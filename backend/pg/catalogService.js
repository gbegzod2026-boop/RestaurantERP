import { REALTIME_EVENTS } from "./events.js";
import { recordEvent } from "./hub.js";
import { pushId } from "./pushId.js";
import {
  mapByLegacy, tableToRtdb, employeeToRtdb, menuItemToRtdb, categoryToRtdb,
  customerToRtdb, reservationToRtdb, inventoryToRtdb, notificationToRtdb,
  money, asObject, toMs,
} from "./shape.js";

function json(v) {
  return JSON.stringify(v == null ? {} : v);
}

function mergeObjects(current, patch) {
  if (!current || typeof current !== "object" || Array.isArray(current)) return patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeObjects(current[key], value)
      : value;
  }
  return merged;
}

export async function getSettings(client, restaurantUuid) {
  const { rows } = await client.query(
    `SELECT settings FROM restaurant_settings WHERE restaurant_id = $1`,
    [restaurantUuid]
  );
  return rows[0]?.settings || {};
}

export async function patchSettings(client, restaurantUuid, restId, patch, events) {
  const current = await getSettings(client, restaurantUuid);
  const next = { ...current, ...patch };
  await client.query(
    `INSERT INTO restaurant_settings (restaurant_id, settings)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (restaurant_id) DO UPDATE SET settings = restaurant_settings.settings || EXCLUDED.settings`,
    [restaurantUuid, json(next)]
  );
  events.push(await recordEvent(client, {
    restaurantUuid, restId, type: REALTIME_EVENTS.PATH_CHANGED,
    path: `restaurants/${restId}/settings`, payload: { settings: next },
  }));
  return next;
}

export async function listTablesMap(client, restaurantUuid) {
  const { rows } = await client.query(`SELECT * FROM tables WHERE restaurant_id = $1 ORDER BY number`, [restaurantUuid]);
  return mapByLegacy(rows, tableToRtdb);
}

export async function upsertTable(client, ctx, legacyId, payload, events) {
  const { restaurantUuid, restId } = ctx;
  if (payload == null) {
    await client.query(`DELETE FROM tables WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`, [restaurantUuid, legacyId]);
    events.push(await recordEvent(client, {
      restaurantUuid, restId, type: REALTIME_EVENTS.TABLE_STATUS_CHANGED,
      path: `restaurants/${restId}/tables/${legacyId}`, payload: { tableId: legacyId, deleted: true },
    }));
    return null;
  }
  const number = payload.number != null ? Number(payload.number) : Number(String(legacyId).replace(/^table_/, "")) || 0;
  const consumed = new Set(["number", "tableType", "capacity", "active", "status", "createdAt", "updatedAt", "_pgId"]);
  const extra = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!consumed.has(k) && v !== undefined) extra[k] = v;
  }
  const { rows } = await client.query(
    `INSERT INTO tables (legacy_rtdb_id, restaurant_id, number, table_type, capacity, active, status, extra)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
        number = COALESCE(EXCLUDED.number, tables.number),
        table_type = COALESCE(EXCLUDED.table_type, tables.table_type),
        capacity = COALESCE(EXCLUDED.capacity, tables.capacity),
        active = EXCLUDED.active,
        status = COALESCE(EXCLUDED.status, tables.status),
        extra = COALESCE(tables.extra, '{}'::jsonb) || EXCLUDED.extra
     RETURNING *`,
    [
      legacyId, restaurantUuid, number || 0,
      payload.tableType || "oddiy",
      payload.capacity != null ? Number(payload.capacity) : null,
      payload.active !== false,
      payload.status || extra.status || "free",
      json(extra),
    ]
  );
  const shaped = tableToRtdb(rows[0]);
  events.push(await recordEvent(client, {
    restaurantUuid, restId, type: REALTIME_EVENTS.TABLE_STATUS_CHANGED,
    path: `restaurants/${restId}/tables/${legacyId}`,
    payload: { tableId: legacyId, status: shaped.status, table: shaped },
  }));
  return shaped;
}

export async function patchTable(client, ctx, legacyId, patch, events) {
  const map = await listTablesMap(client, ctx.restaurantUuid);
  const current = map[legacyId] || {};
  return upsertTable(client, ctx, legacyId, { ...current, ...patch }, events);
}

export async function listEmployeesMap(client, restaurantUuid) {
  const { rows } = await client.query(`SELECT * FROM employees WHERE restaurant_id = $1`, [restaurantUuid]);
  return mapByLegacy(rows, employeeToRtdb);
}

export async function getEmployee(client, restaurantUuid, legacyId) {
  const { rows } = await client.query(
    `SELECT * FROM employees WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
    [restaurantUuid, legacyId]
  );
  return rows[0] ? employeeToRtdb(rows[0]) : null;
}

export async function patchEmployee(client, ctx, legacyId, patch, events) {
  const current = await getEmployee(client, ctx.restaurantUuid, legacyId);
  if (!current) return null;
  return upsertEmployee(client, ctx, legacyId, mergeObjects(current, patch), events);
}

export async function upsertEmployee(client, ctx, legacyId, payload, events) {
  const { restaurantUuid, restId } = ctx;
  if (payload == null) {
    await client.query(`DELETE FROM employees WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`, [restaurantUuid, legacyId]);
    events.push(await recordEvent(client, {
      restaurantUuid, restId, type: REALTIME_EVENTS.EMPLOYEE_STATUS_CHANGED,
      path: `restaurants/${restId}/users/${legacyId}`, payload: { userId: legacyId, deleted: true },
    }));
    return null;
  }
  const consumed = new Set(["name", "login", "role", "active", "modules", "actions", "createdAt", "updatedAt", "_pgId"]);
  const extra = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!consumed.has(k) && v !== undefined) extra[k] = v;
  }
  const login = payload.login || extra.username || legacyId;
  const { rows } = await client.query(
    `INSERT INTO employees (legacy_rtdb_id, restaurant_id, name, login, role, active, modules, actions, extra)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)
     ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, employees.name),
        role = COALESCE(EXCLUDED.role, employees.role),
        login = COALESCE(EXCLUDED.login, employees.login),
        active = COALESCE(EXCLUDED.active, employees.active),
        modules = COALESCE(EXCLUDED.modules, employees.modules),
        actions = COALESCE(EXCLUDED.actions, employees.actions),
        extra = COALESCE(employees.extra, '{}'::jsonb) || EXCLUDED.extra
     RETURNING *`,
    [
      legacyId, restaurantUuid,
      payload.name ?? login, login, payload.role ?? "waiter",
      payload.active == null ? true : payload.active !== false,
      payload.modules != null ? json(payload.modules) : null,
      payload.actions != null ? json(payload.actions) : null,
      json(extra),
    ]
  );
  const shaped = employeeToRtdb(rows[0]);
  events.push(await recordEvent(client, {
    restaurantUuid, restId, type: REALTIME_EVENTS.EMPLOYEE_STATUS_CHANGED,
    path: `restaurants/${restId}/users/${legacyId}`,
    payload: { userId: legacyId, user: shaped },
  }));
  return shaped;
}

export async function listMenuMap(client, restaurantUuid) {
  const { rows } = await client.query(`SELECT * FROM menu_items WHERE restaurant_id = $1`, [restaurantUuid]);
  const catRows = await client.query(
    `SELECT id, legacy_rtdb_id FROM menu_categories WHERE restaurant_id = $1`,
    [restaurantUuid]
  );
  const catById = new Map(catRows.rows.map((c) => [c.id, c.legacy_rtdb_id]));
  const out = {};
  for (const row of rows) {
    if (!row.legacy_rtdb_id) continue;
    const shaped = menuItemToRtdb(row);
    if (row.category_id) shaped.categoryId = catById.get(row.category_id) || shaped.categoryId;
    if (row.subcategory_id) shaped.subcategoryId = catById.get(row.subcategory_id);
    out[row.legacy_rtdb_id] = shaped;
  }
  return out;
}

export async function upsertMenuItem(client, ctx, legacyId, payload, events) {
  const { restaurantUuid, restId } = ctx;
  if (payload == null) {
    await client.query(`DELETE FROM menu_items WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`, [restaurantUuid, legacyId]);
    events.push(await recordEvent(client, {
      restaurantUuid, restId, type: REALTIME_EVENTS.MENU_UPDATED,
      path: `restaurants/${restId}/menu/${legacyId}`, payload: { menuId: legacyId, deleted: true },
    }));
    return null;
  }
  let categoryId = null;
  if (payload.categoryId) {
    const c = await client.query(
      `SELECT id FROM menu_categories WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
      [restaurantUuid, String(payload.categoryId)]
    );
    categoryId = c.rows[0]?.id || null;
  }
  const consumed = new Set([
    "name", "price", "imgUrl", "image", "active", "isCombo", "isWeightBased", "isFeatured", "isNew",
    "portionSize", "variants", "prepTime", "categoryId", "category", "subcategoryId", "createdAt", "updatedAt", "_pgId",
  ]);
  const extra = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!consumed.has(k) && v !== undefined) extra[k] = v;
  }
  const { rows } = await client.query(
    `INSERT INTO menu_items (
        legacy_rtdb_id, restaurant_id, category_id, name, price, img_url, active,
        is_combo, is_weight_based, is_featured, is_new, portion_size, variants, prep_time, extra
     ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb)
     ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
        category_id = COALESCE(EXCLUDED.category_id, menu_items.category_id),
        name = EXCLUDED.name,
        price = EXCLUDED.price,
        img_url = COALESCE(EXCLUDED.img_url, menu_items.img_url),
        active = EXCLUDED.active,
        is_combo = EXCLUDED.is_combo,
        extra = COALESCE(menu_items.extra, '{}'::jsonb) || EXCLUDED.extra
     RETURNING *`,
    [
      legacyId, restaurantUuid, categoryId,
      json(payload.name ?? ""), money(payload.price),
      payload.imgUrl || payload.image || null,
      payload.active !== false,
      payload.isCombo === true, payload.isWeightBased === true,
      payload.isFeatured === true, payload.isNew === true,
      payload.portionSize || null,
      payload.variants != null ? json(payload.variants) : null,
      payload.prepTime || null, json(extra),
    ]
  );
  events.push(await recordEvent(client, {
    restaurantUuid, restId, type: REALTIME_EVENTS.MENU_UPDATED,
    path: `restaurants/${restId}/menu/${legacyId}`,
    payload: { menuId: legacyId, item: menuItemToRtdb(rows[0]) },
  }));
  return menuItemToRtdb(rows[0]);
}

export async function listCategoriesMap(client, restaurantUuid) {
  const { rows } = await client.query(`SELECT * FROM menu_categories WHERE restaurant_id = $1`, [restaurantUuid]);
  const children = {};
  const tops = [];
  for (const row of rows) {
    if (row.parent_id) {
      if (!children[row.parent_id]) children[row.parent_id] = {};
      if (row.legacy_rtdb_id) children[row.parent_id][row.legacy_rtdb_id] = categoryToRtdb(row);
    } else {
      tops.push(row);
    }
  }
  const out = {};
  for (const row of tops) {
    if (!row.legacy_rtdb_id) continue;
    out[row.legacy_rtdb_id] = categoryToRtdb(row, children);
  }
  return out;
}

export async function upsertCategory(client, ctx, legacyId, payload, events) {
  const { restaurantUuid, restId } = ctx;
  if (payload == null) {
    await client.query(`DELETE FROM menu_categories WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`, [restaurantUuid, legacyId]);
    return null;
  }
  const extra = {};
  const { rows } = await client.query(
    `INSERT INTO menu_categories (legacy_rtdb_id, restaurant_id, name, extra)
     VALUES ($1,$2,$3::jsonb,$4::jsonb)
     ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
        name = EXCLUDED.name,
        extra = COALESCE(menu_categories.extra, '{}'::jsonb) || EXCLUDED.extra
     RETURNING *`,
    [legacyId, restaurantUuid, json(payload.name ?? payload), json(extra)]
  );
  events.push(await recordEvent(client, {
    restaurantUuid, restId, type: REALTIME_EVENTS.MENU_UPDATED,
    path: `restaurants/${restId}/categories/${legacyId}`,
    payload: { categoryId: legacyId },
  }));
  return categoryToRtdb(rows[0]);
}

export async function listCustomersMap(client, restaurantUuid) {
  const { rows } = await client.query(`SELECT * FROM customers WHERE restaurant_id = $1`, [restaurantUuid]);
  return mapByLegacy(rows, customerToRtdb);
}

export async function upsertCustomer(client, ctx, legacyId, payload, events) {
  const { restaurantUuid, restId } = ctx;
  if (payload == null) {
    await client.query(`DELETE FROM customers WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`, [restaurantUuid, legacyId]);
    return null;
  }
  const consumed = new Set([
    "name", "notes", "status", "personalDiscount", "discountPercent", "totalSpent", "ordersCount",
    "visits", "lastVisit", "loyaltyLevel", "loyaltyPoints", "isVip", "createdAt", "updatedAt", "id", "_pgId",
  ]);
  const extra = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!consumed.has(k) && v !== undefined) extra[k] = v;
  }
  const phone = payload.normalizedPhone || payload.phone || legacyId;
  await client.query(
    `INSERT INTO customers (
        legacy_rtdb_id, restaurant_id, original_phone_key, normalized_phone, name, notes, status,
        personal_discount, discount_percent, total_spent, orders_count, visits, loyalty_level, loyalty_points, is_vip, extra
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
     ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, customers.name),
        notes = COALESCE(EXCLUDED.notes, customers.notes),
        personal_discount = EXCLUDED.personal_discount,
        extra = COALESCE(customers.extra, '{}'::jsonb) || EXCLUDED.extra`,
    [
      legacyId, restaurantUuid, legacyId, typeof phone === "string" ? phone : null,
      payload.name || null, payload.notes || null, payload.status || null,
      money(payload.personalDiscount), payload.discountPercent != null ? money(payload.discountPercent) : null,
      money(payload.totalSpent), payload.ordersCount || 0, payload.visits || 0,
      payload.loyaltyLevel || null, money(payload.loyaltyPoints), payload.isVip === true, json(extra),
    ]
  );
  events.push(await recordEvent(client, {
    restaurantUuid, restId, type: REALTIME_EVENTS.CUSTOMER_UPDATED,
    path: `restaurants/${restId}/customers/${legacyId}`, payload: { customerId: legacyId },
  }));
  const map = await listCustomersMap(client, restaurantUuid);
  return map[legacyId];
}

export async function listReservationsMap(client, restaurantUuid) {
  const { rows } = await client.query(`SELECT * FROM reservations WHERE restaurant_id = $1`, [restaurantUuid]);
  return mapByLegacy(rows, reservationToRtdb);
}

export async function upsertReservation(client, ctx, legacyId, payload, events) {
  const { restaurantUuid, restId } = ctx;
  if (payload == null) {
    await client.query(`DELETE FROM reservations WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`, [restaurantUuid, legacyId]);
    events.push(await recordEvent(client, {
      restaurantUuid, restId, type: REALTIME_EVENTS.RESERVATION_UPDATED,
      path: `restaurants/${restId}/reservations/${legacyId}`, payload: { reservationId: legacyId, deleted: true },
    }));
    return null;
  }
  const extra = { ...asObject(payload) };
  delete extra.status; delete extra.customerName; delete extra.customerPhone; delete extra.guests;
  delete extra.date; delete extra.time; delete extra.notes; delete extra.table;
  await client.query(
    `INSERT INTO reservations (
        legacy_rtdb_id, restaurant_id, legacy_table_key, customer_name, customer_phone,
        guests, reserved_date, reserved_time, status, status_raw, notes, extra
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
        customer_name = COALESCE(EXCLUDED.customer_name, reservations.customer_name),
        customer_phone = COALESCE(EXCLUDED.customer_phone, reservations.customer_phone),
        guests = COALESCE(EXCLUDED.guests, reservations.guests),
        reserved_date = COALESCE(EXCLUDED.reserved_date, reservations.reserved_date),
        reserved_time = COALESCE(EXCLUDED.reserved_time, reservations.reserved_time),
        status = EXCLUDED.status,
        status_raw = EXCLUDED.status_raw,
        notes = COALESCE(EXCLUDED.notes, reservations.notes),
        extra = COALESCE(reservations.extra, '{}'::jsonb) || EXCLUDED.extra`,
    [
      legacyId, restaurantUuid, payload.table != null ? String(payload.table) : null,
      payload.customerName || payload.name || null, payload.customerPhone || payload.phone || null,
      payload.guests != null ? Number(payload.guests) : null,
      payload.date || payload.reserved_date || null,
      payload.time || payload.reserved_time || null,
      payload.status || "pending", payload.status || "pending",
      payload.notes || null, json(extra),
    ]
  );
  events.push(await recordEvent(client, {
    restaurantUuid, restId, type: REALTIME_EVENTS.RESERVATION_UPDATED,
    path: `restaurants/${restId}/reservations/${legacyId}`, payload: { reservationId: legacyId },
  }));
  const map = await listReservationsMap(client, restaurantUuid);
  return map[legacyId];
}

export async function listInventoryMap(client, restaurantUuid, trackedAs = null) {
  const q = trackedAs
    ? [`SELECT * FROM inventory_items WHERE restaurant_id = $1 AND tracked_as IN ($2, 'both')`, [restaurantUuid, trackedAs]]
    : [`SELECT * FROM inventory_items WHERE restaurant_id = $1`, [restaurantUuid]];
  const { rows } = await client.query(q[0], q[1]);
  return mapByLegacy(rows, inventoryToRtdb);
}

export async function upsertInventory(client, ctx, legacyId, payload, events, trackedAs = "inventory") {
  const { restaurantUuid, restId } = ctx;
  if (payload == null) {
    await client.query(`DELETE FROM inventory_items WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`, [restaurantUuid, legacyId]);
    events.push(await recordEvent(client, {
      restaurantUuid, restId, type: REALTIME_EVENTS.INVENTORY_UPDATED,
      path: `restaurants/${restId}/inventory/${legacyId}`, payload: { itemId: legacyId, deleted: true },
    }));
    return null;
  }
  const extra = {};
  await client.query(
    `INSERT INTO inventory_items (legacy_rtdb_id, restaurant_id, name, category, unit, stock, min_stock, price, tracked_as, extra)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, inventory_items.name),
        stock = EXCLUDED.stock,
        min_stock = COALESCE(EXCLUDED.min_stock, inventory_items.min_stock),
        price = EXCLUDED.price,
        extra = COALESCE(inventory_items.extra, '{}'::jsonb) || EXCLUDED.extra`,
    [
      legacyId, restaurantUuid, payload.name || legacyId, payload.category || null,
      payload.unit || "dona", money(payload.stock), payload.minStock != null ? money(payload.minStock) : null,
      money(payload.price), trackedAs, json(extra),
    ]
  );
  events.push(await recordEvent(client, {
    restaurantUuid, restId, type: REALTIME_EVENTS.INVENTORY_UPDATED,
    path: `restaurants/${restId}/${trackedAs === "ingredients" ? "ingredients" : "inventory"}/${legacyId}`,
    payload: { itemId: legacyId },
  }));
  return payload;
}

export async function listNotificationsMap(client, restaurantUuid) {
  const { rows } = await client.query(
    `SELECT * FROM notifications_log WHERE restaurant_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [restaurantUuid]
  );
  return mapByLegacy(rows, notificationToRtdb);
}

export async function upsertNotification(client, ctx, legacyId, payload, events) {
  const { restaurantUuid, restId } = ctx;
  const key = legacyId || pushId();
  await client.query(
    `INSERT INTO notifications_log (legacy_rtdb_id, restaurant_id, channel, recipient, subject, body, status, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
        body = COALESCE(EXCLUDED.body, notifications_log.body),
        status = COALESCE(EXCLUDED.status, notifications_log.status),
        payload = notifications_log.payload || EXCLUDED.payload`,
    [
      key, restaurantUuid, payload.channel || "in_app", payload.recipient || null,
      payload.subject || payload.title || null, payload.body || payload.message || null,
      payload.status || "unread", json(payload),
    ]
  );
  events.push(await recordEvent(client, {
    restaurantUuid, restId, type: REALTIME_EVENTS.NOTIFICATION_CREATED,
    path: `restaurants/${restId}/notifications/${key}`, payload: { notificationId: key, notification: payload },
  }));
  return key;
}

export async function listCouriersMap(client, restaurantUuid) {
  const { rows } = await client.query(`SELECT * FROM couriers WHERE restaurant_id = $1`, [restaurantUuid]);
  const out = {};
  for (const row of rows) {
    if (!row.legacy_rtdb_id) continue;
    out[row.legacy_rtdb_id] = {
      ...asObject(row.extra),
      name: row.name, phone: row.phone, status: row.status,
      vehicleType: row.vehicle_type, active: row.active !== false,
      _pgId: row.id,
    };
  }
  return out;
}

export async function upsertCourier(client, ctx, legacyId, payload, events) {
  const { restaurantUuid, restId } = ctx;
  const extra = { ...asObject(payload) };
  await client.query(
    `INSERT INTO couriers (legacy_rtdb_id, restaurant_id, name, phone, status, vehicle_type, active, extra)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, couriers.name),
        phone = COALESCE(EXCLUDED.phone, couriers.phone),
        status = EXCLUDED.status,
        extra = COALESCE(couriers.extra, '{}'::jsonb) || EXCLUDED.extra`,
    [
      legacyId, restaurantUuid, payload.name || null, payload.phone || null,
      payload.status || "offline", payload.vehicleType || payload.vehicle_type || null,
      payload.active !== false, json(extra),
    ]
  );
  events.push(await recordEvent(client, {
    restaurantUuid, restId, type: REALTIME_EVENTS.COURIER_STATUS_CHANGED,
    path: `restaurants/${restId}/couriers/${legacyId}`,
    payload: { courierId: legacyId, status: payload.status },
  }));
  return payload;
}

function canonAssignmentStatus(raw) {
  const s = String(raw || "assigned");
  const allowed = new Set([
    "assigned", "accepted", "heading_to_restaurant", "picked_up",
    "delivering", "delivered", "cancelled", "unknown",
  ]);
  if (allowed.has(s)) return s;
  if (s === "arrived") return "heading_to_restaurant";
  if (s === "in_transit" || s === "arrived_customer") return "delivering";
  if (s === "completed") return "delivered";
  if (s === "customer_not_found" || s === "returned" || s === "expired") return "cancelled";
  if (s === "waiting_for_courier") return "assigned";
  return "unknown";
}

export function assignmentToRtdb(row) {
  return {
    ...asObject(row.extra),
    orderId: row.legacy_order_id,
    courierId: row.legacy_courier_id,
    status: row.status_raw || row.status,
    subStage: row.sub_stage || asObject(row.extra).subStage,
    assignedAt: toMs(row.assigned_at),
    _pgId: row.id,
  };
}

export async function getCourierAssignment(client, restaurantUuid, legacyId) {
  const { rows } = await client.query(
    `SELECT * FROM courier_assignments WHERE restaurant_id = $1 AND legacy_rtdb_id = $2 LIMIT 1`,
    [restaurantUuid, legacyId]
  );
  return rows[0] ? assignmentToRtdb(rows[0]) : null;
}

export async function upsertCourierAssignment(client, ctx, legacyId, payload, events) {
  const { restaurantUuid, restId } = ctx;
  const key = legacyId || pushId();
  let orderUuid = null;
  if (payload.orderId) {
    const o = await client.query(
      `SELECT id FROM orders WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
      [restaurantUuid, String(payload.orderId)]
    );
    orderUuid = o.rows[0]?.id || null;
  }
  let courierUuid = null;
  if (payload.courierId) {
    const c = await client.query(
      `SELECT id FROM couriers WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
      [restaurantUuid, String(payload.courierId)]
    );
    courierUuid = c.rows[0]?.id || null;
  }
  const statusRaw = payload.status || "assigned";
  const extra = { ...payload };
  await client.query(
    `INSERT INTO courier_assignments (
        legacy_rtdb_id, restaurant_id, order_id, legacy_order_id,
        courier_id, legacy_courier_id, status, status_raw, sub_stage, assigned_at, extra
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
        order_id = COALESCE(EXCLUDED.order_id, courier_assignments.order_id),
        legacy_order_id = COALESCE(EXCLUDED.legacy_order_id, courier_assignments.legacy_order_id),
        courier_id = EXCLUDED.courier_id,
        legacy_courier_id = EXCLUDED.legacy_courier_id,
        status = EXCLUDED.status,
        status_raw = EXCLUDED.status_raw,
        sub_stage = COALESCE(EXCLUDED.sub_stage, courier_assignments.sub_stage),
        extra = COALESCE(courier_assignments.extra, '{}'::jsonb) || EXCLUDED.extra`,
    [
      key, restaurantUuid, orderUuid, payload.orderId || null,
      courierUuid, payload.courierId || null,
      canonAssignmentStatus(statusRaw), String(statusRaw),
      payload.subStage || null,
      payload.assignedAt ? new Date(payload.assignedAt) : new Date(),
      json(extra),
    ]
  );
  events.push(await recordEvent(client, {
    restaurantUuid, restId, type: REALTIME_EVENTS.COURIER_STATUS_CHANGED,
    path: `restaurants/${restId}/courierAssignments/${key}`,
    payload: { assignmentId: key, orderId: payload.orderId, courierId: payload.courierId, status: statusRaw },
  }));
  return key;
}

export async function listCourierAssignmentsMap(client, restaurantUuid) {
  const { rows } = await client.query(`SELECT * FROM courier_assignments WHERE restaurant_id = $1`, [restaurantUuid]);
  const out = {};
  for (const row of rows) {
    if (!row.legacy_rtdb_id) continue;
    out[row.legacy_rtdb_id] = {
      ...asObject(row.extra),
      orderId: row.legacy_order_id, courierId: row.legacy_courier_id,
      status: row.status_raw || row.status,
      assignedAt: toMs(row.assigned_at),
    };
  }
  return out;
}

export async function listChangeRequestsMap(client, restaurantUuid) {
  const { rows } = await client.query(`SELECT * FROM order_change_requests WHERE restaurant_id = $1`, [restaurantUuid]);
  const out = {};
  for (const row of rows) {
    if (!row.legacy_rtdb_id) continue;
    out[row.legacy_rtdb_id] = {
      ...asObject(row.payload),
      orderId: row.legacy_order_id, requestType: row.request_type_raw || row.request_type,
      status: row.status_raw || row.status, reason: row.reason,
      requestedBy: row.requested_by, createdAt: toMs(row.created_at),
    };
  }
  return out;
}

export async function upsertChangeRequest(client, ctx, legacyId, payload, events) {
  const { restaurantUuid, restId } = ctx;
  const key = legacyId || pushId();
  let orderId = null;
  if (payload.orderId) {
    const o = await client.query(
      `SELECT id FROM orders WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
      [restaurantUuid, payload.orderId]
    );
    orderId = o.rows[0]?.id || null;
  }
  await client.query(
    `INSERT INTO order_change_requests (
        legacy_rtdb_id, restaurant_id, order_id, legacy_order_id, request_type, request_type_raw,
        status, status_raw, requested_by, reason, payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
        status = EXCLUDED.status,
        status_raw = EXCLUDED.status_raw,
        payload = order_change_requests.payload || EXCLUDED.payload`,
    [
      key, restaurantUuid, orderId, payload.orderId || null,
      payload.requestType && ["cancel_item","replace_item","change_qty","cancel_order"].includes(payload.requestType)
        ? payload.requestType : "cancel_item",
      payload.requestType || "cancel_item",
      payload.status || "pending", payload.status || "pending",
      payload.requestedBy || ctx.userId || null, payload.reason || null, json(payload),
    ]
  );
  events.push(await recordEvent(client, {
    restaurantUuid, restId, type: REALTIME_EVENTS.ORDER_UPDATED,
    path: `restaurants/${restId}/orderChangeRequests/${key}`, payload: { requestId: key },
  }));
  return key;
}

export async function listKitchenStationsMap(client, restaurantUuid) {
  const { rows } = await client.query(`SELECT * FROM kitchen_stations WHERE restaurant_id = $1`, [restaurantUuid]);
  const out = {};
  for (const row of rows) {
    if (!row.legacy_rtdb_id) continue;
    out[row.legacy_rtdb_id] = { name: row.name, _pgId: row.id };
  }
  return out;
}

export async function getReportsSummary(client, restaurantUuid) {
  const { rows } = await client.query(
    `SELECT
        count(*)::int AS orders,
        COALESCE(SUM(total),0) AS revenue,
        count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
        count(*) FILTER (WHERE payment_status = 'paid')::int AS paid
       FROM orders WHERE restaurant_id = $1`,
    [restaurantUuid]
  );
  return rows[0];
}

export { pushId };
