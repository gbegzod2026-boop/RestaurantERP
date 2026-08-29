// server.js — Firebase Realtime Database backend
import dotenv from "dotenv";
import os from "os";
import cors from "cors";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import {
  connectDB, getDatabaseState, isDatabaseConnected,
} from "./db.js";
// Architecture Fix Pass: database.rules.json now requires `auth != null` on
// restaurants/$restId, so every read/write this file makes there goes
// through these admin-or-client helpers (systemDb.js) instead of the plain
// client SDK directly — otherwise this backend's own unauthenticated
// connection would be rejected by the very rules it's serving. See
// systemDb.js's header for the fallback behavior when no service account
// is configured yet (unchanged from before this fix).
import { systemGet, systemSet, systemUpdate, systemPush, systemQueryOrderedLimit, systemRemove } from "./systemDb.js";
import clickRouter from "./routes/click.js";
import paymeRouter from "./routes/payme.js";
import uzumRouter from "./routes/uzum.js";
import paymentsInitRouter from "./routes/paymentsInit.js";
import deliveryRouter from "./routes/delivery.js";
import notificationsRouter from "./routes/notifications.js";
import aiImportRouter from "./routes/aiImport.js";
import twoFactorRouter from "./routes/twoFactor.js";
import authRouter from "./routes/auth.js";
import qrRouter from "./routes/qr.js";
import clientOrdersRouter from "./routes/clientOrders.js";
import superadminCredentialsRouter from "./routes/superadminCredentials.js";
import publicStatsRouter from "./routes/publicStats.js";
import publicFirebaseConfigRouter from "./routes/publicFirebaseConfig.js";
import superadminDashboardRouter from "./routes/superadminDashboard.js";
import superadminSessionsRouter from "./routes/superadminSessions.js";
import superadmin2faRouter from "./routes/superadmin2fa.js";
import superadminMarketingRouter from "./routes/superadminMarketing.js";
import superadminSettingsRouter from "./routes/superadminSettings.js";
import superadminBotRouter from "./routes/superadminBot.js";
import restaurantConfigRouter from "./routes/restaurantConfig.js";
import discountClaimsRouter from "./routes/discountClaims.js";
import pgApiRouter from "./routes/pgApi.js";
import { attachIo } from "./pg/hub.js";
import { attachPgRealtime } from "./pg/socket.js";
import { authorizeSocketJoin } from "./pg/rbacPg.js";
import {
  authorizeLegacyClientConnect,
  authorizeLegacyStaffConnect,
  leaveOperationalRooms,
  joinOperationalRooms,
  rememberLegacyStaff,
  revalidateLegacyStaffAuthority,
  authorizeLegacyPrivilegedEmit,
  staffRoomsForConnect,
  CHEF_CONNECT_ROLES,
  ADMIN_CONNECT_ROLES,
  LEGACY_STAFF_RECHECK_MS,
} from "./pg/legacySocketPolicy.js";
import { assertQrSigningConfigured, qrSigningHealth } from "./security/qrSign.js";
import { getDataBackend, usePostgres } from "./pg/config.js";
import { assertIsolatedAuthEnvironment, authEnvironmentDiagnostic, logAuthEnvironment } from "./firebaseEnv.js";
import { isPgAvailable, maskedConfig, withTenantContext } from "./db/postgres.js";
import { isPgUnavailableError, lookupRestaurantByLegacyId } from "./pg/tenant.js";
import { broadcastAll } from "./pg/hub.js";
import * as pgOrders from "./pg/ordersService.js";
import * as pgCatalog from "./pg/catalogService.js";
import { assertPinAvailable, upsertEmployeeCredential } from "./pg/credentialService.js";
import { pushId } from "./pg/pushId.js";
import { requirePermission, resolveIdentity, resolveRequestPermissions } from "./rbac.js";
import { classifyStaffMutationFailure, createStaffMutationAuthority } from "./staffMutationAuthority.js";
import { preparePgStaffCreate, preparePgStaffPatch } from "./staffPayload.js";
import { hashPassword, verifyPassword } from "./security/password.js";
import { encryptSecret, decryptSecret } from "./security/crypto.js";
import { attachSocketIO } from "./delivery/engine.js";
import { startScheduler } from "./notifications/scheduler.js";
import { startDbMonitor } from "./notifications/dbMonitor.js";
import { startPolling as startTelegramBotPolling } from "./notifications/TelegramBotService.js";
import { startPolling as startSuperAdminBotPolling } from "./notifications/SuperAdminBotService.js";
import { NotificationService } from "./notifications/NotificationService.js";
import { NOTIFICATION_TYPES } from "./notifications/types.js";
import { applySecurityHeaders, buildCorsOptions } from "./security/headers.js";
import {
  globalApiLimiter, pgRtdbLimiter, authLimiter, twoFactorLimiter, paymentLimiter,
  notificationLimiter, deliveryLimiter,
  superadminCredentialsLimiter, publicStatsLimiter, superadminDashboardLimiter,
  superadminSessionsLimiter, superadmin2faLimiter, superadminMarketingLimiter,
  superadminSettingsLimiter, superadminBotLimiter,
} from "./security/rateLimit.js";
import { isSafeId } from "./security/sanitize.js";
import { logAuditEvent, logSecurityEvent } from "./security/auditLog.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Express + Socket.IO ──────────────────────────────────────────────────────
const app    = express();

// P1-1 fix (PRODUCTION-AUDIT.md): `req.ip` (used by every rate limiter in
// security/rateLimit.js) and `req.ips`/X-Forwarded-For handling are NOT
// safe to make trust-proxy-aware by guessing a hop count — this repo has no
// nginx/Docker/PM2 config and no way to know its actual deployment
// topology. Guessing wrong in EITHER direction is actively dangerous:
//   - Enabling "trust proxy" when there is NO real reverse proxy in front
//     of this process makes req.ip read the client-supplied
//     X-Forwarded-For header directly — trivially spoofable, defeating
//     every IP-keyed rate limiter outright.
//   - Leaving it disabled when there IS a real reverse proxy (this app's
//     {domain}.nestacrm.uz subdomain-per-restaurant design, plus server.js
//     using plain http.createServer with no TLS of its own, strongly
//     suggests one exists in production for SSL termination + subdomain
//     routing — but that is circumstantial, not confirmed) makes req.ip
//     resolve to the proxy's own IP for every request, collapsing every
//     rate limiter into one shared bucket across all real users.
// Resolution: make it explicit and opt-in via TRUST_PROXY (documented in
// .env.example), defaulting to Express's own default (disabled — trust
// nothing, use the raw socket address) when unset, so nothing changes
// silently. Whoever deploys this and knows the real topology sets it once.
//   TRUST_PROXY unset            -> unchanged (safe if there is no proxy)
//   TRUST_PROXY=1  (or any int)  -> trust that many hops from the client
//   TRUST_PROXY=true             -> trust the nearest hop unconditionally
if (process.env.TRUST_PROXY) {
  const raw = process.env.TRUST_PROXY.trim();
  const asHops = Number(raw);
  app.set("trust proxy", Number.isFinite(asHops) && raw !== "" ? asHops : raw === "true");
  console.log(`[server] trust proxy enabled from TRUST_PROXY=${raw}`);
}

const server = http.createServer(app);
// P1-2 fix (PRODUCTION-AUDIT.md): Socket.IO has its own, separate CORS
// config from Express's `cors` middleware below — was independently set to
// `origin: true` (reflect any origin) with credentials:true, the same
// vulnerability class as the Express-side finding. buildCorsOptions()'s
// `origin` function has the exact shape the `cors` package (and Socket.IO,
// which uses the same convention) expects — (origin, callback) — so it's
// reused directly here instead of duplicating the allowlist logic.
const io     = new Server(server, {
  cors: { ...buildCorsOptions(), methods: ["GET","POST","PUT","PATCH","DELETE"] },
  transports: ["websocket", "polling"],
});

// ─── Security headers (Helmet: CSP/HSTS/X-Frame-Options/etc.) + CORS ────────
// Applied before every other middleware/route so nothing downstream can
// accidentally run without them. See security/headers.js for what each
// option does and why it's shaped this way for this app specifically.
applySecurityHeaders(app);
app.use(cors(buildCorsOptions()));
// AI Smart Import sends base64-encoded images/PDFs in the JSON body (~33%
// larger than the original file); the default 100kb express.json() limit
// would 413 on anything but a tiny receipt photo, so the global limit is
// raised to comfortably cover Settings → AI Smart Import's maxFileSizeMB
// (default 10MB) plus base64 overhead. Every other route's payloads are
// tiny by comparison, so this is a safe app-wide increase.
app.use(express.json({ limit: "20mb" }));

// ─── Rate limiting — brute-force / abuse protection (spec section 5) ────────
// A generous app-wide ceiling first, then tighter per-surface limits on the
// routes most worth protecting (payments, AI Import cost, notifications,
// delivery mutations, 2FA guessing). None of these can be hit by normal UI
// usage — see security/rateLimit.js for exact thresholds and rationale.
function apiPath(req) {
  const mounted = String(req.path || "");
  const original = String(req.originalUrl || "").split("?")[0];
  return { mounted, original };
}

function isPgApi(req) {
  const { mounted, original } = apiPath(req);
  return mounted === "/pg" || mounted.startsWith("/pg/")
    || original === "/api/pg" || original.startsWith("/api/pg/");
}

function pathPrefixed(req, mountPath) {
  const { mounted, original } = apiPath(req);
  return mounted === mountPath || mounted.startsWith(`${mountPath}/`)
    || original === `/api${mountPath}` || original.startsWith(`/api${mountPath}/`);
}

function isPaymentApi(req) {
  return pathPrefixed(req, "/click")
    || pathPrefixed(req, "/payme")
    || pathPrefixed(req, "/uzum")
    || pathPrefixed(req, "/payments");
}

function isDeliveryApi(req) {
  const { mounted, original } = apiPath(req);
  return mounted === "/delivery" || mounted.startsWith("/delivery/")
    || original === "/api/delivery" || original.startsWith("/api/delivery/");
}

function isNotificationApi(req) {
  const { mounted, original } = apiPath(req);
  return mounted === "/notifications" || mounted.startsWith("/notifications/")
    || original === "/api/notifications" || original.startsWith("/api/notifications/");
}

function onlyWhen(predicate, limiter) {
  return (req, res, next) => (predicate(req) ? limiter(req, res, next) : next());
}

app.use("/api", (req, res, next) => {
  if (isPgApi(req)) return next();
  return globalApiLimiter(req, res, next);
});
app.use("/api/2fa", twoFactorLimiter);
// Server-verified login (Production Security Fix Pass) — the one endpoint
// an unauthenticated attacker can hit repeatedly to guess a PIN/password,
// so it gets the same brute-force ceiling as 2FA verification.
app.use("/api/auth", authLimiter, authRouter);
app.use("/api", qrRouter);
// P0 fix — CLIENT ORDER ACCESS SECURITY (see routes/clientOrders.js header
// for the full root-cause writeup). The one server-authorized way a QR
// customer session reads an order; never lists orders, so it has no
// enumeration surface regardless of what database.rules.json allows.
app.use("/api", clientOrdersRouter);
// Superadmin-only restaurant-credential reveal/rotate (see the router's own
// header for the full authorization model) — same brute-force ceiling as
// login, since it's another credential-adjacent surface.
app.use("/api/superadmin/credentials", superadminCredentialsLimiter, superadminCredentialsRouter);
// Superadmin dashboard systemData-regression fix (health/payment-history/
// audit-log/login-history) — see routes/superadminDashboard.js header.
app.use("/api/superadmin/dashboard", superadminDashboardLimiter, superadminDashboardRouter);
// Superadmin systemData migration, Stage 2 — Active Sessions/Devices, 2FA,
// Marketing (promo codes/broadcast), Settings. Same authorization surface/
// risk profile as the dashboard router above (not a brute-force-prone
// endpoint family), so same 200/15min policy per family — but each family
// gets its OWN limiter instance, not the dashboard's. 429-storm fix: these
// four used to all reuse superadminDashboardLimiter's instance, which
// silently pooled all five families onto one shared 200/15min counter
// instead of 200/15min each; see the per-limiter comment in
// security/rateLimit.js for the full trace.
app.use("/api/superadmin/sessions", superadminSessionsLimiter, superadminSessionsRouter);
app.use("/api/superadmin/2fa", superadmin2faLimiter, superadmin2faRouter);
app.use("/api/superadmin/marketing", superadminMarketingLimiter, superadminMarketingRouter);
app.use("/api/superadmin/settings", superadminSettingsLimiter, superadminSettingsRouter);
// SuperAdmin Telegram bot settings (token/allowlist/test) — see routes/
// superadminBot.js and notifications/SuperAdminBotService.js headers.
app.use("/api/superadmin/bot", superadminBotLimiter, superadminBotRouter);
// Restaurant-facing admin panel's systemData-regression fix (see
// routes/restaurantConfig.js header) — tariff/plan feature catalog reads
// that used to go straight at systemData/settings/tariffs/* via the client
// SDK, now blocked by database.rules.json's unconditional systemData
// closure. Low-risk authenticated read, no dedicated limiter needed —
// covered by the app-wide globalApiLimiter mounted on "/api" above.
app.use("/api/restaurant", restaurantConfigRouter);
// Landing page's public aggregate-stats endpoint (see routes/publicStats.js
// header for the full root-cause/fix writeup) — the one endpoint in this
// app that is deliberately unauthenticated, so it gets its own dedicated,
// per-IP rate limit on top of the route's own server-side cache. Mounted at
// the specific "/api/public" prefix (like authLimiter/"/api/auth" and
// superadminCredentialsLimiter/"/api/superadmin/credentials" above) rather
// than the broad "/api" other routers below use, so this limiter can only
// ever consume its quota for this router's own requests.
app.use("/api/public", publicFirebaseConfigRouter);
app.use("/api/public", publicStatsLimiter, publicStatsRouter);

// PostgreSQL RTDB bridge must be mounted BEFORE the broad `/api` + limiter
// stacks below. Those stacks used to run paymentLimiter (60/min) four times
// plus delivery/notification limiters on EVERY /api/* miss — including
// /api/pg/rtdb/get — so one admin page of ~60 onValue listeners exhausted
// the payment bucket and 429'd. Limits themselves are unchanged.
app.use("/api/pg", pgRtdbLimiter, pgApiRouter);
attachIo(io);
attachPgRealtime(io);

// ─── To'lov tizimlari (Click / Payme / Uzum) ─────────────────────────────────
// Click va Payme webhooklari o'zlarining ichida kerakli body-parserni
// ishlatadi (Click: urlencoded, Payme: JSON-RPC standart JSON body orqali).
app.use("/api", onlyWhen((req) => pathPrefixed(req, "/click"), paymentLimiter), clickRouter);
app.use("/api", onlyWhen((req) => pathPrefixed(req, "/payme"), paymentLimiter), paymeRouter);
app.use("/api", onlyWhen((req) => pathPrefixed(req, "/uzum"), paymentLimiter), uzumRouter);
app.use("/api", onlyWhen((req) => pathPrefixed(req, "/payments"), paymentLimiter), paymentsInitRouter);

// ─── Delivery Management (Internal Couriers + Yandex Go, provider-based) ─────
app.use("/api", onlyWhen(isDeliveryApi, deliveryLimiter), deliveryRouter);
attachSocketIO(io);

// ─── Notification Center (Telegram today; Push/Email/SMS/WhatsApp-ready) ────
app.use("/api", onlyWhen(isNotificationApi, notificationLimiter), notificationsRouter);

// ─── AI Smart Import (Manual parsers + Gemini-backed AI detection) ───────────
// 🩹 429-storm fix: aiImportLimiter used to gate the WHOLE router here (every
// route — GET modules/settings/history, PUT settings, POST analyze/commit —
// sharing one 15-req/60s-per-restaurant bucket). Those reads/writes are free,
// non-Gemini calls a normal admin fires on every tab visit (Settings ↔ AI
// Import section), so ordinary navigation alone could exhaust the budget
// meant for the actual token-costing Gemini calls — the next request (often
// Save) then got a 429 with nothing resembling abuse having happened.
// aiImportLimiter now applies ONLY to the two routes that actually call
// Gemini (see routes/aiImport.js) — every other route here still runs under
// the app-wide globalApiLimiter (300 req/60s, mounted above) same as before.
app.use("/api", aiImportRouter);

// ─── QR one-time customer discount claims (Sozlamalar → Chop etish → QR) ────
// Rate limiting is per-route inside routes/discountClaims.js itself (public
// resolve/claim routes get their own dedicated limiter; the two staff routes
// rely on the app-wide globalApiLimiter above, same as every other
// authenticated route in this file).
app.use("/api", discountClaimsRouter);

// ─── 2FA (TOTP) — optional, per-employee, Settings-toggled (spec section 6) ─
app.use("/api", twoFactorRouter);

// All three background jobs (scheduler, db monitor, Telegram bot polling)
// make their first Firebase read immediately on start — startScheduler()'s
// tick() calls listRestaurantIds() right away, startDbMonitor() subscribes
// to ".info/connected" right away, and startTelegramBotPolling() lists
// restaurants to sync pollers right away. All three previously started
// before connectDB() (below, near server.listen) had actually run, so
// getDB() was still null and the very first call of each crashed on boot.
// connectDB() is idempotent (safe to call more than once — see db.js), so
// gating all three behind this one await here doesn't change anything about
// the existing connectDB() call further down.
if (usePostgres()) {
  startScheduler();
  startTelegramBotPolling();
  startSuperAdminBotPolling();
} else {
  connectDB().then(() => {
    startScheduler();
    startDbMonitor();
    startTelegramBotPolling();
    startSuperAdminBotPolling();
  });
}

// ─── BASE_PATH: frontend ile aynı yapı ───────────────────────────────────────
// Frontend: restaurants/${restId}/orders  vb.
// SERVER: har bir so'rovda restId talab qilinadi (query yoki body orqali)
// Oddiylashtirish uchun: BASE_PATH ni dynamic helper sifatida ishlatamiz

function basePath(restId) {
  return `restaurants/${restId}`;
}

// ─── Room helpers (Socket.IO) ─────────────────────────────────────────────────
const rooms = {
  clients: new Map(),
  chefs:   new Map(),
  tables:  new Map(),
  orders:  new Map(),
};

// Table numbers ("1", "2", ...) are reused across every restaurant, so a
// table room MUST be scoped by restId — otherwise restaurant A's table 1
// and restaurant B's table 1 are the same Socket.IO room and each would see
// the other's order-status/payment events. `restId` is optional only for
// backward compatibility with any not-yet-updated caller; when present, the
// socket joins ONLY the scoped room (the unscoped legacy room is no longer
// joined once a caller sends restId, closing the cross-tenant leak for that
// client going forward).
function joinTableRooms(socket, table, restId) {
  if (!table) return;
  const key = String(table);
  if (restId) {
    socket.join(`table-${restId}-${key}`);
  } else {
    socket.join(`table-${key}`);
    socket.join(`table_${key}`);
  }
  const trackKey = restId ? `${restId}-${key}` : key;
  if (!rooms.tables.has(trackKey)) rooms.tables.set(trackKey, new Set());
  rooms.tables.get(trackKey).add(socket.id);
}

function emitToTable(table, eventName, payload, restId) {
  if (!table) return;
  const key = String(table);
  if (restId) {
    io.to(`table-${restId}-${key}`).emit(eventName, payload);
  } else {
    // Legacy, unscoped fallback — only reached for sockets that joined
    // before restId scoping (see joinTableRooms above).
    io.to(`table-${key}`).emit(eventName, payload);
    io.to(`table_${key}`).emit(eventName, payload);
  }
}

async function withPgRest(restId, fn, { actingRole = "owner", userId = null } = {}) {
  const restaurant = await lookupRestaurantByLegacyId(restId);
  if (!restaurant) return { __missingRestaurant: true };
  const events = [];
  const ctx = { restaurantUuid: restaurant.id, restId, restaurant, actingRole, userId };
  const result = await withTenantContext(restaurant.id, (client) => fn(client, ctx, events), { actingRole });
  broadcastAll(events);
  return result;
}

function mapStatus(status = "") {
  const map = {
    Yangi:"new", Tasdiqlandi:"approved", Tayyorlanmoqda:"cooking",
    Tayyor:"ready", Yetkazilmoqda:"on_way", Yetkazildi:"delivered",
    Topshirildi:"delivered", Yopildi:"closed",
    new:"new", in_progress:"cooking", ready:"ready",
    delivered:"delivered", closed:"closed",
  };
  return map[status] || String(status).toLowerCase().replace(/\s+/g,"_");
}

function calculateOrderTotal(items = []) {
  return items.reduce((t, i) => t + Number(i?.price||0) * Number(i?.qty||i?.quantity||1), 0);
}

function normalizeItems(items = []) {
  return items.filter(Boolean).map(i => ({
    name:  String(i.name||"").trim(),
    price: Number(i.price||0),
    qty:   Number(i.qty||i.quantity||1),
    image: i.image||i.img||"",
  })).filter(i => i.name);
}

// ─── Audit log helper (spec section 18) ──────────────────────────────────────
// Fire-and-forget: resolves the acting employee's name/role, then writes one
// audit entry. Never awaited by callers — must not add latency or ever fail
// a request.
//
// Production Security Fix Pass (P0-1): every current caller of this
// function is behind requirePermission() (see rbac.js), which now attaches
// the VERIFIED identity as req.nestaAuth before calling next() — used here
// instead of the raw x-user-id header, so a spoofed header can no longer
// mislabel who an already-authorized action's audit entry is attributed to.
// Falls back to the header only if some future caller isn't
// requirePermission()-gated (defensive; not the case for any caller today).
async function auditFromReq(req, restId, module, action, details) {
  try {
    const userId = req.nestaAuth?.userId || req.headers["x-user-id"] || null;
    let userName = "", userRole = "";
    if (restId && userId) {
      const uSnap = await systemGet(`${basePath(restId)}/users/${userId}`);
      if (uSnap.exists()) {
        userName = uSnap.val().name || "";
        userRole = uSnap.val().role || "";
      }
    }
    logAuditEvent({ restId, userId, userName, userRole, module, action, details }, req);
  } catch (err) {
    console.error("[audit] non-fatal:", err.message);
  }
}

// ─── DB guard ─────────────────────────────────────────────────────────────────
async function ensureDatabase(res) {
  if (usePostgres()) return true;
  if (isDatabaseConnected()) return true;
  const db = await connectDB();
  if (db) return true;
  res.status(503).json({ error:"Database is unavailable", dbState: getDatabaseState() });
  return false;
}

// restId ni so'rovdan olish
// A restId is interpolated straight into a Firebase RTDB path
// (basePath() above), so it must be a single safe path segment — otherwise
// a value containing "/" could make a request that passed permission checks
// for restaurant A actually read/write under a different path entirely
// (see security/sanitize.js). Invalid values resolve to null, which every
// call site already 400s on ("restId required") — no behavior change for
// any real restId, which is always a plain Firebase push()/generated key.
function getRestId(req) {
  const raw =
    req.query.restId ||
    req.body?.restId ||
    req.headers["x-rest-id"] ||
    process.env.DEFAULT_REST_ID ||
    null;
  return raw && isSafeId(String(raw)) ? raw : null;
}

const requireStaffMutationAuthority = createStaffMutationAuthority({ resolveIdentity, getRestId, usePostgres });

function trackOrder(orderId, payload) {
  const key = String(orderId);
  rooms.orders.set(key, { ...(rooms.orders.get(key)||{}), ...payload });
}

// rooms.orders is a single process-wide Map (all restaurants), so filtering
// by restId here — not just by chefId — is what keeps a chef from seeing
// another restaurant's in-flight orders in the initial "active-orders" sync.
function broadcastActiveOrders(chefId, restId) {
  const chefEntry = rooms.chefs.get(String(chefId));
  if (!chefEntry) return;
  const active = [];
  for (const [orderId, data] of rooms.orders.entries()) {
    if (!data.chefId && (!restId || data.restId === restId) && ["Yangi","Tasdiqlandi","new","approved"].includes(data.status)) {
      active.push({ orderId, ...data });
    }
  }
  if (active.length) io.to(chefEntry.socketId).emit("active-orders", active);
}

// ─── REST API ─────────────────────────────────────────────────────────────────

app.get("/api/local-ip", (_req, res) => {
  const ifaces = os.networkInterfaces();
  let localIp = "localhost";
  for (const iface of Object.values(ifaces)) {
    for (const alias of iface) {
      if (alias.family === "IPv4" && !alias.internal) { localIp = alias.address; break; }
    }
  }
  res.json({ ip: localIp, port: PORT });
});

app.get("/api/health", async (_req, res) => {
  if (!usePostgres() && !isDatabaseConnected()) await connectDB();
  const qr = qrSigningHealth();
  const payload = {
    ok: qr.ok !== false,
    dbState: getDatabaseState(),
    dataBackend: getDataBackend(),
    postgres: isPgAvailable(),
    qrSigning: qr.qrSigning,
    ...authEnvironmentDiagnostic(),
  };
  if (!qr.ok) return res.status(503).json(payload);
  res.json(payload);
});

// ── Categories ────────────────────────────────────────────────────────────────
app.get("/api/categories", requirePermission("menu", "view", getRestId), async (req, res) => {
  if (!(await ensureDatabase(res))) return;
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  if (usePostgres()) {
    const out = await withPgRest(restId, async (client, ctx) => pgCatalog.listCategoriesMap(client, ctx.restaurantUuid), { actingRole: req.nestaAuth?.role || "owner", userId: req.nestaAuth?.userId });
    if (out?.__missingRestaurant) return res.status(404).json({ error: "Restaurant not found" });
    const list = Object.entries(out || {})
      .map(([id, cat]) => ({ _id: id, name: cat.name, icon: cat.icon || "" }))
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    return res.json(list);
  }

  const snap = await systemGet(`${basePath(restId)}/categories`);
  const data = snap.val() || {};
  const list = Object.entries(data)
    .map(([id, cat]) => ({ _id: id, name: cat.name, icon: cat.icon||"" }))
    .sort((a,b) => a.name?.localeCompare(b.name));
  res.json(list);
});

app.post("/api/categories", requirePermission("menu", "create", getRestId), async (req, res) => {
  if (!(await ensureDatabase(res))) return;
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const name = String(req.body?.name||"").trim();
  if (!name) return res.status(400).json({ error: "Category name is required" });

  if (usePostgres()) {
    const catData = { name, icon: req.body?.icon || "", createdAt: Date.now() };
    const newKey = pushId();
    const out = await withPgRest(restId, async (client, ctx, events) => {
      await pgCatalog.upsertCategory(client, ctx, newKey, catData, events);
      return newKey;
    }, { actingRole: req.nestaAuth?.role || "owner", userId: req.nestaAuth?.userId });
    if (out?.__missingRestaurant) return res.status(404).json({ error: "Restaurant not found" });
    const payload = { _id: out, name, icon: catData.icon };
    io.to(`rest-${restId}`).emit("category:created", payload);
    auditFromReq(req, restId, "menu", "create", { entity: "category", id: out, name });
    return res.status(201).json(payload);
  }

  const catData = { name, icon: req.body?.icon||"", createdAt: Date.now() };
  const newKey = await systemPush(`${basePath(restId)}/categories`, catData);

  const payload = { _id: newKey, name, icon: catData.icon };
  io.to(`rest-${restId}`).emit("category:created", payload);
  auditFromReq(req, restId, "menu", "create", { entity: "category", id: newKey, name });
  res.status(201).json(payload);
});

// ── Foods / Menu ──────────────────────────────────────────────────────────────
app.get("/api/foods", requirePermission("menu", "view", getRestId), async (req, res) => {
  if (!(await ensureDatabase(res))) return;
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  if (usePostgres()) {
    const out = await withPgRest(restId, async (client, ctx) => {
      const [menuData, catData] = await Promise.all([
        pgCatalog.listMenuMap(client, ctx.restaurantUuid),
        pgCatalog.listCategoriesMap(client, ctx.restaurantUuid),
      ]);
      return { menuData, catData };
    }, { actingRole: req.nestaAuth?.role || "owner", userId: req.nestaAuth?.userId });
    if (out?.__missingRestaurant) return res.status(404).json({ error: "Restaurant not found" });
    const list = Object.entries(out.menuData || {})
      .map(([id, item]) => {
        const cat = item.categoryId ? out.catData[item.categoryId] : null;
        return {
          _id: id,
          name: item.name,
          price: Number(item.price || 0),
          image: item.imgUrl || item.image || "",
          available: item.active !== false,
          categoryId: item.categoryId || item.category || "",
          category: cat ? { _id: item.categoryId, name: cat.name, icon: cat.icon || "" } : null,
          createdAt: item.createdAt,
        };
      })
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return res.json(list);
  }

  const [menuSnap, catSnap] = await Promise.all([
    systemGet(`${basePath(restId)}/menu`),
    systemGet(`${basePath(restId)}/categories`),
  ]);

  const menuData = menuSnap.val() || {};
  const catData  = catSnap.val()  || {};

  const list = Object.entries(menuData)
    .map(([id, item]) => {
      const cat = item.categoryId ? catData[item.categoryId] : null;
      return {
        _id:        id,
        name:       item.name,
        price:      Number(item.price||0),
        image:      item.imgUrl || item.image || "",
        available:  item.active !== false,
        categoryId: item.categoryId || item.category || "",
        category:   cat ? { _id: item.categoryId, name: cat.name, icon: cat.icon||"" } : null,
      };
    })
    .sort((a,b) => b.createdAt - a.createdAt);
  res.json(list);
});

app.post("/api/foods", requirePermission("menu", "create", getRestId), async (req, res) => {
  if (!(await ensureDatabase(res))) return;
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const name = String(req.body?.name||"").trim();
  if (!name) return res.status(400).json({ error: "Food name is required" });

  const categoryId = req.body?.categoryId || req.body?.category || "";
  const foodData = {
    name:       { uz: name },
    price:      Number(req.body?.price||0),
    imgUrl:     req.body?.image || "",
    active:     req.body?.available !== false,
    categoryId,
    category:   categoryId,
    createdAt:  Date.now(),
  };

  if (usePostgres()) {
    const newKey = pushId();
    const out = await withPgRest(restId, async (client, ctx, events) => {
      await pgCatalog.upsertMenuItem(client, ctx, newKey, foodData, events);
      let category = null;
      if (categoryId) {
        const cats = await pgCatalog.listCategoriesMap(client, ctx.restaurantUuid);
        const c = cats[categoryId];
        if (c) category = { _id: categoryId, name: c.name, icon: c.icon || "" };
      }
      return category;
    }, { actingRole: req.nestaAuth?.role || "owner", userId: req.nestaAuth?.userId });
    if (out?.__missingRestaurant) return res.status(404).json({ error: "Restaurant not found" });
    const payload = {
      _id: newKey, name, price: foodData.price,
      image: foodData.imgUrl, available: foodData.active, categoryId, category: out,
    };
    io.to(`rest-${restId}`).emit("food:created", payload);
    auditFromReq(req, restId, "menu", "create", { entity: "food", id: newKey, name, price: foodData.price });
    return res.status(201).json(payload);
  }

  const newKey = await systemPush(`${basePath(restId)}/menu`, foodData);

  let category = null;
  if (categoryId) {
    const catSnap = await systemGet(`${basePath(restId)}/categories/${categoryId}`);
    if (catSnap.exists()) {
      const c = catSnap.val();
      category = { _id: categoryId, name: c.name, icon: c.icon||"" };
    }
  }

  const payload = {
    _id: newKey, name, price: foodData.price,
    image: foodData.imgUrl, available: foodData.active, categoryId, category,
  };
  io.to(`rest-${restId}`).emit("food:created", payload);
  auditFromReq(req, restId, "menu", "create", { entity: "food", id: newKey, name, price: foodData.price });
  res.status(201).json(payload);
});

// ── Orders ────────────────────────────────────────────────────────────────────
app.get("/api/orders", requirePermission("orders", "view", getRestId), async (req, res) => {
  if (!(await ensureDatabase(res))) return;
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  if (usePostgres()) {
    const out = await withPgRest(restId, async (client, ctx) => pgOrders.listOrdersMap(client, ctx.restaurantUuid, { limit: 300 }), { actingRole: req.nestaAuth?.role || "owner", userId: req.nestaAuth?.userId });
    if (out?.__missingRestaurant) return res.status(404).json({ error: "Restaurant not found" });
    const list = Object.entries(out || {})
      .map(([id, o]) => normalizeOrder(id, o))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return res.json(list);
  }

  const snap = await systemQueryOrderedLimit(`${basePath(restId)}/orders`, "createdAt", 300);
  const data = snap.val() || {};

  const list = Object.entries(data)
    .map(([id, o]) => normalizeOrder(id, o))
    .sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
  res.json(list);
});

app.post("/api/orders", requirePermission("orders", "create", getRestId), async (req, res) => {
  if (!(await ensureDatabase(res))) return;
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const table = Number(req.body?.table||0);
  const items = normalizeItems(req.body?.items||(req.body?.item ? [req.body.item] : []));
  if (!table || !items.length) return res.status(400).json({ error:"Order table and items are required" });

  const orderNum = `#${Date.now().toString().slice(-6)}`;
  const orderData = {
    table,
    items,
    // Production Security Fix Pass, Phase 2 (High: missing server
    // validation) — total used to trust req.body.total when the caller
    // supplied one, letting an authorized-but-buggy/malicious client set an
    // order total unrelated to its actual items. Always derived from the
    // (already-normalized, server-side) item list instead.
    total:       calculateOrderTotal(items),
    status:      req.body?.status || "new",
    statusKey:   "new",
    statusLabel: "Yangi",
    chefId:      req.body?.chefId || null,
    orderNumber: req.body?.orderNumber || orderNum,
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
  };

  if (usePostgres()) {
    const newKey = pushId();
    const out = await withPgRest(restId, async (client, ctx, events) => {
      await pgOrders.upsertOrder(client, ctx, newKey, orderData, events);
      return pgOrders.getOrderByLegacy(client, ctx.restaurantUuid, newKey);
    }, { actingRole: req.nestaAuth?.role || "owner", userId: req.nestaAuth?.userId });
    if (out?.__missingRestaurant) return res.status(404).json({ error: "Restaurant not found" });
    const payload = normalizeOrder(newKey, out || orderData);
    io.to(`rest-${restId}`).emit("order:created", payload);
    trackOrder(newKey, { table: payload.table, status: payload.status, chefId: payload.chefId });
    auditFromReq(req, restId, "orders", "create", { orderId: newKey, table: payload.table, total: payload.total });
    return res.status(201).json(payload);
  }

  const newKey = await systemPush(`${basePath(restId)}/orders`, orderData);

  const payload = normalizeOrder(newKey, orderData);
  io.to(`rest-${restId}`).emit("order:created", payload);
  trackOrder(newKey, { table: payload.table, status: payload.status, chefId: payload.chefId });
  auditFromReq(req, restId, "orders", "create", { orderId: newKey, table: payload.table, total: payload.total });
  res.status(201).json(payload);
});

app.put("/api/orders/:id/status", requirePermission("orders", "edit", getRestId), async (req, res) => {
  if (!(await ensureDatabase(res))) return;
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });
  if (!isSafeId(req.params.id)) return res.status(400).json({ error: "Invalid order id" });

  const status = String(req.body?.status||"").trim();
  if (!status) return res.status(400).json({ error:"Status is required" });

  if (usePostgres()) {
    const out = await withPgRest(restId, async (client, ctx, events) => {
      const existing = await pgOrders.getOrderByLegacy(client, ctx.restaurantUuid, req.params.id);
      if (!existing) return { missing: true };
      const updated = await pgOrders.applyLifecycle(client, ctx, req.params.id, "status", {
        status,
        chefId: req.body?.chefId || null,
        statusLabel: status,
      }, events);
      return { existing, updated: updated?.order || updated };
    }, { actingRole: req.nestaAuth?.role || "owner", userId: req.nestaAuth?.userId });
    if (out?.__missingRestaurant) return res.status(404).json({ error: "Restaurant not found" });
    if (out?.missing || out?.error) return res.status(out?.status || 404).json({ error: out?.error || "Order not found" });
    const shaped = out.updated && typeof out.updated === "object" && !out.updated.missing
      ? out.updated
      : { ...out.existing, status, statusKey: mapStatus(status), chefId: req.body?.chefId || null };
    const payload = normalizeOrder(req.params.id, shaped);
    io.to(`rest-${restId}`).emit("order:updated", payload);
    io.to(`admins:${restId}`).emit("order-status-changed", payload);
    const isDeliveryOrder =
      shaped.orderType === "delivery" || shaped.isDelivery === true || shaped.deliveryType === "delivery" || !!shaped.deliveryAddress;
    if (isDeliveryOrder && (payload.statusKey === "ready" || shaped.status === "ready" || shaped.statusKey === "ready")) {
      import("./delivery/engine.js")
        .then((engine) => engine.assign(restId, req.params.id))
        .catch((err) => console.error("Delivery auto-assign error:", err.message));
    }
    trackOrder(req.params.id, { table: payload.table, status: payload.status, chefId: payload.chefId });
    auditFromReq(req, restId, "orders", "edit", { orderId: req.params.id, newStatus: status });
    return res.json(payload);
  }

  const orderPath  = `${basePath(restId)}/orders/${req.params.id}`;
  const orderSnap = await systemGet(orderPath);
  if (!orderSnap.exists()) return res.status(404).json({ error:"Order not found" });

  const updates = {
    status,
    statusKey:   mapStatus(status),
    statusLabel: status,
    chefId:      req.body?.chefId || null,
    updatedAt:   Date.now(),
  };
  await systemUpdate(orderPath, updates);

  const payload = normalizeOrder(req.params.id, { ...orderSnap.val(), ...updates });
  io.to(`rest-${restId}`).emit("order:updated", payload);
  io.to(`admins:${restId}`).emit("order-status-changed", payload);

  // Order Ready → Delivery Engine selects a provider (Internal / Yandex Go /
  // Automatic), for orders placed as delivery. Fire-and-forget: a failure
  // here (e.g. no courier available) must not fail the status update.
  const orderAfter = { ...orderSnap.val(), ...updates };
  const isDeliveryOrder =
    orderAfter.orderType === "delivery" || orderAfter.isDelivery === true || orderAfter.deliveryType === "delivery" || !!orderAfter.deliveryAddress;
  if (isDeliveryOrder && updates.statusKey === "ready") {
    import("./delivery/engine.js")
      .then((engine) => engine.assign(restId, req.params.id))
      .catch((err) => console.error("Delivery auto-assign error:", err.message));
  }
  trackOrder(req.params.id, { table: payload.table, status: payload.status, chefId: payload.chefId });
  auditFromReq(req, restId, "orders", "edit", { orderId: req.params.id, newStatus: status });
  res.json(payload);
});

// ── Staff / Users ─────────────────────────────────────────────────────────────
app.get("/api/staff", requirePermission("staff", "view", getRestId), async (req, res) => {
  if (!usePostgres() && !(await ensureDatabase(res))) return;
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  if (usePostgres()) {
    const out = await withPgRest(restId, async (client, ctx) => pgCatalog.listEmployeesMap(client, ctx.restaurantUuid), { actingRole: req.nestaAuth?.role || "owner", userId: req.nestaAuth?.userId });
    if (out?.__missingRestaurant) return res.status(404).json({ error: "Restaurant not found" });
    const list = Object.entries(out || {})
      .filter(([, u]) => u.role === "chef" || u.role === "waiter")
      .map(([id, u]) => normalizeStaff(id, u))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return res.json(list);
  }

  const snap = await systemGet(`${basePath(restId)}/users`);
  const data = snap.val() || {};
  const list = Object.entries(data)
    .filter(([, u]) => u.role === "chef" || u.role === "waiter")
    .map(([id, u]) => normalizeStaff(id, u))
    .sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
  res.json(list);
});

app.post("/api/staff", requireStaffMutationAuthority, requirePermission("staff", "create", getRestId), async (req, res) => {
  if (!usePostgres() && !(await ensureDatabase(res))) return;
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const name = String(req.body?.name||"").trim();
  if (!name) return res.status(400).json({ error:"Staff name is required" });

  const role      = req.body?.role || "waiter";
  const staffId   = `${role}_${Date.now()}`;

  if (usePostgres()) {
    const prepared = preparePgStaffCreate(req.body, { isSafeId });
    if (prepared.error) return res.status(400).json({ error: prepared.error });
    const { requestedPin, staffData } = prepared;
    const pgStaffId = prepared.staffId;
    if (requestedPin && !/^\d{4}$/.test(requestedPin)) {
      return res.status(400).json({ error: "Password must be exactly 4 digits" });
    }
    try {
      const created = await withPgRest(restId, async (client, ctx, events) => {
        let pin = requestedPin;
        if (pin) {
          await assertPinAvailable(client, { pin });
        } else {
          do {
            pin = String(Math.floor(1000 + Math.random() * 9000));
            try {
              await assertPinAvailable(client, { pin });
              break;
            } catch (err) {
              if (err?.code !== "CREDENTIAL_CONFLICT") throw err;
              pin = "";
            }
          } while (!pin);
        }
        const employee = await pgCatalog.upsertEmployee(
          client, ctx, pgStaffId, staffData, events
        );
        await upsertEmployeeCredential(client, { employeeId: employee._pgId, pin });
        return employee;
      }, { actingRole: req.nestaAuth?.role || "owner", userId: req.nestaAuth?.userId });
      if (created?.__missingRestaurant) return res.status(404).json({ error: "Restaurant not found" });
      return res.status(201).json(normalizeStaff(pgStaffId, created));
    } catch (err) {
      if (err?.code === "CREDENTIAL_CONFLICT") {
        return res.status(409).json({ error: "Employee code already in use in this restaurant" });
      }
      throw err;
    }
  }

  const usersSnap = await systemGet(`${basePath(restId)}/users`);
  const existingUsers = usersSnap.val() || {};
  // P0-2 residual-gap fix: password now lives at
  // credentials/${restId}/${userId}/password, not on the user record
  // itself — see database.rules.json's "credentials" tree comment.
  const credsSnap = await systemGet(`credentials/${restId}`);
  const existingCreds = credsSnap.val() || {};
  const existingPasswordValues = Object.keys(existingUsers)
    .map(uid => String(existingCreds[uid]?.password ?? "").trim())
    .filter(Boolean);
  // Existing passwords may now be bcrypt hashes (Production Security Fix
  // Pass — see security/password.js), so a plain Set membership check no
  // longer detects a collision against those. verifyPassword() understands
  // both the new hashed format and legacy plaintext, so it's used here too;
  // it's async, hence the codeIsTaken() helper instead of a Set.
  async function codeIsTaken(candidate) {
    for (const stored of existingPasswordValues) {
      if ((await verifyPassword(candidate, stored)).ok) return true;
    }
    return false;
  }

  let password = req.body?.password ? String(req.body.password).trim() : "";
  if (password) {
    // Kod faqat JORIY restoran ichida noyob bo'lishi kerak — boshqa
    // restoranlardagi kodlar bilan solishtirilmaydi.
    if (await codeIsTaken(password)) {
      return res.status(409).json({ error: "Employee code already in use in this restaurant" });
    }
  } else {
    do {
      password = String(Math.floor(1000 + Math.random()*9000));
    } while (await codeIsTaken(password));
  }

  // plainCode is returned to the caller once (e.g. shown to the admin who
  // just created this account) — the DB itself only ever stores the bcrypt
  // hash from here on (Production Security Fix Pass: PINs used to be
  // written to Firebase in plain text).
  const plainCode = password;
  const staffData = {
    name,
    role,
    active:    req.body?.active !== false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await systemSet(`${basePath(restId)}/users/${staffId}`, staffData);
  // P0-2 residual-gap fix: written to credentials/${restId}/${staffId}
  // instead of embedded in the user record.
  await systemSet(`credentials/${restId}/${staffId}`, { password: await hashPassword(plainCode) });
  auditFromReq(req, restId, "staff", "create", { staffId, name, role });
  res.status(201).json({ ...normalizeStaff(staffId, staffData), password: plainCode });
});

app.patch("/api/staff/:id", requireStaffMutationAuthority, requirePermission("staff", "edit", getRestId), async (req, res) => {
  if (!usePostgres() && !(await ensureDatabase(res))) return;
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });
  const staffId = String(req.params.id || "");
  if (!isSafeId(staffId)) return res.status(400).json({ error: "Invalid staff id" });

  if (usePostgres()) {
    const prepared = preparePgStaffPatch(req.body, { isSafeId });
    if (prepared.error) return res.status(400).json({ error: prepared.error });
    const password = prepared.requestedPin;
    if (password != null && !/^\d{4}$/.test(password)) {
      return res.status(400).json({ error: "Password must be exactly 4 digits" });
    }
    const employeePatch = prepared.staffPatch;
    try {
      const updated = await withPgRest(restId, async (client, ctx, events) => {
        const current = await pgCatalog.getEmployee(client, ctx.restaurantUuid, staffId);
        if (!current) return null;
        const employee = await pgCatalog.patchEmployee(client, ctx, staffId, employeePatch, events);
        if (password != null) {
          await assertPinAvailable(client, { pin: password, excludeEmployeeId: employee._pgId });
          await upsertEmployeeCredential(client, { employeeId: employee._pgId, pin: password });
        }
        return employee;
      }, { actingRole: req.nestaAuth?.role || "owner", userId: req.nestaAuth?.userId });
      if (updated?.__missingRestaurant) return res.status(404).json({ error: "Restaurant not found" });
      if (!updated) return res.status(404).json({ error: "Staff not found" });
      return res.json(normalizeStaff(staffId, updated));
    } catch (err) {
      if (err?.code === "CREDENTIAL_CONFLICT") {
        return res.status(409).json({ error: "Employee code already in use in this restaurant" });
      }
      throw err;
    }
  }

  const userPath = `${basePath(restId)}/users/${staffId}`;
  const userSnap = await systemGet(userPath);
  if (!userSnap.exists()) return res.status(404).json({ error: "Staff not found" });
  const { password: _password, restId: _restId, restaurantId: _restaurantId, ...patch } = req.body || {};
  const firebasePassword = req.body?.password == null ? null : String(req.body.password);
  if (firebasePassword != null && !/^\d{4}$/.test(firebasePassword)) {
    return res.status(400).json({ error: "Password must be exactly 4 digits" });
  }
  patch.updatedAt = Date.now();
  await systemUpdate(userPath, patch);
  if (firebasePassword != null) {
    await systemUpdate(`credentials/${restId}/${staffId}`, { password: await hashPassword(firebasePassword) });
  }
  const updated = { ...userSnap.val(), ...patch };
  auditFromReq(req, restId, "staff", "edit", { staffId, name: updated.name });
  return res.json(normalizeStaff(staffId, updated));
});

// Console-error fix pass: admin.js's deleteStaff() used to remove
// restaurants/$restId/users/$id (broad rule, any same-restId session, so
// this half always succeeded) and THEN try to also remove
// credentials/$restId/$id directly from the browser — but that path's
// write rule (database.rules.json) is intentionally strict, literally
// "role == owner || role == admin" only, since it's the one place a
// bcrypt hash lives. Any OTHER role this app's own RBAC (customRoles/
// roleOverrides) has granted "staff:delete" to — a manager, a custom
// role — passes the frontend's window.canDelete("staff") check and the
// first remove(), then fails the second with permission_denied, exactly
// as reported. The fix is not to loosen that rule (explicitly ruled out)
// but to do the credential half through the backend instead, the same way
// POST /api/staff above already writes it: requirePermission() enforces
// this app's REAL, flexible authorization policy (whatever roles actually
// have staff:delete, not just literally owner/admin), then the Admin SDK
// (systemRemove) bypasses the rule with that already-verified authority —
// consistent with every other backend write in this file, and no weaker
// than what a legitimate owner/admin could already do by hand.
app.delete("/api/staff/:id", requireStaffMutationAuthority, requirePermission("staff", "delete", getRestId), async (req, res) => {
  if (!usePostgres() && !(await ensureDatabase(res))) return;
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const staffId = String(req.params.id || "");
  if (!isSafeId(staffId)) return res.status(400).json({ error: "Invalid staff id" });

  if (usePostgres()) {
    const deleted = await withPgRest(restId, async (client, ctx, events) => {
      const current = await pgCatalog.getEmployee(client, ctx.restaurantUuid, staffId);
      if (!current) return null;
      if (current.role === "admin" && current.isSubAdmin !== true) {
        return { __primaryAdmin: true };
      }
      await pgCatalog.upsertEmployee(client, ctx, staffId, null, events);
      return current;
    }, { actingRole: req.nestaAuth?.role || "owner", userId: req.nestaAuth?.userId });
    if (deleted?.__missingRestaurant) return res.status(404).json({ error: "Restaurant not found" });
    if (!deleted) return res.status(404).json({ error: "Staff not found" });
    if (deleted.__primaryAdmin) return res.status(403).json({ error: "Cannot delete the primary admin account" });
    return res.json({ ok: true });
  }

  const userPath = `${basePath(restId)}/users/${staffId}`;
  const userSnap = await systemGet(userPath);
  if (!userSnap.exists()) {
    // Already gone / never belonged to this restaurant — nothing to do,
    // but don't claim success for a target that was never confirmed to be
    // this restaurant's own employee.
    return res.status(404).json({ error: "Staff not found" });
  }
  const staffData = userSnap.val() || {};

  // Same guard admin.js's own deleteStaff() already applies client-side
  // (the real founder/owner-created "admin" account can never be removed)
  // — repeated here so a direct API call can't bypass it.
  if (staffData.role === "admin" && staffData.isSubAdmin !== true) {
    return res.status(403).json({ error: "Cannot delete the primary admin account" });
  }

  await systemRemove(userPath);
  // credentials/$restId/$staffId — see the fix comment above this route.
  await systemRemove(`credentials/${restId}/${staffId}`).catch((err) => {
    console.error("[DELETE /api/staff] credential cleanup error:", err.message);
  });

  auditFromReq(req, restId, "staff", "delete", { staffId, name: staffData.name, role: staffData.role });
  res.json({ ok: true });
});

// ── Staff credential (PIN) set/reveal ───────────────────────────────────────
//
// Root cause this closes: admin.js's Edit Staff modal could set a new PIN
// (saveStaffEdit() → direct client write of credentials/$restId/$uid/password,
// UNCHANGED, still plaintext exactly as before) but could never reliably show
// it again afterward. Once an employee logs into their own panel even once,
// backend/routes/auth.js's staff-login self-migrates that plaintext into a
// one-way bcrypt hash (Production Security Fix Pass) — by design, correctly,
// and there was never any reversible copy stored anywhere for staff PINs (only
// a restaurant's OWN admin login has one — passwordEnc, superadminCredentials.js
// — a different field, written by a different flow, gated to superadmin only).
//
// Fix: mirrors that EXACT existing passwordEnc pattern (same AES-256-GCM
// helpers, security/crypto.js — nothing new invented), but scoped to this
// restaurant's own staff via requirePermission("staff","edit",...) — this
// app's real, flexible RBAC (respects custom roles/overrides, not a hardcoded
// role literal) — the same authorization DELETE /api/staff/:id above already
// uses to reach credentials/ via the Admin SDK instead of the browser's own
// (correctly limited) Firebase Rules access. No Firebase Rule was touched:
// credentials/$restId/$userId/passwordEnc already had a generic (not
// admin_1-specific) ".read":false/".write":owner-or-admin shape from the
// original P0-2 design — it already covered any uid, this is the first
// caller that writes it for a REGULAR employee, not just a restaurant's own
// admin account.
//
// POST /api/staff/:id/credential  body: { password }  — sets a NEW PIN.
// Writes passwordEnc ONLY (the reversible copy) — deliberately does NOT
// touch the existing `password` (bcrypt/plaintext) field or its write path;
// saveStaffEdit()'s own existing direct write handles that half, completely
// unchanged, so the login flow this fix must never risk breaking is not
// touched by this route at all.
app.post("/api/staff/:id/credential", requireStaffMutationAuthority, requirePermission("staff", "edit", getRestId), async (req, res) => {
  if (!usePostgres() && !(await ensureDatabase(res))) return;
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const staffId = String(req.params.id || "");
  if (!isSafeId(staffId)) return res.status(400).json({ error: "Invalid staff id" });

  const password = String(req.body?.password || "");
  if (!/^\d{4}$/.test(password)) {
    return res.status(400).json({ error: "Password must be exactly 4 digits" });
  }

  if (usePostgres()) {
    try {
      const updated = await withPgRest(restId, async (client, ctx) => {
        const employee = await pgCatalog.getEmployee(client, ctx.restaurantUuid, staffId);
        if (!employee) return null;
        await assertPinAvailable(client, { pin: password, excludeEmployeeId: employee._pgId });
        await upsertEmployeeCredential(client, { employeeId: employee._pgId, pin: password });
        return employee;
      }, { actingRole: req.nestaAuth?.role || "owner", userId: req.nestaAuth?.userId });
      if (updated?.__missingRestaurant) return res.status(404).json({ error: "Restaurant not found" });
      if (!updated) return res.status(404).json({ error: "Staff not found" });
      return res.json({ ok: true });
    } catch (err) {
      if (err?.code === "CREDENTIAL_CONFLICT") {
        return res.status(409).json({ error: "Employee code already in use in this restaurant" });
      }
      throw err;
    }
  }

  const userSnap = await systemGet(`${basePath(restId)}/users/${staffId}`);
  if (!userSnap.exists()) return res.status(404).json({ error: "Staff not found" });

  await systemUpdate(`credentials/${restId}/${staffId}`, { passwordEnc: encryptSecret(password) });
  auditFromReq(req, restId, "staff", "edit", { staffId, name: userSnap.val()?.name, field: "credential" });
  res.json({ ok: true });
});

// GET /api/staff/:id/credential — reveals the currently-set PIN, decrypted
// server-side, ONLY for a session this restaurant's RBAC actually grants
// staff:edit to. Returns 404 (not an empty password) when no PIN has ever
// been set through the route above yet (e.g. a PIN set before this feature
// existed, or one that already migrated to a hash under the OLD flow with no
// passwordEnc copy) — the caller (admin.js) falls back to its existing
// hash-detection UI for that case, unchanged.
app.get("/api/staff/:id/credential", requirePermission("staff", "edit", getRestId), async (req, res) => {
  if (!usePostgres() && !(await ensureDatabase(res))) return;
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const staffId = String(req.params.id || "");
  if (!isSafeId(staffId)) return res.status(400).json({ error: "Invalid staff id" });

  if (usePostgres()) {
    const employee = await withPgRest(restId, (client, ctx) =>
      pgCatalog.getEmployee(client, ctx.restaurantUuid, staffId),
    { actingRole: req.nestaAuth?.role || "owner", userId: req.nestaAuth?.userId });
    if (employee?.__missingRestaurant) return res.status(404).json({ error: "Restaurant not found" });
    if (!employee) return res.status(404).json({ error: "Staff not found" });
    return res.status(404).json({ error: "No credential available" });
  }

  const encSnap = await systemGet(`credentials/${restId}/${staffId}/passwordEnc`);
  const encVal = encSnap.val();
  if (!encVal) return res.status(404).json({ error: "No credential available" });

  try {
    const plain = decryptSecret(encVal);
    res.json({ password: plain });
  } catch (err) {
    console.error("[GET /api/staff/:id/credential] decrypt error:", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── Normalizers ──────────────────────────────────────────────────────────────
function normalizeOrder(id, data) {
  const items = Array.isArray(data.items)
    ? data.items
    : Object.values(data.items||{});
  return {
    _id:         id,
    table:       Number(data.table||0),
    items:       items.map(i => ({
      name:  i.name,
      price: Number(i.price||0),
      qty:   Number(i.qty||1),
      image: i.image||i.img||"",
    })),
    total:       Number(data.total || calculateOrderTotal(items)),
    status:      data.status || "new",
    statusKey:   data.statusKey || mapStatus(data.status),
    statusLabel: data.statusLabel || data.status || "Yangi",
    chefId:      data.chefId || null,
    orderNumber: data.orderNumber || "",
    createdAt:   data.createdAt,
    updatedAt:   data.updatedAt,
  };
}

function normalizeStaff(id, data) {
  return {
    _id:       id,
    name:      data.name,
    role:      data.role,
    active:    data.active !== false,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
// Restaurant isolation (audit finding, fixed here): every "chefs"/"admins"
// room used to be ONE global room shared by every restaurant on this
// backend instance, and "admin-connect"/"chef-connect" joined it with no
// credential check at all — a raw Socket.IO connection (no browser, no
// login, nothing) could emit "admin-connect" and receive every restaurant's
// live order/delivery/payment data. Both rooms are now scoped per restId
// (`admins:${restId}`, `chefs:${restId}`), and joining either now requires
// the same identity check every REST endpoint already goes through
// (rbac.js's resolveRequestPermissions — the acting restId+userId/chefId
// must resolve to a real employee of THAT restaurant). Table rooms are
// scoped the same way via joinTableRooms/emitToTable above. `socket.restId`
// is recorded once at connect time and reused by every later event on that
// socket, so mid-session events (status updates, chat, etc.) inherit the
// same scope without needing every payload to repeat it.
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);
  socket.legacyJoinedRooms = [];

  const legacyAuthorityTimer = setInterval(async () => {
    if (!socket.legacyStaffVerified) return;
    const result = await revalidateLegacyStaffAuthority(socket, authorizeSocketJoin, { force: true });
    if (!result.ok) socket.emit("legacy:unauthorized", { error: result.code });
  }, LEGACY_STAFF_RECHECK_MS);
  legacyAuthorityTimer.unref?.();

  socket.on("client-connect", async (data={}) => {
    leaveOperationalRooms(socket);
    const token = data.token || socket.handshake?.auth?.token || socket.handshake?.query?.token || "";
    const identity = await resolveIdentity({
      headers: { authorization: token ? `Bearer ${token}` : "" },
      ip: socket.handshake?.address,
      originalUrl: "socket:client-connect",
    }).catch(() => ({ verified: false }));
    const decision = authorizeLegacyClientConnect({ identity, requestedRestId: data.restId });
    if (!decision.ok) {
      logSecurityEvent({
        type: "socket_join_denied",
        restId: data.restId || null,
        userId: identity?.userId || null,
        ip: socket.handshake?.address,
        details: { event: "client-connect", error: decision.code },
      });
      return;
    }
    const clientId = String(data.clientId || socket.id);
    socket.clientId = clientId;
    socket.table = decision.table || "";
    socket.role = "client";
    socket.isCustomer = true;
    socket.restId = null;
    socket.customerRestId = decision.restId;
    rooms.clients.set(clientId, socket.id);
    for (const room of decision.joinRooms) socket.join(room);
  });

  const handleStaffConnect = async (data={}, kind) => {
    leaveOperationalRooms(socket);
    const requestedUserId = String(kind === "chef" ? (data.chefId || data.id || "") : (data.userId || ""));
    const restId = String(data.restId || "");
    const allowedRoles = kind === "chef" ? CHEF_CONNECT_ROLES : ADMIN_CONNECT_ROLES;
    if (!requestedUserId || !restId || !isSafeId(requestedUserId) || !isSafeId(restId)) return;
    const token = data.token || socket.handshake?.auth?.token || socket.handshake?.query?.token || "";
    const identity = await resolveIdentity({
      headers: { authorization: token ? `Bearer ${token}` : "" },
      ip: socket.handshake?.address,
      originalUrl: `socket:${kind}-connect`,
    }).catch(() => ({ verified: false }));
    const authz = await authorizeSocketJoin({ token, restId, userId: requestedUserId }).catch(() => null);
    const decision = authorizeLegacyStaffConnect({
      identity, authz, requestedRestId: restId, requestedUserId, allowedRoles,
    });
    if (!decision.ok) {
      logSecurityEvent({
        type: "socket_join_denied",
        restId,
        userId: requestedUserId,
        ip: socket.handshake?.address,
        details: { event: `${kind}-connect`, error: decision.code },
      });
      return;
    }
    rememberLegacyStaff(socket, {
      token, restId: decision.restId, userId: decision.userId, kind, allowedRoles, authz,
      chefId: kind === "chef" ? requestedUserId : null,
    });
    if (kind === "chef") socket.chefName = data.name || data.chefName || "Chef";
    joinOperationalRooms(socket, staffRoomsForConnect(decision.restId, kind));
    if (kind === "chef") {
      rooms.chefs.set(requestedUserId, { socketId: socket.id, restId: decision.restId });
      broadcastActiveOrders(requestedUserId, decision.restId);
    }
  };
  socket.on("chef-connect",  (data={}) => handleStaffConnect(data, "chef"));
  socket.on("chef:join",     (data={}) => handleStaffConnect(data, "chef"));

  socket.on("admin-connect", (data={}) => handleStaffConnect(data, "admin"));

  async function requireLegacyStaffOp(event) {
    return authorizeLegacyPrivilegedEmit(socket, event, authorizeSocketJoin);
  }

  socket.on("new-order", async (data={}) => {
    const decision = await requireLegacyStaffOp("new-order");
    if (!decision.ok) return;
    const orderId = String(data.orderId||"");
    const restId = decision.restId;
    if (!orderId) return;
    trackOrder(orderId, { chefId:null, table:data.order?.table, status:data.order?.status||"new", clientId:socket.clientId||null, restId });
    io.to(`chefs:${restId}`).emit("new-order", { orderId, order: data.order, timestamp: Date.now() });
    socket.emit("order-created", { orderId, status:"created" });
  });

  socket.on("chef:new-order", async (data={}) => {
    const decision = await requireLegacyStaffOp("chef:new-order");
    if (!decision.ok || !data.orderId) return;
    const restId = decision.restId;
    trackOrder(data.orderId, { chefId: data.chefId||null, table: data.table||null, status:"approved", restId });
    const payload = { ...data, timestamp: Date.now() };
    if (data.chefId) {
      const entry = rooms.chefs.get(String(data.chefId));
      if (entry) io.to(entry.socketId).emit("chef:new-order", payload);
    }
    io.to(`chefs:${restId}`).emit("chef:new-order", payload);
  });

  socket.on("order-assigned", async (data={}) => {
    const decision = await requireLegacyStaffOp("order-assigned");
    if (!decision.ok) return;
    const { orderId, chefId, table } = data;
    const restId = decision.restId;
    if (!orderId) return;
    trackOrder(orderId, { chefId:chefId||null, table:table||null, status:"Tasdiqlandi", restId });
    const entry = rooms.chefs.get(String(chefId||""));
    if (entry) {
      io.to(entry.socketId).emit("order-assigned", data);
      io.to(entry.socketId).emit("chef:new-order", { orderId, chefId, table, orderNumber: data.orderNumber||orderId, timestamp: Date.now() });
    }
    emitToTable(table, "order-accepted", { orderId, status:"Tasdiqlandi", chefId }, restId);
  });

  socket.on("chef-status-update", async (data={}) => {
    const decision = await requireLegacyStaffOp("chef-status-update");
    if (!decision.ok) return;
    const { orderId, status, chefId, table, orderNumber } = data;
    const restId = decision.restId;
    if (!orderId) return;
    trackOrder(orderId, { chefId: chefId||socket.chefId||null, table:table||null, status, restId });
    const payload = {
      orderId, status,
      statusKey:   mapStatus(status),
      statusLabel: status,
      chefId:      chefId||socket.chefId||null,
      chefName:    socket.chefName||data.chefName||"Chef",
      orderNumber: orderNumber||"",
      table:       table||null,
      timestamp:   Date.now(),
    };
    emitToTable(table, "order-status-update", payload, restId);
    socket.to(`chefs:${restId}`).emit("other-chef-status", payload);
    io.to(`chefs:${restId}`).emit("chef:status-updated", payload);
    io.to(`admins:${restId}`).emit("order-status-changed", payload);
    io.to(`rest-${restId}`).emit("order:updated", payload);
  });

  socket.on("payment-request", async (data={}) => {
    const decision = await requireLegacyStaffOp("payment-request");
    if (!decision.ok) return;
    io.to(`admins:${decision.restId}`).emit("payment-request", { ...data, clientId: socket.clientId||null, timestamp: Date.now() });
  });

  socket.on("payment-approved", async (data={}) => {
    const decision = await requireLegacyStaffOp("payment-approved");
    if (!decision.ok) return;
    const { orderId, table, clientId } = data;
    const restId = decision.restId;
    const s = rooms.clients.get(String(clientId||""));
    if (s) io.to(s).emit("payment-approved", { orderId, approved:true, timestamp: Date.now() });
    emitToTable(table, "payment-approved", { ...data, approved:true, timestamp: Date.now() }, restId);
  });

  socket.on("chef-message", async (data={}) => {
    const decision = await requireLegacyStaffOp("chef-message");
    if (!decision.ok) return;
    const restId = decision.restId;
    const payload = { ...data, chefName: data.chefName||socket.chefName||"Chef", timestamp: Date.now() };
    emitToTable(data.table, "chef-message", payload, restId);
    io.to(`chefs:${restId}`).emit("chef:chat-message", payload);
  });

  socket.on("chef:chat-message", async (data={}) => {
    const decision = await requireLegacyStaffOp("chef:chat-message");
    if (!decision.ok) return;
    io.to(`chefs:${decision.restId}`).emit("chef:chat-message", { ...data, timestamp: Date.now() });
  });

  socket.on("table-force-closed", async (data={}) => {
    const decision = await requireLegacyStaffOp("table-force-closed");
    if (!decision.ok) return;
    const restId = decision.restId;
    const payload = { table: data.table, reason: data.reason||"Admin closed the table", timestamp: Date.now() };
    emitToTable(data.table, "table-force-closed", payload, restId);
    io.to(`chefs:${restId}`).emit("table-closed", payload);
    io.to(`chefs:${restId}`).emit("chef:table-update", { ...payload, status:"closed" });
    rooms.tables.delete(`${restId}-${String(data.table||"")}`);
  });

  socket.on("session-reset", async (data={}) => {
    const decision = await requireLegacyStaffOp("session-reset");
    if (!decision.ok) return;
    for (const [orderId, od] of rooms.orders.entries()) {
      if (od.clientId === data.clientId) rooms.orders.delete(orderId);
    }
  });

  socket.on("menu-updated", async () => {
    const decision = await requireLegacyStaffOp("menu-updated");
    if (!decision.ok) return;
    io.to(`rest-${decision.restId}`).emit("menu-updated", { timestamp: Date.now(), restId: decision.restId });
  });

  socket.on("disconnect", () => {
    clearInterval(legacyAuthorityTimer);
    leaveOperationalRooms(socket);
    if (socket.role === "client" && socket.clientId) rooms.clients.delete(socket.clientId);
    if (socket.chefId) rooms.chefs.delete(socket.chefId);
    const tableKey = socket.restId ? `${socket.restId}-${String(socket.table||"")}` : String(socket.table||"");
    if (socket.table && rooms.tables.has(tableKey)) {
      rooms.tables.get(tableKey).delete(socket.id);
    }
  });
});

// ─── Static + Listen ──────────────────────────────────────────────────────────
const staticPath = path.join(__dirname, "../admin-frontend/public");

// P1-3 fix (PRODUCTION-AUDIT.md): express.static() below serves EVERY file
// under admin-frontend/public by default, including old .bak snapshots
// (admin.html.bak, superadmin.html.bak, ...) left over from earlier editing
// sessions — confirmed live: admin.html.bak (500KB) was fetchable at
// /admin.html.bak with a plain HTTP 200 before this fix. These are old
// application source, not user data — spot-checked for secrets (none found;
// backend secrets live in backend/.env, never in admin-frontend/public) —
// but still real, unnecessary disclosure of superseded code. This ONLY
// blocks the HTTP response; the .bak files themselves are left alone on
// disk (not deleted) in case they're still useful as local backups.
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith(".bak")) {
    return res.status(404).end();
  }
  next();
});

app.use(express.static(staticPath, {
  // HTML documents (superadmin.html, admin.html, login.html, ...) must
  // NEVER be served from a stale browser cache — this is an actively
  // developed app, and express.static's default (etag/lastModified only,
  // no explicit Cache-Control) leaves browsers free to apply heuristic
  // freshness and skip revalidation entirely for a while, which repeatedly
  // caused "the fix is in the file but the browser is still running old
  // behavior" symptoms (e.g. a removed <script> tag/UI section appearing
  // to still be present). JS/CSS/image assets are unaffected by this —
  // they keep the default etag-based revalidation, and the ones that
  // matter most already carry an explicit ?v= cache-buster in their
  // <script src> reference.
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    }
  },
}));

// ─── Global error handler → instant "System Error" notification ─────────────
// Must be registered after every route/static middleware (Express only
// invokes 4-arg handlers for errors passed to next(err) or thrown in an
// async route). Rate-limited per error message so a repeating failure
// doesn't spam the channel — satisfies spec section 14 ("only send changed
// alerts once").
const _recentErrorAlerts = new Map();
app.use((err, req, res, _next) => {
  console.error("Unhandled request error", { method: req.method, path: req.path });
  const restId = getRestId(req);
  if (restId) {
    const key = `${restId}:request-error`;
    const last = _recentErrorAlerts.get(key) || 0;
    if (Date.now() - last > 10 * 60 * 1000) {
      _recentErrorAlerts.set(key, Date.now());
      NotificationService.send(NOTIFICATION_TYPES.SYSTEM_ERROR, restId, null, { message: "A request failed" }).catch(() => {});
    }
  }
  if (!res.headersSent) {
    const failure = classifyStaffMutationFailure(err, isPgUnavailableError);
    res.status(failure.status).json(failure.body);
  }
});

const PORT = Number(process.env.PORT || 4000);
if (!usePostgres()) connectDB();

try {
  assertQrSigningConfigured();
  assertIsolatedAuthEnvironment();
} catch (err) {
  console.error("[startup] configuration failed:", err.message);
  process.exit(1);
}

server.listen(PORT, "0.0.0.0", () => {
  const ifaces = os.networkInterfaces();
  let localIp = "localhost";
  for (const iface of Object.values(ifaces)) {
    for (const alias of iface) {
      if (alias.family === "IPv4" && !alias.internal) { localIp = alias.address; break; }
    }
  }
  const pgCfg = maskedConfig();
  console.log(`🚀 Server: http://localhost:${PORT}`);
  console.log(`🌐 Network: http://${localIp}:${PORT}`);
  console.log(`📱 QR: http://${localIp}:${PORT}/table/1`);
  console.log(`❤️  Health: http://localhost:${PORT}/api/health`);
  console.log(`🗄️  Data backend: ${getDataBackend()}${pgCfg ? ` (postgres ${pgCfg.user}@${pgCfg.host}:${pgCfg.port}/${pgCfg.database})` : ""}`);
  logAuthEnvironment();
});

// P2 fix (PRODUCTION-AUDIT.md #17): no SIGTERM/SIGINT handler existed, so a
// process manager restart/redeploy (or Ctrl+C locally) killed in-flight
// requests and open Socket.IO connections outright instead of draining them.
// Minimal fix: stop accepting new connections, let Socket.IO close its
// sockets and in-flight HTTP requests finish naturally, then exit — with a
// hard timeout fallback, since open WebSocket/long-poll connections don't
// end on their own and would otherwise hang the process indefinitely.
let _shuttingDown = false;
function gracefulShutdown(signal) {
  if (_shuttingDown) return; // ignore a second signal while already draining
  _shuttingDown = true;
  console.log(`\n[shutdown] ${signal} received — draining connections...`);
  const forceExitTimer = setTimeout(() => {
    console.warn("[shutdown] Drain timed out after 10s — forcing exit.");
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();
  io.close(() => {
    server.close((err) => {
      clearTimeout(forceExitTimer);
      if (err) {
        console.error("[shutdown] Error while closing HTTP server:", err.message);
        process.exit(1);
      }
      console.log("[shutdown] All connections drained — exiting cleanly.");
      process.exit(0);
    });
  });
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
