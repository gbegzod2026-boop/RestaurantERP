// db/scripts/firebase-discover-legacy-roots.mjs — Phase 1, Step 2b.
//
// firebase-discover.mjs walks restaurants/$restId. This script covers the
// OTHER 30 root keys the live database turned out to have, which no audit
// document mentioned: a complete pre-multi-tenant schema (top-level orders,
// menu, customers, tables, users, settings, …) sitting alongside the current
// per-restaurant tree, plus platform trees (restaurants_meta, organizations,
// landingRequests, telegram, supportTickets, …).
//
// Deciding whether each of these is live data, abandoned legacy, or a
// duplicate mirror is a prerequisite for scoping the migration — a table that
// exists in PostgreSQL for data nobody reads is waste, and a live root that
// gets missed is silent data loss.
//
// READ-ONLY (lib/fbRead.mjs exports no mutating verb).
// Output: docs/migration-reports/firebase-legacy-roots-<stamp>.json
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initFirebase, shallowKeys, getValue, getLimited, requestCount } from "./lib/fbRead.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.join(__dirname, "../../../docs/migration-reports");

// Roots handled by firebase-discover.mjs / intentionally skipped here.
const SKIP = new Set(["restaurants", "credentials", "systemData"]);

function jsType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Newest plausible timestamp anywhere in a record — used to judge whether a
 *  root is abandoned legacy or still receiving writes. */
function newestTimestamp(obj, depth = 0) {
  if (depth > 3 || obj === null || typeof obj !== "object") return 0;
  let best = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" && /at$|time$|date$|^ts$/i.test(k)) {
      // Accept ms epochs in a sane range (2015-01-01 .. now+1y)
      if (v > 1420070400000 && v < Date.now() + 31536000000) best = Math.max(best, v);
      else if (v > 1420070400 && v < Date.now() / 1000 + 31536000) best = Math.max(best, v * 1000);
    } else if (typeof v === "string" && /at$|time$|date$/i.test(k)) {
      const p = Date.parse(v);
      if (!Number.isNaN(p) && p > 1420070400000 && p < Date.now() + 31536000000) best = Math.max(best, p);
    } else if (typeof v === "object") {
      best = Math.max(best, newestTimestamp(v, depth + 1));
    }
  }
  return best;
}

function profileRecords(entries) {
  const fields = new Map();
  let records = 0;
  let newest = 0;
  for (const [, v] of entries) {
    records++;
    newest = Math.max(newest, newestTimestamp(v));
    if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
    for (const [fk, fv] of Object.entries(v)) {
      const f = fields.get(fk) || { count: 0, types: new Set(), sample: undefined };
      f.count++;
      f.types.add(jsType(fv));
      if (f.sample === undefined) {
        f.sample =
          typeof fv === "object" && fv !== null
            ? `{${Object.keys(fv).slice(0, 6).join(",")}}`
            : typeof fv === "string" && fv.length > 60
              ? fv.slice(0, 60) + "…"
              : fv;
      }
      fields.set(fk, f);
    }
  }
  return {
    recordsSampled: records,
    newestTimestamp: newest ? new Date(newest).toISOString() : null,
    fields: Object.fromEntries(
      [...fields.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([k, f]) => [k, { count: f.count, types: [...f.types], sample: f.sample }])
    ),
  };
}

async function main() {
  console.log("Nesta ERP - legacy / non-restaurant root discovery (READ-ONLY)");
  console.log("-".repeat(70));
  initFirebase();

  const roots = (await shallowKeys("/")).filter((r) => !SKIP.has(r)).sort();
  console.log(`Inspecting ${roots.length} roots: ${roots.join(", ")}\n`);

  const out = {};
  for (const root of roots) {
    const childKeys = await shallowKeys(root);
    const entry = { childCount: childKeys.length, sampleChildKeys: childKeys.slice(0, 10) };

    if (childKeys.length === 0) {
      const v = await getValue(root);
      entry.kind = v === null ? "empty" : "scalar";
      entry.scalarValue = typeof v === "object" ? "(object)" : v;
    } else {
      const sample = await getLimited(root, Math.min(15, childKeys.length));
      const entries = Object.entries(sample || {});
      entry.kind = "collection";
      entry.profile = profileRecords(entries);
      // Is this restaurant-scoped (children are rest_* ids) or flat?
      const restLike = childKeys.filter((k) => /^rest_\d+$/.test(k)).length;
      entry.restaurantScoped = restLike > 0;
      entry.restaurantScopedChildren = restLike;
    }
    out[root] = entry;

    const age = entry.profile?.newestTimestamp
      ? `newest=${entry.profile.newestTimestamp.slice(0, 10)}`
      : "no timestamps found";
    console.log(
      `  ${root.padEnd(20)} children=${String(entry.childCount).padStart(6)}  ` +
        `${entry.restaurantScoped ? "rest-scoped" : "flat       "}  ${age}`
    );
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const p = path.join(REPORT_DIR, `firebase-legacy-roots-${stamp}.json`);
  writeFileSync(p, JSON.stringify({ generatedAt: stamp, roots: out }, null, 2), "utf8");
  writeFileSync(path.join(REPORT_DIR, "firebase-legacy-roots-latest.json"), JSON.stringify({ generatedAt: stamp, roots: out }, null, 2), "utf8");

  console.log(`\nFirebase REST reads: ${requestCount()}`);
  console.log(`Report: ${p}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
