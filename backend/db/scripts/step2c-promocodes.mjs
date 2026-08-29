// Classify root /promocodes READ-ONLY. Never writes Firebase.
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initFirebase, shallowKeys, getValue, getLimited, getPageByKey, requestCount } from "./lib/fbRead.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "../../../docs/migration-reports/step2c-root-promocodes.json");

const TENANT_FIELDS = ["restId", "restaurantId", "restaurant_id", "tenantId", "tenant", "rest_id"];

function fieldUnion(rec, into) {
  if (!rec || typeof rec !== "object") return;
  for (const k of Object.keys(rec)) into[k] = (into[k] || 0) + 1;
}

function classify(key, rec, restIds) {
  if (rec == null) return "C";
  if (typeof rec !== "object") return "C";
  if (restIds.has(key)) return "A";
  let tenant = null;
  for (const f of TENANT_FIELDS) {
    if (rec[f] != null && String(rec[f]).trim()) {
      tenant = String(rec[f]).trim();
      break;
    }
  }
  if (tenant && restIds.has(tenant)) return "A";
  if (tenant) return "D";
  const looksOperational = rec.percent != null || rec.amount != null || rec.code != null || rec.active != null;
  if (looksOperational) return "B";
  return "D";
}

async function main() {
  initFirebase();
  const restIds = new Set(await shallowKeys("restaurants"));
  const rootKeys = await shallowKeys("promocodes");
  const tenantPromoRests = [];
  let tenantPromoCount = 0;
  for (const rid of restIds) {
    const keys = await shallowKeys(`restaurants/${rid}/promocodes`).catch(() => []);
    if (keys.length) {
      tenantPromoRests.push({ restId: rid, count: keys.length });
      tenantPromoCount += keys.length;
    }
  }
  const tenantDiscountCount = [];
  let discountTotal = 0;
  for (const rid of restIds) {
    const keys = await shallowKeys(`restaurants/${rid}/discounts`).catch(() => []);
    if (keys.length) {
      tenantDiscountCount.push({ restId: rid, count: keys.length });
      discountTotal += keys.length;
    }
  }
  const platformPromo = await shallowKeys("systemData/promoCodes").catch(() => []);

  const newest = await getLimited("promocodes", 80);
  const oldest = await getPageByKey("promocodes", null, 80);
  const samples = { ...((oldest && typeof oldest === "object") ? oldest : {}), ...((newest && typeof newest === "object") ? newest : {}) };

  const fields = {};
  const classCounts = { A: 0, B: 0, C: 0, D: 0 };
  const classExamples = { A: [], B: [], C: [], D: [] };
  let objectSamples = 0;
  let primitiveSamples = 0;
  const primitiveTypes = {};
  for (const [key, rec] of Object.entries(samples)) {
    if (rec != null && typeof rec === "object") {
      objectSamples++;
      fieldUnion(rec, fields);
    } else {
      primitiveSamples++;
      const t = rec === null ? "null" : typeof rec;
      primitiveTypes[t] = (primitiveTypes[t] || 0) + 1;
    }
    const bucket = classify(key, rec, restIds);
    classCounts[bucket]++;
    if (classExamples[bucket].length < 5) {
      classExamples[bucket].push({
        key,
        valueType: rec == null ? "null" : typeof rec,
        tenantHint: rec && typeof rec === "object" ? TENANT_FIELDS.filter((f) => rec[f] != null) : [],
        fieldNames: rec && typeof rec === "object" ? Object.keys(rec).slice(0, 12) : [],
      });
    }
  }

  const runtime = {
    rootPromocodesDirectRead: "none found in application JS (no ref(db, 'promocodes'))",
    tenantPromocodesGiftPath: "client.js giftPromo reads restaurants/$restId/promocodes/$code (BASE_PATH-scoped)",
    tenantDiscountsAdmin: "admin.js loadPromocodesPanel reads restaurants/$restId/discounts",
    platformLivePromos: "superadmin.js + backend/routes/superadminMarketing.js use systemData/promoCodes",
    rootTreeLastSeenInDiscovery: "legacy-roots newest timestamp 2026-03-03 (stale vs 2026-08-29)",
  };

  const sampled = objectSamples + primitiveSamples;
  const extrapolated = {};
  if (sampled > 0) {
    for (const k of ["A", "B", "C", "D"]) {
      extrapolated[k] = Math.round((classCounts[k] / sampled) * rootKeys.length);
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    mode: "READ-ONLY",
    firebaseRequests: requestCount(),
    rootPromocodeKeys: rootKeys.length,
    tenantRestaurantPromocodes: { restaurants: tenantPromoRests.length, records: tenantPromoCount, perRestaurant: tenantPromoRests },
    tenantDiscounts: { restaurants: tenantDiscountCount.length, records: discountTotal },
    platformSystemDataPromoCodes: platformPromo.length,
    sample: {
      sampled,
      objectSamples,
      primitiveSamples,
      primitiveTypes,
      fieldUnion: fields,
      classCountsInSample: classCounts,
      classExamples,
    },
    extrapolatedFromSampleToRoot: extrapolated,
    runtime,
    decisionNote: "Live checkout/admin promo paths do not read the root /promocodes tree. Operational data is tenant discounts + systemData/promoCodes. Root tree is classified from samples; rows are not inserted into tenant tables without a defensible restId.",
  };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
  console.log(JSON.stringify({
    rootPromocodeKeys: out.rootPromocodeKeys,
    tenantRestaurantPromocodes: tenantPromoCount,
    tenantDiscounts: discountTotal,
    platformSystemDataPromoCodes: platformPromo.length,
    sampleClassCounts: classCounts,
    extrapolated,
    fieldUnion: Object.keys(fields),
  }, null, 2));
  console.log(`Wrote ${OUT}`);
}

main().catch((err) => {
  console.error("PROMOCODES CLASSIFY FAILED:", err.message);
  process.exit(1);
});
