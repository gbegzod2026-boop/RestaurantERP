// notifications/chatRegistry.js — explicit chatId -> restId registry, the
// multi-tenant safety net requested on top of the existing architecture.
//
// IMPORTANT CONTEXT (why this is additive, not a redesign): this app's
// existing design already gives HARD isolation between restaurants for the
// common case — each restaurant configures its OWN Telegram bot token
// (restaurants/{restId}/settings/notificationSettings/telegram/botToken),
// and TelegramBotService.js runs one independent long-poll loop per bot
// token. Telegram's own API guarantees a getUpdates call scoped to bot
// token A can only ever return updates sent to bot A — there is no
// operation in this codebase that reads updates for "a bot" without
// already knowing which restaurant's token it is. So cross-tenant mixing
// was already structurally impossible in the normal case.
//
// The ONE real gap: nothing previously detected an admin accidentally
// pasting restaurant A's bot token into restaurant B's settings. This file
// closes that gap with the exact registry shape requested:
//
//   telegram/chats/<chatId>: { restId, language, linkedAt }
//
// A chat is linked to a restaurant on first contact and is then permanent
// — if a later message from the same chatId ever arrives under a
// DIFFERENT restId (only possible via a duplicate-bot-token
// misconfiguration, since normally one chatId only ever talks to one
// restaurant's bot), it is treated as a security event: logged loudly and
// the update is dropped rather than processed against the wrong tenant.
// Architecture Fix Pass: this registry lives outside restaurants/$restId
// (top-level "telegram/chats"), which the root `.read: false / .write:
// false` rule already covers — every read/write here goes through the
// admin-or-client fallback (systemDb.js) instead of the plain client SDK.
import { systemGet, systemUpdate } from "../systemDb.js";

const REGISTRY_PATH = "telegram/chats";

export async function getChatLink(chatId) {
  const snap = await systemGet(`${REGISTRY_PATH}/${chatId}`);
  return snap.exists() ? snap.val() : null;
}

async function setChatLink(chatId, restId, language) {
  await systemUpdate(`${REGISTRY_PATH}/${chatId}`, {
    restId,
    language,
    linkedAt: Date.now(),
  });
}

/**
 * The mandatory resolve-before-load gate: chatId -> restId, verified.
 * Call this BEFORE loading any restaurant data for an inbound Telegram
 * update. Returns the restId that is safe to use, or null if the update
 * must be dropped (unlinked chat trying to claim a different restaurant's
 * data, or a duplicate-token misconfiguration).
 *
 * `expectedRestId` is the restId the caller already believes this chat
 * belongs to (known from which per-restaurant poller received the update —
 * see TelegramBotService.js). This function does not trust that belief
 * blindly; it cross-checks it against the persisted registry.
 */
export async function resolveAndLinkChat(chatId, expectedRestId, language) {
  const existing = await getChatLink(chatId);

  if (!existing) {
    // First contact from this chat — permanently link it to the restaurant
    // whose bot token actually received the message.
    await setChatLink(chatId, expectedRestId, language);
    console.log(`[ChatRegistry] Linked chatId=${chatId} -> restId="${expectedRestId}" (first contact)`);
    return expectedRestId;
  }

  if (existing.restId !== expectedRestId) {
    // This should be unreachable under normal operation (it would require
    // two restaurants sharing one bot token). Refuse to serve data rather
    // than guess which tenant is correct.
    console.error(
      `[ChatRegistry] 🚨 SECURITY: chatId=${chatId} is registered to restId="${existing.restId}" but this update arrived via ` +
      `restId="${expectedRestId}"'s bot token — likely a duplicate/misconfigured bot token. Dropping update, NOT loading any data.`
    );
    return null;
  }

  // Keep the registry's language mirror current (best-effort, non-blocking
  // for callers that don't await it) — the settings.language field under
  // that restaurant's own notificationSettings remains the actual source
  // of truth used to render text; this copy is only for registry visibility.
  if (language && existing.language !== language) {
    setChatLink(chatId, expectedRestId, language).catch(() => {});
  }

  return expectedRestId;
}

/** For duplicate-bot-token detection in TelegramBotService.syncPollers(). */
export async function findRestaurantsUsingToken(allTelegramSettingsByRestId, botToken) {
  return Object.entries(allTelegramSettingsByRestId)
    .filter(([, s]) => s.botToken === botToken)
    .map(([restId]) => restId);
}
