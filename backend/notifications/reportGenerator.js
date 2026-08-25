// notifications/reportGenerator.js — computes the numbers behind the Daily/
// Weekly/Monthly Telegram report (spec section 5) straight from the same
// Firebase data the Admin Panel already reads (restaurants/{id}/orders,
// warehouse, users, courierAssignments, feedback, customers) — no new data
// model, no duplicated business logic. Field names mirror the exact ones
// already used by admin.js's own `loadNotifications()`
// (admin-frontend/public/js/admin.js:14535+): `item.quantity ?? item.qty`,
// `item.minQuantity ?? item.minQty`, etc.
//
// This module ONLY computes data — it never sends anything. The scheduler
// calls it, formats the result with templates.formatPeriodReport(), and
// hands the text to NotificationService.
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so every read in this file goes through the
// admin-or-client fallback (systemDb.js) instead of the plain client SDK.
import { systemGet } from "../systemDb.js";
import { basePath } from "./common.js";

function inRange(ts, from, to) {
  return typeof ts === "number" && ts >= from && ts < to;
}

function orderTimestamp(o) {
  return Number(o.createdAt || o.updatedAt || 0);
}

const READY_STATUSES = new Set(["tayyor", "ready", "served", "berildi", "yakunlandi", "completed"]);
const DELIVERED_ORDER_STATUSES = new Set(["delivered", "yetkazildi", "completed", "served"]);

/** Priority classification mirrors shopping-planner.js's spPriorityFor thresholds. */
function priorityForDaysRemaining(days) {
  if (days == null) return "low";
  if (days < 2) return "critical";
  if (days < 5) return "high";
  if (days < 14) return "medium";
  return "low";
}

async function computeSales(restId, from, to) {
  const snap = await systemGet(`${basePath(restId)}/orders`);
  const all = Object.values(snap.val() || {});
  const inPeriod = all.filter((o) => inRange(orderTimestamp(o), from, to));

  const revenue = inPeriod.reduce((sum, o) => sum + Number(o.total || o.finalTotal || 0), 0);
  const orders = inPeriod.length;
  const avgCheck = orders ? revenue / orders : 0;

  // No per-order COGS is tracked anywhere in this codebase yet, so profit is
  // an estimate using a configurable margin (defaults to 35%) rather than a
  // fabricated exact figure — documented here, not hidden.
  const estimatedMarginPct = 35;
  const profit = revenue * (estimatedMarginPct / 100);

  let prepared = 0;
  let lateOrders = 0;
  let cookMinutesSum = 0;
  let cookSamples = 0;

  inPeriod.forEach((o) => {
    const statusKey = String(o.statusKey || o.status || "").toLowerCase();
    const itemCount = Array.isArray(o.items) ? o.items.length : Object.keys(o.items || {}).length;
    if (READY_STATUSES.has(statusKey)) {
      prepared += itemCount;
      const createdAt = Number(o.createdAt || 0);
      const readyAt = Number(o.readyAt || o.updatedAt || 0);
      if (createdAt && readyAt && readyAt > createdAt) {
        const mins = (readyAt - createdAt) / 60000;
        cookMinutesSum += mins;
        cookSamples += 1;
        if (mins >= 30) lateOrders += 1;
      }
    }
  });

  return {
    sales: { orders, revenue, avgCheck, profit },
    kitchen: {
      prepared,
      avgCookMinutes: cookSamples ? Math.round(cookMinutesSum / cookSamples) : 0,
      lateOrders,
    },
    _ordersInPeriod: inPeriod,
  };
}

async function computeWarehouse(restId) {
  const snap = await systemGet(`${basePath(restId)}/warehouse`);
  const items = Object.entries(snap.val() || {});
  if (!items.length) {
    return { healthPct: 100, low: 0, critical: 0, outOfStock: 0, needsShopping: false, lowStockIngredients: [], topShortageDish: null };
  }

  let low = 0, critical = 0, outOfStock = 0, healthy = 0;
  const lowStockIngredients = [];

  items.forEach(([, item]) => {
    const qty = Number(item.quantity ?? item.qty ?? 0);
    const minQty = Number(item.minQuantity ?? item.minQty ?? 0);
    const avgDailyUsage = Number(item.avgDailyUsage || 0) || (minQty > 0 ? minQty / 7 : 0);
    const daysRemaining = avgDailyUsage > 0 ? qty / avgDailyUsage : null;
    const priority = qty <= 0 ? "out" : priorityForDaysRemaining(daysRemaining);

    if (priority === "out") outOfStock += 1;
    else if (priority === "critical") { critical += 1; lowStockIngredients.push(item.name || "—"); }
    else if (priority === "high") { low += 1; lowStockIngredients.push(item.name || "—"); }
    else healthy += 1;
  });

  const total = items.length;
  const healthPct = total ? Math.round((healthy / total) * 100) : 100;

  return {
    healthPct,
    low,
    critical,
    outOfStock,
    needsShopping: low + critical + outOfStock > 0,
    lowStockIngredients,
    topShortageDish: null, // requires recipe→ingredient mapping; left for a future extension (see final report)
  };
}

async function computeEmployees(restId, ordersInPeriod) {
  const snap = await systemGet(`${basePath(restId)}/users`);
  const users = Object.entries(snap.val() || {});
  const working = users.filter(([, u]) => (u.role === "chef" || u.role === "waiter" || u.role === "head_chef" || u.role === "cashier") && u.active !== false).length;

  // Attendance (late/absent) has no tracking subsystem in this codebase yet
  // — see final report's "future extension points". Left at 0 rather than
  // fabricated.
  const late = 0;
  const absent = 0;

  const chefCounts = {};
  const waiterCounts = {};
  ordersInPeriod.forEach((o) => {
    if (o.chefId) chefCounts[o.chefId] = (chefCounts[o.chefId] || 0) + 1;
    if (o.waiterId) waiterCounts[o.waiterId] = (waiterCounts[o.waiterId] || 0) + 1;
  });
  const topOf = (counts) => {
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (!best) return null;
    const user = users.find(([id]) => id === best[0]);
    return user ? user[1].name : null;
  };

  return { working, late, absent, topChef: topOf(chefCounts), topWaiter: topOf(waiterCounts) };
}

async function computeDelivery(restId, from, to) {
  const snap = await systemGet(`${basePath(restId)}/courierAssignments`);
  const all = Object.values(snap.val() || {});
  const inPeriod = all.filter((a) => inRange(Number(a.assignedAt || 0), from, to));

  const delivered = inPeriod.filter((a) => DELIVERED_ORDER_STATUSES.has(String(a.status || "").toLowerCase()));
  const cancelled = inPeriod.filter((a) => String(a.status || "").toLowerCase() === "cancelled");

  const minutes = delivered
    .map((a) => (a.deliveredAt && a.assignedAt ? (a.deliveredAt - a.assignedAt) / 60000 : null))
    .filter((m) => m != null);
  const avgMinutes = minutes.length ? Math.round(minutes.reduce((s, m) => s + m, 0) / minutes.length) : 0;

  return { completed: delivered.length, avgMinutes, cancelled: cancelled.length };
}

async function computeCustomers(restId, from, to) {
  const [custSnap, feedbackSnap] = await Promise.all([
    systemGet(`${basePath(restId)}/customers`),
    systemGet(`${basePath(restId)}/feedback`),
  ]);
  const customers = Object.values(custSnap.val() || {});
  const feedback = Object.values(feedbackSnap.val() || {}).filter((f) => inRange(Number(f.createdAt || 0), from, to));

  const newCustomers = customers.filter((c) => inRange(Number(c.createdAt || 0), from, to)).length;
  const returning = customers.filter((c) => Number(c.orderCount || c.totalOrders || 0) > 1 && inRange(Number(c.lastOrderAt || c.updatedAt || 0), from, to)).length;

  const ratings = feedback
    .map((f) => (Number(f.foodQuality || 0) + Number(f.serviceQuality || 0) + Number(f.atmosphere || 0)) / 3)
    .filter((r) => r > 0);
  const avgRating = ratings.length ? Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10 : null;

  return { new: newCustomers, returning, avgRating, reviewCount: feedback.length };
}

/**
 * Generates the full report data object consumed by
 * templates.formatPeriodReport(). `from`/`to` are epoch ms, half-open range.
 */
export async function generateReport(restId, from, to) {
  const { sales, kitchen, _ordersInPeriod } = await computeSales(restId, from, to);
  const [warehouse, employees, delivery, customers] = await Promise.all([
    computeWarehouse(restId),
    computeEmployees(restId, _ordersInPeriod),
    computeDelivery(restId, from, to),
    computeCustomers(restId, from, to),
  ]);

  return { sales, kitchen, warehouse, employees, delivery, customers, finance: { worstDishes: [] } };
}

export function dayRange(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.getTime(), to: end.getTime() };
}

export function weekRange(date = new Date()) {
  const { from: todayStart } = dayRange(date);
  const start = new Date(todayStart);
  start.setDate(start.getDate() - 7);
  return { from: start.getTime(), to: todayStart };
}

export function monthRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
  return { from: start, to: end };
}

// ══════════════════════════════════════════════════════════════════════════
// Additive — production notification system (2026 expansion). Everything
// below is NEW computation on top of the SAME Firebase paths already used
// above (orders/warehouse/users/courierAssignments/customers/feedback/
// expenses) — no schema change, no redesign of the functions above.
// ══════════════════════════════════════════════════════════════════════════

/** order.payment.method (kassa.js) is "Naqd"/"Click"/"Payme"/"Uzum Bank"/etc;
 * backend-confirmed payments (payments/common.js markOrderPaid) instead set
 * order.paymentProvider to "click"/"payme"/"uzum". Both are read here so a
 * sale counts correctly regardless of which path completed it. */
function classifyPaymentMethod(o) {
  const raw = String(o.payment?.method || o.paymentProvider || o.deliveryPaymentMethod || "").toLowerCase();
  if (raw.includes("click")) return "click";
  if (raw.includes("payme")) return "payme";
  if (raw.includes("uzum")) return "uzum";
  if (raw.includes("naqd") || raw.includes("cash")) return "cash";
  return "cash"; // POS default when no explicit method is recorded (dine-in cash is the common case)
}

function classifyOrderType(o) {
  if (o.orderType === "delivery" || o.isDelivery === true || o.deliveryType === "delivery" || o.deliveryAddress) return "delivery";
  if (o.orderType === "pickup" || o.isPickup === true || o.deliveryType === "pickup") return "pickup";
  return "dineIn";
}

const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "bekor qilindi", "bekor_qilindi"]);

async function computeSalesDetailed(restId, from, to) {
  const snap = await systemGet(`${basePath(restId)}/orders`);
  const all = Object.entries(snap.val() || {});
  const inPeriod = all.filter(([, o]) => inRange(orderTimestamp(o), from, to));

  const byMethod = { cash: 0, click: 0, payme: 0, uzum: 0 };
  const breakdown = { completed: 0, cancelled: 0, delivery: 0, dineIn: 0, pickup: 0 };
  let revenue = 0;

  inPeriod.forEach(([, o]) => {
    const total = Number(o.total || o.finalTotal || 0);
    const statusKey = String(o.statusKey || o.status || "").toLowerCase();
    const isCancelled = CANCELLED_STATUSES.has(statusKey);

    if (isCancelled) {
      breakdown.cancelled += 1;
      return; // cancelled orders don't count toward revenue or type totals
    }

    revenue += total;
    byMethod[classifyPaymentMethod(o)] += total;
    breakdown[classifyOrderType(o)] += 1;
    if (READY_STATUSES.has(statusKey) || o.status === "paid" || o.statusKey === "completed") breakdown.completed += 1;
  });

  const orders = inPeriod.length;
  const estimatedMarginPct = 35; // see computeSales() above for the same documented estimate
  const profit = revenue * (estimatedMarginPct / 100);

  return {
    sales: { orders, revenue, byMethod, profit, avgCheck: orders ? revenue / orders : 0 },
    ordersBreakdown: breakdown,
    _ordersEntriesInPeriod: inPeriod,
  };
}

function computeKitchenDetailed(ordersEntries) {
  let sum = 0, samples = 0, slowest = null, fastest = null;

  ordersEntries.forEach(([, o]) => {
    const statusKey = String(o.statusKey || o.status || "").toLowerCase();
    if (!READY_STATUSES.has(statusKey)) return;
    const createdAt = Number(o.createdAt || 0);
    const readyAt = Number(o.readyAt || o.updatedAt || 0);
    if (!createdAt || !readyAt || readyAt <= createdAt) return;

    const minutes = Math.round((readyAt - createdAt) / 60000);
    sum += minutes;
    samples += 1;

    const entry = { orderNumber: o.orderNumber || "—", minutes };
    if (!slowest || minutes > slowest.minutes) slowest = entry;
    if (!fastest || minutes < fastest.minutes) fastest = entry;
  });

  return { avgCookMinutes: samples ? Math.round(sum / samples) : 0, slowest, fastest };
}

const FAILED_DELIVERY_STATUSES = new Set(["cancelled", "unable_to_deliver", "customer_not_found", "returned"]);

async function computeDeliveryDetailed(restId, from, to, users) {
  const snap = await systemGet(`${basePath(restId)}/courierAssignments`);
  const all = Object.values(snap.val() || {});
  const inPeriod = all.filter((a) => inRange(Number(a.assignedAt || 0), from, to));

  const successful = inPeriod.filter((a) => DELIVERED_ORDER_STATUSES.has(String(a.status || "").toLowerCase()));
  const failed = inPeriod.filter((a) => FAILED_DELIVERY_STATUSES.has(String(a.subStage || a.status || "").toLowerCase()));

  const minutes = successful
    .map((a) => (a.deliveredAt && a.assignedAt ? (a.deliveredAt - a.assignedAt) / 60000 : null))
    .filter((m) => m != null);
  const avgMinutes = minutes.length ? Math.round(minutes.reduce((s, m) => s + m, 0) / minutes.length) : 0;

  const byCourtier = {};
  inPeriod.forEach((a) => {
    if (!a.courierId) return;
    if (!byCourtier[a.courierId]) byCourtier[a.courierId] = { count: 0, minutesSum: 0, minutesSamples: 0, failed: 0 };
    const bucket = byCourtier[a.courierId];
    bucket.count += 1;
    if (DELIVERED_ORDER_STATUSES.has(String(a.status || "").toLowerCase()) && a.deliveredAt && a.assignedAt) {
      bucket.minutesSum += (a.deliveredAt - a.assignedAt) / 60000;
      bucket.minutesSamples += 1;
    }
    if (FAILED_DELIVERY_STATUSES.has(String(a.subStage || a.status || "").toLowerCase())) bucket.failed += 1;
  });

  const perCourier = Object.entries(byCourtier).map(([courierId, b]) => ({
    name: users?.[courierId]?.name || courierId,
    count: b.count,
    avgMinutes: b.minutesSamples ? Math.round(b.minutesSum / b.minutesSamples) : 0,
    failed: b.failed,
  })).sort((a, b) => b.count - a.count);

  return {
    count: inPeriod.length,
    avgMinutes,
    successful: successful.length,
    failed: failed.length,
    perCourier,
    topCourier: perCourier[0]?.name || null,
  };
}

async function computeEmployeesDetailed(restId, ordersEntries) {
  const snap = await systemGet(`${basePath(restId)}/users`);
  const usersObj = snap.val() || {};
  const users = Object.entries(usersObj);

  const staffStats = {}; // id -> { orders, revenue, completed, cancelled }
  ordersEntries.forEach(([, o]) => {
    const statusKey = String(o.statusKey || o.status || "").toLowerCase();
    const isCancelled = CANCELLED_STATUSES.has(statusKey);
    const total = Number(o.total || o.finalTotal || 0);
    [o.chefId, o.waiterId, o.cashierId].filter(Boolean).forEach((staffId) => {
      if (!staffStats[staffId]) staffStats[staffId] = { orders: 0, revenue: 0, completed: 0, cancelled: 0 };
      staffStats[staffId].orders += 1;
      if (isCancelled) staffStats[staffId].cancelled += 1;
      else { staffStats[staffId].revenue += total; staffStats[staffId].completed += 1; }
    });
  });

  const employees = users
    .filter(([id]) => staffStats[id])
    .map(([id, u]) => {
      const s = staffStats[id];
      return {
        name: u.name || id,
        role: u.role || "—",
        orders: s.orders,
        revenue: s.revenue,
        avgOrder: s.orders ? Math.round(s.revenue / s.orders) : 0,
        completedPct: s.orders ? Math.round((s.completed / s.orders) * 100) : 0,
        cancelledPct: s.orders ? Math.round((s.cancelled / s.orders) * 100) : 0,
        // No attendance/shift-tracking subsystem exists in this codebase yet
        // (confirmed absent in the same audit that flagged this for the
        // Courier module) — left unset rather than fabricated.
        workingHours: null,
      };
    })
    .sort((a, b) => b.orders - a.orders);

  const topChef = employees.filter((e) => e.role === "chef" || e.role === "head_chef").sort((a, b) => b.orders - a.orders)[0]?.name || null;
  const topWaiter = employees.filter((e) => e.role === "waiter").sort((a, b) => b.orders - a.orders)[0]?.name || null;

  return { employees, topChef, topWaiter, usersObj };
}

function computeBestWorstFood(ordersEntries) {
  const counts = {};
  ordersEntries.forEach(([, o]) => {
    const items = Array.isArray(o.items) ? o.items : Object.values(o.items || {});
    items.forEach((it) => {
      const name = typeof it.name === "object" ? (it.name.uz || Object.values(it.name)[0]) : it.name;
      if (!name) return;
      counts[name] = (counts[name] || 0) + Number(it.qty || it.quantity || 1);
    });
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return { bestFood: sorted[0]?.[0] || null, worstFood: sorted[sorted.length - 1]?.[0] || null, sorted };
}

async function computeExpenses(restId, from, to) {
  const snap = await systemGet(`${basePath(restId)}/expenses`);
  const all = Object.values(snap.val() || {});
  return all
    .filter((e) => inRange(Number(e.date || e.createdAt || 0), from, to))
    .reduce((sum, e) => sum + Number(e.amount || 0), 0);
}

/** Full Daily Report data — spec section 1. */
export async function generateDailyReportData(restId, from, to) {
  const { sales, ordersBreakdown, _ordersEntriesInPeriod } = await computeSalesDetailed(restId, from, to);
  const kitchen = computeKitchenDetailed(_ordersEntriesInPeriod);
  const [warehouse, employeesResult, bestWorst] = await Promise.all([
    computeWarehouse(restId),
    computeEmployeesDetailed(restId, _ordersEntriesInPeriod),
    Promise.resolve(computeBestWorstFood(_ordersEntriesInPeriod)),
  ]);
  const delivery = await computeDeliveryDetailed(restId, from, to, employeesResult.usersObj);

  return {
    sales,
    ordersBreakdown,
    kitchen,
    warehouse: { low: warehouse.low, outOfStock: warehouse.outOfStock },
    delivery,
    employees: employeesResult.employees,
    topWaiter: employeesResult.topWaiter,
    topChef: employeesResult.topChef,
    topCourier: delivery.topCourier,
    bestFood: bestWorst.bestFood,
    worstFood: bestWorst.worstFood,
  };
}

/** Full Weekly Report data — spec section 2. */
export async function generateWeeklyReportData(restId, from, to) {
  const { sales, _ordersEntriesInPeriod } = await computeSalesDetailed(restId, from, to);
  const [warehouse, expenses, bestWorst] = await Promise.all([
    computeWarehouse(restId),
    computeExpenses(restId, from, to),
    Promise.resolve(computeBestWorstFood(_ordersEntriesInPeriod)),
  ]);
  const employeesResult = await computeEmployeesDetailed(restId, _ordersEntriesInPeriod);

  // Text revenue chart: one bar per day across the range.
  const revenueChart = [];
  const dayMs = 24 * 60 * 60 * 1000;
  for (let t = from; t < to; t += dayMs) {
    const dayEntries = _ordersEntriesInPeriod.filter(([, o]) => inRange(orderTimestamp(o), t, t + dayMs));
    const dayRevenue = dayEntries.reduce((sum, [, o]) => sum + (CANCELLED_STATUSES.has(String(o.statusKey || o.status || "").toLowerCase()) ? 0 : Number(o.total || o.finalTotal || 0)), 0);
    revenueChart.push({ label: new Date(t).toLocaleDateString("en-US", { weekday: "short" }), value: dayRevenue });
  }

  return {
    revenue: sales.revenue,
    expenses,
    profit: sales.revenue - expenses,
    revenueChart,
    topProducts: bestWorst.sorted.slice(0, 5).map(([name, count]) => ({ name, count })),
    topEmployees: employeesResult.employees.slice(0, 5),
    warehouse: { healthPct: warehouse.healthPct, low: warehouse.low, critical: warehouse.critical, outOfStock: warehouse.outOfStock },
  };
}

/** Full Monthly Report data — spec section 3. */
export async function generateMonthlyReportData(restId, from, to, prevFrom, prevTo) {
  const { sales, _ordersEntriesInPeriod } = await computeSalesDetailed(restId, from, to);
  const [expenses, prevSalesResult, bestWorst] = await Promise.all([
    computeExpenses(restId, from, to),
    computeSalesDetailed(restId, prevFrom, prevTo),
    Promise.resolve(computeBestWorstFood(_ordersEntriesInPeriod)),
  ]);
  const employeesResult = await computeEmployeesDetailed(restId, _ordersEntriesInPeriod);

  const custSnap = await systemGet(`${basePath(restId)}/customers`);
  const customers = Object.values(custSnap.val() || {});
  const topCustomers = customers
    .filter((c) => Number(c.totalSpent || 0) > 0)
    .sort((a, b) => Number(b.totalSpent || 0) - Number(a.totalSpent || 0))
    .slice(0, 5)
    .map((c) => ({ name: c.name || "—", orders: Number(c.orderCount || c.totalOrders || c.visits || 0), spent: Number(c.totalSpent || 0) }));

  return {
    revenue: sales.revenue,
    profit: sales.revenue - expenses,
    expenses,
    prevRevenue: prevSalesResult.sales.revenue,
    topCustomers,
    topFoods: bestWorst.sorted.slice(0, 5).map(([name, count]) => ({ name, count })),
    employeeKPI: employeesResult.employees.slice(0, 8),
  };
}

/** Previous-period range for growth% comparison — same length immediately before `from`. */
export function previousPeriodRange(from, to) {
  const span = to - from;
  return { from: from - span, to: from };
}

// ══════════════════════════════════════════════════════════════════════════
// Additive — Telegram Control Panel dashboard buttons (2026 expansion).
// Thin, on-demand wrappers around the SAME private compute*() functions
// already used by generateDailyReportData() above — every call here does a
// fresh Firebase get() (via the underlying compute functions, which never
// cache), so a dashboard button always reflects live data, never a stale
// snapshot. No new computation logic, no duplicated business rules.
// ══════════════════════════════════════════════════════════════════════════

export async function getWarehouseStatus(restId) {
  return computeWarehouse(restId);
}

export async function getFinanceStatusToday(restId) {
  const { from, to } = dayRange();
  const { sales } = await computeSalesDetailed(restId, from, to);
  return sales;
}

export async function getOrdersStatusToday(restId) {
  const { from, to } = dayRange();
  const { ordersBreakdown, sales } = await computeSalesDetailed(restId, from, to);
  return { ...ordersBreakdown, totalOrders: sales.orders };
}

export async function getKitchenStatusToday(restId) {
  const { from, to } = dayRange();
  const { _ordersEntriesInPeriod } = await computeSalesDetailed(restId, from, to);
  return computeKitchenDetailed(_ordersEntriesInPeriod);
}

export async function getDeliveryStatusToday(restId) {
  const { from, to } = dayRange();
  const { employees, usersObj } = await computeEmployeesDetailed(restId, (await computeSalesDetailed(restId, from, to))._ordersEntriesInPeriod);
  void employees; // not needed here, computeEmployeesDetailed just also gives us the users map cheaply
  return computeDeliveryDetailed(restId, from, to, usersObj);
}

export async function getEmployeesStatusToday(restId) {
  const { from, to } = dayRange();
  const { _ordersEntriesInPeriod } = await computeSalesDetailed(restId, from, to);
  const { employees, topChef, topWaiter } = await computeEmployeesDetailed(restId, _ordersEntriesInPeriod);
  return { employees, topChef, topWaiter };
}

export async function getBestWorstFoodToday(restId) {
  const { from, to } = dayRange();
  const { _ordersEntriesInPeriod } = await computeSalesDetailed(restId, from, to);
  return computeBestWorstFood(_ordersEntriesInPeriod);
}

// ══════════════════════════════════════════════════════════════════════════
// Additive — Admin Telegram Bot dashboard expansion (Restoran jarayoni /
// Stollar / Buyurtmalar / Bronlar / Mijozlar / Xodimlar drill-down, 2026).
// Every function below reads the SAME canonical Firebase paths the Admin
// Panel itself reads (restaurants/{id}/tables, /orders, /reservations,
// /customers, /users) — no new data model, no duplicated business rules.
//
// admin-frontend/public/js/shared.js is the ONE canonical source for the
// TABLE_STATUS_V2 / ORDER_STATUS_V2 vocabularies, but it is a browser ES
// module (imports firebase-database.js straight from a CDN URL) and cannot
// be imported into this Node backend. Its status keys/legacy-alias tables
// are mirrored below byte-for-byte (see the comment on each map) rather
// than reinvented with different names, so a table/order bucketed here as
// "occupied"/"preparing"/etc. always agrees with what the Admin Panel itself
// would show for the same record.
// ══════════════════════════════════════════════════════════════════════════

// Mirrors shared.js's LEGACY_TABLE_STATUS_TO_V2 + TABLE_STATUS_V2, folded
// into the 3 buckets the bot dashboard's simplified table view needs.
// Unknown/unrecognized statuses fall back to "occupied" — same fallback
// shared.js's own normalizeTableStatusV2() uses (never assume unknown means
// free).
const TABLE_BUCKET_MAP = {
  free: "free", open: "free", "bo'sh": "free",
  reserved: "reserved", // admin.js's updateReservationStatus() writes this literal status when a reservation is confirmed
  busy: "occupied", occupied: "occupied", band: "occupied",
  order_received: "occupied",
  preparing: "occupied", cooking: "occupied", tayyorlanmoqda: "occupied",
  ready: "occupied", tayyor: "occupied",
  eating: "occupied", served: "occupied", yetkazildi: "occupied",
  cleaning: "occupied", needs_cleaning: "occupied", tozalanmoqda: "occupied",
  billing: "paying", hisob: "paying",
  paid: "paying", "to'landi": "paying",
};
function tableBucket(rawStatus) {
  const s = String(rawStatus || "").trim().toLowerCase();
  if (!s) return "free";
  return TABLE_BUCKET_MAP[s] || "occupied";
}

// Mirrors shared.js's LEGACY_STATUS_TO_V2 + ORDER_STATUS_V2, folded into the
// 5 buckets the spec's "🧾 Buyurtmalar" drill-down asks for (Yangi / Oshxonada
// / Tayyor / To'lov / Yakunlangan) plus "cancelled" kept separate so it never
// silently inflates any of the 5 active buckets.
const ORDER_BUCKET_MAP = {
  pending: "new", new: "new", queue: "new", yangi: "new", kutilmoqda: "new",
  order_created: "new", waiter: "new", kitchen_printer: "new", kitchen_display: "new",
  approved: "kitchen", cooking: "kitchen", tayyorlanmoqda: "kitchen", tasdiqlandi: "kitchen", preparing: "kitchen",
  ready: "ready", tayyor: "ready", picked_up: "ready", yetkazilmoqda: "ready", delivering: "ready",
  served: "payment", eating: "payment", yetkazildi: "payment", delivered: "payment", cashier: "payment", payment: "payment",
  closed: "completed", paid: "completed", "to'landi": "completed", tolandi: "completed", yopildi: "completed", completed: "completed",
  canceled: "cancelled", cancelled: "cancelled", "bekor qilindi": "cancelled",
};
function orderBucket(o) {
  const s = String(o.statusKey || o.status || "").trim().toLowerCase();
  if (CANCELLED_STATUSES.has(s)) return "cancelled";
  return ORDER_BUCKET_MAP[s] || "new";
}

function orderItemsSummary(o) {
  const items = Array.isArray(o.items) ? o.items : Object.values(o.items || {});
  return items.map((it) => ({
    name: typeof it.name === "object" ? (it.name.uz || Object.values(it.name)[0]) : (it.name || "—"),
    qty: Number(it.qty || it.quantity || 1),
    price: Number(it.price || it.total || 0),
  }));
}

// ── Tables ───────────────────────────────────────────────────────────────
async function computeTablesDetailed(restId) {
  const [tablesSnap, ordersSnap, resvSnap] = await Promise.all([
    systemGet(`${basePath(restId)}/tables`),
    systemGet(`${basePath(restId)}/orders`),
    systemGet(`${basePath(restId)}/reservations`),
  ]);
  const tablesEntries = Object.entries(tablesSnap.val() || {});
  const orders = Object.entries(ordersSnap.val() || {});
  const reservations = Object.entries(resvSnap.val() || {});

  // "Bron" (reserved) is not a persisted table.status in this codebase (only
  // client.js computes it transiently, per-visit) — derived here the same
  // way: a currently-FREE table with an active (not cancelled/seated) today
  // reservation for that exact table number. Never applied to an
  // already-occupied/paying table (real presence always wins over a booking).
  const todayStr = new Date().toISOString().slice(0, 10);
  const reservedTableNumbers = new Set(
    reservations
      .filter(([, r]) => r.date === todayStr && !["cancelled", "canceled", "seated", "completed"].includes(String(r.status || "").toLowerCase()))
      .map(([, r]) => String(r.tableNumber ?? r.table ?? ""))
      .filter(Boolean)
  );

  const tables = tablesEntries.map(([key, tbl]) => {
    const number = tbl.number ?? key;
    const bucket = tableBucket(tbl.status);
    const isReserved = bucket === "free" && reservedTableNumbers.has(String(number));
    const order = tbl.orderId
      ? orders.find(([oid]) => oid === tbl.orderId)
      : orders.find(([, o]) => String(o.table) === String(number) && orderBucket(o) !== "completed" && orderBucket(o) !== "cancelled");
    return {
      id: key,
      number,
      tableType: tbl.tableType || "oddiy",
      bucket: isReserved ? "reserved" : bucket,
      statusRaw: tbl.status || "free",
      orderId: order ? order[0] : null,
    };
  });

  const counts = { free: 0, occupied: 0, reserved: 0, paying: 0 };
  tables.forEach((t) => { counts[t.bucket] = (counts[t.bucket] || 0) + 1; });

  return { counts, tables };
}

export async function getTablesStatusToday(restId) {
  const { counts } = await computeTablesDetailed(restId);
  return counts;
}

export async function getTablesByBucket(restId, bucket) {
  const { tables } = await computeTablesDetailed(restId);
  return tables.filter((t) => t.bucket === bucket).sort((a, b) => Number(a.number) - Number(b.number));
}

export async function getTableDetail(restId, tableId) {
  const { tables } = await computeTablesDetailed(restId);
  const table = tables.find((t) => t.id === tableId || String(t.number) === String(tableId));
  if (!table) return null;

  let order = null;
  if (table.orderId) {
    const orderSnap = await systemGet(`${basePath(restId)}/orders/${table.orderId}`);
    const o = orderSnap.val();
    if (o) {
      const usersSnap = await systemGet(`${basePath(restId)}/users`);
      const users = usersSnap.val() || {};
      order = {
        id: table.orderId,
        orderNumber: o.orderNumber || table.orderId,
        total: Number(o.total || o.finalTotal || 0),
        createdAt: o.createdAt || null,
        waiterName: (o.waiterId && users[o.waiterId]?.name) || o.waiterName || null,
        items: orderItemsSummary(o),
      };
    }
  }

  return { ...table, order };
}

// ── Orders (status drill-down + detail + actions) ───────────────────────
export async function getOrdersBucketsToday(restId) {
  const { from, to } = dayRange();
  const snap = await systemGet(`${basePath(restId)}/orders`);
  const entries = Object.entries(snap.val() || {}).filter(([, o]) => inRange(orderTimestamp(o), from, to));
  const counts = { new: 0, kitchen: 0, ready: 0, payment: 0, completed: 0, cancelled: 0 };
  entries.forEach(([, o]) => { const b = orderBucket(o); counts[b] = (counts[b] || 0) + 1; });
  return counts;
}

export async function getOrdersByBucketToday(restId, bucket) {
  const { from, to } = dayRange();
  const snap = await systemGet(`${basePath(restId)}/orders`);
  const entries = Object.entries(snap.val() || {}).filter(([, o]) => inRange(orderTimestamp(o), from, to));
  return entries
    .filter(([, o]) => orderBucket(o) === bucket)
    .map(([id, o]) => ({
      id,
      orderNumber: o.orderNumber || id,
      table: o.table ?? null,
      total: Number(o.total || o.finalTotal || 0),
      createdAt: orderTimestamp(o),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getOrderDetail(restId, orderId) {
  const [orderSnap, usersSnap] = await Promise.all([
    systemGet(`${basePath(restId)}/orders/${orderId}`),
    systemGet(`${basePath(restId)}/users`),
  ]);
  const o = orderSnap.val();
  if (!o) return null;
  const users = usersSnap.val() || {};

  const items = orderItemsSummary(o);
  const itemsTotal = items.reduce((s, it) => s + it.qty * it.price, 0);
  const total = Number(o.total || o.finalTotal || 0);
  const discount = o.discount ? Number(o.discount) : (itemsTotal > total ? itemsTotal - total : 0);

  return {
    id: orderId,
    orderNumber: o.orderNumber || orderId,
    table: o.table ?? null,
    customerName: o.customerName || o.clientName || null,
    customerPhone: o.customerPhone || o.clientPhone || o.phone || null,
    items,
    itemsTotal,
    discount,
    total,
    paymentMethod: o.payment?.method || o.paymentProvider || null,
    paid: o.payment?.paid === true,
    bucket: orderBucket(o),
    statusRaw: o.statusKey || o.status || null,
    chefName: (o.chefId && users[o.chefId]?.name) || null,
    waiterName: (o.waiterId && users[o.waiterId]?.name) || null,
  };
}

// ── Reservations ─────────────────────────────────────────────────────────
const RESV_ACTIVE_STATUSES = new Set(["pending", "confirmed"]);
function reservationBucket(r) {
  const s = String(r.status || "pending").toLowerCase();
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "seated" || s === "completed") return "seated";
  if (s === "confirmed") return "confirmed";
  return "pending";
}

export async function getReservationsStatusToday(restId) {
  const snap = await systemGet(`${basePath(restId)}/reservations`);
  const entries = Object.entries(snap.val() || {});
  const todayStr = new Date().toISOString().slice(0, 10);
  const counts = { pending: 0, confirmed: 0, seated: 0, cancelled: 0 };
  entries.forEach(([, r]) => {
    if (r.date !== todayStr) return;
    const b = reservationBucket(r);
    counts[b] = (counts[b] || 0) + 1;
  });
  return counts;
}

export async function getReservationsList(restId, when) {
  const snap = await systemGet(`${basePath(restId)}/reservations`);
  const entries = Object.entries(snap.val() || {});
  const todayStr = new Date().toISOString().slice(0, 10);
  return entries
    .filter(([, r]) => {
      const bucket = reservationBucket(r);
      if (bucket === "cancelled") return false;
      return when === "today" ? r.date === todayStr : r.date > todayStr;
    })
    .map(([id, r]) => ({
      id,
      guestName: r.guestName || "—",
      guests: Number(r.guests || r.guestCount || 0),
      date: r.date,
      time: r.time,
      tableNumber: r.tableNumber ?? r.table ?? null,
      bucket: reservationBucket(r),
    }))
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
}

export async function getReservationDetail(restId, reservationId) {
  const snap = await systemGet(`${basePath(restId)}/reservations/${reservationId}`);
  const r = snap.val();
  if (!r) return null;
  return {
    id: reservationId,
    guestName: r.guestName || "—",
    guestPhone: r.guestPhone || r.phone || null,
    guests: Number(r.guests || r.guestCount || 0),
    date: r.date,
    time: r.time,
    tableNumber: r.tableNumber ?? r.table ?? null,
    bucket: reservationBucket(r),
  };
}

// ── Customers ────────────────────────────────────────────────────────────
export async function getCustomersStatusToday(restId) {
  const { from, to } = dayRange();
  const snap = await systemGet(`${basePath(restId)}/customers`);
  const customers = Object.values(snap.val() || {});
  const today = customers.filter((c) => inRange(Number(c.lastOrderAt || c.updatedAt || 0), from, to)).length;
  const newToday = customers.filter((c) => inRange(Number(c.createdAt || 0), from, to)).length;
  const returning = customers.filter((c) => Number(c.orderCount || c.totalOrders || c.visits || 0) > 1).length;
  const discounted = customers.filter((c) => Number(c.discount || c.discountPct || 0) > 0).length;
  return { today, new: newToday, returning, discounted };
}

export async function getCustomersList(restId, bucket) {
  const { from, to } = dayRange();
  const snap = await systemGet(`${basePath(restId)}/customers`);
  const entries = Object.entries(snap.val() || {});
  const filtered = entries.filter(([, c]) => {
    if (bucket === "new") return inRange(Number(c.createdAt || 0), from, to);
    if (bucket === "active") return Number(c.orderCount || c.totalOrders || c.visits || 0) > 1;
    if (bucket === "discounted") return Number(c.discount || c.discountPct || 0) > 0;
    return true;
  });
  return filtered
    .map(([id, c]) => ({
      id,
      name: c.name || "—",
      phone: c.phone || null,
      orderCount: Number(c.orderCount || c.totalOrders || c.visits || 0),
      totalSpent: Number(c.totalSpent || 0),
    }))
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, 50); // pagination-friendly cap — see spec section 27, never a full-table download
}

export async function getCustomerDetail(restId, customerId) {
  const snap = await systemGet(`${basePath(restId)}/customers/${customerId}`);
  const c = snap.val();
  if (!c) return null;
  return {
    id: customerId,
    name: c.name || "—",
    phone: c.phone || null,
    orderCount: Number(c.orderCount || c.totalOrders || c.visits || 0),
    totalSpent: Number(c.totalSpent || 0),
    visits: Number(c.visits || c.orderCount || 0),
    discount: c.discount ?? c.discountPct ?? null,
    lastOrderAt: c.lastOrderAt || c.updatedAt || null,
  };
}

// ── Employees (real fields only — NO shift/attendance subsystem exists in
// this codebase; see the "workingHours: null" comment on
// computeEmployeesDetailed() above, the same confirmed gap). This view
// deliberately shows only what the users/{id} record + today's order
// activity can honestly support: role, account active/blocked, and the
// timestamp of their most recent order today as "last known activity" — it
// NEVER claims "working now" as a fact. If a real attendance/shift module is
// added later, only computeEmployeeWorkingNow() below needs to change; every
// caller already reads through it. ─────────────────────────────────────────
function computeEmployeeWorkingNow(_user, _lastActivityAt) {
  // NOT VERIFIED / shift source not available — see reportGenerator.js
  // header comment. Intentionally always null; this is the single
  // attachment point a future attendance/shift module would replace.
  return null;
}

export async function getEmployeesList(restId, roleFilter) {
  const { from, to } = dayRange();
  const [usersSnap, ordersSnap] = await Promise.all([
    systemGet(`${basePath(restId)}/users`),
    systemGet(`${basePath(restId)}/orders`),
  ]);
  const users = Object.entries(usersSnap.val() || {});
  const ordersToday = Object.values(ordersSnap.val() || {}).filter((o) => inRange(orderTimestamp(o), from, to));

  const lastActivityByUser = {};
  ordersToday.forEach((o) => {
    [o.chefId, o.waiterId, o.cashierId].filter(Boolean).forEach((uid) => {
      const ts = orderTimestamp(o);
      if (!lastActivityByUser[uid] || ts > lastActivityByUser[uid]) lastActivityByUser[uid] = ts;
    });
  });

  return users
    .filter(([, u]) => !roleFilter || u.role === roleFilter)
    .map(([id, u]) => ({
      id,
      name: u.name || id,
      role: u.role || "—",
      active: u.active !== false,
      lastActivityAt: lastActivityByUser[id] || null,
      workingNow: computeEmployeeWorkingNow(u, lastActivityByUser[id] || null),
    }))
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
}

export async function getEmployeesSummaryToday(restId) {
  const list = await getEmployeesList(restId, null);
  return {
    total: list.length,
    active: list.filter((e) => e.active).length,
    blocked: list.filter((e) => !e.active).length,
  };
}

export async function getEmployeeDetail(restId, userId) {
  const { from, to } = dayRange();
  const [userSnap, ordersSnap] = await Promise.all([
    systemGet(`${basePath(restId)}/users/${userId}`),
    systemGet(`${basePath(restId)}/orders`),
  ]);
  const u = userSnap.val();
  if (!u) return null;
  const ordersToday = Object.values(ordersSnap.val() || {}).filter((o) => inRange(orderTimestamp(o), from, to));
  let orderCount = 0, lastActivityAt = null;
  ordersToday.forEach((o) => {
    if (o.chefId === userId || o.waiterId === userId || o.cashierId === userId) {
      orderCount += 1;
      const ts = orderTimestamp(o);
      if (!lastActivityAt || ts > lastActivityAt) lastActivityAt = ts;
    }
  });
  return {
    id: userId,
    name: u.name || userId,
    role: u.role || "—",
    active: u.active !== false,
    ordersToday: orderCount,
    lastActivityAt,
    workingNow: computeEmployeeWorkingNow(u, lastActivityAt),
  };
}

// ── Combined "Restoran jarayoni" view (spec Part A section 2) — reuses
// every canonical compute*() above; no separately-hardcoded numbers. ─────
export async function getRestaurantProcessToday(restId) {
  const [tables, orders, kitchen, delivery, reservations] = await Promise.all([
    getTablesStatusToday(restId),
    getOrdersBucketsToday(restId),
    getKitchenStatusToday(restId),
    getDeliveryStatusToday(restId),
    getReservationsStatusToday(restId),
  ]);
  return { tables, orders, kitchen, delivery, reservations };
}

/** Employee schedule-report data (spec Part B section 21). */
export async function generateEmployeeReportData(restId) {
  const [summary, employees] = await Promise.all([
    getEmployeesSummaryToday(restId),
    getEmployeesList(restId, null),
  ]);
  return { summary, employees: employees.slice(0, 20) };
}

/** Process schedule-report data (spec Part B section 22) — same numbers as
 * getRestaurantProcessToday(), reused rather than recomputed differently. */
export async function generateProcessReportData(restId) {
  return getRestaurantProcessToday(restId);
}
