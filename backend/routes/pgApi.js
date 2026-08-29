import express from "express";
import { getDataBackend, usePostgres } from "../pg/config.js";
import { authEnvironmentDiagnostic } from "../firebaseEnv.js";
import { isPgAvailable } from "../db/postgres.js";
import { countCanonicalRestaurants } from "../pg/platformCount.js";
import { requirePgTenant, withRequestTenant, requestedRestId, isPgUnavailableError, isRlsDeniedError } from "../pg/tenant.js";
import { requirePermission } from "../rbac.js";
import { authorizeRtdbPath } from "../pg/rtdbAuthz.js";
import { isSafeId } from "../security/sanitize.js";
import { broadcastAll, listEventsSince } from "../pg/hub.js";
import * as pathRouter from "../pg/pathRouter.js";
import * as orders from "../pg/ordersService.js";
import * as catalog from "../pg/catalogService.js";
import { pushId } from "../pg/pushId.js";

const router = express.Router();

function getRestId(req) {
  return req.pgTenant?.restId || requestedRestId(req);
}

router.get("/meta", async (_req, res) => {
  const restaurants = await countCanonicalRestaurants();
  res.status(200).json({
    ok: true,
    dataBackend: getDataBackend(),
    postgresConfigured: isPgAvailable(),
    postgresReachable: restaurants.source === "postgres",
    restaurantCount: restaurants.count,
    restaurantCountSource: restaurants.source,
    realtime: true,
    mappedCollections: [...pathRouter.MAPPED_COLLECTIONS],
    usePostgres: usePostgres(),
    ...authEnvironmentDiagnostic(),
  });
});

router.get("/health", async (_req, res) => {
  res.json({
    ok: true,
    dataBackend: getDataBackend(),
    postgres: isPgAvailable(),
  });
});

function sendEvents(events) {
  broadcastAll(events);
}

export function sendPgFailure(res, err) {
  if (isRlsDeniedError(err)) return res.status(403).json({ error: "Access Denied", code: "rls_denied" });
  if (isPgUnavailableError(err)) return res.status(503).json({ error: "PG_UNAVAILABLE" });
  return res.status(500).json({ error: "Internal server error" });
}

function sendRtdbError(res, result) {
  const code = result.code || result.error;
  return res.status(result.status || 400).json({ error: result.error, code, details: result.details || null });
}

async function requireRtdbAccess(req, res, op) {
  const path = String(req.body?.path || "");
  const decision = await authorizeRtdbPath(req.pgTenant, path, op, {
    writeValue: req.body?.value ?? req.body?.patch ?? req.body?.next,
  });
  if (decision.status) {
    sendRtdbError(res, decision);
    return false;
  }
  return true;
}

// ── RTDB compatibility bridge ────────────────────────────────────────────
router.post("/rtdb/get", requirePgTenant(), async (req, res) => {
  try {
    if (!(await requireRtdbAccess(req, res, "get"))) return;
    const path = String(req.body?.path || "");
    const events = [];
    const result = await withRequestTenant(req, (client) => pathRouter.rtdbGet(client, req.pgTenant, path));
    if (result.error) return sendRtdbError(res, result);
    sendEvents(events);
    res.json(result);
  } catch (err) {
    console.error("[pgApi] rtdb/get failed", { code: err?.code || "UNKNOWN" });
    sendPgFailure(res, err);
  }
});

router.post("/rtdb/set", requirePgTenant(), async (req, res) => {
  try {
    if (!(await requireRtdbAccess(req, res, "set"))) return;
    const path = String(req.body?.path || "");
    const events = [];
    const result = await withRequestTenant(req, (client) => pathRouter.rtdbSet(client, req.pgTenant, path, req.body?.value, events));
    if (result.error) return sendRtdbError(res, result);
    sendEvents(events);
    res.json(result);
  } catch (err) {
    console.error("[pgApi] rtdb/set failed", { code: err?.code || "UNKNOWN" });
    sendPgFailure(res, err);
  }
});

router.post("/rtdb/update", requirePgTenant(), async (req, res) => {
  try {
    if (!(await requireRtdbAccess(req, res, "update"))) return;
    const path = String(req.body?.path || "");
    const events = [];
    const result = await withRequestTenant(req, (client) => pathRouter.rtdbUpdate(client, req.pgTenant, path, req.body?.value || req.body?.patch, events));
    if (result.error) return sendRtdbError(res, result);
    sendEvents(events);
    res.json(result);
  } catch (err) {
    console.error("[pgApi] rtdb/update failed", { code: err?.code || "UNKNOWN" });
    sendPgFailure(res, err);
  }
});

router.post("/rtdb/remove", requirePgTenant(), async (req, res) => {
  try {
    if (!(await requireRtdbAccess(req, res, "remove"))) return;
    const path = String(req.body?.path || "");
    const events = [];
    const result = await withRequestTenant(req, (client) => pathRouter.rtdbRemove(client, req.pgTenant, path, events));
    if (result.error) return sendRtdbError(res, result);
    sendEvents(events);
    res.json(result);
  } catch (err) {
    console.error("[pgApi] rtdb/remove failed", { code: err?.code || "UNKNOWN" });
    sendPgFailure(res, err);
  }
});

router.post("/rtdb/push", requirePgTenant(), async (req, res) => {
  try {
    if (!(await requireRtdbAccess(req, res, "push"))) return;
    const path = String(req.body?.path || "");
    const events = [];
    const result = await withRequestTenant(req, (client) => pathRouter.rtdbPush(client, req.pgTenant, path, req.body?.value, events));
    if (result.error) return sendRtdbError(res, result);
    sendEvents(events);
    res.json(result);
  } catch (err) {
    console.error("[pgApi] rtdb/push failed", { code: err?.code || "UNKNOWN" });
    sendPgFailure(res, err);
  }
});

router.post("/rtdb/transaction", requirePgTenant(), async (req, res) => {
  try {
    if (!(await requireRtdbAccess(req, res, "transaction"))) return;
    const path = String(req.body?.path || "");
    const events = [];
    const result = await withRequestTenant(req, async (client) => {
      const segs = String(path).split("/").filter(Boolean);
      // Counter paths are incremented atomically server-side. Returning the
      // increment (not the full settings document) matches Firebase
      // runTransaction's snapshot.val() contract used by orderNumber.
      if (segs[0] === "restaurants" && segs[2] === "meta" && segs[3]) {
        const n = await orders.incrementCounter(client, req.pgTenant.restaurantUuid, segs[3]);
        return { value: n };
      }
      if (typeof req.body?.next !== "undefined") {
        const setResult = await pathRouter.rtdbSet(client, req.pgTenant, path, req.body.next, events);
        if (setResult?.error) return setResult;
        return { value: req.body.next };
      }
      const txn = await pathRouter.rtdbTransaction(client, req.pgTenant, path);
      if (txn?.error) return txn;
      return txn;
    });
    if (result?.error) return sendRtdbError(res, result);
    sendEvents(events);
    res.json(result);
  } catch (err) {
    console.error("[pgApi] rtdb/transaction failed", { code: err?.code || "UNKNOWN" });
    sendPgFailure(res, err);
  }
});

router.get("/rtdb/mapped", (_req, res) => {
  res.json({ collections: [...pathRouter.MAPPED_COLLECTIONS] });
});

// ── Domain REST ──────────────────────────────────────────────────────────
router.get("/orders", requirePgTenant(), requirePermission("orders", "view", getRestId), async (req, res) => {
  try {
    const map = await withRequestTenant(req, (client) => orders.listOrdersMap(client, req.pgTenant.restaurantUuid));
    res.json(map);
  } catch (err) {
    sendPgFailure(res, err);
  }
});

router.get("/orders/:id", requirePgTenant(), requirePermission("orders", "view", getRestId), async (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).json({ error: "Invalid order id" });
  try {
    const order = await withRequestTenant(req, (client) => orders.getOrderByLegacy(client, req.pgTenant.restaurantUuid, req.params.id));
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) {
    sendPgFailure(res, err);
  }
});

router.post("/orders", requirePgTenant(), requirePermission("orders", "create", getRestId), async (req, res) => {
  try {
    const events = [];
    const id = req.body?.id || pushId();
    const order = await withRequestTenant(req, (client) => orders.upsertOrder(client, req.pgTenant, id, req.body, events));
    if (order?.error) return sendRtdbError(res, order);
    sendEvents(events);
    res.status(201).json({ id, order });
  } catch (err) {
    sendPgFailure(res, err);
  }
});

const LIFECYCLE = [
  "add-item", "update-item", "remove-item", "submit", "approve", "cancel",
  "send-kitchen", "kitchen", "cooking", "ready", "served", "completed",
  "payment", "pay", "close",
];

for (const action of LIFECYCLE) {
  router.post(`/orders/:id/${action}`, requirePgTenant(), requirePermission("orders", "edit", getRestId), async (req, res) => {
    if (!isSafeId(req.params.id)) return res.status(400).json({ error: "Invalid order id" });
    try {
      const events = [];
      const result = await withRequestTenant(req, (client) =>
        orders.applyLifecycle(client, req.pgTenant, req.params.id, action, req.body || {}, events)
      );
      if (result?.error) return res.status(result.status || 400).json({ error: result.error });
      sendEvents(events);
      res.json(result);
    } catch (err) {
      sendPgFailure(res, err);
    }
  });
}

router.put("/orders/:id/status", requirePgTenant(), requirePermission("orders", "edit", getRestId), async (req, res) => {
  if (!isSafeId(req.params.id)) return res.status(400).json({ error: "Invalid order id" });
  try {
    const events = [];
    const result = await withRequestTenant(req, (client) =>
      orders.applyLifecycle(client, req.pgTenant, req.params.id, "status", req.body || {}, events)
    );
    if (result?.error) return res.status(result.status || 400).json({ error: result.error });
    sendEvents(events);
    res.json(result);
  } catch (err) {
    sendPgFailure(res, err);
  }
});

router.get("/menu", requirePgTenant(), requirePermission("menu", "view", getRestId), async (req, res) => {
  const map = await withRequestTenant(req, (client) => catalog.listMenuMap(client, req.pgTenant.restaurantUuid));
  res.json(map);
});

router.get("/categories", requirePgTenant(), requirePermission("menu", "view", getRestId), async (req, res) => {
  const map = await withRequestTenant(req, (client) => catalog.listCategoriesMap(client, req.pgTenant.restaurantUuid));
  res.json(map);
});

router.get("/tables", requirePgTenant(), requirePermission("tables", "view", getRestId), async (req, res) => {
  const map = await withRequestTenant(req, (client) => catalog.listTablesMap(client, req.pgTenant.restaurantUuid));
  res.json(map);
});

router.get("/employees", requirePgTenant(), requirePermission("staff", "view", getRestId), async (req, res) => {
  const map = await withRequestTenant(req, (client) => catalog.listEmployeesMap(client, req.pgTenant.restaurantUuid));
  res.json(map);
});

router.get("/customers", requirePgTenant(), requirePermission("customers", "view", getRestId), async (req, res) => {
  const map = await withRequestTenant(req, (client) => catalog.listCustomersMap(client, req.pgTenant.restaurantUuid));
  res.json(map);
});

router.get("/reservations", requirePgTenant(), requirePermission("reservations", "view", getRestId), async (req, res) => {
  const map = await withRequestTenant(req, (client) => catalog.listReservationsMap(client, req.pgTenant.restaurantUuid));
  res.json(map);
});

router.get("/inventory", requirePgTenant(), requirePermission("warehouse", "view", getRestId), async (req, res) => {
  const map = await withRequestTenant(req, (client) => catalog.listInventoryMap(client, req.pgTenant.restaurantUuid));
  res.json(map);
});

router.get("/notifications", requirePgTenant(), requirePermission("notifications", "view", getRestId), async (req, res) => {
  const map = await withRequestTenant(req, (client) => catalog.listNotificationsMap(client, req.pgTenant.restaurantUuid));
  res.json(map);
});

router.get("/settings", requirePgTenant(), requirePermission("settings", "view", getRestId), async (req, res) => {
  const settings = await withRequestTenant(req, (client) => catalog.getSettings(client, req.pgTenant.restaurantUuid));
  res.json(settings);
});

router.get("/couriers", requirePgTenant(), requirePermission("courier", "view", getRestId), async (req, res) => {
  const map = await withRequestTenant(req, (client) => catalog.listCouriersMap(client, req.pgTenant.restaurantUuid));
  res.json(map);
});

router.get("/reports/summary", requirePgTenant(), requirePermission("report", "view", getRestId), async (req, res) => {
  const summary = await withRequestTenant(req, (client) => catalog.getReportsSummary(client, req.pgTenant.restaurantUuid));
  res.json(summary);
});

router.get("/realtime/since", requirePgTenant(), async (req, res) => {
  try {
    if (req.pgTenant?.isCustomer === true) {
      return res.status(403).json({ error: "Access Denied", code: "role_denied" });
    }
    const after = Number(req.query.afterSeq || 0);
    const events = await withRequestTenant(req, (client) => listEventsSince(client, req.pgTenant.restaurantUuid, after));
    res.json({ restId: req.pgTenant.restId, events });
  } catch (err) {
    sendPgFailure(res, err);
  }
});

export { usePostgres };
export default router;
