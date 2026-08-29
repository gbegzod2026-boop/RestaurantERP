import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";
import { getPool, closePool } from "../postgres.js";

const TENANT_CATALOG_SQL = `
  SELECT c.relname AS table_name,
         c.relrowsecurity,
         c.relforcerowsecurity,
         EXISTS (
           SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid
              AND a.attname = 'restaurant_id'
              AND NOT a.attisdropped
              AND a.attnum > 0
         ) AS has_restaurant_id
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
`;

const available = await dbAvailable();
if (available !== true) {
  await skipUnavailable("rls-catalog-count.test.mjs", available.error);
} else {
  test("every current tenant table has RLS and FORCE RLS; catalog counts are classified", async () => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const { rows } = await client.query(TENANT_CATALOG_SQL);
      const withRestaurantId = rows.filter((r) => r.has_restaurant_id);
      const extras = rows.filter((r) => !r.has_restaurant_id);
      const missingRls = rows.filter((r) => r.relrowsecurity !== true).map((r) => r.table_name);
      const missingForce = rows.filter((r) => r.relforcerowsecurity !== true).map((r) => r.table_name);
      assert.equal(missingRls.length, 0, `RLS missing: ${missingRls.join(", ")}`);
      assert.equal(missingForce.length, 0, `FORCE RLS missing: ${missingForce.join(", ")}`);
      assert.equal(withRestaurantId.filter((r) => r.relrowsecurity && r.relforcerowsecurity).length, withRestaurantId.length);
      assert.ok(rows.length >= withRestaurantId.length);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        currentTenantTableCount: rows.length,
        restaurantIdTables: withRestaurantId.length,
        extrasWithoutRestaurantId: extras.map((r) => r.table_name),
        rlsCount: rows.filter((r) => r.relrowsecurity).length,
        forceRlsCount: rows.filter((r) => r.relforcerowsecurity).length,
      }));
    } finally {
      client.release();
      await closePool();
    }
  });
}
