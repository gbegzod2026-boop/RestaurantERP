import { resolveIdentity, resolveRequestPermissions } from "../rbac.js";
import { withTenantContext } from "../db/postgres.js";
import { lookupRestaurantByLegacyId } from "./tenant.js";
import { canonicalizeRestId, parseRestId } from "./restId.js";
import { isSafeId } from "../security/sanitize.js";

export async function resolvePermissionsPg(restId, userId) {
  const restaurant = await lookupRestaurantByLegacyId(restId);
  if (!restaurant) return null;
  return withTenantContext(restaurant.id, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM employees WHERE restaurant_id = $1 AND legacy_rtdb_id = $2 LIMIT 1`,
      [restaurant.id, userId]
    );
    if (!rows[0]) return null;
    const user = rows[0];
    if (user.active === false) return null;
    const extra = user.extra && typeof user.extra === "object" ? user.extra : {};
    if (extra.blocked === true || extra.status === "blocked" || extra.deleted === true || extra.revoked === true) return null;
    const role = user.role || "waiter";
    const isSubAdmin = extra.isSubAdmin === true;
    if (role === "owner" || (role === "admin" && isSubAdmin !== true)) {
      return { role, modules: null, actions: null };
    }
    const custom = await client.query(
      `SELECT name, modules, actions FROM custom_roles WHERE restaurant_id = $1`,
      [restaurant.id]
    ).catch(() => ({ rows: [] }));
    const overrides = await client.query(
      `SELECT base_role, modules, actions FROM role_overrides WHERE restaurant_id = $1`,
      [restaurant.id]
    ).catch(() => ({ rows: [] }));
    return { role, pgUser: true, customRoles: custom.rows, roleOverrides: overrides.rows, user };
  }, { actingRole: "owner" });
}

/** Socket join: verified token tenant plus current PostgreSQL employee authority. */
export async function authorizeSocketJoin({
  token,
  restId,
  userId: _unusedUserId,
  resolveIdentityFn = resolveIdentity,
  resolvePermissionsFn = resolveRequestPermissions,
}) {
  const requestedParsed = parseRestId(restId);
  if (!requestedParsed.ok || requestedParsed.empty || !isSafeId(requestedParsed.restId)) return null;
  const requested = requestedParsed.restId;
  const fakeReq = {
    headers: { authorization: token ? `Bearer ${token}` : "" },
    ip: null,
    originalUrl: "socket",
  };
  const identity = await resolveIdentityFn(fakeReq);
  if (!identity.verified) return null;
  if (identity.platformSuperAdmin === true) {
    return { userId: identity.userId, restId: requested, role: identity.role, verified: true, isSuperAdmin: true };
  }
  if (identity.isCustomer === true) return null;
  const tokenRestId = canonicalizeRestId(identity.restId);
  if (!tokenRestId || tokenRestId !== requested) return null;
  const permissions = await resolvePermissionsFn(requested, identity.userId);
  if (!permissions) return null;
  return {
    userId: identity.userId,
    restId: requested,
    role: permissions.role || null,
    permissions,
    verified: true,
  };
}
