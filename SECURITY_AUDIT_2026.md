# Nesta ERP — Production Security Audit (2026)

> **Round 2 addendum** (Socket.IO restaurant isolation, additional XSS
> gaps, Electron/Storage/CSRF/file-upload review) is at the bottom of this
> document, after Part 2.

This document records what the security audit found, what was fixed in this
pass (low-risk, additive, backward-compatible), and — separately — the
proposed design for the one structural gap that was **not** touched without
sign-off: Firebase Realtime Database rules being open by design.

---

## Part 1 — What was implemented

All changes are additive: new files under `backend/security/`, new optional
routes, and small guard clauses inserted into existing handlers. No existing
route signature, response shape, or business rule changed. `npm audit`: 0
vulnerabilities (was 6: 1 low / 1 moderate / 4 high) after `npm audit fix`.

| Area | What changed | Files |
|---|---|---|
| HTTP security headers | Helmet: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy | `security/headers.js`, `server.js` |
| CORS | Configurable origin allowlist via `ALLOWED_ORIGINS`; unset = unchanged legacy behavior | `security/headers.js`, `server.js` |
| Rate limiting | Per-surface limits (auth-adjacent, payments, AI Import, notifications, delivery, 2FA, global) | `security/rateLimit.js`, `server.js` |
| Restaurant isolation / path injection | `restId`/`orderId`/`userId`/`courierId` validated as safe single path segments before touching any Firebase path — closes a gap where a crafted id could make a request authorized for restaurant A actually touch a different path | `security/sanitize.js`, `server.js`, `rbac.js`, `routes/*.js`, `payments/common.js` |
| Audit logging | `restaurants/{id}/auditLog` — who/when/IP/user-agent/module/action/details, on order/menu/staff mutations | `security/auditLog.js`, `server.js` |
| Security logging | `systemData/securityLog` — auth/authz denials, rate-limit hits, 2FA events, separate from the audit log | `security/auditLog.js`, `rbac.js`, `security/rateLimit.js`, `routes/twoFactor.js` |
| 2FA (TOTP) | Optional, opt-in, per-employee (owner/admin/manager) — RFC 6238, hand-rolled with Node `crypto` (no new dependency), AES-256-GCM at rest, backup codes, wired into `login.js` only for accounts that enable it | `security/totp.js`, `security/crypto.js`, `routes/twoFactor.js`, `login.js` |
| Payment webhook hardening | Timing-safe signature/secret comparison (Click MD5 sign, Payme Basic Auth key, Uzum HMAC) instead of `===`; loud warning when Uzum signature verification is disabled (no secret configured) | `security/crypto.js`, `routes/click.js`, `routes/payme.js`, `routes/uzum.js` |
| XSS via Telegram | Every user-supplied field (customer review comments, cancellation reasons, staff/supplier/dish names, system error messages) now HTML-escaped before being sent with `parse_mode: "HTML"` — the dashboard-bot templates already did this; the instant-alert and scheduled-report templates didn't | `notifications/templates.js` |
| AI prompt-injection defense-in-depth | Length cap on the free-text `instruction` field that reaches the Gemini system prompt; unchanged the existing (already solid) server-side schema re-validation on commit | `routes/aiImport.js` |
| Secrets | Confirmed `.env` is gitignored and was never committed; confirmed no Firebase/Telegram/Gemini/payment secret appears in `admin-frontend/`; documented `ENCRYPTION_KEY` requirement for 2FA | `.env.example` |

### Explicitly NOT changed (by design, per your constraints)

- **Employee PIN/password storage** — still plain text in Firebase, still
  compared client-side in `login.js` (including the pre-existing plaintext
  fallback `user.password === passVal`). This *cannot* be hashed without also
  moving verification server-side (bcrypt hashes can't be compared in the
  browser), which is exactly the work scoped in Part 2 below. Doing it
  half-way would either break every existing employee's login or add a
  second, parallel, still-insecure comparison path.
- **Firebase Realtime Database rules** (`database.rules.json`) — untouched.
  See Part 2.
- Business logic, response shapes, existing permission model, module
  structure — untouched everywhere.

### Known residual gap worth flagging

`routes/payme.js` writes to `systemData/paymeTxIndex/{id}` and this audit's
new `security/auditLog.js` writes to `systemData/securityLog` using the same
Firebase **client** SDK (`firebase`, not `firebase-admin`) with no
authenticated session — i.e. as `auth == null`. The checked-in
`database.rules.json` gives `systemData` no explicit rule, which under
Firebase's cascading-rules model means it inherits the root's
`".read": false, ".write": false}`. If the *live* rules on the Firebase
console actually match this file, both the pre-existing Payme index writes
and the new security-log writes would be silently rejected (both are
wrapped in non-fatal try/catch, so nothing crashes — they'd just silently
not persist). This audit could not verify the live rules against this file
without console access. **Recommended next step:** compare
`database.rules.json` against what's actually deployed
(`firebase database:get / rules:get` or the console), and if they differ,
either redeploy this file or add an explicit `systemData` rule scoped to
what the backend needs.

---

## Part 2 — Proposed design: closing the Firebase rules gap (NOT executed)

### The problem, precisely

```json
"restaurants": { "$restId": { ".read": true, ".write": true } }
```

Anyone who has the Firebase web config (public by necessity — it's shipped
to every browser in `login.js`) can read or write **any** restaurant's
entire data tree directly via the Firebase REST API or SDK, bypassing
`server.js`/`rbac.js` entirely. This is why the rules file's own comments
call it a known limitation: employee login never creates a real Firebase
Auth session, so rules have no `auth.uid` to check module/action permissions
against.

### Why it can't be fixed by editing the rules file alone

Tightening `restaurants/$restId` to `"auth != null"` today would instantly
break every employee login and every direct-Firebase read/write in the
~32,500-line `admin.js`, because none of that traffic carries a Firebase
Auth session. The rules and the login model have to change together.

### Recommended target design: Firebase Custom Tokens

1. **Add `firebase-admin`** to the backend (server-only; needs a service
   account — store as `FIREBASE_SERVICE_ACCOUNT_JSON` in `.env`, matching
   this app's existing "secrets live only in `.env`" convention, never a
   checked-in file).
2. **New backend endpoint**, e.g. `POST /api/auth/login`:
   - Accepts `restId` + PIN (staff) or `login`+password (manager/admin).
   - Verifies the credential **server-side** against Firebase (bcrypt-hashed
     going forward — see below).
   - On success, mints a Firebase **custom token** via
     `admin.auth().createCustomToken(uid, { restId, role })`, where `uid` is
     a stable, namespaced id (e.g. `emp:{restId}:{userId}`) so tokens from
     different restaurants/employees can never collide.
3. **`login.js` change**: instead of finishing login with `sessionStorage`
   writes only, call the new endpoint, then
   `signInWithCustomToken(auth, token)` — this gives the browser a *real*
   Firebase Auth session for the first time, with `auth.uid` and (via a
   custom claim) `restId`/`role` that **Security Rules can actually check**.
4. **Rewrite `database.rules.json`** once (3) ships, e.g.:
   ```json
   "restaurants": {
     "$restId": {
       ".read":  "auth != null && auth.token.restId === $restId",
       ".write": "auth != null && auth.token.restId === $restId"
     }
   }
   ```
   with finer per-path rules (orders, finance, staff, etc.) layered in as a
   second pass, each checking `auth.token.role`/custom claims — this is where
   the module/action granularity `rbac.js` already computes server-side can
   finally be enforced by Firebase itself too, not just by the Express
   routes.
5. **Password/PIN hashing** becomes possible in the same change: since
   verification moves server-side (step 2), employee PINs/passwords can
   finally be bcrypt-hashed at rest — the browser never needs to compare
   against them again.
6. **Migration path for existing data**: no schema change needed for
   `restaurants/{id}/users/{id}` records themselves; a one-time backend
   script re-hashes existing plaintext passwords/PINs with bcrypt the first
   time this ships (keep the plaintext-compare fallback for exactly one
   deploy cycle, logged loudly, then remove it).

### Sizing

This is a genuine multi-week project for a codebase this size (32k-line
`admin.js` making direct Firebase calls throughout), not a config change:
touches every login surface (staff PIN, manager/admin, and — separately,
since it uses real Firebase Auth already — SuperAdmin), needs the custom
claims threaded through `admin.js`'s existing session model, needs the rules
rewritten and tested per-module, and needs a rollout plan that doesn't lock
out restaurants mid-migration. Recommend scoping it as its own tracked
project with a staging environment, rather than folding it into this audit.

### Interim mitigation available today (lower effort, worth considering separately)

Route **all** writes through the Express backend (proxy pattern) instead of
letting `admin.js` write to Firebase directly, keeping `rbac.js` as the sole
authorization point and using the Realtime Database purely as backend-only
storage (rules tightened to deny all direct client access). This avoids the
custom-token/Auth work but requires rewriting every direct
`set()`/`update()`/`push()` call in `admin.js` into a REST call — a smaller
but still substantial rewrite, and it loses Firebase's live `onValue()`
realtime listeners unless paired with Socket.IO events for every write (the
delivery/notifications modules already show this pattern working). Flagging
as an alternative, not a recommendation — the custom-token approach above
keeps more of the existing realtime architecture intact.

---

## Round 2 addendum

A second pass, focused on what Round 1 flagged but didn't finish, plus the
audit categories not yet covered (Socket.IO, Electron, Storage rules, file
upload, CSRF).

### Fixed: Socket.IO had no restaurant isolation (critical)

**Finding.** `admins` and `chefs` were single global Socket.IO rooms shared
by *every* restaurant on the backend instance, and joining either required
no credential: `socket.on("admin-connect", () => { socket.join("admins"); })`
accepted the join unconditionally. A raw Socket.IO client — no browser, no
login, nothing but the server's URL — could connect and emit `"admin-connect"`
to receive `delivery:updated` events (customer address/phone, courier,
order total) for every restaurant on the platform via
`delivery/engine.js`'s `_io.to("admins").emit(...)`. The `"chefs"` room had
the same problem, consumed by `chef.js` (the one actively-used Socket.IO
client in the current frontend — traced every other page: `admin.js` opens
a socket but never emits `admin-connect` or listens for anything over it
today, `client.js`/`waiter.js`/`kassa.js`/`courier.js` don't touch
Socket.IO at all, and `alohida.js` — the only file that emitted
`"client-connect"`/`"new-order"` — isn't loaded by any HTML page, i.e. dead
code). Table rooms (`table-{n}`) were also unscoped, meaning table "1" in
restaurant A and table "1" in restaurant B were the same room.

**Fix.** `admins`/`chefs`/table rooms are now scoped by restId
(`admins:{restId}`, `chefs:{restId}`, `table-{restId}-{n}`). Joining
`admins:*`/`chefs:*` now requires the same identity check every REST
endpoint already performs — `rbac.js`'s `resolveRequestPermissions(restId, userId)`
must resolve to a real employee of that restaurant, logged as a
`socket_join_denied` security event on failure. `chef.js` was updated to
send its already-known `restId` in the `chef:join` payload (required — this
is the one live consumer, so without this change the fix would have broken
kitchen real-time alerts entirely; verified via syntax check + a clean
server smoke-test after the change). The four dead-broadcast events
(`order:created`, `food:created`, `category:created`, `order:updated` on
create) — confirmed via search to have zero frontend listeners anywhere —
were also moved off the global `io.emit()` onto a `rest-{restId}` room, so
even though nothing consumes them today, they no longer go out over the
wire to every other restaurant's open browser tab either.

**Residual, accepted for now:** the public table-ordering Socket.IO path
(`client-connect`, `new-order` from `alohida.js`) is dead code — not wired
into any page — so its isolation fix is inert until that flow is revived;
flagging so it isn't assumed live. `menu-updated` stays a global broadcast
(payload is just `{timestamp}`, no restaurant data, so cross-tenant exposure
is nil).

### Fixed: additional stored-XSS gaps in `admin.js`

Round 1 covered Telegram templates. A targeted search of `admin.js` for the
`notes`/`comment` fields the spec calls out found renders that use
`escapeHtml()` almost everywhere already (the codebase has 6+ existing
escaping helpers across its files) — but 4 call sites rendered a `.note`/
`.category`/`.title`/`.requesterName` field straight into `innerHTML`
unescaped: the Expenses list and Expenses report table (`e.note`, `e.name`,
`e.category`), and the Approval Requests card (`req.title`,
`req.requesterName`, `req.note`). All four now go through the same
`escapeHtml()` already used elsewhere in the file. Given `admin.js` is
~32,500 lines with 800+ `innerHTML` assignments, this was a targeted search
on the specific fields named in the spec (notes/comments), not an
exhaustive line-by-line pass of every occurrence — flagging that limit
honestly rather than claiming full coverage.

### Reviewed, no code change needed

- **Electron/Desktop** — no Electron code exists in this repo yet (no
  `electron` dependency, no `BrowserWindow`/`nodeIntegration`/
  `contextIsolation` references anywhere). Nothing to audit. **When it's
  added**, apply before shipping: `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, a `preload.js` using
  `contextBridge.exposeInMainWorld` with an explicit allowlisted API
  surface (never `require` exposed to the renderer), and validate every
  argument on every exposed IPC channel server-side (main process), since
  the renderer must be treated as untrusted the same way a browser tab is.
- **Firebase Storage rules** — `firebase.json` only configures Realtime
  Database rules (`database.rules.json`); there is no `storage` key and no
  `storage.rules` file. AI Import handles files as base64 in the JSON body
  (see `backend/aiImport/`), not via Firebase Storage, so there's no
  Storage bucket in use to write rules for today.
- **File upload (multer/formidable/multipart)** — none found; confirmed no
  `multer`/`formidable`/multipart-parsing dependency or code anywhere in
  `backend/`. Files (receipts, PDFs, images for AI Import) are sent as
  base64 inside the existing 20MB JSON body limit, validated by MIME/size
  checks in `aiImport/validationService.js` and capped by the existing
  `express.json({ limit: "20mb" })`. Since there's no traditional
  multipart upload endpoint, the double-extension/executable-upload/
  ZIP-bomb/SVG-XSS-via-`<img src>` checks in the spec don't have a code
  path to apply to yet — flagging so this is revisited if/when a real file
  upload endpoint is added (e.g. direct-to-Storage uploads), at which point
  MIME sniffing (not trusting the `Content-Type` header), extension
  allowlisting, and a size cap enforced *before* reading the full body are
  all needed.
- **CSRF** — every REST endpoint in `backend/` authenticates via a custom
  header (`x-user-id`, `x-rest-id`) read from `req.headers`, never from a
  cookie, and the app sets no auth cookies at all (state lives in
  `sessionStorage`/`localStorage`, sent by the frontend explicitly on each
  `fetch()` call). CSRF exploits a browser's *automatic* credential
  attachment (cookies) to a cross-site request; a custom header cannot be
  attached by a plain cross-site form/img/script tag, so this app's actual
  CSRF exposure is structurally low already. No `csurf`-style token was
  added, since introducing cookie-based session auth is exactly the
  Firebase Auth migration in Part 2 — CSRF protection belongs in that
  change, alongside `SameSite`/`HttpOnly` cookie configuration, not bolted
  onto the current header-based model.
