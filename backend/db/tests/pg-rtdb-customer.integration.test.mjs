import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";
import { getPool, closePool } from "../postgres.js";
import { isAdminAvailable, getAdminAuth } from "../../firebaseAdmin.js";
import pgApi from "../../routes/pgApi.js";

const suffix = Date.now();
const REST_A = `rest_${suffix}`;
const REST_B = `rest_${suffix + 1}`;

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

const available = await dbAvailable();
if (available !== true) {
  await skipUnavailable("pg-rtdb-customer.integration.test.mjs", available.error);
} else if (!installMockVerify()) {
  test("customer RTDB isolation: MOCKED auth unavailable", { skip: "Firebase Admin SDK unavailable" }, () => {});
} else {
  test("customer RTDB bridge is resource-scoped against PostgreSQL ownership", async () => {
    const previousBackend = process.env.DATA_BACKEND;
    process.env.DATA_BACKEND = "postgres";
    const pool = getPool();
    const setup = await pool.connect();
    let restA;
    let restB;
    const app = express();
    app.use(express.json());
    app.use("/api/pg", pgApi);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    const api = async (token, op, body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/pg/rtdb/${op}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    try {
      restA = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
        [`cust-a-${suffix}.local`, "Customer A", REST_A]
      )).rows[0].id;
      restB = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
        [`cust-b-${suffix}.local`, "Customer B", REST_B]
      )).rows[0].id;
      await setup.query(
        `INSERT INTO tables (legacy_rtdb_id, restaurant_id, number, table_type, status)
         VALUES ('table_1',$1,1,'oddiy','free'), ('table_2',$1,2,'oddiy','free')`,
        [restA]
      );
      await setup.query(
        `INSERT INTO orders (legacy_rtdb_id, restaurant_id, order_type, table_label, status, payment_status, customer_session_id)
         VALUES ('ord_a',$1,'dine_in','1','order_created','unpaid','client_1'),
                ('ord_b',$1,'dine_in','2','order_created','unpaid','client_2'),
                ('ord_t1',$1,'takeaway',NULL,'order_created','unpaid','client_na_a'),
                ('ord_t2',$1,'takeaway',NULL,'order_created','unpaid','client_na_b')`,
        [restA]
      );
      await setup.query(
        `INSERT INTO restaurant_settings (restaurant_id, settings)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (restaurant_id) DO UPDATE SET settings = EXCLUDED.settings`,
        [restA, JSON.stringify({
          name: "Cafe",
          deliverySettings: { enabled: true, fee: 1000, yandexGo: { apiKey: "secret-yandex-key" } },
          telegramBotToken: "123:ABC",
        })]
      );

      const custA = mintMock({
        restId: REST_A, userId: "client_1", role: "client", type: "customer", table: "1", tableId: "table_1",
      });
      const custB = mintMock({
        restId: REST_A, userId: "client_2", role: "client", type: "customer", table: "2", tableId: "table_2",
      });
      const custOtherTenant = mintMock({
        restId: REST_B, userId: "client_1", role: "client", type: "customer", table: "1", tableId: "table_1",
      });
      const staffAsClient = mintMock({
        restId: REST_A, userId: "admin_1", role: "client",
      });

      const own = await api(custA, "get", { path: `restaurants/${REST_A}/orders/ord_a`, restId: REST_A });
      assert.equal(own.status, 200, own.body.code);
      assert.equal(String(own.body.value.table), "1");

      const foreign = await api(custA, "get", { path: `restaurants/${REST_A}/orders/ord_b`, restId: REST_A });
      assert.equal(foreign.status, 403);
      assert.equal(foreign.body.code, "role_denied");

      const listed = await api(custA, "get", { path: `restaurants/${REST_A}/orders`, restId: REST_A });
      assert.equal(listed.status, 403);

      const otherTable = await api(custA, "get", { path: `restaurants/${REST_A}/tables/table_2`, restId: REST_A });
      assert.equal(otherTable.status, 403);
      const ownTable = await api(custA, "get", { path: `restaurants/${REST_A}/tables/table_1`, restId: REST_A });
      assert.equal(ownTable.status, 200);

      const notices = await api(custA, "get", { path: `restaurants/${REST_A}/notifications`, restId: REST_A });
      assert.equal(notices.status, 403);
      const settingsWrite = await api(custA, "set", {
        path: `restaurants/${REST_A}/settings`, restId: REST_A, value: { secret: true },
      });
      assert.equal(settingsWrite.status, 403);

      const badPush = await api(custA, "push", {
        path: `restaurants/${REST_A}/orders`, restId: REST_A, value: { table: 2, items: [] },
      });
      assert.equal(badPush.status, 403);
      const ownPush = await api(custA, "push", {
        path: `restaurants/${REST_A}/orders`, restId: REST_A, value: { table: 1, items: [] },
      });
      assert.equal(ownPush.status, 200, ownPush.body.code);

      const cross = await api(custOtherTenant, "get", { path: `restaurants/${REST_A}/orders/ord_a`, restId: REST_A });
      assert.equal(cross.status, 403);
      assert.equal(cross.body.code, "restId_mismatch");

      const peer = await api(custB, "update", {
        path: `restaurants/${REST_A}/orders/ord_a`, restId: REST_A, value: { notes: "hijack" },
      });
      assert.equal(peer.status, 403);

      const forgedStaff = await api(staffAsClient, "get", { path: `restaurants/${REST_A}/orders`, restId: REST_A });
      assert.equal(forgedStaff.status, 403);

      const tableMut = await api(custA, "set", {
        path: `restaurants/${REST_A}/tables/table_1`, restId: REST_A, value: { status: "occupied" },
      });
      assert.equal(tableMut.status, 403);
      const paidHijack = await api(custA, "update", {
        path: `restaurants/${REST_A}/orders/ord_a`, restId: REST_A, value: { paymentStatus: "paid", total: 1 },
      });
      assert.equal(paidHijack.status, 403);

      const settingsGet = await api(custA, "get", { path: `restaurants/${REST_A}/settings`, restId: REST_A });
      assert.equal(settingsGet.status, 200, settingsGet.body.code);
      const settingsJson = JSON.stringify(settingsGet.body.value || {});
      assert.equal(settingsJson.includes("secret-yandex-key"), false);
      assert.equal(settingsJson.includes("123:ABC"), false);

      const takeA = mintMock({
        restId: REST_A, userId: "client_na_a", role: "client", type: "customer", table: "", tableId: "",
      });
      const takeB = mintMock({
        restId: REST_A, userId: "client_na_b", role: "client", type: "customer", table: "", tableId: "",
      });
      const ownTake = await api(takeA, "get", { path: `restaurants/${REST_A}/orders/ord_t1`, restId: REST_A });
      assert.equal(ownTake.status, 200, ownTake.body.code);
      const peerTake = await api(takeB, "get", { path: `restaurants/${REST_A}/orders/ord_t1`, restId: REST_A });
      assert.equal(peerTake.status, 403);
      const guessedTake = await api(takeA, "get", { path: `restaurants/${REST_A}/orders/ord_t2`, restId: REST_A });
      assert.equal(guessedTake.status, 403);

      const crApprove = await api(custA, "push", {
        path: `restaurants/${REST_A}/orderChangeRequests`, restId: REST_A,
        value: { orderId: "ord_a", status: "approved" },
      });
      assert.equal(crApprove.status, 403);
      const crCreate = await api(custA, "push", {
        path: `restaurants/${REST_A}/orderChangeRequests`, restId: REST_A,
        value: { orderId: "ord_a", reason: "please cancel" },
      });
      assert.equal(crCreate.status, 200, crCreate.body.code);
      const callDone = await api(custA, "update", {
        path: `restaurants/${REST_A}/waiterCalls/call_x`, restId: REST_A, value: { status: "resolved" },
      });
      assert.equal(callDone.status, 403);

      const realtime = await fetch(`http://127.0.0.1:${port}/api/pg/realtime/since?afterSeq=0`, {
        headers: { Authorization: `Bearer ${custA}`, "x-rest-id": REST_A },
      });
      assert.equal(realtime.status, 403);
    } finally {
      server.close();
      await once(server, "close");
      if (restA) await setup.query("DELETE FROM restaurants WHERE id = $1", [restA]).catch(() => {});
      if (restB) await setup.query("DELETE FROM restaurants WHERE id = $1", [restB]).catch(() => {});
      setup.release();
      if (previousBackend === undefined) delete process.env.DATA_BACKEND;
      else process.env.DATA_BACKEND = previousBackend;
      await closePool();
    }
  });
}
