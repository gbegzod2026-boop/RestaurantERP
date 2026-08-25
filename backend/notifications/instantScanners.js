// notifications/instantScanners.js — periodic, poll-based detection for
// events that don't have a single reliable write choke-point in this
// codebase (orders/reservations/reviews can be created either through the
// Express REST API in server.js OR by client.js/admin.js writing straight
// to Firebase RTDB — see backend exploration notes). Polling once a minute
// (driven by scheduler.js) catches both paths without needing a live RTDB
// listener per restaurant, and naturally satisfies spec section 14 ("do not
// generate on every page load — use scheduled background jobs").
//
// Each scanner dedupes via common.js's persisted alert-state store, keyed
// per record id, so a record already alerted is never re-sent.
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so every read here goes through the admin-or-
// client fallback (systemDb.js) instead of the plain client SDK.
import { systemGet } from "../systemDb.js";
import { basePath, getAlertState, setAlertState, isTypeEnabled, getNotificationSettings } from "./common.js";
import { NotificationService } from "./NotificationService.js";
import { NOTIFICATION_TYPES } from "./types.js";
import { getFinanceStatusToday } from "./reportGenerator.js";

const LOOKBACK_MS = 5 * 60 * 1000; // only ever consider records from the last 5 minutes

export async function scanLargeOrders(restId) {
  const settings = await getNotificationSettings(restId);
  if (!isTypeEnabled(settings, NOTIFICATION_TYPES.LARGE_ORDER)) return { alerted: 0 };

  const snap = await systemGet(`${basePath(restId)}/orders`);
  const entries = Object.entries(snap.val() || {});
  const now = Date.now();
  let alerted = 0;

  for (const [id, order] of entries) {
    const createdAt = Number(order.createdAt || 0);
    if (!createdAt || now - createdAt > LOOKBACK_MS) continue;

    const total = Number(order.total || order.finalTotal || 0);
    if (total < settings.largeOrderThreshold) continue;

    const stateKey = `large_order_${id}`;
    if (await getAlertState(restId, stateKey)) continue;

    await NotificationService.send(NOTIFICATION_TYPES.LARGE_ORDER, restId, null, {
      orderId: id,
      orderNumber: order.orderNumber,
      total,
    });
    await setAlertState(restId, stateKey, { sent: true });
    alerted += 1;
  }
  return { alerted };
}

export async function scanNewReservations(restId) {
  const settings = await getNotificationSettings(restId);
  if (!isTypeEnabled(settings, NOTIFICATION_TYPES.RESERVATION_ALERT)) return { alerted: 0 };

  const snap = await systemGet(`${basePath(restId)}/reservations`);
  const entries = Object.entries(snap.val() || {});
  const now = Date.now();
  let alerted = 0;

  for (const [id, res] of entries) {
    const createdAt = Number(res.createdAt || 0);
    if (!createdAt || now - createdAt > LOOKBACK_MS) continue;

    const stateKey = `reservation_${id}`;
    if (await getAlertState(restId, stateKey)) continue;

    await NotificationService.send(NOTIFICATION_TYPES.RESERVATION_ALERT, restId, null, {
      customerName: res.guestName || "",
      dateTime: res.date && res.time ? `${res.date} ${res.time}` : "",
      guests: res.guests || res.guestCount || "",
    });
    await setAlertState(restId, stateKey, { sent: true });
    alerted += 1;
  }
  return { alerted };
}

// 🩹 Audit fix: NOTIFICATION_TYPES.PAYMENT_RECEIVED avval faqat
// backend/payments/common.js'ning markOrderPaid() (Click/Payme/Uzum webhook)
// orqali yuborilardi — kassa.js/waiter.js (writeUnifiedPayment) va
// client.js'ning naqd/karta to'lovlari to'g'ridan-to'g'ri Firebase RTDB'ga
// yozgani uchun bu yo'ldan umuman o'tmasdi, ya'ni haqiqiy to'lovlarning
// aksariyati (naqd/karta — restoran to'lovlarining asosiy qismi) Telegramga
// hech qachon xabar bermasdi. Bu scanner scanCancelledOrders bilan bir xil
// pattern — barcha orders'ni payment.paid bo'yicha tekshiradi, manbasidan
// qat'i nazar. markOrderPaid() endi o'zi ham xuddi shu alertState kalitini
// yozadi — shu bilan online to'lovlar uchun ikki marta xabar ketmaydi.
export async function scanPaymentsReceived(restId) {
  const settings = await getNotificationSettings(restId);
  if (!isTypeEnabled(settings, NOTIFICATION_TYPES.PAYMENT_RECEIVED)) return { alerted: 0 };

  const snap = await systemGet(`${basePath(restId)}/orders`);
  const entries = Object.entries(snap.val() || {});
  let alerted = 0;

  for (const [id, order] of entries) {
    const s = String(order.status || "").toLowerCase();
    const isPaid = order.payment?.paid === true || s === "paid" || s === "to'landi" || s === "completed";
    if (!isPaid) continue;

    const stateKey = `payment_received_${id}`;
    if (await getAlertState(restId, stateKey)) continue;

    await NotificationService.send(NOTIFICATION_TYPES.PAYMENT_RECEIVED, restId, null, {
      orderId: id,
      orderNumber: order.orderNumber,
      amount: Number(order.finalTotal || order.total || 0),
      method: order.payment?.method || order.paymentProvider || "",
    });
    await setAlertState(restId, stateKey, { sent: true });
    alerted += 1;
  }
  return { alerted };
}

// Client ilovasi (client.js) mijozning o'zi bronni bekor qilganda
// status="canceled" + cancelledBy="client" deb yozadi (admin o'zi bekor
// qilganda cancelledBy yozilmaydi — bu holat shu yerda filtrlanadi, admin
// o'ziga o'zi xabar olmasin uchun). scanCancelledOrders() bilan bir xil
// pattern — lookback oynasi yo'q, faqat alertState orqali bir marta yuboriladi.
export async function scanCancelledReservations(restId) {
  const settings = await getNotificationSettings(restId);
  if (!isTypeEnabled(settings, NOTIFICATION_TYPES.RESERVATION_CANCELLED)) return { alerted: 0 };

  const snap = await systemGet(`${basePath(restId)}/reservations`);
  const entries = Object.entries(snap.val() || {});
  let alerted = 0;

  for (const [id, res] of entries) {
    const status = String(res.status || "").toLowerCase();
    if (status !== "canceled" && status !== "cancelled") continue;
    if (res.cancelledBy !== "client") continue;

    const stateKey = `reservation_cancelled_${id}`;
    if (await getAlertState(restId, stateKey)) continue;

    await NotificationService.send(NOTIFICATION_TYPES.RESERVATION_CANCELLED, restId, null, {
      customerName: res.guestName || "",
      dateTime: res.date && res.time ? `${res.date} ${res.time}` : "",
    });
    await setAlertState(restId, stateKey, { sent: true });
    alerted += 1;
  }
  return { alerted };
}

// ── Additive — production notification system (2026 expansion) ────────────

export async function scanNewOrders(restId) {
  const settings = await getNotificationSettings(restId);
  if (!isTypeEnabled(settings, NOTIFICATION_TYPES.NEW_ORDER)) return { alerted: 0 };

  const snap = await systemGet(`${basePath(restId)}/orders`);
  const entries = Object.entries(snap.val() || {});
  const now = Date.now();
  let alerted = 0;

  for (const [id, order] of entries) {
    const createdAt = Number(order.createdAt || 0);
    if (!createdAt || now - createdAt > LOOKBACK_MS) continue;

    const stateKey = `new_order_${id}`;
    if (await getAlertState(restId, stateKey)) continue;

    await NotificationService.send(NOTIFICATION_TYPES.NEW_ORDER, restId, null, {
      orderId: id,
      orderNumber: order.orderNumber,
      total: Number(order.total || order.finalTotal || 0),
    });
    await setAlertState(restId, stateKey, { sent: true });
    alerted += 1;
  }
  return { alerted };
}

const CANCELLED_STATUS_SET = new Set(["cancelled", "canceled", "bekor qilindi", "bekor_qilindi"]);

export async function scanCancelledOrders(restId) {
  const settings = await getNotificationSettings(restId);
  if (!isTypeEnabled(settings, NOTIFICATION_TYPES.ORDER_CANCELLED)) return { alerted: 0 };

  const snap = await systemGet(`${basePath(restId)}/orders`);
  const entries = Object.entries(snap.val() || {});
  let alerted = 0;

  for (const [id, order] of entries) {
    const statusKey = String(order.statusKey || order.status || "").toLowerCase();
    if (!CANCELLED_STATUS_SET.has(statusKey)) continue;

    const stateKey = `order_cancelled_${id}`;
    if (await getAlertState(restId, stateKey)) continue;

    await NotificationService.send(NOTIFICATION_TYPES.ORDER_CANCELLED, restId, null, {
      orderId: id,
      orderNumber: order.orderNumber,
      reason: order.cancelReason || order.paymentCancelReason || "",
    });
    await setAlertState(restId, stateKey, { sent: true });
    alerted += 1;
  }
  return { alerted };
}

// Menu availability is a toggle, not a one-way event — a dish can sell out
// and come back in stock repeatedly the same day. State stores the last
// KNOWN availability so we alert exactly once per false-transition (not
// once ever), and silently re-arm when the dish becomes available again.
export async function scanSoldOutFoods(restId) {
  const settings = await getNotificationSettings(restId);
  if (!isTypeEnabled(settings, NOTIFICATION_TYPES.FOOD_SOLD_OUT)) return { alerted: 0 };

  const snap = await systemGet(`${basePath(restId)}/menu`);
  const entries = Object.entries(snap.val() || {});
  let alerted = 0;

  for (const [id, item] of entries) {
    const isAvailable = item.active !== false && item.available !== false;
    const stateKey = `sold_out_${id}`;
    const prior = await getAlertState(restId, stateKey);
    const wasAvailable = prior ? prior.available !== false : true;

    if (isAvailable !== wasAvailable) {
      if (!isAvailable) {
        const name = typeof item.name === "object" ? (item.name.uz || Object.values(item.name)[0]) : item.name;
        await NotificationService.send(NOTIFICATION_TYPES.FOOD_SOLD_OUT, restId, null, { foodName: name || id });
        alerted += 1;
      }
      await setAlertState(restId, stateKey, { available: isAvailable });
    }
  }
  return { alerted };
}

// Same 20-minute threshold already used by admin.js's own delayed-order
// detection (admin-frontend/public/js/admin.js:14579, `loadNotifications()`)
// — reused here, not reinvented, so "kitchen delay" means the same thing in
// the Telegram alert as it already does in the Admin Panel's own notification feed.
const KITCHEN_DELAY_THRESHOLD_MIN = 20;
const COOKING_STATUS_SET = new Set(["cooking", "tayyorlanmoqda"]);

export async function scanKitchenDelays(restId) {
  const settings = await getNotificationSettings(restId);
  if (!isTypeEnabled(settings, NOTIFICATION_TYPES.KITCHEN_DELAY)) return { alerted: 0 };

  const snap = await systemGet(`${basePath(restId)}/orders`);
  const entries = Object.entries(snap.val() || {});
  const now = Date.now();
  let alerted = 0;

  for (const [id, order] of entries) {
    const statusKey = String(order.statusKey || order.status || "").toLowerCase();
    if (!COOKING_STATUS_SET.has(statusKey)) continue;

    const createdAt = Number(order.createdAt || 0);
    if (!createdAt) continue;
    const minutes = Math.round((now - createdAt) / 60000);
    if (minutes < KITCHEN_DELAY_THRESHOLD_MIN) continue;

    const stateKey = `kitchen_delay_${id}`;
    if (await getAlertState(restId, stateKey)) continue; // already alerted once for this order

    await NotificationService.send(NOTIFICATION_TYPES.KITCHEN_DELAY, restId, null, {
      orderId: id, orderNumber: order.orderNumber, minutes,
    });
    await setAlertState(restId, stateKey, { sent: true });
    alerted += 1;
  }
  return { alerted };
}

// Revenue milestones — fires once per newly-crossed tier per day (e.g. every
// 5,000,000 so'm of today's revenue), using the SAME sales computation as
// the Daily Report and the Finance dashboard button — no separate revenue
// calculation logic.
const DEFAULT_MILESTONE_STEP = 5_000_000;

export async function scanRevenueMilestones(restId) {
  const settings = await getNotificationSettings(restId);
  if (!isTypeEnabled(settings, NOTIFICATION_TYPES.HIGH_REVENUE_MILESTONE)) return { alerted: 0 };

  const sales = await getFinanceStatusToday(restId);
  const step = Number(settings.revenueMilestoneStep) || DEFAULT_MILESTONE_STEP;
  const currentTier = Math.floor(sales.revenue / step);
  if (currentTier < 1) return { alerted: 0 };

  const today = new Date().toDateString();
  const stateKey = "revenue_milestone";
  const prior = await getAlertState(restId, stateKey);
  const priorTier = prior && prior.day === today ? Number(prior.tier || 0) : 0;

  if (currentTier <= priorTier) return { alerted: 0 };

  await NotificationService.send(NOTIFICATION_TYPES.HIGH_REVENUE_MILESTONE, restId, null, {
    milestone: currentTier * step,
  });
  await setAlertState(restId, stateKey, { day: today, tier: currentTier });
  return { alerted: 1 };
}

export async function scanNewReviews(restId) {
  const settings = await getNotificationSettings(restId);
  if (!isTypeEnabled(settings, NOTIFICATION_TYPES.CUSTOMER_REVIEW)) return { alerted: 0 };

  const snap = await systemGet(`${basePath(restId)}/feedback`);
  const entries = Object.entries(snap.val() || {});
  const now = Date.now();
  let alerted = 0;

  for (const [id, fb] of entries) {
    const createdAt = Number(fb.createdAt || 0);
    if (!createdAt || now - createdAt > LOOKBACK_MS) continue;

    const stateKey = `review_${id}`;
    if (await getAlertState(restId, stateKey)) continue;

    const rating = (Number(fb.foodQuality || 0) + Number(fb.serviceQuality || 0) + Number(fb.atmosphere || 0)) / 3;
    await NotificationService.send(NOTIFICATION_TYPES.CUSTOMER_REVIEW, restId, null, {
      rating: Math.round(rating * 10) / 10,
      comment: fb.comment || fb.text || "",
    });
    await setAlertState(restId, stateKey, { sent: true });
    alerted += 1;
  }
  return { alerted };
}
