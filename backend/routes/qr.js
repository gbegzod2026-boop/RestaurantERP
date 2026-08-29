// routes/qr.js — Production Security Fix Pass, Phase 2 (High: QR security)
// + Phase 6 (Architecture: QR → Backend → Firebase Custom Token → Anonymous
// Firebase Auth → RTDB). See security/qrSign.js for the QR-signing
// rationale, and firebaseAdmin.js / routes/auth.js for the custom-token
// pattern this route reuses unchanged for customer sessions.
//
// Every QR scan (client.js, on page load) now calls POST /api/qr/session
// with the restId/table it resolved from the URL. This mints a Firebase
// Auth custom token carrying { restId, table } claims — the SAME mechanism
// routes/auth.js already uses for staff logins — which lets
// database.rules.json finally require `auth != null` on restaurants/$restId
// instead of leaving it open to any unauthenticated browser. Table/restId
// are not secrets (they're already in the QR URL itself, which is the
// whole point of a QR menu), so this endpoint isn't an authorization gate —
// it's what turns "an anonymous browser" into "a real, Firebase-Auth-backed
// anonymous customer session" so the rules layer has something to check.
import express from "express";
import crypto from "crypto";
import { signQrParams, verifyQrParams } from "../security/qrSign.js";
import { isSafeId } from "../security/sanitize.js";
import { isAdminAvailable, getAdminAuth } from "../firebaseAdmin.js";
import { assertAuthMintAllowed } from "../firebaseEnv.js";
import { resolveIdentity, resolveRequestPermissions } from "../rbac.js";
import { canonicalizeRestId } from "../pg/restId.js";
import { customerSessionUid, evaluateQrSessionMint } from "../pg/qrSession.js";

const router = express.Router();

function getRestId(req) {
  return req.query.restId || req.body?.restId || req.headers["x-rest-id"] || null;
}

// Called by admin.js when staff generate/print/download a table's QR code —
// see downloadSingleQR / downloadAllTablesQR.
router.get("/qr/sign", async (req, res) => {
  const identity = await resolveIdentity(req);
  if (!identity.verified) {
    return res.status(401).json({ error: "Authentication required", code: identity.tokenError || "token_missing" });
  }
  if (identity.isCustomer === true) {
    return res.status(403).json({ error: "Access Denied", code: "role_denied" });
  }
  const restId = getRestId(req);
  if (!restId || !isSafeId(String(restId))) {
    return res.status(400).json({ error: "Invalid restId", code: "restId_invalid" });
  }
  const canonical = canonicalizeRestId(restId);
  if (identity.platformSuperAdmin !== true) {
    if (!identity.restId || canonicalizeRestId(identity.restId) !== canonical) {
      return res.status(403).json({ error: "Access Denied", code: "restId_mismatch" });
    }
    const perms = await resolveRequestPermissions(canonical, identity.userId);
    if (!perms) return res.status(403).json({ error: "Access Denied", code: "role_denied" });
  }
  const table = req.query.table != null ? String(req.query.table) : "";
  const tableId = req.query.tableId != null ? String(req.query.tableId) : "";
  const { sig, exp } = signQrParams({ restId: canonical, table, tableId });
  res.json({ sig, exp });
});

// Called by client.js on page load when the URL carries a `sig` param.
router.get("/qr/verify", (req, res) => {
  const restId = getRestId(req);
  const table = req.query.table != null ? String(req.query.table) : "";
  const tableId = req.query.tableId != null ? String(req.query.tableId) : "";
  const { sig, exp } = req.query;
  const result = verifyQrParams({ restId, table, tableId, sig, exp });
  res.json(result);
});

// First-QR-scan-token-bug fix: setCustomUserClaims() requires the Firebase
// Auth user to already exist — it does NOT create one. This uid (see
// /qr/session below) is only ever seen by this backend when a table's QR
// code is scanned for the very first time, so setCustomUserClaims() used
// to throw `auth/user-not-found` on exactly that first scan, caught by the
// try/catch below, degrading to `token: null` (this endpoint's own
// documented best-effort fallback — client.js keeps working unauthenticated
// in that case, so nothing crashed, but the diner never got a real session
// on their first scan; only a second scan of the same table — after some
// OTHER diner's scan had already created the Auth record — would succeed).
//
// This mirrors routes/auth.js's mintSessionToken() fix for the identical
// underlying bug in the staff-login flow (see that file's own header for
// the full writeup) — duplicated here as a small, self-contained local
// helper rather than imported, so this fix stays scoped to routes/qr.js
// alone and never touches the manager/admin/staff login flow.
//
// No RTDB data model change: this only ever creates a Firebase AUTH user
// record (no email/password — Firebase Auth's own password mechanism is
// never used here either), never touches restaurants/$restId in RTDB.
// uid is already globally unique (see below — it's restId-prefixed), so no
// UID-scheme change was needed here, unlike mintSessionToken()'s bare-uid
// collision fix.
async function ensureAuthUserExists(auth, uid) {
  try {
    await auth.getUser(uid);
    return; // already exists (e.g. a previous scan of this same table) — nothing to do
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
  }
  try {
    await auth.createUser({ uid, disabled: false });
  } catch (err) {
    // Two diners scanning the SAME table's QR code at the same instant can
    // both reach this point for the same not-yet-existing uid — the loser
    // of that race gets `auth/uid-already-exists`, which just means the
    // other request's createUser() already won; the user exists either
    // way, which is all this helper promises. Not a crash for either
    // caller, and neither diner's page load is blocked.
    if (err.code === "auth/uid-already-exists") return;
    throw err;
  }
}

// Called by client.js on EVERY page load (every QR scan) before it touches
// Firebase at all. Mints the customer's Firebase Auth session.
router.post("/qr/session", async (req, res) => {
  const decision = evaluateQrSessionMint({
    restId: req.body?.restId,
    table: req.body?.table,
    tableId: req.body?.tableId,
    sig: req.body?.sig,
    exp: req.body?.exp,
  });
  if (!decision.ok) {
    return res.status(decision.status).json({ error: decision.error, code: decision.code });
  }

  if (!isAdminAvailable()) {
    return res.status(503).json({ error: "Session verification unavailable", token: null, code: "token_invalid" });
  }
  try {
    assertAuthMintAllowed();
  } catch (err) {
    console.error("[qr/session] mint refused:", err.message);
    return res.status(503).json({ token: null, error: "Session mint unavailable", code: "token_invalid" });
  }

  try {
    const auth = getAdminAuth();
    const uid = customerSessionUid(decision, crypto.randomUUID());
    const claims = {
      restId: decision.restId,
      restaurantId: decision.restId,
      table: decision.dineIn ? (decision.table || null) : null,
      tableId: decision.dineIn ? (decision.tableId || decision.table || null) : null,
      type: "customer",
      role: "client",
    };
    await ensureAuthUserExists(auth, uid);
    await auth.setCustomUserClaims(uid, claims);
    const token = await auth.createCustomToken(uid, claims);
    res.json({ token });
  } catch (err) {
    console.error("[qr/session] mint failed:", err.code || err.message);
    res.status(503).json({ token: null, error: "Session mint failed", code: "token_invalid" });
  }
});

export default router;
