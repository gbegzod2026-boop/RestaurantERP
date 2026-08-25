// routes/superadminSessions.js — Superadmin systemData migration, Stage 2:
// Active Sessions + Devices (Security Center module in superadmin.js).
//
// systemData/activeSessions/{sessionId} and systemData/disabledDevices/
// {deviceId} were written/read directly via the client SDK
// (scStartSession/scHeartbeat/scEndSession/scTerminateSession/
// scDeviceToggleDisable and the two onValue listeners in scStartListeners).
// database.rules.json's unconditional systemData lockdown denies all of
// that now — every route below requires a verified superadmin/platform
// session (requireSuperAdmin) and goes through the Admin SDK.
//
// Sessions here are exclusively Superadmin-PANEL sessions (started from
// superadmin.js's own onAuthStateChanged handler) — restaurant staff/QR
// customer logins are a completely separate flow (routes/auth.js,
// routes/qr.js) and never appear in this tree. Every verified
// non-restId, non-anonymous session is treated as a platform-level peer
// able to view/terminate any session here — this mirrors the trust
// boundary the ORIGINAL (pre-lockdown) Firebase rules already granted to
// any restId==null session; it is not a new, broader grant introduced by
// this migration. Fine-grained "view own vs. view all" (the
// canViewAllSessions permission check) stays exactly as it was: a
// CLIENT-side filter over the full list this endpoint returns (unchanged
// behavior, not a security boundary — matches how it worked before too,
// since the old Firebase rules never enforced that distinction server-side
// either).
import express from "express";
import { systemGet, systemPush, systemSet, systemUpdate, systemRemove } from "../systemDb.js";
import { requireSuperAdmin } from "../security/requireSuperAdmin.js";

const router = express.Router();
router.use(requireSuperAdmin);

function clean(str, max = 200) {
  return typeof str === "string" ? str.slice(0, max) : null;
}

// ─── Active Sessions ─────────────────────────────────────────────────────
router.get("/active-sessions", async (req, res) => {
  try {
    const snap = await systemGet("systemData/activeSessions");
    res.json(snap.exists() ? snap.val() : {});
  } catch (err) {
    console.error("[superadminSessions] active-sessions read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// uid/name/email come from the verified token, NOT the request body —
// mirrors scLogLogin's identity handling in superadminDashboard.js.
router.post("/active-sessions/start", async (req, res) => {
  try {
    const body = req.body || {};
    const now = Date.now();
    const record = {
      uid: req.superAdminUid,
      name: clean(body.name) || req.superAdminEmail || "SuperAdmin",
      email: req.superAdminEmail || clean(body.email),
      browser: clean(body.browser),
      os: clean(body.os),
      deviceLabel: clean(body.deviceLabel),
      deviceId: clean(body.deviceId, 100),
      startedAt: now,
      lastSeenAt: now,
    };
    const key = await systemPush("systemData/activeSessions", record);
    res.json({ ok: true, sessionId: key });
  } catch (err) {
    console.error("[superadminSessions] session start failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/active-sessions/:sessionId/heartbeat", async (req, res) => {
  try {
    await systemUpdate(`systemData/activeSessions/${req.params.sessionId}`, { lastSeenAt: Date.now() });
    res.json({ ok: true });
  } catch (err) {
    // Non-critical, matches the old client's silent-catch heartbeat behavior.
    res.status(503).json({ error: "Unavailable" });
  }
});

// Covers scEndSession (own session), scTerminateSession (another session),
// scDeviceLogout/scDeviceForceLogout (loop over a device's session ids),
// and scTerminateAllSessions (loop over every visible session) — all of
// those were already just "remove this session id" client-side, so one
// DELETE route covers all four call sites.
router.delete("/active-sessions/:sessionId", async (req, res) => {
  try {
    await systemRemove(`systemData/activeSessions/${req.params.sessionId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[superadminSessions] session terminate failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// ─── Disabled Devices ────────────────────────────────────────────────────
router.get("/disabled-devices", async (req, res) => {
  try {
    const snap = await systemGet("systemData/disabledDevices");
    res.json(snap.exists() ? snap.val() : {});
  } catch (err) {
    console.error("[superadminSessions] disabled-devices read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/disabled-devices/:deviceId", async (req, res) => {
  try {
    const body = req.body || {};
    const deviceId = clean(req.params.deviceId, 200);
    if (!deviceId) return res.status(400).json({ error: "Invalid device id" });
    await systemSet(`systemData/disabledDevices/${deviceId}`, {
      deviceId,
      os: clean(body.os) || "",
      browser: clean(body.browser) || "",
      deviceLabel: clean(body.deviceLabel) || "",
      disabledAt: Date.now(),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[superadminSessions] disable device failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.delete("/disabled-devices/:deviceId", async (req, res) => {
  try {
    await systemRemove(`systemData/disabledDevices/${req.params.deviceId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[superadminSessions] enable device failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

export default router;
