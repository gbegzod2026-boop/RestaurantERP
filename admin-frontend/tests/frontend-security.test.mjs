import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pg = readFileSync(new URL("../public/js/pgRtdb.js", import.meta.url), "utf8");
const admin = readFileSync(new URL("../public/js/admin.js", import.meta.url), "utf8");
const chef = readFileSync(new URL("../public/js/chef.js", import.meta.url), "utf8");

test("backend discovery accepts only explicit postgres or firebase mode", () => {
  assert.match(pg, /j\.dataBackend !== "postgres" && j\.dataBackend !== "firebase"/);
  assert.doesNotMatch(pg, /_mode = "firebase";\s*return _mode;\s*\}\);/);
  assert.match(pg, /getClientDataBackend\(\) \{\s*return _mode;/);
});

test("meta failure is fail-closed as sanitized PG_UNAVAILABLE", () => {
  assert.match(pg, /\.catch\(\(\) => \{\s*_modeP = null;\s*throw httpError\(503, \{ error: "PG_UNAVAILABLE" \}\);/);
});

test("explicit firebase mode preserves the native Firebase flow", () => {
  assert.match(pg, /_mode = j\.dataBackend;/);
  assert.match(pg, /postgresDataPlane/);
  assert.match(pg, /if \(!\(await usePg\(r\)\)\) return fbGet/);
  assert.match(pg, /if \(!\(await usePg\(r\)\)\) return fbSet/);
});

test("postgres bridge fallback never invokes a Firebase operation", () => {
  const fallbackBranches = [...pg.matchAll(/if \(json\.fallback\)([^\n]*)/g)].map((m) => m[1]);
  assert.ok(fallbackBranches.length >= 5);
  for (const branch of fallbackBranches) {
    assert.match(branch, /throw httpError\(503/);
    assert.doesNotMatch(branch, /fb(?:Get|Set|Update|Remove|RunTransaction)/);
  }
});

test("postgres mode fails closed for unmapped tenant paths instead of native Firebase", () => {
  assert.match(pg, /plane === "unmapped"/);
  assert.match(pg, /code: "unmapped_path"/);
  assert.match(pg, /postgresDataPlane\(path, mode\)/);
  assert.doesNotMatch(pg, /return mode === "postgres" && isMapped/);
});

test("tenant path authority comes only from a fresh verified token claim", () => {
  assert.match(pg, /user\.getIdTokenResult\(true\)/);
  assert.match(pg, /claims\.restId \?\? claims\.restaurantId \?\? null/);
  assert.match(pg, /authority\.restId !== requestedRestId/);
  assert.match(pg, /async function usePg\(r\) \{/);
  assert.match(pg, /await ensureTenantAuthority\(path\)/);
});

test("denial cache is scoped by uid, restId, and token generation", () => {
  assert.match(pg, /function denialHits\(uid, restId, gen\)/);
  assert.match(pg, /_authDenied.uid !== uid \|\| _authDenied.restId !== restId \|\| _authDenied.gen !== gen/);
  assert.match(pg, /function rememberDenial/);
  assert.doesNotMatch(pg, /_tenantAuthority.uid === user.uid && \(Date.now\(\) - _tenantAuthority.ts\) < 50 \* 60 \* 1000/);
  assert.match(pg, /Math.min\(60_000/);
});

test("resync waits for nesta:subscribed acknowledgment", () => {
  assert.match(pg, /_pendingResync = wasReconnect/);
  assert.match(pg, /nesta:subscribed/);
  assert.match(pg, /emitResyncWithRetry/);
  assert.doesNotMatch(pg, /if \(wasReconnect\) _socket.emit\("nesta:resync"/);
});

test("subscription ACK and resync are correlated to the active tenant generation", () => {
  assert.match(pg, /_activeSubscription = \{ restId: canonical, generation, epoch: _authEpoch \}/);
  assert.match(pg, /matchesSubscriptionMessage\(active, msg, _authEpoch/);
  assert.match(pg, /generation: expected\.generation,\s*afterSeq: _lastSeq/);
  assert.match(pg, /e\?\.generation === expected\.generation/);
});

test("identity and tenant transitions invalidate old realtime state", () => {
  assert.match(pg, /const identityKey = user \? `\$\{user\.uid\}:\$\{restId \|\| ""\}` : null/);
  assert.match(pg, /invalidateRealtimeSubscription\(\)/);
  assert.match(pg, /_socket\.emit\("nesta:unsubscribe"/);
  assert.match(pg, /_socketRestId = null/);
  assert.match(pg, /_lastSeq = 0/);
  assert.match(pg, /L\.epoch = -1/);
  assert.match(pg, /resumeRealtimeForCurrentIdentity/);
});

test("stale tenant events cannot refresh current listeners", () => {
  assert.match(pg, /matchesTenantEvent\(active, ev, _authEpoch, _subscribedAck\)/);
  assert.match(pg, /L\.epoch !== _authEpoch/);
  assert.match(pg, /restIdOf\(L\.path\) !== active\.restId/);
  assert.match(pg, /const expectedEpoch = L\.epoch/);
  assert.match(pg, /L\.epoch !== expectedEpoch \|\| expectedEpoch !== _authEpoch/);
  assert.match(pg, /const qkey = `\$\{_authEpoch\}\\0/);
});

test("resync retries are bounded and reconnect uses Socket.IO backoff", () => {
  assert.match(pg, /for \(let i = 0; i < 3; i\+\+\)/);
  assert.match(pg, /reconnectionDelay: 400/);
  assert.match(pg, /reconnectionDelayMax: 5000/);
  assert.doesNotMatch(pg, /while\s*\(\s*true\s*\)/);
});

test("legacy chef room join sends a current verified token", () => {
  assert.match(chef, /auth\.currentUser \? await auth\.currentUser\.getIdToken\(\) : null/);
  assert.match(chef, /emitSocket\("chef:join",[\s\S]{0,500}\btoken\b/);
});

test("admin top-level tenant listeners await full tenant auth readiness", () => {
  assert.match(admin, /window\._afterAdminTenantReady = async function \(task\)/);
  assert.match(admin, /window\._afterAdminTenantReady\(async \(\) => \{\s*onValue\(ref\(db, BASE_PATH \+ "\/printSettings"\)/);
  assert.match(admin, /const isMismatch = claimsCheckFailed \|\| sessionRestId !== expectedRestId;/);
});

test("HTTP status classification is deterministic and sanitized", () => {
  for (const marker of ["AUTH_REQUIRED", "TENANT_FORBIDDEN", "NOT_FOUND", "PG_UNAVAILABLE", "UNEXPECTED"]) {
    assert.match(pg, new RegExp(`code: "${marker}"`));
    assert.match(admin, new RegExp(`code: "${marker}"`));
  }
  assert.doesNotMatch(pg, /err\.body\s*=/);
  assert.doesNotMatch(pg, /new Error\(json\.error/);
});

test("tenant alert notification never includes a raw backend error message", () => {
  assert.match(admin, /context \? `\$\{context\}: \$\{classified\.code\}` : classified\.code/);
  assert.match(admin, /t\("sa_alert_inventory_title", "Inventory error"\),\s*classified\.code,/);
});

test("postgres staff create uses the canonical API before any Firebase write", () => {
  const helper = admin.match(/async function _writeNewStaffCredentialAndRecord[\s\S]*?\n\}/)?.[0] || "";
  assert.match(helper, /await resolveClientDataBackend\(\)/);
  assert.match(helper, /_staffApi\("\/api\/staff",/);
  assert.ok(helper.indexOf("_staffApi") < helper.indexOf("await set(ref(db, CREDS_PATH"));
});

test("postgres staff edit combines employee and credential into one PATCH", () => {
  const saveEdit = admin.match(/window\.saveStaffEdit = async function \(\) \{[\s\S]*?\n\};/)?.[0] || "";
  assert.match(saveEdit, /staffBackendMode === "postgres"/);
  assert.match(saveEdit, /_staffApi\(`\/api\/staff\/\$\{encodeURIComponent\(id\)\}`,[\s\S]*method: "PATCH"/);
  assert.match(saveEdit, /body: \{ \.\.\.updates, \.\.\.\(password \? \{ password \} : \{\}\) \}/);
});

test("postgres credential reveal never falls back to the Firebase credential tree", () => {
  const editStaff = admin.match(/window\.editStaff = async function \(id, name\) \{[\s\S]*?\n\};/)?.[0] || "";
  assert.match(editStaff, /const staffBackendMode = await resolveClientDataBackend\(\)/);
  assert.match(editStaff, /let revealedViaEndpoint = staffBackendMode === "postgres"/);
  assert.match(editStaff, /if \(!revealedViaEndpoint\) \{[\s\S]*CREDS_PATH/);
});

test("staff API errors discard backend bodies and expose only classified codes", () => {
  const helper = admin.match(/async function _staffApi[\s\S]*?\n\}/)?.[0] || "";
  assert.match(helper, /classifyAdminDataError/);
  assert.match(helper, /new Error\(classified\.code\)/);
  assert.doesNotMatch(helper, /payload\?\.error \|\|/);
});

test("staff API checks fresh token tenant claims before sending", () => {
  const helper = admin.match(/async function _staffApi[\s\S]*?\n\}/)?.[0] || "";
  assert.match(helper, /user\.getIdTokenResult\(true\)/);
  assert.match(helper, /claims\.restId \?\? claims\.restaurantId \?\? null/);
  assert.match(helper, /claimRestId !== currentRestaurantId/);
});

test("staff delete uses sanitized API errors and deterministic status UI", () => {
  const deleteStaff = admin.match(/window\.deleteStaff = async function \(id\) \{[\s\S]*?\n\};/)?.[0] || "";
  assert.match(deleteStaff, /await _staffApi\(`\/api\/staff\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(deleteStaff, /classifyAdminDataError\(error\)/);
  assert.match(deleteStaff, /getAdminDataErrorMessage\(error\)/);
  assert.doesNotMatch(deleteStaff, /body\?\.error|error\.message|console\.error\([^\n]*, error\)/);

  const messages = admin.match(/window\.getAdminDataErrorMessage = function \(error\) \{[\s\S]*?\n\};/)?.[0] || "";
  for (const code of ["AUTH_REQUIRED", "TENANT_FORBIDDEN", "NOT_FOUND", "PG_UNAVAILABLE", "UNEXPECTED"]) {
    assert.match(messages, new RegExp(`${code}:`));
  }
});

test("tenant readiness helper blocks pending/invalid work and runs valid work once", async () => {
  const assignment = admin.match(/window\._afterAdminTenantReady = async function \(task\) \{[\s\S]*?\n\};/)?.[0] || "";
  assert.ok(assignment);

  let resolveReadiness;
  const readiness = new Promise((resolve) => { resolveReadiness = resolve; });
  const mockWindow = { _adminAuthReady: readiness };
  const helper = Function("window", `${assignment}; return window._afterAdminTenantReady;`)(mockWindow);
  let calls = 0;
  const pending = helper(async () => { calls += 1; });
  await Promise.resolve();
  assert.equal(calls, 0);
  resolveReadiness({ ok: true });
  assert.equal((await pending).ran, true);
  assert.equal(calls, 1);

  mockWindow._adminAuthReady = Promise.resolve({ ok: false, reason: "mismatch" });
  assert.equal((await helper(async () => { calls += 1; })).ran, false);
  assert.equal(calls, 1);
});

test("module evaluation has no eager mode discovery or current-user tenant get", () => {
  assert.doesNotMatch(pg, /\nensureMode\(\);\s*\nwindow\.__nestaRealtimeState/);
  const currentUserGate = admin.match(/window\._afterAdminTenantReady\(async \(\) => \{\s*if \(!currentRestaurantId \|\| !currentUserId\)[\s\S]*?Admin user readiness check failed/)?.[0] || "";
  assert.match(currentUserGate, /await get\(ref\(db, `restaurants\/\$\{currentRestaurantId\}\/users\/\$\{currentUserId\}`\)\)/);
  assert.equal((admin.match(/restaurants\/\$\{currentRestaurantId\}\/users\/\$\{currentUserId\}/g) || []).length, 1);
});

test("order sound and backend write decisions are readiness-safe", () => {
  const sound = admin.match(/\(function initOrderSoundSystem\(\) \{[\s\S]*?\n\}\)\(\);/)?.[0] || "";
  assert.match(sound, /window\._afterAdminTenantReady/);
  assert.doesNotMatch(sound, /authStateReady/);
  assert.doesNotMatch(admin, /getClientDataBackend\(/);
  assert.ok((admin.match(/await resolveClientDataBackend\(\)/g) || []).length >= 6);
});

test("credential conflict is a sanitized deterministic 409 state", () => {
  assert.match(pg, /CREDENTIAL_CONFLICT", status: 409/);
  assert.match(admin, /CREDENTIAL_CONFLICT", status: 409/);
  assert.match(admin, /CREDENTIAL_CONFLICT: t\("staff_pin_taken"/);
});
