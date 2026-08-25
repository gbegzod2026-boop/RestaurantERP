import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getDatabase, forceWebSockets, ref, onValue, update, get, runTransaction
} from "./pgRtdb.js";
// 🔒 P0 AUTH FIX (same root cause as waiter.js/kassa.js/chef.js — see
// their own comments for the full trace) — courier.js never imported
// firebase-auth.js at all, so it never had a Firebase Auth session even
// though login.js already signed one in (signInWithCustomToken) before
// redirecting here. Without getAuth(app) + awaiting authStateReady()
// before any read/write, every restaurants/{restId}/... call this file
// makes goes out with NO token — denied by database.rules.json's
// top-level `auth != null` requirement. This is the exact cause of the
// live "permission_denied" errors on users/{courierId} (header staff
// name) and couriers/{courierId} (battery reporting) — NOT a rules or
// data problem (confirmed live: the target records genuinely exist and
// are readable by an authenticated same-restaurant session).
import { getAuth, signInWithCustomToken, setPersistence, inMemoryPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { t, getLang, setLang, applyLang, onLangChange } from "./i18n.js";
import { ORDER_STATUS_V2 } from "./shared.js";
import { deliveryClient } from "./deliveryClient.js";
import { PAYMENT_METHOD_REGISTRY, paymentMethodLabel as engineMethodLabel } from "./paymentEngine.js";
import { setHeaderLogo } from "./header.js";
// 🩹 Talab: "kuryer sahifasidan footerni o'chir" — staff-footer
// (ish vaqti/telefon paneli) endi mount qilinmaydi.

// Force WebSocket-only transport (never fall back to `.lp` long-polling) —
// first executable statement in this module (verified: shared.js/
// deliveryClient.js/paymentEngine.js above have no top-level Firebase calls
// of their own, so there is nothing this could race against, but calling
// it here rather than further down removes any future risk of that).
forceWebSockets();

// ══════════════════════════════════════════════════════
// 🛵 KURYER SAHIFASI (courier.js)
// Arxitektura: Cashier/Kitchen zanjiridan keyingi bosqich —
// buyurtma "yetkazib berish" turida bo'lsa, admin uni kuryerga
// tayinlaydi (restaurants/{id}/courierAssignments/{assignmentId}),
// kuryer bu yerda ko'radi va statusni yangilaydi:
//   assigned → picked_up → in_transit → delivered
// Kuryerning o'z profili restaurants/{id}/couriers/{courierId} da,
// admin.js dagi "Kuryer monitoring" bo'limi shu ikki yo'lni o'qiydi —
// shuning uchun bu yerda yozilgan har bir status admin panelda
// avtomatik va real-vaqtda ko'rinadi.
// ══════════════════════════════════════════════════════

// ─── Buyurtma raqamini formatlash: DVR-1 ───
// admin.js / client.js / waiter.js / chef.js dagi bilan bir xil format —
// barcha panellarda bir xil buyurtma raqami ko'rinishi uchun. courier.js
// har doim yetkazib berish (delivery) buyurtmalari bilan ishlaydi, shuning
// uchun prefiks doim "DVR".
function formatOrderNumber(orderOrNumber) {
  const num = (orderOrNumber && typeof orderOrNumber === "object")
    ? orderOrNumber.orderNumber
    : orderOrNumber;
  if (num === undefined || num === null || num === "") return null;
  return `DVR-${String(num)}`;
}
window.formatOrderNumber = formatOrderNumber;

// ── 1. URL parametrlari va xavfsizlik (waiter.js bilan bir xil pattern) ──
const urlParams = new URLSearchParams(window.location.search);
const viewAsId = urlParams.get("viewAs");
const restIdFromUrl = urlParams.get("rest") || urlParams.get("id");

let currentRestaurantId = restIdFromUrl || localStorage.getItem("restaurantId");
// PIN login (login.js) va boshqa dedicated sahifalar (waiter.js, chef.js)
// bilan bir xil pattern: userId/role har bir brauzer tabi uchun alohida
// bo'lishi kerak bo'lgani sababli sessionStorage'da saqlanadi, faqat
// restaurantId (yuqorida) tab'lar orasida umumiy bo'lgani uchun localStorage'da.
let currentCourierId = sessionStorage.getItem("userId");

if (viewAsId && restIdFromUrl) {
  currentRestaurantId = restIdFromUrl;
  currentCourierId = viewAsId;
  localStorage.setItem("restaurantId", restIdFromUrl);
  sessionStorage.setItem("userId", viewAsId);
  sessionStorage.setItem("role", "courier");
  sessionStorage.setItem("isViewingAsAdmin", "true");
} else {
  const role = sessionStorage.getItem("role");
  if (!currentRestaurantId || !currentCourierId || role !== "courier") {
    console.warn("🚫 Ruxsat yo'q. Login sahifasiga yo'naltirilmoqda...");
    window.location.replace("login.html");
  }
}

const BASE_PATH = `restaurants/${currentRestaurantId}`;

// ── 2. Firebase (loyihaning boshqa panellari bilan bir xil config) ──
const firebaseConfig = {
  apiKey: "AIzaSyCGCCIP3eFg40bOEENDLGcrw9c484ySCHQ",
  authDomain: "restoran-30d51.firebaseapp.com",
  databaseURL: "https://restoran-30d51-default-rtdb.firebaseio.com",
  projectId: "restoran-30d51",
  storageBucket: "restoran-30d51.firebasestorage.app",
  messagingSenderId: "862261129762",
  appId: "1:862261129762:web:5577e6821b4ad7ea4e507b",
  measurementId: "G-8NG56H5ZGG"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const db = getDatabase(app);
// 🔒 P0 AUTH FIX — getAuth(app) triggers automatic session restoration
// from whatever real Firebase Auth session is already persisted for this
// origin (this courier's own, from login.js, or an admin's own session
// when using the "viewAs" shortcut). The DOMContentLoaded boot sequence
// below awaits auth.authStateReady() as its very first step, before any
// Firebase read/write.
const auth = getAuth(app);

// 🩹 P0 root-cause fix (this pass, same as chef.js/waiter.js): viewAs used
// to carry ONLY the cosmetic URL params set above — no real Firebase Auth
// session — silently relying on the calling admin's own session leaking
// into this tab via shared browser storage. That stopped working the
// moment login.js was scoped to tab-local persistence (a separate,
// deliberate fix — see that file's own header comment). admin.js's
// "Sahifaga o'tish" now mints a real session via backend routes/auth.js's
// new /staff-view-as and passes it here as a one-time ssoToken — same
// pattern admin.js's own "Login As" already uses for itself. Must live
// here (after `auth` exists) — this file declares app/db/auth AFTER the
// viewAs block above, not before. Top-level await is legal (this file is
// an ES module) and deliberately blocks the rest of this module's boot
// (which awaits auth.authStateReady() itself, further down) until the
// real session is signed in.
if (viewAsId && restIdFromUrl) {
  const ssoToken = urlParams.get("ssoToken");
  if (ssoToken) {
    try {
      await setPersistence(auth, inMemoryPersistence);
      await signInWithCustomToken(auth, ssoToken);
    } catch (ssoErr) {
      console.warn("[COURIER-AUTH] ssoToken sign-in failed:", ssoErr?.code || ssoErr?.message);
    }
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("ssoToken");
    history.replaceState(null, "", cleanUrl.toString());
  }
}

// ── 3. Holat (state) ──
let _courierProfile = {};
// 🆕 RESTORAN MANZILI — canonical manba: restaurants/{restId}/settings/
// deliverySettings/restaurantAddress (Admin → Sozlamalar → Umumiy →
// "Restoran manzilini xaritada belgilang", mavjud — YANGI schema
// yaratilmadi). initCourierHeader()dagi mavjud real-time settings
// listener orqali to'ldiriladi (pastda), Profil tabida ko'rsatiladi.
let _restaurantAddress = "";
let _assignments = {};
// 🆕 TARIX — barcha kuryerlarning yetkazilgan buyurtmalari. _assignments
// (yuqorida) ATAYLAB faqat joriy kuryerga tegishlilar bilan cheklangan
// (Faol buyurtmalar/Dashboard/Profil — shaxsiy statistika uchun to'g'ri).
// Tarix esa RBAC bo'yicha barcha kuryerlarning yetkazib bergan
// buyurtmalarini ko'rsatishi kerak — shuning uchun xom, filtrlanmagan
// courierAssignments to'liq shu yerda saqlanadi (Firebase Rules
// allaqachon butun tugunni o'qishga ruxsat beradi — mavjud onValue
// aslida hozir ham HAMMASINI o'qiydi, faqat client-side filtrlab
// tashlar edi; rules o'zgartirilmadi).
let _allAssignments = {};
let _historyCourierFilter = "all";
// 🆕 Header bilan bir xil — restaurants/{restId}/users/{userId}dan
// asinxron o'qilgan HAQIQIY ism (initCourierHeader()). Profil tabi ham
// shundan foydalanadi — localStorage.name (mavjud, faqat fallback)
// noto'g'ri/eskirgan bo'lsa ham to'g'ri ism ko'rinishi uchun.
let _courierRealName = "";
let _currentView = "orders";
let _historyRange = "today";
let _dashboardRange = "today";
let _openDetailAssignmentId = null;
let _yandexMapInstance = null;
let _fullMapInstance = null;
let _activeOfferId = null;
let _offerCountdownTimer = null;

// ── Sozlamalar (localStorage'da saqlanadi — faqat shu kuryer qurilmasiga tegishli) ──
const SETTINGS_KEY = "courier_settings_v1";
function loadSettings() {
  try { return { darkMode: false, notifSound: true, navApp: "google", gpsAccuracy: "high", ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
  catch (_e) { return { darkMode: false, notifSound: true, navApp: "google", gpsAccuracy: "high" }; }
}
function saveSettings(patch) {
  const merged = { ..._settings, ...patch };
  _settings = merged;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  applySettings();
}
let _settings = loadSettings();
function applySettings() {
  document.body.classList.toggle("dark-mode", !!_settings.darkMode);
  // 🆕 Header theme-toggle ikonkasi ham sinxron turadi (Profil tabidagi
  // switch orqali o'zgartirilsa ham) — _syncCourierThemeToggleIcon()
  // pastda, initCourierHeader() yonida e'lon qilingan (hoisted).
  if (typeof _syncCourierThemeToggleIcon === "function") _syncCourierThemeToggleIcon();
}

// ══════════════════════════════════════════════════════
// 🚗 5-bosqichli status zanjiri (spec bo'yicha):
// Qabul qilindi → Restoranga ketmoqda → Buyurtma olindi → Yo'lda → Yetkazildi
// RTDB'dagi mavjud "assigned/picked_up/in_transit/delivered" holatlari bilan
// mos kelishi uchun "heading_to_restaurant" va "at_restaurant" ichki
// bosqichlarini courierAssignments/{id}/subStage maydonida saqlaymiz —
// bu orders/{id} statusV2 zanjirini buzmaydi, faqat kuryer UI'sida
// qo'shimcha detallashtirish beradi.
// ══════════════════════════════════════════════════════
// Full spec order-action chain (Accept → Driving to restaurant → Arrived →
// Picked up → Driving → Arrived at customer → Delivered). "Completed" is set
// together with "delivered" (no separate tap) to keep the flow one-handed
// and low-tap, per the UX requirement. Each subStage also mirrors 1:1 into
// orders/{orderId}/delivery.status via _syncEngineStatus, so the admin
// Delivery Panel (DELIVERY_PANEL_STATUS_LABEL in admin.js) shows the exact
// same vocabulary in real time.
const COURIER_STAGE_FLOW = [
  { key: "assigned", subStage: "accepted", label: "courier_stage_accepted", labelDefault: "Qabul qilindi" },
  { key: "assigned", subStage: "heading_to_restaurant", label: "courier_stage_heading_restaurant", labelDefault: "Restoranga ketmoqda" },
  { key: "assigned", subStage: "arrived_restaurant", label: "courier_stage_arrived_restaurant", labelDefault: "Restoranga yetib keldi" },
  { key: "picked_up", subStage: "picked_up", label: "courier_stage_picked_up", labelDefault: "Buyurtma olindi" },
  { key: "in_transit", subStage: "in_transit", label: "courier_stage_in_transit", labelDefault: "Yo'lda" },
  { key: "in_transit", subStage: "arrived_customer", label: "courier_stage_arrived_customer", labelDefault: "Mijozga yetib keldi" },
  { key: "delivered", subStage: "delivered", label: "courier_stage_delivered", labelDefault: "Yetkazildi" }
];

// subStage → orders/{id}/delivery.status value expected by the backend
// Delivery Engine's COURIER_FLOW_ORDER (backend/delivery/common.js).
const SUBSTAGE_TO_ENGINE_STATUS = {
  accepted: "accepted",
  heading_to_restaurant: "heading_to_restaurant",
  arrived_restaurant: "arrived",
  picked_up: "picked_up",
  in_transit: "in_transit",
  arrived_customer: "arrived_customer",
  delivered: "delivered",
};

// Best-effort mirror of a courier stage/status change into the backend
// Delivery Engine (orders/{orderId}/delivery.status) — swallows errors so
// assignments created outside the engine (or before this module existed)
// don't break the existing RTDB-driven flow.
function _syncEngineStatus(orderId, engineStatus) {
  if (!orderId || !engineStatus) return;
  deliveryClient.updateStatus(currentRestaurantId, orderId, engineStatus, currentCourierId).catch(() => {});
}

function _playNotifSound() {
  if (!_settings.notifSound) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (_e) { /* audio unavailable — silent */ }
}

function _currentStageIndex(a) {
  const sub = a.subStage || (a.status === "assigned" ? "accepted" : a.status);
  const idx = COURIER_STAGE_FLOW.findIndex(s => s.subStage === sub);
  return idx === -1 ? 0 : idx;
}

// ══════════════════════════════════════════════════════
// Header: kuryer ismi — waiter.js'dagi loadStaffName() bilan bir xil
// naqsh (sessionStorage/localStorage — faqat darhol ko'rinadigan
// boshlang'ich fallback; restaurants/{restId}/users/{userId} — asinxron
// o'qilib, header HAQIQIY (authenticated) xodim ismi bilan qayta yoziladi
// — admin yoki boshqa xodim nomi noto'g'ri fallback sifatida qolib
// ketmasligi uchun).
// ══════════════════════════════════════════════════════
function initCourierHeader() {
  const nameEl = document.getElementById("courierNameLabel");
  // 🩹 ROOT CAUSE FIX — "Asosiy Boshqaruvchi" (restoran egasi/admin nomi)
  // headerda ko'rinib qolardi: bu fallback avval localStorage.name'ni
  // SESSIONSTORAGE'DAN OLDIN tekshirardi. login.js HECH QACHON
  // localStorage.name'ga yozmaydi (faqat sessionStorage — chunki u har
  // bir brauzer tabi/sessiyasi uchun ALOHIDA, aynan shu fayldagi
  // currentRestaurantId/currentCourierId izohida ham tushuntirilgan
  // sabab bilan). localStorage butun origin bo'yicha UMUMIY va cheksiz
  // saqlanadi — agar shu brauzerda ilgari (masalan boshqa tabda/eski
  // test paytida) localStorage.name qandaydir eski qiymat bilan
  // qolib ketgan bo'lsa (hech qachon tozalanmagan), u HAR DOIM ustun
  // chiqib, joriy sessiyaning haqiqiy sessionStorage.name qiymatini
  // butunlay bekor qilib yuborardi. Endi ustuvorlik to'g'irlandi:
  // sessionStorage (joriy sessiya) BIRINCHI, localStorage FAQAT oxirgi
  // chora sifatida.
  const fallbackName = sessionStorage.getItem("name") || localStorage.getItem("name") || "";
  if (nameEl && fallbackName) nameEl.textContent = fallbackName;

  if (currentCourierId) {
    get(ref(db, `${BASE_PATH}/users/${currentCourierId}`)).then(snap => {
      if (snap.exists()) {
        const staff = snap.val();
        const realName = staff?.name || staff?.fullName || "";
        if (realName) {
          if (nameEl) nameEl.textContent = realName;
          // 🆕 Profil tabi ham shu HAQIQIY ismni ishlatsin (item 24) —
          // avval renderProfileView() faqat localStorage.name'ga ishonardi.
          _courierRealName = realName;
          if (_currentView === "profile") renderProfileView();
        }
      }
    }).catch(e => console.warn("initCourierHeader (staff name):", e?.code || e?.message || e));
  }

  // 🆕 waiter bilan bir xil — restoran nomi markazda ("New"), soat/sana
  // ostida. Avval "Kuryer — RestoranNomi" pastki qator sifatida
  // xodim nomi ustunida edi — endi waiter headeridagi kabi alohida,
  // markaziy blokka ko'chirildi.
  const restEl = document.getElementById("courierHeaderRest");
  // 🩹 waiter.html'ning O'ZI ishlatadigan aniq, to'g'ridan-to'g'ri yo'l
  // (restaurants/{restId}/settings/restaurantName — butun settings/info
  // obyektini emas, faqat shu bitta qiymatni o'qiydi) — pastdagi
  // get(info).then(onValue(settings)) zanjiridan alohida, mustaqil
  // listener sifatida QO'SHILDI (uni ALMASHTIRMAYDI) — ikkalasidan
  // qaysi biri birinchi muvaffaqiyatli bo'lsa, restoran nomi shu bilan
  // to'ldiriladi (masalan settings/info kombinatsiyasi biror sabab bilan
  // kechiksa/muvaffaqiyatsiz bo'lsa ham, shu yagona-maydon so'rovi orqali
  // ko'rinishi kafolatlanadi — canonical manba bir xil, faqat qo'shimcha
  // ishonchlilik qatlami).
  if (restEl) {
    onValue(ref(db, `${BASE_PATH}/settings/restaurantName`), snap => {
      if (snap.exists() && snap.val()) restEl.textContent = snap.val();
    });
  }
  get(ref(db, `${BASE_PATH}/info`)).then(infoSnap => {
    const info = infoSnap.val() || {};
    onValue(ref(db, `${BASE_PATH}/settings`), snap => {
      const settings = snap.val() || {};
      if (restEl) restEl.textContent = settings.restaurantName || info.name || "";
      // 🩹 ROOT CAUSE FIX — courier.html hech qachon setHeaderLogo()ni
      // chaqirmagan edi (waiter/chef/kassa esa allaqachon chaqiradi) —
      // shuning uchun Admin Sozlamalar'da yuklangan haqiqiy restoran
      // logotipi (settings.restaurantLogoUrl) headerda HECH QACHON
      // ko'rinmasdi, doim standart Nesta logosi qolib ketardi. Endi
      // waiter/chef/kassa bilan bir xil canonical manba + funksiya.
      setHeaderLogo("nestaHeaderBrand", settings.restaurantLogoUrl || "");

      // 🆕 RESTORAN MANZILI — Admin canonical deliverySettings.restaurantAddress'ni
      // o'zgartirsa/o'chirsa, shu YAGONA real-time listener orqali refreshsiz
      // yangilanadi (yangi listener yaratilmadi — mavjudiga bitta qo'shimcha
      // qator). localStorage/cache'da nusxa saqlanmaydi — Firebase har doim
      // source-of-truth.
      _restaurantAddress = settings.deliverySettings?.restaurantAddress || "";
      if (_currentView === "profile") renderProfileView();
    });
  }).catch(() => {});
}

// 🩹 ROOT-CAUSE FIX (o'zbek tilida "2026 M08 18" kabi noto'g'ri sana,
// ingliz/rus tillari orasida beqaror almashinish) — avval Intl.
// toLocaleDateString ishlatilardi; "uz-UZ" locale'i uchun ko'p brauzer/
// OS'da to'liq o'zbekcha oy nomlari ICU ma'lumotida yo'q, shuning uchun
// tarjima qilinmagan generik fallback ("M08") chiqardi. Endi oy nomi
// Intl'dan EMAS, loyihaning o'z t()/langs.js kalitlaridan olinadi.
(function initCourierHeaderDateTime() {
  const el = document.getElementById("courierHeaderDateTime");
  if (!el) return;
  const MONTH_KEYS = ["month_jan","month_feb","month_mar","month_apr","month_may","month_jun",
                       "month_jul","month_aug","month_sep","month_oct","month_nov","month_dec"];
  function pad2(n) { return String(n).padStart(2, "0"); }
  function tick() {
    const now = new Date();
    // 🩹 getLang() ishlatiladi (avval localStorage.getItem("lang") —
    // legacy kalit, i18n.js'ning haqiqiy joriy tili "app_lang" kalitida
    // saqlanadi — t() ham shundan o'qiydi). Ikkalasi turli kalit
    // o'qigani uchun ba'zan mos kelmasligi mumkin edi.
    const lang = (typeof getLang === "function" ? getLang() : null) || "uz";
    const monthName = t(MONTH_KEYS[now.getMonth()]);
    const yearSuffix = lang === "ru" ? " г." : "";
    const datePart = `${now.getDate()} ${monthName} ${now.getFullYear()}${yearSuffix}`;
    const timePart = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    el.textContent = `${datePart} · ${timePart}`;
  }
  tick();
  setInterval(tick, 1000);
  // 🩹 ROOT-CAUSE FIX ("2 marta tarjima bo'lish" — til almashtirilganda
  // eski tildagi matn ~1 soniya ko'rinib turardi). Endi til almashishi
  // bilan DARHOL qayta chiziladi.
  if (typeof onLangChange === "function") onLangChange(tick);
})();

// 🆕 Header theme-toggle — waiter bilan bir xil ikonka (fa-moon/fa-sun),
// lekin courier'ning O'ZINING mavjud dark-mode mexanizmini (body.dark-mode,
// _settings.darkMode — Profil tabidagi switch bilan bir xil) chaqiradi.
// Yangi/parallel theme tizimi (masalan data-theme atributi) YARATILMADI —
// courier.css butunlay body.dark-mode klassiga qurilgan, uni o'zgartirish
// katta, ushbu task doirasidan tashqari refactor bo'lar edi.
function _syncCourierThemeToggleIcon() {
  const btn = document.getElementById("courierThemeToggleBtn");
  if (btn) btn.classList.toggle("is-dark", !!_settings.darkMode);
}
window.toggleCourierHeaderTheme = function () {
  saveSettings({ darkMode: !_settings.darkMode });
  _syncCourierThemeToggleIcon();
  // Profil tabidagi switch ham ochiq bo'lsa, u bilan sinxronlashtiramiz.
  if (_currentView === "profile") renderProfileView();
};

window.courierLogout = function () {
  if (!confirm(t("confirm_logout", "Tizimdan chiqmoqchimisiz?"))) return;
  localStorage.removeItem("role");
  localStorage.removeItem("userId");
  localStorage.removeItem("name");
  window.location.replace("login.html");
};

// ══════════════════════════════════════════════════════
// Online / Paused / Offline holatini boshqarish
// couriers/{courierId}/status ga yoziladi — admin monitoringda
// darhol ko'rinadi (COURIER_STATUS_BADGES bilan mos).
// ══════════════════════════════════════════════════════
window.setCourierAvailability = async function (status) {
  if (!currentCourierId) return;
  try {
    await update(ref(db, `${BASE_PATH}/couriers/${currentCourierId}`), {
      status,
      lastSeenAt: Date.now()
    });
    _renderAvailabilityToggle(status);
    showCourierToast(
      status === "online" ? t("courier_now_online", "Siz onlaynsiz") :
      status === "paused" ? t("courier_now_paused", "Tanaffusga chiqdingiz") :
      t("courier_now_offline", "Siz offlaynsiz"),
      "success"
    );
  } catch (err) {
    console.error("setCourierAvailability error:", err);
    showCourierToast(t("notify.error", "Xatolik yuz berdi"), "error");
  }
};

function _renderAvailabilityToggle(status) {
  document.querySelectorAll(".status-toggle-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.status === status);
  });
}

// ── Sahifa yopilganda avtomatik offline qilish (jismoniy qurilma o'chsa ham keyingi ochilishda to'g'irlanadi) ──
// Bug fix: this used to write only lastSeenAt, never status — so a courier
// who closed the tab/app without tapping the offline toggle stayed
// "online" in admin's live courier-monitoring view forever (admin.js has
// no lastSeenAt-staleness fallback; it reads status directly), and could
// keep receiving auto-assigned orders after they were gone.
window.addEventListener("beforeunload", () => {
  if (currentCourierId) {
    update(ref(db, `${BASE_PATH}/couriers/${currentCourierId}`), {
      status: "offline",
      lastSeenAt: Date.now()
    }).catch(() => {});
  }
});

// ══════════════════════════════════════════════════════
// Batareya holati (agar qurilma/brauzer qo'llasa) — couriers/{id}/battery
// Admin monitoringdagi courierBatteryColor() shu qiymatni o'qiydi.
// ══════════════════════════════════════════════════════
async function initBatteryReporting() {
  if (!("getBattery" in navigator)) return;
  try {
    const battery = await navigator.getBattery();
    const report = () => {
      const pct = Math.round(battery.level * 100);
      const chip = document.getElementById("courierBatteryChip");
      const pctEl = document.getElementById("courierBatteryPct");
      if (chip) chip.style.display = "flex";
      if (pctEl) pctEl.textContent = pct;
      if (currentCourierId) {
        update(ref(db, `${BASE_PATH}/couriers/${currentCourierId}`), { battery: pct }).catch(() => {});
      }
    };
    report();
    battery.addEventListener("levelchange", report);
  } catch (_e) { /* getBattery mavjud emas yoki ruxsat berilmagan — sokin o'tkazamiz */ }
}

// ══════════════════════════════════════════════════════
// 📍 Jonli joylashuv (couriers/{id}/lastLocation) — admin.js dagi
// "Kuryer monitoring → Xarita" bo'limi (courierMapView) aynan shu
// maydonni o'qiydi, shuning uchun boshqa hech narsa o'zgartirilmadi.
// watchPosition() 12 soniyada bir marta yozadi (RTDB yozuvlar sonini
// cheklash uchun), brauzer ruxsat so'raganda kuryer rad etsa ham
// ilova ishlashda davom etadi (best-effort, xatolik sokin o'tkaziladi).
// ══════════════════════════════════════════════════════
let _lastLocationWriteAt = 0;
let _geoWatchId = null;

// GPS aniqligi sozlamasi (Settings → GPS accuracy) yozish chastotasi va
// enableHighAccuracy'ga ta'sir qiladi — "past" rejim batareyani tejaydi.
const GPS_ACCURACY_PROFILES = {
  high: { enableHighAccuracy: true, maximumAge: 10000, writeIntervalMs: 12000 },
  balanced: { enableHighAccuracy: true, maximumAge: 20000, writeIntervalMs: 20000 },
  low: { enableHighAccuracy: false, maximumAge: 45000, writeIntervalMs: 45000 },
};

function startLocationReporting() {
  if (!("geolocation" in navigator) || !currentCourierId) return;
  const profile = GPS_ACCURACY_PROFILES[_settings.gpsAccuracy] || GPS_ACCURACY_PROFILES.high;
  _geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const now = Date.now();
      if (now - _lastLocationWriteAt < profile.writeIntervalMs) return;
      _lastLocationWriteAt = now;
      update(ref(db, `${BASE_PATH}/couriers/${currentCourierId}`), {
        lastLocation: {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          heading: pos.coords.heading || null,
          speed: pos.coords.speed || null,
          updatedAt: now
        }
      }).catch(() => {});
    },
    () => { /* ruxsat berilmadi — sokin o'tkazamiz, ilova baribir ishlaydi */ },
    { enableHighAccuracy: profile.enableHighAccuracy, maximumAge: profile.maximumAge, timeout: 15000 }
  );
}

function restartLocationReporting() {
  if (_geoWatchId !== null) navigator.geolocation.clearWatch(_geoWatchId);
  _geoWatchId = null;
  startLocationReporting();
}

window.addEventListener("beforeunload", () => {
  if (_geoWatchId !== null) navigator.geolocation.clearWatch(_geoWatchId);
});

// ══════════════════════════════════════════════════════
// Real-vaqt tinglash: profil + tayinlangan buyurtmalar
// ══════════════════════════════════════════════════════
function listenCourierData() {
  // Bug fix: courier.js had NO subscription/block enforcement at all — a
  // courier already logged in could keep accepting/delivering orders
  // indefinitely after Super Admin blocked/paused the restaurant
  // (window.toggleBlockRestaurant/togglePauseRestaurant in superadmin.js,
  // which writes restaurants/{id}/info/status). Mirrors the same live
  // lockout added to waiter.js/chef.js/kassa.js and the login.js gate.
  onValue(ref(db, `${BASE_PATH}/info/status`), (statusSnap) => {
    const status = statusSnap.val();
    if (status !== "blocked" && status !== "paused") return;
    window.location.href = `expired.html?rest=${encodeURIComponent(currentRestaurantId)}`;
  });

  onValue(ref(db, `${BASE_PATH}/couriers/${currentCourierId}`), (snap) => {
    _courierProfile = snap.exists() ? snap.val() : {};
    _renderAvailabilityToggle(_courierProfile.status || "offline");
  });

  onValue(ref(db, `${BASE_PATH}/courierAssignments`), (snap) => {
    const all = snap.exists() ? snap.val() : {};
    // Faqat shu kuryerga tayinlangan buyurtmalarni olamiz (shaxsiy —
    // Faol buyurtmalar/Dashboard/Profil).
    _assignments = {};
    // 🆕 Tarix uchun — xom, HAMMA kuryerlarga tegishli (item 19/21/35).
    _allAssignments = {};
    Object.entries(all).forEach(([id, a]) => {
      const withId = { ...a, _id: id };
      _allAssignments[id] = withId;
      if (a.courierId === currentCourierId) _assignments[id] = withId;
    });
    renderCourierContent();
    if (_currentView === "history") renderHistoryList();
    if (_currentView === "dashboard") renderDashboard();
    checkForNewOffer();
  });
}

// ══════════════════════════════════════════════════════
// 🔔 Yangi buyurtma taklifi (offer) — Realtime Accept/Reject popup.
// InternalCourierProvider yangi tayinlashni subStage:"accepted_pending" va
// offerExpiresAt bilan yaratadi; kuryer Accept bosguncha bu yozuv asosiy
// "Faol buyurtmalar" ro'yxatida ko'rinmaydi (faqat shu popup orqali).
// Timeout bo'lsa server o'zi keyingi kuryerga qayta yo'naltiradi
// (backend/delivery/engine.js — _scheduleOfferTimeout), shuning uchun bu
// yerdagi countdown faqat vizual — hech qanday yozishni o'zi bajarmaydi.
// ══════════════════════════════════════════════════════
function checkForNewOffer() {
  const pending = Object.values(_assignments)
    .filter(a => a.status === "assigned" && a.subStage === "accepted_pending")
    .sort((a, b) => (a.assignedAt || 0) - (b.assignedAt || 0));

  if (pending.length === 0) {
    if (_activeOfferId) hideOfferPopup();
    return;
  }

  const next = pending[0];
  if (_activeOfferId !== next._id) {
    showOfferPopup(next._id);
  }
}

// Karta HTML'ini alohida chiqarib olindi — til almashtirilganda
// (_relabelOfferPopupOnLangChange) faqat shu qism qayta chiziladi, ovoz
// va countdown intervali qayta ishga tushirilmaydi (pastdagi tick() har
// safar ID orqali elementni qayta izlaydi, shuning uchun innerHTML
// almashtirilsa ham interval ishlashda davom etadi).
function _offerCardHtml(assignmentId, a) {
  const orderNum = formatOrderNumber(a) || `#${String(assignmentId).slice(-4)}`;
  const distanceKm = a.distanceKm != null ? `${Number(a.distanceKm).toFixed(1)} km` : "—";
  const etaMin = a.etaMinutes != null ? `${Math.round(Number(a.etaMinutes))} ${t("minutes_short", "daqiqa")}` : "—";

  return `
    <div class="offer-countdown-wrap"><div class="offer-countdown" id="offerCountdown" style="--pct:100%"><span id="offerCountdownVal">--</span></div></div>
    <div class="offer-title">🛵 ${t("courier_offer_title", "Yangi buyurtma!")} — ${orderNum}</div>
    <div class="offer-row"><span>${t("courier_offer_restaurant", "Restoran")}</span><b>${_escHtml(a.restaurantName || "—")}</b></div>
    <div class="offer-row"><span>${t("courier_offer_customer", "Mijoz")}</span><b>${_escHtml(a.customerName || "—")}</b></div>
    <div class="offer-row"><span>${t("courier_offer_address", "Manzil")}</span><b>${_escHtml(a.address || "—")}</b></div>
    <div class="offer-row"><span>${t("courier_offer_distance", "Masofa")}</span><b>${distanceKm}</b></div>
    <div class="offer-row"><span>${t("courier_offer_eta", "Taxminiy vaqt")}</span><b>${etaMin}</b></div>
    <div class="offer-row"><span>${t("courier_offer_payment", "To'lov usuli")}</span><b>${_escHtml(_paymentMethodLabel(a))}</b></div>
    <div class="offer-row"><span>${t("courier_offer_total", "Summa")}</span><b>${Number(a.total || 0).toLocaleString()} ${t("currency", "so'm")}</b></div>
    <div class="offer-actions">
      <button class="offer-btn reject" onclick="window.rejectOffer('${assignmentId}')">✖️ ${t("courier_offer_reject", "Rad etish")}</button>
      <button class="offer-btn accept" onclick="window.acceptOffer('${assignmentId}')">✓ ${t("courier_offer_accept", "Qabul qilish")}</button>
    </div>
  `;
}

function showOfferPopup(assignmentId) {
  const a = _assignments[assignmentId];
  if (!a) return;
  _activeOfferId = assignmentId;
  _playNotifSound();

  const overlay = document.getElementById("offerOverlay");
  const card = document.getElementById("offerCard");
  if (!overlay || !card) return;

  card.innerHTML = _offerCardHtml(assignmentId, a);
  overlay.classList.add("show");

  clearInterval(_offerCountdownTimer);
  const tick = () => {
    const remainMs = (a.offerExpiresAt || 0) - Date.now();
    const el = document.getElementById("offerCountdown");
    const valEl = document.getElementById("offerCountdownVal");
    if (!el || !valEl) { clearInterval(_offerCountdownTimer); return; }
    if (remainMs <= 0) {
      valEl.textContent = "0";
      el.style.setProperty("--pct", "0%");
      clearInterval(_offerCountdownTimer);
      return;
    }
    const totalMs = Math.max(1, (a.offerExpiresAt || Date.now()) - (a.assignedAt || Date.now() - 25000));
    valEl.textContent = Math.ceil(remainMs / 1000);
    el.style.setProperty("--pct", `${Math.max(0, Math.min(100, (remainMs / totalMs) * 100))}%`);
  };
  tick();
  _offerCountdownTimer = setInterval(tick, 250);
}

// Til almashganda taklif popupi ochiq bo'lsa — ovoz chalinmasdan va
// countdown intervali qayta ishga tushirilmasdan faqat matnlar yangilanadi.
function _relabelOfferPopupOnLangChange() {
  if (!_activeOfferId) return;
  const a = _assignments[_activeOfferId];
  const card = document.getElementById("offerCard");
  if (!a || !card) return;
  card.innerHTML = _offerCardHtml(_activeOfferId, a);
}

function hideOfferPopup() {
  _activeOfferId = null;
  clearInterval(_offerCountdownTimer);
  const overlay = document.getElementById("offerOverlay");
  if (overlay) overlay.classList.remove("show");
}

window.acceptOffer = async function (assignmentId) {
  const a = _assignments[assignmentId];
  if (!a) return;
  const now = Date.now();
  try {
    await update(ref(db, `${BASE_PATH}/courierAssignments/${assignmentId}`), {
      subStage: "accepted",
      subStage_accepted_at: now,
    });
    _syncEngineStatus(a.orderId, "accepted");
    hideOfferPopup();
    showCourierToast(t("courier_offer_accepted_toast", "Buyurtma qabul qilindi!"), "success");
  } catch (err) {
    console.error("acceptOffer error:", err);
    showCourierToast(t("notify.error", "Xatolik yuz berdi"), "error");
  }
};

window.rejectOffer = async function (assignmentId) {
  const a = _assignments[assignmentId];
  if (!a) return;
  hideOfferPopup();
  try {
    await update(ref(db, `${BASE_PATH}/courierAssignments/${assignmentId}`), {
      status: "cancelled",
      subStage: "rejected",
      cancelledAt: Date.now(),
      cancelReason: "courier_rejected",
    });
    if (a.orderId) {
      try { await deliveryClient.reject(currentRestaurantId, a.orderId, currentCourierId, "courier_rejected"); }
      catch (_e) { /* engine-side reassignment best-effort */ }
    }
    showCourierToast(t("courier_reject_success", "Buyurtmadan voz kechildi"), "success");
  } catch (err) {
    console.error("rejectOffer error:", err);
    showCourierToast(t("notify.error", "Xatolik yuz berdi"), "error");
  }
};

// ══════════════════════════════════════════════════════
// 🚚 "Buyurtmani olish" — umumiy poolga tushgan (courierId: null,
// deliverySettings.assignmentMode === "manual" bo'lganda backend
// InternalCourierProvider.js yaratadi) buyurtmani joriy kuryer o'ziga
// oladi. Ikki kuryer bir vaqtda bossa — faqat bittasi yutishi kerak
// (item 6) — shuning uchun oddiy update() emas, BUTUN yozuv ustida
// runTransaction() ishlatiladi (writeUnifiedPayment()dagi payment.paid
// bilan bir xil, mavjud atomik-yozish namunasi): Firebase serveri
// raqobatdosh yozuvlardan faqat BITTASINI qabul qiladi, boshqasi
// avtomatik bekor (abort) qilinadi — race condition frontendda emas,
// server darajasida yopiladi.
// ══════════════════════════════════════════════════════
window.claimUnassignedOrder = async function (assignmentId) {
  // 🩹 sessionStorage — joriy sessiya (to'g'ri manba), localStorage esa
  // faqat oxirgi chora (initCourierHeader()dagi bilan bir xil sabab).
  const courierName = _courierRealName || sessionStorage.getItem("name") || localStorage.getItem("name") || t("courier_role_label", "Kuryer");
  const assignRef = ref(db, `${BASE_PATH}/courierAssignments/${assignmentId}`);
  try {
    const now = Date.now();
    const result = await runTransaction(assignRef, (current) => {
      if (!current) return; // yozuv o'chirilgan/topilmadi — abort
      if (current.courierId) return; // allaqachon olingan — abort
      return {
        ...current,
        courierId: currentCourierId,
        courierName,
        subStage: "accepted",
        subStage_accepted_at: now,
        claimedAt: now,
      };
    });

    if (!result.committed || result.snapshot.val()?.courierId !== currentCourierId) {
      // Boshqa kuryer yutdi (yoki yozuv shu orada yo'qoldi) — real-time
      // onValue(courierAssignments) allaqachon UI'ni qayta chizadi
      // (item 33), bu yerda faqat aniq xabar beriladi (item 5/6/27).
      const winnerName = result.snapshot?.val()?.courierName || "";
      showCourierToast(
        winnerName
          ? t("courier_claimed_by_other", "Bu buyurtmani {name} qabul qilgan").replace("{name}", winnerName)
          : t("courier_claim_failed", "Bu buyurtma allaqachon olingan"),
        "error"
      );
      return;
    }

    const claimedOrderId = result.snapshot.val()?.orderId;
    _syncEngineStatus(claimedOrderId, "accepted");
    showCourierToast(t("courier_claim_success", "Buyurtma sizga biriktirildi!"), "success");
  } catch (err) {
    console.error("claimUnassignedOrder error:", err);
    showCourierToast(t("notify.error", "Xatolik yuz berdi"), "error");
  }
};

// ── "Mavjud buyurtmalar" (umumiy pool, courierId: null) — item 1/5/6. ──
function _renderAvailableOrderCard(id, a) {
  const orderNum = formatOrderNumber(a) || `#${String(id).slice(-4)}`;
  const address = a.address || t("no_address_provided", "Manzil kiritilmagan");
  const customerName = a.customerName || "";
  const total = Number(a.total || 0).toLocaleString();
  const distanceKm = a.distanceKm != null ? `${Number(a.distanceKm).toFixed(1)} km` : "";
  return `
    <div class="assign-card available-card">
      <div class="assign-card-top">
        <span class="assign-order-num">${orderNum}</span>
        <span class="assign-status-chip assigned">🆕 ${t("courier_available_badge", "Mavjud")}</span>
      </div>
      ${customerName ? `<div class="assign-row"><span class="lbl-icon">👤</span><span>${_escHtml(customerName)}</span></div>` : ""}
      <div class="assign-row"><span class="lbl-icon">📍</span><span>${_escHtml(address)}</span>${distanceKm ? ` <span class="assign-distance-chip">${distanceKm}</span>` : ""}</div>
      <div class="assign-total">${total} ${t("currency", "so'm")}</div>
      <div class="assign-actions">
        <button class="assign-btn primary" onclick="window.claimUnassignedOrder('${id}')" style="flex:1;">
          🚚 ${t("take_order", "Buyurtmani olish")}
        </button>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════
// Kontentni chizish
// ══════════════════════════════════════════════════════
// chef.js/waiter.js dagi getLocale()/waiterLocale() bilan bir xil konventsiya.
function courierLocale() {
  const lang = getLang();
  if (lang === "ru") return "ru-RU";
  if (lang === "en") return "en-GB";
  return "uz-UZ";
}

function _escHtml(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// ⚠️ Funksiya sifatida — agar bu doim tayyor obyekt bo'lganida, t() faqat
// modul birinchi yuklanganda bir marta chaqirilib, natija "muzlab" qolar edi
// (til keyin almashtirilsa ham, label eskicha turib qolardi). Har chizishda
// qayta chaqirilishi uchun funksiya qilib olindi.
function _assignStatusLabel(status) {
  const MAP = {
    assigned: { label: t("courier_assign_status_assigned", "Tayinlandi"), icon: "📦" },
    picked_up: { label: t("courier_assign_status_picked_up", "Olib ketildi"), icon: "🛍️" },
    in_transit: { label: t("courier_assign_status_in_transit", "Yo'lda"), icon: "🛵" },
    delivered: { label: t("courier_assign_status_delivered", "Yetkazildi"), icon: "✅" }
  };
  return MAP[status] || MAP.assigned;
}

// ── Bugun boshlangan/kelgan tayinlashlarni aniqlash (mahalliy kun bo'yicha) ──
function _isAssignedToday(a) {
  const ts = a.assignedAt || a.deliveredAt || 0;
  if (!ts) return false;
  const d = new Date(ts);
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
}

function renderCourierContent() {
  const box = document.getElementById("courierContent");
  if (!box) return;

  const entries = Object.entries(_assignments).sort((a, b) => (b[1].assignedAt || 0) - (a[1].assignedAt || 0));

  // "accepted_pending" (not yet Accepted by the courier) is shown exclusively
  // via the New Order popup (checkForNewOffer/showOfferPopup) — not in this list.
  const activeEntries = entries.filter(([, a]) => ["assigned", "picked_up", "in_transit"].includes(a.status) && a.subStage !== "accepted_pending");
  const todaysEntries = entries.filter(([, a]) => _isAssignedToday(a));
  const todaysDelivered = todaysEntries.filter(([, a]) => a.status === "delivered");

  // ── 🚚 Smena statistikasi: bugungi buyurtmalar / yetkazildi / faol / daromad ──
  const todaysEarnings = todaysDelivered.reduce((sum, [, a]) => sum + Number(a.total || 0), 0);

  const elTotal = document.getElementById("shiftStatTotal");
  const elDelivered = document.getElementById("shiftStatDelivered");
  const elActive = document.getElementById("shiftStatActive");
  const elEarnings = document.getElementById("shiftStatEarnings");
  if (elTotal) elTotal.textContent = todaysEntries.length;
  if (elDelivered) elDelivered.textContent = todaysDelivered.length;
  if (elActive) elActive.textContent = activeEntries.length;
  if (elEarnings) elEarnings.textContent = `${todaysEarnings.toLocaleString()} ${t("currency", "so'm")}`;

  const countBadge = document.getElementById("activeOrdersCountBadge");
  if (countBadge) {
    if (activeEntries.length > 0) {
      countBadge.style.display = "inline-block";
      countBadge.textContent = activeEntries.length;
    } else {
      countBadge.style.display = "none";
    }
  }

  // 🆕 "Mavjud buyurtmalar" — umumiy pool (courierId: null,
  // deliverySettings.assignmentMode === "manual" bo'lganda backend
  // yaratadi — InternalCourierProvider.js). _allAssignments (Tarix uchun
  // ham ishlatiladigan, HAMMA kuryerlarga tegishli xom ro'yxat) dan
  // olinadi, chunki _assignments faqat joriy kuryerga tayinlanganlarni
  // saqlaydi (courierId hali null bo'lgan yozuv u yerda umuman yo'q).
  const availableEntries = Object.entries(_allAssignments)
    .filter(([, a]) => !a.courierId && a.subStage === "unassigned" && a.status === "assigned")
    .sort((a, b) => (a[1].assignedAt || 0) - (b[1].assignedAt || 0));

  const availableHtml = availableEntries.length > 0
    ? `<div class="dash-section-title">🆕 ${t("courier_available_orders_title", "Mavjud buyurtmalar")}</div>`
      + availableEntries.map(([id, a]) => _renderAvailableOrderCard(id, a)).join("")
    : "";

  if (activeEntries.length === 0 && availableEntries.length === 0) {
    box.innerHTML = `
      <div class="courier-empty">
        <div class="icon">🛵</div>
        <div>${t("courier_no_active_assignments", "Hozircha sizga buyurtma tayinlanmagan")}</div>
      </div>`;
    return;
  }

  const activeHtml = activeEntries.length > 0
    ? (availableHtml ? `<div class="dash-section-title">🚚 ${t("courier_active_orders_title", "Faol buyurtmalar")}</div>` : "")
      + activeEntries.map(([id, a]) => renderAssignmentCard(id, a)).join("")
    : "";

  box.innerHTML = availableHtml + activeHtml;
}

// ── To'lov usuli matnini aniqlash (Click/Payme/Naqt/va h.k.) ──
// courierAssignments/{id}.paymentMethod is written by client.js's delivery
// checkout using its own ids ("cash_on_delivery"/"click"/"payme"/"uzum"/
// "prepaid_card" — see sendDeliveryOrder/autoAssignCourier), not the
// firebaseKey scheme kassa.js/waiter.js write. _DELIVERY_METHOD_ID_ALIASES
// bridges the two vocabularies so both read from the one shared
// PAYMENT_METHOD_REGISTRY (paymentEngine.js) instead of a second inline list.
const _DELIVERY_METHOD_ID_ALIASES = { cash_on_delivery: "cash", prepaid_card: "visa_mastercard" };
function _paymentMethodLabel(a) {
  if (a.isPrepaid) return t("payment_already_paid", "To'langan");
  if (!a.paymentMethod) return t("payment_cash", "Naqt");
  const id = _DELIVERY_METHOD_ID_ALIASES[a.paymentMethod] || a.paymentMethod;
  return engineMethodLabel(id, t);
}

function renderAssignmentCard(id, a) {
  const statusInfo = _assignStatusLabel(a.status);
  const address = a.address || t("no_address_provided", "Manzil kiritilmagan");
  const customerName = a.customerName || "";
  const total = Number(a.total || 0).toLocaleString();
  const orderNum = formatOrderNumber(a) || `#${String(id).slice(-4)}`;
  const restaurantName = a.restaurantName || t("courier_restaurant_default", "Restoran");
  const paymentMethod = _paymentMethodLabel(a);
  const distanceKm = a.distanceKm != null ? `${Number(a.distanceKm).toFixed(1)} km` : "";

  // ── Karta ustida faqat "Tafsilot" tugmasi — bosqichlarni boshqarish modal ichida ──
  const actionsHtml = `
    <div class="assign-actions">
      <button class="assign-btn primary" onclick="window.openAssignmentDetails('${id}')" style="flex:1;">
        📄 ${t("courier_btn_details", "Tafsilot")}
      </button>
    </div>`;

  return `
    <div class="assign-card status-${a.status}">
      <div class="assign-card-top">
        <span class="assign-order-num">${orderNum}</span>
        <span class="assign-status-chip ${a.status}">${statusInfo.icon} ${statusInfo.label}</span>
      </div>
      ${customerName ? `<div class="assign-row"><span class="lbl-icon">👤</span><span>${_escHtml(customerName)}</span></div>` : ""}
      <div class="assign-row"><span class="lbl-icon">📍</span><span>${_escHtml(address)}</span>${distanceKm ? ` <span class="assign-distance-chip">${distanceKm}</span>` : ""}</div>
      <div class="assign-total">${total} ${t("currency", "so'm")}</div>
      <div class="assign-meta-grid">
        <div class="assign-meta-item">
          <span class="meta-lbl">${t("courier_meta_restaurant", "Restoran")}</span>
          <span class="meta-val">${_escHtml(restaurantName)}</span>
        </div>
        <div class="assign-meta-item">
          <span class="meta-lbl">${t("courier_meta_payment", "To'lov")}</span>
          <span class="meta-val">${_escHtml(paymentMethod)}</span>
        </div>
      </div>
      ${actionsHtml}
    </div>`;
}

// ══════════════════════════════════════════════════════
// 📄 "Tafsilot" tugmasi: buyurtma haqida to'liq modal
// Mijoz, telefon (qo'ng'iroq/Telegram), manzil (xaritada ochish),
// buyurtma tarkibi, izoh, va to'lov usulini ko'rsatadi.
// ══════════════════════════════════════════════════════
function _renderOrderItemsList(a) {
  const items = Array.isArray(a.items) ? a.items : (a.orderItems || []);
  if (!items.length) {
    return `<div style="font-size:13px;color:#94a3b8;padding:10px 0;">${t("no_items_info", "Buyurtma tarkibi haqida ma'lumot yo'q")}</div>`;
  }
  return `
    <div class="cdetail-items-list">
      ${items.map(it => `
        <div class="cdetail-item-row">
          <span>${_escHtml(it.name || it.title || "—")}</span>
          <span class="cdetail-item-qty">x${Number(it.qty || it.quantity || 1)}</span>
        </div>
      `).join("")}
    </div>`;
}

// ── Yetkazish tafsilotlari: Qavat / Podez / Domofon kodi / Mo'ljal / Izoh ──
// (order.deliveryAddress dan InternalCourierProvider tomonidan
// courierAssignments/{id}/addressDetails ga ko'chirilgan — backend/delivery/
// providers/InternalCourierProvider.js).
function _renderDeliveryNotes(a) {
  const d = a.addressDetails || {};
  const rows = [
    d.floor ? [t("delivery_note_floor", "Qavat"), d.floor] : null,
    d.entrance ? [t("delivery_note_entrance", "Podez"), d.entrance] : null,
    d.doorCode ? [t("delivery_note_door_code", "Domofon kodi"), d.doorCode] : null,
    d.landmark ? [t("delivery_note_landmark", "Mo'ljal"), d.landmark] : null,
  ].filter(Boolean);

  if (rows.length === 0) return "";

  return `
    <div class="cdetail-section-title">${t("delivery_notes_title", "Yetkazish tafsilotlari")}</div>
    <div class="assign-meta-grid">
      ${rows.map(([lbl, val]) => `
        <div class="assign-meta-item">
          <span class="meta-lbl">${_escHtml(lbl)}</span>
          <span class="meta-val">${_escHtml(val)}</span>
        </div>`).join("")}
    </div>`;
}

function _renderPaymentChips(a) {
  const rawMethod = (a.paymentMethod || "").toLowerCase();
  const method = _DELIVERY_METHOD_ID_ALIASES[rawMethod] || rawMethod || "cash";
  // Only the delivery-relevant methods from the shared registry (same set
  // client.js's checkout actually offers — see client.js renderDeliveryMethodButtons).
  const chipIds = ["cash", "click", "payme", "uzum"];
  return chipIds.map(id => {
    const def = PAYMENT_METHOD_REGISTRY.find(m => m.id === id);
    const isSelected = method === id || (id === "cash" && !a.paymentMethod && !a.isPrepaid);
    return `<span class="cdetail-payment-chip${isSelected ? " selected" : ""}">${engineMethodLabel(def.firebaseKey, t)}</span>`;
  }).join("");
}

window.openAssignmentDetails = function (assignmentId) {
  // 🆕 Tarix endi barcha kuryerlarning buyurtmalarini ko'rsatadi — shu
  // sababli _assignments (shaxsiy) da topilmasa _allAssignments'dan
  // qaraladi (masalan boshqa kuryer yetkazgan, allaqachon yakunlangan
  // yozuvni ko'rish uchun — tahrirlash tugmalari terminal holatda
  // (delivered) baribir ko'rinmaydi, quyidagi mavjud shartlar orqali).
  const a = _assignments[assignmentId] || _allAssignments[assignmentId];
  if (!a) return;
  _openDetailAssignmentId = assignmentId;

  const orderNum = formatOrderNumber(a) || `#${String(assignmentId).slice(-4)}`;
  const customerName = a.customerName || t("unknown_customer", "Noma'lum mijoz");
  const phone = a.customerPhone || a.phone || "";
  const address = a.address || t("no_address_provided", "Manzil kiritilmagan");
  const telegramUrl = a.customerTelegram
    ? `https://t.me/${String(a.customerTelegram).replace(/^@/, "")}`
    : (phone ? `https://t.me/${phone.replace(/[^\d]/g, "")}` : "");

  const sheet = document.getElementById("cdetailSheet");
  const overlay = document.getElementById("cdetailOverlay");
  if (!sheet || !overlay) return;

  const distanceKm = a.distanceKm != null ? Number(a.distanceKm).toFixed(1) : "—";
  const etaMin = a.etaMinutes != null ? Math.round(Number(a.etaMinutes)) : "—";

  sheet.innerHTML = `
    <div class="cdetail-handle"></div>
    <div class="cdetail-top">
      <span class="cdetail-order-num">${t("order_label", "Buyurtma")} ${orderNum}</span>
      <button class="cdetail-close-btn" onclick="window.closeAssignmentDetails()" aria-label="${t("close_btn", "Yopish")}">✕</button>
    </div>

    <div class="cdetail-section-title">${t("courier_status_title", "Status")}</div>
    ${_renderStageTracker(a)}

    <div class="cdetail-section-title">${t("courier_map_title", "Xarita")}</div>
    <div class="cdetail-map-mini-route">
      <div class="map-node"><span class="map-node-icon">🏪</span><span>${t("courier_meta_restaurant", "Restoran")}</span></div>
      <span class="map-arrow">→</span>
      <div class="map-node"><span class="map-node-icon">📍</span><span>${t("courier_map_route", "Yo'nalish")}</span></div>
      <span class="map-arrow">→</span>
      <div class="map-node"><span class="map-node-icon">👤</span><span>${t("client_label", "Mijoz")}</span></div>
    </div>
    <div id="cdetailYandexMap"></div>
    <div class="cdetail-map-stats">
      <div class="cdetail-map-stat-box">
        <div class="cdetail-map-stat-value">${distanceKm} km</div>
        <div class="cdetail-map-stat-label">${t("courier_map_distance", "Masofa")}</div>
      </div>
      <div class="cdetail-map-stat-box">
        <div class="cdetail-map-stat-value">${etaMin} ${t("minutes_short", "daqiqa")}</div>
        <div class="cdetail-map-stat-label">ETA</div>
      </div>
    </div>

    <div class="cdetail-section-title">${t("client_label", "Mijoz")}</div>
    <div class="cdetail-customer-row">
      <div class="cdetail-customer-info">
        <span class="cdetail-customer-name">${_escHtml(customerName)}</span>
        ${phone ? `<span class="cdetail-customer-phone">${_escHtml(phone)}</span>` : ""}
      </div>
      <div class="cdetail-contact-btns">
        ${phone ? `<a class="cdetail-contact-btn call" href="tel:${_escHtml(phone)}" title="${t("call_label", "Qo'ng'iroq")}">📞</a>` : ""}
        ${telegramUrl ? `<a class="cdetail-contact-btn telegram" href="${telegramUrl}" target="_blank" title="Telegram">✈️</a>` : ""}
      </div>
    </div>

    <div class="cdetail-section-title">${t("address_label", "Manzil")}</div>
    <div class="cdetail-address-row">📍 <span>${_escHtml(address)}</span></div>
    <button class="cdetail-nav-btn" onclick="window.openCourierNavigation('${_escHtml(address)}')">
      🧭 ${t("open_in_maps", "Xaritada ochish")}
    </button>
    ${_renderDeliveryNotes(a)}
    ${a.restaurantPhone ? `
    <button class="cdetail-nav-btn" style="background:#dcfce7;color:#15803d;margin-top:8px;" onclick="window.location.href='tel:${_escHtml(a.restaurantPhone)}'">
      📞 ${t("call_restaurant_label", "Restoranga qo'ng'iroq")}
    </button>` : ""}
    ${_currentStageIndex(a) === 0 ? `
    <button class="cdetail-nav-btn" style="background:#fef2f2;color:#dc2626;margin-top:8px;" onclick="window.rejectAssignment('${a._id}')">
      ✖️ ${t("courier_reject_btn", "Buyurtmadan voz kechish")}
    </button>` : ""}

    <div class="cdetail-section-title">${t("order_items_title", "Buyurtmalar")}</div>
    ${_renderOrderItemsList(a)}

    ${a.note ? `
      <div class="cdetail-section-title">${t("note_label", "Izoh")}</div>
      <div class="cdetail-note-box">📝 ${_escHtml(a.note)}</div>
    ` : ""}

    <div class="cdetail-section-title">${t("payment_label", "To'lov")}</div>
    <div>${_renderPaymentChips(a)}</div>
  `;

  overlay.classList.add("show");
  _initYandexMapForAssignment(a);
};

window.closeAssignmentDetails = function () {
  const overlay = document.getElementById("cdetailOverlay");
  if (overlay) overlay.classList.remove("show");
  _openDetailAssignmentId = null;
  if (_yandexMapInstance) {
    try { _yandexMapInstance.destroy(); } catch (_e) {}
    _yandexMapInstance = null;
  }
};

// ══════════════════════════════════════════════════════
// 🗺 Yandex Map: restoran → yo'nalish → mijoz, ikki marker + chiziq.
// restaurantLocation va customerLocation {lat,lng} courierAssignments
// yozuvida bo'lishi kerak (admin/waiter tayinlashda yozadi). Bo'lmasa,
// xarita o'rniga "koordinata yo'q" holati ko'rsatiladi.
// ══════════════════════════════════════════════════════
function _initYandexMapForAssignment(a) {
  const mapEl = document.getElementById("cdetailYandexMap");
  if (!mapEl) return;

  const restLoc = a.restaurantLocation;
  const custLoc = a.customerLocation;

  if (window.__yandexMapsFailed || typeof ymaps === "undefined") {
    mapEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:12.5px;text-align:center;padding:10px;">${t("map_unavailable", "Xarita hozircha mavjud emas")}</div>`;
    return;
  }

  if (!restLoc || !custLoc) {
    mapEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:12.5px;text-align:center;padding:10px;">${t("map_no_coords", "Koordinatalar mavjud emas")}</div>`;
    return;
  }

  ymaps.ready(() => {
    if (_yandexMapInstance) {
      try { _yandexMapInstance.destroy(); } catch (_e) {}
    }
    const center = [
      (restLoc.lat + custLoc.lat) / 2,
      (restLoc.lng + custLoc.lng) / 2
    ];
    _yandexMapInstance = new ymaps.Map(mapEl, {
      center,
      zoom: 12,
      controls: []
    });

    const restPlacemark = new ymaps.Placemark(
      [restLoc.lat, restLoc.lng],
      { balloonContent: t("courier_meta_restaurant", "Restoran") },
      { preset: "islands#redDotIcon" }
    );
    const custPlacemark = new ymaps.Placemark(
      [custLoc.lat, custLoc.lng],
      { balloonContent: t("client_label", "Mijoz") },
      { preset: "islands#blueDotIcon" }
    );

    _yandexMapInstance.geoObjects.add(restPlacemark);
    _yandexMapInstance.geoObjects.add(custPlacemark);

    ymaps.route([[restLoc.lat, restLoc.lng], [custLoc.lat, custLoc.lng]]).then((route) => {
      route.getPaths().options.set({ strokeColor: "2563ebff", strokeWidth: 4 });
      _yandexMapInstance.geoObjects.add(route);
      _yandexMapInstance.setBounds(_yandexMapInstance.geoObjects.getBounds(), { checkZoomRange: true, zoomMargin: 30 });
    }).catch(() => {
      _yandexMapInstance.setBounds(_yandexMapInstance.geoObjects.getBounds(), { checkZoomRange: true, zoomMargin: 30 });
    });
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.closeAssignmentDetails();
});

// ══════════════════════════════════════════════════════
// 📜 Tarix bo'limi: Bugun / Kecha / Hafta / Oy filtri bilan
// yetkazilgan buyurtmalar ro'yxati (courierAssignments'dan status
// === "delivered" bo'lganlar, deliveredAt bo'yicha filtrlanadi).
// ══════════════════════════════════════════════════════
window.switchCourierView = function (view) {
  _currentView = view;
  const mainView = document.getElementById("mainCourierView");
  const historyView = document.getElementById("historyView");
  const dashboardView = document.getElementById("dashboardView");
  const mapPageView = document.getElementById("mapPageView");
  const profileView = document.getElementById("profileView");

  if (mainView) mainView.style.display = view === "orders" ? "block" : "none";
  if (historyView) historyView.classList.toggle("show", view === "history");
  if (dashboardView) dashboardView.classList.toggle("show", view === "dashboard");
  if (mapPageView) mapPageView.classList.toggle("show", view === "map");
  if (profileView) profileView.classList.toggle("show", view === "profile");

  ["bnavDashboard", "bnavOrders", "bnavMap", "bnavHistory", "bnavProfile"].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle("active", id === `bnav${view.charAt(0).toUpperCase()}${view.slice(1)}`);
  });

  if (view === "history") renderHistoryList();
  if (view === "dashboard") renderDashboard();
  if (view === "map") renderFullMap();
  if (view === "profile") renderProfileView();
};

window.setDashboardRange = function (range) {
  _dashboardRange = range;
  document.querySelectorAll(".dash-range-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.range === range));
  renderDashboard();
};

// ══════════════════════════════════════════════════════
// 🏠 Dashboard: kengaytirilgan statistika (spec: Online/Offline, bugungi
// yetkazmalar, faol, yakunlangan, bekor qilingan, o'rtacha vaqt, daromad,
// reyting). Bugun/Hafta/Oy filtri bilan.
// ══════════════════════════════════════════════════════
function renderDashboard() {
  const grid = document.getElementById("dashboardGrid");
  if (!grid) return;

  const entries = Object.values(_assignments).filter(a => _isWithinHistoryRange(a.deliveredAt || a.cancelledAt || a.assignedAt, _dashboardRange) || (_dashboardRange === "today" && _isAssignedToday(a)));
  const delivered = entries.filter(a => a.status === "delivered");
  const cancelled = entries.filter(a => a.status === "cancelled");
  const active = Object.values(_assignments).filter(a => ["assigned", "picked_up", "in_transit"].includes(a.status) && a.subStage !== "accepted_pending");

  const earnings = delivered.reduce((sum, a) => sum + Number(a.total || 0), 0);
  const avgMs = delivered.length
    ? delivered.reduce((sum, a) => sum + Math.max(0, (a.deliveredAt || 0) - (a.assignedAt || 0)), 0) / delivered.length
    : 0;
  const avgMin = avgMs ? Math.round(avgMs / 60000) : null;
  const isOnline = (_courierProfile.status || "offline") === "online" || (_courierProfile.status || "") === "on_delivery";

  const cards = [
    { value: isOnline ? t("courier_status_online_short", "Ishlayapman") : t("courier_status_offline_short", "Offline"), label: t("profile_field_status", "Holat") },
    { value: entries.length, label: t("courier_shift_stat_total", "Bugungi buyurtmalar") },
    { value: active.length, label: t("courier_shift_stat_active", "Faol") },
    { value: delivered.length, label: t("courier_shift_stat_delivered", "Yetkazildi") },
    { value: cancelled.length, label: t("courier_dash_cancelled_today", "Bekor qilingan") },
    { value: avgMin != null ? `${avgMin} ${t("minutes_short", "daq")}` : "—", label: t("courier_dash_avg_time", "O'rtacha vaqt") },
    { value: `${earnings.toLocaleString()} ${t("currency", "so'm")}`, label: t("courier_shift_stat_earnings", "Daromad") },
    { value: t("courier_dash_rating_soon", "Tez orada"), label: t("courier_dash_rating", "Reyting") },
  ];

  grid.innerHTML = cards.map(c => `
    <div class="dash-card">
      <div class="dash-card-value">${c.value}</div>
      <div class="dash-card-label">${c.label}</div>
    </div>`).join("");
}

// ══════════════════════════════════════════════════════
// 🗺️ Xarita sahifasi: kuryerning joriy joylashuvi + barcha faol
// yetkazmalarning restoran/mijoz nuqtalari bitta xaritada.
// ══════════════════════════════════════════════════════
function renderFullMap() {
  const mapEl = document.getElementById("courierMapFull");
  if (!mapEl) return;

  if (window.__yandexMapsFailed || typeof ymaps === "undefined") {
    mapEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:13px;">${t("map_unavailable", "Xarita hozircha mavjud emas")}</div>`;
    return;
  }

  const active = Object.values(_assignments).filter(a => ["assigned", "picked_up", "in_transit"].includes(a.status) && a.subStage !== "accepted_pending");

  ymaps.ready(() => {
    if (_fullMapInstance) { try { _fullMapInstance.destroy(); } catch (_e) {} }
    const myLoc = _courierProfile.lastLocation;
    const center = myLoc ? [myLoc.lat, myLoc.lng] : (active[0]?.restaurantLocation ? [active[0].restaurantLocation.lat, active[0].restaurantLocation.lng] : [41.311081, 69.240562]);
    _fullMapInstance = new ymaps.Map(mapEl, { center, zoom: 12, controls: ["zoomControl"] });

    if (myLoc) {
      _fullMapInstance.geoObjects.add(new ymaps.Placemark([myLoc.lat, myLoc.lng], { balloonContent: t("courier_role_label", "Kuryer") }, { preset: "islands#greenDotIcon" }));
    }
    active.forEach(a => {
      if (a.restaurantLocation) _fullMapInstance.geoObjects.add(new ymaps.Placemark([a.restaurantLocation.lat, a.restaurantLocation.lng], { balloonContent: a.restaurantName || t("courier_meta_restaurant", "Restoran") }, { preset: "islands#redDotIcon" }));
      if (a.customerLocation) _fullMapInstance.geoObjects.add(new ymaps.Placemark([a.customerLocation.lat, a.customerLocation.lng], { balloonContent: a.customerName || t("client_label", "Mijoz") }, { preset: "islands#blueDotIcon" }));
    });

    if (!active.length && !myLoc) {
      mapEl.insertAdjacentHTML("afterbegin", `<div style="position:absolute;z-index:5;background:#fff;padding:6px 12px;border-radius:8px;font-size:12px;color:#64748b;margin:8px;">${t("courier_map_no_active", "Hozircha faol yetkazma yo'q")}</div>`);
    }
    if (_fullMapInstance.geoObjects.getLength() > 0) {
      _fullMapInstance.setBounds(_fullMapInstance.geoObjects.getBounds(), { checkZoomRange: true, zoomMargin: 40 });
    }
  });
}

// ══════════════════════════════════════════════════════
// 👤 Profil + ⚙️ Sozlamalar
// ══════════════════════════════════════════════════════
function renderProfileView() {
  // 🩹 ROOT CAUSE FIX (item 24) — avval faqat localStorage.name'ga
  // ishonardi (hech qanday Firebase tekshiruvisiz, waiter/kassa'da avval
  // topilgan xatoning aynan bir xili) — endi initCourierHeader() orqali
  // canonical restaurants/{restId}/users/{userId}dan o'qilgan HAQIQIY ism
  // (_courierRealName) ustuvor, faqat u hali kelmagan bo'lsa sessionStorage
  // (joriy sessiya — localStorage EMAS, xuddi yuqoridagi bilan bir xil
  // sabab: localStorage butun origin bo'yicha umumiy, boshqa/eski
  // sessiyadan qolib ketgan noto'g'ri qiymatni ko'rsatib qo'yishi mumkin
  // edi) darhol ko'rinadigan fallback sifatida ishlatiladi.
  const name = _courierRealName || sessionStorage.getItem("name") || "Kuryer";
  const phone = _courierProfile.phone || localStorage.getItem("phone") || "—";
  const statusKey = _courierProfile.status || "offline";
  const statusLabel = {
    online: t("courier_status_online_short", "Ishlayapman"),
    paused: t("courier_status_paused_short", "Tanaffus"),
    on_delivery: t("courier_status_busy_short", "Band"),
    offline: t("courier_status_offline_short", "Offline"),
  }[statusKey] || statusKey;

  document.getElementById("profileNameLg").textContent = name;
  document.getElementById("profileAvatarLg").textContent = name.charAt(0).toUpperCase();
  document.getElementById("profilePhoneLg").textContent = phone;

  document.getElementById("profileInfoList").innerHTML = `
    <div class="profile-row"><span class="profile-row-label">${t("profile_field_name", "Ism")}</span><span class="profile-row-val">${_escHtml(name)}</span></div>
    <div class="profile-row"><span class="profile-row-label">${t("profile_field_phone", "Telefon")}</span><span class="profile-row-val">${_escHtml(phone)}</span></div>
    <div class="profile-row"><span class="profile-row-label">${t("profile_field_status", "Holat")}</span><span class="profile-row-val">${statusLabel}</span></div>
    <div class="profile-row">
      <span class="profile-row-label">${t("profile_field_restaurant_address", "Restoran manzili")}</span>
      <span class="profile-row-val">${_restaurantAddress ? _escHtml(_restaurantAddress) : t("restaurant_address_not_set", "Restoran manzili belgilanmagan")}</span>
    </div>
  `;

  // 🆕 Bugungi statistika (item 23) — Buyurtmalar tabidagi smena kartasi
  // bilan BIR XIL hisoblash (_assignments — shaxsiy, mavjud), yangi
  // parallel hisoblash yaratilmadi.
  const todaysEntries = Object.values(_assignments).filter(_isAssignedToday);
  const todaysDelivered = todaysEntries.filter(a => a.status === "delivered");
  const activeEntries = Object.values(_assignments).filter(a => ["assigned", "picked_up", "in_transit"].includes(a.status) && a.subStage !== "accepted_pending");
  const statsListEl = document.getElementById("profileStatsList");
  if (statsListEl) {
    statsListEl.innerHTML = `
      <div class="profile-row"><span class="profile-row-label">${t("courier_shift_stat_delivered", "Yetkazildi")}</span><span class="profile-row-val">${todaysDelivered.length}</span></div>
      <div class="profile-row"><span class="profile-row-label">${t("courier_shift_stat_active", "Faol")}</span><span class="profile-row-val">${activeEntries.length}</span></div>
      <div class="profile-row"><span class="profile-row-label">${t("courier_shift_stat_total", "Bugungi buyurtmalar")}</span><span class="profile-row-val">${todaysEntries.length}</span></div>
    `;
  }

  const langOptions = ["uz", "ru", "en"].map(l => `<option value="${l}"${getLang() === l ? " selected" : ""}>${l.toUpperCase()}</option>`).join("");

  document.getElementById("profileSettingsList").innerHTML = `
    <div class="profile-row">
      <span class="profile-row-label">${t("profile_field_language", "Til")}</span>
      <select onchange="window.setLang(this.value)">${langOptions}</select>
    </div>
    <div class="profile-row">
      <span class="profile-row-label">${t("settings_dark_mode", "Tungi rejim")}</span>
      <div class="switch-toggle${_settings.darkMode ? " on" : ""}" onclick="window.toggleSetting('darkMode', this)"></div>
    </div>
    <div class="profile-row">
      <span class="profile-row-label">${t("settings_notification_sound", "Bildirishnoma ovozi")}</span>
      <div class="switch-toggle${_settings.notifSound ? " on" : ""}" onclick="window.toggleSetting('notifSound', this)"></div>
    </div>
    <div class="profile-row">
      <span class="profile-row-label">${t("settings_navigation_app", "Navigatsiya ilovasi")}</span>
      <select onchange="window.setStringSetting('navApp', this.value)">
        <option value="google"${_settings.navApp === "google" ? " selected" : ""}>${t("settings_nav_google", "Google Maps")}</option>
        <option value="yandex"${_settings.navApp === "yandex" ? " selected" : ""}>${t("settings_nav_yandex", "Yandex Maps")}</option>
      </select>
    </div>
    <div class="profile-row">
      <span class="profile-row-label">${t("settings_gps_accuracy", "GPS aniqligi")}</span>
      <select onchange="window.setStringSetting('gpsAccuracy', this.value)">
        <option value="high"${_settings.gpsAccuracy === "high" ? " selected" : ""}>${t("settings_gps_high", "Yuqori")}</option>
        <option value="balanced"${_settings.gpsAccuracy === "balanced" ? " selected" : ""}>${t("settings_gps_balanced", "O'rtacha")}</option>
        <option value="low"${_settings.gpsAccuracy === "low" ? " selected" : ""}>${t("settings_gps_low", "Past (batareya tejash)")}</option>
      </select>
    </div>
    <button class="profile-btn-row" onclick="window.showCourierToastPublic()">🔒 ${t("courier_profile_change_password", "Parolni o'zgartirish")}</button>
  `;
}

window.toggleSetting = function (key, el) {
  const next = !_settings[key];
  saveSettings({ [key]: next });
  el.classList.toggle("on", next);
  showCourierToast(t("settings_saved", "Sozlamalar saqlandi"), "success");
  if (key === "darkMode") return;
};

window.setStringSetting = function (key, value) {
  saveSettings({ [key]: value });
  showCourierToast(t("settings_saved", "Sozlamalar saqlandi"), "success");
  if (key === "gpsAccuracy") restartLocationReporting();
};

window.showCourierToastPublic = function () {
  showCourierToast(t("courier_dash_rating_soon", "Tez orada"), "");
};

window.setHistoryRange = function (range) {
  _historyRange = range;
  document.querySelectorAll(".history-filter-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.range === range);
  });
  renderHistoryList();
};

function _isWithinHistoryRange(deliveredAt, range) {
  if (!deliveredAt) return false;
  const d = new Date(deliveredAt);
  const now = new Date();

  if (range === "today") {
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  }
  if (range === "yesterday") {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate();
  }
  if (range === "week") {
    const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    return deliveredAt >= weekAgo;
  }
  if (range === "month") {
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }
  return false;
}

// 🆕 Tarix — barcha kuryer nomlaridan (yetkazilgan buyurtmalarda uchragan)
// filter ro'yxatini quradi. courierName — backend (InternalCourierProvider.js)
// tomonidan assignment yaratilganda allaqachon yoziladi — yangi maydon yo'q.
function _buildHistoryCourierOptions() {
  const names = new Set();
  Object.values(_allAssignments).forEach(a => {
    if (a.status === "delivered" && a.courierName) names.add(a.courierName);
  });
  return [...names].sort((a, b) => a.localeCompare(b));
}

window.setHistoryCourierFilter = function (name) {
  _historyCourierFilter = name || "all";
  renderHistoryList();
};

function renderHistoryList() {
  const box = document.getElementById("historyList");
  if (!box) return;

  // 🆕 Filter select — har safar qayta chizamiz (kuryer ro'yxati vaqt
  // o'tishi bilan o'sishi mumkin: item 20/22 — kuryer bo'yicha filter).
  const filterBox = document.getElementById("historyCourierFilterBox");
  if (filterBox) {
    const names = _buildHistoryCourierOptions();
    filterBox.style.display = names.length > 1 ? "block" : "none";
    filterBox.innerHTML = `
      <select id="historyCourierFilterSelect" class="courier-lang-select" onchange="window.setHistoryCourierFilter(this.value)">
        <option value="all" ${_historyCourierFilter === "all" ? "selected" : ""}>${t("courier_history_filter_all", "Barchasi")}</option>
        ${names.map(n => `<option value="${_escHtml(n)}" ${_historyCourierFilter === n ? "selected" : ""}>${_escHtml(n)}</option>`).join("")}
      </select>`;
  }

  // 🆕 Endi barcha kuryerlarning yetkazilgan buyurtmalari (item 19/35 —
  // RBAC: delivered tarixni har bir kuryer ko'ra oladi), ixtiyoriy kuryer
  // filtri bilan (item 20/22).
  const delivered = Object.entries(_allAssignments)
    .filter(([, a]) => a.status === "delivered" && _isWithinHistoryRange(a.deliveredAt, _historyRange))
    .filter(([, a]) => _historyCourierFilter === "all" || a.courierName === _historyCourierFilter)
    .sort((a, b) => (b[1].deliveredAt || 0) - (a[1].deliveredAt || 0));

  if (delivered.length === 0) {
    box.innerHTML = `
      <div class="courier-empty">
        <div class="icon">📭</div>
        <div>${t("courier_no_delivered_yet", "Hali yetkazilgan buyurtma yo'q")}</div>
      </div>`;
    return;
  }

  box.innerHTML = delivered.map(([id, a]) => {
    const orderNum = formatOrderNumber(a) || `#${String(id).slice(-4)}`;
    const total = Number(a.total || 0).toLocaleString();
    const time = a.deliveredAt
      ? new Date(a.deliveredAt).toLocaleTimeString(courierLocale(), { hour: "2-digit", minute: "2-digit" })
      : "—";
    const date = a.deliveredAt
      ? new Date(a.deliveredAt).toLocaleDateString(courierLocale(), { day: "2-digit", month: "2-digit", year: "numeric" })
      : "—";
    // 🆕 Yetkazgan kuryer ismi (item 21) — har bir yozuvda aniq ko'rinadi,
    // admin/boshqa kuryer ham qaysi kuryer yetkazganini bilishi uchun.
    const courierName = a.courierName || t("unknown_courier", "Noma'lum kuryer");
    return `
      <div class="history-order-row" onclick="window.openAssignmentDetails('${id}')">
        <div class="history-order-left">
          <span class="history-order-num">${orderNum}</span>
          <span class="history-order-courier">👤 ${_escHtml(courierName)} · ${date} ${time}</span>
        </div>
        <div class="history-order-right">
          <span class="history-order-sum">${total} ${t("currency", "so'm")}</span>
          <span class="history-order-status">✅ ${t("courier_assign_status_delivered", "Yetkazildi")}</span>
        </div>
      </div>`;
  }).join("");
}

// ══════════════════════════════════════════════════════
// 🚗 "Keyingi bosqich" — bitta tugma bilan navbatdagi bosqichga o'tish.
// Ichki subStage RTDB'ga yoziladi; real status (assigned/picked_up/
// in_transit/delivered) faqat subStage mos kelganda o'zgaradi — shu
// orqali admin panel va boshqa joylar bilan mosligi saqlanadi.
// ══════════════════════════════════════════════════════
window.advanceCourierStage = async function (assignmentId) {
  const a = _assignments[assignmentId];
  if (!a) return;

  const curIdx = _currentStageIndex(a);
  const nextStage = COURIER_STAGE_FLOW[curIdx + 1];
  if (!nextStage) return;

  const now = Date.now();
  const updates = {
    [`${BASE_PATH}/courierAssignments/${assignmentId}/subStage`]: nextStage.subStage,
    [`${BASE_PATH}/courierAssignments/${assignmentId}/subStage_${nextStage.subStage}_at`]: now
  };

  // Faqat real status chegarasini kesib o'tganda asosiy statusni yozamiz
  if (nextStage.key !== a.status) {
    updates[`${BASE_PATH}/courierAssignments/${assignmentId}/status`] = nextStage.key;
    updates[`${BASE_PATH}/courierAssignments/${assignmentId}/${nextStage.key}At`] = now;

    if (nextStage.key === "picked_up" || nextStage.key === "in_transit") {
      updates[`${BASE_PATH}/couriers/${currentCourierId}/status`] = "on_delivery";
    }

    if (nextStage.key === "delivered") {
      updates[`${BASE_PATH}/couriers/${currentCourierId}/status`] = "online";
      updates[`${BASE_PATH}/courierAssignments/${assignmentId}/deliveredAt`] = now;
      if (a.orderId) {
        updates[`${BASE_PATH}/orders/${a.orderId}/status`] = ORDER_STATUS_V2.SERVED.key;
        updates[`${BASE_PATH}/orders/${a.orderId}/statusKey`] = ORDER_STATUS_V2.SERVED.key;
        updates[`${BASE_PATH}/orders/${a.orderId}/statusV2`] = ORDER_STATUS_V2.SERVED.key;
        updates[`${BASE_PATH}/orders/${a.orderId}/statusLabel`] = ORDER_STATUS_V2.SERVED.labelUz;
        updates[`${BASE_PATH}/orders/${a.orderId}/statusHistory/${ORDER_STATUS_V2.SERVED.key}`] = now;
        updates[`${BASE_PATH}/orders/${a.orderId}/deliveredByCourierId`] = currentCourierId;
      }
    }
  }

  try {
    await update(ref(db), updates);
    _syncEngineStatus(a.orderId, SUBSTAGE_TO_ENGINE_STATUS[nextStage.subStage] || nextStage.subStage);
    if (nextStage.key === "delivered") {
      _syncEngineStatus(a.orderId, "completed");
    }

    if (nextStage.key === "delivered") {
      await calculateCourierKPI(assignmentId, a);
    }

    // Modal ochiq bo'lsa, uni yangi holat bilan qayta chizamiz
    if (_openDetailAssignmentId === assignmentId) {
      setTimeout(() => window.openAssignmentDetails(assignmentId), 50);
    }

    showCourierToast(
      nextStage.key === "delivered"
        ? t("courier_delivered_success", "✅ Buyurtma yetkazildi deb belgilandi!")
        : t("courier_status_updated", "Holat yangilandi"),
      "success"
    );
  } catch (err) {
    console.error("advanceCourierStage error:", err);
    showCourierToast(t("notify.error", "Xatolik yuz berdi"), "error");
  }
};

// ══════════════════════════════════════════════════════
// ✖️ Buyurtmadan voz kechish — faqat hali "qabul qilindi" bosqichigacha
// mumkin (haydab ketgan/olib ketgan buyurtmadan voz kechib bo'lmaydi).
// Backend Delivery Engine (POST /api/delivery/:orderId/reject) ichki
// tayinlashni bekor qilib, avtomatik rejimda boshqa kuryerga yoki
// Yandex Go'ga qayta yo'naltiradi.
// ══════════════════════════════════════════════════════
window.rejectAssignment = async function (assignmentId) {
  const a = _assignments[assignmentId];
  if (!a) return;
  const reason = prompt(t("courier_reject_reason_prompt", "Voz kechish sababi (ixtiyoriy):"), "");
  if (reason === null) return; // bekor qilindi

  try {
    await update(ref(db, `${BASE_PATH}/courierAssignments/${assignmentId}`), {
      status: "cancelled",
      cancelledAt: Date.now(),
      cancelReason: reason || "",
    });
    if (a.orderId) {
      try { await deliveryClient.reject(currentRestaurantId, a.orderId, currentCourierId, reason || ""); }
      catch (_e) { /* Delivery Engine bilan sinxronlanmagan eski tayinlash bo'lishi mumkin — sokin o'tkazamiz */ }
    }
    window.closeAssignmentDetails();
    showCourierToast(t("courier_reject_success", "Buyurtmadan voz kechildi"), "success");
  } catch (err) {
    console.error("rejectAssignment error:", err);
    showCourierToast(t("notify.error", "Xatolik yuz berdi"), "error");
  }
};

function _renderStageTracker(a) {
  const curIdx = _currentStageIndex(a);
  const rows = COURIER_STAGE_FLOW.map((stage, i) => {
    const cls = i < curIdx ? "done" : (i === curIdx ? "current" : "");
    const dotContent = i < curIdx ? "✓" : (i + 1);
    return `
      <div class="cdetail-status-step ${cls}">
        <div class="cdetail-status-dot">${dotContent}</div>
        <div class="cdetail-status-label">${t(stage.label, stage.labelDefault)}</div>
      </div>
      ${i < COURIER_STAGE_FLOW.length - 1 ? `<div class="cdetail-status-arrow">↓</div>` : ""}
    `;
  }).join("");

  const isLast = curIdx >= COURIER_STAGE_FLOW.length - 1;
  // 🎨 UI-only: "Keyingi bosqich" tugmasi barcha bosqichlar uchun umumiy
  // matn ishlatardi. Aynan "picked_up → in_transit" o'tishida (haqiqiy
  // "yo'lga chiqish" lahzasi) endi maxsus "🚚 Yo'lga chiqdim" matni
  // ko'rsatiladi — advanceCourierStage()/subStage/status yozish logikasi
  // bir xil qoladi, faqat shu bitta o'tish uchun tugma matni aniqroq.
  const nextStage = COURIER_STAGE_FLOW[curIdx + 1];
  const isHeadingOut = nextStage && nextStage.subStage === "in_transit";
  const nextBtnLabel = isHeadingOut
    ? `🚚 ${t("courier_btn_heading_out", "Yo'lga chiqdim")}`
    : `${curIdx === COURIER_STAGE_FLOW.length - 2 ? "✅" : "➡️"} ${t("courier_btn_next_stage", "Keyingi bosqich")}`;
  const nextBtn = isLast
    ? ""
    : `<button class="cdetail-next-btn${curIdx === COURIER_STAGE_FLOW.length - 2 ? " success" : ""}" onclick="window.advanceCourierStage('${a._id}')">
        ${nextBtnLabel}
      </button>`;

  // Unable to Deliver / Customer Not Found / Cancel — reachable from any
  // active (non-terminal) stage, not part of the linear next-stage flow.
  const exceptionBtns = isLast ? "" : `
    <div style="display:flex;gap:8px;margin-top:8px;">
      <button class="cdetail-nav-btn" style="flex:1;background:#fffbeb;color:#b45309;" onclick="window.markUnableToDeliver('${a._id}')">
        ⚠️ ${t("courier_action_unable_to_deliver", "Yetkazib bo'lmadi")}
      </button>
      <button class="cdetail-nav-btn" style="flex:1;background:#fef2f2;color:#dc2626;" onclick="window.markCustomerNotFound('${a._id}')">
        ❓ ${t("courier_action_customer_not_found", "Mijoz topilmadi")}
      </button>
    </div>`;

  return `<div class="cdetail-status-track">${rows}</div>${nextBtn}${exceptionBtns}`;
}

async function _finalizeExceptionStatus(assignmentId, status, engineStatus, reason) {
  const a = _assignments[assignmentId];
  if (!a) return;
  try {
    await update(ref(db, `${BASE_PATH}/courierAssignments/${assignmentId}`), {
      status: "cancelled",
      subStage: status,
      cancelledAt: Date.now(),
      cancelReason: reason || "",
    });
    await update(ref(db, `${BASE_PATH}/couriers/${currentCourierId}`), { status: "online" });
    _syncEngineStatus(a.orderId, engineStatus);
    window.closeAssignmentDetails();
    showCourierToast(t("courier_status_updated", "Holat yangilandi"), "success");
  } catch (err) {
    console.error("_finalizeExceptionStatus error:", err);
    showCourierToast(t("notify.error", "Xatolik yuz berdi"), "error");
  }
}

window.markUnableToDeliver = function (assignmentId) {
  const reason = prompt(t("courier_unable_reason_prompt", "Sababini kiriting:"), "");
  if (reason === null) return;
  _finalizeExceptionStatus(assignmentId, "unable_to_deliver", "returned", reason);
};

window.markCustomerNotFound = function (assignmentId) {
  if (!confirm(t("courier_customer_not_found_confirm", "Mijozni \"topilmadi\" deb belgilaysizmi?"))) return;
  _finalizeExceptionStatus(assignmentId, "customer_not_found", "customer_not_found", "");
};
// Har bir o'tish courierAssignments/{id} ga yoziladi, va delivered
// bo'lganda tegishli orders/{orderId} yozuvi ham ORDER_STATUS_V2
// zanjiriga mos ravishda yakunlanadi (SERVED bosqichi sifatida).
// ══════════════════════════════════════════════════════
window.advanceAssignmentStatus = async function (assignmentId, newStatus) {
  const a = _assignments[assignmentId];
  if (!a) return;

  const now = Date.now();
  const updates = {
    [`${BASE_PATH}/courierAssignments/${assignmentId}/status`]: newStatus,
    [`${BASE_PATH}/courierAssignments/${assignmentId}/${newStatus}At`]: now
  };

  // Kuryer profilining umumiy holatini ham moslashtiramiz
  if (newStatus === "picked_up" || newStatus === "in_transit") {
    updates[`${BASE_PATH}/couriers/${currentCourierId}/status`] = "on_delivery";
  }

  if (newStatus === "delivered") {
    updates[`${BASE_PATH}/couriers/${currentCourierId}/status`] = "online";
    updates[`${BASE_PATH}/courierAssignments/${assignmentId}/deliveredAt`] = now;

    // Bog'liq buyurtmani ORDER_STATUS_V2 zanjiri bo'yicha yakunlaymiz
    if (a.orderId) {
      updates[`${BASE_PATH}/orders/${a.orderId}/status`] = ORDER_STATUS_V2.SERVED.key;
      updates[`${BASE_PATH}/orders/${a.orderId}/statusKey`] = ORDER_STATUS_V2.SERVED.key;
      updates[`${BASE_PATH}/orders/${a.orderId}/statusV2`] = ORDER_STATUS_V2.SERVED.key;
      updates[`${BASE_PATH}/orders/${a.orderId}/statusLabel`] = ORDER_STATUS_V2.SERVED.labelUz;
      updates[`${BASE_PATH}/orders/${a.orderId}/statusHistory/${ORDER_STATUS_V2.SERVED.key}`] = now;
      updates[`${BASE_PATH}/orders/${a.orderId}/deliveredByCourierId`] = currentCourierId;
    }
  }

  try {
    await update(ref(db), updates);
    _syncEngineStatus(a.orderId, newStatus);

    // 📊 Kuryer KPI: har bir yakunlangan yetkazish oylik statistikaga yoziladi
    // (finance/courier_stats/{courierId}/{monthKey}) — admin.js dagi umumiy
    // xodim-KPI (calculateStaffKPI) bilan bir xil finance/ shajarasida,
    // shuning uchun moliyaviy hisobotlar ikkalasini ham birga ko'ra oladi.
    if (newStatus === "delivered") {
      await calculateCourierKPI(assignmentId, a);
    }

    showCourierToast(
      newStatus === "delivered"
        ? t("courier_delivered_success", "✅ Buyurtma yetkazildi deb belgilandi!")
        : t("courier_status_updated", "Holat yangilandi"),
      "success"
    );
  } catch (err) {
    console.error("advanceAssignmentStatus error:", err);
    showCourierToast(t("notify.error", "Xatolik yuz berdi"), "error");
  }
};

// ══════════════════════════════════════════════════════
// 📊 Kuryer KPI hisoblash
// Har bir yetkazilgan buyurtma uchun: yetkazishlar soni, jami summa,
// va (agar kuryer komissiya foizi belgilangan bo'lsa) topilgan pul.
// Admin.js dagi finance/staff_stats bilan bir xil oy-kalitli (monthKey)
// tuzilmada — shuning uchun mavjud moliyaviy hisobot ekranlari buni ham
// ko'rsatishi mumkin, faqat yo'l nomi courier_stats.
// ══════════════════════════════════════════════════════
async function calculateCourierKPI(assignmentId, assignment) {
  const monthKey = new Date().toISOString().slice(0, 7);
  try {
    const assignSnap = await get(ref(db, `${BASE_PATH}/courierAssignments/${assignmentId}`));
    if (!assignSnap.exists() || assignSnap.val().kpiCalculated) return;

    const courierSnap = await get(ref(db, `${BASE_PATH}/users/${currentCourierId}`));
    const courierUser = courierSnap.exists() ? courierSnap.val() : {};
    const total = Number(assignment.total || 0);

    // Kuryer uchun ham xodimlar bilan bir xil komissiya-rejimi ishlatiladi
    // (agar sozlanmagan bo'lsa, faqat yetkazishlar soni hisoblanadi, pul yo'q)
    const mode = courierUser.salaryMode || "fixed";
    const earned = mode === "percent"
      ? (total * Number(courierUser.commissionPercent || 0)) / 100
      : Number(courierUser.perDeliveryFee || 0);

    // runTransaction (not get()+update()): two deliveries completing close
    // together used to race here — the second get() could read the stats
    // before the first update() landed, silently dropping that delivery's
    // earnings/count from the monthly total.
    const statsRef = ref(db, `${BASE_PATH}/finance/courier_stats/${currentCourierId}/${monthKey}`);
    await runTransaction(statsRef, (cur) => {
      cur = cur || { totalEarned: 0, deliveryCount: 0, totalDeliveredSum: 0 };
      return {
        totalEarned: (cur.totalEarned || 0) + earned,
        deliveryCount: (cur.deliveryCount || 0) + 1,
        totalDeliveredSum: (cur.totalDeliveredSum || 0) + total,
        lastUpdate: Date.now()
      };
    });

    await update(ref(db, `${BASE_PATH}/courierAssignments/${assignmentId}`), { kpiCalculated: true });
  } catch (err) {
    console.error("calculateCourierKPI error:", err);
  }
}

// ══════════════════════════════════════════════════════
// Xaritada ochish (Google Maps yo'nalish)
// ══════════════════════════════════════════════════════
window.openCourierNavigation = function (address) {
  const url = _settings.navApp === "yandex"
    ? `https://yandex.com/maps/?text=${encodeURIComponent(address)}&rtext=~${encodeURIComponent(address)}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
  window.open(url, "_blank");
};

// ══════════════════════════════════════════════════════
// Toast xabarnoma
// ══════════════════════════════════════════════════════
let _toastTimer = null;
function showCourierToast(msg, type = "") {
  const el = document.getElementById("courierToast");
  if (!el) return;
  el.textContent = msg;
  el.className = "show" + (type ? " " + type : "");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.classList.remove("show"); }, 2600);
}

// ══════════════════════════════════════════════════════
// Ishga tushirish
// ══════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", async () => {
  if (!currentRestaurantId || !currentCourierId) return; // login.html ga allaqachon yo'naltirilgan

  // Header'dagi til selektori — waiter.js/chef.js bilan bir xil ulanish
  // patterni (id="langSelect" ni topib, joriy tilni ko'rsatadi va
  // o'zgarganda mavjud global setLang() ni chaqiradi — yangi mexanizm yo'q).
  const langSelect = document.getElementById("langSelect");
  if (langSelect) {
    langSelect.value = getLang();
    langSelect.addEventListener("change", e => setLang(e.target.value));
  }

  applyLang(getLang());
  applySettings();

  // 🔒 P0 AUTH FIX — pastdagi HAR QANDAY Firebase o'qish/yozishdan oldin
  // (birinchisi initCourierHeader() ichida) shu yerda kutamiz — waiter.js
  // init()dagi bilan bir xil, yagona joy.
  try {
    await auth.authStateReady();
  } catch (err) {
    console.warn("[COURIER-AUTH] authStateReady() failed:", err?.code || err?.message);
  }

  initCourierHeader();
  listenCourierData();
  initBatteryReporting();
  startLocationReporting();
  renderCourierContent();
  window.switchCourierView("orders");
});

// ══════════════════════════════════════════════════════
// 🌐 Til almashtirilganda: sahifa qayta yuklanmaydi, faqat statik
// (data-i18n) va dinamik (JS orqali chizilgan) qismlar qayta chiziladi.
// Firebase tinglovchilari (listenCourierData), GPS/battery reporting va
// mavjud taymerlar (offer countdown) TEGILMAYDI — faqat matn yangilanadi,
// joriy holat (faol view, ochiq detallar/taklif modali, filtrlar) saqlanadi.
// ══════════════════════════════════════════════════════
// Har bir qadam alohida try/catch bilan izolyatsiya qilingan — aks holda
// (masalan) renderCourierContent() xato bersa, undan keyingi barcha
// qadamlar (tarix, statistika, xarita, taklif popupi, ochiq buyurtma
// detali) qayta chizilmay qolardi — "til faqat refresh'dan keyin ishlaydi"
// muammosining aynan shu yerdagi sababi (batafsil: i18n.js setLang()dagi
// izoh — Admin/SuperAdmin/Waiter/Chef/Client panellarida topilgan va
// tuzatilgan bitta umumiy sababning Courier panelidagi ko'rinishi). Bitta
// qadam xato bersa ham, qolganlari baribir ishlaydi.
onLangChange(() => {
  const _step = (label, fn) => {
    try { fn(); } catch (err) { console.error(`[i18n] courier.js "${label}" failed during language switch:`, err); }
  };

  _step("applyLang", () => applyLang());
  _step("renderCourierContent", () => renderCourierContent());
  _step("renderHistoryList", () => { if (_currentView === "history") renderHistoryList(); });
  _step("renderDashboard", () => { if (_currentView === "dashboard") renderDashboard(); });
  _step("renderFullMap", () => { if (_currentView === "map") renderFullMap(); });
  _step("renderProfileView", () => { if (_currentView === "profile") renderProfileView(); });
  _step("_relabelOfferPopupOnLangChange", () => _relabelOfferPopupOnLangChange());
  _step("openAssignmentDetails relabel", () => { if (_openDetailAssignmentId) window.openAssignmentDetails(_openDetailAssignmentId); });
});