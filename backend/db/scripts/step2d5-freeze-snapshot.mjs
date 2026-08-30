// Step 2D.5 READ-ONLY freeze-time Firebase snapshot.
// GET only via fbRead. No Auth mutation. Requires --freeze-window.
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initFirebase, shallowKeys, getValue, requestCount } from "./lib/fbRead.mjs";
import { freezeSnapshotComplete, EXPECTED_FIREBASE_PROJECT } from "./lib/freezeSnapshot.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "../../..");

const TENANT_COLS = [
  "users", "tables", "menu", "customers", "orders", "inventory", "ingredients",
  "suppliers", "expenses", "reservations", "couriers", "customRoles", "waiterCalls",
  "notifications", "chats", "modules", "subscription", "kitchenStations",
  "modifiers", "extras", "discounts", "audit_log", "attendance",
];

function projectFromUrl(dbUrl) {
  try {
    const host = new URL(dbUrl).hostname;
    const m = host.match(/^([^.]+)\./);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function main() {
  if (!process.argv.includes("--freeze-window")) {
    console.log(JSON.stringify({
      freezeFirebaseSnapshot: "NOT RUN",
      reason: "pass --freeze-window to take a READ-ONLY freeze-time snapshot",
    }, null, 2));
    process.exit(2);
  }

  initFirebase();
  const dbUrl = process.env.FIREBASE_DATABASE_URL || "";
  const project = process.env.FIREBASE_PROJECT_ID || projectFromUrl(dbUrl);
  if (project !== EXPECTED_FIREBASE_PROJECT) {
    console.error("Refusing: Firebase project is not restoran-30d51");
    process.exit(2);
  }
  let host = "(unparseable)";
  try { host = new URL(dbUrl).host; } catch { /* ignore */ }
  if (host.includes("nesta-staging")) {
    console.error("Refusing: discovery host is not production RTDB");
    process.exit(2);
  }

  const restIds = await shallowKeys("restaurants");
  const credTrees = await shallowKeys("credentials").catch(() => []);
  const systemPromo = await shallowKeys("systemData/promoCodes").catch(() => []);
  const counts = Object.fromEntries(TENANT_COLS.map((c) => [c, 0]));
  let orderItems = 0;
  let payments = 0;

  for (const rid of restIds) {
    for (const col of TENANT_COLS) {
      const keys = await shallowKeys(`restaurants/${rid}/${col}`).catch(() => []);
      counts[col] += keys.length;
    }
    const orders = await getValue(`restaurants/${rid}/orders`).catch(() => null);
    if (!orders || typeof orders !== "object") continue;
    for (const rec of Object.values(orders)) {
      if (!rec || typeof rec !== "object") continue;
      if (rec.items && typeof rec.items === "object") orderItems += Object.keys(rec.items).length;
      if (rec.payment && typeof rec.payment === "object") payments++;
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const generatedAt = new Date().toISOString();
  const doc = {
    freezeWindow: true,
    mode: "READ-ONLY",
    generatedAt,
    firebaseProject: EXPECTED_FIREBASE_PROJECT,
    rtdbHostClass: host.replace(/^[^.]+/, "*"),
    firebaseRequests: requestCount(),
    counts: {
      restaurants: restIds.length,
      users: counts.users,
      employees: counts.users,
      orders: counts.orders,
      orderItems,
      payments,
      menu: counts.menu,
      tables: counts.tables,
      customers: counts.customers,
      credentialTrees: credTrees.length,
      customRoles: counts.customRoles,
      platformPromoCodes: systemPromo.length,
    },
    sourceRoots: ["restaurants", "credentials", "systemData/promoCodes"],
  };

  const outDir = path.join(REPO, "cutover-backups", `freeze-snapshot-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "FREEZE.json"), JSON.stringify(doc, null, 2));
  console.log(JSON.stringify({
    freezeFirebaseSnapshot: freezeSnapshotComplete(doc) ? "PASS" : "FAIL",
    generatedAt,
    firebaseProject: EXPECTED_FIREBASE_PROJECT,
    counts: doc.counts,
    artifactClass: "cutover-backups/freeze-snapshot-*/FREEZE.json",
  }, null, 2));
}

main().catch((err) => {
  console.error("FREEZE SNAPSHOT FAILED:", err.message);
  process.exit(1);
});
