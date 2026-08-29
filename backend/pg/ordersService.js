import { REALTIME_EVENTS, KITCHEN_STATUSES } from "./events.js";
import { pushId } from "./pushId.js";
import { recordEvent } from "./hub.js";
import {
  orderToRtdb, itemToRtdb, paymentToRtdb, money, asObject, toMs,
} from "./shape.js";
import { sanitizeCustomerOrderCreate, sanitizeCustomerOrderUpdate } from "./customerPolicy.js";
import { priceCustomerOrderItems, priceCustomerLineFromCatalog, loadCustomerCatalog } from "./customerPricing.js";

export const ORDER_STATUS_IN = Object.freeze({
  order_created: "order_created",
  created: "order_created",
  new: "order_created",
  Yangi: "order_created",
  confirmed: "confirmed",
  approved: "confirmed",
  Tasdiqlandi: "confirmed",
  cooking: "cooking",
  preparing: "cooking",
  "tayyorlanmoqda": "cooking",
  Tayyorlanmoqda: "cooking",
  ready: "ready",
  Tayyor: "ready",
  picked_up: "picked_up",
  served: "served",
  payment: "payment_requested",
  payment_requested: "payment_requested",
  paid: "paid",
  completed: "completed",
  closed: "completed",
  Yopildi: "completed",
  cancelled: "cancelled",
  canceled: "cancelled",
  "bekor qilindi": "cancelled",
});

export function normalizeStatus(raw) {
  if (raw == null || raw === "") return null;
  if (Object.prototype.hasOwnProperty.call(ORDER_STATUS_IN, raw)) return ORDER_STATUS_IN[raw];
  const k = String(raw).trim();
  if (Object.prototype.hasOwnProperty.call(ORDER_STATUS_IN, k)) return ORDER_STATUS_IN[k];
  const lower = k.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ORDER_STATUS_IN, lower)) return ORDER_STATUS_IN[lower];
  return null;
}

async function loadEmployeeLegacyMap(client, restaurantUuid) {
  const { rows } = await client.query(
    `SELECT id, legacy_rtdb_id FROM employees WHERE restaurant_id = $1 AND legacy_rtdb_id IS NOT NULL`,
    [restaurantUuid]
  );
  const byId = new Map();
  const byLegacy = new Map();
  for (const r of rows) {
    byId.set(r.id, r.legacy_rtdb_id);
    byLegacy.set(r.legacy_rtdb_id, r.id);
  }
  return { byId, byLegacy };
}

async function resolveTable(client, restaurantUuid, tableVal) {
  if (tableVal == null || tableVal === "") return { id: null, label: null, key: null };
  const label = String(tableVal);
  const asNum = Number(tableVal);
  const { rows } = await client.query(
    `SELECT id, legacy_rtdb_id, number FROM tables
      WHERE restaurant_id = $1
        AND (legacy_rtdb_id = $2 OR number = $3)
      LIMIT 1`,
    [restaurantUuid, label, Number.isFinite(asNum) ? asNum : -1]
  );
  if (rows[0]) return { id: rows[0].id, label, key: rows[0].legacy_rtdb_id };
  return { id: null, label, key: null };
}

export async function assembleOrder(client, restaurantUuid, row, empMap) {
  const { rows: itemRows } = await client.query(
    `SELECT * FROM order_items WHERE restaurant_id = $1 AND order_id = $2 ORDER BY created_at`,
    [restaurantUuid, row.id]
  );
  const { rows: payRows } = await client.query(
    `SELECT * FROM payments WHERE restaurant_id = $1 AND order_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [restaurantUuid, row.id]
  );
  const items = {};
  for (const it of itemRows) {
    if (it.legacy_rtdb_id) items[it.legacy_rtdb_id] = itemToRtdb(it);
  }
  let map = empMap;
  if (!map) {
    try {
      map = await loadEmployeeLegacyMap(client, restaurantUuid);
    } catch {
      map = { byId: new Map(), byLegacy: new Map() };
    }
  }
  return orderToRtdb(row, {
    items,
    payment: paymentToRtdb(payRows[0] || null),
    waiterLegacy: row.waiter_id ? map.byId.get(row.waiter_id) : null,
    chefLegacy: row.chef_id ? map.byId.get(row.chef_id) : null,
    createdByLegacy: row.created_by_employee_id ? map.byId.get(row.created_by_employee_id) : null,
  });
}

export async function getOrderByLegacy(client, restaurantUuid, legacyId) {
  const { rows } = await client.query(
    `SELECT * FROM orders WHERE restaurant_id = $1 AND legacy_rtdb_id = $2 LIMIT 1`,
    [restaurantUuid, legacyId]
  );
  if (!rows[0]) return null;
  return assembleOrder(client, restaurantUuid, rows[0]);
}

export async function listOrdersMap(client, restaurantUuid, { limit = 500 } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM orders WHERE restaurant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [restaurantUuid, Math.min(2000, Math.max(1, Number(limit) || 500))]
  );
  const empMap = await loadEmployeeLegacyMap(client, restaurantUuid);
  const out = {};
  for (const row of rows) {
    if (!row.legacy_rtdb_id) continue;
    out[row.legacy_rtdb_id] = await assembleOrder(client, restaurantUuid, row, empMap);
  }
  return out;
}

async function nextOrderNumber(client, restaurantUuid, orderType) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(order_number), 0)::int AS n
       FROM orders
      WHERE restaurant_id = $1 AND order_type = $2`,
    [restaurantUuid, orderType || "dine_in"]
  );
  return (rows[0]?.n || 0) + 1;
}

export async function incrementCounter(client, restaurantUuid, counterKey) {
  await client.query(
    `INSERT INTO restaurant_settings (restaurant_id, settings)
     VALUES ($1, jsonb_build_object('meta', jsonb_build_object($2::text, 1)))
     ON CONFLICT (restaurant_id) DO UPDATE
       SET settings = COALESCE(restaurant_settings.settings, '{}'::jsonb)
         || jsonb_build_object(
              'meta',
              COALESCE(restaurant_settings.settings->'meta', '{}'::jsonb)
                || jsonb_build_object(
                     $2::text,
                     to_jsonb(COALESCE((restaurant_settings.settings->'meta'->>$2::text)::int, 0) + 1)
                   )
            )`,
    [restaurantUuid, counterKey]
  );
  const { rows } = await client.query(
    `SELECT (settings->'meta'->>$2)::int AS n FROM restaurant_settings WHERE restaurant_id = $1`,
    [restaurantUuid, counterKey]
  );
  return rows[0]?.n || 1;
}

function jsonOrText(v) {
  if (v == null) return JSON.stringify(null);
  if (typeof v === "object") return JSON.stringify(v);
  return JSON.stringify(v);
}

export async function upsertOrder(client, ctx, legacyId, payload, events) {
  const { restaurantUuid, restId, userId } = ctx;
  if (ctx.isCustomer === true) {
    const existingCustomer = await client.query(
      `SELECT * FROM orders WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
      [restaurantUuid, legacyId]
    );
    if (existingCustomer.rows[0]) {
      const current = await assembleOrder(client, restaurantUuid, existingCustomer.rows[0]);
      const allowed = sanitizeCustomerOrderUpdate(payload);
      payload = {
        ...current,
        ...allowed,
        status: existingCustomer.rows[0].status,
        statusKey: existingCustomer.rows[0].status,
        payment: current.payment,
        waiterId: current.waiterId,
        chefId: current.chefId,
        total: current.total,
        subtotal: current.subtotal,
        customerSessionId: existingCustomer.rows[0].customer_session_id || userId,
      };
    } else {
      payload = sanitizeCustomerOrderCreate(payload, ctx);
    }
    if (payload?.items && typeof payload.items === "object") {
      const priced = await priceCustomerOrderItems(client, ctx, payload.items);
      if (!priced.ok) return priced;
      payload.items = priced.items;
      payload.total = priced.total;
      payload.subtotal = priced.subtotal;
      payload.originalTotal = priced.originalTotal;
      payload.discountAmount = 0;
      payload.discount = 0;
    } else {
      payload.total = 0;
      payload.subtotal = 0;
      payload.originalTotal = 0;
      payload.discountAmount = 0;
    }
  }
  if (payload == null) {
    const existing = await client.query(
      `SELECT id FROM orders WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
      [restaurantUuid, legacyId]
    );
    if (existing.rows[0]) {
      await client.query(`DELETE FROM orders WHERE id = $1 AND restaurant_id = $2`, [existing.rows[0].id, restaurantUuid]);
      await recordEvent(client, {
        restaurantUuid, restId, type: REALTIME_EVENTS.ORDER_UPDATED,
        path: `restaurants/${restId}/orders/${legacyId}`,
        payload: { orderId: legacyId, deleted: true },
      }).then((e) => events.push(e));
    }
    return null;
  }

  const statusNorm = normalizeStatus(payload.statusKey || payload.statusV2 || payload.status) || "order_created";
  const tableInfo = await resolveTable(client, restaurantUuid, payload.table);
  const empMap = ctx.isCustomer === true
    ? { byId: new Map(), byLegacy: new Map() }
    : await loadEmployeeLegacyMap(client, restaurantUuid);
  const waiterId = payload.waiterId ? empMap.byLegacy.get(payload.waiterId) || null : null;
  const chefId = payload.chefId ? empMap.byLegacy.get(payload.chefId) || null : null;
  const createdBy = payload.createdByWaiterId ? empMap.byLegacy.get(payload.createdByWaiterId) || null : waiterId;

  let orderType = payload.orderType || null;
  if (!orderType) {
    if (payload.isDelivery === true || payload.deliveryType === "delivery" || payload.deliveryAddress) orderType = "delivery";
    else if (payload.table != null && payload.table !== "") orderType = "dine_in";
    else orderType = "unknown";
  }
  if (!["dine_in", "delivery", "takeaway", "pickup", "unknown"].includes(orderType)) orderType = "unknown";

  const createdAt = payload.createdAt ? new Date(payload.createdAt) : new Date();
  const orderNumber = payload.orderNumber != null && payload.orderNumber !== ""
    ? Number(payload.orderNumber)
    : await nextOrderNumber(client, restaurantUuid, orderType === "unknown" ? "dine_in" : orderType);

  const consumed = new Set([
    "status", "statusKey", "statusV2", "statusLabel", "statusV2Label", "statusHistory",
    "orderNumber", "orderType", "deliveryType", "isDelivery", "source", "table",
    "waiterId", "chefId", "createdByWaiterId", "createdByWaiter", "createdByWaiterName",
    "createdByClient", "clientId", "customerId", "customerName", "customerPhone", "clientPhone",
    "total", "originalTotal", "discount", "discountAmount", "discountPercent",
    "discountSource", "discountReason", "discountApplied", "deliveryFee", "fastFeeAmount",
    "payment", "paymentMethod", "deliveryPaymentMethod", "paidAt", "deliveryAddress",
    "notes", "priority", "loyaltyLevel", "loyaltyVisits", "loyaltyAutoApplied",
    "inventoryDeducted", "chefScoreAwarded", "items", "createdAt", "updatedAt",
    "confirmedAt", "approvedAt", "cookingStartedAt", "startedAt", "readyAt", "finishedAt",
    "deliveredAt", "cancelledAt", "serviceFeeAmount", "subtotal", "id", "_pgId",
    "customerSessionId",
  ]);
  const extra = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!consumed.has(k) && v !== undefined) extra[k] = v;
  }
  extra.customerSessionId = ctx.isCustomer === true
    ? (userId || ctx.customerSessionId)
    : (extra.customerSessionId || payload.customerSessionId || null);

  const paymentStatus = ctx.isCustomer === true
    ? (payload.paymentStatus || "unpaid")
    : (payload.payment?.paid === true ? "paid"
      : payload.payment?.requested === true ? "pending"
      : (payload.paymentMethod === "pending" ? "pending" : "unpaid"));

  const params = {
    legacy_rtdb_id: legacyId,
    restaurant_id: restaurantUuid,
    order_number: Number.isFinite(orderNumber) ? orderNumber : null,
    order_type: orderType,
    source: payload.source || (payload.createdByWaiter ? "waiter" : null),
    table_id: tableInfo.id,
    table_label: tableInfo.label,
    waiter_id: waiterId,
    chef_id: chefId,
    created_by_employee_id: createdBy,
    customer_name_snapshot: payload.customerName || null,
    customer_phone_snapshot: payload.customerPhone || payload.clientPhone || null,
    status: statusNorm,
    status_raw: payload.status != null ? String(payload.status) : statusNorm,
    status_key_raw: payload.statusKey != null ? String(payload.statusKey) : statusNorm,
    status_v2_raw: payload.statusV2 != null ? String(payload.statusV2) : statusNorm,
    status_label_raw: payload.statusLabel != null ? String(payload.statusLabel) : null,
    subtotal: money(payload.subtotal),
    discount_amount: money(payload.discountAmount ?? payload.discount),
    discount_percent: payload.discountPercent != null ? money(payload.discountPercent) : null,
    discount_source: payload.discountSource || null,
    discount_reason: payload.discountReason || null,
    service_fee_amount: money(payload.serviceFeeAmount ?? payload.payment?.serviceFeeAmount),
    delivery_fee: money(payload.deliveryFee),
    fast_fee_amount: money(payload.fastFeeAmount),
    original_total: money(payload.originalTotal || payload.total),
    total: money(payload.total),
    payment_status: paymentStatus,
    payment_method: payload.payment?.method || payload.paymentMethod || null,
    delivery_address: payload.deliveryAddress != null ? payload.deliveryAddress : null,
    delivery_type: payload.deliveryType || null,
    is_delivery: payload.isDelivery === true || orderType === "delivery",
    notes: payload.notes || null,
    priority: payload.priority === true,
    extra,
    created_at: createdAt,
    confirmed_at: payload.confirmedAt || payload.approvedAt ? new Date(payload.confirmedAt || payload.approvedAt) : (statusNorm === "confirmed" ? new Date() : null),
    cooking_started_at: payload.cookingStartedAt || payload.startedAt ? new Date(payload.cookingStartedAt || payload.startedAt) : (statusNorm === "cooking" ? new Date() : null),
    ready_at: payload.readyAt || payload.finishedAt ? new Date(payload.readyAt || payload.finishedAt) : (statusNorm === "ready" ? new Date() : null),
    served_at: payload.servedAt ? new Date(payload.servedAt) : (statusNorm === "served" ? new Date() : null),
    paid_at: payload.paidAt || payload.payment?.paidAt ? new Date(payload.paidAt || payload.payment.paidAt) : (statusNorm === "paid" || payload.payment?.paid ? new Date() : null),
    cancelled_at: payload.cancelledAt ? new Date(payload.cancelledAt) : (statusNorm === "cancelled" ? new Date() : null),
    customer_session_id: ctx.isCustomer === true
      ? String(userId || ctx.customerSessionId || ctx.uid || "")
      : (payload.customerSessionId || extra.customerSessionId || null),
  };

  const { rows } = await client.query(
    `INSERT INTO orders (
        legacy_rtdb_id, restaurant_id, order_number, order_type, source,
        table_id, table_label, waiter_id, chef_id, created_by_employee_id,
        customer_name_snapshot, customer_phone_snapshot,
        status, status_raw, status_key_raw, status_v2_raw, status_label_raw,
        subtotal, discount_amount, discount_percent, discount_source, discount_reason,
        service_fee_amount, delivery_fee, fast_fee_amount, original_total, total,
        payment_status, payment_method,         delivery_address, delivery_type, is_delivery,
        notes, priority, extra, created_at,
        confirmed_at, cooking_started_at, ready_at, served_at, paid_at, cancelled_at,
        customer_session_id
     ) VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,$8,$9,$10,
        $11,$12,
        $13,$14,$15,$16,$17,
        $18,$19,$20,$21,$22,
        $23,$24,$25,$26,$27,
        $28,$29,$30::jsonb,$31,$32,
        $33,$34,$35::jsonb,$36,
        $37,$38,$39,$40,$41,$42,
        NULLIF(COALESCE($43, current_setting('app.current_customer_uid', true)), '')
     )
     ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
        order_number = COALESCE(EXCLUDED.order_number, orders.order_number),
        order_type = EXCLUDED.order_type,
        source = COALESCE(EXCLUDED.source, orders.source),
        table_id = COALESCE(EXCLUDED.table_id, orders.table_id),
        table_label = COALESCE(EXCLUDED.table_label, orders.table_label),
        waiter_id = COALESCE(EXCLUDED.waiter_id, orders.waiter_id),
        chef_id = COALESCE(EXCLUDED.chef_id, orders.chef_id),
        created_by_employee_id = COALESCE(EXCLUDED.created_by_employee_id, orders.created_by_employee_id),
        customer_name_snapshot = COALESCE(EXCLUDED.customer_name_snapshot, orders.customer_name_snapshot),
        customer_phone_snapshot = COALESCE(EXCLUDED.customer_phone_snapshot, orders.customer_phone_snapshot),
        status = EXCLUDED.status,
        status_raw = EXCLUDED.status_raw,
        status_key_raw = EXCLUDED.status_key_raw,
        status_v2_raw = EXCLUDED.status_v2_raw,
        status_label_raw = COALESCE(EXCLUDED.status_label_raw, orders.status_label_raw),
        subtotal = EXCLUDED.subtotal,
        discount_amount = EXCLUDED.discount_amount,
        discount_percent = EXCLUDED.discount_percent,
        discount_source = EXCLUDED.discount_source,
        discount_reason = EXCLUDED.discount_reason,
        service_fee_amount = EXCLUDED.service_fee_amount,
        delivery_fee = EXCLUDED.delivery_fee,
        fast_fee_amount = EXCLUDED.fast_fee_amount,
        original_total = EXCLUDED.original_total,
        total = EXCLUDED.total,
        payment_status = EXCLUDED.payment_status,
        payment_method = EXCLUDED.payment_method,
        delivery_address = COALESCE(EXCLUDED.delivery_address, orders.delivery_address),
        delivery_type = COALESCE(EXCLUDED.delivery_type, orders.delivery_type),
        is_delivery = EXCLUDED.is_delivery,
        notes = COALESCE(EXCLUDED.notes, orders.notes),
        priority = EXCLUDED.priority,
        extra = COALESCE(orders.extra, '{}'::jsonb) || EXCLUDED.extra,
        confirmed_at = COALESCE(EXCLUDED.confirmed_at, orders.confirmed_at),
        cooking_started_at = COALESCE(EXCLUDED.cooking_started_at, orders.cooking_started_at),
        ready_at = COALESCE(EXCLUDED.ready_at, orders.ready_at),
        served_at = COALESCE(EXCLUDED.served_at, orders.served_at),
        paid_at = COALESCE(EXCLUDED.paid_at, orders.paid_at),
        cancelled_at = COALESCE(EXCLUDED.cancelled_at, orders.cancelled_at),
        customer_session_id = COALESCE(orders.customer_session_id, EXCLUDED.customer_session_id)
     RETURNING *, (xmax = 0) AS inserted`,
    [
      params.legacy_rtdb_id, params.restaurant_id, params.order_number, params.order_type, params.source,
      params.table_id, params.table_label, params.waiter_id, params.chef_id, params.created_by_employee_id,
      params.customer_name_snapshot, params.customer_phone_snapshot,
      params.status, params.status_raw, params.status_key_raw, params.status_v2_raw, params.status_label_raw,
      params.subtotal, params.discount_amount, params.discount_percent, params.discount_source, params.discount_reason,
      params.service_fee_amount, params.delivery_fee, params.fast_fee_amount, params.original_total, params.total,
      params.payment_status, params.payment_method,
      params.delivery_address != null ? jsonOrText(params.delivery_address) : null,
      params.delivery_type, params.is_delivery,
      params.notes, params.priority, JSON.stringify(params.extra), params.created_at,
      params.confirmed_at, params.cooking_started_at, params.ready_at, params.served_at, params.paid_at, params.cancelled_at,
      params.customer_session_id,
    ]
  );
  const order = rows[0];
  const inserted = order.inserted === true;

  if (payload.items && typeof payload.items === "object") {
    const itemResult = await syncItems(client, ctx, order, payload.items, events);
    if (itemResult?.error) return itemResult;
  }
  if (ctx.isCustomer !== true && payload.payment && typeof payload.payment === "object") {
    await upsertPayment(client, ctx, order, payload.payment, events);
  }
  if (payload.statusHistory && typeof payload.statusHistory === "object") {
    await syncStatusHistory(client, restaurantUuid, order, payload.statusHistory, userId);
  }

  const shaped = await assembleOrder(client, restaurantUuid, order, empMap);
  const type = inserted ? REALTIME_EVENTS.ORDER_CREATED : REALTIME_EVENTS.ORDER_UPDATED;
  events.push(await recordEvent(client, {
    restaurantUuid, restId, type,
    path: `restaurants/${restId}/orders/${legacyId}`,
    payload: { orderId: legacyId, order: shaped, status: shaped.status, statusKey: shaped.statusKey },
  }));
  if (!inserted && payload.status != null) {
    events.push(await recordEvent(client, {
      restaurantUuid, restId, type: REALTIME_EVENTS.ORDER_STATUS_CHANGED,
      path: `restaurants/${restId}/orders/${legacyId}`,
      payload: { orderId: legacyId, status: shaped.status, statusKey: shaped.statusKey, order: shaped },
    }));
  }
  if (KITCHEN_STATUSES.has(statusNorm) || statusNorm === "order_created") {
    events.push(await recordEvent(client, {
      restaurantUuid, restId, type: REALTIME_EVENTS.KITCHEN_ORDER_UPDATED,
      path: `restaurants/${restId}/orders/${legacyId}`,
      payload: { orderId: legacyId, status: statusNorm, order: shaped },
    }));
  }
  return shaped;
}

async function syncItems(client, ctx, order, itemsObj, events) {
  const entries = Array.isArray(itemsObj)
    ? itemsObj.map((it, i) => [it.id || it.key || `item_${i}`, it])
    : Object.entries(itemsObj);
  for (const [itemKey, item] of entries) {
    if (!item) {
      await client.query(
        `DELETE FROM order_items WHERE order_id = $1 AND restaurant_id = $2 AND legacy_rtdb_id = $3`,
        [order.id, ctx.restaurantUuid, itemKey]
      );
      events.push(await recordEvent(client, {
        restaurantUuid: ctx.restaurantUuid, restId: ctx.restId,
        type: REALTIME_EVENTS.ORDER_ITEM_CHANGED,
        path: `restaurants/${ctx.restId}/orders/${order.legacy_rtdb_id}/items/${itemKey}`,
        payload: { orderId: order.legacy_rtdb_id, itemId: itemKey, deleted: true },
      }));
      continue;
    }
    const written = await upsertItem(client, ctx, order, itemKey, item, events);
    if (written && written.error) return written;
  }
  return null;
}

export async function upsertItem(client, ctx, orderOrLegacy, itemKey, item, events) {
  let order = orderOrLegacy;
  if (typeof orderOrLegacy === "string") {
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
      [ctx.restaurantUuid, orderOrLegacy]
    );
    order = rows[0];
    if (!order) return null;
  }
  if (ctx.isCustomer === true) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: "Invalid order", status: 400, code: "item_invalid" };
    }
    const catalog = await loadCustomerCatalog(client, ctx.restaurantUuid);
    const priced = priceCustomerLineFromCatalog(catalog, item, itemKey);
    if (!priced.ok) return priced;
    item = priced.item;
  }
  const qty = Number(item.qty || item.quantity || 1) || 1;
  const price = money(item.price);
  const nameSnap = item.name != null ? item.name : "";
  const itemStatus = ctx.isCustomer === true
    ? "pending"
    : (normalizeStatus(item.status) || item.status || "pending");
  const allowedItem = new Set(["pending", "cooking", "ready", "delivered", "served", "cancelled", "unknown"]);
  const st = allowedItem.has(itemStatus) ? itemStatus : "pending";

  await client.query(
    `INSERT INTO order_items (
        legacy_rtdb_id, order_id, restaurant_id, legacy_menu_id,
        name_snapshot, price_snapshot, qty, line_total,
        modifiers, extras, variant_snapshot, status, status_raw,
        kitchen_status, is_combo, notes, extra
     ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17::jsonb)
     ON CONFLICT (order_id, legacy_rtdb_id) DO UPDATE SET
        name_snapshot = EXCLUDED.name_snapshot,
        price_snapshot = EXCLUDED.price_snapshot,
        qty = EXCLUDED.qty,
        line_total = EXCLUDED.line_total,
        modifiers = EXCLUDED.modifiers,
        extras = EXCLUDED.extras,
        variant_snapshot = COALESCE(EXCLUDED.variant_snapshot, order_items.variant_snapshot),
        status = EXCLUDED.status,
        status_raw = EXCLUDED.status_raw,
        kitchen_status = EXCLUDED.kitchen_status,
        is_combo = EXCLUDED.is_combo,
        notes = EXCLUDED.notes,
        extra = COALESCE(order_items.extra, '{}'::jsonb) || EXCLUDED.extra`,
    [
      itemKey, order.id, ctx.restaurantUuid, item.menuId || item.id || null,
      jsonOrText(nameSnap), price, qty, price * qty,
      JSON.stringify(item.modifiers || []), JSON.stringify(item.extras || []),
      item.variant != null ? jsonOrText(item.variant) : null,
      st, ctx.isCustomer === true ? "pending" : (item.status != null ? String(item.status) : st),
      ctx.isCustomer === true ? null : (item.kitchenStatus || null),
      item.isCombo === true, item.notes || item.comment || null,
      JSON.stringify({}),
    ]
  );
  events.push(await recordEvent(client, {
    restaurantUuid: ctx.restaurantUuid, restId: ctx.restId,
    type: REALTIME_EVENTS.ORDER_ITEM_CHANGED,
    path: `restaurants/${ctx.restId}/orders/${order.legacy_rtdb_id}/items/${itemKey}`,
    payload: { orderId: order.legacy_rtdb_id, itemId: itemKey, item },
  }));
  return item;
}

export async function upsertPayment(client, ctx, order, payment, events) {
  const methodRaw = payment.method || payment.paymentMethod || "unknown";
  const methodMap = {
    cash: "cash", Naqd: "cash", card: "card", payme: "payme", Payme: "payme",
    click: "click", Click: "click", uzum: "uzum", transfer: "transfer",
    mixed: "mixed", pending: "pending",
  };
  const method = methodMap[methodRaw] || "unknown";
  await client.query(
    `INSERT INTO payments (
        legacy_rtdb_id, restaurant_id, order_id, legacy_order_id,
        method, method_raw, amount, service_fee_amount, final_total,
        paid, paid_at, requested, approved, extra
     ) VALUES ('payment',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'{}'::jsonb)
     ON CONFLICT (restaurant_id, legacy_order_id, legacy_rtdb_id) DO UPDATE SET
        method = EXCLUDED.method,
        method_raw = EXCLUDED.method_raw,
        amount = EXCLUDED.amount,
        service_fee_amount = EXCLUDED.service_fee_amount,
        final_total = EXCLUDED.final_total,
        paid = EXCLUDED.paid,
        paid_at = EXCLUDED.paid_at,
        requested = EXCLUDED.requested,
        approved = EXCLUDED.approved`,
    [
      ctx.restaurantUuid, order.id, order.legacy_rtdb_id,
      method, String(methodRaw),
      money(payment.amount ?? order.total),
      money(payment.serviceFeeAmount),
      payment.finalTotal != null ? money(payment.finalTotal) : money(order.total),
      payment.paid === true,
      payment.paidAt ? new Date(payment.paidAt) : (payment.paid === true ? new Date() : null),
      payment.requested === true,
      payment.approved === true,
    ]
  );
  if (payment.paid === true) {
    await client.query(
      `UPDATE orders SET payment_status = 'paid', paid_at = COALESCE(paid_at, now()), status = CASE WHEN status IN ('cancelled') THEN status ELSE 'paid' END
        WHERE id = $1 AND restaurant_id = $2`,
      [order.id, ctx.restaurantUuid]
    );
  } else if (payment.requested === true) {
    await client.query(
      `UPDATE orders SET payment_status = 'pending' WHERE id = $1 AND restaurant_id = $2`,
      [order.id, ctx.restaurantUuid]
    );
  }
  events.push(await recordEvent(client, {
    restaurantUuid: ctx.restaurantUuid, restId: ctx.restId,
    type: REALTIME_EVENTS.PAYMENT_UPDATED,
    path: `restaurants/${ctx.restId}/orders/${order.legacy_rtdb_id}/payment`,
    payload: { orderId: order.legacy_rtdb_id, payment },
  }));
}

async function syncStatusHistory(client, restaurantUuid, order, history, userId) {
  for (const [statusRaw, ts] of Object.entries(history)) {
    const changedAt = typeof ts === "number" ? new Date(ts)
      : (ts && typeof ts === "object" && ts.at) ? new Date(ts.at)
      : new Date();
    await client.query(
      `INSERT INTO order_status_history (order_id, restaurant_id, status, status_raw, changed_at, changed_by, source)
       VALUES ($1,$2,$3,$4,$5,$6,'api')
       ON CONFLICT (order_id, status_raw, changed_at) DO NOTHING`,
      [order.id, restaurantUuid, normalizeStatus(statusRaw) || statusRaw, statusRaw, changedAt, userId || null]
    );
  }
}

export async function patchOrderFields(client, ctx, legacyId, patch, events) {
  const { rows } = await client.query(
    `SELECT * FROM orders WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
    [ctx.restaurantUuid, legacyId]
  );
  if (!rows[0]) return { missing: true };
  const current = await assembleOrder(client, ctx.restaurantUuid, rows[0]);
  const merged = { ...current, ...patch };
  if (patch.items === undefined) delete merged.items;
  else merged.items = { ...(current.items || {}), ...patch.items };
  if (patch.payment && typeof patch.payment === "object") {
    merged.payment = { ...(current.payment || {}), ...patch.payment };
  }
  return upsertOrder(client, ctx, legacyId, merged, events);
}

export async function applyLifecycle(client, ctx, legacyId, action, body, events) {
  const statusByAction = {
    submit: "order_created",
    approve: "confirmed",
    cancel: "cancelled",
    "send-kitchen": "confirmed",
    kitchen: "confirmed",
    cooking: "cooking",
    ready: "ready",
    served: "served",
    completed: "completed",
    close: "completed",
    payment: "payment_requested",
  };
  if (action === "add-item") {
    const itemKey = body.itemId || pushId();
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
      [ctx.restaurantUuid, legacyId]
    );
    if (!rows[0]) return { error: "Order not found", status: 404 };
    const added = await upsertItem(client, ctx, rows[0], itemKey, body.item || body, events);
    if (added?.error) return added;
    await recomputeTotal(client, ctx.restaurantUuid, rows[0].id);
    return { order: await getOrderByLegacy(client, ctx.restaurantUuid, legacyId), itemId: itemKey };
  }
  if (action === "update-item") {
    const itemKey = body.itemId;
    if (!itemKey) return { error: "itemId required", status: 400 };
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
      [ctx.restaurantUuid, legacyId]
    );
    if (!rows[0]) return { error: "Order not found", status: 404 };
    const updated = await upsertItem(client, ctx, rows[0], itemKey, body.item || body, events);
    if (updated?.error) return updated;
    await recomputeTotal(client, ctx.restaurantUuid, rows[0].id);
    return { order: await getOrderByLegacy(client, ctx.restaurantUuid, legacyId) };
  }
  if (action === "remove-item") {
    const itemKey = body.itemId;
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
      [ctx.restaurantUuid, legacyId]
    );
    if (!rows[0]) return { error: "Order not found", status: 404 };
    await client.query(
      `DELETE FROM order_items WHERE order_id = $1 AND restaurant_id = $2 AND legacy_rtdb_id = $3`,
      [rows[0].id, ctx.restaurantUuid, itemKey]
    );
    await recomputeTotal(client, ctx.restaurantUuid, rows[0].id);
    events.push(await recordEvent(client, {
      restaurantUuid: ctx.restaurantUuid, restId: ctx.restId,
      type: REALTIME_EVENTS.ORDER_ITEM_CHANGED,
      path: `restaurants/${ctx.restId}/orders/${legacyId}/items/${itemKey}`,
      payload: { orderId: legacyId, itemId: itemKey, deleted: true },
    }));
    return { order: await getOrderByLegacy(client, ctx.restaurantUuid, legacyId) };
  }
  if (action === "pay" || action === "payment") {
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
      [ctx.restaurantUuid, legacyId]
    );
    if (!rows[0]) return { error: "Order not found", status: 404 };
    const payment = {
      requested: body.requested !== false,
      paid: body.paid === true || action === "pay",
      method: body.method || body.paymentMethod || "cash",
      amount: body.amount,
      approved: body.approved === true || body.paid === true,
    };
    await upsertPayment(client, ctx, rows[0], payment, events);
    if (payment.paid) {
      return patchOrderFields(client, ctx, legacyId, {
        status: "paid", statusKey: "paid", payment,
      }, events);
    }
    return patchOrderFields(client, ctx, legacyId, {
      status: "payment_requested", statusKey: "payment_requested", payment,
    }, events);
  }

  const next = body.status ? normalizeStatus(body.status) : statusByAction[action];
  if (!next) return { error: `Unknown action ${action}`, status: 400 };
  const patch = {
    status: next,
    statusKey: next,
    statusV2: next,
    updatedAt: Date.now(),
  };
  if (body.chefId) patch.chefId = body.chefId;
  if (body.statusLabel) patch.statusLabel = body.statusLabel;
  patch.statusHistory = { [next]: Date.now() };
  await appendTimeline(client, ctx, legacyId, action, next);
  return patchOrderFields(client, ctx, legacyId, patch, events);
}

async function recomputeTotal(client, restaurantUuid, orderId) {
  await client.query(
    `UPDATE orders SET total = COALESCE((
        SELECT SUM(line_total) FROM order_items WHERE order_id = $1 AND restaurant_id = $2 AND status <> 'cancelled'
     ), 0)
     WHERE id = $1 AND restaurant_id = $2`,
    [orderId, restaurantUuid]
  );
}

async function appendTimeline(client, ctx, legacyOrderId, eventType, message) {
  const { rows } = await client.query(
    `SELECT id FROM orders WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
    [ctx.restaurantUuid, legacyOrderId]
  );
  await client.query(
    `INSERT INTO order_timeline (legacy_rtdb_id, order_id, legacy_order_id, restaurant_id, event_type, actor_id, message, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
    [pushId(), rows[0]?.id || null, legacyOrderId, ctx.restaurantUuid, eventType, ctx.userId || null, message]
  );
}

export { loadEmployeeLegacyMap, resolveTable };
