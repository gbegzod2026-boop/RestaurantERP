// pg/pathRouter.js — map Firebase RTDB paths onto PostgreSQL services.
// Unmapped paths return { fallback: true } so the client keeps using Firebase.
import { pushId } from "./pushId.js";
import * as orders from "./ordersService.js";
import * as catalog from "./catalogService.js";
import { getSettings } from "./catalogService.js";
import { REALTIME_EVENTS } from "./events.js";
import { recordEvent } from "./hub.js";

export const MAPPED_COLLECTIONS = new Set([
  "orders", "menu", "categories", "tables", "users", "customers", "reservations",
  "inventory", "ingredients", "notifications", "settings", "orderChangeRequests",
  "courierAssignments", "couriers", "orderTimeline", "meta", "activityLogs",
  "waiterCalls", "kitchenStations", "orderChats",
]);

export function parsePath(path) {
  const p = String(path || "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!p) return { root: true, segments: [] };
  const segments = p.split("/").filter(Boolean);
  return { segments, path: p };
}

export function isMappedPath(path) {
  const { segments } = parsePath(path);
  if (segments[0] !== "restaurants" || segments.length < 3) return false;
  return MAPPED_COLLECTIONS.has(segments[2]);
}

export function restIdFromPath(path) {
  const { segments } = parsePath(path);
  if (segments[0] === "restaurants" && segments[1]) return segments[1];
  return null;
}

async function readCollection(client, ctx, col, id, rest) {
  switch (col) {
    case "orders": {
      if (!id) return orders.listOrdersMap(client, ctx.restaurantUuid);
      if (rest[0] === "items") {
        const order = await orders.getOrderByLegacy(client, ctx.restaurantUuid, id);
        if (!order) return null;
        if (!rest[1]) return order.items || {};
        return (order.items || {})[rest[1]] ?? null;
      }
      if (rest[0] === "payment") {
        const order = await orders.getOrderByLegacy(client, ctx.restaurantUuid, id);
        return order ? order.payment : null;
      }
      if (rest[0]) {
        const order = await orders.getOrderByLegacy(client, ctx.restaurantUuid, id);
        return order ? (order[rest[0]] ?? null) : null;
      }
      return orders.getOrderByLegacy(client, ctx.restaurantUuid, id);
    }
    case "menu": {
      const map = await catalog.listMenuMap(client, ctx.restaurantUuid);
      return id ? (map[id] ?? null) : map;
    }
    case "categories": {
      const map = await catalog.listCategoriesMap(client, ctx.restaurantUuid);
      return id ? (map[id] ?? null) : map;
    }
    case "tables": {
      const map = await catalog.listTablesMap(client, ctx.restaurantUuid);
      if (!id) return map;
      if (rest[0]) return map[id] ? (map[id][rest[0]] ?? null) : null;
      return map[id] ?? null;
    }
    case "users": {
      const map = await catalog.listEmployeesMap(client, ctx.restaurantUuid);
      if (!id) return map;
      if (rest[0]) return map[id] ? (map[id][rest[0]] ?? null) : null;
      return map[id] ?? null;
    }
    case "customers": {
      const map = await catalog.listCustomersMap(client, ctx.restaurantUuid);
      return id ? (map[id] ?? null) : map;
    }
    case "reservations": {
      const map = await catalog.listReservationsMap(client, ctx.restaurantUuid);
      return id ? (map[id] ?? null) : map;
    }
    case "inventory": {
      const map = await catalog.listInventoryMap(client, ctx.restaurantUuid, "inventory");
      return id ? (map[id] ?? null) : map;
    }
    case "ingredients": {
      const map = await catalog.listInventoryMap(client, ctx.restaurantUuid, "ingredients");
      return id ? (map[id] ?? null) : map;
    }
    case "notifications": {
      const map = await catalog.listNotificationsMap(client, ctx.restaurantUuid);
      return id ? (map[id] ?? null) : map;
    }
    case "settings": {
      const settings = await getSettings(client, ctx.restaurantUuid);
      if (!id) return settings;
      let cur = settings;
      for (const part of [id, ...rest]) {
        if (cur == null) return null;
        cur = cur[part];
      }
      return cur ?? null;
    }
    case "couriers": {
      const map = await catalog.listCouriersMap(client, ctx.restaurantUuid);
      return id ? (map[id] ?? null) : map;
    }
    case "courierAssignments": {
      const map = await catalog.listCourierAssignmentsMap(client, ctx.restaurantUuid);
      return id ? (map[id] ?? null) : map;
    }
    case "orderChangeRequests": {
      const map = await catalog.listChangeRequestsMap(client, ctx.restaurantUuid);
      return id ? (map[id] ?? null) : map;
    }
    case "kitchenStations": {
      const map = await catalog.listKitchenStationsMap(client, ctx.restaurantUuid);
      return id ? (map[id] ?? null) : map;
    }
    case "meta": {
      const settings = await getSettings(client, ctx.restaurantUuid);
      const meta = settings.meta || {};
      if (!id) return meta;
      return meta[id] ?? 0;
    }
    case "orderTimeline": {
      const { rows } = await client.query(
        `SELECT * FROM order_timeline WHERE restaurant_id = $1 AND ($2::text IS NULL OR legacy_order_id = $2)
         ORDER BY occurred_at`,
        [ctx.restaurantUuid, id || null]
      );
      const out = {};
      for (const r of rows) {
        if (r.legacy_rtdb_id) out[r.legacy_rtdb_id] = { ...r.payload, type: r.event_type, message: r.message, at: r.occurred_at };
      }
      return out;
    }
    default:
      return { fallback: true };
  }
}

async function writeNode(client, ctx, col, id, rest, value, events, op) {
  if (col === "orders") {
    if (!id) {
      if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
          out[k] = await orders.upsertOrder(client, ctx, k, v, events);
        }
        return out;
      }
      return null;
    }
    if (rest[0] === "items") {
      const { rows } = await client.query(
        `SELECT * FROM orders WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
        [ctx.restaurantUuid, id]
      );
      if (!rows[0]) return { missing: true };
      if (!rest[1]) {
        if (value == null) {
          await client.query(`DELETE FROM order_items WHERE order_id = $1 AND restaurant_id = $2`, [rows[0].id, ctx.restaurantUuid]);
          return null;
        }
        for (const [k, v] of Object.entries(value)) {
          await orders.upsertItem(client, ctx, rows[0], k, v, events);
        }
        return value;
      }
      if (value == null) {
        await client.query(
          `DELETE FROM order_items WHERE order_id = $1 AND restaurant_id = $2 AND legacy_rtdb_id = $3`,
          [rows[0].id, ctx.restaurantUuid, rest[1]]
        );
        events.push(await recordEvent(client, {
          restaurantUuid: ctx.restaurantUuid, restId: ctx.restId,
          type: REALTIME_EVENTS.ORDER_ITEM_CHANGED,
          path: `restaurants/${ctx.restId}/orders/${id}/items/${rest[1]}`,
          payload: { orderId: id, itemId: rest[1], deleted: true },
        }));
        return null;
      }
      return orders.upsertItem(client, ctx, rows[0], rest[1], value, events);
    }
    if (rest[0] === "payment") {
      const { rows } = await client.query(
        `SELECT * FROM orders WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
        [ctx.restaurantUuid, id]
      );
      if (!rows[0]) return { missing: true };
      return orders.upsertPayment(client, ctx, rows[0], value || {}, events);
    }
    if (rest[0] && rest.length >= 1) {
      const patch = {};
      let cursor = patch;
      for (let i = 0; i < rest.length - 1; i++) {
        cursor[rest[i]] = {};
        cursor = cursor[rest[i]];
      }
      cursor[rest[rest.length - 1]] = value;
      return orders.patchOrderFields(client, ctx, id, patch, events);
    }
    return orders.upsertOrder(client, ctx, id, value, events);
  }
  if (col === "tables") {
    if (!id) return null;
    if (rest[0]) {
      const patch = {};
      let cursor = patch;
      for (let i = 0; i < rest.length - 1; i++) {
        cursor[rest[i]] = {};
        cursor = cursor[rest[i]];
      }
      cursor[rest[rest.length - 1]] = value;
      return catalog.patchTable(client, ctx, id, patch, events);
    }
    return catalog.upsertTable(client, ctx, id, value, events);
  }
  if (col === "users") {
    if (!id) return null;
    if (rest[0]) {
      const patch = {};
      let cursor = patch;
      for (let i = 0; i < rest.length - 1; i++) {
        cursor[rest[i]] = {};
        cursor = cursor[rest[i]];
      }
      cursor[rest[rest.length - 1]] = value;
      return catalog.patchEmployee(client, ctx, id, patch, events);
    }
    return catalog.upsertEmployee(client, ctx, id, value, events);
  }
  if (col === "menu") {
    if (!id) return null;
    return catalog.upsertMenuItem(client, ctx, id, value, events);
  }
  if (col === "categories") {
    if (!id) return null;
    return catalog.upsertCategory(client, ctx, id, value, events);
  }
  if (col === "customers") {
    if (!id) return null;
    return catalog.upsertCustomer(client, ctx, id, value, events);
  }
  if (col === "reservations") {
    if (!id) return null;
    return catalog.upsertReservation(client, ctx, id, value, events);
  }
  if (col === "inventory") {
    if (!id) return null;
    return catalog.upsertInventory(client, ctx, id, value, events, "inventory");
  }
  if (col === "ingredients") {
    if (!id) return null;
    return catalog.upsertInventory(client, ctx, id, value, events, "ingredients");
  }
  if (col === "notifications") {
    const key = id || pushId();
    await catalog.upsertNotification(client, ctx, key, value || {}, events);
    return key;
  }
  if (col === "settings") {
    if (!id) return catalog.patchSettings(client, ctx.restaurantUuid, ctx.restId, value || {}, events);
    const patch = {};
    let cursor = patch;
    const parts = [id, ...rest];
    for (let i = 0; i < parts.length - 1; i++) {
      cursor[parts[i]] = {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
    return catalog.patchSettings(client, ctx.restaurantUuid, ctx.restId, patch, events);
  }
  if (col === "couriers") {
    if (!id) return null;
    return catalog.upsertCourier(client, ctx, id, value || {}, events);
  }
  if (col === "orderChangeRequests") {
    const key = id || pushId();
    await catalog.upsertChangeRequest(client, ctx, key, value || {}, events);
    return key;
  }
  if (col === "meta") {
    const settings = await getSettings(client, ctx.restaurantUuid);
    const meta = { ...(settings.meta || {}) };
    if (id) meta[id] = value;
    await catalog.patchSettings(client, ctx.restaurantUuid, ctx.restId, { meta }, events);
    return id ? value : meta;
  }
  return { fallback: true };
}

export async function rtdbGet(client, ctx, path) {
  const { segments } = parsePath(path);
  if (segments[0] !== "restaurants" || segments[1] !== ctx.restId) {
    return { error: "path_restId_mismatch", status: 403 };
  }
  const col = segments[2];
  if (!MAPPED_COLLECTIONS.has(col)) return { fallback: true };
  const value = await readCollection(client, ctx, col, segments[3], segments.slice(4));
  return { value };
}

export async function rtdbSet(client, ctx, path, value, events) {
  const { segments } = parsePath(path);
  if (segments[0] !== "restaurants" || segments[1] !== ctx.restId) {
    return { error: "path_restId_mismatch", status: 403 };
  }
  const col = segments[2];
  if (!MAPPED_COLLECTIONS.has(col)) return { fallback: true };
  const result = await writeNode(client, ctx, col, segments[3], segments.slice(4), value, events, "set");
  return { value: result };
}

export async function rtdbUpdate(client, ctx, path, patch, events) {
  if (!patch || typeof patch !== "object") return { value: null };
  const base = parsePath(path);

  // Root multi-path update: keys are absolute ("restaurants/x/orders/y")
  const keys = Object.keys(patch);
  const isMulti = keys.some((k) => k.includes("/") || k.startsWith("restaurants/"));
  if (isMulti && (base.root || base.segments.length === 0 || (base.segments[0] === "restaurants" && base.segments.length <= 1))) {
    for (const [k, v] of Object.entries(patch)) {
      const abs = k.replace(/^\/+/, "");
      const r = await rtdbSet(client, ctx, abs, v, events);
      if (r.error) return r;
      if (r.fallback) return r;
    }
    return { value: true };
  }

  const { segments } = base;
  if (segments[0] !== "restaurants" || segments[1] !== ctx.restId) {
    return { error: "path_restId_mismatch", status: 403 };
  }
  const col = segments[2];
  if (!MAPPED_COLLECTIONS.has(col)) return { fallback: true };

  // Relative multi-path under this node
  if (isMulti) {
    for (const [k, v] of Object.entries(patch)) {
      const child = [...segments, ...k.split("/").filter(Boolean)].join("/");
      const r = await rtdbSet(client, ctx, child, v, events);
      if (r.error) return r;
      if (r.fallback) return r;
    }
    return { value: true };
  }

  if (col === "orders" && segments[3] && segments.length === 4) {
    return { value: await orders.patchOrderFields(client, ctx, segments[3], patch, events) };
  }
  if (col === "tables" && segments[3] && segments.length === 4) {
    return { value: await catalog.patchTable(client, ctx, segments[3], patch, events) };
  }
  if (col === "users" && segments[3] && segments.length === 4) {
    return { value: await catalog.patchEmployee(client, ctx, segments[3], patch, events) };
  }
  return rtdbSet(client, ctx, path, patch, events);
}

export async function rtdbRemove(client, ctx, path, events) {
  return rtdbSet(client, ctx, path, null, events);
}

export async function rtdbPush(client, ctx, path, value, events) {
  const key = pushId();
  const child = `${String(path).replace(/\/+$/, "")}/${key}`;
  if (value !== undefined) {
    const r = await rtdbSet(client, ctx, child, value, events);
    if (r.error || r.fallback) return r;
  }
  return { key, path: child };
}

export async function rtdbTransaction(client, ctx, path, currentHint) {
  const { segments } = parsePath(path);
  if (segments[2] === "meta" && segments[3]) {
    const n = await orders.incrementCounter(client, ctx.restaurantUuid, segments[3]);
    return { value: n };
  }
  const got = await rtdbGet(client, ctx, path);
  return { value: got.value, apply: async (next, events) => rtdbSet(client, ctx, path, next, events) };
}
