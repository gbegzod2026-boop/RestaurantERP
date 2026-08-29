#!/usr/bin/env node
// Read-only proof that the running backend is NOT production Firebase.
// Does not mint users, tokens, or QR sessions. Never prints secrets.
const BASE = process.env.NESTA_ACCEPTANCE_BASE || "http://127.0.0.1:4000";
const PRODUCTION = "restoran-30d51";
const STAGING = "nesta-staging";

async function getJson(pathname) {
  try {
    const res = await fetch(`${BASE}${pathname}`, { headers: { Accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    return { reachable: true, status: res.status, body };
  } catch {
    return { reachable: false, status: 0, body: {} };
  }
}

function projectFrom(health, pub) {
  return (
    health.body.firebaseProjectId ||
    pub.body.firebaseProjectId ||
    pub.body.config?.projectId ||
    null
  );
}

const health = await getJson("/api/health");
const meta = await getJson("/api/pg/meta");
const pub = await getJson("/api/public/firebase-config");

const projectId = projectFrom(health, pub);
const publicProjectId = pub.body.config?.projectId || pub.body.firebaseProjectId || null;
const productionFirebase =
  health.body.productionFirebase === true ||
  pub.body.productionFirebase === true ||
  projectId === PRODUCTION ||
  publicProjectId === PRODUCTION;
const authEmulator = health.body.authEmulator === true || Boolean(pub.body.authEmulatorHost);
const isolatedAuth = health.body.isolatedAuth === true || pub.body.isolatedAuth === true;
const dataBackend = health.body.dataBackend || meta.body.dataBackend || null;
const postgresReachable = meta.body.postgresReachable === true;
const restaurantCount = Number.isFinite(meta.body.restaurantCount) ? meta.body.restaurantCount : null;
const remoteStagingAllowed = process.env.NESTA_ALLOW_REMOTE_STAGING === "1";

const report = {
  base: BASE,
  reachable: health.reachable,
  healthStatus: health.status,
  publicConfigStatus: pub.status,
  metaStatus: meta.status,
  firebaseProjectId: projectId,
  publicProjectId,
  productionFirebase,
  authEmulator,
  isolatedAuth,
  dataBackend,
  postgresReachable,
  restaurantCount,
  publicEmulatorHostSet: Boolean(pub.body.authEmulatorHost),
};

let verdict = "READY";
const blockers = [];
if (!health.reachable) {
  verdict = "NOT READY";
  blockers.push("backend_unreachable");
} else if (productionFirebase || projectId === PRODUCTION || publicProjectId === PRODUCTION) {
  verdict = "NOT READY";
  blockers.push("production_firebase");
} else if (dataBackend !== "postgres") {
  verdict = "NOT READY";
  blockers.push("data_backend_not_postgres");
} else if (!authEmulator && !remoteStagingAllowed) {
  verdict = "NOT READY";
  blockers.push("auth_emulator_missing");
} else if (!authEmulator && remoteStagingAllowed && (projectId === PRODUCTION || !projectId)) {
  verdict = "NOT READY";
  blockers.push("remote_staging_not_proven");
} else if (authEmulator && projectId !== STAGING) {
  verdict = "NOT READY";
  blockers.push("expected_nesta-staging");
} else if (!isolatedAuth) {
  verdict = "NOT READY";
  blockers.push("isolated_auth_flag_unset");
}

console.log(JSON.stringify({ verdict, blockers, ...report }, null, 2));
if (verdict !== "READY") process.exit(2);
