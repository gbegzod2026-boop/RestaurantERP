// Policy for legacy Socket.IO events in server.js. Unauthenticated sockets
// never join tenant rooms. Customers never join rest-{restId}.
import { canonicalizeRestId, parseRestId } from "./restId.js";
import { isSafeId } from "../security/sanitize.js";
import { permissionAllows } from "../rbac.js";

export const LEGACY_OPERATIONAL_EVENTS = [
  "new-order",
  "chef:new-order",
  "order-assigned",
  "chef-status-update",
  "payment-request",
  "payment-approved",
  "chef-message",
  "chef:chat-message",
  "table-force-closed",
  "session-reset",
  "menu-updated",
];

export const LEGACY_EVENT_PERMISSIONS = {
  "new-order": { module: "orders", action: "edit" },
  "chef:new-order": { module: "orders", action: "edit" },
  "order-assigned": { module: "orders", action: "edit" },
  "chef-status-update": { module: "orders", action: "edit" },
  "payment-request": { module: "orders", action: "edit" },
  "payment-approved": { module: "kassa", action: "edit" },
  "chef-message": { module: "orders", action: "edit" },
  "chef:chat-message": { module: "orders", action: "edit" },
  "table-force-closed": { module: "tables", action: "edit" },
  "session-reset": { module: "tables", action: "edit" },
  "menu-updated": { module: "menu", action: "edit" },
};

export function customerSocketRooms(identity) {
  if (!identity?.verified || identity.isCustomer !== true || !identity.userId) return [];
  const rooms = [`customer-session:${identity.userId}`];
  const restId = canonicalizeRestId(identity.restId);
  const table = identity.table || identity.tableId;
  if (restId && table) rooms.push(`customer-table:${restId}:${String(table)}`);
  return rooms;
}

export function authorizeLegacyClientConnect({ identity, requestedRestId } = {}) {
  if (!identity?.verified || identity.isCustomer !== true) {
    return { ok: false, code: "unauthenticated", joinRooms: [] };
  }
  const tokenRest = canonicalizeRestId(identity.restId);
  if (!tokenRest) return { ok: false, code: "restId_invalid", joinRooms: [] };
  if (requestedRestId != null && String(requestedRestId).trim() !== "") {
    const parsed = parseRestId(requestedRestId);
    if (!parsed.ok || parsed.empty || parsed.restId !== tokenRest) {
      return { ok: false, code: "restId_mismatch", joinRooms: [] };
    }
  }
  return {
    ok: true,
    restId: tokenRest,
    userId: identity.userId,
    table: identity.table || "",
    joinRooms: customerSocketRooms(identity),
  };
}

export const LEGACY_STAFF_TTL_MS = 5_000;
export const LEGACY_STAFF_RECHECK_MS = 60_000;
export const CHEF_CONNECT_ROLES = ["chef", "admin", "owner", "head_chef"];
export const ADMIN_CONNECT_ROLES = ["admin", "owner"];

export function authorizeLegacyStaffConnect({ identity, authz, requestedRestId, requestedUserId, allowedRoles }) {
  if (!authz || !identity?.verified || identity.isCustomer === true) {
    return { ok: false, code: "subscribe_denied" };
  }
  const parsed = parseRestId(requestedRestId);
  if (!parsed.ok || parsed.empty || !isSafeId(parsed.restId)) {
    return { ok: false, code: "restId_invalid" };
  }
  if (!requestedUserId || !isSafeId(String(requestedUserId))) {
    return { ok: false, code: "subscribe_denied" };
  }
  if (authz.userId !== String(requestedUserId)) return { ok: false, code: "subscribe_denied" };
  if (allowedRoles && authz.isSuperAdmin !== true && !allowedRoles.includes(authz.role)) {
    return { ok: false, code: "role_denied" };
  }
  return { ok: true, restId: parsed.restId, userId: authz.userId, role: authz.role };
}

export function isOperationalTenantRoom(room) {
  return /^(rest-|admins:|chefs:)/.test(String(room || ""));
}

export function staffRoomsForConnect(restId, kind) {
  if (kind === "chef") return [`chefs:${restId}`, `rest-${restId}`];
  return [`admins:${restId}`, `rest-${restId}`];
}

export function collectOperationalRooms(socket) {
  const fromSet = socket?.rooms instanceof Set ? [...socket.rooms] : [];
  const tracked = Array.isArray(socket?.legacyJoinedRooms) ? socket.legacyJoinedRooms : [];
  return [...new Set([...fromSet, ...tracked])].filter(isOperationalTenantRoom);
}

export function leaveOperationalRooms(socket) {
  if (!socket) return [];
  const rooms = collectOperationalRooms(socket);
  for (const room of rooms) socket.leave?.(room);
  socket.legacyJoinedRooms = [];
  socket.legacyStaffVerified = false;
  socket.legacyStaffAuthz = null;
  socket.legacyStaffCheckedAt = 0;
  socket.legacyConnectKind = null;
  socket.legacyAllowedRoles = null;
  socket.legacyUserId = null;
  socket.legacyToken = null;
  if (socket.role === "admin" || socket.role === "chef") socket.role = null;
  socket.restId = null;
  socket.chefId = null;
  return rooms;
}

export function joinOperationalRooms(socket, rooms = []) {
  socket.legacyJoinedRooms = [];
  for (const room of rooms) {
    socket.join?.(room);
    socket.legacyJoinedRooms.push(room);
  }
  return socket.legacyJoinedRooms.slice();
}

export function rememberLegacyStaff(socket, {
  token, restId, userId, kind, allowedRoles, authz, chefId,
} = {}) {
  socket.legacyStaffVerified = true;
  socket.legacyToken = token || socket.legacyToken || null;
  socket.restId = restId;
  socket.legacyUserId = userId;
  socket.legacyConnectKind = kind;
  socket.legacyAllowedRoles = allowedRoles || null;
  socket.legacyStaffAuthz = authz || null;
  socket.legacyStaffCheckedAt = Date.now();
  socket.isCustomer = false;
  socket.role = kind === "chef" ? "chef" : "admin";
  if (chefId) socket.chefId = chefId;
}

export async function revalidateLegacyStaffAuthority(socket, authorizeSocketJoinFn, {
  force = true,
  ttlMs = LEGACY_STAFF_TTL_MS,
} = {}) {
  if (socket?.isCustomer === true) {
    leaveOperationalRooms(socket);
    return { ok: false, code: "role_denied" };
  }
  if (!socket?.legacyStaffVerified || !socket.restId || !socket.legacyUserId) {
    return { ok: false, code: "unauthenticated" };
  }
  const now = Date.now();
  if (force !== true && socket.legacyStaffAuthz && now - (socket.legacyStaffCheckedAt || 0) < ttlMs) {
    return { ok: true, restId: socket.restId, authz: socket.legacyStaffAuthz };
  }
  let authz;
  try {
    authz = await authorizeSocketJoinFn({
      token: socket.legacyToken,
      restId: socket.restId,
      userId: socket.legacyUserId,
    });
  } catch {
    leaveOperationalRooms(socket);
    return { ok: false, code: "subscribe_denied" };
  }
  if (
    !authz ||
    (socket.legacyAllowedRoles && authz.isSuperAdmin !== true && !socket.legacyAllowedRoles.includes(authz.role))
  ) {
    leaveOperationalRooms(socket);
    return { ok: false, code: "subscribe_denied" };
  }
  socket.legacyStaffAuthz = authz;
  socket.legacyStaffCheckedAt = now;
  return { ok: true, restId: socket.restId, authz };
}

export function authorizeLegacyEvent(authz, event) {
  if (!event || !LEGACY_OPERATIONAL_EVENTS.includes(event)) return { ok: false, code: "role_denied" };
  const need = LEGACY_EVENT_PERMISSIONS[event];
  if (!need) return { ok: false, code: "role_denied" };
  if (!authz) return { ok: false, code: "subscribe_denied" };
  if (authz.isSuperAdmin === true) return { ok: true, ...need };
  const perms = authz.permissions || authz;
  if (!permissionAllows(perms, need.module, need.action)) {
    return { ok: false, code: "role_denied" };
  }
  return { ok: true, ...need };
}

export async function authorizeLegacyPrivilegedEmit(socket, event, authorizeSocketJoinFn) {
  const current = await revalidateLegacyStaffAuthority(socket, authorizeSocketJoinFn, { force: true });
  if (!current.ok) return current;
  const operational = authorizeLegacyOperational({
    staffVerified: true,
    restId: current.restId,
    isCustomer: socket.isCustomer === true,
    event,
  });
  if (!operational.ok) return operational;
  const eventAuth = authorizeLegacyEvent(current.authz, event);
  if (!eventAuth.ok) return eventAuth;
  return { ok: true, restId: current.restId, authz: current.authz, module: eventAuth.module, action: eventAuth.action };
}

export function authorizeLegacyOperational({ staffVerified, restId, isCustomer, event } = {}) {
  if (isCustomer === true) return { ok: false, code: "role_denied" };
  if (!staffVerified) return { ok: false, code: "unauthenticated" };
  if (!restId) return { ok: false, code: "subscribe_denied" };
  if (event && !LEGACY_OPERATIONAL_EVENTS.includes(event)) return { ok: false, code: "role_denied" };
  return { ok: true, restId };
}

export function tenantWideRoomsForbidden(rooms = []) {
  return rooms.some((room) => /^rest-/.test(String(room)) || /^admins:/.test(String(room)) || /^chefs:/.test(String(room)));
}
