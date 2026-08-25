// Shared tenant wrapper for leftover HTTP/engine paths that still take a
// Firebase restId (legacy RTDB key) rather than going through /api/pg.
import { lookupRestaurantByLegacyId } from "./tenant.js";
import { withTenantContext } from "../db/postgres.js";
import { broadcastAll } from "./hub.js";

export async function withLegacyRest(restId, fn, { actingRole = "owner", userId = null } = {}) {
  const restaurant = await lookupRestaurantByLegacyId(restId);
  if (!restaurant) return null;
  const events = [];
  const ctx = {
    restaurantUuid: restaurant.id,
    restId,
    restaurant,
    actingRole,
    userId,
  };
  const result = await withTenantContext(restaurant.id, (client) => fn(client, ctx, events), { actingRole });
  broadcastAll(events);
  return result;
}
