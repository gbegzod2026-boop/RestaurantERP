// notifications/NotificationService.js — the ONE choke point every
// notification in the system must pass through (spec section 1/13).
//
//   NotificationService.send(type, restaurantId, recipients, payload)
//
// Business modules (delivery engine, orders route, payments routes, the
// warehouse scanner, the scheduler...) only ever call this. They never
// import a provider, never know what a "chat id" or "bot token" is, and
// never format a message string themselves — that's templates.js's job.
//
// Adding Push/Email/SMS/WhatsApp later touches providerRegistry.js + one
// new provider file. This file does not change.
import { getNotificationSettings, isTypeEnabled, appendNotificationLog } from "./common.js";
import { getProvider, getAllProviderKeys } from "./providerRegistry.js";
import { renderInstantMessage } from "./templates.js";
import { TOGGLEABLE_TYPES } from "./types.js";

/**
 * @param {string} type - one of NOTIFICATION_TYPES
 * @param {string} restId - restaurant id
 * @param {null|Array<{channel:string, target:string}>} recipients - optional
 *   explicit overrides (future use — e.g. SMS to a specific manager's phone).
 *   When null, the restaurant's configured channels/targets from
 *   notificationSettings are used.
 * @param {object} payload - type-specific data for the template
 * @param {{text?: string, replyMarkup?: object}} [opts] - pass a pre-rendered
 *   `text` to skip the built-in per-type template (used by the report
 *   scheduler, which builds its own multi-section message via
 *   templates.formatPeriodReport). `replyMarkup` is an optional Telegram
 *   inline_keyboard object forwarded as-is to TelegramProvider.send() — used
 *   by the scheduler to attach the same live-dashboard buttons the manual
 *   /start menu uses to automatic report messages. Ignored by providers that
 *   don't understand it.
 */
export async function send(type, restId, recipients, payload = {}, opts = {}) {
  console.log(`[NotificationService] send() called — type="${type}" restId="${restId}"`);

  if (!restId) {
    console.error("[NotificationService] ❌ no_restaurant — restId was empty/undefined, aborting before any settings lookup.");
    return { ok: false, reason: "no_restaurant" };
  }

  const settings = await getNotificationSettings(restId);
  console.log(
    `[NotificationService] settings loaded — enabled=${settings.enabled} | telegram.enabled=${settings.telegram?.enabled} | telegram.hasToken=${!!settings.telegram?.botToken} | telegram.chatId=${settings.telegram?.chatId || "(empty)"}`
  );

  // Only gate on the admin's checkbox for the types that are actually
  // presented as checkboxes; internal/delivery-lifecycle events always go
  // through (their own "enabled" toggle is settings.telegram.enabled).
  if (TOGGLEABLE_TYPES.includes(type) && !isTypeEnabled(settings, type)) {
    console.warn(`[NotificationService] ❌ STOPPED — type_disabled: "${type}" is turned off in Settings → Notifications (or the master "enabled" switch is off).`);
    return { ok: false, reason: "type_disabled" };
  }

  const lang = settings.language;
  const text = opts.text || renderInstantMessage(type, lang, payload);

  const targets = recipients && recipients.length
    ? recipients
    : getAllProviderKeys()
        .filter((channel) => settings[channel]?.enabled)
        .map((channel) => ({ channel, target: null }));

  if (!targets.length) {
    // This is the single most common silent failure: Test Connection only
    // verifies the bot token/chat id are valid — it does NOT require or
    // check settings.telegram.enabled. An admin can test successfully and
    // still never receive scheduled reports if the "Enable Telegram
    // Notifications" checkbox itself was never saved as checked.
    console.error(
      `[NotificationService] ❌ STOPPED — no_channel_configured. settings.telegram.enabled=${settings.telegram?.enabled}. ` +
      `TelegramProvider.send() will NOT be called. Fix: check "Enable Telegram Notifications" in Settings → Notifications and Save.`
    );
    return { ok: false, reason: "no_channel_configured" };
  }

  console.log(`[NotificationService] → dispatching to channel(s): ${targets.map((t) => t.channel).join(", ")}`);

  const results = await Promise.all(
    targets.map(async ({ channel }) => {
      const provider = getProvider(channel);
      if (!provider) {
        console.error(`[NotificationService] ❌ unknown_channel: "${channel}" has no registered provider.`);
        return { channel, ok: false, reason: "unknown_channel" };
      }
      const result = await provider.send({ restId, settings, type, text, payload, replyMarkup: opts.replyMarkup });
      console.log(`[NotificationService] ← ${channel}.send() returned:`, JSON.stringify(result));
      return { channel, ...result };
    })
  );

  const ok = results.some((r) => r.ok);
  console.log(`[NotificationService] final result — ok=${ok}`, JSON.stringify(results));
  appendNotificationLog(restId, { type, ok, results, textPreview: text.slice(0, 120) }).catch(() => {});

  return { ok, results };
}

/** Same dispatch path, but with a fully pre-formatted message (used for reports). */
export async function sendRaw(restId, text) {
  const settings = await getNotificationSettings(restId);
  const targets = getAllProviderKeys().filter((channel) => settings[channel]?.enabled);
  if (!targets.length) return { ok: false, reason: "no_channel_configured" };

  const results = await Promise.all(
    targets.map(async (channel) => {
      const provider = getProvider(channel);
      const result = await provider.send({ restId, settings, type: "report", text, payload: {} });
      return { channel, ...result };
    })
  );
  return { ok: results.some((r) => r.ok), results };
}

export const NotificationService = { send, sendRaw };
export default NotificationService;
