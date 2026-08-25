#!/usr/bin/env node
// db/scripts/migrate-wave1-dry-run.mjs — READ-ONLY comparison of Firebase's
// real data against Wave 1's Postgres schema. Reads Firebase (via
// firebaseAdmin.js/systemDb.js, the same trusted Admin SDK path every
// other backend read already uses) and reads Postgres (via db/postgres.js,
// platform context). Writes NOTHING to either store — no set/push/update
// against Firebase, no INSERT/UPDATE against Postgres. Safe to run
// repeatedly against production data.
//
// Entities covered (Wave 1 scope only — orders/finance/inventory/CRM/
// delivery are later waves): restaurants, employees (users), tables,
// menu_categories (+ subcategories), kitchen_stations, menu_items,
// combo composition.
import { systemGet } from "../../systemDb.js";
import { getPool, closePool } from "../postgres.js";

const MAX_EXAMPLES = 15; // cap how many concrete examples print per issue bucket

function report(entity, counts) {
  console.log(`\n${entity}`);
  console.log(`  FIREBASE COUNT : ${counts.firebase}`);
  console.log(`  POSTGRES COUNT : ${counts.postgres}`);
  console.log(`  TO CREATE      : ${counts.toCreate}`);
  console.log(`  TO UPDATE      : ${counts.toUpdate}`);
  console.log(`  CONFLICTS      : ${counts.conflicts.length}`);
  console.log(`  ORPHANS        : ${counts.orphans.length}`);
  console.log(`  MALFORMED      : ${counts.malformed.length}`);
  for (const [label, list] of [["conflict", counts.conflicts], ["orphan", counts.orphans], ["malformed", counts.malformed]]) {
    if (list.length) {
      console.log(`  ${label} examples (up to ${MAX_EXAMPLES}):`);
      list.slice(0, MAX_EXAMPLES).forEach((x) => console.log(`    - ${x}`));
      if (list.length > MAX_EXAMPLES) console.log(`    ... and ${list.length - MAX_EXAMPLES} more`);
    }
  }
}

async function main() {
  console.log("=== Wave 1 Dry Run — READ ONLY, no writes to Firebase or PostgreSQL ===");

  const pool = getPool();
  // Platform context for every Postgres read below — this script inspects
  // across all tenants, matching how a real cross-tenant migration job
  // would run (never a single restaurant's own session).
  const client = await pool.connect();
  await client.query("SELECT set_config('app.current_restaurant_id', '', true)");

  console.log("\nReading restaurants/ root from Firebase (Admin SDK, read-only)...");
  const snap = await systemGet("restaurants");
  const fbRestaurants = snap.exists() ? snap.val() : {};
  const fbRestIds = Object.keys(fbRestaurants);
  console.log(`Found ${fbRestIds.length} restaurant(s) in Firebase.`);

  const pgRestaurants = await client.query("SELECT id, legacy_rtdb_id, domain FROM restaurants");
  const pgRestByLegacyId = new Map(pgRestaurants.rows.filter((r) => r.legacy_rtdb_id).map((r) => [r.legacy_rtdb_id, r]));
  const pgDomains = new Set(pgRestaurants.rows.map((r) => r.domain));

  // ── restaurants ──────────────────────────────────────────────────────
  {
    const conflicts = [], malformed = [];
    let toCreate = 0, toUpdate = 0;
    for (const [rid, r] of Object.entries(fbRestaurants)) {
      const info = r?.info || {};
      if (!info.domain && !info.name) { malformed.push(`${rid}: no info.domain or info.name`); continue; }
      if (info.domain && pgDomains.has(info.domain) && !pgRestByLegacyId.has(rid)) {
        conflicts.push(`${rid}: domain "${info.domain}" already exists in Postgres under a different legacy_rtdb_id`);
        continue;
      }
      if (pgRestByLegacyId.has(rid)) toUpdate++; else toCreate++;
    }
    report("RESTAURANTS", {
      firebase: fbRestIds.length, postgres: pgRestaurants.rowCount,
      toCreate, toUpdate, conflicts, orphans: [], malformed,
    });
  }

  // ── employees (per-restaurant, restaurants/$id/users) ───────────────
  {
    let fbCount = 0, malformedCount = 0;
    const malformed = [];
    for (const [rid, r] of Object.entries(fbRestaurants)) {
      const users = r?.users || {};
      for (const [uid, u] of Object.entries(users)) {
        fbCount++;
        if (!u?.name || !u?.role) { malformed.push(`${rid}/${uid}: missing name or role`); malformedCount++; }
      }
    }
    const pgCount = await client.query("SELECT count(*) FROM employees");
    report("EMPLOYEES (restaurants/$id/users)", {
      firebase: fbCount, postgres: Number(pgCount.rows[0].count),
      toCreate: fbCount - malformedCount, toUpdate: 0, conflicts: [], orphans: [], malformed,
    });
  }

  // ── tables ────────────────────────────────────────────────────────────
  {
    let fbCount = 0;
    const malformed = [], conflicts = [];
    const seenNumberPerRest = new Map();
    for (const [rid, r] of Object.entries(fbRestaurants)) {
      const tbls = r?.tables || {};
      for (const [key, tb] of Object.entries(tbls)) {
        fbCount++;
        if (tb?.number === undefined || tb?.number === null) { malformed.push(`${rid}/${key}: missing number`); continue; }
        const mapKey = `${rid}:${tb.number}`;
        if (seenNumberPerRest.has(mapKey)) conflicts.push(`${rid}: duplicate table number ${tb.number} (keys ${seenNumberPerRest.get(mapKey)} and ${key})`);
        seenNumberPerRest.set(mapKey, key);
      }
    }
    const pgCount = await client.query("SELECT count(*) FROM tables");
    report("TABLES (restaurants/$id/tables)", {
      firebase: fbCount, postgres: Number(pgCount.rows[0].count),
      toCreate: fbCount - malformed.length, toUpdate: 0, conflicts, orphans: [], malformed,
    });
  }

  // ── menu_categories (+ subcategories) ────────────────────────────────
  {
    let fbCount = 0;
    const malformed = [];
    for (const [rid, r] of Object.entries(fbRestaurants)) {
      const cats = r?.categories || {};
      for (const [cid, cat] of Object.entries(cats)) {
        fbCount++;
        if (!cat?.name) malformed.push(`${rid}/${cid}: missing name`);
        const subs = cat?.sub || {};
        for (const [sid, sub] of Object.entries(subs)) {
          fbCount++;
          if (!sub?.name) malformed.push(`${rid}/${cid}/sub/${sid}: missing name`);
        }
      }
    }
    const pgCount = await client.query("SELECT count(*) FROM menu_categories");
    report("MENU_CATEGORIES (+ subcategories)", {
      firebase: fbCount, postgres: Number(pgCount.rows[0].count),
      toCreate: fbCount - malformed.length, toUpdate: 0, conflicts: [], orphans: [], malformed,
    });
  }

  // ── kitchen_stations ──────────────────────────────────────────────────
  {
    let fbCount = 0;
    const malformed = [];
    for (const [rid, r] of Object.entries(fbRestaurants)) {
      const stations = r?.kitchenStations || {};
      for (const [sid, st] of Object.entries(stations)) {
        fbCount++;
        if (!st?.name) malformed.push(`${rid}/${sid}: missing name`);
      }
    }
    const pgCount = await client.query("SELECT count(*) FROM kitchen_stations");
    report("KITCHEN_STATIONS", {
      firebase: fbCount, postgres: Number(pgCount.rows[0].count),
      toCreate: fbCount - malformed.length, toUpdate: 0, conflicts: [], orphans: [], malformed,
    });
  }

  // ── menu_items ────────────────────────────────────────────────────────
  {
    let fbCount = 0, comboCount = 0, staticCategoryRefs = 0;
    const malformed = [], orphans = [];
    for (const [rid, r] of Object.entries(fbRestaurants)) {
      const menu = r?.menu || {};
      const cats = r?.categories || {};
      for (const [mid, item] of Object.entries(menu)) {
        fbCount++;
        if (!item?.name || item?.price === undefined) { malformed.push(`${rid}/${mid}: missing name or price`); continue; }
        if (item?.category && !cats[item.category]) {
          staticCategoryRefs++;
          orphans.push(`${rid}/${mid}: category "${item.category}" not found in restaurants/${rid}/categories — likely a frontend-static/built-in category id (see migration file header), category_id will be NULL`);
        }
        if (item?.subcategory && item?.category && cats[item.category] && !cats[item.category]?.sub?.[item.subcategory]) {
          orphans.push(`${rid}/${mid}: subcategory "${item.subcategory}" not found under category "${item.category}"`);
        }
        if (item?.kitchenStation && !(r?.kitchenStations || {})[item.kitchenStation]) {
          orphans.push(`${rid}/${mid}: kitchenStation "${item.kitchenStation}" not found in restaurants/${rid}/kitchenStations`);
        }
        if (item?.isCombo || item?.category === "combo") comboCount++;
      }
    }
    const pgCount = await client.query("SELECT count(*) FROM menu_items");
    report("MENU_ITEMS (restaurants/$id/menu)", {
      firebase: fbCount, postgres: Number(pgCount.rows[0].count),
      toCreate: fbCount - malformed.length, toUpdate: 0, conflicts: [], orphans, malformed,
    });
    console.log(`  (info) menu items whose .category has no matching RTDB record (static/built-in category — not a data error): ${staticCategoryRefs}`);
    console.log(`  (info) menu items flagged isCombo/category==="combo": ${comboCount} — combo COMPOSITION (which items make up a combo) is not consistently stored as its own RTDB list across restaurants; the real-migration script will only populate combo_items where that composition data actually exists, and will report (not guess) any combo with no discoverable composition.`);
  }

  await client.release();
  await closePool();

  console.log("\n=== Dry run complete. No data was written to Firebase or PostgreSQL. ===");
}

main().catch((err) => {
  console.error("Dry run failed:", err);
  process.exitCode = 1;
});
