// security/rateLimit.js — brute-force / abuse protection via express-rate-limit.
// Limits are per (IP + restId) where a restId is available, so one noisy
// restaurant can't exhaust another's quota, and per-IP alone for routes that
// run before a restId is known (webhooks, 2FA verify). All limiters fail
// "open enough" to never block legitimate single-user traffic — thresholds
// are generous multiples of realistic human/UI request rates.
import rateLimit from "express-rate-limit";
import { logSecurityEvent } from "./auditLog.js";

function keyGenerator(req) {
  const restId = req.query.restId || req.body?.restId || req.headers["x-rest-id"] || "";
  return `${req.ip}:${restId}`;
}

function makeLimiter({ windowMs, max, name, byRestId = true }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: byRestId ? keyGenerator : (req) => req.ip,
    handler: (req, res) => {
      logSecurityEvent({
        type: "rate_limit_exceeded",
        limiter: name,
        ip: req.ip,
        path: req.originalUrl,
        restId: req.query.restId || req.body?.restId || req.headers["x-rest-id"] || null,
        userId: req.headers["x-user-id"] || null,
      });
      res.status(429).json({ error: "Too many requests, please try again later." });
    },
  });
}

// Login/PIN attempts — mounted on /api/auth (routes/auth.js) since the
// Production Security Fix Pass moved credential verification server-side;
// this is now the actual brute-force surface for staff PINs/passwords.
export const authLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 20, name: "auth" });
export const twoFactorLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 10, name: "2fa", byRestId: false });

// Superadmin restaurant-credential endpoints (status/reveal/set) — restId
// here is a URL path param, not query/body/x-rest-id, so the default
// keyGenerator can't see it and would silently collapse to one shared
// per-IP bucket across EVERY restaurant's credential calls combined (this
// is exactly what caused 429s during normal use: one superadmin browsing
// several restaurants' credential modals in a session easily exceeds
// authLimiter's 20/15min ceiling once it's no longer split by restId).
// byRestId: false makes that explicit rather than accidental, and the
// ceiling is sized for realistic superadmin browsing (opening many
// restaurants' modals, a few reveals/rotations) while still bounding
// abuse — this endpoint is already gated by requireSuperAdmin()'s strict
// authorization, so it isn't the same open brute-force surface authLimiter
// exists for.
export const superadminCredentialsLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 100, name: "superadmin_credentials", byRestId: false });

// Payment webhooks — Click/Payme/Uzum retry on failure, but real traffic
// never approaches this; generous ceiling mainly stops signature-guessing.
export const paymentLimiter = makeLimiter({ windowMs: 60 * 1000, max: 60, name: "payment", byRestId: false });

// AI Import — Gemini calls cost tokens/money; cap per restaurant.
export const aiImportLimiter = makeLimiter({ windowMs: 60 * 1000, max: 15, name: "ai_import" });

// Notification test/trigger + Telegram test-connection.
export const notificationLimiter = makeLimiter({ windowMs: 60 * 1000, max: 30, name: "notifications" });

// Delivery status/assign mutations.
export const deliveryLimiter = makeLimiter({ windowMs: 60 * 1000, max: 60, name: "delivery" });

// General API safety net — applied app-wide, well above any legitimate UI's
// call volume (dashboards poll, but not at this rate).
export const globalApiLimiter = makeLimiter({ windowMs: 60 * 1000, max: 300, name: "global", byRestId: false });

// PostgreSQL RTDB bridge — every onValue/get/set is an HTTP call. One client
// page plus staff tabs easily exceeds the 300/min global /api ceiling.
// Isolated from login/payment limiters; keyed by IP+restId so one tenant
// cannot exhaust another. Does not change auth, RLS, or RBAC.
export const pgRtdbLimiter = makeLimiter({ windowMs: 60 * 1000, max: 2000, name: "pg_rtdb" });

// Superadmin dashboard's systemData-regression-fix endpoints
// (routes/superadminDashboard.js: health/payment-history/audit-log/
// login-history/restaurants) — same generous, not-restId-scoped ceiling as
// superadminCredentialsLimiter above, for the same reason (already gated by
// requireSuperAdmin's strict authorization; this just bounds abuse of an
// authenticated surface, not a brute-force one).
//
// 429-storm fix, wiring half: this used to be the ONE limiter INSTANCE
// server.js passed to all five superadmin route families (dashboard/
// sessions/2fa/marketing/settings). express-rate-limit keeps its counter
// per instance, so five mounts sharing one instance meant all five shared
// one combined 200/15min budget instead of 200/15min each — confirmed
// live: even with the polling-side dedup fix (superadmin.js's
// _saGenericPoll, no more literal duplicate pollers), the legitimate
// combined poll rate across ~10-13 distinct resources spanning all five
// families still exceeded 200/15min on its own. Split into five
// independent instances below, each keeping the exact same policy (15min
// window, 200 requests, per-IP) — restoring the isolation this comment
// already described as the intent, not a larger allowance: same ceiling,
// per feature family, instead of one ceiling shared by all of them.
export const superadminDashboardLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 200, name: "superadmin_dashboard", byRestId: false });
export const superadminSessionsLimiter  = makeLimiter({ windowMs: 15 * 60 * 1000, max: 200, name: "superadmin_sessions",  byRestId: false });
export const superadmin2faLimiter       = makeLimiter({ windowMs: 15 * 60 * 1000, max: 200, name: "superadmin_2fa",       byRestId: false });
export const superadminMarketingLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 200, name: "superadmin_marketing", byRestId: false });
export const superadminSettingsLimiter  = makeLimiter({ windowMs: 15 * 60 * 1000, max: 200, name: "superadmin_settings",  byRestId: false });
// SuperAdmin Telegram bot settings/test-message endpoints (routes/
// superadminBot.js) — its OWN family/limiter, same policy as the five
// above, per that same 429-storm lesson (never let a new router silently
// share another family's counter).
export const superadminBotLimiter        = makeLimiter({ windowMs: 15 * 60 * 1000, max: 200, name: "superadmin_bot",       byRestId: false });

// Landing page's public aggregate-stats endpoint (routes/publicStats.js) —
// unauthenticated by design, no restId to key on, so per-IP only. The
// route's own 5-minute server-side cache already absorbs most real traffic;
// this just bounds scripted/scraping abuse of the one endpoint that
// deliberately requires no session at all. Generous relative to the
// landing page's own 60s poll interval.
export const publicStatsLimiter = makeLimiter({ windowMs: 60 * 1000, max: 30, name: "public_stats", byRestId: false });
