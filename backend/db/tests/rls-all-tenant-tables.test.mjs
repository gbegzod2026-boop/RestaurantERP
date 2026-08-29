import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";
import { getPool, closePool, withTenantContext } from "../postgres.js";

const avail = await dbAvailable();
if (avail !== true) {
  await skipUnavailable("rls-all-tenant-tables.test.mjs", avail.error);
} else {
  test("every tenant table has RLS and FORCE RLS enabled", async () => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const { rows } = await client.query(`
        SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND (
             c.relname = 'restaurants'
             OR EXISTS (
               SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid
                  AND a.attname = 'restaurant_id'
                  AND NOT a.attisdropped
                  AND a.attnum > 0
             )
             OR c.relname IN ('employee_credentials', 'payment_credentials', 'combo_items')
           )
         ORDER BY c.relname
      `);
      assert.ok(rows.length > 7, `expected full tenant catalog, got ${rows.length}`);
      const missingRls = rows.filter((r) => r.relrowsecurity !== true).map((r) => r.table_name);
      const missingForce = rows.filter((r) => r.relforcerowsecurity !== true).map((r) => r.table_name);
      assert.equal(missingRls.length, 0, `RLS missing: ${missingRls.join(", ")}`);
      assert.equal(missingForce.length, 0, `FORCE RLS missing: ${missingForce.join(", ")}`);
    } finally {
      client.release();
      await closePool();
    }
  });
}
