import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "../../security/password.js";
import {
  CredentialConflictError,
  assertPinAvailable,
  authenticateStaffWithPostgres,
  upsertEmployeeCredential,
} from "../../pg/credentialService.js";

test("credential upsert stores only a bcrypt hash", async () => {
  const calls = [];
  const client = { query: async (...args) => { calls.push(args); return { rows: [], rowCount: 0 }; } };
  await upsertEmployeeCredential(client, { employeeId: "employee-id", pin: "2468" });
  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /^UPDATE employee_credentials/);
  assert.match(calls[1][0], /^INSERT INTO employee_credentials/);
  assert.ok(calls.every(([sql]) => !/ON CONFLICT/i.test(sql)));
  assert.ok(calls.every(([, params]) => params[1] !== "2468" && /^\$2[aby]\$/.test(params[1])));
});

test("PIN uniqueness check uses login-reader privilege and restores nesta_app", async () => {
  const hash = await hashPassword("2468");
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (/SELECT employee_id/.test(sql)) return { rows: [{ employee_id: "employee-id", password_hash: hash }] };
      return { rows: [] };
    },
  };
  await assert.rejects(
    assertPinAvailable(client, { pin: "2468" }),
    (error) => error instanceof CredentialConflictError
  );
  assert.equal(calls[0], "SET LOCAL ROLE nesta_login_reader");
  assert.equal(calls.at(-1), "SET LOCAL ROLE nesta_app");
});

test("PostgreSQL staff login is tenant-scoped and never calls RTDB", async () => {
  const hash = await hashPassword("2468");
  const calls = [];
  let queryIndex = 0;
  const results = [
    { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
    { rows: [{ id: "tenant-uuid", status: "active" }] },
    { rows: [] },
    { rows: [{ id: "employee-uuid", legacy_rtdb_id: "waiter_1", name: "Waiter", role: "waiter", active: true, extra: {} }] },
    { rows: [] },
    { rows: [{ employee_id: "employee-uuid", password_hash: hash }] },
    { rows: [] }, { rows: [] },
  ];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return results[queryIndex++] || { rows: [] };
    },
    release() {},
  };
  const employee = await authenticateStaffWithPostgres("rest_1", "2468", {
    pool: { connect: async () => client },
  });
  assert.equal(employee?.legacy_rtdb_id, "waiter_1");
  assert.ok(calls.some(({ sql, params }) => /current_restaurant_id/.test(sql) && params?.[0] === "tenant-uuid"));
  assert.ok(calls.some(({ sql }) => sql === "SET LOCAL ROLE nesta_login_reader"));
  assert.ok(calls.every(({ sql }) => !/firebase|restaurants\//i.test(sql)));
});
