const BLOCKED_KEYS = new Set([
  "proto", "prototype", "constructor",
  "password", "passwordenc", "passwordhash", "pin", "pincode",
  "credential", "credentials",
  "restid", "restaurantid", "restaurantuuid", "tenantid", "organizationid",
  "platformsuperadmin", "issuperadmin", "authority", "authorities", "claims",
  "token", "idtoken", "accesstoken", "refreshtoken", "userid", "uid", "actingrole",
  "id", "employeeid", "pgid", "legacyrtdbid",
  "auth", "authorization", "security", "isadmin", "isowner", "superadmin", "roleoverrides",
  "createdat", "updatedat",
]);

function normalizedKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isBlockedKey(key) {
  const normalized = normalizedKey(key);
  return (
    BLOCKED_KEYS.has(normalized) ||
    normalized.startsWith("password") || normalized.startsWith("pin") ||
    normalized.includes("credential") || normalized.startsWith("token") ||
    normalized.startsWith("platform") || normalized.startsWith("authority") ||
    normalized.startsWith("claim") || normalized.startsWith("security") ||
    normalized.startsWith("restid") || normalized.startsWith("restaurantid") ||
    normalized.startsWith("tenantid") || normalized.startsWith("employeeid")
  );
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== "object") return value;
  const out = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    if (isBlockedKey(key)) continue;
    out[key] = sanitizeValue(child);
  }
  return out;
}

export function safeEmployeeFields(body) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const out = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    const normalized = normalizedKey(key);
    if (isBlockedKey(normalized)) continue;
    out[key] = sanitizeValue(value);
  }
  return out;
}

export function preparePgStaffPatch(body, { isSafeId, now = Date.now }) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const staffPatch = safeEmployeeFields(source);
  if (Object.hasOwn(staffPatch, "name")) {
    staffPatch.name = String(staffPatch.name || "").trim();
    if (!staffPatch.name) return { error: "Staff name is required" };
  }
  if (Object.hasOwn(staffPatch, "role")) {
    staffPatch.role = String(staffPatch.role || "");
    if (!isSafeId(staffPatch.role)) return { error: "Invalid staff role" };
  }
  if (Object.hasOwn(staffPatch, "login")) staffPatch.login = String(staffPatch.login || "").trim();
  staffPatch.updatedAt = Number(now());
  return {
    staffPatch,
    requestedPin: source.password == null ? null : String(source.password),
  };
}

export function preparePgStaffCreate(body, { isSafeId, now = Date.now }) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const name = String(source.name || "").trim();
  if (!name) return { error: "Staff name is required" };

  const role = String(source.role || "waiter");
  if (!isSafeId(role)) return { error: "Invalid staff role" };

  const requestedLegacyId = source.legacy_rtdb_id == null ? "" : String(source.legacy_rtdb_id);
  if (requestedLegacyId && !isSafeId(requestedLegacyId)) return { error: "Invalid staff id" };

  const timestamp = Number(now());
  const staffId = requestedLegacyId || `${role}_${timestamp}`;
  const fields = safeEmployeeFields(source);
  fields.name = name;
  fields.role = role;
  fields.active = source.active !== false;
  fields.login = source.login == null || String(source.login).trim() === ""
    ? staffId
    : String(source.login).trim();
  fields.createdAt = timestamp;
  fields.updatedAt = timestamp;

  return {
    staffId,
    staffData: fields,
    requestedPin: source.password == null ? "" : String(source.password).trim(),
  };
}
