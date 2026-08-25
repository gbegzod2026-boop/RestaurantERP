// routes/payme.js — Payme (Paycom) Merchant API integratsiyasi (JSON-RPC)
// Hujjat: https://developer.help.paycom.uz
import express from "express";
import {
  basePath, findOrder, markOrderPaid, splitMerchantTransId, amountsMatch, tiyinToSom,
} from "../payments/common.js";
import { safeEqual } from "../security/crypto.js";
import { isSafeId } from "../security/sanitize.js";
import { systemSet, systemGet, systemUpdate } from "../systemDb.js";

const router = express.Router();

// Payme JSON-RPC error kodlari
const PAYME_ERROR = {
  INVALID_AMOUNT: -31001,
  ACCOUNT_NOT_FOUND: -31050, // -31050 dan -31099 gacha bo'lgan diapazon
  TRANSACTION_NOT_FOUND: -31003,
  CANT_CANCEL: -31007,
  CANT_PERFORM: -31008,
  ALREADY_DONE: -31060,
  SYSTEM_ERROR: -32400,
  INSUFFICIENT_PRIVILEGE: -32504,
  PARSE_ERROR: -32700,
};

// Payme tranzaksiya holatlari
const STATE = {
  CREATED: 1,
  COMPLETED: 2,
  CANCELLED: -1,
  CANCELLED_AFTER_COMPLETE: -2,
};

const PAYME_KEY = process.env.PAYME_KEY || ""; // Merchant key (test yoki production)
const TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 soat — Payme standartiga ko'ra

// Production Security Fix Pass (Critical): when PAYME_KEY is unset,
// safeEqual("", "") used to return true, so checkAuth() accepted ANY Basic
// Auth request with an empty password — a forged webhook could mark orders
// paid with no real signature check at all. Fail CLOSED instead: every call
// is rejected until a real key is configured, logged loudly so a missing
// key can never be missed silently in production.
if (!PAYME_KEY) {
  console.warn("⚠️  [Payme] PAYME_KEY is not set — the /payme/webhook route will reject ALL requests until it is configured in backend/.env.");
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

// Basic Auth tekshiruvi: login har doim "Paycom", parol = PAYME_KEY
function checkAuth(req) {
  if (!PAYME_KEY) return false; // fail closed — see warning above
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const [login, password] = decoded.split(":");
  return login === "Paycom" && safeEqual(password || "", PAYME_KEY);
}

// account.order_id "restId:orderId" formatida keladi (frontendda shunday yaratiladi)
function parseAccount(account) {
  const raw = account?.order_id || account?.orderId || "";
  return splitMerchantTransId(raw);
}

// Firebase'da Payme tranzaksiyalarini alohida saqlaymiz (idempotentlik va
// CheckTransaction/CancelTransaction uchun)
async function getPaymeTx(restId, paymeTxId) {
  const snap = await systemGet(`${basePath(restId)}/paymeTransactions/${paymeTxId}`);
  return snap.exists() ? snap.val() : null;
}
async function savePaymeTx(restId, paymeTxId, data) {
  await systemSet(`${basePath(restId)}/paymeTransactions/${paymeTxId}`, data);
}
async function updatePaymeTx(restId, paymeTxId, data) {
  await systemUpdate(`${basePath(restId)}/paymeTransactions/${paymeTxId}`, data);
}

/**
 * Payme faqat o'zining tranzaksiya ID'sini (params.id) yuboradi — qaysi
 * restoranga tegishli ekanini bilmaymiz. Shu sababli CreateTransaction
 * vaqtida systemData/paymeTxIndex/{paymeTxId} -> {restId, orderId} index
 * yozamiz va keyingi chaqiruvlarda shundan foydalanamiz.
 */
async function locatePaymeTx(paymeTxId) {
  // systemData/* is closed to every client by database.rules.json (Phase 1)
  // — systemGet()/systemSet() write via the Admin SDK (bypasses rules) when
  // available, or the legacy client SDK otherwise. See systemDb.js.
  const idxSnap = await systemGet(`systemData/paymeTxIndex/${paymeTxId}`);
  if (!idxSnap.exists()) return null;
  const { restId, orderId } = idxSnap.val();
  const tx = await getPaymeTx(restId, paymeTxId);
  if (!tx) return null;
  return { restId, orderId, tx };
}

router.post("/payme/webhook", async (req, res) => {
  if (!checkAuth(req)) {
    return res.json(rpcError(req.body?.id ?? null, PAYME_ERROR.INSUFFICIENT_PRIVILEGE, "Insufficient privileges"));
  }

  const { method, params, id } = req.body || {};

  // params.id (Payme's own transaction id) is used as a Firebase path key
  // below (paymeTransactions/{id}, systemData/paymeTxIndex/{id}) — validated
  // the same way every other id in this app is before touching the DB.
  if (params?.id != null && !isSafeId(String(params.id))) {
    return res.json(rpcError(id, PAYME_ERROR.TRANSACTION_NOT_FOUND, "Invalid transaction id"));
  }

  try {
    switch (method) {
      case "CheckPerformTransaction": {
        const { restId, orderId } = parseAccount(params.account);
        const found = restId && orderId ? await findOrder(restId, orderId) : null;

        if (!found) {
          return res.json(rpcError(id, PAYME_ERROR.ACCOUNT_NOT_FOUND, "Order not found"));
        }
        const orderAmountSom = Number(found.data.total || 0);
        if (!amountsMatch(tiyinToSom(params.amount), orderAmountSom)) {
          return res.json(rpcError(id, PAYME_ERROR.INVALID_AMOUNT, "Incorrect amount"));
        }
        return res.json(rpcResult(id, { allow: true }));
      }

      case "CreateTransaction": {
        const { restId, orderId } = parseAccount(params.account);
        const found = restId && orderId ? await findOrder(restId, orderId) : null;

        if (!found) {
          return res.json(rpcError(id, PAYME_ERROR.ACCOUNT_NOT_FOUND, "Order not found"));
        }

        const existing = await getPaymeTx(restId, params.id);

        if (existing) {
          // Qayta yuborilgan so'rov — bir xil javobni qaytarish kerak
          if (existing.state !== STATE.CREATED) {
            return res.json(rpcError(id, PAYME_ERROR.CANT_PERFORM, "Transaction state invalid"));
          }
          if (Date.now() - existing.create_time > TIMEOUT_MS) {
            await updatePaymeTx(restId, params.id, { state: STATE.CANCELLED, reason: 4, cancel_time: Date.now() });
            return res.json(rpcError(id, PAYME_ERROR.CANT_PERFORM, "Transaction timed out"));
          }
          return res.json(rpcResult(id, {
            create_time: existing.create_time,
            transaction: orderId,
            state: STATE.CREATED,
          }));
        }

        const orderAmountSom = Number(found.data.total || 0);
        if (!amountsMatch(tiyinToSom(params.amount), orderAmountSom)) {
          return res.json(rpcError(id, PAYME_ERROR.INVALID_AMOUNT, "Incorrect amount"));
        }
        if (found.data.status === "paid" || found.data.status === "closed") {
          return res.json(rpcError(id, PAYME_ERROR.CANT_PERFORM, "Order already paid"));
        }

        const createTime = Date.now();
        await savePaymeTx(restId, params.id, {
          paymeTxId: params.id,
          restId, orderId,
          amount: params.amount,
          state: STATE.CREATED,
          create_time: createTime,
        });
        // Index yozish — keyingi PerformTransaction/CancelTransaction/CheckTransaction
        // chaqiruvlari faqat params.id bilan keladi
        await systemSet(`systemData/paymeTxIndex/${params.id}`, { restId, orderId });

        return res.json(rpcResult(id, {
          create_time: createTime,
          transaction: orderId,
          state: STATE.CREATED,
        }));
      }

      case "PerformTransaction": {
        const located = await locatePaymeTx(params.id);
        if (!located) {
          return res.json(rpcError(id, PAYME_ERROR.TRANSACTION_NOT_FOUND, "Transaction not found"));
        }
        const { restId, orderId, tx } = located;

        if (tx.state === STATE.COMPLETED) {
          return res.json(rpcResult(id, { transaction: orderId, perform_time: tx.perform_time, state: STATE.COMPLETED }));
        }
        if (tx.state !== STATE.CREATED) {
          return res.json(rpcError(id, PAYME_ERROR.CANT_PERFORM, "Transaction not in created state"));
        }
        if (Date.now() - tx.create_time > TIMEOUT_MS) {
          await updatePaymeTx(restId, params.id, { state: STATE.CANCELLED, reason: 4, cancel_time: Date.now() });
          return res.json(rpcError(id, PAYME_ERROR.CANT_PERFORM, "Transaction timed out"));
        }

        const performTime = Date.now();
        await updatePaymeTx(restId, params.id, { state: STATE.COMPLETED, perform_time: performTime });
        await markOrderPaid(restId, orderId, {
          provider: "payme",
          providerTransactionId: params.id,
          amount: tiyinToSom(tx.amount),
        });

        return res.json(rpcResult(id, { transaction: orderId, perform_time: performTime, state: STATE.COMPLETED }));
      }

      case "CancelTransaction": {
        const located = await locatePaymeTx(params.id);
        if (!located) {
          return res.json(rpcError(id, PAYME_ERROR.TRANSACTION_NOT_FOUND, "Transaction not found"));
        }
        const { restId, orderId, tx } = located;

        const newState = tx.state === STATE.COMPLETED ? STATE.CANCELLED_AFTER_COMPLETE : STATE.CANCELLED;
        const cancelTime = tx.cancel_time || Date.now();

        if (tx.state !== STATE.CANCELLED && tx.state !== STATE.CANCELLED_AFTER_COMPLETE) {
          await updatePaymeTx(restId, params.id, { state: newState, reason: params.reason || 0, cancel_time: cancelTime });
        }

        return res.json(rpcResult(id, { transaction: orderId, cancel_time: cancelTime, state: newState }));
      }

      case "CheckTransaction": {
        const located = await locatePaymeTx(params.id);
        if (!located) {
          return res.json(rpcError(id, PAYME_ERROR.TRANSACTION_NOT_FOUND, "Transaction not found"));
        }
        const { orderId, tx } = located;
        return res.json(rpcResult(id, {
          create_time: tx.create_time,
          perform_time: tx.perform_time || 0,
          cancel_time: tx.cancel_time || 0,
          transaction: orderId,
          state: tx.state,
          reason: tx.reason ?? null,
        }));
      }

      default:
        return res.json(rpcError(id, PAYME_ERROR.PARSE_ERROR, "Method not found"));
    }
  } catch (err) {
    console.error("[Payme webhook] error:", err);
    return res.json(rpcError(req.body?.id ?? null, PAYME_ERROR.SYSTEM_ERROR, "System error"));
  }
});

export default router;