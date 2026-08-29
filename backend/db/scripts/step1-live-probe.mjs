#!/usr/bin/env node
// Live Step-1 probe against the currently running backend. Creates two
// disposable PG restaurants, mints Firebase ID tokens (REAL VERIFIED),
// exercises /api/pg/rtdb/*, then deletes the fixtures. Never prints tokens,
// passwords, or connection strings.
import { getAdminAuth, isAdminAvailable } from "../../firebaseAdmin.js";
import { getPool, closePool, withTenantContext } from "../postgres.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = process.env.NESTA_LIVE_BASE || "http://127.0.0.1:4000";
const suffix = Date.now();
const legacyA = `rest_${suffix}`;
const legacyB = `rest_${suffix + 1}`;
let restA = null;
let restB = null;

function apiKeyFromFrontend() {
  const adminJs = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../admin-frontend/public/js/admin.js"),
    "utf8"
  );
  const match = adminJs.match(/apiKey:\s*"([^"]+)"/);
  if (!match) throw new Error("frontend apiKey not found");
  return match[1];
}

async function exchangeCustomToken(customToken) {
  const key = apiKeyFromFrontend();
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const json = await res.json();
  if (!json.idToken) throw new Error(`custom-token exchange failed status=${res.status}`);
  return json.idToken;
}

async function mintIdToken(restId, userId, role, { platformSuperAdmin = false } = {}) {
  if (!isAdminAvailable()) throw new Error("Firebase Admin unavailable");
  const auth = getAdminAuth();
  const uid = platformSuperAdmin ? `platform_probe_${suffix}` : `${restId}__${userId}`;
  const claims = platformSuperAdmin
    ? { platformSuperAdmin: true, role: "superadmin" }
    : { restId, restaurantId: restId, role, rtdbUserId: userId };
  try { await auth.getUser(uid); } catch {
    await auth.createUser({ uid, disabled: false });
  }
  await auth.setCustomUserClaims(uid, claims);
  const custom = await auth.createCustomToken(uid, claims);
  return exchangeCustomToken(custom);
}

async function rtdb(token, op, body) {
  const res = await fetch(`${BASE}/api/pg/rtdb/${op}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-rest-id": body.restId || "",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function ok(label, pass, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  return pass;
}

async function main() {
  const pool = getPool();
  const setup = await pool.connect();
  let fails = 0;
  try {
    const ra = await setup.query(
      `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
      [`s1-a-${suffix}.local`, "Step1 A", legacyA]
    );
    restA = ra.rows[0].id;
    const rb = await setup.query(
      `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
      [`s1-b-${suffix}.local`, "Step1 B", legacyB]
    );
    restB = rb.rows[0].id;
    await setup.query(
      `INSERT INTO employees (restaurant_id, name, login, role, legacy_rtdb_id, active)
       VALUES ($1,'Admin A','admin_a','admin','admin_1', true),
              ($1,'Waiter A','waiter_a','waiter','waiter_1', true),
              ($1,'Chef A','chef_a','chef','chef_1', true),
              ($1,'Courier A','courier_a','courier','courier_1', true),
              ($1,'Cashier A','cashier_a','cashier','cashier_1', true),
              ($1,'Blocked A','blocked_a','waiter','blocked_1', false),
              ($2,'Admin B','admin_b','admin','admin_1', true)`,
      [restA, restB]
    );

    console.log("AUTH: REAL VERIFIED (Firebase custom token → Identity Toolkit ID token)");

    const tokenA = await mintIdToken(legacyA, "admin_1", "admin");
    const tokenWaiter = await mintIdToken(legacyA, "waiter_1", "waiter");
    const tokenChef = await mintIdToken(legacyA, "chef_1", "chef");
    const tokenCourier = await mintIdToken(legacyA, "courier_1", "courier");
    const tokenCashier = await mintIdToken(legacyA, "cashier_1", "cashier");
    const tokenBlocked = await mintIdToken(legacyA, "blocked_1", "waiter");
    const tokenB = await mintIdToken(legacyB, "admin_1", "admin");
    const composite = `${legacyA}__admin_1`;

    const ownGet = await rtdb(tokenA, "get", { path: `restaurants/${legacyA}/settings`, restId: legacyA });
    fails += !ok("admin own tenant GET", ownGet.status === 200, `status=${ownGet.status} code=${ownGet.body.code || "ok"}`);

    const ownSet = await rtdb(tokenA, "set", {
      path: `restaurants/${legacyA}/notifications/step1_${suffix}`,
      restId: legacyA,
      value: { title: "step1", createdAt: Date.now() },
    });
    fails += !ok("admin own tenant SET", ownSet.status === 200, `status=${ownSet.status}`);

    const ownUpdate = await rtdb(tokenA, "update", {
      path: `restaurants/${legacyA}/notifications/step1_${suffix}`,
      restId: legacyA,
      value: { title: "step1-updated" },
    });
    fails += !ok("admin own tenant UPDATE", ownUpdate.status === 200, `status=${ownUpdate.status} code=${ownUpdate.body.code || "ok"}`);

    const ownPush = await rtdb(tokenA, "push", {
      path: `restaurants/${legacyA}/notifications`,
      restId: legacyA,
      value: { title: "pushed", createdAt: Date.now() },
    });
    fails += !ok("admin own tenant PUSH", ownPush.status === 200 && !!ownPush.body.key, `status=${ownPush.status}`);

    const ownRemove = await rtdb(tokenA, "remove", {
      path: `restaurants/${legacyA}/notifications/step1_${suffix}`,
      restId: legacyA,
    });
    fails += !ok("admin own tenant REMOVE", ownRemove.status === 200, `status=${ownRemove.status}`);

    const compositeGet = await rtdb(tokenA, "get", { path: `restaurants/${composite}/settings`, restId: composite });
    fails += !ok("legacy composite restId GET", compositeGet.status === 200, `status=${compositeGet.status} code=${compositeGet.body.code || "ok"}`);

    for (const op of ["get", "set", "update", "remove", "push"]) {
      const foreign = await rtdb(tokenA, op, {
        path: `restaurants/${legacyB}/notifications/x`,
        restId: legacyB,
        value: { t: 1 },
      });
      fails += !ok(`cross-tenant ${op.toUpperCase()}`, foreign.status === 403 && foreign.body.code === "restId_mismatch", `status=${foreign.status} code=${foreign.body.code}`);
    }

    const waiterSettings = await rtdb(tokenWaiter, "set", {
      path: `restaurants/${legacyA}/settings`,
      restId: legacyA,
      value: { restaurantName: "nope" },
    });
    fails += !ok("waiter settings WRITE", waiterSettings.status === 403 && waiterSettings.body.code === "role_denied", `status=${waiterSettings.status} code=${waiterSettings.body.code}`);

    const waiterInv = await rtdb(tokenWaiter, "get", { path: `restaurants/${legacyA}/inventory`, restId: legacyA });
    fails += !ok("waiter inventory READ", waiterInv.status === 403 && waiterInv.body.code === "role_denied", `status=${waiterInv.status} code=${waiterInv.body.code}`);

    const waiterOrders = await rtdb(tokenWaiter, "get", { path: `restaurants/${legacyA}/orders`, restId: legacyA });
    fails += !ok("waiter orders READ", waiterOrders.status === 200, `status=${waiterOrders.status}`);

    const chefInv = await rtdb(tokenChef, "get", { path: `restaurants/${legacyA}/users`, restId: legacyA });
    fails += !ok("chef users READ", chefInv.status === 403, `status=${chefInv.status} code=${chefInv.body.code}`);

    const courierUsers = await rtdb(tokenCourier, "get", { path: `restaurants/${legacyA}/inventory`, restId: legacyA });
    fails += !ok("courier inventory READ", courierUsers.status === 403, `status=${courierUsers.status} code=${courierUsers.body.code}`);

    const cashierOrders = await rtdb(tokenCashier, "get", { path: `restaurants/${legacyA}/orders`, restId: legacyA });
    fails += !ok("cashier orders READ", cashierOrders.status === 200, `status=${cashierOrders.status}`);

    const blockedRead = await rtdb(tokenBlocked, "get", { path: `restaurants/${legacyA}/orders`, restId: legacyA });
    fails += !ok("blocked employee READ", blockedRead.status === 403, `status=${blockedRead.status} code=${blockedRead.body.code}`);

    const infoWrite = await rtdb(tokenA, "set", {
      path: `restaurants/${legacyA}/info`,
      restId: legacyA,
      value: { name: "nope" },
    });
    fails += !ok("unmapped collection SET (no Firebase fallback)", infoWrite.status === 400 && infoWrite.body.code === "unmapped_path", `status=${infoWrite.status} code=${infoWrite.body.code}`);

    const txnFail = await rtdb(tokenA, "transaction", {
      path: `restaurants/${legacyA}/info`,
      restId: legacyA,
      next: { name: "nope" },
    });
    fails += !ok("transaction failure propagation", txnFail.status !== 200 && txnFail.body.code === "unmapped_path", `status=${txnFail.status} code=${txnFail.body.code}`);

    const malformed = await rtdb(tokenA, "get", {
      path: `restaurants/${legacyA}/settings`,
      restId: `${legacyA}/../${legacyB}`,
    });
    fails += !ok("malformed restId", malformed.status === 400 && malformed.body.code === "restId_invalid", `status=${malformed.status} code=${malformed.body.code}`);

    const conflict = await rtdb(tokenA, "get", {
      path: `restaurants/${legacyA}/settings`,
      restId: "rest_0000000000000",
    });
    fails += !ok("conflicting restId selectors", conflict.status === 400 && conflict.body.code === "restId_conflict", `status=${conflict.status} code=${conflict.body.code}`);

    const spoof = await rtdb(tokenA, "get", {
      path: `restaurants/rest_0000000000000/settings`,
      restId: "rest_0000000000000",
    });
    fails += !ok("restId spoof header+path", spoof.status === 403 && spoof.body.code === "restId_mismatch", `status=${spoof.status} code=${spoof.body.code}`);

    const otherAdmin = await rtdb(tokenB, "get", { path: `restaurants/${legacyA}/settings`, restId: legacyA });
    fails += !ok("restaurant B admin reading A", otherAdmin.status === 403, `status=${otherAdmin.status} code=${otherAdmin.body.code}`);

    try {
      const tokenRoot = await mintIdToken(legacyA, "root", "superadmin", { platformSuperAdmin: true });
      const superGet = await rtdb(tokenRoot, "get", { path: `restaurants/${legacyA}/settings`, restId: legacyA });
      fails += !ok("superadmin explicit tenant GET", superGet.status === 200, `status=${superGet.status} code=${superGet.body.code || "ok"}`);
    } catch (err) {
      fails += !ok("superadmin explicit tenant GET", false, err.code || err.name);
    }

    const seenA = await withTenantContext(restA, async (client) => {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM notifications_log WHERE restaurant_id = $1`, [restA]);
      return rows[0].n;
    }, { actingRole: "admin" });
    const seenB = await withTenantContext(restB, async (client) => {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM notifications_log WHERE restaurant_id = $1`, [restB]);
      return rows[0].n;
    }, { actingRole: "admin" });
    fails += !ok("RLS A sees own notification write", seenA >= 1, `count=${seenA}`);
    fails += !ok("RLS B cannot see A's notifications", seenB === 0, `count=${seenB}`);

    const leaked = await withTenantContext(restB, async (client) => {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM notifications_log WHERE restaurant_id = $1`, [restA]);
      return rows[0].n;
    }, { actingRole: "admin" });
    fails += !ok("RLS bypass query for A under B context returns 0", leaked === 0, `count=${leaked}`);
  } catch (err) {
    fails += 1;
    console.log("FAIL  live probe threw", err.code || err.name);
  } finally {
    try {
      if (restA) await setup.query("DELETE FROM restaurants WHERE id = $1", [restA]);
      if (restB) await setup.query("DELETE FROM restaurants WHERE id = $1", [restB]);
    } catch { /* */ }
    setup.release();
    await closePool();
  }
  console.log(`live probe complete, failures=${fails}`);
  process.exitCode = fails ? 1 : 0;
}

main();
