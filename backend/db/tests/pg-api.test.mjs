#!/usr/bin/env node
// db/tests/pg-api.test.mjs — Phase 2: tenant isolation, order lifecycle,
// realtime event recording. Uses the service layer (same code the HTTP API
// calls) inside withTenantContext so FORCE RLS via SET LOCAL ROLE nesta_app
// is actually exercised.
import { getPool, closePool, withTenantContext } from "../postgres.js";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";
import * as orders from "../../pg/ordersService.js";
import { listEventsSince } from "../../pg/hub.js";
import { rtdbGet, rtdbSet, rtdbUpdate } from "../../pg/pathRouter.js";

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✅ ${label}`); }
function bad(label, detail) { fail++; console.log(`  ❌ ${label}${detail ? " — " + detail : ""}`); }

async function main() {
  const avail = await dbAvailable();
  if (avail !== true) return await skipUnavailable("pg-api.test.mjs (Phase 2)", avail.error);

  const pool = getPool();
  const setup = await pool.connect();
  const suffix = Date.now();
  let restA, restB, legacyA, legacyB;

  try {
    console.log("Creating Phase 2 API fixtures...");
    legacyA = `rest_${suffix}`;
    legacyB = `rest_${suffix + 1}`;
    const ra = await setup.query(
      `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
      [`p2-a-${suffix}.nestacrm.uz`, "Phase2 A", legacyA]
    );
    restA = ra.rows[0].id;
    const rb = await setup.query(
      `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
      [`p2-b-${suffix}.nestacrm.uz`, "Phase2 B", legacyB]
    );
    restB = rb.rows[0].id;

    await setup.query(
      `INSERT INTO employees (restaurant_id, name, login, role, legacy_rtdb_id)
       VALUES ($1,'Waiter A','waiter_a','waiter','waiter_a'),
              ($2,'Waiter B','waiter_b','waiter','waiter_b')`,
      [restA, restB]
    );
    await setup.query(
      `INSERT INTO tables (restaurant_id, number, legacy_rtdb_id, status)
       VALUES ($1, 1, 'table_1', 'free'), ($2, 1, 'table_1', 'free')`,
      [restA, restB]
    );

    const ctxA = { restaurantUuid: restA, restId: legacyA, userId: "waiter_a", actingRole: "waiter" };
    const ctxB = { restaurantUuid: restB, restId: legacyB, userId: "waiter_b", actingRole: "waiter" };

    // ── create order in A ──
    const orderId = `ord_${suffix}`;
    await withTenantContext(restA, async (client) => {
      const events = [];
      await orders.upsertOrder(client, ctxA, orderId, {
        orderNumber: 101,
        table: 1,
        status: "order_created",
        statusKey: "order_created",
        total: 15000,
        originalTotal: 15000,
        waiterId: "waiter_a",
        createdAt: Date.now(),
        items: {
          item_1: { name: { uz: "Osh" }, price: 15000, qty: 1 },
        },
        payment: { requested: false, paid: false },
      }, events);
      if (events.some((e) => e.type === "ORDER_CREATED")) ok("ORDER_CREATED recorded for restaurant A");
      else bad("ORDER_CREATED recorded for restaurant A", JSON.stringify(events.map((e) => e.type)));
    }, { actingRole: "waiter" });

    const seenA = await withTenantContext(restA, (client) => orders.getOrderByLegacy(client, restA, orderId), { actingRole: "waiter" });
    if (seenA && seenA.total === 15000 && seenA.items?.item_1) ok("A can read its own order with item snapshot");
    else bad("A can read its own order with item snapshot", JSON.stringify(seenA));

    const seenB = await withTenantContext(restB, (client) => orders.getOrderByLegacy(client, restB, orderId), { actingRole: "waiter" });
    if (!seenB) ok("Restaurant B cannot read Restaurant A's order");
    else bad("Restaurant B cannot read Restaurant A's order", "leaked");

    const listB = await withTenantContext(restB, (client) => orders.listOrdersMap(client, restB), { actingRole: "waiter" });
    if (!listB[orderId]) ok("Restaurant B listOrders does not include A's order");
    else bad("Restaurant B listOrders does not include A's order");

    // ── lifecycle ──
    await withTenantContext(restA, async (client) => {
      const events = [];
      await orders.applyLifecycle(client, ctxA, orderId, "approve", {}, events);
      await orders.applyLifecycle(client, ctxA, orderId, "cooking", {}, events);
      await orders.applyLifecycle(client, ctxA, orderId, "ready", {}, events);
      await orders.applyLifecycle(client, ctxA, orderId, "served", {}, events);
      await orders.applyLifecycle(client, ctxA, orderId, "pay", { paid: true, method: "cash", amount: 15000 }, events);
      await orders.applyLifecycle(client, ctxA, orderId, "close", {}, events);
      const types = events.map((e) => e.type);
      if (types.includes("ORDER_STATUS_CHANGED")) ok("lifecycle emits ORDER_STATUS_CHANGED");
      else bad("lifecycle emits ORDER_STATUS_CHANGED", types.join(","));
      if (types.includes("PAYMENT_UPDATED")) ok("lifecycle emits PAYMENT_UPDATED");
      else bad("lifecycle emits PAYMENT_UPDATED", types.join(","));
      if (types.includes("KITCHEN_ORDER_UPDATED")) ok("lifecycle emits KITCHEN_ORDER_UPDATED");
      else bad("lifecycle emits KITCHEN_ORDER_UPDATED", types.join(","));
    }, { actingRole: "waiter" });

    const closed = await withTenantContext(restA, (client) => orders.getOrderByLegacy(client, restA, orderId), { actingRole: "waiter" });
    if (closed && (closed.status === "completed" || closed.statusKey === "completed" || closed.payment?.paid)) {
      ok("order closed / paid after lifecycle");
    } else bad("order closed / paid after lifecycle", JSON.stringify({ status: closed?.status, payment: closed?.payment }));

    // ── table occupancy via path router ──
    await withTenantContext(restA, async (client) => {
      const events = [];
      await rtdbUpdate(client, ctxA, `restaurants/${legacyA}/tables/table_1`, { status: "occupied", orderId }, events);
      const got = await rtdbGet(client, ctxA, `restaurants/${legacyA}/tables/table_1`);
      if (got.value?.status === "occupied") ok("table status patched through path router");
      else bad("table status patched through path router", JSON.stringify(got.value));
      if (events.some((e) => e.type === "TABLE_STATUS_CHANGED")) ok("TABLE_STATUS_CHANGED recorded");
      else bad("TABLE_STATUS_CHANGED recorded");
    }, { actingRole: "waiter" });

    const tableB = await withTenantContext(restB, (client) => rtdbGet(client, ctxB, `restaurants/${legacyB}/tables/table_1`), { actingRole: "waiter" });
    if (tableB.value?.status !== "occupied") ok("Restaurant B table 1 not occupied by A's write");
    else bad("Restaurant B table 1 not occupied by A's write", JSON.stringify(tableB.value));

    // ── path restId mismatch denied ──
    const mismatch = await withTenantContext(restA, (client) =>
      rtdbGet(client, ctxA, `restaurants/${legacyB}/orders`), { actingRole: "waiter" });
    if (mismatch.error === "path_restId_mismatch") ok("path restId mismatch is denied");
    else bad("path restId mismatch is denied", JSON.stringify(mismatch));

    // ── realtime events are tenant-scoped ──
    const evA = await withTenantContext(restA, (client) => listEventsSince(client, restA, 0), { actingRole: "waiter" });
    const evB = await withTenantContext(restB, (client) => listEventsSince(client, restB, 0), { actingRole: "waiter" });
    if (evA.length > 0) ok(`restaurant A has ${evA.length} realtime event(s)`);
    else bad("restaurant A has realtime events");
    if (evB.length === 0) ok("restaurant B has zero events (no leakage)");
    else bad("restaurant B has zero events (no leakage)", `${evB.length} leaked`);

    // ── cancel path ──
    const cancelId = `ord_c_${suffix}`;
    await withTenantContext(restA, async (client) => {
      const events = [];
      await orders.upsertOrder(client, ctxA, cancelId, {
        orderNumber: 102, table: 1, status: "order_created", statusKey: "order_created",
        total: 1000, createdAt: Date.now(), items: { x: { name: "Tea", price: 1000, qty: 1 } },
      }, events);
      await orders.applyLifecycle(client, ctxA, cancelId, "cancel", {}, events);
    }, { actingRole: "waiter" });
    const cancelled = await withTenantContext(restA, (client) => orders.getOrderByLegacy(client, restA, cancelId), { actingRole: "waiter" });
    if (cancelled && (cancelled.status === "cancelled" || cancelled.statusKey === "cancelled")) ok("cancel lifecycle sets cancelled");
    else bad("cancel lifecycle sets cancelled", cancelled?.status);

  } catch (err) {
    bad("pg-api.test.mjs threw", err.stack || err.message);
  } finally {
    try {
      if (restA) await setup.query("DELETE FROM restaurants WHERE id = $1", [restA]);
      if (restB) await setup.query("DELETE FROM restaurants WHERE id = $1", [restB]);
    } catch (e) {
      console.warn("fixture cleanup:", e.message);
    }
    setup.release();
    await closePool();
  }

  console.log(`\nPhase 2 API tests: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main();
