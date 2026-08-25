// notifications/common.js — shared helpers for the Notification Center.
// Mirrors the conventions in delivery/common.js and payments/common.js
// (same basePath() shape, same get/update-oriented style) so this module
// reads like a natural sibling of the existing provider-adapter systems.
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so every read/write here goes through the
// admin-or-client fallback (systemDb.js) instead of the plain client SDK.
import { systemGet, systemUpdate, systemPush } from "../systemDb.js";

export function basePath(restId) {
  return `restaurants/${restId}`;
}

const DEFAULT_SCHEDULE = {
  timezone: "Asia/Tashkent",
  daily: { enabled: false, times: ["22:00"] }, // spec default: end-of-day report at 22:00
  weekly: { enabled: false, day: "monday", time: "09:00" },
  monthly: { enabled: false, day: 1, time: "09:00" },
};

export async function getNotificationSettings(restId) {
  const snap = await systemGet(`${basePath(restId)}/settings/notificationSettings`);
  const s = snap.val() || {};
  return {
    enabled: s.enabled !== false,
    telegram: { botToken: s.telegram?.botToken || "", chatId: s.telegram?.chatId || "", enabled: !!s.telegram?.enabled },
    types: s.types || {},
    schedule: { ...DEFAULT_SCHEDULE, ...(s.schedule || {}) },
    largeOrderThreshold: Number(s.largeOrderThreshold || 1000000),
    language: s.language || "uz",
  };
}

export async function updateNotificationSettings(restId, patch) {
  await systemUpdate(`${basePath(restId)}/settings/notificationSettings`, { ...patch, updatedAt: Date.now() });
}

/** Is this notification type turned on for this restaurant? Defaults to ON
 * (checkboxes ship checked per spec) unless the admin explicitly disabled it. */
export function isTypeEnabled(settings, type) {
  if (!settings.enabled) return false;
  return settings.types?.[type] !== false;
}

// ── Dedupe / "only send changed alerts once" state ─────────────────────────
// Persisted (not in-memory) so it survives server restarts — a requirement
// from spec section 14 ("Only send changed alerts once").
export async function getAlertState(restId, key) {
  const snap = await systemGet(`${basePath(restId)}/notifications/state/${key}`);
  return snap.val() || null;
}

export async function setAlertState(restId, key, value) {
  await systemUpdate(`${basePath(restId)}/notifications/state`, { [key]: { ...value, at: Date.now() } });
}

/** Appends one entry to the restaurant's notification history (for the future Notification Center UI). */
export async function appendNotificationLog(restId, entry) {
  await systemPush(`${basePath(restId)}/notifications/log`, { ...entry, at: Date.now() });
}

export async function listRestaurantIds() {
  const snap = await systemGet("restaurants");
  const data = snap.val() || {};
  return Object.keys(data);
}

/** Shared by scheduler.js and TelegramBotService.js — avoids duplicating this lookup. */
export async function getRestaurantName(restId) {
  const snap = await systemGet(`${basePath(restId)}/settings/restaurantName`);
  return snap.val() || restId;
}
