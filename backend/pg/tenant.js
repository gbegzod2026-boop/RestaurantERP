// pg/tenant.js — resolve Firebase restId → PostgreSQL restaurants.id
// and attach a verified tenant context to the request.
//
// Client-supplied restaurant_id is NEVER trusted on its own. The verified
// Firebase ID token's restId claim is the source of tenant identity.
import { isSafeId } from "../security/sanitize.js";
import { resolveIdentity } from "../rbac.js";
import { getPool, withTenantContext, withPlatformContext } from "../db/postgres.js";
import { logSecurityEvent } from "../security/auditLog.js";

const _cache = new Map(); // legacy_rtdb_id → { id, legacy_rtdb_id, domain, name, ts }
const CACHE_MS = 60_000;

export async function lookupRestaurantByLegacyId(legacyId) {
  if (!legacyId) return null;
  const cached = _cache.get(legacyId);
  if (cached && Date.now() - cached.ts < CACHE_MS) return cached.row;
  const { rows } = await getPool().query(
    `SELECT id, legacy_rtdb_id, domain, name FROM restaurants WHERE legacy_rtdb_id = $1 LIMIT 1`,
    [legacyId]
  );
  const row = rows[0] || null;
  if (row) _cache.set(legacyId, { row, ts: Date.now() });
  return row;
}

export function requestedRestId(req) {
  const raw =
    req.pgRestId ||
    req.query.restId ||
    req.body?.restId ||
    req.headers["x-rest-id"] ||
    null;
  return raw && isSafeId(String(raw)) ? String(raw) : null;
}

/**
 * Middleware: verified Bearer token required. Tenant is the token's restId
 * unless the caller is superadmin acting on an explicitly requested restaurant.
 * Attaches req.pgTenant = { userId, restId, role, restaurantUuid, isSuperAdmin, actingRole }.
 */
export function isPgUnavailableError(err) {
  return new Set([
    "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
    "57P01", "57P02", "57P03", "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  ]).has(String(err?.code || ""));
}

export function tenantScopeDecision(identity, requested) {
  if (!identity?.verified) return { status: 401, error: "Authentication required" };
  const restId = identity.restId || null;
  if (requested && restId && requested !== restId) return { status: 403, error: "Access Denied" };
  if (!restId) return { status: 403, error: "Access Denied" };
  return { restId };
}

export function requirePgTenant() {
  return async function (req, res, next) {
    try {
      const identity = await resolveIdentity(req);
      if (!identity.verified) {
        const tokenError = String(identity.tokenError || "");
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
        logSecurityEvent({ type: "authz_denied", ip: req.ip, path: req.originalUrl, details: { reason: "unverified_identity" } });
        return res.status(401).json({ error: "Authentication required" });
      }

      const restId = identity.restId || null;
      const requested = requestedRestId(req);
      const scope = tenantScopeDecision(identity, requested);

      if (scope.status === 403 && requested && restId && requested !== restId) {
        logSecurityEvent({
          type: "authz_denied", restId: requested, userId: identity.userId, ip: req.ip,
          path: req.originalUrl, details: { reason: "restId_mismatch", tokenRestId: restId },
        });
        return res.status(403).json({ error: "Access Denied" });
      }
      if (scope.status === 403 && !restId) {
        logSecurityEvent({
          type: "authz_denied", restId: requested, userId: identity.userId, ip: req.ip,
          path: req.originalUrl, details: { reason: "token_missing_restId" },
        });
        return res.status(403).json({ error: "Access Denied" });
      }

      const restaurant = await lookupRestaurantByLegacyId(restId);
      if (!restaurant) return res.status(404).json({ error: "Restaurant not found" });

      req.nestaAuth = {
        userId: identity.userId,
        restId,
        role: identity.role || null,
        verified: true,
        isSuperAdmin: false,
      };
      req.pgTenant = {
        userId: identity.userId,
        restId,
        role: identity.role || null,
        restaurantUuid: restaurant.id,
        restaurant,
        isSuperAdmin: false,
        actingRole: identity.role || null,
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

export async function withRequestTenant(req, fn) {
  const t = req.pgTenant;
  if (!t) throw new Error("withRequestTenant requires requirePgTenant() first");
  return withTenantContext(t.restaurantUuid, fn, { actingRole: t.actingRole });
}

export { withTenantContext, withPlatformContext };
