// routes/superadminSettings.js — Superadmin systemData migration, Stage 2:
// Settings (tariffs, subscriptionPlans, paymentApi, receiptPhone).
//
// systemData/settings/{tariffs,subscriptionPlans,paymentApi,receiptPhone}
// were read/written directly via the client SDK (listenSystemSettings/
// saveTariffSettings, listenDiscountSettings/saveDiscountSettings,
// loadPaymentApiSettings/savePaymentApiSettings, listenReceiptPhone/
// saveReceiptPhone) — all denied now by database.rules.json's systemData
// lockdown.
//
// paymentApi additionally gets a real security fix, not just a permission
// fix: it used to send Payme/Click/Uzum secretKey values to the browser in
// full (loadPaymentApiSettings() wrote them straight into visible <input>
// fields) so an admin could see/edit them. GET /settings/payment-api below
// now NEVER returns a secretKey — only `configured: true/false` per
// provider — and POST only overwrites a provider's stored secretKey when
// the admin actually typed a fresh one; the masked placeholder
// ("••••••••") round-trips back unchanged, exactly the same convention
// routes/notifications.js already uses for its Telegram bot token.
import express from "express";
import { systemGet, systemSet, systemUpdate, systemRemove, systemTransaction } from "../systemDb.js";
import { requireSuperAdmin } from "../security/requireSuperAdmin.js";
import { invalidatePlatformInfoCache } from "./publicStats.js";

const router = express.Router();
router.use(requireSuperAdmin);

const MASK = "••••••••";

// ─── Tariffs ─────────────────────────────────────────────────────────────
router.get("/tariffs", async (req, res) => {
  try {
    const snap = await systemGet("systemData/settings/tariffs");
    res.json(snap.exists() ? snap.val() : null);
  } catch (err) {
    console.error("[superadminSettings] tariffs read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/tariffs", async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Invalid payload" });
    }
    await systemSet("systemData/settings/tariffs", body);
    res.json({ ok: true });
  } catch (err) {
    console.error("[superadminSettings] tariffs write failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// ─── Subscription plans (discount packages) ──────────────────────────────
router.get("/subscription-plans", async (req, res) => {
  try {
    const snap = await systemGet("systemData/settings/subscriptionPlans");
    res.json(snap.exists() ? snap.val() : null);
  } catch (err) {
    console.error("[superadminSettings] subscription-plans read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/subscription-plans", async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Invalid payload" });
    }
    await systemSet("systemData/settings/subscriptionPlans", body);
    res.json({ ok: true });
  } catch (err) {
    console.error("[superadminSettings] subscription-plans write failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// ─── Receipt phone ────────────────────────────────────────────────────────
router.get("/receipt-phone", async (req, res) => {
  try {
    const snap = await systemGet("systemData/settings/receiptPhone");
    res.json({ phone: snap.exists() ? snap.val() : "" });
  } catch (err) {
    console.error("[superadminSettings] receipt-phone read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/receipt-phone", async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").slice(0, 40);
    await systemSet("systemData/settings/receiptPhone", phone);
    res.json({ ok: true });
  } catch (err) {
    console.error("[superadminSettings] receipt-phone write failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// ─── Platform settings (name / support email / support phone) ───────────
// Root-cause fix: superadmin.html's savePlatformSettings()/
// _listenPlatformSettings() used to read/write systemData/platform DIRECTLY
// with the client SDK — silently denied by database.rules.json's
// unconditional systemData lockdown ("permission_denied" in the browser
// console, confirmed live). Same systemGet/systemSet migration this file
// already did for tariffs/subscriptionPlans/receiptPhone/paymentApi above.
router.get("/platform", async (req, res) => {
  try {
    // One-time migration, preserved from the old client-side logic: an
    // even older path (systemData/settings/platform) may still hold real
    // values from before that logic itself was broken by the systemData
    // lockdown (it used the same denied client-SDK read, so it never
    // actually ran once rules went live) — copy it forward exactly once,
    // via a transaction so a concurrent save from this same panel can never
    // be clobbered by it.
    const oldSnap = await systemGet("systemData/settings/platform");
    if (oldSnap.exists()) {
      const old = oldSnap.val() || {};
      await systemTransaction("systemData/platform", (current) => {
        if (current) return undefined; // abort — already populated, don't overwrite
        return { name: old.name || "", supportEmail: old.supportEmail || "", supportPhone: old.supportPhone || "" };
      });
    }

    const snap = await systemGet("systemData/platform");
    const data = snap.exists() ? snap.val() || {} : {};
    res.json({
      name: data.name || "",
      supportEmail: data.supportEmail || "",
      supportPhone: data.supportPhone || "",
      address: data.address || "",
      logoConfigured: !!data.logo,
    });
  } catch (err) {
    console.error("[superadminSettings] platform read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/platform", async (req, res) => {
  try {
    const body = req.body || {};
    const data = {
      name: String(body.name || "").slice(0, 200),
      supportEmail: String(body.supportEmail || "").slice(0, 200),
      supportPhone: String(body.supportPhone || "").slice(0, 60),
      address: String(body.address || "").slice(0, 300),
    };
    // update() (not set()) — a plain overwrite here would wipe out `logo`,
    // which is written independently via /platform-logo below.
    await systemUpdate("systemData/platform", data);
    invalidatePlatformInfoCache(); // landing page sees this save immediately, not after up to 5min
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("[superadminSettings] platform write failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// ─── Platform logo (site header/footer branding — base64 data URL) ──────
// Separate from receipt-logo above (that one is for printed receipts only).
// Public landing page reads name/logo/contact info via GET /api/public/
// platform-info (routes/publicStats.js) — never this superadmin-gated path.
router.get("/platform-logo", async (req, res) => {
  try {
    const snap = await systemGet("systemData/platform/logo");
    res.json({ dataUrl: snap.exists() ? snap.val() || null : null });
  } catch (err) {
    console.error("[superadminSettings] platform-logo read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/platform-logo", async (req, res) => {
  try {
    const dataUrl = String(req.body?.dataUrl || "");
    if (!dataUrl.startsWith("data:image/")) {
      return res.status(400).json({ error: "Invalid image data" });
    }
    await systemSet("systemData/platform/logo", dataUrl);
    invalidatePlatformInfoCache();
    res.json({ ok: true });
  } catch (err) {
    console.error("[superadminSettings] platform-logo write failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/platform-logo/remove", async (req, res) => {
  try {
    await systemRemove("systemData/platform/logo");
    invalidatePlatformInfoCache();
    res.json({ ok: true });
  } catch (err) {
    console.error("[superadminSettings] platform-logo remove failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// ─── Receipt footer text ──────────────────────────────────────────────────
// Same root cause as /platform above — was a direct client-SDK write to
// systemData/settings/receiptFooter.
router.get("/receipt-footer", async (req, res) => {
  try {
    const snap = await systemGet("systemData/settings/receiptFooter");
    res.json({ text: snap.exists() ? snap.val() || "" : "" });
  } catch (err) {
    console.error("[superadminSettings] receipt-footer read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/receipt-footer", async (req, res) => {
  try {
    const text = String(req.body?.text || "").slice(0, 500);
    await systemSet("systemData/settings/receiptFooter", text);
    res.json({ ok: true, text });
  } catch (err) {
    console.error("[superadminSettings] receipt-footer write failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// ─── Receipt logo (base64 data URL) ───────────────────────────────────────
// Same root cause as /platform above — was a direct client-SDK
// set()/remove() to systemData/settings/receiptLogo. The 300KB size cap is
// already enforced client-side (previewReceiptLogo()) before the image is
// ever read into a data URL; express.json()'s 20mb body limit (server.js)
// comfortably covers a base64-encoded 300KB image on top of that.
router.get("/receipt-logo", async (req, res) => {
  try {
    const snap = await systemGet("systemData/settings/receiptLogo");
    res.json({ dataUrl: snap.exists() ? snap.val() || null : null });
  } catch (err) {
    console.error("[superadminSettings] receipt-logo read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/receipt-logo", async (req, res) => {
  try {
    const dataUrl = String(req.body?.dataUrl || "");
    if (!dataUrl.startsWith("data:image/")) {
      return res.status(400).json({ error: "Invalid image data" });
    }
    await systemSet("systemData/settings/receiptLogo", dataUrl);
    res.json({ ok: true });
  } catch (err) {
    console.error("[superadminSettings] receipt-logo write failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/receipt-logo/remove", async (req, res) => {
  try {
    await systemRemove("systemData/settings/receiptLogo");
    res.json({ ok: true });
  } catch (err) {
    console.error("[superadminSettings] receipt-logo remove failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// ─── Security settings (session timeout / login attempts / min password) ──
router.get("/security", async (req, res) => {
  try {
    const snap = await systemGet("systemData/settings/security");
    const data = snap.exists() ? snap.val() || {} : {};
    res.json({
      sessionTimeout: data.sessionTimeout ?? 30,
      loginAttemptsLimit: data.loginAttemptsLimit ?? 5,
      minPasswordLength: data.minPasswordLength ?? 8,
    });
  } catch (err) {
    console.error("[superadminSettings] security read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/security", async (req, res) => {
  try {
    const body = req.body || {};
    const data = {
      sessionTimeout: Number(body.sessionTimeout) || 30,
      loginAttemptsLimit: Number(body.loginAttemptsLimit) || 5,
      minPasswordLength: Number(body.minPasswordLength) || 8,
    };
    await systemSet("systemData/settings/security", data);
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error("[superadminSettings] security write failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// ─── Backups (read-only listing) ──────────────────────────────────────────
router.get("/backups", async (req, res) => {
  try {
    const snap = await systemGet("systemData/backups");
    res.json(snap.exists() ? snap.val() || {} : {});
  } catch (err) {
    console.error("[superadminSettings] backups read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// ─── Payment API (Payme/Click/Uzum) — secret-masked ──────────────────────
function maskProvider(p) {
  if (!p) return { merchantId: "", serviceId: "", checkoutUrl: "", configured: false };
  return {
    merchantId: p.merchantId || "",
    serviceId: p.serviceId || "",
    checkoutUrl: p.checkoutUrl || "",
    configured: !!p.secretKey,
  };
}

router.get("/payment-api", async (req, res) => {
  try {
    const snap = await systemGet("systemData/settings/paymentApi");
    const data = snap.exists() ? snap.val() : {};
    res.json({
      payme: maskProvider(data.payme),
      click: maskProvider(data.click),
      uzum: maskProvider(data.uzum),
      updatedAt: data.updatedAt || null,
    });
  } catch (err) {
    console.error("[superadminSettings] payment-api read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/payment-api", async (req, res) => {
  try {
    const body = req.body || {};
    const existingSnap = await systemGet("systemData/settings/paymentApi");
    const existing = existingSnap.exists() ? existingSnap.val() : {};

    function mergeProvider(existingP, incomingP, hasServiceId) {
      const e = existingP || {};
      const i = incomingP || {};
      const incomingSecret = i.secretKey;
      const secretKey = (typeof incomingSecret === "string" && !incomingSecret.includes("•"))
        ? incomingSecret.trim()
        : (e.secretKey || "");
      const out = {
        merchantId: (i.merchantId ?? e.merchantId ?? "").toString().trim(),
        secretKey,
        checkoutUrl: (i.checkoutUrl ?? e.checkoutUrl ?? "").toString().trim(),
      };
      if (hasServiceId) out.serviceId = (i.serviceId ?? e.serviceId ?? "").toString().trim();
      return out;
    }

    const newPaymentApi = {
      payme: mergeProvider(existing.payme, body.payme, false),
      click: mergeProvider(existing.click, body.click, true),
      uzum: mergeProvider(existing.uzum, body.uzum, false),
      updatedAt: Date.now(),
    };

    await systemSet("systemData/settings/paymentApi", newPaymentApi);
    res.json({
      payme: maskProvider(newPaymentApi.payme),
      click: maskProvider(newPaymentApi.click),
      uzum: maskProvider(newPaymentApi.uzum),
      updatedAt: newPaymentApi.updatedAt,
    });
  } catch (err) {
    console.error("[superadminSettings] payment-api write failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

export default router;
