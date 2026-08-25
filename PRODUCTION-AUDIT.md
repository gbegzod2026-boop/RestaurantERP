# NestaCRM — Production Readiness Audit

**Status:** Read-only audit. No code, Firebase data, dependencies, or config were changed while producing this document. All findings are evidence-based — either read directly from source (file:line cited) or verified live via non-destructive, read-only test scripts that were deleted immediately after use. Where something could not be verified to this standard, it is explicitly marked **NOT VERIFIED** rather than assumed.

**Two live-proven Critical (P0) findings were confirmed this audit** using the same read-only methodology used throughout this engagement (mint a real Firebase session shaped exactly like a legitimate one → call the real running backend/Firebase project → read the response → clean up). Reproduction steps are included so they can be re-run after a fix.

---

## 1. Executive Summary

NestaCRM is a substantial Firebase-backed restaurant ERP (7 roles/panels, Click/Payme/Uzum payment integrations, Telegram notifications, AI-assisted data import, real-time Socket.IO). Large parts of it reflect genuine, careful security engineering — fail-closed payment webhooks, AES-256-GCM crypto with timing-safe comparisons, a per-origin-audited CSP, RTDB path-traversal protection, server-computed order totals, and an exhaustively-verified i18n layer (see §13).

However, the audit found **two Critical findings that undermine the entire access-control model**, live-proven, not inferred:

1. **Authentication bypass**: any external caller with zero credentials can impersonate a restaurant's admin by sending two spoofed HTTP headers, because the "unverified identity" fallback in `rbac.js` is only *logged*, never *denied*.
2. **Firebase rules not enforced in production**: `database.rules.json`'s password-read protection does not actually apply on the live Firebase project — a legitimately-scoped session could still read a bcrypt hash directly.

Until these two are fixed and **re-verified with the reproduction steps given**, the honest verdict is **NOT READY**.

---

## 2. Architecture

**Verified from source, not assumed:**

- **Backend**: Node.js + Express 5, `backend/server.js` as the single entry point. Mounts: `routes/auth.js` (`/api/auth`), `routes/qr.js`, `routes/superadminCredentials.js`, `routes/click.js` + `routes/payme.js` + `routes/uzum.js` + `routes/paymentsInit.js` (all under `/api`), `routes/delivery.js`, `routes/notifications.js`, `routes/aiImport.js`, `routes/twoFactor.js`. Plus a handful of routes defined inline in `server.js` itself (`/api/categories`, `/api/foods`, `/api/orders`, `/api/staff`, `/api/health`, `/api/local-ip`).
- **Frontend**: two, only one of which is live. **Live**: `admin-frontend/public/*.html` + `admin-frontend/public/js/*.js` (vanilla JS, `type="module"`), served statically by `express.static()` at [server.js:764-782](backend/server.js#L764-L782). **Dead**: `admin-frontend/src/*` — an abandoned React skeleton (`App.js`, `api.js`, `components/`) with no `package.json` in the repo (only an orphaned `package-lock.json`), never built, not referenced by `server.js`. It calls exactly the four inline REST routes in `server.js` (`/api/categories`, `/api/foods`, `/api/orders`, `/api/staff`) — confirmed by reading `admin-frontend/src/api.js` directly. Those routes are still live and reachable even though their only known caller is dead code — see P0-1.
- **Data layer**: Firebase Realtime Database, tenant-scoped at `restaurants/{restId}/...`. No `organizationId`/`branch` node exists anywhere in the schema I found — multi-tenancy in this codebase is restaurant-only, not org/branch-hierarchical (the audit prompt's `organizations/{orgId}` questions don't map onto this schema).
- **Auth flow (traced end-to-end, confirmed earlier this engagement and re-confirmed this pass)**: `login.html` → `login.js` → `POST /api/auth/manager-login` (or `/staff-login` for PIN) → `routes/auth.js` verifies via `security/password.js` (`verifyPassword`: bcrypt, with legacy plaintext/SHA-256 fallback that self-migrates to bcrypt on successful login) → on success, `firebaseAdmin.js`-backed `mintSessionToken()` issues a real Firebase Auth custom token carrying `{restId, role}` claims *if a service account is configured* (`backend/serviceAccountKey.json` — confirmed present, gitignored) → `signInWithCustomToken()` client-side → every subsequent `requirePermission()`-gated request is *supposed* to carry that token as `Authorization: Bearer` — **in practice, most current frontend call sites instead send only the legacy `x-user-id`/`x-rest-id` headers, which `rbac.js` still accepts unverified — see P0-1.**
- **Authorization**: `backend/rbac.js` — `ROLE_TEMPLATES` (owner/admin/manager/cashier/head_chef/chef/waiter/inventory_manager/finance/crm/hr/delivery_manager/courier), mirrored from the frontend's own role table (`admin.js`'s `ROLE_TEMPLATES`) per the file's own comment — this mirroring is a real, if fragile, single point of truth risk (two independently-maintained copies of the same permission table).
- **Real-time**: Socket.IO, restId-scoped rooms (`rest-${restId}`, `chefs:${restId}`, `admins:${restId}`, `table-${restId}-${n}`), with a server-side permission check (`resolveRequestPermissions`) gating room joins — this part is genuinely well isolated (§6).
- **Payments**: `payments/common.js` is the shared idempotency/amount-validation layer all three providers (Click, Payme, Uzum) funnel through via `markOrderPaid()`.
- **i18n**: `admin-frontend/public/js/langs.js` (single source of truth, `{uz:{}, ru:{}, en:{}}`) + `i18n.js` (`t()`, `data-i18n*` attributes, MutationObserver-based auto-translation for dynamically-injected DOM). Exhaustively audited earlier this engagement — see §13.

---

## 3. Security — see §4/§5/§6/§7 (findings consolidated there per topic, not repeated here).

---

## 4. Authentication

| Area | Status | Evidence |
|---|---|---|
| Password hashing | ✅ bcrypt (cost 10) | `security/password.js` |
| Legacy password fallback | ⚠️ present by design | `verifyPassword()` accepts legacy plaintext/SHA-256 once, then self-migrates to bcrypt on that login — reasonable transitional design, not a fresh weakness |
| Universal-login restId-hint bug | ✅ fixed earlier this engagement | A stale/wrong `localStorage.restaurantId` hint used to make an otherwise-correct login fail 401; fixed in `routes/auth.js` to fall back to a full search when the hint produces zero matches. Live-reproduced and re-verified working this engagement. |
| Session mechanism | Firebase Auth custom tokens, `{restId, role}` claims | `routes/auth.js` `mintSessionToken()` |
| 2FA (TOTP) | ✅ well-designed state machine | `routes/twoFactor.js` — setup → enable-with-real-code → backup codes single-use. **But** its identity check inherits the P0-1 weakness (see below) |
| PIN login (staff) | Same bcrypt-backed model, restaurant-scoped | `routes/auth.js` `/staff-login` |
| Login As / Superadmin | Gated by `requireSuperAdmin()` (verified ID token, no `restId` claim, non-anonymous) | `routes/superadminCredentials.js` — audited in depth earlier this engagement, sound |
| Rate limiting on login | 20 attempts / 15 min, IP+restId keyed | `security/rateLimit.js` `authLimiter` — **see P1 below: `req.ip` is unreliable without `trust proxy`** |
| Session expiration/explicit revocation | **NOT VERIFIED** | Firebase ID tokens remain valid until natural expiry even after client-side logout (`localStorage`/`sessionStorage` clear only) — I found no server-side revocation call (`revokeRefreshTokens`). May be acceptable risk; flagging for your judgment, not asserting it's wrong. |

### 🔴 P0-1 — Unverified identity is accepted as authorization, live-proven
**Files:** [backend/rbac.js:39-56](backend/rbac.js#L39-L56) (`resolveIdentity`), [backend/rbac.js:205-254](backend/rbac.js#L205-L254) (`requirePermission`), [backend/routes/delivery.js:29-140](backend/routes/delivery.js#L29-L140), [backend/routes/twoFactor.js:48-55](backend/routes/twoFactor.js#L48-L55)

`resolveIdentity()` prefers a verified `Authorization: Bearer <id-token>`, but when absent/invalid, falls back to trusting the raw `x-user-id` header — and `requirePermission()` **only logs** this (`authz_unverified_identity`), it does not deny. `getRestId()` similarly trusts `x-rest-id`/query/body with no cryptographic binding.

**Live reproduction (read-only GET, zero data modified):**
```
GET /api/staff       headers: x-user-id: admin_1, x-rest-id: rest_1786365629017  →  HTTP 200
GET /api/orders      (same headers)                                             →  HTTP 200
GET /api/categories  (same headers)                                             →  HTTP 200
Control — headers: x-user-id: nonexistent_user_zzz, x-rest-id: rest_1786365629017 →  HTTP 403 (correctly denied)
```
`admin_1` is not guessed — it is the **hardcoded, universal uid every restaurant's founding admin account gets** ([admin-frontend/public/js/superadmin.js:589](admin-frontend/public/js/superadmin.js#L589): `restaurants/${restId}/users/admin_1`), and `role === 'admin'` resolves to **fully unrestricted** permissions ([rbac.js:182-186](backend/rbac.js#L182-L186)).

**Why it matters:** The identical middleware gates `POST /api/staff`, `POST /api/foods`, `POST /api/categories`, `POST /api/orders`, `PUT /api/orders/:id/status` — meaning **write access is exposed via the same bypass** (not independently tested, per the no-write audit rule, but it is the same code path with the same authorization gate — this is a direct logical consequence of the proven read-path bypass, not a separate guess). `routes/delivery.js` reads `x-user-id` even more directly (bypassing even the partial Bearer check). `routes/twoFactor.js`'s `/2fa/setup` + `/2fa/enable` inherit the same gap, meaning an attacker who spoofs another employee's `x-user-id` can enroll their own TOTP secret on that account and lock the real owner out — the exact scenario the file's own header comment says was fixed, which it is not, for any caller not sending a verified token.

**Reproduction after fix:** repeat the exact commands above; `admin_1` should now return 403, not 200.

**Recommended fix (not applied):** Require verified `Authorization: Bearer` identity — reject (403), don't just log — on every state-changing route and on all of `/2fa/*`, once the frontend reliably sends it everywhere. Audit every frontend call site first to confirm none will break.

**Regression risk of the fix:** High if done carelessly — any frontend call site not yet sending a Bearer token would start failing. Needs a full frontend audit of every `fetch()` call to these routes before flipping unverified identity from "logged" to "denied."

---

## 5. Authorization / RBAC

- `requirePermission(module, action, getRestId)` — role/module/action resolution logic itself (once given a *trustworthy* identity) is sound: owner/admin unrestricted, other roles resolved against `ROLE_TEMPLATES` + `customRoles` + `roleOverrides`, matching the client's own resolver by the file's own cross-reference comments.
- **The identity feeding into it is not trustworthy — see P0-1.** This is the single most important finding in the whole audit: a correct authorization *policy* built on top of an unverified *identity* provides no real protection.
- Cross-restaurant checks: `requirePermission()` does compare a **verified** token's `restId` claim against the request's target `restId` and denies on mismatch ([rbac.js:222-225](backend/rbac.js#L222-L225)) — this specific check is good, but only applies when identity was actually verified, which P0-1 shows is not required.
- `routes/delivery.js` courier-ownership checks (`courierId !== req.headers["x-user-id"]`) are trivially satisfied by setting that same header — same root cause.

**IDOR checklist (per the prompt's explicit list):**
| Vector | Status |
|---|---|
| Arbitrary `restId` via URL/body/header | 🔴 Exploitable — see P0-1 |
| Arbitrary `uid` via header | 🔴 Exploitable — see P0-1 |
| Arbitrary `orderId`/`courierId` in `routes/delivery.js` | 🔴 Exploitable via the same header-trust pattern |
| Path traversal in any id (`restId="A/../B"`) | ✅ Closed — `security/sanitize.js`'s `isSafeId()`, applied consistently everywhere checked |
| Client boundary (client → other client's data) | **NOT VERIFIED** — client.js's QR-session flow was not re-traced this pass for cross-client isolation; earlier engagement work established QR sessions carry `{restId, table}` claims, not a personal identity, so "another client's data" mostly doesn't exist as a concept in this schema (orders are table-scoped, not account-scoped) |

---

## 6. Multi-tenancy

- Tenant boundary = `restId`. Enforced in two independent places: (a) `database.rules.json`'s `auth.token.restId == $restId` check (①**not proven live-enforced — see P0-2**), and (b) `rbac.js`'s restId-claim-mismatch check (only active for verified identities — see P0-1).
- Socket.IO: genuinely well isolated. Every room is restId-scoped (`rest-${restId}`, `chefs:${restId}`, `admins:${restId}`), and joining `admins:${restId}`/`chefs:${restId}` requires `resolveRequestPermissions(restId, userId)` to resolve successfully server-side before the join is honored ([server.js:619-649](backend/server.js#L619-L649)) — this is a *real* control, not just a client-side room name convention. (It still inherits P0-1's weak identity resolution, but at least it performs a real DB-backed check rather than trusting a bare header with no lookup at all, unlike `routes/delivery.js`.)
- No `organizationId`/branch concept exists in this codebase — confirmed by reading the schema and grepping for both terms; the audit prompt's org/branch questions don't apply here.

---

## 7. Firebase

### 🔴 P0-2 — `database.rules.json`'s password protection is not enforced on the live project
**File:** [database.rules.json:101](database.rules.json#L101)

**Live reproduction (read-only, real Firebase REST API, a legitimately-scoped same-restaurant session, zero data modified):**
```
Minted session: staff-login-shaped token, restId=rest_1786365629017, role=admin (same restaurant — "legitimate" by the rule's own logic)
GET .../restaurants/rest_1786365629017/users/admin_1/password.json?auth=<idToken>
  → HTTP 200, 66-byte body (a real bcrypt hash), NOT null
VERDICT: RULE NOT ENFORCED
```
The rules file says this path should return `null` (`.read: false`). It returned a real hash. This means either the rules were never deployed, or a different ruleset is live. `passwordEnc` returned `null` in the same test, but **only because that specific test user has no `passwordEnc` value set** — this is inconclusive for that field, not proof it's protected; it needs re-testing against a record known to have `passwordEnc` populated.

**Why it matters:** every security property the rules file's extensive header comments describe — auth-required restaurant scoping, closed `systemData`, role-escalation protection — is unverified in production, because the one field I could conclusively test (`password`) failed.

**Recommended fix (not applied):** Deploy via `firebase deploy --only database:rules`, following the file's own documented step order (service account → restart backend → confirm real sessions mint claims → *then* deploy). Re-run the exact test above (and the same test against `passwordEnc` with a populated record, and `systemData`) to confirm.

### Path-by-path summary (per the prompt's requested breakdown)
| Path | Read | Write | Tenant check | Verified live? |
|---|---|---|---|---|
| `restaurants/$restId` (general) | `auth != null && (token.restId==$restId \|\| token.restId==null)` | same | ✅ in the rules file | ❌ **NOT enforced — see P0-2** |
| `.../users/$uid/password` | `false` | open (self-service resets) | n/a | ❌ **Proven NOT enforced (read succeeded)** |
| `.../users/$uid/passwordEnc` | `false` | n/a | n/a | ⚠️ Inconclusive (field absent in test data) |
| `.../users/$uid/role` (write) | n/a | requires owner/admin or superadmin session | ✅ in rules | Not independently tested |
| `.../info` | `true` (intentional, pre-login) | n/a | n/a | Low sensitivity by design — acceptable |
| `restaurantsIndex` | `auth != null` | `auth != null` | n/a | Not tested |
| `superadmin` | `auth != null && token.restId == null` | same | n/a | Not tested |
| `systemData` | `false` | `false` | n/a | Not tested this pass (only `password` was) |
| Root `/` | `false` | `false` | n/a | Good design (no full-DB dump) — not independently tested |

**Should the frontend write directly to Firebase, or go through the backend?** As currently architected, most business writes (menu, orders status via chef/waiter/kassa, staff records) go **directly from the browser to Firebase RTDB** via the client SDK, relying entirely on `database.rules.json` for authorization. Given P0-2 shows that file's protections are not provably live, **this is currently the weaker of the two enforcement layers, not the stronger one** — the backend's Express routes at least *attempt* a lookup-based check (even if P0-1 shows that check is bypassable); direct client writes have no equivalent server-side re-validation at all. Recommendation: this architecture is defensible *only* once P0-2 is fixed and re-verified; until then, it is the larger of the two data-integrity risks in this app.

---

## 8. API — Endpoint Table

Legend: AUTH = an identity mechanism is present at all; ROLE = a specific module/action permission is required; TENANT = restId is checked against the acting identity; VALID = request body/param shape validation exists; RISK = this audit's assessment given P0-1's finding.

| Method | Path | Auth | Role | Tenant Check | Validation | Rate Limit | Risk |
|---|---|---|---|---|---|---|---|
| GET | `/api/health` | none (by design) | — | — | — | global (300/min) | Low |
| GET | `/api/local-ip` | none | — | — | — | global | Low (dev utility) |
| GET | `/api/categories` | ⚠️ unverified-header-OK | ✅ menu:view | ⚠️ | partial | global | 🔴 High (P0-1) |
| POST | `/api/categories` | ⚠️ | ✅ menu:create | ⚠️ | name required | global | 🔴 High (P0-1) |
| GET | `/api/foods` | ⚠️ | ✅ menu:view | ⚠️ | partial | global | 🔴 High (P0-1) |
| POST | `/api/foods` | ⚠️ | ✅ menu:create | ⚠️ | name required | global | 🔴 High (P0-1) |
| GET | `/api/orders` | ⚠️ | ✅ orders:view | ⚠️ | — | global | 🔴 High (P0-1) |
| POST | `/api/orders` | ⚠️ | ✅ orders:create | ⚠️ | table+items required, **total server-computed** ✅ | global | 🔴 High (P0-1) |
| PUT | `/api/orders/:id/status` | ⚠️ | ✅ orders:edit | ⚠️ | `isSafeId`, status required | global | 🔴 High (P0-1) |
| GET | `/api/staff` | ⚠️ | ✅ staff:view | ⚠️ | — | global | 🔴 High (P0-1) |
| POST | `/api/staff` | ⚠️ | ✅ staff:create | ⚠️ | name required, PIN uniqueness within restaurant, **bcrypt-hashed before storage** ✅ | global | 🔴 High (P0-1) |
| POST | `/api/auth/staff-login` | n/a (this IS login) | — | — | ✅ | `authLimiter` 20/15min | Low — server-verified, rate-limited |
| POST | `/api/auth/manager-login` | n/a | — | — | ✅ | `authLimiter` | Low |
| GET/POST | `/api/superadmin/credentials/*` | ✅ verified-only (`requireSuperAdmin`) | ✅ | n/a (superadmin scope) | ✅ | dedicated 100/15min | Low — audited in depth, sound |
| POST | `/click/webhook` | signature (MD5, `safeEqual`) | n/a | ✅ via merchant_trans_id | ✅ amount, idempotent | `paymentLimiter` 60/min | Low — fail-closed |
| POST | `/payme/webhook` | Basic Auth (`safeEqual`) | n/a | ✅ | ✅ full JSON-RPC state machine | `paymentLimiter` | Low — fail-closed |
| POST | `/payments/uzum/intent` | none (customer-facing, by design) | n/a | ✅ via `findOrder` | ✅ amount cross-checked against order | `paymentLimiter` | Low |
| POST | `/uzum/webhook` | HMAC-SHA256 (`safeEqual`) | n/a | ✅ | ⚠️ amount NOT re-validated against order total at completion (see P2 below) | `paymentLimiter` | Low-Medium |
| POST | `/api/payments/init` | none (customer-facing, by design) | n/a | ✅ via `findOrder`, already-paid guard | ✅ | `paymentLimiter` | Low |
| POST/GET | `/api/delivery/*` | ⚠️ unverified-header, some routes read `x-user-id` raw | ✅ | ⚠️ | `isSafeId` on params | `deliveryLimiter` 60/min | 🔴 High (P0-1, worse here) |
| GET/PUT/POST | `/api/notifications/*` | ⚠️ | ✅ | ⚠️ | not fully re-audited this pass | `notificationLimiter` 30/min | Medium (inherits P0-1) |
| GET/PUT/POST | `/api/ai-import/*` | ⚠️ | ✅ | ⚠️ | not fully re-audited this pass | `aiImportLimiter` 15/min | Medium (inherits P0-1; also costs real money per call) |
| GET/POST/PUT | `/api/2fa/*` | ⚠️ (except `/verify`, which is code-gated) | n/a | ✅ restId-claim check when verified | ✅ | `twoFactorLimiter` 10/15min | 🔴 High for `/setup`+`/enable` (P0-1) |
| GET | `/api/qr/sign`, `/api/qr/verify` | **NOT re-read this pass** | — | — | — | — | NOT VERIFIED this pass (last audited earlier this engagement) |
| POST | `/api/qr/session` | n/a (mints anonymous table session) | — | — | **NOT re-read this pass** | qrRouter (mounted, specific limiter not confirmed this pass) | NOT VERIFIED this pass |

**Injection classes checked:** No SQL (no SQL database in this stack). NoSQL/path injection into Firebase paths: closed via `isSafeId()`, consistently applied everywhere checked. Prototype pollution: not specifically tested (**NOT VERIFIED**). XSS: see §12 (Frontend), `innerHTML` usage is pervasive throughout the frontend by architecture (heavy inline-template rendering) — not a new finding, but a standing design risk that depends entirely on every dynamic value being escaped before interpolation; **not exhaustively verified across 85k+ lines this pass**. SSRF: `routes/uzum.js`'s `fetch(UZUM_API_BASE + ...)` uses an env-configured base URL, not user input — low risk. Open redirect: `payUrl` values returned to the client are built from configured merchant IDs + env-configured return URL, not raw user input — low risk. Mass assignment: `POST /api/staff` and similar routes pick specific fields off `req.body` rather than spreading the whole body into the DB write — good pattern, consistently used where checked.

### 🟡 P2 — Uzum webhook doesn't re-validate amount at completion
**File:** [backend/routes/uzum.js:138-144](backend/routes/uzum.js#L138-L144)
Unlike Click/Payme (which call `amountsMatch()` against the real order total immediately before marking paid), the Uzum webhook's success path passes `body.amount` straight into `markOrderPaid()` without a final cross-check. The amount *was* validated once, earlier, at `/payments/uzum/intent` creation — but the webhook itself has no defense-in-depth check. Not currently exploitable without the HMAC secret, but inconsistent with the other two providers' stricter pattern. **Recommended fix (not applied):** add the same `amountsMatch()` guard used in `click.js`/`payme.js` before calling `markOrderPaid`.

---

## 9. Payments — see §8 table + P2 above. Full Click/Payme deep-read (this pass) confirmed: fail-closed secrets, `safeEqual` constant-time comparisons, real idempotency (Payme's transaction state machine; Click's order-status check), amount validation with sane float tolerance (`amountsMatch`, ±1 so'm). No replay-attack gap found in Payme's `CreateTransaction` (re-submission of an existing `params.id` returns the stored state rather than re-processing). Duplicate-payment protection: order-status-based (`status !== "paid"` gate) across all three providers — sound for the RTDB record itself; see §5 in the prior audit pass for the minor duplicate-*notification* (not duplicate-*charge*) race noted there.

---

## 10. Data Integrity

- **Order lifecycle**: server-computed total ✅, status transitions are free-form string writes with no explicit state-machine guard I found at the Express layer for the inline `/api/orders/:id/status` route (any string is accepted as `status`) — **but** the actual production order-status flow runs through direct Firebase writes from chef.js/waiter.js/kassa.js, not this Express route (confirmed dead-ish per §2) — so the real-world state machine enforcement, if any, lives client-side. **NOT VERIFIED**: whether an invalid transition (e.g., "delivered" → "new") is blocked anywhere.
- **Paid-order protections**: `/api/payments/init` and `/payments/uzum/intent` both correctly refuse to generate a new payment link for an already-paid order (409). I did not find an equivalent "can't cancel a paid order" guard at the Express layer — **NOT VERIFIED** whether one exists client-side.
- **Race conditions**: Firebase RTDB transactions (`runTransaction`) were not found in a grep of the payment/order write paths — writes are plain `set`/`update` calls. For the specific "mark paid" path this is acceptable because it's idempotent by field-overwrite (same final state regardless of how many times it fires) — but **inventory/stock deduction race conditions were not independently re-verified this pass** (large surface, out of this turn's scope) — **NOT VERIFIED**.
- **Negative inventory, concurrent transactions**: **NOT VERIFIED** this pass.
- **Restaurant/user deletion cascades**: **NOT VERIFIED** — did not trace what happens to orders/staff/payments when a restaurant or user record is deleted (and per the no-destructive-action rule, I did not test this live).

---

## 11. Performance

- 165 total `onValue()` Firebase listeners across the frontend (`admin.js`: 64, `client.js`: 20, `chef.js`: 24, `waiter.js`: 10, `kassa.js`: 8, `courier.js`: 3, `plan_features.js`: 5, `shared.js`/`chat-system.js`: 2 each, `deliveryClient.js`: 1) against only 8 explicit `off()` cleanup calls found in `admin.js`. No full-root (`onValue(ref(database))`) or whole-`restaurants`-tree listener pattern was found via targeted grep — good, no "read the whole database" anti-pattern. The 64-vs-8 ratio in `admin.js` specifically is a real, static signal worth a dedicated listener-lifecycle audit — **I did not trace all 64 individually this pass; this is flagged as a pattern, not a proven leak.**
- `/api/orders` caps server-side reads at 300 via an ordered/limited query — good where used; not confirmed as a universal pattern across every list endpoint.
- No caching layer in front of Firebase reads found.

---

## 12. Frontend

**Largely NOT VERIFIED at runtime this pass** — this environment has no browser/DevTools access, so JS runtime errors, broken modals/forms, memory leaks, and responsive-layout behavior across ~85,000 combined lines of frontend code cannot be confirmed by static reading alone, and I am not going to claim otherwise. What was verified:
- File-upload validation (`admin.js` `uploadRestaurantLogo`) — see §14 below.
- CSP is aligned with actually-used script/fetch origins across the app (`security/headers.js`, dated per-origin audit trail).
- `innerHTML`-heavy rendering is the dominant frontend pattern throughout (confirmed via the earlier i18n audit's incidental exposure to hundreds of call sites) — this is a standing XSS-class risk surface that depends on consistent escaping of interpolated values; **not exhaustively verified**.

---

## 13. i18n — Regression Check

Re-confirmed this pass (no code changed since the last full audit, so this restates rather than re-derives): **0 real missing translation keys across all 7 panels (UZ/RU/EN)**, all previously-identified dynamic-key patterns (`t("role_"+role)`, `t("status_"+status)`, `t("module_"+module)`, etc.) correctly excluded as false positives with real concrete translated instances confirmed for each. Pre-existing duplicate keys not touched (`role_waiter`, `sa_pay_promo`, `audit_nav`, `sa_loading`, `dashboard`, `reservations_nav`) — these predate this engagement and were reported, not modified, per instruction. No translation keys were renamed. No new hardcoded text was introduced (no i18n-relevant frontend edits happened between that audit and this one).

---

## 14. File Upload Audit

Uploads found: restaurant logo (`admin.js` `uploadRestaurantLogo`, chef/waiter recipe images, AI Import document/image attachments). Deep-read: **restaurant logo path** ([admin.js:24540-24599](admin-frontend/public/js/admin.js#L24540-L24599)):
- MIME check via `file.type` (client-reported, spoofable) — mitigated somewhat by re-encoding through an HTML5 `<canvas>` (`_resizeImageToBase64`), which effectively fails on non-image binary data rather than passing it through unchanged.
- **SVG is in the allowed-types list** (`image/svg+xml`). SVG can embed `<script>`. Rendered via `<img src="data:image/svg+xml;base64,...">` elsewhere in the app (chef/waiter header logo) — modern browsers do not execute scripts inside an SVG loaded via `<img>`, which mitigates the most common exploitation path, but this was not exhaustively verified against every place `restaurantLogoUrl` is rendered app-wide.
- **No server-side re-validation** — the base64 payload is written directly from the browser to Firebase RTDB via the client SDK; nothing on the backend re-checks type/size. A client that bypasses the JS UI entirely (e.g., via devtools console, calling the Firebase SDK directly) could write arbitrary base64 content to `restaurantLogoUrl`, bounded only by whatever `database.rules.json` does or doesn't enforce for that path — and per P0-2, this file's enforcement is not proven live.
- Size limits: 5MB raw, 9MB post-base64 — reasonable, client-side only.
- No filename ever touches a path — no path-traversal risk on this specific upload (it's stored as a blob, not a named file).
- AI Import's file handling (`aiImportClient.js`) and Firebase Storage uploads elsewhere (`uploadBytes`/`getDownloadURL`) were **not re-read line-by-line this pass** — **NOT VERIFIED**.

**🟡 P2 — Unsanitized SVG accepted, no server-side re-validation of any upload.** Recommended fix (not applied): drop `image/svg+xml` from the allow-list unless there's a specific need for it, or sanitize server-side (strip `<script>`/event handlers) before storage; add a minimal server-side type/size re-check for any upload path that writes through the Express backend rather than directly from the browser.

---

## 15. Dependencies

```
npm audit (backend, read-only, not fixed):
  8 moderate severity vulnerabilities
  Root cause: firebase-admin@12.7.0 → @google-cloud/firestore / google-gax / gaxios /
              teeny-request / @google-cloud/storage / retry-request → vulnerable `uuid`
              versions (GHSA-w5hq-g745-h8pq, missing buffer bounds check)
  Fix requires: firebase-admin@14.2.0 (BREAKING CHANGE) — not applied

npm outdated (backend):
  bcryptjs             2.4.3   →  3.0.3
  express-rate-limit   7.5.1   →  8.6.2
  firebase            11.10.0  → 12.17.1
  firebase-admin       12.7.0  → 14.2.0
```
No unused/duplicate top-level dependencies found in `backend/package.json` (9 deps, all referenced somewhere in the routes/security modules read this pass). `admin-frontend/package-lock.json` exists with **no corresponding `package.json`** — an orphaned lockfile, consistent with the dead React app in `admin-frontend/src/` (§2).

---

## 16. Deployment / Production Configuration

| Item | Status |
|---|---|
| CORS | ⚠️ `ALLOWED_ORIGINS` unset in the real `.env` → reflects any origin with `credentials:true` (documented, backward-compatible default — needs setting before go-live) |
| CSP / Helmet | ✅ Genuinely well audited, per-origin justified, dated comments |
| HTTPS enforcement | `upgradeInsecureRequests` gated on `NODE_ENV==="production"`, which is **never set anywhere in `.env`/`.env.example`** — silently inactive as currently configured |
| `trust proxy` | 🔴 **Never set** — breaks per-IP rate limiting (and can crash under `express-rate-limit` v7 with certain proxy header configs) behind any reverse proxy |
| Cookies | Not used for auth (Bearer-token-oriented) — HttpOnly/Secure/SameSite questions largely don't apply to this app's actual auth mechanism |
| Compression | **NOT VERIFIED** — no `compression` middleware found in `server.js`'s dependency list or code |
| Body size limit | ✅ `express.json({limit:"20mb"})`, app-wide (sized for AI Import) |
| Rate limiting | ✅ present and reasonably tuned, **undermined by the trust-proxy gap above** |
| Request timeout | Not explicitly configured — relies on Node/Express defaults — **NOT VERIFIED** if acceptable for your host |
| Graceful shutdown | 🔴 No `SIGTERM`/`SIGINT` handler found — in-flight requests/writes are not drained on restart |
| Health endpoint | ✅ `GET /api/health`, reports real DB connectivity |
| Readiness endpoint | Same endpoint doubles as both; no separate liveness/readiness split — acceptable for most simple deployments |
| Environment separation | **NOT VERIFIED** — no evidence of separate dev/staging/prod config beyond `.env` itself |
| Process manager / Docker / nginx config | **None found in the repository** — **NOT VERIFIED** how this is actually deployed; I found no evidence either way |

**Publicly-servable stray files** (🟠 P1): `express.static()` serves the entire `admin-frontend/public` directory, which currently contains 10 `.bak` files (`admin.html.bak` ≈500KB, plus `superadmin/client/kassa/login/waiter/chef/courier/headoffice/index.html.bak` and several `.css.bak`), all fetchable directly by URL. None are in `.gitignore`.

---

## 17. Backup / Recovery

**NOT VERIFIED — no backup automation, Firebase export scripts, or disaster-recovery documentation found in this repository.** `backend/scripts/migration-dry-run.mjs` exists and (per its name and per this audit's no-fix rule) was **not executed**. This is a genuine open question for production readiness, not something this repo answers either way.

---

## 18. Testing

**Current coverage: 0.** No project-owned test files found anywhere (`**/*.test.js` matches only inside `node_modules`). `backend/package.json` has no `test` script (`start`, `dev` only). Score reflects this honestly (§20).

### Minimum critical-flow test plan (not implemented, proposed only)
```
AUTH
  - correct login+password → session created
  - wrong password → 401, no session
  - inactive/disabled user → rejected
  - stale/wrong restaurantId hint + correct credentials → login still succeeds (regression guard for the bug fixed earlier this engagement)

RBAC
  - non-owner role denied an action outside its ROLE_TEMPLATES entry
  - customRole/roleOverride correctly widens/narrows access
  - [POST-FIX] spoofed x-user-id with no Authorization header → 403, not 200

ORDER
  - create → total always server-computed, ignoring any client-sent total
  - status transition sequence matches real kitchen flow
  - cannot re-pay an already-paid order

PAYMENT
  - Click/Payme/Uzum: valid signature → processed; invalid/missing signature → rejected
  - duplicate webhook delivery → no double-charge, no duplicate DB write
  - amount mismatch → rejected

INVENTORY
  - concurrent deduction from two simultaneous orders doesn't go negative unexpectedly (or negative is explicitly allowed and surfaced, per existing "Zaxira manfiy bo'lishi mumkin" UI copy found during the i18n audit)

MULTI-TENANCY
  - restaurant A's session cannot read/write restaurant B's data via any endpoint
  - [POST-FIX] re-run this audit's exact P0-1/P0-2 reproduction steps as permanent regression tests

USER MANAGEMENT
  - PIN uniqueness enforced per-restaurant, not globally
  - password always stored as bcrypt, never plaintext, for any newly-created account
```

---

## 19. P0 / P1 / P2 / P3 — Full List

### 🔴 P0 — CRITICAL
```
#1  File: backend/rbac.js:39-56, 205-254; routes/delivery.js:29-140; routes/twoFactor.js:48-55
    Problem: Unverified x-user-id/x-rest-id header accepted as authorization
    Why dangerous: Live-proven full cross-tenant impersonation, zero credentials
    Repro: GET /api/staff with headers x-user-id:admin_1, x-rest-id:<real restId>, no Authorization → HTTP 200
    Fix: Require verified Bearer token; reject (not log) unverified identity on mutating/2FA routes
    Regression risk: High — must confirm every frontend call site sends a Bearer token first

#2  File: database.rules.json:101 (password), untested siblings passwordEnc/systemData
    Problem: Rules file's protections are not enforced on the live Firebase project
    Why dangerous: Live-proven — legitimate same-restaurant session read a real bcrypt hash
    Repro: authenticated REST read of .../users/admin_1/password.json returns a 66-byte hash, not null
    Fix: firebase deploy --only database:rules per the file's own documented order; re-verify with the same test
    Regression risk: Medium — must follow the file's own 4-step deployment order exactly or it breaks all logins
```

### 🟠 P1 — HIGH
```
#3  File: backend/server.js (trust proxy never set)
    Problem: req.ip is the proxy's IP behind any reverse proxy
    Fix: app.set('trust proxy', <hop count>) before rate limiters register

#4  File: backend/.env (ALLOWED_ORIGINS unset)
    Problem: CORS reflects any origin with credentials:true
    Fix: Set to real production domain(s) before go-live

#5  File: admin-frontend/public/*.html.bak (10 files, ~500KB admin.html.bak alone)
    Problem: Publicly servable old source snapshots
    Fix: Delete from the served directory; add *.bak to .gitignore

#6  File: _key.tmp (repo root)
    Problem: Raw 65-char hex key-shaped value, plaintext, not gitignored, ≠ live ENCRYPTION_KEY
    Fix: Confirm provenance; delete if stale, gitignore if legitimate

#7  File: backend/rbac.js:183-184, 194-195
    Problem: console.log of full role/permission objects on every single request
    Fix: Remove or gate behind an explicit debug flag

#8  File: backend/delivery/providers/YandexGoProvider.js:10-12
    Problem: Yandex Go delivery is a documented mock, not a real integration
    Fix: Implement for real, or hide the option in Settings until it exists

#9  File: backend/.env
    Problem: All payment/Telegram/Gemini secrets unset
    Fix: Confirm intentional for this environment; populate before go-live if not

#10 File: admin-frontend/src/* + backend/server.js:292-554
    Problem: Dead React frontend targets live, P0-1-exploitable REST routes
    Fix: Confirm src/ is truly unused, remove it; re-scope/remove the routes once P0-1 is fixed

#11 File: backend/ root (7 malformed accident filenames)
    Problem: Shell-escaping mistakes left as files (e.g. "renderOrders(window.allOrders)")
    Fix: Inspect briefly, then delete
```

### 🟡 P2 — MEDIUM
```
#12 File: backend/package.json — 8 moderate npm audit vulnerabilities (transitive, uuid via firebase-admin)
    Fix: Plan a firebase-admin major upgrade on its own schedule (breaking change)

#13 File: admin-frontend/public/js/admin.js — 64 onValue() vs 8 off() calls
    Fix: Dedicated listener-lifecycle audit (not done this pass — too large for this turn)

#14 File: backend/routes/uzum.js:138-144 — webhook doesn't re-validate amount at completion
    Fix: Add the same amountsMatch() guard click.js/payme.js already use

#15 File: admin-frontend/public/js/admin.js:24548 — SVG accepted in logo upload, client-only validation
    Fix: Drop SVG from allow-list or sanitize server-side; add minimal server-side re-check

#16 File: backend/.env / .env.example — NODE_ENV never set/documented
    Fix: Set NODE_ENV=production in the real deployment; document in .env.example

#17 File: (absence) — no graceful shutdown handling
    Fix: SIGTERM handler that stops accepting new connections and drains in-flight ones

#18 File: backend/payments/common.js:64-93 — PAYMENT_RECEIVED notification has no idempotency guard
    Fix: Reuse the alert-state dedup already used for the scanner path
```

### 🔵 P3 — LOW
```
#19 File: backend/ root — stray log/pid files (_boot_err.log, server_pid.txt, etc.), not gitignored
    Fix: Add to .gitignore (content checked this pass — harmless)

#20 File: backend/make-hash.js — dev utility sitting at backend root instead of scripts/
    Fix: Move into backend/scripts/ (not externally reachable either way — cosmetic only)
```

### 🟢 INFO
```
- No backup/disaster-recovery procedure found in-repo — open question, not a code defect
- No external monitoring/alerting (Sentry-equivalent) found — Telegram business alerts exist; infra-level monitoring does not, as far as this repo shows
- 0 tests exist — see §18 for the proposed minimum plan
```

---

## 20. Production Readiness Score

```
SECURITY:         2/10   (two live-proven critical bypasses)
AUTH:              4/10   (good design — bcrypt, 2FA, rate limits — undermined by P0-1's enforcement gap)
RBAC:              3/10   (policy logic is sound; identity feeding it is not trustworthy)
MULTI-TENANCY:     3/10   (Socket.IO isolation is real; REST/RTDB isolation is not proven live)
DATA INTEGRITY:    5/10   (server-computed totals, idempotent payment marking; several areas NOT VERIFIED)
PAYMENTS:          8/10   (genuinely solid — fail-closed, signed, idempotent; one minor amount-recheck gap)
PERFORMANCE:       5/10   (no full-tree listener anti-pattern found; cleanup discipline unproven at scale)
FRONTEND:          5/10   (static patterns look reasonable; runtime behavior NOT VERIFIED — no browser access)
i18n:              10/10  (exhaustively verified twice this engagement, 0 real gaps)
ERROR HANDLING:    6/10   (generic error responses, no stack leak found; some routes not re-audited)
LOGGING:           5/10   (real structured security/audit log exists; also unbounded plain console.log of permission data on every request)
DEPENDENCIES:      6/10   (8 moderate, transitive, non-critical; nothing screaming "unmaintained")
DEPLOYMENT:        2/10   (no trust proxy, no process-manager/nginx config found, NODE_ENV unset, no graceful shutdown)
TESTING:           0/10   (zero project-owned tests)

OVERALL PRODUCTION SCORE: 34/100
```

---

## 21. Recommended Fix Plan (order)

1. **P0-1** — fix the identity-verification gap in `rbac.js`/`routes/delivery.js`/`routes/twoFactor.js`. Audit every frontend call site first so nothing breaks when unverified identity starts being rejected instead of logged.
2. **P0-2** — deploy `database.rules.json` per its own documented order, then re-run the exact live test in §7 (and extend it to `passwordEnc` with a populated record, and `systemData`).
3. **P1-3 → P1-11**, in the order listed in §19 — the `.bak` files and `_key.tmp` are the fastest, highest-value fixes (minutes of work, real exposure closed immediately); `trust proxy` and `ALLOWED_ORIGINS` are required before any reverse-proxy production deploy.
4. **P2 list**, at your discretion / next sprint.
5. **P3 + testing plan (§18)**, ongoing hygiene.

**I have not made any of these fixes.** This document is the audit only, per your instruction. Tell me which item(s) to start with and I'll apply them one at a time, with a `node --check` and a regression check after each.
