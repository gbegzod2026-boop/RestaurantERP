// routes/superadmin2fa.js — Superadmin systemData migration, Stage 2: 2FA.
//
// Root cause + security upgrade: systemData/twoFactorSuperAdmin and
// systemData/platformUsers/{uid}/twoFactor are now closed to every client
// (database.rules.json), so the old client-side TOTP setup/verify flow
// (superadmin.js's scOpen2faSetup/scVerify2faSetup/scConfirmDisable2fa,
// using the browser-side OTPAuth library) can no longer read or write
// there directly. Beyond just fixing the permission error, this migration
// also does the hardening the OLD code's own header comment called for
// verbatim: "requires a Cloud Function (or similar backend) to store the
// secret and verify codes server-side" — TOTP codes are now generated
// (security/totp.js, hand-rolled RFC 6238, no new dependency) and verified
// ENTIRELY server-side, and the secret is encrypted at rest
// (security/crypto.js's encryptSecret/decryptSecret — the exact same
// helper routes/superadminCredentials.js already uses for passwordEnc).
// The raw secret is sent to the client exactly once, during setup, so it
// can be scanned into an authenticator app — standard, unavoidable TOTP UX,
// not a leak — and never again afterward. GET routes here never return a
// secret in any form, only `{enabled}` booleans.
//
// Identity resolution: the caller's OWN uid (from the verified token, never
// the request body) determines whether their 2FA record lives under
// systemData/platformUsers/{uid}/twoFactor (if that platformUsers entry
// exists) or systemData/twoFactorSuperAdmin (the raw superadmin account) —
// resolved server-side via a real DB lookup, not trusted from the client,
// unlike the old _scGetMy2faRecord() which relied on window.allPlatformUsers
// already being loaded client-side.
import express from "express";
import { systemGet, systemUpdate } from "../systemDb.js";
import { requireSuperAdmin } from "../security/requireSuperAdmin.js";
import { generateBase32Secret, verifyTotpCode, buildOtpAuthUri } from "../security/totp.js";
import { encryptSecret, decryptSecret } from "../security/crypto.js";

const router = express.Router();
router.use(requireSuperAdmin);

async function my2faPath(uid) {
  const snap = await systemGet(`systemData/platformUsers/${uid}`);
  return snap.exists() ? `systemData/platformUsers/${uid}/twoFactor` : "systemData/twoFactorSuperAdmin";
}

/** Decrypts whichever secret field is present — secretEnc (current
 *  format) or a legacy plaintext `secret` (written by the old client-side
 *  flow, before this migration, kept readable so an already-enabled
 *  account isn't locked out). */
function resolveSecret(record) {
  if (!record) return null;
  if (record.secretEnc) {
    try { return decryptSecret(record.secretEnc); } catch { return null; }
  }
  return record.secret || null;
}

router.get("/status", async (req, res) => {
  try {
    const path = await my2faPath(req.superAdminUid);
    const snap = await systemGet(path);
    const data = snap.exists() ? snap.val() : {};
    res.json({ enabled: !!data.enabled });
  } catch (err) {
    console.error("[superadmin2fa] status read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// Aggregate, booleans-only view across every platform user + the
// superadmin account — backs the Security Center dashboard's "2FA enabled"
// stat count and the device-drawer's per-user 2FA badge. Never returns
// secrets, names, emails, or any other platformUsers field.
router.get("/all-status", async (req, res) => {
  try {
    const [saSnap, puSnap] = await Promise.all([
      systemGet("systemData/twoFactorSuperAdmin"),
      systemGet("systemData/platformUsers"),
    ]);
    const superadmin = { enabled: !!(saSnap.exists() && saSnap.val()?.enabled) };
    const platformUsers = {};
    if (puSnap.exists()) {
      const all = puSnap.val() || {};
      for (const uid of Object.keys(all)) {
        platformUsers[uid] = { enabled: !!all[uid]?.twoFactor?.enabled };
      }
    }
    res.json({ superadmin, platformUsers });
  } catch (err) {
    console.error("[superadmin2fa] all-status read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// Generates a NEW secret and stores it PENDING (not yet enabled) — the
// account only becomes 2FA-protected once /2fa/verify-setup confirms the
// user actually has it in their authenticator app.
router.post("/setup", async (req, res) => {
  try {
    const path = await my2faPath(req.superAdminUid);
    const secret = generateBase32Secret();
    const label = req.superAdminEmail || "superadmin";
    await systemUpdate(path, {
      pendingSecretEnc: encryptSecret(secret),
      pendingCreatedAt: Date.now(),
    });
    res.json({ secret, otpauthUri: buildOtpAuthUri({ secretBase32: secret, accountLabel: label }), issuer: "Nesta ERP", label });
  } catch (err) {
    console.error("[superadmin2fa] setup failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/verify-setup", async (req, res) => {
  try {
    const code = req.body?.code;
    const path = await my2faPath(req.superAdminUid);
    const snap = await systemGet(path);
    const data = snap.exists() ? snap.val() : {};
    if (!data.pendingSecretEnc) {
      return res.status(400).json({ error: "No pending setup" });
    }
    const secret = decryptSecret(data.pendingSecretEnc);
    if (!verifyTotpCode(secret, code, 1)) {
      return res.status(400).json({ error: "Invalid code" });
    }
    await systemUpdate(path, {
      enabled: true,
      secretEnc: data.pendingSecretEnc,
      secret: null, // clear any legacy plaintext field
      enabledAt: Date.now(),
      pendingSecretEnc: null,
      pendingCreatedAt: null,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[superadmin2fa] verify-setup failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/disable", async (req, res) => {
  try {
    const code = req.body?.code;
    const path = await my2faPath(req.superAdminUid);
    const snap = await systemGet(path);
    const data = snap.exists() ? snap.val() : {};
    const secret = resolveSecret(data);
    if (!data.enabled || !secret) {
      // Nothing to disable — matches the old client's early-return when
      // there's no secret on record.
      return res.json({ ok: true });
    }
    if (!verifyTotpCode(secret, code, 1)) {
      return res.status(400).json({ error: "Invalid code" });
    }
    await systemUpdate(path, { enabled: false, secret: null, secretEnc: null, enabledAt: null });
    res.json({ ok: true });
  } catch (err) {
    console.error("[superadmin2fa] disable failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

export default router;
