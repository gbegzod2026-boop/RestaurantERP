// security/auditLog.js — audit trail (business actions) + security log
// (auth/permission events), stored in Firebase alongside everything else so
// no new infrastructure is required. Two separate trees, as requested:
//   restaurants/{restId}/auditLog/{id}   — who/when/module/action/what changed
//   systemData/securityLog/{id}          — auth failures, permission denials,
//                                          rate-limit hits, 2FA events (not
//                                          restaurant-scoped, since some of
//                                          these happen before restId is
//                                          trustworthy, e.g. a spoofed one)
// Best-effort/fire-and-forget by design: a logging failure must never break
// the request it's describing (same convention already used throughout this
// codebase for NotificationService.send() calls).
import { isDatabaseConnected } from "../db.js";
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so logAuditEvent()/getRecentAuditLog() also go
// through the admin-or-client fallback (systemDb.js), same reasoning as the
// systemData/securityLog write below.
import { systemPush, systemQueryOrderedLimit } from "../systemDb.js";

// P1-1 fix (PRODUCTION-AUDIT.md): this used to read req.headers["x-forwarded-for"]
// directly and unconditionally — spoofable by any direct caller, regardless
// of whether a real reverse proxy was actually in front of this app or not,
// since it never consulted Express's own trust-proxy decision at all. Now
// uses req.ip, which is the same value every rate limiter in
// security/rateLimit.js already keys on — respects the TRUST_PROXY setting
// (see server.js) when configured, and is the safe, unspoofable raw socket
// address when it isn't. This only changes what gets LOGGED (audit trail
// metadata) — it was never used for a rate-limit or authorization decision.
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export async function logAuditEvent({ restId, userId, userName, userRole, module, action, details }, req) {
  try {
    if (!isDatabaseConnected() || !restId) return;
    const entry = {
      userId: userId || null,
      userName: userName || "",
      userRole: userRole || "",
      module: module || "",
      action: action || "",
      details: details || null,
      ip: req ? clientIp(req) : null,
      userAgent: req?.headers?.["user-agent"] || null,
      createdAt: Date.now(),
    };
    await systemPush(`restaurants/${restId}/auditLog`, entry);
  } catch (err) {
    console.error("[AuditLog] write failed (non-fatal):", err.message);
  }
}

export async function logSecurityEvent({ type, restId, userId, ip, path, limiter, details }) {
  try {
    if (!isDatabaseConnected()) return;
    const entry = {
      type: type || "unknown",
      restId: restId || null,
      userId: userId || null,
      ip: ip || null,
      path: path || null,
      limiter: limiter || null,
      details: details || null,
      createdAt: Date.now(),
    };
    console.warn("[SecurityLog]", JSON.stringify(entry));
    // systemData/* is closed to every client by database.rules.json (Phase 1)
    // — systemPush() writes via the Admin SDK (bypasses rules) when
    // available, or the legacy client SDK otherwise. See systemDb.js.
    await systemPush("systemData/securityLog", entry);
  } catch (err) {
    console.error("[SecurityLog] write failed (non-fatal):", err.message);
  }
}

/** Express middleware: logs every permission DENY from requirePermission() as a security event. */
export function auditPermissionDenied(moduleId, action, getRestId) {
  return function (req, _res, next) {
    req._auditContext = { moduleId, action, restId: getRestId(req), userId: req.headers["x-user-id"] || null };
    next();
  };
}

export async function getRecentAuditLog(restId, limitCount = 200) {
  if (!isDatabaseConnected() || !restId) return [];
  const snap = await systemQueryOrderedLimit(`restaurants/${restId}/auditLog`, "createdAt", limitCount);
  const data = snap.val() || {};
  return Object.entries(data)
    .map(([id, entry]) => ({ _id: id, ...entry }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
