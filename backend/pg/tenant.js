// pg/tenant.js — resolve Firebase restId → PostgreSQL restaurants.id
// and attach a verified tenant context to the request.
//
// Client-supplied restaurant_id is NEVER trusted on its own. The verified
// Firebase ID token's restId claim (canonicalized from composite UIDs) is
// the source of tenant identity. Platform superadmin is the canonical
// verifier only — never inferred from missing tenant scope or isSuperAdmin.
import { isSafeId } from "../security/sanitize.js";
import { resolveIdentity } from "../rbac.js";
import { getPool, withTenantContext, withPlatformContext } from "../db/postgres.js";
import { logSecurityEvent } from "../security/auditLog.js";
import { canonicalizeRestId, parseRestId, resolveActingRestId, resolveRequestRestId } from "./restId.js";

const _cache = new Map(); // legacy_rtdb_id → { id, legacy_rtdb_id, domain, name, ts }
const CACHE_MS = 60_000;

export async function lookupRestaurantByLegacyId(legacyId) {
  if (!legacyId) return null;
  const canonical = canonicalizeRestId(legacyId);
  if (!canonical) return null;
  const cached = _cache.get(canonical);
  if (cached && Date.now() - cached.ts < CACHE_MS) return cached.row;
  const { rows } = await getPool().query(
    `SELECT id, legacy_rtdb_id, domain, name FROM restaurants WHERE legacy_rtdb_id = $1 LIMIT 1`,
    [canonical]
  );
  const row = rows[0] || null;
  if (row) _cache.set(canonical, { row, ts: Date.now() });
  return row;
}

export function requestedRestId(req) {
  const resolved = resolveRequestRestId(req);
  if (!resolved.ok || resolved.empty) return null;
  return isSafeId(resolved.restId) ? resolved.restId : null;
}

export { resolveRequestRestId, parseRestId };

function authzBody(status, code, error) {
  return { status, error, code };
}

export function isPgUnavailableError(err) {
  return new Set([
    "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
    "57P01", "57P02", "57P03", "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  ]).has(String(err?.code || ""));
}

export function isRlsDeniedError(err) {
  return String(err?.code || "") === "42501";
}

/**
 * Decide tenant scope from a server-resolved identity.
 * identity.platformSuperAdmin must already be the canonical verifier result.
 */
export function tenantScopeDecision(identity, requested) {
  if (!identity?.verified) {
    const missing = String(identity?.tokenError || "") === "token_missing";
    return authzBody(401, missing ? "token_missing" : "token_invalid", "Authentication required");
  }

  if (requested != null && requested !== "") {
    const parsed = parseRestId(requested);
    if (!parsed.ok) return authzBody(400, "restId_invalid", "Invalid restaurant id");
  }
  const requestedCanonical = canonicalizeRestId(requested);
  if (identity.platformSuperAdmin === true) {
    if (!requestedCanonical) return authzBody(403, "token_missing_restId", "Access Denied");
    return { restId: requestedCanonical, isSuperAdmin: true };
  }

  const restId = resolveActingRestId({
    tokenRestId: identity.restId,
    uid: identity.uid || identity.userId,
    platformSuperAdmin: false,
  });
  const requestedId = requestedCanonical;

  if (requestedId && restId && requestedId !== restId) {
    return authzBody(403, "restId_mismatch", "Access Denied");
  }
  if (!restId) return authzBody(403, "token_missing_restId", "Access Denied");
  return { restId };
}

export function createRequirePgTenant({
  resolveIdentityFn = resolveIdentity,
  lookupRestaurantFn = lookupRestaurantByLegacyId,
} = {}) {
  return async function (req, res, next) {
    try {
      const identity = await resolveIdentityFn(req);
      if (!identity.verified) {
        const tokenError = String(identity.tokenError || "");
        const code = tokenError === "token_missing" ? "token_missing" : "token_invalid";
        console.warn("[PG-AUTH]", {
          requestId: req.headers["x-request-id"] || "-",
          route: req.originalUrl,
          authenticated: false,
          tokenValid: false,
          tokenExpired: /expired/i.test(tokenError),
          userId: null,
          restaurantId: requestedRestId(req),
          role: null,
        });
        logSecurityEvent({ type: "authz_denied", ip: req.ip, path: req.originalUrl, details: { reason: "unverified_identity", code } });
        return res.status(401).json({ error: "Authentication required", code });
      }

      const requestedDecision = resolveRequestRestId(req);
      if (!requestedDecision.ok) {
        logSecurityEvent({
          type: "authz_denied", userId: identity.userId, ip: req.ip,
          path: req.originalUrl, details: { reason: requestedDecision.code, code: requestedDecision.code },
        });
        return res.status(requestedDecision.status).json({
          error: requestedDecision.code === "restId_conflict" ? "Conflicting restaurant id" : "Invalid restaurant id",
          code: requestedDecision.code,
        });
      }
      const requested = requestedDecision.restId;
      const scope = tenantScopeDecision(identity, requested);

      if (scope.status === 400) {
        return res.status(400).json({ error: scope.error, code: scope.code });
      }
      if (scope.status === 401) {
        return res.status(401).json({ error: scope.error, code: scope.code });
      }
      if (scope.status === 403 && scope.code === "restId_mismatch") {
        logSecurityEvent({
          type: "authz_denied", restId: requested, userId: identity.userId, ip: req.ip,
          path: req.originalUrl, details: { reason: "restId_mismatch", tokenRestId: identity.restId, code: "restId_mismatch" },
        });
        return res.status(403).json({ error: "Access Denied", code: "restId_mismatch" });
      }
      if (scope.status === 403) {
        logSecurityEvent({
          type: "authz_denied", restId: requested, userId: identity.userId, ip: req.ip,
          path: req.originalUrl, details: { reason: scope.code || "token_missing_restId", code: scope.code },
        });
        return res.status(403).json({ error: "Access Denied", code: scope.code || "token_missing_restId" });
      }

      const restId = scope.restId;
      const restaurant = await lookupRestaurantFn(restId);
      if (!restaurant) return res.status(404).json({ error: "Restaurant not found", code: "not_found" });

      const isSuperAdmin = scope.isSuperAdmin === true;
      const isCustomer = identity.isCustomer === true && isSuperAdmin !== true;
      req.nestaAuth = {
        userId: identity.userId,
        restId,
        role: identity.role || null,
        verified: true,
        isSuperAdmin,
        isCustomer,
        tokenType: identity.tokenType || null,
      };
      req.pgTenant = {
        userId: identity.userId,
        restId,
        role: identity.role || null,
        restaurantUuid: restaurant.id,
        restaurant,
        isSuperAdmin,
        isCustomer,
        tokenType: identity.tokenType || null,
        table: isCustomer ? (identity.table || "") : "",
        tableId: isCustomer ? (identity.tableId || identity.table || "") : "",
        uid: identity.uid || identity.userId || null,
        customerSessionId: isCustomer ? String(identity.uid || identity.userId || "") : "",
        actingRole: isSuperAdmin ? "owner" : (isCustomer ? "customer" : (identity.role || null)),
      };
      next();
    } catch (err) {
      console.error("[pg/tenant] request failed", { code: err?.code || "UNKNOWN" });
      if (isPgUnavailableError(err)) {
        return res.status(503).json({ error: "PG_UNAVAILABLE" });
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

export function requirePgTenant() {
  return createRequirePgTenant();
}

export async function withRequestTenant(req, fn) {
  const t = req.pgTenant;
  if (!t) throw new Error("withRequestTenant requires requirePgTenant() first");
  return withTenantContext(t.restaurantUuid, fn, {
    actingRole: t.actingRole,
    customerUid: t.isCustomer ? (t.customerSessionId || t.userId || "") : "",
    customerTable: t.isCustomer ? (t.table || t.tableId || "") : "",
  });
}

export { withTenantContext, withPlatformContext, canonicalizeRestId, resolveActingRestId };
