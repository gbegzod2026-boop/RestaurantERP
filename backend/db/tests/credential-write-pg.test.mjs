import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";
import { getPool, closePool, withTenantContext } from "../postgres.js";
import { upsertEmployeeCredential } from "../../pg/credentialService.js";

const available = await dbAvailable();
if (available !== true) {
  await skipUnavailable("credential-write-pg.test.mjs", available.error);
} else {
  test("least-privileged tenant actor can insert and rotate a credential without hash SELECT", async () => {
    const pool = getPool();
    const setup = await pool.connect();
    let restaurantId;
    try {
      restaurantId = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id)
         VALUES ($1, 'Credential write test', $2) RETURNING id`,
        [`credential-${Date.now()}.local`, `rest_${Date.now()}`]
      )).rows[0].id;
      const employeeId = (await setup.query(
        `INSERT INTO employees
          (restaurant_id, legacy_rtdb_id, name, login, role, active)
         VALUES ($1, 'waiter_1', 'Waiter', $2, 'waiter', true) RETURNING id`,
        [restaurantId, `credential_waiter_${Date.now()}`]
      )).rows[0].id;

      await withTenantContext(restaurantId, (client) =>
        upsertEmployeeCredential(client, { employeeId, pin: "4826" }), { actingRole: "admin" });
      await withTenantContext(restaurantId, (client) =>
        upsertEmployeeCredential(client, { employeeId, pin: "7315" }), { actingRole: "admin" });

      const { rows } = await setup.query(
        `SELECT password_hash, password_enc FROM employee_credentials WHERE employee_id = $1`,
        [employeeId]
      );
      assert.match(rows[0].password_hash, /^\$2[aby]\$/);
      assert.notEqual(rows[0].password_hash, "7315");
      assert.equal(rows[0].password_enc, null);
    } finally {
      if (restaurantId) await setup.query("DELETE FROM restaurants WHERE id = $1", [restaurantId]).catch(() => {});
      setup.release();
      await closePool();
    }
  });
}
