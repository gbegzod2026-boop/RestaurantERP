// firebaseAdmin.js — Production Security Fix Pass (Critical).
//
// Everything else in this backend talks to Firebase with the public CLIENT
// SDK (see db.js) — from Firebase's point of view that's indistinguishable
// from a browser, and it's why Realtime Database Security Rules had to stay
// wide open (a client-SDK connection can't prove who it is). Two of the
// Critical fixes need the backend to actually be trusted by Firebase:
//
//   1. Minting real Firebase Auth sessions for employee logins (so RTDB
//      rules can finally check `auth.uid`/`auth.token.*` instead of being
//      open to everyone) — requires admin.auth().createCustomToken() +
//      setCustomUserClaims(), which only the Admin SDK can do.
//   2. Verifying the ID tokens those sessions produce on incoming API
//      requests (replacing blind trust in the `x-user-id` header) —
//      requires admin.auth().verifyIdToken().
//
// The Admin SDK needs a service account credential, which is NOT something
// this codebase can generate — it has to come from you:
//
//   Firebase Console → Project Settings → Service Accounts →
//   "Generate new private key" → save the downloaded JSON as
//   backend/serviceAccountKey.json (already gitignored — see .gitignore)
//
// Until that file exists, every export below is a documented no-op and the
// app keeps running exactly as before (legacy x-user-id trust, no custom
// token minted at login) — see the isAdminAvailable() checks at each call
// site (routes/auth.js, rbac.js). Nothing crashes on boot either way.
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import { assertFirebaseDataPlaneAccess } from "./dataPlane.js";
import {
  assertIsolatedAuthEnvironment,
  getAuthEmulatorHost,
  getConfiguredFirebaseProjectId,
  isolatedAuthRequired,
  isProductionFirebaseProject,
  logAuthEnvironment,
} from "./firebaseEnv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVICE_ACCOUNT_PATH =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  path.join(__dirname, "serviceAccountKey.json");

let _app = null;
let _warned = false;
const _dbViews = new Map();

function tryInit() {
  if (_app) return _app;
  if (admin.apps.length) {
    _app = admin.apps[0];
    return _app;
  }

  try {
    assertIsolatedAuthEnvironment();
  } catch (err) {
    console.error("❌ [firebaseAdmin]", err.message);
    if (isolatedAuthRequired()) process.exit(1);
    return null;
  }

  const emulatorHost = getAuthEmulatorHost();
  const projectId = getConfiguredFirebaseProjectId();

  // Auth emulator: never load production service-account JSON. Admin SDK
  // talks to FIREBASE_AUTH_EMULATOR_HOST and verifyIdToken is real emulator crypto.
  if (emulatorHost) {
    if (isProductionFirebaseProject(projectId)) {
      console.error("❌ [firebaseAdmin] refusing Auth emulator with production FIREBASE_PROJECT_ID");
      if (isolatedAuthRequired()) process.exit(1);
      return null;
    }
    try {
      _app = admin.initializeApp({ projectId: projectId || "nesta-staging" });
      console.log("✅ Firebase Admin SDK initialized (Auth emulator; real verifyIdToken)");
      logAuthEnvironment();
      return _app;
    } catch (err) {
      console.error("❌ [firebaseAdmin] Failed to initialize emulator Admin:", err.message);
      return null;
    }
  }

  // GOOGLE_APPLICATION_CREDENTIALS is the standard Google Cloud env var —
  // support it too, in case that's how credentials are provisioned (e.g.
  // in a hosting environment that injects it) rather than a checked-in file.
  if (!existsSync(SERVICE_ACCOUNT_PATH) && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    if (!_warned) {
      console.warn(
        "⚠️  [firebaseAdmin] No service account credential found " +
        `(looked for ${SERVICE_ACCOUNT_PATH} and $GOOGLE_APPLICATION_CREDENTIALS). ` +
        "Real Firebase Auth sessions (secure RTDB rules, verified x-user-id " +
        "replacement) are DISABLED — the app falls back to its prior, less " +
        "secure behavior for these features. See firebaseAdmin.js header for " +
        "setup steps."
      );
      _warned = true;
    }
    return null;
  }

  try {
    const credential = process.env.GOOGLE_APPLICATION_CREDENTIALS
      ? admin.credential.applicationDefault()
      : admin.credential.cert(JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, "utf8")));

    if (isolatedAuthRequired() && isProductionFirebaseProject(projectId)) {
      console.error("❌ [firebaseAdmin] isolated auth refused production service account project");
      process.exit(1);
    }

    _app = admin.initializeApp({
      credential,
      databaseURL: isolatedAuthRequired() ? undefined : process.env.FIREBASE_DATABASE_URL,
      projectId: projectId || undefined,
    });
    console.log("✅ Firebase Admin SDK initialized (real auth sessions enabled)");
    logAuthEnvironment();
    return _app;
  } catch (err) {
    console.error("❌ [firebaseAdmin] Failed to initialize:", err.message);
    return null;
  }
}

export function isAdminAvailable() {
  return !!tryInit();
}

export function getAdminAuth() {
  const app = tryInit();
  return app ? admin.auth(app) : null;
}

export function getAdminDb({ purpose = "runtime" } = {}) {
  const app = tryInit();
  if (!app) return null;
  const key = String(purpose);
  if (_dbViews.has(key)) return _dbViews.get(key);
  const database = admin.database(app);
  const guarded = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "ref") {
        return (path) => {
          assertFirebaseDataPlaneAccess(path, { purpose });
          return target.ref(path);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  _dbViews.set(key, guarded);
  return guarded;
}

// adminAuth()/adminDb() — plain aliases of getAdminAuth()/getAdminDb().
// Every existing call site in this codebase (rbac.js, routes/auth.js,
// routes/qr.js, systemDb.js) already imports getAdminAuth/getAdminDb, so
// those stay the primary names to avoid touching working code — these are
// additive alternates only, for callers that prefer the shorter form.
// Lazy-init is preserved either way: nothing here evaluates admin.auth()/
// admin.database() until called, matching tryInit()'s "only once, only
// when actually needed" contract.
export const adminAuth = getAdminAuth;
export const adminDb = getAdminDb;
