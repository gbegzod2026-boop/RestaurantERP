import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";
import { getPool, closePool } from "../postgres.js";
import { authorizeSocketJoin } from "../../pg/rbacPg.js";

const REST = `rest_${Date.now()}`;

const available = await dbAvailable();
if (available !== true) {
  await skipUnavailable("socket-authority-pg.test.mjs", available.error);
} else {
  test("socket authority is revalidated against current PostgreSQL employee state", async () => {
    const pool = getPool();
    const setup = await pool.connect();
    let restaurantId;
    try {
      restaurantId = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [`socket-authority-${Date.now()}.local`, "Socket authority", REST]
      )).rows[0].id;
      await setup.query(
        `INSERT INTO employees
          (restaurant_id, name, login, role, legacy_rtdb_id, active, extra)
         VALUES
          ($1, 'Current', 'socket_current', 'waiter', 'current', true, '{}'::jsonb),
          ($1, 'Inactive', 'socket_inactive', 'waiter', 'inactive', false, '{}'::jsonb),
          ($1, 'Blocked', 'socket_blocked', 'waiter', 'blocked', true, '{"blocked":true}'::jsonb),
          ($1, 'Revoked', 'socket_revoked', 'waiter', 'revoked', true, '{"revoked":true}'::jsonb),
          ($1, 'Deleted', 'socket_deleted', 'waiter', 'deleted', true, '{}'::jsonb)`,
        [restaurantId]
      );
      await setup.query(
        `DELETE FROM employees WHERE restaurant_id = $1 AND legacy_rtdb_id = 'deleted'`,
        [restaurantId]
      );

      const authorize = (userId, tokenRole = "admin") => authorizeSocketJoin({
        token: "mocked-verified-token",
        restId: REST,
        resolveIdentityFn: async () => ({
          verified: true,
          restId: REST,
          userId,
          role: tokenRole,
        }),
      });

      const current = await authorize("current");
      assert.equal(current.role, "waiter");
      assert.notEqual(current.role, "admin", "token role must not be used");
      for (const userId of ["inactive", "blocked", "revoked", "deleted"]) {
        assert.equal(await authorize(userId), null, userId);
      }

      await setup.query(
        `UPDATE employees SET role = 'chef'
          WHERE restaurant_id = $1 AND legacy_rtdb_id = 'current'`,
        [restaurantId]
      );
      const changed = await authorize("current", "waiter");
      assert.equal(changed.role, "chef");
    } finally {
      if (restaurantId) {
        await setup.query("DELETE FROM restaurants WHERE id = $1", [restaurantId]).catch(() => {});
      }
      setup.release();
      await closePool();
    }
  });
}
