// Path-level RBAC for /api/pg/rtdb/*. Tenant match is decided by
// requirePgTenant(); this module only restricts which mapped collections
// a given acting identity may read or write. Platform superadmin is already
// authorized by the canonical verifier before this runs.
//
// Staff reads require a current PostgreSQL employee (existence, active,
// not blocked) and the effective PG role — never the token role claim.
//
// Customer access is NEVER collection-scoped from role:"client". Canonical
// QR sessions are type==="customer" && role==="client" (routes/qr.js).
// Ownership is proven from PostgreSQL / server-side session table claims.
import { resolveRequestPermissions } from "../rbac.js";
import { withTenantContext } from "../db/postgres.js";
import { isSafeId } from "../security/sanitize.js";
import { parseRestId } from "./restId.js";
import { MAPPED_COLLECTIONS, parsePath } from "./pathRouter.js";
import { getOrderByLegacy } from "./ordersService.js";
import { customerOwnsOrder, hasDineInTable, tableMatchesCustomerSession } from "./customerIdentity.js";
import {
  CUSTOMER_PUBLIC_READ,
  customerChangeRequestOp,
  customerChatOp,
  customerCreatePayloadAllowed,
  customerOrderOp,
  customerTableOp,
  customerTimelineOp,
  customerWaiterCallOp,
  payloadHasProtectedOrderField,
} from "./customerPolicy.js";

export const COLLECTION_MODULE = {
  orders: "orders",
  menu: "menu",
  categories: "menu",
  tables: "tables",
  users: "staff",
  customers: "customers",
  reservations: "reservations",
  inventory: "warehouse",
  ingredients: "warehouse",
  notifications: "notifications",
  settings: "settings",
  meta: "settings",
  couriers: "courier",
  courierAssignments: "courier",
  orderChangeRequests: "orders",
  orderTimeline: "orders",
  waiterCalls: "tables",
  kitchenStations: "orders",
  orderChats: "orders",
  activityLogs: "audit_log",
  info: "settings",
  subscription: "settings",
  attendance: "staff",
  kitchenAnnouncements: "notifications",
  chats: "notifications",
  superadmin_chat: "notifications",
};

export const FINANCE_SENSITIVE = new Set(["inventory", "ingredients", "activityLogs", "users", "settings"]);

const READ_ONLY_CONFIG = new Set(["info", "subscription"]);
const STAFF_COMMS = new Set(["kitchenAnnouncements", "chats", "superadmin_chat"]);

export const READ_COMPANIONS = {
  waiter: ["menu", "categories", "meta"],
  chef: ["menu", "categories", "tables"],
  cashier: ["menu", "categories", "tables", "meta"],
  courier: ["orders"],
  head_chef: ["tables", "categories"],
};

function denied(code, status = 403) {
  return { status, error: status === 400 ? "Unsupported path" : "Access Denied", code };
}

function isReadOp(op) {
  return op === "read" || op === "get";
}

function isPushOp(op) {
  return op === "push";
}

function isRemoveOp(op) {
  return op === "remove";
}

function normalizeResourceId(id) {
  if (id == null || id === "") return null;
  const value = String(id);
  if (!isSafeId(value)) return { invalid: true };
  return { id: value };
}

function customerContextOptions(tenant) {
  return {
    actingRole: tenant?.isCustomer === true ? "customer" : (tenant?.actingRole || "customer"),
    customerUid: tenant?.userId || tenant?.customerSessionId || "",
    customerTable: tenant?.table || tenant?.tableId || "",
  };
}

async function defaultLookupOrder(tenant, orderId) {
  if (!tenant?.restaurantUuid || !orderId) return null;
  return withTenantContext(
    tenant.restaurantUuid,
    (client) => getOrderByLegacy(client, tenant.restaurantUuid, orderId),
    customerContextOptions(tenant)
  );
}

async function defaultLookupTable(tenant, tableKey) {
  if (!tenant?.restaurantUuid || !tableKey) return null;
  return withTenantContext(tenant.restaurantUuid, async (client) => {
    const { rows } = await client.query(
      `SELECT legacy_rtdb_id, number
         FROM tables
        WHERE restaurant_id = $1
          AND (
            legacy_rtdb_id = $2
            OR number::text = $2
            OR ('table_' || number::text) = $2
          )
        LIMIT 1`,
      [tenant.restaurantUuid, tableKey]
    );
    return rows[0] || null;
  }, customerContextOptions(tenant));
}

async function defaultLookupChangeRequest(tenant, requestId) {
  if (!tenant?.restaurantUuid || !requestId) return null;
  return withTenantContext(tenant.restaurantUuid, async (client) => {
    const { rows } = await client.query(
      `SELECT legacy_rtdb_id, legacy_order_id, payload, status
         FROM order_change_requests
        WHERE restaurant_id = $1 AND legacy_rtdb_id = $2
        LIMIT 1`,
      [tenant.restaurantUuid, requestId]
    );
    return rows[0] || null;
  }, customerContextOptions(tenant));
}

async function defaultLookupWaiterCall(tenant, callId) {
  if (!tenant?.restaurantUuid || !callId) return null;
  return withTenantContext(tenant.restaurantUuid, async (client) => {
    const { rows } = await client.query(
      `SELECT legacy_rtdb_id, legacy_table_key, extra, status
         FROM waiter_calls
        WHERE restaurant_id = $1 AND legacy_rtdb_id = $2
        LIMIT 1`,
      [tenant.restaurantUuid, callId]
    );
    return rows[0] || null;
  }, customerContextOptions(tenant));
}

async function customerMayAccessOrder(tenant, orderId, lookups) {
  const parsed = normalizeResourceId(orderId);
  if (!parsed || parsed.invalid) return { status: 400, error: "Invalid id", code: "restId_invalid" };
  const order = await lookups.lookupOrder(tenant, parsed.id);
  if (!order) return denied("role_denied");
  if (!customerOwnsOrder(tenant, order)) return denied("role_denied");
  return { ok: true, order };
}

async function customerMayAccessTable(tenant, tableKey, lookups) {
  const parsed = normalizeResourceId(tableKey);
  if (!parsed || parsed.invalid) return { status: 400, error: "Invalid id", code: "restId_invalid" };
  if (!hasDineInTable(tenant)) return denied("role_denied");
  if (tableMatchesCustomerSession(tenant, parsed.id)) return { ok: true };
  const table = await lookups.lookupTable(tenant, parsed.id);
  if (!table) return denied("role_denied");
  if (!tableMatchesCustomerSession(tenant, table.legacy_rtdb_id, table.number)) {
    return denied("role_denied");
  }
  return { ok: true, table };
}

async function authorizeCustomerRtdbPath(tenant, segments, op, {
  lookupOrder = defaultLookupOrder,
  lookupTable = defaultLookupTable,
  lookupChangeRequest = defaultLookupChangeRequest,
  lookupWaiterCall = defaultLookupWaiterCall,
  writeValue,
} = {}) {
  const lookups = { lookupOrder, lookupTable, lookupChangeRequest, lookupWaiterCall };
  const col = segments[2];
  const resource = normalizeResourceId(segments[3]);
  if (resource?.invalid) return { status: 400, error: "Invalid id", code: "restId_invalid" };
  const resourceId = resource?.id || null;
  const isRead = isReadOp(op);

  if (CUSTOMER_PUBLIC_READ.has(col) || col === "settings" || col === "meta") {
    if (isRead) return { ok: true };
    return denied("role_denied");
  }

  if (col === "orders") {
    if (!resourceId) {
      if (isPushOp(op) && customerCreatePayloadAllowed(tenant, writeValue)) return { ok: true };
      return denied("role_denied");
    }
    if (isRemoveOp(op)) return denied("role_denied");
    if (isRead) return customerMayAccessOrder(tenant, resourceId, lookups);
    const existing = await lookupOrder(tenant, resourceId);
    if (!existing) {
      if (!customerCreatePayloadAllowed(tenant, writeValue)) return denied("role_denied");
      return { ok: true };
    }
    if (!customerOwnsOrder(tenant, existing)) return denied("role_denied");
    const decision = customerOrderOp(op, segments, writeValue, existing);
    if (decision.status) return decision;
    return { ok: true };
  }

  if (col === "tables") {
    if (!resourceId) return denied("role_denied");
    const tableOp = customerTableOp(op);
    if (tableOp.status) return tableOp;
    return customerMayAccessTable(tenant, resourceId, lookups);
  }

  if (col === "orderTimeline") {
    const timeline = customerTimelineOp(op);
    if (timeline.status) return timeline;
    return customerMayAccessOrder(tenant, resourceId, lookups);
  }

  if (col === "orderChats") {
    const chat = customerChatOp(op, segments);
    if (chat.status) return chat;
    return customerMayAccessOrder(tenant, resourceId, lookups);
  }

  if (col === "orderChangeRequests") {
    const cr = customerChangeRequestOp(op, segments, writeValue);
    if (cr.status) return cr;
    const orderId = writeValue?.orderId || writeValue?.legacy_order_id;
    if (!resourceId) return customerMayAccessOrder(tenant, String(orderId), lookups);
    const row = await lookupChangeRequest(tenant, resourceId);
    const boundOrderId = row?.legacy_order_id || row?.payload?.orderId;
    if (!boundOrderId) return denied("role_denied");
    if (orderId && String(orderId) !== String(boundOrderId)) return denied("role_denied");
    return customerMayAccessOrder(tenant, String(boundOrderId), lookups);
  }

  if (col === "waiterCalls") {
    const callOp = customerWaiterCallOp(op, segments, writeValue, tenant);
    if (callOp.status) return callOp;
    if (!resourceId) return { ok: true };
    const row = await lookupWaiterCall(tenant, resourceId);
    const tableKey = row?.legacy_table_key || row?.extra?.table || row?.extra?.tableId;
    if (!tableKey) return denied("role_denied");
    return customerMayAccessTable(tenant, String(tableKey), lookups);
  }

  return denied("role_denied");
}

export async function authorizeRtdbPath(tenant, path, op, {
  resolvePerms = resolveRequestPermissions,
  lookupOrder,
  lookupTable,
  lookupChangeRequest,
  lookupWaiterCall,
  writeValue,
} = {}) {
  const { segments } = parsePath(path);
  if (segments[0] !== "restaurants" || !segments[1]) {
    return denied("path_restId_mismatch");
  }
  const pathParsed = parseRestId(segments[1]);
  if (!pathParsed.ok || pathParsed.empty) {
    return { status: 400, error: "Invalid restaurant id", code: "restId_invalid" };
  }
  if (pathParsed.restId !== tenant.restId) {
    return denied("path_restId_mismatch");
  }
  const col = segments[2];
  if (!MAPPED_COLLECTIONS.has(col)) return denied("unmapped_path", 400);

  if (tenant.isSuperAdmin === true) return { ok: true };

  if (tenant.isCustomer === true) {
    return authorizeCustomerRtdbPath(tenant, segments, op, {
      lookupOrder, lookupTable, lookupChangeRequest, lookupWaiterCall, writeValue,
    });
  }

  const isRead = isReadOp(op);
  const perms = await resolvePerms(tenant.restId, tenant.userId);
  if (!perms) return denied("role_denied");
  if (!isRead && READ_ONLY_CONFIG.has(col)) return denied("role_denied");
  if (perms.modules === null) return { ok: true };

  if (isRead && READ_ONLY_CONFIG.has(col)) return { ok: true };
  if (STAFF_COMMS.has(col)) return { ok: true };
  if (col === "attendance" && segments[4] === tenant.userId) return { ok: true };

  if (isRead && (READ_COMPANIONS[perms.role] || []).includes(col)) {
    return { ok: true };
  }

  const moduleId = COLLECTION_MODULE[col];
  const allowedModules = perms.modules || [];
  const allowedActions = (perms.actions && perms.actions[moduleId]) || [];
  const required = isRead ? "view" : "edit";
  if (!moduleId || !allowedModules.includes(moduleId) || !allowedActions.includes(required)) {
    return denied("role_denied");
  }
  return { ok: true };
}
