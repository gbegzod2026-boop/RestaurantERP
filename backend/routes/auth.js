// routes/auth.js — Production Security Fix Pass (Critical).
//
// Replaces the old flow where login.js downloaded EVERY employee's record
// (name/role/PIN — including plaintext passwords) to the browser and
// compared the typed PIN/password in JavaScript. That is now done here,
// server-side, using hashed credentials (security/password.js) — the
// browser never again receives another user's credential, and a failed
// guess never reveals whether the login/PIN even exists.
//
// When a Firebase Admin service account is configured (see
// firebaseAdmin.js), a successful login also mints a real Firebase Auth
// custom token carrying { restId, role } as custom claims, which
// database.rules.json now checks — this is what finally lets RTDB rules
// require `auth != null` instead of being open to any browser. Without a
// service account, login still works exactly as it does today (server-
// verified, hashed) but no Firebase session is established — see the
// isAdminAvailable() branches below.
//
// Architecture Fix Pass: every read/write in this file now goes through
// systemGet()/systemUpdate() (systemDb.js) instead of the plain client SDK
// directly. Reason: once database.rules.json requires `auth != null` on
// restaurants/$restId, this backend's OWN unauthenticated client-SDK
// connection (db.js) would be rejected by those same rules just like any
// other anonymous browser — which would make login itself unable to read
// the very user record it needs to verify a password against. systemGet/
// systemUpdate use the Admin SDK (bypasses rules entirely, as a trusted
// server should) when configured, and fall back to the plain client SDK
// otherwise — identical degrade-gracefully behavior as every other
// Admin-SDK-dependent piece of this fix pass.
import express from "express";
import { isAdminAvailable, getAdminAuth } from "../firebaseAdmin.js";
import { systemGet, systemUpdate } from "../systemDb.js";
import { verifyPassword } from "../security/password.js";
import { isSafeId } from "../security/sanitize.js";
import { logSecurityEvent } from "../security/auditLog.js";
import { decryptSecret, sha256Hex } from "../security/crypto.js";
import { verifyTotpCode } from "../security/totp.js";
import { requireSuperAdmin } from "../security/requireSuperAdmin.js";
import { usePostgres } from "../pg/config.js";
import { authenticateStaffWithPostgres, CredentialConflictError } from "../pg/credentialService.js";

console.log("========== AUTH ROUTER LOADED ==========");

const router = express.Router();

router.get("/test", (req, res) => {
    console.log("TEST ROUTE HIT");
    res.send("OK");
});

const MANAGER_LOGIN_ROLES = new Set(["owner", "admin", "manager"]);
const TRANSIENT_POSTGRES_CODES = new Set([
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  "40001", "40P01", "53300", "53400", "55000", "57P01", "57P02", "57P03",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
]);

export function isTransientPostgresError(error) {
  return TRANSIENT_POSTGRES_CODES.has(String(error?.code || ""));
}

function subscriptionGate(restData) {
  const infoStatus = restData.info?.status;
  if (infoStatus === "blocked" || infoStatus === "paused") return "expired";
  const sub = restData.subscription || {};
  const isLifetime = sub.oneTimePaid === true || sub.isLifetime === true;
  const expireAt = sub.expireAt || 0;
  if (!isLifetime && expireAt > 0 && Date.now() > Number(expireAt)) return "expired";
  return null;
}

/** Mints a Firebase Auth custom token carrying { restId, restaurantId, role,
 * rtdbUserId, isSuperAdmin } claims, when an Admin SDK service account is
 * configured. Returns null otherwise — the caller degrades gracefully
 * (session stays app-managed, not Firebase Auth backed, exactly like before
 * this fix).
 *
 * Firebase Auth UID mapping (first-login-token-bug fix): the Firebase Auth
 * uid is `${restId}__${userId}` — NOT the bare RTDB userId. RTDB user ids
 * (e.g. "admin_1", "chef_1784436547396") are only unique WITHIN a
 * restaurant, reused across every restaurant (confirmed live: dozens of
 * real restaurants each have their own "admin_1") — but Firebase Auth UIDs
 * must be globally unique. Using the bare userId directly (the previous
 * scheme) meant every restaurant's "admin_1" silently shared ONE Firebase
 * Auth record — each login overwrote that shared record's persisted custom
 * claims (setCustomUserClaims), so a DIFFERENT restaurant's admin logging
 * in could make an already-signed-in admin's session claims resolve to the
 * WRONG restaurant on its next silent hourly token refresh. The
 * `${restId}__${userId}` composite closes that collision structurally, the
 * same globally-unique scheme already scoped out (read-only, unexecuted) in
 * backend/scripts/migration-dry-run.mjs's `proposedFirebaseUid`.
 *
 * Because the Firebase Auth uid is no longer the bare RTDB userId, the
 * `rtdbUserId` claim carries the original RTDB id explicitly — rbac.js's
 * resolveIdentity() reads THIS claim (falling back to the token's own uid
 * for any already-minted token from before this fix, which never carries
 * this claim, so existing sessions keep resolving exactly as before).
 *
 * Claim naming: `restId` is the name every consumer of this token actually
 * reads (database.rules.json, rbac.js's resolveIdentity()) — kept as-is
 * since renaming it would mean touching the security rules themselves.
 * `restaurantId` is included alongside it, identical value, purely additive,
 * for callers that prefer the fuller name; nothing currently reads it, and
 * adding it doesn't change what `restId` does anywhere.
 *
 * isSuperAdmin mirrors resolveRequestPermissions()'s exact owner/admin
 * check below in this file's sibling rbac.js — recomputed here rather than
 * imported to keep this module's only Firebase dependency the Admin SDK
 * (rbac.js pulls in the full ROLE_TEMPLATES table, which isn't needed just
 * to mint a token) — if that condition ever changes, update both.
 *
 * `permissions` (the full resolved module/action grants) is deliberately
 * NOT included as a claim: (1) Firebase custom claims are capped at 1000
 * bytes total — a customRole-heavy restaurant's resolved permissions object
 * can exceed that, which would make setCustomUserClaims() throw and break
 * login outright; (2) this app's own security principle (see rbac.js
 * header) is to never trust a client-held permission set — every request
 * still re-resolves permissions server-side via resolveRequestPermissions()
 * on each call, which is strictly safer than trusting a snapshot taken at
 * login time that could go stale if an admin changes the role mid-session. */
async function mintSessionToken(restId, userId, role, isSubAdmin = false) {
  if (!isAdminAvailable()) return null;
  const auth = getAdminAuth();
  // Globally-unique across every restaurant — see the function header for
  // why the bare userId can no longer be used directly.
  const uid = `${restId}__${userId}`;
  // Restaurant ownership is tenant-local authority. Never mint platform
  // authority (including the legacy isSuperAdmin claim) into scoped tokens.
  const claims = { restId, restaurantId: restId, role, rtdbUserId: userId };
  try {
    await ensureAuthUserExists(auth, uid);
    // setCustomUserClaims persists the claims on the Auth user record, so
    // they survive the SDK's silent hourly ID-token refresh — createCustomToken's
    // own additionalClaims argument only guarantees the claims on THIS
    // sign-in's very first token, not later refreshes.
    await auth.setCustomUserClaims(uid, claims);
    return await auth.createCustomToken(uid, claims);
  } catch (err) {
    // Never log err.message's raw Firebase payload here beyond what the
    // SDK itself already sanitizes (uid/code only, no credential is ever
    // part of an Admin Auth SDK error) — consistent with this file's
    // no-secret-logging rule elsewhere.
    console.error("[auth] mintSessionToken failed:", err.code || "AUTH_TOKEN_MINT_FAILED");
    return null;
  }
}

/** Ensures a Firebase Auth user record exists for `uid`, creating one
 * (no email/password — this is a server-managed session identity, not a
 * real account; existing RTDB password/hash is never imported into
 * Firebase Auth, which has its own separate, unused password mechanism)
 * when it doesn't yet. Idempotent and race-safe:
 *   - setCustomUserClaims() (the caller's very next line) is what actually
 *     needs the user to exist — this function's ONLY job is to make that
 *     true, cheaply, without assuming anything about whether it already was.
 *   - A first-time createUser() attempt that loses a race to a concurrent
 *     first login for the SAME uid fails with `auth/uid-already-exists` —
 *     caught and treated as success (the user now exists either way, which
 *     is all this function promises), not a crash.
 *   - `disabled: false` is set explicitly on create. mintSessionToken()'s
 *     only caller (routes/auth.js's /staff-login, /manager-login) already
 *     rejects `user.active === false` with 403 BEFORE ever reaching this
 *     point, so every call here is for a currently-active RTDB user —
 *     "keep Firebase Auth disabled in sync with RTDB active" (this fix's
 *     scope) means never leaving a freshly-created record disabled. It does
 *     NOT retroactively re-enable/disable an ALREADY-EXISTING Auth record
 *     when RTDB's `active` flag changes later — no code path deactivates an
 *     employee's Firebase Auth record today (deactivation is enforced at
 *     the login-gate/rbac layer, unchanged by this fix); wiring a live
 *     toggle would be a separate, broader change outside what was asked. */
async function ensureAuthUserExists(auth, uid) {
  try {
    await auth.getUser(uid);
    return; // already exists — nothing to do
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
  }
  try {
    await auth.createUser({ uid, disabled: false });
  } catch (err) {
    if (err.code === "auth/uid-already-exists") return; // lost a create race — fine, user exists now
    throw err;
  }
}

// Auth root-cause fix pass: superadmin.js's "Login As" (loginAsRestaurantAdmin())
// used to open a brand-new tab (window.open()) carrying only cosmetic
// ?viewAs=/?viewAsRole= URL params — no real Firebase Auth session at all.
// The superadmin's OWN session deliberately uses browserSessionPersistence
// (tab-scoped, see superadmin.js's own setPersistence() call), so the new
// tab starts with zero session either way. admin.js's existing-session check
// then found nothing and fell back to its own anonymous sign-in — which
// carries no restId/role claims, so it structurally cannot satisfy
// database.rules.json's `auth.token.restId == $restId` on ANY restaurant,
// for ANY operation, every single time this flow is used. Live-confirmed for
// rest_1784781747889: its admin_1 Firebase Auth record had never even been
// created — proof no real session had ever been minted for it.
//
// Fix: mint a REAL session for the target admin here (reusing
// mintSessionToken() — the exact same function every normal login already
// uses), gated by requireSuperAdmin (verified token, no restId claim, not
// anonymous — the same check routes/superadminCredentials.js already uses
// for every other superadmin-only action). The target user's role is read
// fresh from Firebase, never trusted from the request body, so this can't be
// used to mint elevated claims for an arbitrary role. No Firebase Rules
// change — this closes the gap by establishing a session that legitimately
// satisfies the existing rules, not by loosening them.
router.post("/login-as", requireSuperAdmin, async (req, res) => {
  const restId = String(req.body?.restId || "");
  const userId = String(req.body?.userId || "");
  if (!isSafeId(restId) || !isSafeId(userId)) {
    return res.status(400).json({ error: "Invalid restId or userId" });
  }

  try {
    const [restSnap, userSnap] = await Promise.all([
      systemGet(`restaurants/${restId}/info`),
      systemGet(`restaurants/${restId}/users/${userId}`),
    ]);
    if (!restSnap.exists()) return res.status(404).json({ error: "Restaurant not found" });
    if (!userSnap.exists()) return res.status(404).json({ error: "User not found" });

    const user = userSnap.val();
    if (user.active === false) return res.status(403).json({ error: "Account disabled" });

    const token = await mintSessionToken(restId, userId, user.role, user.isSubAdmin);
    if (!token) return res.status(503).json({ error: "Feature unavailable" });

    logSecurityEvent({
      type: "superadmin_login_as",
      restId,
      ip: req.ip,
      details: { targetUserId: userId, targetRole: user.role, by: req.superAdminUid },
    });

    res.json({ token, user: { id: userId, name: user.name, role: user.role } });
  } catch (err) {
    console.error("[auth/login-as] error:", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// Restaurant admin/owner/manager "Sahifaga o'tish" (viewAs) — mints a REAL
// session for one of THIS restaurant's own staff members (chef/waiter/
// cashier/courier/other), so opening chef.html/waiter.html/kassa.html/
// courier.html in a new tab gets an actual Firebase Auth session instead of
// implicitly relying on the calling admin's own session leaking into that
// tab via shared browser storage. That implicit reliance is what silently
// broke (live-reproduced: chef.html's initChefAttendance() got
// permission_denied, authUid:null) the moment login.js was scoped to
// tab-local persistence (browserSessionPersistence — see that file's own
// header comment, a deliberate fix for a DIFFERENT bug: one tab's login
// corrupting another already-open tab's session). Restores the viewAs
// feature the correct way — same pattern as /login-as just above
// (superadmin -> restaurant admin), re-scoped to restaurant-admin ->
// restaurant-staff: the CALLER's own verified token must show
// restId-matching admin/owner/manager, never trusted from the request
// body, and mintSessionToken() (the exact same function every normal
// login/the superadmin path already uses) reads the target's role fresh
// from RTDB rather than trusting anything the client sent.
router.post("/staff-view-as", async (req, res) => {
  const restId = String(req.body?.restId || "");
  const userId = String(req.body?.userId || "");
  if (!isSafeId(restId) || !isSafeId(userId)) {
    return res.status(400).json({ error: "Invalid restId or userId" });
  }
  if (!isAdminAvailable()) {
    return res.status(503).json({ error: "Feature unavailable" });
  }

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  let caller;
  try {
    caller = await getAdminAuth().verifyIdToken(authHeader.slice(7).trim());
  } catch (_err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (caller.restId !== restId || !MANAGER_LOGIN_ROLES.has(String(caller.role || "").toLowerCase())) {
    logSecurityEvent({
      type: "staff_view_as_denied",
      restId,
      ip: req.ip,
      details: { callerUid: caller.uid, callerRestId: caller.restId || null, callerRole: caller.role || null, targetUserId: userId },
    });
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const userSnap = await systemGet(`restaurants/${restId}/users/${userId}`);
    if (!userSnap.exists()) return res.status(404).json({ error: "User not found" });

    const user = userSnap.val();
    if (user.active === false) return res.status(403).json({ error: "Account disabled" });

    const token = await mintSessionToken(restId, userId, user.role, user.isSubAdmin);
    if (!token) return res.status(503).json({ error: "Feature unavailable" });

    logSecurityEvent({
      type: "staff_view_as",
      restId,
      ip: req.ip,
      details: { targetUserId: userId, targetRole: user.role, by: caller.rtdbUserId || caller.uid },
    });

    res.json({ token, user: { id: userId, name: user.name, role: user.role } });
  } catch (err) {
    console.error("[auth/staff-view-as] error:", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

async function verify2FA(restId, userId, code) {
  const snap = await systemGet(`restaurants/${restId}/users/${userId}/twoFactor`);
  const tf = snap.val();
  if (!tf?.enabled || !tf.secretEnc) return { required: false, ok: true };
  const secret = decryptSecret(tf.secretEnc);
  const validTotp = verifyTotpCode(secret, String(code || "").trim());
  const codeHash = sha256Hex(String(code || "").trim());
  const backupIdx = Array.isArray(tf.backupCodeHashes) ? tf.backupCodeHashes.indexOf(codeHash) : -1;
  if (!validTotp && backupIdx === -1) return { required: true, ok: false };
  if (backupIdx !== -1) {
    const remaining = tf.backupCodeHashes.filter((_, i) => i !== backupIdx);
    await systemUpdate(`restaurants/${restId}/users/${userId}/twoFactor`, { backupCodeHashes: remaining });
  }
  return { required: true, ok: true };
}

// ── Employee PIN login (chef/waiter/cashier/courier/etc.) ──────────────────
// POST /api/auth/staff-login  { restId, pin }
router.post("/staff-login", async (req, res) => {
  const restId = String(req.body?.restId || "");
  const pin = String(req.body?.pin || "").trim();
  if (!restId || !isSafeId(restId) || !pin) {
    return res.status(400).json({ error: "restId and pin are required" });
  }

  try {
    if (usePostgres()) {
      const employee = await authenticateStaffWithPostgres(restId, pin);
      if (!employee) {
        logSecurityEvent({ type: "login_failed", restId, ip: req.ip, details: { mode: "staff_pin" } });
        return res.status(401).json({ error: "Invalid credentials" });
      }
      if (employee.active === false) return res.status(403).json({ error: "Account disabled" });
      const userId = employee.legacy_rtdb_id || String(employee.id);
      const token = await mintSessionToken(restId, userId, employee.role, employee.extra?.isSubAdmin === true);
      logSecurityEvent({ type: "login_success", restId, userId, ip: req.ip, details: { mode: "staff_pin" } });
      return res.json({
        ok: true,
        user: { id: userId, name: employee.name, role: employee.role },
        restId,
        token,
      });
    }

    const restSnap = await systemGet(`restaurants/${restId}`);
    if (!restSnap.exists()) return res.status(401).json({ error: "Invalid credentials" });
    const restData = restSnap.val();
    if (restData.info?.status === "blocked" || !restData.users) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // P0-2 residual-gap fix: password now lives at
    // credentials/${restId}/${userId}/password (see database.rules.json's
    // "credentials" tree comment) instead of on the users/${userId} record
    // itself — fetched once here, alongside restData, same as before.
    const credsSnap = await systemGet(`credentials/${restId}`);
    const credsData = credsSnap.val() || {};

    // Same "collect every match, reject on ambiguity" logic login.js used to
    // run client-side — kept identical so restaurants with an accidental
    // duplicate PIN keep getting the same safe "contact your admin" outcome,
    // just evaluated server-side now instead of after shipping every PIN to
    // the browser.
    const candidates = [];
    for (const [userId, user] of Object.entries(restData.users)) {
      const role = String(user.role || "").trim().toLowerCase();
      if (MANAGER_LOGIN_ROLES.has(role)) continue;
      const result = await verifyPassword(pin, credsData[userId]?.password);
      if (result.ok) candidates.push({ userId, user, role, migratedHash: result.migratedHash });
    }

    if (candidates.length > 1) {
      logSecurityEvent({ type: "login_pin_conflict", restId, ip: req.ip, details: { count: candidates.length } });
      return res.status(409).json({ error: "PIN conflict — contact your administrator" });
    }
    if (candidates.length === 0) {
      logSecurityEvent({ type: "login_failed", restId, ip: req.ip, details: { mode: "staff_pin" } });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const { userId, user, role, migratedHash } = candidates[0];
    if (user.active === false) return res.status(403).json({ error: "Account disabled" });

    const gate = subscriptionGate(restData);
    if (gate) return res.status(402).json({ error: gate, restId });

    if (migratedHash) {
      // Self-migration: this account's PIN was still plaintext — now that
      // we've verified it, replace it with a bcrypt hash so it's never
      // stored in the clear again. Fire-and-forget: must never block login.
      // P0-2 residual-gap fix: writes to the new credentials/ location, not
      // the old users/${userId}/password (see database.rules.json).
      systemUpdate(`credentials/${restId}/${userId}`, { password: migratedHash })
        .catch((err) => console.error("[auth] PIN hash migration failed:", err.message));
    }

    const token = await mintSessionToken(restId, userId, role, user.isSubAdmin);
    logSecurityEvent({ type: "login_success", restId, userId, ip: req.ip, details: { mode: "staff_pin" } });
    res.json({
      ok: true,
      user: { id: userId, name: user.name, role: user.role },
      restId,
      token, // Firebase custom token, or null if Admin SDK isn't configured yet
    });
  } catch (err) {
    if (err instanceof CredentialConflictError) {
      logSecurityEvent({ type: "login_pin_conflict", restId, ip: req.ip, details: { mode: "staff_pin" } });
      return res.status(409).json({ error: "PIN conflict — contact your administrator" });
    }
    if (isTransientPostgresError(err)) return res.status(503).json({ error: "PG_UNAVAILABLE" });
    console.error("[auth/staff-login] failed:", err?.code || "UNEXPECTED_ERROR");
    res.status(500).json({ error: "Internal error" });
  }
});

// ── Owner/admin/manager login (email/username + password, optional 2FA) ───
// POST /api/auth/manager-login  { login, password, code?, restId? }
//
// UNIVERSAL LOGIN (Nesta ERP single-login-page pass): `restId` is now
// OPTIONAL. Historically the frontend always knew which restaurant it was
// scoped to (via login.html?rest=<id>) and told the backend exactly where
// to look. The new /login.html has no such scope — the user only enters
// login+password — so this endpoint now identifies the restaurant FROM the
// credential itself:
//   - If `restId` IS given (old links, e.g. login.html?rest=<id> still
//     work — see resolveRestaurantScope() in login.js) it's used ONLY as a
//     narrowing hint: that one restaurant is checked first. It is NEVER
//     trusted as an authentication decision by itself — a matching restId
//     with a wrong login/password still fails exactly like before.
//   - If `restId` is absent, invalid, or doesn't name a restaurant that
//     exists, every restaurant is searched (see "CANDIDATE RESTAURANT SET"
//     below). At the current scale (~30 restaurants / ~70 users total,
//     verified live) a full scan per login attempt is cheap and safe —
//     documented here for whoever revisits it once the restaurant count
//     grows by orders of magnitude (at that point, a login->restId index
//     written at account-creation time would be the next step).
router.post("/manager-login", async (req, res) => {
    console.log("===== MANAGER LOGIN HIT =====");

    try {
        const requestedRestId = req.body?.restId ? String(req.body.restId) : "";

        const login = String(req.body?.login || "")
            .trim()
            .toLowerCase();

        const password = String(req.body?.password || "");

        console.log({
            requestedRestId: requestedRestId || null,
            submittedLogin: login,
            submittedPasswordLength: password?.length
        });

        if (!login || !password) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        // ─────────────────────────────────────────
        // CANDIDATE RESTAURANT SET
        // ─────────────────────────────────────────
        // requestedRestId is an optional, UNTRUSTED hint — narrows the
        // search when present and valid, never substitutes for identity/
        // password verification below.

        let restaurantsToSearch = null;
        let usedHint = false;

        if (requestedRestId && isSafeId(requestedRestId)) {
            const hintedSnap = await systemGet(`restaurants/${requestedRestId}`);
            if (hintedSnap.exists()) {
                restaurantsToSearch = { [requestedRestId]: hintedSnap.val() };
                usedHint = true;
            }
        }

        if (!restaurantsToSearch) {
            // Universal search — see the route's header comment for the
            // "why a full scan is fine right now" reasoning.
            const allSnap = await systemGet("restaurants");
            restaurantsToSearch = allSnap.val() || {};
        }

        // P0-2 residual-gap fix: password now lives at
        // credentials/${restId}/${userId}/password, not on the users/
        // ${userId} record itself (see database.rules.json's "credentials"
        // tree comment) — fetched in the same shape as restaurantsToSearch
        // (one credentials/${restId} fetch per candidate restaurant) so
        // searchManagerCandidates() below can look each user's password up
        // by [restId][userId], mirroring how it already looks up restData.
        async function fetchCredsFor(restIdSet) {
            const entries = await Promise.all(
                Object.keys(restIdSet).map(async (rid) => [rid, (await systemGet(`credentials/${rid}`)).val() || {}])
            );
            return Object.fromEntries(entries);
        }
        let credsToSearch = await fetchCredsFor(restaurantsToSearch);

        // ─────────────────────────────────────────
        // IDENTITY + PASSWORD MATCH (across the candidate set)
        // ─────────────────────────────────────────
        // Only owner/admin/manager-role users are eligible here — staff
        // (waiter/chef/cashier/courier/...) authenticate exclusively via
        // /staff-login's PIN flow and are never expected to have a `login`
        // field at all. Restricting the universal search to these roles
        // keeps the search small (already tiny at current scale) and
        // avoids ever matching a staff member's display name against a
        // typed login string now that the search spans every restaurant.
        async function searchManagerCandidates(candidateSet, credsSet) {
            const found = [];

            for (const [restId, restData] of Object.entries(candidateSet)) {
                if (!restData?.users) continue;
                const restCreds = credsSet[restId] || {};

                for (const [userId, user] of Object.entries(restData.users)) {
                    const role = String(user.role || "").trim().toLowerCase();
                    if (!MANAGER_LOGIN_ROLES.has(role)) continue;

                    const matchesIdentity =
                        String(user.login || "").trim().toLowerCase() === login ||
                        String(user.name || "").trim().toLowerCase() === login;

                    if (!matchesIdentity) continue;

                    // P0-2 residual-gap fix: password read from
                    // credentials/${restId}/${userId}, not user.password —
                    // see database.rules.json's "credentials" tree comment.
                    const result = await verifyPassword(password, restCreds[userId]?.password);

                    // Never log the hash itself (or even a prefix of it) —
                    // only non-secret match metadata for troubleshooting.
                    console.log({
                        candidateRestId: restId,
                        candidateUserId: userId,
                        passwordLength: password?.length,
                        passwordMatches: result.ok
                    });

                    if (result.ok) {
                        found.push({ restId, restData, userId, user, role, migratedHash: result.migratedHash });
                    }
                }
            }

            return found;
        }

        let matches = await searchManagerCandidates(restaurantsToSearch, credsToSearch);

        // ROOT CAUSE FIX: requestedRestId is documented above as a
        // "narrowing-only hint, never an auth decision" — but until now, a
        // hint that named a REAL restaurant (e.g. stale
        // localStorage.restaurantId left over from a previous login to a
        // DIFFERENT restaurant in the same browser — login.js always writes
        // this on every successful login) silently narrowed the search to
        // that one wrong restaurant and NEVER fell back, so an entirely
        // correct login+password for a DIFFERENT restaurant came back
        // "Invalid credentials" even though the account was fine. Confirmed
        // live: a correct login+password hinted at an unrelated, real
        // restId reproducibly failed with 401 before this fix. If the
        // hinted restaurant alone produced no match, we now fall back to
        // the same universal search used when no hint is given at all —
        // this only ever WIDENS the search, so it cannot turn a legitimately
        // failed login into a success.
        if (usedHint && matches.length === 0) {
            console.log("MANAGER LOGIN: hinted restId had no match, falling back to full search:", { hintedRestId: requestedRestId });
            const allSnap = await systemGet("restaurants");
            const allRestaurants = allSnap.val() || {};
            matches = await searchManagerCandidates(allRestaurants, await fetchCredsFor(allRestaurants));
        }

        // ─────────────────────────────────────────
        // ZERO OR AMBIGUOUS MATCH
        // ─────────────────────────────────────────
        // More than one match means the SAME login+password combination
        // verifies against two different restaurants — this can only
        // happen with a genuine data collision (two restaurants that both
        // happen to have chosen an identical login AND an identical
        // password), astronomically unlikely but handled safely rather
        // than silently picking one, mirroring /staff-login's existing
        // PIN-conflict-lands-on-409 pattern.

        if (matches.length === 0) {
            console.log("LOGIN FAILED: user not found or password incorrect");

            logSecurityEvent({
                type: "login_failed",
                restId: requestedRestId || null,
                ip: req.ip,
                details: { mode: "manager", login }
            });

            return res.status(401).json({ error: "Invalid credentials" });
        }

        if (matches.length > 1) {
            logSecurityEvent({
                type: "login_ambiguous",
                restId: requestedRestId || null,
                ip: req.ip,
                details: { mode: "manager", login, count: matches.length }
            });

            return res.status(409).json({ error: "Ambiguous credentials — contact your administrator" });
        }

        // ─────────────────────────────────────────
        // FOUND USER
        // ─────────────────────────────────────────

        const { restId, userId, user, role, migratedHash } = matches[0];

        // ─────────────────────────────────────────
        // ACTIVE CHECK
        // ─────────────────────────────────────────

        if (user.active === false) {
            return res.status(403).json({
                error: "Account disabled"
            });
        }

        // ─────────────────────────────────────────
        // PASSWORD MIGRATION
        // ─────────────────────────────────────────

        if (migratedHash) {
            // P0-2 residual-gap fix: writes to the new credentials/
            // location, not the old users/${userId}/password.
            systemUpdate(
                `credentials/${restId}/${userId}`,
                {
                    password: migratedHash
                }
            ).catch((err) => {
                console.error(
                    "[auth] password hash migration failed:",
                    err.message
                );
            });
        }

        // ─────────────────────────────────────────
        // LOGIN SUCCESS
        // ─────────────────────────────────────────

        console.log(
            "LOGIN SUCCESS:",
            {
                restId,
                userId,
                role
            }
        );

        // ─────────────────────────────────────────
        // SESSION TOKEN
        // ─────────────────────────────────────────

        const token = await mintSessionToken(
            restId,
            userId,
            role,
            user.isSubAdmin
        );

        // ─────────────────────────────────────────
        // SECURITY LOG
        // ─────────────────────────────────────────

        logSecurityEvent({
            type: "login_success",
            restId,
            userId,
            ip: req.ip,
            details: {
                mode: "manager"
            }
        });

        // ─────────────────────────────────────────
        // RESPONSE
        // ─────────────────────────────────────────

        return res.json({
            ok: true,

            user: {
                id: userId,
                name: user.name,
                role: user.role
            },

            restId,

            token
        });

    } catch (err) {
        console.error(
            "MANAGER LOGIN ERROR:",
            err
        );

        return res.status(500).json({
            error: "Internal server error"
        });
    }
});


// ═══════════════════════════════════════════════
// TEST ROUTE
// ═══════════════════════════════════════════════

router.get("/test", (req, res) => {
    res.send("AUTH OK");
});


// ═══════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════

export default router;
