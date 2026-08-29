// notifications/SuperAdminBotService.js — a SEPARATE, global Telegram bot for
// the platform's superadmin, distinct from TelegramBotService.js (which runs
// one bot PER RESTAURANT and only ever shows that restaurant's own
// read-mostly dashboard). This bot is single/global (one token for the whole
// platform, not one per restaurant) and can WRITE — create a restaurant,
// block/unblock one, extend a license — because the person on the other end
// is meant to be the actual platform owner, not a restaurant employee.
//
// Reuses TelegramBotService.js's outbound helpers (sendMessage/editMessage/
// sendInlineKeyboard/answerCallbackQuery — all already generic, no restId
// baked in) rather than re-implementing the Telegram HTTP call. Only the
// long-poll loop itself (getUpdates/deleteWebhook) is written here, since
// that file's poller is keyed to a specific restaurant's settings, which
// doesn't fit this bot's single global-config shape.
//
// Configuration lives at systemData/settings/superadminBot (botToken,
// enabled, allowedTelegramIds) — the exact same "settings in Firebase,
// managed from the panel, read via systemGet/systemSet" pattern
// routes/superadminSettings.js already established for tariffs/
// subscriptionPlans/paymentApi. See routes/superadminBot.js for the panel-
// facing settings API (token masking, allowlist editing, test message).
//
// Access control: allowedTelegramIds is a numeric Telegram user/chat ID
// allowlist (the superadmin finds their own ID via any "what's my id" bot,
// e.g. @userinfobot, and enters it in the panel). Fail-closed by design — an
// empty allowlist or missing/disabled token means the poller does not even
// start (see syncPoller() below), and any update from a chat ID not on the
// list is logged and silently dropped, same posture as
// TelegramBotService.js's own allowedChatId check.
//
// Every write this file performs (create restaurant, block/unblock, extend
// license) is a direct port of the EXACT same Firebase writes the panel's
// own superadmin.js already does for that action (saveNewRestaurant(),
// toggleBlockRestaurant(), the license-duration flow) — same paths, same
// field names, same restaurants_meta mirror, same payment-history/audit-log
// entries — so a restaurant created or changed from the bot is
// indistinguishable in the panel from one created/changed by hand, and
// nothing about the existing schema was redesigned for this feature.
import crypto from "crypto";
import { isAdminAvailable, getAdminDb } from "../firebaseAdmin.js";
import { isMaintenanceMode } from "../security/maintenance.js";
import { systemGet, systemSet, systemPush, systemQueryOrderedLimit } from "../systemDb.js";
import { sha256Hex, encryptSecret } from "../security/crypto.js";
import { getTranslator } from "./locales/index.js";
import {
  sendMessage, editMessage, sendInlineKeyboard, answerCallbackQuery,
} from "./TelegramBotService.js";

const TELEGRAM_API = "https://api.telegram.org/bot";
const SYNC_INTERVAL_MS = 30 * 1000;
const POLL_TIMEOUT_SEC = 25;
const LIST_PAGE_SIZE = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

// ── Business logic — mirrors admin-frontend/public/js/superadmin.js ───────
// The panel's own restaurant-creation form (saveNewRestaurant()) hardcodes
// businessType="restaurant" and tariff="pro" unconditionally — it never
// offers a choice of either — so this bot does the same in v1 rather than
// inventing a picker the panel itself doesn't have.
const RESTAURANT_MODULES = {
  pos: true, qr_menu: true, kitchen: true, waiter: true, tables: true,
  inventory: true, crm: true, reservations: true, purchase: true,
  suppliers: false, reports: true, finance: true, loyalty: false,
  delivery: true, accounting: false, take_away: true, split_bill: false,
  production: false,
};

async function loadSubscriptionPlans() {
  const snap = await systemGet("systemData/settings/subscriptionPlans");
  return snap.exists() ? snap.val() || {} : {};
}

async function loadTariffs() {
  const snap = await systemGet("systemData/settings/tariffs");
  return snap.exists() ? snap.val() || {} : {};
}

// `licenseCode` is "1"|"3"|"6"|"12"|"lifetime". `fromTs` is the timestamp the
// duration is added to — "now" for a brand-new restaurant, or the current
// (still-valid) expiry for an extension, exactly like the panel's own
// saveNewRestaurant()/confirmLicenseDuration() pick their base timestamp.
function computeLicense(plans, licenseCode, fromTs) {
  const isLifetime = licenseCode === "lifetime";
  let expireAt;
  if (isLifetime) {
    expireAt = 9999999999999;
  } else {
    const d = new Date(fromTs);
    d.setMonth(d.getMonth() + Number(licenseCode));
    expireAt = d.getTime();
  }
  const basePrice = Number(plans[1]?.price || 0);
  let amount;
  if (isLifetime) {
    amount = basePrice * Number(plans.lifetime?.coefficient || 12);
  } else {
    const m = Number(licenseCode);
    const disc = m === 1 ? 0 : Number(plans[m]?.discount || 0);
    amount = basePrice * m * (1 - disc / 100);
  }
  amount = Math.round(amount);
  const periodCode = isLifetime ? "lifetime" : ({ 1: "1m", 3: "3m", 6: "6m", 12: "1y" }[Number(licenseCode)] || "1m");
  return { isLifetime, expireAt, amount, periodCode };
}

async function checkUniqueness({ name, domain, adminLogin }) {
  const db = getAdminDb();
  const snap = await db.ref("restaurants").once("value");
  const list = Object.values(snap.val() || {});
  return {
    nameTaken: name != null && list.some((r) => (r.info?.name || "").toLowerCase() === name.toLowerCase()),
    domainTaken: domain != null && list.some((r) => (r.info?.domain || "").toLowerCase() === domain.toLowerCase()),
    loginTaken: adminLogin != null && list.some((r) => (r.users?.admin_1?.login || "").toLowerCase() === adminLogin.toLowerCase()),
  };
}

async function computeStats() {
  const db = getAdminDb();
  const snap = await db.ref("restaurants").once("value");
  const tree = snap.val() || {};
  const now = Date.now();
  let total = 0, active = 0, blocked = 0, expired = 0;
  for (const rest of Object.values(tree)) {
    total++;
    const info = rest?.info || {};
    const sub = rest?.subscription || {};
    const isBlocked = info.status === "blocked";
    const expireAt = Number(sub.expireAt || 0);
    if (isBlocked) blocked++;
    else if (expireAt > now) active++;
    else expired++;
  }

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const phSnap = await systemGet("systemData/paymentHistory");
  const ph = phSnap.exists() ? phSnap.val() || {} : {};
  let revenueMonth = 0;
  for (const rec of Object.values(ph)) {
    if (Number(rec?.date || 0) >= startOfMonth.getTime()) revenueMonth += Number(rec?.amount || 0);
  }
  return { total, active, blocked, expired, revenueMonth };
}

async function createRestaurantFromWizard(data, actorLabel) {
  const db = getAdminDb();
  const now = Date.now();
  const restId = "rest_" + now;

  const plans = await loadSubscriptionPlans();
  const tariffs = await loadTariffs();
  const selectedPlanName = tariffs?.pro?.name || "PRO";
  const planFeatures = tariffs?.pro?.features || [];
  const { isLifetime, expireAt, amount, periodCode } = computeLicense(plans, data.licenseCode, now);

  const commonData = {
    info: {
      name: data.name,
      domain: data.domain,
      tariff: "pro",
      businessType: "restaurant",
      phone: data.phone || "",
      email: data.email || "",
      address: data.address || "",
      status: "active",
      createdAt: now,
    },
    subscription: {
      plan: selectedPlanName,
      planId: "pro",
      status: "active",
      expireAt,
      expireDate: expireAt,
      lastPaymentDate: now,
      lastPaymentMethod: "manual",
      activatedBy: actorLabel,
      licenseStartedAt: now,
      lastLicensePeriodCode: periodCode,
      features: planFeatures,
      oneTimePaid: isLifetime,
    },
    modules: RESTAURANT_MODULES,
  };

  await Promise.all([
    db.ref(`restaurants/${restId}`).set(commonData),
    db.ref(`restaurants_meta/${restId}`).set(commonData),
  ]);

  // Same two-field password convention as saveNewRestaurant(): `password` is
  // the SHA-256 hex hash routes/auth.js's login already accepts (matches
  // window.hashPassword() exactly — sha256Hex() below is the identical
  // algorithm, just server-side); `passwordEnc` is the reversible copy the
  // "Restoran login ma'lumotlari" modal reveals later. passwordEnc is
  // best-effort (requires ENCRYPTION_KEY) — its absence must never block
  // restaurant creation, same as the panel's own behavior.
  const credUpdate = { password: sha256Hex(data.adminPass) };
  try {
    credUpdate.passwordEnc = encryptSecret(data.adminPass);
  } catch (err) {
    console.warn("[SuperAdminBot] passwordEnc not stored (ENCRYPTION_KEY missing?):", err.message);
  }
  await db.ref(`credentials/${restId}/admin_1`).set(credUpdate);
  await db.ref(`restaurants/${restId}/users/admin_1`).set({
    name: "Asosiy Boshqaruvchi",
    login: data.adminLogin,
    role: "admin",
    active: true,
    createdAt: now,
  });

  await systemPush("systemData/paymentHistory", {
    restaurantName: data.name,
    restaurantId: restId,
    amount,
    method: "🆕 Yangi restoran (Telegram bot)",
    months: isLifetime ? 0 : Number(data.licenseCode),
    trialDays: 0,
    oneTimeFee: 0,
    promoCode: null,
    promoDiscount: 0,
    newTariff: selectedPlanName,
    date: now,
  });
  await systemPush("systemData/auditLogs", {
    action: "new_restaurant",
    restName: data.name,
    details: "Yangi restoran yaratildi (Telegram bot orqali)",
    actor: actorLabel,
    timestamp: now,
    ip: null,
    device: "telegram-bot",
  });

  return { restId, expireAt, isLifetime };
}

async function toggleBlock(restId, block, actorLabel) {
  const db = getAdminDb();
  const updates = { "info/status": block ? "blocked" : "active", "info/updatedAt": Date.now() };
  await Promise.all([
    db.ref(`restaurants/${restId}`).update(updates),
    db.ref(`restaurants_meta/${restId}`).update(updates),
  ]);
  const nameSnap = await db.ref(`restaurants/${restId}/info/name`).once("value");
  await systemPush("systemData/auditLogs", {
    action: block ? "block" : "unblock",
    restName: nameSnap.val() || restId,
    details: block ? "Restoran bloklandi (Telegram bot orqali)" : "Restoran blokdan chiqarildi (Telegram bot orqali)",
    actor: actorLabel,
    timestamp: Date.now(),
    ip: null,
    device: "telegram-bot",
  });
}

// `code` is "1"|"3"|"6"|"12"|"lifetime" — extends from the CURRENT expiry if
// it's still in the future, otherwise from now, same rule the panel's own
// license-duration modal uses for "Uzaytirish" mode.
async function extendLicense(restId, code, actorLabel) {
  const db = getAdminDb();
  const now = Date.now();
  const restSnap = await db.ref(`restaurants/${restId}`).once("value");
  const rest = restSnap.val() || {};
  const sub = rest.subscription || {};
  const currentExpireAt = Number(sub.expireAt || 0);
  const base = currentExpireAt > now ? currentExpireAt : now;

  const plans = await loadSubscriptionPlans();
  const { isLifetime, expireAt, amount, periodCode } = computeLicense(plans, code, base);

  const updates = {
    "subscription/expireAt": expireAt,
    "subscription/expireDate": expireAt,
    "subscription/oneTimePaid": isLifetime,
    "subscription/lastLicensePeriodCode": periodCode,
    "subscription/updatedAt": now,
    "subscription/activatedBy": actorLabel,
    "info/updatedAt": now,
  };
  // Extending a license is also how the panel lets an admin "un-block" a
  // restaurant that only lapsed on payment (not a manual block) — matches
  // "grant" mode's own info/status reset in confirmLicenseDuration().
  if (rest.info?.status === "blocked") updates["info/status"] = "active";

  await Promise.all([
    db.ref(`restaurants/${restId}`).update(updates),
    db.ref(`restaurants_meta/${restId}`).update(updates),
  ]);

  await systemPush("systemData/paymentHistory", {
    restaurantName: rest.info?.name || restId,
    restaurantId: restId,
    amount,
    method: "⏳ Litsenziya uzaytirildi (Telegram bot)",
    months: isLifetime ? 0 : Number(code),
    trialDays: 0,
    oneTimeFee: 0,
    promoCode: null,
    promoDiscount: 0,
    newTariff: rest.subscription?.plan || "PRO",
    date: now,
  });
  await systemPush("systemData/auditLogs", {
    action: "extend_license",
    restName: rest.info?.name || restId,
    details: `Litsenziya uzaytirildi (Telegram bot orqali) — ${periodCode}`,
    actor: actorLabel,
    timestamp: now,
    ip: null,
    device: "telegram-bot",
  });

  return { expireAt, isLifetime };
}

// Mirrors saveEditedRestaurant() (superadmin.js) exactly: a PARTIAL update()
// on restaurants/{restId}/info — only the keys present in `fields` are
// touched, everything else (businessType, owner, licenseStatus, ...) is left
// exactly as it was. No restaurants_meta write here — saveEditedRestaurant()
// deliberately dropped that mirror (see its own comment: restaurants_meta
// has no reader anywhere in the app for the info subtree), so this doesn't
// reintroduce it. Only checks domain uniqueness (excluding this restaurant
// itself) — matches the panel, which does not re-check name uniqueness on
// edit (only on create).
async function updateRestaurantInfo(restId, fields, actorLabel) {
  const db = getAdminDb();
  const now = Date.now();
  const updates = { ...fields, updatedAt: now };
  await db.ref(`restaurants/${restId}/info`).update(updates);
  if (fields.name) {
    await db.ref(`restaurants/${restId}/settings`).update({ restaurantName: fields.name });
  }
  const nameSnap = await db.ref(`restaurants/${restId}/info/name`).once("value");
  await systemPush("systemData/auditLogs", {
    action: "edit",
    restName: nameSnap.val() || restId,
    details: `Ma'lumotlar tahrirlandi (Telegram bot orqali): ${Object.keys(fields).join(", ")}`,
    actor: actorLabel,
    timestamp: now,
    ip: null,
    device: "telegram-bot",
  });
}

async function isDomainTakenExcluding(domain, excludeRestId) {
  const db = getAdminDb();
  const snap = await db.ref("restaurants").once("value");
  return Object.entries(snap.val() || {}).some(
    ([id, r]) => id !== excludeRestId && (r.info?.domain || "").toLowerCase() === domain.toLowerCase()
  );
}

const ALL_MODULE_IDS = [
  "pos", "qr_menu", "kitchen", "waiter", "tables", "inventory", "crm", "reservations",
  "purchase", "suppliers", "reports", "finance", "loyalty", "delivery", "accounting",
  "take_away", "split_bill", "production",
];

// Mirrors saveModulesForRestaurant() exactly: full overwrite of the modules
// object on BOTH restaurants/{id} and restaurants_meta/{id} (that function
// DOES mirror to restaurants_meta, unlike updateRestaurantInfo() above —
// each write here matches its own source function, not a blanket rule).
async function updateRestaurantModules(restId, modules, actorLabel) {
  const db = getAdminDb();
  await Promise.all([
    db.ref(`restaurants/${restId}/modules`).update(modules),
    db.ref(`restaurants_meta/${restId}/modules`).update(modules),
  ]);
  const nameSnap = await db.ref(`restaurants/${restId}/info/name`).once("value");
  const enabledList = Object.entries(modules).filter(([, v]) => v).map(([k]) => k).join(", ");
  await systemPush("systemData/auditLogs", {
    action: "modules_update",
    restName: nameSnap.val() || restId,
    details: `Modullar yangilandi (Telegram bot orqali): ${enabledList}`,
    actor: actorLabel,
    timestamp: Date.now(),
    ip: null,
    device: "telegram-bot",
  });
}

const TARIFF_IDS = ["start", "pro", "premium"];

// Mirrors applyBonus(type:"upgrade") exactly: only restaurants/{id} is
// touched (that flow never mirrors to restaurants_meta either).
async function changeTariff(restId, newTariff, actorLabel) {
  const db = getAdminDb();
  const now = Date.now();
  const updates = {
    "info/tariff": newTariff,
    "info/updatedAt": now,
    "bonus/upgradedAt": now,
    "bonus/upgradeNote": `SuperAdmin (Telegram): ${newTariff.toUpperCase()}`,
  };
  await db.ref(`restaurants/${restId}`).update(updates);
  const nameSnap = await db.ref(`restaurants/${restId}/info/name`).once("value");
  await systemPush("systemData/auditLogs", {
    action: "tariff_change",
    restName: nameSnap.val() || restId,
    details: `Tarif ${newTariff.toUpperCase()}ga o'zgartirildi (Telegram bot orqali)`,
    actor: actorLabel,
    timestamp: now,
    ip: null,
    device: "telegram-bot",
  });
}

// Read-only views over the same two systemData trees the panel's
// "To'lovlar tarixi"/"Faoliyat jurnali" tables already show (routes/
// superadminDashboard.js) — most-recent-first, capped to a short list since
// Telegram messages have a length limit and this is a quick-glance view,
// not a replacement for the panel's filterable table.
async function getRecentPaymentHistory(limit) {
  const snap = await systemQueryOrderedLimit("systemData/paymentHistory", "date", 200);
  const list = Object.values(snap.exists() ? snap.val() || {} : {});
  return list.sort((a, b) => Number(b?.date || 0) - Number(a?.date || 0)).slice(0, limit);
}

async function getRecentAuditLog(limit) {
  const snap = await systemQueryOrderedLimit("systemData/auditLogs", "timestamp", 200);
  const list = Object.values(snap.exists() ? snap.val() || {} : {});
  return list.sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0)).slice(0, limit);
}

// Only price/discount/coefficient numbers are bot-editable — the per-
// duration `active` on/off flags (superadmin.html's "Faol" checkboxes) are
// preserved exactly as they already are, never touched here. Same
// systemData/settings/subscriptionPlans path saveDiscountSettings() (the
// panel's own save button) writes to.
async function updateSubscriptionPlansPricing(fields, actorLabel) {
  const existing = await loadSubscriptionPlans();
  const newPlans = {
    ...existing,
    1: { ...(existing[1] || {}), price: fields.price1 },
    3: { ...(existing[3] || {}), discount: fields.disc3 },
    6: { ...(existing[6] || {}), discount: fields.disc6 },
    12: { ...(existing[12] || {}), discount: fields.disc12 },
    lifetime: { ...(existing.lifetime || {}), coefficient: fields.coefLifetime },
  };
  await systemSet("systemData/settings/subscriptionPlans", newPlans);
  await systemPush("systemData/auditLogs", {
    action: "settings_change",
    restName: null,
    details: "Litsenziya narxlari o'zgartirildi (Telegram bot orqali)",
    actor: actorLabel,
    timestamp: Date.now(),
    ip: null,
    device: "telegram-bot",
  });
}

// ── Keyboards / views ───────────────────────────────────────────────────────
function mainMenuKeyboard(t) {
  return [
    [{ text: t("sab_btn_add_restaurant"), callback_data: "wiz_start" }],
    [{ text: t("sab_btn_list_restaurants"), callback_data: "list_0" }, { text: t("sab_btn_stats"), callback_data: "stats" }],
    [{ text: t("sab_btn_payments"), callback_data: "payments" }, { text: t("sab_btn_audit"), callback_data: "audit" }],
    [{ text: t("sab_btn_pricing"), callback_data: "pricing" }],
    [{ text: t("sab_btn_language"), callback_data: "lang" }],
  ];
}

function languageKeyboard(t) {
  return [
    [{ text: "🇺🇿 O'zbekcha", callback_data: "lang_uz" }],
    [{ text: "🇷🇺 Русский", callback_data: "lang_ru" }],
    [{ text: "🇬🇧 English", callback_data: "lang_en" }],
    [{ text: t("sab_btn_back_menu"), callback_data: "menu" }],
  ];
}

// callback_data has a 64-byte Telegram limit — every restId in this app is
// "rest_" + a millisecond timestamp (verified against live data), so the
// timestamp alone is already globally unique; callbacks carry just that,
// and "rest_" is re-prepended wherever a real restId is needed.
function tsOf(restId) {
  return restId.replace(/^rest_/, "");
}

function buildRestaurantListView(t, allRestaurants, page) {
  const entries = Object.entries(allRestaurants)
    .sort((a, b) => Number(b[1]?.info?.createdAt || 0) - Number(a[1]?.info?.createdAt || 0));

  if (entries.length === 0) {
    return { text: t("sab_list_empty"), keyboard: [[{ text: t("sab_btn_back_menu"), callback_data: "menu" }]] };
  }

  const totalPages = Math.max(1, Math.ceil(entries.length / LIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = entries.slice(safePage * LIST_PAGE_SIZE, safePage * LIST_PAGE_SIZE + LIST_PAGE_SIZE);

  const rows = slice.map(([restId, rest]) => {
    const info = rest?.info || {};
    const sub = rest?.subscription || {};
    const isBlocked = info.status === "blocked";
    const isActive = !isBlocked && Number(sub.expireAt || 0) > Date.now();
    const dot = isBlocked ? "🔴" : (isActive ? "🟢" : "🟠");
    return [{ text: `${dot} ${info.name || restId}`, callback_data: `rv_${tsOf(restId)}` }];
  });

  const navRow = [];
  if (safePage > 0) navRow.push({ text: t("sab_btn_prev_page"), callback_data: `list_${safePage - 1}` });
  if (safePage < totalPages - 1) navRow.push({ text: t("sab_btn_next_page"), callback_data: `list_${safePage + 1}` });
  if (navRow.length) rows.push(navRow);
  rows.push([{ text: t("sab_btn_back_menu"), callback_data: "menu" }]);

  const text = `${t("sab_list_title", { count: entries.length })}\n${t("sab_page_label", { page: safePage + 1, total: totalPages })}`;
  return { text, keyboard: rows };
}

function renderRestaurantDetail(t, restId, rest) {
  const info = rest?.info || {};
  const sub = rest?.subscription || {};
  const isBlocked = info.status === "blocked";
  const expireAt = Number(sub.expireAt || 0);
  const isLifetime = !!sub.oneTimePaid && expireAt >= 9999999999999;
  const isActive = !isBlocked && expireAt > Date.now();
  const statusLabel = isBlocked ? t("sab_rest_status_blocked") : (isActive ? t("sab_rest_status_active") : t("sab_rest_status_expired"));
  const expireLabel = isLifetime ? t("sab_rest_lifetime") : (expireAt ? new Date(expireAt).toLocaleDateString("ru-RU") : "—");
  const createdLabel = info.createdAt ? new Date(info.createdAt).toLocaleDateString("ru-RU") : "—";

  return [
    `🏢 <b>${esc(info.name || restId)}</b>`,
    `${t("sab_rest_domain")}: ${esc(info.domain || "—")}`,
    info.phone ? `${t("sab_rest_phone")}: ${esc(info.phone)}` : null,
    `${t("sab_rest_status")}: ${statusLabel}`,
    `${t("sab_rest_tariff")}: ${(info.tariff || "—").toUpperCase()}`,
    `${t("sab_rest_expire")}: ${expireLabel}`,
    `${t("sab_rest_created")}: ${createdLabel}`,
  ].filter(Boolean).join("\n");
}

function restaurantDetailKeyboard(t, restId, isBlocked, listPage) {
  const ts = tsOf(restId);
  return [
    [{ text: isBlocked ? t("sab_btn_unblock") : t("sab_btn_block"), callback_data: `rbk_${ts}` }],
    [{ text: t("sab_btn_extend"), callback_data: `re_${ts}` }],
    [{ text: t("sab_btn_edit"), callback_data: `redit_${ts}` }, { text: t("sab_btn_modules"), callback_data: `rmod_${ts}` }],
    [{ text: t("sab_btn_tariff"), callback_data: `rtar_${ts}` }],
    [{ text: t("sab_btn_back_list"), callback_data: `list_${listPage || 0}` }],
  ];
}

// One-tap confirm before flipping block state — matches the extend-license/
// tariff-change confirm pattern already used elsewhere in this bot (a
// restaurant going offline for real customers is not something a single
// accidental tap should be able to do).
function blockConfirmKeyboard(t, restId) {
  const ts = tsOf(restId);
  return [
    [{ text: t("sab_btn_confirm"), callback_data: `rbkc_${ts}` }],
    [{ text: t("sab_btn_cancel"), callback_data: `rv_${ts}` }],
  ];
}

function moduleListKeyboard(restId, modules) {
  const ts = tsOf(restId);
  const rows = ALL_MODULE_IDS.map((id) => {
    const on = !!modules[id];
    return [{ text: `${on ? "✅" : "❌"} ${id}`, callback_data: `rmodt_${ts}_${id}` }];
  });
  return rows;
}

function moduleListFooter(t, restId) {
  const ts = tsOf(restId);
  return [
    [{ text: t("sab_btn_save"), callback_data: `rmods_${ts}` }],
    [{ text: t("sab_btn_cancel"), callback_data: `rv_${ts}` }],
  ];
}

function tariffMenuKeyboard(t, restId) {
  const ts = tsOf(restId);
  return [
    TARIFF_IDS.map((id) => ({ text: id.toUpperCase(), callback_data: `rtars_${ts}_${id}` })),
    [{ text: t("sab_btn_cancel"), callback_data: `rv_${ts}` }],
  ];
}

function tariffConfirmKeyboard(t, restId, tariffId) {
  const ts = tsOf(restId);
  return [
    [{ text: t("sab_btn_confirm"), callback_data: `rtarc_${ts}_${tariffId}` }],
    [{ text: t("sab_btn_cancel"), callback_data: `rv_${ts}` }],
  ];
}

function pricingKeyboard(t) {
  return [
    [{ text: t("sab_btn_edit"), callback_data: "pricing_edit" }],
    [{ text: t("sab_btn_back_menu"), callback_data: "menu" }],
  ];
}

function pricingConfirmKeyboard(t) {
  return [
    [{ text: t("sab_btn_confirm"), callback_data: "pricing_confirm" }],
    [{ text: t("sab_btn_cancel"), callback_data: "pricing_cancel" }],
  ];
}

function extendMenuKeyboard(t, restId) {
  const ts = tsOf(restId);
  return [
    [{ text: t("sab_btn_ext_1m"), callback_data: `rea_${ts}_1` }, { text: t("sab_btn_ext_3m"), callback_data: `rea_${ts}_3` }],
    [{ text: t("sab_btn_ext_6m"), callback_data: `rea_${ts}_6` }, { text: t("sab_btn_ext_12m"), callback_data: `rea_${ts}_12` }],
    [{ text: t("sab_btn_ext_lifetime"), callback_data: `rea_${ts}_lt` }],
    [{ text: t("sab_btn_cancel"), callback_data: `rv_${ts}` }],
  ];
}

function extendConfirmKeyboard(t, restId, code) {
  const ts = tsOf(restId);
  return [
    [{ text: t("sab_btn_confirm"), callback_data: `reac_${ts}_${code}` }],
    [{ text: t("sab_btn_cancel"), callback_data: `rv_${ts}` }],
  ];
}

const EXT_LABEL_KEYS = { 1: "sab_btn_ext_1m", 3: "sab_btn_ext_3m", 6: "sab_btn_ext_6m", 12: "sab_btn_ext_12m", lt: "sab_btn_ext_lifetime" };

function wizardLicenseKeyboard(t) {
  return [
    [{ text: t("sab_btn_ext_1m"), callback_data: "wiz_lic_1" }, { text: t("sab_btn_ext_3m"), callback_data: "wiz_lic_3" }],
    [{ text: t("sab_btn_ext_6m"), callback_data: "wiz_lic_6" }, { text: t("sab_btn_ext_12m"), callback_data: "wiz_lic_12" }],
    [{ text: t("sab_btn_ext_lifetime"), callback_data: "wiz_lic_lt" }],
    [{ text: t("sab_btn_cancel"), callback_data: "wiz_cancel" }],
  ];
}

function wizardConfirmKeyboard(t) {
  return [
    [{ text: t("sab_btn_confirm"), callback_data: "wiz_confirm" }],
    [{ text: t("sab_btn_cancel"), callback_data: "wiz_cancel" }],
  ];
}

function buildWizardConfirmText(t, data) {
  const licenseLabel = data.licenseCode === "lifetime" ? t("sab_btn_ext_lifetime") : t(EXT_LABEL_KEYS[data.licenseCode] || "sab_btn_ext_1m");
  return [
    `<b>${t("sab_wizard_confirm_title")}</b>`,
    `🏢 ${esc(data.name)}`,
    `🔗 ${esc(data.domain)}.nestacrm.uz`,
    data.phone ? `📞 ${esc(data.phone)}` : null,
    data.email ? `✉️ ${esc(data.email)}` : null,
    data.address ? `📍 ${esc(data.address)}` : null,
    `👤 ${esc(data.adminLogin)}`,
    `🔑 ${"•".repeat(Math.min(data.adminPass.length, 10))}`,
    `⏳ ${licenseLabel}`,
  ].filter(Boolean).join("\n");
}

function renderPaymentHistoryText(t, list) {
  if (!list.length) return `<b>${t("sab_btn_payments")}</b>\n\n${t("sab_payments_empty")}`;
  const lines = list.map((rec) => {
    const dateLabel = rec.date ? new Date(rec.date).toLocaleDateString("ru-RU") : "—";
    const amount = Number(rec.amount || 0).toLocaleString("ru-RU");
    return `${dateLabel} — ${esc(rec.restaurantName || "—")} — ${amount} so'm (${esc(rec.method || "—")})`;
  });
  return `<b>${t("sab_payments_title")}</b>\n\n${lines.join("\n")}`;
}

function renderAuditLogText(t, list) {
  if (!list.length) return `<b>${t("sab_btn_audit")}</b>\n\n${t("sab_audit_empty")}`;
  const lines = list.map((rec) => {
    const dateObj = rec.timestamp ? new Date(rec.timestamp) : null;
    const dateLabel = dateObj ? `${dateObj.toLocaleDateString("ru-RU")} ${dateObj.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : "—";
    return `${dateLabel} — [${esc(rec.action || "?")}] ${esc(rec.restName || "—")} — ${esc(rec.details || "")} (${esc(rec.actor || "SuperAdmin")})`;
  });
  return `<b>${t("sab_audit_title")}</b>\n\n${lines.join("\n")}`;
}

function renderPricingText(t, plans) {
  const p1 = Number(plans[1]?.price || 0).toLocaleString("ru-RU");
  const d3 = Number(plans[3]?.discount || 0);
  const d6 = Number(plans[6]?.discount || 0);
  const d12 = Number(plans[12]?.discount || 0);
  const coef = Number(plans.lifetime?.coefficient || 12);
  return [
    `<b>${t("sab_pricing_title")}</b>`,
    `${t("sab_pricing_1m")}: ${p1} so'm`,
    `${t("sab_pricing_3m")}: ${d3}%`,
    `${t("sab_pricing_6m")}: ${d6}%`,
    `${t("sab_pricing_12m")}: ${d12}%`,
    `${t("sab_pricing_lifetime_coef")}: ${coef}`,
  ].join("\n");
}

// ── Per-chat state ──────────────────────────────────────────────────────────
// In-memory only (not persisted to Firebase) — v1 scope. Language choice and
// any in-progress flow (restaurant wizard, restaurant-info edit, pending
// module toggles, pricing edit) reset to defaults if the backend restarts
// mid-conversation; low-impact since this bot has very few, trusted users
// and any of these flows is quick to redo. Exactly one of wizard/editWizard/
// modulesPending/settingsEdit is ever active at a time — starting any one of
// them clears the other three (see the "wiz_start"/"redit_"/"rmod_"/
// "pricing_edit" callback handlers below).
const _chatState = new Map(); // chatId -> { lang, wizard, editWizard, modulesPending, settingsEdit, lastListPage }

function getState(chatId) {
  if (!_chatState.has(chatId)) {
    _chatState.set(chatId, {
      lang: "uz", wizard: null, editWizard: null, modulesPending: null, settingsEdit: null, lastListPage: 0,
    });
  }
  return _chatState.get(chatId);
}

function clearAllFlows(state) {
  state.wizard = null;
  state.editWizard = null;
  state.modulesPending = null;
  state.settingsEdit = null;
}

// ── Wizard text-step handling ───────────────────────────────────────────────
async function handleWizardText(botToken, chatId, text, state, t) {
  const w = state.wizard;
  const cancelKb = [[{ text: t("sab_btn_cancel"), callback_data: "wiz_cancel" }]];

  switch (w.step) {
    case "name": {
      if (!text) return sendInlineKeyboard(botToken, chatId, t("sab_wizard_step_name"), cancelKb);
      w.data.name = text;
      w.step = "domain";
      return sendInlineKeyboard(botToken, chatId, t("sab_wizard_step_domain"), cancelKb);
    }
    case "domain": {
      const domain = text.toLowerCase();
      if (!/^[a-z0-9-]+$/.test(domain)) {
        return sendInlineKeyboard(botToken, chatId, t("sab_wizard_err_domain_format"), cancelKb);
      }
      const { nameTaken, domainTaken } = await checkUniqueness({ name: w.data.name, domain });
      if (nameTaken) return sendInlineKeyboard(botToken, chatId, t("sab_wizard_err_name_taken"), cancelKb);
      if (domainTaken) return sendInlineKeyboard(botToken, chatId, t("sab_wizard_err_domain_taken"), cancelKb);
      w.data.domain = domain;
      w.step = "phone";
      return sendInlineKeyboard(botToken, chatId, t("sab_wizard_step_phone"), cancelKb);
    }
    case "phone": {
      w.data.phone = text === "-" ? "" : text;
      w.step = "email";
      return sendInlineKeyboard(botToken, chatId, t("sab_wizard_step_email"), cancelKb);
    }
    case "email": {
      w.data.email = text === "-" ? "" : text;
      w.step = "address";
      return sendInlineKeyboard(botToken, chatId, t("sab_wizard_step_address"), cancelKb);
    }
    case "address": {
      w.data.address = text === "-" ? "" : text;
      w.step = "login";
      const suggested = `${w.data.domain}_admin`;
      return sendInlineKeyboard(botToken, chatId, t("sab_wizard_step_login", { login: suggested }), cancelKb);
    }
    case "login": {
      const suggested = `${w.data.domain}_admin`;
      const adminLogin = (text === "-" ? suggested : text).trim();
      const { loginTaken } = await checkUniqueness({ adminLogin });
      if (loginTaken) return sendInlineKeyboard(botToken, chatId, t("sab_wizard_err_login_taken"), cancelKb);
      w.data.adminLogin = adminLogin;
      w.step = "pass";
      return sendInlineKeyboard(botToken, chatId, t("sab_wizard_step_pass"), cancelKb);
    }
    case "pass": {
      // Aynan 6 xonali raqam — panelning "Restoran qo'shish" formasidagi
      // (superadmin.js saveNewRestaurant()) talab bilan bir xil, ikkalasi
      // ham bitta qoidadan kelib chiqadi.
      if (!/^\d{6}$/.test(text)) return sendInlineKeyboard(botToken, chatId, t("sab_wizard_err_pass_short"), cancelKb);
      w.data.adminPass = text;
      w.step = "license";
      return sendInlineKeyboard(botToken, chatId, t("sab_wizard_step_license"), wizardLicenseKeyboard(t));
    }
    default:
      // "license"/"confirm" steps are button-driven — a stray text message
      // here just re-shows the current prompt instead of being silently lost.
      return sendInlineKeyboard(botToken, chatId, t("sab_wizard_step_license"), wizardLicenseKeyboard(t));
  }
}

const EDIT_STEP_ORDER = ["name", "domain", "phone", "email", "address"];
const EDIT_STEP_PROMPT_KEYS = {
  name: "sab_edit_prompt_name", domain: "sab_edit_prompt_domain", phone: "sab_edit_prompt_phone",
  email: "sab_edit_prompt_email", address: "sab_edit_prompt_address",
};

function nextEditStep(step) {
  const i = EDIT_STEP_ORDER.indexOf(step);
  return i >= 0 && i < EDIT_STEP_ORDER.length - 1 ? EDIT_STEP_ORDER[i + 1] : "confirm";
}

function editWizardCancelKb(t, restId) {
  return [[{ text: t("sab_btn_cancel"), callback_data: `rv_${tsOf(restId)}` }]];
}

function editWizardConfirmKb(t, restId) {
  const ts = tsOf(restId);
  return [
    [{ text: t("sab_btn_confirm"), callback_data: `redits_${ts}` }],
    [{ text: t("sab_btn_cancel"), callback_data: `rv_${ts}` }],
  ];
}

function buildEditConfirmText(t, ew) {
  const changed = Object.entries(ew.fields);
  if (!changed.length) return `<b>${t("sab_edit_confirm_title")}</b>\n\n${t("sab_edit_no_changes")}`;
  const lines = changed.map(([k, v]) => `${k}: "${ew.current[k] || "—"}" → "${v}"`);
  return `<b>${t("sab_edit_confirm_title")}</b>\n\n${lines.join("\n")}`;
}

// Every step accepts "-" to keep the current value (nothing written for
// that field — updateRestaurantInfo()'s update() only touches keys actually
// present in `fields`, exactly like saveEditedRestaurant()'s targeted write).
async function handleEditWizardText(botToken, chatId, text, state, t) {
  const ew = state.editWizard;
  const cancelKb = editWizardCancelKb(t, ew.restId);

  if (ew.step === "domain" && text !== "-") {
    const domain = text.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(domain)) {
      return sendInlineKeyboard(botToken, chatId, t("sab_edit_err_domain_format"), cancelKb);
    }
    if (await isDomainTakenExcluding(domain, ew.restId)) {
      return sendInlineKeyboard(botToken, chatId, t("sab_edit_err_domain_taken"), cancelKb);
    }
    if (domain !== (ew.current.domain || "")) ew.fields.domain = domain;
  } else if (text !== "-" && text !== (ew.current[ew.step] || "")) {
    ew.fields[ew.step] = text;
  }

  ew.step = nextEditStep(ew.step);
  if (ew.step === "confirm") {
    return sendInlineKeyboard(botToken, chatId, buildEditConfirmText(t, ew), editWizardConfirmKb(t, ew.restId));
  }
  const current = ew.current[ew.step] || "—";
  return sendInlineKeyboard(botToken, chatId, t(EDIT_STEP_PROMPT_KEYS[ew.step], { current }), cancelKb);
}

// Single-message CSV input: "350000,5,11,16,12" — see sab_pricing_edit_prompt.
async function handleSettingsEditText(botToken, chatId, text, state, t) {
  const cancelKb = [[{ text: t("sab_btn_cancel"), callback_data: "pricing_cancel" }]];
  const parts = text.split(",").map((s) => s.trim());
  if (parts.length !== 5 || parts.some((p) => p === "" || Number.isNaN(Number(p)))) {
    return sendInlineKeyboard(botToken, chatId, t("sab_pricing_err_format"), cancelKb);
  }
  const [price1, disc3, disc6, disc12, coefLifetime] = parts.map(Number);
  state.settingsEdit.fields = { price1, disc3, disc6, disc12, coefLifetime };
  const previewPlans = {
    1: { price: price1 }, 3: { discount: disc3 }, 6: { discount: disc6 }, 12: { discount: disc12 },
    lifetime: { coefficient: coefLifetime },
  };
  const text2 = `${renderPricingText(t, previewPlans)}\n\n${t("sab_pricing_confirm_title")}`;
  return sendInlineKeyboard(botToken, chatId, text2, pricingConfirmKeyboard(t));
}

// ── Callback dispatch ────────────────────────────────────────────────────────
async function handleCallback(botToken, chatId, messageId, data, state) {
  const t = getTranslator(state.lang);
  const actorLabel = `SuperAdmin (Telegram #${chatId})`;

  const render = async (text, keyboard) => {
    if (messageId) return editMessage(botToken, chatId, messageId, text, { inline_keyboard: keyboard });
    return sendInlineKeyboard(botToken, chatId, text, keyboard);
  };

  if (data === "menu") {
    clearAllFlows(state);
    return render(t("sab_welcome"), mainMenuKeyboard(t));
  }

  if (data === "lang") return render(t("sab_welcome"), languageKeyboard(t));
  if (data === "lang_uz" || data === "lang_ru" || data === "lang_en") {
    state.lang = data.slice(5);
    const newT = getTranslator(state.lang);
    return render(`${newT("sab_lang_changed")}\n\n${newT("sab_welcome")}`, mainMenuKeyboard(newT));
  }

  if (data === "stats") {
    const s = await computeStats();
    const text = [
      `<b>${t("sab_stats_title")}</b>`,
      `${t("sab_stats_total")}: ${s.total}`,
      `${t("sab_stats_active")}: 🟢 ${s.active}`,
      `${t("sab_stats_expired")}: 🟠 ${s.expired}`,
      `${t("sab_stats_blocked")}: 🔴 ${s.blocked}`,
      `${t("sab_stats_revenue_month")}: ${s.revenueMonth.toLocaleString("ru-RU")} so'm`,
    ].join("\n");
    return render(text, [[{ text: t("sab_btn_back_menu"), callback_data: "menu" }]]);
  }

  if (data.startsWith("list_")) {
    const page = Number(data.slice(5)) || 0;
    state.lastListPage = page;
    const db = getAdminDb();
    const snap = await db.ref("restaurants").once("value");
    const view = buildRestaurantListView(t, snap.val() || {}, page);
    return render(view.text, view.keyboard);
  }

  if (data.startsWith("rv_")) {
    // Also the "cancel" target for every restaurant sub-flow (edit/modules/
    // tariff), so it clears whatever was in progress before rendering.
    clearAllFlows(state);
    const restId = "rest_" + data.slice(3);
    const db = getAdminDb();
    const snap = await db.ref(`restaurants/${restId}`).once("value");
    if (!snap.exists()) return render(t("sab_list_empty"), [[{ text: t("sab_btn_back_menu"), callback_data: "menu" }]]);
    const rest = snap.val();
    const isBlocked = rest?.info?.status === "blocked";
    return render(renderRestaurantDetail(t, restId, rest), restaurantDetailKeyboard(t, restId, isBlocked, state.lastListPage));
  }

  if (data.startsWith("rbk_")) {
    // One-tap confirm first — does not toggle anything yet.
    const restId = "rest_" + data.slice(4);
    const db = getAdminDb();
    const snap = await db.ref(`restaurants/${restId}/info/status`).once("value");
    const isBlocked = snap.val() === "blocked";
    const promptKey = isBlocked ? "sab_unblock_confirm_title" : "sab_block_confirm_title";
    return render(t(promptKey), blockConfirmKeyboard(t, restId));
  }
  if (data.startsWith("rbkc_")) {
    const restId = "rest_" + data.slice(5);
    const db = getAdminDb();
    const beforeSnap = await db.ref(`restaurants/${restId}`).once("value");
    const wasBlocked = beforeSnap.val()?.info?.status === "blocked";
    await toggleBlock(restId, !wasBlocked, actorLabel);
    const afterSnap = await db.ref(`restaurants/${restId}`).once("value");
    const rest = afterSnap.val() || {};
    const text = `${wasBlocked ? t("sab_unblock_success") : t("sab_block_success")}\n\n${renderRestaurantDetail(t, restId, rest)}`;
    return render(text, restaurantDetailKeyboard(t, restId, !wasBlocked, state.lastListPage));
  }

  if (data.startsWith("re_")) {
    const restId = "rest_" + data.slice(3);
    return render(t("sab_wizard_step_license"), extendMenuKeyboard(t, restId));
  }

  if (data.startsWith("rea_")) {
    // rea_<ts>_<code> — show a one-tap confirm before writing anything
    // (extending a license has real financial/access impact).
    const rest = data.slice(4);
    const sep = rest.lastIndexOf("_");
    const ts = rest.slice(0, sep);
    const code = rest.slice(sep + 1);
    const label = t(EXT_LABEL_KEYS[code] || "sab_btn_ext_1m");
    return render(`${t("sab_extend_confirm_title")}\n\n${label}`, extendConfirmKeyboard(t, "rest_" + ts, code));
  }

  if (data.startsWith("reac_")) {
    const rest = data.slice(5);
    const sep = rest.lastIndexOf("_");
    const ts = rest.slice(0, sep);
    const code = rest.slice(sep + 1);
    const restId = "rest_" + ts;
    const licenseCode = code === "lt" ? "lifetime" : code;
    const { expireAt, isLifetime } = await extendLicense(restId, licenseCode, actorLabel);
    const dateLabel = isLifetime ? t("sab_rest_lifetime") : new Date(expireAt).toLocaleDateString("ru-RU");
    const db = getAdminDb();
    const snap = await db.ref(`restaurants/${restId}`).once("value");
    const rest2 = snap.val() || {};
    const text = `${t("sab_extend_success", { date: dateLabel })}\n\n${renderRestaurantDetail(t, restId, rest2)}`;
    return render(text, restaurantDetailKeyboard(t, restId, rest2?.info?.status === "blocked", state.lastListPage));
  }

  // ── Restaurant info edit ──────────────────────────────────────────────────
  if (data.startsWith("redit_")) {
    clearAllFlows(state);
    const restId = "rest_" + data.slice(6);
    const db = getAdminDb();
    const snap = await db.ref(`restaurants/${restId}/info`).once("value");
    const info = snap.val() || {};
    state.editWizard = {
      restId,
      step: "name",
      current: { name: info.name || "", domain: info.domain || "", phone: info.phone || "", email: info.email || "", address: info.address || "" },
      fields: {},
    };
    return render(t("sab_edit_prompt_name", { current: state.editWizard.current.name || "—" }), editWizardCancelKb(t, restId));
  }
  if (data.startsWith("redits_") && state.editWizard) {
    const ew = state.editWizard;
    state.editWizard = null;
    try {
      if (Object.keys(ew.fields).length) await updateRestaurantInfo(ew.restId, ew.fields, actorLabel);
      const db = getAdminDb();
      const snap = await db.ref(`restaurants/${ew.restId}`).once("value");
      const rest = snap.val() || {};
      const text = `${t("sab_edit_success")}\n\n${renderRestaurantDetail(t, ew.restId, rest)}`;
      return render(text, restaurantDetailKeyboard(t, ew.restId, rest?.info?.status === "blocked", state.lastListPage));
    } catch (err) {
      console.error("[SuperAdminBot] updateRestaurantInfo failed:", err.message);
      return render(t("sab_error_generic", { msg: err.message }), mainMenuKeyboard(t));
    }
  }

  // ── Modules toggle ────────────────────────────────────────────────────────
  if (data.startsWith("rmod_")) {
    clearAllFlows(state);
    const restId = "rest_" + data.slice(5);
    const db = getAdminDb();
    const snap = await db.ref(`restaurants/${restId}/modules`).once("value");
    const modules = {};
    ALL_MODULE_IDS.forEach((id) => { modules[id] = !!snap.val()?.[id]; });
    state.modulesPending = { restId, modules };
    return render(t("sab_modules_title"), [...moduleListKeyboard(restId, modules), ...moduleListFooter(t, restId)]);
  }
  if (data.startsWith("rmodt_") && state.modulesPending) {
    const rest = data.slice(6);
    const sep = rest.lastIndexOf("_");
    const ts = rest.slice(0, sep);
    const moduleId = rest.slice(sep + 1);
    if (tsOf(state.modulesPending.restId) === ts && ALL_MODULE_IDS.includes(moduleId)) {
      state.modulesPending.modules[moduleId] = !state.modulesPending.modules[moduleId];
    }
    const { restId, modules } = state.modulesPending;
    return render(t("sab_modules_title"), [...moduleListKeyboard(restId, modules), ...moduleListFooter(t, restId)]);
  }
  if (data.startsWith("rmods_") && state.modulesPending) {
    const { restId, modules } = state.modulesPending;
    state.modulesPending = null;
    try {
      await updateRestaurantModules(restId, modules, actorLabel);
      const db = getAdminDb();
      const snap = await db.ref(`restaurants/${restId}`).once("value");
      const rest = snap.val() || {};
      const text = `${t("sab_modules_success")}\n\n${renderRestaurantDetail(t, restId, rest)}`;
      return render(text, restaurantDetailKeyboard(t, restId, rest?.info?.status === "blocked", state.lastListPage));
    } catch (err) {
      console.error("[SuperAdminBot] updateRestaurantModules failed:", err.message);
      return render(t("sab_error_generic", { msg: err.message }), mainMenuKeyboard(t));
    }
  }

  // ── Tariff change ─────────────────────────────────────────────────────────
  if (data.startsWith("rtar_")) {
    clearAllFlows(state);
    const restId = "rest_" + data.slice(5);
    return render(t("sab_tariff_title"), tariffMenuKeyboard(t, restId));
  }
  if (data.startsWith("rtars_")) {
    const rest = data.slice(6);
    const sep = rest.lastIndexOf("_");
    const ts = rest.slice(0, sep);
    const tariffId = rest.slice(sep + 1);
    if (!TARIFF_IDS.includes(tariffId)) return render(t("sab_welcome"), mainMenuKeyboard(t));
    return render(t("sab_tariff_confirm_title", { tariff: tariffId.toUpperCase() }), tariffConfirmKeyboard(t, "rest_" + ts, tariffId));
  }
  if (data.startsWith("rtarc_")) {
    const rest = data.slice(6);
    const sep = rest.lastIndexOf("_");
    const ts = rest.slice(0, sep);
    const tariffId = rest.slice(sep + 1);
    const restId = "rest_" + ts;
    if (!TARIFF_IDS.includes(tariffId)) return render(t("sab_welcome"), mainMenuKeyboard(t));
    try {
      await changeTariff(restId, tariffId, actorLabel);
      const db = getAdminDb();
      const snap = await db.ref(`restaurants/${restId}`).once("value");
      const rest2 = snap.val() || {};
      const text = `${t("sab_tariff_success", { tariff: tariffId.toUpperCase() })}\n\n${renderRestaurantDetail(t, restId, rest2)}`;
      return render(text, restaurantDetailKeyboard(t, restId, rest2?.info?.status === "blocked", state.lastListPage));
    } catch (err) {
      console.error("[SuperAdminBot] changeTariff failed:", err.message);
      return render(t("sab_error_generic", { msg: err.message }), mainMenuKeyboard(t));
    }
  }

  // ── Read-only: payment history / audit log ───────────────────────────────
  if (data === "payments") {
    const list = await getRecentPaymentHistory(10);
    return render(renderPaymentHistoryText(t, list), [[{ text: t("sab_btn_back_menu"), callback_data: "menu" }]]);
  }
  if (data === "audit") {
    const list = await getRecentAuditLog(10);
    return render(renderAuditLogText(t, list), [[{ text: t("sab_btn_back_menu"), callback_data: "menu" }]]);
  }

  // ── License-duration pricing (systemData/settings/subscriptionPlans) ─────
  if (data === "pricing") {
    clearAllFlows(state);
    const plans = await loadSubscriptionPlans();
    return render(renderPricingText(t, plans), pricingKeyboard(t));
  }
  if (data === "pricing_edit") {
    clearAllFlows(state);
    state.settingsEdit = { fields: null };
    return render(t("sab_pricing_edit_prompt"), [[{ text: t("sab_btn_cancel"), callback_data: "pricing_cancel" }]]);
  }
  if (data === "pricing_cancel") {
    state.settingsEdit = null;
    return render(t("sab_welcome"), mainMenuKeyboard(t));
  }
  if (data === "pricing_confirm" && state.settingsEdit?.fields) {
    const fields = state.settingsEdit.fields;
    state.settingsEdit = null;
    try {
      await updateSubscriptionPlansPricing(fields, actorLabel);
      return render(t("sab_pricing_success"), mainMenuKeyboard(t));
    } catch (err) {
      console.error("[SuperAdminBot] updateSubscriptionPlansPricing failed:", err.message);
      return render(t("sab_error_generic", { msg: err.message }), mainMenuKeyboard(t));
    }
  }

  // ── Add-restaurant wizard ─────────────────────────────────────────────────
  if (data === "wiz_start") {
    clearAllFlows(state);
    state.wizard = { step: "name", data: {} };
    return render(t("sab_wizard_step_name"), [[{ text: t("sab_btn_cancel"), callback_data: "wiz_cancel" }]]);
  }
  if (data === "wiz_cancel") {
    state.wizard = null;
    return render(t("sab_wizard_cancelled"), mainMenuKeyboard(t));
  }
  if (data.startsWith("wiz_lic_") && state.wizard?.step === "license") {
    const raw = data.slice(8);
    const code = raw === "lt" ? "lifetime" : raw;
    state.wizard.data.licenseCode = code;
    state.wizard.step = "confirm";
    return render(buildWizardConfirmText(t, state.wizard.data), wizardConfirmKeyboard(t));
  }
  if (data === "wiz_confirm" && state.wizard?.step === "confirm") {
    const wizardData = state.wizard.data;
    state.wizard = null;
    try {
      const { restId, expireAt, isLifetime } = await createRestaurantFromWizard(wizardData, actorLabel);
      const dateLabel = isLifetime ? t("sab_rest_lifetime") : new Date(expireAt).toLocaleDateString("ru-RU");
      const text = [
        t("sab_wizard_success"),
        `🆔 ${restId}`,
        `${t("sab_rest_expire")}: ${dateLabel}`,
        "",
        t("sab_created_login_recap"),
        `🔗 https://${esc(wizardData.domain)}.nestacrm.uz`,
        `👤 ${esc(wizardData.adminLogin)}`,
        `🔑 ${esc(wizardData.adminPass)}`,
      ].join("\n");
      return render(text, mainMenuKeyboard(t));
    } catch (err) {
      console.error("[SuperAdminBot] createRestaurantFromWizard failed:", err.message);
      return render(t("sab_error_generic", { msg: err.message }), mainMenuKeyboard(t));
    }
  }

  // Unknown/stale callback (e.g. a button from an old message pre-restart).
  return render(t("sab_welcome"), mainMenuKeyboard(t));
}

// ── Update dispatch ──────────────────────────────────────────────────────────
async function handleUpdate(botToken, allowedTelegramIds, update) {
  const msg = update.message;
  const cq = update.callback_query;
  const chatId = msg?.chat?.id ?? cq?.message?.chat?.id;
  if (chatId == null) return;

  if (!allowedTelegramIds.includes(String(chatId))) {
    console.warn(`[SuperAdminBot] Ignored update from unauthorized chatId=${chatId}`);
    if (cq) await answerCallbackQuery(botToken, cq.id).catch(() => {});
    return;
  }

  const state = getState(chatId);
  const t = getTranslator(state.lang);

  if (msg?.text != null) {
    const text = msg.text.trim();
    if (text === "/start" || text === "/menu") {
      clearAllFlows(state);
      await sendInlineKeyboard(botToken, chatId, t("sab_welcome"), mainMenuKeyboard(t));
      return;
    }
    if (text === "/cancel") {
      clearAllFlows(state);
      await sendInlineKeyboard(botToken, chatId, t("sab_wizard_cancelled"), mainMenuKeyboard(t));
      return;
    }
    if (state.settingsEdit) {
      await handleSettingsEditText(botToken, chatId, text, state, t);
      return;
    }
    if (state.editWizard) {
      await handleEditWizardText(botToken, chatId, text, state, t);
      return;
    }
    if (state.wizard) {
      await handleWizardText(botToken, chatId, text, state, t);
      return;
    }
    await sendInlineKeyboard(botToken, chatId, t("sab_welcome"), mainMenuKeyboard(t));
    return;
  }

  if (cq) {
    await answerCallbackQuery(botToken, cq.id).catch(() => {});
    const data = cq.data || "";
    const messageId = cq.message?.message_id;
    try {
      await handleCallback(botToken, chatId, messageId, data, state);
    } catch (err) {
      console.error(`[SuperAdminBot] callback error for "${data}":`, err.message);
      if (messageId) {
        await editMessage(botToken, chatId, messageId, t("sab_error_generic", { msg: err.message }), { inline_keyboard: mainMenuKeyboard(t) }).catch(() => {});
      }
    }
  }
}

// ── Per-chat update serialization ───────────────────────────────────────────
// ROOT CAUSE this closes: the poll loop below fires handleUpdate() for every
// update in a getUpdates batch WITHOUT awaiting between them (fire-and-
// forget, so the loop itself never blocks on Firebase/network latency).
// state.wizard/editWizard/modulesPending/settingsEdit ARE cleared
// synchronously before their first await inside handleCallback() — which
// safely no-ops a SECOND tap that arrives after the first has already
// finished — but it does NOT protect against two updates for the SAME chat
// being dispatched in the same batch: both handleUpdate() calls run their
// synchronous prefix (up to answerCallbackQuery, itself an await) before
// EITHER reaches the state-clearing line, so both could observe the
// pre-clear state and both proceed — e.g. two "✅ Tasdiqlash" taps on the
// same still-pending restaurant-creation wizard creating two restaurants,
// or a license getting extended twice. Real if narrow (needs two genuinely
// concurrent updates for one chat, e.g. a fast double-tap or a Telegram
// redelivery) — closed generically here rather than patching each write
// path individually: updates for the same chatId are queued and run
// strictly one-at-a-time; different chats remain fully independent/
// concurrent, unaffected.
const _chatQueues = new Map(); // chatId -> Promise (tail of that chat's processing chain)

function enqueueForChat(chatId, taskFn) {
  const prev = _chatQueues.get(chatId) || Promise.resolve();
  const next = prev.then(taskFn, taskFn); // run taskFn even if the previous update's handling threw
  _chatQueues.set(chatId, next.catch(() => {})); // keep the stored tail always-settled so the map never accumulates a rejected chain
  return next;
}

// ── Single global long-poll loop ────────────────────────────────────────────
let _poller = null; // { botToken, allowedTelegramIds, stopped }

async function pollLoop(state) {
  let offset = 0;
  console.log("[SuperAdminBot] Poller started.");
  await callApi(state.botToken, "deleteWebhook", {}).catch(() => {});

  while (!state.stopped) {
    const resp = await callApi(state.botToken, "getUpdates", { offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ["message", "callback_query"] });
    if (state.stopped) break;

    if (!resp.ok) {
      console.error("[SuperAdminBot] getUpdates failed:", resp.description || "unknown error", "— retrying in 5s");
      await sleep(5000);
      continue;
    }

    for (const update of resp.result || []) {
      offset = update.update_id + 1;
      const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
      const run = () => handleUpdate(state.botToken, state.allowedTelegramIds, update);
      const task = chatId == null ? run() : enqueueForChat(chatId, run);
      task.catch((err) => console.error("[SuperAdminBot] handleUpdate error:", err.message));
    }
  }
  console.log("[SuperAdminBot] Poller stopped.");
}

async function loadBotSettings() {
  const snap = await systemGet("systemData/settings/superadminBot");
  const v = snap.exists() ? snap.val() || {} : {};
  return {
    botToken: v.botToken || "",
    enabled: !!v.enabled,
    allowedTelegramIds: Array.isArray(v.allowedTelegramIds) ? v.allowedTelegramIds.map(String) : [],
  };
}

async function syncPoller() {
  if (isMaintenanceMode()) return;
  if (!isAdminAvailable()) return; // same graceful-degrade posture as every other Admin-SDK-only feature

  const settings = await loadBotSettings();
  // Fail-closed: won't even start the poller without a token AND at least
  // one allowlisted Telegram ID — an enabled bot with an empty allowlist
  // would otherwise answer every stranger who finds it with /start.
  const shouldRun = settings.enabled && !!settings.botToken && settings.allowedTelegramIds.length > 0;

  if (_poller && (!shouldRun || _poller.botToken !== settings.botToken)) {
    _poller.stopped = true;
    _poller = null;
  }
  if (shouldRun && !_poller) {
    const state = { botToken: settings.botToken, allowedTelegramIds: settings.allowedTelegramIds, stopped: false };
    _poller = state;
    pollLoop(state).catch((err) => console.error("[SuperAdminBot] poller crashed:", err.message));
  } else if (_poller) {
    // Allowlist edits take effect on the next sync tick without a restart.
    _poller.allowedTelegramIds = settings.allowedTelegramIds;
  }
}

let _syncTimer = null;

/** Call once from server.js, alongside startTelegramBotPolling()/startScheduler(). */
export function startPolling() {
  if (_syncTimer) return; // idempotent
  console.log("🤖 SuperAdmin Telegram Bot — polling manager started.");
  syncPoller().catch((err) => console.error("[SuperAdminBot] initial sync error:", err.message));
  _syncTimer = setInterval(() => syncPoller().catch((err) => console.error("[SuperAdminBot] sync error:", err.message)), SYNC_INTERVAL_MS);
}

export function stopPolling() {
  if (_syncTimer) clearInterval(_syncTimer);
  _syncTimer = null;
  if (_poller) _poller.stopped = true;
  _poller = null;
}

/** Used by routes/superadminBot.js's "send test message" button. */
// Masks a chat/user ID for logs the SAME way the bot token is already
// masked elsewhere in this codebase (superadminBot.js route, superadmin.js
// panel JS) — never log the full ID either, even though it's less sensitive
// than a token, since it's still a real person's Telegram identifier.
function maskId(id) {
  const s = String(id ?? "");
  if (s.length <= 4) return "•".repeat(s.length);
  return s.slice(0, 2) + "•".repeat(s.length - 4) + s.slice(-2);
}

// Turns a Telegram API error response into one of a small, fixed set of
// reason codes — routes/superadminBot.js forwards these as-is to the panel,
// which maps each one to a translated, human message (superadmin.js's
// SA_BOT_TEST_ERROR_KEYS). Never forward Telegram's raw `description` as
// the ONLY signal — a bare "Bad Request: chat not found" means nothing to
// someone who doesn't already know the Telegram Bot API's error strings.
function classifyTelegramError(resp) {
  if (resp.networkError) return "network_error";
  if (resp.error_code === 429) return "rate_limited";
  const d = String(resp.description || "").toLowerCase();
  if (d.includes("chat not found")) return "chat_not_found";
  if (d.includes("bot was blocked")) return "bot_blocked";
  if (d.includes("bot is not a member") || d.includes("not enough rights") || d.includes("have no rights") || d.includes("kicked")) return "not_member";
  if (d.includes("too many requests")) return "rate_limited";
  if (d.includes("unauthorized")) return "unauthorized";
  return "unknown";
}

// ROOT CAUSE this closes: "Test xabar yuborish" only ever called
// sendMessage() directly, so a genuinely wrong/never-/started Telegram ID
// surfaced as a raw, unmapped Telegram error the panel just JSON.stringify'd
// at the user. Now: (1) getMe() once, up front — if the TOKEN itself is bad,
// every chat would fail for that one shared reason, so check it once instead
// of once per id; (2) getChat() per id BEFORE sendMessage — the single most
// common real cause (confirmed live: a Telegram ID that has never sent
// /start to this bot) fails here with a clear, classifiable reason instead
// of only surfacing once sendMessage itself is attempted; (3) every failure
// gets a `reason` code from the fixed set above instead of a raw Telegram
// string.
export async function sendTestMessage(botToken, chatIds, text) {
  console.log("[TELEGRAM-DIAG]", { botConfigured: !!botToken, chatCount: chatIds.length });

  const me = await callApi(botToken, "getMe", {});
  if (!me.ok) {
    console.warn("[TELEGRAM-DIAG] getMe failed — bot token itself is invalid:", me.description || me.reason);
    return chatIds.map((chatId) => ({ chatId, ok: false, reason: "unauthorized" }));
  }

  const results = [];
  for (const chatId of chatIds) {
    const chatIdStr = String(chatId ?? "").trim();
    console.log("[TELEGRAM-DIAG]", {
      chatIdPresent: !!chatIdStr,
      chatIdType: typeof chatId,
      chatIdMasked: maskId(chatIdStr),
      botConfigured: true,
    });

    if (!chatIdStr) {
      results.push({ chatId, ok: false, reason: "invalid_chat_id" });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- sequential is fine, this only ever runs for a handful of allowlisted ids from one manual panel click
    const chatCheck = await callApi(botToken, "getChat", { chat_id: chatIdStr });
    if (!chatCheck.ok) {
      console.warn(`[TELEGRAM-DIAG] getChat failed for ${maskId(chatIdStr)}:`, chatCheck.description || chatCheck.reason);
      results.push({ chatId, ok: false, reason: classifyTelegramError(chatCheck) });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- see above
    const sendResult = await sendMessage(botToken, chatIdStr, text);
    if (!sendResult.ok) {
      results.push({ chatId, ok: false, reason: classifyTelegramError(sendResult) });
    } else {
      results.push({ chatId, ok: true });
    }
  }
  return results;
}

export const SuperAdminBotService = { startPolling, stopPolling, sendTestMessage };
export default SuperAdminBotService;
