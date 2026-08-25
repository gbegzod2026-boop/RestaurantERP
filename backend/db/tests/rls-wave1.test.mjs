#!/usr/bin/env node
// db/tests/rls-wave1.test.mjs — same DENY/ALLOW proof as Wave 0's
// rls.test.mjs, applied to Wave 1's master-data tables (tables,
// menu_categories, menu_items, combo_items). Reuses every lesson Wave 0's
// live verification found the hard way: NULLIF-guarded platform context,
// SQLSTATE-code assertions (not locale-dependent message text), no chained
// queries inside a transaction after a caught error.
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

async function main() {
  const avail = await dbAvailable();
  if (avail !== true) return await skipUnavailable("rls-wave1.test.mjs (Wave 1 master data)", avail.error);

  const pool = getPool();
  const setup = await pool.connect();
  const app = await pool.connect();
  let restA, restB, tableA, catA, itemA, itemB, comboA;

  try {
    await app.query("SET ROLE nesta_app");

    console.log("Creating test fixtures...");
    const ra = await setup.query("INSERT INTO restaurants (domain, name) VALUES ($1,$2) RETURNING id", [`rls1-a-${Date.now()}.nestacrm.uz`, "Wave1 Test A"]);
    restA = ra.rows[0].id;
    const rb = await setup.query("INSERT INTO restaurants (domain, name) VALUES ($1,$2) RETURNING id", [`rls1-b-${Date.now()}.nestacrm.uz`, "Wave1 Test B"]);
    restB = rb.rows[0].id;

    const t1 = await setup.query("INSERT INTO tables (restaurant_id, number) VALUES ($1,1) RETURNING id", [restA]);
    tableA = t1.rows[0].id;
    await setup.query("INSERT INTO tables (restaurant_id, number) VALUES ($1,1)", [restB]);

    const c1 = await setup.query("INSERT INTO menu_categories (restaurant_id, name) VALUES ($1,$2) RETURNING id", [restA, JSON.stringify({ uz: "Taomlar" })]);
    catA = c1.rows[0].id;

    const m1 = await setup.query("INSERT INTO menu_items (restaurant_id, category_id, name, price) VALUES ($1,$2,$3,$4) RETURNING id", [restA, catA, JSON.stringify({ uz: "Lag'mon" }), 35000]);
    itemA = m1.rows[0].id;
    const m2 = await setup.query("INSERT INTO menu_items (restaurant_id, name, price) VALUES ($1,$2,$3) RETURNING id", [restA, JSON.stringify({ uz: "Salat" }), 15000]);
    const componentA = m2.rows[0].id;
    const mb = await setup.query("INSERT INTO menu_items (restaurant_id, name, price) VALUES ($1,$2,$3) RETURNING id", [restB, JSON.stringify({ uz: "Other" }), 10000]);
    itemB = mb.rows[0].id;

    const combo = await setup.query("INSERT INTO menu_items (restaurant_id, name, price, is_combo) VALUES ($1,$2,$3,true) RETURNING id", [restA, JSON.stringify({ uz: "Combo" }), 45000]);
    comboA = combo.rows[0].id;
    await setup.query("INSERT INTO combo_items (combo_menu_item_id, component_menu_item_id, qty) VALUES ($1,$2,1)", [comboA, componentA]);

    console.log(`Fixtures ready: A=${restA} B=${restB}\n`);

    console.log("1. tables — tenant isolation");
    await asTenant(app, restA, "owner", async () => {
      const { rows } = await app.query("SELECT id FROM tables");
      if (rows.length === 1 && rows[0].id === tableA) ok("Restaurant A sees only its own table");
      else bad("Restaurant A tables SELECT", `got ${rows.length} rows`);
    });
    await asTenant(app, restA, "owner", async () => {
      try {
        await app.query("UPDATE tables SET status = 'busy' WHERE restaurant_id = $1", [restB]);
        const { rowCount } = await app.query("SELECT 1 FROM tables WHERE restaurant_id = $1", [restB]);
        if (rowCount === 0) ok("Restaurant A cannot see/update Restaurant B's tables");
        else bad("Restaurant A cross-tenant tables UPDATE", "B's table visible");
      } catch (err) { bad("Restaurant A cross-tenant tables UPDATE", `[${err.code}] ${err.message}`); }
    });

    console.log("\n2. menu_categories / menu_items — tenant isolation + INSERT deny");
    await asTenant(app, restA, "owner", async () => {
      try {
        await app.query("INSERT INTO menu_items (restaurant_id, name, price) VALUES ($1,$2,$3)", [restB, JSON.stringify({ uz: "Forged" }), 1000]);
        bad("Restaurant A INSERT menu_item into Restaurant B", "expected WITH CHECK violation");
      } catch (err) {
        if (err.code === "42501") ok("Restaurant A cannot INSERT a menu_item into Restaurant B");
        else bad("Restaurant A INSERT menu_item into Restaurant B", `wrong error [${err.code}]`);
      }
    });
    await asTenant(app, restB, "owner", async () => {
      const { rows } = await app.query("SELECT id FROM menu_items WHERE id = $1", [itemA]);
      if (rows.length === 0) ok("Restaurant B cannot SELECT Restaurant A's menu_item");
      else bad("Restaurant B cross-tenant menu_item SELECT", "unexpectedly visible");
    });

    console.log("\n3. combo_items — subquery-based RLS (no restaurant_id column of its own)");
    await asTenant(app, restA, "owner", async () => {
      const { rows } = await app.query("SELECT * FROM combo_items WHERE combo_menu_item_id = $1", [comboA]);
      if (rows.length === 1) ok("Restaurant A sees its own combo_items row");
      else bad("Restaurant A combo_items SELECT", `got ${rows.length} rows`);
    });
    await asTenant(app, restB, "owner", async () => {
      const { rows } = await app.query("SELECT * FROM combo_items WHERE combo_menu_item_id = $1", [comboA]);
      if (rows.length === 0) ok("Restaurant B cannot see Restaurant A's combo_items row");
      else bad("Restaurant B combo_items SELECT", "unexpectedly visible");
    });

    console.log("\n4. Platform context sees everything");
    await asTenant(app, "", "", async () => {
      const { rows } = await app.query("SELECT id FROM menu_items WHERE id = ANY($1)", [[itemA, itemB]]);
      if (rows.length === 2) ok("Platform context sees menu_items from both restaurants");
      else bad("Platform context menu_items SELECT", `expected 2, got ${rows.length}`);
    });

    console.log("\n5. Forged / malformed context fails closed");
    await asTenant(app, "not-a-uuid", "owner", async () => {
      try {
        await app.query("SELECT id FROM tables");
        bad("Malformed context on tables", "expected a cast error");
      } catch (err) {
        if (err.code === "22P02") ok("Malformed restaurant_id context on tables fails closed");
        else bad("Malformed context on tables", `wrong error [${err.code}]`);
      }
    });

  } finally {
    console.log("\nCleaning up fixtures...");
    if (restA) await setup.query("DELETE FROM restaurants WHERE id = $1", [restA]).catch((e) => console.warn("cleanup A failed:", e.message));
    if (restB) await setup.query("DELETE FROM restaurants WHERE id = $1", [restB]).catch((e) => console.warn("cleanup B failed:", e.message));
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
