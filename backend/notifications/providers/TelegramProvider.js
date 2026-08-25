// notifications/providers/TelegramProvider.js — the only channel actually
// wired up today. Everything Telegram-specific (bot token, chat id, the
// Telegram Bot API call itself) lives ONLY here — no other file in the
// system knows what a "chat id" or "bot token" is.
//
// IMPORTANT: this file must never report success unless Telegram's own
// response body says `ok: true`. A 200 HTTP status is NOT sufficient proof
// by itself — we parse and check the JSON body explicitly on every path,
// and log the exact request/response so a misconfigured token/chat id is
// visible immediately instead of surfacing as a silent no-op.
import { BaseProvider } from "./BaseProvider.js";

async function callTelegramApi(botToken, chatId, text, replyMarkup) {
  if (!botToken) {
    console.error("[Telegram Provider] no_bot_token — botToken is empty/undefined, sendMessage was never called.");
    return { ok: false, reason: "no_bot_token" };
  }
  if (!chatId) {
    console.error("[Telegram Provider] no_chat_id — chatId is empty/undefined, sendMessage was never called.");
    return { ok: false, reason: "no_chat_id" };
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  // reply_markup is optional (undefined for every non-report notification
  // type, unchanged) — only the scheduled-report path passes one, via
  // opts.replyMarkup all the way from NotificationService.send().
  const body = { chat_id: chatId, text, parse_mode: "HTML", ...(replyMarkup ? { reply_markup: replyMarkup } : {}) };

  // Never log the raw token — mask everything but the last 4 chars, same
  // convention as the masked value the Settings UI shows.
  const maskedUrl = `https://api.telegram.org/bot${"•".repeat(Math.max(0, botToken.length - 4))}${botToken.slice(-4)}/sendMessage`;
  console.log("[Telegram Provider] POST", maskedUrl);
  console.log("[Telegram Provider] request body:", JSON.stringify(body));

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network-level failure — fetch never got a response at all (DNS, no
    // internet egress from this server, TLS error, etc.)
    console.error("[Telegram Provider] fetch() threw before any HTTP response was received:", err.message);
    return { ok: false, reason: "network_error", detail: err.message };
  }

  console.log("[Telegram Provider] response.status:", resp.status, resp.statusText);

  let json = null;
  try {
    json = await resp.json();
  } catch (err) {
    console.error("[Telegram Provider] response body was not valid JSON:", err.message);
    return { ok: false, reason: "invalid_response_body", httpStatus: resp.status };
  }

  console.log("[Telegram Provider] response body:", JSON.stringify(json));

  // Telegram's own contract: the JSON body always carries `ok: true|false`.
  // A 200 with ok:false has never been observed in Telegram's API, but we
  // check both explicitly anyway — this is the line that guarantees this
  // function can never report success without Telegram itself confirming it.
  if (!resp.ok || json?.ok !== true) {
    console.error(
      "[Telegram Provider] Telegram rejected the message:",
      `http ${resp.status}`,
      `error_code=${json?.error_code}`,
      `description="${json?.description}"`
    );
    return {
      ok: false,
      reason: json?.description || `http_${resp.status}`,
      httpStatus: resp.status,
      telegramErrorCode: json?.error_code,
      telegramResponse: json,
    };
  }

  console.log("[Telegram Provider] ✅ Telegram confirmed delivery — message_id:", json.result?.message_id);
  return { ok: true, httpStatus: resp.status, telegramResponse: json };
}

export class TelegramProvider extends BaseProvider {
  static key = "telegram";

  async send({ settings, text, replyMarkup }) {
    const { botToken, chatId, enabled } = settings.telegram || {};
    if (!enabled) {
      console.warn("[Telegram Provider] send() called but channel_disabled (settings.telegram.enabled is false) — no sendMessage attempted.");
      return { ok: false, reason: "channel_disabled" };
    }
    return callTelegramApi(botToken, chatId, text, replyMarkup);
  }

  async testConnection({ settings, testMessage }) {
    const { botToken, chatId } = settings.telegram || {};
    console.log("[Telegram Provider.testConnection] botToken present:", !!botToken, "| chatId:", chatId || "(empty)");
    if (!botToken || !chatId) return { ok: false, reason: "missing_credentials" };
    return callTelegramApi(botToken, chatId, testMessage || "✅ Nesta ERP — test message");
  }
}
