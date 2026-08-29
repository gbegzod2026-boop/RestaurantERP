# NESTA Agent Handoff

## Codex track

- Owner: security architecture, implementation review, tests, acceptance, safe Git baseline.
- Current: canonical platform authority, unconditional tenant isolation, tenant-context-only bridge, RTDB rule review patch, and generic PostgreSQL error mapping implemented locally.
- Verification: 7 focused security regressions pass; modified JavaScript modules pass `node --check`. Firebase rules were not deployed.
- Production actions: none authorized.

## Cursor track

- Owner: local PostgreSQL/Windows/Docker/listener diagnosis and browser/runtime execution.
- Constraints: no authorization-code changes; never print credentials or connection strings.
- Sanitized configuration evidence (2026-08-25): `DATA_BACKEND=postgres`; PostgreSQL host class is loopback; port is `5432`; database `postgres`; user `postgres`; app-password field present. Values and connection strings were not printed.
- Root cause of ECONNREFUSED: C: had 0 GB free; no Windows PostgreSQL service, no Docker Desktop, no WSL distro, no Program Files/registry install, and nothing listened on loopback `5432`. The previously documented 16.15 data directory was gone.
- Restoration (2026-08-25, user-space, no elevation): npm-cache (~2.35 GB) removed from C: only. PostgreSQL **16.15** (Visual C++ build 1944, 64-bit) binaries extracted to `D:\nesta-postgresql\pgsql` (D: had ~339 GB free). Fresh cluster initialized at `D:\nesta-postgresql\data` as role `postgres`, `listen_addresses` loopback-only, port `5432`, `scram-sha-256`. Existing `.env` password was used via a temp pwfile and not printed; `.env` was not edited. `nesta_app` password set via `npm run db:set-app-password` (value not logged).
- Proof: loopback TCP `5432` succeeded. `SELECT 1` succeeded (`postgres@localhost:5432/postgres`, version PostgreSQL 16.15). `npm run db:migrate:up` applied 0001–0011; `db:migrate:status` reports 11/11 applied, 0 pending, no drift. `GET /api/pg/meta` HTTP 200: `postgresConfigured=true`, `postgresReachable=true`, `dataBackend=postgres`, `restaurantCount=0`, `restaurantCountSource=postgres`.
- Not a Windows service: restart with `D:\nesta-postgresql\pgsql\bin\pg_ctl.exe -D D:\nesta-postgresql\data -l D:\nesta-postgresql\pg.log start`. No Docker/WSL. Authorization code and `pg/tenant.js` were not edited.
- Follow-up (not production-data apply): this is a **fresh** cluster, so previously migrated restaurant rows are absent (`restaurantCount=0`). Firebase `--apply` was not run.
- RLS (Cursor, 2026-08-25): `REQUIRE_DB=1 npm run db:test:rls` — Wave 0 **13/13**, Wave 1 **8/8**, Wave 2 **21/21**, 0 failed, 0 skipped. Fixtures created and torn down in-test. Authorization code and `pg/tenant.js` were not edited.
- Next Cursor claim: none unblocked. Browser pgRtdb GET/SET/UPDATE remains blocked until local restaurant rows exist and a real staff/QR session is available. Git secret hygiene (2026-08-25): `backend/.env`, `backend/serviceAccountKey.json`, and `.env` are ignored; no matching secret filenames are tracked. Working tree only shows the four coordination docs. Git `safe.directory` was not written to config; inspection used a one-shot `-c` override because `.git` is owned by `CodexSandboxOffline`.

## Cursor track (2026-08-27, Step 1 foundation)

- Owner: verify current backend on :4000, fix `/api/pg/rtdb/*` authz, RLS, request storms. Production migrate/deploy still prohibited.
- Current truth: nothing was on :4000 at start; PostgreSQL 16.15 user-space cluster was down and was started via `pg_ctl`. Single `node server.js` now listens on `0.0.0.0:4000`. `GET /api/pg/meta`: `dataBackend=postgres`, `postgresReachable=true`, **`restaurantCount=0`**. Served `/js/pgRtdb.js` and `/js/admin.js` match the current working tree.
- Root causes (confirmed in current source, not prior reports): `resolveActingRestId` was missing; composite Auth UIDs `rest_<id>__<userId>` were compared as restaurant ids; PG RTDB routes returned unstructured 401/403; writes had no collection RBAC; `ensureTenantAuthority` force-refreshed every mapped call; inventory listeners started before `_adminAuthReady`; `migrateTableKeys` ran on every admin boot; socket join accepted unverified `userId`.
- Fixes shipped locally: canonical restId helper, structured codes, path RBAC, shared token refresh + 401/403 circuit breaker, inventory gated on tenant ready, migrate-on-numeric-keys only, socket join requires verified token. Firebase custom token → ID token verified via Identity Toolkit in the live probe (token values not logged).
- Live API probe (`backend/db/scripts/step1-live-probe.mjs`): own GET/WRITE 200; composite GET 200; foreign GET/WRITE 403 `restId_mismatch`; waiter settings 403 `role_denied`; unmapped `/info` 403 `role_denied`; RLS A-vs-B on `notifications_log` 0 leak. Fixtures deleted (`leftoverStep1Fixtures=0`).
- RLS: Wave0 13/13, Wave1 8/8, Wave2 21/21 with `REQUIRE_DB=1`, 0 skipped. Core tables `relrowsecurity=true` and `relforcerowsecurity=true`.
- Not done: real-browser admin login (no Playwright; PG has no production restaurant rows; Firebase still lists restaurants the scheduler can see). Two-browser Socket.IO resync not executed. CSP `apis.google.com/js/api.js` not added (no Google Sign-In / `gapi` usage). Not production-ready.

## Cursor track (2026-08-28, Step 1 Codex-review remediation)

- Owner: close Codex STEP 1 FAIL findings only. Step 2 / Desktop / Mobile not started. Production migrate/deploy still prohibited.
- P0 postgres fail-closed: `pgRtdb.js` uses `postgresDataPlane`; unmapped tenant/credentials paths throw `unmapped_path` and do not call native Firebase. Platform RTDB retained: `systemData`, `.info`. Auth remains Firebase.
- P1 read RBAC: `rtdbAuthz.js` requires current PG employee, `active !== false`, effective role, module+`view` (writes still need `edit`). Waiter/chef/cashier/courier POS catalog companions are read-only. Finance-sensitive: inventory, ingredients, users, activityLogs, settings.
- P1 restId grammar: canonical `rest_[0-9]{10,16}`; legacy staff uid `rest_<digits>__<staffUser>` only. Malformed → 400 `restId_invalid`. Conflicting selectors → 400 `restId_conflict`. No silent null.
- P1 realtime: client waits for `nesta:subscribed` before `nesta:resync`; server rejects resync unless `nestaSubscribed`. Bounded retry then listener refresh.
- P2: denial cache keyed uid+restId+token generation; authority TTL min(60s, token-exp-30s); transaction route propagates `rtdbSet` errors.
- Tests: `REQUIRE_DB=1 npm run db:test` **190 pass / 0 fail / 0 skip**. Frontend **24 pass**. HTTP stack mounted actual `/api/pg` router; Firebase crypto **MOCKED / NOT VERIFIED** in that file. Live probe **REAL VERIFIED**, failures=0.
- RLS: 74/74 tenant tables `relrowsecurity` and `relforcerowsecurity`. Pool leak test passed.
- Live probe vs :4000 after restart: GET/SET/UPDATE/REMOVE/PUSH 200; all cross-tenant ops 403 `restId_mismatch`; waiter/chef/courier restricted reads 403; blocked employee 403; unmapped SET+txn 400 `unmapped_path`; malformed 400; conflict 400; superadmin GET 200; RLS 0 leak.
- Not done: real-browser admin login and two-tab Socket.IO. Local PG still has `restaurantCount=0` for production tenants. No production Firebase→PG migrate. CSP not changed.
- Next: browser acceptance against a **seeded local** tenant (not production data) if explicitly requested. Do not start Step 2.

## Local PostgreSQL acceptance fixture (2026-08-28)

- Owner: disposable local PostgreSQL setup/cleanup and manual runbook for Step 1 Remediation Round 2 only.
- Added `backend/db/scripts/step1-local-acceptance.mjs` plus package scripts. It reserves two deterministic `.localhost` tenants, requires `NESTA_LOCAL_ACCEPTANCE=1`, rejects every non-loopback PostgreSQL host, checks the required 0012-era runtime schema, detects tenant-ID collisions, and uses platform/tenant transaction contexts.
- Seed scope: manager/staff bcrypt credentials, active and blocked RBAC states, modules/overrides, settings, tables, menu/category, inventory, notifications, and a realtime event. Cleanup is explicit, idempotent, ownership-checked, and cascades from only the two disposable restaurants.
- Firebase: the fixture imports no Firebase code and does not read/change Auth users, claims, or RTDB. The existing browser manager-login route can mutate Firebase Auth while minting a session, so no browser login was run without separate approval.
- Verification: fixture `node --check` passed; package JSON parsed; explicit-opt-in and non-loopback guards passed; focused credential tests 3/3 passed. A generated-secret seed/status/cleanup cycle could not connect because local PostgreSQL was down (`ECONNREFUSED`); errors remained sanitized and no fixture rows were retained.
- Runbook: `docs/STEP1_LOCAL_PG_ACCEPTANCE.md`. Browser, two-tab Socket.IO, and CSP evidence remain **NOT VERIFIED** pending an approved manual run.

## Step 1 Remediation Round 2 validation (2026-08-28)

- P0 single data plane: frontend tenant consumers use `pgRtdb`; backend Admin/client RTDB adapters enforce the canonical `dataPlane.js` firewall. Tenant `info`, subscription features, attendance, kitchen announcements, internal chats, and superadmin chat now have PostgreSQL paths. Canonical platform APIs back restaurant projection, feature mutation, and superadmin chat.
- Direct RTDB audit: frontend native imports are limited by the repository-wide static allowlist to `pgRtdb` plus approved platform/connectivity files. Backend native Admin/client RTDB access is limited to canonical guarded adapters. Both enforcement suites pass.
- RestId: absent selectors remain eligible for verified-token fallback; present empty/whitespace/malformed header, body, query, and path selectors return 400 `restId_invalid`; valid conflicts remain `restId_conflict`; tenant mismatch remains 403.
- Realtime: initial subscribe, resubscribe, resync, and periodic checks revalidate current PostgreSQL employee authority. Deleted/inactive/blocked/revoked staff fail closed and leave rooms. Client auth epochs plus subscription generations reject late ACKs, old-tenant events, and stale resyncs.
- Credentials: fixture execution exposed `INSERT ... ON CONFLICT` requiring access incompatible with deliberate password-hash SELECT denial. Credential writes now use update-then-insert with a single unique-race recovery; real least-privileged PostgreSQL insert and rotation pass without plaintext or reversible storage.
- Validation: `REQUIRE_DB=1 npm run db:test` — **211 pass, 0 fail, 0 skip**. Frontend — **34 pass**. Focused realtime/authority — **18 pass**. Independent catalog query — **74/74 RLS and 74/74 FORCE RLS**. Pool rollback/reuse isolation passed.
- Local fixture: migration 0012 was applied to the disposable loopback cluster. Full seed → READY/READY → cleanup → ABSENT/ABSENT cycle passed without Firebase access or retained fixture rows.
- Evidence limits: the five-operation HTTP matrix mounts the actual router and uses real PostgreSQL, but Firebase `verifyIdToken` is mocked for deterministic identities. Genuine browser login, two-browser realtime, and browser CSP remain **NOT VERIFIED** because login would mutate the configured Firebase Auth project and no approval was given. STEP 1 complete acceptance therefore remains **NO-GO**; Step 2 was not started.

## Step 1 Remediation Round 3 (2026-08-28)

- Customer RTDB hole: `rtdbAuthz.js` no longer grants collection-wide access from `role === "client"`. Canonical customer identity is `type === "customer"` AND `role === "client"` from verified QR claims (`routes/qr.js`). Staff tokens with only `role:"client"` fall through PostgreSQL employee RBAC and fail closed.
- Ownership: dine-in orders/tables/orderChats/orderChangeRequests/waiterCalls are scoped to the QR table claim and proven against PostgreSQL. Collection roots, foreign table/order, tenant-wide notifications, and settings writes are denied. Public catalog reads (menu, categories, info, subscription, meta, settings GET) remain for QR menu.
- Realtime: customer tokens cannot join `nesta:subscribe` tenant rooms even if employee lookup would succeed; `GET /api/pg/realtime/since` is 403 for customers.
- Validation: `REQUIRE_DB=1 npm run db:test` — **223 pass, 0 fail, 0 skip**. Frontend — **34 pass**. Focused customer authz + PG isolation + five-verb matrix passed. RLS catalog test passed; pool leak passed. Identity crypto in HTTP/customer integration remains **MOCKED**. Browser/CSP remain **NOT VERIFIED**. Step 2 was not started.

## Step 1 Remediation Round 4 (2026-08-28)

- Legacy Socket.IO: unauthenticated `client-connect` no longer joins `rest-{restId}`. Customers join only `customer-session:` / `customer-table:` rooms after verified identity. Operational events (`new-order`, `payment-request`, `menu-updated`, …) require `legacyStaffVerified` from chef/admin connect; request-controlled `restId` is ignored.
- QR mint: `/api/qr/session` requires existing HMAC (`QR_SIGNING_KEY` / `ENCRYPTION_KEY`). Unsigned/modified/expired QR cannot receive table claims. Takeaway sessions get a unique uid. `/api/qr/sign` requires staff/platform identity.
- Takeaway ownership: `orders.customer_session_id` stamped at create; missing binding fails closed. No-table IDOR closed.
- Customer writes: field allowlist + protected-field deny; table mutation deny; timeline read-only; chats append-only; change requests create-pending only; waiter calls create-open only.
- Settings: customer GET uses public DTO via `public_restaurant_settings()`; fake API keys never serialized.
- DB context: `actingRole=customer` with GUCs; RESTRICTIVE RLS; event persist via `record_realtime_event` SECURITY DEFINER.
- Validation: `REQUIRE_DB=1 npm run db:test` — **232 pass, 0 fail, 0 skip**. Frontend — **34 pass**. RLS catalog **74/74**. Identity crypto in HTTP tests remains **MOCKED**. Browser/CSP **NOT VERIFIED**. Step 2 was not started.

## Step 1 Remediation Round 5 (2026-08-28)

- Customer prices: `customerPricing.js` resolves product/modifier IDs in the current tenant PostgreSQL catalog. Client `price`/`status`/`kitchenStatus` and aliases are discarded. Invalid product/qty/foreign modifier rejected. Migration **0016** allows customer SELECT on `modifiers`/`extras`/`stop_list` (writes still denied). Applied locally only.
- QR production key: `resolveQrSigningKey` fails closed when `NODE_ENV=production` and neither `QR_SIGNING_KEY` nor `ENCRYPTION_KEY` is set (min length 32). No ephemeral production key. Non-production may use an in-memory key with a warning. `/api/health` returns 503 when QR config is invalid. Startup `process.exit(1)` in that production case. Production env vars were not mutated.
- Legacy staff sockets: `leaveOperationalRooms` before every staff reconnect; `revalidateLegacyStaffAuthority` on privileged emit (5s TTL) and every 60s; failed refresh/deleted/blocked/inactive/role-revoked evicts all `rest-*`/`admins:*`/`chefs:*`. Request `restId` is not authority.
- RLS count: live catalog **74** tenant tables with RLS+FORCE; **71** of those have `restaurant_id`. The other 3 are `restaurants`, `combo_items`, `employee_credentials`. Codex 71/71 counted the `restaurant_id` subset; Cursor 74/74 counted the full tenant catalog query. Invariant holds for both.
- Validation: `REQUIRE_DB=1 npm run db:test` — **247 pass, 0 fail, 0 skip**. Frontend — **34 pass**. No skipped security/DB tests. Step 2 was not started. Independent Codex PASS is not claimed.

## Step 1 Remediation Round 6 (2026-08-28)

- P1 product↔modifier: `resolveAllowedModifierRelationships` defaults to empty/deny. Missing, null, undefined, or empty `modifierIds`/`modifierGroupIds`/aliases no longer mean “any same-tenant modifier”. Codex exploit (product 10000 + unrelated modifier -9000 → persisted 1000) now 403 `modifier_not_associated`. Option IDs are accepted only when they uniquely belong to an explicitly allowed group (needed because order create prices twice: order-level then `upsertItem`). Server price still comes only from the catalog.
- P1 privileged sockets: `revalidateLegacyStaffAuthority` defaults to fresh PG (`force: true`). 5s TTL remains only when `force: false` (room-maintenance). `authorizeLegacyPrivilegedEmit` is the write path: fresh identity + `LEGACY_EVENT_PERMISSIONS` module/action via canonical `permissionAllows`. Deleted/blocked/inactive/module-revoked/role-changed staff are denied on the next emit with no sub-5s window. Identity invalid → rooms cleared; missing module → event denied, identity kept.
- Validation: `REQUIRE_DB=1 npm run db:test` — **259 pass, 0 fail, 0 skip**. Frontend — **34 pass**. No skipped security/DB tests. Step 2 was not started. Independent Codex PASS is not claimed. Browser/CSP remain NOT VERIFIED.

## Step 1 final runtime acceptance (Cursor, 2026-08-29)

- Executed only runtime gates. Step 2 not started. Production Firebase Auth/data not mutated. No commit.
- Environment: `DATA_BACKEND=postgres`; Firebase Admin “real auth sessions enabled”; project `restoran-30d51`; Auth emulator not configured; local PG `restaurantCount=0`.
- Genuine-token E2E and credential submit were stopped: minting a staff or signed-QR session would create/claim users in production Auth.
- Real browser: `/login.html` staff PIN + Rahbar login/password (no Login As, no submit). Unsigned `client.html?restId=rest_1999000000001&table=1` empty menu; browser `POST /api/qr/session` 403 `missing_signature`.
- Live Socket.IO without token: connected; `nesta:subscribe` → `subscription_invalid`. Authorized rooms, two-tenant isolation, revocation, reconnect-after-auth: NOT VERIFIED.
- CSP: recorded from live `/login.html`; gstatic Firebase SDK loaded; `apis.google.com` not requested; no CSP code change.
- Verdict: STEP 1 CODE/SECURITY PASS; STEP 1 RUNTIME/COMPLETE **NOT VERIFIED**; Step 2 **NO-GO**.

## Step 1 isolated runtime environment (Cursor, 2026-08-29, resume after timeout)

- Timed-out setup run had already wired isolated Auth (no production Auth mutation, no commit, Step 2 not started). Resume did not rewrite that work.
- Completed before timeout: `backend/firebaseEnv.js`, Admin emulator init, mint guards on `routes/auth.js` and `routes/qr.js`, `/api/health` + `/api/pg/meta` diagnostics, `/api/public/firebase-config`, frontend `nestaFirebaseApp.js` for login/admin/chef/waiter/kassa/client, CSP `connect-src` for loopback emulator, `firebase.json` Auth-only emulator, `backend/env.staging.example`, `docs/STEP1_STAGING_AUTH.md`, `firebase-env.test.mjs`, `step1-genuine-token.mjs`, `step1-sign-qr-url.mjs`. `step1-runtime-env-probe.mjs` was missing.
- Resume added the read-only probe (`npm run auth:probe`) and did not overwrite the files above.
- Local user-space PostgreSQL was down; started via `pg_ctl`. Fixture status then **READY/READY** for `rest_1999000000001` and `rest_1999000000002`. Disposable passwords were re-hashed in-process and not printed.
- Auth emulator: `nesta-staging` on loopback `9099` (Auth only; no RTDB emulator). Isolated backend overlay: `NESTA_REQUIRE_ISOLATED_AUTH=1`, `FIREBASE_PROJECT_ID=nesta-staging`, `DATA_BACKEND=postgres`. Startup log: `production=false emulator=true isolated=true`.
- Probe **READY**: `firebaseProjectId=nesta-staging`, `productionFirebase=false`, `authEmulator=true`, `isolatedAuth=true`, `dataBackend=postgres`, `postgresReachable=true`, `restaurantCount=2`. Production project `restoran-30d51` was not the runtime target.
- Genuine-token script (emulator only, after probe READY): manager-login 200 (`admin_1` / Tenant A); own settings GET 200; foreign Tenant B GET 403 `restId_mismatch`; refreshed ID token GET 200. Client `signOut` does not revoke the prior JWT; a still-unexpired ID token continued to GET 200 (**not** server-side logout revocation). Evidence label: **REAL emulator `verifyIdToken`**. Production Auth was not used.
- Later closed in the isolated browser/runtime pass: `admin.js` syntax, production frontend fallbacks, browser login/QR/Socket.IO/revocation/PG_UNAVAILABLE. See the following section.
- Step 2 not started. No commit.

## Step 1 isolated browser/runtime acceptance (Cursor, 2026-08-29)

- Finished remaining runtime gates only. Step 2 not started. No commit. Production Auth users not created/modified.
- Blockers closed: `admin.js` `listenTablesRealtime` duplicate `tablesObj` (`node --check` PASS); HTML/JS production `getApps()` fallbacks removed; pages initialize via `loadNestaFirebaseApp()`. Isolated mode never initialized `restoran-30d51`.
- Probe after fixes: **READY**. `firebaseProjectId=nesta-staging`, Auth emulator `127.0.0.1:9099`, `DATA_BACKEND=postgres`, 2 fixture restaurants.
- Real browser: manager login Tenant A (no Login As); reload restored session; Chiqish cleared storage (unexpired JWT until expiry not treated as failure); waiter PIN login + settings SET 403 `role_denied`; foreign tenant GET 403 `restId_mismatch`.
- Signed QR: `/api/qr/session` 200; customer uid `client_rest_1999000000001_1`; order persisted total 27000 (catalog 25000 + cheese 2000); forged cheese 999999 ignored; `mod_unrelated` 403 `modifier_foreign`.
- Data plane: `/api/pg/rtdb/*` and `/api/pg/meta`; 0 tenant `*.firebaseio.com` on login/admin/customer/waiter.
- Live Socket.IO websocket: staff `nesta:subscribed`; customer generic `rest-*` `subscribe_denied`. Two origins: same-tenant event once; Tenant B never saw Tenant A; reload reconnect restored subscribe without duplicate.
- Authority: blocked `admin_1` settings SET 403 in 21ms; waiter `role_overrides` menu:edit then revoke → menu SET 200 then 403 in 25ms. Fixture reseeded. Admin role is unrestricted (`modules: null`); module revoke proven on waiter overrides, not admin modules.
- PG_UNAVAILABLE: disposable `:4010` to unreachable PG; browser 503 `PG_UNAVAILABLE`; no RTDB fallback. Shared PG and `:4000` left running; disposable `:4010` stopped afterward.
- CSP: Helmet still includes emulator `http://127.0.0.1:9099`; 0 `securitypolicyviolation`; CSP not widened.
- Tests: `REQUIRE_DB=1 npm run db:test` **262 pass / 0 fail / 0 skip** with isolated Auth overlay (`nesta-staging`). Frontend `npm test` **35 pass / 0 fail / 0 skip**. One earlier `db:test` without overlay logged Admin SDK `production=true` from `.env`; no Auth mutation; re-run used overlay only.
- Verdict: STEP 1 RUNTIME **PASS**; STEP 1 COMPLETE **PASS**; Step 2 **GO**. Step 2 was not started.

## Shared protocol

- Re-read this file before editing and merge rather than overwrite another agent's evidence.
- Record commands/results without secrets, raw tokens, private hosts, or passwords.
