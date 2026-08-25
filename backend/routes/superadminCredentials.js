// routes/superadminCredentials.js
//
// Backs the superadmin panel's "Restoran login ma'lumotlari" (restaurant
// credentials) modal. Root cause of the bug this fixes: the modal's
// password field used to come ONLY from window._justCreatedCredentials, an
// in-memory JS object populated exclusively inside saveNewRestaurant()'s
// own execution — nothing persisted it anywhere, so it was gone on refresh
// and never existed at all for restaurants created in an earlier session.
//
// Architecture: two SEPARATE password-related fields now live on
// restaurants/{restId}/users/{uid}, written by two SEPARATE, unrelated
// code paths — this separation is deliberate and must be preserved:
//
//   - `password` — bcrypt hash (or legacy plaintext/SHA-256 pending self-
//     migration). Written by the EXISTING frontend restaurant-creation
//     flow (superadmin.js's saveNewRestaurant()) and by backend/security/
//     password.js's self-migration. The ONLY field routes/auth.js's
//     manager-login / verifyPassword() ever reads. This file NEVER reads
//     or decides login based on this field, and only writes it when
//     explicitly rotating a password (see POST .../set with rotateHash).
//
//   - `passwordEnc` — AES-256-GCM ciphertext (backend/security/crypto.js,
//     server-only ENCRYPTION_KEY, never sent to any client) of the SAME
//     plaintext password. Written ONLY by this file. Read ONLY by this
//     file's reveal endpoint, ONLY for a verified superadmin session. This
//     is what makes the credentials modal's password persist across
//     refreshes and work for every restaurant, not just the most recently
//     created one in the current browser tab.
//
// Authorization: every route below requires a Firebase ID token (Admin SDK
// verified) that carries NO restId claim. This is not a new, weaker trust
// boundary invented for this file — it is the EXACT signal database.
// rules.json's header comment already documents as "how a superadmin
// session is told apart from an employee/client one": every staff login
// (routes/auth.js mintSessionToken) and QR customer session (routes/qr.js)
// always carries a restId claim; only the superadmin panel's real Firebase
// Auth email/password session never does. A request with no token, an
// invalid token, or a token WITH a restId claim (any restaurant's own
// admin/manager/staff) is rejected — closing exactly the two cases the
// task asked for: "oddiy admin boshqa restoran parolini ko'ra olmasin" and
// "restaurant admin o'zidan boshqa restaurant passwordini ko'ra olmasin".
import express from "express";
import { systemGet, systemUpdate } from "../systemDb.js";
import { hashPassword } from "../security/password.js";
import { encryptSecret, decryptSecret } from "../security/crypto.js";
import { isSafeId } from "../security/sanitize.js";
import { requireSuperAdmin } from "../security/requireSuperAdmin.js";

const router = express.Router();

// Exported (Auth root-cause fix pass) so routes/auth.js's new /login-as
// endpoint can reuse the exact same verified-superadmin check instead of
// duplicating it — one canonical definition of "what counts as a real
// superadmin session" for every place that needs it.
router.use(requireSuperAdmin);

// GET /api/superadmin/credentials/:restId/:uid/status
// Safe metadata only — never the password itself, never a hash. Lets the
// modal render the correct UI (dots+eye vs "not available") the moment it
// opens, for every restaurant, without a full reveal round-trip.
router.get("/:restId/:uid/status", async (req, res) => {
  const { restId, uid } = req.params;
  if (!isSafeId(restId) || !isSafeId(uid)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    const snap = await systemGet(`restaurants/${restId}/users/${uid}`);
    if (!snap.exists()) return res.status(404).json({ error: "Not found" });
    const user = snap.val() || {};
    // P0-2 residual-gap fix: passwordEnc now lives at
    // credentials/${restId}/${uid}/passwordEnc, not on the user record
    // itself — see database.rules.json's "credentials" tree comment.
    const credSnap = await systemGet(`credentials/${restId}/${uid}/passwordEnc`);
    return res.json({
      login: user.login || null,
      hasEncryptedPassword: !!credSnap.val(),
    });
  } catch (err) {
    console.error("[superadminCredentials] status error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/superadmin/credentials/:restId/:uid/reveal
// Decrypts server-side and returns plaintext ONLY to an already-verified
// superadmin session. Never logs the password itself.
router.post("/:restId/:uid/reveal", async (req, res) => {
  const { restId, uid } = req.params;
  if (!isSafeId(restId) || !isSafeId(uid)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    // P0-2 residual-gap fix: passwordEnc now lives at
    // credentials/${restId}/${uid}/passwordEnc — see database.rules.json's
    // "credentials" tree comment.
    const snap = await systemGet(`credentials/${restId}/${uid}/passwordEnc`);
    const encVal = snap.val();
    if (!encVal) {
      return res.status(404).json({ error: "Password not available for reveal" });
    }
    const plain = decryptSecret(encVal);
    logSecurityEvent({
      type: "superadmin_credential_revealed",
      restId,
      ip: req.ip,
      details: { uid, by: req.superAdminUid },
    });
    return res.json({ password: plain });
  } catch (err) {
    console.error("[superadminCredentials] reveal error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/superadmin/credentials/:restId/:uid/set   body: { password, rotateHash? }
//
// Two callers, same endpoint:
//   1. Right after saveNewRestaurant() (superadmin.js) creates a new
//      restaurant's admin_1 — that flow still computes/writes the login
//      `password` hash itself, UNCHANGED; this call ONLY adds the
//      reversible passwordEnc copy (rotateHash omitted/false).
//   2. The "Yangi parol o'rnatish" rotation UI, for restaurants that only
//      ever had a passwordHash (pre-dating this feature, cannot be
//      decrypted — see the file header). rotateHash:true also replaces
//      the bcrypt hash via the SAME hashPassword() login already trusts,
//      so the new password works for normal login immediately.
router.post("/:restId/:uid/set", async (req, res) => {
  const { restId, uid } = req.params;
  const password = String(req.body?.password || "");
  const rotateHash = req.body?.rotateHash === true;

  if (!isSafeId(restId) || !isSafeId(uid)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ error: "Password too short" });
  }

  try {
    const userSnap = await systemGet(`restaurants/${restId}/users/${uid}`);
    if (!userSnap.exists()) return res.status(404).json({ error: "Not found" });

    // P0-2 residual-gap fix: password/passwordEnc now written to
    // credentials/${restId}/${uid}, not the user record itself — see
    // database.rules.json's "credentials" tree comment.
    const updates = { passwordEnc: encryptSecret(password) };
    if (rotateHash) {
      updates.password = await hashPassword(password);
    }
    await systemUpdate(`credentials/${restId}/${uid}`, updates);

    logSecurityEvent({
      type: "superadmin_credential_set",
      restId,
      ip: req.ip,
      details: { uid, rotateHash, by: req.superAdminUid },
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[superadminCredentials] set error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;
