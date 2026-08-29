import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initFirebase, shallowKeys, getValue } from "./lib/fbRead.mjs";
import { assertMigrationTarget } from "./lib/migrationTargetGuard.mjs";
import { getPool, maskedConfig, closePool, isPgAvailable } from "../postgres.js";
import { PG_COUNT_TABLES } from "./lib/run-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.join(__dirname, "../../../docs/migration-reports");
const AUDIT_DIR = path.join(__dirname, "../migration-audit");
const OUT = path.join(REPORT_DIR, "step2b-reconcile.json");
const QUARANTINE_OUT = path.join(REPORT_DIR, "step2b-quarantine.json");

const WAVE1_TABLES = [
  "restaurants", "employees", "employee_credentials", "custom_roles", "tables",
  "menu_categories", "menu_items", "combo_items", "kitchen_stations", "restaurant_settings",
  "restaurant_modules",
];

const SECRET_KEY = /pass(word|hash|enc)?|token|secret|cookie|credential|private[_-]?key|api[_-]?key/i;

function redact(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) out[k] = "[REDACTED]";
    else out[k] = redact(v);
  }
  return out;
}

async function one(c, sql, params = []) {
  return (await c.query(sql, params)).rows[0];
}

async function n(c, sql, params = []) {
  return Number((await one(c, sql, params)).n);
}

function latestAudit() {
  if (!existsSync(AUDIT_DIR)) return null;
  const files = readdirSync(AUDIT_DIR)
    .filter((f) => f.endsWith("-apply.json") || f.endsWith("-dryrun.json"))
    .sort();
  if (!files.length) return null;
  return JSON.parse(readFileSync(path.join(AUDIT_DIR, files[files.length - 1]), "utf8"));
}

function latestMigrationReport() {
  const p = path.join(REPORT_DIR, "apply-latest.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

async function main() {
  if (!isPgAvailable()) throw new Error("PostgreSQL not configured");
  const cfg = maskedConfig();
  assertMigrationTarget(cfg);
  initFirebase();
  const pool = getPool();
  const c = await pool.connect();
  await c.query("SELECT set_config('app.current_restaurant_id', '', true)");

  const counts = {};
  for (const t of [...WAVE1_TABLES, ...PG_COUNT_TABLES]) {
    try { counts[t] = await n(c, `SELECT count(*)::int AS n FROM ${t}`); }
    catch { counts[t] = null; }
  }

  const money = await one(c, `
    SELECT
      count(*)::int AS orders,
      coalesce(sum(total), 0)::text AS order_total_sum,
      coalesce(sum(subtotal), 0)::text AS subtotal_sum,
      coalesce(sum(discount_amount), 0)::text AS discount_sum,
      coalesce(sum(original_total), 0)::text AS original_total_sum
    FROM orders
  `);
  const items = await one(c, `
    SELECT count(*)::int AS n,
           coalesce(sum(line_total), 0)::text AS line_total_sum
    FROM order_items
  `);
  const pays = await one(c, `
    SELECT count(*)::int AS n,
           coalesce(sum(amount), 0)::text AS amount_sum,
           coalesce(sum(final_total), 0)::text AS final_total_sum
    FROM payments
  `);
  const expenses = await one(c, `SELECT count(*)::int AS n, coalesce(sum(amount), 0)::text AS amount_sum FROM expenses`).catch(() => ({ n: 0, amount_sum: "0" }));
  const inventory = await one(c, `
    SELECT count(*)::int AS n,
           coalesce(sum(stock), 0)::text AS stock_sum,
           coalesce(sum(stock * price), 0)::text AS stock_value_sum
    FROM inventory_items
  `).catch(() => ({ n: 0, stock_sum: "0", stock_value_sum: "0" }));

  const fk = {
    fixtureLikeRestaurants: await n(c, "SELECT count(*)::int AS n FROM restaurants WHERE legacy_rtdb_id LIKE 'rest_1999%'"),
    orphanRestaurantEmployees: await n(c, `
      SELECT count(*)::int AS n FROM employees e
      WHERE NOT EXISTS (SELECT 1 FROM restaurants r WHERE r.id = e.restaurant_id)
    `),
    ordersWaiterNullWithUnresolved: await n(c, `
      SELECT count(*)::int AS n FROM orders
      WHERE waiter_id IS NULL AND extra ? 'unresolved_waiter_id'
    `),
    ordersCreatedByNullWithUnresolved: await n(c, `
      SELECT count(*)::int AS n FROM orders
      WHERE created_by_employee_id IS NULL AND extra ? 'unresolved_created_by_waiter_id'
    `),
    ordersWaiterOrphan: await n(c, `
      SELECT count(*)::int AS n FROM orders o
      WHERE waiter_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = o.waiter_id AND e.restaurant_id = o.restaurant_id)
    `),
    orderItemMenuOrphan: await n(c, `
      SELECT count(*)::int AS n FROM order_items i
      WHERE menu_item_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM menu_items m
          WHERE m.id = i.menu_item_id AND m.restaurant_id = i.restaurant_id
        )
    `),
    orderCustomerOrphan: await n(c, `
      SELECT count(*)::int AS n FROM orders o
      WHERE customer_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM customers cu WHERE cu.id = o.customer_id AND cu.restaurant_id = o.restaurant_id)
    `),
    inventorySupplierOrphan: await n(c, `
      SELECT count(*)::int AS n FROM inventory_items i
      WHERE supplier_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.id = i.supplier_id AND s.restaurant_id = i.restaurant_id)
    `),
    crossTenantOrderWaiter: await n(c, `
      SELECT count(*)::int AS n FROM orders o
      JOIN employees e ON e.id = o.waiter_id
      WHERE e.restaurant_id IS DISTINCT FROM o.restaurant_id
    `),
    crossTenantOrderChef: await n(c, `
      SELECT count(*)::int AS n FROM orders o
      JOIN employees e ON e.id = o.chef_id
      WHERE e.restaurant_id IS DISTINCT FROM o.restaurant_id
    `),
    crossTenantOrderItemMenu: await n(c, `
      SELECT count(*)::int AS n FROM order_items i
      JOIN menu_items m ON m.id = i.menu_item_id
      WHERE m.restaurant_id IS DISTINCT FROM i.restaurant_id
    `),
    crossTenantInventorySupplier: await n(c, `
      SELECT count(*)::int AS n FROM inventory_items i
      JOIN suppliers s ON s.id = i.supplier_id
      WHERE s.restaurant_id IS DISTINCT FROM i.restaurant_id
    `),
    duplicateLegacyEmployees: await n(c, `
      SELECT coalesce(sum(d),0)::int AS n FROM (
        SELECT count(*) AS d FROM employees
        GROUP BY restaurant_id, legacy_rtdb_id HAVING count(*) > 1
      ) s
    `),
    duplicateLegacyOrders: await n(c, `
      SELECT coalesce(sum(d),0)::int AS n FROM (
        SELECT count(*) AS d FROM orders
        GROUP BY restaurant_id, legacy_rtdb_id HAVING count(*) > 1
      ) s
    `),
    duplicateLegacyRestaurants: await n(c, `
      SELECT coalesce(sum(d),0)::int AS n FROM (
        SELECT count(*) AS d FROM restaurants
        GROUP BY legacy_rtdb_id HAVING count(*) > 1
      ) s
    `),
    nullRequiredEmployeeRole: await n(c, `SELECT count(*)::int AS n FROM employees WHERE role IS NULL OR role = ''`),
    employeesNonCanonicalRole: await n(c, `
      SELECT count(*)::int AS n FROM employees
      WHERE role NOT IN ('admin','owner','manager','waiter','chef','cashier','courier','kassa')
    `),
    employeesMigrationPending: await n(c, `SELECT count(*)::int AS n FROM employees WHERE role = 'migration_pending'`),
    restaurantsMigrationReview: await n(c, `SELECT count(*)::int AS n FROM restaurants WHERE status = 'migration_review'`),
  };

  const p1 = await one(c, `
    SELECT
      (SELECT coalesce(sum((SELECT count(*) FROM jsonb_object_keys(extra))),0)::int FROM restaurant_modules) AS module_keys,
      (SELECT count(*)::int FROM restaurants WHERE subscription <> '{}'::jsonb) AS subscription_restaurants
  `).catch(() => ({ module_keys: 0, subscription_restaurants: 0 }));
  const finExtra = await one(c, `
    SELECT
      coalesce(sum((extra->'financial_reconciliation'->>'gap_header_minus_lines')::numeric),0)::text AS gap_sum,
      coalesce(sum((extra->'financial_reconciliation'->>'remaining')::numeric),0)::text AS remaining_sum,
      coalesce(sum((extra->'financial_reconciliation'->>'delivery_fee')::numeric),0)::text AS delivery_sum,
      coalesce(sum((extra->'financial_reconciliation'->>'service_fee')::numeric),0)::text AS service_sum,
      coalesce(sum((extra->'financial_reconciliation'->>'fast_fee')::numeric),0)::text AS fast_sum,
      count(*) FILTER (WHERE extra->'financial_reconciliation'->>'remainder_kind' = 'LEGACY_INCONSISTENCY')::int AS legacy_inconsistency_orders,
      count(*) FILTER (WHERE extra->'financial_reconciliation'->>'remainder_kind' IN ('NONE','ROUNDING'))::int AS explained_orders
    FROM orders
  `).catch(() => ({}));

  const restIds = await shallowKeys("restaurants");
  const credTrees = await shallowKeys("credentials").catch(() => []);
  let fbOrderCount = 0;
  let fbOrderTotal = 0;
  let fbItemCount = 0;
  let fbPaidSum = 0;
  let fbPaymentCount = 0;
  let fbDiscountSum = 0;
  const fbCollectionCounts = {
    users: 0, tables: 0, menu: 0, customers: 0, orders: 0, inventory: 0,
    ingredients: 0, suppliers: 0, expenses: 0, reservations: 0, couriers: 0,
    customRoles: 0, waiterCalls: 0, notifications: 0, chats: 0, modules: 0, subscription: 0,
  };
  for (const rid of restIds) {
    for (const col of Object.keys(fbCollectionCounts)) {
      const keys = await shallowKeys(`restaurants/${rid}/${col}`).catch(() => []);
      fbCollectionCounts[col] += keys.length;
    }
    const orders = await getValue(`restaurants/${rid}/orders`).catch(() => null);
    if (!orders || typeof orders !== "object") continue;
    for (const rec of Object.values(orders)) {
      if (!rec || typeof rec !== "object") continue;
      fbOrderCount++;
      if (typeof rec.total === "number") fbOrderTotal += rec.total;
      if (typeof rec.discountAmount === "number") fbDiscountSum += rec.discountAmount;
      else if (typeof rec.discount === "number") fbDiscountSum += rec.discount;
      if (rec.items && typeof rec.items === "object") fbItemCount += Object.keys(rec.items).length;
      if (rec.payment && typeof rec.payment === "object") {
        fbPaymentCount++;
        const amt = rec.payment.finalTotal ?? rec.payment.amount;
        if (typeof amt === "number") fbPaidSum += amt;
      }
    }
  }

  const entities = [
    ["restaurants", restIds.length, counts.restaurants],
    ["employees/users", fbCollectionCounts.users, counts.employees],
    ["credentials", credTrees.length, counts.employee_credentials],
    ["custom_roles", fbCollectionCounts.customRoles, counts.custom_roles],
    ["modules", fbCollectionCounts.modules, p1.module_keys],
    ["subscription_fields", fbCollectionCounts.subscription, p1.subscription_restaurants],
    ["tables", fbCollectionCounts.tables, counts.tables],
    ["menu", fbCollectionCounts.menu, counts.menu_items],
    ["customers", fbCollectionCounts.customers, counts.customers],
    ["inventory", fbCollectionCounts.inventory, counts.inventory_items],
    ["ingredients", fbCollectionCounts.ingredients, counts.inventory_items],
    ["suppliers", fbCollectionCounts.suppliers, counts.suppliers],
    ["orders", fbOrderCount, counts.orders],
    ["order_items", fbItemCount, counts.order_items],
    ["payments", fbPaymentCount, counts.payments],
    ["expenses", fbCollectionCounts.expenses, counts.expenses],
    ["reservations", fbCollectionCounts.reservations, counts.reservations],
    ["couriers", fbCollectionCounts.couriers, counts.couriers],
    ["waiter_calls", fbCollectionCounts.waiterCalls, counts.waiter_calls],
    ["notifications", fbCollectionCounts.notifications, counts.notifications_log],
    ["chats", fbCollectionCounts.chats, counts.chats],
  ];

  const wave1Audit = latestAudit();
  const applyReport = latestMigrationReport();
  const quarantine = [];
  for (const ex of wave1Audit?.exceptions || []) {
    quarantine.push(redact({
      tenant: ex.restaurantLegacyId || ex.legacyId || null,
      sourcePath: ex.scope === "employee" ? `restaurants/${ex.restaurantLegacyId}/users/${ex.legacyId}` : null,
      sourceKey: ex.legacyId || null,
      entity: ex.scope || "unknown",
      reason: ex.reason,
      action: ex.action || null,
      businessDecisionRequired: !!ex.businessDecisionRequired,
      detail: ex.detail || ex.generatedFields || null,
    }));
  }
  for (const d of applyReport?.dataLoss || []) {
    quarantine.push(redact({
      tenant: d.restaurantId || null,
      sourcePath: d.firebasePath || null,
      sourceKey: d.legacyId || null,
      entity: d.entity || "unknown",
      reason: d.reason,
      outcome: d.outcome || null,
      detail: d.detail || null,
    }));
  }

  const financialDiff = {
    orderCount: { firebase: fbOrderCount, postgres: money.orders, diff: money.orders - fbOrderCount },
    orderTotalSum: { firebase: fbOrderTotal, postgres: money.order_total_sum, match: String(fbOrderTotal) === String(Number(money.order_total_sum)) },
    itemCount: { firebase: fbItemCount, postgres: items.n, diff: items.n - fbItemCount },
    paymentCount: { firebase: fbPaymentCount, postgres: pays.n, diff: pays.n - fbPaymentCount },
    paymentSum: { firebase: fbPaidSum, postgres: pays.final_total_sum },
    discountSum: { firebase: fbDiscountSum, postgres: money.discount_sum },
  };

  const out = {
    generatedAt: new Date().toISOString(),
    target: { host: cfg.host, port: cfg.port, database: cfg.database },
    pgCounts: counts,
    sourceCollectionCounts: fbCollectionCounts,
    credentialTrees: credTrees.length,
    reconciliation: entities.map(([entity, source, target]) => ({
      entity,
      sourceCount: source,
      targetCount: target,
      diff: target == null ? null : target - source,
    })),
    financial: {
      pg: { ...money, items: items.n, itemLineTotal: items.line_total_sum, payments: pays.n, paymentAmount: pays.amount_sum, paymentFinal: pays.final_total_sum, expenses: expenses.n, expenseSum: expenses.amount_sum, inventory: inventory.n, inventoryStock: inventory.stock_sum, inventoryValue: inventory.stock_value_sum },
      firebase: { orders: fbOrderCount, orderTotalSum: fbOrderTotal, items: fbItemCount, payments: fbPaymentCount, paymentSum: fbPaidSum, discountSum: fbDiscountSum },
      diff: financialDiff,
      extraClassification: finExtra,
    },
    p1: p1,
    fk,
    quarantineCount: quarantine.length,
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
  writeFileSync(QUARANTINE_OUT, JSON.stringify({
    generatedAt: out.generatedAt,
    count: quarantine.length,
    records: quarantine,
  }, null, 2), "utf8");
  console.log(JSON.stringify({ ...out, quarantineFile: QUARANTINE_OUT }, null, 2));
  c.release();
  await closePool();
}

main().catch((err) => {
  console.error("RECONCILE FAILED:", err.message);
  process.exit(1);
});
