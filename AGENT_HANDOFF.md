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

## Step 1 checkpoint + Step 2A readiness (Cursor, 2026-08-29)

- Step 1 checkpoint commit created: `2ab3e4fb03ba2d8dea7817c825b6c9010e6615ef` (not pushed). `tools/` left untracked. No secrets staged.
- Step 2A is inventory/plan only. Production Firebase REST GET only (667 discover + 57 legacy-roots + 191 issue re-check). Writes: 0. Auth not mutated. Production migrate not run. Step 3 not started.
- Live source (2026-08-29): 46 restaurants, 56 tenant collections, 59 orders, 85 users, 44/46 credential trees, restaurants_meta 47 with 1 orphan, root promocodes 68,751, discountClaims absent. Local PG currently holds only the 2 Step 1 fixture tenants.
- Step 2A readiness: **PARTIAL**. Safe for local/read-only dry-run on a dedicated database. **Not** safe to migrate production.

## Step 2D.2 cutover verification tooling (Cursor, 2026-08-29)

- Tooling only. Production data was not migrated. `DATA_BACKEND` was not switched. Production Firebase was not written. Step 3 was not started.
- Added read-only `step2d2-prod-pg-preflight.mjs` (SSL, non-loopback, forbidden DBs, schema 0017, roles, FORCE RLS, empty restaurants, pool recommendation). Local loopback is expected **NO-GO**.
- Production `--apply` requires exact `NESTA_MIGRATE_TARGET=production` plus two confirmation strings; `yes`/`true`/`1` are refused. Default remains loopback `nesta_migration_dryrun`.
- Operator checklist: `docs/CUTOVER_OPERATOR_CHECKLIST.md`. Backups and payment pause remain **NOT VERIFIED** until the operator supplies artifacts/confirmation.
- Webhooks: Click/Payme/Uzum **BLOCKED**. HTTP 503 is not a guaranteed retry. `DURABLE_QUEUE` is not implemented.
- Local rehearsal: `node db/scripts/step2b-run.mjs rehearsal` against `nesta_migration_dryrun` only.

## Step 2D.3 Railway schema-only (Cursor, 2026-08-30)

- Schema-only attempt. Production Firebase was not read for migrate-apply. `migrate-firebase --apply` was not run. `DATA_BACKEND` was not switched. Step 3 was not started.
- Identity probe (`step2d3-railway-schema.mjs identify`) **STOP**: process env has no `POSTGRES_URL` / `DATABASE_URL`; `backend/.env` is still loopback `localhost` / database `postgres` (local fixture). Railway CLI / `RAILWAY_TOKEN` not present. No remote connection was opened.
- Schema 0001–0017 was **not** applied. Local PostgreSQL was not used.
- Re-run after the operator sets a non-loopback public URL in the environment (do not commit it): `node db/scripts/step2d3-railway-schema.mjs identify` then `apply`, then `step2d2-prod-pg-preflight.mjs`.

## Railway TLS fix (Cursor, 2026-08-30)

- `self-signed certificate in certificate chain` on `*.proxy.rlwy.net` is the stock Railway Postgres cert (CN=localhost, unpublished per-instance CA). `step2d3` previously set `rejectUnauthorized: true` against the public CA store.
- Fix: `backend/db/pgSsl.js` — Railway hosts use libpq `sslmode=require` equivalent (encrypt, no global `NODE_TLS_REJECT_UNAUTHORIZED`). Other remote hosts stay verify-full. Optional `POSTGRES_SSL_CA` / `POSTGRES_SSL_CA_FILE` enables verify-ca.
- Schema was not applied. `DATA_BACKEND` was not switched.

## Step 2D.3 schema apply session fix (Cursor, 2026-08-30)

- Root cause: `identifyLive` ran `SET default_transaction_read_only = on` on the same client later used for `apply`. That GUC is session-level and survives `ROLLBACK`, so `CREATE TABLE` failed with "read-only transaction".
- Fix: identify/tls-probe use `BEGIN READ ONLY` + `SET LOCAL`. Apply closes that client and opens a dedicated session with `default_transaction_read_only = off`. Invariants still require empty `railway` / PUBLIC MANAGED / SSL on.
- This agent session still has no `DATABASE_PUBLIC_URL`; apply was not executed here. Re-run `node db/scripts/step2d3-railway-schema.mjs apply` in the shell that already passed identify. No Firebase migrate. `DATA_BACKEND` unchanged.

## Step 2D.4 operator preflight (Cursor, 2026-08-30)

- Production Firebase `--apply` was not run. `DATA_BACKEND` was not switched. Auth was not mutated. Step 3 was not started.
- Firebase RTDB backup: read-only GET; 46 restaurants; 54 nested order payments; structural parse **PASS**. Live RTDB restore **not** performed. Artifact under gitignored `cutover-backups/firebase-*`.
- App/config copies: **PASS** (`.env` + service-account copied to gitignored `cutover-backups/app-config-*`; secret **names** only in inventory). Reverse proxy config **NOT VERIFIED**.
- Railway PG dump/restore drill: **FAIL then fixed source-vs-target mix-up**. Root cause: the script copied `DATABASE_PUBLIC_URL` onto `POSTGRES_URL`, so restore used Railway and the loopback guard stopped. Fix: independent resolvers (`resolveDumpSource` / `resolveRestoreTarget`); restore uses `STEP2D4_RESTORE_DATABASE_URL` or isolated `backend/.env` loopback; never `DATABASE_PUBLIC_URL`. Disposable DB `nesta_step2d4_restore` only. Cursor still has no `DATABASE_PUBLIC_URL` — dump **NOT RUN** here. Operator re-run in the Railway shell. Production data not migrated. `DATA_BACKEND` unchanged.
- Click/Payme/Uzum **BLOCKED**. HTTP 503 is not a guaranteed retry. Durable queue not implemented. Pause confirm phrase not set.
- `POSTGRES_POOL_MAX` remains **10**.

## Step 2D.4 PG backup/restore connection separation (Cursor, 2026-08-30)

- Do not dump Railway from this session if `DATABASE_PUBLIC_URL` is unset. Do not substitute localhost as dump source.
- Source resolver: `DATABASE_PUBLIC_URL` (Railway `railway` only). Restore resolver: `STEP2D4_RESTORE_DATABASE_URL` or isolated `backend/.env` loopback. Disposable DB: `nesta_step2d4_restore`.
- Operator command (shell that already has the public URL): `$env:POSTGRES_SSL = "true"; node db/scripts/step2d4-pg-backup-restore.mjs`
- Tests: `node --test db/tests/step2d4-pg-backup-restore.test.mjs`

## Step 2D.4 pg_dump client version guard (Cursor, 2026-08-30)

- Railway server is PostgreSQL 18.6. A PATH `pg_dump` 16.x cannot dump it. Guard requires pg_dump/pg_restore major >= server major and stops with `PG_DUMP_VERSION_INCOMPATIBLE` before creating a dump.
- Set `PG_DUMP_BIN` / `PG_RESTORE_BIN` to PostgreSQL 18 client executables. Do not downgrade Railway. Dump source remains Railway read-only; restore remains loopback `nesta_step2d4_restore`.
- Operator (shell with `DATABASE_PUBLIC_URL`): `$env:POSTGRES_SSL = "true"; $env:PG_DUMP_BIN = "...\PostgreSQL\18\bin\pg_dump.exe"; $env:PG_RESTORE_BIN = "...\PostgreSQL\18\bin\pg_restore.exe"; node db/scripts/step2d4-pg-backup-restore.mjs`

## Step 2D.4 local restore role bootstrap (Cursor, 2026-08-30)

- `pg_restore` failed with exit 1 because cluster-global `nesta_app` is not in a database dump. Schema 0017 / RLS 74/74 still restored.
- Fix: before local restore, CREATE missing `nesta_*` roles on loopback `postgres` only (NOSUPERUSER / NOCREATEDB / NOCREATEROLE / NOREPLICATION / NOBYPASSRLS / NOLOGIN). Never CREATE ROLE on Railway. Drop only roles this drill created.
- Re-run operator drill with the same PG 18 clients. Do not migrate Firebase. `DATA_BACKEND` unchanged.

## Step 2D final payment cutover confirmation (Cursor, 2026-08-30)

- `NESTA_PAYMENT_PAUSE_CONFIRM` is **UNSET** in process env and `backend/.env`. `NESTA_PAYMENT_CUTOVER_MODE` unset. Go-live **false**. Click/Payme/Uzum **BLOCKED**.
- Confirm guard **PASS**: exact phrase required; `yes`/`true`/`1` refused. `webhookRetryGuaranteed=false`. Durable queue unimplemented. Maintenance middleware tests: Click/Payme/Uzum webhooks HTTP 503, `retry_guaranteed: false`.
- Artifacts present under gitignored `cutover-backups/` (firebase 1, pg 6, app-config 1). Production `--apply` not run. `DATA_BACKEND` not switched. Step 3 not started.
- Final preflight **PARTIAL**. Not safe to request human approval.

## Step 2D final gate diagnosis (Cursor, 2026-08-30)

- Root cause of PASS + `safeToRequestHumanApproval=false`: the approval flags were **hardcoded false** and were not derived from the PASS label.
- After fix: PASS = PREFLIGHT READY only. `safeToRequestHumanApproval` requires CUTOVER WINDOW ARMED (maintenance on, write-stop verified, deploy freeze, git freeze, freeze-time snapshot, Railway live GO). `safeToMigrateProductionData` remains false until explicit human approval (never granted by this script).
- Payment pause evidence is **OPERATOR ATTESTATION**. Do not enable maintenance from this agent. Do not migrate. `DATA_BACKEND` unchanged.

## Step 2D.5 cutover window arming (Cursor, 2026-08-30)

- Tooling added: `step2d5-deploy-freeze.mjs`, `step2d5-write-stop-probe.mjs` (GET health first; no write POSTs if maintenance off), `step2d5-freeze-snapshot.mjs --freeze-window` (READ-ONLY, `restoran-30d51`), `step2d5-cutover-window.mjs`.
- Prior run: working tree dirty (FAIL). Maintenance OFF; write-stop NOT VERIFIED; freeze snapshot NOT RUN; Railway live GO NOT RUN. Phase **not** CUTOVER_WINDOW_ARMED. `safeToMigrateProductionData` false.
- Do not enable maintenance from this agent. Do not migrate. `DATA_BACKEND` unchanged.

## Step 2D.5A current cutover candidate freeze (Cursor, 2026-08-30)

- Historical Step 2C tag `nesta-step2c-cutover` / `38f5a80681ebd431c9952e83e043ceb23fed6454` is preserved and is **not** the deploy-freeze target.
- Current production cutover candidate tag: `nesta-step2-cutover-ready`. Deploy freeze requires a clean working tree and HEAD equal to that tag.
- Cutover window was not armed. Production migrate was not run. `DATA_BACKEND` unchanged. Maintenance was not enabled. No push.

## Shared protocol

- Re-read this file before editing and merge rather than overwrite another agent's evidence.
- Record commands/results without secrets, raw tokens, private hosts, or passwords.
