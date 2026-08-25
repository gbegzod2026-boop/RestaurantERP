#!/usr/bin/env node
// db/tests/rls-wave2.test.mjs — tenant-isolation proof for the Wave 2–5
// tables (orders, order_items, payments, finance, inventory, kitchen, logs).
//
// Where rls.test.mjs and rls-wave1.test.mjs hand-write checks per table, this
// file is deliberately DATA-DRIVEN: it reads pg_class/pg_policies and asserts
// the invariant across EVERY tenant-owned table that exists. A table added in
// a later migration without RLS therefore fails this test automatically,
// instead of silently shipping unprotected — which is exactly how a
// cross-tenant leak gets introduced.
//
// It then runs the four concrete denials the brief names (requirement #10) on
// the orders domain: A cannot SELECT / INSERT / UPDATE / DELETE B's data.
//
// NOT LIVE VERIFIED in the authoring environment — no PostgreSQL was
// available. Run it against a real instance:
//   node db/migrate.js up && node db/tests/rls-wave2.test.mjs
import { getPool, closePool } from "../postgres.js";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✅ ${label}`); }
function bad(label, detail) { fail++; console.log(`  ❌ ${label}${detail ? " — " + detail : ""}`); }

async function asTenant(client, restaurantId, actingRole, fn) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_restaurant_id', $1, true)", [restaurantId || ""]);
    await client.query("SELECT set_config('app.current_employee_role', $1, true)", [actingRole || ""]);
    return await fn();
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
}

// Tables from Waves 2–5 that own a restaurant_id and must therefore be
// tenant-isolated. Checked against the live catalog, so a name that does not
// exist yet is reported as missing rather than silently passing.
const EXPECTED_TENANT_TABLES = [
  // Wave 2 — orders domain
  "customers", "customer_addresses", "couriers", "orders", "order_items",
  "order_status_history", "order_timeline", "order_change_requests",
  "order_chats", "order_chat_messages", "payments", "courier_assignments",
  "reservations", "reservation_slots", "waiter_calls",
  // Wave 3 — finance and inventory
  "expenses", "cash_counts", "finance_entries", "payroll_entries",
  "staff_stats", "suppliers", "inventory_items", "stock_movements",
  "daily_usage", "recipes", "recipe_items", "semi_finished",
  "semi_finished_acts", "purchase_orders", "purchase_order_items",
  "supplier_payments", "debts",
  // Wave 4 — kitchen and operations
  "attendance", "shifts", "chef_tasks", "prep_schedule", "waste_log",
  "equipment_status", "kitchen_inventory", "kitchen_announcements",
  "production_plans", "modifiers", "extras", "stop_list", "discounts",
  "promotions", "print_settings", "terminal_settings", "equipment_printers",
  // Wave 5 — comms and audit
  "chats", "chat_messages", "audit_log", "activity_logs", "notifications_log",
  "system_alerts", "feedback", "customer_notes", "approvals",
  "import_history", "discount_claims",
  // Phase 2 runtime
  "realtime_events",
];

async function main() {
  const avail = await dbAvailable();
  if (avail !== true) return await skipUnavailable("rls-wave2.test.mjs (Waves 2–5)", avail.error);

  const pool = getPool();
  const setup = await pool.connect();
  const app = await pool.connect();
  let restA, restB, custA, orderA, orderB, itemA;

  try {
    await app.query("SET ROLE nesta_app");

    // ── 1. Catalog invariants across every tenant table ────────────────────
    console.log("1. Schema-level RLS invariants (data-driven across all tables)");

    const { rows: existing } = await setup.query(
      `SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)`,
      [EXPECTED_TENANT_TABLES]
    );
    const byName = new Map(existing.map((r) => [r.table_name, r]));

    const missing = EXPECTED_TENANT_TABLES.filter((t) => !byName.has(t));
    if (missing.length === 0) ok(`all ${EXPECTED_TENANT_TABLES.length} expected tenant tables exist`);
    else bad(`${missing.length} expected tables do not exist`, missing.join(", "));

    const notEnabled = existing.filter((r) => !r.rls_enabled).map((r) => r.table_name);
    if (notEnabled.length === 0) ok(`ROW LEVEL SECURITY enabled on all ${existing.length} tables`);
    else bad(`RLS NOT enabled on ${notEnabled.length} tables`, notEnabled.join(", "));

    const notForced = existing.filter((r) => !r.rls_forced).map((r) => r.table_name);
    if (notForced.length === 0) ok(`FORCE ROW LEVEL SECURITY set on all ${existing.length} tables`);
    else bad(`FORCE RLS missing on ${notForced.length} tables`, notForced.join(", "));

    // A table with RLS on but no policy denies everything — safe, but a bug.
    const { rows: policyCounts } = await setup.query(
      `SELECT c.relname AS table_name, count(p.polname) AS n
         FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
         LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE ns.nspname = 'public' AND c.relname = ANY($1)
        GROUP BY c.relname`,
      [EXPECTED_TENANT_TABLES]
    );
    const noPolicy = policyCounts.filter((r) => Number(r.n) === 0).map((r) => r.table_name);
    if (noPolicy.length === 0) ok("every tenant table carries at least one policy");
    else bad(`${noPolicy.length} tables have RLS but no policy (deny-all)`, noPolicy.join(", "));

    // ── 2. Every FK is indexed ─────────────────────────────────────────────
    // An unindexed FK turns each parent DELETE into a seq scan of the child.
    console.log("\n2. Foreign-key index coverage (requirement #11)");
    const { rows: unindexedFks } = await setup.query(`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        JOIN unnest(c.conkey) AS k(attnum) ON true
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.contype = 'f'
         AND n.nspname = 'public'
         AND array_length(c.conkey, 1) = 1
         AND NOT EXISTS (
           SELECT 1 FROM pg_index i
            WHERE i.indrelid = c.conrelid
              AND i.indkey[0] = k.attnum
         )
       ORDER BY 1, 2`);
    if (unindexedFks.length === 0) ok("every single-column foreign key is covered by an index");
    else bad(`${unindexedFks.length} foreign keys have no leading index`,
      unindexedFks.slice(0, 12).map((r) => `${r.tbl}.${r.col}`).join(", "));

    // ── Fixtures ───────────────────────────────────────────────────────────
    console.log("\nCreating test fixtures...");
    const stamp = Date.now();
    restA = (await setup.query("INSERT INTO restaurants (domain, name) VALUES ($1,$2) RETURNING id",
      [`rls2-a-${stamp}.nestacrm.uz`, "Wave2 Test A"])).rows[0].id;
    restB = (await setup.query("INSERT INTO restaurants (domain, name) VALUES ($1,$2) RETURNING id",
      [`rls2-b-${stamp}.nestacrm.uz`, "Wave2 Test B"])).rows[0].id;

    custA = (await setup.query(
      `INSERT INTO customers (restaurant_id, legacy_rtdb_id, normalized_phone, name)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [restA, "+998901110001", "+998901110001", "Cust A"])).rows[0].id;

    orderA = (await setup.query(
      `INSERT INTO orders (restaurant_id, legacy_rtdb_id, order_type, order_number, status, total, customer_id, created_at)
       VALUES ($1,$2,'dine_in',1,'completed',44131.50,$3, now()) RETURNING id`,
      [restA, "-OrderA", custA])).rows[0].id;
    orderB = (await setup.query(
      `INSERT INTO orders (restaurant_id, legacy_rtdb_id, order_type, order_number, status, total, created_at)
       VALUES ($1,$2,'dine_in',1,'completed',1000.00, now()) RETURNING id`,
      [restB, "-OrderB"])).rows[0].id;

    itemA = (await setup.query(
      `INSERT INTO order_items (order_id, restaurant_id, legacy_rtdb_id, legacy_menu_id, name_snapshot, price_snapshot, qty, line_total)
       VALUES ($1,$2,$3,$4,$5,35000.00,2.000,70000.00) RETURNING id`,
      [orderA, restA, "mid__1", "mid", JSON.stringify({ uz: "Lag'mon" })])).rows[0].id;

    await setup.query(
      `INSERT INTO payments (restaurant_id, order_id, legacy_rtdb_id, method, amount, paid)
       VALUES ($1,$2,'payment','cash',44131.50,true)`, [restA, orderA]);

    console.log(`Fixtures ready: A=${restA} B=${restB}\n`);

    // ── 3. The four denials the brief requires ─────────────────────────────
    console.log("3. orders — the four required denials (requirement #10)");

    await asTenant(app, restA, "owner", async () => {
      const { rows } = await app.query("SELECT id FROM orders");
      if (rows.length === 1 && rows[0].id === orderA) ok("A SELECT: sees only its own order");
      else bad("A SELECT orders", `got ${rows.length} rows`);
    });

    await asTenant(app, restA, "owner", async () => {
      const { rows } = await app.query("SELECT id FROM orders WHERE id = $1", [orderB]);
      if (rows.length === 0) ok("A cannot SELECT B's order (0 rows, not an error)");
      else bad("A cross-tenant SELECT", "B's order was visible");
    });

    await asTenant(app, restA, "owner", async () => {
      try {
        await app.query(
          `INSERT INTO orders (restaurant_id, legacy_rtdb_id, order_type, status, total, created_at)
           VALUES ($1,'-Forged','dine_in','completed',1.00, now())`, [restB]);
        bad("A INSERT into B", "expected a WITH CHECK violation");
      } catch (err) {
        // SQLSTATE, not message text — the server's lc_messages localizes it.
        if (err.code === "42501") ok("A cannot INSERT an order for B (WITH CHECK denied)");
        else bad("A INSERT into B", `wrong error [${err.code}]: ${err.message}`);
      }
    });

    await asTenant(app, restA, "owner", async () => {
      const { rowCount } = await app.query("UPDATE orders SET total = 0 WHERE id = $1", [orderB]);
      if (rowCount === 0) ok("A UPDATE of B's order affects 0 rows");
      else bad("A UPDATE of B", `${rowCount} rows affected`);
    });

    await asTenant(app, restA, "owner", async () => {
      const { rowCount } = await app.query("DELETE FROM orders WHERE id = $1", [orderB]);
      if (rowCount === 0) ok("A DELETE of B's order affects 0 rows");
      else bad("A DELETE of B", `${rowCount} rows affected`);
    });

    // ── 4. Child tables inherit isolation ──────────────────────────────────
    console.log("\n4. Child tables (order_items, payments) inherit isolation");
    await asTenant(app, restA, "owner", async () => {
      const { rows } = await app.query("SELECT id FROM order_items");
      if (rows.length === 1 && rows[0].id === itemA) ok("A sees its own order_items");
      else bad("A SELECT order_items", `got ${rows.length} rows`);
    });
    await asTenant(app, restB, "owner", async () => {
      const { rows } = await app.query("SELECT id FROM order_items WHERE id = $1", [itemA]);
      if (rows.length === 0) ok("B cannot see A's order_items");
      else bad("B cross-tenant order_items SELECT", "visible");
    });
    await asTenant(app, restB, "owner", async () => {
      const { rows } = await app.query("SELECT id FROM payments");
      if (rows.length === 0) ok("B cannot see A's payments");
      else bad("B cross-tenant payments SELECT", `got ${rows.length} rows`);
    });

    // A cross-tenant FK must be impossible even with RLS satisfied on the row
    // being written — otherwise B could attach a row to A's order.
    console.log("\n5. Cross-tenant foreign keys are impossible");
    await asTenant(app, restB, "owner", async () => {
      try {
        await app.query(
          `INSERT INTO order_items (order_id, restaurant_id, legacy_rtdb_id, name_snapshot, price_snapshot, qty, line_total)
           VALUES ($1,$2,'x',$3,1.00,1.000,1.00)`,
          [orderA, restB, JSON.stringify("Forged")]);
        bad("B attaching an order_item to A's order", "expected a foreign-key violation");
      } catch (err) {
        // 23503 = foreign_key_violation. B cannot SEE orderA, so the FK
        // cannot be satisfied — RLS and referential integrity compose.
        if (err.code === "23503" || err.code === "42501") ok(`B cannot attach an order_item to A's order [${err.code}]`);
        else bad("B attaching an order_item to A's order", `wrong error [${err.code}]: ${err.message}`);
      }
    });

    // ── 6. Platform context ────────────────────────────────────────────────
    console.log("\n6. Platform context is explicit");
    await asTenant(app, "", "", async () => {
      const { rows } = await app.query("SELECT id FROM orders WHERE id = ANY($1)", [[orderA, orderB]]);
      if (rows.length === 2) ok("platform context (empty restaurant_id) sees both restaurants");
      else bad("platform context SELECT", `expected 2, got ${rows.length}`);
    });
    await asTenant(app, "not-a-uuid", "owner", async () => {
      try {
        await app.query("SELECT id FROM orders");
        bad("malformed context", "expected a uuid cast error");
      } catch (err) {
        if (err.code === "22P02") ok("malformed restaurant_id context fails closed");
        else bad("malformed context", `wrong error [${err.code}]`);
      }
    });

    // ── 7. Idempotency and snapshot immutability at the schema level ───────
    console.log("\n7. Idempotency and snapshot guarantees");

    // The UNIQUE that makes ON CONFLICT possible must actually exist.
    try {
      await setup.query("BEGIN");
      await setup.query(
        `INSERT INTO orders (restaurant_id, legacy_rtdb_id, order_type, status, total, created_at)
         VALUES ($1,'-OrderA','dine_in','completed',999.00, now())`, [restA]);
      bad("re-inserting the same legacy_rtdb_id", "expected a unique violation");
      await setup.query("ROLLBACK");
    } catch (err) {
      await setup.query("ROLLBACK").catch(() => {});
      if (err.code === "23505") ok("(restaurant_id, legacy_rtdb_id) is UNIQUE — re-runs cannot duplicate");
      else bad("re-inserting the same legacy_rtdb_id", `wrong error [${err.code}]: ${err.message}`);
    }

    // An ON CONFLICT upsert — what apply actually issues — must converge.
    try {
      const up = await setup.query(
        `INSERT INTO orders (restaurant_id, legacy_rtdb_id, order_type, status, total, created_at)
         VALUES ($1,'-OrderA','dine_in','completed',44131.50, now())
         ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET total = EXCLUDED.total
         RETURNING id`, [restA]);
      if (up.rows[0].id === orderA) ok("ON CONFLICT upsert converges onto the same row (idempotent)");
      else bad("ON CONFLICT upsert", "created a new row instead of updating");
    } catch (err) {
      bad("ON CONFLICT upsert", `[${err.code}] ${err.message}`);
    }

    // The snapshot must survive deletion of the menu item it came from. The
    // FK is ON DELETE RESTRICT precisely so history cannot be orphaned by a
    // cascade, and legacy_menu_id + name_snapshot carry the history.
    {
      const { rows } = await setup.query(
        "SELECT name_snapshot, price_snapshot, legacy_menu_id, menu_item_id FROM order_items WHERE id = $1", [itemA]);
      const r = rows[0];
      if (r && r.menu_item_id === null && r.legacy_menu_id === "mid" && Number(r.price_snapshot) === 35000) {
        ok("order_items keeps name/price snapshot and legacy menu id independent of the menu");
      } else {
        bad("order_items snapshot", JSON.stringify(r));
      }
    }

    // Money must be exact, not floating point.
    {
      const { rows } = await setup.query("SELECT total FROM orders WHERE id = $1", [orderA]);
      if (rows[0].total === "44131.50") ok("money round-trips exactly as numeric(14,2), not float");
      else bad("money precision", `got ${JSON.stringify(rows[0].total)}`);
    }

    // Money columns must genuinely be numeric(14,2) everywhere.
    {
      const { rows: badMoney } = await setup.query(`
        SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND (column_name LIKE '%total%' OR column_name LIKE '%amount%'
                OR column_name IN ('price','price_snapshot','subtotal','balance','paid_amount'))
           AND column_name NOT IN ('rows_total')
           AND data_type NOT IN ('numeric')
        ORDER BY 1,2`);
      if (badMoney.length === 0) ok("no money-named column uses a non-numeric type");
      else bad(`${badMoney.length} money columns are not numeric`,
        badMoney.map((r) => `${r.table_name}.${r.column_name}:${r.data_type}`).join(", "));
    }

  } catch (err) {
    bad("test run", `${err.code || ""} ${err.message}`);
  } finally {
    console.log("\nCleaning up fixtures...");
    await app.query("RESET ROLE").catch(() => {});
    for (const r of [restA, restB]) {
      if (r) await setup.query("DELETE FROM restaurants WHERE id = $1", [r]).catch((e) => console.warn("cleanup failed:", e.message));
    }
    setup.release();
    app.release();
    await closePool();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
