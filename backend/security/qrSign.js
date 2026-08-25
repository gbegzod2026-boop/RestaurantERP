// security/qrSign.js — Production Security Fix Pass, Phase 2 (High: QR
// security).
//
// Table/QR ordering links (client.html?rest=X&table=N) were plain,
// unsigned URLs — table and restId are short, guessable/sequential values,
// so nothing stopped someone from photographing a real QR code, changing
// `table=` (or `rest=`) to point at a different table or restaurant, and
// generating their own working QR/link pointing at it. This module lets
// the backend attach an HMAC signature + expiry to a table's link at the
// moment staff generate/print it (routes/qr.js), and verify one later
// (called by client.js on page load).
//
// Deliberately NOT an access-control gate on WHO can request a signature —
// restId/table are already effectively public within this app's existing
// architecture (see database.rules.json's documented anonymous-ordering
// carve-out), so signing isn't about hiding those values, it's about
// making sure a link's restId/table pair can't be TAMPERED WITH after
// it's printed. A link with no `sig` at all (every QR code printed before
// this fix shipped) is treated as legacy and still works unchanged —
// hard-requiring a signature would break every already-distributed QR
// code, which is exactly the kind of functionality break this whole fix
// pass was told to avoid.
import crypto from "crypto";
import { safeEqual } from "./crypto.js";

const DEFAULT_TTL_MS = 5 * 365 * 24 * 60 * 60 * 1000; // 5 years — printed QR codes are physical, long-lived

let _ephemeralKey = null;
let _warnedNoKey = false;

function getKey() {
  const configured = process.env.QR_SIGNING_KEY || process.env.ENCRYPTION_KEY || "";
  if (configured) return configured;
  if (!_warnedNoKey) {
    console.warn(
      "⚠️  [QR signing] Neither QR_SIGNING_KEY nor ENCRYPTION_KEY is set in backend/.env — " +
      "using a random in-memory key for this process only. QR links signed now will fail " +
      "verification after the next server restart. Set QR_SIGNING_KEY for stable signed links."
    );
    _warnedNoKey = true;
  }
  if (!_ephemeralKey) _ephemeralKey = crypto.randomBytes(32).toString("hex");
  return _ephemeralKey;
}

function payload({ restId, table, tableId, exp }) {
  return `${restId || ""}|${table || ""}|${tableId || ""}|${exp}`;
}

export function signQrParams({ restId, table, tableId, ttlMs = DEFAULT_TTL_MS }) {
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac("sha256", getKey()).update(payload({ restId, table, tableId, exp })).digest("hex");
  return { sig, exp };
}

export function verifyQrParams({ restId, table, tableId, sig, exp }) {
  if (!sig || !exp) return { valid: false, reason: "missing_signature" };
  if (Date.now() > Number(exp)) return { valid: false, reason: "expired" };
  const expected = crypto.createHmac("sha256", getKey()).update(payload({ restId, table, tableId, exp })).digest("hex");
  const valid = safeEqual(expected, String(sig));
  return { valid, reason: valid ? null : "invalid_signature" };
}
