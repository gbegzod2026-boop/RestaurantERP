// delivery/common.js — shared helpers for the Delivery Engine and its
// provider adapters. Mirrors the conventions in payments/common.js.
//
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so every read/write here goes through the
// admin-or-client fallback (systemDb.js) instead of the plain client SDK.
import { systemGet, systemUpdate, systemPush } from "../systemDb.js";
import { usePostgres } from "../pg/config.js";
import { withLegacyRest } from "../pg/legacyBridge.js";
import { getOrderByLegacy, patchOrderFields } from "../pg/ordersService.js";
import { getSettings } from "../pg/catalogService.js";
import { pushId } from "../pg/pushId.js";

export function basePath(restId) {
  return `restaurants/${restId}`;
}

export const DELIVERY_STATUS = {
  WAITING_FOR_COURIER: "waiting_for_courier",
  ASSIGNED: "assigned",
  ACCEPTED: "accepted",
  HEADING_TO_RESTAURANT: "heading_to_restaurant",
  ARRIVED: "arrived",
  PICKED_UP: "picked_up",
  IN_TRANSIT: "in_transit",
  ARRIVED_CUSTOMER: "arrived_customer",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  CUSTOMER_NOT_FOUND: "customer_not_found",
  RETURNED: "returned",
};

// Linear courier flow, used to validate status transitions coming from the
// courier app. Cancelled/customer_not_found/returned are reachable from any
// active (non-terminal) state, not part of the linear order.
export const COURIER_FLOW_ORDER = [
  DELIVERY_STATUS.ASSIGNED,
  DELIVERY_STATUS.ACCEPTED,
  DELIVERY_STATUS.HEADING_TO_RESTAURANT,
  DELIVERY_STATUS.ARRIVED,
  DELIVERY_STATUS.PICKED_UP,
  DELIVERY_STATUS.IN_TRANSIT,
  DELIVERY_STATUS.ARRIVED_CUSTOMER,
  DELIVERY_STATUS.DELIVERED,
  DELIVERY_STATUS.COMPLETED,
];

const TERMINAL_STATUSES = new Set([
  DELIVERY_STATUS.COMPLETED,
  DELIVERY_STATUS.CANCELLED,
  DELIVERY_STATUS.CUSTOMER_NOT_FOUND,
  DELIVERY_STATUS.RETURNED,
]);

export function isTerminalDeliveryStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

// How long a courier has to Accept/Reject a new-order offer before the
// engine auto-rejects it and moves on to the next courier. Configurable per
// restaurant via settings/deliverySettings.offerTimeoutSec.
export const OFFER_TIMEOUT_SEC_DEFAULT = 25;
export function getOfferTimeoutSec(settings) {
  const v = Number(settings?.offerTimeoutSec);
  return Number.isFinite(v) && v > 0 ? v : OFFER_TIMEOUT_SEC_DEFAULT;
}

export async function getOrder(restId, orderId) {
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

export async function getDeliverySettings(restId) {
  if (usePostgres()) {
    const settings = await withLegacyRest(restId, (client, ctx) => getSettings(client, ctx.restaurantUuid));
    return settings?.deliverySettings || {};
  }
  const snap = await systemGet(`${basePath(restId)}/settings/deliverySettings`);
  return snap.val() || {};
}

/** Merges a patch into orders/{orderId}/delivery (additive sub-object, does not touch the rest of the order). */
export async function updateOrderDelivery(restId, orderId, patch) {
  if (usePostgres()) {
    await withLegacyRest(restId, async (client, ctx, events) => {
      const current = await getOrderByLegacy(client, ctx.restaurantUuid, orderId);
      if (!current) return null;
      const delivery = { ...(current.delivery || {}), ...patch, updatedAt: Date.now() };
      return patchOrderFields(client, ctx, orderId, { delivery }, events);
    });
    return;
  }
  await systemUpdate(`${basePath(restId)}/orders/${orderId}/delivery`, { ...patch, updatedAt: Date.now() });
}

export async function getOrderDelivery(restId, orderId) {
  if (usePostgres()) {
    const current = await withLegacyRest(restId, (client, ctx) => getOrderByLegacy(client, ctx.restaurantUuid, orderId));
    return current?.delivery || null;
  }
  const snap = await systemGet(`${basePath(restId)}/orders/${orderId}/delivery`);
  return snap.val() || null;
}

/** Appends one entry to orders/{orderId}/delivery/history (push, so entries keep insertion order + unique keys). */
export async function appendDeliveryHistory(restId, orderId, { status, actor = "system", note = "" } = {}) {
  if (usePostgres()) {
    await withLegacyRest(restId, async (client, ctx, events) => {
      const current = await getOrderByLegacy(client, ctx.restaurantUuid, orderId);
      if (!current) return null;
      const delivery = { ...(current.delivery || {}) };
      const history = { ...(delivery.history || {}) };
      history[pushId()] = { status, actor, note, at: Date.now() };
      return patchOrderFields(client, ctx, orderId, { delivery: { ...delivery, history, updatedAt: Date.now() } }, events);
    });
    return;
  }
  await systemPush(`${basePath(restId)}/orders/${orderId}/delivery/history`, {
    status,
    actor,
    note,
    at: Date.now(),
  });
}

// Haversine distance in km — ported from admin-frontend/public/js/shared.js
// so the backend doesn't need to import a browser-oriented module.
export function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => typeof v !== "number" || Number.isNaN(v))) return null;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function formatDeliveryAddress(addr) {
  if (!addr) return "";
  if (typeof addr === "string") return addr;
  const parts = [];
  if (addr.street) parts.push(addr.street);
  if (addr.house) parts.push(`${addr.house}-uy`);
  if (addr.apartment) parts.push(`${addr.apartment}-xonadon`);
  if (addr.entrance) parts.push(`${addr.entrance}-podez`);
  if (addr.floor) parts.push(`${addr.floor}-qavat`);
  if (addr.landmark) parts.push(`(${addr.landmark})`);
  return parts.join(", ");
}
