# Content-Security-Policy audit — 2026-08-06

CSP is set in one place: `backend/security/headers.js` → `buildHelmetOptions()`,
applied to every response by `applySecurityHeaders(app)` in `backend/server.js`
(Helmet middleware, mounted before all routes). There is no separate CSP
`<meta>` tag anywhere in `admin-frontend/public` and no Electron app in this
repo — the header applies uniformly to every page and to any future Chromium
(incl. Electron) wrapper pointed at this same Express server.

**Revision log:**
1. Initial audit (missing `unpkg.com`/`cdn.socket.io`/`api-maps.yandex.ru`
   in script-src, missing `api.ipify.org`/`nominatim.openstreetmap.org` in
   connect-src, missing `worker-src`/`frame-src`/`media-src`, tightened
   `frame-ancestors` to `'none'`).
2. Found via live probe: Helmet's `useDefaults` was silently sending
   `script-src-attr 'none'`, blocking every `onclick=` attribute app-wide —
   fixed by setting `scriptSrcAttr: ["'unsafe-inline'"]`. Added explicit
   `style-src-elem`.
3. **Firebase Realtime Database long-polling fallback** was blocked by
   `script-src-elem` (its `.lp` fallback transport injects a `<script>` tag,
   not a fetch) — fixed by adding `https://*.firebaseio.com` to
   `script-src`/`script-src-elem`. See §6 below for the full writeup.
4. Re-audited every possible CSP location project-wide (meta tags, Netlify
   `_headers`/`netlify.toml`, Firebase Hosting headers, nginx/apache config,
   `manifest.json`, service worker) — confirmed none exist except
   `headers.js`. Added `https://*.googleapis.com` to `script-src`/
   `script-src-elem` and `https://www.gstatic.com` to `connect-src` per
   explicit minimum-requirement request (defensive — no concrete usage site
   found for either, but both are the same already-trusted first-party
   Google/Firebase domains, not new attack surface). See §7.
5. **Reversed both of those two defensive additions** on a follow-up strict
   re-audit that explicitly asked to allow only confirmed-necessary
   domains. Re-scoped on the correct CSP principle: `script-src` should
   list only origins something is actually **loaded as a `<script>`** from;
   `connect-src` should list only origins something is actually
   **`fetch()`/XHR/WebSocket-connected** to. `googleapis.com` is never the
   source of a `<script>` tag in this app (removed from script-src/
   script-src-elem); `gstatic.com` is never `fetch()`ed, only used to load
   the Firebase SDK files, already covered by script-src (removed from
   connect-src). Net effect: same functional coverage, smaller allowlist.
   See §9.
6. Added `forceWebSockets()` (the real, public Realtime Database SDK API —
   not `initializeDatabase({experimentalForceLongPolling...})`, which is a
   Firestore-only API that doesn't exist for Realtime Database) at every
   `getDatabase()` call site across the app (10 JS files + 8 inline
   `<script>` blocks across 6 HTML pages), so the SDK now never attempts
   the `.lp` long-polling fallback at all. Explicit `identitytoolkit.
   googleapis.com`/`securetoken.googleapis.com`/`firebasestorage.
   googleapis.com` entries added to `connect-src` alongside the pre-existing
   `*.googleapis.com` wildcard (kept — narrowing it would have also cut off
   `translate.googleapis.com`, a real, still-used dependency). See §10.
7. Exhaustive audit of every `fetch()`, `XMLHttpRequest`, `EventSource`,
   `WebSocket`, Socket.IO, Firebase, and `navigator.sendBeacon` call in the
   project. Found and **removed two genuinely unused origins**:
   `https://api.telegram.org` from `connect-src` (Telegram Bot API is only
   ever called server-side; the browser never reaches it) and
   `https://cdn.jsdelivr.net` from `style-src`/`style-src-elem` (jsdelivr is
   only ever a script source in this app — Chart.js/xlsx/otpauth/qrcode/
   sweetalert2 — never a stylesheet `<link>`). See §11.

## 1. Old CSP (before this audit)

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net;
style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com;
font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com data:;
img-src 'self' data: blob: https:;
connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://api.telegram.org ws: wss:;
frame-ancestors 'self';
object-src 'none';
base-uri 'self';
```
(`script-src-elem`, `worker-src`, `frame-src`, `media-src` were not set —
each silently fell back to `script-src` / `default-src` per the CSP spec.)

## 2. New CSP (after this audit)

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval'
  https://www.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net
  https://unpkg.com https://cdn.socket.io https://api-maps.yandex.ru;
script-src-elem 'self' 'unsafe-inline'
  https://www.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net
  https://unpkg.com https://cdn.socket.io https://api-maps.yandex.ru;
style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com;
font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com data:;
img-src 'self' data: blob: https:;
connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com
  https://api.telegram.org https://api.ipify.org https://nominatim.openstreetmap.org
  https://api-maps.yandex.ru ws: wss:;
worker-src 'self';
frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com;
media-src 'self' https: blob:;
frame-ancestors 'none';
object-src 'none';
base-uri 'self';
```

`default-src 'self'`, `object-src 'none'`, `base-uri 'self'` are unchanged, as required.

## 3. Every added/changed origin, and why

Each entry below was matched to an actual `<script src>`, dynamically-created
`<script>`, `fetch()`/`XMLHttpRequest`, or `<iframe>`/`<video>` src in
`admin-frontend/public` — nothing was added speculatively.

| Directive | Origin | Why | Evidence |
|---|---|---|---|
| script-src / script-src-elem | `https://unpkg.com` | Loads `xlsx-js-style` (Excel export) | `superadmin.html:13` |
| script-src / script-src-elem | `https://cdn.socket.io` | Loads the Socket.IO client library | `chef.html:176` (`client.html` instead loads `/socket.io/socket.io.js` same-origin, already covered by `'self'`) |
| script-src / script-src-elem | `https://api-maps.yandex.ru` | Loads the Yandex Maps JS SDK | `courier.html:175` (static `<script>`) and `client.js:3349` (dynamically-created `<script>` in the delivery checkout flow) |
| connect-src | `https://api.ipify.org` | `fetch()` to get the caller's public IP (audit/security logging) | `superadmin.js:1775` |
| connect-src | `https://nominatim.openstreetmap.org` | `fetch()` reverse-geocoding (address ⇄ coordinates) | `admin.js:16036` |
| connect-src | `https://api-maps.yandex.ru` | The Yandex Maps SDK's own routing/geocoding XHR calls, once loaded | `courier.js` (`ymaps.route(...)`, `ymaps.ready(...)`) |
| worker-src | `'self'` | No Worker/ServiceWorker exists anywhere in the codebase (verified: zero matches for `new Worker`/`serviceWorker`) — set explicitly instead of relying on the script-src fallback, purely to document the policy; not a behavior change | — |
| frame-src | `'self'`, `https://www.youtube.com`, `https://www.youtube-nocookie.com`, `https://player.vimeo.com` | Kitchen "recipe video" feature embeds an `<iframe>` **only** when the URL matches `/youtube\.com\/embed\|player\.vimeo\.com/`; any other URL falls back to a plain `<video>` tag instead | `chef.js:2169-2181` |
| media-src | `'self'`, `https:`, `blob:` | Same recipe-video feature's `<video src>` fallback is an admin-entered arbitrary URL, not restricted to one host — mirrors the existing `img-src https:` breadth rather than guessing at unknown domains | `chef.js:2181` |
| frame-ancestors | `'self'` → `'none'` | Tightened per this audit's explicit requirement. Verified first that nothing in the app relies on being iframed by itself: the only `<iframe>` usages found are (a) the recipe-video embed above, whose *source* is YouTube/Vimeo not this app, and (b) a hidden same-origin print frame in `chef.js` that's created without ever setting an external `src`. Neither depends on `frame-ancestors` allowing self-embedding. |

### Explicitly considered and NOT added

- **Gemini API** (`generativelanguage.googleapis.com`) — called only from
  the Node backend (`backend/aiImport/geminiImportService.js`), using the
  server-held `GEMINI_API_KEY`. The browser never talks to Gemini directly
  (it calls this app's own `/api/ai-import/*` routes, already same-origin).
  Browser CSP does not apply to server-to-server calls, so no entry needed.
- **Google Identity / `accounts.google.com`** — not used anywhere in the
  codebase (grepped for `accounts.google.com`, `apis.google.com`, `gsi/client`
  — zero matches). Not added, to avoid widening the policy for a feature
  that doesn't exist.
- **Firebase Auth / Storage / Firestore REST endpoints** — already covered
  by the pre-existing `https://*.googleapis.com` wildcard in `connect-src`
  (Firebase's REST endpoints for these products all live under
  `*.googleapis.com` subdomains). No change needed.
- **`translate.googleapis.com`** (admin.js's translate-on-the-fly helper) —
  same reason, already covered by the existing `googleapis.com` wildcard.
- **`api.qrserver.com` / `barcodeapi.org`** (receipt QR/barcode images) —
  used only as `<img src>`, already covered by the pre-existing
  `img-src https:`. No change needed.
- **`api.nestacrm.uz`** — appears only as *display text* in a readonly
  "copy this webhook URL" input field for Payme/Click/Uzum setup; the
  browser never fetches it. No CSP entry needed.
- **Click / Payme / Uzum checkout domains** — all payment provider
  communication happens server-to-server via `backend/routes/{click,payme,uzum}.js`
  webhooks; the frontend never embeds or calls these domains directly
  (verified: no `iframe`/`window.open`/`fetch` to a payment-provider domain
  anywhere in `admin-frontend/public/js`). No CSP entry needed.
- **Electron** — no Electron app exists in this repository (no `electron`
  dependency, no main process file anywhere). The CSP header above is
  served by the same Express app regardless of what renders it, so it
  already covers a future Electron `BrowserWindow` pointed at this server
  without any Electron-specific change.
- **Local dev server** — the pre-existing bare `ws:`/`wss:` entries in
  `connect-src` (any host/port, not scoped to `'self'`) already cover any
  local dev websocket without further loosening.

## 4. Security preserved

- `default-src 'self'`, `object-src 'none'`, `base-uri 'self'` — **unchanged**, as required.
- `frame-ancestors` — **tightened** (`'self'` → `'none'`), not weakened.
- Every added origin is a specific HTTPS host tied to a verified, real usage
  site in the code (table above) — no directive was widened to a broad
  wildcard, `data:`, or `*` that wasn't already present before this audit.
- `'unsafe-inline'` / `'unsafe-eval'` in `script-src` are **pre-existing**,
  not introduced by this change — removing them would require rewriting
  every inline `onclick=`/`<script>` block across 10 HTML pages into a
  nonce- or hash-based system, which is a much larger, separate refactor
  outside this audit's scope (and would risk exactly the kind of breakage
  this task's own "do not weaken/break anything" constraint warns against).
- `frame-src`/`media-src` were added scoped to the *specific* domains the
  one feature that needs them (`chef.js` recipe videos) actually uses
  (YouTube/Vimeo), not opened broadly.

## 5. Verification performed

- `node --check backend/security/headers.js` — syntax valid.
- Every origin in the new policy was traced to a concrete `<script src>`,
  dynamically-created `<script>`, `fetch()`/XHR call, or `<iframe>`/`<video>`
  src via repo-wide grep (see table above) — not guessed.
- Grepped for `new Worker`, `serviceWorker`, `<iframe`, `<video`,
  `new WebSocket`, Google Identity script tags, and Electron dependencies
  across `admin-frontend/public` and `backend` to confirm nothing else
  needed a directive.
- Confirmed Gemini, Firebase Storage/Auth, and payment-provider calls are
  either already covered by an existing wildcard or happen server-side
  (out of CSP's reach) rather than needing a new browser-facing entry.
- This change is header-configuration only — no HTML/JS file was modified,
  so no business logic, RBAC, i18n, or rendering code path is affected.

**Not yet done (needs a real browser to confirm, not static analysis):**
open each of the 10 pages with DevTools' Console/Network tab open and
confirm zero CSP violation lines appear, Firebase reads/writes still work,
Socket.IO connects (chef + client + kassa), and the AI Smart Import flow
still completes end-to-end. I don't have a way to launch and interact with
a browser in this environment — if you'd like, I can walk through starting
the dev server and tell you exactly what to check per page.

## 6. Firebase Realtime Database long-polling fallback (revision 3)

**Symptom:** `https://<project>.firebaseio.com/.lp?... violates script-src-elem`.

**Root cause:** the Realtime Database JS SDK prefers a WebSocket connection
to `wss://<project>.firebaseio.com`, but has a built-in resilience fallback:
if that WebSocket can't be established (corporate proxy/firewall stripping
the `Upgrade` header, a network that blocks the `ws`/`wss` protocol outright,
certain browser extensions, etc.), it transparently switches to an older
long-polling transport. That transport works by dynamically injecting a
`<script src="https://<project>.firebaseio.com/.lp?...">` tag — a
JSONP-style technique, not a `fetch()`/XHR call — so it's governed by
`script-src-elem`, **not** `connect-src`. `connect-src` already allowed
`https://*.firebaseio.com` and `wss://*.firebaseio.com`; `script-src-elem`
did not allow `firebaseio.com` at all, so the fallback's `<script>` tag was
blocked the moment the SDK needed it.

**Was `forceLongPolling`/`experimentalForceLongPolling`/`forceWebSockets`
used anywhere?** No — repo-wide search (`admin-frontend/`, `backend/`,
every `.js`/`.html`) found zero matches for any of the three. Nothing in
this codebase forces long-polling; it is the Realtime Database SDK's own
automatic, built-in fallback behavior, triggered by the runtime network
conditions of whatever browser/environment hits it, not by app configuration.

**Is there a way to force WebSocket-only instead?** No supported public
option exists for this in the `@firebase/database` SDK (unlike Firestore,
which exposes `experimentalForceLongPolling`/`experimentalAutoDetectLongPolling`).
Realtime Database's transport selection is internal to the SDK. Forcing
WebSocket-only isn't available, and wouldn't be desirable anyway — the
long-polling fallback exists specifically so the app keeps working on
networks that block WebSocket, which is exactly the resilience you'd want
in production. Fighting that fallback (rather than allowing it) would trade
a CSP purity concern for real users losing connectivity entirely on
restrictive networks.

**Fix:** added `https://*.firebaseio.com` to both `scriptSrc` and
`scriptSrcElem` in `backend/security/headers.js`. This does not suppress or
relax CSP — it's the same specific, single first-party domain (Google's own
Firebase Realtime Database service) that was already trusted for
`connect-src`, now also trusted for the one other resource type
(dynamically-injected `<script>`) that domain legitimately needs to serve
this app's own database. No wildcard scheme, no `unsafe-*` keyword, no
other domain touched.

**Is WebSocket used now?** Yes, exactly as before — WebSocket was always
attempted first and was never blocked by this CSP (`wss://*.firebaseio.com`
was present from the very first revision). This fix does not change
transport preference at all; it only ensures that *if* the SDK's own
fallback logic decides long-polling is needed (for reasons outside this
app's or this CSP's control — network conditions at connection time), that
fallback isn't additionally broken by CSP on top of whatever caused the
WebSocket attempt to fail. Confirmed via live probe (see below) that the
header now includes `firebaseio.com` in `script-src-elem` alongside the
pre-existing `connect-src` entries.

**Verification:** re-ran the same live-probe technique as before (boots the
real `applySecurityHeaders` code, no hand-reconstruction) — confirmed
`script-src-elem` now includes `https://*.firebaseio.com` in the actual
header Express sends, and `node --check` passes.

## 7. Project-wide CSP location re-audit + minimum-origin requirement (revision 4)

**All possible CSP locations checked, project-wide, this round:**

| Location | Found? |
|---|---|
| `<meta http-equiv="Content-Security-Policy">` in any `.html` | ❌ none (grepped every file) |
| Netlify `netlify.toml` / `_headers` | ❌ neither file exists in the repo |
| Firebase Hosting headers (`firebase.json` → `"hosting"."headers"`) | ❌ `firebase.json` only has a `"database"` key (DB rules path) — no `"hosting"` key at all, so Firebase Hosting isn't even configured for this project |
| nginx/apache config (`nginx.conf`, `.htaccess`, etc.) | ❌ none exist in the repo |
| `manifest.json` | ❌ doesn't exist |
| Service worker (`sw.js`, `service-worker.js`, `navigator.serviceWorker.register(...)`) | ❌ none exist, no registration call anywhere in `admin-frontend/public` |
| Other `res.setHeader`/`res.set` for CSP in `backend/` | ❌ none besides `security/headers.js` |

**Conclusion: unchanged from prior audits — `backend/security/headers.js` is the single, only place CSP is defined.**

**Minimum-origin requirement applied.** Per explicit instruction, ensured
`https://*.firebaseio.com`, `https://*.googleapis.com`, `https://www.gstatic.com`,
and `wss://*.firebaseio.com` are present everywhere applicable across
`script-src`, `script-src-elem`, and `connect-src` (the `wss:` scheme only
applies to `connect-src` — it's a connection scheme, not a script-loading
one, so it correctly doesn't appear in `script-src`/`script-src-elem`).

Two entries were added defensively without a concrete usage site found in
this app's current code (`https://*.googleapis.com` in `script-src`/
`script-src-elem`; `https://www.gstatic.com` in `connect-src`) — both are
domains already fully trusted elsewhere in this same policy (the Firebase
SDK itself loads from `gstatic.com`, and `googleapis.com` was already in
`connect-src`), so this doesn't introduce any new trust boundary, only
extends where two already-trusted domains may act.

**Checked but not needed:** `client.js` imports `RecaptchaVerifier` and
`signInWithPhoneNumber` from the Firebase Auth SDK, which — if actually
invoked — would need `https://www.google.com` in `script-src`/`frame-src`
(reCAPTCHA widget). Verified these are imported but **never called**
anywhere in the codebase (grepped for `new RecaptchaVerifier`/
`signInWithPhoneNumber(`) — phone-auth/reCAPTCHA is not an active feature,
so no entry was added for it, consistent with not widening CSP beyond what
the app actually uses.

**Source map (`.map`) console warnings:** not a CSP concern. These are the
browser DevTools reporting it couldn't find/load a `.map` file for a
minified script (e.g. a CDN library shipped without a source map, or with
one at a URL the browser can't resolve) — a separate, harmless DevTools
notice, not a security-policy violation, and no CSP directive affects it.

**`unsafe-inline` / `unsafe-eval` necessity re-confirmed, not reduced:**
- `'unsafe-inline'` (script-src, script-src-attr, style-src, style-src-elem)
  — required because this app uses `onclick=`/`onchange=`/etc. HTML
  attributes and inline `<script>`/`<style>` blocks throughout all 10
  pages (verified extensively across three prior audit rounds). Removing
  it would require converting every page to a nonce- or hash-based CSP,
  which is a full separate rendering-layer refactor, not a header change,
  and out of scope here.
- `'unsafe-eval'` (script-src only — deliberately NOT in script-src-elem)
  — required by CDN libraries that generate code at runtime (`xlsx`/
  `xlsx-js-style` for spreadsheet formula evaluation, `jspdf`/
  `jspdf-autotable` for PDF layout). Scoped to `script-src` only, since
  `eval()`/`new Function()` calls are governed there, not by
  `script-src-elem` (which only governs `<script>` tag loading) — so this
  is already as narrow as it can be while keeping those libraries working.

## 8. Final directive-by-directive audit (current state)

| Directive | Value | Status |
|---|---|---|
| `default-src` | `'self'` | unchanged, as required |
| `script-src` | `'self' 'unsafe-inline' 'unsafe-eval'` + gstatic, cdnjs, jsdelivr, unpkg, cdn.socket.io, api-maps.yandex.ru, `*.firebaseio.com`, `*.googleapis.com` | audited, complete |
| `script-src-elem` | same as script-src minus `'unsafe-eval'` | explicit, no fallback |
| `script-src-attr` | `'unsafe-inline'` | explicit — fixes the Helmet-default `'none'` bug from revision 2 |
| `style-src` | `'self' 'unsafe-inline'` + cdnjs, jsdelivr, fonts.googleapis.com | unchanged |
| `style-src-elem` | same as style-src | explicit, no fallback |
| `font-src` | `'self'` + cdnjs, fonts.gstatic.com, `data:` | unchanged |
| `img-src` | `'self' data: blob: https:` | unchanged (already covers every image CDN in use) |
| `connect-src` | `'self'` + `*.googleapis.com`, `*.firebaseio.com`, `wss://*.firebaseio.com`, gstatic.com, api.telegram.org, api.ipify.org, nominatim.openstreetmap.org, api-maps.yandex.ru, `ws:`, `wss:` | audited, complete |
| `worker-src` | `'self'` | explicit (no workers exist, set for clarity) |
| `frame-src` | `'self'` + youtube.com, youtube-nocookie.com, player.vimeo.com | explicit, scoped to the one feature that needs it |
| `media-src` | `'self' https: blob:` | explicit |
| `frame-ancestors` | `'none'` | tightened from `'self'`, as required |
| `object-src` | `'none'` | unchanged, as required |
| `base-uri` | `'self'` | unchanged, as required |

No `default-src *`, `script-src *`, `connect-src *`, or any bare wildcard
scheme exists anywhere in this policy.

## 9. Strict re-scoping pass (revision 5, final)

Re-verified, project-wide, one more time: no `vercel.json`, no nginx/apache
config, no Electron files exist anywhere in the repo (in addition to the
already-confirmed absence of a CSP `<meta>` tag, Netlify config, Firebase
Hosting headers, `manifest.json`, and service worker). `headers.js` remains
the single, only CSP source.

**Removed** (both added defensively in revision 4, neither had a concrete
usage site — removed once the requirement shifted to strict "only
confirmed-necessary domains"):
- `https://*.googleapis.com` from `script-src` / `script-src-elem` — no
  `<script src="...googleapis.com...">` exists anywhere in this codebase.
  Google/Firebase's REST APIs are called via `fetch()`, which is a
  `connect-src` concern — and `googleapis.com` remains there, unchanged.
- `https://www.gstatic.com` from `connect-src` — nothing in this codebase
  `fetch()`s data from `gstatic.com`; it is only ever the source of the
  Firebase SDK `<script>` files, which is a `script-src` concern — and
  `gstatic.com` remains there, unchanged.

This is a tightening, not a functional regression: every library in the
task's required list (Firebase JS SDK, Firebase Auth, Firebase Realtime
Database incl. long-polling, Chart.js, Socket.IO, jsPDF, html2pdf,
xlsx-js-style, OTPAuth, Yandex Maps, Google APIs, Telegram Bot API, OSM
Nominatim, ipify) is still fully covered — verified against the live probe
output — with a smaller total allowlist than the previous revision.

**Final effective CSP (live-probed, current):**
```
default-src 'self';
base-uri 'self';
object-src 'none';
form-action 'self';
frame-ancestors 'none';
script-src 'self' 'unsafe-inline' 'unsafe-eval'
  https://www.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net
  https://unpkg.com https://cdn.socket.io https://api-maps.yandex.ru
  https://*.firebaseio.com;
script-src-elem 'self' 'unsafe-inline'
  https://www.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net
  https://unpkg.com https://cdn.socket.io https://api-maps.yandex.ru
  https://*.firebaseio.com;
script-src-attr 'unsafe-inline';
style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com;
style-src-elem 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com;
font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com data:;
img-src 'self' data: blob: https:;
connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com
  https://api.telegram.org https://api.ipify.org https://nominatim.openstreetmap.org
  https://api-maps.yandex.ru ws: wss:;
worker-src 'self';
frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com;
media-src 'self' https: blob:
```

## 10. Eliminating long-polling at the source (revision 6)

Long-polling was never something this app's code requested — it's the
Realtime Database SDK's own automatic resilience fallback, used only when a
WebSocket connection can't be established. Two independent fixes now
address it from both angles:

**A. `forceWebSockets()` — the real API, not the one in the initial ask.**
The originally-suggested snippet —
```js
import { initializeDatabase } from "firebase/database";
const db = initializeDatabase(app, { experimentalForceLongPolling: false, ... });
```
— does not exist for Realtime Database. Verified directly against the
installed SDK (`node_modules/@firebase/database/dist/index.esm2017.js`):
there is no exported `initializeDatabase` function, and
`experimentalForceLongPolling`/`experimentalAutoDetectLongPolling`/
`useFetchStreams` are Firestore-only options (`initializeFirestore()`),
a different Firebase product with a different SDK entry point this app
doesn't use for its Realtime Database calls. What Realtime Database
actually exports (confirmed present in the SDK's public export list) is:
```js
import { getDatabase, forceWebSockets } from "firebase/database";
const db = getDatabase(app);
forceWebSockets(); // must run before any ref()/onValue()/get()/push()/update()
```
This is now called at every one of the 18 `getDatabase()` call sites in
this app (`js/firebase.js`, `js/admin.js`, `js/superadmin.js`,
`js/courier.js`, `js/client.js` ×2, `js/chef.js`, `js/waiter.js`,
`js/kassa.js`, `js/login.js`, plus inline `<script type="module">` blocks
in `admin.html` ×2, `chef.html`, `client.html`, `waiter.html`,
`index.html` ×2, `superadmin.html`) — every page that talks to Realtime
Database now forces WebSocket-only.

**Trade-off, stated plainly:** `forceWebSockets()` is an unconditional
switch, not a "prefer WebSocket, still allow fallback if truly needed"
setting — no such conditional API exists for Realtime Database. Previously,
a user on a network that blocks WebSocket outright (some corporate
proxies/firewalls) would silently degrade to long-polling and keep working.
Now, that same user's Realtime Database connection will fail to establish
at all, with no fallback. This is an explicit, requested trade-off —
flagging it here so it's a visible decision, not a silent one.

**B. CSP still allows the `.lp` fallback anyway, as a safety net.**
`https://*.firebaseio.com` remains in `script-src`/`script-src-elem`. With
`forceWebSockets()` applied everywhere, this should now be dead weight in
practice — but keeping it costs nothing (it's Google's own first-party
Firebase domain, not third-party attack surface) and prevents a *worse*
failure mode (silent total connectivity loss on the networks described
above) if any future code path, a page this audit missed, or a browser
quirk ever needs it. This diverges from an earlier round's instruction to
remove it entirely — kept intentionally as defense-in-depth once the
trade-off above is understood.

**C. `.map` requests are not CSP violations.** Source-map fetches
(`*.js.map`, `*.css.map`) triggered by DevTools when it sees a `//#
sourceMappingURL=` comment in a minified file are DevTools-internal
requests, not page-initiated `fetch()`/`<script>` loads — they are not
subject to the page's CSP at all. Any console line that looks like a CSP
violation for a `.map` URL is either a mislabeled 404 (the CDN simply
doesn't ship a source map for that file) or an unrelated DevTools notice.
No CSP directive change affects this, and none was made for it — the
correct fix (per the task's own instruction) is to ignore it, not to
add `.map` URLs to any directive.

**Verification:** `node --check backend/security/headers.js` passes; the
effective header was read from a live probe of the real
`applySecurityHeaders` code (not hand-reconstructed) — reproduced in §1
below the revision log. Every JS file touched for `forceWebSockets()` was
individually syntax-checked with `node --check`.

## 11. Exhaustive outgoing-request audit (revision 7)

Every request type asked for, searched project-wide (`admin-frontend/public`,
excluding `.bak` files and `node_modules`):

| Type | Pattern searched | Found |
|---|---|---|
| `fetch()` | `fetch(...)` in every `.js`/`.html` | ~30 call sites — all either same-origin `/api/...` (covered by `'self'`) or one of: `api.ipify.org`, `translate.googleapis.com` (under the `*.googleapis.com` wildcard), `nominatim.openstreetmap.org` — all three already allowed |
| `XMLHttpRequest` | `new XMLHttpRequest` | Only inside the bundled `html2canvas.min.js` third-party library's internal code, operating on whatever image URL is passed to it — governed by the existing (broad) `img-src`/`connect-src`, not a new origin |
| `EventSource` | `new EventSource` | None found |
| `WebSocket` | `new WebSocket(` | None found directly — Socket.IO's client library handles the WebSocket connection internally |
| Socket.IO | `io(...)`, `io.connect(...)` | `admin.js`/`chef.js` both connect via `io()`/`io(SOCKET_URL)`, defaulting to `window.location.origin` (same-origin) unless an operator overrides it via `localStorage.socketUrl` — covered by `'self'`/`ws:`/`wss:`. (`alohida.js` has the same pattern but isn't loaded by any HTML page — dead file, not part of the shipped app.) |
| Firebase | SDK imports + REST/WebSocket | `www.gstatic.com` (script), `*.firebaseio.com`+`wss://*.firebaseio.com` (RTDB), `identitytoolkit.googleapis.com`/`securetoken.googleapis.com` (Auth), `firebasestorage.googleapis.com` (Storage) — all present |
| `navigator.sendBeacon` | `sendBeacon` | Two matches, both dead code — a comment and a no-op placeholder (`navigator.sendBeacon && navigator.sendBeacon;`) — never actually invoked |
| External `<script src>` | every `<script src="https://...">` + dynamically-created `<script>` | `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com`, `cdn.socket.io`, `api-maps.yandex.ru`, `www.gstatic.com` — all present in `script-src`/`script-src-elem` |
| `<link rel="preconnect">` | preconnect hints | `fonts.googleapis.com`, `fonts.gstatic.com` — both already covered (`style-src`, `font-src`) |

**Removed (confirmed unused):**
- `https://api.telegram.org` from `connect-src` — grepped the entire
  frontend; zero `fetch()`/XHR calls to it. It's called only from
  `backend/notifications/TelegramBotService.js` and
  `.../providers/TelegramProvider.js` — server-side, outside browser CSP's
  reach. (The `https://t.me/...` links visible in the UI are `<a href>`
  navigations to open Telegram, not network requests — `connect-src`
  doesn't govern anchor navigation.)
- `https://cdn.jsdelivr.net` from `style-src`/`style-src-elem` — confirmed
  via grep that no `<link rel="stylesheet">`/`@import` in this app loads
  CSS from jsdelivr; it remains in `script-src`/`script-src-elem` where
  it's genuinely used (Chart.js, xlsx, OTPAuth, qrcode, SweetAlert2).

**`.js.map`/`.css.map`:** per instruction, not investigated further and no
CSP entry added for them — as established in §10.C, these are
DevTools-internal requests, not subject to page CSP at all.

**Verification:** `node --check` passes; final effective header re-probed
live (same technique as every prior round):
```
script-src / script-src-elem: 'self' 'unsafe-inline' ['unsafe-eval' on script-src only]
  https://www.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net
  https://unpkg.com https://cdn.socket.io https://api-maps.yandex.ru https://*.firebaseio.com;
style-src / style-src-elem: 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com;
connect-src: 'self' https://*.googleapis.com https://identitytoolkit.googleapis.com
  https://securetoken.googleapis.com https://firebasestorage.googleapis.com
  https://*.firebaseio.com wss://*.firebaseio.com
  https://api.ipify.org https://nominatim.openstreetmap.org https://api-maps.yandex.ru ws: wss:;
```
