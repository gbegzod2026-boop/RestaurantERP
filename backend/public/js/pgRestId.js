// Strict restaurant-id grammar — must stay aligned with backend/pg/restId.js.
export const CANONICAL_REST_ID_RE = /^rest_[0-9]{10,16}$/;
export const LEGACY_STAFF_UID_RE = /^(rest_[0-9]{10,16})__([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
const MAX_LEN = 96;

function encodedSeparator(value) {
  return /%(?:2f|2e|2d|5f|25|23|3f|26|3d)/i.test(value);
}

export function parseRestId(raw) {
  if (raw == null) return { ok: true, restId: null, empty: true };
  if (typeof raw !== "string") return { ok: false, code: "restId_invalid" };
  if (raw.length === 0) return { ok: false, code: "restId_invalid" };
  if (raw !== raw.trim() || raw !== raw.normalize("NFC")) return { ok: false, code: "restId_invalid" };
  if (raw.length > MAX_LEN) return { ok: false, code: "restId_invalid" };
  if (encodedSeparator(raw)) return { ok: false, code: "restId_invalid" };
  if (/[\s./?#\[\]$@,+*]/.test(raw)) return { ok: false, code: "restId_invalid" };
  if (raw.includes("___")) return { ok: false, code: "restId_invalid" };

  const dbl = raw.split("__").length - 1;
  if (dbl > 1) return { ok: false, code: "restId_invalid" };
  if (dbl === 1) {
    const match = raw.match(LEGACY_STAFF_UID_RE);
    if (!match) return { ok: false, code: "restId_invalid" };
    return { ok: true, restId: match[1], staffUserId: match[2], composite: true };
  }

  if (!CANONICAL_REST_ID_RE.test(raw)) return { ok: false, code: "restId_invalid" };
  return { ok: true, restId: raw, composite: false };
}

export function canonicalizeRestId(raw) {
  const parsed = parseRestId(raw);
  if (!parsed.ok || parsed.empty) return null;
  return parsed.restId;
}
