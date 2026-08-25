import { resolveIdentity, resolveRequestPermissions } from "../rbac.js";
import { withTenantContext } from "../db/postgres.js";
import { lookupRestaurantByLegacyId } from "./tenant.js";
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
    const extra = user.extra && typeof user.extra === "object" ? user.extra : {};
    const role = user.role || "waiter";
    const isSubAdmin = extra.isSubAdmin === true;
    if (role === "owner" || (role === "admin" && isSubAdmin !== true)) {
      return { role, modules: null, actions: null };
    }
    const [custom, overrides] = await Promise.all([
      client.query(`SELECT name, modules, actions FROM custom_roles WHERE restaurant_id = $1`, [restaurant.id]).catch(() => ({ rows: [] })),
      client.query(`SELECT base_role, modules, actions FROM role_overrides WHERE restaurant_id = $1`, [restaurant.id]).catch(() => ({ rows: [] })),
    ]);
    // Fall through to the existing Firebase resolver if custom role tables are empty —
    // ROLE_TEMPLATES in rbac.js still apply via resolveRequestPermissions.
    return { role, pgUser: true, customRoles: custom.rows, roleOverrides: overrides.rows, user };
  }, { actingRole: "owner" });
}

/** Socket join: verified token restId must match requested restId. */
export async function authorizeSocketJoin({ token, restId, userId }) {
  if (!restId || !isSafeId(String(restId))) return null;
  const fakeReq = {
    headers: { authorization: token ? `Bearer ${token}` : "" },
    ip: null,
    originalUrl: "socket",
  };
  const identity = await resolveIdentity(fakeReq);
  if (identity.verified) {
    if (identity.restId !== restId) return null;
    return { userId: identity.userId, restId, role: identity.role, verified: true };
  }
  if (!userId || !isSafeId(String(userId))) return null;
  const perms = await resolveRequestPermissions(restId, userId).catch(() => null);
  if (!perms) return null;
  return { userId, restId, role: perms.role, verified: false };
}
