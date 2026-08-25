import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
  import { getDatabase, forceWebSockets, ref, get, set, update, push, onValue, runTransaction }
    from "./pgRtdb.js";
  // 🔒 P0 AUTH FIX (same root cause as waiter.js) — kassa.js never imported
  // firebase-auth.js, so it never had a Firebase Auth session even though
  // login.js already signed one in (signInWithCustomToken) before
  // redirecting here. Without getAuth(app), the Auth "component" is never
  // registered for this page's app instance, so every restaurants/{restId}/...
  // read/write goes out with no token — denied by database.rules.json's
  // top-level `auth != null` requirement. getAuth(app) + the top-level
  // `await auth.authStateReady()` below (this file has no init()-style boot
  // function — everything runs top-level — so a top-level await, legal in
  // an ES module, is the equivalent gate) restores whatever real session is
  // already persisted for this origin before any Firebase call fires.
  import { getAuth, signInWithCustomToken, setPersistence, inMemoryPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
  import { langData } from "./langs.js";
  import { ORDER_STATUS_V2, writeOrderAuditLog, normalizeOrderType, ORDER_TYPE, formatDeliveryAddress, approveOrderChangeRequest, rejectOrderChangeRequest, getTableTypeMeta } from "./shared.js";
  import { PAYMENT_METHOD_REGISTRY, getEnabledPaymentMethods, paymentMethodLabel, writeUnifiedPayment } from "./paymentEngine.js";
  import { printReceiptInPopup, downloadReceiptHtmlFile, buildReceiptBodyHtml } from "./receiptEngine.js";
  import { discountClaimsClient } from "./discountClaimsClient.js";
  import { mountStaffFooter, updateStaffFooter } from "./staffFooter.js";

  // Force WebSocket-only transport (never fall back to `.lp` long-polling) —
  // first executable statement in this module.
  forceWebSockets();

  // 🆕 YAGONA STAFF FOOTER — kassada bottom-nav yo'q, fixed rejimda.
  const _staffFooterEl = mountStaffFooter({ fixed: true });


  // ─── Buyurtma raqamini formatlash: ORD31 (restoran ichi), Take31 (olib ketish) yoki Del31 (yetkazib berish) ───
  // shared.js dagi normalizeOrderType() bilan bir xil mantiq — barcha panellarda buyurtma raqami bir xil ko'rinsin.
  function formatOrderNumber(orderOrNumber, isDeliveryFlag) {
    let num, prefix;
    if (orderOrNumber && typeof orderOrNumber === "object") {
      num = orderOrNumber.orderNumber;
      const type = normalizeOrderType(orderOrNumber);
      prefix = type === ORDER_TYPE.DELIVERY ? "Del" : type === ORDER_TYPE.TAKEAWAY ? "Take" : "ORD";
    } else {
      num = orderOrNumber;
      prefix = isDeliveryFlag ? "Del" : "ORD";
    }
    if (num === undefined || num === null || num === "") return null;
    return `${prefix}${String(num)}`;
  }
  window.formatOrderNumber = formatOrderNumber;

  // ── i18n ──
  let currentLang = localStorage.getItem("lang") || "uz";
  let L = langData[currentLang] || langData["uz"];
  function t(key, vars) {
    const found = L[key] !== undefined ? L[key] : langData["uz"][key];
    // vars — odatda interpolatsiya obyekti, lekin chat-system.js kabi tashqi
    // skriptlar t(key, "fallback matni") shaklida ishlatadi (i18n.js uslubi)
    let str = found !== undefined ? found : (typeof vars === "string" ? vars : key);
    if (vars && typeof vars === "object") Object.entries(vars).forEach(([k,v]) => { str = str.replace(`{${k}}`, v); });
    return str;
  }
  // chat-system.js kabi tashqi skriptlar global t()/onLangChange() ga tayanadi
  window.t = t;
  const _langChangeListeners = [];
  window.onLangChange = function (cb) { if (typeof cb === "function") _langChangeListeners.push(cb); };
  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach(el => {
      const k = el.getAttribute("data-i18n");
      if (el.hasAttribute("data-i18n-html")) el.innerHTML = t(k);
      else el.textContent = t(k);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
      el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
    });
    document.querySelectorAll("[data-i18n-title]").forEach(el => {
      el.title = t(el.getAttribute("data-i18n-title"));
    });
    document.title = t("kassa_page_title", "YesPOS — Kassa");
    // 🩹 Stol buyurtma ekranidagi summa qatorlari (ktoSubtotal/ktoDiscount/
    // ktoServiceFee/ktoGrandTotal) — hali stol ochilmagan bo'lsa "0"
    // boshlang'ich qiymatida turadi. Bu yerda ularni fmt(0) orqali joriy
    // tilning valyuta birligi bilan to'ldiramiz; stol ochilsa renderKtoTotals()
    // baribir haqiqiy qiymat bilan ustidan yozadi, shuning uchun bu yerda
    // shartsiz qo'yish xavfsiz (ktoOrderId hali e'lon qilinmagan bo'lishi
    // mumkin — applyI18n() sahifa yuklanganda shu funksiyalar e'lon
    // qilinishidan OLDIN chaqiriladi).
    ["ktoSubtotal","ktoDiscount","ktoServiceFee","ktoTableService","ktoGrandTotal"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = fmt(0);
    });
  }
  applyI18n();

  // Faqat langs.js'da haqiqatan mavjud bo'lgan tillar ko'rsatiladi — bu fayl
  // shu sessiyada yuklanmagani uchun ro'yxatni oldindan qattiq belgilamaymiz.
  const LANG_DISPLAY_NAMES = { uz: "O'zbekcha", ru: "Русский", en: "English" };
  function langDisplayName(code) { return LANG_DISPLAY_NAMES[code] || code.toUpperCase(); }
  const AVAILABLE_LANGS = Object.keys(langData);

  function populateLangMenu() {
    const menu = document.getElementById("kassaLangMenu");
    const label = document.getElementById("kassaLangLabel");
    if (!menu) return;
    menu.innerHTML = AVAILABLE_LANGS.map(code => `
      <button class="lang-menu-item ${code === currentLang ? "active" : ""}"
              data-lang="${code}" onclick="window.setKassaLang('${code}')">
        ${langDisplayName(code)}
      </button>`).join("");
    if (label) label.textContent = langDisplayName(currentLang);
  }
  populateLangMenu();

  window.toggleKassaLangMenu = function () {
    document.getElementById("kassaLangMenu")?.classList.toggle("open");
  };
  // Menyudan tashqariga bosilsa yopiladi
  document.addEventListener("click", (e) => {
    const wrap = document.getElementById("kassaLangWrap");
    if (wrap && !wrap.contains(e.target)) {
      document.getElementById("kassaLangMenu")?.classList.remove("open");
    }
  });

  // ── Tilni reload'siz almashtirish. applyI18n() faqat statik data-i18n
  //    elementlarini yangilaydi — ko'p render funksiyalari (renderHallMap,
  //    renderOrder, renderReport, renderHistory va h.k.) t() qiymatini
  //    to'g'ridan-to'g'ri HTML shabloniga yozib qo'yadi, shuning uchun ular
  //    joriy ko'rinayotgan sahifaga qarab qayta chaqiriladi. ──
  window.setKassaLang = function (lang) {
    if (!langData[lang] || lang === currentLang) return;
    currentLang = lang;
    localStorage.setItem("lang", lang);
    L = langData[currentLang] || langData["uz"];
    applyI18n();
    refreshVisiblePageAfterLangChange();
    _langChangeListeners.forEach(cb => { try { cb(currentLang); } catch (_) {} });

    const btnLabel = document.getElementById("kassaLangLabel");
    if (btnLabel) btnLabel.textContent = langDisplayName(lang);
    document.querySelectorAll(".lang-menu-item").forEach(el => {
      el.classList.toggle("active", el.dataset.lang === lang);
    });
    document.getElementById("kassaLangMenu")?.classList.remove("open");
  };

  function refreshVisiblePageAfterLangChange() {
    const mapVisible     = document.getElementById("pageMap")?.style.display     !== "none";
    const kassaVisible   = document.getElementById("pageKassa")?.style.display   !== "none";
    const historyVisible = document.getElementById("pageHistory")?.style.display !== "none";
    const reportVisible  = document.getElementById("pageReport")?.style.display  !== "none";

    if (mapVisible) { renderKassaHallFilter(); renderHallMap(); }
    if (kassaVisible && currentOrder) renderOrder(currentOrder);
    if (historyVisible) renderHistory();
    if (reportVisible) renderReport();
    // pageTableOrder alohida to'liq ekran — ochiq bo'lsa shu stol uchun qayta quramiz
    if (ktoTableKey && document.getElementById("pageTableOrder")?.style.display !== "none") {
      window.openTableOrderScreen(ktoTableKey);
    }
  }

  // ── DARK / LIGHT TEMA — admin.js/waiter.js'dagi window.toggleTheme()/
  // initTheme() bilan AYNAN bir xil naqsh: bir xil localStorage kaliti
  // ("app_theme") va bir xil <html data-theme="dark"> atributi (design-
  // system.css/header.css/kassa.css allaqachon shu atributni o'qiydi) —
  // shuning uchun bitta qurilmada boshqa panelda tanlangan tema, Kassa
  // panelini ochganda ham darhol qo'llanadi. Yangi tema tizimi yaratilmadi.
  (function initKassaTheme() {
    try {
      const saved = localStorage.getItem("app_theme");
      if (saved === "dark") document.documentElement.setAttribute("data-theme", "dark");
    } catch { /* localStorage mavjud emas — light standart holat */ }
  })();

  window.toggleKassaTheme = function () {
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

  const firebaseConfig = {
    apiKey:            "AIzaSyCGCCIP3eFg40bOEENDLGcrw9c484ySCHQ",
    authDomain:        "restoran-30d51.firebaseapp.com",
    databaseURL:       "https://restoran-30d51-default-rtdb.firebaseio.com",
    projectId:         "restoran-30d51",
    storageBucket:     "restoran-30d51.firebasestorage.app",
    messagingSenderId: "your-sender-id",
    appId:             "your-app-id"
  };

  const app  = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const db   = getDatabase(app);
  const auth = getAuth(app);

  // ── Online/Offline ko'rsatkich olib tashlandi — offline-queue-ui.js fayli
  // serverda mavjud emas. Agar kerak bo'lsa, shu faylni loyihaga qo'shib,
  // yuqoridagi importni va shu chaqiruvni qayta tiklash mumkin. ──

  const params       = new URLSearchParams(window.location.search);
  const restaurantId = params.get("rest") || localStorage.getItem("restaurantId") || localStorage.getItem("clientRestaurantId");
  const openTableKey = params.get("openTable"); // admin panelidan "Kassa paneli" tugmasi orqali kelganda shu stol popoveri avtomatik ochiladi

  // ── Admin panelidan "kuzatuvchi sifatida kirish" (viewAs) orqali ochilganda ──
  // Bunday holatda sessionStorage'da "role"/"userId" hali yozilmagan bo'lishi
  // mumkin (yangi tab/oyna), shuning uchun URL'dagi viewAs parametridan
  // foydalanib sessiyani shu yerda to'g'irlaymiz — aks holda ruxsat
  // tekshiruvi ishlamay, foydalanuvchi login sahifasiga qaytarib yuboriladi.
  const viewAsId = params.get("viewAs");
  if (viewAsId && restaurantId) {
    localStorage.setItem("restaurantId", restaurantId);
    sessionStorage.setItem("userId", viewAsId);
    sessionStorage.setItem("role", "cashier");
    sessionStorage.setItem("isViewingAsAdmin", "true");

    // 🩹 P0 root-cause fix (this pass, same as chef.js/waiter.js/courier.js):
    // viewAs used to carry ONLY these cosmetic URL params — no real
    // Firebase Auth session — silently relying on the calling admin's own
    // session leaking into this tab via shared browser storage. That
    // stopped working the moment login.js was scoped to tab-local
    // persistence (a separate, deliberate fix — see that file's own header
    // comment). admin.js's "Sahifaga o'tish" now mints a real session via
    // backend routes/auth.js's new /staff-view-as and passes it here as a
    // one-time ssoToken — same pattern admin.js's own "Login As" already
    // uses for itself. Top-level await is legal here (this file is an ES
    // module, no init()-style boot function — see this file's own header
    // comment on that) and deliberately blocks the rest of this module's
    // boot, including the `await auth.authStateReady()` a few lines below,
    // until the real session is signed in.
    const ssoToken = params.get("ssoToken");
    if (ssoToken) {
      try {
        await setPersistence(auth, inMemoryPersistence);
        await signInWithCustomToken(auth, ssoToken);
      } catch (ssoErr) {
        console.warn("[KASSA-AUTH] ssoToken sign-in failed:", ssoErr?.code || ssoErr?.message);
      }
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("ssoToken");
      history.replaceState(null, "", cleanUrl.toString());
    }
  }

  if (!restaurantId) document.getElementById("configWarning").style.display = "block";

  // ── 🔒 RUXSAT NAZORATI (ACCESS GUARD) ──
  // Ilgari bu yerda hech qanday tekshiruv yo'q edi: kod faqat localStorage'dan
  // ismni ("staffName"/"name") o'qib, mavjud bo'lmasa "Kassir" degan
  // defolt qiymat bilan sahifani ochib yuborardi. Bu — login qilgan HAR
  // QANDAY xodim (oshpaz, ofitsiant va h.k.) kassa.html manzilini
  // to'g'ridan-to'g'ri ochsa, hech qanday to'siqsiz kira olishiga sabab
  // bo'lgan asosiy kamchilik edi.
  //
  // MUHIM: rol endi login paytida sessionStorage'ga "role" kaliti bilan
  // yoziladi (localStorage'ga EMAS) — sabab: localStorage butun brauzer
  // bo'yicha umumiy, agar bir tabda admin, boshqa tabda kassir bilan login
  // qilingan bo'lsa, ikkalasi bir-birining sessiyasini bosib o'tar edi.
  // Faqat "cashier" yoki "admin" rollariga sahifa ochiladi; boshqa har
  // qanday rol (yoki rol umuman yozilmagan bo'lsa) darhol login
  // sahifasiga qaytariladi va qolgan skript ishga tushmaydi.
  const ALLOWED_KASSA_ROLES = ["cashier", "admin"];
  const currentUserRole     = sessionStorage.getItem("role");

  if (!ALLOWED_KASSA_ROLES.includes(currentUserRole)) {
    window.location.href = "login.html";
    throw new Error("Kirish rad etildi: joriy rol (\"" + currentUserRole + "\") kassa sahifasiga ruxsat etilmagan.");
  }

  // 🔒 Bu fayl waiter.js'dagi kabi bitta async init() funksiyasiga ega emas —
  // butun skript modul darajasida yuqoridan pastga ishlaydi, shuning uchun
  // pastdagi HAR QANDAY Firebase o'qish/yozishdan oldin (birinchisi darhol
  // quyida — restaurants/{restId}/info/status) shu yerda kutamiz. Bu ES
  // modulida qonuniy top-level await — kassa.js DOMContentLoaded'ga
  // tayanmagani uchun (hech qanday addEventListener("DOMContentLoaded",...)
  // yo'q — grep bilan tasdiqlangan), bu yerda kutish biror hodisani
  // o'tkazib yuborish xavfini tug'dirmaydi.
  try {
    await auth.authStateReady();
  } catch (err) {
    console.warn("[KASSA-AUTH] authStateReady() failed:", err?.code || err?.message);
  }

  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    console.info("[KASSA-STAFF-DIAG]", {
      restId: restaurantId,
      authUid: auth.currentUser?.uid || null,
      targetUid: sessionStorage.getItem("userId") || "kassa",
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      path: `restaurants/${restaurantId}/...`
    });
  }

  const BASE = `restaurants/${restaurantId}`;

  // Bug fix: kassa.js had NO subscription/block enforcement at all, live or
  // otherwise — a cashier already on this screen could keep processing
  // payments indefinitely after Super Admin blocked/paused the restaurant
  // (window.toggleBlockRestaurant/togglePauseRestaurant in superadmin.js,
  // which writes restaurants/{id}/info/status). Mirrors the same live
  // lockout now added to waiter.js/chef.js and the existing login.js gate.
  onValue(ref(db, `${BASE}/info/status`), (statusSnap) => {
    const status = statusSnap.val();
    if (status !== "blocked" && status !== "paused") return;
    window.location.href = `expired.html?rest=${encodeURIComponent(restaurantId)}`;
  });
  // Bu ikkalasi (pageKassa pay-card gridi va KTO to'lov gridi) endi to'liq
  // ro'yxat emas — faqat "qanday tartibda joylashgan" ma'lumoti uchun
  // saqlanadi (kassa.html'dagi pm-0..pm-7 / kpm-0..kpm-4 statik tugmalar
  // shu tartibda). Qaysi tugmalar HAQIQATDA ko'rinishi endi
  // getEnabledPaymentMethods() (js/paymentEngine.js — Admin → Sozlamalar →
  // To'lov usullari) orqali belgilanadi — pastdagi applyEnabledPaymentMethodsToKassaUI().
  // "QR kod" — registrdan tashqari, avvalgidek doim ko'rinadigan alohida usul
  // (bu funksiya uchun hech qachon o'chirish sozlamasi bo'lmagan).
  const PAY_LABELS = ["Naqd","UzCard","Humo","Uzum Bank","Click","Payme","Bank karta","QR kod"];

  // ── To'lov usuli nomini ko'rsatish uchun tarjima qiladi — endi bitta
  //    umumiy manba: js/paymentEngine.js'dagi PAYMENT_METHOD_REGISTRY.
  //    PAY_LABELS/KTO_PAY_LABELS massivlaridagi qiymatlar Firebase'da
  //    payment.method sifatida saqlanadigan ICHKI kalitlar bo'lib qolaveradi
  //    (o'zgarmaydi). "QR kod" registrda yo'q — shunchaki tarjima qilinmagan
  //    holda ko'rsatiladi (avvalgidek).
  function payMethodDisplayLabel(m) {
    return paymentMethodLabel(m, t);
  }

  // pm-0..pm-7 / kpm-0..kpm-4 statik tugmalarini Admin → Sozlamalar → To'lov
  // usullari bo'yicha ko'rsatadi/yashiradi. Naqd (pm-0/kpm-0) har doim
  // ko'rinadi. "QR kod" (faqat pageKassa gridida, registrdan tashqari) ham
  // har doim ko'rinadi — bu funksiya hech qachon uni yashirmaydi.
  function applyEnabledPaymentMethodsToKassaUI() {
    const enabledKeys = new Set(getEnabledPaymentMethods(restaurantSettings).map(m => m.firebaseKey));
    PAY_LABELS.forEach((label, idx) => {
      const el = document.getElementById("pm-" + idx);
      if (!el) return;
      const visible = label === "QR kod" || enabledKeys.has(label);
      el.style.display = visible ? "" : "none";
    });
    KTO_PAY_LABELS.forEach((label, idx) => {
      const el = document.getElementById("kpm-" + idx);
      if (!el) return;
      el.style.display = enabledKeys.has(label) ? "" : "none";
    });

    // Hech qanday usul ko'rinmasa — bo'sh grid o'rniga tushunarli xabar
    // (item 11). "QR kod" pageKassa'da har doim ko'rinadigani va Naqd
    // registrda alwaysOn bo'lgani uchun amalda kamdan-kam yuzaga keladi,
    // lekin ikkala ekran ham himoyalangan.
    const payGridEmpty = document.getElementById("payGridEmpty");
    if (payGridEmpty) {
      const anyPayCardVisible = PAY_LABELS.some((label, idx) => {
        const el = document.getElementById("pm-" + idx);
        return el && el.style.display !== "none";
      });
      payGridEmpty.style.display = anyPayCardVisible ? "none" : "block";
    }
    const ktoPayMethodsEmpty = document.getElementById("ktoPayMethodsEmpty");
    if (ktoPayMethodsEmpty) {
      const anyKtoMethodVisible = KTO_PAY_LABELS.some((label, idx) => {
        const el = document.getElementById("kpm-" + idx);
        return el && el.style.display !== "none";
      });
      ktoPayMethodsEmpty.style.display = anyKtoMethodVisible ? "none" : "block";
    }

    // 🔒 Agar hozir TANLANGAN usul aynan shu o'zgarishda admin tomonidan
    // o'chirilgan bo'lsa — tanlovni bekor qilamiz (stale usul bilan to'lov
    // yozilishining oldini olish, ikkalasi ham: pageKassa Step3/4 va
    // KTO stol-to'lov ekrani). Faqat HAQIQATAN o'chirilgan bo'lsagina reset
    // qilinadi — aloqasiz sozlama o'zgarishi (mas. restoran nomi) tanlovni
    // bekor qilmaydi.
    if (selectedMethod && !enabledKeys.has(selectedMethod)) {
      selectedMethod = null;
      document.querySelectorAll(".pay-card").forEach(el => el.classList.remove("selected"));
      const payBtn = document.getElementById("payBtn");
      if (payBtn) payBtn.disabled = true;
      const cMethodEl = document.getElementById("cMethod");
      if (cMethodEl) cMethodEl.textContent = "—";
    }
    if (ktoSelectedMethod && !enabledKeys.has(ktoSelectedMethod)) {
      ktoSelectedMethod = null;
      document.querySelectorAll(".kto-pay-method").forEach(el => el.classList.remove("selected"));
      const ktoPayBtn = document.getElementById("ktoPayBtn");
      if (ktoPayBtn) ktoPayBtn.disabled = true;
      const cardRow = document.getElementById("ktoCardNumberRow");
      if (cardRow) cardRow.style.display = "none";
    }
  }

  // 🆕 Kassir identifikatori — agar boshqa sahifadan (login) userId qolgan
  // bo'lsa undan, bo'lmasa umumiy "Kassir" nomidan foydalanamiz.
  const cashierId   = sessionStorage.getItem("userId") || "kassa";
  // 🩹 ROOT CAUSE FIX — "Asosiy Boshqaruvchi" headerida noto'g'ri chiqishi:
  // bu qiymat avval FAQAT sessionStorage.staffName/name'dan olinardi va
  // hech qachon Firebase'dagi haqiqiy xodim yozuvi bilan tekshirilmasdi.
  // Admin "kuzatuvchi sifatida kirish" (viewAs, yuqorida) orqali ochilganda
  // sessionStorage.userId to'g'ri (nishonlangan kassir) qiymatga
  // yangilanadi-yu, sessionStorage.name esa YANGILANMAYDI — agar shu
  // brauzer tab/sessiyasida oldin ADMIN sifatida kirilgan bo'lsa (yoki
  // umuman eskirgan/boshqa xodimga tegishli qiymat qolib ketgan bo'lsa),
  // "Kassir" o'rniga o'sha eski ism (masalan restoran egasi "Asosiy
  // Boshqaruvchi") ko'rsatilib qolardi. Endi waiter.js'dagi
  // loadStaffName() bilan bir xil naqsh: sessionStorage faqat DARHOL
  // ko'rinadigan boshlang'ich (fallback) qiymat, undan keyin
  // restaurants/{restId}/users/{cashierId} — canonical source-of-truth —
  // asinxron o'qilib, header shu HAQIQIY ism bilan qayta yoziladi.
  let cashierName = sessionStorage.getItem("staffName") || sessionStorage.getItem("name") || "Kassir";

  // 🆕 Header: xodim nomi (rol bilan) — waiter/chef panellari bilan bir xil
  // struktura (#waiterHeaderStaffName/.w-staff, #chefHeaderName/.ch-staff).
  function renderKassaHeaderStaffName() {
    const el = document.getElementById("kassaHeaderStaffName");
    // 🩹 Rol qavs ichida ("Ism (Kassir)") olib tashlandi — waiter bilan bir
    // xil (headerda faqat ism, rol #nestaHeaderBrand'da alohida qatorda).
    if (el) el.textContent = cashierName;
  }
  renderKassaHeaderStaffName();

  (async function loadCashierRealName() {
    if (!restaurantId || !cashierId || cashierId === "kassa") return;
    try {
      const snap = await get(ref(db, `${BASE}/users/${cashierId}`));
      if (snap.exists()) {
        const staff = snap.val();
        const realName = staff?.name || staff?.fullName || "";
        if (realName) {
          cashierName = realName;
          window.currentCashierRealName = realName;
          renderKassaHeaderStaffName();
        }
      }
    } catch (e) {
      // Permission denied yoki tarmoq xatosi — panel yiqilmasin, sessionStorage
      // fallback (yuqorida allaqachon chizilgan) shunday qoladi.
      console.warn("loadCashierRealName:", e?.code || e?.message || e);
    }
  })();

  // 🆕 waiter/chef panellari bilan bir xil logout() — kassa headerida bu
  // funksiya umuman mavjud emas edi (chiqish faqat boshqa yo'llar orqali).
  window.kassaLogout = function () {
    localStorage.clear();
    sessionStorage.clear();
    location.href = "login.html";
  };

  // ── 💬 Ichki chat: Kassir → E'lonlar + Admin bilan shaxsiy chat ──
  async function getCashierChatOptions() {
    return [
      { icon: "📢", label: t("chat_announcements", "E'lonlar"), type: "announcement" },
      { icon: "👨‍💼", label: t("chat_with_admin", "Admin"), type: "admin" }
    ];
  }
  async function getCashierChatId(option) {
    if (option.type === "admin") return `admin_cashier_${cashierId}`;
    return null;
  }
  if (typeof window.initChatSystem === "function") {
    window.initChatSystem({
      currentRestaurantId: restaurantId,
      currentUserId: cashierId,
      currentRole: "cashier",
      db: db,
      getChatOptions: getCashierChatOptions,
      getChatId: getCashierChatId
    });
  }

  let currentOrder   = null;
  let selectedMethod = null;
  // 🆕 successSection'dagi "Qayta chop etish" tugmasi uchun — processPayment()
  // to'lov muvaffaqiyatli yozilgan zahoti to'ldiradi (item 14: reprint bir xil
  // kanonik receiptEngine yo'lidan foydalanishi kerak, alohida ma'lumot manbai emas).
  let _lastPaidOrder = null;
  let _lastPaidOrderId = null;
  // Live subscription on the found order (started in searchOrder(), torn
  // down in resetAll() / before starting a new search) — see the comment
  // in searchOrder() for why this replaced a one-time get().
  let _searchedOrderUnsub = null;
  let menuCache      = null; // restaurants/{id}/menu — fallback uchun (eski buyurtmalarda imgUrl/subcategory/recipe yo'q bo'lsa)
  let restaurantSettings = {}; // restaurants/{id}/settings — paymentAcceptor va h.k. uchun
  // 🆕 Admin → Sozlamalar → Chop etish sozlamalari (restaurants/{id}/printSettings)
  // — waiter.js'dagi printSettingsCache bilan bir xil naqsh: real-time onValue,
  // hech qanday qayta so'rov/refresh talab qilinmaydi (pastda initHeaderBranding
  // ichida obuna qilinadi).
  let printSettingsCache = {};

  async function getMenuCache() {
    if (menuCache) return menuCache;
    try {
      const snap = await get(ref(db, `${BASE}/menu`));
      menuCache = snap.exists() ? snap.val() : {};
    } catch (e) {
      console.warn("Menu cache yuklanmadi:", e);
      menuCache = {};
    }
    return menuCache;
  }

  // ══════════════════════════════════════════════
  // KTO (KASSA TABLE ORDER) — stol buyurtmasini ko'rish + to'lov.
  // Menyu yo'q: buyurtmani ofitsiant tuzadi, kassir faqat ko'rib to'lov qabul qiladi.
  // ══════════════════════════════════════════════
  let ktoTableKey       = null;   // ochiq turgan stol kaliti
  let ktoOrderId        = null;   // shu stolga tegishli faol buyurtma ID'si
  let ktoSelectedMethod = null;

  const KTO_PAY_LABELS = ["Naqd", "Payme", "Click", "Uzum Bank", "Bank karta"];

  // ── Ekranni ochish/yopish ──
  window.openTableOrderScreen = function (tableKey) {
    ktoTableKey = tableKey;
    const tb = tablesRaw[tableKey];
    if (!tb) return;

    const order = orderForTable(tableKey, tb);
    ktoOrderId = order ? order.key : null;
    ktoSelectedMethod = null;

    const num = tb.number || String(tb.id || tableKey).replace("table_", "");
    document.getElementById("ktoTableNum").textContent = num;

    // Mijoz: telefon raqami bo'lsa o'shani, bo'lmasa "Anonim" — customerName
    // maydoni ba'zan "Stol N" kabi avtomatik yorliq bilan to'lgan bo'lishi
    // mumkin (haqiqiy mijoz ismi emas), shuning uchun uni ko'rsatmaymiz.
    const clientPhone = order?.customerPhone || order?.clientPhone || order?.phoneNumber || "";
    document.getElementById("ktoClientLabel").textContent = clientPhone || t("client_anonymous", "Anonim");

    document.getElementById("ktoWaiterName").textContent  = order?.createdByWaiterName || order?.waiterName || order?.staffName || "—";
    document.getElementById("ktoOpenedAt").textContent = order?.createdAt
      ? new Date(order.createdAt).toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" })
      : "—";

    renderKtoOrderItems(order);
    renderKtoTotals(order);
    resetKtoPaymentUI(order);

    document.getElementById("pageMap").style.display = "none";
    document.getElementById("pageTableOrder").style.display = "block";
    // 🆕 Stol tanlanganda global tab navigatsiyasi (Zallar/Tarix/Hisobot/
    // Buyurtma o'zgarishlari) butunlay yashiriladi — detail/payment
    // interfeysi to'liq ekran kengligidan foydalansin, tablar bilan
    // ustma-ust chiqmasin. State-based (ktoTableKey/ktoOrderId, mavjud
    // canonical o'zgaruvchilar) — CSS hack emas.
    const tabNav = document.querySelector(".tab-nav");
    if (tabNav) tabNav.style.display = "none";
  };

  window.closeTableOrderScreen = function () {
    ktoTableKey = null;
    ktoOrderId  = null;
    document.getElementById("pageTableOrder").style.display = "none";
    document.getElementById("pageMap").style.display = "block";
    // 🆕 "← Stollar" bosilganda tablar qayta ko'rinadi.
    const tabNav = document.querySelector(".tab-nav");
    if (tabNav) tabNav.style.display = "";
  };

  // ── Buyurtma tarkibini faqat o'qish rejimida chizish ──
  function renderKtoOrderItems(order) {
    const listEl = document.getElementById("ktoCartList");
    if (!order || !order.items || Object.keys(order.items).length === 0) {
      listEl.innerHTML = `<div class="kto-cart-empty">${t("kassa_kto_no_active_order", "Faol buyurtma yo'q.")}</div>`;
      return;
    }
    listEl.innerHTML = "";
    Object.values(order.items).forEach(item => {
      const qty   = Number(item.qty) || 1;
      const price = Number(item.price) || 0;
      const name  = getName(item.name) || getName(item.title) || "—";
      const row = document.createElement("div");
      row.className = "kto-cart-item";
      row.innerHTML = `
        <div>
          <div class="name">${escHtml(name)}</div>
          <div class="sub">${qty} × ${fmt(price)}</div>
        </div>
        <div class="price">${fmt(price * qty)}</div>
      `;
      listEl.appendChild(row);
    });
  }

  // ── Jami/chegirma/stol xizmati/yakuniy summa ──
  function renderKtoTotals(order) {
    const items = Object.values(order?.items || {});
    const subtotal = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);
    const total    = Number(order?.total) || subtotal;
    // order.discount ba'zan to'ldirilmagan bo'lishi mumkin — bu holatda subtotal va
    // total orasidagi farqni chegirma sifatida hisoblaymiz, aks holda foydalanuvchiga
    // yakuniy summa nega kamroq ekani ko'rinmay qoladi.
    const discount = Number(order?.discount) || Math.max(0, subtotal - total);
    // 🆕 STOL XIZMAT NARXI — order yaratilganda "muzlatilgan" qiymat
    // (waiter.js bilan bir xil manba, order.tableServiceAmount). Kassa
    // buni qayta hisoblamaydi (item 9: "boshqa summa hisoblamasin") —
    // to'g'ridan-to'g'ri saqlangan qiymat ishlatiladi.
    const tableServiceAmount = Math.max(0, Number(order?.tableServiceAmount || 0)) || 0;
    const grandTotal = total + tableServiceAmount;

    document.getElementById("ktoSubtotal").textContent = fmt(subtotal);
    const discLine = document.getElementById("ktoDiscountLine");
    if (discount > 0) {
      discLine.style.display = "flex";
      document.getElementById("ktoDiscount").textContent = "−" + fmt(discount);
    } else {
      discLine.style.display = "none";
    }
    const tblSvcLine = document.getElementById("ktoTableServiceLine");
    if (tableServiceAmount > 0) {
      tblSvcLine.style.display = "flex";
      document.getElementById("ktoTableService").textContent = "+" + fmt(tableServiceAmount);
    } else {
      tblSvcLine.style.display = "none";
    }
    document.getElementById("ktoGrandTotal").textContent = fmt(grandTotal);
  }

  // ── To'lov usuli tugmalari + "To'lovni tasdiqlash" holatini boshlang'ich holatga qaytarish ──
  function resetKtoPaymentUI(order) {
    document.querySelectorAll(".kto-pay-method").forEach(el => el.classList.remove("selected"));
    const payBtn = document.getElementById("ktoPayBtn");
    const isPaid = order?.status === "to'landi" || order?.payment?.paid === true;
    const hasOrder = !!order;

    // Admin panelida "To'lovni kim qabul qiladi?" — "Ofitsiant" tanlangan bo'lsa,
    // kassir bu yerdan to'lov qabul qila olmaydi (barcha to'lov ofitsiant
    // tomonidan waiter.js orqali amalga oshiriladi). Buyurtma tarkibi va
    // summalar baribir ko'rinaveradi — faqat to'lov amali bloklanadi.
    const paymentAcceptor = restaurantSettings?.paymentAcceptor || "kassir";
    const kassirCanAcceptPayment = paymentAcceptor === "kassir";

    payBtn.disabled = true;
    if (isPaid) {
      payBtn.innerHTML = t("kassa_kto_pay_btn_paid", "✅ To'langan");
    } else if (!kassirCanAcceptPayment) {
      payBtn.innerHTML = t("kassa_kto_pay_btn_waiter_only", "🧑‍🍳 To'lovni ofitsiant qabul qiladi");
    } else {
      payBtn.innerHTML = "💳 " + t("kassa_kto_confirm_payment", "To'lovni tasdiqlash");
    }

    document.querySelectorAll(".kto-pay-method").forEach(el => {
      el.style.pointerEvents = (isPaid || !hasOrder || !kassirCanAcceptPayment) ? "none" : "";
      el.style.opacity       = (isPaid || !hasOrder || !kassirCanAcceptPayment) ? ".5" : "";
    });
    // Karta raqami maydoni — yangi stol ochilganda oldingi qiymat/holat qolib
    // ketmasligi uchun tozalab, yashirib qo'yamiz.
    const cardInput = document.getElementById("ktoCardNumberInput");
    if (cardInput) cardInput.value = "";
    const cardRow = document.getElementById("ktoCardNumberRow");
    if (cardRow) cardRow.style.display = "none";
  }

  window.selKtoMethod = function (method) {
    const order = ktoOrderId ? ordersRaw[ktoOrderId] : null;
    if (!order) return;
    const isPaid = order.status === "to'landi" || order.payment?.paid === true;
    if (isPaid) return;
    const paymentAcceptor = restaurantSettings?.paymentAcceptor || "kassir";
    if (paymentAcceptor !== "kassir") return;

    ktoSelectedMethod = method;
    document.querySelectorAll(".kto-pay-method").forEach(el => el.classList.remove("selected"));
    const idx = KTO_PAY_LABELS.indexOf(method);
    if (idx >= 0) document.getElementById("kpm-" + idx).classList.add("selected");

    // Naqd bundan mustasno — qolgan barcha usullarda karta raqami majburiy.
    const needsCard = method !== "Naqd";
    const cardRow = document.getElementById("ktoCardNumberRow");
    if (cardRow) cardRow.style.display = needsCard ? "block" : "none";

    updateKtoPayBtnState();
  };

  window.updateKtoPayBtnState = function () {
    const payBtn = document.getElementById("ktoPayBtn");
    if (!payBtn || !ktoSelectedMethod) return;
    const needsCard = ktoSelectedMethod !== "Naqd";
    const cardVal = document.getElementById("ktoCardNumberInput")?.value.trim() || "";
    payBtn.disabled = needsCard && !cardVal;
  }

  window.confirmKtoPayment = async function () {
    if (!ktoOrderId || !ktoSelectedMethod) return;
    const order = ordersRaw[ktoOrderId];
    if (!order) return;

    // Mustaqil tekshiruv — yuqoridagi selKtoMethod bloklashiga tayanmaymiz,
    // chunki bu haqiqiy Firebase yozuv nuqtasi.
    const paymentAcceptor = restaurantSettings?.paymentAcceptor || "kassir";
    if (paymentAcceptor !== "kassir") return;

    // 🔒 Xuddi shu tekshiruv processPayment()'da ham bor (item 13) — admin
    // shu payt ichida usulni o'chirgan bo'lishi mumkin, resetKtoPaymentUI()
    // ga tayanib qolmaymiz.
    const stillEnabled = getEnabledPaymentMethods(restaurantSettings).some(m => m.firebaseKey === ktoSelectedMethod);
    if (!stillEnabled) {
      alert(t("kassa_payment_method_disabled_err", "Bu to'lov usuli o'chirilgan. Boshqa usulni tanlang."));
      applyEnabledPaymentMethodsToKassaUI();
      return;
    }

    const needsCard = ktoSelectedMethod !== "Naqd";
    const cardNumber = document.getElementById("ktoCardNumberInput")?.value.trim() || "";
    if (needsCard && !cardNumber) return; // tugma disabled bo'lishi kerak, lekin ehtiyot uchun

    const payBtn = document.getElementById("ktoPayBtn");
    payBtn.disabled = true;
    payBtn.textContent = t("kassa_saving", "Saqlanmoqda...");

    try {
      await writePaymentToFirebase(ktoOrderId, order, ktoSelectedMethod, cardNumber);
      // 🆕 Root-cause fix — to'lovdan keyin chek avtomatik chiqishi shart
      // (spec §2/§12). closeTableOrderScreen() dan OLDIN chaqiriladi —
      // u ktoOrderId'ni tozalaydi, keyin chek qurish uchun order topilmay qoladi.
      // ⚠️ Bug fix: `order` — writePaymentToFirebase() dan OLDINGI lahzaviy
      // nusxa (payment.method hali Firebase'ga yozilmagan) — processPayment()
      // bilan bir xil sabab, ktoSelectedMethod shu yerda birlashtiriladi.
      const paidOrder = { ...order, payment: { ...(order.payment || {}), method: ktoSelectedMethod } };
      _kassaAutoPrintReceipt(paidOrder, ktoOrderId);
      alert(t("kassa_kto_pay_success_alert", "To'lov qabul qilindi ✓"));
      window.closeTableOrderScreen();
    } catch (e) {
      payBtn.disabled = false;
      payBtn.innerHTML = "💳 " + t("kassa_kto_confirm_payment", "To'lovni tasdiqlash");
      alert(t("kassa_err_firebase", "Firebase xatosi: ") + e.message);
    }
  };

  // ── Chek chiqarish — receiptEngine orqali, xuddi "To'lovlar tarixi"dagi
  //    chek bilan bir xil dizaynda, yangi oynada ochib, brauzer chop etish
  //    dialogini chaqiradi. ──
  window.printKtoReceipt = function () {
    const order = ktoOrderId ? ordersRaw[ktoOrderId] : null;
    if (!order) { alert(t("kassa_receipt_not_found", "Chek topilmadi")); return; }
    printReceiptInPopup(_kassaReceiptEngineData({ key: ktoOrderId, ...order }), {
      t, width: _kassaReceiptWidth(), copies: _kassaReceiptCopies(), title: t("kassa_rcpt_print_title", "Chek"),
      onPopupBlocked: () => alert(t("kassa_popup_blocked", "Popup bloklandi — brauzer sozlamalarini tekshiring")),
    });
  };

  // ── Kassa clock widget ──
  const MONTH_KEYS = ["month_jan","month_feb","month_mar","month_apr","month_may","month_jun",
                       "month_jul","month_aug","month_sep","month_oct","month_nov","month_dec"];
  const DAY_KEYS   = ["day_sun","day_mon","day_tue","day_wed","day_thu","day_fri","day_sat"];
  function monthName(idx) { return t(MONTH_KEYS[idx]); }
  function dayName(idx)   { return t(DAY_KEYS[idx]); }

  function pad2(n) { return String(n).padStart(2, "0"); }

  // 🩹 ROOT-CAUSE FIX (console/screenshot: o'zbek tilida "2026 M08 18" kabi
  // noto'g'ri sana chiqishi) — avval brauzerning Intl.toLocaleDateString
  // ishlatilardi; "uz-UZ" locale'i uchun ko'p brauzer/OS'da to'liq
  // o'zbekcha oy nomlari ICU ma'lumotida yo'q, shuning uchun Intl
  // tarjima qilinmagan generik fallback ("M08") qaytarardi. Endi oy nomi
  // Intl'dan EMAS, shu faylning O'Z mavjud monthName()/t() orqali
  // olinadi (yuqorida, o'zgartirilmadi) — har doim to'g'ri ishlaydi.
  function tickKassaClock() {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();
    const dtEl = document.getElementById("kClockDateTime");
    if (dtEl) {
      const yearSuffix = currentLang === "ru" ? " г." : "";
      const datePart = now.getDate() + " " + monthName(now.getMonth()) + " " + now.getFullYear() + yearSuffix;
      const timePart = pad2(h) + ":" + pad2(m) + ":" + pad2(s);
      dtEl.textContent = datePart + " · " + timePart;
    }
    function setHand(id, deg, len) {
      const el = document.getElementById(id);
      if (!el) return;
      const rad = (deg - 90) * Math.PI / 180;
      el.setAttribute("x2", (12 + len * Math.cos(rad)).toFixed(2));
      el.setAttribute("y2", (12 + len * Math.sin(rad)).toFixed(2));
    }
    setHand("kHourHand", (h % 12) * 30 + m * 0.5, 4.5);
    setHand("kMinHand",  m * 6 + s * 0.1, 6.5);
    setHand("kSecHand",  s * 6, 7);
  }
  setInterval(tickKassaClock, 1000);
  tickKassaClock();
  // 🩹 ROOT-CAUSE FIX ("2 marta tarjima bo'lish" — til almashtirilganda
  // eski tildagi matn ~1 soniya ko'rinib turardi, chunki setInterval
  // faqat har soniyada bir marta qayta hisoblardi). Endi til almashishi
  // bilan DARHOL qayta chiziladi.
  if (typeof window.onLangChange === "function") window.onLangChange(tickKassaClock);

  // ── Kassa ICHKI soat (katta widget) ──
  function tickInnerKassaClock() {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();

    const hhEl   = document.getElementById("ikClockHH");
    const mmEl   = document.getElementById("ikClockMM");
    const ssEl   = document.getElementById("ikClockSS");
    const dayEl  = document.getElementById("ikClockDay");
    const dateEl = document.getElementById("ikClockDate");
    const c1El   = document.getElementById("ikColon1");
    const c2El   = document.getElementById("ikColon2");

    if (hhEl)   hhEl.textContent  = pad2(h);
    if (mmEl)   mmEl.textContent  = pad2(m);
    if (ssEl)   ssEl.textContent  = pad2(s);
    if (c1El)   c1El.style.opacity = s % 2 === 0 ? "1" : "0.2";
    if (c2El)   c2El.style.opacity = s % 2 === 0 ? "1" : "0.2";
    if (dayEl)  dayEl.textContent  = dayName(now.getDay());
    if (dateEl) dateEl.textContent = pad2(now.getDate()) + " " + monthName(now.getMonth()) + " " + now.getFullYear();

    // Analog soat millari (56x56 viewBox, markaz 28,28)
    function setIKHand(id, deg, len) {
      const el = document.getElementById(id);
      if (!el) return;
      const rad = (deg - 90) * Math.PI / 180;
      el.setAttribute("x2", (28 + len * Math.cos(rad)).toFixed(2));
      el.setAttribute("y2", (28 + len * Math.sin(rad)).toFixed(2));
    }
    setIKHand("ikHourHand", (h % 12) * 30 + m * 0.5, 14);
    setIKHand("ikMinHand",  m * 6 + s * 0.1, 19);
    setIKHand("ikSecHand",  s * 6, 21);
  }
  setInterval(tickInnerKassaClock, 1000);
  tickInnerKassaClock();

  // ── format ──
  function fmt(n) { return Number(n).toLocaleString("uz-UZ") + " " + t("currency", "so'm"); }

  // ══════════════════════════════════════════════
  // ZALLAR / STOLLAR XARITASI
  // ══════════════════════════════════════════════

  let tablesRaw     = {};   // { table_1: {...}, table_2: {...} }
  let ordersRaw      = {};  // { orderId: {...} } — faqat to'lanmagan buyurtmalar keshi
  let mapListenerOn = false;
  // 🩹 CANONICAL SOURCE BIRLASHTIRISH — avval bu yerda `activeZone` (tb.zone
  // maydoni, faqat Admin popup'da info sifatida ko'rinadigan, kam
  // ishlatiladigan maydon) bo'yicha filtr bor edi. Waiter panelida esa
  // "hall" filtri butunlay boshqa (va Admin'ning asosiy stol boshqaruv
  // filtri bilan bir xil) maydon — tb.tableType — bo'yicha ishlaydi. Endi
  // Kassa ham AYNAN shu tableType manbasidan foydalanadi (getTableTypeMeta,
  // waiter.js bilan bir xil "all" sentinel qiymati).
  let activeKassaHall = "all";
  let popoverKey    = null;
  let openTableConsumed = !openTableKey; // agar URL'da openTable bo'lmasa, darhol "ishlatilgan" deb belgilaymiz

  // ── Pure function: bitta stol + bog'liq buyurtma obyektidan status chiqaradi.
  //    Boshqa joyda (masalan admin.js) ham ishlatish uchun input/outputgina, DOM'ga tegmaydi.
  //    Phase 2 backend migratsiyasida shu funksiyani o'zgarishsiz ko'chirsa bo'ladi. ──
  function computeTableStatus(table, order) {
    const raw = table?.status || "free";
    if (raw === "cleaning" || raw === "tozalanmoqda" || raw === "needs_cleaning") return "cleaning";
    if (raw === "billing" || raw === "bill_requested") return "billreq";
    if (raw === "free" && !table?.busy) return "free";
    // "band" holatida, lekin buyurtma hali hisob so'ramagan bo'lsa — busy;
    // order.billRequested true bo'lsa (masalan client tomondan so'ralgan) — billreq
    if (order?.billRequested === true) return "billreq";
    return "busy";
  }

  const STATUS_LABELS = {
    free:     () => t("kassa_map_legend_free", "Bo'sh"),
    busy:     () => t("kassa_map_legend_busy", "Band"),
    billreq:  () => t("kassa_map_legend_billreq", "Hisob kutilmoqda"),
    cleaning: () => t("kassa_map_legend_cleaning", "Tozalanmoqda"),
  };

  function startTablesListener() {
    if (mapListenerOn || !restaurantId) return;
    mapListenerOn = true;

    onValue(ref(db, `${BASE}/tables`), (snap) => {
      tablesRaw = snap.exists() ? snap.val() : {};
      renderKassaHallFilter();
      renderHallMap();
      if (popoverKey) refreshPopoverIfOpen();

      // Admin panelidan "Kassa paneli" tugmasi orqali kelgan bo'lsa,
      // o'sha stolning turi (tableType) tabiga o'tib, popoverini bir
      // martagina ochamiz — avval bu yerda tb.zone ishlatilardi.
      if (!openTableConsumed && tablesRaw[openTableKey]) {
        openTableConsumed = true;
        const tb = tablesRaw[openTableKey];
        activeKassaHall = tb.tableType ? String(tb.tableType).trim().toLowerCase() : "all";
        renderKassaHallFilter();
        renderHallMap();
        window.openTableOrderScreen(openTableKey);
      }
    }, (err) => {
      console.warn("Stollar o'qishda xato:", err);
    });

    // Faqat "band" bo'lishi mumkin bo'lgan buyurtmalarni yengil kuzatish uchun
    // to'liq orders/ ni doim tinglamaymiz — stol popover ochilganda kerakli
    // buyurtmani nuqtama-nuqta (orderId bo'yicha) o'qiymiz (pastda openTablePopover).
    // Grid'dagi summani ko'rsatish uchun esa yengil keshni shu yerda tutamiz:
    onValue(ref(db, `${BASE}/orders`), (snap) => {
      const all = snap.exists() ? snap.val() : {};
      ordersRaw = Object.fromEntries(
        Object.entries(all).filter(([, o]) => o.status !== "to'landi" && o.status !== "paid" && o.payment?.paid !== true)
      );
      renderHallMap();
      if (popoverKey) refreshPopoverIfOpen();
    });
  }

  function orderForTable(tableKey, tableData) {
    if (!tableData?.orderId) return null;
    return ordersRaw[tableData.orderId] ? { key: tableData.orderId, ...ordersRaw[tableData.orderId] } : null;
  }

  // 🩹 BADGE/TUR TABLARI — waiter.js'ning typeMeta()/getTableTypes()/
  // renderTypeFilter()/window.setHall() bilan AYNAN bir xil mantiq va
  // AYNAN bir xil canonical manba (shared.js'ning getTableTypeMeta(),
  // restaurantSettings.customTableTypeIcons orqali admin qo'shgan custom
  // badge'lar ham avtomatik tan olinadi — hech narsa hardcode qilinmaydi).
  /** Tur uchun emoji + nom (admin qo'shgan custom turlar ham ishlaydi) */
  function kassaTypeMeta(rawType) {
    const meta = getTableTypeMeta(rawType, t, restaurantSettings?.customTableTypeIcons);
    return { emoji: meta.icon, label: meta.label, key: meta.key };
  }

  /** Stollardan barcha turlarni yig'adi: Map { tur => soni } — faqat active
   *  stollar (waiter.js'dagi getTableTypes() bilan bir xil: active:false
   *  stollar badge countiga ham, tab bosilganda ko'rinadigan ro'yxatga ham
   *  kirmaydi). */
  function getKassaTableTypes() {
    const types = new Map();
    Object.values(tablesRaw || {}).forEach(tb => {
      if (tb?.active === false) return;
      const key = String(tb?.tableType || "oddiy").trim().toLowerCase() || "oddiy";
      types.set(key, (types.get(key) || 0) + 1);
    });
    return types;
  }

  function renderKassaHallFilter() {
    const box = document.getElementById("kassaHallFilter");
    if (!box) return;

    const types = getKassaTableTypes();
    const total = [...types.values()].reduce((a, b) => a + b, 0);

    if (!types.has(activeKassaHall) && activeKassaHall !== "all") activeKassaHall = "all";

    // "Asosiy zal" — mavjud table_zone_main tarjima kalitidan (barcha
    // panellarda allaqachon bor: UZ "Asosiy zal" / RU "Основной зал" /
    // EN "Main hall") — bu tab waiter.js'dagi "Barcha stollar" tabi bilan
    // bir xil ishlaydi (barcha faol stollarni ko'rsatadi), faqat Kassa
    // uchun shu mavjud nom ishlatiladi.
    let html = `
      <button class="zone-tab ${activeKassaHall === "all" ? "active" : ""}" onclick="selectKassaHall('all')">
        ${escHtml(t("table_zone_main", "Asosiy zal"))}
        <span class="cnt">${total}</span>
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
        const meta = kassaTypeMeta(type);
        const safe = escHtml(type).replace(/'/g, "\\'");
        html += `
          <button class="zone-tab ${activeKassaHall === type ? "active" : ""}" onclick="selectKassaHall('${safe}')">
            ${meta.emoji} ${escHtml(meta.label)}
            <span class="cnt">${count}</span>
          </button>`;
      });

    box.innerHTML = html;
  }

  window.selectKassaHall = function (type) {
    activeKassaHall = type;
    renderKassaHallFilter();
    renderHallMap();
  };

  function escHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  function renderHallMap() {
    const grid = document.getElementById("hallGrid");
    if (!grid) return;

    // 🆕 [TABLE-DIAG] — waiter.js bilan bir xil diagnostika, "Stol raqami
    // yo'qolib qolyapti" muammosini localhost'da aniqlash uchun.
    const _isLocalDebug = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    if (_isLocalDebug) {
      console.info("[TABLE-DIAG] kassa xom tablesRaw (Firebase'dan, hech qanday filtr yo'q):",
        Object.entries(tablesRaw).map(([k, tb]) => ({ key: k, num: tb?.number, active: tb?.active, status: tb?.status, zone: tb?.zone, type: tb?.tableType })));
    }

    // 🩹 waiter.js'ning renderTablesGrid() bilan bir xil ikki bosqichli
    // filtr: (1) active:false stollar hech qachon ko'rinmaydi (avval Kassa
    // bu bosqichni umuman qilmasdi — Waiter/Admin bilan mos kelmasdi); (2)
    // "Asosiy zal" (all) tanlangan bo'lsa tur bo'yicha filtr qilinmaydi,
    // aks holda faqat shu tableType'ga tegishli stollar qoladi.
    let entries = Object.entries(tablesRaw).filter(([, tb]) => tb?.active !== false);

    if (activeKassaHall !== "all") {
      entries = entries.filter(([, tb]) => {
        const tp = String(tb?.tableType || "oddiy").trim().toLowerCase() || "oddiy";
        return tp === activeKassaHall;
      });
    }

    entries.sort((a, b) => (Number(a[1].number) || 0) - (Number(b[1].number) || 0));

    if (_isLocalDebug) {
      console.info("[TABLE-DIAG] kassa renderHallMap() YAKUNIY ro'yxat (activeKassaHall=" + activeKassaHall + "):",
        entries.map(([, tb]) => tb?.number));
    }

    if (!entries.length) {
      grid.innerHTML = `
        <div class="hall-empty">
          <div class="icon">🪑</div>
          <span data-i18n="kassa_map_empty">Bu zonada stollar yo'q</span>
        </div>`;
      applyI18n();
      return;
    }

    grid.innerHTML = "";
    entries.forEach(([key, tb]) => {
      const order   = orderForTable(key, tb);
      const status  = computeTableStatus(tb, order);
      const num     = tb.number || String(tb.id || key).replace("table_", "");
      const sum     = order ? Number(order.finalTotal || order.total || 0) : 0;
      const waiter  = order?.waiterName || "";
      // waiter.js'dagi bilan bir xil maydon nomi konventsiyasi (tables/{key}
      // Firebase yozuvida ikkalasi ham uchraydi) — yangi maydon o'qilmadi,
      // faqat mavjuduni kartada ko'rsatish qo'shildi.
      const seats   = tb?.seats || tb?.capacity;
      const orderNo = order ? (formatOrderNumber(order) || null) : null;

      const card = document.createElement("div");
      card.className = `htable ${status}`;
      // Bo'sh va Tozalanmoqda holatidagi stollarda kassir uchun bosiladigan
      // hech qanday amal yo'q — "Tozalash tugadi" endi faqat ofitsiant
      // tomonidan (waiter.js orqali) bajariladi. Band va Hisob kutmoqda
      // holatlari — ikkalasi ham buyurtma ko'rish/to'lov ekranini ochadi
      // (to'lov aynan shu holatlardan boshlanadi).
      const isOpenable = !(status === "free" || status === "cleaning");
      if (!isOpenable) {
        card.style.cursor = "default";
      } else {
        card.onclick = () => window.openTableOrderScreen(key);
      }
      // 🩹 BADGE IKON YAGONA MANBA — avval bu yerda 🪑 hardcoded edi, VIP/
      // boshqa turdagi stollarda ham har doim oddiy stol ikoni ko'rinardi.
      // Endi shared.js'ning getTableTypeMeta() (Admin/Waiter bilan bir xil
      // canonical manba) ishlatiladi.
      const tableIcon = getTableTypeMeta(tb.tableType, t, restaurantSettings?.customTableTypeIcons).icon;
      card.innerHTML = `
        <div class="htable-top">
          <div class="htable-num">${tableIcon} №${escHtml(num)}</div>
          <span class="htable-status-badge">
            <span class="htable-dot"></span>${STATUS_LABELS[status]()}
          </span>
        </div>
        ${(seats || waiter || orderNo) ? `
        <div class="htable-meta">
          ${seats ? `<span class="htable-meta-item">👤 ${escHtml(String(seats))}</span>` : ""}
          ${orderNo ? `<span class="htable-meta-item">🧾 ${escHtml(orderNo)}</span>` : ""}
          ${waiter ? `<span class="htable-meta-item">🧑‍🍳 ${escHtml(waiter)}</span>` : ""}
        </div>` : ""}
        ${sum > 0 ? `<div class="htable-sum">${fmt(sum)}</div>` : ""}
        ${isOpenable ? `<div class="htable-open-hint">${t("kassa_table_open_order", "Stoldagi buyurtma")} →</div>` : ""}
      `;
      grid.appendChild(card);
    });
    applyI18n();
  }

  // ── STOL POPOVER ──
  window.openTablePopover = function(key) {
    popoverKey = key;
    document.getElementById("tpopOverlay").classList.add("open");
    renderPopoverContent();
  };

  window.closeTablePopover = function() {
    popoverKey = null;
    document.getElementById("tpopOverlay").classList.remove("open");
  };

  function refreshPopoverIfOpen() {
    if (popoverKey && tablesRaw[popoverKey]) renderPopoverContent();
    else if (popoverKey && !tablesRaw[popoverKey]) closeTablePopover();
  }

  function renderPopoverContent() {
    const tb = tablesRaw[popoverKey];
    if (!tb) { closeTablePopover(); return; }

    const order  = orderForTable(popoverKey, tb);
    const status = computeTableStatus(tb, order);
    const num    = tb.number || String(tb.id || popoverKey).replace("table_", "");

    const tpopIcon = getTableTypeMeta(tb.tableType, t, restaurantSettings?.customTableTypeIcons).icon;
    document.getElementById("tpopTitle").textContent = `${tpopIcon} ${t("kassa_map_table_prefix", "Stol")} №${num}`;

    const body = document.getElementById("tpopBody");
    if (!order) {
      body.innerHTML = `<div class="tpop-empty">${t("kassa_map_no_active_order", "Faol buyurtma yo'q")}</div>`;
    } else {
      // 🆕 STOL XIZMAT NARXI — order.finalTotal (to'lovdan keyin yozilgan)
      // yo'q bo'lsa, hali to'lanmagan buyurtma uchun order.total +
      // tableServiceAmount (saqlangan, qayta hisoblanmaydi — item 9).
      const tableServiceAmount = Math.max(0, Number(order.tableServiceAmount || 0)) || 0;
      const sum = order.finalTotal != null
        ? Number(order.finalTotal)
        : Number(order.total || 0) + tableServiceAmount;
      body.innerHTML = `
        <div class="tpop-row">
          <span class="lbl">${t("kassa_map_order_num", "Buyurtma")}</span>
          <span class="val">${escHtml(formatOrderNumber(order) || "#" + order.key.slice(-6))}</span>
        </div>
        <div class="tpop-row">
          <span class="lbl">${t("kassa_map_status", "Holat")}</span>
          <span class="val">${STATUS_LABELS[status]()}</span>
        </div>
        ${order.waiterName ? `
        <div class="tpop-row">
          <span class="lbl">${t("kassa_map_waiter", "Ofitsiant")}</span>
          <span class="val">${escHtml(order.waiterName)}</span>
        </div>` : ""}
        ${tableServiceAmount > 0 ? `
        <div class="tpop-row">
          <span class="lbl">🏷 ${t("table_service_row_label", "Stol xizmati")}</span>
          <span class="val">+${fmt(tableServiceAmount)}</span>
        </div>` : ""}
        <div class="tpop-row">
          <span class="lbl">${t("kassa_map_total", "Jami summa")}</span>
          <span class="val big">${fmt(sum)}</span>
        </div>
      `;
    }

    const actions = document.getElementById("tpopActions");
    let actionsHtml = "";

    if (order && status === "busy") {
      actionsHtml += `
        <button class="tpop-btn warn" onclick="requestBillForTable('${popoverKey}')">
          🧾 ${t("kassa_map_request_bill", "Hisob so'rash (Pre-chek)")}
        </button>`;
    }
    if (order && order.kassaCode) {
      actionsHtml += `
        <button class="tpop-btn primary" onclick="goToPaymentForOrder('${String(order.kassaCode).replace(/'/g, "\\'")}')">
          💳 ${t("kassa_map_go_to_payment", "To'lovga o'tish")}
        </button>`;
    } else if (order) {
      actionsHtml += `
        <button class="tpop-btn ghost" disabled>
          ${t("kassa_map_no_kassa_code", "Kassa kodi hali yo'q")}
        </button>`;
    }
    if (status === "free") {
      actionsHtml += `
        <button class="tpop-btn ghost" disabled>
          ${t("kassa_map_table_free_hint", "Bu stol bo'sh")}
        </button>`;
    }
    actions.innerHTML = actionsHtml;
  }

  // ── Hisob so'rash: sariq statusga o'tkazish ──
  // Sof funksiya + bitta atomik update() — sahifa ataylab offline-yozuv
  // navbatiga ulanmagan (yuqoridagi mountOfflineStatusOnly izohiga qarang),
  // shuning uchun bu yerda ham faqat online holatda ishlaydi.
  window.requestBillForTable = async function(tableKey) {
    const tb = tablesRaw[tableKey];
    if (!tb?.orderId) return;
    const btn = event?.target?.closest("button");
    if (btn) { btn.disabled = true; btn.textContent = t("kassa_saving", "Saqlanmoqda..."); }
    try {
      const updates = {};
      updates[`${BASE}/tables/${tableKey}/status`]          = "billing";
      updates[`${BASE}/orders/${tb.orderId}/billRequested`] = true;
      updates[`${BASE}/orders/${tb.orderId}/billRequestedAt`] = Date.now();
      await update(ref(db), updates);
      // onValue listener o'zi popover'ni yangilaydi
    } catch (e) {
      alert(t("kassa_err_firebase", "Firebase xatosi: ") + e.message);
      if (btn) { btn.disabled = false; btn.textContent = "🧾 " + t("kassa_map_request_bill", "Hisob so'rash (Pre-chek)"); }
    }
  };

  // ── Popoverdan to'g'ridan-to'g'ri to'lov (Kassa) tabiga, kassaCode bilan o'tish.
  //    searchOrder() kassaCode bo'yicha qidiradi (Firebase key yoki orderNumber emas) ──
  window.goToPaymentForOrder = function(kassaCode) {
    closeTablePopover();
    switchTab("kassa");
    const input = document.getElementById("orderInput");
    input.value = kassaCode;
    searchOrder();
  };

  // ── stepper ──
  function setStep(s) {
    [1,2,3,4].forEach(n => {
      const dot = document.getElementById("sd"+n);
      const lbl = document.getElementById("sl"+n);
      if (n < s)      { dot.className="sdot done";   lbl.className="slbl done"; }
      else if (n===s) { dot.className="sdot active"; lbl.className="slbl active"; }
      else            { dot.className="sdot idle";   lbl.className="slbl idle"; }
    });
  }

  // ── getName: {uz,ru,en} object yoki string ──
  function getName(val, depth) {
    depth = depth || 0;
    if (depth > 5 || val === null || val === undefined) return "";
    if (typeof val === "string") return val.trim();
    if (typeof val === "number") return val > 0 ? String(val) : "";
    if (Array.isArray(val)) {
      for (const x of val) { const r = getName(x, depth+1); if (r) return r; }
      return "";
    }
    if (typeof val === "object") {
      for (const k of ["uz","ru","en"]) {
        if (typeof val[k] === "string" && val[k].trim()) return val[k].trim();
      }
      for (const k of ["name","title","label","text","value"]) {
        if (val[k] !== undefined) { const r = getName(val[k], depth+1); if (r) return r; }
      }
      for (const v of Object.values(val)) {
        if (typeof v === "string" && v.trim() && !v.startsWith("http") && v.length < 200)
          return v.trim();
      }
    }
    return "";
  }

  // ── recipe → "Guruch, Go'sht, Sabzi" ──
  function getIngredientText(item) {
    const raw = item.recipe || item.ingredients || item.tarkib || null;
    if (!raw) return "";
    const rows = Array.isArray(raw) ? raw : Object.values(raw);
    const parts = rows.map(i => {
      if (!i) return "";
      if (typeof i === "string") return i;
      if (typeof i !== "object") return "";
      const n = getName(i.name) || getName(i.title) || "";
      if (!n) return "";
      const amt  = i.amount !== undefined ? String(i.amount) : "";
      const unit = typeof i.unit === "string" ? i.unit : "";
      return n; // faqat nom (amount ixtiyoriy)
    }).filter(Boolean);
    return parts.join(", ");
  }

  // ── SEARCH ──
  window.searchOrder = async function() {
    if (!restaurantId) { showErr(t("kassa_err_no_restaurant")); return; }
    const code = document.getElementById("orderInput").value.trim();
    if (!code || code.length < 4) { showErr(t("kassa_err_short_code")); return; }

    setLoading(true); hideErr();
    document.getElementById("orderSection").style.display   = "none";
    document.getElementById("successSection").style.display = "none";
    setStep(1);

    // Detach any previous order's live subscription before starting a new
    // search — otherwise repeated searches stack duplicate onValue()
    // listeners on different orders/{id} paths that never get cleaned up.
    if (_searchedOrderUnsub) { _searchedOrderUnsub(); _searchedOrderUnsub = null; }

    try {
      // kassaCode isn't the RTDB key, so finding the order still needs a
      // one-time scan of the whole orders collection. What used to be the
      // bug: this snapshot was then FROZEN into currentOrder.data for the
      // rest of the payment flow — if a waiter added items or the kitchen
      // changed the order after this search but before "Pay" was pressed,
      // the cashier kept charging/printing the stale total (kassa.js
      // undercharge bug). Fixed below by subscribing live to the found
      // order instead of using this snapshot directly.
      const snap = await get(ref(db, `${BASE}/orders`));
      if (!snap.exists()) { showErr(t("kassa_err_no_orders")); return; }

      let foundKey = null;
      for (const [key, order] of Object.entries(snap.val())) {
        if (String(order.kassaCode || "").trim() === String(code).trim()) {
          foundKey = key; break;
        }
      }
      if (!foundKey) { showErr(t("kassa_err_order_not_found", { code })); return; }

      await getMenuCache(); // eski buyurtmalarda yo'q maydonlarni to'ldirish uchun menyuni oldindan yuklaymiz

      document.getElementById("orderSection").style.display = "block";
      document.getElementById("orderSection").scrollIntoView({ behavior:"smooth", block:"start" });
      setStep(2);

      // Live from here on: any edit to this order (items, total, status)
      // made by the waiter/kitchen/another cashier while this screen is
      // open re-renders instantly, so payment always uses the current data.
      _searchedOrderUnsub = onValue(ref(db, `${BASE}/orders/${foundKey}`), (oSnap) => {
        if (!oSnap.exists()) return; // order deleted/archived mid-view — keep last known render
        currentOrder = { key: foundKey, data: oSnap.val() };
        renderOrder(currentOrder);
      });
    } catch(e) {
      showErr(t("kassa_err_generic") + e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── RENDER ORDER ──
  // ══════════════════════════════════════════════════════
  // 🚚 Kassir: yetkazib berish manzilini ko'rish + kuryerga tayinlash.
  // kassa.html admin.js ni yuklamaydi (mustaqil sahifa), shuning uchun
  // admin.js dagi window.assignOrderToCourier() shu yerda ishlamaydi —
  // xuddi shu RTDB yozuvlarni (courierAssignments + orders/{id}) mustaqil
  // yozadigan yengil nusxasi shu yerda.
  // ══════════════════════════════════════════════════════
  let _kassaCouriersCache = {};
  onValue(ref(db, `${BASE}/users`), snap => {
    const all = snap.val() || {};
    _kassaCouriersCache = Object.fromEntries(Object.entries(all).filter(([, u]) => u.role === "courier"));
  });

  function renderKassaDeliveryPanel(orderId, o, orderType) {
    const panel = document.getElementById("kassaDeliveryPanel");
    if (!panel) return;
    if (orderType !== ORDER_TYPE.DELIVERY) { panel.style.display = "none"; panel.innerHTML = ""; return; }

    panel.style.display = "block";
    const addressText = formatDeliveryAddress(o.deliveryAddress) || (typeof o.deliveryAddress === "string" ? o.deliveryAddress : "");
    const courierOptions = Object.entries(_kassaCouriersCache)
      .map(([id, u]) => `<option value="${id}" ${o.courierId === id ? "selected" : ""}>${(u.name || id)}</option>`)
      .join("");

    panel.innerHTML = `
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:10px 12px;margin:8px 0;font-size:13px;">
        <div><b>📍 ${t("kassa_delivery_address_label") || "Manzil"}:</b> ${addressText || "—"}</div>
        ${o.deliveryAddress?.comment ? `<div>📝 ${o.deliveryAddress.comment}</div>` : ""}
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <select id="kassaCourierSelect" style="padding:6px;border-radius:6px;border:1px solid #fca5a5;">
            <option value="">${t("select_courier_first") || "Kuryerni tanlang"}</option>
            ${courierOptions}
          </select>
          <button class="btn" onclick="window.kassaAssignCourier('${orderId}')">
            ${o.courierId ? (t("kassa_reassign_courier") || "Qayta tayinlash") : (t("kassa_assign_courier") || "🛵 Kuryerga tayinlash")}
          </button>
          ${o.courierId ? `<span style="color:#15803d;font-weight:600;">✅ ${o.courierName || o.courierId}</span>` : ""}
        </div>
      </div>`;
  }

  window.kassaAssignCourier = async function (orderId) {
    const courierId = document.getElementById("kassaCourierSelect")?.value;
    if (!courierId) { alert(t("select_courier_first") || "Iltimos, kuryerni tanlang!"); return; }
    try {
      const [orderSnap, courierUserSnap] = await Promise.all([
        get(ref(db, `${BASE}/orders/${orderId}`)),
        get(ref(db, `${BASE}/users/${courierId}`))
      ]);
      if (!orderSnap.exists()) return;
      const order = orderSnap.val();
      const courierName = courierUserSnap.exists() ? (courierUserSnap.val().name || "") : "";
      const now = Date.now();
      const assignRef = push(ref(db, `${BASE}/courierAssignments`));
      const address = formatDeliveryAddress(order.deliveryAddress) || "";
      const destination = (order.deliveryAddress && typeof order.deliveryAddress.lat === "number")
        ? { lat: order.deliveryAddress.lat, lng: order.deliveryAddress.lng } : null;
      const paymentMethod = order.deliveryPaymentMethod || "cash_on_delivery";

      await set(assignRef, {
        courierId, orderId, orderNumber: order.orderNumber || "",
        customerName: order.customerName || "", address,
        ...(destination ? { destination } : {}),
        customerPhone: order.customerPhone || order.clientPhone || "",
        total: Number(order.total || 0), paymentMethod,
        isPrepaid: paymentMethod === "prepaid_card" && order.payment?.paid === true,
        note: order.deliveryNote || order.deliveryAddress?.comment || "",
        status: "assigned", assignedAt: now
      });
      await update(ref(db, `${BASE}/orders/${orderId}`), {
        courierId, courierName, courierAssignmentId: assignRef.key, courierAssignedAt: now
      });
      await update(ref(db, `${BASE}/couriers/${courierId}`), { status: "on_delivery" });
      alert(t("courier_assigned_success") || "Kuryerga tayinlandi!");
    } catch (err) {
      console.error("kassaAssignCourier error:", err);
      alert(t("error_occurred") || "Xatolik yuz berdi!");
    }
  };

  function renderOrder({ key, data: o }) {
    const num = formatOrderNumber(o) || `#${key.slice(-6)}`;
    document.getElementById("oId").textContent    = `${t("kassa_order_number_label")}: ${num}`;
    const kOrderType = normalizeOrderType(o);
    document.getElementById("oTable").textContent = kOrderType === ORDER_TYPE.DELIVERY
      ? `🚚 ${t("delivery_badge", "YETKAZISH")}`
      : kOrderType === ORDER_TYPE.TAKEAWAY
      ? `🥡 ${t("takeaway_badge", "OLIB KETISH")}`
      : (o.table ? `${t("kassa_table_prefix")} ${o.table}` : `${t("kassa_table_prefix")} —`);
    renderKassaDeliveryPanel(key, o, kOrderType);
    document.getElementById("cNum").textContent   = num;
    document.getElementById("cAmount").textContent = fmt(Number(o.total) || 0);

    // status
    const isPaid = o.status === "to'landi" || o.status === "paid" ||
                   o.payment?.paid === true || o.payment?.approved === true;
    const isNewOrder = o.status === "yangi" || o.status === "new"
      || o.status === ORDER_STATUS_V2.ORDER_CREATED.key
      || o.status === ORDER_STATUS_V2.WAITER.key; // 🆕 yangi flow
    const statusEl = document.getElementById("oStatus");
    if (isPaid) {
      statusEl.textContent = t("kassa_status_paid"); statusEl.className = "status-badge status-paid";
    } else if (isNewOrder) {
      statusEl.textContent = t("kassa_status_new"); statusEl.className = "status-badge status-new";
    } else {
      statusEl.textContent = t("kassa_status_ready"); statusEl.className = "status-badge status-ready";
    }

    // client
    const phone = o.customerPhone || o.clientPhone || o.phoneNumber || "";
    const strip = document.getElementById("clientStrip");
    if (phone) {
      strip.innerHTML = `
        <div class="client-strip">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07
                     A19.5 19.5 0 0 1 4.07 13.93a19.79 19.79 0 0 1-3.07-8.67
                     A2 2 0 0 1 3 3.18h3a2 2 0 0 1 2 1.72
                     c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.09 10.91
                     a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45
                     c.907.339 1.85.573 2.81.7A2 2 0 0 1 21 18v2.92z"/>
          </svg>
          ${phone}
          ${o.kassaCode ? `<span style="margin-left:8px;font-size:12px;color:#15803d;opacity:.7;">🎫 ${o.kassaCode}</span>` : ""}
        </div>`;
    } else {
      strip.innerHTML = "";
    }

  // ── order item maydonlarini menyu keshidan to'ldirish (eski buyurtmalarda imgUrl/subcategory/recipe yo'q bo'lsa) ──
    function fillFromMenu(item) {
      const menuItem = menuCache && (menuCache[item.id] || menuCache[String(item.id)]);
      if (!menuItem) return item;
      return {
        ...item,
        imgUrl:      item.imgUrl      || menuItem.imgUrl || menuItem.img || menuItem.image || "",
        subcategory: item.subcategory || menuItem.subcategory || "",
        recipe:      item.recipe      || item.ingredients || menuItem.recipe || menuItem.ingredients || null,
        category:    item.category    || menuItem.category || "",
        name:        item.name        || menuItem.name || ""
      };
    }

    // items
    const list = document.getElementById("itemsList");
    list.innerHTML = "";
    const items = Object.values(o.items || {}).map(fillFromMenu);
    let subtotal = 0;

    items.forEach((item, idx) => {
      const qty       = Number(item.qty)   || 1;
      const price     = Number(item.price) || 0;
      const lineTotal = price * qty;
      subtotal += lineTotal;

      const name   = getName(item.name) || getName(item.title) || "—";
      const cat    = item.category    || item.cat    || "";
      const subcat = item.subcategory || item.subcat || "";
      const ingr   = getIngredientText(item);
      const imgSrc = item.imgUrl || item.img || item.image || item.photo || "";

      const imgHtml = imgSrc
        ? `<img class="item-img" src="${imgSrc}"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" alt="">
           <div class="item-img-placeholder" style="display:none;">🍽️</div>`
        : `<div class="item-img-placeholder">🍽️</div>`;

      const div = document.createElement("div");
      div.className = "order-item";
      div.innerHTML = `
        <div class="item-img-wrap">
          ${imgHtml}
          <div class="qty-badge">x${qty}</div>
        </div>
        <div class="item-body">
          <div class="item-name">${name}</div>
          ${cat ? `<div class="meta-row"><span class="meta-key">${t("kassa_meta_category")}</span><span class="meta-val">${cat}</span></div>` : ""}
          ${subcat ? `<div class="meta-row"><span class="meta-key">${t("kassa_meta_subcategory")}</span><span class="meta-val">${subcat}</span></div>` : ""}
          ${ingr ? `<div class="meta-row"><span class="meta-key">${t("kassa_meta_ingredients")}</span><span class="meta-val">${ingr}</span></div>` : ""}
          <div class="item-price-row">
            <span class="item-unit-price">${fmt(price)}</span>
            <span style="color:var(--muted2);">×</span>
            <span style="font-weight:700;">${qty}</span>
          </div>
        </div>
        <div class="item-total">${fmt(lineTotal)}</div>
      `;
      list.appendChild(div);
    });

    // totals
    const totalPayable = Number(o.total) || subtotal;
    const discount     = Number(o.discount) || 0;
    document.getElementById("tCount").textContent    = items.reduce((s,i)=>s+Number(i.qty),0) + " " + t("kassa_unit_pieces", "ta");
    document.getElementById("tSubtotal").textContent = fmt(subtotal);
    if (discount > 0) {
      document.getElementById("discountRow").style.display = "flex";
      document.getElementById("tDiscount").textContent     = "−" + fmt(discount);
    } else {
      document.getElementById("discountRow").style.display = "none";
    }
    document.getElementById("tTotal").textContent = fmt(totalPayable);

    // reset pay methods
    selectedMethod = null;
    document.querySelectorAll(".pay-card").forEach(el => el.classList.remove("selected","disabled"));
    const payBtn = document.getElementById("payBtn");
    const payTxt = document.getElementById("payBtnTxt");
    if (isPaid) {
      payTxt.textContent = t("kassa_pay_btn_paid");
      payBtn.disabled = true;
      document.querySelectorAll(".pay-card").forEach(el => el.classList.add("disabled"));
    } else {
      payTxt.textContent = t("kassa_pay_btn");
      payBtn.disabled = true;
    }
    document.getElementById("cMethod").textContent = "—";
  }

  // ── SELECT METHOD ──
  window.selMethod = function(m) {
    if (!currentOrder) return;
    const isPaid = currentOrder.data.status === "to'landi" || currentOrder.data.payment?.paid;
    if (isPaid) return;
    selectedMethod = m;
    document.querySelectorAll(".pay-card").forEach(el => el.classList.remove("selected"));
    const idx = PAY_LABELS.indexOf(m);
    if (idx >= 0) document.getElementById("pm-"+idx).classList.add("selected");
    document.getElementById("cMethod").textContent = payMethodDisplayLabel(m);
    document.getElementById("payBtn").disabled = false;
    setStep(3);
  };

  // ── To'lovni Firebase'ga yozish (pageKassa VA pageTableOrder ikkalasi ham shu
  //    bitta funksiyani chaqiradi — maydonlar ikki joyda ikki marta yozilib,
  //    keyinchalik bir-biridan farqlanib qolmasligi uchun) ──
  // Endi js/paymentEngine.js'dagi bitta umumiy writeUnifiedPayment() ni
  // chaqiradi (waiter.js ham xuddi shu funksiyani chaqiradi) — Firebase'ga
  // yoziladigan maydonlar aynan avvalgidek qoladi, faqat yozish mantig'i
  // endi ikkala faylda ham bitta joyda saqlanadi.
  async function writePaymentToFirebase(key, data, method, cardNumber = "") {
    const result = await writeUnifiedPayment({
      db, update, ref, runTransaction, basePath: BASE,
      orderId: key,
      orderData: data,
      method, cardNumber,
      actor: { id: cashierId, name: cashierName, role: "cashier" },
      resolveTableKey: (orderData) => {
        if (!orderData?.table) return null;
        // ⚠️ tables/ tugunlari "table_N" formatida kalitlangan (raqamning o'zi
        // emas) — buni tablesRaw'dan orderId mos kelgan yozuvni topib aniqlaymiz,
        // aks holda eski (noto'g'ri) "${data.table}" kaliti ishlatiladi.
        const matchedKey = Object.keys(tablesRaw).find(k => tablesRaw[k]?.orderId === key);
        return matchedKey || orderData.tableKey || `table_${orderData.table}`;
      },
      writeOrderAuditLog,
      ORDER_STATUS_V2,
      extra: {
        // 🆕 STOL XIZMAT NARXI — order.tableServiceAmount (waiter.js bilan
        // bir xil, order yaratilganda "muzlatilgan" manba) payment.finalTotal'ga
        // qo'shiladi, kassa qayta hisoblamaydi (item 9).
        finalTotal: (Number(data.total) || 0) + Math.max(0, Number(data.tableServiceAmount || 0)),
        auditDescription: t("kassa_audit_payment_desc", {
          table:  data.table || "—",
          num:    data.orderNumber || key.slice(-6),
          method: method,
          amount: fmt((Number(data.total) || 0) + Math.max(0, Number(data.tableServiceAmount || 0)))
        }),
      },
    });

    // 🆕 QR bir martalik chegirma (spec §15/§27/§28):
    // (1) agar shu order allaqachon bir claimni "ishlatgan" bo'lsa
    //     (discountClaimId — waiter.js/client.js discount hisoblashida
    //     yozilgan), to'lov muvaffaqiyatli bo'lgan ZAHOTI (payment-
    //     authoritative flow) uni "used" qilamiz.
    // (2) Shu order uchun chek QR claimni chiqaramiz/qayta ishlatamiz —
    //     issueClaimForOrder() orderId bo'yicha idempotent, tokenni
    //     orders/{key}/qrDiscountClaimToken ga yozadi, keyinroq
    //     _kassaReceiptEngineData() shu maydonni to'g'ridan-to'g'ri o'qiydi
    //     (qayta chiqarishda ham xuddi shu claim, yangisi yaratilmaydi).
    // Ikkalasi ham to'lovning o'zini bloklamaydi — xatolik bo'lsa faqat log.
    if (data.discountClaimId) {
      discountClaimsClient.use(restaurantId, data.discountClaimId, key)
        .catch(err => console.error("discountClaimsClient.use error:", err));
    }
    discountClaimsClient.issue(restaurantId, key)
      .catch(err => console.error("discountClaimsClient.issue error:", err));

    historyLoaded = false; // tarix tabida yangi to'lov ko'rinishi uchun
    return result.paidAt;
  }

  // ── PROCESS PAYMENT (pageKassa) ──
  window.processPayment = async function() {
    if (!currentOrder || !selectedMethod) return;

    const paymentAcceptor = restaurantSettings?.paymentAcceptor || "kassir";
    if (paymentAcceptor !== "kassir") return;

    // 🔒 Yozuv nuqtasidagi mustaqil tekshiruv — applyEnabledPaymentMethodsToKassaUI()
    // UI holatini yangilashiga tayanib qolmaymiz (item 13: stale/o'chirilgan
    // usul bilan to'lov yozilmasligi kerak). "QR kod" registrdan tashqari,
    // har doim ruxsat etilgan (avvalgidek).
    const stillEnabled = selectedMethod === "QR kod"
      || getEnabledPaymentMethods(restaurantSettings).some(m => m.firebaseKey === selectedMethod);
    if (!stillEnabled) {
      showErr(t("kassa_payment_method_disabled_err", "Bu to'lov usuli o'chirilgan. Boshqa usulni tanlang."));
      applyEnabledPaymentMethodsToKassaUI();
      return;
    }

    const payBtn = document.getElementById("payBtn");
    const payTxt = document.getElementById("payBtnTxt");
    payBtn.disabled  = true;
    payTxt.innerHTML = `<span class="spinner"></span> ${t("kassa_saving")}`;

    const { key, data } = currentOrder;

    try {
      await writePaymentToFirebase(key, data, selectedMethod);
      const nowStr = new Date().toLocaleString("uz-UZ");

      document.getElementById("orderSection").style.display   = "none";
      const ss = document.getElementById("successSection");
      ss.style.display = "block";
      document.getElementById("sOrderId").textContent = t("kassa_success_order_line", {
        num:  data.orderNumber || key.slice(-6),
        code: data.kassaCode || "—"
      });
      document.getElementById("sTable").textContent   = data.table ? `${t("kassa_receipt_table")} ${data.table}` : "—";
      document.getElementById("sMethod").textContent  = payMethodDisplayLabel(selectedMethod);
      document.getElementById("sTotal").textContent   = fmt(Number(data.total) || 0);
      document.getElementById("sDate").textContent    = nowStr;
      setStep(4);
      ss.scrollIntoView({ behavior:"smooth", block:"start" });
      // 🆕 Root-cause fix — bu oqimda ("pageKassa" — asosiy qidiruv+to'lov
      // ekrani) to'lovdan keyin chek chiqarish UMUMAN yo'q edi: na avtomatik
      // print, na successSection'da qayta-chop-etish tugmasi. data.total —
      // saqlangan order/payment'dagi ALLAQACHON tasdiqlangan summa (spec §17:
      // paymentdan keyin qayta hisoblanmaydi).
      // ⚠️ Bug fix: `data` — currentOrder'dan OLDIN olingan, to'lovdan OLDINGI
      // lahzaviy nusxa — writePaymentToFirebase() payment.method'ni Firebase'ga
      // yozadi, lekin bu LOKAL obyektga emas. Shu sabab _kassaReceiptEngineData()
      // order.payment?.method'ni topa olmasdi va chekda to'lov turi bo'sh
      // chiqardi (successSection'dagi #sMethod aynan shu sababdan
      // data.payment.method emas, selectedMethod'ning o'zidan o'qiydi — bu
      // yerda ham xuddi shunday birlashtiriladi).
      const paidData = { ...data, payment: { ...(data.payment || {}), method: selectedMethod } };
      _lastPaidOrder = paidData;
      _lastPaidOrderId = key;
      _kassaAutoPrintReceipt(paidData, key);
    } catch(e) {
      payBtn.disabled = false;
      payTxt.textContent = t("kassa_pay_error_retry");
      showErr(t("kassa_err_firebase") + e.message);
    }
  };

  // 🆕 successSection'dagi "Qayta chop etish" — avtomatik print (yuqorida)
  // popup bloklangan yoki muvaffaqiyatsiz bo'lsa, foydalanuvchi shu yerdan
  // qayta urina oladi. Xuddi shu kanonik _kassaAutoPrintReceipt()ni ishlatadi.
  window.reprintLastKassaReceipt = function () {
    if (!_lastPaidOrder || !_lastPaidOrderId) {
      alert(t("kassa_receipt_not_found", "Chek topilmadi"));
      return;
    }
    _kassaAutoPrintReceipt(_lastPaidOrder, _lastPaidOrderId);
  };

  window.resetAll = function() {
    if (_searchedOrderUnsub) { _searchedOrderUnsub(); _searchedOrderUnsub = null; }
    currentOrder = null; selectedMethod = null;
    _lastPaidOrder = null; _lastPaidOrderId = null;
    document.getElementById("orderInput").value              = "";
    hideErr();
    document.getElementById("orderSection").style.display   = "none";
    document.getElementById("successSection").style.display = "none";
    document.getElementById("cMethod").textContent  = "—";
    document.getElementById("cNum").textContent     = "—";
    document.getElementById("cAmount").textContent  = "—";
    document.getElementById("clientStrip").innerHTML = "";
    setStep(1);
    window.scrollTo({ top:0, behavior:"smooth" });
  };

  function showErr(msg) {
    const el = document.getElementById("errorMsg");
    el.textContent = msg; el.style.display = "block";
  }
  function hideErr() {
    document.getElementById("errorMsg").style.display = "none";
  }
  function setLoading(on) {
    const btn = document.getElementById("searchBtn");
    const txt = document.getElementById("searchBtnTxt");
    btn.disabled  = on;
    txt.innerHTML = on ? '<span class="spinner"></span>' : t("kassa_search_order_btn");
  }

  // ══════════════════════════════════════════════
  // 🔄 BUYURTMA O'ZGARTIRISH SO'ROVLARI (Order Change Requests)
  // admin.js'dagi bilan AYNAN bir xil shared.js funksiyalarini chaqiradi
  // (approveOrderChangeRequest/rejectOrderChangeRequest) — order mutatsiya
  // mantig'i ikki joyda alohida-alohida yozilmagan (item 22).
  // ══════════════════════════════════════════════
  let ocrCache = {};
  let ocrTabMode = "pending";
  const OCR_DEBUG = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

  function ocrActor() {
    return {
      uid: cashierId,
      name: cashierName,
      role: "cashier",
    };
  }

  function listenOrderChangeRequests() {
    if (OCR_DEBUG) console.log("[OCR-DIAG] listener init: kassa orderChangeRequests");
    onValue(ref(db, `${BASE}/orderChangeRequests`), snap => {
      if (OCR_DEBUG) console.log("[OCR-DIAG] listener callback: kassa orderChangeRequests");
      ocrCache = snap.exists() ? snap.val() : {};
      renderOcrList();
      updateOcrBadge();
    });
  }

  function updateOcrBadge() {
    const badge = document.getElementById("ocrTabBadge");
    if (!badge) return;
    const pending = Object.values(ocrCache).filter(r => r.status === "pending").length;
    badge.textContent = pending > 99 ? "99+" : String(pending);
    badge.classList.toggle("u-93b8ea5b", pending === 0);
  }

  window._setOcrTab = function (tabName) {
    ocrTabMode = tabName;
    document.querySelectorAll("#pageOcr .ocr-tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tabName));
    renderOcrList();
  };

  function ocrStatusMeta(status) {
    switch (status) {
      case "pending":   return { cls: "ocr-pending",   icon: "⏳", key: "status_pending",   fb: "Kutilmoqda" };
      case "approved":  return { cls: "ocr-approved",  icon: "✅", key: "status_approved",  fb: "Tasdiqlandi" };
      case "rejected":  return { cls: "ocr-rejected",  icon: "❌", key: "status_rejected",  fb: "Rad etildi" };
      case "cancelled": return { cls: "ocr-cancelled", icon: "🚫", key: "status_cancelled", fb: "Bekor qilindi" };
      default:          return { cls: "ocr-pending",   icon: "⏳", key: "status_pending",   fb: status || "" };
    }
  }

  function renderOcrList() {
    if (OCR_DEBUG) console.log("[OCR-DIAG] render start: kassa ocrList");
    const box = document.getElementById("ocrList");
    if (!box) return;

    const entries = Object.entries(ocrCache)
      .filter(([, r]) => ocrTabMode === "all" || r.status === ocrTabMode)
      .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

    if (!entries.length) {
      box.innerHTML = `<p class="empty-state">${t("oc_empty_state", "Hozircha buyurtma o'zgarish so'rovlari yo'q")}</p>`;
      return;
    }

    const reasonLabelMap = {
      customer_request: t("oc_reason_customer_request", "Mijoz so'rovi"),
      customer_wish: t("oc_reason_customer_wish", "Mijoz xohishi"),
      wrong_order: t("oc_reason_wrong_order", "Xato buyurtma qilindi"),
      out_of_stock: t("oc_reason_out_of_stock", "Taom tugagan"),
      other: t("oc_reason_other", "Boshqa"),
    };

    box.innerHTML = entries.map(([id, r]) => {
      const meta = ocrStatusMeta(r.status);
      const oldName = escHtml(getName(r.oldItem?.name) || "—");
      const changeLine = r.requestType === "cancel_item"
        ? `${oldName} <b>${r.oldItem?.qty ?? "?"} → ${Math.max(0, Number(r.oldItem?.qty || 0) - Number(r.requestedCancelQty || 0))}</b>`
        : `${oldName} → <b>${escHtml(getName(r.newItem?.name) || "—")}</b>`;
      const timeStr = r.createdAt ? new Date(r.createdAt).toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" }) : "";
      const canAct = r.status === "pending";

      return `
        <div class="ocr-card ${meta.cls}">
          <div class="ocr-card-top">
            <div class="ocr-card-title">${r.requestType === "cancel_item" ? "🚫" : "🔀"} ${t(r.requestType === "cancel_item" ? "oc_cancel_item_title" : "oc_replace_item_title", r.requestType === "cancel_item" ? "Taomni bekor qilish" : "Taomni almashtirish")}</div>
            <span class="ocr-status-badge">${meta.icon} ${t(meta.key, meta.fb)}</span>
          </div>
          <div class="ocr-card-meta">
            <span>${t("kassa_map_table_prefix", "Stol")} №${escHtml(String(r.tableId ?? "—"))}</span>
            <span>${escHtml(String(r.orderId || "").slice(-6))}</span>
            <span>${t("kassa_map_waiter", "Ofitsiant")}: ${escHtml(r.createdByName || "—")}</span>
          </div>
          <div class="ocr-change-line">${changeLine}</div>
          <div class="ocr-card-meta">
            <span>${t("reason_label", "Sabab")}: ${escHtml(reasonLabelMap[r.reason] || r.reason || "—")}</span>
            <span>🕘 ${timeStr}</span>
          </div>
          ${r.reasonNote ? `<div class="ocr-note">💬 ${escHtml(r.reasonNote)}</div>` : ""}
          ${r.status === "approved" ? `<div class="ocr-resolved-by">${t("approve_btn", "Tasdiqlash")}: ${escHtml(r.approvedByName || "")}</div>` : ""}
          ${r.status === "rejected" ? `<div class="ocr-resolved-by">${t("apv_confirm_reject_btn", "Rad etish")}: ${escHtml(r.rejectedByName || "")}${r.rejectReason ? " — " + escHtml(r.rejectReason) : ""}</div>` : ""}
          ${canAct ? `
          <div class="ocr-actions">
            <button type="button" class="ocr-btn ocr-btn-approve" onclick="window.approveOcrRequest('${id}')">✅ ${t("approve_btn", "Tasdiqlash")}</button>
            <button type="button" class="ocr-btn ocr-btn-reject" onclick="window.rejectOcrRequest('${id}')">❌ ${t("apv_confirm_reject_btn", "Rad etish")}</button>
          </div>` : ""}
        </div>`;
    }).join("");
    if (OCR_DEBUG) console.log("[OCR-DIAG] render end: kassa ocrList");
  }

  function ocrResultMessage(result) {
    if (result.ok) return { text: t("oc_approve_success", "So'rov tasdiqlandi, buyurtma yangilandi"), type: "success" };
    switch (result.reason) {
      case "order_already_paid": return { text: t("oc_paid_order_blocked_err", "Bu buyurtma allaqachon to'langan — o'zgartirish so'rovini tasdiqlab bo'lmaydi"), type: "error" };
      case "already_resolved":   return { text: t("oc_already_resolved_err", "Bu so'rov allaqachon ko'rib chiqilgan"), type: "info" };
      default: return { text: t("kassa_err_firebase", "Firebase xatoligi: "), type: "error" };
    }
  }

  // ⚠️ kassa.js'da umumiy toast tizimi mavjud emas (#toastContainer
  // kassa.html'da bor, lekin hech qanday JS uni to'ldirmaydi — orfan
  // element). Mavjud confirmKtoPayment()/processPayment() natija xabarlari
  // ham xuddi shu sababdan alert() ishlatadi — shu bilan bir xillik uchun
  // shu yerda ham yangi toast infratuzilmasi o'ylab topilmadi.
  window.approveOcrRequest = async function (requestId) {
    if (!confirm(t("apv_confirm_approve", "Ushbu so'rovni tasdiqlaysizmi?"))) return;
    if (OCR_DEBUG) console.log("[OCR-DIAG] approve start", requestId);
    try {
      const result = await approveOrderChangeRequest({
        db, ref, get, update, runTransaction, basePath: BASE, requestId, actor: ocrActor(),
      });
      if (OCR_DEBUG) console.log("[OCR-DIAG] approve end", requestId, result.ok ? "request state: pending -> approved" : result.reason);
      alert(ocrResultMessage(result).text);
    } catch (err) {
      console.error("approveOcrRequest error:", err);
      alert(t("kassa_err_firebase", "Firebase xatoligi: ") + err.message);
    }
  };

  window.rejectOcrRequest = async function (requestId) {
    const reason = prompt(t("apv_reject_reason_label", "Sababni kiriting")) || "";
    try {
      const result = await rejectOrderChangeRequest({
        db, ref, get, update, runTransaction, basePath: BASE, requestId, actor: ocrActor(), reason,
      });
      alert(result.ok ? t("oc_reject_success", "So'rov rad etildi") : ocrResultMessage(result).text);
    } catch (err) {
      console.error("rejectOcrRequest error:", err);
      alert(t("kassa_err_firebase", "Firebase xatoligi: ") + err.message);
    }
  };

  listenOrderChangeRequests();

  // ══════════════════════════════════════════════
  // TAB SWITCHING
  // ══════════════════════════════════════════════
  window.switchTab = function(tab) {
    document.getElementById("pageMap").style.display     = tab === 'map'     ? "block" : "none";
    document.getElementById("pageKassa").style.display   = tab === 'kassa'   ? "block" : "none";
    document.getElementById("pageHistory").style.display = tab === 'history' ? "block" : "none";
    document.getElementById("pageReport").style.display  = tab === 'report'  ? "block" : "none";
    document.getElementById("pageOcr").style.display     = tab === 'ocr'     ? "block" : "none";
    // 🩹 pageTableOrder — stol buyurtma ekrani — bu to'rtta asosiy tabga
    // tegishli emas, lekin ular bilan bir xil hujjat oqimida joylashgan.
    // Agar foydalanuvchi stol ekranini ochiq qoldirib boshqa tabga o'tsa,
    // bu konteyner yashirilmaguncha "block" holatida qolib, tanlangan
    // tab tarkibi bilan bir vaqtda (tepa-pastga qatlashib) ko'rinib qolardi.
    // Har qanday tab tanlanganda uni ham darhol yopib qo'yamiz.
    ktoTableKey = null;
    ktoOrderId  = null;
    document.getElementById("pageTableOrder").style.display = "none";
    document.getElementById("tabMap").classList.toggle("active",     tab === 'map');
    document.getElementById("tabKassa")?.classList.toggle("active",   tab === 'kassa');
    document.getElementById("tabHistory").classList.toggle("active", tab === 'history');
    document.getElementById("tabReport").classList.toggle("active",  tab === 'report');
    document.getElementById("tabOcr")?.classList.toggle("active",    tab === 'ocr');

    // bottom-bar faqat kassa (to'lov) tabida ko'rinadi
    const bb = document.querySelector(".bottom-bar");
    if (bb) bb.style.display = tab === 'kassa' ? "flex" : "none";

    // Hisobot ham historyData'ga tayanadi — Tarix tabi hali ochilmagan bo'lsa ham
    // shu yerdan yuklaymiz, shunda Hisobot mustaqil ishlaydi.
    if ((tab === 'history' || tab === 'report') && !historyLoaded) loadHistory();
    else if (tab === 'report') renderReport();

    if (tab === 'map') startTablesListener();
  };

  // ══════════════════════════════════════════════
  // TO'LOVLAR TARIXI
  // ══════════════════════════════════════════════

  let historyData   = [];
  let historyLoaded = false;
  let historyFilter = "all";

  async function loadHistory() {
    const listEl = document.getElementById("historyList");
    listEl.innerHTML = `
      <div class="history-loading" style="grid-column:1/-1;">
        <span class="spinner" style="border-color:rgba(0,0,0,.12);border-top-color:var(--accent);"></span>
        ${t("kassa_hist_loading")}
      </div>`;
    try {
      const snap = await get(ref(db, `${BASE}/orders`));
      if (!snap.exists()) { historyData = []; renderReport(); renderHistory(); return; }

      const all = snap.val();
      historyData = Object.entries(all)
        .map(([key, o]) => ({ key, ...o }))
        .filter(o =>
          o.status === "to'landi" ||
          o.status === "paid"     ||
          o.payment?.paid === true
        )
        .sort((a, b) => (b.paidAt || b.createdAt || 0) - (a.paidAt || a.createdAt || 0));

      historyLoaded = true;
      populateHistoryFilterOptions();
      renderReport();
      renderHistory();
    } catch(e) {
      listEl.innerHTML = `<div class="hist-empty"><div class="icon">⚠️</div>${t("kassa_err_load")}${e.message}</div>`;
    }
  }

  // ── Kassir va To'lov turi dropdown'larini haqiqiy ma'lumotlar asosida to'ldiradi ──
  function populateHistoryFilterOptions() {
    const cashierSel = document.getElementById("histCashierFilter");
    const methodSel  = document.getElementById("histMethodFilter");
    if (cashierSel) {
      const cashiers = [...new Set(historyData.map(o => o.payment?.kassir).filter(Boolean))].sort();
      cashierSel.innerHTML = `<option value="">${t("kassa_hist_filter_all_cashiers", "Barcha kassirlar")}</option>` +
        cashiers.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join("");
    }
    if (methodSel) {
      methodSel.innerHTML = `<option value="">${t("kassa_hist_filter_all_methods", "Barcha to'lov turlari")}</option>` +
        PAY_LABELS.map(m => `<option value="${escHtml(m)}">${escHtml(payMethodDisplayLabel(m))}</option>`).join("");
    }
  }

  // ── 📈 Kassa hisoboti — bugungi to'lovlar bo'yicha ──
  function renderReport() {
    const methodsRow = document.getElementById("reportMethodsRow");
    if (!methodsRow) return;

    const todayStr = new Date().toLocaleDateString("uz-UZ");
    const todays = historyData.filter(o => {
      const d = o.paidAt || o.createdAt;
      return d && new Date(d).toLocaleDateString("uz-UZ") === todayStr;
    });

    // Har bir usul bo'yicha jami (KTO_PAY_LABELS — kassa ekranida ishlatiladigan
    // aynan shu 5 ta usul, boshqa qiymat kelsa ham yig'indiga qo'shiladi lekin
    // alohida pastki nomlanmagan usul sifatida ko'rsatilmaydi).
    const totalsByMethod = {};
    KTO_PAY_LABELS.forEach(m => { totalsByMethod[m] = 0; });
    let grandTotal = 0;
    todays.forEach(o => {
      const m = o.payment?.method;
      const amt = Number(o.total) || 0;
      if (m && totalsByMethod[m] !== undefined) totalsByMethod[m] += amt;
      grandTotal += amt;
    });

    const shortLabel = { "Naqd": t("kassa_pay_label_cash", "Naqd"), "Uzum Bank": "Uzum", "Bank karta": t("kassa_kto_pm_card", "Karta") };
    methodsRow.innerHTML = KTO_PAY_LABELS.map(m => `
      <div class="report-method-pill">
        <span class="rmp-label">${escHtml(shortLabel[m] || m)}</span>
        <span class="rmp-value">${fmt(totalsByMethod[m])}</span>
      </div>`).join("") + `
      <div class="report-method-pill grand">
        <span class="rmp-label">${t("kassa_report_grand_label", "Jami")}</span>
        <span class="rmp-value">${fmt(grandTotal)}</span>
      </div>`;

    // Stats
    const count = todays.length;
    const avg = count ? Math.round(grandTotal / count) : 0;
    const max = count ? Math.max(...todays.map(o => Number(o.total) || 0)) : 0;

    let topMethod = "—";
    if (count) {
      const methodCounts = {};
      todays.forEach(o => {
        const m = o.payment?.method || "—";
        methodCounts[m] = (methodCounts[m] || 0) + 1;
      });
      topMethod = Object.entries(methodCounts).sort((a, b) => b[1] - a[1])[0][0];
    }

    document.getElementById("repCount").textContent      = `${count} ${t("kassa_unit_pieces", "ta")}`;
    document.getElementById("repAvg").textContent         = count ? fmt(avg) : "—";
    document.getElementById("repMax").textContent         = count ? fmt(max) : "—";
    document.getElementById("repTopMethod").textContent   = topMethod;
  }

  window.setHistFilter = function(f) {
    historyFilter = f;
    document.getElementById("hfAll").classList.toggle("active",       f === "all");
    document.getElementById("hfToday").classList.toggle("active",     f === "today");
    document.getElementById("hfYesterday").classList.toggle("active", f === "yesterday");
    renderHistory();
  };

  window.filterHistory = function() { renderHistory(); };

  function renderHistory() {
    const listEl   = document.getElementById("historyList");
    const query    = (document.getElementById("histSearch").value || "").trim().toLowerCase();
    const todayStr = new Date().toLocaleDateString("uz-UZ");
    const yesterdayStr = new Date(Date.now() - 86400000).toLocaleDateString("uz-UZ");
    const rangeFrom = document.getElementById("histDateFrom")?.value || "";
    const rangeTo   = document.getElementById("histDateTo")?.value   || "";
    const cashierFilterVal = document.getElementById("histCashierFilter")?.value || "";
    const methodFilterVal  = document.getElementById("histMethodFilter")?.value  || "";

    const items = historyData.filter(o => {
      const d = o.paidAt || o.createdAt;

      if (historyFilter === "today") {
        if (!d || new Date(d).toLocaleDateString("uz-UZ") !== todayStr) return false;
      }
      if (historyFilter === "yesterday") {
        if (!d || new Date(d).toLocaleDateString("uz-UZ") !== yesterdayStr) return false;
      }
      if (historyFilter === "range" && (rangeFrom || rangeTo)) {
        if (!d) return false;
        const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
        if (rangeFrom && dayStart < new Date(rangeFrom)) return false;
        if (rangeTo) {
          const toEnd = new Date(rangeTo); toEnd.setHours(23, 59, 59, 999);
          if (dayStart > toEnd) return false;
        }
      }
      if (cashierFilterVal && o.payment?.kassir !== cashierFilterVal) return false;
      if (methodFilterVal && o.payment?.method !== methodFilterVal) return false;

      if (query) {
        const num   = String(o.orderNumber || o.key?.slice(-6) || "").toLowerCase();
        const kassa = String(o.kassaCode || "").toLowerCase();
        const phone = String(o.customerPhone || o.clientPhone || "").toLowerCase();
        const table = String(o.table || "").toLowerCase();
        if (!num.includes(query) && !kassa.includes(query) && !phone.includes(query) && !table.includes(query))
          return false;
      }
      return true;
    });

    // Stats
    const totalAmt = items.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const avg      = items.length ? Math.round(totalAmt / items.length) : 0;
    document.getElementById("hsTotalCount").textContent  = items.length;
    document.getElementById("hsTotalAmount").textContent = items.length ? fmt(totalAmt) : "0 " + t("currency", "so'm");
    document.getElementById("hsAvg").textContent         = items.length ? fmt(avg) : "—";

    if (!items.length) {
      listEl.innerHTML = `
        <div class="hist-empty">
          <div class="icon">🧾</div>
          ${query || historyFilter === "today" ? t("kassa_hist_empty_filter") : t("kassa_hist_empty_all")}
        </div>`;
      return;
    }

    const PAY_ICONS = {
      "Naqd":"💵","UzCard":"💳","Humo":"💳","Uzum Bank":"📱",
      "Click":"📲","Payme":"📲","Bank karta":"💳","QR kod":"📷"
    };

    listEl.innerHTML = "";
    items.forEach(o => {
      const num     = formatOrderNumber(o) || `#${o.key?.slice(-6) || "—"}`;
      const kassa   = o.kassaCode   || "";
      const table   = o.table       || "";
      const method  = o.payment?.method || "—";
      const phone   = o.customerPhone || o.clientPhone || o.phoneNumber || "";
      // customerName ba'zan "Stol N" kabi avtomatik yorliq bilan to'lgan
      // bo'lishi mumkin (haqiqiy mijoz ismi emas) — buni ko'rsatmaymiz.
      const rawName = getName(o.customerName) || "";
      const looksLikeTableLabel = /^stol\s*\d+$/i.test(rawName.trim());
      const customerName = (rawName && !looksLikeTableLabel) ? rawName : "";
      const amount  = Number(o.total) || 0;
      const paidAt  = o.paidAt || o.createdAt;
      const dateStr = paidAt
        ? new Date(paidAt).toLocaleString("uz-UZ", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" })
        : "—";
      const icon = PAY_ICONS[method] || "💰";

      const el = document.createElement("div");
      el.className = "hist-item";
      el.innerHTML = `
        <div class="hist-top">
          <div>
            <div class="hist-order">${num}</div>
            ${kassa ? `<div class="hist-kassa">🎫 ${kassa}</div>` : ""}
          </div>
          <div class="hist-amount">${fmt(amount)}</div>
        </div>
        <div class="hist-meta">
          ${table  ? `<span class="hist-tag">🪑 ${t("kassa_map_table_prefix", "Stol")} ${table}</span>` : ""}
          ${customerName ? `<span class="hist-tag">👤 ${escHtml(customerName)}</span>` : ""}
          ${method !== "—" ? `<span class="hist-tag green">${icon} ${escHtml(payMethodDisplayLabel(method))}</span>` : ""}
          ${phone  ? `<span class="hist-tag blue">📞 ${phone}</span>` : ""}
        </div>
        <div class="hist-date">🕐 ${dateStr}</div>
        <div class="hist-actions">
          <button class="hist-action-btn" onclick="window.reprintHistoryReceipt('${o.key}')">🖨 ${t("kassa_hist_reprint_btn", "Qayta chiqarish")}</button>
          <button class="hist-action-btn" onclick="window.downloadHistoryReceipt('${o.key}')">📄 PDF</button>
          <button class="hist-action-btn" onclick="window.sendHistoryReceiptToPrinter('${o.key}')">🖶 ${t("kassa_hist_send_printer_btn", "Printerga yuborish")}</button>
        </div>
      `;
      listEl.appendChild(el);
    });
  }

  // Header'dan (applyHeaderBranding orqali) o'qib olingan restoran nomi/INN —
  // chekni chop etishda ham ishlatish uchun modul darajasida saqlanadi.
  let receiptRestaurantName = "";
  let receiptRestaurantInn  = "";

  // Endi receiptEngine.buildReceiptBodyHtml() ni chaqiradi (waiter.js/client.js/
  // admin.js bilan bir xil shablon) — avvalgi buildHistoryReceiptHtml/RCPT_STYLE
  // shu bitta funksiyaga almashtirildi. Maydonlar (Zal/Stol/Ochilgan/Buyurtma/
  // Ofitsiant/tovar jadvali/chegirma/jami) aynan avvalgidek saqlanadi.
  function _kassaReceiptEngineData(order) {
    const items = Object.values(order.items || {});
    const subtotal = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);
    // 🆕 Sozlamalar → Chop etish sozlamalari (printSettingsCache) — logotip/QR/
    // shtrix-kod/pastki matn kassa chekida ham waiter.js bilan bir xil tarzda
    // hurmat qilinishi uchun (avval kassa bu sozlamalarni umuman o'qimasdi).
    const ps = printSettingsCache || {};
    const showLogo = ps.receiptLogo !== false; // default: yoqilgan
    const orderNum = order.orderNumber || order.key?.slice(-6);
    return {
      restaurantName: receiptRestaurantName || t("sa_default_rest_name", "Restoran"),
      filial: receiptRestaurantInn ? `INN: ${receiptRestaurantInn}` : "",
      logoUrl: showLogo ? (restaurantSettings?.restaurantLogoUrl || "") : "",
      date: order.createdAt ? new Date(order.createdAt).toLocaleDateString("uz-UZ") : "—",
      time: order.createdAt ? new Date(order.createdAt).toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" }) : "",
      orderId: order.key,
      orderNumber: orderNum,
      table: order.table,
      waiterName: order.waiterName || order.payment?.kassir || "",
      items: items.map(i => ({
        name: getName(i.name) || getName(i.title) || "—",
        qty: Number(i.qty) || 1,
        price: Number(i.price) || 0,
      })),
      subtotal,
      discount: Number(order.discount) || 0,
      ...(Number(order.tableServiceAmount || 0) > 0 ? {
        extraFeeRows: [{ label: t("table_service_row_label", "Stol xizmati"), value: Number(order.tableServiceAmount) }]
      } : {}),
      total: (Number(order.total) || subtotal) + Math.max(0, Number(order.tableServiceAmount || 0)),
      methodLabel: order.payment?.method ? paymentMethodLabel(order.payment.method, t) : "",
      barcodeText: ps.receiptBarcode ? String(orderNum || "").trim() : "",
      footerText: ps.receiptFooter && String(ps.receiptFooter).trim() ? ps.receiptFooter : undefined,
      ...(ps.receiptQr && order.qrDiscountClaimToken ? {
        qrText: `${window.location.origin}/client.html?rest=${encodeURIComponent(restaurantId)}&discount=${encodeURIComponent(order.qrDiscountClaimToken)}`,
        qrCaption: `${t("receipt_qr_caption", "Keyingi tashrifingizga")} ${Number(ps.receiptQrPercent || 0)}% ${t("receipt_qr_caption_2", "chegirma")}`,
      } : {}),
    };
  }
  function _kassaReceiptWidth() {
    return (printSettingsCache || {}).receiptPaperSize === "58mm" ? "58mm" : "80mm";
  }
  function _kassaReceiptCopies() {
    return Number((printSettingsCache || {}).receiptCopies) || 1;
  }

  const _KASSA_PRINT_DIAG = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  function _kassaPrintDiag(stage) {
    if (_KASSA_PRINT_DIAG) console.info(`[KASSA-PRINT-DIAG] ${stage}`);
  }

  function _kassaAutoPrintReceipt(order, orderId) {
    _kassaPrintDiag("payment success");
    try {
      _kassaPrintDiag("receipt build");
      const receiptData = _kassaReceiptEngineData({ key: orderId, ...order });
      _kassaPrintDiag("receipt html ready");
      if (receiptData.qrText) _kassaPrintDiag("qr ready");
      if (receiptData.barcodeText) _kassaPrintDiag("barcode ready");
      _kassaPrintDiag("print start");
      const win = printReceiptInPopup(receiptData, {
        t, width: _kassaReceiptWidth(), copies: _kassaReceiptCopies(), title: t("kassa_rcpt_print_title", "Chek"),
        onPopupBlocked: () => {
          alert(t("kassa_print_popup_blocked_err", "To'lov qabul qilindi, lekin chek avtomatik chiqmadi (popup bloklandi). Qayta chop etish tugmasidan foydalaning yoki brauzer sozlamalarini tekshiring."));
        },
      });
      if (win) _kassaPrintDiag("print complete");
    } catch (e) {
      console.error("[KASSA-PRINT-DIAG] print error:", e);
      alert(t("kassa_print_error_err", "To'lov qabul qilindi, lekin chekni chiqarishda xatolik yuz berdi. Qayta chop etish tugmasidan foydalaning."));
    }
  }

  function findHistoryOrder(orderId) {
    return historyData.find(o => o.key === orderId) || null;
  }

  window.reprintHistoryReceipt = function (orderId) {
    const order = findHistoryOrder(orderId);
    if (!order) { alert(t("kassa_receipt_not_found", "Chek topilmadi")); return; }
    printReceiptInPopup(_kassaReceiptEngineData(order), {
      t, width: _kassaReceiptWidth(), copies: _kassaReceiptCopies(), title: t("kassa_rcpt_print_title", "Chek"),
      onPopupBlocked: () => alert(t("kassa_popup_blocked", "Popup bloklandi — brauzer sozlamalarini tekshiring")),
    });
  };

  window.downloadHistoryReceipt = function (orderId) {
    const order = findHistoryOrder(orderId);
    if (!order) { alert(t("kassa_receipt_not_found", "Chek topilmadi")); return; }
    downloadReceiptHtmlFile(_kassaReceiptEngineData(order), {
      t, width: _kassaReceiptWidth(), title: t("kassa_rcpt_print_title", "Chek"),
      filename: `chek-${order.orderNumber || orderId.slice(-6)}.html`,
    });
  };

  window.sendHistoryReceiptToPrinter = function (orderId) {
    window.reprintHistoryReceipt(orderId);
  };

  document.getElementById("orderInput").addEventListener("keydown", e => {
    if (e.key === "Enter") searchOrder();
  });

  function applyHeaderBranding(settings, info) {
    const name = settings?.restaurantName || info?.name || "";
    const logoUrl = settings?.restaurantLogoUrl || "";

    receiptRestaurantName = name || "";
    receiptRestaurantInn  = settings?.inn || info?.inn || "";

    const nameEl = document.getElementById("kassaHeaderRestName");
    if (nameEl) nameEl.textContent = name || "";

    const logoImg = document.querySelector("#nestaHeaderBrand .nesta-header-logo");
    if (logoImg) {
      logoImg.src = logoUrl || "img/logo (2).svg";
    }
  }

  (async function initHeaderBranding() {
    let cachedInfo = {};
    try {
      const [settSnap, infoSnap] = await Promise.all([
        get(ref(db, `${BASE}/settings`)),
        get(ref(db, `${BASE}/info`))
      ]);
      cachedInfo = infoSnap.val() || {};
      restaurantSettings = settSnap.val() || {};
      applyHeaderBranding(restaurantSettings, cachedInfo);
      applyEnabledPaymentMethodsToKassaUI();
      updateStaffFooter(_staffFooterEl, restaurantSettings, t);
    } catch (e) {
      console.warn("initHeaderBranding:", e);
    }
    // Sozlamalar keyinchalik (admin panelidan) o'zgarsa ham header yangilanadi
    onValue(ref(db, `${BASE}/settings`), snap => {
      restaurantSettings = snap.val() || {};
      applyHeaderBranding(restaurantSettings, cachedInfo);
      applyEnabledPaymentMethodsToKassaUI();
      // 🆕 Yagona staff footer (ish vaqti/telefon) — refreshsiz yangilanadi.
      updateStaffFooter(_staffFooterEl, restaurantSettings, t);
      // "To'lovni kim qabul qiladi?" o'zgarsa, ochiq turgan buyurtma
      // ko'rish ekranidagi to'lov tugmasi holati ham darhol yangilansin.
      if (ktoOrderId && document.getElementById("pageTableOrder")?.style.display !== "none") {
        resetKtoPaymentUI(ordersRaw[ktoOrderId]);
      }
    });
    // 🆕 Chop etish sozlamalari — admin Sozlamalar'dan o'zgartirilsa, kassa
    // chekni darhol yangi qiymat bilan chop etadi (qayta yuklashsiz).
    onValue(ref(db, `${BASE}/printSettings`), snap => {
      printSettingsCache = snap.val() || {};
    });
  })();

  // ── Header: terminal nomi (Sozlamalar → Terminal sozlamalari, admin.js
  //    orqali yoziladi: restaurants/{id}/terminalSettings/name). Admin
  //    kassa nomini o'zgartirsa, shu yerda darhol yangilanadi. ──
  function applyTerminalName(s) {
    const nameEl = document.getElementById("kassaHeaderTerminalName");
    if (!nameEl) return;
    const name = (s?.name || "").trim();
    nameEl.textContent = name || t("kassa_terminal", "Terminal 1");
  }
  onValue(ref(db, `${BASE}/terminalSettings`), snap => {
    applyTerminalName(snap.val() || {});
  });

  // ── Sahifa ochilganda kassir birinchi Zallar xaritasini ko'radi ──
  switchTab("map");