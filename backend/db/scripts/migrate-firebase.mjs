// db/scripts/migrate-firebase.mjs — the Phase 1 migration engine.
//
//   node db/scripts/migrate-firebase.mjs --dry-run          (default)
//   node db/scripts/migrate-firebase.mjs --apply
//   node db/scripts/migrate-firebase.mjs --verify
//   ... --restaurant rest_123   --resume   --reset-checkpoint   --limit N
//
// ── Safety ───────────────────────────────────────────────────────────────
// Firebase is READ-ONLY here. Every Firebase call goes through lib/fbRead.mjs,
// which exports no mutating verb, so this engine physically cannot delete or
// modify production data (rule #1, #2, #17). PostgreSQL is the only write
// target, and in --dry-run even that is rolled back.
//
// ── Why it runs without PostgreSQL ───────────────────────────────────────
// If no POSTGRES_* config is present the engine still performs a complete
// TRANSFORM-ONLY dry run: it reads every record, normalizes it, resolves
// every foreign key against the Firebase-side reference maps, and reports
// malformed data, unknown enums, duplicates, money anomalies and orphans.
// That is the bulk of what a dry run is for, and it means the data can be
// validated before a database is provisioned. What it cannot prove is
// PostgreSQL-side behaviour (constraints, RLS, real inserts) — so it labels
// itself transform-only and never claims otherwise.
//
// ── Idempotency / resume ─────────────────────────────────────────────────
// Every insert is ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE, so a
// second run converges instead of duplicating (rule #10). Progress is
// checkpointed per restaurant per entity so an interrupted run resumes where
// it stopped (rule #11).
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { initFirebase, shallowKeys, getValue, requestCount } from "./lib/fbRead.mjs";
import { MigrationReport, OUTCOME, SEVERITY } from "./lib/report.mjs";
import { upsertRow, resolveRestaurantUuid, countTable } from "./lib/upsert.mjs";
import {
  toMoney, toDecimal, toPercent, toTimestamp, toTimeOfDay, toDateKey,
  normalizePhone, decodePhoneKey, mapEnum, resolveOrderStatus, resolvePaymentStatus,
  toText, toBool, toInt, toI18nJson, toJson, leftoverExtra,
  ORDER_ITEM_STATUS_MAP, PAYMENT_METHOD_MAP, ORDER_TYPE_MAP,
  RESERVATION_STATUS_MAP, COURIER_ASSIGNMENT_STATUS_MAP,
  CHANGE_REQUEST_TYPE_MAP, CHANGE_REQUEST_STATUS_MAP,
  ORDER_STATUS_MAP as ORDER_STATUS_MAP_REF,
} from "./lib/normalize.mjs";
import * as w35 from "./lib/transforms-wave35.mjs";
import { accept, runWaves35, WAVE2_CONFLICT, drop, postgresCounts } from "./lib/run-engine.mjs";
import { enforceProductionApplyGate, MIGRATION_PHASE } from "./lib/productionMigrateAuthorize.mjs";
import {
  assertCheckpointBinding,
  checkpointBinding,
  commitRestaurantThenCheckpoint,
  emptyCheckpoint,
  restaurantCompleted,
  atomicWriteJsonFile,
} from "./lib/migrationCheckpoint.mjs";
import { createPgAttemptStore, ATTEMPT_STATUS, checkpointPhaseFamily, casAttempt } from "./lib/productionMigrationAttempt.mjs";
import { classifyOrderFinancials } from "./lib/orderFinancials.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, "../../..");
const REPORT_DIR = path.join(REPO_ROOT, "docs/migration-reports");
const CHECKPOINT = path.join(REPORT_DIR, ".migration-checkpoint.json");

// ── CLI ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const MODE = has("--apply") ? "apply" : has("--verify") ? "verify" : "dry-run";
const ONLY_RESTAURANT = val("--restaurant");
const LIMIT = Number(val("--limit", "0")) || 0;
const RESUME = has("--resume");
const RESET_CHECKPOINT = has("--reset-checkpoint");

// ── checkpoint ────────────────────────────────────────────────────────────
function loadCheckpoint() {
  // Apply/verify start a new pass unless the caller asked to resume — otherwise
  // a just-finished dry-run checkpoint would skip every restaurant.
  if (RESET_CHECKPOINT || ((MODE === "apply" || MODE === "verify") && !RESUME) || !existsSync(CHECKPOINT)) {
    return emptyCheckpoint();
  }
  try { return JSON.parse(readFileSync(CHECKPOINT, "utf8")); }
  catch { return emptyCheckpoint(); }
}
function saveCheckpoint(cp) {
  mkdirSync(REPORT_DIR, { recursive: true });
  atomicWriteJsonFile(CHECKPOINT, cp);
}

// ── optional PostgreSQL ───────────────────────────────────────────────────
// isPgAvailable() only reports whether POSTGRES_* config EXISTS, which is not
// the same as a server answering — .env can name a database that is not
// running. Reporting "connected" on the strength of config alone would put a
// false basis on every reconciliation line, so this actually opens a
// connection and runs `SELECT 1` before claiming anything.
let pgMod = null;
async function loadPg() {
  if (pgMod !== null) return pgMod;
  pgMod = false;
  try {
    const m = await import("../postgres.js");
    if (!m.isPgAvailable()) return pgMod;
    const client = await m.getPool().connect();
    try {
      await client.query("SELECT 1");
      pgMod = m;
    } finally {
      client.release();
    }
  } catch (err) {
    pgConnectError = err?.message || String(err);
    pgMod = false;
  }
  return pgMod;
}
let pgConnectError = null;

// ── transform helpers ─────────────────────────────────────────────────────
// Each transform returns { row, issues[], warnings[] }. `issues` are fatal for
// that record (it will be skipped and reported); `warnings` are recorded but
// the record still migrates.

// RTDB returns an ARRAY, not an object, whenever a node's keys are the
// consecutive integers 0..n — so a collection someone once wrote with numeric
// keys arrives here as `[...]`. `typeof [] === "object"` alone would let it
// through and produce a row of nulls, which is the silent-loss failure mode
// rule #14 forbids.
function isRecord(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function collect(target, res, field, { fatal = true } = {}) {
  if (res.ok) {
    if (res.warnings) for (const w of res.warnings) target.warnings.push({ field, ...w });
    return res.value;
  }
  (fatal ? target.issues : target.warnings).push({ field, reason: res.reason, detail: res.detail });
  return null;
}

/** customers/$phoneKey → customers row */
function transformCustomer(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) {
    t.issues.push({ field: "(record)", reason: "record_not_an_object" });
    return { row: null, ...t };
  }
  const decoded = decodePhoneKey(key);
  const normalized = normalizePhone(key) || normalizePhone(rec.phone);
  if (!normalized) {
    t.warnings.push({ field: "normalized_phone", reason: "phone_unparseable", detail: key });
  }
  const consumed = new Set([
    "phone", "id", "name", "notes", "status", "createdAt", "updatedAt", "lastVisit",
    "personalDiscount", "personalDiscountReason", "personalDiscountSource", "personalDiscountSetAt",
    "discountPercent", "totalSpent", "ordersCount", "visits", "loyalty", "loyaltyLevel",
    "loyaltyPoints", "loyaltyCard", "isVip", "vipDiscountPercent", "vipOrdersTotal",
    "savedAddresses", "orderIds", "oneTimeDiscounts",
  ]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    original_phone_key: decoded,
    normalized_phone: normalized,
    name: collect(t, toText(rec.name), "name", { fatal: false }),
    notes: collect(t, toText(rec.notes), "notes", { fatal: false }),
    status: collect(t, toText(rec.status), "status", { fatal: false }),
    personal_discount: collect(t, toPercent(rec.personalDiscount), "personalDiscount", { fatal: false }) ?? "0.00",
    personal_discount_reason: collect(t, toText(rec.personalDiscountReason), "personalDiscountReason", { fatal: false }),
    personal_discount_source: collect(t, toText(rec.personalDiscountSource), "personalDiscountSource", { fatal: false }),
    personal_discount_set_at: collect(t, toTimestamp(rec.personalDiscountSetAt), "personalDiscountSetAt", { fatal: false }),
    discount_percent: collect(t, toPercent(rec.discountPercent), "discountPercent", { fatal: false }),
    total_spent: collect(t, toMoney(rec.totalSpent), "totalSpent", { fatal: false }) ?? "0.00",
    orders_count: collect(t, toInt(rec.ordersCount), "ordersCount", { fatal: false }) ?? 0,
    visits: collect(t, toInt(rec.visits), "visits", { fatal: false }) ?? 0,
    last_visit: collect(t, toTimestamp(rec.lastVisit), "lastVisit", { fatal: false }),
    loyalty_level: collect(t, toText(rec.loyaltyLevel ?? rec.loyalty), "loyaltyLevel", { fatal: false }),
    loyalty_points: collect(t, toMoney(rec.loyaltyPoints), "loyaltyPoints", { fatal: false }) ?? "0.00",
    loyalty_card: collect(t, toJson(rec.loyaltyCard), "loyaltyCard", { fatal: false }),
    is_vip: collect(t, toBool(rec.isVip, false), "isVip", { fatal: false }) ?? false,
    vip_discount_percent: collect(t, toPercent(rec.vipDiscountPercent), "vipDiscountPercent", { fatal: false }),
    vip_orders_total: collect(t, toMoney(rec.vipOrdersTotal), "vipOrdersTotal", { fatal: false }) ?? "0.00",
    extra: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
    updated_at: collect(t, toTimestamp(rec.updatedAt), "updatedAt", { fatal: false }),
  };
  return { row, ...t };
}

/** orders/$orderId → orders row (items handled separately) */
function transformOrder(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) {
    t.issues.push({ field: "(record)", reason: "record_not_an_object" });
    return { row: null, ...t };
  }

  // Required: a status must be resolvable and createdAt must be valid.
  const st = resolveOrderStatus(rec);
  if (!st.ok) t.issues.push({ field: "status", reason: st.reason, detail: st.detail });

  const createdAt = toTimestamp(rec.createdAt);
  if (!createdAt.ok) t.issues.push({ field: "createdAt", reason: createdAt.reason, detail: createdAt.detail });
  else if (createdAt.value === null) t.issues.push({ field: "createdAt", reason: "createdAt_missing" });

  // orderType is absent on 45 of 59 live orders, so it has to be derived —
  // but only from POSITIVE evidence in the same record, never from a blanket
  // default (rule #20). A delivery order carries isDelivery/deliveryType/
  // deliveryAddress; a dine-in order carries a table. When neither is
  // present the type is genuinely unknown and is recorded as 'unknown'
  // rather than guessed into a bucket that would silently distort every
  // dine-in-vs-delivery report built on top of it.
  let orderType = null;
  if (rec.orderType !== undefined && rec.orderType !== null && rec.orderType !== "") {
    orderType = collect(t, mapEnum(rec.orderType, ORDER_TYPE_MAP, "order_type"), "orderType");
  } else if (rec.isDelivery === true || rec.deliveryType === "delivery" || rec.deliveryAddress) {
    orderType = "delivery";
    t.warnings.push({ field: "orderType", reason: "order_type_inferred_delivery_from_record_evidence" });
  } else if (rec.table !== undefined && rec.table !== null && rec.table !== "") {
    orderType = "dine_in";
    t.warnings.push({ field: "orderType", reason: "order_type_inferred_dine_in_from_table_present" });
  } else {
    orderType = "unknown";
    t.warnings.push({ field: "orderType", reason: "order_type_unknown_no_evidence", detail: "no orderType/isDelivery/deliveryAddress/table" });
  }

  // FK resolution against this restaurant's reference maps.
  const tableLabel = rec.table !== undefined && rec.table !== null ? String(rec.table) : null;
  let tableRef = null;
  if (tableLabel) {
    tableRef = ctx.maps.tablesByNumber.get(String(tableLabel)) || ctx.maps.tablesByKey.get(String(tableLabel)) || null;
    if (!tableRef) t.warnings.push({ field: "table", reason: "table_reference_unresolved", detail: tableLabel });
  }
  const waiterRef = rec.waiterId ? ctx.maps.users.get(rec.waiterId) || null : null;
  if (rec.waiterId && !waiterRef) t.warnings.push({ field: "waiterId", reason: "employee_reference_unresolved", detail: rec.waiterId });
  const chefRef = rec.chefId ? ctx.maps.users.get(rec.chefId) || null : null;
  if (rec.chefId && !chefRef) t.warnings.push({ field: "chefId", reason: "employee_reference_unresolved", detail: rec.chefId });
  const creatorRef = rec.createdByWaiterId ? ctx.maps.users.get(rec.createdByWaiterId) || null : null;
  if (rec.createdByWaiterId && !creatorRef) t.warnings.push({ field: "createdByWaiterId", reason: "employee_reference_unresolved", detail: rec.createdByWaiterId });

  const custPhone = rec.customerPhone ?? rec.customerId ?? rec.clientPhone ?? null;
  const custNorm = custPhone ? normalizePhone(custPhone) : null;
  const custRef = custNorm ? ctx.maps.customersByPhone.get(custNorm) || null : null;
  if (custNorm && !custRef) {
    t.warnings.push({ field: "customerId", reason: "customer_reference_unresolved", detail: custNorm });
  }

  const paymentStatus = resolvePaymentStatus(rec);
  const consumed = new Set([
    "status", "statusKey", "statusV2", "statusLabel", "statusV2Label", "statusHistory",
    "orderNumber", "orderType", "deliveryType", "isDelivery", "source", "table",
    "waiterId", "chefId", "createdByWaiterId", "createdByWaiter", "createdByWaiterName",
    "createdByClient", "clientId", "customerId", "customerName", "customerPhone", "clientPhone",
    "total", "originalTotal", "discount", "discountAmount", "discountPercent",
    "discountSource", "discountReason", "discountApplied", "deliveryFee", "fastFeeAmount",
    "payment", "paymentMethod", "deliveryPaymentMethod", "paidAt", "deliveryAddress",
    "notes", "priority", "loyaltyLevel", "loyaltyVisits", "loyaltyAutoApplied",
    "inventoryDeducted", "chefScoreAwarded", "items", "createdAt", "updatedAt",
    "confirmedAt", "approvedAt", "cookingStartedAt", "startedAt", "readyAt", "finishedAt",
    "deliveredAt", "cancelledAt", "serviceFeeAmount", "subtotal",
  ]);

  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    order_number: collect(t, toInt(rec.orderNumber), "orderNumber", { fatal: false }),
    order_type: orderType || "unknown",
    source: collect(t, toText(rec.source), "source", { fatal: false }),
    table_id: tableRef,
    table_label: tableLabel,
    waiter_id: waiterRef,
    chef_id: chefRef,
    created_by_employee_id: creatorRef,
    customer_id: custRef,
    courier_id: null,
    customer_name_snapshot: collect(t, toText(rec.customerName), "customerName", { fatal: false }),
    customer_phone_snapshot: custPhone ? String(custPhone) : null,
    status: st.ok ? st.value : null,
    status_raw: rec.status ?? null,
    status_key_raw: rec.statusKey ?? null,
    status_v2_raw: rec.statusV2 ?? null,
    status_label_raw: rec.statusLabel ?? null,
    subtotal: collect(t, toMoney(rec.subtotal), "subtotal", { fatal: false }) ?? "0.00",
    discount_amount: collect(t, toMoney(rec.discountAmount ?? rec.discount), "discountAmount", { fatal: false }) ?? "0.00",
    discount_percent: collect(t, toPercent(rec.discountPercent), "discountPercent", { fatal: false }),
    discount_source: collect(t, toText(rec.discountSource), "discountSource", { fatal: false }),
    discount_reason: collect(t, toText(rec.discountReason), "discountReason", { fatal: false }),
    service_fee_amount: collect(t, toMoney(rec.serviceFeeAmount ?? rec.payment?.serviceFeeAmount), "serviceFeeAmount", { fatal: false }) ?? "0.00",
    delivery_fee: collect(t, toMoney(rec.deliveryFee), "deliveryFee", { fatal: false }) ?? "0.00",
    fast_fee_amount: collect(t, toMoney(rec.fastFeeAmount), "fastFeeAmount", { fatal: false }) ?? "0.00",
    original_total: collect(t, toMoney(rec.originalTotal), "originalTotal", { fatal: false }) ?? "0.00",
    total: collect(t, toMoney(rec.total), "total") ?? "0.00",
    payment_status: paymentStatus.value,
    payment_method: collect(t, toText(rec.payment?.method ?? rec.paymentMethod), "paymentMethod", { fatal: false }),
    // Polymorphic in production (object or bare string) — preserved as-is.
    delivery_address: collect(t, toJson(rec.deliveryAddress), "deliveryAddress", { fatal: false }),
    delivery_type: collect(t, toText(rec.deliveryType), "deliveryType", { fatal: false }),
    is_delivery: collect(t, toBool(rec.isDelivery, false), "isDelivery", { fatal: false }) ?? false,
    notes: collect(t, toText(rec.notes), "notes", { fatal: false }),
    priority: collect(t, toBool(rec.priority, false), "priority", { fatal: false }) ?? false,
    loyalty_level: collect(t, toText(rec.loyaltyLevel), "loyaltyLevel", { fatal: false }),
    loyalty_visits: collect(t, toInt(rec.loyaltyVisits), "loyaltyVisits", { fatal: false }),
    loyalty_auto_applied: collect(t, toBool(rec.loyaltyAutoApplied, false), "loyaltyAutoApplied", { fatal: false }) ?? false,
    inventory_deducted: collect(t, toBool(rec.inventoryDeducted, false), "inventoryDeducted", { fatal: false }) ?? false,
    chef_score_awarded: collect(t, toBool(rec.chefScoreAwarded, false), "chefScoreAwarded", { fatal: false }) ?? false,
    created_at: createdAt.ok ? createdAt.value : null,
    updated_at: collect(t, toTimestamp(rec.updatedAt), "updatedAt", { fatal: false }),
    confirmed_at: collect(t, toTimestamp(rec.confirmedAt ?? rec.approvedAt), "confirmedAt", { fatal: false }),
    cooking_started_at: collect(t, toTimestamp(rec.cookingStartedAt ?? rec.startedAt), "cookingStartedAt", { fatal: false }),
    ready_at: collect(t, toTimestamp(rec.readyAt ?? rec.finishedAt), "readyAt", { fatal: false }),
    served_at: null,
    delivered_at: collect(t, toTimestamp(rec.deliveredAt), "deliveredAt", { fatal: false }),
    paid_at: collect(t, toTimestamp(rec.paidAt ?? rec.payment?.paidAt), "paidAt", { fatal: false }),
    cancelled_at: collect(t, toTimestamp(rec.cancelledAt), "cancelledAt", { fatal: false }),
    extra: (() => {
      const extraObj = JSON.parse(leftoverExtra(rec, consumed) || "{}");
      if (rec.waiterId && !waiterRef) extraObj.unresolved_waiter_id = rec.waiterId;
      if (rec.chefId && !chefRef) extraObj.unresolved_chef_id = rec.chefId;
      if (rec.createdByWaiterId && !creatorRef) extraObj.unresolved_created_by_waiter_id = rec.createdByWaiterId;
      extraObj.financial_reconciliation = classifyOrderFinancials(rec);
      return JSON.stringify(extraObj);
    })(),
  };
  return { row, ...t };
}

function transformOrderItem(itemKey, item, ctx, orderLegacyId) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(item)) {
    t.issues.push({ field: "(record)", reason: "record_not_an_object" });
    return { row: null, ...t };
  }
  if (item.name === undefined || item.name === null || item.name === "") {
    t.issues.push({ field: "name", reason: "item_name_missing" });
  }
  if (item.price === undefined || item.price === null) {
    t.issues.push({ field: "price", reason: "item_price_missing" });
  }

  // The composite key is "{menuItemId}__{timestampMs}"; the menu id is the
  // part before "__". Fall back to the record's own id field.
  const legacyMenuId = item.id ?? (String(itemKey).includes("__") ? String(itemKey).split("__")[0] : String(itemKey));
  const menuRef = legacyMenuId ? ctx.maps.menu.get(legacyMenuId) || null : null;
  if (legacyMenuId && !menuRef) {
    t.warnings.push({ field: "menu_item_id", reason: "menu_item_reference_unresolved", detail: legacyMenuId });
  }

  const price = collect(t, toMoney(item.price), "price");
  const qty = collect(t, toDecimal(item.qty ?? 1, 3), "qty", { fatal: false }) ?? "1.000";
  let lineTotal = collect(t, toMoney(item.total), "total", { fatal: false });
  if (lineTotal === null && price !== null) {
    lineTotal = (Number(price) * Number(qty)).toFixed(2);
    t.warnings.push({ field: "line_total", reason: "line_total_computed_from_price_x_qty" });
  }

  const status = item.status !== undefined && item.status !== null && item.status !== ""
    ? collect(t, mapEnum(item.status, ORDER_ITEM_STATUS_MAP, "item_status"), "status")
    : "pending";

  const consumed = new Set(["id", "name", "price", "qty", "total", "status", "kitchenStatus",
    "modifiers", "extras", "variant", "variants", "isCombo", "notes", "comment"]);

  const row = {
    legacy_rtdb_id: String(itemKey),
    restaurant_id: ctx.restaurantId,
    legacy_order_id: orderLegacyId,
    menu_item_id: menuRef,
    legacy_menu_id: legacyMenuId,
    name_snapshot: collect(t, toI18nJson(item.name), "name"),
    price_snapshot: price ?? "0.00",
    qty,
    line_total: lineTotal ?? "0.00",
    modifiers: collect(t, toJson(item.modifiers ?? [], "[]"), "modifiers", { fatal: false }) ?? "[]",
    extras: collect(t, toJson(item.extras ?? [], "[]"), "extras", { fatal: false }) ?? "[]",
    variant_snapshot: collect(t, toJson(item.variant ?? item.variants ?? null), "variant", { fatal: false }),
    status: status || "pending",
    status_raw: item.status ?? null,
    kitchen_status: collect(t, toText(item.kitchenStatus), "kitchenStatus", { fatal: false }),
    is_combo: collect(t, toBool(item.isCombo, false), "isCombo", { fatal: false }) ?? false,
    notes: collect(t, toText(item.notes ?? item.comment), "notes", { fatal: false }),
    extra: leftoverExtra(item, consumed),
    line_total_origin: lineTotal != null && item.total != null && item.total !== "" ? "source_item_total" : "computed_price_x_qty",
  };
  if (row.line_total_origin === "computed_price_x_qty") {
    const extraObj = JSON.parse(row.extra || "{}");
    extraObj.line_total_origin = "computed_price_x_qty";
    row.extra = JSON.stringify(extraObj);
  } else {
    const extraObj = JSON.parse(row.extra || "{}");
    extraObj.line_total_origin = "source_item_total";
    row.extra = JSON.stringify(extraObj);
  }
  delete row.line_total_origin;
  return { row, ...t };
}

// statusHistory is keyed BY STATUS NAME with a timestamp value, so one order
// yields one row per distinct status it passed through. It is expanded inline
// in the orders branch of main() rather than in its own transform, because it
// is the only sub-entity whose key IS the status.

/** reservations/$id → reservations row */
function transformReservation(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) {
    t.issues.push({ field: "(record)", reason: "record_not_an_object" });
    return { row: null, ...t };
  }
  const status = rec.status ? collect(t, mapEnum(rec.status, RESERVATION_STATUS_MAP, "reservation_status"), "status") : "pending";
  const dateRes = rec.date ? toDateKey(String(rec.date)) : { ok: true, value: null };
  if (!dateRes.ok) t.warnings.push({ field: "date", reason: dateRes.reason, detail: String(rec.date) });
  const timeRes = toTimeOfDay(rec.time);
  if (!timeRes.ok) t.warnings.push({ field: "time", reason: timeRes.reason, detail: String(rec.time) });

  const tableLabel = rec.table ?? rec.tableNumber ?? null;
  const tableRef = tableLabel != null
    ? ctx.maps.tablesByNumber.get(String(tableLabel)) || ctx.maps.tablesByKey.get(String(tableLabel)) || null
    : null;
  if (tableLabel != null && !tableRef) {
    t.warnings.push({ field: "table", reason: "table_reference_unresolved", detail: String(tableLabel) });
  }

  const phone = rec.phone ?? rec.customerPhone ?? null;
  const consumed = new Set(["date", "time", "status", "table", "tableNumber", "guests",
    "name", "customerName", "phone", "customerPhone", "notes", "source", "createdAt", "updatedAt"]);

  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    table_id: tableRef,
    legacy_table_key: tableLabel != null ? String(tableLabel) : null,
    customer_id: phone ? ctx.maps.customersByPhone.get(normalizePhone(phone)) || null : null,
    customer_name: collect(t, toText(rec.name ?? rec.customerName), "name", { fatal: false }),
    customer_phone: phone ? String(phone) : null,
    guests: collect(t, toInt(rec.guests), "guests", { fatal: false }),
    reserved_date: dateRes.ok ? dateRes.value : null,
    reserved_time: timeRes.ok ? timeRes.value : null,
    reserved_at: null,
    status: status || "pending",
    status_raw: rec.status ?? null,
    source: collect(t, toText(rec.source), "source", { fatal: false }),
    notes: collect(t, toText(rec.notes), "notes", { fatal: false }),
    extra: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
    updated_at: collect(t, toTimestamp(rec.updatedAt), "updatedAt", { fatal: false }),
  };
  return { row, ...t };
}

/** couriers/$id → couriers row */
function transformCourier(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) {
    t.issues.push({ field: "(record)", reason: "record_not_an_object" });
    return { row: null, ...t };
  }
  const consumed = new Set(["name", "phone", "status", "vehicleType", "active", "createdAt", "updatedAt"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    employee_id: ctx.maps.users.get(key) || null,
    name: collect(t, toText(rec.name), "name", { fatal: false }),
    phone: collect(t, toText(rec.phone), "phone", { fatal: false }),
    status: collect(t, toText(rec.status), "status", { fatal: false }) ?? "offline",
    vehicle_type: collect(t, toText(rec.vehicleType), "vehicleType", { fatal: false }),
    active: collect(t, toBool(rec.active, true), "active", { fatal: false }) ?? true,
    extra: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
    updated_at: collect(t, toTimestamp(rec.updatedAt), "updatedAt", { fatal: false }),
  };
  return { row, ...t };
}

/** courierAssignments/$id → courier_assignments row */
function transformCourierAssignment(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) {
    t.issues.push({ field: "(record)", reason: "record_not_an_object" });
    return { row: null, ...t };
  }
  const status = rec.status
    ? collect(t, mapEnum(rec.status, COURIER_ASSIGNMENT_STATUS_MAP, "courier_assignment_status"), "status")
    : "assigned";
  const consumed = new Set(["orderId", "courierId", "status", "subStage", "assignedAt",
    "acceptedAt", "pickedUpAt", "deliveredAt", "kpiCalculated", "createdAt", "updatedAt"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    legacy_order_id: rec.orderId ? String(rec.orderId) : null,
    legacy_courier_id: rec.courierId ? String(rec.courierId) : null,
    status: status || "assigned",
    status_raw: rec.status ?? null,
    sub_stage: collect(t, toText(rec.subStage), "subStage", { fatal: false }),
    assigned_at: collect(t, toTimestamp(rec.assignedAt), "assignedAt", { fatal: false }),
    accepted_at: collect(t, toTimestamp(rec.acceptedAt), "acceptedAt", { fatal: false }),
    picked_up_at: collect(t, toTimestamp(rec.pickedUpAt), "pickedUpAt", { fatal: false }),
    delivered_at: collect(t, toTimestamp(rec.deliveredAt), "deliveredAt", { fatal: false }),
    kpi_calculated: collect(t, toBool(rec.kpiCalculated, false), "kpiCalculated", { fatal: false }) ?? false,
    stage_timestamps: "{}",
    extra: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
  };
  return { row, ...t };
}

/** orderChangeRequests/$id → order_change_requests row */
function transformChangeRequest(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) {
    t.issues.push({ field: "(record)", reason: "record_not_an_object" });
    return { row: null, ...t };
  }
  const rt = rec.requestType
    ? collect(t, mapEnum(rec.requestType, CHANGE_REQUEST_TYPE_MAP, "change_request_type"), "requestType")
    : null;
  if (!rt) t.issues.push({ field: "requestType", reason: "change_request_type_missing" });
  const st = rec.status
    ? collect(t, mapEnum(rec.status, CHANGE_REQUEST_STATUS_MAP, "change_request_status"), "status")
    : "pending";
  const consumed = new Set(["orderId", "itemKey", "requestType", "status", "requestedBy",
    "resolvedBy", "reason", "createdAt", "resolvedAt"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    legacy_order_id: rec.orderId ? String(rec.orderId) : null,
    legacy_item_key: rec.itemKey ? String(rec.itemKey) : null,
    request_type: rt,
    request_type_raw: rec.requestType ?? null,
    status: st || "pending",
    status_raw: rec.status ?? null,
    requested_by: collect(t, toText(rec.requestedBy), "requestedBy", { fatal: false }),
    resolved_by: collect(t, toText(rec.resolvedBy), "resolvedBy", { fatal: false }),
    reason: collect(t, toText(rec.reason), "reason", { fatal: false }),
    payload: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
    resolved_at: collect(t, toTimestamp(rec.resolvedAt), "resolvedAt", { fatal: false }),
  };
  return { row, ...t };
}

/** orders/$orderId/payment → payments row */
function transformPayment(orderLegacyId, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) return { row: null, ...t, skip: true };
  const method = rec.method
    ? collect(t, mapEnum(rec.method, PAYMENT_METHOD_MAP, "payment_method"), "method")
    : "unknown";
  const consumed = new Set(["method", "paid", "paidAt", "requested", "approved",
    "adminNotified", "kassir", "finalTotal", "serviceFeeAmount", "paidByWaiter", "paidByWaiterId"]);
  const row = {
    legacy_rtdb_id: "payment",
    restaurant_id: ctx.restaurantId,
    legacy_order_id: orderLegacyId,
    method: method || "unknown",
    method_raw: rec.method ?? null,
    amount: collect(t, toMoney(rec.finalTotal), "finalTotal", { fatal: false }) ?? "0.00",
    service_fee_amount: collect(t, toMoney(rec.serviceFeeAmount), "serviceFeeAmount", { fatal: false }) ?? "0.00",
    final_total: collect(t, toMoney(rec.finalTotal), "finalTotal", { fatal: false }),
    paid: collect(t, toBool(rec.paid, false), "paid", { fatal: false }) ?? false,
    paid_at: collect(t, toTimestamp(rec.paidAt), "paidAt", { fatal: false }),
    requested: collect(t, toBool(rec.requested, false), "requested", { fatal: false }) ?? false,
    approved: collect(t, toBool(rec.approved, false), "approved", { fatal: false }) ?? false,
    admin_notified: collect(t, toBool(rec.adminNotified, false), "adminNotified", { fatal: false }) ?? false,
    legacy_cashier: collect(t, toText(rec.kassir), "kassir", { fatal: false }),
    paid_by_employee_id: rec.paidByWaiterId ? ctx.maps.users.get(rec.paidByWaiterId) || null : null,
    extra: leftoverExtra(rec, consumed),
  };
  return { row, ...t };
}

// ── entity pipeline definition ────────────────────────────────────────────
// Order matters: dependencies first (requirement #13).
const ENTITIES = [
  { name: "customers", collection: "customers", transform: transformCustomer },
  { name: "couriers", collection: "couriers", transform: transformCourier },
  { name: "orders", collection: "orders", transform: transformOrder },        // special-cased: also items/history/payment
  { name: "order_change_requests", collection: "orderChangeRequests", transform: transformChangeRequest },
  { name: "courier_assignments", collection: "courierAssignments", transform: transformCourierAssignment },
  { name: "reservations", collection: "reservations", transform: transformReservation },
];

// ── reference maps ────────────────────────────────────────────────────────
// In transform-only mode these hold the legacy id itself (a truthy marker
// proving the reference resolves); with PostgreSQL they hold real uuids.
async function buildReferenceMaps(restId, pg, client) {
  const maps = {
    tablesByKey: new Map(),
    tablesByNumber: new Map(),
    users: new Map(),
    menu: new Map(),
    customersByPhone: new Map(),
    suppliers: new Map(),
    inventory: new Map(),
    orders: new Map(),
    couriers: new Map(),
    semiFinished: new Map(),
    purchaseOrders: new Map(),
  };

  if (pg && client) {
    const q = async (sql) => (await client.query(sql, [restId])).rows;
    for (const r of await q(`SELECT id, legacy_rtdb_id, number FROM tables WHERE restaurant_id = (SELECT id FROM restaurants WHERE legacy_rtdb_id = $1)`)) {
      if (r.legacy_rtdb_id) maps.tablesByKey.set(r.legacy_rtdb_id, r.id);
      if (r.number != null) maps.tablesByNumber.set(String(r.number), r.id);
    }
    for (const r of await q(`SELECT id, legacy_rtdb_id FROM employees WHERE restaurant_id = (SELECT id FROM restaurants WHERE legacy_rtdb_id = $1)`)) {
      if (r.legacy_rtdb_id) maps.users.set(r.legacy_rtdb_id, r.id);
    }
    for (const r of await q(`SELECT id, legacy_rtdb_id FROM menu_items WHERE restaurant_id = (SELECT id FROM restaurants WHERE legacy_rtdb_id = $1)`)) {
      if (r.legacy_rtdb_id) maps.menu.set(r.legacy_rtdb_id, r.id);
    }
    for (const r of await q(`SELECT id, normalized_phone FROM customers WHERE restaurant_id = (SELECT id FROM restaurants WHERE legacy_rtdb_id = $1)`)) {
      if (r.normalized_phone) maps.customersByPhone.set(r.normalized_phone, r.id);
    }
    try {
      for (const r of await q(`SELECT id, legacy_rtdb_id FROM suppliers WHERE restaurant_id = (SELECT id FROM restaurants WHERE legacy_rtdb_id = $1)`)) {
        if (r.legacy_rtdb_id) maps.suppliers.set(r.legacy_rtdb_id, r.id);
      }
    } catch { /* table may not exist if only wave 0-1 applied */ }
    try {
      for (const r of await q(`SELECT id, legacy_rtdb_id FROM inventory_items WHERE restaurant_id = (SELECT id FROM restaurants WHERE legacy_rtdb_id = $1)`)) {
        if (r.legacy_rtdb_id) maps.inventory.set(r.legacy_rtdb_id, r.id);
      }
    } catch { /* same */ }
    try {
      for (const r of await q(`SELECT id, legacy_rtdb_id FROM orders WHERE restaurant_id = (SELECT id FROM restaurants WHERE legacy_rtdb_id = $1)`)) {
        if (r.legacy_rtdb_id) maps.orders.set(r.legacy_rtdb_id, r.id);
      }
    } catch { /* same */ }
    try {
      for (const r of await q(`SELECT id, legacy_rtdb_id FROM couriers WHERE restaurant_id = (SELECT id FROM restaurants WHERE legacy_rtdb_id = $1)`)) {
        if (r.legacy_rtdb_id) maps.couriers.set(r.legacy_rtdb_id, r.id);
      }
    } catch { /* same */ }
    return maps;
  }

  // Transform-only: resolve references against Firebase itself.
  const [tables, users, menu, customers] = await Promise.all([
    getValue(`restaurants/${restId}/tables`).catch(() => null),
    getValue(`restaurants/${restId}/users`).catch(() => null),
    getValue(`restaurants/${restId}/menu`).catch(() => null),
    getValue(`restaurants/${restId}/customers`).catch(() => null),
  ]);
  for (const [k, v] of Object.entries(tables || {})) {
    maps.tablesByKey.set(k, k);
    if (v && v.number != null) maps.tablesByNumber.set(String(v.number), k);
  }
  for (const k of Object.keys(users || {})) maps.users.set(k, k);
  for (const k of Object.keys(menu || {})) maps.menu.set(k, k);
  for (const k of Object.keys(customers || {})) {
    const n = normalizePhone(k);
    if (n) maps.customersByPhone.set(n, k);
  }
  return maps;
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  const pg = await loadPg();
  const transformOnly = !pg;
  const productionPhase = (RESET_CHECKPOINT || !RESUME)
    ? MIGRATION_PHASE.FULL_AFTER_WAVE1
    : MIGRATION_PHASE.RESUME_FULL;
  let productionAuth = null;
  if (pg) {
    const cfg = pg.maskedConfig();
    const live = await pg.getPool().connect();
    try {
      productionAuth = await enforceProductionApplyGate({
        repoRoot: REPO_ROOT,
        env: process.env,
        argv,
        client: live,
        masked: cfg,
        writesCommitted: MODE === "apply",
        resume: RESUME,
        phase: productionPhase,
      });
      console.log(`[target] ${productionAuth.mode} ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
      if (productionAuth.attempt?.attempt_id) {
        console.log(`[attempt] ${productionAuth.attempt.attempt_id} status=${productionAuth.attempt.status} phase=${productionPhase}`);
      }
    } finally {
      live.release();
    }
  }

  console.log("=".repeat(78));
  console.log(`Nesta ERP — Firebase → PostgreSQL migration engine`);
  console.log(`mode         : ${MODE}`);
  console.log(`postgres     : ${pg ? "connected (verified with SELECT 1)"
    : `UNAVAILABLE — running TRANSFORM-ONLY dry run${pgConnectError ? ` (${pgConnectError})` : ""}`}`);
  console.log(`firebase     : READ-ONLY (lib/fbRead.mjs exports no mutating verb)`);
  if (MODE === "apply" && transformOnly) {
    console.error("\n--apply requires PostgreSQL. Refusing to continue.");
    process.exit(2);
  }
  console.log("=".repeat(78));

  initFirebase();
  const report = new MigrationReport({
    mode: transformOnly ? `${MODE} (transform-only, no PostgreSQL)` : MODE,
    reportDir: REPORT_DIR,
  });

  const checkpoint = loadCheckpoint();
  const fullBinding = productionAuth?.attempt
    ? checkpointBinding({
      attemptId: productionAuth.attempt.attempt_id,
      targetFingerprint: productionAuth.targetFingerprint,
      candidateCommit: productionAuth.attempt.candidate_commit,
      cutoverWindowIdentity: productionAuth.cutoverWindowIdentity,
      phase: checkpointPhaseFamily(productionPhase),
      freezeIdentity: productionAuth.freezeIdentity,
      batchId: `full-${productionAuth.attempt.attempt_id}`,
    })
    : null;
  if (fullBinding) {
    const hasWork = Object.keys(checkpoint.completedRestaurants || {}).length > 0;
    if (RESUME && (hasWork || checkpoint.binding)) {
      assertCheckpointBinding(checkpoint, fullBinding);
    } else {
      checkpoint.binding = fullBinding;
      checkpoint.version = fullBinding.checkpointVersion;
      checkpoint.completedRestaurants = checkpoint.completedRestaurants || {};
    }
  }
  if (RESUME && Object.keys(checkpoint.completedRestaurants || checkpoint.completed || {}).length) {
    console.log(`Resuming — already-completed restaurants will be skipped.`);
  }

  let restIds = ONLY_RESTAURANT ? [ONLY_RESTAURANT] : await shallowKeys("restaurants");
  restIds.sort();
  if (LIMIT && !RESUME) restIds = restIds.slice(0, LIMIT);
  console.log(`Restaurants to process: ${restIds.length}\n`);

  // Global duplicate detection across the whole run.
  const seenPhonesPerRest = new Map();

  const pool = pg ? pg.getPool() : null;
  const willWrite = !!pg && (MODE === "apply" || MODE === "dry-run");
  let applyFailed = false;

  for (let i = 0; i < restIds.length; i++) {
    const restId = restIds[i];
    process.stdout.write(`[${i + 1}/${restIds.length}] ${restId} … `);

    if (RESUME && restaurantCompleted(checkpoint, restId)) {
      console.log("already checkpointed");
      continue;
    }

    let client = null;
    let restaurantUuid = null;
    let restaurantOk = true;
    if (willWrite) {
      client = await pool.connect();
      await client.query("BEGIN");
      restaurantUuid = await resolveRestaurantUuid(client, restId);
      if (!restaurantUuid && MODE === "apply") {
        await client.query("ROLLBACK");
        client.release();
        report.seen(restId, "restaurants", 1);
        report.lose({
          restId, entity: "restaurants",
          firebasePath: `restaurants/${restId}`, legacyId: restId,
          reason: "restaurant_not_in_postgres", severity: SEVERITY.ERROR,
          detail: "Wave 1 (restaurants/employees/menu) must be applied first",
          outcome: OUTCOME.SKIPPED,
        });
        console.log("SKIPPED (restaurant not in PostgreSQL — run wave1 apply first)");
        applyFailed = true;
        continue;
      }
    }

    let maps;
    try {
      maps = await buildReferenceMaps(restId, pg, client);
    } catch (err) {
      if (client) { await client.query("ROLLBACK").catch(() => {}); client.release(); }
      report.fatalError(`referenceMaps:${restId}`, err);
      console.log("FAILED (reference maps)");
      applyFailed = true;
      continue;
    }
    const ctx = { restaurantId: restId, restaurantUuid, maps };
    const writer = willWrite && restaurantUuid ? { client, restaurantUuid } : null;
    let touched = 0;

    for (const ent of ENTITIES) {
      let node;
      try {
        node = await getValue(`restaurants/${restId}/${ent.collection}`);
      } catch (err) {
        restaurantOk = false;
        report.fatalError(`read:${restId}/${ent.collection}`, err);
        applyFailed = true;
        continue;
      }
      if (!node || typeof node !== "object") continue;

      const entries = Object.entries(node);
      report.seen(restId, ent.name, entries.length);
      touched += entries.length;

      const seenLegacy = new Set();

      for (const [key, rec] of entries) {
        const fbPath = `restaurants/${restId}/${ent.collection}/${key}`;

        if (seenLegacy.has(key)) {
          report.lose({
            restId, entity: ent.name, firebasePath: fbPath, legacyId: key,
            reason: "duplicate_legacy_id", severity: SEVERITY.ERROR, outcome: OUTCOME.DUPLICATE,
          });
          continue;
        }
        seenLegacy.add(key);

        const result = ent.transform(key, rec, ctx);
        const { row } = result;

        if (ent.name === "customers" && row?.normalized_phone) {
          const set = seenPhonesPerRest.get(restId) || new Map();
          if (set.has(row.normalized_phone)) {
            report.lose({
              restId, entity: ent.name, firebasePath: fbPath, legacyId: key,
              reason: "duplicate_normalized_phone_in_restaurant", severity: SEVERITY.WARN,
              detail: `also ${set.get(row.normalized_phone)} — NOT merged, manual review required`,
              outcome: OUTCOME.DUPLICATE,
            });
            seenPhonesPerRest.set(restId, set);
            continue;
          }
          set.set(row.normalized_phone, key);
          seenPhonesPerRest.set(restId, set);
        }

        const pgId = await accept(report, writer, {
          restId, entity: ent.name, fbPath, legacyId: key, result,
          table: ent.name, conflict: WAVE2_CONFLICT[ent.name],
          patch: ent.name === "courier_assignments"
            ? (r) => ({ ...r, order_id: ctx.maps.orders.get(r.legacy_order_id) || null, courier_id: ctx.maps.couriers.get(r.legacy_courier_id) || r.courier_id || null })
            : ent.name === "order_change_requests"
              ? (r) => ({ ...r, order_id: ctx.maps.orders.get(r.legacy_order_id) || null })
              : undefined,
        });
        if (pgId && ent.name === "orders") ctx.maps.orders.set(key, pgId);
        if (pgId && ent.name === "couriers") ctx.maps.couriers.set(key, pgId);
        if (pgId && ent.name === "customers" && row.normalized_phone) {
          ctx.maps.customersByPhone.set(row.normalized_phone, pgId);
        }

        if (ent.name === "orders" && result.issues?.length === 0 && row) {
          const items = rec.items && typeof rec.items === "object" ? Object.entries(rec.items) : [];
          report.seen(restId, "order_items", items.length);
          for (const [ik, item] of items) {
            const ir = transformOrderItem(ik, item, ctx, key);
            await accept(report, writer, {
              restId, entity: "order_items", fbPath: `${fbPath}/items/${ik}`,
              legacyId: ik, result: ir, table: "order_items",
              conflict: WAVE2_CONFLICT.order_items,
              patch: (r) => drop({ ...r, order_id: typeof pgId === "string" ? pgId : ctx.maps.orders.get(key) || null }, "legacy_order_id"),
            });
          }

          const hist = rec.statusHistory;
          if (hist && typeof hist === "object") {
            const entriesH = Object.entries(hist);
            report.seen(restId, "order_status_history", entriesH.length);
            for (const [statusName, raw] of entriesH) {
              const hpath = `${fbPath}/statusHistory/${statusName}`;
              let tsRaw = raw, changedBy = null;
              if (raw && typeof raw === "object") {
                tsRaw = raw.at ?? raw.ts ?? raw.time ?? raw.timestamp ?? null;
                changedBy = raw.by ?? raw.userId ?? null;
              }
              const ts = toTimestamp(tsRaw);
              const mapped = mapEnum(statusName, ORDER_STATUS_MAP_REF, "status_history");
              const hResult = {
                issues: [], warnings: [],
                row: {
                  restaurant_id: restId,
                  order_id: typeof pgId === "string" ? pgId : ctx.maps.orders.get(key) || null,
                  status: mapped.ok ? mapped.value : null,
                  status_raw: statusName,
                  changed_at: ts.ok ? ts.value : null,
                  changed_by: changedBy,
                  source: "rtdb_status_history",
                },
              };
              if (!mapped.ok) hResult.issues.push({ field: "status", reason: "status_history_unknown_status", detail: statusName });
              else if (!ts.ok || ts.value === null) hResult.issues.push({ field: "changed_at", reason: ts.ok ? "status_history_timestamp_missing" : ts.reason, detail: String(tsRaw) });
              await accept(report, writer, {
                restId, entity: "order_status_history", fbPath: hpath,
                legacyId: statusName, result: hResult, table: "order_status_history",
                conflict: WAVE2_CONFLICT.order_status_history,
              });
            }
          }

          if (rec.payment && typeof rec.payment === "object") {
            report.seen(restId, "payments", 1);
            const pr = transformPayment(key, rec.payment, ctx);
            await accept(report, writer, {
              restId, entity: "payments", fbPath: `${fbPath}/payment`,
              legacyId: key, result: pr, table: "payments",
              conflict: WAVE2_CONFLICT.payments,
              patch: (r) => ({ ...r, order_id: typeof pgId === "string" ? pgId : ctx.maps.orders.get(key) || null }),
            });
          }
        }
      }
    }

    try {
      touched += await runWaves35(restId, ctx, report, writer);
    } catch (err) {
      restaurantOk = false;
      applyFailed = true;
      report.fatalError(`waves35:${restId}`, err);
    }

    if (client) {
      try {
        if (!restaurantOk) {
          applyFailed = true;
          await client.query("ROLLBACK").catch(() => {});
        } else {
          await commitRestaurantThenCheckpoint({
            client,
            mode: MODE,
            checkpoint,
            restId,
            persist: saveCheckpoint,
          });
        }
      } catch (err) {
        applyFailed = true;
        report.fatalError(`tx:${restId}`, err);
        await client.query("ROLLBACK").catch(() => {});
      }
      client.release();
    }

    console.log(`${touched} records`);
  }

  // ── reconciliation ──────────────────────────────────────────────────────
  // Compares what Firebase holds against what the pipeline accounted for.
  // In transform-only mode "would migrate" replaces "is in PostgreSQL", and
  // the report says so rather than implying a database was checked.
  const per = report.perEntityTotals();
  let pgCounts = null;
  if (pg && (MODE === "apply" || MODE === "verify")) {
    const c = await pg.getPool().connect();
    try { pgCounts = await postgresCounts(c); }
    finally { c.release(); }
  }
  for (const [entity, c] of Object.entries(per)) {
    const accounted = c.migrated + c.skipped + c.failed + c.duplicate + c.malformed;
    const pgN = pgCounts ? pgCounts[entity] : null;
    const basis = pgCounts ? (RESUME ? "firebase_vs_transform_pipeline_resume" : "firebase_vs_postgres") : "firebase_vs_transform_pipeline";
    report.reconciliation[entity] = {
      firebaseRecords: c.firebaseRecords,
      accountedFor: accounted,
      wouldMigrate: c.migrated,
      postgresRows: pgN,
      difference: pgN == null || RESUME ? null : pgN - c.migrated,
      unaccounted: c.firebaseRecords - accounted,
      balanced: (RESUME || pgN == null)
        ? c.firebaseRecords === accounted
        : (pgN === c.migrated && c.firebaseRecords === accounted),
      basis,
    };
  }

  // A resumed run reports only what it still had to do, so it must not
  // overwrite the full run's `-latest` file — otherwise the moment you resume
  // a finished migration, the report everyone reads becomes an empty one.
  const basename = MODE === "verify" ? "verify"
    : MODE === "apply" ? (RESUME ? "apply-resume" : "apply")
    : (RESUME ? "dry-run-resume" : "dry-run");
  const file = report.write(basename);
  report.printSummary();

  const reconBasis = pgCounts ? "Firebase vs PostgreSQL" : "Firebase vs transform pipeline";
  console.log(`\nReconciliation (${reconBasis}):`);
  for (const [e, r] of Object.entries(report.reconciliation).sort()) {
    const pgBit = r.postgresRows == null ? "" : ` postgres=${String(r.postgresRows).padStart(6)} diff=${String(r.difference).padStart(4)}`;
    console.log(`  ${e.padEnd(24)} firebase=${String(r.firebaseRecords).padStart(6)} accounted=${String(r.accountedFor).padStart(6)}${pgBit} ${r.balanced ? "BALANCED" : `UNACCOUNTED=${r.unaccounted}`}`);
  }

  console.log(`\nFirebase REST reads: ${requestCount()}`);
  console.log(`Report written: ${path.relative(REPO_ROOT, file)}`);
  console.log(`Firebase was NOT modified.`);

  const unbalanced = Object.values(report.reconciliation).some((r) => !r.balanced);
  if (MODE === "apply" && productionAuth?.attempt) {
    const statusClient = await pg.getPool().connect();
    try {
      await casAttempt(createPgAttemptStore(statusClient), productionAuth.attempt, {
        nextStatus: (applyFailed || report.fatal.length || unbalanced)
          ? ATTEMPT_STATUS.FAILED
          : ATTEMPT_STATUS.FULL_COMPLETE,
        nextPhase: (applyFailed || report.fatal.length || unbalanced)
          ? productionAuth.attempt.phase
          : MIGRATION_PHASE.FULL_AFTER_WAVE1,
        full_checkpoint_id: fullBinding?.batchId || null,
      });
    } finally {
      statusClient.release();
    }
  }
  process.exit(report.fatal.length || unbalanced ? 1 : 0);
}

// Exported so db/tests/migration.test.mjs can exercise the real transforms —
// the same functions apply uses — rather than a test-only reimplementation
// that could drift from them.
export {
  transformCustomer,
  transformOrder,
  transformOrderItem,
  transformReservation,
  transformCourier,
  transformCourierAssignment,
  transformChangeRequest,
  transformPayment,
  ENTITIES,
};

/** Reference maps shaped like buildReferenceMaps' output, for tests. */
export function emptyMaps() {
  return {
    tablesByKey: new Map(),
    tablesByNumber: new Map(),
    users: new Map(),
    menu: new Map(),
    customersByPhone: new Map(),
    suppliers: new Map(),
    inventory: new Map(),
    orders: new Map(),
    couriers: new Map(),
    semiFinished: new Map(),
    purchaseOrders: new Map(),
  };
}

// Only run the engine when this file is the entry point. Importing it (as the
// tests do) must never start a migration or call process.exit.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedDirectly) {
  main().catch((err) => {
    console.error("\nENGINE FAILED:", err);
    process.exit(1);
  });
}
