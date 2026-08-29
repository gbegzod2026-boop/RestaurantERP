import test from "node:test";
import assert from "node:assert/strict";
import { authorizeRtdbPath } from "../../pg/rtdbAuthz.js";
import { authorizeSocketJoin } from "../../pg/rbacPg.js";
import {
  customerOwnsOrder,
  isCanonicalCustomerClaims,
} from "../../pg/customerIdentity.js";
import { authorizeLegacyClientConnect, authorizeLegacyOperational, tenantWideRoomsForbidden } from "../../pg/legacySocketPolicy.js";
import { CUSTOMER_PROTECTED_ORDER_FIELDS } from "../../pg/customerPolicy.js";

const REST = "rest_1784740340104";
const REST_B = "rest_2000000000002";
const ORDER_A = "ord_table1";
const ORDER_B = "ord_table2";
const ORDER_NA = "ord_takeaway";

const customerA = {
  restId: REST,
  userId: `client_${REST}_1`,
  role: "client",
  isSuperAdmin: false,
  isCustomer: true,
  tokenType: "customer",
  table: "1",
  tableId: "table_1",
};
const customerB = { ...customerA, userId: `client_${REST}_2`, table: "2", tableId: "table_2" };
const takeawayA = { ...customerA, userId: `client_${REST}_s_aaa`, table: "", tableId: "" };
const takeawayB = { ...customerA, userId: `client_${REST}_s_bbb`, table: "", tableId: "" };

const orders = {
  [ORDER_A]: { table: 1, tableId: "table_1", customer_session_id: customerA.userId, status: "order_created" },
  [ORDER_B]: { table: 2, tableId: "table_2", customer_session_id: customerB.userId, status: "order_created" },
  [ORDER_NA]: { orderType: "takeaway", customer_session_id: takeawayA.userId, status: "order_created" },
};
const tables = {
  table_1: { legacy_rtdb_id: "table_1", number: 1 },
  "1": { legacy_rtdb_id: "table_1", number: 1 },
  table_2: { legacy_rtdb_id: "table_2", number: 2 },
};
const changeRequests = {
  cr_a: { legacy_order_id: ORDER_A },
  cr_b: { legacy_order_id: ORDER_B },
};
const waiterCalls = {
  call_a: { legacy_table_key: "table_1" },
  call_b: { legacy_table_key: "table_2" },
};

const lookups = {
  lookupOrder: async (_tenant, id) => orders[id] || null,
  lookupTable: async (_tenant, id) => tables[id] || null,
  lookupChangeRequest: async (_tenant, id) => changeRequests[id] || null,
  lookupWaiterCall: async (_tenant, id) => waiterCalls[id] || null,
};

function decide(tenant, path, op, extra = {}) {
  return authorizeRtdbPath(tenant, path, op, { ...lookups, ...extra });
}

test("canonical customer identity requires type and role together", () => {
  assert.equal(isCanonicalCustomerClaims({ type: "customer", role: "client" }), true);
  assert.equal(isCanonicalCustomerClaims({ role: "client" }), false);
  assert.equal(isCanonicalCustomerClaims({ type: "customer", role: "admin" }), false);
  assert.equal(isCanonicalCustomerClaims({ type: "staff", role: "client" }), false);
  assert.equal(customerOwnsOrder(customerA, orders[ORDER_A]), true);
  assert.equal(customerOwnsOrder(customerA, orders[ORDER_B]), false);
  assert.equal(customerOwnsOrder(customerA, orders[ORDER_NA]), false);
  assert.equal(customerOwnsOrder(takeawayA, orders[ORDER_NA]), true);
  assert.equal(customerOwnsOrder(takeawayB, orders[ORDER_NA]), false);
  assert.equal(customerOwnsOrder(takeawayA, { orderType: "takeaway" }), false);
});

test("staff token with role client is not a customer and is denied without an employee", async () => {
  const forged = {
    restId: REST, userId: "admin_1", role: "client", isSuperAdmin: false, isCustomer: false,
  };
  const result = await decide(forged, `restaurants/${REST}/orders`, "get", {
    resolvePerms: async () => null,
  });
  assert.equal(result.code, "role_denied");
});

test("customer A own order read is allowed; collection and foreign resources are denied", async () => {
  assert.equal((await decide(customerA, `restaurants/${REST}/orders/${ORDER_A}`, "get")).ok, true);
  assert.equal((await decide(customerA, `restaurants/${REST}/orders`, "get")).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/orders/${ORDER_B}`, "get")).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/tables`, "get")).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/tables/table_2`, "get")).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/tables/table_1`, "get")).ok, true);
  assert.equal((await decide(customerA, `restaurants/${REST}/notifications`, "get")).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/orderChats/${ORDER_B}`, "get")).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/orderChats/${ORDER_A}/messages`, "get")).ok, true);
  assert.equal((await decide(customerA, `restaurants/${REST}/orderChangeRequests`, "get")).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/waiterCalls`, "get")).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/menu`, "get")).ok, true);
  assert.equal((await decide(customerA, `restaurants/${REST}/settings`, "get")).ok, true);
  assert.equal((await decide(customerA, `restaurants/${REST}/settings`, "set")).code, "role_denied");
});

test("customer writes are resource-scoped and fail closed", async () => {
  assert.equal((await decide(customerA, `restaurants/${REST}/orders/${ORDER_B}`, "update")).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/orders/${ORDER_B}`, "set", {
    writeValue: { table: 1, items: [] },
  })).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/orders/${ORDER_A}`, "remove")).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/orders`, "push", {
    writeValue: { table: 2, items: [] },
  })).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/orders`, "push", {
    writeValue: { items: [] },
  })).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/orders`, "push", {
    writeValue: { table: 1, items: [] },
  })).ok, true);
  assert.equal((await decide(customerA, `restaurants/${REST}/orders/${ORDER_A}`, "update", {
    writeValue: { notes: "ok" },
  })).ok, true);
  assert.equal((await decide(customerA, `restaurants/${REST}/tables/table_1`, "set", {
    writeValue: { status: "occupied" },
  })).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/waiterCalls`, "push", {
    writeValue: { table: 2 },
  })).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/waiterCalls`, "push", {
    writeValue: { table: 1 },
  })).ok, true);
  assert.equal((await decide(customerA, `restaurants/${REST}/waiterCalls/call_a`, "update", {
    writeValue: { status: "resolved" },
  })).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/orderChangeRequests`, "push", {
    writeValue: { orderId: ORDER_B },
  })).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/orderChangeRequests`, "push", {
    writeValue: { orderId: ORDER_A, status: "approved" },
  })).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/orderChangeRequests`, "push", {
    writeValue: { orderId: ORDER_A },
  })).ok, true);
  assert.equal((await decide(customerA, `restaurants/${REST}/orderChats/${ORDER_B}/messages`, "push")).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/orderTimeline/${ORDER_A}`, "set")).code, "role_denied");
});

test("customer protected order fields are denied on update", async () => {
  for (const field of CUSTOMER_PROTECTED_ORDER_FIELDS) {
    const result = await decide(customerA, `restaurants/${REST}/orders/${ORDER_A}`, "update", {
      writeValue: { [field]: "hijack" },
    });
    assert.equal(result.code, "role_denied", field);
  }
});

test("takeaway ownership requires session binding", async () => {
  assert.equal((await decide(takeawayA, `restaurants/${REST}/orders/${ORDER_NA}`, "get")).ok, true);
  assert.equal((await decide(takeawayB, `restaurants/${REST}/orders/${ORDER_NA}`, "get")).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST}/orders/${ORDER_NA}`, "get")).code, "role_denied");
});

test("customer A cannot act as customer B or tenant B", async () => {
  assert.equal((await decide(customerA, `restaurants/${REST}/orders/${ORDER_B}`, "get")).code, "role_denied");
  assert.equal((await decide(customerB, `restaurants/${REST}/orders/${ORDER_A}`, "get")).code, "role_denied");
  assert.equal((await decide(customerA, `restaurants/${REST_B}/orders/${ORDER_A}`, "get")).code, "path_restId_mismatch");
});

test("customer tokens cannot join the generic tenant realtime room", async () => {
  const authz = await authorizeSocketJoin({
    token: "t",
    restId: REST,
    resolveIdentityFn: async () => ({
      verified: true,
      userId: customerA.userId,
      restId: REST,
      role: "client",
      isCustomer: true,
      tokenType: "customer",
    }),
    resolvePermissionsFn: async () => ({ role: "admin", modules: null, actions: null }),
  });
  assert.equal(authz, null);
});

test("legacy unauthenticated and customer sockets cannot join tenant rooms", () => {
  const unauth = authorizeLegacyClientConnect({ identity: { verified: false }, requestedRestId: REST });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.joinRooms.length, 0);
  const forged = authorizeLegacyClientConnect({
    identity: { verified: true, isCustomer: true, restId: REST, userId: customerA.userId, table: "1" },
    requestedRestId: REST_B,
  });
  assert.equal(forged.ok, false);
  const customer = authorizeLegacyClientConnect({
    identity: { verified: true, isCustomer: true, restId: REST, userId: customerA.userId, table: "1" },
    requestedRestId: REST,
  });
  assert.equal(customer.ok, true);
  assert.equal(tenantWideRoomsForbidden(customer.joinRooms), false);
  assert.equal(authorizeLegacyOperational({ staffVerified: false, restId: REST, event: "new-order" }).ok, false);
  assert.equal(authorizeLegacyOperational({
    staffVerified: true, restId: REST, isCustomer: true, event: "new-order",
  }).ok, false);
});
