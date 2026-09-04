/**
 * =====================================================
 * plan_features.js  —  Universal Feature Gate
 * =====================================================
 * Bu fayl admin.js, chef.js (kds), waiter.js sahifalariga
 * ulanadi. Firebase'dan restoranning subscription/features
 * ni real-time o'qib, UI elementlarini yoqadi yoki bloklab
 * "Tarif cheklovi" modal chiqaradi.
 *
 * ULANISH TARTIBI (har bir sahifa yuqorisiga):
 *   <script type="module" src="plan_features.js"></script>
 *   yoki admin.js ichiga import qiling.
 *
 * QOIDALAR:
 *   - Superadmin tarif funksiyalarini global darajada o'zgartiradi
 *     (systemData/settings/tariffs/{key}/features)
 *   - Superadmin alohida restoran uchun qo'shimcha/ayirma funksiya
 *     qo'shishi mumkin (restaurants/{id}/subscription/customFeatures)
 *   - Yakuniy features = tarif features + customFeatures
 *   - admin, chef, waiter roli farq qilmaydi — barchaga bir xil gate
 * =====================================================
 */

import {
  getDatabase, forceWebSockets, ref, onValue, get
} from "./pgRtdb.js";

// Redundant, idempotent safety net (see superadmin_features.js for the
// full rationale) — this module's own onValue() calls are all inside
// listenPlanFeatures(), only invoked later by the importing page, so this
// isn't fixing a live bug; it closes off a future one.
forceWebSockets();

// ─────────────────────────────────────────────────────
// 1. FEATURE → UI SELECTOR XARITASI
//    Har bir feature ID → DOM elementlar/selectorlar
// ─────────────────────────────────────────────────────
const FEATURE_MAP = {
  qr_menu:      {
    selectors:  ['#menu-qr', 'a[href="#qr"]', '[data-feature="qr_menu"]'],
    sections:   ['qr'],
    label:      () => window.t?.("feature_qr_menu", "QR-Menyu va Self-service") ?? "QR-Menyu",
    icon:       "fa-qrcode"
  },
  kds:          {
    selectors:  ['#kds-link', '[data-feature="kds"]'],
    sections:   ['kds'],
    label:      () => window.t?.("feature_kds", "Oshpaz ekrani (KDS)") ?? "KDS",
    icon:       "fa-kitchen-set"
  },
  promo:        {
    selectors:  ['#menu-promocodes', '[data-feature="promo"]'],
    sections:   ['promocodes'],
    label:      () => window.t?.("feature_promo", "Promokod / Keshbek") ?? "Promokod",
    icon:       "fa-tag"
  },
  finance:      {
    selectors:  ['#menu-finance', 'a[href="#finance"]', 'a[href="#report"]', '[data-feature="finance"]'],
    sections:   ['finance', 'report'],
    label:      () => window.t?.("feature_finance", "Moliya hisobotlari") ?? "Moliya",
    icon:       "fa-chart-line"
  },
  inventory:    {
    selectors:  ['a[href="#warehouse"]', '#menu-warehouse', '[data-feature="inventory"]'],
    sections:   ['warehouse', 'inventory'],
    label:      () => window.t?.("feature_inventory", "Ombor (Inventarizatsiya)") ?? "Ombor",
    icon:       "fa-boxes-stacking"
  },
  reservations: {
    selectors:  ['a[href="#reservations"]', '#menu-reservations', '[data-feature="reservations"]'],
    sections:   ['reservations'],
    label:      () => window.t?.("feature_reservations", "Bron tizimi") ?? "Bronlash",
    icon:       "fa-calendar-check"
  }
};

// ─────────────────────────────────────────────────────
// 2. GLOBAL HOLAT
// ─────────────────────────────────────────────────────
window._planFeatures     = window._planFeatures     || [];
window._customFeatures   = window._customFeatures   || [];  // superadmin qo'shgan qo'shimcha
window._currentPlanKey   = window._currentPlanKey   || "start";
window._currentPlanName  = window._currentPlanName  || "START";
window.allTariffs        = window.allTariffs        || {};
window.restaurantFeatures= window.restaurantFeatures|| [];

// ─────────────────────────────────────────────────────
// 3. SECTION NAVIGATION INTERCEPTOR
//    Sahifa ichida section almashtirish (showSection, navigateTo …)
//    bloklanadi, agar feature yo'q bo'lsa
// ─────────────────────────────────────────────────────
(function patchNavigation() {
  // admin.js da showSection yoki navigateTo global bo'lishi mumkin
  const _patch = (fnName) => {
    const orig = window[fnName];
    if (typeof orig !== "function") return;
    window[fnName] = function(id, ...args) {
      const blockedFeature = Object.entries(FEATURE_MAP).find(([, cfg]) =>
        cfg.sections.includes(id?.replace("#", ""))
      );
      if (blockedFeature) {
        const [featureId] = blockedFeature;
        if (!window._planFeatures.includes(featureId)) {
          showFeatureBlockModal(featureId);
          return;
        }
      }
      return orig.call(this, id, ...args);
    };
  };

  // DOM tayyor bo'lgandan keyin patch qilamiz
  document.addEventListener("DOMContentLoaded", () => {
    ["showSection", "navigateTo", "openSection", "switchTab"].forEach(_patch);
  });
})();

// ─────────────────────────────────────────────────────
// 4. FEATURES NI UI GA QOLLASH
// ─────────────────────────────────────────────────────
function applyPlanFeaturesToUI(features) {
  window._planFeatures = Array.isArray(features) ? features : [];
  window.restaurantFeatures = window._planFeatures; // eski mos kelish uchun

  Object.entries(FEATURE_MAP).forEach(([featureId, cfg]) => {
    const allowed = window._planFeatures.includes(featureId);

    cfg.selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        if (allowed) {
          // ✅ Ruxsat berilgan
          el.classList.remove("plan-locked");
          el.removeAttribute("data-plan-blocked");
          el.querySelectorAll(".plan-lock-icon").forEach(ic => ic.remove());
          if (el._planLockedClickHandler) {
            el.removeEventListener("click", el._planLockedClickHandler);
            delete el._planLockedClickHandler;
          }
        } else {
          // 🔒 Bloklangan
          el.classList.add("plan-locked");
          el.setAttribute("data-plan-blocked", featureId);

          // Qulf ikonchasini bir marta qo'shamiz
          if (!el.querySelector(".plan-lock-icon")) {
            const ic = document.createElement("i");
            ic.className = "fa-solid fa-lock plan-lock-icon";
            ic.style.cssText = "margin-left:6px;color:#f59e0b;font-size:11px;vertical-align:middle;";
            el.appendChild(ic);
          }

          // Eski handler'ni olib tashlab, yangisini qo'shamiz
          if (el._planLockedClickHandler) {
            el.removeEventListener("click", el._planLockedClickHandler);
          }
          el._planLockedClickHandler = function planLockedClick(e) {
            e.preventDefault();
            e.stopPropagation();
            showFeatureBlockModal(featureId);
          };
          el.addEventListener("click", el._planLockedClickHandler);
        }
      });
    });
  });

  // Alohida display none/block kerak bo'lgan elementlar
  const promoMenu = document.getElementById("menu-promocodes");
  if (promoMenu) promoMenu.style.display = window._planFeatures.includes("promo") ? "" : "none";

  const financeMenu = document.getElementById("menu-finance");
  if (financeMenu) financeMenu.style.display = window._planFeatures.includes("finance") ? "" : "none";

  // Joriy ochiq bo'lim bloklanganmi? → asosiy sahifaga qaytarish
  _checkCurrentSectionBlocked();
}

// Joriy ko'rsatilayotgan section bloklanganligini tekshirish
function _checkCurrentSectionBlocked() {
  const active = document.querySelector(".section-content.active, [class*='section'][style*='block']");
  if (!active) return;
  const sectionId = active.id;
  if (!sectionId) return;

  const blockedFeature = Object.entries(FEATURE_MAP).find(([, cfg]) =>
    cfg.sections.includes(sectionId)
  );
  if (!blockedFeature) return;
  const [featureId] = blockedFeature;
  if (!window._planFeatures.includes(featureId)) {
    // Asosiy sahifaga qaytarish
    if (typeof window.showSection === "function") window.showSection("dashboard");
    else if (typeof window.navigateTo === "function") window.navigateTo("dashboard");
    showFeatureBlockModal(featureId);
  }
}

// ─────────────────────────────────────────────────────
// 5. BLOKLASH MODAL
// ─────────────────────────────────────────────────────
function showFeatureBlockModal(featureId) {
  const old = document.getElementById("pf-block-modal");
  if (old) old.remove();

  _injectStyles();

  const cfg = FEATURE_MAP[featureId] || {};
  const name = cfg.label ? cfg.label() : featureId;
  const icon = cfg.icon || "fa-lock";

  // Qaysi tarif kerakligini topamiz
  const TARIFF_ORDER = ["start", "pro", "premium"];
  const currentKey   = (window._currentPlanKey || "start").toLowerCase();
  let requiredPlan   = null;

  for (const tKey of TARIFF_ORDER) {
    if (TARIFF_ORDER.indexOf(tKey) <= TARIFF_ORDER.indexOf(currentKey)) continue;
    const tData = window.allTariffs[tKey] || {};
    const tFeats = Array.isArray(tData.features) ? tData.features : [];
    if (tFeats.includes(featureId)) {
      requiredPlan = tData.name || tKey.toUpperCase();
      break;
    }
  }
  // Agar hech bir yuqori tarif ham yo'q bo'lsa (superadmin ayirmagan)
  if (!requiredPlan) {
    for (const tKey of TARIFF_ORDER) {
      const tData = window.allTariffs[tKey] || {};
      const tFeats = Array.isArray(tData.features) ? tData.features : [];
      if (tFeats.includes(featureId)) {
        requiredPlan = tData.name || tKey.toUpperCase();
        break;
      }
    }
  }

  const planBadge = requiredPlan
    ? `<div class="pf-upgrade-badge">
        <span>⬆️</span>
        <span>${window.t?.("required_plan_label","Kerakli tarif") ?? "Kerakli tarif"}:
          <strong>${requiredPlan}</strong>
        </span>
       </div>`
    : "";

  const modal = document.createElement("div");
  modal.id = "pf-block-modal";
  modal.className = "pf-overlay";
  modal.innerHTML = `
    <div class="pf-card">
      <div class="pf-lock-ring">
        <i class="fa-solid ${icon}"></i>
      </div>
      <h3 class="pf-title">${window.t?.("plan_limit_title","Tarif cheklovi") ?? "Tarif cheklovi"}</h3>
      <p class="pf-desc">
        <span class="pf-feature-name">${name}</span>
        ${window.t?.("plan_feature_not_available","funksiyasi joriy tarifingizda mavjud emas.") ?? "funksiyasi joriy tarifingizda mavjud emas."}
        <br>
        ${window.t?.("plan_upgrade_request","Superadmin orqali tarifni yangilang.") ?? "Superadmin orqali tarifni yangilang."}
      </p>
      <div class="pf-current-plan">
        💼 ${window.t?.("current_plan_label","Joriy tarif") ?? "Joriy tarif"}:
        <strong>${(window._currentPlanName || "START").toUpperCase()}</strong>
      </div>
      ${planBadge}
      <button class="pf-close-btn" onclick="document.getElementById('pf-block-modal').remove()">
        ${window.t?.("understood_btn","Tushunarli") ?? "Tushunarli"}
      </button>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
}

// ─────────────────────────────────────────────────────
// 6. FEATURE ACCESS CHECK (window.checkFeatureAccess)
//    admin.js ichidan ishlatiladi:
//    checkFeatureAccess("finance", () => loadFinance())
// ─────────────────────────────────────────────────────
window.checkFeatureAccess = function(featureKey, actionCallback) {
  if (
    window._planFeatures.includes("all") ||
    window._planFeatures.includes(featureKey)
  ) {
    if (typeof actionCallback === "function") actionCallback();
    return true;
  }
  showFeatureBlockModal(featureKey);
  return false;
};

// ─────────────────────────────────────────────────────
// 7. FIREBASE LISTENER — REAL-TIME YANGILANISH
//    Tarif o'zgarganda YOKI customFeatures o'zgarganda
//    darhol UI yangilanadi.
//
//    Firebase strukturasi:
//      restaurants/{restId}/info/tariff           → "pro"
//      restaurants/{restId}/subscription/features → ["qr_menu","kds",...]
//      restaurants/{restId}/subscription/customFeatures → ["finance"] (qo'shimcha)
//
//    Yakuniy features = tarif features UNION customFeatures
// ─────────────────────────────────────────────────────
export function listenPlanFeatures(db) {
  const restId = localStorage.getItem("restaurantId");
  if (!restId || !db) return;

  // --- 7a. Tarif kaliti o'zgarishini tinglash ---
  onValue(ref(db, `restaurants/${restId}/info/tariff`), async tariffSnap => {
    const tariffKey = (tariffSnap.val() || "start").toLowerCase();
    window._currentPlanKey = tariffKey;

    // Global tariflar bor bo'lsa foydalanib, bo'lmasa Firebase'dan olamiz
    let allTariffs = window.allTariffs || {};
    if (!allTariffs[tariffKey]) {
      const snap = await get(ref(db, "systemData/settings/tariffs"));
      if (snap.exists()) {
        allTariffs = snap.val();
        window.allTariffs = allTariffs;
      }
    }
    const tariffData      = allTariffs[tariffKey] || {};
    window._currentPlanName = tariffData.name || tariffKey.toUpperCase();

    _recomputeAndApply(db, restId, tariffKey, allTariffs);
  });

  // --- 7b. Global tariflar o'zgarganda (superadmin tarifni yangiladi) ---
  onValue(ref(db, "systemData/settings/tariffs"), snap => {
    if (!snap.exists()) return;
    window.allTariffs = snap.val();

    const tariffKey  = window._currentPlanKey || "start";
    const tariffData = window.allTariffs[tariffKey] || {};
    window._currentPlanName = tariffData.name || tariffKey.toUpperCase();

    _recomputeAndApply(db, restId, tariffKey, window.allTariffs);
  });

  // --- 7c. Superadmin qo'shgan customFeatures ni tinglash ---
  onValue(ref(db, `restaurants/${restId}/subscription/customFeatures`), snap => {
    window._customFeatures = Array.isArray(snap.val()) ? snap.val() : [];
    const tariffKey = window._currentPlanKey || "start";
    _recomputeAndApply(db, restId, tariffKey, window.allTariffs);
  });

  // --- 7d. subscription/features ni to'g'ridan-to'g'ri tinglash (mos kelish) ---
  onValue(ref(db, `restaurants/${restId}/subscription/features`), snap => {
    const features = Array.isArray(snap.val()) ? snap.val() : [];
    // customFeatures ni ustiga qo'shamiz
    const merged = _mergeFeatures(features, window._customFeatures || []);
    if (JSON.stringify(merged) !== JSON.stringify(window._planFeatures)) {
      applyPlanFeaturesToUI(merged);
    }
  });
}

// Tarif features + customFeatures birlashtirib UI ga qo'llaymiz
function _recomputeAndApply(db, restId, tariffKey, allTariffs) {
  const tariffFeatures = Array.isArray(allTariffs[tariffKey]?.features)
    ? allTariffs[tariffKey].features
    : [];
  const custom = Array.isArray(window._customFeatures) ? window._customFeatures : [];
  const merged = _mergeFeatures(tariffFeatures, custom);

  applyPlanFeaturesToUI(merged);
}

// Ikki array'ni birlashtirib, takrorlanmasdan qaytaradi
function _mergeFeatures(base, extra) {
  const set = new Set([...(base || []), ...(extra || [])]);
  return [...set];
}

// ─────────────────────────────────────────────────────
// 8. CSS INJECT — Bir marta
// ─────────────────────────────────────────────────────
function _injectStyles() {
  if (document.getElementById("pf-styles")) return;
  const s = document.createElement("style");
  s.id = "pf-styles";
  s.textContent = `
    @keyframes pf-pop   { from { transform:scale(.8) translateY(20px); opacity:0 }
                          to   { transform:scale(1)  translateY(0);     opacity:1 } }
    @keyframes pf-shake { 0%,100%{transform:rotate(0)}
                          20%,60%{transform:rotate(-8deg)}
                          40%,80%{transform:rotate(8deg)} }

    .plan-locked {
      opacity: .55;
      cursor:  not-allowed !important;
      position: relative;
    }
    .plan-locked::after {
      content:'';
      position:absolute; inset:0;
      background:rgba(255,255,255,.05);
      border-radius:inherit;
      pointer-events:none;
    }

    /* Modal overlay */
    .pf-overlay {
      position:fixed; inset:0; z-index:99999;
      background:rgba(15,23,42,.6);
      display:flex; align-items:center; justify-content:center;
      backdrop-filter:blur(4px);
    }

    /* Modal kartochka */
    .pf-card {
      background:#fff;
      border-radius:20px;
      padding:40px 36px 32px;
      max-width:440px; width:90%;
      text-align:center;
      box-shadow:0 25px 80px rgba(0,0,0,.3);
      animation:pf-pop .3s cubic-bezier(.34,1.56,.64,1);
      position:relative;
    }

    /* Qulf ring */
    .pf-lock-ring {
      width:72px; height:72px;
      margin:0 auto 20px;
      border-radius:50%;
      background:linear-gradient(135deg,#fef3c7,#fde68a);
      display:flex; align-items:center; justify-content:center;
      font-size:28px; color:#f59e0b;
      box-shadow:0 4px 20px rgba(245,158,11,.3);
      animation:pf-shake 1s ease .3s 1;
    }

    .pf-title {
      margin:0 0 12px;
      font-size:20px; font-weight:800;
      color:#0f172a;
    }
    .pf-desc {
      color:#64748b; font-size:14px;
      line-height:1.7; margin:0 0 16px;
    }
    .pf-feature-name {
      font-weight:700; color:#f59e0b; font-size:15px;
    }
    .pf-current-plan {
      background:#f8fafc;
      border:1px solid #e2e8f0;
      border-radius:10px;
      padding:10px 16px;
      font-size:13px; color:#475569;
      margin-bottom:12px;
    }
    .pf-upgrade-badge {
      background:#f0fdf4;
      border:1.5px solid #6ee7b7;
      border-radius:10px;
      padding:10px 16px;
      font-size:13px; color:#065f46;
      display:flex; align-items:center;
      justify-content:center; gap:8px;
      margin-bottom:20px;
    }
    .pf-upgrade-badge strong { color:#059669; font-size:15px; }

    .pf-close-btn {
      background:linear-gradient(135deg,#3b82f6,#1d4ed8);
      color:#fff; border:none;
      border-radius:12px;
      padding:14px 32px;
      font-size:15px; font-weight:700;
      cursor:pointer; width:100%;
      transition:transform .15s, box-shadow .15s;
      box-shadow:0 4px 15px rgba(59,130,246,.4);
    }
    .pf-close-btn:hover {
      transform:translateY(-1px);
      box-shadow:0 6px 20px rgba(59,130,246,.5);
    }
    .pf-close-btn:active { transform:translateY(0); }
  `;
  document.head.appendChild(s);
}

// ─────────────────────────────────────────────────────
// 9. EKSPORT — admin.js / chef.js / waiter.js dan
//    import qilish uchun
// ─────────────────────────────────────────────────────
export { applyPlanFeaturesToUI, showFeatureBlockModal, FEATURE_MAP };