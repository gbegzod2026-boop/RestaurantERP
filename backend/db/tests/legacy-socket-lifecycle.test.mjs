import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeLegacyStaffConnect,
  authorizeLegacyOperational,
  authorizeLegacyEvent,
  authorizeLegacyPrivilegedEmit,
  leaveOperationalRooms,
  joinOperationalRooms,
  rememberLegacyStaff,
  revalidateLegacyStaffAuthority,
  staffRoomsForConnect,
  collectOperationalRooms,
  LEGACY_EVENT_PERMISSIONS,
  CHEF_CONNECT_ROLES,
  ADMIN_CONNECT_ROLES,
} from "../../pg/legacySocketPolicy.js";

const REST_A = "rest_1784740340104";
const REST_B = "rest_2000000000002";

function mockSocket() {
  const rooms = new Set(["sid"]);
  const left = [];
  return {
    id: "sid",
    rooms,
    join(room) { rooms.add(room); },
    leave(room) { rooms.delete(room); left.push(room); },
    left,
    emit() {},
  };
}

test("active staff join is limited to canonical rest plus current PG authority", () => {
  const identity = { verified: true, userId: "emp_1", restId: REST_A, isCustomer: false };
  const authz = { userId: "emp_1", role: "admin", restId: REST_A };
  const ok = authorizeLegacyStaffConnect({
    identity, authz, requestedRestId: REST_A, requestedUserId: "emp_1", allowedRoles: ADMIN_CONNECT_ROLES,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(staffRoomsForConnect(REST_A, "admin"), [`admins:${REST_A}`, `rest-${REST_A}`]);
});

test("deleted, blocked, inactive, or role-revoked staff cannot keep operational authority", async () => {
  const socket = mockSocket();
  rememberLegacyStaff(socket, {
    token: "t", restId: REST_A, userId: "emp_1", kind: "chef", allowedRoles: CHEF_CONNECT_ROLES,
    authz: { userId: "emp_1", role: "chef" },
  });
  joinOperationalRooms(socket, staffRoomsForConnect(REST_A, "chef"));
  const denied = await revalidateLegacyStaffAuthority(socket, async () => null, { force: true });
  assert.equal(denied.ok, false);
  assert.equal(socket.legacyStaffVerified, false);
  assert.equal(collectOperationalRooms(socket).length, 0);

  const roleRevoked = mockSocket();
  rememberLegacyStaff(roleRevoked, {
    token: "t", restId: REST_A, userId: "emp_1", kind: "chef", allowedRoles: CHEF_CONNECT_ROLES,
    authz: { userId: "emp_1", role: "chef" },
  });
  joinOperationalRooms(roleRevoked, staffRoomsForConnect(REST_A, "chef"));
  const waiter = await revalidateLegacyStaffAuthority(roleRevoked, async () => ({
    userId: "emp_1", role: "waiter", restId: REST_A,
  }), { force: true });
  assert.equal(waiter.ok, false);
  assert.equal(authorizeLegacyOperational({
    staffVerified: roleRevoked.legacyStaffVerified, restId: roleRevoked.restId, event: "chef-status-update",
  }).ok, false);
});

test("tenant A to B and UID change leave every rest/admins/chefs room", () => {
  const socket = mockSocket();
  joinOperationalRooms(socket, [`rest-${REST_A}`, `admins:${REST_A}`, `chefs:${REST_A}`]);
  const leftA = leaveOperationalRooms(socket);
  assert.ok(leftA.includes(`rest-${REST_A}`));
  assert.ok(leftA.includes(`admins:${REST_A}`));
  assert.ok(leftA.includes(`chefs:${REST_A}`));
  joinOperationalRooms(socket, staffRoomsForConnect(REST_B, "admin"));
  const remaining = collectOperationalRooms(socket);
  assert.equal(remaining.some((room) => String(room).includes(REST_A)), false);
  assert.ok(remaining.includes(`rest-${REST_B}`));
  assert.ok(remaining.includes(`admins:${REST_B}`));

  rememberLegacyStaff(socket, {
    token: "old", restId: REST_B, userId: "uid_a", kind: "admin", allowedRoles: ADMIN_CONNECT_ROLES,
    authz: { userId: "uid_a", role: "admin" },
  });
  leaveOperationalRooms(socket);
  rememberLegacyStaff(socket, {
    token: "new", restId: REST_B, userId: "uid_b", kind: "admin", allowedRoles: ADMIN_CONNECT_ROLES,
    authz: { userId: "uid_b", role: "admin" },
  });
  joinOperationalRooms(socket, staffRoomsForConnect(REST_B, "admin"));
  assert.equal(socket.legacyUserId, "uid_b");
  assert.equal(socket.legacyToken, "new");
});

test("failed refresh and forged event restId cannot keep old-tenant operations", async () => {
  const socket = mockSocket();
  rememberLegacyStaff(socket, {
    token: "t", restId: REST_A, userId: "emp_1", kind: "admin", allowedRoles: ADMIN_CONNECT_ROLES,
    authz: { userId: "emp_1", role: "admin" },
  });
  joinOperationalRooms(socket, staffRoomsForConnect(REST_A, "admin"));
  const failed = await revalidateLegacyStaffAuthority(socket, async () => {
    throw new Error("refresh failed");
  }, { force: true });
  assert.equal(failed.ok, false);
  assert.equal(socket.legacyStaffVerified, false);
  assert.equal(collectOperationalRooms(socket).length, 0);
  assert.equal(authorizeLegacyOperational({
    staffVerified: false, restId: REST_A, event: "menu-updated",
  }).ok, false);
  assert.equal(authorizeLegacyOperational({
    staffVerified: true, restId: REST_A, event: "menu-updated",
  }).ok, true);
  const op = authorizeLegacyOperational({
    staffVerified: true, restId: REST_A, event: "menu-updated",
  });
  assert.equal(op.restId, REST_A);
  assert.notEqual(op.restId, REST_B);
});

function chefPermissions() {
  return {
    role: "chef",
    modules: ["dashboard", "orders", "notifications"],
    actions: {
      dashboard: ["view", "edit"],
      orders: ["view", "edit"],
      notifications: ["view", "edit"],
    },
  };
}

function staffSocket(kind = "chef") {
  const socket = mockSocket();
  rememberLegacyStaff(socket, {
    token: "t", restId: REST_A, userId: "emp_1", kind,
    allowedRoles: kind === "chef" ? CHEF_CONNECT_ROLES : ADMIN_CONNECT_ROLES,
    authz: { userId: "emp_1", role: kind, permissions: chefPermissions() },
  });
  joinOperationalRooms(socket, staffRoomsForConnect(REST_A, kind));
  return socket;
}

test("positive TTL is used only when force is explicitly false", async () => {
  const socket = staffSocket();
  let calls = 0;
  const joinFn = async () => {
    calls += 1;
    return { userId: "emp_1", role: "chef", permissions: chefPermissions() };
  };
  const cached = await revalidateLegacyStaffAuthority(socket, joinFn, { force: false });
  assert.equal(cached.ok, true);
  assert.equal(calls, 0);
  const write = await authorizeLegacyPrivilegedEmit(socket, "chef-status-update", joinFn);
  assert.equal(write.ok, true);
  assert.equal(calls, 1);
});

test("privileged emit always revalidates current authority and ignores a positive TTL", async () => {
  const socket = staffSocket();
  socket.legacyStaffCheckedAt = Date.now();
  let calls = 0;
  const joinFn = async () => {
    calls += 1;
    return { userId: "emp_1", role: "chef", permissions: chefPermissions() };
  };
  const first = await authorizeLegacyPrivilegedEmit(socket, "chef-status-update", joinFn);
  assert.equal(first.ok, true);
  const second = await authorizeLegacyPrivilegedEmit(socket, "chef-status-update", joinFn);
  assert.equal(second.ok, true);
  assert.equal(calls, 2, "privileged writes must not reuse the 5s positive cache");
});

test("per-event module permission is required; missing module does not evict identity", async () => {
  const socket = staffSocket();
  const joinFn = async () => ({ userId: "emp_1", role: "chef", permissions: chefPermissions() });
  const status = await authorizeLegacyPrivilegedEmit(socket, "chef-status-update", joinFn);
  assert.equal(status.ok, true);
  const menu = await authorizeLegacyPrivilegedEmit(socket, "menu-updated", joinFn);
  assert.equal(menu.ok, false);
  assert.equal(menu.code, "role_denied");
  const payment = await authorizeLegacyPrivilegedEmit(socket, "payment-approved", joinFn);
  assert.equal(payment.ok, false);
  assert.equal(socket.legacyStaffVerified, true);
  assert.ok(collectOperationalRooms(socket).includes(`chefs:${REST_A}`));
  assert.equal(LEGACY_EVENT_PERMISSIONS["chef-status-update"].module, "orders");
  assert.equal(LEGACY_EVENT_PERMISSIONS["menu-updated"].module, "menu");
  assert.equal(LEGACY_EVENT_PERMISSIONS["payment-approved"].module, "kassa");
  assert.equal(authorizeLegacyEvent({ permissions: chefPermissions() }, "menu-updated").ok, false);
});

test("deleted employee is denied on the next privileged emit without waiting for TTL", async () => {
  const socket = staffSocket();
  socket.legacyStaffCheckedAt = Date.now();
  const denied = await authorizeLegacyPrivilegedEmit(socket, "new-order", async () => null);
  assert.equal(denied.ok, false);
  assert.equal(socket.legacyStaffVerified, false);
  assert.equal(collectOperationalRooms(socket).length, 0);
});

test("failed refresh denies privileged emit and clears write authority", async () => {
  const socket = staffSocket("admin");
  const failed = await authorizeLegacyPrivilegedEmit(socket, "menu-updated", async () => {
    throw new Error("refresh failed");
  });
  assert.equal(failed.ok, false);
  assert.equal(socket.legacyStaffVerified, false);
});

test("tenant transition leaves old restId and denies stale A emits", async () => {
  const socket = staffSocket("admin");
  let tokenRest = REST_A;
  const joinFn = async ({ restId }) => {
    if (restId !== tokenRest) return null;
    return { userId: "emp_1", role: "admin", permissions: { role: "admin", modules: null, actions: null } };
  };
  assert.equal((await authorizeLegacyPrivilegedEmit(socket, "menu-updated", joinFn)).ok, true);
  leaveOperationalRooms(socket);
  tokenRest = REST_B;
  rememberLegacyStaff(socket, {
    token: "b", restId: REST_B, userId: "emp_b", kind: "admin", allowedRoles: ADMIN_CONNECT_ROLES,
    authz: { userId: "emp_b", role: "admin", permissions: { modules: null, actions: null } },
  });
  joinOperationalRooms(socket, staffRoomsForConnect(REST_B, "admin"));
  const onB = await authorizeLegacyPrivilegedEmit(socket, "menu-updated", joinFn);
  assert.equal(onB.ok, true);
  assert.equal(onB.restId, REST_B);
  socket.restId = REST_A;
  const staleA = await authorizeLegacyPrivilegedEmit(socket, "menu-updated", joinFn);
  assert.equal(staleA.ok, false);
});
