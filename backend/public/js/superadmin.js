import { loadNestaFirebaseApp, loadNestaNamedFirebaseApp } from "./nestaFirebaseApp.js";
import { getDatabase, forceWebSockets, ref, get, set, update, onValue, remove, push, runTransaction } from "./pgRtdb.js";
import { getAuth, onAuthStateChanged, signOut, createUserWithEmailAndPassword, setPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { t, getLang, setLang, applyLang, onLangChange } from "./i18n.js";
// NOTE on ordering: per the ES module spec, `import` declarations are
// always evaluated before any of THIS module's own top-level statements,
// regardless of where in the source they're written — so writing
// forceWebSockets() above or below this line has no effect on which runs
// first; superadmin_features.js's module body always runs before any code
// here. That's fine today (verified: superadmin_features.js has zero
// top-level Firebase calls — only function/window.* assignments, nothing
// executes immediately), but it's exactly why forceWebSockets() is also
// called at the top of superadmin_features.js itself below (redundant,
// idempotent, cheap) rather than relying on source position in this file.
import "./superadmin_features.js";

// Force WebSocket-only transport (never fall back to `.lp` long-polling).
// A previous version of this file only called this ~1700 lines further
// down; moved here so it's the first thing THIS module's own top-level
// code does (after its imports have resolved, per the note above).
forceWebSockets();

// VAQTINCHALIK DEBUG — muammo topilgach o'chirib tashlang
window.alert = new Proxy(window.alert, {
  apply(target, thisArg, args) {
    console.log('[ALERT DEBUG]', {
      lang: getLang(),
      text: args[0]
    });
    return target.apply(thisArg, args);
  }
});
window.ref = ref;
window.remove = remove;
// 🩹 Audit fix: several inline, non-module <script> blocks in
// superadmin.html (e.g. _listenPlatformSettings/_listenReceiptFooter) call
// onValue()/get()/set() as bare globals — but only window.ref/window.db
// were ever exposed here. Since those blocks are classic scripts (not
// type="module"), they can't `import` these themselves, so every such call
// threw "onValue is not defined" — silently swallowed by their own
// try/catch, meaning those "live" listeners never actually ran. Exposing
// the same functions window.ref already uses, so bare/window.-prefixed
// calls in those blocks now resolve for real.
window.onValue = onValue;
window.get = get;
window.set = set;
window.runTransaction = runTransaction;

// ============================================
// 🏷️ BUSINESS TYPE va MODULLAR KATALOGI
// ============================================
// Har bir modul: id, nom va ikonka. Bu ro'yxat admin.js bilan bir xil bo'lishi shart
// (FEATURE_SECTION_MAP / MODULE_SECTION_MAP bilan moslashtirilgan).
window.MODULE_CATALOG = {
  pos:          { n: () => t("mod_pos", "Kassa (POS)") },
  qr_menu:      { n: () => t("mod_qr_menu", "QR-Menyu") },
  kitchen:      { n: () => t("mod_kitchen", "Oshxona ekrani (KDS)") },
  waiter:       { n: () => t("mod_waiter", "Ofitsiant paneli") },
  tables:       { n: () => t("mod_tables", "Stollar") },
  inventory:    { n: () => t("mod_inventory", "Ombor / Inventarizatsiya") },
  crm:          { n: () => t("mod_crm", "CRM (Mijozlar)") },
  reservations: { n: () => t("mod_reservations", "Bron tizimi") },
  purchase:     { n: () => t("mod_purchase", "Xaridlar") },
  suppliers:    { n: () => t("mod_suppliers", "Yetkazib beruvchilar") },
  reports:      { n: () => t("mod_reports", "Hisobotlar") },
  finance:      { n: () => t("mod_finance", "Moliya") },
  loyalty:      { n: () => t("mod_loyalty", "Loyalty / Sodiqlik") },
  delivery:     { n: () => t("mod_delivery", "Yetkazib berish") },
  accounting:   { n: () => t("mod_accounting", "Buxgalteriya") },
  take_away:    { n: () => t("mod_take_away", "Take Away") },
  split_bill:   { n: () => t("mod_split_bill", "Chekni bo'lish") },
  production:   { n: () => t("mod_production", "Ishlab chiqarish") }
};

// Business type → shu turga tavsiya etiladigan modullar ro'yxati
// (rasmdagi "Tavsiya etiladigan Business Type'lar" jadvaliga mos)
window.BUSINESS_TYPE_MODULES = {
  restaurant: { label: () => t("btype_restaurant", "Restoran"), modules: ['pos', 'tables', 'waiter', 'qr_menu', 'kitchen', 'delivery', 'take_away', 'inventory', 'purchase', 'crm', 'reservations', 'finance', 'reports'] },
  cafe:       { label: () => t("btype_cafe", "Kafe"), modules: ['pos', 'tables', 'waiter', 'qr_menu', 'kitchen', 'delivery', 'take_away', 'inventory', 'purchase', 'crm', 'reservations', 'finance', 'reports'] },
  teahouse:   { label: () => t("btype_teahouse", "Choyxona"), modules: ['pos', 'tables', 'waiter', 'qr_menu', 'kitchen', 'take_away', 'inventory', 'purchase', 'finance', 'reports'] },
  fastfood:   { label: () => t("btype_fastfood", "Fast Food"), modules: ['pos', 'kitchen', 'delivery', 'take_away', 'inventory', 'purchase', 'finance', 'reports'] },
  coffeeshop: { label: () => t("btype_coffeeshop", "Coffee Shop"), modules: ['pos', 'inventory', 'kitchen', 'loyalty'] },
  bar:        { label: () => t("btype_bar", "Bar/Pub"), modules: ['pos', 'tables', 'waiter', 'qr_menu', 'kitchen', 'take_away', 'inventory', 'purchase', 'crm', 'reservations', 'finance', 'reports'] },
  pizzeria:   { label: () => t("btype_pizzeria", "Pizzeria"), modules: ['pos', 'tables', 'waiter', 'qr_menu', 'kitchen', 'delivery', 'take_away', 'inventory', 'purchase', 'crm', 'reservations', 'finance', 'reports'] },
  bakery:     { label: () => t("btype_bakery", "Bakery"), modules: ['pos', 'kitchen', 'take_away', 'inventory', 'purchase', 'finance', 'reports'] },
  canteen:    { label: () => t("btype_canteen", "Oshxona (Stolovaya)"), modules: ['pos', 'tables', 'kitchen', 'take_away', 'inventory', 'purchase', 'finance', 'reports'] },
  other:      { label: () => t("btype_other", "Boshqa"), modules: ['pos', 'kitchen', 'inventory'] }
};

// Business type tanlanganda shu turga mos modullarni true, qolganlarini false qilib qaytaradi
window.buildModulesFromBusinessType = function (businessTypeKey) {
  const allModuleIds = Object.keys(window.MODULE_CATALOG);
  const recommended = window.BUSINESS_TYPE_MODULES[businessTypeKey]?.modules || [];
  const modules = {};
  allModuleIds.forEach(id => { modules[id] = recommended.includes(id); });
  return modules;
};

// Tarif → limitlar katalogi (modul emas, faqat son cheklovlari)
window.PLAN_LIMITS = {
  start:   { maxStaff: 5,  maxChefs: 2, maxTables: 15, maxCustomers: 500,  maxBranches: 1 },
  pro:     { maxStaff: 20, maxChefs: 5, maxTables: 50, maxCustomers: 5000, maxBranches: 3 },
  premium: { maxStaff: Infinity, maxChefs: Infinity, maxTables: Infinity, maxCustomers: Infinity, maxBranches: Infinity }
};

// HTML formada limitChefs{Prefix} inputi bo'lmasa, limitStaff{Prefix} yonida
// dinamik ravishda "Oshpazlar soni" inputini yaratib qo'yamiz.
window.ensureChefLimitInput = function (prefix, currentVal) {
  const existing = document.getElementById(`limitChefs${prefix}`);
  if (existing) {
    if (document.activeElement !== existing) {
      existing.value = (currentVal === undefined || currentVal === null || Number(currentVal) <= 0) ? "" : currentVal;
    }
    return;
  }

  const staffInput = document.getElementById(`limitStaff${prefix}`);
  if (!staffInput) return;

  const staffGroup = staffInput.closest(".form-group") || staffInput.parentElement;
  if (!staffGroup || !staffGroup.parentElement) return;

  const wrapper = document.createElement("div");
  wrapper.className = "form-group";
  wrapper.style.cssText = "margin-bottom:14px;";
  wrapper.innerHTML = `
    <label style="display:block; font-size:13px; font-weight:700; color:#374151; margin-bottom:6px;">
      👨‍🍳 ${t("sa_limit_chefs_label", "Oshpazlar soni (limit)")}
    </label>
    <input type="number" id="limitChefs${prefix}" min="0" placeholder="∞"
           style="width:100%; padding:10px 12px; border:1px solid #d1d5db; border-radius:8px; font-size:14px;"
           value="${(currentVal === undefined || currentVal === null || Number(currentVal) <= 0) ? "" : currentVal}">
    <div style="font-size:12px; color:#9ca3af; margin-top:4px;">
      ${t("sa_limit_chefs_hint", "Bo'sh qoldirilsa — cheksiz. Bu limit faqat 'chef' rolidagi xodimlarni sanaydi.")}
    </div>`;

  staffGroup.parentElement.insertBefore(wrapper, staffGroup.nextSibling);
};

// Modal HTML faylida <select id="newRestBusinessType"> bo'lmasa, uni shu yerga
// dinamik tarzda qo'shib qo'yamiz (forma maydoni mavjud bo'lgan joyga, masalan domain
// inputidan keyin). Agar select allaqachon mavjud bo'lsa — option'larini to'ldiramiz.
window.ensureBusinessTypeField = function (selectId, modalEl) {
  if (!modalEl) return null;
  let select = document.getElementById(selectId);

  if (!select) {
    const wrapper = document.createElement("div");
    wrapper.className = "form-group business-type-field";
    wrapper.style.cssText = "margin-bottom:14px;";
    wrapper.innerHTML = `
      <label style="display:block; font-size:13px; font-weight:700; color:#374151; margin-bottom:6px;">
        🏪 ${t("biz_type_label", "Biznes turi")}
      </label>
      <select id="${selectId}" style="width:100%; padding:10px 12px; border:1px solid #d1d5db; border-radius:8px; font-size:14px; background:#fff;"></select>
      <div style="font-size:12px; color:#9ca3af; margin-top:4px;">
        ${t("biz_type_hint", "Tanlangan turga qarab tavsiya etilgan modullar avtomatik yoqiladi. Keyin Modullar bo'limidan o'zgartirish mumkin.")}
      </div>`;

    // Anchor topish: domain input maydonidan keyin qo'yamiz, topilmasa modal ichiga oxiriga qo'shamiz
    const anchorInput = modalEl.querySelector('[id*="Domain"]');
    const anchorGroup = anchorInput ? (anchorInput.closest(".form-group") || anchorInput.parentElement) : null;
    if (anchorGroup && anchorGroup.parentElement) {
      anchorGroup.parentElement.insertBefore(wrapper, anchorGroup.nextSibling);
    } else {
      const modalBody = modalEl.querySelector(".modal-body") || modalEl.querySelector(".modal-content") || modalEl;
      modalBody.appendChild(wrapper);
    }
    select = wrapper.querySelector("select");
  }

  // Optionlarni har safar to'ldiramiz (til o'zgarishi bo'lsa ham yangilanadi)
  const prevValue = select.value;
  select.innerHTML = `<option value="">${t("biz_type_select_placeholder", "— Tanlang —")}</option>` +
    Object.entries(window.BUSINESS_TYPE_MODULES).map(([key, data]) =>
      `<option value="${key}">${typeof data.label === "function" ? data.label() : data.label}</option>`
    ).join("");
  if (prevValue) select.value = prevValue;

  return select;
};

window.updateGrowthChart = async function (period) {
  const ctx = document.getElementById('growthChart');
  if (!ctx) return;

  const dates = Object.values(window.allRestaurants || {})
    .map(r => r.info?.createdAt)
    .filter(d => d);

  let labels = [];
  let dataPoints = [];
  const now = new Date();

  if (period === 'daily') {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      labels.push(`${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`);

      const count = dates.filter(date => {
        const cd = new Date(date);
        return cd.getDate() === d.getDate() && cd.getMonth() === d.getMonth() && cd.getFullYear() === d.getFullYear();
      }).length;
      dataPoints.push(count);
    }
  } else if (period === 'monthly') {
    const monthNames = [
      t("month_jan", "Yanvar"), t("month_feb", "Fevral"), t("month_mar", "Mart"),
      t("month_apr", "Aprel"), t("month_may", "May"), t("month_jun", "Iyun"),
      t("month_jul", "Iyul"), t("month_aug", "Avgust"), t("month_sep", "Sentabr"),
      t("month_oct", "Oktabr"), t("month_nov", "Noyabr"), t("month_dec", "Dekabr")
    ];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      labels.push(`${monthNames[d.getMonth()]} ${d.getFullYear()}`);

      const count = dates.filter(date => {
        const cd = new Date(date);
        return cd.getMonth() === d.getMonth() && cd.getFullYear() === d.getFullYear();
      }).length;
      dataPoints.push(count);
    }
  }

  if (window.myGrowthChart) {
    window.myGrowthChart.data.labels = labels;
    window.myGrowthChart.data.datasets[0].data = dataPoints;
    window.myGrowthChart.data.datasets[0].label = t("sa_new_connections", "Yangi ulanishlar");
    window.myGrowthChart.update();
  } else {
    window.myGrowthChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: t("sa_new_connections", "Yangi ulanishlar"),
          data: dataPoints,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          borderWidth: 3,
          fill: true,
          tension: 0.4,
          pointRadius: 5,
          pointBackgroundColor: '#fff',
          pointBorderColor: '#10b981'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { borderDash: [5, 5] } },
          x: { grid: { display: false } }
        }
      }
    });
  }
};

window.updateRevenueByFilter = async function () {
  console.log(t("sa_log_revenue_filter", "📊 Daromad filtri ishga tushdi..."));

  try {
    const startInput = document.getElementById("revStartDate").value;
    const endInput = document.getElementById("revEndDate").value;

    const start = startInput ? new Date(startInput).getTime() : 0;
    const end = endInput ? new Date(endInput).setHours(23, 59, 59, 999) : Date.now();

    const selectedMethods = Array.from(document.querySelectorAll('.revMethod:checked'))
      .map(el => el.value.toLowerCase());

    if (selectedMethods.length === 0) {
      document.getElementById("totalRevenueDisplay").innerText = "0 " + t("sa_currency_uzs", "so'm");
      return;
    }

    // P0-2 systemData-regression fix: systemData/paymentHistory is no
    // longer client-readable directly (see database.rules.json) — reuse
    // listenPaymentHistory()'s poller cache (globalPaymentsData) when it's
    // already populated, falling back to a direct backend fetch (same
    // Admin-SDK-backed endpoint) if this runs before the first poll tick.
    const payments = globalPaymentsData || await _saDashFetch('/payment-history');
    if (!payments || !Object.keys(payments).length) {
      document.getElementById("totalRevenueDisplay").innerText = "0 " + t("sa_currency_uzs", "so'm");
      return;
    }

    let total = 0;

    Object.values(payments).forEach(p => {
      const payDate = p.date || 0;
      const payMethod = (p.method || "").toLowerCase();

      const dateMatch = payDate >= start && payDate <= end;

      const methodMatch = selectedMethods.some(m => payMethod.includes(m));

      if (dateMatch && methodMatch) {
        total += Number(p.amount || 0);
      }
    });

    const display = document.getElementById("totalRevenueDisplay");
    if (display) {
      display.innerText = total.toLocaleString('ru-RU') + " " + t("sa_currency_uzs", "so'm");
    }

    const label = document.getElementById("revenueLabel");
    if (label) {
      label.innerText = (start === 0 && !endInput)
        ? t("sa_stat_total_revenue", "Jami tushgan pullar")
        : t("sa_filtered_revenue", "Filtrlangan tushum");
    }

  } catch (err) {
    // _saDashFetch()'s thrown message carries the backend HTTP status
    // (e.g. "401: Unauthorized"/"503: Unavailable") rather than the old
    // Firebase "Permission denied" text — any failure here now means the
    // backend call itself didn't succeed, so the same existing fallback
    // message applies regardless of the exact reason.
    console.error(t("sa_err_revenue_filter", "Revenue filtrida xato:"), err);
    const display = document.getElementById("totalRevenueDisplay");
    if (display) display.innerText = t("sa_err_no_permission", "Ruxsat yo'q (Rules)");
  }
};

window.handleChartPeriodChange = function (value) {
  const customDiv = document.getElementById("chartCustomDates");
  if (customDiv) {
    customDiv.style.display = (value === "custom") ? "flex" : "none";
  }

  if (typeof window.updateGrowthChart === "function") {
    window.updateGrowthChart(value);
  }
};

document.getElementById("chartStartDate")?.addEventListener("change", () => window.updateGrowthChart('custom'));
document.getElementById("chartEndDate")?.addEventListener("change", () => window.updateGrowthChart('custom'));

// ============================================
// ENG FAOL VA ENG PASSIV RESTORANLAR REYTINGI
// ============================================
// Ro'yxat endi FAQAT nom + ball ko'rsatadi (domen/subdomen kabi qo'shimcha
// ma'lumotlar doimiy ko'rinmaydi — bosilganda ochiladigan detail modalga
// ko'chirildi, pastdagi window.saOpenActivityDetail()ga qarang). Har bir
// qator bosiladigan (nom yoki ball — butun qator) va o'sha restoranning
// to'liq tafsilotini modalda ochadi.
window.updateActivityRanking = function () {
  const activeList = document.getElementById("activeRestaurantsList");
  const passiveList = document.getElementById("passiveRestaurantsList");
  if (!activeList || !passiveList) return;

  // Xato ma'lumot UI'ni yiqitmasin (talab #17): nom yo'q bo'lsa "Noma'lum",
  // ball hisoblanmasa 0 — window.calculateActivityScore() o'zi ham har bir
  // ichki maydonni (users/ordersCount/info/subscription) yo'qligiga
  // chidamli, shuning uchun bu yerda faqat nomni himoyalash kifoya.
  let restaurantsArray = Object.entries(window.allRestaurants || {}).map(([id, data]) => {
    const name = data?.info?.name || t("sa_unknown", "Noma'lum");
    let score = 0;
    try { score = window.calculateActivityScore(id, data); } catch (e) { score = 0; }
    return { id, name, score };
  });

  let topActive = [...restaurantsArray].sort((a, b) => b.score - a.score).slice(0, 4);
  let topPassive = [...restaurantsArray].sort((a, b) => a.score - b.score).slice(0, 4);

  // Talab #16: uchta alohida bo'sh-holat matni — restoranlar UMUMAN yo'q
  // bo'lsa (source ro'yxati bo'sh) ikkala ro'yxatda ham shu umumiy xabar
  // ko'rsatiladi; aks holda har biri o'zining "topilmadi" xabarini
  // ko'rsatadi (masalan barcha restoranlar faol bo'lsa, Passiv ro'yxati
  // bo'sh qoladi va o'ziga xos xabarini ko'rsatadi, umumiy xabarni emas).
  const noRestaurantsAtAll = restaurantsArray.length === 0;

  const renderList = (arr, container, isFaol, emptyKey, emptyDefault) => {
    container.innerHTML = "";
    if (arr.length === 0) {
      const msg = noRestaurantsAtAll
        ? t("sa_no_restaurants_at_all", "Hozircha restoranlar mavjud emas.")
        : t(emptyKey, emptyDefault);
      container.innerHTML = `<li class="sa-activity-empty">${msg}</li>`;
      return;
    }
    const rowClass = isFaol ? "sa-activity-row sa-activity-row-active" : "sa-activity-row sa-activity-row-passive";
    const badgeClass = isFaol ? "sa-activity-score-badge sa-activity-score-badge-active" : "sa-activity-score-badge sa-activity-score-badge-passive";
    arr.forEach((r, index) => {
      container.innerHTML += `
        <li class="${rowClass}" onclick="window.saOpenActivityDetail('${encodeURIComponent(r.id)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}" tabindex="0" role="button">
          <div class="sa-activity-row-left">
            <span class="sa-activity-rank">${index + 1}.</span>
            <span class="sa-activity-name">${escapeHtml(r.name)}</span>
          </div>
          <span class="${badgeClass}">${r.score} <span class="sa-activity-score-unit">${t("sa_score", "ball")}</span></span>
        </li>
      `;
    });
  };

  renderList(topActive, activeList, true, "sa_no_active_restaurants", "Faol restoranlar topilmadi.");
  renderList(topPassive, passiveList, false, "sa_no_passive_restaurants", "Passiv restoranlar topilmadi.");
};

// Faol/Passiv ro'yxatdagi bir qator bosilganda ochiladigan detail modal —
// restoran nomi, xodimlar soni, buyurtmalar soni, holati va faollik balini
// ko'rsatadi. Bir xil funksiya ikkala ro'yxat (Faol/Passiv) uchun ham
// ishlatiladi — alohida "passive detail" nusxasi yo'q.
let _saActivityDetailOpenRestId = null;

window.saOpenActivityDetail = function (encodedRestId) {
  const restId = decodeURIComponent(encodedRestId || "");
  const data = (window.allRestaurants || {})[restId];

  const modal = document.getElementById("saActivityDetailModal");
  if (!modal) return;

  _saActivityDetailOpenRestId = restId;

  // Talab #17: ma'lumot topilmasa ham UI yiqilmasin — xavfsiz standartlar.
  const name = data?.info?.name || t("sa_unknown", "Noma'lum");
  const employeesCount = data ? getRestaurantEmployeesCount(data) : 0;
  const ordersCount = data ? getRestaurantOrdersCount(data) : 0;
  const active = data ? isRestaurantActive(data) : false;
  let score = 0;
  if (data) { try { score = window.calculateActivityScore(restId, data); } catch (e) { score = 0; } }

  const nameEl = document.getElementById("saActivityDetailName");
  if (nameEl) nameEl.textContent = name;

  const employeesEl = document.getElementById("saActivityDetailEmployees");
  if (employeesEl) employeesEl.textContent = String(employeesCount);

  const ordersEl = document.getElementById("saActivityDetailOrders");
  if (ordersEl) ordersEl.textContent = String(ordersCount);

  const statusEl = document.getElementById("saActivityDetailStatus");
  if (statusEl) {
    statusEl.textContent = active ? t("status_active", "Faol") : t("status_inactive", "Faol emas");
    statusEl.className = active ? "sa-activity-detail-status sa-activity-detail-status-active" : "sa-activity-detail-status sa-activity-detail-status-inactive";
  }
  const statusIconEl = document.getElementById("saActivityDetailStatusIcon");
  if (statusIconEl) statusIconEl.textContent = active ? "🟢" : "🔴";

  const scoreEl = document.getElementById("saActivityDetailScore");
  if (scoreEl) scoreEl.textContent = String(score);

  modal.style.display = "flex";
};

window.saCloseActivityDetail = function () {
  const modal = document.getElementById("saActivityDetailModal");
  if (modal) modal.style.display = "none";
  _saActivityDetailOpenRestId = null;
};

// Modal ochiq turgan paytda til almashtirilsa (talab: "Modal ochish →
// language change → modal textlari ham o'zgaradi"): statik label'lar
// (data-i18n) global applyLang() orqali avtomatik yangilanadi, lekin
// "Faol"/"Faol emas" statusi shu funksiya ichida bir martalik t() bilan
// yozilgan — shuning uchun faqat SHU maydonni til o'zgarganda qayta
// hisoblab qo'yamiz (butun modalni yopib-ochish shart emas).
onLangChange(() => {
  if (_saActivityDetailOpenRestId && typeof window.saOpenActivityDetail === "function") {
    window.saOpenActivityDetail(encodeURIComponent(_saActivityDetailOpenRestId));
  }
});

window.saveNewRestaurant = async function () {
  const name = document.getElementById("newRestName")?.value.trim() || "";
  const domain = document.getElementById("newRestDomain")?.value.trim().toLowerCase() || "";
  let adminLogin = document.getElementById("newRestAdminLogin")?.value.trim() || "";
  const adminPass = document.getElementById("newRestAdminPass")?.value.trim() || "";

  // ROOT CAUSE FIX: #newRestDomain va #newRestAdminLogin ikkalasi ham
  // brauzerning login-menejeri tomonidan JISMONIY klaviatura bosilmasdan
  // (autofill) eski, boshqa restoranga tegishli qiymat bilan
  // almashtirilishi mumkin edi — buni oddiy "input"/"change" hodisasi
  // orqali ANIQLAB BO'LMAYDI, chunki ko'p brauzerlar autofill vaqtida ham
  // shu hodisalarni sun'iy chaqiradi (avtocomplete="off" ham buni
  // to'xtatolmaydi — Chrome/Edge buni e'tiborsiz qoldirishi mumkin).
  // "keydown" esa FAQAT jismoniy klaviatura bosilganda ishga tushadi —
  // shu farq orqali window._newRestDomainTypedByUser va
  // window._newRestLoginTypedByUser bayroqlari "haqiqiy foydalanuvchi
  // kiritishi"ni "brauzer/eski qiymat qoldi" holatidan ajratadi.
  //
  // Domen uchun avtomatik "tuzatib qo'yish" YO'Q — agar domen jismonan
  // terilmagan bo'lsa, uni nimaga "tuzatish" kerakligini bilishning iloji
  // yo'q (login kabi domendan hosil qilib bo'lmaydi), shuning uchun aniq
  // validatsiya xatosi bilan to'xtatiladi (pastda).
  //
  // Login esa domendan DETERMINISTIK tarzda hosil qilinadi — FAQAT domen
  // "haqiqiy" deb tasdiqlangandan keyin.
  if (!window._newRestDomainTypedByUser) {
    alert(t("sa_err_domain_retype", "Restoran domenini qayta kiriting. (Avtomatik to'ldirilgan/eski qiymatga ishonib bo'lmaydi — xavfsizlik uchun domenni qo'lda qayta yozing.)"));
    document.getElementById("newRestDomain")?.focus();
    return;
  }

  if (window._newRestLoginTypedByUser) {
    // Foydalanuvchi loginni qo'lda tahrirlagan — aynan shu qiymatdan
    // foydalanamiz (yuqoridagi `adminLogin` DOM'dan o'qilgan holicha qoladi).
  } else {
    adminLogin = domain + "_admin";
  }
  const businessType = "restaurant";
  const phone = document.getElementById("newRestPhone")?.value.trim() || "";
  const email = document.getElementById("newRestEmail")?.value.trim() || "";
  const address = document.getElementById("newRestAddress")?.value.trim() || "";

  const tariff = "pro";

  const licenseRadio = document.querySelector('input[name="newRestLicenseOption"]:checked');
  const licenseCode = licenseRadio?.value || null;

  if (!name || !domain || !adminLogin || !adminPass) {
    alert(t("sa_err_fill_all_fields", "Iltimos, barcha maydonlarni to'ldiring!"));
    return;
  }

  // Admin paroli — aynan 6 xonali raqam (bot orqali yaratilgan restoranlar
  // bilan bir xil talab, SuperAdminBotService.js'dagi "pass" bosqichi ham
  // shu qoidani ishlatadi — ikkalasi ham bitta manbadan kelib chiqadi:
  // routes/superadminCredentials.js'ning umumiy parol-uzunlik minimumi
  // emas, bu YANGI restoran yaratishga xos, qattiqroq shart).
  if (!/^\d{6}$/.test(adminPass)) {
    alert(t("sa_err_pass_6digit", "Admin paroli aynan 6 ta raqamdan iborat bo'lishi kerak (masalan: 123456)."));
    document.getElementById("newRestAdminPass")?.focus();
    return;
  }

  // Domen formati: faqat lotin kichik harflar, raqamlar va tire — subdomen
  // sifatida ishlatilgani uchun (`${domain}.nestacrm.uz`), boshqa belgilar
  // (masalan probel, katta harf autofill orqali kirib qolgan holat) xato.
  if (!/^[a-z0-9-]+$/.test(domain)) {
    alert(t("sa_err_domain_format", "Domen faqat lotin harflari, raqamlar va tiredan iborat bo'lishi kerak."));
    document.getElementById("newRestDomain")?.focus();
    return;
  }

  if (!licenseCode) {
    alert(t("sa_lic_dur_select_required", "Iltimos, uzaytirish turini tanlang."));
    return;
  }

  const isNameTaken = Object.values(window.allRestaurants || {}).some(
    r => (r.info?.name || "").toLowerCase() === name.toLowerCase()
  );

  if (isNameTaken) {
    alert(t("sa_err_name_taken", "Bunday nomli restoran allaqachon ro'yxatdan o'tgan!"));
    return;
  }

  // Domen uchun ham xuddi shu tekshiruv — editRestaurant() (6275-qator
  // atrofi) da bor edi, lekin yangi restoran yaratishda yo'q edi. Domen
  // takrorlansa, #newRestAdminLogin maydoni domendan avtomatik hosil
  // qilinadigani sabab (2332-qator atrofidagi "input" listener: login =
  // domain + "_admin"), ikkita har xil restoran bir xil admin login bilan
  // yaratilib qolishi mumkin edi — bu xuddi shu bug'ning ildizi.
  const isDomainTaken = Object.values(window.allRestaurants || {}).some(
    r => (r.info?.domain || "").toLowerCase() === domain.toLowerCase()
  );

  if (isDomainTaken) {
    alert(`"${domain}.nestacrm.uz" ${t("sa_domain_taken", "subdomeni allaqachon boshqa restoran tomonidan band qilingan.")}`);
    return;
  }

  // Admin login ham restoranlar bo'yicha noyob bo'lishi shart — aks holda
  // ikkita mustaqil restoran (turli restId) bir xil login bilan yozilib
  // qolishi mumkin (masalan, foydalanuvchi login maydonini qo'lda
  // domendan boshqacha qiymatga o'zgartirsa yoki brauzer avtomatik
  // to'ldirsa). Bu tekshiruv Firebase yozuvidan OLDIN, restId hali
  // yaratilmasdan turib bajariladi.
  const isAdminLoginTaken = Object.values(window.allRestaurants || {}).some(
    r => (r.users?.admin_1?.login || "").toLowerCase() === adminLogin.toLowerCase()
  );

  if (isAdminLoginTaken) {
    alert(t("sa_admin_login_taken", "Bu login allaqachon boshqa restoranda ishlatilgan. Boshqa login tanlang."));
    return;
  }

  const database = window.db || (typeof db !== 'undefined' ? db : null);
  if (!database) {
    alert(t("sa_err_db_refresh", "Ma'lumotlar bazasi bilan aloqa o'rnatib bo'lmadi. Sahifani yangilang."));
    return;
  }

  const now = Date.now();
  const isLifetime = licenseCode === "lifetime";

  let expireAt;
  if (isLifetime) {
    expireAt = 9999999999999;
  } else {
    const d = new Date(now);
    d.setMonth(d.getMonth() + Number(licenseCode));
    expireAt = d.getTime();
  }

  const plans = window.subscriptionPlans || {};
  const basePrice = Number(plans[1]?.price || 0);
  let amount = 0;
  if (isLifetime) {
    amount = basePrice * Number(plans.lifetime?.coefficient || 12);
  } else {
    const m = Number(licenseCode);
    const disc = m === 1 ? 0 : Number(plans[m]?.discount || 0);
    amount = basePrice * m * (1 - disc / 100);
  }
  amount = Math.round(amount);

  const _initialPeriodCode = isLifetime ? "lifetime" : ({ 1: "1m", 3: "3m", 6: "6m", 12: "1y" }[Number(licenseCode)] || "1m");

  window.closeAddRestaurantModal();

  try {
    const restId = "rest_" + now;
    console.log("[CRED-DEBUG] saveNewRestaurant(): generated restId =", restId,
      "| adminLogin =", adminLogin, "| adminPass captured =", adminPass ? `yes (${adminPass.length} chars)` : "NO — EMPTY!");
    const selectedPlanId = tariff.toLowerCase();
    const selectedPlanName = window.allTariffs?.[selectedPlanId]?.name || selectedPlanId.toUpperCase();
    const planFeatures = window.allTariffs?.[selectedPlanId]?.features || [];
    const initialModules = window.buildModulesFromBusinessType(businessType);

    const commonData = {
      info: {
        name: name,
        domain: domain,
        tariff: selectedPlanId,
        businessType: businessType,
        phone: phone,
        email: email,
        address: address,
        status: "active",
        createdAt: now
      },
      subscription: {
        plan: selectedPlanName,
        planId: selectedPlanId,
        status: "active",
        expireAt: expireAt,
        expireDate: expireAt,
        lastPaymentDate: now,
        lastPaymentMethod: "manual",
        activatedBy: window._auditActorName || (typeof auth !== 'undefined' ? auth?.currentUser?.email : null) || sessionStorage.getItem("name") || "SuperAdmin",
        licenseStartedAt: now,
        lastLicensePeriodCode: _initialPeriodCode,
        features: planFeatures,
        oneTimePaid: isLifetime
      },
      modules: initialModules
    };

    await Promise.all([
      set(ref(database, `restaurants/${restId}`), commonData),
      set(ref(database, `restaurants_meta/${restId}`), commonData)
    ]);

    const hashedPassword = typeof window.hashPassword === 'function'
      ? await window.hashPassword(adminPass)
      : adminPass;

    // Firebase write'dan BEVOSITA OLDIN — parolning o'zi emas, faqat
    // uzunligi (vaqtinchalik debug, xavfsiz). domainTypedByUser/
    // loginTypedByUser shu yerda TRUE bo'lishi shart (aks holda yuqoridagi
    // validatsiya funksiyani allaqachon to'xtatgan bo'lardi).
    console.log({
      restId,
      domain,
      adminLogin,
      adminPasswordLength: adminPass.length,
      domainTypedByUser: !!window._newRestDomainTypedByUser,
      loginTypedByUser: !!window._newRestLoginTypedByUser
    });

    // P0-2 residual-gap fix (PRODUCTION-AUDIT.md / P0-2-CREDENTIAL-READ-
    // DESIGN.md): password now written to credentials/${restId}/admin_1,
    // not embedded in the users/admin_1 record — see database.rules.json's
    // "credentials" tree comment for why. Written BEFORE the user record so
    // a reader never observes a user record with no credential at all.
    await set(ref(database, `credentials/${restId}/admin_1`), {
      password: hashedPassword,
    });
    await set(ref(database, `restaurants/${restId}/users/admin_1`), {
      name: t("sa_main_admin", "Asosiy Boshqaruvchi"),
      login: adminLogin,
      role: "admin",
      active: true,
      createdAt: now
    });

    // Firebase write'dan KEYIN — DARHOL SHU PATHNI QAYTA O'QIB tekshiramiz
    // (mahalliy o'zgaruvchiga emas, Firebase'ning o'ziga ishonamiz — bu
    // write muvaffaqiyatli va aynan kutilgan qiymat bilan yozilganini real
    // tasdiqlaydi). Parol xesh uzunligi/mavjudligi loglanadi, o'zi emas.
    try {
      const [verifySnap, verifyCredSnap] = await Promise.all([
        get(ref(database, `restaurants/${restId}/users/admin_1`)),
        get(ref(database, `credentials/${restId}/admin_1`)),
      ]);
      const verifyVal = verifySnap.val() || {};
      const verifyCredVal = verifyCredSnap.val() || {};
      console.log({
        path: `restaurants/${restId}/users/admin_1`,
        savedLogin: verifyVal.login,
        savedRole: verifyVal.role,
        passwordHashExists: !!verifyCredVal.password,
        passwordHashLength: verifyCredVal.password ? String(verifyCredVal.password).length : 0
      });
    } catch (verifyErr) {
      console.error("[CRED-DEBUG] post-write verification read failed:", verifyErr.message);
    }

    // ROOT CAUSE FIX: bu chaqiruv avvalroq mavjud edi, lekin credential
    // modal (alohida UI) olib tashlangan bir turda, aloqasiz bo'lsa-da,
    // bexosdan shu bilan birga o'chirilib qolgan — shu sabab HAR BIR yangi
    // restoran uchun Firebase'da `passwordEnc` HECH QACHON yozilmagan, va
    // "Restoranni Tahrirlash"dagi parol-ko'rish har doim "Parol mavjud
    // emas" ko'rsatgan (bu haqiqatan to'g'ri xabar edi — ma'lumot chindan
    // yo'q edi, lekin sabab shu yerda edi). Bu yerda FAQAT `passwordEnc`
    // (qaytarib olinadigan nusxa) saqlanadi — yuqorida allaqachon yozilgan
    // `password` (login uchun ishlatiladigan bcrypt/SHA-256 hash) bilan
    // hech qanday aloqasi yo'q, uni umuman o'zgartirmaydi (rotateHash
    // yuborilmaydi). Best-effort: muvaffaqiyatsiz bo'lsa ham restoran
    // yaratilishi to'xtamaydi — faqat keyinchalik "Restoranni Tahrirlash"da
    // parolni ko'rish ishlamaydi (superadmin buni keyin "Yangi parol
    // o'rnatish" orqali to'ldirishi mumkin, agar bu funksiya mavjud bo'lsa).
    try {
      const credToken = await _saGetIdTokenForEditCred();
      const credResp = await fetch(
        `/api/superadmin/credentials/${encodeURIComponent(restId)}/admin_1/set`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(credToken ? { Authorization: `Bearer ${credToken}` } : {}),
          },
          body: JSON.stringify({ password: adminPass }),
        }
      );
      console.log("[CRED-DEBUG] passwordEnc auto-store:", { restId, httpStatus: credResp.status, ok: credResp.ok });
    } catch (credErr) {
      console.warn("[CRED-DEBUG] passwordEnc saqlanmadi (restoran baribir yaratildi):", credErr.message);
    }

    await _saLogPayment({
      restaurantName: name,
      restaurantId: restId,
      amount: amount,
      method: t("sa_manual_method", "🆕 Yangi restoran"),
      months: isLifetime ? 0 : Number(licenseCode),
      trialDays: 0,
      oneTimeFee: 0,
      promoCode: null,
      promoDiscount: 0,
      newTariff: selectedPlanName,
    });

    window.logAudit && window.logAudit("new_restaurant", name, t("sa_log_new_restaurant_created", "Yangi restoran yaratildi"));

    alert(t("sa_success_restaurant_created", "Restoran muvaffaqiyatli yaratildi!"));
  } catch (err) {
    console.error(err);
    alert(t("sa_error_prefix", "Xatolik: ") + err.message);
  }
};

window.selectSuperPlan = function (months) {
  window.selectedSuperPlanMonths = months;
  // Sinov rejimini o'chirish
  window.currentPaymentMethod = null;

  // Barcha plan kartlarini reset
  document.querySelectorAll('.plan-card').forEach(card => {
    card.classList.remove('active');
    card.style.border = '1px solid #e5e7eb';
    card.style.background = 'white';
    card.style.opacity = '1';
    card.style.pointerEvents = 'auto';
  });

  const activeEl = document.getElementById(`plan-${months}`);
  if (activeEl) {
    activeEl.classList.add('active');
    activeEl.style.border = '2px solid #10b981';
    activeEl.style.background = '#f0fdf4';
  }

  // 1-martalik to'lovni unlock (sinov bloklagan bo'lsa)
  window._oneTimeLocked = false;
  const cardInnerOT = document.getElementById('oneTimeFeeCardInner');
  if (cardInnerOT) {
    cardInnerOT.style.opacity = '1';
    cardInnerOT.style.pointerEvents = 'auto';
    cardInnerOT.style.filter = '';
  }
  const cardWrapOT = document.getElementById('oneTimeFeeCard');
  if (cardWrapOT) cardWrapOT.style.opacity = '1';

  // Card form va payment methods reset
  const cardForm = document.getElementById("cardDetailsForm");
  if (cardForm) cardForm.style.display = "none";

  const methodsBlock = document.getElementById("superPaymentMethods");
  if (methodsBlock) {
    methodsBlock.style.setProperty("display", "grid", "important");
    methodsBlock.style.visibility = "visible";
    methodsBlock.style.opacity = "1";
  } else {
    console.error(t("sa_err_payment_methods_not_found", "Xato: 'superPaymentMethods' ID-li element topilmadi!"));
  }

  // Tugmani reset — to'lov usuli qayta tanlansin
  const payBtn = document.getElementById('modalPayBtn');
  if (payBtn) {
    payBtn.disabled = true;
    payBtn.style.opacity = "0.5";
    payBtn.style.cursor = "not-allowed";
    payBtn.innerHTML = `<i class="fa-solid fa-credit-card"></i> ${t("sa_pay_btn", "TO'LASH")}`;
  }
};

// Sinov muddatini tanlash — to'lovsiz, to'g'ridan-to'g'ri faollashtirish
window.selectTrialPlan = function () {
  // Barcha plan kartlarini reset + oylik/yillik kartlarni lock
  document.querySelectorAll('.plan-card').forEach(card => {
    card.classList.remove('active');
    card.style.border = '1px solid #e5e7eb';
    card.style.background = 'white';
    // trial bo'lmagan kartalarni grey qilish
    if (card.id !== 'plan-trial') {
      card.style.opacity = '0.35';
      card.style.pointerEvents = 'none';
    }
  });

  const trialCard = document.getElementById('plan-trial');
  if (trialCard) {
    trialCard.classList.add('active');
    trialCard.style.border = '2px solid #f59e0b';
    trialCard.style.background = '#fffbeb';
    trialCard.style.opacity = '1';
    trialCard.style.pointerEvents = 'auto';
  }

  // 1-martalik to'lov kartasini lock (sinov bilan mos kelmaydi)
  window._oneTimeLocked = true;
  const cardInnerOT = document.getElementById('oneTimeFeeCardInner');
  if (cardInnerOT) {
    cardInnerOT.style.opacity = '0.35';
    cardInnerOT.style.pointerEvents = 'none';
    cardInnerOT.style.filter = 'grayscale(1)';
  }
  const cardWrapOT = document.getElementById('oneTimeFeeCard');
  if (cardWrapOT) cardWrapOT.style.opacity = '0.45';
  // 1-martalik holatini bekor qilish
  window._oneTimeFeeSelected = false;
  const iconEl = document.getElementById('oneTimeFeeIcon');
  if (cardInnerOT) { cardInnerOT.style.border = '2px dashed #e5e7eb'; cardInnerOT.style.background = '#fafafa'; }
  if (iconEl) { iconEl.style.background = '#f3f4f6'; iconEl.style.border = '2px solid #d1d5db'; iconEl.innerHTML = '🔑'; }

  // To'lov usullari panelini va karta formini yashirish
  const methodsBlock = document.getElementById("superPaymentMethods");
  if (methodsBlock) methodsBlock.style.display = "none";

  const cardForm = document.getElementById("cardDetailsForm");
  if (cardForm) cardForm.style.display = "none";

  // To'lov tugmasini to'g'ridan-to'g'ri faollashtirish
  window.currentPaymentMethod = '__TRIAL__';
  window.selectedSuperPlanMonths = 0;

  const payBtn = document.getElementById("modalPayBtn");
  if (payBtn) {
    payBtn.disabled = false;
    payBtn.style.opacity = "1";
    payBtn.style.cursor = "pointer";
    const tDays = window.allTariffs[window.selectedTariffKey?.toLowerCase()]?.trialDays || 0;
    payBtn.innerHTML = `<i class="fa-solid fa-gift"></i> ${tDays} ${t("sa_trial_activate_btn", "kunlik sinovni boshlash")}`;
  }
};

// ============================================
// JADVALNI CHIZISH VA SARALASH (FILTR)
// ============================================
window.renderRestaurantsTable = function () {
  const tbody = document.getElementById("restaurantsTableBody");
  if (!tbody) return;

  const sourceData = window.allRestaurants || {};

  if (Object.keys(sourceData).length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:30px;">${t("sa_no_restaurants_yet", "Hozircha restoranlar yo'q")}</td></tr>`;
    return;
  }

  const searchTerm = document.getElementById("restaurantSearch")?.value.toLowerCase().trim() || "";
  const statusFilter = document.getElementById("restaurantStatusFilter")?.value || "all";
  const businessFilter = document.getElementById("restaurantBusinessFilter")?.value || "all";
  const tagFilter = document.getElementById("restaurantTagFilter")?.value || "all";

  let arr = Object.entries(sourceData).map(([id, data]) => {
    let timestampFromId = id.startsWith("rest_") ? (parseInt(id.replace("rest_", "")) || 0) : 0;
    const finalTime = (data.info && data.info.createdAt) ? data.info.createdAt : timestampFromId;
    let score = 0;
    try { score = window.calculateActivityScore(id, data); } catch (e) { }
    return { id, sortTime: finalTime, score, ...data };
  });

  // Biznes turi filter select'ini dinamik to'ldirish
  try {
    const businessFilterEl = document.getElementById("restaurantBusinessFilter");
    if (businessFilterEl) {
      const businessKeys = Array.from(new Set(arr.map(r => r.info?.businessType).filter(Boolean)));
      const existingValues = Array.from(businessFilterEl.options).map(o => o.value);
      businessKeys.forEach(key => {
        if (!existingValues.includes(key)) {
          const btData = window.BUSINESS_TYPE_MODULES && window.BUSINESS_TYPE_MODULES[key];
          const label = btData ? (typeof btData.label === "function" ? btData.label() : btData.label) : key;
          const opt = document.createElement("option");
          opt.value = key;
          opt.textContent = label;
          businessFilterEl.appendChild(opt);
        }
      });
      businessFilterEl.value = businessFilter;
    }
  } catch (e) { }

  // Teg filter select'ini dinamik to'ldirish (TAG_CONFIG: VIP/Demo/Premium)
  try {
    const tagFilterEl = document.getElementById("restaurantTagFilter");
    if (tagFilterEl && window.TAG_CONFIG) {
      const existingValues = Array.from(tagFilterEl.options).map(o => o.value);
      Object.entries(window.TAG_CONFIG).forEach(([key, cfg]) => {
        if (!existingValues.includes(key)) {
          const opt = document.createElement("option");
          opt.value = key;
          opt.textContent = `${cfg.emoji} ${cfg.label}`;
          tagFilterEl.appendChild(opt);
        }
      });
      tagFilterEl.value = tagFilter;
    }
  } catch (e) { }

  if (searchTerm) {
    arr = arr.filter(rest => {
      const name = (rest.info?.name || "").toLowerCase();
      const domain = (rest.info?.domain || "").toLowerCase();
      const owner = (rest.info?.owner || "").toLowerCase();
      const phone = (rest.info?.phone || "").toLowerCase();
      return name.includes(searchTerm) || domain.includes(searchTerm) || owner.includes(searchTerm) || phone.includes(searchTerm) || rest.id.toLowerCase().includes(searchTerm);
    });
  }

  if (statusFilter !== "all") {
    const nowTs = Date.now();
    arr = arr.filter(rest => {
      const info = rest.info || {};
      const sub = rest.subscription || {};
      const expireAt = Number(sub.expireDate || sub.expireAt || 0);
      const isActive = !(info.status === "blocked" || info.status === "paused") && (sub.oneTimePaid || expireAt > nowTs);
      return statusFilter === "active" ? isActive : !isActive;
    });
  }

  if (businessFilter !== "all") {
    arr = arr.filter(rest => (rest.info?.businessType || "") === businessFilter);
  }

  if (tagFilter !== "all") {
    arr = arr.filter(rest => {
      const rTags = rest.info?.tags || [];
      return tagFilter === "__notag__" ? rTags.length === 0 : rTags.includes(tagFilter);
    });
  }

  arr.sort((a, b) => {
    if (b.sortTime !== a.sortTime) return b.sortTime - a.sortTime; // createdAt DESC (newest first)
    // Deterministic tiebreaker: sortTime ties happen for legacy entries with
    // neither info.createdAt nor a rest_<timestamp>-style id (both fall back
    // to 0 above) — without this, order for those rows is whatever
    // Object.entries() iteration happened to produce, not an intentional
    // sort. ID DESC keeps it stable and reproducible on every render.
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  const now = Date.now();
  let htmlContent = "";

  arr.forEach(rest => {
    try {
      const info = rest.info || {};
      const sub = rest.subscription || {};
      const expireAt = Number(sub.expireDate || sub.expireAt || 0);
      const tId = (info.tariff || "start").toLowerCase();

      const currentTariffName = (window.allTariffs && window.allTariffs[tId])
        ? (window.allTariffs[tId].name || tId.toUpperCase())
        : tId.toUpperCase();

      let tariffBgColor = "#3b82f6";
      let tariffTextColor = "#ffffff";

      if (tId === "start") {
        tariffBgColor = "#f3f4f6";
        tariffTextColor = "#374151";
      } else if (tId === "pro") {
        tariffBgColor = "#10b981";
        tariffTextColor = "#ffffff";
      } else if (tId === "premium" || tId === "vip") {
        tariffBgColor = "#8b5cf6";
        tariffTextColor = "#ffffff";
      }

      let statusHtml = "";
      const gracePeriodMs = 10 * 24 * 60 * 60 * 1000;
      const isPaused = info.status === "paused";

      if (info.status === "blocked") {
        statusHtml = `<span class="badge" style="background:#FEE2E2; color:#EF4444;">${t("sa_status_blocked", "Bloklangan")}</span>`;
      } else if (isPaused) {
        statusHtml = `<span class="badge" style="background:#E5E7EB; color:#4B5563;">${t("sa_status_paused", "To'xtatilgan")}</span>`;
      } else if (sub.oneTimePaid) {
        statusHtml = `<span class="badge" style="background:#D1FAE5; color:#059669; font-weight:700;">∞ ${t("sa_status_active", "Faol")}</span>`;
      } else if (expireAt > now) {
        statusHtml = `<span class="badge" style="background:#D1FAE5; color:#059669;">${t("sa_status_active", "Faol")}</span>`;
      } else {
        const timePassed = now - expireAt;
        if (timePassed <= gracePeriodMs) {
          const daysLeft = Math.ceil((gracePeriodMs - timePassed) / (1000 * 60 * 60 * 24));
          const titleText = t("sa_days_left_title", "O'chishiga {days} kun qoldi").replace("{days}", daysLeft);
          const kunText = t("sa_days", "kun");
          statusHtml = `<span class="badge" style="background:#FEF3C7; color:#D97706;" title="${titleText}">${typeof t === 'function' ? t("sa_status_pending", "Kutmoqda") : "Kutmoqda"} (${daysLeft} ${kunText})</span>`;
        } else {
          statusHtml = `<span class="badge" style="background:#FEE2E2; color:#B91C1C; border: 1px solid #B91C1C;" title="${t("sa_data_will_be_deleted", "Ma'lumotlar o'chirilishi kerak")}">${t("sa_status_expired_clean", "Tugagan (Tozalanadi)")}</span>`;
        }
      }

      const pauseIcon = isPaused ? 'fa-play' : 'fa-pause';
      const pauseTitle = isPaused ? t("sa_action_resume", "Davom ettirish") : t("sa_action_pause", "Vaqtincha to'xtatish");
      const pauseColor = isPaused ? '#3b82f6' : '#f59e0b';

      // ── To'lov vaqti ─────────────────────────────────────────────────
      const payDateHtml = sub.lastPaymentDate
        ? new Date(sub.lastPaymentDate).toLocaleDateString('ru-RU')
        : "—";

      // ── Muddati ───────────────────────────────────────────────────────
      let expireDateHtml;
      if (sub.oneTimePaid) {
        expireDateHtml = '<span style="font-size:18px;font-weight:700;color:#10b981;" title="' + t("sa_lifetime_license", "Doimiy litsenziya") + '">∞</span>';
      } else if (sub.isTrial && expireAt) {
        expireDateHtml = '<span style="color:#d97706;font-weight:600;" title="' + t("sa_trial_tooltip_prefix", "Sinov:") + ' ' + (sub.trialDays || '') + ' ' + t("sa_days", "kun") + '">🎁 ' + new Date(expireAt).toLocaleDateString('ru-RU') + '</span>';
      } else if (expireAt) {
        const isExp = expireAt < now;
        expireDateHtml = '<span style="font-weight:600;color:' + (isExp ? '#ef4444' : '#374151') + ';">' + new Date(expireAt).toLocaleDateString('ru-RU') + '</span>';
      } else {
        expireDateHtml = "—";
      }

      // ── Qoldi ─────────────────────────────────────────────────────────
      let timeLeftHtml;
      if (sub.oneTimePaid) {
        timeLeftHtml = '<span style="display:inline-flex;align-items:center;gap:5px;background:#f0fdf4;color:#059669;font-size:12px;font-weight:700;padding:3px 9px;border-radius:20px;">∞ ' + t("sa_lifetime_short", "Cheksiz") + '</span>';
      } else if (isPaused) {
        const remMs = info.remainingMs || 0;
        const remDays = remMs > 0 ? Math.ceil(remMs / 86400000) : 0;
        timeLeftHtml = '<span style="display:inline-flex;align-items:center;gap:5px;background:#f3f4f6;color:#6b7280;font-size:12px;font-weight:600;padding:3px 9px;border-radius:20px;">⏸ ' + (remDays > 0 ? t("sa_time_days", "{days} kun").replace("{days}", remDays) : t("sa_paused_short", "To'xtatilgan")) + '</span>';
      } else if (info.status === "blocked") {
        timeLeftHtml = '<span style="display:inline-flex;align-items:center;gap:5px;background:#fee2e2;color:#b91c1c;font-size:12px;font-weight:600;padding:3px 9px;border-radius:20px;">🚫 ' + t("sa_blocked_short", "Bloklangan") + '</span>';
      } else if (!expireAt) {
        timeLeftHtml = '<span style="color:#9ca3af;">—</span>';
      } else {
        const diffMs = expireAt - now;
        const absDiff = Math.abs(diffMs);
        const tDays = Math.floor(absDiff / 86400000);
        const tHours = Math.floor(absDiff / 3600000);
        const tMins = Math.floor(absDiff / 60000);
        const tMonths = Math.floor(tDays / 30);
        const tRemDays = tDays % 30;
        let tLabel, tBg, tColor, tDot, tBorder;
        if (diffMs > 0) {
          if (tDays >= 30) { tLabel = t("sa_time_months_days", "{months} oy {days} kun").replace("{months}", tMonths).replace("{days}", tRemDays > 0 ? " " + tRemDays : "").trim(); tBg="#dcfce7"; tColor="#15803d"; tDot="#16a34a"; tBorder="none"; }
          else if (tDays >= 7) { tLabel = t("sa_time_days", "{days} kun").replace("{days}", tDays); tBg="#dcfce7"; tColor="#15803d"; tDot="#16a34a"; tBorder="none"; }
          else if (tDays >= 3) { tLabel = t("sa_time_days", "{days} kun").replace("{days}", tDays); tBg="#fef9c3"; tColor="#a16207"; tDot="#ca8a04"; tBorder="none"; }
          else if (tHours >= 1) { tLabel = t("sa_time_hours", "{hours} soat").replace("{hours}", tHours); tBg="#fee2e2"; tColor="#b91c1c"; tDot="#ef4444"; tBorder="none"; }
          else { tLabel = t("sa_time_minutes", "{mins} daqiqa").replace("{mins}", tMins); tBg="#fee2e2"; tColor="#b91c1c"; tDot="#ef4444"; tBorder="none"; }
          timeLeftHtml = '<span style="display:inline-flex;align-items:center;gap:5px;background:' + tBg + ';color:' + tColor + ';font-size:12px;font-weight:700;padding:3px 9px;border-radius:20px;white-space:nowrap;"><span style="width:6px;height:6px;border-radius:50%;background:' + tDot + ';flex-shrink:0;"></span>' + tLabel + '</span>';
        } else {
          if (tDays >= 1) tLabel = t("sa_time_expired_days", "{days} kun oldin tugagan").replace("{days}", tDays);
          else if (tHours >= 1) tLabel = t("sa_time_expired_hours", "{hours} soat oldin tugagan").replace("{hours}", tHours);
          else tLabel = t("sa_time_expired_mins", "{mins} daqiqa oldin tugagan").replace("{mins}", tMins);
          timeLeftHtml = '<span style="display:inline-flex;align-items:center;gap:5px;background:#fef2f2;color:#991b1b;font-size:12px;font-weight:700;padding:3px 9px;border-radius:20px;white-space:nowrap;border:1px solid #fecaca;">⏰ ' + tLabel + '</span>';
        }
      }

      // ── To'lov ikon, rang, tooltip ────────────────────────────────────
      const _pm = (sub.lastPaymentMethod || "").toLowerCase();
      let payIconHtml, payBtnColor, payBtnTitle;
      const _billingBase = t("sa_billing", "To'lovni uzaytirish");
      if (_pm.includes("click")) {
        payIconHtml   = '<i class="fa-solid fa-credit-card"></i>';
        payBtnColor   = "#0078D7";
        payBtnTitle   = _billingBase + " (Click)";
      } else if (_pm.includes("payme")) {
        payIconHtml   = '<i class="fa-solid fa-mobile-screen-button"></i>';
        payBtnColor   = "#00ADEF";
        payBtnTitle   = _billingBase + " (Payme)";
      } else if (_pm.includes("naqd") || _pm.includes("cash")) {
        payIconHtml   = '<i class="fa-solid fa-money-bills"></i>';
        payBtnColor   = "#16a34a";
        payBtnTitle   = _billingBase + " (" + t("sa_pm_cash", "Naqd pul") + ")";
      } else if (_pm === "trial" || _pm.includes("trial")) {
        payIconHtml   = '<i class="fa-solid fa-gift"></i>';
        payBtnColor   = "#f59e0b";
        payBtnTitle   = _billingBase + " (" + t("sa_pm_trial", "Sinov") + ")";
      } else if (_pm.includes("uzcard")) {
        payIconHtml   = '<i class="fa-solid fa-credit-card"></i>';
        payBtnColor   = "#1d4ed8";
        payBtnTitle   = _billingBase + " (UzCard)";
      } else if (_pm.includes("humo")) {
        payIconHtml   = '<i class="fa-solid fa-credit-card"></i>';
        payBtnColor   = "#ea580c";
        payBtnTitle   = _billingBase + " (Humo)";
      } else {
        payIconHtml   = '<i class="fa-solid fa-money-bill-wave"></i>';
        payBtnColor   = "#10b981";
        payBtnTitle   = _billingBase;
      }

      // ── Aktivlik balli (real) ─────────────────────────────────────────
      const actScore = rest.score || 0;
      const isActBlocked  = info.status === 'blocked';
      const isActExpired  = !sub.oneTimePaid && expireAt > 0 && expireAt < now;
      const isActLifetime = !!sub.oneTimePaid;

      // Ball darajasi
      let actBg, actColor, actIcon, actLabel;
      if (isActBlocked) {
        actBg='#fee2e2'; actColor='#dc2626'; actIcon='🚫'; actLabel=t('sa_act_blocked','Bloklangan');
      } else if (isActExpired) {
        actBg='#fef3c7'; actColor='#d97706'; actIcon='⏰'; actLabel=t('sa_act_expired',"To'lov tugagan");
      } else if (isActLifetime && actScore >= 100) {
        actBg='#d1fae5'; actColor='#059669'; actIcon='♾️'; actLabel=t('sa_act_lifetime_active','Doimiy · Faol');
      } else if (actScore >= 300) {
        actBg='#d1fae5'; actColor='#15803d'; actIcon='🔥'; actLabel=t('sa_act_very_active','Juda faol');
      } else if (actScore >= 100) {
        actBg='#dcfce7'; actColor='#16a34a'; actIcon='✅'; actLabel=t('sa_act_active','Faol');
      } else if (actScore >= 30) {
        actBg='#fef9c3'; actColor='#a16207'; actIcon='⚡'; actLabel=t('sa_act_medium',"O'rtacha");
      } else {
        actBg='#f3f4f6'; actColor='#6b7280'; actIcon='😴'; actLabel=t('sa_act_passive','Passiv');
      }

      // Balliga qarab sovg'a tavsiyasi
      const giftGiven = !!(rest.bonus?.giftAt);
      let giftHint = '';
      if (!isActBlocked && !isActExpired) {
        if (actScore >= 300)      giftHint = t('sa_gift_hint_300','🎁 30 kun bonus');
        else if (actScore >= 100) giftHint = t('sa_gift_hint_100','🎁 14 kun yoki 20%');
        else if (actScore >= 30)  giftHint = t('sa_gift_hint_30','🎁 7 kun yoki 10%');
        else                      giftHint = t('sa_gift_hint_activate','🎁 Faollashtirish');
      }
      if (giftGiven) giftHint = t('sa_gift_given', "✅ Sovg'a berilgan");

      const giftActLabelSafe = (actLabel || '').replace(/'/g, "\\'");
      const safeRestName = (info.name || '').replace(/'/g, "\\'");

      // ── Tizim ogohlantirishlari (internet uzilishi, Firebase xatosi, inventory xatosi) ──
      const restAlerts = Object.values(rest.systemAlerts || {}).filter(a => a && a.active);
      const alertBadgeHtml = restAlerts.length
        ? `<span class="badge" title="${escapeHtml(restAlerts.map(a => a.title).join(', '))}" style="background:#FEE2E2; color:#DC2626; font-weight:700; margin-left:6px; cursor:pointer;" onclick="window.saShowRestaurantAlerts && window.saShowRestaurantAlerts('${rest.id}')">🔴 ${restAlerts.length}</span>`
        : "";

      const activityTd = `
        <div style="display:flex;flex-direction:column;gap:4px;min-width:110px;">
          <span style="display:inline-flex;align-items:center;gap:4px;background:#eff6ff;color:#1d4ed8;font-size:13px;font-weight:800;padding:3px 9px;border-radius:12px;width:fit-content;">
            <i class="fa-solid fa-bolt" style="font-size:10px;"></i> ${actScore}
          </span>
          <span style="display:inline-flex;align-items:center;gap:3px;background:${actBg};color:${actColor};font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;width:fit-content;">
            ${actIcon} ${actLabel}
          </span>
        </div>`;

      const isActive = !(info.status === "blocked" || isPaused) && (sub.oneTimePaid || expireAt > now);
      const activeBadgeHtml = isActive
        ? `<span class="badge" style="background:#D1FAE5; color:#059669;">${t("sa_active_short", "Faol")}</span>`
        : `<span class="badge" style="background:#FEE2E2; color:#B91C1C;">${t("sa_inactive_short", "Nofaol")}</span>`;

      // ── Biznes turi ───────────────────────────────────────────────────
      const rowBusinessType = info.businessType || "other";
      const rowBtData = window.BUSINESS_TYPE_MODULES && window.BUSINESS_TYPE_MODULES[rowBusinessType];
      const rowBtLabel = rowBtData ? (typeof rowBtData.label === "function" ? rowBtData.label() : rowBtData.label) : rowBusinessType;
      const businessTypeHtml = rowBtLabel
        ? escapeHtml(rowBtLabel)
        : '<span style="color:#9ca3af;">—</span>';

      // ── Subdomain ────────────────────────────────────────────────────
      const subdomainHtml = info.domain
        ? `<code>${escapeHtml(info.domain)}</code>`
        : '<span style="color:#9ca3af;">—</span>';

      // ── Teglar ──────────────────────────────────────────────────────
      const tagsHtml = typeof window.renderTagsCell === "function"
        ? window.renderTagsCell(rest.id, info.tags)
        : '<span style="color:#9ca3af;">—</span>';

      // ── Litsenziya (muddat turi) ────────────────────────────────────
      const _periodLabels = { "1m": t("sa_lic_dur_opt_1m", "1 oy"), "3m": t("sa_lic_dur_opt_3m", "3 oy"), "6m": t("sa_lic_dur_opt_6m", "6 oy"), "1y": t("sa_lic_dur_opt_1y", "1 yil") };
      const _periodLabel = _periodLabels[sub.lastLicensePeriodCode] || "";
      let licenseHtml;
      if (sub.oneTimePaid) {
        licenseHtml = `<span style="color:#2563eb; font-weight:700;"><i class="fa-solid fa-infinity"></i> ${t("sa_license_lifetime", "Doimiy")}</span>`;
      } else if (expireAt > 0) {
        licenseHtml = _periodLabel
          ? `<span style="color:#374151;">${escapeHtml(_periodLabel)}</span>`
          : `<span style="color:#374151;">${escapeHtml(currentTariffName)}</span>`;
      } else {
        licenseHtml = `<span style="color:#9ca3af;">${t("sa_license_none", "Yo'q")}</span>`;
      }

      // ── Device (POS qurilma) ─────────────────────────────────────────
      const deviceCode = info.posDeviceCode || info.deviceCode || (rest.devices ? Object.keys(rest.devices)[0] : null);
      const deviceHtml = deviceCode
        ? `<code>${escapeHtml(deviceCode)}</code>`
        : '<span style="color:#9ca3af;">—</span>';

      // ── Modullar (soni) ──────────────────────────────────────────────
      const modulesMap = rest.modules || {};
      const activeModuleCount = Object.keys(modulesMap).filter(k => modulesMap[k]).length;
      const modulesHtml = activeModuleCount > 0
        ? `<span style="font-weight:700; color:#111827;">${activeModuleCount}</span>`
        : '<span style="color:#9ca3af;">—</span>';

      // ── Tugash sanasi ──────────────────────────────────────────────
      const expireCellHtml = sub.oneTimePaid
        ? `<span style="font-weight:700; color:#2563eb;" title="${t("sa_lifetime_license", "Doimiy litsenziya")}">∞</span>`
        : (expireAt > 0
          ? `<span style="color:${expireAt < now ? '#ef4444' : '#374151'};">${new Date(expireAt).toLocaleDateString('ru-RU')}</span>`
          : '<span style="color:#9ca3af;">—</span>');

      // ── Holat (rangli nuqta) ──────────────────────────────────────────
      const statusDotHtml = `
        <span style="display:inline-flex; align-items:center; gap:6px;">
          <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${isActive ? '#22c55e' : '#ef4444'};"></span>
        </span>`;

      htmlContent += `
<tr>
  <td>
    <div style="display:flex; flex-direction:column;">
      <strong>${info.name || t("sa_unknown", "Noma'lum")}</strong>${alertBadgeHtml}
      <div style="display:flex; align-items:center; gap:6px; margin-top:2px;">
        <!-- ID no longer shown as visible text in the card/list (search
             still matches it — see renderRestaurantsTable()'s search
             filter) — the copy button stays since it's an action, not
             displayed text; it doesn't render the ID anywhere on the page. -->
        <button class="btn-icon" onclick="window.copyToClipboard('${rest.id}', this)"
                style="padding: 2px 5px; font-size: 10px; cursor: pointer; background: #f3f4f6; border-radius: 4px;"
                title="${t("sa_copy_id", "IDdan nusxa olish")}">
          <i class="fa-regular fa-copy"></i>
        </button>
      </div>
    </div>
  </td>
  <td>${licenseHtml}</td>
  <td>${deviceHtml}</td>
  <td>${tagsHtml}</td>
  <td>${expireCellHtml}</td>
  <td>${statusDotHtml}</td>
  <td>
    <div style="display: flex; gap: 4px; align-items:center; flex-wrap:nowrap;">
      <button class="btn-act btn-act--view" onclick="window.rvOpenDrawer('${rest.id}')" title="${t('sa_view', "Ko'rish")}"><i class="fa-solid fa-eye"></i></button>
      <button class="btn-act btn-act--edit" onclick="window.editRestaurant('${rest.id}')" title="${t('sa_edit', 'Tahrirlash')}"><i class="fa-solid fa-pen"></i></button>
      <button class="btn-act btn-act--login" onclick="window.loginAsRestaurantAdmin('${rest.id}')" title="${t('sa_login_as', 'Restoran Adminiga kirish')}"><i class="fa-solid fa-user"></i></button>
      <button class="btn-act btn-act--license" onclick="window.openLicenseModal('${rest.id}', '${safeRestName}')" title="${t('sa_license_title', 'Litsenziya')}"><i class="fa-solid fa-key"></i></button>
      <button class="btn-act ${info.status === 'blocked' ? 'btn-act--unblock' : 'btn-act--block'}" onclick="window.toggleBlockRestaurant('${rest.id}', ${info.status === 'blocked'})" title="${info.status === 'blocked' ? t('sa_unblock', "Blokdan chiqarish") : t('sa_block', 'Bloklash')}">
        <i class="fa-solid ${info.status === 'blocked' ? 'fa-unlock' : 'fa-ban'}"></i>
      </button>
      <button class="btn-act btn-act--danger" style="color:#ef4444;" onclick="window.deleteRestaurant('${rest.id}', '${safeRestName}')" title="${t('sa_delete', "O'chirish")}"><i class="fa-solid fa-trash"></i></button>
    </div>
  </td>
</tr>`;
    } catch (err) { console.error(t("sa_err_row_render", "Qatorni chizishda xato:"), err); }
  });

  tbody.innerHTML = htmlContent;
};

// ─────────────────────────────────────────────────────────
// Restaurant View Drawer ("👁 Ko'rish") — read-only quick view
// ─────────────────────────────────────────────────────────
function _rvRow(label, value, color) {
  return `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f3f4f6;">
      <span style="font-size:12px; color:#6b7280;">${label}</span>
      <span style="font-size:13px; font-weight:600; color:${color || '#111827'}; text-align:right; max-width:60%; word-break:break-word;">${value}</span>
    </div>`;
}

window.rvOpenDrawer = function (restId) {
  const rest = window.allRestaurants && window.allRestaurants[restId];
  if (!rest) return;
  window._rvTargetId = restId;

  const info = rest.info || {};
  const sub = rest.subscription || {};
  const titleEl = document.getElementById('rvDwTitle');
  const subtitleEl = document.getElementById('rvDwSubtitle');
  if (titleEl) titleEl.textContent = info.name || t('sa_unknown', "Noma'lum");
  if (subtitleEl) subtitleEl.textContent = info.domain ? `${info.domain}.nestacrm.uz` : '';

  const tagsArr = info.tags || [];
  const tagsHtml = tagsArr.length
    ? tagsArr.map(tg => {
        const cfg = window.TAG_CONFIG && window.TAG_CONFIG[tg];
        return cfg ? `${cfg.emoji} ${escapeHtml(cfg.label)}` : escapeHtml(tg);
      }).join(', ')
    : `<span style="color:#9ca3af; font-weight:500;">${t('sa_tag_filter_none', 'Tegsiz')}</span>`;

  const rowsEl = document.getElementById('rvDwInfoRows');
  if (rowsEl) {
    rowsEl.innerHTML =
      _rvRow(t('sa_rv_field_name', "Restoran nomi"), escapeHtml(info.name || '—')) +
      _rvRow(t('sa_rv_field_phone', "Telefon"), info.phone ? escapeHtml(info.phone) : '<span style="color:#9ca3af; font-weight:500;">—</span>') +
      _rvRow(t('sa_rv_field_address', "Manzil"), info.address ? escapeHtml(info.address) : '<span style="color:#9ca3af; font-weight:500;">—</span>') +
      _rvRow(t('sa_rv_field_tags', "Teg"), tagsHtml) +
      _rvRow(t('sa_rv_field_owner', "Owner"), info.owner ? escapeHtml(info.owner) : '<span style="color:#9ca3af; font-weight:500;">—</span>');
  }

  _rvRenderLicenseTab(rest);
  _rvRenderDeviceTab(rest);
  _rvRenderModulesTab(rest);
  _rvRenderHistoryTab(restId, info.name || restId);

  window.rvSwitchTab('main');

  const drawer = document.getElementById('rvDrawer');
  if (drawer) {
    drawer.style.display = 'flex';
  }
};

// ── Tab: Litsenziya ─────────────────────────────────────────────────
function _rvRenderLicenseTab(rest) {
  const el = document.getElementById('rvDwLicenseRows');
  if (!el) return;

  const info = rest.info || {};
  const sub = rest.subscription || {};
  const now = Date.now();
  const expireAt = Number(sub.expireDate || sub.expireAt || 0);
  const tId = (info.tariff || 'start').toLowerCase();
  const tariffName = (window.allTariffs && window.allTariffs[tId])
    ? (window.allTariffs[tId].name || tId.toUpperCase())
    : tId.toUpperCase();

  let statusHtml;
  const gracePeriodMs = 10 * 24 * 60 * 60 * 1000;
  if (info.status === 'blocked') {
    statusHtml = `<span style="color:#dc2626; font-weight:700;">${t('sa_status_blocked', 'Bloklangan')}</span>`;
  } else if (info.status === 'paused') {
    statusHtml = `<span style="color:#4b5563; font-weight:700;">${t('sa_status_paused', "To'xtatilgan")}</span>`;
  } else if (sub.oneTimePaid) {
    statusHtml = `<span style="color:#059669; font-weight:700;">∞ ${t('sa_status_active', 'Faol')}</span>`;
  } else if (expireAt > now) {
    statusHtml = `<span style="color:#059669; font-weight:700;">${t('sa_status_active', 'Faol')}</span>`;
  } else if (expireAt && (now - expireAt) <= gracePeriodMs) {
    statusHtml = `<span style="color:#d97706; font-weight:700;">${t('sa_status_pending', 'Kutmoqda')}</span>`;
  } else {
    statusHtml = `<span style="color:#b91c1c; font-weight:700;">${t('sa_status_expired_clean', "Tugagan (Tozalanadi)")}</span>`;
  }

  el.innerHTML =
    _rvRow(t('sa_table_license', 'Litsenziya'), sub.oneTimePaid ? `<i class="fa-solid fa-infinity"></i> ${t('sa_license_lifetime', 'Doimiy')}` : escapeHtml(tariffName)) +
    _rvRow(t('sa_lm_col_status', 'Status'), statusHtml) +
    _rvRow(t('sa_table_expire', 'Tugash'), sub.oneTimePaid ? '∞' : (expireAt ? new Date(expireAt).toLocaleDateString('ru-RU') : '<span style="color:#9ca3af;">—</span>')) +
    _rvRow(t('sa_lm_col_lastpayment', 'Last payment'), sub.lastPaymentDate ? new Date(sub.lastPaymentDate).toLocaleDateString('ru-RU') : '<span style="color:#9ca3af;">—</span>') +
    _rvRow(t('sa_ak_field_activated_by', "Faollashtirgan"), sub.activatedBy ? escapeHtml(sub.activatedBy) : '<span style="color:#9ca3af;">—</span>');
}

window.rvOpenLicenseFromDrawer = function () {
  const restId = window._rvTargetId;
  if (!restId) return;
  const rest = window.allRestaurants && window.allRestaurants[restId];
  if (!rest) return;
  window.rvCloseDrawer();
  window.openLicenseModal(restId, rest.info?.name || restId);
};

// ── Tab: Device ──────────────────────────────────────────────────────
function _rvRenderDeviceTab(rest) {
  const el = document.getElementById('rvDwDeviceRows');
  if (!el) return;

  const info = rest.info || {};
  const devices = rest.devices || {};
  const deviceIds = Object.keys(devices);
  const primaryCode = info.posDeviceCode || info.deviceCode || (deviceIds[0] || null);

  let html = _rvRow(t('sa_rv_field_device_code', 'Device kod'), primaryCode ? `<code>${escapeHtml(primaryCode)}</code>` : '<span style="color:#9ca3af; font-weight:500;">—</span>');

  if (deviceIds.length) {
    html += `<div style="margin-top:14px; font-size:11px; font-weight:700; color:#6b7280; text-transform:uppercase; letter-spacing:.4px;">${t('sa_rv_devices_list', "Ulangan qurilmalar")}</div>`;
    deviceIds.forEach(dId => {
      const d = devices[dId] || {};
      const lastSeen = d.lastSeen || d.lastActive || d.updatedAt;
      html += `
        <div style="padding:10px 0; border-bottom:1px solid #f3f4f6;">
          <div style="font-size:13px; font-weight:600; color:#111827;">${escapeHtml(d.name || dId)}</div>
          <div style="font-size:11px; color:#9ca3af; margin-top:2px;">${lastSeen ? new Date(lastSeen).toLocaleString('ru-RU') : '—'}</div>
        </div>`;
    });
  } else {
    html += `<div style="padding:20px 0; text-align:center; color:#9ca3af; font-size:12px;">${t('sa_rv_no_devices', "Ulangan qurilmalar yo'q")}</div>`;
  }

  el.innerHTML = html;
}

// ── Tab: Modullar ────────────────────────────────────────────────────
function _rvRenderModulesTab(rest) {
  const el = document.getElementById('rvDwModulesGrid');
  if (!el) return;

  const modules = rest.modules || {};
  const activeIds = Object.keys(modules).filter(id => modules[id]);

  if (!activeIds.length) {
    el.innerHTML = `<div style="padding:20px 0; text-align:center; color:#9ca3af; font-size:12px; width:100%;">${t('sa_rv_no_modules', "Faol modul yo'q")}</div>`;
    return;
  }

  el.innerHTML = activeIds.map(id => {
    const mod = window.MODULE_CATALOG && window.MODULE_CATALOG[id];
    const label = mod && typeof mod.n === 'function' ? mod.n() : id;
    return `<span style="display:inline-block; background:#eff6ff; color:#2563eb; font-size:12px; font-weight:600; padding:5px 12px; border-radius:14px;">${escapeHtml(label)}</span>`;
  }).join('');
}

window.rvEditFromDrawer = function () {
  const restId = window._rvTargetId;
  if (!restId) return;
  window.rvCloseDrawer();
  window.editRestaurant(restId);
};

// ── Tab: Tarix ───────────────────────────────────────────────────────
function _rvRenderHistoryTab(restId, restName) {
  const el = document.getElementById('rvDwHistoryList');
  if (!el) return;

  const source = (typeof globalLicenseHistoryData !== 'undefined' && globalLicenseHistoryData) || {};
  const entries = Object.values(source)
    .filter(entry => entry && entry.restName === restName)
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, 30);

  if (!entries.length) {
    el.innerHTML = `<div style="padding:20px 0; text-align:center; color:#9ca3af; font-size:12px;">${t('sa_no_license_history', "Hozircha litsenziya tarixi yo'q")}</div>`;
    return;
  }

  // Group entries by day (dd.mm.yyyy)
  const groups = [];
  let lastDayKey = null;
  entries.forEach(entry => {
    const dateObj = entry.timestamp ? new Date(entry.timestamp) : null;
    const dayKey = dateObj
      ? dateObj.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '—';
    if (dayKey !== lastDayKey) {
      groups.push({ dayKey, items: [] });
      lastDayKey = dayKey;
    }
    groups[groups.length - 1].items.push(entry);
  });

  el.innerHTML = groups.map((group, gIdx) => {
    const rows = group.items.map(entry => {
      const dateObj = entry.timestamp ? new Date(entry.timestamp) : null;
      const timeStr = dateObj ? dateObj.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
      const meta = (typeof LICENSE_ACTION_LABELS !== 'undefined' && LICENSE_ACTION_LABELS[entry.action]) || { icon: 'fa-circle-info', color: '#64748b', bg: '#f8fafc', key: null, fallback: entry.action };
      const actionLabel = meta.key ? t(meta.key, meta.fallback) : meta.fallback;
      const detailsText = entry.details ? escapeHtml(entry.details) : '';
      return `
        <div style="display:flex; gap:10px; align-items:flex-start; padding:8px 0;">
          <div style="width:28px; height:28px; border-radius:8px; background:${meta.bg}; color:${meta.color}; display:flex; align-items:center; justify-content:center; font-size:12px; flex-shrink:0;">
            <i class="fa-solid ${meta.icon}"></i>
          </div>
          <div style="flex:1; min-width:0;">
            <div style="font-size:13px; font-weight:600; color:#111827;">${escapeHtml(actionLabel)}</div>
            ${detailsText ? `<div style="font-size:12px; color:#6b7280; margin-top:1px;">${detailsText}</div>` : ''}
            <div style="font-size:11px; color:#9ca3af; margin-top:2px;">${timeStr}${entry.actor ? ' · ' + escapeHtml(entry.actor) : ''}</div>
          </div>
        </div>`;
    }).join('');

    return `
      <div style="${gIdx > 0 ? 'margin-top:14px; padding-top:14px; border-top:1px dashed #e5e7eb;' : ''}">
        <div style="font-size:12px; font-weight:700; color:#6b7280; letter-spacing:.3px; margin-bottom:2px;">${group.dayKey}</div>
        ${rows}
      </div>`;
  }).join('');
}

window.rvCloseDrawer = function () {
  const drawer = document.getElementById('rvDrawer');
  if (drawer) drawer.style.display = 'none';
  window._rvTargetId = null;
};

window.rvSwitchTab = function (tabName) {
  document.querySelectorAll('#rvDrawer [id^="rvTab_"]').forEach(p => p.style.display = 'none');
  const panel = document.getElementById('rvTab_' + tabName);
  if (panel) panel.style.display = 'block';

  document.querySelectorAll('.rv-tab-btn').forEach(b => {
    const active = b.dataset.rvTab === tabName;
    b.style.borderBottomColor = active ? '#2563eb' : 'transparent';
    b.style.color = active ? '#2563eb' : '#6b7280';
  });
};

window.togglePauseRestaurant = async function (restId, currentStatus, currentExpireAt) {
  try {
    const database = window.db;
    const now = Date.now();
    const rest = window.allRestaurants[restId];
    if (!rest) return;

    let updates = {};

    if (currentStatus === "paused") {
      if (!confirm(t("sa_confirm_resume", "Restoran faoliyati davom ettirilsinmi?"))) return;

      const remainingMs = rest.info?.remainingMs || 0;
      const isLifetime = !!rest.subscription?.oneTimePaid;
      const newExpireAt = isLifetime ? 9999999999999 : now + remainingMs;

      updates = {
        "info/status": "active",
        "info/pausedAt": null,
        "info/remainingMs": null,
        "subscription/expireAt": newExpireAt,
        "subscription/expireDate": newExpireAt,
        "subscription/status": "active"
      };

      await Promise.all([
        update(ref(database, `restaurants/${restId}`), updates),
        update(ref(database, `restaurants_meta/${restId}`), updates)
      ]);
      window.logAudit("resume", rest.info?.name || restId, t("sa_log_resumed", "Restoran faoliyati davom ettirildi"));
      return;

    } else {
      if (!rest.subscription?.oneTimePaid && currentExpireAt < now) {
        alert(t("sa_err_cannot_pause_expired", "Muddati allaqachon tugagan restoranni to'xtatib bo'lmaydi."));
        return;
      }

      if (!confirm(t("sa_confirm_pause", "Restoran obunasi vaqtincha to'xtatilsinmi?\n(Qolgan kunlari xotirada saqlanadi)"))) return;

      const remainingMs = currentExpireAt - now;

      updates = {
        "info/status": "paused",
        "info/pausedAt": now,
        "info/remainingMs": remainingMs,
        "subscription/status": "paused"
      };

      await Promise.all([
        update(ref(database, `restaurants/${restId}`), updates),
        update(ref(database, `restaurants_meta/${restId}`), updates)
      ]);
      window.logAudit("pause", rest.info?.name || restId, t("sa_log_paused", "Restoran obunasi vaqtincha to'xtatildi"));
      return;
    }

  } catch (e) {
    console.error(t("sa_err_pause_process", "Pauza jarayonida xato:"), e);
    alert(t("sa_error_prefix", "Xatolik yuz berdi: ") + e.message);
  }
};

window.copyToClipboard = function (text, btn) {
  if (!navigator.clipboard) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand("copy");
    document.body.removeChild(textArea);
    showCopyFeedback(btn);
    return;
  }

  navigator.clipboard.writeText(text).then(() => {
    showCopyFeedback(btn);
  }).catch(err => console.error(t("sa_err_copy", "Nusxalashda xato:"), err));
};

function showCopyFeedback(btn) {
  const icon = btn.querySelector('i');
  const originalClass = icon.className;

  icon.className = 'fa-solid fa-check';
  icon.style.color = '#10b981';

  setTimeout(() => {
    icon.className = originalClass;
    icon.style.color = '';
  }, 2000);
}

// ============================================
// FAOLLIK BALI (ACTIVITY SCORE) — HISOBLASH YORDAMCHILARI
// window.updateActivityRanking() (yuqorida) va window.saOpenActivityDetail()
// (pastda) ikkalasi ham shu bitta markazlashtirilgan hisoblashdan
// foydalanadi — parallel/mustaqil formula yo'q.
// ============================================
// Har bir restoran uchun xodimlar sonini bitta joydan hisoblaydi —
// restaurants/{restId}/users (GET /api/superadmin/dashboard/restaurants
// orqali {login,createdAt} ga qisqartirilgan holda keladi, lekin bu KALIT
// SONINI o'zgartirmaydi — har xodim uchun bitta yozuv, shuning uchun
// Object.keys().length hamon haqiqiy son). O'chirilgan/bloklangan xodimlar
// mavjud loyiha konvensiyasiga ko'ra `active: false` bilan belgilanadi
// (admin.js'dagi xodimlar bo'limi — waiter/courier/chef/cashier ro'yxatlari,
// role-limit hisoblagichi va h.k. — barchasi `u.active !== false` shartidan
// foydalanadi); shu bitta, allaqachon loyihada ishlatilayotgan qoidani
// qayta ishlatamiz, yangi maydon o'ylab topmaymiz.
function getRestaurantEmployeesCount(data) {
  const users = data?.users || {};
  return Object.values(users).filter(u => u && u.active !== false).length;
}
window.getRestaurantEmployeesCount = getRestaurantEmployeesCount;

// Har bir restoran uchun buyurtmalar sonini bitta joydan hisoblaydi.
// Backend endpoint (superadminDashboard.js /restaurants) endi har bir
// restoran uchun ordersCount'ni serverda hisoblab yuboradi (restoranlar
// daraxti allaqachon Admin SDK orqali to'liq o'qilgan bo'lgani uchun bu
// qo'shimcha Firebase o'qish talab qilmaydi — 44+ restoran uchun alohida-
// alohida parallel so'rov YO'Q). data.orders odatda loyiha dizayni bo'yicha
// bu yerga umuman kelmaydi (buyurtma tafsilotlari superadmin dashboard'ga
// keraksiz) — shuning uchun asosiy manba shu backend maydoni; agar u
// mavjud bo'lmasa (masalan kelajakda boshqa chaqiruvchi to'liq `data.orders`
// bilan chaqirsa), xavfsiz fallback sifatida haqiqiy obyektni sanaydi.
function getRestaurantOrdersCount(data) {
  if (typeof data?.ordersCount === "number") return data.ordersCount;
  return Object.keys(data?.orders || {}).length;
}
window.getRestaurantOrdersCount = getRestaurantOrdersCount;

// ── Faollik bali (Activity Score) — yagona, markazlashtirilgan, deterministik
// formula. Barcha restoranlar uchun BIR XIL hisoblanadi, hardcoded ball yo'q.
//
//   employeeScore = min(employeesCount, EMPLOYEE_SCORE_CAP_COUNT) * EMPLOYEE_WEIGHT
//   orderScore    = ordersCount * ORDER_WEIGHT
//   statusScore   = isRestaurantActive(data) ? ACTIVE_BONUS : 0
//   activityScore = employeeScore + orderScore + statusScore
//
// Og'irliklar tanlovi:
//  - ORDER_WEIGHT eng katta ta'sirga ega (har buyurtma = 1 ball, yuqori
//    chegarasiz) — chunki buyurtmalar soni odatda o'nlab-yuzlab-minglab
//    bo'lishi mumkin va bu ENG ishonchli "haqiqiy faollik" ko'rsatkichi.
//  - EMPLOYEE_WEIGHT ijobiy ta'sir qiladi, lekin CHEGARALANGAN (eski
//    formuladagi "xodimlar × 5, max +50" bilan bir xil chegara/og'irlik —
//    mavjud loyiha konvensiyasiga mos), aks holda ko'p xodimli-lekin-
//    buyurtmasiz restoran haqiqatan faol restoranni ortda qoldirib
//    yuborishi mumkin edi ("passiv restoran yuqoriga chiqib ketmasin").
//  - ACTIVE_BONUS — faqat ijobiy bonus (jarima emas): faol restoran +20
//    ball oladi, nofaol/muddati tugagan restoran shu bonusni olmaydi,
//    xolos — buyurtma/xodim sonlari o'zi allaqachon haqiqiy holatni aks
//    ettiradi.
const ACTIVITY_SCORE_WEIGHTS = Object.freeze({
  EMPLOYEE_WEIGHT: 5,
  EMPLOYEE_SCORE_CAP_COUNT: 10, // 10 xodimdan ortig'i ball qo'shishda hisobga olinmaydi
  ORDER_WEIGHT: 1,
  ACTIVE_BONUS: 20,
});

window.calculateActivityScore = function (id, data) {
  const employeesCount = getRestaurantEmployeesCount(data);
  const ordersCount = getRestaurantOrdersCount(data);
  const active = isRestaurantActive(data);

  const employeeScore = Math.min(employeesCount, ACTIVITY_SCORE_WEIGHTS.EMPLOYEE_SCORE_CAP_COUNT) * ACTIVITY_SCORE_WEIGHTS.EMPLOYEE_WEIGHT;
  const orderScore = ordersCount * ACTIVITY_SCORE_WEIGHTS.ORDER_WEIGHT;
  const statusScore = active ? ACTIVITY_SCORE_WEIGHTS.ACTIVE_BONUS : 0;

  return Math.round(employeeScore + orderScore + statusScore);
};

window.t = t;

// ════════════════════════════════════════════════════════════════
// BONUS MODAL — ochish, tur tanlash, qo'llash
// ════════════════════════════════════════════════════════════════
window._bonusTargetId   = null;
window._bonusTargetName = '';
window._bonusType       = 'days';

window.openBonusModal = function (restId, restName, actScore, actLabel) {
  window._bonusTargetId   = restId;
  window._bonusTargetName = restName;
  window._bonusScore      = actScore || 0;
  window._bonusType       = 'days';

  document.getElementById('bonusRestName').textContent   = '🏪 ' + restName;
  document.getElementById('bonusRestDomain').textContent = restId;

  // Ball badge
  const scoreEl = document.getElementById('bonusScoreBadge');
  if (scoreEl) scoreEl.innerHTML = `
    <div style="font-size:22px;font-weight:800;color:#1d4ed8;">⚡ ${actScore}</div>
    <div style="font-size:11px;color:#9ca3af;margin-top:1px;">${actLabel || ''}</div>`;

  // Tavsiya satri
  const sugEl = document.getElementById('bonusSuggestion');
  if (sugEl) {
    let sugText = '', sugColor = '', sugBorder = '';
    if (actScore >= 300) {
      sugText = t('sa_suggestion_very_active', '🔥 Juda faol restoran! 30 kunlik bonus yoki bepul PRO→PREMIUM tavsiya etiladi.');
      sugColor = '#f0fdf4'; sugBorder = '#16a34a';
    } else if (actScore >= 100) {
      sugText = t('sa_suggestion_active', "✅ Faol restoran. 14 kun yoki 20% chegirma bilan rag'batlantiring.");
      sugColor = '#f0fdf4'; sugBorder = '#22c55e';
    } else if (actScore >= 30) {
      sugText = t('sa_suggestion_medium', "⚡ O'rtacha faollik. 7 kunlik bonus yoki 10% chegirma bilan qo'llab-quvvatlang.");
      sugColor = '#fefce8'; sugBorder = '#ca8a04';
    } else {
      sugText = t('sa_suggestion_passive', '😴 Passiv restoran. Faollashtirish uchun bonus kunlar yoki xabar yuboring.');
      sugColor = '#fff7ed'; sugBorder = '#f97316';
    }
    sugEl.style.display      = 'block';
    sugEl.style.background   = sugColor;
    sugEl.style.borderColor  = sugBorder;
    sugEl.style.color        = '#374151';
    sugEl.textContent        = sugText;
  }

  // Balliga mos tavsiya kun/chegirma qiymatlarini oldindan to'ldirish
  if (actScore >= 300) {
    document.getElementById('bonusDaysInput').value    = 30;
    document.getElementById('bonusDiscountInput').value = 30;
  } else if (actScore >= 100) {
    document.getElementById('bonusDaysInput').value    = 14;
    document.getElementById('bonusDiscountInput').value = 20;
  } else {
    document.getElementById('bonusDaysInput').value    = 7;
    document.getElementById('bonusDiscountInput').value = 10;
  }

  window.selectBonusType('days');
  document.getElementById('bonusNoteInput').value = '';
  document.getElementById('bonusGiftMessage') && (document.getElementById('bonusGiftMessage').value = '');
  if (typeof window.populateBonusPromoSelect === 'function') window.populateBonusPromoSelect();

  const modal = document.getElementById('bonusModal');
  modal.style.display = 'flex';
};

window.closeBonusModal = function () {
  document.getElementById('bonusModal').style.display = 'none';
  window._bonusTargetId = null;
};

window.selectBonusType = function (type) {
  window._bonusType = type;
  document.querySelectorAll('.btype-card').forEach(card => {
    const sel = card.dataset.type === type;
    card.style.borderColor = sel ? '#6366f1' : '#e5e7eb';
    card.style.background  = sel ? '#f5f3ff' : '#fff';
    const lbl = card.querySelector('div:nth-child(2)');
    if (lbl) lbl.style.color = sel ? '#4338ca' : '#374151';
  });
  ['days','discount','promo','upgrade','gift'].forEach(t2 => {
    const el = document.getElementById('bonusParam' + t2.charAt(0).toUpperCase() + t2.slice(1));
    if (el) el.style.display = t2 === type ? 'block' : 'none';
  });
};

window.applyBonus = function () {
  const restId   = window._bonusTargetId;
  const restName = window._bonusTargetName;
  const type     = window._bonusType;
  const note     = document.getElementById('bonusNoteInput')?.value.trim() || '';
  const db       = window.db;

  if (!restId) { alert(t('sa_err_no_rest_selected', 'Restoran tanlanmagan!')); return; }
  if (!db)     { alert(t('sa_err_firebase_not_connected', 'Firebase ulanmagan!'));    return; }

  const now = Date.now();
  let updateData = {};
  let confirmMsg = '';

  if (type === 'days') {
    const days = parseInt(document.getElementById('bonusDaysInput')?.value || '0');
    if (!days || days < 1) { alert(t('sa_err_enter_days', 'Kunlar sonini kiriting!')); return; }
    const rest        = (window.allRestaurants || {})[restId] || {};
    const sub         = rest.subscription || {};
    const curExpire   = Number(sub.expireAt || sub.expireDate || 0);
    const base        = curExpire > now ? curExpire : now;
    const newExpire   = base + days * 86400000;
    updateData[`restaurants/${restId}/subscription/expireAt`]   = newExpire;
    updateData[`restaurants/${restId}/subscription/expireDate`] = newExpire;
    confirmMsg = t('sa_bonus_days_success', '✅ {restName} ga +{days} kun bonus berildi!').replace('{restName}', restName).replace('{days}', days);

  } else if (type === 'discount') {
    const pct = parseInt(document.getElementById('bonusDiscountInput')?.value || '0');
    if (!pct || pct < 1 || pct > 100) { alert(t("sa_err_enter_discount", "Chegirma foizini to'g'ri kiriting!")); return; }
    updateData[`restaurants/${restId}/bonus/discountPercent`] = pct;
    updateData[`restaurants/${restId}/bonus/discountAt`]      = now;
    updateData[`restaurants/${restId}/bonus/discountNote`]    = note || `Superadmin: ${pct}% ${t('sa_task_log_discount_word', "chegirma")}`;
    confirmMsg = t('sa_bonus_discount_success', '✅ {restName} ga {pct}% chegirma kuponi saqlandi!').replace('{restName}', restName).replace('{pct}', pct);

  } else if (type === 'upgrade') {
    const newTariff = document.getElementById('bonusUpgradeTariff')?.value || 'pro';
    updateData[`restaurants/${restId}/info/tariff`]        = newTariff;
    updateData[`restaurants/${restId}/bonus/upgradedAt`]   = now;
    updateData[`restaurants/${restId}/bonus/upgradeNote`]  = note || `Superadmin: ${t('sa_bonus_log_free_word', "bepul")} ${newTariff.toUpperCase()}`;
    confirmMsg = t('sa_bonus_upgrade_success', '✅ {restName} tarifi {tariff} ga ko\'tarildi!').replace('{restName}', restName).replace('{tariff}', newTariff.toUpperCase());

  } else if (type === 'promo') {
    const promoId = document.getElementById('bonusPromoSelect')?.value || '';
    if (!promoId) { alert(t('sa_err_select_promo', 'Promo kodni tanlang!')); return; }
    const promo = (window.allPromoCodes || {})[promoId];
    if (!promo) { alert(t('sa_rest_not_found', 'Promo kod topilmadi!')); return; }
    updateData[`restaurants/${restId}/bonus/recommendedPromoId`]   = promoId;
    updateData[`restaurants/${restId}/bonus/recommendedPromoCode`] = promo.code;
    updateData[`restaurants/${restId}/bonus/recommendedPromoAt`]   = now;
    confirmMsg = t('sa_bonus_promo_success', "✅ {restName} ga {code} promo kodi tavsiya etildi! Keyingi to'lovda restoran admin bu kodni kiritishi mumkin.").replace('{restName}', restName).replace('{code}', promo.code);

  } else if (type === 'gift') {
    const msg = document.getElementById('bonusGiftMessage')?.value.trim() || '';
    if (!msg) { alert(t("sa_err_enter_message", "Xabar matnini kiriting!")); return; }
    updateData[`restaurants/${restId}/bonus/giftMessage`] = msg;
    updateData[`restaurants/${restId}/bonus/giftAt`]      = now;
    confirmMsg = t('sa_bonus_gift_success', '✅ {restName} ga maxsus xabar yuborildi!').replace('{restName}', restName);
  }

  if (note && type !== 'gift') {
    updateData[`restaurants/${restId}/bonus/lastNote`] = note;
  }
  updateData[`restaurants/${restId}/bonus/lastBonusType`] = type;
  updateData[`restaurants/${restId}/bonus/lastBonusAt`]   = now;

  const btn = document.getElementById('applyBonusBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t('sa_saving_short', 'Saqlanmoqda...')}`; }

  update(ref(db), updateData)
    .then(() => {
      let logDetails = '';
      if (type === 'days') logDetails = `+${document.getElementById('bonusDaysInput')?.value || ''} ${t('sa_bonus_log_days', "kun bonus berildi")}`;
      else if (type === 'discount') logDetails = `${document.getElementById('bonusDiscountInput')?.value || ''}${t('sa_bonus_log_discount', "% chegirma berildi")}`;
      else if (type === 'promo') logDetails = `${t('sa_bonus_log_promo', "Promo kod tavsiya etildi:")} ${document.getElementById('bonusPromoSelect')?.selectedOptions?.[0]?.textContent || ''}`;
      else if (type === 'upgrade') logDetails = `${t('sa_bonus_log_upgrade_prefix', "Tarif")} ${(document.getElementById('bonusUpgradeTariff')?.value || '').toUpperCase()} ${t('sa_bonus_log_upgrade_suffix', "ga bepul oshirildi")}`;
      else if (type === 'gift') logDetails = t('sa_bonus_log_gift', "Maxsus xabar yuborildi");
      window.logAudit("bonus", restName, logDetails);

      alert(confirmMsg);
      window.closeBonusModal();
      if (typeof window.renderRestaurantsTable === 'function') window.renderRestaurantsTable();
    })
    .catch(err => { alert(t('sa_error_prefix', 'Xatolik: ') + err.message); })
    .finally(() => {
      if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-gift"></i> ${t('sa_btn_bonus_give', 'Bonus Berish')}`; }
    });
};

// ============================================
// TEZKOR UZAYTIRISH — Expiring Subscriptions sahifasi uchun
// ============================================
window.quickExtendSubscription = function (restId, days, btn) {
  const db = window.db;
  if (!db) { alert(t('sa_err_firebase_not_connected', 'Firebase ulanmagan!')); return; }

  const rest = (window.allRestaurants || {})[restId];
  if (!rest) { alert(t('sa_rest_not_found', 'Restoran topilmadi!')); return; }

  const restName = rest.info?.name || restId;
  const confirmMsg = t('sa_extend_confirm', '{rest} ga +{days} kun qo\'shilsinmi?')
    .replace('{rest}', restName).replace('{days}', days);
  if (!confirm(confirmMsg)) return;

  const now = Date.now();
  const sub = rest.subscription || {};
  const curExpire = Number(sub.expireAt || sub.expireDate || 0);
  const base = curExpire > now ? curExpire : now;
  const newExpire = base + days * 86400000;

  const updates = {
    [`restaurants/${restId}/subscription/expireAt`]: newExpire,
    [`restaurants/${restId}/subscription/expireDate`]: newExpire,
    [`restaurants_meta/${restId}/subscription/expireAt`]: newExpire,
    [`restaurants_meta/${restId}/subscription/expireDate`]: newExpire
  };

  if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`; }

  update(ref(db), updates)
    .then(() => {
      window.logAudit && window.logAudit("extend", restName, `+${days} ${t('sa_extend_log_days', "kun uzaytirildi (tezkor)")}`);
      if (typeof window.renderExpiringSubscriptions === "function") window.renderExpiringSubscriptions();
      if (typeof window.renderRestaurantsTable === "function") window.renderRestaurantsTable();
    })
    .catch(err => {
      alert(t('sa_error_prefix', 'Xatolik: ') + err.message);
      if (btn) { btn.disabled = false; btn.innerHTML = `+${days} <span style="font-size:11px;">${t('sa_days_short', "kun")}</span>`; }
    });
};

// ============================================
// TRIAL BOSHQARUVI — "Muddati tugayotganlar" sahifasidagi Trial bo'limi uchun
// ============================================

// Trial restoranga qo'shimcha kun beradi, LEKIN bu oddiy uzaytirish hisoblanadi
// (isTrial belgisi false bo'ladi, sinov rejimi emas — mijoz qaytadan "sinov" deb ko'rmaydi
// va trialUsed=true bo'lib qoladi, ya'ni bu istisno tariqasidagi bonus kun)
window.continueTrialAsNormal = function (restId, days, btn) {
  const db = window.db;
  if (!db) { alert(t('sa_err_firebase_not_connected', 'Firebase ulanmagan!')); return; }

  const rest = (window.allRestaurants || {})[restId];
  if (!rest) { alert(t('sa_rest_not_found', 'Restoran topilmadi!')); return; }

  const restName = rest.info?.name || restId;
  const confirmMsg = t('sa_trial_continue_confirm', '{rest} ga +{days} kun beriladi (sinov sifatida emas, oddiy uzaytirish). Davom etilsinmi?')
    .replace('{rest}', restName).replace('{days}', days);
  if (!confirm(confirmMsg)) return;

  const now = Date.now();
  const sub = rest.subscription || {};
  const curExpire = Number(sub.expireAt || sub.expireDate || 0);
  const base = curExpire > now ? curExpire : now;
  const newExpire = base + days * 86400000;

  const updates = {
    [`restaurants/${restId}/subscription/expireAt`]: newExpire,
    [`restaurants/${restId}/subscription/expireDate`]: newExpire,
    [`restaurants/${restId}/subscription/isTrial`]: false,
    [`restaurants/${restId}/info/isTrial`]: false,
    [`restaurants_meta/${restId}/subscription/expireAt`]: newExpire,
    [`restaurants_meta/${restId}/subscription/expireDate`]: newExpire,
    [`restaurants_meta/${restId}/subscription/isTrial`]: false,
    [`restaurants_meta/${restId}/info/isTrial`]: false
  };

  if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`; }

  update(ref(db), updates)
    .then(() => {
      window.logAudit && window.logAudit("trial_continue", restName, `${t('sa_trial_log_continue_prefix', "Sinov")} +${days} ${t('sa_trial_log_continue_suffix', "kun (oddiy uzaytirish sifatida) davom ettirildi")}`);
      if (typeof window.renderExpiringSubscriptions === "function") window.renderExpiringSubscriptions();
      if (typeof window.renderRestaurantsTable === "function") window.renderRestaurantsTable();
    })
    .catch(err => {
      alert(t('sa_error_prefix', 'Xatolik: ') + err.message);
      if (btn) { btn.disabled = false; btn.innerHTML = `${t('sa_trial_continue_btn', 'Davom ettirish')}`; }
    });
};

// Sinov muddatini darhol bekor qiladi (muddatni hozirgi vaqtga tushiradi)
window.cancelTrialNow = function (restId, btn) {
  const db = window.db;
  if (!db) { alert(t('sa_err_firebase_not_connected', 'Firebase ulanmagan!')); return; }

  const rest = (window.allRestaurants || {})[restId];
  if (!rest) { alert(t('sa_rest_not_found', 'Restoran topilmadi!')); return; }

  const restName = rest.info?.name || restId;
  if (!confirm(t('sa_trial_cancel_confirm', '{rest} ning sinov muddati hozir bekor qilinsinmi? Restoran darhol faolsizlanadi.').replace('{rest}', restName))) return;

  const now = Date.now();
  const updates = {
    [`restaurants/${restId}/subscription/expireAt`]: now,
    [`restaurants/${restId}/subscription/expireDate`]: now,
    [`restaurants/${restId}/subscription/status`]: "expired",
    [`restaurants_meta/${restId}/subscription/expireAt`]: now,
    [`restaurants_meta/${restId}/subscription/expireDate`]: now,
    [`restaurants_meta/${restId}/subscription/status`]: "expired"
  };

  if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`; }

  update(ref(db), updates)
    .then(() => {
      window.logAudit && window.logAudit("trial_cancel", restName, t("sa_trial_log_cancelled", "Sinov muddati bekor qilindi"));
      if (typeof window.renderExpiringSubscriptions === "function") window.renderExpiringSubscriptions();
      if (typeof window.renderRestaurantsTable === "function") window.renderRestaurantsTable();
    })
    .catch(err => {
      alert(t('sa_error_prefix', 'Xatolik: ') + err.message);
      if (btn) { btn.disabled = false; btn.innerHTML = `${t('sa_trial_cancel_btn', 'Bekor qilish')}`; }
    });
};



// ESC bilan yopish
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('bonusModal')?.style.display === 'flex') {
    window.closeBonusModal();
  }
  if (e.key === 'Escape' && document.getElementById('saActivityDetailModal')?.style.display === 'flex') {
    window.saCloseActivityDetail();
  }
});

const app = await loadNestaFirebaseApp();
const db = getDatabase(app);
window.db = db;
const auth = getAuth(app);
// ROOT CAUSE FIX (credential modal "Login ma'lumoti mavjud emas" after
// visiting a restaurant page and returning): Firebase Auth defaults to
// browserLocalPersistence — a session shared across EVERY tab of this
// origin via IndexedDB, not per-tab. admin.html unconditionally calls
// signInAnonymously(auth) on load (including every "Login As" open, which
// happens in a NEW TAB) — with shared persistence, that anonymous sign-in
// silently overwrites the superadmin's OWN tab's session too, so
// auth.currentUser there stops being the real superadmin. Nothing broke
// visibly before this mattered (every other superadmin write went through
// the client SDK directly, gated only by RTDB rules that don't
// distinguish anonymous from a real superadmin session) — the credential
// endpoints (backend/routes/superadminCredentials.js) are the first
// feature that actually verifies the ID token's identity, which is what
// exposed this. Scoping THIS tab's session to itself (survives refresh,
// does not sync to/from other tabs) fixes it without touching admin.js's
// signInAnonymously() call, login.js, or any other flow.
setPersistence(auth, browserSessionPersistence).catch((e) =>
  console.error("[auth] setPersistence failed:", e.message)
);

// ─────────────────────────────────────────────────────────
// Secondary Firebase app instance — used ONLY to create new
// platform-user Auth accounts (createUserWithEmailAndPassword)
// without signing the current SuperAdmin session out. Firebase's
// client SDK swaps the active session to whatever user was last
// created/signed-in on a given Auth instance, so a second,
// isolated app+auth pair keeps that side effect off the main
// session. We sign this instance out again immediately after use.
// ─────────────────────────────────────────────────────────
const _puSecondaryApp = await loadNestaNamedFirebaseApp("puSecondary");
const _puSecondaryAuth = getAuth(_puSecondaryApp);

// ============================================
// AUDIT LOG — barcha SuperAdmin amallarini yozish
// ============================================
window._auditActorName = null;

// IP manzilni bir marta olib, keshda saqlaymiz (har bir logAudit chaqiruvida qayta so'ramaslik uchun)
window._cachedClientIp = window._cachedClientIp || null;
window._fetchClientIp = async function () {
  if (window._cachedClientIp) return window._cachedClientIp;
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const data = await res.json();
    window._cachedClientIp = data?.ip || null;
  } catch (err) {
    window._cachedClientIp = null;
  }
  return window._cachedClientIp;
};

// User-agent (va imkon bo'lsa Client Hints) asosida OS nomi + versiyasini aniqlaydi
async function _detectClientOS(ua) {
  // Chromium brauzerlarida Windows 10 / 11 ni aniq ajratish uchun Client Hints
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      const uaData = await navigator.userAgentData.getHighEntropyValues(["platformVersion"]);
      if (navigator.userAgentData.platform === "Windows" && uaData?.platformVersion) {
        const major = parseInt(uaData.platformVersion.split(".")[0], 10);
        if (major >= 13) return "Windows 11";
        if (major > 0) return "Windows 10";
      }
    }
  } catch (err) { /* Client Hints mavjud emas — UA orqali fallback */ }

  if (/windows nt 10\.0/i.test(ua)) return "Windows 10";
  if (/windows nt 6\.3/i.test(ua)) return "Windows 8.1";
  if (/windows nt 6\.2/i.test(ua)) return "Windows 8";
  if (/windows nt 6\.1/i.test(ua)) return "Windows 7";
  if (/windows/i.test(ua)) return "Windows";

  let m = ua.match(/mac os x (\d+[_.]\d+(?:[_.]\d+)?)/i);
  if (m) return "macOS " + m[1].replace(/_/g, ".");
  if (/mac os/i.test(ua)) return "macOS";

  m = ua.match(/android (\d+(?:\.\d+)?)/i);
  if (m) return "Android " + m[1];

  m = ua.match(/(?:iphone|ipad).*os (\d+[_.]\d+)/i);
  if (m) return "iOS " + m[1].replace(/_/g, ".");

  if (/linux/i.test(ua)) return "Linux";
  return t("sa_unknown_os", "Noma'lum OS");
}

// User-agent asosida brauzer nomi + versiyasini aniqlaydi
function _detectClientBrowser(ua) {
  let m = ua.match(/edg\/(\d+)/i);
  if (m) return "Edge " + m[1];

  if (!/edg\//i.test(ua)) {
    m = ua.match(/chrome\/(\d+)/i);
    if (m) return "Chrome " + m[1];
  }

  m = ua.match(/firefox\/(\d+)/i);
  if (m) return "Firefox " + m[1];

  if (!/chrome/i.test(ua)) {
    m = ua.match(/version\/(\d+).*safari/i);
    if (m) return "Safari " + m[1];
  }

  return t("sa_unknown_browser", "Noma'lum brauzer");
}

// User-agent asosida qurilma/brauzer tavsifi ("Windows 11 · Chrome 138")
window._getClientDeviceInfo = async function () {
  try {
    const ua = navigator.userAgent || "";
    const os = await _detectClientOS(ua);
    const browser = _detectClientBrowser(ua);
    return `${os} · ${browser}`;
  } catch (err) {
    return t("sa_unknown_device", "Noma'lum qurilma");
  }
};

// P0-2 systemData-regression fix: systemData/auditLogs is no longer
// client-writable at all (see database.rules.json) — this single shared
// function is the ONLY place that used to push() there directly (62 call
// sites elsewhere in this file call window.logAudit(), none of which
// needed to change). `actor`/`ip` are still collected client-side exactly
// as before and sent along, but the backend (requireSuperAdmin-gated —
// see backend/routes/superadminDashboard.js) prefers the verified token's
// own email for `actor` and its own view of the request IP, so a forged
// client `actor`/`ip` can't poison the audit trail even if this endpoint
// were somehow called by something other than this function.
window.logAudit = async function (action, restName, details) {
  try {
    // ip is no longer sent from here — the backend uses its own view of
    // req.ip (more trustworthy than a client-reported value anyway), so
    // the ipify.org round-trip this used to do is no longer needed.
    const device = await window._getClientDeviceInfo();

    await _saDashFetch('/audit-log', {
      method: 'POST',
      body: JSON.stringify({
        action: action,
        restName: restName || null,
        details: details || null,
        device: device || null,
      }),
    });
  } catch (err) {
    console.error(t ? t("sa_err_audit_log", "Audit logni yozishda xato:") : "Audit logni yozishda xato:", err);
  }
};

onAuthStateChanged(auth, (user) => {
  if (user) window._auditActorName = user.email || user.displayName || "SuperAdmin";
});

// ============================================
// FAOLIYAT JURNALI (AUDIT LOG) — jadval, filtrlar, eksport
// ============================================
window.globalAuditLogData = null;

// P0-2 systemData-regression fix: same poll-based replacement as
// listenPaymentHistory() above (systemData/auditLogs is no longer
// client-readable directly) — _populateAuditFilterDropdowns/
// renderAuditTable are unchanged, same data shape.
function listenAuditLog() {
  _saStartDashPoll('/audit-log', (data) => {
    window.globalAuditLogData = data && Object.keys(data).length ? data : null;
    _populateAuditFilterDropdowns();
    if (typeof window.renderAuditTable === "function") window.renderAuditTable();
  });
}
window.listenAuditLog = listenAuditLog;

function _auditActionMeta(action) {
  const map = {
    block:            { fallback: "🔴 Bloklash",                    color: "#dc2626", bg: "#fef2f2" },
    unblock:          { fallback: "🟢 Blokdan chiqarish",            color: "#059669", bg: "#f0fdf4" },
    pause:            { fallback: "⏸️ To'xtatish",                   color: "#d97706", bg: "#fff7ed" },
    resume:           { fallback: "▶️ Davom ettirish",               color: "#059669", bg: "#f0fdf4" },
    extend:           { fallback: "🟢 Litsenziya uzaytirildi",       color: "#2563eb", bg: "#eff6ff" },
    tariff_change:    { fallback: "💳 Tarif o'zgarishi",             color: "#2563eb", bg: "#eff6ff" },
    bonus:            { fallback: "🟠 Promo kod yaratildi",          color: "#7c3aed", bg: "#f5f3ff" },
    domain_change:    { fallback: "🌐 Domen o'zgarishi",             color: "#0891b2", bg: "#ecfeff" },
    edit:             { fallback: "🔵 Teg yangilandi",               color: "#64748b", bg: "#f8fafc" },
    delete:           { fallback: "🗑️ O'chirish",                    color: "#dc2626", bg: "#fef2f2" },
    delete_all:       { fallback: "⚠️ Hammasini o'chirish",          color: "#dc2626", bg: "#fef2f2" },
    login_as:         { fallback: "🟣 Login As",                     color: "#9333ea", bg: "#faf5ff" },
    new_restaurant:   { fallback: "🟢 Litsenziya yaratildi",         color: "#16a34a", bg: "#f0fdf4" },
    settings_change:  { fallback: "⚙️ Sozlamalar",                   color: "#475569", bg: "#f1f5f9" },
    trial_continue:   { fallback: "🎁 Trial davom ettirildi",        color: "#059669", bg: "#f0fdf4" },
    trial_cancel:     { fallback: "🚫 Trial bekor qilindi",          color: "#dc2626", bg: "#fef2f2" },
    device_block:     { fallback: "🔴 Device bloklandi",             color: "#dc2626", bg: "#fef2f2" },
    device_unblock:   { fallback: "🟢 Device yoqildi",               color: "#059669", bg: "#f0fdf4" },
    promo_toggle:     { fallback: "🟠 Promo kod holati o'zgardi",    color: "#d97706", bg: "#fff7ed" },
    tag_update:       { fallback: "🔵 Teg yangilandi",               color: "#2563eb", bg: "#eff6ff" },
    integration_update:      { fallback: "Integratsiya yangilandi",        color: "#0891b2", bg: "#ecfeff" },
    session_terminate:       { fallback: "Sessiyani tugatish",             color: "#dc2626", bg: "#fef2f2" },
    session_terminate_all:   { fallback: "Barcha sessiyalarni tugatish",   color: "#dc2626", bg: "#fef2f2" },
    broadcast:               { fallback: "Ommaviy xabar",                  color: "#2563eb", bg: "#eff6ff" },
    credential_rotate:       { fallback: "Parolni yangilash",              color: "#d97706", bg: "#fff7ed" },
    platform_user_update:    { fallback: "Platform xodimi yangilandi",     color: "#2563eb", bg: "#eff6ff" },
    platform_user_status:    { fallback: "Platform xodimi holati",         color: "#d97706", bg: "#fff7ed" },
    license_extend:          { fallback: "Litsenziya uzaytirildi",         color: "#2563eb", bg: "#eff6ff" },
    backup_settings:         { fallback: "Zaxira sozlamalari",             color: "#475569", bg: "#f1f5f9" },
    platform_user_create:    { fallback: "Platform xodimi qo'shildi",      color: "#16a34a", bg: "#f0fdf4" },
    backup_create:           { fallback: "Zaxira yaratildi",               color: "#16a34a", bg: "#f0fdf4" },
    apikey_create:           { fallback: "API kalit yaratildi",            color: "#16a34a", bg: "#f0fdf4" },
    apikey_update:           { fallback: "API kalit yangilandi",           color: "#2563eb", bg: "#eff6ff" },
    apikey_regenerate:       { fallback: "API kalit qayta yaratildi",      color: "#d97706", bg: "#fff7ed" },
    error_status:            { fallback: "Xato holati",                   color: "#d97706", bg: "#fff7ed" },
    task_execute:            { fallback: "Vazifa bajarildi",              color: "#059669", bg: "#f0fdf4" },
    task_create:             { fallback: "Vazifa yaratildi",              color: "#16a34a", bg: "#f0fdf4" },
    error_clear:             { fallback: "Xatolar tozalandi",             color: "#475569", bg: "#f1f5f9" },
    modules_update:          { fallback: "Modullar yangilandi",           color: "#2563eb", bg: "#eff6ff" },
    device_enable:           { fallback: "Qurilma yoqildi",               color: "#059669", bg: "#f0fdf4" },
    device_disable:          { fallback: "Qurilma bloklandi",             color: "#dc2626", bg: "#fef2f2" },
    franchise_status:        { fallback: "Franchayz holati",              color: "#d97706", bg: "#fff7ed" },
    franchise_royalty:       { fallback: "Franchayz royalti",             color: "#7c3aed", bg: "#f5f3ff" },
    franchise_create:        { fallback: "Franchayz yaratildi",           color: "#16a34a", bg: "#f0fdf4" },
    task_delete:             { fallback: "Vazifa o'chirildi",             color: "#dc2626", bg: "#fef2f2" },
    promo_used:              { fallback: "Promo kod ishlatildi",          color: "#7c3aed", bg: "#f5f3ff" },
    promo_create:            { fallback: "Promo kod yaratildi",           color: "#16a34a", bg: "#f0fdf4" }
  };
  return map[action] || { fallback: action || "—", color: "#475569", bg: "#f1f5f9" };
}

function _getAuditDateRange() {
  const startVal = document.getElementById("auditDateStart")?.value || "";
  const endVal = document.getElementById("auditDateEnd")?.value || "";
  const start = startVal ? new Date(startVal + "T00:00:00").getTime() : null;
  const end = endVal ? new Date(endVal + "T23:59:59").getTime() : null;
  return { start, end };
}

function _populateAuditFilterDropdowns() {
  const restSelect = document.getElementById("auditFilterRestaurant");
  const actorSelect = document.getElementById("auditFilterActor");
  if (!window.globalAuditLogData || (!restSelect && !actorSelect)) return;

  const entries = Object.values(window.globalAuditLogData);
  const restNames = new Set();
  const actorNames = new Set();
  entries.forEach(e => {
    if (e.restName) restNames.add(e.restName);
    if (e.actor) actorNames.add(e.actor);
  });

  if (restSelect) {
    const currentVal = restSelect.value || "all";
    const allLabel = t("sa_audit_filter_all_rest", "Barcha restoranlar");
    restSelect.innerHTML = `<option value="all">${allLabel}</option>` +
      [...restNames].sort().map(name => `<option value="${name}">${name}</option>`).join("");
    if ([...restSelect.options].some(o => o.value === currentVal)) restSelect.value = currentVal;
  }

  if (actorSelect) {
    const currentVal = actorSelect.value || "all";
    const allLabel = t("sa_audit_filter_all_actor", "Barcha foydalanuvchilar");
    actorSelect.innerHTML = `<option value="all">${allLabel}</option>` +
      [...actorNames].sort().map(name => `<option value="${name}">${name}</option>`).join("");
    if ([...actorSelect.options].some(o => o.value === currentVal)) actorSelect.value = currentVal;
  }
}

function _getFilteredAuditEntries() {
  if (!window.globalAuditLogData) return [];

  const searchVal = (document.getElementById("auditSearchInput")?.value || "").trim().toLowerCase();
  const restFilter = document.getElementById("auditFilterRestaurant")?.value || "all";
  const actorFilter = document.getElementById("auditFilterActor")?.value || "all";
  const actionFilter = document.getElementById("auditFilterAction")?.value || "all";
  const { start, end } = _getAuditDateRange();

  return Object.entries(window.globalAuditLogData)
    .map(([id, data]) => ({ id, ...data }))
    .filter(e => {
      const ts = Number(e.timestamp || 0);
      if (start && ts < start) return false;
      if (end && ts > end) return false;
      return true;
    })
    .filter(e => !searchVal || (e.restName || "").toLowerCase().includes(searchVal))
    .filter(e => restFilter === "all" || e.restName === restFilter)
    .filter(e => actorFilter === "all" || e.actor === actorFilter)
    .filter(e => actionFilter === "all" || e.action === actionFilter)
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

window.renderAuditTable = function () {
  const tbody = document.getElementById("auditLogTableBody");
  if (!tbody) return;

  if (!window.globalAuditLogData) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:40px; color:#94a3b8;">
      <i class="fa-solid fa-spinner fa-spin"></i>
      <span data-i18n="sa_audit_loading"> Yuklanmoqda...</span>
    </td></tr>`;
    return;
  }

  const rows = _getFilteredAuditEntries();
  window._auditRowsById = {};
  rows.forEach(r => { window._auditRowsById[r.id] = r; });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:40px; color:#94a3b8;">
      <i class="fa-solid fa-inbox"></i>
      <span data-i18n="sa_audit_empty"> Hech qanday yozuv topilmadi</span>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((row, idx) => {
    const meta = _auditActionMeta(row.action);
    const dateStr = row.timestamp ? new Date(row.timestamp).toLocaleString("ru-RU") : "—";
    return `<tr>
      <td>${idx + 1}</td>
      <td>${dateStr}</td>
      <td>${row.actor || "—"}</td>
      <td><span style="display:inline-block; padding:2px 8px; border-radius:6px; font-size:12px; font-weight:600; color:${meta.color}; background:${meta.bg};">${t("sa_audit_action_" + row.action, meta.fallback)}</span></td>
      <td>${row.restName || "—"}</td>
      <td>${row.details || "—"}</td>
      <td style="text-align:center;">
        <button onclick="window.openAuditDetailModal('${row.id}')"
          style="padding:5px 10px; background:#f0fdf4; border:1px solid #bbf7d0; color:#16a34a; border-radius:8px; cursor:pointer; font-size:12px; font-weight:600; white-space:nowrap;">
          👁 <span data-i18n="sa_audit_detail_btn">Batafsil</span>
        </button>
      </td>
    </tr>`;
  }).join("");
};

// ---- Batafsil (detail) modal ----
window.openAuditDetailModal = function (id) {
  const row = (window._auditRowsById || {})[id];
  const modal = document.getElementById("auditDetailModal");
  const body = document.getElementById("auditDetailBody");
  if (!row || !modal || !body) return;
  window._openAuditDetailId = id;

  const meta = _auditActionMeta(row.action);
  const dateStr = row.timestamp ? new Date(row.timestamp).toLocaleString("ru-RU") : "—";
  const ip = row.ip || t("sa_audit_detail_unknown", "Noma'lum");
  const unknownLabel = t("sa_audit_detail_unknown", "Noma'lum");

  // Device qatori "OS · Browser" ko'rinishida saqlanadi — modalda ikki alohida qatorga bo'lamiz
  let osLine = unknownLabel;
  let browserLine = "";
  if (row.device) {
    const parts = String(row.device).split("·").map(p => p.trim()).filter(Boolean);
    osLine = parts[0] || unknownLabel;
    browserLine = parts[1] || "";
  }

  body.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:14px; font-size:14px; color:#111827;">
      <div>
        <div style="color:#94a3b8; font-size:12px; font-weight:600; text-transform:uppercase; margin-bottom:3px;" data-i18n="sa_audit_col_action">Amal</div>
        <div style="font-weight:700;">${t("sa_audit_action_" + row.action, meta.fallback)}</div>
      </div>
      <div>
        <div style="color:#94a3b8; font-size:12px; font-weight:600; text-transform:uppercase; margin-bottom:3px;" data-i18n="sa_audit_col_actor">Kim</div>
        <div style="font-weight:700;">${row.actor || "—"}</div>
      </div>
      <div>
        <div style="color:#94a3b8; font-size:12px; font-weight:600; text-transform:uppercase; margin-bottom:3px;" data-i18n="sa_audit_col_ip">IP</div>
        <div style="font-family:monospace;">${ip}</div>
      </div>
      <div>
        <div style="color:#94a3b8; font-size:12px; font-weight:600; text-transform:uppercase; margin-bottom:3px;" data-i18n="sa_audit_col_device">Device</div>
        <div>${osLine}</div>
        ${browserLine ? `<div>${browserLine}</div>` : ""}
      </div>
      <div>
        <div style="color:#94a3b8; font-size:12px; font-weight:600; text-transform:uppercase; margin-bottom:3px;" data-i18n="sa_audit_col_date_full">Vaqt</div>
        <div>${dateStr}</div>
      </div>
    </div>`;

  modal.style.display = "flex";
};

window.closeAuditDetailModal = function () {
  const modal = document.getElementById("auditDetailModal");
  if (modal) modal.style.display = "none";
  window._openAuditDetailId = null;
};

// ---- Excel eksport ----
window.exportAuditLogToExcel = function () {
  if (typeof XLSX === "undefined") {
    alert(t("sa_xlsx_lib_error", "Excel kutubxonasi yuklanmagan. Internet aloqasini tekshiring."));
    return;
  }

  const rows = _getFilteredAuditEntries();
  if (!rows.length) {
    alert(t("sa_audit_no_data_export", "Eksport uchun ma'lumot topilmadi"));
    return;
  }

  const header = [
    t("sa_audit_col_date", "Sana"),
    t("sa_audit_col_actor", "Kim"),
    t("sa_audit_col_action", "Amal"),
    t("sa_audit_col_rest", "Obyekt"),
    t("sa_audit_col_details", "Tafsilot"),
    t("sa_audit_col_ip", "IP"),
    t("sa_audit_col_device", "Qurilma")
  ];

  const aoa = [header, ...rows.map(row => {
    const meta = _auditActionMeta(row.action);
    return [
      row.timestamp ? new Date(row.timestamp).toLocaleString("ru-RU") : "—",
      row.actor || "—",
      t("sa_audit_action_" + row.action, meta.fallback),
      row.restName || "—",
      row.details || "—",
      row.ip || "—",
      row.device || "—"
    ];
  })];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 20 }, { wch: 20 }, { wch: 22 }, { wch: 22 }, { wch: 40 }, { wch: 16 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, t("sa_audit_excel_sheet", "Faoliyat jurnali"));
  const fileName = `faoliyat_jurnali_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fileName);
};

// ---- PDF eksport ----
window.exportAuditLogToPDF = async function () {
  const rows = _getFilteredAuditEntries();
  if (!rows.length) {
    alert(t("sa_audit_no_data_export", "Eksport uchun ma'lumot topilmadi"));
    return;
  }

  if (typeof window.jspdf === "undefined" && typeof window.jsPDF === "undefined") {
    alert(t("sa_pdf_lib_error", "PDF kutubxonasi yuklanmagan. Internet aloqasini tekshiring."));
    return;
  }

  const JsPDFCtor = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : window.jsPDF;
  const doc = new JsPDFCtor({ orientation: "landscape", unit: "pt", format: "a4" });

  doc.setFontSize(14);
  doc.text(t("sa_audit_title_plain", "Faoliyat jurnali"), 40, 40);

  const head = [[
    t("sa_audit_col_date", "Sana"),
    t("sa_audit_col_actor", "Kim"),
    t("sa_audit_col_action", "Amal"),
    t("sa_audit_col_rest", "Obyekt"),
    t("sa_audit_col_details", "Tafsilot"),
    t("sa_audit_col_ip", "IP"),
    t("sa_audit_col_device", "Qurilma")
  ]];

  const body = rows.map(row => {
    const meta = _auditActionMeta(row.action);
    return [
      row.timestamp ? new Date(row.timestamp).toLocaleString("ru-RU") : "—",
      row.actor || "—",
      t("sa_audit_action_" + row.action, meta.fallback),
      row.restName || "—",
      row.details || "—",
      row.ip || "—",
      row.device || "—"
    ];
  });

  if (typeof doc.autoTable === "function") {
    doc.autoTable({ head, body, startY: 55, styles: { fontSize: 8 }, headStyles: { fillColor: [46, 188, 88] } });
  } else {
    // autoTable plugin mavjud bo'lmasa — sodda matn ko'rinishida
    let y = 60;
    body.forEach(r => {
      doc.setFontSize(8);
      doc.text(r.join("  |  "), 40, y);
      y += 14;
      if (y > 560) { doc.addPage(); y = 40; }
    });
  }

  doc.save(`faoliyat_jurnali_${new Date().toISOString().slice(0, 10)}.pdf`);
};

window.allRestaurants = {};
window.allTariffs = {};
window.allPromoCodes = {};
window.subscriptionPlans = {
  1: { price: 350000, active: true },
  3: { discount: 5, active: true },
  6: { discount: 11, active: true },
  12: { discount: 16, active: true },
  lifetime: { coefficient: 12, active: false }
};
window.targetRestIdForBilling = null;
window.selectedSuperPlanMonths = 0;
window.currentPaymentMethod = null;
window.isCreatingNewRestaurant = false;
window.pendingNewRestaurantData = null;
window.paymentInterval = null;
window.listenRestaurants = listenRestaurants;
window.listenPaymentHistory = listenPaymentHistory;
window.listenDiscountSettings = listenDiscountSettings;
window.listenPromoCodes = listenPromoCodes;
let globalPaymentsData = null;

// ============================================
// 1. INIT VA MARKAZIY LISTENERLAR
// ============================================
document.addEventListener("DOMContentLoaded", () => {
  let _scAuthLoggedOnce = false;
  // `onAuthStateChanged` re-fires on more than just the initial page load —
  // ID token refresh (~hourly), tab visibility changes, etc. all re-trigger
  // it with the same signed-in user. Without this guard, every re-fire used
  // to re-run listenRestaurants()/listenPaymentHistory()/etc., each of which
  // calls onValue() again on the SAME Firebase path without ever detaching
  // the previous subscription — stacking duplicate listeners forever (a
  // real memory leak, and every future snapshot re-running
  // renderRestaurantsTable()/updateDashboardStats()/etc. once per stacked
  // listener, causing growing lag/flicker the longer the tab stays open).
  // The realtime *listeners* only need to be attached once per page load;
  // the auth check itself still runs on every re-fire (e.g. to redirect on
  // sign-out).
  let _scListenersStarted = false;
  onAuthStateChanged(auth, async (user) => {
    // 403-storm fix: `user` only means "some Firebase session exists in
    // this browser" — it says nothing about WHICH one. login.js's
    // staff/employee sign-in never calls setPersistence(), so it uses
    // Firebase's default browserLocalPersistence, shared across every tab
    // of this origin. This tab's own setPersistence(auth,
    // browserSessionPersistence) call above only governs future writes —
    // it does not un-restore whatever session was already loaded into
    // auth.currentUser when this tab's own Auth SDK initialized. A staff
    // login (or an anonymous admin.html session) already sitting in this
    // browser's storage can be silently inherited here, pass the old
    // `!user` check since a user DOES exist, and then get 403'd by
    // requireSuperAdmin on every single API call — confirmed live: the
    // backend was correctly rejecting a real but wrong-shaped session; the
    // actual gap was this page treating "any session" as "a superadmin
    // session". Verify the same claim shape requireSuperAdmin checks
    // server-side (no restId claim, not an anonymous provider) before ever
    // proceeding to load a dashboard that can never successfully call its
    // own APIs.
    let claimsOk = null; // null = no user to check
    if (user) {
      try {
        const tokenResult = await user.getIdTokenResult(true);
        claimsOk = !tokenResult.claims.restId && tokenResult.signInProvider !== "anonymous";
      } catch (e) {
        console.error("[SA-AUTH] token claim tekshiruvida xato:", e.message);
        claimsOk = false;
      }
    }

    if (claimsOk === false) {
      // A real session exists but isn't superadmin-shaped — sign it out so
      // it can't keep silently winning over a real superadmin login next
      // time, and send to login exactly like "no session at all".
      try { await signOut(auth); } catch (e) { /* noop */ }
      window.location.href = "login.html";
      return;
    }

    if (!user && sessionStorage.getItem("role") !== "superadmin") {
      window.location.href = "login.html";
    } else {
      initNavigation();
      if (!_scListenersStarted) {
        _scListenersStarted = true;
        if (typeof window.listenRestaurants === "function") window.listenRestaurants();
        if (typeof window.listenSystemSettings === "function") window.listenSystemSettings();
        if (typeof window.loadPaymentApiSettings === "function") window.loadPaymentApiSettings();
        if (typeof window.listenPaymentHistory === "function") window.listenPaymentHistory();
        // Revenue-filter 401 fix: this used to auto-run from a standalone
        // setTimeout(..., 1000) at module scope (see the removed call near
        // loadGlobalPayments() below), racing raw wall-clock time against
        // Firebase's async onAuthStateChanged resolution instead of waiting
        // for it. When auth resolved slower than 1s (cold start), _saApiFetch
        // found auth.currentUser still null, sent the request with no
        // Authorization header at all, and the backend correctly 401'd it —
        // same failure shape as the earlier System Health 401. Moved into
        // this already-auth-resolved gate, same pattern as every other
        // listener here, so it never runs before a token is available.
        if (typeof window.updateRevenueByFilter === "function") window.updateRevenueByFilter();
        if (typeof window.listenDiscountSettings === "function") window.listenDiscountSettings();
        if (typeof window.listenPromoCodes === "function") window.listenPromoCodes();
        if (typeof window.listenBroadcastHistory === "function") window.listenBroadcastHistory();
        if (typeof window.listenAuditLog === "function") window.listenAuditLog();
        if (typeof window.listenReceiptPhone === "function") window.listenReceiptPhone();
        if (typeof window._shAutoStartIfNeeded === "function") window._shAutoStartIfNeeded();
      }

      // Security Center: log this login once per page load (not on every
      // auth state re-check) and start the active-session heartbeat.
      if (!_scAuthLoggedOnce) {
        _scAuthLoggedOnce = true;
        if (typeof window.scLogLogin === "function") window.scLogLogin('success', user);
      }
    }
  });

  const langSelect = document.getElementById("langSelect");
  if (langSelect) {
    langSelect.value = getLang();
    langSelect.addEventListener("change", (e) => {
      setLang(e.target.value);
      if (typeof window.renderAuditTable === "function") window.renderAuditTable();
    });
  }
  applyLang();

  document.getElementById("logoutBtn")?.addEventListener("click", async () => {
    if (confirm(t("sa_logout_confirm", "Tizimdan chiqishni xohlaysizmi?"))) {
      if (typeof window.scEndSession === "function") await window.scEndSession();
      await signOut(auth);
      localStorage.clear();
      sessionStorage.clear();
      window.location.href = "login.html";
    }
  });

  document.addEventListener("input", (e) => {
    const target = e.target;
    const val = target.value;

    if (target.id === 'card_num' || target.id === 'cardNumber') {
      let digits = val.replace(/\D/g, '');
      const cardLogo = document.getElementById('card-type-logo');
      if (cardLogo) {
        if (digits.startsWith('8600')) {
          cardLogo.innerText = "🔹 " + t("sa_card_uzcard", "UzCard"); cardLogo.style.color = "#0052cc";
        } else if (digits.startsWith('9860')) {
          cardLogo.innerText = "🔸 " + t("sa_card_humo", "Humo"); cardLogo.style.color = "#ff6b00";
        } else {
          cardLogo.innerText = "";
        }
      }
      target.value = (digits.match(/.{1,4}/g)?.join(' ') || digits).substring(0, 19);
    }
    if (target.id === 'card_exp' || target.id === 'cardExpiry') {
      let digits = val.replace(/\D/g, '');
      target.value = digits.length >= 2 ? digits.substring(0, 2) + '/' + digits.substring(2, 4) : digits;
    }
    if (target.id === "newRestDomain") {
      // Foydalanuvchi loginni QO'LDA (haqiqiy klaviatura bosishi bilan)
      // o'zgartirgan bo'lsa, bu yerda uni endi qayta yozib qo'ymaymiz —
      // window._newRestLoginTypedByUser quyidagi "keydown" listenerida
      // o'rnatiladi (pastga qarang).
      if (!window._newRestLoginTypedByUser) {
        const loginField = document.getElementById("newRestAdminLogin");
        if (loginField) loginField.value = val.trim().toLowerCase() + "_admin";
      }
    }
    if (target.id === "newRestAdminPass") {
      target.value = val.replace(/\D/g, '').substring(0, 6);
    }
    if (target.id === 'card_cvc' || target.id === 'cardCvc') {
      target.value = val.replace(/\D/g, '').substring(0, 3);
    }
  });

  // newRestAdminLogin VA newRestDomain uchun HAQIQIY foydalanuvchi
  // kiritishini aniqlash: "keydown" faqat jismoniy klaviatura bosilganda
  // ishga tushadi — brauzer autofill/parol menejeri maydonni to'ldirganda
  // "input"/"change" hodisasi sun'iy ravishda yuborilishi mumkin, lekin
  // "keydown" HECH QACHON emas. Shu farq orqali "foydalanuvchi qo'lda
  // o'zgartirdi" holatini "brauzer/eski qiymat qoldi" holatidan ajratib
  // olamiz. Domen uchun ham xuddi shunday himoya kerak — oldingi tuzatish
  // faqat login maydonini himoya qilgan edi, lekin agar #newRestDomain'ning
  // O'ZI ham autofill bilan eski qiymatga ega bo'lsa, undan hosil
  // qilingan login ham muqarrar noto'g'ri chiqadi. saveNewRestaurant() bu
  // ikkala bayroqni endi alohida tekshiradi.
  document.addEventListener("keydown", (e) => {
    if (e.target?.id === "newRestAdminLogin") {
      window._newRestLoginTypedByUser = true;
    }
    if (e.target?.id === "newRestDomain") {
      window._newRestDomainTypedByUser = true;
    }
  });
});

// One throwing step here used to silently cancel every step listed after
// it — including, worse, the OTHER two onLangChange() dispatchers further
// down this file, since a listener throwing aborts i18n.js's whole
// langListeners.forEach loop. That's the exact bug behind "language only
// updates for sidebar/header, everything else needs a refresh". Each step
// (in all three dispatchers below) is now isolated so one module's
// re-render failing can never block the others. See the matching note in
// i18n.js's setLang().
function _i18nRelabelStep(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[i18n] "${label}" failed during language switch — other modules still updated normally:`, err);
  }
}

onLangChange(() => {
  _i18nRelabelStep("applyLang", () => applyLang());
  _i18nRelabelStep("renderRestaurantsTable", () => { if (typeof window.renderRestaurantsTable === "function") window.renderRestaurantsTable(); });
  _i18nRelabelStep("updateDashboardStats", () => { if (typeof updateDashboardStats === "function") updateDashboardStats(); });
  _i18nRelabelStep("updateActivityRanking", () => { if (typeof window.updateActivityRanking === "function") window.updateActivityRanking(); });
  _i18nRelabelStep("renderPaymentHistory", () => { if (typeof window.renderPaymentHistory === "function") window.renderPaymentHistory(); });
  _i18nRelabelStep("renderSystemSettingsUI", () => { if (typeof window.renderSystemSettingsUI === "function") window.renderSystemSettingsUI(); });
  _i18nRelabelStep("intRenderGrid", () => { if (typeof window.intRenderGrid === "function") window.intRenderGrid(); });
  _i18nRelabelStep("akRenderList", () => { if (typeof window.akRenderList === "function") window.akRenderList(); });
  _i18nRelabelStep("frRenderList", () => { if (typeof window.frRenderList === "function") window.frRenderList(); });
  _i18nRelabelStep("puRenderList", () => { if (typeof window.puRenderList === "function") window.puRenderList(); });
  _i18nRelabelStep("ecRenderList", () => { if (typeof window.ecRenderList === "function") window.ecRenderList(); });
  _i18nRelabelStep("bcRenderList", () => { if (typeof window.bcRenderList === "function") window.bcRenderList(); });
  // NOTE: window.lmRenderList o'rniga window.orgRenderList — "lm" moduli
  // "org" (Tashkilotlar) sifatida qayta nomlangan, lekin bu yerdagi eski
  // chaqiruv yangilanmagan qolib ketgan edi (shuning uchun Tashkilotlar
  // ro'yxati til almashganda hech qachon qayta chizilmasdi).
  _i18nRelabelStep("orgRenderList", () => { if (typeof window.orgRenderList === "function") window.orgRenderList(); });
  _i18nRelabelStep("smRenderList", () => { if (typeof window.smRenderList === "function") window.smRenderList(); });
  _i18nRelabelStep("gnRenderHistory", () => { if (typeof window.gnRenderHistory === "function") window.gnRenderHistory(); });
  _i18nRelabelStep("scRenderDevices", () => { if (typeof window.scRenderDevices === "function") window.scRenderDevices(); });
  _i18nRelabelStep("scRenderSessions", () => { if (typeof window.scRenderSessions === "function") window.scRenderSessions(); });
  _i18nRelabelStep("scRenderLoginHistory", () => { if (typeof window.scRenderLoginHistory === "function") window.scRenderLoginHistory(); });
  _i18nRelabelStep("shRefreshLabels", () => { if (typeof window.shRefreshLabels === "function") window.shRefreshLabels(); });
  _i18nRelabelStep("renderAuditTable", () => { if (typeof window.renderAuditTable === "function") window.renderAuditTable(); });
  _i18nRelabelStep("populateAuditFilters", () => { if (typeof _populateAuditFilterDropdowns === "function") _populateAuditFilterDropdowns(); });
  _i18nRelabelStep("openAuditDetailModal", () => {
    const id = window._openAuditDetailId;
    const modal = document.getElementById("auditDetailModal");
    if (id && modal && modal.style.display !== "none" && typeof window.openAuditDetailModal === "function") {
      window.openAuditDetailModal(id);
    }
  });
  _i18nRelabelStep("renderPromoCodesTable", () => { if (typeof window.renderPromoCodesTable === "function") window.renderPromoCodesTable(); });
  _i18nRelabelStep("renderBroadcastHistory", () => { if (typeof window.renderBroadcastHistory === "function") window.renderBroadcastHistory(); });
  _i18nRelabelStep("renderTasksList", () => { if (typeof window.renderTasksList === "function") window.renderTasksList(); });
  _i18nRelabelStep("saRenderSystemAlerts", () => { if (typeof window.saRenderSystemAlerts === "function") window.saRenderSystemAlerts(); });
  _i18nRelabelStep("renderTariffCards", () => {
    if (document.getElementById("tariffCardsContainer") && typeof window.renderTariffCards === "function") {
      window.renderTariffCards(window.selectedTariffKey);
    }
  });
  _i18nRelabelStep("renderNewRestLicenseOptions", () => {
    if (document.getElementById("newRestLicenseOptions") && typeof window.renderNewRestLicenseOptions === "function") {
      window.renderNewRestLicenseOptions();
    }
  });

  // Revenue Calculator / Marketing forecast — faqat foydalanuvchi shu
  // bo'limga kirgan (konteyner mavjud) yoki natija paneli allaqachon
  // ko'rsatilgan bo'lsa qayta chizamiz (Firebase'ga qayta murojaat yo'q,
  // faqat window.allTariffs kabi keshlangan ma'lumot asosida).
  _i18nRelabelStep("_mfRenderForecast", () => {
    if (document.getElementById("mf_tariff") && typeof window._mfRenderForecast === "function") {
      window._mfRenderForecast();
    }
  });
  _i18nRelabelStep("rcCalculate", () => {
    const rcResultPanel = document.getElementById("rc_result_panel");
    if (rcResultPanel && rcResultPanel.style.display !== "none" && typeof window.rcCalculate === "function") {
      window.rcCalculate();
    }
  });

  // "Modullarni boshqarish" oynasi ochiq bo'lsa, checkbox yorliqlarini
  // (window._saModulesPendingState — foydalanuvchining hali saqlanmagan
  // tanlovlari) yo'qotmasdan joriy tilga qayta chizamiz.
  _i18nRelabelStep("_renderSaModulesList", () => {
    const saModulesModal = document.getElementById("saModulesModal");
    if (saModulesModal && saModulesModal.style.display !== "none" && typeof _renderSaModulesList === "function") {
      _renderSaModulesList();
    }
  });

  // To'lov cheki ochiq bo'lsa (masalan, admin uni yopishdan oldin tilni
  // almashtirsa), yorliqlarini shu zahoti qayta chizamiz.
  _i18nRelabelStep("_updateReceiptLabels", () => {
    const receiptModal = document.getElementById("receiptModal");
    if (receiptModal && typeof _updateReceiptLabels === "function") {
      _updateReceiptLabels();
    }
  });

  _i18nRelabelStep("restaurantSearch placeholder", () => {
    const searchInput = document.getElementById("restaurantSearch");
    if (searchInput) searchInput.placeholder = t("sa_placeholder_search", "Restoran qidirish...");
  });

  _i18nRelabelStep("updateGrowthChart", () => {
    if (typeof window.updateGrowthChart === "function") {
      const period = document.getElementById('chartPeriodSelect')?.value || 'monthly';
      window.updateGrowthChart(period);
    }
  });

  _i18nRelabelStep("saChatModal labels", () => {
    if (document.getElementById('saChatModal')) {
      const saChatSearchInput = document.getElementById('saChatSearchInput');
      if (saChatSearchInput) saChatSearchInput.placeholder = t("sa_placeholder_search_rest", "🔍 Restoran qidirish...");

      const saChatInput = document.getElementById('saChatInput');
      if (saChatInput) saChatInput.placeholder = t("sa_placeholder_type_msg", "Xabar yozing...");

      if (!window.currentChatRestId) {
        document.getElementById('saChatTitle').innerText = t("sa_chat_title_active", "Faol Restoranlar");

        if (!document.getElementById('saChatModal').classList.contains('hidden')) {
          window.loadSaChatList();
        }
      } else {
        const backBtn = document.querySelector('#saChatRoom button');
        if (backBtn) backBtn.innerHTML = `<i class="fa-solid fa-arrow-left"></i> ${t("sa_btn_back", "Orqaga")}`;
      }
    }
  });
  // Tables/modals rebuilt above inject new data-i18n nodes after the first
  // applyLang() — sweep them so audit buttons, modal labels, and filters
  // switch language without a page reload.
  _i18nRelabelStep("applyLangFinal", () => applyLang());
});

window.hashPassword = async function (password) {
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
};

// ═══════════════════════════════════════════════════════════════════
//  SYSTEM HEALTH — Firebase xizmatlar holati real-vaqt monitoring
// ═══════════════════════════════════════════════════════════════════

(function _shModule() {

  /** Kuzatiladigan xizmatlar */
  // Xizmat nomlari joriy tilda hisoblanadi (til almashtirilganda ham to'g'ri
  // ko'rsatilishi uchun eval vaqtida emas, har safar chaqirilganda t() orqali
  // olinadi — quyidagi _shSvcName() ga qarang).
  // P0-2 systemData-regression fix: these used to write/read
  // systemData/_healthPing* directly with the client SDK — now closed
  // entirely by database.rules.json (".read":false/".write":false,
  // unconditional, superadmin included). All 4 checks now come from ONE
  // backend call (GET /api/superadmin/dashboard/health, Admin-SDK-backed —
  // see backend/routes/superadminDashboard.js), fetched once per
  // shRunChecks() run below; each `check` here just reads its own field
  // from that shared result instead of hitting Firebase itself. Thresholds/
  // history/rendering (_shStatus, _shHistory, _shUpdateMini, etc.) are all
  // unchanged.
  const SH_SERVICES = [
    {
      id: 'rtdb',
      nameKey: "sa_health_svc_rtdb", nameFallback: "Realtime DB",
      icon: '🗄️',
      check: (healthData) => _shResultToMs(healthData?.rtdb),
    },
    {
      id: 'auth',
      nameKey: "sa_health_svc_auth", nameFallback: "Authentication",
      icon: '🔐',
      check: (healthData) => _shResultToMs(healthData?.auth),
    },
    {
      id: 'storage',
      nameKey: "sa_health_svc_storage", nameFallback: "Storage",
      icon: '📦',
      check: (healthData) => _shResultToMs(healthData?.storage),
    },
    {
      id: 'functions',
      nameKey: "sa_health_svc_functions", nameFallback: "Cloud Functions",
      icon: '⚡',
      check: (healthData) => _shResultToMs(healthData?.functions),
    },
  ];

  /** `{ms}` → resolved ms; `{error}`/missing → rejected, matching the old
   *  per-service check()'s throw-on-failure contract so downstream
   *  Promise.allSettled handling below needs no changes. */
  function _shResultToMs(result) {
    if (result && typeof result.ms === "number") return Promise.resolve(result.ms);
    return Promise.reject(new Error(result?.error || t("sa_health_ping_failed", "ping read failed")));
  }

  /** Xizmat nomini joriy tilda qaytaradi (har safar chaqirilganda t() ishlaydi,
   *  shu sababli til almashtirilganda/qayta yuklanganda ham to'g'ri chiqadi). */
  function _shSvcName(svc) {
    if (!svc) return '';
    return t(svc.nameKey, svc.nameFallback);
  }

  /** Latency threshold: ok <300ms, warn <800ms, error >=800ms */
  function _shStatus(ms) {
    if (ms === null) return 'error';
    if (ms < 300)   return 'ok';
    if (ms < 800)   return 'warn';
    return 'error';
  }

  function _shStatusLabel(st) {
    if (st === 'ok')    return '🟢 ' + t('sa_health_status_ok', "Ishlayapti");
    if (st === 'warn')  return '🟡 ' + t('sa_health_status_warn', "Sekin");
    if (st === 'error') return '🔴 ' + t('sa_health_status_error', "Xatolik");
    return '⏳ ' + t('sa_health_status_checking', "Tekshirilmoqda");
  }

  // Har bir xizmat uchun so'nggi 20 latency tarixi
  const _shHistory = { rtdb: [], auth: [], storage: [], functions: [] };
  let _shRunning = false;

  /** Barcha xizmatlarni parallel tekshirish */
  window.shRunChecks = async function () {
    if (_shRunning) return;
    _shRunning = true;

    const now = new Date();

    // Dashboard mini-cards: "tekshirilmoqda" holati
    SH_SERVICES.forEach(svc => _shUpdateMini(svc.id, null, null, true));

    // Log: boshlanish yozuvi
    _shLog('info', `${t('sa_health_check_started', "Tekshiruv boshlandi")} — ${now.toLocaleTimeString('ru-RU')}`);

    // Bitta backend chaqiruvi barcha 4 xizmat uchun (bo'lingan to'g'ridan-
    // to'g'ri Firebase chaqiruvlari o'rniga) — tarmoq/auth xatosi bo'lsa,
    // har bir svc.check() o'zining _shResultToMs() orqali xatoni qaytaradi
    // (healthData undefined bo'lganda ham).
    let healthData = null;
    try {
      healthData = await _saDashFetch('/health');
    } catch (err) {
      console.error(t('sa_health_fetch_failed', "Health tekshiruvi backend chaqiruvi muvaffaqiyatsiz:"), err.message);
    }

    // Parallel check
    const results = await Promise.allSettled(
      SH_SERVICES.map(svc => svc.check(healthData))
    );

    results.forEach((res, i) => {
      const svc = SH_SERVICES[i];
      if (res.status === 'fulfilled') {
        const ms = res.value;
        const st = _shStatus(ms);
        _shHistory[svc.id].push(ms);
        if (_shHistory[svc.id].length > 20) _shHistory[svc.id].shift();
        _shUpdateMini(svc.id, st, ms, false);
        _shLog(st, `${svc.icon} ${_shSvcName(svc)}: ${ms}ms — ${_shStatusLabel(st).replace(/^[🟢🟡🔴⏳]\s/,'')}`);
      } else {
        _shHistory[svc.id].push(null);
        if (_shHistory[svc.id].length > 20) _shHistory[svc.id].shift();
        _shUpdateMini(svc.id, 'error', null, false);
        _shLog('error', `${svc.icon} ${_shSvcName(svc)}: ${t('sa_health_error', "Xatolik")} — ${res.reason?.message || t('sa_health_timeout', 'timeout')}`);
      }
    });

    _shRenderSummary();
    _shRenderLatencyCharts();

    const lastEl = document.getElementById('shLastChecked');
    if (lastEl) lastEl.textContent = `${t('sa_health_last_checked', "Oxirgi")}: ${now.toLocaleTimeString('ru-RU')}`;

    _shRunning = false;
  };

  /** Til almashtirilganda: qayta tekshirmasdan, mavjud natijalar bo'yicha
   *  faqat nomlar/labellarni joriy tilga moslab qayta chizadi. */
  window.shRefreshLabels = function () {
    SH_SERVICES.forEach(svc => {
      const hist = _shHistory[svc.id];
      const last = hist && hist.length ? hist[hist.length - 1] : null;
      const st = hist && hist.length ? _shStatus(last) : null;
      _shUpdateMini(svc.id, st, last, false);
    });
    _shRenderSummary();
    _shRenderLatencyCharts();
  };

  /** Dashboard mini-card yangilash */
  function _shUpdateMini(id, st, ms, loading) {
    const card = document.querySelector(`#dashHealthRow [data-service="${id}"]`);
    if (!card) return;
    const svc = SH_SERVICES.find(s => s.id === id);
    card.className = `sh-mini-card${loading ? ' sh-loading' : st ? ' sh-' + st : ''}`;
    card.innerHTML = `
      <span class="sh-icon">${loading ? '⏳' : st === 'ok' ? '🟢' : st === 'warn' ? '🟡' : '🔴'}</span>
      <span class="sh-label" style="font-size:12.5px; font-weight:600; color:#374151;">${svc ? _shSvcName(svc) : id}</span>
      <span class="sh-ping">${loading ? '…' : ms !== null ? ms + 'ms' : 'err'}</span>`;
  }

  /** Full health section — summary kartalar */
  function _shRenderSummary() {
    const el = document.getElementById('shSummaryRow');
    if (!el) return;

    el.innerHTML = SH_SERVICES.map(svc => {
      const hist = _shHistory[svc.id];
      const last = hist.length ? hist[hist.length - 1] : null;
      const st   = _shStatus(last);
      const avg  = hist.filter(v => v !== null).length
        ? Math.round(hist.filter(v => v !== null).reduce((a, b) => a + b, 0) / hist.filter(v => v !== null).length)
        : null;

      return `
        <div class="sh-summary-card sh-${st}">
          <span class="sh-summary-name">${svc.icon} ${_shSvcName(svc)}</span>
          <span class="sh-summary-status">${_shStatusLabel(st)}</span>
          <span style="font-size:12px; color:#6b7280; margin-top:2px;">
            ${last !== null ? `${t('sa_health_last_value', "Son")}: <b>${last}ms</b>` : t('sa_health_no_data', "Ma'lumot yo'q")}
            ${avg !== null ? ` · ${t('sa_health_avg', "O'rt")}: <b>${avg}ms</b>` : ''}
          </span>
        </div>`;
    }).join('');
  }

  /** Latency mini-bar grafiklari */
  function _shRenderLatencyCharts() {
    const el = document.getElementById('shLatencyCharts');
    if (!el) return;

    el.innerHTML = SH_SERVICES.map(svc => {
      const hist = _shHistory[svc.id];
      const maxMs = Math.max(...hist.filter(v => v !== null), 1);

      const bars = hist.map(ms => {
        if (ms === null) return `<div class="sh-bar-seg" style="background:#fecaca; height:100%;"></div>`;
        const pct   = Math.max(6, Math.round((ms / Math.max(maxMs, 1)) * 100));
        const color = ms < 300 ? '#22c55e' : ms < 800 ? '#f59e0b' : '#ef4444';
        return `<div class="sh-bar-seg" title="${ms}ms" style="background:${color}; height:${pct}%;"></div>`;
      });

      // Oxirgi ms
      const last = hist.length ? hist[hist.length - 1] : null;
      const st   = _shStatus(last);
      const badge = `<span style="font-size:11px; padding:2px 7px; border-radius:6px;
        background:${st==='ok'?'#dcfce7':st==='warn'?'#fef3c7':'#fee2e2'};
        color:${st==='ok'?'#15803d':st==='warn'?'#92400e':'#b91c1c'}; font-weight:700;">
        ${last !== null ? last+'ms' : t('sa_health_err_short', 'err')}</span>`;

      return `
        <div class="sh-bar-wrap">
          <div class="sh-bar-header">
            <span>${svc.icon} ${_shSvcName(svc)}</span>
            ${badge}
          </div>
          <div class="sh-bar-track">
            ${bars.length ? bars.join('') : `<span style="color:#d1d5db;font-size:11px;padding:0 4px;">${t('sa_health_not_checked_yet', "Hali tekshirilmagan")}</span>`}
          </div>
        </div>`;
    }).join('');
  }

  /** Log yozish */
  const _shLogs = [];
  function _shLog(level, text) {
    _shLogs.unshift({ level, text, time: new Date().toLocaleTimeString('ru-RU') });
    if (_shLogs.length > 60) _shLogs.pop();
    _shRenderLog();
  }

  function _shRenderLog() {
    const el = document.getElementById('shLogContainer');
    if (!el) return;
    if (!_shLogs.length) {
      el.innerHTML = `<div style="padding:20px; text-align:center; color:#9ca3af;">${t('sa_health_no_logs', "Yozuvlar yo'q")}</div>`;
      return;
    }
    el.innerHTML = _shLogs.map(e => `
      <div class="sh-log-entry">
        <span class="sh-log-time">${e.time}</span>
        <span class="sh-log-dot ${e.level === 'info' ? 'ok' : e.level}"></span>
        <span class="sh-log-text">${e.text}</span>
      </div>`).join('');
  }

  /** Auto-refresh: har 60 soniyada */
  let _shTimer = null;
  function _shStartAuto() {
    window.shRunChecks();
    _shTimer = setInterval(window.shRunChecks, 60_000);
  }

  // System Health 401 fix: this used to auto-start unconditionally on
  // DOMContentLoaded (see _shAttachNavHook below), independent of and not
  // synchronized with the onAuthStateChanged gate every other listener
  // waits for (superadmin.js:2410-2450). Firebase's session restoration is
  // async and can still be in flight at DOMContentLoaded, so
  // shRunChecks()'s very first call could fire with no signed-in user yet
  // — no Authorization header gets attached at all, and requireSuperAdmin
  // correctly 401s that (not a backend bug — confirmed by live trace: the
  // same requireSuperAdmin check already works for every other superadmin
  // endpoint once a real session exists). Exposed here, guarded by the
  // same !_shTimer check the nav-link click handler below already uses, so
  // the auth gate can trigger the real start (once, after auth resolves)
  // without risking a second, parallel 60s interval if a click happens to
  // reach _shStartAuto() first.
  window._shAutoStartIfNeeded = function () {
    if (!_shTimer) _shStartAuto();
  };

  /** Health sectioniga o'tganda avtomatik start */
  function _shAttachNavHook() {
    document.querySelectorAll('.sidebar-nav a[href="#health"]').forEach(link => {
      link.addEventListener('click', () => {
        if (!_shTimer) _shStartAuto();
        else window.shRunChecks();
      });
    });
    // Auto-start on page load now happens from the onAuthStateChanged gate
    // (window._shAutoStartIfNeeded(), called from superadmin.js's main init
    // block) instead of unconditionally here — this hook only wires up the
    // nav-link click handler above now.
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _shAttachNavHook);
  else _shAttachNavHook();

})(); // end _shModule

// ═══════════════════════════════════════════════════════════════════

// Generic in-section tabs, used by TWO independent groups:
//   "settings" — #settings bo'limi: Sozlamalar / Xavfsizlik / Litsenziya muddatlari
//   "health"   — #health bo'limi:   System Health / Xotira Monitor
// `group` orqali faqat SHU guruhga tegishli .sa-tabpanel/.sa-tab-btn
// almashtiriladi — health tabiga bosish settings tablariga umuman
// tegmaydi, va aksincha. Bitta tab ID bir nechta .sa-tabpanel bo'lagiga
// (bir xil group+tab-panel juftligi) tegishli bo'lishi mumkin (masalan
// "general" — Chek+Platforma birinchi bo'lakda, Tizim kartasi ikkinchi,
// fayldagi joylashuv tartibi tufayli) — shuning uchun querySelectorAll
// bilan BARCHASINI birga ko'rsatish/yashirish kerak, getElementById emas.
window.saTabSwitch = function (group, tabId) {
  document.querySelectorAll(`.sa-tabpanel[data-tab-group="${group}"]`).forEach(el => {
    el.classList.toggle('active', el.dataset.tabPanel === tabId);
  });
  document.querySelectorAll(`.sa-tab-btn[data-tab-group="${group}"]`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tabBtn === tabId);
  });
  // Health guruhidagi tablar — ikkalasi ham allaqachon #health sahifasi
  // ochilganda (initNavigation()'dagi 'health' holati) bir martalik
  // yuklanadi; bu yerda faqat tab birinchi marta ko'ringanda ma'lumot hali
  // bo'sh bo'lib qolmasligi uchun qayta chaqiriladi (arzon, idempotent).
  if (group === 'health' && tabId === 'health' && typeof window.shRunChecks === 'function') window.shRunChecks();
  if (group === 'health' && tabId === 'storage' && typeof window.smRenderList === 'function') window.smRenderList();
};

function initNavigation() {
  const navLinks = document.querySelectorAll('.sidebar-nav a');
  const sections = document.querySelectorAll('.saas-section');

  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href');
      if (!href || !href.startsWith('#')) return;
      e.preventDefault();

      navLinks.forEach(l => l.classList.remove('active'));
      sections.forEach(s => s.classList.remove('active-section'));

      link.classList.add('active');
      const targetId = href.substring(1);
      if (targetId) document.getElementById(targetId)?.classList.add('active-section');

      // Marketing bo'limiga o'tganda grafik va ma'lumotlarni yangilash
      if (targetId === 'marketing') {
        setTimeout(() => {
          if (typeof window._mfRenderForecast === 'function') {
            window._mfRenderForecast();
          } else {
            window.initMarketingForecast();
          }
        }, 100);
      }

      // Xabar yuborish bo'limiga o'tganda segment hisoblagichlarini va tarixni yangilash
      if (targetId === 'broadcast') {
        if (typeof window.bcUpdateSegmentCounts === 'function') window.bcUpdateSegmentCounts();
        if (typeof window.renderBroadcastHistory === 'function') window.renderBroadcastHistory();
      }

      if (targetId === 'health') {
        if (typeof window.shRunChecks === 'function') window.shRunChecks();
        if (typeof window.smRenderList === 'function') window.smRenderList();
      }

      if (targetId === 'tasks') {
        listenTasks();
        setTimeout(() => {
          window.renderTasksList();
          window.updateTaskStats();
          window.updateTasksBadge();
        }, 100);
      }

    });
  });
}

// ============================================
// 🚨 TIZIM OGOHLANTIRISHLARI PANELI (Dashboard)
// restaurants/{id}/systemAlerts dagi barcha faol yozuvlarni yig'ib,
// Dashboard'da umumiy ro'yxat sifatida ko'rsatadi.
// ============================================
(function () {
  function _saCollectAllAlerts() {
    const out = [];
    Object.entries(window.allRestaurants || {}).forEach(([restId, rest]) => {
      const alerts = rest?.systemAlerts || {};
      Object.values(alerts).forEach(a => {
        if (a && a.active) {
          out.push({
            ...a,
            restId,
            restName: (rest.info && rest.info.name) || restId
          });
        }
      });
    });
    out.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    return out;
  }

  function _saEnsurePanel() {
    let panel = document.getElementById('saSystemAlertsPanel');
    if (panel) return panel;

    const anchor = document.getElementById('totalRestaurants');
    // Statistika kartalari joylashgan konteynerni topamiz (2-3 daraja yuqoriga)
    let statsContainer = anchor ? (anchor.closest('.stats-grid, .dashboard-stats, .cards-row, .grid') || anchor.parentElement?.parentElement) : null;
    const dashboardSection = document.getElementById('dashboard') || (statsContainer ? statsContainer.closest('section, div.page, div[id]') : null);

    panel = document.createElement('div');
    panel.id = 'saSystemAlertsPanel';
    panel.style.cssText = 'margin:16px 0; border:1px solid #FECACA; background:#FEF2F2; border-radius:12px; padding:16px; display:none;';
    panel.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
        <span style="font-size:18px;">🔴</span>
        <strong style="color:#B91C1C; font-size:15px;">${t('sa_alerts_panel_title', "Tizim ogohlantirishlari")}</strong>
      </div>
      <div id="saSystemAlertsList" style="display:flex; flex-direction:column; gap:8px;"></div>
    `;

    if (statsContainer && statsContainer.parentElement) {
      statsContainer.parentElement.insertBefore(panel, statsContainer.nextSibling);
    } else if (dashboardSection) {
      dashboardSection.insertBefore(panel, dashboardSection.firstChild);
    } else {
      document.body.insertBefore(panel, document.body.firstChild);
    }
    return panel;
  }

  window.saRenderSystemAlerts = function () {
    const panel = _saEnsurePanel();
    const list = document.getElementById('saSystemAlertsList');
    if (!panel || !list) return;

    const alerts = _saCollectAllAlerts();
    if (!alerts.length) {
      panel.style.display = 'none';
      list.innerHTML = '';
      return;
    }
    panel.style.display = 'block';

    list.innerHTML = alerts.map(a => {
      const timeStr = a.updatedAt ? new Date(a.updatedAt).toLocaleString('ru-RU') : '';
      return `
        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px; background:#fff; border:1px solid #FEE2E2; border-radius:10px; padding:10px 14px;">
          <div>
            <div style="font-weight:700; color:#111827; font-size:13px;">🔴 ${t('sa_alert_restaurant_prefix', 'Restoran')} "${escapeHtml(a.restName)}"</div>
            <div style="color:#374151; font-size:13px; margin-top:2px;">${escapeHtml(a.title)}</div>
            ${a.detail ? `<div style="color:#6b7280; font-size:12px; margin-top:2px;">${escapeHtml(a.detail)}</div>` : ''}
          </div>
          <div style="text-align:right; white-space:nowrap;">
            <div style="color:#9ca3af; font-size:11px;">${timeStr}</div>
            <button onclick="window.editRestaurant && window.editRestaurant('${a.restId}')"
              style="margin-top:4px; background:#eff6ff; color:#2563eb; border:none; border-radius:6px; padding:4px 10px; font-size:11px; font-weight:700; cursor:pointer;">
              ${t('sa_alert_view_btn', "Ko'rish")}
            </button>
          </div>
        </div>`;
    }).join('');
  };

  // Restoranlar ro'yxatidagi badge bosilganda ham shu panelga o'tkazamiz
  window.saShowRestaurantAlerts = function (restId) {
    document.querySelector('.sidebar-nav a[href="#dashboard"]')?.click();
    setTimeout(() => {
      document.getElementById('saSystemAlertsPanel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
  };
})();

// ============================================
// 2. DATA LISTENERS & DASHBOARD
// ============================================
// Restaurant-count-0 fix: onValue(ref(db,"restaurants"),...) read the bare
// "restaurants" collection in one shot — database.rules.json's ".read" is
// defined only at restaurants/$restId (a descendant), never at bare
// "restaurants" or root, and a rule on a descendant never authorizes a
// bulk read of the parent above it. This has been permission_denied for
// every session, superadmin included, since that rules structure shipped
// — unrelated to auth state or the polling fix above. Now served by
// GET /api/superadmin/dashboard/restaurants (Admin SDK, bypasses Security
// Rules by design, same as every other route in this file), which also
// projects each restaurant down to exactly the fields this dashboard
// reads (info/subscription/modules in full, users reduced to
// {login, createdAt} only) instead of returning full raw records.
//
// Repeated-console-log audit (superadmin.js:3286/3993/4254/4323 atrofi):
// root cause traced live — NOT a duplicate onValue listener va NOT a
// stacked init (o'sha ikkalasi ham allaqachon tuzatilgan: _saGenericPoll
// bir xil resursni bitta intervalga birlashtiradi, _scListenersStarted esa
// listenRestaurants()/listenSystemSettings()ning bir necha marta ishga
// tushishini oldini oladi). Haqiqiy sabab: updateDashboardStats() (demak,
// ichidagi "Всего ресторанов" logi HAM, chunki u har doim updateTodayStats()
// ("Статистика за сегодня" logi)ni ham zanjir bo'yicha chaqiradi) IKKITA
// MUSTAQIL 30s pollerdan — /restaurants (shu yerda) va /tariffs
// (listenSystemSettings(), pastda) — chaqiriladi. Ikkalasi ham sahifa
// ochilganda ketma-ket ishga tushirilgani uchun fazasi deyarli bir xil
// qoladi va shu sabab har ~30 soniyada ikkalasi ham deyarli bir vaqtda
// fire bo'lib, bitta logikaviy yangilanish ikki marta hisoblanadi va ikki
// marta konsolga yoziladi. Cheksiz tsikl EMAS (chastota o'zgarmaydi,
// tezlashib bormaydi) va Firebase write tsikli ham emas (faqat o'qish +
// DOM/konsol) — sof ortiqcha, deyarli bir vaqtdagi qayta hisoblash.
// _saScheduleDashboardStats() shu ikki poller-callback uchun 400ms debounce
// bilan ularni bitta haqiqiy chaqiruvga birlashtiradi; onLangChange() va
// deleteAllRestaurants() kabi aniq foydalanuvchi amali natijasidagi darhol
// yangilanish kutilgan joylar o'zgarishsiz — ular hali ham sinxron
// updateDashboardStats()ni to'g'ridan-to'g'ri chaqiradi.
let _saDashStatsDebounceTimer = null;
function _saScheduleDashboardStats() {
  if (_saDashStatsDebounceTimer) clearTimeout(_saDashStatsDebounceTimer);
  _saDashStatsDebounceTimer = setTimeout(() => {
    _saDashStatsDebounceTimer = null;
    if (typeof updateDashboardStats === "function") updateDashboardStats();
  }, 400);
}

function listenRestaurants() {
  _saStartDashPoll('/restaurants', (data) => {
    if (data && Object.keys(data).length) {
      window.allRestaurants = data;
      _saScheduleDashboardStats();
      window.renderRestaurantsTable();
      window.updateActivityRanking();
      if (typeof window.saRenderSystemAlerts === "function") window.saRenderSystemAlerts();
      const period = document.getElementById('chartPeriodSelect')?.value || 'monthly';
      window.updateGrowthChart(period);
      if (typeof window.bcUpdateSegmentCounts === "function") window.bcUpdateSegmentCounts();
    }
  });
  fetch("/api/pg/meta")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (j && typeof j.restaurantCount === "number") {
        window.__canonicalRestaurantCount = j.restaurantCount;
        if (typeof updateDashboardStats === "function") updateDashboardStats();
      }
    })
    .catch(() => {});
}

// P0-2 systemData-regression fix: systemData/paymentHistory and
// systemData/auditLogs are no longer client-readable at all (see
// database.rules.json) — both onValue() subscriptions here are replaced
// with a poll of backend/routes/superadminDashboard.js's endpoints
// (Admin-SDK-backed, superadmin-authenticated). Same data shape (object
// keyed by push id) both renderers already expect, so renderPromoCodesTable/
// renderPaymentHistory are unchanged.
function listenPaymentHistory() {
  _saStartDashPoll('/payment-history', (data) => {
    console.log(t("sa_log_payment_history_updated", "💳 To'lovlar tarixi yangilandi!"));
    globalPaymentsData = data && Object.keys(data).length ? data : null;

    if (typeof window.renderPromoCodesTable === "function") {
      window.renderPromoCodesTable();
    }
  });

  // 📜 Litsenziya tarixi — audit logdan litsenziyaga oid amallarni kuzatish
  _saStartDashPoll('/audit-log', (data) => {
    globalLicenseHistoryData = data && Object.keys(data).length ? data : null;
    if (typeof window.renderPaymentHistory === "function") {
      window.renderPaymentHistory();
    }
  });
}

// Litsenziya tarixi bo'limida ko'rsatiladigan amal turlari
const LICENSE_HISTORY_ACTIONS = new Set([
  "new_restaurant",       // 🟢 Litsenziya yaratildi
  "extend",               // 🔵 Muddat uzaytirildi
  "trial_continue",       // 🔵 Muddat uzaytirildi (sinov)
  "edit",                 // 🟠 Litsenziya tahrirlandi
  "settings_change",      // 🟠 Litsenziya tahrirlandi
  "tariff_change",        // 🟠 Litsenziya tahrirlandi
  "license_change",       // 🟠 Litsenziya tahrirlandi
  "block",                // 🔴 Litsenziya bloklandi
  "unblock",              // 🟢 Litsenziya faollashtirildi
  "resume",               // 🟢 Litsenziya faollashtirildi
  "pause",                // 🔴 Litsenziya bloklandi
  "trial_cancel",         // 🔴 Litsenziya bloklandi
  "device_force_logout",  // 🟣 Qurilma almashtirildi
  "device_disable",       // 🟠 Qurilma bloklandi
  "device_enable",        // 🟢 Qurilma qayta yoqildi
  "device_logout",        // 🟣 Qurilma almashtirildi
  "modules_update"        // 🟤 Modullar o'zgartirildi
]);

const LICENSE_ACTION_LABELS = {
  new_restaurant:       { icon: "fa-circle-plus",          color: "#16a34a", bg: "#f0fdf4", key: "sa_lic_action_created",         fallback: "🟢 Litsenziya yaratildi" },
  extend:               { icon: "fa-clock",                color: "#2563eb", bg: "#eff6ff", key: "sa_lic_action_extended",        fallback: "🔵 Muddat uzaytirildi" },
  trial_continue:       { icon: "fa-clock",                color: "#2563eb", bg: "#eff6ff", key: "sa_lic_action_trial_continue",  fallback: "🔵 Muddat uzaytirildi" },
  edit:                 { icon: "fa-pen",                  color: "#d97706", bg: "#fff7ed", key: "sa_lic_action_edited",          fallback: "🟠 Litsenziya tahrirlandi" },
  settings_change:      { icon: "fa-pen",                  color: "#d97706", bg: "#fff7ed", key: "sa_lic_action_edited",          fallback: "🟠 Litsenziya tahrirlandi" },
  tariff_change:        { icon: "fa-pen",                  color: "#d97706", bg: "#fff7ed", key: "sa_lic_action_edited",          fallback: "🟠 Litsenziya tahrirlandi" },
  license_change:       { icon: "fa-pen",                  color: "#d97706", bg: "#fff7ed", key: "sa_lic_action_edited",          fallback: "🟠 Litsenziya tahrirlandi" },
  block:                { icon: "fa-lock",                 color: "#dc2626", bg: "#fef2f2", key: "sa_lic_action_blocked",         fallback: "🔴 Litsenziya bloklandi" },
  pause:                { icon: "fa-lock",                 color: "#dc2626", bg: "#fef2f2", key: "sa_lic_action_blocked",         fallback: "🔴 Litsenziya bloklandi" },
  trial_cancel:         { icon: "fa-lock",                 color: "#dc2626", bg: "#fef2f2", key: "sa_lic_action_blocked",         fallback: "🔴 Litsenziya bloklandi" },
  unblock:              { icon: "fa-lock-open",            color: "#16a34a", bg: "#f0fdf4", key: "sa_lic_action_activated",       fallback: "🟢 Litsenziya faollashtirildi" },
  resume:               { icon: "fa-lock-open",            color: "#16a34a", bg: "#f0fdf4", key: "sa_lic_action_activated",       fallback: "🟢 Litsenziya faollashtirildi" },
  device_force_logout:  { icon: "fa-arrow-right-arrow-left", color: "#7c3aed", bg: "#f5f3ff", key: "sa_lic_action_device_change", fallback: "🟣 Qurilma almashtirildi" },
  device_logout:        { icon: "fa-arrow-right-arrow-left", color: "#7c3aed", bg: "#f5f3ff", key: "sa_lic_action_device_change", fallback: "🟣 Qurilma almashtirildi" },
  device_disable:       { icon: "fa-mobile-screen",        color: "#d97706", bg: "#fff7ed", key: "sa_lic_action_device_disable",  fallback: "🟠 Qurilma bloklandi" },
  device_enable:        { icon: "fa-mobile-screen-button", color: "#16a34a", bg: "#f0fdf4", key: "sa_lic_action_device_enable",   fallback: "🟢 Qurilma qayta yoqildi" },
  modules_update:       { icon: "fa-puzzle-piece",         color: "#92400e", bg: "#fef3e2", key: "sa_lic_action_modules",         fallback: "🟤 Modullar o'zgartirildi" }
};

let globalLicenseHistoryData = null;

// Superadmin systemData migration, Stage 2: systemData/settings/* is no
// longer client-readable/writable directly — polled from
// backend/routes/superadminSettings.js instead.
let _sdsStarted = false; // reset-to-defaults stacking fix: listenDiscountSettings() is intentionally re-called after a successful reset (see saveDiscountSettings' reset flow) to refresh the form with the just-written defaults — without this guard, that re-call created a second, permanent, independent poller for the exact same resource. The keyed dedup in _saGenericPoll above already prevents a second INTERVAL either way; this additionally skips re-registering a redundant listener callback, so the reset flow simply relies on the existing poller's next tick to show fresh data, exactly as if nothing special happened.
function listenDiscountSettings() {
  if (_sdsStarted) return;
  _sdsStarted = true;
  _saStartSettingsPoll('/subscription-plans', (data) => {
    if (data) {
      window.subscriptionPlans = data;
      [1, 3, 6, 12, "lifetime"].forEach(m => {
        const plan = window.subscriptionPlans[m];
        if (!plan) return;
        if (m === 1) {
          if (document.getElementById('price_m1')) document.getElementById('price_m1').value = plan.price || 0;
        } else if (document.getElementById(`disc_m${m}`)) {
          document.getElementById(`disc_m${m}`).value = plan.discount || 0;
        }
        if (document.getElementById(`active_m${m}`)) document.getElementById(`active_m${m}`).checked = !!plan.active;
        if (m === "lifetime" && document.getElementById('coef_mlifetime')) document.getElementById('coef_mlifetime').value = plan.coefficient || 12;
      });
      if (typeof window.updateLicenseCalcPreview === "function") window.updateLicenseCalcPreview();
    }
  });
}

// Litsenziya muddatlari blokida narxlarni jonli (live) hisoblab ko'rsatish
window.updateLicenseCalcPreview = function () {
  const basePrice = Number(document.getElementById('price_m1')?.value || 0);
  const fmt = (n) => Math.round(n).toLocaleString('ru-RU') + " " + t("sa_currency_uzs", "so'm");

  [3, 6, 12].forEach(m => {
    const discEl = document.getElementById(`disc_m${m}`);
    const calcEl = document.getElementById(`calc_m${m}`);
    if (!discEl || !calcEl) return;
    const disc = Number(discEl.value || 0);
    const total = basePrice * m * (1 - disc / 100);
    calcEl.textContent = `= ${fmt(total)}`;
  });
};

// "Yangi Restoran Qo'shish" oynasida — sozlamalardagi litsenziya muddatlaridan
// faqat Faol bo'lganlarini narxi bilan ko'rsatish (radio tanlov)
window.renderNewRestLicenseOptions = function () {
  const container = document.getElementById("newRestLicenseOptions");
  if (!container) return;

  // Til o'zgarganda ham qayta chaqiriladi (faqat matnlarni yangilash uchun) —
  // shuning uchun foydalanuvchi allaqachon tanlagan variantni yo'qotmaslik
  // kerak (aks holda har safar 1-variantga qaytib qolardi).
  const _prevChecked = container.querySelector('input[name="newRestLicenseOption"]:checked')?.value;

  const plans = window.subscriptionPlans || {};
  const fmt = (n) => Math.round(n).toLocaleString('ru-RU') + " " + t("sa_currency_uzs", "so'm");
  const basePrice = Number(plans[1]?.price || 0);

  const defs = [
    { code: "1", labelKey: "sa_lic_dur_opt_1m", labelFallback: "1 oy", price: basePrice },
    { code: "3", labelKey: "sa_lic_dur_opt_3m", labelFallback: "3 oy", price: basePrice * 3 * (1 - Number(plans[3]?.discount || 0) / 100) },
    { code: "6", labelKey: "sa_lic_dur_opt_6m", labelFallback: "6 oy", price: basePrice * 6 * (1 - Number(plans[6]?.discount || 0) / 100) },
    { code: "12", labelKey: "sa_lic_dur_opt_1y", labelFallback: "1 yil", price: basePrice * 12 * (1 - Number(plans[12]?.discount || 0) / 100) },
    { code: "lifetime", labelKey: "sa_lic_dur_opt_lifetime_label", labelFallback: "Doimiy", price: basePrice * Number(plans.lifetime?.coefficient || 12) }
  ];

  const activeDefs = defs.filter(d => !!plans[d.code === "lifetime" ? "lifetime" : Number(d.code)]?.active);

  if (activeDefs.length === 0) {
    container.innerHTML = `<div style="font-size:12.5px; color:#9ca3af;">${t("sa_no_active_license_periods", "Faol litsenziya muddati yo'q. Avval sozlamalar bo'limidan yoqing.")}</div>`;
    return;
  }

  container.innerHTML = activeDefs.map((d, idx) => `
    <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 12px; border:1.5px solid #e2e8f0; border-radius:8px; cursor:pointer; font-size:13px; color:#374151;">
      <span style="display:flex; align-items:center; gap:8px;">
        <input type="radio" name="newRestLicenseOption" value="${d.code}" ${idx === 0 ? "checked" : ""} style="accent-color:#6bada4;">
        ${t(d.labelKey, d.labelFallback)}
      </span>
      <span style="font-weight:700; color:#059669;">${fmt(d.price)}</span>
    </label>
  `).join("");

  if (_prevChecked) {
    const toRecheck = container.querySelector(`input[name="newRestLicenseOption"][value="${_prevChecked}"]`);
    if (toRecheck) toRecheck.checked = true;
  }
};

// ============================================
// PROMO KODLAR TIZIMI
// ============================================
// Superadmin systemData migration, Stage 2: systemData/promoCodes is no
// longer client-readable/writable directly (see database.rules.json) —
// replaced with a poll of backend/routes/superadminMarketing.js (same
// object-keyed-by-push-id shape renderPromoCodesTable/populateBonusPromoSelect
// already expect).
function listenPromoCodes() {
  _saStartMarketingPoll('/promo-codes', (data) => {
    window.allPromoCodes = data && Object.keys(data).length ? data : {};
    if (typeof window.renderPromoCodesTable === "function") window.renderPromoCodesTable();
    if (typeof window.populateBonusPromoSelect === "function") window.populateBonusPromoSelect();
  });
}

window.openCreatePromoModal = function () {
  document.getElementById('pc_code').value = '';
  document.getElementById('pc_discount').value = '';
  document.getElementById('pc_maxUses').value = '';
  document.getElementById('pc_expireDate').value = '';
  document.getElementById('pc_note').value = '';
  const modal = document.getElementById('createPromoModal');
  if (modal) modal.style.display = 'flex';
};

window.closeCreatePromoModal = function () {
  const modal = document.getElementById('createPromoModal');
  if (modal) modal.style.display = 'none';
};

window.generateRandomPromoCode = function () {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  const input = document.getElementById('pc_code');
  if (input) input.value = code;
};

window.savePromoCode = async function () {
  const codeRaw = document.getElementById('pc_code')?.value.trim().toUpperCase() || '';
  const discount = parseInt(document.getElementById('pc_discount')?.value || '0');
  const maxUsesRaw = document.getElementById('pc_maxUses')?.value.trim() || '';
  const expireDateRaw = document.getElementById('pc_expireDate')?.value || '';
  const note = document.getElementById('pc_note')?.value.trim() || '';

  if (!codeRaw) { alert(t('sa_pc_err_no_code', "Iltimos, promo kod nomini kiriting!")); return; }
  if (!/^[A-Z0-9_-]+$/.test(codeRaw)) { alert(t('sa_pc_err_invalid_code', "Kod faqat lotin harflari, raqamlar, - va _ belgilaridan iborat bo'lishi kerak!")); return; }
  if (!discount || discount < 1 || discount > 100) { alert(t('sa_pc_err_invalid_discount', "Chegirma foizini 1-100 oralig'ida kiriting!")); return; }

  const existingKey = Object.keys(window.allPromoCodes || {}).find(
    k => (window.allPromoCodes[k].code || '').toUpperCase() === codeRaw
  );
  if (existingKey) { alert(t('sa_pc_err_duplicate', "Bu kod allaqachon mavjud!")); return; }

  const maxUses = maxUsesRaw ? parseInt(maxUsesRaw) : null;
  let expireAt = null;
  if (expireDateRaw) {
    const d = new Date(expireDateRaw + 'T23:59:59');
    expireAt = d.getTime();
  }

  try {
    await _saMarketingFetch('/promo-codes', {
      method: 'POST',
      body: JSON.stringify({ code: codeRaw, discount, maxUses, expireAt, note: note || null }),
    });
    window.logAudit && window.logAudit("promo_create", codeRaw, `${t('sa_promo_log_created', "Promo kod yaratildi:")} -${discount}%`);
    window.closeCreatePromoModal();
  } catch (err) {
    alert(t('sa_error_prefix', 'Xatolik: ') + err.message);
  }
};

window.togglePromoActive = async function (promoId, currentActive) {
  try {
    await _saMarketingFetch(`/promo-codes/${encodeURIComponent(promoId)}/toggle`, { method: 'PATCH' });
    const code = window.allPromoCodes?.[promoId]?.code || promoId;
    window.logAudit && window.logAudit("promo_toggle", code, !currentActive ? t("sa_promo_log_enabled", "Promo kod yoqildi") : t("sa_promo_log_disabled_temp", "Promo kod o'chirildi (vaqtincha)"));
  } catch (err) {
    alert(t('sa_error_prefix', 'Xatolik: ') + err.message);
  }
};

window.deletePromoCode = async function (promoId) {
  const code = window.allPromoCodes?.[promoId]?.code || promoId;
  if (!confirm(t('sa_pc_confirm_delete', "{code} promo kodini o'chirishni xohlaysizmi?").replace('{code}', code))) return;
  try {
    await _saMarketingFetch(`/promo-codes/${encodeURIComponent(promoId)}`, { method: 'DELETE' });
    window.logAudit && window.logAudit("promo_delete", code, t("sa_promo_log_deleted", "Promo kod o'chirildi"));
  } catch (err) {
    alert(t('sa_error_prefix', 'Xatolik: ') + err.message);
  }
};

// Promo kod bo'yicha to'lovlar tarixini guruhlash: { code -> [ {restaurantName, amount, discountGiven, date, months}, ... ] }
window.getPromoUsageStats = function () {
  const stats = {}; // code (UPPER) -> { totalUses, totalDiscount, usesList: [...] }
  if (!globalPaymentsData) return stats;

  Object.values(globalPaymentsData).forEach(pay => {
    if (!pay.promoCode) return;
    const codeKey = String(pay.promoCode).toUpperCase();
    const pct = Number(pay.promoDiscount || 0);
    const amount = Number(pay.amount || 0);
    // amount allaqachon promo chegirma qo'llangan holdagi summa,
    // shuning uchun asl narx = amount / (1 - pct/100), chegirma summasi = asl - amount
    const discountGiven = (pct > 0 && pct < 100) ? Math.round(amount * pct / (100 - pct)) : 0;

    if (!stats[codeKey]) stats[codeKey] = { totalUses: 0, totalDiscount: 0, usesList: [] };
    stats[codeKey].totalUses += 1;
    stats[codeKey].totalDiscount += discountGiven;
    stats[codeKey].usesList.push({
      restaurantName: pay.restaurantName || t('sa_unknown_rest', "Noma'lum restoran"),
      restaurantId: pay.restaurantId || '',
      amount: amount,
      discountGiven: discountGiven,
      months: pay.months || 0,
      date: pay.date || 0
    });
  });

  Object.values(stats).forEach(s => s.usesList.sort((a, b) => b.date - a.date));
  return stats;
};

window.renderPromoAnalyticsSummary = function (usageStats) {
  const totalUsesEl = document.getElementById('pcAnTotalUses');
  const totalDiscountEl = document.getElementById('pcAnTotalDiscount');
  const topCodeEl = document.getElementById('pcAnTopCode');
  const uniqueRestsEl = document.getElementById('pcAnUniqueRests');
  if (!totalUsesEl) return;

  let totalUses = 0, totalDiscount = 0;
  let topCode = null, topUses = 0;
  const uniqueRests = new Set();

  Object.entries(usageStats).forEach(([code, s]) => {
    totalUses += s.totalUses;
    totalDiscount += s.totalDiscount;
    if (s.totalUses > topUses) { topUses = s.totalUses; topCode = code; }
    s.usesList.forEach(u => { if (u.restaurantId) uniqueRests.add(u.restaurantId); else uniqueRests.add(u.restaurantName); });
  });

  totalUsesEl.textContent = totalUses.toLocaleString();
  totalDiscountEl.textContent = totalDiscount.toLocaleString() + " " + t("sa_currency_uzs", "so'm");
  topCodeEl.textContent = topCode ? `${topCode} (${topUses})` : '—';
  uniqueRestsEl.textContent = uniqueRests.size.toLocaleString();
};

window.togglePromoUsageRow = function (rowId) {
  const row = document.getElementById('pcUsesRow_' + rowId);
  const icon = document.getElementById('pcUsesIcon_' + rowId);
  if (!row) return;
  const isOpen = row.style.display === 'table-row';
  row.style.display = isOpen ? 'none' : 'table-row';
  if (icon) icon.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
};

window.renderPromoCodesTable = function () {
  const tbody = document.getElementById('promoCodesTableBody');
  if (!tbody) return;

  const entries = Object.entries(window.allPromoCodes || {});
  const usageStats = window.getPromoUsageStats();
  if (typeof window.renderPromoAnalyticsSummary === 'function') window.renderPromoAnalyticsSummary(usageStats);

  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:30px; color:#9ca3af;">${t('sa_pc_empty', "Hozircha promo kodlar yo'q")}</td></tr>`;
    return;
  }

  entries.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
  const now = Date.now();

  tbody.innerHTML = entries.map(([id, p]) => {
    const isExpired = !!(p.expireAt && p.expireAt < now);
    const isExhausted = !!(p.maxUses && (p.usedCount || 0) >= p.maxUses);
    const isInactiveManually = p.active === false;

    let statusHtml;
    if (isInactiveManually) {
      statusHtml = `<span class="badge" style="background:#E5E7EB; color:#4B5563;">${t('sa_pc_status_off', "O'chirilgan")}</span>`;
    } else if (isExpired) {
      statusHtml = `<span class="badge" style="background:#FEE2E2; color:#B91C1C;">${t('sa_pc_status_expired', "Muddati tugagan")}</span>`;
    } else if (isExhausted) {
      statusHtml = `<span class="badge" style="background:#FEF3C7; color:#D97706;">${t('sa_pc_status_exhausted', "Limit tugagan")}</span>`;
    } else {
      statusHtml = `<span class="badge" style="background:#D1FAE5; color:#059669;">${t('sa_pc_status_active', "Faol")}</span>`;
    }

    const usageHtml = p.maxUses
      ? `${p.usedCount || 0} / ${p.maxUses}`
      : `${p.usedCount || 0} / ${t('sa_pc_unlimited', "♾️ cheksiz")}`;

    const expiryHtml = p.expireAt
      ? new Date(p.expireAt).toLocaleDateString('ru-RU')
      : `<span style="color:#9ca3af;">${t('sa_pc_no_expiry', "Muddatsiz")}</span>`;

    const createdHtml = p.createdAt ? new Date(p.createdAt).toLocaleDateString('ru-RU') : '—';
    const safeCode = typeof escapeHtml === 'function' ? escapeHtml(p.code || '') : (p.code || '');
    const safeNote = p.note ? (typeof escapeHtml === 'function' ? escapeHtml(p.note) : p.note) : '';

    const codeKey = (p.code || '').toUpperCase();
    const stat = usageStats[codeKey] || { totalUses: 0, totalDiscount: 0, usesList: [] };
    const givenHtml = stat.totalDiscount > 0
      ? `<span style="font-weight:700; color:#dc2626;">${stat.totalDiscount.toLocaleString()} ${t("sa_currency_uzs", "so'm")}</span>`
      : `<span style="color:#9ca3af;">—</span>`;

    const hasUses = stat.usesList.length > 0;
    const expandCell = hasUses
      ? `<i id="pcUsesIcon_${id}" class="fa-solid fa-chevron-right" style="cursor:pointer; color:#9ca3af; transition:.15s;" onclick="window.togglePromoUsageRow('${id}')"></i>`
      : '';

    const usesRowsHtml = hasUses ? stat.usesList.map(u => `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 10px; border-bottom:1px solid #f1f5f9; font-size:12.5px;">
        <div style="min-width:0; flex:1;">
          <div style="font-weight:700; color:#111827;">🏪 ${(typeof escapeHtml === 'function' ? escapeHtml(u.restaurantName) : u.restaurantName)}</div>
          <div style="font-size:11px; color:#9ca3af; margin-top:1px;">${u.date ? new Date(u.date).toLocaleDateString('ru-RU') : '—'}${u.months ? ' · ' + u.months + ' ' + t('sa_months_short', 'oylik') : ''}</div>
        </div>
        <div style="text-align:right; flex-shrink:0;">
          <div style="font-weight:700; color:#059669;">${u.amount.toLocaleString()} ${t("sa_currency_uzs", "so'm")}</div>
          <div style="font-size:11px; color:#dc2626;">-${u.discountGiven.toLocaleString()} ${t("sa_currency_uzs", "so'm")}</div>
        </div>
      </div>`).join('') : '';

    return `
<tr>
  <td>${expandCell}</td>
  <td><code style="font-weight:700; letter-spacing:0.5px;">${safeCode}</code>${safeNote ? `<div style="font-size:11px; color:#9ca3af; margin-top:2px;">${safeNote}</div>` : ''}</td>
  <td><span style="font-weight:700; color:#10b981;">-${p.discount}%</span></td>
  <td>${usageHtml}</td>
  <td>${givenHtml}</td>
  <td>${expiryHtml}</td>
  <td>${statusHtml}</td>
  <td style="white-space:nowrap;">${createdHtml}</td>
  <td>
    <div style="display:flex; gap:4px; align-items:center;">
      <button class="btn-act" onclick="window.togglePromoActive('${id}', ${p.active !== false})" title="${p.active !== false ? t('sa_pc_action_disable', "Vaqtincha o'chirish") : t('sa_pc_action_enable', 'Yoqish')}" style="color:${p.active !== false ? '#f59e0b' : '#10b981'};">
        <i class="fa-solid ${p.active !== false ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
      </button>
      <button class="btn-act" onclick="window.copyToClipboard('${safeCode}', this)" title="${t('sa_copy_id', "Nusxa olish")}">
        <i class="fa-regular fa-copy"></i>
      </button>
      <button class="btn-act btn-act--block" onclick="window.deletePromoCode('${id}')" title="${t('sa_delete', "O'chirish")}">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    </div>
  </td>
</tr>
<tr id="pcUsesRow_${id}" style="display:none; background:#f9fafb;">
  <td colspan="9" style="padding:0;">
    <div style="padding:6px 16px 10px;">
      <div style="font-size:11px; font-weight:700; color:#6b7280; text-transform:uppercase; letter-spacing:.4px; padding:6px 0;">${t('sa_pc_used_by', "Qaysi restoranlar ishlatdi")}</div>
      ${usesRowsHtml || `<div style="color:#9ca3af; font-size:12px; padding:6px 0;">${t('sa_pc_no_uses_yet', "Hali ishlatilmagan")}</div>`}
    </div>
  </td>
</tr>`;
  }).join('');
};

// Bonus oynasidagi "Promo kod" turi uchun dropdownni to'ldirish
window.populateBonusPromoSelect = function () {
  const select = document.getElementById('bonusPromoSelect');
  if (!select) return;
  const now = Date.now();
  const usable = Object.entries(window.allPromoCodes || {}).filter(([id, p]) => {
    if (p.active === false) return false;
    if (p.expireAt && p.expireAt < now) return false;
    if (p.maxUses && (p.usedCount || 0) >= p.maxUses) return false;
    return true;
  });

  select.innerHTML = `<option value="">${t('sa_bonus_promo_select_empty', '— Promo kod tanlang —')}</option>` +
    usable.map(([id, p]) => `<option value="${id}">${p.code} (-${p.discount}%)</option>`).join('');
};

// ============================================
// OMMAVIY XABAR YUBORISH (BROADCAST)
// ============================================

// Teg bo'yicha broadcast: vip, demo, premium (TAG_CONFIG)
window.getBroadcastByTagRestaurants = function (tagName) {
  const all = Object.entries(window.allRestaurants || {});
  return all
    .filter(([id, rest]) => {
      const tags = rest.info?.tags || [];
      return tags.includes(tagName);
    })
    .map(([id, rest]) => ({ id, name: rest.info?.name || id }));
};

// Biznes turi bo'yicha broadcast
window.getBroadcastByBusinessTypeRestaurants = function (businessType) {
  const all = Object.entries(window.allRestaurants || {});
  return all
    .filter(([id, rest]) => (rest.info?.businessType || '') === businessType)
    .map(([id, rest]) => ({ id, name: rest.info?.name || id }));
};

window.bcPopulateBusinessTypeSelect = function () {
  const sel = document.getElementById('bcBusinessTypeSelect');
  if (!sel) return;
  const all = Object.values(window.allRestaurants || {});
  const keys = Array.from(new Set(all.map(r => r.info?.businessType).filter(Boolean)));
  const existingValues = Array.from(sel.options).map(o => o.value);
  keys.forEach(key => {
    if (!existingValues.includes(key)) {
      const btData = window.BUSINESS_TYPE_MODULES && window.BUSINESS_TYPE_MODULES[key];
      const label = btData ? (typeof btData.label === 'function' ? btData.label() : btData.label) : key;
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = label;
      sel.appendChild(opt);
    }
  });
};

window.bcUpdateSegmentCounts = function () {
  // Teg hisoblarini yangilash (TAG_CONFIG: vip/demo/premium)
  if (window.TAG_CONFIG) {
    Object.keys(window.TAG_CONFIG).forEach(tag => {
      const countEl = document.getElementById('bcTagCount_' + tag);
      if (countEl) countEl.textContent = window.getBroadcastByTagRestaurants(tag).length;
    });
  }
  if (typeof window.bcPopulateBusinessTypeSelect === 'function') window.bcPopulateBusinessTypeSelect();
  const btSel = document.getElementById('bcBusinessTypeSelect');
  if (btSel && btSel.value && btSel.value !== 'all') {
    const cnt = document.getElementById('bcBusinessTypeCount');
    if (cnt) cnt.textContent = window.getBroadcastByBusinessTypeRestaurants(btSel.value).length;
  }
  window.bcUpdateSelectedSummary();
};

window.bcUpdateSelectedSummary = function () {
  const selectedTag = window._bcSelectedTag || '';
  const selectedBt = window._bcSelectedBusinessType || '';
  let count;
  if (selectedTag) count = window.getBroadcastByTagRestaurants(selectedTag).length;
  else if (selectedBt) count = window.getBroadcastByBusinessTypeRestaurants(selectedBt).length;
  else count = 0;
  const textEl = document.getElementById('bcSelectedCountText');
  if (textEl) textEl.textContent = count;
};

// Teg bo'yicha broadcast tanlash (chip bosilganda)
window.bcSelectTag = function (tagName) {
  const alreadyActive = window._bcSelectedTag === tagName;
  window._bcSelectedTag = alreadyActive ? '' : tagName;
  window._bcSelectedBusinessType = '';
  const btSel2 = document.getElementById('bcBusinessTypeSelect');
  if (btSel2) btSel2.value = 'all';
  document.querySelectorAll('.bc-tag-chip').forEach(c => {
    const isActive = c.dataset.tag === window._bcSelectedTag;
    c.classList.toggle('active', isActive);
    c.style.border = isActive ? '1.5px solid #2563eb' : '1.5px solid #e5e7eb';
    c.style.background = isActive ? '#eff6ff' : '#fff';
    c.style.color = isActive ? '#1d4ed8' : '#374151';
    const badge = c.querySelector('.bc-seg-count');
    if (badge) { badge.style.background = isActive ? '#1d4ed8' : '#f3f4f6'; badge.style.color = isActive ? '#fff' : '#374151'; }
  });
  window.bcUpdateSelectedSummary();
};

// Biznes turi bo'yicha broadcast tanlash (select o'zgarganda)
window.bcSelectBusinessType = function (businessType) {
  window._bcSelectedBusinessType = businessType && businessType !== 'all' ? businessType : '';
  if (window._bcSelectedBusinessType) {
    window._bcSelectedTag = '';
    document.querySelectorAll('.bc-tag-chip').forEach(c => {
      c.classList.remove('active');
      c.style.border = '1.5px solid #e5e7eb';
      c.style.background = '#fff';
      c.style.color = '#374151';
      const badge = c.querySelector('.bc-seg-count');
      if (badge) { badge.style.background = '#f3f4f6'; badge.style.color = '#374151'; }
    });
  }
  window.bcUpdateSelectedSummary();
};

window.openBroadcastConfirm = function () {
  const text = document.getElementById('bcMessageText')?.value.trim() || '';
  if (!text) { alert(t('sa_bc_err_no_text', "Iltimos, xabar matnini kiriting!")); return; }

  const useNotif = !!document.getElementById('bcChannelNotif')?.checked;
  const useChat = !!document.getElementById('bcChannelChat')?.checked;
  if (!useNotif && !useChat) { alert(t('sa_bc_err_no_channel', "Kamida bitta yetkazish kanalini tanlang!")); return; }

  const selectedTag = window._bcSelectedTag || '';
  const selectedBt = window._bcSelectedBusinessType || '';

  let targets, segLabel;
  if (selectedTag) {
    targets = window.getBroadcastByTagRestaurants(selectedTag);
    const cfg = (window.TAG_CONFIG || {})[selectedTag];
    segLabel = cfg ? `${cfg.emoji} ${cfg.label}` : selectedTag;
  } else if (selectedBt) {
    targets = window.getBroadcastByBusinessTypeRestaurants(selectedBt);
    const btData = window.BUSINESS_TYPE_MODULES && window.BUSINESS_TYPE_MODULES[selectedBt];
    segLabel = btData ? (typeof btData.label === 'function' ? btData.label() : btData.label) : selectedBt;
  } else {
    alert(t('sa_bc_err_no_segment', "Iltimos, teg yoki biznes turini tanlang!"));
    return;
  }

  if (!targets.length) { alert(t('sa_bc_err_no_targets', "Bu segment/tegda restoranlar topilmadi!")); return; }

  const confirmText = document.getElementById('bcConfirmText');
  if (confirmText) {
    confirmText.textContent = t('sa_bc_confirm_body', '"{seg}" segmentidagi {count} restorangа xabar yuboriladi. Davom etilsinmi?')
      .replace('{seg}', segLabel)
      .replace('{count}', targets.length);
  }

  const modal = document.getElementById('broadcastConfirmModal');
  if (modal) modal.style.display = 'flex';
};

window.closeBroadcastConfirm = function () {
  const modal = document.getElementById('broadcastConfirmModal');
  if (modal) modal.style.display = 'none';
};

window.sendBroadcastMessage = async function () {
  const text = document.getElementById('bcMessageText')?.value.trim() || '';
  const useNotif = !!document.getElementById('bcChannelNotif')?.checked;
  const useChat = !!document.getElementById('bcChannelChat')?.checked;
  const useSms = !!document.getElementById('bcChannelSms')?.checked; // hozircha disabled, kelajak uchun
  const selectedTag = window._bcSelectedTag || '';
  const selectedBt = window._bcSelectedBusinessType || '';
  let targets;
  if (selectedTag) targets = window.getBroadcastByTagRestaurants(selectedTag);
  else if (selectedBt) targets = window.getBroadcastByBusinessTypeRestaurants(selectedBt);
  else targets = [];

  if (!text || !targets.length) { window.closeBroadcastConfirm(); return; }

  const btn = document.getElementById('bcConfirmSendBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t('sa_bc_sending', 'Yuborilmoqda...')}`; }

  const database = window.db;
  const now = Date.now();

  try {
    const writes = [];
    targets.forEach(({ id }) => {
      if (useNotif) {
        writes.push(push(ref(database, `restaurants/${id}/notifications`), {
          title: t('sa_notification_title', "Tizim Egasi (Superadmin)"),
          message: text,
          type: "superadmin_broadcast",
          date: now,
          isRead: false
        }));
      }
      if (useChat) {
        writes.push(push(ref(database, `restaurants/${id}/superadmin_chat`), {
          sender: "superadmin",
          text: text,
          timestamp: now
        }));
      }
    });

    await Promise.all(writes);

    let finalSegLabel, finalSegKey, segIconOverride = '';
    if (selectedTag) {
      const cfg = (window.TAG_CONFIG || {})[selectedTag];
      finalSegLabel = cfg ? `${cfg.emoji} ${cfg.label}` : selectedTag;
      finalSegKey = 'tag:' + selectedTag;
      segIconOverride = cfg ? cfg.emoji : '🏷️';
    } else {
      const btData = window.BUSINESS_TYPE_MODULES && window.BUSINESS_TYPE_MODULES[selectedBt];
      finalSegLabel = btData ? (typeof btData.label === 'function' ? btData.label() : btData.label) : selectedBt;
      finalSegKey = 'bt:' + selectedBt;
      segIconOverride = '🏬';
    }

    await _saMarketingFetch('/broadcast-history', {
      method: 'POST',
      body: JSON.stringify({
        text: text,
        segment: finalSegKey,
        segmentLabel: finalSegLabel,
        segmentIcon: segIconOverride,
        recipientCount: targets.length,
        channels: { notif: useNotif, chat: useChat, sms: useSms },
      }),
    });

    window.logAudit && window.logAudit("broadcast", finalSegLabel, `${t('sa_bc_log_sent', "Ommaviy xabar yuborildi")} (${targets.length} ${t('sa_task_log_to_rest', "ta restoranga")}): "${text.length > 60 ? text.slice(0, 60) + '…' : text}"`);

    window.closeBroadcastConfirm();
    document.getElementById('bcMessageText').value = '';
    alert(t('sa_bc_success', "✅ Xabar {count} restorangа muvaffaqiyatli yuborildi!").replace('{count}', targets.length));

  } catch (err) {
    alert(t('sa_error_prefix', 'Xatolik: ') + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `<span data-i18n="sa_bc_confirm_send_btn">${t('sa_bc_confirm_send_btn', 'Ha, yuborish')}</span>`; }
  }
};

// Superadmin systemData migration, Stage 2: systemData/broadcastHistory is
// no longer client-readable directly — polled from
// backend/routes/superadminMarketing.js instead. Note: the actual message
// fan-out (writes to restaurants/{id}/notifications and
// restaurants/{id}/superadmin_chat, just above in sendBroadcastMessage) is
// NOT under systemData and stays a direct client write, unchanged.
window.listenBroadcastHistory = function () {
  _saStartMarketingPoll('/broadcast-history', (data) => {
    window.allBroadcastHistory = data && Object.keys(data).length ? data : {};
    if (typeof window.renderBroadcastHistory === "function") window.renderBroadcastHistory();
  });
};

window.renderBroadcastHistory = function () {
  const container = document.getElementById('bcHistoryContainer');
  if (!container) return;

  const entries = Object.entries(window.allBroadcastHistory || {});
  if (!entries.length) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:#9ca3af;">${t('sa_bc_history_empty', "Hozircha yuborilgan xabarlar yo'q")}</div>`;
    return;
  }

  entries.sort((a, b) => (b[1].date || 0) - (a[1].date || 0));

  const segIcons = { all: '📣', pro: '🟢', start: '⚪', premium: '🟣', trial: '🎁', inactive: '😴' };

  container.innerHTML = entries.map(([id, b]) => {
    const safeText = typeof escapeHtml === 'function' ? escapeHtml(b.text || '') : (b.text || '');
    const channels = [];
    if (b.channels?.notif) channels.push('🔔');
    if (b.channels?.chat) channels.push('💬');
    if (b.channels?.sms) channels.push('📱');

    return `
      <div style="padding:14px 20px; border-bottom:1px solid #f1f5f9;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:6px;">
          <span style="font-size:12px; font-weight:700; color:#1d4ed8; background:#eff6ff; padding:3px 9px; border-radius:8px;">
            ${b.segmentIcon || segIcons[b.segment] || '📣'} ${b.segmentLabel || b.segment}
          </span>
          <span style="font-size:11px; color:#9ca3af; white-space:nowrap;">${b.date ? new Date(b.date).toLocaleString('ru-RU') : ''}</span>
        </div>
        <div style="font-size:13.5px; color:#111827; line-height:1.5; margin-bottom:6px; white-space:pre-wrap;">${safeText}</div>
        <div style="font-size:11.5px; color:#6b7280;">
          <i class="fa-solid fa-users"></i> ${b.recipientCount || 0} ${t('sa_bc_rest_short', "restoranga")} · ${channels.join(' ')}
        </div>
      </div>`;
  }).join('');
};

window.listenSystemSettings = function () {
  _saStartSettingsPoll('/tariffs', (data) => {
    if (data) {
      window.allTariffs = data;
      console.log(t("sa_log_tariffs_updated_live", "✅ Tariflar bazadan jonli yangilandi:"), window.allTariffs);
    } else {
      window.allTariffs = {
        start: { name: "START", price: 150000, trialDays: 0, oneTimeFee: 4900000, oneTimeActive: true, features: ['kds'] },
        pro: { name: "PRO", price: 350000, trialDays: 0, oneTimeFee: 9900000, oneTimeActive: true, features: ['inventory', 'reservations'] },
        premium: { name: "PREMIUM", price: 700000, trialDays: 0, oneTimeFee: 19900000, oneTimeActive: true, features: ['qr_menu', 'kds', 'promo', 'inventory', 'reservations'] }
      };
    }

    // Sinov kunlari inputlarini yangilash
    ['start', 'pro', 'premium'].forEach(tKey => {
      const trialInput = document.getElementById(`trialDays${tKey.charAt(0).toUpperCase() + tKey.slice(1)}`);
      if (trialInput) trialInput.value = window.allTariffs[tKey]?.trialDays || 0;
    });

    if (typeof window.renderSystemSettingsUI === "function") window.renderSystemSettingsUI();

    // Repeated-console-log fix — qarang: listenRestaurants() yonidagi izoh.
    // Bu /tariffs pollerining o'z callbacki, /restaurants pollerining
    // callbacki bilan MUSTAQIL ravishda ~30s'da bir marta fire bo'ladi —
    // ikkalasi ham updateDashboardStats()ni chaqirgani uchun debounce
    // bilan bittaga birlashtiriladi.
    _saScheduleDashboardStats();

    if (typeof window.renderRestaurantsTable === "function") window.renderRestaurantsTable();

    const billingModal = document.getElementById("superBillingModal");
    if (billingModal && (billingModal.style.display === "flex" || billingModal.style.display === "block")) {
      if (typeof window.renderTariffCards === "function") {
        const currentTariff = window.selectedTariffKey || "pro";
        window.renderTariffCards(currentTariff);
      }
    }
  });
};

// Oylik/Yillik narx ko'rsatish
window._pricingPeriod = 'monthly'; // default

window.setPricingPeriod = function (period) {
  window._pricingPeriod = period;
  const btnMonthly = document.getElementById('btn-monthly');
  const btnAnnual = document.getElementById('btn-annual');
  if (btnMonthly) btnMonthly.classList.toggle('active', period === 'monthly');
  if (btnAnnual) btnAnnual.classList.toggle('active', period === 'annual');
  window.renderSystemSettingsUI();
};

window.renderSystemSettingsUI = function () {
  const period = window._pricingPeriod || 'monthly';
  const isAnnual = period === 'annual';
  const DISCOUNT = 0.80; // 20% chegirma

  if (!document.getElementById("fix-double-checkmarks")) {
    const style = document.createElement("style");
    style.id = "fix-double-checkmarks";
    style.innerHTML = `
      .price-features li::before { content: none !important; display: none !important; }
      .price-features li { padding-left: 0 !important; display: flex !important; align-items: center; gap: 8px; }
    `;
    document.head.appendChild(style);
  }

  const tariffs = window.allTariffs || {};

  ['start', 'pro', 'premium'].forEach(tKey => {
    const plan = tariffs[tKey] || { price: 0, features: [] };
    const prefix = tKey.charAt(0).toUpperCase() + tKey.slice(1);
    const basePrice = plan.price || 0;

    if (document.getElementById(`price${prefix}`)) {
      document.getElementById(`price${prefix}`).value = basePrice;
    }
    const trialInput = document.getElementById(`trialDays${prefix}`);
    if (trialInput) trialInput.value = plan.trialDays || 0;
    const oneTimeFeeInput = document.getElementById(`oneTimeFee${prefix}`);
    if (oneTimeFeeInput) oneTimeFeeInput.value = plan.oneTimeFee || 0;
    const oneTimeActiveInput = document.getElementById(`oneTimeActive${prefix}`);
    if (oneTimeActiveInput) oneTimeActiveInput.checked = !!plan.oneTimeActive;
    if (document.getElementById(`f_${tKey}_qr`)) {
      document.getElementById(`f_${tKey}_qr`).checked = (plan.features || []).includes("qr_menu");
    }
    if (document.getElementById(`f_${tKey}_kds`)) {
      document.getElementById(`f_${tKey}_kds`).checked = (plan.features || []).includes("kds");
    }
    if (document.getElementById(`f_${tKey}_promo`)) {
      document.getElementById(`f_${tKey}_promo`).checked = (plan.features || []).includes("promo");
    }
    if (document.getElementById(`f_${tKey}_finance`)) {
      document.getElementById(`f_${tKey}_finance`).checked = (plan.features || []).includes("finance");
    }
    if (document.getElementById(`f_${tKey}_inventory`)) {
      document.getElementById(`f_${tKey}_inventory`).checked = (plan.features || []).includes("inventory");
    }
    if (document.getElementById(`f_${tKey}_reservations`)) {
      document.getElementById(`f_${tKey}_reservations`).checked = (plan.features || []).includes("reservations");
    }

    // Limitlarni sozlamalar formasiga to'ldirish (0 yoki bo'sh qiymat → input bo'sh qoladi, placeholder "∞" ko'rinadi)
    const limits = plan.limits || {};
    const fillLimitInput = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = (val === undefined || val === null || Number(val) <= 0) ? "" : val;
    };
    fillLimitInput(`limitBranches${prefix}`, limits.maxBranches);
    fillLimitInput(`limitAdmins${prefix}`, limits.maxAdmins);
    fillLimitInput(`limitStaff${prefix}`, limits.maxStaff);
    fillLimitInput(`limitChefs${prefix}`, limits.maxChefs);
    fillLimitInput(`limitTables${prefix}`, limits.maxTables);
    fillLimitInput(`limitProducts${prefix}`, limits.maxProducts);

    // Agar HTML formada limitChefs input mavjud bo'lmasa — limitStaff yonida dinamik yaratamiz
    window.ensureChefLimitInput && window.ensureChefLimitInput(prefix, limits.maxChefs);

    // Narxni hisoblash (oylik yoki yillik chegirma bilan)
    const displayedPrice = isAnnual ? Math.round(basePrice * DISCOUNT) : basePrice;
    const annualTotal = basePrice * 12;
    const annualDiscounted = Math.round(annualTotal * DISCOUNT);
    const saving = annualTotal - annualDiscounted;

    const displayPrice = document.getElementById(`display-price-${tKey}`);
    if (displayPrice) {
      displayPrice.textContent = displayedPrice.toLocaleString('ru-RU');
    }

    const periodLabel = document.getElementById(`period-label-${tKey}`);
    if (periodLabel) {
      periodLabel.textContent = isAnnual ? t("sa_period_annual", "oyiga / 1 yillik to'lov") : t("sa_period_monthly", "oyiga / 1 oylik to'lov");
    }

    const savingEl = document.getElementById(`saving-${tKey}`);
    if (savingEl) {
      if (isAnnual) {
        savingEl.textContent = t("sa_saving_annual", "Yilga {amount} UZS tejaysiz").replace("{amount}", saving.toLocaleString('ru-RU'));
        savingEl.style.display = 'inline-block';
      } else {
        savingEl.style.display = 'none';
      }
    }

    const compPrice = document.getElementById(`comp-price-${tKey}`);
    if (compPrice) {
      compPrice.textContent = t("sa_comp_price_per_month", "{price} so'm/oy").replace("{price}", displayedPrice.toLocaleString('ru-RU'));
    }

    const ul = document.getElementById(`list-${tKey}`);
    if (ul) {
      const limits = plan.limits || {};
      const fmtLimit = (val, unlimitedText) => {
        const n = Number(val);
        return (val === undefined || val === null || val === "" || n <= 0)
          ? unlimitedText
          : n.toLocaleString('ru-RU');
      };
      const limitRows = [
        { value: fmtLimit(limits.maxBranches, t("sa_limit_unlimited", "Cheksiz")), label: t("sa_limit_branches_short", "filial") },
        { value: fmtLimit(limits.maxAdmins, t("sa_limit_unlimited", "Cheksiz")), label: t("sa_limit_admins_short", "admin") },
        { value: fmtLimit(limits.maxStaff, t("sa_limit_unlimited", "Cheksiz")), label: t("sa_limit_staff_short", "xodim") },
        { value: fmtLimit(limits.maxChefs, t("sa_limit_unlimited", "Cheksiz")), label: t("sa_limit_chefs_short", "oshpaz") },
        { value: fmtLimit(limits.maxTables, t("sa_limit_unlimited", "Cheksiz")), label: t("sa_limit_tables_short", "stol") },
        { value: fmtLimit(limits.maxProducts, t("sa_limit_unlimited", "Cheksiz")), label: t("sa_limit_products_short", "mahsulot") }
      ];

      ul.innerHTML = limitRows.map(r => `
        <li style="font-weight:600;"><i class="fa-solid fa-check" style="color:#10b981;"></i> <span>${r.value} ${r.label}</span></li>
      `).join('') + `
        <li><i class="fa-solid fa-check" style="color:#10b981;"></i> <span>${t("sa_feat_pos", "Kassa va Ofitsiant paneli")}</span></li>
        <li><i class="fa-solid fa-check" style="color:#10b981;"></i> <span>${t("sa_feat_admin", "Tizimda 1 ta Admin profil")}</span></li>
      `;

      const feats = [
        { id: 'qr_menu', n: t("feat_qr", "QR-Menyu va Self-service") },
        { id: 'kds', n: t("feat_kds", "Oshpaz ekrani (KDS)") },
        { id: 'promo', n: t("feat_promo", "Promokod / Keshbek") },
        { id: 'finance', n: t("feat_finance", "Moliya hisobotlari") },
        { id: 'inventory', n: t("feat_inventory", "Ombor / Inventarizatsiya") },
        { id: 'reservations', n: t("feat_reservations", "Bron tizimi") }
      ];

      feats.forEach(f => {
        const has = (plan.features || []).includes(f.id);
        if (has) {
          ul.innerHTML += `<li><i class="fa-solid fa-check" style="color:#10b981;"></i> <span>${f.n}</span></li>`;
        } else {
          ul.innerHTML += `<li style="opacity:0.5;"><i class="fa-solid fa-xmark" style="color:#ef4444;"></i> <span style="text-decoration:line-through;">${f.n}</span></li>`;
        }
      });
    }
  });
};

// Yagona "restoran faolmi?" aniqlovchisi — Dashboard'ning tepadagi 3 ta KPI
// kartasi ("Jami restoranlar"/"To'lov muddati tugagan") va pastdagi Faol/
// Passiv reyting (calculateActivityScore) ikkalasi ham AYNAN shu funksiyani
// ishlatadi. Yangi/parallel status maydoni YO'Q — mavjud haqiqiy fieldlar:
// subscription.expireAt (obuna muddati) va info.status (masalan "blocked")
// — bu ikkalasi ham allaqachon updateDashboardStats() da ishlatilgan,
// tekshirilgan, ishlab turgan mezon edi; bu yerga faqat qayta ishlatish
// uchun ko'chirildi, mantiqiy o'zgarish yo'q.
function isRestaurantActive(rest) {
  const info = rest?.info || {};
  const sub = rest?.subscription || {};
  const expireAt = Number(sub.expireAt || 0);
  return expireAt > Date.now() && info.status !== "blocked";
}
window.isRestaurantActive = isRestaurantActive;

function updateDashboardStats() {
  let total = 0, active = 0, expired = 0, expectedRevenue = 0;

  let salesCount = {};
  Object.keys(window.allTariffs || {}).forEach(k => salesCount[k.toLowerCase()] = 0);

  Object.values(window.allRestaurants || {}).forEach(rest => {
    total++;
    const info = rest.info || {};

    const tariffKey = (info.tariff || "pro").toLowerCase();

    if (salesCount.hasOwnProperty(tariffKey)) {
      salesCount[tariffKey]++;
    } else {
      salesCount[tariffKey] = (salesCount[tariffKey] || 0) + 1;
    }

    if (isRestaurantActive(rest)) {
      active++;
      const tariffPrice = window.allTariffs[tariffKey]?.price || 0;
      expectedRevenue += Number(tariffPrice);
    } else {
      expired++;
    }
  });

  if (typeof window.__canonicalRestaurantCount === "number" && Number.isFinite(window.__canonicalRestaurantCount)) {
    total = window.__canonicalRestaurantCount;
  }

  if (document.getElementById("totalRestaurants")) document.getElementById("totalRestaurants").innerText = total;
  if (document.getElementById("activeRestaurants")) document.getElementById("activeRestaurants").innerText = active;
  if (document.getElementById("expiredRestaurants")) document.getElementById("expiredRestaurants").innerText = expired;

  // Revenue-filter-modal flicker fix: this write is a DIFFERENT metric
  // (sum of active subscriptions' tariff prices) than what
  // updateRevenueByFilter()/setRevenueQuickFilter() show in the same
  // element (actual filtered received payments). Both used to race this
  // one node — fired every 30s from the restaurants poll, colliding with
  // whatever the user had just set in the open modal. While the modal
  // owns this display (open), defer to it; this fires again the moment
  // the modal closes via the next poll tick or any explicit refresh.
  const revDisplay = document.getElementById("totalRevenueDisplay");
  const _revModalOpen = document.getElementById("revenueFilterMenu")?.style.display === "block";
  if (revDisplay && !_revModalOpen) revDisplay.innerText = expectedRevenue.toLocaleString('ru-RU') + " " + t("sa_currency_uzs", "so'm");

  const taText = typeof t === 'function' ? t("sa_piece", "ta") : "ta";

  Object.keys(salesCount).forEach(tKey => {
    const badgeId = `badge-sales-${tKey}`;
    const badgeElement = document.getElementById(badgeId);

    if (badgeElement) {
      const count = salesCount[tKey];
      if (tKey === 'pro') {
        badgeElement.innerHTML = `🔥 ${t("sa_badge_most_sold", "Eng ko'p sotilgan:")} ${count} ${taText}`;
      } else {
        badgeElement.innerHTML = `${t("sa_badge_clients", "Mijozlar:")} ${count} ${taText}`;
      }
    }
  });

  console.log(t("sa_log_total_rests", "📊 Umumiy restoranlar:"), total, "| " + t("sa_log_by_tariffs", "Tariflar kesimida:"), salesCount);

  updateTodayStats();
}

// ============================================
// BUGUNGI STATISTIKA (Yangi restoran / foydalanuvchi / buyurtma / aylanma)
// ============================================
function updateTodayStats() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;

  const isToday = (ts) => {
    const n = Number(ts || 0);
    return n >= todayStart && n < todayEnd;
  };

  // To'langan hisoblanadigan statuslar (aylanmaga kiradi)
  const PAID_STATUSES = new Set(["paid", "closed", "to'landi", "yopildi"]);

  let newRestaurants = 0;
  let newUsers = 0;
  let ordersToday = 0;
  let turnoverToday = 0;

  Object.values(window.allRestaurants || {}).forEach(rest => {
    if (!rest || typeof rest !== "object") return;

    // 1. Bugun qo'shilgan restoranlar
    const info = rest.info || {};
    if (isToday(info.createdAt)) {
      newRestaurants++;
    }

    // 2. Bugun qo'shilgan xodimlar (users/)
    const users = rest.users || {};
    Object.values(users).forEach(u => {
      if (u && isToday(u.createdAt)) newUsers++;
    });

    // 3. Bugungi buyurtmalar va aylanma (orders/)
    const orders = rest.orders || {};
    Object.values(orders).forEach(o => {
      if (!o || !isToday(o.createdAt)) return;

      ordersToday++;

      const rawStatus = String(o.statusKey || o.status || "").trim().toLowerCase();
      if (PAID_STATUSES.has(rawStatus)) {
        turnoverToday += Number(o.total || 0);
      }
    });
  });

  if (document.getElementById("todayNewRestaurants")) {
    document.getElementById("todayNewRestaurants").innerText = newRestaurants;
  }
  if (document.getElementById("todayNewUsers")) {
    document.getElementById("todayNewUsers").innerText = newUsers;
  }
  if (document.getElementById("todayOrdersCount")) {
    document.getElementById("todayOrdersCount").innerText = ordersToday.toLocaleString('ru-RU');
  }
  if (document.getElementById("todayTurnover")) {
    document.getElementById("todayTurnover").innerText =
      formatCompactUzs(turnoverToday);
  }

  console.log(
    t("sa_log_today_stats", "📅 Bugungi statistika:"),
    { newRestaurants, newUsers, ordersToday, turnoverToday }
  );
}

// "280 mln" kabi qisqartirilgan UZS formatini chiqaradi (katta sonlar uchun),
// kichik summalarda to'liq raqamni ko'rsatadi.
function formatCompactUzs(amount) {
  const n = Number(amount || 0);
  if (n >= 1_000_000_000) {
    return (n / 1_000_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + " " + t("sa_unit_bln", "mlrd");
  }
  if (n >= 1_000_000) {
    return (n / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + " " + t("sa_unit_mln", "mln");
  }
  return n.toLocaleString('ru-RU');
}

window.selectedTariffKey = null;

window.openSuperBillingModal = function (restId, restName) {
  console.log(t("sa_log_billing_modal_opening", "📂 Billing modal ochilmoqda:"), restId, restName);

  if (restId !== "dummy_id" && window.allRestaurants[restId]) {
    const rest = window.allRestaurants[restId];
    const expireAt = Number(rest.subscription?.expireAt || 0);
    const now = Date.now();
    const gracePeriodMs = 10 * 24 * 60 * 60 * 1000;

    if (!rest.subscription?.oneTimePaid && expireAt < now && (now - expireAt) > gracePeriodMs) {
      const confirmResetMsg = t("sa_confirm_reset_billing", "DIQQAT! {restName} restoranining to'lov muddati tugaganiga 10 kundan oshgan.\n\nQoidaga ko'ra, barcha eski ma'lumotlar (taomlar, ishchilar) o'chib ketadi va restoran noldan boshlanadi.\n\nShunga rozimisiz (Tozalab, yangi to'lov qilish)?")
        .replace("{restName}", restName)
        .replace("${restName}", restName);
      const confirmReset = confirm(confirmResetMsg);

      if (!confirmReset) {
        return;
      } else {
        window.pendingResetForRestId = restId;
      }
    } else {
      window.pendingResetForRestId = null;
    }
  }

  window.isCreatingNewRestaurant = (restId === "dummy_id");
  window.targetRestIdForBilling = restId;
  window.selectedSuperPlanMonths = 0;
  window.selectedTariffKey = null;
  window.currentPaymentMethod = null;
  window._activePromo = null;

  const modal = document.getElementById("superBillingModal");
  if (modal) modal.style.display = "flex";

  const nameDisplay = document.getElementById("targetRestNameText");
  if (nameDisplay) nameDisplay.innerText = restName || t("sa_unknown", "Noma'lum");

  const promoInput = document.getElementById("billingPromoInput");
  if (promoInput) promoInput.value = "";
  const promoMsg = document.getElementById("billingPromoMsg");
  if (promoMsg) { promoMsg.style.display = "none"; promoMsg.textContent = ""; }

  let initialTariff = "pro";
  if (window.pendingNewRestaurantData && window.pendingNewRestaurantData.tariff) {
    initialTariff = window.pendingNewRestaurantData.tariff;
  } else if (window.allRestaurants && window.allRestaurants[restId]) {
    initialTariff = window.allRestaurants[restId].info?.tariff || "pro";
  }

  if (typeof window.renderTariffCards === "function") {
    window.renderTariffCards(initialTariff);
  } else {
    console.error(t("sa_err_render_tariff_cards_not_found", "Xato: renderTariffCards funksiyasi topilmadi!"));
  }
};

window.renderTariffCards = function (activeTariffKey) {
  const container = document.getElementById("tariffCardsContainer");
  if (!container) return;
  container.innerHTML = "";

  activeTariffKey = activeTariffKey || window.selectedTariffKey || "pro";

  const tariffs = window.allTariffs && Object.keys(window.allTariffs).length > 0
    ? window.allTariffs
    : {
      start: { name: "START", price: 150000, trialDays: 0, oneTimeFee: 4900000, oneTimeActive: true, features: ['kds'] },
      pro: { name: "PRO", price: 350000, trialDays: 0, oneTimeFee: 9900000, oneTimeActive: true, features: ['inventory', 'reservations'] },
      premium: { name: "PREMIUM", price: 700000, trialDays: 0, oneTimeFee: 19900000, oneTimeActive: true, features: ['qr_menu', 'kds', 'promo', 'inventory', 'reservations'] }
    };

  Object.keys(tariffs).forEach(tKey => {
    const tariff = tariffs[tKey];
    const isActive = tKey.toLowerCase() === activeTariffKey.toLowerCase();
    const trialDays = tariff.trialDays || 0;

    if (isActive) window.selectedTariffKey = tKey;

    const card = document.createElement("div");
    card.style.cssText = `
      border: ${isActive ? '2px solid #10b981' : '1px solid #e5e7eb'};
      background: ${isActive ? '#f0fdf4' : '#ffffff'};
      padding: 12px 10px;
      border-radius: 8px;
      text-align: center;
      cursor: pointer;
      transition: 0.2s;
      position: relative;
    `;

    card.innerHTML = `
      ${trialDays > 0 ? `<div style="position:absolute; top:-9px; left:50%; transform:translateX(-50%); background:#f59e0b; color:#fff; font-size:10px; padding:2px 8px; border-radius:10px; font-weight:bold; white-space:nowrap;">🎁 ${trialDays} ${t("sa_clock_trial_days","kun sinov")}</div>` : ''}
      <div style="font-weight: 700; color: #374151; font-size: 14px; margin-top:${trialDays > 0 ? '6px' : '0'};">${tariff.name || tKey.toUpperCase()}</div>
      <div style="font-size: 12px; color: #6b7280; margin-top: 5px;">${(tariff.price || 0).toLocaleString()} ${t("sa_currency_uzs", "so'm")}</div>
      ${tariff.oneTimeActive && tariff.oneTimeFee ? `<div style="font-size:11px; color:#d97706; margin-top:4px;">🔑 ${(tariff.oneTimeFee).toLocaleString()} ${t("sa_currency_uzs", "so'm")}</div>` : ''}
    `;

    card.onclick = () => {
      window.renderTariffCards(tKey);
    };

    container.appendChild(card);
  });

  if (typeof window.calculateAndDisplayPrices === "function") {
    window.calculateAndDisplayPrices(window.selectedTariffKey);
  }

  // 1 martalik to'lov card ni yangilash
  if (typeof window.renderOneTimeFeeCard === "function") {
    window.renderOneTimeFeeCard(window.selectedTariffKey);
  }

  window.selectedSuperPlanMonths = 0;

  const methods = document.getElementById("superPaymentMethods");
  if (methods) methods.style.display = "none";

  const form = document.getElementById("cardDetailsForm");
  if (form) form.style.display = "none";

  const payBtn = document.getElementById("modalPayBtn");
  if (payBtn) {
    payBtn.disabled = true;
    payBtn.style.opacity = "0.5";
    payBtn.innerHTML = `<i class="fa-solid fa-credit-card"></i> ${t("sa_pay_btn", "TO'LASH")}`;
  }
};

window.calculateAndDisplayPrices = function (tariffKey) {
  const tKeyLower = tariffKey?.toLowerCase();
  const basePrice = Number(window.subscriptionPlans?.[1]?.price) || window.allTariffs[tKeyLower]?.price || 350000;
  const trialDays = window.allTariffs[tKeyLower]?.trialDays || 0;
  const container = document.querySelector("#superBillingModal .pricing-plans");
  window.currentCalculatedAmounts = {};

  if (container && window.subscriptionPlans) {
    container.innerHTML = "";

    // Sinov muddati kartasi (agar trialDays > 0 bo'lsa va restoran hali sinovdan foydalanmagan bo'lsa)
    const targetRest = window.targetRestIdForBilling ? window.allRestaurants?.[window.targetRestIdForBilling] : null;
    const trialAlreadyUsed = !window.isCreatingNewRestaurant && !!targetRest?.info?.trialUsed;

    if (trialDays > 0 && trialAlreadyUsed) {
      const trialUsedCard = document.createElement("div");
      trialUsedCard.className = "plan-card";
      trialUsedCard.id = "plan-trial";
      trialUsedCard.style.cssText = `
        flex: 1;
        border: 1px dashed #d1d5db;
        background: #f9fafb;
        padding: 15px 10px;
        border-radius: 8px;
        text-align: center;
        cursor: not-allowed;
        position: relative;
        margin-top: 10px;
        opacity: 0.6;
      `;
      trialUsedCard.innerHTML = `
        <div style="font-weight: 700; color: #9ca3af; font-size: 14px; margin-bottom: 5px;">🚫 ${t("sa_trial_days_label", "kunlik sinov")}</div>
        <div style="font-size: 12px; color: #9ca3af; font-weight: 600;">${t("sa_trial_already_used_label", "Sinov muddati ishlatilgan")}</div>
      `;
      container.appendChild(trialUsedCard);
    } else if (trialDays > 0) {
      const trialCard = document.createElement("div");
      trialCard.className = "plan-card";
      trialCard.id = "plan-trial";
      trialCard.onclick = () => window.selectTrialPlan();
      trialCard.style.cssText = `
        flex: 1;
        border: 1px solid #f59e0b;
        background: #fffbeb;
        padding: 15px 10px;
        border-radius: 8px;
        text-align: center;
        cursor: pointer;
        transition: 0.2s;
        position: relative;
        margin-top: 10px;
      `;
      trialCard.innerHTML = `
        <div style="position:absolute; top:-10px; left:50%; transform:translateX(-50%); background:#f59e0b; color:#fff; font-size:10px; padding:3px 8px; border-radius:10px; font-weight:bold; white-space:nowrap;">${t("sa_trial_card_badge","🎁 BEPUL")}</div>
        <div style="font-weight: 700; color: #92400e; font-size: 14px; margin-bottom: 5px;">${trialDays} ${t("sa_trial_days_label", "kunlik sinov")}</div>
        <div style="font-size: 13px; color: #d97706; font-weight: 700;">${t("sa_trial_free", "Bepul sinov")}</div>
      `;
      container.appendChild(trialCard);
    }

    const monthLabels = {
      1: t("sa_1_month", "1 oy"),
      3: t("sa_3_months", "3 oy"),
      6: t("sa_6_months", "6 oy"),
      12: t("sa_1_year", "1 yil")
    };

    Object.entries(window.subscriptionPlans).forEach(([key, data]) => {
      if (!data.active) return;

      const isLifetime = key === "lifetime";
      const months = isLifetime ? null : Number(key);

      // Cheksiz litsenziya uchun narx = 1 oylik narx × koeffitsient (masalan, 12 oy)
      const totalPrice = isLifetime
        ? Math.round(basePrice * Number(data.coefficient || 12))
        : Math.round((basePrice * months) * (1 - (data.discount || 0) / 100));

      window.currentCalculatedAmounts[key] = totalPrice;

      const promoPct = window._activePromo?.discount || 0;
      const promoPrice = promoPct ? Math.round(totalPrice * (1 - promoPct / 100)) : totalPrice;

      const planCard = document.createElement("div");
      planCard.className = "plan-card";
      planCard.id = `plan-${key}`;

      planCard.onclick = () => window.selectSuperPlan(key);

      planCard.style.cssText = `
        flex: 1;
        border: 1px solid ${isLifetime ? '#a855f7' : '#e5e7eb'};
        background: ${isLifetime ? '#faf5ff' : '#ffffff'};
        padding: 15px 10px;
        border-radius: 8px;
        text-align: center;
        cursor: pointer;
        transition: 0.2s;
        position: relative;
        margin-top: 10px;
      `;

      planCard.innerHTML = `
        ${!isLifetime && data.discount > 0 ? `<div style="position:absolute; top:-10px; left:50%; transform:translateX(-50%); background:#3b82f6; color:white; font-size:10px; padding:3px 8px; border-radius:10px; font-weight:bold; white-space:nowrap;">-${data.discount}% ${t("sa_discount_badge", "CHEGIRMA")}</div>` : ''}
        ${isLifetime ? `<div style="position:absolute; top:-10px; left:50%; transform:translateX(-50%); background:#a855f7; color:white; font-size:10px; padding:3px 8px; border-radius:10px; font-weight:bold; white-space:nowrap;">♾️ ${t("sa_lifetime_badge", "MUDDATSIZ")}</div>` : ''}
        <div style="font-weight: 700; color: #374151; font-size: 14px; margin-bottom: 5px;">
          ${isLifetime ? t("sa_lifetime_label", "Cheksiz litsenziya") : monthLabels[months]}
        </div>
        ${promoPct ? `<div style="font-size:11px; color:#9ca3af; text-decoration:line-through;">${totalPrice.toLocaleString()} ${t("sa_currency_uzs", "so'm")}</div>` : ''}
        <div style="font-size: 13px; color: ${promoPct ? '#dc2626' : (isLifetime ? '#9333ea' : '#10b981')}; font-weight: 700;">
          ${promoPrice.toLocaleString()} ${t("sa_currency_uzs", "so'm")} ${promoPct ? `<span style="font-size:10px; background:#fee2e2; color:#dc2626; padding:1px 5px; border-radius:6px;">🎟️ -${promoPct}%</span>` : ''}
        </div>
      `;

      container.appendChild(planCard);
    });
  }
};

// ============================================
// BILLING OYNASIDA PROMO KOD QO'LLASH
// ============================================
window.applyPromoCodeToBilling = function () {
  const input = document.getElementById('billingPromoInput');
  const msgEl = document.getElementById('billingPromoMsg');
  const code = (input?.value || '').trim().toUpperCase();

  const showMsg = (text, ok) => {
    if (!msgEl) return;
    msgEl.style.display = 'block';
    msgEl.style.color = ok ? '#059669' : '#dc2626';
    msgEl.textContent = text;
  };

  if (!code) { showMsg(t('sa_pc_err_no_code', "Iltimos, promo kod nomini kiriting!"), false); return; }

  const now = Date.now();
  const entry = Object.entries(window.allPromoCodes || {}).find(
    ([id, p]) => (p.code || '').toUpperCase() === code
  );

  if (!entry) { window._activePromo = null; showMsg(t('sa_pc_err_not_found', "❌ Bunday promo kod topilmadi"), false); window.calculateAndDisplayPrices(window.selectedTariffKey); return; }

  const [promoId, promo] = entry;

  if (promo.active === false) { window._activePromo = null; showMsg(t('sa_pc_err_off', "❌ Bu promo kod o'chirilgan"), false); window.calculateAndDisplayPrices(window.selectedTariffKey); return; }
  if (promo.expireAt && promo.expireAt < now) { window._activePromo = null; showMsg(t('sa_pc_err_expired_apply', "❌ Bu promo kodning amal qilish muddati tugagan"), false); window.calculateAndDisplayPrices(window.selectedTariffKey); return; }
  if (promo.maxUses && (promo.usedCount || 0) >= promo.maxUses) { window._activePromo = null; showMsg(t('sa_pc_err_exhausted_apply', "❌ Bu promo kod limiti tugagan"), false); window.calculateAndDisplayPrices(window.selectedTariffKey); return; }

  window._activePromo = { id: promoId, code: promo.code, discount: promo.discount };
  showMsg(t('sa_pc_applied', "✅ {code} qo'llandi: -{pct}% chegirma!").replace('{code}', promo.code).replace('{pct}', promo.discount), true);

  // Narxlarni promo bilan qayta chizish
  window.calculateAndDisplayPrices(window.selectedTariffKey);

  // Agar muddat allaqachon tanlangan bo'lsa, tanlovni saqlab qolish (faqat ko'rinishni yangilash)
  if (window.selectedSuperPlanMonths) {
    const activeEl = document.getElementById(`plan-${window.selectedSuperPlanMonths}`);
    if (activeEl) {
      activeEl.classList.add('active');
      activeEl.style.border = '2px solid #10b981';
      activeEl.style.background = '#f0fdf4';
    }
  }
};

window.toggleCardForm = function (showForm, method) {
  window.currentPaymentMethod = method;
  const form = document.getElementById('cardDetailsForm');
  const payBtn = document.getElementById('modalPayBtn');

  if (window.paymentInterval) clearInterval(window.paymentInterval);

  if (form) form.style.display = showForm ? 'block' : 'none';
  if (!payBtn) return;

  // Plan yoki 1-martalik to'lov tanlangan bo'lsa tugmani yoqish mumkin
  const hasPlan = !!window.selectedSuperPlanMonths;
  const hasOnetime = !!window._oneTimeFeeSelected;
  const canEnableBtn = hasPlan || hasOnetime;

  if (showForm) {
    if (canEnableBtn) {
      payBtn.disabled = false;
      payBtn.style.opacity = "1";
      payBtn.style.cursor = "pointer";
      payBtn.innerHTML = `<i class="fa-solid fa-credit-card"></i> ${t("sa_pay_btn", "TO'LASH")} (${method})`;
    } else {
      // Karta formi ochildi lekin hali plan/onetime tanlanmagan — tugma yoqilmaydi
      payBtn.disabled = true;
      payBtn.style.opacity = "0.5";
      payBtn.style.cursor = "not-allowed";
      payBtn.innerHTML = `<i class="fa-solid fa-credit-card"></i> ${t("sa_pay_btn", "TO'LASH")} (${method})`;
    }
  } else if (method === t("sa_pay_cash", "Naqd pul") || method === "Naqd pul") {
    payBtn.disabled = true;
    payBtn.style.opacity = "0.5";
    payBtn.style.cursor = "not-allowed";

    let seconds = 5;

    payBtn.innerHTML = `<i class="fa-solid fa-clock"></i> ${seconds} ${t("sa_wait_seconds", "soniya kuting...")}`;

    window.paymentInterval = setInterval(() => {
      seconds--;
      if (seconds > 0) {
        payBtn.innerHTML = `<i class="fa-solid fa-clock"></i> ${seconds} ${t("sa_wait_seconds", "soniya kuting...")}`;
      } else {
        clearInterval(window.paymentInterval);
        if (canEnableBtn) {
          payBtn.disabled = false;
          payBtn.style.opacity = "1";
          payBtn.style.cursor = "pointer";
          payBtn.innerHTML = `<i class="fa-solid fa-money-bill-1-wave"></i> ${t("sa_pay_btn", "TO'LASH")} (${t("sa_cash_short", "Naqd")})`;
        }
      }
    }, 1000);
  }
};

async function loadRestaurantsOnce() {
  const snap = await get(ref(db, 'restaurants'));
  const data = snap.val() || {};
  renderRestaurants(data);
}

// ============================================
// 1 MARTALIK TO'LOV CARD FUNKSIYALARI
// ============================================

window._oneTimeFeeSelected = false;

window.renderOneTimeFeeCard = function (tariffKey) {
  const tKey = (tariffKey || 'pro').toLowerCase();
  const tariff = window.allTariffs?.[tKey] || {};
  const cardWrap = document.getElementById('oneTimeFeeCard');
  const amountEl = document.getElementById('oneTimeFeeAmount');
  const cardInner = document.getElementById('oneTimeFeeCardInner');

  // 1 martalik to'lovni reset qilish (tarif o'zgarganda)
  window._oneTimeFeeSelected = false;
  window._oneTimeLocked = false;
  // Barcha plan kartalarini unlock
  document.querySelectorAll('.plan-card').forEach(card => {
    card.style.opacity = '1';
    card.style.pointerEvents = 'auto';
  });
  if (cardInner) {
    cardInner.style.border = '2px dashed #e5e7eb';
    cardInner.style.background = '#fafafa';
  }
  const iconEl = document.getElementById('oneTimeFeeIcon');
  if (iconEl) {
    iconEl.style.background = '#f3f4f6';
    iconEl.style.border = '2px solid #d1d5db';
    iconEl.innerHTML = '🔑';
  }

  if (!cardWrap) return;

  if (tariff.oneTimeActive && tariff.oneTimeFee) {
    if (amountEl) amountEl.textContent = (tariff.oneTimeFee).toLocaleString('ru-RU');
    cardWrap.style.display = 'block';
  } else {
    cardWrap.style.display = 'none';
    window._oneTimeFeeSelected = false;
  }
};

window.toggleOneTimeFee = function () {
  // Sinov tanlangan bo'lsa — 1-martalik bloklanishi kerak, klik qilish ta'sir qilmasin
  if (window._oneTimeLocked) return;

  window._oneTimeFeeSelected = !window._oneTimeFeeSelected;
  const cardInner = document.getElementById('oneTimeFeeCardInner');
  const iconEl = document.getElementById('oneTimeFeeIcon');

  if (window._oneTimeFeeSelected) {
    // 1-martalik tanlanganda — sinov kartasini va oylik/yillik kartalarni lock
    document.querySelectorAll('.plan-card').forEach(card => {
      if (!card.classList.contains('active')) {
        card.style.opacity = '0.35';
        card.style.pointerEvents = 'none';
      }
    });
    // Sinov kartasini ham grey
    const trialCard = document.getElementById('plan-trial');
    if (trialCard && !trialCard.classList.contains('active')) {
      trialCard.style.opacity = '0.35';
      trialCard.style.pointerEvents = 'none';
    }

    if (cardInner) {
      cardInner.style.border = '2px solid #10b981';
      cardInner.style.background = '#f0fdf4';
      cardInner.style.opacity = '1';
      cardInner.style.filter = '';
    }
    if (iconEl) {
      iconEl.style.background = '#10b981';
      iconEl.style.border = '2px solid #10b981';
      iconEl.innerHTML = '<i class="fa-solid fa-check" style="color:white; font-size:14px;"></i>';
    }

    // Payment methods ko'rsatish
    const methodsBlock = document.getElementById('superPaymentMethods');
    if (methodsBlock) {
      methodsBlock.style.setProperty('display', 'grid', 'important');
      methodsBlock.style.visibility = 'visible';
      methodsBlock.style.opacity = '1';
    }

    // Agar to'lov usuli allaqachon tanlangan bo'lsa — tugmani yoq
    if (window.currentPaymentMethod && window.currentPaymentMethod !== '__TRIAL__') {
      const payBtn = document.getElementById('modalPayBtn');
      if (payBtn) {
        payBtn.disabled = false;
        payBtn.style.opacity = '1';
        payBtn.style.cursor = 'pointer';
        const isCard = ['Click', 'Payme'].includes(window.currentPaymentMethod);
        const icon = isCard ? 'fa-credit-card' : 'fa-money-bill-1-wave';
        const label = isCard ? window.currentPaymentMethod : t('sa_cash_short', 'Naqd');
        payBtn.innerHTML = `<i class="fa-solid ${icon}"></i> ${t('sa_pay_btn', "TO'LASH")} (${label})`;
      }
    }
  } else {
    // 1-martalik bekor qilindi — barcha kartalarni unlock
    document.querySelectorAll('.plan-card').forEach(card => {
      card.style.opacity = '1';
      card.style.pointerEvents = 'auto';
    });

    if (cardInner) {
      cardInner.style.border = '2px dashed #e5e7eb';
      cardInner.style.background = '#fafafa';
    }
    if (iconEl) {
      iconEl.style.background = '#f3f4f6';
      iconEl.style.border = '2px solid #d1d5db';
      iconEl.innerHTML = '🔑';
    }

    // Agar plan ham tanlanmagan bo'lsa — tugmani o'chirish
    if (!window.selectedSuperPlanMonths) {
      const payBtn = document.getElementById('modalPayBtn');
      if (payBtn) {
        payBtn.disabled = true;
        payBtn.style.opacity = '0.5';
        payBtn.style.cursor = 'not-allowed';
        payBtn.innerHTML = `<i class="fa-solid fa-credit-card"></i> ${t('sa_pay_btn', "TO'LASH")}`;
      }
    }
  }
};

window.closeSuperBillingModal = function () {
  document.getElementById("superBillingModal").style.display = "none";
  window.pendingNewRestaurantData = null;
  window._oneTimeFeeSelected = false;
  window._oneTimeLocked = false;
  window._activePromo = null;
  // Barcha kartalarni unlock qilish
  document.querySelectorAll('.plan-card').forEach(card => {
    card.style.opacity = '1';
    card.style.pointerEvents = 'auto';
  });
  const cardInnerOT = document.getElementById('oneTimeFeeCardInner');
  if (cardInnerOT) {
    cardInnerOT.style.opacity = '1';
    cardInnerOT.style.pointerEvents = 'auto';
    cardInnerOT.style.filter = '';
  }
  const cardWrapOT = document.getElementById('oneTimeFeeCard');
  if (cardWrapOT) cardWrapOT.style.opacity = '1';
};

window.processSimulatedPayment = async function () {
  const method = window.currentPaymentMethod;
  const planMonths = window.selectedSuperPlanMonths;
  const isNew = window.isCreatingNewRestaurant;
  const newRestData = window.pendingNewRestaurantData;
  const isTrial = window.currentPaymentMethod === '__TRIAL__';

  const oneTimeFeeOnlyMode = !planMonths && window._oneTimeFeeSelected;
  if (!planMonths && !isTrial && !oneTimeFeeOnlyMode) return alert(typeof t === 'function' ? t("sa_err_select_period", "Iltimos, muddatni tanlang!") : "Iltimos, muddatni tanlang!");
  if (!method) return alert(typeof t === 'function' ? t("sa_err_select_payment", "Iltimos, to'lov usulini tanlang!") : "Iltimos, to'lov usulini tanlang!");

  // Mavjud restoran sinov muddatini ikkinchi marta ishlatmasligi uchun tekshirish
  if (isTrial && !isNew) {
    const targetRest = window.allRestaurants?.[window.targetRestIdForBilling];
    if (targetRest?.info?.trialUsed) {
      alert(typeof t === 'function'
        ? t("sa_err_trial_already_used", "❌ Bu restoran bepul sinov muddatidan allaqachon foydalangan. Sinov muddatini qayta berish uchun \"Muddati tugayotganlar\" sahifasidagi Trial bo'limidan foydalaning.")
        : "❌ Bu restoran bepul sinov muddatidan allaqachon foydalangan.");
      return;
    }
  }

  try {
    const database = window.db;
    const now = Date.now();
    const activeTariff = window.selectedTariffKey || "pro";
    const trialDays = window.allTariffs[activeTariff.toLowerCase()]?.trialDays || 0;

    let msToAdd, amount;
    const oneTimeFeeActive = window._oneTimeFeeSelected;
    const oneTimeFeeValue = oneTimeFeeActive
      ? (window.allTariffs[activeTariff.toLowerCase()]?.oneTimeFee || 0)
      : 0;
    const activePromo = window._activePromo || null;

    const isLifetimePlan = planMonths === "lifetime";

    if (isTrial) {
      msToAdd = trialDays * 24 * 60 * 60 * 1000;
      amount = 0;
    } else if (isLifetimePlan) {
      msToAdd = null; // cheksiz muddatli — pastda 9999999999999 sifatida yoziladi
      amount = window.currentCalculatedAmounts ? (window.currentCalculatedAmounts["lifetime"] || 0) : 0;
      if (activePromo && activePromo.discount) {
        amount = Math.round(amount * (1 - activePromo.discount / 100));
      }
    } else {
      msToAdd = planMonths * 30 * 24 * 60 * 60 * 1000;
      amount = window.currentCalculatedAmounts ? (window.currentCalculatedAmounts[planMonths] || 0) : 0;
      if (activePromo && activePromo.discount) {
        amount = Math.round(amount * (1 - activePromo.discount / 100));
      }
    }
    const totalAmount = amount + oneTimeFeeValue;

    let restId = window.targetRestIdForBilling;
    let selectedPlanId, selectedPlanName;

    if (isNew && newRestData) {
      restId = "rest_" + now;

      selectedPlanId = activeTariff.toLowerCase();
      selectedPlanName = window.allTariffs[selectedPlanId]?.name || selectedPlanId.toUpperCase();

      // Tarifga mos features ni olish (eski tizim bilan moslik uchun saqlanadi)
      const planFeatures = window.allTariffs[selectedPlanId]?.features || [];

      // Business type asosida boshlang'ich modullar to'plamini hosil qilamiz
      const businessType = newRestData.businessType || "other";
      const initialModules = window.buildModulesFromBusinessType(businessType);

      const commonData = {
        info: {
          name: newRestData.name,
          domain: newRestData.domain,
          tariff: selectedPlanId,
          businessType: businessType,
          phone: newRestData.phone || "",
          email: newRestData.email || "",
          address: newRestData.address || "",
          status: "active",
          createdAt: now,
          ...(isTrial ? { isTrial: true, trialStartedAt: now, trialUsed: true } : {})
        },
        subscription: {
          plan: selectedPlanName,
          planId: selectedPlanId,
          status: "active",
          expireAt: (isLifetimePlan || (oneTimeFeeActive && !msToAdd)) ? 9999999999999 : now + msToAdd,
          expireDate: (isLifetimePlan || (oneTimeFeeActive && !msToAdd)) ? 9999999999999 : now + msToAdd,
          lastPaymentDate: now,
          lastPaymentMethod: isTrial ? "trial" : method,
          features: planFeatures,
          oneTimePaid: (oneTimeFeeActive || isLifetimePlan) ? true : false,
          ...(isTrial ? { isTrial: true, trialDays: trialDays } : {})
        },
        modules: initialModules
      };

      await Promise.all([
        set(ref(database, `restaurants/${restId}`), commonData),
        set(ref(database, `restaurants_meta/${restId}`), commonData)
      ]);

      const hashedPassword = typeof window.hashPassword === 'function'
        ? await window.hashPassword(newRestData.adminPass)
        : newRestData.adminPass;

      // P0-2 residual-gap fix: password written to credentials/${restId}/
      // admin_1, not embedded in the users/admin_1 record — see
      // database.rules.json's "credentials" tree comment.
      await set(ref(database, `credentials/${restId}/admin_1`), {
        password: hashedPassword,
      });
      await set(ref(database, `restaurants/${restId}/users/admin_1`), {
        name: typeof t === 'function' ? t("sa_main_admin", "Asosiy Boshqaruvchi") : "Asosiy Boshqaruvchi",
        login: newRestData.adminLogin,
        role: "admin",
        active: true,
        createdAt: now
      });

    } else {
      const rest = window.allRestaurants[restId];
      if (!rest) throw new Error(typeof t === 'function' ? t("sa_rest_not_found", "Restoran topilmadi!") : "Restoran topilmadi!");

      selectedPlanId = activeTariff.toLowerCase();
      selectedPlanName = window.allTariffs[selectedPlanId]?.name || selectedPlanId.toUpperCase();

      // Tarifga mos features ni olish
      const planFeatures = window.allTariffs[selectedPlanId]?.features || [];

      const currentExpireAt = Number(rest.subscription?.expireAt || 0);
      const startTime = (currentExpireAt > now) ? currentExpireAt : now;
      const newExpireDate = isLifetimePlan ? 9999999999999 : startTime + msToAdd;

      const updates = {
        "info/tariff": selectedPlanId,
        "subscription/planId": selectedPlanId,
        "subscription/planName": selectedPlanName,
        "subscription/status": "active",
        "subscription/expireAt": (isLifetimePlan || (oneTimeFeeActive && !planMonths)) ? 9999999999999 : newExpireDate,
        "subscription/expireDate": (isLifetimePlan || (oneTimeFeeActive && !planMonths)) ? 9999999999999 : newExpireDate,
        "subscription/lastPaymentDate": now,
        "subscription/lastPaymentMethod": isTrial ? "trial" : method,
        "subscription/features": planFeatures,
        "subscription/oneTimePaid": (oneTimeFeeActive || isLifetimePlan) ? true : (rest.subscription?.oneTimePaid || false),
        ...(isTrial ? { "subscription/isTrial": true, "subscription/trialDays": trialDays, "info/isTrial": true, "info/trialStartedAt": now, "info/trialUsed": true } : { "subscription/isTrial": false, "info/isTrial": false })
      };

      if (window.pendingResetForRestId === restId) {
        console.log(t("sa_log_10_days_expired", "⚠️ 10 kunlik muddat o'tgan! Eski ma'lumotlar tozalanyapti..."));

        updates["users"] = null;
        updates["products"] = null;
        updates["orders"] = null;
        updates["categories"] = null;
        updates["tables"] = null;
      }

      await Promise.all([
        update(ref(database, `restaurants/${restId}`), updates),
        update(ref(database, `restaurants_meta/${restId}`), updates)
      ]);

      if (window.pendingResetForRestId === restId) {
        const defaultPass = typeof window.hashPassword === 'function' ? await window.hashPassword("123456") : "123456";
        // P0-2 residual-gap fix: password now lives in the separate
        // credentials/${restId} tree, not inside users/ (see database.
        // rules.json's "credentials" tree comment) — so wiping users above
        // (updates["users"] = null) no longer also wipes every deleted
        // employee's old PIN the way it used to when they lived in the same
        // subtree. Explicitly clear the whole credentials/${restId} tree
        // here too, to preserve that exact "10-day reset wipes ALL old
        // employee data" behavior, then write only the fresh admin_1 one.
        await set(ref(database, `credentials/${restId}`), null);
        await set(ref(database, `credentials/${restId}/admin_1`), {
          password: defaultPass,
        });
        await set(ref(database, `restaurants/${restId}/users/admin_1`), {
          name: t("sa_main_admin_restored", "Asosiy Boshqaruvchi (Tiklandi)"),
          login: rest.info?.domain + "_admin",
          role: "admin",
          active: true,
          createdAt: now
        });
        window.pendingResetForRestId = null;
      }
    }

    const restNameForHistory = isNew ? newRestData.name : (window.allRestaurants[restId]?.info?.name || t("sa_unknown", "Noma'lum"));

    await _saLogPayment({
      restaurantName: restNameForHistory,
      restaurantId: restId,
      amount: isTrial ? 0 : totalAmount,
      method: isTrial ? t("sa_trial_method", "🎁 Sinov muddati") : method,
      months: isTrial ? 0 : planMonths,
      trialDays: isTrial ? trialDays : 0,
      oneTimeFee: oneTimeFeeActive ? oneTimeFeeValue : 0,
      promoCode: (!isTrial && activePromo) ? activePromo.code : null,
      promoDiscount: (!isTrial && activePromo) ? activePromo.discount : 0,
      newTariff: selectedPlanName,
    });

    if (!isTrial && activePromo) {
      await _saMarketingFetch(`/promo-codes/${encodeURIComponent(activePromo.id)}/use`, { method: 'POST' });
      window.logAudit && window.logAudit("promo_used", restNameForHistory, `${t("sa_promo_used_log", "Promo kod ishlatildi:")} ${activePromo.code} (-${activePromo.discount}%)`);
    }

    window.closeSuperBillingModal();

    const durationLabel = isLifetimePlan
      ? t("sa_lifetime_label", "Cheksiz muddatli")
      : `${planMonths} ${t("sa_months_short", "oylik")}`;
    const planLabel = isTrial
      ? `${trialDays} ${t("sa_trial_days_label", "kunlik sinov")} (${selectedPlanName})`
      : `${durationLabel} (${selectedPlanName})${oneTimeFeeActive ? ` + 🔑 ${oneTimeFeeValue.toLocaleString()} ${t("sa_currency_uzs", "so'm")}` : ''}${activePromo ? ` 🎟️ -${activePromo.discount}%` : ''}`;

    window.logAudit(
      isNew ? "new_restaurant" : "tariff_change",
      restNameForHistory,
      isNew
        ? `${t('sa_log_new_rest_added', "Yangi restoran qo'shildi")} (${selectedPlanName})`
        : `${t('sa_log_tariff_prefix', "Tarif")} ${selectedPlanName} ${t('sa_log_tariff_suffix', "ga o'tkazildi")} (${planLabel})`
    );

    const amountLabel = isTrial
      ? t("sa_trial_free", "Bepul sinov")
      : totalAmount.toLocaleString() + " " + t("sa_currency_uzs", "so'm");

    if (typeof window.showSuccessReceipt === "function") {
      window.showSuccessReceipt({
        orderId: "REC-" + now.toString().slice(-6),
        restaurantName: restNameForHistory,
        plan: planLabel,
        method: isTrial ? t("sa_trial_method", "🎁 Sinov muddati") : method,
        date: new Date().toLocaleString('ru-RU'),
        amount: amountLabel
      });
    }

    if (typeof window.renderRestaurantsTable === "function") {
      window.renderRestaurantsTable();
    }

  } catch (error) {
    console.error(t("sa_err_payment_process", "To'lov jarayonida xatolik:"), error);
    alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
  }
};

// ============================================
// CHEK TELEFON RAQAMI
// ============================================
window.saveReceiptPhone = async function () {
  const input = document.getElementById('receiptPhoneInput');
  if (!input) return;
  const phone = input.value.trim();
  try {
    await _saSettingsFetch('/receipt-phone', { method: 'POST', body: JSON.stringify({ phone }) });
    window._receiptPhone = phone;
    // Update chek phone display if visible
    const el = document.getElementById('r_phone');
    if (el) el.innerText = phone || '+998 71 000-00-00';
    // Visual feedback
    input.style.borderColor = '#10b981';
    setTimeout(() => { input.style.borderColor = '#d1d5db'; }, 2000);
    alert(t('sa_phone_saved', '✅ Telefon raqam saqlandi!'));
  } catch (err) {
    alert(t('sa_error_prefix', 'Xatolik: ') + err.message);
  }
};

// Receipt-phone init fix: this used to have its own standalone
// DOMContentLoaded + 1.2s setTimeout trigger, independent of and not
// synchronized with the main onAuthStateChanged gate every other listener
// waits for (superadmin.js:2410-2449) — the same class of page-load race
// already fixed for System Health. Firebase's session restoration is
// async and can still be in flight at that fixed 1.2s mark. Now started
// from inside that same gate (see the _scListenersStarted block below) —
// this function itself is unchanged, only when it's first called moved.
window.listenReceiptPhone = function () {
  try {
    _saStartSettingsPoll('/receipt-phone', (data) => {
      const phone = data?.phone || '+998 71 000-00-00';
      window._receiptPhone = phone;
      const input = document.getElementById('receiptPhoneInput');
      if (input) input.value = phone;
      const el = document.getElementById('r_phone');
      if (el) el.innerText = phone;
    });
  } catch (e) { /* silent */ }
};

// ============================================
// CHEK MODAL — KLASSIK TERMAL PRINTER USLUBI
// ============================================
function _ensureReceiptModal() {
  if (document.getElementById('receiptModal')) return;

  const html = `
  <style>
    #receiptModal {
      position: fixed; inset: 0; background: rgba(0,0,0,0.55);
      z-index: 99999; display: none; align-items: center; justify-content: center;
    }
    #receiptModal.open { display: flex; }
    .rcpt-paper {
      width: 300px;
      background: #fff;
      font-family: 'Courier New', Courier, monospace;
      color: #111;
      box-shadow: 0 4px 24px rgba(0,0,0,0.18);
      border-radius: 3px 3px 0 0;
      overflow: hidden;
    }
    .rcpt-paper .rp-head {
      background: #111;
      padding: 20px 20px 14px;
      text-align: center;
    }
    .rcpt-paper .rp-head .rp-name {
      font-size: 15px; font-weight: 900; letter-spacing: 2px; color: #fff;
    }
    .rcpt-paper .rp-head .rp-phone {
      font-size: 11px; color: #aaa; margin-top: 5px; letter-spacing: 1px;
    }
    .rcpt-paper .rp-head .rp-sub {
      font-size: 9px; letter-spacing: 3px; color: #666; margin-top: 3px; text-transform: uppercase;
    }
    .rcpt-paper .rp-body {
      padding: 12px 18px 8px;
    }
    .rcpt-paper .rp-dashed {
      border: none; border-top: 1px dashed #888; margin: 10px 0;
    }
    .rcpt-paper .rp-solid {
      border: none; border-top: 1.5px solid #111; margin: 10px 0;
    }
    .rcpt-paper .rp-row {
      display: flex; justify-content: space-between;
      font-size: 11.5px; padding: 2px 0; color: #111;
    }
    .rcpt-paper .rp-row .rp-lbl { font-weight: 700; }
    .rcpt-paper .rp-row .rp-val { text-align: right; font-weight: 400; }
    .rcpt-paper .rp-item-name {
      font-size: 12px; font-weight: 700; color: #111; margin-top: 2px;
    }
    .rcpt-paper .rp-item-detail {
      display: flex; justify-content: space-between;
      font-size: 11.5px; color: #111; padding: 2px 0;
    }
    .rcpt-paper .rp-total-row {
      display: flex; justify-content: space-between;
      font-size: 12.5px; font-weight: 900; color: #111; padding: 2px 0;
    }
    .rcpt-paper .rp-thanks {
      text-align: center; font-size: 11px; letter-spacing: 3px; color: #111;
      margin: 4px 0 2px;
    }
    .rcpt-paper .rp-visit {
      text-align: center; font-size: 10px; letter-spacing: 1px; color: #555;
      margin-top: 3px; margin-bottom: 2px;
    }
    .rcpt-actions-bar {
      width: 300px;
      display: flex;
      border-radius: 0 0 8px 8px;
      overflow: hidden;
      box-shadow: 0 6px 20px rgba(0,0,0,0.14);
    }
    .rcpt-actions-bar button {
      flex: 1; padding: 13px 4px;
      border: none; cursor: pointer;
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.6px;
      font-family: 'Courier New', monospace;
      display: flex; align-items: center; justify-content: center; gap: 5px;
      transition: filter 0.15s;
    }
    .rcpt-actions-bar button:hover { filter: brightness(0.9); }
    .rcpt-actions-bar .rca-save  { background: #111; color: #fff; }
    .rcpt-actions-bar .rca-print { background: #444; color: #fff; }
    .rcpt-actions-bar .rca-close { background: #eee; color: #333; border-left: 1px solid #ccc; }
    @media print {
      body > *:not(#receiptModal) { display: none !important; }
      #receiptModal { position: static !important; background: none !important; display: block !important; }
      .rcpt-actions-bar { display: none !important; }
    }
  </style>

  <div id="receiptModal">
    <div style="display:flex; flex-direction:column; align-items:center;">
      <div class="rcpt-paper" id="captureArea">

        <div class="rp-head">
          <div class="rp-name">NESTA ERP</div>
          <div id="r_phone" class="rp-phone">+998 71 220-00-00</div>
          <div class="rp-sub" id="r_platform_label">${t('sa_rcpt_platform', "TO'LOV PLATFORMA")}</div>
        </div>

        <div class="rp-body">
          <hr class="rp-dashed">

          <div class="rp-row">
            <span class="rp-lbl" id="r_lbl_date">${t('sa_rcpt_date_label', 'SANA')}:</span>
            <span class="rp-val" id="r_date">—</span>
          </div>
          <div class="rp-row">
            <span class="rp-lbl" id="r_lbl_num">${t('sa_rcpt_num_label', 'CHEK RAQAM')}:</span>
            <span class="rp-val" id="r_orderId">—</span>
          </div>
          <div class="rp-row">
            <span class="rp-lbl" id="r_lbl_method">${t('sa_rcpt_method_label', "TO'LOV USULI")}:</span>
            <span class="rp-val" id="r_method">—</span>
          </div>

          <hr class="rp-dashed">

          <div class="rp-item-name" id="r_restName">—</div>
          <div class="rp-item-detail">
            <span id="r_plan">—</span>
            <span id="r_amount_item">—</span>
          </div>

          <hr class="rp-solid">

          <div class="rp-total-row">
            <span id="r_lbl_total">${t('sa_rcpt_total_label', "JAMI TO'LOV")}:</span>
            <span id="r_amount">—</span>
          </div>

          <hr class="rp-dashed">

          <div class="rp-thanks" id="r_thanks_text">* * * ${t('sa_rcpt_thanks', 'R A H M A T')} * * *</div>
          <div class="rp-visit" id="r_visit_text">${t('sa_rcpt_visit_again', 'BIZNI TANLAGANINGIZ UCHUN!')}</div>
        </div>

      </div>

      <div class="rcpt-actions-bar">
        <button class="rca-save" onclick="window.downloadReceipt('png')">
          &#8595; <span id="r_btn_save">${t('sa_rcpt_save_btn', 'Saqlash')}</span>
        </button>
        <button class="rca-print" onclick="window.printReceipt()">
          &#9113; <span id="r_btn_print">${t('sa_rcpt_print_btn', 'Chop')}</span>
        </button>
        <button class="rca-close" onclick="window.closeReceipt()">
          &#x2715; <span id="r_btn_close">${t('sa_rcpt_close_btn', 'Yopish')}</span>
        </button>
      </div>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
}

function _updateReceiptLabels() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
  set('r_platform_label',  t('sa_rcpt_platform',    "TO'LOV PLATFORMA"));
  set('r_lbl_date',        t('sa_rcpt_date_label',  'SANA') + ':');
  set('r_lbl_num',         t('sa_rcpt_num_label',   'CHEK RAQAM') + ':');
  set('r_lbl_method',      t('sa_rcpt_method_label',"TO'LOV USULI") + ':');
  set('r_lbl_total',       t('sa_rcpt_total_label', "JAMI TO'LOV") + ':');
  set('r_thanks_text',     '* * * ' + t('sa_rcpt_thanks', 'R A H M A T') + ' * * *');
  set('r_visit_text',      t('sa_rcpt_visit_again', 'BIZNI TANLAGANINGIZ UCHUN!'));
  set('r_btn_save',        t('sa_rcpt_save_btn',    'Saqlash'));
  set('r_btn_print',       t('sa_rcpt_print_btn',   'Chop'));
  set('r_btn_close',       t('sa_rcpt_close_btn',   'Yopish'));
}

window.showSuccessReceipt = function (data) {
  window._showPaymentLoadingThenReceipt(data);
};

window._ensurePaymentLoadingModal = function () {
  if (document.getElementById('paymentLoadingModal')) return;
  const html = `
    <div id="paymentLoadingModal" style="display:none; position:fixed; inset:0; z-index:99999; background:rgba(15,23,42,.55); align-items:center; justify-content:center;">
      <div style="background:#fff; padding:40px 48px; border-radius:20px; box-shadow:0 20px 60px rgba(0,0,0,.2); text-align:center; min-width:280px;">
        <div style="width:56px; height:56px; margin:0 auto 20px; border:5px solid #e2e8f0; border-top-color:#2563eb; border-radius:50%; animation:paymentSpin 0.8s linear infinite;"></div>
        <div style="font-family:'Sora',sans-serif; font-weight:700; font-size:16px; color:#0F172A;">${t("sa_payment_processing", "To'lov amalga oshirilmoqda...")}</div>
      </div>
    </div>
    <style>@keyframes paymentSpin { to { transform: rotate(360deg); } }</style>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
};

window._showPaymentLoadingThenReceipt = function (data) {
  window._ensurePaymentLoadingModal();
  const loader = document.getElementById('paymentLoadingModal');
  if (loader) { loader.style.display = 'flex'; }

  setTimeout(() => {
    if (loader) loader.style.display = 'none';

    _ensureReceiptModal();
    _updateReceiptLabels();
    const m = document.getElementById('receiptModal');
    if (!m) return;
    document.getElementById('r_orderId').innerText = "#" + data.orderId;
    document.getElementById('r_restName').innerText = data.restaurantName || data.restName || '---';
    document.getElementById('r_plan').innerText = data.plan;
    document.getElementById('r_method').innerText = data.method;
    document.getElementById('r_date').innerText = data.date;
    document.getElementById('r_amount').innerText = data.amount;
    const amtItem = document.getElementById('r_amount_item');
    if (amtItem) amtItem.innerText = data.amount;
    const phoneEl = document.getElementById('r_phone');
    if (phoneEl) phoneEl.innerText = window._receiptPhone || '+998 71 220-00-00';
    m.classList.add('open');
    m.style.display = 'flex';
  }, 3000);
};

window.printReceipt = function () {
  window.print();
};

window.closeReceipt = function () {
  const m = document.getElementById('receiptModal');
  if (m) { m.classList.remove('open'); m.style.display = 'none'; }
};

window.downloadReceipt = function (format) {
  const area = document.getElementById("captureArea");
  if (typeof html2canvas !== "undefined") {
    html2canvas(area, { scale: 2, backgroundColor: "#ffffff" }).then(canvas => {
      if (format === 'png') {
        const link = document.createElement('a');
        link.download = `${t("sa_receipt_label", "Chek")}-${Date.now()}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
      }
    });
  } else {
    alert(t("sa_html2canvas_error", "html2canvas yuklanmagan!"));
  }
};

// ============================================
// 4. RESTORANLAR JADVALI VA HARAKATLAR
// ============================================
window.openAddRestaurantModal = function () {
  const modal = document.getElementById("addRestaurantModal");
  if (modal) { modal.style.display = "flex"; modal.classList.remove("hidden"); }
  if (document.getElementById("newRestName")) document.getElementById("newRestName").value = "";
  if (document.getElementById("newRestDomain")) document.getElementById("newRestDomain").value = "";
  if (document.getElementById("newRestAdminLogin")) document.getElementById("newRestAdminLogin").value = "";
  if (document.getElementById("newRestAdminPass")) document.getElementById("newRestAdminPass").value = "";
  // Har safar modal yangidan ochilganda "foydalanuvchi qo'lda o'zgartirdi"
  // bayrog'ini ham tozalaymiz — aks holda oldingi restoran uchun qo'lda
  // tahrirlangan bo'lsa, shu bayroq keyingi (yangi) restoran yaratishga ham
  // "sizib o'tib", domain asosidagi avtomatik generatsiyani bloklab qo'yardi.
  window._newRestLoginTypedByUser = false;
  window._newRestDomainTypedByUser = false;
  if (typeof window.renderNewRestLicenseOptions === "function") window.renderNewRestLicenseOptions();
};

window.closeAddRestaurantModal = function () {
  const modal = document.getElementById("addRestaurantModal");
  if (modal) { modal.classList.add("hidden"); modal.style.display = "none"; }
};

// Restoran nomi bo'yicha tegларini topish (allRestaurants dan)
function _getRestTagsByName(restName) {
  if (!restName || !window.allRestaurants) return [];
  const match = Object.values(window.allRestaurants).find(r => (r.info?.name || "") === restName);
  return match?.info?.tags || [];
}

// 🏢 Restoran va 🏷️ Teg filtr dropdownlarini litsenziya tarixidagi ma'lumotlar asosida to'ldirish
function _populateLicenseHistoryFilterDropdowns() {
  if (!globalLicenseHistoryData) return;

  const restSelect = document.getElementById("licenseHistoryRestFilter");
  const tagSelect = document.getElementById("licenseHistoryTagFilter");
  if (!restSelect && !tagSelect) return;

  const restNames = new Set();
  const tagSet = new Set();

  Object.values(globalLicenseHistoryData).forEach(entry => {
    if (!LICENSE_HISTORY_ACTIONS.has(entry.action)) return;
    if (entry.restName) restNames.add(entry.restName);
    _getRestTagsByName(entry.restName).forEach(tg => tagSet.add(tg));
  });

  if (restSelect) {
    const prevVal = restSelect.value || "all";
    const sortedNames = [...restNames].sort((a, b) => a.localeCompare(b));
    restSelect.innerHTML = `<option value="all">🏢 ${t("sa_audit_filter_all_rest", "Barcha restoranlar")}</option>` +
      sortedNames.map(name => `<option value="${name}">${name}</option>`).join("");
    if ([...restSelect.options].some(o => o.value === prevVal)) restSelect.value = prevVal;
  }

  if (tagSelect) {
    const prevVal = tagSelect.value || "all";
    const sortedTags = [...tagSet].sort((a, b) => a.localeCompare(b));
    tagSelect.innerHTML = `<option value="all">🏷️ ${t("sa_lm_filter_all_tags", "Barcha teglar")}</option>` +
      sortedTags.map(tg => `<option value="${tg}">${tg}</option>`).join("");
    if ([...tagSelect.options].some(o => o.value === prevVal)) tagSelect.value = prevVal;
  }
}

window.renderPaymentHistory = function () {
  const tbody = document.getElementById("paymentsTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!globalLicenseHistoryData || Object.keys(globalLicenseHistoryData).length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="border:none;">
      <div class="pay-empty-state">
        <i class="fa-regular fa-file-excel"></i>
        <span>${t("sa_no_license_history", "Hozircha litsenziya tarixi yo'q")}</span>
      </div>
    </td></tr>`;
    return;
  }

  _populateLicenseHistoryFilterDropdowns();

  const { start, end } = (typeof _getPaymentsFilterRange === "function") ? _getPaymentsFilterRange() : { start: null, end: null };
  const searchVal = (document.getElementById("licenseHistorySearchInput")?.value || "").trim().toLowerCase();
  const restFilter = document.getElementById("licenseHistoryRestFilter")?.value || "all";
  const actionFilter = document.getElementById("licenseHistoryActionFilter")?.value || "all";
  const tagFilter = document.getElementById("licenseHistoryTagFilter")?.value || "all";

  let historyArray = Object.entries(globalLicenseHistoryData)
    .map(([id, data]) => ({ id, ...data }))
    .filter(entry => LICENSE_HISTORY_ACTIONS.has(entry.action));

  if (start || end) {
    historyArray = historyArray.filter(p => {
      const ts = Number(p.timestamp || 0);
      if (start && ts < start) return false;
      if (end && ts > end) return false;
      return true;
    });
  }

  if (searchVal) {
    historyArray = historyArray.filter(p =>
      (p.restName || "").toLowerCase().includes(searchVal) ||
      (p.details || "").toLowerCase().includes(searchVal) ||
      (p.actor || "").toLowerCase().includes(searchVal)
    );
  }

  if (restFilter !== "all") {
    historyArray = historyArray.filter(p => p.restName === restFilter);
  }

  if (actionFilter !== "all") {
    historyArray = historyArray.filter(p => p.action === actionFilter);
  }

  if (tagFilter !== "all") {
    historyArray = historyArray.filter(p => _getRestTagsByName(p.restName).includes(tagFilter));
  }

  historyArray.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));

  if (!historyArray.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="border:none;">
      <div class="pay-empty-state">
        <i class="fa-regular fa-calendar-xmark"></i>
        <span>${t("sa_no_license_history_in_range", "Tanlangan filtrga mos litsenziya tarixi topilmadi")}</span>
      </div>
    </td></tr>`;
    return;
  }

  historyArray.forEach(entry => {
    const dateObj = entry.timestamp ? new Date(entry.timestamp) : null;
    const dateMain = dateObj ? dateObj.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : "—";
    const dateTime = dateObj ? dateObj.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : "";

    const meta = LICENSE_ACTION_LABELS[entry.action] || { icon: "fa-circle-info", color: "#64748b", bg: "#f8fafc", key: null, fallback: entry.action };
    const actionLabel = meta.key ? t(meta.key, meta.fallback) : meta.fallback;
    const detailsText = entry.details ? ` <span style="color:#94a3b8;font-weight:500;">— ${entry.details}</span>` : "";

    const restName = entry.restName || t("sa_unknown_rest", "Noma'lum restoran");
    const restInitial = restName.trim().charAt(0).toUpperCase() || "?";

    const tr = document.createElement("tr");
    tr.innerHTML = `
  <td data-label="${t('sa_table_date','Sana')}">
    <div class="pay-date-cell">
      <span class="pay-date-main">${dateMain}</span>
      <span class="pay-date-time">${dateTime}</span>
    </div>
  </td>
  <td data-label="${t('sa_table_restaurant','Restoran')}">
    <div class="pay-rest-cell">
      <div class="pay-rest-avatar">${restInitial}</div>
      <span class="pay-rest-name">${restName}</span>
    </div>
  </td>
  <td data-label="${t('sa_lic_table_action','Amal')}">
    <span class="pay-badge" style="background:${meta.bg}; color:${meta.color};"><i class="fa-solid ${meta.icon}"></i> ${actionLabel}</span>${detailsText}
  </td>
  <td data-label="${t('sa_lic_table_actor',"Kim bajardi")}">
    <span style="font-weight:600; color:#374151; font-size:13px;"><i class="fa-solid fa-user-shield" style="color:#94a3b8; margin-right:5px;"></i>${entry.actor || "SuperAdmin"}</span>
  </td>
`;
    tbody.appendChild(tr);
  });
};



// ============================================
// TO'LOVLAR TARIXI — SANA FILTRI VA EXCEL EXPORT
// ============================================
window._paymentsQuickFilter = null;

function _pad2(n) { return String(n).padStart(2, "0"); }

function _dateToInputValue(d) {
  return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;
}

// Joriy filtr (boshlanish/tugash) ni millisekund oraliqqa aylantiradi
function _getPaymentsFilterRange() {
  const startInput = document.getElementById("paymentsFilterStart")?.value;
  const endInput = document.getElementById("paymentsFilterEnd")?.value;

  let start = startInput ? new Date(startInput + "T00:00:00") : null;
  let end = endInput ? new Date(endInput + "T23:59:59") : null;

  return {
    start: start ? start.getTime() : null,
    end: end ? end.getTime() : null
  };
}

// Tezkor filtr tugmalari (Bu oy / O'tgan oy / Bu yil)
window.setPaymentsQuickFilter = function (type) {
  const now = new Date();
  let start, end;

  if (type === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  } else if (type === "prevmonth") {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 0);
  } else if (type === "year") {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear(), 11, 31);
  } else {
    return;
  }

  window._paymentsQuickFilter = type;

  const startEl = document.getElementById("paymentsFilterStart");
  const endEl = document.getElementById("paymentsFilterEnd");
  if (startEl) startEl.value = _dateToInputValue(start);
  if (endEl) endEl.value = _dateToInputValue(end);

  // Tugmalar uchun aktiv holat ko'rsatish
  ["pqb_month", "pqb_prevmonth", "pqb_year"].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const isActive = (id === "pqb_" + type);
    btn.style.background = isActive ? "#10B981" : "transparent";
    btn.style.color = isActive ? "#fff" : "#374151";
  });

  if (typeof window.renderPaymentHistory === "function") window.renderPaymentHistory();
};

// Sana inputlari qo'lda o'zgartirilganda tezkor tugmalar aktivligini olib tashlash va jadvalni qayta chizish
document.addEventListener("DOMContentLoaded", () => {
  ["paymentsFilterStart", "paymentsFilterEnd"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("change", () => {
        window._paymentsQuickFilter = null;
        ["pqb_month", "pqb_prevmonth", "pqb_year"].forEach(btnId => {
          const btn = document.getElementById(btnId);
          if (btn) { btn.style.background = "transparent"; btn.style.color = "#374151"; }
        });
        if (typeof window.renderPaymentHistory === "function") window.renderPaymentHistory();
      });
    }
  });
});

// Tanlangan filtrlarga mos litsenziya tarixi yozuvlarini qaytaradi (barcha restoranlar)
function _getFilteredPaymentsForExport() {
  if (!globalLicenseHistoryData) return [];

  const { start, end } = _getPaymentsFilterRange();
  const searchVal = (document.getElementById("licenseHistorySearchInput")?.value || "").trim().toLowerCase();
  const restFilter = document.getElementById("licenseHistoryRestFilter")?.value || "all";
  const actionFilter = document.getElementById("licenseHistoryActionFilter")?.value || "all";
  const tagFilter = document.getElementById("licenseHistoryTagFilter")?.value || "all";

  return Object.entries(globalLicenseHistoryData)
    .map(([id, data]) => ({ id, ...data }))
    .filter(entry => LICENSE_HISTORY_ACTIONS.has(entry.action))
    .filter(p => {
      const ts = Number(p.timestamp || 0);
      if (start && ts < start) return false;
      if (end && ts > end) return false;
      return true;
    })
    .filter(p => !searchVal ||
      (p.restName || "").toLowerCase().includes(searchVal) ||
      (p.details || "").toLowerCase().includes(searchVal) ||
      (p.actor || "").toLowerCase().includes(searchVal))
    .filter(p => restFilter === "all" || p.restName === restFilter)
    .filter(p => actionFilter === "all" || p.action === actionFilter)
    .filter(p => tagFilter === "all" || _getRestTagsByName(p.restName).includes(tagFilter))
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
}

// Excel hisobotini yaratish va yuklab olish — barcha restoranlarning litsenziya tarixi
window.exportPaymentsToExcel = function () {
  if (typeof XLSX === "undefined") {
    alert(t("sa_xlsx_lib_error", "Excel kutubxonasi yuklanmagan. Internet aloqasini tekshiring."));
    return;
  }

  const rows = _getFilteredPaymentsForExport();

  if (!rows.length) {
    alert(t("sa_no_license_history_in_range", "Tanlangan sana oralig'ida litsenziya tarixi topilmadi"));
    return;
  }

  const { start, end } = _getPaymentsFilterRange();

  // ---------- Umumiy stillar ----------
  const BRAND = "2EBC58";
  const BRAND_DARK = "16803A";

  const titleStyle = {
    font: { name: "Calibri", sz: 16, bold: true, color: { rgb: BRAND_DARK } },
    alignment: { vertical: "center" }
  };
  const subtitleStyle = {
    font: { name: "Calibri", sz: 10, italic: true, color: { rgb: "64748B" } },
    alignment: { vertical: "center" }
  };
  const headerStyle = {
    font: { name: "Calibri", sz: 11, bold: true, color: { rgb: "FFFFFF" } },
    fill: { patternType: "solid", fgColor: { rgb: BRAND } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border: {
      top: { style: "thin", color: { rgb: BRAND_DARK } },
      bottom: { style: "thin", color: { rgb: BRAND_DARK } },
      left: { style: "thin", color: { rgb: BRAND_DARK } },
      right: { style: "thin", color: { rgb: BRAND_DARK } }
    }
  };
  const thinBorder = {
    top: { style: "thin", color: { rgb: "E2E8F0" } },
    bottom: { style: "thin", color: { rgb: "E2E8F0" } },
    left: { style: "thin", color: { rgb: "E2E8F0" } },
    right: { style: "thin", color: { rgb: "E2E8F0" } }
  };
  const cellBase = { font: { name: "Calibri", sz: 10.5, color: { rgb: "374151" } }, border: thinBorder, alignment: { vertical: "center" } };
  const cellEven = { ...cellBase, fill: { patternType: "solid", fgColor: { rgb: "F8FAFC" } } };
  const cellOdd = { ...cellBase, fill: { patternType: "solid", fgColor: { rgb: "FFFFFF" } } };
  const amountStyle = (isEven) => ({
    ...(isEven ? cellEven : cellOdd),
    font: { name: "Calibri", sz: 10.5, bold: true, color: { rgb: BRAND_DARK } },
    alignment: { horizontal: "right", vertical: "center" },
    numFmt: '#,##0 "so\'m"'
  });
  const centerCell = (isEven) => ({ ...(isEven ? cellEven : cellOdd), alignment: { horizontal: "center", vertical: "center" } });
  const totalLabelStyle = {
    font: { name: "Calibri", sz: 11, bold: true, color: { rgb: "FFFFFF" } },
    fill: { patternType: "solid", fgColor: { rgb: BRAND_DARK } },
    alignment: { horizontal: "right", vertical: "center" },
    border: thinBorder
  };
  const totalAmountStyle = {
    font: { name: "Calibri", sz: 12, bold: true, color: { rgb: "FFFFFF" } },
    fill: { patternType: "solid", fgColor: { rgb: BRAND_DARK } },
    alignment: { horizontal: "right", vertical: "center" },
    numFmt: '#,##0 "so\'m"',
    border: thinBorder
  };
  const totalEmptyStyle = {
    fill: { patternType: "solid", fgColor: { rgb: BRAND_DARK } },
    border: thinBorder
  };

  const fmt = ts => ts ? new Date(ts).toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric" }) : t("sa_excel_all_period","barcha davr");
  const periodLabel = (!start && !end) ? t("sa_excel_period_label","Davr: barcha vaqt") : `${t("sa_excel_period_prefix","Davr:")} ${fmt(start)} — ${fmt(end)}`;

  // ============================================================
  // 1-VARAQ: TAFSILOT
  // ============================================================
  const detailHeaders = [t("sa_excel_date_header","Sana"), t("sa_excel_rest_header","Restoran"), t("sa_excel_action_header","Amal"), t("sa_excel_details_header","Tafsilot"), t("sa_excel_actor_header","Kim bajardi")];
  const detailAOA = [
    [t("sa_excel_lic_title","Litsenziya Tarixi Hisoboti")],
    [periodLabel],
    [],
    detailHeaders
  ];

  rows.forEach(entry => {
    const ts = Number(entry.timestamp || 0);
    const dateStr = ts ? new Date(ts).toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
    }) : "—";

    const meta = LICENSE_ACTION_LABELS[entry.action] || { key: null, fallback: entry.action };
    const actionLabel = meta.key ? t(meta.key, meta.fallback) : meta.fallback;

    detailAOA.push([dateStr, entry.restName || t("sa_unknown_rest","Noma'lum restoran"), actionLabel, entry.details || "", entry.actor || "SuperAdmin"]);
  });

  const wsDetail = XLSX.utils.aoa_to_sheet(detailAOA);
  wsDetail["!cols"] = [{ wch: 19 }, { wch: 26 }, { wch: 24 }, { wch: 34 }, { wch: 18 }];
  wsDetail["!rows"] = [{ hpt: 26 }, { hpt: 16 }, { hpt: 6 }, { hpt: 22 }];
  wsDetail["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } }
  ];

  wsDetail["A1"].s = titleStyle;
  wsDetail["A2"].s = subtitleStyle;

  detailHeaders.forEach((_, ci) => {
    const ref = XLSX.utils.encode_cell({ r: 3, c: ci });
    if (wsDetail[ref]) wsDetail[ref].s = headerStyle;
  });

  rows.forEach((p, ri) => {
    const rowIdx = 4 + ri;
    const isEven = ri % 2 === 1;
    [0, 2, 3, 4].forEach(ci => {
      const ref = XLSX.utils.encode_cell({ r: rowIdx, c: ci });
      if (wsDetail[ref]) wsDetail[ref].s = centerCell(isEven);
    });
    const restRef = XLSX.utils.encode_cell({ r: rowIdx, c: 1 });
    if (wsDetail[restRef]) wsDetail[restRef].s = { ...(isEven ? cellEven : cellOdd), font: { name: "Calibri", sz: 10.5, bold: true, color: { rgb: "1E293B" } } };
  });

  wsDetail["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3, c: 4 } }) };

  // ============================================================
  // 2-VARAQ: RESTORANLAR BO'YICHA JAMI
  // ============================================================
  const byRestaurant = {};
  rows.forEach(entry => {
    const name = entry.restName || t("sa_unknown_restaurant", "Noma'lum restoran");
    if (!byRestaurant[name]) byRestaurant[name] = { count: 0 };
    byRestaurant[name].count += 1;
  });

  const sortedRest = Object.entries(byRestaurant).sort((a, b) => b[1].count - a[1].count);

  const summaryHeaders = ["#", t("sa_excel_rest_header","Restoran"), t("sa_excel_count_header","Yozuvlar soni")];
  const summaryAOA = [
    [t("sa_excel_lic_summary_title","Restoranlar bo'yicha Litsenziya Yozuvlari")],
    [periodLabel],
    [],
    summaryHeaders
  ];

  sortedRest.forEach(([name, info], idx) => {
    summaryAOA.push([idx + 1, name, info.count]);
  });

  const summaryTotalRowIdx = summaryAOA.length;
  summaryAOA.push(["", t("sa_excel_total_label","JAMI:"), rows.length]);

  const wsSummary = XLSX.utils.aoa_to_sheet(summaryAOA);
  wsSummary["!cols"] = [{ wch: 5 }, { wch: 28 }, { wch: 16 }];
  wsSummary["!rows"] = [{ hpt: 26 }, { hpt: 16 }, { hpt: 6 }, { hpt: 22 }];
  wsSummary["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 2 } }
  ];

  wsSummary["A1"].s = titleStyle;
  wsSummary["A2"].s = subtitleStyle;

  summaryHeaders.forEach((_, ci) => {
    const ref = XLSX.utils.encode_cell({ r: 3, c: ci });
    if (wsSummary[ref]) wsSummary[ref].s = headerStyle;
  });

  sortedRest.forEach((_, ri) => {
    const rowIdx = 4 + ri;
    const isEven = ri % 2 === 1;
    [0, 2].forEach(ci => {
      const ref = XLSX.utils.encode_cell({ r: rowIdx, c: ci });
      if (wsSummary[ref]) wsSummary[ref].s = centerCell(isEven);
    });
    const restRef = XLSX.utils.encode_cell({ r: rowIdx, c: 1 });
    if (wsSummary[restRef]) wsSummary[restRef].s = { ...(isEven ? cellEven : cellOdd), font: { name: "Calibri", sz: 10.5, bold: true, color: { rgb: "1E293B" } } };
  });

  [0, 1, 2].forEach(ci => {
    const ref = XLSX.utils.encode_cell({ r: summaryTotalRowIdx, c: ci });
    if (wsSummary[ref]) wsSummary[ref].s = (ci === 1) ? totalLabelStyle : totalEmptyStyle;
  });
  const summaryTotalCountRef = XLSX.utils.encode_cell({ r: summaryTotalRowIdx, c: 2 });
  if (wsSummary[summaryTotalCountRef]) wsSummary[summaryTotalCountRef].s = { ...totalAmountStyle, numFmt: "#,##0" };

  wsSummary["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3, c: 2 } }) };

  // ---------- WORKBOOK YARATISH ----------
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsDetail, t("sa_excel_sheet_detail","Tafsilot"));
  XLSX.utils.book_append_sheet(wb, wsSummary, t("sa_excel_sheet_summary","Restoranlar boyicha jami"));

  const fnFmt = ts => ts ? new Date(ts).toISOString().slice(0, 10) : "all";
  const fileName = `Litsenziya_tarixi_${fnFmt(start)}_${fnFmt(end)}.xlsx`;

  XLSX.writeFile(wb, fileName);
};


// ===============================
// BARCHA RESTORANLARNI O'CHIRISH 
// ===============================
window.deleteAllRestaurants = async function () {
  const confirmMsg = typeof t === 'function'
    ? t("sa_confirm_delete_all_rests", "⚠️ DIQQAT! Tizimdagi BARCHA restoranlarni va ularning ma'lumotlarini butunlay o'chirib tashlamoqchimisiz? Bu amalni qaytarib bo'lmaydi!")
    : "⚠️ DIQQAT! Tizimdagi BARCHA restoranlarni va ularning ma'lumotlarini butunlay o'chirib tashlamoqchimisiz? Bu amalni qaytarib bo'lmaydi!";

  const confirmFirst = confirm(confirmMsg);

  if (!confirmFirst) return;

  try {
    await _saDashFetch("/restaurants", { method: "DELETE" });

      window.logAudit("delete_all", null, t("sa_log_all_deleted", "Tizimdagi BARCHA restoranlar o'chirildi"));

      const successMsg = typeof t === 'function' ? t("sa_all_deleted_success", "✅ Barcha restoranlar muvaffaqiyatli o'chirildi.") : "✅ Barcha restoranlar muvaffaqiyatli o'chirildi.";
      alert(successMsg);

      if (typeof window.renderRestaurantsTable === "function") {
        window.renderRestaurantsTable();
      }

      if (typeof updateDashboardStats === "function") {
        updateDashboardStats();
      }

  } catch (error) {
    console.error(t("sa_err_delete_all", "Barchasini o'chirishda xato:"), error);
    const errorPrefix = typeof t === 'function' ? t("sa_error_prefix", "Xatolik: ") : "Xatolik: ";
    alert(errorPrefix + error.message);
  }
};

window.saveGlobalSettings = async function () {
  console.log(t("sa_log_save_btn_clicked", "1. Saqlash tugmasi bosildi!"));

  const btn = document.querySelector("button[onclick*='saveGlobalSettings']");
  if (btn) btn.innerText = t("sa_saving_wait", "Saqlanmoqda... ⏳");

  try {
    const getFeatures = (tKey) => {
      const arr = [];
      if (document.getElementById(`f_${tKey}_qr`)?.checked) arr.push("qr_menu");
      if (document.getElementById(`f_${tKey}_kds`)?.checked) arr.push("kds");
      if (document.getElementById(`f_${tKey}_promo`)?.checked) arr.push("promo");
      if (document.getElementById(`f_${tKey}_finance`)?.checked) arr.push("finance");
      if (document.getElementById(`f_${tKey}_inventory`)?.checked) arr.push("inventory");
      if (document.getElementById(`f_${tKey}_reservations`)?.checked) arr.push("reservations");
      return arr;
    };

    // Limitlarni o'qish: bo'sh yoki 0 → cheklanmagan (0 sifatida saqlanadi, UI'da "Cheksiz" ko'rsatiladi)
    const getLimits = (prefix) => {
      const readLimit = (id) => {
        const raw = document.getElementById(id)?.value;
        const n = Number(raw);
        return (raw === "" || raw === undefined || isNaN(n) || n < 0) ? 0 : n;
      };
      return {
        maxBranches: readLimit(`limitBranches${prefix}`),
        maxAdmins: readLimit(`limitAdmins${prefix}`),
        maxStaff: readLimit(`limitStaff${prefix}`),
        maxChefs: readLimit(`limitChefs${prefix}`),
        maxTables: readLimit(`limitTables${prefix}`),
        maxProducts: readLimit(`limitProducts${prefix}`)
      };
    };

    const newTariffs = {
      start: {
        name: "START",
        price: Number(document.getElementById("priceStart")?.value || 150000),
        trialDays: Number(document.getElementById("trialDaysStart")?.value || 0),
        oneTimeFee: Number(document.getElementById("oneTimeFeeStart")?.value || 4900000),
        oneTimeActive: !!document.getElementById("oneTimeActiveStart")?.checked,
        features: getFeatures("start"),
        limits: getLimits("Start")
      },
      pro: {
        name: "PRO",
        price: Number(document.getElementById("pricePro")?.value || 350000),
        trialDays: Number(document.getElementById("trialDaysPro")?.value || 0),
        oneTimeFee: Number(document.getElementById("oneTimeFeePro")?.value || 9900000),
        oneTimeActive: !!document.getElementById("oneTimeActivePro")?.checked,
        features: getFeatures("pro"),
        limits: getLimits("Pro")
      },
      premium: {
        name: "PREMIUM",
        price: Number(document.getElementById("pricePremium")?.value || 700000),
        trialDays: Number(document.getElementById("trialDaysPremium")?.value || 0),
        oneTimeFee: Number(document.getElementById("oneTimeFeePremium")?.value || 19900000),
        oneTimeActive: !!document.getElementById("oneTimeActivePremium")?.checked,
        features: getFeatures("premium"),
        limits: getLimits("Premium")
      }
    };

    await _saSettingsFetch('/tariffs', { method: 'POST', body: JSON.stringify(newTariffs) });

    window.allTariffs = newTariffs;
    if (typeof window.renderSystemSettingsUI === "function") {
      window.renderSystemSettingsUI();
    }

    window.logAudit("settings_change", null, t("sa_log_tariffs_changed", "Tarif narxlari va huquqlari o'zgartirildi"));

    alert(t("sa_success_settings_saved", "✅ Narxlar va huquqlar saqlandi! Barcha sahifalarda yangilandi."));

  } catch (err) {
    console.error(t("sa_err_saving_uppercase", "❌ SAQLASHDA XATOLIK:"), err);
    alert(t("sa_err_saving", "Saqlashda xatolik: ") + err.message);
  } finally {
    if (btn) btn.innerHTML = `${t("sa_btn_save_settings", "Sozlamalarni Saqlash")}`;
  }
};

// ============================================
// To'lov tizimlari API sozlamalari (Payme, Click, Uzum)
// ============================================
window.savePaymentApiSettings = async function () {
  const btn = document.querySelector("button[onclick*='savePaymentApiSettings']");
  const btnOriginalHtml = btn ? btn.innerHTML : "";
  if (btn) btn.innerHTML = t("sa_saving_wait", "Saqlanmoqda... ⏳");

  try {
    // Superadmin systemData migration, Stage 2 — security upgrade, not just
    // a permission fix: secretKey values are never sent to/from the
    // browser anymore (backend/routes/superadminSettings.js masks them as
    // "••••••••" on read). A field left showing the mask is sent through
    // AS-IS — the backend recognizes it and keeps the existing stored
    // secret unchanged; only a genuinely retyped value (no "•") overwrites
    // it. Same convention routes/notifications.js already uses for its
    // Telegram bot token.
    const readField = (id) => document.getElementById(id)?.value.trim() || "";
    const newPaymentApi = {
      payme: {
        merchantId: readField("paymeMerchantId"),
        secretKey: readField("paymeSecretKey"),
        checkoutUrl: readField("paymeCheckoutUrl")
      },
      click: {
        merchantId: readField("clickMerchantId"),
        serviceId: readField("clickServiceId"),
        secretKey: readField("clickSecretKey"),
        checkoutUrl: readField("clickCheckoutUrl")
      },
      uzum: {
        merchantId: readField("uzumMerchantId"),
        secretKey: readField("uzumSecretKey"),
        checkoutUrl: readField("uzumCheckoutUrl")
      },
    };

    const saved = await _saSettingsFetch('/payment-api', { method: 'POST', body: JSON.stringify(newPaymentApi) });
    window.paymentApiSettings = saved;
    window._saApplyPaymentApiMasked(saved);

    if (typeof window.logAudit === "function") {
      window.logAudit("settings_change", null, t("sa_log_payment_api_changed", "To'lov tizimlari API sozlamalari o'zgartirildi"));
    }

    alert(t("sa_pay_api_saved", "✅ To'lov tizimlari sozlamalari saqlandi!"));

  } catch (err) {
    console.error(t("sa_err_saving_uppercase", "❌ SAQLASHDA XATOLIK:"), err);
    alert(t("sa_err_saving", "Saqlashda xatolik: ") + err.message);
  } finally {
    if (btn) btn.innerHTML = btnOriginalHtml || `<i class="fa-solid fa-floppy-disk"></i> ${t("sa_pay_api_save_btn", "Sozlamalarni Saqlash")}`;
  }
};

// Populates the form from a masked payment-api response (never contains a
// real secretKey — only merchantId/serviceId/checkoutUrl plus a
// `configured` boolean per provider). A configured provider's secret field
// shows the "••••••••" placeholder (untouched round-trips as "keep
// existing" on save); an unconfigured one is left blank.
const _SA_SECRET_MASK = "••••••••";
window._saApplyPaymentApiMasked = function (data) {
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val || "";
  };
  const setSecret = (id, configured) => setVal(id, configured ? _SA_SECRET_MASK : "");

  setVal("paymeMerchantId", data.payme?.merchantId);
  setSecret("paymeSecretKey", data.payme?.configured);
  setVal("paymeCheckoutUrl", data.payme?.checkoutUrl);

  setVal("clickMerchantId", data.click?.merchantId);
  setVal("clickServiceId", data.click?.serviceId);
  setSecret("clickSecretKey", data.click?.configured);
  setVal("clickCheckoutUrl", data.click?.checkoutUrl);

  setVal("uzumMerchantId", data.uzum?.merchantId);
  setSecret("uzumSecretKey", data.uzum?.configured);
  setVal("uzumCheckoutUrl", data.uzum?.checkoutUrl);
};

window.loadPaymentApiSettings = function () {
  _saStartSettingsPoll('/payment-api', (data) => {
    window.paymentApiSettings = data || {};
    window._saApplyPaymentApiMasked(window.paymentApiSettings);
  });
};

// ── SuperAdmin Telegram Bot settings (routes/superadminBot.js) ────────────
// Lives under "Integratsiyalar Boshqaruvi" now (the "Telegram Bot" card),
// NOT the generic systemData/integrations/{id} mechanism the other 8 cards
// use (see intOpenModal()'s special-case below for why: this bot has real
// backend state — a live poller, an allowlist — not just one API key, so it
// keeps its own dedicated, already-working /api/superadmin/bot/settings
// route instead of the client-SDK systemData/integrations path). Same
// masked-secret round-trip as paymentApi: the token input only ever shows
// "••••••••" once configured, and saBotIntSave() only sends a fresh token
// to the backend when the field no longer holds that mask.
window.saBotIntOpenModal = function () {
  const modal = document.getElementById('saBotIntModal');
  if (modal) modal.style.display = 'flex';
  window.saBotIntRefreshStatus();
};

window.saBotIntCloseModal = function () {
  const modal = document.getElementById('saBotIntModal');
  if (modal) modal.style.display = 'none';
};

window.saBotIntRefreshStatus = async function () {
  try {
    const data = await _saBotFetch('/settings');
    window._superAdminBotSettings = data || {};
  } catch (err) {
    console.error(t("sa_err_bot_status_load", "Bot holatini yuklashda xato:"), err.message);
    window._superAdminBotSettings = window._superAdminBotSettings || {};
  }
  const data = window._superAdminBotSettings;

  const tokenEl = document.getElementById("saBotIntTokenInput");
  const enabledEl = document.getElementById("saBotIntEnabledToggle");
  const idsEl = document.getElementById("saBotIntAllowedIdsInput");
  const statusEl = document.getElementById("saBotIntStatusLine");
  if (tokenEl && document.activeElement !== tokenEl) tokenEl.value = data?.tokenConfigured ? _SA_SECRET_MASK : "";
  if (enabledEl && document.activeElement !== enabledEl) enabledEl.checked = !!data?.enabled;
  if (idsEl && document.activeElement !== idsEl) idsEl.value = (data?.allowedTelegramIds || []).join(", ");
  if (statusEl) {
    const parts = [];
    parts.push(data?.tokenConfigured ? t("sa_bot_status_token_ok", "✅ Token saqlangan") : t("sa_bot_status_token_missing", "⚠️ Token kiritilmagan"));
    parts.push(data?.enabled ? t("sa_bot_status_enabled", "🟢 Yoqilgan") : t("sa_bot_status_disabled", "⚪ O'chirilgan"));
    parts.push(t("sa_bot_status_ids_count", "Ruxsat etilgan ID'lar: {{n}}").replace("{{n}}", (data?.allowedTelegramIds || []).length));
    statusEl.textContent = parts.join(" · ");
  }
  // Reflects the real bot state on the integration card itself, not just
  // inside the modal — see intRenderGrid()'s telegram special-case.
  if (typeof window.intRenderGrid === "function") window.intRenderGrid();
};

window.saBotIntSave = async function () {
  const tokenEl = document.getElementById("saBotIntTokenInput");
  const enabledEl = document.getElementById("saBotIntEnabledToggle");
  const idsEl = document.getElementById("saBotIntAllowedIdsInput");

  const rawToken = (tokenEl?.value || "").trim();
  const allowedTelegramIds = (idsEl?.value || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^-?\d+$/.test(s));

  try {
    const saved = await _saBotFetch('/settings', {
      method: 'POST',
      body: JSON.stringify({
        token: rawToken, // backend ignores this if it still equals the mask
        enabled: !!enabledEl?.checked,
        allowedTelegramIds,
      }),
    });
    window._superAdminBotSettings = saved;
    if (tokenEl) tokenEl.value = saved?.tokenConfigured ? _SA_SECRET_MASK : "";
    window.logAudit && window.logAudit("integration_update", "Telegram Bot", t("sa_log_bot_settings_changed", "SuperAdmin bot sozlamalari o'zgartirildi"));
    if (typeof window.intRenderGrid === "function") window.intRenderGrid();
    alert(t("sa_success_msg", "Muvaffaqiyatli bajarildi!"));
    window.saBotIntCloseModal();
  } catch (err) {
    alert(t("sa_error_prefix", "Xatolik: ") + err.message);
  }
};

// Telegram error `reason` codes (backend/notifications/SuperAdminBotService.js's
// classifyTelegramError()) → i18n key + fallback text. Never show Telegram's
// raw "Bad Request: chat not found" string to the superadmin — it means
// nothing without already knowing the Bot API's error vocabulary.
const SA_BOT_TEST_ERROR_KEYS = {
  invalid_chat_id: ["sa_bot_err_invalid_chat_id", "Noto'g'ri Telegram ID."],
  chat_not_found: ["sa_bot_err_chat_not_found", "Telegram chat topilmadi. Botga /start yuboring va Telegram IDni tekshiring."],
  bot_blocked: ["sa_bot_err_bot_blocked", "Foydalanuvchi botni bloklagan."],
  not_member: ["sa_bot_err_not_member", "Bot kerakli guruh/kanalga qo'shilmagan yoki huquqi yetarli emas."],
  unauthorized: ["sa_bot_err_unauthorized", "Telegram bot tokeni noto'g'ri yoki yaroqsiz."],
  rate_limited: ["sa_bot_err_rate_limited", "Telegram API vaqtincha rate limit qo'ydi. Keyinroq urinib ko'ring."],
  network_error: ["sa_bot_err_network", "Tarmoq xatosi — qayta urinib ko'ring."],
  unknown: ["sa_bot_err_unknown", "Noma'lum xatolik. Konsolni tekshiring."],
};

function _saBotMaskId(id) {
  const s = String(id ?? '');
  if (s.length <= 4) return '•'.repeat(s.length);
  return s.slice(0, 2) + '•'.repeat(s.length - 4) + s.slice(-2);
}

// `btn` (the clicked element, passed via onclick="...(this)") is disabled
// for the duration of the request — prevents a fast double-click from
// firing two overlapping test sends (each would independently succeed and
// deliver two Telegram messages, which is harmless here but still worth
// not doing).
window.saBotIntTest = async function (btn) {
  if (btn) {
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn.disabled = true;
  }
  try {
    const result = await _saBotFetch('/test', { method: 'POST' });
    const results = Array.isArray(result?.results) ? result.results : [];
    if (result?.ok) {
      alert(t("sa_bot_test_success", "✅ Test xabar yuborildi!"));
    } else {
      const lines = results.map((r) => {
        if (r.ok) return `✅ ${_saBotMaskId(r.chatId)}`;
        const [key, fallback] = SA_BOT_TEST_ERROR_KEYS[r.reason] || SA_BOT_TEST_ERROR_KEYS.unknown;
        return `❌ ${_saBotMaskId(r.chatId)} — ${t(key, fallback)}`;
      });
      alert(`${t("sa_bot_test_partial", "⚠️ Ba'zi ID'larga yuborilmadi:")}\n${lines.join("\n")}`);
    }
  } catch (err) {
    alert(t("sa_error_prefix", "Xatolik: ") + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.dataset.busy = '0';
    }
  }
};

window.saveDiscountSettings = async function () {
  const newPlans = {
    1: { price: Number(document.getElementById('price_m1')?.value || 0), active: !!document.getElementById('active_m1')?.checked },
    3: { discount: Number(document.getElementById('disc_m3')?.value || 0), active: !!document.getElementById('active_m3')?.checked },
    6: { discount: Number(document.getElementById('disc_m6')?.value || 0), active: !!document.getElementById('active_m6')?.checked },
    12: { discount: Number(document.getElementById('disc_m12')?.value || 0), active: !!document.getElementById('active_m12')?.checked },
    lifetime: { coefficient: Number(document.getElementById('coef_mlifetime')?.value || 12), active: !!document.getElementById('active_mlifetime')?.checked }
  };

  try {
    await _saSettingsFetch('/subscription-plans', { method: 'POST', body: JSON.stringify(newPlans) });
    window.logAudit("settings_change", null, t("sa_log_discount_settings_changed", "Obuna paketlari va chegirmalar o'zgartirildi"));
    alert(t("sa_success_packages_saved", "Paketlar va chegirmalar saqlandi!"));
  } catch (err) {
    alert(t("sa_error_prefix", "Xatolik: ") + err.message);
  }
};

async function logPaymentToHistory(restName, months, method, amount) {
  await _saLogPayment({ restaurantName: restName, months: months, amount: amount, method: method });
}

window.renderPaymentHistory = renderPaymentHistory;

// ============================================
// TAHRIRLASH, BLOKLASH VA LOGIN
// ============================================
window.toggleBlockRestaurant = async function (restId, isCurrentlyBlocked) {
  const newStatus = isCurrentlyBlocked ? "active" : "blocked";

  const confirmMsg = isCurrentlyBlocked
    ? t("sa_unblock_confirm_full", "Siz rostdan ham bu restoranni qulfdan chiqarmoqchimisiz?")
    : t("sa_block_confirm_full", "Siz rostdan ham bu restoranni bloklamoqchimisiz?");

  if (!confirm(confirmMsg)) return;

  const database = window.db || (typeof db !== 'undefined' ? db : null);

  if (!database) {
    console.error(t("sa_err_db_not_found_log", "❌ Xato: Firebase Database ob'ekti topilmadi!"));
    alert(t("sa_err_db_refresh", "Ma'lumotlar bazasi bilan aloqa o'rnatib bo'lmadi. Sahifani yangilang."));
    return;
  }

  try {
    const updates = {
      "info/status": newStatus,
      "info/updatedAt": Date.now()
    };

    console.log(t("sa_log_status_changing", "📡 Restoran holati o'zgartirilmoqda: {id} -> {status}").replace("{id}", restId).replace("{status}", newStatus));

    await update(ref(database, `restaurants/${restId}`), updates);
    await update(ref(database, `restaurants_meta/${restId}`), updates);

    const restNameForLog = (window.allRestaurants?.[restId]?.info?.name) || restId;
    window.logAudit(
      newStatus === "blocked" ? "block" : "unblock",
      restNameForLog,
      newStatus === "blocked" ? t("sa_log_rest_blocked", "Restoran bloklandi") : t("sa_log_rest_unblocked", "Restoran blokdan chiqarildi")
    );

    alert(t("sa_success_msg", "Muvaffaqiyatli bajarildi!"));

    if (typeof window.renderRestaurantsTable === "function") {
      window.renderRestaurantsTable();
    }
  } catch (err) {
    console.error(t("sa_err_block_process", "❌ Bloklashda xato yuz berdi:"), err);
    alert(t("sa_error_prefix", "Xatolik: ") + (err?.message || ""));
  }
};

let editingRestaurantId = null;

window.editRestaurant = function (restId) {
  console.log(t("sa_log_edit_opening", "✏️ Tahrirlash ochilmoqda:"), restId);

  window.editingRestaurantId = restId;

  const rest = window.allRestaurants && window.allRestaurants[restId];
  if (!rest) {
    alert(t("sa_rest_not_found", "Restoran topilmadi!"));
    return;
  }

  const nameInput = document.getElementById("editRestName");
  const domainInput = document.getElementById("editRestDomain");

  if (nameInput) nameInput.value = rest.info?.name || "";
  if (domainInput) domainInput.value = rest.info?.domain || "";

  const ownerInput = document.getElementById("editRestOwner");
  const phoneInput = document.getElementById("editRestPhone");
  const emailInput = document.getElementById("editRestEmail");
  const addressInput = document.getElementById("editRestAddress");
  const licenseSelect = document.getElementById("editRestLicenseStatus");
  if (ownerInput) ownerInput.value = rest.info?.owner || "";
  if (phoneInput) phoneInput.value = rest.info?.phone || "";
  if (emailInput) emailInput.value = rest.info?.email || "";
  if (addressInput) addressInput.value = rest.info?.address || "";
  if (licenseSelect) licenseSelect.value = rest.info?.licenseStatus || "pending";

  const modal = document.getElementById("editRestaurantModal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.style.setProperty("display", "flex", "important");

    modal.style.opacity = "1";
    modal.style.visibility = "visible";
  } else {
    console.error(t("sa_err_modal_not_found", "❌ Modal topilmadi! ID: editRestaurantModal"));
  }

  _loadEditRestCredentials(restId, rest);
};

// Restoran ma'lumotidan HAQIQIY admin/owner/manager uid'ni topadi — "admin_1"
// deb qattiq belgilanmaydi. backend/routes/auth.js'dagi MANAGER_LOGIN_ROLES
// bilan bir xil rol to'plami (owner/admin/manager), loginAsRestaurantAdmin()
// bilan bir xil qidiruv naqshi. Topilmasa, "admin_1" so'nggi fallback
// sifatida qoladi (eski, hali migratsiya qilinmagan yozuvlar uchun).
function _findManagerUid(rest) {
  const users = rest?.users || {};
  const roles = new Set(["owner", "admin", "manager"]);
  for (const [uid, u] of Object.entries(users)) {
    const role = String(u?.role || "").trim().toLowerCase();
    if (roles.has(role)) return uid;
  }
  return "admin_1";
}

// ── Superadmin systemData migration (backend/routes/superadminDashboard.js,
// superadminSessions.js, superadmin2fa.js, superadminMarketing.js,
// superadminSettings.js) — every one of these used to read/write
// systemData/* directly via the client SDK; database.rules.json now closes
// that path entirely (".read":false, ".write":false, unconditional), so
// they all go through this one small authenticated-fetch helper instead.
// Same Bearer-ID-token pattern as _saGetIdTokenForEditCred()/
// superadminCredentials.js just below — kept as a separate, more generic
// helper since these call sites aren't credential-specific.
// ID-token audit fix — root-caused live from this exact sequence:
// "[SA-API] ID token olishda xato: auth/the-service-is-currently-unavailable"
// followed immediately by 401s on /revenue, /marketing/broadcast-history and
// /dashboard/audit-log, while RTDB reads (tariffs/restaurants/today-stats/
// payment-history — all separate, onValue-free polls of THIS SAME
// _saApiFetch, see _saDashFetch below) kept working. Two compounding bugs,
// both in this one function:
//   (1) `getIdToken(true)` — forceRefresh UNCONDITIONALLY, on every single
//       call. With 5 independent pollers (dashboard/sessions/2fa/marketing/
//       settings) each ticking every 30s, plus updateRevenueByFilter()'s own
//       direct call, this was a fresh forceRefresh token round-trip to
//       Firebase's token-refresh endpoint on every tick of every poller —
//       far more load than a normal SDK-cached getIdToken() ever generates,
//       and exactly the kind of self-inflicted traffic that gets back a
//       transient `auth/the-service-is-currently-unavailable`.
//   (2) On a token-acquisition failure, `token` stayed null but this
//       function sent the fetch() anyway, with NO Authorization header —
//       a guaranteed-401 request against an endpoint that requires one.
//       The "401 Unauthorized" the console showed wasn't a real
//       authorization decision at all — it never had a token to check.
// Fixed below: authStateReady() first, ONE shared in-flight token promise
// (so N concurrent callers become 1 real getIdToken() call, not N),
// getIdToken() WITHOUT forceRefresh by default (the SDK already silently
// refreshes ~5min before real expiry — force is now reserved for the one
// case that actually needs it: a 401 with a token the SDK still thought was
// valid), a short bounded retry (not infinite) on acquisition failure, and
// no fetch() is ever sent without a real token — an unavailable token is a
// thrown AUTH_TOKEN_UNAVAILABLE error, never a fabricated request.
let _saPendingTokenPromise = null;
// Tracks the last uid the [SA-AUTH-DIAG] log actually printed for — see
// that log's own comment below. `undefined` (not null) so the very first
// call, even for an unauthenticated/null uid, still logs once.
let _saAuthDiagLastLoggedUid;
const SA_TOKEN_RETRY_DELAYS_MS = [300, 800]; // 3 total attempts (1 + these 2), never unbounded

async function _saGetIdToken(forceRefresh) {
  // Forced refresh (the 401-retry path below) is rare and reactive by
  // nature — only the common, high-concurrency default path is deduped,
  // so a forced call is never held hostage waiting on an unrelated
  // in-flight default-token request.
  if (!forceRefresh && _saPendingTokenPromise) return _saPendingTokenPromise;

  const attempt = (async () => {
    try {
      await auth.authStateReady();

      // Console-spam fix: this used to log unconditionally on every single
      // _saGetIdToken() call — live-reproduced, it fired 10+ times per ~30s
      // poll cycle (5+ independent resource pollers — dashboard/sessions/
      // 2fa/marketing/settings — each calling this on its own schedule, and
      // the dedup above (_saPendingTokenPromise) only coalesces calls that
      // are truly concurrent, not ones a few ms apart from separate
      // pollers). The whole point of this diagnostic (per the original
      // "compact, localhost-only diagnostic" ask) was to answer "did auth
      // actually resolve for this session" ONCE — not to narrate every
      // routine token fetch forever. Now logs at most once per page
      // session, and again if the auth state actually CHANGES (signed out,
      // or a different uid) — a real transition is still worth seeing.
      const _isLocalDebug = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
      if (_isLocalDebug) {
        const _diagUid = auth.currentUser?.uid || null;
        if (_diagUid !== _saAuthDiagLastLoggedUid) {
          _saAuthDiagLastLoggedUid = _diagUid;
          let diagClaims = {};
          try { diagClaims = auth.currentUser ? (await auth.currentUser.getIdTokenResult())?.claims || {} : {}; } catch (_e) { /* best-effort */ }
          console.log("[SA-AUTH-DIAG]", {
            currentUserExists: !!auth.currentUser,
            uid: _diagUid,
            isAnonymous: auth.currentUser?.isAnonymous ?? null,
            provider: auth.currentUser?.providerData?.[0]?.providerId || (auth.currentUser ? "custom_token" : null),
            role: diagClaims.role ?? null,
            restId: diagClaims.restId ?? null,
            isSuperAdmin: diagClaims.isSuperAdmin ?? null,
          });
        }
      }

      // No session to recover a token FROM — this is a real "not signed in"
      // state, not a token-service hiccup. Never attempt getIdToken() with
      // no currentUser (item 3's explicit ask) — the caller (_saApiFetch)
      // treats a null return as AUTH_TOKEN_UNAVAILABLE and never sends the
      // request.
      if (!auth.currentUser) return null;

      let lastErr = null;
      for (let i = 0; i <= SA_TOKEN_RETRY_DELAYS_MS.length; i++) {
        try {
          return await auth.currentUser.getIdToken(forceRefresh);
        } catch (e) {
          lastErr = e;
          if (i < SA_TOKEN_RETRY_DELAYS_MS.length) {
            await new Promise(r => setTimeout(r, SA_TOKEN_RETRY_DELAYS_MS[i]));
          }
        }
      }
      // Distinct from a 401: this is Firebase Auth token ACQUISITION
      // failing (network/service availability), never confused in logging
      // with the backend's own authorization decision (item 7).
      console.error("[SA-API] ID token olishda xato (bounded retry tugadi):", lastErr?.code || lastErr?.message);
      return null;
    } finally {
      if (!forceRefresh) _saPendingTokenPromise = null;
    }
  })();

  if (!forceRefresh) _saPendingTokenPromise = attempt;
  return attempt;
}

async function _saApiFetch(fullPath, options = {}) {
  const token = await _saGetIdToken(false);
  if (!token) {
    // Never send a guaranteed-invalid request (item 6) — the caller (every
    // _saXFetch wrapper, every poller via _saGenericPoll) gets a clearly
    // distinct error it can recognize and back off on, instead of a fake
    // 401 that looks identical to a real backend authorization denial.
    throw new Error("AUTH_TOKEN_UNAVAILABLE: Firebase ID token hozircha mavjud emas");
  }
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    Authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  };
  let resp = await fetch(fullPath, { ...options, headers });
  // A real 401 despite a token the SDK believed was still valid usually
  // means claims changed server-side since the cached token was minted —
  // retry exactly once with a forced refresh (item 8: never on every call,
  // only when actually needed).
  if (resp.status === 401) {
    const freshToken = await _saGetIdToken(true);
    if (freshToken && freshToken !== token) {
      resp = await fetch(fullPath, { ...options, headers: { ...headers, Authorization: `Bearer ${freshToken}` } });
    }
  }
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(`${resp.status}${body?.error ? ": " + body.error : ""}`);
  }
  return resp.json();
}

// Thin, path-prefixed wrappers — unchanged call shape at every existing
// _saDashFetch() call site from the previous fix pass.
async function _saDashFetch(path, options = {}) { return _saApiFetch(`/api/superadmin/dashboard${path}`, options); }
async function _saSessionsFetch(path, options = {}) { return _saApiFetch(`/api/superadmin/sessions${path}`, options); }
async function _sa2faFetch(path, options = {}) { return _saApiFetch(`/api/superadmin/2fa${path}`, options); }
async function _saMarketingFetch(path, options = {}) { return _saApiFetch(`/api/superadmin/marketing${path}`, options); }
async function _saSettingsFetch(path, options = {}) { return _saApiFetch(`/api/superadmin/settings${path}`, options); }
// Exposed on window — same reason window.ref/window.db/window.onValue are:
// several inline, non-module <script> blocks in superadmin.html (platform/
// receipt-footer/receipt-logo/security settings) can't `import` a module-
// scoped function, only reach it via window.*.
window._saSettingsFetch = _saSettingsFetch;
window._saDashFetch = _saDashFetch;
async function _saBotFetch(path, options = {}) { return _saApiFetch(`/api/superadmin/bot${path}`, options); }

// Realtime onValue() subscriptions on systemData/* are no longer possible
// (client can't read that path at all anymore) — this replaces them with an
// immediate fetch + a periodic poll. 30s keeps the dashboard reasonably
// fresh without hammering the backend (these paths aren't updated more than
// a few times an hour in practice — new payments/audit entries).
// Replaces the 3 direct push(ref(db,"systemData/paymentHistory"),{...})
// call sites below — same field shape each caller already builds, just
// posted to the backend (Admin-SDK-backed, server sets `date`) instead of
// written directly. Best-effort/non-fatal on failure, same as before (a
// failed history record must never block the license/restaurant action
// itself finishing).
async function _saLogPayment(record) {
  try {
    await _saDashFetch('/payment-history', { method: 'POST', body: JSON.stringify(record) });
  } catch (err) {
    console.error(t("sa_err_payment_log", "To'lov tarixini yozishda xato:"), err.message);
  }
}

// Generic version — takes a fetcher function instead of assuming the
// dashboard-router prefix, so it works for any of the new routers
// (sessions/2fa/marketing/settings) too. `_saStartDashPoll` below is kept
// as a thin wrapper so every existing call site from the previous fix pass
// is unchanged.
//
// Superadmin polling 429-storm fix. Root cause traced live: this function
// used to create a brand-new setInterval on every single call, with zero
// awareness of any other poller already covering the same resource — two
// different callers polling the same endpoint (listenPaymentHistory()'s
// internal second poll and listenAuditLog(), both /audit-log) silently
// doubled that resource's request rate, and any call site invoked more
// than once per page (e.g. listenDiscountSettings() re-run after
// "reset to defaults") permanently stacked one more interval for the rest
// of the tab's life. None of this raised or removed any rate limit — the
// fix is entirely about not sending more requests than each resource
// actually needs.
//
// `key` identifies the RESOURCE being polled (not the caller) — every
// _saStartXPoll() wrapper below derives it from the resource path, so two
// callers asking for the same path always collide onto one shared
// interval. A second registration for a key that's already active does
// NOT start a new interval; it just adds this caller's own `onData` to the
// existing poller's listener set, so every current consumer keeps
// receiving the same data it already does — nothing UI-visible changes.
const _saActivePolls = new Map(); // key -> { listeners:Set<fn>, intervalId, inFlight, backoffTicks, lastData }

function _saGenericPoll(key, fetcher, onData, intervalMs = 30000) {
  const existing = _saActivePolls.get(key);
  if (existing) {
    existing.listeners.add(onData);
    // Hand the new subscriber whatever we already have rather than making
    // it wait up to `intervalMs` for the shared poller's next tick — only
    // when a real fetch has actually completed at least once.
    if (existing.lastData !== undefined) onData(existing.lastData);
    return () => _saUnsubscribePoll(key, onData);
  }

  const entry = { listeners: new Set([onData]), intervalId: null, inFlight: false, backoffTicks: 0, lastData: undefined };
  _saActivePolls.set(key, entry);

  async function tick() {
    if (entry.inFlight) return; // previous request for this resource still pending — never overlap requests
    if (entry.backoffTicks > 0) { entry.backoffTicks--; return; } // cooling off after a 429 — real errors are never suppressed, only this specific case waits
    entry.inFlight = true;
    try {
      const data = await fetcher();
      entry.lastData = data;
      entry.listeners.forEach(fn => {
        try { fn(data); } catch (e) { console.error(`[SA-POLL] listener error (${key}):`, e.message); }
      });
    } catch (err) {
      const msg = err.message || "";
      if (/^429\b/.test(msg)) {
        entry.backoffTicks = 2; // skip the next 1-2 scheduled ticks instead of hammering again on the very next one
        console.warn(`[SA-POLL] 429 for ${key} — backing off ${entry.backoffTicks} tick(s)`);
      } else if (/^AUTH_TOKEN_UNAVAILABLE\b/.test(msg)) {
        // Auth-availability backoff (item 12): _saGetIdToken() already ran
        // its own short bounded retry before ever surfacing this — by the
        // time it reaches here, hammering the very next 30s tick again
        // is unlikely to fare any better if Firebase Auth's token service
        // itself is genuinely degraded. Back off a bit longer than a plain
        // 429 (which is usually gone within one tick); auth recovering is
        // a slower, less predictable event. Never permanent — the poll
        // resumes normal cadence on its own once a tick succeeds again.
        entry.backoffTicks = 4;
        console.warn(`[SA-POLL] auth token unavailable for ${key} — backing off ${entry.backoffTicks} tick(s)`);
      } else {
        console.error(`[SA-POLL] poll failed (${key}):`, msg);
      }
    } finally {
      entry.inFlight = false;
    }
  }

  tick();
  entry.intervalId = setInterval(tick, intervalMs);
  return () => _saUnsubscribePoll(key, onData);
}

function _saUnsubscribePoll(key, onData) {
  const entry = _saActivePolls.get(key);
  if (!entry) return;
  entry.listeners.delete(onData);
  if (entry.listeners.size === 0) {
    clearInterval(entry.intervalId);
    _saActivePolls.delete(key);
  }
}

function _saStartDashPoll(path, onData, intervalMs = 30000) {
  return _saGenericPoll(`dashboard:${path}`, () => _saDashFetch(path), onData, intervalMs);
}
function _saStartSessionsPoll(path, onData, intervalMs = 30000) {
  return _saGenericPoll(`sessions:${path}`, () => _saSessionsFetch(path), onData, intervalMs);
}
function _saStart2faPoll(path, onData, intervalMs = 30000) {
  return _saGenericPoll(`2fa:${path}`, () => _sa2faFetch(path), onData, intervalMs);
}
function _saStartMarketingPoll(path, onData, intervalMs = 30000) {
  return _saGenericPoll(`marketing:${path}`, () => _saMarketingFetch(path), onData, intervalMs);
}
function _saStartSettingsPoll(path, onData, intervalMs = 30000) {
  return _saGenericPoll(`settings:${path}`, () => _saSettingsFetch(path), onData, intervalMs);
}

// ── "Login ma'lumotlari" (Restoranni Tahrirlash oynasi, FAQAT ko'rsatish
// uchun — bu maydonlar orqali login/parol o'zgartirilmaydi, saveEditedRestaurant()
// ularni hech qachon o'qimaydi). Mavjud backend endpointlaridan qayta
// foydalaniladi (backend/routes/superadminCredentials.js — status/reveal) —
// yangi authentication yoki credential endpoint yaratilmagan. Parolning
// o'zi hech qachon console.log/localStorage/sessionStorage/URL'ga
// yozilmaydi — faqat shu ikkita input elementining DOM qiymatiga.
window._editRestCredRestId = null;
window._editRestCredUid = null;
window._editRestCredPlain = null;
window._editRestCredRevealed = false;

async function _saGetIdTokenForEditCred() {
  try {
    // forceRefresh=true — hech qachon eskirgan/keshlangan tokenga
    // tayanmaslik uchun; requireSuperAdmin() aynan JORIY sessiya
    // claim'larini ko'rishi kerak.
    return auth?.currentUser ? await auth.currentUser.getIdToken(true) : null;
  } catch (e) {
    console.error("[EDIT-CRED] ID token olishda xato:", e.message);
    return null;
  }
}

async function _loadEditRestCredentials(restId, rest) {
  const uid = _findManagerUid(rest);
  window._editRestCredRestId = restId;
  window._editRestCredUid = uid;
  window._editRestCredPlain = null;
  window._editRestCredRevealed = false;

  const loginField = document.getElementById("restCredLoginField");
  const passField = document.getElementById("restCredPasswordField");
  const toggleBtn = document.getElementById("restCredPasswordToggle");
  if (toggleBtn) toggleBtn.style.display = "none";

  // 4-band: DOM elementlari haqiqatan mavjudligini va boshlang'ich
  // holatini tasdiqlash (parolning o'zi emas, faqat meta-holat).
  console.log(
    `[EDIT-CRED] DOM check: loginFieldExists=${!!loginField} passFieldExists=${!!passField} ` +
    (loginField ? `loginField(disabled=${loginField.disabled}, readOnly=${loginField.readOnly}, type=${loginField.type}) ` : "") +
    (passField ? `passField(disabled=${passField.disabled}, readOnly=${passField.readOnly}, type=${passField.type})` : "")
  );

  if (loginField) loginField.value = t("sa_loading", "Yuklanmoqda...");
  if (passField) { passField.type = "text"; passField.value = t("sa_loading", "Yuklanmoqda..."); }

  try {
    const token = await _saGetIdTokenForEditCred();
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

    const statusResp = await fetch(
      `/api/superadmin/credentials/${encodeURIComponent(restId)}/${encodeURIComponent(uid)}/status`,
      { headers: authHeaders }
    );
    const statusBody = await statusResp.json().catch(() => ({}));

    // Vaqtinchalik, xavfsiz diagnostika — parol/hash/token HECH QACHON
    // yo'q, faqat holat/mavjudlik ma'lumoti. Konsolda "Object" deb
    // yig'ilib qolmasligi uchun (ba'zi konsollarda kengaytirmasdan
    // ko'chirilganda shunday chiqadi) — bitta tekis matn qatori sifatida
    // ham chiqaramiz, xuddi shu ma'lumot bilan.
    console.log(
      `[EDIT-CRED] status: restId=${restId} uid=${uid} httpStatus=${statusResp.status} ok=${statusResp.ok} hadToken=${!!token} responseKeys=${JSON.stringify(Object.keys(statusBody || {}))} loginPresent=${typeof statusBody?.login === "string" && statusBody.login.length > 0} hasEncryptedPassword=${statusBody?.hasEncryptedPassword === true} error=${statusBody?.error || "null"}`
    );

    // Shu orada superadmin boshqa restoranni tahrirlashga o'tgan bo'lishi
    // mumkin — eskirgan javob endi noto'g'ri oynaga yozilib qolmasin.
    if (window._editRestCredRestId !== restId || window._editRestCredUid !== uid) return;

    if (!statusResp.ok) {
      // Haqiqiy sababni to'g'ridan-to'g'ri UI'ning o'zida ko'rsatamiz — HTTP
      // status kodi + backend error matni (agar bo'lsa) — shunda muammoni
      // konsolni ochmasdan, modalning o'zidan ko'rish mumkin.
      const reason = `(${statusResp.status}${statusBody?.error ? ": " + statusBody.error : ""})`;
      if (loginField) loginField.value = `${t("sa_cred_not_available", "Login ma'lumoti mavjud emas")} ${reason}`;
      if (passField) passField.value = `${t("sa_edit_cred_password_unavailable", "Parol mavjud emas")} ${reason}`;
      return;
    }

    // 5-band: body.login qiymati to'g'ridan-to'g'ri #restCredLoginField ga.
    if (loginField) {
      loginField.value = statusBody.login || t("sa_cred_not_available", "Login ma'lumoti mavjud emas");
      // Login parol emas — xavfsiz, DOM'ga haqiqatan nima yozilganini
      // to'g'ridan-to'g'ri tasdiqlash uchun ko'rsatiladi.
      console.log(`[EDIT-CRED] DOM write: restCredLoginField.value="${loginField.value}"`);
    }

    if (!statusBody.hasEncryptedPassword) {
      if (passField) passField.value = t("sa_edit_cred_password_unavailable", "Parol mavjud emas");
      return;
    }

    const revealResp = await fetch(
      `/api/superadmin/credentials/${encodeURIComponent(restId)}/${encodeURIComponent(uid)}/reveal`,
      { method: "POST", headers: authHeaders }
    );
    const revealBody = await revealResp.json().catch(() => ({}));

    console.log(
      `[EDIT-CRED] reveal: restId=${restId} uid=${uid} httpStatus=${revealResp.status} ok=${revealResp.ok} responseKeys=${JSON.stringify(Object.keys(revealBody || {}))} passwordKeyPresent=${typeof revealBody?.password === "string"} error=${revealBody?.error || "null"}`
    );

    if (window._editRestCredRestId !== restId || window._editRestCredUid !== uid) return;

    if (!revealResp.ok || !revealBody.password) {
      const reason = `(${revealResp.status}${revealBody?.error ? ": " + revealBody.error : ""})`;
      if (passField) passField.value = `${t("sa_edit_cred_password_unavailable", "Parol mavjud emas")} ${reason}`;
      return;
    }

    // body.password qiymati to'g'ridan-to'g'ri #restCredPasswordField ga —
    // lekin DASTLAB maskalangan holatda (type="password"); 👁 tugmasi
    // bosilgandagina ochiq matn sifatida ko'rsatiladi.
    window._editRestCredPlain = revealBody.password;
    window._editRestCredRevealed = false;
    if (passField) {
      passField.type = "password";
      passField.value = window._editRestCredPlain;
      // Parolning O'ZI emas — faqat DOM'ga haqiqatan yozilgan qiymat
      // uzunligi, yozuv haqiqatan sodir bo'lganini tasdiqlash uchun.
      console.log(`[EDIT-CRED] DOM write: restCredPasswordField written, length=${passField.value.length}, type=${passField.type}`);
    }
    if (toggleBtn) {
      toggleBtn.style.display = "";
      toggleBtn.innerHTML = '<i class="fa-solid fa-eye"></i>';
      toggleBtn.title = t("show_label", "Ko'rsatish");
    }
  } catch (err) {
    // Bu — HTTP status ham yo'q holat (tarmoq darajasidagi xato: fetch()ning
    // o'zi bajarilmadi — masalan ulanish uzilishi). Xabarga aynan shu
    // sababni ham qo'shamiz.
    console.error("[EDIT-CRED] credential fetch failed:", err.message);
    if (window._editRestCredRestId === restId && window._editRestCredUid === uid) {
      const reason = `(tarmoq xatosi: ${err.message})`;
      if (loginField) loginField.value = `${t("sa_cred_not_available", "Login ma'lumoti mavjud emas")} ${reason}`;
      if (passField) passField.value = `${t("sa_edit_cred_password_unavailable", "Parol mavjud emas")} ${reason}`;
    }
  }
}

window.toggleRestCredPassword = function () {
  const passField = document.getElementById("restCredPasswordField");
  const toggleBtn = document.getElementById("restCredPasswordToggle");
  if (!passField || window._editRestCredPlain == null) return;

  window._editRestCredRevealed = !window._editRestCredRevealed;
  if (window._editRestCredRevealed) {
    passField.type = "text";
    passField.value = window._editRestCredPlain;
    if (toggleBtn) {
      toggleBtn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
      toggleBtn.title = t("hide_label", "Yashirish");
    }
  } else {
    passField.type = "password";
    passField.value = window._editRestCredPlain;
    if (toggleBtn) {
      toggleBtn.innerHTML = '<i class="fa-solid fa-eye"></i>';
      toggleBtn.title = t("show_label", "Ko'rsatish");
    }
  }
};

window.closeEditRestaurantModal = function () {
  const modal = document.getElementById("editRestaurantModal");
  if (modal) {
    modal.classList.add("hidden");
    modal.style.setProperty("display", "none", "important");
  }
  window._editRestCredRestId = null;
  window._editRestCredUid = null;
  window._editRestCredPlain = null;
  window._editRestCredRevealed = false;
};

// (Restoran login ma'lumotlari / credential modal funksiyasi butunlay olib
// tashlandi — superadmin panelida bu funksiya endi kerak emas, chunki
// universal /login.html restoran va foydalanuvchini o'zi, backend orqali
// aniqlaydi. Tegishli backend endpointlar (backend/routes/
// superadminCredentials.js) bu turda o'chirilmadi — ular boshqa hech qanday
// kod tomonidan ishlatilmaydi, pastdagi yakuniy hisobotda alohida qayd
// etilgan, sizning tasdig'ingizdan keyin o'chirilishi mumkin.)

// ============================================
// 🔑 LITSENZIYA MODAL (Holati / Turi / Boshlangan / Tugash / Faollashtirgan
//    + Litsenziya berish / Uzaytirish / Bloklash)
// ============================================
window._licenseTargetId = null;

// Helper: joriy litsenziya holatini restoran ma'lumotlaridan hisoblash.
// expireAt hisobi table qatoridagi bilan bir xil bo'lishi kerak (sub.expireDate || sub.expireAt).
window._computeLicenseInfo = function (rest) {
  const info = (rest && rest.info) || {};
  const sub = (rest && rest.subscription) || {};
  const now = Date.now();
  const expireAt = Number(sub.expireDate || sub.expireAt || 0);
  const isLifetime = !!sub.oneTimePaid;
  const isBlocked = info.status === "blocked";
  const hasAnyLicense = isLifetime || expireAt > 0;
  const isActive = !isBlocked && (isLifetime || expireAt > now);
  return { info, sub, now, expireAt, isLifetime, isBlocked, hasAnyLicense, isActive };
};

window.openLicenseModal = function (restId, restName) {
  window._licenseTargetId = restId;
  const rest = window.allRestaurants && window.allRestaurants[restId];
  const nameEl = document.getElementById("licenseModalRestName");
  if (nameEl) nameEl.textContent = "🏪 " + restName;

  const li = window._computeLicenseInfo(rest || {});

  // Holati
  const statusEl = document.getElementById("licInfoStatus");
  if (statusEl) {
    if (li.isBlocked) {
      statusEl.textContent = t("sa_lic_status_blocked", "🚫 Bloklangan");
      statusEl.style.color = "#dc2626";
    } else if (li.isActive) {
      statusEl.textContent = t("sa_active_short", "Faol");
      statusEl.style.color = "#059669";
    } else if (li.hasAnyLicense) {
      statusEl.textContent = t("sa_license_expired", "❌ Amal qilmaydi");
      statusEl.style.color = "#dc2626";
    } else {
      statusEl.textContent = t("sa_license_none", "— Yo'q");
      statusEl.style.color = "#9ca3af";
    }
  }

  // Turi
  const typeEl = document.getElementById("licInfoType");
  if (typeEl) {
    if (li.isLifetime) typeEl.innerHTML = `<i class="fa-solid fa-infinity"></i> ${t("sa_license_lifetime", "Doimiy")}`;
    else if (li.expireAt > 0) typeEl.textContent = t("sa_lic_type_period", "Muddatli");
    else typeEl.textContent = "—";
  }

  // Boshlangan
  const startedEl = document.getElementById("licInfoStarted");
  if (startedEl) {
    startedEl.textContent = li.sub.licenseStartedAt
      ? new Date(li.sub.licenseStartedAt).toLocaleDateString('ru-RU')
      : "—";
  }

  // Tugash
  const expiresEl = document.getElementById("licInfoExpires");
  if (expiresEl) {
    if (li.isLifetime) expiresEl.textContent = "∞";
    else if (li.expireAt > 0) expiresEl.textContent = new Date(li.expireAt).toLocaleDateString('ru-RU');
    else expiresEl.textContent = "—";
  }

  // Faollashtirgan
  const activatedByEl = document.getElementById("licInfoActivatedBy");
  if (activatedByEl) activatedByEl.textContent = li.sub.activatedBy || "—";

  // Tugma holatlari:
  // "Litsenziya berish" — faqat litsenziya YO'Q bo'lganda ko'rinadi/aktiv
  // "Uzaytirish" — Doimiy (∞) litsenziyada kerak emas (uzaytiradigan narsa yo'q)
  const grantBtn = document.getElementById("licBtnGrant");
  const extendBtn = document.getElementById("licBtnExtend");
  if (grantBtn) {
    grantBtn.style.display = li.hasAnyLicense ? "none" : "inline-flex";
  }
  if (extendBtn) {
    extendBtn.style.display = (!li.hasAnyLicense || li.isLifetime) ? "none" : "inline-flex";
  }

  const modal = document.getElementById("licenseModal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.style.setProperty("display", "flex", "important");
  }
};

window.closeLicenseModal = function () {
  const modal = document.getElementById("licenseModal");
  if (modal) {
    modal.classList.add("hidden");
    modal.style.setProperty("display", "none", "important");
  }
  window._licenseTargetId = null;
};

// ── Bloklash (litsenziya modali ichidan) ──────────────────────────
// toggleBlockRestaurant bilan bir xil yozish patternini takrorlaydi.
window.blockLicense = async function () {
  const restId = window._licenseTargetId;
  if (!restId) return;
  const rest = window.allRestaurants?.[restId];
  const alreadyBlocked = rest?.info?.status === "blocked";

  if (alreadyBlocked) {
    alert(t("sa_lic_already_blocked", "Bu restoran allaqachon bloklangan."));
    return;
  }

  const confirmMsg = t("sa_block_confirm_full", "Siz rostdan ham bu restoranni bloklamoqchimisiz?");
  if (!confirm(confirmMsg)) return;

  const database = window.db || (typeof db !== 'undefined' ? db : null);
  if (!database) {
    console.error(t("sa_err_db_not_found_log", "❌ Xato: Firebase Database ob'ekti topilmadi!"));
    alert(t("sa_err_db_refresh", "Ma'lumotlar bazasi bilan aloqa o'rnatib bo'lmadi. Sahifani yangilang."));
    return;
  }

  try {
    const updates = { "info/status": "blocked", "info/updatedAt": Date.now() };
    await update(ref(database, `restaurants/${restId}`), updates);
    await update(ref(database, `restaurants_meta/${restId}`), updates);

    const restNameForLog = rest?.info?.name || restId;
    window.logAudit("block", restNameForLog, t("sa_log_rest_blocked", "Restoran bloklandi"));

    alert(t("sa_success_msg", "Muvaffaqiyatli bajarildi!"));
    window.closeLicenseModal();
    if (typeof window.renderRestaurantsTable === "function") window.renderRestaurantsTable();
  } catch (err) {
    console.error(t("sa_err_block_process", "❌ Bloklashda xato yuz berdi:"), err);
    alert(t("sa_error_prefix", "Xatolik: ") + (err?.message || ""));
  }
};

// ============================================
// 🔑 LITSENZIYA MUDDAT TANLASH MODALI
//    ("Litsenziya berish" va "Uzaytirish" ikkalasida ham ishlatiladi)
// ============================================
window._licenseDurationMode = null; // 'grant' | 'extend'

window._licenseDurationMs = function (code, fromTs) {
  const d = new Date(fromTs);
  switch (code) {
    case "1m": d.setMonth(d.getMonth() + 1); return d.getTime();
    case "3m": d.setMonth(d.getMonth() + 3); return d.getTime();
    case "6m": d.setMonth(d.getMonth() + 6); return d.getTime();
    case "1y": d.setFullYear(d.getFullYear() + 1); return d.getTime();
    default: return null;
  }
};

window.openLicenseDurationModal = function (mode) {
  const restId = window._licenseTargetId;
  if (!restId) return;
  const rest = window.allRestaurants?.[restId];
  if (!rest) return;

  window._licenseDurationMode = mode; // 'grant' | 'extend'
  const li = window._computeLicenseInfo(rest);

  const titleEl = document.getElementById("licDurTitle");
  const confirmBtn = document.getElementById("licDurConfirmBtn");
  if (mode === "grant") {
    if (titleEl) titleEl.textContent = t("sa_lic_dur_grant_title", "Litsenziya berish");
    if (confirmBtn) confirmBtn.textContent = t("sa_lic_btn_grant", "Litsenziya berish");
  } else {
    if (titleEl) titleEl.textContent = t("sa_lic_dur_extend_title", "Litsenziyani uzaytirish");
    if (confirmBtn) confirmBtn.textContent = t("sa_lic_btn_extend", "Uzaytirish");
  }

  const restNameEl = document.getElementById("licDurRestName");
  if (restNameEl) restNameEl.textContent = rest.info?.name || t("sa_unknown", "Noma'lum");

  // "Joriy litsenziya" / "Joriy tugash sanasi" — faqat Uzaytirish rejimida mazmunli
  const currentWrap = document.getElementById("licDurCurrentWrap");
  const currentExpireWrap = document.getElementById("licDurCurrentExpireWrap");
  const currentTypeEl = document.getElementById("licDurCurrentType");
  const currentExpireEl = document.getElementById("licDurCurrentExpire");

  if (mode === "extend" && li.hasAnyLicense) {
    if (currentWrap) currentWrap.style.display = "";
    if (currentExpireWrap) currentExpireWrap.style.display = "";
    if (currentTypeEl) {
      currentTypeEl.textContent = li.isLifetime
        ? t("sa_license_lifetime", "Doimiy")
        : t("sa_lic_type_period", "Muddatli");
    }
    if (currentExpireEl) {
      currentExpireEl.textContent = li.isLifetime
        ? "∞"
        : (li.expireAt > 0 ? new Date(li.expireAt).toLocaleDateString('ru-RU') : "—");
    }
  } else {
    if (currentWrap) currentWrap.style.display = "none";
    if (currentExpireWrap) currentExpireWrap.style.display = "none";
  }

  // Radio va izohni tozalash
  document.querySelectorAll(".licDurRadio").forEach(r => r.checked = false);

  // Sozlamalardagi litsenziya muddatlaridan narx va Faol holatini qo'llash
  const plans = window.subscriptionPlans || {};
  const fmt = (n) => Math.round(n).toLocaleString('ru-RU') + " " + t("sa_currency_uzs", "so'm");
  const basePrice = Number(plans[1]?.price || 0);

  const priceDefs = {
    "1m": { planKey: 1, price: basePrice },
    "3m": { planKey: 3, price: basePrice * 3 * (1 - Number(plans[3]?.discount || 0) / 100) },
    "6m": { planKey: 6, price: basePrice * 6 * (1 - Number(plans[6]?.discount || 0) / 100) },
    "1y": { planKey: 12, price: basePrice * 12 * (1 - Number(plans[12]?.discount || 0) / 100) },
    "lifetime": { planKey: "lifetime", price: basePrice * Number(plans.lifetime?.coefficient || 12) }
  };

  Object.keys(priceDefs).forEach(code => {
    const wrap = document.getElementById(`licDurOptWrap_${code}`);
    const priceEl = document.getElementById(`licDurPrice_${code}`);
    const isActive = !!plans[priceDefs[code].planKey]?.active;
    if (wrap) wrap.style.display = isActive ? "flex" : "none";
    if (priceEl) priceEl.textContent = isActive ? fmt(priceDefs[code].price) : "";
  });

  const modal = document.getElementById("licenseDurationModal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.style.setProperty("display", "flex", "important");
  }
};

window.closeLicenseDurationModal = function () {
  const modal = document.getElementById("licenseDurationModal");
  if (modal) {
    modal.classList.add("hidden");
    modal.style.setProperty("display", "none", "important");
  }
};

window.confirmLicenseDuration = async function () {
  const restId = window._licenseTargetId;
  const mode = window._licenseDurationMode;
  if (!restId || !mode) return;

  const selectedRadio = document.querySelector(".licDurRadio:checked");
  if (!selectedRadio) {
    alert(t("sa_lic_dur_select_required", "Iltimos, uzaytirish turini tanlang."));
    return;
  }
  const code = selectedRadio.value;
  const now = Date.now();

  const rest = window.allRestaurants?.[restId];
  const li = window._computeLicenseInfo(rest || {});
  // Uzaytirish — muddat allaqachon tugagan bo'lsa bugundan, aks holda joriy tugash sanasidan qo'shiladi
  const extendBaseTs = (mode === "extend" && li.expireAt > now) ? li.expireAt : now;

  let newExpireAt = null;   // number | null (null = Doimiy)
  let isLifetime = false;

  if (code === "lifetime") {
    isLifetime = true;
  } else {
    newExpireAt = window._licenseDurationMs(code, mode === "extend" ? extendBaseTs : now);
    if (!newExpireAt) {
      alert(t("sa_lic_dur_select_required", "Iltimos, uzaytirish turini tanlang."));
      return;
    }
  }

  const confirmMsg = mode === "grant"
    ? t("sa_lic_grant_confirm", "Ushbu restoranga litsenziya berilsinmi?")
    : t("sa_lic_extend_confirm", "Litsenziya muddatini uzaytirishni tasdiqlaysizmi?");
  if (!confirm(confirmMsg)) return;

  const database = window.db || (typeof db !== 'undefined' ? db : null);
  if (!database) {
    console.error(t("sa_err_db_not_found_log", "❌ Xato: Firebase Database ob'ekti topilmadi!"));
    alert(t("sa_err_db_refresh", "Ma'lumotlar bazasi bilan aloqa o'rnatib bo'lmadi. Sahifani yangilang."));
    return;
  }

  const actorName = window._auditActorName || auth?.currentUser?.email || sessionStorage.getItem("name") || "SuperAdmin";

  try {
    const subUpdates = {
      "subscription/oneTimePaid": isLifetime,
      "subscription/expireDate": isLifetime ? null : newExpireAt,
      "subscription/activatedBy": actorName,
      "subscription/updatedAt": now,
      "subscription/lastLicensePeriodCode": code,
      "info/updatedAt": now
    };
    // "Litsenziya berish" — yangi litsenziya, boshlanish sanasini bugundan qo'yamiz.
    // "Uzaytirish" — mavjud litsenziyani davom ettiradi, boshlanish sanasi o'zgarmaydi.
    if (mode === "grant") {
      subUpdates["subscription/licenseStartedAt"] = now;
      // Bloklangan bo'lsa, litsenziya berilganda avtomatik blokdan chiqarish
      subUpdates["info/status"] = "active";
    }

    await update(ref(database, `restaurants/${restId}`), subUpdates);
    await update(ref(database, `restaurants_meta/${restId}`), subUpdates);

    const restNameForLog = rest?.info?.name || restId;
    const actionLabel = mode === "grant"
      ? t("sa_log_license_granted", "Litsenziya berildi")
      : t("sa_log_license_extended", "Litsenziya uzaytirildi");
    const detailSuffix = isLifetime ? " → Doimiy (∞)" : ` → ${new Date(newExpireAt).toLocaleDateString('ru-RU')}`;
    window.logAudit(mode === "grant" ? "license_grant" : "license_extend", restNameForLog, actionLabel + detailSuffix + (comment ? ` | ${comment}` : ""));

    alert(t("sa_success_msg", "Muvaffaqiyatli bajarildi!"));
    window.closeLicenseDurationModal();

    // Ortidagi litsenziya modalini yangilangan ma'lumot bilan qayta ochish
    if (typeof window.renderRestaurantsTable === "function") window.renderRestaurantsTable();
    const refreshedRest = window.allRestaurants?.[restId];
    if (refreshedRest) window.openLicenseModal(restId, refreshedRest.info?.name || restNameForLog);
  } catch (err) {
    console.error(t("sa_err_license_save", "Litsenziyani saqlashda xato:"), err);
    alert(t("sa_error_prefix", "Xatolik: ") + (err?.message || ""));
  }
};

window.saveEditedRestaurant = async function () {
  const restId = window.editingRestaurantId;
  if (!restId) return;

  const name = document.getElementById("editRestName").value.trim();
  const domain = document.getElementById("editRestDomain").value.trim().toLowerCase();

  const oldRest = window.allRestaurants?.[restId];
  const oldName = oldRest?.info?.name || '';
  const oldDomain = oldRest?.info?.domain || '';

  const translate = (key, def) => (typeof t === 'function' ? t(key, def) : def);

  if (!name || !domain) {
    alert(translate("sa_fill_all_fields", "Iltimos, barcha maydonlarni to'ldiring!"));
    return;
  }

  const isDomainTaken = Object.entries(window.allRestaurants || {}).some(([id, r]) => {
    return id !== restId && (r.info?.domain || "") === domain;
  });

  if (isDomainTaken) {
    alert(`"${domain}.nestacrm.uz" ${translate("sa_domain_taken", "subdomeni allaqachon boshqa restoran tomonidan band qilingan.")}`);
    return;
  }

  const btn = document.querySelector("#editRestaurantModal .btn-primary");
  const originalText = btn ? btn.innerText : "";
  if (btn) {
    btn.innerText = translate("sa_saving", "Saqlanmoqda...");
    btn.disabled = true;
  }

  try {
    const database = window.db;

    const newBusinessType = oldRest?.info?.businessType || "restaurant";
    const owner = document.getElementById("editRestOwner")?.value.trim() || "";
    const phone = document.getElementById("editRestPhone")?.value.trim() || "";
    const email = document.getElementById("editRestEmail")?.value.trim() || "";
    const address = document.getElementById("editRestAddress")?.value.trim() || "";
    const licenseStatus = document.getElementById("editRestLicenseStatus")?.value || "pending";

    const infoUpdates = {
      name: name,
      domain: domain,
      businessType: newBusinessType,
      owner: owner,
      phone: phone,
      email: email,
      address: address,
      licenseStatus: licenseStatus,
      updatedAt: Date.now()
    };

    await update(ref(database, `restaurants/${restId}/info`), infoUpdates);

    // restaurants_meta/{restId}/info write removed here (permission_denied
    // fix): restaurants_meta has zero coverage anywhere in
    // database.rules.json (falls under the root default-deny), and a full
    // repo trace found no reader of it anywhere — frontend or backend. It
    // was a write-only mirror of the line above, never read back by
    // anything. restaurants/${restId}/info (just above) is the actual
    // canonical, actively-read path (admin.js, the dashboard endpoint,
    // renderRestaurantsTable(), login.js all read it). Removing this dead
    // write also fixes the side effect it was causing: since this was the
    // second of three sequential awaits with only one outer catch, its
    // failure was skipping the settings.restaurantName sync below and the
    // whole success path, even though the real write one line up had
    // already succeeded.
    await update(ref(database, `restaurants/${restId}/settings`), {
      restaurantName: name
    });

    const changeParts = [];
    if (oldName && oldName !== name) changeParts.push(`${t("sa_log_name_label", "Nomi")}: "${oldName}" → "${name}"`);
    if (oldDomain && oldDomain !== domain) changeParts.push(`${t("sa_log_domain_label", "Domen")}: "${oldDomain}" → "${domain}"`);
    window.logAudit(
      oldDomain !== domain ? "domain_change" : "edit",
      name,
      changeParts.length ? changeParts.join('; ') : t("sa_log_data_edited", "Ma'lumotlar tahrirlandi")
    );

    alert(translate("sa_changes_saved", "✅ O'zgarishlar muvaffaqiyatli saqlandi!"));
    window.closeEditRestaurantModal();

    if (typeof window.renderRestaurantsTable === "function") {
      window.renderRestaurantsTable();
    }
  } catch (error) {
    console.error(t("sa_err_edit", "Tahrirlashda xatolik:"), error);
    alert(translate("sa_network_error", "Xatolik yuz berdi. Konsolni tekshiring."));
  } finally {
    if (btn) {
      btn.innerText = originalText;
      btn.disabled = false;
    }
  }
};

function escapeHtml(unsafe) {
  if (!unsafe) return "";
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

window.loginAsRestaurantAdmin = async function (restId) {
  try {
    console.log(t("sa_log_search_admin", "🔍 Restoran adminini qidirish:"), restId);

    const restaurantData = window.allRestaurants && window.allRestaurants[restId];

    if (!restaurantData) {
      alert(t("sa_err_rest_not_found_mem", "Restoran ma'lumotlari xotirada topilmadi. Sahifani yangilang."));
      return;
    }

    if (!restaurantData.users) {
      alert(typeof t === 'function' ? t("sa_err_no_admin_account", "Ushbu restoran uchun hali xodim/admin akkaunti yaratilmagan.") : "Admin akkaunti topilmadi.");
      return;
    }

    const users = restaurantData.users;
    let adminId = null;
    let adminName = typeof t === 'function' ? t("sa_default_admin", "Admin") : "Admin";

    for (const [uId, user] of Object.entries(users)) {
      if (user.role === 'admin' || (user.permissions && user.permissions.includes('all'))) {
        adminId = uId;
        adminName = user.name || (typeof t === 'function' ? t("sa_default_admin", "Admin") : "Admin");
        break;
      }
    }

    if (!adminId) {
      const userKeys = Object.keys(users);
      if (userKeys.length > 0) {
        adminId = userKeys[0];
        adminName = users[userKeys[0]].name || (typeof t === 'function' ? t("sa_default_staff", "Xodim") : "Staff");
      } else {
        alert(typeof t === 'function' ? t("sa_err_no_admin_account", "Restoranda foydalanuvchilar yo'q.") : "Foydalanuvchilar topilmadi.");
        return;
      }
    }

    // restaurantId localStorage'da qoladi (barcha tab'lar uchun umumiy —
    // bitta restoran bilan ishlash odatiy holat). userId/role esa endi
    // localStorage'ga YOZILMAYDI — buning o'rniga admin.html'ga ?viewAs=
    // va ?viewAsRole= URL parametrlari orqali uzatiladi. MUHIM SABAB: bu
    // yangi tabda ochiladi (window.open bilan); agar userId/role
    // localStorage'ga yozilsa, ular BARCHA ochiq tab'larga (masalan
    // superadmin allaqachon ochiq boshqa tab, yoki admin sifatida ishlab
    // turgan boshqa tab) "sizib o'tib", ularning sessiyasini buzishi mumkin
    // edi. viewAs esa faqat YANGI ochilgan, mustaqil tabga tegishli.
    localStorage.setItem("restaurantId", restId);

    // Auth root-cause fix pass: this used to open the new tab with ONLY the
    // cosmetic ?viewAs=/?viewAsRole= params above — no real Firebase Auth
    // session. superadmin's OWN session uses browserSessionPersistence
    // (tab-scoped, see this file's setPersistence() call), so the new tab
    // always started with zero session, and admin.js's own fallback then
    // signed it in ANONYMOUSLY — a session with no restId/role claims,
    // which cannot satisfy database.rules.json's auth.token.restId==$restId
    // check for ANY restaurant. Now mints a REAL session first (backend
    // verifies this is a genuine superadmin session before minting anything
    // — see routes/auth.js's /login-as) and passes it via a one-time
    // ssoToken URL param that admin.js signs in with immediately, before it
    // would otherwise consider its anonymous fallback.
    const superAdminIdToken = auth?.currentUser ? await auth.currentUser.getIdToken() : null;
    if (!superAdminIdToken) {
      alert(t("sa_err_login_admin", "❌ Adminga kirishda xato yuz berdi:") + " no active superadmin session");
      return;
    }
    let ssoToken = null;
    try {
      const resp = await fetch("/api/auth/login-as", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${superAdminIdToken}` },
        body: JSON.stringify({ restId, userId: adminId }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok || !body.token) throw new Error(body?.error || `HTTP ${resp.status}`);
      ssoToken = body.token;
    } catch (err) {
      console.error(t("sa_err_login_admin", "❌ Adminga kirishda xato yuz berdi:"), err);
      alert(t("sa_error_prefix", "Xatolik: ") + (err?.message || ""));
      return;
    }

    window.logAudit("login_as", restaurantData.info?.name || restId, `"${adminName}" ${t("sa_log_logged_in_as", "nomidan kirildi")}`);

    console.log(t("sa_log_redirecting_admin", "🚀 Admin panelga yo'naltirilmoqda..."));
    window.open(`admin.html?id=${encodeURIComponent(restId)}&viewAs=${encodeURIComponent(adminId)}&viewAsRole=admin&viewAsName=${encodeURIComponent(adminName)}&ssoToken=${encodeURIComponent(ssoToken)}`, "_blank");

  } catch (err) {
    console.error(t("sa_err_login_admin", "❌ Adminga kirishda xato yuz berdi:"), err);
    alert(t("sa_error_prefix", "Xatolik: ") + err.message);
  }
};

window.deleteRestaurant = async function (restId, restName) {
  const deleteMsg = t("sa_delete_confirm_full", "Diqqat! \"{name}\" restoranini va uning barcha ma'lumotlarini bazadan butunlay o'chirib tashlamoqchimisiz?")
    .replace("{name}", restName);

  if (!confirm(deleteMsg)) return;
  try {
    const database = window.db;

    await remove(ref(database, `restaurants/${restId}`));
    await remove(ref(database, `restaurants_meta/${restId}`));

    window.logAudit("delete", restName, t("sa_log_rest_fully_deleted", "Restoran butunlay o'chirildi"));

    alert(t("sa_delete_success", "Restoran muvaffaqiyatli o'chirildi."));

    if (typeof window.renderRestaurantsTable === "function") {
      window.renderRestaurantsTable();
    }
  } catch (err) {
    console.error(t("sa_err_delete", "O'chirishda xato:"), err);
    alert(t("sa_error_prefix", "Xatolik: ") + (err?.message || ""));
  }
};

window.toggleRevenueFilter = function () {
  const menu = document.getElementById("revenueFilterMenu");
  const backdrop = document.getElementById("revenueFilterBackdrop");
  const trigger = document.getElementById("revenueFilterTrigger");
  if (!menu) return;

  const isOpening = (menu.style.display === "none" || !menu.style.display);

  if (isOpening) {
    const rect = trigger ? trigger.getBoundingClientRect() : { bottom: 60, right: window.innerWidth - 20 };
    const menuWidth = 280;
    const margin = 10;

    let left = rect.right - menuWidth;
    if (left < margin) left = margin;
    if (left + menuWidth > window.innerWidth - margin) left = window.innerWidth - menuWidth - margin;

    let top = rect.bottom + margin;
    const maxHeight = window.innerHeight - top - margin;
    menu.style.maxHeight = Math.max(240, Math.min(420, maxHeight)) + "px";

    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.display = "block";
    if (backdrop) backdrop.style.display = "block";
    if (typeof window.setRevenueQuickFilter === "function") {
      window.setRevenueQuickFilter(window._statTrendPeriod || "yesterday");
    }
  } else {
    menu.style.display = "none";
    if (backdrop) backdrop.style.display = "none";
  }
};

// Revenue-filter 401 fix: the unconditional auto-run on page load now
// happens from inside the onAuthStateChanged-gated block above (with
// listenPaymentHistory()) instead of here, so it can't fire before a
// Firebase ID token is available. See the comment there for the full trace.

window.loadGlobalPayments = function () {
  onValue(ref(db, 'payments'), (snapshot) => {
    const data = snapshot.val();
    const list = document.getElementById('payments-list');
    const totalRev = document.getElementById('total-revenue');
    let total = 0;
    if (list) list.innerHTML = "";

    if (data) {
      Object.values(data).reverse().forEach(pay => {
        total += pay.amount;
        if (list) list.innerHTML += `
                    <tr>
                        <td>${pay.restaurantId}</td>
                        <td>${pay.amount.toLocaleString()} ${t("sa_currency_uzs", "so'm")}</td>
                        <td><b>${pay.method}</b></td>
                        <td>${new Date(pay.date).toLocaleString()}</td>
                    </tr>
                `;
      });
    }
    if (totalRev) totalRev.innerText = total.toLocaleString();
  });
};

window.selectedSuperPlanMonths = 12;
window.currentPaymentMethod = t("sa_pay_cash", "Naqd pul");
window.selectedSuperPlanMonths = 0;
window.currentPaymentMethod = null;
window.isCreatingNewRestaurant = false;
window.pendingNewRestaurantData = null;

function resetModalState() {
  const form = document.getElementById('cardDetailsForm');
  if (form) form.style.display = 'none';

  const methods = document.getElementById('superPaymentMethods');
  if (methods) methods.style.display = 'grid';

  const payBtn = document.getElementById('modalPayBtn');
  if (payBtn) {
    payBtn.disabled = true;
    payBtn.style.opacity = "0.5";
    payBtn.style.cursor = "not-allowed";
    payBtn.innerHTML = `<i class="fa-solid fa-credit-card"></i> <span>${t("sa_pay_btn", "TO'LASH")}</span>`;
  }
}
window.paymentInterval = null;

// showSuccessReceipt — _ensureReceiptModal orqali ishlaydi (yuqorida aniqlangan)

let selectedMethod = null;

window.handlePlanChangeInBilling = function (newTariff) {
  console.log(t("sa_log_tariff_changed", "🔄 Tarif o'zgartirildi:"), newTariff);

  if (typeof calculateAndDisplayPrices === "function") {
    calculateAndDisplayPrices(newTariff);

    window.selectedSuperPlanMonths = 0;

    document.querySelectorAll('.plan-card').forEach(card => {
      card.classList.remove('active');
      card.classList.remove('selected');
      card.style.border = '1px solid #e5e7eb';
      card.style.background = 'white';
    });

    const methods = document.getElementById("superPaymentMethods");
    const cardDetails = document.getElementById("cardDetailsForm");
    if (methods) methods.style.display = "none";
    if (cardDetails) cardDetails.style.display = "none";

    const payBtn = document.getElementById("modalPayBtn");
    if (payBtn) {
      payBtn.disabled = true;
      payBtn.style.opacity = "0.5";
      payBtn.style.cursor = "not-allowed";
      payBtn.innerHTML = `<i class="fa-solid fa-credit-card"></i> ${t("sa_pay_btn", "TO'LASH")}`;
    }
  }
};

window.growthChartInstance = null;

// ============================================
// TO'LOV CHEKI (RECEIPT) FUNKSIYALARI
// ============================================
window.showFinalReceipt = function (data) {
  _ensureReceiptModal();
  _updateReceiptLabels();
  const modal = document.getElementById("receiptModal");
  if (!modal) return;

  const amountStr = data.amount.toLocaleString() + " " + t("sa_currency_uzs", "so'm");
  document.getElementById("r_orderId").innerText = data.orderId;
  document.getElementById("r_restName").innerText = data.restName;
  document.getElementById("r_plan").innerText = data.months + " " + t("sa_monthly_sub", "Oylik Obuna");
  document.getElementById("r_amount").innerText = amountStr;
  document.getElementById("r_method").innerText = data.method;
  document.getElementById("r_date").innerText = data.date;
  const amtItem = document.getElementById("r_amount_item");
  if (amtItem) amtItem.innerText = amountStr;
  const phoneEl = document.getElementById('r_phone');
  if (phoneEl) phoneEl.innerText = window._receiptPhone || '+998 71 220-00-00';

  modal.classList.add('open');
  modal.style.display = "flex";
};

window.allTariffs = {};

async function addNewRestaurantToSystem(name) {
  const newRestId = "rest_" + Date.now();

  const newRestData = {
    info: {
      name: name,
      status: "active"
    },
    subscription: {
      plan: "VIP",
      planId: "vip",
      status: "active",
      expireDate: Date.now() + (365 * 24 * 60 * 60 * 1000),
      createdAt: Date.now()
    }
  };

  try {
    await set(ref(db, 'restaurants/' + newRestId), newRestData);
    alert(t("sa_vip_added", "Yangi VIP restoran qo'shildi!"));
  } catch (error) {
    console.error(t("sa_error", "Xatolik:"), error);
    alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
  }
}

async function makeEverythingVIP() {
  const restSnap = await get(ref(db, 'restaurants'));
  if (!restSnap.exists()) return;

  const allData = restSnap.val();
  const updates = {};

  Object.keys(allData).forEach(restId => {
    updates[`restaurants/${restId}/subscription`] = {
      plan: "VIP",
      planId: "vip",
      status: "active",
      expireDate: Date.now() + (365 * 24 * 60 * 60 * 1000),
      updatedAt: Date.now()
    };
    updates[`restaurants/${restId}/info/status`] = "active";
  });

  await update(ref(db), updates);
  alert(t("sa_all_vip", "Barcha restoranlar 100% VIP bo'ldi!"));
}

async function upgradeAllRestaurantsToVIP() {
  if (!confirm(t("sa_confirm_upgrade_all_vip", "DIQQAT! Barcha restoranlarni VIP tarifga o'tkazmoqchimisiz? Bu amalni ortga qaytarib bo'lmaydi."))) return;

  console.log(t("sa_vip_start_log", "⏳ Barcha restoranlarni..."));
  try {
    const restaurantsSnap = await get(ref(db, 'restaurants'));

    if (!restaurantsSnap.exists()) {
      console.error(t("sa_err_no_rests_found", "Hech qanday restoran topilmadi."));
      return;
    }

    const allRestorans = restaurantsSnap.val();
    const updates = {};

    Object.keys(allRestorans).forEach(restId => {
      updates[`restaurants/${restId}/subscription`] = {
        plan: "VIP",
        planId: "vip",
        status: "active",
        expireDate: Date.now() + (365 * 24 * 60 * 60 * 1000),
        updatedAt: Date.now(),
        isTest: true
      };

      updates[`restaurants/${restId}/info/status`] = "active";
    });

    await update(ref(db), updates);

    alert(t("sa_all_vip_success", "🚀 TABRIKLAYMIZ! Barcha restoranlar 100% VIP tarifga o'tkazildi."));
    console.log(t("sa_log_update_success", "✅ Yangilanish muvaffaqiyatli yakunlandi."));

  } catch (error) {
    console.error(t("sa_err_occurred_log", "❌ Xatolik yuz berdi:"), error);
    alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
  }
}

// ============================================
// TAVSIYA ETILGAN SOZLAMALARNI TIKLASH
// ============================================
window.resetToRecommendedSettings = function () {
  if (!confirm(typeof t === 'function' ? t("sa_confirm_reset_settings", "Barcha narxlar va chegirmalarni standart (tavsiya etilgan) holatga qaytarmoqchimisiz?") : "Barcha narxlar va chegirmalarni standart holatga qaytarmoqchimisiz?")) {
    return;
  }

  const defaultTariffs = {
    start: { name: "START", price: 150000, oneTimeFee: 4900000, oneTimeActive: true, features: ['kds'], limits: { maxBranches: 1, maxAdmins: 1, maxStaff: 5, maxChefs: 2, maxTables: 15, maxProducts: 500 } },
    pro: { name: "PRO", price: 350000, oneTimeFee: 9900000, oneTimeActive: true, features: ['inventory', 'reservations'], limits: { maxBranches: 3, maxAdmins: 5, maxStaff: 20, maxChefs: 5, maxTables: 100, maxProducts: 10000 } },
    premium: { name: "PREMIUM", price: 700000, oneTimeFee: 19900000, oneTimeActive: true, features: ['qr_menu', 'kds', 'promo', 'inventory', 'reservations'], limits: { maxBranches: 0, maxAdmins: 0, maxStaff: 0, maxChefs: 0, maxTables: 0, maxProducts: 0 } }
  };

  const defaultPlans = {
    1: { price: 350000, active: true },
    6: { discount: 10, active: true },
    12: { discount: 20, active: true },
    lifetime: { coefficient: 12, active: false }
  };

  Promise.all([
    _saSettingsFetch('/tariffs', { method: 'POST', body: JSON.stringify(defaultTariffs) }),
    _saSettingsFetch('/subscription-plans', { method: 'POST', body: JSON.stringify(defaultPlans) })
  ]).then(() => {
    alert(t("sa_success_settings_reset", "✅ Sozlamalar muvaffaqiyatli tiklandi!"));

    if (typeof window.renderSystemSettingsUI === "function") window.renderSystemSettingsUI();
    if (typeof window.listenDiscountSettings === "function") window.listenDiscountSettings();

  }).catch((err) => {
    console.error(t("sa_err_reset_settings", "Sozlamalarni tiklashda xato:"), err);
    alert(t("sa_error_prefix", "Xatolik: ") + err.message);
  });
};

// ==========================================
// 🚀 SUPERADMIN: JONLI CHAT TIZIMI
// ==========================================
window.initSuperadminChat = function () {
  const chatHtml = `
  <style>
    .sa-chat-btn { position: fixed; bottom: 30px; right: 30px; background: #10b981; color: #fff; width: 60px; height: 60px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 26px; cursor: pointer; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); z-index: 99999; transition: 0.3s; }
    .sa-chat-btn:hover { transform: scale(1.1); }
    .sa-chat-modal { position: fixed; bottom: 100px; right: 30px; width: 360px; height: 500px; background: #fff; border-radius: 15px; box-shadow: 0 5px 25px rgba(0,0,0,0.2); display: flex; flex-direction: column; z-index: 99999; overflow: hidden; font-family: sans-serif; transition: 0.3s; }
    .sa-chat-modal.hidden { opacity: 0; pointer-events: none; transform: translateY(20px); }
    .sa-chat-header { background: #1e293b; color: #fff; padding: 15px; display: flex; justify-content: space-between; align-items: center; font-weight: bold; }
    .sa-chat-header button { background: none; border: none; color: #fff; font-size: 18px; cursor: pointer; }
    
    .sa-chat-search { padding: 10px; background: #f8f9fa; border-bottom: 1px solid #e2e8f0; }
    .sa-chat-search input { width: 100%; padding: 8px 15px; border: 1px solid #cbd5e1; border-radius: 20px; outline: none; font-size: 13px; transition: 0.2s; }
    .sa-chat-search input:focus { border-color: #10b981; box-shadow: 0 0 5px rgba(16,185,129,0.3); }

    .sa-chat-list { flex: 1; overflow-y: auto; background: #fff; }
    .sa-rest-item { padding: 15px; border-bottom: 1px solid #f1f5f9; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: 0.2s; font-size: 14px; font-weight: 600; color: #333;}
    .sa-rest-item:hover { background: #f8f9fa; }
    .sa-chat-room { flex: 1; display: flex; flex-direction: column; background: #fff; }
    .sa-chat-messages { flex: 1; overflow-y: auto; padding: 15px; background: #f0f2f5; display: flex; flex-direction: column; gap: 10px; }
    .sa-msg-row { display: flex; flex-direction: column; max-width: 85%; }
    .sa-msg-row.me { align-self: flex-end; align-items: flex-end; }
    .sa-msg-row.them { align-self: flex-start; align-items: flex-start; }
    .sa-msg-bubble { padding: 10px 14px; border-radius: 15px; font-size: 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.1); line-height: 1.4; color: #111;}
    .sa-msg-row.me .sa-msg-bubble { background: #dcf8c6; border-bottom-right-radius: 2px; }
    .sa-msg-row.them .sa-msg-bubble { background: #fff; border-bottom-left-radius: 2px; }
    .sa-msg-time { font-size: 11px; color: #64748b; margin-top: 4px; }
    .sa-chat-input-area { padding: 10px; background: #fff; border-top: 1px solid #e2e8f0; display: flex; gap: 8px; }
    .sa-chat-input-area input { flex: 1; padding: 10px 15px; border: 1px solid #cbd5e1; border-radius: 20px; outline: none; font-size: 14px;}
    .sa-chat-input-area button { background: #10b981; color: #fff; border: none; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px;}
  </style>
  <div class="sa-chat-btn" onclick="window.toggleSaChat()"><i class="fa-solid fa-headset"></i></div>
  <div id="saChatModal" class="sa-chat-modal hidden">
    <div class="sa-chat-header">
      <span id="saChatTitle">${t("sa_chat_title_active", "Faol Restoranlar")}</span>
      <button onclick="window.toggleSaChat()"><i class="fa-solid fa-xmark"></i></button>
    </div>
    
    <div id="saChatSearchContainer" class="sa-chat-search">
      <input type="text" id="saChatSearchInput" placeholder="${t("sa_placeholder_search_rest", "🔍 Restoran qidirish...")}" oninput="window.filterSaChatList()" autocomplete="off">
    </div>

    <div id="saChatList" class="sa-chat-list"></div>
    <div id="saChatRoom" class="sa-chat-room" style="display:none;">
      <div style="padding: 10px; background: #f8f9fa; border-bottom: 1px solid #ddd; display:flex; align-items:center;">
        <button onclick="window.closeSaChatRoom()" style="background:none; border:none; color:#10b981; cursor:pointer; font-weight:bold; font-size: 14px;"><i class="fa-solid fa-arrow-left"></i> ${t("sa_btn_back", "Orqaga")}</button>
      </div>
      <div id="saChatMessages" class="sa-chat-messages"></div>
      <div class="sa-chat-input-area">
        <input type="text" id="saChatInput" placeholder="${t("sa_placeholder_type_msg", "Xabar yozing...")}" autocomplete="off" onkeypress="if(event.key==='Enter') window.sendSaMessage()">
        <button onclick="window.sendSaMessage()"><i class="fa-solid fa-paper-plane"></i></button>
      </div>
    </div>
  </div>`;

  if (!document.getElementById('saChatModal')) {
    document.body.insertAdjacentHTML('beforeend', chatHtml);
  }
};

window.toggleSaChat = function () {
  const modal = document.getElementById('saChatModal');
  if (modal.classList.contains('hidden')) {
    modal.classList.remove('hidden');
    window.loadSaChatList();
  } else {
    modal.classList.add('hidden');
  }
};

window.loadSaChatList = function () {
  document.getElementById('saChatList').style.display = 'block';
  document.getElementById('saChatSearchContainer').style.display = 'block';
  document.getElementById('saChatRoom').style.display = 'none';
  document.getElementById('saChatTitle').innerText = t("sa_chat_title_active", "Faol Restoranlar");

  const searchInput = document.getElementById('saChatSearchInput');
  if (searchInput) searchInput.value = '';

  const listContainer = document.getElementById('saChatList');
  listContainer.innerHTML = '';

  const now = Date.now();
  const activeRests = Object.entries(window.allRestaurants || {}).filter(([id, data]) => {
    const sub = data.subscription || {};
    const expireAt = Number(sub.expireDate || sub.expireAt || 0);
    const isBlocked = data.info?.status === "blocked" || data.info?.status === "paused";
    return !isBlocked && (sub.oneTimePaid || expireAt > now);
  }).sort(([idA, dataA], [idB, dataB]) => {
    // Newest-first fix: this list used to render in whatever incidental
    // order Object.entries() produced (no sort at all). Reuses the exact
    // same createdAt-DESC logic already traced and shipped in
    // renderRestaurantsTable() rather than a new/arbitrary field:
    // info.createdAt when present, else the timestamp already embedded in
    // a rest_<ms> id (never Date.now() or anything invented). ID-DESC
    // tiebreak for determinism when both are equal (e.g. legacy rows
    // missing both). filterSaChatList() only toggles display on already-
    // rendered nodes, so search results inherit this order automatically.
    const timeOf = (id, data) => {
      const fromId = id.startsWith("rest_") ? (parseInt(id.replace("rest_", "")) || 0) : 0;
      return (data.info && data.info.createdAt) ? data.info.createdAt : fromId;
    };
    const tA = timeOf(idA, dataA);
    const tB = timeOf(idB, dataB);
    if (tB !== tA) return tB - tA;
    return idA < idB ? 1 : idA > idB ? -1 : 0;
  });

  if (activeRests.length === 0) {
    listContainer.innerHTML = `<div style="padding: 20px; text-align: center; color: #64748b;">${t("sa_chat_no_active", "Faol restoranlar yo'q")}</div>`;
    return;
  }

  activeRests.forEach(([id, data]) => {
    const restName = data.info?.name || t("sa_unknown_rest", "Nomsiz restoran");
    const safeChatName = restName.replace(/'/g, "\\'");
    listContainer.innerHTML += `
      <div class="sa-rest-item" data-name="${restName.toLowerCase()}" onclick="window.openSaChatRoom('${id}', '${safeChatName}')">
        <span>🍽 ${restName}</span>
        <span style="font-size: 11px; padding: 4px 8px; background: #d1fae5; color: #059669; border-radius: 12px;">${t("sa_status_active", "Faol")}</span>
      </div>`;
  });
};

window.filterSaChatList = function () {
  const query = document.getElementById('saChatSearchInput').value.toLowerCase().trim();
  const items = document.querySelectorAll('.sa-rest-item');

  items.forEach(item => {
    const name = item.getAttribute('data-name') || "";
    if (name.includes(query)) {
      item.style.display = "flex";
    } else {
      item.style.display = "none";
    }
  });
};

window.currentChatRestId = null;

window.openSaChatRoom = async function (restId, restName) {
  window.currentChatRestId = restId;
  document.getElementById('saChatList').style.display = 'none';
  document.getElementById('saChatSearchContainer').style.display = 'none';
  document.getElementById('saChatRoom').style.display = 'flex';
  document.getElementById('saChatTitle').innerText = restName;

  const msgsDiv = document.getElementById('saChatMessages');
  msgsDiv.innerHTML = `<div style="text-align:center; color:#888; margin-top:20px;">${t("sa_loading", "Yuklanmoqda...")}</div>`;

  try {
    const msgs = await _saDashFetch(`/restaurants/${encodeURIComponent(restId)}/superadmin-chat`);
      msgsDiv.innerHTML = '';
      if (!msgs || !Object.keys(msgs).length) {
        msgsDiv.innerHTML = `<div style="text-align:center; color:#888; margin-top:20px; font-size:13px;">${t("sa_chat_empty", "Hali xabarlar yo'q. Birinchi bo'lib yozing!")}</div>`;
        return;
      }
      Object.values(msgs).forEach(m => {
        const isMe = m.sender === 'superadmin';
        msgsDiv.innerHTML += `
          <div class="sa-msg-row ${isMe ? 'me' : 'them'}">
            <div class="sa-msg-bubble">${m.text}</div>
            <div class="sa-msg-time">${new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          </div>`;
      });
      msgsDiv.scrollTop = msgsDiv.scrollHeight;
  } catch (_) {
    msgsDiv.innerHTML = `<div style="text-align:center; color:#b91c1c; margin-top:20px;">${t("sa_error_loading", "Yuklashda xatolik")}</div>`;
  }
};

window.closeSaChatRoom = function () {
  window.currentChatRestId = null;
  if (window.saChatUnsubscribe) window.saChatUnsubscribe();
  window.loadSaChatList();
};

document.addEventListener("DOMContentLoaded", function () {
  const menuBtn = document.getElementById("menuToggleBtn");
  const sidebar = document.querySelector(".sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const menuIcon = menuBtn ? menuBtn.querySelector("i") : null;

  function openSidebar() {
    sidebar.classList.add("open");
    overlay.classList.add("visible");
    document.body.classList.add("sidebar-open");
    if (menuIcon) {
      menuIcon.classList.remove("fa-list-ul");
      menuIcon.classList.add("fa-xmark");
    }
  }

  function closeSidebar() {
    sidebar.classList.remove("open");
    overlay.classList.remove("visible");
    document.body.classList.remove("sidebar-open");
    if (menuIcon) {
      menuIcon.classList.remove("fa-xmark");
      menuIcon.classList.add("fa-list-ul");
    }
  }

  function toggleSidebar() {
    if (sidebar.classList.contains("open")) {
      closeSidebar();
    } else {
      openSidebar();
    }
  }

  if (menuBtn) {
    menuBtn.addEventListener("click", toggleSidebar);
  }

  if (overlay) {
    overlay.addEventListener("click", closeSidebar);
  }

  // Sidebar ichidagi nav linkga bosilganda yoping (mobil)
  if (sidebar) {
    sidebar.querySelectorAll(".sidebar-nav a").forEach(link => {
      link.addEventListener("click", () => {
        if (window.innerWidth <= 1024) {
          closeSidebar();
        }
      });
    });
  }

  // Esc tugmasi bilan yopish
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sidebar.classList.contains("open")) {
      closeSidebar();
    }
  });

  // ── Swipe gesture — mobil uchun (chapdan o'ngga ochish, o'ngdan chapga yopish) ──
  let touchStartX = 0;
  let touchStartY = 0;
  let isSwiping = false;
  const SWIPE_THRESHOLD = 60;   // px — minimal swipe masofasi
  const SWIPE_EDGE = 30;        // px — chap chetdan boshlanishi kerak (ochish uchun)
  const SWIPE_MAX_VERTICAL = 80; // px — vertikal drift chegarasi

  document.addEventListener("touchstart", (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    isSwiping = false;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!isSwiping) {
      const dx = Math.abs(e.touches[0].clientX - touchStartX);
      const dy = Math.abs(e.touches[0].clientY - touchStartY);
      if (dx > 8 && dx > dy) isSwiping = true;
    }
  }, { passive: true });

  document.addEventListener("touchend", (e) => {
    if (!isSwiping) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);

    // Vertikal drift juda katta bo'lsa, swipe hisoblanmaydi
    if (dy > SWIPE_MAX_VERTICAL) return;

    // Chapdan o'ngga — sidebar ochish (faqat chap chetdan boshlanmasa)
    if (dx > SWIPE_THRESHOLD && touchStartX < SWIPE_EDGE) {
      if (window.innerWidth <= 1024) openSidebar();
    }

    // O'ngdan chapga — sidebar yopish
    if (dx < -SWIPE_THRESHOLD && sidebar.classList.contains("open")) {
      closeSidebar();
    }

    isSwiping = false;
  }, { passive: true });

  // ── Window resize — katta ekranga o'tganda sidebar holatini tiklash ──
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (window.innerWidth > 1024 && sidebar.classList.contains("open")) {
        closeSidebar();
      }
    }, 150);
  });
});

window.sendSaMessage = async function () {
  const input = document.getElementById('saChatInput');
  const text = input.value.trim();
  const restId = window.currentChatRestId;
  if (!text || !restId) return;

  input.value = '';
  const now = Date.now();

  await _saDashFetch(`/restaurants/${encodeURIComponent(restId)}/superadmin-chat`, {
    method: "POST",
    body: JSON.stringify({ text })
  });
};

setTimeout(() => { if (typeof window.initSuperadminChat === 'function') window.initSuperadminChat(); }, 1000);

document.querySelectorAll('.revMethod').forEach(el => {
  el.addEventListener('change', () => window.updateRevenueByFilter());
});

const startD = document.getElementById("revStartDate");
const endD = document.getElementById("revEndDate");
if (startD) startD.addEventListener("change", () => window.updateRevenueByFilter());
if (endD) endD.addEventListener("change", () => window.updateRevenueByFilter());

document.getElementById("revStartDate")?.addEventListener("change", window.updateRevenueByFilter);
document.getElementById("revEndDate")?.addEventListener("change", window.updateRevenueByFilter);
/* =========================
   SUPERADMIN HEADER SOAT (CLOCK WIDGET)
========================= */

(function initSuperAdminClock() {

  function injectClock() {
    if (document.getElementById("adminClockWidget")) return;

    const clockHTML = `
      <div id="adminClockWidget" style="
        display:flex; align-items:center; gap:10px;
        background: linear-gradient(135deg, #0f172a, #1e3a5f);
        border-radius: 10px; padding: 6px 16px 6px 12px;
        box-shadow: 0 2px 10px rgba(37,99,235,.22);
        cursor:default; user-select:none;
      ">
        <svg id="adminClockSvg" width="22" height="22" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;">
          <circle cx="12" cy="12" r="10" stroke="#60a5fa" stroke-width="1.6"/>
          <circle cx="12" cy="12" r="1.2" fill="#93c5fd"/>
          <line id="aHourHand" x1="12" y1="12" x2="12" y2="7"   stroke="#e2e8f0" stroke-width="1.8" stroke-linecap="round"/>
          <line id="aMinHand"  x1="12" y1="12" x2="12" y2="5"   stroke="#60a5fa" stroke-width="1.4" stroke-linecap="round"/>
          <line id="aSecHand"  x1="12" y1="12" x2="12" y2="4.5" stroke="#f87171" stroke-width="1"   stroke-linecap="round"/>
        </svg>
        <!-- 🩹 Talab: "soatni shu formatga o'zgartir: 18 августа 2026 г. ·
             17:39:34" — waiter/kassa/chef/courier/client bilan bir xil
             yagona qator (to'liq sana + soniyagacha soat, hafta kunisiz).
             Avval alohida HH/MM/SS (yonib-o'chuvchi ikki nuqta bilan) +
             alohida qisqa sana qatori bor edi. -->
        <span id="aClockDateTime" style="font-size:13px; font-weight:700; color:#f1f5f9; letter-spacing:.2px; font-variant-numeric:tabular-nums; font-family:inherit; white-space:nowrap;">-- --- ---- · --:--:--</span>
      </div>
    `;

    const header = document.querySelector("header") || document.querySelector(".header") || document.querySelector(".superadmin-header") || document.querySelector("nav");
    if (!header) { setTimeout(injectClock, 300); return; }

    const wrapper = document.createElement("div");
    wrapper.innerHTML = clockHTML;
    const clockEl = wrapper.firstElementChild;

    // 🩹 Talab: "soat bilan bildirishnoma icon va til selektni o'rnini
    // almashtir" — avval bu widget header'ga eng OXIRIGA (appendChild)
    // qo'shilardi, o'zining margin-left:auto'si bilan har doim eng o'ng
    // chetga surilardi — .header-right (bell+til) esa undan OLDIN turardi.
    // Endi soat .header-right'dan OLDIN joylashtiriladi (o'z margin-left:
    // auto'si OLIB TASHLANDI) — .header'ning mavjud
    // justify-content:space-between qoidasi (superadmin.css) natijada
    // 3 ta ko'rinadigan farzand ([brand][soat][.header-right]) orasiga
    // avtomatik teng bo'shliq qo'yadi, .header-right esa endi ENG OXIRGI
    // farzand bo'lgani uchun o'zi eng o'ng chetga tushadi — ikkalasining
    // joyi almashadi, hech qanday mavjud CSS klassiga tegmasdan.
    const headerRight = header.querySelector(".header-right");
    if (headerRight) { header.insertBefore(clockEl, headerRight); } else { header.appendChild(clockEl); }
  }

  // 🩹 ROOT-CAUSE FIX (o'zbek tilida "2026 M08 18" kabi noto'g'ri sana,
  // ingliz/rus tillari orasida beqaror almashinish) — avval Intl.
  // toLocaleDateString ishlatilardi; "uz-UZ" locale'i uchun ko'p brauzer/
  // OS'da to'liq o'zbekcha oy nomlari ICU ma'lumotida yo'q, shuning uchun
  // tarjima qilinmagan generik fallback ("M08") chiqardi. Endi oy nomi
  // Intl'dan EMAS, loyihaning o'z t()/langs.js kalitlaridan olinadi.
  const _SA_CLOCK_MONTH_KEYS = ["month_jan","month_feb","month_mar","month_apr","month_may","month_jun",
                                 "month_jul","month_aug","month_sep","month_oct","month_nov","month_dec"];
  function _saClockPad2(n) { return String(n).padStart(2, "0"); }

  function tickClock() {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();
    const dtEl = document.getElementById("aClockDateTime");
    if (!dtEl) { injectClock(); return; }
    const lang = (typeof getLang === "function" ? getLang() : null) || "uz";
    const monthName = t(_SA_CLOCK_MONTH_KEYS[now.getMonth()]);
    const yearSuffix = lang === "ru" ? " г." : "";
    const datePart = `${now.getDate()} ${monthName} ${now.getFullYear()}${yearSuffix}`;
    const timePart = `${_saClockPad2(h)}:${_saClockPad2(m)}:${_saClockPad2(s)}`;
    dtEl.textContent = datePart + " · " + timePart;
    function setHand(id, deg, len) {
      const el = document.getElementById(id);
      if (!el) return;
      const rad = (deg - 90) * Math.PI / 180;
      el.setAttribute("x2", (12 + len * Math.cos(rad)).toFixed(2));
      el.setAttribute("y2", (12 + len * Math.sin(rad)).toFixed(2));
    }
    setHand("aHourHand", (h % 12) * 30 + m * 0.5, 4.5);
    setHand("aMinHand",  m * 6 + s * 0.1, 6.5);
    setHand("aSecHand",  s * 6, 7);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectClock);
  } else {
    injectClock();
  }
  setInterval(tickClock, 1000);
  tickClock();
  // 🩹 ROOT-CAUSE FIX ("2 marta tarjima bo'lish" — til almashtirilganda
  // eski tildagi matn ~1 soniya ko'rinib turardi). Endi til almashishi
  // bilan DARHOL qayta chiziladi.
  if (typeof onLangChange === "function") onLangChange(tickClock);
})();

// ============================================================
// MARKETING BO'LIMI — RESTORAN FOYDA KALKULYATORI
// ============================================================

window.marketingForecastChart = null;
window._rcPeriod    = 'monthly';   // kalkulyator davri
window._rcSysPeriod = 'monthly';   // tizim prognozi davri
window._rcTariff    = 'pro';       // tanlangan tarif

// Format helper
function _rcFmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' ' + window.t('rc_fmt_mlrd','mlrd');
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' ' + window.t('rc_fmt_mln','mln');
  return Math.round(n).toLocaleString('ru-RU');
}

// Tarif kartalarini chizish
function _rcRenderTariffCards() {
  const container = document.getElementById('rc_tariff_cards');
  if (!container) return;

  const tariffs = window.allTariffs && Object.keys(window.allTariffs).length
    ? window.allTariffs
    : {
        start:   { name: 'START',   price: 150000, trialDays: 0 },
        pro:     { name: 'PRO',     price: 350000, trialDays: 0 },
        premium: { name: 'PREMIUM', price: 700000, trialDays: 0 }
      };

  const icons   = { start: '🌱', pro: '⚡', premium: '👑' };
  const colors  = { start: '#22c55e', pro: '#6366f1', premium: '#f59e0b' };
  const bgLight = { start: '#f0fdf4', pro: '#eff6ff', premium: '#fffbeb' };
  const borders = { start: '#86efac', pro: '#a5b4fc', premium: '#fde68a' };

  container.innerHTML = Object.keys(tariffs).map(k => {
    const t = tariffs[k];
    const isActive = k === window._rcTariff;
    const trial = t.trialDays > 0
      ? `<span style="background:#fef3c7;color:#92400e;font-size:10px;padding:1px 6px;border-radius:8px;font-weight:600;">🎁 ${t.trialDays} ${window.t("rc_trial_badge","kun sinov")}</span>`
      : '';
    return `<div onclick="window.rcSelectTariff('${k}')"
      style="display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-radius:10px;
        border:${isActive ? '2px solid ' + colors[k] : '1.5px solid #e5e7eb'};
        background:${isActive ? bgLight[k] : 'white'}; cursor:pointer; transition:.15s; user-select:none;">
      <div style="display:flex; align-items:center; gap:10px;">
        <span style="font-size:18px;">${icons[k] || '📦'}</span>
        <div>
          <div style="font-weight:700; font-size:13px; color:${isActive ? colors[k] : '#374151'};">${t.name || k.toUpperCase()}</div>
          <div style="font-size:11px; color:#9ca3af;">${(t.price || 0).toLocaleString()} ${window.t('rc_price_per_month',"so'm/oy")} ${trial}</div>
        </div>
      </div>
      ${isActive ? `<i class="fa-solid fa-circle-check" style="color:${colors[k]}; font-size:16px;"></i>` : `<span style="width:16px;height:16px;border-radius:50%;border:1.5px solid #d1d5db;display:inline-block;"></span>`}
    </div>`;
  }).join('');
}

// Tarif tanlash
window.rcSelectTariff = function (key) {
  window._rcTariff = key;
  _rcRenderTariffCards();
};

// Davr o'zgartirish: kalkulyator
window.rcSetPeriod = function (period) {
  window._rcPeriod = period;
  const mb = document.getElementById('rc_btn_monthly');
  const yb = document.getElementById('rc_btn_yearly');
  if (mb) { mb.style.background = period === 'monthly' ? '#10b981' : 'transparent'; mb.style.color = period === 'monthly' ? 'white' : '#6b7280'; }
  if (yb) { yb.style.background = period === 'yearly'  ? '#10b981' : 'transparent'; yb.style.color = period === 'yearly'  ? 'white' : '#6b7280'; }
};

// Davr o'zgartirish: tizim prognozi
window.rcSetSysPeriod = function (period) {
  window._rcSysPeriod = period;
  const mb = document.getElementById('sys_btn_monthly');
  const yb = document.getElementById('sys_btn_yearly');
  if (mb) { mb.style.background = period === 'monthly' ? '#6366f1' : 'transparent'; mb.style.color = period === 'monthly' ? 'white' : '#6b7280'; }
  if (yb) { yb.style.background = period === 'yearly'  ? '#6366f1' : 'transparent'; yb.style.color = period === 'yearly'  ? 'white' : '#6b7280'; }
  _rcRenderSystemStats();
};

// ASOSIY HISOBLASH — Restoran foyda kalkulyatori
window.rcCalculate = function () {
  const rawIncome = Number((document.getElementById('rc_income')?.value || '0').replace(/\s/g, ''));
  if (!rawIncome || rawIncome <= 0) {
    const inp = document.getElementById('rc_income');
    if (inp) { inp.style.borderColor = '#ef4444'; setTimeout(() => inp.style.borderColor = '#d1d5db', 1500); }
    return;
  }

  const tariffKey = window._rcTariff || 'pro';
  const isYearly  = window._rcPeriod === 'yearly';
  const mult      = isYearly ? 12 : 1;

  const tariffs = window.allTariffs && Object.keys(window.allTariffs).length
    ? window.allTariffs
    : { start: { name:'START', price:150000 }, pro: { name:'PRO', price:350000 }, premium: { name:'PREMIUM', price:700000 } };

  const tariffPrice = (tariffs[tariffKey]?.price || 0) * mult;
  const income      = rawIncome * mult;
  const profit      = income - tariffPrice;
  const profitPct   = income > 0 ? ((profit / income) * 100).toFixed(1) : '0';
  const periodLabel = isYearly ? window.t('rc_period_yearly','yillik') : window.t('rc_period_monthly','oylik');

  const setEl = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };

  // Hero banner
  setEl('rc_hero_label', `${isYearly ? window.t('rc_yearly','Yillik') : window.t('rc_monthly','Oylik')} ${window.t('rc_hero_label_suffix','sof foyda prognozi')} (${(tariffs[tariffKey]?.name || tariffKey.toUpperCase())} ${window.t('rc_tariff_label','tarifi')})`);
  setEl('rc_hero_value', _rcFmt(profit) + ' ' + window.t('sa_currency_uzs',"so'm"));
  setEl('rc_hero_sub', window.t('rc_hero_sub','Daromadingizning {pct}% sof foyda — tarif narxi ayirib tashlanganidan keyin').replace('{pct}', profitPct));

  const heroEl = document.getElementById('rc_hero');
  if (heroEl) heroEl.style.background = profit >= 0
    ? 'linear-gradient(135deg,#0f172a,#1e3a5f)'
    : 'linear-gradient(135deg,#1f0909,#3b0f0f)';

  // 3 metrika
  setEl('rc_m_income',     _rcFmt(income) + ' ' + window.t('sa_currency_uzs',"so'm"));
  setEl('rc_m_income_lbl', periodLabel + window.t('rc_period_suffix','ga'));
  setEl('rc_m_cost',       _rcFmt(tariffPrice) + ' ' + window.t('sa_currency_uzs',"so'm"));
  setEl('rc_m_cost_lbl',   periodLabel + window.t('rc_period_suffix','ga'));
  setEl('rc_m_profit',     _rcFmt(profit) + ' ' + window.t('sa_currency_uzs',"so'm"));
  setEl('rc_m_profit_lbl', periodLabel + window.t('rc_period_suffix','ga'));

  // Taqqoslama jadval — barcha tariflar
  const tBody = document.getElementById('mf_breakdown_body');
  if (tBody) {
    const allKeys = Object.keys(tariffs);
    tBody.innerHTML = allKeys.map(k => {
      const tp     = (tariffs[k]?.price || 0) * mult;
      const ip     = rawIncome * mult;
      const pr     = ip - tp;
      const pct    = ip > 0 ? ((pr / ip) * 100).toFixed(0) : 0;
      const trial  = tariffs[k]?.trialDays || 0;
      const isActive = k === tariffKey;
      const pctColor = pct >= 90 ? '#059669' : pct >= 70 ? '#d97706' : '#ef4444';
      return `<tr style="background:${isActive ? '#f0fdf4' : 'transparent'}; ${isActive ? 'border-left:3px solid #10b981;' : ''}">
        <td style="padding:10px 14px; font-weight:700; color:${isActive ? '#059669' : '#374151'};">
          ${ {start:'🌱',pro:'⚡',premium:'👑'}[k] || '' } ${tariffs[k]?.name || k.toUpperCase()}
          ${isActive ? `<span style="font-size:10px;background:#dcfce7;color:#059669;padding:1px 6px;border-radius:6px;margin-left:5px;">${window.t('rc_selected','Tanlangan')}</span>` : ''}
        </td>
        <td style="padding:10px 14px; text-align:right; color:#ef4444; font-weight:600;">${_rcFmt(tp)} ${window.t('sa_currency_uzs',"so'm")}</td>
        <td style="padding:10px 14px; text-align:right; color:#374151;">${_rcFmt(ip)} ${window.t('sa_currency_uzs',"so'm")}</td>
        <td style="padding:10px 14px; text-align:right; color:${pr >= 0 ? '#059669' : '#dc2626'}; font-weight:700;">${_rcFmt(pr)} ${window.t('sa_currency_uzs',"so'm")}</td>
        <td style="padding:10px 14px; text-align:center;">
          <span style="background:${pctColor}18; color:${pctColor}; padding:3px 10px; border-radius:20px; font-size:12px; font-weight:700;">${pct}%</span>
        </td>
        <td style="padding:10px 14px; text-align:center;">
          ${trial > 0 ? `<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:8px;font-size:11px;">🎁 ${trial} ${window.t("rc_trial_badge","kun sinov")}</span>` : '<span style="color:#d1d5db;font-size:12px;">—</span>'}
        </td>
      </tr>`;
    }).join('');
  }
  setEl('rc_compare_period_lbl', isYearly ? window.t('rc_yearly_view',"yillik ko'rinish") : window.t('rc_monthly_view',"oylik ko'rinish"));

  // Grafik — 12 oy yoki 1 oy taqqoslash
  _rcRenderCalcChart(rawIncome, tariffs, tariffKey, isYearly);

  // Natija panelini ko'rsatish
  const resultPanel = document.getElementById('rc_result_panel');
  const emptyState  = document.getElementById('rc_empty_state');
  if (resultPanel) resultPanel.style.display = 'block';
  if (emptyState)  emptyState.style.display  = 'none';
};

// GRAFIK — Daromad, Xarajat, Foyda (oylar bo'yicha)
function _rcRenderCalcChart(monthlyIncome, tariffs, tariffKey, isYearly) {
  const ctx = document.getElementById('mf_chart');
  if (!ctx) return;

  const months = isYearly ? 12 : 6;
  const UZ_M   = [
    window.t('month_short_jan','Yanv'), window.t('month_short_feb','Fevr'), window.t('month_short_mar','Mart'),
    window.t('month_short_apr','Apr'),  window.t('month_short_may','May'),  window.t('month_short_jun','Iyun'),
    window.t('month_short_jul','Iyul'), window.t('month_short_aug','Avg'),  window.t('month_short_sep','Sen'),
    window.t('month_short_oct','Okt'),  window.t('month_short_nov','Noy'),  window.t('month_short_dec','Dek')
  ];
  const labels = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(new Date().getFullYear(), new Date().getMonth() + i, 1);
    labels.push(UZ_M[d.getMonth()]);
  }

  const tariffMonthly = tariffs[tariffKey]?.price || 0;
  const incomeData  = labels.map(() => monthlyIncome);
  const costData    = labels.map(() => tariffMonthly);
  const profitData  = labels.map(() => monthlyIncome - tariffMonthly);

  if (window.marketingForecastChart) {
    window.marketingForecastChart.data.labels = labels;
    window.marketingForecastChart.data.datasets[0].data = incomeData;
    window.marketingForecastChart.data.datasets[1].data = costData;
    window.marketingForecastChart.data.datasets[2].data = profitData;
    window.marketingForecastChart.update();
    return;
  }

  window.marketingForecastChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: window.t('rc_chart_income','Daromad'),
          data: incomeData,
          backgroundColor: 'rgba(99,102,241,0.75)',
          borderColor: '#6366f1',
          borderWidth: 1.5,
          borderRadius: 5,
          order: 2
        },
        {
          label: window.t('rc_chart_tariff_cost','Tarif narxi'),
          data: costData,
          backgroundColor: 'rgba(239,68,68,0.65)',
          borderColor: '#ef4444',
          borderWidth: 1.5,
          borderRadius: 5,
          order: 3
        },
        {
          label: window.t('rc_chart_net_profit','Sof foyda'),
          data: profitData,
          type: 'line',
          borderColor: '#10b981',
          backgroundColor: 'rgba(16,185,129,0.10)',
          borderWidth: 2.5,
          fill: true,
          tension: 0.35,
          pointRadius: 5,
          pointBackgroundColor: '#fff',
          pointBorderColor: '#10b981',
          pointBorderWidth: 2,
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => ` ${c.dataset.label}: ${_rcFmt(c.parsed.y)} ${window.t('sa_currency_uzs',"so'm")}`
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(0,0,0,0.05)', borderDash: [4,4] },
          ticks: { font: { size: 11 }, callback: v => _rcFmt(v) }
        }
      }
    }
  });
}

// TIZIM STATISTIKASI — barcha restoranlar
function _rcRenderSystemStats() {
  const filterTariff = document.getElementById('mf_tariff')?.value || 'all';
  const isYearly = window._rcSysPeriod === 'yearly';
  const mult = isYearly ? 12 : 1;

  const tariffs = window.allTariffs && Object.keys(window.allTariffs).length
    ? window.allTariffs
    : { start:{name:'START',price:150000}, pro:{name:'PRO',price:350000}, premium:{name:'PREMIUM',price:700000} };

  const counts = { start: 0, pro: 0, premium: 0 };
  Object.values(window.allRestaurants || {}).forEach(rest => {
    const k = (rest.info?.tariff || 'pro').toLowerCase();
    if (counts.hasOwnProperty(k)) counts[k]++;
  });

  let totalRests = 0, baseMonthly = 0;
  const keys = filterTariff === 'all' ? Object.keys(tariffs) : [filterTariff];
  keys.forEach(k => {
    totalRests  += counts[k] || 0;
    baseMonthly += (counts[k] || 0) * (tariffs[k]?.price || 0);
  });

  const setEl = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
  setEl('mf_total_rests', totalRests + ' ' + window.t('sa_piece','ta'));
  setEl('mf_monthly_rev', _rcFmt(baseMonthly * mult) + ' ' + window.t('sa_currency_uzs',"so'm"));
  setEl('mf_period_rev',  _rcFmt(baseMonthly * (isYearly ? 12 : 12)) + ' ' + window.t('sa_currency_uzs',"so'm"));
  setEl('mf_annual_est',  totalRests > 0 ? _rcFmt((baseMonthly / totalRests) * mult) + ' ' + window.t('sa_currency_uzs',"so'm") : '—');

  // Label yangilash
  const ml = document.getElementById('mf_monthly_lbl');
  const pl = document.getElementById('mf_period_lbl');
  if (ml) ml.innerText = isYearly ? window.t('rc_yearly_revenue','Yillik tushum') : window.t('rc_monthly_revenue','Oylik tushum');
  if (pl) pl.innerText = isYearly ? window.t('rc_5year_forecast','5 yillik prognoz') : window.t('rc_yearly_revenue','Yillik tushum');
}

window.initMarketingForecast = function () {
  const section = document.getElementById('marketing');
  if (!section) return;

  _rcRenderTariffCards();
  _rcRenderSystemStats();

  // Tarif filter listener
  const tfEl = document.getElementById('mf_tariff');
  if (tfEl) {
    tfEl.addEventListener('change', _rcRenderSystemStats);
  }

  window._mfRenderForecast = function () {
    _rcRenderTariffCards();
    _rcRenderSystemStats();
  };
};

// Restoranlar yangilanganda statistikani ham yangilash
const _origListenRestaurants = window.listenRestaurants;
window.listenRestaurants = function () {
  if (typeof _origListenRestaurants === 'function') _origListenRestaurants();
  onValue(ref(db, "restaurants"), () => {
    if (typeof window._mfRenderForecast === 'function') window._mfRenderForecast();
  });
};

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => { window.initMarketingForecast(); }, 1200);
});

// ============================================================
// 📈 REVENUE FORECAST — TIZIM DARAJASIDAGI DAROMAD PROGNOZI
// ============================================================
// Marketing kalkulyatoridan farqli o'laroq, bu blok mavjudiy mijoz uchun emas,
// balki SUPERADMIN uchun — "agar bugungi holat shu tarzda davom etsa, kelasi
// oy/yilda qancha tushum kutilmoqda" degan savolga javob beradi.
//
// Hisoblash mantiqi (joriy holat asosida, statik):
//   1. Faqat status !== 'blocked' VA subscription.expireAt > hozir bo'lgan
//      restoranlar hisobga olinadi (faol, muddati tugamagan).
//   2. Har bir restoran o'z tarifining oylik narxini "to'laydi" deb hisoblanadi.
//   3. Kelasi oy prognozi = shu summa x 1.
//   4. Kelasi yil prognozi = shu summa x 12 (o'sish yoki to'xtab qolish hisobga
//      olinmaydi — bu "agar hech narsa o'zgarmasa" degan statik prognoz).

function _rfGetActiveRestaurants() {
  const now = Date.now();
  return Object.values(window.allRestaurants || {}).filter(rest => {
    const info = rest.info || {};
    const sub = rest.subscription || {};
    const expireAt = Number(sub.expireAt || sub.expireDate || 0);
    const isBlocked = info.status === 'blocked';
    const isExpired = expireAt > 0 && expireAt <= now;
    return !isBlocked && !isExpired;
  });
}

function _rfCalculate() {
  const tariffs = window.allTariffs && Object.keys(window.allTariffs).length
    ? window.allTariffs
    : { start: { name: 'START', price: 150000 }, pro: { name: 'PRO', price: 350000 }, premium: { name: 'PREMIUM', price: 700000 } };

  const activeRests = _rfGetActiveRestaurants();

  let monthlyTotal = 0;
  const byTariff = {};

  activeRests.forEach(rest => {
    const tariffKey = (rest.info?.tariff || rest.subscription?.planId || 'pro').toLowerCase();
    const price = tariffs[tariffKey]?.price || 0;
    monthlyTotal += price;
    byTariff[tariffKey] = (byTariff[tariffKey] || 0) + 1;
  });

  return {
    activeCount: activeRests.length,
    monthlyTotal,
    nextMonth: monthlyTotal,
    nextYear: monthlyTotal * 12,
    byTariff,
    tariffs
  };
}

function _rfRender() {
  const data = _rfCalculate();
  const setEl = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };

  // Statik yorliqlarni ham til o'zgarganda yangilaymiz (avval faqat bir marta DOM
  // yaratilganda yozilardi va keyin til almashtirilganda eskirib qolardi)
  setEl('rf_title_el', t('rf_title', 'Revenue Forecast'));
  setEl('rf_subtitle_el', t('rf_subtitle', "Joriy holat asosida statik prognoz — agar hozirgi faol restoranlar soni o'zgarmasa"));
  setEl('rf_active_label_el', t('rf_active_label', 'Faol restoranlar'));
  setEl('rf_next_month_label_el', t('rf_next_month_label', 'Kelasi oy'));
  setEl('rf_next_year_label_el', t('rf_next_year_label', 'Kelasi yil'));

  setEl('rf_active_count', data.activeCount + ' ' + window.t('sa_piece', 'ta'));
  setEl('rf_next_month', _rcFmt(data.nextMonth) + ' ' + window.t('sa_currency_uzs', "so'm"));
  setEl('rf_next_year', _rcFmt(data.nextYear) + ' ' + window.t('sa_currency_uzs', "so'm"));

  const breakdownEl = document.getElementById('rf_breakdown');
  if (breakdownEl) {
    const icons = { start: '🌱', pro: '⚡', premium: '👑' };
    breakdownEl.innerHTML = Object.entries(data.byTariff)
      .sort((a, b) => b[1] - a[1])
      .map(([k, count]) => {
        const name = data.tariffs[k]?.name || k.toUpperCase();
        const price = data.tariffs[k]?.price || 0;
        return `<div style="display:flex; align-items:center; justify-content:space-between; padding:7px 0; border-bottom:1px dashed #f1f5f9; font-size:13px;">
          <span style="color:#475569;">${icons[k] || '📦'} ${name} <span style="color:#9ca3af;">(${count} ${window.t('sa_piece','ta')} × ${price.toLocaleString('ru-RU')})</span></span>
          <span style="font-weight:700; color:#1e293b;">${_rcFmt(count * price)} ${window.t('sa_currency_uzs',"so'm")}</span>
        </div>`;
      }).join('') || `<div style="color:#9ca3af; font-size:13px; text-align:center; padding:10px 0;">${window.t('sa_no_data', "Hozircha ma'lumot yo'q")}</div>`;
  }
}

function _ensureRevenueForecastDom() {
  if (document.getElementById('revenueForecastBox')) return;

  const section = document.getElementById('marketing');
  if (!section) return;

  const html = `
  <style>
    .rf-box { background:#fff; border-radius:16px; padding:22px; margin:20px 0;
      border:1px solid #eef2f7; box-shadow:0 4px 16px rgba(0,0,0,0.04); }
    .rf-head { display:flex; align-items:center; gap:10px; margin-bottom:4px; }
    .rf-head h3 { margin:0; font-size:16px; color:#1e293b; }
    .rf-sub { font-size:12px; color:#94a3b8; margin-bottom:18px; }
    .rf-cards { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:18px; }
    .rf-card { border-radius:14px; padding:18px; color:#fff; position:relative; overflow:hidden; }
    .rf-card-month { background:linear-gradient(135deg,#0f172a,#1e3a5f); }
    .rf-card-year { background:linear-gradient(135deg,#1e1b4b,#4338ca); }
    .rf-card-label { font-size:12px; opacity:.8; margin-bottom:6px; }
    .rf-card-value { font-size:26px; font-weight:800; }
    .rf-meta { font-size:12px; color:#64748b; background:#f8fafc; border:1px solid #eef2f7;
      border-radius:10px; padding:10px 12px; margin-bottom:14px; }
    @media (max-width:560px) { .rf-cards { grid-template-columns:1fr; } }
  </style>
  <div class="rf-box" id="revenueForecastBox">
    <div class="rf-head">
      <span style="font-size:20px;">📈</span>
      <h3 id="rf_title_el">${t('rf_title', 'Revenue Forecast')}</h3>
    </div>
    <div class="rf-sub" id="rf_subtitle_el">${t('rf_subtitle', "Joriy holat asosida statik prognoz — agar hozirgi faol restoranlar soni o'zgarmasa")}</div>

    <div class="rf-meta">
      🏪 <span id="rf_active_label_el">${t('rf_active_label', 'Faol restoranlar')}</span>: <b id="rf_active_count">—</b>
    </div>

    <div class="rf-cards">
      <div class="rf-card rf-card-month">
        <div class="rf-card-label" id="rf_next_month_label_el">${t('rf_next_month_label', 'Kelasi oy')}</div>
        <div class="rf-card-value" id="rf_next_month">—</div>
      </div>
      <div class="rf-card rf-card-year">
        <div class="rf-card-label" id="rf_next_year_label_el">${t('rf_next_year_label', 'Kelasi yil')}</div>
        <div class="rf-card-value" id="rf_next_year">—</div>
      </div>
    </div>

    <div id="rf_breakdown"></div>
  </div>`;

  // Marketing bo'limining boshiga joylaymiz (kalkulyatordan oldin)
  section.insertAdjacentHTML('afterbegin', html);
}

window.initRevenueForecast = function () {
  _ensureRevenueForecastDom();
  _rfRender();
};

// Mavjud yangilanish zanjiriga ulanamiz: restoranlar/tariflar o'zgarganda
// va til o'zgarganda forecast ham yangilanadi.
const _origMfRenderForecastForRf = window._mfRenderForecast;
function _rfHookIntoForecastRefresh() {
  window._mfRenderForecast = function () {
    if (typeof _origMfRenderForecastForRf === 'function') _origMfRenderForecastForRf();
    else { _rcRenderTariffCards(); _rcRenderSystemStats(); }
    _rfRender();
  };
}

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    window.initRevenueForecast();
    _rfHookIntoForecastRefresh();
  }, 1300);
});

onLangChange(() => {
  _i18nRelabelStep("_rfRender", () => { if (document.getElementById('revenueForecastBox')) _rfRender(); });
});

onLangChange(() => {
  _i18nRelabelStep("rvOpenDrawer relabel", () => {
    const drawer = document.getElementById('rvDrawer');
    const openRestId = window._rvTargetId;
    if (drawer && drawer.style.display !== 'none' && openRestId && typeof window.rvOpenDrawer === "function") {
      window.rvOpenDrawer(openRestId);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 🏷️ RESTAURANT TEGLAR TIZIMI (VIP / Demo / Premium)
// ══════════════════════════════════════════════════════════════════════════════

const TAG_CONFIG = {
  vip:     { label: 'VIP',     emoji: '👑', bg: '#ede9fe', color: '#6d28d9' },
  demo:    { label: 'Demo',    emoji: '🎯', bg: '#dbeafe', color: '#1d4ed8' },
  premium: { label: 'Premium', emoji: '💎', bg: '#fef9c3', color: '#a16207' },
};
window.TAG_CONFIG = TAG_CONFIG;

// Jadval katakchasida teglarni render qilish
window.renderTagsCell = function (restId, tags) {
  tags = tags || [];
  const badges = tags.map(tag => {
    const cfg = TAG_CONFIG[tag];
    if (!cfg) return '';
    return `<span class="rest-tag" style="display:inline-flex;align-items:center;background:${cfg.bg};color:${cfg.color};font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;white-space:nowrap;">${cfg.emoji} ${cfg.label}</span>`;
  }).join('');

  return `
    <div style="display:flex; flex-direction:column; gap:4px; min-width:90px;">
      <div style="display:flex; flex-wrap:wrap; gap:3px;">${badges || '<span style="color:#d1d5db; font-size:11px;">—</span>'}</div>
      <button onclick="window.openTagModal('${restId}')"
        style="margin-top:2px; background:#f3f4f6; border:1px dashed #d1d5db; border-radius:7px; padding:3px 8px; font-size:10px; color:#6b7280; cursor:pointer; width:fit-content; white-space:nowrap; transition:background .15s;"
        onmouseover="this.style.background='#e0e7ff'; this.style.color='#3730a3';"
        onmouseout="this.style.background='#f3f4f6'; this.style.color='#6b7280';">
        ✏️ ${t('sa_add_tag_btn', "Teg qo'sh")}
      </button>
    </div>`;
};

// Tag modal ochish
let _tagModalRestId = null;

window.openTagModal = function (restId) {
  _tagModalRestId = restId;
  const rest = (window.allRestaurants || {})[restId];
  if (!rest) return;

  const info = rest.info || {};
  const currentTags = info.tags || [];

  // Restoran nomini ko'rsat
  const nameEl = document.getElementById('tagModalRestName');
  if (nameEl) nameEl.textContent = '🍽️  ' + (info.name || restId);

  // Checkbox ro'yxatini to'ldirish
  const list = document.getElementById('tagCheckboxList');
  if (list) {
    list.innerHTML = Object.entries(TAG_CONFIG).map(([key, cfg]) => {
      const isChecked = currentTags.includes(key);
      return `
        <label class="tag-checkbox-row${isChecked ? ' selected' : ''}" id="tagrow_${key}" onclick="window._toggleTagRow('${key}')"
          style="display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:10px; cursor:pointer; border:1px solid ${isChecked ? cfg.color : '#e5e7eb'}; background:${isChecked ? cfg.bg : '#fff'};">
          <input type="checkbox" id="tagchk_${key}" value="${key}" ${isChecked ? 'checked' : ''} onclick="event.stopPropagation(); window._toggleTagRow('${key}')">
          <span class="tag-label" style="font-weight:600; color:#374151;">${cfg.emoji} ${cfg.label}</span>
        </label>`;
    }).join('');
  }

  const modal = document.getElementById('tagModal');
  if (modal) { modal.style.display = 'flex'; }
};

window._toggleTagRow = function (key) {
  const chk = document.getElementById('tagchk_' + key);
  const row = document.getElementById('tagrow_' + key);
  if (!chk || !row) return;
  chk.checked = !chk.checked;
  const cfg = TAG_CONFIG[key];
  row.classList.toggle('selected', chk.checked);
  row.style.background = chk.checked ? cfg.bg : '#fff';
  row.style.borderColor = chk.checked ? cfg.color : '#e5e7eb';
};

window.closeTagModal = function () {
  const modal = document.getElementById('tagModal');
  if (modal) modal.style.display = 'none';
  _tagModalRestId = null;
};

// Teglarni Firebase'ga saqlash
window.saveRestaurantTags = async function () {
  if (!_tagModalRestId) return;
  const database = window.db;
  if (!database) return;

  const selected = [];
  Object.keys(TAG_CONFIG).forEach(key => {
    const chk = document.getElementById('tagchk_' + key);
    if (chk && chk.checked) selected.push(key);
  });

  try {
    await Promise.all([
      update(ref(database, `restaurants/${_tagModalRestId}/info`),        { tags: selected }),
      update(ref(database, `restaurants_meta/${_tagModalRestId}/info`),   { tags: selected }),
    ]);

    // Local cache yangilash
    if (window.allRestaurants && window.allRestaurants[_tagModalRestId]) {
      window.allRestaurants[_tagModalRestId].info = window.allRestaurants[_tagModalRestId].info || {};
      window.allRestaurants[_tagModalRestId].info.tags = selected;
    }

    // Audit log
    const restName = (window.allRestaurants[_tagModalRestId]?.info?.name) || _tagModalRestId;
    const tagStr = selected.length ? selected.join(', ') : t('sa_no_tag', 'hech qaysi teg');
    if (typeof window.logAudit === 'function') {
      window.logAudit('tag_update', restName, `${t('sa_log_tags_updated', "Teglar yangilandi:")} ${tagStr}`);
    }

    window.closeTagModal();

    // Jadval hujayralarini yangilash (full re-render shart emas)
    if (typeof window.renderRestaurantsTable === 'function') {
      window.renderRestaurantsTable();
    }

  } catch (err) {
    console.error(t('sa_tag_save_error', 'Tag saqlashda xato:'), err);
    alert(t('sa_error_prefix', 'Xatolik: ') + err.message);
  }
};

// Tashqariga bosganda modal yopilsin
document.addEventListener('click', e => {
  const modal = document.getElementById('tagModal');
  if (modal && modal.style.display === 'flex' && e.target === modal) {
    window.closeTagModal();
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 📋 VAZIFALAR (TASKS) TIZIMI
// Firebase path: systemData/tasks/{taskId}
// Struktura:
//   type: 'message' | 'discount' | 'pause'
//   targetMode: 'tag' | 'rest'
//   targetTags: string[]          (tag rejimida)
//   targetRestIds: string[]       (restoran rejimida)
//   scheduledAt: number           (ms timestamp)
//   message: string               (type=message uchun)
//   discountPct: number           (type=discount uchun)
//   note: string
//   status: 'pending' | 'done' | 'failed'
//   createdAt: number
//   doneAt: number|null
//   doneDetails: string|null
// ══════════════════════════════════════════════════════════════════════════════

let _allTasks = {};
let _taskCurrentTab = 'pending';
let _taskNotifTimer = null;

// ── Firebase listener ──────────────────────────────────────────────────────
function listenTasks() {
  const database = window.db;
  if (!database) return;
  onValue(ref(database, 'systemData/tasks'), snap => {
    _allTasks = snap.exists() ? snap.val() : {};
    window.renderTasksList();
    window.updateTaskStats();
    window.updateTasksBadge();
    window.checkTaskNotifications();
  });
}

// ── Tab switching ──────────────────────────────────────────────────────────
window.taskSwitchTab = function (tab) {
  _taskCurrentTab = tab;
  document.querySelectorAll('.task-tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.style.borderColor  = active ? '#6366f1' : '#e5e7eb';
    btn.style.background   = active ? '#eff0ff'  : '#fff';
    btn.style.color        = active ? '#4338ca'  : '#374151';
  });
  window.renderTasksList();
};

// ── Stats ──────────────────────────────────────────────────────────────────
window.updateTaskStats = function () {
  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  let total=0, pending=0, done=0, overdue=0;
  Object.values(_allTasks).forEach(t => {
    total++;
    if (t.status === 'done') { done++; return; }
    pending++;
    if (t.scheduledAt <= now) overdue++;
  });
  const setEl = (id,v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  setEl('taskStatTotal',   total);
  setEl('taskStatPending', pending);
  setEl('taskStatDone',    done);
  setEl('taskStatOverdue', overdue);
};

// ── Badge (sidebar) ────────────────────────────────────────────────────────
window.updateTasksBadge = function () {
  const now = Date.now();
  let urgent = 0;
  Object.values(_allTasks).forEach(t => {
    if (t.status !== 'done' && t.scheduledAt <= now + 24*3600*1000) urgent++;
  });
  const badge = document.getElementById('tasksBadge');
  if (!badge) return;
  if (urgent > 0) { badge.textContent = urgent; badge.style.display = 'inline-block'; }
  else badge.style.display = 'none';
};

// ── Render task list ───────────────────────────────────────────────────────
window.renderTasksList = function () {
  const container = document.getElementById('tasksListContainer');
  if (!container) return;
  const now = Date.now();
  const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);

  let tasks = Object.entries(_allTasks).map(([id, t]) => ({ id, ...t }));

  // Tab filter
  tasks = tasks.filter(t => {
    if (_taskCurrentTab === 'done')    return t.status === 'done';
    if (_taskCurrentTab === 'pending') return t.status !== 'done' && t.scheduledAt > now;
    if (_taskCurrentTab === 'today')   return t.status !== 'done' && t.scheduledAt <= now;
    return true; // 'all'
  });

  // Sort: pending first by scheduledAt asc, done by doneAt desc
  tasks.sort((a, b) => {
    if (a.status === 'done' && b.status !== 'done') return 1;
    if (b.status === 'done' && a.status !== 'done') return -1;
    return a.scheduledAt - b.scheduledAt;
  });

  if (!tasks.length) {
    container.innerHTML = `
      <div style="text-align:center; padding:60px; color:#94a3b8;">
        <div style="font-size:36px; margin-bottom:12px;">📭</div>
        <div style="font-size:14px; font-weight:600;">${t('sa_tasks_empty', "Bu bo'limda vazifalar yo'q")}</div>
        <div style="font-size:12px; margin-top:4px;">${t('sa_tasks_empty_hint', "Yangi vazifa qo'shish uchun \"Yangi vazifa\" tugmasini bosing")}</div>
      </div>`;
    return;
  }

  container.innerHTML = tasks.map(t => renderTaskCard(t, now)).join('');
};

function renderTaskCard(task, now) {
  const isDone    = task.status === 'done';
  const isOverdue = !isDone && task.scheduledAt <= now;
  const isToday   = !isDone && !isOverdue && task.scheduledAt <= now + 24*3600*1000;

  const typeConf = {
    message:  { icon: '💬', label: t('sa_task_type_message',  'Xabar yuborish'),    cls: 'task-type--message'  },
    discount: { icon: '🎟️', label: t('sa_task_type_discount', 'Chegirma berish'),   cls: 'task-type--discount' },
    pause:    { icon: '⏸️',  label: t('sa_task_type_pause',    "Obuna to'xtatish"), cls: 'task-type--pause'    },
  }[task.type] || { icon: '📋', label: task.type, cls: '' };

  // Target description
  let targetStr = '';
  if (task.targetMode === 'tag' && task.targetTags?.length) {
    const tagLabels = { vip: t("sa_tag_vip", "👑 VIP"), problematic: t("sa_tag_problematic", "⚠️ Problematic"), demo: t("sa_tag_demo", "🎯 Demo"), partner: t("sa_tag_partner", "🤝 Partner"), enterprise: t("sa_tag_enterprise", "🏢 Enterprise") };
    targetStr = task.targetTags.map(tg => tagLabels[tg] || tg).join(', ');
  } else if (task.targetMode === 'rest' && task.targetRestIds?.length) {
    const names = task.targetRestIds.map(id => (window.allRestaurants?.[id]?.info?.name) || id);
    targetStr = names.slice(0,3).join(', ') + (names.length > 3 ? ` ${t('sa_task_and_more', "va yana")} ${names.length-3} ${t('sa_task_count_suffix', "ta")}` : '');
  }

  // Affected count
  const affectedCount = countAffected(task);

  // Time label
  const diffMs  = task.scheduledAt - now;
  const absDiff = Math.abs(diffMs);
  const timeLbl = isOverdue
    ? formatTimeDiff(absDiff) + ' ' + t('sa_task_time_ago', "oldin o'tgan")
    : diffMs < 60000 ? t('sa_task_time_almost_now', 'Deyarli hozir') : formatTimeDiff(diffMs) + ' ' + t('sa_task_time_left', 'qoldi');

  const timeFormatted = new Date(task.scheduledAt).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });

  // Content description
  let contentDesc = '';
  if (task.type === 'message' && task.message)       contentDesc = `"${task.message.substring(0,80)}${task.message.length>80?'...':''}"`;
  else if (task.type === 'discount' && task.discountPct) contentDesc = `${task.discountPct}${t('sa_task_discount_coupon', "% chegirma kuponi")}`;
  else if (task.type === 'pause')                  contentDesc = t('sa_task_pause_desc', "Restoranlar obunasi vaqtincha to'xtatiladi");

  const cardCls = isDone ? 'task-done' : isOverdue ? 'task-overdue' : isToday ? 'task-today' : '';

  const doneLabel = isDone
    ? `<span class="task-pill task-pill--done">✅ ${new Date(task.doneAt||0).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>` : '';

  const timePill = isDone ? '' : isOverdue
    ? `<span class="task-pill task-pill--overdue">🔴 ${timeLbl}</span>`
    : isToday
    ? `<span class="task-pill task-pill--today">🟡 ${timeLbl}</span>`
    : `<span class="task-pill task-pill--time">🕐 ${timeLbl}</span>`;

  return `
  <div class="task-card ${cardCls}">
    <div class="task-type-icon ${typeConf.cls}">${typeConf.icon}</div>
    <div class="task-meta">
      <div class="task-title">${typeConf.label}</div>
      <div class="task-desc">
        <strong>${targetStr}</strong>${contentDesc ? ' · ' + contentDesc : ''}
        ${task.note ? ' · <em>' + escapeHtml(task.note) + '</em>' : ''}
      </div>
      <div class="task-pills">
        ${timePill}
        ${doneLabel}
        <span class="task-pill task-pill--time">📅 ${timeFormatted}</span>
        ${task.targetMode==='tag' ? `<span class="task-pill task-pill--tag">🏷️ ${t('sa_task_by_tag', "Teg bo'yicha")}</span>` : ''}
        ${affectedCount > 0 ? `<span class="task-pill task-pill--count">🍽️ ${affectedCount} ${t('sa_task_restaurant_word', "restoran")}</span>` : ''}
      </div>
    </div>
    <div class="task-actions">
      ${!isDone ? `
        <button class="task-btn task-btn--run" onclick="window.executeTask('${task.id}', true)" title="${t('sa_task_run_now', "Hozir bajarish")}">
          ▶ ${t('sa_task_run_btn', "Bajarish")}
        </button>` : `
        <button class="task-btn task-btn--done" disabled>✅ ${t('sa_task_done_label', "Bajarildi")}</button>`}
      <button class="task-btn task-btn--delete" onclick="window.deleteTask('${task.id}')" title="${t('sa_task_delete_title', "O'chirish")}">
        <i class="fa-solid fa-trash"></i>
      </button>
    </div>
  </div>`;
}

function formatTimeDiff(ms) {
  const mins  = Math.floor(ms / 60000);
  const hours = Math.floor(ms / 3600000);
  const days  = Math.floor(ms / 86400000);
  if (days >= 1)  return days  + ' ' + t("sa_days", "kun");
  if (hours >= 1) return hours + ' ' + t("hours_short", "soat");
  return mins     + ' ' + t("minutes", "daqiqa");
}

function countAffected(task) {
  if (!window.allRestaurants) return 0;
  if (task.targetMode === 'rest') return (task.targetRestIds || []).length;
  if (task.targetMode === 'tag') {
    const tags = task.targetTags || [];
    return Object.values(window.allRestaurants).filter(r => {
      const rt = r.info?.tags || [];
      return tags.some(tg => rt.includes(tg));
    }).length;
  }
  return 0;
}

// ── Notification checker (5 min interval) ─────────────────────────────────
window.checkTaskNotifications = function () {
  if (_taskNotifTimer) clearInterval(_taskNotifTimer);
  _taskNotifTimer = setInterval(_checkDueTasksNow, 5 * 60 * 1000);
  _checkDueTasksNow(); // darhol tekshir
};

function _checkDueTasksNow() {
  const now = Date.now();
  const WARN_WINDOW = 15 * 60 * 1000; // 15 daqiqa oldindan ogohlantirish

  Object.entries(_allTasks).forEach(([id, task]) => {
    if (task.status === 'done') return;
    const diff = task.scheduledAt - now;

    // Hozir yoki 15 daqiqa ichida — notification
    if (diff <= WARN_WINDOW && diff > -3600000) { // -1 soatga qadar (o'tmish)
      _showTaskNotif(id, task, diff);
    }

    // Avtomatik bajarish: vaqti yetgan va hali bajarilmagan
    if (diff <= 0 && diff > -300000) { // 5 daqiqa ichida avtomatik
      window.executeTask(id, false); // false = auto (confirm so'ramsiz)
    }
  });
}

function _showTaskNotif(taskId, task, diffMs) {
  const notifKey = 'task_notif_' + taskId;
  if (sessionStorage.getItem(notifKey)) return;
  sessionStorage.setItem(notifKey, '1');

  const typeLabels = { message: t('sa_task_type_message', "Xabar yuborish"), discount: t('sa_task_type_discount', "Chegirma berish"), pause: t('sa_task_type_pause', "Obuna to'xtatish") };
  const label = typeLabels[task.type] || task.type;
  const soon = diffMs > 0 ? formatTimeDiff(diffMs) + ' ' + t('sa_task_within', 'ichida') : t('sa_task_now_passed', "hozir (o'tgan)");

  window.updateTasksBadge();

  _pushToNotifDropdown(taskId, task, label, soon);

  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('📋 ' + t('sa_task_notif_title', 'Vazifa eslatmasi'), {
      body: `${label} — ${soon}`,
      icon: 'img/logo (2).svg'
    });
  }
}

function _pushToNotifDropdown(taskId, task, label, soon) {
  const container = document.getElementById('notifListContainer');
  if (!container) return;

  const existing = container.querySelector(`[data-task-notif="${taskId}"]`);
  if (existing) return;

  const div = document.createElement('div');
  div.setAttribute('data-task-notif', taskId);
  div.style.cssText = 'padding:12px 16px; border-bottom:1px solid #f1f5f9; display:flex; align-items:flex-start; gap:10px; cursor:pointer;';
  div.onclick = () => { document.querySelector('a[href="#tasks"]')?.click(); };
  div.innerHTML = `
    <span style="font-size:20px; flex-shrink:0;">📋</span>
    <div style="flex:1; min-width:0;">
      <div style="font-size:13px; font-weight:700; color:#111827;">${label}</div>
      <div style="font-size:11px; color:#6b7280; margin-top:2px;">${soon}</div>
      <div style="font-size:11px; color:#9ca3af; margin-top:1px;">
        ${new Date(task.scheduledAt).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}
      </div>
    </div>
    <button onclick="event.stopPropagation(); window.executeTask('${taskId}', true)"
      style="background:#4f46e5; color:#fff; border:none; border-radius:7px; padding:5px 10px; font-size:11px; font-weight:700; cursor:pointer; flex-shrink:0;">
      ▶
    </button>`;

  container.prepend(div);

  // Badge yangilash
  const badge = document.getElementById('notifBadgeCount');
  if (badge) {
    const cur = parseInt(badge.textContent || '0') + 1;
    badge.textContent = cur;
    badge.style.display = 'flex';
  }
}

// ── Task bajarish ──────────────────────────────────────────────────────────
window.executeTask = async function (taskId, askConfirm = true) {
  const task = _allTasks[taskId];
  if (!task || task.status === 'done') return;
  const database = window.db;
  if (!database) return;

  const affected = getAffectedRestaurants(task);
  if (!affected.length) {
    if (askConfirm) alert(t('sa_task_no_target_rest', "Mos restoran topilmadi! Teg bo'yicha hech kim yo'q yoki restoranlar tanlanmagan."));
    return;
  }

  const typeLabels = { message: t('sa_task_type_message', "Xabar yuborish"), discount: t('sa_task_type_discount', "Chegirma berish"), pause: t('sa_task_type_pause', "Obuna to'xtatish") };
  if (askConfirm) {
    if (!confirm(`"${typeLabels[task.type]}" ${t('sa_task_confirm_run', "amalini")} ${affected.length} ${t('sa_task_confirm_run_suffix', "ta restoranga bajarishni tasdiqlaysizmi?")}`)) return;
  }

  const now = Date.now();
  const updates = {};
  let logDetails = '';

  try {
    if (task.type === 'message') {
      // Har bir restoranga xabar yuborish (bildirishnoma + superadmin chat)
      for (const restId of affected) {
        const pushRef = push(ref(database, `restaurants/${restId}/notifications`));
        updates[`restaurants/${restId}/notifications/${pushRef.key}`] = {
          message: task.message,
          from: 'superadmin',
          type: 'broadcast',
          taskId: taskId,
          createdAt: now,
          read: false
        };
        // Superadmin chat ga ham yozish
        const chatRef = push(ref(database, `systemData/saChat/${restId}`));
        updates[`systemData/saChat/${restId}/${chatRef.key}`] = {
          text: task.message,
          from: 'admin',
          timestamp: now
        };
      }
      logDetails = `${t('sa_task_log_msg_sent', "Xabar yuborildi:")} ${affected.length} ${t('sa_task_log_to_rest', "ta restoranga")}`;

    } else if (task.type === 'discount') {
      const pct = task.discountPct || 0;
      for (const restId of affected) {
        updates[`restaurants/${restId}/bonus/discountPercent`] = pct;
        updates[`restaurants/${restId}/bonus/discountAt`]      = now;
        updates[`restaurants/${restId}/bonus/discountNote`]    = `${t('sa_task_log_auto_discount', "Vazifadan avtomatik:")} ${pct}% ${t('sa_task_log_discount_word', "chegirma")} (taskId:${taskId})`;
      }
      logDetails = `${pct}${t('sa_task_log_discount_given', "% chegirma berildi:")} ${affected.length} ${t('sa_task_log_to_rest', "ta restoranga")}`;

    } else if (task.type === 'pause') {
      for (const restId of affected) {
        const rest = window.allRestaurants?.[restId] || {};
        const sub  = rest.subscription || {};
        const expireAt = Number(sub.expireAt || sub.expireDate || 0);
        if (expireAt <= now) continue; // muddati tugagan — o'tkazib yuboramiz
        const remainingMs = expireAt - now;
        updates[`restaurants/${restId}/info/status`]        = 'paused';
        updates[`restaurants/${restId}/info/pausedAt`]      = now;
        updates[`restaurants/${restId}/info/remainingMs`]   = remainingMs;
        updates[`restaurants/${restId}/subscription/status`] = 'paused';
        updates[`restaurants_meta/${restId}/info/status`]   = 'paused';
        updates[`restaurants_meta/${restId}/info/pausedAt`] = now;
        updates[`restaurants_meta/${restId}/info/remainingMs`] = remainingMs;
        updates[`restaurants_meta/${restId}/subscription/status`] = 'paused';
      }
      logDetails = `${t('sa_task_log_paused', "Obuna to'xtatildi:")} ${affected.length} ${t('sa_task_restaurant_word', "restoran")}`;
    }

    // Task ni done qilish
    updates[`systemData/tasks/${taskId}/status`]      = 'done';
    updates[`systemData/tasks/${taskId}/doneAt`]      = now;
    updates[`systemData/tasks/${taskId}/doneDetails`] = logDetails;
    updates[`systemData/tasks/${taskId}/affectedCount`] = affected.length;

    await update(ref(database), updates);

    window.logAudit && window.logAudit('task_execute', `Task#${taskId}`, logDetails);

    if (typeof window.renderRestaurantsTable === 'function') window.renderRestaurantsTable();

    if (askConfirm) {
      alert(`✅ ${t('sa_task_completed', "Bajarildi!")}\n${logDetails}`);
    }
  } catch (err) {
    console.error(t('sa_task_exec_error', 'Task bajarishda xato:'), err);
    if (askConfirm) alert(t('sa_error_prefix', 'Xatolik: ') + err.message);
    // Mark as failed
    await update(ref(database, `systemData/tasks/${taskId}`), { status: 'failed', failedAt: now, failReason: err.message }).catch(()=>{});
  }
};

function getAffectedRestaurants(task) {
  if (!window.allRestaurants) return [];
  if (task.targetMode === 'rest') return task.targetRestIds || [];
  if (task.targetMode === 'tag') {
    const tags = task.targetTags || [];
    return Object.entries(window.allRestaurants)
      .filter(([, r]) => { const rt = r.info?.tags || []; return tags.some(tg => rt.includes(tg)); })
      .map(([id]) => id);
  }
  return [];
}

// ── Task o'chirish ─────────────────────────────────────────────────────────
window.deleteTask = async function (taskId) {
  if (!confirm(t('sa_task_delete_confirm', "Bu vazifani o'chirishni tasdiqlaysizmi?"))) return;
  try {
    await remove(ref(window.db, `systemData/tasks/${taskId}`));
    window.logAudit && window.logAudit('task_delete', `Task#${taskId}`, t('sa_task_deleted_log', "Vazifa o'chirildi"));
  } catch (err) {
    alert(t('sa_error_prefix', 'Xatolik: ') + err.message);
  }
};

// ── CREATE TASK MODAL ──────────────────────────────────────────────────────
let _ctaskType       = 'message';
let _ctaskTargetMode = 'tag';
let _ctaskSelTags    = new Set();
let _ctaskSelRests   = new Set(); // Set of restIds

window.openCreateTaskModal = function () {
  _ctaskType       = 'message';
  _ctaskTargetMode = 'tag';
  _ctaskSelTags    = new Set();
  _ctaskSelRests   = new Set();

  // Reset UI
  ['message','discount','pause'].forEach(t => {
    const btn = document.getElementById('ctask_type_' + t);
    if (btn) btn.classList.toggle('active', t === 'message');
  });
  ['tag','rest'].forEach(t => {
    const btn = document.getElementById('ctask_target_' + t);
    if (btn) btn.classList.toggle('active', t === 'tag');
  });

  document.querySelectorAll('.ctask-tag-chip').forEach(c => c.classList.remove('selected'));
  const tagsWrap = document.getElementById('ctask_tags_wrap');
  const restWrap = document.getElementById('ctask_rest_wrap');
  if (tagsWrap) tagsWrap.style.display = 'flex';
  if (restWrap) restWrap.style.display = 'none';

  ['message','discount','pause'].forEach(p => {
    const el = document.getElementById('ctask_param_' + p);
    if (el) el.style.display = p === 'message' ? 'block' : 'none';
  });

  const msgEl = document.getElementById('ctask_message_text');
  if (msgEl) msgEl.value = '';
  const discEl = document.getElementById('ctask_discount_pct');
  if (discEl) discEl.value = '';
  const noteEl = document.getElementById('ctask_note');
  if (noteEl) noteEl.value = '';
  const searchEl = document.getElementById('ctask_rest_search');
  if (searchEl) searchEl.value = '';
  const resListEl = document.getElementById('ctask_rest_selected_list');
  if (resListEl) resListEl.innerHTML = '';
  const resResultsEl = document.getElementById('ctask_rest_results');
  if (resResultsEl) { resResultsEl.innerHTML = ''; resResultsEl.style.display = 'none'; }

  // Default date: ertaga 09:00
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const dateEl = document.getElementById('ctask_date');
  const timeEl = document.getElementById('ctask_time');
  if (dateEl) dateEl.value = tomorrow.toISOString().slice(0,10);
  if (timeEl) timeEl.value = '09:00';

  _ctaskUpdateTargetCount();

  const modal = document.getElementById('createTaskModal');
  if (modal) modal.style.display = 'flex';
};

window.closeCreateTaskModal = function () {
  const modal = document.getElementById('createTaskModal');
  if (modal) modal.style.display = 'none';
};

window.ctaskSelectType = function (type) {
  _ctaskType = type;
  ['message','discount','pause'].forEach(t => {
    const btn = document.getElementById('ctask_type_' + t);
    if (btn) btn.classList.toggle('active', t === type);
    const param = document.getElementById('ctask_param_' + t);
    if (param) param.style.display = t === type ? 'block' : 'none';
  });
};

window.ctaskSelectTarget = function (mode) {
  _ctaskTargetMode = mode;
  ['tag','rest'].forEach(t => {
    const btn = document.getElementById('ctask_target_' + t);
    if (btn) btn.classList.toggle('active', t === mode);
  });
  const tagsWrap = document.getElementById('ctask_tags_wrap');
  const restWrap = document.getElementById('ctask_rest_wrap');
  if (tagsWrap) tagsWrap.style.display = mode === 'tag' ? 'flex' : 'none';
  if (restWrap) restWrap.style.display = mode === 'rest' ? 'block' : 'none';
  _ctaskUpdateTargetCount();
};

window.ctaskToggleTag = function (tag) {
  if (_ctaskSelTags.has(tag)) _ctaskSelTags.delete(tag);
  else _ctaskSelTags.add(tag);
  document.querySelectorAll(`.ctask-tag-chip[data-tag="${tag}"]`).forEach(c => {
    c.classList.toggle('selected', _ctaskSelTags.has(tag));
  });
  _ctaskUpdateTargetCount();
};

window.ctaskSearchRest = function (query) {
  const resEl = document.getElementById('ctask_rest_results');
  if (!resEl) return;
  query = query.toLowerCase().trim();
  if (!query) { resEl.style.display = 'none'; resEl.innerHTML = ''; return; }

  const matches = Object.entries(window.allRestaurants || {}).filter(([, r]) => {
    const name = (r.info?.name || '').toLowerCase();
    const domain = (r.info?.domain || '').toLowerCase();
    return name.includes(query) || domain.includes(query);
  }).slice(0, 8);

  if (!matches.length) { resEl.innerHTML = `<div style="padding:12px; font-size:13px; color:#9ca3af; text-align:center;">${t('sa_ctask_not_found', "Topilmadi")}</div>`; resEl.style.display = 'block'; return; }

  resEl.style.display = 'block';
  resEl.innerHTML = matches.map(([id, r]) => `
    <div onclick="window.ctaskAddRest('${id}')"
      style="padding:10px 14px; font-size:13px; font-weight:600; color:#374151; cursor:pointer; display:flex; align-items:center; gap:8px;"
      onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background=''">
      <span style="width:28px; height:28px; background:#e0e7ff; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:14px; flex-shrink:0;">🍽️</span>
      <div>
        <div>${escapeHtml(r.info?.name || id)}</div>
        <div style="font-size:11px; color:#9ca3af;">${r.info?.domain || ''}.nestacrm.uz</div>
      </div>
    </div>`).join('');
};

window.ctaskAddRest = function (restId) {
  _ctaskSelRests.add(restId);
  const searchEl = document.getElementById('ctask_rest_search');
  if (searchEl) searchEl.value = '';
  const resEl = document.getElementById('ctask_rest_results');
  if (resEl) { resEl.style.display = 'none'; resEl.innerHTML = ''; }
  _ctaskRenderSelectedRests();
  _ctaskUpdateTargetCount();
};

function _ctaskRenderSelectedRests() {
  const el = document.getElementById('ctask_rest_selected_list');
  if (!el) return;
  el.innerHTML = [..._ctaskSelRests].map(id => {
    const name = window.allRestaurants?.[id]?.info?.name || id;
    return `<span style="display:inline-flex; align-items:center; gap:5px; background:#ede9fe; color:#5b21b6; border-radius:20px; padding:4px 10px; font-size:12px; font-weight:600;">
      🍽️ ${escapeHtml(name)}
      <span onclick="window.ctaskRemoveRest('${id}')" style="cursor:pointer; color:#7c3aed; font-weight:800; font-size:14px; line-height:1;">×</span>
    </span>`;
  }).join('');
}

window.ctaskRemoveRest = function (restId) {
  _ctaskSelRests.delete(restId);
  _ctaskRenderSelectedRests();
  _ctaskUpdateTargetCount();
};

function _ctaskUpdateTargetCount() {
  const el = document.getElementById('ctask_target_count');
  if (!el) return;
  let count = 0;
  let label = '';
  if (_ctaskTargetMode === 'tag') {
    if (!_ctaskSelTags.size) { el.textContent = ''; return; }
    count = Object.values(window.allRestaurants || {}).filter(r => {
      const rt = r.info?.tags || [];
      return [..._ctaskSelTags].some(tg => rt.includes(tg));
    }).length;
    label = `🍽️ ${count} ${t('sa_ctask_found_by_tag', "ta restoran topildi (tanlangan teglar bo'yicha)")}`;
  } else {
    count = _ctaskSelRests.size;
    label = count ? `🍽️ ${count} ${t('sa_ctask_selected', "ta restoran tanlandi")}` : '';
  }
  el.textContent = label;
}

window.ctaskQuickTime = function (days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const dateEl = document.getElementById('ctask_date');
  const timeEl = document.getElementById('ctask_time');
  if (dateEl) dateEl.value = d.toISOString().slice(0,10);
  if (timeEl && days === 0) timeEl.value = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
};

window.saveTask = async function () {
  const database = window.db;
  if (!database) return;

  // Validatsiya
  if (_ctaskTargetMode === 'tag' && !_ctaskSelTags.size) {
    alert(t('sa_ctask_val_tag', "Kamida bitta teg tanlang!")); return;
  }
  if (_ctaskTargetMode === 'rest' && !_ctaskSelRests.size) {
    alert(t('sa_ctask_val_rest', "Kamida bitta restoran tanlang!")); return;
  }

  const dateVal = document.getElementById('ctask_date')?.value;
  const timeVal = document.getElementById('ctask_time')?.value || '09:00';
  if (!dateVal) { alert(t('sa_ctask_val_date', "Sanani kiriting!")); return; }

  const scheduledAt = new Date(`${dateVal}T${timeVal}:00`).getTime();
  if (isNaN(scheduledAt)) { alert(t('sa_ctask_val_date_invalid', "Sana noto'g'ri!")); return; }

  const now = Date.now();
  const payload = {
    type: _ctaskType,
    targetMode: _ctaskTargetMode,
    targetTags:    _ctaskTargetMode === 'tag'  ? [..._ctaskSelTags]  : [],
    targetRestIds: _ctaskTargetMode === 'rest' ? [..._ctaskSelRests] : [],
    scheduledAt,
    note: document.getElementById('ctask_note')?.value.trim() || '',
    status: 'pending',
    createdAt: now,
    doneAt: null,
    doneDetails: null,
    affectedCount: 0
  };

  if (_ctaskType === 'message') {
    const msg = document.getElementById('ctask_message_text')?.value.trim() || '';
    if (!msg) { alert(t('sa_ctask_val_message', "Xabar matnini kiriting!")); return; }
    payload.message = msg;
  }
  if (_ctaskType === 'discount') {
    const pct = parseInt(document.getElementById('ctask_discount_pct')?.value || '0');
    if (!pct || pct < 1 || pct > 100) { alert(t('sa_ctask_val_discount', "Chegirma foizini 1-100 oralig'ida kiriting!")); return; }
    payload.discountPct = pct;
  }

  try {
    await push(ref(database, 'systemData/tasks'), payload);
    window.logAudit && window.logAudit('task_create', `${t('sa_ctask_log_new_task', "Yangi vazifa")} (${_ctaskType})`, `${payload.targetMode==='tag'?payload.targetTags.join(','):payload.targetRestIds.length+' rest'} · ${new Date(scheduledAt).toLocaleString('ru-RU')}`);
    window.closeCreateTaskModal();
  } catch (err) {
    alert(t('sa_ctask_save_error', "Saqlashda xatolik: ") + err.message);
  }
};

// ── Tasks bo'limiga o'tganda listener ishga tushirish ─────────────────────
document.addEventListener('click', e => {
  const link = e.target.closest('a[href="#tasks"]');
  if (link) {
    setTimeout(() => {
      if (!Object.keys(_allTasks).length) listenTasks();
    }, 100);
  }

  // Create task modal tashqarisiga bosish
  const ctModal = document.getElementById('createTaskModal');
  if (ctModal && ctModal.style.display === 'flex' && e.target === ctModal) {
    window.closeCreateTaskModal();
  }
});

// initNavigation'ni kengaytirish kerak emas — initNavigation o'zida tasks bo'limini handle qiladi

// Restaurants yangilanganda task count'larni ham yangilash (re-declaration yo'q)
const _origLisRest = window.listenRestaurants;
window.listenRestaurants = function () {
  if (typeof _origLisRest === 'function') _origLisRest.apply(this, arguments);
  // Restaurants yuklanganda task count'larni yangilash
  setTimeout(() => {
    if (Object.keys(_allTasks).length) {
      window.updateTaskStats();
      window.renderTasksList();
    }
  }, 500);
};
// ============================================
// 🧩 MODULLAR BOSHQARUVI (SUPERADMIN)
// Restoran kartochkasidagi "Modullar" tugmasi orqali ochiladi.
// Har bir restoran uchun /restaurants/{id}/modules ni ko'rish/tahrirlash.
// ============================================
window._modulesEditingRestId = null;

function _ensureModulesModalDom() {
  if (document.getElementById('saModulesModal')) return;

  const html = `
  <style>
    .sa-mod-modal { position:fixed; inset:0; background:rgba(15,23,42,0.55); z-index:99998;
      display:none; align-items:center; justify-content:center; }
    .sa-mod-modal.flex { display:flex; }
    .sa-mod-box { background:#fff; border-radius:16px; width:92%; max-width:480px; max-height:86vh;
      overflow-y:auto; box-shadow:0 24px 60px rgba(0,0,0,0.28); }
    .sa-mod-head { padding:18px 22px; border-bottom:1px solid #eef2f7; display:flex; align-items:center; justify-content:space-between; }
    .sa-mod-head h3 { margin:0; font-size:16px; color:#1e293b; }
    .sa-mod-head button { background:none; border:none; font-size:18px; color:#94a3b8; cursor:pointer; }
    .sa-mod-body { padding:14px 22px 6px; }
    .sa-mod-bt-hint { font-size:12px; color:#64748b; background:#f8fafc; border:1px solid #eef2f7;
      border-radius:10px; padding:10px 12px; margin-bottom:14px; display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .sa-mod-bt-hint button { background:#eef2ff; color:#4338ca; border:none; border-radius:8px;
      padding:6px 10px; font-size:12px; font-weight:700; cursor:pointer; white-space:nowrap; }
    .sa-mod-row { display:flex; align-items:center; justify-content:space-between; padding:9px 0;
      border-bottom:1px dashed #f1f5f9; font-size:14px; color:#334155; }
    .sa-mod-row:last-child { border-bottom:none; }
    .sa-mod-switch { position:relative; width:42px; height:24px; flex-shrink:0; }
    .sa-mod-switch input { opacity:0; width:0; height:0; }
    .sa-mod-slider { position:absolute; cursor:pointer; inset:0; background:#e2e8f0; border-radius:24px; transition:.2s; }
    .sa-mod-slider:before { content:""; position:absolute; height:18px; width:18px; left:3px; bottom:3px;
      background:#fff; border-radius:50%; transition:.2s; box-shadow:0 1px 3px rgba(0,0,0,0.2); }
    .sa-mod-switch input:checked + .sa-mod-slider { background:#10b981; }
    .sa-mod-switch input:checked + .sa-mod-slider:before { transform:translateX(18px); }
    .sa-mod-foot { padding:14px 22px 20px; }
    .sa-mod-save-btn { width:100%; background:#10b981; color:#fff; border:none; border-radius:10px;
      padding:12px; font-size:14px; font-weight:700; cursor:pointer; }
    .sa-mod-save-btn:disabled { opacity:.6; cursor:not-allowed; }
  </style>
  <div id="saModulesModal" class="sa-mod-modal">
    <div class="sa-mod-box">
      <div class="sa-mod-head">
        <h3>🧩 <span id="saModulesRestName">${t("sa_modules_title", "Modullar")}</span></h3>
        <button onclick="window.closeSaModulesModal()"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="sa-mod-body">
        <div class="sa-mod-bt-hint">
          <span id="saModulesBtHint">${t("sa_modules_bt_hint", "Biznes turiga mos modullarni avtomatik qo'llash")}</span>
          <button onclick="window.applyRecommendedModules()">${t("sa_modules_apply_btn", "Tavsiyani qo'llash")}</button>
        </div>
        <div id="saModulesList"></div>
      </div>
      <div class="sa-mod-foot">
        <button class="sa-mod-save-btn" id="saModulesSaveBtn" onclick="window.saveModulesForRestaurant()">
          ${t("sa_modules_save_btn", "Saqlash")}
        </button>
      </div>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('saModulesModal').addEventListener('click', e => {
    if (e.target.id === 'saModulesModal') window.closeSaModulesModal();
  });
}

window._saModulesPendingState = {};

window.openSaModulesModal = async function (restId) {
  _ensureModulesModalDom();
  window._modulesEditingRestId = restId;

  const rest = window.allRestaurants?.[restId];
  if (!rest) { alert(t("sa_rest_not_found", "Restoran topilmadi!")); return; }

  const nameEl = document.getElementById('saModulesRestName');
  if (nameEl) nameEl.textContent = rest.info?.name || restId;

  const businessType = rest.info?.businessType || "other";
  const btLabelData = window.BUSINESS_TYPE_MODULES[businessType];
  const btLabel = btLabelData ? (typeof btLabelData.label === "function" ? btLabelData.label() : btLabelData.label) : businessType;
  const hintEl = document.getElementById('saModulesBtHint');
  if (hintEl) hintEl.textContent = `${t("sa_modules_bt_prefix", "Biznes turi")}: ${btLabel}`;

  const currentModules = rest.modules || window.buildModulesFromBusinessType(businessType);
  window._saModulesPendingState = { ...currentModules };

  _renderSaModulesList();

  const modal = document.getElementById('saModulesModal');
  modal.classList.add('flex');
  modal.style.display = 'flex';
};

function _renderSaModulesList() {
  const list = document.getElementById('saModulesList');
  if (!list) return;
  const state = window._saModulesPendingState;

  list.innerHTML = Object.entries(window.MODULE_CATALOG).map(([id, mod]) => {
    const checked = !!state[id];
    const label = typeof mod.n === "function" ? mod.n() : mod.n;
    return `
      <div class="sa-mod-row">
        <span>${label}</span>
        <label class="sa-mod-switch">
          <input type="checkbox" ${checked ? "checked" : ""} onchange="window._toggleSaModule('${id}', this.checked)">
          <span class="sa-mod-slider"></span>
        </label>
      </div>`;
  }).join("");
}

window._toggleSaModule = function (moduleId, value) {
  window._saModulesPendingState[moduleId] = value;
};

window.applyRecommendedModules = function () {
  const restId = window._modulesEditingRestId;
  const rest = window.allRestaurants?.[restId];
  if (!rest) return;
  const businessType = rest.info?.businessType || "other";
  window._saModulesPendingState = window.buildModulesFromBusinessType(businessType);
  _renderSaModulesList();
};

window.closeSaModulesModal = function () {
  const modal = document.getElementById('saModulesModal');
  if (modal) { modal.classList.remove('flex'); modal.style.display = 'none'; }
  window._modulesEditingRestId = null;
};

window.saveModulesForRestaurant = async function () {
  const restId = window._modulesEditingRestId;
  if (!restId) return;

  const btn = document.getElementById('saModulesSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = t("sa_saving", "Saqlanmoqda..."); }

  try {
    const modules = window._saModulesPendingState;
    await update(ref(window.db, `restaurants/${restId}/modules`), modules);
    await update(ref(window.db, `restaurants_meta/${restId}/modules`), modules);

    window.logAudit && window.logAudit('modules_update', window.allRestaurants?.[restId]?.info?.name || restId,
      `${t("sa_modules_updated_log", "Modullar yangilandi:")} ${Object.entries(modules).filter(([,v]) => v).map(([k]) => k).join(', ')}`);

    window.closeSaModulesModal();
  } catch (error) {
    alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t("sa_modules_save_btn", "Saqlash"); }
  }
};
// ═══════════════════════════════════════════════════════════════════
// FRANCHISE MANAGEMENT MODULE
// Firebase path: systemData/franchises/{franchiseId}
//   {
//     name: string,
//     parentId: restaurantId (franchayzer),
//     royaltyPct: number,
//     branches: { [restaurantId]: true },
//     status: 'active' | 'paused',
//     createdAt: timestamp,
//     royaltyPayments: { [restaurantId]: { [yyyy-mm]: { paid: bool, amount, paidAt } } }
//   }
// ═══════════════════════════════════════════════════════════════════
(function () {
  window.allFranchises = window.allFranchises || {};

  let _frParentSelectedId = null;
  let _frBranchSelectedIds = new Set();
  let _frDetailOpenId = null;

  function _frMonthKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function _frRestName(id) {
    return window.allRestaurants?.[id]?.info?.name || id || t("sa_unknown", "Noma'lum");
  }

  function _frRestRevenue(id) {
    return Number(window.allRestaurants?.[id]?.stats?.totalRevenue || 0);
  }

  function _frFormatMoney(n) {
    return Math.round(Number(n || 0)).toLocaleString('ru-RU');
  }

  // ─────────────────────────────────────────────────────────
  // Firebase listener
  // ─────────────────────────────────────────────────────────
  window.listenFranchises = function () {
    onValue(ref(window.db, "systemData/franchises"), (snap) => {
      window.allFranchises = snap.exists() ? snap.val() : {};
      window.frRenderList();
      window.frUpdateStats();
      // Refresh open detail modal if applicable
      if (_frDetailOpenId && window.allFranchises[_frDetailOpenId]) {
        window.frOpenDetail(_frDetailOpenId);
      }
    });
  };

  // ─────────────────────────────────────────────────────────
  // Stats cards
  // ─────────────────────────────────────────────────────────
  window.frUpdateStats = function () {
    const list = Object.entries(window.allFranchises || {});
    const totalCount = list.length;
    let totalBranches = 0;
    let royaltyMonth = 0;
    let unpaidCount = 0;
    const curMonth = _frMonthKey();

    list.forEach(([fid, f]) => {
      const branches = Object.keys(f.branches || {});
      totalBranches += branches.length;
      const pct = Number(f.royaltyPct || 0) / 100;

      branches.forEach(bid => {
        const rev = _frRestRevenue(bid);
        royaltyMonth += rev * pct;
        const payRec = f.royaltyPayments?.[bid]?.[curMonth];
        if (!payRec || !payRec.paid) unpaidCount++;
      });
    });

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('frTotalCount', totalCount);
    setEl('frTotalBranches', totalBranches);
    setEl('frRoyaltyMonth', _frFormatMoney(royaltyMonth));
    setEl('frUnpaidCount', unpaidCount);
  };

  // ─────────────────────────────────────────────────────────
  // List render
  // ─────────────────────────────────────────────────────────
  window.frRenderList = function () {
    const body = document.getElementById('frTableBody');
    if (!body) return;
    const query = (document.getElementById('frSearchInput')?.value || '').toLowerCase().trim();

    let entries = Object.entries(window.allFranchises || {});
    if (query) {
      entries = entries.filter(([, f]) => (f.name || '').toLowerCase().includes(query));
    }

    if (!entries.length) {
      body.innerHTML = `<tr><td colspan="6" style="padding:30px; text-align:center; color:#94a3b8;">${t("sa_fr_none_found", "Franchayzlar topilmadi")}</td></tr>`;
      return;
    }

    body.innerHTML = entries.map(([fid, f]) => {
      const branchCount = Object.keys(f.branches || {}).length;
      const isActive = f.status !== 'paused';
      const statusBadge = isActive
        ? `<span style="background:#dcfce7; color:#16a34a; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t("sa_fr_status_active", "Faol")}</span>`
        : `<span style="background:#fee2e2; color:#dc2626; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t("sa_fr_status_paused", "To'xtatilgan")}</span>`;

      return `
        <tr style="border-top:1px solid #f1f5f9;">
          <td style="padding:12px 16px; font-weight:700; color:#111827;">
            <span style="cursor:pointer;" onclick="window.frOpenDetail('${fid}')">🏢 ${escapeHtml(f.name || '')}</span>
          </td>
          <td style="padding:12px 16px; color:#374151;">${escapeHtml(_frRestName(f.parentId))}</td>
          <td style="padding:12px 16px; color:#374151;">${branchCount}</td>
          <td style="padding:12px 16px; color:#374151;">${Number(f.royaltyPct || 0)}%</td>
          <td style="padding:12px 16px;">${statusBadge}</td>
          <td style="padding:12px 16px; text-align:right; white-space:nowrap;">
            <button onclick="window.frOpenDetail('${fid}')" title="${t('sa_fr_action_view', 'Ko`rish')}"
              style="background:#eff6ff; color:#2563eb; border:none; border-radius:8px; padding:6px 10px; cursor:pointer; margin-right:4px;">
              <i class="fa-solid fa-eye"></i>
            </button>
            <button onclick="window.frOpenEditModal('${fid}')" title="${t('sa_fr_action_edit', 'Tahrirlash')}"
              style="background:#f3f4f6; color:#374151; border:none; border-radius:8px; padding:6px 10px; cursor:pointer; margin-right:4px;">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button onclick="window.frDelete('${fid}')" title="${t('sa_fr_action_delete', 'O`chirish')}"
              style="background:#fef2f2; color:#dc2626; border:none; border-radius:8px; padding:6px 10px; cursor:pointer;">
              <i class="fa-solid fa-trash"></i>
            </button>
          </td>
        </tr>`;
    }).join('');
  };

  // ─────────────────────────────────────────────────────────
  // Create / Edit modal
  // ─────────────────────────────────────────────────────────
  window.frOpenCreateModal = function () {
    document.getElementById('frEditId').value = '';
    document.getElementById('frModalTitle').textContent = t('sa_fr_modal_create_title', "🏢 Yangi franchayz yaratish");
    document.getElementById('frNameInput').value = '';
    document.getElementById('frRoyaltyInput').value = '';
    document.getElementById('frParentSearch').value = '';
    document.getElementById('frParentSelected').innerHTML = '';
    document.getElementById('frBranchSearch').value = '';
    document.getElementById('frBranchList').innerHTML = '';
    _frParentSelectedId = null;
    _frBranchSelectedIds = new Set();

    const modal = document.getElementById('frModal');
    if (modal) { modal.style.display = 'flex'; }
  };

  window.frOpenEditModal = function (fid) {
    const f = window.allFranchises?.[fid];
    if (!f) return;

    window.frOpenCreateModal();
    document.getElementById('frEditId').value = fid;
    document.getElementById('frModalTitle').textContent = t('sa_fr_modal_edit_title', "🏢 Franchayzni tahrirlash");
    document.getElementById('frNameInput').value = f.name || '';
    document.getElementById('frRoyaltyInput').value = Number(f.royaltyPct || 0);

    _frParentSelectedId = f.parentId || null;
    _frRenderParentSelected();

    _frBranchSelectedIds = new Set(Object.keys(f.branches || {}));
    _frRenderBranchList();
  };

  window.frCloseModal = function () {
    const modal = document.getElementById('frModal');
    if (modal) modal.style.display = 'none';
  };

  // ─────────────────────────────────────────────────────────
  // Restaurant search (shared by parent + branch fields)
  // ─────────────────────────────────────────────────────────
  window.frSearchRest = function (query, mode) {
    const resEl = document.getElementById(mode === 'parent' ? 'frParentResults' : 'frBranchResults');
    if (!resEl) return;
    query = (query || '').toLowerCase().trim();
    if (!query) { resEl.style.display = 'none'; resEl.innerHTML = ''; return; }

    const matches = Object.entries(window.allRestaurants || {}).filter(([id, r]) => {
      const name = (r.info?.name || '').toLowerCase();
      const domain = (r.info?.domain || '').toLowerCase();
      if (mode === 'branch' && _frBranchSelectedIds.has(id)) return false;
      return name.includes(query) || domain.includes(query);
    }).slice(0, 8);

    if (!matches.length) {
      resEl.innerHTML = `<div style="padding:12px; font-size:13px; color:#9ca3af; text-align:center;">${t('sa_ctask_not_found', "Topilmadi")}</div>`;
      resEl.style.display = 'block';
      return;
    }

    resEl.style.display = 'block';
    resEl.innerHTML = matches.map(([id, r]) => `
      <div onclick="window.${mode === 'parent' ? 'frSelectParent' : 'frAddBranch'}('${id}')"
        style="padding:10px 14px; font-size:13px; font-weight:600; color:#374151; cursor:pointer; display:flex; align-items:center; gap:8px;"
        onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background=''">
        <span style="width:28px; height:28px; background:#ede9fe; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:14px; flex-shrink:0;">🍽️</span>
        <div>
          <div>${escapeHtml(r.info?.name || id)}</div>
          <div style="font-size:11px; color:#9ca3af;">${r.info?.domain || ''}.nestacrm.uz</div>
        </div>
      </div>`).join('');
  };

  window.frSelectParent = function (id) {
    _frParentSelectedId = id;
    const searchEl = document.getElementById('frParentSearch');
    if (searchEl) searchEl.value = '';
    const resEl = document.getElementById('frParentResults');
    if (resEl) { resEl.style.display = 'none'; resEl.innerHTML = ''; }
    _frRenderParentSelected();
  };

  function _frRenderParentSelected() {
    const el = document.getElementById('frParentSelected');
    if (!el) return;
    if (!_frParentSelectedId) { el.innerHTML = ''; return; }
    el.innerHTML = `<span style="display:inline-flex; align-items:center; gap:6px; background:#ede9fe; color:#5b21b6; border-radius:20px; padding:4px 12px; font-size:12px; font-weight:700;">
      👑 ${escapeHtml(_frRestName(_frParentSelectedId))}
      <span onclick="window.frClearParent()" style="cursor:pointer; color:#7c3aed; font-weight:800; font-size:14px; line-height:1;">×</span>
    </span>`;
  }

  window.frClearParent = function () {
    _frParentSelectedId = null;
    _frRenderParentSelected();
  };

  window.frAddBranch = function (id) {
    _frBranchSelectedIds.add(id);
    const searchEl = document.getElementById('frBranchSearch');
    if (searchEl) searchEl.value = '';
    const resEl = document.getElementById('frBranchResults');
    if (resEl) { resEl.style.display = 'none'; resEl.innerHTML = ''; }
    _frRenderBranchList();
  };

  window.frRemoveBranch = function (id) {
    _frBranchSelectedIds.delete(id);
    _frRenderBranchList();
  };

  function _frRenderBranchList() {
    const el = document.getElementById('frBranchList');
    if (!el) return;
    el.innerHTML = [..._frBranchSelectedIds].map(id => `
      <span style="display:inline-flex; align-items:center; gap:5px; background:#cffafe; color:#0e7490; border-radius:20px; padding:4px 10px; font-size:12px; font-weight:600;">
        🍽️ ${escapeHtml(_frRestName(id))}
        <span onclick="window.frRemoveBranch('${id}')" style="cursor:pointer; color:#0891b2; font-weight:800; font-size:14px; line-height:1;">×</span>
      </span>`).join('');
  }

  // ─────────────────────────────────────────────────────────
  // Save (create or update)
  // ─────────────────────────────────────────────────────────
  window.frSave = async function () {
    const editId = document.getElementById('frEditId').value.trim();
    const name = document.getElementById('frNameInput').value.trim();
    const royaltyPct = Number(document.getElementById('frRoyaltyInput').value || 0);

    if (!name) { alert(t('sa_fr_err_name_required', "Franchayz nomini kiriting")); return; }
    if (!_frParentSelectedId) { alert(t('sa_fr_err_parent_required', "Bosh restoranni tanlang")); return; }
    if (royaltyPct < 0 || royaltyPct > 100) { alert(t('sa_fr_err_royalty_range', "Royalti foizi 0-100 orasida bo'lishi kerak")); return; }

    const branchesObj = {};
    _frBranchSelectedIds.forEach(id => { branchesObj[id] = true; });

    const payload = {
      name,
      parentId: _frParentSelectedId,
      royaltyPct,
      branches: branchesObj,
    };

    try {
      if (editId) {
        await update(ref(window.db, `systemData/franchises/${editId}`), payload);
        window.logAudit && window.logAudit('franchise_update', name, t('sa_fr_log_updated', "Franchayz ma'lumotlari yangilandi"));
      } else {
        payload.status = 'active';
        payload.createdAt = Date.now();
        payload.royaltyPayments = {};
        const newRef = push(ref(window.db, 'systemData/franchises'));
        await set(newRef, payload);
        window.logAudit && window.logAudit('franchise_create', name, t('sa_fr_log_created', "Yangi franchayz yaratildi"));
      }
      window.frCloseModal();
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  window.frDelete = async function (fid) {
    const f = window.allFranchises?.[fid];
    if (!f) return;
    if (!confirm(t('sa_fr_confirm_delete', "Franchayzni o'chirmoqchimisiz? Bu amalni bekor qilib bo'lmaydi.") + `\n\n${f.name}`)) return;

    try {
      await remove(ref(window.db, `systemData/franchises/${fid}`));
      window.logAudit && window.logAudit('franchise_delete', f.name || fid, t('sa_fr_log_deleted', "Franchayz o'chirildi"));
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  window.frToggleStatus = async function (fid) {
    const f = window.allFranchises?.[fid];
    if (!f) return;
    const newStatus = f.status === 'paused' ? 'active' : 'paused';
    try {
      await update(ref(window.db, `systemData/franchises/${fid}`), { status: newStatus });
      window.logAudit && window.logAudit('franchise_status', f.name || fid,
        newStatus === 'paused' ? t('sa_fr_log_paused', "Franchayz to'xtatildi") : t('sa_fr_log_resumed', "Franchayz qayta faollashtirildi"));
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  // ─────────────────────────────────────────────────────────
  // Detail / Royalty modal
  // ─────────────────────────────────────────────────────────
  window.frOpenDetail = function (fid) {
    const f = window.allFranchises?.[fid];
    if (!f) return;
    _frDetailOpenId = fid;

    document.getElementById('frDetailTitle').textContent = `🏢 ${f.name || ''}`;

    const branches = Object.keys(f.branches || {});
    const pct = Number(f.royaltyPct || 0) / 100;
    const curMonth = _frMonthKey();

    const rows = branches.map(bid => {
      const rev = _frRestRevenue(bid);
      const royalty = rev * pct;
      const payRec = f.royaltyPayments?.[bid]?.[curMonth];
      const isPaid = !!payRec?.paid;
      return `
        <tr style="border-top:1px solid #f1f5f9;">
          <td style="padding:10px 12px; font-weight:600; color:#111827;">${escapeHtml(_frRestName(bid))}</td>
          <td style="padding:10px 12px; color:#374151;">${_frFormatMoney(rev)}</td>
          <td style="padding:10px 12px; color:#374151; font-weight:700;">${_frFormatMoney(royalty)}</td>
          <td style="padding:10px 12px;">
            ${isPaid
              ? `<span style="background:#dcfce7; color:#16a34a; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t('sa_fr_paid', "To'langan")}</span>`
              : `<span style="background:#fee2e2; color:#dc2626; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t('sa_fr_unpaid', "To'lanmagan")}</span>`}
          </td>
          <td style="padding:10px 12px; text-align:right;">
            <button onclick="window.frMarkPaid('${fid}','${bid}', ${!isPaid})"
              style="background:${isPaid ? '#f3f4f6' : '#dcfce7'}; color:${isPaid ? '#374151' : '#16a34a'}; border:none; border-radius:8px; padding:6px 12px; font-weight:700; font-size:12px; cursor:pointer;">
              ${isPaid ? t('sa_fr_mark_unpaid', "Bekor qilish") : t('sa_fr_mark_paid', "To'landi deb belgilash")}
            </button>
          </td>
        </tr>`;
    }).join('');

    const totalRoyalty = branches.reduce((sum, bid) => sum + _frRestRevenue(bid) * pct, 0);

    document.getElementById('frDetailBody').innerHTML = `
      <div style="display:flex; gap:16px; flex-wrap:wrap; margin-bottom:18px;">
        <div style="flex:1; min-width:140px; background:#f9fafb; border-radius:10px; padding:12px 14px;">
          <div style="font-size:11px; color:#9ca3af; font-weight:600;">${t('sa_fr_detail_parent', "Bosh restoran")}</div>
          <div style="font-size:14px; font-weight:700; color:#111827; margin-top:4px;">${escapeHtml(_frRestName(f.parentId))}</div>
        </div>
        <div style="flex:1; min-width:140px; background:#f9fafb; border-radius:10px; padding:12px 14px;">
          <div style="font-size:11px; color:#9ca3af; font-weight:600;">${t('sa_fr_detail_royalty_pct', "Royalti foizi")}</div>
          <div style="font-size:14px; font-weight:700; color:#111827; margin-top:4px;">${Number(f.royaltyPct || 0)}%</div>
        </div>
        <div style="flex:1; min-width:140px; background:#f9fafb; border-radius:10px; padding:12px 14px;">
          <div style="font-size:11px; color:#9ca3af; font-weight:600;">${t('sa_fr_detail_total_royalty', "Shu oylik jami royalti")}</div>
          <div style="font-size:14px; font-weight:700; color:#16a34a; margin-top:4px;">${_frFormatMoney(totalRoyalty)} ${t("sa_currency_uzs", "so'm")}</div>
        </div>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <h4 style="margin:0; font-size:14px; color:#111827;">${t('sa_fr_detail_branches_title', "Filiallar bo'yicha royalti")} (${curMonth})</h4>
        <button onclick="window.frToggleStatus('${fid}')"
          style="background:${f.status === 'paused' ? '#dcfce7' : '#fee2e2'}; color:${f.status === 'paused' ? '#16a34a' : '#dc2626'}; border:none; border-radius:8px; padding:6px 12px; font-weight:700; font-size:12px; cursor:pointer;">
          ${f.status === 'paused' ? t('sa_fr_resume_btn', "Faollashtirish") : t('sa_fr_pause_btn', "To'xtatish")}
        </button>
      </div>

      <table style="width:100%; border-collapse:collapse; background:#fff; border:1px solid #e5e7eb; border-radius:10px; overflow:hidden;">
        <thead style="background:#f9fafb;">
          <tr>
            <th style="padding:8px 12px; text-align:left; font-size:11px; color:#6b7280;">${t('sa_fr_col_branch', "Filial")}</th>
            <th style="padding:8px 12px; text-align:left; font-size:11px; color:#6b7280;">${t('sa_fr_col_total_rev', "Jami tushum")}</th>
            <th style="padding:8px 12px; text-align:left; font-size:11px; color:#6b7280;">${t('sa_fr_col_royalty_amt', "Royalti summasi")}</th>
            <th style="padding:8px 12px; text-align:left; font-size:11px; color:#6b7280;">${t('sa_fr_col_status', "Holat")}</th>
            <th style="padding:8px 12px; text-align:right; font-size:11px; color:#6b7280;">${t('sa_fr_col_actions', "Amallar")}</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="5" style="padding:20px; text-align:center; color:#94a3b8;">${t('sa_fr_no_branches', "Filiallar yo'q")}</td></tr>`}</tbody>
      </table>
    `;

    const modal = document.getElementById('frDetailModal');
    if (modal) modal.style.display = 'flex';
  };

  window.frCloseDetailModal = function () {
    const modal = document.getElementById('frDetailModal');
    if (modal) modal.style.display = 'none';
    _frDetailOpenId = null;
  };

  window.frMarkPaid = async function (fid, bid, markPaid) {
    const f = window.allFranchises?.[fid];
    if (!f) return;
    const curMonth = _frMonthKey();
    const pct = Number(f.royaltyPct || 0) / 100;
    const rev = _frRestRevenue(bid);
    const amount = rev * pct;

    try {
      await update(ref(window.db, `systemData/franchises/${fid}/royaltyPayments/${bid}/${curMonth}`), {
        paid: markPaid,
        amount,
        paidAt: markPaid ? Date.now() : null,
      });
      window.logAudit && window.logAudit('franchise_royalty', `${f.name} → ${_frRestName(bid)}`,
        markPaid
          ? `${t('sa_fr_log_royalty_paid', "Royalti to'landi deb belgilandi:")} ${_frFormatMoney(amount)} ${t("sa_currency_uzs", "so'm")} (${curMonth})`
          : `${t('sa_fr_log_royalty_unpaid', "Royalti to'lovi bekor qilindi")} (${curMonth})`);
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  // ─────────────────────────────────────────────────────────
  // Nav hook: start listener when Franchise section first opened
  // ─────────────────────────────────────────────────────────
  let _frListenerStarted = false;
  function _frAttachNavHook() {
    document.querySelectorAll('.sidebar-nav a[href="#franchise"]').forEach(link => {
      link.addEventListener('click', () => {
        if (!_frListenerStarted) {
          _frListenerStarted = true;
          window.listenFranchises();
        } else {
          window.frRenderList();
          window.frUpdateStats();
        }
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _frAttachNavHook);
  else _frAttachNavHook();

})(); // end Franchise Management module

// ═══════════════════════════════════════════════════════════════════
// ORGANIZATIONS MANAGEMENT MODULE
// Groups multiple restaurants/branches under one company for combined
// oversight (e.g. one owner running several restaurants).
// Firebase path: systemData/organizations/{orgId}
//   {
//     name: string,
//     owner: string,
//     phone: string,
//     restaurants: { [restaurantId]: true },
//     status: 'active' | 'paused',
//     createdAt: timestamp,
//   }
// ═══════════════════════════════════════════════════════════════════
(function () {
  window.allOrganizations = window.allOrganizations || {};

  let _orgRestSelectedIds = new Set();
  let _orgDetailOpenId = null;

  function _orgRestName(id) {
    return window.allRestaurants?.[id]?.info?.name || id || t("sa_unknown", "Noma'lum");
  }

  function _orgRestRevenue(id) {
    return Number(window.allRestaurants?.[id]?.stats?.totalRevenue || 0);
  }

  function _orgFormatMoney(n) {
    return Math.round(Number(n || 0)).toLocaleString('ru-RU');
  }

  // ─────────────────────────────────────────────────────────
  // Firebase listener
  // ─────────────────────────────────────────────────────────
  window.listenOrganizations = function () {
    onValue(ref(window.db, "systemData/organizations"), (snap) => {
      window.allOrganizations = snap.exists() ? snap.val() : {};
      window.orgRenderList();
      window.orgUpdateStats();
      // Refresh open detail modal if applicable
      if (_orgDetailOpenId && window.allOrganizations[_orgDetailOpenId]) {
        window.orgOpenDetail(_orgDetailOpenId);
      }
    });
  };

  // ─────────────────────────────────────────────────────────
  // Stats cards
  // ─────────────────────────────────────────────────────────
  window.orgUpdateStats = function () {
    const list = Object.entries(window.allOrganizations || {});
    const totalCount = list.length;
    let totalRestaurants = 0;
    let totalRevenue = 0;

    list.forEach(([, o]) => {
      const restIds = Object.keys(o.restaurants || {});
      totalRestaurants += restIds.length;
      restIds.forEach(rid => { totalRevenue += _orgRestRevenue(rid); });
    });

    const avgBranches = totalCount ? (totalRestaurants / totalCount) : 0;

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('orgTotalCount', totalCount);
    setEl('orgTotalRestaurants', totalRestaurants);
    setEl('orgTotalRevenue', _orgFormatMoney(totalRevenue));
    setEl('orgAvgBranches', avgBranches ? avgBranches.toFixed(1) : '0');
  };

  // ─────────────────────────────────────────────────────────
  // List render
  // ─────────────────────────────────────────────────────────
  window.orgRenderList = function () {
    const body = document.getElementById('orgTableBody');
    if (!body) return;
    const query = (document.getElementById('orgSearchInput')?.value || '').toLowerCase().trim();

    let entries = Object.entries(window.allOrganizations || {});
    if (query) {
      entries = entries.filter(([, o]) =>
        (o.name || '').toLowerCase().includes(query) ||
        (o.owner || '').toLowerCase().includes(query));
    }

    if (!entries.length) {
      body.innerHTML = `<tr><td colspan="6" style="padding:30px; text-align:center; color:#94a3b8;">${t("sa_org_none_found", "Tashkilotlar topilmadi")}</td></tr>`;
      return;
    }

    body.innerHTML = entries.map(([oid, o]) => {
      const restIds = Object.keys(o.restaurants || {});
      const revenue = restIds.reduce((sum, rid) => sum + _orgRestRevenue(rid), 0);
      const isActive = o.status !== 'paused';
      const statusBadge = isActive
        ? `<span style="background:#dcfce7; color:#16a34a; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t("sa_org_status_active", "Faol")}</span>`
        : `<span style="background:#fee2e2; color:#dc2626; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t("sa_org_status_paused", "To'xtatilgan")}</span>`;

      return `
        <tr style="border-top:1px solid #f1f5f9;">
          <td style="padding:12px 16px; font-weight:700; color:#111827;">
            <span style="cursor:pointer;" onclick="window.orgOpenDetail('${oid}')">🏢 ${escapeHtml(o.name || '')}</span>
          </td>
          <td style="padding:12px 16px; color:#374151;">
            ${escapeHtml(o.owner || '—')}${o.phone ? `<div style="font-size:11px; color:#9ca3af;">${escapeHtml(o.phone)}</div>` : ''}
          </td>
          <td style="padding:12px 16px; color:#374151;">${restIds.length}</td>
          <td style="padding:12px 16px; color:#374151;">${_orgFormatMoney(revenue)}</td>
          <td style="padding:12px 16px;">${statusBadge}</td>
          <td style="padding:12px 16px; text-align:right; white-space:nowrap;">
            <button onclick="window.orgOpenDetail('${oid}')" title="${t('sa_org_action_view', "Ko'rish")}"
              style="background:#eff6ff; color:#2563eb; border:none; border-radius:8px; padding:6px 10px; cursor:pointer; margin-right:4px;">
              <i class="fa-solid fa-eye"></i>
            </button>
            <button onclick="window.orgOpenEditModal('${oid}')" title="${t('sa_org_action_edit', 'Tahrirlash')}"
              style="background:#f3f4f6; color:#374151; border:none; border-radius:8px; padding:6px 10px; cursor:pointer; margin-right:4px;">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button onclick="window.orgDelete('${oid}')" title="${t('sa_org_action_delete', "O'chirish")}"
              style="background:#fef2f2; color:#dc2626; border:none; border-radius:8px; padding:6px 10px; cursor:pointer;">
              <i class="fa-solid fa-trash"></i>
            </button>
          </td>
        </tr>`;
    }).join('');
  };

  // ─────────────────────────────────────────────────────────
  // Create / Edit modal
  // ─────────────────────────────────────────────────────────
  window.orgOpenCreateModal = function () {
    document.getElementById('orgEditId').value = '';
    document.getElementById('orgModalTitle').textContent = t('sa_org_modal_create_title', "🏢 Yangi tashkilot yaratish");
    document.getElementById('orgNameInput').value = '';
    document.getElementById('orgOwnerInput').value = '';
    document.getElementById('orgPhoneInput').value = '';
    document.getElementById('orgRestSearch').value = '';
    document.getElementById('orgRestList').innerHTML = '';
    _orgRestSelectedIds = new Set();

    const modal = document.getElementById('orgModal');
    if (modal) { modal.style.display = 'flex'; }
  };

  window.orgOpenEditModal = function (oid) {
    const o = window.allOrganizations?.[oid];
    if (!o) return;

    window.orgOpenCreateModal();
    document.getElementById('orgEditId').value = oid;
    document.getElementById('orgModalTitle').textContent = t('sa_org_modal_edit_title', "🏢 Tashkilotni tahrirlash");
    document.getElementById('orgNameInput').value = o.name || '';
    document.getElementById('orgOwnerInput').value = o.owner || '';
    document.getElementById('orgPhoneInput').value = o.phone || '';

    _orgRestSelectedIds = new Set(Object.keys(o.restaurants || {}));
    _orgRenderRestList();
  };

  window.orgCloseModal = function () {
    const modal = document.getElementById('orgModal');
    if (modal) modal.style.display = 'none';
  };

  // ─────────────────────────────────────────────────────────
  // Restaurant search (multi-select)
  // ─────────────────────────────────────────────────────────
  window.orgSearchRest = function (query) {
    const resEl = document.getElementById('orgRestResults');
    if (!resEl) return;
    query = (query || '').toLowerCase().trim();
    if (!query) { resEl.style.display = 'none'; resEl.innerHTML = ''; return; }

    const matches = Object.entries(window.allRestaurants || {}).filter(([id, r]) => {
      if (_orgRestSelectedIds.has(id)) return false;
      const name = (r.info?.name || '').toLowerCase();
      const domain = (r.info?.domain || '').toLowerCase();
      return name.includes(query) || domain.includes(query);
    }).slice(0, 8);

    if (!matches.length) {
      resEl.innerHTML = `<div style="padding:12px; font-size:13px; color:#9ca3af; text-align:center;">${t('sa_ctask_not_found', "Topilmadi")}</div>`;
      resEl.style.display = 'block';
      return;
    }

    resEl.style.display = 'block';
    resEl.innerHTML = matches.map(([id, r]) => `
      <div onclick="window.orgAddRest('${id}')"
        style="padding:10px 14px; font-size:13px; font-weight:600; color:#374151; cursor:pointer; display:flex; align-items:center; gap:8px;"
        onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background=''">
        <span style="width:28px; height:28px; background:#dbeafe; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:14px; flex-shrink:0;">🍽️</span>
        <div>
          <div>${escapeHtml(r.info?.name || id)}</div>
          <div style="font-size:11px; color:#9ca3af;">${r.info?.domain || ''}.nestacrm.uz</div>
        </div>
      </div>`).join('');
  };

  window.orgAddRest = function (id) {
    _orgRestSelectedIds.add(id);
    const searchEl = document.getElementById('orgRestSearch');
    if (searchEl) searchEl.value = '';
    const resEl = document.getElementById('orgRestResults');
    if (resEl) { resEl.style.display = 'none'; resEl.innerHTML = ''; }
    _orgRenderRestList();
  };

  window.orgRemoveRest = function (id) {
    _orgRestSelectedIds.delete(id);
    _orgRenderRestList();
  };

  function _orgRenderRestList() {
    const el = document.getElementById('orgRestList');
    if (!el) return;
    el.innerHTML = [..._orgRestSelectedIds].map(id => `
      <span style="display:inline-flex; align-items:center; gap:5px; background:#dbeafe; color:#1d4ed8; border-radius:20px; padding:4px 10px; font-size:12px; font-weight:600;">
        🍽️ ${escapeHtml(_orgRestName(id))}
        <span onclick="window.orgRemoveRest('${id}')" style="cursor:pointer; color:#2563eb; font-weight:800; font-size:14px; line-height:1;">×</span>
      </span>`).join('');
  }

  // ─────────────────────────────────────────────────────────
  // Save (create or update)
  // ─────────────────────────────────────────────────────────
  window.orgSave = async function () {
    const editId = document.getElementById('orgEditId').value.trim();
    const name = document.getElementById('orgNameInput').value.trim();
    const owner = document.getElementById('orgOwnerInput').value.trim();
    const phone = document.getElementById('orgPhoneInput').value.trim();

    if (!name) { alert(t('sa_org_err_name_required', "Tashkilot nomini kiriting")); return; }
    if (!_orgRestSelectedIds.size) { alert(t('sa_org_err_rest_required', "Kamida bitta restoran qo'shing")); return; }

    const restaurantsObj = {};
    _orgRestSelectedIds.forEach(id => { restaurantsObj[id] = true; });

    const payload = {
      name,
      owner,
      phone,
      restaurants: restaurantsObj,
    };

    try {
      if (editId) {
        await update(ref(window.db, `systemData/organizations/${editId}`), payload);
        window.logAudit && window.logAudit('organization_update', name, t('sa_org_log_updated', "Tashkilot ma'lumotlari yangilandi"));
      } else {
        payload.status = 'active';
        payload.createdAt = Date.now();
        const newRef = push(ref(window.db, 'systemData/organizations'));
        await set(newRef, payload);
        window.logAudit && window.logAudit('organization_create', name, t('sa_org_log_created', "Yangi tashkilot yaratildi"));
      }
      window.orgCloseModal();
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  window.orgDelete = async function (oid) {
    const o = window.allOrganizations?.[oid];
    if (!o) return;
    if (!confirm(t('sa_org_confirm_delete', "Tashkilotni o'chirmoqchimisiz? Bu amalni bekor qilib bo'lmaydi.") + `\n\n${o.name}`)) return;

    try {
      await remove(ref(window.db, `systemData/organizations/${oid}`));
      window.logAudit && window.logAudit('organization_delete', o.name || oid, t('sa_org_log_deleted', "Tashkilot o'chirildi"));
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  window.orgToggleStatus = async function (oid) {
    const o = window.allOrganizations?.[oid];
    if (!o) return;
    const newStatus = o.status === 'paused' ? 'active' : 'paused';
    try {
      await update(ref(window.db, `systemData/organizations/${oid}`), { status: newStatus });
      window.logAudit && window.logAudit('organization_status', o.name || oid,
        newStatus === 'paused' ? t('sa_org_log_paused', "Tashkilot to'xtatildi") : t('sa_org_log_resumed', "Tashkilot qayta faollashtirildi"));
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  // ─────────────────────────────────────────────────────────
  // Detail modal
  // ─────────────────────────────────────────────────────────
  window.orgOpenDetail = function (oid) {
    const o = window.allOrganizations?.[oid];
    if (!o) return;
    _orgDetailOpenId = oid;

    document.getElementById('orgDetailTitle').textContent = `🏢 ${o.name || ''}`;

    const restIds = Object.keys(o.restaurants || {});
    const totalRevenue = restIds.reduce((sum, rid) => sum + _orgRestRevenue(rid), 0);

    const rows = restIds.map(rid => {
      const rev = _orgRestRevenue(rid);
      const status = window.allRestaurants?.[rid]?.info?.status;
      const statusBadge = status === 'blocked'
        ? `<span style="background:#fee2e2; color:#dc2626; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t('sa_org_rest_blocked', "Bloklangan")}</span>`
        : `<span style="background:#dcfce7; color:#16a34a; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t('sa_org_rest_active', "Faol")}</span>`;
      return `
        <tr style="border-top:1px solid #f1f5f9;">
          <td style="padding:10px 12px; font-weight:600; color:#111827;">${escapeHtml(_orgRestName(rid))}</td>
          <td style="padding:10px 12px; color:#374151;">${_orgFormatMoney(rev)}</td>
          <td style="padding:10px 12px;">${statusBadge}</td>
          <td style="padding:10px 12px; text-align:right;">
            <button onclick="window.orgRemoveRestFromOrg('${oid}','${rid}')"
              style="background:#fef2f2; color:#dc2626; border:none; border-radius:8px; padding:6px 12px; font-weight:700; font-size:12px; cursor:pointer;">
              ${t('sa_org_remove_from_org', "Guruhdan chiqarish")}
            </button>
          </td>
        </tr>`;
    }).join('');

    document.getElementById('orgDetailBody').innerHTML = `
      <div style="display:flex; gap:16px; flex-wrap:wrap; margin-bottom:18px;">
        <div style="flex:1; min-width:140px; background:#f9fafb; border-radius:10px; padding:12px 14px;">
          <div style="font-size:11px; color:#9ca3af; font-weight:600;">${t('sa_org_detail_owner', "Egasi")}</div>
          <div style="font-size:14px; font-weight:700; color:#111827; margin-top:4px;">${escapeHtml(o.owner || '—')}</div>
        </div>
        <div style="flex:1; min-width:140px; background:#f9fafb; border-radius:10px; padding:12px 14px;">
          <div style="font-size:11px; color:#9ca3af; font-weight:600;">${t('sa_org_detail_phone', "Telefon")}</div>
          <div style="font-size:14px; font-weight:700; color:#111827; margin-top:4px;">${escapeHtml(o.phone || '—')}</div>
        </div>
        <div style="flex:1; min-width:140px; background:#f9fafb; border-radius:10px; padding:12px 14px;">
          <div style="font-size:11px; color:#9ca3af; font-weight:600;">${t('sa_org_detail_total_revenue', "Jami tushum")}</div>
          <div style="font-size:14px; font-weight:700; color:#16a34a; margin-top:4px;">${_orgFormatMoney(totalRevenue)} ${t("sa_currency_uzs", "so'm")}</div>
        </div>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <h4 style="margin:0; font-size:14px; color:#111827;">${t('sa_org_detail_restaurants_title', "Tashkilotdagi restoranlar")}</h4>
        <button onclick="window.orgToggleStatus('${oid}')"
          style="background:${o.status === 'paused' ? '#dcfce7' : '#fee2e2'}; color:${o.status === 'paused' ? '#16a34a' : '#dc2626'}; border:none; border-radius:8px; padding:6px 12px; font-weight:700; font-size:12px; cursor:pointer;">
          ${o.status === 'paused' ? t('sa_org_resume_btn', "Faollashtirish") : t('sa_org_pause_btn', "To'xtatish")}
        </button>
      </div>

      <table style="width:100%; border-collapse:collapse; background:#fff; border:1px solid #e5e7eb; border-radius:10px; overflow:hidden;">
        <thead style="background:#f9fafb;">
          <tr>
            <th style="padding:8px 12px; text-align:left; font-size:11px; color:#6b7280;">${t('sa_org_col_restaurant', "Restoran")}</th>
            <th style="padding:8px 12px; text-align:left; font-size:11px; color:#6b7280;">${t('sa_fr_col_total_rev', "Jami tushum")}</th>
            <th style="padding:8px 12px; text-align:left; font-size:11px; color:#6b7280;">${t('sa_org_col_status', "Holat")}</th>
            <th style="padding:8px 12px; text-align:right; font-size:11px; color:#6b7280;">${t('sa_fr_col_actions', "Amallar")}</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="4" style="padding:20px; text-align:center; color:#94a3b8;">${t('sa_org_no_restaurants', "Restoranlar yo'q")}</td></tr>`}</tbody>
      </table>
    `;

    const modal = document.getElementById('orgDetailModal');
    if (modal) modal.style.display = 'flex';
  };

  window.orgCloseDetailModal = function () {
    const modal = document.getElementById('orgDetailModal');
    if (modal) modal.style.display = 'none';
    _orgDetailOpenId = null;
  };

  window.orgRemoveRestFromOrg = async function (oid, rid) {
    const o = window.allOrganizations?.[oid];
    if (!o) return;
    if (!confirm(t('sa_org_confirm_remove_rest', "Ushbu restoranni tashkilotdan chiqarmoqchimisiz?") + `\n\n${_orgRestName(rid)}`)) return;

    try {
      await remove(ref(window.db, `systemData/organizations/${oid}/restaurants/${rid}`));
      window.logAudit && window.logAudit('organization_remove_rest', `${o.name} → ${_orgRestName(rid)}`,
        t('sa_org_log_rest_removed', "Restoran tashkilotdan chiqarildi"));
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  // ─────────────────────────────────────────────────────────
  // Nav hook: start listener when Organizations section first opened
  // ─────────────────────────────────────────────────────────
  let _orgListenerStarted = false;
  function _orgAttachNavHook() {
    document.querySelectorAll('.sidebar-nav a[href="#organizations"]').forEach(link => {
      link.addEventListener('click', () => {
        if (!_orgListenerStarted) {
          _orgListenerStarted = true;
          window.listenOrganizations();
        } else {
          window.orgRenderList();
          window.orgUpdateStats();
        }
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _orgAttachNavHook);
  else _orgAttachNavHook();

})(); // end Organizations Management module


// ═══════════════════════════════════════════════════════════════════
// INTEGRATION MANAGEMENT MODULE
// Firebase path: systemData/integrations/{integrationId}
//   { apiKey: string, enabled: bool, updatedAt: timestamp }
// ═══════════════════════════════════════════════════════════════════
(function () {
  const INT_CATALOG = [
    { id: 'payme',      name: 'Payme',            icon: '💳', color: '#00cbaf', group: 'sa_int_group_payments' },
    { id: 'click',      name: 'Click',            icon: '💳', color: '#0295d3', group: 'sa_int_group_payments' },
    { id: 'uzum',       name: 'Uzum Bank',        icon: '💳', color: '#7c3aed', group: 'sa_int_group_payments' },
    { id: 'eskiz',      name: 'Eskiz SMS',        icon: '📩', color: '#f59e0b', group: 'sa_int_group_sms' },
    { id: 'playmobile', name: 'PlayMobile SMS',   icon: '📩', color: '#ef4444', group: 'sa_int_group_sms' },
    { id: 'telegram',   name: 'Telegram Bot',     icon: '🤖', color: '#0ea5e9', group: 'sa_int_group_telegram' },
    { id: 'emailsmtp',  name: 'Email SMTP',       icon: '📧', color: '#6366f1', group: 'sa_int_group_email' },
    { id: 'pushnotif',  name: 'Push Notification', icon: '📲', color: '#10b981', group: 'sa_int_group_push' },
    { id: 'webhook',    name: 'Webhook',          icon: '🌐', color: '#64748b', group: 'sa_int_group_webhook' },
  ];

  window.allIntegrations = window.allIntegrations || {};

  window.listenIntegrations = function () {
    onValue(ref(window.db, "systemData/integrations"), (snap) => {
      window.allIntegrations = snap.exists() ? snap.val() : {};
      window.intRenderGrid();
    });
  };

  function _intMaskKey(key) {
    if (!key) return '';
    if (key.length <= 8) return '•'.repeat(key.length);
    return key.slice(0, 4) + '•'.repeat(Math.max(4, key.length - 8)) + key.slice(-4);
  }

  window.intRenderGrid = function () {
    const grid = document.getElementById('intGrid');
    if (!grid) return;

    grid.innerHTML = INT_CATALOG.map(item => {
      // Telegram Bot has its own dedicated backend state (routes/
      // superadminBot.js — a live poller + allowlist, not just one API
      // key), fetched separately by saBotIntRefreshStatus() into
      // window._superAdminBotSettings — NOT systemData/integrations/telegram
      // like the other 8 cards. See intOpenModal()'s matching special-case.
      const isTelegram = item.id === 'telegram';
      const botSettings = window._superAdminBotSettings || {};
      const rec = isTelegram ? {} : (window.allIntegrations?.[item.id] || {});
      const isEnabled = isTelegram ? !!botSettings.enabled : !!rec.enabled;
      const hasKey = isTelegram ? !!botSettings.tokenConfigured : !!rec.apiKey;

      return `
        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:14px; padding:18px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
            <div style="display:flex; align-items:center; gap:10px;">
              <div style="width:40px; height:40px; border-radius:10px; background:${item.color}1a; color:${item.color}; display:flex; align-items:center; justify-content:center; font-size:18px;">${item.icon}</div>
              <div>
                <div style="font-weight:700; color:#111827; font-size:14px;">${escapeHtml(item.name)}</div>
                <div style="font-size:11px; color:#9ca3af;">${t(item.group, item.group)}</div>
              </div>
            </div>
            ${isEnabled
              ? `<span style="background:#dcfce7; color:#16a34a; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t('sa_int_enabled', "Yoqilgan")}</span>`
              : `<span style="background:#f3f4f6; color:#6b7280; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t('sa_int_disabled', "O'chirilgan")}</span>`}
          </div>

          <div style="font-size:12px; color:#6b7280; margin-bottom:14px; font-family:monospace; background:#f9fafb; padding:8px 10px; border-radius:8px;">
            ${isTelegram
              ? (hasKey ? t('sa_bot_status_token_ok', "✅ Token saqlangan") : t('sa_int_no_key', "API kalit kiritilmagan"))
              : (hasKey ? escapeHtml(_intMaskKey(rec.apiKey)) : t('sa_int_no_key', "API kalit kiritilmagan"))}
          </div>

          <button onclick="window.intOpenModal('${item.id}')"
            style="width:100%; background:#f3f4f6; color:#374151; border:none; border-radius:8px; padding:9px; font-weight:700; font-size:12px; cursor:pointer;">
            <i class="fa-solid fa-key"></i> ${t('sa_int_configure_btn', "Sozlash")}
          </button>
        </div>`;
    }).join('');
  };

  window.intOpenModal = function (integrationId) {
    // Telegram Bot's "Sozlash" opens its OWN modal (real backend state —
    // see intRenderGrid()'s matching special-case above), not this generic
    // one-API-key modal.
    if (integrationId === 'telegram') {
      if (typeof window.saBotIntOpenModal === 'function') window.saBotIntOpenModal();
      return;
    }
    const item = INT_CATALOG.find(i => i.id === integrationId);
    if (!item) return;
    const rec = window.allIntegrations?.[integrationId] || {};

    document.getElementById('intEditKey').value = integrationId;
    document.getElementById('intModalTitle').textContent = `${item.icon} ${item.name}`;
    document.getElementById('intApiKeyInput').value = rec.apiKey || '';
    document.getElementById('intEnabledToggle').checked = !!rec.enabled;

    const modal = document.getElementById('intModal');
    if (modal) modal.style.display = 'flex';
  };

  window.intCloseModal = function () {
    const modal = document.getElementById('intModal');
    if (modal) modal.style.display = 'none';
  };

  window.intSave = async function () {
    const integrationId = document.getElementById('intEditKey').value.trim();
    if (!integrationId) return;
    const item = INT_CATALOG.find(i => i.id === integrationId);

    const apiKey = document.getElementById('intApiKeyInput').value.trim();
    const enabled = document.getElementById('intEnabledToggle').checked;

    if (enabled && !apiKey) {
      alert(t('sa_int_err_key_required', "Yoqish uchun avval API kalitni kiriting"));
      return;
    }

    try {
      await update(ref(window.db, `systemData/integrations/${integrationId}`), {
        apiKey,
        enabled,
        updatedAt: Date.now(),
      });
      window.logAudit && window.logAudit('integration_update', item?.name || integrationId,
        enabled ? t('sa_int_log_enabled', "Integratsiya yoqildi") : t('sa_int_log_disabled', "Integratsiya o'chirildi"));
      window.intCloseModal();
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  let _intListenerStarted = false;
  function _intAttachNavHook() {
    document.querySelectorAll('.sidebar-nav a[href="#integrations"]').forEach(link => {
      link.addEventListener('click', () => {
        if (!_intListenerStarted) {
          _intListenerStarted = true;
          window.listenIntegrations();
          // Telegram Bot card's real status (separate from the other 8
          // cards' systemData/integrations listener above) — see
          // intRenderGrid()'s telegram special-case.
          if (typeof window.saBotIntRefreshStatus === 'function') window.saBotIntRefreshStatus();
        } else {
          window.intRenderGrid();
        }
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _intAttachNavHook);
  else _intAttachNavHook();

})(); // end Integration Management module

// ═══════════════════════════════════════════════════════════════════
// GLOBAL NOTIFICATIONS MODULE
// Firebase path: systemData/globalNotifications/{id}
//   { title, message, notifType, createdAt }
// Delivered by writing into each restaurant's own notification inbox:
//   restaurants/{id}/notifications/{pushId}
// ═══════════════════════════════════════════════════════════════════
(function () {
  let _gnSelectedType = 'info';
  // Til o'zgarganda gnRenderHistory()ni argumentsiz qayta chaqirish tarixni
  // "hozircha xabar yo'q" holatiga tushirib qo'yardi — shuning uchun so'nggi
  // kelgan ma'lumotni shu yerda keshlab, til almashganda ANA SHUNI qayta
  // chizamiz (Firebase'ga qayta murojaat qilmasdan).
  let _gnLastData = {};

  window.gnSelectType = function (type) {
    _gnSelectedType = type;
    ['info', 'warning', 'success'].forEach(tp => {
      const btn = document.getElementById(`gn_type_${tp}`);
      if (btn) btn.classList.toggle('active', tp === type);
    });
  };

  window.gnSend = async function () {
    const title = document.getElementById('gnTitleInput').value.trim();
    const message = document.getElementById('gnMessageInput').value.trim();

    if (!title || !message) {
      alert(t('sa_gn_err_required', "Sarlavha va xabar matnini kiriting"));
      return;
    }

    const restIds = Object.keys(window.allRestaurants || {});
    if (!restIds.length) {
      alert(t('sa_gn_err_no_restaurants', "Yuborish uchun restoranlar topilmadi"));
      return;
    }

    if (!confirm(`${t('sa_gn_confirm_send', "Ushbu bildirishnoma barcha restoranlarga yuboriladi:")} ${restIds.length} ${t('sa_gn_confirm_send_suffix', "ta restoran. Davom etasizmi?")}`)) return;

    try {
      const createdAt = Date.now();
      const logRef = push(ref(window.db, 'systemData/globalNotifications'));
      await set(logRef, { title, message, notifType: _gnSelectedType, createdAt, recipientCount: restIds.length });

      const updates = {};
      restIds.forEach(rid => {
        const pushId = push(ref(window.db, `restaurants/${rid}/notifications`)).key;
        updates[`restaurants/${rid}/notifications/${pushId}`] = {
          title, message, type: _gnSelectedType, createdAt, read: false, source: 'global',
        };
      });
      await update(ref(window.db), updates);

      window.logAudit && window.logAudit('global_notification', title,
        `${t('sa_gn_log_sent', "Global bildirishnoma yuborildi:")} ${restIds.length} ${t('sa_gn_log_recipients', "ta restoranga")}`);

      document.getElementById('gnTitleInput').value = '';
      document.getElementById('gnMessageInput').value = '';
      window.gnSelectType('info');
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  window.listenGlobalNotifHistory = function () {
    onValue(ref(window.db, "systemData/globalNotifications"), (snap) => {
      window.gnRenderHistory(snap.exists() ? snap.val() : {});
    });
  };

  window.gnRenderHistory = function (data) {
    const el = document.getElementById('gnHistoryList');
    if (!el) return;
    if (data !== undefined) _gnLastData = data || {};
    const entries = Object.entries(_gnLastData).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0)).slice(0, 30);

    if (!entries.length) {
      el.innerHTML = `<div style="padding:20px; text-align:center; color:#94a3b8;">${t('sa_gn_no_history', "Hozircha yuborilgan xabarlar yo'q")}</div>`;
      return;
    }

    const typeIcon = { info: 'ℹ️', warning: '⚠️', success: '✅' };
    el.innerHTML = entries.map(([id, n]) => `
      <div style="background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:12px 14px; display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div style="font-weight:700; color:#111827; font-size:13px;">${typeIcon[n.notifType] || 'ℹ️'} ${escapeHtml(n.title || '')}</div>
          <div style="font-size:12px; color:#6b7280; margin-top:2px;">${escapeHtml(n.message || '')}</div>
        </div>
        <div style="font-size:11px; color:#9ca3af; white-space:nowrap; margin-left:12px;">
          ${n.createdAt ? new Date(n.createdAt).toLocaleString('ru-RU') : ''}<br>
          ${n.recipientCount || 0} ${t('sa_gn_recipients_suffix', "ta")}
        </div>
      </div>`).join('');
  };

  let _gnListenerStarted = false;
  function _gnAttachNavHook() {
    document.querySelectorAll('.sidebar-nav a[href="#globalnotif"]').forEach(link => {
      link.addEventListener('click', () => {
        if (!_gnListenerStarted) { _gnListenerStarted = true; window.listenGlobalNotifHistory(); }
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _gnAttachNavHook);
  else _gnAttachNavHook();

})(); // end Global Notifications module


// ═══════════════════════════════════════════════════════════════════
// API KEYS MODULE (per-restaurant developer API access)
// Firebase path: restaurants/{id}/apiKeys/{keyId}
//   { name, apiKey, enabled, permissions: {orders,menu,tables,customers,statistics},
//     expiresAt (0 = never), createdAt, regeneratedAt, lastUsedAt }
// ═══════════════════════════════════════════════════════════════════
(function () {
  const AK_PERMS = ['orders', 'menu', 'tables', 'customers', 'statistics'];
  const AK_PERM_LABELS = {
    orders: () => t('sa_ak_perm_orders', 'Orders'),
    menu: () => t('sa_ak_perm_menu', 'Menu'),
    tables: () => t('sa_ak_perm_tables', 'Tables'),
    customers: () => t('sa_ak_perm_customers', 'Customers'),
    statistics: () => t('sa_ak_perm_statistics', 'Statistics'),
  };

  function _akGenerateKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = 'nk_live_';
    for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function _akMaskKey(key) {
    if (!key) return '';
    if (key.length <= 12) return '•'.repeat(key.length);
    return key.slice(0, 8) + '•'.repeat(Math.max(4, key.length - 12)) + key.slice(-4);
  }

  function _akFormatLastUsed(ts) {
    if (!ts) return t('sa_ak_never_used', "Hech qachon");
    const diffMs = Date.now() - ts;
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return t('sa_ak_just_now', "Hozirgina");
    if (min < 60) return `${min} ${t('sa_ak_minutes_ago', "daqiqa oldin")}`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs} ${t('sa_ak_hours_ago', "soat oldin")}`;
    const days = Math.floor(hrs / 24);
    return `${days} ${t('sa_ak_days_ago', "kun oldin")}`;
  }

  function _akFormatExpiry(expiresAt) {
    if (!expiresAt) return t('sa_ak_expiry_never', "∞ (muddatsiz)");
    return new Date(expiresAt).toLocaleDateString('ru-RU');
  }

  function _akIsExpired(access) {
    return !!access.expiresAt && access.expiresAt < Date.now();
  }

  // Flattened list of {rid, restName, keyId, access} across all restaurants
  function _akAllEntries() {
    const out = [];
    Object.entries(window.allRestaurants || {}).forEach(([rid, r]) => {
      const keys = r.apiKeys || {};
      Object.entries(keys).forEach(([keyId, access]) => {
        out.push({ rid, restName: r.info?.name || rid, keyId, access });
      });
    });
    return out;
  }

  window.akRenderList = function () {
    const body = document.getElementById('akTableBody');
    if (!body) return;
    const query = (document.getElementById('akSearchInput')?.value || '').toLowerCase().trim();

    let entries = _akAllEntries();
    if (query) {
      entries = entries.filter(e =>
        e.restName.toLowerCase().includes(query) ||
        (e.access.name || '').toLowerCase().includes(query) ||
        (e.access.apiKey || '').toLowerCase().includes(query));
    }
    entries.sort((a, b) => (b.access.createdAt || 0) - (a.access.createdAt || 0));
    entries = entries.slice(0, 200);

    if (!entries.length) {
      body.innerHTML = `<tr><td colspan="5" style="padding:30px; text-align:center; color:#94a3b8;">${t('sa_ak_none_found', "Kalitlar topilmadi")}</td></tr>`;
      return;
    }

    body.innerHTML = entries.map(({ rid, restName, keyId, access }) => {
      const hasKey = !!access.apiKey;
      const expired = _akIsExpired(access);
      const isEnabled = !!access.enabled && !expired;

      let statusBadge;
      if (expired) {
        statusBadge = `<span style="background:#fef3c7; color:#b45309; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t('sa_ak_status_expired', "Muddati tugagan")}</span>`;
      } else if (isEnabled) {
        statusBadge = `<span style="background:#dcfce7; color:#16a34a; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t('sa_ak_status_active', "Faol")}</span>`;
      } else {
        statusBadge = `<span style="background:#f3f4f6; color:#6b7280; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t('sa_ak_status_inactive', "Nofaol")}</span>`;
      }

      return `
        <tr style="border-top:1px solid #f1f5f9;">
          <td style="padding:12px 16px;">
            <div style="font-weight:700; color:#111827;">${escapeHtml(restName)}</div>
            ${access.name ? `<div style="font-size:11px; color:#9ca3af;">${escapeHtml(access.name)}</div>` : ''}
          </td>
          <td style="padding:12px 16px; font-family:monospace; color:#6b7280; font-size:12px;">
            ${hasKey ? escapeHtml(_akMaskKey(access.apiKey)) : t('sa_ak_no_key', "Kalit yaratilmagan")}
          </td>
          <td style="padding:12px 16px;">${statusBadge}</td>
          <td style="padding:12px 16px; font-size:12px; color:#6b7280;">${_akFormatLastUsed(access.lastUsedAt)}</td>
          <td style="padding:12px 16px; text-align:right; white-space:nowrap;">
            <button onclick="window.akOpenModal('${rid}','${keyId}')" title="${t('sa_ak_manage_btn', 'Boshqarish')}"
              style="background:#eff6ff; color:#2563eb; border:none; border-radius:8px; padding:6px 10px; font-weight:700; font-size:12px; cursor:pointer; margin-right:4px;">
              <i class="fa-solid fa-eye"></i>
            </button>
            <button onclick="window.akQuickRegenerate('${rid}','${keyId}')" title="${t('sa_ak_regenerate_btn', 'Yangilash')}"
              style="background:#fff7ed; color:#c2410c; border:none; border-radius:8px; padding:6px 10px; font-weight:700; font-size:12px; cursor:pointer; margin-right:4px;">
              <i class="fa-solid fa-rotate"></i>
            </button>
            <button onclick="window.akQuickRevoke('${rid}','${keyId}')" title="${t('sa_ak_revoke_btn', 'Bekor qilish')}"
              style="background:#fef2f2; color:#dc2626; border:none; border-radius:8px; padding:6px 10px; font-weight:700; font-size:12px; cursor:pointer;">
              <i class="fa-solid fa-ban"></i>
            </button>
          </td>
        </tr>`;
    }).join('');
  };

  // ─────────────────────────────────────────────────────────────
  // Detail modal: view / toggle / regenerate / revoke a specific key
  // ─────────────────────────────────────────────────────────────
  window.akOpenModal = function (restId, keyId) {
    const rest = window.allRestaurants?.[restId];
    if (!rest) return;
    const access = rest.apiKeys?.[keyId] || {};

    document.getElementById('akEditRestId').value = restId;
    document.getElementById('akEditKeyId').value = keyId;
    document.getElementById('akModalTitle').textContent = `🔑 ${rest.info?.name || restId}`;
    document.getElementById('akNameDisplay').value = access.name || '—';
    document.getElementById('akKeyDisplay').value = access.apiKey || t('sa_ak_no_key', "Kalit yaratilmagan");
    document.getElementById('akEnabledToggle').checked = !!access.enabled;
    document.getElementById('akExpiryDisplay').textContent = _akFormatExpiry(access.expiresAt);
    document.getElementById('akLastUsedDisplay').textContent = _akFormatLastUsed(access.lastUsedAt);

    const perms = access.permissions || {};
    const permsEl = document.getElementById('akPermsDisplay');
    if (permsEl) {
      const active = AK_PERMS.filter(p => perms[p]);
      permsEl.innerHTML = active.length
        ? active.map(p => `<span style="background:#eff6ff; color:#2563eb; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${AK_PERM_LABELS[p]()}</span>`).join('')
        : `<span style="color:#9ca3af; font-size:12px;">${t('sa_ak_no_perms', "Ruxsatlar tanlanmagan")}</span>`;
    }

    const modal = document.getElementById('akModal');
    if (modal) modal.style.display = 'flex';
  };

  window.akCloseModal = function () {
    const modal = document.getElementById('akModal');
    if (modal) modal.style.display = 'none';
  };

  window.akCopyKey = function () {
    const input = document.getElementById('akKeyDisplay');
    if (!input || !input.value) return;
    navigator.clipboard?.writeText(input.value).then(() => {
      alert(t('sa_ak_copied', "Kalit nusxalandi"));
    }).catch(() => {});
  };

  async function _akDoRegenerate(restId, keyId) {
    const newKey = _akGenerateKey();
    await update(ref(window.db, `restaurants/${restId}/apiKeys/${keyId}`), {
      apiKey: newKey,
      regeneratedAt: Date.now(),
    });
    window.logAudit && window.logAudit('apikey_regenerate', window.allRestaurants?.[restId]?.info?.name || restId,
      t('sa_ak_log_regenerated', "API kalit qayta generatsiya qilindi"));
    return newKey;
  }

  window.akRegenerate = async function () {
    const restId = document.getElementById('akEditRestId').value.trim();
    const keyId = document.getElementById('akEditKeyId').value.trim();
    if (!restId || !keyId) return;
    if (!confirm(t('sa_ak_confirm_regenerate', "Yangi kalit generatsiya qilinsa, eski kalit ishlamay qoladi. Davom etasizmi?"))) return;
    try {
      const newKey = await _akDoRegenerate(restId, keyId);
      document.getElementById('akKeyDisplay').value = newKey;
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  window.akQuickRegenerate = async function (restId, keyId) {
    if (!confirm(t('sa_ak_confirm_regenerate', "Yangi kalit generatsiya qilinsa, eski kalit ishlamay qoladi. Davom etasizmi?"))) return;
    try {
      await _akDoRegenerate(restId, keyId);
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  async function _akDoRevoke(restId, keyId) {
    await update(ref(window.db, `restaurants/${restId}/apiKeys/${keyId}`), { enabled: false });
    window.logAudit && window.logAudit('apikey_revoke', window.allRestaurants?.[restId]?.info?.name || restId,
      t('sa_ak_log_revoked', "API kalit bekor qilindi"));
  }

  window.akRevoke = async function () {
    const restId = document.getElementById('akEditRestId').value.trim();
    const keyId = document.getElementById('akEditKeyId').value.trim();
    if (!restId || !keyId) return;
    if (!confirm(t('sa_ak_confirm_revoke', "Bu kalitni bekor qilmoqchimisiz? U darhol ishlamay qoladi."))) return;
    try {
      await _akDoRevoke(restId, keyId);
      document.getElementById('akEnabledToggle').checked = false;
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  window.akQuickRevoke = async function (restId, keyId) {
    if (!confirm(t('sa_ak_confirm_revoke', "Bu kalitni bekor qilmoqchimisiz? U darhol ishlamay qoladi."))) return;
    try {
      await _akDoRevoke(restId, keyId);
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  window.akSave = async function () {
    const restId = document.getElementById('akEditRestId').value.trim();
    const keyId = document.getElementById('akEditKeyId').value.trim();
    if (!restId || !keyId) return;

    const enabled = document.getElementById('akEnabledToggle').checked;
    try {
      await update(ref(window.db, `restaurants/${restId}/apiKeys/${keyId}`), { enabled });
      window.logAudit && window.logAudit('apikey_update', window.allRestaurants?.[restId]?.info?.name || restId,
        enabled ? t('sa_ak_log_enabled', "API kalit faollashtirildi") : t('sa_ak_log_disabled', "API kalit o'chirildi"));
      window.akCloseModal();
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  // ─────────────────────────────────────────────────────────────
  // Create modal: pick restaurant, name, permissions, expiry
  // ─────────────────────────────────────────────────────────────
  window.akOpenCreateModal = function () {
    const select = document.getElementById('akNewRestSelect');
    if (select) {
      const entries = Object.entries(window.allRestaurants || {})
        .sort((a, b) => (a[1].info?.name || a[0]).localeCompare(b[1].info?.name || b[0]));
      select.innerHTML = entries.map(([rid, r]) =>
        `<option value="${rid}">${escapeHtml(r.info?.name || rid)}</option>`).join('');
    }
    const nameInput = document.getElementById('akNewNameInput');
    if (nameInput) nameInput.value = '';
    document.querySelectorAll('.akNewPerm').forEach(cb => cb.checked = true);
    const expirySelect = document.getElementById('akNewExpirySelect');
    if (expirySelect) expirySelect.value = '0';

    const modal = document.getElementById('akCreateModal');
    if (modal) modal.style.display = 'flex';
  };

  window.akCloseCreateModal = function () {
    const modal = document.getElementById('akCreateModal');
    if (modal) modal.style.display = 'none';
  };

  window.akCreateKey = async function () {
    const restId = document.getElementById('akNewRestSelect')?.value;
    if (!restId) return;
    const name = (document.getElementById('akNewNameInput')?.value || '').trim();
    if (!name) {
      alert(t('sa_ak_err_no_name', "Kalit uchun nom kiriting"));
      return;
    }

    const permissions = {};
    document.querySelectorAll('.akNewPerm').forEach(cb => { permissions[cb.value] = cb.checked; });

    const expiryDays = parseInt(document.getElementById('akNewExpirySelect')?.value || '0', 10);
    const expiresAt = expiryDays > 0 ? Date.now() + expiryDays * 86400000 : 0;

    const newKey = _akGenerateKey();
    const keyId = `key_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    try {
      await update(ref(window.db, `restaurants/${restId}/apiKeys/${keyId}`), {
        name,
        apiKey: newKey,
        enabled: true,
        permissions,
        expiresAt,
        createdAt: Date.now(),
      });
      window.logAudit && window.logAudit('apikey_create', window.allRestaurants?.[restId]?.info?.name || restId,
        t('sa_ak_log_created', "Yangi API kalit yaratildi") + `: ${name}`);
      window.akCloseCreateModal();
      window.akRenderList();
    } catch (error) {
      alert(t("sa_error_prefix", "Xatolik: ") + (error?.message || ""));
    }
  };

  function _akAttachNavHook() {
    document.querySelectorAll('.sidebar-nav a[href="#apikeys"]').forEach(link => {
      link.addEventListener('click', () => window.akRenderList());
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _akAttachNavHook);
  else _akAttachNavHook();

})(); // end API Keys module

// ============================================
// 🗄️ STORAGE MONITOR — restoranlar bo'yicha taxminiy xotira sarfi
// ============================================
// Eslatma: bu yerda haqiqiy Firebase Storage baytlari o'lchanmaydi (u alohida
// SDK/API talab qiladi). Buning o'rniga har bir restoran uchun Realtime DB
// ichida allaqachon yuklangan (window.allRestaurants) ma'lumotlar asosida:
//  - Orders / Inventory yozuvlar soni sanaladi
//  - Rasm-shaklidagi maydonlar (base64 yoki url) topilib sanaladi
//  - Butun restoran subtree'sining JSON og'irligi baytlarda taxminan hisoblanadi
// Bu "kim bazani ortiqcha to'ldiryapti" degan savolga aniq javob beradi va
// haqiqiy Storage API ulanganda osongina almashtirilishi mumkin.
(function () {
  const IMAGE_KEY_HINTS = ['image', 'img', 'photo', 'rasm', 'avatar', 'logo', 'banner', 'picture', 'thumbnail'];
  const ORDER_KEY_HINTS = ['orders'];
  const INVENTORY_KEY_HINTS = ['inventory', 'ombor', 'products', 'stock', 'warehouse'];

  function _smIsImageValue(val) {
    if (typeof val !== 'string' || val.length < 20) return false;
    return val.startsWith('data:image') || /^https?:\/\/.+\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(val);
  }

  // Restoran subtree'sini bir marta aylanib chiqib, hisoblarni yig'ib qaytaradi.
  function _smAnalyzeRestaurant(rest) {
    let orderCount = 0;
    let inventoryCount = 0;
    let imageCount = 0;
    let approxBytes = 0;

    try {
      approxBytes = JSON.stringify(rest || {}).length; // UTF-16 belgilar soni ≈ bayt (taxminiy)
    } catch (e) {
      approxBytes = 0;
    }

    function walk(node, keyPath) {
      if (!node || typeof node !== 'object') return;
      const lastKey = (keyPath[keyPath.length - 1] || '').toLowerCase();

      if (ORDER_KEY_HINTS.includes(lastKey)) {
        orderCount += Object.keys(node).length;
      }
      if (INVENTORY_KEY_HINTS.some(h => lastKey.includes(h))) {
        inventoryCount += Object.keys(node).length;
      }

      Object.entries(node).forEach(([k, v]) => {
        const kLower = k.toLowerCase();
        if (_smIsImageValue(v)) {
          imageCount++;
        } else if (v && typeof v === 'object') {
          walk(v, [...keyPath, kLower]);
        } else if (IMAGE_KEY_HINTS.some(h => kLower.includes(h)) && typeof v === 'string' && v.length > 0) {
          imageCount++;
        }
      });
    }

    walk(rest, []);

    return { orderCount, inventoryCount, imageCount, approxBytes };
  }

  function _smFormatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 KB';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toLocaleString('ru-RU', { maximumFractionDigits: i === 0 ? 0 : 1 })} ${units[i]}`;
  }

  function _smComputeAll() {
    const entries = Object.entries(window.allRestaurants || {});
    const rows = entries.map(([rid, rest]) => {
      const stats = _smAnalyzeRestaurant(rest);
      return {
        rid,
        name: rest?.info?.name || rid,
        domain: rest?.info?.domain || '',
        ...stats
      };
    });
    const totalBytes = rows.reduce((sum, r) => sum + r.approxBytes, 0);
    return { rows, totalBytes };
  }

  window.smRenderList = function () {
    const body = document.getElementById('smTableBody');
    if (!body) return;

    const query = (document.getElementById('smSearchInput')?.value || '').toLowerCase().trim();
    const sortBy = document.getElementById('smSortBy')?.value || 'storage';

    const { rows, totalBytes } = _smComputeAll();

    // SUMMARY CARDS
    const summaryEl = document.getElementById('smSummaryRow');
    if (summaryEl) {
      const totalOrders = rows.reduce((s, r) => s + r.orderCount, 0);
      const totalInventory = rows.reduce((s, r) => s + r.inventoryCount, 0);
      const totalImages = rows.reduce((s, r) => s + r.imageCount, 0);
      const cards = [
        { label: t('sa_sm_card_total_storage', "Umumiy taxminiy hajm"), value: _smFormatBytes(totalBytes), color: '#2563eb' },
        { label: t('sa_sm_card_total_orders', "Jami buyurtmalar"), value: totalOrders.toLocaleString('ru-RU'), color: '#059669' },
        { label: t('sa_sm_card_total_inventory', "Jami ombor yozuvlari"), value: totalInventory.toLocaleString('ru-RU'), color: '#d97706' },
        { label: t('sa_sm_card_total_images', "Jami rasmlar"), value: totalImages.toLocaleString('ru-RU'), color: '#7c3aed' }
      ];
      summaryEl.innerHTML = cards.map(c => `
        <div style="background:#fff; border:1px solid #e5e7eb; border-radius:14px; padding:16px 18px; box-shadow:0 2px 8px rgba(0,0,0,0.04);">
          <div style="font-size:12px; color:#6b7280; font-weight:600; margin-bottom:6px;">${c.label}</div>
          <div style="font-size:22px; font-weight:800; color:${c.color};">${c.value}</div>
        </div>`).join('');
    }

    let filtered = rows;
    if (query) {
      filtered = filtered.filter(r =>
        r.name.toLowerCase().includes(query) ||
        r.domain.toLowerCase().includes(query) ||
        r.rid.toLowerCase().includes(query)
      );
    }

    const sorters = {
      storage: (a, b) => b.approxBytes - a.approxBytes,
      orders: (a, b) => b.orderCount - a.orderCount,
      inventory: (a, b) => b.inventoryCount - a.inventoryCount,
      images: (a, b) => b.imageCount - a.imageCount,
      name: (a, b) => a.name.localeCompare(b.name)
    };
    filtered = [...filtered].sort(sorters[sortBy] || sorters.storage);

    const countEl = document.getElementById('smResultCount');
    if (countEl) countEl.textContent = `${filtered.length} ${t('sa_lm_count_suffix', "ta restoran")}`;

    if (!filtered.length) {
      body.innerHTML = `<tr><td colspan="6" style="padding:30px; text-align:center; color:#94a3b8;">${t('sa_lm_none_found', "Restoranlar topilmadi")}</td></tr>`;
      return;
    }

    body.innerHTML = filtered.map(r => {
      const name = escapeHtml(r.name);
      const domain = r.domain ? `<div style="font-size:11px; color:#9ca3af;">${escapeHtml(r.domain)}</div>` : '';
      const sharePct = totalBytes > 0 ? (r.approxBytes / totalBytes * 100) : 0;
      const barColor = sharePct > 20 ? '#ef4444' : (sharePct > 8 ? '#d97706' : '#2563eb');
      return `
        <tr style="border-top:1px solid #f1f5f9;">
          <td style="padding:12px 16px;">
            <div style="font-weight:700; color:#111827;">${name}</div>
            ${domain}
          </td>
          <td style="padding:12px 10px; text-align:right; font-variant-numeric:tabular-nums;">${r.orderCount.toLocaleString('ru-RU')}</td>
          <td style="padding:12px 10px; text-align:right; font-variant-numeric:tabular-nums;">${r.inventoryCount.toLocaleString('ru-RU')}</td>
          <td style="padding:12px 10px; text-align:right; font-variant-numeric:tabular-nums;">${r.imageCount.toLocaleString('ru-RU')}</td>
          <td style="padding:12px 16px; white-space:nowrap; font-weight:700; color:#111827;">${_smFormatBytes(r.approxBytes)}</td>
          <td style="padding:12px 16px; min-width:140px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <div style="flex:1; background:#f1f5f9; border-radius:6px; height:8px; overflow:hidden;">
                <div style="width:${Math.min(sharePct, 100).toFixed(1)}%; background:${barColor}; height:100%;"></div>
              </div>
              <span style="font-size:11px; color:#6b7280; white-space:nowrap;">${sharePct.toFixed(1)}%</span>
            </div>
          </td>
        </tr>`;
    }).join('');
  };

  function _smAttachNavHook() {
    // Xotira Monitor endi Tizim holati (#health) bo'limi ichida joylashgan
    document.querySelectorAll('.sidebar-nav a[href="#health"]').forEach(link => {
      link.addEventListener('click', () => window.smRenderList());
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _smAttachNavHook);
  else _smAttachNavHook();

})();

// ═══════════════════════════════════════════════════════════════════
// PLATFORM USERS MANAGEMENT MODULE
// Nesta ERP jamoasi a'zolari: Support, Developer, Moderator, Sales,
// Marketing, Finance va boshqa ichki (mijoz bo'lmagan) xodimlar.
// Firebase path: systemData/platformUsers/{userId}
//   {
//     name: string,
//     email: string,
//     phone: string,
//     role: 'support' | 'developer' | 'moderator' | 'sales' | 'marketing' | 'finance',
//     status: 'active' | 'suspended',
//     note: string,
//     createdAt: timestamp,
//     lastActiveAt: timestamp | null,
//   }
// ═══════════════════════════════════════════════════════════════════
(function () {
  window.allPlatformUsers = window.allPlatformUsers || {};

  const _puRoleMeta = {
    superadmin: { label: () => t('sa_pu_role_superadmin', 'SuperAdmin'), permission: () => t('sa_pu_perm_full', "To'liq") },
    support:    { label: () => t('sa_pu_role_support', 'Support'), permission: () => t('sa_pu_role_support', 'Support') },
    developer:  { label: () => t('sa_pu_role_developer', 'Developer'), permission: () => t('sa_pu_role_developer', 'Developer') },
    moderator:  { label: () => t('sa_pu_role_moderator', 'Moderator'), permission: () => t('sa_pu_role_moderator', 'Moderator') },
    sales:      { label: () => t('sa_pu_role_sales', 'Sales'), permission: () => t('sa_pu_role_sales', 'Sales') },
    marketing:  { label: () => t('sa_pu_role_marketing', 'Marketing'), permission: () => t('sa_pu_role_marketing', 'Marketing') },
    finance:    { label: () => t('sa_pu_role_finance', 'Finance'), permission: () => t('sa_pu_role_finance', 'Finance') },
  };

  function _puRoleText(role) {
    const meta = _puRoleMeta[role];
    return meta ? escapeHtml(meta.label()) : escapeHtml(role || '—');
  }

  function _puPermissionText(role) {
    const meta = _puRoleMeta[role];
    return meta ? escapeHtml(meta.permission()) : escapeHtml(role || '—');
  }

  function _puStatusDot(status) {
    const isActive = status !== 'suspended';
    return `<span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${isActive ? '#22c55e' : '#ef4444'};" title="${isActive ? t('sa_pu_status_active', 'Faol') : t('sa_pu_status_suspended', 'Bloklangan')}"></span>`;
  }

  function _puLastActiveText(ts) {
    if (!ts) return t('sa_pu_never_active', 'Hech qachon');
    const now = Date.now();
    const diffMs = now - ts;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    const dateObj = new Date(ts);
    const isToday = dateObj.toDateString() === new Date(now).toDateString();
    const yesterday = new Date(now - 86400000);
    const isYesterday = dateObj.toDateString() === yesterday.toDateString();

    if (diffMin < 1) return t('sa_pu_active_now', 'Hozir');
    if (diffMin < 60) return `${diffMin} ${t('sa_pu_min_ago', 'daqiqa')}`;
    if (isToday) return t('sa_pu_today', 'Bugun');
    if (isYesterday) return t('sa_pu_yesterday', 'Kecha');
    if (diffDay < 7) return `${diffDay} ${t('sa_days', 'kun')}`;
    return dateObj.toLocaleDateString('ru-RU');
  }

  // ─────────────────────────────────────────────────────────
  // Firebase listener
  // ─────────────────────────────────────────────────────────
  window.listenPlatformUsers = function () {
    onValue(ref(window.db, 'systemData/platformUsers'), (snap) => {
      window.allPlatformUsers = snap.exists() ? snap.val() : {};
      window.puRenderList();
      window.puUpdateStats();
    });
  };

  // ─────────────────────────────────────────────────────────
  // Stats cards
  // ─────────────────────────────────────────────────────────
  window.puUpdateStats = function () {
    const list = Object.values(window.allPlatformUsers || {});
    const total = list.length;
    const active = list.filter(u => u.status !== 'suspended').length;
    const suspended = total - active;
    const support = list.filter(u => u.role === 'support').length;

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('puTotalCount', total);
    setEl('puActiveCount', active);
    setEl('puSuspendedCount', suspended);
    setEl('puSupportCount', support);
  };

  // ─────────────────────────────────────────────────────────
  // List render (search + role/status filter)
  // ─────────────────────────────────────────────────────────
  window.puRenderList = function () {
    const body = document.getElementById('puTableBody');
    if (!body) return;

    const query = (document.getElementById('puSearchInput')?.value || '').toLowerCase().trim();
    const roleFilter = document.getElementById('puRoleFilter')?.value || '';
    const statusFilter = document.getElementById('puStatusFilter')?.value || '';

    let entries = Object.entries(window.allPlatformUsers || {});

    if (query) {
      entries = entries.filter(([, u]) =>
        (u.name || '').toLowerCase().includes(query) ||
        (u.email || '').toLowerCase().includes(query) ||
        (u.phone || '').toLowerCase().includes(query));
    }
    if (roleFilter) entries = entries.filter(([, u]) => u.role === roleFilter);
    if (statusFilter) entries = entries.filter(([, u]) => (u.status || 'active') === statusFilter);

    entries.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

    if (!entries.length) {
      body.innerHTML = `<tr><td colspan="7" style="padding:30px; text-align:center; color:#94a3b8;">${t('sa_pu_none_found', 'Xodimlar topilmadi')}</td></tr>`;
      return;
    }

    body.innerHTML = entries.map(([uid, u]) => {
      const isSuspended = u.status === 'suspended';
      const contactVal = u.email || u.phone || '';
      const contactHref = u.email ? `mailto:${u.email}` : (u.phone ? `tel:${u.phone}` : '');
      const contactHtml = contactVal
        ? `<a href="${contactHref}" style="color:#2563eb; text-decoration:none;" onclick="event.stopPropagation();">${escapeHtml(contactVal)} <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:9px;"></i></a>`
        : '<span style="color:#9ca3af;">—</span>';

      return `
      <tr style="border-top:1px solid #f1f5f9;">
        <td style="padding:14px 16px; font-weight:700; color:#111827; cursor:pointer;" onclick="window.puOpenEditModal('${uid}')">
          ${escapeHtml(u.name || '')}
          ${u.note ? `<div style="font-size:11px; color:#9ca3af; font-weight:500;">${escapeHtml(u.note)}</div>` : ''}
        </td>
        <td style="padding:14px 16px;">${contactHtml}</td>
        <td style="padding:14px 16px; color:#111827;">${_puRoleText(u.role)}</td>
        <td style="padding:14px 16px; color:#111827;">${_puPermissionText(u.role)}</td>
        <td style="padding:14px 16px;">${_puStatusDot(u.status)}</td>
        <td style="padding:14px 16px; color:#111827; font-size:13px; white-space:nowrap;">${_puLastActiveText(u.lastActiveAt)}</td>
        <td style="padding:14px 16px; text-align:right; white-space:nowrap;">
          <button onclick="event.stopPropagation(); window.puOpenViewDrawer('${uid}')" title="${t('sa_view', "Ko'rish")}"
            style="background:none; border:none; color:#2563eb; cursor:pointer; padding:6px; margin-right:2px; font-size:15px;">
            <i class="fa-solid fa-eye"></i>
          </button>
          <button onclick="event.stopPropagation(); window.puOpenEditModal('${uid}')" title="${t('sa_pu_action_edit', 'Tahrirlash')}"
            style="background:none; border:none; color:#f59e0b; cursor:pointer; padding:6px; margin-right:2px; font-size:15px;">
            <i class="fa-solid fa-pen"></i>
          </button>
          ${!isSuspended ? `
          <button onclick="event.stopPropagation(); window.puToggleStatus('${uid}')" title="${t('sa_pu_action_suspend', 'Bloklash')}"
            style="background:none; border:none; color:#ef4444; cursor:pointer; padding:6px; font-size:15px;">
            <i class="fa-solid fa-ban"></i>
          </button>` : `
          <button onclick="event.stopPropagation(); window.puToggleStatus('${uid}')" title="${t('sa_pu_action_activate', 'Faollashtirish')}"
            style="background:none; border:none; color:#16a34a; cursor:pointer; padding:6px; font-size:15px;">
            <i class="fa-solid fa-user-check"></i>
          </button>`}
        </td>
      </tr>`;
    }).join('');
  };

  // ─────────────────────────────────────────────────────────
  // Copy table to clipboard (tab-separated, for pasting into Excel/Sheets)
  // ─────────────────────────────────────────────────────────
  window.puCopyTable = function () {
    const list = Object.values(window.allPlatformUsers || {});
    const header = [t('sa_pu_copy_col_name', 'Ism'), t('sa_pu_col_contact', 'Telefon / Email'), t('sa_pu_col_role', 'Rol'), t('sa_pu_col_permission', 'Ruxsat'), t('sa_pu_copy_col_status', 'Holat'), t('sa_pu_col_last_active', 'Oxirgi faollik')];
    const rows = list.map(u => [
      u.name || '',
      u.email || u.phone || '',
      _puRoleText(u.role),
      _puPermissionText(u.role),
      u.status === 'suspended' ? t('sa_pu_status_suspended', 'Bloklangan') : t('sa_pu_status_active', 'Faol'),
      _puLastActiveText(u.lastActiveAt)
    ]);
    const text = [header, ...rows].map(r => r.join('\t')).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  };

  // ─────────────────────────────────────────────────────────
  // Create / Edit modal
  // ─────────────────────────────────────────────────────────
  // Helper: split name → first/last
  function _puSplitName(fullName) {
    const parts = (fullName || '').trim().split(/\s+/);
    return { first: parts[0] || '', last: parts.slice(1).join(' ') };
  }

  // Sync permissions badges when role changes
  // Role -> default permission set. Used to pre-fill when a role is chosen;
  // the superadmin can then click individual cards to diverge from this.
  window._puRolePermsMapModal = window._puRolePermsMapModal || {
    superadmin: ['restaurants','promocodes','requests','broadcast','auditlog','systemstatus','backup','settings'],
    developer:  ['restaurants','auditlog','systemstatus','backup','settings'],
    support:    ['restaurants','requests','auditlog','systemstatus'],
    moderator:  ['restaurants','requests','broadcast'],
    sales:      ['restaurants','promocodes','requests','broadcast'],
    marketing:  ['restaurants','promocodes','broadcast'],
    finance:    ['restaurants','settings'],
  };

  const _puPermLabels = {
    restaurants:  { icon: 'fa-store',      label: () => t('sa_pu_perm_restaurants',  'Restoranlar') },
    promocodes:   { icon: 'fa-tag',        label: () => t('sa_pu_perm_promocodes',   'Promo kodlar') },
    requests:     { icon: 'fa-inbox',      label: () => t('sa_pu_perm_requests',     "So'rovlar") },
    auditlog:     { icon: 'fa-file-lines', label: () => t('sa_pu_perm_auditlog',     'Audit Log') },
    broadcast:    { icon: 'fa-bullhorn',   label: () => t('sa_pu_perm_broadcast',    'Xabar yuborish') },
    backup:       { icon: 'fa-database',   label: () => t('sa_pu_perm_backup',       'Backup') },
    systemstatus: { icon: 'fa-signal',     label: () => t('sa_pu_perm_systemstatus', 'Tizim holati') },
    settings:     { icon: 'fa-gear',       label: () => t('sa_pu_perm_settings',     'Sozlamalar') },
  };
  const _puAllPermKeys = ['restaurants','promocodes','requests','broadcast','auditlog','systemstatus','backup','settings'];

  // Current modal state: which permission keys are checked right now.
  // Populated by puApplyRoleDefaults() (role change / initial open) or by
  // puOpenEditModal() (existing user's saved permissions).
  window._puSelectedPerms = window._puSelectedPerms || [];

  function _puRenderPermsGrid() {
    const grid = document.getElementById('puModalPermsGrid');
    if (!grid) return;
    const selected = window._puSelectedPerms || [];

    grid.innerHTML = _puAllPermKeys.map(key => {
      const meta = _puPermLabels[key] || { icon: 'fa-circle', label: () => key };
      const on = selected.includes(key);
      return `<div class="pu-modal-perm ${on ? 'active' : 'inactive'}" data-perm-key="${key}"
          onclick="window.puTogglePerm('${key}')" role="button" tabindex="0"
          onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault(); window.puTogglePerm('${key}');}">
        <div class="pu-modal-perm-icon">
          <i class="fa-solid ${meta.icon}"></i>
        </div>
        <span>${escapeHtml(meta.label())}</span>
        ${on ? '<i class="fa-solid fa-check" style="margin-left:auto; font-size:10px; color:#2563eb;"></i>'
               : '<i class="fa-solid fa-xmark" style="margin-left:auto; font-size:10px; color:#d1d5db;"></i>'}
      </div>`;
    }).join('');

    _puUpdatePermsNote();
  }

  function _puUpdatePermsNote() {
    const note = document.getElementById('puModalPermsNote');
    if (!note) return;
    const role = document.getElementById('puRoleInput')?.value;
    const roleDefaults = (window._puRolePermsMapModal[role] || []).slice().sort();
    const current = (window._puSelectedPerms || []).slice().sort();
    const matchesRoleDefault = JSON.stringify(roleDefaults) === JSON.stringify(current);
    note.textContent = matchesRoleDefault
      ? t('sa_pu_perms_note_default', 'rolga qarab')
      : t('sa_pu_perms_note_custom', "qo'lda sozlangan");
  }

  // Toggle a single permission on/off. Called from the onclick on each card.
  window.puTogglePerm = function (key) {
    const cur = window._puSelectedPerms || [];
    window._puSelectedPerms = cur.includes(key)
      ? cur.filter(k => k !== key)
      : [...cur, key];
    _puRenderPermsGrid();
  };

  // Reset the permission grid to the selected role's default set.
  // Called when the Rol <select> changes.
  window.puApplyRoleDefaults = function () {
    const role = document.getElementById('puRoleInput')?.value;
    window._puSelectedPerms = (window._puRolePermsMapModal[role] || []).slice();
    _puRenderPermsGrid();
    _puRefreshLoginDisplay();
  };

  // Kept for backward compatibility with any existing callers/onchange
  // handlers that still reference the old name.
  window.puModalSyncPerms = window.puApplyRoleDefaults;

  function _puRefreshLoginDisplay() {
    const email = document.getElementById('puEmailInput')?.value.trim();
    const phone = document.getElementById('puPhoneInput')?.value.trim();
    const loginEl = document.getElementById('puLoginDisplay');
    if (loginEl) loginEl.value = email || phone || '—';
  }

  // Show/hide a password <input>'s text, flipping the eye icon on the
  // trigger button that called this.
  window.puTogglePasswordVisibility = function (inputId, btnEl) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const icon = btnEl?.querySelector('i');
    if (input.type === 'password') {
      input.type = 'text';
      if (icon) { icon.classList.remove('fa-eye'); icon.classList.add('fa-eye-slash'); }
    } else {
      input.type = 'password';
      if (icon) { icon.classList.remove('fa-eye-slash'); icon.classList.add('fa-eye'); }
    }
  };

  // Reveal the "new password" field in edit mode (collapsed by default so
  // editing an existing user never implies their password is being reset).
  window.puShowPasswordResetField = function () {
    const toggleRow = document.getElementById('puPasswordEditToggleRow');
    const fieldRow  = document.getElementById('puPasswordEditFieldRow');
    if (toggleRow) toggleRow.style.display = 'none';
    if (fieldRow)  fieldRow.style.display  = 'block';
    document.getElementById('puNewPasswordInput')?.focus();
  };

  window.puOpenCreateModal = function () {
    document.getElementById('puEditId').value = '';
    document.getElementById('puModalTitle').textContent = t('sa_pu_modal_create_title', '🛡️ Yangi platform xodimi');

    const iconEl = document.getElementById('puModalIcon');
    if (iconEl) { iconEl.innerHTML = '<i class="fa-solid fa-user-plus"></i>'; iconEl.style.background = '#f0fdf4'; iconEl.style.color = '#16a34a'; }

    document.getElementById('puFirstNameInput').value  = '';
    document.getElementById('puLastNameInput').value   = '';
    document.getElementById('puEmailInput').value      = '';
    document.getElementById('puPhoneInput').value      = '';
    document.getElementById('puLoginDisplay').value    = '—';
    document.getElementById('puRoleInput').value       = 'support';
    document.getElementById('puStatusInput').value     = 'active';
    document.getElementById('puNoteInput').value       = '';

    // Password UI: "create" mode by default — required password field
    // visible, the "existing user" change-password toggle hidden.
    const createBlock = document.getElementById('puPasswordCreateBlock');
    const editBlock    = document.getElementById('puPasswordEditBlock');
    if (createBlock) createBlock.style.display = 'block';
    if (editBlock)   editBlock.style.display   = 'none';
    const pwInput = document.getElementById('puPasswordInput');
    if (pwInput) pwInput.value = '';
    const newPwInput = document.getElementById('puNewPasswordInput');
    if (newPwInput) newPwInput.value = '';
    const toggleRow = document.getElementById('puPasswordEditToggleRow');
    const fieldRow  = document.getElementById('puPasswordEditFieldRow');
    if (toggleRow) toggleRow.style.display = 'block';
    if (fieldRow)  fieldRow.style.display  = 'none';

    // live login sync
    ['puEmailInput','puPhoneInput'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.oninput = _puRefreshLoginDisplay;
    });

    window.puApplyRoleDefaults();

    const modal = document.getElementById('puModal');
    if (modal) modal.style.display = 'flex';
  };

  window.puOpenEditModal = function (uid) {
    const u = window.allPlatformUsers?.[uid];
    if (!u) return;

    window.puOpenCreateModal();
    document.getElementById('puEditId').value = uid;
    document.getElementById('puModalTitle').textContent = t('sa_pu_modal_edit_title', '🛡️ Xodimni tahrirlash');

    const iconEl = document.getElementById('puModalIcon');
    if (iconEl) {
      const initials = (u.name || '').trim().split(' ').map(w => w[0] || '').join('').toUpperCase().slice(0,2);
      if (initials) { iconEl.textContent = initials; } else { iconEl.innerHTML = '<i class="fa-solid fa-user-pen"></i>'; }
      iconEl.style.background = '#eff6ff'; iconEl.style.color = '#2563eb';
    }

    const { first, last } = _puSplitName(u.name);
    document.getElementById('puFirstNameInput').value  = first;
    document.getElementById('puLastNameInput').value   = last;
    document.getElementById('puEmailInput').value      = u.email || '';
    document.getElementById('puPhoneInput').value      = u.phone || '';
    document.getElementById('puRoleInput').value       = u.role || 'support';
    document.getElementById('puStatusInput').value     = u.status || 'active';
    document.getElementById('puNoteInput').value       = u.note || '';

    // Password UI: "edit" mode — hide the required-password field, show
    // the collapsed "Parolni almashtirish" toggle instead. The account
    // already exists in Firebase Auth; we only touch its password if the
    // superadmin explicitly opts in.
    const createBlock = document.getElementById('puPasswordCreateBlock');
    const editBlock    = document.getElementById('puPasswordEditBlock');
    if (createBlock) createBlock.style.display = 'none';
    if (editBlock)   editBlock.style.display   = 'block';

    // Permissions: load this user's saved set if present, otherwise fall
    // back to the role default (covers users saved before this feature).
    window._puSelectedPerms = Array.isArray(u.permissions) && u.permissions.length
      ? u.permissions.slice()
      : (window._puRolePermsMapModal[u.role] || []).slice();
    _puRenderPermsGrid();
    _puRefreshLoginDisplay();
  };

  window.puCloseModal = function () {
    const modal = document.getElementById('puModal');
    if (modal) modal.style.display = 'none';
  };

  // ─────────────────────────────────────────────────────────
  // Platform User View Drawer (read-only, 4 tabs)
  // ─────────────────────────────────────────────────────────

  // Role → permissions map (which capabilities each role has)
  const _puRolePermsMap = {
    superadmin: [
      'restaurants', 'promocodes', 'requests', 'broadcast',
      'auditlog', 'systemstatus', 'backup', 'settings'
    ],
    developer: [
      'restaurants', 'auditlog', 'systemstatus', 'backup', 'settings'
    ],
    support: [
      'restaurants', 'requests', 'auditlog', 'systemstatus'
    ],
    moderator: [
      'restaurants', 'requests', 'broadcast'
    ],
    sales: [
      'restaurants', 'promocodes', 'requests', 'broadcast'
    ],
    marketing: [
      'restaurants', 'promocodes', 'broadcast'
    ],
    finance: [
      'restaurants', 'settings'
    ],
  };

  // NOTE: label/icon metadata for permission keys is the shared
  // _puPermLabels declared earlier (next to puTogglePerm) — reused here so
  // the edit modal and this view drawer always show identical labels.

  // Currently viewed uid (for edit/toggle from drawer)
  let _puViewUid = null;

  window.puOpenViewDrawer = function (uid) {
    const u = window.allPlatformUsers?.[uid];
    if (!u) return;
    _puViewUid = uid;

    // ── Header ──
    const initials = (u.name || '').trim().split(' ').map(w => w[0] || '').join('').toUpperCase().slice(0, 2);
    const avatarEl = document.getElementById('puDwAvatar');
    if (avatarEl) {
      if (initials) {
        avatarEl.textContent = initials;
        avatarEl.style.fontSize = '15px';
      } else {
        avatarEl.innerHTML = '<i class="fa-solid fa-user-shield"></i>';
        avatarEl.style.fontSize = '18px';
      }
      const isSuspended = u.status === 'suspended';
      avatarEl.style.background = isSuspended ? '#fef2f2' : '#eff6ff';
      avatarEl.style.color = isSuspended ? '#ef4444' : '#2563eb';
    }
    const nameEl = document.getElementById('puDwName');
    if (nameEl) nameEl.textContent = u.name || '—';
    const roleEl = document.getElementById('puDwRole');
    if (roleEl) roleEl.textContent = _puRoleText(u.role) + (u.status === 'suspended' ? ' · 🔴 ' + t('sa_pu_status_suspended', 'Bloklangan') : ' · 🟢 ' + t('sa_pu_status_active', 'Faol'));

    // ── Tab: Asosiy ──
    const mainRows = [
      { label: t('sa_pu_col_name',       'Ism-Familiya'),   value: u.name  || '—' },
      { label: t('sa_pu_field_firstname', 'Ism'),            value: (u.name || '').split(' ')[0] || '—' },
      { label: t('sa_pu_field_lastname',  'Familiya'),       value: (u.name || '').split(' ').slice(1).join(' ') || '—' },
      { label: t('sa_pu_field_phone',     'Telefon'),        value: u.phone || '—' },
      { label: t('sa_pu_field_email',     'Email'),          value: u.email || '—' },
      { label: t('sa_pu_field_login',     'Login'),          value: u.email || u.phone || '—' },
      { label: t('sa_pu_col_role',        'Rol'),            value: _puRoleText(u.role) },
      { label: t('sa_pu_col_status',      'Holati'),         value: u.status === 'suspended' ? t('sa_pu_status_suspended', 'Bloklangan') : t('sa_pu_status_active', 'Faol') },
      { label: t('sa_pu_field_created',   'Yaratilgan sana'), value: u.createdAt ? new Date(u.createdAt).toLocaleString('ru-RU') : '—' },
    ];
    const mainContainer = document.getElementById('puDwMainRows');
    if (mainContainer) {
      mainContainer.innerHTML = mainRows.map(r => `
        <div class="pu-info-row">
          <span class="pu-info-label">${escapeHtml(r.label)}</span>
          <span class="pu-info-value">${escapeHtml(r.value)}</span>
        </div>`).join('');
    }

    // ── Tab: Ruxsatlar ──
    // Prefer the user's actually-saved permissions (may have been
    // hand-customized in the edit modal); fall back to role defaults only
    // for records saved before per-user permissions existed.
    const allowedPerms = Array.isArray(u.permissions) && u.permissions.length
      ? u.permissions
      : (_puRolePermsMap[u.role] || []);
    const allPermKeys = Object.keys(_puPermLabels);
    const permsContainer = document.getElementById('puDwPermsGrid');
    if (permsContainer) {
      permsContainer.innerHTML = allPermKeys.map(key => {
        const meta = _puPermLabels[key];
        const has = allowedPerms.includes(key);
        return `<div class="pu-perm-item">
          <div class="pu-perm-check ${has ? 'on' : 'off'}">
            <i class="fa-solid ${has ? 'fa-check' : 'fa-xmark'}"></i>
          </div>
          <i class="fa-solid ${meta.icon}" style="color:${has ? '#2563eb' : '#d1d5db'}; width:16px; text-align:center;"></i>
          <span style="font-size:13px; font-weight:600; color:${has ? '#111827' : '#9ca3af'};">${escapeHtml(meta.label())}</span>
        </div>`;
      }).join('');
    }

    // ── Tab: Faollik (from auditLogs, filtered by actor name) ──
    const activityContainer = document.getElementById('puDwActivityList');
    if (activityContainer) {
      const logs = window.globalAuditLogData ? Object.values(window.globalAuditLogData) : [];
      const userName = (u.name || '').toLowerCase();
      const userEmail = (u.email || '').toLowerCase();
      const userFiltered = logs
        .filter(l => {
          const actor = (l.actor || '').toLowerCase();
          return actor && (actor === userName || actor === userEmail);
        })
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, 20);

      if (!userFiltered.length) {
        activityContainer.innerHTML = `<div style="padding:30px 0; text-align:center; color:#9ca3af; font-size:13px;">
          <i class="fa-solid fa-clock" style="font-size:22px; margin-bottom:10px; display:block; opacity:.4;"></i>
          ${t('sa_pu_dw_no_activity', "Faollik ma'lumotlari topilmadi")}
        </div>`;
      } else {
        activityContainer.innerHTML = userFiltered.map(l => {
          const d = new Date(l.timestamp || 0);
          const dateStr = `${d.getDate().toString().padStart(2,'0')}.${(d.getMonth()+1).toString().padStart(2,'0')}`;
          const timeStr = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
          return `<div class="pu-activity-item">
            <div style="display:flex; flex-direction:column; align-items:center; gap:4px; flex-shrink:0; padding-top:2px;">
              <div class="pu-activity-dot"></div>
              <div style="font-size:10px; font-weight:700; color:#6b7280; white-space:nowrap;">${escapeHtml(dateStr)}</div>
              <div style="font-size:9px; color:#9ca3af;">${escapeHtml(timeStr)}</div>
            </div>
            <div>
              <div style="font-size:13px; font-weight:600; color:#111827; margin-bottom:2px;">${escapeHtml(l.details || l.action || '—')}</div>
              ${l.restName ? `<div style="font-size:11px; color:#6b7280;"><i class="fa-solid fa-store" style="margin-right:4px;"></i>${escapeHtml(l.restName)}</div>` : ''}
            </div>
          </div>`;
        }).join('');
      }
    }

    // ── Tab: Sessiyalar (placeholder — real data would come from Firebase sessions node) ──
    const sessionsContainer = document.getElementById('puDwSessionsList');
    if (sessionsContainer) {
      // Attempt to get session info from allDevices or security center data
      const allDevices = window.allDevicesData ? Object.values(window.allDevicesData) : [];
      const userDevices = allDevices.filter(d =>
        (d.userEmail || '').toLowerCase() === userEmail ||
        (d.userName  || '').toLowerCase() === userName
      );

      if (!userDevices.length) {
        sessionsContainer.innerHTML = `<div style="padding:30px 0; text-align:center; color:#9ca3af; font-size:13px;">
          <i class="fa-solid fa-display" style="font-size:22px; margin-bottom:10px; display:block; opacity:.4;"></i>
          ${t('sa_pu_dw_no_sessions', 'Faol sessiya topilmadi')}
        </div>`;
      } else {
        sessionsContainer.innerHTML = userDevices.map(d => {
          const isOnline = d.lastSeen && (Date.now() - d.lastSeen) < 5 * 60 * 1000;
          const lastSeenStr = d.lastSeen ? new Date(d.lastSeen).toLocaleString('ru-RU') : '—';
          return `<div class="pu-session-card">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
              <div style="display:flex; align-items:center; gap:8px;">
                <i class="fa-solid fa-${d.deviceType === 'mobile' ? 'mobile-screen' : 'display'}" style="color:#6b7280; font-size:16px;"></i>
                <span style="font-weight:700; font-size:13px; color:#111827;">${escapeHtml(d.os || t('sa_pu_dw_unknown_os', 'Unknown OS'))}</span>
              </div>
              <span style="font-size:11px; font-weight:700; padding:3px 8px; border-radius:20px; background:${isOnline ? '#dcfce7' : '#f3f4f6'}; color:${isOnline ? '#16a34a' : '#6b7280'};">
                ${isOnline ? t('sa_pu_session_online','Online') : t('sa_pu_session_offline','Offline')}
              </span>
            </div>
            <div style="display:flex; flex-direction:column; gap:4px;">
              <div style="display:flex; gap:8px; font-size:12px; color:#6b7280;">
                <i class="fa-brands fa-${(d.browser || '').toLowerCase().includes('chrome') ? 'chrome' : 'firefox-browser'}" style="width:14px;"></i>
                <span>${escapeHtml(d.browser || '—')}</span>
              </div>
              <div style="display:flex; gap:8px; font-size:12px; color:#6b7280;">
                <i class="fa-solid fa-clock" style="width:14px;"></i>
                <span>${escapeHtml(lastSeenStr)}</span>
              </div>
              ${d.ip ? `<div style="display:flex; gap:8px; font-size:12px; color:#6b7280;"><i class="fa-solid fa-network-wired" style="width:14px;"></i><span>${escapeHtml(d.ip)}</span></div>` : ''}
            </div>
          </div>`;
        }).join('');
      }
    }

    // ── Footer toggle button ──
    const toggleBtn = document.getElementById('puDwToggleBtn');
    if (toggleBtn) {
      const isSuspended = u.status === 'suspended';
      if (isSuspended) {
        toggleBtn.style.background = '#f0fdf4';
        toggleBtn.style.color = '#16a34a';
        toggleBtn.style.borderColor = '#bbf7d0';
        toggleBtn.innerHTML = `<i class="fa-solid fa-user-check"></i> <span>${t('sa_pu_action_activate', 'Faollashtirish')}</span>`;
      } else {
        toggleBtn.style.background = '#fef2f2';
        toggleBtn.style.color = '#ef4444';
        toggleBtn.style.borderColor = '#fecaca';
        toggleBtn.innerHTML = `<i class="fa-solid fa-ban"></i> <span>${t('sa_pu_action_suspend', 'Bloklash')}</span>`;
      }
    }

    // Reset to first tab
    window.puSwitchViewTab('main');

    // Show drawer
    const drawer = document.getElementById('puViewDrawer');
    if (drawer) drawer.style.display = 'flex';
  };

  window.puCloseViewDrawer = function () {
    const drawer = document.getElementById('puViewDrawer');
    if (drawer) drawer.style.display = 'none';
    _puViewUid = null;
  };

  window.puSwitchViewTab = function (tabName) {
    const tabs = ['main', 'perms', 'activity', 'sessions'];
    tabs.forEach(name => {
      const pane = document.getElementById(`puVTab_${name}`);
      const btn  = document.querySelector(`.pu-view-tab[data-pu-tab="${name}"]`);
      if (pane) pane.style.display = name === tabName ? 'block' : 'none';
      if (btn) {
        btn.classList.toggle('active', name === tabName);
        btn.style.borderBottomColor = name === tabName ? '#2563eb' : 'transparent';
        btn.style.color = name === tabName ? '#2563eb' : '#6b7280';
      }
    });
  };

  window.puEditFromDrawer = function () {
    if (!_puViewUid) return;
    const uidToEdit = _puViewUid;
    window.puCloseViewDrawer();
    window.puOpenEditModal(uidToEdit);
  };

  window.puToggleFromDrawer = function () {
    if (!_puViewUid) return;
    window.puToggleStatus(_puViewUid);
    setTimeout(() => {
      if (_puViewUid && window.allPlatformUsers?.[_puViewUid]) {
        window.puOpenViewDrawer(_puViewUid);
      }
    }, 600);
  };

  // ─────────────────────────────────────────────────────────
  // Save (create or update)
  // ─────────────────────────────────────────────────────────
  function _puAuthErrorText(error) {
    const map = {
      'auth/email-already-in-use': t('sa_pu_err_email_in_use', 'Bu email allaqachon ro\'yxatdan o\'tgan'),
      'auth/invalid-email':        t('sa_pu_err_invalid_email', "Email formati noto'g'ri"),
      'auth/weak-password':        t('sa_pu_err_weak_password', 'Parol juda oddiy (kamida 6 ta belgi)'),
      'auth/wrong-password':       t('sa_pu_err_wrong_password', "Joriy parol mos kelmadi, parolni almashtirib bo'lmadi"),
      'auth/user-not-found':       t('sa_pu_err_auth_user_missing', "Bu xodimning Auth hisobi topilmadi \u2014 avval hisobni qayta yarating"),
      'auth/network-request-failed': t('sa_pu_err_network', 'Internet aloqasi xatosi'),
    };
    return map[error?.code] || error?.message || String(error);
  }

  window.puSave = async function () {
    const editId    = document.getElementById('puEditId').value.trim();
    const firstName = document.getElementById('puFirstNameInput').value.trim();
    const lastName  = document.getElementById('puLastNameInput').value.trim();
    const name      = [firstName, lastName].filter(Boolean).join(' ');
    const email     = document.getElementById('puEmailInput').value.trim();
    const phone     = document.getElementById('puPhoneInput').value.trim();
    const role      = document.getElementById('puRoleInput').value;
    const status    = document.getElementById('puStatusInput').value;
    const note      = document.getElementById('puNoteInput').value.trim();
    const permissions = (window._puSelectedPerms || []).slice();

    if (!firstName) { alert(t('sa_pu_err_name_required', 'Ismni kiriting')); return; }

    const saveBtn = document.getElementById('puSaveBtn');
    const setBusy = (busy) => {
      if (!saveBtn) return;
      saveBtn.disabled = busy;
      saveBtn.style.opacity = busy ? '0.6' : '1';
      saveBtn.style.cursor = busy ? 'default' : 'pointer';
    };

    try {
      if (editId) {
        // ── EDIT MODE ──────────────────────────────────────────
        // Login is tied to the existing Auth account, so email/phone are
        // metadata here, not re-provisioned. Permissions and role/status
        // update freely.
        if (!email && !phone) { alert(t('sa_pu_err_contact_required', 'Email yoki telefon raqamidan birini kiriting')); return; }

        const newPassword = document.getElementById('puNewPasswordInput')?.value || '';
        if (newPassword && newPassword.length < 6) {
          alert(t('sa_pu_err_weak_password', 'Parol juda oddiy (kamida 6 ta belgi)'));
          return;
        }

        setBusy(true);

        if (newPassword) {
          // Changing another user's password from the client SDK requires
          // authenticating AS that user first (signInWithEmailAndPassword),
          // then calling updatePassword on that session. We do this on the
          // isolated secondary Auth instance so it never touches the
          // SuperAdmin's own session. This only works if we know that
          // user's *current* password, which we don't store — so this path
          // is intentionally left as a clear, explicit failure pointing at
          // the real fix (a server-side Admin SDK reset) rather than
          // silently pretending to succeed.
          setBusy(false);
          alert(t('sa_pu_err_password_change_needs_backend',
            "Boshqa xodimning parolini brauzerdan bevosita almashtirib bo'lmaydi (Firebase xavfsizlik cheklovi). " +
            "Buning uchun server tomonda (Cloud Function / Admin SDK) alohida 'parolni tiklash' funksiyasi kerak. " +
            "Hozircha xodimga parolni unutganini bildirib, login ekranidagi 'parolni tiklash' havolasidan foydalanishni so'rang."));
          return;
        }

        const payload = { name, email, phone, role, status, note, permissions };
        await update(ref(window.db, `systemData/platformUsers/${editId}`), payload);
        window.logAudit && window.logAudit('platform_user_update', name, t('sa_pu_log_updated', "Platform xodimi ma'lumotlari yangilandi"));
        window.puCloseModal();

      } else {
        // ── CREATE MODE ────────────────────────────────────────
        // A real login requires a real Firebase Auth account. Auth needs
        // email+password (no phone-only path wired up here), so email is
        // mandatory when creating — phone stays optional contact info.
        const password = document.getElementById('puPasswordInput')?.value || '';
        if (!email) { alert(t('sa_pu_err_email_required_for_login', "Login uchun email kiriting")); return; }
        if (!password || password.length < 6) {
          alert(t('sa_pu_err_weak_password', 'Parol juda oddiy (kamida 6 ta belgi)'));
          return;
        }

        setBusy(true);

        // Create the Auth account on the SECONDARY app instance so this
        // never disturbs the SuperAdmin's own signed-in session.
        const cred = await createUserWithEmailAndPassword(_puSecondaryAuth, email, password);
        const newUid = cred.user.uid;

        const payload = {
          name, email, phone, role, status, note, permissions,
          createdAt: Date.now(),
          lastActiveAt: null,
        };
        await set(ref(window.db, `systemData/platformUsers/${newUid}`), payload);

        // Clean up: the secondary instance is now signed in as the new
        // user. Sign it out so it's inert until next use.
        await _puSecondaryAuth.signOut();

        window.logAudit && window.logAudit('platform_user_create', name, t('sa_pu_log_created', 'Yangi platform xodimi qo\'shildi'));
        window.puCloseModal();
      }
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + _puAuthErrorText(error));
      // If Auth account creation succeeded but the DB write somehow failed,
      // we deliberately do NOT auto-delete the Auth account here — surfacing
      // the error and letting the superadmin retry (which will now correctly
      // fail with auth/email-already-in-use) is safer than silent cleanup
      // that could race with a slow network response.
    } finally {
      setBusy(false);
    }
  };

  window.puDelete = async function (uid) {
    const u = window.allPlatformUsers?.[uid];
    if (!u) return;
    // IMPORTANT: this removes the platformUsers/{uid} record only. It does
    // NOT delete the person's Firebase Auth account — the client SDK
    // cannot delete another user's Auth account (that needs the Admin SDK
    // server-side). So without also suspending them (see puToggleStatus),
    // a "deleted" person could still authenticate; they'd just be gone
    // from this list and lose whatever this app gates on that record. Make
    // that explicit rather than implying a full account removal.
    if (!confirm(
      t('sa_pu_confirm_delete', "Xodimni o'chirmoqchimisiz? Bu amalni bekor qilib bo'lmaydi.") + `\n\n${u.name}\n\n` +
      t('sa_pu_confirm_delete_auth_note', "Eslatma: bu faqat ro'yxatdan o'chiradi. Xodimning login hisobi (Firebase Auth) alohida o'chirilishi kerak \u2014 aks holda u hali ham login qila oladi.")
    )) return;

    try {
      await remove(ref(window.db, `systemData/platformUsers/${uid}`));
      window.logAudit && window.logAudit('platform_user_delete', u.name || uid, t('sa_pu_log_deleted', "Platform xodimi o'chirildi"));
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + (error?.message || ''));
    }
  };

  window.puToggleStatus = async function (uid) {
    const u = window.allPlatformUsers?.[uid];
    if (!u) return;
    const newStatus = u.status === 'suspended' ? 'active' : 'suspended';
    try {
      await update(ref(window.db, `systemData/platformUsers/${uid}`), { status: newStatus });
      window.logAudit && window.logAudit('platform_user_status', u.name || uid,
        newStatus === 'suspended' ? t('sa_pu_log_suspended', 'Xodim bloklandi') : t('sa_pu_log_activated', 'Xodim faollashtirildi'));
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + (error?.message || ''));
    }
  };

  // ─────────────────────────────────────────────────────────
  // Nav hook: start listener when Platform Users section first opened
  // ─────────────────────────────────────────────────────────
  let _puListenerStarted = false;
  function _puAttachNavHook() {
    document.querySelectorAll('.sidebar-nav a[href="#platformusers"]').forEach(link => {
      link.addEventListener('click', () => {
        if (!_puListenerStarted) {
          _puListenerStarted = true;
          window.listenPlatformUsers();
        } else {
          window.puRenderList();
          window.puUpdateStats();
        }
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _puAttachNavHook);
  else _puAttachNavHook();

})();

// ═══════════════════════════════════════════════════════════════════
// SECURITY CENTER MODULE
// Login history, active sessions, TOTP-based 2FA, and device tracking.
//
// Firebase paths:
//   systemData/loginHistory/{entryId}            — append-only login log
//     { uid, name, email, result: 'success'|'failed', deviceLabel,
//       browser, os, deviceId, timestamp }
//   systemData/activeSessions/{sessionId}         — one row per open session
//     { uid, name, email, deviceLabel, browser, os, deviceId,
//       startedAt, lastSeenAt }
//   systemData/platformUsers/{uid}/twoFactor      — TOTP state
//     { enabled, secret, enabledAt }
//   systemData/twoFactorSuperAdmin (for the superadmin account itself,
//     which isn't a systemData/platformUsers entry)
//     { enabled, secret, enabledAt }
//
// ⚠️ SECURITY NOTE: this app has no backend server (Firebase RTDB +
// vanilla JS only), so the TOTP secret is generated and verified
// entirely client-side and stored in RTDB. This gives real, working
// 2FA (a code from Google Authenticator is genuinely required to
// disable/re-enable it) but is not equivalent to server-verified MFA
// — anyone with direct database read access could read the secret,
// and someone control ling their own browser console could bypass the
// client-side check. Hardening this later requires a Cloud Function
// (or similar backend) to store the secret and verify codes server-side.
//
// IP address tracking was intentionally left out (would require an
// external API call from the browser); device/browser info is derived
// from navigator.userAgent plus a stable per-browser deviceId kept in
// localStorage.
// ═══════════════════════════════════════════════════════════════════
(function () {
  window.allLoginHistory = window.allLoginHistory || {};
  window.allActiveSessions = window.allActiveSessions || {};

  const SC_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min inactivity = session considered stale
  const SC_HEARTBEAT_MS = 60 * 1000; // update lastSeenAt every 60s while tab is open

  let _scCurrentSessionId = null;
  let _scHeartbeatTimer = null;
  let _scListenersStarted = false;
  let _scPendingSecret = null; // OTPAuth.Secret currently shown in the setup modal (not yet confirmed)
  let _scPendingIsSuperAdmin = false;

  // ─────────────────────────────────────────────────────────
  // Device / browser fingerprint (no external IP lookup)
  // ─────────────────────────────────────────────────────────
  function _scGetDeviceId() {
    let id = localStorage.getItem('nesta_deviceId');
    if (!id) {
      id = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('nesta_deviceId', id);
    }
    return id;
  }

  function _scParseUserAgent() {
    const ua = navigator.userAgent || '';
    let browser = t('sa_unknown_browser', "Noma'lum brauzer");
    if (/Edg\//.test(ua)) browser = 'Microsoft Edge';
    else if (/OPR\//.test(ua)) browser = 'Opera';
    else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';
    else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';

    let os = t('sa_sc_unknown_system', "Noma'lum tizim");
    if (/Windows/.test(ua)) os = 'Windows';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Linux/.test(ua)) os = 'Linux';

    const isMobile = /Mobi|Android|iPhone|iPad/.test(ua);
    const deviceLabel = `${browser} · ${os}${isMobile ? ' 📱' : ' 🖥️'}`;

    return { browser, os, isMobile, deviceLabel };
  }

  // ─────────────────────────────────────────────────────────
  // RBAC helper: can the current viewer see everyone's sessions,
  // or only their own?
  // ─────────────────────────────────────────────────────────
  function _scCurrentViewerId() {
    return (auth?.currentUser?.uid) || localStorage.getItem('uid') || null;
  }

  function _scCanViewAll() {
    if (localStorage.getItem('role') === 'superadmin') return true;
    const uid = _scCurrentViewerId();
    const me = uid ? window.allPlatformUsers?.[uid] : null;
    return !!(me && me.permissions && me.permissions.canViewAllSessions);
  }

  // ─────────────────────────────────────────────────────────
  // Login history logging (call this from the auth listener)
  // ─────────────────────────────────────────────────────────
  // P0-2 systemData-regression fix: systemData/loginHistory is no longer
  // client-writable directly (see database.rules.json) — this fires once
  // per dashboard page load (confirmed in the reported console errors), so
  // it's replaced with a POST to backend/routes/superadminDashboard.js
  // (Admin-SDK-backed, requireSuperAdmin-gated; uid/email there are taken
  // from the verified token, not trusted from this payload). NOTE:
  // scStartSession()/scHeartbeat() just below (systemData/activeSessions)
  // are a separate write path onto the same systemData root and are
  // ALSO now denied by the same rule — left as-is for this fix (each
  // already fails safely inside its own try/catch and doesn't block
  // anything else) and called out explicitly in this fix's report as a
  // remaining issue, not silently swept under this change.
  window.scLogLogin = async function (result, user) {
    try {
      const { browser, os, deviceLabel } = _scParseUserAgent();
      const deviceId = _scGetDeviceId();
      const name = user?.displayName || user?.email || localStorage.getItem('name') || 'SuperAdmin';
      const email = user?.email || localStorage.getItem('email') || null;
      const uid = user?.uid || localStorage.getItem('uid') || 'unknown';

      await _saDashFetch('/login-history', {
        method: 'POST',
        body: JSON.stringify({ name, email, result, browser, os, deviceLabel, deviceId }),
      });

      if (result === 'success') {
        window.scStartSession(uid, name, email, { browser, os, deviceLabel, deviceId });
      }
    } catch (err) {
      console.error(t('sa_sc_err_login_log', 'Login tarixini yozishda xato:'), err);
    }
  };

  // ─────────────────────────────────────────────────────────
  // Active session tracking
  // ─────────────────────────────────────────────────────────
  // Superadmin systemData migration, Stage 2: systemData/activeSessions is
  // no longer client-writable/readable directly (see database.rules.json)
  // — start/heartbeat/terminate now go through backend/routes/
  // superadminSessions.js (Admin-SDK-backed, requireSuperAdmin-gated; uid
  // there is taken from the verified token, not this function's own `uid`
  // param — that param is kept only because scLogLogin() still passes it
  // for the (unchanged) localStorage/UI bookkeeping below).
  window.scStartSession = async function (uid, name, email, deviceInfo) {
    try {
      const { sessionId } = await _saSessionsFetch('/active-sessions/start', {
        method: 'POST',
        body: JSON.stringify({
          name, email,
          browser: deviceInfo.browser,
          os: deviceInfo.os,
          deviceLabel: deviceInfo.deviceLabel,
          deviceId: deviceInfo.deviceId,
        }),
      });
      _scCurrentSessionId = sessionId;
      localStorage.setItem('nesta_sessionId', _scCurrentSessionId);

      if (_scHeartbeatTimer) clearInterval(_scHeartbeatTimer);
      _scHeartbeatTimer = setInterval(window.scHeartbeat, SC_HEARTBEAT_MS);

      window.addEventListener('beforeunload', () => {
        // Best-effort; a fetch() this late in page teardown isn't
        // guaranteed to complete either, stale sessions are also filtered
        // out client-side via SC_SESSION_TIMEOUT_MS.
        if (_scCurrentSessionId) {
          navigator.sendBeacon && navigator.sendBeacon; // no-op placeholder, kept as-is (unchanged from before this fix)
        }
      });
    } catch (err) {
      console.error(t('sa_sc_err_session_start', 'Sessiya yaratishda xato:'), err);
    }
  };

  window.scHeartbeat = async function () {
    if (!_scCurrentSessionId) return;
    try {
      await _saSessionsFetch(`/active-sessions/${encodeURIComponent(_scCurrentSessionId)}/heartbeat`, { method: 'POST' });
    } catch (err) { /* silent — non-critical, matches previous behavior */ }
  };

  window.scEndSession = async function () {
    if (!_scCurrentSessionId) return;
    try {
      await _saSessionsFetch(`/active-sessions/${encodeURIComponent(_scCurrentSessionId)}`, { method: 'DELETE' });
    } catch (err) { /* silent */ }
    if (_scHeartbeatTimer) clearInterval(_scHeartbeatTimer);
    _scCurrentSessionId = null;
    localStorage.removeItem('nesta_sessionId');
  };

  // Force-terminate another session (e.g. from the Sessions tab)
  window.scTerminateSession = async function (sessionId) {
    if (!confirm(t('sa_sc_confirm_terminate', 'Ushbu sessiyani tugatmoqchimisiz?'))) return;
    try {
      await _saSessionsFetch(`/active-sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      window.logAudit && window.logAudit('session_terminate', sessionId, t('sa_sc_log_session_terminated', 'Sessiya majburiy tugatildi'));
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + (error?.message || ''));
    }
  };

  // ─────────────────────────────────────────────────────────
  // Backend polling (replaces the two onValue() listeners — systemData is
  // no longer client-readable at all; see the module header above)
  // ─────────────────────────────────────────────────────────
  window.scStartListeners = function () {
    if (_scListenersStarted) return;
    _scListenersStarted = true;

    _saStartDashPoll('/login-history', (data) => {
      window.allLoginHistory = data && Object.keys(data).length ? data : {};
      window.scUpdateStats();
      window.scRenderLoginHistory();
    });

    _saStartSessionsPoll('/active-sessions', (data) => {
      window.allActiveSessions = data && Object.keys(data).length ? data : {};
      window.scUpdateStats();
      window.scRenderSessions();
      window.scRenderDevices();
    });
  };

  // ─────────────────────────────────────────────────────────
  // Visible-to-me filtering (RBAC)
  // ─────────────────────────────────────────────────────────
  function _scVisibleLoginEntries() {
    const entries = Object.entries(window.allLoginHistory || {});
    if (_scCanViewAll()) return entries;
    const myUid = _scCurrentViewerId();
    return entries.filter(([, e]) => e.uid === myUid);
  }

  function _scVisibleSessions() {
    const entries = Object.entries(window.allActiveSessions || {});
    const fresh = entries.filter(([, s]) => (Date.now() - (s.lastSeenAt || s.startedAt || 0)) < SC_SESSION_TIMEOUT_MS);
    if (_scCanViewAll()) return fresh;
    const myUid = _scCurrentViewerId();
    return fresh.filter(([, s]) => s.uid === myUid);
  }

  // ─────────────────────────────────────────────────────────
  // Stat cards
  // ─────────────────────────────────────────────────────────
  window.scUpdateStats = function () {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const loginEntries = _scVisibleLoginEntries();

    const loginsToday = loginEntries.filter(([, e]) => e.result === 'success' && e.timestamp >= startOfDay.getTime()).length;
    const failedLast24h = loginEntries.filter(([, e]) => e.result === 'failed' && e.timestamp >= (Date.now() - 24 * 3600 * 1000)).length;
    const activeSessionsCount = _scVisibleSessions().length;

    const platformUsersList = Object.values(window.allPlatformUsers || {});
    const twofaEnabledCount = platformUsersList.filter(u => u.twoFactor?.enabled).length
      + (window._scSuperAdmin2fa?.enabled ? 1 : 0);

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('scLoginsToday', loginsToday);
    setEl('scActiveSessions', activeSessionsCount);
    setEl('sc2faEnabled', twofaEnabledCount);
    setEl('scFailedLogins', failedLast24h);
  };

  // ─────────────────────────────────────────────────────────
  // Tab switching
  // ─────────────────────────────────────────────────────────
  window.scSwitchTab = function (tabName) {
    document.querySelectorAll('.sc-tab-panel').forEach(p => p.style.display = 'none');
    const panel = document.getElementById('scTab_' + tabName);
    if (panel) panel.style.display = 'block';

    document.querySelectorAll('.sc-tab-btn').forEach(b => {
      const active = b.dataset.scTab === tabName;
      b.style.borderBottomColor = active ? '#2563eb' : 'transparent';
      b.style.color = active ? '#2563eb' : '#6b7280';
    });

    if (tabName === 'twofa') window.scRefresh2faView();
    if (tabName === 'devices') window.scRenderDevices();
  };

  // ─────────────────────────────────────────────────────────
  // Reset all login history filters
  // ─────────────────────────────────────────────────────────
  window.scResetLoginFilters = function () {
    const search = document.getElementById('scLoginSearchInput');
    const date = document.getElementById('scLoginDateFilter');
    const result = document.getElementById('scLoginResultFilter');
    if (search) search.value = '';
    if (date) date.value = '';
    if (result) result.value = '';
    window.scRenderLoginHistory();
  };

  // ─────────────────────────────────────────────────────────
  // Login History tab render
  // ─────────────────────────────────────────────────────────
  window.scRenderLoginHistory = function () {
    const body = document.getElementById('scLoginHistoryBody');
    if (!body) return;

    const query = (document.getElementById('scLoginSearchInput')?.value || '').toLowerCase().trim();
    const resultFilter = document.getElementById('scLoginResultFilter')?.value || '';
    const dateFilter = document.getElementById('scLoginDateFilter')?.value || '';

    let entries = _scVisibleLoginEntries();
    if (query) {
      entries = entries.filter(([, e]) =>
        (e.name || '').toLowerCase().includes(query) || (e.email || '').toLowerCase().includes(query));
    }
    if (resultFilter) entries = entries.filter(([, e]) => e.result === resultFilter);
    if (dateFilter) {
      entries = entries.filter(([, e]) => {
        if (!e.timestamp) return false;
        const d = new Date(e.timestamp);
        const local = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        return local === dateFilter;
      });
    }

    entries.sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));
    entries = entries.slice(0, 200); // cap render for very large logs

    if (!entries.length) {
      body.innerHTML = `<tr><td colspan="5" style="padding:30px; text-align:center; color:#94a3b8;">${t('sa_sc_login_none_found', "Yozuvlar topilmadi")}</td></tr>`;
      return;
    }

    body.innerHTML = entries.map(([, e]) => {
      const dot = e.result === 'success'
        ? `<span title="${t('sa_sc_filter_success', 'Muvaffaqiyatli')}" style="display:inline-block; width:10px; height:10px; border-radius:50%; background:#22c55e;"></span>`
        : `<span title="${t('sa_sc_filter_failed', 'Muvaffaqiyatsiz')}" style="display:inline-block; width:10px; height:10px; border-radius:50%; background:#ef4444;"></span>`;
      return `
        <tr style="border-top:1px solid #f1f5f9;">
          <td style="padding:12px 16px; font-weight:700; color:#111827;">
            ${escapeHtml(e.name || '—')}
            ${e.email ? `<div style="font-size:11px; color:#9ca3af; font-weight:500;">${escapeHtml(e.email)}</div>` : ''}
          </td>
          <td style="padding:12px 16px; color:#6b7280; font-size:12px; white-space:nowrap;">${new Date(e.timestamp).toLocaleString('ru-RU')}</td>
          <td style="padding:12px 16px; color:#6b7280; font-size:12px; white-space:nowrap;">${escapeHtml(e.ip || '—')}</td>
          <td style="padding:12px 16px; color:#374151; font-size:13px;">${escapeHtml(e.deviceLabel || '—')}</td>
          <td style="padding:12px 16px;">${dot}</td>
        </tr>`;
    }).join('');
  };

  // ─────────────────────────────────────────────────────────
  // Sessions tab render
  // ─────────────────────────────────────────────────────────
  window.scRenderSessions = function () {
    const body = document.getElementById('scSessionsBody');
    if (!body) return;

    const sessions = _scVisibleSessions().sort((a, b) => (b[1].lastSeenAt || 0) - (a[1].lastSeenAt || 0));

    if (!sessions.length) {
      body.innerHTML = `<tr><td colspan="7" style="padding:30px; text-align:center; color:#94a3b8;">${t('sa_sc_sessions_none', "Faol sessiyalar yo'q")}</td></tr>`;
      return;
    }

    body.innerHTML = sessions.map(([sid, s]) => {
      const isThisDevice = s.deviceId === _scGetDeviceId() && sid === _scCurrentSessionId;
      const roleLabel = s.role || (window.allPlatformUsers?.[s.uid]?.role) || (s.uid === localStorage.getItem('uid') ? localStorage.getItem('role') : '') || '—';
      return `
        <tr style="border-top:1px solid #f1f5f9;">
          <td style="padding:12px 16px; font-weight:700; color:#111827;">
            ${escapeHtml(s.name || '—')}
            ${isThisDevice ? `<span style="margin-left:6px; background:#dbeafe; color:#2563eb; padding:2px 8px; border-radius:20px; font-size:10px; font-weight:700;">${t('sa_sc_this_device', 'Shu qurilma')}</span>` : ''}
          </td>
          <td style="padding:12px 16px; color:#374151; font-size:13px;">${escapeHtml(roleLabel)}</td>
          <td style="padding:12px 16px; color:#374151; font-size:13px;">${escapeHtml(s.deviceLabel || '—')}</td>
          <td style="padding:12px 16px; color:#6b7280; font-size:12px; white-space:nowrap;">${escapeHtml(s.ip || '—')}</td>
          <td style="padding:12px 16px; color:#6b7280; font-size:12px; white-space:nowrap;">${new Date(s.startedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</td>
          <td style="padding:12px 16px;">
            <span style="display:inline-flex; align-items:center; gap:6px; color:#16a34a; font-size:12px; font-weight:600;">
              <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#22c55e;"></span>
              ${t('sa_sc_status_online', 'Online')}
            </span>
          </td>
          <td style="padding:12px 16px; text-align:right;">
            <button onclick="window.scTerminateSession('${sid}')" title="${t('sa_sc_action_terminate', 'Tugatish')}"
              style="background:#fef2f2; color:#dc2626; border:none; border-radius:8px; padding:6px 10px; cursor:pointer; font-size:12px; font-weight:600;">
              <i class="fa-solid fa-power-off"></i> ${t('sa_sc_action_terminate', 'Tugatish')}
            </button>
          </td>
        </tr>`;
    }).join('');
  };

  // Bulk-terminate every active session except the caller's own SuperAdmin session
  window.scTerminateAllSessions = async function () {
    if (!confirm(t('sa_sc_confirm_terminate_all', "Barcha sessiyalarni (SuperAdmindan tashqari) tugatmoqchimisiz?"))) return;
    try {
      const sessions = _scVisibleSessions();
      const myUid = _scCurrentViewerId();
      const isSuperAdmin = localStorage.getItem('role') === 'superadmin';
      const targets = sessions.filter(([, s]) => !(isSuperAdmin && s.uid === myUid));
      await Promise.all(targets.map(([sid]) => _saSessionsFetch(`/active-sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' })));
      window.logAudit && window.logAudit('session_terminate_all', '', t('sa_sc_log_sessions_terminated_all', 'Barcha sessiyalar majburiy tugatildi'));
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + (error?.message || ''));
    }
  };

  // ─────────────────────────────────────────────────────────
  // Devices tab render — table layout with click-through detail drawer
  // ─────────────────────────────────────────────────────────
  window._scDisabledMap = {};  // cached for drawer access

  function _scRelativeTime(ts) {
    if (!ts) return '—';
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    const h = Math.floor(diff / 3600000);
    const d = Math.floor(diff / 86400000);
    if (m < 1)  return t('sa_sc_time_now', 'Hozirgina');
    if (m < 60) return t('sa_sc_time_mins_ago', '{mins} daqiqa oldin').replace('{mins}', m);
    if (h < 24) return t('sa_sc_time_hours_ago', '{hours} soat oldin').replace('{hours}', h);
    if (d === 1) return t('sa_sc_time_yesterday', 'Kecha');
    if (d < 7)  return t('sa_sc_time_days_ago', '{days} kun oldin').replace('{days}', d);
    return new Date(ts).toLocaleDateString('ru-RU');
  }

  function _scDeviceIcon(d) {
    const label = d.deviceLabel || '';
    if (/📱/.test(label) || /iphone|ipad|android/i.test(d.os || ''))
      return 'fa-mobile-screen-button';
    if (/mac/i.test(d.os || '')) return 'fa-laptop';
    return 'fa-desktop';
  }

  function _scStatusBadge(isDisabled, isOffline) {
    if (isDisabled) return `<span style="display:inline-flex;align-items:center;gap:4px;background:#fee2e2;color:#dc2626;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;"><span style="width:6px;height:6px;border-radius:50%;background:#dc2626;display:inline-block;"></span>${t('sa_sc_status_blocked', 'Bloklangan')}</span>`;
    if (isOffline)  return `<span style="display:inline-flex;align-items:center;gap:4px;background:#f3f4f6;color:#6b7280;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;"><span style="width:6px;height:6px;border-radius:50%;background:#9ca3af;display:inline-block;"></span>${t('sa_sc_status_offline', 'Offline')}</span>`;
    return `<span style="display:inline-flex;align-items:center;gap:4px;background:#dcfce7;color:#16a34a;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;"><span style="width:6px;height:6px;border-radius:50%;background:#16a34a;display:inline-block;"></span>${t('sa_sc_status_active', 'Faol')}</span>`;
  }

  function _scBrowserIcon(browser) {
    if (!browser) return 'fa-globe';
    const b = browser.toLowerCase();
    if (b.includes('chrome'))  return 'fa-brands fa-chrome';
    if (b.includes('safari'))  return 'fa-brands fa-safari';
    if (b.includes('firefox')) return 'fa-brands fa-firefox-browser';
    if (b.includes('edge'))    return 'fa-brands fa-edge';
    return 'fa-globe';
  }

  window.scRenderDevices = async function () {
    const tbody = document.getElementById('scDevicesTableBody');
    if (!tbody) return;

    const searchQ = (document.getElementById('scDeviceSearch')?.value || '').toLowerCase();
    const filterV = document.getElementById('scDeviceFilter')?.value || 'all';

    const sessions = _scVisibleSessions();
    const byDevice = {};
    sessions.forEach(([sid, s]) => {
      const key = s.deviceId || sid;
      if (!byDevice[key]) byDevice[key] = { ...s, sessionIds: [] };
      byDevice[key].sessionIds.push(sid);
      if ((s.lastSeenAt || 0) > (byDevice[key].lastSeenAt || 0)) byDevice[key].lastSeenAt = s.lastSeenAt;
      if ((s.startedAt  || 0) < (byDevice[key].startedAt  || Infinity)) byDevice[key].startedAt = s.startedAt;
    });

    let disabledMap = {};
    try {
      disabledMap = await _saSessionsFetch('/disabled-devices');
    } catch (e) { disabledMap = {}; }
    window._scDisabledMap = disabledMap;

    Object.entries(disabledMap).forEach(([deviceId, d]) => {
      if (!byDevice[deviceId]) {
        byDevice[deviceId] = { ...d, sessionIds: [], _noActiveSession: true };
      }
    });

    const SC_OFFLINE_MS = 5 * 60 * 1000; // 5 min without heartbeat = offline
    let entries = Object.entries(byDevice).map(([deviceId, d]) => {
      const isDisabled  = !!disabledMap[deviceId];
      const isOffline   = !isDisabled && d._noActiveSession;
      const isActive    = !isDisabled && !isOffline;
      const lastLogin   = d.startedAt   || d.lastSeenAt;
      const lastActive  = d.lastSeenAt;
      return { deviceId, d, isDisabled, isOffline, isActive, lastLogin, lastActive };
    });

    // Filter
    if (filterV !== 'all') {
      entries = entries.filter(e => {
        if (filterV === 'active')   return e.isActive;
        if (filterV === 'offline')  return e.isOffline;
        if (filterV === 'disabled') return e.isDisabled;
        return true;
      });
    }
    if (searchQ) {
      entries = entries.filter(({ d }) => {
        const hay = [d.name, d.email, d.os, d.browser, d.deviceLabel, d.deviceId].join(' ').toLowerCase();
        return hay.includes(searchQ);
      });
    }

    // Sort: active first, then offline, then disabled, then by lastLogin desc
    entries.sort((a, b) => {
      const rank = x => x.isActive ? 0 : x.isOffline ? 1 : 2;
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (b.lastLogin || 0) - (a.lastLogin || 0);
    });

    const countEl = document.getElementById('scDeviceCount');
    if (countEl) countEl.textContent = `${entries.length} ${t('sa_sc_device_count_suffix', 'ta qurilma')}`;

    if (!entries.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="padding:40px; text-align:center; color:#94a3b8;">
        <div style="font-size:32px; margin-bottom:8px;">📵</div>
        <div style="font-weight:600;">${t('sa_sc_no_devices', 'Qurilmalar topilmadi')}</div>
        <div style="font-size:12px; margin-top:4px;">${t('sa_sc_no_devices_hint', "Filtr yoki qidiruvni o'zgartiring")}</div>
      </td></tr>`;
      return;
    }

    tbody.innerHTML = entries.map(({ deviceId, d, isDisabled, isOffline, isActive, lastLogin }) => {
      const icon      = _scDeviceIcon(d);
      const bIcon     = _scBrowserIcon(d.browser);
      const badge     = _scStatusBadge(isDisabled, isOffline);
      const devLabel  = d.deviceLabel ? d.deviceLabel.replace(/[📱🖥️]/g, '').trim() : (d.os || '—');
      const userName  = escapeHtml(d.name || d.email || '—');
      const userEmail = escapeHtml(d.email || '');
      const sessionJson = JSON.stringify(d.sessionIds || []).replace(/"/g, '&quot;');

      return `<tr class="sc-dev-row" onclick="window.scOpenDeviceDrawer('${deviceId}')">
        <td style="padding:12px 16px;">
          <div style="font-weight:600; color:#111827; font-size:13px;">${userName}</div>
          <div style="font-size:11px; color:#9ca3af; margin-top:1px;">${userEmail}</div>
        </td>
        <td style="padding:12px 16px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <div style="width:30px; height:30px; border-radius:8px; background:#eff6ff; color:#2563eb; display:flex; align-items:center; justify-content:center; font-size:13px; flex-shrink:0;">
              <i class="fa-solid ${icon}"></i>
            </div>
            <div>
              <div style="font-weight:500; color:#374151; font-size:12px;">${escapeHtml(devLabel)}</div>
            </div>
          </div>
        </td>
        <td style="padding:12px 16px;">
          <div style="display:flex; align-items:center; gap:6px; color:#374151; font-size:12px;">
            <i class="${bIcon}" style="color:#6b7280;"></i> ${escapeHtml(d.browser || '—')}
          </div>
        </td>
        <td style="padding:12px 16px; color:#374151; font-size:12px;">${escapeHtml(d.os || '—')}</td>
        <td style="padding:12px 16px; color:#374151; font-size:12px;">${_scRelativeTime(lastLogin)}</td>
        <td style="padding:12px 16px;">${badge}</td>
        <td style="padding:12px 16px;" onclick="event.stopPropagation()">
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            ${!isDisabled ? `<button onclick="window.scDeviceForceLogout('${deviceId}', '${sessionJson}')"
              style="background:#fef2f2; color:#dc2626; border:none; border-radius:7px; padding:5px 10px; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap; ${d._noActiveSession ? 'opacity:.45; pointer-events:none;' : ''}">
              <i class="fa-solid fa-right-from-bracket"></i> ${t('sa_sc_dw_force_logout', 'Force Logout')}</button>` : ''}
            <button onclick="window.scDeviceToggleDisable('${deviceId}', ${isDisabled})"
              style="background:${isDisabled ? '#f0fdf4' : '#fff7ed'}; color:${isDisabled ? '#16a34a' : '#c2410c'}; border:none; border-radius:7px; padding:5px 10px; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap;">
              <i class="fa-solid ${isDisabled ? 'fa-lock-open' : 'fa-ban'}"></i> ${isDisabled ? t('sa_sc_enable', 'Enable') : t('sa_sc_disable', 'Disable')}</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  };

  // ─────────────────────────────────────────────────────────
  // Device Detail Drawer
  // ─────────────────────────────────────────────────────────
  function _scDwRow(label, value, valueStyle) {
    return `<div style="display:flex; align-items:center; justify-content:space-between; padding:9px 0; border-bottom:1px solid #f3f4f6;">
      <span style="font-size:12px; color:#6b7280;">${label}</span>
      <span style="font-size:12px; font-weight:600; color:${valueStyle || '#111827'}; max-width:55%; text-align:right; word-break:break-all;">${value}</span>
    </div>`;
  }

  window.scOpenDeviceDrawer = function (deviceId) {
    const sessions = _scVisibleSessions();
    const byDevice = {};
    sessions.forEach(([sid, s]) => {
      const key = s.deviceId || sid;
      if (!byDevice[key]) byDevice[key] = { ...s, sessionIds: [] };
      byDevice[key].sessionIds.push(sid);
      if ((s.lastSeenAt || 0) > (byDevice[key].lastSeenAt || 0)) byDevice[key].lastSeenAt = s.lastSeenAt;
      if ((s.startedAt  || 0) < (byDevice[key].startedAt  || Infinity)) byDevice[key].startedAt = s.startedAt;
    });

    const disabledMap = window._scDisabledMap || {};
    // Also check disabled devices with no active session
    let d = byDevice[deviceId];
    if (!d && disabledMap[deviceId]) d = { ...disabledMap[deviceId], sessionIds: [], _noActiveSession: true };
    if (!d) return;

    const isDisabled   = !!disabledMap[deviceId];
    const isOffline    = !isDisabled && d._noActiveSession;
    const isActive     = !isDisabled && !isOffline;
    const isMobile     = /📱/.test(d.deviceLabel || '') || /iphone|ipad|android/i.test(d.os || '');
    const icon         = _scDeviceIcon(d);
    const devLabel     = (d.deviceLabel || d.os || t('sa_sc_dw_unknown_device', 'Unknown Device')).replace(/[📱🖥️]/g, '').trim();
    const sessionIds   = d.sessionIds || [];

    // Gather user 2FA status
    const uid = d.uid || '';
    const users = window.allPlatformUsers || {};
    const twoFA = uid && users[uid] ? (users[uid].twoFactor?.enabled ? '✅ ' + t('sa_sc_dw_2fa_on', 'Yoqilgan') : '❌ ' + t('sa_sc_dw_2fa_off', "O'chirilgan")) : '—';

    // header
    const iconEl     = document.getElementById('scDwIcon');
    const titleEl    = document.getElementById('scDwTitle');
    const subtitleEl = document.getElementById('scDwSubtitle');
    if (iconEl) { iconEl.innerHTML = `<i class="fa-solid ${icon}"></i>`; iconEl.style.background = isDisabled ? '#fee2e2' : '#eff6ff'; iconEl.style.color = isDisabled ? '#dc2626' : '#2563eb'; }
    if (titleEl) titleEl.textContent = devLabel;
    if (subtitleEl) subtitleEl.textContent = escapeHtml(d.name || d.email || t('sa_sc_dw_unknown_user', "Noma'lum foydalanuvchi"));

    // Info rows
    const infoEl = document.getElementById('scDwInfoRows');
    if (infoEl) infoEl.innerHTML =
      _scDwRow(t('sa_sc_dw_device_name', 'Device Name'), escapeHtml(devLabel)) +
      _scDwRow(t('sa_sc_dw_os', 'Operating System'), escapeHtml(d.os || '—')) +
      _scDwRow(t('sa_sc_dw_browser', 'Browser'), escapeHtml(d.browser || '—')) +
      _scDwRow(t('sa_sc_dw_screen_res', 'Screen Resolution'), '—') +
      _scDwRow(t('sa_sc_dw_language', 'Language'), '—') +
      _scDwRow(t('sa_sc_dw_timezone', 'Timezone'), Intl.DateTimeFormat().resolvedOptions().timeZone || '—');

    // Session rows
    const sessEl = document.getElementById('scDwSessionRows');
    const remember = '—'; // not stored in current data model
    if (sessEl) sessEl.innerHTML =
      _scDwRow(t('sa_sc_dw_first_login', 'First Login'), d.startedAt ? new Date(d.startedAt).toLocaleString('ru-RU') : '—') +
      _scDwRow(t('sa_sc_dw_last_login', 'Last Login'), d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString('ru-RU') : '—') +
      _scDwRow(t('sa_sc_dw_current_session', 'Current Session'), sessionIds.length ? `${sessionIds.length} ${t('sa_sc_dw_active_count_suffix', 'ta aktiv')}` : t('sa_sc_dw_none', "Yo'q"), sessionIds.length ? '#16a34a' : '#6b7280') +
      _scDwRow(t('sa_sc_dw_remember_device', 'Remember Device'), remember);

    // Security rows
    const secEl = document.getElementById('scDwSecRows');
    if (secEl) secEl.innerHTML =
      _scDwRow(t('sa_sc_dw_2fa_enabled', '2FA Enabled'), twoFA) +
      _scDwRow(t('sa_sc_dw_device_id', 'Device ID'), `<span style="font-family:monospace; font-size:10px;">${deviceId.slice(0, 16)}…</span>`, '#6b7280') +
      _scDwRow(t('sa_sc_dw_status', 'Status'), isDisabled ? '🔴 ' + t('sa_sc_status_blocked', 'Bloklangan') : isOffline ? '⚪ ' + t('sa_sc_status_offline', 'Offline') : '🟢 ' + t('sa_sc_status_active', 'Faol'));

    // Action buttons
    const actEl = document.getElementById('scDwActions');
    const sessionJson = JSON.stringify(sessionIds).replace(/"/g, '&quot;');
    if (actEl) actEl.innerHTML = `
      <button onclick="window.scCloseDeviceDrawer(); window.scDeviceLogout('${sessionJson}')" ${!sessionIds.length ? 'disabled' : ''}
        style="width:100%; background:${sessionIds.length ? '#f3f4f6' : '#f9fafb'}; color:${sessionIds.length ? '#374151' : '#9ca3af'}; border:none; border-radius:10px; padding:11px 16px; font-size:13px; font-weight:700; cursor:${sessionIds.length ? 'pointer' : 'not-allowed'}; display:flex; align-items:center; justify-content:center; gap:8px;">
        <i class="fa-solid fa-right-from-bracket"></i> ${t('sa_sc_dw_logout_device', 'Logout Device')}
      </button>
      <button onclick="window.scCloseDeviceDrawer(); window.scDeviceForceLogout('${deviceId}', '${sessionJson}')" ${!sessionIds.length ? 'disabled' : ''}
        style="width:100%; background:${sessionIds.length ? '#fef2f2' : '#fafafa'}; color:${sessionIds.length ? '#dc2626' : '#9ca3af'}; border:none; border-radius:10px; padding:11px 16px; font-size:13px; font-weight:700; cursor:${sessionIds.length ? 'pointer' : 'not-allowed'}; display:flex; align-items:center; justify-content:center; gap:8px;">
        <i class="fa-solid fa-triangle-exclamation"></i> ${t('sa_sc_dw_force_logout', 'Force Logout')}
      </button>
      <button onclick="window.scCloseDeviceDrawer(); window.scDeviceToggleDisable('${deviceId}', ${isDisabled})"
        style="width:100%; background:${isDisabled ? '#f0fdf4' : '#fff7ed'}; color:${isDisabled ? '#16a34a' : '#c2410c'}; border:none; border-radius:10px; padding:11px 16px; font-size:13px; font-weight:700; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px;">
        <i class="fa-solid ${isDisabled ? 'fa-lock-open' : 'fa-ban'}"></i> ${isDisabled ? t('sa_sc_dw_enable_device', 'Enable Device') : t('sa_sc_dw_disable_device', 'Disable Device')}
      </button>`;

    const drawer = document.getElementById('scDeviceDrawer');
    if (drawer) { drawer.style.display = 'flex'; }
  };

  window.scCloseDeviceDrawer = function () {
    const drawer = document.getElementById('scDeviceDrawer');
    if (drawer) drawer.style.display = 'none';
  };

  // Logout a device's active session(s) — a "soft" logout, same as
  // ending that session; device itself stays allowed to log back in.
  window.scDeviceLogout = async function (sessionIdsJson) {
    let sessionIds = [];
    try { sessionIds = JSON.parse(sessionIdsJson.replace(/&quot;/g, '"')); } catch (e) { return; }
    if (!sessionIds.length) return;
    if (!confirm(t('sa_sc_confirm_device_logout', 'Ushbu qurilmani tizimdan chiqarmoqchimisiz?'))) return;
    try {
      for (const sid of sessionIds) {
        await _saSessionsFetch(`/active-sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
      }
      window.logAudit && window.logAudit('device_logout', sessionIds.join(','), t('sa_sc_log_device_logout', 'Qurilma tizimdan chiqarildi'));
      window.scRenderDevices();
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + (error?.message || ''));
    }
  };

  // Force logout — same effect but flagged as urgent/security action
  // (kept as a distinct action so it can be audited and styled
  // differently, even though the underlying operation is the same:
  // immediately terminate every session tied to this device).
  window.scDeviceForceLogout = async function (deviceId, sessionIdsJson) {
    let sessionIds = [];
    try { sessionIds = JSON.parse(sessionIdsJson.replace(/&quot;/g, '"')); } catch (e) { sessionIds = []; }
    if (!confirm(t('sa_sc_confirm_force_logout', "Diqqat! Ushbu qurilma majburan tizimdan chiqariladi. Davom etasizmi?"))) return;
    try {
      for (const sid of sessionIds) {
        await _saSessionsFetch(`/active-sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
      }
      window.logAudit && window.logAudit('device_force_logout', deviceId, t('sa_sc_log_device_force_logout', 'Qurilma majburan tizimdan chiqarildi'));
      window.scRenderDevices();
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + (error?.message || ''));
    }
  };

  // Disable / re-enable a device. A disabled device is recorded under
  // systemData/disabledDevices/{deviceId}; login flow should check this
  // path and block sign-in from a matching deviceId.
  window.scDeviceToggleDisable = async function (deviceId, isCurrentlyDisabled) {
    const willDisable = !isCurrentlyDisabled;
    const confirmMsg = willDisable
      ? t('sa_sc_confirm_disable_device', "Ushbu qurilmani bloklamoqchimisiz? U qayta kira olmaydi.")
      : t('sa_sc_confirm_enable_device', "Ushbu qurilmani qayta yoqmoqchimisiz?");
    if (!confirm(confirmMsg)) return;

    try {
      if (willDisable) {
        const sessions = _scVisibleSessions().filter(([, s]) => (s.deviceId || '') === deviceId);
        const sample = sessions[0]?.[1] || {};
        await _saSessionsFetch(`/disabled-devices/${encodeURIComponent(deviceId)}`, {
          method: 'POST',
          body: JSON.stringify({
            os: sample.os || '',
            browser: sample.browser || '',
            deviceLabel: sample.deviceLabel || '',
          }),
        });
        // Also kill any currently active sessions on this device
        for (const [sid] of sessions) {
          await _saSessionsFetch(`/active-sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
        }
        window.logAudit && window.logAudit('device_disable', deviceId, t('sa_sc_log_device_disabled', 'Qurilma bloklandi'));
      } else {
        await _saSessionsFetch(`/disabled-devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
        window.logAudit && window.logAudit('device_enable', deviceId, t('sa_sc_log_device_enabled', 'Qurilma qayta yoqildi'));
      }
      window.scRenderDevices();
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + (error?.message || ''));
    }
  };



  // ─────────────────────────────────────────────────────────
  // 2FA — status lookup helpers
  // ─────────────────────────────────────────────────────────
  function _scIsCurrentUserSuperAdmin() {
    return localStorage.getItem('role') === 'superadmin' && !_scCurrentViewerId_isPlatformUser();
  }
  function _scCurrentViewerId_isPlatformUser() {
    const uid = _scCurrentViewerId();
    return !!(uid && window.allPlatformUsers?.[uid]);
  }

  // Superadmin systemData migration, Stage 2: 2FA is now also a real
  // security upgrade, not just a permission fix — see
  // backend/routes/superadmin2fa.js's header for the full writeup. The
  // TOTP secret is generated AND verified entirely server-side now; the
  // client only ever sees it once, during setup (unavoidable — it has to
  // be shown/scanned into an authenticator app), and status checks return
  // only `{enabled}` booleans, never the secret.
  window._scSuperAdmin2fa = null;
  window.scListen2faSuperAdmin = function () {
    _saStart2faPoll('/all-status', (result) => {
      window._scSuperAdmin2fa = result?.superadmin || { enabled: false };
      // Merge boolean-only 2FA status into whatever platformUsers records
      // are already loaded client-side (that module's own listener is
      // unmigrated/out of scope for this pass — see this fix's report),
      // without touching any other field on those records.
      if (result?.platformUsers && window.allPlatformUsers) {
        Object.keys(result.platformUsers).forEach(uid => {
          if (window.allPlatformUsers[uid]) {
            window.allPlatformUsers[uid].twoFactor = {
              ...(window.allPlatformUsers[uid].twoFactor || {}),
              enabled: result.platformUsers[uid].enabled,
            };
          }
        });
      }
      window.scRefresh2faView();
      window.scUpdateStats();
    }, 30000);
  };

  // ─────────────────────────────────────────────────────────
  // 2FA — status view render
  // ─────────────────────────────────────────────────────────
  window.scRefresh2faView = async function () {
    const icon = document.getElementById('sc2faStatusIcon');
    const text = document.getElementById('sc2faStatusText');
    const btn = document.getElementById('sc2faToggleBtn');
    if (!icon || !text || !btn) return;

    let enabled = false;
    try {
      const status = await _sa2faFetch('/status');
      enabled = !!status.enabled;
    } catch (err) {
      console.error(t('sa_sc_err_2fa_status', "2FA holatini olishda xato:"), err.message);
    }

    if (enabled) {
      icon.style.background = '#dcfce7'; icon.style.color = '#16a34a';
      text.textContent = t('sa_sc_2fa_enabled_desc', "Yoqilgan — hisobingiz TOTP kod bilan himoyalangan");
      btn.innerHTML = `<i class="fa-solid fa-lock-open"></i> <span>${t('sa_sc_2fa_disable_btn', "O'chirish")}</span>`;
      btn.style.background = '#fef2f2'; btn.style.color = '#dc2626';
      btn.onclick = window.scOpenDisable2fa;
    } else {
      icon.style.background = '#fee2e2'; icon.style.color = '#dc2626';
      text.textContent = t('sa_sc_2fa_disabled_desc', "O'chirilgan — hisobingiz kamroq himoyalangan");
      btn.innerHTML = `<i class="fa-solid fa-lock"></i> <span>${t('sa_sc_2fa_enable_btn', 'Yoqish')}</span>`;
      btn.style.background = 'linear-gradient(135deg,#2563eb,#1d4ed8)'; btn.style.color = '#fff';
      btn.onclick = window.scOpen2faSetup;
    }
  };

  // ─────────────────────────────────────────────────────────
  // 2FA — enable flow (server generates the secret; QR/manual-entry only)
  // ─────────────────────────────────────────────────────────
  window.scOpen2faSetup = async function () {
    if (typeof QRCode === 'undefined') {
      alert(t('sa_sc_err_totp_lib', "TOTP kutubxonasi yuklanmadi. Internet aloqasini tekshiring."));
      return;
    }

    let setup;
    try {
      setup = await _sa2faFetch('/setup', { method: 'POST' });
    } catch (err) {
      alert(t('sa_error_prefix', 'Xatolik: ') + err.message);
      return;
    }
    _scPendingSecret = setup.secret; // only ever held in memory, never persisted client-side

    document.getElementById('sc2faStepQr').style.display = 'block';
    document.getElementById('sc2faStepDisable').style.display = 'none';
    document.getElementById('sc2faVerifyInput').value = '';
    document.getElementById('sc2faError').style.display = 'none';
    document.getElementById('sc2faSecretText').textContent = setup.secret;

    // 2026-08-06: rewritten for "qrcodejs" (davidshimjs) — the npm "qrcode"
    // package's static QRCode.toCanvas(el, text, opts, cb) API is gone from
    // this page (see the <script> tag comment in superadmin.html for why).
    // qrcodejs instead renders synchronously via a constructor that takes
    // its own container element and builds a <canvas> (or <table> as a
    // fallback in very old browsers) inside it directly — no separate
    // canvas element to pre-create, no callback (it either renders or
    // throws; nothing here does async work).
    const canvasWrap = document.getElementById('sc2faQrCanvas');
    canvasWrap.innerHTML = '';
    try {
      new QRCode(canvasWrap, {
        text: setup.otpauthUri,
        width: 200,
        height: 200,
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch (err) {
      console.error(err);
    }

    const modal = document.getElementById('sc2faModal');
    if (modal) modal.style.display = 'flex';
  };

  window.scVerify2faSetup = async function () {
    const code = document.getElementById('sc2faVerifyInput').value.trim();
    const errEl = document.getElementById('sc2faError');
    if (!_scPendingSecret) return;

    try {
      await _sa2faFetch('/verify-setup', { method: 'POST', body: JSON.stringify({ code }) });
      window.logAudit && window.logAudit('2fa_enabled', auth?.currentUser?.email || 'superadmin', t('sa_sc_log_2fa_enabled', '2FA yoqildi'));
      window.scClose2faSetup();
      window.scRefresh2faView();
    } catch (error) {
      errEl.textContent = /400/.test(error.message)
        ? t('sa_sc_2fa_wrong_code', "Kod noto'g'ri. Qaytadan urinib ko'ring.")
        : t('sa_error_prefix', 'Xatolik: ') + (error?.message || '');
      errEl.style.display = 'block';
    }
  };

  // ─────────────────────────────────────────────────────────
  // 2FA — disable flow (requires current code, verified server-side)
  // ─────────────────────────────────────────────────────────
  window.scOpenDisable2fa = function () {
    document.getElementById('sc2faStepQr').style.display = 'none';
    document.getElementById('sc2faStepDisable').style.display = 'block';
    document.getElementById('sc2faDisableInput').value = '';
    document.getElementById('sc2faDisableError').style.display = 'none';
    const modal = document.getElementById('sc2faModal');
    if (modal) modal.style.display = 'flex';
  };

  window.scConfirmDisable2fa = async function () {
    const code = document.getElementById('sc2faDisableInput').value.trim();
    const errEl = document.getElementById('sc2faDisableError');

    try {
      await _sa2faFetch('/disable', { method: 'POST', body: JSON.stringify({ code }) });
      window.logAudit && window.logAudit('2fa_disabled', auth?.currentUser?.email || 'superadmin', t('sa_sc_log_2fa_disabled', "2FA o'chirildi"));
      window.scClose2faSetup();
      window.scRefresh2faView();
    } catch (error) {
      errEl.textContent = /400/.test(error.message)
        ? t('sa_sc_2fa_wrong_code', "Kod noto'g'ri. Qaytadan urinib ko'ring.")
        : t('sa_error_prefix', 'Xatolik: ') + (error?.message || '');
      errEl.style.display = 'block';
    }
  };

  window.scClose2faSetup = function () {
    const modal = document.getElementById('sc2faModal');
    if (modal) modal.style.display = 'none';
    _scPendingSecret = null;
  };

  // ─────────────────────────────────────────────────────────
  // Nav hook: start listeners when Security Center first opened
  // ─────────────────────────────────────────────────────────
  function _scAttachNavHook() {
    document.querySelectorAll('.sidebar-nav a[href="#securitycenter"]').forEach(link => {
      link.addEventListener('click', () => {
        window.scStartListeners();
        window.scListen2faSuperAdmin();
        setTimeout(() => window.scRefresh2faView(), 100);
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _scAttachNavHook);
  else _scAttachNavHook();

})();

// ══════════════════════════════════════════════════════════════
//   BACKUP CENTER
//   Full RTDB export/import (cloud backup + restore)
// ══════════════════════════════════════════════════════════════
(function () {

  const BC_ROOTS = ["restaurants", "restaurants_meta", "systemData"];
  const BC_LIST_PATH = "systemData/backups";
  const BC_SETTINGS_PATH = "systemData/backupSettings";
  let _bcCache = {};

  function _bcDb() { return window.db; }

  function _bcFmtSize(bytes) {
    if (!bytes) return "0 KB";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function _bcFmtDate(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleString('ru-RU');
  }

  // ─────────────────────────────────────────────────────────
  // Create a full backup: read all data roots, store as one
  // JSON blob (stringified) under systemData/backups/{id}
  // ─────────────────────────────────────────────────────────
  window.bcCreateBackup = async function () {
    const database = _bcDb();
    if (!database) { alert(t('sa_err_firebase_not_connected', 'Firebase ulanmagan!')); return; }

    const btn = document.getElementById('bcCreateBtn');
    const originalHtml = btn ? btn.innerHTML : null;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t('sa_bc_creating', 'Yaratilmoqda...')}`;
    }

    try {
      const payload = {};
      for (const root of BC_ROOTS) {
        const snap = await get(ref(database, root));
        payload[root] = snap.exists() ? snap.val() : null;
      }
      const json = JSON.stringify(payload);
      const sizeBytes = new Blob([json]).size;
      const id = "bkp_" + Date.now();
      const authorEmail = (window.auth && window.auth.currentUser && window.auth.currentUser.email) || 'superadmin';

      await set(ref(database, `${BC_LIST_PATH}/${id}`), {
        id,
        createdAt: Date.now(),
        type: 'manual',
        author: authorEmail,
        sizeBytes,
        data: json
      });

      window.logAudit && window.logAudit('backup_create', authorEmail, t('sa_bc_log_created', 'Yangi zaxira nusxa yaratildi'));
      await window.bcRenderList();
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + (error?.message || ''));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }
  };

  // ─────────────────────────────────────────────────────────
  // Render backup list + stats
  // ─────────────────────────────────────────────────────────
  window.bcRenderList = async function () {
    const database = _bcDb();
    const body = document.getElementById('bcBackupListBody');
    if (!database || !body) return;

    try {
      const snap = await get(ref(database, BC_LIST_PATH));
      const raw = snap.exists() ? snap.val() : {};
      _bcCache = raw;

      const list = Object.values(raw).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      document.getElementById('bcTotalCount').textContent = list.length;
      document.getElementById('bcTotalSize').textContent = _bcFmtSize(list.reduce((s, b) => s + (b.sizeBytes || 0), 0));
      document.getElementById('bcLastBackup').textContent = list.length ? _bcFmtDate(list[0].createdAt) : '—';

      if (!list.length) {
        body.innerHTML = `<tr><td colspan="5" style="padding:30px; text-align:center; color:#94a3b8;">${t('sa_bc_none_found', "Zaxira nusxalar topilmadi")}</td></tr>`;
        return;
      }

      body.innerHTML = list.map(b => {
        const typeLabel = b.type === 'auto'
          ? `<span style="background:#dbeafe; color:#2563eb; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t('sa_bc_type_auto', 'Avtomatik')}</span>`
          : `<span style="background:#f3f4f6; color:#374151; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${t('sa_bc_type_manual', "Qo'lda")}</span>`;
        return `
          <tr>
            <td style="padding:12px 16px; font-size:13px; color:#111827;">${_bcFmtDate(b.createdAt)}</td>
            <td style="padding:12px 16px;">${typeLabel}</td>
            <td style="padding:12px 16px; font-size:13px; color:#6b7280;">${_bcFmtSize(b.sizeBytes)}</td>
            <td style="padding:12px 16px; font-size:13px; color:#6b7280;">${b.author || '—'}</td>
            <td style="padding:12px 16px; text-align:right; white-space:nowrap;">
              <button onclick="window.bcDownloadBackup('${b.id}')" title="${t('sa_bc_action_download', 'Yuklab olish')}"
                style="background:#f3f4f6; border:none; border-radius:8px; width:32px; height:32px; cursor:pointer; color:#374151; margin-right:6px;">
                <i class="fa-solid fa-download"></i>
              </button>
              <button onclick="window.bcOpenRestoreModal('${b.id}')" title="${t('sa_bc_action_restore', 'Tiklash')}"
                style="background:#eff6ff; border:none; border-radius:8px; width:32px; height:32px; cursor:pointer; color:#2563eb; margin-right:6px;">
                <i class="fa-solid fa-rotate-left"></i>
              </button>
              <button onclick="window.bcDeleteBackup('${b.id}')" title="${t('sa_bc_action_delete', "O'chirish")}"
                style="background:#fef2f2; border:none; border-radius:8px; width:32px; height:32px; cursor:pointer; color:#dc2626;">
                <i class="fa-solid fa-trash"></i>
              </button>
            </td>
          </tr>`;
      }).join('');
    } catch (error) {
      body.innerHTML = `<tr><td colspan="5" style="padding:30px; text-align:center; color:#dc2626;">${t('sa_error_prefix', 'Xatolik: ')}${error?.message || ''}</td></tr>`;
    }
  };

  window.bcDownloadBackup = function (id) {
    const b = _bcCache[id];
    if (!b) return;
    const blob = new Blob([b.data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nestacrm-backup-${id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  window.bcDeleteBackup = async function (id) {
    const database = _bcDb();
    if (!database) return;
    if (!confirm(t('sa_bc_confirm_delete', "Ushbu zaxira nusxani o'chirmoqchimisiz?"))) return;
    try {
      await remove(ref(database, `${BC_LIST_PATH}/${id}`));
      window.logAudit && window.logAudit('backup_delete', id, t('sa_bc_log_deleted', "Zaxira nusxa o'chirildi"));
      await window.bcRenderList();
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + (error?.message || ''));
    }
  };

  // ─────────────────────────────────────────────────────────
  // Restore flow — from an existing cloud backup, or from an
  // uploaded JSON file. Both funnel into the confirm modal.
  // ─────────────────────────────────────────────────────────
  let _bcPendingRestorePayload = null;
  let _bcPendingRestoreMeta = null;

  window.bcOpenRestoreModal = function (id) {
    const b = _bcCache[id];
    if (!b) return;
    try {
      _bcPendingRestorePayload = JSON.parse(b.data);
    } catch (e) {
      alert(t('sa_bc_err_parse', "Zaxira faylini o'qib bo'lmadi."));
      return;
    }
    _bcPendingRestoreMeta = { source: 'cloud', date: _bcFmtDate(b.createdAt), size: _bcFmtSize(b.sizeBytes) };
    document.getElementById('bcRestoreModalMeta').innerHTML =
      `<strong>${t('sa_bc_col_date', 'Sana')}:</strong> ${_bcPendingRestoreMeta.date} &nbsp;·&nbsp; <strong>${t('sa_bc_col_size', 'Hajmi')}:</strong> ${_bcPendingRestoreMeta.size}`;
    document.getElementById('bcRestoreConfirmInput').value = '';
    document.getElementById('bcRestoreModal').style.display = 'flex';
  };

  window.bcRestoreFromFile = function (file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const parsed = JSON.parse(e.target.result);
        _bcPendingRestorePayload = parsed;
        _bcPendingRestoreMeta = { source: 'file', date: file.name, size: _bcFmtSize(file.size) };
        document.getElementById('bcRestoreModalMeta').innerHTML =
          `<strong>${t('sa_bc_restore_file_label', 'Fayl')}:</strong> ${file.name} &nbsp;·&nbsp; <strong>${t('sa_bc_col_size', 'Hajmi')}:</strong> ${_bcFmtSize(file.size)}`;
        document.getElementById('bcRestoreConfirmInput').value = '';
        document.getElementById('bcRestoreModal').style.display = 'flex';
      } catch (err) {
        alert(t('sa_bc_err_parse', "Zaxira faylini o'qib bo'lmadi."));
      }
    };
    reader.readAsText(file);
    document.getElementById('bcRestoreFileInput').value = '';
  };

  window.bcCloseRestoreModal = function () {
    document.getElementById('bcRestoreModal').style.display = 'none';
    _bcPendingRestorePayload = null;
    _bcPendingRestoreMeta = null;
  };

  window.bcConfirmRestore = async function () {
    const database = _bcDb();
    if (!database || !_bcPendingRestorePayload) { window.bcCloseRestoreModal(); return; }

    const confirmVal = (document.getElementById('bcRestoreConfirmInput').value || '').trim().toUpperCase();
    if (confirmVal !== 'TIKLASH' && confirmVal !== 'RESTORE') {
      alert(t('sa_bc_err_confirm_word', 'Tasdiqlash uchun to\'g\'ri so\'zni kiriting.'));
      return;
    }

    try {
      const updates = {};
      for (const root of BC_ROOTS) {
        if (Object.prototype.hasOwnProperty.call(_bcPendingRestorePayload, root)) {
          updates[root] = _bcPendingRestorePayload[root];
        }
      }
      await update(ref(database), updates);

      const authorEmail = (window.auth && window.auth.currentUser && window.auth.currentUser.email) || 'superadmin';
      window.logAudit && window.logAudit('backup_restore', authorEmail,
        t('sa_bc_log_restored', 'Tizim zaxira nusxadan tiklandi') + ` (${_bcPendingRestoreMeta?.source || ''})`);

      window.bcCloseRestoreModal();
      alert(t('sa_bc_restore_success', 'Ma\'lumotlar muvaffaqiyatli tiklandi. Sahifa yangilanadi.'));
      location.reload();
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + (error?.message || ''));
    }
  };

  // ─────────────────────────────────────────────────────────
  // Auto-backup settings
  // ─────────────────────────────────────────────────────────
  window.bcSaveAutoSettings = async function () {
    const database = _bcDb();
    if (!database) return;
    const freq = document.getElementById('bcAutoFrequency').value;
    const enabled = document.getElementById('bcAutoToggle').checked;
    try {
      await set(ref(database, BC_SETTINGS_PATH), { frequency: freq, enabled, updatedAt: Date.now() });
      document.getElementById('bcAutoStatus').textContent = enabled
        ? t('sa_bc_auto_on', 'Yoqilgan') : t('sa_bc_auto_off', "O'chirilgan");
      window.logAudit && window.logAudit('backup_settings', 'superadmin', t('sa_bc_log_settings', 'Avto-zaxira sozlamalari yangilandi'));
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + (error?.message || ''));
    }
  };

  window.bcLoadAutoSettings = async function () {
    const database = _bcDb();
    if (!database) return;
    try {
      const snap = await get(ref(database, BC_SETTINGS_PATH));
      const s = snap.exists() ? snap.val() : { frequency: 'off', enabled: false };
      const freqEl = document.getElementById('bcAutoFrequency');
      const toggleEl = document.getElementById('bcAutoToggle');
      if (freqEl) freqEl.value = s.frequency || 'off';
      if (toggleEl) toggleEl.checked = !!s.enabled;
      const statusEl = document.getElementById('bcAutoStatus');
      if (statusEl) statusEl.textContent = s.enabled ? t('sa_bc_auto_on', 'Yoqilgan') : t('sa_bc_auto_off', "O'chirilgan");
    } catch (error) {
      console.error(t('sa_bc_err_settings_load', 'Sozlamalarni yuklashda xato:'), error);
    }
  };

  // ─────────────────────────────────────────────────────────
  // Nav hook: load data when Backup Center is first opened
  // ─────────────────────────────────────────────────────────
  function _bcAttachNavHook() {
    document.querySelectorAll('.sidebar-nav a[href="#backupcenter"]').forEach(link => {
      link.addEventListener('click', () => {
        window.bcRenderList();
        window.bcLoadAutoSettings();
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _bcAttachNavHook);
  else _bcAttachNavHook();

})();

// ══════════════════════════════════════════════════════════════
//   ERROR CENTER
//   Platform-wide error tracking (frontend/backend/integration)
// ══════════════════════════════════════════════════════════════
(function () {

  const EC_PATH = "systemData/errorLogs";
  let _ecCache = {};
  let _ecListenerAttached = false;
  window._ecCurrentDetailId = null;

  function _ecDb() { return window.db; }

  function _ecFmtDate(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleString('ru-RU');
  }

  function _ecSevBadge(sev) {
    const map = {
      critical: { bg: '#fee2e2', fg: '#dc2626', label: t('sa_ec_sev_critical', 'Kritik') },
      error: { bg: '#fef3c7', fg: '#d97706', label: t('sa_ec_sev_error', 'Xato') },
      warning: { bg: '#dbeafe', fg: '#2563eb', label: t('sa_ec_sev_warning', 'Ogohlantirish') }
    };
    const s = map[sev] || map.error;
    return `<span style="background:${s.bg}; color:${s.fg}; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${s.label}</span>`;
  }

  function _ecStatusBadge(status) {
    const map = {
      open: { bg: '#fee2e2', fg: '#dc2626', label: t('sa_ec_status_open', 'Ochiq') },
      resolved: { bg: '#dcfce7', fg: '#16a34a', label: t('sa_ec_status_resolved', 'Hal qilingan') },
      ignored: { bg: '#f3f4f6', fg: '#6b7280', label: t('sa_ec_status_ignored', "E'tiborsiz qoldirilgan") }
    };
    const s = map[status] || map.open;
    return `<span style="background:${s.bg}; color:${s.fg}; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">${s.label}</span>`;
  }

  // ─────────────────────────────────────────────────────────
  // Public API: report an error from anywhere in the app
  // window.ecReportError('frontend', message, { restId, stack, meta })
  // ─────────────────────────────────────────────────────────
  window.ecReportError = async function (source, message, opts) {
    const database = _ecDb();
    if (!database) return;
    opts = opts || {};
    try {
      await push(ref(database, EC_PATH), {
        createdAt: Date.now(),
        source: source || 'frontend',
        severity: opts.severity || 'error',
        message: String(message || '').slice(0, 2000),
        stack: opts.stack ? String(opts.stack).slice(0, 4000) : null,
        restaurantId: opts.restId || null,
        restaurantName: opts.restName || null,
        status: 'open'
      });
    } catch (e) {
      console.error(t('sa_ec_report_failed', 'ecReportError failed:'), e);
    }
  };

  // Auto-capture uncaught JS errors on this page
  window.addEventListener('error', (e) => {
    window.ecReportError('frontend', e.message, { severity: 'error', stack: e.error?.stack });
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.ecReportError('frontend', t('sa_ec_unhandled_rejection_prefix', 'Unhandled promise rejection: ') + (e.reason?.message || e.reason), { severity: 'warning', stack: e.reason?.stack });
  });

  // ─────────────────────────────────────────────────────────
  // Live listener + stats
  // ─────────────────────────────────────────────────────────
  window.ecStartListener = function () {
    const database = _ecDb();
    if (!database || _ecListenerAttached) return;
    _ecListenerAttached = true;
    onValue(ref(database, EC_PATH), (snap) => {
      _ecCache = snap.exists() ? snap.val() : {};
      window.ecUpdateStats();
      window.ecRenderList();
    });
  };

  window.ecUpdateStats = function () {
    const list = Object.values(_ecCache || {});
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const totalEl = document.getElementById('ecTotalCount');
    const openEl = document.getElementById('ecOpenCount');
    const todayEl = document.getElementById('ecTodayCount');
    const resolvedEl = document.getElementById('ecResolvedCount');
    const badgeEl = document.getElementById('errorCenterBadge');
    if (!totalEl) return;

    const openCount = list.filter(e => (e.status || 'open') === 'open').length;
    totalEl.textContent = list.length;
    openEl.textContent = openCount;
    todayEl.textContent = list.filter(e => (e.createdAt || 0) >= startOfDay.getTime()).length;
    resolvedEl.textContent = list.filter(e => e.status === 'resolved').length;

    if (badgeEl) {
      if (openCount > 0) {
        badgeEl.style.display = 'inline-block';
        badgeEl.textContent = openCount > 99 ? '99+' : openCount;
      } else {
        badgeEl.style.display = 'none';
      }
    }
  };

  // ─────────────────────────────────────────────────────────
  // Render filtered list
  // ─────────────────────────────────────────────────────────
  window.ecRenderList = function () {
    const body = document.getElementById('ecListBody');
    if (!body) return;

    const search = (document.getElementById('ecSearchInput')?.value || '').trim().toLowerCase();
    const sevFilter = document.getElementById('ecSeverityFilter')?.value || '';
    const statusFilter = document.getElementById('ecStatusFilter')?.value || '';
    const sourceFilter = document.getElementById('ecSourceFilter')?.value || '';

    let list = Object.entries(_ecCache || {}).map(([id, e]) => ({ id, ...e }));

    if (search) {
      list = list.filter(e =>
        (e.message || '').toLowerCase().includes(search) ||
        (e.restaurantName || '').toLowerCase().includes(search) ||
        (e.source || '').toLowerCase().includes(search)
      );
    }
    if (sevFilter) list = list.filter(e => e.severity === sevFilter);
    if (statusFilter) list = list.filter(e => (e.status || 'open') === statusFilter);
    if (sourceFilter) list = list.filter(e => e.source === sourceFilter);

    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (!list.length) {
      body.innerHTML = `<tr><td colspan="7" style="padding:30px; text-align:center; color:#94a3b8;">${t('sa_ec_none_found', "Xatolar topilmadi")}</td></tr>`;
      return;
    }

    body.innerHTML = list.slice(0, 300).map(e => `
      <tr>
        <td style="padding:12px 16px; font-size:13px; color:#111827; white-space:nowrap;">${_ecFmtDate(e.createdAt)}</td>
        <td style="padding:12px 16px;">${_ecSevBadge(e.severity)}</td>
        <td style="padding:12px 16px; font-size:13px; color:#6b7280; text-transform:capitalize;">${e.source || '—'}</td>
        <td style="padding:12px 16px; font-size:13px; color:#111827; max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${(e.message || '').replace(/"/g, '&quot;')}">${e.message || '—'}</td>
        <td style="padding:12px 16px; font-size:13px; color:#6b7280;">${e.restaurantName || '—'}</td>
        <td style="padding:12px 16px;">${_ecStatusBadge(e.status || 'open')}</td>
        <td style="padding:12px 16px; text-align:right; white-space:nowrap;">
          <button onclick="window.ecOpenDetailModal('${e.id}')" title="${t('sa_ec_action_view', "Ko'rish")}"
            style="background:#f3f4f6; border:none; border-radius:8px; width:32px; height:32px; cursor:pointer; color:#374151; margin-right:6px;">
            <i class="fa-solid fa-eye"></i>
          </button>
          <button onclick="window.ecDeleteError('${e.id}')" title="${t('sa_ec_action_delete', "O'chirish")}"
            style="background:#fef2f2; border:none; border-radius:8px; width:32px; height:32px; cursor:pointer; color:#dc2626;">
            <i class="fa-solid fa-trash"></i>
          </button>
        </td>
      </tr>`).join('');
  };

  // ─────────────────────────────────────────────────────────
  // Detail modal
  // ─────────────────────────────────────────────────────────
  window.ecOpenDetailModal = function (id) {
    const e = _ecCache[id];
    if (!e) return;
    window._ecCurrentDetailId = id;
    document.getElementById('ecDetailBody').innerHTML = `
      <div style="display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap;">
        ${_ecSevBadge(e.severity)} ${_ecStatusBadge(e.status || 'open')}
        <span style="background:#f3f4f6; color:#374151; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700; text-transform:capitalize;">${e.source || '—'}</span>
      </div>
      <div style="margin-bottom:10px; font-size:13px; color:#6b7280;"><strong>${t('sa_ec_col_time', 'Vaqt')}:</strong> ${_ecFmtDate(e.createdAt)}</div>
      ${e.restaurantName ? `<div style="margin-bottom:10px; font-size:13px; color:#6b7280;"><strong>${t('sa_ec_col_restaurant', 'Restoran')}:</strong> ${e.restaurantName}</div>` : ''}
      <div style="margin-bottom:10px;">
        <div style="font-size:13px; color:#6b7280; margin-bottom:4px;"><strong>${t('sa_ec_col_message', 'Xabar')}:</strong></div>
        <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:10px; padding:12px 14px; font-size:13px; color:#111827; word-break:break-word;">${e.message || '—'}</div>
      </div>
      ${e.stack ? `
      <div>
        <div style="font-size:13px; color:#6b7280; margin-bottom:4px;"><strong>${t('sa_ec_col_stack_trace', 'Stack trace:')}</strong></div>
        <pre style="background:#111827; color:#e5e7eb; border-radius:10px; padding:12px 14px; font-size:11px; overflow-x:auto; white-space:pre-wrap; word-break:break-word;">${e.stack}</pre>
      </div>` : ''}
    `;
    document.getElementById('ecDetailModal').style.display = 'flex';
  };

  window.ecCloseDetailModal = function () {
    document.getElementById('ecDetailModal').style.display = 'none';
    window._ecCurrentDetailId = null;
  };

  window.ecSetStatus = async function (id, status) {
    const database = _ecDb();
    if (!database || !id) return;
    try {
      await update(ref(database, `${EC_PATH}/${id}`), { status });
      window.logAudit && window.logAudit('error_status', id, `${t('sa_ec_log_status_prefix', 'Xato holati o\'zgartirildi:')} ${status}`);
      window.ecCloseDetailModal();
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + (error?.message || ''));
    }
  };

  window.ecDeleteError = async function (id) {
    const database = _ecDb();
    if (!database) return;
    if (!confirm(t('sa_ec_confirm_delete', "Ushbu xato yozuvini o'chirmoqchimisiz?"))) return;
    try {
      await remove(ref(database, `${EC_PATH}/${id}`));
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + (error?.message || ''));
    }
  };

  window.ecClearResolved = async function () {
    const database = _ecDb();
    if (!database) return;
    if (!confirm(t('sa_ec_confirm_clear', "Barcha hal qilingan xatolarni tozalamoqchimisiz?"))) return;
    try {
      const toRemove = Object.entries(_ecCache || {}).filter(([, e]) => e.status === 'resolved');
      for (const [id] of toRemove) {
        await remove(ref(database, `${EC_PATH}/${id}`));
      }
      window.logAudit && window.logAudit('error_clear', 'superadmin', t('sa_ec_log_cleared', 'Hal qilingan xatolar tozalandi'));
    } catch (error) {
      alert(t('sa_error_prefix', 'Xatolik: ') + (error?.message || ''));
    }
  };

  // ─────────────────────────────────────────────────────────
  // Nav hook
  // ─────────────────────────────────────────────────────────
  function _ecAttachNavHook() {
    document.querySelectorAll('.sidebar-nav a[href="#errorcenter"]').forEach(link => {
      link.addEventListener('click', () => window.ecStartListener());
    });
    // Start listener immediately so the sidebar badge stays live
    window.ecStartListener();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _ecAttachNavHook);
  else _ecAttachNavHook();

})();5