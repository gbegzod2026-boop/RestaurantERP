// Canonical transactional content fingerprints for the credential gate.
// Source of truth: named JSONB objects, NULL distinct from '', UTC timestamps.
// employee_credentials is excluded. Encrypted secret columns are excluded.
// Not pg_stat. Not delimiter concatenation.

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error("FINGERPRINT_IDENT_INVALID");
  }
  if (name === "tables") return '"tables"';
  return name;
}

function utcTimestampExpr(ident) {
  return `(CASE WHEN ${ident} IS NULL THEN NULL ELSE to_char(${ident} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END)`;
}

function jsonObjectSql(columns) {
  const args = columns.map((col) => {
    const ident = quoteIdent(col.name);
    const value = col.kind === "timestamptz" ? utcTimestampExpr(ident) : ident;
    return `'${col.name}', ${value}`;
  });
  return `jsonb_build_object(${args.join(", ")})`;
}

function identityExpr(spec) {
  if (Array.isArray(spec.identity)) {
    return `jsonb_build_array(${spec.identity.map((name) => quoteIdent(name)).join(", ")})`;
  }
  return quoteIdent(spec.identity);
}

function tableFingerprintExpr(spec) {
  const table = spec.quoted || quoteIdent(spec.table);
  const identity = identityExpr(spec);
  const obj = jsonObjectSql(spec.columns);
  return `(SELECT md5(COALESCE((SELECT jsonb_agg(obj ORDER BY ord)::text FROM (SELECT ${identity} AS ord, ${obj} AS obj FROM ${table}) fingerprint_rows), '[]')))`;
}

function col(name, kind = "plain") {
  return Object.freeze({ name, kind });
}

const TS = "timestamptz";

export const PROTECTED_FINGERPRINT_SPECS = Object.freeze([
  Object.freeze({
    table: "restaurants",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("legacy_rtdb_id"), col("domain"), col("name"), col("status"),
      col("organization_id"), col("business_type"), col("info"), col("subscription"),
      col("created_at", TS), col("updated_at", TS),
    ]),
  }),
  Object.freeze({
    table: "employees",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("legacy_rtdb_id"), col("restaurant_id"), col("name"), col("login"),
      col("role"), col("custom_role_id"), col("modules"), col("actions"), col("active"),
      col("extra"), col("created_at", TS), col("updated_at", TS),
    ]),
  }),
  Object.freeze({
    table: "role_overrides",
    identity: Object.freeze(["restaurant_id", "base_role"]),
    columns: Object.freeze([
      col("restaurant_id"), col("base_role"), col("modules"), col("actions"),
    ]),
  }),
  Object.freeze({
    table: "restaurant_modules",
    identity: "restaurant_id",
    columns: Object.freeze([
      col("restaurant_id"), col("enabled_modules"), col("extra"),
    ]),
  }),
  Object.freeze({
    table: "orders",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("legacy_rtdb_id"), col("restaurant_id"), col("order_number"),
      col("order_type"), col("source"), col("table_id"), col("table_label"),
      col("waiter_id"), col("chef_id"), col("created_by_employee_id"), col("customer_id"),
      col("courier_id"), col("status"), col("payment_status"), col("payment_method"),
      col("subtotal"), col("discount_amount"), col("total"), col("original_total"),
      col("extra"), col("created_at", TS), col("updated_at", TS),
    ]),
  }),
  Object.freeze({
    table: "order_items",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("legacy_rtdb_id"), col("order_id"), col("restaurant_id"),
      col("menu_item_id"), col("legacy_menu_id"), col("name_snapshot"),
      col("price_snapshot"), col("qty"), col("line_total"), col("status"),
      col("modifiers"), col("extras"), col("variant_snapshot"),
      col("status_raw"), col("kitchen_status"), col("is_combo"), col("notes"),
      col("extra"), col("created_at", TS),
    ]),
  }),
  Object.freeze({
    table: "courier_assignments",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("legacy_rtdb_id"), col("restaurant_id"), col("order_id"),
      col("legacy_order_id"), col("courier_id"), col("legacy_courier_id"),
      col("status"), col("status_raw"), col("sub_stage"),
      col("assigned_at", TS), col("accepted_at", TS), col("picked_up_at", TS),
      col("delivered_at", TS), col("kpi_calculated"), col("stage_timestamps"),
      col("extra"), col("created_at", TS), col("updated_at", TS),
    ]),
  }),
  Object.freeze({
    table: "order_change_requests",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("legacy_rtdb_id"), col("restaurant_id"), col("order_id"),
      col("legacy_order_id"), col("order_item_id"), col("legacy_item_key"),
      col("request_type"), col("request_type_raw"), col("status"), col("status_raw"),
      col("requested_by"), col("resolved_by"), col("reason"), col("payload"),
      col("created_at", TS), col("resolved_at", TS),
    ]),
  }),
  Object.freeze({
    table: "waiter_calls",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("legacy_rtdb_id"), col("restaurant_id"), col("table_id"),
      col("legacy_table_key"), col("order_id"), col("call_type"), col("status"),
      col("status_raw"), col("handled_by"), col("extra"),
      col("created_at", TS), col("resolved_at", TS),
    ]),
  }),
  Object.freeze({
    table: "payments",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("legacy_rtdb_id"), col("restaurant_id"), col("order_id"),
      col("legacy_order_id"), col("method"), col("method_raw"), col("amount"),
      col("service_fee_amount"), col("final_total"), col("paid"), col("paid_at", TS),
      col("requested"), col("approved"), col("cashier_id"), col("paid_by_employee_id"),
      col("extra"), col("created_at", TS),
    ]),
  }),
  Object.freeze({
    table: "custom_roles",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("restaurant_id"), col("legacy_rtdb_id"), col("name"),
      col("modules"), col("actions"), col("created_at", TS),
    ]),
  }),
  Object.freeze({
    table: "payment_credentials",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("restaurant_id"), col("provider"), col("configured"),
      col("created_at", TS), col("updated_at", TS),
    ]),
    excludedSecrets: Object.freeze(["secret_enc"]),
  }),
  Object.freeze({
    table: "two_factor_credentials",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("owner_type"), col("owner_id"), col("enabled"), col("enabled_at", TS),
    ]),
    excludedSecrets: Object.freeze(["secret_enc", "pending_secret_enc"]),
  }),
  Object.freeze({
    table: "organizations",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("name"), col("status"), col("created_at", TS), col("updated_at", TS),
    ]),
  }),
  Object.freeze({
    table: "platform_users",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("firebase_uid"), col("email"), col("display_name"), col("role"),
      col("permissions"), col("status"), col("created_at", TS), col("updated_at", TS),
    ]),
  }),
  Object.freeze({
    table: "backup_codes",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("two_factor_id"), col("used_at", TS),
    ]),
    excludedSecrets: Object.freeze(["code_hash"]),
  }),
  Object.freeze({
    table: "restaurant_settings",
    identity: "restaurant_id",
    columns: Object.freeze([
      col("restaurant_id"), col("settings"), col("updated_at", TS),
    ]),
  }),
  Object.freeze({
    table: "tables",
    quoted: '"tables"',
    identity: "id",
    columns: Object.freeze([
      col("id"), col("legacy_rtdb_id"), col("restaurant_id"), col("number"),
      col("table_type"), col("capacity"), col("active"), col("status"),
      col("created_at", TS), col("updated_at", TS),
    ]),
  }),
  Object.freeze({
    table: "menu_items",
    identity: "id",
    columns: Object.freeze([
      col("id"), col("legacy_rtdb_id"), col("restaurant_id"), col("category_id"),
      col("subcategory_id"), col("kitchen_station_id"), col("name"), col("price"),
      col("prep_time"), col("img_url"), col("is_weight_based"), col("is_featured"),
      col("is_new"), col("portion_size"), col("variants"), col("is_combo"),
      col("active"), col("extra"), col("created_at", TS), col("updated_at", TS),
    ]),
  }),
]);

export const SESSION_FINGERPRINT_SPECS = Object.freeze([
  Object.freeze({
    table: "production_migration_attempts",
    identity: "attempt_id",
    columns: Object.freeze([
      col("attempt_id"), col("target_fingerprint"), col("candidate_commit"),
      col("reviewed_tag"), col("cutover_window_identity"), col("firebase_project"),
      col("freeze_identity"), col("phase"), col("status"), col("transition_epoch"),
      col("wave1_batch_id"), col("full_checkpoint_id"),
      col("freeze_generated_at", TS), col("started_at", TS), col("updated_at", TS),
    ]),
  }),
  Object.freeze({
    table: "schema_migrations",
    identity: "version",
    columns: Object.freeze([
      col("version"), col("name"), col("checksum"), col("applied_at", TS),
    ]),
  }),
]);

export function fingerprintColumns(table) {
  const spec = [...PROTECTED_FINGERPRINT_SPECS, ...SESSION_FINGERPRINT_SPECS]
    .find((item) => item.table === table);
  return spec ? spec.columns.map((c) => c.name) : [];
}

export function buildFingerprintSelect(specs, comment) {
  const selects = specs.map((spec) => {
    const alias = spec.table.replace(/"/g, "");
    return `${tableFingerprintExpr(spec)} AS ${alias}_fp`;
  });
  return `-- ${comment}\nSELECT\n  ${selects.join(",\n  ")}`;
}

export function buildProtectedContentFingerprintSql() {
  return buildFingerprintSelect(
    PROTECTED_FINGERPRINT_SPECS,
    "credential-gate-protected-content-fingerprint",
  );
}

export function buildSessionProtectedFingerprintSql() {
  return buildFingerprintSelect(
    SESSION_FINGERPRINT_SPECS,
    "credential-gate-session-protected-fingerprint",
  );
}

export const PROTECTED_CONTENT_FINGERPRINT_SQL = buildProtectedContentFingerprintSql();
export const SESSION_PROTECTED_FINGERPRINT_SQL = buildSessionProtectedFingerprintSql();

export const REQUIRED_FINGERPRINT_FIELDS = Object.freeze({
  employees: Object.freeze(["id", "legacy_rtdb_id", "restaurant_id", "name", "login", "role", "custom_role_id", "modules", "actions", "active", "extra"]),
  role_overrides: Object.freeze(["restaurant_id", "base_role", "modules", "actions"]),
  restaurant_modules: Object.freeze(["restaurant_id", "enabled_modules", "extra"]),
  custom_roles: Object.freeze(["id", "restaurant_id", "name", "modules", "actions"]),
  platform_users: Object.freeze(["id", "role", "permissions", "status"]),
  restaurants: Object.freeze(["id", "legacy_rtdb_id", "domain", "name", "status", "organization_id", "subscription"]),
  orders: Object.freeze(["id", "restaurant_id", "table_id", "waiter_id", "status", "total"]),
  order_items: Object.freeze(["id", "order_id", "restaurant_id", "menu_item_id", "qty", "price_snapshot", "modifiers", "extras", "variant_snapshot"]),
  courier_assignments: Object.freeze(["id", "restaurant_id", "order_id", "courier_id", "status"]),
  order_change_requests: Object.freeze(["id", "legacy_rtdb_id", "restaurant_id", "order_id", "legacy_order_id", "payload", "status", "requested_by"]),
  waiter_calls: Object.freeze(["id", "legacy_rtdb_id", "restaurant_id", "table_id", "legacy_table_key", "extra", "status"]),
  payments: Object.freeze(["id", "restaurant_id", "order_id", "amount", "paid", "method"]),
  production_migration_attempts: Object.freeze(["attempt_id", "target_fingerprint", "firebase_project", "phase", "status"]),
  schema_migrations: Object.freeze(["version", "name", "checksum"]),
});

export const EXCLUDED_FROM_PROTECTED_FINGERPRINT = Object.freeze({
  employee_credentials: "mutation target of this gate; hashing it would change on every allowed copy",
  combo_items: "menu composition helper; historical sold state lives on order_items snapshots",
  menu_categories: "catalog taxonomy; not authorization or current order/payment meaning",
  kitchen_stations: "kitchen routing catalog; not authorization",
  customers: "customer master data; order identity is fingerprinted on orders.customer_id",
  customer_addresses: "address book; delivery snapshot lives on orders",
  couriers: "courier master data; current assignment state is fingerprinted on courier_assignments",
  order_status_history: "historical status audit; current operational state is orders.status",
  order_timeline: "UI event log; current order meaning is on orders",
  order_chats: "chat metadata; not authorization or payment",
  order_chat_messages: "chat bodies; not authorization or payment",
  reservations: "front-of-house reservations; not credential/authorization",
  reservation_slots: "reservation inventory; not authorization",
  expenses: "finance ledger; not this gate's credential invariant",
  cash_counts: "cash drawer counts; not this gate's credential invariant",
  finance_entries: "finance journal; not this gate's credential invariant",
  payroll_entries: "payroll; not this gate's credential invariant",
  staff_stats: "derived staff stats; not authorization grants",
  suppliers: "procurement master data",
  inventory_items: "stock catalog",
  stock_movements: "inventory movements",
  daily_usage: "usage aggregates",
  recipes: "recipe catalog",
  recipe_items: "recipe composition",
  semi_finished: "prep catalog",
  semi_finished_acts: "prep acts",
  purchase_orders: "procurement documents",
  purchase_order_items: "procurement lines",
  supplier_payments: "supplier payments",
  debts: "payables",
  attendance: "HR attendance",
  shifts: "shift roster",
  chef_tasks: "kitchen task list",
  prep_schedule: "prep schedule",
  waste_log: "waste log",
  equipment_status: "equipment status",
  kitchen_inventory: "kitchen inventory",
  kitchen_announcements: "kitchen notices",
  production_plans: "production plans",
  modifiers: "modifier catalog; sold modifiers snapshot on order_items",
  extras: "extras catalog; sold extras snapshot on order_items",
  stop_list: "86 list; not authorization",
  discounts: "discount catalog; applied amounts live on orders",
  promotions: "promotion catalog; applied amounts live on orders",
  print_settings: "printer settings",
  terminal_settings: "terminal settings",
  equipment_printers: "printer hardware",
  chats: "staff chat",
  chat_messages: "staff chat bodies",
  audit_log: "audit trail of this application; not the protected business snapshot",
  activity_logs: "activity log",
  notifications_log: "notifications",
  system_alerts: "alerts",
  feedback: "feedback",
  customer_notes: "CRM notes",
  approvals: "approval workflow",
  import_history: "import bookkeeping",
  discount_claims: "discount claim log",
  realtime_events: "runtime event bus",
  schema_migrations: "fingerprinted in the session-role bookkeeping query",
  production_migration_attempts: "fingerprinted in the session-role bookkeeping query",
});

export function assertFingerprintSqlContract(sql) {
  const text = String(sql || "");
  if (/pg_stat_/i.test(text)) throw new Error("FINGERPRINT_USES_PG_STAT");
  if (/chr\(31\)|concat_ws\s*\(/i.test(text)) throw new Error("FINGERPRINT_USES_DELIMITERS");
  if (!/jsonb_build_object\s*\(/i.test(text)) throw new Error("FINGERPRINT_NOT_CANONICAL_JSON");
  if (/COALESCE\s*\(\s*[a-z_][a-z0-9_]*\s*,\s*''\s*\)/i.test(text.replace(/\s+/g, " "))) {
    throw new Error("FINGERPRINT_COALESCE_EMPTY_STRING");
  }
}

export function assertFingerprintHasDeterministicOrder(sql) {
  const text = String(sql || "");
  const aggs = text.match(/jsonb_agg\s*\(/gi) || [];
  if (!aggs.length) throw new Error("FINGERPRINT_ORDER_MISSING");
  const unordered = /jsonb_agg\s*\(\s*obj\s*\)/i.test(text);
  if (unordered) throw new Error("FINGERPRINT_ORDER_MISSING");
  if (!/jsonb_agg\(obj ORDER BY ord\)/.test(text)) throw new Error("FINGERPRINT_ORDER_MISSING");
  const countAgg = (text.match(/jsonb_agg\(obj ORDER BY ord\)/g) || []).length;
  if (countAgg !== aggs.length) throw new Error("FINGERPRINT_ORDER_MISSING");
}

function tableSqlFragment(sql, table) {
  const alias = `${table}_fp`;
  const idx = String(sql).indexOf(` AS ${alias}`);
  if (idx < 0) return "";
  const start = String(sql).lastIndexOf("(SELECT md5", idx);
  return start >= 0 ? String(sql).slice(start, idx) : "";
}

export function assertRequiredFingerprintCoverage(protectedSql, sessionSql) {
  assertFingerprintSqlContract(protectedSql);
  assertFingerprintSqlContract(sessionSql);
  assertFingerprintHasDeterministicOrder(protectedSql);
  assertFingerprintHasDeterministicOrder(sessionSql);
  const combined = {
    ...Object.fromEntries(
      PROTECTED_FINGERPRINT_SPECS.map((spec) => [spec.table, tableSqlFragment(protectedSql, spec.table)]),
    ),
    ...Object.fromEntries(
      SESSION_FINGERPRINT_SPECS.map((spec) => [spec.table, tableSqlFragment(sessionSql, spec.table)]),
    ),
  };
  for (const [table, fields] of Object.entries(REQUIRED_FINGERPRINT_FIELDS)) {
    const fragment = combined[table] || "";
    if (!fragment) throw new Error(`FINGERPRINT_TABLE_MISSING:${table}`);
    if (!/jsonb_agg\(obj ORDER BY ord\)/.test(fragment)) {
      throw new Error(`FINGERPRINT_ORDER_MISSING:${table}`);
    }
    for (const field of fields) {
      const expr = `'${field}', `;
      if (!fragment.includes(expr) && !fragment.includes(`'${field}', ${field}`)) {
        throw new Error(`FINGERPRINT_FIELD_MISSING:${table}.${field}`);
      }
    }
  }
}
