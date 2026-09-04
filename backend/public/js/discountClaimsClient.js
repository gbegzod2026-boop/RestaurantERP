// discountClaimsClient.js — thin fetch wrapper around the backend QR
// one-time discount claim REST API (/api/discount-claims/*). Two shapes in
// one file (unlike notificationsClient.js/aiImportClient.js, which are
// staff-only): `resolve`/`claim` are called by client.js with NO auth
// headers at all (the customer scanning a receipt QR has no staff session —
// see routes/discountClaims.js's own header comment for why that's safe);
// `issue`/`use` are called by waiter.js/kassa.js and need the same
// Authorization: Bearer <firebase-id-token> header every other staff client
// wrapper in this app already sends.
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

async function _staffHeaders(restId) {
  const userId = sessionStorage.getItem("userId") || sessionStorage.getItem("adminId") || "";
  const headers = { "Content-Type": "application/json", "x-user-id": userId, "x-rest-id": restId };
  try {
    const idToken = await getAuth().currentUser?.getIdToken();
    if (idToken) headers["Authorization"] = `Bearer ${idToken}`;
  } catch (_e) { /* no signed-in Firebase session yet — request will 401 */ }
  return headers;
}

export const discountClaimsClient = {
  /** Staff-triggered — called right before/while building a receipt that
   *  should carry the QR. Idempotent per orderId (see claimsService.js). */
  async issue(restId, orderId) {
    const res = await fetch(`/api/discount-claims/issue?restId=${encodeURIComponent(restId)}`, {
      method: "POST",
      headers: await _staffHeaders(restId),
      body: JSON.stringify({ restId, orderId }),
    });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!res.ok || !data.ok) return null;
    return data.claim; // { token, percent, status } | null (QR discount not configured)
  },

  /** Public — the claim landing page (client.js) reads what the QR is worth. */
  async resolve(restId, token) {
    const res = await fetch(`/api/discount-claims/resolve?restId=${encodeURIComponent(restId)}&token=${encodeURIComponent(token)}`);
    return res.json().catch(() => ({ ok: false, reason: "network_error" }));
  },

  /** Public — customer submits their phone to attach the claim to their profile. */
  async claim(restId, token, phone) {
    const res = await fetch(`/api/discount-claims/claim?restId=${encodeURIComponent(restId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restId, token, phone }),
    });
    return res.json().catch(() => ({ ok: false, reason: "network_error" }));
  },

  /** Staff-triggered ONLY — called at the exact moment waiter.js/kassa.js
   *  mark a cash order paid. Gateway (Click/Payme/Uzum) orders never call
   *  this — payments/common.js's markOrderPaid() consumes the claim directly,
   *  backend-to-backend, since that flow has no staff session at all. */
  async use(restId, token, orderId) {
    const res = await fetch(`/api/discount-claims/use?restId=${encodeURIComponent(restId)}`, {
      method: "POST",
      headers: await _staffHeaders(restId),
      body: JSON.stringify({ restId, token, orderId }),
    });
    return res.json().catch(() => ({ ok: false }));
  },

  /** Staff-triggered — Admin → Mijozlar → customer profile → "QR chegirma
   *  berish". No token/QR round-trip — admin already has the phone. */
  async grant(restId, phone, percent, usageLimit) {
    const res = await fetch(`/api/discount-claims/grant?restId=${encodeURIComponent(restId)}`, {
      method: "POST",
      headers: await _staffHeaders(restId),
      body: JSON.stringify({ restId, phone, percent, usageLimit }),
    });
    return res.json().catch(() => ({ ok: false, reason: "network_error" }));
  },
};
