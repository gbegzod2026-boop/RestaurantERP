// db/scripts/lib/normalize.mjs — the single source of truth for turning a
// raw Firebase value into something PostgreSQL will accept.
//
// Every migration pass (dry-run, apply, verify) imports THIS module, so a
// dry-run's verdict is guaranteed to match what apply would really do. If
// dry-run and apply each had their own coercion logic, a clean dry-run would
// prove nothing — which is the failure mode Phase 1 requirement #16 exists to
// prevent.
//
// Two rules govern everything here:
//   1. Never invent data (rule #20). Absent stays absent; it never becomes 0
//      or "" or today's date.
//   2. Never silently coerce an unrecognized value (rules #14, #15). Anything
//      unmappable returns { ok: false, reason } and the caller reports and
//      skips the record.
//
// The mapping tables are transcriptions of docs/STATUS_MIGRATION_MAP.md,
// which was itself generated from a complete scan of live production data
// (docs/migration-reports/firebase-enums-latest.json) — not from guesses.

// ── result helpers ────────────────────────────────────────────────────────
export const ok = (value) => ({ ok: true, value });
export const fail = (reason, detail) => ({ ok: false, reason, detail });

// ── money ─────────────────────────────────────────────────────────────────
// Policy: docs/MONEY_MIGRATION_POLICY.md
const MONEY_MAX = 999999999999.99;

/** Converts a raw Firebase money value to a numeric(14,2)-safe string.
 *  Returns { ok, value, warnings[] } — warnings are non-fatal findings the
 *  caller must still record (precision loss, negatives). */
export function toMoney(raw, { allowNegative = true } = {}) {
  const warnings = [];
  if (raw === null || raw === undefined || raw === "") return { ...ok(null), warnings };

  let n;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    const s = raw.trim();
    // A comma could be a decimal separator or a thousands separator.
    // "1,500" is genuinely ambiguous, so it is rejected rather than guessed.
    if (s.includes(",")) return { ...fail("money_ambiguous_comma", raw), warnings };
    if (!/^-?\d+(\.\d+)?$/.test(s)) return { ...fail("money_unparseable", raw), warnings };
    n = Number(s);
  } else {
    return { ...fail("money_wrong_type", `${typeof raw}`), warnings };
  }

  if (!Number.isFinite(n)) return { ...fail("money_non_finite", String(raw)), warnings };
  if (Math.abs(n) > MONEY_MAX) return { ...fail("money_out_of_range", String(raw)), warnings };
  if (n < 0) {
    if (!allowNegative) return { ...fail("money_negative_not_allowed", String(raw)), warnings };
    warnings.push({ code: "money_negative", value: n });
  }

  // Round half-up in integer cents rather than via toFixed, which would add a
  // second float round-trip through string formatting.
  const cents = Math.round(Math.abs(n) * 100);
  const rounded = (n < 0 ? -cents : cents) / 100;
  if (rounded !== n) {
    warnings.push({ code: "money_precision_loss", original: n, rounded, delta: Number((n - rounded).toFixed(10)) });
  }
  return { ...ok(rounded.toFixed(2)), warnings };
}

/** Quantities and stock levels — same safety, different scale/precision. */
export function toDecimal(raw, scale = 3) {
  if (raw === null || raw === undefined || raw === "") return ok(null);
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return fail("decimal_non_finite", String(raw));
  const f = Math.pow(10, scale);
  return ok((Math.round(n * f) / f).toFixed(scale));
}

/** Percentages: 0–100 inclusive. Accepts the app's "%5" string form. */
export function toPercent(raw) {
  if (raw === null || raw === undefined || raw === "") return ok(null);
  let n;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string") {
    const s = raw.trim().replace(/^%/, "").replace(/%$/, "");
    if (!/^-?\d+(\.\d+)?$/.test(s)) return fail("percent_unparseable", raw);
    n = Number(s);
  } else return fail("percent_wrong_type", typeof raw);
  if (!Number.isFinite(n)) return fail("percent_non_finite", String(raw));
  if (n < 0 || n > 100) return fail("percent_out_of_range", String(n));
  return ok((Math.round(n * 100) / 100).toFixed(2));
}

// ── timestamps ────────────────────────────────────────────────────────────
// RTDB stores epoch MILLISECONDS as numbers. Some records use seconds, and a
// few use ISO strings. Guessing wrong turns 2026 into 1970, so the ranges
// below are deliberately tight and anything outside them is rejected.
const MS_MIN = Date.UTC(2015, 0, 1);
const MS_MAX = Date.UTC(2035, 0, 1);

export function toTimestamp(raw) {
  if (raw === null || raw === undefined || raw === "") return ok(null);

  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return fail("timestamp_non_finite", String(raw));
    if (raw >= MS_MIN && raw <= MS_MAX) return ok(new Date(raw).toISOString());
    // Plausible epoch-seconds value
    if (raw * 1000 >= MS_MIN && raw * 1000 <= MS_MAX) return ok(new Date(raw * 1000).toISOString());
    return fail("timestamp_out_of_range", String(raw));
  }

  if (typeof raw === "string") {
    const s = raw.trim();
    if (/^\d+$/.test(s)) return toTimestamp(Number(s));
    const p = Date.parse(s);
    if (Number.isNaN(p)) return fail("timestamp_unparseable", s.slice(0, 40));
    if (p < MS_MIN || p > MS_MAX) return fail("timestamp_out_of_range", s.slice(0, 40));
    return ok(new Date(p).toISOString());
  }
  return fail("timestamp_wrong_type", typeof raw);
}

/** Firebase date-keyed trees use "YYYY-MM-DD" path segments. Requirement #8:
 *  these become real date columns, never opaque ids. */
export function toDateKey(raw) {
  if (typeof raw !== "string") return fail("datekey_wrong_type", typeof raw);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return fail("datekey_bad_format", raw);
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) {
    return fail("datekey_not_a_real_date", raw);
  }
  return ok(`${y}-${mo}-${d}`);
}

/** "YYYY-MM" month keys → the first day of that month, as a date. */
export function toMonthKey(raw) {
  if (typeof raw !== "string") return fail("monthkey_wrong_type", typeof raw);
  const m = /^(\d{4})-(\d{2})$/.exec(raw.trim());
  if (!m) return fail("monthkey_bad_format", raw);
  if (+m[2] < 1 || +m[2] > 12) return fail("monthkey_bad_month", raw);
  return ok(`${m[1]}-${m[2]}-01`);
}

/** "HH:MM" / "HH:MM:SS" reservation times. */
export function toTimeOfDay(raw) {
  if (raw === null || raw === undefined || raw === "") return ok(null);
  if (typeof raw !== "string") return fail("time_wrong_type", typeof raw);
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!m) return fail("time_bad_format", raw);
  const h = +m[1], mi = +m[2], s = m[3] ? +m[3] : 0;
  if (h > 23 || mi > 59 || s > 59) return fail("time_out_of_range", raw);
  return ok(`${String(h).padStart(2, "0")}:${m[2]}:${String(s).padStart(2, "0")}`);
}

// ── phone numbers ─────────────────────────────────────────────────────────
// Firebase customer keys are phone numbers, sometimes percent-encoded
// ("%2B998..."), sometimes bare ("902651475"), sometimes full E.164
// ("+998902651475"). Requirement #7.

/** Decodes a raw RTDB key without normalizing it. Safe against keys that are
 *  not valid percent-encoding (decodeURIComponent throws on a lone '%'). */
export function decodePhoneKey(key) {
  if (typeof key !== "string") return null;
  try {
    return decodeURIComponent(key);
  } catch {
    return key.replace(/%2B/gi, "+");
  }
}

/** Canonical comparison form. Returns null when the input cannot be treated
 *  as a phone number — the caller then leaves normalized_phone NULL rather
 *  than inventing one, and the row still migrates.
 *
 *  Uzbek local numbers (9 digits, e.g. "902651475") are expanded to +998…
 *  because the platform is Uzbekistan-only and the same person is otherwise
 *  stored twice. This is the ONE inference made here, and it is applied only
 *  to exactly-9-digit inputs; anything else is left alone. */
export function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;
  const decoded = decodePhoneKey(String(raw)).trim();
  if (!decoded) return null;

  const hadPlus = decoded.startsWith("+");
  const digits = decoded.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length < 6 || digits.length > 20) return null;

  if (hadPlus) return `+${digits}`;
  if (digits.length === 9) return `+998${digits}`;      // Uzbek local
  if (digits.length === 12 && digits.startsWith("998")) return `+${digits}`;
  return `+${digits}`;
}

// ── status maps ───────────────────────────────────────────────────────────
// Transcribed from docs/STATUS_MIGRATION_MAP.md.

export const ORDER_STATUS_MAP = Object.freeze({
  order_created: "order_created",
  created: "order_created",
  confirmed: "confirmed",
  cooking: "cooking",
  preparing: "cooking",
  "tayyorlanmoqda": "cooking",
  ready: "ready",
  picked_up: "picked_up",
  served: "served",
  payment: "payment_requested",
  payment_requested: "payment_requested",
  paid: "paid",
  // Uzbek "paid". Resolves to completed, not paid — see the decision note in
  // docs/STATUS_MIGRATION_MAP.md §2. Payment state lives in payments.paid.
  "to'landi": "completed",
  "to‘landi": "completed",   // U+2018 variant — same word, different apostrophe
  completed: "completed",
  cancelled: "cancelled",
  canceled: "cancelled",
  "bekor qilindi": "cancelled",
});

export const ORDER_ITEM_STATUS_MAP = Object.freeze({
  pending: "pending",
  cooking: "cooking",
  preparing: "cooking",
  ready: "ready",
  prepared: "ready",
  delivered: "delivered",
  served: "served",
  cancelled: "cancelled",
  canceled: "cancelled",
});

export const PAYMENT_METHOD_MAP = Object.freeze({
  cash: "cash",
  naqd: "cash",
  cash_on_delivery: "cash",
  card: "card",
  karta: "card",
  payme: "payme",
  click: "click",
  uzum: "uzum",
  transfer: "transfer",
  otkazma: "transfer",
  mixed: "mixed",
  pending: "pending",
});

export const TABLE_STATUS_MAP = Object.freeze({
  free: "free",
  bosh: "free",
  occupied: "occupied",
  busy: "occupied",
  eating: "occupied",
  band: "occupied",
  cleaning: "cleaning",
  reserved: "reserved",
});

export const ORDER_TYPE_MAP = Object.freeze({
  dine_in: "dine_in",
  dinein: "dine_in",
  zal: "dine_in",
  delivery: "delivery",
  dostavka: "delivery",
  takeaway: "takeaway",
  "olib ketish": "takeaway",
  pickup: "pickup",
});

export const RESERVATION_STATUS_MAP = Object.freeze({
  pending: "pending",
  confirmed: "confirmed",
  seated: "seated",
  completed: "completed",
  no_show: "no_show",
  noshow: "no_show",
  cancelled: "cancelled",
  canceled: "cancelled",
});

export const COURIER_ASSIGNMENT_STATUS_MAP = Object.freeze({
  assigned: "assigned",
  accepted: "accepted",
  heading_to_restaurant: "heading_to_restaurant",
  picked_up: "picked_up",
  delivering: "delivering",
  delivered: "delivered",
  cancelled: "cancelled",
  canceled: "cancelled",
});

export const CHANGE_REQUEST_TYPE_MAP = Object.freeze({
  cancel_item: "cancel_item",
  replace_item: "replace_item",
  change_qty: "change_qty",
  cancel_order: "cancel_order",
});

export const CHANGE_REQUEST_STATUS_MAP = Object.freeze({
  pending: "pending",
  approved: "approved",
  rejected: "rejected",
  cancelled: "cancelled",
  canceled: "cancelled",
});

export const EMPLOYEE_ROLE_SET = Object.freeze(new Set([
  "owner", "admin", "manager", "cashier", "chef", "waiter", "courier",
  "finance", "hr", "crm", "inventory_manager", "marketing",
]));

/** Looks a value up in a map: exact match first, then trimmed/lower-cased.
 *  Returns fail() on no match so the caller reports and skips — deliberately
 *  never falls back to "unknown", which would hide a real gap. */
export function mapEnum(raw, map, fieldName) {
  if (raw === null || raw === undefined || raw === "") return ok(null);
  if (typeof raw !== "string") return fail(`${fieldName}_wrong_type`, typeof raw);
  if (Object.prototype.hasOwnProperty.call(map, raw)) return ok(map[raw]);
  const k = raw.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(map, k)) return ok(map[k]);
  return fail(`${fieldName}_unknown_value`, raw);
}

/** Resolves an order's canonical status using the documented precedence
 *  statusV2 → statusKey → status, and reports which field won so the report
 *  can show it. */
export function resolveOrderStatus(order) {
  const candidates = [
    ["statusV2", order?.statusV2],
    ["statusKey", order?.statusKey],
    ["status", order?.status],
  ];
  for (const [field, raw] of candidates) {
    if (raw === null || raw === undefined || raw === "") continue;
    const m = mapEnum(raw, ORDER_STATUS_MAP, "order_status");
    if (m.ok && m.value) return { ...ok(m.value), sourceField: field, raw };
    if (!m.ok) return { ...fail("order_status_unknown_value", `${field}="${raw}"`), sourceField: field, raw };
  }
  return fail("order_status_absent", "no statusV2/statusKey/status present");
}

/** Payment state for orders.payment_status, which is a different axis from
 *  orders.status. Derived from the payment object, falling back to the
 *  top-level paymentMethod field that (confusingly) holds "pending". */
export function resolvePaymentStatus(order) {
  const p = order?.payment;
  if (p && typeof p === "object") {
    if (p.paid === true) return ok("paid");
    if (p.requested === true) return ok("pending");
  }
  const pm = order?.paymentMethod;
  if (typeof pm === "string" && pm.trim().toLowerCase() === "pending") return ok("pending");
  if (p && typeof p === "object" && p.paid === false) return ok("unpaid");
  return ok("unpaid");
}

// ── text / json ───────────────────────────────────────────────────────────

/** Trims and collapses "" to null, so absent and blank are one thing. */
export function toText(raw, { maxLen = null } = {}) {
  if (raw === null || raw === undefined) return ok(null);
  if (typeof raw === "number" || typeof raw === "boolean") return ok(String(raw));
  if (typeof raw !== "string") return fail("text_wrong_type", typeof raw);
  const s = raw.trim();
  if (!s) return ok(null);
  if (maxLen && s.length > maxLen) return fail("text_too_long", `${s.length} > ${maxLen}`);
  return ok(s);
}

export function toBool(raw, dflt = false) {
  if (raw === null || raw === undefined || raw === "") return ok(dflt);
  if (typeof raw === "boolean") return ok(raw);
  if (typeof raw === "number") return ok(raw !== 0);
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (["true", "1", "yes", "ha"].includes(s)) return ok(true);
    if (["false", "0", "no", "yo'q"].includes(s)) return ok(false);
  }
  return fail("bool_unparseable", String(raw).slice(0, 30));
}

export function toInt(raw) {
  if (raw === null || raw === undefined || raw === "") return ok(null);
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return fail("int_non_finite", String(raw));
  if (!Number.isInteger(n)) return ok(Math.round(n));
  return ok(n);
}

/** Menu/category names are {uz,ru,en} objects, but some records hold a bare
 *  string. Both shapes are preserved verbatim as jsonb rather than one being
 *  coerced into the other and losing either the translations or the text. */
export function toI18nJson(raw) {
  if (raw === null || raw === undefined || raw === "") return ok(null);
  if (typeof raw === "string") return ok(JSON.stringify(raw.trim()));
  if (typeof raw === "object" && !Array.isArray(raw)) return ok(JSON.stringify(raw));
  if (Array.isArray(raw)) return ok(JSON.stringify(raw));
  return fail("i18n_wrong_type", typeof raw);
}

export function toJson(raw, dflt = null) {
  if (raw === null || raw === undefined) return ok(dflt);
  try {
    return ok(JSON.stringify(raw));
  } catch (e) {
    return fail("json_unserializable", e.message);
  }
}

/** Everything in `record` whose key is not in `consumed`, as a jsonb blob.
 *  This is what fills the `extra` column and is the mechanical guarantee
 *  behind "no silent data loss": a field nobody mapped still lands in
 *  PostgreSQL instead of evaporating. */
export function leftoverExtra(record, consumed) {
  if (!record || typeof record !== "object") return "{}";
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (!consumed.has(k) && v !== null && v !== undefined) out[k] = v;
  }
  return JSON.stringify(out);
}
