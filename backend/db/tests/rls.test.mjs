#!/usr/bin/env node
// db/tests/rls.test.mjs — proves Wave 0's tenant isolation live: Restaurant
// A can see/change only its own data, Restaurant B only its own, a forged
// or wrong restaurant context is denied, platform context sees everything,
// and the role-escalation trigger rejects a non-owner/admin role change.
//
// CODE VERIFIED, not LIVE VERIFIED — no PostgreSQL instance was available
// in this environment to actually run this. Run it yourself once Wave 0's
// migration has been applied to a real instance:
//   node db/migrate.js up
//   node db/tests/rls.test.mjs
//
// Runs every check as the nesta_app role (via SET ROLE, not a separate
// password-authenticated connection — see 0001_wave0_core.up.sql's
// `GRANT nesta_app TO CURRENT_USER`), because the connecting POSTGRES_USER
// is commonly a superuser/table-owner that would otherwise bypass RLS
// entirely and make every test here meaningless.
//
// All test data is created and torn down inside this run — nothing is left
// behind, and nothing here touches Firebase.
import { getPool, closePool } from "../postgres.js";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";

let pass = 0;
let fail = 0;

function ok(label) { pass++; console.log(`  ✅ ${label}`); }
function bad(label, detail) { fail++; console.log(`  ❌ ${label}${detail ? " — " + detail : ""}`); }

/** Runs `fn(client)` inside its own transaction with the given tenant
 *  context (or '' for platform), always rolling back — test queries never
 *  persist beyond their own check. */
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
  if (avail !== true) return await skipUnavailable("rls.test.mjs (Wave 0)", avail.error);

  const pool = getPool();
  const setup = await pool.connect(); // stays as the migrator/admin role — used only to create/tear down fixtures
  const app = await pool.connect();   // impersonates nesta_app for every actual RLS-governed check

  let restA, restB, empA, empB;

  try {
    await app.query("SET ROLE nesta_app");

    // ── Fixtures (created as the admin/migrator role, bypasses RLS by design — this is setup, not a test) ──
    console.log("Creating test fixtures...");
    const ra = await setup.query(
      "INSERT INTO restaurants (domain, name) VALUES ($1, $2) RETURNING id",
      [`rls-test-a-${Date.now()}.nestacrm.uz`, "RLS Test Restaurant A"]
    );
    restA = ra.rows[0].id;
    const rb = await setup.query(
      "INSERT INTO restaurants (domain, name) VALUES ($1, $2) RETURNING id",
      [`rls-test-b-${Date.now()}.nestacrm.uz`, "RLS Test Restaurant B"]
    );
    restB = rb.rows[0].id;

    const ea = await setup.query(
      "INSERT INTO employees (restaurant_id, name, login, role) VALUES ($1, $2, $3, $4) RETURNING id",
      [restA, "Owner A", "owner_a", "owner"]
    );
    empA = ea.rows[0].id;
    const eb = await setup.query(
      "INSERT INTO employees (restaurant_id, name, login, role) VALUES ($1, $2, $3, $4) RETURNING id",
      [restB, "Owner B", "owner_b", "owner"]
    );
    empB = eb.rows[0].id;

    const ea2 = await setup.query(
      "INSERT INTO employees (restaurant_id, name, login, role) VALUES ($1, $2, $3, $4) RETURNING id",
      [restA, "Chef A", "chef_a", "chef"]
    );
    const chefA = ea2.rows[0].id;

    console.log(`Fixtures ready: restaurant A=${restA}, B=${restB}\n`);

    // ── 1. Restaurant A sees only its own employees ──
    console.log("1. Tenant isolation — SELECT");
    await asTenant(app, restA, "owner", async () => {
      const { rows } = await app.query("SELECT id FROM employees ORDER BY id");
      const ids = rows.map((r) => r.id);
      if (ids.includes(empA) && !ids.includes(empB)) ok("Restaurant A SELECT: sees its own employees, not B's");
      else bad("Restaurant A SELECT", `got ${JSON.stringify(ids)}`);
    });
    await asTenant(app, restB, "owner", async () => {
      const { rows } = await app.query("SELECT id FROM employees ORDER BY id");
      const ids = rows.map((r) => r.id);
      if (ids.includes(empB) && !ids.includes(empA)) ok("Restaurant B SELECT: sees its own employees, not A's");
      else bad("Restaurant B SELECT", `got ${JSON.stringify(ids)}`);
    });

    // ── 2. Cross-tenant SELECT-by-id returns nothing, not someone else's row ──
    await asTenant(app, restA, "owner", async () => {
      const { rows } = await app.query("SELECT id FROM employees WHERE id = $1", [empB]);
      if (rows.length === 0) ok("Restaurant A cannot SELECT Restaurant B's employee by id (0 rows, not an error)");
      else bad("Restaurant A cross-tenant SELECT by id", `expected 0 rows, got ${rows.length}`);
    });

    // ── 3. Cross-tenant INSERT is rejected ──
    console.log("\n2. Tenant isolation — INSERT/UPDATE/DELETE");
    await asTenant(app, restA, "owner", async () => {
      try {
        await app.query("INSERT INTO employees (restaurant_id, name, login, role) VALUES ($1, $2, $3, $4)", [restB, "Forged", "forged_login", "waiter"]);
        bad("Restaurant A INSERT into Restaurant B", "expected a WITH CHECK violation, insert succeeded instead");
      } catch (err) {
        // Matched on SQLSTATE, not message text — Postgres translates its
        // own error messages per the server's lc_messages locale (this one
        // came back in Russian during Wave 0 verification), so English
        // regex matching against err.message is not portable across
        // servers. 42501 = insufficient_privilege, the code Postgres uses
        // for both RLS policy violations and column/table permission
        // denials (also used in the credential-column check below).
        if (err.code === "42501") ok("Restaurant A cannot INSERT an employee into Restaurant B (RLS WITH CHECK denied)");
        else bad("Restaurant A INSERT into Restaurant B", `wrong error [${err.code}]: ${err.message}`);
      }
    });

    // ── 4. Cross-tenant UPDATE affects zero rows ──
    await asTenant(app, restA, "owner", async () => {
      const { rowCount } = await app.query("UPDATE employees SET name = 'hacked' WHERE id = $1", [empB]);
      if (rowCount === 0) ok("Restaurant A UPDATE targeting Restaurant B's employee affects 0 rows");
      else bad("Restaurant A UPDATE into Restaurant B", `expected 0 rows affected, got ${rowCount}`);
    });

    // ── 5. Cross-tenant DELETE affects zero rows ──
    await asTenant(app, restA, "owner", async () => {
      const { rowCount } = await app.query("DELETE FROM employees WHERE id = $1", [empB]);
      if (rowCount === 0) ok("Restaurant A DELETE targeting Restaurant B's employee affects 0 rows");
      else bad("Restaurant A DELETE into Restaurant B", `expected 0 rows affected, got ${rowCount}`);
    });

    // ── 6. Forged / invalid restaurant context ──
    console.log("\n3. Forged restaurant context");
    await asTenant(app, "not-a-real-uuid", "owner", async () => {
      try {
        await app.query("SELECT id FROM employees");
        bad("Malformed restaurant_id context", "expected a cast error, query succeeded instead");
      } catch (err) {
        // 22P02 = invalid_text_representation (locale-independent SQLSTATE
        // for a bad uuid cast — see the note on the INSERT test above).
        if (err.code === "22P02") ok("Malformed restaurant_id context fails closed (uuid cast error, no data returned)");
        else bad("Malformed restaurant_id context", `wrong error [${err.code}]: ${err.message}`);
      }
    });
    await asTenant(app, "00000000-0000-0000-0000-000000000000", "owner", async () => {
      const { rows } = await app.query("SELECT id FROM employees");
      if (rows.length === 0) ok("Well-formed but nonexistent restaurant_id context sees 0 rows");
      else bad("Nonexistent restaurant_id context", `expected 0 rows, got ${rows.length}`);
    });

    // ── 7. Platform context sees everything ──
    console.log("\n4. Platform-level context");
    await asTenant(app, "", "", async () => {
      const { rows } = await app.query("SELECT id FROM employees WHERE id = ANY($1)", [[empA, empB]]);
      if (rows.length === 2) ok("Platform context (empty restaurant_id) sees both Restaurant A and B's employees");
      else bad("Platform context SELECT", `expected 2 rows, got ${rows.length}`);
    });

    // ── 8. Role escalation ──
    console.log("\n5. Role-escalation prevention");
    await asTenant(app, restA, "chef", async () => {
      try {
        await app.query("UPDATE employees SET role = 'owner' WHERE id = $1", [chefA]);
        bad("Chef self-promotion to owner", "expected the trigger to reject this, update succeeded instead");
      } catch (err) {
        if (/role change denied/i.test(err.message)) ok("Chef cannot change its own role to owner (trigger rejects it)");
        else bad("Chef self-promotion to owner", `wrong error: ${err.message}`);
      }
    });
    await asTenant(app, restA, "owner", async () => {
      try {
        await app.query("UPDATE employees SET role = 'manager' WHERE id = $1", [chefA]);
        ok("Owner CAN change another employee's role within the same restaurant");
      } catch (err) {
        bad("Owner role change", `expected success, got: ${err.message}`);
      }
    });

    // ── 9. Column-level credential privilege boundary ──
    console.log("\n6. Credential column privileges");
    await setup.query("INSERT INTO employee_credentials (employee_id, password_hash) VALUES ($1, $2)", [empA, "not-a-real-bcrypt-hash-just-a-fixture"]);
    await asTenant(app, restA, "owner", async () => {
      try {
        await app.query("SELECT password_hash FROM employee_credentials WHERE employee_id = $1", [empA]);
        bad("nesta_app reading password_hash directly", "expected a column-privilege error, select succeeded instead");
      } catch (err) {
        if (err.code === "42501") ok("nesta_app (without SET ROLE nesta_login_reader) cannot SELECT password_hash directly");
        else bad("nesta_app reading password_hash directly", `wrong error [${err.code}]: ${err.message}`);
      }
    });
    // Wrapped in the same tenant context a real reveal endpoint would run
    // under (RLS is FORCEd on this table — a bare query with no context set
    // sees zero rows regardless of column grants, that's RLS doing its job,
    // not a column-privilege result).
    //
    // No nested try/catch-and-continue here on purpose: once a statement
    // inside a transaction errors, Postgres aborts the whole transaction —
    // any further command (including a "helpful" SET ROLE reset) just
    // raises 25P02 (current transaction is aborted) and masks the real
    // failure. Let asTenant's own ROLLBACK end the transaction and revert
    // SET ROLE back to nesta_app for us (SET ROLE, like other session
    // state, is undone on rollback the same as any other transactional
    // effect) — do not issue anything else in this transaction after the
    // one query being tested.
    try {
      await asTenant(app, restA, "owner", async () => {
        await app.query("SET ROLE nesta_login_reader");
        const { rows } = await app.query("SELECT password_hash FROM employee_credentials WHERE employee_id = $1", [empA]);
        if (!rows[0]?.password_hash) throw new Error("no row returned");
      });
      ok("nesta_login_reader CAN SELECT password_hash (the one intended reader)");
    } catch (err) {
      bad("nesta_login_reader reading password_hash", `[${err.code || "n/a"}] ${err.message}`);
    }

  } finally {
    // ── Teardown — always runs, even if a test threw unexpectedly ──
    console.log("\nCleaning up fixtures...");
    await app.query("RESET ROLE").catch(() => {});
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
