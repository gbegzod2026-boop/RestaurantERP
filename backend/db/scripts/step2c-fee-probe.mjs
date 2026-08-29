import { getPool, maskedConfig, closePool, isPgAvailable } from "../postgres.js";
import { assertMigrationTarget } from "./lib/migrationTargetGuard.mjs";
import { classifyFromStoredExtra } from "./lib/orderFinancials.mjs";

const WRITE = process.argv.includes("--write-reclass");

async function main() {
  if (!isPgAvailable()) throw new Error("PostgreSQL not configured");
  assertMigrationTarget(maskedConfig());
  const pool = getPool();
  const c = await pool.connect();
  await c.query("SELECT set_config('app.current_restaurant_id', '', true)");

  if (WRITE) {
    const rows = (await c.query(`SELECT id, extra FROM orders`)).rows;
    let updated = 0;
    for (const row of rows) {
      const next = classifyFromStoredExtra(row.extra?.financial_reconciliation);
      if (!next) continue;
      const extra = { ...(row.extra || {}), financial_reconciliation: next };
      await c.query(`UPDATE orders SET extra = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(extra)]);
      updated++;
    }
    console.error(`[fee-probe] rewrote financial_reconciliation on ${updated} orders in ${maskedConfig().database}`);
  }

  const r = (await c.query(`
    SELECT count(*)::int AS orders,
           coalesce(sum(total),0)::text AS total,
           coalesce(sum(discount_amount),0)::text AS discount,
           coalesce(sum(delivery_fee),0)::text AS delivery,
           coalesce(sum(service_fee_amount),0)::text AS service,
           coalesce(sum(fast_fee_amount),0)::text AS fast,
           coalesce(sum(original_total),0)::text AS original,
           coalesce(sum(subtotal),0)::text AS subtotal
    FROM orders
  `)).rows[0];
  const i = (await c.query(`SELECT coalesce(sum(line_total),0)::text AS lines FROM order_items`)).rows[0];
  const p1 = (await c.query(`
    SELECT
      (SELECT count(*)::int FROM restaurants WHERE status = 'migration_review') AS restaurants_migration_review,
      (SELECT count(*)::int FROM employees WHERE role = 'migration_pending') AS employees_migration_pending,
      (SELECT count(*)::int FROM employees WHERE active = false) AS employees_inactive,
      (SELECT coalesce(sum((SELECT count(*) FROM jsonb_object_keys(extra))),0)::int FROM restaurant_modules) AS module_keys,
      (SELECT count(*)::int FROM restaurants WHERE subscription <> '{}'::jsonb) AS subscription_restaurants,
      (SELECT count(*)::int FROM custom_roles) AS custom_roles
  `)).rows[0];
  const roles = (await c.query(`
    SELECT role, count(*)::int AS n, count(*) FILTER (WHERE active = false)::int AS inactive
    FROM employees GROUP BY role ORDER BY n DESC
  `)).rows;
  const identities = (await c.query(`
    SELECT extra->'financial_reconciliation'->>'identity' AS identity,
           extra->'financial_reconciliation'->>'remainder_kind' AS remainder_kind,
           count(*)::int AS n,
           coalesce(sum((extra->'financial_reconciliation'->>'remaining')::numeric),0)::text AS remaining_sum,
           coalesce(sum((extra->'financial_reconciliation'->>'gap_header_minus_lines')::numeric),0)::text AS gap_sum
    FROM orders
    GROUP BY 1, 2
    ORDER BY n DESC
  `)).rows;
  const fin = (await c.query(`
    SELECT
      coalesce(sum((extra->'financial_reconciliation'->>'gap_header_minus_lines')::numeric),0)::text AS gap_sum,
      coalesce(sum((extra->'financial_reconciliation'->>'explained_by_identity')::numeric),0)::text AS explained_by_identity_sum,
      coalesce(sum((extra->'financial_reconciliation'->>'remaining')::numeric),0)::text AS remaining_sum,
      coalesce(sum((extra->'financial_reconciliation'->>'delivery_fee')::numeric),0)::text AS delivery_sum,
      coalesce(sum((extra->'financial_reconciliation'->>'service_fee')::numeric),0)::text AS service_sum,
      coalesce(sum((extra->'financial_reconciliation'->>'fast_fee')::numeric),0)::text AS fast_sum,
      coalesce(sum((extra->'financial_reconciliation'->>'discount')::numeric),0)::text AS discount_from_extra,
      coalesce(sum((extra->'financial_reconciliation'->>'original_vs_total_plus_discount')::numeric),0)::text AS original_vs_total_plus_discount,
      count(*) FILTER (WHERE extra->'financial_reconciliation'->>'remainder_kind' = 'LEGACY_INCONSISTENCY')::int AS legacy_inconsistency_orders,
      count(*) FILTER (WHERE extra->'financial_reconciliation'->>'remainder_kind' = 'ROUNDING')::int AS rounding_orders,
      count(*) FILTER (WHERE extra->'financial_reconciliation'->>'remainder_kind' = 'NONE')::int AS none_remainder_orders,
      count(*) FILTER (WHERE extra->'financial_reconciliation' IS NULL)::int AS missing_classification
    FROM orders
  `)).rows[0];
  const inconsistent = (await c.query(`
    SELECT
      r.legacy_rtdb_id AS restaurant,
      o.legacy_rtdb_id AS order_id,
      o.extra->'financial_reconciliation'->>'identity' AS identity,
      (o.extra->'financial_reconciliation'->>'gap_header_minus_lines')::numeric AS gap,
      (o.extra->'financial_reconciliation'->>'explained_by_identity')::numeric AS explained,
      (o.extra->'financial_reconciliation'->>'remaining')::numeric AS remaining,
      (o.extra->'financial_reconciliation'->>'delivery_fee')::numeric AS delivery,
      (o.extra->'financial_reconciliation'->>'service_fee')::numeric AS service,
      (o.extra->'financial_reconciliation'->>'discount')::numeric AS discount,
      (o.extra->'financial_reconciliation'->>'original_vs_total_plus_discount')::numeric AS orig_delta
    FROM orders o
    JOIN restaurants r ON r.id = o.restaurant_id
    WHERE o.extra->'financial_reconciliation'->>'remainder_kind' = 'LEGACY_INCONSISTENCY'
    ORDER BY abs((o.extra->'financial_reconciliation'->>'remaining')::numeric) DESC
  `)).rows;
  console.log(JSON.stringify({
    database: maskedConfig().database,
    wroteReclass: WRITE,
    orders: r,
    lines: i.lines,
    p1,
    roles,
    identities,
    extraClassification: fin,
    inconsistentCount: inconsistent.length,
    inconsistent,
  }, null, 2));
  c.release();
  await closePool();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
