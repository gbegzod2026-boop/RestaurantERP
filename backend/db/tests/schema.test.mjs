// db/tests/schema.test.mjs — static checks on the SQL migration files.
//
// These are NOT a substitute for applying the migrations to a real
// PostgreSQL instance; they cannot catch a syntax error. What they DO catch
// is the class of mistake that is easy to make across ~70 tables in four
// files and invisible until production: a table with no down migration, a
// money column typed `numeric` without a scale, a naive `timestamp`, a
// tenant-owned table nobody wired RLS to, a migrated entity missing its
// legacy_rtdb_id.
//
// Every rule here is one of Phase 1's stated requirements, enforced
// mechanically so a table added later cannot quietly opt out of it.
//
// No database needed. Run: node --test db/tests/
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

const upFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".up.sql")).sort();
const sqlOf = (f) => readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");

/** Strips comments and string literals so a pattern can't match inside them. */
function stripNoise(sql) {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** Splits a file into { name, body } per CREATE TABLE, body being everything
 *  up to the matching close paren of the column list. */
function parseTables(sql) {
  const clean = stripNoise(sql);
  const out = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let m;
  while ((m = re.exec(clean))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < clean.length && depth > 0) {
      if (clean[i] === "(") depth++;
      else if (clean[i] === ")") depth--;
      i++;
    }
    out.push({ name: m[1], body: clean.slice(re.lastIndex, i - 1) });
  }
  return out;
}

/** Columns added by a later `ALTER TABLE ... ADD COLUMN`, so a table that was
 *  completed by a follow-up migration is judged on its effective shape rather
 *  than only on its original CREATE. */
function parseAddedColumns(sql) {
  const clean = stripNoise(sql);
  const out = [];
  const re = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([^;]+);/gi;
  let m;
  while ((m = re.exec(clean))) out.push({ table: m[1], definition: m[2] });
  return out;
}

const ALL_TABLES = upFiles.flatMap((f) => parseTables(sqlOf(f)).map((t) => ({ ...t, file: f })));

for (const f of upFiles) {
  for (const { table, definition } of parseAddedColumns(sqlOf(f))) {
    const t = ALL_TABLES.find((x) => x.name === table);
    if (t) t.body += `\n  ${definition},`;
  }
}

// Reference/lookup tables that are deliberately platform-wide rather than
// tenant-owned, and tables whose rows are not migrated from Firebase.
const NOT_TENANT_OWNED = new Set([
  "organizations", "restaurants", "platform_users", "two_factor_credentials",
  "backup_codes", "schema_migrations", "custom_roles", "role_overrides",
  "employee_credentials", "combo_items", "recipe_items", "purchase_order_items",
  "order_chat_messages", "chat_messages", "customer_addresses",
]);

// Tables whose primary key is deliberately composite rather than a surrogate
// uuid, because the row IS the relationship.
/** True when the table's identity is its own surrogate uuid — i.e. it is an
 *  entity in its own right, rather than a 1:1 extension keyed by its parent
 *  (`restaurant_settings`, `employee_credentials`, …) or a pure relationship
 *  keyed compositely (`role_overrides`). Deriving this beats maintaining an
 *  exception list that has to be edited every time a table is added. */
const hasSurrogatePk = (t) => /\bid\s+uuid\s+PRIMARY\s+KEY/i.test(t.body);
const hasParentPk = (t) => /\b[a-z_]+_id\s+uuid\s+PRIMARY\s+KEY\s+REFERENCES/i.test(t.body);
const hasCompositePk = (t) => /PRIMARY\s+KEY\s*\(/i.test(t.body);

/** A surrogate-keyed table that is nonetheless 1:1 with a parent — a NOT NULL
 *  FK plus a UNIQUE on that same column (`recipes.menu_item_id`). Its Firebase
 *  key is the parent's, already preserved on the parent row. */
function is1to1Extension(t) {
  for (const m of t.body.matchAll(/\b([a-z_]+_id)\s+uuid\s+NOT\s+NULL\s+REFERENCES/gi)) {
    if (new RegExp(`UNIQUE\\s*\\(\\s*${m[1]}\\s*\\)`, "i").test(t.body)) return true;
  }
  return false;
}

// Entities with a surrogate PK that still legitimately have no RTDB key.
const NO_LEGACY_ID = new Set([
  "platform_users",        // keyed by Firebase AUTH uid (its own firebase_uid column), not an RTDB key
  "organizations",         // has no Firebase counterpart at all
  "schema_migrations",     // migration bookkeeping
  "combo_items",           // rows derived from a menu item's own combo array
  "order_status_history",  // derived from a status-keyed object, identified by (order, status, time)
  "reservation_slots",     // identified by (date, time, table)
  "recipe_items",          // derived from a recipe's ingredient array
  "purchase_order_items",  // derived from a PO's item array
  "customer_addresses",    // derived from customers.savedAddresses
  "daily_usage",           // identified by (date, item)
  "attendance",            // identified by (date, employee)
  "payroll_entries",       // identified by (month, employee, kind)
  "staff_stats",           // identified by (employee, scope, month)
  "stop_list",             // identified by (restaurant, menu item)
  "two_factor_credentials",// identified by its polymorphic (owner_type, owner_id)
  "backup_codes",          // child rows of a two_factor_credentials record
  "payment_credentials",   // one row per provider; the provider name IS the key (settings/payments/$provider)
  "order_chats",           // orderChats/$orderId — the RTDB key IS the order id, kept in legacy_order_id
  "system_alerts",         // systemAlerts/$type — the RTDB key IS alert_type, which is NOT NULL and unique per tenant
  "discount_claims",       // discountClaims/$restId/$token — the RTDB key IS the token, unique per tenant
  "realtime_events",       // Phase 2 durable WS log — identified by (restaurant_id, seq), not an RTDB tree
]);

describe("migration files are well-formed", () => {
  test("there is at least one migration and they are numbered contiguously", () => {
    assert.ok(upFiles.length >= 7, `expected 7+ migrations, found ${upFiles.length}`);
    const numbers = upFiles.map((f) => Number(f.slice(0, 4)));
    for (let i = 0; i < numbers.length; i++) {
      assert.equal(numbers[i], i + 1, `migration numbering has a gap at ${upFiles[i]}`);
    }
  });

  test("every up migration has a matching down migration", () => {
    const downs = new Set(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".down.sql")));
    for (const up of upFiles) {
      assert.ok(downs.has(up.replace(".up.sql", ".down.sql")), `${up} has no .down.sql`);
    }
  });

  test("parentheses balance in every migration file", () => {
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql"))) {
      const clean = stripNoise(sqlOf(f));
      let depth = 0;
      for (const ch of clean) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        assert.ok(depth >= 0, `${f}: unbalanced closing paren`);
      }
      assert.equal(depth, 0, `${f}: ${depth} unclosed paren(s)`);
    }
  });

  test("every table created in an up migration is dropped in its down", () => {
    for (const up of upFiles) {
      const created = parseTables(sqlOf(up)).map((t) => t.name);
      const down = stripNoise(sqlOf(path.join(MIGRATIONS_DIR, up.replace(".up.sql", ".down.sql"))
        .replace(MIGRATIONS_DIR + path.sep, "")));
      for (const name of created) {
        assert.match(down, new RegExp(`DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?${name}\\b`, "i"),
          `${up}: table ${name} is never dropped in the down migration`);
      }
    }
  });

  test("no table name is created twice across migrations", () => {
    const seen = new Map();
    for (const t of ALL_TABLES) {
      assert.ok(!seen.has(t.name), `${t.name} created in both ${seen.get(t.name)} and ${t.file}`);
      seen.set(t.name, t.file);
    }
  });
});

describe("column typing rules", () => {
  test("money columns are numeric(14,2) — never float, never bare numeric", () => {
    const MONEY = /(amount|total|price|subtotal|fee|paid|cost|balance|salary|revenue|spent|value)/i;
    for (const t of ALL_TABLES) {
      for (const line of t.body.split("\n")) {
        // numeric(14,2) contains a comma, so the type pattern has to consume
        // a parenthesised argument list rather than stopping at the first one.
        const m = /^\s*([a-z_][a-z0-9_]*)\s+(double precision|real|float\d*|money|numeric(?:\([^)]*\))?)/i.exec(line);
        if (!m) continue;
        const [, col, type] = m;
        assert.ok(!/^(double precision|real|float|money)/i.test(type),
          `${t.name}.${col} uses ${type} — money must be exact numeric (${t.file})`);
        if (MONEY.test(col) && /^numeric/i.test(type)) {
          assert.match(type, /^numeric\(\d+,\d+\)/i,
            `${t.name}.${col} is bare ${type} — money needs an explicit precision/scale (${t.file})`);
        }
      }
    }
  });

  test("all timestamps are timestamptz, never naive timestamp", () => {
    for (const t of ALL_TABLES) {
      for (const line of t.body.split("\n")) {
        const m = /^\s*([a-z_][a-z0-9_]*)\s+timestamp\b(?!tz)/i.exec(line);
        if (m && !/with time zone/i.test(line)) {
          assert.fail(`${t.name}.${m[1]} is a naive timestamp — use timestamptz (${t.file})`);
        }
      }
    }
  });

  test("every table has a uuid primary key, or is keyed by its parent", () => {
    for (const t of ALL_TABLES) {
      if (t.name === "schema_migrations") continue;
      if (t.name === "realtime_events") continue; // Phase 2 log: (restaurant_id, seq) identity, bigserial id
      assert.ok(hasSurrogatePk(t) || hasParentPk(t) || hasCompositePk(t),
        `${t.name} has no usable primary key (${t.file})`);
    }
  });

  test("every entity with its own identity preserves its Firebase key", () => {
    const offenders = [];
    for (const t of ALL_TABLES) {
      // A 1:1 extension or relationship row inherits its parent's legacy id.
      if (!hasSurrogatePk(t) || is1to1Extension(t)) continue;
      if (NO_LEGACY_ID.has(t.name)) continue;
      // Usually `legacy_rtdb_id`. A few collections are keyed in Firebase by
      // their PARENT's id instead (orderChats/$orderId), and anchor on a
      // mandatory `legacy_<parent>_id` — equally lossless, so accept either.
      const anchored = /\blegacy_rtdb_id\b/.test(t.body)
        || /\blegacy_[a-z_]+_id\s+text\s+NOT\s+NULL/i.test(t.body);
      if (!anchored) offenders.push(`${t.name} (${t.file})`);
    }
    assert.deepEqual(offenders, [],
      `these tables preserve no Firebase key — add legacy_rtdb_id, or list them in NO_LEGACY_ID with the natural key that replaces it:\n  ${offenders.join("\n  ")}`);
  });
});

describe("tenant isolation is wired for every tenant-owned table", () => {
  const allSql = upFiles.map(sqlOf).join("\n");

  test("every table with restaurant_id has an RLS call", () => {
    for (const t of ALL_TABLES) {
      if (!/\brestaurant_id\b/.test(t.body)) continue;
      if (NOT_TENANT_OWNED.has(t.name)) continue;
      const applied = new RegExp(`apply_(tenant|inherited)_rls\\(\\s*'${t.name}'`, "i").test(allSql)
        || new RegExp(`ALTER\\s+TABLE\\s+${t.name}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, "i").test(allSql);
      assert.ok(applied, `${t.name} owns a restaurant_id but has no RLS applied (${t.file})`);
    }
  });

  test("the RLS helper forces row level security", () => {
    // Everything relies on this one function, so assert it directly rather
    // than trusting ~70 call sites.
    assert.match(allSql, /FORCE\s+ROW\s+LEVEL\s+SECURITY/i,
      "no FORCE ROW LEVEL SECURITY anywhere — a table owner would bypass RLS");
  });

  test("the tenant predicate uses the project's current_setting convention", () => {
    assert.match(allSql, /current_setting\(\s*''?app\.current_restaurant_id''?\s*,\s*true\s*\)/i,
      "tenant policies must read app.current_restaurant_id with the missing_ok flag");
  });

  test("every restaurant_id foreign key cascades or is explicitly restricted", () => {
    for (const t of ALL_TABLES) {
      const m = /restaurant_id\s+uuid[^,]*REFERENCES\s+restaurants\(id\)([^,]*)/i.exec(t.body);
      if (!m) continue;
      assert.match(m[1], /ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL)/i,
        `${t.name}.restaurant_id has no explicit ON DELETE behaviour (${t.file})`);
    }
  });
});

describe("the orders domain meets its special requirements (#5)", () => {
  const orders = ALL_TABLES.find((t) => t.name === "orders");
  const orderItems = ALL_TABLES.find((t) => t.name === "order_items");

  test("all seven required order tables exist", () => {
    const names = new Set(ALL_TABLES.map((t) => t.name));
    for (const required of [
      "orders", "order_items", "order_status_history", "order_change_requests",
      "order_timeline", "order_chats", "payments",
    ]) {
      assert.ok(names.has(required), `missing required table: ${required}`);
    }
  });

  test("orders preserves every field the brief names", () => {
    for (const col of [
      "order_number", "restaurant_id", "order_type", "table_id", "waiter_id",
      "customer_id", "courier_id", "status", "subtotal", "discount_amount",
      "service_fee_amount", "total", "payment_status", "payment_method",
      "created_at", "source", "delivery_address", "notes",
    ]) {
      assert.match(orders.body, new RegExp(`\\b${col}\\b`), `orders.${col} is missing`);
    }
  });

  test("order_items stores snapshots, not just a live menu reference", () => {
    for (const col of ["name_snapshot", "price_snapshot", "qty", "modifiers", "extras"]) {
      assert.match(orderItems.body, new RegExp(`\\b${col}\\b`), `order_items.${col} is missing`);
    }
    assert.match(orderItems.body, /legacy_menu_id/,
      "order_items must keep the original menu id even when the dish is deleted");
  });

  test("a deleted menu item cannot cascade away an order's history", () => {
    const fk = /menu_item_id\s+uuid[^,]*REFERENCES\s+menu_items\(id\)([^,]*)/i.exec(orderItems.body);
    assert.ok(fk, "order_items.menu_item_id FK not found");
    assert.doesNotMatch(fk[1], /ON\s+DELETE\s+CASCADE/i,
      "order_items.menu_item_id must NOT cascade — deleting a dish would erase order history");
  });

  test("every mandated entity has a table", () => {
    const names = new Set(ALL_TABLES.map((t) => t.name));
    const required = [
      "organizations", "restaurants", "restaurant_settings", "employees",
      "employee_credentials", "custom_roles", "role_overrides", "platform_users",
      "two_factor_credentials", "backup_codes", "tables", "menu_categories",
      "kitchen_stations", "menu_items", "modifiers", "extras", "combo_items",
      "customers", "orders", "order_items", "order_status_history",
      "order_change_requests", "reservations", "payments", "cash_counts",
      "finance_entries", "expenses", "inventory_items", "stock_movements",
      "recipes", "recipe_items", "suppliers", "purchase_orders",
      "purchase_order_items", "supplier_payments", "debts", "couriers",
      "courier_assignments", "attendance", "chef_tasks", "prep_schedule",
      "waste_log", "equipment_status", "kitchen_inventory",
      "kitchen_announcements", "chats", "order_chats", "order_timeline",
      "audit_log", "activity_logs", "discount_claims", "print_settings",
    ];
    const missing = required.filter((r) => !names.has(r));
    assert.deepEqual(missing, [], `entities from the brief with no table: ${missing.join(", ")}`);
  });

  test("the one merged entity is merged deliberately, not dropped", () => {
    // The brief lists `ingredients` and `inventory_items` as 2 of its 53
    // entities. Live Firebase holds `inventory` and `ingredients` as two
    // trees with the same record shape, written by different screens. They
    // are one table here, discriminated by a column — recorded in
    // FIREBASE_TO_POSTGRES_MAPPING.md, not silently collapsed.
    const names = new Set(ALL_TABLES.map((t) => t.name));
    assert.equal(names.has("ingredients"), false,
      "if a separate ingredients table now exists, update this test and the mapping doc");
    const inv = ALL_TABLES.find((t) => t.name === "inventory_items");
    assert.match(inv.body, /\btracked_as\b/,
      "inventory_items must record which Firebase tree each row came from");
  });
});

describe("date-keyed Firebase trees became real columns (#8)", () => {
  test("no table stores a date as an opaque text key", () => {
    const dateKeyed = {
      attendance: "work_date",
      waste_log: "waste_date",
      chef_tasks: "task_date",
      prep_schedule: "prep_date",
      daily_usage: "usage_date",
      staff_stats: "period_month",
      payroll_entries: "period_month",
    };
    for (const [table, col] of Object.entries(dateKeyed)) {
      const t = ALL_TABLES.find((x) => x.name === table);
      assert.ok(t, `${table} not found`);
      assert.match(t.body, new RegExp(`\\b${col}\\s+date\\b`, "i"),
        `${table}.${col} must be a real date column, not a text key`);
    }
  });
});
