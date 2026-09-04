// shopping-planner.js
// 🛒 Bozorlik / Smart Procurement Planner — Ombor sub-tabi.
// Ombor zaxirasi, retseptlar, sotuv tarixi va Production Planner'ning
// rezervlangan resurslaridan foydalanib, avtomatik xarid ro'yxati tuziladi.
// Hech qanday yangi ma'lumot nusxalanmaydi — faqat shoppingHistory/{id} yozuvi qo'shiladi.

import { t } from "./i18n.js";
import { db } from "./firebase.js";
import { exportRowsToExcel, buildExportFilename } from "./exportUtils.js";
import {
  ref, get, push, set
} from "./pgRtdb.js";
import {
  ppComputeReserved, ppMaxPortions, ppAvgDailySales, ppSameWeekdayAvg,
  ppGetPlannableMenuItems, ppPlannedQty, ppLoadPlan, ppGetRequirementPerPortion,
  menuName, todayStr, fmt
} from "./production-planner.js";

function restId() {
  return localStorage.getItem("restaurantId") || window.currentRestaurantId || "";
}

// Production Security Fix Pass, Phase 3 — spPrintFromCalc() below builds an
// HTML string via document.write() with ingredient names pulled straight
// from Firebase (staff-editable inventory data) with no escaping; any staff
// account that can rename an ingredient could inject markup that runs in
// whichever staff member's browser next prints the shopping list.
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function basePath() {
  return `restaurants/${restId()}`;
}
function tt(key, fallback) {
  if (typeof t !== "function") return fallback;
  const result = t(key, fallback);
  // Ba'zi i18n implementatsiyalari topilmagan kalit uchun
  // fallback o'rniga kalitning o'zini qaytaradi — buni ushlab olamiz.
  if (result === undefined || result === null || result === key) {
    return fallback;
  }
  return result;
}
function spToast(msg, type = "success") {
  let box = document.getElementById("sp-toast-box");
  if (!box) {
    box = document.createElement("div");
    box.id = "sp-toast-box";
    box.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;";
    document.body.appendChild(box);
  }
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText = `padding:10px 16px;border-radius:8px;color:#fff;font-size:13.5px;box-shadow:0 4px 14px rgba(0,0,0,.2);background:${type === "error" ? "#e5484d" : type === "warning" ? "#f2994a" : "#2e9e6c"};`;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ==========================================
// 📦 STATE
// ==========================================
const SP = {
  periodDays: 7,
  periodLabel: "7d",
  simMultiplier: 1,
  simActive: false,
  activeTab: "overview",
  lastCalc: null,
  history: null,
  inited: false
};

const PERIOD_PRESETS = [
  { id: "today", days: 1, key: "pp_period_today", fb: "Bugun" },
  { id: "1w", days: 7, key: "pp_period_1w", fb: "1 hafta" },
  { id: "2w", days: 14, key: "pp_period_2w", fb: "2 hafta" },
  { id: "1m", days: 30, key: "pp_period_1m", fb: "1 oy" },
  { id: "3m", days: 90, key: "pp_period_3m", fb: "3 oy" },
  { id: "6m", days: 180, key: "pp_period_6m", fb: "6 oy" },
  { id: "1y", days: 365, key: "pp_period_1y", fb: "1 yil" }
];

const PRIORITY_META = {
  critical: { key: "critical", fb: "Kritik", color: "#e5484d" },
  high: { key: "high", fb: "Yuqori", color: "#f2994a" },
  medium: { key: "medium", fb: "O'rta", color: "#e8b923" },
  low: { key: "low", fb: "Past", color: "#2e9e6c" }
};

// ==========================================
// 🧮 HISOBLASH YADROSI
// ==========================================
async function spGetDailyUsageAverages() {
  const averages = new Map();
  try {
    const snap = await get(ref(db, `${basePath()}/dailyUsage`));
    if (!snap.exists()) return averages;
    const data = snap.val();
    const dates = Object.keys(data).sort().slice(-30);
    const totals = new Map();
    for (const d of dates) {
      for (const [ingId, val] of Object.entries(data[d] || {})) {
        totals.set(ingId, (totals.get(ingId) || 0) + Number(val || 0));
      }
    }
    for (const [ingId, total] of totals) {
      averages.set(ingId, total / Math.max(1, dates.length));
    }
  } catch (e) { /* dailyUsage ixtiyoriy signal */ }
  return averages;
}

/** Retsept + sotuv tezligi asosida taxminiy kunlik sarf (dailyUsage tarixi yo'q masalliqlar uchun) */
async function spProjectedUsageFromRecipes() {
  const projected = new Map();
  const menuIds = await ppGetPlannableMenuItems();
  for (const menuId of menuIds) {
    const req = await ppGetRequirementPerPortion(menuId);
    const avgSales = ppAvgDailySales(menuId, 30);
    if (avgSales <= 0) continue;
    for (const [ingId, perPortion] of req.ing) {
      projected.set(ingId, (projected.get(ingId) || 0) + perPortion * avgSales);
    }
  }
  return projected;
}

function spPriorityFor(daysRemaining) {
  if (!isFinite(daysRemaining)) return "low";
  if (daysRemaining < 2) return "critical";
  if (daysRemaining < 5) return "high";
  if (daysRemaining < 14) return "medium";
  return "low";
}

async function spComputeAll(periodDays, simMultiplier = 1) {
  const inv = window.allInventory || {};
  const { reservedIng } = await ppComputeReserved(null);
  const dailyAvg = await spGetDailyUsageAverages();
  const projectedAvg = await spProjectedUsageFromRecipes();

  const items = [];
  for (const [ingId, ing] of Object.entries(inv)) {
    const historical = dailyAvg.get(ingId) || 0;
    const projected = projectedAvg.get(ingId) || 0;
    const baseUsage = historical > 0 ? historical : projected;
    const avgDailyUsage = baseUsage * simMultiplier;

    const stock = Number(ing.stock || 0);
    const reserved = reservedIng.get(ingId) || 0;
    const safetyStock = Number(ing.minStock || 0);
    const required = avgDailyUsage * periodDays + reserved + safetyStock;
    const toBuy = Math.max(0, required - stock);
    const daysRemaining = avgDailyUsage > 0 ? Math.max(0, (stock - reserved) / avgDailyUsage) : Infinity;
    const priority = spPriorityFor(daysRemaining);
    const price = Number(ing.price || 0);
    const estCost = toBuy * price;

    if (avgDailyUsage <= 0 && stock <= 0) continue; // hech qachon ishlatilmagan va zaxirasi yo'q masalliq — ro'yxatga kiritilmaydi

    items.push({
      id: ingId, name: menuName(ing) || ingId, unit: ing.unit || "",
      stock, required, toBuy, reserved, safetyStock, avgDailyUsage,
      daysRemaining, priority, estCost
    });
  }

  items.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    if (order[a.priority] !== order[b.priority]) return order[a.priority] - order[b.priority];
    return a.daysRemaining - b.daysRemaining;
  });

  const shoppingItems = items.filter(i => i.toBuy > 0);
  const sufficient = shoppingItems.length === 0;
  const finiteDays = items.filter(i => isFinite(i.daysRemaining)).map(i => i.daysRemaining);
  const minDaysRemaining = finiteDays.length ? Math.min(...finiteDays) : Infinity;
  const totalEstCost = shoppingItems.reduce((a, i) => a + i.estCost, 0);

  return { items, shoppingItems, sufficient, minDaysRemaining, totalEstCost };
}

// ==========================================
// 📈 AQLLI TAVSIYA — hafta kuni bo'yicha talab tahlili
// ==========================================
async function spWeekdayInsight() {
  const menuIds = await ppGetPlannableMenuItems();
  let boosted = [];
  for (const menuId of menuIds) {
    const avg7 = ppAvgDailySales(menuId, 7);
    const sameDow = ppSameWeekdayAvg(menuId);
    if (avg7 > 0 && sameDow > avg7 * 1.2) {
      boosted.push({ menuId, name: menuName(window.allMenu[menuId]), ratio: sameDow / avg7 });
    }
  }
  return boosted.sort((a, b) => b.ratio - a.ratio).slice(0, 5);
}

// ==========================================
// 🔔 BILDIRISHNOMALAR
// ==========================================
async function spCheckNotifications(calc) {
  const guardKey = `sp_notified_${todayStr()}`;
  if (localStorage.getItem(guardKey)) return;
  let notified = false;

  const criticalItems = calc.shoppingItems.filter(i => i.priority === "critical");
  if (criticalItems.length && typeof window.addNotification === "function") {
    window.addNotification({
      category: "warehouse", type: "error", icon: "fa-solid fa-triangle-exclamation",
      titleKey: "sp_notif_critical",
      title: tt("sp_notif_critical", "Bir nechta masalliq tanqis holatda — xarid zarur!"),
      link: "warehouse"
    });
    notified = true;
  }

  try {
    await ppLoadPlan(todayStr());
    const menuIds = await ppGetPlannableMenuItems();
    for (const menuId of menuIds) {
      const planned = ppPlannedQty(menuId);
      if (planned <= 0) continue;
      const { max } = await ppMaxPortions(menuId);
      if (max < planned) {
        if (typeof window.addNotification === "function") {
          window.addNotification({
            category: "warehouse", type: "warning", icon: "fa-solid fa-kitchen-set",
            titleKey: "sp_notif_production_risk",
            title: tt("sp_notif_production_risk", "Bugungi ishlab chiqarish rejasi ombor zaxirasi bilan to'liq bajarilmasligi mumkin"),
            link: "production-planner"
          });
        }
        notified = true;
        break;
      }
    }
  } catch (e) { /* production planner rejasi mavjud bo'lmasa — jim o'tkaziladi */ }

  if (notified) localStorage.setItem(guardKey, "1");
}

// ==========================================
// 💾 XARID TARIXI (shoppingHistory)
// ==========================================
async function spSaveHistory(calc) {
  const entry = {
    createdBy: localStorage.getItem("staffName") || localStorage.getItem("userName") || "admin",
    createdAt: Date.now(),
    periodDays: SP.periodDays,
    periodLabel: SP.periodLabel,
    items: calc.shoppingItems.map(i => ({
      ingId: i.id, name: i.name, unit: i.unit, currentStock: i.stock,
      required: Math.round(i.required * 100) / 100, toBuy: Math.round(i.toBuy * 100) / 100,
      priority: i.priority, daysRemaining: isFinite(i.daysRemaining) ? Math.round(i.daysRemaining * 10) / 10 : null,
      estCost: Math.round(i.estCost)
    })),
    totalEstCost: Math.round(calc.totalEstCost),
    imported: null
  };
  try {
    const listRef = ref(db, `${basePath()}/shoppingHistory`);
    const newRef = push(listRef);
    await set(newRef, entry);
    spToast(tt("sp_history_saved", "Xarid ro'yxati tarixga saqlandi"));
    return newRef.key;
  } catch (e) {
    console.warn("Shopping history save error:", e);
    spToast(tt("pp_save_error", "Saqlashda xatolik yuz berdi"), "error");
    return null;
  }
}

async function spLoadHistory() {
  try {
    const snap = await get(ref(db, `${basePath()}/shoppingHistory`));
    SP.history = snap.exists() ? snap.val() : {};
  } catch (e) {
    SP.history = {};
  }
  return SP.history;
}

async function spMarkImported(entryId, ingId, qty) {
  qty = Math.max(0, Number(qty) || 0);
  try {
    const entrySnap = await get(ref(db, `${basePath()}/shoppingHistory/${entryId}/imported`));
    const imported = entrySnap.exists() ? entrySnap.val() : {};
    imported[ingId] = qty;
    await set(ref(db, `${basePath()}/shoppingHistory/${entryId}/imported`), imported);
    spToast(tt("sp_import_saved", "Import qilingan miqdor saqlandi"));
  } catch (e) {
    console.warn("Mark imported error:", e);
  }
}

// ==========================================
// 🖨️ EXPORT — Print / PDF / Excel
// ==========================================
function spExportRows(calc) {
  return calc.shoppingItems.map(i => ({
    [tt("col_ingredient", "Masalliq")]: i.name,
    [tt("available_stock", "Mavjud zaxira")]: fmt(i.stock) + " " + i.unit,
    [tt("required_quantity", "Kerakli miqdor")]: fmt(Math.round(i.required)) + " " + i.unit,
    [tt("purchase_quantity", "Xarid miqdori")]: fmt(Math.round(i.toBuy)) + " " + i.unit,
    [tt("shopping_priority", "Muhimlik")]: tt(PRIORITY_META[i.priority].key, PRIORITY_META[i.priority].fb),
    [tt("remaining_days", "Qolgan kunlar")]: isFinite(i.daysRemaining) ? Math.round(i.daysRemaining * 10) / 10 : "—",
    [tt("estimated_cost", "Taxminiy narx")]: fmt(Math.round(i.estCost))
  }));
}

function spExcelFromCalc(calc) {
  if (!calc || typeof XLSX === "undefined") return;
  const rows = spExportRows(calc);
  exportRowsToExcel({
    rows,
    sheetName: tt("shopping_list", "Xarid ro'yxati"),
    filename: buildExportFilename(tt("sp_export_filename", "bozorlik"), todayStr()),
    wrapColumns: [tt("col_ingredient", "Masalliq")],
  });
}

function spPdfFromCalc(calc) {
  if (!calc || typeof jsPDF === "undefined") return;
  const pdf = new jsPDF("landscape");
  const rows = calc.shoppingItems.map(i => [
    i.name, `${fmt(i.stock)} ${i.unit}`, `${fmt(Math.round(i.required))} ${i.unit}`,
    `${fmt(Math.round(i.toBuy))} ${i.unit}`, tt(PRIORITY_META[i.priority].key, PRIORITY_META[i.priority].fb),
    isFinite(i.daysRemaining) ? Math.round(i.daysRemaining * 10) / 10 : "—", fmt(Math.round(i.estCost))
  ]);
  pdf.setFontSize(14);
  pdf.text(tt("shopping_list", "Xarid ro'yxati") + " — " + todayStr(), 10, 12);
  if (typeof pdf.autoTable === "function") {
    pdf.autoTable({
      startY: 18,
      head: [[tt("col_ingredient", "Masalliq"), tt("available_stock", "Mavjud"), tt("required_quantity", "Kerak"),
      tt("purchase_quantity", "Xarid"), tt("shopping_priority", "Muhimlik"), tt("remaining_days", "Kun"), tt("estimated_cost", "Narx")]],
      body: rows
    });
  }
  pdf.save(`${tt("sp_export_filename", "bozorlik")}_${todayStr()}.pdf`);
}

function spPrintFromCalc(calc) {
  if (!calc) return;
  const rows = calc.shoppingItems.map(i => `<tr>
    <td>${escapeHtml(i.name)}</td><td>${fmt(i.stock)} ${escapeHtml(i.unit)}</td><td>${fmt(Math.round(i.required))} ${escapeHtml(i.unit)}</td>
    <td>${fmt(Math.round(i.toBuy))} ${escapeHtml(i.unit)}</td><td>${tt(PRIORITY_META[i.priority].key, PRIORITY_META[i.priority].fb)}</td>
    <td>${isFinite(i.daysRemaining) ? Math.round(i.daysRemaining * 10) / 10 : "—"}</td><td>${fmt(Math.round(i.estCost))}</td>
  </tr>`).join("");
  const html = `<html><head><title>${tt("shopping_list", "Xarid ro'yxati")}</title>
    <style>body{font-family:sans-serif;padding:20px;} table{width:100%;border-collapse:collapse;} th,td{border:1px solid #ccc;padding:6px 10px;text-align:left;font-size:13px;}</style>
    </head><body onload="window.print()">
    <h2>${tt("shopping_list", "Xarid ro'yxati")} — ${todayStr()}</h2>
    <table><thead><tr>
      <th>${tt("col_ingredient", "Masalliq")}</th><th>${tt("available_stock", "Mavjud")}</th><th>${tt("required_quantity", "Kerak")}</th>
      <th>${tt("purchase_quantity", "Xarid")}</th><th>${tt("shopping_priority", "Muhimlik")}</th><th>${tt("remaining_days", "Kun")}</th><th>${tt("estimated_cost", "Narx")}</th>
    </tr></thead><tbody>${rows}</tbody></table>
    </body></html>`;
  const w = window.open("", "_blank");
  // Sever window.opener so this popup's (fully-escaped, but
  // document.write-based) content can never reach back into the page that
  // opened it — same hardening as receiptEngine.js's printReceiptInPopup().
  // NOTE: passing "noopener" directly in the window.open() features string
  // would do this too, but per spec makes window.open() return null instead
  // of the new window — which would break the document.write() below that
  // needs a live reference. Setting .opener = null after the fact achieves
  // the same isolation without losing that reference.
  if (w) w.opener = null;
  w?.document.write(html);
  w?.document.close();
}

window._spExportExcel = function () { spExcelFromCalc(SP.lastCalc); };
window._spExportPdf = function () { spPdfFromCalc(SP.lastCalc); };
window._spPrint = function () { spPrintFromCalc(SP.lastCalc); };

// ==========================================
// 🖥️ RENDER
// ==========================================
function spTabsHtml() {
  const tabs = [
    ["overview", "pp_tab_dashboard", "Umumiy holat"],
    ["list", "shopping_list", "Xarid ro'yxati"],
    ["whatif", "pp_tab_simulation", "Nima bo'lardi (What-if)"],
    ["history", "shopping_history", "Tarix"]
  ];
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
    ${tabs.map(([id, key, fb]) => `
      <button class="kassa-subtab-btn${SP.activeTab === id ? " active" : ""}" data-i18n="${key}" onclick="window._spSwitchTab('${id}')">${tt(key, fb)}</button>
    `).join("")}
  </div>`;
}

function spPeriodBarHtml() {
  return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
    <label data-i18n="planning_period">${tt("planning_period", "Rejalashtirish davri")}:</label>
    ${PERIOD_PRESETS.map(p => `<button class="kassa-subtab-btn${SP.periodLabel === p.id ? " active" : ""}"
      data-i18n="${p.key}" onclick="window._spSetPeriod('${p.id}', ${p.days})">${tt(p.key, p.fb)}</button>`).join("")}
    <input type="number" min="1" id="sp-custom-days" placeholder="${tt("custom_period", "Maxsus...")}"
      value="${!PERIOD_PRESETS.find(p => p.id === SP.periodLabel) ? SP.periodDays : ""}"
      style="width:100px;padding:5px 8px;border-radius:6px;border:1px solid var(--border,#ccc);">
    <button class="btn btn-primary" onclick="window._spApplyCustomPeriod()" data-i18n="sp_apply_period">${tt("sp_apply_period", "Qo'llash")}</button>
  </div>`;
}

window._spSetPeriod = function (id, days) {
  SP.periodLabel = id;
  SP.periodDays = days;
  spRenderTabContent();
};
window._spApplyCustomPeriod = function () {
  const val = Number(document.getElementById("sp-custom-days")?.value);
  if (val > 0) {
    SP.periodLabel = "custom";
    SP.periodDays = val;
    spRenderTabContent();
  }
};

async function spRenderRoot() {
  const root = document.getElementById("sp-root");
  if (!root) return;
  root.innerHTML = `
    <h2 data-i18n="shopping_planner">${tt("shopping_planner", "Bozorlik")}</h2>
    ${spTabsHtml()}
    <div id="sp-tab-content">${tt("pp_loading", "Yuklanmoqda...")}</div>
  `;
  spRenderTabContent();
}

window._spSwitchTab = function (tabId) {
  SP.activeTab = tabId;
  spRenderRoot();
};

async function spRenderTabContent() {
  const el = document.getElementById("sp-tab-content");
  if (!el) return;
  el.innerHTML = `<div style="padding:30px;text-align:center;color:var(--muted,#888);">${tt("pp_loading", "Yuklanmoqda...")}</div>`;
  try {
    if (SP.activeTab === "overview") await spRenderOverview(el);
    else if (SP.activeTab === "list") await spRenderList(el);
    else if (SP.activeTab === "whatif") await spRenderWhatIf(el);
    else if (SP.activeTab === "history") await spRenderHistory(el);
  } catch (e) {
    console.error("Shopping planner render error:", e);
    el.innerHTML = `<div style="padding:20px;color:#e5484d;">${tt("pp_render_error", "Bo'limni yuklashda xatolik yuz berdi")}</div>`;
  }
}

function spStatCard(key, fallback, value, color) {
  return `<div class="pp-stat-card" style="background:var(--card-bg,#fff);border-radius:10px;padding:14px 16px;box-shadow:0 1px 4px rgba(0,0,0,.08);">
    <div style="font-size:12.5px;color:var(--muted,#888);" data-i18n="${key}">${tt(key, fallback)}</div>
    <div style="font-size:22px;font-weight:700;${color ? `color:${color};` : ""}">${value}</div>
  </div>`;
}

async function spRenderOverview(el) {
  el.innerHTML = spPeriodBarHtml() + `<div id="sp-overview-body">${tt("pp_loading", "Yuklanmoqda...")}</div>`;
  const body = document.getElementById("sp-overview-body");
  const calc = await spComputeAll(SP.periodDays, SP.simMultiplier);
  SP.lastCalc = calc;
  spCheckNotifications(calc);
  const insight = await spWeekdayInsight();

  const verdictHtml = calc.sufficient
    ? `<div class="admin-alert admin-alert--success">
        <div class="admin-alert-title" data-i18n="warehouse_sufficient">${tt("warehouse_sufficient", "Ombor zaxirasi yetarli.")}</div>
        <div class="admin-alert-body" data-i18n="shopping_not_required">${tt("shopping_not_required", "Hozircha xarid qilish shart emas.")}</div>
        <div class="admin-alert-body" style="margin-top:8px;" data-i18n="estimated_duration">${tt("estimated_duration", "Taxminiy davomiylik")}: <b>${isFinite(calc.minDaysRemaining) ? Math.round(calc.minDaysRemaining) : "—"} ${tt("sp_days_unit", "kun")}</b></div>
      </div>`
    : `<div class="admin-alert admin-alert--danger">
        <div class="admin-alert-title" data-i18n="warehouse_insufficient">${tt("warehouse_insufficient", "Ombor zaxirasi yetarli emas.")}</div>
        <div class="admin-alert-body" data-i18n="shopping_required">${tt("shopping_required", "Xarid qilish tavsiya etiladi.")}</div>
      </div>`;

  el.innerHTML = spPeriodBarHtml() + `
    <div id="sp-overview-body">
      ${verdictHtml}
      <div class="pp-cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:22px;">
        ${spStatCard("pp_stat_warnings", "Kritik masalliqlar", calc.shoppingItems.filter(i => i.priority === "critical").length, "#e5484d")}
        ${spStatCard("shopping_list", "Xarid kerak bo'lgan masalliqlar", calc.shoppingItems.length)}
        ${spStatCard("estimated_cost", "Taxminiy xarajat", fmt(Math.round(calc.totalEstCost)) + " " + tt("currency", "so'm"))}
      </div>
      ${insight.length ? `<div style="background:var(--card-bg,#fff);border-radius:10px;padding:14px 16px;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:16px;">
        <div style="font-weight:600;margin-bottom:6px;" data-i18n="sp_smart_recommendation">${tt("sp_smart_recommendation", "Aqlli tavsiya")}</div>
        ${insight.map(x => `<div>${x.name}: ${tt("sp_weekday_busy", "bugungi hafta kunida odatdagidan ko'proq sotiladi")} (×${x.ratio.toFixed(1)})</div>`).join("")}
      </div>` : ""}
      <button class="btn btn-primary" onclick="window._spSaveAndGoList()" data-i18n="generate_shopping_list">${tt("generate_shopping_list", "Xarid ro'yxatini shakllantirish")}</button>
    </div>
  `;
}

window._spSaveAndGoList = function () {
  SP.activeTab = "list";
  spRenderRoot();
};

function spPriorityBadge(priority) {
  const meta = PRIORITY_META[priority];
  return `<span data-i18n="${meta.key}" style="color:#fff;background:${meta.color};padding:2px 8px;border-radius:10px;font-size:11.5px;font-weight:600;">${tt(meta.key, meta.fb)}</span>`;
}

async function spRenderList(el) {
  if (!SP.lastCalc) SP.lastCalc = await spComputeAll(SP.periodDays, SP.simMultiplier);
  const calc = SP.lastCalc;

  el.innerHTML = `
    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
      <button class="btn btn-primary" onclick="window._spDoSaveHistory()" data-i18n="generate_shopping_list">${tt("generate_shopping_list", "Ro'yxatni saqlash")}</button>
      <button class="btn" onclick="window._spPrint()" data-i18n="print_shopping_list">${tt("print_shopping_list", "Chop etish")}</button>
      <button class="btn" onclick="window._spExportPdf()" data-i18n="export_pdf">${tt("export_pdf", "PDF eksport")}</button>
      <button class="btn" onclick="window._spExportExcel()" data-i18n="export_excel">${tt("export_excel", "Excel eksport")}</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px;">
      ${calc.shoppingItems.map(i => spShoppingItemCard(i)).join("") || `<div style="padding:18px;color:var(--muted,#888);text-align:center;" data-i18n="pp_no_shortage">${tt("pp_no_shortage", "Hozircha yetishmovchilik yo'q")}</div>`}
    </div>
  `;
}

/** Bitta xarid mahsuloti uchun card ko'rinishi — Kerak / Omborda / Sotib olish */
function spShoppingItemCard(i) {
  const meta = PRIORITY_META[i.priority];
  return `<div style="background:var(--card-bg,#fff);border-radius:12px;padding:16px 20px;box-shadow:0 2px 8px rgba(0,0,0,.06);border-left:4px solid ${meta.color};">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
      <div style="font-weight:700;font-size:15.5px;">🛒 ${i.name}</div>
      ${spPriorityBadge(i.priority)}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:${isFinite(i.daysRemaining) ? "10px" : "0"};">
      <div>
        <div style="font-size:12px;color:var(--muted,#888);" data-i18n="required_quantity">${tt("required_quantity", "Kerak")}</div>
        <div style="font-weight:600;">${fmt(Math.round(i.required))} ${i.unit}</div>
      </div>
      <div>
        <div style="font-size:12px;color:var(--muted,#888);" data-i18n="available_stock">${tt("available_stock", "Omborda")}</div>
        <div style="font-weight:600;">${fmt(i.stock)} ${i.unit}</div>
      </div>
      <div>
        <div style="font-size:12px;color:var(--muted,#888);" data-i18n="purchase_quantity">${tt("purchase_quantity", "Sotib olish")}</div>
        <div style="font-weight:700;color:${meta.color};">${fmt(Math.round(i.toBuy))} ${i.unit}</div>
      </div>
      <div>
        <div style="font-size:12px;color:var(--muted,#888);" data-i18n="estimated_cost">${tt("estimated_cost", "Taxminiy narx")}</div>
        <div style="font-weight:600;">${fmt(Math.round(i.estCost))} ${tt("currency", "so'm")}</div>
      </div>
    </div>
    ${isFinite(i.daysRemaining) ? `<div style="font-size:12px;color:var(--muted,#888);padding-top:10px;border-top:1px solid #eee;" data-i18n="remaining_days">${tt("remaining_days", "Qolgan kunlar")}: <b>${Math.round(i.daysRemaining * 10) / 10}</b></div>` : ""}
  </div>`;
}

window._spDoSaveHistory = async function () {
  if (!SP.lastCalc) return;
  await spSaveHistory(SP.lastCalc);
};

async function spRenderWhatIf(el) {
  el.innerHTML = `
    <div style="margin-bottom:16px;">
      <label data-i18n="sp_whatif_label">${tt("sp_whatif_label", "Ishlab chiqarish/sarf o'zgarishi (%)")}</label>
      <input type="number" id="sp-whatif-pct" value="${Math.round((SP.simMultiplier - 1) * 100)}" style="width:100px;padding:5px 8px;border-radius:6px;border:1px solid var(--border,#ccc);margin:0 8px;">
      <button class="btn btn-primary" onclick="window._spRunWhatIf()" data-i18n="sp_calculate">${tt("sp_calculate", "Hisoblash")}</button>
      <span style="margin-left:10px;color:var(--muted,#888);" data-i18n="pp_sim_intro">${tt("pp_sim_intro", "Bu simulyatsiya ombor zaxirasini o'zgartirmaydi.")}</span>
    </div>
    <div id="sp-whatif-body"></div>
  `;
  await spRenderWhatIfResult();
}

async function spRenderWhatIfResult() {
  const body = document.getElementById("sp-whatif-body");
  if (!body) return;
  body.innerHTML = tt("pp_loading", "Yuklanmoqda...");
  const calc = await spComputeAll(SP.periodDays, SP.simMultiplier);
  body.innerHTML = `
    <div style="overflow-x:auto;">
    <table class="admin-table" style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th data-i18n="col_ingredient">${tt("col_ingredient", "Masalliq")}</th>
        <th data-i18n="average_daily_usage">${tt("average_daily_usage", "O'rtacha kunlik sarf")}</th>
        <th data-i18n="purchase_quantity">${tt("purchase_quantity", "Xarid miqdori")}</th>
        <th data-i18n="shopping_priority">${tt("shopping_priority", "Muhimlik")}</th>
      </tr></thead>
      <tbody>${calc.shoppingItems.map(i => `<tr>
        <td>${i.name}</td><td>${fmt(Math.round(i.avgDailyUsage * 100) / 100)} ${i.unit}</td>
        <td>${fmt(Math.round(i.toBuy))} ${i.unit}</td><td>${spPriorityBadge(i.priority)}</td>
      </tr>`).join("") || `<tr><td colspan="4" style="text-align:center;color:var(--muted,#888);">${tt("pp_no_shortage", "Hozircha yetishmovchilik yo'q")}</td></tr>`}</tbody>
    </table>
    </div>
  `;
}

window._spRunWhatIf = async function () {
  const pct = Number(document.getElementById("sp-whatif-pct")?.value) || 0;
  SP.simMultiplier = 1 + pct / 100;
  await spRenderWhatIfResult();
};

async function spRenderHistory(el) {
  el.innerHTML = tt("pp_loading", "Yuklanmoqda...");
  await spLoadHistory();
  const entries = Object.entries(SP.history || {}).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  el.innerHTML = entries.length ? entries.map(([id, entry]) => `
    <div style="background:var(--card-bg,#fff);border-radius:10px;padding:14px 16px;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
        <div><b>${new Date(entry.createdAt).toLocaleString()}</b> — ${entry.createdBy || ""}</div>
        <div>${tt("planning_period", "Davr")}: ${entry.periodDays} ${tt("sp_days_unit", "kun")} · ${tt("estimated_cost", "Narx")}: ${fmt(entry.totalEstCost)}</div>
      </div>
      <div style="overflow-x:auto;">
      <table class="admin-table" style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr>
          <th data-i18n="col_ingredient">${tt("col_ingredient", "Masalliq")}</th>
          <th data-i18n="purchase_quantity">${tt("purchase_quantity", "Xarid miqdori")}</th>
          <th data-i18n="sp_imported_qty">${tt("sp_imported_qty", "Kirim qilingan")}</th>
        </tr></thead>
        <tbody>${(entry.items || []).map(it => `<tr>
          <td>${it.name}</td><td>${fmt(it.toBuy)} ${it.unit}</td>
          <td><input type="number" min="0" value="${entry.imported?.[it.ingId] ?? ""}" data-entry-id="${id}" data-ing-id="${it.ingId}" class="sp-imported-input" style="width:90px;padding:4px 6px;border-radius:6px;border:1px solid var(--border,#ccc);"></td>
        </tr>`).join("")}</tbody>
      </table>
      </div>
    </div>
  `).join("") : `<div style="padding:16px;color:var(--muted,#888);" data-i18n="pp_no_data">${tt("pp_no_data", "Ma'lumot yo'q")}</div>`;

  el.querySelectorAll(".sp-imported-input").forEach(input => {
    input.addEventListener("change", (e) => {
      spMarkImported(e.target.dataset.entryId, e.target.dataset.ingId, e.target.value);
    });
  });
}

// ==========================================
// 🚀 INIT — warehouseSwitchSubtab('shopping-planner') dan chaqiriladi
// ==========================================
window.initShoppingPlanner = async function () {
  if (!window.allMenu || !window.allInventory) {
    setTimeout(() => window.initShoppingPlanner(), 500);
    return;
  }
  SP.inited = true;
  spRenderRoot();
};

// ==========================================
// 📤 EXPORTS — boshqa modullar (masalan Production Planner'ning
// "Bozorlik" tabi) uchun hisoblash yadrosini qayta ishlatish
// ==========================================
export { spComputeAll, PERIOD_PRESETS, PRIORITY_META, spExcelFromCalc, spPdfFromCalc, spPrintFromCalc };