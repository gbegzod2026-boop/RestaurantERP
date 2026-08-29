// Canonical QR/customer identity. The only minter is routes/qr.js:
//   type: "customer" AND role: "client" AND restId
// Staff mintSessionToken() never sets those two claims together.
// role:"client" alone is NOT a customer session (stale/forged staff tokens).

export function isCanonicalCustomerClaims(claims) {
  if (!claims || typeof claims !== "object") return false;
  return claims.type === "customer" && claims.role === "client";
}

export function customerTableClaims(claims) {
  const table = claims?.table != null && String(claims.table).trim() !== ""
    ? String(claims.table)
    : "";
  const tableId = claims?.tableId != null && String(claims.tableId).trim() !== ""
    ? String(claims.tableId)
    : "";
  return {
    table: table && table !== "na" ? table : "",
    tableId: tableId && tableId !== "na" ? tableId : "",
  };
}

export function sessionTableAliases(session) {
  const aliases = new Set();
  for (const raw of [session?.table, session?.tableId]) {
    const value = raw != null ? String(raw).trim() : "";
    if (!value || value === "na") continue;
    aliases.add(value);
    aliases.add(value.replace(/^table_/, ""));
    if (/^\d+$/.test(value)) aliases.add(`table_${value}`);
  }
  return aliases;
}

export function hasDineInTable(session) {
  return sessionTableAliases(session).size > 0;
}

function asTableToken(value) {
  if (value == null || value === "") return "";
  return String(value).trim();
}

export function tableMatchesCustomerSession(session, ...candidates) {
  const aliases = sessionTableAliases(session);
  if (aliases.size === 0) return false;
  for (const candidate of candidates) {
    const token = asTableToken(candidate);
    if (!token) continue;
    if (aliases.has(token) || aliases.has(token.replace(/^table_/, ""))) return true;
    if (/^\d+$/.test(token) && aliases.has(`table_${token}`)) return true;
  }
  return false;
}

function orderSessionId(order) {
  return order?.customerSessionId
    || order?.customer_session_id
    || order?.extra?.customerSessionId
    || "";
}

function sessionActorId(session) {
  return session?.customerSessionId || session?.uid || session?.userId || "";
}

/** Ownership requires a server-stamped customer_session_id that matches this
 *  session. Unguessable order ids and table-less tokens are not enough.
 *  Dine-in also requires the QR table claim to match. Missing binding fails closed. */
export function customerOwnsOrder(session, order) {
  if (!order || typeof order !== "object" || !session) return false;
  const bound = String(orderSessionId(order) || "").trim();
  const actor = String(sessionActorId(session) || "").trim();
  if (!bound || !actor || bound !== actor) return false;
  const table = order.table !== undefined && order.table !== null && String(order.table) !== ""
    ? order.table
    : (order.table_label ?? null);
  const hasTable = table !== undefined && table !== null && String(table) !== "";
  if (hasTable) return tableMatchesCustomerSession(session, table, order.tableId, order.legacy_table_key);
  return !hasDineInTable(session);
}

export function payloadTableCandidates(value) {
  if (!value || typeof value !== "object") return [];
  return [value.table, value.tableId, value.tableNumber, value.legacy_table_key];
}
