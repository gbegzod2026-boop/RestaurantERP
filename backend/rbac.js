// rbac.js — server-side permission resolution + Express middleware.
//
// This is a Node-side port of the permission model already implemented on
// the client in admin-frontend/public/js/admin.js (ROLE_TEMPLATES,
// customRoles, roleOverrides, resolveRoleConfig). It must stay in sync with
// that file's ROLE_TEMPLATES/ALL_MODULES/ALL_ACTIONS if those change.
//
// Identity — Production Security Fix Pass (Critical):
// Every request used to identify the acting employee purely via the
// client-supplied `x-user-id` header, with nothing checking that the caller
// actually IS that user (no password/token tied to it) — anyone could claim
// any user id. requirePermission() now prefers a verified identity: if the
// request carries `Authorization: Bearer <firebase-id-token>` (issued by
// POST /api/auth/staff-login or /api/auth/manager-login, see routes/auth.js)
// and a Firebase Admin service account is configured (firebaseAdmin.js), the
// token is cryptographically verified and its uid/claims are trusted instead
// of the header. The `x-user-id` header remains a fallback — for requests
// without a bearer token (older/not-yet-migrated frontend call sites, or
// deployments without a service account configured yet) — so nothing breaks
// during the transition, but that fallback is logged as unverified so it's
// visible in the security log which traffic still relies on it.
import { isSafeId } from "./security/sanitize.js";
import { logSecurityEvent } from "./security/auditLog.js";
import { isAdminAvailable, getAdminAuth } from "./firebaseAdmin.js";
// Architecture Fix Pass: database.rules.json now requires `auth != null` on
// restaurants/$restId, so this file's own reads (the permission check every
// requirePermission()-gated route depends on) must go through the Admin SDK
// when available — otherwise this backend's plain, unauthenticated client-
// SDK connection would be rejected by the very rules it's trying to enforce
// permissions ahead of. See systemDb.js for the admin-or-client fallback.
import { systemGet } from "./systemDb.js";
import { usePostgres } from "./pg/config.js";
import { getPool, withTenantContext } from "./db/postgres.js";

/**
 * Resolves the acting user's id for a request, preferring a verified
 * Firebase ID token over the legacy x-user-id header. Returns
 * { userId, verified } — verified is true only when the id token was
 * cryptographically checked (signature, expiry, issuer) by the Admin SDK.
 *
 * mintSessionToken() first-login-token-bug fix (routes/auth.js): the
 * Firebase Auth uid a verified token's `decoded.uid` carries is no longer
 * the bare RTDB userId — it's `${restId}__${userId}` (globally unique
 * across restaurants; see routes/auth.js's mintSessionToken() header for
 * why). The RTDB userId this app actually needs (to look up
 * restaurants/$restId/users/$userId, credentials/$restId/$userId, etc.) now
 * travels as the token's separate `rtdbUserId` claim instead. Falling back
 * to `decoded.uid` when that claim is absent keeps every ALREADY-MINTED
 * token (signed in before this fix shipped, or a QR customer session /
 * superadmin session that never sets rtdbUserId) resolving exactly as it
 * did before — no forced re-login, no behavior change for any token this
 * fix didn't touch.
 */
export async function resolveIdentity(req) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ") && isAdminAvailable()) {
    const idToken = authHeader.slice(7).trim();
    if (idToken) {
      try {
        const decoded = await getAdminAuth().verifyIdToken(idToken);
        return {
          userId: decoded.rtdbUserId || decoded.uid,
          restId: decoded.restId || decoded.restaurantId || null,
          role: decoded.role || null,
          verified: true,
        };
      } catch (err) {
        // Expired/malformed token is not a verified identity. Do not trust
        // x-user-id as a substitute — that header is not a credential.
        logSecurityEvent({ type: "id_token_invalid", ip: req.ip, path: req.originalUrl, details: { reason: err.code || "invalid_token" } });
        return {
          userId: null,
          restId: null,
          role: null,
          verified: false,
          tokenError: err.code || "invalid_token",
        };
      }
    }
  }
  const headerUserId = req.headers["x-user-id"];
  return { userId: headerUserId || null, restId: null, role: null, verified: false };
}

const ROLE_TEMPLATES = {
  admin: {
    modules: [
      "dashboard",
      "orders",
      "menu",
      "tables",
      "staff",
      "customers",
      "report",
      "notifications",
      "roles",
      "audit_log",
      "settings",
      "reservations",
      "warehouse",
      "finance",
      "feedback",
      "kassa",
      "system-health",
      "courier",
      "delivery",
      "delivery-settings",
      "ai_import"
    ],
    actions: [
      "view",
      "create",
      "edit",
      "delete",
      "export",
      "refund",
      "discount",
      "manage_roles"
    ]
  },
  owner: { modules: ["dashboard", "orders", "menu", "tables", "staff", "customers", "report", "notifications", "roles", "audit_log", "settings", "reservations", "warehouse", "finance", "feedback", "kassa", "system-health", "courier", "delivery", "delivery-settings", "ai_import"], actions: ["view", "create", "edit", "delete", "export", "refund", "discount", "manage_roles"] },
  manager: { modules: ["dashboard", "orders", "tables", "staff", "customers", "report", "notifications", "reservations", "feedback"], actions: ["view", "create", "edit", "export", "discount"] },
  cashier: { modules: ["dashboard", "orders", "customers", "notifications", "kassa", "delivery"], actions: ["view", "export", "refund", "edit"] },
  head_chef: { modules: ["dashboard", "orders", "menu", "notifications", "warehouse", "staff"], actions: ["view", "edit", "create"] },
  chef: { modules: ["dashboard", "orders", "notifications"], actions: ["view", "edit"] },
  waiter: { modules: ["dashboard", "orders", "tables", "customers", "reservations", "notifications"], actions: ["view", "create", "edit"] },
  inventory_manager: { modules: ["dashboard", "warehouse", "notifications"], actions: ["view", "create", "edit", "export"] },
  finance: { modules: ["dashboard", "report", "finance", "notifications"], actions: ["view", "export"] },
  crm: { modules: ["dashboard", "customers", "feedback", "notifications"], actions: ["view", "create", "edit", "export", "discount"] },
  hr: { modules: ["dashboard", "staff", "roles", "notifications"], actions: ["view", "create", "edit"] },
  delivery_manager: { modules: ["dashboard", "orders", "courier", "delivery", "delivery-settings", "notifications"], actions: ["view", "create", "edit"] },
  // Mirrors ROLE_TEMPLATES.courier in admin-frontend/public/js/admin.js exactly —
  // was missing here, which silently 403'd every courier.js call into
  // /api/delivery/* (status updates, reject, own-status toggle).
  courier: { modules: ["courier", "delivery"], actions: ["view", "edit"] },
};

function broadcastFlatActionsToModules(flatActions, modules) {
  const result = {};
  (modules || []).forEach(moduleId => {
    result[moduleId] = Array.isArray(flatActions) ? [...flatActions] : [];
  });
  return result;
}

function unionModuleActions(base, extra) {
  const result = {};
  const allModuleIds = new Set([...Object.keys(base || {}), ...Object.keys(extra || {})]);
  allModuleIds.forEach(moduleId => {
    const baseArr = (base && base[moduleId]) || [];
    const extraArr = (extra && extra[moduleId]) || [];
    result[moduleId] = Array.from(new Set([...baseArr, ...extraArr]));
  });
  return result;
}

/** Mirrors resolveRoleConfig() in admin.js — same precedence: customRoles > ROLE_TEMPLATES(+roleOverrides). */
function resolveRoleConfig(role, customRoles, roleOverrides) {
  const custom = (customRoles || {})[role];
  if (custom) {
    const modules = Array.isArray(custom.modules) ? custom.modules : [];
    const actions = Array.isArray(custom.actions)
      ? broadcastFlatActionsToModules(custom.actions, modules)
      : (custom.actions && typeof custom.actions === "object" ? custom.actions : {});
    return { modules, actions };
  }

  const tpl = ROLE_TEMPLATES[role];
  if (!tpl) return { modules: [], actions: {} };

  const tplModuleActions = broadcastFlatActionsToModules(tpl.actions, tpl.modules);
  const extra = (roleOverrides || {})[role];
  if (!extra) return { modules: tpl.modules, actions: tplModuleActions };

  const mergedModules = Array.from(new Set([...(tpl.modules || []), ...(extra.modules || [])]));
  const extraModuleActions = Array.isArray(extra.actions)
    ? broadcastFlatActionsToModules(extra.actions, extra.modules || mergedModules)
    : (extra.actions && typeof extra.actions === "object" ? extra.actions : {});

  return { modules: mergedModules, actions: unionModuleActions(tplModuleActions, extraModuleActions) };
}

async function resolveRequestPermissionsFromPg(restId, userId) {
  const { rows: restRows } = await getPool().query(
    `SELECT id FROM restaurants WHERE legacy_rtdb_id = $1 LIMIT 1`,
    [restId]
  );
  if (!restRows[0]) return null;
  return withTenantContext(restRows[0].id, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM employees WHERE restaurant_id = $1 AND legacy_rtdb_id = $2 LIMIT 1`,
      [restRows[0].id, userId]
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
      client.query(`SELECT name, modules, actions FROM custom_roles WHERE restaurant_id = $1`, [restRows[0].id]),
      client.query(`SELECT base_role, modules, actions FROM role_overrides WHERE restaurant_id = $1`, [restRows[0].id]),
    ]);
    const customRoles = {};
    for (const r of custom.rows) {
      if (r.name) customRoles[r.name] = { modules: r.modules, actions: r.actions };
    }
    const roleOverrides = {};
    for (const r of overrides.rows) {
      if (r.base_role) roleOverrides[r.base_role] = { modules: r.modules, actions: r.actions };
    }
    const cfg = resolveRoleConfig(role, customRoles, roleOverrides);
    return { role, modules: cfg.modules, actions: cfg.actions };
  }, { actingRole: "owner" });
}

/** Resolves the acting user's permission config from PostgreSQL when DATA_BACKEND=postgres, otherwise Firebase. Returns null if the user can't be identified. */
export async function resolveRequestPermissions(restId, userId) {
  if (!restId || !userId) return null;
  // See security/sanitize.js — restId/userId become Firebase RTDB path
  // segments a few lines below; rejecting anything that isn't a safe single
  // segment here means every caller of this function (every requirePermission()
  // gated route, plus routes/delivery.js and routes/twoFactor.js which call
  // it directly) gets this protection for free, with no per-route changes.
  if (!isSafeId(String(restId)) || !isSafeId(String(userId))) return null;

  if (usePostgres()) {
    return resolveRequestPermissionsFromPg(restId, userId);
  }

  const userSnap = await systemGet(`restaurants/${restId}/users/${userId}`);
  if (!userSnap.exists()) return null;

  const user = userSnap.val();
  const role = user.role || "waiter";

  // "admin" mirrors "owner" (fully unrestricted) UNLESS the record is a
  // temporary/restricted sub-admin — this is not a new rule, it's the exact
  // same distinction the client already makes in admin.js:
  //   admin.js:3796  window._isSuperAdmin = role === "admin" || role === "superadmin"
  //   admin.js:8401  role === "admin" && isSubAdmin !== true  → real founder, cannot be deleted
  //   admin.js:24214 isSuperAdmin = role === "admin" && isSubAdmin !== true
  // A sub-admin (isSubAdmin === true) is deliberately NOT special-cased here —
  // per admin.js:24238-24242, module access for every role (including a
  // temp sub-admin) already flows through the same ROLE_TEMPLATES/customRoles/
  // roleOverrides resolver below, so it falls through unchanged.
  if (role === "owner" || (role === "admin" && user.isSubAdmin !== true)) {
    return { role, modules: null, actions: null }; // unrestricted, like the client
  }

  const [customSnap, overridesSnap] = await Promise.all([
    systemGet(`restaurants/${restId}/customRoles`),
    systemGet(`restaurants/${restId}/roleOverrides`),
  ]);

  const cfg = resolveRoleConfig(role, customSnap.val() || {}, overridesSnap.val() || {});
  return { role, modules: cfg.modules, actions: cfg.actions };
}

/** Tenant routes require a verified, explicitly tenant-scoped claim. */
export function tenantAuthorityDecision(identity, requestedRestId) {
  if (!identity?.verified) return { status: 401 };
  if (!identity.restId || identity.restId !== requestedRestId) return { status: 403 };
  return { restId: identity.restId };
}

/**
 * Express middleware factory: requirePermission("staff", "create").
 * Denies with 403 Access Denied unless the requesting user's role grants
 * the given action for the given module. Identity comes exclusively from
 * resolveIdentity() — a verified Authorization: Bearer <firebase-id-token>
 * is now REQUIRED (Production Security Fix Pass — P0-1, see
 * PRODUCTION-AUDIT.md). The `x-user-id`/`x-rest-id` headers this file used
 * to fall back to as an unverified identity source were proven live-
 * exploitable: any caller could impersonate any restaurant's admin by
 * simply setting those two headers, with no password or token at all. They
 * are never treated as authentication or authorization evidence anywhere
 * in this function — `getRestId(req)` (which several callers still derive
 * from x-rest-id) is only ever used as "which resource is being requested",
 * cross-checked below against the VERIFIED identity's own restId claim.
 *
 * On success, the verified identity is attached to req.nestaAuth
 * ({ userId, restId, role, verified: true }) so downstream route handlers
 * that need the acting user's id (e.g. "is this courier acting on their
 * own record?") can reuse this already-verified value instead of ever
 * reading req.headers["x-user-id"] themselves — see routes/delivery.js.
 */
export function requirePermission(moduleId, action, getRestId) {
  return async function (req, res, next) {
    try {
      const restId = getRestId(req);
      const identity = await resolveIdentity(req);

      if (!identity.verified) {
        logSecurityEvent({ type: "authz_denied", restId, userId: identity.userId || null, ip: req.ip, path: req.originalUrl, details: { reason: "unverified_identity", moduleId, action } });
        return res.status(401).json({ error: "Authentication required" });
      }

      const userId = identity.userId;
      if (!restId || !userId) {
        logSecurityEvent({ type: "authz_denied", restId, userId: userId || null, ip: req.ip, path: req.originalUrl, details: { reason: "missing_restId_or_userId", moduleId, action } });
        return res.status(403).json({ error: "Access Denied" });
      }

      // A verified token claiming a DIFFERENT restId than the one this
      // request is acting on is a stronger tell than "unresolved user" —
      // e.g. an employee of restaurant A presenting a valid session while
      // restId=B is in the request. Deny outright rather than falling
      // through to a lookup that would legitimately fail anyway.
      if (tenantAuthorityDecision(identity, restId).status === 403) {
        logSecurityEvent({ type: "authz_denied", restId, userId, ip: req.ip, path: req.originalUrl, details: { reason: "restId_missing_or_mismatch", moduleId, action, tokenRestId: identity.restId || null } });
        return res.status(403).json({ error: "Access Denied" });
      }

      const perms = await resolveRequestPermissions(restId, userId);
      if (!perms) {
        logSecurityEvent({ type: "authz_denied", restId, userId, ip: req.ip, path: req.originalUrl, details: { reason: "unresolved_user", moduleId, action } });
        return res.status(403).json({ error: "Access Denied" });
      }

      req.nestaAuth = { userId, restId, role: perms.role, verified: true };

      if (perms.modules === null) return next(); // owner — unrestricted

      const allowedModules = perms.modules || [];
      const allowedActions = (perms.actions && perms.actions[moduleId]) || [];
      if (!allowedModules.includes(moduleId) || !allowedActions.includes(action)) {
        logSecurityEvent({ type: "authz_denied", restId, userId, ip: req.ip, path: req.originalUrl, details: { reason: "insufficient_permission", moduleId, action, role: perms.role } });
        return res.status(403).json({ error: "Access Denied" });
      }

      next();
    } catch (err) {
      const code = String(err?.code || "");
      if (["08000", "08001", "08003", "08004", "08006", "08007", "08P01", "40001", "40P01", "53300", "53400", "55000", "57P01", "57P02", "57P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) {
        return res.status(503).json({ error: "PG_UNAVAILABLE" });
      }
      res.status(500).json({ error: "Internal error" });
    }
  };
}
