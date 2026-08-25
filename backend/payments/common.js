// payments/common.js — Click, Payme, Uzum integratsiyalari uchun umumiy yordamchi funksiyalar
//
// Architecture Fix Pass: database.rules.json now requires `auth != null` on
// restaurants/$restId — these webhook handlers run with no Firebase Auth
// session of their own (Click/Payme/Uzum call this backend directly, not
// through a browser), so every read/write here goes through systemDb.js's
// admin-or-client helpers instead of the plain client SDK. This is the
// money-critical path (marking an order paid) — see systemDb.js for the
// fallback behavior when no service account is configured yet.
import { NotificationService } from "../notifications/NotificationService.js";
import { NOTIFICATION_TYPES } from "../notifications/types.js";
import { getAlertState, setAlertState } from "../notifications/common.js";
import { isSafeId } from "../security/sanitize.js";
import { systemGet, systemUpdate } from "../systemDb.js";
import { useClaim } from "../discountClaims/claimsService.js";
import { usePostgres } from "../pg/config.js";
import { withLegacyRest } from "../pg/legacyBridge.js";
import { getOrderByLegacy, patchOrderFields } from "../pg/ordersService.js";

export function basePath(restId) {
  return `restaurants/${restId}`;
}

/**
 * Berilgan restoran ichida orderId bo'yicha buyurtmani topadi.
 * Click/Payme/Uzum so'rovlarida odatda merchant_trans_id / account.order_id /
 * clientReferenceId formatida "restId:orderId" yoki sof "orderId" keladi —
 * shu sababli ikkalasini ham qo'llab-quvvatlaymiz.
 *
 * restId/orderId here come from splitMerchantTransId(), which parses a
 * string a *client* (or, on the webhook path, the payment provider echoing
 * back what our own /payments/init put in the checkout link) controls — so
 * they get the same single-path-segment validation as every other
 * user-influenced id in this app before touching Firebase (security/sanitize.js).
 */
export async function findOrder(restId, orderId) {
  if (!restId || !orderId || !isSafeId(String(restId)) || !isSafeId(String(orderId))) return null;
  const orderPath = `${basePath(restId)}/orders/${orderId}`;
  if (usePostgres()) {
    const data = await withLegacyRest(restId, (client, ctx) => getOrderByLegacy(client, ctx.restaurantUuid, orderId));
    if (!data) return null;
    return { path: orderPath, data };
  }
  const snap = await systemGet(orderPath);
  if (!snap.exists()) return null;
  return { path: orderPath, data: snap.val() };
}

/**
 * "restId:orderId" yoki "restId_orderId" formatidagi merchant_trans_id'ni
 * ikkiga ajratadi. Agar faqat bitta qiymat bo'lsa (masalan test holatlarida),
 * DEFAULT_REST_ID dan foydalaniladi.
 */
export function splitMerchantTransId(value) {
  const str = String(value || "");
  const sep = str.includes(":") ? ":" : (str.includes("_") ? "_" : null);
  if (!sep) {
    return { restId: process.env.DEFAULT_REST_ID || null, orderId: str };
  }
  const idx = str.indexOf(sep);
  return { restId: str.slice(0, idx), orderId: str.slice(idx + 1) };
}

export function buildMerchantTransId(restId, orderId) {
  return `${restId}:${orderId}`;
}

/**
 * Buyurtma holatini "paid" ga o'tkazadi va to'lov metadatasini yozadi.
 * idempotent: agar buyurtma allaqachon shu provider orqali to'langan bo'lsa,
 * qayta yozishni oldini olish chaqiruvchi tomonidan tekshiriladi.
 */
export async function markOrderPaid(restId, orderId, { provider, providerTransactionId, amount }) {
  const orderPath = `${basePath(restId)}/orders/${orderId}`;
  const paidPatch = {
    status: "paid",
    statusKey: "paid",
    statusLabel: "To'landi",
    paymentProvider: provider,
    paymentTransactionId: String(providerTransactionId),
    paymentAmount: Number(amount || 0),
    paidAt: Date.now(),
    updatedAt: Date.now(),
    payment: { paid: true, method: provider, amount: Number(amount || 0), approved: true },
  };
  if (usePostgres()) {
    await withLegacyRest(restId, (client, ctx, events) => patchOrderFields(client, ctx, orderId, paidPatch, events));
  } else {
    await systemUpdate(orderPath, paidPatch);
  }

  // 🆕 QR one-time discount claim consumption (spec §15/§16/§33) — this IS
  // the "payment-authoritative flow" for Click/Payme/Uzum gateway orders:
  // markOrderPaid() is the single choke point every gateway payment passes
  // through exactly once, so it's the correct (and only) place a gateway
  // order's one-time claim gets marked "used", directly (backend-to-backend,
  // no HTTP hop, no client/waiter ever able to trigger this transition
  // themselves for a gateway order). useClaim() is its own atomic
  // available->used transaction — see claimsService.js — so this can never
  // double-consume even under a webhook retry.
  try {
    const orderForClaim = await findOrder(restId, orderId);
    const claimId = orderForClaim?.data?.discountClaimId;
    if (claimId) await useClaim(restId, claimId, orderId);
  } catch (err) {
    // Never let claim bookkeeping block a real, already-successful payment
    // from being recorded — same fail-open posture as the notification send
    // below, for the same reason (money already moved; this is bookkeeping).
    console.error("[markOrderPaid] discount claim consume error:", err.message);
  }

  // Same single choke point as markOrderCanceled() below — every successful
  // Click/Payme/Uzum payment passes through here exactly once under normal
  // conditions (callers already check order.status !== "paid" first — see
  // routes/click.js, routes/payme.js, routes/uzum.js). The alert-state check
  // below is defense-in-depth against the case that guard doesn't cover: a
  // payment provider's webhook retry arriving after markOrderPaid() already
  // ran once for this order (Click/Payme/Uzum all retry undelivered
  // webhooks) — without it, a retry would send a second PAYMENT_RECEIVED
  // alert for the same real payment.
  //
  // P2 fix (PRODUCTION-AUDIT.md #18): this check used to happen only via
  // setAlertState() AFTER the notification was already sent — which
  // protected the separate instantScanners.js poller from double-alerting,
  // but did nothing to stop THIS function itself from sending twice if
  // called twice. Checking getAlertState() first, and writing the "sent"
  // state before sending, closes that gap for the realistic case (a retry
  // arriving after the first call already completed). It does not close a
  // sub-second concurrent-webhook race, since getAlertState/setAlertState
  // are plain reads/writes, not an atomic Firebase transaction — closing
  // that fully would need runTransaction() here, which is a larger change
  // than this specific finding's scope; the order data itself stays correct
  // either way (idempotent by field-overwrite, per §10 of the audit).
  const alertKey = `payment_received_${orderId}`;
  const existingAlert = await getAlertState(restId, alertKey).catch(() => null);
  if (!existingAlert?.sent) {
    await setAlertState(restId, alertKey, { sent: true }).catch(() => {});
    const found = await findOrder(restId, orderId);
    NotificationService.send(NOTIFICATION_TYPES.PAYMENT_RECEIVED, restId, null, {
      orderId, amount, method: provider, orderNumber: found?.data?.orderNumber,
    }).catch(() => {});
  }
}

export async function markOrderCanceled(restId, orderId, { provider, providerTransactionId, reason, amount }) {
  const cancelPatch = {
    paymentProvider: provider,
    paymentTransactionId: String(providerTransactionId),
    paymentCancelReason: reason || "",
    paymentCanceledAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (usePostgres()) {
    await withLegacyRest(restId, (client, ctx, events) => patchOrderFields(client, ctx, orderId, cancelPatch, events));
  } else {
    await systemUpdate(`${basePath(restId)}/orders/${orderId}`, cancelPatch);
  }

  // Single choke point for all 3 payment providers (Click/Payme/Uzum) — a
  // canceled/failed transaction always passes through here, so the instant
  // "Failed Payment" alert (spec section 6) needs exactly one hook, not one
  // per provider file.
  NotificationService.send(NOTIFICATION_TYPES.FAILED_PAYMENT, restId, null, {
    orderId, amount, reason,
  }).catch(() => {});
}

// So'mni tiyinga va aksincha aylantirish (Payme tiyin bilan ishlaydi)
export const somToTiyin = (som) => Math.round(Number(som || 0) * 100);
export const tiyinToSom = (tiyin) => Math.round(Number(tiyin || 0) / 100);

// Ikki summa (so'mda) bir-biriga tengligini tekshirish — float xatolarini
// hisobga olib, ±1 so'm tolerantlik bilan
export function amountsMatch(a, b, toleranceSom = 1) {
  return Math.abs(Number(a) - Number(b)) <= toleranceSom;
}