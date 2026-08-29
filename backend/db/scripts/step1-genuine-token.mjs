#!/usr/bin/env node
// Genuine Firebase token proof against isolated Auth (emulator/staging).
// Never prints tokens, passwords, or cookies. Requires NESTA_REQUIRE_ISOLATED_AUTH
// already proven by /api/health (productionFirebase=false).
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithCustomToken, signOut } from "firebase/auth";

const BASE = process.env.NESTA_ACCEPTANCE_BASE || "http://127.0.0.1:4000";
const loginName = process.env.NESTA_ACCEPTANCE_MANAGER_LOGIN || "step1_admin_a";
const password = process.env.NESTA_ACCEPTANCE_ADMIN_A_PASSWORD || "";
const restA = "rest_1999000000001";
const restB = "rest_1999000000002";

if (!password) {
  console.error("[genuine-token] NESTA_ACCEPTANCE_ADMIN_A_PASSWORD is required");
  process.exit(2);
}

function summarize(obj) {
  return {
    firebaseProjectId: obj.firebaseProjectId,
    productionFirebase: obj.productionFirebase,
    authEmulator: obj.authEmulator,
    isolatedAuth: obj.isolatedAuth,
    dataBackend: obj.dataBackend,
    restaurantCount: obj.restaurantCount,
  };
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
if (health.productionFirebase === true || health.firebaseProjectId === "restoran-30d51") {
  console.error("[genuine-token] STOP: runtime Firebase project is production");
  process.exit(2);
}
if (health.firebaseProjectId !== "nesta-staging") {
  console.error("[genuine-token] STOP: expected nesta-staging");
  process.exit(2);
}

const pub = await fetch(`${BASE}/api/public/firebase-config`).then((r) => r.json());
if (pub.productionFirebase === true || pub.config?.projectId === "restoran-30d51") {
  console.error("[genuine-token] STOP: public config is production");
  process.exit(2);
}

const loginRes = await fetch(`${BASE}/api/auth/manager-login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ login: loginName, password }),
});
const loginBody = await loginRes.json().catch(() => ({}));
if (!loginRes.ok || !loginBody.token) {
  console.error("[genuine-token] manager-login failed", loginRes.status, loginBody.code || loginBody.error || "");
  process.exit(1);
}

const app = initializeApp(pub.config);
const auth = getAuth(app);
if (pub.authEmulatorHost) {
  connectAuthEmulator(auth, pub.authEmulatorHost, { disableWarnings: true });
}
await signInWithCustomToken(auth, loginBody.token);
const idToken = await auth.currentUser.getIdToken();
const uid = auth.currentUser.uid;

const own = await fetch(`${BASE}/api/pg/rtdb/get`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${idToken}`,
    "Content-Type": "application/json",
    "x-rest-id": restA,
  },
  body: JSON.stringify({ path: `restaurants/${restA}/settings` }),
});
const ownBody = await own.json().catch(() => ({}));

const foreign = await fetch(`${BASE}/api/pg/rtdb/get`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${idToken}`,
    "Content-Type": "application/json",
    "x-rest-id": restB,
  },
  body: JSON.stringify({ path: `restaurants/${restB}/settings` }),
});
const foreignBody = await foreign.json().catch(() => ({}));

const refreshed = await auth.currentUser.getIdToken(true);
const afterRefresh = await fetch(`${BASE}/api/pg/rtdb/get`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${refreshed}`,
    "Content-Type": "application/json",
    "x-rest-id": restA,
  },
  body: JSON.stringify({ path: `restaurants/${restA}/menu` }),
});
const refreshBody = await afterRefresh.json().catch(() => ({}));

await signOut(auth);
const afterLogout = await fetch(`${BASE}/api/pg/rtdb/get`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${idToken}`,
    "Content-Type": "application/json",
    "x-rest-id": restA,
  },
  body: JSON.stringify({ path: `restaurants/${restA}/settings` }),
});

console.log(JSON.stringify({
  health: summarize(health),
  publicProject: pub.config?.projectId,
  publicEmulator: Boolean(pub.authEmulatorHost),
  loginStatus: loginRes.status,
  loginRestId: loginBody.restId,
  loginUserId: loginBody.user?.id,
  loginRole: loginBody.user?.role,
  uidPrefix: String(uid).startsWith(`${restA}__`) ? "canonical_composite" : "unexpected",
  ownGet: { status: own.status, code: ownBody.code || null, hasValue: ownBody.value != null },
  foreignGet: { status: foreign.status, code: foreignBody.code || null },
  refreshGet: { status: afterRefresh.status, code: refreshBody.code || null, hasValue: refreshBody.value != null },
  staleTokenAfterSignOut: { status: afterLogout.status, code: (await afterLogout.json().catch(() => ({}))).code || null },
  evidence: "REAL emulator verifyIdToken via /api/pg/rtdb/get",
}, null, 2));
