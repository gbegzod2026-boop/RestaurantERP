import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";
import { getPool, closePool } from "../postgres.js";
import { authorizeSocketJoin } from "../../pg/rbacPg.js";
import {
  authorizeLegacyPrivilegedEmit,
  rememberLegacyStaff,
  joinOperationalRooms,
  leaveOperationalRooms,
  staffRoomsForConnect,
  collectOperationalRooms,
  CHEF_CONNECT_ROLES,
  ADMIN_CONNECT_ROLES,
} from "../../pg/legacySocketPolicy.js";

const suffix = Date.now();
const REST_A = `rest_${suffix}`;
const REST_B = `rest_${suffix + 1}`;

function mockSocket() {
  const rooms = new Set(["sid"]);
  return {
    id: "sid",
    rooms,
    join(room) { rooms.add(room); },
    leave(room) { rooms.delete(room); },
    emit() {},
  };
}

const available = await dbAvailable();
if (available !== true) {
  await skipUnavailable("legacy-privileged-emit-pg.test.mjs", available.error);
} else {
  test("privileged legacy emits revalidate live PostgreSQL authority and per-event permissions", async () => {
    const previousBackend = process.env.DATA_BACKEND;
    process.env.DATA_BACKEND = "postgres";
    const pool = getPool();
    const setup = await pool.connect();
    let restA;
    let restB;
    try {
      restA = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
        [`emit-a-${suffix}.local`, "Emit A", REST_A]
      )).rows[0].id;
      restB = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
        [`emit-b-${suffix}.local`, "Emit B", REST_B]
      )).rows[0].id;
      await setup.query(
        `INSERT INTO employees
          (restaurant_id, name, login, role, legacy_rtdb_id, active, extra)
         VALUES
          ($1, 'Chef Main', 'chef_main_${suffix}', 'chef', 'chef_main', true, '{}'::jsonb),
          ($1, 'Chef Del', 'chef_del_${suffix}', 'chef', 'chef_del', true, '{}'::jsonb),
          ($1, 'Chef Blk', 'chef_blk_${suffix}', 'chef', 'chef_blk', true, '{}'::jsonb),
          ($1, 'Chef Off', 'chef_off_${suffix}', 'chef', 'chef_off', true, '{}'::jsonb),
          ($2, 'Chef B', 'chef_b_${suffix}', 'chef', 'chef_b', true, '{}'::jsonb)`,
        [restA, restB]
      );

      let currentUserId = "chef_main";
      let currentRest = REST_A;
      let calls = 0;
      const authorize = async ({ token, restId, userId }) => {
        calls += 1;
        return authorizeSocketJoin({
          token,
          restId,
          userId,
          resolveIdentityFn: async () => ({
            verified: true,
            restId: currentRest,
            userId: currentUserId,
            isCustomer: false,
          }),
        });
      };

      const attach = (socket, userId, restId, kind = "chef") => {
        rememberLegacyStaff(socket, {
          token: "mocked-verified-token",
          restId,
          userId,
          kind,
          allowedRoles: kind === "chef" ? CHEF_CONNECT_ROLES : ADMIN_CONNECT_ROLES,
        });
        joinOperationalRooms(socket, staffRoomsForConnect(restId, kind));
      };

      const chefSocket = mockSocket();
      attach(chefSocket, "chef_main", REST_A);
      chefSocket.legacyStaffCheckedAt = Date.now();

      const statusOk = await authorizeLegacyPrivilegedEmit(chefSocket, "chef-status-update", authorize);
      assert.equal(statusOk.ok, true, statusOk.code);
      const menuDenied = await authorizeLegacyPrivilegedEmit(chefSocket, "menu-updated", authorize);
      assert.equal(menuDenied.ok, false);
      assert.equal(menuDenied.code, "role_denied");
      const payDenied = await authorizeLegacyPrivilegedEmit(chefSocket, "payment-approved", authorize);
      assert.equal(payDenied.ok, false);
      assert.equal(chefSocket.legacyStaffVerified, true);
      assert.ok(collectOperationalRooms(chefSocket).includes(`chefs:${REST_A}`));

      const callsAfterPerms = calls;
      const again = await authorizeLegacyPrivilegedEmit(chefSocket, "chef-status-update", authorize);
      assert.equal(again.ok, true);
      assert.equal(calls, callsAfterPerms + 1, "no 5s write-authority window");

      await setup.query(
        `INSERT INTO custom_roles (restaurant_id, name, modules, actions, legacy_rtdb_id)
         VALUES ($1, 'chef', '["notifications"]'::jsonb, '["view"]'::jsonb, 'chef_limited')`,
        [restA]
      );
      const revokedModule = await authorizeLegacyPrivilegedEmit(chefSocket, "chef-status-update", authorize);
      assert.equal(revokedModule.ok, false);
      assert.equal(revokedModule.code, "role_denied");
      assert.equal(chefSocket.legacyStaffVerified, true, "identity remains; only the event is denied");
      await setup.query(`DELETE FROM custom_roles WHERE restaurant_id = $1`, [restA]);

      await setup.query(
        `UPDATE employees SET role = 'finance' WHERE restaurant_id = $1 AND legacy_rtdb_id = 'chef_main'`,
        [restA]
      );
      const roleChanged = await authorizeLegacyPrivilegedEmit(chefSocket, "chef-status-update", authorize);
      assert.equal(roleChanged.ok, false);
      assert.equal(chefSocket.legacyStaffVerified, false);

      currentUserId = "chef_del";
      const delSocket = mockSocket();
      attach(delSocket, "chef_del", REST_A);
      delSocket.legacyStaffCheckedAt = Date.now();
      assert.equal((await authorizeLegacyPrivilegedEmit(delSocket, "new-order", authorize)).ok, true);
      await setup.query(
        `DELETE FROM employees WHERE restaurant_id = $1 AND legacy_rtdb_id = 'chef_del'`,
        [restA]
      );
      const deletedNow = await authorizeLegacyPrivilegedEmit(delSocket, "new-order", authorize);
      assert.equal(deletedNow.ok, false);
      assert.equal(delSocket.legacyStaffVerified, false);
      assert.equal(collectOperationalRooms(delSocket).length, 0);

      currentUserId = "chef_blk";
      const blkSocket = mockSocket();
      attach(blkSocket, "chef_blk", REST_A);
      blkSocket.legacyStaffCheckedAt = Date.now();
      assert.equal((await authorizeLegacyPrivilegedEmit(blkSocket, "chef-status-update", authorize)).ok, true);
      await setup.query(
        `UPDATE employees SET extra = '{"blocked":true}'::jsonb
          WHERE restaurant_id = $1 AND legacy_rtdb_id = 'chef_blk'`,
        [restA]
      );
      const blockedNow = await authorizeLegacyPrivilegedEmit(blkSocket, "chef-status-update", authorize);
      assert.equal(blockedNow.ok, false);
      assert.equal(blkSocket.legacyStaffVerified, false);

      currentUserId = "chef_off";
      const offSocket = mockSocket();
      attach(offSocket, "chef_off", REST_A);
      offSocket.legacyStaffCheckedAt = Date.now();
      assert.equal((await authorizeLegacyPrivilegedEmit(offSocket, "chef-status-update", authorize)).ok, true);
      await setup.query(
        `UPDATE employees SET active = false
          WHERE restaurant_id = $1 AND legacy_rtdb_id = 'chef_off'`,
        [restA]
      );
      const inactiveNow = await authorizeLegacyPrivilegedEmit(offSocket, "chef-status-update", authorize);
      assert.equal(inactiveNow.ok, false);
      assert.equal(offSocket.legacyStaffVerified, false);

      currentUserId = "chef_b";
      currentRest = REST_B;
      const tenantSocket = mockSocket();
      attach(tenantSocket, "chef_b", REST_B);
      const onB = await authorizeLegacyPrivilegedEmit(tenantSocket, "chef-status-update", authorize);
      assert.equal(onB.ok, true);
      assert.equal(onB.restId, REST_B);
      tenantSocket.restId = REST_A;
      const oldTenant = await authorizeLegacyPrivilegedEmit(tenantSocket, "chef-status-update", authorize);
      assert.equal(oldTenant.ok, false);

      const failSocket = mockSocket();
      currentUserId = "chef_b";
      currentRest = REST_B;
      attach(failSocket, "chef_b", REST_B);
      const failed = await authorizeLegacyPrivilegedEmit(failSocket, "chef-status-update", async () => {
        throw new Error("refresh failed");
      });
      assert.equal(failed.ok, false);
      assert.equal(failSocket.legacyStaffVerified, false);
    } finally {
      if (restA) await setup.query("DELETE FROM restaurants WHERE id = $1", [restA]).catch(() => {});
      if (restB) await setup.query("DELETE FROM restaurants WHERE id = $1", [restB]).catch(() => {});
      setup.release();
      if (previousBackend === undefined) delete process.env.DATA_BACKEND;
      else process.env.DATA_BACKEND = previousBackend;
      await closePool();
    }
  });
}
