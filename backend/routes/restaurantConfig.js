// routes/restaurantConfig.js — small, Admin-SDK-backed reads for the
// restaurant-facing admin panel (admin-frontend/public/js/admin.js) that
// used to go straight at systemData/* via the client SDK. database.rules.json
// closes "systemData" to every client unconditionally (".read": false,
// ".write": false — see that file's own header comment: "no browser has a
// legitimate reason to read or write this directly"), confirmed live during
// this fix: a freshly-minted, fully valid staff session still gets a 401
// Permission Denied reading systemData/settings/tariffs/{key} directly. This
// is intentional, not a rules gap — the fix is this endpoint, mirroring the
// exact same pattern already used for superadmin.js's systemData migration
// (backend/routes/superadminDashboard.js and friends), not a rules change.
import express from "express";
import { isAdminAvailable, getAdminAuth } from "../firebaseAdmin.js";
import { isSafeId } from "../security/sanitize.js";
import { systemGet } from "../systemDb.js";

const router = express.Router();

// Tariff/plan feature data (systemData/settings/tariffs/*) is a platform-
// wide catalog, not restaurant-specific — no restId-ownership check is
// needed, only "this is a real, verified Firebase session" (staff or
// superadmin both qualify), same identity check rbac.js's resolveIdentity()
// already trusts for verified callers, kept minimal and local here since
// this route doesn't need resolveIdentity()'s x-user-id legacy fallback.
async function requireVerifiedSession(req, res, next) {
  if (!isAdminAvailable()) return res.status(503).json({ error: "Feature unavailable" });
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  try {
    await getAdminAuth().verifyIdToken(authHeader.slice(7).trim());
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

router.use(requireVerifiedSession);

// GET /api/restaurant/tariffs/:tariffKey — backs admin.js's
// listenPlanFeatures() and checkPermissions(), which both used to read
// systemData/settings/tariffs/{tariffKey} directly via the client SDK.
router.get("/tariffs/:tariffKey", async (req, res) => {
  try {
    const key = String(req.params.tariffKey || "").toLowerCase();
    if (!isSafeId(key)) return res.status(400).json({ error: "Invalid tariff key" });
    const snap = await systemGet(`systemData/settings/tariffs/${key}`);
    res.json(snap.exists() ? snap.val() : {});
  } catch (err) {
    console.error("[restaurantConfig] tariff read failed:", err?.message || err);
    res.status(503).json({ error: "Unavailable" });
  }
});

export default router;
