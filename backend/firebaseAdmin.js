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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVICE_ACCOUNT_PATH =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  path.join(__dirname, "serviceAccountKey.json");

let _app = null;
let _warned = false;

function tryInit() {
  if (_app) return _app;
  if (admin.apps.length) {
    _app = admin.apps[0];
    return _app;
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

    _app = admin.initializeApp({
      credential,
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
    console.log("✅ Firebase Admin SDK initialized (real auth sessions enabled)");
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

export function getAdminDb() {
  const app = tryInit();
  return app ? admin.database(app) : null;
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
