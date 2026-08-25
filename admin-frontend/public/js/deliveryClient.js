// deliveryClient.js — thin fetch wrapper around the backend Delivery Engine
// REST API (/api/delivery/*). Used by courier.js and admin.js instead of
// writing delivery/assignment status directly to Firebase RTDB, so the
// provider-selection logic, Yandex Go calls, and Telegram notifications all
// stay server-side. Realtime reads still go through Firebase onValue()
// listeners, unchanged — this module only covers writes/transitions.
//
// Production Security Fix Pass (P0-1): these routes' backend authorization
// used to trust the x-user-id/x-rest-id headers below directly (proven
// live-exploitable — see PRODUCTION-AUDIT.md) and now REQUIRES a verified
// Authorization: Bearer <firebase-id-token> instead. getAuth() (no app arg)
// picks up whatever Firebase app the current page already initialized —
// login.js's signInWithCustomToken() at login time is what makes
// auth.currentUser non-null here. x-user-id/x-rest-id are kept only as
// non-authoritative routing context (the backend no longer trusts them for
// identity), for any log line or legacy code path that still reads them.
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

async function _headers(restId) {
  const userId = localStorage.getItem("userId") || "";
  const headers = {
    "Content-Type": "application/json",
    "x-user-id": userId,
    "x-rest-id": restId,
  };
  try {
    const idToken = await getAuth().currentUser?.getIdToken();
    if (idToken) headers["Authorization"] = `Bearer ${idToken}`;
  } catch (_e) { /* no signed-in Firebase session yet — request will 401, same as before this fix for an unauthenticated caller */ }
  return headers;
}

async function _postJson(url, restId, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: await _headers(restId),
    body: JSON.stringify({ restId, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export const deliveryClient = {
  assign(restId, orderId, courierId = null) {
    return _postJson(`/api/delivery/${orderId}/assign`, restId, { courierId });
  },
  updateStatus(restId, orderId, status, actor = "courier") {
    return _postJson(`/api/delivery/${orderId}/status`, restId, { status, actor });
  },
  reject(restId, orderId, courierId, reason = "") {
    return _postJson(`/api/delivery/${orderId}/reject`, restId, { courierId, reason });
  },
  retry(restId, orderId) {
    return _postJson(`/api/delivery/${orderId}/retry`, restId, {});
  },
  async get(restId, orderId) {
    const res = await fetch(`/api/delivery/${orderId}?restId=${encodeURIComponent(restId)}`, {
      headers: await _headers(restId),
    });
    if (!res.ok) return null;
    return res.json();
  },
  setCourierStatus(restId, courierId, status) {
    return _postJson(`/api/delivery/couriers/${courierId}/status`, restId, { status });
  },
};
