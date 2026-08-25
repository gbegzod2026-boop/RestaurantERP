// routes/twoFactor.js — optional TOTP 2FA for restaurant owner/admin/manager
// accounts (the roles that log in via login.js's "Rahbar" email+password
// form — see rbac.js ROLE_TEMPLATES). Off by default, enabled per-employee
// via Settings, exactly as requested ("Majburiy emas, Settings orqali
// yoqiladigan"). Backward compatible: an account that never calls /setup
// behaves exactly as before — /verify only gets called by the login flow
// when the matched user's stored record has twoFactor.enabled === true.
//
// Trust model — Production Security Fix Pass, Phase 5 (verification pass):
// /setup, /enable, /disable, /status now resolve identity via rbac.js's
// resolveIdentity(), the same verified-Firebase-ID-token-preferred,
// x-user-id-header-fallback path every requirePermission()-gated route
// already uses. Previously these four routes trusted the raw x-user-id
// header directly with NO permission check at all — the exact "attacker who
// knows another employee's id can silently re-enroll 2FA under their own
// secret and lock the real owner out" scenario flagged in the original
// audit, and never actually closed until now. /verify is unchanged and
// intentionally still identity-free: it runs during login, before any
// session exists, and is protected by requiring the real TOTP/backup code.
import express from "express";
import { resolveRequestPermissions, resolveIdentity } from "../rbac.js";
import { generateBase32Secret, verifyTotpCode, buildOtpAuthUri, generateBackupCodes } from "../security/totp.js";
import { encryptSecret, decryptSecret, sha256Hex } from "../security/crypto.js";
import { isSafeId } from "../security/sanitize.js";
import { logSecurityEvent } from "../security/auditLog.js";
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so this file's own reads/writes go through the
// admin-or-client fallback (systemDb.js) — same reasoning as rbac.js/auth.js.
import { systemGet, systemUpdate } from "../systemDb.js";

const router = express.Router();

function getRestId(req) {
  return req.query.restId || req.body?.restId || req.headers["x-rest-id"] || process.env.DEFAULT_REST_ID || null;
}

const MANAGER_ROLES = new Set(["owner", "admin", "manager"]);

async function loadUser(restId, userId) {
  const snap = await systemGet(`restaurants/${restId}/users/${userId}`);
  return snap.exists() ? { data: snap.val() } : null;
}

// Resolves the acting user id via resolveIdentity() — a verified
// Authorization: Bearer <id-token> is REQUIRED (Production Security Fix
// Pass — P0-1, see PRODUCTION-AUDIT.md). This route file has no current
// frontend caller at all (verified during that audit: every 2FA UI in this
// app — superadmin.js's Security Center — writes directly to Firebase RTDB
// instead of calling these routes; login.js's 2FA-at-login check goes
// through routes/auth.js's own internal verify2FA(), not this router's
// /verify), so requiring verified identity here carries zero regression
// risk to anything currently working, and closes the exact "attacker who
// knows another employee's id can silently re-enroll 2FA under their own
// secret and lock the real owner out" scenario this file's own header
// comment already describes. Returns null (→ callers already 400 on a
// missing userId) both when no identity was provided at all AND when a
// verified session's restId claim doesn't match the restId this request is
// acting on — never when identity was merely unverified-but-present, since
// that path is no longer trusted at all.
async function resolveUserId(req, restId) {
  const identity = await resolveIdentity(req);
  if (!identity.verified) {
    logSecurityEvent({ type: "authz_denied", restId, userId: identity.userId || null, ip: req.ip, path: req.originalUrl, details: { reason: "unverified_identity", route: "2fa" } });
    return null;
  }
  if (identity.restId && identity.restId !== restId) return null;
  return identity.userId;
}

// ── Status: does the caller have 2FA enabled? Drives the Settings UI toggle state.
router.get("/2fa/status", async (req, res) => {
  const restId = getRestId(req);
  const userId = await resolveUserId(req, restId);
  if (!restId || !isSafeId(String(restId)) || !userId || !isSafeId(String(userId))) {
    return res.status(400).json({ error: "restId and x-user-id required" });
  }
  const found = await loadUser(restId, userId);
  if (!found) return res.status(404).json({ error: "User not found" });
  const tf = found.data.twoFactor || {};
  res.json({ enabled: !!tf.enabled, pending: !!tf.pendingSecretEnc && !tf.enabled });
});

// ── Setup: generate a new secret (not yet active — /enable confirms it with
// a real code first, so a typo'd/half-finished setup can never silently
// lock an account out).
router.post("/2fa/setup", async (req, res) => {
  const restId = getRestId(req);
  const userId = await resolveUserId(req, restId);
  if (!restId || !isSafeId(String(restId)) || !userId || !isSafeId(String(userId))) {
    return res.status(400).json({ error: "restId and x-user-id required" });
  }
  const found = await loadUser(restId, userId);
  if (!found) return res.status(404).json({ error: "User not found" });
  if (!MANAGER_ROLES.has(String(found.data.role || "").toLowerCase())) {
    return res.status(403).json({ error: "2FA is currently available for owner/admin/manager accounts" });
  }

  const secret = generateBase32Secret();
  const otpauthUri = buildOtpAuthUri({ secretBase32: secret, accountLabel: `${found.data.name || userId}@${restId}` });

  await systemUpdate(`restaurants/${restId}/users/${userId}/twoFactor`, {
    pendingSecretEnc: encryptSecret(secret),
    enabled: false,
    updatedAt: Date.now(),
  });

  // Secret is returned once, over HTTPS, to the account owner only (same
  // exposure window any TOTP setup flow needs — Google/GitHub/etc. all show
  // the raw secret once at setup time too).
  res.json({ secret, otpauthUri });
});

// ── Enable: confirm setup with a real code from the authenticator app.
router.post("/2fa/enable", async (req, res) => {
  const restId = getRestId(req);
  const userId = await resolveUserId(req, restId);
  const code = String(req.body?.code || "").trim();
  if (!restId || !isSafeId(String(restId)) || !userId || !isSafeId(String(userId))) {
    return res.status(400).json({ error: "restId and x-user-id required" });
  }
  const found = await loadUser(restId, userId);
  const pendingEnc = found?.data?.twoFactor?.pendingSecretEnc;
  if (!pendingEnc) return res.status(400).json({ error: "No pending 2FA setup — call /2fa/setup first" });

  const secret = decryptSecret(pendingEnc);
  if (!verifyTotpCode(secret, code)) {
    logSecurityEvent({ type: "2fa_enable_failed", restId, userId, ip: req.ip });
    return res.status(401).json({ error: "Invalid code" });
  }

  const backupCodes = generateBackupCodes();
  await systemUpdate(`restaurants/${restId}/users/${userId}/twoFactor`, {
    secretEnc: encryptSecret(secret),
    pendingSecretEnc: null,
    enabled: true,
    backupCodeHashes: backupCodes.map(sha256Hex),
    confirmedAt: Date.now(),
    updatedAt: Date.now(),
  });
  logSecurityEvent({ type: "2fa_enabled", restId, userId, ip: req.ip });

  // Backup codes shown exactly once, at enable time — standard practice
  // (Google/GitHub/etc.) so the account owner can save them offline.
  res.json({ ok: true, backupCodes });
});

// ── Disable: requires a valid current code (or unused backup code) so an
// attacker who merely hijacks a logged-in session can't turn 2FA off.
router.post("/2fa/disable", async (req, res) => {
  const restId = getRestId(req);
  const userId = await resolveUserId(req, restId);
  const code = String(req.body?.code || "").trim();
  if (!restId || !isSafeId(String(restId)) || !userId || !isSafeId(String(userId))) {
    return res.status(400).json({ error: "restId and x-user-id required" });
  }
  const found = await loadUser(restId, userId);
  const tf = found?.data?.twoFactor;
  if (!tf?.enabled || !tf.secretEnc) return res.status(400).json({ error: "2FA is not enabled" });

  const secret = decryptSecret(tf.secretEnc);
  const validTotp = verifyTotpCode(secret, code);
  const codeHash = sha256Hex(code);
  const validBackup = Array.isArray(tf.backupCodeHashes) && tf.backupCodeHashes.includes(codeHash);
  if (!validTotp && !validBackup) {
    logSecurityEvent({ type: "2fa_disable_failed", restId, userId, ip: req.ip });
    return res.status(401).json({ error: "Invalid code" });
  }

  await systemUpdate(`restaurants/${restId}/users/${userId}/twoFactor`, {
    enabled: false, secretEnc: null, pendingSecretEnc: null, backupCodeHashes: null, updatedAt: Date.now(),
  });
  logSecurityEvent({ type: "2fa_disabled", restId, userId, ip: req.ip });
  res.json({ ok: true });
});

// ── Verify: called by login.js AFTER the primary Firebase credential check
// already matched a user, only when that user's record has twoFactor.enabled.
// Heavily rate-limited (see security/rateLimit.js twoFactorLimiter mounted
// in server.js) since this is the one 6-digit-guessing surface in the app.
router.post("/2fa/verify", async (req, res) => {
  const restId = req.body?.restId;
  const userId = req.body?.userId;
  const code = String(req.body?.code || "").trim();
  if (!restId || !isSafeId(String(restId)) || !userId || !isSafeId(String(userId))) {
    return res.status(400).json({ error: "restId and userId required" });
  }
  const found = await loadUser(restId, userId);
  const tf = found?.data?.twoFactor;
  if (!tf?.enabled || !tf.secretEnc) {
    // Nothing to verify against — treat as pass-through so a race between
    // "just disabled 2FA" and a stale client never locks a real user out.
    return res.json({ ok: true, required: false });
  }

  const secret = decryptSecret(tf.secretEnc);
  const validTotp = verifyTotpCode(secret, code);
  const codeHash = sha256Hex(code);
  const backupIdx = Array.isArray(tf.backupCodeHashes) ? tf.backupCodeHashes.indexOf(codeHash) : -1;

  if (!validTotp && backupIdx === -1) {
    logSecurityEvent({ type: "2fa_login_failed", restId, userId, ip: req.ip });
    return res.status(401).json({ ok: false, required: true, error: "Invalid 2FA code" });
  }

  if (backupIdx !== -1) {
    // Backup codes are single-use — burn it.
    const remaining = tf.backupCodeHashes.filter((_, i) => i !== backupIdx);
    await systemUpdate(`restaurants/${restId}/users/${userId}/twoFactor`, { backupCodeHashes: remaining });
  }

  logSecurityEvent({ type: "2fa_login_success", restId, userId, ip: req.ip });
  res.json({ ok: true, required: true });
});

export default router;
