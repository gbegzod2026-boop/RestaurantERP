// discountClaims/claimsService.js — usage-limited customer discount claims.
// Two origins write into the SAME model (spec §5's explicit "don't create two
// counter sources"): a QR scan (Admin Sozlamalar → Chop etish sozlamalari →
// "QR kodni ko'rsatish") and a direct admin grant (Admin → Mijozlar →
// customer profile → "QR chegirma berish"). Both end up as one entry with
// `usageLimit`/`usageCount` — `remaining = usageLimit - usageCount` is
// computed on read, never stored separately.
//
// Architecture:
//  - AUTHORITATIVE record: top-level discountClaims/$restId/$token (see
//    database.rules.json — backend-Admin-SDK-only, no browser ever touches
//    it). Single source of truth for usage consumption, guarded by
//    systemDb.js's systemTransaction() so two concurrent orders can never
//    both consume the same use.
//  - DISPLAY MIRROR: restaurants/$restId/customers/$phone/oneTimeDiscounts/
//    $token — written by this service whenever the authoritative record
//    changes, for the Admin Mijozlar card's real-time listener (already
//    subscribed to the whole customers subtree) to pick up with zero new
//    listeners. Purely a read convenience — never consulted by useClaim()'s
//    atomic guard, and never itself the thing that decides remaining uses.
//  - Reuses printSettings.receiptQr / receiptQrPercent (existing Chop etish
//    sozlamalari fields) for the QR's percent; printSettings.receiptQrUsageLimit
//    (new, additive field on the SAME node — no new settings schema) for how
//    many uses a scanned QR grants, defaulting to 1 (unchanged prior behavior)
//    when not configured.
//  - Reuses the existing order discount schema (discount/discountAmount/
//    discountPercent/discountSource) — this module only adds
//    discountClaimId, written by client.js/waiter.js's discount computation
//    when a claim wins the existing MAX-priority comparison.
import crypto from "crypto";
import { systemGet, systemUpdate, systemTransaction } from "../systemDb.js";
import { isSafeId } from "../security/sanitize.js";

function restBasePath(restId) {
  return `restaurants/${restId}`;
}
function claimPath(restId, token) {
  return `discountClaims/${restId}/${token}`;
}
function mirrorPath(restId, phone, token) {
  return `${restBasePath(restId)}/customers/${encodeURIComponent(phone)}/oneTimeDiscounts/${token}`;
}

/** Same canonical rule as admin-frontend/public/js/shared.js's normalizePhone()
 *  — duplicated (not imported) because this file runs in Node, shared.js is a
 *  browser ES module with browser-only tooling around it; kept byte-for-byte
 *  equivalent so the SAME phone always maps to the SAME customers/{phone} key
 *  on both sides. */
function normalizePhone(phone = "") {
  let cleaned = String(phone || "").replace(/\D/g, "");
  if (!cleaned) return "";
  if (cleaned.length > 12 && cleaned.includes("998")) {
    cleaned = "998" + cleaned.slice(cleaned.indexOf("998") + 3).slice(0, 9);
  }
  if (cleaned.length === 12 && cleaned.startsWith("998")) return "+" + cleaned;
  if (cleaned.length === 9) return "+998" + cleaned;
  if (cleaned.length === 10 && cleaned.startsWith("0")) return "+998" + cleaned.slice(1);
  return "+" + cleaned;
}

function isValidUzPhone(phone) {
  return /^\+998\d{9}$/.test(phone);
}

/** `available` while usageCount < usageLimit, `exhausted` once it isn't —
 *  the ONLY place this status is computed, so it can never drift from the
 *  usageLimit/usageCount pair it's derived from (spec §5/§10). */
function statusFor(usageCount, usageLimit) {
  return Number(usageCount) < Number(usageLimit) ? "available" : "exhausted";
}

function mirrorFields(claim) {
  return {
    percent: claim.percent,
    usageLimit: claim.usageLimit,
    usageCount: claim.usageCount,
    status: claim.status,
    source: claim.source,
    issuedAt: claim.issuedAt,
    claimedAt: claim.claimedAt || null,
  };
}

/**
 * Issues (or, if this order already has one, returns) the QR claim token for
 * a receipt. Idempotent per order — reprinting the SAME order's receipt must
 * never mint a second discount (spec §22/§27/§28): the token is cached on the
 * order record itself (orders/$orderId/qrDiscountClaimToken) the first time
 * a receipt is built for it, and every subsequent call for the same orderId
 * just re-reads and returns that same token.
 *
 * Returns `null` (not an error) when QR discounts aren't configured — either
 * printSettings.receiptQr is off, or receiptQrPercent isn't a positive
 * number — so callers can simply skip rendering a QR, exactly like today.
 */
export async function issueClaimForOrder(restId, orderId) {
  if (!isSafeId(String(restId)) || !isSafeId(String(orderId))) return null;

  const orderPath = `${restBasePath(restId)}/orders/${orderId}`;
  const [orderSnap, printSettingsSnap] = await Promise.all([
    systemGet(orderPath),
    systemGet(`${restBasePath(restId)}/printSettings`),
  ]);
  if (!orderSnap.exists()) return null;
  const order = orderSnap.val() || {};

  // Already issued for this order — reprint path, reuse the same claim.
  const existingToken = order.qrDiscountClaimToken;
  if (existingToken) {
    const existing = await systemGet(claimPath(restId, existingToken));
    if (existing.exists()) {
      const claim = existing.val();
      return { token: existingToken, percent: claim.percent, usageLimit: claim.usageLimit, status: claim.status };
    }
    // Order points at a claim that no longer exists (shouldn't normally
    // happen) — fall through and issue a fresh one rather than erroring.
  }

  const ps = printSettingsSnap.val() || {};
  const percent = Number(ps.receiptQrPercent || 0);
  if (!ps.receiptQr || !(percent > 0)) return null;
  // 🆕 receiptQrUsageLimit — additive Print Settings field (Sozlamalar → Chop
  // etish → QR). Defaults to 1 (the entire prior single-use behavior), so a
  // deployment that never configures it keeps working exactly as before.
  const usageLimit = Math.max(1, Math.floor(Number(ps.receiptQrUsageLimit) || 1));

  const token = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  await systemUpdate(claimPath(restId, token), {
    restId, orderId, percent, usageLimit,
    usageCount: 0,
    status: "unclaimed",
    source: "qr",
    issuedAt: now,
    reason: ps.receiptQrReason || "",
  });
  await systemUpdate(orderPath, { qrDiscountClaimToken: token });

  return { token, percent, usageLimit, status: "unclaimed" };
}

/**
 * Admin → Mijozlar → customer profile → "QR chegirma berish" — a direct
 * grant, no QR scan needed (admin already has the phone in front of them).
 * Same authoritative model as a QR claim (spec §5: one model, two origins) —
 * created straight into "available" with the phone already attached, since
 * there's no unclaimed→claimed step to go through.
 */
export async function grantDiscountToPhone(restId, rawPhone, percent, usageLimit) {
  if (!isSafeId(String(restId))) return { ok: false, reason: "invalid_request" };
  const phone = normalizePhone(rawPhone);
  if (!isValidUzPhone(phone)) return { ok: false, reason: "invalid_phone" };

  const pct = Number(percent);
  if (!(pct > 0) || pct > 100) return { ok: false, reason: "invalid_percent" };
  // §3: usageLimit <= 0 is never "unlimited" by accident — reject outright.
  // (An explicit unlimited option doesn't exist anywhere else in this
  // codebase's discount model — see file header — so none is introduced here.)
  const limit = Math.floor(Number(usageLimit));
  if (!Number.isFinite(limit) || limit <= 0) return { ok: false, reason: "invalid_usage_limit" };

  const token = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  const claim = {
    restId, percent: pct, usageLimit: limit, usageCount: 0,
    status: "available", source: "admin_grant",
    claimedPhone: phone, issuedAt: now, claimedAt: now,
  };
  await systemUpdate(claimPath(restId, token), claim);
  await systemUpdate(mirrorPath(restId, phone, token), mirrorFields(claim));

  return { ok: true, token, percent: pct, usageLimit: limit };
}

/** Safe, public-facing view of a claim — never exposes anything beyond what
 *  the claim landing page needs to render (spec §16/§17: no secrets in the
 *  QR, and nothing sensitive echoed back from resolve() either). */
export async function resolveClaim(restId, token) {
  if (!isSafeId(String(restId)) || !isSafeId(String(token))) {
    return { ok: false, reason: "invalid_token" };
  }
  const snap = await systemGet(claimPath(restId, token));
  if (!snap.exists()) return { ok: false, reason: "not_found" };
  const c = snap.val();

  if (c.expiresAt && Date.now() > Number(c.expiresAt)) {
    return { ok: false, reason: "expired" };
  }
  if (c.status === "exhausted") {
    return { ok: false, reason: "already_used" };
  }
  return {
    ok: true,
    percent: c.percent,
    usageLimit: c.usageLimit,
    status: c.status,
    alreadyClaimedPhone: c.status === "available" ? maskPhone(c.claimedPhone) : null,
  };
}

function maskPhone(phone) {
  if (!phone) return null;
  return phone.replace(/^(\+998\d{2})\d{5}(\d{2})$/, "$1•••••$2");
}

/**
 * Attaches an "unclaimed" QR claim to a customer phone number — spec §6/§7.
 * Re-scanning an already-"available" claim with the SAME phone is treated as
 * idempotent success (so a page refresh/re-scan doesn't error); a DIFFERENT
 * phone trying to claim an already-claimed token is rejected.
 */
export async function claimForPhone(restId, token, rawPhone) {
  if (!isSafeId(String(restId)) || !isSafeId(String(token))) {
    return { ok: false, reason: "invalid_token" };
  }
  const phone = normalizePhone(rawPhone);
  if (!isValidUzPhone(phone)) return { ok: false, reason: "invalid_phone" };

  const result = await systemTransaction(claimPath(restId, token), (current) => {
    if (current == null) return undefined; // abort — no such claim, don't create one
    if (current.status === "unclaimed") {
      return { ...current, status: "available", claimedPhone: phone, claimedAt: Date.now() };
    }
    if (current.claimedPhone === phone) {
      return current; // idempotent re-claim by the same phone — no-op write
    }
    return undefined; // already claimed by a DIFFERENT phone, or exhausted — abort
  });

  if (!result.committed) {
    const snap = await systemGet(claimPath(restId, token));
    if (!snap.exists()) return { ok: false, reason: "not_found" };
    const c = snap.val();
    if (c.status === "exhausted") return { ok: false, reason: "already_used" };
    if (c.claimedPhone && c.claimedPhone !== phone) return { ok: false, reason: "claimed_by_other" };
    return { ok: false, reason: "claim_failed" };
  }

  const claim = result.snapshot.val();
  await systemUpdate(mirrorPath(restId, phone, token), mirrorFields(claim));

  return { ok: true, percent: claim.percent, usageLimit: claim.usageLimit, phone };
}

/**
 * Atomic usage consumption (spec §6-§9). This is the ONLY place a claim's
 * usageCount is ever incremented — called from the payment-authoritative
 * flow only (routes/discountClaims.js's staff-authenticated /use route,
 * called by waiter.js/kassa.js right when they mark an order paid; and
 * directly, as a plain function call, from payments/common.js's
 * markOrderPaid() for Click/Payme/Uzum gateway payments) — never reachable
 * by an unauthenticated customer request. Idempotent per orderId: retrying
 * with the SAME orderId that already consumed a use is a no-op success
 * (protects against a webhook retry double-counting), a use for a DIFFERENT
 * order once exhausted is rejected. usageHistory is the audit trail the
 * Admin Mijozlar history view reads (spec §12).
 */
export async function useClaim(restId, token, orderId) {
  if (!isSafeId(String(restId)) || !isSafeId(String(token)) || !isSafeId(String(orderId))) {
    return { ok: false, reason: "invalid_params" };
  }

  const result = await systemTransaction(claimPath(restId, token), (current) => {
    if (current == null) return undefined;
    if (current.usageHistory && current.usageHistory[orderId]) {
      return current; // this exact order already consumed a use — idempotent no-op
    }
    if (current.status !== "available" || Number(current.usageCount) >= Number(current.usageLimit)) {
      return undefined; // exhausted, or somehow still unclaimed — abort
    }
    const usageCount = Number(current.usageCount) + 1;
    return {
      ...current,
      usageCount,
      status: statusFor(usageCount, current.usageLimit),
      usageHistory: { ...(current.usageHistory || {}), [orderId]: Date.now() },
    };
  });

  if (!result.committed) {
    const snap = await systemGet(claimPath(restId, token));
    const c = snap.exists() ? snap.val() : null;
    if (c?.usageHistory?.[orderId]) return { ok: true, alreadyConsumed: true };
    return { ok: false, reason: c ? "not_available" : "not_found" };
  }

  const claim = result.snapshot.val();
  if (claim.claimedPhone) {
    await systemUpdate(mirrorPath(restId, claim.claimedPhone, token), mirrorFields(claim));
  }
  return { ok: true, percent: claim.percent, usageCount: claim.usageCount, usageLimit: claim.usageLimit, remaining: claim.usageLimit - claim.usageCount };
}

/**
 * Order-cancel / failed-payment restore (spec §6/§18) — documents the
 * invariant explicitly rather than leaving it implicit: useClaim() is only
 * ever called at payment success (see the payment-authoritative call sites
 * listed on useClaim() above), never at order creation, so a cancelled/
 * failed order simply never touches usageCount — nothing to reverse. Kept as
 * a named no-op so a future cancel-flow hook has an obvious, self-documenting
 * place to call into rather than silently doing nothing.
 */
export async function releaseClaimIfUnused(restId, token, orderId) {
  if (!isSafeId(String(restId)) || !isSafeId(String(token))) return { ok: false, reason: "invalid_params" };
  const snap = await systemGet(claimPath(restId, token));
  if (!snap.exists()) return { ok: false, reason: "not_found" };
  const c = snap.val();
  if (c.usageHistory && c.usageHistory[orderId]) return { ok: false, reason: "already_used" };
  return { ok: true, unchanged: true };
}
