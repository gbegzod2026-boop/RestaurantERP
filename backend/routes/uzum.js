// routes/uzum.js — Uzum Bank to'lov integratsiyasi (Intent API + webhook)
// Hujjat: https://developer.uzumbank.uz
import express from "express";
import crypto from "crypto";
import { findOrder, markOrderPaid, buildMerchantTransId, splitMerchantTransId, amountsMatch } from "../payments/common.js";
import { safeEqual } from "../security/crypto.js";
import { isSafeId } from "../security/sanitize.js";

const router = express.Router();

const UZUM_API_BASE   = process.env.UZUM_API_BASE || "https://api.test.uzumbank.uz"; // sandbox bazasi (rasmiy hujjatdan tekshiring)
const UZUM_SERVICE_ID = process.env.UZUM_SERVICE_ID || "";
const UZUM_API_KEY    = process.env.UZUM_API_KEY || "";       // Intent yaratishda autentifikatsiya uchun
const UZUM_WEBHOOK_SECRET = process.env.UZUM_WEBHOOK_SECRET || ""; // webhook imzosini tekshirish uchun

// P1-7 fix (PRODUCTION-AUDIT.md): without these, POST /payments/uzum/intent
// already fails safely (the real Uzum API rejects the call and the route
// returns 502 — never a fake "payment link created" response), but nothing
// told an operator *why* Uzum checkout is broken until a customer actually
// tried to pay. Matches Click/Payme/the webhook-secret warning below: a
// clear, startup-time signal instead of silent misconfiguration.
if (!UZUM_API_KEY || !UZUM_SERVICE_ID) {
  console.warn("⚠️  [Uzum] UZUM_API_KEY/UZUM_SERVICE_ID is not set — POST /payments/uzum/intent will fail (502) until both are configured in backend/.env.");
}

// P1-7 fix (PRODUCTION-AUDIT.md): this warning used to live only inside
// verifyUzumSignature(), so it fired (repeatedly, once per incoming
// webhook) instead of once at server startup — unlike Click's and Payme's
// equivalent warnings, which are both top-level and print as soon as the
// process boots, giving an operator a clear signal before any real traffic
// arrives. Moved here to match that pattern; verifyUzumSignature() below
// still fails closed the same way it always did.
if (!UZUM_WEBHOOK_SECRET) {
  console.warn("⚠️  [Uzum] UZUM_WEBHOOK_SECRET is not set — the /uzum/webhook route will reject ALL requests until it is configured in backend/.env.");
}

/**
 * Frontend (kassa modal) shu endpointni chaqirib to'lov uchun link oladi.
 * POST /api/payments/uzum/intent  { restId, orderId, amount }
 */
router.post("/payments/uzum/intent", async (req, res) => {
  try {
    const { restId, orderId, amount } = req.body || {};
    if (!restId || !orderId || !amount) {
      return res.status(400).json({ error: "restId, orderId, amount required" });
    }
    if (!isSafeId(String(restId)) || !isSafeId(String(orderId))) {
      return res.status(400).json({ error: "Invalid restId or orderId" });
    }
    if (!(Number(amount) > 0)) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const found = await findOrder(restId, orderId);
    if (!found) return res.status(404).json({ error: "Order not found" });
    if (found.data.status === "paid" || found.data.status === "to'landi" || found.data.payment?.paid === true) {
      return res.status(409).json({ error: "Order is already paid" });
    }
    // The client can technically send any `amount` here (it only drives the
    // Uzum intent payload) — cross-check it against the order's real total
    // so a tampered amount can't create an intent for less than what's owed.
    // (Uzum's own webhook still re-verifies against the order at completion
    // time — see markOrderPaid — this is defense-in-depth, not the only check.)
    if (Math.round(Number(amount)) !== Math.round(Number(found.data.total || 0))) {
      return res.status(400).json({ error: "Amount does not match order total" });
    }

    const clientReferenceId = buildMerchantTransId(restId, orderId);

    const intentPayload = {
      clientReferenceId,
      payments: [
        {
          paymentInstrument: { paymentMethodName: "UzumBankApp" },
          submittedAmount: { value: Number(amount), currency: "UZS" },
          authCurrencyCode: "UZS",
        },
      ],
    };

    const response = await fetch(`${UZUM_API_BASE}/processing/api/v1/intents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Service-Id": UZUM_SERVICE_ID,
        "Authorization": `Bearer ${UZUM_API_KEY}`,
      },
      body: JSON.stringify(intentPayload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("[Uzum intent] xatolik:", data);
      return res.status(502).json({ error: "Uzum intent creation failed", details: data });
    }

    // data ichida to'lov linki bo'ladi (Uzum hujjatiga ko'ra) — frontendga uzatamiz
    return res.json({
      payUrl: data.payUrl || data.link || data.redirectUrl || null,
      intentId: data.intentId || data.id || null,
      raw: data,
    });
  } catch (err) {
    console.error("[Uzum intent] server xatosi:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// Webhook imzosini tekshirish — Uzum hujjatiga ko'ra HMAC-SHA256 bilan beriladi
// (aniq header nomi va algoritm sandbox kabinetida ko'rsatiladi; shu joyni
// kabinetdagi haqiqiy spetsifikatsiyaga moslashtiring)
function verifyUzumSignature(req) {
  if (!UZUM_WEBHOOK_SECRET) {
    // Production Security Fix Pass (Critical): this used to return true
    // (verification disabled) when unset, which let anyone fabricate a
    // "payment succeeded" webhook and mark orders paid for free. Fail
    // CLOSED instead — every request is rejected until a real secret is
    // configured. (Startup-time warning now lives at module load above —
    // see the P1-7 fix comment there.)
    return false;
  }
  const signature = req.headers["x-uzum-signature"] || "";
  const expected = crypto
    .createHmac("sha256", UZUM_WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest("hex");
  return safeEqual(String(signature), expected);
}

/**
 * Uzum tranzaksiya holati o'zgarganda shu URL ga POST yuboradi.
 * Aniq payload strukturasi merchant kabinetidagi hujjatga qarab
 * moslashtirilishi kerak — quyida eng keng tarqalgan shaklga asoslanган.
 */
router.post("/uzum/webhook", async (req, res) => {
  try {
    if (!verifyUzumSignature(req)) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const body = req.body || {};
    const clientReferenceId = body.clientReferenceId || body.orderId || "";
    const status = String(body.status || body.paymentStatus || "").toUpperCase();
    const amount = Number(body.amount?.value || body.amount || 0);
    const transactionId = body.transactionId || body.intentId || body.id;

    const { restId, orderId } = splitMerchantTransId(clientReferenceId);
    if (!restId || !orderId) {
      return res.status(400).json({ error: "Invalid clientReferenceId" });
    }

    const found = await findOrder(restId, orderId);
    if (!found) return res.status(404).json({ error: "Order not found" });

    // Muvaffaqiyatli holatlar uchun odatiy nomlanishlar: SUCCESS, COMPLETED, PAID, CONFIRMED
    const SUCCESS_STATUSES = new Set(["SUCCESS", "COMPLETED", "PAID", "CONFIRMED"]);

    if (SUCCESS_STATUSES.has(status) && found.data.status !== "paid") {
      // P2 fix (PRODUCTION-AUDIT.md #14): Click/Payme both re-check the paid
      // amount against the real order total immediately before marking an
      // order paid (see amountsMatch() calls in routes/click.js,
      // routes/payme.js) — this webhook used to skip that defense-in-depth
      // check and trust body.amount directly. Not currently exploitable
      // without the HMAC secret (verifyUzumSignature() above already fails
      // closed), but this brings Uzum in line with the other two providers'
      // stricter pattern instead of being the one exception.
      if (!amountsMatch(amount, found.data.total)) {
        return res.status(400).json({ error: "Amount does not match order total" });
      }
      await markOrderPaid(restId, orderId, {
        provider: "uzum",
        providerTransactionId: transactionId,
        amount,
      });
    }

    // Uzum odatda 200 OK qaytarishni kutadi, body shart emas
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[Uzum webhook] xatolik:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;