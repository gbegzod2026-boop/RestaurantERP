// Customer RTDB operation/field policy. Ownership is necessary but not
// sufficient — each collection has an explicit allowed verb + DTO.
import {
  customerOwnsOrder,
  hasDineInTable,
  payloadTableCandidates,
  tableMatchesCustomerSession,
} from "./customerIdentity.js";

export const CUSTOMER_PUBLIC_READ = new Set(["menu", "categories", "info", "subscription"]);

export const CUSTOMER_PROTECTED_ORDER_FIELDS = [
  "payment", "paymentStatus", "paymentMethod", "paidAmount", "paidAt", "paid",
  "status", "statusKey", "statusV2", "statusLabel", "statusHistory",
  "kitchenStatus", "chefStatus", "chefId", "waiterId", "courierId",
  "deliveredAt", "servedAt", "completedAt", "pickedUpAt",
  "total", "subtotal", "originalTotal", "discount", "discountAmount",
  "discountPercent", "discountSource", "discountReason", "discountApplied",
  "serviceFeeAmount", "deliveryFee", "fastFeeAmount",
  "restaurantId", "restId", "customerId", "customerSessionId", "clientId",
  "createdAt", "updatedAt", "confirmedAt", "cookingStartedAt", "readyAt",
  "staffNotes", "internalNotes", "assignedTo", "createdByWaiterId",
  "inventoryDeducted", "chefScoreAwarded", "priority",
];

export const CUSTOMER_ORDER_CREATE_FIELDS = new Set([
  "items", "notes", "table", "tableId", "orderType", "deliveryType",
  "isDelivery", "deliveryAddress", "customerName", "customerPhone", "clientPhone",
  "source", "comment",
]);

export const CUSTOMER_ORDER_UPDATE_FIELDS = new Set([
  "items", "notes", "comment", "customerName", "customerPhone", "clientPhone",
  "deliveryAddress",
]);

export const CUSTOMER_MUTABLE_ORDER_STATUSES = new Set(["order_created", "new", "unknown"]);

function denied(code = "role_denied", status = 403) {
  return { status, error: status === 400 ? "Unsupported path" : "Access Denied", code };
}

export function payloadHasProtectedOrderField(value) {
  if (!value || typeof value !== "object") return [];
  return CUSTOMER_PROTECTED_ORDER_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(value, field));
}

export function sanitizeCustomerOrderCreate(value, session) {
  const src = value && typeof value === "object" ? value : {};
  const out = {};
  for (const field of CUSTOMER_ORDER_CREATE_FIELDS) {
    if (src[field] !== undefined) out[field] = src[field];
  }
  if (hasDineInTable(session)) {
    out.table = session.table || src.table;
    out.tableId = session.tableId || src.tableId || out.table;
    out.orderType = "dine_in";
  } else if (!out.orderType) {
    out.orderType = src.isDelivery === true || src.deliveryAddress ? "delivery" : "takeaway";
  }
  out.status = "order_created";
  out.paymentStatus = "unpaid";
  out.customerSessionId = session.userId;
  out.createdByClient = true;
  out.source = "customer";
  return out;
}

export function sanitizeCustomerOrderUpdate(value) {
  const src = value && typeof value === "object" ? value : {};
  const out = {};
  for (const field of CUSTOMER_ORDER_UPDATE_FIELDS) {
    if (src[field] !== undefined) out[field] = src[field];
  }
  return out;
}

export function customerCreatePayloadAllowed(session, value) {
  const payloadTables = payloadTableCandidates(value).filter((item) => item != null && String(item) !== "");
  if (hasDineInTable(session)) {
    if (payloadTables.length === 0) return false;
    return payloadTables.every((item) => tableMatchesCustomerSession(session, item));
  }
  return payloadTables.length === 0;
}

export function customerChatOp(op, segments) {
  const resourceId = segments[3];
  const nested = segments[4];
  if (!resourceId) return denied();
  if (op === "get" || op === "read") return { ok: true };
  if ((op === "push" || op === "set") && (nested === "messages" || nested === "chef")) return { ok: true };
  return denied();
}

export function customerTimelineOp(op) {
  if (op === "get" || op === "read") return { ok: true };
  return denied();
}

export function customerChangeRequestOp(op, segments, writeValue) {
  const resourceId = segments[3];
  if (!resourceId) {
    if (op === "push" && (writeValue?.orderId || writeValue?.legacy_order_id)) {
      const status = writeValue.status || writeValue.status_raw;
      if (status && !["pending", "open", "new"].includes(String(status))) return denied();
      return { ok: true, create: true };
    }
    return denied();
  }
  if (op === "get" || op === "read") return { ok: true };
  return denied();
}

export function customerWaiterCallOp(op, segments, writeValue, session) {
  const resourceId = segments[3];
  if (!resourceId) {
    if (op === "push" && customerCreatePayloadAllowed(session, writeValue)) return { ok: true, create: true };
    return denied();
  }
  if (op === "get" || op === "read") return { ok: true };
  return denied();
}

export function customerTableOp(op) {
  if (op === "get" || op === "read") return { ok: true };
  return denied();
}

export function customerOrderOp(op, segments, writeValue, existing) {
  const resourceId = segments[3];
  if (!resourceId) {
    if (op === "push" && customerCreatePayloadAllowed({ table: writeValue?.table, tableId: writeValue?.tableId }, writeValue)) {
      return { ok: true, create: true };
    }
    return denied();
  }
  if (op === "remove") return denied();
  if (op === "get" || op === "read") return { ok: true };
  if (!existing) {
    if (payloadHasProtectedOrderField(writeValue).length) return denied();
    return { ok: true, create: true };
  }
  const nested = segments[4];
  if (nested === "payment") return denied();
  if (payloadHasProtectedOrderField(writeValue).length) return denied();
  const status = existing.status || existing.status_raw;
  if (status && !CUSTOMER_MUTABLE_ORDER_STATUSES.has(String(status))) {
    if (writeValue && Object.keys(sanitizeCustomerOrderUpdate(writeValue)).length === 0) return denied();
    if (writeValue?.items !== undefined) return denied();
  }
  return { ok: true, update: true };
}

export { customerOwnsOrder };
