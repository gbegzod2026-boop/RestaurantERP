// notificationsClient.js — thin fetch wrapper around the backend Notification
// Center REST API (/api/notifications/*). Mirrors deliveryClient.js exactly:
// the Admin Panel never writes Telegram bot token/chat id straight to
// Firebase RTDB (unlike deliverySettings' historical pattern) — it goes
// through the backend so the token can be masked on read and validated on
// write, per spec section 2 ("Bot Token and Chat ID must be stored securely").
//
// Production Security Fix Pass (P0-1): these routes' backend authorization
// used to trust the x-user-id/x-rest-id headers below directly (proven
// live-exploitable — see PRODUCTION-AUDIT.md) and now REQUIRES a verified
// Authorization: Bearer <firebase-id-token> instead — see deliveryClient.js's
// header comment for how getAuth() picks up the current page's session.
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

async function _headers(restId) {
  // admin.js authenticates every backend call via x-user-id resolved from
  // sessionStorage (see admin.js:223 `sessionStorage.getItem("userId")`),
  // NOT localStorage — that's the convention used by courier.js/kassa.js
  // instead. Also covers the ?viewAs= impersonation flow, which admin.js
  // writes into sessionStorage (admin.js:214). Kept as non-authoritative
  // routing context only — the backend no longer trusts either header for
  // identity; the Authorization header below is what it actually checks.
  const userId = sessionStorage.getItem("userId") || sessionStorage.getItem("adminId") || "";
  const headers = {
    "Content-Type": "application/json",
    "x-user-id": userId,
    "x-rest-id": restId,
  };
  try {
    const idToken = await getAuth().currentUser?.getIdToken();
    if (idToken) headers["Authorization"] = `Bearer ${idToken}`;
  } catch (_e) { /* no signed-in Firebase session yet — request will 401 */ }
  return headers;
}

export const notificationsClient = {
  async getSettings(restId) {
    const res = await fetch(`/api/notifications/settings?restId=${encodeURIComponent(restId)}`, { headers: await _headers(restId) });
    if (!res.ok) return null;
    return res.json();
  },
  async saveSettings(restId, settings) {
    const res = await fetch(`/api/notifications/settings?restId=${encodeURIComponent(restId)}`, {
      method: "PUT",
      headers: await _headers(restId),
      body: JSON.stringify(settings),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  },
  async testTelegram(restId, { botToken, chatId }) {
    const res = await fetch(`/api/notifications/telegram/test?restId=${encodeURIComponent(restId)}`, {
      method: "POST",
      headers: await _headers(restId),
      body: JSON.stringify({ botToken, chatId }),
    });
    return res.json().catch(() => ({ ok: false, reason: "invalid_response" }));
  },
  async trigger(restId, type, payload) {
    const res = await fetch(`/api/notifications/trigger?restId=${encodeURIComponent(restId)}`, {
      method: "POST",
      headers: await _headers(restId),
      body: JSON.stringify({ type, payload }),
    });
    return res.json().catch(() => ({ ok: false }));
  },
};
