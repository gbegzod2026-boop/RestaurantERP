// Canonical tenant RLS catalog for Step 1/2D.
// Identity set matching production Step 2D.3 74/74 FORCE RLS:
// public tables that are restaurants, have restaurant_id, or are
// employee_credentials / payment_credentials / combo_items.
// Platform-only tables (organizations, platform_users, two_factor_credentials,
// backup_codes, schema_migrations, production_migration_attempts) are excluded.
export const CANONICAL_TENANT_RLS_TABLES = Object.freeze([
  "activity_logs",
  "approvals",
  "attendance",
  "audit_log",
  "cash_counts",
  "chat_messages",
  "chats",
  "chef_tasks",
  "combo_items",
  "courier_assignments",
  "couriers",
  "customer_addresses",
  "customer_notes",
  "customers",
  "custom_roles",
  "daily_usage",
  "debts",
  "discount_claims",
  "discounts",
  "employee_credentials",
  "employees",
  "equipment_printers",
  "equipment_status",
  "expenses",
  "extras",
  "feedback",
  "finance_entries",
  "import_history",
  "inventory_items",
  "kitchen_announcements",
  "kitchen_inventory",
  "kitchen_stations",
  "menu_categories",
  "menu_items",
  "modifiers",
  "notifications_log",
  "order_change_requests",
  "order_chat_messages",
  "order_chats",
  "order_items",
  "order_status_history",
  "order_timeline",
  "orders",
  "payment_credentials",
  "payments",
  "payroll_entries",
  "prep_schedule",
  "print_settings",
  "production_plans",
  "promotions",
  "purchase_order_items",
  "purchase_orders",
  "realtime_events",
  "recipe_items",
  "recipes",
  "reservation_slots",
  "reservations",
  "restaurant_modules",
  "restaurant_settings",
  "restaurants",
  "role_overrides",
  "semi_finished",
  "semi_finished_acts",
  "shifts",
  "staff_stats",
  "stock_movements",
  "stop_list",
  "supplier_payments",
  "suppliers",
  "system_alerts",
  "tables",
  "terminal_settings",
  "waiter_calls",
  "waste_log",
]);

export const EXPECTED_TENANT_CATALOG_COUNT = CANONICAL_TENANT_RLS_TABLES.length;
export const REQUIRED_NAMED_RLS_TABLES = Object.freeze([
  "restaurants",
  "employees",
  "orders",
  "order_items",
  "payments",
  "custom_roles",
]);

export function canonicalRlsCatalogRows() {
  return CANONICAL_TENANT_RLS_TABLES.map((table) => ({
    table,
    rls: true,
    force_rls: true,
  }));
}

export function canonicalTenantRlsSet() {
  return new Set(CANONICAL_TENANT_RLS_TABLES);
}


