// Strict restaurant-id grammar.
// Canonical tenant id: rest_<unix-ms> (10–16 digits), e.g. rest_1784740340104.
// Legacy staff Auth uid (mintSessionToken): rest_<tenant>__<staffUser>
//   → canonical rest_<tenant>
// Anything else (whitespace, extra "__", encoding, overlong, prefix tricks) is invalid.

export const CANONICAL_REST_ID_RE = /^rest_[0-9]{10,16}$/;
export const STAFF_USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
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

export function parseCompositeUid(uid) {
  const parsed = parseRestId(uid);
  if (!parsed.ok || !parsed.composite) return null;
  return { restId: parsed.restId, userId: parsed.staffUserId };
}

export function resolveActingRestId({
  tokenRestId = null,
  requestedRestId = null,
  uid = null,
  platformSuperAdmin = false,
} = {}) {
  const requested = parseRestId(requestedRestId);
  const token = parseRestId(tokenRestId);
  const fromUid = parseCompositeUid(uid);
  if (platformSuperAdmin === true) {
    if (!requested.ok || requested.empty) return null;
    return requested.restId;
  }
  if (token.ok && !token.empty) return token.restId;
  return fromUid?.restId || null;
}

export function collectRestIdInputs(req) {
  const found = [];
  const hasOwn = (obj, key) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
  const add = (value, source) => {
    found.push({ source, value });
  };
  if (hasOwn(req, "pgRestId")) add(req.pgRestId, "pg");
  if (hasOwn(req?.query, "restId")) add(req.query.restId, "query");
  if (hasOwn(req?.body, "restId")) add(req.body.restId, "body");
  if (hasOwn(req?.headers, "x-rest-id")) add(req.headers["x-rest-id"], "header");
  if (hasOwn(req?.body, "path") && typeof req.body.path === "string") {
    const normalized = req.body.path.replace(/^\/+/, "");
    const segs = normalized.split("/");
    if (segs[0] === "restaurants") add(segs[1], "path");
  }
  return found;
}

export function resolveRequestRestId(req) {
  const found = collectRestIdInputs(req);
  if (!found.length) return { ok: true, restId: null, empty: true };
  const parsed = found.map((item) => ({ ...item, parsed: parseRestId(item.value) }));
  const invalid = parsed.find((item) => !item.parsed.ok || item.parsed.empty);
  if (invalid) return { ok: false, status: 400, code: "restId_invalid" };
  const ids = new Set(parsed.map((item) => item.parsed.restId));
  if (ids.size > 1) return { ok: false, status: 400, code: "restId_conflict" };
  return { ok: true, restId: [...ids][0] };
}
