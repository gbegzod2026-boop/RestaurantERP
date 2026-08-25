// aiImportClient.js — thin fetch wrapper around the backend AI Smart Import
// REST API (/api/ai-import/*). Mirrors notificationsClient.js exactly,
// including the x-user-id/x-rest-id header convention (sessionStorage, not
// localStorage — see notificationsClient.js's own comment for why).
//
// Production Security Fix Pass (P0-1): these routes' backend authorization
// used to trust the x-user-id/x-rest-id headers below directly (proven
// live-exploitable — see PRODUCTION-AUDIT.md) and now REQUIRES a verified
// Authorization: Bearer <firebase-id-token> instead — see deliveryClient.js's
// header comment for how getAuth() picks up the current page's session.
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

async function _headers(restId) {
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

export const aiImportClient = {
  async getModules(restId) {
    const res = await fetch(`/api/ai-import/modules?restId=${encodeURIComponent(restId)}`, { headers: await _headers(restId) });
    if (!res.ok) return { manual: [], all: [] };
    return res.json();
  },
  async getSettings(restId) {
    const res = await fetch(`/api/ai-import/settings?restId=${encodeURIComponent(restId)}`, { headers: await _headers(restId) });
    if (!res.ok) return null;
    return res.json();
  },
  async saveSettings(restId, settings) {
    const res = await fetch(`/api/ai-import/settings?restId=${encodeURIComponent(restId)}`, {
      method: "PUT",
      headers: await _headers(restId),
      body: JSON.stringify(settings),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 🆕 admin.js's catch blocks special-case 429 (rate limit) to show a
      // dedicated friendly message instead of the raw backend text — needs
      // the status code preserved on the thrown Error, not just the message.
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  /** Manual mode — rows already parsed client-side. Never touches Gemini. */
  async previewManual(restId, moduleId, rows) {
    const res = await fetch(`/api/ai-import/preview?restId=${encodeURIComponent(restId)}`, {
      method: "POST",
      headers: await _headers(restId),
      body: JSON.stringify({ restId, moduleId, rows }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 🆕 admin.js's catch blocks special-case 429 (rate limit) to show a
      // dedicated friendly message instead of the raw backend text — needs
      // the status code preserved on the thrown Error, not just the message.
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  /** AI mode — module not preselected; parts are Gemini content parts built client-side. */
  async analyzeAi(restId, parts) {
    const res = await fetch(`/api/ai-import/analyze?restId=${encodeURIComponent(restId)}`, {
      method: "POST",
      headers: await _headers(restId),
      body: JSON.stringify({ restId, parts }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 🆕 admin.js's catch blocks special-case 429 (rate limit) to show a
      // dedicated friendly message instead of the raw backend text — needs
      // the status code preserved on the thrown Error, not just the message.
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  /** Legacy single/few-item quick-capture (the original AI Import modal). */
  async quickCapture(restId, type, parts, instruction) {
    const res = await fetch(`/api/ai-import?restId=${encodeURIComponent(restId)}`, {
      method: "POST",
      headers: await _headers(restId),
      body: JSON.stringify({ restId, type, parts, instruction }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 🆕 admin.js's catch blocks special-case 429 (rate limit) to show a
      // dedicated friendly message instead of the raw backend text — needs
      // the status code preserved on the thrown Error, not just the message.
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  async commit(restId, { moduleId, mode, rows, fileName, docType, confidence }) {
    const res = await fetch(`/api/ai-import/commit?restId=${encodeURIComponent(restId)}`, {
      method: "POST",
      headers: await _headers(restId),
      body: JSON.stringify({ restId, moduleId, mode, rows, fileName, docType, confidence }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 🆕 admin.js's catch blocks special-case 429 (rate limit) to show a
      // dedicated friendly message instead of the raw backend text — needs
      // the status code preserved on the thrown Error, not just the message.
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  async getHistory(restId) {
    const res = await fetch(`/api/ai-import/history?restId=${encodeURIComponent(restId)}`, { headers: await _headers(restId) });
    if (!res.ok) return { rows: [] };
    return res.json();
  },
};
