// routes/discountClaims.js — QR one-time customer discount claims REST
// surface. Mirrors routes/notifications.js / routes/aiImport.js's own
// convention (thin Express handlers delegating to backend/discountClaims/*).
//
// Two of these routes are deliberately PUBLIC (no requirePermission) — the
// customer scanning a receipt QR has no staff session at all. Security here
// comes from: unguessable tokens (crypto.randomBytes, see claimsService.js),
// restId scoping baked into every path, and a dedicated rate limiter (this
// is the one genuinely public, unauthenticated surface in the whole app
// besides the payment webhooks and the landing page's public-stats route).
import express from "express";
import rateLimit from "express-rate-limit";
import { requirePermission } from "../rbac.js";
import { isSafeId } from "../security/sanitize.js";
import {
  issueClaimForOrder, resolveClaim, claimForPhone, useClaim, grantDiscountToPhone,
} from "../discountClaims/claimsService.js";

const router = express.Router();

function getRestId(req) {
  const raw = req.query.restId || req.body?.restId || req.headers["x-rest-id"] || process.env.DEFAULT_REST_ID || null;
  return raw && isSafeId(String(raw)) ? raw : null;
}

// Public claim-page traffic — generous enough for real customers scanning/
// retrying, tight enough to bound token-guessing (tokens are 32-byte random,
// so this is defense-in-depth, not the primary protection).
const publicClaimLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => res.status(429).json({ ok: false, error: "ai_import_err_rate_limited" }),
});

// ── Staff-triggered — issuing a claim happens when a receipt with the QR is
// built (waiter/kassa/admin print flow). Gated on the existing "customers"
// module's "edit" action (same action already granted to waiter/cashier/
// manager/owner for personal-discount edits — no new RBAC action invented).
router.post("/discount-claims/issue", requirePermission("customers", "edit", getRestId), async (req, res) => {
  const restId = getRestId(req);
  const { orderId } = req.body || {};
  if (!restId || !orderId) return res.status(400).json({ error: "restId and orderId required" });
  try {
    const result = await issueClaimForOrder(restId, orderId);
    res.json({ ok: true, claim: result }); // claim is null when QR discounts aren't configured — not an error
  } catch (err) {
    console.error("[discountClaims] /issue error:", err.message);
    res.status(500).json({ ok: false, error: "discount_claim_err_issue_failed" });
  }
});

// ── Public — the claim landing page reads the claim to render "🎁 10% chegirma".
router.get("/discount-claims/resolve", publicClaimLimiter, async (req, res) => {
  const restId = getRestId(req);
  const token = req.query.token;
  if (!restId || !token) return res.status(400).json({ ok: false, reason: "invalid_request" });
  const result = await resolveClaim(restId, String(token));
  res.json(result);
});

// ── Public — customer submits their phone to attach the claim.
router.post("/discount-claims/claim", publicClaimLimiter, async (req, res) => {
  const restId = getRestId(req);
  const { token, phone } = req.body || {};
  if (!restId || !token || !phone) return res.status(400).json({ ok: false, reason: "invalid_request" });
  const result = await claimForPhone(restId, String(token), String(phone));
  res.json(result);
});

// ── Staff-triggered — Admin → Mijozlar → customer profile → "QR chegirma
// berish". No QR/token round-trip needed (admin already has the phone in
// front of them) — same "customers"/"edit" gate as /issue above.
router.post("/discount-claims/grant", requirePermission("customers", "edit", getRestId), async (req, res) => {
  const restId = getRestId(req);
  const { phone, percent, usageLimit } = req.body || {};
  if (!restId || !phone) return res.status(400).json({ ok: false, reason: "invalid_request" });
  const result = await grantDiscountToPhone(restId, String(phone), percent, usageLimit);
  res.json(result);
});

// ── Staff-triggered ONLY — called by waiter.js/kassa.js at the exact moment
// they mark an order paid (cash). Gateway payments (Click/Payme/Uzum) never
// call this route — payments/common.js's markOrderPaid() calls useClaim()
// directly (backend-to-backend, no HTTP hop) since that flow has no staff
// session at all. This is the "payment-authoritative flow" spec §33 requires
// — never callable by an unauthenticated customer request.
router.post("/discount-claims/use", requirePermission("orders", "edit", getRestId), async (req, res) => {
  const restId = getRestId(req);
  const { token, orderId } = req.body || {};
  if (!restId || !token || !orderId) return res.status(400).json({ ok: false, reason: "invalid_request" });
  const result = await useClaim(restId, String(token), String(orderId));
  res.json(result);
});

export default router;
