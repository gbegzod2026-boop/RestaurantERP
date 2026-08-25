// db/scripts/firebase-discover.mjs — Phase 1, Step 2: build the REAL RTDB
// inventory by walking the production database, not by trusting docs.
//
// READ-ONLY. Every Firebase call goes through lib/fbRead.mjs, which exports
// no mutating verb at all. This script writes only to
// docs/migration-reports/.
//
// What it produces:
//   1. The true set of root keys (several documented ones turn out not to
//      exist at all).
//   2. Per restaurant: which collections exist and how many children each has.
//   3. Per collection type (aggregated across all restaurants): a field
//      profile — every field name ever seen, its JS types, fill rate, and
//      sample values. This is what the schema is designed against.
//   4. Key-format classification per collection (push-id / numeric / date /
//      phone / other), which drives the legacy_rtdb_id and date-key
//      normalization decisions.
//
// Usage:  node db/scripts/firebase-discover.mjs [--samples=40] [--full-count]
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  initFirebase,
  shallowKeys,
  getValue,
  getLimited,
  mapLimit,
  requestCount,
} from "./lib/fbRead.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.join(__dirname, "../../../docs/migration-reports");

const args = process.argv.slice(2);
const SAMPLES_PER_COLLECTION = Number(
  (args.find((a) => a.startsWith("--samples=")) || "--samples=40").split("=")[1]
);
const FULL_COUNT = args.includes("--full-count");

// Root keys the rules file / audit docs claim exist. Probed explicitly so the
// report can say "documented but absent" rather than silently omitting them.
const DOCUMENTED_ROOTS = [
  "restaurants",
  "credentials",
  "systemData",
  "restaurantsIndex",
  "superadmin",
  "discountClaims",
];

// ─── Key-format classification ────────────────────────────────────────────
const RE_PUSH_ID = /^-[A-Za-z0-9_-]{18,19}$/;
const RE_NUMERIC = /^\d+$/;
const RE_DATE_YMD = /^\d{4}-\d{2}-\d{2}$/;
const RE_MONTH_YM = /^\d{4}-\d{2}$/;
const RE_PREFIXED = /^[a-zA-Z]+[_-].+$/;
const RE_PHONE_ENC = /^(%2B|\+)?\d[\d%A-Fa-f]*$/;

function classifyKey(k) {
  if (RE_PUSH_ID.test(k)) return "push_id";
  if (RE_DATE_YMD.test(k)) return "date_ymd";
  if (RE_MONTH_YM.test(k)) return "month_ym";
  if (RE_NUMERIC.test(k)) return "numeric";
  if (RE_PHONE_ENC.test(k) && k.replace(/%2B|\+/g, "").length >= 7) return "phone_like";
  if (RE_PREFIXED.test(k)) return "prefixed_id";
  return "other";
}

function jsType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Detects money-shaped floating point trouble: more than 2 decimal places,
 *  or a value that does not survive a round-trip through cents. */
function moneyAnomaly(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const s = String(v);
  if (s.includes("e") || s.includes("E")) return "exponential";
  const dot = s.indexOf(".");
  if (dot === -1) return null;
  const decimals = s.length - dot - 1;
  if (decimals > 2) return `decimals_${decimals}`;
  return null;
}

// ─── Field profiler ───────────────────────────────────────────────────────
class Profile {
  constructor() {
    this.records = 0;
    this.fields = new Map(); // name -> {count, types:Set, samples:[], moneyAnomalies:[], maxLen}
    this.keyFormats = new Map();
    this.nonObjectRecords = 0;
  }

  addKey(k) {
    const f = classifyKey(k);
    this.keyFormats.set(f, (this.keyFormats.get(f) || 0) + 1);
  }

  addRecord(rec) {
    this.records++;
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
      this.nonObjectRecords++;
      return;
    }
    for (const [k, v] of Object.entries(rec)) {
      let f = this.fields.get(k);
      if (!f) {
        f = { count: 0, types: new Set(), samples: [], moneyAnomalies: [], maxLen: 0, childKeys: new Set() };
        this.fields.set(k, f);
      }
      f.count++;
      f.types.add(jsType(v));
      if (typeof v === "string" && v.length > f.maxLen) f.maxLen = v.length;
      const ma = moneyAnomaly(v);
      if (ma && f.moneyAnomalies.length < 5) f.moneyAnomalies.push({ value: v, issue: ma });
      if (f.samples.length < 4) {
        let s = v;
        if (typeof v === "object" && v !== null) {
          const keys = Object.keys(v);
          keys.slice(0, 12).forEach((ck) => f.childKeys.add(ck));
          s = Array.isArray(v) ? `[array len=${v.length}]` : `{${keys.slice(0, 8).join(",")}}`;
        } else if (typeof v === "string" && v.length > 80) {
          s = v.slice(0, 80) + "…";
        }
        if (!f.samples.some((x) => JSON.stringify(x) === JSON.stringify(s))) f.samples.push(s);
      }
    }
  }

  toJSON() {
    const fields = {};
    for (const [name, f] of [...this.fields.entries()].sort((a, b) => b[1].count - a[1].count)) {
      fields[name] = {
        fillRate: this.records ? Number((f.count / this.records).toFixed(3)) : 0,
        count: f.count,
        types: [...f.types].sort(),
        samples: f.samples,
        ...(f.childKeys.size ? { childKeys: [...f.childKeys].slice(0, 20) } : {}),
        ...(f.maxLen ? { maxStringLen: f.maxLen } : {}),
        ...(f.moneyAnomalies.length ? { moneyAnomalies: f.moneyAnomalies } : {}),
      };
    }
    return {
      recordsSampled: this.records,
      nonObjectRecords: this.nonObjectRecords,
      keyFormats: Object.fromEntries([...this.keyFormats.entries()].sort((a, b) => b[1] - a[1])),
      fields,
    };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = new Date().toISOString();
  console.log("Nesta ERP — Firebase RTDB discovery (READ-ONLY)");
  console.log("─".repeat(70));
  initFirebase();

  // 1. Root keys
  const actualRoots = await shallowKeys("/");
  console.log(`Root keys actually present: ${actualRoots.join(", ") || "(none)"}`);
  const rootStatus = {};
  for (const r of DOCUMENTED_ROOTS) {
    rootStatus[r] = actualRoots.includes(r) ? "present" : "ABSENT (documented but no data)";
  }
  for (const r of actualRoots) {
    if (!DOCUMENTED_ROOTS.includes(r)) rootStatus[r] = "present (undocumented)";
  }

  // 2. Restaurants
  const restIds = await shallowKeys("restaurants");
  console.log(`Restaurants discovered: ${restIds.length}`);

  // 3. Per-restaurant collection enumeration
  const perRestaurant = {};
  const collectionTotals = new Map(); // collection -> {restaurants, totalChildren}
  let done = 0;

  await mapLimit(restIds, 6, async (restId) => {
    const cols = await shallowKeys(`restaurants/${restId}`);
    const entry = { collections: {}, collectionCount: cols.length };
    // Count children per collection (shallow — keys only, no subtree download)
    await mapLimit(cols, 6, async (col) => {
      let keys = [];
      try {
        keys = await shallowKeys(`restaurants/${restId}/${col}`);
      } catch {
        keys = [];
      }
      entry.collections[col] = keys.length;
      const agg = collectionTotals.get(col) || { restaurants: 0, totalChildren: 0 };
      agg.restaurants++;
      agg.totalChildren += keys.length;
      collectionTotals.set(col, agg);
    });
    perRestaurant[restId] = entry;
    done++;
    if (done % 5 === 0 || done === restIds.length) {
      process.stdout.write(`\r  enumerated ${done}/${restIds.length} restaurants…`);
    }
  });
  process.stdout.write("\n");

  const collectionNames = [...collectionTotals.keys()].sort();
  console.log(`Distinct collections under restaurants/$restId: ${collectionNames.length}`);

  // 4. Field profiling per collection, sampled across restaurants
  const profiles = {};
  // Nested collections worth profiling one level deeper (date-keyed / grouped)
  const NESTED = {
    chefTasks: 1,
    prepSchedule: 1,
    chats: 1,
    finance: 1,
    attendance: 0,
    wasteLog: 0,
  };

  let ci = 0;
  for (const col of collectionNames) {
    ci++;
    process.stdout.write(`\r  profiling ${ci}/${collectionNames.length}: ${col.padEnd(28)}`);
    const prof = new Profile();
    const nestedProf = NESTED[col] ? new Profile() : null;

    // Restaurants that actually have this collection, richest first
    const owners = restIds
      .filter((r) => (perRestaurant[r].collections[col] || 0) > 0)
      .sort((a, b) => perRestaurant[b].collections[col] - perRestaurant[a].collections[col]);

    let collected = 0;
    for (const restId of owners) {
      if (collected >= SAMPLES_PER_COLLECTION) break;
      const need = Math.min(SAMPLES_PER_COLLECTION - collected, 20);
      let batch = null;
      try {
        batch = await getLimited(`restaurants/${restId}/${col}`, need);
      } catch {
        continue;
      }
      if (!batch || typeof batch !== "object") continue;
      for (const [k, v] of Object.entries(batch)) {
        prof.addKey(k);
        prof.addRecord(v);
        collected++;
        if (nestedProf && v && typeof v === "object" && !Array.isArray(v)) {
          for (const [nk, nv] of Object.entries(v).slice(0, 6)) {
            nestedProf.addKey(nk);
            nestedProf.addRecord(nv);
          }
        }
      }
    }
    profiles[col] = prof.toJSON();
    profiles[col].restaurantsWithCollection = collectionTotals.get(col).restaurants;
    profiles[col].totalChildrenAcrossRestaurants = collectionTotals.get(col).totalChildren;
    if (nestedProf && nestedProf.records) profiles[col].nestedLevel2 = nestedProf.toJSON();
  }
  process.stdout.write("\n");

  // 5. credentials/ tree
  const credRestIds = await shallowKeys("credentials");
  const credProfile = new Profile();
  for (const rid of credRestIds.slice(0, 12)) {
    const users = await shallowKeys(`credentials/${rid}`);
    for (const uid of users.slice(0, 6)) {
      const v = await getValue(`credentials/${rid}/${uid}`);
      credProfile.addKey(uid);
      credProfile.addRecord(v);
    }
  }

  // 6. systemData tree
  const sysKeys = await shallowKeys("systemData");
  const systemData = {};
  for (const k of sysKeys) {
    try {
      const childKeys = await shallowKeys(`systemData/${k}`);
      systemData[k] = { childCount: childKeys.length, sampleChildKeys: childKeys.slice(0, 12) };
    } catch (e) {
      systemData[k] = { error: e.message };
    }
  }

  // 7. Assemble report
  const report = {
    generatedAt: startedAt,
    finishedAt: new Date().toISOString(),
    mode: "READ-ONLY discovery",
    firebaseRequests: requestCount(),
    samplesPerCollection: SAMPLES_PER_COLLECTION,
    rootKeys: { actual: actualRoots, status: rootStatus },
    restaurants: {
      count: restIds.length,
      ids: restIds,
      perRestaurant,
    },
    collections: {
      count: collectionNames.length,
      names: collectionNames,
      totals: Object.fromEntries(
        [...collectionTotals.entries()]
          .sort((a, b) => b[1].totalChildren - a[1].totalChildren)
          .map(([k, v]) => [k, v])
      ),
    },
    profiles,
    credentials: {
      restaurantCount: credRestIds.length,
      profile: credProfile.toJSON(),
    },
    systemData,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-");
  const outPath = path.join(REPORT_DIR, `firebase-discovery-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  const latestPath = path.join(REPORT_DIR, "firebase-discovery-latest.json");
  writeFileSync(latestPath, JSON.stringify(report, null, 2), "utf8");

  // 8. Console summary
  console.log("─".repeat(70));
  console.log(`Restaurants: ${restIds.length}`);
  console.log(`Collections: ${collectionNames.length}`);
  console.log(`Firebase REST reads: ${requestCount()}`);
  console.log("\nTop collections by total child records:");
  [...collectionTotals.entries()]
    .sort((a, b) => b[1].totalChildren - a[1].totalChildren)
    .slice(0, 30)
    .forEach(([name, v]) => {
      console.log(
        `  ${name.padEnd(26)} ${String(v.totalChildren).padStart(8)} records  in ${v.restaurants} restaurants`
      );
    });
  console.log(`\nReport: ${outPath}`);
  console.log(`Latest: ${latestPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nDISCOVERY FAILED:", err);
  process.exit(1);
});
