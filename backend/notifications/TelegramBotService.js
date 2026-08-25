// notifications/TelegramBotService.js — inbound side of Telegram: the
// interactive "24/7 Control Panel" (/start + button dashboard). This is a
// NEW, separate capability from providers/TelegramProvider.js, which stays
// exactly as it was — outbound-only (NotificationService -> TelegramProvider
// -> sendMessage), used for scheduled reports and instant alerts. Nothing in
// that path changes. This file only ADDS the ability for the bot to receive
// and respond to messages/button presses.
//
// Multi-tenant design: every restaurant can configure its own Telegram bot
// (settings.notificationSettings.telegram.botToken), so this service runs
// one independent long-poll loop per restaurant whose bot is enabled — not
// one global bot. Loops are (re)synced against live Firebase settings every
// 30s, so enabling/disabling/re-tokening a restaurant's bot takes effect
// without a server restart, same guarantee as the scheduler already gives
// for report times.
//
// Architecture kept flat and consistent with the rest of notifications/:
//   TelegramBotService  -- inbound polling + command/callback routing (this file)
//   NotificationService -- outbound dispatch (unchanged)
//   providerRegistry / TelegramProvider -- outbound channel adapter (unchanged)
//   reportGenerator / templates -- shared data + text builders (reused, not duplicated)
import { listRestaurantIds, getNotificationSettings, updateNotificationSettings, getRestaurantName, appendNotificationLog } from "./common.js";
import {
  dayRange, generateDailyReportData, getWarehouseStatus, getFinanceStatusToday, getOrdersStatusToday, getKitchenStatusToday, getDeliveryStatusToday, getEmployeesStatusToday,
  getRestaurantProcessToday, getTablesStatusToday, getTablesByBucket, getTableDetail,
  getOrdersBucketsToday, getOrdersByBucketToday, getOrderDetail,
  getReservationsStatusToday, getReservationsList, getReservationDetail,
  getCustomersStatusToday, getCustomersList, getCustomerDetail,
  getEmployeesSummaryToday, getEmployeesList, getEmployeeDetail,
} from "./reportGenerator.js";
import {
  formatDashboardWelcome, formatReportTodayHTML, formatWarehouseStatusHTML, formatEmployeesStatusHTML,
  formatFinanceStatusHTML, formatOrdersStatusHTML, formatKitchenStatusHTML, formatDeliveryStatusHTML, formatSettingsStatusHTML,
  formatProcessViewHTML, formatTablesStatusHTML, formatTableListHTML, formatTableDetailHTML,
  formatOrdersPipelineHTML, formatOrderListHTML, formatOrderDetailHTML,
  formatReservationsStatusHTML, formatReservationListHTML, formatReservationDetailHTML,
  formatCustomersStatusHTML, formatCustomerListHTML, formatCustomerDetailHTML,
  formatEmployeeRoleListHTML, formatEmployeeDetailHTML,
} from "./templates.js";
import { getTranslator } from "./locales/index.js";
import { TOGGLEABLE_TYPES } from "./types.js";
import { resolveAndLinkChat } from "./chatRegistry.js";
import { approveOrderViaBot, cancelOrderViaBot, confirmReservationViaBot, cancelReservationViaBot } from "./orderActions.js";

const TELEGRAM_API = "https://api.telegram.org/bot";
const SYNC_INTERVAL_MS = 30 * 1000;
const POLL_TIMEOUT_SEC = 25; // Telegram long-poll wait; keep well under typical proxy/timeout limits

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callApi(botToken, method, body) {
  try {
    const resp = await fetch(`${TELEGRAM_API}${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return await resp.json().catch(() => ({ ok: false, description: "invalid_json_response" }));
  } catch (err) {
    return { ok: false, description: err.message, networkError: true };
  }
}

export async function sendMessage(botToken, chatId, text, replyMarkup) {
  return callApi(botToken, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: replyMarkup });
}

export async function editMessage(botToken, chatId, messageId, text, replyMarkup) {
  return callApi(botToken, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", reply_markup: replyMarkup });
}

export async function answerCallbackQuery(botToken, callbackQueryId, text) {
  return callApi(botToken, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

// Every caption comes from getTranslator(lang) — no hardcoded button text
// anywhere in this file. Three keyboard "views" exist: the main dashboard
// grid, the settings sub-menu, and the language sub-menu; which one is
// shown is decided by buildCallbackContent() below, per callback pressed.
// Exported (not just used internally) so scheduler.js can attach this SAME
// menu to an automatic daily/weekly/monthly report — tapping any button on
// an auto-sent report goes through the exact same, already-tested callback
// handling as pressing it from /start's dashboard. No new callback routes,
// no duplicated button set to keep in sync.
export function dashboardKeyboard(lang) {
  const t = getTranslator(lang);
  return [
    [{ text: t("btn_report"), callback_data: "report_today" }, { text: t("btn_warehouse"), callback_data: "warehouse_status" }, { text: t("btn_employees"), callback_data: "employees_status" }],
    [{ text: t("btn_finance"), callback_data: "finance_today" }, { text: t("btn_orders"), callback_data: "orders_status" }, { text: t("btn_kitchen"), callback_data: "kitchen_status" }],
    [{ text: t("btn_delivery"), callback_data: "delivery_status" }, { text: t("btn_settings"), callback_data: "settings" }, { text: t("btn_refresh"), callback_data: "refresh_dashboard" }],
    // Restaurant-process / drill-down expansion (2026) — additive rows, the
    // 3 rows above are untouched (spec: "NO BREAKING CHANGES", existing
    // callbacks keep working exactly as before).
    [{ text: t("btn_process"), callback_data: "process" }, { text: t("btn_tables"), callback_data: "tables_status" }],
    [{ text: t("btn_reservations"), callback_data: "resv" }, { text: t("btn_customers"), callback_data: "cust" }],
  ];
}

// Every drill-down screen below ends in this same [⬅️ Orqaga]/[🏠 Bosh menyu]
// row (spec section 26) — "back" always returns to the nearest meaningful
// parent screen (not necessarily the exact previous page/bucket), "home"
// always returns to the main dashboard.
function navRow(lang, backCallback) {
  const t = getTranslator(lang);
  const row = [];
  if (backCallback) row.push({ text: t("btn_back"), callback_data: backCallback });
  row.push({ text: t("btn_home"), callback_data: "refresh_dashboard" });
  return [row];
}

const PAGE_SIZE = 8;
function paginate(list, page) {
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, Number(page) || 1), totalPages);
  return { slice: list.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE), page: p, totalPages };
}

/** Spec section 27 pagination row: [⬅️] page/total [➡️] — "noop" (the page
 * indicator) is handled as a silent no-op in handleUpdate below, never
 * treated as an unknown action. */
function paginationRow(prefix, page, totalPages) {
  if (totalPages <= 1) return [];
  const row = [];
  if (page > 1) row.push({ text: "⬅️", callback_data: `${prefix}_${page - 1}` });
  row.push({ text: `${page}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages) row.push({ text: "➡️", callback_data: `${prefix}_${page + 1}` });
  return [row];
}

// "⚙️ Settings" -> 🌐 Language / 🔔 Notifications / ⬅️ Back to dashboard.
function settingsKeyboard(lang) {
  const t = getTranslator(lang);
  return [
    [{ text: t("btn_language"), callback_data: "language" }],
    [{ text: t("btn_notifications"), callback_data: "notifications" }],
    [{ text: t("btn_back"), callback_data: "refresh_dashboard" }],
  ];
}

function languageKeyboard(lang) {
  const t = getTranslator(lang);
  return [
    [{ text: t("btn_lang_uz"), callback_data: "lang_uz" }],
    [{ text: t("btn_lang_ru"), callback_data: "lang_ru" }],
    [{ text: t("btn_lang_en"), callback_data: "lang_en" }],
    [{ text: t("btn_back"), callback_data: "settings" }],
  ];
}

// ── Notification type toggles ───────────────────────────────────────────────
// TOGGLEABLE_TYPES (types.js) is the single authoritative list of every
// switchable notification type — the SAME list NotificationService.send()
// already checks via isTypeEnabled() before sending anything, and the SAME
// list the Admin Panel's Settings → Notifications checkboxes render from
// (admin.js NOTIF_TOGGLE_TYPES). This menu is a third view over that one
// list — no separate/duplicated configuration exists anywhere.
//
// A handful of types get the exact callback_data name requested in the
// spec (e.g. "toggle_cancel_order" for the "order_cancelled" type, because
// the literal type key would be a worse button identifier); everything else
// falls back to the mechanical `toggle_<type>` pattern. Both directions
// (type -> callback, callback -> type) are derived from ONE table so they
// can never drift out of sync with each other.
const TOGGLE_CALLBACK_ALIASES = {
  order_cancelled: "toggle_cancel_order",
  payment_received: "toggle_payment",
  delivery_problem: "toggle_delivery",
  customer_review: "toggle_customer_reviews",
  employee_attendance: "toggle_attendance",
  system_error: "toggle_system_errors",
  printer_offline: "toggle_printer",
  database_offline: "toggle_database",
  refund_alert: "toggle_refund",
  food_sold_out: "toggle_dish_unavailable",
  employee_login: "toggle_checkin",
  employee_logout: "toggle_checkout",
};

function callbackForType(type) {
  return TOGGLE_CALLBACK_ALIASES[type] || `toggle_${type}`;
}

const CALLBACK_TO_TYPE = Object.fromEntries(
  TOGGLEABLE_TYPES.map((type) => [callbackForType(type), type])
);

function typeLabelKey(type) {
  return `notif_type_${type}`;
}

function notificationsMenuKeyboard(lang, settings) {
  const t = getTranslator(lang);
  const rows = TOGGLEABLE_TYPES.map((type) => {
    const enabled = settings.types?.[type] !== false; // same default-on rule as isTypeEnabled()
    return [{ text: `${enabled ? "✅" : "❌"} ${t(typeLabelKey(type))}`, callback_data: callbackForType(type) }];
  });
  rows.push([{ text: t("btn_back"), callback_data: "settings" }]);
  return rows;
}

export function sendInlineKeyboard(botToken, chatId, text, keyboardRows) {
  return sendMessage(botToken, chatId, text, { inline_keyboard: keyboardRows });
}

const LANGUAGE_CALLBACKS = { lang_uz: "uz", lang_ru: "ru", lang_en: "en" };

/**
 * Every callback fetches fresh data via reportGenerator's compute functions
 * (the same ones the scheduled reports use) — no caching layer exists
 * anywhere in this module, so every button press is a live Firebase read.
 * Returns { text, keyboard } — the keyboard differs for the settings/
 * language sub-menus vs. the main dashboard.
 */
async function buildCallbackContent(restId, settings, restaurantName, data) {
  const lang = settings.language;

  // Language switch — spec section "CALLBACKS": update Firebase, refresh
  // the menu, and confirm IN THE NEWLY SELECTED LANGUAGE.
  if (LANGUAGE_CALLBACKS[data]) {
    const newLang = LANGUAGE_CALLBACKS[data];
    await updateNotificationSettings(restId, { language: newLang });
    const newT = getTranslator(newLang);
    return { text: `${newT("lang_changed_success")}\n\n${newT("lang_menu_prompt")}`, keyboard: languageKeyboard(newLang) };
  }

  // Notification-type toggle — flips exactly one key inside settings.types
  // and rewrites the WHOLE types object (Firebase's update() replaces a
  // nested object wholesale, it does not deep-merge), using the full,
  // freshly-read settings.types plus the one flipped value, so no other
  // toggle's state is ever touched by this write.
  const toggledType = CALLBACK_TO_TYPE[data];
  if (toggledType) {
    const currentlyEnabled = settings.types?.[toggledType] !== false;
    const newTypes = { ...settings.types, [toggledType]: !currentlyEnabled };
    await updateNotificationSettings(restId, { types: newTypes });
    const refreshed = { ...settings, types: newTypes };
    return { text: getTranslator(lang)("tg_notifications_menu_title"), keyboard: notificationsMenuKeyboard(lang, refreshed) };
  }

  // ── Drill-down expansion (2026) — RBAC / tenant isolation note ──────────
  // This bot is one long-poll loop PER RESTAURANT (see syncPollers() below),
  // gated by allowedChatId before ANY callback reaches this function, and
  // `restId` here is always the value resolveAndLinkChat() already verified
  // against the persisted chatRegistry — never taken from the callback data
  // itself. Every read/write below is therefore scoped under
  // `restaurants/${restId}/...` structurally — an orderId/reservationId/
  // customerId that belongs to a DIFFERENT restaurant simply does not exist
  // at that path and resolves to "not found", it can never be read or acted
  // on through this chat. There is no separate per-callback role check
  // because there is no multi-role user model for this bot (unlike the
  // in-panel RBAC system) — the single configured chat IS "the restaurant
  // admin" for every action taken here, same as the panel's own owner login.
  const m = (re) => data.match(re);
  let mm;

  if ((mm = m(/^tbllist_(free|occupied|reserved|paying)_(\d+)$/))) {
    const [, bucket, pageStr] = mm;
    const { slice, page, totalPages } = paginate(await getTablesByBucket(restId, bucket), pageStr);
    return { text: formatTableListHTML(lang, bucket, slice), keyboard: [...slice.map((t) => [{ text: `№${t.number}`, callback_data: `tbl_${t.number}` }]), ...paginationRow(`tbllist_${bucket}`, page, totalPages), ...navRow(lang, "tables_status")] };
  }
  if ((mm = m(/^tbl_(.+)$/))) {
    const detail = await getTableDetail(restId, mm[1]);
    if (!detail) return null;
    const rows = [];
    if (detail.order) rows.push([{ text: getTranslator(lang)("tg_order_view_btn"), callback_data: `ord_${detail.order.id}` }]);
    return { text: formatTableDetailHTML(lang, detail), keyboard: [...rows, ...navRow(lang, "tables_status")] };
  }
  if ((mm = m(/^ordlist_(new|kitchen|ready|payment|completed)_(\d+)$/))) {
    const [, bucket, pageStr] = mm;
    const { slice, page, totalPages } = paginate(await getOrdersByBucketToday(restId, bucket), pageStr);
    return { text: formatOrderListHTML(lang, bucket, slice), keyboard: [...slice.map((o) => [{ text: `#${o.orderNumber}`, callback_data: `ord_${o.id}` }]), ...paginationRow(`ordlist_${bucket}`, page, totalPages), ...navRow(lang, "orders_status")] };
  }
  if ((mm = m(/^ord_([A-Za-z0-9_-]+)$/))) {
    const order = await getOrderDetail(restId, mm[1]);
    if (!order) return null;
    const t = getTranslator(lang);
    const rows = [];
    // PAID ORDER PROTECTION (spec Part A section 10) — no approve/cancel
    // action is ever offered once an order is paid or already terminal.
    if (!order.paid && order.bucket !== "completed" && order.bucket !== "cancelled") {
      rows.push([{ text: t("tg_order_approve_btn"), callback_data: `orda_${order.id}` }, { text: t("tg_order_cancel_btn"), callback_data: `ordc_${order.id}` }]);
    }
    return { text: formatOrderDetailHTML(lang, order), keyboard: [...rows, ...navRow(lang, "orders_status")] };
  }
  if ((mm = m(/^orda_([A-Za-z0-9_-]+)$/))) {
    const result = await approveOrderViaBot(restId, mm[1]);
    const order = await getOrderDetail(restId, mm[1]);
    const t = getTranslator(lang);
    if (!order) return { text: t("tg_order_action_failed"), keyboard: navRow(lang, "orders_status"), toast: t("tg_order_action_failed") };
    return { text: formatOrderDetailHTML(lang, order), keyboard: navRow(lang, "orders_status"), toast: result.ok ? t("tg_order_action_ok") : t("tg_order_action_failed") };
  }
  if ((mm = m(/^ordc_([A-Za-z0-9_-]+)$/))) {
    // Confirm step before the destructive cancel — mirrors the SuperAdmin
    // bot's block/unblock rbk_/rbkc_ confirm pattern already established.
    const t = getTranslator(lang);
    return { text: `❓ ${t("tg_order_cancel_btn")}?`, keyboard: [[{ text: t("sab_btn_confirm"), callback_data: `ordcc_${mm[1]}` }, { text: t("sab_btn_cancel"), callback_data: `ord_${mm[1]}` }]] };
  }
  if ((mm = m(/^ordcc_([A-Za-z0-9_-]+)$/))) {
    const result = await cancelOrderViaBot(restId, mm[1]);
    const order = await getOrderDetail(restId, mm[1]);
    const t = getTranslator(lang);
    if (!order) return { text: t("tg_order_action_failed"), keyboard: navRow(lang, "orders_status"), toast: t("tg_order_action_failed") };
    return { text: formatOrderDetailHTML(lang, order), keyboard: navRow(lang, "orders_status"), toast: result.ok ? t("tg_order_action_ok") : t("tg_order_action_failed") };
  }
  if ((mm = m(/^resvlist_(today|upcoming)_(\d+)$/))) {
    const [, when, pageStr] = mm;
    const { slice, page, totalPages } = paginate(await getReservationsList(restId, when), pageStr);
    return { text: formatReservationListHTML(lang, when, slice), keyboard: [...slice.map((r) => [{ text: `${r.time} ${r.guestName}`, callback_data: `resvd_${r.id}` }]), ...paginationRow(`resvlist_${when}`, page, totalPages), ...navRow(lang, "resv")] };
  }
  if ((mm = m(/^resvd_([A-Za-z0-9_-]+)$/))) {
    const r = await getReservationDetail(restId, mm[1]);
    if (!r) return null;
    const t = getTranslator(lang);
    const rows = [];
    if (r.bucket === "pending" || r.bucket === "confirmed") {
      rows.push([{ text: t("tg_reservation_confirm_btn"), callback_data: `resvcf_${r.id}` }, { text: t("tg_reservation_cancel_btn"), callback_data: `resvcx_${r.id}` }]);
    }
    return { text: formatReservationDetailHTML(lang, r), keyboard: [...rows, ...navRow(lang, "resv")] };
  }
  if ((mm = m(/^resvcf_([A-Za-z0-9_-]+)$/))) {
    const result = await confirmReservationViaBot(restId, mm[1]);
    const r = await getReservationDetail(restId, mm[1]);
    const t = getTranslator(lang);
    if (!r) return { text: t("tg_order_action_failed"), keyboard: navRow(lang, "resv"), toast: t("tg_order_action_failed") };
    return { text: formatReservationDetailHTML(lang, r), keyboard: navRow(lang, "resv"), toast: result.ok ? t("tg_order_action_ok") : t("tg_order_action_failed") };
  }
  if ((mm = m(/^resvcx_([A-Za-z0-9_-]+)$/))) {
    const t = getTranslator(lang);
    return { text: `❓ ${t("tg_reservation_cancel_btn")}?`, keyboard: [[{ text: t("sab_btn_confirm"), callback_data: `resvcxc_${mm[1]}` }, { text: t("sab_btn_cancel"), callback_data: `resvd_${mm[1]}` }]] };
  }
  if ((mm = m(/^resvcxc_([A-Za-z0-9_-]+)$/))) {
    const result = await cancelReservationViaBot(restId, mm[1]);
    const r = await getReservationDetail(restId, mm[1]);
    const t = getTranslator(lang);
    if (!r) return { text: t("tg_order_action_failed"), keyboard: navRow(lang, "resv"), toast: t("tg_order_action_failed") };
    return { text: formatReservationDetailHTML(lang, r), keyboard: navRow(lang, "resv"), toast: result.ok ? t("tg_order_action_ok") : t("tg_order_action_failed") };
  }
  if ((mm = m(/^custlist_(new|active|discounted)_(\d+)$/))) {
    const [, bucket, pageStr] = mm;
    const { slice, page, totalPages } = paginate(await getCustomersList(restId, bucket), pageStr);
    return { text: formatCustomerListHTML(lang, bucket, slice), keyboard: [...slice.map((c) => [{ text: c.name, callback_data: `custd_${c.id}` }]), ...paginationRow(`custlist_${bucket}`, page, totalPages), ...navRow(lang, "cust")] };
  }
  if ((mm = m(/^custd_([A-Za-z0-9_-]+)$/))) {
    const c = await getCustomerDetail(restId, mm[1]);
    if (!c) return null;
    return { text: formatCustomerDetailHTML(lang, c), keyboard: navRow(lang, "cust") };
  }
  if ((mm = m(/^emprole_([A-Za-z0-9_-]+)_(\d+)$/))) {
    const [, role, pageStr] = mm;
    const { slice, page, totalPages } = paginate(await getEmployeesList(restId, role), pageStr);
    return { text: formatEmployeeRoleListHTML(lang, role, slice), keyboard: [...slice.map((e) => [{ text: e.name, callback_data: `empd_${e.id}` }]), ...paginationRow(`emprole_${role}`, page, totalPages), ...navRow(lang, "employees_status")] };
  }
  if ((mm = m(/^empd_([A-Za-z0-9_-]+)$/))) {
    const e = await getEmployeeDetail(restId, mm[1]);
    if (!e) return null;
    return { text: formatEmployeeDetailHTML(lang, e), keyboard: navRow(lang, "employees_status") };
  }

  switch (data) {
    case "report_today": {
      const { from, to } = dayRange();
      const report = await generateDailyReportData(restId, from, to);
      appendNotificationLog(restId, { type: "daily_report", source: "manual", ok: true, textPreview: "report_today (dashboard button)" }).catch(() => {});
      return { text: formatReportTodayHTML(lang, report, restaurantName), keyboard: dashboardKeyboard(lang) };
    }
    case "warehouse_status":
      return { text: formatWarehouseStatusHTML(lang, await getWarehouseStatus(restId)), keyboard: dashboardKeyboard(lang) };
    case "employees_status": {
      const [summary, allEmployees] = await Promise.all([getEmployeesSummaryToday(restId), getEmployeesList(restId, null)]);
      const roles = [...new Set(allEmployees.map((e) => e.role).filter(Boolean))];
      appendNotificationLog(restId, { type: "employee_report", source: "manual", ok: true, textPreview: "employees_status (dashboard button)" }).catch(() => {});
      return {
        text: formatEmployeesListHTML(lang, summary),
        keyboard: [...roles.map((role) => [{ text: role, callback_data: `emprole_${role}_1` }]), ...dashboardKeyboard(lang)],
      };
    }
    case "process": {
      const data2 = await getRestaurantProcessToday(restId);
      appendNotificationLog(restId, { type: "process_report", source: "manual", ok: true, textPreview: "process (dashboard button)" }).catch(() => {});
      const t = getTranslator(lang);
      return {
        text: formatProcessViewHTML(lang, data2),
        keyboard: [
          [{ text: t("btn_tables"), callback_data: "tables_status" }, { text: t("btn_orders"), callback_data: "orders_status" }],
          [{ text: t("btn_kitchen"), callback_data: "kitchen_status" }, { text: t("btn_delivery"), callback_data: "delivery_status" }],
          [{ text: t("btn_reservations"), callback_data: "resv" }],
          ...navRow(lang, null),
        ],
      };
    }
    case "tables_status": {
      const counts = await getTablesStatusToday(restId);
      const t = getTranslator(lang);
      return {
        text: formatTablesStatusHTML(lang, counts),
        keyboard: [
          [{ text: `${t("tg_table_bucket_free")} (${counts.free})`, callback_data: "tbllist_free_1" }, { text: `${t("tg_table_bucket_occupied")} (${counts.occupied})`, callback_data: "tbllist_occupied_1" }],
          [{ text: `${t("tg_table_bucket_reserved")} (${counts.reserved})`, callback_data: "tbllist_reserved_1" }, { text: `${t("tg_table_bucket_paying")} (${counts.paying})`, callback_data: "tbllist_paying_1" }],
          ...navRow(lang, null),
        ],
      };
    }
    case "resv": {
      const counts = await getReservationsStatusToday(restId);
      const t = getTranslator(lang);
      return {
        text: formatReservationsStatusHTML(lang, counts),
        keyboard: [[{ text: t("tg_btn_today"), callback_data: "resvlist_today_1" }, { text: t("tg_btn_upcoming"), callback_data: "resvlist_upcoming_1" }], ...navRow(lang, null)],
      };
    }
    case "cust": {
      const counts = await getCustomersStatusToday(restId);
      const t = getTranslator(lang);
      return {
        text: formatCustomersStatusHTML(lang, counts),
        keyboard: [
          [{ text: t("notif_new_customers_label"), callback_data: "custlist_new_1" }, { text: t("notif_returning_customers_label"), callback_data: "custlist_active_1" }],
          [{ text: t("tg_customers_discounted_label"), callback_data: "custlist_discounted_1" }],
          ...navRow(lang, null),
        ],
      };
    }
    case "finance_today":
      return { text: formatFinanceStatusHTML(lang, await getFinanceStatusToday(restId)), keyboard: dashboardKeyboard(lang) };
    case "orders_status": {
      const pipeline = await getOrdersBucketsToday(restId);
      const t = getTranslator(lang);
      return {
        text: formatOrdersPipelineHTML(lang, pipeline),
        keyboard: [
          [{ text: `${t("tg_orders_bucket_new")} (${pipeline.new})`, callback_data: "ordlist_new_1" }, { text: `${t("tg_orders_bucket_kitchen")} (${pipeline.kitchen})`, callback_data: "ordlist_kitchen_1" }],
          [{ text: `${t("tg_orders_bucket_ready")} (${pipeline.ready})`, callback_data: "ordlist_ready_1" }, { text: `${t("tg_orders_bucket_payment")} (${pipeline.payment})`, callback_data: "ordlist_payment_1" }],
          [{ text: `${t("tg_orders_bucket_completed")} (${pipeline.completed})`, callback_data: "ordlist_completed_1" }],
          ...navRow(lang, null),
        ],
      };
    }
      return { text: formatOrdersStatusHTML(lang, await getOrdersStatusToday(restId)), keyboard: dashboardKeyboard(lang) };
    case "kitchen_status":
      return { text: formatKitchenStatusHTML(lang, await getKitchenStatusToday(restId)), keyboard: dashboardKeyboard(lang) };
    case "delivery_status":
      return { text: formatDeliveryStatusHTML(lang, await getDeliveryStatusToday(restId)), keyboard: dashboardKeyboard(lang) };
    // "settings_status"/"lang_menu" are the original callback names kept
    // working exactly as before; "settings"/"language" are the names this
    // task's spec calls for — both point at the same views so neither an
    // already-displayed old keyboard nor a freshly-drawn new one can break.
    case "settings_status":
    case "settings":
    case "back": // one level up from the notifications toggle menu
      return { text: formatSettingsStatusHTML(lang, settings), keyboard: settingsKeyboard(lang) };
    case "lang_menu":
    case "language":
      return { text: getTranslator(lang)("lang_menu_prompt"), keyboard: languageKeyboard(lang) };
    case "notifications":
      return { text: getTranslator(lang)("tg_notifications_menu_title"), keyboard: notificationsMenuKeyboard(lang, settings) };
    case "refresh_dashboard":
      return { text: formatDashboardWelcome(lang, restaurantName), keyboard: dashboardKeyboard(lang) };
    default:
      return null;
  }
}

async function handleUpdate(restId, botToken, allowedChatId, update) {
  if (update.message?.text) {
    const chatId = update.message.chat.id;
    const text = update.message.text.trim();

    // Access control: only the chat_id the restaurant itself configured in
    // Settings → Notifications may use the control panel. Without this, any
    // stranger who finds the bot on Telegram and sends /start would see the
    // restaurant's live revenue/orders/employee data.
    if (allowedChatId && String(chatId) !== String(allowedChatId)) {
      console.warn(`[Telegram] Ignored /start-type message from unauthorized chatId=${chatId} (restId="${restId}", expected chatId="${allowedChatId}")`);
      return;
    }

    if (text === "/start") {
      console.log(`[Telegram] Received command: /start (restId="${restId}", chatId=${chatId})`);
      const settings = await getNotificationSettings(restId);

      // Multi-tenant resolve-before-load gate (telegram/chats/<chatId> ->
      // restId). The restId above is already known to be correct (it's the
      // specific per-restaurant poller that received this update, and each
      // poller only ever polls its OWN bot token), but this is verified
      // against the persisted registry anyway rather than trusted blindly —
      // see chatRegistry.js for exactly what this catches.
      const resolvedRestId = await resolveAndLinkChat(chatId, restId, settings.language);
      if (!resolvedRestId) return; // dropped — see [ChatRegistry] security log

      const restaurantName = await getRestaurantName(resolvedRestId);
      console.log("[Telegram] Generating report...");
      const welcome = formatDashboardWelcome(settings.language, restaurantName);
      console.log("[Telegram] Sending...");
      await sendInlineKeyboard(botToken, chatId, welcome, dashboardKeyboard(settings.language));
      console.log("[Telegram] Done");
    }
    return;
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;

    if (allowedChatId && String(chatId) !== String(allowedChatId)) {
      console.warn(`[Telegram] Ignored callback from unauthorized chatId=${chatId} (restId="${restId}")`);
      await answerCallbackQuery(botToken, cq.id).catch(() => {});
      return;
    }

    console.log(`[Telegram] Received callback: ${cq.data} (restId="${restId}", chatId=${chatId})`);
    // Always a fresh Firebase read — a language change from a previous
    // callback (or from the Admin Panel itself) is picked up immediately,
    // no restart, no cache.
    const settings = await getNotificationSettings(restId);

    // Same resolve-before-load gate as /start above — every callback must
    // pass this before any restaurant data is touched.
    const resolvedRestId = await resolveAndLinkChat(chatId, restId, settings.language);
    if (!resolvedRestId) {
      await answerCallbackQuery(botToken, cq.id).catch(() => {});
      return; // dropped — see [ChatRegistry] security log
    }

    const restaurantName = await getRestaurantName(resolvedRestId);

    console.log("[Telegram] Generating report...");
    let result;
    try {
      result = await buildCallbackContent(resolvedRestId, settings, restaurantName, cq.data);
    } catch (err) {
      console.error(`[Telegram] callback content error for "${cq.data}":`, err.message);
      result = null;
    }
    const text = result?.text || `❌ Unknown action: ${cq.data}`;
    const keyboard = result?.keyboard || dashboardKeyboard(settings.language);

    console.log("[Telegram] Sending...");
    await answerCallbackQuery(botToken, cq.id).catch(() => {});
    // Refresh (and every other dashboard button) edits the SAME message in
    // place rather than sending a new one each time — spec section 8.
    if (cq.message?.message_id) {
      await editMessage(botToken, chatId, cq.message.message_id, text, { inline_keyboard: keyboard });
    }
    console.log("[Telegram] Done");
  }
}

// ── Per-restaurant long-poll loops ──────────────────────────────────────────
const _pollers = new Map(); // restId -> { botToken, chatId, stopped }

async function pollLoop(restId, state) {
  let offset = 0;
  console.log(`[Telegram] Poller started for restId="${restId}"`);

  // Defensive: getUpdates (polling) and a webhook cannot both be active on
  // the same bot token. If one was ever set (e.g. by another integration or
  // a prior manual test), clear it so polling actually receives updates.
  await callApi(state.botToken, "deleteWebhook", {}).catch(() => {});

  while (!state.stopped) {
    const resp = await callApi(state.botToken, "getUpdates", { offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ["message", "callback_query"] });

    if (state.stopped) break;

    if (!resp.ok) {
      // Automatic reconnect after network failures / transient Telegram
      // errors — never let one failed poll kill the loop permanently.
      console.error(`[Telegram] getUpdates failed for restId="${restId}": ${resp.description || "unknown error"} — retrying in 5s`);
      await sleep(5000);
      continue;
    }

    for (const update of resp.result || []) {
      offset = update.update_id + 1;
      handleUpdate(restId, state.botToken, state.chatId, update).catch((err) =>
        console.error(`[Telegram] handleUpdate error (restId="${restId}"):`, err.message)
      );
    }
  }

  console.log(`[Telegram] Poller stopped for restId="${restId}"`);
}

async function syncPollers() {
  const restIds = await listRestaurantIds();
  const wanted = new Map();

  for (const restId of restIds) {
    const settings = await getNotificationSettings(restId);
    if (settings.telegram?.enabled && settings.telegram?.botToken) {
      wanted.set(restId, { botToken: settings.telegram.botToken, chatId: settings.telegram.chatId });
    }
  }

  // Multi-tenant safety: this is the ONE way two restaurants' data could
  // actually mix — an admin pasting the same bot token into two different
  // restaurants' settings. Two independent long-poll loops on the same
  // token would race for Telegram's getUpdates, each potentially processing
  // a message meant to be scoped to the OTHER restaurant. Detect it and run
  // neither poller for that token rather than guess which one is "right".
  const restaurantsByToken = new Map();
  for (const [restId, w] of wanted.entries()) {
    if (!restaurantsByToken.has(w.botToken)) restaurantsByToken.set(w.botToken, []);
    restaurantsByToken.get(w.botToken).push(restId);
  }
  for (const [token, ids] of restaurantsByToken.entries()) {
    if (ids.length > 1) {
      console.error(
        `[Telegram] 🚨 SECURITY: bot token ${token.slice(0, 8)}… is configured on ${ids.length} restaurants ` +
        `[${ids.join(", ")}] — refusing to poll for any of them until this is fixed (one bot token must belong to exactly one restaurant).`
      );
      ids.forEach((restId) => wanted.delete(restId));
    }
  }

  // Stop pollers for restaurants that turned Telegram off, or changed their
  // bot token (old token's loop must not keep running against a dead bot).
  for (const [restId, state] of _pollers.entries()) {
    const w = wanted.get(restId);
    if (!w || w.botToken !== state.botToken) {
      state.stopped = true;
      _pollers.delete(restId);
    }
  }

  // Start pollers for newly-enabled restaurants.
  for (const [restId, w] of wanted.entries()) {
    if (!_pollers.has(restId)) {
      const state = { botToken: w.botToken, chatId: w.chatId, stopped: false };
      _pollers.set(restId, state);
      pollLoop(restId, state).catch((err) => console.error(`[Telegram] poller crashed for restId="${restId}":`, err.message));
    } else {
      // chatId can change without a token change — keep it current so the
      // access-control check above always compares against the latest value.
      _pollers.get(restId).chatId = w.chatId;
    }
  }
}

let _syncTimer = null;

/** Call once from server.js, alongside startScheduler()/startDbMonitor(). */
export function startPolling() {
  if (_syncTimer) return; // idempotent
  console.log("🤖 Telegram Control Panel — polling manager started.");
  syncPollers().catch((err) => console.error("[Telegram] initial poller sync error:", err.message));
  _syncTimer = setInterval(() => syncPollers().catch((err) => console.error("[Telegram] poller sync error:", err.message)), SYNC_INTERVAL_MS);
}

export function stopPolling() {
  if (_syncTimer) clearInterval(_syncTimer);
  _syncTimer = null;
  for (const state of _pollers.values()) state.stopped = true;
  _pollers.clear();
}

export const TelegramBotService = { startPolling, stopPolling, sendMessage, editMessage, sendInlineKeyboard, answerCallbackQuery };
export default TelegramBotService;
