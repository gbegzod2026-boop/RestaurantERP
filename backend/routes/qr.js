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
import { signQrParams, verifyQrParams } from "../security/qrSign.js";
import { isSafeId } from "../security/sanitize.js";
import { isAdminAvailable, getAdminAuth } from "../firebaseAdmin.js";

const router = express.Router();

function getRestId(req) {
  return req.query.restId || req.body?.restId || req.headers["x-rest-id"] || null;
}

// Table/tableId only ever end up in a Firebase Auth uid and custom claim
// here, never interpolated into a DB path — still worth capping length/
// charset so a malformed value can't produce a garbage uid.
const SAFE_TABLE_RE = /^[A-Za-z0-9_-]{0,64}$/;

// Called by admin.js when staff generate/print/download a table's QR code —
// see downloadSingleQR / downloadAllTablesQR.
router.get("/qr/sign", (req, res) => {
  const restId = getRestId(req);
  if (!restId || !isSafeId(String(restId))) {
    return res.status(400).json({ error: "Invalid restId" });
  }
  const table = req.query.table != null ? String(req.query.table) : "";
  const tableId = req.query.tableId != null ? String(req.query.tableId) : "";
  const { sig, exp } = signQrParams({ restId, table, tableId });
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
  const restId = req.body?.restId;
  const table = req.body?.table != null ? String(req.body.table) : "";
  const tableId = req.body?.tableId != null ? String(req.body.tableId) : "";
  if (!restId || !isSafeId(String(restId))) {
    return res.status(400).json({ error: "Invalid restId" });
  }
  if (!SAFE_TABLE_RE.test(table) || !SAFE_TABLE_RE.test(tableId)) {
    return res.status(400).json({ error: "Invalid table" });
  }

  // If the link carries a signature (see security/qrSign.js — only links
  // generated/downloaded since Phase 2's QR-security fix have one), verify
  // it and reject a tampered rest/table/tableId combination outright. Links
  // with NO signature at all — every QR code printed before that fix
  // shipped — skip this check entirely, same "legacy stays legacy" carve-out
  // as /qr/verify; this endpoint mints a session for them exactly as it
  // does for a signed link.
  const { sig, exp } = req.body || {};
  if (sig || exp) {
    const result = verifyQrParams({ restId, table, tableId, sig, exp });
    if (!result.valid) return res.status(403).json({ error: "Invalid or expired QR link", reason: result.reason });
  }

  if (!isAdminAvailable()) {
    // No Firebase Admin service account configured yet — degrade exactly
    // like routes/auth.js does: no session token, client.js falls back to
    // its pre-existing (unauthenticated) behavior, nothing breaks.
    return res.json({ token: null });
  }

  try {
    const auth = getAdminAuth();
    // Stable per (restaurant, table) — not per visitor. This is an
    // anonymous SESSION identity, not a personal account: every diner who
    // scans the same table's QR code shares it, exactly as they already
    // share that table's unauthenticated access today. Already globally
    // unique (restId-prefixed) — no per-restaurant collision risk, unlike
    // the bare-uid scheme mintSessionToken() (routes/auth.js) used to have.
    // First-QR-scan-token-bug fix: ensureAuthUserExists() above explicitly
    // creates the underlying Firebase Auth user record on first scan now —
    // it was NOT created automatically by setCustomUserClaims() the way
    // this comment used to (incorrectly) say; see that function's header.
    const uid = `client_${restId}_${table || tableId || "na"}`.slice(0, 128);
    // `table`/`role` are the names database.rules.json and rbac.js could
    // consume if they ever need to (currently neither does — only
    // auth.token.restId is checked for QR sessions). `tableId`/`type`/
    // `restaurantId` are additive aliases satisfying the fuller claim-name
    // contract without removing the originals or touching the rules file.
    const claims = {
      restId, restaurantId: restId,
      table: table || null, tableId: table || tableId || null,
      type: "customer",
      role: "client",
    };
    await ensureAuthUserExists(auth, uid);
    await auth.setCustomUserClaims(uid, claims);
    const token = await auth.createCustomToken(uid, claims);
    res.json({ token });
  } catch (err) {
    // err.code only (e.g. "auth/..."), never a raw message that could echo
    // request data — no password/hash/token is ever part of this error either way.
    console.error("[qr/session] mint failed:", err.code || err.message);
    res.json({ token: null }); // best-effort — see comment above, never blocks page load
  }
});

export default router;
