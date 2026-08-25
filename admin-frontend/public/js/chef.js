// chef.js

import { CATEGORY_DATA } from "./shared.js";

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";

// 🔒 P0 AUTH FIX (same root cause as waiter.js/kassa.js) — chef.js never
// imported firebase-auth.js, so it never had a Firebase Auth session even
// though login.js already signed one in (signInWithCustomToken) before
// redirecting here. Without getAuth(app), every restaurants/{restId}/...
// read/write goes out with no token — denied by database.rules.json's
// top-level `auth != null` requirement. getAuth(app) below restores
// whatever real session is already persisted for this origin; initChef()
// (this file's existing async boot function, already gated behind
// DOMContentLoaded) awaits auth.authStateReady() as its first step.
import { getAuth, signInWithCustomToken, setPersistence, inMemoryPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {

  getDatabase,

  forceWebSockets,

  ref,

  onValue,

  update,

  get,

  set,

  push,

  remove,

  query,

  orderByChild,

  limitToLast,

  runTransaction

} from "./pgRtdb.js";

import { t, getLang, setLang, applyLang, onLangChange } from "./i18n.js";

import { listenPlanFeatures } from "./plan_features.js";

import { ORDER_STATUS_V2, writeOrderAuditLog, normalizeOrderType, ORDER_TYPE, formatDeliveryAddress } from "./shared.js";
import { mountStaffFooter, updateStaffFooter } from "./staffFooter.js";

// Force WebSocket-only transport (never fall back to `.lp` long-polling) —
// first executable statement in this module.
forceWebSockets();

// 🆕 YAGONA STAFF FOOTER — chef panelida bottom-nav yo'q, shuning uchun
// fixed (viewport pastida) rejimda. Bu — screenshotdagi canonical
// reference, boshqa panellar shu bilan bir xil komponentni ishlatadi.
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



/* =========================

   CONFIG

========================= */

const firebaseConfig = {

  apiKey: "AIzaSyCGCCIP3eFg40bOEENDLGcrw9c484ySCHQ",

  authDomain: "restoran-30d51.firebaseapp.com",

  databaseURL: "https://restoran-30d51-default-rtdb.firebaseio.com",

  projectId: "restoran-30d51",

  storageBucket: "restoran-30d51.firebasestorage.app",

  messagingSenderId: "862261129762",

  appId: "1:862261129762:web:5577e6821b4ad7ea4e507b"

};



const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

const db = getDatabase(app);

const auth = getAuth(app);



window.allOrders = {};

let headerTimerInterval = null;



const urlParams = new URLSearchParams(window.location.search);

const rId = urlParams.get('rest') || urlParams.get('id') || localStorage.getItem("restaurantId");



if (rId) localStorage.setItem("restaurantId", rId);

const viewAsId = urlParams.get('viewAs');

const restIdFromUrl = urlParams.get('rest') || urlParams.get('id');



let currentRestaurantId = restIdFromUrl || localStorage.getItem("restaurantId");

let currentChefId = sessionStorage.getItem("userId") ||

  sessionStorage.getItem("chefId") ||

  sessionStorage.getItem("uid");



let chefActive = true;

let currentLang = getLang();



if (viewAsId && restIdFromUrl) {

  currentRestaurantId = restIdFromUrl;

  currentChefId = viewAsId;



  localStorage.setItem("restaurantId", restIdFromUrl);

  sessionStorage.setItem("userId", viewAsId);

  sessionStorage.setItem("chefId", viewAsId);

  sessionStorage.setItem("role", "chef");

  sessionStorage.setItem("isViewingAsAdmin", "true");

  // 🩹 P0 root-cause fix (this pass): viewAs used to carry ONLY these
  // cosmetic URL params — no real Firebase Auth session — silently
  // relying on the admin's own session leaking into this tab via shared
  // browser storage. That stopped working the moment login.js was scoped
  // to tab-local persistence (a separate, deliberate fix — see that
  // file's own header comment). Live-reproduced: initChefAttendance() got
  // permission_denied with authUid:null. admin.js's "Sahifaga o'tish" now
  // mints a real session via backend routes/auth.js's new /staff-view-as
  // and passes it here as a one-time ssoToken — same pattern admin.js's
  // own "Login As" already uses for itself. Top-level await is legal here
  // (chef.js is an ES module) and deliberately blocks the REST of this
  // module's boot (kitchenStations listener, initChefAttendance, etc.)
  // until the real session is signed in — never let those fire against
  // whatever partial/no session existed before this resolves.
  const ssoToken = urlParams.get("ssoToken");
  if (ssoToken) {
    try {
      await setPersistence(auth, inMemoryPersistence);
      await signInWithCustomToken(auth, ssoToken);
    } catch (ssoErr) {
      console.warn("[CHEF-AUTH] ssoToken sign-in failed:", ssoErr?.code || ssoErr?.message);
    }
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("ssoToken");
    history.replaceState(null, "", cleanUrl.toString());
  }

  console.log(t("admin_login_success", "✅ Admin kuzatuvchi (Oshpaz) sifatida muvaffaqiyatli kirdi."));

} else {

  const role = sessionStorage.getItem("role");



  if (!currentRestaurantId || !currentChefId || (role !== "chef" && role !== "head_chef" && role !== "admin")) {

    console.warn(t("no_permission_redirecting", "🚫 Ruxsat yo'q. Login sahifasiga yo'naltirilmoqda..."));

    window.location.replace("login.html");

  }

}



const BASE_PATH = `restaurants/${currentRestaurantId}`;



// ==========================================

// 🍳 OSHXONA BO'LIMLARI (kitchenStations) — admin panelida har bir taomga

// biriktirilgan haqiqiy bo'lim (masalan "Fast-food", "Non mahsulotlari").

window.kitchenStations = window.kitchenStations || {};

// 🔒 Bu chaqiruv modul darajasida (initChef()dan OLDIN, DOMContentLoaded'ni
// kutmasdan) darhol ishga tushadi — shuning uchun uni to'g'ridan-to'g'ri
// auth.authStateReady() bilan kutish (await) EMAS, .then() bilan
// "auth tayyor bo'lgach" ko'rinishida yozamiz: bu modulning qolgan qismi
// (jumladan pastdagi DOMContentLoaded/initChef ro'yxatdan o'tkazishlari)
// bloklanib qolmaydi, faqat shu bitta listener auth tayyor bo'lgunча kutadi.
auth.authStateReady().then(() => {
  onValue(ref(db, BASE_PATH + "/kitchenStations"), snap => {

    window.kitchenStations = snap.val() || {};

    if (typeof renderChefOrders === "function") renderChefOrders();

  });
}).catch(err => console.warn("[CHEF-AUTH] authStateReady() failed:", err?.code || err?.message));



function getItemDisplayName(name, fallback) {

  fallback = fallback || t("food_label", "Taom");

  if (!name) return fallback;

  if (typeof name === "string") return name.trim() || fallback;

  if (typeof name === "object") {

    const lang = typeof currentLang !== "undefined" ? currentLang : (typeof getLang === "function" ? getLang() : "uz");

    return name[lang] || name.uz || name.ru || name.en || fallback;

  }

  return fallback;

}



function getKitchenStationLabel(stationId) {

  if (!stationId) return "";

  const st = (window.kitchenStations || {})[stationId];

  if (!st) return "";

  return getItemDisplayName(st.name, stationId);

}



// Menu itemga qarab qaysi oshpaz(lar)ga tegishli ekanini topadi.

// kitchenStation + chefCategories OR-mantiqda tekshiriladi (routing bilan bir xil).

function getAssignedChefNamesForItem(menu, item) {

  const stationId = normalizeText(menu?.kitchenStation || item?.kitchenStation || "");

  const categoryId = normalizeText(menu?.category || item?.category || "");

  if (!window.allChefs) return [];

  const names = Object.values(window.allChefs)

    .filter(chef => chef.active !== false)

    .filter(chef => {

      const chefStationsSingle = chef.kitchenStation ? [normalizeText(chef.kitchenStation)] : [];

      const chefStationsArray = Array.isArray(chef.chefCategories) ? chef.chefCategories.map(c => normalizeText(c)) : [];

      const chefStations = [...new Set([...chefStationsSingle, ...chefStationsArray])];

      if (chefStations.length === 0 || chefStations.includes("general")) return true;

      if (stationId && chefStations.includes(stationId)) return true;

      if (categoryId && chefStations.includes(categoryId)) return true;

      return false;

    })

    .map(chef => chef.name)

    .filter(Boolean);

  return names;

}



// ==========================================

// 🔑 STOL KALITINI STANDARTLASHTIRISH

// Firebase'da stollar "table_5" formatida saqlanadi. Bu faylda ba'zi joylarda

// faqat "5" (stol raqami, order.table dan) ishlatilgani uchun admin

// panelidagi Stollar bo'limi yangilanmay qolardi. Shu funksiya orqali

// barcha tables/ yo'llari bitta formatga keltiriladi.

function getTableKey(tableNumberOrKey) {

  const raw = String(tableNumberOrKey ?? "").trim();

  if (!raw) return raw;

  return raw.startsWith("table_") ? raw : `table_${raw}`;

}

window.getTableKey = getTableKey;



window.updateGlobalChefTime = async function (mins) {

  await update(ref(db, BASE_PATH + "/settings"), { normalOrderBaseTime: Number(mins) });

};



window.toggleGlobalFastOrder = async function (isActive) {

  await update(ref(db, BASE_PATH + "/settings"), { fastOrderActive: isActive });

};



// ==========================================

// 📝 OSHPAZ HARAKATLARINI LOG QILISH

// ==========================================

window.logChefAction = async function (message) {

  const restId = localStorage.getItem("restaurantId");

  const chefName = localStorage.getItem("userName") || t("chef_label", "Oshpaz");



  try {

    const newLogRef = push(ref(db, `restaurants/${restId}/activityLogs`));

    await set(newLogRef, {

      action: "kitchen_update",

      description: `👨‍🍳 ${message}`,

      userName: chefName,

      createdAt: Date.now()

    });

  } catch (e) {

    console.error(t("log_write_error", "Log yozishda xato:"), e);

  }

};



window.moveOrder = async function (orderId, newStatus) {

  if (window.isChefMonitorMode && window.isChefMonitorMode()) return; // 🖥️ Monitor rejimi: faqat ko'rish

  const restId = localStorage.getItem("restaurantId");

  const orderRef = ref(db, `restaurants/${restId}/orders/${orderId}`);



  const statusMap = {

    "cooking": "cooking",

    "preparing": "cooking",

    "tayyorlanmoqda": "cooking",

    "ready": "ready",

    "tayyor": "ready"

  };



  const finalStatus = statusMap[newStatus] || newStatus;



  try {

    await update(orderRef, {

      status: finalStatus,

      statusKey: finalStatus,

      updatedAt: Date.now()

    });



    if (typeof window.logChefAction === "function") {

      const statusText = finalStatus === "ready" ? t("status_ready", "tayyor") : t("status_cooking", "pishirilmoqda");

      await window.logChefAction(`#${orderId.slice(-4)} - ${t("status_updated")}: ${statusText}`);

    }

  } catch (error) {

    console.error("Status update error:", error);

  }

};



function getStoredChefId() {

  return String(

    sessionStorage.getItem("chefId") ||

    sessionStorage.getItem("userId") ||

    sessionStorage.getItem("uid") ||

    localStorage.getItem("currentUserId") ||

    localStorage.getItem("id") ||

    ""

  ).trim();

}



// ==============================

// 🔄 DİNAMIK ROL KUZATUVCHISI 

// ==============================

window.listenToMyRoleChange = async function () {

  const restId = localStorage.getItem("restaurantId");

  const userId = currentChefId || sessionStorage.getItem("userId");



  if (!restId || !userId) {

    console.warn(t("role_watch_no_data", "Rolni kuzatish uchun ma'lumotlar yetarli emas."));

    return;

  }



  try {

    onValue(ref(db, `restaurants/${restId}/users/${userId}/role`), (snap) => {

      if (!snap.exists()) return;



      const newRole = snap.val();

      const currentLocalRole = sessionStorage.getItem("role") || "chef";



      if (newRole && newRole !== currentLocalRole) {

        sessionStorage.setItem("role", newRole);

        const currentPath = window.location.pathname.toLowerCase();



        if (newRole === "admin" && !currentPath.includes("admin.html")) {

          alert(t("admin_rights_granted", "👑 Sizga Asosiy Boshqaruvchi (Admin) huquqlari berildi!"));

          window.location.replace(`admin.html?id=${restId}`);

        }

        else if (newRole === "chef" && !currentPath.includes("chef.html")) {

          alert(t("role_changed_chef", "👨‍🍳 Rolingiz o'zgardi. Oshpaz paneliga qaytarilmoqdasiz..."));

          window.location.replace(`chef.html?id=${restId}`);

        }

        else if (newRole === "waiter" && !currentPath.includes("waiter.html")) {

          alert(t("role_changed_waiter", "🧑‍🍳 Rolingiz o'zgardi. Ofitsiant paneliga qaytarilmoqdasiz..."));

          window.location.replace(`waiter.html?id=${restId}`);

        }

      }

    });

  } catch (error) {

    console.error(t("role_watch_error", "Rolni kuzatishda xatolik:"), error);

  }

};



// ==========================================

// ⏳ OBUNA VA TARIFNI KUZATISH TAYMERI

// ==========================================

window.startChefSubscriptionTimer = async function () {

  const restId = localStorage.getItem("restaurantId");

  if (!restId) return;



  let container = document.getElementById("subTimerContainer");

  if (!container) {

    const logo = document.querySelector(".chef-header .logo") || document.querySelector(".logo");

    if (logo) {

      container = document.createElement("div");

      container.id = "subTimerContainer";

      container.style.marginLeft = "20px";

      logo.parentNode.insertBefore(container, logo.nextSibling);

    } else return;

  }



  try {

    const infoSnap = await get(ref(db, `restaurants/${restId}/info/tariff`));

    const currentTariff = String(infoSnap.val() || "START").toUpperCase();



    // Bug fix: the listener below only ever reacted to subscription.expireDate
    // (a countdown badge) — it never checked restaurants/{id}/info/status,
    // which is what Super Admin's Block/Pause action actually writes
    // (window.toggleBlockRestaurant/togglePauseRestaurant in superadmin.js).
    // A chef already on the Kitchen Display never got locked out when Super
    // Admin blocked their restaurant mid-session.
    onValue(ref(db, `restaurants/${restId}/info/status`), (statusSnap) => {
      const status = statusSnap.val();
      if (status !== "blocked" && status !== "paused") return;
      window.location.href = `expired.html?rest=${encodeURIComponent(restId)}`;
    });

    onValue(ref(db, `restaurants/${restId}/subscription`), (snap) => {

      const subData = snap.val();

      const expireVal = subData?.expireDate || subData?.expireAt || subData?.endDate;



      if (!subData || !expireVal) return;



      const expiryDate = new Date(expireVal).getTime();

      const runTimer = () => {

        const now = new Date().getTime();

        const diff = expiryDate - now;



        if (diff <= 0) {

          container.innerHTML = `<div style="background:#fee2e2; color:#b91c1c; padding:6px 12px; border-radius:10px; font-weight:700; font-size:11px; border:1px solid #f87171;">⚠️ ${t("subscription_expired", "MUDDAT TUGADI")}</div>`;

          return;

        }



        const d = Math.floor(diff / (1000 * 60 * 60 * 24));

        const h = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

        const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));



        let color = d < 2 ? "#dc2626" : (d < 7 ? "#d97706" : "#059669");



        container.innerHTML = `

                    <div style="background:#f8fafc; color:${color}; padding:5px 12px; border-radius:10px; border:1px solid #e2e8f0; display:flex; align-items:center; gap:8px; box-shadow:0 2px 5px rgba(0,0,0,0.05);">

                        <i class="fa-solid fa-clock" style="font-size:14px;"></i>

                        <div style="display:flex; flex-direction:column; line-height:1.1;">

                            <span style="font-size:8px; font-weight:800; opacity:0.6;">${t("tariff", "TARIF")}: ${currentTariff}</span>

                            <span style="font-size:12px; font-weight:700;">${d > 0 ? d + 'k ' : ''}${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}</span>

                        </div>

                    </div>`;

      };



      if (window.chefSubInterval) clearInterval(window.chefSubInterval);

      window.chefSubInterval = setInterval(runTimer, 60000);

      runTimer();

    });

  } catch (e) { console.error(t("timer_error_log", "Timer error:"), e); }

};



/* =========================

   STATE

========================= */

let allOrders = {};

window.allOrders = allOrders;

let searchDebounceTimer = null;

const PERSONAL_CHEF_ROOM = currentChefId ? `dm_${currentChefId}` : "dm_unknown";

let currentChefChatRoom = localStorage.getItem("chefChatRoom") || PERSONAL_CHEF_ROOM;

let orderCountdownInterval = null;

let lastOrdersSignature = "";

let socketConnected = false;



window.listeners = {};

window.addEventListener('beforeunload', () => {

  Object.values(window.listeners || {}).forEach(unsub => unsub?.());

});



// ==========================================

// 📅 DAVOMAT (ATTENDANCE) TRACKER — CHEF

// ==========================================

// 🩹 P0 Auth Fix (this pass) — root-caused live: "Uncaught (in promise)
// Error: Permission denied" at initChefAttendance's get(attendRef). This
// whole IIFE used to run unguarded at module-parse time — the SAME race
// already fixed for the kitchenStations listener just above (line ~214:
// `auth.authStateReady().then(...)`), but never ported to this function.
// Firebase Auth's session restore is always asynchronous, even for an
// already-valid session (a normal chef login, or — as reproduced live —
// an admin's "viewAs" observer session), so auth.currentUser is reliably
// null for a brief window on every page load; a read sent during that
// window fails database.rules.json's `auth != null` requirement — not a
// role/restId problem. get(attendRef).then() also had no .catch(), which
// is what turned that denial into an unhandled rejection instead of a
// clean, logged failure. Fixed both: the whole body now waits for
// auth.authStateReady() (same non-blocking .then() style as
// kitchenStations, so nothing else in this module is held up by it), and
// the initial get() has its own .catch() (the update()/onDisconnect()/
// setInterval() calls below already had theirs).
(function initChefAttendance() {

  const restId = localStorage.getItem("restaurantId");

  const userId = sessionStorage.getItem("userId") || sessionStorage.getItem("chefId") || sessionStorage.getItem("uid");

  if (!restId || !userId) return;



  const todayKey = new Date().toISOString().slice(0, 10); // "2025-06-01"

  const attendRef = ref(db, `restaurants/${restId}/attendance/${todayKey}/${userId}`);

  auth.authStateReady().then(() => {

    // Sahifa ochilganda — "keldi" deb belgilash

    const now = Date.now();

    get(attendRef).then(snap => {

      const existing = snap.val() || {};

      const updates = {

        name: localStorage.getItem("userName") || "Oshpaz",

        role: "chef",

        date: todayKey,

        status: "present",

        lastSeen: now

      };

      // Birinchi marta kelganda onlineAt ni yozamiz, keyingilarda o'zgartirmaymiz

      if (!existing.onlineAt) updates.onlineAt = now;

      update(attendRef, updates).catch(() => { });

    }).catch(err => console.warn("[CHEF-AUTH] initChefAttendance get() failed:", err?.code || err?.message));



    // Firebase onDisconnect — internet uzilsa avtomatik offlineAt yoziladi

    import("https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js").then(({ onDisconnect }) => {

      onDisconnect(attendRef).update({

        status: "offline",

        offlineAt: Date.now(),

        lastSeen: Date.now()

      }).catch(() => { });

    });



    // Sahifa yopilganda lastSeen yangilash

    window.addEventListener("beforeunload", () => {

      const offNow = Date.now();

      // navigator.sendBeacon orqali sinxron emas, lekin eng ishonchli yo'l

      try {

        update(attendRef, { status: "offline", offlineAt: offNow, lastSeen: offNow }).catch(() => { });

      } catch (_) { }

    });



    // Har 2 daqiqada lastSeen yangilab turish (real-time online holati uchun)

    setInterval(() => {

      update(attendRef, { lastSeen: Date.now(), status: "present" }).catch(() => { });

    }, 2 * 60 * 1000);

  }).catch(err => console.warn("[CHEF-AUTH] authStateReady() failed (initChefAttendance):", err?.code || err?.message));

})();



window.allChefs = {};

window.allMenu = {};

window.orderChatsByOrder = {};

window.chefChats = {};

window.tableStates = {};

window.delayedAlertedOrders = window.delayedAlertedOrders || new Set();

window.kitchenAuditLogs = window.kitchenAuditLogs || [];

window.kitchenNotifications = window.kitchenNotifications || [];

window.stopList = window.stopList || {};

window.orderTimelines = window.orderTimelines || {};

window.chefSettings = window.chefSettings || {};

window.__stopListAlertedOrders = window.__stopListAlertedOrders || new Set();

window.__kitchenNotificationTimer = null;

window.__kitchenRealtimeTimer = null;

window.__kitchenTickerTimer = null;



/* =========================

   OPTIONAL SOCKET.IO

========================= */

const SOCKET_URL =

  localStorage.getItem("socketUrl") ||

  document.documentElement.dataset.socketUrl ||

  window.location.origin;



const socket = typeof window.io === "function"

  ? window.io(SOCKET_URL, {

    transports: ["websocket", "polling"],

    autoConnect: true,

    reconnection: true

  })

  : null;



function emitSocket(eventName, payload) {

  if (!socket || !socketConnected) return;

  try {

    socket.emit(eventName, payload);

  } catch (err) {

    console.warn(t("socket_emit_error", "Socket emit xatolik:"), err);

  }

}



function listenSocket() {

  if (!socket) return;



  socket.on("connect", () => {

    socketConnected = true;

    emitSocket("chef:join", {

      chefId: currentChefId,

      chefName: sessionStorage.getItem("name") || t("chef_label", "Chef"),

      role: "chef",

      restId: currentRestaurantId

    });

    showNotification(`🟢 ${t("socket_connected", "Tizimga ulandi")}`);

  });



  socket.on("disconnect", () => {

    socketConnected = false;

    showNotification(`🟡 ${t("socket_disconnected", "Tarmoq uzildi")}`);

  });



  socket.on("chef:new-order", payload => {

    if (!payload) return;

    const targetChefId = String(payload.chefId || "").trim();

    if (targetChefId && targetChefId === String(currentChefId)) {

      playSound();

      showNotification(`🆕 ${t("new_order_arrived", "Yangi buyurtma")}: #${payload.orderNumber || payload.orderId || ""}`);

    }

  });



  socket.on("chef:status-updated", payload => {

    if (!payload?.orderId) return;

    showNotification(`🔄 ${t("status_label")}: ${payload.statusLabel || payload.status || ""}`);

  });



  socket.on("chef:chat-message", payload => {

    if (!payload) return;

    if (payload.senderId !== currentChefId) {

      playSound();

      showNotification(`💬 ${payload.senderName || t("chef_label", "Oshpaz")}: ${payload.text || ""}`);

    }

  });





}



function ensureChefEnhancementLayout() {

  const header = document.querySelector(".chef-header");

  const main = document.querySelector("main.container");

  if (!header || !main) return;



  if (!document.getElementById("chefAllergyStyle")) {

    const s = document.createElement("style");

    s.id = "chefAllergyStyle";

    s.textContent = `

      .order-allergy-note {

        display: flex; align-items: flex-start; gap: 6px;

        margin-top: 10px; padding: 8px 10px;

        background: rgba(255, 200, 0, 0.12);

        border: 1.5px solid rgba(255, 200, 0, 0.45);

        border-radius: 8px; font-size: 13px; line-height: 1.4;

      }

      .allergy-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }

      .allergy-text { color: #f5c518; font-weight: 600; word-break: break-word; }

      @keyframes chefShake {

        0%,100%{transform:translateX(0)}

        10%,30%,50%,70%,90%{transform:translateX(-4px)}

        20%,40%,60%,80%{transform:translateX(4px)}

      }

      .shake-anim { animation: chefShake 0.6s ease infinite; }

      .chef-card-countdown { transition: color 0.5s ease; }

    `;

    document.head.appendChild(s);

  }







  if (!document.getElementById("chefDetailModal")) {

    const modal = document.createElement("div");

    modal.id = "chefDetailModal";

    modal.className = "chef-detail-modal";

    modal.style.display = "none";

    modal.innerHTML = `

      <div class="chef-detail-dialog">

        <div class="chef-detail-head">

          <h3>🍽 ${t("order_detail_title", "Order detail")}</h3>

          <button type="button" class="btn-close" onclick="closeChefOrderDetail()">✖</button>

        </div>

        <div id="chefDetailContent" class="chef-detail-content"></div>

      </div>

    `;

    document.body.appendChild(modal);

  }



  if (!document.getElementById("chefRecipeStyle")) {

    const rs = document.createElement("style");

    rs.id = "chefRecipeStyle";

    rs.textContent = `

      .chef-recipe-modal {

        position: fixed; inset: 0; z-index: 100000;

        background: rgba(15, 23, 42, .55);

        backdrop-filter: blur(4px);

        display: flex; align-items: center; justify-content: center;

        padding: 16px;

      }

      .chef-recipe-dialog {

        width: 100%; max-width: 560px; max-height: 86vh;

        background: #0F172A; border-radius: 20px;

        border: 1px solid rgba(255,255,255,.08);

        box-shadow: 0 24px 64px rgba(0,0,0,.4);

        display: flex; flex-direction: column; overflow: hidden;

      }

      .chef-recipe-head {

        display: flex; align-items: center; justify-content: space-between;

        gap: 12px; padding: 18px 20px;

        border-bottom: 1px solid rgba(255,255,255,.08);

        flex-shrink: 0;

      }

      .chef-recipe-head h3 {

        margin: 0; font-family: 'Sora', sans-serif; font-size: 17px;

        font-weight: 800; color: #fff;

        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;

      }

      .chef-recipe-head .btn-close {

        flex-shrink: 0; background: rgba(255,255,255,.08); border: none;

        color: #e2e8f0; width: 32px; height: 32px; border-radius: 10px;

        font-size: 15px; cursor: pointer; line-height: 1;

      }

      .chef-recipe-body {

        padding: 18px 20px 22px; overflow-y: auto;

      }

      .chef-recipe-photo {

        width: 100%; height: 180px; object-fit: cover;

        border-radius: 14px; margin-bottom: 16px;

        background: rgba(255,255,255,.05);

      }

      .chef-recipe-section-title {

        font-family: 'Inter', sans-serif; font-size: 12px; font-weight: 800;

        letter-spacing: .4px; text-transform: uppercase; color: #94A3B8;

        margin: 0 0 10px;

      }

      .chef-recipe-ingredients {

        list-style: none; margin: 0 0 18px; padding: 0;

        display: flex; flex-direction: column; gap: 8px;

      }

      .chef-recipe-ingredients li {

        display: flex; align-items: center; justify-content: space-between;

        gap: 10px; padding: 9px 12px;

        background: rgba(255,255,255,.04);

        border: 1px solid rgba(255,255,255,.06);

        border-radius: 10px;

        font-family: 'Inter', sans-serif; font-size: 13.5px; color: #e2e8f0;

      }

      .chef-recipe-ingredients .qty {

        flex-shrink: 0; font-weight: 700; color: #FFB088;

        background: rgba(255,122,69,.12);

        padding: 2px 9px; border-radius: 999px; font-size: 12.5px;

      }

      .chef-recipe-steps {

        margin: 0 0 18px; padding-left: 20px;

        display: flex; flex-direction: column; gap: 10px;

      }

      .chef-recipe-steps li {

        font-family: 'Inter', sans-serif; font-size: 13.5px;

        line-height: 1.55; color: #cbd5e1; padding-left: 4px;

      }

      .chef-recipe-video {

        width: 100%; border-radius: 14px; margin-bottom: 18px;

        background: #000; aspect-ratio: 16/9;

      }

      .chef-recipe-allergy {

        display: flex; align-items: flex-start; gap: 8px;

        padding: 10px 12px; border-radius: 10px;

        background: rgba(255, 200, 0, 0.10);

        border: 1.5px solid rgba(255, 200, 0, 0.35);

        font-family: 'Inter', sans-serif; font-size: 13px; color: #f5c518;

        font-weight: 600; line-height: 1.4;

      }

      .chef-recipe-empty {

        text-align: center; color: #64748B; font-size: 13.5px;

        padding: 30px 10px; font-family: 'Inter', sans-serif;

      }

      .chef-recipe-btn {

        background: rgba(255,255,255,0.08); color: #e2e8f0;

        border: 1.5px solid rgba(255,255,255,0.15);

        padding: 6px 10px; border-radius: 8px;

        font-size: 11px; font-weight: 700; cursor: pointer;

        white-space: nowrap; display: inline-flex; align-items: center; gap: 5px;

      }

      .chef-recipe-btn:hover { background: rgba(255,255,255,0.14); }

    `;

    document.head.appendChild(rs);

  }



  if (!document.getElementById("chefRecipeModal")) {

    const rmodal = document.createElement("div");

    rmodal.id = "chefRecipeModal";

    rmodal.className = "chef-recipe-modal";

    rmodal.style.display = "none";

    rmodal.innerHTML = `

      <div class="chef-recipe-dialog">

        <div class="chef-recipe-head">

          <h3 id="chefRecipeTitle">🍳 ${t("recipe_modal_title", "Retsept")}</h3>

          <button type="button" class="btn-close" onclick="window.closeChefRecipe()">✖</button>

        </div>

        <div id="chefRecipeContent" class="chef-recipe-body"></div>

      </div>

    `;

    document.body.appendChild(rmodal);

    rmodal.addEventListener("click", (e) => {

      if (e.target === rmodal) window.closeChefRecipe();

    });

  }

}



document.addEventListener("input", (e) => {

  const ids = ["chefStatusFilter", "chefTableFilter", "chefSearchInput"];

  if (ids.includes(e.target.id)) {

    if (typeof renderChefOrders === "function") {

      renderChefOrders();

    }

  }

});



/* =========================

   DOM ELEMENTS

========================= */

const chefFilterEl = document.getElementById("chefFilter");

const categoryFilterEl = document.getElementById("categoryFilter");

const subFilterEl = document.getElementById("subFilter");

const langSelect = document.getElementById("langSelect");

const activeBox = document.getElementById("chefOrders");

const readyBox = document.getElementById("readyOrders");

const newOrdersBadge = document.getElementById("newOrdersBadge");

const myActiveCountEl = document.getElementById("myActiveCount");

const allChefsStatsEl = document.getElementById("allChefsStats");

const statsPanelEl = document.getElementById("statsPanel");

const chefChatRoomsDom = document.getElementById("chefChatRooms");

const chefChatMessagesDom = document.getElementById("chefChatMessages");

const chefChatInputDom = document.getElementById("chefChatInput");

const chefChatSendBtnDom = document.getElementById("chefChatSendBtn");

const chefChatTitleDom = document.getElementById("chefChatTitle");







/* =========================

   HELPERS

========================= */

/* =========================

   OVOZLI SIGNAL TIZIMI (Chef)

========================= */

let _chefAudioCtx = null;

let _chefUserInteracted = false;

let _chefPendingSound = false; // Foydalanuvchi bosmagunicha kutuvchi signal



// AudioContext faqat foydalanuvchi gesture dan keyin yaratiladi

function _chefGetAudioCtx() {

  if (_chefAudioCtx && _chefAudioCtx.state === "running") return _chefAudioCtx;

  if (_chefAudioCtx && _chefAudioCtx.state === "suspended") {

    _chefAudioCtx.resume().catch(() => { });

    return _chefAudioCtx;

  }

  if (!_chefUserInteracted) return null; // Gesture bo'lmasa — yaratmaymiz

  try {

    _chefAudioCtx = new (window.AudioContext || window.webkitAudioContext)();

    return _chefAudioCtx;

  } catch (e) { return null; }

}



// Foydalanuvchi birinchi gesture sida unlock + kutayotgan signal ijro etiladi

(function () {

  const unlock = async () => {

    _chefUserInteracted = true;

    // AudioContext yaratamiz (gesture ichida — sinxron)

    if (!_chefAudioCtx) {

      try { _chefAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { }

    }

    // resume() ni await bilan kutamiz — Chrome talabi

    if (_chefAudioCtx && _chefAudioCtx.state === "suspended") {

      try { await _chefAudioCtx.resume(); } catch (e) { }

    }

    document.removeEventListener("click", unlock, true);

    document.removeEventListener("keydown", unlock, true);

    document.removeEventListener("touchstart", unlock, true);

    document.removeEventListener("touchend", unlock, true);

    // Agar signal kelgan bo'lsa — resume tugagandan keyin ijro etamiz

    if (_chefPendingSound) {

      _chefPendingSound = false;

      setTimeout(() => _playNewOrderBeep(), 50);

    }

  };

  document.addEventListener("click", unlock, true);

  document.addEventListener("keydown", unlock, true);

  document.addEventListener("touchstart", unlock, true);

  document.addEventListener("touchend", unlock, true);

})();



function _chefBeep(freq, duration, gain, delay) {

  const ctx = _chefGetAudioCtx();

  if (!ctx) return;

  try {

    const osc = ctx.createOscillator();

    const vol = ctx.createGain();

    osc.connect(vol);

    vol.connect(ctx.destination);

    osc.type = "sine";

    osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);

    vol.gain.setValueAtTime(gain, ctx.currentTime + delay);

    vol.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);

    osc.start(ctx.currentTime + delay);

    osc.stop(ctx.currentTime + delay + duration);

  } catch (e) { }

}



function _playChefBeepPattern() {

  // 5 marta jiringlash

  _chefBeep(880, 0.18, 0.7, 0.00);

  _chefBeep(660, 0.18, 0.6, 0.22);

  _chefBeep(880, 0.18, 0.7, 0.55);

  _chefBeep(660, 0.18, 0.6, 0.77);

  _chefBeep(1100, 0.28, 0.8, 1.10);

}



function _playNewOrderBeep() {

  _chefBeep(880, 0.18, 0.7, 0.00);

  _chefBeep(660, 0.18, 0.6, 0.22);

  _chefBeep(880, 0.18, 0.7, 0.55);

  _chefBeep(660, 0.18, 0.6, 0.77);

  _chefBeep(1100, 0.28, 0.8, 1.10);

}



// WAV + Web Audio fallback — foydalanuvchi gesture sini tekshiradi

function _chefPlayAudio(isNewOrder) {

  if (window.chefSettings && window.chefSettings.soundEnabled === false) return;



  const tryWebAudio = () => {

    if (!_chefUserInteracted) {

      // Hali bosimagan — signalni queue ga qo'yamiz

      _chefPendingSound = true;

      return;

    }

    if (isNewOrder) _playNewOrderBeep();

    else _playChefBeepPattern();

  };



  // Avval WAV urinib ko'ramiz

  try {

    const audio = new Audio("/img/notify.wav?v=2");

    audio.volume = isNewOrder ? 1.0 : 0.85;

    const p = audio.play();

    if (p) {

      p.catch(() => tryWebAudio());

    } else {

      tryWebAudio();

    }

  } catch (e) {

    tryWebAudio();

  }

}



function playSound() {

  _chefPlayAudio(false);

}



// Yangi order uchun alohida kuchli signal

function playNewOrderSound() {

  _chefPlayAudio(true);

}



const STATUS_LABELS = {

  new: "new",

  approved: "approved",

  cooking: "cooking",

  ready: "ready",

  closed: "closed"

};



function getAssignedChefId(orderId, order = null) {

  const orderChefId = String(order?.chefId || "").trim();

  if (orderChefId) return orderChefId;

  const chatChefId = String(

    window.orderChatsByOrder?.[orderId]?.meta?.targetId || ""

  ).trim();

  if (chatChefId) return chatChefId;

  return "";

}



function getAssignedChefName(orderId, order = null) {

  const chefId = String(getAssignedChefId(orderId, order) || "");

  if (!chefId) return "—";

  return window.allChefs?.[chefId]?.name || chefId;

}



function getSelectedChef() {

  return chefFilterEl?.value || localStorage.getItem("chefFilter") || "all";

}



function getSelectedCategory() {

  return categoryFilterEl?.value || localStorage.getItem("categoryFilter") || "all";

}



function getSelectedSub() {

  return subFilterEl?.value || localStorage.getItem("subFilter") || "all";

}



function getLocale() {

  if (currentLang === "ru") return "ru-RU";

  if (currentLang === "en") return "en-GB";

  return "uz-UZ";

}



function escapeChatHTML(str = "") {

  return String(str).replace(/[&<>"']/g, s => ({

    "&": "&amp;",

    "<": "&lt;",

    ">": "&gt;",

    '"': "&quot;",

    "'": "&#39;"

  }[s]));

}



function escapeHtml(value = "") {

  return String(value).replace(/[&<>"']/g, ch => ({

    "&": "&amp;",

    "<": "&lt;",

    ">": "&gt;",

    '"': "&quot;",

    "'": "&#39;"

  }[ch] || ch));

}



function escapeJsString(value = "") {

  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

}



function formatClock(ts) {

  if (!ts) return "--:--";

  return new Date(ts).toLocaleTimeString(getLocale(), {

    hour: "2-digit",

    minute: "2-digit"

  });

}



function formatOrderTime(ts) {

  if (!ts) return "—";

  return new Date(ts).toLocaleTimeString(getLocale(), {

    hour: "2-digit",

    minute: "2-digit"

  });

}



function formatDateTime(ts) {

  if (!ts) return "—";

  return new Date(ts).toLocaleString(getLocale(), {

    year: "numeric", month: "2-digit", day: "2-digit",

    hour: "2-digit", minute: "2-digit"

  });

}



function formatDuration(ms) {

  const totalMs = Number(ms || 0);

  if (!totalMs || totalMs < 0) return `0 ${t("minute_short", "daq")}`;

  const totalSec = Math.floor(totalMs / 1000);

  const h = Math.floor(totalSec / 3600);

  const m = Math.floor((totalSec % 3600) / 60);

  const s = totalSec % 60;

  if (h > 0) return `${h} ${t("hour_short", "soat")} ${m} ${t("minute_short", "daq")}`;

  if (m > 0) return `${m} ${t("minute_short", "daq")} ${s} ${t("second_short", "soniya")}`;

  return `${s} ${t("second_short", "soniya")}`;

}



function formatMoney(amount, currency = "UZS") {

  const num = Number(amount || 0);

  try {

    return new Intl.NumberFormat(getLocale(), {

      style: "currency",

      currency,

      maximumFractionDigits: currency === "UZS" ? 0 : 2

    }).format(num);

  } catch (_) {

    return `${num.toLocaleString(getLocale())} ${currency}`;

  }

}



function isFastOrder(order) {

  return String(order?.priority || "").toLowerCase() === "fast";

}



function normalizeText(value = "") {

  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();

}



function normalizeKitchenStatus(status) {

  const s = normalizeText(status);

  const map = {

    // "Yangi" — hali oshxonaga chek chiqmagan / navbatda turgan buyurtmalar

    yangi: "new", new: "new", pending: "new", queue: "new", kutilmoqda: "new",

    // "Tasdiqlandi" — chek oshxonaga chiqdi, lekin hali faol pishirilmayapti

    tasdiqlandi: "approved", approved: "approved",

    // "Tayyorlanmoqda" — faol pishirilmoqda

    tayyorlanmoqda: "cooking", cooking: "cooking",

    // "Tayyor" — pishirish tugadi, olib ketilishi kutilmoqda

    tayyor: "ready", ready: "ready",

    // "Yopildi" — oshxona uchun harakatsiz/yakunlangan holatlar. Bekor

    // qilingan buyurtmalar ham shu yerga tushadi — ilgari bu yerda

    // yo'q edi va standart holatda "new"ga tushib, oshxona navbatida

    // faol buyurtma sifatida ko'rinib qolardi (xato edi, tuzatildi).

    yopildi: "closed", closed: "closed",

    "to'landi": "closed", tolandi: "closed", paid: "closed", completed: "closed",

    "bekor qilindi": "closed", cancelled: "closed", canceled: "closed",

    delivered: "closed", yetkazildi: "closed", yetkazilmoqda: "closed",

    delivering: "closed", eating: "closed",



    // 🆕 Yangi status flow (shared.js: ORDER_STATUS_V2) — chef.js'ning

    // eski 5-bosqichli state machine'iga mos keladigan bosqichga tushiriladi,

    // shunda quyidagi processChefAction/updateOrderKitchenStatus logikasi

    // o'zgarishsiz ishlashda davom etadi:

    waiter: "new",

    order_created: "new",

    kitchen_printer: "approved",

    kitchen_display: "approved",

    preparing: "cooking",

    picked_up: "ready",

    served: "closed",

    cashier: "closed",

    payment: "closed"

  };

  return map[s] || "new";

}



function getOrderStatus(order) {

  return normalizeKitchenStatus(order?.status || order?.statusKey);

}



function getStatusText(status) {

  const s = normalizeKitchenStatus(status);

  const map = {

    new: "status_created",

    approved: "status_admin_approved",

    cooking: "status_cooking",

    ready: "status_ready",

    closed: "status_closed"

  };

  return t(map[s] || "status_created", "Yaratildi");

}



function getMenuName(menu, fallback = "") {

  if (!menu) return fallback;

  if (typeof menu.name === "object" && menu.name !== null) {

    return menu.name[currentLang] || menu.name.uz || menu.name.ru || menu.name.en || fallback;

  }

  if (typeof menu.name === "string") return menu.name;

  return fallback;

}



// ─── Allergiya chiplarini joriy tilga o'girish ────────────────────────────────

// allergyNote Firebase da istalgan tilda matn sifatida saqlanadi

// Bu funksiya barcha tillardagi qiymatlarni teskari izlab, t() orqali joriy tilga o'giradi

const _CHIP_REVERSE_MAP = (() => {

  // key → [uz, ru, en] barcha mumkin qiymatlar (kichik harfda)

  const TABLE = {

    chip_no_salt: ["tuzsiz", "без соли", "no salt"],

    chip_low_salt: ["kam tuzli", "мало соли", "low salt"],

    chip_no_spicy: ["achchiqsiz", "без острого", "not spicy"],

    chip_spicy: ["achchiq", "острое", "spicy"],

    chip_no_onion: ["piyozsiz", "без лука", "no onion"],

    chip_no_greens: ["ko'katsiz", "без зелени", "no greens"],

    chip_no_oil: ["yog'siz", "без масла", "no oil"],

    chip_vegetarian: ["vegetarian", "вегетарианское", "vegetarian"],

  };

  const map = {};

  Object.entries(TABLE).forEach(([key, variants]) => {

    variants.forEach(v => { map[v] = key; });

  });

  return map;

})();



function translateAllergyNote(note) {

  if (!note) return "";

  return note

    .split(",")

    .map(part => {

      const trimmed = part.trim();

      const key = _CHIP_REVERSE_MAP[trimmed.toLowerCase()];

      return key ? t(key, trimmed) : trimmed;

    })

    .join(", ");

}



function getTranslatedItemName(item, menuItem = null, lang = currentLang || "uz") {

  if (menuItem?.name) {

    if (typeof menuItem.name === "object") {

      return menuItem.name[lang] || menuItem.name.uz || menuItem.name.ru || menuItem.name.en || "—";

    }

    return menuItem.name || "—";

  }

  if (item?.name) {

    if (typeof item.name === "object") {

      return item.name[lang] || item.name.uz || item.name.ru || item.name.en || "—";

    }

    return item.name || "—";

  }

  return "—";

}



function getOrderItemMenu(item) {

  const menuId = item.menuId || item.id || item.itemId;

  return window.allMenu?.[menuId] || null;

}



/* =========================

   RECIPE VIEWER

   Firebase yo'li: restaurants/{restId}/menu/{menuId}/recipe

   recipe: {

     ingredients: [{ name, grams }],

     steps: [ "matn", ... ]  yoki  [{ text }],

     videoUrl: "https://...",

     photoUrl: "https://...",

     allergyNote: "matn"

   }

========================= */

function renderChefRecipeContent(menu, dishName) {

  const recipe = menu?.recipe;



  if (!recipe || (!recipe.ingredients?.length && !recipe.steps?.length && !recipe.videoUrl && !recipe.photoUrl)) {

    return `<div class="chef-recipe-empty">🍳 ${t("recipe_not_found", "Bu taom uchun retsept hali qo'shilmagan")}</div>`;

  }



  const photoUrl = recipe.photoUrl || menu?.imgUrl || menu?.img || "";

  const photoHtml = photoUrl

    ? `<img class="chef-recipe-photo" src="${escapeHtml(photoUrl)}" alt="${escapeHtml(dishName)}" onerror="this.style.display='none'">`

    : "";



  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];

  const ingredientsHtml = ingredients.length ? `

    <div class="chef-recipe-section-title">🥕 ${t("recipe_ingredients", "Ingredientlar")}</div>

    <ul class="chef-recipe-ingredients">

      ${ingredients.map(ing => {

    const name = typeof ing === "string" ? ing : (ing?.name || "");

    const grams = typeof ing === "object" ? (ing?.grams ?? ing?.gram ?? ing?.amount) : null;

    const qtyTxt = (grams !== null && grams !== undefined && grams !== "")

      ? `${escapeHtml(String(grams))} ${t("gram_unit", "gr")}`

      : "";

    return `<li><span>${escapeHtml(name)}</span>${qtyTxt ? `<span class="qty">${qtyTxt}</span>` : ""}</li>`;

  }).join("")}

    </ul>` : "";



  const steps = Array.isArray(recipe.steps) ? recipe.steps : [];

  const stepsHtml = steps.length ? `

    <div class="chef-recipe-section-title">📋 ${t("recipe_steps", "Tayyorlash")}</div>

    <ol class="chef-recipe-steps">

      ${steps.map(s => `<li>${escapeHtml(typeof s === "string" ? s : (s?.text || ""))}</li>`).join("")}

    </ol>` : "";



  let videoHtml = "";

  if (recipe.videoUrl) {

    const isEmbeddable = /youtube\.com\/embed|player\.vimeo\.com/.test(recipe.videoUrl);

    videoHtml = isEmbeddable

      ? `<div class="chef-recipe-section-title">🎬 ${t("recipe_video", "Video")}</div>

         <iframe class="chef-recipe-video" src="${escapeHtml(recipe.videoUrl)}" frameborder="0" allowfullscreen></iframe>`

      : `<div class="chef-recipe-section-title">🎬 ${t("recipe_video", "Video")}</div>

         <video class="chef-recipe-video" src="${escapeHtml(recipe.videoUrl)}" controls></video>`;

  }



  const allergyText = recipe.allergyNote || menu?.allergyNote || "";

  const allergyHtml = allergyText

    ? `<div class="chef-recipe-allergy">⚠️ <span>${escapeHtml(translateAllergyNote(allergyText))}</span></div>`

    : "";



  return `${photoHtml}${ingredientsHtml}${stepsHtml}${videoHtml}${allergyHtml}`;

}



window.openChefRecipe = function (menuId, dishNameOverride) {

  ensureChefEnhancementLayout();

  const modal = document.getElementById("chefRecipeModal");

  const content = document.getElementById("chefRecipeContent");

  const titleEl = document.getElementById("chefRecipeTitle");

  if (!modal || !content) return;



  const menu = window.allMenu?.[menuId] || null;

  const dishName = dishNameOverride || getTranslatedItemName({}, menu || {}, currentLang) || menu?.name || t("food_label", "Taom");



  if (titleEl) titleEl.textContent = `🍳 ${dishName}`;

  content.innerHTML = renderChefRecipeContent(menu, dishName);

  modal.style.display = "flex";

};



window.closeChefRecipe = function () {

  const modal = document.getElementById("chefRecipeModal");

  if (modal) modal.style.display = "none";

};



function getCategoryLabel(categoryId) {

  if (!categoryId) return "";

  const cat = CATEGORY_DATA?.categories?.find(c => c.id === categoryId);

  return cat ? (t(cat.nameKey) || categoryId) : categoryId;

}



function getSubcategoryLabel(subKey) {

  if (!subKey) return "";

  return t(subKey) || subKey;

}



function formatRemainingMs(ms) {

  if (!ms || ms <= 0) return `0 ${t("minute_short", "daq")}`;

  const totalSec = Math.floor(ms / 1000);

  const h = Math.floor(totalSec / 3600);

  const m = Math.floor((totalSec % 3600) / 60);

  const s = totalSec % 60;

  if (h > 0) return `${h} ${t("hour_short", "soat")} ${m} ${t("minute_short", "daq")}`;

  return `${m} ${t("minute_short", "daq")} ${s} ${t("second_short", "soniya")}`;

}



function formatRemainingTime(readyAt) {

  const diff = Number(readyAt || 0) - Date.now();

  if (diff <= 0) return `✅ ${t("ready_time_reached")}`;

  const minutes = Math.floor(diff / 60000);

  const seconds = Math.floor((diff % 60000) / 1000);

  return `⏳ ${minutes}:${String(seconds).padStart(2, "0")} ${t("left_short", "qoldi")}`;

}



function getRemainingInfo(order) {

  const readyAt = Number(order?.readyAt || 0);

  if (!readyAt) {

    return {

      text: `⏳ ${t("time_not_set", "Vaqt belgilanmagan")}`,

      urgent: false,

      done: false,

      delayed: false,

      delayedMinutes: 0

    };

  }

  const diff = readyAt - Date.now();

  const urgent = diff > 0 && diff <= 5 * 60 * 1000;

  const done = diff <= 0;

  const delayedMinutes = done ? Math.floor(Math.abs(diff) / 60000) : 0;

  const delayed = delayedMinutes >= 20;

  if (done) {

    return {

      text: `✅ ${t("ready_time_reached", "Vaqt tugadi")}`,

      urgent: false,

      done: true,

      delayed,

      delayedMinutes

    };

  }

  return {

    text: `⏳ ${t("time_left_prefix", "Qoldi")}: ${formatRemainingMs(diff)}`,

    urgent,

    done: false,

    delayed: false,

    delayedMinutes: 0

  };

}



function showNotification(text) {

  const n = document.getElementById("notification");

  if (!n) {

    console.log(t("notification_log", "Notification:"), text);

    return;

  }

  n.innerText = text;

  n.classList.add("show");

  setTimeout(() => n.classList.remove("show"), 3000);

}



function showChefNotification(text) {

  showNotification(text);

}



/* =========================

   SECURITY + BOOTSTRAP

========================= */

async function ensureChefUserExists() {

  if (!currentChefId) return;

  const userRef = ref(db, BASE_PATH + "/users/" + currentChefId);

  const snap = await get(userRef);

  if (snap.exists()) return;

  await set(userRef, {

    id: currentChefId,

    name: sessionStorage.getItem("name") || t("chef_label", "Oshpaz"),

    role: "chef",

    active: true,

    createdAt: Date.now()

  });

}



async function ensureChefAccess(requiredPermission = "kitchen_access") {

  const snap = await get(ref(db, `${BASE_PATH}/users/${currentChefId}`));



  if (!snap.exists()) {

    alert(t("user_not_found", "User topilmadi"));

    window.location.replace("login.html");

    throw new Error("User not found");

  }



  const user = snap.val() || {};

  const permissions = Array.isArray(user.permissions) ? user.permissions : [];



  if (user.active === false) {

    alert(t("staff_inactive", "Sizning hisobingiz faolsizlantirilgan!"));

    window.location.replace("login.html");

    throw new Error("Inactive chef");

  }

  const isOwner = user.role === "admin";

  const isChef = user.role === "chef";

  const hasSpecificPermission = permissions.includes(requiredPermission);

  const hasGeneralPermission =

    permissions.includes("kitchen_access") ||

    permissions.includes("kitchen_manage") ||

    permissions.includes("all");



  const allowed = isOwner || isChef || hasSpecificPermission || hasGeneralPermission;



  if (!allowed) {

    alert(t("no_kitchen_permission", "Oshxona paneliga kirish uchun ruxsatingiz yo'q!"));

    window.location.replace("login.html");

    throw new Error("Permission denied");

  }



  return user;

}



/* =========================

   FILTERS

========================= */

function renderCategoryFilter() {

  if (!categoryFilterEl) return;

  const savedCategory = localStorage.getItem("categoryFilter") || "all";

  categoryFilterEl.innerHTML = `<option value="all">${t("all_categories", "Barcha kategoriyalar")}</option>`;

  (CATEGORY_DATA?.categories || []).forEach(cat => {

    const option = document.createElement("option");

    option.value = cat.id;

    option.textContent = t(cat.nameKey);

    categoryFilterEl.appendChild(option);

  });

  categoryFilterEl.value = savedCategory;

}



function renderSubFilter(categoryId = "all") {

  if (!subFilterEl) return;

  const savedSub = localStorage.getItem("subFilter") || "all";

  subFilterEl.innerHTML = `<option value="all">${t("all_subcategories", "Barcha subkategoriyalar")}</option>`;

  if (categoryId === "all") {

    subFilterEl.value = "all";

    return;

  }

  const category = CATEGORY_DATA?.categories?.find(c => c.id === categoryId);

  (category?.sub || []).forEach(subKey => {

    const option = document.createElement("option");

    option.value = subKey;

    option.textContent = t(subKey);

    subFilterEl.appendChild(option);

  });

  const exists = [...subFilterEl.options].some(opt => opt.value === savedSub);

  subFilterEl.value = exists ? savedSub : "all";

}



function fillChefFilter(users) {

  if (!chefFilterEl) return;

  const previousValue = chefFilterEl.value || localStorage.getItem("chefFilter") || "all";

  chefFilterEl.innerHTML = `<option value="all">${t("all_items", "Barchasi")}</option>`;

  Object.entries(users).forEach(([id, user]) => {

    if (user.role !== "chef") return;

    const option = document.createElement("option");

    option.value = id;

    option.textContent = `${user.active !== false ? "🟢" : "🔴"} ${user.name || id}`;

    chefFilterEl.appendChild(option);

  });

  const exists = [...chefFilterEl.options].some(opt => opt.value === previousValue);

  chefFilterEl.value = exists ? previousValue : "all";

}



function matchesFilters(order) {

  const selectedChef = getSelectedChef();

  const selectedCategory = getSelectedCategory();

  const selectedSub = getSelectedSub();

  if (selectedChef !== "all") {

    if (String(order.chefId || "") !== String(selectedChef)) return false;

  }



  // ── 🍳 Kitchen Station bo'yicha qat'iy filterlash ──

  // Har bir menu itemda kitchenStation maydoni bo'ladi (masalan: "somsachi", "pizza_chef", "bar", "grill").

  // Oshpazning kitchenStation qiymati bo'lsa, faqat o'sha stansiyaga tegishli

  // taomlar bo'lgan buyurtmalar ko'rinadi. Stansiya belgilanmagan ("general"

  // ── 🍳 Oshpazning bo'limi bo'yicha avtomatik filterlash ──────────────────

  // Oshpazning barcha tanlangan bo'limlari (kitchenStation + chefCategories

  // massivi birlashtirilib) bitta ro'yxatga yig'iladi. Shu ro'yxatdagi BIRON

  // bo'limga mos taom bo'lsa, buyurtma ko'rinadi (OR-mantiq).

  // "general" yoki bo'sh ro'yxat bo'lsa — hamma buyurtmalar ko'rinadi.

  const myChef = window.allChefs?.[currentChefId];

  const myStationsSingle = myChef?.kitchenStation ? [normalizeText(myChef.kitchenStation)] : [];

  const myStationsArray = Array.isArray(myChef?.chefCategories)

    ? myChef.chefCategories.map(c => normalizeText(c))

    : [];

  const myStations = [...new Set([...myStationsSingle, ...myStationsArray])];

  const hasRestriction = myStations.length > 0 && !myStations.includes("general");



  if (hasRestriction) {

    const orderItems = Object.values(order.items || {});

    const hasMatch = orderItems.some(item => {

      const menu = getOrderItemMenu(item);

      if (!menu) return false; // menusi yo'q item — o'tkazib yuborish

      const itemStation = normalizeText(menu.kitchenStation || "");

      if (itemStation) return myStations.includes(itemStation);

      // kitchenStation belgilanmagan bo'lsa — eski category/subcategory qiymati bilan solishtiramiz

      return myStations.some(st => String(menu.category || "") === st || String(menu.subcategory || "") === st);

    });

    if (!hasMatch) return false;

  }



  if (selectedCategory === "all" && selectedSub === "all") return true;

  const items = Object.values(order.items || {});

  return items.some(item => {

    const menu = getOrderItemMenu(item);

    if (!menu) return true;

    if (selectedCategory !== "all" && menu.category !== selectedCategory) return false;

    if (selectedSub !== "all" && menu.subcategory !== selectedSub) return false;

    return true;

  });

}



function filterChefOrdersByStatus(order) {

  const filterEl = document.getElementById("chefStatusFilter");

  const value = filterEl?.value || localStorage.getItem("chefStatusFilter") || window.chefSettings?.defaultFilter || "all";

  const status = getOrderStatus(order);

  const remaining = getRemainingInfo(order);

  if (value === "all") return true;

  if (value === "mine") return String(order?.chefId || "") === String(currentChefId);

  if (value === "delayed") return remaining.delayed;

  const normalizedStatus = normalizeKitchenStatus(status);

  const map = { new: ["new"], accepted: ["approved"], cooking: ["cooking"], ready: ["ready"] };

  return (map[value] || []).includes(normalizedStatus);

}



function filterChefOrdersByCategory(order) {

  const selectedCategory = getSelectedCategory();

  if (selectedCategory === "all") return true;

  return Object.values(order?.items || {}).some(item => {

    const menu = getOrderItemMenu(item) || {};

    return String(menu?.category || "") === String(selectedCategory);

  });

}



function filterChefOrdersByTable(order) {

  const value = normalizeText(document.getElementById("chefTableFilter")?.value || "");

  if (!value) return true;

  return normalizeText(order?.table) === value;

}



function filterChefOrdersByAssignedChef(order) {

  const selectedChef = getSelectedChef();

  if (selectedChef === "all") return true;

  return String(order?.chefId || "") === String(selectedChef);

}



function filterChefOrdersByDelay(order) {

  const value = document.getElementById("chefStatusFilter")?.value || "all";

  if (value !== "delayed") return true;

  return getRemainingInfo(order).delayed;

}



function searchChefOrders(orderId, order) {

  const query = normalizeText(document.getElementById("chefSearchInput")?.value || "");

  if (!query) return true;

  const textParts = [

    orderId, order?.table, order?.clientRequest, order?.lastClientMessage, order?.lastChefMessage,

    getAssignedChefName(orderId, order)

  ];

  Object.values(order?.items || {}).forEach(item => {

    const menu = getOrderItemMenu(item) || {};

    textParts.push(

      item?.name, getTranslatedItemName(item, menu, currentLang),

      menu?.name?.uz, menu?.name?.ru, menu?.name?.en,

      menu?.category, menu?.subcategory, item?.kitchenNote

    );

  });

  const haystack = normalizeText(textParts.filter(Boolean).join(" "));

  return haystack.includes(query);

}



function filterMyAssignedOrders(order) {

  const value = document.getElementById("chefStatusFilter")?.value || "all";

  if (value !== "mine") return true;

  return String(order?.chefId || "") === String(currentChefId);

}



// ⚠️ MAJBURIY: bu tekshiruv "Mening" filtri tanlanган-tanlanmaganidan qat'iy

// nazar ishlaydi — boshqa oshpazga allaqachon biriktirilgan buyurtma hech

// qachon ko'rinmaydi. Hali hech kimga biriktirilmagan (chefId bo'sh) yangi

// buyurtmalar esa barcha oshpazlarga ko'rinishda qoladi — aks holda ularni

// hech kim qabul qila olmay qolardi.

function isOrderHiddenFromOtherChef(order) {

  const assignedTo = String(order?.chefId || "").trim();

  if (!assignedTo) return false; // hali hech kimga biriktirilmagan — ko'rinadi

  return assignedTo !== String(currentChefId);

}



function applyChefOrderFilters(orderId, order) {

  // 🖥️ Monitor rejimi — umumiy oshxona ekrani, barcha oshpazlarning barcha

  // buyurtmalarini ko'rsatadi (kim tayinlanganini ham). Bu — shaxsiy oshpaz

  // oynasidagi majburiy izolyatsiya qoidasining yagona istisnosi.

  // ⚠️ Faqat izolyatsiya tekshiruvini o'chirish yetarli emas: getSelectedChef()

  // va "mine" filtri localStorage'dagi eski qiymatga tayanadi — bu qiymat

  // shaxsiy oshpaz oynasidan qolib ketgan bo'lishi mumkin, hatto Monitor

  // sahifasida hech qanday dropdown bo'lmasa ham. Shu sabab ikkalasi ham

  // Monitor rejimida o'tkazib yuboriladi.

  const isMonitor = !!(window.isChefMonitorMode && window.isChefMonitorMode());

  if (!isMonitor && isOrderHiddenFromOtherChef(order)) return false;

  const status = getOrderStatus(order);

  const normalizedStatus = normalizeKitchenStatus(status);

  const allowed = ["new", "approved", "cooking", "ready"];

  if (!allowed.includes(normalizedStatus)) return false;

  if (!filterChefOrdersByStatus(order)) return false;

  if (!filterChefOrdersByCategory(order)) return false;

  if (!isMonitor && !filterChefOrdersByAssignedChef(order)) return false;

  if (!filterChefOrdersByTable(order)) return false;

  if (!filterChefOrdersByDelay(order)) return false;

  if (!isMonitor && !filterMyAssignedOrders(order)) return false;

  if (!searchChefOrders(orderId, order)) return false;

  return true;

}



function getOrderPriorityLabel(order) {

  const remaining = getRemainingInfo(order);

  if (remaining.delayed) return "critical";

  if (remaining.urgent) return "high";

  if (isFastOrder(order)) return "fast";

  if (String(order?.deliveryType || order?.orderType || "").toLowerCase().includes("delivery")) return "delivery";

  if (order?.reservationId || order?.isReservation === true) return "reservation";

  if (String(order?.customerType || order?.loyalty || "").toLowerCase().includes("vip")) return "vip";

  return "normal";

}



function sortChefOrdersByPriority(entries = []) {

  // Yangi buyurtmalar (new/yangi) har doim eng tepada turadi

  const NEW_STATUSES = ["new", "yangi", "pending", "queue", ""];

  const statusRank = { new: 0, yangi: 0, pending: 0, queue: 0, approved: 1, tasdiqlandi: 1, cooking: 2, tayyorlanmoqda: 2, ready: 3, tayyor: 3 };

  const priorityRank = { critical: 0, high: 1, fast: 2, delivery: 3, reservation: 4, vip: 5, normal: 6 };

  return [...entries].sort((a, b) => {

    const [idA, orderA] = a;

    const [idB, orderB] = b;

    const stA = normalizeKitchenStatus(orderA?.status || orderA?.statusKey || "");

    const stB = normalizeKitchenStatus(orderB?.status || orderB?.statusKey || "");

    // Yangi buyurtmalar har doim birinchi

    const aIsNew = NEW_STATUSES.includes(String(orderA?.status || orderA?.statusKey || "").toLowerCase());

    const bIsNew = NEW_STATUSES.includes(String(orderB?.status || orderB?.statusKey || "").toLowerCase());

    if (aIsNew && !bIsNew) return -1;

    if (!aIsNew && bIsNew) return 1;

    // So'ng priority bo'yicha

    const pA = priorityRank[getOrderPriorityLabel(orderA)] ?? 999;

    const pB = priorityRank[getOrderPriorityLabel(orderB)] ?? 999;

    if (pA !== pB) return pA - pB;

    const sA = statusRank[stA] ?? 999;

    const sB = statusRank[stB] ?? 999;

    if (sA !== sB) return sA - sB;

    // Oxirida: yangi kelgan birinchi (createdAt kamayuvchi — eng yangi tepada)

    const tA = Number(orderA?.createdAt || 0);

    const tB = Number(orderB?.createdAt || 0);

    return tB - tA;

  });

}



function getChefVisibleOrders() {

  const orders = window.allOrders || allOrders || {};

  const entries = Object.entries(orders).filter(([orderId, order]) => applyChefOrderFilters(orderId, order));

  return sortChefOrdersByPriority(entries);

}



/* =========================

   RENDER ORDERS (ENHANCED)

========================= */

function getOrderCookStartTime(order) {

  return Number(order?.startedAt || order?.takenAt || order?.assignedAt || order?.createdAt || 0);

}



function getOrderWaitDuration(order) {

  const start = getOrderCookStartTime(order);

  if (!start) return 0;

  const end = Number(order?.finishedAt || Date.now());

  return Math.max(0, end - start);

}



function getPriorityBadgeHtml(order) {

  const p = getOrderPriorityLabel(order);

  const map = {

    critical: `<span class="priority-badge critical">🚨 ${t("priority_critical", "Kritik")}</span>`,

    high: `<span class="priority-badge high">⏰ ${t("priority_high", "Yuqori")}</span>`,

    fast: `<span class="priority-badge fast">⚡ ${t("priority_fast", "Tezkor")}</span>`,

    delivery: `<span class="priority-badge delivery">🛵 ${t("priority_delivery", "Yetkazish")}</span>`,

    reservation: `<span class="priority-badge reservation">📅 ${t("priority_reservation", "Band qilingan")}</span>`,

    vip: `<span class="priority-badge vip">👑 ${t("priority_vip", "VIP")}</span>`,

    normal: `<span class="priority-badge normal">🟢 ${t("priority_normal", "Oddiy")}</span>`

  };

  return map[p] || map.normal;

}



function getItemKitchenState(item = {}) {

  return normalizeText(item?.kitchenStatus || item?.status || "");

}



function getItemKitchenBadge(item = {}) {

  const state = getItemKitchenState(item);

  if (state === "prepared") return `<span class="item-kitchen-badge prepared">✅ ${t("item_badge_prepared", "Tayyorlandi")}</span>`;

  if (state === "delayed") return `<span class="item-kitchen-badge delayed">⏰ ${t("item_badge_delayed", "Kechikdi")}</span>`;

  if (state === "rejected") return `<span class="item-kitchen-badge rejected">❌ ${t("item_badge_rejected", "Rad etildi")}</span>`;

  return `<span class="item-kitchen-badge pending">🕓 ${t("item_badge_pending", "Kutmoqda")}</span>`;

}



function renderOrderItemsDetailed(orderId, order) {

  const items = Object.entries(order?.items || {});

  if (!items.length) return `<div class="detail-empty">${t("no_items", "Item yo'q")}</div>`;

  return items.map(([itemKey, item]) => {

    const menu = getOrderItemMenu(item) || {};

    const name = getTranslatedItemName(item, menu, currentLang);

    const qty = Number(item?.qty || 1);

    const note = item?.kitchenNote ? `<div class="item-kitchen-note">📝 ${escapeHtml(item.kitchenNote)}</div>` : "";

    const prepTime = Number(item?.prepTime || menu?.prepTime || 15);

    return `

      <div class="chef-item-row">

        <div class="chef-item-main">

          <div class="chef-item-title">

            <b>${escapeHtml(name)}</b>

            <span>x${qty}</span>

            ${getItemKitchenBadge(item)}

          </div>

          <div class="chef-item-meta">

            ${(() => {
        const catId = menu?.category || item?.category || "";
        const subId = menu?.subcategory || item?.subcategory || "";
        const catText = getCategoryLabel(catId);
        const subText = subId ? getSubcategoryLabel(subId) : "";
        const catSub = `${catText}${subText ? ` • ${subText}` : ""}`.trim();
        const stationFallback = getKitchenStationLabel(menu?.kitchenStation || item?.kitchenStation || "");
        return escapeHtml(catSub || stationFallback || t("food_label", "Taom"));
      })()}

            • ${prepTime} ${t("minute_short", "daq")}

          </div>

          ${note}

        </div>

        <div class="chef-item-actions">

          <button type="button" onclick="toggleItemPrepared('${escapeJsString(orderId)}','${escapeJsString(itemKey)}')">✅</button>

          <button type="button" onclick="markDelayedItem('${escapeJsString(orderId)}','${escapeJsString(itemKey)}')">⏰</button>

          <button type="button" onclick="addKitchenNote('${escapeJsString(orderId)}','${escapeJsString(itemKey)}')">📝</button>

          <button type="button" onclick="rejectOrderItem('${escapeJsString(orderId)}','${escapeJsString(itemKey)}')">❌</button>

          <button type="button" onclick="toggleItemAvailability('${escapeJsString(menu?.id || item?.menuId || itemKey)}', false)">⛔</button>

        </div>

      </div>

    `;

  }).join("");

}



function renderChefOrderCard(orderId, order, queueNumber) {

  const status = normalizeText(order.status || order.statusKey || "");

  const orderTime = formatDateTime(order.createdAt);

  const totalItems = Object.values(order.items || {}).reduce((acc, item) => acc + (Number(item.qty) || 1), 0);

  const isFast = !!order.isFastOrder;

  const isCooking = ["cooking", "tayyorlanmoqda"].includes(status);



  // Stol nomi oldidagi rangli katakcha va monitor-status nuqtasi: Navbatda=kulrang,

  // Pishirilmoqda=ko'k, Tayyor=yashil, Kechikkan yoki juda shoshilinch=qizil.

  // Ikkalasi ham (jadval kvadratchasi va monitor rejimi belgisi) shu bitta

  // hisob-kitobdan foydalanadi, shunday qilib ular hech qachon bir-biriga

  // mos kelmay qolmaydi.

  const isReadyStatus = ["ready", "tayyor"].includes(status);

  const isOverdueNow = isCooking && Number(order.readyAt || 0) > 0 && Date.now() > Number(order.readyAt);

  let tableSquareColor = "#94a3b8"; // kulrang — navbatda

  if (isOverdueNow || isFast) tableSquareColor = "#ef4444"; // qizil

  else if (isReadyStatus) tableSquareColor = "#22c55e"; // yashil

  else if (isCooking) tableSquareColor = "#3b82f6"; // ko'k



  const timerHtml = isCooking ? `

    <div class="order-timer" data-start="${order.acceptedAt || order.createdAt}" data-limit="${order.prepTimeLimit || 15}">

      <i class="fa-regular fa-clock"></i> <span class="timer-val">00:00</span>

    </div>` : "";



  let actionHtml = "";

  if (window.isChefMonitorMode && window.isChefMonitorMode()) {

    // 🖥️ Monitor rejimi: faqat status ko'rsatiladi, hech qanday tugma/input yo'q

    const MONITOR_STATUS_MAP = {

      new: `⏳ ${t("monitor_status_queued", "Navbatda")}`,

      yangi: `⏳ ${t("monitor_status_queued", "Navbatda")}`,

      queue: `⏳ ${t("monitor_status_queued", "Navbatda")}`,

      approved: `📋 ${t("monitor_status_accepted", "Qabul qilindi")}`,

      tasdiqlandi: `📋 ${t("monitor_status_accepted", "Qabul qilindi")}`,

      cooking: `🔥 ${t("monitor_status_cooking", "Tayyorlanmoqda")}`,

      tayyorlanmoqda: `🔥 ${t("monitor_status_cooking", "Tayyorlanmoqda")}`,

      ready: `✅ ${t("monitor_status_ready", "Tayyor")}`,

      tayyor: `✅ ${t("monitor_status_ready", "Tayyor")}`,

    };

    const monitorLabel = MONITOR_STATUS_MAP[status] || `• ${t("monitor_status_unknown", "Kutilmoqda")}`;

    const hasAnyRecipe = Object.values(order.items || {}).some(it => !!(it.menuId || it.id || it.itemId));

    const assignedChefName = getAssignedChefName(orderId, order);

    actionHtml = `

      ${assignedChefName !== "—" ? `

      <div style="text-align:center;font-size:13px;font-weight:700;color:#e2e8f0;margin-bottom:6px;">

        ${isFast ? "⚡ " : ""}👨‍🍳 ${escapeHtml(assignedChefName)}

      </div>` : ""}

      <div class="monitor-status-readonly" style="margin-top:10px;text-align:center;font-size:14px;font-weight:800;

        padding:9px 10px;background:rgba(255,255,255,0.08);border-radius:10px;color:#e2e8f0;letter-spacing:0.3px;">

        <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${tableSquareColor};margin-right:6px;vertical-align:middle;"></span>${monitorLabel}

      </div>

      <div style="display:flex;gap:8px;margin-top:8px;">

        ${hasAnyRecipe ? `

        <div style="flex:1;text-align:center;font-size:12.5px;font-weight:700;color:#94a3b8;

          padding:7px 8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.10);border-radius:9px;">

          📖 ${t("view_recipe_btn", "Retsept")}

        </div>` : ""}

        ${isReadyStatus ? `

        <div style="flex:1;text-align:center;font-size:12.5px;font-weight:700;color:#22c55e;

          padding:7px 8px;background:rgba(34,197,94,0.10);border:1px solid rgba(34,197,94,0.25);border-radius:9px;">

          ✅ ${t("monitor_status_ready", "Tayyor")}

        </div>` : ""}

      </div>`;

  } else if (status === "approved" || status === "tasdiqlandi" || status === "new") {

    actionHtml = `

      <div style="margin-top:10px;">

        <div style="font-size:11px;color:#94a3b8;margin-bottom:5px;font-weight:600;">

          ⏱ ${t("enter_ready_minutes", "Tayyor bo'lish vaqti (daqiqa)")}

        </div>

        <div style="display:flex;gap:5px;margin-bottom:7px;flex-wrap:wrap;">

          ${[5, 10, 15, 20, 30].map(m =>

      `<button onclick="document.getElementById('time-input-${escapeHtml(orderId)}').value=${m}"

              style="padding:4px 10px;background:rgba(251,191,36,0.15);border:1.5px solid rgba(217,119,6,0.35);

              color:#92400e;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;">${m}</button>`

    ).join("")}

        </div>

        <div style="display:flex;gap:7px;align-items:center;">

          <input id="time-input-${escapeHtml(orderId)}" type="number" min="1" max="120"

            placeholder="${t("minute_short", "Daqiqa...")}"

            style="flex:1;padding:8px 10px;border-radius:9px;border:1.5px solid rgba(217,119,6,0.45);

            background:rgba(251,191,36,0.10);color:#1e293b;font-size:14px;font-weight:700;outline:none;"

            onkeydown="if(event.key==='Enter') window.startCooking('${escapeHtml(orderId)}')">

          <button onclick="window.startCooking('${escapeHtml(orderId)}')" 

            style="padding:9px 14px;background:linear-gradient(135deg,#16a34a,#22c55e);

            color:#fff;border:none;border-radius:10px;font-weight:800;font-size:13px;

            cursor:pointer;display:flex;align-items:center;gap:6px;white-space:nowrap;

            box-shadow:0 3px 10px rgba(22,163,74,0.4);">

            <i class="fa-solid fa-play"></i> ${t("start_cooking_btn", "BOSHLASH")}

          </button>

        </div>

      </div>`;

  } else if (isCooking) {

    // Countdown hisoblash

    const readyAt = Number(order.readyAt || 0);

    const now0 = Date.now();

    const diffMs0 = readyAt - now0;

    const diffMins0 = Math.floor(diffMs0 / 60000);

    const diffSecs0 = Math.floor((diffMs0 % 60000) / 1000);

    const timerColor0 = diffMs0 <= 60000 ? "#ef4444" : diffMs0 <= 3 * 60000 ? "#f97316" : "#f59e0b";

    const timerTxt0 = readyAt

      ? (diffMs0 <= 0

        ? `⚠️ ${t("overdue_label", "Kechikdi")} ${Math.abs(diffMins0)} ${t("minute_short", "daq")}`

        : `⏱ ${diffMins0}:${String(diffSecs0).padStart(2, "0")} ${t("left_short", "qoldi")}`)

      : `🔥 ${t("cooking_label", "Tayyorlanmoqda...")}`;



    actionHtml = `

      <div style="margin-top:10px;">

        <!-- Countdown -->

        <div class="chef-card-countdown" data-ready-at="${readyAt || ""}" data-order-id="${escapeHtml(orderId)}"

          style="text-align:center;font-size:14px;font-weight:800;color:${timerColor0};padding:7px 10px;

          background:rgba(0,0,0,0.12);border-radius:10px;margin-bottom:8px;letter-spacing:0.5px;">

          ${timerTxt0}

        </div>

        <!-- Vaqt o'zgartirish: input + Yangilash -->

        <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;">

          ${[5, 10, 15, 20, 30].map(m => `<button

            onclick="document.getElementById('new-time-${escapeHtml(orderId)}').value=${m}"

            style="padding:4px 9px;background:rgba(251,191,36,0.15);border:1.5px solid rgba(217,119,6,0.35);

            color:#92400e;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;">${m}</button>`).join("")}

          <input id="new-time-${escapeHtml(orderId)}" type="number" min="1" max="120"

            placeholder="${t("minute_short", "Daq")}" value="${order.prepMinutes || ""}"

            style="width:60px;padding:5px 8px;border-radius:8px;border:1.5px solid rgba(217,119,6,0.40);

            background:rgba(251,191,36,0.10);color:#1e293b;font-size:13px;font-weight:700;outline:none;"

            onkeydown="if(event.key==='Enter') window.updateCookingTimer('${escapeHtml(orderId)}')">

          <button onclick="window.updateCookingTimer('${escapeHtml(orderId)}')" title="${t("update_timer", "Vaqtni yangilash")}"

            style="padding:5px 10px;background:rgba(251,191,36,0.20);border:1.5px solid rgba(217,119,6,0.40);

            color:#92400e;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">

            🔄 ${t("update_timer", "Yangilash")}

          </button>

        </div>

        <!-- Tayyor tugmasi -->

        <button class="btn-action btn-ready" onclick="markOrderReady('${orderId}')" style="width:100%;">

          <i class="fa-solid fa-check-double"></i> ${t("ready_order", "TAYYOR ✅")}

        </button>

      </div>`;

  }



  // Ofitsiant tomonidan tanlangan teglar (waiter.js: NOTE_TAGS/parseNoteTags

  // bilan bir xil vokabulyar va formatda — item.note ichida vergul bilan

  // ajratilgan holda, o'zbekcha yorliq matni sifatida saqlanadi).

  // ⚠️ waiter.js'dagi note_tag_* kalitlarining rus/ingliz tarjimalari bu

  // faylda tekshirilmagani uchun, faqat o'zbekcha matn bilan solishtiramiz;

  // mos kelmagan matn 📝 umumiy belgi bilan ko'rsatiladi (noto'g'ri

  // taglashdan ko'ra shunday xolisroq).

  const ITEM_NOTE_TAGS = [

    { label: "Tuzsiz", icon: "🧂" },

    { label: "Kam tuzli", icon: "🧂" },

    { label: "Achchiqsiz", icon: "🌶️" },

    { label: "Achchiq", icon: "🌶️" },

    { label: "Piyozsiz", icon: "🧅" },

    { label: "Ko'katsiz", icon: "🌿" },

    { label: "Yog'siz", icon: "🫗" },

    { label: "Vegetarian", icon: "🥗" },

  ];

  function renderItemNoteTags(note) {

    const parts = String(note || "").split(",").map(s => s.trim()).filter(Boolean);

    if (parts.length === 0) return "";

    const badges = parts.map(p => {

      const match = ITEM_NOTE_TAGS.find(tg => tg.label === p);

      const icon = match ? match.icon : "📝";

      return `<span class="item-note-badge" style="display:inline-flex;align-items:center;gap:5px;

        font-size:13px;font-weight:700;color:#e2e8f0;

        background:rgba(255,255,255,0.10);border:1.5px solid rgba(255,255,255,0.18);

        border-radius:10px;padding:6px 12px;white-space:nowrap;">${icon} ${escapeHtml(p)}</span>`;

    }).join("");

    return `<div class="item-note-badges" style="display:flex;flex-wrap:wrap;gap:6px;">${badges}</div>`;

  }



  const itemsHtml = Object.values(order.items || {}).map((item, idx, arr) => {

    const menu = getOrderItemMenu(item) || {};

    const name = getTranslatedItemName(item, menu, currentLang);

    const noteTagsHtml = renderItemNoteTags(item.note);

    const isLast = idx === arr.length - 1;

    return `

      <div class="order-item-row">

        <span class="item-name">${escapeHtml(name)}</span>

        <span class="item-qty">x${item.qty}</span>

      </div>

      ${noteTagsHtml ? `<div style="margin:2px 0 6px;">${noteTagsHtml}</div>` : ""}

      ${!isLast ? `<div class="item-separator" style="border-top:1px solid rgba(255,255,255,0.08);margin:8px 0;"></div>` : ""}`;

  }).join("");



  return `

    <div class="order-card ${isFast ? 'fast-order' : ''} ${isCooking ? 'status-cooking' : ''}">

      <div class="card-glow"></div>

      <div class="order-card-header">

        <div class="order-info">

          <span class="order-number">#${queueNumber}</span>

          <span class="order-table">

            ${normalizeOrderType(order) === ORDER_TYPE.DELIVERY
      ? `<span style="display:inline-flex;align-items:center;gap:4px;font-weight:700;color:#fff;background:#dc2626;border-radius:6px;padding:1px 7px;font-size:11px;">🚚 ${t("delivery_badge", "YETKAZISH")}</span>${order.courierId ? ` <span title="${escapeHtml(order.courierName || '')}">🛵</span>` : ""} <span style="font-size:11px;color:#94a3b8;">${escapeHtml((formatDeliveryAddress(order.deliveryAddress) || "").slice(0, 28))}</span>`
      : normalizeOrderType(order) === ORDER_TYPE.TAKEAWAY
        ? `<span style="display:inline-flex;align-items:center;gap:4px;font-weight:700;color:#fff;background:#d97706;border-radius:6px;padding:1px 7px;font-size:11px;">🥡 ${t("takeaway_badge", "OLIB KETISH")}</span>`
        : `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${tableSquareColor};margin-right:5px;vertical-align:middle;"></span>${t("table_short", "Stol")}: ${escapeHtml(String(order.table || order.tableNumber || "-"))}`
    }

          </span>

        </div>

        <div class="order-meta">

          <span class="order-time">${orderTime}</span>

        </div>

      </div>

      

      <div class="order-card-body">

        ${itemsHtml}

        ${order.allergyNote ? `

        <div class="order-allergy-note">

          <span class="allergy-icon">⚠️</span>

          <span class="allergy-text">${escapeHtml(translateAllergyNote(order.allergyNote))}</span>

        </div>` : ""}

      </div>

      

      <div class="order-card-footer">

        <div class="footer-stats">

          <span class="items-total"><i class="fa-solid fa-utensils"></i> ${totalItems}</span>

          ${order.waiterName ? `<span class="order-waiter" style="font-size:12px;color:#94a3b8;"><i class="fa-solid fa-user"></i> ${escapeHtml(order.waiterName)}</span>` : ""}

          ${timerHtml}

          ${(window.isChefMonitorMode && window.isChefMonitorMode()) ? "" : `

          <button

            onclick="window.manualPrintOrder('${escapeJsString(orderId)}')"

            title="${t('print_ticket', 'Chiptani chop etish')}"

            style="

              display:inline-flex;align-items:center;gap:4px;

              padding:4px 10px;height:28px;

              background:rgba(255,255,255,0.06);

              border:1px solid rgba(255,255,255,0.12);

              border-radius:7px;

              color:#94a3b8;font-size:12px;font-weight:700;

              cursor:pointer;transition:background 0.15s;

              font-family:'Plus Jakarta Sans',sans-serif;

            "

            onmouseover="this.style.background='rgba(255,255,255,0.12)';this.style.color='#e2e8f0'"

            onmouseout="this.style.background='rgba(255,255,255,0.06)';this.style.color='#94a3b8'"

          >

            🖨️ ${t('print_btn', 'Print')}

          </button>`}

        </div>

        <div class="order-actions">

          ${actionHtml}

        </div>

      </div>

    </div>

  `;

}



window.updateStatus = async function (orderId, nextStatus) {

  const rId = localStorage.getItem("restaurantId");

  if (!rId) return;



  const orderRef = ref(db, `restaurants/${rId}/orders/${orderId}`);

  let updates = { status: nextStatus };



  if (nextStatus === 'cooking') {

    const timeInput = document.getElementById(`time-input-${orderId}`);

    const minutes = timeInput.value;

    if (!minutes) {

      alert(t("enter_prep_time", "Tayyor bo'lish vaqtini kiriting!"));

      return;

    }

    updates.prepTime = minutes;

    updates.cookingStartedAt = Date.now();

  }



  if (nextStatus === 'ready') {

    updates.finishedAt = Date.now();

  }



  try {

    await update(orderRef, updates);

  } catch (e) {

    console.error(t("error_label", "Xato:"), e);

  }

};



/**

 * @param {string} orderId 

 */

window.finishOrder = async function (orderId) {

  const isConfirmed = confirm(t("confirm_payment_text", "Mijoz to'lov qildimi? Buyurtma yakunlanadi va stol bo'shatiladi."));



  if (!isConfirmed) return;



  try {

    const restaurantId = localStorage.getItem("restaurantId");

    const orderRef = ref(db, `restaurants/${restaurantId}/orders/${orderId}`);



    await update(orderRef, {

      status: 'completed',

      paymentStatus: 'paid',

      completedAt: Date.now()

    });



    const orderData = window.allOrders[orderId];

    const tableRefId = orderData?.tableId || orderData?.table;

    if (tableRefId) {

      const tableRef = ref(db, `restaurants/${restaurantId}/tables/${getTableKey(tableRefId)}`);

      await update(tableRef, { status: 'free', busy: false, orderId: null });

    }



    if (typeof showToast === "function") {

      showToast(t("order_completed", "Buyurtma muvaffaqiyatli yakunlandi!"), "success");

    }



  } catch (error) {

    console.error(t("payment_confirm_error_log", "To'lovni tasdiqlashda xatolik:"), error);

    alert(t("error_generic", "Xatolik yuz berdi. Iltimos qaytadan urinib ko'ring."));

  }

};



window.setOrderCookingTime = window.processChefAction;



// ============================================

// ⏱ OSHPAZ: VAQT KIRITIB TAYYOR DEYISH

// ============================================

window.markOrderReady = async function (orderId) {

  if (window.isChefMonitorMode && window.isChefMonitorMode()) return; // 🖥️ Monitor rejimi: faqat ko'rish

  // Eski modal bo'lsa o'chiramiz

  const existingModal = document.getElementById("chefReadyTimeModal");

  if (existingModal) existingModal.remove();



  // Modal yaratamiz

  const modal = document.createElement("div");

  modal.id = "chefReadyTimeModal";

  modal.style.cssText = `

    position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:99999;

    display:flex; align-items:center; justify-content:center; padding:20px;

  `;

  modal.innerHTML = `

    <div style="background:#fff; border-radius:16px; padding:28px 24px; width:100%; max-width:360px;

                box-shadow:0 8px 32px rgba(0,0,0,0.18); text-align:center;">

      <div style="font-size:32px; margin-bottom:8px;">⏱</div>

      <h3 style="margin:0 0 6px; font-size:17px; color:#1e293b;">${t("ready_time_title", "Tayyorlanish vaqti")}</h3>

      <p style="margin:0 0 18px; font-size:13px; color:#64748b;">${t("ready_time_desc", "Ovqat necha daqiqada tayyor bo'ladi?")}</p>

      <div style="display:flex; align-items:center; justify-content:center; gap:10px; margin-bottom:20px;">

        <button onclick="

          var i=document.getElementById('chefReadyMinInput');

          var v=Math.max(1,parseInt(i.value||5)-1); i.value=v;

        " style="width:40px;height:40px;border-radius:50%;border:1.5px solid #e2e8f0;background:#f8fafc;font-size:20px;cursor:pointer;font-weight:700;color:#475569;">−</button>

        <input id="chefReadyMinInput" type="number" value="15" min="1" max="120"

          style="width:80px;height:48px;text-align:center;font-size:22px;font-weight:800;

                 border:2px solid #3b82f6;border-radius:12px;color:#1e293b;outline:none;" />

        <button onclick="

          var i=document.getElementById('chefReadyMinInput');

          var v=Math.min(120,parseInt(i.value||5)+1); i.value=v;

        " style="width:40px;height:40px;border-radius:50%;border:1.5px solid #e2e8f0;background:#f8fafc;font-size:20px;cursor:pointer;font-weight:700;color:#475569;">+</button>

        <span style="font-size:14px;color:#64748b;font-weight:600;">${t("minute_short", "daq")}</span>

      </div>

      <div style="display:flex;gap:10px;">

        <button onclick="document.getElementById('chefReadyTimeModal').remove()"

          style="flex:1;padding:12px;border-radius:10px;border:1.5px solid #e2e8f0;background:#f8fafc;

                 color:#64748b;font-weight:700;font-size:14px;cursor:pointer;">

          ${t("cancel_btn", "Bekor")}

        </button>

        <button id="chefReadyConfirmBtn"

          style="flex:2;padding:12px;border-radius:10px;border:none;background:linear-gradient(135deg,#16a34a,#22c55e);

                 color:#fff;font-weight:800;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">

          ✅ ${t("confirm_ready", "Tasdiqlash")}

        </button>

      </div>

    </div>

  `;



  document.body.appendChild(modal);



  // Confirm tugmasi

  document.getElementById("chefReadyConfirmBtn").onclick = async () => {

    const minutes = parseInt(document.getElementById("chefReadyMinInput")?.value || 15);

    if (isNaN(minutes) || minutes < 1) {

      alert(t("enter_valid_time", "To'g'ri vaqt kiriting!"));

      return;

    }



    modal.remove();



    const now = Date.now();

    const expectedReadyAt = now + minutes * 60 * 1000;



    // Buyurtmani oldingi statusini tekshiramiz (audit uchun)

    const prevSnap = await get(ref(db, `${BASE_PATH}/orders/${orderId}`));

    const prevStatus = prevSnap.exists() ? (prevSnap.val()?.statusV2 || prevSnap.val()?.status || ORDER_STATUS_V2.PREPARING.key) : ORDER_STATUS_V2.PREPARING.key;



    await updateOrderKitchenStatus(

      orderId,

      "ready",

      {

        statusKey: ORDER_STATUS_V2.READY.key,

        statusLabel: ORDER_STATUS_V2.READY.labelUz,

        statusV2: ORDER_STATUS_V2.READY.key,

        [`statusHistory/${ORDER_STATUS_V2.READY.key}`]: now,

        readyAt: expectedReadyAt,

        expectedReadyAt,

        prepMinutes: minutes,

        isNotified: false,

        notified: false

      }

    );



    // 🆕 Audit Log

    const chefId = sessionStorage.getItem("userId") || "chef";

    const chefName = localStorage.getItem("userName") || t("chef_label", "Oshpaz");

    const restId = localStorage.getItem("restaurantId");

    if (restId) {

      await writeOrderAuditLog(db, `restaurants/${restId}`, {

        actorId: chefId,

        actorName: chefName,

        actorRole: "chef",

        action: "order_ready",

        fromStatus: prevStatus,

        toStatus: ORDER_STATUS_V2.READY.key,

        orderId,

        description: `✅ Oshpaz tayyor deb belgiladi (${minutes} daq)`

      });

    }



    if (typeof window.deductOrderInventory === "function") {

      await window.deductOrderInventory(orderId);

    }



    // 🏅 Oshpaz uchun buyurtma balli — staff_stats/{chefId}/{monthKey}

    try {

      const _restId = localStorage.getItem("restaurantId");

      const _chefId = sessionStorage.getItem("userId");

      if (_restId && _chefId) {

        // Bu order uchun allaqachon ball berilanmi? Was a check-then-act
        // race: get() the flag, then two separate update()s — two
        // near-simultaneous "ready" triggers (double click, or chef +
        // admin both finishing the same order) could both pass the check
        // before either write landed, double-incrementing orderCount.
        // Fixed by claiming the flag itself atomically via runTransaction
        // first; only the caller that wins the claim proceeds to award.
        const _flagRef = ref(db, `restaurants/${_restId}/orders/${orderId}/chefScoreAwarded`);
        const _claim = await runTransaction(_flagRef, (cur) => {
          if (cur) return; // abort — already awarded, someone else won the race
          return true;
        });

        if (_claim.committed) {

          const _monthKey = new Date().toISOString().slice(0, 7);

          const _statsRef = ref(db, `restaurants/${_restId}/finance/staff_stats/${_chefId}/${_monthKey}`);

          await runTransaction(_statsRef, (cur) => {
            cur = cur || { orderCount: 0, totalEarned: 0 };
            return {
              orderCount: (cur.orderCount || 0) + 1,
              totalEarned: cur.totalEarned || 0,
              lastUpdate: Date.now()
            };
          });

          await update(ref(db, `restaurants/${_restId}/orders/${orderId}`), {

            chefScoreAwardedTo: _chefId,

            chefScoreAwardedAt: Date.now()

          });

        }

      }

    } catch (_scoreErr) {

      console.warn("Chef score yozishda xato:", _scoreErr);

    }



    if (typeof showToast === "function") {

      showToast(`✅ ${t("order_ready", "Taom tayyor!")} ⏱ ${minutes} ${t("minute_short", "daq")}`, "success");

    }

  };



  // Modal tashqarisiga bosish — yopish

  modal.addEventListener("click", (e) => {

    if (e.target === modal) modal.remove();

  });

};



/* =========================

   ORDER STATUS ACTIONS

========================= */

async function createKitchenTimelineEvent(orderId, eventType, payload = {}) {

  if (!orderId || !eventType) return null;



  const actorName = window.allChefs?.[currentChefId]?.name || sessionStorage.getItem("name") || t("chef_label", "Chef");

  const actorRole = "chef";



  const eventRef = push(ref(db, `${BASE_PATH}/orderTimeline/${orderId}`));



  await set(eventRef, {

    orderId,

    eventType,

    payload,

    actorId: currentChefId,

    actorName,

    actorRole,

    createdAt: Date.now()

  });



  await update(ref(db, `${BASE_PATH}/orders/${orderId}`), {

    lastTimelineEventAt: Date.now(),

    lastTimelineEventType: eventType

  });



  return eventRef.key;

}



async function kitchenAudit(action, payload = {}, severity = "info") {

  const actorName = window.allChefs?.[currentChefId]?.name || sessionStorage.getItem("name") || t("chef_label", "Chef");

  await push(ref(db, BASE_PATH + "/activityLogs"), {

    userId: currentChefId, userName: actorName, userRole: "chef", module: "kitchen",

    action, target: String(payload.orderId || payload.productId || payload.itemId || ""),

    severity, description: action, payload, createdAt: Date.now()

  });

}



// ==========================================

// 🧑‍🍳 OFITSIANT BIRIKTIRISH: "Tayyor" bosilganda qaysi

// ofitsiantga yuborilishini restoran sozlamalariga

// (waiterAssignMode: manual | auto | mixed) qarab hal qiladi.

// ==========================================

async function _resolveReadyWaiter(order) {

  try {

    const settSnap = await get(ref(db, `${BASE_PATH}/settings/waiterAssignMode`));

    const mode = settSnap.exists() ? settSnap.val() : "manual";



    // Qo'lda rejimda avtomatik hech kim biriktirilmaydi —

    // admin/waiter panelidan qo'lda tanlanadi.

    if (mode !== "auto") return null;



    // Auto: faol ofitsiantlar ichidan eng kam ochiq (yetkazilmagan)

    // buyurtmasi bo'lganini topamiz.

    const usersSnap = await get(ref(db, `${BASE_PATH}/users`));

    const users = usersSnap.exists() ? usersSnap.val() : {};

    const activeWaiterIds = Object.entries(users)

      .filter(([, u]) => u.role === "waiter" && u.active !== false)

      .map(([id]) => id);



    if (!activeWaiterIds.length) return null;



    const ordersSnap = await get(ref(db, `${BASE_PATH}/orders`));

    const allOrders = ordersSnap.exists() ? ordersSnap.val() : {};



    const DONE = ["yopildi", "closed", "yetkazildi", "bekor qilindi", "to'landi", "eating", "cancelled"];

    const load = {};

    activeWaiterIds.forEach(id => { load[id] = 0; });



    Object.values(allOrders).forEach(o => {

      const st = String(o.status || o.statusKey || "").toLowerCase();

      if (o.waiterId && load.hasOwnProperty(o.waiterId) && !DONE.includes(st)) {

        load[o.waiterId]++;

      }

    });



    // Eng kam yuklangan ofitsiant (teng bo'lsa — ro'yxatdagi birinchisi)

    let bestId = activeWaiterIds[0];

    activeWaiterIds.forEach(id => {

      if (load[id] < load[bestId]) bestId = id;

    });



    return { id: bestId, name: users[bestId]?.name || "" };

  } catch (e) {

    console.warn("Ofitsiant avtomatik biriktirishda xato:", e);

    return null;

  }

}



async function updateOrderKitchenStatus(

  orderId,

  nextStatus,

  extra = {}

) {



  await ensureChefAccess("kitchen_manage");



  const orderRef =

    ref(db, `${BASE_PATH}/orders/${orderId}`);



  const snap = await get(orderRef);



  if (!snap.exists()) return;



  const order = snap.val();



  const normalized =

    normalizeKitchenStatus(nextStatus);



  const now = Date.now();



  const current =

    getOrderStatus(order);



  const statusLabels = {



    new: t("status_new", "Yangi"),



    approved: t("status_approved", "Tasdiqlandi"),



    cooking: t("status_cooking", "Tayyorlanmoqda"),



    ready: t("status_ready", "Tayyor"),



    delivering: t("status_on_way", "Yetkazilmoqda"),



    closed: t("status_closed", "Yopildi"),



    cancelled: t("status_cancelled", "Bekor qilindi")



  };



  const patches = {



    status: normalized,



    statusKey: normalized,



    statusLabel:

      statusLabels[normalized] || normalized,



    updatedAt: now,



    updatedBy: currentChefId,



    ...extra



  };



  if (

    !order.chefId &&

    ["approved", "cooking", "ready"]

      .includes(normalized)

  ) {



    patches.chefId = currentChefId;



    patches.assignedAt = now;



  }



  if (

    normalized === "approved" &&

    !order.takenAt

  ) {



    patches.takenAt = now;



  }



  if (

    normalized === "cooking" &&

    !order.startedAt

  ) {



    patches.startedAt = now;



  }



  if (normalized === "ready") {



    patches.finishedAt = now;

    // 🆕 Yangi flow bosqichi

    patches.statusV2 = ORDER_STATUS_V2.READY.key;

    patches.statusV2Label = ORDER_STATUS_V2.READY.labelUz;

    patches[`statusHistory/${ORDER_STATUS_V2.READY.key}`] = now;



    // 🧑‍🍳 Ofitsiant biriktirish (faqat "auto" rejimda, va

    // buyurtmaga hali hech kim biriktirilmagan bo'lsa)

    if (!order.waiterId) {

      const resolved = await _resolveReadyWaiter(order);

      if (resolved) {

        patches.waiterId = resolved.id;

        patches.waiterName = resolved.name;

        patches.waiterAssignedAt = now;

        patches.waiterAssignedVia = "auto";

      }

    }



  }



  if (

    normalized === "cooking" &&

    current === "ready"

  ) {



    patches.finishedAt = null;



  }



  if (normalized === "closed") {



    patches.closedAt = now;



  }



  await update(orderRef, patches);



  if (order?.table) {



    await writeTableState(order.table, {



      status:

        normalized === "ready"

          ? "ready"

          : normalized === "closed"

            ? "free"

            : "open",



      orderId:

        normalized === "closed"

          ? null

          : orderId,



      chefId:

        patches.chefId ||

        order.chefId ||

        currentChefId,



      kitchenStatus: normalized



    });



  }



  await createKitchenTimelineEvent(

    orderId,

    "order_status_changed",

    {

      from: current,

      to: normalized,

      assignedBy:

        extra.assignedBy || null,

      assignedAt:

        patches.assignedAt || null

    }

  );



  await kitchenAudit(

    "order_status_changed",

    {

      orderId,

      from: current,

      to: normalized,

      table: order.table || null

    }

  );



  if (

    normalized === "ready" &&

    order?.table

  ) {



    await push(

      ref(db, BASE_PATH + "/waiterCalls"),

      {

        table: order.table,

        orderId,



        message:

          `🪑 ${t("table_label")} ` +

          `${order.table}: ` +

          `${t("status_ready")}`,



        createdAt: now,



        status: "waiting",



        chefId: currentChefId,



        chefName:

          window.allChefs?.[currentChefId]

            ?.name || currentChefId

      }

    );



  }



  showChefNotification(

    `✅ ${t("status_label", "Status")

    }: ${statusLabels[normalized]

    }`

  );



}



window.updateChefOrderStatus = window.processChefAction;

window.changeOrderStatus = window.processChefAction;



window.acceptOrder = async function (orderId) {

  try {

    if (typeof updateOrderKitchenStatus === "function") {

      await updateOrderKitchenStatus(

        orderId,

        "approved",

        {

          statusKey: "approved",

          statusLabel: t("status_approved", "Tasdiqlandi"),

          approvedAt: Date.now(),

          // 🆕 Yangi flow uchun aniqroq bosqich: buyurtma oshxona

          // printeri va displeyiga bir vaqtda (parallel) yuboriladi.

          statusV2: ORDER_STATUS_V2.KITCHEN_PRINTER.key,

          statusV2Label: `${ORDER_STATUS_V2.KITCHEN_PRINTER.labelUz} + ${ORDER_STATUS_V2.KITCHEN_DISPLAY.labelUz}`,

          [`statusHistory/${ORDER_STATUS_V2.KITCHEN_PRINTER.key}`]: Date.now()

        }

      );

    }



    if (typeof window.deductOrderInventory === "function") {

      await window.deductOrderInventory(orderId);

    }



    if (typeof showToast === "function") {

      showToast(t("order_accepted", "Buyurtma tasdiqlandi"), "success");

    }



  } catch (error) {

    console.error("Buyurtmani tasdiqlashda xato:", error);

    if (typeof showToast === "function") {

      showToast(t("error_generic", "Xatolik yuz berdi"), "error");

    }

  }

};



window.startCooking = async function (orderId) {

  if (window.isChefMonitorMode && window.isChefMonitorMode()) return; // 🖥️ Monitor rejimi: faqat ko'rish

  const timeInput = document.getElementById(`time-input-${orderId}`);

  const inputVal = parseInt(timeInput?.value);



  if (!inputVal || inputVal <= 0) {

    if (typeof showToast === "function")

      showToast(t("enter_ready_minutes", "Iltimos, tayyor bo'lish vaqtini daqiqada kiriting!"), "warning");

    if (timeInput) {

      timeInput.focus();

      timeInput.style.border = "2px solid #ef4444";

      setTimeout(() => { if (timeInput) timeInput.style.border = ""; }, 1500);

    }

    return;

  }



  const minutes = inputVal;

  const now = Date.now();

  const readyAt = now + (minutes * 60000);

  const restId = localStorage.getItem("restaurantId") || currentRestaurantId;

  const orderRef = ref(db, `restaurants/${restId}/orders/${orderId}`);



  // Tugmani vaqtincha bloklash (ikki marta bosishdan saqlash)

  const startBtn = document.querySelector(`[onclick="window.startCooking('${orderId}')"]`);

  if (startBtn) {

    startBtn.disabled = true;

    startBtn.style.opacity = "0.6";

    startBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ...`;

  }



  try {

    await update(orderRef, {

      status: "cooking",

      statusKey: "cooking",

      statusLabel: t("status_cooking", "Tayyorlanmoqda"),

      readyAt: readyAt,

      expectedReadyAt: readyAt,

      prepMinutes: minutes,

      cookingStartedAt: now,

      chefTimerSetAt: now,

      updatedAt: now,

      // 🆕 Yangi flow bosqichi

      statusV2: ORDER_STATUS_V2.PREPARING.key,

      statusV2Label: ORDER_STATUS_V2.PREPARING.labelUz,

      [`statusHistory/${ORDER_STATUS_V2.PREPARING.key}`]: now

    });



    if (typeof showToast === "function")

      showToast(

        `⏱ ${minutes} ${t("minute_short", "daqiqa")} — ${t("timer_started", "taymer ishga tushdi")}`,

        "success"

      );



    // 🆕 Audit Log

    try {

      const _chefId2 = sessionStorage.getItem("userId") || "chef";

      const _chefName2 = localStorage.getItem("userName") || t("chef_label", "Oshpaz");

      const _restId2 = localStorage.getItem("restaurantId");

      if (_restId2) {

        await writeOrderAuditLog(db, `restaurants/${_restId2}`, {

          actorId: _chefId2,

          actorName: _chefName2,

          actorRole: "chef",

          action: "cooking_started",

          fromStatus: ORDER_STATUS_V2.KITCHEN_PRINTER.key,

          toStatus: ORDER_STATUS_V2.PREPARING.key,

          orderId,

          description: `🔥 Pishirish boshlandi — ${minutes} daqiqa`

        });

      }

    } catch (_ae) { console.warn("startCooking audit:", _ae); }



    if (typeof window.deductOrderInventory === "function")

      await window.deductOrderInventory(orderId);



  } catch (err) {

    console.error("Start cooking error:", err);

    if (typeof showToast === "function") showToast(t("error_generic", "Xatolik"), "error");

    // Xato bo'lsa tugmani qayta yoqamiz

    if (startBtn) {

      startBtn.disabled = false;

      startBtn.style.opacity = "";

      startBtn.innerHTML = `<i class="fa-solid fa-play"></i> ${t("start_cooking_btn", "BOSHLASH")}`;

    }

  }

};



window.markAsReady = window.markOrderReady;



// ─── Cooking vaqtini yangilash (oshpaz qo'lda o'zgartirsa) ───────────────────

window.updateCookingTimer = async function (orderId) {

  const input = document.getElementById(`new-time-${orderId}`);

  const inputVal = parseInt(input?.value);

  if (!inputVal || inputVal <= 0) {

    if (typeof showToast === "function") showToast(t("enter_ready_minutes", "Daqiqa kiriting!"), "warning");

    if (input) input.focus();

    return;

  }

  const readyAt = Date.now() + (inputVal * 60000);

  const restId = localStorage.getItem("restaurantId") || currentRestaurantId;

  try {

    await update(ref(db, `restaurants/${restId}/orders/${orderId}`), {

      readyAt,

      expectedReadyAt: readyAt,

      prepMinutes: inputVal,

      updatedAt: Date.now()

    });

    if (typeof showToast === "function") showToast(`⏱ ${inputVal} ${t("minute_short", "daqiqa")} — ${t("timer_started", "taymer yangilandi")}`, "success");

  } catch (err) {

    console.error("updateCookingTimer error:", err);

    if (typeof showToast === "function") showToast(t("error_generic", "Xatolik"), "error");

  }

};



window.returnOrderToCooking =

  async function (orderId) {



    await updateOrderKitchenStatus(

      orderId,

      "cooking",

      {

        statusKey: "cooking",

        statusLabel: t("status_return_cooking", "Qayta tayyorlanmoqda"),

        returnedToCookingAt: Date.now()

      }

    );



  };



window.reopenReadyOrder =

  async function (orderId) {



    await updateOrderKitchenStatus(

      orderId,

      "cooking",

      {

        statusKey: "cooking",

        statusLabel: t("status_reopened", "Qayta ochildi"),

        reopenedAt: Date.now()

      }

    );



  };



window.takeOrder = async function (orderId) {

  const snap = await get(ref(db, BASE_PATH + "/orders/" + orderId));

  if (!snap.exists()) return;

  const order = snap.val();

  if (order.chefId) { alert(t("order_already_taken", "Ushbu buyurtma allaqachon boshqa oshpaz tomonidan olingan!")); return; }

  const now = Date.now();

  await update(ref(db, BASE_PATH + "/orders/" + orderId), {

    chefId: currentChefId, status: "approved", statusKey: "approved", statusLabel: "approved",

    takenAt: now, updatedAt: now, assignedAt: now

  });

  if (order.table) await writeTableState(order.table, { status: "open", orderId, chefId: currentChefId, kitchenStatus: "approved" });

  emitSocket("chef:new-order", { orderId, orderNumber: order.orderNumber || orderId, chefId: currentChefId, table: order.table || null });

  if (typeof window.deductOrderInventory === "function") {

    await window.deductOrderInventory(orderId);

  }

  showNotification(t("order_taken", "Buyurtma qabul qilindi"));

};



window.claimOrder = window.takeOrder;



window.sendChefInlineReply = async function (orderId) {

  const input = document.getElementById(`chefReplyInput_${orderId}`);

  const text = input?.value.trim();

  if (!text) return;

  const myChefId = String(currentChefId || "").trim();

  if (!myChefId) return;

  const orderSnap = await get(ref(db, BASE_PATH + "/orders/" + orderId));

  if (!orderSnap.exists()) return;

  const order = orderSnap.val();

  const orderChefId = String(order.chefId || "").trim();

  if (orderChefId !== myChefId) { alert(t("not_your_order", "Bu sizning buyurtmangiz emas!")); return; }

  const senderName = window.allChefs?.[myChefId]?.name || t("chef_label", "Oshpaz");

  const now = Date.now();

  await update(ref(db, `${BASE_PATH}/orderChats/${orderId}/chef/meta`), {

    orderId, orderNumber: order.orderNumber || null, table: order.table || null,

    clientId: order.clientId || null, targetId: myChefId, targetRole: "chef",

    chefName: senderName, lastMessage: text, lastSenderRole: "chef", updatedAt: now, status: "open"

  });

  await push(ref(db, `${BASE_PATH}/orderChats/${orderId}/chef/messages`), {

    text, senderId: myChefId, senderRole: "chef", senderName, orderId, table: order.table || null, createdAt: now

  });

  await update(ref(db, `${BASE_PATH}/orders/${orderId}`), { lastChefMessage: text, lastChefMessageAt: now });

  emitSocket("chef:chat-message", { orderId, text, senderId: myChefId, senderName, createdAt: now });

  input.value = "";

};



/* =========================

   ITEM-LEVEL ACTIONS

========================= */

function resolveOrderItemKey(order, itemId) {

  if (!order?.items) return "";

  if (order.items[itemId]) return itemId;

  const found = Object.entries(order.items).find(([key, item]) => String(item?.menuId || item?.id || item?.itemId || key) === String(itemId));

  return found?.[0] || "";

}



async function updateOrderItemStatus(orderId, itemId, patch = {}) {

  const snap = await get(ref(db, `${BASE_PATH}/orders/${orderId}`));

  if (!snap.exists()) return "";

  const order = snap.val();

  const resolvedKey = resolveOrderItemKey(order, itemId);

  if (!resolvedKey) return "";

  await update(ref(db, `${BASE_PATH}/orders/${orderId}/items/${resolvedKey}`), { ...patch, updatedAt: Date.now(), updatedBy: currentChefId });

  return resolvedKey;

}



window.toggleItemPrepared = async function (orderId, itemId) {

  const snap = await get(ref(db, `${BASE_PATH}/orders/${orderId}`));

  if (!snap.exists()) return;

  const order = snap.val();

  const resolvedKey = resolveOrderItemKey(order, itemId);

  if (!resolvedKey) return;

  const currentItem = order?.items?.[resolvedKey] || {};

  const nextState = getItemKitchenState(currentItem) === "prepared" ? "pending" : "prepared";

  // ── item.status ham yoziladi (mijoz sahifasi - client.js - shu maydonni

  // o'qiydi: "ready"/"tayyor"/"delivered"). Agar item allaqachon "delivered"

  // bo'lsa, uni orqaga qaytarmaymiz. ──

  const curClientStatus = String(currentItem?.status || "").toLowerCase();

  const alreadyDelivered = curClientStatus === "delivered" || curClientStatus === "yetkazildi";

  const patch = { kitchenStatus: nextState, preparedAt: nextState === "prepared" ? Date.now() : null };

  if (!alreadyDelivered) {

    patch.status = nextState === "prepared" ? "ready" : "pending";

  }

  await updateOrderItemStatus(orderId, resolvedKey, patch);

  await createKitchenTimelineEvent(orderId, "item_toggled_prepared", { itemId: resolvedKey, kitchenStatus: nextState });

  await kitchenAudit("item_toggled_prepared", { orderId, itemId: resolvedKey, kitchenStatus: nextState });

  renderChefOrders();

};



window.markDelayedItem = async function (orderId, itemId) {

  await updateOrderItemStatus(orderId, itemId, { kitchenStatus: "delayed", delayedAt: Date.now() });

  await createKitchenTimelineEvent(orderId, "item_delayed", { itemId });

  await kitchenAudit("item_delayed", { orderId, itemId });

  renderChefOrders();

};



window.addKitchenNote = async function (orderId, itemId, note) {

  const finalNote = typeof note === "string" ? note : prompt(t("enter_kitchen_note", "Kitchen note kiriting:"));

  if (!finalNote) return;

  const resolvedKey = await updateOrderItemStatus(orderId, itemId, { kitchenNote: finalNote });

  await createKitchenTimelineEvent(orderId, "item_note_added", { itemId: resolvedKey || itemId, note: finalNote });

  await kitchenAudit("item_note_added", { orderId, itemId: resolvedKey || itemId, note: finalNote });

  renderChefOrders();

};



window.rejectOrderItem = async function (orderId, itemId, reason = "Rejected") {

  const finalReason = reason || prompt(t("enter_reject_reason", "Sabab kiriting:")) || t("default_rejected", "Rad etildi");

  const resolvedKey = await updateOrderItemStatus(orderId, itemId, { kitchenStatus: "rejected", rejectedReason: finalReason, rejectedAt: Date.now() });

  await createKitchenTimelineEvent(orderId, "item_rejected", { itemId: resolvedKey || itemId, reason: finalReason });

  await kitchenAudit("item_rejected", { orderId, itemId: resolvedKey || itemId, reason: finalReason });

  renderChefOrders();

};



// ── Bitta taomni "Tayyor" deb belgilash (aralash buyurtmalar uchun) ──

// Somsa+shashlik aralash buyurtmada faqat somsa tayyor bo'lsa, shu tugma

// bosiladi. Item.status="ready" bo'ladi (client.js buni o'qiydi), va agar

// buyurtmadagi BARCHA itemlar tayyor bo'lsa — butun order.status ham

// "ready" ga o'tkaziladi (ofitsiant sahifasiga chiqishi uchun).

window.toggleSingleItemReady = async function (orderId, itemId) {

  const orderRef = ref(db, `${BASE_PATH}/orders/${orderId}`);

  const snap = await get(orderRef);

  if (!snap.exists()) return;

  const order = snap.val();

  const resolvedKey = resolveOrderItemKey(order, itemId);

  if (!resolvedKey) return;

  const currentItem = order?.items?.[resolvedKey] || {};

  const curStatus = String(currentItem?.status || "").toLowerCase();



  if (curStatus === "delivered" || curStatus === "yetkazildi") return; // olib ketilganini o'zgartirmaymiz



  const nextStatus = (curStatus === "ready" || curStatus === "tayyor") ? "pending" : "ready";

  const patch = {

    status: nextStatus,

    kitchenStatus: nextStatus === "ready" ? "prepared" : "pending",

    preparedAt: nextStatus === "ready" ? Date.now() : null,

    updatedAt: Date.now(),

    updatedBy: currentChefId

  };

  await update(ref(db, `${BASE_PATH}/orders/${orderId}/items/${resolvedKey}`), patch);



  // ── Barcha itemlar tayyor/yetkazilganmi tekshiramiz ──

  const freshSnap = await get(orderRef);

  const freshOrder = freshSnap.exists() ? freshSnap.val() : order;

  const allItems = Object.values(freshOrder?.items || {});

  const allReadyOrDelivered = allItems.length > 0 && allItems.every(it => {

    const s = String(it?.status || "").toLowerCase();

    return ["ready", "tayyor", "delivered", "yetkazildi"].includes(s);

  });



  if (allReadyOrDelivered && nextStatus === "ready") {

    const orderStatus = String(freshOrder?.status || "").toLowerCase();

    if (!["ready", "tayyor", "yetkazildi", "delivered", "yopildi", "closed"].includes(orderStatus)) {

      await update(orderRef, {

        status: "ready", statusKey: "ready",

        finishedAt: Date.now(), readyAt: Date.now(),

        isNotified: false, notified: false

      });

    }

  }



  await createKitchenTimelineEvent(orderId, "item_toggled_ready", { itemId: resolvedKey, status: nextStatus });

  await kitchenAudit("item_toggled_ready", { orderId, itemId: resolvedKey, status: nextStatus });

  if (typeof showToast === "function") {

    showToast(nextStatus === "ready" ? t("item_marked_ready", "Taom tayyor deb belgilandi") : t("item_marked_pending", "Taom qayta 'kutmoqda' holatiga qaytdi"), "success");

  }

  renderChefOrders();

};



window.markAllItemsPrepared = async function (orderId) {

  const snap = await get(ref(db, `${BASE_PATH}/orders/${orderId}`));

  if (!snap.exists()) return;

  const order = snap.val();

  const ops = Object.entries(order?.items || {}).map(([key, item]) => {

    const curClientStatus = String(item?.status || "").toLowerCase();

    const alreadyDelivered = curClientStatus === "delivered" || curClientStatus === "yetkazildi";

    const patch = { kitchenStatus: "prepared", preparedAt: Date.now(), updatedAt: Date.now(), updatedBy: currentChefId };

    if (!alreadyDelivered) patch.status = "ready";

    return update(ref(db, `${BASE_PATH}/orders/${orderId}/items/${key}`), patch);

  });

  await Promise.all(ops);

  await createKitchenTimelineEvent(orderId, "all_items_prepared", {});

  await kitchenAudit("all_items_prepared", { orderId });

  renderChefOrders();

};



/* =========================

   STOP-LIST

========================= */

function renderStopList() {

  const root = document.getElementById("stopListBoard");

  if (!root) return;

  const items = Object.entries(window.stopList || {}).filter(([_, item]) => item?.active !== false).sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0));

  root.innerHTML = `<div class="chef-widget-head">⛔ ${t("stop_list_title", "Stop-list")}</div><div class="chef-widget-body">${items.length ? items.map(([id, item]) => `<div class="stop-row"><div><b>${escapeHtml(item?.name || id)}</b><small>${formatDateTime(item?.updatedAt || item?.createdAt)}</small></div><button type="button" onclick="removeFromStopList('${escapeJsString(id)}')">♻️</button></div>`).join("") : `<div class="detail-empty">${t("stop_list_empty", "Stop-list bo'sh")}</div>`}</div>`;

}



async function loadStopList() {

  const snap = await get(ref(db, BASE_PATH + "/stopList"));

  window.stopList = snap.val() || {};

  renderStopList();

  return window.stopList;

}



window.addToStopList = async function (productId, productName) {

  await ensureChefAccess("kitchen_manage");



  const updates = {};

  updates[`${BASE_PATH}/stopList/${productId}`] = {

    productId, name: productName, active: true,

    updatedAt: Date.now(), updatedBy: currentChefId, source: "chef"

  };

  updates[`${BASE_PATH}/menu/${productId}/active`] = false;



  await update(ref(db), updates);

  await kitchenAudit("stop_list_added", { productId, name: productName }, "warning");

};



window.removeFromStopList = async function (productId) {

  const updates = {};

  updates[`${BASE_PATH}/stopList/${productId}`] = null;

  updates[`${BASE_PATH}/menu/${productId}/active`] = true;



  await update(ref(db), updates);

  await kitchenAudit("stop_list_removed", { productId }, "info");

};



window.toggleItemAvailability = async function (productId, active) {

  await update(ref(db, `${BASE_PATH}/menu/${productId}`), { active: !!active, updatedAt: Date.now(), updatedBy: currentChefId });

  if (active) await window.removeFromStopList(productId);

  else { const name = window.allMenu?.[productId]?.name?.[currentLang] || window.allMenu?.[productId]?.name || productId; await window.addToStopList(productId, name); }

};



/* =========================

   KITCHEN NOTIFICATIONS

========================= */

function buildKitchenNotifications() {

  const list = [];

  const entries = getChefVisibleOrders();

  entries.forEach(([orderId, order]) => {

    const remaining = getRemainingInfo(order);

    const isMine = String(getAssignedChefId(orderId, order)) === String(currentChefId);

    if (isMine && ["new", "approved"].includes(getOrderStatus(order))) list.push({ id: `new_${orderId}`, type: "new_order", createdAt: Number(order?.createdAt || Date.now()), text: `🆕 ${t("new_order", "Yangi order")} #${orderId}` });

    if (remaining.delayed) list.push({ id: `delay_${orderId}`, type: "delay", createdAt: Date.now(), text: `🚨 ${t("delayed_order_alert", "Kechikkan order")} #${orderId}` });

    if (order?.clientRequest) list.push({ id: `note_${orderId}`, type: "note", createdAt: Number(order?.updatedAt || order?.createdAt || Date.now()), text: `📝 ${t("note_exists", "Note mavjud:")} #${orderId}` });

    const stopHits = Object.values(order?.items || {}).filter(item => { const menuId = item?.menuId || item?.id || item?.itemId; return menuId && window.stopList?.[menuId]?.active !== false; });

    if (stopHits.length) list.push({ id: `stop_${orderId}`, type: "stoplist", createdAt: Date.now(), text: `⛔ ${t("stop_list_item_order", "Stop-list item order")} #${orderId}` });

  });

  Object.entries(window.stopList || {}).forEach(([productId, item]) => { if (item?.active !== false) list.push({ id: `stopitem_${productId}`, type: "stop_item", createdAt: Number(item?.updatedAt || item?.createdAt || Date.now()), text: `⛔ ${t("stop_list_title", "Stop-list")}: ${item?.name || productId}` }); });

  return list.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, 20);

}



function loadKitchenNotifications() {

  window.kitchenNotifications = buildKitchenNotifications();

  renderKitchenNotifications();

  return window.kitchenNotifications;

}



function renderKitchenNotifications() {

  const root = document.getElementById("kitchenNotificationsPanel");

  if (!root) return;

  const readIds = new Set(getKitchenReadNotifications());

  const items = window.kitchenNotifications || [];

  root.innerHTML = `<div class="chef-widget-head">🔔 ${t("kitchen_notifications", "Kitchen notifications")}</div><div class="chef-widget-body">${items.length ? items.map(item => `<div class="kitchen-note-row ${readIds.has(item.id) ? "is-read" : ""}"><div>${escapeHtml(item.text)}</div><div class="kitchen-note-actions"><small>${formatDateTime(item.createdAt)}</small><button type="button" onclick="markKitchenNotificationRead('${escapeJsString(item.id)}')">✓</button></div></div>`).join("") : `<div class="detail-empty">${t("no_notifications", "Notification yo'q")}</div>`}</div>`;

}



function getKitchenReadNotifications() {

  try { return JSON.parse(localStorage.getItem("kitchenReadNotifications") || "[]"); } catch (_) { return []; }

}

function setKitchenReadNotifications(ids) { localStorage.setItem("kitchenReadNotifications", JSON.stringify(ids || [])); }

window.markKitchenNotificationRead = function (id) { const ids = new Set(getKitchenReadNotifications()); ids.add(id); setKitchenReadNotifications([...ids]); renderKitchenNotifications(); };



/* =========================

   STATS

========================= */

function calculateAllStats() {

  const stats = {};

  const orders = window.allOrders || allOrders || {};

  if (!orders || !Object.keys(orders).length) return stats;



  Object.entries(orders).forEach(([id, order]) => {

    const chefId = order.chefId || "unassigned";

    if (!stats[chefId]) {

      stats[chefId] = { active: 0, ready: 0, totalWorkMinutes: 0, total: 0, fast: 0, normal: 0 };

    }



    const status = normalizeKitchenStatus(order.status);



    if (status === 'cooking' || status === 'preparing' || status === 'approved') {

      stats[chefId].active++;

    }



    const isToday = new Date(order.createdAt).toLocaleDateString() === new Date().toLocaleDateString();

    if (status === 'ready' && isToday) {

      stats[chefId].ready++;

    }



    if (order.acceptedAt && order.readyAt) {

      const diff = Math.round((order.readyAt - order.acceptedAt) / 60000);

      if (diff > 0) stats[chefId].totalWorkMinutes += diff;

    }



    if (isFastOrder(order)) stats[chefId].fast++;

    else stats[chefId].normal++;



    stats[chefId].total++;

  });

  return stats;

}



function updateStatistics() {

  const allStats = calculateAllStats();

  const myStats = allStats[currentChefId] || { active: 0, fast: 0, normal: 0, ready: 0, total: 0, totalWorkMinutes: 0 };

  if (myActiveCountEl) { myActiveCountEl.textContent = myStats.active; myActiveCountEl.style.display = myStats.active > 0 ? "inline-flex" : "none"; }

  const statMyActiveEl = document.getElementById("statMyActive"), statMyFastEl = document.getElementById("statMyFast"), statMyNormalEl = document.getElementById("statMyNormal"), statMyReadyEl = document.getElementById("statMyReady"), statMyWorkTimeEl = document.getElementById("statMyWorkTime"), statMyTotalEl = document.getElementById("statMyTotal");

  if (statMyActiveEl) statMyActiveEl.textContent = myStats.active;

  if (statMyFastEl) statMyFastEl.textContent = myStats.fast;

  if (statMyNormalEl) statMyNormalEl.textContent = myStats.normal;

  if (statMyReadyEl) statMyReadyEl.textContent = myStats.ready;

  if (statMyWorkTimeEl) statMyWorkTimeEl.textContent = `${myStats.totalWorkMinutes} ${t("minute_short", "daq")}`;

  if (statMyTotalEl) statMyTotalEl.textContent = myStats.total;

  renderKitchenLoadSummary(allStats);

  renderAllChefsStats(allStats);

}



function renderKitchenLoadSummary(allStats) {

  const rows = Object.entries(allStats).sort((a, b) => b[1].active - a[1].active).map(([chefId, stat]) => { const chef = window.allChefs?.[chefId]; if (!chef) return ""; const me = chefId === currentChefId ? " me" : ""; return `<div class="chef-load-row${me}"><div class="chef-load-name">${chef.name || chefId}</div><div class="chef-load-meta">${stat.active} ${t("active_now", "faol")}</div><div class="chef-load-bar"><span style="width:${stat.loadPercent}%"></span></div></div>`; }).join("");

}



function renderAllChefsStats(allStats) {

  if (!allChefsStatsEl) return;

  const sortedChefs = Object.entries(allStats).sort((a, b) => { if (b[1].active !== a[1].active) return b[1].active - a[1].active; if (b[1].ready !== a[1].ready) return b[1].ready - a[1].ready; return b[1].totalWorkMinutes - a[1].totalWorkMinutes; });

  allChefsStatsEl.innerHTML = `<h4>${t("all_chefs_title", "Barcha oshpazlar")}</h4><div class="stats-legend"><div class="legend-item">${t("stats_active_short", "Faol")}</div><div class="legend-item">${t("stats_fast_short", "Tez")}</div><div class="legend-item">${t("stats_normal_short", "Oddiy")}</div><div class="legend-item">${t("stats_ready_short", "Tayyor")}</div><div class="legend-item">${t("stats_time_short", "Vaqt")}</div></div>${sortedChefs.map(([chefId, stats]) => { const chef = window.allChefs?.[chefId]; if (!chef) return ""; const isMe = chefId === currentChefId; const isActive = chef.active !== false; return `<div class="chef-stat-row ${isMe ? "my-row" : ""} ${!isActive ? "inactive" : ""}"><div class="chef-stat-name">${isMe ? "👨‍🍳" : "🧑‍🍳"} ${chef.name || chefId}${isMe ? `<span class="me-badge">${t("me_badge", "Men")}</span>` : ""}${!isActive ? `<span class="inactive-badge">${t("inactive_badge", "Faolsiz")}</span>` : ""}</div><div class="chef-stat-numbers"><span class="stat-badge active-badge">🔥 ${stats.active}</span><span class="stat-badge fast-badge">⚡ ${stats.fast}</span><span class="stat-badge normal-badge">🟢 ${stats.normal}</span><span class="stat-badge completed-badge">✅ ${stats.ready}</span><span class="stat-badge time-badge">⏱ ${stats.totalWorkMinutes} ${t("minute_short", "daq")}</span></div></div>`; }).join("")}`;

}



function updateNewOrdersBadge() {

  if (!newOrdersBadge) return;

  const selectedChef = getSelectedChef();

  const myId = String(currentChefId);

  const count = Object.entries(allOrders || {}).filter(([orderId, order]) => { if (!order) return false; const status = getOrderStatus(order); const orderChefId = String(getAssignedChefId(orderId, order) || ""); const pendingStatuses = ["new", "approved", "cooking"]; if (!pendingStatuses.includes(normalizeKitchenStatus(status))) return false; if (selectedChef !== "all") return orderChefId === String(selectedChef); return orderChefId === myId; }).length;

  newOrdersBadge.textContent = count;

  newOrdersBadge.style.display = count > 0 ? "inline-flex" : "none";

}



/* =========================

   TABLE STATUS

========================= */

function deriveTableStatusFromOrders(tableNumber) {

  const orders = Object.values(allOrders || {}).filter(order => String(order.table || "") === String(tableNumber));

  if (!orders.length) return "free";

  if (orders.some(order => getOrderStatus(order) === "ready")) return "ready";

  if (orders.some(order => ["new", "approved", "cooking"].includes(getOrderStatus(order)))) return "busy";

  return "free";

}



function getTableStatusLabel(status) { if (status === "ready") return t("table_ready_pickup", "Olib ketishga tayyor"); if (status === "busy") return t("table_busy", "Band"); return t("table_free", "Bo'sh"); }



window.confirmOrderTime = async function (orderId) {

  const input = document.getElementById(`time-input-${orderId}`);

  if (!input) return;



  const minutes = parseInt(input.value);



  if (!minutes || minutes <= 0) {

    alert(t("enter_prep_time", "Iltimos, tayyor bo'lish vaqtini kiriting!"));

    return;

  }



  const readyAt = Date.now() + (minutes * 60000);



  try {

    const restaurantId = localStorage.getItem("restaurantId");

    if (!restaurantId) throw new Error(t("restaurant_id_missing", "Restaurant ID topilmadi"));



    const orderRef = ref(db, `restaurants/${restaurantId}/orders/${orderId}`);

    await update(orderRef, {

      readyAt: readyAt,

      status: "cooking",

      statusKey: "cooking"

    });



    if (typeof window.deductOrderInventory === "function") {

      await window.deductOrderInventory(orderId);

    }



    if (typeof showToast === "function") showToast(t("time_set_success", "Vaqt belgilandi"), "success");

  } catch (error) {

    console.error(t("time_save_error_log", "Vaqtni saqlashda xato:"), error);

    alert(t("error_generic", "Xatolik yuz berdi!"));

  }

};



window.saveChefTime = async function (orderId) {

  const input = document.getElementById(`time-input-${orderId}`);

  const minutes = parseInt(input.value);

  if (!minutes || minutes <= 0) return;



  const readyAt = Date.now() + (minutes * 60000);



  try {

    const restaurantId = localStorage.getItem("restaurantId");

    await update(ref(db, `restaurants/${restaurantId}/orders/${orderId}`), { readyAt });

    if (typeof showToast === "function") showToast(t("time_set_success", "Vaqt belgilandi"), "success");

  } catch (e) {

    console.error(t("time_save_error_log", "Vaqtni saqlashda xato:"), e);

  }

};



window.setOrderReadyTime = async function (orderId, minutes) {

  const restaurantId = new URLSearchParams(window.location.search).get('rest') || localStorage.getItem("restaurantId");

  const orderRef = ref(db, `restaurants/${restaurantId}/orders/${orderId}`);



  const now = Date.now();

  const readyAtTimestamp = now + (minutes * 60 * 1000);



  await update(orderRef, {

    status: "cooking",

    statusKey: "cooking",

    prepMinutes: minutes,

    readyAt: readyAtTimestamp,

    updatedAt: now,

    isNotified: false

  });



  if (typeof window.deductOrderInventory === "function") {

    await window.deductOrderInventory(orderId);

  }



  if (typeof showToast === "function") showToast(t("order_started", "Buyurtma boshlandi"), "success");

};



async function writeTableState(tableNo, patch = {}) {

  if (!tableNo) return;

  const tableRef = ref(db, `${BASE_PATH}/tables/${getTableKey(tableNo)}`);

  const currentSnap = await get(tableRef);

  const current = currentSnap.exists() ? currentSnap.val() : {};



  await update(tableRef, {

    ...patch,

    updatedAt: Date.now(),

    busy: !["free", "cleaning"].includes(String(patch.status || current.status || "").toLowerCase())

  });

}



/* =========================

   CHEF CHAT

========================= */

function getChefChatRoomList() { return [{ id: PERSONAL_CHEF_ROOM, targetId: currentChefId, name: t("messages_to_me", "Menga kelgan xabarlar") }]; }

function getChefChatMessages(roomId) {

  if (roomId !== PERSONAL_CHEF_ROOM) return [];

  return (window.chefChats?.[roomId]?.messages || []).filter(msg => { const msgTargetId = String(msg?.targetId || window.chefChats?.[roomId]?.meta?.targetId || currentChefId); const msgSenderId = String(msg?.senderId || ""); return msgTargetId === String(currentChefId) || msgSenderId === String(currentChefId); });

}



function renderChefChatRooms() {

  if (!chefChatRoomsDom) return;

  const rooms = getChefChatRoomList();

  chefChatRoomsDom.innerHTML = rooms.map(room => { const unread = (window.chefChats?.[room.id]?.messages || []).filter(msg => msg.senderId !== currentChefId).length; return `<button type="button" class="chef-room-item ${room.id === currentChefChatRoom ? "active" : ""}" data-room-id="${room.id}"><span>${escapeHtml(room.name)}</span>${unread ? `<span class="chef-room-count">${unread}</span>` : ""}</button>`; }).join("");

  chefChatRoomsDom.querySelectorAll(".chef-room-item").forEach(btn => { btn.addEventListener("click", () => { currentChefChatRoom = btn.dataset.roomId || "kitchen"; localStorage.setItem("chefChatRoom", currentChefChatRoom); renderChefChatRooms(); renderChefChatMessages(); }); });

}



function renderChefChatMessages() {

  if (!chefChatMessagesDom || !chefChatTitleDom) return;



  const rooms = getChefChatRoomList();

  const room = rooms.find(item => item.id === currentChefChatRoom) || rooms[0];

  const messages = getChefChatMessages(currentChefChatRoom);



  chefChatTitleDom.textContent = room?.name || t("chef_chat_title", "Oshpaz Chat");



  chefChatMessagesDom.innerHTML = messages.length

    ? messages.slice(-50).map(msg => `

        <div class="chef-chat-message ${msg.senderId === currentChefId ? "me" : "other"}">

          <div class="chef-chat-text">${escapeHtml(msg.text || "")}</div>

          <div class="chef-chat-meta">${escapeHtml(msg.senderName || "")} • ${formatOrderTime(msg.createdAt)}</div>

        </div>`).join("")

    : `<div class="chef-chat-empty">${t("no_chef_messages", "Xabarlar yo'q")}</div>`;



  setTimeout(() => {

    chefChatMessagesDom.scrollTop = chefChatMessagesDom.scrollHeight;

  }, 100);

}



window.sendChefChatMessage = async function () {

  const text = chefChatInputDom?.value.trim();

  if (!text) return;

  const senderName = window.allChefs?.[currentChefId]?.name || sessionStorage.getItem("name") || t("chef_label");

  const now = Date.now();

  const roomId = PERSONAL_CHEF_ROOM;

  const chefChatPath = `restaurants/${currentRestaurantId}/chats/admin_chef_${currentChefId}`;

  await update(ref(db, `${chefChatPath}/meta`), { roomId, targetId: currentChefId, updatedAt: now });

  await push(ref(db, `${chefChatPath}/messages`), { text, senderId: currentChefId, senderRole: "chef", senderName, targetId: currentChefId, createdAt: now });

  emitSocket("chef:chat-message", { roomId, text, senderId: currentChefId, senderName, targetId: currentChefId, createdAt: now });

  if (chefChatInputDom) chefChatInputDom.value = "";

};



/* =========================

   SIDEBAR MENU

========================= */

function renderPrepMenuSidebar() {

  const box = document.getElementById("prepMenuList");

  if (!box) return;

  const items = Object.entries(window.allMenu || {}).filter(([_, item]) => item && item.active !== false).sort((a, b) => getMenuName(a[1], "").localeCompare(getMenuName(b[1], ""), getLocale()));

  box.innerHTML = items.map(([id, item]) => { const name = getMenuName(item, "—"); const img = item.imgUrl || item.img || "img/no-image.png"; const prepTime = Number(item.prepTime || 30); return `<div class="prep-item"><img src="${img}" onerror="this.src='img/no-image.png'"><div class="prep-info"><b>${escapeHtml(name)}</b><div><input type="number" min="1" class="prep-input" id="prep_${id}" value="${prepTime}"><span>${t("minute_short", "daq")}</span></div><button class="prep-save" onclick="savePrepTime('${id}')">💾 ${t("prep_save_btn", "Saqlash")}</button></div></div>`; }).join("");

}



window.savePrepTime = async function (menuId) {

  const input = document.getElementById("prep_" + menuId);

  if (!input) return;

  const prepTime = Number(input.value);

  if (!prepTime || prepTime < 1) { alert(t("prep_time_invalid", "Tayyorlash vaqti noto'g'ri!")); return; }



  await update(ref(db, `${BASE_PATH}/menu/${menuId}`), { prepTime });

  showNotification(`✅ ${t("prep_time_saved", "Vaqt saqlandi")}: ${prepTime} ${t("minute_short", "daq")}`);

};



/* =========================

   TV / FULLSCREEN / COUNTDOWNS

========================= */

// ── TV MODE (kengaytirilgan) ──────────────────────────────────────────────────

function injectChefMonitorStyles() {

  if (document.getElementById("chefMonitorModeStyles")) return;

  const s = document.createElement("style");

  s.id = "chefMonitorModeStyles";

  s.textContent = `

    /* ===== OSHXONA MONITORI REJIMI (faqat ko'rish) ===== */

    body.monitor-mode::before {

      content: "🖥️ MONITOR";

      position: fixed;

      top: 0; left: 0; right: 0;

      z-index: 100000;

      text-align: center;

      font-size: 11px;

      font-weight: 800;

      letter-spacing: 1px;

      color: #0f172a;

      background: linear-gradient(90deg, #fbbf24, #f59e0b);

      padding: 3px 0;

      pointer-events: none;

    }

    body.monitor-mode .order-card { cursor: default; }

  `;

  document.head.appendChild(s);

}



function injectChefTVStyles() {

  if (document.getElementById("chefTVModeStyles")) return;

  const s = document.createElement("style");

  s.id = "chefTVModeStyles";

  s.textContent = `

    /* ===== CHEF TV MODE ===== */

    body.tv-mode .chef-extra-filters,

    body.tv-mode .chef-chat-panel,

    body.tv-mode #statsPanel,

    body.tv-mode #prepMenuList,

    body.tv-mode #kitchenNotificationsPanel,

    body.tv-mode #kitchenAuditList,

    body.tv-mode #stopListBoard,

    body.tv-mode #chefsTodayStats,

    body.tv-mode #langSelect,

    body.tv-mode .lang-selector { display: none !important; }



    body.tv-mode { background: #000 !important; }

    body.tv-mode .container { max-width: none !important; background: transparent !important; padding: 22px 26px !important; }





    body.tv-mode .chef-header {

      background: #0a0a0a !important;

      border-bottom: 1px solid #1f1f1f !important;

      backdrop-filter: none !important;

      -webkit-backdrop-filter: none !important;

      padding: 0 22px !important;

      height: 54px !important;

    }

    body.tv-mode .ch-logo::before { content: "🍳 "; }

    body.tv-mode .ch-brand { color: #fff !important; }

    body.tv-mode .ch-brand-blue { color: #10b981 !important; }

    body.tv-mode .ch-sep { display: none !important; }

    body.tv-mode .ch-user::before { content: "Kitchen Monitor"; color: #fff; font-weight: 700; margin-right: 14px; }

    body.tv-mode .ch-user-name::before { content: "👨‍🍳 "; }

    body.tv-mode .ch-user-name { color: #cbd5e1 !important; }

    body.tv-mode .ch-user-role { color: #64748b !important; }

    body.tv-mode .ch-rest-center { display: none !important; }

    body.tv-mode .ch-online-status { color: #10b981 !important; }

    body.tv-mode .ch-clock { color: #fff !important; font-weight: 700 !important; }

    body.tv-mode .ch-lang,

    body.tv-mode .ch-btn-print,

    body.tv-mode .ch-btn-fs,

    body.tv-mode .ch-btn-logout { display: none !important; }

    body.tv-mode .ch-actions { gap: 18px !important; }



    body.tv-mode #chefTVStatsBar {

      display: flex !important;

      gap: 14px;

      flex-wrap: wrap;

      background: #0a0a0a;

      border: 1px solid #1f1f1f;

      border-radius: 14px;

      padding: 16px 22px;

      margin: 0 0 20px 0;

    }

    body.tv-mode .chef-tv-stat {

      display: flex; align-items: center; gap: 10px;

      flex: 1; min-width: 150px;

    }

    body.tv-mode .chef-tv-stat i { font-size: 20px; color: #e2e8f0; width: 22px; text-align: center; }

    body.tv-mode .chef-tv-stat div { display: flex; flex-direction: column; line-height: 1.25; }

    body.tv-mode .chef-tv-stat span[data-tv-label] {

      font-size: 11px; font-weight: 700; letter-spacing: 0.4px; color: #94a3b8; text-transform: uppercase;

    }

    body.tv-mode .chef-tv-stat b { font-size: 22px; font-weight: 800; color: #fff; }



    body.tv-mode #panelActive,

    body.tv-mode #panelReady {

      display: block !important;

      margin: 0 !important;

    }

    body.tv-mode .ready-section-title,

    body.tv-mode #panelReady > h2,

    body.tv-mode #panelReady > h3 { display: none !important; }



    body.tv-mode #chefOrders,

    body.tv-mode #readyOrders {

      display: grid !important;

      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)) !important;

      gap: 18px !important;

      margin: 0 !important;

    }



    body.tv-mode .order-card {

      background: #fff !important;

      color: #1e293b !important;

      border-radius: 14px !important;

      border: 2.5px solid #e2e8f0 !important;

      padding: 16px 18px !important;

      box-shadow: 0 2px 10px rgba(0,0,0,0.28) !important;

    }

    body.tv-mode .order-card.chef-tv-new    { border-color: #ef4444 !important; }

    body.tv-mode .order-card.chef-tv-cooking{ border-color: #3b82f6 !important; }

    body.tv-mode .order-card.chef-tv-ready  { border-color: #10b981 !important; }



    body.tv-mode .chef-tv-card-top {

      display: flex; justify-content: space-between; align-items: center;

      margin-bottom: 12px;

    }

    body.tv-mode .chef-tv-card-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

    body.tv-mode .chef-tv-fast-badge {

      background: #ef4444; color: #fff; font-size: 11px; font-weight: 800;

      padding: 4px 8px; border-radius: 6px; letter-spacing: 0.3px;

      display: inline-flex; align-items: center; gap: 3px;

    }

    body.tv-mode .chef-tv-table-name { font-size: 17px; font-weight: 800; color: #0f172a; }

    body.tv-mode .order-card.chef-tv-new    .chef-tv-time-big,

    body.tv-mode .order-card.chef-tv-new    .chef-tv-time-small { color: #ef4444; }

    body.tv-mode .order-card.chef-tv-cooking .chef-tv-time-big,

    body.tv-mode .order-card.chef-tv-cooking .chef-tv-time-small { color: #3b82f6; }

    body.tv-mode .order-card.chef-tv-ready  .chef-tv-time-big,

    body.tv-mode .order-card.chef-tv-ready  .chef-tv-time-small { color: #10b981; }

    body.tv-mode .chef-tv-time-block { text-align: right; }

    body.tv-mode .chef-tv-time-big { font-size: 18px; font-weight: 800; line-height: 1.1; }

    body.tv-mode .chef-tv-time-small { font-size: 12px; font-weight: 700; }



    body.tv-mode .chef-tv-chef-row {

      display: flex; align-items: center; gap: 10px;

      padding-bottom: 12px; margin-bottom: 12px;

      border-bottom: 1px solid #f1f5f9;

    }

    body.tv-mode .chef-tv-avatar {

      width: 34px; height: 34px; border-radius: 50%;

      background: #e2e8f0; border: 1px solid #cbd5e1;

      display: flex; align-items: center; justify-content: center;

      font-size: 16px; flex-shrink: 0; overflow: hidden;

    }

    body.tv-mode .chef-tv-chef-name { font-size: 14px; font-weight: 700; color: #334155; letter-spacing: 0.2px; }



    body.tv-mode .chef-tv-items-body { }

    body.tv-mode .chef-tv-item-row {

      display: flex; justify-content: space-between; align-items: center;

      padding: 7px 0;

    }

    body.tv-mode .chef-tv-item-name { font-size: 14.5px; font-weight: 600; color: #1e293b; }

    body.tv-mode .chef-tv-item-qty { font-size: 14px; font-weight: 700; color: #334155; }



    body.tv-mode .chef-tv-chip-row { display: flex; gap: 6px; flex-wrap: wrap; margin: 2px 0 10px 0; }

    body.tv-mode .chef-tv-chip {

      background: #fce8e8; color: #c0392b; border: none;

      font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px;

      display: inline-flex; align-items: center; gap: 4px;

    }



    body.tv-mode #tvModeBtn { background: linear-gradient(135deg,#ef4444,#dc2626) !important; }



    /* ===== TV MODE: IXCHAM AVTOMATIK GRID (ko'p stol bitta ekranga sig'ishi uchun) ===== */

    body.tv-mode .orders-grid {

      display: grid !important;

      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)) !important;

      gap: 8px !important;

      align-items: start;

    }

    body.tv-mode .order-card.chef-tv-compact {

      padding: 6px 8px !important;

      border-radius: 10px !important;

      min-width: 0;

    }

    body.tv-mode .chef-tv-compact-head {

      display: flex; align-items: center; justify-content: space-between;

      gap: 6px; margin-bottom: 4px; padding-bottom: 4px;

      border-bottom: 1px solid #e2e8f0;

    }

    body.tv-mode .chef-tv-compact-table {

      font-size: 13px; font-weight: 800; color: #0f172a; white-space: nowrap;

      overflow: hidden; text-overflow: ellipsis;

    }

    body.tv-mode .chef-tv-compact-time {

      font-size: 11px; font-weight: 700; flex-shrink: 0;

    }

    body.tv-mode .order-card.chef-tv-new .chef-tv-compact-time { color: #ef4444; }

    body.tv-mode .order-card.chef-tv-cooking .chef-tv-compact-time { color: #3b82f6; }

    body.tv-mode .order-card.chef-tv-ready .chef-tv-compact-time { color: #10b981; }

    body.tv-mode .chef-tv-compact-item {

      display: flex; align-items: baseline; justify-content: space-between;

      gap: 4px; font-size: 12px; line-height: 1.35; padding: 1px 0;

    }

    body.tv-mode .chef-tv-compact-item-name {

      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;

      color: #1e293b; font-weight: 600; flex: 1; min-width: 0;

    }

    body.tv-mode .chef-tv-compact-item-qty {

      font-weight: 800; color: #334155; flex-shrink: 0;

    }

    body.tv-mode .chef-tv-compact-item-chef {

      font-size: 10px; color: #94a3b8; margin-left: 4px; flex-shrink: 0;

      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60px;

    }

  `;

  document.head.appendChild(s);

}



function applyChefTVMode(isTV) {

  const hideSelectors = [

    ".chef-extra-filters", ".chef-chat-panel", "#statsPanel",

    "#prepMenuList", "#kitchenNotificationsPanel", "#kitchenAuditList",

    "#stopListBoard", "#chefsTodayStats", "#langSelect", ".lang-selector"

  ];

  hideSelectors.forEach(sel => {

    document.querySelectorAll(sel).forEach(el => { el.style.display = isTV ? "none" : ""; });

  });

  ["chefOrders", "readyOrders"].forEach(id => {

    const el = document.getElementById(id);

    if (!el) return;

    el.style.gridTemplateColumns = isTV ? "repeat(auto-fill, minmax(340px, 1fr))" : "";

    el.style.gap = isTV ? "18px" : "";

  });

}



function updateChefTVButton() {

  const isTV = document.body.classList.contains("tv-mode");

  const btn = document.getElementById("tvModeBtn");

  if (!btn) return;

  const label = btn.querySelector("span[data-i18n]");

  if (label) label.textContent = isTV ? t("tv_mode_off", "TV O'chirish") : t("tv_mode", "TV Rejimi");

  btn.style.background = isTV ? "#dc2626" : "#4f46e5";

}



window.__chefTVRefreshTimer = null;



function startChefTVAutoRefresh() {

  if (window.__chefTVRefreshTimer) return;

  window.__chefTVRefreshTimer = setInterval(() => {

    if (document.body.classList.contains("tv-mode") && typeof window.renderChefOrders === "function") {

      window.renderChefOrders();

    }

  }, 2500);

}



function stopChefTVAutoRefresh() {

  if (window.__chefTVRefreshTimer) {

    clearInterval(window.__chefTVRefreshTimer);

    window.__chefTVRefreshTimer = null;

  }

}



window.toggleTVMode = function () {

  const isTV = document.body.classList.toggle("tv-mode");

  localStorage.setItem("tvMode", isTV ? "1" : "0");

  applyChefTVMode(isTV);

  if (isTV) {

    startChefTVAutoRefresh();

  } else {

    stopChefTVAutoRefresh();

  }

  if (isTV && !document.fullscreenElement) {

    document.documentElement.requestFullscreen().catch(() => { });

  }

  updateChefTVButton();

  if (typeof window.renderChefOrders === "function") window.renderChefOrders();

};



// ── FULLSCREEN ────────────────────────────────────────────────────────────────

window.toggleChefFullscreen = async function () {

  try {

    if (!document.fullscreenElement) {

      await document.documentElement.requestFullscreen();

    } else {

      await document.exitFullscreen();

    }

  } catch (err) {

    console.warn("Fullscreen xato:", err.message);

  }

  setTimeout(updateChefFullscreenButton, 150);

};

window.toggleFullscreen = window.toggleChefFullscreen;

window.toggleStatsPanel = function () { if (!statsPanelEl) return; const isVisible = statsPanelEl.style.display === "block"; statsPanelEl.style.display = isVisible ? "none" : "block"; if (!isVisible) updateStatistics(); };

function updateChefFullscreenButton() {

  const btn = document.getElementById("chefFSBtn");

  if (!btn) return;

  const label = btn.querySelector("span");

  if (label) label.textContent = document.fullscreenElement

    ? t("fullscreen_exit_btn", "Kichraytirish")

    : t("fullscreen_btn", "To'liq ekran");

  const icon = btn.querySelector("i");

  if (icon) icon.className = document.fullscreenElement

    ? "fa-solid fa-compress"

    : "fa-solid fa-rotate";

  icon.style.fontSize = "12px";

}

function updateOrderCountdowns() {

  document.querySelectorAll(".order-card[data-ready-at]").forEach(card => {

    const readyAt = Number(card.dataset.readyAt || 0);

    const orderId = card.dataset.orderId || "";

    const timerEl = card.querySelector(".chef-order-timer div");

    const urgentEl = card.querySelector(".order-urgency-line");

    if (!readyAt || !timerEl) return;

    const diff = readyAt - Date.now();

    const delayedMinutes = diff < 0 ? Math.floor(Math.abs(diff) / 60000) : 0;

    const urgent = diff > 0 && diff <= 5 * 60 * 1000;

    const delayed = delayedMinutes >= 20;

    timerEl.textContent = formatRemainingTime(readyAt);

    card.classList.toggle("order-urgent", urgent);

    card.classList.toggle("order-delayed", delayed);

    card.classList.toggle("time-done", diff <= 0);

    if (urgentEl) {

      if (delayed) urgentEl.innerHTML = `🚨 ${t("delayed_order", "Kechikkan")} • ${delayedMinutes} ${t("minute_short", "daq")}`;

      else if (urgent) urgentEl.innerHTML = `🚨 ${t("urgent_order", "Tezkor")}`;

      else if (diff <= 0) urgentEl.innerHTML = `✅ ${t("ready_time_reached", "Vaqt tugadi")}`;

      else urgentEl.innerHTML = "";

    }

    if (delayed && orderId && !window.delayedAlertedOrders.has(orderId)) { window.delayedAlertedOrders.add(orderId); showNotification(`🚨 ${t("delayed_alert", "Kechikdi")} • #${orderId}`); }

  });



  // chef-card-countdown elementlarini yangilash

  document.querySelectorAll(".chef-card-countdown[data-ready-at]").forEach(el => {

    const readyAt = Number(el.dataset.readyAt || 0);

    if (!readyAt) return;

    const diff = readyAt - Date.now();

    const diffMins = Math.floor(Math.abs(diff) / 60000);

    const diffSecs = Math.floor((Math.abs(diff) % 60000) / 1000);



    if (diff <= 0) {

      const overMin = Math.floor(Math.abs(diff) / 60000);

      el.textContent = `⚠️ ${t("overdue_label", "Kechikdi")} ${overMin} ${t("minute_short", "daq")}`;

      el.style.color = '#ef4444';

      el.classList.remove('shake-anim');

    } else if (diff <= 60000) {

      el.textContent = `⏱ 0:${String(Math.floor(diff / 1000)).padStart(2, '0')} ${t("left_short", "qoldi")}`;

      el.style.color = '#ef4444';

      el.classList.add('shake-anim');

    } else if (diff <= 3 * 60000) {

      el.textContent = `⏱ ${diffMins}:${String(diffSecs).padStart(2, '0')} ${t("left_short", "qoldi")}`;

      el.style.color = '#ef4444';

      el.classList.remove('shake-anim');

    } else {

      el.textContent = `⏱ ${diffMins}:${String(diffSecs).padStart(2, '0')} ${t("left_short", "qoldi")}`;

      el.style.color = '#f59e0b';

      el.classList.remove('shake-anim');

    }

  });

}

function startOrderCountdowns() { if (orderCountdownInterval) return; orderCountdownInterval = setInterval(updateOrderCountdowns, 1000); updateOrderCountdowns(); }



/* =========================

   REALTIME LISTENERS

========================= */

function listenUsers() {

  if (window.listeners?.users) window.listeners.users();

  window.listeners.users = onValue(ref(db, BASE_PATH + "/users"), snap => {

    const users = snap.val() || {};

    window.allChefs = {};

    Object.entries(users).forEach(([id, user]) => { if (user.role === "chef") window.allChefs[id] = user; });

    fillChefFilter(users);

    const me = users[currentChefId] || Object.values(users).find(u => String(u.id || "") === String(currentChefId));

    chefActive = me?.active !== false;

    renderChefChatRooms();

    renderChefChatMessages();

    refreshUI();

  });

}



function listenMenu() {

  if (window.listeners?.menu) window.listeners.menu();

  window.listeners.menu = onValue(ref(db, BASE_PATH + "/menu"), snap => { window.allMenu = snap.val() || {}; renderPrepMenuSidebar(); refreshUI(); });

}



// Ilgari ko'rilgan order IDlarini saqlaymiz — yangi orderlarni aniqlash uchun

let _chefKnownOrderIds = null;



/* ═══════════════════════════════════════════════════════════

   🖨️  KITCHEN AUTO-PRINT SYSTEM

   ──────────────────────────────────────────────────────────

   • buildKitchenReceiptHtml(orderId, order) → HTML string

   • autoPrintKitchenOrder(orderId, order)   → silent iframe print

   • window.manualPrintOrder(orderId)         → manual button trigger

   ═══════════════════════════════════════════════════════════ */



function buildKitchenReceiptHtml(orderId, order) {

  const restName = localStorage.getItem("restaurantName") || "Nesta ERP";

  const chefName = localStorage.getItem("userName") || t("chef_label", "Oshpaz");

  const tableNum = order?.table ?? "—";

  const orderNum = formatOrderNumber(order) || ("#" + String(orderId).slice(-6).toUpperCase());

  const createdAt = order?.createdAt ? new Date(order.createdAt).toLocaleString(getLocale(), { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "—";

  const note = order?.clientRequest || order?.specialNote || "";

  const allergyNote = order?.allergyNote ? `<div class="allergy">⚠️ ${escapeHtml(order.allergyNote)}</div>` : "";

  const isFast = isFastOrder(order);



  const itemsHtml = Object.entries(order?.items || {}).map(([, item]) => {

    const menu = getOrderItemMenu(item) || {};

    const name = getTranslatedItemName(item, menu, currentLang) || "—";

    const qty = Number(item?.qty || 1);

    const kNote = item?.kitchenNote ? `<div class="knote">📝 ${escapeHtml(item.kitchenNote)}</div>` : "";

    return `<tr>

      <td class="qty">${qty}x</td>

      <td class="name">${escapeHtml(name)}${kNote}</td>

    </tr>`;

  }).join("") || `<tr><td colspan="2" class="empty">—</td></tr>`;



  return `<!DOCTYPE html>

<html lang="uz">

<head>

<meta charset="UTF-8">

<title>Kitchen Ticket #${escapeHtml(String(orderNum))}</title>

<style>

  * { margin:0; padding:0; box-sizing:border-box; }

  body {

    font-family: 'Courier New', Courier, monospace;

    font-size: 13px;

    width: 80mm;

    padding: 8px 6px;

    color: #000;

    background: #fff;

  }

  .header { text-align:center; margin-bottom:6px; }

  .header h2 { font-size:18px; font-weight:900; letter-spacing:1px; }

  .header .rest { font-size:11px; color:#444; margin-top:2px; }

  .sep { border:none; border-top:2px dashed #000; margin:6px 0; }

  .sep-thin { border:none; border-top:1px solid #ccc; margin:4px 0; }

  .meta-row { display:flex; justify-content:space-between; font-size:12px; margin:2px 0; }

  .meta-row b { font-weight:800; }

  .badge-fast { display:inline-block; background:#000; color:#fff; font-size:11px; font-weight:900; padding:2px 8px; border-radius:3px; letter-spacing:1px; margin-top:4px; }

  table { width:100%; border-collapse:collapse; margin:4px 0; }

  td { vertical-align:top; padding:3px 2px; }

  td.qty { width:28px; font-weight:900; font-size:14px; text-align:center; }

  td.name { font-size:13px; font-weight:700; }

  .knote { font-size:11px; font-weight:400; color:#555; margin-top:2px; }

  .empty { text-align:center; color:#888; }

  .note-block { font-size:12px; margin:4px 0; padding:4px 6px; border:1.5px solid #000; border-radius:4px; }

  .allergy { font-size:12px; font-weight:900; color:#000; border:2px solid #000; padding:4px 6px; margin:4px 0; background:#f5f5f5; }

  .footer { text-align:center; font-size:11px; color:#666; margin-top:6px; }

  @media print {

    @page { margin:0; size:80mm auto; }

    body { width:80mm; }

  }

</style>

</head>

<body>



  <div class="header">

    <h2>🍽 OSHXONA</h2>

    <div class="rest">${escapeHtml(restName)}</div>

  </div>



  <hr class="sep">



  <div class="meta-row"><span>📋 ${t("order_label", "Buyurtma")}:</span> <b>${escapeHtml(String(orderNum))}</b></div>

  <div class="meta-row"><span>🪑 ${t("table_label", "Stol")}:</span> <b>${escapeHtml(String(tableNum))}</b></div>

  <div class="meta-row"><span>🕐 ${t("time_label", "Vaqt")}:</span> <b>${createdAt}</b></div>

  ${isFast ? `<div style="text-align:center;margin-top:4px;"><span class="badge-fast">⚡ TEZKOR</span></div>` : ""}



  <hr class="sep">



  <table>${itemsHtml}</table>



  <hr class="sep-thin">



  ${note ? `<div class="note-block">📝 ${t("client_note", "Izoh")}: ${escapeHtml(note)}</div>` : ""}

  ${allergyNote}



  <hr class="sep">



  <div class="footer">

    👨‍🍳 ${escapeHtml(chefName)} &nbsp;|&nbsp; Nesta ERP

  </div>



</body>

</html>`;

}



function autoPrintKitchenOrder(orderId, order) {

  try {

    // Mavjud frame-ni tozalaymiz yoki yangi yasaymiz

    let frame = document.getElementById("__kitchenPrintFrame");

    if (!frame) {

      frame = document.createElement("iframe");

      frame.id = "__kitchenPrintFrame";

      frame.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:0;height:0;border:none;visibility:hidden;";

      document.body.appendChild(frame);

    }



    const html = buildKitchenReceiptHtml(orderId, order);

    const doc = frame.contentDocument || frame.contentWindow?.document;

    if (!doc) return;



    doc.open();

    doc.write(html);

    doc.close();



    // Brauzer kontenti yuklashini kutamiz, so'ng print

    frame.onload = () => {

      try {

        frame.contentWindow?.focus();

        frame.contentWindow?.print();

      } catch (err) {

        console.warn("Kitchen print error:", err);

      }

    };

  } catch (err) {

    console.error("autoPrintKitchenOrder error:", err);

  }

}



window.manualPrintOrder = function (orderId) {

  const order = window.allOrders?.[orderId];

  if (!order) { console.warn("Print: order not found", orderId); return; }

  autoPrintKitchenOrder(orderId, order);

};



function listenOrders() {

  if (window.listeners?.orders) {

    window.listeners.orders();

    window.listeners.orders = null;

  }



  const ordersRef = query(ref(db, BASE_PATH + "/orders"), orderByChild("createdAt"), limitToLast(500));



  window.listeners.orders = onValue(ordersRef, snap => {

    const incoming = snap.exists() ? (snap.val() || {}) : {};



    // Yangi buyurtmalarni aniqlaymiz

    if (_chefKnownOrderIds !== null) {

      const newIds = Object.keys(incoming).filter(id => !_chefKnownOrderIds.has(id));

      if (newIds.length > 0) {

        // Faqat "new" yoki "yangi" statusdagi orderlar uchun signal

        const reallyNew = newIds.filter(id => {

          const st = String(incoming[id]?.status || incoming[id]?.statusKey || "").toLowerCase();

          return ["new", "yangi", "pending", "queue", "order_created", ""].includes(st);

        });

        if (reallyNew.length > 0) {

          playNewOrderSound();

          reallyNew.forEach(id => {

            const o = incoming[id];

            showNotification(

              `🆕 ${t("new_order_arrived", "Yangi buyurtma")} — ${t("table_label", "Stol")} ${o.table || "?"} | #${o.orderNumber || id.slice(-4)}`

            );

            // 🖨️ Auto-print: sozlamalarda yoqilgan bo'lsa — oshxona chiptasini chiqar

            if (window.chefSettings?.autoPrint) {

              setTimeout(() => autoPrintKitchenOrder(id, o), 300);

            }

          });

        }

      }

    }

    // Birinchi yuklashda faqat ro'yxatni saqlaymiz (signal chiqarmaymiz)

    _chefKnownOrderIds = new Set(Object.keys(incoming));



    window.allOrders = incoming;

    allOrders = window.allOrders;



    if (typeof renderChefOrders === "function") {

      renderChefOrders();

    }



    if (typeof updateStatistics === "function") {

      updateStatistics();

    }



    updateKitchenRealtimeStats();

    updateNewOrdersBadge?.();

    loadKitchenNotifications?.();



    const hasQueueOrders = Object.values(window.allOrders || {}).some(o =>

      ["queue", "new", "yangi"].includes(normalizeText(o.status || o.statusKey)) && !o.chefId

    );

    if (hasQueueOrders && typeof assignNextFromQueue === "function") {

      assignNextFromQueue().catch(err => console.error(t("queue_error_log", "Queue error:"), err));

    }

  });

}

// ══════════════════════════════════════════════════════════════════
// 🔄 BUYURTMA O'ZGARTIRISH SO'ROVLARI — Admin/Kassir tasdiqlagan bekor
// qilish/almashtirish oshxonaga YETIB BORISHI kerak (item 17), lekin
// listenOrders() yuqoridagi "yangi buyurtma" signali FAQAT yangi orderId
// paydo bo'lganda ishlaydi — item o'zgarishi (order.items ustida) buni
// qayta ishga tushirmaydi (order allaqachon _chefKnownOrderIds'da).
// Shuning uchun alohida, kichik listener: faqat status "approved"ga
// o'tganda va bu order oshxona allaqachon ko'rgan bo'lsa — ovoz+toast
// signali beradi. Yangi parallel oshxona workflow YARATILMADI — mavjud
// playNewOrderSound()/showNotification() qayta ishlatildi.
// ══════════════════════════════════════════════════════════════════
let _chefKnownApprovedOcrIds = null;

function listenOrderChangeRequestsForKitchen() {
  const _ocrDebug = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  if (_ocrDebug) console.log("[OCR-DIAG] listener init: chef orderChangeRequests");
  onValue(ref(db, BASE_PATH + "/orderChangeRequests"), snap => {
    if (_ocrDebug) console.log("[OCR-DIAG] listener callback: chef orderChangeRequests");
    const data = snap.exists() ? (snap.val() || {}) : {};

    if (_chefKnownApprovedOcrIds === null) {
      // Birinchi yuklashda faqat ro'yxatni saqlaymiz — sahifa ochilganda
      // eski (allaqachon approved) so'rovlar uchun signal berilmaydi.
      _chefKnownApprovedOcrIds = new Set(
        Object.entries(data).filter(([, r]) => r.status !== "pending").map(([id]) => id)
      );
      return;
    }

    Object.entries(data).forEach(([id, r]) => {
      if (r.status !== "approved" || _chefKnownApprovedOcrIds.has(id)) return;
      _chefKnownApprovedOcrIds.add(id);

      // Faqat oshxona ALLAQACHON bilgan buyurtma uchun ogohlantiramiz —
      // yangi (hali chizilmagan) buyurtma o'zining "yangi buyurtma"
      // signali orqali allaqachon xabar beradi (listenOrders() yuqorida).
      if (!(_chefKnownOrderIds && _chefKnownOrderIds.has(r.orderId))) return;

      if (typeof playNewOrderSound === "function") playNewOrderSound();

      const oldName = getItemDisplayName(r.oldItem?.name, "");
      const label = r.requestType === "cancel_item"
        ? `⚠️ ${t("oc_cancel_item_title", "Taomni bekor qilish")}: ${oldName} ×${r.requestedCancelQty || ""}`
        : `⚠️ ${t("oc_replace_item_title", "Taomni almashtirish")}: ${oldName} → ${getItemDisplayName(r.newItem?.name, "")}`;

      if (typeof showNotification === "function") showNotification(label);
    });
  });
}



function listenOrderChats() {

  if (window.listeners?.orderChats) window.listeners.orderChats();

  window.listeners.orderChats = onValue(ref(db, BASE_PATH + "/orderChats"), snap => {

    const allChats = snap.val() || {};

    const nextChats = {};

    const myChefId = String(currentChefId || "").trim();

    const selectedChef = getSelectedChef();

    Object.entries(allChats).forEach(([orderId, rooms]) => {

      const chefRoom = rooms?.chef || {};

      const meta = chefRoom?.meta || {};

      const order = allOrders?.[orderId] || null;

      const assignedChefId = String(order?.chefId || meta.targetId || "").trim();

      if (!assignedChefId) return;

      if (selectedChef !== "all" && assignedChefId !== String(selectedChef).trim()) return;

      const messages = Object.entries(chefRoom?.messages || {}).map(([id, msg]) => ({ id, ...msg })).sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));

      nextChats[orderId] = { meta, messages };

    });

    window.orderChatsByOrder = nextChats;

    lastOrdersSignature = "";

    renderChefOrders();

  });

}



function listenChefChats() {

  if (window.listeners?.chefChats) window.listeners.chefChats();

  window.listeners.chefChats = onValue(ref(db, BASE_PATH + "/chats/admin_chef_" + currentChefId), snap => {

    const chatData = snap.val() || {};

    const messages = Object.entries(chatData?.messages || {})

      .map(([id, msg]) => ({ id, ...msg }))

      .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));

    window.chefChats = { [PERSONAL_CHEF_ROOM]: { meta: { ...(chatData?.meta || {}), targetId: currentChefId }, messages } };

    currentChefChatRoom = PERSONAL_CHEF_ROOM;

    localStorage.setItem("chefChatRoom", currentChefChatRoom);

    renderChefChatRooms();

    renderChefChatMessages();

  });

}



function listenTableStates() {

  if (window.listeners?.tables) window.listeners.tables();

  window.listeners.tables = onValue(ref(db, BASE_PATH + "/tables"), snap => { window.tableStates = snap.val() || {} });

}



function listenMyStatus() {

  if (!currentChefId) return;

  if (window.listeners?.myStatus) window.listeners.myStatus();



  window.listeners.myStatus = onValue(ref(db, BASE_PATH + "/users/" + currentChefId), snap => {

    const user = snap.val();

    chefActive = user ? user.active !== false : true;

  });

}



function listenOrderTimelines() {

  if (window.listeners?.timelines) window.listeners.timelines();

  window.listeners.timelines = onValue(ref(db, BASE_PATH + "/orderTimeline"), snap => { window.orderTimelines = snap.val() || {}; const modal = document.getElementById("chefDetailModal"); if (modal?.style.display === "flex") { const currentOrderId = document.getElementById("chefDetailContent")?.dataset?.orderId; if (currentOrderId && allOrders?.[currentOrderId]) renderChefOrderDetail(currentOrderId, allOrders[currentOrderId]); } });

}



function listenActivityLogs() {

  if (window.listeners?.logs) window.listeners.logs();

  window.listeners.logs = onValue(ref(db, BASE_PATH + "/activityLogs"), snap => {

    const rows = Object.entries(snap.val() || {}).map(([id, row]) => ({ id, ...row }));

    window.kitchenAuditLogs = rows.filter(row => String(row.module || "").toLowerCase() === "kitchen" || String(row.userRole || "").toLowerCase() === "chef");

    renderKitchenActionLog();

  });

}



function listenStopList() {

  if (window.listeners?.stopList) window.listeners.stopList();

  window.listeners.stopList = onValue(ref(db, BASE_PATH + "/stopList"), snap => {

    window.stopList = snap.val() || {};

    renderStopList();

    loadKitchenNotifications();

  });

}



function renderKitchenActionLog() {

  const root = document.getElementById("kitchenAuditList");

  if (!root) return;

  const logs = [...(window.kitchenAuditLogs || [])].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, 30);

  root.innerHTML = `<div class="chef-widget-head">📜 ${t("kitchen_log", "Kitchen log")}</div><div class="chef-widget-body">${logs.length ? logs.map(log => `<div class="chef-chat-message other"><div class="chef-chat-text">${escapeHtml(log.action || "event")}${(log.payload?.orderId || log.target) ? ` • #${escapeHtml(log.payload?.orderId || log.target)}` : ""}</div><div class="chef-chat-meta">${escapeHtml(log.userName || log.actorName || "system")} • ${formatDateTime(log.createdAt)}</div></div>`).join("") : `<div class="chef-chat-empty">${t("no_kitchen_log", "Kitchen log yo'q")}</div>`}</div>`;

}



async function assignNextFromQueue() {

  if (!allOrders || !window.allChefs) return;

  const activeChefs = Object.entries(window.allChefs).filter(([_, chef]) => chef.active !== false);

  if (activeChefs.length === 0) return;



  const queueOrders = Object.entries(allOrders)

    .filter(([_, o]) => ["queue", "new", "yangi"].includes(normalizeText(o.status || o.statusKey)) && !o.chefId)

    .sort((a, b) => Number(a[1].queuedAt || a[1].createdAt || 0) - Number(b[1].queuedAt || b[1].createdAt || 0));



  if (queueOrders.length === 0) return;



  // ── KATEGORIYAGA ASOSLANGAN TARQATISH ──────────────────────────────────────

  for (const [orderId, order] of queueOrders) {



    // 1️⃣ Buyurtmadagi taomlarning kategoriya va stansiyalarini aniqlash

    const orderCategories = new Set(

      Object.values(order.items || {}).map(item => {

        const menu = window.allMenu?.[item.menuId || item.id || item.itemId];

        return menu?.category || null;

      }).filter(Boolean)

    );

    const orderStations = new Set(

      Object.values(order.items || {}).map(item => {

        const menu = window.allMenu?.[item.menuId || item.id || item.itemId];

        return menu?.kitchenStation ? normalizeText(menu.kitchenStation) : null;

      }).filter(Boolean)

    );



    // 2️⃣ Stansiyaga yoki kategoriyaga mos faol oshpazlarni topish

    //    Oshpazning barcha tanlangan bo'limlari (kitchenStation + chefCategories

    //    massivi birlashtirilib) bitta ro'yxatga yig'iladi va OR-mantiqda

    //    tekshiriladi: shu ro'yxatdagi BIRON bo'limdan kelgan taom bo'lsa,

    //    oshpaz mos hisoblanadi. "general" tanlagan oshpazlar hamma buyurtmani oladi.

    const matchingChefs = activeChefs.filter(([_, chef]) => {

      const stationFromSingle = chef.kitchenStation ? [normalizeText(chef.kitchenStation)] : [];

      const stationsFromArray = Array.isArray(chef.chefCategories)

        ? chef.chefCategories.map(c => normalizeText(c))

        : [];

      const chefStations = [...new Set([...stationFromSingle, ...stationsFromArray])];



      if (chefStations.includes("general") || chefStations.length === 0) return true;

      if (orderStations.size === 0 && orderCategories.size === 0) return true; // ma'lumot yo'q — hammaga ochiq



      const matchesStation = [...orderStations].some(st => chefStations.includes(st));

      const matchesCategory = [...orderCategories].some(cat => chefStations.includes(normalizeText(cat)));

      return matchesStation || matchesCategory;

    });



    if (matchingChefs.length === 0) continue;



    // 3️⃣ Fast-food kategoriyasidagi oshpazlar 2+ bo'lsa → bosh oshpazga

    const FAST_FOOD_CAT = "fast-food";

    const hasFastFood = [...orderCategories].some(cat =>

      String(cat).toLowerCase().replace(/[\s_]/g, "-") === FAST_FOOD_CAT ||

      String(cat).toLowerCase().includes("fast")

    );



    const fastFoodChefs = matchingChefs.filter(([_, chef]) => {

      const cats = [

        ...(Array.isArray(chef.chefCategories) ? chef.chefCategories : []),

        ...(chef.kitchenStation ? [chef.kitchenStation] : [])

      ];

      return cats.some(c => String(c).toLowerCase().replace(/[\s_]/g, "-") === FAST_FOOD_CAT

        || String(c).toLowerCase().includes("fast"));

    });



    let selectedChefId = null;



    if (hasFastFood && fastFoodChefs.length >= 2) {

      // Fast-food 2+ oshpaz → bosh oshpaz (isHeadChef: true) ni topamiz

      const headChef = fastFoodChefs.find(([_, chef]) => chef.isHeadChef === true);

      if (headChef) {

        selectedChefId = headChef[0];

      }

    }



    // 4️⃣ Bosh oshpaz tanlilmasa yoki fast-food sharti yo'q → yuk (load) bo'yicha

    if (!selectedChefId) {

      const loads = matchingChefs.map(([id]) => {

        const count = Object.values(allOrders).filter(o =>

          String(o.chefId) === String(id) &&

          ["new", "approved", "cooking"].includes(normalizeKitchenStatus(o.status))

        ).length;

        return { id, count };

      }).sort((a, b) => a.count - b.count);

      selectedChefId = loads[0]?.id;

    }



    if (!selectedChefId) continue;



    await update(ref(db, `${BASE_PATH}/orders/${orderId}`), {

      chefId: selectedChefId,

      status: "new",

      statusKey: "new",

      assignedAt: Date.now(),

      updatedAt: Date.now()

    });

  }

}



/* =========================

   SETTINGS

========================= */

const DEFAULT_CHEF_SETTINGS = { soundEnabled: true, autoPrint: false, compactMode: false, defaultFilter: "all", highlightLateOrders: true, kitchenMonitorEnabled: false, kitchenMonitorCount: 1 };

async function loadChefSettings() {

  const restId = localStorage.getItem("restaurantId");

  const [globalSnap, localSnap, restKitchenSnap] = await Promise.all([

    get(ref(db, "settings/kitchenDefaults")),

    get(ref(db, `chefSettings/${currentChefId}`)),

    restId ? get(ref(db, `restaurants/${restId}/settings/kitchenDefaults`)) : Promise.resolve(null),

  ]);

  const globalDefaults = globalSnap.exists() ? globalSnap.val() : {};

  const localOverrides = localSnap.exists() ? localSnap.val() : {};

  // Restoranga bog'langan Kitchen Monitor sozlamasi (admin panelidagi

  // "Oshxona monitoridan foydalanish" toggle) — mavjud bo'lsa, faqat shu

  // ikki maydonni ustuvor qiladi, qolgan sozlamalar (autoPrint va h.k.)

  // avvalgidek global/shaxsiy manbadan olinadi.

  const restKitchenDefaults = restKitchenSnap && restKitchenSnap.exists() ? restKitchenSnap.val() : {};

  const kitchenMonitorOverride = {};

  if (restKitchenDefaults.kitchenMonitorEnabled !== undefined) {

    kitchenMonitorOverride.kitchenMonitorEnabled = restKitchenDefaults.kitchenMonitorEnabled;

  }

  if (restKitchenDefaults.kitchenMonitorCount !== undefined) {

    kitchenMonitorOverride.kitchenMonitorCount = restKitchenDefaults.kitchenMonitorCount;

  }

  window.chefSettings = { ...DEFAULT_CHEF_SETTINGS, ...globalDefaults, ...localOverrides, ...kitchenMonitorOverride };

  document.body.classList.toggle("compact-mode", !!window.chefSettings.compactMode);

  return window.chefSettings;

}



window.saveChefSettings = async function (patch = {}) {

  window.chefSettings = { ...DEFAULT_CHEF_SETTINGS, ...(window.chefSettings || {}), ...(patch || {}) };

  localStorage.setItem("chefSettings", JSON.stringify(window.chefSettings));

  await set(ref(db, `chefSettings/${currentChefId}`), window.chefSettings);

  document.body.classList.toggle("compact-mode", !!window.chefSettings.compactMode);

  renderKitchenStats();

  renderKitchenNotifications();

  showChefNotification(t("settings_saved", "⚙️ Settings saved"));

};



// ══════════════════════════════════════════════════════

// 🖥️ OSHXONA MONITORI REJIMI (faqat ko'rish)

// Admin "Oshxona monitoridan foydalanish"ni yoqsa, oshpaz

// login qilgach "Ishchi rejim" / "Monitor rejimi"ni tanlaydi.

// Monitor rejimida status-o'zgartiruvchi tugmalar yashiriladi,

// buyurtmalar faqat o'qish uchun ko'rsatiladi.

// ══════════════════════════════════════════════════════



window.isKitchenMonitorAvailable = function () {

  return !!(window.chefSettings && window.chefSettings.kitchenMonitorEnabled === true);

};



window.isChefMonitorMode = function () {

  if (!window.isKitchenMonitorAvailable()) return false;

  return localStorage.getItem("chefViewMode") === "monitor";

};



window.setChefViewMode = function (mode) {

  const finalMode = (mode === "monitor" && window.isKitchenMonitorAvailable()) ? "monitor" : "work";

  localStorage.setItem("chefViewMode", finalMode);

  document.body.classList.toggle("monitor-mode", finalMode === "monitor");

  window.closeChefModeModal?.();

  if (typeof window.renderChefOrders === "function") window.renderChefOrders();

  window.updateChefModeBadge?.();

};



// Rejim tanlash oynasi va header belgisi (badge) so'rov bo'yicha olib

// tashlandi — oshpaz interfeysi endi doim "ishchi rejim"da ishlaydi.

// Funksiyalar bo'sh no-op sifatida qoldirilgan (boshqa joydagi chaqiruvlar

// xato bermasligi uchun), monitor-mode CSS klassi hech qachon qo'yilmaydi.

window.maybeShowChefModeModal = function () {

  localStorage.removeItem("chefViewMode");

  document.body.classList.remove("monitor-mode");

};



window.closeChefModeModal = function () { };



window.updateChefModeBadge = function () {

  document.getElementById("chefModeBadge")?.remove();

};



window.maybeShowChefModeModalForced = function () { };



window.toggleKitchenSound = async () => window.saveChefSettings({ soundEnabled: !window.chefSettings?.soundEnabled });

window.toggleAutoPrint = async () => {

  await window.saveChefSettings({ autoPrint: !window.chefSettings?.autoPrint });

  syncAutoPrintUI();

};



// Header tugmasi va settings checkbox-ni sinxron ushlab turadi

function syncAutoPrintUI() {

  const isOn = !!window.chefSettings?.autoPrint;

  const btn = document.getElementById("autoPrintHeaderBtn");

  if (btn) btn.classList.toggle("print-active", isOn);

  const cb = document.getElementById("chefToggleAutoPrint");

  if (cb) cb.checked = isOn;

}

window.syncAutoPrintUI = syncAutoPrintUI;



// Header tugmasidan toggle

window.toggleAutoPrintHeader = async function () {

  await window.saveChefSettings({ autoPrint: !window.chefSettings?.autoPrint });

  syncAutoPrintUI();

  const isOn = !!window.chefSettings?.autoPrint;

  if (typeof showNotification === "function") {

    showNotification(isOn

      ? "\uD83D\uDDA8\uFE0F Auto Print yoqildi \u2705"

      : "\uD83D\uDDA8\uFE0F Auto Print o\u02BBchirildi \u26D4"

    );

  }

};

window.toggleCompactMode = async () => window.saveChefSettings({ compactMode: !window.chefSettings?.compactMode });

window.setDefaultKitchenFilter = async (value = "all") => { await window.saveChefSettings({ defaultFilter: value || "all" }); localStorage.setItem("chefStatusFilter", value || "all"); refreshUI(); };



/* =========================

   DETAIL MODAL (Tarjima ulangan)

========================= */

function renderChefOrderDetail(orderId, order) {

  const detail = document.getElementById("chefDetailContent");

  if (!detail || !order) return;

  detail.dataset.orderId = orderId;

  const status = normalizeKitchenStatus(getOrderStatus(order));

  const chefName = getAssignedChefName(orderId, order);

  const total = Object.values(order?.items || {}).reduce((sum, item) => { const menu = getOrderItemMenu(item) || {}; const price = Number(item?.price || menu?.price || 0); return sum + (price * Number(item?.qty || 1)); }, 0);



  detail.innerHTML = `

    <div class="chef-detail-grid">

      <div class="chef-detail-card">

        <h4>${t("basic_info", "Asosiy ma'lumot")}</h4>

        <div><b>${t("order", "Order ID")}:</b> #${escapeHtml(orderId)}</div>

        <div><b>${t("table", "Stol")}:</b> ${escapeHtml(order?.table || "-")}</div>

        <div><b>${t("order_status", "Status")}:</b> ${escapeHtml(t("status_" + status) || status)}</div>

        <div><b>${t("chef_label", "Chef")}:</b> ${escapeHtml(chefName)}</div>

        <div><b>${t("created_at", "Yaratildi")}:</b> ${formatDateTime(order?.createdAt)}</div>

        <div><b>${t("total_label", "Total")}:</b> ${formatMoney(total)}</div>

      </div>

      <div class="chef-detail-card">

        <h4>${t("special_request_label", "Special instructions")}</h4>

        ${renderOrderSpecialInstructions(order)}

      </div>

      <div class="chef-detail-card">

        <h4>${t("items_label", "Items")}</h4>

        ${renderOrderItemsDetailed(orderId, order)}

        <div class="chef-detail-actions">

          <button type="button" onclick="acceptOrder('${escapeJsString(orderId)}')">✅ ${t("approve", "Accept")}</button>

          <button type="button" onclick="startCooking('${escapeJsString(orderId)}')">🔥 ${t("status_cooking", "Start")}</button>

          <button type="button" onclick="markOrderReady('${escapeJsString(orderId)}')">🍽 ${t("status_ready", "Ready")}</button>

        </div>

      </div>

    </div>`;

}



function renderOrderSpecialInstructions(order) {

  const parts = [];

  if (order?.clientRequest) parts.push(`<div>📝 <b>${t("client_note", "Mijoz izohi:")}</b> ${escapeHtml(order.clientRequest)}</div>`);

  if (order?.allergyNote) parts.push(`<div>⚠️ <b>${t("allergy_note", "Allergiya:")}</b> ${escapeHtml(translateAllergyNote(order.allergyNote))}</div>`);

  if (order?.specialNote) parts.push(`<div>📌 <b>${t("special_note", "Special note:")}</b> ${escapeHtml(order.specialNote)}</div>`);

  if (order?.reservationNote) parts.push(`<div>📅 <b>${t("reservation_note", "Reservation note:")}</b> ${escapeHtml(order.reservationNote)}</div>`);

  return parts.length ? parts.join("") : `<div class="detail-empty">${t("no_extra_note", "Qo'shimcha izoh yo'q")}</div>`;

}



function renderOrderTimeline(orderId) {

  const rows = Object.entries(window.orderTimelines?.[orderId] || {}).map(([id, row]) => ({ id, ...row })).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  if (!rows.length) return `<div class="detail-empty">${t("no_timeline", "Timeline yo'q")}</div>`;

  return rows.map(row => `<div class="timeline-row"><div><b>${escapeHtml(row?.eventType || "event")}</b></div><small>${formatDateTime(row?.createdAt)}</small><div>${escapeHtml(row?.actorName || "system")}</div></div>`).join("");

}



window.openChefOrderDetail = function (orderId) { ensureChefEnhancementLayout(); const modal = document.getElementById("chefDetailModal"); const order = allOrders?.[orderId]; if (!modal || !order) return; renderChefOrderDetail(orderId, order); modal.style.display = "flex"; };



window.closeChefOrderDetail = function () {

  const modal = document.getElementById("chefDetailModal");

  if (modal) {

    modal.style.display = "none";

    document.body.style.overflow = "auto";

  }

};



/* =========================

   STATS UI / REFRESH

========================= */

function calculateKitchenStats() {

  const orders = window.allOrders || allOrders || {};

  const entries = Object.entries(orders);

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

  const todayStart = startOfDay.getTime();



  const stats = { total: entries.length, newOrders: 0, cooking: 0, ready: 0, delayed: 0, avgPrepMinutes: 0, completedToday: 0 };

  let completedCount = 0, totalCompletedMinutes = 0;



  entries.forEach(([_, order]) => {

    const status = getOrderStatus(order);

    const normalizedStatus = normalizeKitchenStatus(status);



    if (["new", "approved"].includes(normalizedStatus)) stats.newOrders += 1;

    if (normalizedStatus === "cooking") stats.cooking += 1;

    if (normalizedStatus === "ready") stats.ready += 1;

    if (getRemainingInfo(order).delayed) stats.delayed += 1;



    // Bugungi tugallangan buyurtmalar (ready yoki closed)

    const finishedAt = Number(order?.finishedAt || 0);

    const createdAt = Number(order?.createdAt || 0);

    const isToday = createdAt >= todayStart || finishedAt >= todayStart;

    if (isToday && ["ready", "closed"].includes(normalizedStatus)) {

      stats.completedToday += 1;

    }



    const duration = getOrderWaitDuration(order);

    if (duration > 0 && finishedAt > 0) {

      completedCount += 1;

      totalCompletedMinutes += Math.round(duration / 60000);

    }

  });



  stats.avgPrepMinutes = completedCount ? Math.round(totalCompletedMinutes / completedCount) : 0;

  return stats;

}

function calculateChefOwnStats() { return calculateAllStats?.()[currentChefId] || { active: 0, fast: 0, normal: 0, ready: 0, total: 0, totalWorkMinutes: 0, delayed: 0, loadPercent: 0 }; }

function renderKitchenStats() {

  const stats = calculateKitchenStats();



  // ① Header kartochkalarini yangilash (rasmda ko'rinadi)

  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };



  setEl("statNewOrders", stats.newOrders);

  setEl("statCooking", stats.cooking);

  setEl("statReady", stats.ready);

  setEl("statDelayed", stats.delayed);

  setEl("statAvgPrepMinutes", stats.avgPrepMinutes ? `${stats.avgPrepMinutes} ${t("minute_short", "min")}` : `0 ${t("minute_short", "min")}`);

  setEl("statCompletedToday", stats.completedToday);



  // data-stat attribute orqali ham qo'llab-quvvatlash

  document.querySelectorAll("[data-stat]").forEach(el => {

    const key = el.dataset.stat;

    if (key === "new") el.textContent = stats.newOrders;

    if (key === "cooking") el.textContent = stats.cooking;

    if (key === "ready") el.textContent = stats.ready;

    if (key === "delayed") el.textContent = stats.delayed;

    if (key === "avg") el.textContent = `${stats.avgPrepMinutes} ${t("minute_short", "min")}`;

    if (key === "today") el.textContent = stats.completedToday;

  });



  const root = document.getElementById("chefsTodayStats");

  if (root) {

    const cardHtml = (typeof renderChefPerformanceCard === "function") ? renderChefPerformanceCard() : "";

    root.innerHTML = `

      <div class="kitchen-stats-grid">

        <div class="stat-card"><b>🆕 ${t("new_label", "Yangi")}</b><span>${stats.newOrders}</span></div>

        <div class="stat-card"><b>🔥 ${t("cooking_label", "Pishirilmoqda")}</b><span>${stats.cooking}</span></div>

        <div class="stat-card"><b>✅ ${t("ready_label", "Tayyor")}</b><span>${stats.ready}</span></div>

        <div class="stat-card"><b>🚨 ${t("delayed_label", "Kechikkan")}</b><span>${stats.delayed}</span></div>

        <div class="stat-card"><b>⏱ ${t("avg_prep_label", "O'rtacha vaqt")}</b><span>${stats.avgPrepMinutes} ${t("minute_short", "min")}</span></div>

        <div class="stat-card"><b>📦 ${t("today_label", "Bugun")}</b><span>${stats.completedToday}</span></div>

      </div>`;

  }

}



function renderChefPerformanceCard() {

  const mine = calculateChefOwnStats();



  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  setEl("myLoad", mine.active);

  setEl("myReadyCount", mine.ready);

  setEl("myWorkTime", `${mine.totalWorkMinutes} ${t("minute_short", "min")}`);



  document.querySelectorAll("[data-mystat]").forEach(el => {

    const key = el.dataset.mystat;

    if (key === "load") el.textContent = mine.active;

    if (key === "ready") el.textContent = mine.ready;

    if (key === "time") el.textContent = `${mine.totalWorkMinutes} ${t("minute_short", "min")}`;

  });

}



window.updateStatistics = updateStatistics;

window.calculateAllStats = calculateAllStats;



/* =========================

   COOKING PERFORMANCE BOX (#chefStatsBox)

========================= */

function renderChefStatsBox() {

  const box = document.getElementById("chefStatsBox");

  if (!box) return;



  const stats = calculateKitchenStats();

  const mine = calculateChefOwnStats();



  // Labels (i18n-aware)

  const labelToday = t("today_label", "Bugun");

  const labelAvg = t("avg_prep_label", "O'rtacha");

  const labelMin = t("minute_short", "min");

  const labelTitle = t("cooking_performance", "Cooking Performance");

  const labelDishes = t("dishes_label", "ta taom");

  const labelActive = t("active_orders_title", "Faol");

  const labelDelayed = t("delayed_label", "Kechikkan");



  const todayCount = stats.completedToday;

  const avgMin = stats.avgPrepMinutes || 0;

  const activeCount = stats.cooking + stats.newOrders;

  const delayedCount = stats.delayed;



  const avgColor = avgMin === 0 ? "#6b7280"

    : avgMin <= 15 ? "#22c55e"

      : avgMin <= 25 ? "#f59e0b"

        : "#ef4444";



  const delayedColor = delayedCount === 0 ? "#22c55e" : "#ef4444";



  box.innerHTML = `

    <style>

      #chefStatsBox {

        display: flex;

        align-items: center;

        gap: 6px;

        padding: 6px 14px;

        background: #fff;

        border-bottom: 1px solid rgba(255,255,255,0.06);

        flex-wrap: wrap;

        font-family: 'Plus Jakarta Sans', sans-serif;

      }

      .csb-label {

        font-size: 11px;

        font-weight: 700;

        color: #475569;

        text-transform: uppercase;

        letter-spacing: 0.6px;

        margin-right: 2px;

        white-space: nowrap;

      }

      .csb-chip {

        display: inline-flex;

        align-items: center;

        gap: 5px;

        padding: 3px 10px;

        border-radius: 20px;

        font-size: 13px;

        font-weight: 700;

        line-height: 1;

        white-space: nowrap;

        border: 1px solid rgba(255,255,255,0.08);

      }

      .csb-chip-today {

        background: rgba(59,130,246,0.12);

        color: #93c5fd;

        border-color: rgba(59,130,246,0.3);

      }

      .csb-chip-avg {

        background: rgba(34,197,94,0.10);

        border-color: rgba(34,197,94,0.25);

      }

      .csb-chip-active {

        background: rgba(251,146,60,0.10);

        color: #fdba74;

        border-color: rgba(251,146,60,0.25);

      }

      .csb-chip-delayed {

        background: rgba(239,68,68,0.10);

        border-color: rgba(239,68,68,0.25);

      }

      .csb-sep {

        width: 1px;

        height: 18px;

        background: rgba(255,255,255,0.08);

        flex-shrink: 0;

      }

      @media (max-width:520px) {

        #chefStatsBox { padding: 5px 10px; gap: 5px; }

        .csb-label { display: none; }

        .csb-chip  { font-size: 12px; padding: 3px 8px; }

      }

    </style>



    <span class="csb-label">${labelTitle}</span>

    <span class="csb-sep"></span>



    <span class="csb-chip csb-chip-avg" style="color:${avgColor}" title="${labelAvg}">

      ⏱ ${labelAvg} <span id="csbAvg">${avgMin}</span> ${labelMin}

    </span>



    <span class="csb-chip csb-chip-active" title="${labelActive}">

      🔥 <span id="csbActive">${activeCount}</span>

    </span>



    <span class="csb-chip csb-chip-delayed" style="color:${delayedColor}" title="${labelDelayed}">

      🚨 <span id="csbDelayed">${delayedCount}</span>

    </span>

  `;

}

window.renderChefStatsBox = renderChefStatsBox;



function updateKitchenRealtimeStats() { renderKitchenStats(); renderChefStatsBox(); if (typeof updateStatistics === "function") updateStatistics(); }

function applyStaticTranslations() {

  document.querySelectorAll("[data-i18n]").forEach(el => { const key = el.dataset.i18n; if (key) el.textContent = t(key); });

  document.querySelectorAll("[data-i18n-title]").forEach(el => { const key = el.dataset.i18nTitle; if (key) el.title = t(key); });

  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => { const key = el.dataset.i18nPlaceholder; if (key) el.placeholder = t(key); });

  document.title = t("chef_document_title", `Nesta ERP — ${t("chef_page_title", "Oshpaz paneli")}`);

}

function applyChefPageTranslations() { applyStaticTranslations(); updateChefFullscreenButton(); renderKitchenStats(); renderChefStatsBox(); renderKitchenNotifications(); renderStopList(); renderKitchenActionLog(); renderCategoryFilter?.(); renderSubFilter?.(getSelectedCategory?.() || "all"); renderChefFilters(); }

function renderChefFilters() {

  ensureChefEnhancementLayout();

  const statusEl = document.getElementById("chefStatusFilter"), tableEl = document.getElementById("chefTableFilter"), searchEl = document.getElementById("chefSearchInput");

  if (statusEl) {

    const savedVal = localStorage.getItem("chefStatusFilter") || window.chefSettings?.defaultFilter || "all";

    statusEl.innerHTML = `

      <option value="all">${t("all_statuses", "Barcha statuslar")}</option>

      <option value="new">${t("status_new", "Yangi")}</option>

      <option value="accepted">${t("status_approved", "Tasdiqlangan")}</option>

      <option value="cooking">${t("status_cooking", "Tayyorlanmoqda")}</option>

      <option value="ready">${t("status_ready", "Tayyor")}</option>

      <option value="delayed">${t("delayed_order", "Kechikkan")}</option>

      <option value="mine">${t("my_orders", "Mening orderlarim")}</option>

    `;

    statusEl.value = savedVal;

  }

  if (tableEl) {

    tableEl.placeholder = t("table_number_placeholder", "Stol raqami...");

    tableEl.value = localStorage.getItem("chefTableFilter") || "";

  }

  if (searchEl) {

    searchEl.placeholder = t("search_order_food", "Order / taom / note qidirish...");

    searchEl.value = localStorage.getItem("chefSearch") || "";

  }

}



window.renderChefOrders = function () {

  const activeContainer = document.getElementById("chefOrders");

  const readyContainer = document.getElementById("readyOrders");

  if (!activeContainer || !readyContainer) return;



  activeContainer.innerHTML = '';

  readyContainer.innerHTML = '';



  const visibleEntries = getChefVisibleOrders();

  renderChefTVStatsBar(visibleEntries);



  if (visibleEntries.length === 0) {

    activeContainer.innerHTML = `<p class="empty-state">${t("no_orders", "Hozircha buyurtmalar kelmadi...")}</p>`;

    readyContainer.innerHTML = `<p class="empty-state">${t("no_ready_orders", "Tayyor buyurtmalar yo'q")}</p>`;

    return;

  }



  let hasActive = false;

  let hasReady = false;



  visibleEntries.forEach(([orderId, order]) => {

    const status = normalizeKitchenStatus(order.status || order.statusKey || 'new');



    if (['new', 'approved', 'cooking'].includes(status)) {

      const card = buildChefOrderCard(orderId, order, false);

      if (card) { activeContainer.appendChild(card); hasActive = true; }

    } else if (status === 'ready') {

      const card = buildChefOrderCard(orderId, order, true);

      if (card) { readyContainer.appendChild(card); hasReady = true; }

    }

  });



  if (!hasActive) {

    activeContainer.innerHTML = `<p class="empty-state">${t("no_active_matches", "Mos faol buyurtmalar topilmadi")}</p>`;

  }

  if (!hasReady) {

    readyContainer.innerHTML = `<p class="empty-state">${t("no_ready_matches", "Mos tayyor buyurtmalar topilmadi")}</p>`;

  }

};



const renderChefOrders = window.renderChefOrders;



function renderChefTVStatsBar(visibleEntries) {

  const bar = document.getElementById("chefTVStatsBar");

  if (!bar) return;



  let total = 0, cooking = 0, ready = 0, fast = 0, delayed = 0;

  const now = Date.now();



  visibleEntries.forEach(([, order]) => {

    const status = normalizeKitchenStatus(order.status || order.statusKey || 'new');

    if (!['new', 'approved', 'cooking', 'ready'].includes(status)) return;

    total++;

    if (status === 'cooking') cooking++;

    if (status === 'ready') ready++;

    if (isFastOrder(order)) fast++;

    const readyAtVal = Number(order.readyAt || 0);

    if (status === 'cooking' && readyAtVal && readyAtVal <= now) delayed++;

  });



  bar.innerHTML = `

    <div class="chef-tv-stat"><i class="fa-solid fa-clipboard-list"></i><div><span data-tv-label>${t("tv_stat_total", "JAMI BUYURTMALAR")}</span><b>${total}</b></div></div>

    <div class="chef-tv-stat"><i class="fa-solid fa-fire" style="color:#3b82f6;"></i><div><span data-tv-label>${t("tv_stat_cooking", "JARAYONDA")}</span><b style="color:#3b82f6;">${cooking}</b></div></div>

    <div class="chef-tv-stat"><i class="fa-solid fa-circle-check" style="color:#10b981;"></i><div><span data-tv-label>${t("tv_stat_ready", "TAYYOR")}</span><b style="color:#10b981;">${ready}</b></div></div>

    <div class="chef-tv-stat"><i class="fa-solid fa-bolt" style="color:#f59e0b;"></i><div><span data-tv-label>${t("tv_stat_fast", "FAST")}</span><b style="color:#f59e0b;">${fast}</b></div></div>

    <div class="chef-tv-stat"><i class="fa-solid fa-stopwatch" style="color:#ef4444;"></i><div><span data-tv-label>${t("tv_stat_delayed", "KECHIKKAN")}</span><b style="color:#ef4444;">${delayed}</b></div></div>`;

}



const KITCHEN_STATION_COLORS = {

  ks_soups: { bg: 'rgba(59,130,246,.14)', border: 'rgba(37,99,235,.30)', fg: '#1d4ed8' },

  ks_fastfood: { bg: 'rgba(249,115,22,.14)', border: 'rgba(234,88,12,.30)', fg: '#c2410c' },

  ks_desserts: { bg: 'rgba(168,85,247,.14)', border: 'rgba(147,51,234,.30)', fg: '#7e22ce' },

  ks_appetizers: { bg: 'rgba(120,53,15,.12)', border: 'rgba(120,53,15,.30)', fg: '#78350f' },

  ks_main_dishes: { bg: 'rgba(34,197,94,.14)', border: 'rgba(21,128,61,.30)', fg: '#15803d' },

  ks_side_dishes: { bg: 'rgba(34,197,94,.14)', border: 'rgba(21,128,61,.30)', fg: '#15803d' },

  ks_bakery: { bg: 'rgba(180,131,64,.14)', border: 'rgba(146,102,42,.30)', fg: '#92642a' },

  ks_drinks: { bg: 'rgba(14,165,233,.14)', border: 'rgba(2,132,199,.30)', fg: '#0369a1' },

  ks_combo: { bg: 'rgba(236,72,153,.14)', border: 'rgba(219,39,119,.30)', fg: '#be185d' },

  ks_special: { bg: 'rgba(234,179,8,.14)', border: 'rgba(202,138,4,.30)', fg: '#a16207' },

  ks_general: { bg: 'rgba(34,197,94,.14)', border: 'rgba(21,128,61,.30)', fg: '#15803d' }

};

const NEUTRAL_STATION_COLOR = { bg: 'rgba(148,163,184,.14)', border: 'rgba(100,116,139,.30)', fg: '#475569' };



function getCategoryColor(stationId) {

  if (!stationId) return NEUTRAL_STATION_COLOR;

  return KITCHEN_STATION_COLORS[stationId] || NEUTRAL_STATION_COLOR;

}



function renderChefItemNoteChip(note) {

  const text = String(note || '').trim();

  if (!text) return '';

  return `<span class="table-food-note-chip">${escapeHtml(text)}</span>`;

}



function buildChefOrderCard(orderId, order, isReady) {

  const div = document.createElement('div');



  const status = normalizeKitchenStatus(order.status || order.statusKey || '');

  const isCooking = status === 'cooking';

  // 🩹 STOL ? XATOSI — ROOT CAUSE: bu yerda ilgari `order.tableNo ||
  // order.table || '?'` ishlatilardi — delivery/takeaway buyurtmalarda
  // (stol yo'q) fallback har doim "?" bo'lib, kartada "STOL ?" ko'rinardi.
  // Endi shared.js'dagi CANONICAL normalizeOrderType()/ORDER_TYPE (bir xil
  // manba — admin/waiter/kassa/courier ham shu funksiyadan foydalanadi)
  // orqali haqiqiy order turi aniqlanadi: faqat DINE_IN bo'lib, HAQIQIY
  // (bo'sh/"?"/"-" bo'lmagan) stol qiymati mavjud bo'lsagina "STOL {N}"
  // ko'rsatiladi — stale/eski table maydoni (masalan avval boshqa stolda
  // yaratilib keyin delivery'ga aylantirilgan buyurtma) ustidan canonical
  // order type ustuvor bo'ladi.
  const _orderType = normalizeOrderType(order);
  const _rawTable = order.tableNo || order.table;
  const hasTable = _orderType === ORDER_TYPE.DINE_IN &&
    _rawTable !== undefined && _rawTable !== null && _rawTable !== "" &&
    _rawTable !== "?" && _rawTable !== "-";
  const tableNum = hasTable ? _rawTable : null;
  // Haqiqiy biznes buyurtma raqami (formatOrderNumber → order.orderNumber
  // asosida "ORD-4"/"DVR-7"), Firebase push-key EMAS. orderNumber
  // mavjud bo'lmagan juda eski buyurtmalarda ham ichki keyni to'liq
  // ko'rsatmaslik uchun faqat oxirgi 4 belgisi qoldiriladi (avvaldan
  // shunday edi — ushbu task doirasida o'zgartirilmadi).
  const orderNoText = escapeHtml(String(formatOrderNumber(order) || String(orderId).slice(-4)));



  const tvStatusClass = isCooking ? 'chef-tv-cooking' : (isReady ? 'chef-tv-ready' : 'chef-tv-new');

  div.className = `order-card chef-order-card ${isReady ? 'ready-card-style' : ''} ${tvStatusClass}`;



  let statusClass = 'status-new';

  let tableStatusText = t("status_busy", "YANGI 🔴");



  if (isCooking) {

    statusClass = 'status-cooking';

    tableStatusText = t("status_cooking_badge", "JARAYONDA 🟡");

  } else if (isReady) {

    statusClass = 'status-ready';

    tableStatusText = t("status_ready_badge", "TAYYOR 🟢");

  }



  let itemsHtml = '';

  if (order.items) {

    itemsHtml = Object.entries(order.items).map(([itemKey, item]) => {

      const menu = getOrderItemMenu(item) || {};

      const name = getTranslatedItemName(item, menu, currentLang);

      const itemImg = item.image || item.img || menu.imgUrl || menu.img || 'img/logo (2).svg';

      const stationId = menu.kitchenStation || item.kitchenStation || '';

      const stationLabel = getKitchenStationLabel(stationId);

      const catText = getCategoryLabel(menu.category || item.category || '');

      const subCatText = menu.subcategory ? ` / ${getSubcategoryLabel(menu.subcategory)}` : '';

      const catSubTextRaw = `${catText || ''}${subCatText || ''}`.trim();

      const fullCategory = catSubTextRaw || stationLabel || t("food_label", "Taom");

      const catColor = getCategoryColor(stationId);

      const qty = Number(item.qty || item.quantity || 1);

      const noteChip = renderChefItemNoteChip(item.note);

      const assignedChefNames = getAssignedChefNamesForItem(menu, item);

      const assignedChefText = assignedChefNames.length > 0

        ? assignedChefNames.join(", ")

        : t("chef_unassigned", "Oshpaz belgilanmagan");



      return `

        <div class="table-food-item">

          <div class="table-food-top">

            <img src="${escapeHtml(itemImg)}" alt="${escapeHtml(name)}"

                 style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex-shrink:0;"

                 onerror="this.src='img/logo (2).svg'">

            <span class="table-food-name" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(name)}</span>

            <span class="table-food-qty">×${qty}</span>

          </div>

          <div class="table-food-tags-row" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">

            <span class="table-food-category" style="background:${catColor.bg} !important;color:${catColor.fg} !important;border:1px solid ${catColor.border} !important;border-radius:999px !important;padding:2px 9px !important;font-size:10px !important;font-weight:700 !important;text-transform:none !important;letter-spacing:normal !important;white-space:nowrap !important;">${escapeHtml(fullCategory)}</span>

            ${noteChip}

          </div>

          <div class="table-food-chef-row" style="margin-top:4px;font-size:11px;color:#64748b;display:flex;align-items:center;gap:4px;">

            <i class="fa-solid fa-user-chef" style="font-size:10px;"></i>

            <span>${escapeHtml(assignedChefText)}</span>

          </div>

        </div>`;

    }).join('');

  }



  // ── vaqt kiritish bloki (yangi va cooking+vaqtsiz holatlarda) ──────────────

  function _timeInputBlock(fnName) {

    return `

      <div class="table-order-box">

        <div class="table-order-price" style="font-size:12px;color:#94a3b8;display:flex;align-items:center;gap:6px;">

          <i class="fa-solid fa-hourglass-half" style="color:#d97706;"></i>

          ${t("enter_ready_minutes", "Tayyor bo'lish vaqtini daqiqada kiriting")}

        </div>

        <div class="table-time-actions" style="padding:0 0 10px;">

          ${[5, 10, 15, 20, 30].map(m =>

      `<button type="button" onclick="document.getElementById('time-input-${escapeHtml(orderId)}').value=${m}">

              ${m} ${t("minute_short", "daq")}</button>`).join("")}

        </div>

        <div class="timer-not-set" style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">

          <i class="fa-solid fa-hourglass-start" style="flex-shrink:0;"></i>

          <input type="number" id="time-input-${escapeHtml(orderId)}"

            placeholder="${t("enter_ready_minutes", "Daqiqa kiriting")}" min="1" max="120"

            style="flex:1;background:transparent;border:none;color:inherit;font-size:17px;

            font-weight:700;outline:none;min-width:0;"

            onkeydown="if(event.key==='Enter'){window.${fnName}('${escapeJsString(orderId)}');}">

          <span style="font-size:12.5px;font-weight:600;flex-shrink:0;">${t("minute_short", "daq")}</span>

        </div>

        <button id="start-btn-${escapeHtml(orderId)}" class="status-ready"

          onclick="window.${fnName}('${escapeJsString(orderId)}')"

          style="width:100%;padding:12px;border:none;border-radius:12px;cursor:pointer;font-weight:800;font-size:14px;

          display:flex;align-items:center;justify-content:center;gap:9px;background:linear-gradient(135deg,#16a34a,#22c55e);color:#fff;">

          <i class="fa-solid fa-play"></i> ${t("start_cooking_btn", "BOSHLASH")}

        </button>

      </div>`;

  }



  let footerAction = '';

  if (!isReady) {

    const readyAtVal = Number(order.readyAt || 0);



    // ── yangi/tasdiqlangan yoki cooking lekin vaqt hali kiritilmagan ──

    if (!isCooking || (isCooking && !readyAtVal)) {

      footerAction = '';



    } else {

      // ── cooking + readyAt belgilangan: countdown + yangilash + TAYYOR ──

      const now = Date.now();

      const diffMs = readyAtVal - now;

      const diffMins = Math.floor(diffMs / 60000);

      const diffSecs = Math.floor((diffMs % 60000) / 1000);

      let timerColor = '#f59e0b';

      let timerClass = '';

      if (diffMs <= 0) { timerColor = '#ef4444'; timerClass = 'kechikdi'; }

      else if (diffMs <= 60000) { timerColor = '#ef4444'; timerClass = 'shake-anim'; }

      else if (diffMs <= 3 * 60000) { timerColor = '#ef4444'; }

      const timerTxt = diffMs <= 0

        ? `⚠️ ${t("overdue_label", "Kechikdi")} ${Math.abs(diffMins)} ${t("minute_short", "daq")}`

        : `⏱ ${diffMins}:${String(diffSecs).padStart(2, '0')} ${t("left_short", "qoldi")}`;



      const timerStateClass = diffMs <= 0 ? 'timer-overdue' : (diffMs <= 3 * 60000 ? 'timer-overdue' : 'timer-running');



      footerAction = `

        <div class="table-order-box">

          <div class="table-ready-timer">

            <span class="${timerStateClass} chef-card-countdown ${timerClass}"

              data-ready-at="${readyAtVal}" data-order-id="${escapeHtml(orderId)}">

              ${timerTxt}

            </span>

          </div>

          <div class="table-time-actions" style="padding-top:8px;">

            ${[5, 10, 15, 20, 30].map(m =>

        `<button type="button" onclick="document.getElementById('new-time-${escapeHtml(orderId)}').value=${m}">

                ${m}</button>`).join("")}

          </div>

          <div class="timer-not-set" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">

            <input id="new-time-${escapeHtml(orderId)}" type="number" min="1" max="120"

              placeholder="${t("minute_short", "Daq")}" value="${order.prepMinutes || ""}"

              style="flex:1;min-width:0;background:transparent;border:none;color:inherit;font-size:14px;font-weight:700;outline:none;"

              onkeydown="if(event.key==='Enter') window.updateCookingTimer('${escapeHtml(orderId)}')">

            <button type="button" onclick="window.updateCookingTimer('${escapeHtml(orderId)}')"

              style="background:none;border:none;cursor:pointer;color:inherit;font-size:12px;font-weight:700;white-space:nowrap;">

              🔄 ${t("update_timer", "Yangilash")}

            </button>

          </div>

          <button onclick="processChefAction('${escapeJsString(orderId)}', 'ready')"

            style="width:100%;padding:12px;background:linear-gradient(135deg,#10b981,#059669);

            color:#fff;border:none;border-radius:12px;cursor:pointer;font-weight:800;font-size:14px;

            display:flex;align-items:center;justify-content:center;gap:8px;

            box-shadow:0 4px 14px rgba(16,185,129,0.35);">

            <i class="fa-solid fa-check-double"></i> ${t("mark_as_ready", "TAYYOR ✅")}

          </button>

        </div>`;

    }

  } else {

    footerAction = `

      <div class="table-order-box" style="font-size:12px;color:var(--g-d,#16a34a);text-align:center;font-style:italic;display:flex;align-items:center;justify-content:center;gap:6px;">

        <i class="fa-solid fa-bell fa-bounce"></i> ${t("waiting_waiter", "Ofitsiant kutilmoqda...")}

      </div>`;

  }



  const isTVMode = document.body.classList.contains('tv-mode');



  // ── TV rejimi uchun ixcham taomlar ro'yxati: nom + son + oshpaz ismi ──

  let tvItemsHtml = '';

  if (order.items) {

    tvItemsHtml = Object.entries(order.items).map(([itemKey, item]) => {

      const menu = getOrderItemMenu(item) || {};

      const name = getTranslatedItemName(item, menu, currentLang);

      const qty = Number(item.qty || item.quantity || 1);

      const assignedNames = getAssignedChefNamesForItem(menu, item);

      const chefLabel = assignedNames.length > 0 ? assignedNames.join(", ") : "";

      return `

        <div class="chef-tv-compact-item">

          <span class="chef-tv-compact-item-name">${escapeHtml(name)}</span>

          <span class="chef-tv-compact-item-qty">×${qty}</span>

          ${chefLabel ? `<span class="chef-tv-compact-item-chef">${escapeHtml(chefLabel)}</span>` : ''}

        </div>`;

    }).join('');

  }



  const tvAllergyChips = order.allergyNote

    ? translateAllergyNote(order.allergyNote).split(',').map(part => part.trim()).filter(Boolean)

      .map(chipText => `<span class="chef-tv-chip">${escapeHtml(chipText)}</span>`).join('')

    : '';



  const tvChefName = getAssignedChefName(orderId, order);

  const tvIsFast = isFastOrder(order);



  const elapsedMs = Date.now() - Number(order.createdAt || Date.now());

  const elapsedMinTotal = Math.max(0, Math.floor(elapsedMs / 60000));

  const elapsedH = Math.floor(elapsedMinTotal / 60);

  const elapsedM = elapsedMinTotal % 60;

  const tvTimeBig = `${String(elapsedH).padStart(2, '0')}:${String(elapsedM).padStart(2, '0')}`;



  const tvCardHtml = `

    <div class="chef-tv-compact-head">

      <span class="chef-tv-compact-table">${tvIsFast ? '⚡ ' : ''}${hasTable ? `${t("table_title", "Stol")} ${escapeHtml(String(tableNum))}` : `#${orderNoText}`}</span>

      <span class="chef-tv-compact-time">${elapsedMinTotal} ${t("minute_short", "daq")}</span>

    </div>

    <div class="chef-tv-items-body">

      ${tvItemsHtml}

    </div>`;



  if (isTVMode) {

    div.classList.add('chef-tv-compact');

    div.innerHTML = tvCardHtml;

    return div;

  }



  const cardElapsedMs = Date.now() - Number(order.createdAt || Date.now());

  const cardElapsedMin = Math.max(0, Math.floor(cardElapsedMs / 60000));

  div.classList.add(`status-border-${statusClass}`);



  div.innerHTML = `

    <div class="card-inner">

      <div class="card-head card-head-v2">

        <div class="card-table-no" style="display:flex;align-items:center;justify-content:${hasTable ? "space-between" : "flex-start"};width:100%;">🍽 ${hasTable
      ? `${t("table_title", "STOL")} ${escapeHtml(String(tableNum))} <span class="card-order-no">#${orderNoText}</span>`
      : `<span class="card-order-no card-order-no-solo">#${orderNoText}</span>`
    }</div>

        <div class="card-head-row card-head-row-meta">

          <span class="card-order-id">🕒 ${formatOrderTime(order.createdAt)}</span>

          <span class="card-elapsed">⏱ ${cardElapsedMin} ${t("minute_short", "daqiqa")}</span>

        </div>

      </div>

      <div class="table-food-list">

        ${itemsHtml}

        ${order.allergyNote ? `<div class="order-allergy-note"><span class="allergy-icon">⚠️</span><span class="allergy-text">${escapeHtml(translateAllergyNote(order.allergyNote))}</span></div>` : ""}

      </div>

    </div>

    ${footerAction}`;



  return div;

}



window.buildChefOrderCard = buildChefOrderCard;

window.processChefAction = async function (orderId, nextStatus) {

  const restaurantId = localStorage.getItem("restaurantId");

  if (!restaurantId) return;



  const orderRef = ref(db, `restaurants/${restaurantId}/orders/${orderId}`);



  let updates = {

    status: nextStatus,

    statusKey: nextStatus,

    updatedAt: Date.now(),

    chefId: currentChefId

  };



  if (nextStatus === 'cooking') {

    const timeInput = document.getElementById(`time-input-${orderId}`);

    const minutes = parseInt(timeInput?.value);



    if (!minutes || minutes <= 0) {

      if (typeof showToast === "function") {

        showToast(t("invalid_time", "Iltimos, tayyor bo'lish vaqtini kiriting!"), "warning");

      } else {

        alert(t("invalid_time", "Iltimos, tayyor bo'lish vaqtini kiriting!"));

      }

      return;

    }



    updates.prepMinutes = minutes;

    updates.readyAt = Date.now() + (minutes * 60000);

    updates.cookingStartedAt = Date.now();

  }



  if (nextStatus === 'ready') {

    updates.finishedAt = Date.now();

    updates.readyAt = Date.now();

    updates.isNotified = false;

    updates.notified = false;

  }



  try {

    await update(orderRef, updates);



    // ── Butun buyurtma "tayyor" qilinganda — hali "delivered" bo'lmagan

    // barcha itemlarga ham status:"ready" yoziladi, shunda mijoz sahifasida

    // (client.js item.status) har bir taom to'g'ri "Tayyor" ko'rinadi. ──

    if (nextStatus === 'ready') {

      const orderSnap = await get(orderRef);

      const orderVal = orderSnap.exists() ? orderSnap.val() : null;

      const items = orderVal?.items || {};

      const itemUpdates = {};

      Object.entries(items).forEach(([key, item]) => {

        const curStatus = String(item?.status || "").toLowerCase();

        if (curStatus !== "delivered" && curStatus !== "yetkazildi") {

          itemUpdates[`${key}/status`] = "ready";

          itemUpdates[`${key}/kitchenStatus`] = "prepared";

          itemUpdates[`${key}/preparedAt`] = Date.now();

        }

      });

      if (Object.keys(itemUpdates).length > 0) {

        await update(ref(db, `${BASE_PATH}/orders/${orderId}/items`), itemUpdates);

      }

    }



    if ((nextStatus === "approved" || nextStatus === "cooking") &&

      typeof window.deductOrderInventory === "function") {

      await window.deductOrderInventory(orderId);

    }



    if (typeof window.logChefAction === "function") {

      const statusText = nextStatus === 'ready'

        ? t("status_ready", "tayyor")

        : t("status_cooking", "pishirilmoqda");

      await window.logChefAction(

        `#${orderId.slice(-4)} — ${t("status_updated", "Status yangilandi")}: ${statusText}`

      );

    }



    if (typeof showToast === "function") {

      const msg = nextStatus === 'cooking'

        ? t("order_cooking", "Buyurtma pishirish boshlandi")

        : t("order_ready_toast", "Buyurtma tayyor!");

      showToast(msg, "success");

    }



  } catch (error) {

    console.error(t("firebase_status_error_log", "Firebase status yangilashda xato:"), error);

    if (typeof showToast === "function") {

      showToast(t("error_generic", "Xatolik yuz berdi"), "error");

    }

  }

};

window.updateChefOrderStatus = window.processChefAction;

window.changeOrderStatus = window.processChefAction;

window.changeChefOrderStatus = window.processChefAction;

window.updateOrderStatus = window.processChefAction;



/* ==========================================

   🚀 BOSHLASH TUGMASI — startCookingFromCard

   ========================================== */

window.startCookingFromCard = async function (orderId) {

  const timeInput = document.getElementById(`time-input-${orderId}`);

  const inputVal = parseInt(timeInput?.value);



  if (!inputVal || inputVal <= 0) {

    if (typeof showToast === "function") {

      showToast(t("enter_ready_minutes", "Iltimos tayyor bo'lish vaqtini daqiqada kiriting!"), "warning");

    } else {

      alert(t("enter_ready_minutes", "Tayyor bo'lish vaqtini daqiqada kiriting!"));

    }

    if (timeInput) timeInput.focus();

    return;

  }



  const minutes = inputVal;

  const now = Date.now();

  const readyAt = now + (minutes * 60000);

  const restId = localStorage.getItem("restaurantId") || currentRestaurantId;

  const orderRef = ref(db, `restaurants/${restId}/orders/${orderId}`);



  try {

    await update(orderRef, {

      status: "cooking",

      statusKey: "cooking",

      statusLabel: t("status_cooking", "Tayyorlanmoqda"),

      readyAt: readyAt,

      prepMinutes: minutes,

      cookingStartedAt: now,

      startedAt: now,

      updatedAt: now,

      chefId: currentChefId,

      updatedBy: currentChefId

    });



    // Kitchen ticker uchun overdue observer — har 10 soniyada tekshiramiz

    window.__overdueChecked = window.__overdueChecked || new Set();

    const overdueKey = `overdue_${orderId}`;

    if (!window.__overdueCheckTimers) window.__overdueCheckTimers = {};

    if (window.__overdueCheckTimers[overdueKey]) clearInterval(window.__overdueCheckTimers[overdueKey]);



    window.__overdueCheckTimers[overdueKey] = setInterval(async () => {

      const now2 = Date.now();

      if (now2 < readyAt) return; // Hali vaqt o'tmagan



      const overdueMins = Math.floor((now2 - readyAt) / 60000);

      const alertKey = `overdue_alerted_${orderId}_${overdueMins}`;

      if (window.__overdueChecked.has(alertKey)) return;

      window.__overdueChecked.add(alertKey);



      // Har 5 daqiqada bitta ogohlantirish yetarli

      if (overdueMins % 5 !== 0) return;



      // Was: a fresh get(ref(...)) round-trip to Firebase every 10s per
      // active "cooking" order — pure polling that duplicated the already-
      // live listenOrders() subscription. window.allOrders is kept current
      // by that listener, so reading from it here is instant and makes no
      // extra network request.
      const ord2 = window.allOrders?.[orderId];

      if (!ord2) { clearInterval(window.__overdueCheckTimers[overdueKey]); return; }

      if (!["cooking", "tayyorlanmoqda"].includes(normalizeKitchenStatus(ord2.status || ''))) {

        clearInterval(window.__overdueCheckTimers[overdueKey]); return;

      }



      // Oshpazga ogohlantirish push

      const notifMsg = `⚠️ ${t("overdue_chef_alert", "Buyurtma kechikdi")}! ${t("table_label", "Stol")} ${ord2.table || ''} — ${overdueMins} ${t("minute_short", "daqiqa")} kechikdi!`;

      showNotification(notifMsg);

      if (typeof showToast === "function") showToast(notifMsg, "error");



      // Firebasega log

      await push(ref(db, `${BASE_PATH}/activityLogs`), {

        action: "order_overdue_alert",

        description: notifMsg,

        orderId,

        table: ord2.table || null,

        overdueMins,

        chefId: currentChefId,

        createdAt: Date.now()

      });

    }, 10000);



    if (typeof showToast === "function") showToast(`⏳ ${t("timer_started", "Taymer ishga tushdi")} — ${minutes} ${t("minute_short", "daqiqa")}`, "success");



  } catch (err) {

    console.error(t("cooking_start_error_log", "startCookingFromCard error:"), err);

    if (typeof showToast === "function") showToast(t("error_generic", "Xatolik yuz berdi"), "error");

  }

};



function refreshUI() {

  ensureChefEnhancementLayout();

  applyChefPageTranslations();

  renderPrepMenuSidebar?.();

  renderChefOrders();

  renderChefChatRooms?.();

  renderChefChatMessages?.();

  updateKitchenRealtimeStats();

  updateNewOrdersBadge?.();

  loadKitchenNotifications();

}



function startKitchenTicker() {

  if (window.__kitchenTickerTimer) return;

  window.__kitchenTickerTimer = setInterval(() => {

    updateOrderCountdowns();

    highlightLateOrders();

  }, 1000);

}



function highlightLateOrders() {

  const enabled = window.chefSettings?.highlightLateOrders !== false;

  document.querySelectorAll(".chef-order-card[data-order-id]").forEach(card => {

    const orderId = card.dataset.orderId;

    const order = allOrders?.[orderId];

    if (!order) return;

    const remaining = getRemainingInfo(order);

    card.classList.toggle("order-delayed", enabled && remaining.delayed);

    card.classList.toggle("order-urgent", enabled && remaining.urgent);

  });

}



function startKitchenNotificationsAutoRefresh() { if (window.__kitchenNotificationTimer) return; window.__kitchenNotificationTimer = setInterval(loadKitchenNotifications, 10000); }



/* =========================

   EVENTS

========================= */

function bindEvents() {

  if (window.__chefEnhancementEventsBound) return;

  window.__chefEnhancementEventsBound = true;

  if (langSelect) {

    langSelect.value = getLang();

    langSelect.addEventListener("change", e => setLang(e.target.value));

  }

  // Har bir qadam alohida try/catch bilan izolyatsiya qilingan — aks holda
  // (masalan) renderCategoryFilter() xato bersa, undan keyingi refreshUI()
  // (butun Kitchen Board'ni qayta chizadigan asosiy funksiya) umuman
  // chaqirilmay qolardi — "til faqat refresh'dan keyin ishlaydi" degan
  // muammoning aynan shu yerdagi sababi (batafsil: i18n.js setLang()dagi
  // izoh). Bitta qadam xato bersa ham, qolganlari baribir ishlaydi.
  onLangChange(lang => {

    const _step = (label, fn) => {
      try { fn(); } catch (err) { console.error(`[i18n] chef.js "${label}" failed during language switch:`, err); }
    };

    _step("currentLang update", () => { currentLang = lang; });

    _step("langSelect sync", () => { if (langSelect) langSelect.value = lang; });

    _step("renderCategoryFilter", () => renderCategoryFilter());

    _step("lastOrdersSignature reset", () => { lastOrdersSignature = ""; });

    _step("refreshUI", () => refreshUI());

  });

  chefFilterEl?.addEventListener("change", e => { localStorage.setItem("chefFilter", e.target.value); refreshUI(); });

  categoryFilterEl?.addEventListener("change", e => { localStorage.setItem("categoryFilter", e.target.value); localStorage.setItem("subFilter", "all"); renderSubFilter(e.target.value); refreshUI(); });

  subFilterEl?.addEventListener("change", e => { localStorage.setItem("subFilter", e.target.value); refreshUI(); });

  document.addEventListener("change", e => { if (e.target?.id === "chefStatusFilter") { localStorage.setItem("chefStatusFilter", e.target.value); refreshUI(); } });

  document.addEventListener("input", e => {

    if (e.target?.id === "chefSearchInput") {

      localStorage.setItem("chefSearch", e.target.value);

      clearTimeout(searchDebounceTimer);

      searchDebounceTimer = setTimeout(renderChefOrders, 300);

    }

  });



  chefChatSendBtnDom?.addEventListener("click", () => window.sendChefChatMessage?.());

  chefChatInputDom?.addEventListener("keydown", e => { if (e.key === "Enter") window.sendChefChatMessage?.(); });

  document.addEventListener("click", e => { if (statsPanelEl && !statsPanelEl.contains(e.target) && !e.target.closest(".btn-stats-toggle")) statsPanelEl.style.display = "none"; if (e.target?.id === "chefDetailModal") window.closeChefOrderDetail(); });

  document.addEventListener("fullscreenchange", updateChefFullscreenButton);

  if (localStorage.getItem("tvMode") === "1") document.body.classList.add("tv-mode");

}



function startChefSecurityMonitor() {

  const statusRef = ref(db, `${BASE_PATH}/info/status`);



  onValue(statusRef, (snapshot) => {

    const status = snapshot.val();

    const overlay = document.getElementById("system-block-overlay");



    if (overlay) {

      const icon = overlay.querySelector('i');

      const title = overlay.querySelector('h1');

      const desc = overlay.querySelector('p');



      if (status === "blocked") {

        overlay.style.display = "flex";

        document.body.style.overflow = "hidden";

        if (icon) { icon.className = "fa-solid fa-lock"; icon.style.color = "#ef4444"; }

        if (title) title.innerText = t("system_blocked_title", "Tizim vaqtincha bloklangan");

      } else if (status === "paused") {

        overlay.style.display = "flex";

        document.body.style.overflow = "hidden";

        if (icon) { icon.className = "fa-solid fa-circle-pause"; icon.style.color = "#f59e0b"; }

        if (title) title.innerText = t("system_paused_title", "Obuna vaqtincha to'xtatilgan");

        if (desc) desc.innerText = t("system_paused_desc", "Restoraningiz faoliyati vaqtincha to'xtatib qo'yilgan.");

      } else {

        overlay.style.display = "none";

        document.body.style.overflow = "auto";

      }

    }

  });

}



// ==========================================

// 🏷 OSHPAZ SAHIFASI SARLAVHASINI YANGILASH

// ==========================================

window.loadChefHeader = async function () {

  const restId = localStorage.getItem("restaurantId");

  const userId = typeof currentChefId !== "undefined" ? currentChefId : sessionStorage.getItem("userId");



  if (!restId || !userId) return;



  try {

    const [settingsSnap, infoSnap, userSnap] = await Promise.all([

      get(ref(db, `restaurants/${restId}/settings`)),

      get(ref(db, `restaurants/${restId}/info`)),

      get(ref(db, `restaurants/${restId}/users/${userId}`))

    ]);



    const settings = settingsSnap.val() || {};

    const info = infoSnap.val() || {};

    const user = userSnap.val() || {};



    const restName = settings.restaurantName || info.name || t("unknown_restaurant", "Noma'lum Restoran");

    const staffName = user.name || localStorage.getItem("userName") || t("chef_label", "Oshpaz");

    const roleLabel = t("chef_label", "Oshpaz");



    // ── Sahifa title ──

    document.title = `Nesta ERP — ${staffName} (${roleLabel}) | ${restName}`;



    // ── Yangi header elementlarini to'ldirish ──

    const nameEl = document.getElementById("chefHeaderName");

    const restEl = document.getElementById("chefHeaderRest");



    // 🩹 "Ism (Rol)" formati OLIB TASHLANDI — rol allaqachon header.js
    // render qiladigan #nestaHeaderBrand ichida ("КУХНЯ"/"Oshxona" satrida)
    // alohida ko'rsatiladi, shuning uchun xodim nomi yonida takror
    // ko'rsatish ortiqcha edi. Endi faqat ism.
    if (nameEl) nameEl.textContent = staffName;

    if (restEl) {

      restEl.textContent = restName;

      restEl.title = restName;

    }



    // Rol labelini yangilash

    document.querySelectorAll('[data-i18n="chef_label"]').forEach(el => {

      el.textContent = roleLabel;

    });



    // Logotipni yangilash (agar Firebase'dan URL bo'lsa)

    if (settings.restaurantLogoUrl) {

      const logoImg = document.querySelector(".ch-logo-circle img");

      if (logoImg) {

        logoImg.src = settings.restaurantLogoUrl;

        logoImg.style.objectFit = "contain";

        logoImg.style.filter = "none";

      }

    }



  } catch (error) {

    console.error(t("header_load_error_log", "Sarlavhani yuklashda xatolik:"), error);

  }

};



// ==========================================

// 👨‍Chef (OSHPAZ) PANELINI INITIALIZATSIYA QILISH

// ==========================================

async function initChef() {

  if (window.__chefInitStarted) return;

  window.__chefInitStarted = true;

  // 🔒 Har qanday Firebase o'qish/yozishdan (ensureChefUserExists/
  // ensureChefAccess va pastdagi barcha listenXxx() chaqiruvlari) OLDIN
  // Auth sessiyasi tiklanishini kutamiz — bu funksiya allaqachon
  // DOMContentLoaded orqali chaqirilgani uchun bu yerda kutish hech qanday
  // hodisani o'tkazib yuborish xavfini tug'dirmaydi (waiter.js'dagi init()
  // bilan bir xil pattern).
  try {
    await auth.authStateReady();
  } catch (err) {
    console.warn("[CHEF-AUTH] authStateReady() failed:", err?.code || err?.message);
  }

  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    console.info("[CHEF-STAFF-DIAG]", {
      restId: currentRestaurantId,
      authUid: auth.currentUser?.uid || null,
      targetUid: currentChefId,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      path: `${BASE_PATH}/...`
    });
  }

  ensureChefEnhancementLayout();

  try {

    await ensureChefUserExists();

    await ensureChefAccess("kitchen_access");

  } catch (e) { return; }



  await window.startChefSubscriptionTimer();



  applyChefPageTranslations();

  renderChefFilters();

  bindEvents();

  listenSocket();

  listenUsers();

  listenMenu();

  listenOrders();

  listenOrderChangeRequestsForKitchen();

  listenOrderChats();

  listenTableStates();

  listenMyStatus();

  listenStopList();

  listenOrderTimelines();

  listenActivityLogs();



  if (typeof window.listenToMyRoleChange === "function") {

    window.listenToMyRoleChange();

  }



  if (typeof window.loadChefHeader === "function") {

    await window.loadChefHeader();

  }



  // Restoran logotipi va footer ma'lumotlarini yuklash

  if (typeof window.loadChefRestaurantBranding === "function") {

    await window.loadChefRestaurantBranding();

  }



  try {

    await assignNextFromQueue();

  } catch (err) {

    console.error(t("queue_error_log", "Queue error:"), err);

  }



  startKitchenTicker();

  startKitchenNotificationsAutoRefresh();

  updateKitchenRealtimeStats();

  startChefSecurityMonitor();



  if (typeof window.initChefTasksPanel === "function") {

    window.initChefTasksPanel();

  }



  if (typeof window.initKitchenQueuePanel === "function") {

    window.initKitchenQueuePanel();

  }



  if (typeof window.initKitchenPerfPanel === "function") {

    window.initKitchenPerfPanel();

  }



  if (typeof window.initMySalaryStatsPanel === "function") {

    window.initMySalaryStatsPanel();

  }



  if (typeof window.initPrepSchedulerPanel === "function") {

    window.initPrepSchedulerPanel();

  }



  if (typeof window.initKitchenInventoryPanel === "function") {

    window.initKitchenInventoryPanel();

  }



  if (typeof window.initWasteMgmtPanel === "function") {

    window.initWasteMgmtPanel();

  }



  if (typeof window.initEquipmentStatusPanel === "function") {

    window.initEquipmentStatusPanel();

  }



  if (typeof window.initKitchenAnnouncementPanel === "function") {

    window.initKitchenAnnouncementPanel();

  }



  if (typeof window.initVoiceAssistantPanel === "function") {

    window.initVoiceAssistantPanel();

  }



  // 🖨️ Auto-print: sahifa ochilganda sozlamani tiklash va UI-ni yangilash

  setTimeout(() => {

    if (typeof loadChefSettings === "function") {

      loadChefSettings().then(() => {

        syncAutoPrintUI();

        window.maybeShowChefModeModal?.();

        window.updateChefModeBadge?.();

      }).catch(() => { });

    } else {

      syncAutoPrintUI();

    }

  }, 800);



  if (!window.__kitchenRealtimeTimer) {

    window.__kitchenRealtimeTimer = setInterval(updateKitchenRealtimeStats, 10000);

  }



  // ── TV va Fullscreen tugmalari endi HTML da mavjud — faqat style va holat yangilash ──

  (function injectChefTVButtons() {

    injectChefTVStyles();

    injectChefMonitorStyles();

    updateChefTVButton();

  })();



  // TV rejimini tiklash

  if (localStorage.getItem("tvMode") === "1") {

    document.body.classList.add("tv-mode");

    startChefTVAutoRefresh();

    setTimeout(() => {

      applyChefTVMode(true);

      updateChefTVButton();

      if (typeof window.renderChefOrders === "function") window.renderChefOrders();

    }, 300);

  }



  document.addEventListener("fullscreenchange", () => {

    updateChefFullscreenButton();

    updateChefTVButton();

  });

}



/* =========================

   CHEF TABS

========================= */

let _activeChefTab = localStorage.getItem("chefActiveTab") || "active";



window.switchChefTab = function (tab) {

  _activeChefTab = tab;

  localStorage.setItem("chefActiveTab", tab);



  const panelActive = document.getElementById("panelActive");

  const panelReady = document.getElementById("panelReady");

  const btnActive = document.getElementById("tabBtnActive");

  const btnReady = document.getElementById("tabBtnReady");



  if (!panelActive || !panelReady) return;



  if (tab === "active") {

    panelActive.style.display = "";

    panelReady.style.display = "none";

    btnActive?.classList.add("active");

    btnReady?.classList.remove("active");

  } else {

    panelActive.style.display = "none";

    panelReady.style.display = "";

    btnActive?.classList.remove("active");

    btnReady?.classList.add("active");

  }

};



window.updateChefTabCounts = function updateChefTabCounts() {

  const orders = window.allOrders || {};

  let activeCount = 0;

  let readyCount = 0;



  Object.values(orders).forEach(order => {

    // getChefVisibleOrders filterlari bilan mos kelishi uchun

    // normalizeKitchenStatus ishlatiladi

    const rawSt = String(order.status || order.statusKey || "").toLowerCase().trim();

    const st = (function normalizeLocal(s) {

      if (["new", "yangi", "queue", "pending"].includes(s)) return "new";

      if (["approved", "accepted", "tasdiqlandi"].includes(s)) return "approved";

      if (["cooking", "tayyorlanmoqda", "preparing", "in_progress"].includes(s)) return "cooking";

      if (["ready", "tayyor"].includes(s)) return "ready";

      if (["closed", "completed", "paid", "done"].includes(s)) return "closed";

      return s;

    })(rawSt);



    if (["new", "approved", "cooking"].includes(st)) activeCount++;

    else if (st === "ready") readyCount++;

  });



  const elActive = document.getElementById("tabCountActive");

  const elReady = document.getElementById("tabCountReady");

  if (elActive) {

    elActive.textContent = activeCount;

    elActive.setAttribute("data-zero", activeCount === 0 ? "1" : "0");

  }

  if (elReady) {

    elReady.textContent = readyCount;

    elReady.setAttribute("data-zero", readyCount === 0 ? "1" : "0");

  }



  // Tayyor buyurtmalar bo'lsa 2-tab yashil pulsatsiya

  const btnReady = document.getElementById("tabBtnReady");

  if (btnReady) {

    btnReady.classList.toggle("has-ready", readyCount > 0);

  }

};



// renderChefOrders tugagach tab count va stats box yangilansin

const _origRenderChefOrders = window.renderChefOrders;

window.renderChefOrders = function () {

  if (typeof _origRenderChefOrders === "function") _origRenderChefOrders();

  window.updateChefTabCounts();

  if (typeof window.renderChefStatsBox === "function") window.renderChefStatsBox();

};



// allOrders o'zgarganda ham yangilansin (listenOrders ichida)

const _origListenOrders_tabPatch = window.allOrders;

Object.defineProperty(window, "_tabCountAutoUpdate", {

  get() { return this.__tabCountAutoUpdate; },

  set(v) { this.__tabCountAutoUpdate = v; window.updateChefTabCounts(); }

});



document.addEventListener("DOMContentLoaded", () => {

  // Sahifa ochilganda saqlangan tabni tiklash

  const saved = localStorage.getItem("chefActiveTab") || "active";

  window.switchChefTab(saved);

  // Stats box darhol render qilish

  if (typeof window.renderChefStatsBox === "function") window.renderChefStatsBox();

  // Sonlarni darhol yangilash (orders yuklangandan keyin)

  setTimeout(() => window.updateChefTabCounts(), 500);

  setTimeout(() => window.updateChefTabCounts(), 2000);

  setTimeout(() => window.renderChefStatsBox?.(), 1500);

  setTimeout(() => window.renderChefStatsBox?.(), 4000);

});



document.addEventListener("DOMContentLoaded", initChef);



/* =========================

   CHEF: FOOTER VA HEADER LOGOTIPINI YUKLASH

========================= */

window.loadChefRestaurantBranding = async function () {

  const restId = localStorage.getItem("restaurantId");

  if (!restId) return;



  try {

    const snap = await get(ref(db, `restaurants/${restId}/settings`));

    if (!snap.exists()) return;



    const settings = snap.val();



    // 🩹 YAGONA STAFF FOOTER — bu yerda ilgari chef'ga XOS, o'zining
    // hardcoded rangli (var(--bg-card,#fff) — LIGHT rejimga mos, dark
    // rejimda header bilan mos kelmaydi), toggle'siz (ish vaqti/telefon
    // har doim ko'rinardi, Admin ularni o'chira olmasdi) footer qurish
    // kodi bor edi — screenshotdagi aynan shu ko'rinish endi barcha
    // xodim panellari uchun umumiy staffFooter.js/staffFooter.css
    // komponentiga ko'chirildi (bir marta yaratiladi — mountStaffFooter,
    // pastda chef.html'ning header.js chaqiruvi yonida). Bu yerda faqat
    // yangilanadi — Admin'ning footerSettings toggle'lari (ish vaqti/
    // telefon ko'rsatish/yashirish, qo'shimcha matn) hisobga olinadi.
    updateStaffFooter(_staffFooterEl, settings, t);



    // 🩹 IKKI LOGO XATOSI — ROOT CAUSE: bu yerda ilgari, agar
    // settings.restaurantLogoUrl mavjud bo'lsa, YANGI <img id=
    // "chefRestaurantLogoImg"> yaratilib, hech qanday ".logo-wrap"/".logo"/
    // ".brand" topilmagani uchun fallback zanjiri oxir-oqibat
    // `document.querySelector('header')`ga tushardi — bu chef.html'dagi
    // BITTA <header class="chef-header nesta-header">ning o'ziga to'g'ri
    // keladi va logoImg uning BIRINCHI farzandi sifatida (insertBefore
    // ...firstChild) qo'shilardi. Bu #nestaHeaderBrand (header.js render
    // qiladigan, chef.html'ning o'z real-time listeneri — pastda,
    // renderHeader()/setHeaderLogo() orqali — allaqachon yangilab
    // turadigan yagona canonical logo) dan OLDIN, unga yopishib turgan
    // IKKINCHI, butunlay ortiqcha logo edi. Endi bu legacy blok olib
    // tashlandi — logo FAQAT #nestaHeaderBrand .nesta-header-logo orqali,
    // bitta joydan boshqariladi (chef.html'dagi setHeaderLogo() chaqiruvi).



  } catch (error) {

    console.error(t("branding_load_error_log", "Branding yuklashda xato:"), error);

  }

};



// Chef paneli tayyor bo'lganda branding ma'lumotlarini yuklash

// loadChefHeader dan keyin chaqiriladi

window._origLoadChefHeader = window.loadChefHeader;

window.loadChefHeader = async function () {

  if (typeof window._origLoadChefHeader === "function") {

    await window._origLoadChefHeader();

  }

  if (typeof window.loadChefRestaurantBranding === "function") {

    await window.loadChefRestaurantBranding();

  }

};



// Real-time: admin sozlamalarni o'zgartirsa darhol aks ettirish

(function () {

  const restId = localStorage.getItem("restaurantId");

  if (!restId) return;

  onValue(ref(db, `restaurants/${restId}/settings`), (snap) => {

    if (!snap.exists()) return;

    const settings = snap.val();




    // 🩹 YAGONA STAFF FOOTER — legacy .chef-branding-info/#chefDynamicFooter
    // qo'lda yangilash o'rniga, endi umumiy updateStaffFooter() (Admin'ning
    // footerSettings toggle'larini ham hisobga oladi).
    updateStaffFooter(_staffFooterEl, settings, t);



    // 🩹 IKKI LOGO XATOSI — bu bloк ham legacy #chefRestaurantLogoImg
    // (yuqoridagi loadChefRestaurantBranding() bilan bir xil, endi olib
    // tashlangan) elementini yangilar edi — endi u umuman yaratilmagani
    // uchun bu ham kerak emas (logo yagona #nestaHeaderBrand orqali,
    // chef.html'dagi o'z real-time listeneri bilan yangilanadi).

  });

})();



window.setCustomOrderReadyTime = async function (orderId) {

  const input = document.getElementById(`time-input-${orderId}`);

  if (!input) return;



  const minutes = parseInt(input.value);

  if (!minutes || minutes <= 0) {

    const errorMsg = (typeof t === "function")

      ? t("invalid_time", "Iltimos, to'g'ri daqiqa kiriting!")

      : "Iltimos, to'g'ri daqiqa kiriting!";



    if (typeof showToast === "function") {

      showToast(errorMsg, "warning");

    } else {

      alert(errorMsg);

    }

    return;

  }

  if (typeof window.setOrderReadyTime === "function") {

    await window.setOrderReadyTime(orderId, minutes);

    input.value = '';

  } else {

    console.error("Xato: setOrderReadyTime funksiyasi topilmadi!");

  }

};



/* ==========================================================

   👨‍🍳 CHEF TASKS — Bugungi vazifalar + Status pipeline

   (Pending → In Progress → Completed → Verified)

   Firebase yo'li: restaurants/{restId}/chefTasks/{chefId}/{dateKey}/{taskId}

========================================================== */

(function chefTasksModule() {



  const STATUS_FLOW = ["pending", "in_progress", "completed", "verified"];

  const STATUS_LABELS = {

    pending: () => t("task_status_pending", "Pending"),

    in_progress: () => t("task_status_in_progress", "In Progress"),

    completed: () => t("task_status_completed", "Completed"),

    verified: () => t("task_status_verified", "Verified"),

  };



  const DEFAULT_TASKS = [

    "task_default_meat_prep",

    "task_default_sauce_prep",

    "task_default_fridge_check",

    "task_default_kitchen_clean",

    "task_default_inventory_count"

  ];

  const DEFAULT_TASK_LABELS = {

    task_default_meat_prep: "Go'sht tayyorlash",

    task_default_sauce_prep: "Sous tayyorlash",

    task_default_fridge_check: "Muzlatgich tekshirish",

    task_default_kitchen_clean: "Oshxonani tozalash",

    task_default_inventory_count: "Inventar sanash"

  };



  let _tasksCache = {};

  let _tasksUnsub = null;



  function todayKey() {

    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  }



  function tasksPath() {

    const restId = localStorage.getItem("restaurantId") || currentRestaurantId;

    const chefId = currentChefId || getStoredChefId();

    return `restaurants/${restId}/chefTasks/${chefId}/${todayKey()}`;

  }



  async function seedDefaultTasksIfEmpty() {

    const snap = await get(ref(db, tasksPath()));

    if (snap.exists() && snap.val() && Object.keys(snap.val()).length > 0) return;



    const now = Date.now();

    const updates = {};

    DEFAULT_TASKS.forEach((key, idx) => {

      const id = `default_${idx}`;

      updates[id] = {

        label: DEFAULT_TASK_LABELS[key] || key,

        labelKey: key,

        done: false,

        status: "pending",

        createdAt: now,

        order: idx

      };

    });

    await update(ref(db, tasksPath()), updates);

  }



  function renderTasks() {

    const listEl = document.getElementById("chefTasksList");

    const pillEl = document.getElementById("chefTasksProgressPill");

    const fillEl = document.getElementById("chefTasksProgressFill");

    if (!listEl) return;



    const entries = Object.entries(_tasksCache || {})

      .sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0));



    const total = entries.length;

    const doneCount = entries.filter(([_, tsk]) => !!tsk.done).length;



    if (pillEl) pillEl.textContent = `${doneCount}/${total}`;

    if (fillEl) fillEl.style.width = total ? `${Math.round((doneCount / total) * 100)}%` : "0%";



    if (total === 0) {

      listEl.innerHTML = `<div style="padding:16px 8px;color:#94A3B8;font-size:13px;text-align:center;">${t("no_tasks_yet", "Hozircha vazifalar yo'q. Pastdan qo'shing.")}</div>`;

      return;

    }



    listEl.innerHTML = entries.map(([taskId, tsk]) => {

      const label = tsk.labelKey ? (t(tsk.labelKey, tsk.label) || tsk.label) : escapeHtml(tsk.label || "");

      const status = tsk.status || (tsk.done ? "completed" : "pending");



      const statusPills = STATUS_FLOW.map(s => `

        <span class="chef-status-pill ${s === status ? "active" : ""}" data-status="${s}"

          onclick="window.setChefTaskStatus('${taskId}','${s}')">${STATUS_LABELS[s]()}</span>

      `).join(`<i class="fa-solid fa-chevron-right chef-status-arrow"></i>`);



      return `

        <div class="chef-task-item ${tsk.done ? "done" : ""}" data-task-id="${taskId}">

          <div class="chef-task-checkbox" onclick="window.toggleChefTaskDone('${taskId}')">

            <i class="fa-solid fa-check"></i>

          </div>

          <div style="flex:1;">

            <div class="chef-task-label" onclick="window.toggleChefTaskDone('${taskId}')">${label}</div>

            <div class="chef-task-status-row">${statusPills}</div>

          </div>

          <div class="chef-task-delete" onclick="window.deleteChefTask('${taskId}')">

            <i class="fa-solid fa-trash-can"></i>

          </div>

        </div>

      `;

    }).join("");

  }



  function listenChefTasks() {

    if (_tasksUnsub) { _tasksUnsub(); _tasksUnsub = null; }

    const tasksRef = ref(db, tasksPath());

    _tasksUnsub = onValue(tasksRef, snap => {

      _tasksCache = snap.val() || {};

      renderTasks();

    });

    if (window.listeners) window.listeners.chefTasks = _tasksUnsub;

  }



  window.initChefTasksPanel = async function () {

    try {

      await seedDefaultTasksIfEmpty();

      listenChefTasks();



      const collapsed = localStorage.getItem("chefTasksCollapsed") === "1";

      const wrapper = document.getElementById("chefTasksWrapper");

      if (wrapper && collapsed) wrapper.classList.add("collapsed");

    } catch (e) {

      console.error(t("tasks_init_error", "Vazifalar panelini ishga tushirishda xato:"), e);

    }

  };



  window.toggleChefTasksPanel = function () {

    const wrapper = document.getElementById("chefTasksWrapper");

    if (!wrapper) return;

    const isCollapsed = wrapper.classList.toggle("collapsed");

    localStorage.setItem("chefTasksCollapsed", isCollapsed ? "1" : "0");

  };



  window.addChefTask = async function () {

    const input = document.getElementById("chefNewTaskInput");

    const label = (input?.value || "").trim();

    if (!label) {

      if (input) { input.focus(); input.style.border = "2px solid #ef4444"; setTimeout(() => { if (input) input.style.border = ""; }, 1200); }

      return;

    }



    const now = Date.now();

    const existingCount = Object.keys(_tasksCache || {}).length;

    const newTaskRef = push(ref(db, tasksPath()));



    try {

      await set(newTaskRef, {

        label,

        done: false,

        status: "pending",

        createdAt: now,

        order: existingCount

      });

      if (input) input.value = "";

      if (typeof showChefNotification === "function") {

        showChefNotification(`✅ ${t("task_added", "Vazifa qo'shildi")}: ${label}`);

      }

    } catch (e) {

      console.error("addChefTask error:", e);

    }

  };



  window.deleteChefTask = async function (taskId) {

    try {

      await remove(ref(db, `${tasksPath()}/${taskId}`));

    } catch (e) {

      console.error("deleteChefTask error:", e);

    }

  };



  window.toggleChefTaskDone = async function (taskId) {

    const tsk = _tasksCache?.[taskId];

    if (!tsk) return;

    const nextDone = !tsk.done;

    const nextStatus = nextDone ? "completed" : "pending";



    try {

      await update(ref(db, `${tasksPath()}/${taskId}`), {

        done: nextDone,

        status: nextStatus,

        updatedAt: Date.now(),

        ...(nextDone ? { completedAt: Date.now() } : { completedAt: null })

      });

    } catch (e) {

      console.error("toggleChefTaskDone error:", e);

    }

  };



  // Status pipeline: Pending → In Progress → Completed → Verified

  window.setChefTaskStatus = async function (taskId, status) {

    if (!STATUS_FLOW.includes(status)) return;

    const now = Date.now();



    const patch = {

      status,

      updatedAt: now,

      done: status === "completed" || status === "verified"

    };



    if (status === "in_progress") patch.startedAt = now;

    if (status === "completed") patch.completedAt = now;

    if (status === "verified") { patch.verifiedAt = now; patch.verifiedBy = currentChefId; }



    try {

      await update(ref(db, `${tasksPath()}/${taskId}`), patch);

      if (typeof showChefNotification === "function") {

        showChefNotification(`🔄 ${STATUS_LABELS[status]()}`);

      }

    } catch (e) {

      console.error("setChefTaskStatus error:", e);

    }

  };



})();



/* ==========================================================

   🍽️ KITCHEN QUEUE — NOW / NEXT / URGENT

   Mavjud buyurtmalarni (window.allOrders) navbat bo'yicha

   uchta ustunga taqsimlaydi va real vaqtda yangilab turadi.

========================================================== */

(function kitchenQueueModule() {



  const URGENT_THRESHOLD_MS = 5 * 60 * 1000;

  let _kqTimer = null;



  function orderNumberLabel(orderId, order) {

    return formatOrderNumber(order) || `#${String(orderId || "").slice(-3)}`;

  }



  function getQueueBuckets() {

    const orders = window.allOrders || {};



    const activeEntries = Object.entries(orders).filter(([_, order]) => {

      const status = normalizeKitchenStatus(getOrderStatus(order));

      return ["new", "approved", "cooking"].includes(status);

    });



    const withRemaining = activeEntries.map(([orderId, order]) => {

      const readyAt = Number(order.readyAt || order.expectedReadyAt || 0);

      const remainingMs = readyAt ? (readyAt - Date.now()) : null;

      return { orderId, order, remainingMs };

    });



    const urgent = withRemaining

      .filter(x => x.remainingMs !== null && x.remainingMs <= URGENT_THRESHOLD_MS)

      .sort((a, b) => (a.remainingMs ?? 0) - (b.remainingMs ?? 0));



    const urgentIds = new Set(urgent.map(x => x.orderId));



    const rest = withRemaining

      .filter(x => !urgentIds.has(x.orderId))

      .sort((a, b) => Number(a.order.createdAt || 0) - Number(b.order.createdAt || 0));



    const nowItem = rest.length ? [rest[0]] : [];

    const nextItems = rest.slice(1, 4);



    return { now: nowItem, next: nextItems, urgent };

  }



  function renderChip(orderId, order) {

    const label = orderNumberLabel(orderId, order);

    return `

      <div class="kq-order-chip" onclick="window.openChefOrderDetail?.('${orderId}')">

        <span>${label}</span>

      </div>

    `;

  }



  function renderColumn(listElId, countElId, items, emptyKey, emptyFallback) {

    const listEl = document.getElementById(listElId);

    const countEl = document.getElementById(countElId);

    if (!listEl) return;



    if (countEl) countEl.textContent = String(items.length);



    if (items.length === 0) {

      listEl.innerHTML = `<div class="kq-empty-hint">${t(emptyKey, emptyFallback)}</div>`;

      return;

    }



    listEl.innerHTML = items.map(x => renderChip(x.orderId, x.order)).join("");

  }



  function renderKitchenQueue() {

    const { now, next, urgent } = getQueueBuckets();

    renderColumn("kqListNow", "kqCountNow", now, "kq_empty_now", "Navbat bo'sh");

    renderColumn("kqListNext", "kqCountNext", next, "kq_empty_next", "Navbatda yo'q");

    renderColumn("kqListUrgent", "kqCountUrgent", urgent, "kq_empty_urgent", "Shoshilinch yo'q");

  }

  window.renderKitchenQueue = renderKitchenQueue;



  window.initKitchenQueuePanel = function () {

    const collapsed = localStorage.getItem("kitchenQueueCollapsed") === "1";

    const wrapper = document.getElementById("kitchenQueueWrapper");

    if (wrapper && collapsed) wrapper.classList.add("collapsed");



    renderKitchenQueue();



    if (_kqTimer) clearInterval(_kqTimer);

    _kqTimer = setInterval(renderKitchenQueue, 5000);

  };



  window.toggleKitchenQueuePanel = function () {

    const wrapper = document.getElementById("kitchenQueueWrapper");

    if (!wrapper) return;

    const isCollapsed = wrapper.classList.toggle("collapsed");

    localStorage.setItem("kitchenQueueCollapsed", isCollapsed ? "1" : "0");

  };



})();





/* ==========================================================

   📊 KITCHEN PERFORMANCE — Chef KPI

   Bugungi buyurtmalar soni, o'rtacha/eng tez tayyorlash

   vaqti va kechikkan buyurtmalar sonini hisoblab ko'rsatadi.

========================================================== */

(function kitchenPerfModule() {



  let _kpTimer = null;



  function isToday(ts) {

    if (!ts) return false;

    const d = new Date(Number(ts));

    const now = new Date();

    return d.getFullYear() === now.getFullYear() &&

      d.getMonth() === now.getMonth() &&

      d.getDate() === now.getDate();

  }



  function computeKPIs() {

    const orders = window.allOrders || {};

    const chefId = currentChefId;



    const myTodayOrders = Object.values(orders).filter(order => {

      const belongsToMe = String(order.chefId) === String(chefId);

      const ts = order.finishedAt || order.readyAt || order.createdAt;

      return belongsToMe && isToday(ts);

    });



    const totalToday = myTodayOrders.length;



    // Tayyorlash vaqti (daqiqada) — startedAt/cookingStartedAt dan finishedAt gacha

    const durationsMin = myTodayOrders

      .map(order => {

        const start = Number(order.startedAt || order.cookingStartedAt || 0);

        const end = Number(order.finishedAt || 0);

        if (!start || !end || end <= start) return null;

        return (end - start) / 60000;

      })

      .filter(v => v !== null && v > 0);



    const avgMinutes = durationsMin.length

      ? Math.round(durationsMin.reduce((a, b) => a + b, 0) / durationsMin.length)

      : 0;



    const fastestMinutes = durationsMin.length

      ? Math.round(Math.min(...durationsMin))

      : 0;



    // Kechikkan buyurtmalar — belgilangan readyAt/expectedReadyAt dan keyin tugagan

    // yoki hozirgacha tayyor bo'lmagan va vaqti o'tib ketgan buyurtmalar

    const delayedCount = myTodayOrders.filter(order => {

      const expected = Number(order.readyAt || order.expectedReadyAt || 0);

      if (!expected) return false;

      const finishedOrNow = Number(order.finishedAt || Date.now());

      return finishedOrNow > expected;

    }).length;



    return { totalToday, avgMinutes, fastestMinutes, delayedCount };

  }



  function renderKitchenPerf() {

    const { totalToday, avgMinutes, fastestMinutes, delayedCount } = computeKPIs();



    const elTotal = document.getElementById("kpTodayOrders");

    const elAvg = document.getElementById("kpAvgTime");

    const elFastest = document.getElementById("kpFastestTime");

    const elDelayed = document.getElementById("kpDelayedCount");



    if (elTotal) elTotal.textContent = String(totalToday);

    if (elAvg) elAvg.textContent = String(avgMinutes);

    if (elFastest) elFastest.textContent = String(fastestMinutes);

    if (elDelayed) elDelayed.textContent = String(delayedCount);

  }

  window.renderKitchenPerf = renderKitchenPerf;



  window.initKitchenPerfPanel = function () {

    const collapsed = localStorage.getItem("kitchenPerfCollapsed") === "1";

    const wrapper = document.getElementById("kitchenPerfWrapper");

    if (wrapper && collapsed) wrapper.classList.add("collapsed");



    renderKitchenPerf();



    if (_kpTimer) clearInterval(_kpTimer);

    _kpTimer = setInterval(renderKitchenPerf, 15000);

  };



  window.toggleKitchenPerfPanel = function () {

    const wrapper = document.getElementById("kitchenPerfWrapper");

    if (!wrapper) return;

    const isCollapsed = wrapper.classList.toggle("collapsed");

    localStorage.setItem("kitchenPerfCollapsed", isCollapsed ? "1" : "0");

  };



})();





/* ==========================================================

   💰 MENING MAOSHIM / KPI — admin.js bilan sinxron ko'rsatkich

   Manba (admin.js yozadigan yagona joy):

     restaurants/{restId}/users/{chefId}

       salaryMode, fixedSalary, kpiPercent, commissionPercent, ballRate

     restaurants/{restId}/finance/staff_stats/{chefId}/{monthKey}

       orderCount, totalEarned

   Bu yerda faqat o'qiladi — yozish admin.js orqali calculateStaffKPI()

   funksiyasida amalga oshadi, shu bilan ikkala panel bir xil raqamni

   ko'rsatadi.

========================================================== */

(function mySalaryStatsModule() {



  let _userUnsub = null;

  let _statsUnsub = null;

  let _userCache = {};

  let _statsCache = { orderCount: 0, totalEarned: 0 };



  function monthKey() {

    return new Date().toISOString().slice(0, 7);

  }



  function modeLabel(mode) {

    switch (mode) {

      case "kpi": return `🎯 KPI`;

      case "percent": return `📊 ${t("smode_percent_label", "Foiz")}`;

      case "ball": return `🏆 ${t("smode_ball_label", "Ball")}`;

      default: return `💼 ${t("smode_fixed_label", "Oylik")}`;

    }

  }



  function render() {

    const wrap = document.getElementById("mySalaryStatsWrapper");

    if (!wrap) return;



    const mode = _userCache.salaryMode || "fixed";

    const orderCount = Number(_statsCache.orderCount || 0);

    const totalEarned = Number(_statsCache.totalEarned || 0);

    const ballRate = Number(_userCache.ballRate || 0);

    const commissionPercent = Number(_userCache.commissionPercent || 0);

    const kpiPercent = Number(_userCache.kpiPercent ?? 100);

    const fixedSalary = Number(_userCache.fixedSalary || 0);



    const modeEl = document.getElementById("mssModeLabel");

    const ordersEl = document.getElementById("mssOrderCount");

    const detailEl = document.getElementById("mssDetail");



    if (modeEl) modeEl.textContent = modeLabel(mode);

    if (ordersEl) ordersEl.textContent = String(orderCount);



    if (detailEl) {

      if (mode === "percent") {

        detailEl.textContent = `${commissionPercent}% × ${t("orders_this_month", "Ushbu oydagi buyurtmalari")} = ${totalEarned.toLocaleString()} ${t("currency", "so'm")}`;

      } else if (mode === "ball") {

        const ballTotal = orderCount * ballRate;

        detailEl.textContent = `${orderCount} ${t("ball_unit_label", "ball")} × ${ballRate.toLocaleString()} = ${ballTotal.toLocaleString()} ${t("currency", "so'm")}`;

      } else if (mode === "kpi") {

        detailEl.textContent = `${t("kpi_percent_label", "Boshlang'ich KPI")}: ${kpiPercent}% · ${t("monthly_salary_label", "Oylik maosh")}: ${fixedSalary.toLocaleString()} so'm`;

      } else {

        detailEl.textContent = `${t("monthly_salary_label", "Oylik maosh")}: ${fixedSalary.toLocaleString()} so'm`;

      }

    }

  }



  function listen() {

    const restId = localStorage.getItem("restaurantId") || currentRestaurantId;

    const chefId = currentChefId || getStoredChefId();

    if (!restId || !chefId) return;



    if (_userUnsub) { _userUnsub(); _userUnsub = null; }

    if (_statsUnsub) { _statsUnsub(); _statsUnsub = null; }



    const userRef = ref(db, `restaurants/${restId}/users/${chefId}`);

    _userUnsub = onValue(userRef, (snap) => {

      _userCache = snap.val() || {};

      render();

    });



    const statsRef = ref(db, `restaurants/${restId}/finance/staff_stats/${chefId}/${monthKey()}`);

    _statsUnsub = onValue(statsRef, (snap) => {

      _statsCache = snap.val() || { orderCount: 0, totalEarned: 0 };

      render();

    });



    if (window.listeners) {

      window.listeners.mySalaryUser = _userUnsub;

      window.listeners.mySalaryStats = _statsUnsub;

    }

  }



  window.initMySalaryStatsPanel = function () {

    const collapsed = localStorage.getItem("mySalaryStatsCollapsed") === "1";

    const wrapper = document.getElementById("mySalaryStatsWrapper");

    if (wrapper && collapsed) wrapper.classList.add("collapsed");

    listen();

  };



  window.toggleMySalaryStatsPanel = function () {

    const wrapper = document.getElementById("mySalaryStatsWrapper");

    if (!wrapper) return;

    const isCollapsed = wrapper.classList.toggle("collapsed");

    localStorage.setItem("mySalaryStatsCollapsed", isCollapsed ? "1" : "0");

  };



})();



/* ==========================================================

   ⏰ PREPARATION SCHEDULER — Oldindan tayyorlash jadvali

   Kunlik vaqt bo'yicha tayyorgarlik vazifalari (masalan:

   09:00 → Sous, 11:00 → Salat, 12:00 → Kabob).

   Firebase yo'li: restaurants/{restId}/prepSchedule/{chefId}/{dateKey}/{itemId}

   itemId: {

     time: "09:00",

     label: "Sous",

     menuId: "..." (ixtiyoriy, retseptga bog'lash uchun),

     done: false,

     status: "pending" | "done",

     createdAt, doneAt

   }

========================================================== */

(function prepSchedulerModule() {



  let _prepCache = {};

  let _prepUnsub = null;

  let _prepTimer = null;



  const SOON_THRESHOLD_MS = 20 * 60 * 1000; // 20 daqiqa qolganda "tez orada"



  function todayKey() {

    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  }



  function prepSchedulePath() {

    const restId = localStorage.getItem("restaurantId") || currentRestaurantId;

    const chefId = currentChefId || getStoredChefId();

    return `restaurants/${restId}/prepSchedule/${chefId}/${todayKey()}`;

  }



  // "09:00" -> bugungi shu vaqtdagi timestamp

  function timeStrToTimestamp(timeStr) {

    const [h, m] = String(timeStr || "00:00").split(":").map(Number);

    const d = new Date();

    d.setHours(h || 0, m || 0, 0, 0);

    return d.getTime();

  }



  function getPrepItemState(item) {

    if (item.done) return "done";

    const targetTs = timeStrToTimestamp(item.time);

    const diff = targetTs - Date.now();

    if (diff < 0) return "overdue";

    if (diff <= SOON_THRESHOLD_MS) return "soon";

    return "upcoming";

  }



  function prepStateLabel(state) {

    switch (state) {

      case "done": return `✅ ${t("prep_state_done", "Tayyor")}`;

      case "overdue": return `⏰ ${t("prep_state_overdue", "Kechikdi")}`;

      case "soon": return `🔔 ${t("prep_state_soon", "Tez orada")}`;

      default: return `🕒 ${t("prep_state_upcoming", "Navbatda")}`;

    }

  }



  function renderPrepScheduler() {

    const listEl = document.getElementById("prepSchedulerList");

    const countEl = document.getElementById("prepSchedulerCountPill");

    if (!listEl) return;



    const entries = Object.entries(_prepCache || {})

      .sort((a, b) => timeStrToTimestamp(a[1].time) - timeStrToTimestamp(b[1].time));



    const total = entries.length;

    const doneCount = entries.filter(([_, it]) => !!it.done).length;

    if (countEl) countEl.textContent = `${doneCount}/${total}`;



    if (total === 0) {

      listEl.innerHTML = `<div class="prep-sched-empty">${t("prep_sched_empty", "Bugun uchun tayyorgarlik jadvali bo'sh. Pastdan qo'shing.")}</div>`;

      return;

    }



    listEl.innerHTML = entries.map(([itemId, item]) => {

      const state = getPrepItemState(item);

      const label = escapeHtml(item.label || "");

      const timeTxt = escapeHtml(item.time || "--:--");



      return `

        <div class="prep-sched-item prep-sched-${state}" data-item-id="${itemId}">

          <div class="prep-sched-checkbox" onclick="window.togglePrepScheduleDone('${itemId}')">

            <i class="fa-solid fa-check"></i>

          </div>

          <div class="prep-sched-time">${timeTxt}</div>

          <div class="prep-sched-label">${label}</div>

          <div class="prep-sched-state-pill">${prepStateLabel(state)}</div>

          <div class="prep-sched-delete" onclick="window.deletePrepScheduleItem('${itemId}')">

            <i class="fa-solid fa-trash-can"></i>

          </div>

        </div>

      `;

    }).join("");

  }

  window.renderPrepScheduler = renderPrepScheduler;



  function listenPrepSchedule() {

    if (_prepUnsub) { _prepUnsub(); _prepUnsub = null; }

    const schedRef = ref(db, prepSchedulePath());

    _prepUnsub = onValue(schedRef, snap => {

      _prepCache = snap.val() || {};

      renderPrepScheduler();

    });

    if (window.listeners) window.listeners.prepSchedule = _prepUnsub;

  }



  window.initPrepSchedulerPanel = function () {

    try {

      listenPrepSchedule();



      const collapsed = localStorage.getItem("prepSchedulerCollapsed") === "1";

      const wrapper = document.getElementById("prepSchedulerWrapper");

      if (wrapper && collapsed) wrapper.classList.add("collapsed");



      renderPrepScheduler();

      if (_prepTimer) clearInterval(_prepTimer);

      _prepTimer = setInterval(renderPrepScheduler, 30000); // holatlarni (overdue/soon) yangilab turish

    } catch (e) {

      console.error(t("prep_sched_init_error", "Tayyorgarlik jadvalini ishga tushirishda xato:"), e);

    }

  };



  window.togglePrepSchedulerPanel = function () {

    const wrapper = document.getElementById("prepSchedulerWrapper");

    if (!wrapper) return;

    const isCollapsed = wrapper.classList.toggle("collapsed");

    localStorage.setItem("prepSchedulerCollapsed", isCollapsed ? "1" : "0");

  };



  window.addPrepScheduleItem = async function () {

    const timeInput = document.getElementById("prepSchedNewTime");

    const labelInput = document.getElementById("prepSchedNewLabel");

    const time = (timeInput?.value || "").trim();

    const label = (labelInput?.value || "").trim();



    if (!time || !label) {

      [timeInput, labelInput].forEach(el => {

        if (el && !el.value.trim()) {

          el.style.border = "2px solid #ef4444";

          setTimeout(() => { el.style.border = ""; }, 1200);

        }

      });

      return;

    }



    const now = Date.now();

    const newItemRef = push(ref(db, prepSchedulePath()));



    try {

      await set(newItemRef, {

        time,

        label,

        done: false,

        status: "pending",

        createdAt: now

      });

      if (timeInput) timeInput.value = "";

      if (labelInput) labelInput.value = "";

      if (typeof showChefNotification === "function") {

        showChefNotification(`✅ ${t("prep_sched_added", "Jadvalga qo'shildi")}: ${time} — ${label}`);

      }

    } catch (e) {

      console.error("addPrepScheduleItem error:", e);

    }

  };



  window.togglePrepScheduleDone = async function (itemId) {

    const item = _prepCache?.[itemId];

    if (!item) return;

    const nextDone = !item.done;



    try {

      await update(ref(db, `${prepSchedulePath()}/${itemId}`), {

        done: nextDone,

        status: nextDone ? "done" : "pending",

        doneAt: nextDone ? Date.now() : null

      });

    } catch (e) {

      console.error("togglePrepScheduleDone error:", e);

    }

  };



  window.deletePrepScheduleItem = async function (itemId) {

    try {

      await remove(ref(db, `${prepSchedulePath()}/${itemId}`));

    } catch (e) {

      console.error("deletePrepScheduleItem error:", e);

    }

  };



})();

/* ==========================================================

   KITCHEN INVENTORY — Oshxona ombori (Chef paneli)

   Har bir mahsulot uchun qoldiq miqdor va "kam qolsa" chegarasi

   kuzatiladi. Qoldiq chegaradan kam bo'lsa, 🔴 belgisi chiqadi.

   Firebase yo'li: restaurants/{restId}/kitchenInventory/{itemId}

   itemId: {

     name: "Go'sht",

     qty: 5,

     unit: "kg",

     threshold: 2,

     updatedAt, updatedBy

   }

========================================================== */

(function kitchenInventoryModule() {



  let _invCache = {};

  let _invUnsub = null;



  function inventoryPath() {

    const restId = localStorage.getItem("restaurantId") || currentRestaurantId;

    return `restaurants/${restId}/kitchenInventory`;

  }



  function isLowStock(item) {

    const qty = Number(item?.qty);

    const threshold = Number(item?.threshold);

    if (isNaN(qty) || isNaN(threshold)) return false;

    return qty <= threshold;

  }



  function renderKitchenInventory() {

    const listEl = document.getElementById("kitchenInventoryList");

    const emptyEl = document.getElementById("kitchenInventoryEmpty");

    const lowPill = document.getElementById("invLowPill");

    const lowCountEl = document.getElementById("invLowCount");

    if (!listEl) return;



    const entries = Object.entries(_invCache || {})

      .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));



    const lowCount = entries.filter(([_, it]) => isLowStock(it)).length;

    if (lowCountEl) lowCountEl.textContent = String(lowCount);

    if (lowPill) lowPill.classList.toggle("show", lowCount > 0);



    if (entries.length === 0) {

      listEl.innerHTML = "";

      if (emptyEl) emptyEl.style.display = "block";

      return;

    }

    if (emptyEl) emptyEl.style.display = "none";



    listEl.innerHTML = entries.map(([itemId, item]) => {

      const low = isLowStock(item);

      const name = escapeHtml(item.name || "");

      const unit = escapeHtml(item.unit || "");

      const qty = (item.qty === undefined || item.qty === null) ? "" : item.qty;

      const threshold = (item.threshold === undefined || item.threshold === null) ? "" : item.threshold;



      return `

        <tr class="inv-row ${low ? "inv-low" : ""}" data-item-id="${itemId}">

          <td class="inv-name">${name}</td>

          <td>

            <div class="inv-qty-wrap">

              <input type="number" step="any" class="inv-qty-input" value="${qty}"

                onchange="window.updateInventoryQty('${itemId}', this.value)">

              <span class="inv-unit">${unit}</span>

            </div>

          </td>

          <td>

            ${low

          ? `<span class="inv-low-badge">🔴 ${t("inv_low_stock", "Kam qolsa")}</span>`

          : `<span class="inv-ok-badge">✅ ${t("inv_ok_stock", "Yetarli")}</span>`}

          </td>

          <td>

            <input type="number" step="any" class="inv-threshold-input" value="${threshold}"

              title="${t("inv_threshold_hint", "Kam qolsa chegarasi")}"

              onchange="window.updateInventoryThreshold('${itemId}', this.value)">

          </td>

          <td>

            <div class="inv-delete" onclick="window.deleteInventoryItem('${itemId}')">

              <i class="fa-solid fa-trash-can"></i>

            </div>

          </td>

        </tr>

      `;

    }).join("");

  }

  window.renderKitchenInventory = renderKitchenInventory;



  function listenKitchenInventory() {

    if (_invUnsub) { _invUnsub(); _invUnsub = null; }

    const invRef = ref(db, inventoryPath());

    _invUnsub = onValue(invRef, snap => {

      _invCache = snap.val() || {};

      renderKitchenInventory();

    });

    if (window.listeners) window.listeners.kitchenInventory = _invUnsub;

  }



  window.initKitchenInventoryPanel = function () {

    try {

      listenKitchenInventory();



      const collapsed = localStorage.getItem("kitchenInventoryCollapsed") === "1";

      const wrapper = document.getElementById("kitchenInventoryWrapper");

      if (wrapper && collapsed) wrapper.classList.add("collapsed");



      renderKitchenInventory();

    } catch (e) {

      console.error(t("inv_init_error", "Omborni ishga tushirishda xato:"), e);

    }

  };



  window.toggleKitchenInventoryPanel = function () {

    const wrapper = document.getElementById("kitchenInventoryWrapper");

    if (!wrapper) return;

    const isCollapsed = wrapper.classList.toggle("collapsed");

    localStorage.setItem("kitchenInventoryCollapsed", isCollapsed ? "1" : "0");

  };



  window.addInventoryItem = async function () {

    const nameInput = document.getElementById("invNewName");

    const qtyInput = document.getElementById("invNewQty");

    const unitInput = document.getElementById("invNewUnit");

    const thresholdInput = document.getElementById("invNewThreshold");



    const name = (nameInput?.value || "").trim();

    const qty = parseFloat(qtyInput?.value);

    const unit = unitInput?.value || "kg";

    const threshold = parseFloat(thresholdInput?.value);



    if (!name || isNaN(qty)) {

      [nameInput, qtyInput].forEach(el => {

        if (el && !String(el.value).trim()) {

          el.style.border = "2px solid #ef4444";

          setTimeout(() => { el.style.border = ""; }, 1200);

        }

      });

      return;

    }



    const newItemRef = push(ref(db, inventoryPath()));

    try {

      await set(newItemRef, {

        name,

        qty,

        unit,

        threshold: isNaN(threshold) ? 0 : threshold,

        updatedAt: Date.now(),

        updatedBy: currentChefId || null

      });

      if (nameInput) nameInput.value = "";

      if (qtyInput) qtyInput.value = "";

      if (thresholdInput) thresholdInput.value = "";

      if (typeof showChefNotification === "function") {

        showChefNotification(`✅ ${t("inv_added", "Omborga qo'shildi")}: ${name}`);

      }

    } catch (e) {

      console.error("addInventoryItem error:", e);

    }

  };



  window.updateInventoryQty = async function (itemId, value) {

    const qty = parseFloat(value);

    if (isNaN(qty)) return;

    try {

      await update(ref(db, `${inventoryPath()}/${itemId}`), {

        qty,

        updatedAt: Date.now(),

        updatedBy: currentChefId || null

      });

    } catch (e) {

      console.error("updateInventoryQty error:", e);

    }

  };



  window.updateInventoryThreshold = async function (itemId, value) {

    const threshold = parseFloat(value);

    if (isNaN(threshold)) return;

    try {

      await update(ref(db, `${inventoryPath()}/${itemId}`), {

        threshold,

        updatedAt: Date.now(),

        updatedBy: currentChefId || null

      });

    } catch (e) {

      console.error("updateInventoryThreshold error:", e);

    }

  };



  window.deleteInventoryItem = async function (itemId) {

    try {

      await remove(ref(db, `${inventoryPath()}/${itemId}`));

    } catch (e) {

      console.error("deleteInventoryItem error:", e);

    }

  };



})();



/* ==========================================================

   WASTE MANAGEMENT — Isrofgarchilik hisobi (Chef paneli)

   Har bir yo'qotish uchun mahsulot, miqdor va sabab (Expired /

   Burned / Boshqa) qayd etiladi. Kunlik hisobot avtomatik

   hisoblanadi.

   Firebase yo'li: restaurants/{restId}/wasteLog/{dateKey}/{entryId}

   entryId: {

     name: "Go'sht",

     qty: 2,

     unit: "kg",

     reason: "expired" | "burned" | "other",

     createdAt, createdBy

   }

========================================================== */

(function wasteMgmtModule() {



  let _wasteCache = {};

  let _wasteUnsub = null;



  function todayKey() {

    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  }



  function wasteLogPath() {

    const restId = localStorage.getItem("restaurantId") || currentRestaurantId;

    return `restaurants/${restId}/wasteLog/${todayKey()}`;

  }



  function reasonLabel(reason) {

    switch (reason) {

      case "expired": return t("waste_reason_expired", "Expired");

      case "burned": return t("waste_reason_burned", "Burned");

      default: return t("waste_reason_other", "Boshqa");

    }

  }



  function reasonClass(reason) {

    switch (reason) {

      case "expired": return "waste-reason-expired";

      case "burned": return "waste-reason-burned";

      default: return "waste-reason-other";

    }

  }



  function reasonIcon(reason) {

    switch (reason) {

      case "expired": return "⏳";

      case "burned": return "🔥";

      default: return "❔";

    }

  }



  function formatTime(ts) {

    if (!ts) return "--:--";

    const d = new Date(ts);

    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  }



  function renderWasteMgmt() {

    const listEl = document.getElementById("wasteMgmtList");

    const emptyEl = document.getElementById("wasteMgmtEmpty");

    const todayCountEl = document.getElementById("wasteTodayCount");

    const totalEntriesEl = document.getElementById("wasteReportTotalEntries");

    const expiredCountEl = document.getElementById("wasteReportExpiredCount");

    const burnedCountEl = document.getElementById("wasteReportBurnedCount");

    const breakdownEl = document.getElementById("wasteReportBreakdown");

    if (!listEl) return;



    const entries = Object.entries(_wasteCache || {})

      .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));



    const total = entries.length;

    if (todayCountEl) todayCountEl.textContent = String(total);

    if (totalEntriesEl) totalEntriesEl.textContent = String(total);



    const expiredCount = entries.filter(([_, e]) => e.reason === "expired").length;

    const burnedCount = entries.filter(([_, e]) => e.reason === "burned").length;

    if (expiredCountEl) expiredCountEl.textContent = String(expiredCount);

    if (burnedCountEl) burnedCountEl.textContent = String(burnedCount);



    // Mahsulot bo'yicha yig'indi (birlik bo'yicha guruhlangan)

    const byProduct = {};

    entries.forEach(([_, e]) => {

      const key = `${e.name || ""}__${e.unit || ""}`;

      if (!byProduct[key]) byProduct[key] = { name: e.name || "", unit: e.unit || "", qty: 0 };

      const q = Number(e.qty);

      if (!isNaN(q)) byProduct[key].qty += q;

    });

    const breakdownRows = Object.values(byProduct).sort((a, b) => b.qty - a.qty);



    if (breakdownEl) {

      breakdownEl.innerHTML = breakdownRows.length === 0

        ? ""

        : breakdownRows.map(row => `

            <div class="waste-report-breakdown-row">

              <span>${escapeHtml(row.name)}</span>

              <b>${row.qty} ${escapeHtml(row.unit)}</b>

            </div>

          `).join("");

    }



    if (total === 0) {

      listEl.innerHTML = "";

      if (emptyEl) emptyEl.style.display = "block";

      return;

    }

    if (emptyEl) emptyEl.style.display = "none";



    listEl.innerHTML = entries.map(([entryId, entry]) => {

      const name = escapeHtml(entry.name || "");

      const unit = escapeHtml(entry.unit || "");

      const qty = (entry.qty === undefined || entry.qty === null) ? "" : entry.qty;



      return `

        <tr class="waste-row" data-entry-id="${entryId}">

          <td class="waste-name">${name}</td>

          <td><span class="waste-qty-badge">${qty} ${unit}</span></td>

          <td>

            <span class="waste-reason-pill ${reasonClass(entry.reason)}">

              ${reasonIcon(entry.reason)} ${reasonLabel(entry.reason)}

            </span>

          </td>

          <td class="waste-time">${formatTime(entry.createdAt)}</td>

          <td>

            <div class="waste-delete" onclick="window.deleteWasteEntry('${entryId}')">

              <i class="fa-solid fa-trash-can"></i>

            </div>

          </td>

        </tr>

      `;

    }).join("");

  }

  window.renderWasteMgmt = renderWasteMgmt;



  function listenWasteMgmt() {

    if (_wasteUnsub) { _wasteUnsub(); _wasteUnsub = null; }

    const wasteRef = ref(db, wasteLogPath());

    _wasteUnsub = onValue(wasteRef, snap => {

      _wasteCache = snap.val() || {};

      renderWasteMgmt();

    });

    if (window.listeners) window.listeners.wasteMgmt = _wasteUnsub;

  }



  window.initWasteMgmtPanel = function () {

    try {

      listenWasteMgmt();



      const collapsed = localStorage.getItem("wasteMgmtCollapsed") === "1";

      const wrapper = document.getElementById("wasteMgmtWrapper");

      if (wrapper && collapsed) wrapper.classList.add("collapsed");



      renderWasteMgmt();

    } catch (e) {

      console.error(t("waste_init_error", "Isrofgarchilik hisobini ishga tushirishda xato:"), e);

    }

  };



  window.toggleWasteMgmtPanel = function () {

    const wrapper = document.getElementById("wasteMgmtWrapper");

    if (!wrapper) return;

    const isCollapsed = wrapper.classList.toggle("collapsed");

    localStorage.setItem("wasteMgmtCollapsed", isCollapsed ? "1" : "0");

  };



  window.addWasteEntry = async function () {

    const nameInput = document.getElementById("wasteNewName");

    const qtyInput = document.getElementById("wasteNewQty");

    const unitInput = document.getElementById("wasteNewUnit");

    const reasonInput = document.getElementById("wasteNewReason");



    const name = (nameInput?.value || "").trim();

    const qty = parseFloat(qtyInput?.value);

    const unit = unitInput?.value || "kg";

    const reason = reasonInput?.value || "other";



    if (!name || isNaN(qty)) {

      [nameInput, qtyInput].forEach(el => {

        if (el && !String(el.value).trim()) {

          el.style.border = "2px solid #ef4444";

          setTimeout(() => { el.style.border = ""; }, 1200);

        }

      });

      return;

    }



    const newEntryRef = push(ref(db, wasteLogPath()));

    try {

      await set(newEntryRef, {

        name,

        qty,

        unit,

        reason,

        createdAt: Date.now(),

        createdBy: currentChefId || null

      });



      // Mavjud bo'lsa, ombordagi mos mahsulot qoldig'ini ham kamaytiramiz

      if (window.allInventoryByName && typeof window.deductInventoryByName === "function") {

        window.deductInventoryByName(name, qty, unit);

      }



      if (nameInput) nameInput.value = "";

      if (qtyInput) qtyInput.value = "";

      if (typeof showChefNotification === "function") {

        showChefNotification(`🗑️ ${t("waste_added", "Isrofgarchilik qayd etildi")}: ${name} (${qty} ${unit})`);

      }

    } catch (e) {

      console.error("addWasteEntry error:", e);

    }

  };



  window.deleteWasteEntry = async function (entryId) {

    try {

      await remove(ref(db, `${wasteLogPath()}/${entryId}`));

    } catch (e) {

      console.error("deleteWasteEntry error:", e);

    }

  };



})();



/* ==========================================================

   EQUIPMENT STATUS — Uskunalar holati (Chef paneli)

   Har bir uskuna uchun holat: working / ready / offline / maintenance

   Firebase yo'li: restaurants/{restId}/equipmentStatus/{itemId}

   itemId: {

     name: "Oven",

     status: "working" | "ready" | "offline" | "maintenance",

     updatedAt, updatedBy

   }

========================================================== */

(function equipmentStatusModule() {



  let _eqCache = {};

  let _eqUnsub = null;



  function equipmentPath() {

    const restId = localStorage.getItem("restaurantId") || currentRestaurantId;

    return `restaurants/${restId}/equipmentStatus`;

  }



  function statusLabel(status) {

    switch (status) {

      case "working": return t("eq_status_working", "Working");

      case "ready": return t("eq_status_ready", "Ready");

      case "offline": return t("eq_status_offline", "Offline");

      case "maintenance": return t("eq_status_maintenance", "Maintenance");

      default: return status || "";

    }

  }



  function statusClass(status) {

    switch (status) {

      case "working": return "eq-card-working";

      case "ready": return "eq-card-ready";

      case "offline": return "eq-card-offline";

      case "maintenance": return "eq-card-maintenance";

      default: return "";

    }

  }



  function statusIcon(status) {

    switch (status) {

      case "working": return "✅";

      case "ready": return "✅";

      case "offline": return "🔴";

      case "maintenance": return "🛠️";

      default: return "❔";

    }

  }



  function isIssue(status) {

    return status === "offline" || status === "maintenance";

  }



  function formatUpdated(ts) {

    if (!ts) return "";

    const d = new Date(ts);

    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  }



  function renderEquipmentStatus() {

    const gridEl = document.getElementById("equipmentStatusGrid");

    const emptyEl = document.getElementById("equipmentStatusEmpty");

    const issuePill = document.getElementById("eqIssuePill");

    const issueCountEl = document.getElementById("eqIssueCount");

    if (!gridEl) return;



    const entries = Object.entries(_eqCache || {})

      .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));



    const issueCount = entries.filter(([_, it]) => isIssue(it.status)).length;

    if (issueCountEl) issueCountEl.textContent = String(issueCount);

    if (issuePill) issuePill.classList.toggle("show", issueCount > 0);



    if (entries.length === 0) {

      gridEl.innerHTML = `<div class="eq-empty" id="equipmentStatusEmpty" data-i18n="eq_empty">${t("eq_empty", "Uskunalar ro'yxati bo'sh. Pastdan qo'shing.")}</div>`;

      return;

    }



    gridEl.innerHTML = entries.map(([itemId, item]) => {

      const name = escapeHtml(item.name || "");

      const status = item.status || "working";

      const updatedTxt = formatUpdated(item.updatedAt);



      return `

        <div class="eq-card ${statusClass(status)}" data-item-id="${itemId}">

          <div class="eq-card-head">

            <div class="eq-card-name">

              <span class="eq-card-icon">${statusIcon(status)}</span>

              <span>${name}</span>

            </div>

            <div class="eq-card-delete" onclick="window.deleteEquipmentItem('${itemId}')">

              <i class="fa-solid fa-trash-can"></i>

            </div>

          </div>

          <select class="eq-status-select" onchange="window.updateEquipmentStatus('${itemId}', this.value)">

            <option value="working" ${status === "working" ? "selected" : ""}>${statusLabel("working")}</option>

            <option value="ready" ${status === "ready" ? "selected" : ""}>${statusLabel("ready")}</option>

            <option value="offline" ${status === "offline" ? "selected" : ""}>${statusLabel("offline")}</option>

            <option value="maintenance" ${status === "maintenance" ? "selected" : ""}>${statusLabel("maintenance")}</option>

          </select>

          ${updatedTxt ? `<div class="eq-updated">${t("eq_updated_at", "Yangilandi")}: ${updatedTxt}</div>` : ""}

        </div>

      `;

    }).join("");

  }

  window.renderEquipmentStatus = renderEquipmentStatus;



  function listenEquipmentStatus() {

    if (_eqUnsub) { _eqUnsub(); _eqUnsub = null; }

    const eqRef = ref(db, equipmentPath());

    _eqUnsub = onValue(eqRef, snap => {

      _eqCache = snap.val() || {};

      renderEquipmentStatus();

    });

    if (window.listeners) window.listeners.equipmentStatus = _eqUnsub;

  }



  window.initEquipmentStatusPanel = function () {

    try {

      listenEquipmentStatus();



      const collapsed = localStorage.getItem("equipmentStatusCollapsed") === "1";

      const wrapper = document.getElementById("equipmentStatusWrapper");

      if (wrapper && collapsed) wrapper.classList.add("collapsed");



      renderEquipmentStatus();

    } catch (e) {

      console.error(t("eq_init_error", "Uskunalar holatini ishga tushirishda xato:"), e);

    }

  };



  window.toggleEquipmentStatusPanel = function () {

    const wrapper = document.getElementById("equipmentStatusWrapper");

    if (!wrapper) return;

    const isCollapsed = wrapper.classList.toggle("collapsed");

    localStorage.setItem("equipmentStatusCollapsed", isCollapsed ? "1" : "0");

  };



  window.addEquipmentItem = async function () {

    const nameInput = document.getElementById("eqNewName");

    const statusInput = document.getElementById("eqNewStatus");



    const name = (nameInput?.value || "").trim();

    const status = statusInput?.value || "working";



    if (!name) {

      if (nameInput) {

        nameInput.style.border = "2px solid #ef4444";

        setTimeout(() => { nameInput.style.border = ""; }, 1200);

      }

      return;

    }



    const newItemRef = push(ref(db, equipmentPath()));

    try {

      await set(newItemRef, {

        name,

        status,

        updatedAt: Date.now(),

        updatedBy: currentChefId || null

      });

      if (nameInput) nameInput.value = "";

      if (typeof showChefNotification === "function") {

        showChefNotification(`✅ ${t("eq_added", "Uskuna qo'shildi")}: ${name}`);

      }

    } catch (e) {

      console.error("addEquipmentItem error:", e);

    }

  };



  window.updateEquipmentStatus = async function (itemId, status) {

    try {

      await update(ref(db, `${equipmentPath()}/${itemId}`), {

        status,

        updatedAt: Date.now(),

        updatedBy: currentChefId || null

      });

      if (isIssue(status) && typeof showChefNotification === "function") {

        const item = _eqCache?.[itemId];

        showChefNotification(`⚠️ ${item?.name || ""}: ${statusLabel(status)}`);

      }

    } catch (e) {

      console.error("updateEquipmentStatus error:", e);

    }

  };



  window.deleteEquipmentItem = async function (itemId) {

    try {

      await remove(ref(db, `${equipmentPath()}/${itemId}`));

    } catch (e) {

      console.error("deleteEquipmentItem error:", e);

    }

  };



})();



/* ==========================================================

   KITCHEN ANNOUNCEMENT — Manager e'lonlari (Chef paneli)

   Manager yozgan bugungi e'lonlar (masalan: VIP mehmon, 20%

   chegirma) barcha oshpazlarga real-time ko'rinadi.

   Firebase yo'li: restaurants/{restId}/kitchenAnnouncements/{dateKey}/{annId}

   annId: {

     text: "VIP mehmon — 20% chegirma",

     author: "Manager",

     createdAt, createdBy,

     readBy: { chefId: true, ... }

   }

========================================================== */

(function kitchenAnnouncementModule() {



  let _annCache = {};

  let _annUnsub = null;

  let _annKnownIds = null; // null until first snapshot loads (avoids "new" firing on initial load)



  function todayKey() {

    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  }



  function announcementPath() {

    const restId = localStorage.getItem("restaurantId") || currentRestaurantId;

    return `restaurants/${restId}/kitchenAnnouncements/${todayKey()}`;

  }



  function formatTime(ts) {

    if (!ts) return "--:--";

    const d = new Date(ts);

    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  }



  function getMyChefId() {

    return (typeof currentChefId !== "undefined" && currentChefId) || getStoredChefId?.() || sessionStorage.getItem("userId");

  }



  function renderKitchenAnnouncements() {

    const listEl = document.getElementById("kitchenAnnouncementList");

    const emptyEl = document.getElementById("kitchenAnnouncementEmpty");

    const newPill = document.getElementById("annNewPill");

    const newCountEl = document.getElementById("annNewCount");

    if (!listEl) return;



    const myId = getMyChefId();

    const entries = Object.entries(_annCache || {})

      .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));



    const unreadCount = entries.filter(([_, a]) => !a.readBy || !a.readBy[myId]).length;

    if (newCountEl) newCountEl.textContent = String(unreadCount);

    if (newPill) newPill.classList.toggle("show", unreadCount > 0);



    if (entries.length === 0) {

      listEl.innerHTML = "";

      if (emptyEl) emptyEl.style.display = "block";

      return;

    }

    if (emptyEl) emptyEl.style.display = "none";



    listEl.innerHTML = entries.map(([annId, ann]) => {

      const isUnread = !ann.readBy || !ann.readBy[myId];

      const text = escapeHtml(ann.text || "");

      const author = escapeHtml(ann.author || t("ann_default_author", "Menejer"));

      const timeTxt = formatTime(ann.createdAt);



      return `

        <div class="ann-card ${isUnread ? "ann-unread" : ""}" data-ann-id="${annId}"

          onclick="window.markAnnouncementRead('${annId}')">

          <div class="ann-card-head">

            <div class="ann-card-text">📢 ${text}</div>

            <div class="ann-card-delete" onclick="event.stopPropagation(); window.deleteKitchenAnnouncement('${annId}')">

              <i class="fa-solid fa-trash-can"></i>

            </div>

          </div>

          <div class="ann-card-meta">

            <span class="ann-card-author">${author}</span>

            <span class="ann-card-time">${timeTxt}</span>

            ${isUnread ? `<span class="ann-card-badge">${t("ann_new_badge", "Yangi")}</span>` : ""}

          </div>

        </div>

      `;

    }).join("");

  }

  window.renderKitchenAnnouncements = renderKitchenAnnouncements;



  function listenKitchenAnnouncements() {

    if (_annUnsub) { _annUnsub(); _annUnsub = null; }

    const annRef = ref(db, announcementPath());

    _annUnsub = onValue(annRef, snap => {

      _annCache = snap.val() || {};

      const currentIds = Object.keys(_annCache);

      if (_annKnownIds === null) {
        // First load: just remember what's here, don't treat any as "new"
        _annKnownIds = new Set(currentIds);
      } else {
        const newIds = currentIds.filter(id => !_annKnownIds.has(id));
        newIds.forEach(id => _annKnownIds.add(id));
        if (newIds.length > 0) {
          handleNewAnnouncementsArrived(newIds);
        }
      }

      renderKitchenAnnouncements();

    });

    if (window.listeners) window.listeners.kitchenAnnouncements = _annUnsub;

  }



  function handleNewAnnouncementsArrived(newIds) {
    const toastContainer = document.getElementById("kitchenAnnouncementToast");
    if (!toastContainer) return;

    newIds.forEach(id => {
      const ann = _annCache[id];
      if (!ann) return;

      const text = escapeHtml(ann.text || "");
      const author = escapeHtml(ann.author || t("ann_default_author", "Menejer"));
      const timeTxt = formatTime(ann.createdAt);

      const card = document.createElement("div");
      card.className = "ann-toast-card";
      card.dataset.annId = id;
      card.innerHTML = `
        <i class="fa-solid fa-bullhorn ann-toast-icon"></i>
        <div class="ann-toast-body">
          <div class="ann-toast-text">${text}</div>
          <div class="ann-toast-meta">
            <span class="ann-toast-author">${author}</span>
            <span class="ann-toast-time">${timeTxt}</span>
          </div>
        </div>
      `;
      toastContainer.appendChild(card);

      // Trigger the show animation on next frame
      requestAnimationFrame(() => card.classList.add("show"));

      // This toast gets its own independent 5s lifetime, regardless of
      // whether other announcements arrive in the meantime.
      setTimeout(() => {
        card.classList.remove("show");
        setTimeout(() => card.remove(), 250); // let the fade-out finish
      }, 5000);
    });
  }

  window.initKitchenAnnouncementPanel = function () {

    try {

      listenKitchenAnnouncements();



      const storedCollapsed = localStorage.getItem("kitchenAnnouncementCollapsed");

      const collapsed = storedCollapsed === null ? true : storedCollapsed === "1";

      const wrapper = document.getElementById("kitchenAnnouncementWrapper");

      if (wrapper) {
        if (collapsed) {
          wrapper.classList.add("collapsed");
        } else {
          wrapper.classList.remove("collapsed");
        }
      }



      renderKitchenAnnouncements();

    } catch (e) {

      console.error(t("ann_init_error", "E'lonlarni ishga tushirishda xato:"), e);

    }

  };



  let _annManualOpenToken = 0;

  window.toggleKitchenAnnouncementPanel = function () {

    const wrapper = document.getElementById("kitchenAnnouncementWrapper");

    if (!wrapper) return;

    wrapper.classList.toggle("collapsed");

    const isCollapsed = wrapper.classList.contains("collapsed");

    localStorage.setItem("kitchenAnnouncementCollapsed", isCollapsed ? "1" : "0");

    if (isCollapsed) {
      // Closed by hand — invalidate any pending 10s auto-close so it
      // doesn't fire later and touch a panel the user has since reopened.
      _annManualOpenToken++;
    } else {
      // Opened by hand — schedule auto-close 10s from this exact opening.
      const myToken = ++_annManualOpenToken;
      setTimeout(() => {
        if (myToken !== _annManualOpenToken) return; // superseded by a later open/close
        wrapper.classList.add("collapsed");
        localStorage.setItem("kitchenAnnouncementCollapsed", "1");
      }, 10000);
    }

  };



  window.addKitchenAnnouncement = async function () {

    const textInput = document.getElementById("annNewText");

    const text = (textInput?.value || "").trim();



    if (!text) {

      if (textInput) {

        textInput.style.border = "2px solid #ef4444";

        setTimeout(() => { textInput.style.border = ""; }, 1200);

      }

      return;

    }



    const authorName = window.allChefs?.[currentChefId]?.name || sessionStorage.getItem("name") || t("ann_default_author", "Menejer");

    const newAnnRef = push(ref(db, announcementPath()));

    try {

      await set(newAnnRef, {

        text,

        author: authorName,

        createdAt: Date.now(),

        createdBy: currentChefId || null,

        readBy: {}

      });

      if (textInput) textInput.value = "";

      if (typeof showChefNotification === "function") {

        showChefNotification(`📢 ${t("ann_sent", "E'lon yuborildi")}`);

      }

    } catch (e) {

      console.error("addKitchenAnnouncement error:", e);

    }

  };



  window.markAnnouncementRead = async function (annId) {

    const myId = getMyChefId();

    if (!myId) return;

    try {

      await update(ref(db, `${announcementPath()}/${annId}/readBy`), { [myId]: true });

    } catch (e) {

      console.error("markAnnouncementRead error:", e);

    }

  };



  window.deleteKitchenAnnouncement = async function (annId) {

    try {

      await remove(ref(db, `${announcementPath()}/${annId}`));

    } catch (e) {

      console.error("deleteKitchenAnnouncement error:", e);

    }

  };



})();



/* ==========================================================

   VOICE ASSISTANT — Ovozli yordamchi (Chef paneli)

   Chef qo'li band bo'lganda ovoz orqali buyruq berish uchun.

   Brauzerning Web Speech API (SpeechRecognition) ishlatiladi

   — server tomon shart emas, faqat lokal ravishda ishlaydi.



   Qo'llab-quvvatlanadigan buyruqlar (UZ/RU/EN so'zlar bilan):

     "Order 205 Open"    -> #205 buyurtmani boshlash (startCooking)

     "Order 205 Ready"   -> #205 buyurtmani tayyor deb belgilash

     "Next Order"        -> navbatdagi (eng eski faol) buyurtmani ochish

========================================================== */

(function voiceAssistantModule() {



  let _recognition = null;

  let _isListening = false;



  function getSpeechRecognitionCtor() {

    return window.SpeechRecognition || window.webkitSpeechRecognition || null;

  }



  function setHeardText(txt) {

    const el = document.getElementById("vaHeardText");

    if (el) el.textContent = txt || "—";

  }



  function setListeningUI(listening) {

    _isListening = listening;

    const micBtn = document.getElementById("vaMicBtn");

    const livePill = document.getElementById("vaLivePill");

    if (micBtn) micBtn.classList.toggle("listening", listening);

    if (livePill) livePill.classList.toggle("show", listening);

  }



  function showResult(kind, orderText, subText) {

    const card = document.getElementById("vaResultCard");

    const icon = document.getElementById("vaResultIcon");

    const orderEl = document.getElementById("vaResultOrder");

    const subEl = document.getElementById("vaResultSub");

    if (!card) return;



    card.classList.remove("va-result-error");

    if (kind === "error") card.classList.add("va-result-error");



    if (icon) icon.textContent = kind === "error" ? "⚠️" : "✅";

    if (orderEl) orderEl.textContent = orderText || "—";

    if (subEl) subEl.textContent = subText || "";

    card.classList.add("show");

  }



  function speak(text) {

    try {

      if (!("speechSynthesis" in window)) return;

      const utter = new SpeechSynthesisUtterance(text);

      utter.lang = (getLang && getLang() === "ru") ? "ru-RU" : (getLang && getLang() === "en") ? "en-US" : "uz-UZ";

      utter.rate = 1;

      window.speechSynthesis.cancel();

      window.speechSynthesis.speak(utter);

    } catch (e) { /* ovoz chiqarish ixtiyoriy, xato bo'lsa e'tiborsiz qoldiramiz */ }

  }



  // Buyurtma raqamiga mos ID topish: buyurtma raqami odatda orderId ning

  // oxirgi 4 ta belgisi sifatida ko'rsatiladi (masalan #205 → orderId .../205 yoki shu raqam bilan tugaydi)

  function findOrderIdByNumber(numStr) {

    const orders = window.allOrders || {};

    const num = String(numStr).trim();

    let found = Object.keys(orders).find(id => id === num);

    if (found) return found;

    found = Object.keys(orders).find(id => id.endsWith(num));

    if (found) return found;

    found = Object.keys(orders).find(id => {

      const o = orders[id];

      return String(o?.orderNumber || o?.number || "").trim() === num;

    });

    return found || null;

  }



  function findNextActiveOrderId() {

    const orders = window.allOrders || {};

    const entries = Object.entries(orders)

      .filter(([_, o]) => o && o.status && o.status !== "ready" && o.status !== "finished" && o.status !== "cancelled")

      .sort((a, b) => (a[1].createdAt || a[1].timestamp || 0) - (b[1].createdAt || b[1].timestamp || 0));

    return entries.length ? entries[0][0] : null;

  }



  function shortOrderLabel(orderId) {

    return `#${String(orderId).slice(-4)}`;

  }



  async function handleOpenCommand(orderNum) {

    const orderId = findOrderIdByNumber(orderNum);

    if (!orderId) {

      showResult("error", `#${orderNum}`, t("va_order_not_found", "Bunday raqamli buyurtma topilmadi"));

      speak(t("va_order_not_found", "Bunday raqamli buyurtma topilmadi"));

      return;

    }

    try {

      if (typeof window.startCooking === "function") {

        await window.startCooking(orderId);

      } else if (typeof window.acceptOrder === "function") {

        await window.acceptOrder(orderId);

      }

      showResult("ok", shortOrderLabel(orderId), t("va_order_opened", "Buyurtma ochildi va tayyorlash boshlandi"));

      speak(`${t("va_order_opened_speech", "Buyurtma ochildi")} ${orderNum}`);

    } catch (e) {

      console.error("voice handleOpenCommand error:", e);

      showResult("error", shortOrderLabel(orderId), t("va_action_failed", "Amalni bajarib bo'lmadi"));

    }

  }



  async function handleReadyCommand(orderNum) {

    const orderId = findOrderIdByNumber(orderNum);

    if (!orderId) {

      showResult("error", `#${orderNum}`, t("va_order_not_found", "Bunday raqamli buyurtma topilmadi"));

      speak(t("va_order_not_found", "Bunday raqamli buyurtma topilmadi"));

      return;

    }

    try {

      if (typeof window.markOrderReady === "function") {

        await window.markOrderReady(orderId);

      }

      showResult("ok", shortOrderLabel(orderId), t("va_order_ready", "Buyurtma tayyor deb belgilandi"));

      speak(`${t("va_order_ready_speech", "Buyurtma tayyor")} ${orderNum}`);

    } catch (e) {

      console.error("voice handleReadyCommand error:", e);

      showResult("error", shortOrderLabel(orderId), t("va_action_failed", "Amalni bajarib bo'lmadi"));

    }

  }



  function handleNextOrderCommand() {

    const orderId = findNextActiveOrderId();

    if (!orderId) {

      showResult("error", t("va_no_next_order", "Navbatda buyurtma yo'q"), "");

      speak(t("va_no_next_order", "Navbatda buyurtma yo'q"));

      return;

    }

    const card = document.querySelector(`.order-card[data-order-id="${orderId}"]`) ||

      document.getElementById(orderId) ||

      document.querySelector(`[data-order-id="${orderId}"]`);

    if (card && card.scrollIntoView) {

      card.scrollIntoView({ behavior: "smooth", block: "center" });

      card.style.outline = "3px solid #7c3aed";

      setTimeout(() => { card.style.outline = ""; }, 2000);

    }

    showResult("ok", shortOrderLabel(orderId), t("va_next_order_shown", "Navbatdagi buyurtma ko'rsatildi"));

    speak(`${t("va_next_order_speech", "Navbatdagi buyurtma")} ${shortOrderLabel(orderId)}`);

  }



  function parseAndRunCommand(rawText) {

    const text = String(rawText || "").toLowerCase().trim();

    setHeardText(rawText);

    if (!text) return;



    // "Next Order" / "Navbatdagi buyurtma" / "keyingi buyurtma"

    if (/next\s*order|navbatdagi\s*buyurtma|keyingi\s*buyurtma|следующий\s*заказ/.test(text)) {

      handleNextOrderCommand();

      return;

    }



    // "Order 205 Open" / "Buyurtma 205 Ochish" / "заказ 205 открыть"

    const openMatch = text.match(/(?:order|buyurtma|заказ)\D*(\d+)\D*(open|ochish|boshlash|открыть|начать)/);

    if (openMatch) {

      handleOpenCommand(openMatch[1]);

      return;

    }



    // "Order 205 Ready" / "Buyurtma 205 Tayyor" / "заказ 205 готово"

    const readyMatch = text.match(/(?:order|buyurtma|заказ)\D*(\d+)\D*(ready|tayyor|готов[оa]?)/);

    if (readyMatch) {

      handleReadyCommand(readyMatch[1]);

      return;

    }



    // Faqat raqam va "open"/"ready" so'zi teskari tartibda bo'lsa ham urinib ko'ramiz

    const numMatch = text.match(/(\d{2,})/);

    if (numMatch && /open|ochish|boshlash|открыть|начать/.test(text)) {

      handleOpenCommand(numMatch[1]);

      return;

    }

    if (numMatch && /ready|tayyor|готов/.test(text)) {

      handleReadyCommand(numMatch[1]);

      return;

    }



    showResult("error", t("va_cmd_not_recognized", "Buyruq tushunilmadi"), rawText);

  }



  function createRecognition() {

    const Ctor = getSpeechRecognitionCtor();

    if (!Ctor) return null;



    const rec = new Ctor();

    rec.continuous = false;

    rec.interimResults = false;

    rec.maxAlternatives = 1;

    rec.lang = (getLang && getLang() === "ru") ? "ru-RU" : (getLang && getLang() === "en") ? "en-US" : "uz-UZ";



    rec.onstart = () => setListeningUI(true);

    rec.onend = () => setListeningUI(false);

    rec.onerror = (e) => {

      setListeningUI(false);

      if (e.error !== "no-speech" && e.error !== "aborted") {

        console.error("SpeechRecognition error:", e.error);

      }

    };

    rec.onresult = (event) => {

      const transcript = event.results?.[0]?.[0]?.transcript || "";

      parseAndRunCommand(transcript);

    };



    return rec;

  }



  window.toggleVoiceListening = function () {

    if (!_recognition) {

      _recognition = createRecognition();

      if (!_recognition) return;

    }

    if (_isListening) {

      _recognition.stop();

      return;

    }

    try {

      _recognition.lang = (getLang && getLang() === "ru") ? "ru-RU" : (getLang && getLang() === "en") ? "en-US" : "uz-UZ";

      _recognition.start();

    } catch (e) {

      // ba'zan tez-tez bosilsa "already started" xatosi chiqadi — e'tiborsiz qoldiramiz

    }

  };



  window.initVoiceAssistantPanel = function () {

    try {

      const supportedEl = document.getElementById("voiceAssistantSupported");

      const unsupportedEl = document.getElementById("voiceAssistantUnsupported");

      const hasSupport = !!getSpeechRecognitionCtor();



      if (!hasSupport) {

        if (supportedEl) supportedEl.style.display = "none";

        if (unsupportedEl) unsupportedEl.style.display = "block";

      } else {

        if (supportedEl) supportedEl.style.display = "block";

        if (unsupportedEl) unsupportedEl.style.display = "none";

      }



      const collapsed = localStorage.getItem("voiceAssistantCollapsed") === "1";

      const wrapper = document.getElementById("voiceAssistantWrapper");

      if (wrapper && collapsed) wrapper.classList.add("collapsed");

    } catch (e) {

      console.error(t("va_init_error", "Ovozli yordamchini ishga tushirishda xato:"), e);

    }

  };



  window.toggleVoiceAssistantPanel = function () {

    const wrapper = document.getElementById("voiceAssistantWrapper");

    if (!wrapper) return;

    const isCollapsed = wrapper.classList.toggle("collapsed");

    localStorage.setItem("voiceAssistantCollapsed", isCollapsed ? "1" : "0");

  };



})();

// ══════════════════════════════════════════════════════

// 🕐 HEADER SANA+VAQTI — waiter.html'dagi liveDateTime() bilan AYNAN bir
// xil formatlovchi (reuse, yangi formatter yozilmadi): restoran nomi
// ("New") ostidagi #chefHeaderDateTime'ni joriy tilga mos formatda
// har soniyada yangilab turadi. Avval bu yerda faqat HH:MM:SS ko'rsatib,
// alohida #chefHeaderClock (actions qatorida, "🟢 Online" bilan yonma-yon)
// ga yozilardi — endi waiter panel bilan bir xil, sana+vaqt birga,
// markazda, "New" ostida chiqadi.

// ══════════════════════════════════════════════════════

// 🩹 ROOT-CAUSE FIX (o'zbek tilida "2026 M08 18" kabi noto'g'ri sana,
// ingliz/rus tillari orasida beqaror almashinish) — avval Intl.
// toLocaleDateString ishlatilardi; "uz-UZ" locale'i uchun ko'p brauzer/
// OS'da to'liq o'zbekcha oy nomlari ICU ma'lumotida yo'q, shuning uchun
// tarjima qilinmagan generik fallback ("M08") chiqardi. Endi oy nomi
// Intl'dan EMAS, loyihaning o'z t()/langs.js kalitlaridan olinadi.
(function initChefHeaderDateTime() {

  const el = document.getElementById("chefHeaderDateTime");

  if (!el) return;

  const MONTH_KEYS = ["month_jan","month_feb","month_mar","month_apr","month_may","month_jun",
                       "month_jul","month_aug","month_sep","month_oct","month_nov","month_dec"];
  function pad2(n) { return String(n).padStart(2, "0"); }

  function tick() {

    const now = new Date();

    // 🩹 getLang() ishlatiladi (avval localStorage.getItem("lang") —
    // legacy kalit, i18n.js'ning haqiqiy joriy tili "app_lang" kalitida
    // saqlanadi — t() ham shundan o'qiydi).
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