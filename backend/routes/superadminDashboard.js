// routes/superadminDashboard.js — Superadmin dashboard's systemData regression fix.
//
// Root cause this file fixes: the Superadmin dashboard (admin-frontend/
// public/js/superadmin.js) reads/writes several systemData/* paths directly
// with the Firebase CLIENT SDK — health pings, payment history (the "Всего
// поступивших средств" / total-revenue KPI), the audit log, and the login-
// history entry written on every dashboard load. database.rules.json locks
// `systemData` down completely — ".read": false, ".write": false,
// unconditionally, for every client, superadmin included — so all of these
// now fail with permission_denied. That lockdown was deliberate (systemData
// is backend-only data: security log, Payme transaction index, and — since
// it's the same root — everything superadmin.js was also storing there) and
// is NOT relaxed here. Instead, each of these reads/writes moves behind a
// verified-superadmin-only backend endpoint that uses the Firebase Admin SDK
// (bypasses Security Rules entirely, by design — only this trusted backend
// process holds that credential), same pattern as routes/
// superadminCredentials.js (requireSuperAdmin below is intentionally the
// same check, copied rather than shared, matching that file's own
// self-contained style).
//
// Scope (see SUPERADMIN-DASHBOARD-RULES-FIX.md-equivalent report for the
// full path-by-path trace): only the systemData paths that fire
// UNCONDITIONALLY on every dashboard load are covered here — health ping,
// payment history (read + the 3 write call sites that record a
// license/payment), audit log (read + the single shared logAudit() writer,
// 62 call sites unaffected since they all go through that one function),
// and the login-history write. systemData/activeSessions, the 2FA trees,
// promoCodes, broadcastHistory, and settings/* are gated behind opening a
// specific secondary tab and were not part of the confirmed regression —
// deliberately left out of this pass (see the fix report's "Remaining
// Issues").
import express from "express";
import { getAdminAuth, getAdminDb } from "../firebaseAdmin.js";
import { systemGet, systemPush, systemQueryOrderedLimit } from "../systemDb.js";
import { requireSuperAdmin } from "../security/requireSuperAdmin.js";

const router = express.Router();

// Identical authorization model/check as routes/superadminCredentials.js's
// requireSuperAdmin — a verified Firebase ID token carrying NO restId claim
// and not an anonymous session. See that file's header for the full
// rationale; duplicated here rather than imported since neither file
// exports it and this app's routers each define their own auth middleware
// (see routes/notifications.js, routes/aiImport.js, etc.).
router.use(requireSuperAdmin);

router.get("/health", async (req, res) => {
  const db = getAdminDb();
  const authInst = getAdminAuth();

  async function timeIt(fn) {
    const t0 = Date.now();
    try {
      await fn();
      return { ms: Date.now() - t0 };
    } catch (err) {
      return { error: err?.message || "check failed" };
    }
  }

  const [rtdb, authCheck, storage, functionsCheck] = await Promise.all([
    timeIt(async () => {
      await db.ref("systemData/_healthPing").set(Date.now());
      const snap = await db.ref("systemData/_healthPing").once("value");
      if (!snap.exists()) throw new Error("ping read failed");
    }),
    timeIt(() => authInst.listUsers(1)),
    timeIt(() => Promise.all([
      db.ref("systemData/_healthPingS1").set(Date.now()),
      db.ref("systemData/_healthPingS2").set(Date.now()),
    ])),
    timeIt(async () => {
      await db.ref("systemData/_healthPingF").set(Date.now());
      const snap = await db.ref("systemData/_healthPingF").once("value");
      if (!snap.exists()) throw new Error("ping read failed");
    }),
  ]);

  res.json({ rtdb, auth: authCheck, storage, functions: functionsCheck });
});

// ─── Restaurants (list) ──────────────────────────────────────────────────
// Restaurant-count-0 fix: superadmin.js's listenRestaurants() used to read
// the bare "restaurants" RTDB collection directly with the client SDK
// (onValue(ref(db,"restaurants"),...)). database.rules.json's ".read" is
// defined only at restaurants/$restId (a descendant path) — never at bare
// "restaurants" or root — and a rule on a descendant never authorizes a
// bulk read of the parent collection above it. That read has been
// permission_denied for every session, superadmin included, since the
// current rules structure shipped; unrelated to auth state or rate
// limiting. Admin SDK bypasses Security Rules by design (same pattern as
// every other route in this file), but a raw pass-through of the full
// restaurants tree would return far more than this dashboard needs — full
// menu/orders/tables data, and, for any restaurant whose legacy
// pre-credentials-migration users/$uid/password(/Enc) stub hasn't been
// cleared yet, literal credential material (that stub's own ".read":false
// in the rules file only protects it from *client* reads through Security
// Rules; it does nothing against a raw Admin SDK read like this one, which
// is exactly why it's filtered out here explicitly rather than trusted).
// Projected down to exactly what superadmin.js's restaurant list/table/
// growth-charts/activity-ranking/tag-editor/modules-editor/new-restaurant
// login-uniqueness-check/"new users today" stat actually read off each
// record (grepped across every rest./r.-prefixed access in that file):
// info, subscription, modules in full (none of their fields are secret —
// address/domain/email/phone/tariff/status/etc., the same restaurant
// business metadata this dashboard already edits directly elsewhere), and
// users reduced to {login, createdAt} per employee only — never name,
// phone, role, permissions, or any credential field.
//
// ordersCount (Dashboard activity-ranking task): the actual `orders` object
// per restaurant is deliberately NOT included above (order contents are
// customer/business data this dashboard has no reason to see in bulk) — but
// window.calculateActivityScore()/updateActivityRanking() need a real order
// COUNT per restaurant to rank activity, and this was the one number
// missing from anywhere client-reachable (confirmed: restaurants/$id/stats
// is never written by any part of this codebase, so the activity-score
// function's old `stats.totalOrders` read was always 0 — dead code).
// Since `snap` above already holds the full tree in memory (Admin SDK read,
// same cost either way), counting Object.keys(rest.orders) here is free —
// no extra Firebase read, and only a single integer leaves the server per
// restaurant, never the orders themselves. This is why no new endpoint was
// added for this task: this one already returns exactly the restaurant
// list the dashboard needs, just missing this one field.
router.get("/restaurants", async (req, res) => {
  try {
    const snap = await systemGet("restaurants");
    const raw = snap.exists() ? snap.val() : {};
    const projected = {};
    for (const [restId, rest] of Object.entries(raw)) {
      const users = {};
      for (const [uid, u] of Object.entries(rest?.users || {})) {
        users[uid] = { login: u?.login ?? null, createdAt: u?.createdAt ?? null };
      }
      projected[restId] = {
        info: rest?.info || {},
        subscription: rest?.subscription || {},
        modules: rest?.modules || {},
        users,
        ordersCount: rest?.orders ? Object.keys(rest.orders).length : 0,
      };
    }
    res.json(projected);
  } catch (err) {
    console.error("[superadminDashboard] restaurants read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// ─── Payment history ────────────────────────────────────────────────────
// Backs the revenue KPI ("Всего поступивших средств" / updateRevenueByFilter)
// and listenPaymentHistory()'s table. Same object-keyed-by-push-id shape
// the client already handles (Object.values(...)) — only the transport
// changes, so no client-side reshaping is needed beyond swapping the fetch.
router.get("/payment-history", async (req, res) => {
  try {
    const snap = await systemQueryOrderedLimit("systemData/paymentHistory", "date", 1000);
    res.json(snap.exists() ? snap.val() : {});
  } catch (err) {
    console.error("[superadminDashboard] payment-history read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// Replaces the 3 direct client push() call sites (saveNewRestaurant's
// license-creation record, the manual "record payment" flow, and
// logPaymentToHistory()). Body is passed through mostly as-is (same fields
// the client already built: restaurantName/restaurantId/amount/method/
// months/trialDays/oneTimeFee/promoCode/promoDiscount/newTariff) — `date`
// is set server-side rather than trusted from the client, since this is
// financial/audit data.
router.post("/payment-history", async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Invalid payload" });
    }
    const record = { ...body, date: Date.now() };
    const key = await systemPush("systemData/paymentHistory", record);
    res.json({ ok: true, key });
  } catch (err) {
    console.error("[superadminDashboard] payment-history write failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// ─── Audit log ───────────────────────────────────────────────────────────
// Backs the "Faoliyat jurnali" (audit view) table and the license-history
// section listenPaymentHistory() also derives from this same tree.
router.get("/audit-log", async (req, res) => {
  try {
    const snap = await systemQueryOrderedLimit("systemData/auditLogs", "timestamp", 1000);
    res.json(snap.exists() ? snap.val() : {});
  } catch (err) {
    console.error("[superadminDashboard] audit-log read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// Replaces window.logAudit's push() — a single shared function with 62 call
// sites elsewhere in superadmin.js, none of which needed to change; only
// logAudit's own body was repointed at this endpoint. `actor` is preferred
// from the verified token's email (can't be spoofed) over whatever the
// client sent, when available; `timestamp` is always server-set for the
// same reason payment-history's `date` is.
router.post("/audit-log", async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Invalid payload" });
    }
    const entry = {
      action: body.action || null,
      restName: body.restName || null,
      details: body.details || null,
      actor: req.superAdminEmail || body.actor || "SuperAdmin",
      timestamp: Date.now(),
      ip: req.ip || null,
      device: body.device || null,
    };
    const key = await systemPush("systemData/auditLogs", entry);
    res.json({ ok: true, key });
  } catch (err) {
    console.error("[superadminDashboard] audit-log write failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// ─── Login history (write side) ─────────────────────────────────────────
// Replaces scLogLogin()'s push() — fires once per dashboard page load, so
// this was one of the two confirmed-in-console regressions. uid/email are
// taken from the verified token, not trusted from the client body, since
// this is itself a security log.
router.post("/login-history", async (req, res) => {
  try {
    const body = req.body || {};
    const entry = {
      uid: req.superAdminUid,
      name: body.name || req.superAdminEmail || "SuperAdmin",
      email: req.superAdminEmail || body.email || null,
      result: body.result === "failed" ? "failed" : "success",
      browser: body.browser || null,
      os: body.os || null,
      deviceLabel: body.deviceLabel || null,
      deviceId: body.deviceId || null,
      ip: req.ip || null,
      timestamp: Date.now(),
    };
    const key = await systemPush("systemData/loginHistory", entry);
    res.json({ ok: true, key });
  } catch (err) {
    console.error("[superadminDashboard] login-history write failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// Read side (Stage 2 of the migration) — replaces scStartListeners()'s
// onValue(systemData/loginHistory) in the Security Center module. Same
// object-keyed-by-push-id shape the client's _scVisibleLoginEntries()/
// scRenderLoginHistory() already expect.
router.get("/login-history", async (req, res) => {
  try {
    const snap = await systemQueryOrderedLimit("systemData/loginHistory", "timestamp", 1000);
    res.json(snap.exists() ? snap.val() : {});
  } catch (err) {
    console.error("[superadminDashboard] login-history read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

export default router;
