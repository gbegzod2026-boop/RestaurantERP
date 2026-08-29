// pg/pathRouter.js — map Firebase RTDB paths onto PostgreSQL services.
// Unmapped tenant paths fail closed with unmapped_path. There is no
// native Firebase fallback from this router.
import { pushId } from "./pushId.js";
import { parseRestId } from "./restId.js";
import * as orders from "./ordersService.js";
import * as catalog from "./catalogService.js";
import { getSettings, getPublicSettingsRaw } from "./catalogService.js";
import { publicSettingsValue } from "./publicSettings.js";
import { REALTIME_EVENTS } from "./events.js";
import { recordEvent } from "./hub.js";

export const MAPPED_COLLECTIONS = new Set([
  "orders", "menu", "categories", "tables", "users", "customers", "reservations",
  "inventory", "ingredients", "notifications", "settings", "orderChangeRequests",
  "courierAssignments", "couriers", "orderTimeline", "meta", "activityLogs",
  "waiterCalls", "kitchenStations", "orderChats", "info", "subscription",
  "attendance", "kitchenAnnouncements", "chats", "superadmin_chat",
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
  if (segments[0] === "restaurants" && segments[1]) {
    const parsed = parseRestId(segments[1]);
    return parsed.ok ? parsed.restId : null;
  }
  return null;
}

function unmapped() {
  return { error: "Unsupported path", status: 400, code: "unmapped_path" };
}

function wrapWriteResult(result) {
  if (result && typeof result === "object" && result.error) return result;
  if (result && typeof result === "object" && result.fallback) return unmapped();
  return { value: result };
}

function assertPathTenant(segments, ctx) {
  if (segments[0] !== "restaurants" || !segments[1]) {
    return { error: "path_restId_mismatch", status: 403, code: "path_restId_mismatch" };
  }
  const parsed = parseRestId(segments[1]);
  if (!parsed.ok || parsed.empty) {
    return { error: "Invalid restaurant id", status: 400, code: "restId_invalid" };
  }
  if (parsed.restId !== ctx.restId) {
    return { error: "path_restId_mismatch", status: 403, code: "path_restId_mismatch" };
  }
  return { restId: parsed.restId };
}

function nestedValue(value, parts) {
  let current = value;
  for (const part of parts) {
    if (current == null) return null;
    current = current[part];
  }
  return current ?? null;
}

async function readRestaurantConfig(client, ctx, collection, id, rest) {
  const { rows } = await client.query(
    `SELECT name, status, info FROM restaurants WHERE id = $1 LIMIT 1`,
    [ctx.restaurantUuid]
  );
  const row = rows[0] || {};
  const info = row.info && typeof row.info === "object" ? row.info : {};
  const value = collection === "subscription"
    ? (info.subscription && typeof info.subscription === "object" ? info.subscription : {})
    : { ...info, name: info.name || row.name || null, status: info.status || row.status || null };
  return id ? nestedValue(value, [id, ...rest]) : value;
}

async function readAttendance(client, ctx, dateKey, userId, rest) {
  const { rows } = await client.query(
    `SELECT legacy_date_key, legacy_employee_id, status, checked_in_at,
            checked_out_at, extra
       FROM attendance
      WHERE restaurant_id = $1
        AND ($2::text IS NULL OR legacy_date_key = $2)
        AND ($3::text IS NULL OR legacy_employee_id = $3)
      ORDER BY legacy_date_key, legacy_employee_id`,
    [ctx.restaurantUuid, dateKey || null, userId || null]
  );
  const mapped = {};
  for (const row of rows) {
    const value = {
      ...(row.extra || {}),
      date: row.legacy_date_key,
      status: row.status,
      onlineAt: row.checked_in_at ? new Date(row.checked_in_at).getTime() : (row.extra?.onlineAt ?? null),
      offlineAt: row.checked_out_at ? new Date(row.checked_out_at).getTime() : (row.extra?.offlineAt ?? null),
    };
    (mapped[row.legacy_date_key] ||= {})[row.legacy_employee_id] = value;
  }
  const value = dateKey ? (userId ? mapped[dateKey]?.[userId] ?? null : mapped[dateKey] || {}) : mapped;
  return rest.length ? nestedValue(value, rest) : value;
}

async function readKitchenAnnouncements(client, ctx, dateKey, announcementId, rest) {
  const { rows } = await client.query(
    `SELECT legacy_date_key, legacy_rtdb_id, body, legacy_author_id,
            read_by, posted_at, extra
       FROM kitchen_announcements
      WHERE restaurant_id = $1
        AND ($2::text IS NULL OR legacy_date_key = $2)
        AND ($3::text IS NULL OR legacy_rtdb_id = $3)
      ORDER BY announced_date, posted_at, created_at`,
    [ctx.restaurantUuid, dateKey || null, announcementId || null]
  );
  const mapped = {};
  for (const row of rows) {
    const value = {
      ...(row.extra || {}),
      text: row.body,
      authorId: row.legacy_author_id,
      readBy: row.read_by || {},
      createdAt: row.posted_at ? new Date(row.posted_at).getTime() : (row.extra?.createdAt ?? null),
    };
    (mapped[row.legacy_date_key] ||= {})[row.legacy_rtdb_id] = value;
  }
  const value = dateKey
    ? (announcementId ? mapped[dateKey]?.[announcementId] ?? null : mapped[dateKey] || {})
    : mapped;
  return rest.length ? nestedValue(value, rest) : value;
}

async function readChat(client, ctx, chatId, rest, { superadmin = false } = {}) {
  const effectiveId = superadmin ? "superadmin_chat" : chatId;
  if (!effectiveId) {
    const { rows } = await client.query(
      `SELECT legacy_rtdb_id, meta FROM chats WHERE restaurant_id = $1`,
      [ctx.restaurantUuid]
    );
    return Object.fromEntries(rows.map((row) => [row.legacy_rtdb_id, { meta: row.meta || {} }]));
  }
  const { rows: chats } = await client.query(
    `SELECT id, meta FROM chats
      WHERE restaurant_id = $1 AND legacy_rtdb_id = $2 LIMIT 1`,
    [ctx.restaurantUuid, effectiveId]
  );
  if (!chats[0]) return superadmin ? {} : null;
  const { rows: messages } = await client.query(
    `SELECT legacy_rtdb_id, sender_id, sender_name, sender_role, body,
            sent_at, read_by, payload
       FROM chat_messages
      WHERE restaurant_id = $1 AND chat_id = $2
      ORDER BY sent_at`,
    [ctx.restaurantUuid, chats[0].id]
  );
  const messageMap = Object.fromEntries(messages.map((row) => [row.legacy_rtdb_id, {
    ...(row.payload || {}),
    text: row.body,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderRole: row.sender_role,
    sender: row.payload?.sender || row.sender_role,
    timestamp: new Date(row.sent_at).getTime(),
    createdAt: new Date(row.sent_at).getTime(),
    readBy: row.read_by || {},
  }]));
  if (superadmin) return rest.length ? nestedValue(messageMap, rest) : messageMap;
  const value = { meta: chats[0].meta || {}, messages: messageMap };
  return rest.length ? nestedValue(value, rest) : value;
}

async function readCollection(client, ctx, col, id, rest) {
  switch (col) {
    case "info":
    case "subscription":
      return readRestaurantConfig(client, ctx, col, id, rest);
    case "attendance":
      return readAttendance(client, ctx, id, rest[0], rest.slice(1));
    case "kitchenAnnouncements":
      return readKitchenAnnouncements(client, ctx, id, rest[0], rest.slice(1));
    case "chats":
      return readChat(client, ctx, id, rest);
    case "superadmin_chat":
      return readChat(client, ctx, null, id ? [id, ...rest] : rest, { superadmin: true });
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
      if (ctx.isCustomer === true) {
        const publicize = (row) => row ? {
          number: row.number ?? null,
          tableType: row.tableType ?? row.table_type ?? null,
          active: row.active !== false,
        } : null;
        if (!id) return null;
        return rest[0] ? (publicize(map[id])?.[rest[0]] ?? null) : publicize(map[id]);
      }
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
      if (ctx.isCustomer === true) {
        const settings = await getPublicSettingsRaw(client, ctx.restaurantUuid);
        return publicSettingsValue(settings, ctx.restaurant, id ? [id, ...rest] : []);
      }
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
      if (ctx.isCustomer === true) return id ? null : {};
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
      return id ? null : {};
  }
}

async function recordPathChange(client, ctx, path, payload, events) {
  events.push(await recordEvent(client, {
    restaurantUuid: ctx.restaurantUuid,
    restId: ctx.restId,
    type: REALTIME_EVENTS.PATH_CHANGED,
    path,
    payload: payload && typeof payload === "object" ? payload : {},
  }));
}

async function writeAttendance(client, ctx, dateKey, userId, rest, value, events) {
  if (!dateKey || !userId || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return unmapped();
  if (value == null) {
    await client.query(
      `DELETE FROM attendance
        WHERE restaurant_id = $1 AND legacy_date_key = $2 AND legacy_employee_id = $3`,
      [ctx.restaurantUuid, dateKey, userId]
    );
  } else {
    let next = value;
    if (rest.length) {
      const current = await readAttendance(client, ctx, dateKey, userId, []);
      next = { ...(current || {}) };
      let cursor = next;
      for (let i = 0; i < rest.length - 1; i++) cursor = (cursor[rest[i]] ||= {});
      cursor[rest[rest.length - 1]] = value;
    }
    const checkedIn = Number(next.onlineAt) || null;
    const checkedOut = Number(next.offlineAt) || null;
    await client.query(
      `INSERT INTO attendance
        (restaurant_id, employee_id, legacy_employee_id, work_date,
         legacy_date_key, status, checked_in_at, checked_out_at, extra)
       VALUES (
         $1,
         (SELECT id FROM employees WHERE restaurant_id = $1 AND legacy_rtdb_id = $2 LIMIT 1),
         $2, $3::date, $3, $4,
         CASE WHEN $5::bigint IS NULL THEN NULL ELSE to_timestamp($5::double precision / 1000.0) END,
         CASE WHEN $6::bigint IS NULL THEN NULL ELSE to_timestamp($6::double precision / 1000.0) END,
         $7::jsonb
       )
       ON CONFLICT (restaurant_id, work_date, legacy_employee_id) DO UPDATE SET
         status = COALESCE(EXCLUDED.status, attendance.status),
         checked_in_at = COALESCE(EXCLUDED.checked_in_at, attendance.checked_in_at),
         checked_out_at = COALESCE(EXCLUDED.checked_out_at, attendance.checked_out_at),
         extra = attendance.extra || EXCLUDED.extra`,
      [ctx.restaurantUuid, userId, dateKey, next.status || null, checkedIn, checkedOut, JSON.stringify(next)]
    );
  }
  await recordPathChange(
    client,
    ctx,
    `restaurants/${ctx.restId}/attendance/${dateKey}/${userId}`,
    { dateKey, userId, deleted: value == null },
    events
  );
  return value;
}

async function writeKitchenAnnouncement(client, ctx, dateKey, announcementId, rest, value, events) {
  if (!dateKey || !announcementId || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return unmapped();
  if (value == null) {
    await client.query(
      `DELETE FROM kitchen_announcements
        WHERE restaurant_id = $1 AND legacy_date_key = $2 AND legacy_rtdb_id = $3`,
      [ctx.restaurantUuid, dateKey, announcementId]
    );
  } else if (rest[0] === "readBy") {
    await client.query(
      `UPDATE kitchen_announcements
          SET read_by = read_by || $4::jsonb
        WHERE restaurant_id = $1 AND legacy_date_key = $2 AND legacy_rtdb_id = $3`,
      [ctx.restaurantUuid, dateKey, announcementId, JSON.stringify(value || {})]
    );
  } else {
    const postedAt = Number(value.createdAt || value.timestamp) || Date.now();
    await client.query(
      `INSERT INTO kitchen_announcements
        (restaurant_id, legacy_rtdb_id, announced_date, legacy_date_key,
         body, legacy_author_id, read_by, posted_at, extra)
       VALUES ($1, $2, $3::date, $3, $4, $5, $6::jsonb,
               to_timestamp($7::double precision / 1000.0), $8::jsonb)
       ON CONFLICT (restaurant_id, announced_date, legacy_rtdb_id) DO UPDATE SET
         body = COALESCE(EXCLUDED.body, kitchen_announcements.body),
         legacy_author_id = COALESCE(EXCLUDED.legacy_author_id, kitchen_announcements.legacy_author_id),
         read_by = kitchen_announcements.read_by || EXCLUDED.read_by,
         posted_at = COALESCE(EXCLUDED.posted_at, kitchen_announcements.posted_at),
         extra = kitchen_announcements.extra || EXCLUDED.extra`,
      [
        ctx.restaurantUuid, announcementId, dateKey, value.text || value.body || null,
        value.authorId || value.userId || null, JSON.stringify(value.readBy || {}),
        postedAt, JSON.stringify(value),
      ]
    );
  }
  await recordPathChange(
    client,
    ctx,
    `restaurants/${ctx.restId}/kitchenAnnouncements/${dateKey}/${announcementId}`,
    { dateKey, announcementId },
    events
  );
  return value;
}

async function ensureChat(client, ctx, chatId, value = {}) {
  const kind = chatId === "superadmin_chat"
    ? "superadmin"
    : (chatId.startsWith("admin_chef_") ? "admin_chef" : "internal");
  const { rows } = await client.query(
    `INSERT INTO chats
      (restaurant_id, legacy_rtdb_id, chat_kind, title, participants, meta, last_message_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NULL)
     ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
       meta = chats.meta || EXCLUDED.meta
     RETURNING id`,
    [
      ctx.restaurantUuid, chatId, kind, value.title || null,
      JSON.stringify(value.participants || []), JSON.stringify(value.meta || {}),
    ]
  );
  return rows[0].id;
}

async function writeChat(client, ctx, chatId, rest, value, events) {
  if (!chatId) return unmapped();
  const chatUuid = await ensureChat(client, ctx, chatId, rest[0] === "meta" ? { meta: value || {} } : {});
  let path = `restaurants/${ctx.restId}/${chatId === "superadmin_chat" ? "superadmin_chat" : `chats/${chatId}`}`;
  if (rest[0] === "meta") {
    await client.query(
      `UPDATE chats SET meta = meta || $3::jsonb, last_message_at =
         CASE WHEN ($3::jsonb ? 'updatedAt') THEN to_timestamp(($3::jsonb->>'updatedAt')::double precision / 1000.0)
              ELSE last_message_at END
       WHERE restaurant_id = $1 AND id = $2`,
      [ctx.restaurantUuid, chatUuid, JSON.stringify(value || {})]
    );
    path += "/meta";
  } else {
    const messageId = chatId === "superadmin_chat" ? rest[0] : (rest[0] === "messages" ? rest[1] : null);
    if (!messageId) return unmapped();
    path += chatId === "superadmin_chat" ? `/${messageId}` : `/messages/${messageId}`;
    if (value == null) {
      await client.query(
        `DELETE FROM chat_messages WHERE restaurant_id = $1 AND chat_id = $2 AND legacy_rtdb_id = $3`,
        [ctx.restaurantUuid, chatUuid, messageId]
      );
    } else {
      const sentAt = Number(value.timestamp || value.createdAt) || Date.now();
      await client.query(
        `INSERT INTO chat_messages
          (restaurant_id, chat_id, legacy_rtdb_id, sender_id, sender_name,
           sender_role, body, sent_at, read_by, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 to_timestamp($8::double precision / 1000.0), $9::jsonb, $10::jsonb)
         ON CONFLICT (chat_id, legacy_rtdb_id) DO UPDATE SET
           body = EXCLUDED.body, read_by = chat_messages.read_by || EXCLUDED.read_by,
           payload = chat_messages.payload || EXCLUDED.payload`,
        [
          ctx.restaurantUuid, chatUuid, messageId, value.senderId || null,
          value.senderName || value.author || null, value.senderRole || value.sender || null,
          value.text || value.body || null, sentAt, JSON.stringify(value.readBy || {}),
          JSON.stringify(value),
        ]
      );
      await client.query(
        `UPDATE chats SET last_message_at = to_timestamp($3::double precision / 1000.0)
          WHERE restaurant_id = $1 AND id = $2`,
        [ctx.restaurantUuid, chatUuid, sentAt]
      );
    }
  }
  await recordPathChange(client, ctx, path, { chatId }, events);
  return value;
}

async function writeNode(client, ctx, col, id, rest, value, events, op) {
  if (col === "info" || col === "subscription") return unmapped();
  if (col === "attendance") {
    return writeAttendance(client, ctx, id, rest[0], rest.slice(1), value, events);
  }
  if (col === "kitchenAnnouncements") {
    return writeKitchenAnnouncement(client, ctx, id, rest[0], rest.slice(1), value, events);
  }
  if (col === "chats") return writeChat(client, ctx, id, rest, value, events);
  if (col === "superadmin_chat") return writeChat(client, ctx, "superadmin_chat", [id, ...rest], value, events);
  if (col === "orders") {
    if (ctx.isCustomer === true && rest.length > 0) {
      const nestedItemWrite = rest[0] === "items" && rest.length <= 2;
      if (!nestedItemWrite) {
        return { error: "Access Denied", status: 403, code: "role_denied" };
      }
    }
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
          const written = await orders.upsertItem(client, ctx, rows[0], k, v, events);
          if (written?.error) return written;
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
    if (value == null && id) {
      await client.query(
        `DELETE FROM notifications_log WHERE restaurant_id = $1 AND legacy_rtdb_id = $2`,
        [ctx.restaurantUuid, id]
      );
      return null;
    }
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
    const payload = value || {};
    if (ctx.isCustomer === true) {
      payload.status = "pending";
      payload.requestedBy = ctx.userId;
      payload.orderId = payload.orderId || ctx._customerOrderId;
    }
    await catalog.upsertChangeRequest(client, ctx, key, payload, events);
    return key;
  }
  if (col === "waiterCalls") {
    if (value == null) return unmapped();
    const key = id || pushId();
    if (ctx.isCustomer === true) {
      const tableKey = ctx.tableId || ctx.table || value.table || value.tableId;
      await catalog.createWaiterCall(client, ctx, key, {
        table: tableKey,
        callType: value.callType || value.type || "call",
        status: "open",
      }, events);
      return key;
    }
    await catalog.createWaiterCall(client, ctx, key, value, events);
    return key;
  }
  if (col === "orderChats") {
    if (!id) return unmapped();
    const messageId = rest[0] === "messages" ? rest[1] : (rest[1] === "messages" ? rest[2] : rest[0]);
    const channel = rest[0] === "messages" ? "chef" : (rest[0] || "chef");
    if (value == null) return unmapped();
    if (!messageId || messageId === "messages" || messageId === "meta") {
      if (op === "push" || rest[0] === "messages") {
        return catalog.appendOrderChatMessage(client, ctx, id, channel, pushId(), value, events);
      }
      return unmapped();
    }
    if (ctx.isCustomer === true) {
      const existing = await catalog.getOrderChatMessage(client, ctx, id, messageId);
      if (existing && existing.sender_role && existing.sender_role !== "client" && existing.sender_role !== "customer") {
        return { error: "Access Denied", status: 403, code: "role_denied" };
      }
      if (existing && op !== "push") {
        return { error: "Access Denied", status: 403, code: "role_denied" };
      }
    }
    return catalog.appendOrderChatMessage(client, ctx, id, channel, messageId, value, events);
  }
  if (col === "orderTimeline") return unmapped();
  if (col === "meta") {
    const settings = await getSettings(client, ctx.restaurantUuid);
    const meta = { ...(settings.meta || {}) };
    if (id) meta[id] = value;
    await catalog.patchSettings(client, ctx.restaurantUuid, ctx.restId, { meta }, events);
    return id ? value : meta;
  }
  return unmapped();
}

export async function rtdbGet(client, ctx, path) {
  const { segments } = parsePath(path);
  const tenant = assertPathTenant(segments, ctx);
  if (tenant.error) return tenant;
  const col = segments[2];
  if (!MAPPED_COLLECTIONS.has(col)) return unmapped();
  const value = await readCollection(client, ctx, col, segments[3], segments.slice(4));
  if (value && typeof value === "object" && value.fallback) return unmapped();
  return { value };
}

export async function rtdbSet(client, ctx, path, value, events) {
  const { segments } = parsePath(path);
  const tenant = assertPathTenant(segments, ctx);
  if (tenant.error) return tenant;
  const col = segments[2];
  if (!MAPPED_COLLECTIONS.has(col)) return unmapped();
  const result = await writeNode(client, ctx, col, segments[3], segments.slice(4), value, events, "set");
  return wrapWriteResult(result);
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
    }
    return { value: true };
  }

  const { segments } = base;
  const tenant = assertPathTenant(segments, ctx);
  if (tenant.error) return tenant;
  const col = segments[2];
  if (!MAPPED_COLLECTIONS.has(col)) return unmapped();

  // Relative multi-path under this node
  if (isMulti) {
    for (const [k, v] of Object.entries(patch)) {
      const child = [...segments, ...k.split("/").filter(Boolean)].join("/");
      const r = await rtdbSet(client, ctx, child, v, events);
      if (r.error) return r;
    }
    return { value: true };
  }

  if (col === "orders" && segments[3] && segments.length === 4) {
    return wrapWriteResult(await orders.patchOrderFields(client, ctx, segments[3], patch, events));
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
    if (r.error) return r;
  }
  return { key, path: child };
}

export async function rtdbTransaction(client, ctx, path, currentHint) {
  const { segments } = parsePath(path);
  const tenant = assertPathTenant(segments, ctx);
  if (tenant.error) return tenant;
  if (segments[2] === "meta" && segments[3]) {
    const n = await orders.incrementCounter(client, ctx.restaurantUuid, segments[3]);
    return { value: n };
  }
  const got = await rtdbGet(client, ctx, path);
  if (got.error) return got;
  return { value: got.value, apply: async (next, events) => rtdbSet(client, ctx, path, next, events) };
}
