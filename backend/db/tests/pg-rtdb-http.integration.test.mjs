import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";
import { getPool, closePool } from "../postgres.js";
import { createRequirePgTenant } from "../../pg/tenant.js";
import { authorizeRtdbPath } from "../../pg/rtdbAuthz.js";
import { withRequestTenant } from "../../pg/tenant.js";
import * as pathRouter from "../../pg/pathRouter.js";
import { isAdminAvailable, getAdminAuth } from "../../firebaseAdmin.js";
import pgApi from "../../routes/pgApi.js";

const suffix = Date.now();
const REST_A = `rest_${suffix}`;
const REST_B = `rest_${suffix + 1}`;

function decodeTestToken(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return { verified: false, tokenError: "token_missing" };
  const token = header.slice(7);
  if (!token.startsWith("nesta-test.")) return { verified: false, tokenError: "token_invalid" };
  try {
    const decoded = JSON.parse(Buffer.from(token.slice("nesta-test.".length), "base64url").toString("utf8"));
    return {
      ...decoded,
      verified: true,
      uid: decoded.uid || decoded.rtdbUserId || decoded.userId,
      userId: decoded.rtdbUserId || decoded.userId || decoded.uid,
      isCustomer: decoded.type === "customer" && decoded.role === "client",
      tokenType: decoded.type || null,
      table: decoded.table != null ? String(decoded.table) : "",
      tableId: decoded.tableId != null ? String(decoded.tableId) : "",
    };
  } catch {
    return { verified: false, tokenError: "token_invalid" };
  }
}

function mintMock({ restId, userId, role, platformSuperAdmin = false, type, table, tableId }) {
  const payload = {
    uid: platformSuperAdmin ? "platform-root" : (type === "customer" ? userId : `${restId}__${userId}`),
    restId: platformSuperAdmin ? null : restId,
    restaurantId: platformSuperAdmin ? null : restId,
    role,
    rtdbUserId: userId,
    platformSuperAdmin,
    type: type || null,
    table: table ?? null,
    tableId: tableId ?? table ?? null,
  };
  return "nesta-test." + Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function sendRtdbError(res, result) {
  return res.status(result.status || 400).json({ error: result.error, code: result.code || result.error, details: result.details || null });
}

function mountEquivalentRouter(app) {
  const requireTenant = createRequirePgTenant({ resolveIdentityFn: decodeTestToken });
  const verbs = [
    ["get", "read", (req, client) => pathRouter.rtdbGet(client, req.pgTenant, String(req.body?.path || ""))],
    ["set", "write", (req, client, events) => pathRouter.rtdbSet(client, req.pgTenant, String(req.body?.path || ""), req.body?.value, events)],
    ["update", "write", (req, client, events) => pathRouter.rtdbUpdate(client, req.pgTenant, String(req.body?.path || ""), req.body?.value || req.body?.patch, events)],
    ["remove", "write", (req, client, events) => pathRouter.rtdbRemove(client, req.pgTenant, String(req.body?.path || ""), events)],
    ["push", "write", (req, client, events) => pathRouter.rtdbPush(client, req.pgTenant, String(req.body?.path || ""), req.body?.value, events)],
    ["transaction", "write", async (req, client, events) => {
      const path = String(req.body?.path || "");
      if (typeof req.body?.next !== "undefined") {
        const setResult = await pathRouter.rtdbSet(client, req.pgTenant, path, req.body.next, events);
        if (setResult?.error) return setResult;
        return { value: req.body.next };
      }
      const txn = await pathRouter.rtdbTransaction(client, req.pgTenant, path);
      if (txn?.error) return txn;
      return txn;
    }],
  ];
  for (const [op, access, fn] of verbs) {
    app.post(`/api/pg/rtdb/${op}`, requireTenant, async (req, res) => {
      const decision = await authorizeRtdbPath(req.pgTenant, String(req.body?.path || ""), op, {
        writeValue: req.body?.value ?? req.body?.patch ?? req.body?.next,
      });
      if (decision.status) return sendRtdbError(res, decision);
      const events = [];
      const result = await withRequestTenant(req, (client) => fn(req, client, events));
      if (result?.error) return sendRtdbError(res, result);
      res.json(result);
    });
  }
}

function installMockVerify() {
  if (!isAdminAvailable()) return false;
  const auth = getAdminAuth();
  const orig = auth.verifyIdToken.bind(auth);
  auth.verifyIdToken = async (token, checkRevoked) => {
    if (String(token).startsWith("nesta-test.")) {
      return JSON.parse(Buffer.from(String(token).slice("nesta-test.".length), "base64url").toString("utf8"));
    }
    return orig(token, checkRevoked);
  };
  return true;
}

const avail = await dbAvailable();
if (avail !== true) {
  await skipUnavailable("pg-rtdb-http.integration.test.mjs", avail.error);
} else {
  const actualRouter = installMockVerify();
  const tokenKind = actualRouter
    ? "MOCKED / NOT VERIFIED (Admin verifyIdToken patched in this process; cryptography is not production-equivalent)"
    : "MOCKED / NOT VERIFIED (createRequirePgTenant identity stub; Admin SDK unavailable)";

  test(`HTTP RTDB stack identity: ${tokenKind}`, async (t) => {
    const pool = getPool();
    const setup = await pool.connect();
    let restA;
    let restB;
    const app = express();
    app.use(express.json());
    if (actualRouter) app.use("/api/pg", pgApi);
    else mountEquivalentRouter(app);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();

    async function rtdb(token, op, body, { headerRestId, queryRestId } = {}) {
      const query = queryRestId === undefined ? "" : `?restId=${encodeURIComponent(queryRestId)}`;
      const headers = { "Content-Type": "application/json" };
      if (token !== null && token !== undefined) headers.Authorization = `Bearer ${token}`;
      if (headerRestId !== undefined) headers["x-rest-id"] = headerRestId;
      const res = await fetch(`http://127.0.0.1:${port}/api/pg/rtdb/${op}${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }

    try {
      restA = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
        [`http-a-${suffix}.local`, "HTTP A", REST_A]
      )).rows[0].id;
      restB = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
        [`http-b-${suffix}.local`, "HTTP B", REST_B]
      )).rows[0].id;
      await setup.query(
        `INSERT INTO employees (restaurant_id, name, login, role, legacy_rtdb_id, active, extra)
         VALUES
           ($1,'Admin A','admin_a','admin','admin_1', true, '{}'::jsonb),
           ($1,'Waiter A','waiter_a','waiter','waiter_1', true, '{}'::jsonb),
           ($1,'Chef A','chef_a','chef','chef_1', true, '{}'::jsonb),
           ($1,'Courier A','courier_a','courier','courier_1', true, '{}'::jsonb),
           ($1,'Cashier A','cashier_a','cashier','cashier_1', true, '{}'::jsonb),
           ($1,'Blocked A','blocked_a','waiter','blocked_1', false, '{}'::jsonb),
           ($1,'Gone A','gone_a','waiter','gone_1', true, '{}'::jsonb),
           ($2,'Admin B','admin_b','admin','admin_1', true, '{}'::jsonb)`,
        [restA, restB]
      );
      await setup.query(`DELETE FROM employees WHERE restaurant_id = $1 AND legacy_rtdb_id = 'gone_1'`, [restA]);

      const adminA = mintMock({ restId: REST_A, userId: "admin_1", role: "admin" });
      const waiterA = mintMock({ restId: REST_A, userId: "waiter_1", role: "waiter" });
      const chefA = mintMock({ restId: REST_A, userId: "chef_1", role: "chef" });
      const courierA = mintMock({ restId: REST_A, userId: "courier_1", role: "courier" });
      const cashierA = mintMock({ restId: REST_A, userId: "cashier_1", role: "cashier" });
      const blockedA = mintMock({ restId: REST_A, userId: "blocked_1", role: "waiter" });
      const goneA = mintMock({ restId: REST_A, userId: "gone_1", role: "waiter" });
      const adminB = mintMock({ restId: REST_B, userId: "admin_1", role: "admin" });
      const root = mintMock({ restId: REST_A, userId: "root", role: "superadmin", platformSuperAdmin: true });

      const operationBody = (op, path, restId = REST_A) => ({
        path,
        ...(restId === undefined ? {} : { restId }),
        ...(["set", "update", "push"].includes(op)
          ? { value: { title: `${op}-${suffix}`, createdAt: Date.now() } }
          : {}),
      });
      const pathFor = (op, restId = REST_A, collection = "notifications", tag = "matrix") =>
        `restaurants/${restId}/${collection}${op === "push" ? "" : `/${tag}_${op}_${suffix}`}`;
      const verbs = ["get", "set", "update", "remove", "push"];

      for (const op of verbs) {
        const own = await rtdb(adminA, op, operationBody(op, pathFor(op), REST_A));
        assert.equal(own.status, 200, `${op} own tenant: ${own.body.code}`);
        if (op === "push") assert.ok(own.body.key, `${op} own tenant key`);

        const cross = await rtdb(adminA, op, operationBody(op, pathFor(op, REST_B), REST_B));
        assert.equal(cross.status, 403, `${op} cross tenant`);
        assert.equal(cross.body.code, "restId_mismatch", `${op} cross tenant code`);

        const missing = await rtdb(null, op, operationBody(op, pathFor(op), REST_A));
        assert.equal(missing.status, 401, `${op} missing token`);
        assert.equal(missing.body.code, "token_missing", `${op} missing token code`);

        const invalidToken = await rtdb("not-a-token", op, operationBody(op, pathFor(op), REST_A));
        assert.equal(invalidToken.status, 401, `${op} invalid token`);
        assert.equal(invalidToken.body.code, "token_invalid", `${op} invalid token code`);

        const malformed = await rtdb(adminA, op, operationBody(op, pathFor(op), `${REST_A}/../${REST_B}`));
        assert.equal(malformed.status, 400, `${op} malformed restId`);
        assert.equal(malformed.body.code, "restId_invalid", `${op} malformed restId code`);

        const explicitEmpty = await rtdb(adminA, op, operationBody(op, pathFor(op), ""));
        assert.equal(explicitEmpty.status, 400, `${op} explicit empty restId`);
        assert.equal(explicitEmpty.body.code, "restId_invalid", `${op} explicit empty restId code`);

        const conflicting = await rtdb(
          adminA,
          op,
          operationBody(op, pathFor(op), REST_B),
          { headerRestId: REST_A }
        );
        assert.equal(conflicting.status, 400, `${op} conflicting selectors`);
        assert.equal(conflicting.body.code, "restId_conflict", `${op} conflicting selectors code`);

        const denied = await rtdb(
          waiterA,
          op,
          operationBody(op, pathFor(op, REST_A, "inventory", "denied"), REST_A)
        );
        assert.equal(denied.status, 403, `${op} role denied`);
        assert.equal(denied.body.code, "role_denied", `${op} role denied code`);

        const unmapped = await rtdb(
          adminA,
          op,
          operationBody(op, `restaurants/${REST_A}/unmappedTenantData${op === "push" ? "" : "/name"}`, REST_A)
        );
        assert.equal(unmapped.status, 400, `${op} unmapped path`);
        assert.equal(unmapped.body.code, "unmapped_path", `${op} unmapped path code`);

        const platform = await rtdb(root, op, operationBody(op, pathFor(op, REST_A, "notifications", "platform"), REST_A));
        assert.equal(platform.status, 200, `${op} platform superadmin: ${platform.body.code}`);

        const pathOnlyBody = operationBody(op, pathFor(op, REST_B), REST_A);
        delete pathOnlyBody.restId;
        const pathOnlyMismatch = await rtdb(adminA, op, pathOnlyBody);
        assert.equal(pathOnlyMismatch.status, 403, `${op} path/token tenant mismatch`);
        assert.equal(pathOnlyMismatch.body.code, "restId_mismatch", `${op} path/token mismatch code`);

        const forgedRole = await rtdb(
          waiterA,
          op,
          {
            ...operationBody(op, pathFor(op, REST_A, "inventory", "escalation"), REST_A),
            role: "admin",
            isSuperAdmin: true,
            platformSuperAdmin: true,
            userId: "admin_1",
            customerId: "cust_x",
            clientId: "client_x",
            orderId: "ord_x",
            tableId: "table_1",
          },
          { headerRestId: REST_A }
        );
        assert.equal(forgedRole.status, 403, `${op} client-controlled role/authority escalation`);
        assert.equal(forgedRole.body.code, "role_denied", `${op} escalation code`);

        const customerTok = mintMock({
          restId: REST_A, userId: "client_1", role: "client", type: "customer", table: "1", tableId: "table_1",
        });
        const customerRoot = await rtdb(
          customerTok,
          op,
          operationBody(op, `restaurants/${REST_A}/orders${op === "push" ? "" : ""}`, REST_A)
        );
        if (op === "push") {
          assert.equal(customerRoot.status, 403, `${op} customer collection push without matching table`);
        } else {
          assert.equal(customerRoot.status, 403, `${op} customer collection-root`);
        }
        assert.equal(customerRoot.body.code, "role_denied", `${op} customer collection-root code`);

        const customerForeign = await rtdb(
          customerTok,
          op,
          operationBody(op, `restaurants/${REST_A}/orders/foreign_${op}_${suffix}`, REST_A)
        );
        assert.equal(customerForeign.status, 403, `${op} customer foreign-resource`);
        assert.equal(customerForeign.body.code, "role_denied", `${op} customer foreign-resource code`);
      }

      const txnFail = await rtdb(adminA, "transaction", {
        path: `restaurants/${REST_A}/unmappedTenantData`,
        restId: REST_A,
        next: { name: "nope" },
      });
      assert.notEqual(txnFail.status, 200);
      assert.ok(["unmapped_path", "role_denied"].includes(txnFail.body.code), txnFail.body.code);

      const waiterOrders = await rtdb(waiterA, "get", { path: `restaurants/${REST_A}/orders`, restId: REST_A });
      assert.equal(waiterOrders.status, 200);
      const waiterInv = await rtdb(waiterA, "get", { path: `restaurants/${REST_A}/inventory`, restId: REST_A });
      assert.equal(waiterInv.status, 403);
      const waiterUsers = await rtdb(waiterA, "get", { path: `restaurants/${REST_A}/users`, restId: REST_A });
      assert.equal(waiterUsers.status, 403);

      const chefInv = await rtdb(chefA, "get", { path: `restaurants/${REST_A}/inventory`, restId: REST_A });
      assert.equal(chefInv.status, 403);
      const chefOrders = await rtdb(chefA, "get", { path: `restaurants/${REST_A}/orders`, restId: REST_A });
      assert.equal(chefOrders.status, 200);

      const courierUsers = await rtdb(courierA, "get", { path: `restaurants/${REST_A}/users`, restId: REST_A });
      assert.equal(courierUsers.status, 403);
      const courierOwn = await rtdb(courierA, "get", { path: `restaurants/${REST_A}/couriers`, restId: REST_A });
      assert.equal(courierOwn.status, 200);

      const cashierOrders = await rtdb(cashierA, "get", { path: `restaurants/${REST_A}/orders`, restId: REST_A });
      assert.equal(cashierOrders.status, 200);
      const cashierUsers = await rtdb(cashierA, "get", { path: `restaurants/${REST_A}/users`, restId: REST_A });
      assert.equal(cashierUsers.status, 403);

      const blocked = await rtdb(blockedA, "get", { path: `restaurants/${REST_A}/orders`, restId: REST_A });
      assert.equal(blocked.status, 403);
      const deleted = await rtdb(goneA, "get", { path: `restaurants/${REST_A}/orders`, restId: REST_A });
      assert.equal(deleted.status, 403);

      const other = await rtdb(adminB, "get", { path: `restaurants/${REST_A}/settings`, restId: REST_A });
      assert.equal(other.status, 403);

      const superGet = await rtdb(root, "get", { path: `restaurants/${REST_A}/settings`, restId: REST_A });
      assert.equal(superGet.status, 200, `superadmin GET ${superGet.body.code}`);

      t.diagnostic(`router=${actualRouter ? "actual pgApi" : "equivalent stack"} restA=${REST_A}`);
    } finally {
      server.close();
      await once(server, "close");
      if (restA) await setup.query("DELETE FROM restaurants WHERE id = $1", [restA]).catch(() => {});
      if (restB) await setup.query("DELETE FROM restaurants WHERE id = $1", [restB]).catch(() => {});
      setup.release();
      await closePool();
    }
  });
}
