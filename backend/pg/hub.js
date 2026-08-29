// pg/hub.js — tenant-scoped realtime fan-out.
// recordEvent persists inside the caller's tenant transaction.
// broadcast() is called AFTER commit so clients never see rolled-back events.
import { REALTIME_EVENTS } from "./events.js";

let _io = null;

export function attachIo(io) {
  _io = io;
}

export function getIo() {
  return _io;
}

export function restRoom(legacyRestId) {
  return `rest-${legacyRestId}`;
}

export async function recordEvent(client, { restaurantUuid, restId, type, payload = {}, path = null }) {
  if (!restId) throw new Error("recordEvent requires restId");
  if (!type) throw new Error("recordEvent requires type");
  const event = {
    type,
    restId,
    restaurantId: restaurantUuid || null,
    path,
    ts: Date.now(),
    payload: payload && typeof payload === "object" ? payload : {},
    seq: null,
  };
  if (client && restaurantUuid) {
    const { rows } = await client.query(
      `SELECT record_realtime_event($1, $2, $3::jsonb) AS seq`,
      [restaurantUuid, type, JSON.stringify({ ...event.payload, path: path || undefined })]
    );
    event.seq = rows[0]?.seq != null ? Number(rows[0].seq) : null;
  }
  return event;
}

export function broadcast(event) {
  if (!_io || !event?.restId) return;
  const restId = event.restId;
  _io.to(restRoom(restId)).emit("nesta:event", event);
  _io.to(restRoom(restId)).emit(event.type, event);
  if (
    event.type === REALTIME_EVENTS.ORDER_CREATED ||
    event.type === REALTIME_EVENTS.ORDER_UPDATED ||
    event.type === REALTIME_EVENTS.ORDER_STATUS_CHANGED ||
    event.type === REALTIME_EVENTS.KITCHEN_ORDER_UPDATED
  ) {
    _io.to(`chefs:${restId}`).emit(event.type, event);
    _io.to(`admins:${restId}`).emit(event.type, event);
  }
  if (event.type === REALTIME_EVENTS.MENU_UPDATED) {
    _io.to(restRoom(restId)).emit("menu-updated", { timestamp: event.ts, restId });
  }
}

export function broadcastAll(events) {
  for (const e of events || []) broadcast(e);
}

export async function listEventsSince(client, restaurantUuid, afterSeq, { limit = 200 } = {}) {
  const { rows } = await client.query(
    `SELECT seq, event_type, payload, created_at
       FROM realtime_events
      WHERE restaurant_id = $1 AND seq > $2
      ORDER BY seq ASC
      LIMIT $3`,
    [restaurantUuid, Number(afterSeq) || 0, Math.min(500, Math.max(1, Number(limit) || 200))]
  );
  return rows.map((r) => ({
    seq: Number(r.seq),
    type: r.event_type,
    payload: r.payload,
    ts: r.created_at ? new Date(r.created_at).getTime() : null,
    restId: null,
    restaurantId: restaurantUuid,
  }));
}

export { REALTIME_EVENTS };
