/** Convert timestamptz / Date / ISO to Firebase millisecond timestamps. */
export function toMs(v) {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  const d = v instanceof Date ? v : new Date(v);
  const n = d.getTime();
  return Number.isFinite(n) ? n : undefined;
}

export function money(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function asObject(v, fallback = {}) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  return fallback;
}

export function asArray(v, fallback = []) {
  if (Array.isArray(v)) return v;
  return fallback;
}

export function mapByLegacy(rows, shapeFn) {
  const out = {};
  for (const row of rows) {
    const key = row.legacy_rtdb_id;
    if (!key) continue;
    out[key] = shapeFn(row);
  }
  return out;
}

export function orderToRtdb(row, { items = null, payment = null, waiterLegacy = null, chefLegacy = null, createdByLegacy = null } = {}) {
  const extra = asObject(row.extra);
  const shaped = {
    ...extra,
    orderNumber: row.order_number,
    orderType: row.order_type,
    source: row.source || extra.source,
    table: row.table_label != null ? (Number(row.table_label) || row.table_label) : extra.table,
    waiterId: waiterLegacy || extra.waiterId || null,
    chefId: chefLegacy || extra.chefId || null,
    createdByWaiterId: createdByLegacy || extra.createdByWaiterId || null,
    customerName: row.customer_name_snapshot || extra.customerName || null,
    customerPhone: row.customer_phone_snapshot || extra.customerPhone || null,
    customerSessionId: row.customer_session_id || extra.customerSessionId || null,
    status: row.status_raw || row.status,
    statusKey: row.status_key_raw || row.status,
    statusV2: row.status_v2_raw || row.status,
    statusLabel: row.status_label_raw || extra.statusLabel,
    subtotal: money(row.subtotal),
    discount: money(row.discount_amount),
    discountAmount: money(row.discount_amount),
    discountPercent: row.discount_percent != null ? money(row.discount_percent) : extra.discountPercent,
    discountSource: row.discount_source || extra.discountSource,
    discountReason: row.discount_reason || extra.discountReason,
    serviceFeeAmount: money(row.service_fee_amount),
    deliveryFee: money(row.delivery_fee),
    fastFeeAmount: money(row.fast_fee_amount),
    originalTotal: money(row.original_total),
    total: money(row.total),
    paymentMethod: row.payment_method || extra.paymentMethod,
    deliveryAddress: row.delivery_address ?? extra.deliveryAddress ?? null,
    deliveryType: row.delivery_type || extra.deliveryType,
    isDelivery: row.is_delivery === true,
    notes: row.notes || extra.notes,
    priority: row.priority === true,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
    confirmedAt: toMs(row.confirmed_at),
    cookingStartedAt: toMs(row.cooking_started_at),
    readyAt: toMs(row.ready_at),
    servedAt: toMs(row.served_at),
    deliveredAt: toMs(row.delivered_at),
    paidAt: toMs(row.paid_at),
    cancelledAt: toMs(row.cancelled_at),
    paymentStatus: row.payment_status,
    id: row.legacy_rtdb_id,
    _pgId: row.id,
  };
  if (items) shaped.items = items;
  if (payment) shaped.payment = payment;
  return stripUndefined(shaped);
}

export function itemToRtdb(row) {
  const extra = asObject(row.extra);
  return stripUndefined({
    ...extra,
    name: row.name_snapshot,
    price: money(row.price_snapshot),
    qty: money(row.qty) || 1,
    modifiers: row.modifiers,
    extras: row.extras,
    variant: row.variant_snapshot,
    status: row.status_raw || row.status,
    kitchenStatus: row.kitchen_status,
    isCombo: row.is_combo === true,
    notes: row.notes,
    menuId: row.legacy_menu_id,
    createdAt: toMs(row.created_at),
    _pgId: row.id,
  });
}

export function paymentToRtdb(row) {
  if (!row) return { requested: false, paid: false };
  const extra = asObject(row.extra);
  return stripUndefined({
    ...extra,
    method: row.method_raw || row.method,
    amount: money(row.amount),
    serviceFeeAmount: money(row.service_fee_amount),
    finalTotal: row.final_total != null ? money(row.final_total) : extra.finalTotal,
    paid: row.paid === true,
    paidAt: toMs(row.paid_at),
    requested: row.requested === true,
    approved: row.approved === true,
    cashier: row.legacy_cashier || extra.cashier,
  });
}

export function tableToRtdb(row) {
  const extra = asObject(row.extra);
  return stripUndefined({
    ...extra,
    number: row.number,
    tableType: row.table_type,
    capacity: row.capacity,
    active: row.active !== false,
    status: row.status || extra.status || "free",
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
    _pgId: row.id,
  });
}

export function employeeToRtdb(row) {
  const extra = asObject(row.extra);
  return stripUndefined({
    ...extra,
    name: row.name,
    login: row.login,
    role: row.role,
    active: row.active !== false,
    modules: row.modules,
    actions: row.actions,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
    _pgId: row.id,
  });
}

export function menuItemToRtdb(row) {
  const extra = asObject(row.extra);
  return stripUndefined({
    ...extra,
    name: row.name,
    price: money(row.price),
    imgUrl: row.img_url,
    active: row.active !== false,
    isCombo: row.is_combo === true,
    isWeightBased: row.is_weight_based === true,
    isFeatured: row.is_featured === true,
    isNew: row.is_new === true,
    portionSize: row.portion_size,
    variants: row.variants,
    prepTime: row.prep_time,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
    _pgId: row.id,
  });
}

export function categoryToRtdb(row, childrenByParent = null) {
  const extra = asObject(row.extra);
  const shaped = {
    ...extra,
    id: row.legacy_rtdb_id,
    name: row.name,
    createdAt: toMs(row.created_at),
    _pgId: row.id,
  };
  if (childrenByParent && childrenByParent[row.id]) {
    shaped.sub = childrenByParent[row.id];
  }
  return stripUndefined(shaped);
}

export function customerToRtdb(row) {
  const extra = asObject(row.extra);
  return stripUndefined({
    ...extra,
    id: row.legacy_rtdb_id,
    name: row.name,
    notes: row.notes,
    status: row.status,
    personalDiscount: row.personal_discount != null ? money(row.personal_discount) : extra.personalDiscount,
    discountPercent: row.discount_percent != null ? money(row.discount_percent) : extra.discountPercent,
    totalSpent: money(row.total_spent),
    ordersCount: row.orders_count,
    visits: row.visits,
    lastVisit: toMs(row.last_visit),
    loyaltyLevel: row.loyalty_level,
    loyaltyPoints: money(row.loyalty_points),
    isVip: row.is_vip === true,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
    _pgId: row.id,
  });
}

export function reservationToRtdb(row) {
  const extra = asObject(row.extra);
  return stripUndefined({
    ...extra,
    table: row.legacy_table_key,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    guests: row.guests,
    date: row.reserved_date,
    time: row.reserved_time,
    status: row.status_raw || row.status,
    notes: row.notes,
    createdAt: toMs(row.created_at),
    _pgId: row.id,
  });
}

export function inventoryToRtdb(row) {
  const extra = asObject(row.extra);
  return stripUndefined({
    ...extra,
    name: row.name,
    category: row.category,
    unit: row.unit,
    stock: money(row.stock),
    minStock: row.min_stock != null ? money(row.min_stock) : extra.minStock,
    price: money(row.price),
    createdAt: toMs(row.created_at),
    _pgId: row.id,
  });
}

export function notificationToRtdb(row) {
  const extra = asObject(row.payload);
  return stripUndefined({
    ...extra,
    channel: row.channel,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    status: row.status,
    sentAt: toMs(row.sent_at),
    createdAt: toMs(row.created_at),
    _pgId: row.id,
  });
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
