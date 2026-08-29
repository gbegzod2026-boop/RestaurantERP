#!/usr/bin/env node
// db/scripts/migrate-wave2-dry-run.mjs — READ-ONLY Wave 2 (Orders) data
// quality audit. Reads production Firebase via lib/fbRead.mjs (REST GET
// only). DATA_BACKEND cannot redirect this source. Writes NOTHING to
// Firebase and does not connect to PostgreSQL.
//
// Entities covered: orders, order_items (order.items), order status values,
// order↔table/waiter/menu-item reference integrity, payment method values,
// fast-order priority/fee consistency.
import { initFirebase, shallowKeys, getValue, requestCount } from "./lib/fbRead.mjs";

const MAX_EXAMPLES = 12;

// Mirrors shared.js exactly (verbatim copy, kept in sync manually — see the
// Wave 2 report for the source line numbers this was read from).
const ORDER_STATUS_V2_KEYS = new Set([
  "waiter", "order_created", "kitchen_printer", "kitchen_display", "preparing",
  "ready", "picked_up", "served", "cashier", "payment", "completed", "cancelled",
]);
const LEGACY_STATUS_TO_V2 = {
  pending: "order_created", new: "order_created", queue: "order_created",
  approved: "preparing", cooking: "preparing", ready: "ready", closed: "completed",
  paid: "completed", yangi: "order_created", kutilmoqda: "order_created",
  tasdiqlandi: "preparing", tayyorlanmoqda: "preparing", tayyor: "ready",
  yopildi: "completed", "to'landi": "completed", tolandi: "completed",
  yetkazildi: "served", yetkazilmoqda: "picked_up", delivering: "picked_up",
  delivered: "served", canceled: "cancelled", cancelled: "cancelled",
  "bekor qilindi": "cancelled", eating: "served", completed: "completed",
};
function normalizeOrderStatusV2(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  if (ORDER_STATUS_V2_KEYS.has(s)) return s;
  return LEGACY_STATUS_TO_V2[s] || null; // null = genuinely unknown, not just legacy
}

const KNOWN_PAYMENT_KEYS = new Set(["Naqd", "Click", "Payme", "Uzum Bank", "Bank karta", "Humo", "UzCard", "pending", "cash_on_delivery"]);

function report(entity, counts) {
  console.log(`\n${entity}`);
  for (const [k, v] of Object.entries(counts)) {
    if (Array.isArray(v)) continue;
    console.log(`  ${k.padEnd(22)}: ${v}`);
  }
  for (const [k, v] of Object.entries(counts)) {
    if (!Array.isArray(v) || !v.length) continue;
    console.log(`  ${k} examples (up to ${MAX_EXAMPLES}):`);
    v.slice(0, MAX_EXAMPLES).forEach((x) => console.log(`    - ${x}`));
    if (v.length > MAX_EXAMPLES) console.log(`    ... and ${v.length - MAX_EXAMPLES} more`);
  }
}

async function main() {
  console.log("=== Wave 2 Dry Run — READ ONLY (fbRead REST GET), no writes to Firebase, no PostgreSQL connection ===");
  console.log("Source is explicit Firebase REST GET. DATA_BACKEND cannot redirect this read.");
  initFirebase();
  const rids = await shallowKeys("restaurants");
  console.log(`Found ${rids.length} restaurant(s) in Firebase.`);

  let totalOrders = 0, totalItems = 0;
  const malformedOrders = [], malformedItems = [], orphanItems = [];
  const missingTable = [], missingWaiter = [];
  const unknownStatuses = [], unknownItemStatuses = [];
  const duplicateOrderNumbers = [];
  const invalidTotals = [], invalidTimestamps = [];
  const unknownPaymentStates = [];
  const priorityInconsistencies = [];
  const perRestaurantCounts = [];
  const statusHistogram = {};
  const orderTypeHistogram = {};
  const deliveryOrdersWithoutDeliveryNode = [];

  for (const rid of rids) {
    const r = (await getValue(`restaurants/${rid}`)) || {};
    const orders = r?.orders || {};
    const tables = r?.tables || {};
    const users = r?.users || {};
    const menu = r?.menu || {};
    const orderIds = Object.keys(orders);
    let restOrderCount = 0, restItemCount = 0;
    const seenOrderNumbers = new Map(); // `${type}:${number}` -> orderId

    for (const [oid, o] of Object.entries(orders)) {
      totalOrders++; restOrderCount++;

      // ── malformed order ──
      const hasItems = o?.items && Object.keys(o.items).length > 0;
      if (!hasItems || o?.total === undefined || o?.createdAt === undefined || (!o?.status && !o?.statusKey && !o?.statusV2)) {
        malformedOrders.push(`${rid}/orders/${oid}: missing ${!hasItems ? "items " : ""}${o?.total === undefined ? "total " : ""}${o?.createdAt === undefined ? "createdAt " : ""}${(!o?.status && !o?.statusKey && !o?.statusV2) ? "status" : ""}`.trim());
        continue; // can't meaningfully check the rest of this order
      }

      // ── status ──
      const rawStatus = o.statusV2 || o.statusKey || o.status;
      const normalized = normalizeOrderStatusV2(rawStatus);
      if (!normalized) unknownStatuses.push(`${rid}/orders/${oid}: status "${rawStatus}"`);
      else statusHistogram[normalized] = (statusHistogram[normalized] || 0) + 1;

      // ── order type ──
      let orderType = "dine_in";
      if (o.orderType === "dine_in" || o.orderType === "takeaway" || o.orderType === "delivery") orderType = o.orderType;
      else if (o.deliveryType === "delivery" || o.isDelivery === true || o.deliveryAddress) orderType = "delivery";
      else if (!o.table) orderType = "takeaway"; // no table, no delivery markers — best-effort per normalizeOrderType's own fallback
      orderTypeHistogram[orderType] = (orderTypeHistogram[orderType] || 0) + 1;

      // ── duplicate order numbers (within same restaurant + type — separate counters per type) ──
      if (o.orderNumber !== undefined) {
        const dupKey = `${orderType}:${o.orderNumber}`;
        if (seenOrderNumbers.has(dupKey)) duplicateOrderNumbers.push(`${rid}: orderNumber ${o.orderNumber} (${orderType}) — orders ${seenOrderNumbers.get(dupKey)} and ${oid}`);
        else seenOrderNumbers.set(dupKey, oid);
      }

      // ── totals ──
      const totalNum = Number(o.total);
      if (!(totalNum > 0) || Number.isNaN(totalNum)) invalidTotals.push(`${rid}/orders/${oid}: total="${o.total}"`);

      // ── timestamps ──
      const createdAt = Number(o.createdAt);
      if (!createdAt || Number.isNaN(createdAt) || createdAt > Date.now() + 60_000) {
        invalidTimestamps.push(`${rid}/orders/${oid}: createdAt="${o.createdAt}"`);
      }

      // ── table reference (dine-in only) ──
      if (orderType === "dine_in" && o.table !== undefined && o.table !== null) {
        const tableExists = Object.values(tables).some((t) => Number(t?.number) === Number(o.table));
        if (!tableExists) missingTable.push(`${rid}/orders/${oid}: table "${o.table}" not found in restaurants/${rid}/tables`);
      }

      // ── waiter reference ──
      const waiterId = o.waiterId || o.createdByWaiterId;
      if (waiterId && !users[waiterId]) missingWaiter.push(`${rid}/orders/${oid}: waiterId "${waiterId}" not found in restaurants/${rid}/users`);

      // ── payment method ──
      const method = o.payment?.method || o.paymentMethod;
      if (method && !KNOWN_PAYMENT_KEYS.has(method)) unknownPaymentStates.push(`${rid}/orders/${oid}: payment method "${method}" not in known registry`);

      // ── priority / fast-fee consistency (tests whether the feature actually persists) ──
      const hasFastFee = o.fastFeeAmount !== undefined && Number(o.fastFeeAmount) > 0;
      const hasPriority = o.priority !== undefined;
      if (hasFastFee !== hasPriority) priorityInconsistencies.push(`${rid}/orders/${oid}: fastFeeAmount=${o.fastFeeAmount ?? "(absent)"} priority=${o.priority ?? "(absent)"}`);

      // ── delivery orders should carry a .delivery subtree once the Delivery Engine has touched them (informational, not "malformed") ──
      if (orderType === "delivery" && !o.delivery) deliveryOrdersWithoutDeliveryNode.push(`${rid}/orders/${oid}`);

      // ── items ──
      for (const [ikey, item] of Object.entries(o.items || {})) {
        totalItems++; restItemCount++;
        if (!item?.name || item?.price === undefined || item?.qty === undefined) {
          malformedItems.push(`${rid}/orders/${oid}/items/${ikey}: missing ${!item?.name ? "name " : ""}${item?.price === undefined ? "price " : ""}${item?.qty === undefined ? "qty" : ""}`.trim());
          continue;
        }
        if (item.id && !menu[item.id]) orphanItems.push(`${rid}/orders/${oid}/items/${ikey}: menu item "${item.id}" not found in restaurants/${rid}/menu`);
        if (item.status && !["pending", "preparing", "ready", "served", "cancelled"].includes(String(item.status).toLowerCase())) {
          unknownItemStatuses.push(`${rid}/orders/${oid}/items/${ikey}: item status "${item.status}"`);
        }
      }
    }

    if (restOrderCount > 0) perRestaurantCounts.push({ rid, orders: restOrderCount, items: restItemCount });
  }

  console.log("\n=== PER-RESTAURANT SOURCE COUNTS (restaurants with ≥1 order) ===");
  perRestaurantCounts.sort((a, b) => b.orders - a.orders).forEach((p) => console.log(`  ${p.rid}: ${p.orders} order(s), ${p.items} item(s)`));
  if (!perRestaurantCounts.length) console.log("  (no restaurant has any order data)");

  report("ORDERS", {
    "total (source)": totalOrders,
    "malformed": malformedOrders,
    "unknown status": unknownStatuses,
    "invalid total": invalidTotals,
    "invalid timestamp": invalidTimestamps,
    "duplicate order_number (per type)": duplicateOrderNumbers,
    "missing table ref": missingTable,
    "missing waiter ref": missingWaiter,
    "unknown payment method": unknownPaymentStates,
    "priority/fastFee inconsistency": priorityInconsistencies,
    "delivery order missing .delivery node": deliveryOrdersWithoutDeliveryNode,
  });

  report("ORDER_ITEMS", {
    "total (source)": totalItems,
    "malformed": malformedItems,
    "orphan (menu item not found)": orphanItems,
    "unknown item-level status": unknownItemStatuses,
  });

  console.log("\n=== STATUS HISTOGRAM (normalized, valid orders only) ===");
  Object.entries(statusHistogram).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(18)}: ${v}`));

  console.log("\n=== ORDER TYPE HISTOGRAM ===");
  Object.entries(orderTypeHistogram).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(12)}: ${v}`));

  const cleanOrders = totalOrders - malformedOrders.length;
  const cleanItems = totalItems - malformedItems.length;
  console.log("\n=== SOURCE → TARGET PROJECTION (no PostgreSQL connection made — computed from mapping rules only) ===");
  console.log(`  orders row candidates              : ${cleanOrders} (of ${totalOrders} source — ${malformedOrders.length} would be skipped/exception-logged, same policy as Wave 1)`);
  console.log(`  order_items row candidates         : ${cleanItems} (of ${totalItems} source — ${malformedItems.length} would be skipped)`);
  console.log(`  order_status_history row candidates: at least ${cleanOrders} (≥1 per valid order; real count depends on how many distinct statusHistory entries each order actually has, not counted here to keep this pass fast — see report note)`);
  console.log(`  orphan menu_item references        : ${orphanItems.length} — item.id would need to resolve against Wave 1's already-migrated menu_items.legacy_rtdb_id`);

  console.log("\n=== Dry run complete. No data was written to Firebase. No PostgreSQL connection was made. ===");
  console.log(`Firebase REST reads: ${requestCount()}`);
}

main().catch((err) => {
  console.error("Dry run failed:", err);
  process.exitCode = 1;
});
