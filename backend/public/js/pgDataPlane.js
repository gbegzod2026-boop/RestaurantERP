// Postgres application-data plane. In DATA_BACKEND=postgres, tenant paths
// never fall through to native Firebase. Platform-only Firebase services
// (Auth is outside this module; RTDB systemData / .info) remain on Firebase.
export const MAPPED = new Set([
  "orders", "menu", "categories", "tables", "users", "customers", "reservations",
  "inventory", "ingredients", "notifications", "settings", "orderChangeRequests",
  "courierAssignments", "couriers", "orderTimeline", "meta", "activityLogs",
  "waiterCalls", "kitchenStations", "orderChats", "info", "subscription",
  "attendance", "kitchenAnnouncements", "chats", "superadmin_chat",
]);

export function isMapped(path) {
  const segs = String(path || "").split("/").filter(Boolean);
  return segs[0] === "restaurants" && segs.length >= 3 && MAPPED.has(segs[2]);
}

export function isPlatformFirebasePath(path) {
  const segs = String(path || "").split("/").filter(Boolean);
  return segs[0] === ".info" || segs[0] === "systemData";
}

export function isTenantApplicationPath(path) {
  const segs = String(path || "").split("/").filter(Boolean);
  return segs[0] === "restaurants" || segs[0] === "credentials";
}

/** @returns {"postgres"|"firebase"|"unmapped"} */
export function postgresDataPlane(path, mode) {
  if (mode !== "postgres") return "firebase";
  if (isPlatformFirebasePath(path)) return "firebase";
  if (isMapped(path)) return "postgres";
  if (isTenantApplicationPath(path)) return "unmapped";
  if (!path) return "unmapped";
  return "unmapped";
}
