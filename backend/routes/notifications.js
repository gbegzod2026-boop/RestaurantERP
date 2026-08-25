// routes/notifications.js — REST surface for the Notification Center.
// Mirrors the existing routes/delivery.js convention (thin Express handlers
// delegating to backend/notifications/*). The Admin Settings → Notifications
// UI talks to this router; it never touches Telegram/provider internals
// directly.
import express from "express";
import { requirePermission } from "../rbac.js";
import { getNotificationSettings, updateNotificationSettings } from "../notifications/common.js";
import { NotificationService } from "../notifications/NotificationService.js";
import { getProvider } from "../notifications/providerRegistry.js";
import { isSafeId } from "../security/sanitize.js";
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so this file's own reads go through the
// admin-or-client fallback (systemDb.js) instead of the plain client SDK.
import { systemGet } from "../systemDb.js";

const router = express.Router();

function getRestId(req) {
  const raw = req.query.restId || req.body?.restId || req.headers["x-rest-id"] || process.env.DEFAULT_REST_ID || null;
  return raw && isSafeId(String(raw)) ? raw : null;
}

// GET current settings. The bot token is masked (never sent back in full) —
// the Save flow only overwrites it when the admin actually typed a new one
// (see PUT handler: an empty/masked token in the payload keeps the stored one).
router.get("/notifications/settings", requirePermission("notifications", "view", getRestId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const settings = await getNotificationSettings(restId);
  const token = settings.telegram.botToken;
  res.json({
    ...settings,
    telegram: {
      ...settings.telegram,
      botToken: token ? `${"•".repeat(Math.max(0, token.length - 4))}${token.slice(-4)}` : "",
      hasToken: !!token,
    },
  });
});

router.put("/notifications/settings", requirePermission("notifications", "edit", getRestId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const body = req.body || {};
  const patch = {
    enabled: body.enabled !== false,
    types: body.types || {},
    schedule: body.schedule || {},
    largeOrderThreshold: Number(body.largeOrderThreshold || 1000000),
    language: body.language || "uz",
  };

  // Only overwrite the stored token if the admin provided a fresh one
  // (the GET route masks it, so a round-trip Save without editing the field
  // must not clobber the real token with the masked placeholder).
  const existing = await getNotificationSettings(restId);
  const incomingToken = body.telegram?.botToken;
  patch.telegram = {
    chatId: body.telegram?.chatId ?? existing.telegram.chatId,
    enabled: !!body.telegram?.enabled,
    botToken: incomingToken && !incomingToken.includes("•") ? incomingToken : existing.telegram.botToken,
  };

  await updateNotificationSettings(restId, patch);
  res.json({ ok: true });
});

// Test Connection — sends a real Telegram message using whatever is
// currently saved (or, if the admin hasn't hit Save yet, the values passed
// in the request body so "Test" works before "Save").
router.post("/notifications/telegram/test", requirePermission("notifications", "edit", getRestId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const existing = await getNotificationSettings(restId);
  const bodyTokenIsMasked = req.body?.botToken && String(req.body.botToken).includes("•");
  const botToken = req.body?.botToken && !bodyTokenIsMasked ? req.body.botToken : existing.telegram.botToken;
  const chatId = req.body?.chatId || existing.telegram.chatId;

  console.log(
    "[POST /notifications/telegram/test] restId:", restId,
    "| token source:", req.body?.botToken ? (bodyTokenIsMasked ? "body(masked→ignored, using stored)" : "body(fresh)") : "stored",
    "| token present:", !!botToken,
    "| chatId:", chatId || "(empty)"
  );

  const provider = getProvider("telegram");
  const result = await provider.testConnection({
    settings: { telegram: { botToken, chatId } },
    testMessage: "✅ Nesta ERP — Telegram ulanishi muvaffaqiyatli / Успешное подключение / Connection successful",
  });

  console.log("[POST /notifications/telegram/test] result:", JSON.stringify(result));
  res.json(result);
});

// Self-reported employee login/logout — deliberately a SEPARATE, lighter-
// gated endpoint from /trigger below. Every role has "view" on the
// "notifications" module (see backend/rbac.js ROLE_TEMPLATES), but most
// (waiter/chef/cashier) do NOT have "edit" — and a waiter logging in must
// not need admin-level permission just to let the admin know they signed in.
// staffName/role are read from the resolved user record server-side (not
// trusted from the request body) so this can't be used to spoof another
// employee's name.
router.post("/notifications/employee-event", requirePermission("notifications", "view", getRestId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  // Production Security Fix Pass (P0-1): req.nestaAuth is the VERIFIED
  // identity requirePermission() just resolved — reused here instead of the
  // raw x-user-id header so a verified caller can't spoof this header to
  // announce a DIFFERENT employee's name/role in the login notification.
  const userId = req.nestaAuth?.userId;
  const { type } = req.body || {};
  if (type !== "employee_login" && type !== "employee_logout") {
    return res.status(400).json({ error: "unsupported type" });
  }

  const userSnap = await systemGet(`restaurants/${restId}/users/${userId}`);
  const user = userSnap.exists() ? userSnap.val() : {};

  const result = await NotificationService.send(type, restId, null, { staffName: user.name || userId, role: user.role || "" });
  res.json(result);
});

// Generic trigger — for events whose source lives in the frontend or in a
// backend module that doesn't want to import NotificationService directly
// (e.g. a refund confirmed in the Admin Panel UI). Business modules never
// need to know which channel is used; they just describe *what happened*.
router.post("/notifications/trigger", requirePermission("notifications", "edit", getRestId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ error: "type required" });

  const result = await NotificationService.send(type, restId, null, payload || {});
  res.json(result);
});

export default router;
