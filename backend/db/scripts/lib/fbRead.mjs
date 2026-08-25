// db/scripts/lib/fbRead.mjs — STRICTLY READ-ONLY Firebase RTDB access layer
// for every Phase 1 migration script.
//
// Safety rule #1 of this phase is "NEVER delete Firebase data" / "NEVER
// modify existing Firebase records". This module is the single choke point
// through which all Phase 1 tooling touches Firebase, and it exposes ONLY
// read verbs (shallowKeys / getValue / getJson). There is deliberately no
// set/update/push/remove/transaction export here, so no migration script can
// mutate production even by accident — a reviewer only has to audit this one
// file to prove the whole phase is non-destructive.
//
// Why raw REST instead of admin.database():
//   admin.database().ref(p).once("value") always downloads the ENTIRE subtree
//   at p. For enumeration ("which restaurants exist", "which order ids exist")
//   that is catastrophic — restaurants/$id/orders can be tens of MB. The REST
//   API's `shallow=true` returns just the immediate child keys as
//   {key: true, ...}, which is what enumeration actually needs. The Admin SDK
//   has no shallow equivalent, so enumeration uses REST and deep reads use
//   REST too (one consistent path, one auth mechanism).
import admin from "firebase-admin";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(__dirname, "../../..");

dotenv.config({ path: path.join(BACKEND_DIR, ".env"), quiet: true });

let _app = null;
let _dbUrl = null;
let _tokenCache = { token: null, expiresAt: 0 };

function serviceAccountPath() {
  return (
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    path.join(BACKEND_DIR, "serviceAccountKey.json")
  );
}

/** Initializes the Admin SDK purely to obtain OAuth2 access tokens for the
 *  REST calls below. Never used to write. */
export function initFirebase() {
  if (_app) return _app;
  const keyPath = serviceAccountPath();
  if (!existsSync(keyPath) && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      `No Firebase service account credential found (looked for ${keyPath} and ` +
        `$GOOGLE_APPLICATION_CREDENTIALS). Phase 1 discovery/migration needs ` +
        `read access to the production RTDB.`
    );
  }
  _dbUrl = (process.env.FIREBASE_DATABASE_URL || "").replace(/\/$/, "");
  if (!_dbUrl) throw new Error("FIREBASE_DATABASE_URL is not set in backend/.env");

  const credential = process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? admin.credential.applicationDefault()
    : admin.credential.cert(JSON.parse(readFileSync(keyPath, "utf8")));

  _app = admin.apps.length
    ? admin.apps[0]
    : admin.initializeApp({ credential, databaseURL: _dbUrl });
  return _app;
}

async function accessToken() {
  const now = Date.now();
  if (_tokenCache.token && now < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }
  const app = initFirebase();
  const t = await app.options.credential.getAccessToken();
  _tokenCache = {
    token: t.access_token,
    expiresAt: now + (t.expires_in || 3600) * 1000,
  };
  return _tokenCache.token;
}

function encodePath(p) {
  return String(p)
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

let _reqCount = 0;
export function requestCount() {
  return _reqCount;
}

async function restGet(p, params = {}) {
  initFirebase();
  const token = await accessToken();
  const qs = new URLSearchParams({ ...params, access_token: token });
  const url = `${_dbUrl}/${encodePath(p)}.json?${qs.toString()}`;

  // Retry on transient network/5xx/429 only. A 4xx other than 429 is a real
  // error (bad path, permission) and is surfaced immediately rather than
  // retried into a long stall.
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      _reqCount++;
      const res = await fetch(url, { method: "GET" });
      if (res.ok) return await res.json();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} on ${p}`);
      } else {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} on ${p}: ${body.slice(0, 200)}`);
      }
    } catch (err) {
      lastErr = err;
      if (err.message && err.message.startsWith("HTTP 4") && !err.message.startsWith("HTTP 429")) {
        throw err;
      }
    }
    await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt)));
  }
  throw lastErr || new Error(`Failed GET ${p}`);
}

/** Immediate child keys of a path, without downloading the subtree.
 *  Returns [] for a missing path or a primitive leaf. */
export async function shallowKeys(p) {
  const val = await restGet(p, { shallow: "true" });
  if (val === null || typeof val !== "object") return [];
  return Object.keys(val);
}

/** Full value at a path. Use only where the subtree is known-bounded
 *  (a single order, one restaurant's settings) — never on a whole
 *  collection you have not size-checked with shallowKeys() first. */
export async function getValue(p) {
  return await restGet(p);
}

/** Bounded read of a collection: newest-N children by key order.
 *  Used for structure sampling, never for the real migration (which pages). */
export async function getLimited(p, limit) {
  return await restGet(p, { orderBy: '"$key"', limitToLast: String(limit) });
}

/** Key-ordered page of a collection: children with key > afterKey, up to
 *  `limit`. This is how the migration streams large collections (orders,
 *  audit logs) without ever holding the whole thing in memory.
 *  Uses startAfter where supported, falling back to startAt+filter. */
export async function getPageByKey(p, afterKey, limit) {
  const params = { orderBy: '"$key"', limitToFirst: String(limit) };
  if (afterKey != null) params.startAfter = JSON.stringify(String(afterKey));
  try {
    const val = await restGet(p, params);
    return val && typeof val === "object" ? val : {};
  } catch (err) {
    // Older RTDB endpoints reject startAfter; fall back to startAt + drop the
    // boundary key locally. Same result, one extra row transferred per page.
    if (afterKey != null && /startAfter/i.test(err.message || "")) {
      const val = await restGet(p, {
        orderBy: '"$key"',
        startAt: JSON.stringify(String(afterKey)),
        limitToFirst: String(limit + 1),
      });
      if (!val || typeof val !== "object") return {};
      delete val[afterKey];
      return val;
    }
    throw err;
  }
}

/** Iterates every child of a large collection in key order, in pages.
 *  Yields [key, value] pairs. Memory stays bounded at one page. */
export async function* iterateCollection(p, pageSize = 300) {
  let after = null;
  for (;;) {
    const page = await getPageByKey(p, after, pageSize);
    const keys = Object.keys(page);
    if (keys.length === 0) return;
    keys.sort();
    for (const k of keys) yield [k, page[k]];
    const nextAfter = keys[keys.length - 1];
    if (nextAfter === after) return; // defensive: no forward progress
    after = nextAfter;
    if (keys.length < pageSize) return;
  }
}

/** Runs `worker` over `items` with bounded concurrency. Keeps the discovery
 *  scripts fast without opening hundreds of simultaneous sockets. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}
