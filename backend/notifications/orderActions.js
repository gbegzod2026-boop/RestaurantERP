// notifications/orderActions.js — server-side order/reservation status
// actions the Admin Telegram Bot's "✅ Tasdiqlash" / "❌ Bekor qilish" inline
// buttons call (spec Part A sections 9/10/14).
//
// These are NOT a new business-logic implementation — they are the exact
// same atomic transaction pattern admin.js's canonical window.approveOrder()
// / window.cancelOrder() / window.updateReservationStatus() already use
// (runTransaction on the status field to close the TOCTOU window a plain
// read-then-write would leave open against a concurrent payment/cancel),
// replicated here because admin.js is a browser module (client Firebase SDK
// + DOM globals) and cannot be imported into this Node backend. Every write
// path (order status, table status, audit log shape) mirrors admin.js's own
// field names exactly so a bot-driven action is indistinguishable in the
// Admin Panel's own UI/Audit Log from one taken in the panel itself.
//
// Known, disclosed scope cut (see final report): admin.js's approveOrder()/
// cancelOrder() also call window.deductOrderInventory()/restoreOrderInventory()
// — browser-only warehouse-recipe math with no backend equivalent yet. This
// module does NOT run inventory deduction/restoration; an admin using the
// bot to approve/cancel should reconcile stock manually via the panel if
// inventory accuracy matters for that order. Nothing here is a guess at
// what that logic would do — it is simply not invoked.
import { systemGet, systemUpdate, systemPush, systemTransaction } from "../systemDb.js";
import { basePath } from "./common.js";

const TERMINAL_ORDER_STATUSES = new Set(["to'landi", "paid", "canceled", "cancelled"]);

function tableKeyFor(tableNumberOrKey) {
  const raw = String(tableNumberOrKey ?? "").trim();
  if (!raw) return null;
  return raw.startsWith("table_") ? raw : `table_${raw}`;
}

async function writeOrderAuditLog(restId, { action, fromStatus, toStatus, orderId, table, description, severity = "info" }) {
  try {
    await systemPush(`${basePath(restId)}/activityLogs`, {
      userId: "telegram_bot",
      userName: "Telegram Bot (Admin)",
      userRole: "admin_bot",
      module: "orders",
      action,
      target: orderId ? `order:${orderId}` : "order",
      severity,
      description: description || `Status o'zgardi (Telegram bot): ${fromStatus} → ${toStatus}`,
      payload: { orderId: orderId || null, table: table || null, fromStatus: fromStatus || null, toStatus: toStatus || null, via: "telegram_bot" },
      createdAt: Date.now(),
    });
  } catch (err) {
    console.error("[orderActions] writeOrderAuditLog failed:", err.message);
  }
}

/**
 * Mirrors admin.js's window.approveOrder(): atomic status claim (aborts if
 * already paid/cancelled), marks the order "cooking"/"tayyorlanmoqda", and
 * occupies its table. Returns {ok:true} or {ok:false, reason}.
 */
export async function approveOrderViaBot(restId, orderId) {
  const orderSnap = await systemGet(`${basePath(restId)}/orders/${orderId}`);
  const order = orderSnap.val();
  if (!order) return { ok: false, reason: "order_not_found" };

  const fromStatus = order.statusKey || order.status || null;
  const claim = await systemTransaction(`${basePath(restId)}/orders/${orderId}/status`, (current) => {
    if (TERMINAL_ORDER_STATUSES.has(current)) return; // abort — already paid or cancelled
    return "tayyorlanmoqda";
  });
  if (!claim.committed || claim.snapshot.val() !== "tayyorlanmoqda") {
    return { ok: false, reason: "conflict" }; // order status changed concurrently (e.g. already paid/cancelled)
  }

  const now = Date.now();
  await systemUpdate(`${basePath(restId)}/orders/${orderId}`, {
    statusKey: "cooking",
    statusLabel: "Oshpazga yuborildi",
    confirmedAt: now,
    approvedAt: now,
    approvedByAdmin: true,
    approvedVia: "telegram_bot",
  });

  if (order.table) {
    await systemUpdate(`${basePath(restId)}/tables/${tableKeyFor(order.table)}`, {
      status: "busy",
      busy: true,
      orderId,
      occupiedAt: now,
    }).catch(() => {});
  }

  await writeOrderAuditLog(restId, { action: "status_change", fromStatus, toStatus: "tayyorlanmoqda", orderId, table: order.table });
  return { ok: true };
}

/**
 * Mirrors admin.js's window.cancelOrder(): atomic status claim (same
 * paid-order guard), frees the table. Does NOT restore inventory (see file
 * header). Returns {ok:true} or {ok:false, reason}.
 */
export async function cancelOrderViaBot(restId, orderId) {
  const orderSnap = await systemGet(`${basePath(restId)}/orders/${orderId}`);
  const order = orderSnap.val();
  if (!order) return { ok: false, reason: "order_not_found" };

  const fromStatus = order.statusKey || order.status || null;
  const claim = await systemTransaction(`${basePath(restId)}/orders/${orderId}/status`, (current) => {
    const terminal = current === "to'landi" || current === "paid" || current === "canceled";
    if (terminal) return; // abort — already paid (PAID ORDER PROTECTION, spec section 10) or already cancelled
    return "canceled";
  });
  if (!claim.committed || claim.snapshot.val() !== "canceled") {
    return { ok: false, reason: "paid_or_conflict" };
  }

  if (order.table) {
    await systemUpdate(`${basePath(restId)}/tables/${tableKeyFor(order.table)}`, {
      status: "free",
      busy: false,
      orderId: null,
    }).catch(() => {});
  }

  await systemUpdate(`${basePath(restId)}/orders/${orderId}`, {
    statusKey: "canceled",
    statusLabel: "canceled",
    canceledAt: Date.now(),
    canceledBy: "telegram_bot",
  });

  await writeOrderAuditLog(restId, { action: "status_change", fromStatus, toStatus: "canceled", orderId, table: order.table, severity: "warning" });
  return { ok: true };
}

/** Mirrors admin.js's window.updateReservationStatus(id, "confirmed"). */
export async function confirmReservationViaBot(restId, reservationId) {
  const snap = await systemGet(`${basePath(restId)}/reservations/${reservationId}`);
  const r = snap.val();
  if (!r) return { ok: false, reason: "reservation_not_found" };

  await systemUpdate(`${basePath(restId)}/reservations/${reservationId}`, { status: "confirmed", updatedAt: Date.now() });

  const tableNumber = r.tableNumber ?? r.table ?? null;
  if (tableNumber) {
    await systemUpdate(`${basePath(restId)}/tables/${tableKeyFor(tableNumber)}`, { status: "reserved", busy: true }).catch(() => {});
  }
  return { ok: true };
}

/**
 * Mirrors admin.js's window.updateReservationStatus(id, "canceled"). Known,
 * disclosed scope cut: does NOT release the reservationSlots/{date}_{time}_
 * {table} claim admin.js's browser code also clears — that slot-key format
 * lives only in admin.js and guessing it risks a wrong write; an admin
 * rebooking the exact same date/time/table after a bot-cancelled reservation
 * may need to free it once from the panel.
 */
export async function cancelReservationViaBot(restId, reservationId) {
  const snap = await systemGet(`${basePath(restId)}/reservations/${reservationId}`);
  const r = snap.val();
  if (!r) return { ok: false, reason: "reservation_not_found" };

  await systemUpdate(`${basePath(restId)}/reservations/${reservationId}`, { status: "canceled", updatedAt: Date.now(), cancelledBy: "telegram_bot" });

  const tableNumber = r.tableNumber ?? r.table ?? null;
  if (tableNumber) {
    await systemUpdate(`${basePath(restId)}/tables/${tableKeyFor(tableNumber)}`, { status: "free", busy: false }).catch(() => {});
  }
  return { ok: true };
}
