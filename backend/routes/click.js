// routes/click.js — Click.uz to'lov integratsiyasi (SHOP-API: Prepare + Complete)
// Hujjat: https://docs.click.uz
import express from "express";
import crypto from "crypto";
import { findOrder, markOrderPaid, splitMerchantTransId, amountsMatch } from "../payments/common.js";
import { safeEqual } from "../security/crypto.js";

const router = express.Router();

// Click error kodlari (https://docs.click.uz)
const CLICK_ERROR = {
  SUCCESS: 0,
  SIGN_CHECK_FAILED: -1,
  INVALID_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  USER_NOT_FOUND: -5,   // bizda: order topilmadi
  TRANSACTION_NOT_FOUND: -6,
  FAILED_TO_UPDATE: -7,
  ERROR_IN_REQUEST: -8,
  TRANSACTION_CANCELLED: -9,
};

const CLICK_SECRET_KEY = process.env.CLICK_SECRET_KEY || "";

// Production Security Fix Pass (Critical): with CLICK_SECRET_KEY unset, the
// hash below is computable by anyone (every other field is attacker-known),
// which is not a real signature check at all. Fail CLOSED instead of
// silently accepting unsigned requests.
if (!CLICK_SECRET_KEY) {
  console.warn("⚠️  [Click] CLICK_SECRET_KEY is not set — the /click/webhook route will reject ALL requests until it is configured in backend/.env.");
}

// Click'dan keladigan sign_string ni tekshiradi.
// Prepare uchun: click_trans_id + service_id + SECRET_KEY + merchant_trans_id + amount + action + sign_time
// Complete uchun: click_trans_id + service_id + SECRET_KEY + merchant_trans_id + merchant_prepare_id + amount + action + sign_time
function verifySign(body) {
  if (!CLICK_SECRET_KEY) return false; // fail closed — see warning above
  const {
    click_trans_id, service_id, merchant_trans_id,
    merchant_prepare_id, amount, action, sign_time, sign_string,
  } = body;

  const parts = [click_trans_id, service_id, CLICK_SECRET_KEY, merchant_trans_id];
  if (action === 1 || action === "1") {
    // Complete so'rovida merchant_prepare_id ham hash ichiga kiradi
    parts.push(merchant_prepare_id);
  }
  parts.push(amount, action, sign_time);

  const expected = crypto.createHash("md5").update(parts.join("")).digest("hex");
  return safeEqual(expected, String(sign_string || ""));
}

// Click bitta URL ga ham Prepare (action=0), ham Complete (action=1) so'rovini yuboradi
router.post("/click/webhook", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const body = req.body;
    const action = Number(body.action);

    if (!verifySign(body)) {
      return res.json({
        click_trans_id: body.click_trans_id,
        merchant_trans_id: body.merchant_trans_id,
        error: CLICK_ERROR.SIGN_CHECK_FAILED,
        error_note: "SIGN CHECK FAILED!",
      });
    }

    const { restId, orderId } = splitMerchantTransId(body.merchant_trans_id);
    if (!restId || !orderId) {
      return res.json({
        click_trans_id: body.click_trans_id,
        merchant_trans_id: body.merchant_trans_id,
        error: CLICK_ERROR.USER_NOT_FOUND,
        error_note: "Order not found (invalid merchant_trans_id)",
      });
    }

    const found = await findOrder(restId, orderId);
    if (!found) {
      return res.json({
        click_trans_id: body.click_trans_id,
        merchant_trans_id: body.merchant_trans_id,
        error: CLICK_ERROR.USER_NOT_FOUND,
        error_note: "Order not found",
      });
    }

    const order = found.data;
    const amountSom = Number(body.amount);

    if (action === 0) {
      // ── PREPARE ──────────────────────────────────────────────────────────
      if (!amountsMatch(amountSom, order.total)) {
        return res.json({
          click_trans_id: body.click_trans_id,
          merchant_trans_id: body.merchant_trans_id,
          error: CLICK_ERROR.INVALID_AMOUNT,
          error_note: "Incorrect amount",
        });
      }
      if (order.status === "paid" || order.status === "closed") {
        return res.json({
          click_trans_id: body.click_trans_id,
          merchant_trans_id: body.merchant_trans_id,
          error: CLICK_ERROR.ALREADY_PAID,
          error_note: "Already paid",
        });
      }

      return res.json({
        click_trans_id: body.click_trans_id,
        merchant_trans_id: body.merchant_trans_id,
        merchant_prepare_id: Date.now(), // bizning tomonimizdagi vaqtinchalik prepare ID
        error: CLICK_ERROR.SUCCESS,
        error_note: "Success",
      });
    }

    if (action === 1) {
      // ── COMPLETE ─────────────────────────────────────────────────────────
      const clickError = Number(body.error);

      if (clickError < 0) {
        // Click tomonidan bekor qilingan/xatolik bo'lgan to'lov
        return res.json({
          click_trans_id: body.click_trans_id,
          merchant_trans_id: body.merchant_trans_id,
          merchant_confirm_id: Date.now(),
          error: CLICK_ERROR.TRANSACTION_CANCELLED,
          error_note: "Transaction cancelled",
        });
      }

      if (!amountsMatch(amountSom, order.total)) {
        return res.json({
          click_trans_id: body.click_trans_id,
          merchant_trans_id: body.merchant_trans_id,
          error: CLICK_ERROR.INVALID_AMOUNT,
          error_note: "Incorrect amount",
        });
      }

      if (order.status !== "paid") {
        await markOrderPaid(restId, orderId, {
          provider: "click",
          providerTransactionId: body.click_trans_id,
          amount: amountSom,
        });
      }

      return res.json({
        click_trans_id: body.click_trans_id,
        merchant_trans_id: body.merchant_trans_id,
        merchant_confirm_id: Date.now(),
        error: CLICK_ERROR.SUCCESS,
        error_note: "Success",
      });
    }

    return res.json({
      click_trans_id: body.click_trans_id,
      merchant_trans_id: body.merchant_trans_id,
      error: CLICK_ERROR.ACTION_NOT_FOUND,
      error_note: "Action not found",
    });
  } catch (err) {
    console.error("[Click webhook] error:", err);
    return res.json({
      error: CLICK_ERROR.ERROR_IN_REQUEST,
      error_note: "Internal error",
    });
  }
});

export default router;