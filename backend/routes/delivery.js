// routes/delivery.js — REST surface for the Delivery Engine. Mirrors the
// existing payments route convention (thin Express handlers delegating to
// backend/delivery/engine.js + backend/delivery/common.js).
import express from "express";
import { requirePermission, resolveRequestPermissions } from "../rbac.js";
import * as engine from "../delivery/engine.js";
import { basePath } from "../delivery/common.js";
import { isSafeId, requireSafeParam } from "../security/sanitize.js";
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so this file's own reads/writes go through the
// admin-or-client fallback (systemDb.js) instead of the plain client SDK.
import { systemGet, systemUpdate } from "../systemDb.js";
import { usePostgres } from "../pg/config.js";
import { withLegacyRest } from "../pg/legacyBridge.js";
import { listCouriersMap, upsertCourier } from "../pg/catalogService.js";


const router = express.Router();

function getRestId(req) {
  const raw = req.query.restId || req.body?.restId || req.headers["x-rest-id"] || process.env.DEFAULT_REST_ID || null;
  return raw && isSafeId(String(raw)) ? raw : null;
}

// A "courier"-role user may only act on their own delivery/courier record —
// never another courier's. Elevated roles (owner/manager/delivery_manager/…)
// are unaffected. Spec: "Courier only reads own deliveries. Cannot access
// other courier deliveries."
//
// Production Security Fix Pass (P0-1): this used to re-read the raw,
// unverified req.headers["x-user-id"] directly — a caller with a verified
// session could still claim any x-user-id here and pass the "own courier"
// check for someone else's record. Always mounted after requirePermission()
// (see every route below), which now REQUIRES a verified identity and
// attaches it as req.nestaAuth — reusing that instead closes this.
function requireOwnCourier(courierIdOf) {
  return async function (req, res, next) {
    try {
      const restId = getRestId(req);
      const userId = req.nestaAuth?.userId;
      if (!userId) return res.status(401).json({ error: "Authentication required" });
      const perms = await resolveRequestPermissions(restId, userId);
      if (perms && perms.role === "courier" && courierIdOf(req) && courierIdOf(req) !== userId) {
        return res.status(403).json({ error: "Access Denied" });
      }
      next();
    } catch (_err) {
      res.status(403).json({ error: "Access Denied" });
    }
  };
}

router.post("/delivery/:orderId/assign", requireSafeParam("orderId"), requirePermission("delivery", "edit", getRestId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const result = await engine.assign(restId, req.params.orderId, {
    courierIdOverride: req.body?.courierId || null,
  });
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
});

router.post("/delivery/:orderId/status", requireSafeParam("orderId"), requirePermission("delivery", "edit", getRestId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const status = String(req.body?.status || "").trim();
  if (!status) return res.status(400).json({ error: "status required" });

  const actingUserId = req.nestaAuth?.userId;
  const perms = await resolveRequestPermissions(restId, actingUserId);
  if (perms && perms.role === "courier") {
    const existing = await engine.getDelivery(restId, req.params.orderId);
    if (existing && existing.courierId && existing.courierId !== actingUserId) {
      return res.status(403).json({ error: "Access Denied" });
    }
  }

  const result = await engine.updateStatus(restId, req.params.orderId, status, req.body?.actor || "courier");
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

router.post("/delivery/:orderId/reject", requireSafeParam("orderId"), requirePermission("courier", "edit", getRestId), requireOwnCourier((req) => req.body?.courierId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const result = await engine.reject(restId, req.params.orderId, req.body?.courierId, req.body?.reason || "");
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

router.post("/delivery/:orderId/retry", requireSafeParam("orderId"), requirePermission("delivery", "edit", getRestId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const result = await engine.retry(restId, req.params.orderId);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

// Phase-8 fix (PRODUCTION-AUDIT.md route-shadowing bug): GET /delivery/couriers
// must be registered BEFORE GET /delivery/:orderId. Express matches routes in
// registration order with no literal-vs-param prioritization, so with the
// :orderId route registered first, a request to /api/delivery/couriers used
// to match it instead (orderId="couriers"), running the wrong permission
// check (delivery.view instead of courier.view) and always 404'ing via
// engine.getDelivery(restId, "couriers") — the real couriers-list handler
// below was unreachable. Only the registration order changed; neither
// handler's body/permissions were touched.
router.get("/delivery/couriers", requirePermission("courier", "view", getRestId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  let list;
  if (usePostgres()) {
    const data = await withLegacyRest(restId, (client, ctx) => listCouriersMap(client, ctx.restaurantUuid));
    list = Object.entries(data || {}).map(([id, c]) => ({ _id: id, ...c }));
  } else {
    const snap = await systemGet(`${basePath(restId)}/couriers`);
    const data = snap.val() || {};
    list = Object.entries(data).map(([id, c]) => ({ _id: id, ...c }));
  }

  const actingUserId = req.nestaAuth?.userId;
  const perms = await resolveRequestPermissions(restId, actingUserId);
  if (perms && perms.role === "courier") {
    list = list.filter((c) => c._id === actingUserId);
  }

  res.json(list);
});

router.get("/delivery/:orderId", requireSafeParam("orderId"), requirePermission("delivery", "view", getRestId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const delivery = await engine.getDelivery(restId, req.params.orderId);
  if (!delivery) return res.status(404).json({ error: "delivery_not_found" });

  const actingUserId = req.nestaAuth?.userId;
  const perms = await resolveRequestPermissions(restId, actingUserId);
  if (perms && perms.role === "courier" && delivery.courierId && delivery.courierId !== actingUserId) {
    return res.status(403).json({ error: "Access Denied" });
  }

  res.json(delivery);
});

// Courier own-status: Available | Busy | Offline | Break.
// Internally stored as couriers/{id}/status = online|on_delivery|offline|paused
// (unchanged from the existing courier app) so no other reader breaks.
const COURIER_UI_TO_DB_STATUS = {
  available: "online",
  busy: "on_delivery",
  offline: "offline",
  break: "paused",
};

router.post("/delivery/couriers/:courierId/status", requireSafeParam("courierId"), requirePermission("courier", "edit", getRestId), requireOwnCourier((req) => req.params.courierId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const uiStatus = String(req.body?.status || "").trim().toLowerCase();
  const dbStatus = COURIER_UI_TO_DB_STATUS[uiStatus] || uiStatus;
  if (!dbStatus) return res.status(400).json({ error: "status required" });

  if (usePostgres()) {
    await withLegacyRest(restId, async (client, ctx, events) => {
      const current = (await listCouriersMap(client, ctx.restaurantUuid))[req.params.courierId] || {};
      return upsertCourier(client, ctx, req.params.courierId, {
        ...current,
        status: dbStatus,
        lastSeenAt: Date.now(),
      }, events);
    });
  } else {
    await systemUpdate(`${basePath(restId)}/couriers/${req.params.courierId}`, {
      status: dbStatus,
      lastSeenAt: Date.now(),
    });
  }
  res.json({ ok: true, status: dbStatus });
});

export default router;
