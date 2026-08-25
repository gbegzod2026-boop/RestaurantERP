import { authorizeSocketJoin } from "./rbacPg.js";
import { lookupRestaurantByLegacyId } from "./tenant.js";
import { withTenantContext } from "../db/postgres.js";
import { listEventsSince, restRoom } from "./hub.js";
import { isSafeId } from "../security/sanitize.js";
import { logSecurityEvent } from "../security/auditLog.js";

export function attachPgRealtime(io) {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token || "";
    socket.nestaToken = token || null;
    next();
  });

  io.on("connection", (socket) => {
    socket.on("nesta:subscribe", async (data = {}) => {
      try {
        const restId = data.restId && isSafeId(String(data.restId)) ? String(data.restId) : null;
        const token = data.token || socket.nestaToken;
        const userId = data.userId || null;
        const authz = await authorizeSocketJoin({ token, restId, userId });
        if (!authz || !restId) {
          logSecurityEvent({ type: "socket_join_denied", restId, userId, ip: socket.handshake?.address, details: { event: "nesta:subscribe" } });
          socket.emit("nesta:error", { error: "subscribe_denied" });
          return;
        }
        if (socket.nestaRestId && socket.nestaRestId !== restId) {
          socket.leave(restRoom(socket.nestaRestId));
        }
        socket.nestaRestId = restId;
        socket.nestaUserId = authz.userId;
        socket.restId = restId;
        socket.join(restRoom(restId));
        socket.emit("nesta:subscribed", { restId, ok: true });
      } catch (err) {
        socket.emit("nesta:error", { error: err.message });
      }
    });

    socket.on("nesta:resync", async (data = {}) => {
      try {
        const restId = socket.nestaRestId || (data.restId && isSafeId(String(data.restId)) ? String(data.restId) : null);
        if (!restId || restId !== socket.nestaRestId) {
          socket.emit("nesta:error", { error: "not_subscribed" });
          return;
        }
        const restaurant = await lookupRestaurantByLegacyId(restId);
        if (!restaurant) return;
        const afterSeq = Number(data.afterSeq || 0);
        const events = await withTenantContext(restaurant.id, (client) => listEventsSince(client, restaurant.id, afterSeq));
        socket.emit("nesta:resync", { restId, events, afterSeq });
      } catch (err) {
        socket.emit("nesta:error", { error: err.message });
      }
    });
  });
}
