// notifications/templates.js — every human-readable notification string,
// in all 3 languages, in ONE place. Text is sourced EXCLUSIVELY from
// notifications/locales/ (getTranslator()) — this file used to read
// admin-frontend/public/js/langs.js directly, but the Telegram Control
// Panel's localization was moved to its own dedicated locale files so the
// backend's Telegram text has one single, self-contained source of truth,
// independent of the (much larger, frontend-scoped) Admin Panel dictionary.
//
// Text here is plain, newline-formatted — works as-is for Telegram. A
// future Email/SMS provider can reformat (e.g. HTML) without touching this
// file's data, just how it's consumed.
import { NOTIFICATION_TYPES } from "./types.js";
import { getTranslator, SUPPORTED_LANGUAGES } from "./locales/index.js";

// Every call site was historically `tt(lang, key, fallback)` — getTranslator()
// already guarantees a non-empty result (falls back to the "uz" dictionary,
// then to the raw key), so `fallback` is accepted for call-site compatibility
// but never actually used now that every key exists in all 3 locale files.
function tt(lang, key, _fallback) {
  return getTranslator(lang)(key);
}

function fmtNum(n) {
  return Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtDate(ts, lang) {
  const d = new Date(ts || Date.now());
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return lang === "en" ? `${mm}/${dd}/${yyyy}` : `${dd}.${mm}.${yyyy}`;
}

const SEP = "━━━━━━━━━━━━━━━━━━";

// ── Instant alert templates (section 6/7/8/9 of the spec) ──────────────────
// Each returns plain text — sent via TelegramProvider.js with `parse_mode:
// "HTML"` (same as the dashboard bot templates further below), so any field
// here that carries user-entered text (a customer's review comment, a
// cancellation reason, a staff/customer name, a free-text system error
// message) is escaped with escHtml() before interpolation. Without this, a
// customer review like `<a href="https://evil.example">5 stars</a>` would
// render as a real, differently-labeled link inside the restaurant owner's
// Telegram — this is the exact protection formatDashboardWelcome() etc.
// already had; instant alerts were missing it. `payload` shape is
// documented per type.
const INSTANT_TEMPLATES = {
  [NOTIFICATION_TYPES.LARGE_ORDER]: (lang, p) =>
    `🛎 ${tt(lang, "notif_large_order_title")}\n#${escHtml(p.orderNumber || p.orderId)} — ${fmtNum(p.total)} ${tt(lang, "currency")}`,

  [NOTIFICATION_TYPES.FAILED_PAYMENT]: (lang, p) =>
    `❌ ${tt(lang, "notif_failed_payment_title")}\n#${escHtml(p.orderNumber || p.orderId)} — ${fmtNum(p.amount)} ${tt(lang, "currency")}${p.reason ? `\n${tt(lang, "notif_reason_label")}: ${escHtml(p.reason)}` : ""}`,

  [NOTIFICATION_TYPES.REFUND_ALERT]: (lang, p) =>
    `↩️ ${tt(lang, "notif_refund_title")}\n#${escHtml(p.orderNumber || p.orderId)} — ${fmtNum(p.amount)} ${tt(lang, "currency")}`,

  [NOTIFICATION_TYPES.EMPLOYEE_ATTENDANCE]: (lang, p) =>
    `👤 ${tt(lang, "notif_attendance_title")}\n${escHtml(p.staffName)}`,

  [NOTIFICATION_TYPES.LATE_EMPLOYEE]: (lang, p) =>
    `⏰ ${tt(lang, "notif_late_employee_title")}\n${escHtml(p.staffName)}${p.minutesLate ? ` — ${p.minutesLate} ${tt(lang, "minutes_short")}` : ""}`,

  [NOTIFICATION_TYPES.NEW_EMPLOYEE]: (lang, p) =>
    `🆕 ${tt(lang, "notif_new_employee_title")}\n${escHtml(p.staffName)}${p.role ? ` (${escHtml(p.role)})` : ""}`,

  [NOTIFICATION_TYPES.RESERVATION_ALERT]: (lang, p) =>
    `📅 ${tt(lang, "notif_reservation_title")}\n${escHtml(p.customerName)} — ${escHtml(p.dateTime)}${p.guests ? ` — ${p.guests} ${tt(lang, "notif_guests_label")}` : ""}`,

  // Client ilovasidan mijozning o'zi bronni bekor qilganda (admin bekor
  // qilganda emas — bu holat scanCancelledReservations() ichida cancelledBy
  // === "client" bilan cheklanadi).
  [NOTIFICATION_TYPES.RESERVATION_CANCELLED]: (lang, p) =>
    `❌ ${tt(lang, "notif_reservation_cancelled_title")}\n${escHtml(p.customerName)} — ${escHtml(p.dateTime)}`,

  [NOTIFICATION_TYPES.CUSTOMER_REVIEW]: (lang, p) =>
    `⭐️ ${tt(lang, "notif_review_title")}\n${p.rating != null ? `${p.rating}★` : ""}${p.comment ? `\n"${escHtml(p.comment)}"` : ""}`,

  [NOTIFICATION_TYPES.DELIVERY_PROBLEM]: (lang, p) =>
    `🛵⚠️ ${tt(lang, "notif_delivery_problem_title")}\n#${escHtml(p.orderNumber || p.orderId)}${p.reason ? `\n${escHtml(p.reason)}` : ""}`,

  [NOTIFICATION_TYPES.SYSTEM_ERROR]: (lang, p) =>
    `🚨 ${tt(lang, "notif_system_error_title")}\n${escHtml(p.message)}`,

  [NOTIFICATION_TYPES.SUBSCRIPTION_EXPIRATION]: (lang, p) =>
    `⏳ ${tt(lang, "notif_subscription_title")}\n${p.expiresAt ? fmtDate(p.expiresAt, lang) : ""}${p.daysLeft != null ? ` — ${p.daysLeft} ${tt(lang, "notif_days_left_label")}` : ""}`,

  [NOTIFICATION_TYPES.BACKUP_COMPLETED]: (lang, p) =>
    p.ok
      ? `💾 ${tt(lang, "notif_backup_ok_title")}`
      : `💾❌ ${tt(lang, "notif_backup_failed_title")}${p.reason ? `\n${p.reason}` : ""}`,

  [NOTIFICATION_TYPES.RESTAURANT_OFFLINE]: (lang, _p) =>
    `🔌 ${tt(lang, "notif_restaurant_offline_title")}`,

  // Delivery lifecycle (migrated from the old telegram/bot.js TEMPLATES)
  [NOTIFICATION_TYPES.NEW_DELIVERY]: (lang, p) =>
    `🆕 ${tt(lang, "delivery_status_waiting")}\n#${escHtml(p.orderNumber || p.orderId)}`,
  [NOTIFICATION_TYPES.COURIER_ASSIGNED]: (lang, p) =>
    `🛵 ${tt(lang, "delivery_status_assigned")}\n#${escHtml(p.orderNumber || p.orderId)}${p.courierName ? `\n${tt(lang, "courier_meta_courier")}: ${escHtml(p.courierName)}` : ""}`,
  [NOTIFICATION_TYPES.COURIER_ARRIVED]: (lang, p) =>
    `📍 ${tt(lang, "delivery_status_arrived")}\n#${escHtml(p.orderNumber || p.orderId)}${p.courierName ? `\n${tt(lang, "courier_meta_courier")}: ${escHtml(p.courierName)}` : ""}`,
  [NOTIFICATION_TYPES.PICKED_UP]: (lang, p) =>
    `📦 ${tt(lang, "delivery_status_picked_up")}\n#${escHtml(p.orderNumber || p.orderId)}`,
  [NOTIFICATION_TYPES.DELIVERED]: (lang, p) =>
    `✅ ${tt(lang, "delivery_status_delivered")}\n#${escHtml(p.orderNumber || p.orderId)}`,
  [NOTIFICATION_TYPES.DELIVERY_CANCELLED]: (lang, p) =>
    `❌ ${tt(lang, "delivery_status_cancelled")}\n#${escHtml(p.orderNumber || p.orderId)}`,

  // ── Additive — production notification system (2026 expansion) ──────────
  [NOTIFICATION_TYPES.NEW_ORDER]: (lang, p) =>
    `🆕 ${tt(lang, "notif_new_order_title")}\n#${escHtml(p.orderNumber || p.orderId)} — ${fmtNum(p.total)} ${tt(lang, "currency")}`,

  [NOTIFICATION_TYPES.ORDER_CANCELLED]: (lang, p) =>
    `❌ ${tt(lang, "notif_order_cancelled_title")}\n#${escHtml(p.orderNumber || p.orderId)}${p.reason ? `\n${tt(lang, "notif_reason_label")}: ${escHtml(p.reason)}` : ""}`,

  [NOTIFICATION_TYPES.PAYMENT_RECEIVED]: (lang, p) =>
    `💳 ${tt(lang, "notif_payment_received_title")}\n#${escHtml(p.orderNumber || p.orderId)} — ${fmtNum(p.amount)} ${tt(lang, "currency")}${p.method ? ` (${escHtml(p.method)})` : ""}`,

  [NOTIFICATION_TYPES.FOOD_SOLD_OUT]: (lang, p) =>
    `❌ ${tt(lang, "notif_sold_out_title")}\n${escHtml(p.foodName)}`,

  [NOTIFICATION_TYPES.EMPLOYEE_LOGIN]: (lang, p) =>
    `🔓 ${tt(lang, "notif_employee_login_title")}\n${escHtml(p.staffName)}${p.role ? ` (${escHtml(p.role)})` : ""}`,

  [NOTIFICATION_TYPES.EMPLOYEE_LOGOUT]: (lang, p) =>
    `🔒 ${tt(lang, "notif_employee_logout_title")}\n${escHtml(p.staffName)}`,

  [NOTIFICATION_TYPES.DATABASE_OFFLINE]: (lang, p) =>
    p.recovered
      ? `🟢 ${tt(lang, "notif_database_online_title")}${p.offlineForSec ? ` (${p.offlineForSec}s)` : ""}`
      : `🔴 ${tt(lang, "notif_database_offline_title")}`,

  [NOTIFICATION_TYPES.PRINTER_OFFLINE]: (lang, p) =>
    `🖨️❌ ${tt(lang, "notif_printer_offline_title")}${p.printerName ? `\n${escHtml(p.printerName)}` : ""}`,

  [NOTIFICATION_TYPES.KITCHEN_DELAY]: (lang, p) =>
    `⏰🍳 ${tt(lang, "notif_kitchen_delay_title")}\n#${escHtml(p.orderNumber || p.orderId)} — ${p.minutes} ${tt(lang, "minutes_short")}`,

  [NOTIFICATION_TYPES.HIGH_REVENUE_MILESTONE]: (lang, p) =>
    `🎉 ${tt(lang, "notif_revenue_milestone_title")}\n${fmtNum(p.milestone)} ${tt(lang, "currency")} ${tt(lang, "notif_revenue_milestone_reached")}`,
};

/** Renders a single-line/short instant-alert message for the given type+payload. */
export function renderInstantMessage(type, lang, payload = {}) {
  const fn = INSTANT_TEMPLATES[type];
  if (!fn) return `🔔 ${type}`;
  return fn(SUPPORTED_LANGUAGES.includes(lang) ? lang : "uz", payload);
}

// ── Warehouse per-ingredient alert (spec section 7) ─────────────────────────
// (all Telegram sends go through TelegramProvider.js with parse_mode:"HTML"
// — see the escHtml() rationale comment on INSTANT_TEMPLATES above; applies
// equally here since item.name/supplierName come from Warehouse records any
// staff with warehouse:edit can set.)
export function renderWarehouseAlert(lang, item) {
  const icon = item.priority === "critical" ? "🔴" : item.priority === "high" ? "🟠" : "🟡";
  const lines = [
    `${icon} ${escHtml(item.name)}`,
    "",
    `${tt(lang, "notif_wh_only_left")} ${fmtNum(item.stock)} ${escHtml(item.unit)} ${tt(lang, "notif_wh_left")}.`,
  ];
  if (item.daysRemaining != null) {
    lines.push("", tt(lang, "notif_wh_estimated"), `${item.daysRemaining.toFixed(1)} ${tt(lang, "notif_wh_days_remaining")}.`);
  }
  if (item.toBuy > 0) {
    lines.push("", tt(lang, "notif_wh_recommended_purchase"), `${fmtNum(item.toBuy)} ${escHtml(item.unit)}`);
  }
  if (item.supplierName) {
    lines.push("", tt(lang, "notif_wh_supplier"), escHtml(item.supplierName));
  }
  return lines.join("\n");
}

// ── Production alert (spec section 8) ───────────────────────────────────────
export function renderProductionAlert(lang, data) {
  const lines = [
    `🏭 ${tt(lang, "notif_production_title")}`,
    `${data.completionPct}%`,
  ];
  if (data.affectedDishes?.length) {
    lines.push("", tt(lang, "notif_production_shortage"), "", tt(lang, "notif_production_affected"));
    data.affectedDishes.forEach((d) => lines.push(`• ${escHtml(d)}`));
  }
  if (data.shoppingListReady) {
    lines.push("", tt(lang, "notif_production_shopping_ready"));
  }
  return lines.join("\n");
}

// ── Rule-based "Smart Summary" (spec section 11) ────────────────────────────
// Deliberately NOT a call to an external AI service — these are simple,
// transparent heuristics derived from the same numbers already computed for
// the report, so the recommendation is always explainable from the data
// right above it in the same message.
export function generateSmartSummary(lang, report) {
  const out = [];

  if (report.warehouse?.critical > 0 && report.warehouse?.topShortageDish) {
    out.push(`${tt(lang, "smart_increase_production")}: ${report.warehouse.topShortageDish}.`);
  }
  if (report.warehouse?.lowStockIngredients?.length) {
    out.push(`${tt(lang, "smart_purchase_today")}: ${report.warehouse.lowStockIngredients.slice(0, 3).join(", ")}.`);
  }
  if (report.finance?.worstDishes?.length >= 2) {
    out.push(tt(lang, "smart_two_dishes_loss"));
  }
  if (report.sales?.trendUpFriday) {
    out.push(tt(lang, "smart_friday_demand"));
  }
  if (report.kitchen?.avgTimeIncreased) {
    out.push(tt(lang, "smart_avg_wait_increased"));
  }
  return out;
}

// ── Daily / Weekly / Monthly report formatter (spec section 5) ─────────────
// One formatter drives all three periods — `periodLabel` differs, the shape
// of `data` (sales/kitchen/warehouse/employees/delivery/customers) is the
// same regardless of period length.
export function formatPeriodReport(lang, { restaurantName, dateLabel, data }) {
  const L = (key, fb) => tt(lang, key, fb);
  const lines = [];

  lines.push(`🏢 ${restaurantName}`);
  lines.push(`📅 ${dateLabel}`);
  lines.push(SEP);

  lines.push(`💰 ${L("notif_section_sales")}`);
  lines.push("");
  lines.push(`${L("notif_orders_label")}: ${data.sales.orders}`);
  lines.push("");
  lines.push(`${L("notif_revenue_label")}:`);
  lines.push(`${fmtNum(data.sales.revenue)} ${L("currency")}`);
  lines.push("");
  lines.push(`${L("notif_avg_check_label")}:`);
  lines.push(`${fmtNum(data.sales.avgCheck)} ${L("currency")}`);
  lines.push("");
  lines.push(`${L("notif_profit_label")}:`);
  lines.push(`${fmtNum(data.sales.profit)} ${L("currency")}`);
  lines.push(SEP);

  lines.push(`🍽 ${L("notif_section_kitchen")}`);
  lines.push("");
  lines.push(`${L("notif_prepared_label")}:`);
  lines.push(`${data.kitchen.prepared} ${L("notif_dishes_label")}`);
  lines.push("");
  lines.push(`${L("notif_avg_cook_time_label")}:`);
  lines.push(`${data.kitchen.avgCookMinutes} ${L("minutes_short")}`);
  lines.push("");
  lines.push(`${L("notif_late_orders_label")}:`);
  lines.push(`${data.kitchen.lateOrders}`);
  lines.push(SEP);

  lines.push(`📦 ${L("notif_section_warehouse")}`);
  lines.push("");
  lines.push(`${L("notif_stock_health_label")}:`);
  lines.push(`${data.warehouse.healthPct}%`);
  lines.push("");
  lines.push(`${L("notif_low_stock_label")}: ${data.warehouse.low}`);
  lines.push(`${L("notif_critical_label")}: ${data.warehouse.critical}`);
  lines.push(`${L("notif_out_of_stock_label")}: ${data.warehouse.outOfStock}`);
  lines.push("");
  lines.push(`${L("notif_shopping_recommendation_label")}:`);
  lines.push(data.warehouse.needsShopping ? L("notif_available") : L("notif_not_needed"));
  lines.push(SEP);

  lines.push(`👥 ${L("notif_section_employees")}`);
  lines.push("");
  lines.push(`${L("notif_working_label")}: ${data.employees.working}`);
  lines.push(`${L("notif_late_label")}: ${data.employees.late}`);
  lines.push(`${L("notif_absent_label")}: ${data.employees.absent}`);
  if (data.employees.topWaiter) {
    lines.push("");
    lines.push(`${L("notif_top_waiter_label")}:`);
    lines.push(escHtml(data.employees.topWaiter));
  }
  if (data.employees.topChef) {
    lines.push("");
    lines.push(`${L("notif_top_chef_label")}:`);
    lines.push(escHtml(data.employees.topChef));
  }
  lines.push(SEP);

  lines.push(`🛵 ${L("notif_section_delivery")}`);
  lines.push("");
  lines.push(`${L("notif_completed_label")}: ${data.delivery.completed}`);
  lines.push("");
  lines.push(`${L("notif_avg_delivery_label")}:`);
  lines.push(`${data.delivery.avgMinutes} ${L("minutes_short")}`);
  lines.push("");
  lines.push(`${L("notif_cancelled_label")}: ${data.delivery.cancelled}`);
  lines.push(SEP);

  lines.push(`⭐️ ${L("notif_section_customers")}`);
  lines.push("");
  lines.push(`${L("notif_new_customers_label")}: ${data.customers.new}`);
  lines.push(`${L("notif_returning_customers_label")}: ${data.customers.returning}`);
  lines.push(`${L("notif_reviews_label")}: ${data.customers.avgRating != null ? `${data.customers.avgRating}★` : "—"}`);

  const summary = generateSmartSummary(lang, data);
  if (summary.length) {
    lines.push(SEP);
    lines.push(`🧠 ${L("notif_smart_summary_title")}`);
    lines.push("");
    summary.forEach((s) => lines.push(`• ${s}`));
  }

  return lines.join("\n");
}

// ── Daily Report (spec section 1/10) — the full, detailed digest ───────────
// data shape produced by reportGenerator.generateDailyReportData():
//   sales: { orders, revenue, byMethod:{cash,click,payme,uzum}, profit }
//   ordersBreakdown: { completed, cancelled, delivery, dineIn, pickup }
//   kitchen: { avgCookMinutes, slowest:{orderNumber,minutes}, fastest:{orderNumber,minutes} }
//   delivery: { count, avgMinutes, successful, failed, perCourier:[{name,count,avgMinutes,failed}] }
//   warehouse: { low, outOfStock }
//   employees: [{name, role, orders, revenue, avgOrder, completedPct, cancelledPct, workingHours}]
//   topWaiter, topChef, topCourier
//   bestFood, worstFood
export function formatDailyReport(lang, { restaurantName, dateLabel, generatedAt, data }) {
  const L = (key, fb) => tt(lang, key, fb);
  const lines = [];

  lines.push(`📊 ${restaurantName} — ${L("notif_daily_report_title")}`);
  lines.push(`📅 ${dateLabel}`);
  lines.push(SEP);

  lines.push(`💰 ${L("notif_revenue_label")}`);
  lines.push(`${L("notif_today_label")}:`);
  lines.push(`${fmtNum(data.sales.revenue)} ${L("currency")}`);
  lines.push("");
  lines.push(`${L("notif_pay_cash")}: ${fmtNum(data.sales.byMethod.cash)} ${L("currency")}`);
  lines.push(`Click: ${fmtNum(data.sales.byMethod.click)} ${L("currency")}`);
  lines.push(`Payme: ${fmtNum(data.sales.byMethod.payme)} ${L("currency")}`);
  lines.push(`Uzum: ${fmtNum(data.sales.byMethod.uzum)} ${L("currency")}`);
  lines.push(SEP);

  lines.push(`🧾 ${L("notif_orders_label")}`);
  lines.push(`${L("notif_orders_label")}: ${data.sales.orders}`);
  lines.push(`${L("notif_completed_label")}: ${data.ordersBreakdown.completed}`);
  lines.push(`${L("notif_cancelled_label")}: ${data.ordersBreakdown.cancelled}`);
  lines.push(`${L("notif_order_type_delivery")}: ${data.ordersBreakdown.delivery}`);
  lines.push(`${L("notif_order_type_dinein")}: ${data.ordersBreakdown.dineIn}`);
  lines.push(`${L("notif_order_type_pickup")}: ${data.ordersBreakdown.pickup}`);
  lines.push(SEP);

  lines.push(`👨‍🍳 ${L("notif_section_kitchen")}`);
  lines.push(`${L("notif_avg_cook_time_label")}: ${data.kitchen.avgCookMinutes} ${L("minutes_short")}`);
  if (data.kitchen.slowest) lines.push(`${L("notif_slowest_order_label")}: #${data.kitchen.slowest.orderNumber} (${data.kitchen.slowest.minutes} ${L("minutes_short")})`);
  if (data.kitchen.fastest) lines.push(`${L("notif_fastest_order_label")}: #${data.kitchen.fastest.orderNumber} (${data.kitchen.fastest.minutes} ${L("minutes_short")})`);
  lines.push(SEP);

  lines.push(`🛵 ${L("notif_section_delivery")}`);
  lines.push(`${L("notif_delivery_count_label")}: ${data.delivery.count}`);
  lines.push(`${L("notif_avg_delivery_label")}: ${data.delivery.avgMinutes} ${L("minutes_short")}`);
  lines.push(`${L("notif_delivery_success_label")}: ${data.delivery.successful}`);
  lines.push(`${L("notif_delivery_failed_label")}: ${data.delivery.failed}`);
  lines.push(SEP);

  lines.push(`📦 ${L("notif_section_warehouse")}`);
  lines.push(`${L("notif_low_stock_label")}: ${data.warehouse.low}`);
  lines.push(`${L("notif_out_of_stock_label")}: ${data.warehouse.outOfStock}`);
  lines.push(SEP);

  lines.push(`👥 ${L("notif_section_employees")}`);
  data.employees.forEach((e) => {
    lines.push("");
    lines.push(`${escHtml(e.name)} (${escHtml(e.role)})`);
    lines.push(`${L("notif_orders_label")}: ${e.orders} | ${L("notif_revenue_label")}: ${fmtNum(e.revenue)} | ${L("notif_working_hours_label")}: ${e.workingHours ?? "—"}`);
  });
  lines.push("");
  if (data.topWaiter) lines.push(`${L("notif_top_waiter_label")}: ${escHtml(data.topWaiter)}`);
  if (data.topChef) lines.push(`${L("notif_top_chef_label")}: ${escHtml(data.topChef)}`);
  if (data.topCourier) lines.push(`${L("notif_top_courier_label")}: ${escHtml(data.topCourier)}`);
  lines.push(SEP);

  if (data.bestFood) lines.push(`⭐ ${L("notif_best_seller_label")}: ${escHtml(data.bestFood)}`);
  if (data.worstFood) lines.push(`⭐ ${L("notif_worst_seller_label")}: ${escHtml(data.worstFood)}`);

  const summary = generateSmartSummary(lang, data);
  if (summary.length) {
    lines.push(SEP);
    lines.push(`🧠 ${L("notif_smart_summary_title")}`);
    summary.forEach((s) => lines.push(`• ${s}`));
  }

  lines.push(SEP);
  lines.push(`${L("notif_generated_at_label")}: ${generatedAt || ""}`);

  return lines.join("\n");
}

// ── Weekly Report (spec section 2) ──────────────────────────────────────────
// data: { revenue, revenueChart:[{label,value}], topProducts:[{name,count}],
//         topEmployees:[{name,role,orders}], expenses, profit, warehouse:{healthPct,low,critical,outOfStock} }
export function formatWeeklyReport(lang, { restaurantName, dateLabel, generatedAt, data }) {
  const L = (key, fb) => tt(lang, key, fb);
  const lines = [];

  lines.push(`📈 ${restaurantName} — ${L("notif_weekly_report_title")}`);
  lines.push(`📅 ${dateLabel}`);
  lines.push(SEP);

  lines.push(`💰 ${L("notif_revenue_label")}: ${fmtNum(data.revenue)} ${L("currency")}`);
  lines.push(`${L("notif_expenses_label")}: ${fmtNum(data.expenses)} ${L("currency")}`);
  lines.push(`${L("notif_profit_label")}: ${fmtNum(data.profit)} ${L("currency")}`);
  lines.push(SEP);

  if (data.revenueChart?.length) {
    lines.push(`📊 ${L("notif_revenue_chart_label")}`);
    const maxVal = Math.max(...data.revenueChart.map((d) => d.value), 1);
    data.revenueChart.forEach((d) => {
      const barLen = Math.max(1, Math.round((d.value / maxVal) * 12));
      lines.push(`${d.label} ${"▓".repeat(barLen)} ${fmtNum(d.value)}`);
    });
    lines.push(SEP);
  }

  if (data.topProducts?.length) {
    lines.push(`⭐ ${L("notif_top_products_label")}`);
    data.topProducts.forEach((p, i) => lines.push(`${i + 1}. ${escHtml(p.name)} — ${p.count} ${L("notif_dishes_label")}`));
    lines.push(SEP);
  }

  if (data.topEmployees?.length) {
    lines.push(`👥 ${L("notif_top_employees_label")}`);
    data.topEmployees.forEach((e, i) => lines.push(`${i + 1}. ${escHtml(e.name)} (${escHtml(e.role)}) — ${e.orders} ${L("notif_orders_label")}`));
    lines.push(SEP);
  }

  lines.push(`📦 ${L("notif_section_warehouse")}`);
  lines.push(`${L("notif_stock_health_label")}: ${data.warehouse.healthPct}%`);
  lines.push(`${L("notif_low_stock_label")}: ${data.warehouse.low} | ${L("notif_critical_label")}: ${data.warehouse.critical} | ${L("notif_out_of_stock_label")}: ${data.warehouse.outOfStock}`);

  lines.push(SEP);
  lines.push(`${L("notif_generated_at_label")}: ${generatedAt || ""}`);

  return lines.join("\n");
}

// ── Monthly Report (spec section 3) ─────────────────────────────────────────
// data: { revenue, profit, expenses, prevRevenue, topCustomers:[{name,orders,spent}],
//         topFoods:[{name,count}], employeeKPI:[{name,role,orders,revenue}] }
export function formatMonthlyReport(lang, { restaurantName, dateLabel, generatedAt, data }) {
  const L = (key, fb) => tt(lang, key, fb);
  const lines = [];

  const growthPct = data.prevRevenue > 0 ? Math.round(((data.revenue - data.prevRevenue) / data.prevRevenue) * 1000) / 10 : null;

  lines.push(`🗓️ ${restaurantName} — ${L("notif_monthly_report_title")}`);
  lines.push(`📅 ${dateLabel}`);
  lines.push(SEP);

  lines.push(`💰 ${L("notif_revenue_label")}: ${fmtNum(data.revenue)} ${L("currency")}`);
  lines.push(`${L("notif_profit_label")}: ${fmtNum(data.profit)} ${L("currency")}`);
  lines.push(`${L("notif_expenses_label")}: ${fmtNum(data.expenses)} ${L("currency")}`);
  if (growthPct != null) {
    lines.push(`${L("notif_growth_label")}: ${growthPct > 0 ? "📈 +" : "📉 "}${growthPct}%`);
  }
  lines.push(SEP);

  if (data.topCustomers?.length) {
    lines.push(`👑 ${L("notif_top_customers_label")}`);
    data.topCustomers.forEach((c, i) => lines.push(`${i + 1}. ${escHtml(c.name)} — ${c.orders} ${L("notif_orders_label")} (${fmtNum(c.spent)} ${L("currency")})`));
    lines.push(SEP);
  }

  if (data.topFoods?.length) {
    lines.push(`⭐ ${L("notif_top_products_label")}`);
    data.topFoods.forEach((f, i) => lines.push(`${i + 1}. ${escHtml(f.name)} — ${f.count} ${L("notif_dishes_label")}`));
    lines.push(SEP);
  }

  if (data.employeeKPI?.length) {
    lines.push(`👥 ${L("notif_employee_kpi_label")}`);
    data.employeeKPI.forEach((e) => lines.push(`${escHtml(e.name)} (${escHtml(e.role)}) — ${e.orders} ${L("notif_orders_label")}, ${fmtNum(e.revenue)} ${L("currency")}`));
  }

  lines.push(SEP);
  lines.push(`${L("notif_generated_at_label")}: ${generatedAt || ""}`);

  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════════════════════
// Additive — Telegram Control Panel dashboard messages (2026 expansion).
// Telegram-side text only; reuses the SAME reportGenerator compute functions
// as the scheduled reports above (see reportGenerator.js's new
// getWarehouseStatus/getFinanceStatusToday/etc.). These are HTML (`parse_mode:
// "HTML"`) rather than plain text like the scheduled reports, since the
// dashboard is meant to be read interactively inside Telegram.
// ══════════════════════════════════════════════════════════════════════════

function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatDashboardWelcome(lang, restaurantName) {
  return `🤖 <b>${escHtml(restaurantName)}</b>\n${tt(lang, "tg_dashboard_welcome")}`;
}

export function formatReportTodayHTML(lang, data, restaurantName) {
  const L = (k, f) => tt(lang, k, f);
  return [
    `📊 <b>${escHtml(restaurantName)} — ${L("tg_report_today_title")}</b>`,
    "",
    `🧾 ${L("notif_orders_label")}: <b>${data.sales.orders}</b>`,
    `💰 ${L("notif_revenue_label")}: <b>${fmtNum(data.sales.revenue)} ${L("currency")}</b>`,
    `📈 ${L("notif_avg_check_label")}: <b>${fmtNum(data.sales.avgCheck)} ${L("currency")}</b>`,
    `✅ ${L("notif_completed_label")}: <b>${data.ordersBreakdown.completed}</b>`,
    `❌ ${L("notif_cancelled_label")}: <b>${data.ordersBreakdown.cancelled}</b>`,
    data.bestFood ? `⭐ ${L("notif_best_seller_label")}: <b>${escHtml(data.bestFood)}</b>` : "",
  ].filter(Boolean).join("\n");
}

export function formatWarehouseStatusHTML(lang, wh) {
  const L = (k, f) => tt(lang, k, f);
  const lines = [
    `📦 <b>${L("tg_warehouse_status_title")}</b>`,
    "",
    `${L("notif_stock_health_label")}: <b>${wh.healthPct}%</b>`,
    `🟡 ${L("notif_low_stock_label")}: <b>${wh.low}</b>`,
    `🔴 ${L("notif_critical_label")}: <b>${wh.critical}</b>`,
    `⛔ ${L("notif_out_of_stock_label")}: <b>${wh.outOfStock}</b>`,
  ];
  if (wh.lowStockIngredients?.length) {
    lines.push("", `⚠️ ${escHtml(wh.lowStockIngredients.slice(0, 10).join(", "))}`);
  }
  return lines.join("\n");
}

export function formatEmployeesStatusHTML(lang, data) {
  const L = (k, f) => tt(lang, k, f);
  const lines = [`👥 <b>${L("tg_employees_status_title")}</b>`, ""];
  if (!data.employees.length) {
    lines.push(L("tg_no_data"));
  } else {
    data.employees.slice(0, 10).forEach((e) => {
      lines.push(`• <b>${escHtml(e.name)}</b> (${escHtml(e.role)}) — ${e.orders} ${L("notif_orders_label")}, ${fmtNum(e.revenue)} ${L("currency")}`);
    });
  }
  lines.push("");
  if (data.topWaiter) lines.push(`🏅 ${L("notif_top_waiter_label")}: <b>${escHtml(data.topWaiter)}</b>`);
  if (data.topChef) lines.push(`🏅 ${L("notif_top_chef_label")}: <b>${escHtml(data.topChef)}</b>`);
  return lines.join("\n");
}

export function formatFinanceStatusHTML(lang, sales) {
  const L = (k, f) => tt(lang, k, f);
  return [
    `💰 <b>${L("tg_finance_status_title")}</b>`,
    "",
    `${L("notif_revenue_label")}: <b>${fmtNum(sales.revenue)} ${L("currency")}</b>`,
    `${L("notif_pay_cash")}: ${fmtNum(sales.byMethod.cash)} ${L("currency")}`,
    `Click: ${fmtNum(sales.byMethod.click)} ${L("currency")}`,
    `Payme: ${fmtNum(sales.byMethod.payme)} ${L("currency")}`,
    `Uzum: ${fmtNum(sales.byMethod.uzum)} ${L("currency")}`,
    `${L("notif_profit_label")}: <b>${fmtNum(sales.profit)} ${L("currency")}</b>`,
  ].join("\n");
}

export function formatOrdersStatusHTML(lang, ord) {
  const L = (k, f) => tt(lang, k, f);
  return [
    `🍽 <b>${L("tg_orders_status_title")}</b>`,
    "",
    `${L("notif_orders_label")}: <b>${ord.totalOrders}</b>`,
    `✅ ${L("notif_completed_label")}: ${ord.completed}`,
    `❌ ${L("notif_cancelled_label")}: ${ord.cancelled}`,
    `🚚 ${L("notif_order_type_delivery")}: ${ord.delivery}`,
    `🏠 ${L("notif_order_type_dinein")}: ${ord.dineIn}`,
    `🥡 ${L("notif_order_type_pickup")}: ${ord.pickup}`,
  ].join("\n");
}

export function formatKitchenStatusHTML(lang, k) {
  const L = (key, f) => tt(lang, key, f);
  const lines = [
    `🍳 <b>${L("tg_kitchen_status_title")}</b>`,
    "",
    `${L("notif_avg_cook_time_label")}: <b>${k.avgCookMinutes} ${L("minutes_short")}</b>`,
  ];
  if (k.slowest) lines.push(`🐢 ${L("notif_slowest_order_label")}: #${k.slowest.orderNumber} (${k.slowest.minutes} ${L("minutes_short")})`);
  if (k.fastest) lines.push(`⚡ ${L("notif_fastest_order_label")}: #${k.fastest.orderNumber} (${k.fastest.minutes} ${L("minutes_short")})`);
  return lines.join("\n");
}

export function formatDeliveryStatusHTML(lang, d) {
  const L = (k, f) => tt(lang, k, f);
  const lines = [
    `🛵 <b>${L("tg_delivery_status_title")}</b>`,
    "",
    `${L("notif_delivery_count_label")}: <b>${d.count}</b>`,
    `${L("notif_avg_delivery_label")}: ${d.avgMinutes} ${L("minutes_short")}`,
    `✅ ${L("notif_delivery_success_label")}: ${d.successful}`,
    `❌ ${L("notif_delivery_failed_label")}: ${d.failed}`,
  ];
  if (d.topCourier) lines.push("", `🏅 ${L("notif_top_courier_label")}: <b>${escHtml(d.topCourier)}</b>`);
  return lines.join("\n");
}

export function formatSettingsStatusHTML(lang, settings) {
  const L = (k, f) => tt(lang, k, f);
  const onOff = (v) => (v ? `✅ ${L("tg_status_on")}` : `⛔ ${L("tg_status_off")}`);
  return [
    `⚙️ <b>${L("tg_settings_status_title")}</b>`,
    "",
    `${L("notif_type_daily_report")}: ${onOff(settings.schedule.daily?.enabled)} (${(settings.schedule.daily?.times || []).join(", ") || "—"})`,
    `${L("notif_type_weekly_report")}: ${onOff(settings.schedule.weekly?.enabled)} (${settings.schedule.weekly?.day || "—"} ${settings.schedule.weekly?.time || ""})`,
    `${L("notif_type_monthly_report")}: ${onOff(settings.schedule.monthly?.enabled)} (${L("tg_day_of_month")} ${settings.schedule.monthly?.day || "—"} ${settings.schedule.monthly?.time || ""})`,
    `${L("notif_type_large_order")}: ${onOff(settings.types?.large_order !== false)}`,
    `${L("notif_type_warehouse_alert")}: ${onOff(settings.types?.warehouse_alert !== false)}`,
    `${L("notif_timezone_label")}: ${settings.schedule.timezone}`,
  ].join("\n");
}

// ══════════════════════════════════════════════════════════════════════════
// Additive — Restoran jarayoni / Stollar / Buyurtmalar / Bronlar / Mijozlar /
// Xodimlar drill-down (2026 expansion). Same escHtml() discipline as above —
// every field that can carry admin/customer/staff-entered text is escaped.
// ══════════════════════════════════════════════════════════════════════════

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const TABLE_BUCKET_ICON = { free: "🟢", occupied: "🔴", reserved: "🟣", paying: "⚪" };
const ORDER_BUCKET_ICON = { new: "🆕", kitchen: "🍳", ready: "✅", payment: "💳", completed: "✔️", cancelled: "❌" };

// table.tableType is a small fixed enum (mirrors shared.js's
// TABLE_TYPE_CONFIG) — safe to translate via fixed keys.
const KNOWN_TABLE_TYPES = new Set(["oddiy", "vip", "kabina", "terrasa"]);
function tableTypeLabel(lang, type) {
  const key = String(type || "oddiy").toLowerCase();
  return KNOWN_TABLE_TYPES.has(key) ? tt(lang, `table_type_${key}`) : (type || "oddiy");
}

// users/{id}.role is NOT a fixed enum — restaurants can define custom roles
// (admin-frontend's window._customRoles) — so only the common built-in roles
// are translated via i18n keys; anything else is shown as-is rather than
// leaking a raw "tg_role_xyz" key string (getTranslator falls back to the
// key itself, not a caller-supplied default, when a key is missing).
const KNOWN_ROLES = new Set(["chef", "head_chef", "waiter", "cashier", "courier", "hr", "finance", "manager", "admin"]);
function roleLabel(lang, role) {
  const key = String(role || "").toLowerCase();
  return KNOWN_ROLES.has(key) ? tt(lang, `tg_role_${key}`) : (role || "—");
}

export function formatProcessViewHTML(lang, data) {
  const L = (k, f) => tt(lang, k, f);
  return [
    `🏪 <b>${L("tg_process_view_title")}</b>`,
    "",
    `🪑 ${L("tg_process_tables_section")}`,
    `🟢 ${L("tg_table_bucket_free")}: ${data.tables.free}  🔴 ${L("tg_table_bucket_occupied")}: ${data.tables.occupied}`,
    `🟣 ${L("tg_table_bucket_reserved")}: ${data.tables.reserved}  ⚪ ${L("tg_table_bucket_paying")}: ${data.tables.paying}`,
    "",
    `🧾 ${L("notif_orders_label")}`,
    `🆕 ${L("tg_orders_bucket_new")}: ${data.orders.new}  🍳 ${L("tg_orders_bucket_kitchen")}: ${data.orders.kitchen}`,
    `✅ ${L("tg_orders_bucket_ready")}: ${data.orders.ready}  💳 ${L("tg_orders_bucket_payment")}: ${data.orders.payment}`,
    "",
    `🍳 ${L("tg_kitchen_status_title")}`,
    `${L("notif_avg_cook_time_label")}: <b>${data.kitchen.avgCookMinutes} ${L("minutes_short")}</b>`,
    "",
    `🚚 ${L("tg_delivery_status_title")}`,
    `${L("notif_delivery_count_label")}: <b>${data.delivery.count}</b>  ${L("notif_avg_delivery_label")}: ${data.delivery.avgMinutes} ${L("minutes_short")}`,
    "",
    `📅 ${L("tg_process_reservations_section")}`,
    `⏳ ${L("tg_reservation_pending")}: ${data.reservations.pending}  ✅ ${L("tg_reservation_confirmed")}: ${data.reservations.confirmed}`,
  ].join("\n");
}

export function formatTablesStatusHTML(lang, counts) {
  const L = (k, f) => tt(lang, k, f);
  return [
    `🪑 <b>${L("tg_tables_status_title")}</b>`,
    "",
    `🟢 ${L("tg_table_bucket_free")}: <b>${counts.free}</b>`,
    `🔴 ${L("tg_table_bucket_occupied")}: <b>${counts.occupied}</b>`,
    `🟣 ${L("tg_table_bucket_reserved")}: <b>${counts.reserved}</b>`,
    `⚪ ${L("tg_table_bucket_paying")}: <b>${counts.paying}</b>`,
  ].join("\n");
}

export function formatTableListHTML(lang, bucket, tables) {
  const L = (k, f) => tt(lang, k, f);
  const icon = TABLE_BUCKET_ICON[bucket] || "🪑";
  const lines = [`${icon} <b>${L(`tg_table_bucket_${bucket}`)}</b>`, ""];
  if (!tables.length) lines.push(L("tg_no_data"));
  else tables.forEach((t) => lines.push(`№${escHtml(t.number)} — ${escHtml(tableTypeLabel(lang, t.tableType))}`));
  return lines.join("\n");
}

export function formatTableDetailHTML(lang, t) {
  const L = (k, f) => tt(lang, k, f);
  const icon = TABLE_BUCKET_ICON[t.bucket] || "🪑";
  const lines = [
    `🪑 <b>${L("tg_table_detail_title")} №${escHtml(t.number)}</b>`,
    "",
    `${L("tg_status_label")}: ${icon} ${L(`tg_table_bucket_${t.bucket}`)}`,
    `${L("tg_table_type_label")}: ${escHtml(tableTypeLabel(lang, t.tableType))}`,
  ];
  if (t.order) {
    lines.push("");
    if (t.order.waiterName) lines.push(`👤 ${L("tg_waiter_label")}: ${escHtml(t.order.waiterName)}`);
    lines.push(`🧾 ${L("tg_order_label")}: #${escHtml(t.order.orderNumber)}`);
    lines.push(`💰 ${L("notif_revenue_label")}: ${fmtNum(t.order.total)} ${L("currency")}`);
    if (t.order.createdAt) lines.push(`🕐 ${L("tg_order_started_label")}: ${fmtTime(t.order.createdAt)}`);
    if (t.order.items?.length) {
      lines.push("", `🍽 ${L("tg_order_items_label")}:`);
      t.order.items.forEach((it) => lines.push(`${escHtml(it.name)} ×${it.qty}`));
    }
  }
  return lines.join("\n");
}

export function formatOrdersPipelineHTML(lang, pipeline) {
  const L = (k, f) => tt(lang, k, f);
  return [
    `🧾 <b>${L("notif_orders_label")}</b>`,
    "",
    `🆕 ${L("tg_orders_bucket_new")}: <b>${pipeline.new}</b>`,
    `🍳 ${L("tg_orders_bucket_kitchen")}: <b>${pipeline.kitchen}</b>`,
    `✅ ${L("tg_orders_bucket_ready")}: <b>${pipeline.ready}</b>`,
    `💳 ${L("tg_orders_bucket_payment")}: <b>${pipeline.payment}</b>`,
    `✔️ ${L("tg_orders_bucket_completed")}: <b>${pipeline.completed}</b>`,
  ].join("\n");
}

export function formatOrderListHTML(lang, bucket, orders) {
  const L = (k, f) => tt(lang, k, f);
  const icon = ORDER_BUCKET_ICON[bucket] || "🧾";
  const lines = [`${icon} <b>${L(`tg_orders_bucket_${bucket}`)}</b>`, ""];
  if (!orders.length) lines.push(L("tg_no_data"));
  else orders.forEach((o) => {
    lines.push(`#${escHtml(o.orderNumber)}`);
    if (o.table != null) lines.push(`🪑 ${L("tg_table_detail_title")} №${escHtml(o.table)}`);
    lines.push(`💰 ${fmtNum(o.total)} ${L("currency")}`, "");
  });
  return lines.join("\n");
}

export function formatOrderDetailHTML(lang, o) {
  const L = (k, f) => tt(lang, k, f);
  const lines = [`🧾 <b>#${escHtml(o.orderNumber)}</b>`, ""];
  if (o.table != null) lines.push(`🪑 ${L("tg_table_detail_title")}: №${escHtml(o.table)}`);
  if (o.customerName) lines.push(`👤 ${escHtml(o.customerName)}`);
  if (o.customerPhone) lines.push(`📞 ${escHtml(o.customerPhone)}`);
  if (o.items.length) {
    lines.push("", `🍽 ${L("tg_order_items_label")}`, "");
    o.items.forEach((it) => lines.push(`${escHtml(it.name)} ×${it.qty}   ${fmtNum(it.qty * it.price)}`));
  }
  lines.push("");
  if (o.discount > 0) lines.push(`🏷 ${L("tg_order_discount_label")}   −${fmtNum(o.discount)}`);
  lines.push(`💵 ${L("tg_order_total_label")}   <b>${fmtNum(o.total)} ${L("currency")}</b>`);
  lines.push("");
  if (o.paymentMethod) lines.push(`💳 ${L("tg_order_payment_label")}: ${escHtml(o.paymentMethod)}${o.paid ? ` (${L("tg_order_paid_label")})` : ""}`);
  lines.push(`📌 ${L("tg_status_label")}: ${ORDER_BUCKET_ICON[o.bucket] || ""} ${L(`tg_orders_bucket_${o.bucket}`, o.bucket)}`);
  if (o.chefName) lines.push(`🧑‍🍳 ${L("tg_chef_label")}: ${escHtml(o.chefName)}`);
  if (o.waiterName) lines.push(`🧑 ${L("tg_waiter_label")}: ${escHtml(o.waiterName)}`);
  return lines.join("\n");
}

export function formatReservationsStatusHTML(lang, counts) {
  const L = (k, f) => tt(lang, k, f);
  return [
    `📅 <b>${L("tg_reservations_status_title")}</b>`,
    "",
    `⏳ ${L("tg_reservation_pending")}: <b>${counts.pending}</b>`,
    `✅ ${L("tg_reservation_confirmed")}: <b>${counts.confirmed}</b>`,
    `🪑 ${L("tg_reservation_seated")}: <b>${counts.seated}</b>`,
    `❌ ${L("tg_reservation_cancelled")}: <b>${counts.cancelled}</b>`,
  ].join("\n");
}

export function formatReservationListHTML(lang, when, list) {
  const L = (k, f) => tt(lang, k, f);
  const lines = [`📅 <b>${L(when === "today" ? "tg_reservations_today_title" : "tg_reservations_upcoming_title")}</b>`, ""];
  if (!list.length) lines.push(L("tg_no_data"));
  else list.forEach((r) => lines.push(`${escHtml(r.date)} ${escHtml(r.time)} — ${escHtml(r.guestName)} — ${r.guests} ${L("tg_guests_label")} — №${escHtml(r.tableNumber ?? "—")}`));
  return lines.join("\n");
}

export function formatReservationDetailHTML(lang, r) {
  const L = (k, f) => tt(lang, k, f);
  const bucketLabelKey = { pending: "tg_reservation_pending", confirmed: "tg_reservation_confirmed", seated: "tg_reservation_seated", cancelled: "tg_reservation_cancelled" }[r.bucket] || "tg_reservation_pending";
  return [
    `📅 <b>${L("tg_reservation_detail_title")}</b>`,
    "",
    `👤 ${escHtml(r.guestName)}`,
    r.guestPhone ? `📞 ${escHtml(r.guestPhone)}` : "",
    "",
    `🕐 ${escHtml(r.date)} ${escHtml(r.time)}`,
    `👥 ${r.guests} ${L("tg_guests_label")}`,
    r.tableNumber != null ? `🪑 ${L("tg_table_detail_title")} №${escHtml(r.tableNumber)}` : "",
    "",
    `${L("tg_status_label")}: ${L(bucketLabelKey)}`,
  ].filter(Boolean).join("\n");
}

export function formatCustomersStatusHTML(lang, counts) {
  const L = (k, f) => tt(lang, k, f);
  return [
    `👥 <b>${L("tg_customers_status_title")}</b>`,
    "",
    `👤 ${L("tg_customers_today_label")}: <b>${counts.today}</b>`,
    `🆕 ${L("notif_new_customers_label")}: <b>${counts.new}</b>`,
    `🔁 ${L("notif_returning_customers_label")}: <b>${counts.returning}</b>`,
    `🏷 ${L("tg_customers_discounted_label")}: <b>${counts.discounted}</b>`,
  ].join("\n");
}

export function formatCustomerListHTML(lang, bucket, list) {
  const L = (k, f) => tt(lang, k, f);
  const lines = [`👥 <b>${L(`tg_customer_bucket_${bucket}`)}</b>`, ""];
  if (!list.length) lines.push(L("tg_no_data"));
  else list.forEach((c) => lines.push(`👤 ${escHtml(c.name)} — ${c.orderCount} ${L("notif_orders_label")} — ${fmtNum(c.totalSpent)} ${L("currency")}`));
  return lines.join("\n");
}

export function formatCustomerDetailHTML(lang, c) {
  const L = (k, f) => tt(lang, k, f);
  return [
    `👤 <b>${escHtml(c.name)}</b>`,
    "",
    c.phone ? `📞 ${escHtml(c.phone)}` : "",
    "",
    `🧾 ${L("notif_orders_label")}: ${c.orderCount}`,
    `💰 ${L("tg_customer_spent_label")}: ${fmtNum(c.totalSpent)} ${L("currency")}`,
    `🪑 ${L("tg_customer_visits_label")}: ${c.visits}`,
    c.discount ? `🏷 ${L("tg_customer_discount_label")}: ${c.discount}%` : "",
    "",
    c.lastOrderAt ? `🕐 ${L("tg_customer_last_visit_label")}:\n${fmtDate(c.lastOrderAt, lang)}` : "",
  ].filter(Boolean).join("\n");
}

export function formatEmployeesListHTML(lang, summary) {
  const L = (k, f) => tt(lang, k, f);
  return [
    `👥 <b>${L("tg_employees_status_title")}</b>`,
    "",
    `${L("tg_total_employees_label")}: <b>${summary.total}</b>`,
    `${L("tg_active_employees_label")}: <b>${summary.active}</b>`,
    `${L("tg_blocked_employees_label")}: <b>${summary.blocked}</b>`,
  ].join("\n");
}

export function formatEmployeeRoleListHTML(lang, role, list) {
  const L = (k, f) => tt(lang, k, f);
  const lines = [`👥 <b>${escHtml(roleLabel(lang, role))}</b>`, ""];
  if (!list.length) lines.push(L("tg_no_data"));
  else list.forEach((e) => lines.push(`${e.active ? "🟢" : "🔴"} ${escHtml(e.name)}`));
  return lines.join("\n");
}

export function formatEmployeeDetailHTML(lang, e) {
  const L = (k, f) => tt(lang, k, f);
  return [
    `👤 <b>${escHtml(e.name)}</b>`,
    "",
    `${L("tg_role_label")}: ${escHtml(roleLabel(lang, e.role))}`,
    `${L("tg_employee_account_status_label")}: ${e.active ? `🟢 ${L("tg_employee_active")}` : `🔴 ${L("tg_employee_blocked")}`}`,
    "",
    `${L("tg_employee_today_activity_label")}:`,
    `${L("notif_orders_label")}: ${e.ordersToday}`,
    "",
    `${L("tg_employee_last_activity_label")}:`,
    `${e.lastActivityAt ? fmtTime(e.lastActivityAt) : "—"}`,
    "",
    // "Working now" is only ever claimed when a real attendance/shift source
    // exists — it does not in this codebase (see reportGenerator.js's
    // computeEmployeeWorkingNow), so this is always the NOT-VERIFIED line,
    // never a fabricated "🟢 Working" guess based on order activity alone.
    `${L("tg_employee_working_now_label")}: ${e.workingNow ?? L("tg_employee_working_now_not_available")}`,
  ].join("\n");
}

/** Employee schedule report (spec Part B section 21) — plain text, same
 * convention as formatDailyReport()/formatWeeklyReport() above. */
export function formatEmployeeReportText(lang, { restaurantName, generatedAt, data }) {
  const L = (k, f) => tt(lang, k, f);
  const lines = [
    `👥 ${restaurantName} — ${L("tg_employee_report_title")}`,
    SEP,
    `${L("tg_total_employees_label")}: ${data.summary.total}`,
    `${L("tg_active_employees_label")}: ${data.summary.active}`,
    `${L("tg_blocked_employees_label")}: ${data.summary.blocked}`,
    SEP,
    `${L("tg_today_activity_title")}:`,
  ];
  data.employees.forEach((e) => lines.push(`${escHtml(e.name)} — ${e.ordersToday ?? 0} ${L("notif_orders_label")}`.trim()));
  lines.push(SEP, `${L("notif_generated_at_label")}: ${generatedAt || ""}`);
  return lines.join("\n");
}

/** Restaurant-process schedule report (spec Part B section 22) — same
 * numbers as formatProcessViewHTML(), plain-text for the scheduled send. */
export function formatProcessReportText(lang, { restaurantName, generatedAt, data }) {
  const L = (k, f) => tt(lang, k, f);
  return [
    `🏪 ${restaurantName} — ${L("tg_process_report_title")}`,
    SEP,
    `🪑 ${L("tg_process_tables_section")}:`,
    `${L("tg_table_bucket_free")}: ${data.tables.free} / ${L("tg_table_bucket_occupied")}: ${data.tables.occupied}`,
    "",
    `🧾 ${L("notif_orders_label")}:`,
    `${L("tg_orders_bucket_new")}: ${data.orders.new} / ${L("tg_orders_bucket_kitchen")}: ${data.orders.kitchen} / ${L("tg_orders_bucket_ready")}: ${data.orders.ready}`,
    "",
    `💳 ${L("tg_process_payments_section")}:`,
    `${L("tg_orders_bucket_payment")}: ${data.orders.payment}`,
    "",
    `🍳 ${L("tg_kitchen_status_title")}:`,
    `${L("notif_avg_cook_time_label")}: ${data.kitchen.avgCookMinutes} ${L("minutes_short")}`,
    "",
    `🚚 ${L("tg_delivery_status_title")}:`,
    `${L("notif_delivery_count_label")}: ${data.delivery.count}`,
    SEP,
    `${L("notif_generated_at_label")}: ${generatedAt || ""}`,
  ].join("\n");
}

export { fmtNum, fmtDate, escHtml };
