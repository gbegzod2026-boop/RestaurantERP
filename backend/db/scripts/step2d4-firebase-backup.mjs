// Step 2D.4 — READ-ONLY production RTDB backup + structural restore validation.
// Uses fbRead GET only. Never writes Firebase. Never prints hashes, phones, or URLs.
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { initFirebase, shallowKeys, getValue, requestCount } from "./lib/fbRead.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "../../..");
const BACKEND = path.join(__dirname, "../..");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = path.join(REPO, "cutover-backups", `firebase-${STAMP}`);

const REQUIRED_ROOTS = [
  "restaurants",
  "credentials",
  "restaurants_meta",
  "systemData",
];

const TENANT_COLLECTIONS = ["users", "menu", "orders", "payments"];

const PLATFORM_HINTS = [
  "organizations",
  "telegram",
  "landingRequests",
  "supportTickets",
  "promocodes",
  "discountClaims",
];

function sha256File(filePath) {
  const h = crypto.createHash("sha256");
  h.update(readFileSync(filePath));
  return h.digest("hex");
}

function projectIdentity() {
  const fromEnv = String(process.env.FIREBASE_PROJECT_ID || "").trim();
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    || path.join(BACKEND, "serviceAccountKey.json");
  let fromSa = null;
  if (existsSync(saPath)) {
    try {
      fromSa = JSON.parse(readFileSync(saPath, "utf8")).project_id || null;
    } catch { fromSa = null; }
  }
  const dbUrl = String(process.env.FIREBASE_DATABASE_URL || "");
  let hostClass = "(unset)";
  try {
    if (dbUrl) hostClass = new URL(dbUrl).hostname.replace(/^[^.]+/, "*");
  } catch { hostClass = "(unparseable)"; }
  return {
    firebaseProjectId: fromEnv || fromSa || "(unknown)",
    rtdbHostClass: hostClass,
    serviceAccountPresent: existsSync(saPath),
  };
}

function countNestedPayments(restaurantObj) {
  let orderPayments = 0;
  let restaurantsWith = 0;
  if (!restaurantObj || typeof restaurantObj !== "object") {
    return { orderPayments, restaurantsWith };
  }
  for (const rest of Object.values(restaurantObj)) {
    const orders = rest && typeof rest === "object" ? rest.orders : null;
    if (!orders || typeof orders !== "object") continue;
    let hit = false;
    for (const order of Object.values(orders)) {
      if (!order || typeof order !== "object") continue;
      if (order.payments && typeof order.payments === "object") {
        orderPayments += Object.keys(order.payments).length;
        hit = true;
      } else if (order.payment != null) {
        orderPayments += 1;
        hit = true;
      }
    }
    if (hit) restaurantsWith += 1;
  }
  return { orderPayments, restaurantsWith };
}

function summarize(value) {
  if (value == null) return { present: false, type: "null", keyCount: 0 };
  if (Array.isArray(value)) return { present: true, type: "array", keyCount: value.length };
  if (typeof value !== "object") return { present: true, type: typeof value, keyCount: 0 };
  return { present: true, type: "object", keyCount: Object.keys(value).length };
}

async function main() {
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  delete process.env.NESTA_REQUIRE_ISOLATED_AUTH;
  if (process.argv[2] === "--validate") {
    const dir = process.argv[3];
    if (!dir || !existsSync(path.join(dir, "restaurants.json"))) {
      throw new Error("usage: step2d4-firebase-backup.mjs --validate <backup-dir>");
    }
    const restaurantObj = JSON.parse(readFileSync(path.join(dir, "restaurants.json"), "utf8"));
    const restaurantKeys = restaurantObj && typeof restaurantObj === "object" ? Object.keys(restaurantObj) : [];
    const nestedPayments = countNestedPayments(restaurantObj);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    let parsed = 0;
    for (const f of files) {
      JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      parsed += 1;
    }
    const requiredOk = REQUIRED_ROOTS.every((r) => existsSync(path.join(dir, `${r}.json`)));
    const paymentsOk = nestedPayments.orderPayments > 0;
    const ok = requiredOk && restaurantKeys.length > 0 && paymentsOk && parsed === files.length;
    console.log(JSON.stringify({
      firebaseBackup: ok ? "PASS" : "FAIL",
      restoreValidation: ok ? "PASS_STRUCTURAL" : "FAIL",
      restaurantCount: restaurantKeys.length,
      nestedOrderPayments: nestedPayments.orderPayments,
      filesParsed: parsed,
      liveFirebaseRestore: "NOT PERFORMED",
    }, null, 2));
    if (!ok) process.exit(1);
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  initFirebase();
  const identity = projectIdentity();
  const rootKeys = await shallowKeys("");
  const coverage = {};
  const files = [];

  const toExport = [...new Set([...REQUIRED_ROOTS, ...PLATFORM_HINTS, ...rootKeys])];
  for (const root of toExport) {
    const value = await getValue(root);
    const file = path.join(OUT_DIR, `${root}.json`);
    writeFileSync(file, JSON.stringify(value));
    const st = statSync(file);
    coverage[root] = {
      ...summarize(value),
      bytes: st.size,
      sha256: sha256File(file),
      required: REQUIRED_ROOTS.includes(root),
    };
    files.push(path.basename(file));
  }

  const missingRequired = REQUIRED_ROOTS.filter((r) => !coverage[r]?.present);
  const restaurantObj = coverage.restaurants?.present
    ? JSON.parse(readFileSync(path.join(OUT_DIR, "restaurants.json"), "utf8"))
    : null;
  const restaurantKeys = restaurantObj && typeof restaurantObj === "object" ? Object.keys(restaurantObj) : [];
  const tenantCoverage = {};
  for (const col of TENANT_COLLECTIONS) {
    const atRoot = coverage[col]?.present && coverage[col].keyCount > 0;
    let inTenants = 0;
    if (restaurantObj && typeof restaurantObj === "object") {
      for (const id of restaurantKeys) {
        const node = restaurantObj[id];
        if (node && typeof node === "object" && node[col] && typeof node[col] === "object") inTenants += 1;
      }
    }
    tenantCoverage[col] = { atRoot: Boolean(atRoot), restaurantsWithCollection: inTenants };
  }
  const nestedPayments = countNestedPayments(restaurantObj);
  tenantCoverage.payments.nestedOrderPayments = nestedPayments.orderPayments;
  tenantCoverage.payments.restaurantsWithNestedPayments = nestedPayments.restaurantsWith;
  const missingTenant = TENANT_COLLECTIONS.filter((c) => {
    if (c === "payments") {
      return !tenantCoverage.payments.atRoot
        && tenantCoverage.payments.restaurantsWithCollection === 0
        && nestedPayments.orderPayments === 0;
    }
    return !tenantCoverage[c].atRoot && tenantCoverage[c].restaurantsWithCollection === 0;
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    backupDirClass: "cutover-backups/firebase-* (gitignored)",
    backupStamp: STAMP,
    identity,
    firebaseWrites: 0,
    authMutations: 0,
    method: "fbRead REST GET only",
    rootKeys,
    requiredRoots: REQUIRED_ROOTS,
    missingRequired,
    tenantCoverage,
    missingTenantCollections: missingTenant,
    coverage,
    restaurantCount: restaurantKeys.length,
    requestCount: requestCount(),
    files,
  };
  writeFileSync(path.join(OUT_DIR, "MANIFEST.json"), JSON.stringify(manifest, null, 2));

  const structural = {
    manifestReadable: true,
    jsonFilesParsed: 0,
    requiredPresent: REQUIRED_ROOTS.filter((r) => coverage[r]?.present),
    requiredMissing: missingRequired,
    restaurantCount: restaurantKeys.length,
    credentialsTrees: coverage.credentials?.keyCount || 0,
    restaurantsMetaKeys: coverage.restaurants_meta?.keyCount || 0,
    liveRestoreToFirebase: "NOT PERFORMED (would be a production write)",
  };
  for (const f of files) {
    JSON.parse(readFileSync(path.join(OUT_DIR, f), "utf8"));
    structural.jsonFilesParsed += 1;
  }
  const backupOk = missingRequired.length === 0 && restaurantKeys.length > 0 && missingTenant.length === 0;
  const restoreOk = structural.jsonFilesParsed === files.length && backupOk;
  const report = {
    firebaseBackup: backupOk ? "PASS" : "FAIL",
    restoreValidation: restoreOk ? "PASS_STRUCTURAL" : "FAIL",
    identity,
    backupStamp: STAMP,
    restaurantCount: restaurantKeys.length,
    missingRequired,
    missingTenantCollections: missingTenant,
    tenantCoverage,
    requestCount: requestCount(),
    gitignoredDir: true,
    liveFirebaseRestore: "NOT PERFORMED",
  };
  console.log(JSON.stringify(report, null, 2));
  if (!backupOk || !restoreOk) process.exit(1);
}

main().catch((err) => {
  console.error("FIREBASE BACKUP FAILED:", err.message);
  process.exit(1);
});
