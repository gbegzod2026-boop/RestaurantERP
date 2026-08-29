// Step 2D — READ-ONLY production RTDB snapshot vs Step 2C baseline.
// fbRead GET only. Writes gitignored JSON. Never prints names, phones, hashes.
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initFirebase, shallowKeys, getValue, requestCount } from "./lib/fbRead.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.join(__dirname, "../../../docs/migration-reports");
const OUT = path.join(REPORT_DIR, "step2d-source-snapshot.json");

const STEP2C_BASELINE = {
  generatedAt: "2026-08-29T17:04:38.540Z",
  restaurants: 46,
  users: 85,
  credentialTrees: 44,
  customRoles: 13,
  modules: 792,
  subscriptionFields: 514,
  tables: 35,
  menu: 21,
  customers: 8,
  inventory: 13,
  ingredients: 13,
  suppliers: 2,
  orders: 59,
  orderItems: 147,
  payments: 54,
  expenses: 20,
  reservations: 6,
  couriers: 5,
  waiterCalls: 2,
  notifications: 90,
  chats: 3,
  discounts: 1,
  modifiers: 1,
  extras: 1,
  kitchenStationsPg: 330,
  auditLogMigrated: 36,
  auditLogSourceSeen: 39,
  rootPromocodes: 68751,
  orderTotalSum: 3402334.5,
  paymentSum: 995020,
  discountSum: 94487,
};

const TENANT_COLS = [
  "users", "tables", "menu", "customers", "orders", "inventory", "ingredients",
  "suppliers", "expenses", "reservations", "couriers", "customRoles", "waiterCalls",
  "notifications", "chats", "modules", "subscription", "kitchenStations",
  "modifiers", "extras", "discounts", "audit_log", "attendance",
];

async function main() {
  console.log("STEP 2D source snapshot — READ-ONLY");
  initFirebase();
  const dbUrl = process.env.FIREBASE_DATABASE_URL || "";
  let host = "(unparseable)";
  try { host = new URL(dbUrl).host; } catch { /* ignore */ }
  if (host.includes("nesta-staging") || !host || host === "(unparseable)") {
    console.error("Refusing: discovery host is not production RTDB:", host);
    process.exit(2);
  }
  console.log(`RTDB host class: ${host.replace(/^[^.]+/, "*")}`);

  const restIds = await shallowKeys("restaurants");
  console.log(`restaurants: ${restIds.length}`);
  const credTrees = await shallowKeys("credentials").catch(() => []);
  console.log(`credential trees: ${credTrees.length}`);
  // Do not download 68k root promocode keys here; that GET stalled the
  // preflight. Operational count is tenant discounts + systemData/promoCodes.
  // Root tree size is recorded from Step 2C and re-checked at T-60m with paging.
  let rootPromos = { counted: false, length: STEP2C_BASELINE.rootPromocodes, note: "not re-listed this pass; 2C classified stale" };
  const systemPromo = await shallowKeys("systemData/promoCodes").catch(() => []);
  console.log(`platform promoCodes: ${systemPromo.length}`);

  const counts = Object.fromEntries(TENANT_COLS.map((c) => [c, 0]));
  let orderItems = 0;
  let payments = 0;
  let orderTotalSum = 0;
  let paymentSum = 0;
  let discountSum = 0;

  for (let i = 0; i < restIds.length; i++) {
    const rid = restIds[i];
    if (i % 5 === 0) console.log(`[${i + 1}/${restIds.length}] ${rid}`);
    for (const col of TENANT_COLS) {
      const keys = await shallowKeys(`restaurants/${rid}/${col}`).catch(() => []);
      counts[col] += keys.length;
    }
    const orders = await getValue(`restaurants/${rid}/orders`).catch(() => null);
    if (!orders || typeof orders !== "object") continue;
    for (const rec of Object.values(orders)) {
      if (!rec || typeof rec !== "object") continue;
      if (typeof rec.total === "number") orderTotalSum += rec.total;
      if (typeof rec.discountAmount === "number") discountSum += rec.discountAmount;
      else if (typeof rec.discount === "number") discountSum += rec.discount;
      if (rec.items && typeof rec.items === "object") orderItems += Object.keys(rec.items).length;
      if (rec.payment && typeof rec.payment === "object") {
        payments++;
        const amt = rec.payment.finalTotal ?? rec.payment.amount;
        if (typeof amt === "number") paymentSum += amt;
      }
    }
  }

  const now = {
    restaurants: restIds.length,
    users: counts.users,
    credentialTrees: credTrees.length,
    customRoles: counts.customRoles,
    modules: counts.modules,
    subscriptionFields: counts.subscription,
    tables: counts.tables,
    menu: counts.menu,
    customers: counts.customers,
    inventory: counts.inventory,
    ingredients: counts.ingredients,
    suppliers: counts.suppliers,
    orders: counts.orders,
    orderItems,
    payments,
    expenses: counts.expenses,
    reservations: counts.reservations,
    couriers: counts.couriers,
    waiterCalls: counts.waiterCalls,
    notifications: counts.notifications,
    chats: counts.chats,
    discounts: counts.discounts,
    modifiers: counts.modifiers,
    extras: counts.extras,
    kitchenStations: counts.kitchenStations,
    auditLog: counts.audit_log,
    attendance: counts.attendance,
    rootPromocodes: rootPromos.length,
    rootPromocodesRecounted: rootPromos.counted === true,
    platformPromoCodes: systemPromo.length,
    orderTotalSum,
    paymentSum,
    discountSum,
  };

  const drift = {};
  for (const [k, base] of Object.entries(STEP2C_BASELINE)) {
    if (k === "generatedAt" || k === "kitchenStationsPg" || k === "auditLogMigrated" || k === "auditLogSourceSeen") continue;
    if (now[k] == null) continue;
    const d = now[k] - base;
    if (d !== 0) drift[k] = { baseline: base, now: now[k], delta: d };
  }
  if (now.kitchenStations !== STEP2C_BASELINE.kitchenStationsPg) {
    drift.kitchenStations = {
      baselinePg: STEP2C_BASELINE.kitchenStationsPg,
      now: now.kitchenStations,
      delta: now.kitchenStations - STEP2C_BASELINE.kitchenStationsPg,
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    mode: "READ-ONLY",
    rtdbHostClass: host.replace(/^[^.]+/, "*"),
    firebaseRequests: requestCount(),
    step2cBaselineAt: STEP2C_BASELINE.generatedAt,
    now,
    drift,
    drifted: Object.keys(drift).length > 0,
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error("STEP2D SNAPSHOT FAILED:", err.message);
  process.exit(1);
});
