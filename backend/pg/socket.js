import { authorizeSocketJoin } from "./rbacPg.js";
import { lookupRestaurantByLegacyId } from "./tenant.js";
import { withTenantContext } from "../db/postgres.js";
import { listEventsSince, restRoom } from "./hub.js";
import { parseRestId } from "./restId.js";
import { logSecurityEvent } from "../security/auditLog.js";

function validGeneration(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value);
}

export function evaluateSubscribe(restIdRaw, authz, generation) {
  const parsed = parseRestId(restIdRaw);
  if (!parsed.ok || parsed.empty) return { ok: false, error: "restId_invalid" };
  if (!validGeneration(generation)) return { ok: false, error: "subscription_invalid" };
  if (!authz) return { ok: false, error: "subscribe_denied" };
  return { ok: true, restId: parsed.restId, userId: authz.userId, generation };
}

export function evaluateResync(socket, requestedRestId, generation) {
  if (!socket?.nestaSubscribed || !socket?.nestaRestId) {
    return { ok: false, error: "not_subscribed" };
  }
  if (!validGeneration(generation) || generation !== socket.nestaGeneration) {
    return { ok: false, error: "not_subscribed" };
  }
  if (requestedRestId != null) {
    const parsed = parseRestId(requestedRestId);
    if (!parsed.ok || parsed.empty) return { ok: false, error: "restId_invalid" };
    if (parsed.restId !== socket.nestaRestId) return { ok: false, error: "not_subscribed" };
  }
  return { ok: true, restId: socket.nestaRestId, generation };
}

function clearSubscription(socket) {
  if (socket.nestaRestId) socket.leave(restRoom(socket.nestaRestId));
  socket.nestaSubscribed = false;
  socket.nestaRestId = null;
  socket.nestaUserId = null;
  socket.nestaGeneration = null;
  socket.nestaPermissions = null;
  socket.restId = null;
}

export async function revalidateSocketAuthority(socket, authorizeSocketJoinFn = authorizeSocketJoin) {
  if (!socket?.nestaSubscribed || !socket.nestaRestId || !socket.nestaGeneration) return null;
  const expectedRestId = socket.nestaRestId;
  const expectedGeneration = socket.nestaGeneration;
  const authz = await authorizeSocketJoinFn({
    token: socket.nestaToken,
    restId: expectedRestId,
    userId: socket.nestaUserId,
  });
  if (
    !authz ||
    !socket.nestaSubscribed ||
    socket.nestaRestId !== expectedRestId ||
    socket.nestaGeneration !== expectedGeneration
  ) {
    clearSubscription(socket);
    return null;
  }
  socket.nestaUserId = authz.userId;
  socket.nestaPermissions = authz.permissions || null;
  return authz;
}

export function attachPgRealtime(io, {
  authorizeSocketJoinFn = authorizeSocketJoin,
  lookupRestaurantFn = lookupRestaurantByLegacyId,
  withTenantContextFn = withTenantContext,
  listEventsSinceFn = listEventsSince,
} = {}) {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token || "";
    socket.nestaToken = token || null;
    socket.nestaSubscribed = false;
    socket.nestaSubscribeRequestSeq = 0;
    next();
  });

  io.on("connection", (socket) => {
    socket.nestaSubscribed = false;

    socket.on("nesta:subscribe", async (data = {}) => {
      const requestSeq = ++socket.nestaSubscribeRequestSeq;
      clearSubscription(socket);
      try {
        const token = data.token || socket.nestaToken;
        const userId = data.userId || null;
        const authz = await authorizeSocketJoinFn({ token, restId: data.restId, userId });
        if (requestSeq !== socket.nestaSubscribeRequestSeq) return;
        const decision = evaluateSubscribe(data.restId, authz, data.generation);
        if (!decision.ok) {
          logSecurityEvent({ type: "socket_join_denied", restId: data.restId, userId, ip: socket.handshake?.address, details: { event: "nesta:subscribe", error: decision.error } });
          socket.emit("nesta:error", { error: decision.error, restId: data.restId || null, generation: data.generation || null });
          return;
        }
        const restId = decision.restId;
        socket.nestaToken = token;
        socket.nestaRestId = restId;
        socket.nestaUserId = decision.userId;
        socket.nestaGeneration = decision.generation;
        socket.nestaPermissions = authz.permissions || null;
        socket.restId = restId;
        socket.nestaSubscribed = true;
        socket.join(restRoom(restId));
        socket.emit("nesta:subscribed", { restId, generation: decision.generation, ok: true });
      } catch (err) {
        if (requestSeq !== socket.nestaSubscribeRequestSeq) return;
        clearSubscription(socket);
        socket.emit("nesta:error", { error: "subscribe_denied", restId: data.restId || null, generation: data.generation || null });
      }
    });

    socket.on("nesta:unsubscribe", (data = {}) => {
      ++socket.nestaSubscribeRequestSeq;
      const generation = data.generation || socket.nestaGeneration || null;
      const restId = socket.nestaRestId;
      clearSubscription(socket);
      socket.emit("nesta:unsubscribed", { ok: true, restId, generation });
    });

    socket.on("nesta:resync", async (data = {}) => {
      try {
        const decision = evaluateResync(socket, data.restId, data.generation);
        if (!decision.ok) {
          socket.emit("nesta:error", { error: decision.error, restId: data.restId || null, generation: data.generation || null });
          return;
        }
        const restId = decision.restId;
        const authz = await revalidateSocketAuthority(socket, authorizeSocketJoinFn);
        if (
          !authz ||
          !socket.nestaSubscribed ||
          socket.nestaRestId !== restId ||
          socket.nestaGeneration !== decision.generation
        ) {
          clearSubscription(socket);
          socket.emit("nesta:error", { error: "subscribe_denied", restId, generation: decision.generation });
          return;
        }
        const restaurant = await lookupRestaurantFn(restId);
        if (!restaurant) {
          clearSubscription(socket);
          socket.emit("nesta:error", { error: "resync_failed", restId, generation: decision.generation });
          return;
        }
        const afterSeq = Number(data.afterSeq || 0);
        const events = await withTenantContextFn(
          restaurant.id,
          (client) => listEventsSinceFn(client, restaurant.id, afterSeq)
        );
        socket.emit("nesta:resync", { restId, generation: decision.generation, events, afterSeq });
      } catch (err) {
        clearSubscription(socket);
        socket.emit("nesta:error", { error: "resync_failed", restId: data.restId || null, generation: data.generation || null });
      }
    });

    const authorityTimer = setInterval(async () => {
      if (!socket.nestaSubscribed || socket.nestaAuthorityCheckInFlight) return;
      socket.nestaAuthorityCheckInFlight = true;
      const restId = socket.nestaRestId;
      const generation = socket.nestaGeneration;
      try {
        const authz = await revalidateSocketAuthority(socket, authorizeSocketJoinFn);
        if (!authz) {
          socket.emit("nesta:error", { error: "subscribe_denied", restId, generation });
        }
      } catch {
        clearSubscription(socket);
        socket.emit("nesta:error", { error: "subscribe_denied", restId, generation });
      } finally {
        socket.nestaAuthorityCheckInFlight = false;
      }
    }, 60_000);
    authorityTimer.unref?.();

    socket.on("disconnect", () => {
      clearInterval(authorityTimer);
      ++socket.nestaSubscribeRequestSeq;
      clearSubscription(socket);
    });
  });
}
