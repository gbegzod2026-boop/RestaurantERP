// routes/superadminMarketing.js — Superadmin systemData migration, Stage 2:
// Marketing (Promo Codes + Broadcast History).
//
// systemData/promoCodes and systemData/broadcastHistory were read/written
// directly via the client SDK (listenPromoCodes/savePromoCode/
// togglePromoActive/deletePromoCode/the usedCount increment in
// saveNewRestaurant, and listenBroadcastHistory/sendBroadcastMessage's
// history-log write) — all denied now by database.rules.json's systemData
// lockdown. NOTE: sendBroadcastMessage()'s actual fan-out writes (pushing a
// notification/chat message into each targeted restaurant's OWN
// restaurants/{id}/notifications and restaurants/{id}/superadmin_chat) are
// NOT under systemData and are UNCHANGED — restaurants/$restId already
// grants a real superadmin session (no restId claim) write access there;
// only the systemData/broadcastHistory LOG entry needed to move.
import express from "express";
import { getAdminDb } from "../firebaseAdmin.js";
import { systemGet, systemPush, systemUpdate, systemRemove } from "../systemDb.js";
import { requireSuperAdmin } from "../security/requireSuperAdmin.js";

const router = express.Router();
router.use(requireSuperAdmin);

// ─── Promo Codes ─────────────────────────────────────────────────────────
router.get("/promo-codes", async (req, res) => {
  try {
    const snap = await systemGet("systemData/promoCodes");
    res.json(snap.exists() ? snap.val() : {});
  } catch (err) {
    console.error("[superadminMarketing] promo-codes read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/promo-codes", async (req, res) => {
  try {
    const body = req.body || {};
    const code = String(body.code || "").trim().toUpperCase();
    const discount = parseInt(body.discount, 10);

    if (!code || !/^[A-Z0-9_-]+$/.test(code)) {
      return res.status(400).json({ error: "Invalid code" });
    }
    if (!discount || discount < 1 || discount > 100) {
      return res.status(400).json({ error: "Invalid discount" });
    }

    const existingSnap = await systemGet("systemData/promoCodes");
    const existing = existingSnap.exists() ? existingSnap.val() : {};
    const dup = Object.values(existing).some(p => String(p.code || "").toUpperCase() === code);
    if (dup) return res.status(409).json({ error: "Code already exists" });

    const maxUses = body.maxUses ? parseInt(body.maxUses, 10) : null;
    const payload = {
      code,
      discount,
      maxUses: Number.isFinite(maxUses) ? maxUses : null,
      usedCount: 0,
      expireAt: body.expireAt ? Number(body.expireAt) : null,
      note: body.note ? String(body.note).slice(0, 500) : null,
      active: true,
      createdAt: Date.now(),
    };
    const key = await systemPush("systemData/promoCodes", payload);
    res.json({ ok: true, key, promo: payload });
  } catch (err) {
    console.error("[superadminMarketing] promo-codes create failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// Server reads the CURRENT `active` value itself and flips it, rather than
// trusting a client-supplied "currentActive" to negate (the old client
// code's own cache could be stale) — strictly safer than the original.
router.patch("/promo-codes/:id/toggle", async (req, res) => {
  try {
    const snap = await systemGet(`systemData/promoCodes/${req.params.id}`);
    if (!snap.exists()) return res.status(404).json({ error: "Not found" });
    const current = snap.val();
    const nextActive = !(current.active !== false);
    await systemUpdate(`systemData/promoCodes/${req.params.id}`, { active: nextActive });
    res.json({ ok: true, active: nextActive });
  } catch (err) {
    console.error("[superadminMarketing] promo-codes toggle failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.delete("/promo-codes/:id", async (req, res) => {
  try {
    await systemRemove(`systemData/promoCodes/${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[superadminMarketing] promo-codes delete failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// Atomic usedCount++ — replaces saveNewRestaurant()'s read-then-write
// (`usedCount: currentUses + 1`), which had a race window; a real Admin
// SDK transaction closes it, a small correctness improvement alongside the
// migration.
router.post("/promo-codes/:id/use", async (req, res) => {
  try {
    const ref = getAdminDb().ref(`systemData/promoCodes/${req.params.id}/usedCount`);
    const result = await ref.transaction(current => (current || 0) + 1);
    if (!result.committed) return res.status(503).json({ error: "Unavailable" });
    res.json({ ok: true, usedCount: result.snapshot.val() });
  } catch (err) {
    console.error("[superadminMarketing] promo-codes use failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

// ─── Broadcast History ───────────────────────────────────────────────────
router.get("/broadcast-history", async (req, res) => {
  try {
    const snap = await systemGet("systemData/broadcastHistory");
    res.json(snap.exists() ? snap.val() : {});
  } catch (err) {
    console.error("[superadminMarketing] broadcast-history read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

router.post("/broadcast-history", async (req, res) => {
  try {
    const body = req.body || {};
    const entry = {
      text: body.text ? String(body.text).slice(0, 2000) : "",
      segment: body.segment || null,
      segmentLabel: body.segmentLabel || null,
      segmentIcon: body.segmentIcon || null,
      recipientCount: Number(body.recipientCount || 0),
      channels: body.channels || {},
      date: Date.now(),
    };
    const key = await systemPush("systemData/broadcastHistory", entry);
    res.json({ ok: true, key });
  } catch (err) {
    console.error("[superadminMarketing] broadcast-history write failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

export default router;
