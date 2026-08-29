// Step 2A — READ-ONLY re-check of previously observed production source issues.
// Uses lib/fbRead.mjs only (GET). Writes gitignored JSON under docs/migration-reports/.
// Never prints names, phones, hashes, tokens, or restaurant display names.
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initFirebase, shallowKeys, getValue, requestCount } from "./lib/fbRead.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.join(__dirname, "../../../docs/migration-reports");

function isPushId(k) {
  return typeof k === "string" && /^-[A-Za-z0-9_-]{18,19}$/.test(k);
}

async function main() {
  console.log("STEP 2A source-issue re-check — READ-ONLY");
  initFirebase();
  const dbUrl = process.env.FIREBASE_DATABASE_URL || "";
  const host = (() => {
    try { return new URL(dbUrl).host; } catch { return "(unparseable)"; }
  })();
  if (host.includes("nesta-staging") || !host) {
    console.error("Refusing: discovery host is not production RTDB:", host || "(empty)");
    process.exit(2);
  }
  console.log(`RTDB host class: ${host.replace(/^[^.]+/, "*")}`);

  const restIds = await shallowKeys("restaurants");
  const metaIds = await shallowKeys("restaurants_meta").catch(() => []);
  const credIds = await shallowKeys("credentials").catch(() => []);
  const discountKeys = await shallowKeys("discountClaims").catch(() => []);
  const promoKeys = await shallowKeys("promocodes").catch(() => []);
  const rootKeys = await shallowKeys("/").catch(() => []);

  const metaOrphans = metaIds.filter((id) => !restIds.includes(id));
  const restMissingMeta = restIds.filter((id) => !metaIds.includes(id));

  let metaFuture = 0;
  let metaMaxIso = null;
  let metaMaxMs = 0;
  for (const id of metaIds) {
    const rec = await getValue(`restaurants_meta/${id}`).catch(() => null);
    if (!rec || typeof rec !== "object") continue;
    const candidates = [
      rec.updatedAt, rec.createdAt, rec.info?.updatedAt,
      rec.subscription?.expireAt, rec.subscription?.expireDate,
    ];
    for (const v of candidates) {
      const n = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
      if (!Number.isFinite(n)) continue;
      if (n > metaMaxMs) {
        metaMaxMs = n;
        metaMaxIso = new Date(n).toISOString();
      }
      if (n > Date.now() + 24 * 3600 * 1000) metaFuture++;
    }
  }

  const roleIssues = { empty: 0, pushId: 0, otherNonCanonical: 0, totalUsers: 0 };
  const CANON = new Set(["admin", "owner", "manager", "waiter", "chef", "cashier", "courier", "kassa"]);
  for (const restId of restIds) {
    const users = await getValue(`restaurants/${restId}/users`).catch(() => null);
    if (!users || typeof users !== "object") continue;
    for (const u of Object.values(users)) {
      if (!u || typeof u !== "object") continue;
      roleIssues.totalUsers++;
      const role = u.role;
      if (role == null || role === "") roleIssues.empty++;
      else if (isPushId(String(role))) roleIssues.pushId++;
      else if (!CANON.has(String(role))) roleIssues.otherNonCanonical++;
    }
  }

  let orders = 0;
  let waiterMissing = 0;
  let chefMissing = 0;
  let createdByMissing = 0;
  for (const restId of restIds) {
    const users = await getValue(`restaurants/${restId}/users`).catch(() => null) || {};
    const userIds = new Set(Object.keys(users));
    const orderMap = await getValue(`restaurants/${restId}/orders`).catch(() => null);
    if (!orderMap || typeof orderMap !== "object") continue;
    for (const rec of Object.values(orderMap)) {
      if (!rec || typeof rec !== "object") continue;
      orders++;
      if (rec.waiterId && !userIds.has(String(rec.waiterId))) waiterMissing++;
      if (rec.chefId && !userIds.has(String(rec.chefId))) chefMissing++;
      if (rec.createdByWaiterId && !userIds.has(String(rec.createdByWaiterId))) createdByMissing++;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "READ-ONLY",
    firebaseRequests: requestCount(),
    restaurants: restIds.length,
    restaurants_meta: metaIds.length,
    credentialsRestaurants: credIds.length,
    metaOrphanCount: metaOrphans.length,
    restaurantsMissingMeta: restMissingMeta.length,
    metaMaxTimestamp: metaMaxIso,
    metaFutureDatedRecords: metaFuture,
    discountClaimsChildCount: discountKeys.length,
    rootPromocodesChildCount: promoKeys.length,
    rootKeyCount: rootKeys.length,
    rootKeys,
    roleIssues,
    orderEmployeeRefs: {
      orders,
      waiterMissing,
      chefMissing,
      createdByMissing,
    },
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  const out = path.join(REPORT_DIR, "step2a-source-issues-latest.json");
  writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${out} (gitignored)`);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
