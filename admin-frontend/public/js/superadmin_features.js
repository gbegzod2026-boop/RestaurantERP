/**
 * =====================================================
 * superadmin_features.js  —  Superadmin Feature Manager
 * =====================================================
 * Superadmin:
 *   1. Tariflar uchun global funksiyalar ro'yxatini belgilaydi
 *   2. Alohida restoran uchun QO'SHIMCHA funksiya qo'sha oladi
 *   3. Alohida restoran uchun funksiya OLI TASHLASH mumkin
 *   4. O'zgarishlar darhol restorandagi admin/chef/waiterga ta'sir qiladi
 *
 * FIREBASE STRUKTURASI:
 *   systemData/settings/tariffs/{key}/features  → global tarif features
 *   restaurants/{id}/subscription/features      → hisoblangan yakuniy features
 *   restaurants/{id}/subscription/customFeatures → [{id, added_by_superadmin:true}] yoki ["+finance", "-kds"]
 *
 * LOGIKA (plan_features.js bilan birgalikda ishlaydi):
 *   yakuniy = tarif.features ∪ customFeatures_added - customFeatures_removed
 * =====================================================
 */

import {
  ref, get, set, update, onValue, forceWebSockets
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

forceWebSockets();

// ─────────────────────────────────────────────────────
// 1. BARCHA MAVJUD FUNKSIYALAR
// ─────────────────────────────────────────────────────
const ALL_FEATURES = [
  { id: "qr_menu",      icon: "fa-qrcode",          labelKey: "feat_qr",           labelDef: "QR-Menyu va Self-service" },
  { id: "kds",          icon: "fa-kitchen-set",      labelKey: "feat_kds",          labelDef: "Oshpaz ekrani (KDS)" },
  { id: "promo",        icon: "fa-tag",              labelKey: "feat_promo",        labelDef: "Promokod / Keshbek" },
  { id: "finance",      icon: "fa-chart-line",       labelKey: "feat_finance",      labelDef: "Moliya hisobotlari" },
  { id: "inventory",    icon: "fa-boxes-stacking",   labelKey: "feat_inventory",    labelDef: "Ombor / Inventarizatsiya" },
  { id: "reservations", icon: "fa-calendar-check",   labelKey: "feat_reservations", labelDef: "Bron tizimi" }
];

// ─────────────────────────────────────────────────────
// 2. SUPERADMIN: ALOHIDA RESTORAN FEATURES NI BOSHQARISH
// ─────────────────────────────────────────────────────

/**
 * Muayyan restoran uchun individual feature override modal'ini ochadi.
 * superadmin.js dan chaqiriladi:
 *   window.openRestaurantFeaturesModal(restId)
 *
 * @param {string} restId - Firebase restoran IDsi
 */
window.openRestaurantFeaturesModal = async function(restId) {
  const db = window.db;
  if (!db || !restId) return;

  const t = window.t || ((k, d) => d || k);

  // Restoran ma'lumotlarini olamiz
  const restSnap = await get(ref(db, `restaurants/${restId}`));
  if (!restSnap.exists()) {
    alert(t("sa_rest_not_found", "Restoran topilmadi!"));
    return;
  }
  const rest       = restSnap.val();
  const restName   = rest.info?.name || restId;
  const tariffKey  = (rest.info?.tariff || "start").toLowerCase();

  // Global tariflar
  let allTariffs = window.allTariffs || {};
  if (!allTariffs[tariffKey]) {
    const snap = await get(ref(db, "systemData/settings/tariffs"));
    if (snap.exists()) { allTariffs = snap.val(); window.allTariffs = allTariffs; }
  }

  const planFeatures    = Array.isArray(allTariffs[tariffKey]?.features) ? allTariffs[tariffKey].features : [];
  const customFeatures  = Array.isArray(rest.subscription?.customFeatures) ? rest.subscription.customFeatures : [];
  const currentFeatures = _computeEffective(planFeatures, customFeatures);

  _renderModal({ restId, restName, tariffKey, allTariffs, planFeatures, customFeatures, currentFeatures, db, t });
};

// ─────────────────────────────────────────────────────
// 3. EFFECTIVE FEATURES HISOBLASH
//    customFeatures: ["+finance", "-kds", "qr_menu"] → prefix bilan yoki eski format
// ─────────────────────────────────────────────────────
function _computeEffective(planFeatures, customFeatures) {
  const base = new Set(planFeatures || []);

  (customFeatures || []).forEach(f => {
    if (typeof f !== "string") return;
    if (f.startsWith("+")) base.add(f.slice(1));
    else if (f.startsWith("-")) base.delete(f.slice(1));
    else base.add(f); // eski format: prefix yo'q → qo'shimcha
  });

  return [...base];
}
window._computeEffective = _computeEffective;

// ─────────────────────────────────────────────────────
// 4. MODAL RENDER
// ─────────────────────────────────────────────────────
function _renderModal({ restId, restName, tariffKey, allTariffs, planFeatures, customFeatures, currentFeatures, db, t }) {
  const old = document.getElementById("sa-feat-modal");
  if (old) old.remove();

  _injectModalStyles();

  const tariffName = (allTariffs[tariffKey]?.name || tariffKey).toUpperCase();

  const featRows = ALL_FEATURES.map(f => {
    const inPlan    = planFeatures.includes(f.id);
    const inCustom  = customFeatures.some(c => {
      if (typeof c !== "string") return false;
      if (c.startsWith("+")) return c.slice(1) === f.id;
      if (c.startsWith("-")) return false;
      return c === f.id;
    });
    const blockedInCustom = customFeatures.some(c => typeof c === "string" && c === `-${f.id}`);
    const effective = currentFeatures.includes(f.id);
    const label = t(f.labelKey, f.labelDef);
    const planSuffix = t("sa_feat_plan_suffix", "tarifi");
    const addedWord = t("sa_feat_added_word", "qo'shgan");
    const removedWord = t("sa_feat_removed_word", "ayirgan");
    const superadminWord = t("sa_feat_legend_superadmin", "Superadmin");
    const emptyValue = t("empty_value", "—");

    return `
      <div class="sa-feat-row ${effective ? "sa-feat-on" : "sa-feat-off"}"
           data-feature="${f.id}" data-in-plan="${inPlan}" data-blocked="${blockedInCustom}" data-custom="${inCustom}">
        <div class="sa-feat-left">
          <span class="sa-feat-icon ${effective ? "sa-icon-on" : "sa-icon-off"}">
            <i class="fa-solid ${f.icon}"></i>
          </span>
          <div class="sa-feat-info">
            <span class="sa-feat-label">${label}</span>
            <span class="sa-feat-source">
              ${inPlan && !blockedInCustom
                  ? `<span class="sa-badge sa-badge-plan">📋 ${tariffName} ${planSuffix}</span>`
                  : ""}
              ${(inCustom || blockedInCustom)
                  ? `<span class="sa-badge sa-badge-custom">⭐ ${superadminWord} ${inCustom ? addedWord : removedWord}</span>`
                  : ""}
              ${!inPlan && !inCustom && !blockedInCustom
                  ? `<span class="sa-badge sa-badge-none">${emptyValue}</span>`
                  : ""}
            </span>
          </div>
        </div>
        <div class="sa-feat-controls">
          <button class="sa-feat-btn sa-feat-add ${inCustom && !inPlan ? "sa-active-btn" : ""}"
                  onclick="window._saFeatToggle('${restId}', '${f.id}', 'add')"
                  title="${t("sa_feat_add_title", "Qo'shimcha qo'shish")}">
            <i class="fa-solid fa-plus"></i> ${t("sa_feat_add_btn", "Qo'shish")}
          </button>
          <button class="sa-feat-btn sa-feat-remove ${blockedInCustom ? "sa-danger-btn" : ""}"
                  onclick="window._saFeatToggle('${restId}', '${f.id}', 'remove')"
                  title="${t("sa_feat_remove_title", "Ayirish")}">
            <i class="fa-solid fa-minus"></i> ${t("sa_feat_remove_btn", "Ayirish")}
          </button>
          <button class="sa-feat-btn sa-feat-reset"
                  onclick="window._saFeatToggle('${restId}', '${f.id}', 'reset')"
                  title="${t("sa_feat_reset_title", "Tarifga qaytarish")}">
            <i class="fa-solid fa-rotate-left"></i>
          </button>
        </div>
      </div>`;
  }).join("");

  const modal = document.createElement("div");
  modal.id = "sa-feat-modal";
  modal.className = "sa-feat-overlay";
  modal.innerHTML = `
    <div class="sa-feat-card">
      <!-- Header -->
      <div class="sa-feat-header">
        <div>
          <div class="sa-feat-rest-name">🏪 ${_esc(restName)}</div>
          <div class="sa-feat-subtitle">
            <span class="sa-tariff-badge">${tariffName}</span>
            ${t("sa_feat_subtitle", "Individual funksiyalarni boshqarish")}
          </div>
        </div>
        <button class="sa-feat-x" onclick="document.getElementById('sa-feat-modal').remove()">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <!-- Legend -->
      <div class="sa-feat-legend">
        <span><i class="fa-solid fa-circle-check" style="color:#10b981"></i> ${t("sa_feat_legend_active", "Faol")}</span>
        <span><i class="fa-solid fa-circle-xmark" style="color:#ef4444"></i> ${t("sa_feat_legend_blocked", "Bloklangan")}</span>
        <span class="sa-badge sa-badge-plan">📋 ${t("sa_feat_legend_in_plan", "Tarifda bor")}</span>
        <span class="sa-badge sa-badge-custom">⭐ ${t("sa_feat_legend_superadmin", "Superadmin")}</span>
      </div>

      <!-- Rows -->
      <div class="sa-feat-list" id="sa-feat-list-${restId}">
        ${featRows}
      </div>

      <!-- Footer -->
      <div class="sa-feat-footer">
        <div class="sa-feat-hint">
          <i class="fa-solid fa-circle-info"></i>
          ${t("sa_feat_footer_hint", "O'zgarishlar <strong>darhol</strong> restorandagi barcha rollarga (admin, chef, waiter) ta'sir qiladi.")}
        </div>
        <button class="sa-feat-close-btn" onclick="document.getElementById('sa-feat-modal').remove()">
          ${t("close_btn", "Yopish")}
        </button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });

  // DB ni modal scope ga saqlash
  modal._db = db;
  modal._allTariffs = allTariffs;
}

// ─────────────────────────────────────────────────────
// 5. TOGGLE HANDLER (add / remove / reset)
//    Firebase'ga yozib, UI'ni yangilaydi
// ─────────────────────────────────────────────────────
window._saFeatToggle = async function(restId, featureId, action) {
  const db = window.db;
  const t  = window.t || ((k, d) => d || k);
  if (!db || !restId || !featureId) return;

  const snap = await get(ref(db, `restaurants/${restId}/subscription/customFeatures`));
  let custom = Array.isArray(snap.val()) ? snap.val() : [];

  // Eski formatni tozalash
  custom = custom.filter(c => {
    if (typeof c !== "string") return false;
    const clean = c.replace(/^[+-]/, "");
    return clean !== featureId;
  });

  if (action === "add")    custom.push(`+${featureId}`);
  if (action === "remove") custom.push(`-${featureId}`);
  // "reset" → shunchaki olib tashlanadi (tarif qoidasi ishlaydi)

  // Firebase ga yozish
  const tariffKey = ((await get(ref(db, `restaurants/${restId}/info/tariff`))).val() || "start").toLowerCase();
  const allTariffs = window.allTariffs || {};
  const planFeatures = Array.isArray(allTariffs[tariffKey]?.features) ? allTariffs[tariffKey].features : [];
  const effective = _computeEffective(planFeatures, custom);

  await Promise.all([
    // customFeatures saqlash
    set(ref(db, `restaurants/${restId}/subscription/customFeatures`), custom),
    // yakuniy features ni ham yozamiz (plan_features.js listeneri uchun)
    update(ref(db, `restaurants/${restId}/subscription`), { features: effective }),
    // restaurants_meta ham yangilash
    update(ref(db, `restaurants_meta/${restId}/subscription`), { features: effective, customFeatures: custom })
  ]);

  // Modal'ni yangilash
  const modal = document.getElementById("sa-feat-modal");
  if (modal) {
    const restSnap = await get(ref(db, `restaurants/${restId}`));
    if (restSnap.exists()) {
      const rest = restSnap.val();
      window.openRestaurantFeaturesModal(restId);
    }
  }

  // Toast xabari
  _showToast(
    action === "add"    ? t("sa_feat_toggle_added", "✅ {feature} qo'shildi").replace("{feature}", featureId) :
    action === "remove" ? t("sa_feat_toggle_removed", "🚫 {feature} ayirildi").replace("{feature}", featureId) :
                          t("sa_feat_toggle_reset", "↩️ {feature} tarifga qaytarildi").replace("{feature}", featureId),
    action === "remove" ? "danger" : "success"
  );
};

// ─────────────────────────────────────────────────────
// 6. RESTORAN TABLE GA "Features" TUGMASI QO'SHISH
//    superadmin.js renderRestaurantsTable dan keyin chaqiriladi
// ─────────────────────────────────────────────────────
window.injectFeaturesButtonToTable = function() {
  const t = window.t || ((k, d) => d || k);
  document.querySelectorAll("[data-rest-id]").forEach(row => {
    const restId = row.dataset.restId;
    if (!restId || row.querySelector(".sa-open-features-btn")) return;

    const td = document.createElement("td");
    td.innerHTML = `
      <button class="sa-open-features-btn"
              onclick="window.openRestaurantFeaturesModal('${restId}')"
              title="${t("sa_feat_manage_title", "Funksiyalarni boshqarish")}"
              style="background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;
                     border:none;border-radius:8px;padding:5px 10px;
                     font-size:12px;font-weight:600;cursor:pointer;
                     display:inline-flex;align-items:center;gap:5px;
                     white-space:nowrap;">
        <i class="fa-solid fa-sliders"></i> ${t("sa_feat_col_label", "Features")}
      </button>`;
    row.appendChild(td);
  });
};

// ─────────────────────────────────────────────────────
// 7. TOAST XABARI
// ─────────────────────────────────────────────────────
function _showToast(msg, type = "success") {
  const t = document.createElement("div");
  t.style.cssText = `
    position:fixed;bottom:24px;right:24px;z-index:999999;
    padding:12px 20px;border-radius:12px;font-size:14px;font-weight:600;
    color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.2);
    background:${type === "danger" ? "#ef4444" : type === "warning" ? "#f59e0b" : "#10b981"};
    animation:pf-pop .3s ease;
    max-width:320px;
  `;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─────────────────────────────────────────────────────
// 8. CSS
// ─────────────────────────────────────────────────────
function _injectModalStyles() {
  if (document.getElementById("sa-feat-styles")) return;
  const s = document.createElement("style");
  s.id = "sa-feat-styles";
  s.textContent = `
    @keyframes sa-slide-up {
      from { transform:translateY(40px);opacity:0 }
      to   { transform:translateY(0);   opacity:1 }
    }

    .sa-feat-overlay {
      position:fixed;inset:0;z-index:99998;
      background:rgba(15,23,42,.65);
      display:flex;align-items:center;justify-content:center;
      backdrop-filter:blur(6px);
      padding:16px;
    }

    .sa-feat-card {
      background:#fff;
      border-radius:20px;
      width:100%;max-width:620px;
      max-height:90vh;
      display:flex;flex-direction:column;
      box-shadow:0 30px 100px rgba(0,0,0,.35);
      animation:sa-slide-up .35s cubic-bezier(.34,1.36,.64,1);
      overflow:hidden;
    }

    /* Header */
    .sa-feat-header {
      padding:24px 24px 16px;
      background:linear-gradient(135deg,#1e293b,#0f172a);
      color:#fff;
      display:flex;align-items:flex-start;justify-content:space-between;
      gap:16px;
    }
    .sa-feat-rest-name {
      font-size:18px;font-weight:800;margin-bottom:6px;
    }
    .sa-feat-subtitle {
      font-size:13px;color:#94a3b8;
      display:flex;align-items:center;gap:8px;
    }
    .sa-tariff-badge {
      background:linear-gradient(135deg,#6366f1,#4f46e5);
      color:#fff;font-size:11px;font-weight:700;
      padding:3px 10px;border-radius:20px;
    }
    .sa-feat-x {
      background:rgba(255,255,255,.1);border:none;
      width:32px;height:32px;border-radius:8px;
      color:#94a3b8;cursor:pointer;font-size:16px;
      display:flex;align-items:center;justify-content:center;
      transition:background .2s;flex-shrink:0;
    }
    .sa-feat-x:hover { background:rgba(255,255,255,.2);color:#fff; }

    /* Legend */
    .sa-feat-legend {
      padding:10px 24px;
      background:#f8fafc;border-bottom:1px solid #e2e8f0;
      display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:#64748b;
      align-items:center;
    }

    /* Badges */
    .sa-badge {
      display:inline-flex;align-items:center;gap:4px;
      font-size:11px;font-weight:600;
      padding:2px 8px;border-radius:20px;
    }
    .sa-badge-plan    { background:#dbeafe;color:#1d4ed8; }
    .sa-badge-custom  { background:#fef3c7;color:#92400e; }
    .sa-badge-none    { background:#f1f5f9;color:#94a3b8; }

    /* List */
    .sa-feat-list {
      flex:1;overflow-y:auto;padding:8px 0;
    }
    .sa-feat-list::-webkit-scrollbar { width:4px; }
    .sa-feat-list::-webkit-scrollbar-thumb { background:#e2e8f0;border-radius:2px; }

    /* Row */
    .sa-feat-row {
      display:flex;align-items:center;justify-content:space-between;
      padding:14px 24px;gap:12px;
      border-bottom:1px solid #f1f5f9;
      transition:background .15s;
    }
    .sa-feat-row:hover   { background:#f8fafc; }
    .sa-feat-on          { background:#fafff8; }
    .sa-feat-off         { background:#fffbf8; }

    .sa-feat-left {
      display:flex;align-items:center;gap:12px;flex:1;min-width:0;
    }
    .sa-feat-icon {
      width:38px;height:38px;border-radius:10px;flex-shrink:0;
      display:flex;align-items:center;justify-content:center;font-size:16px;
    }
    .sa-icon-on  { background:#dcfce7;color:#16a34a; }
    .sa-icon-off { background:#fee2e2;color:#ef4444; }

    .sa-feat-info { min-width:0; }
    .sa-feat-label {
      display:block;font-size:14px;font-weight:700;color:#1e293b;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .sa-feat-source {
      display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;
    }

    /* Controls */
    .sa-feat-controls {
      display:flex;gap:6px;flex-shrink:0;
    }
    .sa-feat-btn {
      display:inline-flex;align-items:center;gap:4px;
      padding:6px 12px;border:1px solid #e2e8f0;
      border-radius:8px;background:#fff;
      font-size:12px;font-weight:600;
      cursor:pointer;white-space:nowrap;
      transition:all .15s;color:#475569;
    }
    .sa-feat-btn:hover { background:#f1f5f9; }

    .sa-feat-add:hover,
    .sa-active-btn {
      background:#dcfce7!important;color:#16a34a!important;
      border-color:#6ee7b7!important;
    }
    .sa-feat-remove:hover,
    .sa-danger-btn {
      background:#fee2e2!important;color:#ef4444!important;
      border-color:#fca5a5!important;
    }
    .sa-feat-reset { padding:6px 10px;color:#94a3b8; }
    .sa-feat-reset:hover { color:#6366f1;background:#ede9fe!important;border-color:#a5b4fc!important; }

    /* Footer */
    .sa-feat-footer {
      padding:16px 24px;
      background:#f8fafc;border-top:1px solid #e2e8f0;
      display:flex;align-items:center;justify-content:space-between;gap:16px;
      flex-wrap:wrap;
    }
    .sa-feat-hint {
      font-size:12px;color:#64748b;
      display:flex;align-items:center;gap:6px;flex:1;min-width:0;
    }
    .sa-feat-hint i { color:#6366f1;flex-shrink:0; }
    .sa-feat-close-btn {
      background:linear-gradient(135deg,#1e293b,#0f172a);
      color:#fff;border:none;border-radius:10px;
      padding:10px 24px;font-size:14px;font-weight:700;
      cursor:pointer;transition:opacity .15s;white-space:nowrap;
    }
    .sa-feat-close-btn:hover { opacity:.85; }

    @media(max-width:480px) {
      .sa-feat-controls { flex-direction:column; }
      .sa-feat-row { flex-direction:column;align-items:flex-start; }
    }
  `;
  document.head.appendChild(s);
}

function _esc(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ─────────────────────────────────────────────────────
// 9. RESTORAN JADVALINI PATCH QILISH
//    renderRestaurantsTable chaqirilgandan keyin avtomatik trigger
// ─────────────────────────────────────────────────────
(function patchRenderRestaurantsTable() {
  const orig = window.renderRestaurantsTable;
  if (typeof orig !== "function") {
    document.addEventListener("DOMContentLoaded", () => {
      const fn = window.renderRestaurantsTable;
      if (typeof fn === "function") {
        window.renderRestaurantsTable = function(...args) {
          const result = fn.apply(this, args);
          setTimeout(window.injectFeaturesButtonToTable, 100);
          return result;
        };
      }
    });
    return;
  }
  window.renderRestaurantsTable = function(...args) {
    const result = orig.apply(this, args);
    setTimeout(window.injectFeaturesButtonToTable, 100);
    return result;
  };
})();

// ─────────────────────────────────────────────────────
// 10. EKSPORT
// ─────────────────────────────────────────────────────
export { ALL_FEATURES, _computeEffective };