# NESTA Acceptance Matrix

| Case | Expected | Evidence | Status |
|---|---:|---|---|
| Unauthenticated protected request | 401 `token_missing` | Live `POST /api/pg/rtdb/get` on :4000; unit `pg-rtdb-auth` / `pg-http-errors` | PASS |
| Invalid token | 401 `token_invalid` | Live `Bearer not-a-jwt`; unit | PASS |
| Same-tenant GET/WRITE | 2xx | Live probe: admin own GET 200, own notification WRITE 200; custom token exchanged for ID token | PASS (live API fixtures) |
| PostgreSQL unavailable | 503 `PG_UNAVAILABLE` | Unit plus real browser against disposable `:4010` (`POSTGRES_URL` → `127.0.0.1:59999`); 503 `PG_UNAVAILABLE`; 0 `*.firebaseio.com`; shared loopback PG and `:4000` not stopped | PASS |
| Tenant A requests tenant B | 403 `restId_mismatch` | Live probe + unit | PASS |
| Legacy composite uid `rest_*__admin_1` | Canonical restaurant restId | Live composite GET 200; unit canonicalize | PASS |
| Waiter settings write | 403 `role_denied` | Live probe + unit | PASS |
| Tenant staff reads `/info` / `/subscription` | PostgreSQL restaurant metadata only | Real path-router integration | PASS |
| Tenant admin writes platform-owned `/info` / `/subscription` | 403 `role_denied`; only canonical platform API may mutate | Unit + canonical superadmin API integration | PASS |
| Waiter/chef/courier restricted collection READ | 403 `role_denied` | Live probe REAL VERIFIED + HTTP integration MOCKED | PASS |
| Blocked employee READ | 403 `role_denied` | Live probe REAL VERIFIED | PASS |
| Malformed restId | 400 `restId_invalid` | Live probe + adversarial unit | PASS |
| Conflicting restId selectors | 400 `restId_conflict` | Live probe + unit | PASS |
| Transaction write error | non-2xx structured code, not success | Live probe unmapped txn 400 `unmapped_path`; HTTP integration | PASS |
| Postgres mode unmapped tenant path | no native Firebase call | Frontend spy tests + live 400 `unmapped_path` | PASS |
| Every tenant table RLS + FORCE RLS | All current tenant tables: `relrowsecurity` and `relforcerowsecurity` true | Full tenant catalog **74/74** RLS+FORCE. `restaurant_id` subset **71/71**. The 3 extras without `restaurant_id` are `restaurants`, `combo_items`, `employee_credentials`. Prior “74 vs 71” was two catalog definitions, not missing RLS. | PASS |
| Pool leak after thrown tenant callback | tenant B context after A throw/rollback | `pg-pool-leak.test.mjs` | PASS |
| Resync before subscribe ack | `not_subscribed` | Socket protocol two-mock-client test | PASS (protocol) |
| Browser pgRtdb GET/SET/UPDATE | Successful, tenant-scoped | Isolated Auth emulator + local PG fixtures; real browser manager login Tenant A; `/api/pg/rtdb/get` + `/api/pg/meta`; 0 `*.firebaseio.com` tenant-data requests | PASS |
| Two-browser Socket.IO resync after `nesta:subscribed` | Refreshless update, reconnect, no duplicates | Two real origins (`127.0.0.1:4000` vs `localhost:4000`); same-tenant event once; cross-tenant no leak; reload reconnect restored `nesta:subscribed` without duplicate | PASS |

| Enforced browser CSP | Required Google/Firebase scripts work; no functional blocker | Real browser GET `/login.html` + `/client.html` on local :4000; Helmet CSP applied; gstatic Firebase SDK + same-origin Socket.IO loaded; `apis.google.com` not requested; no CSP change made | PASS (no functional blocker); `'unsafe-inline'`/`'unsafe-eval'` remain expected SECURITY CONCERN |
| Legacy scoped `isSuperAdmin=true` requests B | 403 | Unit; canonical verifier ignores the claim | PASS (unit) |
| Canonical platform superadmin + explicit restId | ALLOW | Unit `tenantScopeDecision` / HTTP middleware | PASS (unit) |
| Arbitrary unscoped Firebase account on platform endpoint | 403 | Canonical-authority unit | PASS (unit) |
| Tenant route with `?platform=1` | Tenant context only | Source invariant regression | PASS (unit) |
| Direct tenant Firebase RTDB in postgres mode | No frontend or backend tenant application-data call can reach native RTDB | Frontend repository static allowlist + backend canonical firewall tests | PASS |
| Five-verb HTTP adversarial matrix | GET/SET/UPDATE/REMOVE/PUSH cover own/cross/missing/invalid/malformed/empty/conflict/role/unmapped/superadmin/path mismatch plus client-controlled escalation and customer collection/foreign access | Actual `/api/pg` router + real PostgreSQL; `verifyIdToken` mocked | PASS (router/DB real; identity mocked) |
| Customer collection-root / foreign-resource RTDB | 403 `role_denied`; own dine-in order/table allowed | Unit `rtdb-customer-authz` + live PG `pg-rtdb-customer.integration` | PASS (identity mocked) |
| Staff `role:"client"` without `type:"customer"` | Denied as customer; employee RBAC required | Unit + HTTP/customer integration | PASS |
| Customer tenant-wide Socket.IO / `/realtime/since` | Denied; no generic tenant room | Unit socket + live PG realtime GET | PASS (protocol + integration) |
| Legacy unauthenticated `client-connect` / operational events | No `rest-{restId}` join; operational emits require verified staff | Unit `legacySocketPolicy` | PASS (STRUCTURAL) |
| Signed QR session mint | Table authority only from HMAC `qrSign.js`; unsigned/modified/expired rejected | Unit `qr-session.test.mjs` | PASS (REAL HMAC; mint HTTP MOCKED) |
| Unsigned QR in real browser | 403 `missing_signature`; no Auth mint; no catalog | Cursor IDE browser `POST /api/qr/session` from `client.html` origin; menu chrome empty | PASS (unsigned fail-closed) |
| Signed QR customer order (isolated) | HMAC session; emulator customer token; PG catalog/prices; forged client price ignored | `step1-sign-qr-url.mjs` Tenant A table 1; `/api/qr/session` 200; order `-P0CBNgKyyYJbn37-ksx` total 27000 = 25000+2000; `mod_unrelated` 403 `modifier_foreign` | PASS |
| Takeaway session binding | `customer_session_id` required; unbound/foreign denied | Unit + PG integration + RLS customer context | PASS (identity mocked in HTTP) |
| Public settings DTO | Fake `yandexGo.apiKey` never serialized | Unit + PG customer GET | PASS |
| Customer order item prices | Catalog PostgreSQL prices persist; client price/status/kitchenStatus discarded or rejected | Unit `customer-pricing` + PG integration | PASS (identity mocked in HTTP) |
| Product↔modifier association | Requested modifier accepted only if explicitly associated with the selected product; missing/empty metadata deny; same-tenant unrelated modifier deny | Unit + REAL PG `customer-pricing.integration` including Codex 10000 + -9000 exploit | PASS (identity mocked in HTTP) |
| Production QR signing key | Missing key in `NODE_ENV=production` fails closed; no ephemeral production key | Unit `qr-signing-config` with injected env objects (production env not mutated) | PASS |
| Legacy staff socket lifecycle | Join revalidates current PG authority; eviction on loss; tenant/UID transition leaves all `rest-*`/`admins:*`/`chefs:*` | Unit `legacy-socket-lifecycle` (STRUCTURAL mock rooms; not a live Socket.IO pair) | PASS (STRUCTURAL) |
| Privileged legacy emits | Every privileged write revalidates current PG employee + module/action at event time; no 5s positive write cache | STRUCTURAL wrapper tests + REAL PG `legacy-privileged-emit-pg` (identity MOCKED) | PASS (no live Socket.IO pair) |
| Production QR signing key | Missing key in `NODE_ENV=production` fails closed; no ephemeral production key | Unit `qr-signing-config` with injected env objects (production env not mutated) | PASS |
| Legacy staff socket lifecycle | Join revalidates current PG authority; eviction on loss; tenant/UID transition leaves all `rest-*`/`admins:*`/`chefs:*` | Unit `legacy-socket-lifecycle` (STRUCTURAL mock rooms; not a live Socket.IO pair) | PASS (STRUCTURAL) |
| Realtime authority/lifecycle | Current PG employee state, generations, unsubscribe, stale-event rejection, bounded retry | Protocol tests plus live browser: staff `nesta:subscribed`; customer generic room `subscribe_denied`; waiter menu SET 200 then 403 in 25ms after role_overrides revoke | PASS |
| RLS suites | Pass with `REQUIRE_DB=1` | Full backend: 262 pass, 0 fail, 0 skip (isolated Auth overlay); frontend 35 pass, 0 fail, 0 skip; catalog 74/74 RLS+FORCE | PASS |
| RLS A vs B at DB layer | B cannot see A's rows even under tenant context B | Live probe `notifications_log`; FORCE RLS confirmed on core tables | PASS (fixtures) |
| Git secret hygiene | No sensitive tracked/staged files | `.env` / service account ignored | PASS |

## Step 1 final runtime acceptance (2026-08-29)

- Safe Auth environment: local app points at production Firebase project `restoran-30d51`. Auth emulator unset. `GET /api/pg/meta` `restaurantCount=0`. Staff/QR mint uses Firebase Admin `createUser`/`setCustomUserClaims`/`createCustomToken`.
- Genuine Firebase token / normal login / signed QR / authorized two-browser realtime / PG employee revocation: **NOT VERIFIED**. **BLOCKED — explicit approval required for disposable production Auth mutation.**
- CSP: real browser Helmet header recorded; no functional blocker; CSP not widened.
- Unauthenticated live Socket.IO: websocket connected; `nesta:subscribe` returned `nesta:error` `subscription_invalid`; no tenant RTDB (`*.firebaseio.com`) requests observed on login/client pages.
- STEP 1 RUNTIME / COMPLETE / FINAL VERDICT: **NOT VERIFIED**. Step 2: **NO-GO**.

## Step 1 isolated runtime environment (2026-08-29, resume)

- Probe `backend/db/scripts/step1-runtime-env-probe.mjs` against `:4000`: **READY**. `firebaseProjectId=nesta-staging`, `productionFirebase=false`, `authEmulator=true`, `isolatedAuth=true`, `dataBackend=postgres`, `restaurantCount=2`.
- Genuine token (Auth emulator only, after probe READY): manager-login 200; own GET 200; foreign GET 403 `restId_mismatch`; refresh GET 200. **REAL** `verifyIdToken`. Client sign-out does not invalidate the previous JWT (still 200 until expiry).
- Production project `restoran-30d51` was not the runtime Auth target. Production Auth was not mutated.
- Browser login, signed QR order, authorized two-browser realtime, revocation, reconnect, PG_UNAVAILABLE UI: still **NOT VERIFIED**. STEP 1 RUNTIME overall remains **NOT VERIFIED**. Step 2: **NO-GO**.

## Step 1 isolated browser/runtime acceptance (2026-08-29)

- Probe after frontend/Auth-loader fixes: **READY**. Target `nesta-staging`, emulator `127.0.0.1:9099`, `DATA_BACKEND=postgres`, local fixtures `restaurantCount=2`. Isolated frontend initializes via `loadNestaFirebaseApp()`; no `getApps()` production `restoran-30d51` fallback on acceptance pages. `node --check admin.js` PASS.
- Real browser (origins `http://127.0.0.1:4000` and `http://localhost:4000`): manager login; reload restore; logout storage clear; waiter PIN + settings 403 `role_denied`; foreign GET 403 `restId_mismatch`.
- Signed QR Tenant A table 1: session 200; emulator customer token; PG menu/product/modifier; order total 27000 (25000+2000); forged client price ignored; foreign modifier 403 `modifier_foreign`.
- Data plane: `/api/pg/rtdb/*`; 0 tenant `*.firebaseio.com`. Staff socket `nesta:subscribed`; customer generic room denied. Same-tenant event once; cross-tenant no leak; reload reconnect restored subscribe.
- Immediate revocation on local fixture: blocked admin 403 in 21ms; waiter menu override revoke 403 in 25ms; fixture reseeded. Admin `modules` do not restrict admin role.
- PG_UNAVAILABLE: disposable `:4010` unreachable PG; browser 503; no RTDB fallback. Shared PG/`:4000` kept; `:4010` stopped after.
- CSP functional PASS; not widened. Backend tests 262/0/0 with isolated overlay. Frontend 35/0/0.
- STEP 1 RUNTIME / COMPLETE: **PASS**. Step 2: **GO**. Step 2 was not started. Production Auth not mutated.
