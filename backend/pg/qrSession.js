// Canonical QR session mint policy. Table/restId authority comes only from
// the existing HMAC in security/qrSign.js — never from unsigned query/body.
import { verifyQrParams } from "../security/qrSign.js";
import { isSafeId } from "../security/sanitize.js";
import { parseRestId } from "./restId.js";
import { customerTableClaims } from "./customerIdentity.js";

const SAFE_TABLE_RE = /^[A-Za-z0-9_-]{0,64}$/;

export function evaluateQrSessionMint({ restId, table = "", tableId = "", sig, exp } = {}) {
  const parsed = parseRestId(restId);
  if (!parsed.ok || parsed.empty) {
    return { ok: false, status: 400, error: "Invalid restId", code: "restId_invalid" };
  }
  if (!isSafeId(parsed.restId)) {
    return { ok: false, status: 400, error: "Invalid restId", code: "restId_invalid" };
  }
  const tableValue = table != null ? String(table) : "";
  const tableIdValue = tableId != null ? String(tableId) : "";
  if (!SAFE_TABLE_RE.test(tableValue) || !SAFE_TABLE_RE.test(tableIdValue)) {
    return { ok: false, status: 400, error: "Invalid table", code: "restId_invalid" };
  }

  const verified = verifyQrParams({
    restId: parsed.restId,
    table: tableValue,
    tableId: tableIdValue,
    sig,
    exp,
  });
  if (!verified.valid) {
    return {
      ok: false,
      status: 403,
      error: "Invalid or expired QR link",
      code: verified.reason || "invalid_signature",
    };
  }

  const tables = customerTableClaims({ table: tableValue, tableId: tableIdValue });
  const dineIn = Boolean(tables.table || tables.tableId);
  return {
    ok: true,
    restId: parsed.restId,
    table: tables.table || "",
    tableId: tables.tableId || tables.table || "",
    dineIn,
    uniqueSession: !dineIn,
  };
}

export function customerSessionUid(decision, uniqueSuffix) {
  if (decision.dineIn) {
    return `client_${decision.restId}_${decision.table || decision.tableId}`.slice(0, 128);
  }
  const suffix = String(uniqueSuffix || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  return `client_${decision.restId}_s_${suffix || "na"}`.slice(0, 128);
}
