// delivery/engine.js — the Delivery Engine: the single place that decides
// which provider fulfills a delivery and drives its status forward.
//
//   Internal   → InternalCourierProvider
//   Yandex Go  → YandexGoProvider
//   Automatic  → InternalCourierProvider first, falls back to YandexGoProvider
//                if no internal courier is available (and again on reject).
//
// Adding a future provider only touches providerRegistry.js + a new
// providers/*.js file — this file never branches on provider internals,
// only on the BaseProvider interface (createDelivery/getStatus/cancel/retry).
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so this file's own reads/writes go through the
// admin-or-client fallback (systemDb.js) instead of the plain client SDK.
import { systemGet, systemUpdate } from "../systemDb.js";
import { usePostgres } from "../pg/config.js";
import { withLegacyRest } from "../pg/legacyBridge.js";
import { getCourierAssignment, upsertCourierAssignment } from "../pg/catalogService.js";
import {
  DELIVERY_STATUS,
  COURIER_FLOW_ORDER,
  isTerminalDeliveryStatus,
  getOrder,
  getDeliverySettings,
  getOrderDelivery,
  updateOrderDelivery,
  appendDeliveryHistory,
  haversineDistanceKm,
  basePath,
  getOfferTimeoutSec,
} from "./common.js";
import { getProvider } from "./providerRegistry.js";
// Delivery lifecycle events are dispatched through the generic Notification
// Center, not a Telegram-specific call — this module has no idea Telegram
// exists, and would work unchanged if the restaurant switched to Push/Email/
// SMS/WhatsApp (backend/notifications/).
import { NotificationService } from "../notifications/NotificationService.js";

let _io = null;
export function attachSocketIO(io) {
  _io = io;
}

function emitDeliveryUpdate(restId, orderId, delivery) {
  if (!_io) return;
  // Scoped to this restaurant's admin room only — see server.js's
  // socket.io "admin-connect" handler. Previously broadcast to a single
  // global "admins" room shared by every restaurant on this backend
  // instance, so anyone who opened a raw Socket.IO connection and emitted
  // "admin-connect" (no credential required) would receive every other
  // restaurant's live delivery data (customer address/phone, courier,
  // order total). Fixed as part of the restaurant-isolation audit.
  _io.to(`admins:${restId}`).emit("delivery:updated", { restId, orderId, delivery });
}

async function buildContext(restId, orderId, courierIdOverride, excludeCourierIds = []) {
  const orderResult = await getOrder(restId, orderId);
  if (!orderResult) return { error: "order_not_found" };
  const { data: order } = orderResult;

  const settings = await getDeliverySettings(restId);
  const restaurantLocation = settings.restaurantLocation?.lat != null ? settings.restaurantLocation : null;
  const rawAddress = order.deliveryAddress || order.address || null;
  const customerLocation =
    rawAddress && typeof rawAddress === "object" && typeof rawAddress.lat === "number" ? rawAddress : null;

  const distanceKm =
    restaurantLocation && customerLocation
      ? haversineDistanceKm(restaurantLocation.lat, restaurantLocation.lng, customerLocation.lat, customerLocation.lng)
      : null;

  return {
    restId,
    orderId,
    order,
    settings,
    restaurantLocation,
    customerLocation,
    distanceKm,
    courierIdOverride,
    excludeCourierIds,
  };
}

/**
 * Assigns a delivery for an order using the restaurant's configured
 * provider strategy. Safe to call multiple times (e.g. retry) — it always
 * (re)persists the latest result into orders/{orderId}/delivery.
 *
 * `excludeCourierIds` accumulates couriers who already rejected or timed
 * out on this exact order, so automatic re-assignment (reject/offer-expiry)
 * never re-offers the same order to the same courier.
 */
export async function assign(restId, orderId, { courierIdOverride, excludeCourierIds = [] } = {}) {
  const ctx = await buildContext(restId, orderId, courierIdOverride, excludeCourierIds);
  if (ctx.error) return { ok: false, error: ctx.error };

  const providerSetting = ctx.settings.provider || "internal";
  let result;
  let providerUsed;

  if (providerSetting === "automatic") {
    const internal = getProvider("internal");
    result = await internal.createDelivery(ctx);
    providerUsed = "internal";
    if (!result.ok) {
      const yandex = getProvider("yandex_go");
      result = await yandex.createDelivery(ctx);
      providerUsed = "yandex_go";
    }
  } else {
    const provider = getProvider(providerSetting);
    if (!provider) return { ok: false, error: "unknown_provider" };
    result = await provider.createDelivery(ctx);
    providerUsed = providerSetting;
  }

  const patch = {
    provider: providerUsed,
    status: result.status,
    courierId: result.courierId || null,
    courierName: result.courierName || null,
    courierPhone: result.courierPhone || null,
    assignmentId: result.assignmentId || null,
    trackingId: result.trackingId || null,
    trackingUrl: result.trackingUrl || null,
    vehicle: result.vehicle || null,
    eta: result.eta ?? null,
    distance: result.distance ?? ctx.distanceKm ?? null,
    rejectedCourierIds: excludeCourierIds,
  };
  await updateOrderDelivery(restId, orderId, patch);

  // Internal offers must be Accepted/Rejected within the offer window — if
  // the courier's device never responds (dropped connection, app closed),
  // the engine itself times the offer out and reassigns, so a silent
  // courier never blocks the whole order.
  if (result.ok && providerUsed === "internal" && result.assignmentId) {
    _scheduleOfferTimeout(restId, orderId, result.courierId, result.assignmentId, getOfferTimeoutSec(ctx.settings) * 1000, excludeCourierIds);
  }
  await appendDeliveryHistory(restId, orderId, {
    status: result.status,
    actor: "system",
    note: result.ok ? `assigned via ${providerUsed}` : `waiting (${result.reason || "unknown"})`,
  });

  const delivery = await getOrderDelivery(restId, orderId);
  emitDeliveryUpdate(restId, orderId, delivery);

  if (result.ok) {
    await NotificationService.send("new_delivery", restId, null, { orderId, orderNumber: ctx.order?.orderNumber, courierName: delivery?.courierName });
    if (result.courierId || result.trackingId) {
      await NotificationService.send("courier_assigned", restId, null, { orderId, orderNumber: ctx.order?.orderNumber, courierName: delivery?.courierName });
    }
  }

  return { ok: result.ok, delivery, providerUsed, reason: result.reason };
}

// In-memory timer, single-process only (matches this app's single-Express-
// instance deployment — see backend build/deploy notes). If the process
// restarts mid-offer, the offer simply never auto-expires; the courier can
// still Accept/Reject manually and admin can Retry from the Delivery panel.
function _scheduleOfferTimeout(restId, orderId, courierId, assignmentId, timeoutMs, priorExcluded) {
  setTimeout(async () => {
    try {
      let a = null;
      if (usePostgres()) {
        a = await withLegacyRest(restId, (client, ctx) => getCourierAssignment(client, ctx.restaurantUuid, assignmentId));
        if (!a) return;
        if (a.subStage !== "accepted_pending") return;
        await withLegacyRest(restId, (client, ctx, events) => upsertCourierAssignment(client, ctx, assignmentId, {
          ...a,
          status: "cancelled",
          subStage: "expired",
          cancelledAt: Date.now(),
          cancelReason: "offer_timeout",
        }, events));
      } else {
        const assignPath = `${basePath(restId)}/courierAssignments/${assignmentId}`;
        const snap = await systemGet(assignPath);
        if (!snap.exists()) return;
        a = snap.val();
        if (a.subStage !== "accepted_pending") return; // already accepted/rejected/cancelled
        await systemUpdate(assignPath, {
          status: "cancelled",
          subStage: "expired",
          cancelledAt: Date.now(),
          cancelReason: "offer_timeout",
        });
      }
      await appendDeliveryHistory(restId, orderId, {
        status: "offer_timeout",
        actor: "system",
        note: `courier ${courierId} did not respond in time`,
      });

      await assign(restId, orderId, { excludeCourierIds: [...(priorExcluded || []), courierId] });
    } catch (err) {
      console.error("offer timeout reassignment error:", err);
    }
  }, timeoutMs);
}

function isValidTransition(from, to) {
  if (isTerminalDeliveryStatus(to)) return true; // cancelled/customer_not_found/returned reachable anytime
  const fromIdx = COURIER_FLOW_ORDER.indexOf(from);
  const toIdx = COURIER_FLOW_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return true; // unknown states (e.g. waiting_for_courier) — allow engine to set freely
  return toIdx >= fromIdx;
}

/** Advances (or sets) the delivery status for an order, validating the courier flow order. */
export async function updateStatus(restId, orderId, newStatus, actor = "courier") {
  const delivery = await getOrderDelivery(restId, orderId);
  if (!delivery) return { ok: false, error: "delivery_not_found" };

  if (!isValidTransition(delivery.status, newStatus)) {
    return { ok: false, error: "invalid_transition", from: delivery.status, to: newStatus };
  }

  await updateOrderDelivery(restId, orderId, { status: newStatus });
  await appendDeliveryHistory(restId, orderId, { status: newStatus, actor });

  const updated = await getOrderDelivery(restId, orderId);
  emitDeliveryUpdate(restId, orderId, updated);

  if (newStatus === DELIVERY_STATUS.ARRIVED) {
    await NotificationService.send("courier_arrived", restId, null, { orderId, orderNumber: updated?.orderNumber, courierName: updated?.courierName });
  } else if (newStatus === DELIVERY_STATUS.PICKED_UP) {
    await NotificationService.send("picked_up", restId, null, { orderId, orderNumber: updated?.orderNumber });
  } else if (newStatus === DELIVERY_STATUS.DELIVERED || newStatus === DELIVERY_STATUS.COMPLETED) {
    await NotificationService.send("delivered", restId, null, { orderId, orderNumber: updated?.orderNumber });
  } else if (newStatus === DELIVERY_STATUS.CANCELLED) {
    await NotificationService.send("cancelled", restId, null, { orderId, orderNumber: updated?.orderNumber });
  }

  return { ok: true, delivery: updated };
}

/**
 * Courier rejects an assignment. Internal assignment is cancelled and the
 * engine re-runs assign() — in Automatic mode this naturally falls through
 * to Yandex Go if no other internal courier is free.
 */
export async function reject(restId, orderId, courierId, reason = "") {
  const delivery = await getOrderDelivery(restId, orderId);
  if (!delivery) return { ok: false, error: "delivery_not_found" };

  if (delivery.provider === "internal") {
    const provider = getProvider("internal");
    await provider.cancel({ restId, assignmentId: delivery.assignmentId, reason });
  }

  await appendDeliveryHistory(restId, orderId, { status: "rejected", actor: courierId || "courier", note: reason });
  const excludeCourierIds = [...(delivery.rejectedCourierIds || []), courierId].filter(Boolean);
  return assign(restId, orderId, { excludeCourierIds });
}

/** Retries a failed/waiting delivery (e.g. Yandex Go request that failed). */
export async function retry(restId, orderId) {
  return assign(restId, orderId);
}

export async function getDelivery(restId, orderId) {
  return getOrderDelivery(restId, orderId);
}
