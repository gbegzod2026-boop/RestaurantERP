// db/scripts/lib/transforms-wave35.mjs — Wave 3–5 record transforms.
// Same contract as migrate-firebase.mjs transforms: { row, issues, warnings }.
// Nested Firebase trees (date keys, owner+date keys) are flattened here so
// the engine can upsert one relational row per leaf.
import {
  toMoney, toDecimal, toTimestamp, toDateKey, toMonthKey, toText, toBool, toInt,
  toJson, leftoverExtra, normalizePhone,
} from "./normalize.mjs";

function isRecord(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function collect(t, res, field, { fatal = true } = {}) {
  if (res.ok) {
    if (res.warnings) for (const w of res.warnings) t.warnings.push({ field, ...w });
    return res.value;
  }
  (fatal ? t.issues : t.warnings).push({ field, reason: res.reason, detail: res.detail });
  return null;
}

function base(restId) {
  return { restaurant_id: restId, issues: [], warnings: [] };
}

/** Map a live Firebase status onto a CHECK-constrained column. Unknown
 *  values become `unknown` (which every such CHECK includes) and the
 *  original is kept in status_raw — never widened by dropping the CHECK. */
function checkedStatus(raw, allowed, aliases = {}) {
  if (raw == null || raw === "") return allowed.has("unknown") ? "unknown" : [...allowed][0];
  const s = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (allowed.has(s)) return s;
  if (aliases[s] && allowed.has(aliases[s])) return aliases[s];
  return allowed.has("unknown") ? "unknown" : s;
}

const SUPPLIER_STATUS = new Set(["active", "paused", "archived", "unknown"]);
const PO_STATUS = new Set(["draft", "ordered", "received", "delivered", "cancelled", "unknown"]);
const CHEF_STATUS = new Set(["pending", "in_progress", "done", "cancelled", "unknown"]);
const WAITER_STATUS = new Set(["open", "acknowledged", "resolved", "cancelled", "unknown"]);

export function* walkFlat(node) {
  if (!isRecord(node)) return;
  for (const [key, rec] of Object.entries(node)) yield { key, rec, pathKey: key };
}

export function* walkDateThenId(node) {
  if (!isRecord(node)) return;
  for (const [dateKey, children] of Object.entries(node)) {
    if (!isRecord(children)) continue;
    for (const [id, rec] of Object.entries(children)) {
      yield { key: id, rec: isRecord(rec) ? rec : { value: rec }, dateKey, pathKey: `${dateKey}/${id}` };
    }
  }
}

export function* walkOwnerDateId(node) {
  if (!isRecord(node)) return;
  for (const [ownerId, dates] of Object.entries(node)) {
    if (!isRecord(dates)) continue;
    for (const [dateKey, items] of Object.entries(dates)) {
      if (!isRecord(items)) continue;
      for (const [id, rec] of Object.entries(items)) {
        yield {
          key: id, rec: isRecord(rec) ? rec : { value: rec },
          ownerId, dateKey, pathKey: `${ownerId}/${dateKey}/${id}`,
        };
      }
    }
  }
}

export function transformExpense(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) { t.issues.push({ field: "(record)", reason: "record_not_an_object" }); return { row: null, ...t }; }
  const consumed = new Set(["category", "description", "amount", "paymentMethod", "spentAt", "createdAt", "createdBy", "supplierId"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    category: collect(t, toText(rec.category), "category", { fatal: false }),
    description: collect(t, toText(rec.description ?? rec.note ?? rec.notes), "description", { fatal: false }),
    amount: collect(t, toMoney(rec.amount), "amount", { fatal: false }) ?? "0.00",
    payment_method: collect(t, toText(rec.paymentMethod), "paymentMethod", { fatal: false }),
    spent_at: collect(t, toTimestamp(rec.spentAt ?? rec.createdAt), "spentAt", { fatal: false }),
    created_by: rec.createdBy ? ctx.maps.users.get(rec.createdBy) || null : null,
    legacy_created_by: rec.createdBy ? String(rec.createdBy) : null,
    extra: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
  };
  return { row, ...t };
}

export function transformSupplier(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) { t.issues.push({ field: "(record)", reason: "record_not_an_object" }); return { row: null, ...t }; }
  const name = collect(t, toText(rec.name), "name");
  if (!name) t.issues.push({ field: "name", reason: "supplier_name_missing" });
  const consumed = new Set(["name", "contact", "contactPerson", "phone", "email", "address", "status", "notes", "createdAt", "updatedAt"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    name: name || "unknown",
    contact_person: collect(t, toText(rec.contactPerson ?? rec.contact), "contactPerson", { fatal: false }),
    phone: collect(t, toText(rec.phone), "phone", { fatal: false }),
    email: collect(t, toText(rec.email), "email", { fatal: false }),
    address: collect(t, toText(rec.address), "address", { fatal: false }),
    status: checkedStatus(rec.status ?? "active", SUPPLIER_STATUS),
    status_raw: rec.status != null ? String(rec.status) : null,
    notes: collect(t, toText(rec.notes), "notes", { fatal: false }),
    extra: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
    updated_at: collect(t, toTimestamp(rec.updatedAt), "updatedAt", { fatal: false }),
  };
  return { row, ...t };
}

export function transformInventoryItem(key, rec, ctx, trackedAs) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) { t.issues.push({ field: "(record)", reason: "record_not_an_object" }); return { row: null, ...t }; }
  const name = collect(t, toText(rec.name ?? rec.title), "name");
  if (!name) t.issues.push({ field: "name", reason: "inventory_name_missing" });
  const consumed = new Set(["name", "title", "category", "unit", "stock", "minStock", "price", "supplierId", "createdAt", "updatedAt"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    name: name || "unnamed",
    category: collect(t, toText(rec.category), "category", { fatal: false }),
    unit: collect(t, toText(rec.unit), "unit", { fatal: false }) ?? "dona",
    stock: collect(t, toDecimal(rec.stock ?? 0, 3), "stock", { fatal: false }) ?? "0.000",
    min_stock: collect(t, toDecimal(rec.minStock, 3), "minStock", { fatal: false }),
    price: collect(t, toMoney(rec.price), "price", { fatal: false }) ?? "0.00",
    supplier_id: rec.supplierId ? ctx.maps.suppliers?.get(rec.supplierId) || null : null,
    legacy_supplier_id: rec.supplierId ? String(rec.supplierId) : null,
    tracked_as: trackedAs,
    extra: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
    updated_at: collect(t, toTimestamp(rec.updatedAt), "updatedAt", { fatal: false }),
  };
  return { row, ...t };
}

export function transformPurchaseOrder(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) { t.issues.push({ field: "(record)", reason: "record_not_an_object" }); return { row: null, ...t }; }
  const consumed = new Set(["supplierId", "status", "total", "notes", "items", "createdAt", "updatedAt", "orderedAt"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    supplier_id: rec.supplierId ? ctx.maps.suppliers?.get(rec.supplierId) || null : null,
    legacy_supplier_id: rec.supplierId ? String(rec.supplierId) : null,
    status: checkedStatus(rec.status ?? "draft", PO_STATUS, { pending: "draft", new: "draft", paid: "received" }),
    status_raw: rec.status != null ? String(rec.status) : null,
    total_amount: collect(t, toMoney(rec.total ?? rec.totalAmount), "total", { fatal: false }) ?? "0.00",
    paid_amount: collect(t, toMoney(rec.paidAmount ?? rec.paid), "paidAmount", { fatal: false }) ?? "0.00",
    po_number: collect(t, toText(rec.poNumber ?? rec.number), "poNumber", { fatal: false }),
    ordered_at: collect(t, toTimestamp(rec.orderedAt ?? rec.createdAt), "orderedAt", { fatal: false }),
    received_at: collect(t, toTimestamp(rec.receivedAt), "receivedAt", { fatal: false }),
    notes: collect(t, toText(rec.notes), "notes", { fatal: false }),
    extra: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt ?? rec.orderedAt), "createdAt", { fatal: false }),
    updated_at: collect(t, toTimestamp(rec.updatedAt), "updatedAt", { fatal: false }),
  };
  return { row, ...t };
}

export function transformPoPayment(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) { t.issues.push({ field: "(record)", reason: "record_not_an_object" }); return { row: null, ...t }; }
  const consumed = new Set(["poId", "purchaseOrderId", "supplierId", "amount", "method", "paidAt", "createdAt"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    legacy_po_id: rec.poId ?? rec.purchaseOrderId ? String(rec.poId ?? rec.purchaseOrderId) : null,
    supplier_id: rec.supplierId ? ctx.maps.suppliers?.get(rec.supplierId) || null : null,
    amount: collect(t, toMoney(rec.amount), "amount", { fatal: false }) ?? "0.00",
    method: collect(t, toText(rec.method), "method", { fatal: false }),
    paid_at: collect(t, toTimestamp(rec.paidAt ?? rec.createdAt), "paidAt", { fatal: false }),
    extra: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
  };
  return { row, ...t };
}

export function transformPoItem(idx, rec, ctx) {
  const t = { issues: [], warnings: [] };
  const body = isRecord(rec) ? rec : { qty: rec };
  const name = collect(t, toText(body.name ?? body.title ?? body.itemName), "name", { fatal: false }) || "unnamed";
  const qty = collect(t, toDecimal(body.qty ?? body.quantity ?? body.count, 3), "qty");
  if (qty == null || Number(qty) <= 0) t.issues.push({ field: "qty", reason: "po_item_qty_invalid", detail: String(body.qty) });
  const unitPrice = collect(t, toMoney(body.price ?? body.unitPrice ?? 0), "price", { fatal: false }) ?? "0.00";
  const lineTotal = collect(t, toMoney(body.total ?? body.lineTotal), "total", { fatal: false });
  const row = {
    legacy_rtdb_id: body.id != null ? String(body.id) : String(idx),
    restaurant_id: ctx.restaurantId,
    inventory_item_id: body.itemId ? ctx.maps.inventory?.get(String(body.itemId)) || null : null,
    legacy_item_id: body.itemId != null ? String(body.itemId) : null,
    name_snapshot: name,
    qty,
    unit: collect(t, toText(body.unit), "unit", { fatal: false }),
    unit_price_snapshot: unitPrice,
    line_total: lineTotal ?? unitPrice,
  };
  return { row, ...t };
}

export function transformSemiFinishedAct(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) { t.issues.push({ field: "(record)", reason: "record_not_an_object" }); return { row: null, ...t }; }
  const semiId = rec.semiId ?? rec.semiFinishedId ?? rec.itemId;
  const consumed = new Set(["semiId", "semiFinishedId", "itemId", "qty", "qtyProduced", "producedAt", "createdAt", "producedBy", "notes"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    semi_finished_id: semiId ? ctx.maps.semiFinished?.get(String(semiId)) || null : null,
    legacy_semi_id: semiId != null ? String(semiId) : null,
    qty_produced: collect(t, toDecimal(rec.qty ?? rec.qtyProduced, 3), "qty", { fatal: false }),
    produced_at: collect(t, toTimestamp(rec.producedAt ?? rec.createdAt), "producedAt", { fatal: false }),
    produced_by: rec.producedBy ? ctx.maps.users.get(rec.producedBy) || null : null,
    notes: collect(t, toText(rec.notes), "notes", { fatal: false }),
    extra: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
  };
  return { row, ...t };
}

export function transformDailyUsage(itemId, rec, ctx, dateKey) {
  const t = { issues: [], warnings: [] };
  const date = toDateKey(String(dateKey));
  if (!date.ok) t.issues.push({ field: "usage_date", reason: date.reason, detail: dateKey });
  const body = isRecord(rec) ? rec : { qty: rec };
  const qtyRaw = isRecord(rec) ? (body.qty ?? body.used ?? body.qtyUsed) : rec;
  const row = {
    restaurant_id: ctx.restaurantId,
    usage_date: date.ok ? date.value : null,
    legacy_date_key: String(dateKey),
    inventory_item_id: ctx.maps.inventory?.get(String(itemId)) || null,
    legacy_item_id: String(itemId),
    qty_used: collect(t, toDecimal(qtyRaw, 3), "qty", { fatal: false }) ?? "0.000",
  };
  return { row, ...t };
}

export function transformStopList(menuId, rec, ctx) {
  const t = { issues: [], warnings: [] };
  const body = isRecord(rec) ? rec : { reason: rec };
  const consumed = new Set(["reason", "stoppedAt", "createdAt", "stoppedBy", "active"]);
  const row = {
    restaurant_id: ctx.restaurantId,
    menu_item_id: ctx.maps.menu.get(String(menuId)) || null,
    legacy_menu_id: String(menuId),
    reason: collect(t, toText(body.reason), "reason", { fatal: false }),
    stopped_at: collect(t, toTimestamp(body.stoppedAt ?? body.createdAt), "stoppedAt", { fatal: false }),
    stopped_by: body.stoppedBy ? ctx.maps.users.get(body.stoppedBy) || null : null,
    extra: leftoverExtra(body, consumed),
  };
  return { row, ...t };
}

export function transformSemiFinished(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) { t.issues.push({ field: "(record)", reason: "record_not_an_object" }); return { row: null, ...t }; }
  const consumed = new Set(["name", "unit", "stock", "createdAt", "updatedAt"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    name: collect(t, toText(rec.name), "name") || "unnamed",
    unit: collect(t, toText(rec.unit), "unit", { fatal: false }),
    yield_qty: collect(t, toDecimal(rec.yieldQty ?? rec.stock, 3), "yieldQty", { fatal: false }),
    cost: collect(t, toMoney(rec.cost), "cost", { fatal: false }),
    components: collect(t, toJson(rec.components ?? rec.recipe ?? []), "components", { fatal: false }) ?? "[]",
    extra: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
    updated_at: collect(t, toTimestamp(rec.updatedAt), "updatedAt", { fatal: false }),
  };
  return { row, ...t };
}

export function transformAttendance(userId, rec, ctx, dateKey) {
  const t = { issues: [], warnings: [] };
  const date = toDateKey(String(dateKey));
  if (!date.ok) t.issues.push({ field: "work_date", reason: date.reason, detail: dateKey });
  const body = isRecord(rec) ? rec : { status: rec };
  const consumed = new Set(["status", "checkedInAt", "checkedOutAt", "in", "out", "minutes", "workedMinutes", "notes"]);
  const row = {
    restaurant_id: ctx.restaurantId,
    employee_id: ctx.maps.users.get(userId) || null,
    legacy_employee_id: String(userId),
    work_date: date.ok ? date.value : null,
    legacy_date_key: String(dateKey),
    status: collect(t, toText(body.status), "status", { fatal: false }),
    checked_in_at: collect(t, toTimestamp(body.checkedInAt ?? body.in), "checkedInAt", { fatal: false }),
    checked_out_at: collect(t, toTimestamp(body.checkedOutAt ?? body.out), "checkedOutAt", { fatal: false }),
    worked_minutes: collect(t, toInt(body.workedMinutes ?? body.minutes), "workedMinutes", { fatal: false }),
    notes: collect(t, toText(body.notes), "notes", { fatal: false }),
    extra: leftoverExtra(body, consumed),
  };
  return { row, ...t };
}

export function transformShift(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) { t.issues.push({ field: "(record)", reason: "record_not_an_object" }); return { row: null, ...t }; }
  const consumed = new Set(["userId", "employeeId", "date", "startsAt", "endsAt", "start", "end", "role", "status", "createdAt"]);
  const uid = rec.userId ?? rec.employeeId;
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    employee_id: uid ? ctx.maps.users.get(uid) || null : null,
    legacy_employee_id: uid ? String(uid) : null,
    shift_date: rec.date ? (toDateKey(String(rec.date)).ok ? toDateKey(String(rec.date)).value : null) : null,
    starts_at: collect(t, toTimestamp(rec.startsAt ?? rec.start), "startsAt", { fatal: false }),
    ends_at: collect(t, toTimestamp(rec.endsAt ?? rec.end), "endsAt", { fatal: false }),
    role_label: collect(t, toText(rec.role), "role", { fatal: false }),
    status: collect(t, toText(rec.status), "status", { fatal: false }),
    extra: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
  };
  return { row, ...t };
}

export function transformChefTask(taskId, rec, ctx, chefId, dateKey) {
  const t = { issues: [], warnings: [] };
  const date = toDateKey(String(dateKey));
  if (!date.ok) t.issues.push({ field: "task_date", reason: date.reason, detail: dateKey });
  const body = isRecord(rec) ? rec : { title: rec };
  const consumed = new Set(["title", "name", "description", "status", "priority", "dueAt", "completedAt", "createdAt"]);
  const row = {
    legacy_rtdb_id: String(taskId),
    restaurant_id: ctx.restaurantId,
    chef_id: ctx.maps.users.get(chefId) || null,
    legacy_chef_id: String(chefId),
    task_date: date.ok ? date.value : null,
    legacy_date_key: String(dateKey),
    title: collect(t, toText(body.title ?? body.name), "title", { fatal: false }),
    description: collect(t, toText(body.description), "description", { fatal: false }),
    status: checkedStatus(body.status ?? "pending", CHEF_STATUS, { complete: "done", completed: "done", todo: "pending", doing: "in_progress" }),
    status_raw: body.status != null ? String(body.status) : null,
    priority: collect(t, toText(body.priority), "priority", { fatal: false }),
    due_at: collect(t, toTimestamp(body.dueAt), "dueAt", { fatal: false }),
    completed_at: collect(t, toTimestamp(body.completedAt), "completedAt", { fatal: false }),
    extra: leftoverExtra(body, consumed),
    created_at: collect(t, toTimestamp(body.createdAt), "createdAt", { fatal: false }),
  };
  return { row, ...t };
}

export function transformWaste(entryId, rec, ctx, dateKey) {
  const t = { issues: [], warnings: [] };
  const date = toDateKey(String(dateKey));
  if (!date.ok) t.issues.push({ field: "waste_date", reason: date.reason, detail: dateKey });
  const body = isRecord(rec) ? rec : {};
  const consumed = new Set(["itemId", "name", "qty", "unit", "cost", "reason", "reportedBy", "createdAt"]);
  const row = {
    legacy_rtdb_id: String(entryId),
    restaurant_id: ctx.restaurantId,
    waste_date: date.ok ? date.value : null,
    legacy_date_key: String(dateKey),
    inventory_item_id: body.itemId ? ctx.maps.inventory?.get(body.itemId) || null : null,
    legacy_item_id: body.itemId ? String(body.itemId) : null,
    item_label: collect(t, toText(body.name), "name", { fatal: false }),
    qty: collect(t, toDecimal(body.qty, 3), "qty", { fatal: false }),
    unit: collect(t, toText(body.unit), "unit", { fatal: false }),
    estimated_cost: collect(t, toMoney(body.cost), "cost", { fatal: false }),
    reason: collect(t, toText(body.reason), "reason", { fatal: false }),
    reported_by: body.reportedBy ? ctx.maps.users.get(body.reportedBy) || null : null,
    legacy_reported_by: body.reportedBy ? String(body.reportedBy) : null,
    extra: leftoverExtra(body, consumed),
    created_at: collect(t, toTimestamp(body.createdAt), "createdAt", { fatal: false }),
  };
  return { row, ...t };
}

export function transformAnnouncement(id, rec, ctx, dateKey) {
  const t = { issues: [], warnings: [] };
  const date = toDateKey(String(dateKey));
  if (!date.ok) t.issues.push({ field: "announced_date", reason: date.reason, detail: dateKey });
  const body = isRecord(rec) ? rec : { body: rec };
  const consumed = new Set(["body", "text", "message", "authorId", "readBy", "createdAt", "postedAt"]);
  const row = {
    legacy_rtdb_id: String(id),
    restaurant_id: ctx.restaurantId,
    announced_date: date.ok ? date.value : null,
    legacy_date_key: String(dateKey),
    body: collect(t, toText(body.body ?? body.text ?? body.message), "body", { fatal: false }),
    author_id: body.authorId ? ctx.maps.users.get(body.authorId) || null : null,
    legacy_author_id: body.authorId ? String(body.authorId) : null,
    read_by: collect(t, toJson(body.readBy ?? {}), "readBy", { fatal: false }) ?? "{}",
    posted_at: collect(t, toTimestamp(body.postedAt ?? body.createdAt), "postedAt", { fatal: false }),
    extra: leftoverExtra(body, consumed),
  };
  return { row, ...t };
}

export function transformActivityLog(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) { t.issues.push({ field: "(record)", reason: "record_not_an_object" }); return { row: null, ...t }; }
  const created = toTimestamp(rec.createdAt ?? rec.ts ?? rec.time);
  if (!created.ok || !created.value) t.issues.push({ field: "createdAt", reason: created.reason || "createdAt_missing" });
  const consumed = new Set(["type", "activityType", "message", "text", "actorId", "userId", "actorName", "entityType", "entityId", "createdAt", "ts", "time"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    activity_type: collect(t, toText(rec.type ?? rec.activityType), "type", { fatal: false }),
    message: collect(t, toText(rec.message ?? rec.text), "message", { fatal: false }),
    actor_id: rec.actorId ?? rec.userId ? String(rec.actorId ?? rec.userId) : null,
    actor_name: collect(t, toText(rec.actorName), "actorName", { fatal: false }),
    entity_type: collect(t, toText(rec.entityType), "entityType", { fatal: false }),
    entity_id: rec.entityId != null ? String(rec.entityId) : null,
    payload: leftoverExtra(rec, consumed),
    created_at: created.ok ? created.value : null,
  };
  return { row, ...t };
}

export function transformAudit(key, rec, ctx, sourceTree) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) { t.issues.push({ field: "(record)", reason: "record_not_an_object" }); return { row: null, ...t }; }
  const created = toTimestamp(rec.createdAt ?? rec.ts);
  if (!created.ok || !created.value) t.issues.push({ field: "createdAt", reason: created.reason || "createdAt_missing" });
  const action = collect(t, toText(rec.action ?? rec.type ?? rec.event), "action", { fatal: false }) || "unknown";
  const consumed = new Set(["action", "type", "event", "entityType", "entityId", "actorId", "userId", "actorName", "actorRole", "ip", "before", "after", "createdAt", "ts"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    source_tree: sourceTree,
    action,
    entity_type: collect(t, toText(rec.entityType), "entityType", { fatal: false }),
    entity_id: rec.entityId != null ? String(rec.entityId) : null,
    actor_id: rec.actorId ?? rec.userId ? String(rec.actorId ?? rec.userId) : null,
    actor_name: collect(t, toText(rec.actorName), "actorName", { fatal: false }),
    actor_role: collect(t, toText(rec.actorRole), "actorRole", { fatal: false }),
    ip_address: collect(t, toText(rec.ip), "ip", { fatal: false }),
    before_state: collect(t, toJson(rec.before ?? null), "before", { fatal: false }),
    after_state: collect(t, toJson(rec.after ?? null), "after", { fatal: false }),
    detail: leftoverExtra(rec, consumed),
    created_at: created.ok ? created.value : null,
  };
  return { row, ...t };
}

export function transformSystemAlert(type, rec, ctx) {
  const t = { issues: [], warnings: [] };
  const body = isRecord(rec) ? rec : { message: rec };
  const consumed = new Set(["severity", "message", "active", "raisedAt", "clearedAt", "createdAt"]);
  const row = {
    restaurant_id: ctx.restaurantId,
    alert_type: String(type),
    severity: collect(t, toText(body.severity), "severity", { fatal: false }),
    message: collect(t, toText(body.message ?? body.text), "message", { fatal: false }),
    active: collect(t, toBool(body.active, true), "active", { fatal: false }) ?? true,
    raised_at: collect(t, toTimestamp(body.raisedAt ?? body.createdAt), "raisedAt", { fatal: false }),
    cleared_at: collect(t, toTimestamp(body.clearedAt), "clearedAt", { fatal: false }),
    payload: leftoverExtra(body, consumed),
  };
  return { row, ...t };
}

export function transformPayroll(staffId, rec, ctx, monthKey, kind) {
  const t = { issues: [], warnings: [] };
  const month = toMonthKey(String(monthKey));
  if (!month.ok) t.issues.push({ field: "period_month", reason: month.reason, detail: monthKey });
  const body = isRecord(rec) ? rec : { total: rec };
  const consumed = new Set(["base", "baseSalary", "bonus", "penalty", "total", "totalPaid", "paid", "paidAt", "notes"]);
  const row = {
    restaurant_id: ctx.restaurantId,
    employee_id: ctx.maps.users.get(staffId) || null,
    legacy_employee_id: String(staffId),
    period_month: month.ok ? month.value : null,
    legacy_period_key: String(monthKey),
    entry_kind: kind,
    base_salary: collect(t, toMoney(body.baseSalary ?? body.base), "baseSalary", { fatal: false }),
    bonus: collect(t, toMoney(body.bonus), "bonus", { fatal: false }),
    penalty: collect(t, toMoney(body.penalty), "penalty", { fatal: false }),
    total_paid: collect(t, toMoney(body.totalPaid ?? body.total), "totalPaid", { fatal: false }),
    paid: collect(t, toBool(body.paid, false), "paid", { fatal: false }) ?? false,
    paid_at: collect(t, toTimestamp(body.paidAt), "paidAt", { fatal: false }),
    notes: collect(t, toText(body.notes), "notes", { fatal: false }),
    extra: leftoverExtra(body, consumed),
  };
  return { row, ...t };
}

export function transformStaffStat(staffId, rec, ctx, monthKey, scope) {
  const t = { issues: [], warnings: [] };
  const month = toMonthKey(String(monthKey));
  if (!month.ok) t.issues.push({ field: "period_month", reason: month.reason, detail: monthKey });
  const body = isRecord(rec) ? rec : {};
  const consumed = new Set(["totalEarned", "earned", "orderCount", "orders", "deliveredCount", "delivered", "kpi", "kpiScore"]);
  const row = {
    restaurant_id: ctx.restaurantId,
    employee_id: ctx.maps.users.get(staffId) || ctx.maps.couriers?.get(staffId) || null,
    legacy_employee_id: String(staffId),
    stat_scope: scope,
    period_month: month.ok ? month.value : null,
    legacy_period_key: String(monthKey),
    total_earned: collect(t, toMoney(body.totalEarned ?? body.earned), "totalEarned", { fatal: false }) ?? "0.00",
    order_count: collect(t, toInt(body.orderCount ?? body.orders), "orderCount", { fatal: false }) ?? 0,
    delivered_count: collect(t, toInt(body.deliveredCount ?? body.delivered), "deliveredCount", { fatal: false }) ?? 0,
    kpi_score: collect(t, toDecimal(body.kpiScore ?? body.kpi, 2), "kpi", { fatal: false }),
    extra: leftoverExtra(body, consumed),
  };
  return { row, ...t };
}

export function transformModifierOrExtra(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) { t.issues.push({ field: "(record)", reason: "record_not_an_object" }); return { row: null, ...t }; }
  const consumed = new Set(["name", "price", "active", "createdAt"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    name: collect(t, toJson(rec.name ?? rec.title ?? rec), "name") || '"unnamed"',
    price_delta: collect(t, toMoney(rec.price ?? rec.priceDelta), "price", { fatal: false }) ?? "0.00",
    price: collect(t, toMoney(rec.price), "price", { fatal: false }) ?? "0.00",
    active: collect(t, toBool(rec.active, true), "active", { fatal: false }) ?? true,
    extra: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
  };
  return { row, ...t };
}

export function transformDiscount(code, rec, ctx) {
  const t = { issues: [], warnings: [] };
  const body = isRecord(rec) ? rec : { value: rec };
  const consumed = new Set(["code", "percent", "amount", "active", "createdAt"]);
  const row = {
    restaurant_id: ctx.restaurantId,
    legacy_rtdb_id: String(code),
    code: String(code),
    discount_type: body.percent != null ? "percent" : (body.amount != null ? "fixed" : "unknown"),
    value: collect(t, toMoney(body.value ?? body.percent ?? body.amount), "value", { fatal: false }) ?? "0.00",
    active: collect(t, toBool(body.active, true), "active", { fatal: false }) ?? true,
    extra: leftoverExtra(body, consumed),
    created_at: collect(t, toTimestamp(body.createdAt), "createdAt", { fatal: false }),
  };
  return { row, ...t };
}

export function transformWaiterCall(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) { t.issues.push({ field: "(record)", reason: "record_not_an_object" }); return { row: null, ...t }; }
  const consumed = new Set(["table", "tableId", "orderId", "status", "createdAt", "resolvedAt"]);
  const tableLabel = rec.table ?? rec.tableId;
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    table_id: tableLabel != null ? ctx.maps.tablesByNumber.get(String(tableLabel)) || ctx.maps.tablesByKey.get(String(tableLabel)) || null : null,
    legacy_table_key: tableLabel != null ? String(tableLabel) : null,
    order_id: rec.orderId ? ctx.maps.orders?.get(String(rec.orderId)) || null : null,
    status: checkedStatus(rec.status ?? "open", WAITER_STATUS, { pending: "open", closed: "resolved", done: "resolved" }),
    status_raw: rec.status != null ? String(rec.status) : null,
    extra: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
  };
  return { row, ...t };
}

export function transformOrderTimelineEvent(eventId, rec, ctx, orderLegacyId) {
  const t = { issues: [], warnings: [] };
  const body = isRecord(rec) ? rec : { message: rec };
  const occurred = toTimestamp(body.at ?? body.ts ?? body.createdAt ?? body.time);
  if (!occurred.ok || !occurred.value) t.issues.push({ field: "occurred_at", reason: occurred.reason || "timestamp_missing" });
  const consumed = new Set(["type", "eventType", "actorId", "actorName", "message", "at", "ts", "createdAt", "time"]);
  const row = {
    legacy_rtdb_id: String(eventId),
    restaurant_id: ctx.restaurantId,
    order_id: ctx.maps.orders?.get(String(orderLegacyId)) || null,
    legacy_order_id: String(orderLegacyId),
    event_type: collect(t, toText(body.type ?? body.eventType), "type", { fatal: false }) || "unknown",
    actor_id: body.actorId != null ? String(body.actorId) : null,
    actor_name: collect(t, toText(body.actorName), "actorName", { fatal: false }),
    message: collect(t, toText(body.message), "message", { fatal: false }),
    occurred_at: occurred.ok ? occurred.value : null,
    payload: leftoverExtra(body, consumed),
  };
  return { row, ...t };
}

export function transformNotification(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) { t.issues.push({ field: "(record)", reason: "record_not_an_object" }); return { row: null, ...t }; }
  const consumed = new Set(["channel", "to", "recipient", "subject", "title", "body", "message", "status", "sentAt", "createdAt"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    channel: collect(t, toText(rec.channel), "channel", { fatal: false }),
    recipient: collect(t, toText(rec.recipient ?? rec.to), "recipient", { fatal: false }),
    subject: collect(t, toText(rec.subject ?? rec.title), "subject", { fatal: false }),
    body: collect(t, toText(rec.body ?? rec.message), "body", { fatal: false }),
    status: collect(t, toText(rec.status), "status", { fatal: false }),
    sent_at: collect(t, toTimestamp(rec.sentAt ?? rec.createdAt), "sentAt", { fatal: false }),
    payload: leftoverExtra(rec, consumed),
    created_at: collect(t, toTimestamp(rec.createdAt), "createdAt", { fatal: false }),
  };
  return { row, ...t };
}

export function transformChat(key, rec, ctx, kind = "internal") {
  const t = { issues: [], warnings: [] };
  const meta = isRecord(rec) ? (isRecord(rec.meta) ? rec.meta : rec) : {};
  const consumed = new Set(["meta", "messages", "title", "participants", "lastMessageAt", "createdAt"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    chat_kind: kind,
    title: collect(t, toText(meta.title), "title", { fatal: false }),
    participants: collect(t, toJson(meta.participants ?? []), "participants", { fatal: false }) ?? "[]",
    meta: leftoverExtra(meta, consumed),
    last_message_at: collect(t, toTimestamp(meta.lastMessageAt), "lastMessageAt", { fatal: false }),
    created_at: collect(t, toTimestamp(meta.createdAt), "createdAt", { fatal: false }),
  };
  return { row, messages: isRecord(rec?.messages) ? rec.messages : {}, ...t };
}

export function transformImportHistory(key, rec, ctx) {
  const t = { issues: [], warnings: [] };
  if (!isRecord(rec)) { t.issues.push({ field: "(record)", reason: "record_not_an_object" }); return { row: null, ...t }; }
  const consumed = new Set(["module", "status", "importedAt", "createdAt", "counts"]);
  const row = {
    legacy_rtdb_id: key,
    restaurant_id: ctx.restaurantId,
    import_kind: collect(t, toText(rec.module ?? rec.kind ?? rec.importKind), "module", { fatal: false }),
    source_name: collect(t, toText(rec.source ?? rec.sourceName), "source", { fatal: false }),
    rows_total: collect(t, toInt(rec.rowsTotal ?? rec.counts?.total), "rowsTotal", { fatal: false }),
    rows_imported: collect(t, toInt(rec.rowsImported ?? rec.counts?.imported), "rowsImported", { fatal: false }),
    rows_failed: collect(t, toInt(rec.rowsFailed ?? rec.counts?.failed), "rowsFailed", { fatal: false }),
    performed_by: collect(t, toText(rec.performedBy ?? rec.userId), "performedBy", { fatal: false }),
    performed_at: collect(t, toTimestamp(rec.importedAt ?? rec.createdAt), "createdAt", { fatal: false }),
    detail: leftoverExtra(rec, consumed),
  };
  return { row, ...t };
}

export { isRecord, collect, normalizePhone };
