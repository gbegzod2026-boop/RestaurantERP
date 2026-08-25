// routes/paymentsInit.js — Click va Payme uchun to'lov havolasi generatsiya qiladigan endpoint
// Frontend (kassa bottom-sheet) shu endpointni chaqirib, foydalanuvchini
// tegishli to'lov tizimi sahifasiga yo'naltiradi.
import express from "express";
import { findOrder, buildMerchantTransId } from "../payments/common.js";
import { isSafeId } from "../security/sanitize.js";

const router = express.Router();

const CLICK_SERVICE_ID  = process.env.CLICK_SERVICE_ID  || "";
const CLICK_MERCHANT_ID = process.env.CLICK_MERCHANT_ID || "";
const PAYME_MERCHANT_ID = process.env.PAYME_MERCHANT_ID || ""; // Payme kabinetidan olingan "kassa" ID
const PUBLIC_RETURN_URL = process.env.PAYMENT_RETURN_URL || ""; // to'lovdan keyin qaytariladigan sahifa

/**
 * POST /api/payments/init
 * body: { provider: "click" | "payme" | "uzum", restId, orderId }
 * Uzum uchun /api/payments/uzum/intent dan foydalaniladi (alohida, chunki
 * Uzum to'lov havolasini server tomonida intent orqali oladi).
 */
// Production Security Fix Pass, Phase 2 (High: missing server validation).
// Intentionally NOT gated by requirePermission() — this is called from the
// anonymous customer-facing checkout flow (client.js), which has no staff
// login at all, so there is no employee identity to check here. What was
// missing was strict input shape validation (restId/orderId become part of
// a Firebase path lookup via findOrder — same isSafeId discipline every
// other route in this app already applies) and a guard against generating
// a fresh payment link for an order that's already been paid.
const ALLOWED_PROVIDERS = new Set(["click", "payme"]);

router.post("/payments/init", async (req, res) => {
  try {
    const { provider, restId, orderId } = req.body || {};
    if (!provider || !restId || !orderId) {
      return res.status(400).json({ error: "provider, restId, orderId required" });
    }
    if (!isSafeId(String(restId)) || !isSafeId(String(orderId))) {
      return res.status(400).json({ error: "Invalid restId or orderId" });
    }
    if (!ALLOWED_PROVIDERS.has(String(provider))) {
      return res.status(400).json({ error: "Unsupported provider. Use 'uzum' via /api/payments/uzum/intent instead." });
    }

    const found = await findOrder(restId, orderId);
    if (!found) return res.status(404).json({ error: "Order not found" });
    if (found.data.status === "paid" || found.data.status === "to'landi" || found.data.payment?.paid === true) {
      return res.status(409).json({ error: "Order is already paid" });
    }

    const amount = Number(found.data.total || 0);
    if (!(amount > 0)) {
      return res.status(400).json({ error: "Order has no payable amount" });
    }
    const merchantTransId = buildMerchantTransId(restId, orderId);

    if (provider === "click") {
      const url = new URL("https://my.click.uz/services/pay");
      url.searchParams.set("service_id", CLICK_SERVICE_ID);
      url.searchParams.set("merchant_id", CLICK_MERCHANT_ID);
      url.searchParams.set("amount", String(amount));
      url.searchParams.set("transaction_param", merchantTransId);
      if (PUBLIC_RETURN_URL) url.searchParams.set("return_url", PUBLIC_RETURN_URL);
      return res.json({ payUrl: url.toString() });
    }

    if (provider === "payme") {
      // Payme checkout linki base64 qilingan parametrlardan iborat
      const params = `m=${PAYME_MERCHANT_ID};ac.order_id=${merchantTransId};a=${Math.round(amount * 100)}`;
      const encoded = Buffer.from(params, "utf8").toString("base64");
      return res.json({ payUrl: `https://checkout.paycom.uz/${encoded}` });
    }

    return res.status(400).json({ error: "Unsupported provider. Use 'uzum' via /api/payments/uzum/intent instead." });
  } catch (err) {
    console.error("[payments/init] xatolik:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;