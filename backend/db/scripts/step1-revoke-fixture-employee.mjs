#!/usr/bin/env node
import { closePool, withPlatformContext, withTenantContext } from "../postgres.js";

const REST = "rest_1999000000001";
const op = String(process.argv[2] || "");

const restaurant = await withPlatformContext(async (client) => {
  const { rows } = await client.query(
    "SELECT id FROM restaurants WHERE legacy_rtdb_id = $1 LIMIT 1",
    [REST]
  );
  return rows[0] || null;
});
if (!restaurant) {
  process.stderr.write("fixture restaurant missing\n");
  process.exit(1);
}

await withTenantContext(restaurant.id, async (client) => {
  if (op === "block") {
    await client.query(
      `UPDATE employees
          SET active = false,
              extra = extra || '{"blocked":true,"blockedReason":"step1-revoke"}'::jsonb
        WHERE legacy_rtdb_id = 'admin_1'`
    );
  } else if (op === "revoke-menu") {
    await client.query(
      `UPDATE employees
          SET modules = (
            SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
              FROM jsonb_array_elements_text(modules) AS value
             WHERE value <> 'menu'
          )
        WHERE legacy_rtdb_id = 'admin_1'`
    );
  } else if (op === "grant-waiter-menu-edit") {
    await client.query(
      `UPDATE role_overrides
          SET modules = '["menu","tables","orders"]'::jsonb,
              actions = '["view","edit"]'::jsonb
        WHERE base_role = 'waiter'`
    );
  } else if (op === "revoke-waiter-menu") {
    await client.query(
      `UPDATE role_overrides
          SET modules = '["tables","orders"]'::jsonb,
              actions = '["view"]'::jsonb
        WHERE base_role = 'waiter'`
    );
  } else {
    process.stderr.write("usage: block | revoke-menu | grant-waiter-menu-edit | revoke-waiter-menu\n");
    process.exit(1);
  }
  const { rows } = await client.query(
    `SELECT legacy_rtdb_id, active, role, modules, actions, extra
       FROM employees WHERE legacy_rtdb_id IN ('admin_1','waiter_1')
       ORDER BY legacy_rtdb_id`
  );
  process.stdout.write(`${JSON.stringify(rows)}\n`);
}, { actingRole: "admin" });

await closePool();
