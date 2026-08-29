import test from "node:test";
import assert from "node:assert/strict";
import { authorizeRtdbPath, READ_COMPANIONS, FINANCE_SENSITIVE } from "../../pg/rtdbAuthz.js";
import { evaluateResync, evaluateSubscribe } from "../../pg/socket.js";

const REST = "rest_1784740340104";
const GEN = "test-generation-1";

function perms(role, modules, actionList = ["view", "create", "edit"]) {
  const actions = {};
  for (const moduleId of modules) actions[moduleId] = [...actionList];
  return { role, modules, actions };
}

const WAITER = perms("waiter", ["dashboard", "orders", "tables", "customers", "reservations", "notifications"]);
const CHEF = perms("chef", ["dashboard", "orders", "notifications"], ["view", "edit"]);
const COURIER = perms("courier", ["courier", "delivery"], ["view", "edit"]);
const CASHIER = perms("cashier", ["dashboard", "orders", "customers", "notifications", "kassa", "delivery"], ["view", "export", "refund", "edit"]);
const ADMIN = { role: "admin", modules: null, actions: null };

async function decision(rolePerms, col, op, userId = "u1") {
  return authorizeRtdbPath(
    { restId: REST, userId, role: rolePerms.role, isSuperAdmin: false },
    `restaurants/${REST}/${col}`,
    op,
    { resolvePerms: async () => rolePerms }
  );
}

test("deleted employee token cannot read mapped collections", async () => {
  const result = await authorizeRtdbPath(
    { restId: REST, userId: "gone", role: "waiter", isSuperAdmin: false },
    `restaurants/${REST}/orders`,
    "read",
    { resolvePerms: async () => null }
  );
  assert.equal(result.code, "role_denied");
});

test("blocked employee cannot read mapped collections", async () => {
  const result = await authorizeRtdbPath(
    { restId: REST, userId: "blocked", role: "waiter", isSuperAdmin: false },
    `restaurants/${REST}/orders`,
    "read",
    { resolvePerms: async () => null }
  );
  assert.equal(result.code, "role_denied");
});

test("waiter restricted collections are denied on read", async () => {
  for (const col of ["users", "activityLogs", "inventory", "settings", ...FINANCE_SENSITIVE]) {
    const result = await decision(WAITER, col, "read");
    assert.equal(result.code, "role_denied", col);
  }
});

test("waiter permitted collections and POS companions are readable", async () => {
  for (const col of ["orders", "tables", "customers", "notifications", ...READ_COMPANIONS.waiter]) {
    const result = await decision(WAITER, col, "read");
    assert.equal(result.ok, true, col);
  }
});

test("chef restricted collections are denied on read", async () => {
  for (const col of ["users", "inventory", "settings", "customers", "activityLogs"]) {
    const result = await decision(CHEF, col, "read");
    assert.equal(result.code, "role_denied", col);
  }
});

test("chef can read orders and catalog companions", async () => {
  for (const col of ["orders", "notifications", ...READ_COMPANIONS.chef]) {
    const result = await decision(CHEF, col, "read");
    assert.equal(result.ok, true, col);
  }
});

test("courier restricted collections are denied on read", async () => {
  for (const col of ["users", "inventory", "settings", "customers", "menu", "activityLogs"]) {
    const result = await decision(COURIER, col, "read");
    assert.equal(result.code, "role_denied", col);
  }
});

test("courier can read courier collections and order companion", async () => {
  for (const col of ["couriers", "courierAssignments", "orders"]) {
    const result = await decision(COURIER, col, "read");
    assert.equal(result.ok, true, col);
  }
});

test("cashier and admin permitted collections", async () => {
  assert.equal((await decision(CASHIER, "orders", "read")).ok, true);
  assert.equal((await decision(CASHIER, "customers", "read")).ok, true);
  assert.equal((await decision(CASHIER, "users", "read")).code, "role_denied");
  assert.equal((await decision(CASHIER, "inventory", "read")).code, "role_denied");
  assert.equal((await decision(CASHIER, "activityLogs", "read")).code, "role_denied");
  assert.equal((await decision(ADMIN, "settings", "read")).ok, true);
  assert.equal((await decision(ADMIN, "users", "write")).ok, true);
  assert.equal((await decision(ADMIN, "inventory", "read")).ok, true);
});

test("canonical platform superadmin may read an explicit tenant path", async () => {
  const result = await authorizeRtdbPath(
    { restId: REST, userId: "root", role: null, isSuperAdmin: true },
    `restaurants/${REST}/settings`,
    "read"
  );
  assert.equal(result.ok, true);
});

test("unmapped collection is unmapped_path not an open read", async () => {
  const result = await decision(ADMIN, "unmappedTenantData", "read");
  assert.equal(result.code, "unmapped_path");
  assert.equal(result.status, 400);
});

test("stale token role is ignored; PostgreSQL permissions win", async () => {
  const result = await authorizeRtdbPath(
    { restId: REST, userId: "u1", role: "admin", isSuperAdmin: false },
    `restaurants/${REST}/inventory`,
    "read",
    { resolvePerms: async () => WAITER }
  );
  assert.equal(result.code, "role_denied");
});

test("custom role is limited to granted modules", async () => {
  const custom = perms("floor_lead", ["orders", "tables"]);
  assert.equal((await decision(custom, "orders", "read")).ok, true);
  assert.equal((await decision(custom, "inventory", "read")).code, "role_denied");
  assert.equal((await decision(custom, "users", "read")).code, "role_denied");
});

test("view without edit cannot write", async () => {
  const viewer = perms("waiter", ["orders", "tables", "customers", "reservations", "notifications"], ["view"]);
  assert.equal((await decision(viewer, "orders", "read")).ok, true);
  assert.equal((await decision(viewer, "orders", "write")).code, "role_denied");
});

test("owner has unrestricted mapped access; inactive employee does not", async () => {
  const owner = { role: "owner", modules: null, actions: null };
  assert.equal((await decision(owner, "inventory", "read")).ok, true);
  assert.equal((await decision(owner, "users", "write")).ok, true);
  const inactive = await authorizeRtdbPath(
    { restId: REST, userId: "inactive", role: "owner", isSuperAdmin: false },
    `restaurants/${REST}/orders`,
    "read",
    { resolvePerms: async () => null }
  );
  assert.equal(inactive.code, "role_denied");
});

test("resync is rejected until subscribe ack", () => {
  assert.equal(evaluateResync({ nestaSubscribed: false }, REST, GEN).error, "not_subscribed");
  assert.equal(evaluateSubscribe("rest_s1a_x", { userId: "u" }, GEN).error, "restId_invalid");
  assert.equal(evaluateSubscribe(REST, { userId: "u1" }, "").error, "subscription_invalid");
  const sub = evaluateSubscribe(REST, { userId: "u1" }, GEN);
  assert.equal(sub.ok, true);
  const socket = { nestaSubscribed: true, nestaRestId: sub.restId, nestaGeneration: GEN };
  assert.equal(evaluateResync(socket, REST, GEN).ok, true);
  assert.equal(evaluateResync(socket, REST, "stale-generation").error, "not_subscribed");
  assert.equal(evaluateResync(socket, "rest_2000000000002", GEN).error, "not_subscribed");
});
