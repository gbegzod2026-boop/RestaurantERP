// security/requireSuperAdmin.js — shared authorization middleware for the
// new Superadmin systemData-migration routers (Stage 2: active sessions,
// 2FA, promo codes/broadcast, settings). Identical check to the one already
// inlined in routes/superadminCredentials.js and routes/
// superadminDashboard.js — extracted here ONLY for these new files to share
// (those two existing files are left exactly as they are, per "don't
// arbitrarily change existing endpoints" — this is purely additive).
//
// A verified Firebase ID token (Admin SDK verifyIdToken) that carries NO
// restId claim and isn't an anonymous session. Per database.rules.json's
// header comment, that is the one signal this app already uses everywhere
// to tell a superadmin/platform-level session apart from a restaurant
// employee/QR-customer one (which always carries a restId claim). A
// request with no token, an invalid token, a token WITH a restId claim
// (any restaurant's own owner/admin/staff), or an anonymous session is
// rejected — matching every other superadmin-only route in this app.
import { isAdminAvailable, getAdminAuth } from "../firebaseAdmin.js";
import { logSecurityEvent } from "./auditLog.js";

function bootstrapUids() {
  return new Set(String(process.env.PLATFORM_SUPERADMIN_UIDS || "")
    .split(",")
    .map((uid) => uid.trim())
    .filter(Boolean));
}

export function isCanonicalPlatformSuperAdmin(decoded) {
  if (!decoded?.uid) return false;
  if (decoded.restId != null || decoded.restaurantId != null) return false;
  return decoded.platformSuperAdmin === true || bootstrapUids().has(decoded.uid);
}

export async function verifyPlatformSuperAdminToken(idToken) {
  const decoded = await getAdminAuth().verifyIdToken(idToken);
  return { decoded, authorized: isCanonicalPlatformSuperAdmin(decoded) };
}

export async function requireSuperAdmin(req, res, next) {
  if (!isAdminAvailable()) return res.status(503).json({ error: "Feature unavailable" });
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ") || !authHeader.slice(7).trim()) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { decoded, authorized } = await verifyPlatformSuperAdminToken(authHeader.slice(7).trim());
    if (!authorized) {
      logSecurityEvent({
        type: "platform_superadmin_denied", ip: req.ip, path: req.originalUrl,
        details: { uid: decoded.uid, reason: "canonical_authority_required" },
      });
      return res.status(403).json({ error: "Forbidden" });
    }
    req.superAdminUid = decoded.uid;
    req.superAdminEmail = decoded.email || null;
    req.platformSuperAdmin = true;
    return next();
  } catch (_err) {
    logSecurityEvent({ type: "platform_superadmin_denied", ip: req.ip, path: req.originalUrl, details: { reason: "invalid_token" } });
    return res.status(401).json({ error: "Unauthorized" });
  }
}
