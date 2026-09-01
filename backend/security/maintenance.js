// Cutover maintenance mode. Server-enforced tenant write freeze.
// Enable with NESTA_MAINTENANCE_MODE=1 (or true/yes/on). Never inferred from
// the request. Login and health stay up; tenant mutations and payment
// webhooks do not silently succeed.

export const MAINTENANCE_CODE = "MAINTENANCE";

export function isMaintenanceMode(env = process.env) {
  const v = String(env.NESTA_MAINTENANCE_MODE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function requestPath(req) {
  return String(req.originalUrl || req.url || req.path || "").split("?")[0];
}

const SAFE_GET = true;

const AUTH_ALLOW = new Set([
  "/api/auth/staff-login",
  "/api/auth/manager-login",
  "/api/auth/test",
]);

const QR_ALLOW = new Set([
  "/api/qr/session",
  "/api/qr/sign",
  "/api/qr/verify",
]);

const PG_READ_POST = new Set([
  "/api/pg/rtdb/get",
]);

export function isPaymentWebhookPath(pathname) {
  return (
    pathname === "/api/click/webhook"
    || pathname === "/api/payme/webhook"
    || pathname === "/api/uzum/webhook"
  );
}

export function isMaintenanceAllowed(method, pathname) {
  const m = String(method || "GET").toUpperCase();
  const p = String(pathname || "");
  if (m === "OPTIONS" || m === "HEAD") return true;
  if (p === "/api/health" || p === "/api/deployment" || p === "/api/pg/health" || p === "/api/pg/meta") return true;
  if (p.startsWith("/api/public")) return true;
  if (m === "GET" || m === "HEAD") {
    if (p.startsWith("/api/auth/login-as") || p.startsWith("/api/auth/staff-view-as")) return false;
    return SAFE_GET;
  }
  if (AUTH_ALLOW.has(p)) return true;
  if (QR_ALLOW.has(p) && m === "GET") return true;
  if (p === "/api/qr/session" && m === "POST") return true;
  if (PG_READ_POST.has(p) && m === "POST") return true;
  return false;
}

export function maintenanceBody() {
  return {
    error: MAINTENANCE_CODE,
    code: MAINTENANCE_CODE,
    retryable: true,
    retry_guaranteed: false,
    message: "Service is in cutover maintenance. Tenant writes are paused.",
  };
}

export function clickMaintenanceBody() {
  return {
    error: -7,
    error_note: "MAINTENANCE",
    retryable: true,
    retry_guaranteed: false,
    code: MAINTENANCE_CODE,
  };
}

export function paymeMaintenanceBody(id = null) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32400, message: "MAINTENANCE" },
    retryable: true,
    retry_guaranteed: false,
    code: MAINTENANCE_CODE,
  };
}

export function uzumMaintenanceBody() {
  return {
    error: MAINTENANCE_CODE,
    code: MAINTENANCE_CODE,
    retryable: true,
    retry_guaranteed: false,
  };
}

export function sendMaintenance(req, res) {
  const pathname = requestPath(req);
  res.setHeader("Retry-After", "120");
  if (pathname === "/api/click/webhook") {
    return res.status(503).json(clickMaintenanceBody());
  }
  if (pathname === "/api/payme/webhook") {
    return res.status(503).json(paymeMaintenanceBody(req.body?.id ?? null));
  }
  if (pathname === "/api/uzum/webhook") {
    return res.status(503).json(uzumMaintenanceBody());
  }
  return res.status(503).json(maintenanceBody());
}

export function maintenanceMiddleware(req, res, next) {
  if (!isMaintenanceMode()) return next();
  const pathname = requestPath(req);
  if (isPaymentWebhookPath(pathname)) return sendMaintenance(req, res);
  if (isMaintenanceAllowed(req.method, pathname)) return next();
  return sendMaintenance(req, res);
}
