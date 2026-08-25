// routes/superadminBot.js — panel-facing settings API for the SuperAdmin
// Telegram bot (backend/notifications/SuperAdminBotService.js).
//
// Same storage convention as routes/superadminSettings.js
// (systemData/settings/{tariffs,subscriptionPlans,...}): a single Firebase
// path under systemData/settings, read/written only via systemGet/systemSet
// (Admin SDK, bypasses rules), behind requireSuperAdmin. The bot token is
// masked in every response and only overwritten when the panel actually
// sends a fresh, non-masked value — identical convention to
// superadminSettings.js's paymentApi secretKey handling.
import express from "express";
import { systemGet, systemSet } from "../systemDb.js";
import { requireSuperAdmin } from "../security/requireSuperAdmin.js";
import { sendTestMessage } from "../notifications/SuperAdminBotService.js";

const router = express.Router();
router.use(requireSuperAdmin);

const MASK = "••••••••";
const SETTINGS_PATH = "systemData/settings/superadminBot";

function sanitizeIds(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((v) => String(v).trim()).filter((v) => /^-?\d+$/.test(v)))];
}

// GET /api/superadmin/bot/settings — never returns the real token.
router.get("/settings", async (req, res) => {
  try {
    const snap = await systemGet(SETTINGS_PATH);
    const data = snap.exists() ? snap.val() || {} : {};
    res.json({
      enabled: !!data.enabled,
      allowedTelegramIds: Array.isArray(data.allowedTelegramIds) ? data.allowedTelegramIds : [],
      tokenConfigured: !!data.botToken,
      token: data.botToken ? MASK : "",
      updatedAt: data.updatedAt || null,
    });
  } catch (err) {
    console.error("[superadminBot] settings read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// POST /api/superadmin/bot/settings   body: { token?, enabled, allowedTelegramIds }
router.post("/settings", async (req, res) => {
  try {
    const body = req.body || {};
    const existingSnap = await systemGet(SETTINGS_PATH);
    const existing = existingSnap.exists() ? existingSnap.val() || {} : {};

    const incomingToken = body.token;
    const botToken = (typeof incomingToken === "string" && incomingToken.trim() && !incomingToken.includes("•"))
      ? incomingToken.trim()
      : (existing.botToken || "");

    const newSettings = {
      botToken,
      enabled: body.enabled === true,
      allowedTelegramIds: sanitizeIds(body.allowedTelegramIds),
      updatedAt: Date.now(),
    };

    await systemSet(SETTINGS_PATH, newSettings);
    res.json({
      enabled: newSettings.enabled,
      allowedTelegramIds: newSettings.allowedTelegramIds,
      tokenConfigured: !!newSettings.botToken,
      token: newSettings.botToken ? MASK : "",
      updatedAt: newSettings.updatedAt,
    });
  } catch (err) {
    console.error("[superadminBot] settings write failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// POST /api/superadmin/bot/test — sends a short test message to every
// currently-allowlisted Telegram ID, using whichever token is already
// saved (never accepts a token in the request body — this can only ever
// test the configuration already persisted, not an unsaved draft).
router.post("/test", async (req, res) => {
  try {
    const snap = await systemGet(SETTINGS_PATH);
    const data = snap.exists() ? snap.val() || {} : {};
    if (!data.botToken) return res.status(400).json({ error: "Bot token not configured" });
    const ids = Array.isArray(data.allowedTelegramIds) ? data.allowedTelegramIds : [];
    if (!ids.length) return res.status(400).json({ error: "No allowed Telegram IDs configured" });

    const results = await sendTestMessage(data.botToken, ids, "✅ Nesta ERP — SuperAdmin bot test message");
    const allOk = results.every((r) => r.ok);
    res.json({ ok: allOk, results });
  } catch (err) {
    console.error("[superadminBot] test send failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

export default router;
