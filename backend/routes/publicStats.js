// routes/publicStats.js — Landing-page aggregate statistics.
//
// Root cause this route fixes: the landing page (admin-frontend/public/
// index.html, loadLiveStats()) used to call the Firebase client SDK
// directly — get(ref(db, "restaurants")) — from the browser, with no
// session. That is exactly the access database.rules.json's P0-2
// architecture deliberately denies: restaurants/$restId's ".read" requires
// `auth != null` (a real staff-login/QR-scan/superadmin session — see that
// file's header). No such session exists on an anonymous landing-page visit
// (signInAnonymously() there was never guaranteed to succeed, and even when
// it does, an anonymous Firebase Auth session still carries none of the
// three recognized claim shapes), so the read was correctly denied — the
// browser console's "Firebase Rules ruxsat bermadi" message is the rules
// working as intended, not a bug in them. Loosening the rule (`.read: true`
// or similar) was explicitly ruled out.
//
// Beyond just being denied, that old client-side approach was also the
// wrong shape on its own merits even if it HAD been allowed: it downloaded
// the ENTIRE restaurants/ tree (every restaurant's employees, customers,
// orders, payment amounts, subscriptions...) to the browser just to derive
// four aggregate counters. That is a broad, unauthenticated read of
// privileged data no landing-page visitor should ever be able to fetch,
// regardless of what the four displayed numbers end up being.
//
// The fix: this route computes the same four aggregates SERVER-SIDE, using
// systemDb.js's admin-or-client helper (see its header) — when
// backend/serviceAccountKey.json is present (confirmed present in this
// deployment), systemGet() reads via the Firebase Admin SDK, which bypasses
// Security Rules entirely, by design, because only this trusted backend
// process holds that credential. The browser never touches Firebase for
// this data at all anymore; it only ever sees the four numbers below.
//
// Response shape is deliberately minimal and flat — see computeAggregates()
// — and contains NO restaurant names/ids, NO employee/customer records, NO
// per-order data, NO password/passwordHash/passwordEnc, nothing keyed by
// any identifier. Only four non-negative integers.
import express from "express";
import { systemGet } from "../systemDb.js";
import { countCanonicalRestaurants } from "../pg/platformCount.js";
import { usePostgres } from "../pg/config.js";
import { getPool } from "../db/postgres.js";

const router = express.Router();

// ─── In-memory cache ─────────────────────────────────────────────────────
// restaurants/ is a large tree (every restaurant's employees, customers,
// orders...) — recomputing this on every landing-page hit would mean a full
// tree read+scan per visitor. A short server-side cache keeps the numbers
// fresh enough for a marketing counter (they do not need to be
// live-to-the-second) while bounding backend/database load regardless of
// traffic. `inFlight` additionally collapses concurrent cache-miss requests
// into a single upstream read (prevents a stampede of simultaneous full-tree
// reads if many visitors land right as the cache expires).
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedAt = 0;
let cachedValue = null;
let inFlight = null;

function computeAggregates(restaurantsTree) {
  const restEntries = Object.values(restaurantsTree || {});
  const now = Date.now();

  let totalCustomers = 0;
  let totalOrders = 0;
  let totalRevenue = 0;
  let activeRestaurants = 0;

  restEntries.forEach((rest) => {
    const info = rest?.info || {};
    const sub = rest?.subscription || {};
    const expireAt = Number(sub.expireAt || 0);
    if (info.status !== "blocked" && expireAt > now) activeRestaurants++;

    const customers = rest?.customers || {};
    totalCustomers += Object.keys(customers).length;

    const orders = rest?.orders || {};
    Object.values(orders).forEach((order) => {
      totalOrders++;
      const paid = order?.payment?.approved === true || order?.payment?.paid === true;
      if (paid) totalRevenue += Number(order?.payment?.amount || order?.total || 0);
    });
  });

  // Total restaurant rows — NOT "active subscription or else total".
  // Landing and Superadmin must share one authoritative count; active-only
  // was why index.html could show 29/44 while Superadmin showed 46.
  return {
    restaurants: restEntries.length,
    customers: totalCustomers,
    orders: totalOrders,
    revenue: totalRevenue,
  };
}

async function getStats() {
  const fresh = cachedValue && (Date.now() - cachedAt) < CACHE_TTL_MS;
  if (fresh) return cachedValue;
  if (inFlight) return inFlight; // collapse concurrent misses into one read

  inFlight = (async () => {
    if (usePostgres()) {
      const { rows } = await getPool().query(
        `SELECT
           (SELECT COUNT(*)::int FROM restaurants) AS restaurants,
           (SELECT COUNT(*)::int FROM customers) AS customers,
           (SELECT COUNT(*)::int FROM orders) AS orders,
           (SELECT COALESCE(SUM(total), 0)::numeric FROM orders
             WHERE lower(COALESCE(status, '')) IN ('paid', 'to''landi')) AS revenue`
      );
      const row = rows[0] || {};
      return {
        restaurants: Number(row.restaurants || 0),
        customers: Number(row.customers || 0),
        orders: Number(row.orders || 0),
        revenue: Math.round(Number(row.revenue || 0)),
      };
    }
    const snap = await systemGet("restaurants");
    const tree = snap.exists() ? snap.val() : {};
    const stats = computeAggregates(tree);
    const pg = await countCanonicalRestaurants();
    if (pg.source === "postgres" && typeof pg.count === "number") {
      stats.restaurants = pg.count;
    }
    cachedValue = stats;
    cachedAt = Date.now();
    return stats;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

// GET /api/public/stats — no auth required by design (this is the one
// intentionally-public read in the app); rate-limited (see
// security/rateLimit.js's publicStatsLimiter, mounted in server.js) and
// cached above so it can't be used to force repeated full-tree reads.
// Mounted at the specific "/api/public" prefix in server.js (not the broad
// "/api"), same scoping style as authLimiter ("/api/auth") and
// superadminCredentialsLimiter ("/api/superadmin/credentials") — verified
// live that mounting a limiter at the broad "/api" prefix makes it run (and
// consume its quota) for every /api/* request that reaches that point in
// the chain, not just this router's own route, which would otherwise let a
// burst of landing-page traffic spuriously throttle unrelated endpoints.
// ─── Platform branding/contact info ───────────────────────────────────────
// Backs index.html's header logo/name and contact section (phone/email/
// address) — set by the superadmin via routes/superadminSettings.js's
// /platform + /platform-logo (systemData/platform). Same public-by-design,
// cached, Admin-SDK-backed posture as /stats above: only ever returns the
// handful of fields meant to be shown to every visitor — never any other
// key that might end up on that node later.
const PLATFORM_CACHE_TTL_MS = 5 * 60 * 1000;
let platformCachedAt = 0;
let platformCachedValue = null;
let platformInFlight = null;

async function getPlatformInfo() {
  const fresh = platformCachedValue && (Date.now() - platformCachedAt) < PLATFORM_CACHE_TTL_MS;
  if (fresh) return platformCachedValue;
  if (platformInFlight) return platformInFlight;

  platformInFlight = (async () => {
    const snap = await systemGet("systemData/platform");
    const data = snap.exists() ? snap.val() || {} : {};
    const value = {
      name: data.name || "",
      logo: data.logo || null,
      phone: data.supportPhone || "",
      email: data.supportEmail || "",
      address: data.address || "",
    };
    platformCachedValue = value;
    platformCachedAt = Date.now();
    return value;
  })();

  try {
    return await platformInFlight;
  } finally {
    platformInFlight = null;
  }
}

// Called by routes/superadminSettings.js right after a successful /platform
// or /platform-logo write — ROOT CAUSE FIX: without this, a superadmin save
// was correctly reaching Firebase immediately, but the landing page kept
// showing the pre-save name/logo/phone/email/address for up to
// PLATFORM_CACHE_TTL_MS (5 minutes), because this cache only otherwise
// expires on its own timer. Dropping it here makes the very next
// /platform-info request (e.g. the superadmin refreshing index.html to
// check their change) read fresh data instead of waiting out the TTL.
export function invalidatePlatformInfoCache() {
  platformCachedValue = null;
  platformCachedAt = 0;
}

router.get("/platform-info", async (req, res) => {
  try {
    const info = await getPlatformInfo();
    // "no-cache" (not "public, max-age=60" like /stats above) — this
    // response is branding the superadmin actively edits and expects to see
    // change right away; must-revalidate on every request so a browser-level
    // cache can never show a pre-save name/logo/phone/email/address after
    // the server-side cache (invalidatePlatformInfoCache() above) has
    // already moved on. Cheap either way — getPlatformInfo() itself still
    // serves from its own 5-minute in-memory cache between saves.
    res.set("Cache-Control", "no-cache");
    res.json(info);
  } catch (err) {
    console.error("[publicStats] failed to compute platform info:", err?.message || err);
    res.status(503).json({ error: "Platform info temporarily unavailable" });
  }
});

router.get("/stats", async (req, res) => {
  try {
    const stats = await getStats();
    res.set("Cache-Control", "public, max-age=60"); // browser/CDN-level cache on top of the server cache
    res.json(stats);
  } catch (err) {
    // Never leak internal error detail (DB connection string, stack, etc.)
    // to an unauthenticated caller — log server-side only.
    console.error("[publicStats] failed to compute landing stats:", err?.message || err);
    res.status(503).json({ error: "Statistics temporarily unavailable" });
  }
});

export default router;
