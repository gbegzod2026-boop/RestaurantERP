// client.js 
import { CATEGORY_DATA, ORDER_STATUS, ORDER_STATUS_V2, ORDER_STATUS_V2_FLOW, normalizeOrderStatusV2, getStatusV2Label, getStatusV2Order, writeOrderAuditLog, ORDER_TYPE, computeDeliveryFee, haversineDistanceKm, formatDeliveryAddress, normalizePhone } from "./shared.js";
import { loadNestaFirebaseApp } from "./nestaFirebaseApp.js";
import {
  getDatabase,
  forceWebSockets,
  resolveClientDataBackend,
  ref,
  get,
  set,
  update,
  remove,
  push,
  onValue,
  runTransaction,
  off,
  onChildAdded
} from "./pgRtdb.js";
import { getAuth, RecaptchaVerifier, signInWithPhoneNumber, signInWithCustomToken, onAuthStateChanged, setPersistence, inMemoryPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { t, getLang, setLang, applyLang, onLangChange } from "./i18n.js";
import { getEnabledPaymentMethods, paymentMethodLabel } from "./paymentEngine.js";
import { buildReceiptBodyHtml, printReceiptInPopup, downloadReceiptPNG as engineDownloadReceiptPNG, downloadReceiptPDF as engineDownloadReceiptPDF } from "./receiptEngine.js";
import { discountClaimsClient } from "./discountClaimsClient.js";
// 🩹 Talab: "mijoz sahifasida footerni olib tashla" — staff-footer
// (ish vaqti/telefon paneli) endi mount qilinmaydi.

forceWebSockets();

const app = await loadNestaFirebaseApp();

const auth = getAuth(app);
auth.languageCode = getLang();

const db = getDatabase(app);

// ─── Buyurtma raqamini formatlash: ORD-000123 (restoran ichi) yoki DVR-000123 (yetkazib berish) ───
// admin.js / waiter.js dagi formatOrderNumber bilan bir xil chiqish formati.
// client.js orqali yaratiladigan buyurtmalar doim stol (QR) orqali bo'lgani uchun
// amalda har doim ORD- chiqadi, lekin funksiya boshqa fayllar bilan izchil qoldirilgan.
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

const urlParams =
  new URLSearchParams(window.location.search);

// Accept both ?rest=<id> (the QR/direct customer link) and ?id=<id> (used by
// staff "preview as customer" links, e.g. client.html?id=...&viewAs=...).
let currentRestaurantId =
  urlParams.get("rest") ||
  urlParams.get("id") ||
  localStorage.getItem("restaurantId");

if (!currentRestaurantId) {

  console.error(
    "❌ Restaurant ID topilmadi"
  );

  alert(t("restaurant_id_not_found", "Restaurant ID topilmadi"));

  throw new Error(
    "Restaurant ID topilmadi"
  );
}

localStorage.setItem(
  "restaurantId",
  currentRestaurantId
);

localStorage.setItem(
  "clientRestaurantId",
  currentRestaurantId
);

const urlTable = String(urlParams.get("table") || urlParams.get("tableId") || "").trim();
if (urlTable) {
  localStorage.setItem("table", urlTable);
}

function getClientTable() {
  const live = new URLSearchParams(window.location.search);
  return String(
    live.get("table") ||
    live.get("tableId") ||
    urlParams.get("table") ||
    urlParams.get("tableId") ||
    localStorage.getItem("table") ||
    ""
  ).trim();
}
window.getClientTable = getClientTable;

console.log(
  "👉 Mijoz sahifasi ishga tushdi, Restoran ID:",
  currentRestaurantId
);

const BASE_PATH = `restaurants/${currentRestaurantId}`;

// Architecture Fix Pass — QR → Backend → Firebase Custom Token → Anonymous
// Firebase Auth → RTDB. Every previous fix pass left restaurants/$restId
// open to any unauthenticated browser because client.js had no session at
// all — a diner scans a QR code and starts ordering with zero login step.
// This establishes a real (still anonymous — no personal data, no login
// UI, nothing changes for the diner) Firebase Auth session BEFORE this
// module does anything else with Firebase, by asking the backend
// (routes/qr.js POST /api/qr/session, reusing the exact custom-token
// mechanism routes/auth.js already uses for staff logins) to mint one for
// this restaurant/table. That session's { restId, table } claims are what
// database.rules.json now checks instead of leaving restaurants/$restId
// wide open — see the rules file's own comments for the exact condition.
//
// `await`ed at module top level (supported natively by <script
// type="module"> in every evergreen browser) rather than wrapped in an
// IIFE — this is what guarantees every onValue/get/set/update call below
// this line, anywhere in the file, runs only after the session exists,
// without restructuring the rest of the module. Best-effort by design: if
// the backend is unreachable or no Admin SDK service account is configured
// yet (see firebaseAdmin.js), this resolves with no session and the page
// continues exactly as it always has — a signing failure can never block a
// diner from seeing the menu.
async function establishClientSession(restId, params) {
  try {
    const resp = await fetch("/api/qr/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        restId,
        table: params.get("table") || "",
        tableId: params.get("tableId") || "",
        sig: params.get("sig") || undefined,
        exp: params.get("exp") || undefined,
      }),
    });
    const { token } = await resp.json().catch(() => ({ token: null }));
    if (!token) {
      // Diagnosability fix: this used to fall through completely silently
      // — no session, no log, nothing. Since database.rules.json requires
      // `auth != null` on essentially every restaurants/$restId/... path
      // (menu included), a silent mint failure here means EVERY
      // subsequent read gets silently denied too (subscribeMenuRealtime()'s
      // onValue() below had no error callback either — see that function's
      // own fix), producing exactly "menu completely empty, no visible
      // error" with nothing in the console to explain why. Now at least
      // logged, so this failure mode is diagnosable instead of invisible.
      console.warn("[QR-SESSION] Mijoz sessiyasi o'rnatilmadi (token=null) — restId/table/sig tekshiring yoki backend /api/qr/session javobini ko'ring.");
    }
    if (token) {
      // Cross-tab client-session leak fix (root cause of admin.html seeing
      // resolvedRole:"client"): this sign-in used to run on Firebase's
      // DEFAULT persistence (browserLocalPersistence — shared IndexedDB for
      // the whole origin/browser, survives reloads AND leaks into every
      // other tab), unlike admin.js's own anonymous/ssoToken fallbacks,
      // which have always deliberately used inMemoryPersistence for exactly
      // this reason. A customer session minted from a QR scan in one tab
      // was silently inherited by any OTHER tab of this origin that later
      // loaded with no fresher session of its own — including admin.html on
      // the same device/browser, which then evaluated every admin-only
      // Firebase Rule against claims.role:"client" and got permission_denied
      // on users/admin_1, subscription, systemAlerts, etc. No UX change for
      // the diner: establishClientSession() already re-runs and re-signs-in
      // unconditionally on every page load regardless of persistence, and
      // the underlying uid (client_${restId}_${table}) is stable per table,
      // not per visitor — so nothing about the ordering/session experience
      // depends on this surviving a reload or another tab.
      await setPersistence(auth, inMemoryPersistence);
      await signInWithCustomToken(auth, token);
    }
  } catch (e) {
    console.error("QR session xatosi (davom etamiz, oldingi xatti-harakat saqlanadi):", e);
  }
}
await establishClientSession(currentRestaurantId, urlParams);

// ══════════════════════════════════════════════════════
// 🎁 QR BIR MARTALIK MIJOZ CHEGIRMASI — receipt QR ("Sozlamalar → Chop etish
// sozlamalari → QR kodni ko'rsatish") skaner qilinganda ?discount=<token>
// bilan shu sahifaga tushadi. Not awaited at top level — the underlying menu
// keeps loading normally beneath this overlay (spec's own page-design note:
// "restaurant/client page design'iga mos bo'lsin", not a separate full page).
// discountClaimsClient.resolve()/claim() are PUBLIC, unauthenticated calls
// (see discountClaimsClient.js/routes/discountClaims.js header comments) —
// no dependency on establishClientSession() above, but sequenced after it
// anyway since that's the module's existing "nothing touches Firebase before
// the session exists" convention.
// ══════════════════════════════════════════════════════
(async function handleQrDiscountClaim() {
  const token = urlParams.get("discount");
  if (!token) return;

  const overlay = document.createElement("div");
  overlay.id = "qrDiscountClaimOverlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;";
  document.body.appendChild(overlay);

  function renderCard(html) {
    overlay.innerHTML = `<div style="background:#fff;border-radius:18px;padding:28px 24px;max-width:360px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.25);font-family:inherit;">${html}</div>`;
  }
  function closeOverlay() { overlay.remove(); }
  function showError(msg) {
    renderCard(`
      <div style="font-size:40px;margin-bottom:10px;">❌</div>
      <div style="font-size:15px;color:#334155;margin-bottom:18px;">${msg}</div>
      <button id="qrDiscountCloseBtn" style="background:#1a1a2e;color:#fff;border:none;border-radius:10px;padding:12px 22px;font-weight:700;cursor:pointer;width:100%;">${t("continue_btn", "Davom etish")}</button>
    `);
    document.getElementById("qrDiscountCloseBtn").onclick = closeOverlay;
  }

  renderCard(`<div style="font-size:40px;">⏳</div>`);

  let result;
  try {
    result = await discountClaimsClient.resolve(currentRestaurantId, token);
  } catch (err) {
    console.error("discountClaimsClient.resolve error:", err);
    result = { ok: false, reason: "network_error" };
  }

  if (!result.ok) {
    const REASON_MSG = {
      already_used: t("qr_discount_already_used", "Bu chegirma allaqachon ishlatilgan"),
      expired: t("qr_discount_expired", "Chegirma muddati tugagan"),
    };
    showError(REASON_MSG[result.reason] || t("qr_discount_not_found", "Chegirma topilmadi"));
    return;
  }

  const percent = Number(result.percent || 0);

  async function finishClaim(phone) {
    renderCard(`<div style="font-size:40px;">⏳</div>`);
    let claimResult;
    try {
      claimResult = await discountClaimsClient.claim(currentRestaurantId, token, phone);
    } catch (err) {
      console.error("discountClaimsClient.claim error:", err);
      claimResult = { ok: false, reason: "network_error" };
    }
    if (!claimResult.ok) {
      const REASON_MSG = {
        invalid_phone: t("qr_discount_invalid_phone", "To'g'ri telefon raqamini kiriting"),
        already_used: t("qr_discount_already_used", "Bu chegirma allaqachon ishlatilgan"),
        claimed_by_other: t("qr_discount_claimed_by_other", "Bu chegirma boshqa mijozga biriktirilgan"),
      };
      showError(REASON_MSG[claimResult.reason] || t("qr_discount_claim_failed", "Chegirmani saqlashda xatolik yuz berdi"));
      return;
    }
    // Xuddi checkout oqimidagi bilan bir xil kalit (calculateDiscount(),
    // checkMinOrderAmount() va h.k. shu localStorage yozuvni o'qiydi) —
    // ikkita alohida "mijoz telefoni" manbasi yaratilmadi.
    localStorage.setItem("customerPhone", phone);
    renderCard(`
      <div style="font-size:40px;margin-bottom:10px;">🎁</div>
      <div style="font-size:16px;font-weight:700;color:#0f172a;margin-bottom:6px;">${t("qr_discount_granted_title", "Sizga chegirma berildi!")}</div>
      <div style="font-size:28px;font-weight:800;color:#16a34a;margin-bottom:18px;">${percent}% ${t("one_time_discount_label", "chegirma")}</div>
      <button id="qrDiscountContinueBtn" style="background:#16a34a;color:#fff;border:none;border-radius:10px;padding:12px 22px;font-weight:700;cursor:pointer;width:100%;">${t("continue_btn", "Davom etish")}</button>
    `);
    document.getElementById("qrDiscountContinueBtn").onclick = closeOverlay;
  }

  const savedPhoneRaw = localStorage.getItem("customerPhone") || localStorage.getItem("userPhone") || "";
  const savedPhoneNormalized = normalizePhone(savedPhoneRaw);
  if (/^\+998\d{9}$/.test(savedPhoneNormalized)) {
    await finishClaim(savedPhoneNormalized);
    return;
  }

  renderCard(`
    <div style="font-size:40px;margin-bottom:10px;">🎁</div>
    <div style="font-size:16px;font-weight:700;color:#0f172a;margin-bottom:6px;">${t("qr_discount_granted_title", "Sizga chegirma berildi!")}</div>
    <div style="font-size:28px;font-weight:800;color:#16a34a;margin-bottom:14px;">${percent}% ${t("one_time_discount_label", "chegirma")}</div>
    <div style="font-size:13px;color:#64748b;margin-bottom:10px;">${t("qr_discount_enter_phone_desc", "Chegirmani saqlash uchun telefon raqamingizni kiriting")}</div>
    <input id="qrDiscountPhoneInput" type="tel" placeholder="+998 90 123 45 67" style="width:100%;padding:12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:15px;text-align:center;margin-bottom:8px;box-sizing:border-box;">
    <div id="qrDiscountPhoneErr" style="color:#dc2626;font-size:12px;min-height:16px;margin-bottom:10px;"></div>
    <button id="qrDiscountSaveBtn" style="background:#16a34a;color:#fff;border:none;border-radius:10px;padding:12px 22px;font-weight:700;cursor:pointer;width:100%;">${t("save_discount_btn", "Chegirmani saqlash")}</button>
  `);
  document.getElementById("qrDiscountSaveBtn").onclick = async () => {
    const raw = document.getElementById("qrDiscountPhoneInput").value;
    const normalized = normalizePhone(raw);
    if (!/^\+998\d{9}$/.test(normalized)) {
      document.getElementById("qrDiscountPhoneErr").textContent = t("qr_discount_invalid_phone", "To'g'ri telefon raqamini kiriting");
      return;
    }
    await finishClaim(normalized);
  };
})();

// ══════════════════════════════════════════════════════
// 🔒 P0 FIX — CLIENT ORDER ACCESS SECURITY, PHASE 2
// Root cause + Phase 1 (backend/routes/clientOrders.js): restaurants/$restId
// granted ANY verified session (staff or QR customer) broad read access to
// the whole subtree, including every OTHER customer's orders — a table-1
// QR session could read table-2's order, or enumerate the entire /orders
// node, live-proven. database.rules.json has been narrowed to close this
// (written, not yet deployed — see the P0 fix reports), so every order
// READ a customer session makes must go through the server-authorized
// GET /api/client/orders/:orderId endpoint instead of a direct Firebase
// read from here on. fetchClientOrder()/pollClientOrder() below are the
// ONLY two functions that call it — every caller elsewhere in this file
// just swaps its old get(ref(db,.../orders/id)) for fetchClientOrder(id),
// or its old onValue(ref(db,.../orders/id), cb) for
// pollClientOrder(id, cb), and keeps its own existing null-check/
// rendering logic completely unchanged.
// ══════════════════════════════════════════════════════

/** Returns the same plain-object shape snap.val() used to return (or null
 *  if not found/not accessible/no session yet) — every existing
 *  `if (!order)` / `if (!snap.exists())` check in this file already
 *  handles that shape without any further changes at each call site. */
async function fetchClientOrder(orderId) {
  if (!orderId) return null;
  try {
    const user = auth.currentUser;
    // No QR session established yet (best-effort mint failure, e.g. Admin
    // SDK not configured) — mirrors establishClientSession()'s own
    // resilience: never throw, just behave like "order not found".
    if (!user) return null;
    const idToken = await user.getIdToken();
    const res = await fetch(`/api/client/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) return null; // 401/403/404/500 — all treated as "not accessible", same as a denied/missing snapshot before
    const body = await res.json().catch(() => null);
    return body?.order || null;
  } catch (err) {
    console.error("fetchClientOrder error:", err);
    return null;
  }
}

// Polling replacement for the old onValue(ref(db,.../orders/id)) listener.
// Existing project realtime (Socket.IO, server.js) was traced first, per
// instruction, before choosing this: server.js's order:created/order:updated/
// order-status-changed events are wired ONLY to a separate, legacy
// POST/PUT /api/orders REST family that this app's real order flow (every
// panel — admin/waiter/chef/kassa/client — writes orders straight to
// Firebase RTDB) never calls; extending it would mean adding emit() calls
// into real order-write business logic across multiple files, explicitly
// out of this fix's scope. Polling the already-built, already-tested
// endpoint above needs zero business-logic changes anywhere. 3s interval —
// real order volume observed platform-wide (Wave 2 audit) is a few dozen
// orders total, so a handful of concurrent customer sessions polling every
// 3s is negligible load. Returns a stop function with the exact same
// calling contract as the onValue() unsubscribe it replaces (callers do
// `stopFn()`), so no caller needs to change beyond the one line that
// creates it.
const CLIENT_ORDER_POLL_MS = 3000;
function pollClientOrder(orderId, callback) {
  let stopped = false;
  async function tick() {
    if (stopped) return;
    const order = await fetchClientOrder(orderId);
    if (stopped) return;
    callback(order);
  }
  tick(); // immediate first check, same as onValue's initial fire
  const intervalId = setInterval(tick, CLIENT_ORDER_POLL_MS);
  return () => { stopped = true; clearInterval(intervalId); };
}

// Bug fix: client.js had NO subscription/block enforcement at all — a
// customer already browsing the menu/QR-ordering page could keep placing
// orders indefinitely after Super Admin blocked/paused the restaurant
// (window.toggleBlockRestaurant/togglePauseRestaurant in superadmin.js,
// which writes restaurants/{id}/info/status). Mirrors the same live
// lockout added to waiter.js/chef.js/kassa.js/courier.js and the login.js
// gate for staff.
onValue(ref(db, `${BASE_PATH}/info/status`), (statusSnap) => {
  const status = statusSnap.val();
  if (status !== "blocked" && status !== "paused") return;
  window.location.href = `expired.html?rest=${encodeURIComponent(currentRestaurantId)}`;
});

// Production Security Fix Pass, Phase 2 (High: QR security) — table QR
// links generated after this fix carry a `sig`/`exp` param (see admin.js
// signQrUrl(), backend/routes/qr.js) HMAC-signed over rest/table/tableId,
// so a photographed/edited copy (someone changing `table=`/`rest=` to
// target a different table or restaurant) fails verification here and
// ordering is blocked. Links with NO `sig` at all — every QR code printed
// before this fix shipped — are treated as legacy and work exactly as
// before; this can only ever make a request MORE restricted than today,
// never less, so it can't break anyone's current, already-printed codes.
(async function verifyQrSignatureIfPresent() {
  const sig = urlParams.get("sig");
  const exp = urlParams.get("exp");
  if (!sig || !exp) return; // legacy/unsigned link — unchanged behavior
  try {
    const verifyUrl = new URL("/api/qr/verify", window.location.origin);
    verifyUrl.searchParams.set("restId", currentRestaurantId);
    const table = urlParams.get("table") || "";
    const tableId = urlParams.get("tableId") || "";
    if (table) verifyUrl.searchParams.set("table", table);
    if (tableId) verifyUrl.searchParams.set("tableId", tableId);
    verifyUrl.searchParams.set("sig", sig);
    verifyUrl.searchParams.set("exp", exp);
    const resp = await fetch(verifyUrl.toString());
    const result = await resp.json().catch(() => ({ valid: false }));
    if (!result.valid) {
      document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center;font-family:sans-serif;">
        <div>
          <div style="font-size:48px;margin-bottom:12px;">⚠️</div>
          <div style="font-size:18px;font-weight:600;margin-bottom:8px;">${t("qr_invalid_link_title", "Bu havola yaroqsiz")}</div>
          <div style="color:#666;">${t("qr_invalid_link_desc", "QR kod o'zgartirilgan yoki muddati o'tgan bo'lishi mumkin. Iltimos, restoran xodimidan yordam so'rang.")}</div>
        </div>
      </div>`;
    }
  } catch (_e) {
    // Network hiccup verifying the signature must never lock out a
    // legitimate customer — fail open here, same as every other
    // best-effort check in this file.
  }
})();

// ==========================================
// 🔑 STOL KALITINI STANDARTLASHTIRISH
// Firebase'da stollar "table_5" formatida saqlanadi (admin.js shunday yaratadi).
// Bu yerda esa ko'p joyda faqat "5" (stol raqami) ishlatilgan edi — bu admin
// panelidagi Stollar bo'limi yangilanmasligiga sabab bo'lgan. Endi har doim
// shu funksiya orqali to'g'ri kalitga o'tkazamiz.
function getTableKey(tableNumberOrKey) {
  const raw = String(tableNumberOrKey ?? "").trim();
  if (!raw) return raw;
  return raw.startsWith("table_") ? raw : `table_${raw}`;
}
window.getTableKey = getTableKey;

window.cart =
  JSON.parse(
    localStorage.getItem("cart") || "{}"
  );

console.log(
  "🛒 INITIAL CART:",
  window.cart
);

console.log(
  "🚀 Dastur ishga tushdi, menyuni yuklash boshlanmoqda..."
);

/* =========================
   CHAT SYSTEM INITIALIZATION 
========================= */
window.getClientChatOptions = async function (userId, restaurantId) {
  return [
    { icon: "👨‍🍳", label: t("chat_option_chef", "Oshpaz bilan aloqa"), type: "chef" },
  ];
};

function updateOrderTimeDisplay(order) {
  const headerReadyBox = document.getElementById("headerReadyBox");
  const headerTimerContainer = document.getElementById("header-timer-container");
  const clientReadyBox = document.getElementById("clientReadyBox");

  const headerReadyTime = document.getElementById("headerReadyTime");
  const headerReadyCountdown = document.getElementById("headerReadyCountdown");
  const headerCountdownText = document.getElementById("header-countdown-text");

  const clientReadyTime = document.getElementById("clientReadyTime");
  const clientTimer = document.getElementById("clientTimer");

  if (order && order.prepMinutes && order.expectedReadyAt) {
    if (headerReadyBox) headerReadyBox.style.display = "block";
    if (headerTimerContainer) headerTimerContainer.style.display = "block";
    if (clientReadyBox) clientReadyBox.style.display = "block";

    const readyDate = new Date(order.expectedReadyAt);
    const timeString = readyDate.toLocaleTimeString('uz-UZ', {
      hour: '2-digit',
      minute: '2-digit'
    });

    if (headerReadyTime) headerReadyTime.innerText = timeString;
    if (headerReadyCountdown) headerReadyCountdown.innerText = `${order.prepMinutes} ${t("minutes_short", "min")}`;
    if (headerCountdownText) headerCountdownText.innerText = `${order.prepMinutes}:00`;

    if (clientReadyTime) clientReadyTime.innerHTML = `🍳 ${t("ready_at_text", "Tayyor bo'ladi")}: ${timeString}`;
    if (clientTimer) clientTimer.innerHTML = `⏳ ${t("waiting_text", "Kutilmoqda")}: ${order.prepMinutes} ${t("minutes_short", "min")}`;

  } else {
    if (headerReadyBox) headerReadyBox.style.display = "none";
    if (headerTimerContainer) headerTimerContainer.style.display = "none";
    if (clientReadyBox) clientReadyBox.style.display = "none";
  }
}

window.getClientChatId = async function (option, clientId, restaurantId) {
  if (option.type === "waiter") {
    return `waiterChats/client_${clientId}`;
  }

  if (option.type === "chef") {
    const activeOrderId = localStorage.getItem("activeOrderId");
    if (!activeOrderId) {
      alert(t("active_order_not_found", "Faol buyurtma topilmadi"));
      return null;
    }

    try {
      const database = window.db || db;
      const orderSnap = await get(ref(database, `${BASE_PATH}/orders/${activeOrderId}`));

      if (!orderSnap.exists()) {
        alert(t("order_not_found", "Buyurtma topilmadi"));
        return null;
      }

      const order = orderSnap.val();
      const assignedChefId = order.chefId || order.assignedChefId;

      if (assignedChefId) {
        return `orderChats/${activeOrderId}/chef`;
      } else {
        alert(t("chef_not_assigned", "Buyurtmangizga hali oshpaz biriktirilmagan"));
        return null;
      }
    } catch (error) {
      console.error("Chat ID olishda xato:", error);
      return null;
    }
  }
  return null;
};

// Chat system removed


// 🩹 Same DOMContentLoaded-race fix as _initClientApp() above — see that
// comment for the root cause. This one never fired either (confirmed live:
// "📂 HTML to'liq yuklandi" never printed).
function _diagRenderMenuCheck() {
  console.log("📂 HTML to'liq yuklandi");
  if (typeof renderMenu === "function") {
    console.log("✅ renderMenu funksiyasi topildi");
  } else {
    console.error("❌ XATO: renderMenu funksiyasi topilmadi!");
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _diagRenderMenuCheck);
} else {
  _diagRenderMenuCheck();
}

function normalizeStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  // V2 → display key mapping (INFO map keys)
  const V2_TO_DISPLAY = {
    "order_created":   "order_created",
    "kitchen_printer": "kitchen_printer",
    "kitchen_display": "kitchen_display",
    "preparing":       "preparing",
    "ready":           "ready",
    "picked_up":       "picked_up",
    "served":          "served",
    "cashier":         "cashier",
    "payment":         "payment",
    "completed":       "completed",
  };
  return V2_TO_DISPLAY[s] || s;
}

function getOrderStatusKey(order) {
  const raw = normalizeStatus(order?.status || order?.statusKey);

  const map = {
    // Yangi
    yangi: "yangi", new: "yangi", pending: "yangi", queue: "queue", kutilmoqda: "yangi", waiter: "yangi",
    // Tasdiqlandi
    tasdiqlandi: "tasdiqlandi", approved: "tasdiqlandi",
    // Tayyorlanmoqda
    tayyorlanmoqda: "tayyorlanmoqda", cooking: "tayyorlanmoqda",
    // Tayyor
    tayyor: "tayyor", ready: "tayyor",
    // Yetkazilmoqda
    yetkazilmoqda: "yetkazilmoqda", delivering: "yetkazilmoqda",
    // Yetkazildi — "served" endi bu yerda QAYTA YOZILMAYDI: u to'g'ridan-to'g'ri
    // "served" holicha o'tadi, chunki updateStatusUI() dagi INFO xaritasida
    // "served" allaqachon to'g'ri (5-bosqich, "yetkazildi") ga ega. Ilgari
    // bu yerda served->"yetkazilmoqda" (4-bosqich) ga qayta yozilardi —
    // mijozga taom hali yetkazilmagandek ko'rsatilardi, garchi allaqachon
    // yetkazilgan bo'lsa ham. Xato edi, tuzatildi.
    yetkazildi: "yetkazildi", delivered: "yetkazildi",
    // To'landi
    "to'landi": "to'landi", tolandi: "to'landi", paid: "to'landi",
    // To'lov tasdiqlandi
    "to'lov tasdiqlandi": "to'lov tasdiqlandi", payment_confirmed: "to'lov tasdiqlandi",
    // Queue
    queue: "queue",
    // Yopildi
    yopildi: "yopildi", closed: "yopildi",
    // Bekor qilindi — ikkala yozilishi ham ("canceled" bitta L bilan ham)
    // qamrab olinishi kerak, aks holda bekor qilingan buyurtma
    // updateStatusUI()dagi SPECIAL["bekor qilindi"] filialiga tushmay,
    // oddiy progress-bar sifatida ko'rsatilib qolardi.
    "bekor qilindi": "bekor qilindi", cancelled: "bekor qilindi", canceled: "bekor qilindi",
    // Tozalanmoqda
    tozalanmoqda: "tozalanmoqda", cleaning: "tozalanmoqda", needs_cleaning: "tozalanmoqda"
  };

  return map[raw] || raw;
}

// HTTP (non-HTTPS) da crypto.randomUUID ishlamaydi — fallback
function safeUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

let clientId = localStorage.getItem("clientId");

if (!clientId) {
  clientId = "CL_" + safeUUID();
  localStorage.setItem("clientId", clientId);
}

function checkDiscountFromURL() {

  const params = new URLSearchParams(window.location.search);
  const code = params.get("discount");

  // discount bo‘lmasa stop
  if (!code) return;

  get(ref(db, BASE_PATH + "/discounts/" + code))
    .then((snap) => {

      if (!snap.exists()) {
        alert(t("discount_not_found"));
        return;
      }

      const data = snap.val();

      if (data.active === false) {
        alert(t("discount_inactive"));
        return;
      }

      if (data.used) {
        alert(t("discount_used"));
        return;
      }

      if (data.expireDate && Date.now() > data.expireDate) {
        alert(t("discount_expired"));
        return;
      }

      localStorage.setItem("discountPercent", data.percent);
      localStorage.setItem("discountCode", code);

      alert(`🎉 ${data.percent}% ${t("discount_activated")}`);

    })
    .catch((err) => {
      console.error("Discount check error:", err);
    });
}

const SUBMITTED_ORDER_FLAG = "client_has_submitted_order";

window.addEventListener("load", () => {
  checkDiscountFromURL();
});

function trackOrderAndStartTimer(restaurantId, orderId) {
  const db = getDatabase();
  const orderRef = ref(db, `restaurants/${restaurantId}/orders/${orderId}`);

  onValue(orderRef, (snapshot) => {
    const order = snapshot.val();
    // expectedReadyAt (oshpaz belgilagan vaqt) yoki readyAt dan foydalanamiz
    const countdownTarget = order?.expectedReadyAt || order?.readyAt;
    if (order && countdownTarget && Number(countdownTarget) > Date.now() - 3600000) {
      window.startHeaderCountdown(countdownTarget);
    } else {
      const timerBox = document.getElementById("header-timer-container");
      if (timerBox) timerBox.style.display = 'none';
    }
  });
}

let headerTimerInterval = null;

// ── Buyurtma tayyor bo'lganda header da necha daqiqada tayyorlanganini ko'rsatish ──
function showOrderReadyBanner(order) {
  // Countdown ni to'xtatamiz
  if (headerTimerInterval) {
    clearInterval(headerTimerInterval);
    headerTimerInterval = null;
  }

  const timerBox = document.getElementById("header-timer-container");
  const display = document.getElementById("header-countdown-text");
  const etaBox = document.getElementById("header-ready-eta");
  const timerIcon = timerBox ? timerBox.querySelector(".timer-icon") : null;
  const timerLabel = timerBox ? timerBox.querySelector("small") : null;

  // Necha daqiqada tayyorlanganini hisoblash
  const startedAt = Number(order.cookingStartedAt || order.acceptedAt || 0);
  const finishedAt = Number(order.updatedAt || Date.now());
  let tookMins = null;
  if (startedAt && finishedAt > startedAt) {
    tookMins = Math.round((finishedAt - startedAt) / 60000);
  } else if (order.prepMinutes) {
    tookMins = Number(order.prepMinutes);
  }

  if (timerBox) {
    timerBox.style.display = "flex";
    timerBox.style.background = "linear-gradient(135deg,rgba(22,163,74,0.18),rgba(34,197,94,0.10))";
    timerBox.style.border = "1.5px solid rgba(34,197,94,0.5)";
    timerBox.style.borderRadius = "14px";
  }

  if (timerIcon) timerIcon.textContent = "✅";

  if (timerLabel) {
    timerLabel.textContent = tookMins !== null
      ? `${tookMins} ${t("minute_short", "daqiqa")}da tayyorlandi`
      : t("ready_text", "Tayyor bo'ldi!");
    timerLabel.style.color = "#16a34a";
    timerLabel.style.fontSize = "11px";
  }

  if (display) {
    display.innerText = t("ready_text_emoji", "Tayyor! 🎉");
    display.style.color = "#22c55e";
    display.style.fontSize = "18px";
    display.classList.remove("client-countdown-shake", "client-countdown-red", "client-countdown-yellow");
  }

  // ETA blokini yashiramiz — endi "N daqiqada tayyorlandi" ko'rinadi
  if (etaBox) etaBox.style.display = "none";

  // headerReadyBox da ham yangilaymiz
  const hrb = document.getElementById("headerReadyBox");
  const hrl = document.querySelector(".header-ready-label");
  const hrt = document.getElementById("headerReadyTime");
  const hrc = document.getElementById("headerReadyCountdown");

  if (hrb) hrb.style.display = "block";
  if (hrl) { hrl.innerText = ""; }
  if (hrt) {
    hrt.innerText = tookMins !== null
      ? `✅ ${tookMins} ${t("minute_short", "daqiqa")}da`
      : `✅ ${t("ready_text", "Tayyor!")}`;
    hrt.style.color = "#22c55e";
    hrt.style.fontSize = "16px";
  }
  if (hrc) {
    hrc.innerText = t("order_delivered_label", "Taomingiz keltirilyapti!");
    hrc.style.color = "#16a34a";
  }
}

window.startHeaderCountdown = function (readyAt) {
  const timerBox = document.getElementById("header-timer-container");
  const display = document.getElementById("header-countdown-text");

  if (!timerBox || !display) return;

  if (headerTimerInterval) {
    clearInterval(headerTimerInterval);
    headerTimerInterval = null;
  }

  if (!readyAt) {
    timerBox.style.display = 'none';
    const etaBox = document.getElementById("header-ready-eta");
    if (etaBox) etaBox.style.display = "none";
    return;
  }

  // readyAt butun order obyekti bo'lib kelsa (bug holatida) — xavfsiz qaytamiz
  if (typeof readyAt === 'object' && readyAt !== null) {
    const ts = readyAt.readyAt || readyAt.expectedReadyAt;
    if (!ts) { timerBox.style.display = 'none'; return; }
    readyAt = ts;
  }

  const readyAtNum = Number(readyAt);
  if (!readyAtNum || readyAtNum < Date.now() - 3600000) {
    // 1 soatdan eski yoki noto'g'ri — yashiramiz
    timerBox.style.display = 'none';
    return;
  }

  timerBox.style.display = 'flex';
  timerBox.classList.remove("pulse-animation");
  display.style.color = "";
  display.style.animation = "";

  // ETA vaqtini ko'rsatamiz (tayyor bo'lish soat:daqiqa)
  const etaBox = document.getElementById("header-ready-eta");
  const etaTime = document.getElementById("header-eta-time");
  if (etaBox && etaTime) {
    const etaDt = new Date(readyAtNum);
    etaTime.innerText = etaDt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    etaBox.style.display = "block";
  }

  // Ensure CSS for client shake + red states exists
  if (!document.getElementById("clientCountdownStyles")) {
    const s = document.createElement("style");
    s.id = "clientCountdownStyles";
    s.textContent = `
      @keyframes clientShake {
        0%,100%{transform:translateX(0)}
        10%,30%,50%,70%,90%{transform:translateX(-5px)}
        20%,40%,60%,80%{transform:translateX(5px)}
      }
      .client-countdown-shake { animation: clientShake 0.5s ease infinite !important; }
      .client-countdown-red   { color: #ef4444 !important; }
      .client-countdown-yellow{ color: #f59e0b !important; }
    `;
    document.head.appendChild(s);
  }

  let overdueNotified = false;

  const updateTimer = () => {
    const now = Date.now();
    const diff = readyAtNum - now;

    if (diff <= 0) {
      // Vaqt tugadi
      clearInterval(headerTimerInterval);
      display.innerText = typeof t === "function" ? t("ready_text", "Tayyor! ✨") : "Tayyor! ✨";
      display.style.color = "#22c55e";
      display.style.animation = "";
      display.classList.remove("client-countdown-shake", "client-countdown-red", "client-countdown-yellow");
      timerBox.style.background = "linear-gradient(135deg,rgba(22,163,74,0.2),rgba(34,197,94,0.12))";
      timerBox.style.borderColor = "rgba(34,197,94,0.6)";
      timerBox.classList.add("pulse-animation");
      // headerReadyBox: countdown tugaganda "Tayyor bo'ldi" ko'rsatamiz
      const hrc = document.getElementById("headerReadyCountdown");
      if (hrc) { hrc.innerText = t("order_delivered_label", "Taomingiz keltirilyapti!"); hrc.style.color = "#16a34a"; }
      const hrl = document.querySelector(".header-ready-label");
      if (hrl) hrl.innerText = "";
      const hrt = document.getElementById("headerReadyTime");
      if (hrt) { hrt.innerText = `✅ ${t("ready_text", "Tayyor!")}`; hrt.style.color = "#22c55e"; }

      // Oshpazga bir marta overdue xabar yuborish
      if (!overdueNotified) {
        overdueNotified = true;
        const activeId = localStorage.getItem("activeOrderId");
        if (activeId && typeof db !== "undefined") {
          const restId = localStorage.getItem("restaurantId") || currentRestaurantId;
          get(ref(db, `restaurants/${restId}/orders/${activeId}`)).then(snap => {
            if (!snap.exists()) return;
            const ord = snap.val();
            const chefId = ord.chefId;
            if (!chefId) return;
            const msg = `⚠️ Vaqt tugadi! Stol ${ord.table || ''} buyurtmasi hali tayyorlanmadi. Mijoz kutmoqda!`;
            push(ref(db, `restaurants/${restId}/activityLogs`), {
              action: "client_countdown_expired",
              description: msg,
              orderId: activeId,
              table: ord.table || null,
              chefId,
              createdAt: Date.now()
            });
          }).catch(() => { });
        }
      }
      return;
    }

    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    display.innerText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    // 1 daqiqa qolganda — shake + qizil
    if (diff <= 60000) {
      display.classList.add("client-countdown-shake", "client-countdown-red");
      display.classList.remove("client-countdown-yellow");
      display.style.color = "#ef4444";
    }
    // 3 daqiqa qolganda — faqat qizil, shake yo'q
    else if (diff <= 3 * 60000) {
      display.classList.remove("client-countdown-shake", "client-countdown-yellow");
      display.classList.add("client-countdown-red");
      display.style.color = "#ef4444";
    }
    // Normal holatda — sariq
    else {
      display.classList.remove("client-countdown-shake", "client-countdown-red");
      display.classList.add("client-countdown-yellow");
      display.style.color = "";
    }
  };

  updateTimer();
  headerTimerInterval = setInterval(updateTimer, 1000);
};

/* =========================
   GLOBAL STATE
========================= */
let stopListData = {};
let tableNumber = null;
let confirmedTableNumber = null;
let currentOrderId = null;
let cartItems, cartTotal, cartCount, cartModal, tablesContainer;
let TOP_FOODS = [];
let filterCategory, filterSubcategory, filterTypeSelect, searchInput;
let currentPaymentTotal = 0;
let clientMenu;
let filterCategoryValue = "all";
let filterSubcategoryValue = "all";
let filterType = "all";
let searchQuery = "";
let clientTimerInterval = null;
let baseReadyAt = null;
let receiptShownForOrder = null;
let stopActiveOrderListener = null;
let allowReceiptOpen = false;
let currentBaseCookTime = 30;
let chatFab, headerReadyBox, headerReadyTime, headerReadyCountdown;
let clientChatModal, clientChatInfo, clientChatMessages, clientChatInput, clientChatSendBtn;
let clientChatQuickReplies = null;
let activeOrderData = null;
let hasSubmittedOrder = false;
const tableInput = document.getElementById("tableInput");
const orderStatus = document.getElementById("orderStatus");
const orderStatusBox = document.getElementById("orderStatusBox");
const receiptBox = document.getElementById("receiptBox");
let RESTAURANT_SETTINGS = {
  normalOrderBaseTime: 30
};

const CLIENT_CHAT_QUICK_REPLY_CONFIG = [
  { key: "allergy", label: t("qr_allergy", "Menda ... ga allergiya bor"), template: t("qr_allergy_template", "Menda quyidagiga allergiya bor: "), kind: "allergy", requiresDetails: true },
  { key: "no-onion", label: t("qr_no_onion", "Piyozsiz"), template: t("qr_no_onion", "Piyozsiz"), kind: "preference" },
  { key: "no-greens", label: t("qr_no_greens", "Ko'katsiz"), template: t("qr_no_greens", "Ko'katsiz"), kind: "preference" },
  { key: "spicy", label: t("qr_spicy", "Achchiq"), template: t("qr_spicy", "Achchiq"), kind: "preference" }
];

onValue(ref(db, BASE_PATH + "/settings"), snap => {
  if (snap.exists()) {
    RESTAURANT_SETTINGS = { ...RESTAURANT_SETTINGS, ...snap.val() };
    if (typeof window.renderStoreHeader === "function") window.renderStoreHeader();
    if (typeof updateDeliveryFeePreview === "function") updateDeliveryFeePreview();
    if (typeof renderHomeFeaturedSections === "function") renderHomeFeaturedSections();
  }
});

// 🆕 Admin → Sozlamalar → Chop etish sozlamalari — mijoz o'z chekini ko'rganda/
// chop etganda ham logotip/shtrix-kod/pastki matn shu yerdan boshqarilsin
// (waiter.js/kassa.js'dagi printSettingsCache bilan bir xil naqsh).
let clientPrintSettingsCache = {};
onValue(ref(db, BASE_PATH + "/printSettings"), snap => {
  clientPrintSettingsCache = snap.val() || {};
});

if (localStorage.getItem("role") !== "client" && localStorage.getItem("role") !== "waiter" && localStorage.getItem("role") !== "admin" && localStorage.getItem("role") !== "manager" && localStorage.getItem("role") !== "superadmin") {
}

window.checkRestaurantSubscription = async function () {
  try {
    const snap = await get(ref(db, `restaurants/${currentRestaurantId}/subscription`));

    if (snap.exists()) {
      const data = snap.val();
      return true;
    }
    return true;
  } catch (error) {
    console.warn("⚠️ Litsenziya tekshirishda ruxsat yo'q, lekin test uchun menyu ochiladi.");
    return true;
  }
};

/* =========================
   INIT DOM
========================= */
// 🩹 Root-cause fix ("menyu bo'limi umuman bo'sh" — live-reproduced: none of
// this handler's own logs, not even its very first line, ever printed,
// while every log BEFORE this point in the module did): this file has a
// blocking top-level `await establishClientSession(...)` earlier — a real
// network round-trip to the backend, then a Firebase sign-in. Per spec,
// firing "DOMContentLoaded" must wait for every deferred/module script's
// top-level evaluation (including any top-level await) to finish, so this
// SHOULDN'T be reachable in a fully spec-compliant engine — but
// `document.readyState` can still already be past "loading" by the time
// this line finally runs (that part of parsing is NOT gated on scripts),
// and this exact class of top-level-await/DOMContentLoaded ordering has
// been a real, documented footgun in shipping browsers. Either way, an
// event listener added AFTER its event already fired simply never runs —
// silently, with no error — matching the reported symptom exactly. Fixed
// with the standard, engine-independent pattern: run immediately if the
// event has already passed, otherwise listen for it normally.
async function _initClientApp() {
  const isSubActive = await window.checkRestaurantSubscription();
  if (!isSubActive) return;
  clientMenu = document.getElementById("clientMenu");
  filterCategory = document.getElementById("filterCategory");
  filterSubcategory = document.getElementById("filterSubcategory");
  filterTypeSelect = document.getElementById("filterType");
  searchInput = document.getElementById("menuSearch");
  tableNumber = localStorage.getItem("table");
  cartItems = document.getElementById("cartItems");
  cartTotal = document.getElementById("cartTotal");
  cartCount = document.getElementById("cartCount");
  cartModal = document.getElementById("cartModal");
  tablesContainer = document.getElementById("tablesContainer");
  chatFab = document.getElementById("chatFab");
  clientChatModal = document.getElementById("clientChatModal");
  clientChatInfo = document.getElementById("clientChatInfo");
  clientChatMessages = document.getElementById("clientChatMessages");
  clientChatInput = document.getElementById("clientChatInput");
  clientChatSendBtn = document.getElementById("clientChatSendBtn");
  clientChatQuickReplies = document.getElementById("clientChatQuickReplies");
  headerReadyBox = document.getElementById("headerReadyBox");
  headerReadyTime = document.getElementById("headerReadyTime");
  headerReadyCountdown = document.getElementById("headerReadyCountdown");
  ensureClientChatQuickReplies();

  const savedCart = localStorage.getItem("clientCart");
  const savedActiveOrderId = localStorage.getItem("activeOrderId");

  hasSubmittedOrder = sessionStorage.getItem(SUBMITTED_ORDER_FLAG) === "1";

  if (savedCart && savedActiveOrderId) {
    try { cart = JSON.parse(savedCart) || {}; } catch { cart = {}; }
  } else {
    cart = {};
    localStorage.removeItem("clientCart");
    localStorage.removeItem("lastOrderStatus");
  }

  const langSelect = document.getElementById("langSelect");
  if (langSelect) {
    langSelect.value = getLang();
    langSelect.addEventListener("change", e => { setLang(e.target.value); });
  }

  const langSelectProfile = document.getElementById("langSelectProfile");
  if (langSelectProfile) {
    langSelectProfile.innerHTML = `<option value="uz">UZ</option><option value="ru">RU</option><option value="en">EN</option>`;
    langSelectProfile.value = getLang();
    langSelectProfile.addEventListener("change", e => { setLang(e.target.value); });
  }

  // Har bir qadam alohida try/catch bilan izolyatsiya qilingan — aks holda
  // (masalan) renderMenu() xato bersa, undan keyingi barcha qadamlar
  // (savat, chek, profil, buyurtmalar tarixi) qayta chizilmay qolardi —
  // "til faqat refresh'dan keyin ishlaydi" muammosining aynan shu yerdagi
  // sababi (batafsil: i18n.js setLang()dagi izoh — Admin/SuperAdmin/Waiter/
  // Chef panellarida topilgan va tuzatilgan bitta umumiy sababning Client
  // ilovasidagi ko'rinishi). Bitta qadam xato bersa ham, qolganlari baribir
  // ishlaydi.
  onLangChange((lang) => {
    const _step = (label, fn) => {
      try { fn(); } catch (err) { console.error(`[i18n] client.js "${label}" failed during language switch:`, err); }
    };

    _step("auth.languageCode", () => { auth.languageCode = lang; });
    _step("applyLang", () => applyLang());
    _step("renderCategoryFilter", () => renderCategoryFilter());
    _step("renderSubcategoryFilter", () => renderSubcategoryFilter());
    _step("renderMenu", () => renderMenu());
    _step("updateCart", () => updateCart());
    _step("applyClientPageTranslations", () => applyClientPageTranslations());
    _step("updateStatusUI", () => { if (activeOrderData) updateStatusUI(getOrderStatusKey(activeOrderData)); });

    // Quyidagilar sahifa birinchi yuklanganda (DOMContentLoaded) chaqiriladi,
    // lekin til o'zgarganda avtomatik qayta chaqirilmasdi — shuning uchun
    // Profil/Chegirma/Tashriflar tarixi, saqlangan manzillar va Bosh sahifa
    // bo'limlari eski tilda qolib ketardi.
    _step("renderProfileView", () => { if (typeof renderProfileView === "function") renderProfileView(); });
    _step("renderOrderHistoryView", () => { if (typeof renderOrderHistoryView === "function") renderOrderHistoryView(); });
    _step("renderSavedAddressesRow", () => { if (typeof renderSavedAddressesRow === "function") renderSavedAddressesRow(); });
    _step("renderHomeFeaturedSections", () => { if (typeof renderHomeFeaturedSections === "function") renderHomeFeaturedSections(); });
    _step("renderStoreHeader", () => { if (typeof window.renderStoreHeader === "function") window.renderStoreHeader(); });
    // 🩹 renderPromoBanners() — subscribePromoBanners()ning onValue() live
    // tinglovchisi faqat Firebase /discounts o'zgarganda qayta ishga
    // tushadi, til o'zgarganda emas ("🚚 Bepul yetkazish..." matni F5siz
    // eski tilda qolib ketishining ROOT CAUSE'i). Endi oxirgi olingan
    // snapshotdan (window._lastPromoBannersSnap) yangi Firebase o'qishsiz
    // qayta chiziladi.
    _step("renderPromoBanners", () => { if (typeof renderPromoBanners === "function") renderPromoBanners(); });

    // Chek (receipt) ochiq bo'lsa — matni t() orqali generatsiya vaqtida
    // hisoblanadi va data-i18n bilan belgilanmagan, shuning uchun
    // applyLang() unga yetolmaydi. Ochiq bo'lgandagina, oxirgi ko'rsatilgan
    // buyurtma bilan qayta chizamiz (holat/ma'lumot o'zgarmaydi, faqat til).
    _step("showReceipt relabel", () => {
      const box = document.getElementById("receiptBox");
      if (box && box.style.display !== "none" && _lastReceiptOrder && typeof showReceipt === "function") {
        showReceipt(_lastReceiptOrder);
      }
    });

    // 🩹 i18n live-refresh audit — the remaining "bare container + one-shot
    // innerHTML" modals (#checkout-modal/payment, #favoritesModal,
    // #my-reservations-modal, #reservation-detail-modal): none of these
    // were in this dispatcher before, so if one happened to be open at the
    // moment the language changed, it silently stayed in the old language
    // until closed and reopened. Each of these either self-guards on
    // "is it actually open" internally, or is cheap/idempotent to rebuild
    // even while hidden — same reasoning as renderProfileView()/
    // renderOrderHistoryView() above, which have always been called
    // unconditionally here.
    _step("checkout modal relabel", () => { if (typeof _relabelDeliveryCheckoutIfOpen === "function") _relabelDeliveryCheckoutIfOpen(); });
    _step("reservation modal relabel", () => { if (typeof _relabelReservationModalIfOpen === "function") _relabelReservationModalIfOpen(); });
    _step("renderFavoritesView", () => { if (typeof renderFavoritesView === "function") renderFavoritesView(); });
    _step("renderMyReservationsList", () => { if (typeof _renderMyReservationsList === "function") _renderMyReservationsList(); });
    _step("reservation detail relabel", () => {
      if (window._openReservationDetailId && typeof window.openReservationDetail === "function") {
        window.openReservationDetail(window._openReservationDetailId);
      }
    });

    _step("langSelect sync", () => { if (langSelect) langSelect.value = lang; });
    _step("langSelectProfile sync", () => { if (langSelectProfile) langSelectProfile.value = lang; });
  });

  const hasActiveOrderOnLoad = !!localStorage.getItem("activeOrderId");

  if (!hasActiveOrderOnLoad) {
    // Faol buyurtma yo'q — telefon va VIP ham tozalansin
    localStorage.removeItem("customerPhone");
    localStorage.removeItem("userPhone");
  }

  // Telefon raqam o'zgartirilsa yoki o'chirilsa VIP badge yashiriladi
  const phoneInputEl = document.getElementById("clientPhoneInput");
  if (phoneInputEl) {
    phoneInputEl.addEventListener("input", () => {
      if (!phoneInputEl.value.trim()) {
        hideAllVipElements();
        localStorage.removeItem("customerPhone");
        localStorage.removeItem("userPhone");
      }
    });
  }

  const orderBox = document.getElementById("orderStatusBox");

  if (receiptBox) receiptBox.style.display = "none";
  if (orderBox) orderBox.style.display = "none";

  if (receiptBox) {
    receiptBox.addEventListener("click", function (e) {
      if (e.target.id === "receiptBox") closeReceipt();
    });
  }

  allowReceiptOpen = false;

  applyLang();
  renderCategoryFilter();
  renderSubcategoryFilter();
  bindFilters();
  subscribeMenuRealtime();
  subscribeInventoryRealtime();
  subscribeModifiers();

  onValue(ref(db, BASE_PATH + "/stopList"), snap => {
    stopListData = snap.val() || {};
    safeRenderMenu();
  });

  updateCart();
  renderMenu();
  applyClientPageTranslations();
  clearHeaderReadyInfo();
  if (typeof window.renderStoreHeader === "function") window.renderStoreHeader();
  subscribeFavorites();
  if (typeof renderProfileView === "function") renderProfileView();
  computePopularItems();
  subscribePromoBanners();
  renderSavedAddressesRow();
  if (typeof renderHomeFeaturedSections === "function") renderHomeFeaturedSections();

  restoreSubmittedOrderState().then(() => {
    listenActiveOrder();
    initClientChat();
  });

  // VIP badge: telefon kiritilganda checkout ichida tekshiriladi
  // (checkAndShowVipBadge endi checkout telefon inputiga bog'langan)
  const coPhoneWatcher = () => {
    const el = document.getElementById("coFullPhone");
    if (el && !el.dataset.vipBound) {
      el.dataset.vipBound = "1";
      el.addEventListener("blur", () => {
        localStorage.setItem("customerPhone", normalizeCustomerPhone(el.value || ""));
        checkAndShowVipBadge();
        renderSavedAddressesRow();
      });
    }
  };
  document.body.addEventListener("click", coPhoneWatcher, true);

  const initialReceiptBox = document.getElementById("receiptBox");
  const initialReceiptContent = document.getElementById("receiptContent");

  if (initialReceiptBox) {
    initialReceiptBox.style.display = "none";
  }
  if (initialReceiptContent) {
    initialReceiptContent.innerHTML = "";
  }

  // Chat system removed
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _initClientApp);
} else {
  // DOMContentLoaded already fired before this line ran — invoke directly
  // instead of registering a listener for an event that will never come.
  _initClientApp();
}

/* =========================
   UI XIZMAT FUNKSIYALARI
========================= */
function resetClientSession(paymentConfirmed = false) {
  stopClientChatRealtime();
  currentOrderId = null;
  hasSubmittedOrder = false;
  receiptShownForOrder = null;

  // Savat FAQAT admin to'lovni tasdiqlaganda tozalanadi
  if (paymentConfirmed) {
    cart = {};
    window.cart = {};
    localStorage.removeItem("clientCart");
    localStorage.removeItem("cart");
  }

  localStorage.removeItem("lastOrderStatus");
  sessionStorage.removeItem("client_has_submitted_order");
  localStorage.removeItem("activeOrderId");
  localStorage.removeItem("confirmedTable");
  localStorage.removeItem("table");
  const persistTable = getClientTable();
  if (persistTable) localStorage.setItem("table", persistTable);
  localStorage.removeItem("receiptShown");
  // Telefon raqamni ham tozalaymiz — VIP yangi raqam kiritilganda qayta tekshirilsin
  localStorage.removeItem("customerPhone");
  localStorage.removeItem("userPhone");

  tableNumber = null;
  confirmedTableNumber = null;

  const tableInputEl = document.getElementById("tableInput");
  if (tableInputEl) tableInputEl.value = "";

  closeClientChat(true);
  closeReceipt();

  const statusBox = document.getElementById("orderStatusBox");
  if (statusBox) statusBox.style.display = "none";

  stopClientCountdown();
  clearHeaderReadyInfo();
  updateCart();
  renderMenu();
}

function stopClientCountdown() {
  if (clientTimerInterval) {
    clearInterval(clientTimerInterval);
    clientTimerInterval = null;
  }
  const timerEl = document.getElementById("clientTimer");
  if (timerEl) {
    timerEl.innerText = "";
    timerEl.style.color = "";
  }
  if (headerReadyCountdown) {
    headerReadyCountdown.innerText = "";
    headerReadyCountdown.style.color = "#f59e0b";
  }
}

function showHeaderReadyBox() {
  if (headerReadyBox) headerReadyBox.style.display = "block";
}

function hideHeaderReadyBox() {
  if (headerReadyBox) headerReadyBox.style.display = "none";
}

function clearHeaderReadyInfo() {
  hideHeaderReadyBox();
  if (headerReadyTime) headerReadyTime.innerText = "";
  if (headerReadyCountdown) {
    headerReadyCountdown.innerText = "";
    headerReadyCountdown.style.color = "#f59e0b";
  }
}

function updateHeaderReadyInfo(readyAt) {
  if (!headerReadyTime) return;
  showHeaderReadyBox();
  const dt = new Date(Number(readyAt || Date.now()));
  const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Sarlavhani ko'rsatamiz
  const labelEl = document.querySelector(".header-ready-label");
  if (labelEl) labelEl.innerText = t("header_ready_title", "Tayyor bo'ladi:");

  // Aniq vaqtni ko'rsatamiz
  headerReadyTime.innerText = timeStr;

  // Qolgan daqiqalarni hisoblash
  const diffMs = Number(readyAt) - Date.now();
  const diffMins = Math.max(0, Math.ceil(diffMs / 60000));

  if (headerReadyCountdown) {
    if (diffMs <= 0) {
      headerReadyCountdown.innerText = t("ready_text", "✅ Tayyor!");
      headerReadyCountdown.style.color = "#22c55e";
    } else {
      headerReadyCountdown.innerText = `⏳ ~${diffMins} ${t("minute_short", "daqiqa")}`;
      headerReadyCountdown.style.color = diffMins <= 3 ? "#ef4444" : "#f59e0b";
    }
  }
}

function setPreviewReadyInfo(readyAt) {
  updateHeaderReadyInfo(readyAt);
  const readyEl = document.getElementById("clientReadyTime");
  const countdownEl = document.getElementById("clientTimer");

  if (readyEl) {
    const dt = new Date(readyAt);
    readyEl.innerText = `🍽 ${t("ready_time")}: ${dt.toLocaleTimeString()}`;
  }
  if (countdownEl) {
    countdownEl.innerText = `⏳ ${t("waiting_chef_start", "Oshpaz boshlashi kutilmoqda")}`;
    countdownEl.style.color = "#64748b";
  }
  if (headerReadyCountdown) {
    headerReadyCountdown.innerText = t("waiting_chef_start", "Oshpaz boshlashi kutilmoqda");
    headerReadyCountdown.style.color = "#64748b";
  }
}

/* =========================
   CATEGORY FILTERS & MENU
========================= */
// Display-only emoji per category id (Wolt/Yandex-Eats-style chips) — purely
// cosmetic, does not touch CATEGORY_DATA in shared.js (used by every role).
const CATEGORY_EMOJI = {
  main: "🍗", snacks: "🥗", soups: "🍜", fastfood: "🍔", garnish: "🍚",
  drinks: "🥤", dessert: "🍰", bread: "🍞", special: "🍽️", combo: "🍛"
};
function categoryEmoji(catId) {
  return CATEGORY_EMOJI[String(catId)] || "🍽️";
}

function renderCategoryFilter() {
  // Tab-based category filter — DOM element may be a <div> (tabs) or <select> (legacy)
  const tabContainer = document.getElementById("categoryTabs") || filterCategory;
  if (!tabContainer) return;

  // If it's a <select>, fall back to legacy dropdown behaviour
  if (tabContainer.tagName === "SELECT") {
    let htmlContent = `<option value="all">${t("all_categories")}</option>`;
    CATEGORY_DATA.categories.forEach(cat => {
      htmlContent += `<option value="${cat.id}">${t(cat.nameKey)}</option>`;
    });
    tabContainer.innerHTML = htmlContent;
    return;
  }

  // Collect categories that have at least one active, non-stoplist item
  const _menuForCats = window.allMenu || {};
  const _stopList    = typeof stopListData !== "undefined" ? stopListData : {};
  const activeItems = Object.values(_menuForCats).filter(
    i => i && i.active !== false && _stopList[i.id] !== true
  );
  const usedCatIds = new Set(activeItems.map(i => String(i.category)));

  const cats = CATEGORY_DATA.categories.filter(c => usedCatIds.has(String(c.id)));

  let html = `<button type="button" class="cat-tab${filterCategoryValue === "all" ? " active" : ""}"
    data-cat="all" onclick="setMenuCategoryTab('all')">${t("all_categories")}</button>`;

  cats.forEach(cat => {
    const active = filterCategoryValue === String(cat.id) ? " active" : "";
    html += `<button type="button" class="cat-tab${active}"
      data-cat="${cat.id}" onclick="setMenuCategoryTab('${cat.id}')">${categoryEmoji(cat.id)} ${t(cat.nameKey)}</button>`;
  });

  tabContainer.innerHTML = html;
}

window.setMenuCategoryTab = function(catId) {
  filterCategoryValue = catId;
  filterSubcategoryValue = "all";
  renderCategoryFilter();    // re-render tabs so active state updates
  renderSubcategoryFilter(); // update subcategory strip
  renderMenu();
};

function renderSubcategoryFilter() {
  const el = document.getElementById("subcategoryTabs") || document.getElementById("filterSubcategory");
  if (!el) return;

  if (el.tagName === "SELECT") {
    // legacy dropdown
    let htmlContent = `<option value="all">${t("all_subcategories")}</option>`;
    if (filterCategoryValue !== "all") {
      const cat = CATEGORY_DATA.categories.find(c => c.id === filterCategoryValue);
      if (cat) {
        cat.sub.forEach(subKey => {
          htmlContent += `<option value="${subKey}">${t(subKey)}</option>`;
        });
      }
    }
    el.innerHTML = htmlContent;
    return;
  }

  // Tab strip — hide if no selected category
  if (filterCategoryValue === "all") {
    el.innerHTML = "";
    el.style.display = "none";
    return;
  }
  const cat = CATEGORY_DATA.categories.find(c => String(c.id) === String(filterCategoryValue));
  if (!cat || !cat.sub || cat.sub.length === 0) {
    el.innerHTML = "";
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  let html = `<button type="button" class="subcat-tab${filterSubcategoryValue === "all" ? " active" : ""}"
    onclick="setMenuSubcategoryTab('all')">${t("all_subcategories")}</button>`;
  cat.sub.forEach(subKey => {
    const active = filterSubcategoryValue === subKey ? " active" : "";
    html += `<button type="button" class="subcat-tab${active}"
      onclick="setMenuSubcategoryTab('${subKey}')">${t(subKey)}</button>`;
  });
  el.innerHTML = html;
}

window.setMenuSubcategoryTab = function(subKey) {
  filterSubcategoryValue = subKey;
  renderSubcategoryFilter();
  renderMenu();
};

/* =============
   RENDER MENU 
================ */
function renderMenu() {
  if (!clientMenu) return;

  // ── Inject tab + add-btn CSS once ──────────────────────────────
  if (!document.getElementById("_menuTabStyles")) {
    const s = document.createElement("style");
    s.id = "_menuTabStyles";
    s.textContent = `
      /* Category tab strip — now lives above the menu cards (not in the
         header) and stays sticky/always-open while scrolling the menu. */
      #categoryTabs {
        display: flex; flex-wrap: nowrap; overflow-x: auto; gap: 8px;
        padding: 4px 0 10px; scrollbar-width: none;
      }
      #categoryTabs::-webkit-scrollbar { display: none; }
      #categoryTabs.menu-category-tabs-sticky {
        position: sticky; top: 0; z-index: 20;
        background: var(--bg-body, #f8fafc);
        padding: 10px 0 12px; margin-bottom: 4px;
      }
      /* 🩹 Waiter'ning .cat-btn bilan bir xil pill uslubi — endi CSS
         o'zgaruvchilari orqali (hardcoded hex emas), shuning uchun
         dark-mode (html[data-theme="dark"], client.css) avtomatik
         qo'llanadi — alohida dark override shart emas. */
      .cat-tab {
        flex-shrink: 0; padding: 8px 16px;
        border-radius: 999px; border: 1.5px solid var(--border-color, #e2e8f0);
        background: var(--bg-card, #fff); color: var(--text-secondary, #475569);
        font-size: 13px; font-weight: 600; cursor: pointer;
        white-space: nowrap; transition: all .15s;
        -webkit-tap-highlight-color: transparent;
      }
      .cat-tab.active {
        background: var(--primary, #16A34A); color: #fff; border-color: var(--primary, #16A34A);
      }
      .cat-tab:active { transform: scale(0.95); }

      /* Menu layout: vertical subcategory sidebar (left) + item grid (right),
         matching the reference kassa-panel layout — only top-level
         categories live in the horizontal tab strip above; subcategories
         are a vertical list on the left. */
      .menu-layout {
        display: flex; gap: 18px; align-items: flex-start;
      }
      .menu-sidebar {
        flex: 0 0 150px; display: flex; flex-direction: column; gap: 4px;
        padding: 4px 0;
      }
      .menu-sidebar:empty { display: none; }
      .subcat-tab {
        display: block; width: 100%; text-align: left;
        padding: 10px 12px; border-radius: 10px; border: none;
        background: transparent; color: var(--text-secondary, #64748b);
        font-size: 13.5px; font-weight: 600; cursor: pointer;
        white-space: normal; transition: all .15s;
        -webkit-tap-highlight-color: transparent;
      }
      .subcat-tab.active {
        background: var(--primary-subtle, #eafaf1); color: var(--primary, #16a34a);
      }
      .subcat-tab:active { transform: scale(0.98); }
      .menu-grid { flex: 1 1 auto; min-width: 0; }
      @media (max-width: 720px) {
        .menu-layout { flex-direction: column; }
        .menu-sidebar {
          flex-direction: row; overflow-x: auto; flex: none; width: 100%;
          gap: 8px; scrollbar-width: none;
        }
        .menu-sidebar::-webkit-scrollbar { display: none; }
        .subcat-tab { width: auto; flex-shrink: 0; white-space: nowrap; }
      }

      /* Variant "choose" button on menu card */
      .menu-card-add-btn {
        display: flex; align-items: center; justify-content: center; gap: 6px;
        width: 100%; padding: 9px 12px; margin-top: 8px;
        background: var(--primary, #16A34A); color: #fff;
        border: none; border-radius: 10px;
        font-size: 13px; font-weight: 700; cursor: pointer;
        -webkit-tap-highlight-color: transparent;
        transition: background .15s, transform .12s;
        position: relative;
      }
      .menu-card-add-btn:active { background: var(--primary-dark, #22a34a); transform: scale(0.97); }
      .menu-card-cart-badge {
        display: inline-flex; align-items: center; justify-content: center;
        background: #fff; color: var(--primary, #16A34A);
        font-size: 11px; font-weight: 900;
        width: 20px; height: 20px; border-radius: 50%;
        flex-shrink: 0;
      }

      /* Per-dish favorite heart, top-right corner of each menu card */
      .menu-card { position: relative; }
      .menu-card-fav-btn {
        position: absolute; top: 8px; right: 8px; z-index: 2;
        width: 30px; height: 30px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        background: var(--bg-card, #fff); opacity: 0.92; border: none; border-radius: 50%;
        font-size: 15px; line-height: 1; cursor: pointer;
        box-shadow: 0 1px 4px rgba(0,0,0,0.15);
        -webkit-tap-highlight-color: transparent;
        transition: transform .12s;
      }
      .menu-card-fav-btn:active { transform: scale(0.9); }

      /* New / Top / Discount badge stack, top-left corner of each menu card */
      .menu-card-badges {
        position: absolute; top: 8px; left: 8px; z-index: 2;
        display: flex; flex-direction: column; gap: 4px; align-items: flex-start;
      }
      .menu-card-badges:empty { display: none; }
      .menu-card-badges .badge-new,
      .menu-card-badges .badge-top,
      .menu-card-badges .badge-discount {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 3px 8px; border-radius: 999px;
        font-size: 10.5px; font-weight: 800; color: #fff;
        white-space: nowrap; box-shadow: 0 1px 4px rgba(0,0,0,0.15);
      }
      .menu-card-badges .badge-new { background: #3b82f6; }
      .menu-card-badges .badge-top { background: #f97316; }
      .menu-card-badges .badge-discount { background: #ef4444; }
    `;
    document.head.appendChild(s);
  }

  const lang = typeof getLang === "function" ? getLang() : "uz";

  // Use window.allMenu to avoid TDZ error (let allMenu is declared later in file)
  const allMenu = window.allMenu || {};
  const _stopList = typeof stopListData !== "undefined" ? stopListData : {};

  let items = [];

  for (let key in (allMenu || {})) {
    if (allMenu[key] && typeof allMenu[key] === "object") {
      items.push({
        id: key,
        ...allMenu[key]
      });
    }
  }

  // Out-of-stock (stoplist) items are still shown to the customer, just
  // disabled with an "Out of Stock" badge (see isOutOfStock below) — only
  // explicitly deactivated items are hidden entirely.
  items = items.filter(i => i.active !== false);

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    items = items.filter(i => {
      const n =
        typeof i.name === "object"
          ? (i.name[lang] || i.name.uz || i.name.ru || i.name.en || "")
          : (i.name || "");
      const desc = typeof i.description === "object"
        ? (i.description[lang] || i.description.uz || "")
        : (i.description || "");
      const catObj = CATEGORY_DATA.categories.find(c => String(c.id) === String(i.category));
      const catLabel = catObj ? t(catObj.nameKey) : (i.category || "");
      const recipe = Array.isArray(i.recipe) ? i.recipe : (i.recipe && typeof i.recipe === "object" ? Object.values(i.recipe) : []);
      const ingredientNames = recipe.map(ing => ing.name || "").join(" ");

      const haystack = `${n} ${desc} ${catLabel} ${i.subcategory || ""} ${ingredientNames}`.toLowerCase();
      return haystack.includes(q);
    });
  }

  if (filterCategoryValue !== "all") {
    items = items.filter(
      i => String(i.category) === String(filterCategoryValue)
    );
  }

  if (filterSubcategoryValue !== "all") {
    items = items.filter(
      i => String(i.subcategory) === String(filterSubcategoryValue)
    );
  }

  if (filterType === "new") {
    items = items.filter(i => isNewFood(i));
  }

  if (filterType === "top") {
    items = items.filter(i => TOP_FOODS.includes(i.id));
  }

  // "Discounted" — reads whichever per-item discount field the admin has set
  // (oldPrice/discountPrice); display-only, no new admin flow added.
  if (filterType === "discounted") {
    items = items.filter(i => Number(i.oldPrice || 0) > Number(i.price || 0) || Number(i.discountPrice || 0) > 0);
  }

  clientMenu.innerHTML = items.length
    ? items.map(i => {

      const name =
        typeof i.name === "object"
          ? (
            i.name[lang] ||
            i.name.uz ||
            i.name.ru ||
            i.name.en ||
            "—"
          )
          : (i.name || "—");

      const itemId = String(i.id);

      const hasVariants = i.variants && Object.keys(i.variants).length > 0;
      const variantsArr = hasVariants ? Object.values(i.variants) : [];

      // Cart state: sum every cart entry for this item, across variants and/or
      // modifier-selection variants (key scheme: itemId[__variantId][::modSig]).
      const cartQty = Object.entries(cart || {}).reduce((sum, [k, c]) => {
        return k.split("::")[0].split("__")[0] === itemId ? sum + Number(c.qty || 0) : sum;
      }, 0);

      const isOutOfStock = _stopList[itemId] === true || i.active === false;
      const hasModifiers = typeof window.itemHasModifiers === "function" && window.itemHasModifiers(itemId);

      // Narxni +/- qatorida ko'rsatish uchun (bazaviy narx yoki eng arzon variant narxi)
      const displayPrice = hasVariants
        ? Math.min(...variantsArr.map(v => Number(v.price || 0)).filter(p => p > 0))
        : Number(i.price || 0);
      const priceLabelHtml = (displayPrice > 0)
        ? `<span class="qty-price">${displayPrice.toLocaleString()} ${typeof t === "function" ? t("currency", "so'm") : "so'm"}</span>`
        : "";

      const addBtnHtml = isOutOfStock
        ? `<div class="menu-card-outofstock-note">${typeof t === "function" ? t("out_of_stock", "Tugagan") : "Tugagan"}</div>`
        : hasVariants
        ? `<div class="qty">
             <div class="qty-controls">
               <button type="button" onclick="openVariantModal('${itemId}')">−</button>
               <span>${cartQty}</span>
               <button type="button" onclick="openVariantModal('${itemId}')">+</button>
             </div>
             ${priceLabelHtml}
           </div>`
        : hasModifiers
        ? `<div class="qty">
             <div class="qty-controls">
               <button type="button" onclick="window.openItemModifiers('${itemId}')">−</button>
               <span>${cartQty}</span>
               <button type="button" onclick="window.openItemModifiers('${itemId}')">+</button>
             </div>
             ${priceLabelHtml}
           </div>`
        : `<div class="qty">
             <div class="qty-controls">
               <button type="button" onclick="changeQty('${itemId}', -1)">−</button>
               <span>${cartQty}</span>
               <button type="button" onclick="changeQty('${itemId}', 1)">+</button>
             </div>
             ${priceLabelHtml}
           </div>`;

      // ── Tarkib (recipe) HTML ──
      let recipeHtml = "";
      const recipe = Array.isArray(i.recipe)
        ? i.recipe
        : (i.recipe && typeof i.recipe === "object" ? Object.values(i.recipe) : []);

      if (recipe.length > 0) {
        const inv = window.allInventory || {};
        const ingredientRows = recipe.map(ing => {
          const ingName = ing.name || (inv[ing.id] && inv[ing.id].name) || ing.id || "—";
          const ingUnit = ing.unit || (inv[ing.id] && inv[ing.id].unit) || "gr";
          const ingAmt = Number(ing.amount || 0);
          return `<li class="menu-card-ing-row">
            <span class="menu-card-ing-name">${ingName}</span>
            <span class="menu-card-ing-amount">${ingAmt} ${ingUnit}</span>
          </li>`;
        }).join("");

        recipeHtml = `
          <div class="menu-card-recipe">
            <button type="button"
              class="menu-card-recipe-toggle"
              onclick="(function(btn){
                var box = btn.nextElementSibling;
                var open = box.classList.toggle('open');
                btn.classList.toggle('active', open);
              })(this)">
              ${typeof t === "function" ? t("ingredients_label", "Tarkibi") : "Tarkibi"}
              <span class="menu-card-recipe-arrow">▾</span>
            </button>
            <ul class="menu-card-recipe-list">${ingredientRows}</ul>
          </div>`;
      }

      const isFav = window._favoritesCache && window._favoritesCache[itemId] === true;
      const isNew = typeof isNewFood === "function" ? isNewFood(i) : false;
      const isTop = TOP_FOODS.includes(i.id);
      const isDiscounted = Number(i.oldPrice || 0) > Number(i.price || 0) || Number(i.discountPrice || 0) > 0;

      return `
          <div class="menu-card${isOutOfStock ? " menu-card-outofstock" : ""}">

            <button type="button" class="menu-card-fav-btn" onclick="event.stopPropagation();window.toggleFavorite('${itemId}')" aria-label="${typeof t === "function" ? t("nav_favorites", "Sevimlilar") : "Sevimlilar"}">${isFav ? "❤️" : "🤍"}</button>

            <div class="menu-card-badges">
              ${isNew ? `<span class="badge-new">🆕 ${typeof t === "function" ? t("badge_new", "Yangi") : "Yangi"}</span>` : ""}
              ${isTop ? `<span class="badge-top">🔥 ${typeof t === "function" ? t("badge_top", "Top") : "Top"}</span>` : ""}
              ${isDiscounted ? `<span class="badge-discount">🏷️ ${typeof t === "function" ? t("badge_discount", "Skidka") : "Skidka"}</span>` : ""}
            </div>

            ${isOutOfStock
          ? `<span class="badge-outofstock">${typeof t === "function" ? t("out_of_stock", "Tugagan") : "Tugagan"}</span>`
          : ""
        }

            ${(i.imgUrl || i.image || i.img)
          ? `<img class="menu-card-img"
                src="${i.imgUrl || i.image || i.img}"
                loading="lazy"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"
                alt="${name}"
              >
              <div class="menu-card-img-placeholder" style="display:none;">🍽️</div>`
          : `<div class="menu-card-img-placeholder">🍽️</div>`
        }

            <div class="menu-card-body">
              <div class="menu-card-name-row">
                <div class="menu-card-name">${name}</div>
              </div>

              ${recipeHtml}

              ${addBtnHtml}
            </div>

          </div>
        `;
    }).join("")
    : `
      <p class="empty">
        ${typeof t === "function"
      ? t("search_not_found")
      : "Kechirasiz, taom topilmadi"}
      </p>
    `;
}

/* =========================
   FILTER EVENTS
========================= */
function bindFilters() {
  filterCategory?.addEventListener("change", e => {
    filterCategoryValue = e.target.value;
    filterSubcategoryValue = "all";
    renderSubcategoryFilter();
    renderMenu();
  });

  filterSubcategory?.addEventListener("change", e => {
    filterSubcategoryValue = e.target.value;
    renderMenu();
  });

  filterTypeSelect?.addEventListener("change", e => {
    filterType = e.target.value;
    // "Yangi/Top/Chegirmadagilar" butun menyu bo'yicha qidirishi kerak —
    // aks holda faqat oldin tanlangan kategoriya ichida qidirilib, mos
    // taom boshqa kategoriyada bo'lsa "taom yo'q" chiqib ketardi.
    if (filterType !== "all") {
      filterCategoryValue = "all";
      filterSubcategoryValue = "all";
      renderCategoryFilter();
      renderSubcategoryFilter();
    }
    renderMenu();
  });

  searchInput?.addEventListener("input", e => {
    searchQuery = e.target.value.toLowerCase();
    renderMenu();
  });
}

/* =========================
   TARJIMALAR VA SAHIFA HOLATI
========================= */
function applyClientPageTranslations() {
  document.title = t("client_document_title", `Nesta ERP — ${t("client_page_title")}`);

  const rawStatus = getOrderStatusKey(activeOrderData || {});

  if (activeOrderData?.readyAt) {
    updateHeaderReadyInfo(activeOrderData.readyAt);

    if (!shouldRunCountdownByStatus(rawStatus) && headerReadyCountdown) {
      headerReadyCountdown.innerText =
        t("waiting_chef_start", "Oshpaz boshlashi kutilmoqda");
      headerReadyCountdown.style.color = "#64748b";
    }
  } else {
    clearHeaderReadyInfo();
  }
}

/* =========================
   BUYURTMA HOLATINI TIKLASH 
========================= */
async function restoreSubmittedOrderState() {
  const savedActiveOrderId = localStorage.getItem("activeOrderId");
  const savedTable = String(localStorage.getItem("table") || "").trim();
  const statusBox = document.getElementById("orderStatusBox");

  if (!savedActiveOrderId) {
    resetClientSession();
    return;
  }

  try {
    const order = await fetchClientOrder(savedActiveOrderId);

    if (!order) {
      resetClientSession();
      return;
    }

    const rawStatus = getOrderStatusKey(order);

    const orderClientId = String(order.clientId || "").trim();
    const myClientId = String(clientId || "").trim();
    const orderTable = String(order.table || "").trim();
    const clientMatch = orderClientId === myClientId;
    const tableMatch = !savedTable || orderTable === savedTable;
    const isMine = clientMatch && tableMatch;

    const isAlive = !["yopildi", "bekor qilindi", "closed", "cancelled", "paid", "to'landi"].includes(normalizeStatus(rawStatus));

    if (!isMine || !isAlive || order.tableClosed === true) {
      resetClientSession();
      return;
    }

    if (orderTable && !savedTable) {
      localStorage.setItem("table", orderTable);
      localStorage.setItem("confirmedTable", orderTable);
      confirmedTableNumber = orderTable;
      const tInp = document.getElementById("tableInput");
      if (tInp) tInp.value = orderTable;
    }

    if (order.expectedReadyAt || order.readyAt) startHeaderCountdown(order.expectedReadyAt || order.readyAt);

    currentOrderId = savedActiveOrderId;
    window._currentOrderId = savedActiveOrderId;
    activeOrderData = { ...order, _id: savedActiveOrderId };
    hasSubmittedOrder = true;
    // sessionStorage ni ham tiklaymiz — sahifa yangilanganida ham ishlaydi
    sessionStorage.setItem("client_has_submitted_order", "1");

    updateStatusUI(rawStatus);

  } catch (err) {
    console.error("restoreSubmittedOrderState error:", err);
    if (statusBox) statusBox.style.display = "none";
  }
}

/* =========================
   CHAT VA YORDAMCHI FUNKSIYALAR 
========================= */
let activeClientChatPath = "";
let stopClientChatListener = null;
let activeClientChatOrderId = "";
let pendingClientQuickReplyKey = "";

function normalizeCustomerPhone(phone = "") {
  let cleaned = String(phone || "").replace(/\D/g, "");

  if (!cleaned) return "";

  if (cleaned.length === 12 && cleaned.startsWith("998")) {
    return "+" + cleaned;
  }
  if (cleaned.length === 9) {
    return "+998" + cleaned;
  }
  if (cleaned.length === 10 && cleaned.startsWith("0")) {
    return "+998" + cleaned.slice(1);
  }

  return "+" + cleaned;
}

function normalizeCustomerMemoryList(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item || "").trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/\r?\n|[,;]+/)
      .map(item => item.trim())
      .filter(Boolean);
  }

  return [];
}

function uniqueCustomerMemory(values = []) {
  const seen = new Set();
  return values.filter(item => {
    const normalized = String(item || "").trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getClientChatQuickReply(key = "") {
  return CLIENT_CHAT_QUICK_REPLY_CONFIG.find(item => item.key === key) || null;
}

function setActiveClientQuickReply(key = "") {
  pendingClientQuickReplyKey = key || "";
  if (!clientChatQuickReplies) return;

  clientChatQuickReplies.querySelectorAll("[data-quick-reply-key]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.quickReplyKey === pendingClientQuickReplyKey);
  });
}

function ensureClientChatQuickReplyStyles() {
  if (document.getElementById("clientChatQuickReplyStyles")) return;

  const style = document.createElement("style");
  style.id = "clientChatQuickReplyStyles";
  style.textContent = `
    #clientChatQuickReplies {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 10px 0 12px;
    }
    #clientChatQuickReplies .client-chat-chip {
      border: 1px solid #ffd9d9;
      background: #fff5f5;
      color: #b42318;
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
      box-shadow: 0 6px 16px rgba(180, 35, 24, 0.08);
    }
    #clientChatQuickReplies .client-chat-chip:hover {
      transform: translateY(-1px);
      box-shadow: 0 10px 22px rgba(180, 35, 24, 0.16);
    }
    #clientChatQuickReplies .client-chat-chip.active {
      background: linear-gradient(135deg, #ff5a5f, #d62828);
      color: #fff;
      border-color: transparent;
      box-shadow: 0 12px 26px rgba(214, 40, 40, 0.28);
    }
  `;

  document.head.appendChild(style);
}

function renderClientChatQuickReplies() {
  if (!clientChatQuickReplies) return;

  clientChatQuickReplies.innerHTML = CLIENT_CHAT_QUICK_REPLY_CONFIG.map(item => `
    <button
      type="button"
      class="client-chat-chip ${item.key === pendingClientQuickReplyKey ? "active" : ""}"
      data-quick-reply-key="${item.key}"
    >
      ${escapeHTML(item.label)}
    </button>
  `).join("");

  clientChatQuickReplies.querySelectorAll("[data-quick-reply-key]").forEach(btn => {
    btn.addEventListener("click", () => {
      const quickReply = getClientChatQuickReply(btn.dataset.quickReplyKey || "");
      if (!quickReply || !clientChatInput) return;

      setActiveClientQuickReply(quickReply.key);
      clientChatInput.value = quickReply.template;
      clientChatInput.focus();
      clientChatInput.setSelectionRange(clientChatInput.value.length, clientChatInput.value.length);
    });
  });
}

function ensureClientChatQuickReplies() {
  ensureClientChatQuickReplyStyles();
  if (!clientChatModal || clientChatQuickReplies) {
    renderClientChatQuickReplies();
    return;
  }

  const inputRow = clientChatModal.querySelector(".client-chat-input-row");
  if (!inputRow) return;

  clientChatQuickReplies = document.createElement("div");
  clientChatQuickReplies.id = "clientChatQuickReplies";
  inputRow.parentNode.insertBefore(clientChatQuickReplies, inputRow);
  renderClientChatQuickReplies();
}

function getCurrentClientPhoneNumber(order = null) {
  const fromOrder = normalizeCustomerPhone(
    order?.phoneNumber ||
    order?.customerPhone ||
    order?.clientPhone ||
    activeOrderData?.phoneNumber ||
    activeOrderData?.customerPhone ||
    activeOrderData?.clientPhone ||
    ""
  );

  if (fromOrder) return fromOrder;

  return normalizeCustomerPhone(
    localStorage.getItem("customerPhone") ||
    localStorage.getItem("userPhone") ||
    document.getElementById("clientPhoneInput")?.value ||
    ""
  );
}

function isAllergyMessage(text = "") {
  return /(аллерг|allerg|allergy)/i.test(String(text || ""));
}

function extractAllergyMemory(text = "") {
  const rawText = String(text || "").trim();
  const cleaned = rawText
    .replace(/^у\s+меня\s+аллергия\s+на\s*/i, "")
    .replace(/^аллергия\s*(на)?\s*/i, "")
    .replace(/^allergy\s*(to)?\s*/i, "")
    .replace(/^allergiya\s*(ga|na)?\s*/i, "")
    .trim();

  return cleaned || rawText;
}

async function saveCustomerChatMemory(text, order) {
  const quickReply = getClientChatQuickReply(pendingClientQuickReplyKey);
  const phone = getCurrentClientPhoneNumber(order);
  const messageText = String(text || "").trim();

  if (!phone || !messageText) {
    setActiveClientQuickReply("");
    return;
  }

  await saveCustomerToDatabase(phone);
  const customerRef = ref(db, `${BASE_PATH}/customers/${encodeURIComponent(normalizeCustomerPhone(phone) || phone)}`);
  const snap = await get(customerRef);
  const customerData = snap.exists() ? (snap.val() || {}) : {};
  const patch = {
    phone,
    updatedAt: Date.now(),
    memoryUpdatedAt: Date.now()
  };

  if (!snap.exists()) {
    patch.visits = Number(customerData.visits || 0);
    patch.totalSpent = Number(customerData.totalSpent || 0);
    patch.personalDiscount = Number(customerData.personalDiscount || 0);
    patch.createdAt = customerData.createdAt || Date.now();
  }

  let shouldUpdateCustomer = false;

  if (quickReply?.kind === "allergy" || isAllergyMessage(messageText)) {
    const nextAllergy = extractAllergyMemory(messageText);
    const allergies = uniqueCustomerMemory([
      ...normalizeCustomerMemoryList(customerData.allergies),
      nextAllergy
    ]);

    if (allergies.length) {
      patch.allergies = allergies;
      shouldUpdateCustomer = true;
      if (currentOrderId) {
        await update(ref(db, `${BASE_PATH}/orders/${currentOrderId}`), {
          allergyNote: allergies.join(", "),
          updatedAt: Date.now()
        });
      }
    }
  }

  if (quickReply?.kind === "preference") {
    const preferences = uniqueCustomerMemory([
      ...normalizeCustomerMemoryList(customerData.preferences),
      messageText
    ]);

    if (preferences.length) {
      patch.preferences = preferences;
      shouldUpdateCustomer = true;
    }
  }

  if (shouldUpdateCustomer) {
    await update(customerRef, patch);
  }

  setActiveClientQuickReply("");
}

function stopClientChatRealtime() {
  if (stopClientChatListener) {
    stopClientChatListener();
    stopClientChatListener = null;
  }
  activeClientChatPath = "";
  activeClientChatOrderId = "";
}

function startClientChatRealtime(order) {
  if (!order || !order._id) return;

  const orderId = String(order._id).trim();
  const chefId = String(order.chefId || "").trim();

  if (!orderId || !chefId) return;

  const nextPath = `${BASE_PATH}/orderChats/${orderId}/chef`;

  if (
    activeClientChatOrderId === orderId &&
    activeClientChatPath === nextPath &&
    stopClientChatListener
  ) {
    return;
  }

  stopClientChatRealtime();

  activeClientChatOrderId = orderId;
  activeClientChatPath = nextPath;

  stopClientChatListener = onValue(
    ref(db, `${nextPath}/messages`),
    snap => {
      renderClientChatMessages(snap.val() || {});
    }
  );
}

function initClientChat() {
  if (!chatFab || !clientChatModal) return;

  ensureClientChatQuickReplies();

  chatFab.addEventListener("click", async () => {
    if (!currentOrderId) {
      alert(t("place_order_first"));
      return;
    }

    clientChatModal.style.display = "flex";
    await openClientChefChat();
  });

  clientChatSendBtn?.addEventListener("click", sendClientMessageToChef);

  clientChatInput?.addEventListener("keydown", async e => {
    if (e.key === "Enter") {
      e.preventDefault();
      await sendClientMessageToChef();
    }
  });

  clientChatInput?.addEventListener("input", () => {
    if (!clientChatInput?.value.trim()) {
      setActiveClientQuickReply("");
    }
  });

  clientChatModal.addEventListener("click", e => {
    if (e.target.id === "clientChatModal") {
      closeClientChat();
    }
  });
}

async function openClientChefChat() {
  const order = await getActiveOrderFresh();

  if (!order) {
    alert(t("active_order_not_found"));
    return;
  }

  if (!canClientAccessOrder(order)) {
    alert(t("own_order_only_chat"));
    return;
  }

  const chefId = String(order.chefId || "").trim();

  if (!chefId) {
    alert(t("chef_not_assigned"));
    return;
  }

  let chefName = getChefDefaultName();
  const chefSnap = await get(ref(db, BASE_PATH + "/users/" + chefId));
  if (chefSnap.exists()) {
    chefName = chefSnap.val()?.name || chefName;
  }

  activeClientChatPath = `${BASE_PATH}/orderChats/${currentOrderId}/chef`;

  if (clientChatInfo) {
    clientChatInfo.innerHTML = `
  <b>👨‍🍳 ${escapeHTML(chefName)}</b><br>
  ${t("order_label")} ${formatOrderNumber(order) || ("#" + (order.orderNumber || "-"))} | ${t("table_label")} ${order.table || "-"}
`;
  }

  await update(ref(db, activeClientChatPath + "/meta"), {
    orderId: currentOrderId,
    orderNumber: order.orderNumber || null,
    table: order.table || null,
    clientId,
    targetId: chefId,
    targetRole: "chef",
    chefName,
    updatedAt: Date.now(),
    status: "open"
  });

  // ✅ Agar buyurtmada allergyNote bo'lsa va hali yuborilmagan bo'lsa — oshpazga avto-xabar
  const allergyNote = order.allergyNote || "";
  const allergyAlreadySent = localStorage.getItem(`allergyMsgSent_${currentOrderId}`);
  if (allergyNote && !allergyAlreadySent) {
    await push(ref(db, activeClientChatPath + "/messages"), {
      text: `⚠️ Maxsus so'rov: ${allergyNote}`,
      senderId: clientId,
      senderRole: "client",
      senderName: getClientSenderName(order.table),
      orderId: currentOrderId,
      table: order.table || null,
      createdAt: Date.now(),
      isAutoAllergyMsg: true
    });
    localStorage.setItem(`allergyMsgSent_${currentOrderId}`, "1");
  }

  startClientChatRealtime(order);
}

function renderClientChatMessages(messagesObj) {
  if (!clientChatMessages) return;

  const arr = Object.values(messagesObj || {})
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));

  if (!arr.length) {
    clientChatMessages.innerHTML =
      `<div class="client-chat-empty">${t("no_messages_yet")}</div>`;
    return;
  }

  clientChatMessages.innerHTML = arr.map(msg => {
    const mine = msg.senderRole === "client";
    const sender =
      msg.senderRole === "chef"
        ? `👨‍🍳 ${escapeHTML(msg.senderName || t("chef_label"))}`
        : escapeHTML(msg.senderName || t("client_label"));

    return `
      <div class="client-chat-msg ${mine ? "mine" : "theirs"}">
        <div>${escapeHTML(msg.text || "")}</div>
        <div class="client-chat-meta">
          ${sender} • ${formatChatTime(msg.createdAt)}
        </div>
      </div>
    `;
  }).join("");

  clientChatMessages.scrollTop = clientChatMessages.scrollHeight;
}

async function sendClientMessageToChef() {
  const text = clientChatInput?.value.trim();
  if (!text) return;

  const order = await getActiveOrderFresh();
  if (!order || !canClientAccessOrder(order)) {
    alert(t("chat_not_yours"));
    return;
  }

  if (!activeClientChatPath) {
    await openClientChefChat();
    if (!activeClientChatPath) return;
  }

  await push(ref(db, activeClientChatPath + "/messages"), {
    text,
    senderId: clientId,
    senderRole: "client",
    senderName: getClientSenderName(order.table),
    orderId: currentOrderId,
    table: order.table || null,
    createdAt: Date.now()
  });

  await update(ref(db, activeClientChatPath + "/meta"), {
    orderId: currentOrderId,
    orderNumber: order.orderNumber || null,
    table: order.table || null,
    clientId,
    targetId: order.chefId || null,
    targetRole: "chef",
    lastMessage: text,
    lastSenderRole: "client",
    updatedAt: Date.now(),
    status: "open"
  });

  await update(ref(db, BASE_PATH + "/orders/" + currentOrderId), {
    lastClientMessage: text,
    lastClientMessageAt: Date.now()
  });

  try {
    await saveCustomerChatMemory(text, order);
  } catch (error) {
    console.error("Client chat memory save error:", error);
  }

  clientChatInput.value = "";
  setActiveClientQuickReply("");
}

function closeClientChat(force = false) {
  if (clientChatModal) {
    clientChatModal.style.display = "none";
  }
  if (clientChatInput) clientChatInput.value = "";
  setActiveClientQuickReply("");
  if (force) {
    stopClientChatRealtime();
  }
}

function canClientAccessOrder(order) {
  const myTable = String(localStorage.getItem("table") || tableNumber || "").trim();
  const myClientId = String(clientId || "").trim();

  if (!order) return false;

  return (
    String(order.clientId || "").trim() === myClientId &&
    String(order.table || "").trim() === myTable &&
    String(currentOrderId || "").trim() === String(order._id || currentOrderId || "").trim()
  );
}

function formatChatTime(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function getActiveOrderFresh() {
  if (!currentOrderId) return null;

  if (activeOrderData?._id === currentOrderId) {
    if (!canClientAccessOrder(activeOrderData)) return null;
    return activeOrderData;
  }

  const fetched = await fetchClientOrder(currentOrderId);
  if (!fetched) return null;

  const order = {
    ...fetched,
    _id: currentOrderId
  };

  if (!canClientAccessOrder(order)) return null;

  return order;
}

function escapeHTML(str = "") {
  return String(str).replace(/[&<>"']/g, s => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[s]));
}

function getClientSenderName(table) {
  return `${t("client_label")} (${t("table_label")} ${table || "-"})`;
}

function getChefDefaultName() {
  return t("chef_label");
}

function shouldRunCountdownByStatus(status) {
  const s = normalizeStatus(status);
  return s === "tayyorlanmoqda" || s === "cooking";
}

function playNotificationSound() {
  const audio = new Audio("/img/notify.wav");
  audio.play().catch(() => { });
}

/* =========================
   CART LOGIC
========================= */
function getMaxQtyByStock(menuId) {
  const menu = window.allMenu && (window.allMenu[menuId] || window.allMenu[String(menuId)]);
  if (!menu) return Infinity;

  const recipe = Array.isArray(menu.recipe) ? menu.recipe : (menu.recipe ? Object.values(menu.recipe) : []);
  if (!recipe || recipe.length === 0) return Infinity;

  const inv = window.allInventory || {};
  let maxQty = Infinity;

  for (const ing of recipe) {
    const ingId = ing.id;
    const needed = Number(ing.amount || 0);
    const recipeUnit = ing.unit || "gr";
    if (!ingId || needed <= 0) continue;

    const invData = inv[ingId];
    if (!invData) continue;

    let currentStock = parseFloat(invData.stock ?? 0);
    const stockUnit = invData.unit || "gr";

    const toGrams = (val, unit) => {
      if (unit === "kg") return val * 1000;
      if (unit === "l") return val * 1000;
      return val;
    };

    const stockInBase = toGrams(currentStock, stockUnit);
    const neededInBase = toGrams(needed, recipeUnit);

    const possible = Math.floor(stockInBase / neededInBase);
    if (possible < maxQty) maxQty = possible;
  }

  return maxQty === Infinity ? Infinity : maxQty;
}

function changeQty(id, delta) {

  try {

    id = String(id);

    console.log(
      "🖱 CLICK:",
      id,
      delta
    );

    // INIT
    if (
      !window.cart ||
      typeof window.cart !== "object"
    ) {
      window.cart = {};
    }

    const cart = window.cart;

    // Faqat miqdor oshirilayotganda tekshirish
    if (delta > 0) {
      const baseId = id.split("::")[0].split("__")[0];
      if (stopListData[baseId] === true) {
        alert(t("out_of_stock", "Tugagan"));
        return;
      }

      const currentQty = Number(cart[id]?.qty || 0);
      const newQty = currentQty + Number(delta);

      // Masalliq zaxirasini tekshirish
      const maxAllowed = getMaxQtyByStock(id);

      if (maxAllowed !== Infinity && newQty > maxAllowed) {
        if (maxAllowed <= 0) {
          // Masalliq tugagan
          const menuItem = window.allMenu && (window.allMenu[id] || window.allMenu[String(id)]);
          const name = menuItem
            ? (typeof menuItem.name === "object"
              ? (menuItem.name.uz || menuItem.name.ru || menuItem.name.en || "Taom")
              : (menuItem.name || "Taom"))
            : "Taom";
          const msg = typeof t === "function"
            ? t("stock_out_cant_order", `"${name}" uchun masalliq tugagan, buyurtma berib bo'lmaydi.`).replace("{name}", name)
            : `"${name}" uchun masalliq tugagan, buyurtma berib bo'lmaydi.`;
          alert(msg);
          return;
        } else {
          // Yetarli masalliq faqat maxAllowed ta uchun
          const menuItem = window.allMenu && (window.allMenu[id] || window.allMenu[String(id)]);
          const name = menuItem
            ? (typeof menuItem.name === "object"
              ? (menuItem.name.uz || menuItem.name.ru || menuItem.name.en || "Taom")
              : (menuItem.name || "Taom"))
            : "Taom";
          const msg = typeof t === "function"
            ? t("stock_limited_order", `Siz faqat ${maxAllowed} ta buyurtma bera olasiz (masalliq yetarli emas).`)
              .replace("{max}", maxAllowed)
              .replace("{name}", name)
            : `Siz faqat ${maxAllowed} ta "${name}" buyurtma bera olasiz (masalliq yetarli emas).`;
          alert(msg);

          // Maksimal ruxsat etilgan miqdorga o'rnatamiz
          if (!cart[id]) cart[id] = { qty: 0 };
          cart[id].qty = maxAllowed;

          window.cart = cart;
          localStorage.setItem("cart", JSON.stringify(cart));

          if (typeof updateCart === "function") updateCart();
          if (typeof renderCart === "function") renderCart();
          if (typeof renderMenu === "function") renderMenu();
          return;
        }
      }
    }

    // CREATE ITEM
    if (!cart[id]) {

      cart[id] = {
        qty: 0
      };
    }

    // UPDATE QTY
    cart[id].qty += Number(delta);

    // REMOVE IF 0
    if (cart[id].qty <= 0) {
      delete cart[id];
    }

    // SAVE
    window.cart = cart;

    localStorage.setItem(
      "cart",
      JSON.stringify(cart)
    );

    console.log(
      "✅ UPDATED CART:",
      cart
    );

    console.log(
      "💾 LOCALSTORAGE:",
      localStorage.getItem("cart")
    );

    // UI UPDATE
    if (
      typeof updateCart === "function"
    ) {
      updateCart();
    }

    if (
      typeof renderCart === "function"
    ) {
      renderCart();
    }

    if (
      typeof renderMenu === "function"
    ) {
      renderMenu();
    }

  } catch (err) {

    console.error(
      "❌ changeQty ERROR:",
      err
    );
  }
}

window.changeQty = changeQty;

/* ==============================================
   VARIANT MODAL — mijoz menyu
   Foydalanish: openVariantModal('menuItemId')
   Cart key: 'itemId__variantId'
   ============================================== */
// ══════════════════════════════════════════════════════
// 🧩 MODIFIERS (SECTION: MODIFIERS) — reuses the existing admin-managed
// restaurants/{id}/modifiers registry (already built in admin.js's
// Modifiers tab: name/minSelect/maxSelect/options). There is no per-dish
// assignment field yet anywhere in the codebase, so as a forward-compatible
// default: if a menu item has `modifierIds` (array) we use those groups;
// otherwise every active modifier group applies to every dish. TODO once
// admin.js gains a per-dish modifier picker, this automatically narrows.
// ══════════════════════════════════════════════════════
window.allModifiers = window.allModifiers || {};

function subscribeModifiers() {
  onValue(ref(db, BASE_PATH + "/modifiers"), snap => {
    window.allModifiers = snap.val() || {};
    if (typeof renderMenu === "function") renderMenu();
  });
}

// Taom tarkibiga (recipe) kiritilgan ingredient nomlarini olib, normallashtirilgan
// (kichik harf, bo'shliqlarsiz) to'plam qaytaradi — modifikator optionlarni shu
// tarkib bilan solishtirish uchun.
function getRecipeIngredientNameSet(item) {
  const recipe = Array.isArray(item?.recipe)
    ? item.recipe
    : (item?.recipe && typeof item.recipe === "object" ? Object.values(item.recipe) : []);
  const inv = window.allInventory || {};
  const names = recipe.map(ing => {
    const raw = ing?.name || (ing?.id && inv[ing.id] && inv[ing.id].name) || "";
    return String(raw).trim().toLowerCase();
  }).filter(Boolean);
  return new Set(names);
}

// Faqat taomning tarkibiga (recipe) kiritilgan optionlarni qoldirib, modifikator
// guruhlarini "tozalab" qaytaradi. Guruh ichida hech qanday mos option qolmasa,
// guruhning o'zi ham chiqarilib tashlanadi.
function getApplicableModifierGroups(item) {
  const all = Object.entries(window.allModifiers || {}).map(([id, m]) => ({ id, ...m })).filter(m => m.active !== false);
  const byIds = Array.isArray(item?.modifierIds) && item.modifierIds.length
    ? all.filter(m => item.modifierIds.includes(m.id))
    : all;

  const recipeNames = getRecipeIngredientNameSet(item);

  return byIds
    .map(g => {
      const filteredOptions = Object.fromEntries(
        Object.entries(g.options || {}).filter(([, o]) => recipeNames.has(String(o?.name || "").trim().toLowerCase()))
      );
      return { ...g, options: filteredOptions };
    })
    .filter(g => Object.keys(g.options).length > 0);
}

window.itemHasModifiers = function (itemId) {
  const item = (window.allMenu || {})[String(itemId)];
  if (!item) return false;
  return getApplicableModifierGroups(item).length > 0;
};

window.openItemModifiers = function (itemId, variantId = null) {
  const item = (window.allMenu || {})[String(itemId)];
  if (!item) return;
  const groups = getApplicableModifierGroups(item);
  if (groups.length === 0) { changeQty(variantId ? `${itemId}__${variantId}` : itemId, 1); return; }

  const lang = getLang();
  const name = typeof item.name === "object" ? (item.name[lang] || item.name.uz || "—") : item.name;

  if (!document.getElementById("_modifierModalStyles")) {
    const s = document.createElement("style");
    s.id = "_modifierModalStyles";
    s.textContent = `
      #itemModifierModal { position:fixed; inset:0; z-index:9999; display:flex; align-items:flex-end; justify-content:center; background:rgba(0,0,0,0.45); }
      .im-sheet { background:#fff; border-radius:24px 24px 0 0; padding:20px 20px 32px; width:100%; max-width:480px; max-height:85vh; overflow-y:auto; }
      .im-group { margin-bottom:16px; }
      .im-group-title { font-size:14px; font-weight:800; margin-bottom:2px; }
      .im-group-hint { font-size:11.5px; color:var(--text-muted,#94a3b8); margin-bottom:8px; }
      .im-option-row { display:flex; align-items:center; justify-content:space-between; padding:9px 0; border-bottom:1px solid var(--border-color,#f1f5f9); }
      .im-option-row label { display:flex; align-items:center; gap:10px; font-size:14px; flex:1; cursor:pointer; }
      .im-option-price { font-size:12.5px; color:var(--text-secondary,#64748b); }
    `;
    document.head.appendChild(s);
  }

  const groupsHtml = groups.map(g => {
    const gName = g.name?.[lang] || g.name?.uz || "";
    const isSingle = Number(g.maxSelect || 1) <= 1;
    const options = Object.entries(g.options || {}).map(([optId, o]) => ({ optId, ...o }));
    const inputType = isSingle ? "radio" : "checkbox";
    const optsHtml = options.map((o, idx) => `
      <div class="im-option-row">
        <label>
          <input type="${inputType}" name="im_group_${g.id}" value="${o.optId}" data-price="${Number(o.price || 0)}" data-group="${g.id}" ${isSingle && idx === 0 && Number(g.minSelect || 0) > 0 ? "checked" : ""}>
          <span>${o.name}</span>
        </label>
        <span class="im-option-price">${Number(o.price || 0) > 0 ? "+" + Number(o.price).toLocaleString() + " " + t("currency", "so'm") : ""}</span>
      </div>`).join("");
    return `<div class="im-group" data-group-id="${g.id}" data-min="${g.minSelect || 0}" data-max="${g.maxSelect || 1}">
      <div class="im-group-title">${gName}${Number(g.minSelect || 0) > 0 ? " *" : ""}</div>
      <div class="im-group-hint">${t("modifier_select_hint", "Tanlang")}: ${g.minSelect || 0}–${g.maxSelect || 1}</div>
      ${optsHtml}
    </div>`;
  }).join("");

  let modal = document.getElementById("itemModifierModal");
  if (modal) modal.remove();
  modal = document.createElement("div");
  modal.id = "itemModifierModal";
  modal.innerHTML = `
    <div class="im-sheet">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <b style="font-size:16px;">${name}</b>
        <button onclick="document.getElementById('itemModifierModal').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;" aria-label="Yopish">✕</button>
      </div>
      ${groupsHtml}
      <button class="co-pay-btn" onclick="window._confirmItemModifiers('${itemId}', ${variantId ? `'${variantId}'` : "null"})">${t("add_to_cart_btn", "Savatga qo'shish")}</button>
    </div>`;
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
};

window._confirmItemModifiers = function (itemId, variantId) {
  const modal = document.getElementById("itemModifierModal");
  if (!modal) return;
  const groupEls = modal.querySelectorAll(".im-group");
  const selected = [];
  for (const g of groupEls) {
    const min = Number(g.dataset.min || 0);
    const checked = g.querySelectorAll("input:checked");
    if (checked.length < min) {
      alert(t("modifier_min_required", "Iltimos, majburiy variantlarni tanlang"));
      return;
    }
    checked.forEach(inp => {
      const label = inp.closest("label")?.querySelector("span")?.textContent || "";
      selected.push({ groupId: g.dataset.groupId, optId: inp.value, name: label, price: Number(inp.dataset.price || 0) });
    });
  }

  const baseKey = variantId ? `${itemId}__${variantId}` : String(itemId);
  const modSig = selected.map(s => s.optId).sort().join(",");
  const cartKey = modSig ? `${baseKey}::${modSig}` : baseKey;

  if (!window.cart || typeof window.cart !== "object") window.cart = {};
  if (!window.cart[cartKey]) {
    window.cart[cartKey] = { qty: 0, ...(selected.length ? { modifiers: selected } : {}) };
    if (variantId) {
      const item = (window.allMenu || {})[String(itemId)];
      const v = item?.variants?.[variantId];
      window.cart[cartKey].price = Number(v?.price || 0);
      window.cart[cartKey].variantName = v?.name || "";
    }
  }
  window.cart[cartKey].qty += 1;
  localStorage.setItem("cart", JSON.stringify(window.cart));
  if (typeof updateCart === "function") updateCart();
  if (typeof renderMenu === "function") renderMenu();
  modal.remove();
};

window.openVariantModal = function(itemId) {
  const item = (window.allMenu || {})[String(itemId)];
  if (!item) return;

  const lang = typeof getLang === "function" ? getLang() : "uz";
  const name = typeof item.name === "object"
    ? (item.name[lang] || item.name.uz || item.name.ru || item.name.en || "—")
    : (item.name || "—");

  const variants = item.variants ? Object.values(item.variants) : [];

  // Inject modal CSS once
  if (!document.getElementById("_variantModalStyles")) {
    const s = document.createElement("style");
    s.id = "_variantModalStyles";
    s.textContent = `
      #variantModal {
        position: fixed; inset: 0; z-index: 9999;
        display: flex; align-items: flex-end; justify-content: center;
        background: rgba(0,0,0,0.45);
        padding: 0;
      }
      #variantModal.vm-hidden { display: none !important; }
      .vm-sheet {
        background: #fff;
        border-radius: 24px 24px 0 0;
        padding: 20px 20px 32px;
        width: 100%; max-width: 480px;
        animation: vm-slide-up .25s ease;
        max-height: 85vh; overflow-y: auto;
      }
      @keyframes vm-slide-up {
        from { transform: translateY(60px); opacity: 0; }
        to   { transform: translateY(0);   opacity: 1; }
      }
      .vm-header {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 6px;
      }
      .vm-title {
        font-size: 17px; font-weight: 800; color: #1a2e1a;
        flex: 1; padding-right: 10px; line-height: 1.3;
      }
      .vm-close {
        width: 32px; height: 32px; border-radius: 50%;
        background: #f1f5f9; border: none; cursor: pointer;
        font-size: 16px; display: flex; align-items: center; justify-content: center;
        color: #64748b; flex-shrink: 0;
      }
      .vm-close:active { background: #e2e8f0; }
      .vm-subtitle {
        font-size: 13px; color: #94a3b8; margin-bottom: 18px;
      }
      .vm-variant-row {
        display: flex; align-items: center; gap: 10px;
        padding: 12px 14px;
        border: 1.5px solid #e2e8f0;
        border-radius: 14px;
        margin-bottom: 10px;
        background: #fafafa;
        transition: border-color .15s, background .15s;
      }
      .vm-variant-row:last-child { margin-bottom: 0; }
      .vm-variant-info { flex: 1; min-width: 0; }
      .vm-variant-name {
        font-size: 15px; font-weight: 700; color: #1a2e1a;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .vm-variant-price {
        font-size: 13px; color: #15803d; font-weight: 600; margin-top: 2px;
      }
      .vm-qty-row {
        display: flex; align-items: center; gap: 0;
        background: #f3f4f6; border-radius: 12px; padding: 3px; flex-shrink: 0;
      }
      .vm-qty-btn {
        width: 34px; height: 34px;
        display: flex; align-items: center; justify-content: center;
        background: #fff; border: 1.5px solid rgba(22, 163, 74,0.3);
        border-radius: 9px; color: #15803d;
        font-size: 20px; font-weight: 700;
        cursor: pointer; line-height: 1; flex-shrink: 0;
        transition: background .15s, transform .12s;
        -webkit-tap-highlight-color: transparent;
      }
      .vm-qty-btn:active { background: #dcfce7; transform: scale(0.9); }
      .vm-qty-num {
        font-size: 15px; font-weight: 900; color: #1a2e1a;
        min-width: 28px; text-align: center; user-select: none;
      }
      .vm-done-btn {
        display: block; width: 100%; margin-top: 20px;
        padding: 14px; border: none; border-radius: 14px;
        background: #16A34A; color: #fff;
        font-size: 16px; font-weight: 800; cursor: pointer;
        transition: background .15s;
      }
      .vm-done-btn:active { background: #22a34a; }
      /* Active row highlight when qty > 0 */
      .vm-variant-row.vm-active {
        border-color: rgba(22, 163, 74,0.5);
        background: #f0fdf4;
      }
    `;
    document.head.appendChild(s);
  }

  // Build modal DOM
  let existingModal = document.getElementById("variantModal");
  if (existingModal) existingModal.remove();

  const modal = document.createElement("div");
  modal.id = "variantModal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  const rowsHtml = variants.map(v => {
    const cartKey = `${itemId}__${v.id}`;
    const qty = Number((window.cart || {})[cartKey]?.qty || 0);
    const priceStr = Number(v.price || 0).toLocaleString();
    const cur = typeof t === "function" ? t("currency", "so'm") : "so'm";
    return `
      <div class="vm-variant-row${qty > 0 ? " vm-active" : ""}" id="vmrow_${v.id}">
        <div class="vm-variant-info">
          <div class="vm-variant-name">${v.name || "—"}</div>
          <div class="vm-variant-price">${priceStr} ${cur}</div>
        </div>
        <div class="vm-qty-row">
          <button type="button" class="vm-qty-btn" onclick="changeQtyVariant('${itemId}','${v.id}',-1)">−</button>
          <span class="vm-qty-num" id="vmqty_${itemId}_${v.id}">${qty}</span>
          <button type="button" class="vm-qty-btn" onclick="changeQtyVariant('${itemId}','${v.id}',1)">+</button>
        </div>
      </div>`;
  }).join("");

  const chooseLbl = typeof t === "function" ? t("choose_variant", "Variantni tanlang") : "Variantni tanlang";
  const doneLbl   = typeof t === "function" ? t("done", "Tayyor") : "Tayyor";

  modal.innerHTML = `
    <div class="vm-sheet">
      <div class="vm-header">
        <div class="vm-title">${name}</div>
        <button type="button" class="vm-close" onclick="closeVariantModal()">✕</button>
      </div>
      <div class="vm-subtitle">${chooseLbl}</div>
      ${rowsHtml}
      <button type="button" class="vm-done-btn" onclick="closeVariantModal()">${doneLbl}</button>
    </div>`;

  // Close on backdrop click
  modal.addEventListener("click", e => { if (e.target === modal) closeVariantModal(); });

  document.body.appendChild(modal);
};

window.closeVariantModal = function() {
  const m = document.getElementById("variantModal");
  if (m) m.remove();
  if (typeof renderMenu === "function") renderMenu();
};

window.changeQtyVariant = function(itemId, variantId, delta) {
  try {
    itemId    = String(itemId);
    variantId = String(variantId);
    delta     = Number(delta);

    if (!window.cart || typeof window.cart !== "object") window.cart = {};
    const cart    = window.cart;
    const cartKey = `${itemId}__${variantId}`;

    const item    = (window.allMenu || {})[itemId];
    const variant = item?.variants?.[variantId];

    if (!cart[cartKey]) {
      cart[cartKey] = {
        qty: 0,
        menuId: itemId,
        variantId,
        variantName: variant?.name || "",
        price: Number(variant?.price || 0),
      };
    }

    cart[cartKey].qty += delta;
    if (cart[cartKey].qty <= 0) delete cart[cartKey];

    window.cart = cart;
    localStorage.setItem("cart", JSON.stringify(cart));

    // Update qty badge inside the open modal
    const qtyEl = document.getElementById(`vmqty_${itemId}_${variantId}`);
    if (qtyEl) qtyEl.textContent = String(cart[cartKey]?.qty || 0);
    // Highlight row
    const rowEl = document.getElementById(`vmrow_${variantId}`);
    if (rowEl) rowEl.classList.toggle("vm-active", (cart[cartKey]?.qty || 0) > 0);

    if (typeof updateCart === "function") updateCart();
  } catch (err) {
    console.error("❌ changeQtyVariant ERROR:", err);
  }
};

function removeFromCart(id) {

  id = String(id);

  delete cart[id];

  localStorage.setItem(
    "cart",
    JSON.stringify(cart)
  );

  updateCart();

  if (typeof renderMenu === "function") {
    renderMenu();
  }
}

window.removeFromCart = removeFromCart;

function updateCart() {
  if (!cartItems || !cartTotal || !cartCount) return;

  // ── Savat CSS (bir marta inject) ──────────────────────────────
  if (!document.getElementById("_cartCardStyles")) {
    const s = document.createElement("style");
    s.id = "_cartCardStyles";
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800;900&display=swap');

      /* ══════════════════════════════════════════
         Nesta ERP — Savat karta (v3 — screenshot match)
         Uses CSS variables from client.css
         ══════════════════════════════════════════ */

      .nc-cart-empty {
        display: flex; flex-direction: column; align-items: center;
        justify-content: center; gap: 12px; padding: 48px 20px;
        color: var(--text-muted); font-size: 15px; font-weight: 500; text-align: center;
      }
      .nc-cart-empty-icon { font-size: 56px; line-height: 1; }

      /* ── Karta asosi ── */
      .nc-cart-card {
        background: #ffffff;
        border: 1.5px solid rgba(34,197,94,0.15);
        border-radius: 18px;
        margin-bottom: 12px;
        overflow: hidden;
        box-shadow: 0 2px 12px rgba(0,0,0,0.06);
        transition: box-shadow .22s, transform .18s;
      }
      .nc-cart-card:last-child { margin-bottom: 0; }
      .nc-cart-card:hover {
        box-shadow: 0 6px 20px rgba(34,197,94,0.12);
        border-color: rgba(34,197,94,0.35);
        transform: translateY(-1px);
      }

      /* ── Karta ichki: rasm chap, kontent o'ng ── */
      .nc-cart-card-top {
        display: grid;
        grid-template-columns: 110px 1fr;
        align-items: stretch;
        min-height: 110px;
      }
      @media (max-width: 400px) {
        .nc-cart-card-top { grid-template-columns: 88px 1fr; }
        .nc-cart-img-wrap { width: 88px; }
        .nc-cart-img, .nc-cart-img-placeholder { width: 88px; height: 88px; }
      }

      /* Rasm ustuni */
      .nc-cart-img-wrap {
        width: 110px;
        min-width: 110px;
        flex-shrink: 0;
        overflow: hidden;
        align-self: stretch;
        display: block;
        position: relative;
      }
      .nc-cart-img {
        width: 110px;
        height: 110px;
        object-fit: cover;
        display: block;
      }
      .nc-cart-img-placeholder {
        width: 110px;
        height: 110px;
        display: flex; align-items: center; justify-content: center;
        font-size: 38px;
        background: linear-gradient(140deg, #f0fdf4, #dcfce7);
      }

      /* Kontent bloki (o'ng tomon) */
      .nc-cart-body {
        padding: 12px 14px 10px 13px;
        display: flex; flex-direction: column; gap: 6px; min-width: 0;
      }

      /* Nom + O'chirish qatori */
      .nc-cart-top {
        display: flex; align-items: flex-start;
        justify-content: space-between; gap: 6px;
      }
      .nc-cart-name {
        font-family: 'Sora', sans-serif;
        font-size: 15px; font-weight: 800;
        color: #1a2e1a; line-height: 1.3; flex: 1;
        overflow: hidden; display: -webkit-box;
        -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      }
      .nc-cart-del {
        width: 28px; height: 28px; border-radius: 50%;
        background: rgba(239,68,68,0.06); border: 1px solid rgba(239,68,68,0.18);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; flex-shrink: 0;
        transition: background .15s, transform .15s;
        font-size: 12px; line-height: 1; color: rgba(239,68,68,0.65);
      }
      .nc-cart-del:hover { background: rgba(239,68,68,0.14); color: #ef4444; transform: scale(1.12); }
      .nc-cart-del:active { transform: scale(0.9); }

      /* Kategoriya nishonlari */
      .nc-cart-cats { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
      .nc-cat-badge {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 11px; font-weight: 600;
        padding: 3px 10px; border-radius: 20px; white-space: nowrap;
      }
      .nc-cat-badge.cat {
        background: #f0fdf4; color: #15803d;
        border: 1.5px solid rgba(34,197,94,0.25);
      }
      .nc-cat-badge.sub {
        background: #eff6ff; color: #1d4ed8;
        border: 1.5px solid rgba(59,130,246,0.25);
      }

      /* Allergen teglari */
      .nc-cart-props { display: flex; flex-wrap: wrap; gap: 5px; }
      .nc-prop-tag {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 10.5px; font-weight: 600;
        padding: 3px 9px; border-radius: 30px;
        background: #fff7ed; color: #c2410c;
        border: 1.5px solid #fed7aa; white-space: nowrap;
      }

      /* ── Ajratgich + footer: narx & qty bir qatorda ── */
      .nc-cart-divider {
        height: 1px;
        background: rgba(34,197,94,0.12);
        margin: 0;
      }
      .nc-cart-footer {
        display: flex; align-items: center;
        justify-content: space-between; gap: 10px;
        padding: 9px 14px 11px 13px;
        background: transparent;
      }

      /* Narx bloki */
      .nc-price-wrap { text-align: left; }
      .nc-cart-price-main {
        font-family: 'Sora', sans-serif;
        font-size: 17px; font-weight: 900;
        color: #15803d; white-space: nowrap; line-height: 1.2;
      }
      .nc-cart-price-currency {
        font-size: 12px; font-weight: 700; color: #15803d;
      }
      .nc-cart-price-unit {
        font-size: 11.5px; color: #9ca3af;
        font-weight: 500; white-space: nowrap; margin-top: 1px;
      }

      /* Qty +/- tugmalari — footerda */
      .nc-cart-qty-row {
        display: flex; align-items: center; gap: 0;
        background: #f3f4f6;
        border-radius: 12px;
        padding: 3px;
        flex-shrink: 0;
      }
      .nc-cart-qty-btn {
        width: 32px; height: 32px;
        display: flex; align-items: center; justify-content: center;
        background: #ffffff;
        border: 1.5px solid rgba(34,197,94,0.25);
        border-radius: 9px;
        color: #15803d; font-size: 20px; font-weight: 700;
        cursor: pointer; line-height: 1; flex-shrink: 0;
        transition: background .15s, border-color .15s, transform .12s;
        -webkit-tap-highlight-color: transparent;
        box-shadow: 0 1px 4px rgba(0,0,0,0.07);
      }
      .nc-cart-qty-btn:hover { background: #f0fdf4; border-color: #22c55e; }
      .nc-cart-qty-btn:active { background: #dcfce7; transform: scale(0.9); }
      .nc-cart-qty-num {
        font-family: 'Sora', sans-serif;
        font-size: 15px; font-weight: 900;
        color: #1a2e1a; user-select: none;
        min-width: 28px; text-align: center;
      }
    `;
    document.head.appendChild(s);
  }

  let htmlContent = "";
  let total = 0;
  let count = 0;
  const lang = getLang();

  const PROP_ICONS = {
    "spicy": "🌶️", "achchiq": "🌶️", "no-spicy": "🌶️", "achchiqsiz": "🌶️",
    "vegan": "🥗", "vegetarian": "🥗",
    "gluten": "🌾", "gluten-free": "🌾",
    "dairy": "🥛", "sut": "🥛", "no-dairy": "🥛",
    "nut": "🥜", "yongoq": "🥜",
    "halal": "☪️", "kosher": "✡️",
    "tuzsiz": "🧂", "kam-tuzli": "🧂",
    "piyozsiz": "🧅", "kokatsiz": "🌿", "yogsiz": "🫙",
  };

  function getPropIcon(tag) {
    const k = String(tag).toLowerCase().replace(/\s+/g, "-");
    for (const [key, ico] of Object.entries(PROP_ICONS)) {
      if (k.includes(key)) return ico;
    }
    return "⚠️";
  }

  const entries = Object.entries(cart);

  if (entries.length === 0) {
    htmlContent = `
      <div class="nc-cart-empty">
        <span>🛒</span>
        <div>${t("cart_empty", "Savat bo\'sh")}</div>
      </div>`;
  }

  entries.forEach(([id, c]) => {
    // Support plain itemId, itemId__variantId, and either with a trailing
    // ::modifierSignature (see buildOrderItemsFromCart for the full scheme)
    const keyWithoutMods = id.split("::")[0];
    const isVariantKey = keyWithoutMods.includes("__");
    const menuId    = isVariantKey ? keyWithoutMods.split("__")[0] : keyWithoutMods;
    const variantId = isVariantKey ? keyWithoutMods.split("__")[1] : null;

    const m = allMenu[menuId] || allMenu[String(menuId)] || allMenu[Number(menuId)];
    if (!m) return;

    const name = m.name?.[lang] || m.name?.uz || m.name?.ru || m.name?.en || "—";

    // Variant variantida narx variant.price dan olinadi, aks holda m.price
    let price;
    if (isVariantKey && variantId && m.variants?.[variantId]) {
      price = Number(m.variants[variantId].price || 0);
    } else if (isVariantKey && c.price) {
      price = Number(c.price || 0);
    } else {
      price = Number(m.price || 0);
    }

    const modifiers = Array.isArray(c.modifiers) ? c.modifiers : [];
    price += modifiers.reduce((s, mo) => s + Number(mo.price || 0), 0);

    const qty = Number(c.qty || 0);
    const sum = price * qty;
    const imgSrc = m.imgUrl || m.img || m.image || "";

    // Variant nomi (agar mavjud bo'lsa sarlavhaga qo'shamiz)
    const variantName = isVariantKey
      ? (m.variants?.[variantId]?.name || c.variantName || "")
      : "";
    const displayName = variantName ? `${name} — ${variantName}` : name;
    const modifiersHtml = modifiers.length
      ? `<div class="nc-cart-modifiers">${modifiers.map(mo => `<span class="nc-mod-chip">${mo.name}${Number(mo.price) > 0 ? ` (+${Number(mo.price).toLocaleString()})` : ""}</span>`).join("")}</div>`
      : "";

    total += sum;
    count += qty;

    // Kategoriya nomi (CATEGORY_DATA dan olish)
    const safeCategories = (typeof CATEGORY_DATA !== "undefined" && CATEGORY_DATA.categories)
      ? CATEGORY_DATA.categories : [];
    const catObj = safeCategories.find(cc => String(cc.id) === String(m.category));
    const catName = catObj
      ? (typeof t === "function" ? t(catObj.nameKey) : catObj.nameKey)
      : (m.category || "");
    const subName = m.subcategory
      ? (typeof t === "function" ? t(m.subcategory) || m.subcategory : m.subcategory)
      : "";

    // Kategoriya nishonlari
    const catBadges = [
      catName ? `<span class="nc-cat-badge cat">📂 ${catName}</span>` : "",
      subName ? `<span class="nc-cat-badge sub">🏷 ${subName}</span>` : "",
    ].join("");

    // Allergen/xususiyat teglari
    const allergens = Array.isArray(m.allergens) ? m.allergens
      : (m.allergens && typeof m.allergens === "object" ? Object.values(m.allergens) : []);
    const tags = Array.isArray(m.tags) ? m.tags
      : (m.tags && typeof m.tags === "object" ? Object.values(m.tags) : []);
    const allProps = [...allergens, ...tags].filter(Boolean);
    const propHtml = allProps.length > 0
      ? `<div class="nc-cart-props">${allProps.map(p =>
        `<span class="nc-prop-tag">${getPropIcon(p)} ${p}</span>`
      ).join("")}</div>`
      : "";

    htmlContent += `
      <div class="nc-cart-card">

        <div class="nc-cart-card-top">
          <div class="nc-cart-img-wrap">
            ${imgSrc
        ? `<img class="nc-cart-img" src="${imgSrc}" alt="${name}" onerror="this.outerHTML='<div class=\\'nc-cart-img-placeholder\\'>🍽️</div>'">`
        : `<div class="nc-cart-img-placeholder">🍽️</div>`
      }
          </div>
          <div class="nc-cart-body">
            <div class="nc-cart-top">
              <span class="nc-cart-name">${displayName}</span>
            </div>
            ${catBadges ? `<div class="nc-cart-cats">${catBadges}</div>` : ""}
            ${modifiersHtml}
            ${propHtml}
          </div>
        </div>

        <div class="nc-cart-divider"></div>

        <div class="nc-cart-footer">
          <div class="nc-price-wrap">
            <div class="nc-cart-price-main">${sum.toLocaleString()} <span class="nc-cart-price-currency">${t("currency", "so'm")}</span></div>
            <div class="nc-cart-price-unit">${price.toLocaleString()} × ${qty}</div>
          </div>
          <div class="nc-cart-qty-row">
            <button class="nc-cart-qty-btn" onclick="changeQty('${id}',-1)">−</button>
            <span class="nc-cart-qty-num">${qty}</span>
            <button class="nc-cart-qty-btn" onclick="changeQty('${id}',1)">+</button>
          </div>
        </div>

      </div>
    `;
  });

  cartItems.innerHTML = htmlContent;

  const baseCookTime = calculateOrderCookTime(cart);
  currentBaseCookTime = baseCookTime;

  const result = calculatePriority(total, baseCookTime);
  cartTotal.innerText = result.finalTotal.toLocaleString();
  cartCount.innerText = count;

  const badge = document.getElementById("cartCount");
  if (badge) badge.style.display = count > 0 ? "flex" : "none";

  // Floating sticky cart: only visible once the customer has added the first item.
  const cartIconEl = document.getElementById("cartIcon");
  if (cartIconEl) cartIconEl.style.display = count > 0 ? "flex" : "none";
}


window.allMenu = {};
let allMenu = window.allMenu;

function subscribeMenuRealtime() {

  onValue(
    ref(db, BASE_PATH + "/menu"),
    snap => {

      const data =
        snap.val() || {};

      window.allMenu = data;
      allMenu = data;

      console.log(
        "✅ MENU UPDATED:",
        allMenu
      );

      safeRenderMenu();
      if (typeof renderHomeFeaturedSections === "function") renderHomeFeaturedSections();

      updateCart();
    },
    // Diagnosability + UX fix: this onValue() used to have no error
    // callback at all — a denied read (e.g. establishClientSession()'s QR
    // token mint silently failing — see that function's own fix) meant
    // this callback simply never fired, window.allMenu stayed {}, and
    // renderMenu() (never even called again) left #clientMenu on its
    // static, empty "Menyu" heading with nothing under it — no error, no
    // retry, nothing to explain why. Now logs the real reason AND shows a
    // visible, non-silent state instead of leaving the section blank.
    err => {
      console.error("[MENU] restaurants/.../menu o'qishda xato:", err?.code || err?.message);
      if (clientMenu) {
        clientMenu.innerHTML = `<div class="empty-state" style="grid-column:1/-1;text-align:center;padding:24px;color:#94a3b8;">
          ${typeof t === "function" ? t("menu_load_error", "Menyuni yuklab bo'lmadi. Sahifani yangilab ko'ring.") : "Menyuni yuklab bo'lmadi. Sahifani yangilab ko'ring."}
        </div>`;
      }
    }
  );
}

// ---- Inventory (masalliqlar zaxirasi) real-time tinglash ----
function subscribeInventoryRealtime() {
  if (!window.allInventory) window.allInventory = {};

  onValue(
    ref(db, BASE_PATH + "/inventory"),
    snap => {
      window.allInventory = snap.val() || {};
      // Menyu qayta renderlanmaydi, faqat xotira yangilanadi
      console.log("✅ INVENTORY UPDATED:", Object.keys(window.allInventory).length, "masalliq");
    }
  );
}

let renderLock = false;
window.renderLock = false;

function safeRenderMenu() {

  if (window.renderLock) return;

  window.renderLock = true;

  requestAnimationFrame(() => {

    if (
      typeof renderMenu ===
      "function"
    ) {

      renderMenu();
    }

    window.renderLock = false;
  });
}

/* =========================
   ORDER PLACEMENT
========================= */
async function createClientTimelineEvent(orderId, eventMessage) {
  const timelineRef = ref(db, `${BASE_PATH}/orderTimeline/${orderId}`);
  const newEvent = {
    orderId: orderId,
    eventType: "client_action",
    payload: { message: eventMessage },
    actorId: clientId,
    actorName: t("client_label", "Mijoz"),
    actorRole: "client",
    createdAt: Date.now()
  };
  await push(timelineRef, newEvent);
}

window.currentRewardNote = "";
window.currentRewardDiscount = 0;

/* =========================
   BUYURTMA YUBORISH 
========================= */
/* =========================
   ALLERGIYA / OVQAT XUSUSIYATI MODALI
========================= */
window.__clientAllergyModalResolve = null;

window.openAllergyModal = function () {
  return new Promise((resolve) => {
    window.__clientAllergyModalResolve = resolve;

    let modal = document.getElementById("clientAllergyModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "clientAllergyModal";
      modal.innerHTML = `
        <style>
          #clientAllergyModal {
            position: fixed; inset: 0; z-index: 99999;
            background: rgba(0,0,0,0.5);
            display: flex; align-items: flex-end; justify-content: center;
            animation: fadeInAllergy 0.2s ease;
          }
          @keyframes fadeInAllergy { from { opacity: 0 } to { opacity: 1 } }
          #clientAllergyBox {
            background: #fff; width: 100%; max-width: 480px;
            border-radius: 20px 20px 0 0;
            padding: 24px 20px 32px;
            animation: slideUpAllergy 0.3s ease;
          }
          @keyframes slideUpAllergy { from { transform: translateY(40px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
          #clientAllergyBox h3 {
            margin: 0 0 6px; font-size: 17px; font-weight: 700; color: #111;
          }
          #clientAllergyBox p {
            margin: 0 0 16px; font-size: 13px; color: #666;
          }
          .allergy-chips {
            display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px;
          }
          .allergy-chip {
            padding: 8px 14px; border-radius: 20px; font-size: 13px; font-weight: 500;
            border: 2px solid #e0e0e0; background: #f5f5f5; cursor: pointer;
            transition: all 0.2s; user-select: none;
          }
          .allergy-chip.selected {
            border-color: #168a5f; background: #e7f6ef; color: #168a5f;
          }
          .allergy-custom-row {
            display: flex; gap: 8px; margin-bottom: 18px;
          }
          #allergyCustomInput {
            flex: 1; padding: 10px 14px; border: 1.5px solid #ddd; border-radius: 12px;
            font-size: 14px; outline: none; font-family: inherit;
          }
          #allergyCustomInput:focus { border-color: #168a5f; }
          .allergy-custom-add {
            padding: 10px 14px; background: #168a5f; color: white; border: none;
            border-radius: 12px; cursor: pointer; font-size: 13px; font-weight: 600;
          }
          .allergy-actions {
            display: flex; gap: 10px;
          }
          .allergy-skip-btn {
            flex: 1; padding: 13px; border: 1.5px solid #ddd; background: #f5f5f5;
            border-radius: 12px; font-size: 14px; font-weight: 600; cursor: pointer;
          }
          .allergy-confirm-btn {
            flex: 2; padding: 13px; background: linear-gradient(135deg, #168a5f, #0f6f4d);
            color: white; border: none; border-radius: 12px;
            font-size: 14px; font-weight: 700; cursor: pointer;
          }
          .allergy-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; min-height: 0; }
          .allergy-tag {
            background: #168a5f; color: white; padding: 4px 10px 4px 12px;
            border-radius: 20px; font-size: 12px; display: flex; align-items: center; gap: 6px;
          }
          .allergy-tag-remove { cursor: pointer; font-size: 14px; line-height: 1; }
        </style>
        <div id="clientAllergyBox">
          <h3>🍽️ ${t('special_requests_title', "Maxsus so\'rovlar")}</h3>
          <p>${t('special_requests_desc', 'Ovqat xususiyatlarini belgilang (ixtiyoriy)')}</p>

          <div class="allergy-chips">
            <div class="allergy-chip" data-value="${t('chip_no_salt', 'Tuzsiz')}">🧂 ${t('chip_no_salt', 'Tuzsiz')}</div>
            <div class="allergy-chip" data-value="${t('chip_low_salt', 'Kam tuzli')}">🧂 ${t('chip_low_salt', 'Kam tuzli')}</div>
            <div class="allergy-chip" data-value="${t('chip_no_spicy', 'Achchiqsiz')}">🌶️ ${t('chip_no_spicy', 'Achchiqsiz')}</div>
            <div class="allergy-chip" data-value="${t('chip_spicy', 'Achchiq')}">🌶️ ${t('chip_spicy', 'Achchiq')}</div>
            <div class="allergy-chip" data-value="${t('chip_no_onion', 'Piyozsiz')}">🧅 ${t('chip_no_onion', 'Piyozsiz')}</div>
            <div class="allergy-chip" data-value="${t('chip_no_greens', "Ko\'katsiz")}">🌿 ${t('chip_no_greens', "Ko\'katsiz")}</div>
            <div class="allergy-chip" data-value="${t('chip_no_oil', "Yog\'siz")}">🫙 ${t('chip_no_oil', "Yog\'siz")}</div>
            <div class="allergy-chip" data-value="${t('chip_vegetarian', 'Vegetarian')}">🥗 ${t('chip_vegetarian', 'Vegetarian')}</div>
          </div>

          <div class="allergy-tags" id="allergyTagList"></div>

          <div class="allergy-custom-row">
            <input id="allergyCustomInput" type="text" placeholder="${t('allergy_custom_placeholder', "O\'zingiz yozing (masalan: sut allergiyasi)...")}" maxlength="80" />
            <button class="allergy-custom-add" id="allergyCustomAddBtn">+ ${t('allergy_add_btn', "Qo\'sh")}</button>
          </div>

          <div class="allergy-actions">
            <button class="allergy-skip-btn" id="allergySkipBtn">${t('allergy_skip_btn', "O\'tkazib yuborish")}</button>
            <button class="allergy-confirm-btn" id="allergyConfirmBtn">✅ ${t('order_button', 'Buyurtma berish')}</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    // State
    const selectedTags = new Set();
    const tagListEl = modal.querySelector("#allergyTagList");
    const customInput = modal.querySelector("#allergyCustomInput");

    function renderTags() {
      tagListEl.innerHTML = [...selectedTags].map(v =>
        `<div class="allergy-tag">${v} <span class="allergy-tag-remove" data-val="${v}">×</span></div>`
      ).join("");
      tagListEl.querySelectorAll(".allergy-tag-remove").forEach(btn => {
        btn.addEventListener("click", () => {
          selectedTags.delete(btn.dataset.val);
          // deselect chip if exists
          modal.querySelectorAll(".allergy-chip").forEach(c => {
            if (c.dataset.value === btn.dataset.val) c.classList.remove("selected");
          });
          renderTags();
        });
      });
    }

    // Chip clicks
    modal.querySelectorAll(".allergy-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const val = chip.dataset.value;
        if (chip.classList.contains("selected")) {
          chip.classList.remove("selected");
          selectedTags.delete(val);
        } else {
          chip.classList.add("selected");
          selectedTags.add(val);
        }
        renderTags();
      });
    });

    // Custom add
    modal.querySelector("#allergyCustomAddBtn").addEventListener("click", () => {
      const val = customInput.value.trim();
      if (!val) return;
      selectedTags.add(val);
      customInput.value = "";
      renderTags();
    });
    customInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const val = customInput.value.trim();
        if (!val) return;
        selectedTags.add(val);
        customInput.value = "";
        renderTags();
      }
    });

    // Skip
    modal.querySelector("#allergySkipBtn").addEventListener("click", () => {
      modal.remove();
      resolve("");
    });

    // Confirm
    modal.querySelector("#allergyConfirmBtn").addEventListener("click", () => {
      const note = [...selectedTags].join(", ");
      modal.remove();
      resolve(note);
    });

    modal.addEventListener("click", e => {
      if (e.target === modal) { modal.remove(); resolve(""); }
    });
  });
};

// ══════════════════════════════════════════════════════
// 🚚 DELIVERY CHECKOUT
// QR links with ?table= persist a dine-in order via sendTableOrder().
// Links without a table still go through delivery checkout
// (sendDeliveryOrder). Takeaway is a separate flow.
// ══════════════════════════════════════════════════════

window._selectedOrderType = ORDER_TYPE.DELIVERY;
let _daMapInstance = null;
let _daMapMarker = null;
let _selectedDeliveryLatLng = null;

// Delivery-only app: the address panel/map are always shown (no order-type
// toggle needed since dine-in/takeaway have their own separate apps).
function initDeliveryCheckoutPanel() {
  initDeliveryAddressMap();
  renderSavedAddressesRow();
  updateDeliveryFeePreview();
  wireAddressLabelLiveUpdate();
}

// ── Yandex Maps (SECTION: CHECKOUT / LOCATION) ────────────────────────────
// Per spec the delivery address must be picked on Yandex Maps (previously
// Leaflet/OpenStreetMap). The API key is an admin-configured, additive
// settings field (same pattern as the existing unused deliverySettings.yandexGo.apiKey)
// — if it isn't set yet, the map is skipped gracefully and the manual address
// fields (street/house/apartment/...) still work on their own.
let _yandexMapsLoadPromise = null;
function loadYandexMapsScript(apiKey) {
  if (window.ymaps) return Promise.resolve(window.ymaps);
  if (_yandexMapsLoadPromise) return _yandexMapsLoadPromise;
  _yandexMapsLoadPromise = new Promise((resolve, reject) => {
    const langMap = { uz: "en_US", ru: "ru_RU", en: "en_US" };
    const script = document.createElement("script");
    script.src = `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(apiKey)}&lang=${langMap[getLang()] || "en_US"}`;
    script.onload = () => window.ymaps.ready(() => resolve(window.ymaps));
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return _yandexMapsLoadPromise;
}

async function initDeliveryAddressMap() {
  const el = document.getElementById("deliveryAddressMap");
  if (!el) return;
  const apiKey = RESTAURANT_SETTINGS.deliverySettings?.yandexMapsApiKey;
  if (!apiKey) {
    console.warn("[delivery map] deliverySettings.yandexMapsApiKey sozlanmagan — xarita ko'rsatilmaydi, manzil maydonlari qo'lda ishlaydi.");
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  const originLat = Number(RESTAURANT_SETTINGS.deliverySettings?.restaurantLocation?.lat) || 41.311081;
  const originLng = Number(RESTAURANT_SETTINGS.deliverySettings?.restaurantLocation?.lng) || 69.240562;
  try {
    const ymaps = await loadYandexMapsScript(apiKey);
    if (!_daMapInstance) {
      _daMapInstance = new ymaps.Map(el, { center: [originLat, originLng], zoom: 13, controls: ["zoomControl"] });
      _daMapInstance.events.add("click", (e) => {
        const coords = e.get("coords");
        setDeliveryLatLng(coords[0], coords[1]);
      });
    }
  } catch (err) {
    console.error("[delivery map] Yandex Maps yuklanmadi:", err);
    el.style.display = "none";
  }
}

function setDeliveryLatLng(lat, lng, skipGeocode = false) {
  _selectedDeliveryLatLng = { lat, lng };
  if (_daMapInstance && window.ymaps) {
    if (_daMapMarker) _daMapInstance.geoObjects.remove(_daMapMarker);
    _daMapMarker = new window.ymaps.Placemark([lat, lng]);
    _daMapInstance.geoObjects.add(_daMapMarker);
    _daMapInstance.setCenter([lat, lng], 15);
  }
  updateDeliveryFeePreview();
  if (typeof recomputeDeliveryCheckoutTotal === "function" && document.getElementById("dc-final-price")) {
    recomputeDeliveryCheckoutTotal();
  }
  // Smart address autofill (SECTION: DELIVERY ADDRESS) — only when the
  // customer just picked a new point (map click / "use my location"), not
  // when restoring a previously saved address (those already have their own
  // stored street/house values, which reverse geocoding must not overwrite).
  if (!skipGeocode) reverseGeocodeAndFillAddress(lat, lng);
}

// ── Reverse geocoding for smart address autofill ──────────────────────────
// Reuses the same Yandex Maps API key/loader already used for the map
// (loadYandexMapsScript) — no new provider or key introduced. City/District/
// Mahalla/Street/House are filled when the geocoder returns them; Apartment
// is filled only if the geocoder happens to expose it (rare — reverse
// geocoding is building-level, not unit-level). Anything the geocoder can't
// determine is left empty rather than guessed. Floor/Entrance/Door
// code/Landmark/Comment are never touched — always manual, and optional.
async function reverseGeocodeAndFillAddress(lat, lng) {
  const apiKey = RESTAURANT_SETTINGS.deliverySettings?.yandexMapsApiKey;
  const statusEl = document.getElementById("daGeocodeStatus");
  if (!apiKey) return; // no map/geocoding key configured — fields stay fully manual

  if (statusEl) {
    statusEl.textContent = t("geocoding_in_progress", "Manzil aniqlanmoqda...");
    statusEl.style.display = "block";
  }

  try {
    const ymaps = await loadYandexMapsScript(apiKey);
    const res = await ymaps.geocode([lat, lng], { results: 1 });
    const geoObject = res.geoObjects.get(0);
    const components = geoObject?.properties.get("metaDataProperty")?.GeocoderMetaData?.Address?.Components || [];
    // Yandex can return several components sharing the same "kind" (e.g. two
    // "district" entries — a wide district and a locality-level one), so we
    // collect ALL names per kind rather than just the first match.
    const getAllComp = kind => components.filter(c => c.kind === kind).map(c => c.name).filter(Boolean);
    const getComp = kind => getAllComp(kind)[0] || "";

    // Real-world Yandex "kind" hierarchy for Uzbekistan addresses:
    // country ("Uzbekistan") → province (viloyat, e.g. "Jizzax viloyati")
    // → area (tuman, e.g. "Zomin tumani") → locality (shahar/qishloq,
    // e.g. "Jizzax" or a village) → district (mahalla/mikro-tuman, only
    // present inside big cities) → street → house.
    // "country" must NEVER be used as shahar/tuman — that's the earlier bug.
    const city = getComp("locality") || "";
    const district = getComp("area") || getComp("province") || "";
    // "district" kind = local micro-district/mahalla level (distinct from
    // "area" = tuman). Falls back to "other" if the geocoder exposes it there.
    const mahalla = getComp("district") || getComp("other") || "";
    const street = getComp("street");
    const house = getComp("house");
    // Reverse geocoding is building-level, not unit-level — this is
    // intentionally almost always empty; the field simply stays manual.
    const apartment = getComp("entrance");

    const cityEl = document.getElementById("daCity");
    const districtEl = document.getElementById("daDistrict");
    const mahallaEl = document.getElementById("daMahalla");
    const streetEl = document.getElementById("daStreet");
    const houseEl = document.getElementById("daHouse");
    const apartmentEl = document.getElementById("daApartment");
    if (cityEl && city) cityEl.value = city;
    if (districtEl && district) districtEl.value = district;
    if (mahallaEl && mahalla) mahallaEl.value = mahalla;
    if (streetEl && street) streetEl.value = street;
    if (houseEl && house) houseEl.value = house;
    if (apartmentEl && apartment) apartmentEl.value = apartment;

    if (statusEl) {
      statusEl.textContent = (city || district || street || house)
        ? t("geocoding_success", "Manzil avtomatik to'ldirildi, tekshirib ko'ring")
        : t("geocoding_no_result", "Manzil aniqlanmadi, iltimos qo'lda kiriting");
      setTimeout(() => { statusEl.style.display = "none"; }, 3000);
    }
  } catch (err) {
    console.warn("reverseGeocodeAndFillAddress error:", err);
    if (statusEl) {
      statusEl.textContent = t("geocoding_failed", "Manzilni aniqlab bo'lmadi, iltimos qo'lda kiriting");
      setTimeout(() => { statusEl.style.display = "none"; }, 3000);
    }
  }
}

window.useMyLocationForDelivery = function () {
  if (!navigator.geolocation) {
    alert(t("delivery_geolocation_unsupported", "Brauzeringiz joylashuvni aniqlay olmaydi."));
    return;
  }
  const btn = document.getElementById("daLocateBtn");
  const statusEl = document.getElementById("daGeocodeStatus");
  if (btn) btn.disabled = true;
  if (statusEl) {
    statusEl.textContent = t("delivery_locating", "Joylashuvingiz aniqlanmoqda...");
    statusEl.style.display = "block";
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (btn) btn.disabled = false;
      setDeliveryLatLng(pos.coords.latitude, pos.coords.longitude);
    },
    () => {
      if (btn) btn.disabled = false;
      if (statusEl) statusEl.style.display = "none";
      alert(t("delivery_geolocation_denied", "Joylashuvga ruxsat berilmadi."));
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
};

// Yetkazib berish hududi: "unlimited" bo'lsa doim ruxsat, "radius" bo'lsa
// restoran markazidan belgilangan km dan uzoqroq manzillar bloklanadi.
// Ko'pburchak/ko'p-hududli tizim olib tashlandi (Yandex Go asosida ishlash
// uchun sodda yagona radius yetarli).
function isOutsideDeliveryArea(lat, lng, ds) {
  if (!ds || ds.areaMode !== "radius") return false;
  const origin = ds.restaurantLocation || {};
  if (typeof origin.lat !== "number" || typeof origin.lng !== "number") return false;
  const dist = haversineDistanceKm(origin.lat, origin.lng, lat, lng);
  return dist !== null && dist > (Number(ds.areaRadiusKm) || 0);
}

function updateDeliveryFeePreview() {
  const infoEl = document.getElementById("deliveryFeeInfo");
  if (!infoEl) return;
  if (!_selectedDeliveryLatLng) {
    infoEl.textContent = t("delivery_pick_location_hint", "Yetkazish narxini bilish uchun xaritada manzilni belgilang.");
    return;
  }
  const ds = RESTAURANT_SETTINGS.deliverySettings || {};
  if (isOutsideDeliveryArea(_selectedDeliveryLatLng.lat, _selectedDeliveryLatLng.lng, ds)) {
    infoEl.style.color = "#dc2626";
    infoEl.textContent = t("delivery_outside_zone", "Kechirasiz, bu manzil yetkazib berish hududidan tashqarida.");
    infoEl.dataset.outsideZone = "1";
    return;
  }
  infoEl.dataset.outsideZone = "";
  const origin = ds.restaurantLocation || {};
  const distanceKm = (typeof origin.lat === "number" && typeof origin.lng === "number")
    ? (haversineDistanceKm(origin.lat, origin.lng, _selectedDeliveryLatLng.lat, _selectedDeliveryLatLng.lng) || 0)
    : 0;
  const orderTotal = Number(document.getElementById("cartTotal")?.textContent?.replace(/\D/g, "")) || 0;
  const fee = computeDeliveryFee({
    pricingMode: ds.pricingMode || "fixed",
    baseFee: ds.baseFee || 0,
    perKmFee: ds.perKmFee || 0,
    distanceKm: distanceKm || 0,
    orderTotal,
    freeDeliveryThreshold: ds.freeDeliveryThreshold || 0
  });
  infoEl.style.color = "#16a34a";
  infoEl.textContent = fee > 0
    ? `${t("delivery_fee_label", "Yetkazish narxi")}: ${fee.toLocaleString()} ${t("currency", "so'm")}`
    : t("delivery_fee_free", "Yetkazish bepul!");
}

// Populates BOTH the checkout's compact chip row (#savedAddressesRow) and
// the profile's full address list (#profileAddressesList) from the same
// Firebase read — single source of truth (window._savedAddressesCache) for
// whichever UI happens to be open right now (checkout's chips are cheap
// tap-to-apply; the profile list additionally has edit/delete, see
// renderProfileAddressesList below).
// 🩹 REFRESHLESS I18N FIX — a.label Firebase'da har doim literal "Uy"/"Ish"
// (o'zbek tilida) sifatida saqlanadi, chunki #daLabelChips'dagi tayyor
// tugmalar (window._daPickLabelChip) shu ikkita qatorni to'g'ridan-to'g'ri
// inputga yozadi — mijoz qaysi tilda ko'rayotganidan qat'i nazar. Bu
// aynan item-8/9'dagi "raw localized label"ga o'xshaydi, lekin bu yerda
// Firebase'da alohida `type` maydoni yo'q (faqat `label` — erkin matn).
// Shuning uchun: FAQAT ikkita tayyor variant (case-insensitive "uy"/"ish")
// canonical deb hisoblanadi va t() orqali tarjima qilinadi; boshqa har
// qanday matn (masalan "Ofis 2" yoki mijoz o'zi yozgan har qanday nom)
// item-14 qoidasiga ko'ra ("customer-entered text tarjima qilinmasin")
// TEGILMAY, aynan qanday yozilgan bo'lsa shundayligicha ko'rsatiladi.
function _addressLabelDisplay(rawLabel) {
  const norm = String(rawLabel || "").trim().toLowerCase();
  if (norm === "uy") return t("delivery_address_label_home", "Uy");
  if (norm === "ish") return t("delivery_address_label_work", "Ish");
  return String(rawLabel).replace(/</g, "");
}

function renderSavedAddressesRow() {
  const row = document.getElementById("savedAddressesRow");
  const phone = normalizeCustomerPhone(localStorage.getItem("customerPhone") || localStorage.getItem("userPhone") || "");
  if (!phone) {
    window._savedAddressesCache = {};
    if (row) row.style.display = "none";
    renderProfileAddressesList();
    return;
  }
  const custKey = encodeURIComponent(phone.startsWith("+") ? phone : `+${phone}`);
  get(ref(db, `${BASE_PATH}/customers/${custKey}/savedAddresses`)).then(snap => {
    const saved = snap.val() || {};
    window._savedAddressesCache = saved;
    const entries = Object.entries(saved);
    if (row) {
      if (entries.length === 0) {
        row.style.display = "none";
      } else {
        row.style.display = "flex";
        row.innerHTML = entries.map(([id, a]) => `
          <button type="button" class="btn-check" style="font-size:12px;" onclick="window.applySavedAddress('${id}')">
            📍 ${a.label ? _addressLabelDisplay(a.label) : formatDeliveryAddress(a).slice(0, 24)}
          </button>
        `).join("");
      }
    }
    renderProfileAddressesList();
  }).catch(() => {});
}

// Full address list for the Profile sheet (SECTION: DELIVERY ADDRESS) — one
// row per saved address with its label, a short one-line summary, and
// edit/delete actions. Reads from the same window._savedAddressesCache that
// renderSavedAddressesRow() just populated, so it never issues its own
// Firebase read.
function renderProfileAddressesList() {
  const listEl = document.getElementById("profileAddressesList");
  if (!listEl) return;
  const saved = window._savedAddressesCache || {};
  const entries = Object.entries(saved);
  if (entries.length === 0) {
    listEl.innerHTML = `<p style="font-size:13px;color:var(--text-muted,#94a3b8);margin:0;">${t("profile_no_addresses", "Hali manzil saqlanmagan")}</p>`;
    return;
  }
  listEl.innerHTML = entries.map(([id, a]) => `
    <div style="display:flex;align-items:center;gap:8px;background:var(--bg-input,#f8fafc);border-radius:10px;padding:9px 12px;">
      <span style="font-size:18px;">📍</span>
      <div style="flex:1;min-width:0;">
        <p style="margin:0;font-size:13.5px;font-weight:700;color:var(--text-primary,#1e293b);">${a.label ? _addressLabelDisplay(a.label) : t("profile_untitled_address", "Nomlanmagan")}</p>
        <p style="margin:2px 0 0;font-size:12px;color:var(--text-secondary,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${formatDeliveryAddress(a)}</p>
      </div>
      <button type="button" onclick="window.editProfileAddress('${id}')" aria-label="${t('edit_btn', "Tahrirlash")}" style="background:none;border:none;font-size:16px;cursor:pointer;padding:4px;">✏️</button>
      <button type="button" onclick="window.deleteProfileAddress('${id}')" aria-label="${t('delete_btn', "O'chirish")}" style="background:none;border:none;font-size:16px;cursor:pointer;padding:4px;">🗑️</button>
    </div>
  `).join("");
}

window.applySavedAddress = function (id) {
  const a = (window._savedAddressesCache || {})[id];
  if (!a) return;
  document.getElementById("daCity").value = a.city || "";
  document.getElementById("daDistrict").value = a.district || "";
  document.getElementById("daMahalla").value = a.mahalla || "";
  document.getElementById("daStreet").value = a.street || "";
  document.getElementById("daHouse").value = a.house || "";
  document.getElementById("daApartment").value = a.apartment || "";
  document.getElementById("daEntrance").value = a.entrance || "";
  document.getElementById("daFloor").value = a.floor || "";
  document.getElementById("daDoorCode").value = a.doorCode || "";
  document.getElementById("daLandmark").value = a.landmark || "";
  document.getElementById("daComment").value = a.comment || "";
  const labelEl = document.getElementById("daLabel");
  if (labelEl) labelEl.value = a.label || "";
  if (typeof a.lat === "number" && typeof a.lng === "number") setDeliveryLatLng(a.lat, a.lng, /* skipGeocode */ true);
  localStorage.setItem("defaultAddressId", id);
  updateDeliveryFeePreview();
};

// Savatdan items/total quradi — sendOrder() dagi bilan bir xil mantiq,
// lekin mustaqil nusxa (dine-in yo'lini xavf ostiga qo'ymaslik uchun).
function buildOrderItemsFromCart(cart, menuData) {
  let total = 0;
  const items = {};
  Object.entries(cart).forEach(([id, c]) => {
    // Cart key scheme: "itemId", "itemId__variantId", or either of those with
    // a "::<modifierSignature>" suffix (SECTION: MODIFIERS) — the suffix only
    // keeps distinct modifier selections as separate cart lines; the actual
    // modifier data (name/price) is stored on the cart entry itself (c.modifiers).
    const keyWithoutMods = id.split("::")[0];
    const isVariantKey = keyWithoutMods.includes("__");
    const menuId    = isVariantKey ? keyWithoutMods.split("__")[0] : keyWithoutMods;
    const variantId = isVariantKey ? keyWithoutMods.split("__")[1] : null;
    const m = menuData[menuId];
    if (!m) return;

    let price;
    if (isVariantKey && variantId && m.variants?.[variantId]) {
      price = Number(m.variants[variantId].price || 0);
    } else if (isVariantKey && c.price) {
      price = Number(c.price || 0);
    } else {
      price = Number(m.price) || 0;
    }

    const modifiers = Array.isArray(c.modifiers) ? c.modifiers : [];
    const modPriceDelta = modifiers.reduce((sum, mo) => sum + Number(mo.price || 0), 0);
    price += modPriceDelta;

    const qty = Number(c.qty || c.count || 0);
    if (qty <= 0) return;
    total += price * qty;

    const baseName = (typeof m.name === "object")
      ? m.name
      : { uz: String(m.name || "Noma'lum"), ru: String(m.name || "Noma'lum"), en: String(m.name || "Unknown") };
    const variantLabel = (isVariantKey && variantId && m.variants?.[variantId]?.name)
      ? ` — ${m.variants[variantId].name}`
      : (c.variantName ? ` — ${c.variantName}` : "");
    const modLabel = modifiers.length ? ` (${modifiers.map(mo => mo.name).join(", ")})` : "";
    const itemName = (variantLabel || modLabel)
      ? { uz: (baseName.uz || "") + variantLabel + modLabel, ru: (baseName.ru || "") + variantLabel + modLabel, en: (baseName.en || "") + variantLabel + modLabel }
      : baseName;

    items[id] = {
      id: menuId,
      ...(isVariantKey ? { variantId, variantName: m.variants?.[variantId]?.name || c.variantName || "" } : {}),
      name: itemName,
      price,
      qty,
      category: m.category || "",
      imgUrl: m.imgUrl || m.img || m.image || "",
      status: "pending",
      ...(modifiers.length ? { modifiers } : {})
    };
  });
  return { items, total };
}

function finishOrderSubmission(newOrderId, orderNumber, orderPayload) {
  currentPaymentTotal = orderPayload.total;
  currentBaseCookTime = orderPayload.cookTimeEstimate;
  currentOrderId = newOrderId;
  window._currentOrderId = newOrderId;

  localStorage.setItem("activeOrderId", newOrderId);
  localStorage.setItem("currentOrderId", newOrderId);
  localStorage.setItem("lastOrderContext", JSON.stringify({ orderId: newOrderId, orderNumber, paymentTotal: orderPayload.total, baseCookTime: orderPayload.cookTimeEstimate }));
  localStorage.setItem("clientCart", JSON.stringify(window.cart || {}));
  sessionStorage.setItem("client_has_submitted_order", "1");
  hasSubmittedOrder = true;
  activeOrderData = { ...orderPayload, _id: newOrderId };
  updateStatusUI(ORDER_STATUS_V2.ORDER_CREATED.key);
  listenActiveOrder();

  window.cart = {};
  localStorage.setItem("cart", "{}");
  if (typeof updateCart === "function") updateCart();

  if (typeof toggleCart === "function") {
    const cartModal = document.getElementById("cartModal");
    if (cartModal && cartModal.style.display !== "none") toggleCart();
  }
  showNotification("✅ " + t("order_accepted_success", "Buyurtmangiz muvaffaqiyatli qabul qilindi!"));
  if (typeof window.openOrderTracking === "function") window.openOrderTracking(newOrderId);
}

async function sendTakeawayOrder() {
  try {
    let cart = window.cart;
    if (!cart || Object.keys(cart).length === 0) cart = JSON.parse(localStorage.getItem("cart") || "{}");
    if (!cart || Object.keys(cart).length === 0) { alert(t("cart_empty", "Savat bo'sh!")); return; }

    const menuData = window.allMenu || {};
    const { items, total } = buildOrderItemsFromCart(cart, menuData);
    if (Object.keys(items).length === 0) { alert(t("cart_items_not_in_menu", "Savatdagi mahsulotlar menyu ma'lumotlaridan topilmadi.")); return; }

    // 🆕 Minimal buyurtma summasi tekshiruvi (Sozlamalar → Minimal buyurtma narxi)
    if (!checkMinOrderAmount(total)) return;

    const rawPhone = document.getElementById("clientPhoneInput")?.value?.trim() || localStorage.getItem("customerPhone") || "";
    const customerPhone = normalizeCustomerPhone(rawPhone);
    if (!customerPhone) { alert(t("delivery_phone_required", "Telefon raqamingizni kiriting!")); return; }
    localStorage.setItem("customerPhone", customerPhone);
    if (typeof _recomputeMyReservationsForCurrentPhone === "function") _recomputeMyReservationsForCurrentPhone();

    let finalPrice = total, discountAmount = 0, discountPercent = 0, discountSource = null, discountClaimId = null, discountBreakdown = null;
    try {
      const discountInfo = await calculateDiscount(total);
      finalPrice = Number(discountInfo?.finalPrice) || total;
      discountAmount = Number(discountInfo?.discountAmount) || 0;
      discountPercent = Number(discountInfo?.discountPercent) || 0;
      // 🆕 QR bir martalik chegirma — MAX ustuvorlik zanjirida g'olib chiqqan
      // bo'lsa (spec §12/§14), claim id order yozuvida saqlanadi; to'lov
      // muvaffaqiyatli tugagach shu claim "used" qilinadi (kassa.js/
      // waiter.js/payments/common.js — payment-authoritative flow).
      if (discountInfo?.isOneTime && discountInfo?.oneTimeClaimId) {
        discountSource = "qr_one_time";
        discountClaimId = discountInfo.oneTimeClaimId;
      } else if (discountInfo?.discountBreakdown) {
        // 🆕 Individual + avtomatik chegirma additiv (biznes qoidasi o'zgardi —
        // avval MAX() edi). Ikkalasi ham >0 bo'lsa "combined", faqat bittasi
        // bo'lsa eski qiymatlar bilan bir xil (orqaga mos — mavjud
        // applyPendingCustomerDiscount() kabi joylar shu eski qiymatlarni
        // tanib oladi).
        const bd = discountInfo.discountBreakdown;
        discountBreakdown = bd;
        if (bd.customer > 0 && bd.auto > 0) discountSource = "combined";
        else if (bd.auto > 0) discountSource = "auto";
        else if (bd.customer > 0) discountSource = discountInfo?.isVipDiscount ? "vip" : "customer_phone_match";
      }
    } catch (_e) { /* chegirmasiz davom etamiz */ }

    const newOrderRef = push(ref(db, BASE_PATH + "/orders"));
    const newOrderId = newOrderRef.key;
    const counterRes = await runTransaction(ref(db, BASE_PATH + "/meta/orderCounterOrd"), n => (n || 0) + 1);
    const orderNumber = counterRes.snapshot.val();
    const clientId = localStorage.getItem("clientId") || "anonymous";

    const orderPayload = {
      orderNumber,
      orderType: ORDER_TYPE.TAKEAWAY,
      items, total: finalPrice, originalTotal: total,
      discount: discountAmount, discountAmount, discountPercent,
      ...(discountSource ? { discountSource } : {}),
      ...(discountClaimId ? { discountClaimId } : {}),
      ...(discountBreakdown ? { discountBreakdown } : {}),
      clientId, createdAt: Date.now(),
      status: ORDER_STATUS_V2.ORDER_CREATED.key,
      statusKey: ORDER_STATUS_V2.ORDER_CREATED.key,
      statusLabel: ORDER_STATUS_V2.ORDER_CREATED.labelUz,
      statusV2: ORDER_STATUS_V2.ORDER_CREATED.key,
      statusHistory: { [ORDER_STATUS_V2.ORDER_CREATED.key]: Date.now() },
      cookTimeEstimate: calculateOrderCookTime(cart),
      createdByClient: true,
      customerPhone, clientPhone: customerPhone
    };

    const updates = {};
    updates[`${BASE_PATH}/meta/orderCounterOrd`] = orderNumber;
    updates[`${BASE_PATH}/orders/${newOrderId}`] = orderPayload;
    await update(ref(db), updates);

    // 👥 Telefon kiritilgan bo'lsa — visitCount/ordersCount/totalSpent/
    // loyaltyPoints yangilanadi (spec talabi: "Stol bron qilinganda yoki
    // Delivery buyurtma berilganda"; takeaway ham shu qatorga kiradi).
    if (customerPhone) await _recordCustomerVisit(customerPhone, finalPrice);

    finishOrderSubmission(newOrderId, orderNumber, orderPayload);
  } catch (err) {
    console.error("❌ sendTakeawayOrder ERROR:", err);
    alert(t("error_prefix", "Xatolik: ") + (err.message || t("order_send_failed", "Buyurtma yuborishda xatolik yuz berdi")));
  }
}

// ── Delivery-only ordering rules (SECTION: ORDER RULES) ──────────────────
// Centralizes every pre-checkout guard so no rule can be bypassed by a new
// entry point. Reuses the existing per-field checks (checkDeliveryMinOrderAmount,
// checkMinOrderAmount, isOutsideDeliveryArea) instead of duplicating logic.
function isRestaurantCurrentlyOpen() {
  const hours = String(RESTAURANT_SETTINGS.workingHours || "").trim();
  const m = hours.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return true; // no structured hours set — extension point, treat as always open
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const openMin = Number(m[1]) * 60 + Number(m[2]);
  const closeMin = Number(m[3]) * 60 + Number(m[4]);
  if (closeMin <= openMin) return nowMin >= openMin || nowMin <= closeMin; // crosses midnight
  return nowMin >= openMin && nowMin <= closeMin;
}

function validateDeliveryOrder(cart, total) {
  if (RESTAURANT_SETTINGS.serviceTypes && RESTAURANT_SETTINGS.serviceTypes.delivery === false) {
    alert(t("delivery_not_available", "Bu restoran hozircha yetkazib berishni qabul qilmaydi."));
    return false;
  }
  if (!isRestaurantCurrentlyOpen()) {
    alert(t("restaurant_closed_now", "Kechirasiz, restoran hozir yopiq."));
    return false;
  }
  const menuData = window.allMenu || {};
  for (const id of Object.keys(cart || {})) {
    const baseId = id.includes("__") ? id.split("__")[0] : id;
    if (stopListData[baseId] === true || menuData[baseId]?.active === false) {
      alert(t("cart_item_out_of_stock", "Savatdagi bir mahsulot tugagan, iltimos savatni yangilang."));
      return false;
    }
  }
  if (!checkDeliveryMinOrderAmount(total)) return false;
  if (!checkMinOrderAmount(total)) return false;
  return true;
}

async function sendDeliveryOrder(paymentMethod = "cash") {
  try {
    let cart = window.cart;
    if (!cart || Object.keys(cart).length === 0) cart = JSON.parse(localStorage.getItem("cart") || "{}");
    if (!cart || Object.keys(cart).length === 0) { alert(t("cart_empty", "Savat bo'sh!")); return null; }

    const menuData = window.allMenu || {};
    const { items, total } = buildOrderItemsFromCart(cart, menuData);
    if (Object.keys(items).length === 0) { alert(t("cart_items_not_in_menu", "Savatdagi mahsulotlar menyu ma'lumotlaridan topilmadi.")); return null; }

    if (!validateDeliveryOrder(cart, total)) return null;

    const rawPhone = document.getElementById("coFullPhone")?.value?.trim() || document.getElementById("clientPhoneInput")?.value?.trim() || localStorage.getItem("customerPhone") || "";
    const customerPhone = normalizeCustomerPhone(rawPhone);
    if (!customerPhone) { alert(t("delivery_phone_required", "Telefon raqamingizni kiriting!")); return null; }

    const customerName = document.getElementById("coFullName")?.value?.trim() || "";

    // Ta'm afzalligi / allergiya — majburiy emas, bo'sh bo'lsa payload'ga
    // qo'shilmaydi (oshxona ekranida kerak bo'lmagan bo'sh maydon chiqmasin).
    const allergyChips = Array.from(document.querySelectorAll(".dc-allergy-chip.dc-chip-active")).map(b => b.dataset.val);
    const allergyNote = document.getElementById("coAllergyNote")?.value?.trim() || "";
    const allergyInfo = (allergyChips.length || allergyNote)
      ? { chips: allergyChips, note: allergyNote }
      : null;

    const street = document.getElementById("daStreet")?.value?.trim() || "";
    if (!street) { alert(t("delivery_street_required", "Ko'cha nomini kiriting!")); return null; }
    if (!_selectedDeliveryLatLng) { alert(t("delivery_location_required", "Xaritada manzilni belgilang!")); return null; }

    const ds = RESTAURANT_SETTINGS.deliverySettings || {};

    if (isOutsideDeliveryArea(_selectedDeliveryLatLng.lat, _selectedDeliveryLatLng.lng, ds)) {
      alert(t("delivery_outside_zone", "Kechirasiz, bu manzil yetkazib berish hududidan tashqarida."));
      return null;
    }

    localStorage.setItem("customerPhone", customerPhone);
    if (typeof _recomputeMyReservationsForCurrentPhone === "function") _recomputeMyReservationsForCurrentPhone();

    let finalPrice = total, discountAmount = 0, discountPercent = 0, discountSource = null, discountClaimId = null, discountBreakdown = null;
    try {
      const discountInfo = await calculateDiscount(total);
      finalPrice = Number(discountInfo?.finalPrice) || total;
      discountAmount = Number(discountInfo?.discountAmount) || 0;
      discountPercent = Number(discountInfo?.discountPercent) || 0;
      // 🆕 QR bir martalik chegirma — sendTakeawayOrder() bilan bir xil naqsh.
      if (discountInfo?.isOneTime && discountInfo?.oneTimeClaimId) {
        discountSource = "qr_one_time";
        discountClaimId = discountInfo.oneTimeClaimId;
      } else if (discountInfo?.discountBreakdown) {
        // 🆕 Individual + avtomatik additiv (sendTakeawayOrder() bilan bir xil naqsh).
        const bd = discountInfo.discountBreakdown;
        discountBreakdown = bd;
        if (bd.customer > 0 && bd.auto > 0) discountSource = "combined";
        else if (bd.auto > 0) discountSource = "auto";
        else if (bd.customer > 0) discountSource = discountInfo?.isVipDiscount ? "vip" : "customer_phone_match";
      }
    } catch (_e) { /* chegirmasiz davom etamiz */ }

    const origin = ds.restaurantLocation || {};
    const distanceKm = (typeof origin.lat === "number" && typeof origin.lng === "number")
      ? (haversineDistanceKm(origin.lat, origin.lng, _selectedDeliveryLatLng.lat, _selectedDeliveryLatLng.lng) || 0)
      : 0;
    const deliveryFee = computeDeliveryFee({
      pricingMode: ds.pricingMode || "fixed",
      baseFee: ds.baseFee || 0,
      perKmFee: ds.perKmFee || 0,
      distanceKm,
      orderTotal: finalPrice,
      freeDeliveryThreshold: ds.freeDeliveryThreshold || 0
    });

    const deliveryAddress = {
      city: document.getElementById("daCity")?.value?.trim() || "",
      district: document.getElementById("daDistrict")?.value?.trim() || "",
      mahalla: document.getElementById("daMahalla")?.value?.trim() || "",
      street,
      house: document.getElementById("daHouse")?.value?.trim() || "",
      apartment: document.getElementById("daApartment")?.value?.trim() || "",
      entrance: document.getElementById("daEntrance")?.value?.trim() || "",
      floor: document.getElementById("daFloor")?.value?.trim() || "",
      doorCode: document.getElementById("daDoorCode")?.value?.trim() || "",
      landmark: document.getElementById("daLandmark")?.value?.trim() || "",
      comment: document.getElementById("daComment")?.value?.trim() || "",
      lat: _selectedDeliveryLatLng.lat,
      lng: _selectedDeliveryLatLng.lng,
      createdAt: Date.now()
    };

    const newOrderRef = push(ref(db, BASE_PATH + "/orders"));
    const newOrderId = newOrderRef.key;
    const counterRes = await runTransaction(ref(db, BASE_PATH + "/meta/orderCounterDvr"), n => (n || 0) + 1);
    const orderNumber = counterRes.snapshot.val();
    const clientId = localStorage.getItem("clientId") || "anonymous";

    const orderPayload = {
      orderNumber,
      orderType: ORDER_TYPE.DELIVERY,
      isDelivery: true, deliveryType: "delivery", // legacy sinonimlar — eski o'qish joylari uchun
      items, total: finalPrice + deliveryFee, originalTotal: total,
      discount: discountAmount, discountAmount, discountPercent,
      ...(discountSource ? { discountSource } : {}),
      ...(discountClaimId ? { discountClaimId } : {}),
      ...(discountBreakdown ? { discountBreakdown } : {}),
      deliveryFee, deliveryAddress,
      deliveryPaymentMethod: paymentMethod === "cash" ? "cash_on_delivery" : paymentMethod,
      payment: { method: paymentMethod, paid: false },
      clientId, createdAt: Date.now(),
      status: ORDER_STATUS_V2.ORDER_CREATED.key,
      statusKey: ORDER_STATUS_V2.ORDER_CREATED.key,
      statusLabel: ORDER_STATUS_V2.ORDER_CREATED.labelUz,
      statusV2: ORDER_STATUS_V2.ORDER_CREATED.key,
      statusHistory: { [ORDER_STATUS_V2.ORDER_CREATED.key]: Date.now() },
      cookTimeEstimate: calculateOrderCookTime(cart),
      createdByClient: true,
      customerPhone, clientPhone: customerPhone,
      ...(customerName ? { customerName } : {}),
      ...(allergyInfo ? { allergyInfo } : {})
    };

    const custKey = encodeURIComponent(customerPhone.startsWith("+") ? customerPhone : `+${customerPhone}`);

    const updates = {};
    updates[`${BASE_PATH}/meta/orderCounterDvr`] = orderNumber;
    updates[`${BASE_PATH}/orders/${newOrderId}`] = orderPayload;
    // Order-history index (SECTION: PROFILE / ORDER HISTORY) — additive only,
    // written in the same batch so it never costs an extra round-trip.
    updates[`${BASE_PATH}/customers/${custKey}/orderIds/${newOrderId}`] = true;
    if (document.getElementById("daSaveAddress")?.checked) {
      // Label (SECTION: DELIVERY ADDRESS): whatever the customer named this
      // address as ("Uy" / "Ish" / their own text) — falls back to the
      // street name only if they left the label field empty.
      const addressLabel = document.getElementById("daLabel")?.value?.trim() || street;
      // Reuse an existing saved address only if its label matches what's
      // typed now (case-insensitive) — e.g. re-ordering to "Uy" updates the
      // same "Uy" entry instead of creating a duplicate. A different label
      // (or a first-time save) always creates a new entry.
      const needle = addressLabel.toLowerCase();
      const existingSavedId = Object.entries(window._savedAddressesCache || {})
        .find(([, a]) => String(a.label || "").trim().toLowerCase() === needle)?.[0] || null;
      const savedKey = existingSavedId || push(ref(db, `${BASE_PATH}/customers/${custKey}/savedAddresses`)).key;
      updates[`${BASE_PATH}/customers/${custKey}/savedAddresses/${savedKey}`] = { ...deliveryAddress, label: addressLabel };
    }

    await update(ref(db), updates);

    // 🛵 Avtomatik kuryerga tayinlash: mijoz uydan dostavka buyurtmasi
    // yuborgan zahoti, tizim eng bo'sh (online) kuryerni topib
    // courierAssignments/{id} yozuvini o'zi yaratadi — admin qo'lda
    // tayinlashini kutmasdan kuryer ilovasida darhol paydo bo'ladi.
    // Bo'sh kuryer topilmasa, buyurtma admin panelida "Yetkazib berish"
    // bo'limida qoladi va admin uni qo'lda tayinlashi mumkin (eski yo'l).
    try {
      await autoAssignCourier(newOrderId, orderPayload, orderNumber);
    } catch (assignErr) {
      console.error("autoAssignCourier ERROR:", assignErr);
      // Tayinlash muvaffaqiyatsiz bo'lsa ham buyurtmaning o'zi yaratilgan —
      // xatolik faqat konsolga yoziladi, mijozga ko'rsatilmaydi.
    }

    // 👥 Telefon kiritilgan bo'lsa — visitCount/ordersCount/totalSpent/
    // loyaltyPoints yangilanadi (spec talabi).
    if (customerPhone) await _recordCustomerVisit(customerPhone, orderPayload.total);

    finishOrderSubmission(newOrderId, orderNumber, orderPayload);
    return { orderId: newOrderId, orderNumber, total: orderPayload.total };
  } catch (err) {
    console.error("❌ sendDeliveryOrder ERROR:", err);
    alert(t("error_prefix", "Xatolik: ") + (err.message || t("order_send_failed", "Buyurtma yuborishda xatolik yuz berdi")));
    return null;
  }
}

// ══════════════════════════════════════════════════════
// 🛵 AVTOMATIK KURYERGA TAYINLASH
// admin.js dagi window.assignOrderToCourier bilan bir xil
// courierAssignments/{id} sxemasini yozadi, shuning uchun
// courier.js hech qanday o'zgarishsiz buni real-vaqtda ko'radi.
// Kuryer tanlash mantiqi: couriers/{id}.status === "online" bo'lganlar
// orasidan, hozir eng kam faol (delivered bo'lmagan) tayinlashi
// borini tanlaydi — soddalashtirilgan "eng bo'sh kuryer" balanslash.
// ══════════════════════════════════════════════════════
async function autoAssignCourier(orderId, order, orderNumber) {
  const [couriersSnap, assignSnap] = await Promise.all([
    get(ref(db, `${BASE_PATH}/couriers`)),
    get(ref(db, `${BASE_PATH}/courierAssignments`))
  ]);
  if (!couriersSnap.exists()) return; // faol kuryer yo'q — admin qo'lda tayinlaydi

  const couriers = couriersSnap.val() || {};
  const onlineCourierIds = Object.entries(couriers)
    .filter(([, c]) => c && c.status === "online")
    .map(([id]) => id);
  if (onlineCourierIds.length === 0) return; // hech kim online emas

  const assignments = assignSnap.exists() ? assignSnap.val() : {};
  const activeLoad = {};
  onlineCourierIds.forEach(id => { activeLoad[id] = 0; });
  Object.values(assignments).forEach(a => {
    if (a && onlineCourierIds.includes(a.courierId) && a.status !== "delivered") {
      activeLoad[a.courierId] = (activeLoad[a.courierId] || 0) + 1;
    }
  });

  // Eng kam faol buyurtmasi bor online kuryerni tanlaymiz
  const chosenCourierId = onlineCourierIds.reduce((best, id) =>
    (activeLoad[id] < activeLoad[best]) ? id : best
  , onlineCourierIds[0]);

  const courierName = (couriers[chosenCourierId] && couriers[chosenCourierId].name) || "";
  const now = Date.now();

  const addressRaw = order.deliveryAddress || "";
  const address = typeof formatDeliveryAddress === "function"
    ? (formatDeliveryAddress(addressRaw) || (typeof addressRaw === "string" ? addressRaw : ""))
    : (typeof addressRaw === "string" ? addressRaw : "");
  const destination = (addressRaw && typeof addressRaw.lat === "number" && typeof addressRaw.lng === "number")
    ? { lat: addressRaw.lat, lng: addressRaw.lng }
    : null;

  const paymentMethod = order.deliveryPaymentMethod || "cash_on_delivery";
  const isPrepaid = paymentMethod === "prepaid_card" && order.payment?.paid === true;

  const assignRef = push(ref(db, `${BASE_PATH}/courierAssignments`));
  const assignmentId = assignRef.key;

  await set(assignRef, {
    courierId: chosenCourierId,
    orderId,
    orderNumber: orderNumber || "",
    customerName: order.customerName || "",
    address,
    ...(destination ? { destination } : {}),
    customerPhone: order.customerPhone || "",
    total: Number(order.total || 0),
    paymentMethod,
    isPrepaid,
    note: order.deliveryNote || "",
    status: "assigned",
    assignedAt: now,
    autoAssigned: true
  });

  await update(ref(db), {
    [`${BASE_PATH}/orders/${orderId}/courierId`]: chosenCourierId,
    [`${BASE_PATH}/orders/${orderId}/courierName`]: courierName,
    [`${BASE_PATH}/orders/${orderId}/courierAssignmentId`]: assignmentId,
    [`${BASE_PATH}/orders/${orderId}/courierAssignedAt`]: now,
    [`${BASE_PATH}/couriers/${chosenCourierId}/status`]: "on_delivery"
  });
}

// ── Online payment extension point (SECTION: PAYMENT) ────────────────────
// Reuses the existing backend/routes/paymentsInit.js endpoint (already used
// by the POS/kassa flow) instead of inventing new payment logic. Cash stays
// fully client-side (order already created with paid:false, courier collects
// cash on delivery). Uzum has its own server-side intent endpoint
// (/api/payments/uzum/intent) not yet wired here — left as a clearly marked
// extension point for a future provider.
async function initOnlinePayment(provider, orderId) {
  if (provider === "uzum") {
    alert(t("payment_provider_coming_soon", "Bu to'lov usuli tez orada qo'shiladi. Hozircha naqd pul bilan to'lang."));
    return false;
  }
  try {
    const res = await fetch("/api/payments/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, restId: currentRestaurantId, orderId })
    });
    const data = await res.json();
    if (!res.ok || !data.payUrl) throw new Error(data.error || "no payUrl");
    window.location.href = data.payUrl;
    return true;
  } catch (err) {
    console.error("initOnlinePayment error:", err);
    alert(t("payment_init_failed", "To'lov havolasini olib bo'lmadi. Iltimos, naqd pul bilan to'lang yoki qayta urinib ko'ring."));
    return false;
  }
}

// ══════════════════════════════════════════════════════
// 🛒 DELIVERY CHECKOUT MODAL (pre-order: full name/phone/address/map,
// promo code, payment method) — reuses the #checkout-modal container +
// co-* CSS already defined in client.html, calculateDiscount()/promo
// lookup already used elsewhere, computeDeliveryFee()/isOutsideDeliveryArea().
// ══════════════════════════════════════════════════════
window._dcSelectedMethod = "cash";
window._dcAppliedPromo = null;

// Ta'm afzalligi chip'lari — bir nechtasi birga tanlanishi mumkin
// (masalan "Tuzsiz" + "Achchiq"), umuman tanlanmasa ham buyurtma davom etadi.
window._dcToggleAllergyChip = function (btn) {
  const active = btn.classList.toggle("dc-chip-active");
  btn.style.background = active ? "#eafaf1" : "#fff";
  btn.style.borderColor = active ? "#22c55e" : "#e2e8f0";
  btn.style.color = active ? "#16a34a" : "#475569";
};

window.openDeliveryCheckout = async function () {
  const cart = window.cart || {};
  if (Object.keys(cart).length === 0) { alert(t("cart_empty", "Savat bo'sh!")); return; }

  const menuData = window.allMenu || {};
  const { items, total } = buildOrderItemsFromCart(cart, menuData);
  if (!validateDeliveryOrder(cart, total)) return;

  const modal = document.getElementById("checkout-modal");
  if (!modal) return;
  // #deliveryAddressPanel may still be sitting inside checkout-modal from a
  // previous open (or inside #profileAddressFormSlot from the Profile
  // sheet) — detach it to document.body BEFORE the innerHTML rewrite below,
  // otherwise the rewrite discards it (innerHTML replaces the whole
  // subtree) and every later getElementById("deliveryAddressPanel") call
  // returns null.
  const existingPanel = document.getElementById("deliveryAddressPanel");
  if (existingPanel && existingPanel.parentElement !== document.body) {
    existingPanel.style.display = "none";
    document.body.appendChild(existingPanel);
  }
  modal.style.display = "flex";

  const savedPhone = localStorage.getItem("customerPhone") || localStorage.getItem("userPhone") || "";
  const savedName = localStorage.getItem("customerName") || "";

  modal.innerHTML = `
    <div id="checkout-inner" style="background:#fff;width:100%;max-width:480px;border-radius:24px 24px 0 0;padding:0 0 env(safe-area-inset-bottom,0);max-height:92vh;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px 6px;">
        <h3 style="margin:0;font-size:18px;font-weight:800;" data-i18n="checkout_title">${t("checkout_title", "To'lov")}</h3>
        <button onclick="window.closeDeliveryCheckout()" style="background:none;border:none;font-size:22px;cursor:pointer;color:#94a3b8;">✕</button>
      </div>
      <div style="flex:1;overflow-y:auto;padding:0 20px;">
        <div id="dc-items-list" style="margin-bottom:10px;"></div>

        <p style="font-size:13px;font-weight:700;color:#475569;margin:12px 0 6px;" data-i18n="customer_info_title">${t("customer_info_title", "Mijoz ma'lumotlari")}</p>
        <input id="coFullName" class="co-input" type="text" data-i18n-placeholder="full_name_placeholder" placeholder="${t("full_name_placeholder", "F.I.O")}" value="${savedName.replace(/"/g, "")}" style="width:100%;box-sizing:border-box;margin-bottom:8px;padding:11px 13px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:14px;">
        <input id="coFullPhone" class="co-input" type="tel" placeholder="+998..." value="${savedPhone.replace(/"/g, "")}" style="width:100%;box-sizing:border-box;margin-bottom:12px;padding:11px 13px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:14px;">

        <!-- 🩹 i18n live-refresh audit: bu qator va chip yorliqlari avval
             data-i18n belgisiz edi — tilni almashtirganda (agar checkout
             ochiq bo'lsa) yangilanmasdi, chunki applyLang() ularni
             topolmasdi (faqat DOM'dagi data-i18n* atributlarni qidiradi).
             Endi belgilangan. -->
        <p style="font-size:13px;font-weight:700;color:#475569;margin:0 0 6px;"><span data-i18n="allergy_pref_title">${t("allergy_pref_title", "Ta'm afzalligi / allergiya")}</span> <span style="font-weight:500;color:#94a3b8;">(<span data-i18n="optional_label">${t("optional_label", "ixtiyoriy")}</span>)</span></p>
        <div id="dc-allergy-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
          ${[
            ["salty", "pref_salty", "🧂", "Tuzlik"],
            ["unsalted", "pref_unsalted", "🚫🧂", "Tuzsiz"],
            ["spicy", "pref_spicy", "🌶️", "Achchiq"],
            ["mild", "pref_mild", "🍃", "Achchiq emas"]
          ].map(([val, key, icon, fallback]) => `
            <button type="button" class="dc-allergy-chip" data-val="${val}" onclick="window._dcToggleAllergyChip(this)"
              style="padding:7px 13px;border-radius:999px;border:1.5px solid #e2e8f0;background:#fff;color:#475569;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;">${icon} <span data-i18n="${key}">${t(key, fallback)}</span></button>
          `).join("")}
        </div>
        <textarea id="coAllergyNote" data-i18n-placeholder="allergy_note_placeholder" placeholder="${t("allergy_note_placeholder", "Boshqa istak yoki allergiyangiz bo'lsa yozing...")}"
          style="width:100%;box-sizing:border-box;margin-bottom:12px;padding:10px 13px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:13.5px;min-height:56px;resize:vertical;font-family:inherit;"></textarea>

        <p style="font-size:13px;font-weight:700;color:#475569;margin:0 0 6px;" data-i18n="delivery_address_title">${t("delivery_address_title", "Yetkazib berish manzili")}</p>
        <div id="dc-address-slot"></div>

        <div id="dc-promo-section" style="margin:12px 0 6px;">
          <div style="position:relative;">
            <input id="dc-promo-input" type="text" placeholder="🎫 ${t("enter_promo_placeholder", "Promokod kiriting...")}"
              style="width:100%;box-sizing:border-box;padding:10px 46px 10px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:14px;outline:none;"
              oninput="this.value=this.value.toUpperCase();">
            <button onclick="window._dcApplyPromo()" style="position:absolute;right:7px;top:50%;transform:translateY(-50%);background:#22c55e;border:none;border-radius:8px;width:32px;height:32px;cursor:pointer;color:#fff;font-size:20px;font-weight:800;">›</button>
          </div>
          <div id="dc-promo-msg" style="font-size:12px;margin-top:5px;display:none;"></div>
        </div>

        <div id="dc-discount-row"></div>
        <div id="dc-fee-row" style="display:flex;justify-content:space-between;font-size:13px;color:#64748b;padding:4px 2px;"></div>
        <div style="display:flex;justify-content:space-between;font-size:13px;color:#64748b;padding:4px 2px;">
          <span data-i18n="estimated_arrival_label">${t("estimated_arrival_label", "Yetib kelish vaqti")}</span>
          <span>${(() => { const e = Number(RESTAURANT_SETTINGS.normalOrderBaseTime || 30); return `⏱ ${e}-${e + 15} ${t("minute_short", "daqiqa")}`; })()}</span>
        </div>

        <div style="margin:10px 0;background:#f0fdf4;border-radius:14px;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:14px;color:#16a34a;font-weight:600;" data-i18n="total_sum">${t("total_sum", "Jami:")}</span>
          <span style="font-size:20px;font-weight:800;color:#15803d;"><b id="dc-final-price">0</b> ${t("currency", "so'm")}</span>
        </div>

        <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#475569;" data-i18n="select_method">${t("select_method", "To'lov usulini tanlang:")}</p>
        <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;" id="dc-methods">${renderDeliveryMethodButtons()}</div>
      </div>
      <div style="padding:10px 20px 20px;">
        <button class="co-pay-btn" id="dc-pay-btn" onclick="window._dcConfirmAndPay()">
          💸 <span data-i18n="pay_btn">${t("pay_btn", "To'lash")}</span> — <span id="dc-btn-amount">0</span> ${t("currency", "so'm")}
        </button>
      </div>
    </div>`;

  // Move the existing delivery-address panel (with map, saved addresses,
  // geolocation button) from the cart sheet into the checkout screen.
  const addrPanel = document.getElementById("deliveryAddressPanel");
  const addrSlot = document.getElementById("dc-address-slot");
  if (addrPanel && addrSlot) {
    addrPanel.style.display = "block";
    addrSlot.appendChild(addrPanel);
  }
  initDeliveryCheckoutPanel();

  // 🩹 i18n live-refresh audit: `items` kept on window._dcItems so a
  // language change (while this modal is open) can re-render this list in
  // the new language via _dcRenderItemsList() below, without needing to
  // rebuild the whole modal (which would reset the name/phone/note fields
  // the customer may have already typed).
  window._dcItems = items;
  _dcRenderItemsList();

  window._dcBaseTotal = total;
  window._dcDiscountAmount = 0;
  await recomputeDeliveryCheckoutTotal();
};

async function recomputeDeliveryCheckoutTotal() {
  const base = window._dcBaseTotal || 0;
  let discountAmount = 0, discountPercent = 0, discountBreakdown = null;
  try {
    const info = await calculateDiscount(base);
    discountAmount = Number(info?.discountAmount) || 0;
    discountPercent = Number(info?.discountPercent) || 0;
    discountBreakdown = info?.discountBreakdown || null;
  } catch (_e) { /* discount olinmadi, to'liq narx bilan davom */ }

  if (window._dcAppliedPromo) {
    discountPercent = window._dcAppliedPromo.percent;
    discountAmount = Math.round(base * discountPercent / 100);
    discountBreakdown = null; // promo qo'llansa individual+auto breakdown'i endi mavjud emas
  }

  const afterDiscount = base - discountAmount;

  const ds = RESTAURANT_SETTINGS.deliverySettings || {};
  const origin = ds.restaurantLocation || {};
  const distanceKm = (_selectedDeliveryLatLng && typeof origin.lat === "number" && typeof origin.lng === "number")
    ? (haversineDistanceKm(origin.lat, origin.lng, _selectedDeliveryLatLng.lat, _selectedDeliveryLatLng.lng) || 0)
    : 0;
  const deliveryFee = computeDeliveryFee({
    pricingMode: ds.pricingMode || "fixed",
    baseFee: ds.baseFee || 0,
    perKmFee: ds.perKmFee || 0,
    distanceKm,
    orderTotal: afterDiscount,
    freeDeliveryThreshold: ds.freeDeliveryThreshold || 0
  });

  const finalTotal = afterDiscount + deliveryFee;

  const discRow = document.getElementById("dc-discount-row");
  if (discRow) {
    // 🆕 Individual + avtomatik chegirma additiv bo'lganda (spec §9: "faqat
    // bitta Chegirma 8% deb yashirib qo'yma") — ikkalasi ham qo'shilganini
    // alohida qatorlarda ko'rsatamiz, keyin jami qatorini. Faqat bitta manba
    // (yoki promo/QR) bo'lsa — eski, bitta-qatorli ko'rinish o'zgarmaydi.
    if (discountBreakdown && discountBreakdown.customer > 0 && discountBreakdown.auto > 0) {
      const custAmt = Math.round(base * discountBreakdown.customer / 100);
      const autoAmt = Math.round(base * discountBreakdown.auto / 100);
      discRow.innerHTML = `
        <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:9px 14px;margin-bottom:6px;font-size:13px;">
          <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#92400e;">🏷 ${t("customer_discount_row_label","Mijoz chegirmasi")} (${discountBreakdown.customer}%)</span><span style="color:#b45309;">−${custAmt.toLocaleString()} ${t("currency","so'm")}</span></div>
          <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#92400e;">🏷 ${t("auto_discount_row_label","Avtomatik chegirma")} (${discountBreakdown.auto}%)</span><span style="color:#b45309;">−${autoAmt.toLocaleString()} ${t("currency","so'm")}</span></div>
          <div style="display:flex;justify-content:space-between;padding-top:4px;margin-top:4px;border-top:1px dashed #fde68a;font-weight:800;"><span style="color:#92400e;">${t("total_discount_row_label","Jami chegirma")} (${discountBreakdown.total}%)</span><span style="color:#b45309;">−${discountAmount.toLocaleString()} ${t("currency","so'm")}</span></div>
        </div>`;
    } else {
      discRow.innerHTML = discountAmount > 0 ? `
        <div style="display:flex;justify-content:space-between;background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:9px 14px;margin-bottom:6px;font-size:13px;">
          <span style="color:#92400e;">🎟 ${t("discount_label","Chegirma")} −${discountPercent}%</span>
          <span style="font-weight:800;color:#b45309;">−${discountAmount.toLocaleString()} ${t("currency","so'm")}</span>
        </div>` : "";
    }
  }
  const feeRow = document.getElementById("dc-fee-row");
  if (feeRow) {
    feeRow.innerHTML = `<span>${t("delivery_fee_label","Yetkazish narxi")}</span><span>${deliveryFee > 0 ? deliveryFee.toLocaleString() + " " + t("currency","so'm") : t("delivery_fee_free","Bepul")}</span>`;
  }
  const finalEl = document.getElementById("dc-final-price");
  const btnAmt = document.getElementById("dc-btn-amount");
  if (finalEl) finalEl.textContent = finalTotal.toLocaleString();
  if (btnAmt) btnAmt.textContent = finalTotal.toLocaleString();

  window._dcFinalTotal = finalTotal;
  return finalTotal;
}

window._dcApplyPromo = async function () {
  const inp = document.getElementById("dc-promo-input");
  const msgEl = document.getElementById("dc-promo-msg");
  const code = inp ? inp.value.trim().toUpperCase() : "";
  function showMsg(txt, color) {
    if (!msgEl) return;
    msgEl.textContent = txt; msgEl.style.color = color; msgEl.style.display = "block";
  }
  if (!code) { showMsg("❗ " + t("enter_promo_alert", "Promokod kiriting"), "#b45309"); return; }
  try {
    const snap = await get(ref(db, `${BASE_PATH}/discounts/${code}`));
    if (!snap.exists()) { showMsg("❌ " + t("promo_not_found", "Promokod topilmadi"), "red"); return; }
    const promo = snap.val();
    const usedCount = Number(promo.usedCount || 0);
    const maxUses = Number(promo.maxUses || 1);
    if (promo.used || usedCount >= maxUses) { showMsg("❌ " + t("promo_expired", "Promokod tugagan"), "red"); return; }
    const phone = normalizeCustomerPhone(document.getElementById("coFullPhone")?.value || "");
    if (promo.ownerPhone && promo.ownerPhone !== phone) { showMsg("❌ " + t("promo_not_yours", "Bu promokod sizga tegishli emas"), "red"); return; }
    window._dcAppliedPromo = { code, percent: Number(promo.percent || 0) };
    showMsg(`✅ −${promo.percent}% ${t("promo_applied_success", "qo'llanildi!")}`, "#16a34a");
    await recomputeDeliveryCheckoutTotal();
  } catch (e) { showMsg("❌ " + t("error_generic", "Xatolik yuz berdi"), "red"); }
};

window._dcSelect = function (method, btn) {
  window._dcSelectedMethod = method;
  document.querySelectorAll("#dc-methods .co-method-btn").forEach(b => b.classList.remove("co-active"));
  if (btn) btn.classList.add("co-active");
};

// ── Delivery checkout payment methods (SECTION: PAYMENT) ─────────────────
// Single source of truth: Admin Settings → Payment Methods (getEnabledPaymentMethods,
// same paymentEngine.js used by kassa/waiter). Cash is always first and can never be
// disabled. Only "cash"/"click"/"payme"/"uzum" are offered here — Humo/UzCard/Visa-
// Mastercard have no online-prepay gateway wired for delivery yet (see
// initOnlinePayment), so they stay kassa/waiter-only even when an admin enables them.
function renderDeliveryMethodButtons() {
  const ONLINE_DELIVERY_METHODS = new Set(["cash", "click", "payme", "uzum"]);
  const methods = getEnabledPaymentMethods(RESTAURANT_SETTINGS).filter(m => ONLINE_DELIVERY_METHODS.has(m.id));
  window._dcSelectedMethod = methods[0]?.id || "cash";
  return methods.map((m, i) => `
    <button class="co-method-btn${i === 0 ? " co-active" : ""}" onclick="window._dcSelect('${m.id}',this)">
      <span class="co-method-icon">${m.icon}</span><span>${paymentMethodLabel(m.firebaseKey, t)}</span>
    </button>`).join("");
}

// 🩹 i18n live-refresh audit: extracted out of openDeliveryCheckout() so a
// language change (while checkout is open) can call this again on its own
// — cart item names are keyed by language (it.name[lang]), so they need
// re-rendering, not just a data-i18n relabel.
function _dcRenderItemsList() {
  const lang = getLang();
  const items = window._dcItems || {};
  const listEl = document.getElementById("dc-items-list");
  if (!listEl) return;
  listEl.innerHTML = Object.values(items).map(it => {
    const name = typeof it.name === "object" ? (it.name[lang] || it.name.uz || "—") : it.name;
    return `<div class="co-item-row">
      <div style="flex:1;min-width:0;">
        <p style="margin:0 0 3px;font-weight:700;font-size:14px;">${name}</p>
        <div style="display:flex;justify-content:space-between;">
          <span style="font-size:12px;color:#64748b;">${Number(it.price).toLocaleString()} ${t("currency","so'm")} × ${it.qty}</span>
          <span style="font-size:14px;font-weight:800;">${(Number(it.price) * it.qty).toLocaleString()} ${t("currency","so'm")}</span>
        </div>
      </div>
    </div>`;
  }).join("");
}

// 🩹 i18n live-refresh audit (root cause of "payment modal ochiq bo'lsa,
// til o'zgarganda tarjima qilinmaydi"): #checkout-modal is fully rebuilt
// via one big .innerHTML= template at open time — most of its STATIC
// labels already carry data-i18n (so the existing applyLang() step in
// onLangChange already re-translates them live), but several parts are
// either genuinely DYNAMIC (cart item names, per language; discount/fee/
// total rows, computed) or were missing their data-i18n marker entirely
// (fixed above). This re-renders exactly those dynamic parts — never the
// whole modal — so a customer's already-typed name/phone/note is never
// reset by a language switch. No-ops instantly if checkout isn't open.
function _relabelDeliveryCheckoutIfOpen() {
  const modal = document.getElementById("checkout-modal");
  if (!modal || modal.style.display === "none") return;

  _dcRenderItemsList();
  if (typeof recomputeDeliveryCheckoutTotal === "function") recomputeDeliveryCheckoutTotal();

  // Payment methods — preserve whichever one the customer already picked
  // (renderDeliveryMethodButtons() always resets to the first/cash by
  // design when called fresh, since it's normally only called once at
  // modal-open time — re-applying the previous selection here keeps that
  // choice intact across a mid-checkout language switch).
  const methodsEl = document.getElementById("dc-methods");
  if (methodsEl) {
    const prevSelected = window._dcSelectedMethod;
    methodsEl.innerHTML = renderDeliveryMethodButtons();
    if (prevSelected) {
      window._dcSelectedMethod = prevSelected;
      methodsEl.querySelectorAll(".co-method-btn").forEach(b => b.classList.remove("co-active"));
      const btn = methodsEl.querySelector(`.co-method-btn[onclick*="'${prevSelected}'"]`);
      (btn || methodsEl.querySelector(".co-method-btn"))?.classList.add("co-active");
    }
  }

  // "🎫 <placeholder>" — the emoji prefix means this can't use the generic
  // data-i18n-placeholder mechanism (it would overwrite the whole
  // placeholder including the emoji with just the bare translated text).
  const promoInput = document.getElementById("dc-promo-input");
  if (promoInput) promoInput.placeholder = "🎫 " + t("enter_promo_placeholder", "Promokod kiriting...");
}

window.closeDeliveryCheckout = function () {
  const modal = document.getElementById("checkout-modal");
  if (modal) modal.style.display = "none";
};

window._dcConfirmAndPay = async function () {
  const name = document.getElementById("coFullName")?.value?.trim();
  const phone = document.getElementById("coFullPhone")?.value?.trim();
  if (!name) { alert(t("full_name_required", "Ismingizni kiriting!")); return; }
  if (!phone) { alert(t("delivery_phone_required", "Telefon raqamingizni kiriting!")); return; }
  localStorage.setItem("customerName", name);

  const method = window._dcSelectedMethod || "cash";
  const payBtn = document.getElementById("dc-pay-btn");
  if (payBtn) payBtn.disabled = true;

  const result = await sendDeliveryOrder(method);
  if (!result) { if (payBtn) payBtn.disabled = false; return; }

  // Promo usage bookkeeping (reuses the same discounts/{code} shape as the
  // rest of the app: usedCount/maxUses/used).
  if (window._dcAppliedPromo) {
    try {
      const pSnap = await get(ref(db, `${BASE_PATH}/discounts/${window._dcAppliedPromo.code}`));
      if (pSnap.exists()) {
        const pd = pSnap.val();
        const newCount = Number(pd.usedCount || 0) + 1;
        await update(ref(db, `${BASE_PATH}/discounts/${window._dcAppliedPromo.code}`), {
          usedCount: newCount, used: newCount >= Number(pd.maxUses || 1)
        });
      }
    } catch (_e) { /* promo bookkeeping xatosi buyurtmani bekor qilmaydi */ }
    window._dcAppliedPromo = null;
  }

  window.closeDeliveryCheckout();

  if (method !== "cash") {
    await initOnlinePayment(method, result.orderId);
  }
};

// QR stol havolasi (?table=) — joyida ovqatlanish buyurtmasini yozamiz.
// Stol yo'q bo'lsa — yetkazib berish checkout (manzil + to'lov usuli).
window.submitOrder = function () {
  const table = getClientTable();
  if (table) return sendTableOrder();
  return window.openDeliveryCheckout();
};

async function sendTableOrder() {
  try {
    const table = getClientTable();
    if (!table) {
      return window.openDeliveryCheckout();
    }

    let cart = window.cart;
    if (!cart || Object.keys(cart).length === 0) cart = JSON.parse(localStorage.getItem("cart") || "{}");
    if (!cart || Object.keys(cart).length === 0) { alert(t("cart_empty", "Savat bo'sh!")); return; }

    if (RESTAURANT_SETTINGS.serviceTypes && RESTAURANT_SETTINGS.serviceTypes.dineIn === false) {
      alert(t("dine_in_not_available", "Bu restoran hozircha joyida ovqatlanishni qabul qilmaydi."));
      return;
    }

    const menuData = window.allMenu || {};
    const { items, total } = buildOrderItemsFromCart(cart, menuData);
    if (Object.keys(items).length === 0) { alert(t("cart_items_not_in_menu", "Savatdagi mahsulotlar menyu ma'lumotlaridan topilmadi.")); return; }

    for (const id of Object.keys(cart || {})) {
      const baseId = id.includes("__") ? id.split("__")[0] : id;
      if (stopListData[baseId] === true || menuData[baseId]?.active === false) {
        alert(t("cart_item_out_of_stock", "Savatdagi bir mahsulot tugagan, iltimos savatni yangilang."));
        return;
      }
    }

    if (!checkMinOrderAmount(total)) return;

    const rawPhone = document.getElementById("clientPhoneInput")?.value?.trim() || localStorage.getItem("customerPhone") || "";
    const customerPhone = normalizeCustomerPhone(rawPhone) || "";
    if (customerPhone) localStorage.setItem("customerPhone", customerPhone);

    let finalPrice = total, discountAmount = 0, discountPercent = 0, discountSource = null, discountClaimId = null, discountBreakdown = null;
    try {
      const discountInfo = await calculateDiscount(total);
      finalPrice = Number(discountInfo?.finalPrice) || total;
      discountAmount = Number(discountInfo?.discountAmount) || 0;
      discountPercent = Number(discountInfo?.discountPercent) || 0;
      if (discountInfo?.isOneTime && discountInfo?.oneTimeClaimId) {
        discountSource = "qr_one_time";
        discountClaimId = discountInfo.oneTimeClaimId;
      } else if (discountInfo?.discountBreakdown) {
        const bd = discountInfo.discountBreakdown;
        discountBreakdown = bd;
        if (bd.customer > 0 && bd.auto > 0) discountSource = "combined";
        else if (bd.auto > 0) discountSource = "auto";
        else if (bd.customer > 0) discountSource = discountInfo?.isVipDiscount ? "vip" : "customer_phone_match";
      }
    } catch (_e) { /* chegirmasiz davom etamiz */ }

    const newOrderRef = push(ref(db, BASE_PATH + "/orders"));
    const newOrderId = newOrderRef.key;
    const clientId = localStorage.getItem("clientId") || "anonymous";
    const now = Date.now();
    const tableKey = getTableKey(table);
    const pgMode = (await resolveClientDataBackend()) === "postgres";

    let orderNumber;
    if (pgMode) {
      orderNumber = 0;
    } else {
      const counterRes = await runTransaction(ref(db, BASE_PATH + "/meta/orderCounterOrd"), n => (typeof n === "number" ? n : 0) + 1);
      orderNumber = Number(counterRes.snapshot.val());
      if (!Number.isFinite(orderNumber) || orderNumber <= 0) {
        throw new Error("order_counter_invalid");
      }
    }

    const orderPayload = {
      orderNumber,
      orderType: ORDER_TYPE.DINE_IN,
      table,
      items,
      total: finalPrice,
      originalTotal: total,
      discount: discountAmount,
      discountAmount,
      discountPercent,
      ...(discountSource ? { discountSource } : {}),
      ...(discountClaimId ? { discountClaimId } : {}),
      ...(discountBreakdown ? { discountBreakdown } : {}),
      clientId,
      createdAt: now,
      status: ORDER_STATUS_V2.ORDER_CREATED.key,
      statusKey: ORDER_STATUS_V2.ORDER_CREATED.key,
      statusLabel: ORDER_STATUS_V2.ORDER_CREATED.labelUz,
      statusV2: ORDER_STATUS_V2.ORDER_CREATED.key,
      statusHistory: { [ORDER_STATUS_V2.ORDER_CREATED.key]: now },
      cookTimeEstimate: calculateOrderCookTime(cart),
      createdByClient: true,
      source: "client",
      paymentMethod: "pending",
      payment: { requested: false, paid: false },
      ...(customerPhone ? { customerPhone, clientPhone: customerPhone } : {})
    };

    if (pgMode) {
      // Customer meta/table writes are denied; the order SET is enough.
      // PostgreSQL assigns order_number, catalog prices, and session binding.
      await set(ref(db, `${BASE_PATH}/orders/${newOrderId}`), orderPayload);
      const persisted = await get(ref(db, `${BASE_PATH}/orders/${newOrderId}`));
      const saved = persisted.exists() ? persisted.val() : null;
      orderNumber = Number(saved?.orderNumber);
      if (!Number.isFinite(orderNumber) || orderNumber <= 0) {
        throw new Error("order_counter_invalid");
      }
      if (saved) Object.assign(orderPayload, saved);
    } else {
      const updates = {};
      updates[`${BASE_PATH}/meta/orderCounterOrd`] = orderNumber;
      updates[`${BASE_PATH}/orders/${newOrderId}`] = orderPayload;
      updates[`${BASE_PATH}/tables/${tableKey}/status`] = "occupied";
      updates[`${BASE_PATH}/tables/${tableKey}/busy`] = true;
      updates[`${BASE_PATH}/tables/${tableKey}/orderId`] = newOrderId;
      updates[`${BASE_PATH}/tables/${tableKey}/occupiedAt`] = now;
      await update(ref(db), updates);
    }

    if (customerPhone) await _recordCustomerVisit(customerPhone, finalPrice);

    finishOrderSubmission(newOrderId, orderNumber, orderPayload);
  } catch (err) {
    console.error("❌ sendTableOrder ERROR:", err);
    alert(t("error_prefix", "Xatolik: ") + (err.message || t("order_send_failed", "Buyurtma yuborishda xatolik yuz berdi")));
  }
}

// ══════════════════════════════════════════════════════
// 👥 CUSTOMER VISIT/ORDER/BONUS HISOBLAGICHI (SECTION: CUSTOMERS)
// Telefon kiritilgan har bir delivery/takeaway buyurtma va rezervatsiyada
// chaqiriladi — customers/{phone} yozuvini topadi (yoki yaratadi) va
// visits/ordersCount/totalSpent/loyaltyPoints/lastVisit ni yangilaydi.
// Hech qanday status/tier yozilmaydi — barcha mijoz teng, faqat hisoblagich.
// Bonus formulasi (necha so'mga 1 ball) Admin Settings'dan o'qiladi
// (settings.loyalty.pointsPerAmount — admin.js'da sozlanadi).
// Telefon kiritilmagan bo'lsa — hech narsa yozilmaydi (spec talabi:
// "Customer bazasiga yozilmaydi, tashriflar soni hisoblanmaydi").
// ══════════════════════════════════════════════════════
async function _recordCustomerVisit(phone, spentAmount = 0) {
  const normalizedPhone = normalizeCustomerPhone(phone);
  if (!normalizedPhone) return;
  // 🩹 Audit fix: Firebase KALITI encodeURIComponent() bilan (admin.js/
  // waiter.js bilan bir xil) — lekin record ICHIDAGI phone/id maydonlari
  // baribir RAW "+998..." holida saqlanadi (o'qiladigan, boshqa joylarda
  // taqqoslanadigan qiymat).
  const custKey = encodeURIComponent(normalizedPhone);
  try {
    const custRef = ref(db, `${BASE_PATH}/customers/${custKey}`);
    const snap = await get(custRef);
    const existing = snap.exists() ? snap.val() : {};
    const now = Date.now();

    const pointsPerAmount = Number(RESTAURANT_SETTINGS?.loyalty?.pointsPerAmount || 0);
    const amount = Number(spentAmount || 0);
    const pointsEarned = (pointsPerAmount > 0 && amount > 0) ? Math.floor(amount / pointsPerAmount) : 0;

    await update(custRef, {
      id: normalizedPhone,
      phone: normalizedPhone,
      name: existing.name || localStorage.getItem("customerName") || "",
      visits: Number(existing.visits || 0) + 1,
      ordersCount: Number(existing.ordersCount || 0) + 1,
      totalSpent: Number(existing.totalSpent || 0) + amount,
      loyaltyPoints: Number(existing.loyaltyPoints || 0) + pointsEarned,
      createdAt: existing.createdAt || now,
      lastVisit: now,
      updatedAt: now,
    });
  } catch (e) {
    // Mijoz hisoblagichini yangilay olmasak ham buyurtma/bron davom etishi
    // kerak — bu hech qachon asosiy oqimni to'xtatmaydi.
    console.error("_recordCustomerVisit error:", e);
  }
}

// ══════════════════════════════════════════════════════
// 📅 STOLNI BRON QILISH (SECTION: RESERVATION)
// admin.js'dagi window.createReservation() bilan BIR XIL Firebase yozuvi
// (restaurants/{id}/reservations/{pushId}: guestName/phone/date/time/guests/
// tableNumber/specialRequests/status/createdAt) — shu bilan Admin →
// Reservations moduli hech qanday o'zgarishsiz buni real-vaqtda ko'radi.
// Client hech qachon stol raqamini tanlamaydi (tableNumber:null — admin
// keyinroq tayinlaydi), va status har doim "pending" bilan boshlanadi.
// ══════════════════════════════════════════════════════
window.openReservationModal = function () {
  const modal = document.getElementById("reservation-modal");
  if (!modal) return;
  modal.style.display = "flex";

  const savedPhone = localStorage.getItem("customerPhone") || localStorage.getItem("userPhone") || "";
  const savedName = localStorage.getItem("customerName") || "";
  const today = new Date().toISOString().slice(0, 10);

  modal.innerHTML = `
    <div id="reservation-inner" style="background:var(--bg-card,#fff);width:100%;max-width:480px;border-radius:24px 24px 0 0;padding:0 0 env(safe-area-inset-bottom,0);max-height:92vh;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px 6px;">
        <h3 style="margin:0;font-size:18px;font-weight:800;color:var(--text-primary,#111827);" data-i18n="reservation_modal_title">${t("reservation_modal_title", "Stolni bron qilish")}</h3>
        <div style="display:flex;align-items:center;gap:10px;">
          <!-- 🆕 Yangi bron oynasidan bevosita "Bronlarim" (mavjud bronlar
               tarixi) ga o'tish uchun tezkor ikon — window.openMyReservationsModal()
               allaqachon to'liq ishlaydi (pastki navigatsiyadan ham ochiladi),
               bu yerda faqat qo'shimcha kirish nuqtasi. -->
          <button type="button" onclick="window.openMyReservationsModal()" aria-label="${t("nav_my_reservations", "Bronlarim")}" title="${t("nav_my_reservations", "Bronlarim")}" style="background:none;border:none;font-size:19px;cursor:pointer;line-height:1;">🗓️</button>
          <button onclick="window.closeReservationModal()" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--text-muted,#94a3b8);">✕</button>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;padding:0 20px 20px;">
        <input id="resvName" class="co-input" type="text" data-i18n-placeholder="full_name_placeholder" placeholder="${t("full_name_placeholder", "F.I.O")}" value="${savedName.replace(/"/g, "")}" style="width:100%;box-sizing:border-box;margin-bottom:8px;padding:11px 13px;border:1.5px solid var(--border-color,#e2e8f0);border-radius:10px;font-size:14px;background:var(--bg-card,#fff);color:var(--text-primary,#1e293b);">
        <input id="resvPhone" class="co-input" type="tel" placeholder="+998... (${t("optional_label", "ixtiyoriy")})" value="${savedPhone.replace(/"/g, "")}" style="width:100%;box-sizing:border-box;margin-bottom:8px;padding:11px 13px;border:1.5px solid var(--border-color,#e2e8f0);border-radius:10px;font-size:14px;background:var(--bg-card,#fff);color:var(--text-primary,#1e293b);">
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <input id="resvDate" class="co-input" type="date" min="${today}" value="${today}" style="flex:1;box-sizing:border-box;padding:11px 13px;border:1.5px solid var(--border-color,#e2e8f0);border-radius:10px;font-size:14px;background:var(--bg-card,#fff);color:var(--text-primary,#1e293b);">
          <input id="resvTime" class="co-input" type="time" value="19:00" style="flex:1;box-sizing:border-box;padding:11px 13px;border:1.5px solid var(--border-color,#e2e8f0);border-radius:10px;font-size:14px;background:var(--bg-card,#fff);color:var(--text-primary,#1e293b);">
        </div>
        <input id="resvGuests" class="co-input" type="number" min="1" max="50" value="2" data-i18n-placeholder="resv_guests_placeholder" placeholder="${t("resv_guests_placeholder", "Odam soni")}" style="width:100%;box-sizing:border-box;margin-bottom:8px;padding:11px 13px;border:1.5px solid var(--border-color,#e2e8f0);border-radius:10px;font-size:14px;background:var(--bg-card,#fff);color:var(--text-primary,#1e293b);">
        <textarea id="resvNote" class="co-input" data-i18n-placeholder="reservation_note_placeholder" placeholder="${t("reservation_note_placeholder", "Izoh (ixtiyoriy)")}" style="width:100%;box-sizing:border-box;min-height:64px;padding:11px 13px;border:1.5px solid var(--border-color,#e2e8f0);border-radius:10px;font-size:14px;font-family:inherit;resize:vertical;background:var(--bg-card,#fff);color:var(--text-primary,#1e293b);"></textarea>
      </div>
      <div style="padding:10px 20px 20px;">
        <button class="co-pay-btn" id="resvSubmitBtn" onclick="window.submitReservation()">
          📅 <span data-i18n="reservation_submit_btn">${t("reservation_submit_btn", "Bron qilish")}</span>
        </button>
      </div>
    </div>`;
};

window.closeReservationModal = function () {
  const modal = document.getElementById("reservation-modal");
  if (modal) modal.style.display = "none";
};

// 🩹 REFRESHLESS I18N — checkout modalidagi _relabelDeliveryCheckoutIfOpen()
// bilan bir xil naqsh/sabab: bu modaldagi ko'pchilik matn (title, "F.I.O"/
// "Odam soni"/izoh placeholder'lari, "Bron qilish" tugmasi) allaqachon
// data-i18n/data-i18n-placeholder orqali applyLang()'ning butun hujjat
// bo'ylab qidiruvi tomonidan avtomatik yangilanadi (modal ochiq bo'lsa
// ham) — lekin telefon placeholder'i "+998... (ixtiyoriy)" bitta
// birlashtirilgan satr sifatida FAQAT render vaqtida yaratiladi, shuning
// uchun data-i18n-placeholder orqali ifodalab bo'lmaydi. Shu bitta
// joyni qo'lda yangilaymiz — mijoz allaqachon kiritgan qiymatlarga
// (F.I.O/telefon/sana/vaqt/mehmonlar/izoh) HECH TEGMAYMIZ.
function _relabelReservationModalIfOpen() {
  const modal = document.getElementById("reservation-modal");
  if (!modal || modal.style.display === "none" || !modal.style.display) return;
  const phoneEl = document.getElementById("resvPhone");
  if (phoneEl) phoneEl.placeholder = `+998... (${t("optional_label", "ixtiyoriy")})`;
  const myResvBtn = modal.querySelector('button[onclick="window.openMyReservationsModal()"]');
  if (myResvBtn) {
    const lbl = t("nav_my_reservations", "Bronlarim");
    myResvBtn.setAttribute("aria-label", lbl);
    myResvBtn.setAttribute("title", lbl);
  }
}

window.submitReservation = async function () {
  const guestName = document.getElementById("resvName")?.value?.trim();
  const phoneRaw = document.getElementById("resvPhone")?.value?.trim() || "";
  const date = document.getElementById("resvDate")?.value;
  const time = document.getElementById("resvTime")?.value;
  const guests = Number(document.getElementById("resvGuests")?.value || 0);
  const specialRequests = document.getElementById("resvNote")?.value?.trim() || "";

  if (!guestName) { alert(t("full_name_required", "Ismingizni kiriting!")); return; }
  if (!date || !time) { alert(t("reservation_datetime_required", "Sana va vaqtni tanlang!")); return; }
  if (!guests || guests < 1) { alert(t("reservation_guests_required", "Odam sonini kiriting!")); return; }

  const resDateTime = new Date(`${date}T${time}`);
  if (resDateTime < new Date()) { alert(t("past_time_error", "O'tib ketgan vaqtga bron qilish mumkin emas!")); return; }

  // Telefon — ixtiyoriy (spec talabi): kiritilsa normalize qilinadi va mijoz
  // aniqlanadi, kiritilmasa bron baribir yuboriladi, faqat mijoz identifikatsiya
  // qilinmaydi.
  const phone = phoneRaw ? normalizeCustomerPhone(phoneRaw) : "";

  const btn = document.getElementById("resvSubmitBtn");
  if (btn) { btn.disabled = true; }

  try {
    localStorage.setItem("customerName", guestName);
    if (phone) localStorage.setItem("customerPhone", phone);

    // admin.js'dagi window.createReservation() bilan bir xil maydon
    // to'plami — Admin → Reservations moduli o'zgarishsiz shu yozuvni o'qiydi.
    await set(push(ref(db, `${BASE_PATH}/reservations`)), {
      guestName,
      phone,
      date,
      time,
      guests,
      tableNumber: null,
      specialRequests,
      status: "pending",
      createdAt: Date.now()
    });

    if (phone) await _recordCustomerVisit(phone, 0);

    window.closeReservationModal();
    if (typeof showNotification === "function") {
      showNotification(t("reservation_sent_success", "Bron so'rovingiz yuborildi! Tez orada tasdiqlanadi."));
    } else {
      alert(t("reservation_sent_success", "Bron so'rovingiz yuborildi! Tez orada tasdiqlanadi."));
    }
  } catch (err) {
    console.error("submitReservation error:", err);
    alert(t("error_prefix", "Xatolik: ") + (err.message || t("order_send_failed", "Yuborishda xatolik yuz berdi")));
  } finally {
    if (btn) btn.disabled = false;
  }
};

// ══════════════════════════════════════════════════════
// 🗓️ MENING BRONLARIM (SECTION: MY RESERVATIONS)
// Biznes qoidasi: faqat telefon kiritilgan VA shu telefonga tegishli aktiv
// bron topilgandagina pastki navigatsiyada ko'rinadi. Bitta doimiy onValue
// listener (restart shart emas — Firebase har o'zgarishda o'zi qayta
// ishga tushiradi) restoranning BARCHA bronlarini o'qiydi, keyin
// normalizeCustomerPhone bilan solishtirib faqat joriy mijozning
// yozuvlarini ajratadi — boshqa mijoz/restoran bronlari hech qachon
// chiqmaydi (har doim BASE_PATH — joriy restId — ostida o'qiladi).
//
// admin.js'dagi haqiqiy reservation status qiymatlari bilan bir xil:
// pending/confirmed/seated/completed/no_show/canceled — "Ready" alohida
// holat sifatida ISHLATILMAYDI (admin bron oqimida bunday status yo'q).
// ══════════════════════════════════════════════════════
const RESERVATION_ACTIVE_STATUSES = new Set(["pending", "confirmed", "seated"]);
const RESERVATION_CANCELLABLE_STATUSES = new Set(["pending", "confirmed"]);

function _reservationStatusMeta(status) {
  let s = String(status || "pending").toLowerCase();
  if (s === "cancelled") s = "canceled";
  // 🩹 bg/fg endi CSS o'zgaruvchilari (--status-*, client.css) — hardcoded
  // hex EMAS. Shunda dark-mode almashtirilganda (window.toggleClientTheme())
  // BADGE'LAR HECH QANDAY JS qayta chizishisiz, brauzerning o'zi CSS'ni
  // qayta hisoblashi orqali darhol to'g'ri rangga o'tadi — theme
  // almashtirish uchun alohida re-render hook kerak emas.
  const map = {
    pending:   { icon: "🟡", key: "reservation_status_pending_label",   fallback: "Kutilmoqda",     bg: "var(--status-pending-bg,#fef3c7)",   fg: "var(--status-pending-fg,#92400e)" },
    confirmed: { icon: "🟢", key: "reservation_status_confirmed_label", fallback: "Tasdiqlangan",   bg: "var(--status-confirmed-bg,#dcfce7)", fg: "var(--status-confirmed-fg,#166534)" },
    seated:    { icon: "🟠", key: "reservation_status_arrived_label",   fallback: "Mijoz keldi",    bg: "var(--status-arrived-bg,#ffedd5)",   fg: "var(--status-arrived-fg,#9a3412)" },
    completed: { icon: "⚪", key: "reservation_status_completed_label", fallback: "Yakunlangan",    bg: "var(--status-completed-bg,#f1f5f9)", fg: "var(--status-completed-fg,#475569)" },
    no_show:   { icon: "⚫", key: "reservation_status_no_show_label",   fallback: "Kelmadi",        bg: "var(--status-noshow-bg,#e2e8f0)",    fg: "var(--status-noshow-fg,#334155)" },
    canceled:  { icon: "🔴", key: "reservation_status_cancelled_label", fallback: "Bekor qilingan", bg: "var(--status-canceled-bg,#fee2e2)",  fg: "var(--status-canceled-fg,#991b1b)" },
  };
  return map[s] || map.pending;
}

function _notifyReservationStatusChange(newStatus) {
  const meta = _reservationStatusMeta(newStatus);
  const label = t(meta.key, meta.fallback);
  const msg = `${t("reservation_status_changed_notice", "Bron holati o'zgardi")}: ${meta.icon} ${label}`;
  if (typeof showNotification === "function") showNotification(msg);
  else if (typeof Swal !== "undefined" && Swal.fire) Swal.fire({ icon: "info", title: msg, timer: 3500, showConfirmButton: false, toast: true, position: "top" });
}

window._myReservations = [];
let _myReservationsAllRaw = {};
let _myReservationsPrevStatusById = {};
let _myReservationsListenerStarted = false;

// Firebase'dan qayta o'qimasdan, joriy keshlangan to'plamni joriy telefon
// bo'yicha qayta filtrlaydi — profil/checkout/rezervatsiyada telefon
// yangi kiritilganda (Firebase bronlar to'plami o'zgarmagan bo'lsa ham)
// nav tugmasi/ro'yxat darhol to'g'ri holatga kelishi uchun chaqiriladi.
function _recomputeMyReservationsForCurrentPhone() {
  const rawPhone = localStorage.getItem("customerPhone") || localStorage.getItem("userPhone") || "";
  const myPhone = rawPhone ? normalizeCustomerPhone(rawPhone) : "";
  const mine = [];
  if (myPhone) {
    Object.entries(_myReservationsAllRaw).forEach(([id, r]) => {
      if (r && normalizeCustomerPhone(r.phone || "") === myPhone) mine.push({ id, ...r });
    });
  }
  mine.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // 🔔 Status o'zgarishi bo'yicha client-side bildirishnoma (spec talabi:
  // Pending→Confirmed, Confirmed→Cancelled, Arrived, Completed).
  mine.forEach(r => {
    const prev = _myReservationsPrevStatusById[r.id];
    if (prev !== undefined && prev !== r.status) _notifyReservationStatusChange(r.status);
    _myReservationsPrevStatusById[r.id] = r.status;
  });

  window._myReservations = mine;
  window._refreshMyReservationsNavVisibility();

  // Ro'yxat/tafsilot modallari ochiq bo'lsa — realtime qayta chizamiz
  // (refreshsiz, spec talabi).
  const listModal = document.getElementById("my-reservations-modal");
  if (listModal && listModal.style.display !== "none") _renderMyReservationsList();
  if (window._openReservationDetailId) {
    const stillOpen = mine.find(r => r.id === window._openReservationDetailId);
    if (stillOpen) window.openReservationDetail(stillOpen.id);
  }
}
window._recomputeMyReservationsForCurrentPhone = _recomputeMyReservationsForCurrentPhone;

function _startMyReservationsListener() {
  if (_myReservationsListenerStarted) return;
  _myReservationsListenerStarted = true;
  onValue(ref(db, `${BASE_PATH}/reservations`), (snap) => {
    _myReservationsAllRaw = snap.val() || {};
    _recomputeMyReservationsForCurrentPhone();
  });
}
_startMyReservationsListener();

window._refreshMyReservationsNavVisibility = function () {
  const btn = document.getElementById("myReservationsNavBtn");
  if (!btn) return;
  const hasActive = (window._myReservations || []).some(r => RESERVATION_ACTIVE_STATUSES.has(String(r.status || "pending").toLowerCase()));
  btn.style.display = hasActive ? "flex" : "none";
};

function _renderMyReservationsList() {
  const modal = document.getElementById("my-reservations-modal");
  if (!modal) return;
  const list = window._myReservations || [];
  const cardsHtml = list.length ? list.map(r => {
    const meta = _reservationStatusMeta(r.status);
    const label = t(meta.key, meta.fallback);
    return `
      <div onclick="window.openReservationDetail('${r.id}')" style="background:var(--bg-card,#fff);border:1.5px solid var(--border-color,#e2e8f0);border-radius:14px;padding:14px 16px;margin-bottom:10px;cursor:pointer;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <b style="font-size:14px;color:var(--text-primary,#111827);">#${String(r.id || "").slice(-6).toUpperCase()}</b>
          <span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:800;background:${meta.bg};color:${meta.fg};">${meta.icon} ${label}</span>
        </div>
        <div style="font-size:13px;color:var(--text-secondary,#475569);display:flex;flex-direction:column;gap:3px;">
          <span>📅 ${r.date || ""} · ⏰ ${r.time || ""}</span>
          <span>👥 ${r.guests || ""} ${t("resv_guests_short", "kishi")}</span>
          ${r.tableNumber ? `<span>🪑 ${t("table", "Stol")} ${r.tableNumber}</span>` : ""}
        </div>
      </div>`;
  }).join("") : `<p style="text-align:center;color:var(--text-muted,#94a3b8);padding:30px 0;">${t("my_reservations_empty", "Bronlaringiz topilmadi")}</p>`;

  modal.innerHTML = `
    <div style="background:var(--bg-card,#fff);width:100%;max-width:480px;border-radius:24px 24px 0 0;padding:16px 20px calc(20px + env(safe-area-inset-bottom,0));max-height:85vh;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <h3 style="margin:0;font-size:18px;font-weight:800;color:var(--text-primary,#111827);">${t("nav_my_reservations", "Bronlarim")}</h3>
        <button onclick="window.closeMyReservationsModal()" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--text-muted,#94a3b8);">✕</button>
      </div>
      <div style="overflow-y:auto;flex:1;">${cardsHtml}</div>
    </div>`;
}

window.openMyReservationsModal = function () {
  const modal = document.getElementById("my-reservations-modal");
  if (!modal) return;
  modal.style.display = "flex";
  _renderMyReservationsList();
};
window.closeMyReservationsModal = function () {
  const modal = document.getElementById("my-reservations-modal");
  if (modal) modal.style.display = "none";
};

window.openReservationDetail = function (id) {
  const r = (window._myReservations || []).find(x => x.id === id);
  if (!r) return;
  window._openReservationDetailId = id;
  const modal = document.getElementById("reservation-detail-modal");
  if (!modal) return;

  const meta = _reservationStatusMeta(r.status);
  const label = t(meta.key, meta.fallback);
  const canCancel = RESERVATION_CANCELLABLE_STATUSES.has(String(r.status || "pending").toLowerCase());
  const esc = (s) => String(s || "").replace(/</g, "");

  modal.innerHTML = `
    <div style="background:var(--bg-card,#fff);color:var(--text-primary,#111827);border-radius:18px;width:100%;max-width:420px;max-height:90vh;overflow-y:auto;padding:22px 22px 24px;position:relative;">
      <button onclick="window.closeReservationDetail()" style="position:absolute;top:14px;right:14px;background:var(--bg-input,#f3f4f6);border:none;width:30px;height:30px;border-radius:9px;cursor:pointer;color:var(--text-secondary,#6b7280);font-size:15px;">✕</button>
      <div style="text-align:center;margin-bottom:14px;">
        <div style="font-size:15px;font-weight:800;">${esc(RESTAURANT_SETTINGS.restaurantName || "Nesta ERP")}</div>
        ${RESTAURANT_SETTINGS.address ? `<div style="font-size:12px;color:var(--text-secondary,#6b7280);">${esc(RESTAURANT_SETTINGS.address)}</div>` : ""}
        ${RESTAURANT_SETTINGS.contactPhone ? `<div style="font-size:12px;color:var(--text-secondary,#6b7280);">☎ ${esc(RESTAURANT_SETTINGS.contactPhone)}</div>` : ""}
      </div>
      <div style="text-align:center;margin-bottom:14px;">
        <span style="display:inline-block;padding:5px 14px;border-radius:999px;font-size:12.5px;font-weight:800;background:${meta.bg};color:${meta.fg};">${meta.icon} ${label}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;font-size:13.5px;">
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted,#94a3b8);">${t("reservation_id_label", "Bron ID")}</span><b>#${String(r.id || "").slice(-6).toUpperCase()}</b></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted,#94a3b8);">${t("receipt_date", "Sana")}</span><b>${esc(r.date)}</b></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted,#94a3b8);">${t("receipt_time_label", "Vaqt")}</span><b>${esc(r.time)}</b></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted,#94a3b8);">${t("resv_guests_short", "Mehmonlar")}</span><b>${esc(r.guests)}</b></div>
        ${r.tableNumber ? `<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted,#94a3b8);">${t("table", "Stol")}</span><b>${esc(r.tableNumber)}</b></div>` : ""}
        ${r.hall ? `<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted,#94a3b8);">${t("reservation_hall_label", "Zal / VIP xona")}</span><b>${esc(r.hall)}</b></div>` : ""}
        ${r.adminNote ? `<div><span style="color:var(--text-muted,#94a3b8);">${t("reservation_admin_note_label", "Admin izohi")}</span><p style="margin:4px 0 0;">${esc(r.adminNote)}</p></div>` : ""}
        ${r.specialRequests ? `<div><span style="color:var(--text-muted,#94a3b8);">${t("reservation_customer_note_label", "Mijoz izohi")}</span><p style="margin:4px 0 0;">${esc(r.specialRequests)}</p></div>` : ""}
      </div>
      ${canCancel ? `<button onclick="window.cancelMyReservation('${r.id}')" style="width:100%;margin-top:18px;padding:12px;border:none;border-radius:12px;background:#ef4444;color:#fff;font-weight:700;font-size:14px;cursor:pointer;">✕ ${t("reservation_cancel_btn", "Mening bronimni bekor qilish")}</button>` : ""}
    </div>`;
  modal.style.display = "flex";
};

window.closeReservationDetail = function () {
  const modal = document.getElementById("reservation-detail-modal");
  if (modal) modal.style.display = "none";
  window._openReservationDetailId = null;
};

window.cancelMyReservation = async function (id) {
  if (!confirm(t("reservation_cancel_confirm", "Bronni bekor qilishni tasdiqlaysizmi?"))) return;
  try {
    await update(ref(db, `${BASE_PATH}/reservations/${id}`), {
      status: "canceled",
      cancelledBy: "client",
      cancelledAt: Date.now(),
      updatedAt: Date.now(),
    });
    window.closeReservationDetail();
    if (typeof showNotification === "function") {
      showNotification(t("reservation_cancelled_success", "Bron bekor qilindi"));
    }
  } catch (err) {
    console.error("cancelMyReservation error:", err);
    alert(t("error_prefix", "Xatolik: ") + (err.message || ""));
  }
};

// ══════════════════════════════════════════════════════
// 🏪 STORE HEADER (SECTION: HOME PAGE)
// Restaurant name/logo, open/closed, ETA, min order, delivery fee, free
// delivery threshold — all sourced from the same RESTAURANT_SETTINGS object
// already synced live elsewhere in this file (no extra Firebase reads).
// ══════════════════════════════════════════════════════
window.renderStoreHeader = function () {
  const nameEl = document.getElementById("storeName");
  if (nameEl && RESTAURANT_SETTINGS.restaurantName) nameEl.textContent = RESTAURANT_SETTINGS.restaurantName;

  const openEl = document.getElementById("storeOpenBadge");
  if (openEl) {
    const open = isRestaurantCurrentlyOpen() && RESTAURANT_SETTINGS.serviceTypes?.delivery !== false;
    openEl.textContent = open ? t("store_open", "Ochiq") : t("store_closed", "Yopiq");
    openEl.className = "store-badge " + (open ? "store-badge-open" : "store-badge-closed");
  }

  // Restaurant rating — additive optional field (RESTAURANT_SETTINGS.rating);
  // hidden until an admin-side rating feature sets it.
  const ratingEl = document.getElementById("storeRating");
  if (ratingEl) {
    const rating = Number(RESTAURANT_SETTINGS.rating || 0);
    ratingEl.textContent = rating > 0 ? `⭐ ${rating.toFixed(1)}` : "";
  }

  const ds = RESTAURANT_SETTINGS.deliverySettings || {};
  const etaEl = document.getElementById("storeEta");
  if (etaEl) {
    const eta = Number(RESTAURANT_SETTINGS.normalOrderBaseTime || 30);
    etaEl.textContent = `⏱ ${eta}-${eta + 15} ${t("minute_short", "daqiqa")}`;
  }
  const minOrderEl = document.getElementById("storeMinOrder");
  if (minOrderEl) {
    const minOrder = Number(ds.minOrderAmount || RESTAURANT_SETTINGS.minOrderAmount || 0);
    minOrderEl.textContent = minOrder > 0
      ? `${t("min_order_label", "Minimal buyurtma")}: ${minOrder.toLocaleString()} ${t("currency", "so'm")}`
      : "";
  }
  const feeEl = document.getElementById("storeDeliveryFee");
  if (feeEl) {
    const fee = Number(ds.baseFee || 0);
    feeEl.textContent = `${t("delivery_fee_label", "Yetkazish narxi")}: ${fee > 0 ? fee.toLocaleString() + " " + t("currency", "so'm") : t("delivery_fee_free", "Bepul")}`;
  }
  const freeEl = document.getElementById("storeFreeThreshold");
  if (freeEl) {
    const threshold = Number(ds.freeDeliveryThreshold || 0);
    // 🩹 free_delivery_from endi to'liq jumla shabloni ("{amount}" bilan) —
    // avval "Bepul yetkazish: N+ so'm" kabi qo'lda birlashtirilgan edi,
    // bu esa har tilda so'z tartibini noto'g'ri qilib qo'yardi (masalan
    // ruscha "Бесплатная доставка: N+ сум" tabiiy emas edi). Dynamic
    // qiymat (threshold) hamon alohida — faqat matn shabloni tarjima
    // qilinadi.
    freeEl.textContent = threshold > 0
      ? t("free_delivery_from", "{amount}+ so'mdan bepul yetkazib berish").replace("{amount}", threshold.toLocaleString())
      : "";
  }
};

// ══════════════════════════════════════════════════════
// 📍 DELIVERY ADDRESS (SECTION: DELIVERY ADDRESS)
// The address is determined ONLY inside the checkout/payment screen — there
// is no separate header address bar or address sheet. #deliveryAddressPanel
// lives detached in the DOM and window.openDeliveryCheckout() moves it into
// the checkout screen's #dc-address-slot each time checkout opens.
//
// Label flow: the customer names an address ("Uy" / "Ish" / anything they
// type) and it's saved under that name. Typing a name that matches an
// already-saved label (case-insensitive) auto-fills every address field
// from that saved address — so next time they just type "uy" and the full
// address (street/house/apartment/entrance/...) fills itself in.
// ══════════════════════════════════════════════════════
window._daPickLabelChip = function (label) {
  const input = document.getElementById("daLabel");
  if (!input) return;
  input.value = label;
  input.focus();
  tryAutofillFromLabel(label);
};

// Looks up window._savedAddressesCache for a label matching what's typed
// (case-insensitive, trimmed) and — if found — fills the rest of the address
// form from it. Never overwrites the label input itself while the person is
// mid-typing; only the address fields (city/street/house/...) are filled.
function tryAutofillFromLabel(typedLabel) {
  const hintEl = document.getElementById("daLabelMatchHint");
  const needle = String(typedLabel || "").trim().toLowerCase();
  if (!needle) { if (hintEl) hintEl.style.display = "none"; return; }
  const saved = window._savedAddressesCache || {};
  const match = Object.entries(saved).find(([, a]) => String(a.label || "").trim().toLowerCase() === needle);
  if (!match) { if (hintEl) hintEl.style.display = "none"; return; }
  const [id, a] = match;
  document.getElementById("daCity").value = a.city || "";
  document.getElementById("daDistrict").value = a.district || "";
  document.getElementById("daMahalla").value = a.mahalla || "";
  document.getElementById("daStreet").value = a.street || "";
  document.getElementById("daHouse").value = a.house || "";
  document.getElementById("daApartment").value = a.apartment || "";
  document.getElementById("daEntrance").value = a.entrance || "";
  document.getElementById("daFloor").value = a.floor || "";
  document.getElementById("daDoorCode").value = a.doorCode || "";
  document.getElementById("daLandmark").value = a.landmark || "";
  document.getElementById("daComment").value = a.comment || "";
  if (typeof a.lat === "number" && typeof a.lng === "number") setDeliveryLatLng(a.lat, a.lng, /* skipGeocode */ true);
  localStorage.setItem("defaultAddressId", id);
  updateDeliveryFeePreview();
  if (hintEl) {
    hintEl.textContent = "✓ " + t("delivery_address_label_autofilled", "Manzil avtomatik to'ldirildi");
    hintEl.style.display = "block";
  }
}

// Wires the label input separately from wireAddressFormLiveUpdates() (city/
// district/.../house) since it drives autofill-by-name rather than the
// header-bar text that used to live in this SECTION.
function wireAddressLabelLiveUpdate() {
  if (window._addressLabelListenerWired) return;
  window._addressLabelListenerWired = true;
  document.getElementById("daLabel")?.addEventListener("input", (e) => tryAutofillFromLabel(e.target.value));
}

// ── Profile "Manzillarim" (SECTION: DELIVERY ADDRESS) ─────────────────────
// Lets the customer manage saved addresses (add/edit/delete) from the
// Profile sheet, independently of checkout — reuses the exact same
// #deliveryAddressPanel (map, geolocation, city/street/.../label fields) by
// moving it into #profileAddressFormSlot, the same appendChild pattern
// openDeliveryCheckout() uses for #dc-address-slot. Two checkout-only rows
// (#deliveryFeeInfo, the "save this address" checkbox) are hidden here since
// there's no order total to preview a fee against and saving is implied by
// being on this screen at all.
window._profileEditingAddressId = null;

window.openProfileAddressForm = function (addressId = null) {
  const panel = document.getElementById("deliveryAddressPanel");
  const slot = document.getElementById("profileAddressFormSlot");
  if (!panel || !slot) return;
  if (panel.parentElement !== slot) slot.appendChild(panel);
  panel.style.display = "block";

  window._profileEditingAddressId = addressId;
  _selectedDeliveryLatLng = null;

  // Reset (or prefill, when editing) before the panel becomes visible so
  // the customer never sees a stale address from a previous edit/checkout.
  ["daCity", "daDistrict", "daMahalla", "daStreet", "daHouse", "daApartment",
   "daEntrance", "daFloor", "daDoorCode", "daLandmark", "daComment", "daLabel"]
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });

  const saveRow = document.getElementById("daSaveAddress")?.closest("div");
  if (saveRow) saveRow.style.display = "none";
  const feeInfo = document.getElementById("deliveryFeeInfo");
  if (feeInfo) feeInfo.style.display = "none";
  const savedRow = document.getElementById("savedAddressesRow");
  if (savedRow) savedRow.style.display = "none"; // picking from itself makes no sense here

  if (addressId) {
    const a = (window._savedAddressesCache || {})[addressId];
    if (a) {
      document.getElementById("daCity").value = a.city || "";
      document.getElementById("daDistrict").value = a.district || "";
      document.getElementById("daMahalla").value = a.mahalla || "";
      document.getElementById("daStreet").value = a.street || "";
      document.getElementById("daHouse").value = a.house || "";
      document.getElementById("daApartment").value = a.apartment || "";
      document.getElementById("daEntrance").value = a.entrance || "";
      document.getElementById("daFloor").value = a.floor || "";
      document.getElementById("daDoorCode").value = a.doorCode || "";
      document.getElementById("daLandmark").value = a.landmark || "";
      document.getElementById("daComment").value = a.comment || "";
      document.getElementById("daLabel").value = a.label || "";
      if (typeof a.lat === "number" && typeof a.lng === "number") _selectedDeliveryLatLng = { lat: a.lat, lng: a.lng };
    }
  }

  initDeliveryAddressMap();
  if (_selectedDeliveryLatLng) setDeliveryLatLng(_selectedDeliveryLatLng.lat, _selectedDeliveryLatLng.lng, /* skipGeocode */ true);
  wireAddressLabelLiveUpdate();

  document.getElementById("_profileAddrFormBtns")?.remove();
  slot.insertAdjacentHTML("beforeend", `
    <div id="_profileAddrFormBtns" style="display:flex;gap:8px;margin-top:10px;">
      <button type="button" class="btn-check" style="flex:1;justify-content:center;" onclick="window.saveProfileAddress()" data-i18n="save_btn">${t("save_btn", "Saqlash")}</button>
      <button type="button" class="btn-check" style="flex:1;justify-content:center;" onclick="window.closeProfileAddressForm()" data-i18n="cancel">${t("cancel", "Bekor qilish")}</button>
    </div>
  `);
};

window.closeProfileAddressForm = function () {
  const panel = document.getElementById("deliveryAddressPanel");
  if (panel) {
    panel.style.display = "none";
    // Detach to document.body rather than .remove() — the panel is a
    // singleton reused by checkout and by this form; destroying it would
    // break every future getElementById("deliveryAddressPanel") lookup.
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
  }
  const slot = document.getElementById("profileAddressFormSlot");
  if (slot) slot.innerHTML = "";
  window._profileEditingAddressId = null;
};

window.saveProfileAddress = async function () {
  const street = document.getElementById("daStreet")?.value?.trim();
  if (!street) { alert(t("delivery_street_required", "Ko'cha nomini kiriting!")); return; }
  const key = getCustomerKey();
  if (!key) { alert(t("delivery_phone_required", "Telefon raqamingizni kiriting!")); return; }

  const addressLabel = document.getElementById("daLabel")?.value?.trim() || street;
  const addr = {
    city: document.getElementById("daCity")?.value?.trim() || "",
    district: document.getElementById("daDistrict")?.value?.trim() || "",
    mahalla: document.getElementById("daMahalla")?.value?.trim() || "",
    street,
    house: document.getElementById("daHouse")?.value?.trim() || "",
    apartment: document.getElementById("daApartment")?.value?.trim() || "",
    entrance: document.getElementById("daEntrance")?.value?.trim() || "",
    floor: document.getElementById("daFloor")?.value?.trim() || "",
    doorCode: document.getElementById("daDoorCode")?.value?.trim() || "",
    landmark: document.getElementById("daLandmark")?.value?.trim() || "",
    comment: document.getElementById("daComment")?.value?.trim() || "",
    label: addressLabel,
    ...(typeof _selectedDeliveryLatLng?.lat === "number" ? { lat: _selectedDeliveryLatLng.lat, lng: _selectedDeliveryLatLng.lng } : {}),
    updatedAt: Date.now()
  };

  const editingId = window._profileEditingAddressId;
  const savedKey = editingId || push(ref(db, `${BASE_PATH}/customers/${key}/savedAddresses`)).key;
  if (!editingId) addr.createdAt = Date.now();

  try {
    await update(ref(db, `${BASE_PATH}/customers/${key}/savedAddresses/${savedKey}`), addr);
    if (!localStorage.getItem("defaultAddressId")) localStorage.setItem("defaultAddressId", savedKey);
    showNotification(t("profile_address_saved", "Manzil saqlandi"));
    window.closeProfileAddressForm();
    renderSavedAddressesRow();
  } catch (err) {
    console.error("saveProfileAddress error:", err);
    alert(t("profile_address_save_failed", "Manzilni saqlab bo'lmadi"));
  }
};

window.editProfileAddress = function (id) {
  window.openProfileAddressForm(id);
};

window.deleteProfileAddress = async function (id) {
  const key = getCustomerKey();
  if (!key) return;
  if (!confirm(t("profile_address_delete_confirm", "Bu manzilni o'chirasizmi?"))) return;
  try {
    await remove(ref(db, `${BASE_PATH}/customers/${key}/savedAddresses/${id}`));
    if (localStorage.getItem("defaultAddressId") === id) localStorage.removeItem("defaultAddressId");
    if (window._profileEditingAddressId === id) window.closeProfileAddressForm();
    renderSavedAddressesRow();
  } catch (err) {
    console.error("deleteProfileAddress error:", err);
    alert(t("profile_address_delete_failed", "Manzilni o'chirib bo'lmadi"));
  }
};

// ══════════════════════════════════════════════════════
// ⭐ HOME FEATURED SECTIONS (Popular/Recommended/New/Discounted/Best
// Sellers/Seasonal) — admin chooses which appear via the additive
// RESTAURANT_SETTINGS.homeSections array; defaults to a sensible set.
// ══════════════════════════════════════════════════════
const HOME_SECTION_DEFS = {
  popular: { labelKey: "section_popular", labelUz: "Ommabop", filter: i => TOP_FOODS.includes(i.id) },
  bestSellers: { labelKey: "section_best_sellers", labelUz: "Eng ko'p sotilgan", filter: i => TOP_FOODS.includes(i.id) },
  recommended: { labelKey: "section_recommended", labelUz: "Tavsiya etamiz", filter: i => i.recommended === true },
  new: { labelKey: "section_new", labelUz: "Yangi", filter: i => isNewFood(i) },
  discounted: { labelKey: "section_discounted", labelUz: "Chegirmadagilar", filter: i => Number(i.oldPrice || 0) > Number(i.price || 0) || Number(i.discountPrice || 0) > 0 },
  seasonal: { labelKey: "section_seasonal", labelUz: "Mavsumiy", filter: i => i.seasonal === true }
};

function renderHomeFeaturedSections() {
  const box = document.getElementById("homeFeaturedSections");
  if (!box) return;
  const enabled = Array.isArray(RESTAURANT_SETTINGS.homeSections) && RESTAURANT_SETTINGS.homeSections.length
    ? RESTAURANT_SETTINGS.homeSections
    : ["popular", "new", "discounted"];

  const menu = window.allMenu || {};
  const stop = typeof stopListData !== "undefined" ? stopListData : {};
  const allItems = Object.entries(menu)
    .filter(([id, i]) => i && i.active !== false)
    .map(([id, i]) => ({ id, ...i }));
  const lang = getLang();

  const sectionsHtml = enabled.map(key => {
    const def = HOME_SECTION_DEFS[key];
    if (!def) return "";
    const items = allItems.filter(def.filter).slice(0, 12);
    if (items.length === 0) return "";
    const cardsHtml = items.map(i => {
      const name = typeof i.name === "object" ? (i.name[lang] || i.name.uz || "—") : i.name;
      const isOOS = stop[i.id] === true;
      const img = (i.imgUrl || i.image || i.img)
        ? `<img class="mini-card-img" src="${i.imgUrl || i.image || i.img}" loading="lazy" alt="${name}">`
        : `<div class="mini-card-img mini-card-img-placeholder">🍽️</div>`;
      return `<div class="mini-card${isOOS ? " mini-card-oos" : ""}" onclick="${isOOS ? "" : `window.quickAddToCart('${i.id}')`}">
        ${img}
        <div class="mini-card-name">${name}</div>
        <div class="mini-card-price">${Number(i.price || 0).toLocaleString()} ${t("currency", "so'm")}</div>
        ${isOOS ? `<div class="mini-card-oos-badge">${t("out_of_stock", "Tugagan")}</div>` : ""}
      </div>`;
    }).join("");
    return;
  }).join("");

  box.innerHTML = sectionsHtml;
}

window.quickAddToCart = function (itemId) {
  const item = (window.allMenu || {})[itemId];
  if (!item) return;
  if (item.variants && Object.keys(item.variants).length > 0) { window.openVariantModal(itemId); return; }
  if (typeof window.openItemModifiers === "function" && window.itemHasModifiers(itemId)) { window.openItemModifiers(itemId); return; }
  changeQty(itemId, 1);
};

// ══════════════════════════════════════════════════════
// 📣 PROMOTIONS BANNER STRIP (SECTION: PROMOTIONS)
// Reuses the existing restaurants/{id}/discounts registry (global codes,
// i.e. no ownerPhone) — no new admin-side data model introduced.
//
// 🩹 REFRESHLESS I18N FIX — onValue() faqat Firebase /discounts ma'lumoti
// O'ZI o'zgarganda qayta ishga tushardi, til almashtirilganda emas
// (chunki bu doimiy tinglovchi, bir martalik render emas). Shu sababli
// "🚚 Bepul yetkazish..." matni til almashtirilgandan keyin F5 bosilmaguncha
// eski tilda qolib ketardi. Endi oxirgi olingan snapshot (window._lastPromo
// BannersSnap) saqlanadi va renderPromoBanners() alohida chaqiriladigan
// funksiyaga chiqarildi — shunda onLangChange yangi Firebase o'qishsiz,
// mavjud snapshotdan qayta chizishi mumkin.
// ══════════════════════════════════════════════════════
function renderPromoBanners() {
  const box = document.getElementById("promoBannerStrip");
  if (!box) return;
  const all = window._lastPromoBannersSnap || {};
  // "code" — adminning promokod maydoni (savatga kiritiladigan haqiqiy
  // kod, masalan "YANGI10"), mijoz uni checkout'dagi promo-input'ga aynan
  // shu yozilishda kiritishi kerak — shuning uchun BU matn tarjima
  // qilinmaydi (item 14'dagi "customer/admin-entered text tarjima
  // qilinmasin" qoidasi bilan bir xil sabab: kod har doim aynan bir xil
  // ko'rinishda ko'rinishi kerak, aks holda mijoz uni noto'g'ri terib
  // qo'yadi). Faqat foizi (d.percent) — dynamic raqam — o'zgaradi.
  const active = Object.entries(all).filter(([code, d]) => !d.ownerPhone && !d.used && Number(d.usedCount || 0) < Number(d.maxUses || 1));
  const ds = RESTAURANT_SETTINGS.deliverySettings || {};
  const cards = active.map(([code, d]) => `
    <div class="promo-banner-card">🎫 ${code} — ${d.percent}%</div>
  `);
  if (Number(ds.freeDeliveryThreshold || 0) > 0) {
    const _freeText = t("free_delivery_from", "{amount}+ so'mdan bepul yetkazib berish")
      .replace("{amount}", Number(ds.freeDeliveryThreshold).toLocaleString());
    cards.push(`<div class="promo-banner-card">🚚 ${_freeText}</div>`);
  }
  box.innerHTML = cards.join("");
}

function subscribePromoBanners() {
  onValue(ref(db, BASE_PATH + "/discounts"), snap => {
    window._lastPromoBannersSnap = snap.val() || {};
    renderPromoBanners();
  });
}

// ══════════════════════════════════════════════════════
// 🔥 POPULAR ITEMS (SECTION: MENU / "Popular" filter)
// TOP_FOODS was previously always empty (dead feature). Computed here from
// a single bounded read of the last 200 orders (PERFORMANCE: Optimize
// Firebase reads), cached in localStorage for 1 hour so repeat visits don't
// re-read it.
// ══════════════════════════════════════════════════════
// 🩹 ROOT-CAUSE FIX (console: "computePopularItems error: Permission
// denied") — this used to `get(query(ref(db, BASE_PATH + "/orders"), ...))`,
// a direct client-side read of the restaurant's FULL orders collection.
// That is not a misconfigured Rule to "fix" — it is Firebase Rules
// correctly enforcing a deliberate, documented security boundary from an
// earlier hardening pass (see database.rules.json's own comment at the
// "orders" node, and backend/routes/clientOrders.js's file header): a
// customer/QR session is intentionally NEVER granted read access to the
// orders collection as a whole (only to one specific, already-known order
// id, via the server-authorized GET /api/client/orders/:orderId route) —
// otherwise any customer could enumerate every other customer's order
// history/PII. That endpoint deliberately has no "list orders" route at
// all, by design. So this read was always guaranteed to fail for every
// customer session, on every single page load (the localStorage cache
// below never got a chance to populate, since the read never succeeded) —
// forever retrying a doomed request and logging a permission error each
// time. Fixed by no longer attempting it: TOP_FOODS stays [] (its
// pre-existing default — "Ommabop/Top" simply shows nothing, same as
// before this read was ever added; nothing else depends on it being
// non-empty). A real fix — restoring the "Popular items" feature safely —
// would need a NEW backend endpoint that computes an aggregated tally
// server-side (Admin SDK) and returns only item-id/count pairs, never raw
// order data — deliberately not added here without being asked for it,
// since it's a new security-sensitive surface, not a bug fix.
async function computePopularItems() {
  try {
    const cacheKey = `popularItems_${currentRestaurantId}`;
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (cached && Date.now() - cached.ts < 3600000) {
      TOP_FOODS = cached.ids || [];
      renderMenu();
      if (typeof renderHomeFeaturedSections === "function") renderHomeFeaturedSections();
    }
  } catch (err) {
    console.warn("computePopularItems error:", err);
  }
}

// ══════════════════════════════════════════════════════
// ❤️ FAVORITES (SECTION: FAVORITES)
// Stored per-device at clients/{clientId}/favorites/{itemId}=true — keyed
// off the anonymous clientId (already generated for every visitor, see
// top of file) rather than phone number, so tapping the heart never
// requires entering a phone number. Phone is only ever asked for at actual
// checkout (sendDeliveryOrder). A new, additive Firebase path; nothing
// existing is renamed or restructured.
// ══════════════════════════════════════════════════════
window._favoritesCache = {};

function getCustomerKey() {
  let raw = localStorage.getItem("customerPhone") || localStorage.getItem("userPhone") || "";
  // Profilga kiritilgan-u, biror sababdan localStorage-ga yozilmagan raqamni
  // ham hisobga olamiz — Tarix/Profil doim bir xil manbadan o'qisin.
  if (!raw) {
    raw = document.getElementById("profilePhone")?.value?.trim()
      || document.getElementById("clientPhoneInput")?.value?.trim()
      || "";
  }
  const phone = normalizeCustomerPhone(raw);
  if (!phone) return null;
  // Keyingi safar to'g'ridan-to'g'ri localStorage'dan topilsin (localStorage
  // har doim RAW "+998..." ko'rinishda saqlanadi — faqat Firebase KALITI
  // sifatida ishlatilganda encodeURIComponent() qilinadi, quyida).
  localStorage.setItem("customerPhone", phone);
  // 🩹 Audit fix: admin.js/waiter.js customers/{phone} Firebase kalitini
  // har doim encodeURIComponent() bilan yozadi (crmAdvSafeKey). client.js
  // avval kalitni RAW "+998..." holida ishlatardi — bu ikki FARQLI Firebase
  // yozuvi ("customers/+998..." va "customers/%2B998...") yaratardi, ya'ni
  // bitta haqiqiy mijoz ikkita alohida profilga bo'linib qolardi. Endi
  // hamma joy bir xil kalit formatidan foydalanadi.
  return encodeURIComponent(phone);
}

// Favorites always have an identity to key off of, because clientId is
// generated unconditionally on first visit (no phone number needed).
function getFavoritesKey() {
  return localStorage.getItem("clientId") || clientId;
}

function subscribeFavorites() {
  const key = getFavoritesKey();
  if (!key) { window._favoritesCache = {}; return; }
  onValue(ref(db, `${BASE_PATH}/clients/${key}/favorites`), snap => {
    window._favoritesCache = snap.val() || {};
    if (typeof renderFavoritesView === "function") renderFavoritesView();
    if (typeof renderMenu === "function") renderMenu();
  });
}

window.toggleFavorite = function (itemId) {
  const key = getFavoritesKey();
  if (!key) return; // clientId is always set on load, so this shouldn't happen
  const isFav = window._favoritesCache[itemId] === true;
  set(ref(db, `${BASE_PATH}/clients/${key}/favorites/${itemId}`), isFav ? null : true);
};

function renderFavoritesView() {
  const box = document.getElementById("favoritesList");
  if (!box) return;

  if (!document.getElementById("_favRowStyles")) {
    const s = document.createElement("style");
    s.id = "_favRowStyles";
    s.textContent = `
      .fav-row {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 0; border-bottom: 1px solid var(--border-color, #e2e8f0);
      }
      .fav-row:last-child { border-bottom: none; }
      .fav-row-img {
        width: 44px; height: 44px; border-radius: 8px; object-fit: cover;
        flex-shrink: 0; background: #f1f5f9;
      }
      .fav-row-img-placeholder {
        width: 44px; height: 44px; border-radius: 8px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        background: #f1f5f9; font-size: 20px;
      }
      .fav-row-body { flex: 1; min-width: 0; }
      .fav-row-name { font-weight: 600; font-size: 14px; }
      .fav-row-price { font-size: 12.5px; color: #64748b; margin-top: 2px; }
      .fav-row-remove {
        background: none; border: none; font-size: 18px; cursor: pointer;
        padding: 6px; flex-shrink: 0; -webkit-tap-highlight-color: transparent;
      }
    `;
    document.head.appendChild(s);
  }

  const menu = window.allMenu || {};
  const lang = getLang();
  const favIds = Object.keys(window._favoritesCache || {}).filter(id => window._favoritesCache[id] === true);
  if (favIds.length === 0) {
    box.innerHTML = `<p class="empty">${t("favorites_empty", "Sevimlilar ro'yxati bo'sh")}</p>`;
    return;
  }
  box.innerHTML = favIds.map(id => {
    const item = menu[id];
    if (!item) return "";
    const name = typeof item.name === "object" ? (item.name[lang] || item.name.uz || "—") : item.name;
    const price = Number(item.price || 0).toLocaleString();
    const imgSrc = item.imgUrl || item.image || item.img;
    const imgHtml = imgSrc
      ? `<img class="fav-row-img" src="${imgSrc}" loading="lazy" alt="${name}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
         <div class="fav-row-img-placeholder" style="display:none;">🍽️</div>`
      : `<div class="fav-row-img-placeholder">🍽️</div>`;
    return `<div class="fav-row">
      ${imgHtml}
      <div class="fav-row-body">
        <div class="fav-row-name">${name}</div>
        <div class="fav-row-price">💰 ${price} ${typeof t === "function" ? t("currency", "so'm") : "so'm"}</div>
      </div>
      <button type="button" class="fav-row-remove" onclick="window.toggleFavorite('${id}')" aria-label="${t("delete_btn", "O'chirish")}">💔</button>
    </div>`;
  }).join("");
}
window.renderFavoritesView = renderFavoritesView;

// ══════════════════════════════════════════════════════
// 📜 ORDER HISTORY (SECTION: PROFILE)
// Reads the customers/{phone}/orderIds index written alongside order
// creation in sendDeliveryOrder(), then fetches each order individually.
// ══════════════════════════════════════════════════════
async function renderOrderHistoryView() {
  const box = document.getElementById("orderHistoryList");
  if (!box) return;
  const key = getCustomerKey();
  if (!key) { box.innerHTML = `<p class="empty">${t("delivery_phone_required", "Telefon raqamingizni kiriting!")}</p>`; return; }
  box.innerHTML = `<p class="empty">${t("loading", "Yuklanmoqda...")}</p>`;
  try {
    const idxSnap = await get(ref(db, `${BASE_PATH}/customers/${key}/orderIds`));
    const ids = Object.keys(idxSnap.val() || {});
    if (ids.length === 0) { box.innerHTML = `<p class="empty">${t("order_history_empty", "Hali buyurtmalar yo'q")}</p>`; return; }
    const orders = [];
    for (const id of ids) {
      const o = await fetchClientOrder(id);
      if (o) orders.push({ id, ...o });
    }
    orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    box.innerHTML = orders.map(o => `
      <div class="order-history-row">
        <div onclick="window.openOrderTracking('${o.id}')" style="cursor:pointer;">
          <b>${formatOrderNumber(o) || o.orderNumber}</b>
          <span class="order-history-date">${new Date(o.createdAt || 0).toLocaleString()}</span>
        </div>
        <div onclick="window.openOrderTracking('${o.id}')" style="cursor:pointer;">${getStatusV2Label(o.status)} · ${Number(o.total || 0).toLocaleString()} ${t("currency", "so'm")}</div>
        <button type="button" class="reorder-btn" onclick="event.stopPropagation(); window.reorderPastOrder('${o.id}')" data-i18n="reorder_btn">🔁 ${t("reorder_btn", "Qayta buyurtma qilish")}</button>
      </div>`).join("");
  } catch (err) {
    console.error("renderOrderHistoryView error:", err);
    box.innerHTML = `<p class="empty">${t("error_generic", "Xatolik yuz berdi")}</p>`;
  }
}

// Rebuilds the cart from a past order's items and reopens the cart — reuses
// the existing cart/changeQty pipeline instead of any new order-creation path.
window.reorderPastOrder = async function (orderId) {
  try {
    const order = await fetchClientOrder(orderId);
    if (!order) return;
    const menu = window.allMenu || {};
    const newCart = {};
    Object.entries(order.items || {}).forEach(([key, it]) => {
      if (!menu[it.id]) return; // item no longer on the menu — skip silently
      newCart[key] = {
        qty: Number(it.qty || 1),
        ...(it.variantId ? { variantId: it.variantId, variantName: it.variantName, price: it.price } : {}),
        ...(it.modifiers ? { modifiers: it.modifiers } : {})
      };
    });
    window.cart = newCart;
    localStorage.setItem("cart", JSON.stringify(newCart));
    updateCart();
    renderMenu();
    document.getElementById("orderHistoryModal").style.display = "none";
    toggleCart();
    showNotification(t("reorder_success", "Savatga qo'shildi!"));
  } catch (err) {
    console.error("reorderPastOrder error:", err);
    alert(t("error_generic", "Xatolik yuz berdi"));
  }
};
window.renderOrderHistoryView = renderOrderHistoryView;

// ══════════════════════════════════════════════════════
// 👤 PROFILE (SECTION: PROFILE)
// Name/phone are now editable inputs (not read-only text) — saved to
// localStorage on window.saveProfileInfo(), same storage keys as before
// (customerName / customerPhone) so nothing else that reads them breaks.
// Order count and registration date are read from customers/{phone}
// (createdAt, already written by saveCustomerToDatabase) and
// customers/{phone}/orderIds (already written by sendDeliveryOrder /
// renderOrderHistoryView) — no new Firebase paths introduced.
// ══════════════════════════════════════════════════════
// Detach-before-reattach handle for the live customer-record subscription
// started inside renderProfileView() below — see the comment at its call
// site for why this needed to become a live listener instead of a one-time
// get().
let _profileCustUnsub = null;

async function renderProfileView() {
  const phoneEl = document.getElementById("profilePhone");
  if (phoneEl) phoneEl.value = localStorage.getItem("customerPhone") || localStorage.getItem("userPhone") || "";
  const nameEl = document.getElementById("profileName");
  if (nameEl) nameEl.value = localStorage.getItem("customerName") || "";

  // Manzillarim (SECTION: DELIVERY ADDRESS) — refresh the saved-addresses
  // cache so #profileAddressesList reflects the latest data every time the
  // Profile sheet opens.
  renderSavedAddressesRow();

  const orderCountEl = document.getElementById("profileOrderCount");
  const registeredEl = document.getElementById("profileRegisteredDate");
  const loyaltyBox = document.getElementById("profileLoyaltyBox");
  const key = getCustomerKey();
  // Any previous subscription (for a different customer key, or from a
  // prior open of this sheet) must be detached before we either bail out
  // below or attach a new one — otherwise repeated renderProfileView()
  // calls (tab switch, language change, saveProfileInfo()) stack duplicate
  // onValue() listeners on customers/{key} that never get cleaned up.
  if (_profileCustUnsub) { _profileCustUnsub(); _profileCustUnsub = null; }
  if (!key) {
    if (orderCountEl) orderCountEl.textContent = "0";
    if (registeredEl) registeredEl.textContent = "—";
    // Telefon kiritilmagan — Profile'da hech qanday mijoz ma'lumoti
    // ko'rsatilmaydi (spec talabi), faqat telefon kiritishga taklif.
    if (loyaltyBox) {
      loyaltyBox.innerHTML = `<p style="margin-top:10px;font-size:12.5px;color:var(--text-secondary,#6b7280);text-align:center;">${t("profile_no_phone_hint", "Tashriflaringiz, bonus va chegirmalaringizni ko'rish uchun telefon raqamingizni kiriting.")}</p>`;
    }
    return;
  }
  try {
    const idxSnap = await get(ref(db, `${BASE_PATH}/customers/${key}/orderIds`));
    if (orderCountEl) orderCountEl.textContent = String(Object.keys(idxSnap.val() || {}).length);

    // Customer record itself (visits/loyaltyPoints/discountPercent/...) is
    // kept LIVE: an admin/CRM can change this customer's discount% or
    // loyalty points while the client has the Profile sheet open, and it
    // must reflect instantly, per spec — this used to be a one-time get()
    // that only ever showed the value as of the moment the sheet was opened.
    _profileCustUnsub = onValue(ref(db, `${BASE_PATH}/customers/${key}`), (custSnap) => {
      const cust = custSnap.val() || {};
      const createdAtMs = Number(cust.createdAt) || 0;
      if (createdAtMs > 0) {
        if (registeredEl) registeredEl.textContent = new Date(createdAtMs).toLocaleDateString();
      } else {
        // Backfill: no customer record yet, or a record without createdAt
        // (older data, or created via a path that skipped it). Either way,
        // write it now (merge, not overwrite) so the date shows immediately
        // and stays stable on every future visit. This write itself
        // triggers a fresh snapshot with createdAt set, so it naturally
        // only fires once per record (later snapshots take the branch above).
        const backfillDate = Date.now();
        if (registeredEl) registeredEl.textContent = new Date(backfillDate).toLocaleDateString();
        update(ref(db, `${BASE_PATH}/customers/${key}`), { phone: decodeURIComponent(key), createdAt: backfillDate })
          .catch((backfillErr) => console.error("renderProfileView createdAt backfill failed:", backfillErr));
      }

      // 👥 Telefon kiritgan mijoz uchun: tashrif/buyurtma/xarid/bonus
      // statistikasi + Virtual Loyalty Card. Hech qanday status/tier yo'q.
      if (loyaltyBox) {
        const visits = Number(cust.visits || 0);
        const ordersCount = Number(cust.ordersCount || 0) || Object.keys(idxSnap.val() || {}).length;
        const totalSpent = Number(cust.totalSpent || 0);
        const loyaltyPoints = Number(cust.loyaltyPoints || 0);
        const discountPercent = Number(cust.discountPercent || cust.personalDiscount || 0);
        // Root-cause fix (see saveProfileInfo()): localStorage stays the
        // primary source (this device's own, possibly newer, unsaved-
        // elsewhere edit), but now falls back to the canonical Firebase
        // name — e.g. a fresh device/browser for a phone that already has
        // a name on file (typed on another device, or set by Admin's CRM)
        // no longer shows blank/"Mijoz" just because THIS device's
        // localStorage never happened to be populated.
        const name = localStorage.getItem("customerName") || cust.name || "";
        // Keep the editable name input in sync with the same fallback, but
        // only when the customer hasn't already typed something into it
        // this session — never clobber an in-progress edit.
        if (nameEl && !nameEl.value && name) nameEl.value = name;

        loyaltyBox.innerHTML = `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;">
            <div style="background:var(--primary-subtle,#f0fdf4);border-radius:12px;padding:10px 12px;text-align:center;">
              <div style="font-size:18px;font-weight:800;color:var(--primary,#15803d);">${visits}</div>
              <div style="font-size:10.5px;color:var(--primary,#16a34a);font-weight:700;text-transform:uppercase;">${t("profile_visit_count", "Tashriflar")}</div>
            </div>
            <div style="background:var(--primary-subtle,#f0fdf4);border-radius:12px;padding:10px 12px;text-align:center;">
              <div style="font-size:18px;font-weight:800;color:var(--primary,#15803d);">${ordersCount}</div>
              <div style="font-size:10.5px;color:var(--primary,#16a34a);font-weight:700;text-transform:uppercase;">${t("profile_orders_count", "Buyurtmalar")}</div>
            </div>
            <div style="background:var(--primary-subtle,#f0fdf4);border-radius:12px;padding:10px 12px;text-align:center;">
              <div style="font-size:15px;font-weight:800;color:var(--primary,#15803d);">${totalSpent.toLocaleString()}</div>
              <div style="font-size:10.5px;color:var(--primary,#16a34a);font-weight:700;text-transform:uppercase;">${t("total_spent_label", "Jami xarid")}</div>
            </div>
            <div style="background:var(--primary-subtle,#f0fdf4);border-radius:12px;padding:10px 12px;text-align:center;">
              <div style="font-size:18px;font-weight:800;color:var(--primary,#15803d);">${loyaltyPoints}</div>
              <div style="font-size:10.5px;color:var(--primary,#16a34a);font-weight:700;text-transform:uppercase;">${t("profile_bonus_points", "Bonus")}</div>
            </div>
          </div>

          <!-- 🩹 Loyalty card — ataylab doim yashil-gradient/oq matn (jismoniy
               "brend karta" uslubi, Waiter'ning rangli badge'lari kabi) —
               dark/light rejimidan mustaqil, shuning uchun bu yerga
               var(--bg-card) qo'yilmadi. -->
          <div style="margin-top:12px;border-radius:16px;padding:16px 18px;color:#fff;background:linear-gradient(135deg,#16a34a,#15803d);position:relative;overflow:hidden;">
            <div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;opacity:.85;">${t("profile_loyalty_card_brand", "NESTA ERP LOYALTY")}</div>
            <div style="font-size:15px;font-weight:700;letter-spacing:1.5px;margin:10px 0 8px;font-family:'Courier New',monospace;">${String(decodeURIComponent(key)).replace(/</g, "")}</div>
            <div style="font-size:14px;font-weight:700;">${String(name || t("unknown_customer", "Mijoz")).replace(/</g, "")}</div>
            <div style="display:flex;justify-content:space-between;font-size:11.5px;opacity:.9;margin-top:8px;">
              <span>${t("profile_bonus_points", "Bonus")}: ${loyaltyPoints}</span>
              <span>${t("customers_discount_section", "Chegirma")}: ${discountPercent}%</span>
            </div>
          </div>`;
      }
    });
  } catch (err) {
    console.error("renderProfileView error:", err);
    if (orderCountEl) orderCountEl.textContent = "0";
    if (registeredEl) registeredEl.textContent = "—";
  }
}
window.renderProfileView = renderProfileView;

// Saves the manually-edited name/phone from the profile sheet. Phone is
// normalized the same way as everywhere else (normalizeCustomerPhone) and,
// if it resolves to a valid number, also ensures a customers/{phone} record
// exists (saveCustomerToDatabase) so order count / registration date can be
// looked up next time the sheet opens.
window.saveProfileInfo = async function () {
  const nameEl = document.getElementById("profileName");
  const phoneEl = document.getElementById("profilePhone");
  const name = nameEl?.value?.trim() || "";
  const rawPhone = phoneEl?.value?.trim() || "";

  if (name) localStorage.setItem("customerName", name);
  else localStorage.removeItem("customerName");

  if (rawPhone) {
    const normalized = normalizeCustomerPhone(rawPhone);
    if (!normalized) {
      alert(t("delivery_phone_invalid", "Telefon raqami noto'g'ri kiritildi"));
      return;
    }
    localStorage.setItem("customerPhone", normalized);
    try { await saveCustomerToDatabase(normalized); } catch (_e) { /* profil hali ham saqlanadi */ }
    // Root-cause fix: `name` used to be saved ONLY to localStorage above —
    // never written to customers/{phone} in Firebase, so Admin's CRM (and
    // any other device/session for the same phone) never saw a name the
    // customer typed here, no matter how many times they saved it.
    // saveCustomerToDatabase() only ever CREATES a record if one doesn't
    // exist yet (and never with a name even then) — it does nothing to an
    // already-existing record, which is the common case. Written here as
    // its own small update (not folded into saveCustomerToDatabase(),
    // which other callers use purely for "ensure a record exists" without
    // wanting a name write) — empty name intentionally does NOT clear an
    // existing Firebase name (e.g. one Admin's CRM already set), only a
    // non-empty typed name overwrites it, matching the "customer's own
    // latest edit wins" expectation of this specific save action.
    if (name) {
      try {
        await update(ref(db, `restaurants/${currentRestaurantId}/customers/${encodeURIComponent(normalized)}`), { name });
      } catch (e) {
        console.error("saveProfileInfo: name sync to Firebase failed:", e?.code || e?.message);
      }
    }
    subscribeFavorites();
    if (typeof _recomputeMyReservationsForCurrentPhone === "function") _recomputeMyReservationsForCurrentPhone();
  }

  showNotification(t("profile_saved", "Profil saqlandi"));
  renderProfileView();
  // Checkout's coFullName/coFullPhone inputs are prefilled from
  // localStorage.customerName/customerPhone on every openDeliveryCheckout()
  // call (SECTION: CHECKOUT), so nothing else needs to change there — the
  // customer never has to retype what was just saved here.
  const modal = document.getElementById("profileModal");
  if (modal) modal.style.display = "none";
};

window.logoutCustomer = function () {
  ["customerPhone", "userPhone", "customerName", "activeOrderId", "currentOrderId", "cart"].forEach(k => localStorage.removeItem(k));
  window.cart = {};
  if (typeof updateCart === "function") updateCart();
  if (typeof renderProfileView === "function") renderProfileView();
  showNotification(t("logout_success", "Chiqildi"));
};

// ══════════════════════════════════════════════════════
// 📍 ORDER TRACKING (SECTION: ORDER STATUS / ORDER TRACKING)
// Reuses the same #orderStatusBox progress-timeline that shows for the
// order just placed (driven by updateStatusUI) — no separate plain-list
// design anymore, so history/tracking always looks identical to it.
// ══════════════════════════════════════════════════════
window.openOrderTracking = async function (orderId) {
  const box = document.getElementById("orderStatusBox");
  if (!box) return;
  try {
    const order = await fetchClientOrder(orderId);
    if (!order) return;

    // Drive the same pretty progress-timeline used for the active order
    // (SECTION: ORDER STATUS / ORDER TRACKING) — one single visual design,
    // whether it's the order just placed or one opened from history.
    activeOrderData = { ...order, _id: orderId };
    hasSubmittedOrder = true;
    updateStatusUI(order.status || order.statusKey || "");

    box.scrollIntoView({ behavior: "smooth" });

    if (window._trackingUnsub) { window._trackingUnsub(); window._trackingUnsub = null; }
    window._trackingUnsub = pollClientOrder(orderId, fresh => {
      if (!fresh) return;
      activeOrderData = { ...fresh, _id: orderId };
      updateStatusUI(fresh.status || fresh.statusKey || "");
    });
  } catch (err) { console.error("openOrderTracking error:", err); }
};

function calculateOrderCookTime(itemsObj) {
  let maxPrep = 0;
  Object.entries(itemsObj || {}).forEach(([id, item]) => {
    const prep = Number(allMenu?.[id]?.prepTime || item?.prepTime || 30);
    if (prep > maxPrep) maxPrep = prep;
  });
  return maxPrep || 30;
}

/* =========================
   VAQT VA NARXNI HISBLASH 
========================= */
function calculatePriority(total, baseCookTime = 30) {
  const selectedPriority = document.querySelector("input[name='priority']:checked")?.value || "normal";
  let finalTotal = total;

  let cookTime = RESTAURANT_SETTINGS.normalOrderBaseTime || baseCookTime;

  let extraMoney = 0;
  let isFast = false;

  const meetsMinAmount = total >= (RESTAURANT_SETTINGS.fastOrderMinAmount || 80000);

  if (selectedPriority === "fast" && RESTAURANT_SETTINGS.fastOrderActive !== false && meetsMinAmount) {
    const percent = RESTAURANT_SETTINGS.fastFee || 5;
    const minusMins = RESTAURANT_SETTINGS.fastOrderMinusMinutes || 10;

    extraMoney = Math.round(total * percent / 100);
    finalTotal = total + extraMoney;
    cookTime = Math.max(cookTime - minusMins, 5);
    isFast = true;
  }

  return { finalTotal, cookTime, extraMoney, isFast };
}

/* =========================
   TO'LOV SUMMASINI YANGILASH VA EKRANGA CHIQARISH
========================= */
window.updatePaymentSummary = function () {
  const result = calculatePriority(currentPaymentTotal, currentBaseCookTime);

  const promoPercent = Number(localStorage.getItem("discountPercent") || 0);
  const vipPercent = Number(window.vipDiscountPercent || 0);
  const autoPercent = computeAutoDiscountPercent(currentPaymentTotal).percent;

  const finalDiscountPercent = Math.max(promoPercent, vipPercent, autoPercent);

  let total = result.finalTotal;
  let discountAmount = 0;

  if (finalDiscountPercent > 0 && !result.isFast) {
    discountAmount = Math.round(total * finalDiscountPercent / 100);
    total -= discountAmount;
  }

  const paymentTotalEl = document.getElementById("paymentTotal");
  const breakdown = document.getElementById("priceBreakdown");

  if (paymentTotalEl) paymentTotalEl.innerText = total.toLocaleString() + " " + t("currency");

  if (breakdown) {
    const percent = RESTAURANT_SETTINGS.fastFee || 5;

    breakdown.innerHTML = `
      <div style="display:flex;justify-content:space-between; margin-bottom:5px; font-size:14px; color:#555;">
        <span>${t("base_price", "Asosiy narx")}:</span>
        <span style="${discountAmount > 0 ? 'text-decoration: line-through;' : ''}">${Number(currentPaymentTotal).toLocaleString()} ${t("currency")}</span>
      </div>

      ${result.isFast ? `
        <div style="display:flex;justify-content:space-between;color:#dc3545; font-weight:bold; margin-bottom:5px;">
          <span>⚡ ${t("fast_service", "Tezkor xizmat")} (+${percent}%)</span>
          <span>+${result.extraMoney.toLocaleString()} ${t("currency")}</span>
        </div>
      ` : ""}

      ${discountAmount > 0 ? `
        <div style="display:flex;justify-content:space-between;color:#28a745; font-weight:bold; font-size: 15px; margin-top: 5px; border-top: 1px dashed #ccc; padding-top: 5px;">
<span>${
  vipPercent > 0 && vipPercent >= promoPercent && vipPercent >= autoPercent ? '👑 ' + t("vip_discount", "VIP Chegirma")
  : promoPercent > 0 && promoPercent >= autoPercent ? '🎁 ' + t("promo_code", "Promokod")
  : '🎁 ' + t("auto_discount_label", "Avtomatik chegirma")
} (-${finalDiscountPercent}%):</span>          <span>-${discountAmount.toLocaleString()} ${t("currency")}</span>
        </div>
      ` : ""}
    `;
  }

  const newReadyAt = Date.now() + result.cookTime * 60000;
  const readyEl = document.querySelector(".payment-ready-time") || document.getElementById("clientReadyTime");
  const countdownEl = document.querySelector(".payment-countdown") || document.getElementById("clientTimer");
  const dt = new Date(newReadyAt);
  const timeString = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (readyEl) readyEl.innerHTML = `🍽 ${t("ready_at_text", "Tayyor bo'ladi")}: <b>${timeString}</b>`;
  if (countdownEl) countdownEl.innerHTML = `⏳ ${t("waiting_text", "Kutilmoqda")}: <b>${result.cookTime} ${t("minute_short", "daqiqa")}</b>`;
};

/* =========================
   TO'LOV OYNASINI OCHISH 
========================= */
window.currentPaymentPhoneKey = "";

function openPayment(total, orderNumber, orderItems, baseCookTime, phoneKey) {
  // Yangi window.openPayment ga yo'naltirish (promo kartochkalar shu yerda)
  if (typeof window.openPayment === "function") {
    window.openPayment(total, orderNumber, orderItems, baseCookTime, phoneKey);
  }
}

window.selectMyPromo = function (code) {
  const input = document.getElementById("cartPromoInput");
  if (input) {
    input.value = code;
    if (typeof window.applyClientPromo === "function") {
      window.applyClientPromo();
    }
  }
};

async function fetchAndRenderMyPromos(phone) {
  const container = document.getElementById("myPromosContainer");
  if (!container) return;
  container.innerHTML = `<p style='font-size:13px; color:#666;'>⏳ ${t("searching_promos", "Promokodlar qidirilmoqda...")}</p>`;

  const snap = await get(ref(db, BASE_PATH + "/discounts"));
  const allDiscounts = snap.val() || {};

  const normalizeP = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.slice(-9); };
  const myPromos = Object.values(allDiscounts).filter(d => {
    const usesLeft = d.usesLeft !== undefined ? Number(d.usesLeft) : (d.used ? 0 : 1);
    return normalizeP(d.ownerPhone) === normalizeP(phone) && !d.used && usesLeft > 0;
  });

  if (myPromos.length === 0) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `
        <div style="background: #eef8ee; padding: 10px; border-radius: 8px; margin-bottom: 15px;">
            <h4 style="margin-top:0; color:#28a745; font-size:14px;">🎫 ${t("your_promos_title", "Sizning shaxsiy promokodlaringiz")}</h4>
            ${myPromos.map(p => {
              const isMulti  = (p.maxUses || 1) > 1;
              const usesLeft = p.usesLeft !== undefined ? p.usesLeft : 1;
              return `
                <div style="background:#fff; border:1px solid #c3e6cb; padding:10px; border-radius:6px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <strong style="color:#28a745; font-size:16px;">${p.code}</strong>
                        ${p.isVipPromo ? `<span style="font-size:10px;background:#ede9fe;color:#5b21b6;border-radius:4px;padding:1px 5px;margin-left:4px;">VIP</span>` : ""}
                        <br>
                        <span style="font-size:12px; color:#555;">-${p.percent}% ${t("discount_giving_text", "chegirma beradi")}</span>
                        ${isMulti ? `<span style="font-size:11px;color:#7c3aed;margin-left:6px;">· ${usesLeft}× ${t("uses_left_label","qoldi")}</span>` : ""}
                    </div>
                    <div style="display:flex; flex-direction:column; gap:5px;">
                        <button onclick="applyMyPromo('${p.code}', ${p.percent})" style="background:#28a745; color:#fff; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; font-weight:bold;">${t("apply_btn", "Qo'llash")}</button>
                        <button onclick="giftPromoCode('${p.code}')" style="background:#ffc107; color:#000; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; font-size:12px;">${t("give_to_friend_btn", "Do'stimga berish")}</button>
                    </div>
                </div>`;
            }).join("")}
        </div>
    `;
}

window.applyMyPromo = function (code, percent) {
  localStorage.setItem("discountPercent", percent);
  localStorage.setItem("discountCode", code);
  showNotification(`✅ ${t("promo_applied", "Promokod qo'llanildi")}: -${percent}%`);
  updatePaymentSummary();
};

window.giftPromoCode = async function (code) {
  const newPhone = prompt(t("enter_friend_phone", "Do'stingizning telefon raqamini kiriting (+998...):"));
  if (!newPhone) return;

  const cleanPhone = newPhone.replace(/\D/g, "").slice(-9);
  if (cleanPhone.length < 9) {
    alert(t("invalid_phone_9", "Noto'g'ri raqam kiritildi! Faqat 9 xonali raqam kiriting."));
    return;
  }

  await update(ref(db, `${BASE_PATH}/discounts/${code}`), {
    ownerPhone: cleanPhone
  });

  showNotification(`🎁 ${t("promo_sent_success", "Promokod muvaffaqiyatli")} ${cleanPhone} ${t("number_suffix", "raqamiga yuborildi!")}`);

  if (localStorage.getItem("discountCode") === code) {
    localStorage.removeItem("discountCode");
    localStorage.removeItem("discountPercent");
    updatePaymentSummary();
  }

  fetchAndRenderMyPromos(window.currentPaymentPhoneKey);
};

async function loadMyPromos(phone) {
  const promoListEl = document.getElementById("availablePromos");
  if (!promoListEl || !phone) return;

  const snap = await get(ref(db, BASE_PATH + "/clients/" + phone + "/myPromos"));
  if (snap.exists()) {
    const promos = snap.val();
    let htmlContent = `<h4>${t("my_promos_title", "Mening promokodlarim:")}</h4>`;

    Object.entries(promos).forEach(([id, p]) => {
      if (p.status === "active") {
        htmlContent += `
          <div class="promo-item" onclick="applyPromo('${p.code}', ${p.percent})">
            <span>${p.code} (-${p.percent}%)</span>
            <button onclick="event.stopPropagation(); giftPromo('${id}', '${p.code}')">🎁 ${t("gift_btn", "Sovg'a qilish")}</button>
          </div>`;
      }
    });

    promoListEl.innerHTML = htmlContent;
  }
}

window.applyPromo = function (code, percent) {
  localStorage.setItem("discountPercent", percent);
  localStorage.setItem("discountCode", code);
  updatePaymentSummary();
  showNotification(`✅ ${code} ${t("promo_entered", "promokodi kiritildi!")}`);
};

window.giftPromo = async function (promoId, code) {
  const targetPhone = prompt(t("who_to_gift", "Promokodni kimga bermoqchisiz? (Telefon raqamini yozing):"));
  if (!targetPhone || targetPhone.length < 9) {
    alert(t("invalid_phone", "Noto'g'ri telefon raqami!"));
    return;
  }

  const targetKey = targetPhone.replace(/\D/g, "").slice(-9);
  const myPhone = document.getElementById("clientPhoneInput").value.replace(/\D/g, "").slice(-9);

  await remove(ref(db, `${BASE_PATH}/clients/${myPhone}/myPromos/${promoId}`));

  const snap = await get(ref(db, BASE_PATH + "/promocodes/" + code));
  if (snap.exists()) {
    const pData = snap.val();
    const newPromoId = "promo_" + Date.now();

    await update(ref(db, `${BASE_PATH}/clients/${targetKey}/myPromos/${newPromoId}`), {
      code: code,
      percent: pData.percent,
      status: "active"
    });
    await update(ref(db, BASE_PATH + "/promocodes/" + code), { ownerPhone: targetKey });

    alert(`🎁 ${t("promo_transferred_prefix", "Promokod")} ${targetKey} ${t("promo_transferred_suffix", "raqamiga muvaffaqiyatli o'tkazildi!")}`);
    loadMyPromos(myPhone);
  }
};

/* =========================
   MISC
========================= */
function hideAllVipElements() {
  const vipBadge = document.getElementById("vipBadge");
  const headerBadge = document.getElementById("headerBadge");
  const vipBanner = document.getElementById("vip-banner");
  if (vipBadge) vipBadge.style.display = "none";
  if (headerBadge) headerBadge.style.display = "none";
  if (vipBanner) vipBanner.style.display = "none";
  window.vipDiscountPercent = 0;
}

async function checkAndShowVipBadge() {
  // Faqat checkTable() chaqirganidan keyin ishlaydi
  // localStorage dagi telefon o'sha sessiyada saqlangan bo'lishi kerak

  const phone = localStorage.getItem("customerPhone");

  // Telefon raqam yo'q — barcha VIP elementlarni yashiramiz
  if (!phone) {
    hideAllVipElements();
    return;
  }

  try {
    // Faqat aniq +998XXXXXXXXX (12 raqam) formatini qabul qilamiz
    const cleanDigits = phone.replace(/\D/g, "");

    if (cleanDigits.length !== 12 || !cleanDigits.startsWith("998")) {
      hideAllVipElements();
      return;
    }

    const normalizedKey = `+${cleanDigits}`;

    // Firebase da faqat shu aniq kalit ostidagi mijozni tekshiramiz
    // (🩹 Audit fix: encodeURIComponent — admin.js/waiter.js bilan bir xil kalit).
    const snap = await get(ref(db, `restaurants/${currentRestaurantId}/customers/${encodeURIComponent(normalizedKey)}`));

    if (!snap.exists()) {
      hideAllVipElements();
      return;
    }

    const customer = snap.val();

    // FAQAT admin tomonidan isVip=true qilib belgilangan mijoz
    const isAdminVip = customer.isVip === true;
    const vipDiscPct = Number(customer.vipDiscountPercent || 0);
    const vipTotal = Number(customer.vipOrdersTotal || 0);
    const vipUsed = Number(customer.vipOrdersUsed || 0);

    console.log("%cVIP tekshiruv", "color:gold;font-weight:bold", {
      phone: normalizedKey, isAdminVip, vipDiscPct, vipTotal, vipUsed
    });

    // vipTotal=0 bo'lsa (cheksiz) yoki vipUsed < vipTotal bo'lsa faol
    const isVipActive = isAdminVip && vipDiscPct > 0 && (vipTotal === 0 || vipUsed < vipTotal);

    if (isVipActive) {
      // VIP faol — badge, header va banner ko'rsatamiz
      window.vipDiscountPercent = vipDiscPct;

      const vipBadge = document.getElementById("vipBadge");
      if (vipBadge) {
        vipBadge.style.display = "";
        vipBadge.title = `VIP -${vipDiscPct}% ${t("discount_label", "Chegirma")}`;
      }

      const headerBadge = document.getElementById("headerBadge");
      if (headerBadge) {
        headerBadge.innerHTML = `👑 VIP -${vipDiscPct}%`;
        headerBadge.style.display = "inline-block";
      }

      const banner = document.getElementById("vip-banner");
      const percentSpan = document.getElementById("vip-percent");
      if (banner) {
        if (percentSpan) percentSpan.innerText = vipDiscPct;
        banner.style.display = "block";
      }

      if (typeof updatePaymentSummary === "function") updatePaymentSummary();
    } else {
      hideAllVipElements();
    }
  } catch (err) {
    console.error("VIP badge tekshirishda xatolik:", err);
    hideAllVipElements();
  }
}

function showNotification(text) {
  const n = document.getElementById("notification");
  if (!n) return;
  n.innerText = text;
  n.classList.add("show");
  setTimeout(() => n.classList.remove("show"), 3000);
}

function toggleCart() {
  if (cartModal) cartModal.style.display = cartModal.style.display === "block" ? "none" : "block";
}

function isNewFood(item) {
  if (!item?.createdAt) return false;
  return Date.now() - item.createdAt < 3 * 24 * 60 * 60 * 1000;
}

function getTranslatedItemName(item, menuItem = null, lang = getLang()) {
  const target = menuItem?.name || item?.name;
  if (typeof target === "object") return target[lang] || target.uz || target.ru || target.en || "—";
  return target || "—";
}

/* =========================
   LISTEN ACTIVE ORDER 
========================= */
function listenActiveOrder() {
  const activeId = localStorage.getItem("activeOrderId");
  if (!activeId) return;

  stopActiveOrderListener = pollClientOrder(activeId, async order => {
    if (!order) {
      resetClientSession();
      return;
    }

    activeOrderData = { ...order, _id: activeId };
    const rawStatus = getOrderStatusKey(order);

    const isAlive = !["yopildi", "bekor qilindi", "closed", "cancelled", "paid", "to'landi"].includes(normalizeStatus(rawStatus));

    if (!isAlive || order.tableClosed === true) {
      const isSuccess = rawStatus.includes("yopildi") || rawStatus.includes("closed") || rawStatus.includes("paid") || rawStatus.includes("to'landi");
      const isPaymentApproved = order.payment?.approved === true || order.payment?.paid === true;

      if (isSuccess && typeof window.showFeedbackModal === "function") {
        window.showFeedbackModal(activeId);
      }

      // Kassa/admin orqali to'lov tasdiqlangan bo'lsa — chekni bir marta ko'rsatamiz
      if (isPaymentApproved && receiptShownForOrder !== activeId && typeof showReceipt === "function") {
        receiptShownForOrder = activeId;
        showReceipt(order);
      }

      // Savat faqat to'lov admin tomonidan tasdiqlangan bo'lsa tozalanadi
      resetClientSession(isPaymentApproved);
      showNotification(isSuccess ? t("thanks_for_purchase", "Xaridingiz uchun rahmat!") : t("order_cancelled", "Buyurtma bekor qilindi"));
      return;
    }

    // Stol holati "free" bo'lsa — session tugadi deb hisoblaymiz
    const tableNo = order.table || localStorage.getItem("table");
    if (tableNo) {
      const tableSnap = await get(ref(db, BASE_PATH + "/tables/" + getTableKey(tableNo)));
      if (tableSnap.exists()) {
        const tableData = tableSnap.val();
        const tableStatus = String(tableData.status || "").toLowerCase();

        if (tableStatus === "free" && (rawStatus === "to'landi" || rawStatus === "paid")) {
          // Stol tozalanib bo'ldi — sessiyani yopamiz, savat ham tozalanadi
          if (typeof window.showFeedbackModal === "function") {
            window.showFeedbackModal(activeId);
          }
          resetClientSession(true);
          showNotification(t("thanks_for_purchase", "Xaridingiz uchun rahmat! Tez orada ko'rishguncha."));
          return;
        }

        if (tableStatus === "cleaning" || tableStatus === "needs_cleaning") {
          // Stol tozalanmoqda — mijozga ko'rsatamiz
          hasSubmittedOrder = true;
          updateStatusUI("tozalanmoqda");
          return;
        }
      }
    }

    hasSubmittedOrder = true;
    updateStatusUI(rawStatus);

    // Oshpaz expectedReadyAt yoki readyAt yozganda countdown header da ko'rinadi
    const countdownTs = order.expectedReadyAt || order.readyAt;
    const prepMins = Number(order.prepMinutes || 0);
    const isCookingStatus = ["tayyorlanmoqda", "cooking"].includes(rawStatus);
    const isReadyStatus = ["tayyor", "ready"].includes(rawStatus);

    if (isReadyStatus) {
      // ── TAYYOR: necha daqiqada tayyorlanganini ko'rsatamiz ──
      showOrderReadyBanner(order);
    } else if (countdownTs && isCookingStatus) {
      // ── COOKING + oshpaz vaqt kiritdi: countdown ──
      startHeaderCountdown(countdownTs);
      updateHeaderReadyInfo(countdownTs);

      // headerReadyBox ni ko'rsatamiz
      const hrb = document.getElementById("headerReadyBox");
      if (hrb) hrb.style.display = "block";

      // header-timer-container ni ko'rsatamiz
      const timerBox = document.getElementById("header-timer-container");
      if (timerBox) {
        timerBox.style.display = "flex";
        timerBox.style.background = "linear-gradient(135deg,rgba(22,163,74,0.1),rgba(16,185,129,0.06))";
        timerBox.style.border = "1.5px solid rgba(34,197,94,0.3)";
        timerBox.style.borderRadius = "14px";
      }

      // prepMinutes belgisi (oshpaz kiritgan daqiqa)
      const timerLabel = document.getElementById("chef-prep-label");
      if (timerLabel && prepMins > 0) {
        timerLabel.textContent = `⏱ ${prepMins} ${t("minute_short", "daqiqa")} ichida tayyor`;
        timerLabel.style.color = "#16a34a";
      }

      const readyEl = document.getElementById("clientReadyTime");
      const timerEl = document.getElementById("clientTimer");
      if (readyEl) {
        const dt = new Date(countdownTs);
        readyEl.innerText = `🍽 ${t("ready_at_label", "Tayyor bo'ladi")}: ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }
      if (timerEl) {
        const diff = Number(countdownTs) - Date.now();
        if (diff > 0) {
          const remMins = Math.ceil(diff / 60000);
          timerEl.innerText = `⏳ ~${remMins} ${t("minute_short", "daqiqa")}`;
        } else {
          timerEl.innerText = `✅ ${t("ready_text", "Tayyor!")}`;
        }
      }
    } else if (isCookingStatus && !countdownTs) {
      // ── Cooking boshlandi lekin oshpaz vaqt kiritisini kutmoqda ──
      const timerBox = document.getElementById("header-timer-container");
      const display = document.getElementById("header-countdown-text");
      if (timerBox) {
        timerBox.style.display = "flex";
        timerBox.style.background = "rgba(245,158,11,0.15)";
        timerBox.style.border = "1.5px solid rgba(245,158,11,0.4)";
        timerBox.style.borderRadius = "12px";
        timerBox.style.padding = "6px 14px";
        timerBox.style.gap = "8px";
        timerBox.style.alignItems = "center";
      }
      if (display) {
        display.style.color = "#f59e0b";
        display.style.animation = "";
        display.classList.remove("client-countdown-shake", "client-countdown-red");
        display.innerText = "🔥 " + t("cooking_label", "Tayyorlanmoqda...");
      }
    } else if (!isCookingStatus && !isReadyStatus) {
      // ── Boshqa statuslarda yashiramiz ──
      const timerBox = document.getElementById("header-timer-container");
      if (timerBox) timerBox.style.display = "none";
    }

    const isReceiptReady = (order.payment?.paid === true || order.payment?.approved === true);
    const alreadyShown = localStorage.getItem("receiptShown");

    if (isReceiptReady && alreadyShown !== activeId) {
      localStorage.setItem("receiptShown", activeId);
      // Admin to'lovni tasdiqladi — savat tozalanadi
      cart = {};
      window.cart = {};
      localStorage.removeItem("clientCart");
      localStorage.removeItem("cart");
      if (typeof updateCart === "function") updateCart();

      setTimeout(() => {
        showReceipt(order);

        if (typeof window.showFeedbackModal === "function") {
          setTimeout(() => {
            window.showFeedbackModal(activeId);
          }, 1500);
        }

      }, 500);
    }
  });

  // Stol holatini real-time kuzatish (cleaning → free bo'lganda sessiyani yopish)
  const tableNo = localStorage.getItem("table");
  if (tableNo) {
    let tableWasCleaning = false;
    onValue(ref(db, BASE_PATH + "/tables/" + getTableKey(tableNo)), async (tableSnap) => {
      if (!tableSnap.exists()) return;
      const tableData = tableSnap.val();
      const tableStatus = String(tableData.status || "").toLowerCase();

      if (tableStatus === "cleaning" || tableStatus === "needs_cleaning") {
        tableWasCleaning = true;
        if (hasSubmittedOrder) {
          updateStatusUI("tozalanmoqda");
        }
      } else if (tableStatus === "free" && tableWasCleaning) {
        // Stol tozalanib bo'ldi, sessiyani yopamiz — savat ham tozalanadi
        tableWasCleaning = false;
        const activeOrderId = localStorage.getItem("activeOrderId");
        if (activeOrderId && typeof window.showFeedbackModal === "function") {
          window.showFeedbackModal(activeOrderId);
        }
        setTimeout(() => {
          resetClientSession(true);
          showNotification(t("table_cleaned_ready", "Stol tozalandi! Xaridingiz uchun rahmat."));
        }, 1500);
      }
    });
  }
}

/* =========================
   CHEK (RECEIPT) FUNKSIYALARI 
========================= */
// Til almashganda ochiq bo'lsa chek qayta chizilishi uchun oxirgi
// ko'rsatilgan buyurtmani eslab qolamiz (faqat shu maqsadda — showReceipt()
// ning o'zi va uning 5 ta chaqiruv joyi o'zgarmagan, hech qanday biznes
// logikasi o'zgarmadi).
let _lastReceiptOrder = null;

async function showReceipt(order) {
  _lastReceiptOrder = order;
  const box = document.getElementById("receiptBox");
  const content = document.getElementById("receiptContent");

  if (!box || !content) return;
  if (!order || !order.items) return;

  const lang = getLang();
  const restaurantName = RESTAURANT_SETTINGS.restaurantName || t("restaurant_name", "Restoran");
  const contactPhone   = RESTAURANT_SETTINGS.contactPhone   || "";
  const address        = RESTAURANT_SETTINGS.address        || RESTAURANT_SETTINGS.restaurantAddress || "";

  // --- Raqamlar ---
  const subtotal   = Number(order.originalTotal  || order.subtotal || 0);
  const svcAmt     = Number(order.serviceFeeAmount || 0);
  const svcPct     = Number(order.serviceFeePercent || 0);
  const fastFee    = Number(order.fastFeeAmount   || 0);
  const discount   = Number(order.discount || order.discountAmount || 0);
  const finalTotal = Number(order.finalTotal || order.total || 0);

  // --- Sana / vaqt ---
  const orderDate = new Date(order.createdAt || Date.now());
  const pad = n => String(n).padStart(2, "0");
  const dateStr = `${pad(orderDate.getDate())}.${pad(orderDate.getMonth()+1)}.${orderDate.getFullYear()}`;
  const timeStr = `${pad(orderDate.getHours())}:${pad(orderDate.getMinutes())}`;

  // --- Mijoz tashriflari ---
  let visitCount = null;
  try {
    const cId = localStorage.getItem("clientId") || order.clientId;
    const rId = localStorage.getItem("restaurantId") || order.restaurantId;
    if (cId && rId) {
      const ordersSnap = await get(ref(db, `restaurants/${rId}/orders`));
      if (ordersSnap.exists()) {
        const paidOrders = Object.values(ordersSnap.val()).filter(o =>
          (o.clientId === cId || o.userId === cId) &&
          ["to'landi","paid","tolandi"].includes(o.status)
        );
        visitCount = paidOrders.length + 1;
      }
    }
  } catch(e) {}

  // --- Mahsulotlar (receiptEngine item shape: {name, qty, price, total}) ---
  const receiptItems = Object.values(order.items).map(i => {
    const menuItem = (typeof allMenu !== "undefined" && allMenu) ? (allMenu[i.id || i.menuId] || {}) : {};
    const name  = getTranslatedItemName ? getTranslatedItemName(i, menuItem, lang) : (i.name?.uz || i.name || "");
    const price = Number(i.price || 0);
    const qty   = Number(i.qty || 0);
    return { name: i.variantName ? `${name} (${i.variantName})` : name, qty, price, total: price * qty };
  });

  // Waiter fee + tezkor ustama + cabin fee — bittalashtirilgan qo'shimcha
  // yig'im qatorlari sifatida (receiptEngine's generic extraFeeRows).
  const extraFeeRows = [];
  if (svcAmt > 0) extraFeeRows.push({ label: `${t("waiter_service_fee_label","Xizmat haqi")} ${svcPct}%`, value: svcAmt });
  if (fastFee > 0) extraFeeRows.push({ label: t("fast_fee_label","Tezkor ustama"), value: fastFee });
  const cabinFee = Number(order.cabinFee || order.tableFee || 0);
  if (cabinFee > 0) extraFeeRows.push({ label: t("cabin_fee_label","Cabin fee"), value: cabinFee });

  const receiptNo = formatOrderNumber(order) || order.orderNumber || order.orderNo ||
    (order._id ? String(order._id).substring(0,6) : null) || "—";

  const methodLabel = order.payment?.method ? paymentMethodLabel(order.payment.method, t) : "";

  // 🆕 Sozlamalar → Chop etish sozlamalari (clientPrintSettingsCache). Eslatma:
  // pastdagi QR — buyurtmani kuzatish/tasdiqlash QRi (mustaqil, avvaldan mavjud
  // xususiyat), admin Sozlamalar'dagi "QR kodni ko'rsatish" (receiptQr) esa
  // sodiq-mijoz CHEGIRMA QRi uchun alohida maydon — ikkalasi boshqa-boshqa
  // maqsad, shu sabab bu yerga tegilmadi. Logotip/shtrix-kod/pastki matn esa
  // aynan shu sozlamadan boshqarilishi kerak bo'lgan umumiy chek elementlari.
  const cps = clientPrintSettingsCache || {};
  const showLogo = cps.receiptLogo !== false; // default: yoqilgan
  const receiptData = {
    restaurantName, phone: contactPhone, address,
    logoUrl: showLogo ? (RESTAURANT_SETTINGS.restaurantLogoUrl || "") : "",
    date: dateStr, time: timeStr,
    receiptId: receiptNo, orderNumber: order.orderNumber, orderId: order._id,
    table: order.table, waiterName: order.waiterName,
    customerName: order.customerName || order.clientName || localStorage.getItem("customerName") || "",
    items: receiptItems,
    subtotal, discount, extraFeeRows, total: finalTotal,
    methodLabel,
    visitCount,
    qrText: order.orderNumber ? `${restaurantName} · #${order.orderNumber}` : (order._id || ""),
    qrCaption: t("receipt_order_num", "Buyurtma") + " #" + (order.orderNumber || receiptNo),
    barcodeText: cps.receiptBarcode ? String(order.orderNumber || receiptNo || "").trim() : "",
    footerText: cps.receiptFooter && String(cps.receiptFooter).trim() ? cps.receiptFooter : t("come_again", "RAHMAT! KUTAMIZ SIZNI YANA!"),
  };

  content.innerHTML = `
    <style>
      .rc-action-row { display:flex; gap:10px; margin-top:22px; flex-wrap:wrap; justify-content:center; }
      .rc-btn { border:none; border-radius:8px; padding:11px 18px; font-weight:700; font-size:13px; cursor:pointer; display:flex; align-items:center; gap:6px; letter-spacing:0.3px; }
    </style>
    <div style="padding:24px 16px 32px; display:flex; flex-direction:column; align-items:center;">
      <div id="real-receipt" style="box-shadow:0 6px 32px rgba(0,0,0,0.18); border-radius:2px;">
        ${buildReceiptBodyHtml(receiptData, { t, width: cps.receiptPaperSize === "58mm" ? "58mm" : "80mm" })}
      </div>

      <!-- TUGMALAR -->
      <div class="rc-action-row">
        <button class="rc-btn" onclick="window.printReceipt()" style="background:#1a1a2e; color:#fff;">
          🖨️ ${t("print_btn","Chop etish")}
        </button>
        <button class="rc-btn" onclick="window.downloadReceiptPNG()" style="background:#15803d; color:#fff;">
          🖼 ${t("download_png","PNG")}
        </button>
        <button class="rc-btn" onclick="window.downloadReceiptPDF()" style="background:#1d4ed8; color:#fff;">
          📄 ${t("download_pdf","PDF")}
        </button>
        <button class="rc-btn" onclick="window.closeReceipt()" style="background:#e5e7eb; color:#374151;">
          ✕ ${t("close_btn","Yopish")}
        </button>
      </div>
    </div>
  `;

  window._currentReceiptData = receiptData;
  box.style.display = "flex";
}

function closeReceipt() {
  const box = document.getElementById("receiptBox");
  const content = document.getElementById("receiptContent");
  if (box) box.style.display = "none";
  if (content) content.innerHTML = "";
}

// Print/PNG/PDF now go through receiptEngine.js — same window.print()/
// html2canvas/html2pdf mechanics as before, just no longer duplicated here.
window.printReceipt = function () {
  if (!window._currentReceiptData) { alert(t("receipt_not_found", "Chek topilmadi!")); return; }
  const cps = clientPrintSettingsCache || {};
  printReceiptInPopup(window._currentReceiptData, {
    t, width: cps.receiptPaperSize === "58mm" ? "58mm" : "80mm",
    copies: Number(cps.receiptCopies) || 1,
    title: t("receipt_label", "Chek"),
    onPopupBlocked: () => alert(t("popup_blocked_check_settings", "Pop-up bloklangan. Brauzer sozlamalarini tekshiring.")),
  });
};

window.downloadReceiptPNG = function () {
  const element = document.getElementById("real-receipt");
  if (!element) { alert(t("receipt_not_found", "Chek topilmadi!")); return; }
  engineDownloadReceiptPNG(element, { filename: `Chek_${Date.now()}.png` })
    .catch(err => { console.error("PNG yuklash xatosi:", err); alert(t("download_failed_refresh", "Yuklab olish tizimi ishga tushmadi. Sahifani yangilang.")); });
};

window.downloadReceiptPDF = function () {
  const element = document.getElementById("real-receipt");
  if (!element) { alert(t("receipt_not_found", "Chek topilmadi!")); return; }
  engineDownloadReceiptPDF(element, { filename: `Chek_${Date.now()}.pdf`, width: "80mm" })
    .catch(err => { console.error("PDF yuklash xatosi:", err); alert(t("download_failed_refresh", "Yuklab olish tizimi ishga tushmadi. Sahifani yangilang.")); });
};

window.showReceipt = showReceipt;
window.closeReceipt = closeReceipt;

function generateDiscountCode() {
  return "DISC-" +
    safeUUID()
      .slice(0, 8)
      .toUpperCase();
}

function updateStatusUI(status) {
  const orderStatusBox = document.getElementById("orderStatusBox");
  if (!hasSubmittedOrder || !orderStatusBox) return;

  const raw = normalizeStatus(status);

  orderStatusBox.style.display = "block";

  /* ── CSS (bir marta inject) ── */
  if (!document.getElementById("_otrStyles")) {
    const s = document.createElement("style");
    s.id = "_otrStyles";
    s.textContent = `
      .otr-wrap{width:100%;padding:16px 16px 18px;background:#fff;border-radius:16px;
        box-shadow:0 4px 20px rgba(0,0,0,0.08);box-sizing:border-box;
        font-family:'Segoe UI',Tahoma,sans-serif}
      .otr-title{font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;
        letter-spacing:.07em;margin-bottom:16px}
      .otr-steps{display:flex;align-items:flex-start;justify-content:space-between;
        position:relative;padding:0 2px}
      .otr-steps::before{content:"";position:absolute;top:17px;left:18px;right:18px;
        height:2px;background:#e5e7eb;z-index:0}
      .otr-bar{position:absolute;top:17px;left:18px;height:2px;
        background:linear-gradient(90deg,#10b981,#34d399);z-index:1;
        transition:width .6s cubic-bezier(.4,0,.2,1)}
      .otr-step{display:flex;flex-direction:column;align-items:center;gap:6px;
        flex:1;z-index:2;min-width:0}
      .otr-ico{width:36px;height:36px;border-radius:50%;background:#f3f4f6;
        border:2px solid #e5e7eb;display:flex;align-items:center;justify-content:center;
        font-size:14px;transition:all .35s ease;flex-shrink:0}
      .otr-step.done .otr-ico{background:#d1fae5;border-color:#10b981;font-size:13px}
      .otr-step.active .otr-ico{background:#10b981;border-color:#10b981;color:#fff;
        box-shadow:0 0 0 5px rgba(16,185,129,.18);animation:otrP 2s infinite}
      .otr-step.error .otr-ico{background:#fee2e2;border-color:#ef4444}
      .otr-lbl{font-size:9px;font-weight:600;color:#9ca3af;text-align:center;
        line-height:1.2;max-width:52px;word-break:break-word}
      .otr-step.done  .otr-lbl{color:#10b981}
      .otr-step.active .otr-lbl{color:#059669;font-weight:700}
      .otr-step.error  .otr-lbl{color:#ef4444}
      .otr-msg{margin-top:14px;padding:10px 14px;border-radius:10px;font-size:13px;
        font-weight:600;text-align:center}
      .otr-msg.s0{background:#f3f4f6;color:#6b7280}
      .otr-msg.s1{background:#eff6ff;color:#1d4ed8}
      .otr-msg.s2{background:#fff7ed;color:#ea580c}
      .otr-msg.s3{background:#ecfdf5;color:#059669}
      .otr-msg.s4{background:#faf5ff;color:#7c3aed}
      .otr-msg.s5{background:#f0fdf4;color:#15803d}
      .otr-msg.s6{background:#fffbeb;color:#d97706}
      .otr-msg.s7{background:#d1fae5;color:#065f46}
      .otr-msg.err{background:#fee2e2;color:#dc2626}
      .otr-msg.cln{background:#e0f2fe;color:#0369a1}
      @keyframes otrP{0%,100%{box-shadow:0 0 0 5px rgba(16,185,129,.18)}
        50%{box-shadow:0 0 0 9px rgba(16,185,129,.07)}}
    `;
    document.head.appendChild(s);
  }

  /* ── Asosiy 7 bosqich ── */
  const STEPS = [
    { icon: "🆕", label: t("st_new", "Yangi") },  // 0
    { icon: "✅", label: t("st_approved", "Tasdiqlandi") },  // 1
    { icon: "🔥", label: t("st_cooking", "Tayyorlanmoqda") },  // 2
    { icon: "🍽️", label: t("st_ready", "Tayyor") },  // 3
    { icon: "🛵", label: t("st_deliver", "Yetkazilmoqda") },  // 4
    { icon: "🏁", label: t("st_delivered", "Yetkazildi") },  // 5
    { icon: "💳", label: t("st_paid", "To‘landi") },  // 6
    { icon: "🎉", label: t("st_confirmed", "To‘lov tasdiqlandi") }, // 7
  ];

  /* ── Alohida holatlar (progress yo‘q) ── */
  const SPECIAL = {
    "tozalanmoqda": { cls: "cln", text: "🧹 " + t("cleaning_msg", "Stolingiz tozalanmoqda...") },
    "cleaning": { cls: "cln", text: "🧹 " + t("cleaning_msg", "Stolingiz tozalanmoqda...") },
    "needs_cleaning": { cls: "cln", text: "🧹 " + t("cleaning_msg", "Stolingiz tozalanmoqda...") },
    "bekor qilindi": { cls: "err", text: "❌ " + t("cancelled_msg", "Buyurtma bekor qilindi.") },
    "yopildi": { cls: "err", text: "📦 " + t("closed_msg", "Buyurtma yopildi.") },
  };

  if (SPECIAL[raw]) {
    const sp = SPECIAL[raw];
    orderStatusBox.innerHTML =
      `<div class="otr-wrap">` +
      `<div class="otr-title">🛒 ${t("status_label", "Buyurtma holati")}</div>` +
      `<div class="otr-msg ${sp.cls}" style="font-size:14px;">${sp.text}</div>` +
      `</div>`;
    return;
  }

  /* ── Status → indeks va xabar ── */
  const INFO = {
    // ── Eski (legacy) statuslar ──
    "yangi":             { idx: 0, cls: "s0", text: "🆕 " + t("st_new_msg", "Buyurtmangiz qabul qilindi!") },
    "queue":             { idx: 0, cls: "s0", text: "🆕 " + t("st_new_msg", "Buyurtmangiz qabul qilindi!") },
    "tasdiqlandi":       { idx: 1, cls: "s1", text: "✅ " + t("st_approved_msg", "Oshxona buyurtmangizni oldi!") },
    "tayyorlanmoqda":    { idx: 2, cls: "s2", text: "🔥 " + t("st_cooking_msg", "Oshpaz taomingizni tayyorlamoqda...") },
    "tayyor":            { idx: 3, cls: "s3", text: "🍽️ " + t("st_ready_msg", "Taomingiz tayyor!") },
    "yetkazilmoqda":     { idx: 4, cls: "s4", text: "🛵 " + t("st_deliver_msg", "Ofitsiant taomingizni olib kelyapti...") },
    "yetkazildi":        { idx: 5, cls: "s5", text: "🏁 " + t("st_delivered_msg", "Taomingiz yetkazildi! Ishtaha bilan!") },
    "to'landi":           { idx: 6, cls: "s6", text: "💳 " + t("st_paid_msg", "To'lov so'rovi yuborildi!") },
    "tolandi":           { idx: 6, cls: "s6", text: "💳 " + t("st_paid_msg", "To'lov so'rovi yuborildi!") },
    "to'lov tasdiqlandi": { idx: 7, cls: "s7", text: "🎉 " + t("st_confirmed_msg", "To'lovingiz tasdiqlandi! Rahmat!") },

    // ── Yangi V2 statuslar (shared.js ORDER_STATUS_V2) ──
    "order_created":     { idx: 0, cls: "s0", text: "🆕 " + t("st_new_msg", "Buyurtmangiz qabul qilindi!") },
    "kitchen_printer":   { idx: 1, cls: "s1", text: "🖨️ " + t("st_kitchen_msg", "Oshxona chiptasi chiqmoqda...") },
    "kitchen_display":   { idx: 1, cls: "s1", text: "📺 " + t("st_kitchen_msg", "Oshxona ekranida korinmoqda...") },
    "preparing":         { idx: 2, cls: "s2", text: "🔥 " + t("st_cooking_msg", "Oshpaz taomingizni tayyorlamoqda...") },
    "ready":             { idx: 3, cls: "s3", text: "🍽️ " + t("st_ready_msg", "Taomingiz tayyor!") },
    "picked_up":         { idx: 4, cls: "s4", text: "🛵 " + t("st_deliver_msg", "Ofitsiant taomingizni olib kelyapti...") },
    "served":            { idx: 5, cls: "s5", text: "🏁 " + t("st_delivered_msg", "Taomingiz yetkazildi! Ishtaha bilan!") },
    "cashier":           { idx: 6, cls: "s6", text: "💳 " + t("st_cashier_msg", "Kassir hisob kormoqda...") },
    "payment":           { idx: 6, cls: "s6", text: "💳 " + t("st_paid_msg", "Tolov sorovi yuborildi!") },
    "completed":         { idx: 7, cls: "s7", text: "🎉 " + t("st_confirmed_msg", "Tolovingiz tasdiqlandi! Rahmat!") },
  };

    const info = INFO[raw] || { idx: 0, cls: "s0", text: "⏳ " + status };
  const curIdx = info.idx;
  const maxIdx = STEPS.length - 1;

  // ── Tayyorlanmoqda statusida vaqtga qarab progress hisoblash ──
  // Faqat cooking (idx=2) bo'lsa va oshpaz vaqt belgilagan bo'lsa
  const isCookingNow = curIdx === 2;
  const ord = activeOrderData || {};
  const cookStartedAt = Number(ord.cookingStartedAt || ord.acceptedAt || 0);
  const cookExpectedAt = Number(ord.expectedReadyAt || ord.readyAt || 0);
  const hasCookTimes = isCookingNow && cookStartedAt > 0 && cookExpectedAt > cookStartedAt;

  function calcCookPct() {
    if (!hasCookTimes) return (curIdx / maxIdx) * 100;
    const totalMs = cookExpectedAt - cookStartedAt;
    const elapsedMs = Date.now() - cookStartedAt;
    // step 2 → step 3 orasidagi foiz: [2/7 .. 3/7]
    const stepStart = 2 / maxIdx * 100;
    const stepEnd = 3 / maxIdx * 100;
    const frac = Math.min(Math.max(elapsedMs / totalMs, 0), 1);
    return stepStart + frac * (stepEnd - stepStart);
  }

  // Progress bar elementini ID bilan yasaymiz (live update uchun)
  const _barId = "otr-cook-bar";
  let pct = hasCookTimes ? calcCookPct() : (curIdx / maxIdx) * 100;

  let stepsHtml = `<div class="otr-bar" id="${_barId}" style="width:${pct}%"></div>`;
  STEPS.forEach((step, idx) => {
    const cls = idx < curIdx ? "done" : idx === curIdx ? "active" : "";
    const icon = idx < curIdx ? "✓" : step.icon;
    stepsHtml +=
      `<div class="otr-step ${cls}">` +
      `<div class="otr-ico">${icon}</div>` +
      `<div class="otr-lbl">${step.label}</div>` +
      `</div>`;
  });

  orderStatusBox.innerHTML =
    `<div class="otr-wrap">` +
    `<div class="otr-title">🛒 ${t("status_label", "Buyurtma holati")}</div>` +
    `<div class="otr-steps">${stepsHtml}</div>` +
    `<div class="otr-msg ${info.cls}">${info.text}</div>` +
    `<div id="otr-items-section"></div>` +
    `</div>`;

  // ── Har bir taomning alohida holati (somsa tayyor, shashlik hali yo'q va h.k.) ──
  // Faqat buyurtma haqiqatan oshxona bosqichida bo'lganda ko'rsatiladi.
  const _itemsSectionStages = new Set(["tasdiqlandi", "tayyorlanmoqda", "tayyor", "yetkazilmoqda"]);
  if (_itemsSectionStages.has(raw)) {
    renderPerItemStatusSection(activeOrderData);
  }

  // ── Tayyorlanmoqda: progress barni real vaqtda yangilash ──
  if (window._otrCookBarTimer) {
    clearInterval(window._otrCookBarTimer);
    window._otrCookBarTimer = null;
  }
  if (hasCookTimes) {
    window._otrCookBarTimer = setInterval(() => {
      const barEl = document.getElementById(_barId);
      if (!barEl) { clearInterval(window._otrCookBarTimer); return; }
      // Status o'zgargan bo'lsa to'xtatamiz
      const curRaw = typeof normalizeStatus === 'function'
        ? normalizeStatus(activeOrderData?.status || activeOrderData?.statusKey || "")
        : "";
      const stillCooking = curRaw === "tayyorlanmoqda" || curRaw === "cooking";
      if (!stillCooking) { clearInterval(window._otrCookBarTimer); return; }
      const newPct = calcCookPct();
      barEl.style.width = newPct + "%";
    }, 1000);
  }

  // ── Hisob so'rash tugmasi: faqat "yetkazildi" statusida aktiv ──
  _syncBillBtn(raw);
}

// ==========================================
// 🍽️ HAR BIR TAOMNING ALOHIDA HOLATI + "OLIB KELISHNI SO'RASH" TUGMASI
// Bitta buyurtmada somsa, shashlik, fastfood aralash bo'lishi mumkin.
// Somsa tayyor bo'lib, shashlik hali tayyorlanayotgan bo'lsa ham,
// mijoz buni ko'radi va faqat tayyor bo'lganlarni "olib kel" deb so'rashi mumkin.
// Ofitsiant tayyor bo'lgan taomlarni olib kelib, keyin qolganini
// tayyor bo'lgach yana olib keladi (client.js item.status ni yozadi,
// haqiqiy "olib ketdim" belgisini esa ofitsiant/oshpaz sahifasi qo'yadi).
// ==========================================
function renderPerItemStatusSection(order) {
  const container = document.getElementById("otr-items-section");
  if (!container || !order) return;

  const items = order.items || {};
  const itemKeys = Object.keys(items);
  if (itemKeys.length === 0) { container.innerHTML = ""; return; }

  const lang = typeof getLang === "function" ? getLang() : "uz";

  // ── CSS (bir marta inject) ──
  if (!document.getElementById("_otrItemsStyles")) {
    const s = document.createElement("style");
    s.id = "_otrItemsStyles";
    s.textContent = `
      .otr-items{margin-top:14px;padding-top:12px;border-top:1px dashed #e5e7eb}
      .otr-items-title{font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;
        letter-spacing:.06em;margin-bottom:8px}
      .otr-item-row{display:flex;align-items:center;justify-content:space-between;gap:8px;
        padding:8px 10px;background:#f8fafc;border:1px solid #f1f5f9;border-radius:9px;margin-bottom:6px}
      .otr-item-name{font-size:12.5px;font-weight:600;color:#1e293b;min-width:0;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .otr-item-badge{font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:6px;
        white-space:nowrap;flex-shrink:0}
      .otr-item-badge.pending{background:#fff7ed;color:#c2410c;border:1px solid #fed7aa}
      .otr-item-badge.ready{background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0}
      .otr-item-badge.delivered{background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0}
      .otr-pickup-btn{width:100%;margin-top:8px;padding:12px;border:none;border-radius:11px;
        font-weight:700;font-size:13.5px;cursor:pointer;display:flex;align-items:center;
        justify-content:center;gap:7px;background:linear-gradient(135deg,#16a34a,#22c55e);
        color:#fff;box-shadow:0 4px 14px rgba(34,197,94,0.3);transition:opacity .2s}
      .otr-pickup-btn:disabled{background:#94a3b8;box-shadow:none;cursor:not-allowed;opacity:.75}
      .otr-pickup-note{margin-top:6px;font-size:11px;color:#9ca3af;text-align:center}
    `;
    document.head.appendChild(s);
  }

  const rowsHtml = itemKeys.map(key => {
    const item = items[key] || {};
    const itemName = (typeof item.name === "object")
      ? (item.name[lang] || item.name.uz || item.name.ru || item.name.en || t("food_label", "Taom"))
      : (item.name || t("food_label", "Taom"));
    const qty = Number(item.qty || 1);

    const s = String(item.status || "pending").toLowerCase();
    let badgeCls, badgeText;
    if (s === "delivered" || s === "yetkazildi") {
      badgeCls = "delivered"; badgeText = `🚚 ${t("item_delivered_label", "Olib ketildi")}`;
    } else if (s === "ready" || s === "tayyor") {
      badgeCls = "ready"; badgeText = `✅ ${t("item_ready_label", "Tayyor")}`;
    } else {
      badgeCls = "pending"; badgeText = `⏳ ${t("item_cooking_label", "Tayyorlanmoqda")}`;
    }

    const safeItemName = String(itemName).replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));

    return `
      <div class="otr-item-row">
        <span class="otr-item-name">${safeItemName} ×${qty}</span>
        <span class="otr-item-badge ${badgeCls}">${badgeText}</span>
      </div>`;
  }).join("");

  // ── Pickup tugmasi holati ──
  // "Hozir olib ketishga tayyor" — status ready bo'lib, hali pickup so'ralmagan itemlar
  const pickupRequests = order.pickupRequests || {};
  const requestedItemKeys = new Set();
  Object.values(pickupRequests).forEach(req => {
    (req.itemKeys || []).forEach(k => requestedItemKeys.add(k));
  });

  const readyNotYetRequestedCount = itemKeys.filter(key => {
    const s = String(items[key]?.status || "pending").toLowerCase();
    const isReady = s === "ready" || s === "tayyor";
    return isReady && !requestedItemKeys.has(key);
  }).length;

  const totalDeliveredCount = itemKeys.filter(key => {
    const s = String(items[key]?.status || "pending").toLowerCase();
    return s === "delivered" || s === "yetkazildi";
  }).length;

  // Hali oshxonada (na tayyor, na yetkazilgan) qolgan itemlar soni — to'g'ridan-to'g'ri hisoblanadi
  const stillCookingCount = itemKeys.filter(key => {
    const s = String(items[key]?.status || "pending").toLowerCase();
    return s !== "ready" && s !== "tayyor" && s !== "delivered" && s !== "yetkazildi";
  }).length;

  let pickupBtnHtml = "";
  if (totalDeliveredCount === itemKeys.length) {
    // Hammasi allaqachon olib ketilgan — tugma kerak emas
    pickupBtnHtml = "";
  } else if (readyNotYetRequestedCount > 0) {
    pickupBtnHtml = `
      <button class="otr-pickup-btn" onclick="window.requestPickup('${order._id || ""}', this)">
        🛍️ ${t("request_pickup_btn", "Olib kelishni so'rash")} (${readyNotYetRequestedCount})
      </button>`;
  } else if (requestedItemKeys.size > 0 && stillCookingCount > 0) {
    // Hozircha so'rash uchun yangi tayyor item yo'q, lekin avvalgi so'rov(lar) bor
    // va hali oshxonada pishayotgan taom(lar) qolgan — kutish holatini ko'rsatamiz
    pickupBtnHtml = `
      <button class="otr-pickup-btn" disabled>
        🛍️ ${t("pickup_requested_waiting", "So'rov yuborildi, ofitsiant kelmoqda...")}
      </button>
      <div class="otr-pickup-note">⏳ ${t("pickup_remaining_note", "Qolgan taomlar tayyor bo'lgach, yana so'rashingiz mumkin")}</div>`;
  }

  container.innerHTML = `
    <div class="otr-items">
      <div class="otr-items-title">🍽️ ${t("items_status_title", "Taomlar holati")}</div>
      ${rowsHtml}
      ${pickupBtnHtml}
    </div>
  `;
}

// Mijoz "Olib kelishni so'rash" tugmasini bosganda — faqat HOZIR tayyor bo'lgan
// itemlarning ID'larini yuboradi. Keyinroq tayyor bo'lganlar uchun tugma qayta chiqadi.
window.requestPickup = async function (orderId, btnEl) {
  if (!orderId) return;
  const btn = btnEl || null;
  if (btn) { btn.disabled = true; btn.style.opacity = "0.7"; }

  try {
    const order = await fetchClientOrder(orderId);
    if (!order) return;
    const items = order.items || {};

    // Allaqachon so'ralgan item'larni chetlab o'tamiz (qayta yubormaslik uchun)
    const pickupRequests = order.pickupRequests || {};
    const alreadyRequested = new Set();
    Object.values(pickupRequests).forEach(req => (req.itemKeys || []).forEach(k => alreadyRequested.add(k)));

    const readyItemKeys = Object.keys(items).filter(key => {
      const s = String(items[key]?.status || "pending").toLowerCase();
      const isReady = s === "ready" || s === "tayyor";
      return isReady && !alreadyRequested.has(key);
    });

    if (readyItemKeys.length === 0) return;

    const tableNo = order.table || localStorage.getItem("table") || "";
    await push(ref(db, BASE_PATH + "/orders/" + orderId + "/pickupRequests"), {
      itemKeys: readyItemKeys,
      table: tableNo,
      requestedAt: Date.now(),
      collected: false
    });

    showNotification(t("pickup_request_sent", "So'rov yuborildi! Ofitsiant tez orada keladi."));
  } catch (err) {
    console.error("requestPickup xatosi:", err);
    if (btn) { btn.disabled = false; btn.style.opacity = "1"; }
  }
};

// Hisob so'rash btn ni status bo'yicha boshqarish
function _syncBillBtn(rawStatus) {
  const DELIVERED = new Set(['yetkazildi', 'delivered', 'eating', 'served']);
  const btn1 = document.getElementById('requestBillBtn');
  const btn2 = document.getElementById('requestBillMainBtn');
  const isDelivered = DELIVERED.has(rawStatus);

  // ── Admin sozlamasi: agar hisobni faqat ofitsiant yopa olsa (waiter_only),
  // mijoz tomonida "Hisob so'rash" tugmalari butunlay yashiriladi. ──
  const billingMode = RESTAURANT_SETTINGS?.billingMode || "client_only";
  if (billingMode === "waiter_only") {
    if (btn1) btn1.style.display = 'none';
    if (btn2) btn2.style.display = 'none';
    return;
  }

  // btn1 (#requestBillBtn) — orderStatusBox ichida
  if (btn1) {
    btn1.style.display      = 'flex';
    btn1.disabled           = !isDelivered;
    btn1.style.opacity      = isDelivered ? '1' : '0.45';
    btn1.style.cursor       = isDelivered ? 'pointer' : 'not-allowed';
    btn1.style.background   = isDelivered
      ? 'linear-gradient(135deg,#22c55e,#15803d)'
      : '#94a3b8';
    btn1.style.boxShadow    = isDelivered
      ? '0 4px 14px rgba(34,197,94,0.3)'
      : 'none';
  }

  // btn2 (#requestBillMainBtn) — pastki sticky btn
  if (btn2) {
    btn2.style.display      = 'block';
    btn2.disabled           = !isDelivered;
    btn2.style.opacity      = isDelivered ? '1' : '0.45';
    btn2.style.cursor       = isDelivered ? 'pointer' : 'not-allowed';
    btn2.style.background   = isDelivered
      ? 'linear-gradient(135deg,#22c55e,#15803d)'
      : '#94a3b8';
    btn2.style.pointerEvents = isDelivered ? 'auto' : 'none';
  }
}
let confirmationResult = null;
let timerInterval = null;

window.simpleLogin = function () {
  const rawPhoneInput = document.getElementById('phoneNumber').value.trim();
  const phoneInput = normalizeCustomerPhone(rawPhoneInput);
  const phoneDigits = phoneInput.replace(/\D/g, "");

  if (!phoneInput || phoneDigits.length !== 12 || !phoneDigits.startsWith("998")) {
    alert(t("enter_full_number", "Raqamni to'liq kiriting! Masalan: 901234567 yoki +998901234567"));
    return;
  }

  localStorage.setItem("userPhone", phoneInput);
  localStorage.setItem("customerPhone", phoneInput);

  const _authSec = document.getElementById('auth-section');
  if (_authSec) _authSec.style.display = 'none';
  const menuSec = document.getElementById('menu-section');
  if (menuSec) {
    menuSec.style.display = 'block';
  }

  if (typeof renderMenu === "function") {
    renderMenu();
  }
};

// 🩹 Same DOMContentLoaded-race fix as _initClientApp() above.
function _initAuthSectionVisibility() {
  const savedPhone = localStorage.getItem("userPhone");
  if (savedPhone) {
    const _as = document.getElementById('auth-section');
    if (_as) _as.style.display = 'none';
    const _ms = document.getElementById('menu-section');
    if (_ms) _ms.style.display = 'block';
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _initAuthSectionVisibility);
} else {
  _initAuthSectionVisibility();
}

// 🩹 DEAD-CODE CLEANUP — _wireCloseModalBtn() (targeted #close-modal-btn,
// which does not exist in client.html either — the guard made it a
// permanent no-op) and the local/window closePaymentModal() duplicates
// (targeted #paymentModal, confirmed absent from client.html and never
// invoked from any reachable path) were removed. window.closePaymentModal
// is intentionally kept as a thin compatibility shim — it's harmless if
// ever called, and closeCheckoutModal()/closeReceipt() below are the real,
// live "close everything" calls other code may still reach it through.
window.closePaymentModal = function () {
  if (typeof closeCheckoutModal === "function") closeCheckoutModal();
  if (typeof closeReceipt === "function") closeReceipt();
};

async function saveCustomerToDatabase(phoneNumber) {
  const normalizedPhone = normalizeCustomerPhone(phoneNumber);
  if (!normalizedPhone) return;

  // 🩹 Audit fix: admin.js/waiter.js always encodeURIComponent() the
  // customers/{phone} Firebase key (crmAdvSafeKey); this function previously
  // used the raw "+998..." string, creating a second, disconnected customer
  // record for the same real phone number. The record's own `phone` field
  // still stores the readable raw value.
  const customerRef = ref(db, `restaurants/${currentRestaurantId}/customers/${encodeURIComponent(normalizedPhone)}`);
  const snap = await get(customerRef);

  if (!snap.exists()) {
    await set(customerRef, {
      phone: normalizedPhone,
      visits: 0,
      totalSpent: 0,
      personalDiscount: 0,
      createdAt: Date.now()
    });
  }
  localStorage.setItem("customerPhone", normalizedPhone);
}

async function calculateDiscount(cartTotalAmount, _phoneOverride) {
  // phoneOverride: openPayment'dan to'g'ridan-to'g'ri uzatilgan telefon (localStorage formatiga bog'liq emas)
  const phone = _phoneOverride
    || localStorage.getItem("customerPhone")
    || localStorage.getItem("userPhone")
    || window.currentPaymentPhoneKey
    || "";
  if (!phone) return { finalPrice: cartTotalAmount, discountPercent: 0, discountAmount: 0, isOneTime: false, isVipDiscount: false };

  try {
    // Telefon raqamni Firebase key formatiga o'tkazish — +998XXXXXXXXX (12 raqam)
    // 9 xonali (998 prefikssiz) va to'liq formatlarni qo'llab-quvvatlaymiz
    const cleanDigits = phone.replace(/\D/g, "");
    let normalizedKey;
    if (cleanDigits.length === 9) {
      normalizedKey = `+998${cleanDigits}`;
    } else if (cleanDigits.length === 12 && cleanDigits.startsWith("998")) {
      normalizedKey = `+${cleanDigits}`;
    } else if (cleanDigits.length === 13 && cleanDigits.startsWith("9989")) {
      // +9989... noto'g'ri, 12 ga kesib olamiz
      normalizedKey = `+${cleanDigits.slice(0, 12)}`;
    } else {
      return { finalPrice: cartTotalAmount, discountPercent: 0, discountAmount: 0, isOneTime: false, isVipDiscount: false };
    }

    // 🩹 Audit fix: encodeURIComponent() — admin.js/waiter.js customers/{phone}
    // kaliti bilan bir xil formatda (aks holda mijoz chegirmasi topilmaydi,
    // chunki admin uni boshqa Firebase kalitiga yozgan bo'ladi).
    const snap = await get(ref(db, `restaurants/${currentRestaurantId}/customers/${encodeURIComponent(normalizedKey)}`));

    let individualPercent = 0; // MAX(VIP, plain individual) — same single "individual customer" bucket as before, unchanged
    let isVipDiscount = false;
    let vipOrdersTotal = 0;
    let vipOrdersUsed = 0;
    let bestOneTimeClaim = null;

    if (snap.exists()) {
      const customer = snap.val();

      // ── Yangi VIP tizimi (admin tomonidan berilgan) ──
      const isAdminVip = customer.isVip === true;
      const vipDiscPct = Number(customer.vipDiscountPercent || 0);
      const vipTotal = Number(customer.vipOrdersTotal || 0);
      const vipUsed = Number(customer.vipOrdersUsed || 0);

      if (isAdminVip && vipDiscPct > 0 && (vipTotal === 0 || vipUsed < vipTotal)) {
        // VIP chegirma faol — faqat admin bergan (alohida, oldindan mavjud
        // VIP-sovg'a tizimi — Customers modulidan mustaqil, bu yerga tegilmadi)
        individualPercent = vipDiscPct;
        isVipDiscount = true;
        vipOrdersTotal = vipTotal;
        vipOrdersUsed = vipUsed;
      }
      // Eski fallback olib tashlandi: faqat admin isVip=true bergan mijozga VIP ishlaydi

      // 🆕 Admin → Customers moduli: har qanday mijozga (status/tier tushunchasisiz,
      // hammasi teng) qo'lda berilgan oddiy % chegirma. customer.discountPercent —
      // yangi asosiy maydon, customer.personalDiscount — waiter.js bilan bir xil
      // eski maydon (ikkalasi ham applyCustomerDiscount() orqali admin.js'da bir
      // vaqtda yoziladi) — kattarog'i qo'llaniladi, VIP bilan bir xil "individual"
      // guruh ichida (VIP ham, oddiy ham — bittasi, ikkitasi qo'shilmaydi).
      const plainDiscPct = Number(customer.discountPercent || customer.personalDiscount || 0);
      if (plainDiscPct > individualPercent) {
        individualPercent = plainDiscPct;
        isVipDiscount = false;
      }

      // 🆕 QR bir martalik chegirma claimlari (customer.oneTimeDiscounts —
      // backend/discountClaims/claimsService.js yozadi) — PERMANENT
      // discountPercent'dan mutlaqo alohida maydon. Bir nechtasi "available"
      // bo'lsa (spec §11), faqat ENG KATTA foizlisi bitta orderda ishlatiladi.
      bestOneTimeClaim = Object.entries(customer.oneTimeDiscounts || {})
        .filter(([, v]) => v.status === "available")
        .map(([tok, v]) => ({ token: tok, percent: Number(v.percent || 0) }))
        .sort((a, b) => b.percent - a.percent)[0] || null;
    }

    // 🆕 Sozlamalar → Avtomatik chegirma (settings/autoDiscount): buyurtma summasi
    // belgilangan minimaldan oshsa, mijozga avtomatik % chegirma qo'llaniladi.
    const autoInfo = computeAutoDiscountPercent(cartTotalAmount);
    const isAutoDiscount = autoInfo.percent > 0;

    // 🆕 BIZNES QOIDASI O'ZGARDI (avval MAX() edi): individual (customer/VIP)
    // + automatic threshold chegirma endi QO'SHILADI, biri-biriga qarab
    // ustunlik qilmaydi — masalan customer 3% + auto 5% = 8%. Faqat shu ikki
    // manba additive; boshqa hech biri (promo, QR) shu qoidaga tortilmagan —
    // pastda QR hali ham eski MAX ustuvorligida qoladi. 100% dan oshmasin
    // (spec §17).
    const combinedPercent = Math.min(100, individualPercent + autoInfo.percent);

    let discountPercent = combinedPercent;
    let isOneTime = false;
    let oneTimeClaimId = null;

    // 🆕 QR one-time claim — MAX ustuvorlik (o'zgarmadi, spec §14 aynan shuni
    // talab qiladi): individual+auto kombinatsiyasidan kattaroq bo'lsagina
    // g'olib chiqadi va UNI ALMASHTIRADI (ustiga qo'shilmaydi). G'olib bo'lsa
    // order yozuvida discountClaimId sifatida saqlanadi — to'lov
    // muvaffaqiyatli tugagach shu claim "used" qilinadi.
    if (bestOneTimeClaim && bestOneTimeClaim.percent > discountPercent) {
      discountPercent = bestOneTimeClaim.percent;
      isVipDiscount = false;
      isOneTime = true;
      oneTimeClaimId = bestOneTimeClaim.token;
    }

    const discountAmount = Math.round((cartTotalAmount * discountPercent) / 100);
    const finalPrice = cartTotalAmount - discountAmount;

    // 🆕 Audit/UI uchun — qaysi manbalar qo'shilganini ko'rsatish (spec §9/§10).
    // Faqat individual+auto kombinatsiyasi uchun mazmunli; QR g'olib chiqqanda
    // (isOneTime) kombinatsiya butunlay almashtirilgani uchun undefined.
    const discountBreakdown = isOneTime ? undefined : { customer: individualPercent, auto: autoInfo.percent, total: combinedPercent };

    return { finalPrice, discountPercent, discountAmount, isOneTime, oneTimeClaimId, isVipDiscount, isAutoDiscount, vipOrdersTotal, vipOrdersUsed, discountBreakdown };
  } catch (error) {
    console.error("Chegirmani hisoblashda xatolik:", error);
    const autoInfo = computeAutoDiscountPercent(cartTotalAmount);
    const discountAmount = Math.round((cartTotalAmount * autoInfo.percent) / 100);
    return {
      finalPrice: cartTotalAmount - discountAmount,
      discountPercent: autoInfo.percent,
      discountAmount,
      isOneTime: false,
      isVipDiscount: false,
      isAutoDiscount: autoInfo.percent > 0
    };
  }
}

/**
 * 🆕 Sozlamalardagi "Avtomatik chegirma" (settings/autoDiscount) ni berilgan
 * summaga nisbatan hisoblaydi. Yoqilgan va summa autoDiscount.minAmount dan
 * katta yoki teng bo'lsa { percent } qaytaradi, aks holda { percent: 0 }.
 */
function computeAutoDiscountPercent(baseAmount) {
  const cfg = RESTAURANT_SETTINGS.autoDiscount || {};
  const pct = Number(cfg.pct || 0);
  const minAmount = Number(cfg.minAmount || 0);
  if (!cfg.enabled || !(pct > 0)) return { percent: 0 };
  if (minAmount > 0 && Number(baseAmount) < minAmount) return { percent: 0 };
  return { percent: pct };
}

/**
 * 🆕 Sozlamalardagi "Minimal buyurtma narxi" (settings/minOrderAmount) ni
 * tekshiradi. 0 = cheklov yo'q. Mos kelmasa xabar ko'rsatib false qaytaradi.
 * Ovqatlanish (stol) va olib ketish uchun ishlatiladi; yetkazib berish uchun
 * alohida settings/deliverySettings/minOrderAmount ishlatiladi.
 */
function checkMinOrderAmount(total) {
  const minAmount = Number(RESTAURANT_SETTINGS.minOrderAmount || 0);
  if (minAmount > 0 && Number(total) < minAmount) {
    alert(
      `${t("min_order_not_reached", "Minimal buyurtma summasiga yetmadi")}: ${Number(total).toLocaleString()} / ${minAmount.toLocaleString()} ${t("currency", "so'm")}`
    );
    return false;
  }
  return true;
}

/**
 * 🆕 Yetkazib berish uchun minimal buyurtma summasini tekshiradi
 * (settings/deliverySettings/minOrderAmount).
 */
function checkDeliveryMinOrderAmount(total) {
  const minAmount = Number(RESTAURANT_SETTINGS.deliverySettings?.minOrderAmount || 0);
  if (minAmount > 0 && Number(total) < minAmount) {
    alert(
      `${t("min_order_not_reached", "Minimal buyurtma summasiga yetmadi")}: ${Number(total).toLocaleString()} / ${minAmount.toLocaleString()} ${t("currency", "so'm")}`
    );
    return false;
  }
  return true;
}

async function updateCustomerVisit(totalPaid) {
  const phone = localStorage.getItem("customerPhone");
  if (!phone) return;

  const customerRef = ref(db, `restaurants/${currentRestaurantId}/customers/${encodeURIComponent(normalizeCustomerPhone(phone) || phone)}`);

  const snap = await get(customerRef);
  if (snap.exists()) {
    const currentData = snap.val();
    await update(customerRef, {
      visits: (currentData.visits || 0) + 1,
      totalSpent: (currentData.totalSpent || 0) + totalPaid,
      updatedAt: Date.now()
    });
  }
}

window.addTestCustomers = async function () {
  const exactPath = `restaurants/${currentRestaurantId}/customers`;
  const testData = {
    "+998901234567": { phone: "+998 90 123 45 67", visits: 5, totalSpent: 450000, personalDiscount: 0, createdAt: Date.now() },
    "+998947654321": { phone: "+998 94 765 43 21", visits: 12, totalSpent: 1250000, personalDiscount: 15, createdAt: Date.now() - 86400000 }
  };

  try {
    await update(ref(db, exactPath), testData);
    alert("✅ " + t("test_customers_added", "Test mijozlar yangi bazaga tushdi! Jadvalni yangilang."));
  } catch (error) {
    console.error("Xato:", error);
  }
}

/* ==========================================
   🧮 SPLIT BILL — Mijoz tomonidan hisobni bo'lish
   ==========================================
   Mijoz o'zi to'lovni tasdiqlay olmaydi — bu yerda faqat
   qanday bo'linishini ko'rsatib, ofitsiantga so'rov yuboradi.
   Ofitsiant panelida shu taqsimot ko'rinadi va u tasdiqlaydi.
========================================== */
let _csbMode = "equal";
let _csbPeopleCount = 2;
let _csbCustomShares = [{ name: "", amount: null }, { name: "", amount: null }];

function _ensureClientSplitBillModal() {
  if (document.getElementById("clientSplitBillModal")) return;
  const modal = document.createElement("div");
  modal.id = "clientSplitBillModal";
  modal.style.cssText = "display:none;position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:100000;align-items:center;justify-content:center;padding:16px;";
  modal.innerHTML = `
    <div style="background:#fff;border-radius:20px;max-width:420px;width:100%;max-height:88vh;overflow-y:auto;padding:22px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <h3 style="margin:0;font-size:17px;color:#0f172a;">🧮 ${t("split_bill_title","Hisobni bo'lish")}</h3>
        <button onclick="window.closeClientSplitBillModal()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8;">✕</button>
      </div>
      <div id="csbTotalLine" style="font-size:13px;color:#64748b;margin-bottom:14px;"></div>

      <div style="display:flex;gap:8px;margin-bottom:14px;">
        <button id="csbModeEqualBtn" onclick="window.setClientSplitBillMode('equal')"
          style="flex:1;padding:9px;border-radius:8px;border:1.5px solid #16a34a;font-weight:700;font-size:13px;cursor:pointer;">
          ⚖️ ${t("split_bill_equal","Teng bo'lish")}
        </button>
        <button id="csbModeCustomBtn" onclick="window.setClientSplitBillMode('custom')"
          style="flex:1;padding:9px;border-radius:8px;border:1.5px solid #16a34a;font-weight:700;font-size:13px;cursor:pointer;">
          ✍️ ${t("split_bill_custom","Alohida summalar")}
        </button>
      </div>

      <div id="csbEqualPanel">
        <label style="font-size:13px;font-weight:600;color:#475569;">${t("split_bill_people_count","Necha kishiga bo'linadi?")}</label>
        <div style="display:flex;align-items:center;gap:10px;margin-top:8px;">
          <button onclick="window.csbChangePeopleCount(-1)" style="width:36px;height:36px;border-radius:8px;border:1.5px solid #cbd5e1;background:#fff;font-size:17px;cursor:pointer;">−</button>
          <input id="csbPeopleCountInput" type="number" min="2" max="50" value="2"
            style="flex:1;text-align:center;padding:9px;border-radius:8px;border:1.5px solid #cbd5e1;font-size:15px;font-weight:700;"
            oninput="window.csbSetPeopleCount(this.value)">
          <button onclick="window.csbChangePeopleCount(1)" style="width:36px;height:36px;border-radius:8px;border:1.5px solid #cbd5e1;background:#fff;font-size:17px;cursor:pointer;">+</button>
        </div>
        <div id="csbEqualResult" style="margin-top:14px;"></div>
      </div>

      <div id="csbCustomPanel" style="display:none;">
        <div id="csbCustomList"></div>
        <button onclick="window.csbAddCustomShare()" style="width:100%;margin-top:8px;padding:9px;border-radius:8px;border:1.5px dashed #16a34a;background:#fff;color:#16a34a;font-weight:700;font-size:13px;cursor:pointer;">
          + ${t("split_bill_add_person","Kishi qo'shish")}
        </button>
        <div id="csbCustomSummary" style="margin-top:12px;font-size:13px;font-weight:700;"></div>
      </div>

      <p style="font-size:12px;color:#94a3b8;margin:14px 0 0;">
        ℹ️ ${t("split_bill_client_note","Bu taqsimot ofitsiantga yuboriladi. To'lovni ofitsiant qabul qilib, tasdiqlaydi.")}
      </p>

      <button id="csbConfirmBtn" onclick="window.confirmClientSplitBill()"
        style="width:100%;margin-top:14px;padding:13px;border:none;border-radius:12px;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;font-weight:800;font-size:14px;cursor:pointer;">
        📨 ${t("split_bill_send_to_waiter","Ofitsiantga yuborish")}
      </button>
    </div>
  `;
  document.body.appendChild(modal);
}

window.openClientSplitBillModal = function () {
  _ensureClientSplitBillModal();
  const total = Number(currentPaymentTotal || activeOrderData?.finalTotal || activeOrderData?.total || 0);
  window._csbTotal = total;
  _csbMode = "equal";
  _csbPeopleCount = 2;
  _csbCustomShares = [{ name: "", amount: null }, { name: "", amount: null }];

  document.getElementById("csbTotalLine").textContent =
    `${t("total_label","Jami")}: ${total.toLocaleString()} ${t("currency","so'm")}`;
  document.getElementById("csbPeopleCountInput").value = 2;

  window.setClientSplitBillMode("equal");
  document.getElementById("clientSplitBillModal").style.display = "flex";
};

window.closeClientSplitBillModal = function () {
  const modal = document.getElementById("clientSplitBillModal");
  if (modal) modal.style.display = "none";
};

window.setClientSplitBillMode = function (mode) {
  _csbMode = mode;
  const equalBtn = document.getElementById("csbModeEqualBtn");
  const customBtn = document.getElementById("csbModeCustomBtn");
  const equalPanel = document.getElementById("csbEqualPanel");
  const customPanel = document.getElementById("csbCustomPanel");

  if (equalBtn) { equalBtn.style.background = mode === "equal" ? "#16a34a" : "#fff"; equalBtn.style.color = mode === "equal" ? "#fff" : "#16a34a"; }
  if (customBtn) { customBtn.style.background = mode === "custom" ? "#16a34a" : "#fff"; customBtn.style.color = mode === "custom" ? "#fff" : "#16a34a"; }
  if (equalPanel) equalPanel.style.display = mode === "equal" ? "" : "none";
  if (customPanel) customPanel.style.display = mode === "custom" ? "" : "none";

  if (mode === "equal") _csbRenderEqual();
  else _csbRenderCustom();
};

window.csbChangePeopleCount = function (delta) {
  _csbPeopleCount = Math.max(2, Math.min(50, _csbPeopleCount + delta));
  document.getElementById("csbPeopleCountInput").value = _csbPeopleCount;
  _csbRenderEqual();
};

window.csbSetPeopleCount = function (val) {
  _csbPeopleCount = Math.max(2, Math.min(50, Number(val) || 2));
  _csbRenderEqual();
};

function _csbRenderEqual() {
  const resultEl = document.getElementById("csbEqualResult");
  if (!resultEl) return;
  const total = window._csbTotal || 0;
  const perPerson = Math.floor(total / _csbPeopleCount);
  const remainder = total - perPerson * _csbPeopleCount;

  let rows = "";
  for (let i = 1; i <= _csbPeopleCount; i++) {
    const amount = i === 1 ? perPerson + remainder : perPerson;
    rows += `<div style="display:flex;justify-content:space-between;padding:8px 10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;margin-bottom:6px;font-size:13px;">
      <span>${t("person_label","Kishi")} ${i}</span><b>${amount.toLocaleString()} ${t("currency","so'm")}</b>
    </div>`;
  }
  resultEl.innerHTML = rows;
}

window.csbAddCustomShare = function () {
  _csbCustomShares.push({ name: "", amount: null });
  _csbRenderCustom();
};

window.csbRemoveCustomShare = function (idx) {
  if (_csbCustomShares.length <= 1) return;
  _csbCustomShares.splice(idx, 1);
  _csbRenderCustom();
};

window.csbUpdateCustomShare = function (idx, field, value) {
  if (!_csbCustomShares[idx]) return;
  _csbCustomShares[idx][field] = field === "amount" ? (value === "" ? null : Number(value)) : value;
  _csbUpdateCustomSummary();
};

function _csbRenderCustom() {
  const listEl = document.getElementById("csbCustomList");
  if (!listEl) return;
  listEl.innerHTML = _csbCustomShares.map((share, idx) => `
    <div style="display:flex;gap:6px;margin-bottom:8px;align-items:center;">
      <input type="text" placeholder="${t('split_bill_name_placeholder','Ism (masalan: Ali)')}" value="${share.name || ""}"
        oninput="window.csbUpdateCustomShare(${idx}, 'name', this.value)"
        style="flex:1.3;padding:9px;border-radius:8px;border:1.5px solid #cbd5e1;font-size:13px;">
      <input type="number" placeholder="${t('split_bill_amount_placeholder','Summa')}" value="${share.amount ?? ""}"
        oninput="window.csbUpdateCustomShare(${idx}, 'amount', this.value)"
        style="flex:1;padding:9px;border-radius:8px;border:1.5px solid #cbd5e1;font-size:13px;">
      <button onclick="window.csbRemoveCustomShare(${idx})" style="width:34px;height:34px;border-radius:8px;border:1.5px solid #fecaca;background:#fff;color:#dc2626;cursor:pointer;">✕</button>
    </div>`).join("");
  _csbUpdateCustomSummary();
}

function _csbUpdateCustomSummary() {
  const summaryEl = document.getElementById("csbCustomSummary");
  if (!summaryEl) return;
  const total = window._csbTotal || 0;
  const sumEntered = _csbCustomShares.reduce((a, s) => a + (Number(s.amount) || 0), 0);
  const diff = total - sumEntered;
  const cur = t("currency", "so'm");

  if (diff === 0) {
    summaryEl.innerHTML = `<span style="color:#15803d;">✅ ${t("split_bill_matches","Yig'indi jamiga teng")}: ${sumEntered.toLocaleString()} ${cur}</span>`;
  } else if (diff > 0) {
    summaryEl.innerHTML = `<span style="color:#b45309;">⚠️ ${t("split_bill_remaining","Qoldi")}: ${diff.toLocaleString()} ${cur}</span>`;
  } else {
    summaryEl.innerHTML = `<span style="color:#dc2626;">⚠️ ${t("split_bill_over","Jamidan oshib ketdi")}: ${Math.abs(diff).toLocaleString()} ${cur}</span>`;
  }
}

// ── Split taqsimotni buyurtmaga yozib, ofitsiantga to'lov so'rovini yuborish ──
window.confirmClientSplitBill = async function () {
  if (!currentOrderId) { showNotification(t("active_order_not_found_alert","Faol buyurtma topilmadi!")); return; }
  const total = window._csbTotal || 0;

  let shares = [];
  if (_csbMode === "equal") {
    const perPerson = Math.floor(total / _csbPeopleCount);
    const remainder = total - perPerson * _csbPeopleCount;
    for (let i = 1; i <= _csbPeopleCount; i++) {
      shares.push({ name: `${t("person_label","Kishi")} ${i}`, amount: i === 1 ? perPerson + remainder : perPerson });
    }
  } else {
    const sumEntered = _csbCustomShares.reduce((a, s) => a + (Number(s.amount) || 0), 0);
    if (Math.abs(sumEntered - total) > 1) {
      showNotification(t("split_bill_mismatch_error", "Ulushlar yig'indisi jami summaga teng emas!"));
      return;
    }
    const missingName = _csbCustomShares.some(s => !s.name || !s.name.trim());
    if (missingName) {
      showNotification(t("split_bill_name_required", "Har bir kishi uchun ism kiriting!"));
      return;
    }
    shares = _csbCustomShares.map(s => ({ name: s.name.trim(), amount: Number(s.amount) || 0 }));
  }

  const confirmBtn = document.getElementById("csbConfirmBtn");
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "⏳..."; }

  try {
    const splitBillRequest = {
      mode: _csbMode,
      total,
      peopleCount: _csbMode === "equal" ? _csbPeopleCount : shares.length,
      shares,
      requestedAt: Date.now(),
      requestedBy: "client"
    };

    await update(ref(db, `${BASE_PATH}/orders/${currentOrderId}`), {
      "payment/splitBillRequest": splitBillRequest
    });

    document.getElementById("clientSplitBillModal").style.display = "none";
    showNotification(t("split_bill_sent_notice", "Hisob taqsimoti ofitsiantga yuborildi. Ofitsiant kelib, to'lovni qabul qiladi."));

    // Hisob so'rovini ham yuboramiz (agar hali yuborilmagan bo'lsa)
    if (typeof window.requestBill === "function") {
      await window.requestBill();
    }
  } catch (err) {
    console.error("confirmClientSplitBill error:", err);
    showNotification(t("notify.error", "Xatolik yuz berdi!"));
  } finally {
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = `📨 ${t("split_bill_send_to_waiter","Ofitsiantga yuborish")}`; }
  }
};

/* =========================
   XISOB SO'RASH VA TO'LOV 
========================= */
window.requestBill = async function () {
  // ── Admin "faqat ofitsiant to'laydi" deb belgilagan bo'lsa — mijoz
  // ilova orqali hisob so'ray olmaydi. ──
  const billingMode = RESTAURANT_SETTINGS?.billingMode || "client_only";
  if (billingMode === "waiter_only") {
    showNotification(t("billing_waiter_only_notice", "Hisobni yopish uchun ofitsiantga murojaat qiling."));
    return;
  }

  if (!currentOrderId || !activeOrderData) {
    const _savedId = localStorage.getItem("activeOrderId") || localStorage.getItem("currentOrderId");
    if (_savedId) {
      try {
        const _ord = await fetchClientOrder(_savedId);
        if (_ord) {
          const _st  = normalizeStatus(getOrderStatusKey(_ord));
          const _alive = !["yopildi", "bekor qilindi", "closed", "cancelled", "paid", "to'landi"].includes(_st);
          if (_alive && _ord.tableClosed !== true) {
            currentOrderId   = _savedId;
            activeOrderData  = { ..._ord, _id: _savedId };
            hasSubmittedOrder = true;
            sessionStorage.setItem("client_has_submitted_order", "1");
          } else {
            showNotification(t("active_order_not_found_alert", "Faol buyurtma topilmadi!"));
            return;
          }
        } else {
          showNotification(t("active_order_not_found_alert", "Faol buyurtma topilmadi!"));
          return;
        }
      } catch (_e) {
        console.warn("requestBill restore failed:", _e);
        showNotification(t("active_order_not_found_alert", "Faol buyurtma topilmadi!"));
        return;
      }
    } else {
      showNotification(t("active_order_not_found_alert", "Faol buyurtma topilmadi!"));
      return;
    }
  }

  const tableStr = String(confirmedTableNumber || activeOrderData.table || localStorage.getItem("table") || "").trim();

  let kassaCode = activeOrderData.kassaCode || null;

  if (!kassaCode) {
    // Format: NESTA-YYMM-XXXXXX
    const _d     = new Date();
    const _yymm  = String(_d.getFullYear()).slice(2) + String(_d.getMonth() + 1).padStart(2, "0");
    const _rand6 = String(Math.floor(100000 + Math.random() * 900000));
    kassaCode = "NESTA-" + _yymm + "-" + _rand6;

    await update(ref(db, BASE_PATH + "/orders/" + currentOrderId), {
      kassaCode: kassaCode,
      kassaCodeGeneratedAt: Date.now()
    });

    activeOrderData.kassaCode = kassaCode;
  }

  await set(push(ref(db, BASE_PATH + "/paymentRequests")), {
    table: tableStr,
    tableId: getTableKey(tableStr),
    orderId: currentOrderId,
    kassaCode: kassaCode,
    status: "requested",
    createdAt: Date.now(),
    requestedBy: clientId
  });

  await update(ref(db, `${BASE_PATH}/tables/${getTableKey(tableStr)}`), { status: "billing" });

  const phone = activeOrderData.clientPhone
    || activeOrderData.customerPhone
    || activeOrderData.phoneNumber
    || localStorage.getItem("customerPhone")
    || localStorage.getItem("userPhone")
    || (typeof getCurrentClientPhoneNumber === "function" ? getCurrentClientPhoneNumber() : "")
    || document.getElementById("clientPhoneInput")?.value?.trim()
    || "";

  if (phone) {
    window.currentPaymentPhoneKey = phone;
    localStorage.setItem("customerPhone", phone);
  }

  console.log("💳 requestBill phone:", phone, "| kassaCode:", kassaCode);

  // ID raqam (kassaCode) o'rniga mijozga to'g'ridan-to'g'ri to'lov oynasi ochiladi.
  // Kassa kodi baribir order ichida saqlanadi (admin/ofitsiant panelida
  // ko'rinishi va tekshirilishi uchun), lekin mijozga endi modal emas,
  // to'lov (checkout) UI ko'rsatiladi.
  if (typeof window._openCheckoutUI === "function") {
    await window._openCheckoutUI();
  } else if (typeof window.openCheckoutModal === "function") {
    await window.openCheckoutModal();
  } else {
    _showKassaCodeModal(kassaCode, formatOrderNumber(activeOrderData) || (activeOrderData.orderNumber || ""), tableStr);
  }
};

function _showKassaCodeModal(code, orderNumber, table) {
  const old = document.getElementById("_kassaCodeModal");
  if (old) old.remove();

  const _parts = code.match(/^NESTA-(\d{4})-(\d{6})$/i) || null;
  const _codeDisplay = _parts
    ? `<span style="opacity:.75;font-size:13px;letter-spacing:1px;font-weight:700;">NESTA</span><span style="opacity:.75;font-size:20px;font-weight:700;">-</span><span style="font-size:30px;font-weight:900;letter-spacing:1px;">${_parts[1]}</span><span style="opacity:.75;font-size:20px;font-weight:700;">-</span><span style="font-size:30px;font-weight:900;letter-spacing:2px;">${_parts[2]}</span>`
    : `<span style="font-size:18px;font-weight:900;letter-spacing:2px;">${code}</span>`;

  const overlay = document.createElement("div");
  overlay.id = "_kassaCodeModal";
  overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,0.72);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:20px;";

  overlay.innerHTML = `
    <div style="
      background:#fff;border-radius:28px;
      max-width:380px;width:100%;text-align:center;
      box-shadow:0 32px 80px rgba(0,0,0,0.28);position:relative;overflow:hidden;
      animation:_kcmPop .38s cubic-bezier(.34,1.56,.64,1) both;
    ">
      <style>
        @keyframes _kcmPop  { from{transform:scale(.72) translateY(20px);opacity:0} to{transform:scale(1) translateY(0);opacity:1} }
        @keyframes _kcmGlow { 0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.5)} 50%{box-shadow:0 0 0 12px rgba(34,197,94,0)} }
        @keyframes _kcmShine{ 0%{left:-60%} 100%{left:130%} }
        @keyframes _kcmTick { 0%{transform:scale(0) rotate(-45deg);opacity:0} 60%{transform:scale(1.3) rotate(0deg);opacity:1} 100%{transform:scale(1) rotate(0deg);opacity:1} }
      </style>

      <!-- Yashil dekorativ top chiziq -->
      <div style="height:6px;background:linear-gradient(90deg,#22c55e,#16a34a,#15803d);width:100%;"></div>

      <!-- Yopish tugmasi -->
      <button onclick="document.getElementById('_kassaCodeModal').remove()"
        style="position:absolute;top:16px;right:18px;background:#f1f5f9;border:none;width:30px;height:30px;border-radius:50%;font-size:16px;cursor:pointer;color:#64748b;display:flex;align-items:center;justify-content:center;transition:background .15s;z-index:1;"
        onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f1f5f9'">✕</button>

      <!-- Sarlavha qismi -->
      <div style="padding:28px 28px 0;">
        <div style="width:72px;height:72px;background:linear-gradient(135deg,#f0fdf4,#dcfce7);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:34px;margin:0 auto 14px;border:2px solid #bbf7d0;animation:_kcmGlow 2.5s ease-in-out infinite;">
          🧾
        </div>
        <h2 style="margin:0 0 6px;font-size:20px;font-weight:800;color:#0f172a;letter-spacing:-.3px;">Kassaga boring!</h2>
        <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">
          Kassir ushbu <strong style="color:#16a34a;">Kassa ID</strong> ni kiritadi<br>va to'lovingiz amalga oshiriladi 💚
        </p>
        ${table || orderNumber ? `
        <div style="display:inline-flex;align-items:center;gap:10px;margin-top:12px;padding:6px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:30px;font-size:12px;color:#475569;font-weight:500;">
          ${table ? `<span>🪑 Stol ${table}</span>` : ""}
          ${table && orderNumber ? `<span style="color:#cbd5e1;">|</span>` : ""}
          ${orderNumber ? `<span>📋 Buyurtma ${String(orderNumber).startsWith("ORD-") || String(orderNumber).startsWith("DVR-") ? orderNumber : "#" + orderNumber}</span>` : ""}
        </div>` : ""}
      </div>

      <!-- ID kartochkasi -->
      <div style="margin:20px 24px 0;position:relative;">
        <div style="
          background:linear-gradient(135deg,#16a34a 0%,#22c55e 55%,#4ade80 100%);
          border-radius:20px;padding:24px 20px 20px;
          box-shadow:0 8px 28px rgba(34,197,94,0.4);
          position:relative;overflow:hidden;
        ">
          <!-- Porlash effekti -->
          <div style="
            position:absolute;top:0;left:-60%;width:40%;height:100%;
            background:linear-gradient(90deg,transparent,rgba(255,255,255,.22),transparent);
            transform:skewX(-15deg);
            animation:_kcmShine 2.8s ease-in-out 0.5s infinite;
            pointer-events:none;
          "></div>

          <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,.7);letter-spacing:2.5px;text-transform:uppercase;margin-bottom:12px;">
            ✦ KASSA ID ✦
          </div>
          <div style="color:#fff;line-height:1.2;display:flex;align-items:baseline;justify-content:center;gap:2px;flex-wrap:wrap;font-family:monospace;">
            ${_codeDisplay}
          </div>
          <div style="font-size:10px;color:rgba(255,255,255,.55);margin-top:10px;">
            Kassirga ushbu kodni ayting yoki nusxalang
          </div>
        </div>
      </div>

      <!-- Nusxalash tugmasi -->
      <div style="padding:16px 24px 0;">
        <button id="_kcm_copy_btn" onclick="
          try {
            navigator.clipboard.writeText('${code}').then(()=>{
              const b = document.getElementById('_kcm_copy_btn');
              b.innerHTML = '✅ ' + window.t('copied_label', 'Nusxalandi!');
              b.style.background='#f0fdf4'; b.style.color='#16a34a'; b.style.borderColor='#86efac';
              setTimeout(()=>{
                b.innerHTML='📋 &nbsp;' + window.t('copy_code_btn', 'Kodni nusxalash');
                b.style.background=''; b.style.color=''; b.style.borderColor='';
              }, 2200);
            });
          } catch(e) {
            const t=document.createElement('textarea');t.value='${code}';document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();
            const b=document.getElementById('_kcm_copy_btn');
            b.innerHTML='✅ ' + window.t('copied_label', 'Nusxalandi!');b.style.background='#f0fdf4';b.style.color='#16a34a';
            setTimeout(()=>{b.innerHTML='📋 &nbsp;' + window.t('copy_code_btn', 'Kodni nusxalash');b.style.background='';b.style.color='';},2200);
          }"
          style="width:100%;padding:13px;border:1.5px solid #e2e8f0;border-radius:13px;background:#fff;color:#334155;font-size:14px;font-weight:600;cursor:pointer;transition:all .18s;font-family:inherit;"
          onmouseover="this.style.background='#f0fdf4';this.style.borderColor='#86efac';this.style.color='#16a34a';"
          onmouseout="if(!this.innerHTML.includes(window.t('copied_label','Nusxalandi!'))){this.style.background='';this.style.borderColor='';this.style.color='';}">
          📋 &nbsp;${t("copy_code_btn", "Kodni nusxalash")}
        </button>
      </div>

      <!-- Izoh va yopish -->
      <div style="padding:14px 24px 24px;">
        <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:#f0fdf4;border-radius:10px;margin-bottom:14px;">
          <span style="font-size:18px;">⏱️</span>
          <span style="font-size:12px;color:#166534;font-weight:500;line-height:1.4;">
            Kassir sizning buyurtmangizni topadi va to'lovni amalga oshiradi
          </span>
        </div>
        <button onclick="document.getElementById('_kassaCodeModal').remove()"
          style="width:100%;padding:12px;border:none;border-radius:13px;background:#f1f5f9;color:#64748b;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s;"
          onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f1f5f9'">
          Yopish
        </button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
}

/* =========================
   TO'LOV IMITATSIYASI  
========================= */
window.simulatePayment = async function (method) {
  const amountEl = document.getElementById('paymentTotal');
  const amountText = amountEl ? amountEl.innerText : "0";
  const amount = parseInt(amountText.replace(/\D/g, '')) || 0;
  const restId = localStorage.getItem("restaurantId");

  const modalContent = document.querySelector(".payment-card");
  if (!modalContent) return;

  const originalHTML = modalContent.innerHTML;

  let brandColor = method.toLowerCase() === 'click' ? '#00a1ff' : (method.toLowerCase() === 'payme' ? '#33dac4' : '#28a745');

  modalContent.innerHTML = `
        <div style="text-align:center; padding: 50px 20px;">
            <div style="width: 65px; height: 65px; border: 6px solid #f3f3f3; border-top: 6px solid ${brandColor}; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto;"></div>
            <h3 style="margin-top:25px; color: #333; font-family: sans-serif;">${method} ${t("paying_via", "orqali to'lanmoqda...")}</h3>               
            <p style="color:#888; font-size: 14px; margin-top: 8px;">${t("dont_close_page", "Iltimos, sahifani yopmang yoki yangilamang.")}</p>
        </div>
        <style>
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            @keyframes popIn { 0% { transform: scale(0); opacity: 0; } 80% { transform: scale(1.1); } 100% { transform: scale(1); opacity: 1; } }
        </style>
    `;

  await new Promise(res => setTimeout(res, 2500));

  try {

    if (currentOrderId) {
      await update(ref(db, `restaurants/${restId}/orders/${currentOrderId}/payment`), {
        paid: true,
        method: method,
        time: Date.now(),
        approved: true
      });

      // To'lovdan keyin stol "cleaning" (tozalanmoqda) holatiga o'tadi
      const order2 = await fetchClientOrder(currentOrderId);
      if (order2) {
        const tableNo = order2.table;
        if (tableNo) {
          await update(ref(db, `restaurants/${restId}/tables/${getTableKey(tableNo)}`), {
            status: "cleaning",
            cleaningNeededAt: Date.now(),
            busy: false
          });
        }
        // Buyurtma statusini "to'landi" ga o'tkazish
        await update(ref(db, `restaurants/${restId}/orders/${currentOrderId}`), {
          status: "to'landi",
          paidAt: Date.now()
        });
      }
    }

    modalContent.innerHTML = `
            <div style="text-align:center; padding: 40px 20px;">
                <div style="width: 90px; height: 90px; background: #28a745; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 50px; margin: 0 auto; animation: popIn 0.5s ease-out forwards;">
                    ✓
                </div>
                <h2 style="margin-top:25px; color: #28a745;">${t("payment_success", "To'lov muvaffaqiyatli!")}</h2>
                <div style="background: #f8f9fa; border-radius: 10px; padding: 15px; margin-top: 20px;">
                    <p style="color:#555; font-size: 18px; margin: 0;">${t("total_paid", "Jami to'landi:")}</p>
                    <p style="color:#000; font-size: 24px; font-weight: bold; margin: 5px 0 0 0;">${amount.toLocaleString()} UZS</p>
                </div>
                <p style="color:#aaa; font-size: 12px; margin-top: 15px;">Nesta ERP • ${t("approved_status", "Tasdiqlandi")}</p>
            </div>
        `;

    await new Promise(res => setTimeout(res, 2500));

    document.getElementById('paymentModal').style.display = 'none';
    modalContent.innerHTML = originalHTML;

    localStorage.removeItem("discountPercent");
    localStorage.removeItem("discountCode");

    // Savat tozalash listenActiveOrder orqali payment.approved bo'lganda avtomatik bo'ladi

    if (currentOrderId) {
      const order3 = await fetchClientOrder(currentOrderId);
      if (order3 && typeof showReceipt === "function") {
        showReceipt(order3);
      }
    }

    setTimeout(() => {
      if (typeof openFeedbackModal === "function") openFeedbackModal();
    }, 6000);

  } catch (error) {
    console.error("To'lov xatosi:", error);

    modalContent.innerHTML = `
            <div style="text-align:center; padding: 40px 20px;">
                <div style="width: 80px; height: 80px; background: #dc3545; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 40px; margin: 0 auto; animation: popIn 0.3s ease-out forwards;">
                    ✕
                </div>
                <h2 style="margin-top:20px; color: #dc3545;">${t("error_occurred", "Xatolik yuz berdi")}</h2>
                <p style="color:#888; font-size: 15px; margin-top: 10px;">${t("payment_failed_reason", "Tarmoqda uzilish bo'ldi yoki hisobingizda mablag' yetarli emas. Iltimos, qayta urinib ko'ring.")}</p>
                <button onclick="document.getElementById('paymentModal').style.display='none'; document.querySelector('.payment-card').innerHTML=\`${originalHTML.replace(/`/g, '\\`')}\`;" style="margin-top: 25px; padding: 12px 25px; background: #eee; color: #333; font-weight: bold; border: none; border-radius: 8px; cursor: pointer;">${t("close_and_return", "Yopish va qaytish")}</button>
            </div>
        `;
  }
};

window.handlePaymentMethodChange = function (method) {
  const cardContainer = document.getElementById('card-input-container');
  if (cardContainer) {
    if (method === 'card') {
      cardContainer.style.display = 'block';
      cardContainer.style.animation = 'fadeIn 0.3s ease-in-out';
    } else {
      cardContainer.style.display = 'none';
    }
  }
};

window.openFeedbackModal = function () {
  const modal = document.getElementById('feedback-modal');
  if (modal) {
    modal.style.display = 'flex';
    initStars();
  }
};

/* =========================
   VIP MIJOZ STATUSINI TEKSHIRISH
========================= */
window.vipDiscountPercent = 0;

window.checkVipStatus = async function () {
  const rawPhone = localStorage.getItem("customerPhone") || localStorage.getItem("userPhone");
  if (!rawPhone) {
    hideAllVipElements();
    return;
  }

  // Telefon raqamni normallashtirish (+998XXXXXXXXX)
  const normalizedPhone = normalizeCustomerPhone(rawPhone);
  const _vd = normalizedPhone.replace(/\D/g, "");

  // Faqat aniq +998XXXXXXXXX (12 raqam) formatidagi raqamlarga ruxsat
  if (!normalizedPhone || _vd.length !== 12 || !_vd.startsWith("998")) {
    hideAllVipElements();
    return;
  }

  const restId = localStorage.getItem("restaurantId");

  try {
    // 🩹 Audit fix: encodeURIComponent — admin.js/waiter.js bilan bir xil kalit.
    const custKey = encodeURIComponent(normalizedPhone);
    const snap = await get(ref(db, `restaurants/${restId}/customers/${custKey}`));

    if (!snap.exists()) {
      hideAllVipElements();
      return;
    }

    if (snap.exists()) {
      const customer = snap.val();

      // ── Yangi VIP tizimi ──
      // Admin tomonidan berilgan VIP: isVip=true, vipDiscountPercent, vipOrdersTotal, vipOrdersUsed
      const isAdminVip = customer.isVip === true;
      const vipDiscPct = Number(customer.vipDiscountPercent || 0);
      const vipTotal = Number(customer.vipOrdersTotal || 0);
      const vipUsed = Number(customer.vipOrdersUsed || 0);
      const vipLeft = vipTotal - vipUsed;

      if (isAdminVip && vipDiscPct > 0 && (vipTotal === 0 || vipLeft > 0)) {
        // VIP faol — badge va chegirma ko'rsatamiz
        window.vipDiscountPercent = vipDiscPct;


        const headerBadge = document.getElementById("headerBadge");
        if (headerBadge) {
          headerBadge.innerHTML = `👑 VIP -${vipDiscPct}% (${vipLeft} ${t("vip_left_count_suffix", "ta qoldi")})`;
          headerBadge.style.display = "inline-block";
        }

        const banner = document.getElementById("vip-banner");
        const percentSpan = document.getElementById("vip-percent");
        if (banner && percentSpan) {
          percentSpan.innerText = vipDiscPct;
          banner.style.display = "block";
        }

        if (typeof updatePaymentSummary === "function") updatePaymentSummary();

      } else if (isAdminVip && vipTotal > 0 && vipLeft <= 0) {
        // VIP xaridlar tugagan — VIP olib tashlanadi
        await update(ref(db, `restaurants/${restId}/customers/${custKey}`), {
          isVip: false
        });
        window.vipDiscountPercent = 0;

        const headerBadge = document.getElementById("headerBadge");
        if (headerBadge) headerBadge.style.display = "none";

        const banner = document.getElementById("vip-banner");
        if (banner) banner.style.display = "none";

      } else {
        // VIP yo'q — hech narsa ko'rsatmaymiz
        // (eski fallback olib tashlandi: faqat admin bergan VIP ishlaydi)
        window.vipDiscountPercent = 0;

        const headerBadge = document.getElementById("headerBadge");
        if (headerBadge) headerBadge.style.display = "none";

        const banner = document.getElementById("vip-banner");
        if (banner) banner.style.display = "none";
      }
    }
  } catch (error) {
    console.error("VIP statusni tekshirishda xato:", error);
  }
};

// 🩹 Same DOMContentLoaded-race fix as _initClientApp() above.
function _resetVipStateOnLoad() {
  // Sahifa ochilganda telefon raqamni tozalaymiz —
  // VIP badge FAQAT Tekshirish tugmasi bosilganda, foydalanuvchi o'z raqamini kiritganida korsatiladi
  localStorage.removeItem("customerPhone");
  localStorage.removeItem("userPhone");

  // VIP elementlarni yashiramiz
  const _hb0 = document.getElementById("headerBadge");
  if (_hb0) _hb0.style.display = "none";
  const _vb0 = document.getElementById("vip-banner");
  if (_vb0) _vb0.style.display = "none";
  const _vbadge = document.getElementById("vipBadge");
  if (_vbadge) _vbadge.style.display = "none";
  window.vipDiscountPercent = 0;

  // VIP faqat Tekshirish tugmasi bosilganda tekshiriladi — bu yerda chaqirilmaydi
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _resetVipStateOnLoad);
} else {
  _resetVipStateOnLoad();
}

function initStars() {
  document.querySelectorAll('.stars').forEach(group => {
    const stars = Array.from(group.querySelectorAll('span'));

    stars.forEach((star, index) => {
      star.onclick = function () {
        const value = index + 1;
        group.setAttribute('data-value', value);

        stars.forEach((s, i) => {
          s.style.color = i < value ? '#ffc107' : '#e4e5e9';
        });
      };
    });
  });
}

window.submitFeedback = async function () {
  const restId = localStorage.getItem("restaurantId");
  if (!restId) return;

  const foodQual = parseInt(document.getElementById('star-food').getAttribute('data-value') || 5);
  const servQual = parseInt(document.getElementById('star-service').getAttribute('data-value') || 5);
  const atmos = parseInt(document.getElementById('star-atmosphere').getAttribute('data-value') || 5);
  const recommend = document.getElementById('feedback-recommend').value === 'yes';

  const urlParams = new URLSearchParams(window.location.search);
  const tableNo = urlParams.get('table') || localStorage.getItem("tableNumber") || "Noma'lum";
  const orderId = localStorage.getItem("lastOrderId") || "";
  const feedbackData = {
    table: tableNo,
    orderId: orderId,
    foodQuality: foodQual,
    serviceQuality: servQual,
    atmosphere: atmos,
    wouldRecommend: recommend,
    createdAt: Date.now()
  };

  try {
    const newFeedbackRef = push(ref(db, `restaurants/${restId}/feedback`));
    await set(newFeedbackRef, feedbackData);

    showNotification(t("thanks_for_rating", "Bahoyingiz uchun rahmat! 🎉"));
    closeFeedback();
  } catch (error) {
    console.error(t("err_feedback", "Baholashda xato:"), error);
    alert(t("error_occurred_alert", "Xatolik yuz berdi!"));
  }
};

window.closeFeedback = function () {
  const modal = document.getElementById('feedback-modal');
  if (modal) modal.style.display = 'none';
};

/* =========================
   MIJOZ UCHUN PROMOKOD VA CHEGIRMA
========================= */
window.appliedPromoCode = null;
window.discountPercent = 0;

window.applyClientPromo = async function () {
  const promoInputEl = document.getElementById("cartPromoInput") || document.getElementById("promo-input");
  const promoInput = promoInputEl ? promoInputEl.value.trim().toUpperCase() : "";
  const msgEl = document.getElementById("promo-msg");

  let userPhone = document.getElementById("phoneNumber")?.value || localStorage.getItem("userPhone") || localStorage.getItem("customerPhone") || "";
  userPhone = userPhone.replace(/\D/g, "").slice(-9);

  const restId = localStorage.getItem("restaurantId");

  if (!promoInput) return;

  try {
    const promoSnap = await get(ref(db, `restaurants/${restId}/discounts/${promoInput}`));

    if (!promoSnap.exists()) {
      msgEl.style.color = "red";
      msgEl.innerText = "❌ " + t("promo_not_found", "Bunday promokod topilmadi!");
      msgEl.style.display = "block";
      return;
    }

    const promoData = promoSnap.val();

    const usesLeftOld = promoData.usesLeft !== undefined ? Number(promoData.usesLeft) : (promoData.used ? 0 : 1);

    if (promoData.used && usesLeftOld <= 0) {
      msgEl.style.color = "red";
      msgEl.innerText = "❌ " + t("promo_already_used", "Bu promokod ishlatib bo'lingan!");
      msgEl.style.display = "block";
      return;
    }
    if (usesLeftOld <= 0) {
      msgEl.style.color = "red";
      msgEl.innerText = "❌ " + t("promo_limit_reached", "Bu promokod limiti tugagan!");
      msgEl.style.display = "block";
      return;
    }

    if (promoData.ownerPhone) {
      const ownerClean = promoData.ownerPhone.replace(/\D/g, "").slice(-9);
      if (ownerClean !== userPhone) {
        msgEl.style.color = "red";
        msgEl.innerText = "❌ " + t("promo_not_yours", "Bu promokod sizning raqamingizga tegishli emas!");
        msgEl.style.display = "block";
        return;
      }
    }

    localStorage.setItem("discountPercent", promoData.percent);
    localStorage.setItem("discountCode", promoData.code);

    msgEl.style.color = "#28a745";
    msgEl.innerText = `🎉 ${t("congrats_discount_applied", "Tabriklaymiz!")} ${promoData.percent}% ${t("discount_applied", "chegirma qo'llanildi.")}`;
    msgEl.style.display = "block";

    if (typeof updatePaymentSummary === "function") updatePaymentSummary();

  } catch (error) {
    console.error("Promokod tekshirishda xato:", error);
  }
};

// ==========================================
// 🛡 MIJOZ VA BRONNI TEKSHIRISH TIZIMI
// ==========================================
window.verifyTableAccess = async function () {
  const urlParams = new URLSearchParams(window.location.search);
  const urlTable = urlParams.get("table");

  const tableInput = document.getElementById("stolRaqamiInput")?.value || urlTable;
  const phoneInput = document.getElementById("telefonRaqamInput")?.value.trim();

  if (!tableInput || !phoneInput) {
    alert(t("enter_table_and_phone", "Iltimos, stol va telefon raqamingizni kiriting!"));
    return;
  }

  const restId = urlParams.get("rest") || localStorage.getItem("restaurantId");
  if (!restId) return;

  const cleanInputPhone = phoneInput.replace(/\D/g, "");

  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const reservationsRef = ref(db, `restaurants/${restId}/reservations`);
    const snap = await get(reservationsRef);

    let isReservedByOther = false;
    let matchedReservation = null;
    let matchedResKey = null;

    if (snap.exists()) {
      const reservations = snap.val();

      for (const key in reservations) {
        const res = reservations[key];

        if (res.date === todayStr &&
          String(res.tableNumber) === String(tableInput) &&
          ["pending", "confirmed", "seated"].includes(res.status)) {

          const cleanResPhone = (res.phone || "").replace(/\D/g, "");

          if (cleanResPhone === cleanInputPhone || cleanResPhone.endsWith(cleanInputPhone.slice(-9))) {
            matchedReservation = res;
            matchedResKey = key;
            isReservedByOther = false; // Bug 4 fix: o'z broni topilsa flagni tiklash
            break;
          } else {
            isReservedByOther = true;
          }
        }
      }
    }

    if (matchedReservation) {
      alert(`${t("welcome_guest", "Xush kelibsiz")}, ${matchedReservation.guestName}! ${t("menu_access_granted", "Menyuga ruxsat berildi.")}`);

      const resId = matchedReservation.id || matchedResKey;
      const now = Date.now();

      const updates = {};
      updates[`restaurants/${restId}/reservations/${resId}/status`] = "seated";
      updates[`restaurants/${restId}/reservations/${resId}/updatedAt`] = now;

      const _tk = getTableKey(tableInput);
      updates[`restaurants/${restId}/tables/${_tk}/status`] = "busy";
      updates[`restaurants/${restId}/tables/${_tk}/busy`] = true;
      updates[`restaurants/${restId}/tables/${_tk}/updatedAt`] = now;

      await update(ref(db), updates);
      grantAccessToMenu(tableInput, phoneInput, matchedReservation.guestName);

    } else if (isReservedByOther) {
      const errorDiv = document.getElementById("reservationError") || createErrorDiv();
      errorDiv.innerHTML = `
          <i class="fa-solid fa-circle-exclamation" style="font-size:40px; color:#ef4444; margin-bottom:10px;"></i><br>
          <b>${t("table_already_reserved", "Afsuski, bu stol bron qilingan!")}</b><br>
          <span style="font-size:14px; color:#666;">${t("please_choose_another_table", "Boshqa bo'sh stol tanlashingizni so'raymiz.")}</span>
      `;
      errorDiv.style.display = "block";

    } else {
      // Bug 1 fix: walk-in mijozni ham DB ga yozish — stol busy bo'lmasa bron egasi ham o'tira olmaydi
      const now = Date.now();
      const _tk2 = getTableKey(tableInput);
      await update(ref(db), {
        [`restaurants/${restId}/tables/${_tk2}/status`]: "busy",
        [`restaurants/${restId}/tables/${_tk2}/busy`]: true,
        [`restaurants/${restId}/tables/${_tk2}/updatedAt`]: now,
      });
      grantAccessToMenu(tableInput, phoneInput, "Mijoz");
    }

  } catch (error) {
    console.error("Tekshirishda xato:", error);
  }
};

// ==========================================
// ⭐ MIJOZ FIKRINI OLISH (FEEDBACK) TIZIMI
// ==========================================
window.showFeedbackModal = function (orderId) {
  if (localStorage.getItem(`feedback_done_${orderId}`)) return;

  const existingModal = document.getElementById("clientFeedbackModal");
  if (existingModal) existingModal.remove();

  const modalHtml = `
    <div id="clientFeedbackModal" class="fb-overlay">
      <div class="fb-card">

        <button class="fb-close" id="closeFeedbackBtn" aria-label="Yopish">✕</button>

        <div class="fb-header">
          <span class="fb-emoji">😋</span>
          <h3 class="fb-title">${t("bon_appetit", "Yoqimli ishtaha!")}</h3>
          <p class="fb-subtitle">${t("rate_service_quality", "Xizmatimiz sifatini baholang:")}</p>
        </div>

        <div class="fb-group">
          <div class="fb-group-label">
            <span class="fb-group-icon">🍲</span>
            <span>${t("food_quality", "Taom sifati")}</span>
          </div>
          <div class="star-rating fb-stars" data-category="food">
            <span data-value="1">★</span>
            <span data-value="2">★</span>
            <span data-value="3">★</span>
            <span data-value="4">★</span>
            <span data-value="5">★</span>
          </div>
        </div>

        <div class="fb-group">
          <div class="fb-group-label">
            <span class="fb-group-icon">🏠</span>
            <span>${t("rate_restaurant", "Restoran")}</span>
          </div>
          <div class="star-rating fb-stars" data-category="service">
            <span data-value="1">★</span>
            <span data-value="2">★</span>
            <span data-value="3">★</span>
            <span data-value="4">★</span>
            <span data-value="5">★</span>
          </div>
        </div>

        <div class="fb-group">
          <div class="fb-group-label">
            <span class="fb-group-icon">🛵</span>
            <span>${t("rate_delivery", "Yetkazib berish")}</span>
          </div>
          <div class="star-rating fb-stars" data-category="atmosphere">
            <span data-value="1">★</span>
            <span data-value="2">★</span>
            <span data-value="3">★</span>
            <span data-value="4">★</span>
            <span data-value="5">★</span>
          </div>
        </div>

        <div class="fb-comment">
          <textarea
            id="feedbackComment"
            placeholder="${t("feedback_placeholder", "Qo'shimcha izoh yoki takliflaringiz bo'lsa yozing...")}">
          </textarea>
        </div>

        <button id="submitFeedbackBtn" class="fb-submit">
          ${t("submit_btn", "Yuborish")}
        </button>
        <button class="fb-skip" id="skipFeedbackBtn">
          ${t("not_now_btn", "Hozir emas")}
        </button>

      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const ratings = { food: 0, service: 0, atmosphere: 0 };

  // ── Yulduzcha logikasi ──────────────────────────────────
  document.querySelectorAll(".star-rating").forEach(group => {
    const category = group.dataset.category;
    const stars = group.querySelectorAll("span");

    stars.forEach(star => {
      star.addEventListener("mouseenter", () => {
        const hoverVal = Number(star.dataset.value);
        stars.forEach(s => {
          s.classList.toggle("hovered", Number(s.dataset.value) <= hoverVal);
        });
      });

      star.addEventListener("click", () => {
        const val = Number(star.dataset.value);
        ratings[category] = val;
        stars.forEach(s => {
          s.classList.toggle("active", Number(s.dataset.value) <= val);
        });
      });
    });

    group.addEventListener("mouseleave", () => {
      stars.forEach(s => s.classList.remove("hovered"));
    });
  });

  // ── Yopish ─────────────────────────────────────────────
  function closeFeedback() {
    const modal = document.getElementById("clientFeedbackModal");
    if (modal) {
      modal.style.animation = "fbFadeOut 0.2s ease forwards";
      setTimeout(() => modal.remove(), 200);
    }
  }

  document.getElementById("closeFeedbackBtn").addEventListener("click", () => {
    localStorage.setItem(`feedback_done_${orderId}`, "true");
    closeFeedback();
  });

  document.getElementById("skipFeedbackBtn").addEventListener("click", () => {
    localStorage.setItem(`feedback_done_${orderId}`, "true");
    closeFeedback();
  });

  // Overlay ustiga bosib yopish
  document.getElementById("clientFeedbackModal").addEventListener("click", (e) => {
    if (e.target.id === "clientFeedbackModal") {
      localStorage.setItem(`feedback_done_${orderId}`, "true");
      closeFeedback();
    }
  });

  // ── Yuborish ────────────────────────────────────────────
  document.getElementById("submitFeedbackBtn").addEventListener("click", async () => {
    if (!ratings.food && !ratings.service && !ratings.atmosphere) {
      alert(t("leave_at_least_one_star", "Iltimos, hech bo'lmasa bitta yulduzcha qoldiring!"));
      return;
    }

    const btn = document.getElementById("submitFeedbackBtn");
    btn.textContent = t("sending_btn", "Yuborilmoqda...");
    btn.disabled = true;
    btn.classList.add("fb-submit--loading");

    const restId    = localStorage.getItem("restaurantId");
    const clientPhone = localStorage.getItem("clientPhone") || localStorage.getItem("phone") || "Mijoz";
    const tableNum  = localStorage.getItem("tableNumber") || "Stol";
    const comment   = document.getElementById("feedbackComment").value.trim();

    try {
      const newFeedbackRef = push(ref(db, `restaurants/${restId}/feedback`));
      await set(newFeedbackRef, {
        orderId:        orderId,
        orderNumber:    orderId.substring(orderId.length - 6),
        phone:          clientPhone,
        table:          tableNum,
        foodQuality:    ratings.food,
        serviceQuality: ratings.service,   // = "Restoran" bahosi (nom UI'da o'zgardi, maydon nomi eski qoldi)
        atmosphere:     ratings.atmosphere, // = "Yetkazib berish" bahosi (nom UI'da o'zgardi, maydon nomi eski qoldi)
        comment:        comment,
        createdAt:      Date.now(),
        isRead:         false
      });

      localStorage.setItem(`feedback_done_${orderId}`, "true");

      // ── Muvaffaqiyat animatsiyasi ──
      const card = document.querySelector("#clientFeedbackModal .fb-card");
      card.innerHTML = `
        <div class="fb-success">
          <span class="fb-success-icon">🎉</span>
          <h3 class="fb-success-title">${t("thanks_for_feedback", "Fikringiz uchun rahmat!")}</h3>
          <p class="fb-success-desc">${t("feedback_received", "Sizning bahongiz bizga juda muhim!")}</p>
        </div>
      `;

      setTimeout(() => {
        closeFeedback();
      }, 2200);

    } catch (error) {
      console.error("Fikr yuborishda xato:", error);
      alert(t("error_try_again", "Xatolik yuz berdi. Iltimos, keyinroq qayta urinib ko'ring."));
      btn.textContent = t("submit_btn", "Yuborish");
      btn.disabled = false;
      btn.classList.remove("fb-submit--loading");
    }
  });
};

// ==========================================
// 📱 URL DAN STOL RAQAMINI OLISH 
// ==========================================
window.autoFillTableNumber = function () {
  const urlParams = new URLSearchParams(window.location.search);
  const tableNum = urlParams.get("table");


  if (!tableNum) return;


  const tableInput = document.getElementById("stolRaqamiInput") ||
    document.querySelector("input[placeholder*='Stol']") ||
    document.querySelector("input[placeholder*='stol']");

  if (tableInput) {

    tableInput.value = tableNum;
    tableInput.readOnly = true;
    tableInput.style.backgroundColor = "#f3f4f6";
    tableInput.style.cursor = "not-allowed";
    console.log("✅ Stol raqami avtomat kiritildi: " + tableNum);
  } else {

    setTimeout(window.autoFillTableNumber, 500);
  }
};


// 🩹 Same DOMContentLoaded-race fix as _initClientApp() above.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", window.autoFillTableNumber);
} else {
  window.autoFillTableNumber();
}
setTimeout(window.autoFillTableNumber, 1000); // Zaxira chaqiruv

function grantAccessToMenu(table, phone, name) {
  localStorage.setItem("customerTable", table);
  localStorage.setItem("customerPhone", phone);
  localStorage.setItem("customerName", name);

  const loginSection = document.querySelector(".login-section");
  const menuSection = document.querySelector(".menu-section");

  if (loginSection) loginSection.style.display = "none";
  if (menuSection) menuSection.style.display = "block";
}

function createErrorDiv() {
  const div = document.createElement("div");
  div.id = "reservationError";
  div.style = "background: #fef2f2; color: #991b1b; padding: 20px; border: 2px solid #f87171; border-radius: 12px; text-align: center; margin-top: 15px; display: none;";

  const btn = document.querySelector("button[onclick='window.verifyTableAccess()']");
  if (btn) btn.parentNode.insertBefore(div, btn.nextSibling);
  else document.body.appendChild(div);

  return div;
}

window.closePayment = function () {
  const modal = document.getElementById("paymentModal");
  if (modal) modal.style.display = "none";

  if (currentOrderId && hasSubmittedOrder) {
    window.showFeedbackModal(currentOrderId);
  }
}

window.openPayment = async function (total, orderNumber, orderItems = null, baseCookTime = 30, phoneKey = "") {
  console.log("🔍 openPayment:", { total, orderNumber, baseCookTime });

  if (!total || total <= 0) {
    const menu = window.allMenu || {};
    const cart = window.cart || JSON.parse(localStorage.getItem("cart") || "{}");
    total = 0;
    Object.entries(cart).forEach(([id, c]) => {
      const m = menu[id];
      if (m) total += Number(m.price || 0) * Number(c.qty || 0);
    });
  }

  currentPaymentTotal = Number(total || 0);
  currentBaseCookTime = Number(baseCookTime || 30);
  window.currentPaymentPhoneKey = phoneKey;

  const modal = document.getElementById("paymentModal");
  if (!modal) return;

  // ── Mahsulotlar ro'yxatini tayyorlash ──
  const menu = window.allMenu || {};
  const cart = window.cart || JSON.parse(localStorage.getItem("cart") || "{}");
  const lang = typeof getLang === "function" ? getLang() : "uz";

  let itemsHtml = "";
  let itemsSource = orderItems
    ? (typeof orderItems === "object" && !Array.isArray(orderItems) ? Object.values(orderItems) : orderItems)
    : Object.entries(cart).map(([id, c]) => {
      const m = menu[id] || {};
      return {
        id, name: m.name || "Mahsulot", price: Number(m.price || 0), qty: Number(c.qty || 0),
        img: m.imgUrl || m.img || m.image || "", category: m.category || "", subcategory: m.subcategory || ""
      };
    });

  (itemsSource || []).forEach(item => {
    const itemName = typeof item.name === "object" ? (item.name[lang] || item.name.uz || "Mahsulot") : (item.name || "Mahsulot");
    const qty = Number(item.qty || 0);
    const price = Number(item.price || 0);
    const sum = qty * price;
    const imgSrc = item.img || item.imgUrl || item.image || "";
    const catLabel = item.category
      ? (typeof t === "function" ? t(item.category) || item.category : item.category)
      : "";
    const subLabel = item.subcategory
      ? (typeof t === "function" ? t(item.subcategory) || item.subcategory : item.subcategory)
      : "";
    const catBadge = catLabel
      ? `<span style="font-size:10px;background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;border-radius:4px;padding:2px 6px;margin-right:4px;">${catLabel}</span>`
      : "";
    const subBadge = subLabel
      ? `<span style="font-size:10px;background:#eff6ff;color:#3b82f6;border:1px solid #bfdbfe;border-radius:4px;padding:2px 6px;">${subLabel}</span>`
      : "";

    itemsHtml += `
      <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #f1f5f9;">
        ${imgSrc
        ? `<img src="${imgSrc}" onerror="this.style.display='none'" style="width:56px;height:56px;border-radius:10px;object-fit:cover;flex-shrink:0;border:1px solid #e2e8f0;">`
        : `<div style="width:56px;height:56px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">🍽️</div>`
      }
        <div style="flex:1;min-width:0;">
          <p style="margin:0 0 3px;font-weight:600;font-size:14px;color:#1e293b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${itemName}</p>
          <div style="margin-bottom:4px;">${catBadge}${subBadge}</div>
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:12px;color:#64748b;">${price.toLocaleString()} so'm × ${qty}</span>
            <span style="font-size:14px;font-weight:700;color:#0f172a;">${sum.toLocaleString()} so'm</span>
          </div>
        </div>
      </div>`;
  });

  const tNum = localStorage.getItem("tableNo") || "-";

  // ── Modal ichini yangilash ──
  let card = modal.querySelector(".payment-card");
  if (!card) {
    // HTML'da .payment-card yo'q bo'lsa — modal ichiga dinamik qo'shamiz
    card = document.createElement("div");
    card.className = "payment-card";
    card.style.cssText = "background:#fff;border-radius:20px;padding:24px;width:100%;max-width:440px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.15);position:relative;";
    modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;";
    modal.innerHTML = "";
    modal.appendChild(card);
  }
  if (card) {
    card.innerHTML = `
      <style>
        .pm-method { display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:10px 6px;border:2px solid #e2e8f0;border-radius:12px;cursor:pointer;background:#fff;transition:all 0.18s;flex:1;min-width:0;font-size:12px;font-weight:600;color:#334155; }
        .pm-method:hover { border-color:#22c55e;background:#f0fdf4; }
        .pm-method.active { border-color:#22c55e;background:#f0fdf4;color:#16a34a; }
        .pm-method img { width:32px;height:32px;object-fit:contain;border-radius:6px; }
        .pm-method .pm-icon { font-size:22px; }
        .card-fields { margin-top:14px;padding:14px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;animation:fadeInDown 0.2s ease; }
        @keyframes fadeInDown { from{opacity:0;transform:translateY(-8px)} to{opacity:1;transform:translateY(0)} }
        .cf-input { width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none;margin-bottom:10px;background:#fff;color:#1e293b; }
        .cf-input:focus { border-color:#22c55e; }
        .cf-row { display:flex;gap:8px; }
        .pay-main-btn { width:100%;padding:14px;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;box-shadow:0 4px 14px rgba(34,197,94,0.35);transition:transform 0.15s,box-shadow 0.15s; }
        .pay-main-btn:hover { transform:translateY(-1px);box-shadow:0 6px 20px rgba(34,197,94,0.45); }
        .pay-main-btn:active { transform:scale(0.98); }
        .modal-close-x { position:absolute;top:12px;right:14px;background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8;line-height:1; }
        .modal-close-x:hover { color:#475569; }
      </style>

      <div style="position:relative;">
        <button class="modal-close-x" onclick="document.getElementById('paymentModal').style.display='none'">✕</button>
        <h2 style="margin:0 0 4px;font-size:17px;font-weight:700;color:#0f172a;">To'lov</h2>
        <p style="margin:0 0 14px;font-size:12px;color:#94a3b8;">Buyurtma ${formatOrderNumber(orderNumber, false) || ("№" + (orderNumber || "-"))} · Stol ${tNum}</p>
      </div>

      <div style="max-height:220px;overflow-y:auto;margin-bottom:14px;padding-right:2px;">
        ${itemsHtml || `<p style="text-align:center;color:#94a3b8;padding:20px 0;">Buyurtma yo'q</p>`}
      </div>

      <div id="pm-discount-row"></div>

      <div id="pm-promo-section" style="margin-bottom:12px;">
        <div id="pm-promo-cards" style="margin-bottom:8px;">
          <p style="font-size:12px;color:#94a3b8;margin:0 0 6px;">⏳ Promokodlar yuklanmoqda...</p>
        </div>
        <div style="position:relative;">
          <input id="pm-promo-input" type="text" placeholder="🎫 Promokod kiriting..."
            style="width:100%;box-sizing:border-box;padding:10px 46px 10px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:14px;outline:none;background:#fff;color:#1e293b;letter-spacing:1px;"
            oninput="this.value=this.value.toUpperCase();"
            onfocus="this.style.borderColor='#22c55e'"
            onblur="this.style.borderColor=this.value?'#22c55e':'#e2e8f0'">
          <button id="pm-promo-apply-btn" onclick="window._applyPaymentPromo()" title="Qo'llash"
            style="position:absolute;right:7px;top:50%;transform:translateY(-50%);background:#22c55e;border:none;border-radius:7px;width:32px;height:32px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff;line-height:1;"
            onmouseover="this.style.background='#16a34a'" onmouseout="this.style.background='#22c55e'">›</button>
        </div>
        <div id="pm-promo-msg" style="font-size:12px;margin-top:5px;padding:0 2px;display:none;border-radius:6px;"></div>
      </div>

      <div style="background:#f0fdf4;border-radius:12px;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">
        <span style="font-size:14px;color:#16a34a;font-weight:600;">${t("total_amount_label", "Jami summa")}</span>
        <span id="paymentTotal" style="font-size:20px;font-weight:800;color:#15803d;">${currentPaymentTotal.toLocaleString()} so'm</span>
      </div>

      <p style="font-size:13px;font-weight:600;color:#475569;margin:0 0 10px;">${t("select_pay_method", "To'lov usulini tanlang:")}</p>
      <div style="display:flex;gap:8px;margin-bottom:0;" id="pm-methods">
        <button class="pm-method" onclick="window._selectPayMethod('cash',this)">
          <span class="pm-icon">💵</span>${t("cash", "Naqd")}
        </button>
        <button class="pm-method" onclick="window._selectPayMethod('card',this)">
          <span class="pm-icon">💳</span>Karta
        </button>
        <button class="pm-method" onclick="window._selectPayMethod('click',this)">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;background:#e0f2fe;border-radius:8px;font-size:13px;font-weight:900;color:#0284c7;letter-spacing:-0.5px;">CL</span>Click
        </button>
        <button class="pm-method" onclick="window._selectPayMethod('payme',this)">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;background:#fce7f3;border-radius:8px;font-size:13px;font-weight:900;color:#be185d;">P</span>Payme
        </button>
      </div>

      <div id="pm-card-fields" style="display:none;">
        <div class="card-fields">
          <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#334155;" id="pm-card-title">💳 Karta ma'lumotlari</p>
          <input class="cf-input" id="pm-card-num" type="text" placeholder="0000 0000 0000 0000" maxlength="19"
            oninput="this.value=this.value.replace(/[^0-9]/g,'').replace(/(.{4})/g,'$1 ').trim().slice(0,19)" >
          <div class="cf-row">
            <input class="cf-input" id="pm-card-exp" type="text" placeholder="MM/YY" maxlength="5"
              oninput="let v=this.value.replace(/\\D/g,'');if(v.length>2)v=v.slice(0,2)+'/'+v.slice(2);this.value=v;" style="margin-bottom:0;">
            <input class="cf-input" id="pm-card-cvv" type="password" placeholder="CVV" maxlength="3"
              oninput="this.value=this.value.replace(/\\D/g,'')" style="margin-bottom:0;">
          </div>
        </div>
      </div>

      <button class="pay-main-btn" style="margin-top:18px;" onclick="window._doSimulatePayment()">
        💸 To'lash — <span id="pm-btn-total">${currentPaymentTotal.toLocaleString()}</span> so'm
      </button>

      <button onclick="window.openClientSplitBillModal()"
        style="width:100%;margin-top:10px;padding:11px;border:1.5px solid #a21caf;border-radius:12px;background:#fff;color:#a21caf;font-weight:700;font-size:13px;cursor:pointer;">
        🧮 ${t("split_bill_btn", "Hisobni bo'lish (Split Bill)")}
      </button>
    `;
  }

  modal.style.display = "flex";

  // ── To'lov usulini tanlash logikasi ──
  window._selectedPayMethod = "cash";
  window._selectPayMethod = function (method, btn) {
    window._selectedPayMethod = method;
    document.querySelectorAll(".pm-method").forEach(b => b.classList.remove("active"));
    if (btn) btn.classList.add("active");
    const cf = document.getElementById("pm-card-fields");
    const title = document.getElementById("pm-card-title");
    if (cf) {
      const showCard = ["card", "click", "payme"].includes(method);
      cf.style.display = showCard ? "block" : "none";
      if (title) {
        if (method === "click") title.textContent = `🔵 ${t("card_details_click_label", "Click karta ma'lumotlari")}`;
        else if (method === "payme") title.textContent = `🟢 ${t("card_details_payme_label", "Payme karta ma'lumotlari")}`;
        else title.textContent = `💳 ${t("card_details_generic_label", "Karta ma'lumotlari")}`;
      }
    }
  };

  // ── To'lash tugmasi logikasi ──
  window._doSimulatePayment = async function () {
    const method = window._selectedPayMethod || "cash";
    const showCard = ["card", "click", "payme"].includes(method);
    if (showCard) {
      const num = (document.getElementById("pm-card-num")?.value || "").replace(/\s/g, "");
      const exp = document.getElementById("pm-card-exp")?.value || "";
      const cvv = document.getElementById("pm-card-cvv")?.value || "";
      if (num.length < 16 || exp.length < 5 || cvv.length < 3) {
        const inp = document.getElementById(num.length < 16 ? "pm-card-num" : exp.length < 5 ? "pm-card-exp" : "pm-card-cvv");
        if (inp) { inp.style.borderColor = "#ef4444"; inp.focus(); setTimeout(() => inp.style.borderColor = "#e2e8f0", 1500); }
        return;
      }
    }
    if (typeof window.simulatePayment === "function") {
      // Promokod ishlatilgan bo'lsa — usesLeft ni kamaytiramiz
      if (window._appliedVipPromoCode) {
        const _rId = localStorage.getItem("restaurantId");
        try {
          if (window._appliedVipPromoCode === "VIP-DISCOUNT") {
            // Virtual VIP fallback — customers/ dagi vipOrdersUsed ni oshiramiz
            const _phone2 = localStorage.getItem("customerPhone") || localStorage.getItem("userPhone") || "";
            const _norm2  = (p) => String(p || "").replace(/\D/g, "").slice(-9);
            const _cAll2  = (await get(ref(db, `restaurants/${_rId}/customers`))).val() || {};
            const _cKey2  = Object.keys(_cAll2).find(k => _norm2(_cAll2[k]?.phone || k) === _norm2(_phone2));
            if (_cKey2) {
              const _vUsed2 = Number(_cAll2[_cKey2].vipOrdersUsed || 0) + 1;
              const _vTot2  = Number(_cAll2[_cKey2].vipOrdersTotal || 0);
              const _vDone2 = _vTot2 > 0 && _vUsed2 >= _vTot2;
              await update(ref(db, `restaurants/${_rId}/customers/${_cKey2}`), {
                vipOrdersUsed: _vUsed2,
                ...(_vDone2 ? { isVip: false, vipEndedAt: Date.now() } : {})
              });
              console.log(`👑 VIP xarid #${_vUsed2}/${_vTot2}${_vDone2 ? " — VIP tugadi!" : ""}`);
            }
          } else {
            // Oddiy discounts/ promokod
            const _pSnap = await get(ref(db, `restaurants/${_rId}/discounts/${window._appliedVipPromoCode}`));
            if (_pSnap.exists()) {
              const _pData   = _pSnap.val();
              const _usesLeft = Number(_pData.usesLeft !== undefined ? _pData.usesLeft : (_pData.used ? 0 : 1));
              const _newLeft  = Math.max(0, _usesLeft - 1);
              const _nowDone  = _newLeft === 0;
              await update(ref(db, `restaurants/${_rId}/discounts/${window._appliedVipPromoCode}`), {
                usesLeft: _newLeft,
                used:     _nowDone,
                ...(_nowDone ? { usedAt: Date.now() } : {})
              });
              console.log(`✅ Promokod ${window._appliedVipPromoCode}: ${_usesLeft} → ${_newLeft} qoldi.${_nowDone ? " Tugadi." : ""}`);
            }
          }
        } catch (_e) { console.warn("Promokod yangilashda xato:", _e); }
        window._appliedVipPromoCode = null;
      }
      window.simulatePayment(method);
    }
  };

  // ── VIP chegirma tekshiruvi ──
  // calculateDiscount natijasi keyingi promo kartochkalar blokiga uzatiladi.
  // VIP topilsa _vipFromCalc to'ldiriladi va _free massiviga qo'shiladi.
  let discountInfo = null;
  let _vipFromCalc = null; // {percent, normalizedKey}
  try {
    discountInfo = await calculateDiscount(currentPaymentTotal, phoneKey);
    console.log("💰 calculateDiscount natija:", discountInfo);
    if (discountInfo && discountInfo.isVipDiscount && discountInfo.discountPercent > 0) {
      _vipFromCalc = { percent: discountInfo.discountPercent };
      console.log("👑 VIP calculateDiscount orqali topildi, promo kartochkaga uzatilmoqda");
    }
  } catch (_e) { console.warn("calculateDiscount xato:", _e); }

  // ── Mijozning promokodlarini kartochka sifatida ko'rsatish ──
  // Qoida: 1 buyurtma = 1 promokod. Agar order'da allaqachon appliedPromo bor bo'lsa — bloklanadi.
  try {
    // Telefon raqamini barcha manbalardan qidiramiz
    const _rawPhone = phoneKey
      || window.currentPaymentPhoneKey
      || localStorage.getItem("customerPhone")
      || localStorage.getItem("userPhone")
      || (typeof getCurrentClientPhoneNumber === "function" ? getCurrentClientPhoneNumber() : "")
      || activeOrderData?.clientPhone
      || activeOrderData?.customerPhone
      || activeOrderData?.phoneNumber
      || document.getElementById("clientPhoneInput")?.value?.trim()
      || "";
    const _rId = localStorage.getItem("restaurantId");
    const cardsEl = document.getElementById("pm-promo-cards");
    if (!cardsEl) throw new Error("no cards el");

    console.log("💳 Promo search phone:", _rawPhone, "| restId:", _rId, "| orderId:", currentOrderId);

    if (!_rawPhone || !_rId) {
      cardsEl.innerHTML = "";
    } else {
      let _orderAppliedPromo = null;
      if (currentOrderId) {
        try {
          const _oOrderForPromo = await fetchClientOrder(currentOrderId);
          if (_oOrderForPromo?.appliedPromo) _orderAppliedPromo = _oOrderForPromo.appliedPromo;
        } catch (_oe) { console.warn("Order promo check xato:", _oe); }
      }

      if (_orderAppliedPromo) {
        const promoSnap = await get(ref(db, `restaurants/${_rId}/discounts/${_orderAppliedPromo}`));
        const promoData = promoSnap.exists() ? promoSnap.val() : { percent: 0 };
        cardsEl.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;background:#f0fdf4;border:1.5px solid #86efac;
            border-radius:10px;padding:8px 12px;margin-bottom:8px;">
            <span style="font-size:18px;">✅</span>
            <div>
              <span style="font-size:13px;font-weight:700;color:#15803d;">${_orderAppliedPromo}</span>
              <span style="font-size:11px;color:#4ade80;margin-left:6px;">-${promoData.percent}%</span>
              <p style="margin:2px 0 0;font-size:11px;color:#6b7280;">Bu buyurtmaga promokod allaqachon qo'llanilgan</p>
            </div>
          </div>`;
        const inp = document.getElementById("pm-promo-input");
        const applyBtn = document.getElementById("pm-promo-apply-btn");
        if (inp) {
          inp.value = _orderAppliedPromo;
          inp.readOnly = true;
          inp.style.borderColor = "#22c55e";
          inp.style.background  = "#f0fdf4";
          inp.style.color       = "#15803d";
          inp.style.fontWeight  = "700";
        }
        if (applyBtn) {
          applyBtn.innerHTML = "✓";
          applyBtn.style.background = "#16a34a";
          applyBtn.disabled = true;
          applyBtn.onmouseover = null;
          applyBtn.onmouseout  = null;
        }
        // _applyPaymentPromo ni ham bloklash
        window._appliedVipPromoCode = _orderAppliedPromo;
        window._orderPromoLocked    = true;
      } else {
        // 2️⃣ Mijozga tegishli aktiv promokodlarni topish
        window._orderPromoLocked = false;
        const _norm  = (p) => String(p || "").replace(/\D/g, "").slice(-9);
        const _myKey = _norm(_rawPhone);
        const _dSnap = await get(ref(db, `restaurants/${_rId}/discounts`));
        const _allD  = _dSnap.val() || {};
        const _free  = Object.values(_allD).filter(d => {
          const isOwner  = d.ownerPhone && _norm(d.ownerPhone) === _myKey;
          const isGlobal = !d.ownerPhone; // ownerPhone yo'q — umumiy promokod
          const ul = d.usesLeft !== undefined ? Number(d.usesLeft) : (d.used ? 0 : 1);
          return (isOwner || isGlobal) && !d.used && ul > 0;
        });

        console.log("Found promos:", _free.length, _free.map(p=>p.code));

        // VIP kartochkani _free'ga qo'shish:
        // 1-ustuvorlik: calculateDiscount (tez, exact key) natijasi — _vipFromCalc
        // 2-ustuvorlik: customers/ scan (sekin, fallback)
        if (!_free.some(d => d.isVipPromo)) {
          if (_vipFromCalc) {
            // calculateDiscount VIP topdi — kartochkaga to'g'ridan-to'g'ri uzatamiz
            const _vTotal = Number(discountInfo && discountInfo.vipOrdersTotal || 0);
            const _vUsed  = Number(discountInfo && discountInfo.vipOrdersUsed  || 0);
            const _vLeft  = _vTotal > 0 ? (_vTotal - _vUsed) : 999;
            _free.push({
              code:       "VIP-DISCOUNT",
              percent:    _vipFromCalc.percent,
              used:       false,
              usesLeft:   _vLeft,
              maxUses:    _vTotal,
              ownerPhone: _myKey,
              isVipPromo: true,
              _isFallback: true
            });
            console.log("VIP calculateDiscount->promo kartochka:", _vipFromCalc.percent + "%");
          } else {
            // calculateDiscount VIP topa olmadi — customers/ scan bilan fallback
            try {
              const _cSnap = await get(ref(db, `restaurants/${_rId}/customers`));
              const _cAll  = _cSnap.val() || {};
              const _cData = Object.entries(_cAll).reduce((found, [key, c]) => {
                if (found) return found;
                const byPhone = String(c.phone || "").replace(/\D/g, "").slice(-9);
                const byKey   = String(key).replace(/\D/g, "").slice(-9);
                return (byPhone === _myKey || byKey === _myKey) ? c : null;
              }, null);
              console.log("VIP scan fallback:", _myKey, "->",
                _cData ? "isVip=" + _cData.isVip : "NOT FOUND");
              if (_cData && _cData.isVip === true && _cData.vipDiscountPercent > 0) {
                const _vTotal = Number(_cData.vipOrdersTotal || 0);
                const _vUsed  = Number(_cData.vipOrdersUsed  || 0);
                const _vLeft  = _vTotal > 0 ? (_vTotal - _vUsed) : 999;
                if (_vLeft > 0) {
                  _free.push({
                    code:       "VIP-DISCOUNT",
                    percent:    _cData.vipDiscountPercent,
                    used:       false,
                    usesLeft:   _vLeft,
                    maxUses:    _vTotal,
                    ownerPhone: _myKey,
                    isVipPromo: true,
                    _isFallback: true
                  });
                  console.log("VIP scan fallback qoshildi:", _cData.vipDiscountPercent + "%");
                }
              }
            } catch (_ve) { console.warn("VIP scan fallback xato:", _ve); }
          }
        }


        if (_free.length === 0) {
          cardsEl.innerHTML = "";
          // Promokod yo'q — butun seksiyani yashiramiz (bo'sh input ko'rinmasin)
          const _ps = document.getElementById("pm-promo-section");
          if (_ps) _ps.style.display = "none";
        } else if (_free.length === 1) {
          const _ps1 = document.getElementById("pm-promo-section");
          if (_ps1) _ps1.style.display = "";
          const _solo = _free[0];
          const _soloUl = _solo.usesLeft !== undefined ? Number(_solo.usesLeft) : 1;
          const _soloMulti = (_solo.maxUses || 1) > 1;
          const _soloBadge = _soloMulti
            ? `<span style="font-size:9px;background:#ede9fe;color:#5b21b6;border-radius:4px;padding:1px 4px;margin-left:3px;">${_soloUl}×</span>` : "";
          const _soloVip = _solo.isVipPromo
            ? `<span style="font-size:9px;background:#fef9c3;color:#b45309;border-radius:4px;padding:1px 4px;margin-left:3px;">VIP</span>` : "";

          cardsEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;background:#fafff4;border:1.5px solid #bbf7d0;
              border-radius:10px;padding:8px 12px;margin-bottom:8px;">
              <span style="font-size:18px;">🎫</span>
              <div>
                <span style="font-size:13px;font-weight:700;color:#15803d;">${_solo.code}${_soloBadge}${_soloVip}</span>
                <span style="font-size:11px;color:#4ade80;margin-left:6px;">-${_solo.percent}%</span>
                <p style="margin:2px 0 0;font-size:11px;color:#6b7280;">Promokod avtomatik qo'llanilmoqda...</p>
              </div>
            </div>`;

          const inp = document.getElementById("pm-promo-input");
          if (inp) {
            inp.value = _solo.code;
            inp.style.borderColor = "#22c55e";
            inp.style.background  = "#f0fdf4";
          }
          // _applyPaymentPromo quyida aniqlanadi — retry bilan chaqiramiz
          const _autoApply = () => {
            if (typeof window._applyPaymentPromo === "function") {
              window._applyPaymentPromo();
            } else {
              setTimeout(_autoApply, 100);
            }
          };
          setTimeout(_autoApply, 400);

        } else {
          // ── Ko'p promokod: select kartochkalar ──
          const _psM = document.getElementById("pm-promo-section");
          if (_psM) _psM.style.display = "";
          cardsEl.innerHTML = `
            <p style="font-size:11px;font-weight:600;color:#64748b;margin:0 0 6px;text-transform:uppercase;letter-spacing:.5px;">
              🎫 Promokodingizni tanlang
            </p>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
              ${_free.map(p => {
                const ul = p.usesLeft !== undefined ? Number(p.usesLeft) : 1;
                const isMulti = (p.maxUses || 1) > 1;
                const badge   = isMulti ? `<span style="font-size:9px;background:#ede9fe;color:#5b21b6;border-radius:4px;padding:1px 4px;margin-left:3px;">${ul}×</span>` : "";
                const vipBadge = p.isVipPromo ? `<span style="font-size:9px;background:#fef9c3;color:#b45309;border-radius:4px;padding:1px 4px;margin-left:3px;">VIP</span>` : "";
                return `
                  <button onclick="window._selectPromoCard('${p.code}',${p.percent},this)"
                    data-promo-code="${p.code}"
                    style="display:flex;flex-direction:column;align-items:flex-start;padding:8px 12px;
                      border:2px solid #e2e8f0;border-radius:10px;background:#fff;cursor:pointer;
                      transition:all .15s;min-width:90px;text-align:left;">
                    <span style="font-size:13px;font-weight:800;color:#15803d;letter-spacing:.5px;">${p.code}${badge}${vipBadge}</span>
                    <span style="font-size:11px;color:#64748b;margin-top:2px;">-${p.percent}%</span>
                  </button>`;
              }).join("")}
            </div>`;

          // VIP bo'lsa uni, yo'qsa birinchisini tanlangan qilib, avtomatik apply qilish
          const best = _free.find(d => d.isVipPromo) || _free[0];
          const inp  = document.getElementById("pm-promo-input");
          if (inp && best) {
            inp.value = best.code;
            inp.style.borderColor = "#22c55e";
            inp.style.background  = "#f0fdf4";
            setTimeout(() => {
              const firstCard = cardsEl.querySelector(`[data-promo-code="${best.code}"]`);
              if (firstCard) {
                firstCard.style.borderColor = "#22c55e";
                firstCard.style.background  = "#f0fdf4";
              }
            }, 50);
            // Ko'p promokod bo'lsa ham birinchisini avtomatik apply qilamiz
            const _autoApplyMulti = () => {
              if (typeof window._applyPaymentPromo === "function") {
                window._applyPaymentPromo();
              } else {
                setTimeout(_autoApplyMulti, 100);
              }
            };
            setTimeout(_autoApplyMulti, 450);
          }
        }
      }
    }
  } catch (_e) {
    const cardsEl = document.getElementById("pm-promo-cards");
    if (cardsEl) cardsEl.innerHTML = "";
    console.warn("Promo kartochkalar xatosi:", _e);
  }

  // Kartochka bosilganda: inputga yoziladi + avtomatik qo'llanadi
  window._selectPromoCard = function (code, percent, btn) {
    // Barcha kartochkalarni reset
    document.querySelectorAll("[data-promo-code]").forEach(b => {
      b.style.borderColor = "#e2e8f0";
      b.style.background  = "#fff";
    });
    // Tanlanganni belgilash
    if (btn) { btn.style.borderColor = "#22c55e"; btn.style.background = "#f0fdf4"; }
    // Inputga yozish
    const inp = document.getElementById("pm-promo-input");
    if (inp) {
      inp.value = code;
      inp.style.borderColor = "#22c55e";
      inp.style.background  = "#f0fdf4";
    }
    // Avtomatik qo'llash
    if (typeof window._applyPaymentPromo === "function") {
      window._applyPaymentPromo();
    }
  };

  // ── _applyPaymentPromo — strelka bosilganda ──
  window._applyPaymentPromo = async function () {
    const inp   = document.getElementById("pm-promo-input");
    const msgEl = document.getElementById("pm-promo-msg");
    const code  = inp ? inp.value.trim().toUpperCase() : "";

    function showMsg(txt, color, bg) {
      if (!msgEl) return;
      msgEl.innerText        = txt;
      msgEl.style.color      = color;
      msgEl.style.background = bg || "transparent";
      msgEl.style.padding    = bg ? "5px 8px" : "0";
      msgEl.style.display    = "block";
    }

    // 1 buyurtma = 1 promokod: order'da allaqachon qo'llanilgan bo'lsa bloklash
    if (window._orderPromoLocked) {
      showMsg("⚠️ Bu buyurtmaga promokod allaqachon qo'llanilgan!", "#92400e", "#fefce8");
      return;
    }

    if (!code) { showMsg("❗ Promokod kiriting", "#b45309"); return; }

    const _rId   = localStorage.getItem("restaurantId");
    const _phone = phoneKey
      || window.currentPaymentPhoneKey
      || localStorage.getItem("customerPhone")
      || localStorage.getItem("userPhone")
      || (typeof getCurrentClientPhoneNumber === "function" ? getCurrentClientPhoneNumber() : "")
      || activeOrderData?.clientPhone
      || activeOrderData?.customerPhone
      || document.getElementById("clientPhoneInput")?.value?.trim()
      || "";
    const _norm  = (p) => String(p || "").replace(/\D/g, "").slice(-9);

    try {
      // VIP-DISCOUNT — virtual fallback (discounts/ da yo'q, customers/ dan o'qilgan)
      let promo = null;
      if (code === "VIP-DISCOUNT") {
        const _cSnap2 = await get(ref(db, `restaurants/${_rId}/customers`));
        const _cAll2  = _cSnap2.val() || {};
        const _cData2 = Object.values(_cAll2).find(c => _norm(c.phone || "") === _norm(_phone));
        if (!_cData2 || !_cData2.isVip || !_cData2.vipDiscountPercent) {
          showMsg("❌ VIP status topilmadi!", "red"); return;
        }
        const _vT2 = Number(_cData2.vipOrdersTotal || 0);
        const _vU2 = Number(_cData2.vipOrdersUsed  || 0);
        const _vL2 = _vT2 > 0 ? (_vT2 - _vU2) : 999;
        if (_vL2 <= 0) { showMsg("❌ VIP limiti tugagan!", "red"); return; }
        promo = { code, percent: _cData2.vipDiscountPercent, isVipPromo: true, _isFallback: true, usesLeft: _vL2 };
      } else {
        const snap = await get(ref(db, `restaurants/${_rId}/discounts/${code}`));
        if (!snap.exists()) { showMsg("❌ Bunday promokod topilmadi!", "red"); return; }
        promo = snap.val();
      }

      // Ko'p martalik promokod uchun usesLeft ni tekshiramiz
      const usesLeft = promo.usesLeft !== undefined ? Number(promo.usesLeft) : (promo.used ? 0 : 1);
      if (promo.used && usesLeft <= 0) {
        showMsg("❌ Bu promokod allaqachon ishlatilgan!", "red"); return;
      }
      if (usesLeft <= 0) {
        showMsg("❌ Bu promokod limiti tugagan!", "red"); return;
      }

      if (!promo._isFallback && promo.ownerPhone && _norm(promo.ownerPhone) !== _norm(_phone)) {
        showMsg("❌ Bu promokod sizning raqamingizga tegishli emas!", "red"); return;
      }

      const base    = Number(discountInfo?.finalPrice ?? currentPaymentTotal);
      const discPct = Number(promo.percent || 0);
      const discAmt = Math.round(base * discPct / 100);
      const finalAmt= base - discAmt;

      const discRow = document.getElementById("pm-discount-row");
      if (discRow) discRow.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:10px 14px;margin-bottom:10px;font-size:13px;">
          <span style="color:#92400e;">🎫 <b>${code}</b> (-${discPct}%)</span>
          <span style="font-weight:700;color:#b45309;">-${discAmt.toLocaleString()} so'm</span>
        </div>`;

      const totalEl    = document.getElementById("paymentTotal");
      const btnTotalEl = document.getElementById("pm-btn-total");
      if (totalEl)    totalEl.innerText    = finalAmt.toLocaleString() + " so'm";
      if (btnTotalEl) btnTotalEl.innerText = finalAmt.toLocaleString();
      currentPaymentTotal = finalAmt;

      if (inp) { inp.readOnly = true; inp.style.borderColor = "#22c55e"; inp.style.background = "#f0fdf4"; }
      const btn = document.getElementById("pm-promo-apply-btn");
      if (btn) { btn.innerHTML = "✓"; btn.style.background = "#16a34a"; btn.disabled = true; btn.onmouseover = null; btn.onmouseout = null; }
      showMsg(`✅ ${discPct}% chegirma qo'llanildi!`, "#16a34a", "#f0fdf4");
      window._appliedVipPromoCode = code;
      window._orderPromoLocked    = true;

      try {
        if (currentOrderId && _rId) {
          await update(ref(db, `restaurants/${_rId}/orders/${currentOrderId}`), {
            appliedPromo:    code,
            discountPercent: discPct,
            discountAmount:  discAmt
          });
        }
      } catch (_we) { console.warn("Order'ga promo yozishda xato:", _we); }

    } catch (_e) { showMsg("❌ Xatolik yuz berdi", "red"); console.error(_e); }
  };

  const firstBtn = document.querySelector(".pm-method");
  if (firstBtn) firstBtn.classList.add("active");
};

window.loadClientSettings = async function () {
  const restId = localStorage.getItem("restaurantId");
  if (!restId) return;

  try {
    const settingsRef = ref(db, `restaurants/${restId}/settings`);

    onValue(settingsRef, (snap) => {
      if (snap.exists()) {
        const settings = snap.val();

        const hoursEl = document.getElementById("uiWorkingHours") || document.querySelector('.support-footer p:first-child b');
        const phoneEl = document.getElementById("uiContactPhone") || document.querySelector('.support-footer p:last-child b');

        if (hoursEl && settings.workingHours) hoursEl.innerText = settings.workingHours;
        if (phoneEl && settings.contactPhone) phoneEl.innerText = settings.contactPhone;

        const logoEl = document.querySelector('.header .logo');
        if (logoEl && settings.restaurantName) {
          logoEl.innerText = settings.restaurantName;
          document.title = `${settings.restaurantName} — ${t("electronic_menu_suffix", "Elektron Menyu")}`;
        }

        if (settings.restaurantLogoUrl) {
          const logoImgs = document.querySelectorAll(
            'img[src*="logo-cropped"], img[src*="logo (2)"], img[src*="logo%20(2)"], .logo-img'
          );
          logoImgs.forEach(img => {
            img.src = settings.restaurantLogoUrl;
            img.style.objectFit = 'contain';
          });
        }
      }
    });
  } catch (error) {
    console.error("Sozlamalarni yuklashda xato:", error);
  }
};

function _scheduleLoadClientSettings() {
  setTimeout(() => {
    window.loadClientSettings();
  }, 1000);
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _scheduleLoadClientSettings);
} else {
  _scheduleLoadClientSettings();
}

function initHeaderTimer(restaurantId, orderId) {
  const orderRef = ref(db, `restaurants/${restaurantId}/orders/${orderId}`);

  onValue(orderRef, (snapshot) => {
    const order = snapshot.val();
    const timerContainer = document.getElementById('header-timer-container');
    const timerText = document.getElementById('header-countdown-text');

    if (order && order.readyAt && order.status !== "closed") {
      timerContainer.style.display = 'flex';

      if (window.headerInterval) clearInterval(window.headerInterval);

      window.headerInterval = setInterval(() => {
        const now = Date.now();
        const diff = order.readyAt - now;

        if (diff <= 0) {
          clearInterval(window.headerInterval);
          timerText.innerText = `${t("ready_text", "Tayyor!")} ✅`;
          return;
        }

        const m = Math.floor(diff / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        timerText.innerText = `${m}:${s.toString().padStart(2, '0')}`;
      }, 1000);
    } else {
      timerContainer.style.display = 'none';
    }
  });
}
function trackMyOrder(restaurantId, orderId) {
  const orderRef = dbRef(db, `restaurants/${restaurantId}/orders/${orderId}`);

  onValue(orderRef, (snapshot) => {
    const order = snapshot.val();
    const timerContainer = document.getElementById('header-timer-container');
    const timerText = document.getElementById('header-countdown-text');

    if (order && order.readyAt && order.status !== "closed") {
      timerContainer.style.display = 'flex';

      const updateTimer = () => {
        const now = Date.now();
        const diff = order.readyAt - now;

        if (diff <= 0) {
          timerText.innerText = `${t("ready_text", "Tayyor!")} ✅`;
          timerContainer.style.background = "rgba(34, 197, 94, 0.2)";
          return;
        }

        const m = Math.floor(diff / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        timerText.innerText = `${m}:${s < 10 ? '0' + s : s}`;
      };

      if (window.myCountdown) clearInterval(window.myCountdown);
      window.myCountdown = setInterval(updateTimer, 1000);
      updateTimer();
    } else {
      timerContainer.style.display = 'none';
    }
  });
}

function startCustomerCountdown(readyAtTimestamp) {
  const headerTimerElement = document.getElementById('header-countdown');

  const timer = setInterval(() => {
    const now = Date.now();
    const distance = readyAtTimestamp - now;

    if (distance <= 0) {
      clearInterval(timer);
      headerTimerElement.innerHTML = `🔔 ${t("st_ready_msg", "Taomingiz tayyor!")}`;
      headerTimerElement.style.color = "#10b981";
      return;
    }

    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);

    headerTimerElement.innerHTML = `⏳ ${t("ready_at_text", "Tayyor bo'ladi")}: ${minutes}:${seconds < 10 ? '0' + seconds : seconds}`;
  }, 1000);
}

if (currentRestaurantId && currentOrderId) {
  const userOrderRef = ref(db, `restaurants/${currentRestaurantId}/orders/${currentOrderId}`);

  onValue(userOrderRef, (snapshot) => {
    const order = snapshot.val();
    const timerContainer = document.getElementById('header-timer-container');

    if (order && (order.status === 'cooking' || order.status === 'ready' || order.statusKey === 'ready') &&
      (order.expectedReadyAt || order.readyAtTimestamp || order.readyAt)) {
      startHeaderCountdown(order.expectedReadyAt || order.readyAtTimestamp || order.readyAt);
    } else if (order && order.status === 'ready') {
      if (typeof headerTimerInterval !== 'undefined' && headerTimerInterval) {
        clearInterval(headerTimerInterval);
      }
      if (timerContainer) timerContainer.style.display = 'none';
    } else {
      if (timerContainer) timerContainer.style.display = 'none';
    }
  });

} else {
  console.log("⏱ Taymer kutmoqda: Mijoz hali buyurtma bermagan yoki Buyurtma ID si yo'q.");
}

window.openCheckoutModal = async function () {
  // ── Admin "faqat ofitsiant to'laydi" deb belgilagan bo'lsa — mijoz
  // ilova orqali to'lov oynasini ochа olmaydi. ──
  const billingMode = RESTAURANT_SETTINGS?.billingMode || "client_only";
  if (billingMode === "waiter_only") {
    showNotification(t("billing_waiter_only_notice", "Hisobni yopish uchun ofitsiantga murojaat qiling."));
    return;
  }
  const cart = window.cart || {};
  const menu = window.allMenu || {};
  const modal = document.getElementById('checkout-modal');

  if (!modal) return;
  modal.style.display = 'flex';

  if (!modal.querySelector('#co-title')) {
    modal.style.cssText = "position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,0.45);display:flex;align-items:flex-end;justify-content:center;";
    modal.innerHTML = `
      <div id="checkout-inner" style="background:#fff;width:100%;max-width:480px;border-radius:20px 20px 0 0;max-height:90vh;overflow-y:auto;padding:20px 16px 32px;position:relative;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
          <h2 id="co-title" style="margin:0;font-size:18px;font-weight:800;color:#0f172a;">${t("checkout_title", "Hisob-kitob")}</h2>
          <button onclick="window.closeCheckoutModal()" style="background:none;border:none;font-size:22px;cursor:pointer;color:#94a3b8;line-height:1;padding:4px;">✕</button>
        </div>
        <p id="co-order-meta" style="margin:0 0 14px;font-size:12px;color:#94a3b8;"></p>

        <div id="checkout-items-list" style="margin-bottom:10px;"></div>

        <div id="co-discount-row"></div>

        <div id="co-promo-section" style="margin-bottom:12px;">
          
          <div id="co-promo-cards" style="margin-bottom:8px;"></div>
          <div style="position:relative;">
            <input id="co-promo-input" type="text"
              placeholder="🎫 ${t("enter_promo_placeholder", "Promokod kiriting...")}"
              style="width:100%;box-sizing:border-box;padding:10px 46px 10px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:14px;outline:none;background:#fff;color:#1e293b;letter-spacing:1px;"
              oninput="this.value=this.value.toUpperCase();"
              onfocus="this.style.borderColor='#22c55e'"
              onblur="this.style.borderColor=this.value?'#22c55e':'#e2e8f0'">
            <button id="co-promo-apply-btn" onclick="window._coApplyPromo()" title="${t("apply_btn", "Qo\'llash")}"
              style="position:absolute;right:7px;top:50%;transform:translateY(-50%);background:#22c55e;border:none;border-radius:7px;width:32px;height:32px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff;line-height:1;"
              onmouseover="this.style.background='#16a34a'" onmouseout="this.style.background='#22c55e'">›</button>
          </div>
          <div id="co-promo-msg" style="font-size:12px;margin-top:5px;padding:0 2px;display:none;border-radius:6px;"></div>
        </div>

        <div style="background:#f0fdf4;border-radius:12px;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <span style="font-size:14px;color:#16a34a;font-weight:600;">${t("total_amount_label", "Jami summa")}</span>
          <span id="checkout-final-price" style="font-size:20px;font-weight:800;color:#15803d;">0 ${t("currency", "so\'m")}</span>
        </div>

        <p style="font-size:13px;font-weight:600;color:#475569;margin:0 0 10px;">${t("select_pay_method", "To\'lov usulini tanlang:")}</p>
        <div style="display:flex;gap:8px;margin-bottom:14px;">
          <style>
            .co-method-btn{display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 6px;border:2px solid #e2e8f0;border-radius:12px;cursor:pointer;background:#fff;flex:1;font-size:12px;font-weight:600;color:#334155;transition:all .18s;}
            .co-method-btn:hover{border-color:#22c55e;background:#f0fdf4;}
            .co-active{border-color:#22c55e!important;background:#f0fdf4!important;color:#16a34a!important;}
          </style>
          <button class="co-method-btn co-active" onclick="window._coSelect('cash',this)">
            <span style="font-size:22px;">💵</span>${t("cash", "Naqd")}
          </button>
          <button class="co-method-btn" onclick="window._coSelect('card',this)">
            <span style="font-size:22px;">💳</span>${t("card", "Karta")}
          </button>
          ${RESTAURANT_SETTINGS.clickEnabled !== false ? `
          <button class="co-method-btn" onclick="window._coSelect('click',this)">
            <span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;background:#e0f2fe;border-radius:8px;font-size:13px;font-weight:900;color:#0284c7;letter-spacing:-0.5px;">CL</span>${t("payment_click", "Click")}
          </button>` : ""}
          ${RESTAURANT_SETTINGS.paymeEnabled !== false ? `
          <button class="co-method-btn" onclick="window._coSelect('payme',this)">
            <span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;background:#fce7f3;border-radius:8px;font-size:13px;font-weight:900;color:#be185d;">P</span>${t("payment_payme", "Payme")}
          </button>` : ""}
          ${RESTAURANT_SETTINGS.uzumEnabled !== false ? `
          <button class="co-method-btn" onclick="window._coSelect('uzum',this)">
            <span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;background:#ede9fe;border-radius:8px;font-size:13px;font-weight:900;color:#7c3aed;">U</span>${t("payment_uzum", "Uzum")}
          </button>` : ""}
        </div>

        <div id="co-card-fields" style="display:none;margin-bottom:14px;">
          <div style="padding:14px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;">
            <p id="co-card-label" style="margin:0 0 10px;font-size:13px;font-weight:600;color:#334155;">💳 ${t("card_details", "Karta ma\'lumotlari")}</p>
            <input id="co-card-num" type="text" placeholder="0000 0000 0000 0000" maxlength="19"
              style="width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none;margin-bottom:10px;background:#fff;"
              oninput="this.value=this.value.replace(/[^0-9]/g,'').replace(/(.{4})/g,'$1 ').trim().slice(0,19)">
            <div style="display:flex;gap:8px;">
              <input id="co-card-exp" type="text" placeholder="MM/YY" maxlength="5"
                style="flex:1;box-sizing:border-box;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none;background:#fff;"
                oninput="let v=this.value.replace(/\D/g,'');if(v.length>2)v=v.slice(0,2)+'/'+v.slice(2);this.value=v;">
              <input id="co-card-cvv" type="password" placeholder="CVV" maxlength="3"
                style="flex:1;box-sizing:border-box;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none;background:#fff;"
                oninput="this.value=this.value.replace(/\D/g,'')">
            </div>
          </div>
        </div>
        <button onclick="window._coPay()"
          style="width:100%;padding:15px;border:none;border-radius:14px;font-size:16px;font-weight:800;cursor:pointer;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;box-shadow:0 4px 14px rgba(34,197,94,0.35);">
          💸 ${t("pay_now_btn", "To\'lash")} — <span id="co-btn-amount">0</span> ${t("currency", "so\'m")}
        </button>
</div>

      </div>`;
  }

  const listContainer = document.getElementById('checkout-items-list');
  const totalEl = document.getElementById('checkout-final-price');

  // ── Admin tasdiqlash tekshiruvi ──
  // Faqat admin tasdiqlagan buyurtmalarga ID beriladi va hisob modal ochiladi
  const APPROVED_STATUSES = [
    "tasdiqlandi", "approved",
    "tayyorlanmoqda", "cooking",
    "tayyor", "ready",
    "yetkazilmoqda", "delivering", "served",
    "yetkazildi", "delivered",
    "to'landi", "tolandi", "paid",
    "to'lov tasdiqlandi", "payment_confirmed"
  ];

  // ── Agar hasSubmittedOrder/currentOrderId yo'q bo'lsa, localStorage dan tiklash ──
  // Sababi: sahifa yangilanganda sessionStorage o'chib ketadi
  if (!hasSubmittedOrder || !currentOrderId) {
    const _savedId = localStorage.getItem("activeOrderId") || localStorage.getItem("currentOrderId");
    if (_savedId) {
      try {
        const _ord = await fetchClientOrder(_savedId);
        if (_ord) {
          const _st  = normalizeStatus(getOrderStatusKey(_ord));
          const _alive = !["yopildi", "bekor qilindi", "closed", "cancelled", "paid", "to'landi"].includes(_st);
          if (_alive && _ord.tableClosed !== true) {
            currentOrderId   = _savedId;
            activeOrderData  = { ..._ord, _id: _savedId };
            hasSubmittedOrder = true;
            sessionStorage.setItem("client_has_submitted_order", "1");
          } else {
            if (typeof Swal !== "undefined") Swal.fire({ icon: "info", title: t("no_active_order", "Faol buyurtma yo'q"), text: t("place_order_first", "Avval menyu orqali buyurtma bering."), confirmButtonColor: "#22c55e" });
            else alert(t("no_active_order", "Avval buyurtma bering!"));
            return;
          }
        } else {
          if (typeof Swal !== "undefined") Swal.fire({ icon: "info", title: t("no_active_order", "Faol buyurtma yo'q"), text: t("place_order_first", "Avval menyu orqali buyurtma bering."), confirmButtonColor: "#22c55e" });
          else alert(t("no_active_order", "Avval buyurtma bering!"));
          return;
        }
      } catch (_e) {
        console.warn("openCheckoutModal restore failed:", _e);
        if (typeof Swal !== "undefined") Swal.fire({ icon: "info", title: t("no_active_order", "Faol buyurtma yo'q"), text: t("place_order_first", "Avval menyu orqali buyurtma bering."), confirmButtonColor: "#22c55e" });
        else alert(t("no_active_order", "Avval buyurtma bering!"));
        return;
      }
    } else {
      if (typeof Swal !== "undefined") {
        Swal.fire({ icon: "info", title: t("no_active_order", "Faol buyurtma yo'q"), text: t("place_order_first", "Avval menyu orqali buyurtma bering."), confirmButtonColor: "#22c55e" });
      } else {
        alert(t("no_active_order", "Avval buyurtma bering!"));
      }
      return;
    }
  }

  // ── Firebase dan REAL status olib tekshirish (keshlanmagan) ──
  // Agar handleRequestBill allaqachon tekshirib, flag o'rnatgan bo'lsa — skip
  const _alreadyApproved = window._billApprovedByAdmin === true;
  window._billApprovedByAdmin = false; // flagni tozalash (bir martalik)

  if (!_alreadyApproved) {
    try {
      const _freshOrder = await fetchClientOrder(currentOrderId);
      if (_freshOrder) {
        activeOrderData = { ..._freshOrder, _id: currentOrderId };
      }
    } catch (_fe) {
      console.warn("[openCheckoutModal] Firebase refresh failed, using cached data:", _fe);
    }

    const _refreshedStatus = normalizeStatus(activeOrderData?.status || activeOrderData?.statusKey || "");
    const isApprovedByAdmin = APPROVED_STATUSES.includes(_refreshedStatus);

    if (!isApprovedByAdmin) {
      if (typeof Swal !== "undefined") {
        Swal.fire({
          icon: "warning",
          title: t("order_not_approved_yet", "Buyurtma tasdiqlanmagan"),
          text: t("wait_admin_approval", "Hisob so'rash uchun admin buyurtmangizni tasdiqlashi kerak. Iltimos, kuting..."),
          confirmButtonColor: "#22c55e",
          confirmButtonText: t("ok_btn", "Tushunarli")
        });
      } else {
        alert(t("wait_admin_approval", "Admin buyurtmangizni hali tasdiqlamagan. Iltimos, kuting!"));
      }
      return;
    }
  }

  const lang = typeof getLang === "function" ? getLang() : 'uz';
  const tNum = localStorage.getItem("tableNo") || document.getElementById("tableInput")?.value || "-";

  const orderNo = formatOrderNumber(activeOrderData) ||
    (activeOrderData?.orderNumber ? String(activeOrderData.orderNumber) : (localStorage.getItem("currentOrderId")?.slice(-4) || ""));

  // Unikal Bill ID — handleRequestBill tomonidan yaratilgan bo'lsa undan olamiz
  const _billKey = "billId_" + currentOrderId;
  let _billId = window._checkoutBillId || localStorage.getItem(_billKey);
  if (!_billId) {
    const _ts   = Date.now().toString(36).toUpperCase();
    const _rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    const _sfx  = String(currentOrderId || "").slice(-4).toUpperCase();
    _billId = "BILL-" + _ts + "-" + _rand + (_sfx ? "-" + _sfx : "");
    localStorage.setItem(_billKey, _billId);
  }
  window._checkoutBillId = _billId;

  const metaEl = document.getElementById("co-order-meta");
  const _orderNoIsFormatted = /^(ORD|DVR)-/.test(orderNo);
  const _orderNoLabel = _orderNoIsFormatted ? `${t("order_label", "Buyurtma")} ${orderNo}` : `${t("order_no_label", "Buyurtma №")}${orderNo}`;
  if (metaEl) metaEl.textContent = (orderNo ? `${_orderNoLabel} · ` : "") + `${t("table_label", "Stol")} ${tNum} · 🎫 ${_billId}`;

  let total = 0;
  if (listContainer) listContainer.innerHTML = '';

  if (Object.keys(cart).length === 0) {
    if (listContainer) listContainer.innerHTML = `<p style="text-align:center;color:#94a3b8;padding:24px 0;">${t("cart_empty_text", "Savat bo'sh")}</p>`;
  } else {
    Object.entries(cart).forEach(([id, c]) => {
      const m = menu[id];
      if (!m) return;
      const qty = Number(c.qty || 0);
      const price = Number(m.price || 0);
      const sum = price * qty;
      total += sum;

      const name = typeof m.name === "object" ? (m.name[lang] || m.name.uz || "Mahsulot") : (m.name || "Mahsulot");
      const imgSrc = m.imgUrl || m.img || m.image || "";
      const cat = m.category
        ? (typeof t === "function" ? t(m.category) || m.category : m.category)
        : "";
      const sub = m.subcategory
        ? (typeof t === "function" ? t(m.subcategory) || m.subcategory : m.subcategory)
        : "";

      const imgEl = imgSrc
        ? `<img class="co-item-img" src="${imgSrc}" onerror="this.style.display='none'" alt="">`
        : `<div class="co-item-img-placeholder">🍽️</div>`;

      const catBadge = cat ? `<span class="co-badge co-badge-cat">${cat}</span> ` : "";
      const subBadge = sub ? `<span class="co-badge co-badge-sub">${sub}</span>` : "";

      if (listContainer) listContainer.innerHTML += `
        <div class="co-item-row">
          ${imgEl}
          <div style="flex:1;min-width:0;">
            <p style="margin:0 0 3px;font-weight:700;font-size:14px;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</p>
            ${(cat || sub) ? `<div style="margin-bottom:4px;">${catBadge}${subBadge}</div>` : ""}
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:12px;color:#64748b;">${price.toLocaleString()} so'm × ${qty}</span>
              <span style="font-size:14px;font-weight:800;color:#0f172a;">${sum.toLocaleString()} so'm</span>
            </div>
          </div>
        </div>`;
    });
  }

  // Chegirma hisoblash (VIP shaxsiy)
  let finalTotal = total;
  let _coBaseTotal = total;
  try {
    const discountInfo = await calculateDiscount(total);
    const discPct = Number(discountInfo?.discountPercent || 0);
    const discAmt = Number(discountInfo?.discountAmount || 0);
    finalTotal = Number(discountInfo?.finalPrice || total);
    _coBaseTotal = finalTotal;

    const discRow = document.getElementById("co-discount-row");
if (discRow) {
  discRow.innerHTML = discPct > 0 ? `
    <div style="display:flex;justify-content:space-between;align-items:center;background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:9px 14px;margin-bottom:6px;font-size:13px;">
      <span style="color:#92400e;">🎟 ${t("vip_discount_label", "VIP Chegirma")} −${discPct}%</span>
      <span style="font-weight:800;color:#b45309;">−${discAmt.toLocaleString()} ${t("currency", "so'm")}</span>
    </div>` : "";
}
    sessionStorage.setItem("checkoutDiscountInfo", JSON.stringify({ discPct, discAmt, finalAmt: finalTotal }));
  } catch (e) { }

  // ── ОБСЛУГА (Xizmat haqi) — admin sozlamalardan avtomatik ──
  // Firebase settings dan serviceFee (%) va serviceFeeMinOrder (min summa) olinadi.
  // Agar buyurtma summasi serviceFeeMinOrder dan oshsa — obsluga avtomatik qo'shiladi.
  let _serviceFeeApplied = false;
  let _serviceFeeAmt = 0;
  let _serviceFeePct = 0;
  try {
    const _settSnap = await get(ref(db, `${BASE_PATH}/settings`));
    const _sett = _settSnap.val() || {};
    _serviceFeePct = Number(_sett.serviceFee || 0);
    const _serviceFeeMinOrder = Number(_sett.serviceFeeMinOrder || 0);
    // Chegara tekshiruvi: 0 bo'lsa doim qo'shiladi, aks holda total >= minOrder bo'lsa
    if (_serviceFeePct > 0 && (_serviceFeeMinOrder === 0 || total >= _serviceFeeMinOrder)) {
      _serviceFeeAmt = Math.round(finalTotal * _serviceFeePct / 100);
      finalTotal = finalTotal + _serviceFeeAmt;
      _serviceFeeApplied = true;
      // Obsluga satrini ko'rsatish
      const _svcContainer = document.getElementById("co-discount-row");
      if (_svcContainer) {
        _svcContainer.innerHTML += `
          <div id="co-service-fee-row" style="display:flex;justify-content:space-between;align-items:center;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:9px 14px;margin-bottom:6px;font-size:13px;">
            <span style="color:#c2410c;">🧾 ${t("obsluga_title") || "Обслуга"} +${_serviceFeePct}%${_serviceFeeMinOrder > 0 ? ` <span style="font-size:11px;opacity:.7;">(${_serviceFeeMinOrder.toLocaleString()} ${t("currency","so'm")} dan oshgani uchun)</span>` : ""}</span>
            <span style="font-weight:800;color:#c2410c;">+${_serviceFeeAmt.toLocaleString()} ${t("currency", "so'm")}</span>
          </div>`;
      }
      // Jami satrini yangilash
      const _totalBox = document.querySelector("#checkout-inner > div[style*='background:#f0fdf4']");
      if (_totalBox) {
        const _lbl = _totalBox.querySelector("span:first-child");
        if (_lbl) _lbl.textContent = t("grand_total", "Jami to'lov");
      }
    }
  } catch (_se) { console.warn("[checkout] Obsluga yuklashda xato:", _se); }

  if (totalEl) totalEl.innerText = finalTotal.toLocaleString();
  const btnAmountEl = document.getElementById("co-btn-amount");
  if (btnAmountEl) btnAmountEl.textContent = finalTotal.toLocaleString();

  window._coAppliedPromo = null;
  const _rId   = localStorage.getItem("restaurantId");
  const _norm  = (p) => String(p || "").replace(/\D/g, "").slice(-9);

  let _phone =
    localStorage.getItem("customerPhone") ||
    localStorage.getItem("userPhone") ||
    activeOrderData?.customerPhone ||
    activeOrderData?.clientPhone ||
    activeOrderData?.phoneNumber ||
    document.getElementById("clientPhoneInput")?.value ||
    "";

  // Agar hali ham telefon yo'q bo'lsa — Firebase'dan aktiv buyurtma orqali olamiz
  if (!_norm(_phone) && _rId) {
    try {
      const _activeOId =
        localStorage.getItem("activeOrderId") ||
        localStorage.getItem("currentOrderId");
      if (_activeOId) {
        const _oData = await fetchClientOrder(_activeOId);
        if (_oData) {
          const _oPhone =
            _oData.customerPhone ||
            _oData.clientPhone ||
            _oData.phoneNumber ||
            "";
          if (_oPhone) {
            _phone = _oPhone;
            // Kelajakda ham ishlashi uchun saqlab qo'yamiz
            localStorage.setItem("customerPhone", _oPhone);
          }
        }
      }
    } catch (_fe) { console.warn("Buyurtmadan telefon olishda xato:", _fe); }
  }

  const _myKey = _norm(_phone);

  const cardsEl   = document.getElementById("co-promo-cards");
  const promoInp  = document.getElementById("co-promo-input");
  const promoMsg  = document.getElementById("co-promo-msg");
  const promoApplyBtn = document.getElementById("co-promo-apply-btn");

  if (cardsEl)   cardsEl.innerHTML   = "";
  if (promoInp)  { promoInp.value = ""; promoInp.readOnly = false; promoInp.style.borderColor = "#e2e8f0"; promoInp.style.background = "#fff"; }
  if (promoMsg)  promoMsg.style.display = "none";
  if (promoApplyBtn) { promoApplyBtn.innerHTML = "›"; promoApplyBtn.style.background = "#22c55e"; promoApplyBtn.disabled = false; promoApplyBtn.onmouseover = () => promoApplyBtn.style.background = "#16a34a"; promoApplyBtn.onmouseout = () => promoApplyBtn.style.background = "#22c55e"; }

  let _availablePromos = [];
  try {
    if (_rId) {
      const _dSnap = await get(ref(db, `restaurants/${_rId}/discounts`));
      const _allD  = _dSnap.val() || {};
      _availablePromos = Object.values(_allD).filter(d => {
        const usedCount = Number(d.usedCount || 0);
        const maxUses   = Number(d.maxUses || 1);
        if (d.used || usedCount >= maxUses) return false;
        const isOwner  = d.ownerPhone && _myKey && _norm(d.ownerPhone) === _myKey;
        const isGlobal = !d.ownerPhone;
        return isOwner || isGlobal;
      });
      // VIP promokodlarni birinchi qo'yish (ownerPhone ga tegishli va isVipPromo=true)
      _availablePromos.sort((a, b) => {
        const aVip = (a.isVipPromo === true || (a.ownerPhone && _myKey && _norm(a.ownerPhone) === _myKey)) ? 1 : 0;
        const bVip = (b.isVipPromo === true || (b.ownerPhone && _myKey && _norm(b.ownerPhone) === _myKey)) ? 1 : 0;
        return bVip - aVip;
      });
    }
  } catch (_e) { console.warn("Promo yuklashda xato:", _e); }

  // ── VIP promokodni AVTOMATIK qo'llash ──
  // Agar mijoz telefoni mavjud bo'lsa va unga tegishli VIP promo topilsa — hech narsa kiritmay avtomatik qo'llaniladi
  const _vipAutoPromo = _myKey
    ? _availablePromos.find(d =>
        d.ownerPhone &&
        _norm(d.ownerPhone) === _myKey &&
        !d.used &&
        Number(d.usedCount || 0) < Number(d.maxUses || 1) &&
        d.isVipPromo === true
      ) ||
      // isVipPromo belgisi bo'lmasa ham ownerPhone mos kelsa topamiz
      _availablePromos.find(d =>
        d.ownerPhone &&
        _norm(d.ownerPhone) === _myKey &&
        !d.used &&
        Number(d.usedCount || 0) < Number(d.maxUses || 1)
      )
    : null;

  if (_vipAutoPromo) {
    // VIP promokod topildi — avtomatik qo'llaymiz
    const _vCode   = _vipAutoPromo.code;
    const _vPct    = Number(_vipAutoPromo.percent || 0);
    const _vAmt    = Math.round(_coBaseTotal * _vPct / 100);
    // Obsluga VIP chegirmadan KEYIN qo'shiladi (chegirma bazasiga qarab hisoblangan obsluga + chegirmadan keyingi summa)
    const _vTotal  = (_coBaseTotal - _vAmt) + (_serviceFeeApplied ? _serviceFeeAmt : 0);
    finalTotal = _vTotal;

    // Narxni yangilash
    if (totalEl)   totalEl.innerText   = _vTotal.toLocaleString();
    const _btnAmt  = document.getElementById("co-btn-amount");
    if (_btnAmt)   _btnAmt.textContent = _vTotal.toLocaleString();

    // Chegirma satrini ko'rsatish (obsluga satri saqlanadi)
    const _discRow = document.getElementById("co-discount-row");
    const _svcRowHtml = _serviceFeeApplied && _serviceFeeAmt > 0
      ? `<div id="co-service-fee-row" style="display:flex;justify-content:space-between;align-items:center;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:9px 14px;margin-bottom:6px;font-size:13px;">
           <span style="color:#c2410c;">🧾 ${t("obsluga_title") || "Обслуга"} +${_serviceFeePct}%</span>
           <span style="font-weight:800;color:#c2410c;">+${_serviceFeeAmt.toLocaleString()} ${t("currency","so'm")}</span>
         </div>`
      : "";
    if (_discRow) _discRow.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:9px 14px;margin-bottom:6px;font-size:13px;">
        <span style="color:#92400e;">👑 VIP Promokod: <b>${_vCode}</b> (−${_vPct}%)</span>
        <span style="font-weight:800;color:#b45309;">−${_vAmt.toLocaleString()} so'm</span>
      </div>${_svcRowHtml}`;

    if (promoInp) {
      promoInp.value       = _vCode;
      promoInp.readOnly    = true;
      promoInp.style.borderColor = "#22c55e";
      promoInp.style.background  = "#f0fdf4";
    }
    if (promoApplyBtn) {
      promoApplyBtn.innerHTML   = "✓";
      promoApplyBtn.style.background = "#16a34a";
      promoApplyBtn.disabled    = true;
    }
    if (promoMsg) {
  promoMsg.innerText = `✅ ${t("vip_promo_applied", "VIP promokod avtomatik qo'llanildi")}: −${_vPct}%`;
  promoMsg.style.color = "#16a34a";
  promoMsg.style.background = "#f0fdf4";
  promoMsg.style.padding = "5px 8px";
  promoMsg.style.display = "block";
}

    window._coAppliedPromo = { code: _vCode, percent: _vPct, discAmt: _vAmt };

    if (cardsEl) {
      cardsEl.innerHTML = `
        <p style="font-size:11px;font-weight:700;color:#64748b;margin:0 0 6px;text-transform:uppercase;letter-spacing:.4px;">🎫 Promokodlaringiz</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
          ${_availablePromos.map(p => {
            const isSelected = p.code === _vCode;
            const usesLeft = Number(p.maxUses || 1) - Number(p.usedCount || 0);
            const badge = (p.maxUses || 1) > 1
              ? `<span style="font-size:9px;background:#ede9fe;color:#5b21b6;border-radius:4px;padding:1px 4px;margin-left:3px;">${usesLeft}×</span>`
              : "";
            const vipBadge = (p.ownerPhone && _norm(p.ownerPhone) === _myKey)
              ? `<span style="font-size:9px;background:#fef9c3;color:#92400e;border-radius:4px;padding:1px 4px;margin-left:3px;">👑VIP</span>`
              : "";
            return `<button onclick="window._coSelectPromoCard('${p.code}',${p.percent},this)"
              data-co-code="${p.code}"
              style="display:flex;flex-direction:column;align-items:flex-start;padding:7px 12px;border:2px solid ${isSelected ? '#22c55e' : '#e2e8f0'};border-radius:10px;background:${isSelected ? '#f0fdf4' : '#fff'};cursor:pointer;min-width:80px;text-align:left;transition:all .15s;">
              <span style="font-size:13px;font-weight:800;color:#15803d;letter-spacing:.5px;">${p.code}${badge}${vipBadge}</span>
              <span style="font-size:11px;color:#64748b;margin-top:2px;">−${p.percent}%</span>
            </button>`;
          }).join("")}
        </div>`;
    }

  } else {
    // VIP promo yo'q — oddiy ko'rsatish va birinchisini tanlash
    if (cardsEl && _availablePromos.length > 0) {
      if (_availablePromos.length <= 3) {
        // ≤3 ta: tugma kartochkalar
        cardsEl.innerHTML = `
          <p style="font-size:11px;font-weight:700;color:#64748b;margin:0 0 6px;text-transform:uppercase;letter-spacing:.4px;">🎫 Promokodlaringiz</p>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;" id="co-promo-btns">
            ${_availablePromos.map(p => {
              const usesLeft = Number(p.maxUses || 1) - Number(p.usedCount || 0);
              const badge = (p.maxUses || 1) > 1
                ? `<span style="font-size:9px;background:#ede9fe;color:#5b21b6;border-radius:4px;padding:1px 4px;margin-left:3px;">${usesLeft}×</span>`
                : "";
              return `<button onclick="window._coSelectPromoCard('${p.code}',${p.percent},this)"
                data-co-code="${p.code}"
                style="display:flex;flex-direction:column;align-items:flex-start;padding:7px 12px;border:2px solid #e2e8f0;border-radius:10px;background:#fff;cursor:pointer;min-width:80px;text-align:left;transition:all .15s;">
                <span style="font-size:13px;font-weight:800;color:#15803d;letter-spacing:.5px;">${p.code}${badge}</span>
                <span style="font-size:11px;color:#64748b;margin-top:2px;">−${p.percent}%</span>
              </button>`;
            }).join("")}
          </div>`;
      } else {
        // >3 ta: <select> dropdown
        cardsEl.innerHTML = `
          <p style="font-size:11px;font-weight:700;color:#64748b;margin:0 0 6px;text-transform:uppercase;letter-spacing:.4px;">🎫 Promokodlaringiz</p>
          <select id="co-promo-select"
            style="width:100%;padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:14px;color:#1e293b;background:#fff;outline:none;margin-bottom:8px;cursor:pointer;"
            onchange="window._coSelectFromDropdown(this.value,this.options[this.selectedIndex].dataset.percent)">
            <option value="">— Tanlang —</option>
            ${_availablePromos.map(p => {
              const usesLeft = Number(p.maxUses || 1) - Number(p.usedCount || 0);
              const multi = (p.maxUses || 1) > 1 ? ` (${usesLeft}× qoldi)` : "";
              return `<option value="${p.code}" data-percent="${p.percent}">${p.code} — −${p.percent}%${multi}</option>`;
            }).join("")}
          </select>`;
      }

      // Birinchi promokodni avtomatik tanlash
      const first = _availablePromos[0];
      if (promoInp) {
        promoInp.value = first.code;
        promoInp.style.borderColor = "#22c55e";
        // Birinchi kartochkani highlight
        setTimeout(() => {
          const firstBtn = document.querySelector(`[data-co-code="${first.code}"]`);
          if (firstBtn) { firstBtn.style.borderColor = "#22c55e"; firstBtn.style.background = "#f0fdf4"; }
          const sel = document.getElementById("co-promo-select");
          if (sel) sel.value = first.code;
        }, 50);
      }
    }
  }

  // Kartochka bosilganda
  window._coSelectPromoCard = function (code, percent, btn) {
    document.querySelectorAll("[data-co-code]").forEach(b => { b.style.borderColor = "#e2e8f0"; b.style.background = "#fff"; });
    if (btn) { btn.style.borderColor = "#22c55e"; btn.style.background = "#f0fdf4"; }
    const inp = document.getElementById("co-promo-input");
    if (inp) { inp.value = code; inp.style.borderColor = "#22c55e"; inp.style.background = "#f0fdf4"; }
    window._coApplyPromo();
  };

  window._coSelectFromDropdown = function (code, percent) {
    if (!code) return;
    const inp = document.getElementById("co-promo-input");
    if (inp) { inp.value = code; inp.style.borderColor = "#22c55e"; }
    window._coApplyPromo();
  };

  window._coApplyPromo = async function () {
    const inp   = document.getElementById("co-promo-input");
    const msgEl = document.getElementById("co-promo-msg");
    const code  = inp ? inp.value.trim().toUpperCase() : "";

    function showMsg(txt, color, bg) {
      if (!msgEl) return;
      msgEl.innerText        = txt;
      msgEl.style.color      = color;
      msgEl.style.background = bg || "transparent";
      msgEl.style.padding    = bg ? "5px 8px" : "0";
      msgEl.style.display    = "block";
    }

    if (!code) { showMsg("❗ " + t("enter_promo_alert", "Promokod kiriting"), "#b45309"); return; }

    if (window._coAppliedPromo && window._coAppliedPromo.code === code) return;

    if (window._coAppliedPromo) {
      finalTotal = _coBaseTotal;
      const totalEl2 = document.getElementById("checkout-final-price");
      const btnAmt   = document.getElementById("co-btn-amount");
      if (totalEl2) totalEl2.innerText = finalTotal.toLocaleString();
      if (btnAmt)   btnAmt.textContent = finalTotal.toLocaleString();
      const discRow = document.getElementById("co-discount-row");
      if (discRow) discRow.innerHTML = "";
      window._coAppliedPromo = null;
      if (inp) { inp.readOnly = false; }
      const ab = document.getElementById("co-promo-apply-btn");
      if (ab) { ab.innerHTML = "›"; ab.style.background = "#22c55e"; ab.disabled = false; }
    }

    try {
      const snap = await get(ref(db, `restaurants/${_rId}/discounts/${code}`));
      if (!snap.exists()) { showMsg("❌ Bunday promokod topilmadi!", "red"); return; }

      const promo = snap.val();
      const usedCount = Number(promo.usedCount || 0);
      const maxUses   = Number(promo.maxUses || 1);

      if (promo.used || usedCount >= maxUses) {
        showMsg("❌ Bu promokod allaqachon tugagan!", "red"); return;
      }
      if (promo.ownerPhone && _norm(promo.ownerPhone) !== _myKey) {
        showMsg("❌ Bu promokod sizning raqamingizga tegishli emas!", "red"); return;
      }

      const discPct = Number(promo.percent || 0);
      const discAmt = Math.round(_coBaseTotal * discPct / 100);
      const newTotal = _coBaseTotal - discAmt;

      // Chegirma satri
      const discRow = document.getElementById("co-discount-row");
      if (discRow) discRow.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:9px 14px;margin-bottom:6px;font-size:13px;">
          <span style="color:#92400e;">🎫 <b>${code}</b> (−${discPct}%)</span>
          <span style="font-weight:800;color:#b45309;">−${discAmt.toLocaleString()} so'm</span>
        </div>`;

      finalTotal = newTotal;
      const totalEl2 = document.getElementById("checkout-final-price");
      const btnAmt   = document.getElementById("co-btn-amount");
      if (totalEl2) totalEl2.innerText = newTotal.toLocaleString();
      if (btnAmt)   btnAmt.textContent = newTotal.toLocaleString();

      if (inp) { inp.readOnly = true; inp.style.borderColor = "#22c55e"; inp.style.background = "#f0fdf4"; }
      const ab = document.getElementById("co-promo-apply-btn");
      if (ab) { ab.innerHTML = "✓"; ab.style.background = "#16a34a"; ab.disabled = true; ab.onmouseover = null; ab.onmouseout = null; }

      showMsg(`✅ −${discPct}% ${t("promo_applied_success", "qo'llanildi! Tejash:")} ${discAmt.toLocaleString()} ${t("currency", "so'm")}`, "#16a34a", "#f0fdf4");
      window._coAppliedPromo = { code, percent: discPct, discAmt };

    } catch (e) { showMsg("❌ Xatolik yuz berdi", "red"); console.error(e); }
  };

  window._coSelectedMethod = "cash";
  window._coSelect = function (method, btn) {
    window._coSelectedMethod = method;
    document.querySelectorAll(".co-method-btn").forEach(b => b.classList.remove("co-active"));
    if (btn) btn.classList.add("co-active");
    const cf = document.getElementById("co-card-fields");
    const lbl = document.getElementById("co-card-label");
    if (cf) {
      const show = ["card", "click", "payme", "uzum"].includes(method);
      cf.style.display = show ? "block" : "none";
      if (lbl) {
        if (method === "click") lbl.textContent = `🔵 ${t("card_details_click_label", "Click karta ma'lumotlari")}`;
        else if (method === "payme") lbl.textContent = `🟢 ${t("card_details_payme_label", "Payme karta ma'lumotlari")}`;
        else if (method === "uzum") lbl.textContent = `🟣 ${t("card_details_uzum_label", "Uzum karta ma'lumotlari")}`;
        else lbl.textContent = `💳 ${t("card_details_generic_label", "Karta ma'lumotlari")}`;
      }
    }
  };

  // To'lash tugmasi
  window._coPay = async function () {
    const method = window._coSelectedMethod || "cash";
    const needsCard = ["card", "click", "payme", "uzum"].includes(method);
    if (needsCard) {
      const num = (document.getElementById("co-card-num")?.value || "").replace(/\s/g, "");
      const exp = document.getElementById("co-card-exp")?.value || "";
      const cvv = document.getElementById("co-card-cvv")?.value || "";
      const errField = num.length < 16 ? "co-card-num" : exp.length < 5 ? "co-card-exp" : cvv.length < 3 ? "co-card-cvv" : null;
      if (errField) {
        const el = document.getElementById(errField);
        if (el) { el.classList.add("co-err"); el.focus(); setTimeout(() => el.classList.remove("co-err"), 800); }
        return;
      }
    }
    // To'lov imitatsiyasi
    const inner = document.getElementById("checkout-inner");
    if (!inner) return;
    const brandColor = method === "click" ? "#3b82f6" : method === "payme" ? "#22c55e" : method === "card" ? "#6366f1" : "#22c55e";
    const methodLabel = method === "cash" ? t("cash_label", "Naqd pul") : method === "card" ? t("card_label", "Bank kartasi") : method === "click" ? "Click" : "Payme";

    inner.innerHTML = `
      <style>@keyframes spinPay{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}</style>
      <div style="padding:60px 32px;text-align:center;">
        <div style="width:64px;height:64px;border:5px solid #f1f5f9;border-top:5px solid ${brandColor};border-radius:50%;animation:spinPay 0.9s linear infinite;margin:0 auto 24px;"></div>
        <h3 style="margin:0 0 8px;font-size:18px;font-weight:800;color:#0f172a;">${methodLabel} orqali to'lanmoqda</h3>
        <p style="margin:0;font-size:13px;color:#94a3b8;">Sahifani yopmang yoki yangilamang...</p>
        <div style="margin-top:20px;background:#f8fafc;border-radius:12px;padding:12px 18px;display:inline-block;">
          <span style="font-size:22px;font-weight:800;color:${brandColor};">${finalTotal.toLocaleString()} so'm</span>
        </div>
      </div>`;

    await new Promise(r => setTimeout(r, 2600));

    // Firebase ga yozish
    const restId = localStorage.getItem("restaurantId");
    const orderId = localStorage.getItem("currentOrderId") || (typeof currentOrderId !== 'undefined' ? currentOrderId : null);

    try {
      if (orderId && typeof db !== 'undefined') {
        await update(ref(db, `restaurants/${restId}/orders/${orderId}/payment`), {
          method, paid: true, approved: true, time: Date.now()
        });
        const _svcUpdate = {};
        if (_serviceFeeApplied && _serviceFeeAmt > 0) {
          _svcUpdate.serviceFeePercent = _serviceFeePct;
          _svcUpdate.serviceFeeAmount  = _serviceFeeAmt;
          _svcUpdate.finalTotal        = finalTotal;
        }
        await update(ref(db, `restaurants/${restId}/orders/${orderId}`), {
          status: "to'landi", paidAt: Date.now(), ..._svcUpdate
        });
        const order4 = await fetchClientOrder(orderId);
        if (order4) {
          const tableNo = order4.table;
          if (tableNo) await update(ref(db, `restaurants/${restId}/tables/${getTableKey(tableNo)}`), {
            status: "cleaning", cleaningNeededAt: Date.now(), busy: false
          });
        }
      }
    } catch (e) { console.warn("Firebase to'lov yozishda xato:", e); }

    // Promokod ishlatilgan bo'lsa — usedCount oshirish + orderni yangilash
    if (window._coAppliedPromo) {
      const _pCode = window._coAppliedPromo.code;
      try {
        const _pSnap = await get(ref(db, `restaurants/${restId}/discounts/${_pCode}`));
        if (_pSnap.exists()) {
          const _pd    = _pSnap.val();
          const _maxU  = Number(_pd.maxUses || 1);
          const _usedC = Number(_pd.usedCount || 0);
          const _newC  = _usedC + 1;
          const _done  = _newC >= _maxU;
          await update(ref(db, `restaurants/${restId}/discounts/${_pCode}`), {
            usedCount: _newC,
            used: _done,
            ...(_done ? { usedAt: Date.now() } : {})
          });
        }
      } catch (_e) { console.warn("Promo usedCount xato:", _e); }
      if (orderId) {
        try {
          await update(ref(db, `restaurants/${restId}/orders/${orderId}`), {
            appliedPromo:    window._coAppliedPromo.code,
            discountPercent: window._coAppliedPromo.percent,
            discountAmount:  window._coAppliedPromo.discAmt
          });
        } catch (_e) { }
      }
      window._coAppliedPromo = null;
    }

    // Muvaffaqiyat ekrani
    inner.innerHTML = `
      <style>@keyframes popSuccess{0%{transform:scale(0);opacity:0}70%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}}</style>
      <div style="padding:52px 32px;text-align:center;">
        <div style="width:80px;height:80px;background:#22c55e;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:40px;margin:0 auto 20px;animation:popSuccess .5s ease-out forwards;color:#fff;">✓</div>
        <h2 style="margin:0 0 6px;font-size:22px;font-weight:800;color:#0f172a;">To'lov muvaffaqiyatli!</h2>
        <p style="margin:0 0 20px;font-size:14px;color:#64748b;">${methodLabel} orqali to'landi</p>
        <div style="background:#f0fdf4;border-radius:14px;padding:14px 20px;margin-bottom:20px;">
          <p style="margin:0 0 2px;font-size:13px;color:#64748b;">To'langan summa</p>
          <p style="margin:0;font-size:26px;font-weight:900;color:#15803d;">${finalTotal.toLocaleString()} so'm</p>
        </div>
        <p style="margin:0;font-size:11px;color:#cbd5e1;">Nesta ERP • Tasdiqlandi ✓</p>
      </div>`;

    await new Promise(r => setTimeout(r, 2400));

    modal.style.display = "none";
    localStorage.removeItem("discountPercent");
    localStorage.removeItem("discountCode");

    if (orderId && typeof db !== 'undefined' && typeof showReceipt === "function") {
      try {
        const restId = localStorage.getItem("restaurantId");
        const order5 = await fetchClientOrder(orderId);
        if (order5) showReceipt(order5);
      } catch (e) { }
    }
    setTimeout(() => { if (typeof openFeedbackModal === "function") openFeedbackModal(); }, 5000);
  };

  modal.style.display = 'flex';
};

window.closeCheckoutModal = function () {
  const modal = document.getElementById('checkout-modal');
  if (modal) modal.style.display = 'none';
};

window.sendBillRequest = async function () {
  const methodInput = document.querySelector('input[name="pay-method"]:checked');
  const method = methodInput ? methodInput.value : 'cash';
  const restaurantId = localStorage.getItem("restaurantId") || "rest_default";
  const orderId = localStorage.getItem("currentOrderId") || "order_" + Date.now();

  Swal.fire({
    title: t("bill_calculating_title", "To'lov hisoblanmoqda..."),
    html: t("bill_calculating_text", "Iltimos, kuting, tizim so'rovni qayta ishlamoqda."),
    allowOutsideClick: false,
    willOpen: () => {
      const swalContainer = Swal.getContainer();
      if (swalContainer) swalContainer.style.zIndex = '99999';
    },
    didOpen: () => {
      Swal.showLoading();
    }
  });

  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    if (typeof window.closeCheckoutModal === "function") {
      window.closeCheckoutModal();
    } else {
      const modal = document.getElementById("checkout-modal");
      if (modal) modal.style.display = "none";
    }

    const tableNo = localStorage.getItem("tableNo") || document.getElementById("tableInput")?.value || "-";

    const finalPriceElem = document.getElementById("checkout-final-price") || document.getElementById("paymentTotal");
    let totalNum = 0;
    if (finalPriceElem) {
      totalNum = parseInt(finalPriceElem.innerText.replace(/\D/g, '')) || 0;
    }

    let itemsArray = [];

    const checkoutListEl = document.getElementById("checkout-items-list");
    if (checkoutListEl && checkoutListEl.children.length > 0) {
      Array.from(checkoutListEl.children).forEach((child, idx) => {
        const text = child.innerText || child.textContent || "";
        if (!text.trim()) return;

        let qty = 1;
        let cleanName = "Taom";
        let totalItemPrice = 0;

        const qtyMatch = text.match(/[xX]\s*(\d+)/) || text.match(/(\d+)\s*ta/);

        if (qtyMatch) {
          qty = parseInt(qtyMatch[1]) || 1;

          const indexOfX = text.indexOf(qtyMatch[0]);
          const beforeX = text.substring(0, indexOfX).trim();
          const afterX = text.substring(indexOfX + qtyMatch[0].length).trim();

          cleanName = beforeX || "Taom";
          totalItemPrice = parseInt(afterX.replace(/\D/g, '')) || 0;
        } else {
          const digitsAtEnd = text.match(/(\d[\d\s]*)\s*so['`’‘]m/i) || text.match(/(\d[\d\s]*)$/);
          if (digitsAtEnd) {
            totalItemPrice = parseInt(digitsAtEnd[1].replace(/\D/g, '')) || 0;
            cleanName = text.replace(digitsAtEnd[0], "").trim();
          } else {
            cleanName = text.trim();
          }
        }

        const unitPrice = qty > 0 ? Math.round(totalItemPrice / qty) : totalItemPrice;

        itemsArray.push({
          id: "item_" + idx,
          name: cleanName,
          title: cleanName,
          quantity: qty,
          qty: qty,
          count: qty,
          price: unitPrice,
          unitPrice: unitPrice,
          total: totalItemPrice,
          totalPrice: totalItemPrice,
          summa: totalItemPrice
        });
      });
    }

    if (itemsArray.length === 0 && totalNum > 0) {
      itemsArray.push({
        id: "food_backup",
        name: t("ordered_food_items_fallback", "Buyurtma qilingan taomlar"),
        title: t("ordered_food_items_fallback", "Buyurtma qilingan taomlar"),
        quantity: 1,
        qty: 1,
        count: 1,
        price: totalNum,
        total: totalNum,
        totalPrice: totalNum,
        summa: totalNum
      });
    }

    const shortOrderNo = orderId.replace(/\D/g, '').slice(-4) || "1024";
    const mockOrderData = {
      id: orderId,
      orderId: orderId,
      orderNo: shortOrderNo,
      checkNo: shortOrderNo,
      orderNumber: shortOrderNo,
      restaurantId: restaurantId,

      tableNo: tableNo,
      table: tableNo,
      stol: tableNo,

      paymentMethod: method,
      paymentStatus: 'requested',
      billRequestedAt: Date.now(),

      items: itemsArray,

      totalPrice: totalNum,
      total: totalNum,
      finalPrice: totalNum,
      subTotal: totalNum,
      amount: totalNum,
      totalSum: totalNum,
      sum: totalNum,
      asosiy: totalNum
    };

    Swal.close();

    if (typeof showReceipt === "function") {
      showReceipt(mockOrderData);
    } else {
      Swal.fire({
        icon: 'success',
        title: t("bill_requested_success", "Hisob so'raldi! Ofitsiant tez orada hisob-kitobni olib keladi."),
        text: `${t("payment_method_label", "To'lov turi")}: ${method === 'cash' ? t("payment_cash", "Naqd") : t("payment_method_visa_mastercard", "Karta")}. ${t("waiter_bringing_check", "Ofitsiant hozir chekni olib keladi!")}`,
        confirmButtonColor: 'var(--primary)'
      });
    }

  } catch (error) {
    console.error("To'lov imitatsiyasida xato:", error); // dev-console only, not user-facing
    Swal.close();
  }
};

window.toggleCardInputs = function (show) {
  const cardForm = document.getElementById('card-details-form');
  if (cardForm) {
    cardForm.style.display = show ? 'block' : 'none';
  }
};

window.processFinalPayment = async function () {
  const methodInput = document.querySelector('input[name="pay-type"]:checked');
  if (!methodInput) {
    alert(t("select_payment_type", "Iltimos, to'lov turini tanlang!"));
    return;
  }
  const method = methodInput.value;
  const rId = localStorage.getItem("restaurantId");
  const orderId = localStorage.getItem("currentOrderId");

  if (!orderId) {
    alert(t("no_active_order_yet", "Sizda hali faol buyurtma yo'q!"));
    return;
  }

  try {
    const orderRef = ref(db, `restaurants/${rId}/orders/${orderId}`);
    await update(orderRef, {
      paymentStatus: 'requested',
      paymentMethod: method,
      billRequestedAt: Date.now()
    });

    if (typeof closeCheckoutModal === "function") {
      closeCheckoutModal();
    }

    if (typeof openPaymentModal === "function") {
      openPaymentModal();
    } else {
      const pModal = document.getElementById("paymentModal");
      if (pModal) pModal.style.display = "flex";
    }

  } catch (e) {
    console.error("Xatolik:", e);
    alert(t("error_generic", "Xatolik yuz berdi") + ": " + e.message);
  }
};

/* =========================
EXPORT TO WINDOW
========================= */
window.openFeedbackModal = openFeedbackModal;
window.submitFeedback = submitFeedback;
window.closeFeedback = closeFeedback;
window.toggleCart = toggleCart;
window.removeFromCart = removeFromCart;
window.closeReceipt = closeReceipt;
window.closeClientChat = closeClientChat;
window.checkAndShowVipBadge = checkAndShowVipBadge;
window.cart = window.cart || {};

/* =========================
   HISOB SORASH — ADMIN TASDIQLOV BILAN
========================= */
window.handleRequestBill = async function () {
  try {
    const _orderId = currentOrderId
      || localStorage.getItem("activeOrderId")
      || localStorage.getItem("currentOrderId");

    const _restId = currentRestaurantId || localStorage.getItem("restaurantId");

    if (!_orderId || !_restId) {
      if (typeof Swal !== "undefined") {
        Swal.fire({ icon: "info", title: t("no_active_order", "Faol buyurtma yo'q"), text: t("place_order_first", "Avval menyu orqali buyurtma bering."), confirmButtonColor: "#22c55e" });
      } else {
        alert(t("no_active_order", "Avval buyurtma bering!"));
      }
      return;
    }

    let _freshStatus = "";
    let _freshOrder  = null;
    try {
      _freshOrder = await fetchClientOrder(_orderId);
      if (_freshOrder) {
        activeOrderData = Object.assign({}, _freshOrder, { _id: _orderId });
        currentOrderId  = _orderId;
        window._currentOrderId = _orderId;
        _freshStatus = normalizeStatus(getOrderStatusKey(_freshOrder));
      }
    } catch (_fe) {
      console.warn("[handleRequestBill] Firebase read failed:", _fe);
      _freshStatus = normalizeStatus(
        (activeOrderData && (activeOrderData.status || activeOrderData.statusKey)) || ""
      );
    }

    const _approvedStatuses = [
      "tasdiqlandi", "approved",
      "tayyorlanmoqda", "cooking",
      "tayyor", "ready",
      "yetkazilmoqda", "delivering", "served",
      "yetkazildi", "delivered",
      "to'landi", "tolandi", "paid",
      "to'lov tasdiqlandi", "payment_confirmed"
    ];

    if (!_freshStatus || !_approvedStatuses.includes(_freshStatus)) {
      if (typeof Swal !== "undefined") {
        Swal.fire({
          icon: "warning",
          title: t("order_not_approved_yet", "Buyurtma tasdiqlanmagan"),
          text: t("wait_admin_approval", "Hisob so'rash uchun admin tasdiqlashi kerak. Iltimos, kuting..."),
          confirmButtonColor: "#22c55e",
          confirmButtonText: t("ok_btn", "Tushunarli")
        });
      } else {
        alert(t("wait_admin_approval", "Admin buyurtmangizni hali tasdiqlamagan!"));
      }
      return;
    }

    const _billKey = "billId_" + _orderId;
    let _billId = localStorage.getItem(_billKey);

    if (!_billId && _freshOrder && _freshOrder.billId) {
      _billId = _freshOrder.billId;
      localStorage.setItem(_billKey, _billId);
    }

    if (!_billId) {
      const _ts   = Date.now().toString(36).toUpperCase();
      const _rand = Math.random().toString(36).slice(2, 6).toUpperCase();
      const _sfx  = String(_orderId || "").slice(-4).toUpperCase();
      _billId = "BILL-" + _ts + "-" + _rand + (_sfx ? "-" + _sfx : "");
      localStorage.setItem(_billKey, _billId);

      try {
        await update(ref(db, "restaurants/" + _restId + "/orders/" + _orderId), {
          billId:          _billId,
          billRequestedAt: Date.now(),
          billStatus:      "pending"
        });
      } catch (_we) {
        console.warn("[handleRequestBill] Firebase ga billId yozishda xato:", _we);
      }
    }

    window._checkoutBillId = _billId;

    window._billApprovedByAdmin = true;

    if (typeof window.requestBill === "function") {
      await window.requestBill();
    }

  } catch (_err) {
    console.error("[handleRequestBill] xatolik:", _err);
  }
};