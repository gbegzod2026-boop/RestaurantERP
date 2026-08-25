// production-planner.js
// 🧠 Smart Production Planner — kunlik ishlab chiqarish rejalashtiruvchi.
// Ombor (allInventory/allSemiFinished), Menyu (allMenu, retseptlar) va
// Buyurtmalar (allOrders) tarixiy ma'lumotlaridan foydalanadi — hech qanday
// yangi ma'lumot nusxalanmaydi, faqat productionPlans/{date} yozuvi qo'shiladi.

import { t } from "./i18n.js";
import { db } from "./firebase.js";
import { exportRowsToExcel, buildExportFilename } from "./exportUtils.js";
import {
  ref, get, update, onValue, push, set
} from "./pgRtdb.js";

function restId() {
  return localStorage.getItem("restaurantId") || window.currentRestaurantId || "";
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
function ppUnitLabel(unit) {
  const keyMap = {
    kg: "unit_kg", gr: "unit_gr", g: "unit_gr", l: "unit_l", ml: "unit_ml",
    dona: "unit_dona", osh_q: "unit_osh_q", choy_q: "unit_choy_q",
    piyola: "unit_piyola", bunch: "unit_bunch", dash: "unit_dash"
  };
  if (!unit) return "";
  const key = keyMap[unit];
  if (!key) return unit;
  // unit_kg kabi kalitlar to'liq "kg (kilogram)" matnini qaytaradi,
  // shopping-list/simulyatsiya jadvallarida esa qisqa "kg" kerak —
  // shuning uchun qavs ichidagi qismni kesib tashlaymiz.
  const full = tt(key, unit);
  return String(full).replace(/\s*\(.*?\)\s*/g, "").trim() || unit;
}
function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function fmt(n) {
  const v = Number(n) || 0;
  return v.toLocaleString();
}
function menuName(item) {
  if (!item) return "";
  if (typeof item.name === "string") return item.name;
  if (item.name && typeof item.name === "object") {
    return item.name[getCurrentLangSafe()] || item.name.uz || item.name.ru || item.name.en || Object.values(item.name)[0] || "";
  }
  return "";
}
function getCurrentLangSafe() {
  try {
    return (window.getLang && window.getLang()) || localStorage.getItem("app_lang") || "uz";
  } catch (e) { return "uz"; }
}
function ppToast(msg, type = "success") {
  let box = document.getElementById("pp-toast-box");
  if (!box) {
    box = document.createElement("div");
    box.id = "pp-toast-box";
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
const PP = {
  date: todayStr(),
  plan: {},          // { menuId: { planned, actual, updatedAt } } — real saqlangan reja
  sim: null,          // simulyatsiya rejimida bo'lsa: { menuId: planned }
  reqCache: new Map(),// menuId -> { ing: Map, sfp: Map }
  activeTab: "dashboard",
  reportFrom: todayStr(-6),
  reportTo: todayStr(),
  inited: false,
  loadingPlan: false,
  shoppingPeriodDays: 7,
  shoppingPeriodLabel: "1w",
  dirty: new Set(), // Reja tabida hali saqlanmagan (Save Plan bosilmagan) menuId'lar
  charts: { dishes: null, usage: null, profit: null, topDishes: null }
};

/** Reja tabidagi kiritishlarni FAQAT xotirada yangilaydi (Firebase'ga yozmaydi) —
 * haqiqiy saqlash "Rejani saqlash" tugmasi bosilganda mavjud ppSetPlanned() orqali bajariladi. */
function ppSetPlannedLocal(menuId, planned) {
  planned = Math.max(0, Math.round(Number(planned) || 0));
  PP.plan[menuId] = { ...(PP.plan[menuId] || {}), planned, updatedAt: Date.now() };
  PP.dirty.add(menuId);
}

// ==========================================
// 🧩 RETSEPT (BOM) HISOBLASH — 1 porsiyaga kerak bo'lgan xom-ashyo/yarim-fabrikat
// ==========================================
async function ppGetRequirementPerPortion(menuId) {
  if (PP.reqCache.has(menuId)) return PP.reqCache.get(menuId);
  const req = await ppComputeRequirement(menuId, 1, 0);
  PP.reqCache.set(menuId, req);
  return req;
}

async function ppComputeRequirement(menuId, qty, depth, acc = { ing: new Map(), sfp: new Map() }) {
  if (depth > 6) return acc;
  const menuItem = window.allMenu?.[menuId];
  if (!menuItem) return acc;

  if (menuItem.isCombo) {
    const comboItems = Array.isArray(menuItem.comboItems) ? menuItem.comboItems : Object.values(menuItem.comboItems || {});
    for (const ci of comboItems) {
      const childId = ci.menuId;
      const childQty = Number(ci.qty || 1) * qty;
      if (childId && childQty > 0) await ppComputeRequirement(childId, childQty, depth + 1, acc);
    }
    return acc;
  }

  const recipe = typeof window._getMenuRecipe === "function" ? await window._getMenuRecipe(menuId) : [];
  for (const row of recipe) {
    const amt = Number(row.amount || 0) * qty;
    if (!row.id || amt <= 0) continue;
    if (row.isSemiFinished) {
      acc.sfp.set(row.id, (acc.sfp.get(row.id) || 0) + amt);
    } else {
      acc.ing.set(row.id, (acc.ing.get(row.id) || 0) + amt);
    }
  }
  return acc;
}

/** Rejalashtiriladigan (retsepti bor) menyu taomlari ro'yxati */
async function ppGetPlannableMenuItems() {
  const menu = window.allMenu || {};
  const out = [];
  for (const [id, item] of Object.entries(menu)) {
    if (item?.active === false) continue;
    const req = await ppGetRequirementPerPortion(id);
    if (req.ing.size === 0 && req.sfp.size === 0) continue; // retseptsiz taomlar (masalan ichimliklar) — chiqarib tashlanadi
    out.push(id);
  }
  return out;
}

/** Joriy reja (yoki simulyatsiya) bo'yicha barcha taomlarning umumiy band qilingan (reserved) resurslarini hisoblaydi */
function ppActivePlan() {
  return PP.sim || PP.plan;
}
function ppPlannedQty(menuId) {
  const p = ppActivePlan()[menuId];
  if (!p) return 0;
  return Number((typeof p === "number" ? p : p.planned) || 0);
}

async function ppComputeReserved(excludeMenuId = null) {
  const plan = ppActivePlan();
  const reservedIng = new Map();
  const reservedSfp = new Map();
  for (const menuId of Object.keys(plan)) {
    if (menuId === excludeMenuId) continue;
    const qty = ppPlannedQty(menuId);
    if (qty <= 0) continue;
    const req = await ppGetRequirementPerPortion(menuId);
    for (const [ingId, amt] of req.ing) reservedIng.set(ingId, (reservedIng.get(ingId) || 0) + amt * qty);
    for (const [sfpId, amt] of req.sfp) reservedSfp.set(sfpId, (reservedSfp.get(sfpId) || 0) + amt * qty);
  }
  return { reservedIng, reservedSfp };
}

/** Cheklovchi (limiting) ingredient asosida maksimal ishlab chiqarish miqdorini hisoblaydi */
async function ppMaxPortions(menuId) {
  const req = await ppGetRequirementPerPortion(menuId);
  const { reservedIng, reservedSfp } = await ppComputeReserved(menuId);
  const inv = window.allInventory || {};
  const sfpStore = window.allSemiFinished || {};
  let limit = Infinity;
  let limitingName = "";

  for (const [ingId, perPortion] of req.ing) {
    if (perPortion <= 0) continue;
    const stock = Number(inv[ingId]?.stock || 0);
    const reserved = reservedIng.get(ingId) || 0;
    const available = Math.max(0, stock - reserved);
    const portions = Math.floor(available / perPortion);
    if (portions < limit) { limit = portions; limitingName = menuName(inv[ingId]) || ingId; }
  }
  for (const [sfpId, perPortion] of req.sfp) {
    if (perPortion <= 0) continue;
    const stock = Number(sfpStore[sfpId]?.stock || 0);
    const reserved = reservedSfp.get(sfpId) || 0;
    const available = Math.max(0, stock - reserved);
    const portions = Math.floor(available / perPortion);
    if (portions < limit) { limit = portions; limitingName = menuName(sfpStore[sfpId]) || sfpId; }
  }
  if (!isFinite(limit)) limit = 0;
  return { max: Math.max(0, limit), limitingName };
}

// ==========================================
// 📈 SOTUV TAHLILI — tavsiya etilgan ishlab chiqarish miqdori
// ==========================================
function _orderTs(order) {
  return Number(order.createdAt || order.date || order.timestamp || order.time || 0);
}
function _orderItemQty(item) {
  return Number(item.qty ?? item.quantity ?? 1) || 0;
}
function _orderItemMenuId(item) {
  return item.menuId || item.id || item.itemId || null;
}

/** Berilgan sanadan (kunlar oldin) bugungacha, bitta taom uchun kunlik o'rtacha sotuv */
function ppAvgDailySales(menuId, days) {
  const orders = window.allOrders || {};
  const now = Date.now();
  const from = now - days * 24 * 60 * 60 * 1000;
  let total = 0;
  for (const order of Object.values(orders)) {
    if (!order || order.status === "cancelled" || order.statusKey === "cancelled") continue;
    const ts = _orderTs(order);
    if (ts < from || ts > now) continue;
    const items = order.items ? Object.values(order.items) : [];
    for (const item of items) {
      if (_orderItemMenuId(item) === menuId) total += _orderItemQty(item);
    }
  }
  return total / Math.max(1, days);
}

/** Xuddi shu hafta kunining o'rtacha sotuvi (oxirgi 8 ta shu hafta kuni) */
function ppSameWeekdayAvg(menuId) {
  const orders = window.allOrders || {};
  const todayDow = new Date().getDay();
  const buckets = new Map(); // dateStr -> qty
  for (const order of Object.values(orders)) {
    if (!order || order.status === "cancelled" || order.statusKey === "cancelled") continue;
    const ts = _orderTs(order);
    if (!ts) continue;
    const d = new Date(ts);
    if (d.getDay() !== todayDow) continue;
    const key = d.toISOString().slice(0, 10);
    const items = order.items ? Object.values(order.items) : [];
    let qty = 0;
    for (const item of items) {
      if (_orderItemMenuId(item) === menuId) qty += _orderItemQty(item);
    }
    if (qty > 0) buckets.set(key, (buckets.get(key) || 0) + qty);
  }
  const vals = [...buckets.values()].slice(-8);
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

async function ppRecommendedQty(menuId) {
  const avg7 = ppAvgDailySales(menuId, 7);
  const avg30 = ppAvgDailySales(menuId, 30);
  const avg90 = ppAvgDailySales(menuId, 90);
  const sameDow = ppSameWeekdayAvg(menuId);
  const blended = avg7 * 0.4 + avg30 * 0.3 + avg90 * 0.1 + sameDow * 0.2;
  const { max } = await ppMaxPortions(menuId);
  return { recommended: Math.max(0, Math.min(Math.round(blended), max)), max, avg7, avg30, avg90, sameDow };
}

// ==========================================
// 💾 REJA (PLAN) — Firebase productionPlans/{date}
// ==========================================
async function ppLoadPlan(date) {
  PP.loadingPlan = true;
  try {
    const snap = await get(ref(db, `${basePath()}/productionPlans/${date}/items`));
    PP.plan = snap.exists() ? snap.val() : {};
  } catch (e) {
    console.warn("Production plan load error:", e);
    PP.plan = {};
  }
  PP.loadingPlan = false;
}

async function ppSetPlanned(menuId, planned) {
  planned = Math.max(0, Math.round(Number(planned) || 0));
  if (PP.sim) {
    PP.sim[menuId] = planned;
    return;
  }
  PP.plan[menuId] = { ...(PP.plan[menuId] || {}), planned, updatedAt: Date.now() };
  try {
    await update(ref(db, `${basePath()}/productionPlans/${PP.date}/items/${menuId}`), {
      planned, updatedAt: Date.now()
    });
  } catch (e) {
    console.warn("Production plan save error:", e);
    ppToast(tt("pp_save_error", "Rejani saqlashda xatolik yuz berdi"), "error");
  }
}

async function ppSetActual(menuId, actual) {
  actual = Math.max(0, Math.round(Number(actual) || 0));
  PP.plan[menuId] = { ...(PP.plan[menuId] || {}), actual, updatedAt: Date.now() };
  try {
    await update(ref(db, `${basePath()}/productionPlans/${PP.date}/items/${menuId}`), {
      actual, updatedAt: Date.now()
    });
  } catch (e) {
    console.warn("Production actual save error:", e);
  }
}

// ==========================================
// 🛒 YETISHMOVCHILIK / XARID TAVSIYASI
// ==========================================
async function ppComputeShortages() {
  const { reservedIng, reservedSfp } = await ppComputeReserved(null);
  const inv = window.allInventory || {};
  const sfpStore = window.allSemiFinished || {};
  const shortages = [];
  for (const [ingId, needed] of reservedIng) {
    const stock = Number(inv[ingId]?.stock || 0);
    const missing = needed - stock;
    if (missing > 0) {
      shortages.push({
        id: ingId, kind: "ingredient", name: menuName(inv[ingId]) || ingId,
        unit: inv[ingId]?.unit || "", needed, stock, missing
      });
    }
  }
  for (const [sfpId, needed] of reservedSfp) {
    const stock = Number(sfpStore[sfpId]?.stock || 0);
    const missing = needed - stock;
    if (missing > 0) {
      shortages.push({
        id: sfpId, kind: "semiFinished", name: menuName(sfpStore[sfpId]) || sfpId,
        unit: sfpStore[sfpId]?.unit || "", needed, stock, missing
      });
    }
  }
  return shortages.sort((a, b) => b.missing - a.missing);
}

// ==========================================
// ⚠️ KAM QOLGAN ZAXIRA OGOHLANTIRISHLARI
// ==========================================
async function ppComputeLowStockWarnings() {
  const shortages = await ppComputeShortages();
  const warnings = shortages.map(s => ({
    ...s,
    reason: s.stock <= 0 ? "insufficient" : "insufficient"
  }));
  // dailyUsage asosida "bugun/ertaga tugaydi" signalini qo'shamiz
  try {
    const snap = await get(ref(db, `${basePath()}/dailyUsage`));
    if (snap.exists()) {
      const data = snap.val();
      const dates = Object.keys(data).sort().slice(-7);
      const totals = new Map();
      for (const d of dates) {
        for (const [ingId, val] of Object.entries(data[d] || {})) {
          totals.set(ingId, (totals.get(ingId) || 0) + Number(val || 0));
        }
      }
      const inv = window.allInventory || {};
      for (const [ingId, total] of totals) {
        const avgPerDay = total / Math.max(1, dates.length);
        if (avgPerDay <= 0) continue;
        const stock = Number(inv[ingId]?.stock || 0);
        const daysLeft = stock / avgPerDay;
        if (daysLeft < 2) {
          const existing = warnings.find(w => w.id === ingId && w.kind === "ingredient");
          const label = daysLeft < 1 ? "finishes_today" : "finishes_tomorrow";
          if (existing) existing.reason = label;
          else warnings.push({
            id: ingId, kind: "ingredient", name: menuName(inv[ingId]) || ingId,
            unit: inv[ingId]?.unit || "", needed: 0, stock, missing: 0, reason: label
          });
        }
      }
    }
  } catch (e) { /* dailyUsage optional signal — sekin nosozlik jim o'tkaziladi */ }
  return warnings;
}

// ==========================================
// 📊 HISOBOTLAR (Reports)
// ==========================================
async function ppReportRange(fromDate, toDate) {
  const dates = [];
  let cur = new Date(fromDate);
  const end = new Date(toDate);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  const plannedVsActual = []; // { date, menuId, name, planned, actual }
  const usageTotals = new Map(); // ingId -> total used (dailyUsage)
  const waste = []; // { date, menuId, name, planned, actual, sold, waste }

  for (const date of dates) {
    let planItems = {};
    try {
      const snap = await get(ref(db, `${basePath()}/productionPlans/${date}/items`));
      planItems = snap.exists() ? snap.val() : {};
    } catch (e) { planItems = {}; }

    for (const [menuId, rec] of Object.entries(planItems)) {
      const planned = Number(rec.planned || 0);
      const actual = rec.actual == null ? null : Number(rec.actual);
      const name = menuName(window.allMenu?.[menuId]) || menuId;
      plannedVsActual.push({ date, menuId, name, planned, actual });
      if (actual != null) {
        const sold = ppSoldOnDate(menuId, date);
        const w = Math.max(0, actual - sold);
        waste.push({ date, menuId, name, planned, actual, sold, waste: w });
      }
    }

    try {
      const usnap = await get(ref(db, `${basePath()}/dailyUsage/${date}`));
      if (usnap.exists()) {
        for (const [ingId, val] of Object.entries(usnap.val() || {})) {
          usageTotals.set(ingId, (usageTotals.get(ingId) || 0) + Number(val || 0));
        }
      }
    } catch (e) { /* ignore */ }
  }

  const shortages = await ppComputeShortages();
  return { plannedVsActual, usageTotals, waste, shortages };
}

function ppSoldOnDate(menuId, dateStr) {
  const orders = window.allOrders || {};
  let total = 0;
  for (const order of Object.values(orders)) {
    if (!order || order.status === "cancelled" || order.statusKey === "cancelled") continue;
    const ts = _orderTs(order);
    if (!ts) continue;
    const d = new Date(ts).toISOString().slice(0, 10);
    if (d !== dateStr) continue;
    const items = order.items ? Object.values(order.items) : [];
    for (const item of items) {
      if (_orderItemMenuId(item) === menuId) total += _orderItemQty(item);
    }
  }
  return total;
}

// ==========================================
// 💰 TANNARX / TUSHUM BAHOLASH — mavjud `price` maydonlari asosida qo'shimcha
// hisob-kitob (yangi algoritm emas, faqat mavjud ma'lumotlarni jamlash)
// ==========================================
/** Berilgan reja (planMap: menuId -> planned qty) bo'yicha xom-ashyo tannarxini baholaydi */
async function ppEstimateProductionCost(planMap) {
  const inv = window.allInventory || {};
  const sfpStore = window.allSemiFinished || {};
  let total = 0;
  for (const [menuId, qty] of Object.entries(planMap || {})) {
    const plannedQty = ppPlannedQtyFromMap(planMap, menuId);
    if (plannedQty <= 0) continue;
    const req = await ppGetRequirementPerPortion(menuId);
    let perPortionCost = 0;
    for (const [ingId, amt] of req.ing) perPortionCost += amt * Number(inv[ingId]?.price || 0);
    for (const [sfpId, amt] of req.sfp) perPortionCost += amt * Number(sfpStore[sfpId]?.price || 0);
    total += perPortionCost * plannedQty;
  }
  return total;
}
function ppPlannedQtyFromMap(planMap, menuId) {
  const p = planMap[menuId];
  if (!p) return 0;
  return Number((typeof p === "number" ? p : p.planned) || 0);
}
/** Berilgan reja bo'yicha kutilayotgan tushumni baholaydi (menyu narxi * reja) */
function ppEstimateRevenue(planMap) {
  let total = 0;
  for (const menuId of Object.keys(planMap || {})) {
    const qty = ppPlannedQtyFromMap(planMap, menuId);
    if (qty <= 0) continue;
    total += qty * Number(window.allMenu?.[menuId]?.price || 0);
  }
  return total;
}
/** Har bir taom bo'yicha tannarx/sotuv narxi/foyda-zararni alohida hisoblaydi
 * (foyda kartasidagi "Tafsilotlarni ko'rish" jadvali uchun) */
async function ppEstimateProfitBreakdown(planMap) {
  const inv = window.allInventory || {};
  const sfpStore = window.allSemiFinished || {};
  const rows = [];
  for (const menuId of Object.keys(planMap || {})) {
    const qty = ppPlannedQtyFromMap(planMap, menuId);
    if (qty <= 0) continue;
    const req = await ppGetRequirementPerPortion(menuId);
    let costPerPortion = 0;
    for (const [ingId, amt] of req.ing) costPerPortion += amt * Number(inv[ingId]?.price || 0);
    for (const [sfpId, amt] of req.sfp) costPerPortion += amt * Number(sfpStore[sfpId]?.price || 0);
    const pricePerPortion = Number(window.allMenu?.[menuId]?.price || 0);
    const totalCost = costPerPortion * qty;
    const totalRevenue = pricePerPortion * qty;
    rows.push({
      menuId,
      name: menuName(window.allMenu?.[menuId]) || menuId,
      qty,
      costPerPortion,
      pricePerPortion,
      totalCost,
      totalRevenue,
      profit: totalRevenue - totalCost
    });
  }
  return rows.sort((a, b) => a.profit - b.profit); // eng katta zarar tepada
}
/** Yetishmovchilik qatorini ustuvorlik darajasiga ajratadi (missing/needed nisbati bo'yicha) */
function ppShortagePriority(shortage) {
  const ratio = shortage.needed > 0 ? shortage.missing / shortage.needed : 0;
  if (ratio >= 0.5) return "critical";
  if (ratio >= 0.2) return "high";
  if (ratio > 0) return "medium";
  return "low";
}
const PP_PRIORITY_META = {
  critical: { key: "critical", fb: "Kritik", color: "#e5484d" },
  high: { key: "high", fb: "Yuqori", color: "#f2994a" },
  medium: { key: "medium", fb: "O'rta", color: "#e8b923" },
  low: { key: "low", fb: "Past", color: "#2e9e6c" }
};
function ppSupplierName(ingId) {
  const ing = (window.allInventory || {})[ingId];
  return ing?.supplierName || ing?.supplier || "";
}

// ==========================================
// 🖥️ RENDER — Sana → Dashboard → Tavsiya → Reja → Simulyatsiya → Defitsit → Hisobotlar → Bozorlik
// ==========================================
function ppInjectStyleOnce() {
  if (document.getElementById("pp-style")) return;
  const style = document.createElement("style");
  style.id = "pp-style";
  style.textContent = `
    .pp-sticky-table thead th { position: sticky; top: 0; background: var(--card-bg,#fff); z-index: 2; box-shadow: 0 1px 0 rgba(0,0,0,.08); }
    .pp-badge { display:inline-block; padding:2px 9px; border-radius:10px; font-size:11.5px; font-weight:600; color:#fff; white-space:nowrap; }
    .pp-progress-track { background:#e5e7eb; border-radius:6px; height:7px; width:100%; overflow:hidden; margin-top:5px; min-width:70px; }
    .pp-progress-bar-fill { height:100%; border-radius:6px; transition:width .2s ease, background-color .2s ease; }
    .pp-skel { background:linear-gradient(90deg,#e5e7eb 25%,#f1f2f4 37%,#e5e7eb 63%); background-size:400% 100%; animation:pp-skel-shine 1.4s ease infinite; border-radius:8px; }
    @keyframes pp-skel-shine { 0% { background-position:100% 50%; } 100% { background-position:0 50%; } }
    /* Dark-mode consistency pass — both rules above were hardcoded to
       light-gray-only, no theme awareness at all. */
    :root[data-theme="dark"] .pp-progress-track { background: var(--bg-hover,#232b3d); }
    :root[data-theme="dark"] .pp-skel { background: linear-gradient(90deg,var(--bg-card-2,#1c2333) 25%,var(--bg-hover,#232b3d) 37%,var(--bg-card-2,#1c2333) 63%); background-size:400% 100%; }
    .pp-dirty-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#f2994a; margin-left:5px; vertical-align:middle; }
  `;
  document.head.appendChild(style);
}

/** Bo'lim yuklanayotganda ko'rsatiladigan skeleton (pulsatsiyalanuvchi) placeholder */
function ppSkeletonHtml() {
  return `<div style="padding:4px 0;">
    <div class="pp-skel" style="height:70px;border-radius:12px;margin-bottom:14px;"></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:18px;">
      <div class="pp-skel" style="height:78px;"></div>
      <div class="pp-skel" style="height:78px;"></div>
      <div class="pp-skel" style="height:78px;"></div>
    </div>
    <div class="pp-skel" style="height:22px;width:220px;margin-bottom:12px;"></div>
    <div class="pp-skel" style="height:18px;margin-bottom:8px;"></div>
    <div class="pp-skel" style="height:18px;margin-bottom:8px;"></div>
    <div class="pp-skel" style="height:18px;margin-bottom:8px;"></div>
  </div>`;
}

function ppProgressBar(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color = pct > 100 ? "#e5484d" : pct >= 90 ? "#f2994a" : "#2e9e6c";
  return `<div class="pp-progress-track"><div class="pp-progress-bar-fill" style="width:${clamped}%;background:${color};"></div></div>`;
}

function ppEmptyRow(colspan, key = "pp_empty_dishes", fb = "Retsepti bo'lgan taomlar topilmadi") {
  return `<tr><td colspan="${colspan}" style="text-align:center;color:var(--muted,#888);padding:22px;">${tt(key, fb)}</td></tr>`;
}

function ppTabsHtml() {
  const tabs = [
    ["dashboard", "pp_tab_dashboard", "📊 Dashboard", ""],
    ["recommendation", "pp_tab_recommendation", "🍽 Tavsiyalar", ""],
    ["plan", "pp_tab_plan", "📝 Reja", ""],
    ["simulation", "pp_tab_simulation", "🧪 Simulyatsiya", ""],
    ["shortages", "pp_tab_shortages", "⚠ Defitsit", ""],
    ["shopping", "shopping_planner", "🛒 Bozorlik", ""],
    ["reports", "pp_tab_reports", "📈 Hisobotlar", ""]
  ];
  return `<div class="kassa-subtab-bar" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
    ${tabs.map(([id, key, fb]) => `
      <button class="kassa-subtab-btn${PP.activeTab === id ? " active" : ""}" onclick="window._ppSwitchTab('${id}')">
        <span data-i18n="${key}">${tt(key, fb)}</span>
      </button>
    `).join("")}
  </div>`;
}

async function ppRenderRoot() {
  const root = document.getElementById("pp-root");
  if (!root) return;
  ppInjectStyleOnce();
  root.innerHTML = `
    <h2 data-i18n="production_planner">${tt("production_planner", "Aqlli ishlab chiqarish rejasi")}</h2>
    <div id="pp-date-bar" style="display:flex;align-items:center;gap:10px;margin:10px 0 16px;">
      <label data-i18n="pp_date_label">${tt("pp_date_label", "Sana")}:</label>
      <input type="date" id="pp-date-input" value="${PP.date}" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border,#ccc);">
      ${PP.sim ? `<span style="color:#f2994a;font-weight:600;" data-i18n="simulation">${tt("simulation", "Simulyatsiya")} ⚠️</span>` : ""}
    </div>
    ${ppTabsHtml()}
    <div id="pp-tab-content">${tt("pp_loading", "Yuklanmoqda...")}</div>
  `;
  const dateInput = document.getElementById("pp-date-input");
  dateInput.addEventListener("change", async (e) => {
    PP.date = e.target.value || todayStr();
    await ppLoadPlan(PP.date);
    ppRenderTabContent();
  });
  ppRenderTabContent();
}

window._ppSwitchTab = function (tabId) {
  PP.activeTab = tabId;
  ppRenderRoot();
};

async function ppRenderTabContent() {
  const el = document.getElementById("pp-tab-content");
  if (!el) return;
  el.innerHTML = ppSkeletonHtml();
  try {
    if (PP.activeTab === "dashboard") await ppRenderDashboard(el);
    else if (PP.activeTab === "recommendation") await ppRenderRecommendation(el);
    else if (PP.activeTab === "plan") await ppRenderPlanTable(el);
    else if (PP.activeTab === "simulation") await ppRenderSimulation(el);
    else if (PP.activeTab === "shortages") await ppRenderShortages(el);
    else if (PP.activeTab === "reports") await ppRenderReports(el);
    else if (PP.activeTab === "shopping") await ppRenderShoppingTab(el);
  } catch (e) {
    console.error("Production planner render error:", e);
    el.innerHTML = `<div style="padding:20px;color:#e5484d;">${tt("pp_render_error", "Bo'limni yuklashda xatolik yuz berdi")}</div>`;
  }
}

async function ppRenderDashboard(el) {
  const menuIds = await ppGetPlannableMenuItems();
  let totalPlanned = 0;
  for (const menuId of menuIds) totalPlanned += ppPlannedQty(menuId);
  const shortages = await ppComputeShortages();
  const productionCost = await ppEstimateProductionCost(PP.plan);

  let toBuyCount = 0, purchaseCost = 0;
  try {
    const mod = await import("./shopping-planner.js");
    const calc = await mod.spComputeAll(1, 1); // bugungi kesimda xarid zarurati
    toBuyCount = calc.shoppingItems.length;
    purchaseCost = calc.totalEstCost;
  } catch (e) { /* Bozorlik moduli hali yuklanmagan bo'lsa jim o'tkaziladi */ }

  el.innerHTML = `
    <div class="pp-summary-list" style="display:flex;flex-direction:column;gap:12px;">
      ${ppSummaryCard("🍽", "pp_stat_dishes", "Tavsiya etilgan taomlar", menuIds.length + " " + tt("pp_count_suffix", "ta"), "#2563eb")}
      ${ppSummaryCard("📦", "pp_stat_total_planned", "Jami ishlab chiqarish", totalPlanned + " " + tt("pp_portions_suffix", "porsiya"), "#f2994a")}
      ${ppSummaryCard("⚠️", "ingredient_shortage", "Defitsit ingredientlar", shortages.length + " " + tt("pp_count_suffix", "ta"), shortages.length ? "#e5484d" : "#16a34a")}
      ${ppSummaryCard("🛒", "pp_stat_to_buy", "Xarid qilinadigan mahsulot", toBuyCount + " " + tt("pp_count_suffix", "ta"), toBuyCount ? "#f2994a" : "#16a34a")}
      ${ppSummaryCard("💰", "pp_stat_purchase_cost", "Taxminiy xarid summasi", fmt(Math.round(purchaseCost)) + " " + tt("currency", "so'm"), "#0891b2")}
    </div>
  `;
}

function ppSummaryCard(emoji, key, fallback, value, color) {
  const c = color || "#64748b";
  return `<div style="background:var(--card-bg,#fff);border-radius:12px;padding:16px 20px;box-shadow:0 2px 8px rgba(0,0,0,.06);border-left:4px solid ${c};display:flex;align-items:center;justify-content:space-between;gap:12px;">
    <div style="display:flex;align-items:center;gap:12px;font-size:14.5px;color:var(--text,#333);">
      <span style="font-size:19px;">${emoji}</span>
      <span data-i18n="${key}">${tt(key, fallback)}</span>
    </div>
    <div style="font-weight:700;font-size:16px;color:${c};white-space:nowrap;">${value}</div>
  </div>`;
}

function ppStatCard(key, fallback, value, color, icon) {
  const c = color || "#64748b";
  return `<div class="pp-stat-card" style="background:var(--card-bg,#fff);border-radius:12px;padding:16px 18px;box-shadow:0 2px 8px rgba(0,0,0,.06);border-left:4px solid ${c};display:flex;align-items:center;gap:14px;">
    <div style="width:42px;height:42px;border-radius:10px;background:${c}22;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
      <i class="fa-solid ${icon || "fa-circle-info"}" style="color:${c};font-size:17px;"></i>
    </div>
    <div>
      <div style="font-size:12.5px;color:var(--muted,#888);" data-i18n="${key}">${tt(key, fallback)}</div>
      <div style="font-size:21px;font-weight:700;color:${c};">${typeof value === "string" ? value : fmt(value)}</div>
    </div>
  </div>`;
}

/** Bitta taom uchun cheklovchi ingredientning nomi, ombordagi va kerakli miqdorini qaytaradi
 * (joriy rejadagi shu taomning o'zi hisobga olinmaydi — "boshqalar band qilgani" chiqariladi). */
async function ppLimitingIngredientDetail(menuId) {
  const req = await ppGetRequirementPerPortion(menuId);
  const { reservedIng, reservedSfp } = await ppComputeReserved(menuId);
  const inv = window.allInventory || {};
  const sfpStore = window.allSemiFinished || {};
  let limit = Infinity;
  let detail = null;
  for (const [ingId, perPortion] of req.ing) {
    if (perPortion <= 0) continue;
    const stock = Number(inv[ingId]?.stock || 0);
    const reserved = reservedIng.get(ingId) || 0;
    const available = Math.max(0, stock - reserved);
    const portions = Math.floor(available / perPortion);
    if (portions < limit) {
      limit = portions;
      detail = { name: menuName(inv[ingId]) || ingId, unit: inv[ingId]?.unit || "", available, perPortion };
    }
  }
  for (const [sfpId, perPortion] of req.sfp) {
    if (perPortion <= 0) continue;
    const stock = Number(sfpStore[sfpId]?.stock || 0);
    const reserved = reservedSfp.get(sfpId) || 0;
    const available = Math.max(0, stock - reserved);
    const portions = Math.floor(available / perPortion);
    if (portions < limit) {
      limit = portions;
      detail = { name: menuName(sfpStore[sfpId]) || sfpId, unit: sfpStore[sfpId]?.unit || "", available, perPortion };
    }
  }
  return detail; // null bo'lsa — retseptida hech qanday cheklovchi ingredient yo'q
}

/** planned/max nisbatiga qarab 🟢🟡🔴 status va rang qaytaradi */
function ppRecoStatus(planned, max) {
  if (max <= 0) return { emoji: planned > 0 ? "🔴" : "🟡", color: planned > 0 ? "#e5484d" : "#e8b923", key: planned > 0 ? "insufficient" : "low" };
  const pct = planned / max;
  if (planned > max) return { emoji: "🔴", color: "#e5484d", key: "insufficient" };
  if (pct >= 0.85) return { emoji: "🟡", color: "#e8b923", key: "low" };
  return { emoji: "🟢", color: "#2e9e6c", key: "sufficient" };
}

async function ppRenderRecommendation(el) {
  const menuIds = await ppGetPlannableMenuItems();
  const rows = [];
  for (const menuId of menuIds) {
    const { recommended, max } = await ppRecommendedQty(menuId);
    const limiting = await ppLimitingIngredientDetail(menuId);
    const planned = ppPlannedQty(menuId) || recommended;
    rows.push({ menuId, name: menuName(window.allMenu[menuId]), max, recommended, planned, limiting });
  }

  const totalPlanned = rows.reduce((s, r) => s + r.planned, 0);
  el.innerHTML = `
    <div style="margin-bottom:12px;color:var(--muted,#888);font-size:13px;">
      ${tt("pp_recommendation_hint", "Tavsiyalar ombor zaxirasi, retseptlar va oxirgi savdo statistikasi asosida avtomatik hisoblanadi.")}
    </div>
    <div style="overflow-x:auto;">
    <table class="admin-table pp-sticky-table pp-reco-table" style="width:100%;border-collapse:collapse;background:var(--bg-card);color:var(--text-primary);border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);">
      <thead><tr style="background:var(--bg-card);">
        <th style="text-align:left;padding:12px 16px;font-weight:700;color:var(--text-primary);">${tt("col_food_name", "Taom")}</th>
        <th style="text-align:left;padding:12px 16px;font-weight:700;color:var(--text-primary);">${tt("recommended_quantity", "Tavsiya")}</th>
        <th style="text-align:left;padding:12px 16px;font-weight:700;color:var(--text-primary);">${tt("maximum_portions", "Maksimum")}</th>
        <th style="text-align:left;padding:12px 16px;font-weight:700;color:var(--text-primary);">${tt("pp_your_plan", "Sizning rejangiz")}</th>
        <th style="text-align:center;padding:12px 16px;width:44px;"></th>
      </tr></thead>
      <tbody id="pp-reco-tbody">
        ${rows.map(r => {
          const status = ppRecoStatus(r.planned, r.max);
          return `
          <tr class="pp-reco-row" data-menu-id="${r.menuId}" style="border-top:1px solid var(--border);">
            <td style="padding:14px 16px;">${r.name}</td>
            <td style="padding:14px 16px;" class="pp-reco-recommended">${fmt(r.recommended)}</td>
            <td style="padding:14px 16px;" class="pp-reco-max">${fmt(r.max)}</td>
            <td style="padding:14px 16px;">
              <span class="pp-reco-status" style="margin-right:4px;">${status.emoji}</span>
              [ <span class="pp-reco-planned-num" contenteditable="true" data-menu-id="${r.menuId}"
                  style="display:inline-block;min-width:26px;padding:1px 3px;border-radius:4px;color:${status.color};font-weight:700;outline:none;cursor:text;"
                >${r.planned}</span> ]
            </td>
            <td style="padding:14px 16px;text-align:center;">
              <button type="button" class="pp-reco-toggle" data-menu-id="${r.menuId}" title="${tt("pp_show_details", "Batafsil")}"
                style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:15px;padding:4px;">
                <i class="fa-solid fa-eye"></i>
              </button>
            </td>
          </tr>
          <tr class="pp-reco-detail-row" data-menu-id="${r.menuId}" style="display:none;background:var(--bg-hover);">
            <td colspan="5" style="padding:0;">
              <div class="pp-reco-detail-body" style="padding:16px 20px 20px 20px;"></div>
            </td>
          </tr>`;
        }).join("") || ppEmptyRow(5)}
      </tbody>
      ${rows.length ? `<tfoot>
        <tr style="border-top:2px solid var(--border);background:var(--bg-hover);">
          <td style="padding:14px 16px;font-weight:700;color:var(--text-primary);">${tt("pp_reco_total", "Jami")}</td>
          <td colspan="3" style="padding:14px 16px;">
            <span style="color:var(--text-muted);">${tt("pp_reco_total_planned", "Rejalashtirilgan")}:</span>
            <span id="pp-reco-total-planned" style="font-weight:700;margin-left:6px;color:var(--text-primary);">${fmt(totalPlanned)} ${tt("portions_suffix", "porsiya")}</span>
            <span style="color:var(--text-muted);margin-left:18px;">${tt("pp_reco_total_cost", "Taxminiy tannarx")}:</span>
            <span id="pp-reco-total-cost" style="font-weight:700;margin-left:6px;color:var(--text-primary);">—</span>
            <span style="color:var(--text-muted);margin-left:18px;">${tt("pp_reco_total_profit", "Taxminiy foyda")}:</span>
            <span id="pp-reco-total-profit" style="font-weight:700;margin-left:6px;color:#2e9e6c;">—</span>
          </td>
          <td></td>
        </tr>
      </tfoot>` : ""}
    </table>
    </div>
  `;

  ppWireRecommendationTable(el);
  await ppRecalcRecoTotals();
}

/** Har bir qatorning "ko'z" tugmasi va tahrirlanadigan reja raqami uchun event'larni ulaydi */
function ppWireRecommendationTable(el) {
  el.querySelectorAll(".pp-reco-toggle").forEach(btn => {
    btn.addEventListener("click", async () => {
      const menuId = btn.dataset.menuId;
      const detailRow = el.querySelector(`.pp-reco-detail-row[data-menu-id="${menuId}"]`);
      if (!detailRow) return;
      const isOpen = detailRow.style.display !== "none";
      if (isOpen) {
        detailRow.style.display = "none";
        btn.innerHTML = `<i class="fa-solid fa-eye"></i>`;
      } else {
        detailRow.style.display = "table-row";
        btn.innerHTML = `<i class="fa-solid fa-eye-slash"></i>`;
        await ppRenderRecoDetail(menuId, detailRow.querySelector(".pp-reco-detail-body"));
      }
    });
  });

  el.querySelectorAll(".pp-reco-planned-num").forEach(span => {
    const commit = async () => {
      const menuId = span.dataset.menuId;
      const val = Math.max(0, Math.round(Number(span.textContent.replace(/[^\d.-]/g, "")) || 0));
      span.textContent = val;
      ppSetPlannedLocal(menuId, val);
      await ppRecalcRecommendationInPlace(el, menuId);
    };
    span.addEventListener("blur", commit);
    span.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); span.blur(); }
    });
    span.addEventListener("input", () => {
      // faqat raqam kiritishga ruxsat beramiz
      const clean = span.textContent.replace(/[^\d]/g, "");
      if (clean !== span.textContent) span.textContent = clean;
    });
  });
}

/** Ochilgan qatorning batafsil bloki: tavsiya, maksimum, cheklovchi ingredient, ombordagi/kerakli miqdor */
async function ppRenderRecoDetail(menuId, container) {
  if (!container) return;
  container.innerHTML = `<div style="color:#8b949e;font-size:13px;">${tt("pp_loading", "Yuklanmoqda...")}</div>`;
  const { recommended, max } = await ppRecommendedQty(menuId);
  const limiting = await ppLimitingIngredientDetail(menuId);
  const req = await ppGetRequirementPerPortion(menuId);
  const planned = ppPlannedQty(menuId) || recommended;
  const name = menuName(window.allMenu[menuId]);
  const hasRecipe = req.ing.size > 0 || req.sfp.size > 0;

  const neededForPlanned = limiting ? +(limiting.perPortion * planned).toFixed(2) : 0;

  container.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;margin-bottom:14px;">
      <div>
        <div style="font-size:12px;color:var(--text-muted);">${tt("recommended_quantity", "Tavsiya")}:</div>
        <div style="font-size:16px;font-weight:700;color:var(--text-primary);">${fmt(recommended)} <span style="font-size:12px;font-weight:400;color:var(--text-muted);">${tt("portions_suffix", "porsiya")}</span></div>
      </div>
      <div>
        <div style="font-size:12px;color:var(--text-muted);">${tt("maximum_portions", "Maksimum")}:</div>
        <div style="font-size:16px;font-weight:700;color:var(--text-primary);">${fmt(max)} <span style="font-size:12px;font-weight:400;color:var(--text-muted);">${tt("portions_suffix", "porsiya")}</span></div>
      </div>
      ${limiting ? `
      <div>
        <div style="font-size:12px;color:var(--text-muted);">${tt("pp_limiting_ingredient", "Cheklov")}:</div>
        <div style="font-size:16px;font-weight:700;color:var(--text-primary);">${limiting.name}</div>
      </div>
      <div>
        <div style="font-size:12px;color:var(--text-muted);">${tt("available_stock", "Omborda")}:</div>
        <div style="font-size:16px;font-weight:700;color:var(--text-primary);" class="pp-detail-available">${fmt(limiting.available)} ${ppUnitLabel(limiting.unit)}</div>
      </div>
      <div>
        <div style="font-size:12px;color:var(--text-muted);">${tt("pp_needed_for_plan", "Kerak")}:</div>
        <div style="font-size:16px;font-weight:700;color:var(--text-primary);" class="pp-detail-needed">${fmt(neededForPlanned)} ${ppUnitLabel(limiting.unit)}</div>
      </div>` : hasRecipe ? "" : `
      <div style="grid-column:1/-1;color:var(--text-muted);font-size:13px;">${tt("pp_no_limiting_ingredient", "Ushbu taom uchun cheklovchi xom-ashyo aniqlanmadi.")}</div>`}
    </div>
    <div class="pp-reco-remaining" style="border-top:1px solid var(--border);padding-top:12px;font-size:13.5px;color:var(--text-primary);">
      <div style="font-weight:700;margin-bottom:8px;">${tt("pp_remaining_resources", "Qolgan resurslar")}:</div>
      <div class="pp-reco-remaining-body"></div>
    </div>
  `;
  await ppRenderRecoRemaining(menuId, container.querySelector(".pp-reco-remaining-body"));
}

/** Shu taomning joriy rejasi asosida band bo'lgan cheklovchi ingredient qancha qolganini
 * va bu boshqa taomlarga (ayniqsa o'sha ingredientdan foydalanadigan) qanday ta'sir qilishini ko'rsatadi */
async function ppRenderRecoRemaining(menuId, el) {
  if (!el) return;
  const limiting = await ppLimitingIngredientDetail(menuId);
  if (!limiting) {
    el.innerHTML = `<div style="color:var(--text-muted);">${tt("pp_no_data", "Ma'lumot yo'q")}</div>`;
    return;
  }
  const planned = ppPlannedQty(menuId);
  const usedByThis = limiting.perPortion * planned;
  const remainingAfterThis = Math.max(0, limiting.available - usedByThis);
  const status = remainingAfterThis <= 0 ? { emoji: "🔴", color: "#e5484d" }
    : remainingAfterThis < limiting.available * 0.2 ? { emoji: "🟡", color: "#b8860b" }
    : { emoji: "🟢", color: "#2e9e6c" };

  // Shu cheklovchi ingredientdan foydalanadigan boshqa taomlarni topamiz va ularning yangi maksimalini hisoblaymiz
  const menuIds = await ppGetPlannableMenuItems();
  const affected = [];
  for (const otherId of menuIds) {
    if (otherId === menuId) continue;
    const otherReq = await ppGetRequirementPerPortion(otherId);
    const inv = window.allInventory || {};
    const sfpStore = window.allSemiFinished || {};
    let usesIt = false, perPortionOfLimiting = 0;
    for (const [ingId, amt] of otherReq.ing) {
      if ((menuName(inv[ingId]) || ingId) === limiting.name) { usesIt = true; perPortionOfLimiting = amt; break; }
    }
    if (!usesIt) {
      for (const [sfpId, amt] of otherReq.sfp) {
        if ((menuName(sfpStore[sfpId]) || sfpId) === limiting.name) { usesIt = true; perPortionOfLimiting = amt; break; }
      }
    }
    if (!usesIt) continue;
    const { max: newMax } = await ppMaxPortions(otherId);
    const oldRecommended = (await ppRecommendedQty(otherId)).recommended;
    affected.push({ name: menuName(window.allMenu[otherId]), newMax, oldRecommended });
  }

  el.innerHTML = `
    <div style="margin-bottom:10px;">
      <span style="font-size:15px;">🥩</span> <strong style="color:var(--text-primary);">${limiting.name}</strong>
      <span style="margin-left:8px;">${status.emoji}</span>
      <span style="margin-left:6px;font-weight:700;color:${status.color};">${fmt(Math.round(remainingAfterThis))} ${ppUnitLabel(limiting.unit)}</span>
    </div>
    ${affected.slice(0, 4).map(a => `
      <div style="padding:3px 0;color:#57606a;">
        ➡ ${a.name} ${tt("pp_now_can_produce", "endi")} ${a.oldRecommended !== a.newMax ? `<s style="color:var(--text-muted);">${fmt(a.oldRecommended)}</s> ` : ""}<strong style="color:var(--text-primary);">${fmt(a.newMax)} ${tt("portions_suffix", "porsiya")}</strong> ${tt("pp_can_be_produced", "ishlab chiqarilishi mumkin")}.
      </div>`).join("") || `<div style="color:var(--text-muted);">${tt("pp_no_other_dishes_affected", "Boshqa taomlarga ta'sir qilmaydi.")}</div>`}
  `;
}

/** Reja qatoridagi son o'zgarganda: shu qatorning statusi, ochiq bo'lsa uning batafsil bloki,
 * xuddi shu cheklovchi ingredientdan foydalanadigan BOSHQA ochiq qatorlarning "Maksimum" ustuni
 * va batafsil bloki, hamda pastdagi "Jami" qatori — barchasi real-time qayta hisoblanadi. */
async function ppRecalcRecommendationInPlace(el, changedMenuId) {
  const rows = el.querySelectorAll(".pp-reco-row");
  for (const row of rows) {
    const menuId = row.dataset.menuId;
    const { max } = await ppMaxPortions(menuId);
    const planned = ppPlannedQty(menuId);
    const maxCell = row.querySelector(".pp-reco-max");
    const statusEl = row.querySelector(".pp-reco-status");
    const numEl = row.querySelector(".pp-reco-planned-num");
    if (maxCell) maxCell.textContent = fmt(max);
    const status = ppRecoStatus(planned, max);
    if (statusEl) statusEl.textContent = status.emoji;
    if (numEl && document.activeElement !== numEl) { numEl.textContent = planned; numEl.style.color = status.color; }
    else if (numEl) numEl.style.color = status.color;

    // ochiq bo'lgan batafsil qatorlarni ham yangilaymiz (shu qator va boshqa ta'sirlangan qatorlar)
    const detailRow = el.querySelector(`.pp-reco-detail-row[data-menu-id="${menuId}"]`);
    if (detailRow && detailRow.style.display !== "none") {
      await ppRenderRecoDetail(menuId, detailRow.querySelector(".pp-reco-detail-body"));
    }
  }
  await ppRecalcRecoTotals();
}

/** Pastdagi "Jami" qatorini (rejalashtirilgan porsiya, ingredientlar soni, taxminiy tannarx/foyda) yangilaydi */
async function ppRecalcRecoTotals() {
  const totalPlannedEl = document.getElementById("pp-reco-total-planned");
  const totalCostEl = document.getElementById("pp-reco-total-cost");
  const totalProfitEl = document.getElementById("pp-reco-total-profit");
  if (!totalPlannedEl && !totalCostEl && !totalProfitEl) return;

  const menuIds = await ppGetPlannableMenuItems();
  let totalPlanned = 0;
  const planMap = {};
  const ingredientSet = new Set();
  for (const menuId of menuIds) {
    const qty = ppPlannedQty(menuId);
    if (qty <= 0) continue;
    totalPlanned += qty;
    planMap[menuId] = { planned: qty };
    const req = await ppGetRequirementPerPortion(menuId);
    for (const ingId of req.ing.keys()) ingredientSet.add("i:" + ingId);
    for (const sfpId of req.sfp.keys()) ingredientSet.add("s:" + sfpId);
  }
  const cost = await ppEstimateProductionCost(planMap);
  const revenue = ppEstimateRevenue(planMap);
  const profit = revenue - cost;

  if (totalPlannedEl) totalPlannedEl.textContent = `${fmt(totalPlanned)} ${tt("portions_suffix", "porsiya")}`;
  if (totalCostEl) totalCostEl.textContent = `${fmt(Math.round(cost))} ${tt("currency", "so'm")}`;
  if (totalProfitEl) {
    totalProfitEl.textContent = `${fmt(Math.round(profit))} ${tt("currency", "so'm")}`;
    totalProfitEl.style.color = profit < 0 ? "#e5484d" : "#2e9e6c";
  }
}

async function ppRenderPlanTable(el) {
  const menuIds = await ppGetPlannableMenuItems();
  const trs = [];
  for (const menuId of menuIds) {
    const { recommended } = await ppRecommendedQty(menuId);
    const planned = ppPlannedQty(menuId);
    trs.push(`<tr data-menu-id="${menuId}" style="border-top:1px solid var(--border);">
      <td style="padding:14px 16px;">${menuName(window.allMenu[menuId])}</td>
      <td style="padding:14px 16px;">${fmt(recommended)}</td>
      <td style="padding:14px 16px;">
        <input type="number" min="0" value="${planned}" data-menu-id="${menuId}" class="pp-planned-input"
          style="width:90px;padding:5px 8px;border-radius:6px;border:1px solid var(--border,#ccc);"><span class="pp-dirty-dot" style="display:none;" title="${tt("pp_unsaved", "Saqlanmagan o'zgarish")}"></span>
      </td>
    </tr>`);
  }

  el.innerHTML = `
    <div style="margin-bottom:12px;color:var(--muted,#888);font-size:13px;">
      <i class="fa-solid fa-circle-info"></i> ${tt("pp_plan_hint", "Rejalashtirilgan miqdorni o'zgartirsangiz, boshqa taomlar uchun mavjud resurslar avtomatik qayta hisoblanadi.")}
    </div>
    <div style="overflow-x:auto;">
    <table class="admin-table pp-sticky-table" style="width:100%;border-collapse:collapse;background:var(--bg-card);color:var(--text-primary);border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);">
      <thead><tr style="background:var(--bg-card);">
        <th style="text-align:left;padding:12px 16px;font-weight:700;color:var(--text-primary);">${tt("col_food_name", "Taom")}</th>
        <th style="text-align:left;padding:12px 16px;font-weight:700;color:var(--text-primary);">${tt("recommended_quantity", "Tavsiya")}</th>
        <th style="text-align:left;padding:12px 16px;font-weight:700;color:var(--text-primary);">${tt("pp_manual_plan", "Men belgilayman")}</th>
      </tr></thead>
      <tbody id="pp-plan-tbody">${trs.join("") || ppEmptyRow(3)}</tbody>
    </table>
    </div>
    <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin-top:22px;">
      <button class="btn" id="pp-save-plan-btn" onclick="window._ppSavePlan()" disabled
        style="background:#16a34a;color:#fff;border:none;padding:14px 32px;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 3px 10px rgba(22,163,74,.3);">
        ✅ ${tt("pp_save_plan", "Rejani saqlash")}
      </button>
    </div>
    <div id="pp-dirty-count" style="text-align:center;color:#f2994a;font-size:13px;margin-top:8px;"></div>
  `;

  ppUpdatePlanSaveButtonState();

  el.querySelectorAll(".pp-planned-input").forEach(input => {
    input.addEventListener("change", async (e) => {
      const menuId = e.target.dataset.menuId;
      ppSetPlannedLocal(menuId, e.target.value);
      ppUpdatePlanSaveButtonState();
    });
  });
}

/** "Rejani saqlash" tugmasi va har bir qatordagi "saqlanmagan" belgisini yangilaydi */
function ppUpdatePlanSaveButtonState() {
  const btn = document.getElementById("pp-save-plan-btn");
  const countEl = document.getElementById("pp-dirty-count");
  if (btn) btn.disabled = PP.dirty.size === 0;
  if (countEl) countEl.textContent = PP.dirty.size > 0 ? `${PP.dirty.size} ${tt("pp_unsaved_count_suffix", "ta o'zgarish saqlanmagan")}` : "";
  document.querySelectorAll("#pp-plan-tbody tr[data-menu-id]").forEach(row => {
    const dot = row.querySelector(".pp-dirty-dot");
    if (dot) dot.style.display = PP.dirty.has(row.dataset.menuId) ? "inline-block" : "none";
  });
}

window._ppSavePlan = async function () {
  if (!PP.dirty.size) return;
  const ids = [...PP.dirty];
  for (const menuId of ids) {
    await ppSetPlanned(menuId, ppPlannedQty(menuId));
  }
  PP.dirty.clear();
  ppToast(tt("pp_plan_saved", "Ishlab chiqarish rejasi saqlandi"));
  ppUpdatePlanSaveButtonState();
};

/** Reja jadvalidagi har bir qatorning "Maksimal" ustunini va progress-barini
 * DOM orqali to'g'ridan-to'g'ri yangilaydi — jadvalni butunlay qayta qurmaydi. */
async function ppRecalcPlanRowsInPlace() {
  const tbody = document.getElementById("pp-plan-tbody");
  if (!tbody) return;
  const rows = tbody.querySelectorAll("tr[data-menu-id]");
  for (const row of rows) {
    const menuId = row.dataset.menuId;
    const { max, limitingName } = await ppMaxPortions(menuId);
    const planned = ppPlannedQty(menuId);
    const numEl = row.querySelector(".pp-max-num");
    const nameEl = row.querySelector(".pp-limiting-name");
    const bar = row.querySelector(".pp-progress-bar-fill");
    if (numEl) numEl.textContent = fmt(max);
    if (nameEl) nameEl.textContent = limitingName ? `(${limitingName})` : "";
    if (bar) {
      const pct = max > 0 ? Math.round((planned / max) * 100) : (planned > 0 ? 100 : 0);
      const clamped = Math.max(0, Math.min(100, pct));
      bar.style.width = clamped + "%";
      bar.style.background = pct > 100 ? "#e5484d" : pct >= 90 ? "#f2994a" : "#2e9e6c";
    }
  }
}

// Simulyatsiya sahifasida QAT'IY 4 rangli tizim: OK=yashil, Ogohlantirish=sariq, Muammo=qizil, Ma'lumot=ko'k
const PP_SIM_COLORS = { ok: "#16a34a", warn: "#eab308", problem: "#e5484d", info: "#2563eb" };

async function ppRenderSimulation(el) {
  if (!PP.sim) {
    el.innerHTML = `
      <div style="padding:24px;text-align:center;">
        <i class="fa-solid fa-flask" style="font-size:28px;color:${PP_SIM_COLORS.info};margin-bottom:10px;"></i>
        <p data-i18n="pp_sim_intro">${tt("pp_sim_intro", "Simulyatsiya rejimida siz ombor zaxirasini o'zgartirmasdan turib, ishlab chiqarish rejasini sinab ko'rishingiz mumkin.")}</p>
        <button class="btn btn-primary" onclick="window._ppStartSimulation()" data-i18n="pp_start_simulation">${tt("pp_start_simulation", "Simulyatsiyani boshlash")}</button>
      </div>`;
    return;
  }

  const menuIds = await ppGetPlannableMenuItems();
  const trs = [];
  for (const menuId of menuIds) {
    const { max } = await ppMaxPortions(menuId);
    const planned = ppPlannedQty(menuId);
    trs.push(`<tr data-menu-id="${menuId}">
      <td>${menuName(window.allMenu[menuId])}</td>
      <td class="pp-max-num">${fmt(max)}</td>
      <td><input type="number" min="0" value="${planned}" data-menu-id="${menuId}" class="pp-sim-input"
        style="width:90px;padding:5px 8px;border-radius:6px;border:1px solid var(--border,#ccc);"></td>
    </tr>
    <tr class="pp-sim-row-warning" data-warning-for="${menuId}" style="display:none;">
      <td colspan="3" style="padding:0;"></td>
    </tr>`);
  }

  el.innerHTML = `
    <div id="pp-sim-status" style="margin-bottom:20px;"></div>

    <div style="display:flex;gap:10px;margin-bottom:14px;">
      <button class="btn btn-primary" onclick="window._ppApplySimulation()" data-i18n="apply_plan">${tt("apply_plan", "Rejani qo'llash")}</button>
      <button class="btn" onclick="window._ppCancelSimulation()" data-i18n="pp_cancel_simulation">${tt("pp_cancel_simulation", "Bekor qilish")}</button>
    </div>

    <h3 style="display:flex;align-items:center;gap:8px;"><i class="fa-solid fa-chart-simple" style="color:${PP_SIM_COLORS.info};"></i> <span data-i18n="pp_sim_summary_title">${tt("pp_sim_summary_title", "Simulyatsiya xulosasi")}</span></h3>
    <div id="pp-sim-summary" style="margin-bottom:26px;"></div>

    <h3 style="display:flex;align-items:center;gap:8px;"><i class="fa-solid fa-warehouse" style="color:${PP_SIM_COLORS.info};"></i> <span data-i18n="pp_sim_warehouse_status_title">${tt("pp_sim_warehouse_status_title", "Ombor holati")}</span></h3>
    <div id="pp-sim-warehouse-status" style="margin-bottom:26px;"></div>

    <h3 style="display:flex;align-items:center;gap:8px;"><i class="fa-solid fa-triangle-exclamation" style="color:${PP_SIM_COLORS.warn};"></i> <span data-i18n="pp_sim_warnings_title">${tt("pp_sim_warnings_title", "Ogohlantirishlar")}</span></h3>
    <div id="pp-sim-warnings" style="margin-bottom:26px;"></div>
  `;

  await ppRenderSimSections();
  for (const menuId of menuIds) await ppRenderRowWarning(menuId);

  el.querySelectorAll(".pp-sim-input").forEach(input => {
    input.addEventListener("change", async (e) => {
      const menuId = e.target.dataset.menuId;
      await ppSetPlanned(menuId, e.target.value);
      // Faqat sim jadvali va pastdagi bo'limlar yangilanadi
      await ppRecalcSimTable();
      await ppRenderSimSections();
      await ppRenderRowWarning(menuId);
    });
  });
}

/** Bitta taom uchun kiritilgan miqdor max'dan oshsa, qator ostida
 * "❌ Mumkin emas" panelini (sabab + variantlar) ko'rsatadi. */
async function ppRenderRowWarning(menuId) {
  const warningRow = document.querySelector(`.pp-sim-row-warning[data-warning-for="${menuId}"]`);
  if (!warningRow) return;
  const cell = warningRow.querySelector("td");
  const planned = ppPlannedQty(menuId);
  const { max, limitingName } = await ppMaxPortions(menuId);

  if (planned <= max || planned <= 0) {
    warningRow.style.display = "none";
    cell.innerHTML = "";
    return;
  }

  // Ushbu taomni cheklayotgan aniq masalliqni (va qancha kerakligini) topamiz
  const req = await ppGetRequirementPerPortion(menuId);
  const { reservedIng, reservedSfp } = await ppComputeReserved(menuId);
  const inv = window.allInventory || {};
  const sfpStore = window.allSemiFinished || {};
  let neededToBuy = 0, unit = "", buyName = limitingName;
  for (const [ingId, perPortion] of req.ing) {
    if (perPortion <= 0) continue;
    const stock = Number(inv[ingId]?.stock || 0);
    const reserved = reservedIng.get(ingId) || 0;
    const available = Math.max(0, stock - reserved);
    const needed = perPortion * planned;
    if (needed > available) {
      const missing = needed - available;
      if (missing > neededToBuy) { neededToBuy = missing; unit = inv[ingId]?.unit || ""; buyName = menuName(inv[ingId]) || ingId; }
    }
  }
  for (const [sfpId, perPortion] of req.sfp) {
    if (perPortion <= 0) continue;
    const stock = Number(sfpStore[sfpId]?.stock || 0);
    const reserved = reservedSfp.get(sfpId) || 0;
    const available = Math.max(0, stock - reserved);
    const needed = perPortion * planned;
    if (needed > available) {
      const missing = needed - available;
      if (missing > neededToBuy) { neededToBuy = missing; unit = sfpStore[sfpId]?.unit || ""; buyName = menuName(sfpStore[sfpId]) || sfpId; }
    }
  }

  warningRow.style.display = "";
  cell.innerHTML = `
    <div style="margin:6px 0 12px;border:1px solid ${PP_SIM_COLORS.problem};border-radius:10px;padding:14px 16px;background:${PP_SIM_COLORS.problem}0d;">
      <div style="font-weight:700;color:${PP_SIM_COLORS.problem};margin-bottom:8px;">❌ ${tt("pp_sim_row_not_possible", "Mumkin emas")}</div>
      <div style="font-size:12.5px;color:var(--muted,#888);margin-bottom:2px;">${tt("pp_sim_row_reason_label", "Sabab")}</div>
      <div style="font-size:13.5px;margin-bottom:12px;">${tt("pp_sim_row_reason_text", "{name} yetishmayapti.").replace("{name}", buyName)}</div>
      <div style="font-size:12.5px;color:var(--muted,#888);margin-bottom:6px;">${tt("pp_sim_row_options_label", "Variantlar")}</div>
      <div style="font-size:13.5px;margin-bottom:6px;">① ${tt("pp_sim_row_option_buy", "{qty} {unit} {name} sotib olish").replace("{qty}", fmt(Math.ceil(neededToBuy))).replace("{unit}", unit).replace("{name}", buyName)}</div>
      <div style="font-size:13.5px;color:var(--muted,#888);margin-bottom:6px;">${tt("pp_sim_solution_or", "yoki")}</div>
      <div style="font-size:13.5px;margin-bottom:10px;">② ${tt("pp_sim_row_option_reduce", "Rejani {qty} porsiyaga tushirish").replace("{qty}", fmt(max))}</div>
      <button onclick="window._ppAutoFixDish('${menuId}', ${max})" class="btn btn-primary" style="font-size:13px;padding:7px 14px;">
        🔵 ${tt("pp_sim_row_autofix_btn", "{qty} porsiyaga avtomatik tushirish").replace("{qty}", fmt(max))}
      </button>
    </div>`;
}

async function ppRecalcSimTable() {
  const tbody = document.getElementById("pp-sim-tbody");
  if (!tbody) return;
  const rows = tbody.querySelectorAll("tr[data-menu-id]");
  for (const row of rows) {
    const menuId = row.dataset.menuId;
    const { max } = await ppMaxPortions(menuId);
    const cell = row.querySelector(".pp-max-num");
    if (cell) cell.textContent = fmt(max);
  }
}

/** 2-5-bo'limlarni (Xulosa / Ombor holati / Ogohlantirishlar / Tavsiyalar) hisoblab render qiladi */
async function ppRenderSimSections() {
  const inv = window.allInventory || {};
  const menuIds = await ppGetPlannableMenuItems();
  const { reservedIng } = await ppComputeReserved(null);
  const shortages = await ppComputeShortages();
  const revenue = ppEstimateRevenue(PP.sim || {});
  const cost = await ppEstimateProductionCost(PP.sim || {});
  const profit = revenue - cost;

  let totalPlanned = 0;
  let plannedDishCount = 0;    // planned > 0 bo'lgan taomlar soni
  let readyDishCount = 0;      // planned <= max bo'lgan (to'liq tayyorlanadigan) taomlar soni
  const overCapacity = []; // { name, planned, max }
  for (const menuId of menuIds) {
    const planned = ppPlannedQty(menuId);
    totalPlanned += planned;
    if (planned <= 0) continue;
    plannedDishCount++;
    const { max } = await ppMaxPortions(menuId);
    if (planned > max) overCapacity.push({ name: menuName(window.allMenu[menuId]), planned, max });
    else readyDishCount++;
  }
  // "Tayyorlash mumkin %" — rejalashtirilgan taomlardan nechtasi to'liq (kamchiliksiz) tayyorlanishi mumkin
  const readinessPct = plannedDishCount > 0 ? Math.round((readyDishCount / plannedDishCount) * 100) : 100;

  // Zarar bilan sotilayotgan taomlar sonini aniqlaymiz (Foyda kartasi sub-line uchun)
  const profitRows = await ppEstimateProfitBreakdown(PP.sim || {});
  const lossDishCount = profitRows.filter(r => r.profit < 0).length;

  // ---- 2) Simulyatsiya xulosasi (4 ta katta kartochka) ----
  const summaryEl = document.getElementById("pp-sim-summary");
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="pp-cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;">
        ${ppSimCard("pp_sim_total_planned", "🟦 Jami ishlab chiqarish", fmt(totalPlanned) + " " + tt("pp_portions_suffix", "porsiya"), PP_SIM_COLORS.info, "fa-bowl-food",
          `${fmt(plannedDishCount)} ${tt("pp_sim_dishes_suffix", "taom")}`)}
        ${ppSimCard("pp_sim_readiness_pct", "🟩 Tayyorlash mumkin", readinessPct + " %", readinessPct === 100 ? PP_SIM_COLORS.ok : readinessPct >= 50 ? PP_SIM_COLORS.warn : PP_SIM_COLORS.problem, "fa-gauge-high",
          `${fmt(readyDishCount)} / ${fmt(plannedDishCount)} ${tt("pp_sim_readiness_sub", "taomni to'liq tayyorlash mumkin")}`)}
        ${ppSimCard("ingredient_shortage", "🟥 Yetishmayotgan masalliqlar", fmt(shortages.length) + " " + tt("pp_count_suffix", "ta"), shortages.length ? PP_SIM_COLORS.problem : PP_SIM_COLORS.ok, "fa-triangle-exclamation",
          shortages.length ? shortages[0].name : "")}
        ${ppSimProfitCard(profit, shortages, lossDishCount)}
      </div>
    `;
  }

  // ---- 3) Ombor holati ----
  const whEl = document.getElementById("pp-sim-warehouse-status");
  if (whEl) {
    const rows = [...reservedIng.entries()].filter(([, req]) => req > 0).map(([ingId, required]) => {
      const stock = Number(inv[ingId]?.stock || 0);
      const missing = Math.max(0, required - stock);
      return { name: menuName(inv[ingId]) || ingId, unit: inv[ingId]?.unit || "", stock, required, missing };
    }).sort((a, b) => b.missing - a.missing);

    whEl.innerHTML = rows.length ? `<div style="overflow-x:auto;">
      <table class="admin-table pp-sticky-table" style="width:100%;border-collapse:collapse;">
        <thead><tr>
          <th data-i18n="col_ingredient">${tt("col_ingredient", "Masalliq")}</th>
          <th data-i18n="available_stock">${tt("available_stock", "Mavjud")}</th>
          <th data-i18n="required_quantity">${tt("required_quantity", "Kerak")}</th>
          <th data-i18n="pp_sim_missing_col">${tt("pp_sim_missing_col", "Yetishmaydi")}</th>
          <th data-i18n="pp_sim_status_col">${tt("pp_sim_status_col", "Holati")}</th>
        </tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${r.name}</td>
          <td>${fmt(r.stock)} ${ppUnitLabel(r.unit)}</td>
          <td>${fmt(Math.round(r.required))} ${ppUnitLabel(r.unit)}</td>
          <td style="${r.missing > 0 ? "color:" + PP_SIM_COLORS.problem + ";font-weight:700;" : ""}">${fmt(Math.round(r.missing))} ${ppUnitLabel(r.unit)}</td>
          <td>${r.missing > 0 ? "🔴 " + tt("pp_sim_status_missing", "Yetishmaydi") : "🟢 " + tt("pp_sim_status_enough", "Yetarli")}</td>
        </tr>`).join("")}</tbody>
      </table>
      </div>` : ppNoticeBox(PP_SIM_COLORS.info, "fa-circle-info", tt("pp_sim_no_usage", "Hozircha rejalashtirilgan ishlab chiqarish yo'q."));
  }

  // ---- 4) Ogohlantirishlar — har bir yetishmovchilik + unga ta'sir qiladigan taomlar bitta blokda ----
  const warnEl = document.getElementById("pp-sim-warnings");
  if (warnEl) {
    const blocks = [];

    if (shortages.length) {
      // Har bir kam masalliqni qaysi taomlar qancha ishlatayotganini aniqlaymiz
      for (const s of shortages) {
        const affected = []; // { name, planned }
        for (const menuId of menuIds) {
          const planned = ppPlannedQty(menuId);
          if (planned <= 0) continue;
          const req = await ppGetRequirementPerPortion(menuId);
          const map = s.kind === "semiFinished" ? req.sfp : req.ing;
          const perPortion = map.get(s.id) || 0;
          if (perPortion <= 0) continue;
          affected.push({ name: menuName(window.allMenu[menuId]), planned });
        }
        affected.sort((a, b) => b.planned - a.planned);

        // Zaxira yetishmasa, bu masalliqni ishlatadigan HAR BIR taom uchun rejani 0 ga tushirish tavsiya etiladi —
        // chunki mavjud zaxira allaqachon boshqa taomlar tomonidan "band" (reserved), demak bu taomga umuman qolmaydi.
        blocks.push(`
          <div style="border:1px solid ${PP_SIM_COLORS.problem};border-radius:12px;padding:16px 18px;margin-bottom:12px;background:var(--card-bg,#fff);">
            <div style="font-weight:700;color:${PP_SIM_COLORS.problem};font-size:15.5px;margin-bottom:12px;">
              🔴 ${s.name} ${tt("pp_sim_shortage_insufficient", "yetarli emas")}
            </div>
            ${affected.length ? `
            <div style="font-size:12.5px;color:var(--muted,#888);margin-bottom:6px;">${tt("pp_sim_affected_dishes", "Ta'sir qilayotgan taomlar")}</div>
            <table style="width:100%;border-collapse:collapse;margin-bottom:10px;">
              <thead><tr style="border-bottom:1px solid #eee;">
                <th style="text-align:left;padding:4px 8px 4px 0;font-size:12.5px;color:var(--muted,#888);font-weight:600;">${tt("col_food_name", "Taom")}</th>
                <th style="text-align:left;padding:4px 8px;font-size:12.5px;color:var(--muted,#888);font-weight:600;">${tt("production_plan", "Reja")}</th>
                <th style="text-align:left;padding:4px 0 4px 8px;font-size:12.5px;color:var(--muted,#888);font-weight:600;">${tt("pp_sim_possible_col", "Mumkin")}</th>
              </tr></thead>
              <tbody>${affected.map(a => `<tr>
                <td style="padding:5px 8px 5px 0;font-size:13.5px;">${a.name}</td>
                <td style="padding:5px 8px;font-size:13.5px;">${fmt(a.planned)}</td>
                <td style="padding:5px 0 5px 8px;font-size:13.5px;font-weight:700;color:${PP_SIM_COLORS.problem};">0</td>
              </tr>`).join("")}</tbody>
            </table>` : ""}
            <div style="font-size:13.5px;font-weight:600;margin-bottom:10px;">${tt("pp_sim_missing_col", "Kam")}: ${fmt(Math.round(s.missing))} ${ppUnitLabel(s.unit)}</div>
            <div style="padding-top:10px;border-top:1px solid #eee;font-size:13px;">
              <div style="font-weight:600;margin-bottom:8px;">${tt("pp_sim_solution_label", "Tavsiya")}</div>
              <button onclick="window._ppGoToShoppingWithItem('${s.kind}', '${String(s.id).replace(/'/g, "\\'")}', '${String(s.name).replace(/'/g, "\\'")}', ${Math.round(s.missing)}, '${String(s.unit).replace(/'/g, "\\'")}')"
                class="btn btn-primary" style="font-size:13px;padding:8px 14px;">
                🛒 ${tt("pp_sim_create_shopping_list", "Bozorlik yaratish")}
              </button>
              <button onclick="window._ppAutoFixWholePlan()"
                class="btn" style="font-size:13px;padding:8px 14px;margin-left:8px;background:#0891b2;color:#fff;border:none;">
                🔵 ${tt("pp_sim_autofix_plan", "Rejani avtomatik tuzatish")}
              </button>
              <div style="margin-top:8px;color:var(--muted,#888);">${tt("pp_sim_solution_or", "yoki")}</div>
              <div>✅ ${tt("pp_sim_solution_reduce", "ishlab chiqarish rejasini kamaytiring")}</div>
            </div>
          </div>`);
      }
    }

    // Yuqoridagi qizil bloklarda allaqachon ko'rsatilgan taomlarni sariq blokda takrorlamaymiz
    const alreadyShownDishNames = new Set();
    if (shortages.length) {
      for (const s of shortages) {
        for (const menuId of menuIds) {
          const planned = ppPlannedQty(menuId);
          if (planned <= 0) continue;
          const req = await ppGetRequirementPerPortion(menuId);
          const map = s.kind === "semiFinished" ? req.sfp : req.ing;
          if ((map.get(s.id) || 0) > 0) alreadyShownDishNames.add(menuName(window.allMenu[menuId]));
        }
      }
    }
    for (const oc of overCapacity) {
      if (alreadyShownDishNames.has(oc.name)) continue; // qizil blokda allaqachon aytilgan
      blocks.push(ppNoticeBox(PP_SIM_COLORS.warn, "fa-arrow-down",
        tt("pp_sim_warn_reduce", "{dish} ishlab chiqarishni {from} dan {to} porsiyaga tushiring")
          .replace("{dish}", oc.name).replace("{from}", fmt(oc.planned)).replace("{to}", fmt(oc.max))));
    }

    warnEl.innerHTML = blocks.length
      ? blocks.join("")
      : ppNoticeBox(PP_SIM_COLORS.ok, "fa-circle-check", tt("pp_sim_warn_sufficient", "Ombor zaxirasi yetarli."));
  }

  // ---- 6) Yakuniy status kartasi — reja tayyor yoki emasligini bitta katta blokda ko'rsatadi ----
  const statusEl = document.getElementById("pp-sim-status");
  if (statusEl) {
    statusEl.innerHTML = ppPlanStatusCardHtml(shortages, profit, overCapacity);
  }
}

/** Reja "tayyor" yoki "tayyor emas"ligini aniqlab, sabab va tavsiyalar bilan bitta katta karta qaytaradi. */
function ppPlanStatusCardHtml(shortages, profit, overCapacity) {
  const reasons = [];
  if (shortages.length === 1) reasons.push(tt("pp_sim_status_reason_shortage_one", "1 ta mahsulot yetishmaydi"));
  else if (shortages.length > 1) reasons.push(tt("pp_sim_status_reason_shortage_many", "{n} ta mahsulot yetishmaydi").replace("{n}", fmt(shortages.length)));
  if (profit < 0) reasons.push(tt("pp_sim_status_reason_loss", "Kutilayotgan zarar mavjud"));
  if (overCapacity.length) reasons.push(tt("pp_sim_status_reason_overcapacity", "{n} ta taom rejalashtirilgan miqdorda tayyorlanmaydi").replace("{n}", fmt(overCapacity.length)));

  const isReady = reasons.length === 0;
  const color = isReady ? PP_SIM_COLORS.ok : PP_SIM_COLORS.problem;
  const icon = isReady ? "fa-circle-check" : "fa-circle-xmark";
  const title = isReady
    ? tt("pp_sim_status_ready", "Reja tayyor")
    : tt("pp_sim_status_not_ready", "Reja tayyor emas");
  const emoji = isReady ? "🟢" : "🔴";

  const recommendations = [];
  if (shortages.length) recommendations.push(tt("pp_sim_status_reco_shopping", "Bozorlik yarating"));
  if (profit < 0 || overCapacity.length) recommendations.push(tt("pp_sim_status_reco_recalc", "Ishlab chiqarish rejasini qayta hisoblang"));

  return `<div style="border:2px solid ${color};border-radius:14px;padding:20px 22px;background:${color}10;">
    <div style="display:flex;align-items:center;gap:10px;font-size:19px;font-weight:700;color:${color};margin-bottom:${reasons.length ? "14px" : "0"};">
      <i class="fa-solid ${icon}"></i> <span>${emoji} ${title}</span>
    </div>
    ${reasons.length ? `
    <div style="margin-bottom:${recommendations.length ? "14px" : "0"};">
      <div style="font-size:12.5px;font-weight:700;color:var(--muted,#888);margin-bottom:6px;" data-i18n="pp_sim_status_reasons_label">${tt("pp_sim_status_reasons_label", "Sabablar")}</div>
      ${reasons.map(r => `<div style="font-size:14px;color:${color};margin-bottom:3px;">🔴 ${r}</div>`).join("")}
    </div>` : ""}
    ${recommendations.length ? `
    <div>
      <div style="font-size:12.5px;font-weight:700;color:var(--muted,#888);margin-bottom:6px;" data-i18n="pp_sim_status_reco_label">${tt("pp_sim_status_reco_label", "Tavsiya")}</div>
      ${recommendations.map(r => `<div style="font-size:14px;color:#16a34a;margin-bottom:3px;">🟢 ${r}</div>`).join("")}
    </div>` : ""}
  </div>`;
}

function ppSimCard(key, fallback, valueHtml, color, icon, subLine = "") {
  return `<div class="pp-stat-card" style="background:var(--card-bg,#fff);border-radius:12px;padding:16px 18px;box-shadow:0 2px 8px rgba(0,0,0,.06);border-left:4px solid ${color};display:flex;align-items:center;gap:14px;">
    <div style="width:42px;height:42px;border-radius:10px;background:${color}22;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
      <i class="fa-solid ${icon}" style="color:${color};font-size:17px;"></i>
    </div>
    <div>
      <div style="font-size:12.5px;color:var(--muted,#888);" data-i18n="${key}">${tt(key, fallback)}</div>
      <div style="font-size:21px;font-weight:700;color:${color};">${valueHtml}</div>
      ${subLine ? `<div style="font-size:12px;color:var(--muted,#888);margin-top:2px;">${subLine}</div>` : ""}
    </div>
  </div>`;
}

/** Foyda kartasi — manfiy bo'lsa, faqat raqam emas, aniq sabablar ro'yxati va
 * "Tafsilotlarni ko'rish" tugmasi ham chiqadi (bosilganda taom bo'yicha breakdown modali ochiladi). */
function ppSimProfitCard(profit, shortages, lossDishCount = 0) {
  const color = profit < 0 ? PP_SIM_COLORS.problem : PP_SIM_COLORS.ok;
  const valueHtml = `${fmt(Math.round(profit))} ${tt("currency", "so'm")}`;
  if (profit >= 0) {
    return `<div class="pp-stat-card" style="background:var(--card-bg,#fff);border-radius:12px;padding:16px 18px;box-shadow:0 2px 8px rgba(0,0,0,.06);border-left:4px solid ${color};">
      <div style="display:flex;align-items:center;gap:14px;">
        <div style="width:42px;height:42px;border-radius:10px;background:${color}22;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <i class="fa-solid fa-sack-dollar" style="color:${color};font-size:17px;"></i>
        </div>
        <div>
          <div style="font-size:12.5px;color:var(--muted,#888);" data-i18n="pp_sim_estimated_profit">${tt("pp_sim_estimated_profit", "🟨 Kutilayotgan foyda")}</div>
          <div style="font-size:21px;font-weight:700;color:${color};">${valueHtml}</div>
          ${lossDishCount > 0 ? `<div style="font-size:12px;color:var(--muted,#888);margin-top:2px;">${tt("pp_sim_loss_dish_count", "{n} ta taom zarar bilan sotilyapti").replace("{n}", fmt(lossDishCount))}</div>` : ""}
        </div>
      </div>
    </div>`;
  }

  // Manfiy foyda — sabablarni aniqlaymiz: (1) yetishmovchilik bormi, (2) tannarx narxdan yuqori taomlar bormi.
  // Ikkinchisi uchun joriy sinxron reja bo'yicha allaqachon hisoblangan reservedIng dan foydalanmasdan,
  // faqat oddiy belgi sifatida umumiy holatni ko'rsatamiz (aniq ro'yxat "Tafsilotlarni ko'rish" da chiqadi).
  const reasons = [];
  if (shortages && shortages.length) {
    const topShortage = shortages[0];
    reasons.push({ emoji: "🔴", text: tt("pp_sim_profit_reason_shortage", "{name} yetishmayapti").replace("{name}", topShortage.name) });
  }
  if (lossDishCount > 0) {
    reasons.push({ emoji: "🔴", text: tt("pp_sim_profit_reason_cost", "Ba'zi taomlar tannarxi sotuv narxidan yuqori") });
  }
  reasons.push({ emoji: "🟢", text: tt("pp_sim_profit_reason_reco", "Narxni oshirish tavsiya etiladi") });

  return `<div class="pp-stat-card" style="background:var(--card-bg,#fff);border-radius:12px;padding:16px 18px;box-shadow:0 2px 8px rgba(0,0,0,.06);border-left:4px solid ${color};">
    <div style="display:flex;align-items:center;gap:14px;">
      <div style="width:42px;height:42px;border-radius:10px;background:${color}22;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="fa-solid fa-sack-dollar" style="color:${color};font-size:17px;"></i>
      </div>
      <div>
        <div style="font-size:12.5px;color:var(--muted,#888);" data-i18n="pp_sim_estimated_profit">${tt("pp_sim_estimated_profit", "🟨 Kutilayotgan foyda")}</div>
        <div style="font-size:21px;font-weight:700;color:${color};">${valueHtml}</div>
        ${lossDishCount > 0 ? `<div style="font-size:12px;color:var(--muted,#888);margin-top:2px;">${tt("pp_sim_loss_dish_count", "{n} ta taom zarar bilan sotilyapti").replace("{n}", fmt(lossDishCount))}</div>` : ""}
      </div>
    </div>
    <div style="font-size:12px;color:${color};margin-top:10px;line-height:1.6;">
      <div style="font-weight:700;margin-bottom:3px;" data-i18n="pp_sim_profit_reason_title">${tt("pp_sim_profit_reason_title", "Sabablari")}</div>
      ${reasons.map(r => `<div>${r.emoji} ${r.text}</div>`).join("")}
    </div>
    <button onclick="window._ppOpenProfitDetails()" class="btn" style="margin-top:10px;font-size:12px;padding:6px 12px;width:100%;">
      <i class="fa-solid fa-list"></i> ${tt("pp_sim_profit_view_details", "Tafsilotlarni ko'rish")}
    </button>
  </div>`;
}

function ppSimStatusLabel(status) {
  return {
    enough: tt("pp_sim_status_enough", "Yetarli"),
    low: tt("pp_sim_status_low", "Kam"),
    missing: tt("pp_sim_status_missing", "Yetishmaydi")
  }[status] || status;
}

function ppNoticeBox(color, icon, text) {
  return `<div style="padding:14px 16px;border-radius:10px;background:${color}18;border:1px solid ${color};color:${color};margin-bottom:8px;font-size:13.5px;">
    <i class="fa-solid ${icon}"></i> ${text}
  </div>`;
}

// ==========================================
// 📋 FOYDA TAFSILOTLARI MODALI — taom bo'yicha tannarx/sotuv narxi/foyda/zarar
// ==========================================
window._ppOpenProfitDetails = async function () {
  let modal = document.getElementById("pp-profit-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "pp-profit-modal";
    modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px;";
    modal.innerHTML = `
      <div style="background:var(--card-bg,#fff);border-radius:14px;max-width:720px;width:100%;max-height:85vh;overflow-y:auto;padding:22px 24px;position:relative;">
        <button onclick="window._ppCloseProfitDetails()" style="position:absolute;top:14px;right:16px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted,#888);">&times;</button>
        <h3 style="margin-top:0;display:flex;align-items:center;gap:8px;"><i class="fa-solid fa-sack-dollar" style="color:#2e9e6c;"></i> <span data-i18n="pp_profit_details_title">${tt("pp_profit_details_title", "Foyda tafsilotlari")}</span></h3>
        <div id="pp-profit-modal-body">${tt("pp_loading", "Yuklanmoqda...")}</div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => { if (e.target === modal) window._ppCloseProfitDetails(); });
  }
  modal.style.display = "flex";
  const body = document.getElementById("pp-profit-modal-body");
  const rows = await ppEstimateProfitBreakdown(PP.sim || PP.plan || {});
  body.innerHTML = ppProfitDetailsTableHtml(rows);
};
window._ppCloseProfitDetails = function () {
  const modal = document.getElementById("pp-profit-modal");
  if (modal) modal.style.display = "none";
};

function ppProfitDetailsTableHtml(rows) {
  if (!rows.length) {
    return `<div style="padding:16px;color:var(--muted,#888);">${tt("pp_no_data", "Ma'lumot yo'q")}</div>`;
  }
  return `<div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="border-bottom:1px solid #eee;">
        <th style="text-align:left;padding:6px 8px 6px 0;font-size:12.5px;color:var(--muted,#888);font-weight:600;">${tt("col_food_name", "Taom")}</th>
        <th style="text-align:right;padding:6px 8px;font-size:12.5px;color:var(--muted,#888);font-weight:600;">${tt("production_plan", "Reja")}</th>
        <th style="text-align:right;padding:6px 8px;font-size:12.5px;color:var(--muted,#888);font-weight:600;">${tt("pp_profit_cost_col", "Tannarx")}</th>
        <th style="text-align:right;padding:6px 8px;font-size:12.5px;color:var(--muted,#888);font-weight:600;">${tt("pp_profit_price_col", "Sotuv narxi")}</th>
        <th style="text-align:right;padding:6px 0 6px 8px;font-size:12.5px;color:var(--muted,#888);font-weight:600;">${tt("pp_report_profit", "Foyda / Zarar")}</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr style="border-bottom:1px solid #f3f3f3;">
        <td style="padding:7px 8px 7px 0;font-size:13.5px;">${r.name}</td>
        <td style="padding:7px 8px;font-size:13.5px;text-align:right;">${fmt(r.qty)}</td>
        <td style="padding:7px 8px;font-size:13.5px;text-align:right;">${fmt(Math.round(r.costPerPortion))} ${tt("currency", "so'm")}</td>
        <td style="padding:7px 8px;font-size:13.5px;text-align:right;">${fmt(Math.round(r.pricePerPortion))} ${tt("currency", "so'm")}</td>
        <td style="padding:7px 0 7px 8px;font-size:13.5px;text-align:right;font-weight:700;color:${r.profit < 0 ? "#e5484d" : "#16a34a"};">${r.profit < 0 ? "−" : "+"}${fmt(Math.abs(Math.round(r.profit)))} ${tt("currency", "so'm")}</td>
      </tr>`).join("")}</tbody>
    </table>
  </div>`;
}

// ==========================================
// 🛒 "Bozorlik yaratish" tugmasi — yetishmayotgan masalliqni saqlab, Warehouse > Bozorlik
// bo'limiga o'tkazadi. Bozorlik (shopping-planner.js) moduli o'zining davrga asoslangan
// hisob-kitobini avtomatik ishga tushiradi (initShoppingPlanner); mos kelgan masalliq
// PP.pendingShoppingHighlight orqali belgilanadi — shopping-planner modulida shu
// o'zgaruvchini o'qish/qidirish sozlanganda, u avtomatik ta'kidlanadi/ochiladi.
// ==========================================
window._ppGoToShoppingWithItem = function (kind, id, name, missing, unit) {
  PP.pendingShoppingHighlight = { kind, id, name, missing, unit };
  window.showSection && window.showSection("warehouse");
  setTimeout(() => {
    window.warehouseSwitchSubtab && window.warehouseSwitchSubtab("shopping-planner");
  }, 80);
};

/** Bitta taomni max darajaga (yoki 0 gacha) avtomatik tushiradi va UI'ni yangilaydi */
window._ppAutoFixDish = async function (menuId, toQty) {
  await ppSetPlanned(menuId, toQty);
  const input = document.querySelector(`.pp-sim-input[data-menu-id="${menuId}"]`);
  if (input) input.value = toQty;
  await ppRecalcSimTable();
  await ppRenderSimSections();
  await ppRenderRowWarning(menuId);
  ppToast(tt("pp_sim_autofix_done", "Reja avtomatik tuzatildi"));
};

/** 🔵 "Rejani avtomatik tuzatish" — barcha yetishmayotgan masalliqqa ega taomlarni
 * ombordagi haqiqiy imkoniyat (max porsiya) darajasigacha bir marta bosish bilan tushiradi. */
window._ppAutoFixWholePlan = async function () {
  const menuIds = await ppGetPlannableMenuItems();
  let changed = 0;
  // Bir nechta marta o'tamiz, chunki bitta taomni kamaytirish boshqa taom uchun
  // band qilingan (reserved) resursni bo'shatishi va uning max qiymatini oshirishi mumkin —
  // shu sababli barqarorlashguncha (yoki 5 marta) qayta hisoblaymiz.
  for (let pass = 0; pass < 5; pass++) {
    let passChanged = false;
    for (const menuId of menuIds) {
      const planned = ppPlannedQty(menuId);
      if (planned <= 0) continue;
      const { max } = await ppMaxPortions(menuId);
      if (planned > max) {
        await ppSetPlanned(menuId, max);
        passChanged = true;
        changed++;
      }
    }
    if (!passChanged) break;
  }
  await ppRecalcSimTable();
  await ppRenderSimSections();
  // Inputlarni ham yangilaymiz
  document.querySelectorAll(".pp-sim-input").forEach(input => {
    const menuId = input.dataset.menuId;
    input.value = ppPlannedQty(menuId);
  });
  for (const menuId of menuIds) await ppRenderRowWarning(menuId);
  ppToast(changed
    ? tt("pp_sim_autofix_whole_done", "Reja avtomatik tuzatildi")
    : tt("pp_sim_autofix_nothing", "Tuzatish kerak emas"));
};

window._ppStartSimulation = function () {
  PP.sim = {};
  for (const [menuId, rec] of Object.entries(PP.plan)) {
    PP.sim[menuId] = Number(rec.planned || 0);
  }
  ppRenderRoot();
};
window._ppCancelSimulation = function () {
  PP.sim = null;
  ppRenderRoot();
};
window._ppApplySimulation = async function () {
  if (!PP.sim) return;
  const overrides = PP.sim;
  PP.sim = null;
  for (const [menuId, planned] of Object.entries(overrides)) {
    await ppSetPlanned(menuId, planned);
  }
  ppToast(tt("pp_plan_applied", "Simulyatsiya asosidagi reja qo'llanildi"));
  ppRenderRoot();
};

function ppShortageTableHtml(shortages) {
  if (!shortages.length) {
    return `<div class="admin-alert admin-alert--success" style="padding:18px;color:#166534;" data-i18n="pp_no_shortage">
      <i class="fa-solid fa-circle-check"></i> ${tt("pp_no_shortage", "Hozircha yetishmovchilik yo'q")}
    </div>`;
  }
  return `<div style="overflow-x:auto;">
  <table class="admin-table pp-sticky-table" style="width:100%;border-collapse:collapse;">
    <thead><tr>
      <th data-i18n="col_ingredient">${tt("col_ingredient", "Ingredient")}</th>
      <th style="text-align:center;" data-i18n="available_stock">${tt("available_stock", "Omborda")}</th>
      <th style="text-align:center;" data-i18n="required_quantity">${tt("required_quantity", "Kerak")}</th>
      <th style="text-align:center;" data-i18n="pp_missing_qty">${tt("pp_missing_qty", "Yetmaydi")}</th>
    </tr></thead>
    <tbody>
      ${shortages.map(s => `<tr>
        <td>${s.name}</td>
        <td style="text-align:center;">${fmt(s.stock)} ${ppUnitLabel(s.unit)}</td>
        <td style="text-align:center;">${fmt(s.needed)} ${ppUnitLabel(s.unit)}</td>
        <td style="text-align:center;"><span class="pp-badge" style="background:#e5484d;">${fmt(s.missing)} ${ppUnitLabel(s.unit)}</span></td>
      </tr>`).join("")}
    </tbody>
  </table>
  </div>
  <div style="margin-top:16px;padding:14px 18px;background:var(--admin-danger-bg);border:1px solid #e5484d;border-radius:10px;color:var(--admin-danger-text);font-weight:600;">
    🔴 ${tt("pp_shortage_buy_first", "Ishlab chiqarishni boshlashdan oldin xarid qilish tavsiya etiladi.")}
  </div>`;
}

async function ppRenderShortages(el) {
  const shortages = await ppComputeShortages();
  el.innerHTML = `
    <h3><i class="fa-solid fa-triangle-exclamation" style="color:#e5484d;"></i> <span data-i18n="ingredient_shortage">${tt("ingredient_shortage", "Yetishmayotgan masalliqlar")}</span></h3>
    ${ppShortageTableHtml(shortages)}
  `;
}

async function ppRenderReports(el) {
  el.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">
      <label data-i18n="pp_report_from">${tt("pp_report_from", "Dan")}</label>
      <input type="date" id="pp-report-from" value="${PP.reportFrom}">
      <label data-i18n="pp_report_to">${tt("pp_report_to", "Gacha")}</label>
      <input type="date" id="pp-report-to" value="${PP.reportTo}">
      <button class="btn btn-primary" id="pp-report-run" data-i18n="pp_report_run">${tt("pp_report_run", "Hisobotni shakllantirish")}</button>
      <button class="btn" id="pp-report-export-excel" style="display:none;" data-i18n="export_excel"><i class="fa-solid fa-file-excel"></i> ${tt("export_excel", "Excel eksport")}</button>
      <button class="btn" id="pp-report-export-pdf" style="display:none;" data-i18n="export_pdf"><i class="fa-solid fa-file-pdf"></i> ${tt("export_pdf", "PDF eksport")}</button>
    </div>
    <div id="pp-report-output"><i class="fa-solid fa-circle-info"></i> ${tt("pp_report_hint", "Sana oralig'ini tanlang va hisobotni shakllantiring.")}</div>
  `;
  document.getElementById("pp-report-run").addEventListener("click", async () => {
    PP.reportFrom = document.getElementById("pp-report-from").value || PP.reportFrom;
    PP.reportTo = document.getElementById("pp-report-to").value || PP.reportTo;
    const out = document.getElementById("pp-report-output");
    out.innerHTML = tt("pp_loading", "Yuklanmoqda...");
    const { plannedVsActual, usageTotals, waste, shortages } = await ppReportRange(PP.reportFrom, PP.reportTo);
    const inv = window.allInventory || {};

    // Taomlar bo'yicha jamlash — eng ko'p/eng kam ishlab chiqarilganlar uchun
    const byMenu = new Map();
    for (const r of plannedVsActual) {
      const cur = byMenu.get(r.menuId) || { name: r.name, planned: 0, actual: 0 };
      cur.planned += r.planned;
      cur.actual += r.actual || 0;
      byMenu.set(r.menuId, cur);
    }
    const totalPlanned = plannedVsActual.reduce((a, r) => a + r.planned, 0);
    const totalActual = plannedVsActual.reduce((a, r) => a + (r.actual || 0), 0);
    const diff = totalActual - totalPlanned;
    const sortedByActual = [...byMenu.values()].sort((a, b) => b.actual - a.actual);
    const top5 = sortedByActual.slice(0, 5);
    const bottom5 = sortedByActual.filter(x => x.actual > 0).slice(-5).reverse();
    const top8ForChart = sortedByActual.slice(0, 8);

    // Foyda baholash — davr davomida qayd etilgan haqiqiy ishlab chiqarish bo'yicha
    const actualPlanMap = {};
    for (const [menuId, v] of byMenu) actualPlanMap[menuId] = v.actual;
    const revenue = ppEstimateRevenue(actualPlanMap);
    const cost = await ppEstimateProductionCost(actualPlanMap);
    const profit = revenue - cost;

    const totalWaste = waste.reduce((a, w) => a + w.waste, 0);

    // Kunlar bo'yicha foyda — "Foyda dinamikasi" grafigi uchun
    const byDate = new Map();
    for (const r of plannedVsActual) {
      const cur = byDate.get(r.date) || { actualMap: {} };
      cur.actualMap[r.menuId] = (cur.actualMap[r.menuId] || 0) + (r.actual || 0);
      byDate.set(r.date, cur);
    }
    const profitByDate = [];
    for (const [date, v] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const dayRevenue = ppEstimateRevenue(v.actualMap);
      const dayCost = await ppEstimateProductionCost(v.actualMap);
      profitByDate.push({ date, profit: dayRevenue - dayCost });
    }

    PP.lastReport = { plannedVsActual, usageTotals, waste, shortages, totalPlanned, totalActual, diff };

    out.innerHTML = `
      <h3><i class="fa-solid fa-calendar-days" style="color:#2563eb;"></i> <span data-i18n="pp_report_period_label">${tt("pp_report_period_label", "Davr")}</span>: ${PP.reportFrom} — ${PP.reportTo}</h3>
      <div class="pp-cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:24px;">
        ${ppStatCard("production_plan", "🍽 Rejalashtirilgan", fmt(totalPlanned) + " " + tt("pp_portions_suffix", "porsiya"), "#2563eb", "fa-clipboard-list")}
        ${ppStatCard("pp_actual_production", "✅ Ishlab chiqarildi", fmt(totalActual) + " " + tt("pp_portions_suffix", "porsiya"), "#16a34a", "fa-check-double")}
        ${ppStatCard("pp_report_diff", "📈 Farq", (diff > 0 ? "+" : "") + fmt(diff) + " " + tt("pp_portions_suffix", "porsiya"), diff < 0 ? "#e5484d" : "#16a34a", "fa-arrow-trend-up")}
        ${ppStatCard("pp_report_profit", "💰 Foyda", fmt(Math.round(profit)) + " " + tt("currency", "so'm"), profit < 0 ? "#e5484d" : "#16a34a", "fa-sack-dollar")}
        ${ppStatCard("ingredient_shortage", "⚠ Yetishmovchilik", fmt(shortages.length) + " " + tt("pp_items_suffix", "ta mahsulot"), shortages.length ? "#e5484d" : "#16a34a", "fa-triangle-exclamation")}
        ${ppStatCard("pp_report_waste", "🗑 Chiqindi", fmt(Math.round(totalWaste)) + " " + tt("pp_portions_suffix", "porsiya"), totalWaste > 0 ? "#f2994a" : "#16a34a", "fa-trash")}
      </div>

      <h3><i class="fa-solid fa-table-list" style="color:#2563eb;"></i> <span data-i18n="pp_report_plan_vs_actual">${tt("pp_report_plan_vs_actual", "Reja va fakt")}</span></h3>
      <div style="overflow-x:auto;margin-bottom:24px;">
      <table class="admin-table" style="width:100%;border-collapse:collapse;">
        <thead><tr>
          <th data-i18n="col_food_name">${tt("col_food_name", "Taom")}</th>
          <th style="text-align:center;" data-i18n="production_plan">${tt("production_plan", "Reja")}</th>
          <th style="text-align:center;" data-i18n="pp_actual_production">${tt("pp_actual_production", "Fakt")}</th>
          <th style="text-align:center;" data-i18n="pp_report_diff">${tt("pp_report_diff", "Farq")}</th>
        </tr></thead>
        <tbody>${sortedByActual.map(x => { const d = x.actual - x.planned; return `<tr>
          <td>${x.name}</td>
          <td style="text-align:center;">${fmt(x.planned)}</td>
          <td style="text-align:center;">${fmt(x.actual)}</td>
          <td style="text-align:center;color:${d < 0 ? "#e5484d" : "#16a34a"};font-weight:600;">${d > 0 ? "+" : ""}${fmt(d)}</td>
        </tr>`; }).join("") || ppEmptyRow(4, "pp_no_data", "Ma'lumot yo'q")}</tbody>
      </table>
      </div>

      <h3><i class="fa-solid fa-sack-dollar" style="color:#16a34a;"></i> <span data-i18n="pp_report_profit">${tt("pp_report_profit", "Foyda baholanishi")}</span></h3>
      <div style="background:var(--card-bg,#fff);border-radius:12px;padding:20px 22px;box-shadow:0 2px 8px rgba(0,0,0,.06);border-left:4px solid ${profit < 0 ? "#e5484d" : "#16a34a"};margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
          <h4 style="margin:0;font-size:15px;display:flex;align-items:center;gap:8px;"><i class="fa-solid fa-sack-dollar" style="color:#16a34a;"></i> <span data-i18n="pp_report_profit">${tt("pp_report_profit", "Moliyaviy natija")}</span></h4>
          <span style="display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-size:12.5px;font-weight:700;background:${profit < 0 ? "#e5484d22" : "#16a34a22"};color:${profit < 0 ? "#e5484d" : "#16a34a"};">
            ${profit < 0 ? "🔴" : "🟢"} <span data-i18n="${profit < 0 ? "pp_status_loss" : "pp_status_profit"}">${tt(profit < 0 ? "pp_status_loss" : "pp_status_profit", profit < 0 ? "Zarar" : "Foyda")}</span>
          </span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:0;">
          <div style="padding:0 16px 0 0;border-right:1px solid var(--border,#eee);">
            <div style="font-size:12.5px;color:var(--muted,#888);" data-i18n="pp_report_revenue">${tt("pp_report_revenue", "Taxminiy tushum")}</div>
            <div style="font-size:20px;font-weight:700;color:#0891b2;">${fmt(Math.round(revenue))} ${tt("currency", "so'm")}</div>
          </div>
          <div style="padding:0 16px;border-right:1px solid var(--border,#eee);">
            <div style="font-size:12.5px;color:var(--muted,#888);" data-i18n="pp_stat_production_cost">${tt("pp_stat_production_cost", "Ishlab chiqarish tannarxi")}</div>
            <div style="font-size:20px;font-weight:700;color:#4f46e5;">${fmt(Math.round(cost))} ${tt("currency", "so'm")}</div>
          </div>
          <div style="padding:0 0 0 16px;">
            <div style="font-size:12.5px;color:var(--muted,#888);" data-i18n="pp_report_profit">${tt("pp_report_profit", "Foyda")}</div>
            <div style="font-size:20px;font-weight:700;color:${profit < 0 ? "#e5484d" : "#16a34a"};">${fmt(Math.round(profit))} ${tt("currency", "so'm")}</div>
          </div>
        </div>
      </div>

      <h3><i class="fa-solid fa-arrow-trend-up" style="color:#16a34a;"></i> <span data-i18n="pp_report_top5">${tt("pp_report_top5", "TOP ishlab chiqarilgan taomlar")}</span></h3>
      <div style="overflow-x:auto;margin-bottom:8px;">
      <table class="admin-table" style="width:100%;border-collapse:collapse;">
        <thead><tr><th data-i18n="col_food_name">${tt("col_food_name", "Taom")}</th><th style="text-align:center;" data-i18n="pp_actual_production">${tt("pp_actual_production", "Haqiqiy")}</th></tr></thead>
        <tbody>${top5.map((x, i) => `<tr><td>${["🥇", "🥈", "🥉"][i] || `${i + 1}.`} ${x.name}</td><td style="text-align:center;"><b>${fmt(x.actual)}</b></td></tr>`).join("") || ppEmptyRow(2, "pp_no_data", "Ma'lumot yo'q")}</tbody>
      </table>
      </div>
      ${bottom5.length ? `
      <details style="margin-bottom:20px;">
        <summary style="cursor:pointer;padding:8px 0;font-weight:600;color:var(--muted,#666);display:flex;align-items:center;gap:8px;">
          <i class="fa-solid fa-arrow-trend-down" style="color:#e5484d;"></i> <span data-i18n="pp_report_bottom5">${tt("pp_report_bottom5", "Eng kam ishlab chiqarilgan")}</span>
        </summary>
        <div style="overflow-x:auto;margin-top:10px;">
        <table class="admin-table" style="width:100%;border-collapse:collapse;">
          <thead><tr><th data-i18n="col_food_name">${tt("col_food_name", "Taom")}</th><th style="text-align:center;" data-i18n="pp_actual_production">${tt("pp_actual_production", "Haqiqiy")}</th></tr></thead>
          <tbody>${bottom5.map(x => `<tr><td>${x.name}</td><td style="text-align:center;">${fmt(x.actual)}</td></tr>`).join("")}</tbody>
        </table>
        </div>
      </details>` : ""}

      <h3 data-i18n="pp_report_usage">${tt("pp_report_usage", "Masalliqlar sarfi")}</h3>
      ${usageTotals.size ? `
      <div style="overflow-x:auto;">
      <table class="admin-table" style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <thead><tr><th data-i18n="col_ingredient">${tt("col_ingredient", "Masalliq")}</th><th data-i18n="pp_report_total_usage">${tt("pp_report_total_usage", "Jami sarflangan")}</th></tr></thead>
        <tbody>${[...usageTotals.entries()].map(([ingId, val]) => `<tr>
          <td>${menuName(inv[ingId]) || ingId}</td><td>${fmt(val)} ${ppUnitLabel(inv[ingId]?.unit || "")}</td>
        </tr>`).join("")}</tbody>
      </table>
      </div>` : `
      <div style="padding:16px 18px;color:var(--muted,#888);background:var(--card-bg,#f8f9fa);border-radius:10px;margin-bottom:20px;" data-i18n="pp_usage_not_calculated">
        <i class="fa-solid fa-circle-info"></i> ${tt("pp_usage_not_calculated", "Bu davr uchun masalliqlar sarfi hali hisoblanmagan.")}
      </div>`}

      <h3 data-i18n="pp_report_waste">${tt("pp_report_waste", "Chiqindi (waste) baholanishi")}</h3>
      <div style="overflow-x:auto;">
      <table class="admin-table" style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <thead><tr>
          <th data-i18n="col_food_name">${tt("col_food_name", "Taom")}</th>
          <th style="text-align:center;" data-i18n="pp_actual_production">${tt("pp_actual_production", "Ishlab chiqarildi")}</th>
          <th style="text-align:center;" data-i18n="pp_report_sold">${tt("pp_report_sold", "Sotilgan")}</th>
          <th style="text-align:center;" data-i18n="pp_report_waste_qty">${tt("pp_report_waste_qty", "Qoldiq")}</th>
        </tr></thead>
        <tbody>${[...(() => {
          const byDish = new Map();
          for (const w of waste) {
            const cur = byDish.get(w.name) || { name: w.name, actual: 0, sold: 0, waste: 0 };
            cur.actual += w.actual; cur.sold += w.sold; cur.waste += w.waste;
            byDish.set(w.name, cur);
          }
          return byDish.values();
        })()].filter(w => w.waste > 0).sort((a, b) => b.waste - a.waste).map(w => `<tr>
          <td>${w.name}</td>
          <td style="text-align:center;">${fmt(w.actual)}</td>
          <td style="text-align:center;">${fmt(w.sold)}</td>
          <td style="text-align:center;color:#f2994a;font-weight:600;">${fmt(w.waste)}</td>
        </tr>`).join("") || `<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--muted,#888);" data-i18n="pp_no_waste">${tt("pp_no_waste", "Chiqindi qayd etilmagan")}</td></tr>`}</tbody>
      </table>
      </div>

      <h3 data-i18n="ingredient_shortage">${tt("ingredient_shortage", "Yetishmayotgan masalliqlar")}</h3>
      ${shortages.length ? `
      <div style="background:var(--card-bg,#fff);border-radius:12px;padding:18px 20px;box-shadow:0 2px 8px rgba(0,0,0,.06);border-left:4px solid #e5484d;margin-bottom:20px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-weight:700;color:#e5484d;">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <span data-i18n="pp_missing_products">${tt("pp_missing_products", "Yetishmayotgan mahsulot")}</span>: ${shortages.length}
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px;">
          ${shortages.slice(0, 5).sort((a, b) => b.missing - a.missing).map(s => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--border,#eee);">
              <span style="font-weight:600;">${s.name}</span>
              <span style="display:flex;gap:16px;font-size:13px;color:var(--muted,#888);">
                <span data-i18n="available_stock">${tt("available_stock", "Omborda")}</span>: ${fmt(s.stock)} ${ppUnitLabel(s.unit)}
                <span data-i18n="required_quantity">${tt("required_quantity", "Kerak")}</span>: ${fmt(s.needed)} ${ppUnitLabel(s.unit)}
                <span style="color:#e5484d;font-weight:700;"><span data-i18n="pp_missing_qty">${tt("pp_missing_qty", "Kam")}</span>: ${fmt(s.missing)} ${ppUnitLabel(s.unit)}</span>
              </span>
            </div>`).join("")}
          ${shortages.length > 5 ? `<div style="color:var(--muted,#888);font-size:13px;">+${shortages.length - 5} ${tt("pp_more_items", "ta yana")}</div>` : ""}
        </div>
        <button class="btn btn-primary" style="width:100%;" onclick="window.showSection('warehouse'); setTimeout(() => window.warehouseSwitchSubtab && window.warehouseSwitchSubtab('shopping-planner'), 80);">
          🛒 <span data-i18n="pp_create_shopping_list">${tt("pp_create_shopping_list", "Bozorlik yaratish")}</span>
        </button>
      </div>` : `
      <div class="admin-alert admin-alert--success" style="padding:18px;color:#166534;margin-bottom:20px;" data-i18n="pp_no_shortage">
        <i class="fa-solid fa-circle-check"></i> ${tt("pp_no_shortage", "Hozircha yetishmovchilik yo'q")}
      </div>`}

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-bottom:20px;">
        <div style="background:var(--card-bg,#fff);border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.06);">
          <h3 style="margin:0 0 10px;font-size:14px;" data-i18n="pp_chart_dishes_title">${tt("pp_chart_dishes_title", "Reja vs Fakt")}</h3>
          <canvas id="pp-chart-dishes" height="220"></canvas>
        </div>
        <div style="background:var(--card-bg,#fff);border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.06);">
          <h3 style="margin:0 0 10px;font-size:14px;" data-i18n="pp_chart_profit_title">${tt("pp_chart_profit_title", "Foyda dinamikasi")}</h3>
          <canvas id="pp-chart-profit" height="220"></canvas>
        </div>
        <div style="background:var(--card-bg,#fff);border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.06);">
          <h3 style="margin:0 0 10px;font-size:14px;" data-i18n="pp_chart_top_dishes_title">${tt("pp_chart_top_dishes_title", "Eng ko'p ishlab chiqarilgan taomlar")}</h3>
          <canvas id="pp-chart-top-dishes" height="220"></canvas>
        </div>
        <div style="background:var(--card-bg,#fff);border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.06);">
          <h3 style="margin:0 0 10px;font-size:14px;" data-i18n="pp_chart_usage_title">${tt("pp_chart_usage_title", "Masalliqlar sarfi")}</h3>
          <canvas id="pp-chart-usage" height="220"></canvas>
        </div>
      </div>
    `;

    ppRenderReportCharts(top8ForChart, usageTotals, inv, profitByDate);

    const excelBtn = document.getElementById("pp-report-export-excel");
    const pdfBtn = document.getElementById("pp-report-export-pdf");
    if (excelBtn) excelBtn.style.display = "inline-flex";
    if (pdfBtn) pdfBtn.style.display = "inline-flex";
  });

  document.getElementById("pp-report-export-excel").addEventListener("click", ppExportReportExcel);
  document.getElementById("pp-report-export-pdf").addEventListener("click", ppExportReportPdf);
}

function ppRenderReportCharts(top8, usageTotals, inv, profitByDate) {
  if (typeof Chart === "undefined") return; // Chart.js yuklanmagan bo'lsa, jadval hisobotlar baribir ishlaydi
  if (PP.charts.dishes) { PP.charts.dishes.destroy(); PP.charts.dishes = null; }
  if (PP.charts.usage) { PP.charts.usage.destroy(); PP.charts.usage = null; }
  if (PP.charts.profit) { PP.charts.profit.destroy(); PP.charts.profit = null; }
  if (PP.charts.topDishes) { PP.charts.topDishes.destroy(); PP.charts.topDishes = null; }

  const dishesCanvas = document.getElementById("pp-chart-dishes");
  if (dishesCanvas) {
    PP.charts.dishes = new Chart(dishesCanvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: top8.map(x => x.name),
        datasets: [
          { label: tt("production_plan", "Rejalashtirilgan"), data: top8.map(x => x.planned), backgroundColor: "#2563eb" },
          { label: tt("pp_actual_production", "Haqiqiy"), data: top8.map(x => x.actual), backgroundColor: "#16a34a" }
        ]
      },
      options: { responsive: true, plugins: { legend: { position: "bottom" } }, scales: { y: { beginAtZero: true } } }
    });
  }

  const profitCanvas = document.getElementById("pp-chart-profit");
  if (profitCanvas && profitByDate && profitByDate.length) {
    PP.charts.profit = new Chart(profitCanvas.getContext("2d"), {
      type: "line",
      data: {
        labels: profitByDate.map(p => p.date),
        datasets: [{
          label: tt("pp_report_profit", "Foyda"),
          data: profitByDate.map(p => Math.round(p.profit)),
          borderColor: "#16a34a",
          backgroundColor: "#16a34a22",
          fill: true,
          tension: 0.3,
          pointBackgroundColor: profitByDate.map(p => p.profit < 0 ? "#e5484d" : "#16a34a")
        }]
      },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: false } } }
    });
  } else if (profitCanvas) {
    const ctx = profitCanvas.getContext("2d");
    ctx.font = "13px sans-serif";
    ctx.fillStyle = "#888";
    ctx.textAlign = "center";
    ctx.fillText(tt("pp_no_data", "Ma'lumot yo'q"), profitCanvas.width / 2, profitCanvas.height / 2);
  }

  const topDishesCanvas = document.getElementById("pp-chart-top-dishes");
  if (topDishesCanvas) {
    const top8Sorted = [...top8].sort((a, b) => b.actual - a.actual).slice(0, 8);
    PP.charts.topDishes = new Chart(topDishesCanvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: top8Sorted.map(x => x.name),
        datasets: [{ label: tt("pp_actual_production", "Haqiqiy"), data: top8Sorted.map(x => x.actual), backgroundColor: "#f2994a" }]
      },
      options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } }
    });
  }

  const usageCanvas = document.getElementById("pp-chart-usage");
  if (usageCanvas) {
    const entries = [...usageTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (entries.length) {
      const palette = ["#2563eb", "#16a34a", "#f2994a", "#7c3aed", "#e5484d", "#0891b2", "#eab308", "#64748b"];
      PP.charts.usage = new Chart(usageCanvas.getContext("2d"), {
        type: "pie",
        data: {
          labels: entries.map(([ingId]) => menuName(inv[ingId]) || ingId),
          datasets: [{ data: entries.map(([, v]) => v), backgroundColor: palette }]
        },
        options: { responsive: true, plugins: { legend: { position: "right" } } }
      });
    } else {
      const ctx = usageCanvas.getContext("2d");
      ctx.font = "13px sans-serif";
      ctx.fillStyle = "#888";
      ctx.textAlign = "center";
      ctx.fillText(tt("pp_no_data", "Ma'lumot yo'q"), usageCanvas.width / 2, usageCanvas.height / 2);
    }
  }
}

function ppExportReportExcel() {
  if (!PP.lastReport || typeof XLSX === "undefined") return;
  const rows = PP.lastReport.plannedVsActual.map(r => ({
    [tt("pp_col_date", "Sana")]: r.date,
    [tt("col_food_name", "Taom")]: r.name,
    [tt("production_plan", "Rejalashtirilgan")]: r.planned,
    [tt("pp_actual_production", "Haqiqiy")]: r.actual == null ? "" : r.actual
  }));
  exportRowsToExcel({
    rows,
    sheetName: tt("pp_tab_reports", "Hisobotlar"),
    filename: buildExportFilename("production_report", PP.reportFrom, PP.reportTo),
  });
}

function ppExportReportPdf() {
  if (!PP.lastReport || typeof jsPDF === "undefined") return;
  const pdf = new jsPDF("landscape");
  pdf.setFontSize(14);
  pdf.text(`${tt("pp_tab_reports", "Hisobotlar")} — ${PP.reportFrom} / ${PP.reportTo}`, 10, 12);
  const rows = PP.lastReport.plannedVsActual.map(r => [r.date, r.name, fmt(r.planned), r.actual == null ? "—" : fmt(r.actual)]);
  if (typeof pdf.autoTable === "function") {
    pdf.autoTable({
      startY: 18,
      head: [[tt("pp_col_date", "Sana"), tt("col_food_name", "Taom"), tt("production_plan", "Reja"), tt("pp_actual_production", "Haqiqiy")]],
      body: rows
    });
  }
  pdf.save(`production_report_${PP.reportFrom}_${PP.reportTo}.pdf`);
}

// ==========================================
// 🛒 BOZORLIK — Shopping Planner'ning hisoblash yadrosini qayta ishlatadi
// (mantiqni takrorlamaslik uchun dynamic import, aylanma bog'liqlikdan qochish uchun)
// ==========================================
async function ppRenderShoppingTab(el) {
  el.innerHTML = `<div style="padding:30px;text-align:center;color:var(--muted,#888);">${tt("pp_loading", "Yuklanmoqda...")}</div>`;
  let mod;
  try {
    mod = await import("./shopping-planner.js");
  } catch (e) {
    el.innerHTML = `<div style="padding:20px;color:#e5484d;">${tt("pp_render_error", "Bo'limni yuklashda xatolik yuz berdi")}</div>`;
    return;
  }

  const presets = mod.PERIOD_PRESETS;
  const calc = await mod.spComputeAll(PP.shoppingPeriodDays, 1);
  PP.lastShoppingCalc = calc;

  const verdictHtml = calc.sufficient
    ? `<div class="admin-alert admin-alert--success">
        <div class="admin-alert-title"><i class="fa-solid fa-circle-check"></i> <span data-i18n="warehouse_sufficient">${tt("warehouse_sufficient", "Ombor zaxirasi yetarli.")}</span></div>
        <div class="admin-alert-body" data-i18n="shopping_not_required">${tt("shopping_not_required", "Hozircha xarid qilish shart emas.")}</div>
      </div>`
    : `<div class="admin-alert admin-alert--danger">
        <div class="admin-alert-title"><i class="fa-solid fa-triangle-exclamation"></i> <span data-i18n="warehouse_insufficient">${tt("warehouse_insufficient", "Ombor zaxirasi yetarli emas.")}</span></div>
        <div class="admin-alert-body" data-i18n="shopping_required">${tt("shopping_required", "Xarid qilish tavsiya etiladi.")}</div>
      </div>`;

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <label data-i18n="planning_period">${tt("planning_period", "Rejalashtirish davri")}:</label>
        ${presets.map(p => `<button class="kassa-subtab-btn${PP.shoppingPeriodLabel === p.id ? " active" : ""}"
          onclick="window._ppSetShoppingPeriod('${p.id}', ${p.days})">${tt(p.key, p.fb)}</button>`).join("")}
        <input type="number" min="1" id="pp-shopping-custom-days" placeholder="${tt("custom_period", "Maxsus...")}"
          style="width:100px;padding:5px 8px;border-radius:6px;border:1px solid var(--border,#ccc);">
        <button class="btn btn-primary" onclick="window._ppApplyShoppingCustomPeriod()" data-i18n="sp_apply_period">${tt("sp_apply_period", "Qo'llash")}</button>
      </div>
      ${calc.sufficient ? "" : `
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn" onclick="window._ppShoppingExportExcel()" data-i18n="export_excel">⬇ ${tt("export_excel", "Excel")}</button>
        <button class="btn" onclick="window._ppShoppingPrint()" data-i18n="print_shopping_list">🖨 ${tt("print_shopping_list", "Chop etish")}</button>
        <button class="btn" onclick="window._ppShoppingExportPdf()" data-i18n="export_pdf">📄 PDF</button>
      </div>`}
    </div>
    ${verdictHtml}
    ${calc.sufficient ? "" : `
    <div style="display:flex;flex-direction:column;gap:12px;">
      ${calc.shoppingItems.map(i => `
      <div style="background:var(--card-bg,#fff);border-radius:12px;padding:16px 20px;box-shadow:0 2px 8px rgba(0,0,0,.06);border-left:4px solid #e5484d;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
          <div style="font-weight:700;font-size:15.5px;">🛒 ${i.name}</div>
          <button class="btn btn-primary" style="font-size:12.5px;padding:6px 12px;" onclick="window._ppOpenSupplierModal('${i.id}', '${String(i.name).replace(/'/g, "\\'")}', ${Math.round(i.toBuy)}, '${String(i.unit).replace(/'/g, "\\'")}')">
            🛒 ${tt("pp_shopping_buy_btn", "Xarid qilish")}
          </button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;">
          <div>
            <div style="font-size:12px;color:var(--muted,#888);" data-i18n="required_quantity">${tt("required_quantity", "Kerak")}:</div>
            <div style="font-weight:600;">${fmt(Math.round(i.required))} ${ppUnitLabel(i.unit)}</div>
          </div>
          <div>
            <div style="font-size:12px;color:var(--muted,#888);" data-i18n="available_stock">${tt("available_stock", "Mavjud")}:</div>
            <div style="font-weight:600;">${fmt(i.stock)} ${ppUnitLabel(i.unit)}</div>
          </div>
          <div>
            <div style="font-size:12px;color:var(--muted,#888);" data-i18n="purchase_quantity">${tt("purchase_quantity", "Sotib olish")}:</div>
            <div style="font-weight:700;color:#e5484d;">${fmt(Math.round(i.toBuy))} ${ppUnitLabel(i.unit)}</div>
          </div>
          <div>
            <div style="font-size:12px;color:var(--muted,#888);" data-i18n="remaining_days">${tt("remaining_days", "Yetadi")}:</div>
            <div style="font-weight:600;">${isFinite(i.daysRemaining) ? Math.round(i.daysRemaining * 10) / 10 + " " + tt("sp_days_unit", "kun") : "—"}</div>
          </div>
        </div>
      </div>`).join("") || `<div style="padding:16px;color:var(--muted,#888);">${tt("pp_no_data", "Ma'lumot yo'q")}</div>`}
    </div>
    <div style="margin-top:18px;background:var(--card-bg,#fff);border-radius:12px;padding:18px 20px;box-shadow:0 2px 8px rgba(0,0,0,.06);border-left:4px solid #0891b2;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px;">
      <div>
        <div style="font-size:12.5px;color:var(--muted,#888);" data-i18n="pp_total_items">${tt("pp_total_items", "Umumiy xarid")}</div>
        <div style="font-size:19px;font-weight:700;">${calc.shoppingItems.length} ${tt("pp_items_suffix", "ta mahsulot")}</div>
      </div>
      <div>
        <div style="font-size:12.5px;color:var(--muted,#888);" data-i18n="pp_est_cost">${tt("pp_est_cost", "Taxminiy xarajat")}</div>
        <div style="font-size:19px;font-weight:700;color:#0891b2;">${fmt(Math.round(calc.totalEstCost))} ${tt("currency", "so'm")}</div>
      </div>
    </div>`}
  `;
}

// ==========================================
// 🏪 TA'MINOTCHILAR (SUPPLIERS) — restaurants/{id}/suppliers/{ingredientId}/{supplierId}
// Har bir masalliq uchun bir nechta ta'minotchi: { name, price, rating }
// ==========================================
async function ppGetSuppliersFor(ingredientId) {
  try {
    const snap = await get(ref(db, `${basePath()}/suppliers/${ingredientId}`));
    if (!snap.exists()) return [];
    const val = snap.val();
    return Object.entries(val).map(([id, s]) => ({ id, ...s }));
  } catch (e) {
    console.warn("Suppliers load error:", e);
    return [];
  }
}

function ppStarsHtml(rating) {
  const r = Math.round(Number(rating) || 0);
  return "★".repeat(Math.max(0, Math.min(5, r))) + "☆".repeat(5 - Math.max(0, Math.min(5, r)));
}

/** 🛒 "Xarid qilish" modali — ta'minotchilarni narx bo'yicha solishtirib, bitta bosishda buyurtma beradi. */
window._ppOpenSupplierModal = async function (ingredientId, ingredientName, qty, unit) {
  let overlay = document.getElementById("pp-supplier-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "pp-supplier-modal-overlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99998;display:flex;align-items:center;justify-content:center;padding:16px;";
    overlay.addEventListener("click", (e) => { if (e.target === overlay) window._ppCloseSupplierModal(); });
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div style="background:var(--card-bg,#fff);border-radius:14px;max-width:480px;width:100%;max-height:86vh;overflow-y:auto;padding:22px 24px;">
    <div style="text-align:center;padding:30px;color:var(--muted,#888);">${tt("pp_loading", "Yuklanmoqda...")}</div>
  </div>`;

  const suppliers = (await ppGetSuppliersFor(ingredientId)).sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
  const box = overlay.querySelector("div");

  if (!suppliers.length) {
    box.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 style="margin:0;">🛒 ${ingredientName}</h3>
        <button onclick="window._ppCloseSupplierModal()" class="btn" style="padding:4px 10px;">✕</button>
      </div>
      <div style="padding:16px;color:var(--muted,#888);text-align:center;">${tt("pp_no_suppliers", "Bu masalliq uchun ta'minotchi kiritilmagan.")}</div>
      <button class="btn" style="width:100%;margin-top:10px;" onclick="window.showSection('warehouse'); setTimeout(() => window.warehouseSwitchSubtab && window.warehouseSwitchSubtab('shopping-planner'), 80); window._ppCloseSupplierModal();">
        ${tt("pp_manage_suppliers", "Ta'minotchilarni boshqarish")}
      </button>`;
    return;
  }

  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <h3 style="margin:0;">🛒 ${ingredientName}</h3>
      <button onclick="window._ppCloseSupplierModal()" class="btn" style="padding:4px 10px;">✕</button>
    </div>
    <div style="color:var(--muted,#888);font-size:13px;margin-bottom:16px;">${fmt(qty)} ${unit}</div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${suppliers.map((s, idx) => {
        const total = Number(s.price || 0) * qty;
        const isBest = idx === 0;
        return `<div class="${isBest ? "admin-alert admin-alert--success" : ""}" style="${isBest ? "" : "border:1px solid var(--border,#e5e7eb);"}border-radius:10px;padding:14px 16px;margin-bottom:0;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <div style="font-weight:700;">${s.name || tt("pp_unnamed_supplier", "Nomsiz ta'minotchi")}</div>
            ${isBest ? `<span style="font-size:11.5px;font-weight:700;color:#2e9e6c;">${tt("pp_cheapest_supplier", "Eng arzon ta'minotchi")}</span>` : ""}
          </div>
          <div style="color:#f2994a;font-size:13px;margin-bottom:8px;">${ppStarsHtml(s.rating)}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
            <div>
              <div style="font-size:12px;color:var(--muted,#888);">${tt("pp_supplier_price", "Narxi")}</div>
              <div style="font-weight:600;">${fmt(s.price)} ${tt("currency", "so'm")}/${unit}</div>
            </div>
            <div>
              <div style="font-size:12px;color:var(--muted,#888);">${tt("pp_supplier_total", "Jami")}</div>
              <div style="font-weight:700;color:${isBest ? "#2e9e6c" : "inherit"};">${fmt(Math.round(total))} ${tt("currency", "so'm")}</div>
            </div>
          </div>
          <button class="btn btn-primary" style="width:100%;" onclick="window._ppConfirmSupplierOrder('${ingredientId}', '${String(ingredientName).replace(/'/g, "\\'")}', '${s.id}', '${String(s.name || "").replace(/'/g, "\\'")}', ${Number(s.price || 0)}, ${qty}, '${String(unit).replace(/'/g, "\\'")}')">
            ${tt("pp_place_order", "Buyurtma berish")}
          </button>
        </div>`;
      }).join("")}
    </div>`;
};

window._ppCloseSupplierModal = function () {
  const overlay = document.getElementById("pp-supplier-modal-overlay");
  if (overlay) overlay.remove();
};

/** Buyurtma tasdiqlangach — shoppingHistory/{id} ga yoziladi (mavjud "Ro'yxatni saqlash" mantig'iga o'xshab) */
window._ppConfirmSupplierOrder = async function (ingredientId, ingredientName, supplierId, supplierName, price, qty, unit) {
  const totalCost = price * qty;
  try {
    const newRef = push(ref(db, `${basePath()}/shoppingHistory`));
    await set(newRef, {
      createdAt: Date.now(),
      createdBy: (window.currentUser && (window.currentUser.name || window.currentUser.email)) || "",
      periodDays: PP.shoppingPeriodDays,
      totalEstCost: totalCost,
      items: [{
        ingId: ingredientId, name: ingredientName, toBuy: qty, unit,
        supplierId, supplierName, price, totalCost
      }],
      imported: {}
    });
    ppToast(tt("pp_order_saved", "Buyurtma bozorlik tarixiga saqlandi"));
    window._ppCloseSupplierModal();
  } catch (e) {
    console.warn("Order save error:", e);
    ppToast(tt("pp_save_error", "Saqlashda xatolik yuz berdi"), "error");
  }
};

window._ppShoppingExportExcel = async function () {
  if (!PP.lastShoppingCalc) return;
  const mod = await import("./shopping-planner.js");
  mod.spExcelFromCalc(PP.lastShoppingCalc);
};
window._ppShoppingExportPdf = async function () {
  if (!PP.lastShoppingCalc) return;
  const mod = await import("./shopping-planner.js");
  mod.spPdfFromCalc(PP.lastShoppingCalc);
};
window._ppShoppingPrint = async function () {
  if (!PP.lastShoppingCalc) return;
  const mod = await import("./shopping-planner.js");
  mod.spPrintFromCalc(PP.lastShoppingCalc);
};

window._ppSetShoppingPeriod = function (id, days) {
  PP.shoppingPeriodLabel = id;
  PP.shoppingPeriodDays = days;
  ppRenderTabContent();
};
window._ppApplyShoppingCustomPeriod = function () {
  const val = Number(document.getElementById("pp-shopping-custom-days")?.value);
  if (val > 0) {
    PP.shoppingPeriodLabel = "custom";
    PP.shoppingPeriodDays = val;
    ppRenderTabContent();
  }
};

// ==========================================
// 🚀 INIT — showSection('production-planner') dan chaqiriladi
// ==========================================
window.initProductionPlanner = async function () {
  if (!window.allMenu || !window.allInventory) {
    // ombor/menyu keshi hali tayyor bo'lmasa, biroz kutib qayta urinamiz
    setTimeout(() => window.initProductionPlanner(), 500);
    return;
  }
  if (!PP.inited) {
    PP.inited = true;
    await ppLoadPlan(PP.date);
  }
  ppRenderRoot();
};

// ==========================================
// 📤 EXPORTS — boshqa modullar (masalan Bozorlik/Shopping Planner) uchun
// hisoblash funksiyalarini qayta ishlatish, mantiqni takrorlamaslik uchun
// ==========================================
export {
  ppGetRequirementPerPortion,
  ppComputeReserved,
  ppComputeShortages,
  ppMaxPortions,
  ppAvgDailySales,
  ppSameWeekdayAvg,
  ppGetPlannableMenuItems,
  ppPlannedQty,
  ppLoadPlan,
  menuName,
  todayStr,
  fmt
};