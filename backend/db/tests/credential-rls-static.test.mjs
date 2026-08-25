import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../migrations/0012_employee_credentials_actor_rls.up.sql", import.meta.url);
const rollbackUrl = new URL("../migrations/0012_employee_credentials_actor_rls.down.sql", import.meta.url);

test("0012 credential mutation policies bind actor role and tenant", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    assert.match(sql, new RegExp(`CREATE POLICY employee_credentials_${operation.toLowerCase()}[\\s\\S]*?FOR ${operation}`));
  }
  assert.match(sql, /app\.current_employee_role[\s\S]*?'owner'[\s\S]*?'admin'/);
  assert.match(sql, /restaurant_id\s*=\s*NULLIF\(current_setting\('app\.current_restaurant_id'/);
  assert.match(sql, /ALTER TABLE employee_credentials FORCE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /BYPASSRLS|DISABLE ROW LEVEL SECURITY|GRANT\s+ALL/i);
  assert.doesNotMatch(sql, /current_restaurant_id'\s*,\s*true\)\s*=\s*''/);
});

test("0012 rollback restores only the prior credential mutation boundary", async () => {
  const sql = await readFile(rollbackUrl, "utf8");
  assert.match(sql, /CREATE POLICY employee_credentials_insert[\s\S]*?FOR INSERT/);
  assert.match(sql, /CREATE POLICY employee_credentials_update[\s\S]*?FOR UPDATE/);
  assert.match(sql, /current_restaurant_id', true\) = ''/);
  assert.match(sql, /role IN \('owner', 'admin'\)/);
  assert.match(sql, /DROP POLICY IF EXISTS employee_credentials_delete/);
  assert.match(sql, /REVOKE DELETE ON employee_credentials FROM nesta_app/);
  assert.doesNotMatch(sql, /CREATE POLICY employee_credentials_delete/);
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|INDEX)|DELETE\s+FROM|TRUNCATE|BYPASSRLS|DISABLE ROW LEVEL SECURITY|GRANT\s+ALL/i);

  const touchedPolicyNames = [...sql.matchAll(/(?:DROP|CREATE) POLICY(?: IF EXISTS)?\s+([a-z0-9_]+)/gi)].map((match) => match[1]);
  assert.deepEqual(
    new Set(touchedPolicyNames),
    new Set(["employee_credentials_insert", "employee_credentials_update", "employee_credentials_delete"])
  );
});
