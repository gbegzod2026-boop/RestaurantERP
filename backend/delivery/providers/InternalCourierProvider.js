// delivery/providers/InternalCourierProvider.js — assigns the restaurant's
// own courier fleet. Reuses the exact courierAssignments/{id} shape that
// admin-frontend/public/js/courier.js already reads/writes, so the existing
// courier app needs no schema changes.
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so this file's own reads/writes go through the
// admin-or-client fallback (systemDb.js) instead of the plain client SDK.
import { systemGet, systemUpdate, systemPush } from "../../systemDb.js";
import { basePath, DELIVERY_STATUS, formatDeliveryAddress, haversineDistanceKm, getOfferTimeoutSec } from "../common.js";
import { BaseProvider } from "./BaseProvider.js";
import { usePostgres } from "../../pg/config.js";
import { withLegacyRest } from "../../pg/legacyBridge.js";
import { listCouriersMap, listCourierAssignmentsMap, upsertCourierAssignment, getCourierAssignment } from "../../pg/catalogService.js";
import { pushId } from "../../pg/pushId.js";

// Courier profile status values (restaurants/{id}/couriers/{courierId}/status).
// "online" = Available, "on_delivery" = Busy, "paused" = Break, "offline" = Offline.
// Only Available couriers receive new assignments.
const AVAILABLE_STATUS = "online";

function pickCourierFromMaps(couriers, assignments, excludeCourierIds = []) {
  const excluded = new Set(excludeCourierIds || []);

  const activeCountByCourier = {};
  Object.values(assignments).forEach((a) => {
    if (["assigned", "accepted", "heading_to_restaurant", "arrived", "picked_up", "in_transit", "arrived_customer"].includes(a.status)) {
      activeCountByCourier[a.courierId] = (activeCountByCourier[a.courierId] || 0) + 1;
    }
  });

  // Assignment priority per spec: 1) Available  2) Online (implicit — only
  // "online"/Available couriers are candidates at all)  3) lowest active
  // deliveries  4) nearest (future GPS — not wired yet)  5) current shift
  // (tie-broken by lastSeenAt, most-recently-active first).
  const candidates = Object.entries(couriers)
    .filter(([id, c]) => c.status === AVAILABLE_STATUS && !excluded.has(id))
    .map(([id, c]) => ({ id, courier: c, activeCount: activeCountByCourier[id] || 0 }))
    .sort((a, b) => a.activeCount - b.activeCount || (b.courier.lastSeenAt || 0) - (a.courier.lastSeenAt || 0));

  return candidates[0] || null;
}

async function findAvailableCourier(restId, excludeCourierIds = []) {
  if (usePostgres()) {
    const maps = await withLegacyRest(restId, async (client, ctx) => ({
      couriers: await listCouriersMap(client, ctx.restaurantUuid),
      assignments: await listCourierAssignmentsMap(client, ctx.restaurantUuid),
    }));
    if (!maps) return null;
    return pickCourierFromMaps(maps.couriers || {}, maps.assignments || {}, excludeCourierIds);
  }
  const [couriersSnap, assignmentsSnap] = await Promise.all([
    systemGet(`${basePath(restId)}/couriers`),
    systemGet(`${basePath(restId)}/courierAssignments`),
  ]);
  return pickCourierFromMaps(couriersSnap.val() || {}, assignmentsSnap.val() || {}, excludeCourierIds);
}

export class InternalCourierProvider extends BaseProvider {
  static key = "internal";

  async createDelivery(ctx) {
    const { restId, orderId, order, restaurantLocation, customerLocation, excludeCourierIds } = ctx;

    // 🆕 "Qo'lda tayinlash" (deliverySettings.assignmentMode === "manual") —
    // Admin Sozlamalar'da bu maydon allaqachon mavjud edi, lekin hech qayerda
    // o'qilmasdi (dead setting). Endi: manual rejimda hech qanday kuryer
    // avtomatik tanlanmaydi — buyurtma courierId:null bilan umumiy "poolga"
    // tushadi, istalgan online kuryer uni o'zi (courier.js:
    // claimUnassignedOrder(), atomik runTransaction orqali) olishi mumkin.
    // MUHIM: bu FAQAT admin ATAYLAB "manual" tanlaganda ishga tushadi —
    // "auto"/belgilanmagan holatda xatti-harakat 100% avvalgidek (shu
    // jumladan avtomatik kuryer topilmasa "automatic" provider rejimida
    // Yandex Go'ga fallback qilish — pastdagi asosiy yo'l hech qanday
    // o'zgarishsiz qoladi).
    const manualMode = ctx.settings?.assignmentMode === "manual";
    const picked = manualMode ? null : await findAvailableCourier(restId, excludeCourierIds);
    if (!picked && !manualMode) {
      return { ok: false, status: DELIVERY_STATUS.WAITING_FOR_COURIER, reason: "no_courier_available" };
    }

    const addressRaw = order.deliveryAddress || order.address || "";
    const address = formatDeliveryAddress(addressRaw) || (typeof addressRaw === "string" ? addressRaw : "");
    const distanceKm =
      restaurantLocation && customerLocation
        ? haversineDistanceKm(restaurantLocation.lat, restaurantLocation.lng, customerLocation.lat, customerLocation.lng)
        : null;

    const now = Date.now();

    const paymentMethod = order.deliveryPaymentMethod || "cash_on_delivery";
    const isPrepaid = paymentMethod === "prepaid_card" && order.payment?.paid === true;
    const offerTimeoutSec = getOfferTimeoutSec(ctx.settings);
    const addr = order.deliveryAddress && typeof order.deliveryAddress === "object" ? order.deliveryAddress : {};

    // systemPush() creates the key AND writes the data in one call — safe
    // here (unlike a merge-into-existing-data update()) because this is a
    // brand-new courierAssignments/{id} node with nothing to preserve.
    const baseFields = {
      orderId,
      orderNumber: order.orderNumber || "",
      restaurantName: order.restaurantName || ctx.settings?.restaurantName || "",
      restaurantLocation: restaurantLocation || null,
      customerLocation: customerLocation || null,
      address,
      customerName: order.customerName || "",
      customerPhone: order.customerPhone || order.clientPhone || order.phone || "",
      total: Number(order.finalTotal || order.total || 0),
      note: order.deliveryNote || order.note || "",
      // Delivery notes detail (floor/entrance/door code/landmark) — sourced
      // from order.deliveryAddress, shown as distinct fields in the courier
      // app rather than flattened into a single string.
      addressDetails: {
        floor: addr.floor || "",
        entrance: addr.entrance || "",
        doorCode: addr.doorCode || addr.domofonCode || "",
        landmark: addr.landmark || "",
      },
      paymentMethod,
      isPrepaid,
      distanceKm,
      etaMinutes: ctx.settings?.defaultEtaMinutes || 45,
      status: "assigned",
      assignedAt: now,
    };

    if (manualMode) {
      // 🆕 Umumiy pool yozuvi — courierId hali yo'q, hech qanday
      // offerExpiresAt/timeout mexanizmi qo'llanilmaydi (bu faqat
      // courier-specific offer oqimiga tegishli). courier.js:
      // claimUnassignedOrder() runTransaction orqali courierId'ni
      // atomik ravishda o'zlashtiradi.
      const assignmentId = await persistAssignment(restId, {
        ...baseFields,
        courierId: null,
        subStage: "unassigned",
        assignedVia: "manual_pool",
      });
      return {
        ok: true,
        status: DELIVERY_STATUS.ASSIGNED,
        assignmentId,
        distance: distanceKm,
        eta: ctx.settings?.defaultEtaMinutes || 45,
      };
    }

    const assignmentId = await persistAssignment(restId, {
      ...baseFields,
      courierId: picked.id,
      subStage: "accepted_pending",
      offerExpiresAt: now + offerTimeoutSec * 1000,
      assignedVia: "delivery_engine",
    });

    return {
      ok: true,
      status: DELIVERY_STATUS.ASSIGNED,
      courierId: picked.id,
      courierName: picked.courier.name || "",
      assignmentId,
      distance: distanceKm,
      eta: ctx.settings?.defaultEtaMinutes || 45,
    };
  }

  async getStatus(ctx) {
    if (usePostgres()) {
      const a = await withLegacyRest(ctx.restId, (client, t) => getCourierAssignment(client, t.restaurantUuid, ctx.assignmentId));
      if (!a) return { ok: false, status: DELIVERY_STATUS.CANCELLED };
      return { ok: true, status: a.status };
    }
    const snap = await systemGet(`${basePath(ctx.restId)}/courierAssignments/${ctx.assignmentId}`);
    if (!snap.exists()) return { ok: false, status: DELIVERY_STATUS.CANCELLED };
    return { ok: true, status: snap.val().status };
  }

  async cancel(ctx) {
    if (ctx.assignmentId) {
      if (usePostgres()) {
        await withLegacyRest(ctx.restId, async (client, t, events) => {
          const current = await getCourierAssignment(client, t.restaurantUuid, ctx.assignmentId) || {};
          return upsertCourierAssignment(client, t, ctx.assignmentId, {
            ...current,
            status: "cancelled",
            cancelledAt: Date.now(),
            cancelReason: ctx.reason || "",
          }, events);
        });
      } else {
        await systemUpdate(`${basePath(ctx.restId)}/courierAssignments/${ctx.assignmentId}`, {
          status: "cancelled",
          cancelledAt: Date.now(),
          cancelReason: ctx.reason || "",
        });
      }
    }
    return { ok: true, status: DELIVERY_STATUS.CANCELLED };
  }
}

async function persistAssignment(restId, payload) {
  if (usePostgres()) {
    const key = pushId();
    await withLegacyRest(restId, (client, ctx, events) => upsertCourierAssignment(client, ctx, key, payload, events));
    return key;
  }
  return systemPush(`${basePath(restId)}/courierAssignments`, payload);
}
