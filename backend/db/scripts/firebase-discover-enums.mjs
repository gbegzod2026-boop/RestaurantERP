// db/scripts/firebase-discover-enums.mjs — Phase 1, Step 2c.
//
// Exhaustively collects EVERY distinct value of every enum-like field across
// the whole live database (not a sample), plus every money value's decimal
// shape, plus every date-key format. Phase 1 requirement #9 says unknown
// statuses must never be silently converted — that is only possible if the
// complete real-world value set is known first, which is what this produces.
//
// Unlike firebase-discover.mjs (which samples for structure), this walks every
// record of the targeted collections, because a single unmapped status string
// in one old order is exactly the kind of thing sampling misses and a CHECK
// constraint then rejects at 2am during the real migration.
//
// READ-ONLY. Output: docs/migration-reports/firebase-enums-<stamp>.json
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initFirebase, shallowKeys, getValue, mapLimit, requestCount } from "./lib/fbRead.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.join(__dirname, "../../../docs/migration-reports");

// collection -> list of dotted field paths to treat as enum-like.
// "items.*.status" means: for each child of `items`, read `.status`.
const ENUM_TARGETS = {
  orders: [
    "status", "statusKey", "statusV2", "statusLabel", "statusV2Label",
    "orderType", "deliveryType", "paymentMethod", "deliveryPaymentMethod",
    "payment.method", "payment.status", "priority", "source", "discountSource",
    "discountReason", "items.*.status", "items.*.kitchenStatus",
  ],
  tables: ["status", "tableType", "kitchenStatus"],
  users: ["role", "salaryMode"],
  reservations: ["status", "source"],
  courierAssignments: ["status", "subStage"],
  couriers: ["status", "vehicleType"],
  orderChangeRequests: ["requestType", "status"],
  menu: ["category", "subcategory", "kitchenStation"],
  expenses: ["category", "type", "paymentMethod"],
  purchaseOrders: ["status"],
  suppliers: ["status"],
  inventory: ["unit", "category"],
  ingredients: ["unit", "category"],
  customers: ["status", "loyalty", "loyaltyLevel"],
  info: ["status", "tariff", "businessType"],
  subscription: ["status", "plan"],
};

// Fields whose numeric values must be checked for money-precision problems.
const MONEY_TARGETS = {
  orders: ["total", "originalTotal", "discount", "discountAmount", "deliveryFee",
           "subtotal", "serviceFee", "fastFeeAmount", "payment.finalTotal",
           "payment.serviceFeeAmount", "items.*.price", "items.*.qty", "items.*.total"],
  menu: ["price", "originalPrice", "foodCost"],
  customers: ["totalSpent", "loyaltyPoints", "vipOrdersTotal"],
  expenses: ["amount"],
  inventory: ["stock", "price", "cost"],
  ingredients: ["stock", "price", "cost"],
};

function getPath(obj, dotted) {
  const parts = dotted.split(".");
  let cur = [obj];
  for (const part of parts) {
    const next = [];
    for (const c of cur) {
      if (c === null || typeof c !== "object") continue;
      if (part === "*") {
        for (const v of Object.values(c)) next.push(v);
      } else if (part in c) {
        next.push(c[part]);
      }
    }
    cur = next;
    if (!cur.length) return [];
  }
  return cur;
}

function decimalsOf(n) {
  const s = String(n);
  if (s.includes("e") || s.includes("E")) return -1; // exponential
  const d = s.indexOf(".");
  return d === -1 ? 0 : s.length - d - 1;
}

async function main() {
  console.log("Nesta ERP - exhaustive enum / money / key-format scan (READ-ONLY)");
  console.log("-".repeat(70));
  initFirebase();

  const restIds = await shallowKeys("restaurants");
  console.log(`Scanning ${restIds.length} restaurants (full read of targeted collections)…\n`);

  const enums = {};   // "collection.field" -> {value: count}
  const money = {};   // "collection.field" -> {count, decimals:{n:count}, min, max, examples:[]}
  const keyFormats = {}; // "collection" -> {format: count}
  const scanned = {}; // collection -> record count
  const anomalies = [];

  const noteEnum = (key, val) => {
    if (val === null || val === undefined) return;
    const s = typeof val === "string" ? val : JSON.stringify(val);
    if (s.length > 80) return;
    const b = (enums[key] ||= {});
    b[s] = (b[s] || 0) + 1;
  };

  const noteMoney = (key, val, ctx) => {
    if (typeof val !== "number" || !Number.isFinite(val)) {
      if (val !== null && val !== undefined && val !== "") {
        anomalies.push({ severity: "warn", field: key, issue: "non_numeric_money", value: String(val).slice(0, 60), ctx });
      }
      return;
    }
    const m = (money[key] ||= { count: 0, decimals: {}, min: Infinity, max: -Infinity, negatives: 0, examplesOver2dp: [] });
    m.count++;
    m.min = Math.min(m.min, val);
    m.max = Math.max(m.max, val);
    if (val < 0) m.negatives++;
    const d = decimalsOf(val);
    m.decimals[d] = (m.decimals[d] || 0) + 1;
    if (d > 2 || d === -1) {
      if (m.examplesOver2dp.length < 8) m.examplesOver2dp.push({ value: val, ctx });
    }
  };

  const COLLECTIONS = [...new Set([...Object.keys(ENUM_TARGETS), ...Object.keys(MONEY_TARGETS)])];

  let done = 0;
  await mapLimit(restIds, 5, async (rid) => {
    for (const col of COLLECTIONS) {
      let node;
      try {
        node = await getValue(`restaurants/${rid}/${col}`);
      } catch (e) {
        anomalies.push({ severity: "error", field: `${col}`, issue: "read_failed", value: e.message, ctx: rid });
        continue;
      }
      if (node === null || typeof node !== "object") continue;

      // `info` and `subscription` are single objects, not collections.
      const isSingleton = col === "info" || col === "subscription";
      const records = isSingleton ? [[rid, node]] : Object.entries(node);

      scanned[col] = (scanned[col] || 0) + records.length;

      for (const [key, rec] of records) {
        if (!isSingleton) {
          const kf = (keyFormats[col] ||= {});
          const fmt = /^-[A-Za-z0-9_-]{18,19}$/.test(key) ? "push_id"
            : /^\d{4}-\d{2}-\d{2}$/.test(key) ? "date_ymd"
            : /^\d{4}-\d{2}$/.test(key) ? "month_ym"
            : /^\d+$/.test(key) ? "numeric"
            : /^(%2B|\+)?\d[\d%A-Fa-f]{6,}$/.test(key) ? "phone_like"
            : /^[a-zA-Z]+[_-]/.test(key) ? "prefixed_id"
            : "other";
          kf[fmt] = (kf[fmt] || 0) + 1;
        }
        if (rec === null || typeof rec !== "object") continue;

        for (const f of ENUM_TARGETS[col] || []) {
          for (const v of getPath(rec, f)) noteEnum(`${col}.${f}`, v);
        }
        for (const f of MONEY_TARGETS[col] || []) {
          for (const v of getPath(rec, f)) noteMoney(`${col}.${f}`, v, `${rid}/${col}/${key}`);
        }
      }
    }
    done++;
    process.stdout.write(`\r  scanned ${done}/${restIds.length} restaurants…`);
  });
  process.stdout.write("\n\n");

  // Clean up money min/max for untouched entries
  for (const m of Object.values(money)) {
    if (m.min === Infinity) m.min = null;
    if (m.max === -Infinity) m.max = null;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "READ-ONLY exhaustive enum/money scan",
    restaurantsScanned: restIds.length,
    recordsScannedPerCollection: scanned,
    keyFormats,
    enums,
    money,
    anomalies,
    firebaseRequests: requestCount(),
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  writeFileSync(path.join(REPORT_DIR, `firebase-enums-${stamp}.json`), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(path.join(REPORT_DIR, "firebase-enums-latest.json"), JSON.stringify(report, null, 2), "utf8");

  // ── console output ──
  console.log("DISTINCT ENUM VALUES (complete, not sampled)");
  for (const [k, vals] of Object.entries(enums).sort()) {
    const entries = Object.entries(vals).sort((a, b) => b[1] - a[1]);
    console.log(`\n  ${k}  (${entries.length} distinct)`);
    for (const [v, c] of entries) console.log(`      ${String(c).padStart(5)}x  ${JSON.stringify(v)}`);
  }

  console.log("\n\nMONEY PRECISION");
  for (const [k, m] of Object.entries(money).sort()) {
    const dec = Object.entries(m.decimals).sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([d, c]) => `${d}dp:${c}`).join(" ");
    const flag = m.examplesOver2dp.length ? "  <<< >2dp PRESENT" : "";
    console.log(`  ${k.padEnd(34)} n=${String(m.count).padStart(5)} [${dec}] min=${m.min} max=${m.max} neg=${m.negatives}${flag}`);
    for (const ex of m.examplesOver2dp.slice(0, 3)) console.log(`        e.g. ${ex.value}  @ ${ex.ctx}`);
  }

  console.log("\n\nKEY FORMATS");
  for (const [k, v] of Object.entries(keyFormats).sort()) console.log(`  ${k.padEnd(22)} ${JSON.stringify(v)}`);

  console.log(`\n\nAnomalies: ${anomalies.length}`);
  for (const a of anomalies.slice(0, 20)) console.log(`  [${a.severity}] ${a.field}: ${a.issue} ${JSON.stringify(a.value)} @ ${a.ctx || ""}`);

  console.log(`\nFirebase REST reads: ${requestCount()}`);
  process.exit(0);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
