// Shared.js
// ==============================
// 🔹 IMPORTS
// ==============================
import { ref, onValue, remove, push, set, update, get } from "./pgRtdb.js";
import { t, getLang } from "./i18n.js";

export const ORDER_STATUS = {
  NEW: "new",
  APPROVED: "approved",
  COOKING: "cooking",
  READY: "ready",
  DELIVERING: "delivering",
  CLOSED: "closed",
  CANCELLED: "cancelled"
};

export const ORDER_STATUS_V2 = {
  WAITER: { key: "waiter", order: 0, labelUz: "Ofitsiant", labelKey: "waiter", parallel: false },
  ORDER_CREATED: { key: "order_created", order: 1, labelUz: "Buyurtma yaratildi", labelKey: "status_v2_order_created", parallel: false },
  KITCHEN_PRINTER: { key: "kitchen_printer", order: 2, labelUz: "Oshxona printeri", labelKey: "status_v2_kitchen_printer", parallel: true },
  KITCHEN_DISPLAY: { key: "kitchen_display", order: 2, labelUz: "Oshxona displeyi", labelKey: "status_v2_kitchen_display", parallel: true },
  PREPARING: { key: "preparing", order: 3, labelUz: "Tayyorlanmoqda", labelKey: "status_preparing", parallel: false },
  READY: { key: "ready", order: 4, labelUz: "Tayyor", labelKey: "status_ready", parallel: false },
  PICKED_UP: { key: "picked_up", order: 5, labelUz: "Olib ketildi", labelKey: "status_v2_picked_up", parallel: false },
  SERVED: { key: "served", order: 6, labelUz: "Xizmat qilindi", labelKey: "status_v2_served", parallel: false },
  CASHIER: { key: "cashier", order: 7, labelUz: "Kassir", labelKey: "status_v2_cashier", parallel: false },
  PAYMENT: { key: "payment", order: 8, labelUz: "To'lov", labelKey: "status_v2_payment", parallel: false },
  COMPLETED: { key: "completed", order: 9, labelUz: "Yakunlandi", labelKey: "status_completed", parallel: false },
  CANCELLED: { key: "cancelled", order: -1, labelUz: "Bekor qilindi", labelKey: "status_cancelled", parallel: false }
};

export const ORDER_STATUS_V2_FLOW = [
  ORDER_STATUS_V2.WAITER,
  ORDER_STATUS_V2.ORDER_CREATED,
  ORDER_STATUS_V2.KITCHEN_PRINTER,
  ORDER_STATUS_V2.KITCHEN_DISPLAY,
  ORDER_STATUS_V2.PREPARING,
  ORDER_STATUS_V2.READY,
  ORDER_STATUS_V2.PICKED_UP,
  ORDER_STATUS_V2.SERVED,
  ORDER_STATUS_V2.CASHIER,
  ORDER_STATUS_V2.PAYMENT,
  ORDER_STATUS_V2.COMPLETED
];

const LEGACY_STATUS_TO_V2 = {
  "pending": ORDER_STATUS_V2.ORDER_CREATED.key,
  "new": ORDER_STATUS_V2.ORDER_CREATED.key,
  "queue": ORDER_STATUS_V2.ORDER_CREATED.key,
  "approved": ORDER_STATUS_V2.PREPARING.key,
  "cooking": ORDER_STATUS_V2.PREPARING.key,
  "ready": ORDER_STATUS_V2.READY.key,
  "closed": ORDER_STATUS_V2.COMPLETED.key,
  "paid": ORDER_STATUS_V2.COMPLETED.key,

  "yangi": ORDER_STATUS_V2.ORDER_CREATED.key,
  "kutilmoqda": ORDER_STATUS_V2.ORDER_CREATED.key,
  "tasdiqlandi": ORDER_STATUS_V2.PREPARING.key,
  "tayyorlanmoqda": ORDER_STATUS_V2.PREPARING.key,
  "tayyor": ORDER_STATUS_V2.READY.key,
  "yopildi": ORDER_STATUS_V2.COMPLETED.key,
  "to'landi": ORDER_STATUS_V2.COMPLETED.key,
  "tolandi": ORDER_STATUS_V2.COMPLETED.key,
  "yetkazildi": ORDER_STATUS_V2.SERVED.key,
  "yetkazilmoqda": ORDER_STATUS_V2.PICKED_UP.key,
  "delivering": ORDER_STATUS_V2.PICKED_UP.key,
  "delivered": ORDER_STATUS_V2.SERVED.key,
  // Bekor qilingan buyurtmalar — barcha sahifalarda uchraydigan variantlar
  "canceled": ORDER_STATUS_V2.CANCELLED.key,
  "cancelled": ORDER_STATUS_V2.CANCELLED.key,
  "bekor qilindi": ORDER_STATUS_V2.CANCELLED.key,
  // Ofitsiant sahifasida ishlatilgan "eating" holati  
  "eating": ORDER_STATUS_V2.SERVED.key,
  // To'lov holatlari
  "completed": ORDER_STATUS_V2.COMPLETED.key
};

// Har qanday (eski yoki yangi) status qiymatini yangi barqaror key'ga aylantiradi.
export function normalizeOrderStatusV2(rawStatus) {
  const s = String(rawStatus || "").trim().toLowerCase();
  if (!s) return ORDER_STATUS_V2.ORDER_CREATED.key;

  const isAlreadyV2 = Object.values(ORDER_STATUS_V2).some(st => st.key === s);
  if (isAlreadyV2) return s;

  return LEGACY_STATUS_TO_V2[s] || s;
}

export function getStatusV2Label(rawStatus) {
  const key = normalizeOrderStatusV2(rawStatus);
  const found = Object.values(ORDER_STATUS_V2).find(st => st.key === key);
  if (!found) return rawStatus;
  return typeof t === "function" ? t(found.labelKey, found.labelUz) : found.labelUz;
}

export function getStatusV2Order(rawStatus) {
  const key = normalizeOrderStatusV2(rawStatus);
  const found = Object.values(ORDER_STATUS_V2).find(st => st.key === key);
  return found ? found.order : -1;
}

// Status o'zgarganda Audit Log'ga yozish (restaurants/{id}/activityLogs —
// admin.js Audit Log bo'limi shu yo'ldan o'qiydi, hech narsa o'zgarmagan).
// db va basePath har bir sahifa (admin/waiter/chef/cashier) o'zining
// Firebase instance'idan uzatadi.
export async function writeOrderAuditLog(db, basePath, {
  actorId,
  actorName,
  actorRole,
  action = "status_change",
  fromStatus,
  toStatus,
  orderId,
  table,
  description,
  severity = "info"
} = {}) {
  try {
    await push(ref(db, `${basePath}/activityLogs`), {
      userId: actorId || "system",
      userName: actorName || "Tizim",
      userRole: actorRole || "system",
      module: "orders",
      action,
      target: orderId ? `order:${orderId}` : "order",
      severity,
      description: description || `Status o'zgardi: ${getStatusV2Label(fromStatus)} → ${getStatusV2Label(toStatus)}`,
      payload: {
        orderId: orderId || null,
        table: table || null,
        fromStatus: fromStatus ? normalizeOrderStatusV2(fromStatus) : null,
        toStatus: toStatus ? normalizeOrderStatusV2(toStatus) : null
      },
      createdAt: Date.now()
    });
  } catch (err) {
    console.error("writeOrderAuditLog xato:", err);
  }
}

// ==============================
// 🔹 ORDER CHANGE REQUESTS — Ofitsiant "bekor qilish" / "almashtirish"
// so'rovi, Admin YOKI Kassir tasdiqlagandan keyin ordergo qo'llanadi.
// restaurants/{restId}/orderChangeRequests/{requestId} — yangi, mavjud
// order schemasini buzmaydigan alohida node (items/total/discount
// maydonlari to'g'ridan-to'g'ri ORIGINAL order ustida qoladi, faqat
// approve bo'lgandan keyin shu funksiya orqali o'zgaradi).
//
// Bu yerda: admin.js VA kassa.js EKKALASI HAM shu bitta funksiyani
// chaqiradi (ikkalasi ham allaqachon shared.js'ni import qiladi) — order
// mutatsiya/recompute mantig'i ikki joyda alohida-alohida yozilmagan.
// ==============================

// Firebase orders/{id}/items obyektidagi bitta qatorning umumiy summasi.
function _ocrItemLineTotal(item) {
  return Number(item?.price || 0) * Number(item?.qty || 0);
}

// Order.items obyektidan yangi `total`ni ASLIDAN (delta emas) qayta
// hisoblaydi — waiter.js'dagi mavjud delta-based yangilashlar (masalan
// removeCartRow) uzoq muddatda drift qilishi mumkin edi; approve vaqtida
// har doim to'liq qayta hisoblash xavfsizroq.
function _ocrRecomputeTotal(items) {
  return Object.values(items || {}).reduce((sum, it) => sum + _ocrItemLineTotal(it), 0);
}

// waiter.js'dagi computeFinalOrderTotal() bilan AYNAN bir xil formula
// (waiter.js discount% ni customer/promo orqali ANIQLAYDI — bu yerda esa
// ordergda ALLAQACHON saqlangan discountPercent qiymati QAYTA ISHLATILADI,
// yangi chegirma siyosati o'ylab topilmaydi — faqat baza summa o'zgargani
// uchun chegirma SUMMASI shu yangi bazaga nisbatan qayta hisoblanadi).
// Xizmat haqi foizi/minimal summasi restaurant sozlamalaridan o'qiladi —
// bu ham waiter.js buyurtma yaratishda ishlatgan manba bilan bir xil.
function _ocrComputeTotals(newSubtotal, order, settings) {
  const discountPercent = Number(order?.discountPercent || 0);
  const discountAmount = discountPercent > 0 ? Math.round(newSubtotal * discountPercent / 100) : 0;

  const svcPct = Number(settings?.serviceFee || 0);
  const svcMinOrder = Number(settings?.serviceFeeMinOrder || 0);
  const svcApplies = svcPct > 0 && (svcMinOrder === 0 || newSubtotal >= svcMinOrder);
  const serviceFeeAmount = svcApplies ? Math.round(newSubtotal * svcPct / 100) : 0;

  const finalTotal = Math.max(0, newSubtotal - discountAmount + serviceFeeAmount);
  return { total: newSubtotal, discountAmount, serviceFeeAmount, finalTotal };
}

// So'rovda ko'rsatilgan itemKey/oldItem asosida items obyektini
// mutatsiya qiladi (cancel: miqdorni kamaytiradi/qatorni o'chiradi;
// replace: eski qatorni kamaytiradi + yangi taomni qo'shadi/oshiradi).
// Original `items` obyekti mutatsiya qilinmaydi — yangi nusxa qaytariladi.
function _ocrApplyItemMutation(items, request) {
  const next = { ...(items || {}) };
  const oldKey = request.itemKey;
  const oldRow = oldKey ? next[oldKey] : null;

  if (request.requestType === "cancel_item") {
    if (!oldRow) return next; // qator allaqachon yo'q (masalan boshqa yo'l bilan o'chirilgan) — jim o'tkazib yuboramiz
    const cancelQty = Math.max(0, Number(request.requestedCancelQty || 0));
    const remaining = Math.max(0, Number(oldRow.qty || 0) - cancelQty);
    if (remaining <= 0) {
      delete next[oldKey];
    } else {
      next[oldKey] = { ...oldRow, qty: remaining };
    }
    return next;
  }

  if (request.requestType === "replace_item") {
    if (oldRow) {
      const replaceQty = Math.max(0, Number(request.oldQuantity || 0));
      const remaining = Math.max(0, Number(oldRow.qty || 0) - replaceQty);
      if (remaining <= 0) delete next[oldKey];
      else next[oldKey] = { ...oldRow, qty: remaining };
    }
    const newItem = request.newItem || {};
    const newQty = Math.max(0, Number(request.newQuantity || 0));
    if (newQty > 0 && newItem.id) {
      // Bir xil menyu taomi allaqachon (boshqa qatorda) bo'lsa — miqdorini
      // oshiramiz, aks holda yangi qator qo'shamiz (waiter.js'dagi cart
      // birlashtirish mantig'iga mos yondashuv).
      const existingKey = Object.keys(next).find(k => next[k]?.id === newItem.id && !next[k]?.variantKey);
      if (existingKey) {
        next[existingKey] = { ...next[existingKey], qty: Number(next[existingKey].qty || 0) + newQty };
      } else {
        next[`${newItem.id}__${Date.now()}`] = {
          id: newItem.id,
          name: newItem.name,
          price: Number(newItem.price || 0),
          qty: newQty,
          note: "",
          status: "pending",
          addedBy: request.approvedByName || request.createdByName || "",
          addedById: request.approvedByUid || request.createdByUid || "",
          addedAt: Date.now(),
        };
      }
    }
    return next;
  }

  return next;
}

/**
 * Admin YOKI Kassir bitta so'rovni tasdiqlaganda chaqiriladi. Idempotent —
 * status/status maydoniga runTransaction bilan yoziladi, shuning uchun
 * ikkinchi panel keyinroq bossa ham order IKKINCHI MARTA o'zgarmaydi
 * (paymentEngine.js'dagi writeUnifiedPayment() bilan bir xil naqsh).
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function approveOrderChangeRequest({
  db, ref, get, update, runTransaction,
  basePath, requestId, actor, // actor: {uid, name, role}
}) {
  const _ocrDebug = typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  if (_ocrDebug) console.log("[OCR-DIAG] approve start", requestId);
  const reqRef = ref(db, `${basePath}/orderChangeRequests/${requestId}`);
  const reqSnap = await get(reqRef);
  if (!reqSnap.exists()) return { ok: false, reason: "not_found" };
  const request = reqSnap.val();

  const orderSnap = await get(ref(db, `${basePath}/orders/${request.orderId}`));
  if (!orderSnap.exists()) return { ok: false, reason: "order_not_found" };
  const order = orderSnap.val();

  // To'langan buyurtmani jim o'zgartirib yubormaymiz (item 16) — bunday
  // holatda approve butunlay bloklanadi, so'rov "pending" holicha qoladi
  // (admin/kassir alohida refund/correction jarayoni bilan hal qiladi).
  if (order?.payment?.paid === true || order?.status === "to'landi") {
    return { ok: false, reason: "order_already_paid" };
  }

  // ── Idempotentlik: faqat "pending" holatidan "approved"ga o'tish
  //    muvaffaqiyatli bo'ladi. Ikkinchi panel/ikkinchi bosish shu yerda
  //    committed:false bilan to'xtaydi — orderga hech narsa yozilmaydi. ──
  const statusRef = ref(db, `${basePath}/orderChangeRequests/${requestId}/status`);
  const txn = await runTransaction(statusRef, (current) => {
    if (current !== "pending") return; // abort — allaqachon hal qilingan
    return "approved";
  });
  if (!txn.committed || txn.snapshot.val() !== "approved") {
    if (_ocrDebug) console.log("[OCR-DIAG] approve end", requestId, "already_resolved (no-op)");
    return { ok: false, reason: "already_resolved" };
  }
  if (_ocrDebug) console.log("[OCR-DIAG] request state: pending -> approved", requestId);

  // ── Order mutatsiyasi — FAQAT shu yerga yetib kelgan (ya'ni haqiqatan
  //    pending→approved o'tishni BIZ amalga oshirgan) chaqiruvda ishlaydi. ──
  const settingsSnap = await get(ref(db, `${basePath}/settings`));
  const settings = settingsSnap.val() || {};

  const newItems = _ocrApplyItemMutation(order.items, request);
  const totals = _ocrComputeTotals(_ocrRecomputeTotal(newItems), order, settings);

  const updates = {};
  updates[`${basePath}/orders/${request.orderId}/items`] = newItems;
  updates[`${basePath}/orders/${request.orderId}/total`] = totals.total;
  updates[`${basePath}/orders/${request.orderId}/discountAmount`] = totals.discountAmount;
  updates[`${basePath}/orders/${request.orderId}/serviceFeeAmount`] = totals.serviceFeeAmount;
  updates[`${basePath}/orders/${request.orderId}/finalTotal`] = totals.finalTotal;
  updates[`${basePath}/orders/${request.orderId}/lastChangeRequestId`] = requestId;
  updates[`${basePath}/orderChangeRequests/${requestId}/approvedByUid`] = actor?.uid || "";
  updates[`${basePath}/orderChangeRequests/${requestId}/approvedByName`] = actor?.name || "";
  updates[`${basePath}/orderChangeRequests/${requestId}/approvedByRole`] = actor?.role || "";
  updates[`${basePath}/orderChangeRequests/${requestId}/approvedAt`] = Date.now();

  await update(ref(db), updates);

  await writeOrderAuditLog(db, basePath, {
    actorId: actor?.uid, actorName: actor?.name, actorRole: actor?.role,
    action: "order_change_approved",
    orderId: request.orderId,
    table: request.tableId,
    description: `${actor?.name || ""}: ${request.requestType === "cancel_item" ? "bekor qilish" : "almashtirish"} so'rovini tasdiqladi (${request.oldItem?.name || ""})`,
    severity: "warning",
  });

  if (_ocrDebug) console.log("[OCR-DIAG] approve end", requestId, "ok");
  return { ok: true, requestId, orderId: request.orderId, totals };
}

/** Admin/Kassir rad etganda. Xuddi shu idempotentlik kafolati bilan. */
export async function rejectOrderChangeRequest({
  db, ref, get, update, runTransaction,
  basePath, requestId, actor, reason,
}) {
  const _ocrDebug = typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  if (_ocrDebug) console.log("[OCR-DIAG] reject start", requestId);
  const statusRef = ref(db, `${basePath}/orderChangeRequests/${requestId}/status`);
  const txn = await runTransaction(statusRef, (current) => {
    if (current !== "pending") return;
    return "rejected";
  });
  if (!txn.committed || txn.snapshot.val() !== "rejected") {
    if (_ocrDebug) console.log("[OCR-DIAG] reject end", requestId, "already_resolved (no-op)");
    return { ok: false, reason: "already_resolved" };
  }
  if (_ocrDebug) console.log("[OCR-DIAG] request state: pending -> rejected", requestId);

  const reqSnap = await get(ref(db, `${basePath}/orderChangeRequests/${requestId}`));
  const request = reqSnap.val() || {};

  await update(ref(db, `${basePath}/orderChangeRequests/${requestId}`), {
    rejectedByUid: actor?.uid || "",
    rejectedByName: actor?.name || "",
    rejectedByRole: actor?.role || "",
    rejectedAt: Date.now(),
    rejectReason: reason || "",
  });

  await writeOrderAuditLog(db, basePath, {
    actorId: actor?.uid, actorName: actor?.name, actorRole: actor?.role,
    action: "order_change_rejected",
    orderId: request.orderId,
    table: request.tableId,
    description: `${actor?.name || ""}: ${request.requestType === "cancel_item" ? "bekor qilish" : "almashtirish"} so'rovini rad etdi`,
    severity: "info",
  });

  if (_ocrDebug) console.log("[OCR-DIAG] reject end", requestId, "ok");
  return { ok: true };
}

// ESKI qiymatlar (o'chirilmaydi, faqat kengaytiriladi — pastda izoh berilgan
// LEGACY_TABLE_STATUS_TO_V2 orqali TABLE_STATUS_V2 ga moslashtiriladi):
export const TABLE_STATUS = {
  OPEN: "open",
  BUSY: "busy",
  EATING: "eating",     // Taomlar yetkazildi, mijoz yetyapti
  OCCUPIED: "occupied",   // Stol band (buyurtma qabul qilingach)
  READY: "ready",      // Taomlar tayyor, olib borilmagan
  BILLING: "billing",    // Hisob so'ralgan
  CLEANING: "cleaning"
};

// ==============================
// 🔹 STOL STATUSLARI — YANGI STANDART (V2)
// ==============================
// admin.js dagi TABLE_STATUS_CONFIG (9 holat: Bo'sh/Band/Buyurtma
// olindi/Tayyorlanmoqda/Tayyor/Xizmat ko'rsatildi/Hisob so'ralgan/
// To'langan/Tozalanmoqda) shu yerga ko'chirildi va barcha panellar
// (admin, chef, waiter, client, kassa) uchun YAGONA manba bo'ladi.
// Har bir status: { key, order, labelUz, icon, color, bg, cardBg, border }
// 🌗 color/bg/border — dark-mode-aware CSS var() bilan, asl hex FALLBACK
// sifatida saqlanadi (admin.css'da mos --tbl-st-* token topilmasa yoki bu
// obyekt CSS bo'lmagan kontekstda ishlatilsa ham natija o'zgarmaydi). Var
// nomlari faqat admin.css'da e'lon qilingan (Stollar bo'limi shu yerdan
// o'qiydi) — BILLING/PAID/CLEANING solid-rang + oq matn bo'lgani uchun
// ikkala rejimda ham allaqachon kontrastli, ularga alohida token kerak emas.
export const TABLE_STATUS_V2 = {
  FREE: { key: "free", order: 0, labelUz: "Bo'sh", labelKey: "table_status_free", icon: "🟢", color: "var(--tbl-st-free-text, #15803d)", bg: "var(--tbl-st-free-bg, #dcfce7)", cardBg: "#f0fdf4", border: "var(--tbl-st-free-border, #bbf7d0)" },
  OCCUPIED: { key: "occupied", order: 1, labelUz: "Band", labelKey: "table_status_busy", icon: "🔴", color: "var(--tbl-st-occupied-text, #b91c1c)", bg: "var(--tbl-st-occupied-bg, #fee2e2)", cardBg: "#fef2f2", border: "var(--tbl-st-occupied-border, #fecaca)" },
  ORDER_RECEIVED: { key: "order_received", order: 2, labelUz: "Buyurtma olindi", labelKey: "table_status_order_received", icon: "📝", color: "var(--tbl-st-received-text, #1d4ed8)", bg: "var(--tbl-st-received-bg, #dbeafe)", cardBg: "#eff6ff", border: "var(--tbl-st-received-border, #bfdbfe)" },
  PREPARING: { key: "preparing", order: 3, labelUz: "Ovqat tayyorlanmoqda", labelKey: "table_status_preparing", icon: "👨‍🍳", color: "var(--tbl-st-preparing-text, #7c3aed)", bg: "var(--tbl-st-preparing-bg, #ede9fe)", cardBg: "#f5f3ff", border: "var(--tbl-st-preparing-border, #ddd6fe)" },
  READY: { key: "ready", order: 4, labelUz: "Ovqat tayyor", labelKey: "table_status_ready", icon: "🍽️", color: "var(--tbl-st-ready-text, #047857)", bg: "var(--tbl-st-ready-bg, #d1fae5)", cardBg: "#ecfdf5", border: "var(--tbl-st-ready-border, #a7f3d0)" },
  SERVED: { key: "served", order: 5, labelUz: "Xizmat ko'rsatildi", labelKey: "table_status_served", icon: "✅", color: "var(--tbl-st-served-text, #4338ca)", bg: "var(--tbl-st-served-bg, #e0e7ff)", cardBg: "#eef2ff", border: "var(--tbl-st-served-border, #c7d2fe)" },
  BILLING: { key: "billing", order: 6, labelUz: "Hisob so'ralgan", labelKey: "table_status_billing", icon: "💳", color: "#ffffff", bg: "#ef4444", cardBg: "#fef2f2", border: "#fca5a5" },
  PAID: { key: "paid", order: 7, labelUz: "To'langan", labelKey: "table_status_paid", icon: "💰", color: "#ffffff", bg: "#0e7490", cardBg: "#ecfeff", border: "#a5f3fc" },
  CLEANING: { key: "cleaning", order: 8, labelUz: "Tozalanmoqda", labelKey: "table_status_cleaning", icon: "🧹", color: "#ffffff", bg: "#0ea5e9", cardBg: "#f0f9ff", border: "#bae6fd" }
};

export const TABLE_STATUS_V2_FLOW = [
  TABLE_STATUS_V2.FREE,
  TABLE_STATUS_V2.OCCUPIED,
  TABLE_STATUS_V2.ORDER_RECEIVED,
  TABLE_STATUS_V2.PREPARING,
  TABLE_STATUS_V2.READY,
  TABLE_STATUS_V2.SERVED,
  TABLE_STATUS_V2.BILLING,
  TABLE_STATUS_V2.PAID,
  TABLE_STATUS_V2.CLEANING
];

// ESKI → YANGI stol-status moslashtirish. admin.js, chef.js, waiter.js,
// client.js da xar xil nom bilan yozilgan qiymatlarning barchasi shu
// yerda yig'ilgan ("busy"→occupied, "needs_cleaning"→cleaning, va h.k.).
const LEGACY_TABLE_STATUS_TO_V2 = {
  "free": "free",
  "open": "free",
  "bo'sh": "free",

  "busy": "occupied",
  "occupied": "occupied",
  "band": "occupied",

  "order_received": "order_received",

  "preparing": "preparing",
  "cooking": "preparing",
  "tayyorlanmoqda": "preparing",

  "ready": "ready",
  "tayyor": "ready",

  "eating": "served",
  "served": "served",
  "yetkazildi": "served",

  "billing": "billing",
  "hisob": "billing",

  "paid": "paid",
  "to'landi": "paid",

  "cleaning": "cleaning",
  "needs_cleaning": "cleaning",
  "tozalanmoqda": "cleaning"
};

// Har qanday (eski yoki yangi) stol-status qiymatini yangi
// barqaror key'ga aylantiradi. Noma'lum qiymat kelsa "occupied"
// qaytariladi (admin.js dagi asl fallback xatti-harakati saqlangan:
// noma'lum status "band" deb ko'rsatilishi kerak, "bo'sh" emas).
export function normalizeTableStatusV2(rawStatus) {
  const s = String(rawStatus || "").trim().toLowerCase();
  if (!s) return TABLE_STATUS_V2.FREE.key;

  const isAlreadyV2 = Object.values(TABLE_STATUS_V2).some(st => st.key === s);
  if (isAlreadyV2) return s;

  return LEGACY_TABLE_STATUS_TO_V2[s] || TABLE_STATUS_V2.OCCUPIED.key;
}

export function getTableStatusV2Info(rawStatus) {
  const key = normalizeTableStatusV2(rawStatus);
  return Object.values(TABLE_STATUS_V2).find(st => st.key === key) || TABLE_STATUS_V2.OCCUPIED;
}

export function getTableStatusV2Label(rawStatus) {
  const info = getTableStatusV2Info(rawStatus);
  return typeof t === "function" ? t(info.labelKey, info.labelUz) : info.labelUz;
}

// Buyurtma statusidan (ORDER_STATUS_V2 key) mos stol statusini hosil
// qiladi. admin.js dagi ORDER_TO_TABLE_STATUS_MAP shu yerga ko'chirildi
// va endi ORDER_STATUS_V2 key'lari bilan ishlaydi (xom string emas).
// "completed" statusi qasddan xaritalanmagan (null qaytadi) — chunki
// hisob-kitob yopilgach stol "free"ga qaytishi closeTable() orqali
// to'g'ridan-to'g'ri boshqariladi, bu yerda avtomatik ishlanmaydi.
const ORDER_V2_TO_TABLE_STATUS = {
  waiter: "occupied",
  order_created: "order_received",
  kitchen_printer: "order_received",
  kitchen_display: "order_received",
  preparing: "preparing",
  ready: "ready",
  picked_up: "ready",
  served: "served",
  cashier: "billing",
  payment: "billing"
};

export function getTableStatusFromOrderStatusV2(rawOrderStatus) {
  const orderKey = normalizeOrderStatusV2(rawOrderStatus);
  return ORDER_V2_TO_TABLE_STATUS[orderKey] || null;
}

export function isPaymentValid(paymentData) {
  if (!paymentData) return false;
  return paymentData.paid === true || paymentData.approved === true;
}

// ==============================
// 🔹 TELEFON NORMALIZATSIYA — YAGONA MANBA (Customers module)
// ==============================
// client.js/waiter.js/admin.js'da bir xil logikaning 3 mustaqil nusxasi bor
// edi (+998901234567 / 998901234567 / 901234567 / 0901234567 — barchasi bitta
// customer bo'lishi kerak). Ular ishlab turgani uchun tegilmaydi — bu yerdagi
// eksport faqat YANGI kod (Customers moduli, reservation/kassa discount hook)
// uchun yagona manba, customers/{phone} Firebase kalitini hosil qiladi.
export function normalizePhone(phone = "") {
  let cleaned = String(phone || "").replace(/\D/g, "");
  if (!cleaned) return "";
  // +9989012345678 kabi ortiqcha raqam kiritilgan holatlar — oxirgi 9 ta
  // raqamni "998" bilan birlashtiramiz (client.js calculateDiscount'dagi bilan bir xil).
  if (cleaned.length > 12 && cleaned.includes("998")) {
    cleaned = "998" + cleaned.slice(cleaned.indexOf("998") + 3).slice(0, 9);
  }
  if (cleaned.length === 12 && cleaned.startsWith("998")) return "+" + cleaned;
  if (cleaned.length === 9) return "+998" + cleaned;
  if (cleaned.length === 10 && cleaned.startsWith("0")) return "+998" + cleaned.slice(1);
  return "+" + cleaned;
}

// ==============================
// 🔹 ORDER TYPE (Dine-in / Takeaway / Delivery) — YAGONA MANBA
// ==============================
// Kanonik order turi. Eski buyurtmalarda bu maydon yo'q — shuning uchun
// normalizeOrderType() hamma joyda (formatOrderNumber, chef/waiter/kassa
// kartalari, courier assignment) eski sinonim maydonlar (isDelivery,
// deliveryType, deliveryAddress) orqali ham to'g'ri turini aniqlaydi.
export const ORDER_TYPE = {
  DINE_IN: "dine_in",
  TAKEAWAY: "takeaway",
  DELIVERY: "delivery"
};

export function normalizeOrderType(order) {
  if (!order || typeof order !== "object") return ORDER_TYPE.DINE_IN;
  if (order.orderType === ORDER_TYPE.DINE_IN || order.orderType === ORDER_TYPE.TAKEAWAY || order.orderType === ORDER_TYPE.DELIVERY) {
    return order.orderType;
  }
  if (order.deliveryType === "delivery" || order.isDelivery === true || order.deliveryAddress) {
    return ORDER_TYPE.DELIVERY;
  }
  if (order.table) return ORDER_TYPE.DINE_IN;
  return ORDER_TYPE.DINE_IN;
}

// ==============================
// 🔹 STOL TURI/BADGE IKONASI — YAGONA MANBA
// ==============================
// Avval admin.js (typeConfig, buildTableCard ichida) va waiter.js
// (TABLE_TYPE_META) da mustaqil, bir-biridan farqli nusxalarda
// takrorlanardi — endi bitta joydan (icon+label) olinadi, shuning uchun
// VIP/Oddiy/Kabina/Terrasa har qanday panelda (Admin/Waiter/Kassa/Chef)
// bir xil ikon bilan ko'rinadi.
export const TABLE_TYPE_CONFIG = {
  oddiy: { icon: "🪑", labelKey: "table_type_oddiy", labelUz: "Oddiy" },
  vip: { icon: "👑", labelKey: "table_type_vip", labelUz: "VIP" },
  kabina: { icon: "🏠", labelKey: "table_type_kabina", labelUz: "Kabina" },
  terrasa: { icon: "🌿", labelKey: "table_type_terrasa", labelUz: "Terrasa" }
};

/**
 * Stol turi (table.tableType) uchun canonical icon+label qaytaradi.
 * @param {string} rawType - table.tableType (bo'sh bo'lsa "oddiy" deb olinadi)
 * @param {(key:string, fallback?:string)=>string} [t] - panelning o'z i18n
 *   funksiyasi (berilmasa labelUz fallback ishlatiladi)
 * @param {Object<string,string>} [customIcons] - Admin custom tur uchun
 *   belgilagan ikon (restaurants/{restId}/settings/customTableTypeIcons,
 *   { <turKichikHarflarda>: "⭐" }) — faqat TABLE_TYPE_CONFIG'da YO'Q,
 *   admin qo'shgan haqiqiy custom turlar uchun ishlatiladi.
 */
export function getTableTypeMeta(rawType, t, customIcons) {
  const tt = typeof t === "function" ? t : (k, f) => (f !== undefined ? f : k);
  const key = String(rawType || "").trim().toLowerCase();
  if (!key || key === "oddiy") {
    return { icon: "🪑", label: tt("table_type_oddiy", "Oddiy"), key: "oddiy" };
  }
  const known = TABLE_TYPE_CONFIG[key];
  if (known) return { icon: known.icon, label: tt(known.labelKey, known.labelUz), key };
  const customIcon = customIcons && customIcons[key];
  return {
    icon: customIcon || "🏷️",
    label: key.charAt(0).toUpperCase() + key.slice(1),
    key
  };
}

export const DELIVERY_STATUS = {
  ASSIGNED: { key: "assigned", labelUz: "Kuryerga tayinlandi", labelKey: "delivery_status_assigned" },
  PICKED_UP: { key: "picked_up", labelUz: "Olib ketildi", labelKey: "delivery_status_picked_up" },
  IN_TRANSIT: { key: "in_transit", labelUz: "Yo'lda", labelKey: "delivery_status_in_transit" },
  DELIVERED: { key: "delivered", labelUz: "Yetkazildi", labelKey: "delivery_status_delivered" }
};

// Yetkazib berish Yandex Go orqali amalga oshiriladi — shuning uchun faqat
// uchta narxlash usuli qo'llab-quvvatlanadi (ichki kuryer uchun bo'lgan
// "hudud bo'yicha"/"bepul" rejimlari va ko'p-hududli tizim olib tashlandi).
export const DELIVERY_PRICING_MODES = {
  FIXED: { key: "fixed", labelUz: "Belgilangan narx", labelKey: "delivery_fixed_price" },
  DISTANCE: { key: "distance", labelUz: "Masofaga qarab", labelKey: "delivery_distance_price" },
  YANDEX_GO: { key: "yandex_go", labelUz: "Yandex Go hisoblaydi", labelKey: "delivery_yandex_price" }
};

// Provider-based delivery architecture (Delivery Engine, backend/delivery/).
// INTERNAL = restaurant's own couriers, YANDEX_GO = external Yandex Go
// provider, AUTOMATIC = internal first, falls back to Yandex Go. Future
// providers (Express24, MyTaxi, Custom) are added in
// backend/delivery/providerRegistry.js without touching this enum's shape.
// MANUAL kept only for backward-compat with restaurants that already saved
// this value — treated the same as INTERNAL by the engine.
export const DELIVERY_PROVIDERS = {
  INTERNAL: "internal",
  YANDEX_GO: "yandex_go",
  AUTOMATIC: "automatic",
  MANUAL: "manual"
};

// Full courier-facing delivery status flow (mirrors backend/delivery/common.js
// DELIVERY_STATUS — kept as the single source of truth on the backend,
// duplicated here only as string keys for UI rendering/labels).
export const DELIVERY_FLOW_STATUS = {
  WAITING_FOR_COURIER: { key: "waiting_for_courier", labelKey: "delivery_status_waiting", labelUz: "Kuryer kutilmoqda" },
  ASSIGNED: { key: "assigned", labelKey: "delivery_status_assigned", labelUz: "Tayinlandi" },
  ACCEPTED: { key: "accepted", labelKey: "delivery_status_accepted", labelUz: "Qabul qilindi" },
  HEADING_TO_RESTAURANT: { key: "heading_to_restaurant", labelKey: "delivery_status_heading_restaurant", labelUz: "Restoranga ketmoqda" },
  ARRIVED: { key: "arrived", labelKey: "delivery_status_arrived", labelUz: "Yetib keldi" },
  PICKED_UP: { key: "picked_up", labelKey: "delivery_status_picked_up", labelUz: "Olib ketildi" },
  IN_TRANSIT: { key: "in_transit", labelKey: "delivery_status_in_transit", labelUz: "Yo'lda" },
  DELIVERED: { key: "delivered", labelKey: "delivery_status_delivered", labelUz: "Yetkazildi" },
  COMPLETED: { key: "completed", labelKey: "delivery_status_completed", labelUz: "Yakunlandi" },
  CANCELLED: { key: "cancelled", labelKey: "delivery_status_cancelled", labelUz: "Bekor qilindi" },
  CUSTOMER_NOT_FOUND: { key: "customer_not_found", labelKey: "delivery_status_customer_not_found", labelUz: "Mijoz topilmadi" },
  RETURNED: { key: "returned", labelKey: "delivery_status_returned", labelUz: "Qaytarildi" }
};

export function getDeliveryFlowStatusLabel(rawStatus) {
  const info = Object.values(DELIVERY_FLOW_STATUS).find(s => s.key === rawStatus);
  if (!info) return rawStatus;
  return typeof t === "function" ? t(info.labelKey, info.labelUz) : info.labelUz;
}

// Ikki geografik nuqta orasidagi masofa (km), Haversine formulasi.
// client.js checkout (masofaga qarab narxlash) va yetkazib berish hududi
// (restorandan radius) tekshiruvi uchun ishlatiladi.
export function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => typeof v !== "number" || Number.isNaN(v))) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// deliveryAddress obyektini (1.2 formatidagi) inson o'qiy oladigan
// bitta qatorli manzilga aylantiradi — courier.js, kassa.js va admin.js
// kuryerga tayinlash blokida bir xil ko'rinishda ishlatiladi.
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

// Yetkazib berish narxini hisoblaydi — client.js (checkout preview) va
// backend/server.js (agar REST orqali buyurtma yaratilsa) uchun yagona
// manba, ikkalasi bir xil natija berishi kerak.
export function computeDeliveryFee({ pricingMode, baseFee = 0, perKmFee = 0, distanceKm = 0, orderTotal = 0, freeDeliveryThreshold = 0 } = {}) {
  if (freeDeliveryThreshold > 0 && orderTotal >= freeDeliveryThreshold) return 0;

  let fee = 0;
  switch (pricingMode) {
    case DELIVERY_PRICING_MODES.YANDEX_GO.key:
      // TODO: Yandex Go haqiqiy narx taklifini (quote) API orqali qaytarishi
      // kerak — hozircha real integratsiya yo'q, shuning uchun 0 qaytariladi.
      fee = 0;
      break;
    case DELIVERY_PRICING_MODES.DISTANCE.key:
      fee = (Number(baseFee) || 0) + (Number(perKmFee) || 0) * (Number(distanceKm) || 0);
      break;
    case DELIVERY_PRICING_MODES.FIXED.key:
    default:
      fee = Number(baseFee) || 0;
      break;
  }

  return Math.max(0, Math.round(fee));
}

export const NESTA_PLANS = {
  START: ["qr_menu", "client_order", "basic_admin"],
  PROFESSIONAL: ["qr_menu", "client_order", "basic_admin", "waiter_panel", "chef_panel", "live_tables"],
  BUSINESS: ["qr_menu", "client_order", "basic_admin", "waiter_panel", "chef_panel", "live_tables", "inventory", "finance"]
};

export function checkAccess(currentPlan, feature) {
  const plan = currentPlan || "START";
  return NESTA_PLANS[plan] ? NESTA_PLANS[plan].includes(feature) : false;
}

// ==============================
// 🔥  SHARED API
// ==============================
export const FoodifyShared = {
  async addMenu(data) {
    const newRef = push(ref(window.db, "menu"));
    await set(newRef, data);
  },

  async updateMenu(id, data) {
    await update(ref(window.db, "menu/" + id), data);
  },

  async deleteMenu(id) {
    await remove(ref(window.db, "menu/" + id));
  },

  subscribeMenu(callback) {
    onValue(ref(window.db, "menu"), snap => {
      const data = snap.val() || {};
      const menuArray = Object.entries(data).map(([id, item]) => ({ id, ...item }));
      callback(menuArray);
    });
  },

  subscribeOrders(callback) {
    onValue(ref(window.db, "orders"), snap => {
      const data = snap.val() || {};
      const ordersArray = Object.entries(data).map(([id, item]) => ({ id, ...item }));
      callback(ordersArray);
    });
  },

  async getMenu() {
    const snap = await get(ref(window.db, "menu"));
    return snap.val() || {};
  }
};

// ==============================
// 🔹 CATEGORY DATA
// ==============================
export const CATEGORY_DATA = {
  categories: [
    { id: "main", nameKey: "cat_main", sub: ["sub_meat", "sub_chicken", "sub_fish", "sub_national"] },
    { id: "snacks", nameKey: "cat_snacks", sub: ["sub_salads", "sub_small_snacks", "sub_cold_snacks", "sub_hot_snacks"] },
    { id: "soups", nameKey: "cat_soups", sub: ["sub_national_soups", "sub_broths", "sub_cream_soups"] },
    { id: "fastfood", nameKey: "cat_fastfood", sub: ["sub_burgers", "sub_hotdog", "sub_sandwich", "sub_shawarma"] },
    { id: "garnish", nameKey: "cat_garnish", sub: ["sub_potato", "sub_veggie_garnish", "sub_rice_pasta"] },
    { id: "drinks", nameKey: "cat_drinks", sub: ["sub_hot_drinks", "sub_cold_drinks", "sub_soda", "sub_juices"] },
    { id: "dessert", nameKey: "cat_dessert", sub: ["sub_cakes", "sub_pastry", "sub_icecream", "sub_sweets"] },
    { id: "bread", nameKey: "cat_bread", sub: ["sub_bread", "sub_lavash", "sub_round_bread", "sub_baguette"] },
    { id: "special", nameKey: "cat_special", sub: ["sub_kids", "sub_diet", "sub_vegan", "sub_sport"] },
    { id: "combo", nameKey: "category_combo", sub: ["fast_food", "family_combo", "lunch"] }, // 🔴 KOMBO QO'SHILDI
  ]
};