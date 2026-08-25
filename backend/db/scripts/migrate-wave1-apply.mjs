#!/usr/bin/env node
// db/scripts/migrate-wave1-apply.mjs — REAL Wave 1 Firebase → PostgreSQL
// master-data migration. Reads Firebase (read-only, via systemGet — the
// same trusted Admin SDK path migrate-wave1-dry-run.mjs already used), and
// writes ONLY to PostgreSQL. Never writes, updates, or deletes anything in
// Firebase, never touches Firebase Rules or Auth, never touches the
// nesta_app role's password, never logs a password/hash/secret/token.
//
// Scope: restaurants, employees, tables, menu_categories (real + seeded
// static), kitchen_stations, menu_items, combo_items — exactly Wave 1's
// accepted schema (0002_wave1_master_data.up.sql). Does not touch Wave 0
// data (employee_credentials/2FA are explicitly NOT migrated here — that is
// Wave 0's own data scope, not requested this run) and does not create any
// new table/column (see the two documented schema-gap notes below).
//
// Pipeline per restaurant: READ (already done once, up front) → VALIDATE →
// TRANSFORM → UPSERT → VERIFY → CHECKPOINT. Each restaurant is exactly one
// Postgres transaction — a failure in restaurant N never touches restaurant
// N-1's already-committed data, and rolls back restaurant N's own partial
// work entirely (no half-migrated restaurant is ever left committed).
//
// Idempotent + retry-safe: every insert is an UPSERT keyed on the same
// (restaurant_id, legacy_rtdb_id) uniqueness Wave 1's schema already
// defines — running this script twice against the same Firebase data
// converges to the same Postgres rows, it does not duplicate them.
// Additionally checkpointed: db/migration-audit/wave1-checkpoint.json
// records which restaurants finished, so a re-run after an interruption
// skips already-completed restaurants by default (use --fresh to ignore
// the checkpoint and re-verify everything via the same idempotent UPSERTs).
//
// Two known, deliberate schema-gap deviations (documented here, not
// silently patched by inventing new columns mid-apply — adding a column is
// a schema change, out of scope for "apply the already-accepted schema"):
//   1. tables.created_at is NOT NULL in 0002's accepted schema. Where the
//      source table has no legacy createdAt (table_2's case), this script
//      omits the column from the INSERT so Postgres's own DEFAULT now()
//      fills it — never a fabricated legacy timestamp — and records the
//      row as "generated, not legacy" in the audit JSON (no migrated_at
//      column exists to hold that distinction structurally; the audit file
//      is where it lives instead).
//   2. menu_items has no original_price / combo_discount_type /
//      combo_discount_value columns. Approved decision §5 asked for them to
//      be stored; 0002's accepted schema has no destination for them. This
//      script stores the one supported column (price) in Postgres and
//      writes the discount metadata into the audit JSON only — flagged
//      plainly in this run's report, not guessed into an unrelated column
//      (e.g. `variants`) and not silently dropped.
//
// Usage:
//   node db/scripts/migrate-wave1-apply.mjs --dry-run [--fresh] [--only=rest_A,rest_B]
//   node db/scripts/migrate-wave1-apply.mjs --apply   [--fresh] [--only=rest_A,rest_B] [--stop-on-error]
// --dry-run runs the exact same VALIDATE→TRANSFORM→UPSERT code path inside
// a per-restaurant transaction that is always ROLLBACK'd — real constraint
// checks run for real, nothing persists.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { systemGet } from "../../systemDb.js";
import { getPool, isPgAvailable, maskedConfig, closePool } from "../postgres.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_DIR = path.join(__dirname, "..", "migration-audit");
const CHECKPOINT_PATH = path.join(AUDIT_DIR, "wave1-checkpoint.json");

// ── CLI args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const MODE_APPLY = argv.includes("--apply");
const MODE_DRYRUN = argv.includes("--dry-run") || !MODE_APPLY; // dry-run is the safe default
const FRESH = argv.includes("--fresh");
const STOP_ON_ERROR = argv.includes("--stop-on-error");
const onlyArg = argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").filter(Boolean)) : null;

// ── Static category taxonomy — verbatim copy of admin-frontend/public/js/
// shared.js's CATEGORY_DATA (re-read and diffed against source on 2026-08-13
// before writing this file). Frontend-only, never written to Firebase — the
// migration seeds these as real Postgres rows per the approved decision.
// Keep this in sync manually if shared.js's CATEGORY_DATA ever changes.
const STATIC_CATEGORY_DATA = [
  { id: "main", nameKey: "cat_main", sub: ["sub_meat", "sub_chicken", "sub_fish", "sub_national"] },
  { id: "snacks", nameKey: "cat_snacks", sub: ["sub_salads", "sub_small_snacks", "sub_cold_snacks", "sub_hot_snacks"] },
  { id: "soups", nameKey: "cat_soups", sub: ["sub_national_soups", "sub_broths", "sub_cream_soups"] },
  { id: "fastfood", nameKey: "cat_fastfood", sub: ["sub_burgers", "sub_hotdog", "sub_sandwich", "sub_shawarma"] },
  { id: "garnish", nameKey: "cat_garnish", sub: ["sub_potato", "sub_veggie_garnish", "sub_rice_pasta"] },
  { id: "drinks", nameKey: "cat_drinks", sub: ["sub_hot_drinks", "sub_cold_drinks", "sub_soda", "sub_juices"] },
  { id: "dessert", nameKey: "cat_dessert", sub: ["sub_cakes", "sub_pastry", "sub_icecream", "sub_sweets"] },
  { id: "bread", nameKey: "cat_bread", sub: ["sub_bread", "sub_lavash", "sub_round_bread", "sub_baguette"] },
  { id: "special", nameKey: "cat_special", sub: ["sub_kids", "sub_diet", "sub_vegan", "sub_sport"] },
  { id: "combo", nameKey: "category_combo", sub: ["fast_food", "family_combo", "lunch"] },
];

function ts(ms) {
  return ms ? new Date(Number(ms)) : null; // null → column omitted from the INSERT, DB DEFAULT applies
}

function batchIdFromCheckpointOrNew() {
  if (!FRESH && existsSync(CHECKPOINT_PATH)) {
    try {
      const cp = JSON.parse(readFileSync(CHECKPOINT_PATH, "utf8"));
      if (cp.batchId) return { batchId: cp.batchId, completed: new Set(cp.completedRestaurants || []) };
    } catch { /* fall through to a fresh batch */ }
  }
  return { batchId: `wave1-${Date.now()}`, completed: new Set() };
}

function saveCheckpoint(batchId, completed) {
  mkdirSync(AUDIT_DIR, { recursive: true });
  writeFileSync(
    CHECKPOINT_PATH,
    JSON.stringify({ batchId, completedRestaurants: [...completed], lastUpdatedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

// ── One transaction per restaurant. Always the same code path for dry-run
// and apply — only whether it COMMITs or ROLLBACKs differs. Runs as the
// connecting POSTGRES_USER (the schema owner/migrator), matching how
// db/migrate.js itself applies schema — a system migration tool acting
// with the privileges that role already has, the same way every other
// db/migrate.js-adjacent script in this repo does. RLS's tenant policies
// aren't the thing under test here (db/tests/rls*.test.mjs already prove
// those); this is bulk system-level data load.
async function runRestaurantTx(pool, fn, { commit }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_restaurant_id', '', true)");
    await client.query("SELECT set_config('app.current_employee_role', '', true)");
    const result = await fn(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── VALIDATE + TRANSFORM (pure — no DB access) ────────────────────────────
function validateAndTransformRestaurant(rid, r, exceptions) {
  const info = r?.info || {};
  if (!info.domain && !info.name) {
    exceptions.push({ scope: "restaurant", legacyId: rid, reason: "no info.domain or info.name", action: "skipped_restaurant_and_all_children" });
    return null;
  }
  return {
    legacy_rtdb_id: rid,
    domain: info.domain,
    name: info.name,
    status: info.status || undefined, // undefined → column omitted, DB default 'active' applies
    business_type: info.businessType || null,
    info,
    created_at: ts(info.createdAt),
    updated_at: ts(info.updatedAt),
  };
}

function transformEmployees(rid, r, exceptions) {
  const out = [];
  const users = r?.users || {};
  for (const [uid, u] of Object.entries(users)) {
    if (!u?.name || !u?.role) {
      exceptions.push({ scope: "employee", restaurantLegacyId: rid, legacyId: uid, reason: "legacy employee has empty role", action: "skipped_no_infer_no_write" });
      continue;
    }
    out.push({
      legacy_rtdb_id: uid,
      name: u.name,
      // No dedicated "login" field exists anywhere in the observed RTDB
      // employee shape (confirmed by field-union audit) — employees log in
      // via a per-restaurant 4-digit PIN (login.js), not a username. The
      // RTDB key itself is already guaranteed unique per restaurant (same
      // value stored as legacy_rtdb_id), so it is reused as `login` rather
      // than inventing a new identifier — copying an existing real key,
      // not fabricating business data.
      login: uid,
      role: u.role,
      active: u.active !== false,
      created_at: ts(u.createdAt),
    });
  }
  return out;
}

function transformTables(rid, r, exceptions) {
  const out = [];
  const tbls = r?.tables || {};
  for (const [key, tb] of Object.entries(tbls)) {
    let number = tb?.number;
    let numberSource = "field";
    if (number === undefined || number === null) {
      const m = /^table_(\d+)$/.exec(key);
      if (m) { number = Number(m[1]); numberSource = "parsed_from_key"; }
      else {
        exceptions.push({ scope: "table", restaurantLegacyId: rid, legacyId: key, reason: "missing number, unparseable key", action: "skipped" });
        continue;
      }
    }
    const generatedFields = [];
    if (numberSource === "parsed_from_key") generatedFields.push("number(parsed_from_key)");
    if (tb.capacity === undefined || tb.capacity === null) generatedFields.push("capacity(null)");
    if (!tb.tableType) generatedFields.push("table_type(app_default_oddiy)");
    if (tb.active === undefined) generatedFields.push("active(default_true)");
    if (!tb.createdAt) generatedFields.push("created_at(db_default_now)");
    if (generatedFields.length) {
      exceptions.push({ scope: "table", restaurantLegacyId: rid, legacyId: key, reason: "safe-default mapping applied for missing legacy fields", generatedFields, action: "migrated_with_generated_defaults" });
    }
    out.push({
      legacy_rtdb_id: key,
      number,
      table_type: tb.tableType || "oddiy",
      capacity: tb.capacity ?? null,
      active: tb.active ?? true,
      status: tb.status || undefined,
      created_at: ts(tb.createdAt),
      updated_at: ts(tb.updatedAt),
    });
  }
  return out;
}

function transformKitchenStations(r) {
  const out = [];
  for (const [sid, st] of Object.entries(r?.kitchenStations || {})) {
    out.push({ legacy_rtdb_id: st?.id || sid, name: st?.name || { uz: sid }, created_at: ts(st?.createdAt) });
  }
  return out;
}

function transformRealCategories(r) {
  const cats = [];
  let order = 0;
  for (const [cid, cat] of Object.entries(r?.categories || {})) {
    const subOut = [];
    let subOrder = 0;
    for (const [sid, sub] of Object.entries(cat?.sub || {})) {
      subOut.push({ legacy_rtdb_id: sub?.id || sid, name: sub?.name || { uz: sid }, sort_order: subOrder++ });
    }
    cats.push({ legacy_rtdb_id: cat?.id || cid, name: cat?.name || { uz: cid }, sort_order: order++, created_at: ts(cat?.createdAt), sub: subOut });
  }
  return cats;
}

function transformStaticCategories() {
  // legacy_rtdb_id "static:<id>" / "static:<id>:<subKey>" — a stable,
  // deterministic key so re-running the migration upserts the same rows,
  // never duplicates them. name stores the translation KEY only (per
  // approved decision §4), never a resolved/localized string.
  return STATIC_CATEGORY_DATA.map((cat, i) => ({
    legacy_rtdb_id: `static:${cat.id}`,
    name: { translationKey: cat.nameKey, static: true },
    sort_order: i,
    sub: cat.sub.map((subKey, j) => ({
      legacy_rtdb_id: `static:${cat.id}:${subKey}`,
      name: { translationKey: subKey, static: true },
      sort_order: j,
    })),
    staticId: cat.id, // used only for menu_item category resolution below, not written to DB
  }));
}

function transformMenuItems(r, exceptions, rid) {
  const out = [];
  for (const [mid, item] of Object.entries(r?.menu || {})) {
    if (!item?.name || item?.price === undefined) {
      exceptions.push({ scope: "menu_item", restaurantLegacyId: rid, legacyId: mid, reason: "missing name or price", action: "skipped" });
      continue;
    }
    out.push({
      legacy_rtdb_id: mid,
      name: item.name,
      price: item.price,
      categoryRef: item.category || null,
      subcategoryRef: item.subcategory || null,
      kitchenStationRef: item.kitchenStation || null,
      prep_time: item.prepTime || null,
      img_url: item.imgUrl || null,
      is_weight_based: !!item.isWeightBased,
      is_featured: !!item.isFeatured,
      is_new: !!item.isNew,
      portion_size: item.portionSize || null,
      variants: item.variants || null,
      is_combo: !!(item.isCombo || item.category === "combo"),
      active: item.active !== false,
      created_at: ts(item.createdAt),
      // Not written to any Postgres column — no destination exists in the
      // accepted Wave 1 schema (see file header, gap #2). Captured here so
      // it lands in this run's audit JSON.
      _comboMeta: item.isCombo ? { originalPrice: item.originalPrice ?? null, discountMeta: item.discountMeta || null, comboItems: Array.isArray(item.comboItems) ? item.comboItems : [] } : null,
    });
  }
  return out;
}

// ── UPSERT helpers (each takes the per-restaurant client + pg restaurant id) ──
async function upsertRestaurant(client, row) {
  const cols = ["legacy_rtdb_id", "domain", "name", "business_type", "info"];
  const vals = [row.legacy_rtdb_id, row.domain, row.name, row.business_type, JSON.stringify(row.info)];
  if (row.status) { cols.push("status"); vals.push(row.status); }
  if (row.created_at) { cols.push("created_at"); vals.push(row.created_at); }
  if (row.updated_at) { cols.push("updated_at"); vals.push(row.updated_at); }
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const updateSet = cols.filter((c) => c !== "legacy_rtdb_id").map((c) => `${c} = EXCLUDED.${c}`).join(", ");
  const { rows } = await client.query(
    `INSERT INTO restaurants (${cols.join(", ")}) VALUES (${placeholders})
     ON CONFLICT (legacy_rtdb_id) DO UPDATE SET ${updateSet}
     RETURNING id`,
    vals
  );
  return rows[0].id;
}

async function upsertRestaurantSettings(client, restId, settings) {
  if (!settings) return false;
  await client.query(
    `INSERT INTO restaurant_settings (restaurant_id, settings)
     VALUES ($1, $2)
     ON CONFLICT (restaurant_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`,
    [restId, JSON.stringify(settings)]
  );
  return true;
}

async function upsertEmployees(client, restId, employees) {
  let count = 0;
  for (const e of employees) {
    const cols = ["restaurant_id", "legacy_rtdb_id", "name", "login", "role", "active"];
    const vals = [restId, e.legacy_rtdb_id, e.name, e.login, e.role, e.active];
    if (e.created_at) { cols.push("created_at"); vals.push(e.created_at); }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const updateSet = cols.filter((c) => !["restaurant_id", "legacy_rtdb_id"].includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(", ");
    await client.query(
      `INSERT INTO employees (${cols.join(", ")}) VALUES (${placeholders})
       ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET ${updateSet}`,
      vals
    );
    count++;
  }
  return count;
}

async function upsertTables(client, restId, tables) {
  let count = 0;
  for (const t of tables) {
    const cols = ["restaurant_id", "legacy_rtdb_id", "number", "table_type", "capacity", "active"];
    const vals = [restId, t.legacy_rtdb_id, t.number, t.table_type, t.capacity, t.active];
    if (t.status) { cols.push("status"); vals.push(t.status); }
    if (t.created_at) { cols.push("created_at"); vals.push(t.created_at); }
    if (t.updated_at) { cols.push("updated_at"); vals.push(t.updated_at); }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const updateSet = cols.filter((c) => !["restaurant_id", "legacy_rtdb_id"].includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(", ");
    await client.query(
      `INSERT INTO tables (${cols.join(", ")}) VALUES (${placeholders})
       ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET ${updateSet}`,
      vals
    );
    count++;
  }
  return count;
}

async function upsertKitchenStations(client, restId, stations) {
  const map = new Map(); // legacy_rtdb_id -> pg id
  for (const s of stations) {
    const cols = ["restaurant_id", "legacy_rtdb_id", "name"];
    const vals = [restId, s.legacy_rtdb_id, JSON.stringify(s.name)];
    if (s.created_at) { cols.push("created_at"); vals.push(s.created_at); }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const updateSet = cols.filter((c) => !["restaurant_id", "legacy_rtdb_id"].includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(", ");
    const { rows } = await client.query(
      `INSERT INTO kitchen_stations (${cols.join(", ")}) VALUES (${placeholders})
       ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET ${updateSet}
       RETURNING id`,
      vals
    );
    map.set(s.legacy_rtdb_id, rows[0].id);
  }
  return map;
}

async function upsertCategoryRow(client, restId, cat, parentId) {
  const cols = ["restaurant_id", "legacy_rtdb_id", "name", "sort_order", "parent_id"];
  const vals = [restId, cat.legacy_rtdb_id, JSON.stringify(cat.name), cat.sort_order, parentId];
  if (cat.created_at) { cols.push("created_at"); vals.push(cat.created_at); }
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const updateSet = cols.filter((c) => !["restaurant_id", "legacy_rtdb_id"].includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(", ");
  const { rows } = await client.query(
    `INSERT INTO menu_categories (${cols.join(", ")}) VALUES (${placeholders})
     ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET ${updateSet}
     RETURNING id`,
    vals
  );
  return rows[0].id;
}

/** Upserts both real (RTDB-backed) categories and, if this restaurant has
 *  any menu items, the seeded static taxonomy. Returns a lookup map from
 *  "category-reference-string" (the raw item.category / item.subcategory
 *  value) to { id, subcategories: Map<subRef, id> } — checking real
 *  categories first, then the static fallback, matching menu_items'
 *  resolution rule (see transformMenuItems callers below). */
async function upsertAllCategories(client, restId, realCats, seedStatic) {
  const byRef = new Map(); // ref string -> { id, subs: Map<ref, id> }
  let realCount = 0, staticCount = 0;

  for (const cat of realCats) {
    const parentId = await upsertCategoryRow(client, restId, cat, null);
    realCount++;
    const subs = new Map();
    for (const sub of cat.sub) {
      const subId = await upsertCategoryRow(client, restId, sub, parentId);
      realCount++;
      subs.set(sub.legacy_rtdb_id, subId);
    }
    byRef.set(cat.legacy_rtdb_id, { id: parentId, subs });
  }

  if (seedStatic) {
    for (const cat of transformStaticCategories()) {
      const parentId = await upsertCategoryRow(client, restId, cat, null);
      staticCount++;
      const subs = new Map();
      for (const sub of cat.sub) {
        const subId = await upsertCategoryRow(client, restId, sub, parentId);
        staticCount++;
        subs.set(sub.legacy_rtdb_id.split(":").pop(), subId); // key by bare subKey for resolution
      }
      byRef.set(cat.staticId, { id: parentId, subs }); // key by bare static id ("main", "snacks", ...) for resolution
    }
  }

  return { byRef, realCount, staticCount };
}

async function upsertMenuItems(client, restId, items, categoryMap, kitchenMap, exceptions, rid) {
  const idMap = new Map(); // legacy_rtdb_id -> pg id
  let count = 0;
  const comboMetaLog = [];
  for (const item of items) {
    let categoryId = null, subcategoryId = null;
    if (item.categoryRef) {
      const resolved = categoryMap.get(item.categoryRef);
      if (resolved) {
        categoryId = resolved.id;
        if (item.subcategoryRef) subcategoryId = resolved.subs.get(item.subcategoryRef) || null;
      } else {
        exceptions.push({ scope: "menu_item_category_ref", restaurantLegacyId: rid, legacyId: item.legacy_rtdb_id, reason: `category "${item.categoryRef}" not found (real or static)`, action: "category_id_null" });
      }
    }
    let kitchenStationId = item.kitchenStationRef ? (kitchenMap.get(item.kitchenStationRef) || null) : null;

    const cols = ["restaurant_id", "legacy_rtdb_id", "category_id", "subcategory_id", "kitchen_station_id", "name", "price", "prep_time", "img_url", "is_weight_based", "is_featured", "is_new", "portion_size", "variants", "is_combo", "active"];
    const vals = [restId, item.legacy_rtdb_id, categoryId, subcategoryId, kitchenStationId, JSON.stringify(item.name), item.price, item.prep_time, item.img_url, item.is_weight_based, item.is_featured, item.is_new, item.portion_size, item.variants ? JSON.stringify(item.variants) : null, item.is_combo, item.active];
    if (item.created_at) { cols.push("created_at"); vals.push(item.created_at); }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const updateSet = cols.filter((c) => !["restaurant_id", "legacy_rtdb_id"].includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(", ");
    const { rows } = await client.query(
      `INSERT INTO menu_items (${cols.join(", ")}) VALUES (${placeholders})
       ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET ${updateSet}
       RETURNING id`,
      vals
    );
    idMap.set(item.legacy_rtdb_id, rows[0].id);
    count++;
    if (item._comboMeta) comboMetaLog.push({ legacyId: item.legacy_rtdb_id, price: item.price, ...item._comboMeta });
  }
  return { idMap, count, comboMetaLog };
}

async function upsertComboItems(client, restId, items, itemIdMap, exceptions, rid) {
  let count = 0;
  for (const item of items) {
    if (!item._comboMeta || !item._comboMeta.comboItems.length) continue;
    const comboPgId = itemIdMap.get(item.legacy_rtdb_id);
    for (const ci of item._comboMeta.comboItems) {
      const componentPgId = itemIdMap.get(String(ci.menuId));
      if (!componentPgId) {
        exceptions.push({ scope: "combo_component", restaurantLegacyId: rid, legacyId: item.legacy_rtdb_id, reason: `component menuId "${ci.menuId}" not resolvable to a migrated menu_items row in this restaurant`, action: "combo_items_row_skipped" });
        continue;
      }
      const qty = Number(ci.qty) > 0 ? Number(ci.qty) : 1;
      await client.query(
        `INSERT INTO combo_items (combo_menu_item_id, component_menu_item_id, qty) VALUES ($1,$2,$3)
         ON CONFLICT (combo_menu_item_id, component_menu_item_id) DO UPDATE SET qty = EXCLUDED.qty`,
        [comboPgId, componentPgId, qty]
      );
      count++;
    }
  }
  return count;
}

// ── Per-restaurant orchestration ──────────────────────────────────────────
async function migrateOneRestaurant(pool, rid, r, commit, exceptions) {
  const restaurantRow = validateAndTransformRestaurant(rid, r, exceptions);
  if (!restaurantRow) return { status: "skipped_restaurant" };

  const employees = transformEmployees(rid, r, exceptions);
  const tables = transformTables(rid, r, exceptions);
  const stations = transformKitchenStations(r);
  const realCats = transformRealCategories(r);
  const menuItemsSrc = transformMenuItems(r, exceptions, rid);
  const seedStatic = Object.keys(r?.menu || {}).length > 0;

  const summary = await runRestaurantTx(pool, async (client) => {
    const restId = await upsertRestaurant(client, restaurantRow);
    const hasSettings = await upsertRestaurantSettings(client, restId, r?.settings || null);
    const employeeCount = await upsertEmployees(client, restId, employees);
    const tableCount = await upsertTables(client, restId, tables);
    const kitchenMap = await upsertKitchenStations(client, restId, stations);
    const { byRef: categoryMap, realCount, staticCount } = await upsertAllCategories(client, restId, realCats, seedStatic);
    const { idMap, count: menuItemCount, comboMetaLog } = await upsertMenuItems(client, restId, menuItemsSrc, categoryMap, kitchenMap, exceptions, rid);
    const comboItemCount = await upsertComboItems(client, restId, menuItemsSrc, idMap, exceptions, rid);

    // VERIFY — confirm what we just wrote (same transaction, pre-commit) matches what we intended.
    const verify = await client.query(
      `SELECT
         (SELECT count(*) FROM employees WHERE restaurant_id = $1) AS employees,
         (SELECT count(*) FROM tables WHERE restaurant_id = $1) AS tables,
         (SELECT count(*) FROM menu_categories WHERE restaurant_id = $1) AS categories,
         (SELECT count(*) FROM kitchen_stations WHERE restaurant_id = $1) AS kitchen_stations,
         (SELECT count(*) FROM menu_items WHERE restaurant_id = $1) AS menu_items,
         (SELECT count(*) FROM combo_items WHERE combo_menu_item_id IN (SELECT id FROM menu_items WHERE restaurant_id = $1)) AS combo_items`,
      [restId]
    );
    const v = verify.rows[0];
    const mismatches = [];
    if (Number(v.employees) !== employeeCount) mismatches.push(`employees expected ${employeeCount} got ${v.employees}`);
    if (Number(v.tables) !== tableCount) mismatches.push(`tables expected ${tableCount} got ${v.tables}`);
    if (Number(v.categories) !== realCount + staticCount) mismatches.push(`categories expected ${realCount + staticCount} got ${v.categories}`);
    if (Number(v.menu_items) !== menuItemCount) mismatches.push(`menu_items expected ${menuItemCount} got ${v.menu_items}`);
    if (Number(v.combo_items) !== comboItemCount) mismatches.push(`combo_items expected ${comboItemCount} got ${v.combo_items}`);
    if (mismatches.length) throw new Error(`VERIFY step failed for ${rid}: ${mismatches.join("; ")}`);

    return {
      status: "migrated",
      pgRestaurantId: restId,
      counts: { employees: employeeCount, tables: tableCount, categories: realCount + staticCount, categoriesReal: realCount, categoriesStatic: staticCount, kitchenStations: kitchenMap.size, menuItems: menuItemCount, comboItems: comboItemCount, settings: hasSettings ? 1 : 0 },
      comboMetaLog, // discount metadata with no Postgres destination column — audit-only, see file header gap #2
    };
  }, { commit });

  return summary;
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Wave 1 REAL Migration — mode: ${MODE_APPLY ? "APPLY (writes committed)" : "DRY-RUN (transactions rolled back, nothing persists)"} ===`);
  if (!isPgAvailable()) { console.error("❌ PostgreSQL not configured."); process.exit(1); }
  const cfg = maskedConfig();
  console.log(`[target] ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

  const pool = getPool();
  const { batchId, completed } = batchIdFromCheckpointOrNew();
  console.log(`[batch] ${batchId}${completed.size ? ` (resuming — ${completed.size} restaurant(s) already checkpointed done)` : ""}`);

  console.log("\nReading restaurants/ root from Firebase (Admin SDK, read-only)...");
  const snap = await systemGet("restaurants");
  const fbRestaurants = snap.exists() ? snap.val() : {};
  let rids = Object.keys(fbRestaurants);
  if (ONLY) rids = rids.filter((r) => ONLY.has(r));
  console.log(`Found ${rids.length} restaurant(s) to process (of ${Object.keys(fbRestaurants).length} total in Firebase).\n`);

  const exceptions = [];
  const perRestaurant = [];
  const totals = { migrated: 0, skippedRestaurants: 0, failed: 0, employees: 0, tables: 0, categories: 0, categoriesReal: 0, categoriesStatic: 0, kitchenStations: 0, menuItems: 0, comboItems: 0, settings: 0 };
  const comboMetaAudit = [];

  for (const rid of rids) {
    if (completed.has(rid) && !FRESH) {
      console.log(`  ⏭  ${rid} — already checkpointed done, skipping (use --fresh to re-verify)`);
      continue;
    }
    process.stdout.write(`  → ${rid} ... `);
    try {
      const result = await migrateOneRestaurant(pool, rid, fbRestaurants[rid], MODE_APPLY, exceptions);
      if (result.status === "skipped_restaurant") {
        console.log("SKIPPED (malformed — see exceptions)");
        totals.skippedRestaurants++;
      } else {
        console.log(`OK — employees:${result.counts.employees} tables:${result.counts.tables} categories:${result.counts.categories}(real:${result.counts.categoriesReal}/static:${result.counts.categoriesStatic}) stations:${result.counts.kitchenStations} menu_items:${result.counts.menuItems} combo_items:${result.counts.comboItems}`);
        totals.migrated++;
        for (const k of ["employees", "tables", "categories", "categoriesReal", "categoriesStatic", "kitchenStations", "menuItems", "comboItems", "settings"]) totals[k] += result.counts[k];
        if (result.comboMetaLog?.length) comboMetaAudit.push({ restaurantLegacyId: rid, combos: result.comboMetaLog });
        if (MODE_APPLY) { completed.add(rid); saveCheckpoint(batchId, completed); }
      }
      perRestaurant.push({ legacyId: rid, ...result });
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      totals.failed++;
      exceptions.push({ scope: "restaurant_transaction", legacyId: rid, reason: err.message, action: "rolled_back_this_restaurant_only" });
      perRestaurant.push({ legacyId: rid, status: "failed", error: err.message });
      if (STOP_ON_ERROR) { console.log("\n--stop-on-error set — halting run."); break; }
    }
  }

  // ── Post-run Postgres counts (real counts, whatever mode — apply commits, dry-run always shows 0 delta since everything rolled back) ──
  const setup = await pool.connect();
  let pgCounts = {};
  try {
    const q = await setup.query(`SELECT
      (SELECT count(*) FROM restaurants) AS restaurants,
      (SELECT count(*) FROM employees) AS employees,
      (SELECT count(*) FROM tables) AS tables,
      (SELECT count(*) FROM menu_categories) AS menu_categories,
      (SELECT count(*) FROM kitchen_stations) AS kitchen_stations,
      (SELECT count(*) FROM menu_items) AS menu_items,
      (SELECT count(*) FROM combo_items) AS combo_items`);
    pgCounts = q.rows[0];
  } finally {
    setup.release();
  }

  mkdirSync(AUDIT_DIR, { recursive: true });
  const auditPath = path.join(AUDIT_DIR, `${batchId}-${MODE_APPLY ? "apply" : "dryrun"}.json`);
  writeFileSync(auditPath, JSON.stringify({ batchId, mode: MODE_APPLY ? "apply" : "dry-run", ranAt: new Date().toISOString(), totals, pgCountsAfter: pgCounts, exceptions, comboMetaAudit, perRestaurant: perRestaurant.map(({ comboMetaLog, ...rest }) => rest) }, null, 2), "utf8");

  console.log(`\n=== SUMMARY (${MODE_APPLY ? "APPLY" : "DRY-RUN"}) ===`);
  console.log(`Restaurants migrated : ${totals.migrated}`);
  console.log(`Restaurants skipped  : ${totals.skippedRestaurants}`);
  console.log(`Restaurants failed   : ${totals.failed}`);
  console.log(`Employees migrated   : ${totals.employees}`);
  console.log(`Tables migrated      : ${totals.tables}`);
  console.log(`Categories migrated  : ${totals.categories} (real:${totals.categoriesReal} static:${totals.categoriesStatic})`);
  console.log(`Kitchen stations     : ${totals.kitchenStations}`);
  console.log(`Menu items migrated  : ${totals.menuItems}`);
  console.log(`Combo items migrated : ${totals.comboItems}`);
  console.log(`Exceptions recorded  : ${exceptions.length}`);
  console.log(`\nPostgres table counts after this run:`);
  for (const [k, v] of Object.entries(pgCounts)) console.log(`  ${k}: ${v}`);
  console.log(`\nAudit file: ${auditPath}`);
  console.log(`Checkpoint: ${CHECKPOINT_PATH}`);
  console.log(MODE_APPLY ? "\n✅ APPLY complete." : "\n✅ DRY-RUN complete — no data was committed (every restaurant transaction was rolled back).");

  await closePool();
  process.exit(totals.failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("\nMigration run crashed:", err);
  await closePool().catch(() => {});
  process.exit(1);
});
