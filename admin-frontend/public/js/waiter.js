// ══════════════════════════════════════════════════════════════
// Nesta ERP — OFITSIANT PANELI
// Faqat 4 bo'lim:
//   1. Stol tanlash (zallar filteri bilan)
//   2. Buyurtma oynasi (menyu + savat)
//   3. Stol holati
//   4. Buyurtma tarixi (faqat shu stolniki)
//
// ⚠️ shared.js O'ZGARTIRILMAYDI. Bazada asl V2 statuslari saqlanadi,
//    UI esa ularni WAITER_STATUS_MAP orqali soddalashtirib ko'rsatadi.
// ══════════════════════════════════════════════════════════════

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getDatabase, forceWebSockets, ref, onValue, update, push, get, runTransaction
} from "./pgRtdb.js";
// 🔒 P0 AUTH FIX — waiter.js never imported firebase-auth.js at all, so it
// never had a Firebase Auth session even though login.js already signed one
// in (signInWithCustomToken) before redirecting here. Firebase's Auth SDK
// only restores a persisted session (IndexedDB, same-origin) on a page that
// actually calls getAuth() — no call here meant the Auth "component" was
// never registered for this page's app instance, so every restaurants/
// {restId}/... read/write this file makes went out with no token at all.
// database.rules.json's restaurants/$restId top-level rule requires
// `auth != null` — confirmed live against production (unauthenticated
// request to restaurants/{restId}/users/{id} → 401; identical request with
// a real waiter-claim ID token → 200). This was never a loadStaffName()-only
// bug — every listener in this file (tables/orders/menu/...) was equally
// affected. getAuth(app) below is the fix: it triggers automatic session
// restoration from whatever real Firebase Auth session is already persisted
// for this origin (the waiter's own from login.js, or an admin's own
// session when using the "viewAs" shortcut — either way a real, rules-
// satisfying auth.token.restId, never a fabricated one).
import { getAuth, signOut, signInWithCustomToken, setPersistence, inMemoryPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { t, getLang, setLang, applyLang, onLangChange } from "./i18n.js";
// i18n.js o'zi ham aynan shu faylni import qiladi (yagona tarjima lug'ati) —
// bu yerda faqat CATEGORY_DATA'ning statik (Firebase'da saqlanmaydigan)
// kategoriya/subkategoriya nomlarini HAR BIR til uchun oldindan tayyorlab
// qo'yish uchun kerak (pastda buildCategoriesCache()) — yangi/parallel
// tarjima tizimi EMAS, xuddi shu mavjud lug'atning o'zi.
import { langData } from "./langs.js";
import { CATEGORY_DATA, ORDER_STATUS_V2, writeOrderAuditLog, normalizeTableStatusV2, normalizeOrderType, ORDER_TYPE, normalizePhone, getTableTypeMeta } from "./shared.js";
import { getEnabledPaymentMethods, paymentMethodLabel, createPaymentModal } from "./paymentEngine.js";
import { printReceiptInto, printReceiptInPopup, downloadReceiptHtmlFile } from "./receiptEngine.js";
import { discountClaimsClient } from "./discountClaimsClient.js";
import { mountStaffFooter, updateStaffFooter } from "./staffFooter.js";

// Force WebSocket-only transport (never fall back to `.lp` long-polling) —
// first executable statement in this module.
forceWebSockets();

// 🆕 YAGONA STAFF FOOTER — waiter panelida bottom-nav yo'q, shuning uchun
// viewport pastiga yopishgan (fixed) rejimda ishlatiladi (chef screenshot —
// canonical reference). Haqiqiy ma'lumot kelgunicha yashirin turadi.
const _staffFooterEl = mountStaffFooter({ fixed: true });

// ─── Buyurtma raqamini formatlash: ORD-1 (restoran ichi) yoki DVR-1 (yetkazib berish) ───
// admin.js dagi bilan bir xil mantiq — barcha panellarda buyurtma raqami bir xil ko'rinsin.
function formatOrderNumber(orderOrNumber, isDeliveryFlag) {
  let num, isDelivery;
  if (orderOrNumber && typeof orderOrNumber === "object") {
    num = orderOrNumber.orderNumber;
    isDelivery = !!(
      orderOrNumber.deliveryType === "delivery" || orderOrNumber.isDelivery ||
      orderOrNumber.orderType === "delivery" || orderOrNumber.deliveryAddress
    );
  } else {
    num = orderOrNumber;
    isDelivery = !!isDeliveryFlag;
  }
  if (num === undefined || num === null || num === "") return null;
  const prefix = isDelivery ? "DVR" : "ORD";
  return `${prefix}-${String(num)}`;
}
window.formatOrderNumber = formatOrderNumber;

// ══════════════════════════════════════════
// 1. XAVFSIZLIK VA BOSHLANG'ICH SOZLAMALAR
// ══════════════════════════════════════════
const urlParams     = new URLSearchParams(window.location.search);
const viewAsId      = urlParams.get("viewAs");
const restIdFromUrl = urlParams.get("rest") || urlParams.get("id");

let currentRestaurantId = restIdFromUrl || localStorage.getItem("restaurantId");
// MUHIM: userId/role sessionStorage'dan o'qiladi (localStorage'dan EMAS) —
// bir tabda admin, boshqa tabda ofitsiant bilan login qilinganda ikkalasi
// bir-birining sessiyasini bosib o'tmasligi uchun. "viewAs" havolasi ham
// har doim window.open(..., '_blank') orqali yangi tabda ochiladi.
let currentUserId       = sessionStorage.getItem("userId");

if (viewAsId && restIdFromUrl) {
  currentRestaurantId = restIdFromUrl;
  currentUserId       = viewAsId;
  localStorage.setItem("restaurantId", restIdFromUrl);
  sessionStorage.setItem("userId", viewAsId);
  sessionStorage.setItem("role", "waiter");
  sessionStorage.setItem("isViewingAsAdmin", "true");
  window.currentWaiterId = viewAsId;
} else {
  const role = sessionStorage.getItem("role");
  if (!currentRestaurantId || !currentUserId || role !== "waiter") {
    window.location.replace("login.html");
  } else {
    window.currentWaiterId = currentUserId;
  }
}

const BASE_PATH = `restaurants/${currentRestaurantId}`;

const firebaseConfig = {
  apiKey: "AIzaSyCGCCIP3eFg40bOEENDLGcrw9c484ySCHQ",
  authDomain: "restoran-30d51.firebaseapp.com",
  databaseURL: "https://restoran-30d51-default-rtdb.firebaseio.com",
  projectId: "restoran-30d51",
  storageBucket: "restoran-30d51.firebasestorage.app",
  messagingSenderId: "862261129762",
  appId: "1:862261129762:web:5577e6821b4ad7ea4e507b"
};
const app  = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

// 🩹 P0 root-cause fix (this pass, same as chef.js/courier.js): viewAs used
// to carry ONLY the cosmetic URL params set above (userId/role in
// sessionStorage) — no real Firebase Auth session — silently relying on
// the calling admin's own session leaking into this tab via shared browser
// storage. That stopped working the moment login.js was scoped to
// tab-local persistence (a separate, deliberate fix — see that file's own
// header comment). admin.js's "Sahifaga o'tish" now mints a real session
// via backend routes/auth.js's new /staff-view-as and passes it here as a
// one-time ssoToken — same pattern admin.js's own "Login As" already uses
// for itself. Must live here (after `auth` exists), not up in the viewAs
// block above — this file declares app/db/auth AFTER that block, not
// before (unlike chef.js/courier.js). Top-level await is legal (this file
// is an ES module) and deliberately blocks the rest of this module's boot
// (listenTables/listenOrders/etc., all registered later) until the real
// session is signed in.
if (viewAsId && restIdFromUrl) {
  const ssoToken = urlParams.get("ssoToken");
  if (ssoToken) {
    try {
      await setPersistence(auth, inMemoryPersistence);
      await signInWithCustomToken(auth, ssoToken);
    } catch (ssoErr) {
      console.warn("[WAITER-AUTH] ssoToken sign-in failed:", ssoErr?.code || ssoErr?.message);
    }
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("ssoToken");
    history.replaceState(null, "", cleanUrl.toString());
  }
}

const waiterId = window.currentWaiterId;

// ══════════════════════════════════════════
// 2. GLOBAL HOLAT (STATE)
// ══════════════════════════════════════════
let tablesCache       = {};   // { table_5: {...} }
let ordersCache       = {};   // { orderId: {...} }
let menuCache         = {};   // { menuId: {...} }
let categoriesCache   = [];   // [{id, name}]
let reservationsCache = {};   // { resId: {...} }

let activeHall        = "all";
let activeTableKey    = null;  // "table_5"
let activeTableNumber = null;  // "5"
let activeOrderId     = null;  // mavjud ochiq buyurtma
let cart              = {};    // { cartKey: {menuId, qty, price, note, sent} }

// 🆕 Buyurtma o'zgartirish so'rovlari (Bekor qilish/Almashtirish) — BITTA
// global listener (allOrderChangeRequests, pastda listenOrderChangeRequestsGlobal())
// orqali kuzatiladi, faol buyurtmaga tegishlilari renderCart() vaqtida
// CLIENT tomonda filtrlanadi. Admin/Kassir tasdiqlamaguncha bu yerdagi
// ma'lumot ORDER'ning o'ziga hech qanday ta'sir qilmaydi — faqat "⏳
// kutilmoqda" belgisini ko'rsatish va duplikat so'rov yuborishning oldini
// olish uchun.
let activeCategory    = "all";
let activeSubCategory = "all";
let menuSearchQuery   = "";
let payMethod         = "cash";

// Restoran sozlamalari (faqat ko'rsatish uchun: xizmat haqi %)
let restaurantSettings   = {};
let waiterServiceFeePct    = 0;
let waiterServiceFeeMinOrd = 0;
let waiterMinOrderAmount   = 0;   // 🆕 Minimal buyurtma summasi (settings.minOrderAmount)
let waiterAutoDiscount     = { enabled: false, minAmount: 0, pct: 0 }; // 🆕 Avtomatik chegirma (settings.autoDiscount)
let waiterOwnServiceFeePct = null; // shu ofitsiantga admin tomonidan belgilangan shaxsiy %

// Chek dizayni — admin panelidagi "Chop etish sozlamalari" (Sozlamalar → Terminal
// va Chop etish → Chek) orqali belgilanadi: logotip, QR, shtrix-kod, pastki matn.
let printSettingsCache = {};

// ══════════════════════════════════════════
// 3. STOL HOLATI — UI MAPPING QATLAMI
// Bazada asl status saqlanadi, ofitsiant sodda yorliq ko'radi
// ══════════════════════════════════════════
const WAITER_STATUS_MAP = {
  free:           { ui: "free",      emoji: "🟢", color: "var(--st-free)",     bg: "#dcfce7", labelKey: "tstat_free",      labelUz: "Bo'sh" },
  occupied:       { ui: "busy",      emoji: "🟠", color: "var(--st-busy)",     bg: "#ffedd5", labelKey: "tstat_busy",      labelUz: "Band" },
  order_received: { ui: "busy",      emoji: "🟠", color: "var(--st-busy)",     bg: "#ffedd5", labelKey: "tstat_busy",      labelUz: "Band" },
  preparing:      { ui: "preparing", emoji: "🟡", color: "var(--st-preparing)",bg: "#fef9c3", labelKey: "tstat_preparing", labelUz: "Tayyorlanmoqda" },
  ready:          { ui: "ready",     emoji: "🔵", color: "var(--st-ready)",    bg: "#dbeafe", labelKey: "tstat_ready",     labelUz: "Tayyor" },
  served:         { ui: "ready",     emoji: "🔵", color: "var(--st-ready)",    bg: "#dbeafe", labelKey: "tstat_ready",     labelUz: "Tayyor" },
  billing:        { ui: "paid",      emoji: "🔴", color: "var(--st-paid)",     bg: "#fee2e2", labelKey: "tstat_paid",      labelUz: "To'landi" },
  paid:           { ui: "paid",      emoji: "🔴", color: "var(--st-paid)",     bg: "#fee2e2", labelKey: "tstat_paid",      labelUz: "To'landi" },
  cleaning:       { ui: "closed",    emoji: "⚪", color: "var(--st-closed)",   bg: "#f1f5f9", labelKey: "tstat_closed",    labelUz: "Yopildi" },
  reservation:    { ui: "reserved",  emoji: "🟣", color: "var(--st-reserved)", bg: "#f3e8ff", labelKey: "tstat_reserved",  labelUz: "Bron" }
};

const FALLBACK_STATUS = WAITER_STATUS_MAP.occupied;

/**
 * Bazadagi statusni ofitsiant ko'radigan holatga aylantiradi.
 * Bron alohida tekshiriladi — u tables/{id}/status da emas,
 * reservations tugunida saqlanadi.
 */
function getWaiterStatus(tableKey, table) {
  const tableNumber = getTableNumber(tableKey, table);

  // Bron — bo'sh stolda bugungi aktiv bron bo'lsa
  const v2raw = normalizeTableStatusV2(table?.status || "");
  if (v2raw === "free" && hasActiveReservation(tableNumber)) {
    return { ...WAITER_STATUS_MAP.reservation, raw: "reservation" };
  }

  const mapped = WAITER_STATUS_MAP[v2raw] || FALLBACK_STATUS;
  return { ...mapped, raw: v2raw };
}

/** Ofitsiant qo'lda o'zgartira oladigan holatlar (bazaga qaysi V2 yoziladi) */
const MANUAL_STATUS_ACTIONS = [
  { ui: "free",      writes: "free",     emoji: "🟢", labelKey: "tstat_free",      labelUz: "Bo'sh",           color: "#22c55e" },
  { ui: "busy",      writes: "occupied", emoji: "🟠", labelKey: "tstat_busy",      labelUz: "Band",            color: "#f97316" },
  { ui: "preparing", writes: "preparing",emoji: "🟡", labelKey: "tstat_preparing", labelUz: "Tayyorlanmoqda",  color: "#eab308" },
  { ui: "ready",     writes: "ready",    emoji: "🔵", labelKey: "tstat_ready",     labelUz: "Tayyor",          color: "#3b82f6" },
  { ui: "paid",      writes: "paid",     emoji: "🔴", labelKey: "tstat_paid",      labelUz: "To'landi",        color: "#ef4444" },
  { ui: "closed",    writes: "cleaning", emoji: "⚪", labelKey: "tstat_closed",    labelUz: "Yopildi",         color: "#94a3b8" }
];

// ══════════════════════════════════════════
// 4. YORDAMCHI FUNKSIYALAR
// ══════════════════════════════════════════
function getTableKey(numOrKey) {
  const raw = String(numOrKey ?? "").trim();
  if (!raw) return raw;
  return raw.startsWith("table_") ? raw : `table_${raw}`;
}
window.getTableKey = getTableKey;

function getTableNumber(tableKey, table) {
  return String(table?.number ?? String(tableKey).replace(/\D/g, ""));
}

function escapeHtml(v = "") {
  return String(v).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function waiterLocale() {
  const lang = (typeof getLang === "function" ? getLang() : null) || "uz";
  if (lang === "ru") return "ru-RU";
  if (lang === "en") return "en-GB";
  return "uz-UZ";
}

function money(n) {
  return Number(n || 0).toLocaleString(waiterLocale());
}
// 🩹 ROOT-CAUSE FIX (o'zbek tilida "2026 M08 18" kabi noto'g'ri sana,
// ingliz/rus tillari orasida beqaror almashinish) — avval Intl.
// toLocaleDateString(waiterLocale(), {month:'long'}) ishlatilardi;
// "uz-UZ" locale'i uchun ko'p brauzer/OS'da to'liq o'zbekcha oy nomlari
// ICU ma'lumotida yo'q, shuning uchun tarjima qilinmagan generik
// fallback ("M08") chiqardi. Endi oy nomi Intl'dan EMAS, loyihaning o'z
// t()/langs.js kalitlaridan olinadi — brauzer/OS ICU ma'lumotiga
// bog'liq emas, har doim to'g'ri va barqaror ishlaydi.
const WAITER_CLOCK_MONTH_KEYS = ["month_jan","month_feb","month_mar","month_apr","month_may","month_jun",
                                  "month_jul","month_aug","month_sep","month_oct","month_nov","month_dec"];
function _waiterClockPad2(n) { return String(n).padStart(2, "0"); }

(function initWaiterHeaderDateTime() {
  const el = document.getElementById("waiterHeaderDateTime");
  if (!el) return;
  function tick() {
    const now = new Date();
    const lang = (typeof getLang === "function" ? getLang() : null) || "uz";
    const monthName = t(WAITER_CLOCK_MONTH_KEYS[now.getMonth()]);
    const yearSuffix = lang === "ru" ? " г." : "";
    const datePart = `${now.getDate()} ${monthName} ${now.getFullYear()}${yearSuffix}`;
    const timePart = `${_waiterClockPad2(now.getHours())}:${_waiterClockPad2(now.getMinutes())}:${_waiterClockPad2(now.getSeconds())}`;
    el.textContent = `${datePart} · ${timePart}`;
  }
  tick();
  setInterval(tick, 1000);
  // 🩹 ROOT-CAUSE FIX ("2 marta tarjima bo'lish" — til almashtirilganda
  // eski tildagi matn ~1 soniya davomida ko'rinib turardi, chunki
  // setInterval faqat har soniyada bir marta qayta hisoblardi). Endi til
  // almashishi bilan DARHOL qayta chiziladi — 1 soniyalik kutish yo'q.
  if (typeof onLangChange === "function") onLangChange(tick);
})();

function localName(nameField, fallback = "—") {
  const lang = (typeof getLang === "function" ? getLang() : null) || "uz";
  if (!nameField) return fallback;
  if (typeof nameField === "object") return nameField[lang] || nameField.uz || fallback;
  return String(nameField);
}

/** Kategoriya ID bo'yicha lokalizatsiya qilingan nomni qaytaradi (savat qatorida ko'rsatish uchun) */
function categoryName(catId) {
  if (!catId) return "";
  const c = (categoriesCache || []).find(x => x.id === catId);
  return c ? localName(c.name, catId) : "";
}

function timeShort(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString(waiterLocale(), { hour: "2-digit", minute: "2-digit" });
}

function showToast(message, type = "info") {
  const box = document.getElementById("toastContainer");
  if (!box) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
window.showToast = showToast;

/** Bugungi aktiv bron bormi */
function hasActiveReservation(tableNumber) {
  const today = new Date().toISOString().slice(0, 10);
  return Object.values(reservationsCache || {}).some(r =>
    // 🩹 Audit fix: reservation yozuvlari har doim `tableNumber` maydonini
    // ishlatadi (admin.js createReservation, client.js submitReservation) —
    // `table` degan maydon hech qachon yozilmagan, shuning uchun bu funksiya
    // doim false qaytarardi ("🟣 Bron" belgisi hech qachon chiqmasdi).
    String(r.tableNumber) === String(tableNumber) &&
    String(r.date || "").slice(0, 10) === today &&
    !["cancelled", "canceled", "completed", "done", "no_show"].includes(String(r.status || "").toLowerCase())
  );
}

/** Stolning ochiq buyurtmasini topadi */
function findOpenOrderForTable(tableNumber) {
  const closed = ["completed", "cancelled", "closed", "to'landi", "paid"];
  const list = Object.entries(ordersCache || {})
    .filter(([, o]) =>
      String(o.table) === String(tableNumber) &&
      !closed.includes(String(o.status || "").toLowerCase()) &&
      o?.payment?.paid !== true)
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
  return list[0] ? { id: list[0][0], ...list[0][1] } : null;
}

// ══════════════════════════════════════════
// 5. FIREBASE TINGLAGICHLARI
// ══════════════════════════════════════════
function listenTables() {
  onValue(ref(db, `${BASE_PATH}/tables`), snap => {
    tablesCache = snap.val() || {};
    renderTypeFilter();
    renderTablesGrid();
    if (activeTableKey) refreshOrderScreenHeader();
  });
}

function listenOrders() {
  onValue(ref(db, `${BASE_PATH}/orders`), snap => {
    const allOrders = snap.val() || {};
    // 🚚 Ofitsiant standart holatda Delivery buyurtmalarini ko'rmaydi
    // (RBAC "delivery" modul ruxsati bo'lmasa) — waiter.js RBAC helperlarini
    // yuklamaydi, shuning uchun bu yerda oddiy va xavfsiz standart: doim yashirish.
    ordersCache = Object.fromEntries(
      Object.entries(allOrders).filter(([, o]) => normalizeOrderType(o) !== ORDER_TYPE.DELIVERY)
    );
    renderTablesGrid();
    if (activeTableKey) {
      syncActiveOrder();
      renderOrderHistory();
    }
  });
}

/** cat_main/sub_meat kabi statik tarjima kalitini UZ/RU/EN uchundagi
 *  UCHALASINI ham langData'dan (mavjud, yagona lug'at — i18n.js o'zi ham
 *  aynan shu faylni ishlatadi) to'g'ridan-to'g'ri o'qib, localName() allaqachon
 *  qo'llab-quvvatlaydigan {uz,ru,en} ko'rinishida qaytaradi — custom
 *  (Firebase'dan keladigan) kategoriyalar bilan bir xil format.
 *  🐛 ROOT CAUSE FIX — "kategoriya/subkategoriya faqat refreshdan keyin
 *  tarjima bo'ladi": bu yerda ilgari `t(cat.nameKey)` faqat BIR MARTA —
 *  categories Firebase listeneri ishga tushganda — chaqirilib, natija
 *  (allaqachon tarjima qilingan, oddiy STRING) categoriesCache'ga abadiy
 *  yozib qo'yilardi. localName() keyin bu qiymatni obyekt emas, oddiy
 *  string deb topib, tilni tekshirmasdan aynan o'sha (eski) tilni
 *  qaytarardi — til almashtirilganda yoki keshdan foydalanganda hech
 *  qachon yangilanmasdi. Endi bu yerda tarjima natijasi emas, UCHALA til
 *  ham saqlanadi — localName() esa (o'zgarmagan holda) har safar RENDER
 *  vaqtida joriy tilni tekshiradi, shuning uchun keshni qayta qurishga
 *  hojat qolmay, til almashtirish darhol aks etadi. */
function staticKeyToLangObj(key) {
  return {
    uz: langData.uz?.[key] || key,
    ru: langData.ru?.[key] || key,
    en: langData.en?.[key] || key
  };
}

/** admin.js'dagi getAllCategories() bilan bir xil naqsh — statik (CATEGORY_DATA,
 *  Firebase'da saqlanmaydigan, faqat kodda hardcoded) kategoriyalarni Firebase'dagi
 *  custom kategoriyalar bilan birlashtiradi. Bu bo'lmasa, ofitsiant panelida faqat
 *  qo'lda qo'shilgan custom kategoriyalar ko'rinib, admin panelining menyu
 *  jadvalida ko'rinadigan standart kategoriyalar (Gazaklar, Asosiy taomlar va h.k.)
 *  butunlay yashirin qolar edi. */
function buildCategoriesCache(customCategoriesData) {
  const staticCats = (CATEGORY_DATA?.categories || []).map(cat => ({
    id: cat.id,
    name: staticKeyToLangObj(cat.nameKey),
    sub: (cat.sub || []).map(subKey => ({ id: subKey, name: staticKeyToLangObj(subKey) }))
  }));

  const customObj = customCategoriesData || {};
  const customCats = Object.entries(customObj).map(([id, c]) => ({ id, ...c }));

  return [...staticCats, ...customCats];
}

function listenMenu() {
  onValue(ref(db, `${BASE_PATH}/menu`), snap => {
    menuCache = snap.val() || {};
    if (activeTableKey) { renderCategories(); renderSubCategories(); renderMenuItems(); }
  });
  onValue(ref(db, `${BASE_PATH}/categories`), snap => {
    categoriesCache = buildCategoriesCache(snap.val());
    if (activeTableKey) { renderCategories(); renderSubCategories(); }
  });
}

function listenReservations() {
  onValue(ref(db, `${BASE_PATH}/reservations`), snap => {
    reservationsCache = snap.val() || {};
    renderTablesGrid();
  });
}

/** Xizmat haqi % kabi sozlamalar — kassa/admin panelida belgilanadi, bu yerda faqat o'qiladi */
function listenRestaurantSettings() {
  onValue(ref(db, `${BASE_PATH}/settings`), snap => {
    restaurantSettings   = snap.val() || {};
    waiterServiceFeeMinOrd = Number(restaurantSettings.serviceFeeMinOrder || 0);
    // Agar shu ofitsiantga alohida % belgilanmagan bo'lsa, restoran umumiy % ishlatiladi
    if (waiterOwnServiceFeePct === null) {
      waiterServiceFeePct = Number(restaurantSettings.serviceFee || 0);
    }
    // 🆕 Minimal buyurtma summasi
    waiterMinOrderAmount = Number(restaurantSettings.minOrderAmount || 0);
    // 🆕 Avtomatik skidka (summa oshsa, avtomatik chegirma qo'llanadi)
    waiterAutoDiscount = {
      enabled:   !!restaurantSettings.autoDiscount?.enabled,
      minAmount: Number(restaurantSettings.autoDiscount?.minAmount || 0),
      pct:       Number(restaurantSettings.autoDiscount?.pct || 0)
    };
    if (activeTableKey) renderCart();
    // 🆕 Footer (ish vaqti/telefon) — Admin Sozlamalar o'zgartirsa,
    // shu mavjud listener orqali refreshsiz yangilanadi.
    updateStaffFooter(_staffFooterEl, restaurantSettings, t);
    // 🩹 Header markazidagi restoran nomi (#waiterHeaderRestName) — avval
    // bu element HTML'da bor edi, lekin hech qanday JS uni to'ldirmasdi
    // (doim bo'sh ko'rinardi). client.js/kassa.js/chef.js/courier.js'dagi
    // bilan bir xil manba — shu mavjud settings listeneriga bitta qator
    // qo'shildi, yangi Firebase o'qish yo'q.
    const restNameEl = document.getElementById("waiterHeaderRestName");
    if (restNameEl) restNameEl.textContent = restaurantSettings.restaurantName || "Nesta ERP";
  });

  // Chek dizayni — Sozlamalar → Terminal va Chop etish → Chek (admin.js: savePrintSettings)
  onValue(ref(db, `${BASE_PATH}/printSettings`), snap => {
    printSettingsCache = snap.val() || {};
  });

  if (currentUserId) {
    onValue(ref(db, `${BASE_PATH}/users/${currentUserId}`), snap => {
      const u = snap.val() || {};
      let val = null;
      if (u.serviceFeePercent !== undefined && u.serviceFeePercent !== null && u.serviceFeePercent !== "") {
        const n = Number(u.serviceFeePercent);
        if (!Number.isNaN(n)) val = n;
      }
      if (val === null && u.serviceBonus) {
        const n = Number(String(u.serviceBonus).replace("%", "").trim());
        if (!Number.isNaN(n)) val = n;
      }
      waiterOwnServiceFeePct = val;
      waiterServiceFeePct = waiterOwnServiceFeePct !== null
        ? waiterOwnServiceFeePct
        : Number(restaurantSettings.serviceFee || 0);
      if (activeTableKey) renderCart();
    });
  }
}

// ══════════════════════════════════════════
// 6. VIEW 1 — ZALLAR FILTERI
// ══════════════════════════════════════════
// 🩹 BADGE IKON YAGONA MANBA — avval bu yerda mustaqil TABLE_TYPE_META
// (admin.js'dagi typeConfig'dan farqli — masalan "kabina" yo'q edi) bor
// edi. Endi shared.js'dagi getTableTypeMeta() (canonical, Admin/Waiter/
// Kassa bir xil) ishlatiladi — restaurantSettings.customTableTypeIcons
// orqali admin qo'shgan custom badge ikonlari ham tan olinadi.
/** Tur uchun emoji + nom (admin qo'shgan custom turlar ham ishlaydi) */
function typeMeta(rawType) {
  const meta = getTableTypeMeta(rawType, t, restaurantSettings?.customTableTypeIcons);
  return { emoji: meta.icon, label: meta.label, key: meta.key };
}

/** Stollardan barcha turlarni yig'adi: Map { tur => soni } */
function getTableTypes() {
  const types = new Map();
  Object.values(tablesCache || {}).forEach(tb => {
    if (tb?.active === false) return;
    const key = String(tb?.tableType || "oddiy").trim().toLowerCase() || "oddiy";
    types.set(key, (types.get(key) || 0) + 1);
  });
  return types;
}

function renderTypeFilter() {
  const box = document.getElementById("hallFilter");
  if (!box) return;

  const types = getTableTypes();
  const total = [...types.values()].reduce((a, b) => a + b, 0);

  let html = `
    <button class="hall-btn ${activeHall === "all" ? "active" : ""}"
            onclick="window.setHall('all')">
      ${t("all_tables", "Barcha stollar")}
      <span class="hall-count">${total}</span>
    </button>`;

  const order = ["oddiy", "vip", "terrasa"];
  [...types.entries()]
    .sort((a, b) => {
      const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a[0].localeCompare(b[0]);
    })
    .forEach(([type, count]) => {
      const meta = typeMeta(type);
      const safe = escapeHtml(type).replace(/'/g, "\\'");
      html += `
        <button class="hall-btn ${activeHall === type ? "active" : ""}"
                onclick="window.setHall('${safe}')">
          ${meta.emoji} ${escapeHtml(meta.label)}
          <span class="hall-count">${count}</span>
        </button>`;
    });

  box.innerHTML = html;
}

window.setHall = function (type) {
  activeHall = type;
  renderTypeFilter();
  renderTablesGrid();
};

// ══════════════════════════════════════════
// 7. VIEW 1 — STOL KARTALARI
// ══════════════════════════════════════════
function renderTablesGrid() {
  const box = document.getElementById("tablesGrid");
  if (!box) return;

  let entries = Object.entries(tablesCache || {});

  // 🆕 [TABLE-DIAG] — "Stol raqami yo'qolib qolyapti" muammosini
  // aniqlash uchun: har bir bosqichda (xom → active filtri → tur filtri)
  // qaysi stol raqamlari qolayotganini/tushib qolayotganini localhost'da
  // ko'rsatadi. Ishlab chiqarishda (production) hech narsa chiqmaydi.
  if (_IS_LOCAL_DEBUG) {
    const rawNums = entries.map(([k, tb]) => ({ key: k, num: getTableNumber(k, tb), active: tb?.active, status: tb?.status, type: tb?.tableType }));
    console.info("[TABLE-DIAG] xom tables (Firebase'dan, hech qanday filtr yo'q):", rawNums);
  }

  // Faol emas stollar ofitsiantga ko'rsatilmaydi
  const beforeActiveFilter = entries.length;
  entries = entries.filter(([, tb]) => tb?.active !== false);
  if (_IS_LOCAL_DEBUG && entries.length !== beforeActiveFilter) {
    const excluded = Object.entries(tablesCache || {}).filter(([, tb]) => tb?.active === false)
      .map(([k, tb]) => ({ key: k, num: getTableNumber(k, tb), active: tb?.active }));
    console.info(`[TABLE-DIAG] active:false sabab ${beforeActiveFilter - entries.length} ta stol yashirildi:`, excluded);
  }

  if (activeHall !== "all") {
    entries = entries.filter(([, tb]) => {
      const tp = String(tb?.tableType || "oddiy").trim().toLowerCase() || "oddiy";
      return tp === activeHall;
    });
  }

  entries.sort((a, b) => {
    const na = parseInt(getTableNumber(a[0], a[1]), 10) || 0;
    const nb = parseInt(getTableNumber(b[0], b[1]), 10) || 0;
    return na - nb;
  });

  if (_IS_LOCAL_DEBUG) {
    console.info("[TABLE-DIAG] renderTablesGrid() YAKUNIY ro'yxat (activeHall=" + activeHall + "):",
      entries.map(([k, tb]) => getTableNumber(k, tb)));
  }

  if (entries.length === 0) {
    box.innerHTML = `<p class="empty-state" style="grid-column:1/-1;">${t("no_tables_found", "Stollar topilmadi")}</p>`;
    return;
  }

  box.innerHTML = entries.map(([tableKey, tb]) => {
    const num    = getTableNumber(tableKey, tb);
    const st     = getWaiterStatus(tableKey, tb);
    const order  = findOpenOrderForTable(num);
    const label  = t(st.labelKey, st.labelUz);
    const seats  = tb?.seats || tb?.capacity;
    const billReq = order?.payment?.requested === true;
    // Root cause fix: "meta" (canonical getTableTypeMeta() orqali) allaqachon
    // hisoblangan edi, lekin pastdagi kartochka markup 🪑 ni hardcoded
    // qoldirgan edi (meta hech qachon ishlatilmasdi) — VIP/boshqa turdagi
    // stollarda ham har doim oddiy stol ikoni ko'rinishiga sabab bo'lgan.
    const meta   = typeMeta(tb?.tableType);
    const customName = String(tb?.name || "").trim();
    const isReserved = st.raw === "reservation";
    const isFree = st.raw === "free" && !isReserved;

    const isCleaning = st.raw === "cleaning";

    const waiterName = order ? (order.createdByWaiterName || order.lastUpdatedBy || t("role_waiter", "Ofitsiant")) : "";

    return `
      <div class="table-card ${isFree ? "tc-free" : ""}" onclick="${isCleaning ? "" : `window.openTable('${tableKey}')`}">
        <div class="tc-bar" style="background:${st.color}"></div>
        ${billReq ? `<span class="tc-bell" title="${t("client_bill_requested", "Mijoz hisob so'radi")}">🔔</span>` : (isReserved ? `<span class="tc-reserved-icon" title="${escapeHtml(label)}">🕒</span>` : "")}
        <div class="tc-card-top">
          <div class="tc-num">${meta.emoji} ${escapeHtml(customName || num)}</div>
          <span class="tc-status-badge" style="color:${st.color}">
            <span class="tc-status-dot" style="background:${st.color}"></span>${escapeHtml(label)}
          </span>
        </div>
        ${(seats || waiterName) ? `
        <div class="tc-info-row">
          ${seats ? `<span class="tc-info-item tc-seats">👥 ${escapeHtml(String(seats))}</span>` : ""}
          ${waiterName ? `<span class="tc-info-item">👤 ${escapeHtml(waiterName)}</span>` : ""}
        </div>` : ""}
        ${order ? `
        <div class="tc-badges">
          <span class="tc-badge tc-badge-order">🧾 ${escapeHtml(formatOrderNumber(order) || "—")}</span>
          <span class="tc-badge tc-badge-total">💳 ${money(order.total)}</span>
        </div>
        <div class="tc-meta">🕘 ${timeShort(order.createdAt)}</div>` : ""}
        ${isCleaning ? `
        <button class="tc-ready-btn" onclick="event.stopPropagation(); window.markTableReady('${tableKey}')">
          ✅ ${t("mark_table_ready", "Tayyor")}
        </button>` : `<div class="tc-open-hint">${isFree ? t("tap_to_open_table", "Band qilish →") : t("tap_to_open_table_view", "Ochish →")}</div>`}
      </div>`;
  }).join("");
}

/** Tozalash holatidagi stolni ofitsiant "Tayyor" deb belgilaganda bo'sh holatga o'tkazadi */
window.markTableReady = async function (tableKey) {
  try {
    await update(ref(db, `${BASE_PATH}/tables/${tableKey}`), { status: "free" });
    showToast(t("table_marked_free", "Stol bo'sh holatga o'tkazildi"), "success");
  } catch (e) {
    console.error("markTableReady:", e);
  }
};

// ══════════════════════════════════════════
// 8. VIEW ALMASHTIRISH
// ══════════════════════════════════════════
function showView(name) {
  document.getElementById("viewTables").classList.toggle("active", name === "tables");
  document.getElementById("viewOrder").classList.toggle("active",  name === "order");
  window.scrollTo(0, 0);
}

window.backToTables = function () {
  activeTableKey = null;
  activeTableNumber = null;
  activeOrderId = null;
  window.__waiterJustPaidOrderId = null;
  cart = {};
  menuSearchQuery = "";
  const s = document.getElementById("menuSearch");
  if (s) s.value = "";
  showView("tables");
};

// ══════════════════════════════════════════
// 9. VIEW 2 — BUYURTMA OYNASINI OCHISH
// ══════════════════════════════════════════
window.openTable = async function (tableKey) {
  activeTableKey    = tableKey;
  activeTableNumber = getTableNumber(tableKey, tablesCache[tableKey]);
  activeCategory    = "all";
  activeSubCategory = "all";
  menuSearchQuery   = "";
  payMethod         = "cash";
  cart              = {};

  // Menyu hali yuklanmagan bo'lsa — bir martalik so'rov
  if (Object.keys(menuCache).length === 0) {
    try {
      const snap = await get(ref(db, `${BASE_PATH}/menu`));
      menuCache = snap.exists() ? snap.val() : {};
    } catch (e) { console.error("menu fetch:", e); }
  }

  syncActiveOrder();

  showView("order");
  refreshOrderScreenHeader();
  renderCategories();
  renderSubCategories();
  renderMenuItems();
  renderStatusRow();
  renderOrderHistory();

  const s = document.getElementById("menuSearch");
  if (s) s.value = "";
};

/** Ochiq buyurtma bo'lsa — savatga yuklaydi (sent:true bilan) */
function syncActiveOrder() {
  // To'lovdan keyingi ko'rsatish oynasida (window.__waiterJustPaidOrderId) real-time
  // orders yangilanishi savatni darhol tozalab yubormasligi kerak — buyurtma
  // "to'landi" bo'lgani uchun findOpenOrderForTable uni "yopiq" deb topadi.
  if (window.__waiterJustPaidOrderId && activeOrderId === window.__waiterJustPaidOrderId) {
    return;
  }

  const open = findOpenOrderForTable(activeTableNumber);

  if (!open) {
    // Buyurtma yopilgan bo'lsa — faqat yuborilmagan qatorlar qoladi
    activeOrderId = null;
    Object.keys(cart).forEach(k => { if (cart[k].sent) delete cart[k]; });
    renderCart();
    return;
  }

  activeOrderId = open.id;

  // Bazadagi itemlarni savatga (sent) qilib olamiz, mahalliy yangilarini saqlaymiz
  const localNew = {};
  Object.entries(cart).forEach(([k, v]) => { if (!v.sent) localNew[k] = v; });

  const merged = {};
  Object.entries(open.items || {}).forEach(([itemKey, it]) => {
    merged[itemKey] = {
      menuId: it.id || it.menuId || itemKey.split("__")[0],
      qty:    Number(it.qty || 0),
      price:  Number(it.price || 0),
      name:   it.name,
      note:   it.note || "",
      sent:   true,
      status: it.status || "pending",
      addedBy:   it.addedBy || "",
      addedAt:   it.addedAt || open.createdAt,
      isWeightBased: it.isWeightBased === true,
      variantKey:  it.variantKey || null,
      variantName: it.variantName || null
    };
  });

  cart = { ...merged, ...localNew };
  renderCart();
}

/**
 * 🩹 HANG FIX: bu avval orderByChild("orderId")+equalTo() bilan INDEXLANGAN
 * query ishlatgan va HAR SAFAR activeOrderId o'zgarganda (ya'ni har safar
 * stol ochilganda) qayta obuna bo'lardi. Muammo: database.rules.json'dagi
 * ".indexOn" ENDI kodda bor, lekin bu FAYL Firebase'ga alohida deploy
 * qilinishi kerak — deploy qilinmagan holatda RTDB bunday querylarni
 * to'liq to'plamni yuklab, CLIENT tomonda filtrlash orqali bajaradi (RTDB
 * ning yaxshi hujjatlashtirilgan sekinlik muammosi), bu esa aynan
 * "funksiya qo'shilgach panel qotib qoldi" alomatiga mos keladi.
 * Tuzatish: admin.js/kassa.js allaqachon ishlatayotgan XAVFSIZ naqsh —
 * BITTA marta butun tugunga oddiy onValue (indexga bog'liq emas), keyin
 * kerakli orderId bo'yicha CLIENT tomonda filtrlash. Endi qayta obuna
 * bo'lish, listener boshqarish yoki index'ga bog'liqlik umuman yo'q.
 */
let allOrderChangeRequests = {};

function listenOrderChangeRequestsGlobal() {
  if (_IS_LOCAL_DEBUG) console.log("[OCR-DIAG] listener init: waiter orderChangeRequests");
  onValue(ref(db, `${BASE_PATH}/orderChangeRequests`), snap => {
    if (_IS_LOCAL_DEBUG) console.log("[OCR-DIAG] listener callback: waiter orderChangeRequests");
    allOrderChangeRequests = snap.exists() ? snap.val() : {};
    if (activeOrderId) renderCart();
  });
}

/** Berilgan savat qatori (itemKey) uchun HALI HAL QILINMAGAN (pending) so'rov bormi? */
function _pendingRequestForItemKey(itemKey) {
  if (!activeOrderId) return null;
  return Object.values(allOrderChangeRequests).find(
    r => r.orderId === activeOrderId && r.itemKey === itemKey && r.status === "pending"
  ) || null;
}

function refreshOrderScreenHeader() {
  const numEl    = document.getElementById("osTableNum");
  const badgeEl  = document.getElementById("osTableBadge");
  const clientEl = document.getElementById("osTableClient");
  const servedEl = document.getElementById("osServedBy");
  const chipEl   = document.getElementById("osReceiptChip");
  const chipNumEl = document.getElementById("osReceiptNum");
  if (numEl) numEl.textContent = activeTableNumber || "—";

  if (badgeEl && activeTableKey) {
    const meta = typeMeta(tablesCache[activeTableKey]?.tableType);
    badgeEl.textContent = `${meta.emoji} ${meta.label}`;
    const badgeStyleByType = {
      vip:     { bg: "rgba(168,85,247,0.15)", color: "#a855f7" },
      terrasa: { bg: "rgba(34,197,94,0.15)",  color: "#22c55e" },
      oddiy:   { bg: "rgba(148,163,184,0.15)", color: "#94a3b8" }
    };
    const style = badgeStyleByType[meta.key] || { bg: "rgba(59,130,246,0.15)", color: "#3b82f6" };
    badgeEl.style.background = style.bg;
    badgeEl.style.color = style.color;
  }

  const open = findOpenOrderForTable(activeTableNumber);

  if (servedEl) {
    const staffName = open?.createdByWaiterName || open?.staffName || open?.waiterName || sessionStorage.getItem("name") || "";
    servedEl.textContent = staffName || t("client_anonymous", "Anonim");
  }

  if (chipEl && chipNumEl) {
    if (open?.orderNumber) {
      chipNumEl.textContent = open.orderNumber;
      chipEl.style.display = "";
    } else {
      chipEl.style.display = "none";
    }
  }

  if (clientEl) {
    const rawName  = open ? (open.customerName || open.clientName || open.name || "") : "";
    const rawPhone = open
      ? (open.customerPhone || open.clientPhone || open.phone || "")
      : (tablesCache[activeTableKey]?.customerPhone || "");
    // ⚠️ Ba'zi buyurtmalarda customerName maydoni haqiqiy mijoz ismi o'rniga
    // "Stol N" kabi avtomatik yorliq bilan to'ldirilgan bo'lishi mumkin — bu
    // holatda ismni butunlay ko'rsatmaymiz, faqat telefon raqamini chiqaramiz.
    const looksLikeTableLabel = /^stol\s*\d+$/i.test(String(rawName).trim());
    const showName = rawName && !looksLikeTableLabel;
    const label = showName ? String(rawName) : (rawPhone ? "" : t("client_anonymous", "Anonim"));
    const phoneLabel = rawPhone ? `📞 ${escapeHtml(rawPhone)}` : "";
    const parts = [label, phoneLabel].filter(Boolean);
    const bodyHtml = parts.length
      ? parts.map((p, i) => i === 0 && showName ? `` : p).join(" ")
      : ``;
    clientEl.innerHTML = `${t("client_label", "Mijoz")}: ${bodyHtml}`;
  }

  renderStatusRow();
}

// normalizePhone endi shared.js'dan import qilinadi (yagona manba — admin.js
// bilan bir xil chiqish, ikkita mustaqil nusxa emas).

// ── Mijoz individual chegirmasi keshi (normalizedPhone → {pct, reason}) ──
// ROOT CAUSE FIX: renderCartSummary() — savat old-ko'rinishi (hali order
// yaratilmagan holatda ham) — SINXRON funksiya (natijasi darhol DOMga
// yoziladi), lekin customer lookup Firebase'dan ASINXRON o'qiladi. Shuning
// uchun customer chegirmasi telefon kiritilgan zahoti (editClientPhone())
// shu keshga oldindan yozib qo'yiladi — renderCartSummary() keyin buni
// qo'shimcha Firebase so'rovisiz, sinxron o'qiy oladi. Bir marta o'qilgan
// telefon uchun keshda saqlanadi (0 — "topilmadi/chegirmasi yo'q" holati
// ham keshlanadi, cheksiz qayta so'rov bermaslik uchun).
let _custDiscountLookupCache = {};

/** customers/{phone} yozuvidan individual chegirmani (pct + sabab) o'qiydi,
 *  keshga yozadi va qaytaradi. computeCustomerAwareDiscount() va
 *  renderCartSummary()ning kesh-to'ldirish bosqichi shu YAGONA joydan
 *  o'qiydi — ikki xil Firebase-o'qish yo'li yaratilmadi. */
async function _lookupCustomerDiscount(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return { pct: 0, reason: null, oneTimeClaim: null };
  if (Object.prototype.hasOwnProperty.call(_custDiscountLookupCache, normalizedPhone)) {
    return _custDiscountLookupCache[normalizedPhone];
  }
  let result = { pct: 0, reason: null, oneTimeClaim: null };
  try {
    const custRef = ref(db, `${BASE_PATH}/customers/${encodeURIComponent(normalizedPhone)}`);
    const snap = await get(custRef);
    if (snap.exists()) {
      const profile = snap.val() || {};
      // discountPercent — admin.js Customers modulining yangi asosiy maydoni,
      // personalDiscount — eski/compat maydon (applyCustomerDiscount() ikkalasiga
      // ham bir vaqtda yozadi) — QO'SHILMAYDI, faqat mavjud bo'lgani o'qiladi.
      // 🆕 oneTimeDiscounts — QR orqali berilgan bir martalik chegirma claimlari
      // (backend/discountClaims/claimsService.js yozadi), PERMANENT
      // discountPercent'dan MUTLAQO ALOHIDA maydon — bir nechtasi "available"
      // bo'lsa (spec §11), faqat ENG KATTA foizlisi bitta orderda ishlatiladi.
      const oneTime = Object.entries(profile.oneTimeDiscounts || {})
        .filter(([, v]) => v.status === "available")
        .map(([token, v]) => ({ token, percent: Number(v.percent || 0) }))
        .sort((a, b) => b.percent - a.percent)[0] || null;
      result = {
        pct: Number(profile.discountPercent || profile.personalDiscount || 0),
        reason: profile.personalDiscountReason || null,
        oneTimeClaim: oneTime,
      };
    }
  } catch (err) {
    console.error("_lookupCustomerDiscount error:", err);
    // Xatolik bo'lsa — natijani keshlamaymiz (keyingi urinish qayta so'rov
    // bersin, doimiy "0% topilmadi" holatida qotib qolmasin).
    return { pct: 0, reason: null, oneTimeClaim: null };
  }
  _custDiscountLookupCache[normalizedPhone] = result;
  return result;
}

/** Faqat shu restoran (BASE_PATH) doirasida — customers/{phone} yozuvidagi individual
 *  chegirmani sozlamalar-asosli avtomatik chegirma (computeAutoDiscount) bilan solishtirib,
 *  ikkalasidan KATTASINI qaytaradi. client.js'dagi calculateDiscount()ning "plain discount"
 *  + auto-discount qismi bilan BIR XIL MAX() ustuvorlik qoidasi — waiter.js'da VIP tushunchasi
 *  yo'qligi uchun faqat shu ikki manba solishtiriladi. Hech qanday order yozmaydi, faqat
 *  hisoblab qaytaradi — Firebase yozuvi chaqiruvchi tomonda amalga oshiriladi. Firebase
 *  o'qishi customers/{restId}/{phone} — Rules allaqachon shu restId doirasida ruxsat beradi
 *  (database.rules.json: auth.token.restId == $restId), boshqa restoran mijozlari umuman
 *  ko'rinmaydi — yangi/kengroq rule shart emas. */
async function computeCustomerAwareDiscount(phone, baseAmount) {
  const autoInfo = computeAutoDiscount(baseAmount);
  const { pct: customerPct, reason: customerReason, oneTimeClaim } = await _lookupCustomerDiscount(phone);

  // 🆕 BIZNES QOIDASI O'ZGARDI (avval MAX(customer, auto) edi): individual
  // (mijoz) chegirmasi + avtomatik chegirma endi QO'SHILADI — masalan
  // mijoz 3% + auto 5% = 8%. 100% dan oshmasin. client.js'dagi
  // calculateDiscount() bilan bir xil qoida — waiter.js'da VIP tushunchasi
  // yo'q, shuning uchun "individual" bu yerda faqat customerPct.
  const combinedPercent = Math.min(100, customerPct + autoInfo.percent);
  let percent = combinedPercent;
  let source = null;
  let reason = null;
  let claimId = null;
  let breakdown = null;
  if (customerPct > 0 && autoInfo.percent > 0) {
    source = "combined";
    reason = customerReason;
    breakdown = { customer: customerPct, auto: autoInfo.percent, total: combinedPercent };
  } else if (autoInfo.percent > 0) {
    source = "auto";
  } else if (customerPct > 0) {
    source = "customer_phone_match";
    reason = customerReason;
  }

  // 🆕 QR one-time claim — MAX ustuvorlik qoidasi (o'zgarmadi, spec §14):
  // individual+auto kombinatsiyasidan kattaroq bo'lsagina g'olib chiqadi va
  // UNI ALMASHTIRADI (ustiga qo'shilmaydi). G'olib bo'lsa claimId order
  // yozuvida saqlanadi (pastda applyPendingCustomerDiscount) — to'lov
  // tugagach aynan shu claim discountClaimsClient.use() orqali "used" qilinadi.
  if (oneTimeClaim && oneTimeClaim.percent > percent) {
    percent = oneTimeClaim.percent;
    source = "qr_one_time";
    reason = null;
    claimId = oneTimeClaim.token;
    breakdown = null;
  }

  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    console.info("[DISCOUNT-TRACE] computeCustomerAwareDiscount", {
      phone: normalizePhone(phone) || null, baseAmount, customerPct,
      autoPercent: autoInfo.percent, oneTimeClaimPercent: oneTimeClaim?.percent || 0,
      finalDiscountPercent: percent, finalSource: source
    });
  }

  const amount = Math.round(Number(baseAmount || 0) * percent / 100);
  return { percent, amount, source, reason, claimId, breakdown };
}

/** admin.js'dagi customers/{phone} yozuvida faol shaxsiy chegirma (% + sababi) bo'lsa,
 *  uni joriy buyurtmaga chegirma summasi sifatida qo'llaydi. Bu chegirma admin CRM
 *  paneli orqali qo'lda berilgan bo'lishi mumkin, yoki mijoz avvalgi chekdagi QR kodni
 *  ko'rib, shu safar o'sha raqamni aytganda — ikkalasi ham bir xil customers/{phone}
 *  yozuvidan o'qiladi.
 *  🆕 Endi computeCustomerAwareDiscount() (MAX(customer, auto) qoidasi) orqali hisoblanadi
 *  va order.discountSource "auto"/"customer_phone_match"/bo'sh bo'lsa qayta hisoblanadi —
 *  bu ikkalasi ham shu funksiyaning O'ZI boshqaradigan manbalar, shuning uchun mijoz
 *  raqami o'zgarganda (masalan boshqa mijozga almashtirilsa) eski qiymat to'g'ri
 *  yangilanadi. Agar order boshqa (kelajakda qo'shilishi mumkin bo'lgan) manbadan qo'lda
 *  chegirmaga ega bo'lsa — bu funksiya UNGA TEGMAYDI. */
async function applyPendingCustomerDiscount(phone, orderId) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone || !orderId) return;

  try {
    const order = ordersCache[orderId] || {};
    const existingSource = order.discountSource;
    const isSafeToRecompute = !existingSource || existingSource === "auto" || existingSource === "customer_phone_match" || existingSource === "qr_one_time" || existingSource === "combined";
    if (!isSafeToRecompute) return; // qo'lda/boshqa manbadan kelgan chegirmani hech qachon bosib yozmaymiz

    const base = Number(order.total) || cartTotal();
    const { percent, amount, source, reason, claimId, breakdown } = await computeCustomerAwareDiscount(normalizedPhone, base);

    await update(ref(db, `${BASE_PATH}/orders/${orderId}`), {
      discount: amount,
      discountAmount: amount,
      discountPercent: percent,
      discountReason: reason || (amount > 0 ? t("qr_discount_default_reason", "Sodiq mijoz chegirmasi") : null),
      discountSource: source,
      discountClaimId: claimId || null, // 🆕 faqat source==="qr_one_time" bo'lsa mavjud — aks holda tozalanadi
      discountBreakdown: breakdown || null, // 🆕 faqat source==="combined" bo'lsa mavjud (spec §10) — aks holda tozalanadi
      discountApplied: amount > 0
    });

    if (amount > 0) {
      showToast(`🎁 ${t("customer_discount_applied", "Mijozga shaxsiy chegirma qo'llandi")}: ${percent}%`, "success");
    }
    if (activeTableKey) renderCart();
  } catch (err) {
    console.error("applyPendingCustomerDiscount error:", err);
  }
}

/** Mijoz telefon raqamini kiritish/tahrirlash — kalam ikonkasi orqali chaqiriladi */
window.editClientPhone = async function () {
  if (!activeTableKey) return;
  const open = findOpenOrderForTable(activeTableNumber);
  const currentPhone = open
    ? (open.customerPhone || open.clientPhone || open.phone || "")
    : (tablesCache[activeTableKey]?.customerPhone || "");

  const input = prompt(t("client_phone_prompt", "Mijoz telefon raqamini kiriting:"), currentPhone || "");
  if (input === null) return; // bekor qilindi

  // Kanonik +998901234567 shakliga keltiramiz (901234567 / 90 123 45 67 /
  // 998901234567 / +998901234567 — barchasi bir xil natija beradi), aks
  // holda customerPhone maydoni raw holatda yozilib, discount/lookup bilan
  // mos kelmasligi mumkin edi (lookup allaqachon normalizePhone ishlatadi).
  const trimmed = input.trim();
  const phone = trimmed ? (normalizePhone(trimmed) || trimmed) : "";

  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    console.info("[DISCOUNT-TRACE] phone before order:", phone);
    console.info("[DISCOUNT-TRACE] table cache phone (before write):", tablesCache?.[activeTableKey]?.customerPhone);
  }

  try {
    if (open) {
      await update(ref(db, `${BASE_PATH}/orders/${open.id}`), { customerPhone: phone });
      // Raqam kiritilgach, shu mijozga oldindan berilgan chegirma bo'lsa — avtomatik qo'llaymiz.
      // (applyPendingCustomerDiscount() o'zi renderCart()ni chaqiradi — pastda qayta chaqirilmaydi.)
      if (phone) await applyPendingCustomerDiscount(phone, open.id);
    } else {
      await update(ref(db, `${BASE_PATH}/tables/${activeTableKey}`), { customerPhone: phone });
      // 🐛 ROOT CAUSE FIX — "customer discount cart preview'da ko'rinmayapti":
      // hali order yo'q (fresh stol) holatida telefon FAQAT tables/{tableKey}
      // node'iga yozilardi va bu yerda hech qanday chegirma qidiruvi/qayta
      // chizish chaqirilmasdi — renderCartSummary() esa faqat ALLAQACHON
      // yaratilgan order'ning discountAmount'ini o'qiydi (fresh stolda 0),
      // shuning uchun mijozning 10% chegirmasi buyurtma yaratilmaguncha
      // hech qayerda ko'rinmasdi (garchi sendOrderToKitchen() buyurtma
      // yaratilganda uni to'g'ri hisoblab yozsa ham). Endi telefon
      // kiritilgan zahoti chegirmani oldindan qidirib keshga yozamiz va
      // savat preview'ni darhol qayta chizamiz.
      if (phone) await _lookupCustomerDiscount(phone);
      if (activeTableKey) renderCart();
    }
    refreshOrderScreenHeader();
  } catch (err) {
    console.error(err);
    alert(t("notify.error", "Xatolik yuz berdi"));
  }
};

// ══════════════════════════════════════════
// 10. MENYU — KATEGORIYA, QIDIRUV, TAOMLAR
// ══════════════════════════════════════════
/**
 * Kategoriya nomida bazada emoji maydoni yo'q, shuning uchun nomdagi kalit
 * so'zlarga qarab taxminiy mos emoji tanlaymiz. Mos kelmasa neytral fallback.
 */
const CATEGORY_EMOJI_GUESS = [
  { emoji: "🍲", keywords: ["asosiy", "osnovn", "main"] },
  { emoji: "🥗", keywords: ["salat", "salad"] },
  { emoji: "🍜", keywords: ["sho'rva", "shorva", "sup", "soup"] },
  { emoji: "🍖", keywords: ["kabob", "shashlik", "shashlyk", "grill"] },
  { emoji: "🍛", keywords: ["palov", "plov", "osh"] },
  { emoji: "🍕", keywords: ["pitsa", "pizza"] },
  { emoji: "🍔", keywords: ["burger", "gamburger"] },
  { emoji: "🍰", keywords: ["shirin", "desert", "десерт", "tort", "cake"] },
  { emoji: "🥤", keywords: ["ichimlik", "napit", "drink", "sok", "sharbat"] },
  { emoji: "☕", keywords: ["choy", "kofe", "coffee", "tea", "chay"] },
  { emoji: "🍞", keywords: ["non", "хлеб", "bread"] },
  { emoji: "🍝", keywords: ["makaron", "lag'mon", "lagmon", "pasta"] },
  { emoji: "🐟", keywords: ["baliq", "рыба", "fish"] },
  { emoji: "🍳", keywords: ["nonushta", "завтрак", "breakfast"] }
];

function guessCategoryEmoji(name) {
  const s = String(name || "").toLowerCase();
  for (const g of CATEGORY_EMOJI_GUESS) {
    if (g.keywords.some(k => s.includes(k))) return g.emoji;
  }
  return "🍽️";
}

// Faqat localhostda: [i18n-category-trace]/[i18n-subcategory-trace]
// vaqtinchalik diagnostika logi (real brauzer bilan tasdiqlash uchun) —
// production sessiyalarga chiqmaydi.
const _IS_LOCAL_DEBUG = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

// Haqiqiy Firebase category kalitlari bilan hech qachon to'qnashmaydigan
// virtual filtr id'i — Combo Setlar uchun (item 2/39).
const COMBO_VIRTUAL_CATEGORY_ID = "__combo_sets__";

function renderCategories() {
  const box = document.getElementById("osCats");
  if (!box) return;

  // Faqat kamida bitta faol taomi bor kategoriyalarni ko'rsatamiz.
  const activeItems = Object.values(menuCache || {}).filter(m => m.active !== false && m.archived !== true);
  const usedCatIds = new Set(activeItems.map(m => m.category).filter(Boolean));
  const cats = (categoriesCache || []).filter(c => usedCatIds.has(c.id));
  // 🎁 Admin yaratgan Combo Setlar (menu/{id}.isCombo === true — mavjud
  // schema, alohida Firebase node yo'q) — combo o'ziga tegishli oddiy
  // category ostida ham chiqishi mumkin, lekin buni hech qanday filtr
  // orqali "hammasini birga" ko'rish imkoni yo'q edi. Kamida bitta faol
  // combo bo'lsagina virtual "Combo Setlar" chip ko'rsatiladi.
  const hasCombo = activeItems.some(m => m.isCombo === true);

  const btn = (id, label, emoji) => `
    <button class="cat-btn ${activeCategory === id ? "active" : ""}"
            onclick="window.selectCategory('${escapeHtml(id).replace(/'/g, "\\'")}')">
      ${emoji ? `<span>${emoji}</span>` : ""}${escapeHtml(label)}
    </button>`;

  let html = btn("all", t("all_categories", "Hammasi"), "🍽️");
  if (hasCombo) html += btn(COMBO_VIRTUAL_CATEGORY_ID, t("menu_combo_category_label", "Combo Setlar"), "🎁");
  cats.forEach(c => {
    const label = localName(c.name, c.id);
    if (_IS_LOCAL_DEBUG) {
      console.info("[i18n-category-trace]", {
        language: getLang(), i18nReady: typeof t === "function", categoryKey: c.id, translatedText: label
      });
    }
    html += btn(c.id, label, guessCategoryEmoji(label));
  });
  box.innerHTML = html;
}

window.selectCategory = function (catId) {
  activeCategory = catId;
  activeSubCategory = "all";
  renderCategories();
  renderSubCategories();
  renderMenuItems();
};

/** category.sub ni admin.js yozadigan haqiqiy format (Firebase kalit-qiymat obyekti,
 *  masalan {cs_123:{id,name}, cs_456:{id,name}}) bo'lsa ham, eski/mumkin bo'lgan
 *  massiv format bo'lsa ham bir xil massivga aylantiradi. Bu tuzatishdan oldin
 *  kod `Array.isArray(catObj.sub)` bilan tekshirar edi — bu haqiqiy obyekt
 *  formatida doim false qaytarib, subkategoriyalarni butunlay yashirib qo'yardi. */
function toSubArray(sub) {
  if (!sub) return [];
  if (Array.isArray(sub)) return sub;
  if (typeof sub === "object") return Object.values(sub);
  return [];
}

function renderSubCategories() {
  const box = document.getElementById("osSubCats");
  if (!box) return;

  const btn = (id, label) => `
    <button class="subcat-btn ${activeSubCategory === id ? "active" : ""}"
            onclick="window.selectSubCategory('${escapeHtml(id).replace(/'/g, "\\'")}')">
      ${escapeHtml(label)}
    </button>`;

  const activeItems = Object.values(menuCache || {}).filter(m => m.active !== false && m.archived !== true);
  const usedSubCatIds = new Set(
    activeItems.map(m => m.subCategory || m.subcategory).filter(Boolean)
  );

  let subs;
  if (activeCategory === COMBO_VIRTUAL_CATEGORY_ID) {
    // Combo Setlar — mustaqil taomlar kombinatsiyasi, o'zining subkategoriyasi
    // tushunchasi yo'q (item 2).
    subs = [];
  } else if (activeCategory === "all") {
    // ⚠️ "Barcha kategoriyalar" holatida — barcha kategoriyalarning subkategoriyalarini
    // birlashtirib ko'rsatamiz (bir xil sub.id ikki marta chiqmasligi uchun de-dup qilinadi).
    const seen = new Set();
    subs = [];
    (categoriesCache || []).forEach(c => {
      toSubArray(c.sub).forEach(s => {
        if (!seen.has(s.id)) {
          seen.add(s.id);
          subs.push(s);
        }
      });
    });
  } else {
    const catObj = (categoriesCache || []).find(c => c.id === activeCategory);
    subs = catObj ? toSubArray(catObj.sub) : [];
  }

  // Faqat kamida bitta faol taomi bor subkategoriyalarni ko'rsatamiz.
  subs = subs.filter(s => usedSubCatIds.has(s.id));

  if (subs.length === 0) {
    box.innerHTML = "";
    return;
  }

  let html = btn("all", t("all_subcategories", "Hammasi"));
  subs.forEach(s => {
    const label = localName(s.name, s.id);
    if (_IS_LOCAL_DEBUG) {
      console.info("[i18n-subcategory-trace]", {
        language: getLang(), i18nReady: typeof t === "function", subcategoryKey: s.id, translatedText: label
      });
    }
    html += btn(s.id, label);
  });
  box.innerHTML = html;
}

window.selectSubCategory = function (subId) {
  activeSubCategory = subId;
  renderSubCategories();
  renderMenuItems();
};

window.onMenuSearch = function (val) {
  menuSearchQuery = String(val || "").trim().toLowerCase();
  renderMenuItems();
};

/** Taom kartasi rasmi yuklanmasa (buzilgan URL) — bo'sh joy qoldirish
 *  o'rniga <img>ni bir xil "No Image" placeholderga almashtiradi, xuddi
 *  imgSrc umuman bo'lmagan holatdagidek (renderMenuItems() pastda). */
window._mcImgError = function (imgEl) {
  if (!imgEl || imgEl.dataset.mcFallbackApplied) return;
  imgEl.dataset.mcFallbackApplied = "1";
  const placeholder = document.createElement("div");
  placeholder.className = "mc-img-placeholder";
  placeholder.innerHTML = `<span class="mc-img-icon">🍽️</span><span class="mc-img-label">${t("no_image_label", "Rasm yo'q")}</span>`;
  imgEl.replaceWith(placeholder);
};

function renderMenuItems() {
  const box = document.getElementById("osItems");
  if (!box) return;

  let entries = Object.entries(menuCache || {});

  if (entries.length === 0) {
    box.innerHTML = `<p class="empty-state" style="grid-column:1/-1;">${t("menu_loading", "Menyu yuklanmoqda...")}</p>`;
    return;
  }

  // Mavjud emas / arxivlangan taomlarni chiqarmaymiz
  entries = entries.filter(([, m]) => m.active !== false && m.archived !== true);

  if (activeCategory === COMBO_VIRTUAL_CATEGORY_ID) {
    entries = entries.filter(([, m]) => m.isCombo === true);
  } else if (activeCategory !== "all") {
    entries = entries.filter(([, m]) => m.category === activeCategory);
  }
  if (activeSubCategory !== "all" && activeCategory !== COMBO_VIRTUAL_CATEGORY_ID) {
    // "Barcha kategoriyalar" holatida ham subkategoriya filtri ishlashi kerak,
    // chunki renderSubCategories endi barcha kategoriyalarning subkategoriyalarini
    // birlashtirib ko'rsatadi.
    entries = entries.filter(([, m]) => (m.subCategory || m.subcategory) === activeSubCategory);
  }

  if (menuSearchQuery) {
    entries = entries.filter(([, m]) =>
      localName(m.name, "").toLowerCase().includes(menuSearchQuery));
  }

  if (entries.length === 0) {
    box.innerHTML = `<p class="empty-state" style="grid-column:1/-1;">${t("no_items_found", "Taom topilmadi")}</p>`;
    return;
  }

  box.innerHTML = entries.map(([id, m]) => {
    const name    = localName(m.name);
    const price   = Number(m.price || 0);
    const imgSrc  = m.imgUrl || m.img || m.image || "";
    const isW     = m.isWeightBased === true;
    const variants = getMenuVariants(m);
    const hasVariants = variants.length > 0;
    const qtyInCart = getCartQtyForMenu(id);

    const kgBadge = isW ? `<span class="mc-kg-badge">KG</span>` : "";

    const priceLabel = hasVariants
      ? `${t("from_price", "dan")} ${money(Math.min(...variants.map(v => Number(v.price || 0))))} ${t("currency", "so'm")}`
      : `${money(price)} ${t("currency", "so'm")}${isW ? " / kg" : ""}`;

    // 🆕 Quantity control endi cardning pastki-markaziy qismida, alohida
    // qatorda (.mc-qty-row) — eski "− 1x badge + [+] o'ngda" o'rniga.
    // window.changeQty(id, delta)ning O'ZI (increment/decrement/remove/
    // "yuborilgan taomni o'zgartirib bo'lmaydi" logikasi) BUTUNLAY
    // o'zgarmadi — faqat markup/klass yangilandi, shu bitta funksiyaga
    // ikkala (−/+) tugma ham bog'langan (delta=-1 / delta=1).
    let controls;
    if (hasVariants) {
      // Variant tanlash logikasi (openVariantPrompt/addVariantToCart)
      // BUTUNLAY o'zgarmadi — faqat tugma endi qty-control joyida,
      // kattaroq va markazlashtirilgan ko'rinishda.
      controls = `<button class="btn-variant" onclick="event.stopPropagation(); window.openVariantPrompt('${id}')">
                     🔀 ${qtyInCart > 0 ? `${qtyInCart}x ${t("chosen_label", "tanlangan")}` : t("choose_variant_btn", "Variant tanlash")}
                   </button>`;
    } else if (isW) {
      controls = `<button class="btn-weight" onclick="event.stopPropagation(); window.openWeightPrompt('${id}')">
                     ⚖️ ${qtyInCart > 0 ? `${qtyInCart} kg` : t("enter_weight_btn", "Vazn")}
                   </button>`;
    } else if (qtyInCart > 0) {
      // Tanlangan holat — uzun gorizontal "pill" ichida − / son / + —
      // quantity FAQAT shu bitta joyda ko'rsatiladi (alohida "1x" badge
      // yo'q, duplicate bo'lmasin). Klass nomlari ataylab "mc-qty-" bilan
      // nomlangan (oddiy .qty-btn/.qty-minus/.qty-plus/.qty-val EMAS) —
      // waiter.css'da savat qatoridagi (.cr-qty) stepper allaqachon aynan
      // shu nomlarni ishlatadi; bir xil nom ikkala komponentni ham
      // kutilmagan tarzda bir-biriga ta'sir qildirib qo'yardi.
      controls = `<div class="mc-qty-pill mc-qty-filled">
                     <button class="mc-qty-minus-btn" onclick="event.stopPropagation(); window.changeQty('${id}', -1)" aria-label="${t("decrease_qty", "Kamaytirish")}">−</button>
                     <span class="mc-qty-num">${qtyInCart}</span>
                     <button class="mc-qty-plus-btn" onclick="event.stopPropagation(); window.changeQty('${id}', 1)" aria-label="${t("increase_qty", "Ko'paytirish")}">+</button>
                   </div>`;
    } else {
      // Tanlanmagan holat — xuddi shu o'lchamdagi pill, ichida faqat "+"
      // (kichik kvadrat emas — butun pill bo'ylab bosiladi).
      controls = `<div class="mc-qty-pill mc-qty-empty">
                     <button class="mc-qty-plus-solo" onclick="event.stopPropagation(); window.changeQty('${id}', 1)" aria-label="${t("add_to_cart_btn", "Savatga qo'shish")}">+</button>
                   </div>`;
    }

    // Vazn yoki variant bo'yicha sotiladigan taomlar uchun kartaning o'zi bosilganda emas,
    // faqat tegishli tugma orqali (yuqorida stopPropagation bilan) amal bajariladi.
    const cardClick = (isW || hasVariants) ? "" : `onclick="window.changeQty('${id}', 1)"`;

    // Rasm mavjud bo'lmasa (yoki yuklanmasa — onerror) professional
    // placeholder ko'rsatiladi (window._mcImgError, pastda e'lon qilingan),
    // karta balandligi (.mc-img-wrap orqali) buzilmaydi — narx/tugmalar
    // har doim bir xil joyda qoladi.
    const imgBlockHtml = imgSrc
      ? `<img src="${escapeHtml(imgSrc)}" alt="" onerror="window._mcImgError(this)">`
      : `<div class="mc-img-placeholder"><span class="mc-img-icon">🍽️</span><span class="mc-img-label">${t("no_image_label", "Rasm yo'q")}</span></div>`;

    return `
      <div class="menu-card ${qtyInCart > 0 ? "in-cart" : ""}" ${cardClick}>
        ${kgBadge}
        <div class="mc-img-wrap">${imgBlockHtml}</div>
        <div class="mc-body">
          <div class="mc-top-row">
            <p class="mc-name">${escapeHtml(name)}</p>
            <p class="mc-price">${priceLabel}</p>
          </div>
          <div class="mc-qty-row">
            ${controls}
          </div>
        </div>
      </div>`;
  }).join("");
}

/**
 * Menyu elementidagi variantlarni (masalan: "Kichik/O'rta/Katta" yoki
 * "Yarim/Butun") normalizatsiya qilib qaytaradi: [{ key, name, price }, ...]
 * Bir nechta mumkin bo'lgan maydon nomini (variants/options/sizes) va
 * ham array, ham object shaklini qo'llab-quvvatlaydi.
 */
function getMenuVariants(m) {
  const raw = m.variants || m.options || m.sizes;
  if (!raw) return [];

  const list = Array.isArray(raw) ? raw.map((v, i) => [String(i), v]) : Object.entries(raw);

  return list
    .filter(([, v]) => v && typeof v === "object")
    .map(([key, v]) => ({
      key,
      name: v.name != null ? v.name : (v.label != null ? v.label : key),
      price: Number(v.price || 0)
    }));
}

/** Shu menyu ID bo'yicha savatdagi umumiy soni (barcha qatorlar) */
function getCartQtyForMenu(menuId) {
  return Object.values(cart)
    .filter(c => c.menuId === menuId)
    .reduce((s, c) => s + Number(c.qty || 0), 0);
}

// ══════════════════════════════════════════
// 11. SAVAT
// ══════════════════════════════════════════
/**
 * Yangi (yuborilmagan) qatorni topadi.
 * Yuborilgan qatorlar tegilmaydi — tarix buzilmasligi uchun.
 */
function findEditableCartKey(menuId) {
  const found = Object.entries(cart).find(([, c]) => c.menuId === menuId && !c.sent);
  return found ? found[0] : null;
}

window.changeQty = function (menuId, delta) {
  const m = menuCache[menuId];
  if (!m) return;

  let key = findEditableCartKey(menuId);

  if (!key) {
    if (delta < 0) {
      showToast(t("sent_item_readonly", "Yuborilgan taomni bu yerdan o'zgartirib bo'lmaydi"), "info");
      return;
    }
    key = `${menuId}__${Date.now()}`;
    cart[key] = {
      menuId,
      qty: 0,
      price: Number(m.price || 0),
      name: m.name,
      note: "",
      sent: false,
      isWeightBased: m.isWeightBased === true
    };
  }

  cart[key].qty = Number(cart[key].qty || 0) + delta;
  if (cart[key].qty <= 0) delete cart[key];

  renderMenuItems();
  renderCart();
};

// ══════════════════════════════════════════
// 11b. VARIANT TANLASH (masalan: Kichik / O'rta / Katta)
// ══════════════════════════════════════════
window.openVariantPrompt = function (menuId) {
  const m = menuCache[menuId];
  if (!m) return;
  const variants = getMenuVariants(m);
  if (variants.length === 0) return;

  const backdrop = document.createElement("div");
  backdrop.className = "variant-modal-backdrop";
  backdrop.onclick = (e) => { if (e.target === backdrop) backdrop.remove(); };

  backdrop.innerHTML = `
    <div class="variant-modal">
      <h4>${escapeHtml(localName(m.name))}</h4>
      <p class="vm-sub">${escapeHtml(t("choose_variant_sub", "Variantni tanlang"))}</p>
      ${variants.map(v => `
        <button type="button" class="vm-opt" data-variant-key="${escapeHtml(v.key)}">
          <span class="vm-opt-name">${escapeHtml(localName(v.name, String(v.name)))}</span>
          <span class="vm-opt-price">${money(v.price)} ${t("currency", "so'm")}</span>
        </button>`).join("")}
      <button type="button" class="vm-close">${escapeHtml(t("cancel_btn", "Bekor qilish"))}</button>
    </div>`;

  backdrop.querySelectorAll(".vm-opt").forEach(btn => {
    btn.onclick = () => {
      window.addVariantToCart(menuId, btn.dataset.variantKey);
      backdrop.remove();
    };
  });
  backdrop.querySelector(".vm-close").onclick = () => backdrop.remove();

  document.body.appendChild(backdrop);
};

window.addVariantToCart = function (menuId, variantKey) {
  const m = menuCache[menuId];
  if (!m) return;
  const variant = getMenuVariants(m).find(v => v.key === variantKey);
  if (!variant) return;

  // Har bir variant narxi boshqacha bo'lgani uchun, bir xil menyu + bir xil
  // variantga tegishli yuborilmagan qator bo'lsa sonini oshiramiz, aks holda yangi qator ochamiz.
  const existingKey = Object.entries(cart).find(
    ([, c]) => c.menuId === menuId && c.variantKey === variantKey && !c.sent
  );

  let key;
  if (existingKey) {
    key = existingKey[0];
    cart[key].qty = Number(cart[key].qty || 0) + 1;
  } else {
    key = `${menuId}__${variantKey}__${Date.now()}`;
    cart[key] = {
      menuId,
      qty: 1,
      price: Number(variant.price || 0),
      name: m.name,
      variantKey,
      variantName: variant.name,
      note: "",
      sent: false,
      isWeightBased: false
    };
  }

  renderMenuItems();
  renderCart();
};

window.openWeightPrompt = function (menuId) {
  const m = menuCache[menuId];
  if (!m) return;

  const current = getCartQtyForMenu(menuId);
  const input = prompt(
    `${localName(m.name)} — ${t("enter_weight_kg", "vaznni kiriting (kg)")}:`,
    current > 0 ? String(current) : ""
  );
  if (input === null) return;

  const kg = parseFloat(String(input).replace(",", "."));
  if (isNaN(kg) || kg < 0) {
    showToast(t("invalid_weight", "Noto'g'ri vazn"), "error");
    return;
  }

  let key = findEditableCartKey(menuId);
  if (kg === 0) {
    if (key) delete cart[key];
  } else {
    if (!key) {
      key = `${menuId}__${Date.now()}`;
      cart[key] = {
        menuId, qty: 0, price: Number(m.price || 0),
        name: m.name, note: "", sent: false, isWeightBased: true
      };
    }
    cart[key].qty = kg;
  }

  renderMenuItems();
  renderCart();
};

window.changeCartRowQty = function (cartKey, delta) {
  const row = cart[cartKey];
  if (!row) return;
  if (row.sent) {
    showToast(t("sent_item_readonly", "Yuborilgan taomni o'zgartirib bo'lmaydi"), "info");
    return;
  }
  row.qty = Number(row.qty || 0) + delta;
  if (row.qty <= 0) delete cart[cartKey];
  renderMenuItems();
  renderCart();
};

window.removeCartRow = async function (cartKey) {
  const row = cart[cartKey];
  if (!row) return;

  if (!row.sent) {
    delete cart[cartKey];
    renderMenuItems();
    renderCart();
    return;
  }

  // 🆕 Yuborilgan taom endi to'g'ridan-to'g'ri o'chirilmaydi — Admin/Kassir
  // tasdig'i shart (item 4/27/28: "Waiter → cancel → order darhol
  // o'zgardi" MUTLAQO bo'lmasin). Bu funksiya endi UI'dan sent qatorlar
  // uchun chaqirilmaydi (renderCart() endi 🚫/🔀 tugmalarini ko'rsatadi),
  // lekin himoya sifatida shu yerda ham to'g'ridan-to'g'ri Firebase
  // yozuvi o'rniga so'rov modalini ochamiz.
  window.openCancelItemRequestModal(cartKey);
};

window.setCartNote = function (cartKey, val) {
  if (cart[cartKey]) cart[cartKey].note = String(val || "").slice(0, 200);
};

// ══════════════════════════════════════════
// 9b. BUYURTMA O'ZGARTIRISH SO'ROVI (Bekor qilish / Almashtirish)
// Ofitsiant BU YERDAN faqat SO'ROV yaratadi — orderning o'zi
// o'zgarmaydi. Admin YOKI Kassir tasdiqlaganda shared.js'dagi
// approveOrderChangeRequest() orderni haqiqatan o'zgartiradi.
// ══════════════════════════════════════════
let _ocModalCartKey = null;
let _ocCancelQty = 1;

function _ocStaffName() {
  return window.currentStaffRealName || sessionStorage.getItem("name") || t("role_waiter", "Ofitsiant");
}

window.openCancelItemRequestModal = function (cartKey) {
  const row = cart[cartKey];
  if (!row || !activeOrderId) return;
  if (_pendingRequestForItemKey(cartKey)) {
    showToast(t("oc_already_pending_err", "Bu taom uchun allaqachon kutilayotgan so'rov mavjud"), "info");
    return;
  }
  _ocModalCartKey = cartKey;
  _ocCancelQty = 1;
  const name = localName(row.name, "");
  document.getElementById("ocCancelDishName").textContent = name;
  document.getElementById("ocCancelQtyVal").textContent = _ocCancelQty;
  document.getElementById("ocCancelRemainingHint").textContent =
    `${t("remaining_label", "Qoldiq")}: ${Math.max(0, Number(row.qty || 0) - _ocCancelQty)}`;
  const noteEl = document.getElementById("ocCancelNote");
  if (noteEl) noteEl.value = "";
  const el = document.getElementById("ocCancelModalBackdrop");
  if (el) el.style.display = "flex";
};

window.closeOcCancelModal = function () {
  const el = document.getElementById("ocCancelModalBackdrop");
  if (el) el.style.display = "none";
  _ocModalCartKey = null;
};

window.ocCancelChangeQty = function (delta) {
  const row = _ocModalCartKey ? cart[_ocModalCartKey] : null;
  if (!row) return;
  const maxQty = Number(row.qty || 0);
  _ocCancelQty = Math.min(maxQty, Math.max(1, _ocCancelQty + delta));
  document.getElementById("ocCancelQtyVal").textContent = _ocCancelQty;
  document.getElementById("ocCancelRemainingHint").textContent =
    `${t("remaining_label", "Qoldiq")}: ${Math.max(0, maxQty - _ocCancelQty)}`;
};

window.submitCancelItemRequest = async function () {
  const cartKey = _ocModalCartKey;
  const row = cartKey ? cart[cartKey] : null;
  if (!row || !activeOrderId) return;
  if (_pendingRequestForItemKey(cartKey)) {
    showToast(t("oc_already_pending_err", "Bu taom uchun allaqachon kutilayotgan so'rov mavjud"), "info");
    window.closeOcCancelModal();
    return;
  }

  const reason = document.getElementById("ocCancelReason")?.value || "customer_request";
  const note = document.getElementById("ocCancelNote")?.value?.trim() || "";
  const staffName = _ocStaffName();

  try {
    const reqRef = push(ref(db, `${BASE_PATH}/orderChangeRequests`));
    await update(ref(db), {
      [`${BASE_PATH}/orderChangeRequests/${reqRef.key}`]: {
        requestType: "cancel_item",
        status: "pending",
        orderId: activeOrderId,
        tableId: activeTableNumber,
        itemKey: cartKey,
        oldItem: { id: row.menuId, name: row.name, qty: Number(row.qty || 0), price: Number(row.price || 0) },
        requestedCancelQty: _ocCancelQty,
        reason,
        reasonNote: note,
        createdByUid: waiterId,
        createdByName: staffName,
        createdByRole: "waiter",
        createdAt: Date.now(),
      }
    });

    await writeOrderAuditLog(db, BASE_PATH, {
      actorId: waiterId, actorName: staffName, actorRole: "waiter",
      action: "order_change_requested",
      orderId: activeOrderId, table: activeTableNumber,
      description: `${staffName}: "${localName(row.name, "")}" — ${_ocCancelQty} porsiya bekor qilish so'rovi yubordi`,
    });

    showToast(t("oc_request_sent", "So'rov yuborildi"), "success");
    window.closeOcCancelModal();
  } catch (err) {
    console.error("submitCancelItemRequest error:", err);
    showToast(t("notify.error", "Xatolik yuz berdi"), "error");
  }
};

window.openReplaceItemRequestModal = function (cartKey) {
  const row = cart[cartKey];
  if (!row || !activeOrderId) return;
  if (_pendingRequestForItemKey(cartKey)) {
    showToast(t("oc_already_pending_err", "Bu taom uchun allaqachon kutilayotgan so'rov mavjud"), "info");
    return;
  }
  _ocModalCartKey = cartKey;
  document.getElementById("ocReplaceOldDishName").textContent = localName(row.name, "");
  document.getElementById("ocReplaceOldQty").textContent = row.qty;

  const select = document.getElementById("ocReplaceNewDish");
  if (select) {
    const options = Object.entries(menuCache)
      .filter(([id]) => id !== row.menuId)
      .map(([id, m]) => `<option value="${id}">${escapeHtml(localName(m.name, id))} — ${money(m.price)} ${t("currency", "so'm")}</option>`)
      .join("");
    select.innerHTML = `<option value="" disabled selected>${t("oc_select_dish_placeholder", "Taom tanlang...")}</option>${options}`;
  }
  const noteEl = document.getElementById("ocReplaceNote");
  if (noteEl) noteEl.value = "";
  const el = document.getElementById("ocReplaceModalBackdrop");
  if (el) el.style.display = "flex";
};

window.closeOcReplaceModal = function () {
  const el = document.getElementById("ocReplaceModalBackdrop");
  if (el) el.style.display = "none";
  _ocModalCartKey = null;
};

window.submitReplaceItemRequest = async function () {
  const cartKey = _ocModalCartKey;
  const row = cartKey ? cart[cartKey] : null;
  if (!row || !activeOrderId) return;
  if (_pendingRequestForItemKey(cartKey)) {
    showToast(t("oc_already_pending_err", "Bu taom uchun allaqachon kutilayotgan so'rov mavjud"), "info");
    window.closeOcReplaceModal();
    return;
  }

  const newDishId = document.getElementById("ocReplaceNewDish")?.value || "";
  if (!newDishId || !menuCache[newDishId]) {
    showToast(t("oc_select_dish_placeholder", "Taom tanlang..."), "error");
    return;
  }
  const newDish = menuCache[newDishId];
  const reason = document.getElementById("ocReplaceReason")?.value || "customer_wish";
  const note = document.getElementById("ocReplaceNote")?.value?.trim() || "";
  const staffName = _ocStaffName();
  const oldQty = Number(row.qty || 0);

  try {
    const reqRef = push(ref(db, `${BASE_PATH}/orderChangeRequests`));
    await update(ref(db), {
      [`${BASE_PATH}/orderChangeRequests/${reqRef.key}`]: {
        requestType: "replace_item",
        status: "pending",
        orderId: activeOrderId,
        tableId: activeTableNumber,
        itemKey: cartKey,
        oldItem: { id: row.menuId, name: row.name, qty: oldQty, price: Number(row.price || 0) },
        oldQuantity: oldQty,
        newItem: { id: newDishId, name: newDish.name, price: Number(newDish.price || 0) },
        newQuantity: oldQty,
        reason,
        reasonNote: note,
        createdByUid: waiterId,
        createdByName: staffName,
        createdByRole: "waiter",
        createdAt: Date.now(),
      }
    });

    await writeOrderAuditLog(db, BASE_PATH, {
      actorId: waiterId, actorName: staffName, actorRole: "waiter",
      action: "order_change_requested",
      orderId: activeOrderId, table: activeTableNumber,
      description: `${staffName}: "${localName(row.name, "")}" → "${localName(newDish.name, "")}" almashtirish so'rovi yubordi`,
    });

    showToast(t("oc_request_sent", "So'rov yuborildi"), "success");
    window.closeOcReplaceModal();
  } catch (err) {
    console.error("submitReplaceItemRequest error:", err);
    showToast(t("notify.error", "Xatolik yuz berdi"), "error");
  }
};

window.clearWaiterCart = async function () {
  const rows = Object.entries(cart);
  if (rows.length === 0) {
    showToast(t("nothing_to_clear", "Savat bo'sh"), "info");
    return;
  }

  const hasSent = rows.some(([, c]) => c.sent);
  const confirmMsg = hasSent
    ? t("confirm_clear_cart_full", "Butun ro'yxat, jumladan oshxonaga yuborilgan taomlar ham o'chirilsinmi?")
    : t("confirm_clear_cart", "Yangi qo'shilgan taomlar o'chirilsinmi?");
  if (!confirm(confirmMsg)) return;

  try {
    if (hasSent && activeOrderId) {
      const now = Date.now();
      const staffName = window.currentStaffRealName || sessionStorage.getItem("name") || t("role_waiter", "Ofitsiant");
      const updates = {};
      rows.forEach(([key, c]) => {
        if (c.sent) updates[`${BASE_PATH}/orders/${activeOrderId}/items/${key}`] = null;
      });
      updates[`${BASE_PATH}/orders/${activeOrderId}/total`]         = 0;
      updates[`${BASE_PATH}/orders/${activeOrderId}/originalTotal`] = 0;
      updates[`${BASE_PATH}/orders/${activeOrderId}/updatedAt`]     = now;
      updates[`${BASE_PATH}/orders/${activeOrderId}/lastUpdatedBy`] = staffName;

      await update(ref(db), updates);

      await writeOrderAuditLog(db, BASE_PATH, {
        actorId: waiterId,
        actorName: staffName,
        actorRole: "waiter",
        action: "order_items_cleared",
        orderId: activeOrderId,
        table: activeTableNumber,
        description: `🗑️ Buyurtma ro'yxati to'liq tozalandi — Stol ${activeTableNumber}`
      });
    }

    cart = {};
    renderMenuItems();
    renderCart();
    renderOrderHistory();
  } catch (err) {
    console.error("clearWaiterCart error:", err);
    showToast(t("notify.error", "Xatolik yuz berdi"), "error");
  }
};

function cartTotal() {
  return Object.values(cart).reduce((s, c) => s + Number(c.price || 0) * Number(c.qty || 0), 0);
}

/**
 * 🆕 Sozlamalardagi "Avtomatik skidka" ni berilgan summaga nisbatan hisoblaydi.
 * Agar yoqilgan bo'lsa va summa autoDiscount.minAmount dan katta yoki teng bo'lsa,
 * { percent, amount } qaytaradi, aks holda { percent: 0, amount: 0 }.
 */
function computeAutoDiscount(baseAmount) {
  const cfg = waiterAutoDiscount || {};
  if (!cfg.enabled || !(cfg.pct > 0)) return { percent: 0, amount: 0 };
  if (cfg.minAmount > 0 && baseAmount < cfg.minAmount) return { percent: 0, amount: 0 };
  const amount = Math.round(baseAmount * cfg.pct / 100);
  return { percent: cfg.pct, amount };
}

// ══════════════════════════════════════════
// 11a. TAOM IZOHI — IKONLI TEGLAR + "O'ZI YOZSIN"
// ══════════════════════════════════════════
const NOTE_TAGS = [
  { key: "tuzsiz",     icon: "🧂", label: () => t("note_tag_tuzsiz",     "Tuzsiz") },
  { key: "kamtuzli",   icon: "🧂", label: () => t("note_tag_kamtuzli",   "Kam tuzli") },
  { key: "achchiqsiz", icon: "🌶️", label: () => t("note_tag_achchiqsiz", "Achchiqsiz") },
  { key: "achchiq",    icon: "🌶️", label: () => t("note_tag_achchiq",    "Achchiq") },
  { key: "piyozsiz",   icon: "🧅", label: () => t("note_tag_piyozsiz",   "Piyozsiz") },
  { key: "kokatsiz",   icon: "🌿", label: () => t("note_tag_kokatsiz",   "Ko'katsiz") },
  { key: "yogsiz",     icon: "🫗", label: () => t("note_tag_yogsiz",     "Yog'siz") },
  { key: "vegetarian", icon: "🥗", label: () => t("note_tag_vegetarian", "Vegetarian") }
];

/**
 * cart[key].note ni tanlangan teglar (vergul bilan ajratilgan matn) +
 * ixtiyoriy erkin ("o'zi yozsin") matn ko'rinishida ushlab turadi.
 */
function parseNoteTags(note) {
  const raw = String(note || "");
  const tagLabels = NOTE_TAGS.map(n => n.label());
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  const active = new Set(parts.filter(p => tagLabels.includes(p)));
  const customParts = parts.filter(p => !tagLabels.includes(p));
  return { active, custom: customParts.join(", ") };
}

/** Buyurtma ro'yxatida (savat va tarix) taom ostidagi eski "📝 note-text"
 *  bitta-yumaloq matnini "⚠ Allergiya: ... 💬 Izoh: ..." ikkita ixcham,
 *  yonma-yon chipga aylantiradi. Hech qanday YANGI ma'lumot/maydon
 *  yaratilmaydi — mavjud parseNoteTags() (yuqorida, NOTE_TAGS asosida
 *  qurilgan) allaqachon combined `note` stringini "tanlangan teglar"
 *  (Tuzsiz/Achchiqsiz/... — allergiya/parhez turidagi belgilar) va "erkin
 *  matn" (izoh) ga ajratib beradi; bu yerda faqat SHU natija ikkita
 *  chip sifatida chiziladi. Ikkalasi ham bo'sh bo'lsa — bo'sh qator/chip
 *  chiqarilmaydi ("" qaytadi). */
function renderItemNoteChips(note) {
  if (!note) return "";
  const { active, custom } = parseNoteTags(note);
  const allergyText = [...active].join(", ");
  if (!allergyText && !custom) return "";

  const allergyChip = allergyText
    ? `<span class="item-note-chip chip-allergy" title="${escapeHtml(allergyText)}">
         <span class="chip-icon">⚠</span>
         <span class="chip-label">${escapeHtml(t("allergy_note", "Allergiya:"))}</span>
         <span class="chip-text">${escapeHtml(allergyText)}</span>
       </span>`
    : "";
  const commentChip = custom
    ? `<span class="item-note-chip chip-comment" title="${escapeHtml(custom)}">
         <span class="chip-icon">💬</span>
         <span class="chip-label">${escapeHtml(t("item_note_label", "Izoh:"))}</span>
         <span class="chip-text">${escapeHtml(custom)}</span>
       </span>`
    : "";

  return `<div class="item-note-chips">${allergyChip}${commentChip}</div>`;
}

function rebuildNote(cartKey) {
  const c = cart[cartKey];
  if (!c) return;
  const active = c.noteActiveTags instanceof Set ? c.noteActiveTags : new Set();
  const chosen = NOTE_TAGS.filter(n => active.has(n.key)).map(n => n.label());
  const custom = String(c.noteCustomText || "").trim();
  c.note = [...chosen, ...(custom ? [custom] : [])].join(", ");
}

window.toggleCartNoteTag = function (cartKey, tagKey) {
  const c = cart[cartKey];
  if (!c || c.sent) return;
  if (!(c.noteActiveTags instanceof Set)) c.noteActiveTags = new Set();
  if (c.noteActiveTags.has(tagKey)) c.noteActiveTags.delete(tagKey);
  else c.noteActiveTags.add(tagKey);
  rebuildNote(cartKey);
  renderCart();
};

window.toggleCartNoteCustom = function (cartKey) {
  const c = cart[cartKey];
  if (!c || c.sent) return;
  c.noteCustomOpen = !c.noteCustomOpen;
  if (!c.noteCustomOpen) {
    c.noteCustomText = "";
    rebuildNote(cartKey);
  }
  renderCart();
};

window.setCartNoteCustomText = function (cartKey, val) {
  const c = cart[cartKey];
  if (!c || c.sent) return;
  c.noteCustomText = String(val || "").slice(0, 200);
  rebuildNote(cartKey);
};

window.toggleCartNotePanel = function (cartKey) {
  const c = cart[cartKey];
  if (!c || c.sent) return;
  c.notePanelOpen = !c.notePanelOpen;
  renderCart();
};

function renderNoteTags(cartKey, c) {
  if (!(c.noteActiveTags instanceof Set)) {
    const parsed = parseNoteTags(c.note);
    c.noteActiveTags = new Set(NOTE_TAGS.filter(n => parsed.active.has(n.label())).map(n => n.key));
    if (parsed.custom) {
      c.noteCustomText = parsed.custom;
      c.noteCustomOpen = true;
    }
  }
  const active = c.noteActiveTags;
  const isOpen = !!c.notePanelOpen;

  const activeCount = active.size + (String(c.noteCustomText || "").trim() ? 1 : 0);
  const toggleLabel = t("note_panel_toggle", "Allergiya / Izoh");
  const toggleBtn = `
    <button type="button" class="cr-note-toggle" onclick="window.toggleCartNotePanel('${cartKey}')">
      <span class="cr-note-toggle-arrow ${isOpen ? "open" : ""}">▼</span>
      ${escapeHtml(toggleLabel)}${activeCount ? ` (${activeCount})` : ""}
    </button>`;

  if (!isOpen) {
    return toggleBtn;
  }

  const tagsHtml = NOTE_TAGS.map(n => {
    const isActive = active.has(n.key);
    return `
      <button type="button" class="cr-tag ${isActive ? "active" : ""}"
              onclick="window.toggleCartNoteTag('${cartKey}', '${n.key}')">
        <span class="cr-tag-icon">${n.icon}</span>${escapeHtml(n.label())}
        ${isActive ? `<span class="cr-tag-check">✓</span>` : ""}
      </button>`;
  }).join("");

  const customActive = !!c.noteCustomOpen;
  const customBtn = `
    <button type="button" class="cr-tag cr-tag-custom ${customActive ? "active" : ""}"
            onclick="window.toggleCartNoteCustom('${cartKey}')">
      <span class="cr-tag-icon">✏️</span>${escapeHtml(t("note_tag_custom", "O'zi yozsin"))}
      ${customActive ? `<span class="cr-tag-check">✓</span>` : ""}
    </button>`;

  const customInput = customActive
    ? `<input type="text" class="cr-note" style="margin-top:6px;" value="${escapeHtml(c.noteCustomText || "")}"
              placeholder="${t("item_note_placeholder", "Izoh (masalan: achchiq emas)")}"
              oninput="window.setCartNoteCustomText('${cartKey}', this.value)">`
    : "";

  return `${toggleBtn}<div class="cr-tags" style="margin-top:6px;">${tagsHtml}${customBtn}</div>${customInput}`;
}

function renderCart() {
  const box = document.getElementById("cartList");
  const totalEl = document.getElementById("cartTotal");
  if (!box) return;

  const rows = Object.entries(cart);

  if (rows.length === 0) {
    box.innerHTML = `<p class="empty-state">${t("cart_empty_hint", "Savat bo'sh. Menyudan taom tanlang.")}</p>`;
  } else {
    box.innerHTML = rows.map(([key, c]) => {
      const m    = menuCache[c.menuId] || {};
      const name = localName(c.name, m.name ? localName(m.name) : "—");
      const sum  = Number(c.price || 0) * Number(c.qty || 0);
      const unit = c.isWeightBased ? " kg" : "";

      // 🆕 Rasm, kategoriya va subkategoriya (agar mavjud bo'lsa)
      const imgSrc = m.imgUrl || m.img || m.image || "";
      const catLbl = categoryName(m.category);
      const subLbl = categoryName(m.subCategory || m.subcategory) || localName(m.subCategoryName, "");
      const catLine = [catLbl, subLbl].filter(Boolean).join(" › ");

      const qtyControls = c.sent
        ? `<span class="qty-val">${c.qty}${unit}</span>`
        : `<div class="cr-qty">
             <button class="qty-btn qty-minus" onclick="window.changeCartRowQty('${key}', ${c.isWeightBased ? -0.1 : -1})">−</button>
             <span class="qty-val">${c.qty}${unit}</span>
             <button class="qty-btn qty-plus"  onclick="window.changeCartRowQty('${key}', ${c.isWeightBased ? 0.1 : 1})">+</button>
           </div>`;

      const unitPriceLbl = `${money(c.price)} ${t("currency", "so'm")}${unit ? " / kg" : ""}`;
      const calcLine = `<span class="cr-calc">${c.qty}${unit} × ${unitPriceLbl} = <b>${money(sum)} ${t("currency", "so'm")}</b></span>`;

      // 🆕 Yuborilgan (sent) qatorni ofitsiant ENDI to'g'ridan-to'g'ri
      // o'chira olmaydi — Admin/Kassir tasdig'i shart (item 4/27). Shu
      // qator uchun hali hal qilinmagan so'rov bo'lsa — faqat "⏳ kutilmoqda"
      // ko'rsatiladi (qayta so'rov yuborishning oldini olish, item 12/21);
      // aks holda "Bekor qilish so'rovi" / "Almashtirish so'rovi" tugmalari.
      // Yuborilmagan (hali savatdagi, hali Firebase'ga yozilmagan) qatorda
      // eski to'g'ridan-to'g'ri ✕ o'chirish xatti-harakati o'zgarishsiz qoladi.
      const pendingReq = c.sent ? _pendingRequestForItemKey(key) : null;
      const rightActions = !c.sent
        ? `<button class="cr-remove-btn" onclick="window.removeCartRow('${key}')" title="${t("remove_item_btn", "O'chirish")}">✕</button>`
        : pendingReq
          ? `<span class="oc-pending-chip" title="${escapeHtml(pendingReq.requestType === "cancel_item"
                ? t("oc_pending_cancel_badge", "⏳ {qty} porsiya bekor qilish so'rovi").replace("{qty}", pendingReq.requestedCancelQty ?? "")
                : t("oc_pending_approval_badge", "⏳ O'zgarish tasdiqlanishi kutilmoqda"))}">⏳</span>`
          : `<span class="oc-item-actions">
               <button class="oc-action-btn oc-cancel-btn" onclick="window.openCancelItemRequestModal('${key}')" title="${t("oc_request_cancel_btn", "Bekor qilish so'rovi")}">🚫</button>
               <button class="oc-action-btn oc-replace-btn" onclick="window.openReplaceItemRequestModal('${key}')" title="${t("oc_request_replace_btn", "Almashtirish so'rovi")}">🔀</button>
             </span>`;

      return `
        <div class="cart-row">
          ${imgSrc
            ? `<img class="cr-thumb" src="${escapeHtml(imgSrc)}" alt="" onerror="this.style.display='none'">`
            : `<div class="cr-thumb cr-thumb-empty">🍽️</div>`}
          <div class="cr-main">
            <p class="cr-name">
              ${escapeHtml(name)}
              ${c.sent ? `<span class="cart-sent-badge">${t("sent_badge", "Yuborilgan")}</span>` : ""}
            </p>
            ${catLine ? `<p class="cr-cat">${escapeHtml(catLine)}</p>` : ""}
            ${c.variantName ? `<span class="cr-variant">🔀 ${escapeHtml(localName(c.variantName, String(c.variantName)))}</span>` : ""}
            <p class="cr-price">${unitPriceLbl}</p>
            ${c.sent
              ? renderItemNoteChips(c.note)
              : renderNoteTags(key, c)}
          </div>
          <div class="cr-right">
            ${rightActions}
            ${qtyControls}
            ${calcLine}
          </div>
        </div>`;
    }).join("");
  }

  const finalTotal = renderCartSummary();
  if (totalEl) totalEl.textContent = money(finalTotal);

  // Tugmani holatga moslash
  const btnSend = document.getElementById("btnSendKitchen");
  const hasNew  = Object.values(cart).some(c => !c.sent && Number(c.qty) > 0);

  if (btnSend) {
    const label = btnSend.querySelector("span");
    if (activeOrderId) {
      if (label) label.textContent = t("update_order_btn", "Buyurtma qo'sh");
      btnSend.disabled = !hasNew;
    } else {
      if (label) label.textContent = t("confirm_order_btn", "Tasdiqlash");
      btnSend.disabled = !hasNew;
    }
  }

  renderPayButton();
  renderKassaButton();
}

/**
 * Xizmat haqi (%) va chegirma qatorlarini ko'rsatadi — FAQAT ko'rsatish uchun.
 * Xizmat haqi: restoran sozlamalaridan (settings/serviceFee, admin/kassa belgilaydi).
 * Chegirma: ochiq buyurtmada promo/loyalty orqali qo'llanilgan bo'lsa (order.discountPercent/discountAmount).
 * Ofitsiant bu yerdan hech narsani o'zgartira olmaydi.
 */
/**
 * "To'lov" tugmasini ko'rsatish/yashirish.
 * Faqat: ochiq buyurtma bor, hali to'lanmagan, va savatda yangi
 * (hali oshxonaga yuborilmagan) taom yo'q bo'lsa ko'rinadi —
 * shunda kassaga yuborilgan summa bilan savatdagi summa mos keladi.
 * To'langan buyurtmada esa chek menyusi (qayta chop etish/yuklab olish/ko'rish) ko'rinadi.
 */
function renderPayButton() {
  const btn = document.getElementById("btnPay");
  const receiptBtn = document.getElementById("btnReceiptMenu");
  if (!btn) return;

  const order = activeOrderId ? (ordersCache[activeOrderId] || {}) : null;
  const alreadyPaid = !!order && (order.status === "to'landi" || order.status === "paid" || order?.payment?.paid === true);
  const hasNew = Object.values(cart).some(c => !c.sent && Number(c.qty) > 0);

  // Admin panelida "To'lovni kim qabul qiladi?" — agar "Kassir" tanlangan
  // bo'lsa (yoki hali belgilanmagan bo'lsa, admin.js'ning o'zi ham shu
  // defaultni ishlatadi), ofitsiant to'lov oynasini ochmaydi — faqat kassir.
  const paymentAcceptor = restaurantSettings?.paymentAcceptor || "kassir";
  const waiterCanAcceptPayment = paymentAcceptor === "waiter";

  const canPay = !!activeOrderId && !alreadyPaid && !hasNew && waiterCanAcceptPayment;
  btn.style.display = canPay ? "flex" : "none";

  if (receiptBtn) {
    const hasReceipt = alreadyPaid || !!window.__lastWaiterReceipt;
    receiptBtn.style.display = hasReceipt ? "flex" : "none";
    if (!hasReceipt) window.closeReceiptMenu?.();
  }
}

/**
 * 🆕 STOL XIZMAT NARXI — canonical hisoblash (bitta manba, cart summary/
 * order create/order update — barchasi shu funksiyani chaqiradi, hech
 * qayerda takror yozilmaydi). Admin restaurants/{restId}/tables/{key}/
 * tableServiceAmount (aniq summa, foiz emas) — mavjud restoran-darajasidagi
 * serviceFeePercent bilan chalkashtirilmaydi, ikkalasi mustaqil qo'shiladi.
 * Ochiq buyurtmada allaqachon tableServiceAmount YOZILGAN bo'lsa (0 ham —
 * explicit qiymat, undefined/null bilan farqlanadi) O'SHA qaytariladi —
 * stol narxi keyinroq o'zgarsa ham eski buyurtma qayta hisoblanmaydi
 * (biznes qoidasi). Yangi (hali Firebase'ga yozilmagan) buyurtmada joriy
 * stolning HOZIRGI narxi olinadi.
 */
function computeTableServiceAmount() {
  const open = activeOrderId ? ordersCache[activeOrderId] : null;
  if (open && open.tableServiceAmount !== undefined && open.tableServiceAmount !== null) {
    return Math.max(0, Number(open.tableServiceAmount) || 0);
  }
  const tbl = tablesCache[activeTableKey];
  return Math.max(0, Number(tbl?.tableServiceAmount || 0)) || 0;
}

/**
 * Jami summa, xizmat haqi (%) va chegirma qatorlarini ko'rsatadi — FAQAT ko'rsatish uchun.
 * Xizmat haqi: restoran sozlamalaridan (settings/serviceFee, admin/kassa belgilaydi).
 * Chegirma: ochiq buyurtmada promo/loyalty orqali qo'llanilgan bo'lsa (order.discountPercent/discountAmount).
 * Stol xizmati: computeTableServiceAmount() — alohida, foizga aylantirilmaydi.
 * Ofitsiant bu yerdan hech narsani o'zgartira olmaydi.
 * Qaytaradi: yakuniy to'lanadigan summa (Итого) — jami - chegirma + xizmat haqi + stol xizmati.
 */
function renderCartSummary() {
  const box = document.getElementById("cartSummary");
  const base = cartTotal();
  const open = activeOrderId ? (ordersCache[activeOrderId] || {}) : {};

  let discountAmount  = Number(open.discountAmount || 0);
  let discountPercent = Number(open.discountPercent || 0);
  let discountBreakdown = open.discountBreakdown || null;

  // 🐛 ROOT CAUSE FIX — "customer discount cart preview'da ko'rinmayapti":
  // agar buyurtmada hali chegirma yozilmagan bo'lsa (masalan order hali
  // umuman yaratilmagan — fresh stol), mijozning individual chegirmasini
  // ham (agar telefon allaqachon ma'lum va _lookupCustomerDiscount() orqali
  // keshlangan bo'lsa — bu funksiya SINXRON, yangi Firebase so'rovi
  // bermaydi) sozlamalardagi avtomatik chegirma bilan QO'SHIB ko'rsatamiz —
  // 🆕 biznes qoidasi o'zgardi (avval MAX() edi): computeCustomerAwareDiscount()
  // bilan bir xil additive qoida, faqat bu yerda oldindan keshlangan
  // qiymatdan foydalanadi (yangi Firebase so'rovi yo'q).
  if (discountAmount === 0) {
    const knownPhone = open.customerPhone || open.clientPhone || tablesCache[activeTableKey]?.customerPhone || "";
    const normalizedKnownPhone = normalizePhone(knownPhone);
    const cachedCustomerPct = normalizedKnownPhone
      ? Number(_custDiscountLookupCache[normalizedKnownPhone]?.pct || 0)
      : 0;

    const auto = computeAutoDiscount(base);
    discountPercent = Math.min(100, cachedCustomerPct + auto.percent);
    discountAmount = Math.round(base * discountPercent / 100);
    discountBreakdown = (cachedCustomerPct > 0 && auto.percent > 0)
      ? { customer: cachedCustomerPct, auto: auto.percent, total: discountPercent }
      : null;
  }

  const svcPct     = waiterServiceFeePct;
  const svcMinOrd  = waiterServiceFeeMinOrd;
  const svcApplies = svcPct > 0 && (svcMinOrd === 0 || base >= svcMinOrd);
  const svcAmount  = svcApplies ? Math.round(base * svcPct / 100) : 0;

  // 🆕 STOL XIZMAT NARXI — restoran-darajasidagi serviceFeePercent (%)dan
  // BUTUNLAY MUSTAQIL, aniq stolga biriktirilgan FIKSIRLANGAN summa
  // (foiz emas). Ochiq buyurtmada allaqachon tableServiceAmount saqlangan
  // bo'lsa (0 ham hisobga olinadi — explicit qiymat) O'SHA ishlatiladi
  // (immutable — stol narxi keyin o'zgarsa ham eski buyurtma o'zgarmaydi);
  // yangi (hali yaratilmagan) buyurtmada joriy stolning narxi olinadi.
  const tableServiceAmount = computeTableServiceAmount();

  const finalTotal = Math.max(0, base - discountAmount + svcAmount + tableServiceAmount);

  if (box) {
    const rowsHtml = [];

    rowsHtml.push(`
      <div class="cs-row cs-subtotal">
        <span class="cs-label">${t("subtotal_label", "Podytog")}</span>
        <span class="cs-value">${money(base)} ${t("currency", "so'm")}</span>
      </div>`);

    if (svcApplies) {
      rowsHtml.push(`
        <div class="cs-row cs-service">
          <span class="cs-label">🧾 ${t("obsluga_title", "Obsluga")} (${svcPct}%)</span>
          <span class="cs-value">${money(svcAmount)} ${t("currency", "so'm")}</span>
        </div>`);
    }

    // 🆕 Stol xizmat narxi — faqat >0 bo'lsa ko'rsatiladi (0 = umuman
    // chiqmaydi, restoran-darajasidagi Obsluga (%) qatoridan alohida).
    if (tableServiceAmount > 0) {
      rowsHtml.push(`
        <div class="cs-row cs-table-service">
          <span class="cs-label">🏷 ${t("table_service_row_label", "Stol xizmati")}</span>
          <span class="cs-value">+${money(tableServiceAmount)} ${t("currency", "so'm")}</span>
        </div>`);
    }

    // 🆕 Individual + avtomatik chegirma qo'shilganda (spec §9: "faqat bitta
    // Chegirma 8% deb yashirib qo'yma") — ikkalasini alohida qatorda, keyin
    // jamisini ko'rsatamiz. Faqat bitta manba bo'lsa — eski bitta qatorli ko'rinish.
    if (discountBreakdown && discountBreakdown.customer > 0 && discountBreakdown.auto > 0) {
      const custAmt = Math.round(base * discountBreakdown.customer / 100);
      const autoAmt = Math.round(base * discountBreakdown.auto / 100);
      rowsHtml.push(`
        <div class="cs-row cs-discount">
          <span class="cs-label">🏷 ${t("customer_discount_row_label", "Mijoz chegirmasi")} (${discountBreakdown.customer}%)</span>
          <span class="cs-value">−${money(custAmt)} ${t("currency", "so'm")}</span>
        </div>
        <div class="cs-row cs-discount">
          <span class="cs-label">🏷 ${t("auto_discount_row_label", "Avtomatik chegirma")} (${discountBreakdown.auto}%)</span>
          <span class="cs-value">−${money(autoAmt)} ${t("currency", "so'm")}</span>
        </div>
        <div class="cs-row cs-discount" style="font-weight:800;">
          <span class="cs-label">${t("total_discount_row_label", "Jami chegirma")} (${discountBreakdown.total}%)</span>
          <span class="cs-value">−${money(discountAmount)} ${t("currency", "so'm")}</span>
        </div>`);
    } else if (discountAmount > 0) {
      rowsHtml.push(`
        <div class="cs-row cs-discount">
          <span class="cs-label">🏷 ${t("discount_label", "Chegirma")}${discountPercent ? ` (${discountPercent}%)` : ""}</span>
          <span class="cs-value">−${money(discountAmount)} ${t("currency", "so'm")}</span>
        </div>`);
    }

    box.innerHTML = rowsHtml.join("") + `<div class="cs-divider"></div>`;
  }

  return finalTotal;
}

window.setWaiterPayMethod = function (method) {
  payMethod = method;
  document.querySelectorAll(".pay-opt").forEach(el => {
    el.classList.toggle("active", el.dataset.pay === method);
  });
};

// ══════════════════════════════════════════
// 12. BUYURTMANI OSHXONAGA YUBORISH
// ══════════════════════════════════════════
function buildItemsPayload(onlyNew = true) {
  const items = {};
  const now = Date.now();
  const staffName = window.currentStaffRealName || sessionStorage.getItem("name") || t("role_waiter", "Ofitsiant");

  Object.entries(cart).forEach(([key, c]) => {
    if (onlyNew && c.sent) return;
    const qty = Number(c.qty || 0);
    if (qty <= 0) return;

    const m = menuCache[c.menuId] || {};
    const baseName = (typeof c.name === "object") ? c.name
      : (typeof m.name === "object" ? m.name
        : { uz: String(c.name || m.name || "Noma'lum"), ru: String(c.name || m.name || "Noma'lum"), en: String(c.name || m.name || "Unknown") });

    items[key] = {
      id: c.menuId,
      name: baseName,
      price: Number(c.price || 0),
      qty,
      note: c.note || "",
      isWeightBased: c.isWeightBased === true,
      variantKey: c.variantKey || null,
      variantName: c.variantName || null,
      category: m.category || "",
      imgUrl: m.imgUrl || m.img || m.image || "",
      status: "pending",
      // 🆕 Tarix uchun
      addedBy: staffName,
      addedById: waiterId,
      addedAt: now
    };
  });

  return items;
}

window.sendOrderToKitchen = async function () {
  if (activeOrderId) {
    return window.updateExistingOrder();
  }
  try {
    if (!activeTableNumber) {
      showToast(t("select_table_first", "Avval stol tanlang!"), "error");
      return;
    }

    const items = buildItemsPayload(true);
    if (Object.keys(items).length === 0) {
      showToast(t("cart_empty", "Savat bo'sh!"), "error");
      return;
    }

    const total = Object.values(items).reduce((s, i) => s + i.price * i.qty, 0);

    // 🆕 Minimal buyurtma summasi tekshiruvi (Sozlamalar → Minimal buyurtma summasi)
    if (waiterMinOrderAmount > 0 && total < waiterMinOrderAmount) {
      showToast(
        `${t("min_order_not_reached", "Minimal buyurtma summasiga yetmadi")}: ${money(total)} / ${money(waiterMinOrderAmount)} ${t("currency", "so'm")}`,
        "error"
      );
      return;
    }

    const btn = document.getElementById("btnSendKitchen");
    if (btn) btn.disabled = true;

    const newOrderRef = push(ref(db, `${BASE_PATH}/orders`));
    const newOrderId  = newOrderRef.key;

    const counterRes  = await runTransaction(ref(db, `${BASE_PATH}/meta/orderCounterOrd`), n => (n || 0) + 1);
    const orderNumber = counterRes.snapshot.val();

    const now = Date.now();
    const staffName = window.currentStaffRealName || sessionStorage.getItem("name") || t("role_waiter", "Ofitsiant");

    const tableKey = getTableKey(activeTableNumber);

    // 🆕 Mijoz individual chegirmasi (agar stolda telefon allaqachon ma'lum
    // bo'lsa — editClientPhone() hali order yo'q paytida ham telefonni
    // tables/{tableKey}/customerPhone'ga yozadi, bu order yaratilishidan OLDIN
    // mavjud bo'ladigan yagona telefon manbai) + Avtomatik skidka (Sozlamalar
    // → Avtomatik skidka) — computeCustomerAwareDiscount() ikkalasini
    // QO'SHADI (biznes qoidasi o'zgardi — avval MAX() edi), client.js'dagi
    // calculateDiscount() bilan bir xil additive qoida. Telefon noma'lum
    // bo'lsa — customer qismi shunchaki 0 bo'lib, avvalgi xatti-harakat
    // (faqat auto-discount) o'zgarishsiz saqlanadi.
    const knownPhone = tablesCache[tableKey]?.customerPhone || "";
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      console.info("[DISCOUNT-TRACE] phone before order:", knownPhone);
      console.info("[DISCOUNT-TRACE] table cache phone:", tablesCache?.[tableKey]?.customerPhone);
    }
    const discountInfo = await computeCustomerAwareDiscount(knownPhone, total);
    const normalizedKnownPhone = normalizePhone(knownPhone);

    const orderPayload = {
      orderNumber,
      table: activeTableNumber,
      items,
      total,
      originalTotal: total,
      discount: discountInfo.amount,
      discountAmount: discountInfo.amount,
      discountPercent: discountInfo.percent,
      discountApplied: discountInfo.amount > 0,
      discountSource: discountInfo.source,
      ...(discountInfo.reason ? { discountReason: discountInfo.reason } : {}),
      ...(discountInfo.claimId ? { discountClaimId: discountInfo.claimId } : {}),
      ...(discountInfo.breakdown ? { discountBreakdown: discountInfo.breakdown } : {}),
      ...(normalizedKnownPhone ? { customerPhone: normalizedKnownPhone } : {}),
      // 🆕 STOL XIZMAT NARXI — order yaratilish paytidagi stolning HOZIRGI
      // narxi bilan "muzlatiladi" (immutable — biznes qoidasi: admin keyin
      // narxni o'zgartirsa, bu order o'zgarmaydi). restaurants/{restId}/
      // tables/{tableKey}/tableServiceAmount — canonical manba (DOM/nomdan
      // ajratib olinmaydi).
      tableServiceAmount: Math.max(0, Number(tablesCache[tableKey]?.tableServiceAmount || 0)) || 0,
      clientId: "waiter_" + waiterId,
      createdAt: now,
      status:      ORDER_STATUS_V2.ORDER_CREATED.key,
      statusKey:   ORDER_STATUS_V2.ORDER_CREATED.key,
      statusLabel: ORDER_STATUS_V2.ORDER_CREATED.labelUz,
      statusHistory: { [ORDER_STATUS_V2.ORDER_CREATED.key]: now },
      waiterId,
      createdByWaiter: true,
      createdByWaiterId: waiterId,
      createdByWaiterName: staffName,
      paymentMethod: "pending",
      payment: { requested: false, paid: false }
    };

    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      console.info("[DISCOUNT-TRACE] ORDER BEFORE SAVE", {
        customerPhone: orderPayload.customerPhone || null,
        originalTotal: orderPayload.originalTotal,
        discountPercent: orderPayload.discountPercent,
        discountAmount: orderPayload.discountAmount,
        discountSource: orderPayload.discountSource,
        total: orderPayload.total
      });
    }

    const updates = {};
    updates[`${BASE_PATH}/orders/${newOrderId}`]            = orderPayload;
    updates[`${BASE_PATH}/tables/${tableKey}/status`]       = "occupied";
    updates[`${BASE_PATH}/tables/${tableKey}/busy`]         = true;
    updates[`${BASE_PATH}/tables/${tableKey}/orderId`]      = newOrderId;
    updates[`${BASE_PATH}/tables/${tableKey}/occupiedAt`]   = now;

    await update(ref(db), updates);

    await writeOrderAuditLog(db, BASE_PATH, {
      actorId: waiterId,
      actorName: staffName,
      actorRole: "waiter",
      action: "order_created",
      fromStatus: ORDER_STATUS_V2.WAITER.key,
      toStatus: ORDER_STATUS_V2.ORDER_CREATED.key,
      orderId: newOrderId,
      table: activeTableNumber,
      description: `🧾 Buyurtma yaratildi — Stol ${activeTableNumber} (${formatOrderNumber(orderNumber, false) || "№" + orderNumber})`
    });

    activeOrderId = newOrderId;
    Object.keys(cart).forEach(k => { if (!cart[k].sent) cart[k].sent = true; });

    showToast(`✅ ${t("order_sent_kitchen", "Buyurtma oshxonaga yuborildi")} — ${formatOrderNumber(orderNumber, false) || "№" + orderNumber}`, "success");
    renderCart();
    renderOrderHistory();

  } catch (err) {
    console.error("sendOrderToKitchen error:", err);
    showToast(t("notify.error", "Xatolik yuz berdi!"), "error");
  } finally {
    const btn = document.getElementById("btnSendKitchen");
    if (btn) btn.disabled = false;
  }
};

window.updateExistingOrder = async function () {
  try {
    if (!activeOrderId) {
      showToast(t("no_active_order", "Ochiq buyurtma yo'q"), "error");
      return;
    }

    const newItems = buildItemsPayload(true);
    if (Object.keys(newItems).length === 0) {
      showToast(t("nothing_to_add", "Qo'shiladigan yangi taom yo'q"), "info");
      return;
    }

    const btn = document.getElementById("btnSendKitchen");
    if (btn) btn.disabled = true;

    const order = ordersCache[activeOrderId] || {};
    const addedTotal = Object.values(newItems).reduce((s, i) => s + i.price * i.qty, 0);
    const newTotal   = Number(order.total || 0) + addedTotal;
    const now = Date.now();
    const staffName = window.currentStaffRealName || sessionStorage.getItem("name") || t("role_waiter", "Ofitsiant");

    const updates = {};
    Object.entries(newItems).forEach(([key, item]) => {
      updates[`${BASE_PATH}/orders/${activeOrderId}/items/${key}`] = item;
    });
    updates[`${BASE_PATH}/orders/${activeOrderId}/total`]         = newTotal;
    updates[`${BASE_PATH}/orders/${activeOrderId}/originalTotal`] = newTotal;
    updates[`${BASE_PATH}/orders/${activeOrderId}/updatedAt`]     = now;
    updates[`${BASE_PATH}/orders/${activeOrderId}/lastUpdatedBy`] = staffName;

    // 🆕 Chegirmani (customer individual % + auto-discount, MAX qoidasi) faqat
    // oldin qo'lda/boshqa manbadan kelgan chegirma qo'yilmagan bo'lsa qayta
    // hisoblaymiz — "auto"/"customer_phone_match" ikkalasi ham shu funksiyaning
    // o'zi boshqaradigan manbalar, shuning uchun savatga taom qo'shilib summa
    // o'zgarganda (yoki shu oraliqda mijoz telefoni editClientPhone() orqali
    // almashtirilgan bo'lsa) ular xavfsiz qayta hisoblanadi. Boshqa har qanday
    // (kelajakda qo'shilishi mumkin) manba — tegilmaydi.
    if (!order.discountSource || order.discountSource === "auto" || order.discountSource === "customer_phone_match" || order.discountSource === "combined" || order.discountSource === "qr_one_time") {
      const phoneForRecalc = order.customerPhone || order.clientPhone || tablesCache[getTableKey(activeTableNumber)]?.customerPhone || "";
      const discountInfo = await computeCustomerAwareDiscount(phoneForRecalc, newTotal);
      updates[`${BASE_PATH}/orders/${activeOrderId}/discount`]         = discountInfo.amount;
      updates[`${BASE_PATH}/orders/${activeOrderId}/discountAmount`]   = discountInfo.amount;
      updates[`${BASE_PATH}/orders/${activeOrderId}/discountPercent`]  = discountInfo.percent;
      updates[`${BASE_PATH}/orders/${activeOrderId}/discountApplied`]  = discountInfo.amount > 0;
      updates[`${BASE_PATH}/orders/${activeOrderId}/discountSource`]   = discountInfo.source;
      updates[`${BASE_PATH}/orders/${activeOrderId}/discountClaimId`]  = discountInfo.claimId || null;
      updates[`${BASE_PATH}/orders/${activeOrderId}/discountBreakdown`] = discountInfo.breakdown || null;
      if (discountInfo.reason) updates[`${BASE_PATH}/orders/${activeOrderId}/discountReason`] = discountInfo.reason;
    }

    // Buyurtma yangilangani uchun statusni "qabul qilindi" ga qaytaramiz
    updates[`${BASE_PATH}/orders/${activeOrderId}/status`]      = ORDER_STATUS_V2.ORDER_CREATED.key;
    updates[`${BASE_PATH}/orders/${activeOrderId}/statusKey`]   = ORDER_STATUS_V2.ORDER_CREATED.key;
    updates[`${BASE_PATH}/orders/${activeOrderId}/statusLabel`] = ORDER_STATUS_V2.ORDER_CREATED.labelUz;

    await update(ref(db), updates);

    await writeOrderAuditLog(db, BASE_PATH, {
      actorId: waiterId,
      actorName: staffName,
      actorRole: "waiter",
      action: "order_items_added",
      orderId: activeOrderId,
      table: activeTableNumber,
      description: `➕ ${Object.keys(newItems).length} ta taom qo'shildi — Stol ${activeTableNumber}`
    });

    Object.keys(cart).forEach(k => { if (!cart[k].sent) cart[k].sent = true; });

    showToast(t("order_updated_success", "Buyurtmaga taom qo'shildi"), "success");
    renderCart();
    renderOrderHistory();

  } catch (err) {
    console.error("updateExistingOrder error:", err);
    showToast(t("notify.error", "Xatolik yuz berdi!"), "error");
  } finally {
    const btn = document.getElementById("btnSendKitchen");
    if (btn) btn.disabled = false;
  }
};

// ══════════════════════════════════════════
// 12b. KASSAGA HISOB SO'ROVI YUBORISH
// ══════════════════════════════════════════

/** Ochiq buyurtmada hisob allaqachon so'ralganmi — kassa.html buni orders/{id}/billRequested orqali tekshiradi */
function isBillAlreadyRequested() {
  const order = activeOrderId ? (ordersCache[activeOrderId] || {}) : {};
  return order.billRequested === true;
}

/** "Kassaga yuborish" tugmasini holatga qarab ko'rsatadi/yashiradi */
function renderKassaButton() {
  const btn      = document.getElementById("btnSendKassa");
  const label    = document.getElementById("btnSendKassaLabel");
  const divider  = document.getElementById("kassaDivider");
  if (!btn) return;

  // Faqat ochiq (yuborilgan) buyurtma bo'lsa va yangi, hali yuborilmagan taom bo'lmasa ko'rsatiladi
  const hasNew = Object.values(cart).some(c => !c.sent && Number(c.qty) > 0);
  const canSend = !!activeOrderId && !hasNew;

  if (!canSend) {
    btn.style.display = "none";
    if (divider) divider.style.display = "none";
    return;
  }

  btn.style.display = "flex";
  if (divider) divider.style.display = "flex";

  const alreadyRequested = isBillAlreadyRequested();
  btn.disabled = alreadyRequested;
  btn.classList.toggle("is-requested", alreadyRequested);
  if (label) label.textContent = alreadyRequested
    ? t("bill_already_requested", "Hisob so'ralgan")
    : t("send_to_kassa_btn", "Kassaga yuborish");
}

/**
 * Ofitsiant hisobni kassaga yuboradi — kassa.html'dagi requestBillForTable() bilan
 * bir xil yozuvni amalga oshiradi: orders/{id}/billRequested = true va
 * tables/{key}/status = "billing". Kassa panelida stol sariq (billing) bo'lib
 * ko'rinadi va "Hisob so'rash" tugmasi "Kassa kodi hali yo'q" ga aylanadi
 * (kassaCode mijoz tomonidan generatsiya qilingandan keyin to'lovga o'tish yoqiladi).
 * Naqd/Payme/Click tanlovi ma'lumot sifatida yoziladi; haqiqiy to'lovni qabul
 * qilish (kassa.html'dagi finishPayment) faqat kassada amalga oshadi.
 */
window.sendOrderToKassa = async function () {
  try {
    if (!activeOrderId) {
      showToast(t("no_active_order", "Ochiq buyurtma yo'q"), "error");
      return;
    }
    const hasNew = Object.values(cart).some(c => !c.sent && Number(c.qty) > 0);
    if (hasNew) {
      showToast(t("send_new_items_first", "Avval yangi taomlarni oshxonaga yuboring"), "error");
      return;
    }
    if (isBillAlreadyRequested()) return;

    const btn = document.getElementById("btnSendKassa");
    if (btn) btn.disabled = true;

    const now = Date.now();
    const staffName = window.currentStaffRealName || sessionStorage.getItem("name") || t("role_waiter", "Ofitsiant");

    const updates = {};
    updates[`${BASE_PATH}/orders/${activeOrderId}/billRequested`]   = true;
    updates[`${BASE_PATH}/orders/${activeOrderId}/billRequestedAt`] = now;
    updates[`${BASE_PATH}/orders/${activeOrderId}/billRequestedBy`] = staffName;
    updates[`${BASE_PATH}/orders/${activeOrderId}/updatedAt`]       = now;

    const tableKey = getTableKey(activeTableNumber);
    updates[`${BASE_PATH}/tables/${tableKey}/status`] = "billing";

    await update(ref(db), updates);

    await writeOrderAuditLog(db, BASE_PATH, {
      actorId: waiterId,
      actorName: staffName,
      actorRole: "waiter",
      action: "bill_requested",
      orderId: activeOrderId,
      table: activeTableNumber,
      description: `💰 ${t("audit_bill_sent_to_kassa", "Hisob kassaga yuborildi")} — Stol ${activeTableNumber}`
    });

    showToast(`✅ ${t("bill_sent_to_kassa", "Hisob kassaga yuborildi")}`, "success");
    renderKassaButton();

  } catch (err) {
    console.error("sendOrderToKassa error:", err);
    showToast(t("notify.error", "Xatolik yuz berdi!"), "error");
    renderKassaButton();
  }
};

// ══════════════════════════════════════════
// 12c. OFITSIANT TOMONIDAN TO'LOVNI QABUL QILISH
// kassa.html'dagi processPayment() bilan bir xil Firebase
// yozuvlarini amalga oshiradi, shunda kassa paneli va admin
// panelida ham to'lov to'g'ri (to'landi) ko'rinadi.
// ══════════════════════════════════════════
/**
 * Ochiq buyurtma (yoki joriy savat) uchun yakuniy to'lanadigan summani hisoblaydi:
 * taomlar jami − chegirma + xizmat haqi (%) + stol xizmat narxi (aniq summa).
 * Payment modal va chek shu qiymatni ishlatadi.
 */
function computeFinalOrderTotal(order) {
  const base = Number(order?.total) || cartTotal();
  const discountAmount = Number(order?.discountAmount || 0);
  const svcApplies = waiterServiceFeePct > 0 && (waiterServiceFeeMinOrd === 0 || base >= waiterServiceFeeMinOrd);
  const svcAmount = svcApplies ? Math.round(base * waiterServiceFeePct / 100) : 0;
  // 🆕 STOL XIZMAT NARXI — order.tableServiceAmount mavjud bo'lsa (order
  // yaratilganda "muzlatilgan" qiymat) o'sha, aks holda computeTableServiceAmount()
  // fallback (joriy stol narxi) — savatCart summary bilan bir xil funksiya.
  const tableServiceAmount = (order && order.tableServiceAmount !== undefined && order.tableServiceAmount !== null)
    ? Math.max(0, Number(order.tableServiceAmount) || 0)
    : computeTableServiceAmount();
  return Math.max(0, base - discountAmount + svcAmount + tableServiceAmount);
}

// ── Unified Payment Engine wiring (js/paymentEngine.js) ────────────────────
// Replaces this file's own hand-rolled method list / step machine / Firebase
// write with the one shared implementation also used by kassa.js (and,
// via the same registry, client.js/courier.js) — see paymentEngine.js for the
// full rationale. waiter.html's existing #paymentModalBackdrop/#pmMethods/
// #pmCardStep/#pmProcessing/#pmSuccessStep/#pmCancelBtn markup is reused
// as-is (createPaymentModal operates purely on element ids), so nothing
// about the modal's look changes.
const waiterPaymentModal = createPaymentModal({
  t,
  allowedMethods: () => getEnabledPaymentMethods(restaurantSettings || {}),
  escapeHtml,
  write: {
    get db() { return db; },
    update, ref, runTransaction,
    get basePath() { return BASE_PATH; },
    resolveTableKey: (orderData) => getTableKey(orderData?.table ?? activeTableNumber),
    writeOrderAuditLog,
    ORDER_STATUS_V2,
  },
  async onSuccess(result) {
    const order = ordersCache[activeOrderId] || {};
    showToast(`✅ ${t("payment_success", "To'lov qabul qilindi")}`, "success");

    const paidOrderId = result.orderId;

    // 🆕 QR bir martalik chegirma: (1) agar shu order avvalroq bir claimni
    // "ishlatgan" bo'lsa (discountClaimId — computeCustomerAwareDiscount/
    // applyPendingCustomerDiscount tomonidan yozilgan), aynan shu payment
    // muvaffaqiyatli bo'lgan zahoti (payment-authoritative flow, spec §15/
    // §33) uni "used" qilamiz — order yaratilganda EMAS, shu yerda, aks
    // holda bekor qilingan/muvaffaqiyatsiz to'lovda chegirma yo'qolib qolardi.
    // Xatolik bo'lsa ham to'lovning o'zi allaqachon yozilgan — bloklamaymiz.
    if (order.discountClaimId) {
      discountClaimsClient.use(currentRestaurantId, order.discountClaimId, paidOrderId)
        .catch(err => console.error("discountClaimsClient.use error:", err));
    }
    // (2) Chekka yangi QR chiqarish uchun — reprint bilan bir xil claim
    // qayta ishlatilishi uchun (spec §27/§28), backend orderId bo'yicha
    // idempotent (allaqachon shu order uchun issue qilingan bo'lsa, xuddi
    // shuni qaytaradi). printSettings.receiptQr o'chiq yoki foiz
    // sozlanmagan bo'lsa claim === null — QR shunchaki chiqmaydi.
    let qrClaimToken = null;
    try {
      const claim = await discountClaimsClient.issue(currentRestaurantId, paidOrderId);
      qrClaimToken = claim?.token || null;
    } catch (err) {
      console.error("discountClaimsClient.issue error:", err);
    }

    const receiptData = {
      orderId: paidOrderId,
      table: activeTableNumber,
      orderNumber: order.orderNumber,
      method: result.method,
      subtotal: Number(order.total || 0),
      serviceFeeAmount: result.extra?.serviceFeeAmount || 0,
      discountAmount: Number(order.discountAmount || 0),
      // 🆕 STOL XIZMAT NARXI — chekda alohida qator (receiptEngine.js:
      // extraFeeRows), _waiterReceiptEngineData() shu maydondan quradi.
      tableServiceAmount: (order.tableServiceAmount !== undefined && order.tableServiceAmount !== null)
        ? Math.max(0, Number(order.tableServiceAmount) || 0)
        : computeTableServiceAmount(),
      total: result.extra?.finalTotal ?? computeFinalOrderTotal(order),
      staffName: order.__waiterPaymentActorName || "",
      items: order.items || {},
      customerPhone: order.__waiterPaymentCustomerPhone || "",
      qrClaimToken,
    };
    window.__lastWaiterReceipt = receiptData;
    window.__waiterJustPaidOrderId = paidOrderId;
    printWaiterReceipt(receiptData);
    renderPayButton();
    renderCart();

    // Savat darhol bo'shamaydi — to'langan buyurtma va chek tugmasi ko'rinib turadi.
    // Stol "tozalanmoqda" holatiga o'tadi; bir muddatdan keyin (yoki ofitsiant
    // "Orqaga" bossa) avtomatik ravishda stollar ro'yxatiga qaytadi.
    setTimeout(() => {
      if (window.__waiterJustPaidOrderId === paidOrderId) window.__waiterJustPaidOrderId = null;
      if (activeOrderId === paidOrderId) window.backToTables();
    }, 6000);
  },
  onCancel() {
    showToast(t("notify.error", "Xatolik yuz berdi!"), "error");
  },
});

window.openPaymentModal = function () {
  if (!activeOrderId) {
    showToast(t("no_active_order", "Ochiq buyurtma yo'q"), "error");
    return;
  }
  // Admin panelida "To'lovni kim qabul qiladi?" — "Kassir" tanlangan bo'lsa
  // (yoki hali belgilanmagan bo'lsa), ofitsiant to'lov qila olmaydi. Bu tekshiruv
  // faqat tugma ko'rinishini emas, haqiqiy to'lov jarayonining o'zini to'sadi.
  const paymentAcceptor = restaurantSettings?.paymentAcceptor || "kassir";
  if (paymentAcceptor !== "waiter") {
    showToast(t("payment_kassir_only", "To'lovni faqat kassir qabul qiladi"), "info");
    return;
  }
  const order = ordersCache[activeOrderId] || {};
  const alreadyPaid = order.status === "to'landi" || order.status === "paid" || order?.payment?.paid === true;
  if (alreadyPaid) {
    showToast(t("already_paid", "Bu buyurtma allaqachon to'langan"), "info");
    return;
  }

  const tableEl = document.getElementById("pmTableNum");
  const totalEl = document.getElementById("pmTotal");
  if (tableEl) tableEl.textContent = activeTableNumber || "—";
  if (totalEl) totalEl.textContent = money(computeFinalOrderTotal(order));

  const staffName = window.currentStaffRealName || sessionStorage.getItem("name") || t("role_waiter", "Ofitsiant");
  const svcApplies = waiterServiceFeePct > 0 && (waiterServiceFeeMinOrd === 0 || Number(order.total || 0) >= waiterServiceFeeMinOrd);
  const svcAmount = svcApplies ? Math.round(Number(order.total || 0) * waiterServiceFeePct / 100) : 0;
  const finalTotal = computeFinalOrderTotal(order);
  const customerPhoneRaw = order.customerPhone || order.clientPhone || order.phone || "";
  const normalizedCustomerPhone = normalizePhone(customerPhoneRaw);

  // ⚠️ QR kod chekda ko'rsatilishi yoqilgan bo'lsa — mijozga shu safar wa'da
  // qilingan % chegirmani customers/{phone} yozuviga yozamiz, shunda keyingi
  // safar shu raqam kiritilganda (applyPendingCustomerDiscount) avtomatik ishlaydi.
  const qrPct = Number(printSettingsCache?.receiptQrPercent || 0);
  const extraUpdates = {};
  if (printSettingsCache?.receiptQr && qrPct > 0 && normalizedCustomerPhone) {
    const now = Date.now();
    extraUpdates[`${BASE_PATH}/customers/${encodeURIComponent(normalizedCustomerPhone)}/personalDiscount`] = qrPct;
    extraUpdates[`${BASE_PATH}/customers/${encodeURIComponent(normalizedCustomerPhone)}/personalDiscountReason`] =
      printSettingsCache.receiptQrReason || t("qr_discount_default_reason", "Sodiq mijoz chegirmasi");
    extraUpdates[`${BASE_PATH}/customers/${encodeURIComponent(normalizedCustomerPhone)}/personalDiscountSource`] = "receipt_qr";
    extraUpdates[`${BASE_PATH}/customers/${encodeURIComponent(normalizedCustomerPhone)}/personalDiscountSetAt`] = now;
  }

  waiterPaymentModal.open({
    orderId: activeOrderId,
    orderData: { ...order, table: activeTableNumber },
    actor: { id: waiterId, name: staffName, role: "waiter" },
    extra: {
      serviceFeeAmount: svcAmount,
      finalTotal,
      extraUpdates,
      auditDescription: `💳 ${t("audit_payment_by_waiter", "To'lov ofitsiant tomonidan qabul qilindi")} — Stol ${activeTableNumber} (${formatOrderNumber(order) || "№" + activeOrderId.slice(-6)}) · ${money(finalTotal)}`,
    },
  });
  // onSuccess doesn't have direct access to staffName/phone (they're captured
  // here, at open() time) — stash them on the in-memory order object so the
  // modal's onSuccess callback above can build the same receiptData shape
  // the old code produced, without the engine needing to know about them.
  order.__waiterPaymentActorName = staffName;
  order.__waiterPaymentCustomerPhone = normalizedCustomerPhone || "";
};

window.pmBackToMethods = () => waiterPaymentModal.backToMethods();
window.pmConfirmCardPayment = () => waiterPaymentModal.confirmCard();
window.pmFormatCardNumber = (el) => waiterPaymentModal.formatCardNumber(el);
window.pmFormatCardExpiry = (el) => waiterPaymentModal.formatCardExpiry(el);
window.pmFormatCardCode = (el) => waiterPaymentModal.formatCardCode(el);
window.closePaymentModal = () => waiterPaymentModal.close();

// ══════════════════════════════════════════
// 12d. CHEKNI HTML KO'RINISHIDA QURISH VA CHOP ETISH
// ══════════════════════════════════════════

/** waiter.js'ning ichki receiptData shaklini (orderId/table/orderNumber/method/
 *  subtotal/serviceFeeAmount/discountAmount/total/staffName/items/customerPhone)
 *  receiptEngine.buildReceiptBodyHtml() kutgan umumiy shaklga o'giradi — admin
 *  paneli → Sozlamalar → Terminal va Chop etish → Chek sozlamalari shu yerda
 *  o'qiladi (logotip/QR/shtrix-kod/pastki matn/printer kengligi), aynan avvalgi
 *  mantiq bilan bir xil. */
function _waiterReceiptEngineData(data) {
  const now = data.paidAt ? new Date(data.paidAt) : new Date();
  const restName = document.getElementById("waiterHeaderRestName")?.textContent?.replace(/^\|\s*/, "") || "Nesta ERP";
  const ps = printSettingsCache || {};
  const showLogo = ps.receiptLogo !== false; // default: yoqilgan

  // 🆕 QR chegirma / bir martalik mijoz chegirmasi — avval bu yerda mijoz
  // telefoni/foizi/sababi ochiq matn sifatida QR ichiga yozilardi (ofitsiant
  // buni chekdan o'qib eshitib olardi — hech qanday backend claim/consume
  // mexanizmi yo'q edi, bir marta ishlatilishi hech nima bilan cheklanmagan
  // edi). Endi QR haqiqiy, xavfsiz, bir martalik claim havolasiga olib
  // boradi (backend/discountClaims/*) — token onSuccess() da
  // discountClaimsClient.issue() orqali olinib data.qrClaimToken sifatida
  // uzatiladi; shu yerda faqat havolani quramiz. printSettings.receiptQr/
  // receiptQrPercent — bir xil, avvalgi sozlama qayta ishlatilmoqda.
  let qrText, qrCaption;
  if (ps.receiptQr && data.qrClaimToken) {
    qrText = `${window.location.origin}/client.html?rest=${encodeURIComponent(currentRestaurantId)}&discount=${encodeURIComponent(data.qrClaimToken)}`;
    qrCaption = `${t("receipt_qr_caption", "Keyingi tashrifingizga")} ${Number(ps.receiptQrPercent || 0)}% ${t("receipt_qr_caption_2", "chegirma")}`;
  }
  const barcodeText = ps.receiptBarcode ? String(data.orderNumber || data.orderId || "").trim() : "";

  const items = Object.values(data.items || {}).map(c => ({
    name: localName(c.name, "—"),
    qty: Number(c.qty || 0),
    unit: c.isWeightBased ? " kg" : "",
    price: Number(c.price || 0),
    total: Number(c.qty || 0) * Number(c.price || 0),
  }));

  return {
    restaurantName: restName,
    logoUrl: showLogo ? (restaurantSettings?.restaurantLogoUrl || "") : "",
    date: now.toLocaleDateString(waiterLocale()),
    time: now.toLocaleTimeString(waiterLocale(), { hour: "2-digit", minute: "2-digit" }),
    orderId: data.orderId,
    orderNumber: formatOrderNumber(data) || data.orderNumber,
    table: data.table,
    waiterName: data.staffName,
    items,
    subtotal: data.subtotal,
    serviceFee: data.serviceFeeAmount,
    discount: data.discountAmount,
    // 🆕 STOL XIZMAT NARXI — restoran-darajasidagi "Xizmat haqi" (serviceFee,
    // yuqorida) dan ALOHIDA qator, faqat >0 bo'lsa chiqadi (totalRow() o'zi
    // 0/undefined'ni yashiradi — receiptEngine.js'ning mavjud extraFeeRows
    // kengaytmasi ishlatildi, yangi field ixtiro qilinmadi).
    ...(Number(data.tableServiceAmount || 0) > 0 ? {
      extraFeeRows: [{ label: t("table_service_row_label", "Stol xizmati"), value: Number(data.tableServiceAmount) }]
    } : {}),
    total: data.total,
    methodLabel: paymentMethodLabel(data.method, t),
    qrText, qrCaption, barcodeText,
    footerText: ps.receiptFooter && String(ps.receiptFooter).trim() ? ps.receiptFooter : undefined,
  };
}
function _waiterReceiptWidth() {
  // ⚠️ Bug fix: bu ilgari `.receiptPrinter`ni o'qirdi — ammo Sozlamalar →
  // Chop etish shu qiymatni `.receiptPaperSize`ga yozadi (`.receiptPrinter`
  // Terminal sozlamalaridagi PRINTER QURILMASI nomi, boshqa maydon). Shu
  // nomuvofiqlik tufayli "Chek qog'oz o'lchami" (58mm/80mm) tanlovi hech qachon
  // haqiqiy chekka ta'sir qilmagan.
  return (printSettingsCache || {}).receiptPaperSize === "58mm" ? "58mm" : "80mm";
}
function _waiterReceiptCopies() {
  return Number((printSettingsCache || {}).receiptCopies) || 1;
}

/** Buyurtma to'langanda avtomatik chop etadi — waiter.html'ning mavjud
 *  #printReceiptRoot/#printReceiptBody yashirin konteyneri + window.print()
 *  orqali (mexanizm o'zgarmadi, faqat HTML endi receiptEngine tomonidan
 *  quriladi). */
async function printWaiterReceipt(data) {
  const root = document.getElementById("printReceiptBody");
  if (!root) return;

  // ⚠️ Ba'zi brauzerlar chop etish sahifasining header/footer qismida
  // document.title'ni ko'rsatadi (masalan "Nesta ERP — Ofitsiant paneli").
  // Buni chop etish vaqtida vaqtincha bo'shatib, keyin qaytaramiz. Title
  // printReceiptInto() chaqirilishidan OLDIN o'rnatiladi (u endi QR/logo/
  // shtrix-kod rasmlari yuklanishini kutadi — window.print() darhol emas,
  // asinxron ravishda keyinroq chaqiriladi — shu sabab restoreTitle
  // fallback vaqti ham shu kutishni hisobga olib uzaytirildi).
  const originalTitle = document.title;
  document.title = t("receipt_title", "Chek") + (data?.orderNumber ? ` ${formatOrderNumber(data) || "#" + data.orderNumber}` : "");
  const restoreTitle = () => { document.title = originalTitle; };
  window.addEventListener("afterprint", restoreTitle, { once: true });
  setTimeout(restoreTitle, 6000);

  await printReceiptInto(root, _waiterReceiptEngineData(data), { t, width: _waiterReceiptWidth(), copies: _waiterReceiptCopies() });
}

/** "..." menyusidagi "Chekni qayta chop etish" — oxirgi to'langan buyurtma chekini qayta printerga yuboradi */
window.reprintLastReceipt = function () {
  if (!window.__lastWaiterReceipt) {
    showToast(t("no_receipt_yet", "Chek hali mavjud emas"), "error");
    return;
  }
  window.closeReceiptMenu();
  printWaiterReceipt(window.__lastWaiterReceipt);
};

/** "..." menyusidagi "Chekni ko'rish" — chekni yangi oynada ko'rsatadi */
window.viewLastReceipt = function () {
  if (!window.__lastWaiterReceipt) {
    showToast(t("no_receipt_yet", "Chek hali mavjud emas"), "error");
    return;
  }
  window.closeReceiptMenu();
  printReceiptInPopup(_waiterReceiptEngineData(window.__lastWaiterReceipt), {
    t, width: _waiterReceiptWidth(), copies: _waiterReceiptCopies(), title: t("receipt_title", "Chek"),
    onPopupBlocked: () => showToast(t("popup_blocked", "Popup bloklandi — brauzer sozlamalarini tekshiring"), "error"),
  });
};

/** "..." menyusidagi "Chekni yuklab olish" — chekni .html fayl sifatida yuklab beradi */
window.downloadLastReceipt = function () {
  if (!window.__lastWaiterReceipt) {
    showToast(t("no_receipt_yet", "Chek hali mavjud emas"), "error");
    return;
  }
  window.closeReceiptMenu();
  const data = window.__lastWaiterReceipt;
  downloadReceiptHtmlFile(_waiterReceiptEngineData(data), {
    t, width: _waiterReceiptWidth(),
    title: `${t("receipt_title", "Chek")} #${data.orderNumber || ""}`,
    filename: `chek-${data.orderNumber || Date.now()}.html`,
  });
};

/** "..." dropdown menyusini ochish/yopish */
window.toggleReceiptMenu = function () {
  const dd = document.getElementById("receiptMenuDropdown");
  if (!dd) return;
  const isOpen = dd.style.display === "block";
  dd.style.display = isOpen ? "none" : "block";
};
window.closeReceiptMenu = function () {
  const dd = document.getElementById("receiptMenuDropdown");
  if (dd) dd.style.display = "none";
};
document.addEventListener("click", (e) => {
  const dd = document.getElementById("receiptMenuDropdown");
  const btn = document.getElementById("btnReceiptMenu");
  if (!dd || dd.style.display !== "block") return;
  if (dd.contains(e.target) || (btn && btn.contains(e.target))) return;
  dd.style.display = "none";
});

// ══════════════════════════════════════════
// 13. STOL HOLATI
// ══════════════════════════════════════════
function renderStatusRow() {
  const box = document.getElementById("statusRow");
  if (!box || !activeTableKey) return;

  const current = getWaiterStatus(activeTableKey, tablesCache[activeTableKey]);

  box.innerHTML = MANUAL_STATUS_ACTIONS.map(a => {
    const isActive = a.ui === current.ui;
    return `
      <button class="status-chip ${isActive ? "active" : ""}"
              style="${isActive ? `background:${a.color}; border-color:${a.color};` : ""}"
              onclick="window.setTableStatus('${a.ui}')">
        ${a.emoji} ${t(a.labelKey, a.labelUz)}
      </button>`;
  }).join("");
}

window.setTableStatus = async function (uiStatus) {
  if (!activeTableKey) return;

  const action = MANUAL_STATUS_ACTIONS.find(a => a.ui === uiStatus);
  if (!action) return;

  try {
    const now = Date.now();
    const staffName = window.currentStaffRealName || sessionStorage.getItem("name") || t("role_waiter", "Ofitsiant");
    const updates = {};

    updates[`${BASE_PATH}/tables/${activeTableKey}/status`]        = action.writes;
    updates[`${BASE_PATH}/tables/${activeTableKey}/statusUpdatedAt`] = now;
    updates[`${BASE_PATH}/tables/${activeTableKey}/statusUpdatedBy`] = staffName;

    if (action.writes === "free") {
      updates[`${BASE_PATH}/tables/${activeTableKey}/busy`]       = false;
      updates[`${BASE_PATH}/tables/${activeTableKey}/orderId`]    = null;
      updates[`${BASE_PATH}/tables/${activeTableKey}/occupiedAt`] = null;
    } else if (action.writes === "occupied") {
      updates[`${BASE_PATH}/tables/${activeTableKey}/busy`] = true;
    }

    await update(ref(db), updates);

    showToast(`${action.emoji} ${t(action.labelKey, action.labelUz)}`, "success");
    refreshOrderScreenHeader();

  } catch (err) {
    console.error("setTableStatus error:", err);
    showToast(t("notify.error", "Xatolik yuz berdi!"), "error");
  }
};

// ══════════════════════════════════════════
// 14. BUYURTMA TARIXI (faqat shu stolniki)
// ══════════════════════════════════════════
function renderOrderHistory() {
  const box = document.getElementById("orderHistory");
  if (!box || !activeTableNumber) return;

  // Shu stolga tegishli barcha buyurtmalar
  const tableOrders = Object.entries(ordersCache || {})
    .filter(([, o]) => String(o.table) === String(activeTableNumber));

  // Har bir itemni alohida tarix yozuvi sifatida yig'amiz
  const rows = [];
  tableOrders.forEach(([orderId, o]) => {
    Object.entries(o.items || {}).forEach(([itemKey, it]) => {
      rows.push({
        orderId,
        orderNumber: o.orderNumber,
        name: localName(it.name),
        qty: it.qty,
        isWeightBased: it.isWeightBased === true,
        variantName: it.variantName ? localName(it.variantName, String(it.variantName)) : "",
        note: it.note || "",
        addedBy: it.addedBy || o.createdByWaiterName || t("unknown_person", "Noma'lum"),
        addedAt: it.addedAt || o.createdAt || 0,
        status: it.status || "pending"
      });
    });
  });

  rows.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  if (rows.length === 0) {
    box.innerHTML = `<p class="empty-state" style="padding:14px 0;">${t("no_history_yet", "Tarix bo'sh")}</p>`;
    return;
  }

  box.innerHTML = rows.slice(0, 60).map(r => {
    const statusIcon = r.status === "delivered" || r.status === "served" ? "✅"
      : r.status === "ready" ? "🔵"
      : r.status === "preparing" ? "🟡" : "➕";
    const unit = r.isWeightBased ? " kg" : "×";

    return `
      <div class="hist-row">
        <span class="hist-icon">${statusIcon}</span>
        <div class="hist-body">
          <div class="hist-name">
            ${escapeHtml(r.name)}${r.variantName ? ` <span style="font-weight:700;">— ${escapeHtml(r.variantName)}</span>` : ""}
            <span style="color:var(--text-soft); font-weight:600;">
              ${r.isWeightBased ? `${r.qty}${unit}` : `${unit}${r.qty}`}
            </span>
          </div>
          <div class="hist-meta">
            👤 ${escapeHtml(r.addedBy)} · 🕘 ${timeShort(r.addedAt)}
            ${r.orderNumber ? ` · ${escapeHtml(formatOrderNumber(r.orderNumber, false))}` : ""}
            ${r.note ? ` · 📝 ${escapeHtml(r.note)}` : ""}
          </div>
        </div>
      </div>`;
  }).join("");
}

// ══════════════════════════════════════════
// 14b. DARK / LIGHT TEMA
// admin.js'dagi window.toggleTheme()/initTheme() bilan AYNAN bir xil
// naqsh — bir xil localStorage kaliti ("app_theme") va bir xil
// <html data-theme="dark"> atributi (design-system.css/header.css allaqachon
// shu atributni o'qiydi) — shuning uchun bitta qurilmada admin panelida
// tanlangan tema, waiter panelini ochganda ham darhol qo'llanadi (va
// aksincha). Yangi tema tizimi YARATILMADI — mavjudini reuse qilindi.
// ══════════════════════════════════════════
(function initWaiterTheme() {
  try {
    const saved = localStorage.getItem("app_theme");
    if (saved === "dark") document.documentElement.setAttribute("data-theme", "dark");
  } catch { /* localStorage mavjud emas — light standart holat */ }
})();

window.toggleWaiterTheme = function () {
  const html = document.documentElement;
  const isDark = html.getAttribute("data-theme") === "dark";
  if (isDark) {
    html.removeAttribute("data-theme");
    try { localStorage.setItem("app_theme", "light"); } catch { /* ignore */ }
  } else {
    html.setAttribute("data-theme", "dark");
    try { localStorage.setItem("app_theme", "dark"); } catch { /* ignore */ }
  }
};

// ══════════════════════════════════════════
// 15. TIL (i18n)
// ══════════════════════════════════════════
function initLanguage() {
  const sel = document.getElementById("langSelect");
  const current = getLang();

  if (sel) {
    sel.value = current;
    sel.addEventListener("change", e => {
      setLang(e.target.value);
      localStorage.setItem("lang", e.target.value);
    });
  }

  if (typeof applyLang === "function") applyLang();

  if (typeof onLangChange === "function") {
    onLangChange(() => {
      const _step = (label, fn) => {
        try { fn(); } catch (err) { console.error(`[i18n] waiter.js "${label}" failed during language switch:`, err); }
      };

      _step("applyLang", () => applyLang());
      _step("renderTypeFilter", () => renderTypeFilter());
      _step("renderTablesGrid", () => renderTablesGrid());
      if (activeTableKey) {
        _step("refreshOrderScreenHeader", () => refreshOrderScreenHeader());
        _step("renderCategories", () => renderCategories());
        _step("renderSubCategories", () => renderSubCategories());
        _step("renderMenuItems", () => renderMenuItems());
        _step("renderCart", () => renderCart());
        _step("renderStatusRow", () => renderStatusRow());
        _step("renderOrderHistory", () => renderOrderHistory());
      }
      _step("waiterPaymentModal.relabelOnLangChange", () => waiterPaymentModal.relabelOnLangChange());
    });
  }
}

// ══════════════════════════════════════════
// 16. XODIM ISMI
// ══════════════════════════════════════════
async function loadStaffName() {
  const el = document.getElementById("waiterHeaderStaffName");
  try {
    const snap = await get(ref(db, `${BASE_PATH}/users/${waiterId}`));
    if (snap.exists()) {
      const staff = snap.val();
      const name = staff.name || staff.fullName || sessionStorage.getItem("name") || "";
      window.currentStaffRealName = name;
      if (el && name) el.textContent = name;
    } else if (el && sessionStorage.getItem("isViewingAsAdmin") === "true") {
      el.textContent = t("role_waiter", "Ofitsiant");
    }
  } catch (e) {
    console.warn("loadStaffName:", e?.code || e?.message || e);
    if (el && !el.textContent) {
      el.textContent = sessionStorage.getItem("name") || t("role_waiter", "Ofitsiant");
    }
  }
}

// Item 3.3/3.6 — admin joriy xodimni bloklasa (users/{id}/active=false),
// panel darhol (refreshsiz) "🔒 Hisob bloklangan" bloklovchi ekranini
// ko'rsatadi. Haqiqiy xavfsizlik chegarasi SERVER tomonida allaqachon bor
// (routes/auth.js — user.active===false har bir login/session
// tekshiruvida 403 "Account disabled" qaytaradi); bu FAQAT allaqachon ochiq
// turgan sessiyada foydalanuvchiga darhol signal beradi — mavjud yozish
// huquqlari/RBAC te'sirini o'zgartirmaydi.
function listenSelfBlockStatus() {
  if (!waiterId) return;
  onValue(ref(db, `${BASE_PATH}/users/${waiterId}/active`), snap => {
    const isActive = snap.val() !== false;
    let overlay = document.getElementById("selfBlockedOverlay");
    if (!isActive) {
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "selfBlockedOverlay";
        overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.92);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:24px;";
        overlay.innerHTML = `
          <div style="font-size:52px;">🔒</div>
          <div style="font-size:20px;font-weight:800;">${t("staff_blocked_title", "Bloklangan")}</div>
          <div style="font-size:14px;opacity:.85;max-width:340px;">${t("staff_account_blocked_msg", "Hisobingiz administrator tomonidan bloklangan")}</div>
        `;
        document.body.appendChild(overlay);
      }
    } else if (overlay) {
      overlay.remove();
    }
  });
}

// ══════════════════════════════════════════
// 17. OBUNA MONITORINGI
// ══════════════════════════════════════════
function startSubscriptionMonitor() {
  // Bug fix: this only ever watched restaurants/{id}/subscription — but
  // Super Admin's Block/Pause action (window.toggleBlockRestaurant /
  // togglePauseRestaurant in superadmin.js) writes to
  // restaurants/{id}/info/status, a completely different path. A waiter
  // already logged in never saw the block overlay when Super Admin blocked
  // their restaurant, because this listener was watching the wrong field.
  onValue(ref(db, `${BASE_PATH}/subscription`), snap => {
    if (!snap.exists()) return;
    const sub = snap.val();
    const isBlocked = sub.status === "blocked" || sub.isActive === false;
    const overlay = document.getElementById("system-block-overlay");
    if (overlay) overlay.style.display = isBlocked ? "flex" : "none";
  });
  onValue(ref(db, `${BASE_PATH}/info/status`), snap => {
    const status = snap.val();
    if (status !== "blocked" && status !== "paused") return;
    window.location.href = `expired.html?rest=${encodeURIComponent(currentRestaurantId)}`;
  });
}

// ══════════════════════════════════════════
// 💬 ICHKI CHAT: Ofitsiant → E'lonlar + Admin bilan shaxsiy chat
// ══════════════════════════════════════════
async function getWaiterChatOptions() {
  return [
    { icon: "📢", label: t("chat_announcements", "E'lonlar"), type: "announcement" },
    { icon: "👨‍💼", label: t("chat_with_admin", "Admin"), type: "admin" }
  ];
}
async function getWaiterChatId(option) {
  if (option.type === "admin") return `admin_waiter_${waiterId}`;
  return null;
}
function initWaiterChat() {
  if (typeof window.initChatSystem !== "function") return;
  window.initChatSystem({
    currentRestaurantId,
    currentUserId: waiterId,
    currentRole: "waiter",
    db,
    getChatOptions: getWaiterChatOptions,
    getChatId: getWaiterChatId
  });
}

// ══════════════════════════════════════════
// 18. ISHGA TUSHIRISH
// ══════════════════════════════════════════
async function init() {
  if (!currentRestaurantId || !waiterId) return;

  initLanguage(); // pure DOM/localStorage — no Firebase, safe before auth is ready

  // 🔒 Har qanday Firebase o'qish/yozishdan OLDIN, joriy sahifa uchun Auth
  // sessiyasi tiklanishini kutamiz (login.js signInWithCustomToken() orqali
  // signInWithCustomToken() sessiyasini shu yerda getAuth(app) tiklaydi —
  // header importidagi izohga qarang). authStateReady() — Firebase JS SDK
  // 10.7+ metodi, aynan shu loyihada ishlatilayotgan versiya (10.7.1) bilan
  // mos. Sessiya haqiqatan ham yo'q bo'lsa (masalan localStorage/IndexedDB
  // tozalangan) — currentUser null bo'ladi, keyingi get()/onValue()
  // chaqiruvlari baribir Permission Denied qaytaradi, lekin bu ENDI kod
  // bo'yicha kutilgan, boshqariladigan holat (loadStaffName() va h.k.
  // o'zining mavjud try/catch + fallback logikasi bilan xotirjam davom
  // etadi), tasodifiy/tushunarsiz xato emas.
  try {
    await auth.authStateReady();
  } catch (err) {
    console.warn("[WAITER-AUTH] authStateReady() failed:", err?.code || err?.message);
  }

  // 🩹 Root-cause fix — loadStaffName() (and, silently, every other
  // restId-scoped read/write below) Permission Denied despite a successful
  // Auth session: authStateReady() above only waits for *some* session to
  // resolve — it never verifies that session is actually SCOPED to this
  // restaurant. login.js's signInWithCustomToken() never calls
  // setPersistence(), so a real, non-anonymous session persists in shared
  // browserLocalPersistence across tabs, reloads, and — critically — across
  // logins to a DIFFERENT restaurant on the same browser (a waiter who
  // worked at Restaurant A, then later logs into Restaurant B on the same
  // device without the old tab/session ever being cleared). That stale
  // session sails through authStateReady() as "ready" and non-anonymous, so
  // it LOOKS authenticated — but its auth.token.restId still names the OLD
  // restaurant, so every restaurants/{currentRestaurantId}/... call here
  // fails the Rule's `auth.token.restId == $restId` check. This mirrors
  // admin.js's window._adminAuthReady guard exactly (added there for the
  // identical bug) — waiter.js never had the equivalent until now. Checked
  // ONLY against restId (never role/rtdbUserId): the "View As" shortcut
  // legitimately reuses the admin's own session, which differs on those two
  // fields on purpose and must still be allowed to read — same restId-only
  // scope as admin.js's guard.
  const _existingWaiterUser = auth.currentUser;
  if (_existingWaiterUser && !_existingWaiterUser.isAnonymous) {
    let sessionRestId = null;
    let claimsCheckFailed = false;
    try {
      sessionRestId = (await _existingWaiterUser.getIdTokenResult())?.claims?.restId ?? null;
    } catch (_e) {
      claimsCheckFailed = true;
    }
    const isMismatch = claimsCheckFailed || (sessionRestId && sessionRestId !== currentRestaurantId);
    if (isMismatch) {
      console.error("[WAITER-AUTH] 🚫 SESSION/RESTAURANT MISMATCH (or unverifiable) — signing out, never using this session:", {
        uid: _existingWaiterUser.uid,
        sessionRestId,
        requestedRestId: currentRestaurantId,
        claimsCheckFailed,
      });
      await signOut(auth).catch(() => {});
      alert(t("session_restaurant_mismatch_error", "Sessiya xatosi: bu sahifa boshqa restoran uchun ochilgan sessiya bilan yuklanmoqda. Iltimos, qaytadan tizimga kiring."));
      window.location.replace("login.html");
      return;
    }
  }

  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    // 🆕 Now decodes actual claims (restId/role/rtdbUserId/type/isSuperAdmin)
    // instead of only the raw Firebase Auth uid — the uid is a composite
    // "${restId}__${userId}" (see mintSessionToken()'s header comment), not
    // directly comparable to targetUid/waiterId (the bare RTDB id), so the
    // previous version of this diagnostic could never actually show WHY a
    // read was denied. restIdMatch/rtdbUserIdMatch make that explicit.
    let claims = {};
    try { claims = (await auth.currentUser?.getIdTokenResult())?.claims || {}; } catch (_e) { /* best-effort diagnostic only */ }
    console.info("[WAITER-STAFF-DIAG]", {
      restId: currentRestaurantId,
      authUid: auth.currentUser?.uid || null,
      targetUid: waiterId,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      claimRestId: claims.restId ?? null,
      claimRole: claims.role ?? null,
      claimRtdbUserId: claims.rtdbUserId ?? null,
      claimType: claims.type ?? null,
      claimIsSuperAdmin: claims.isSuperAdmin ?? null,
      restIdMatch: claims.restId != null ? claims.restId === currentRestaurantId : null,
      rtdbUserIdMatch: claims.rtdbUserId != null ? claims.rtdbUserId === waiterId : null,
      path: `${BASE_PATH}/users/${waiterId}`
    });
  }

  loadStaffName();
  startSubscriptionMonitor();

  listenTables();
  listenOrders();
  listenOrderChangeRequestsGlobal();
  listenMenu();
  listenReservations();
  listenRestaurantSettings();
  listenSelfBlockStatus();
  initWaiterChat();

  // ESC — orqaga
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && activeTableKey) window.backToTables();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { init().catch(err => console.error("waiter init() error:", err)); });
} else {
  init().catch(err => console.error("waiter init() error:", err));
}