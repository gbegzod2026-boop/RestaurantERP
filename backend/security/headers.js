// security/headers.js — HTTP security headers (Helmet) + CORS allowlist.
// Additive-only: every option here is chosen so existing behavior (the
// admin/waiter/chef/client/courier pages, Socket.IO, Firebase SDK calls from
// the browser, Telegram/Click/Payme/Uzum webhooks hitting this same origin)
// keeps working unchanged. Nothing here touches business logic.
import helmet from "helmet";
import { getAuthEmulatorHost } from "../firebaseEnv.js";

// P1-2 fix (PRODUCTION-AUDIT.md): matches the production frontend's actual
// domain shape — this app is subdomain-per-restaurant
// (`${domain}.nestacrm.uz`, confirmed live throughout superadmin.js/admin.js
// — e.g. superadmin.js:374,476,1205 build/display exactly this pattern),
// served same-origin by this very Express app (express.static below), so a
// legitimate browser session never actually needs cross-origin CORS at all
// for the real admin/waiter/chef/client/courier flows — same-origin
// requests never even trigger a browser's CORS check. This allowlist exists
// only for genuinely cross-origin callers (a script on a different site) —
// it deliberately does NOT enumerate every individual restaurant subdomain
// (that list changes constantly as restaurants are created) and instead
// pattern-matches the domain shape itself, exactly as requested: "faqat
// nazorat qilinadigan *.nestacrm.uz originlariga ruxsat beradigan aniq
// mexanizm". localhost/127.0.0.1 (any port) is included for local
// development only.
const NESTACRM_ORIGIN_RE = /^https?:\/\/([a-z0-9-]+\.)*nestacrm\.uz$/i;
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

function isDefaultAllowedOrigin(origin) {
  return NESTACRM_ORIGIN_RE.test(origin) || LOCALHOST_ORIGIN_RE.test(origin);
}

/**
 * CORS origin allowlist.
 *   - ALLOWED_ORIGINS set (comma-separated, exact matches) → used AS AN
 *     EXPLICIT OVERRIDE, unchanged from before, for an operator who wants a
 *     different or narrower list than the default below.
 *   - ALLOWED_ORIGINS unset (today's actual .env state) → previously
 *     reflected ANY origin with credentials:true ("any site can call this
 *     API with credentials" — the P1-2 finding). Now defaults to the
 *     *.nestacrm.uz / localhost pattern above instead of `origin: true`,
 *     since no real, currently-observed traffic pattern needs anything
 *     broader than that (same-origin browser requests never hit this check
 *     at all; Click/Payme/Uzum/Telegram webhooks send no Origin header and
 *     are unconditionally allowed below, exactly as before).
 */
export function buildCorsOptions() {
  const configured = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const isAllowed = configured.length
    ? (origin) => configured.includes(origin)
    : isDefaultAllowedOrigin;

  return {
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    origin(origin, callback) {
      // No Origin header (curl, server-to-server webhooks from Click/Payme/
      // Uzum/Telegram, same-origin requests in some browsers) — allow, same
      // as this app's original behavior; those callers were never blocked
      // by CORS before and payment webhooks must keep working.
      if (!origin) return callback(null, true);
      if (isAllowed(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
  };
}

/**
 * Helmet config. CSP is intentionally permissive on script/style/img/connect
 * sources (`'self'`, the Firebase/gstatic CDN the frontend already loads
 * from, and websockets for Socket.IO) rather than a tight nonce-based policy
 * — this app's HTML pages use inline event handlers and inline <script>
 * blocks throughout (admin.html, kassa.html, etc.), so a strict CSP would
 * break rendering. This still meaningfully blocks the OWASP-relevant cases:
 * third-party script injection from an untrusted origin, framing (clickjacking),
 * and mixed content — the headers item this audit specifically asked for.
 *
 * 2026-08-06 audit — every origin below was verified against an actual
 * <script src>, dynamically-injected <script>, fetch()/XHR call, or
 * <iframe>/<video> src found in admin-frontend/public. Nothing was added
 * "just in case". See CSP_AUDIT.md at the repo root for the full origin ↔
 * usage-site mapping this was derived from.
 */
function authEmulatorConnectSrc() {
  const host = getAuthEmulatorHost();
  if (!host) return [];
  const raw = host.includes("://") ? host : `http://${host}`;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return [];
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) return [];
  const origins = new Set([parsed.origin]);
  if (parsed.hostname === "127.0.0.1") {
    origins.add(`http://localhost:${parsed.port || "9099"}`);
  } else if (parsed.hostname === "localhost") {
    origins.add(`http://127.0.0.1:${parsed.port || "9099"}`);
  }
  return [...origins];
}

export function buildHelmetOptions() {
  return {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-inline'/'unsafe-eval' were already required (inline
        // onclick=/<script> blocks throughout, xlsx/jspdf use eval-like
        // codegen) — unchanged. Added: unpkg.com (superadmin.html's
        // xlsx-js-style bundle), cdn.socket.io (chef.html's Socket.IO
        // client — client.html loads /socket.io/socket.io.js same-origin
        // instead, so only chef.html needed this), api-maps.yandex.ru
        // (Yandex Maps SDK — courier.html <script> tag AND a
        // dynamically-created <script> in client.js's openDeliveryCheckout
        // flow both load this same URL), https://*.firebaseio.com (see
        // note on scriptSrcElem below — Realtime Database's long-polling
        // fallback transport, not just its WebSocket transport, needs a
        // script-src entry too).
        // 2026-08-06 re-audit (strict pass): https://*.googleapis.com was
        // previously added here defensively (no confirmed <script src=
        // googleapis.com> anywhere in the codebase — RecaptchaVerifier is
        // imported in client.js but never invoked, so it needs nothing).
        // Removed again per this round's "allow only required domains"
        // requirement: every Firebase JS SDK file this app actually loads
        // comes from www.gstatic.com (already listed), and every REST call
        // Firebase/Google APIs make at runtime is a fetch()/XHR, which
        // belongs in connect-src (already listed there) — not script-src.
        // Keeping googleapis.com out of script-src is strictly tighter and
        // costs nothing real.
        // https://yastatic.net — found via an actual DevTools-equivalent
        // Network-tab inspection (Playwright's securitypolicyviolation
        // event, which exposes the real blockedURI even where Chrome's own
        // console text shows "<URL>"), not guessed. The Yandex Maps entry
        // script (https://api-maps.yandex.ru/2.1/...) is only a small
        // loader stub — once it runs, it dynamically injects the real SDK
        // bundle from a DIFFERENT domain,
        // https://yastatic.net/s3/front-maps-static/maps-front-jsapi-v2-1/.../full.js
        // (confirmed on courier.html, whose map view uses this SDK).
        // Allowing api-maps.yandex.ru alone was not sufficient.
        scriptSrc: [
          "'self'", "'unsafe-inline'", "'unsafe-eval'",
          "https://www.gstatic.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net",
          "https://unpkg.com", "https://cdn.socket.io", "https://api-maps.yandex.ru",
          "https://yastatic.net",
          "https://*.firebaseio.com",
        ],
        // Explicit script-src-elem mirroring script-src — without this,
        // browsers that honor script-src-elem separately fall back to
        // script-src anyway (same effective result), but this documents
        // the audited value directly instead of relying on the fallback.
        //
        // https://*.firebaseio.com is required here specifically (not just
        // in connect-src) because of how the Realtime Database SDK's
        // long-polling FALLBACK transport works: when a WebSocket
        // connection to *.firebaseio.com can't be established (corporate
        // proxy/firewall stripping the `wss:` upgrade, a network that
        // blocks WebSocket outright, certain browser extensions, etc.),
        // the SDK transparently falls back to an old-style long-polling
        // transport that works by dynamically injecting a <script
        // src="https://<project>.firebaseio.com/.lp?..."> tag (a legacy
        // JSONP-like technique, not a fetch/XHR call) — so it's governed by
        // script-src-elem, not connect-src. connect-src already allowed
        // https://*.firebaseio.com (for the normal REST/WebSocket path),
        // but that alone does NOT cover this fallback's dynamically
        // injected <script> tag, which is exactly what was being blocked.
        // We do NOT force WebSocket-only (no supported public config
        // option exists for this in the Realtime Database JS SDK the way
        // Firestore has `experimentalForceLongPolling`/`forceWebSockets` —
        // confirmed via repo-wide search, this project doesn't set any
        // such flag and never has), so the fallback must be allowed to
        // work rather than fought — this directive is the actual fix.
        scriptSrcElem: [
          "'self'", "'unsafe-inline'",
          "https://www.gstatic.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net",
          "https://unpkg.com", "https://cdn.socket.io", "https://api-maps.yandex.ru",
          "https://yastatic.net",
          "https://*.firebaseio.com",
        ],
        // CRITICAL — without this, Helmet's `useDefaults: true` silently
        // injects `script-src-attr 'none'` (verified by dumping the actual
        // header Helmet sends — it is NOT just an unset fallback to
        // script-src, it's an explicit 'none' baked into Helmet's own
        // default directive set). script-src-attr governs inline event
        // handler ATTRIBUTES specifically (onclick=, onchange=,
        // onmouseover=, ...) as a directive separate from script-src since
        // CSP Level 3 — and this codebase uses onclick= throughout every
        // single page (admin.html, superadmin.html, waiter.html, etc.).
        // Left at Helmet's default 'none', a CSP3-enforcing browser blocks
        // literally every onclick handler in the app. Set to match
        // script-src's existing 'unsafe-inline' — preserves the exact
        // behavior this app already relies on, changes nothing else.
        scriptSrcAttr: ["'unsafe-inline'"],
        // 2026-08-06 full network-call audit: removed https://cdn.jsdelivr.net
        // — no <link rel="stylesheet"> or @import anywhere in this app
        // loads CSS from jsdelivr (it's only ever a script-src source: Chart.js,
        // xlsx, otpauth, qrcode, sweetalert2). SweetAlert2 injects its own
        // <style> tags at runtime, which is an 'unsafe-inline' concern, not
        // an external stylesheet — already covered.
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
        // Explicit style-src-elem mirroring style-src, for the same reason
        // script-src-elem is explicit above — documents the audited value
        // instead of relying on the (in this case harmless) fallback.
        styleSrcElem: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com", "data:"],
        // https: stays broad here (unchanged) — it already covers every
        // image CDN the app uses (QR/barcode generators, Yandex map tiles,
        // restaurant/menu photos on arbitrary admin-provided URLs), so no
        // per-domain additions were needed on this directive.
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        // Added: api.ipify.org (superadmin.js getClientIp() fetch()),
        // nominatim.openstreetmap.org (admin.js reverse-geocoding fetch()),
        // api-maps.yandex.ru (Yandex Maps SDK's own routing/geocode XHR
        // calls once loaded). https://*.googleapis.com already covered
        // Firebase Auth/Storage/Firestore's REST endpoints and
        // translate.googleapis.com (admin.js's translate-on-the-fly
        // feature) before this audit — no change needed there. Gemini
        // (generativelanguage.googleapis.com) is called ONLY from the
        // Node backend (backend/aiImport/geminiImportService.js), never
        // from the browser, so it needs no browser CSP entry at all.
        // 2026-08-06 re-audit (strict pass): https://www.gstatic.com was
        // previously added here defensively (no confirmed fetch()/XHR to
        // gstatic.com anywhere in this app's code). Removed again per this
        // round's "allow only required domains" requirement — gstatic.com
        // is only ever used to LOAD the Firebase SDK <script> files, which
        // is already covered by script-src/script-src-elem above; nothing
        // in this codebase fetch()es data from gstatic.com at runtime.
        //
        // https://identitytoolkit.googleapis.com (Firebase Auth REST —
        // signInWithEmailAndPassword, signInAnonymously),
        // https://securetoken.googleapis.com (Firebase Auth token refresh),
        // https://firebasestorage.googleapis.com (Firebase Storage
        // uploadBytes/getDownloadURL/deleteObject) listed explicitly per
        // request — all three were already reachable under the
        // https://*.googleapis.com wildcard already present below (kept,
        // since narrowing it would also cut off translate.googleapis.com,
        // which admin.js's translate-on-the-fly feature genuinely uses and
        // which isn't in this round's explicit list — removing it would be
        // a real regression, not a security improvement, since it's still
        // one specific real Google domain either way).
        // 2026-08-06 full network-call audit: removed https://api.telegram.org
        // — grepped every fetch()/XHR call in admin-frontend/public; it is
        // NEVER called from the browser. Telegram Bot API calls only ever
        // happen server-side (backend/notifications/TelegramBotService.js,
        // backend/notifications/providers/TelegramProvider.js) — outside
        // browser CSP's reach entirely, so allowing it here was pure dead
        // weight. (The "https://t.me/..." links found in the UI are plain
        // <a href> navigations to open Telegram, not fetch()/XHR calls —
        // CSP's connect-src doesn't govern anchor navigation.)
        connectSrc: [
          "'self'",
          "https://*.googleapis.com",
          "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com",
          "https://firebasestorage.googleapis.com",
          "https://*.firebaseio.com", "wss://*.firebaseio.com",
          "https://api.ipify.org", "https://nominatim.openstreetmap.org",
          "https://api-maps.yandex.ru", "ws:", "wss:",
          // DevTools fetches sibling `.js.map` files from the SAME origins
          // already allowed in script-src / script-src-elem (CDN scripts
          // embed `//# sourceMappingURL=...`). Without these, Chrome logs
          // "Connecting to CDN .js.map violates CSP connect-src" even
          // though the app never fetch()es those maps itself.
          // Do NOT widen to connect-src *. These four hosts already serve
          // the scripts: xlsx-js-style (unpkg), jspdf (cdnjs), otpauth +
          // Chart.js (jsdelivr), Firebase SDK (gstatic).
          "https://unpkg.com",
          "https://cdnjs.cloudflare.com",
          "https://cdn.jsdelivr.net",
          "https://www.gstatic.com",
          ...authEmulatorConnectSrc(),
        ],
        // No Worker/ServiceWorker exists anywhere in admin-frontend today
        // (audited, zero matches) — set explicitly to 'self' instead of
        // leaving it to the script-src fallback, purely for a clear,
        // self-documenting policy; not a behavior change.
        workerSrc: ["'self'"],
        // chef.js's recipe-video renderer only ever builds an <iframe> for
        // URLs matching /youtube\.com\/embed|player\.vimeo\.com/ (anything
        // else falls back to a plain <video> tag instead) — so only those
        // two embed origins are needed, not a broad https:.
        frameSrc: ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://player.vimeo.com"],
        // Same recipe-video renderer's <video src> fallback is an
        // admin-entered arbitrary URL (self-hosted files, not restricted to
        // one domain), so this mirrors img-src's existing https: breadth
        // rather than trying to allowlist unknown hosts.
        mediaSrc: ["'self'", "https:", "blob:"],
        // Changed 'self' → 'none' per this audit's explicit requirement.
        // Verified first: no page in this app iframes another Nesta page
        // (grepped for <iframe> across every .html/.js — the only iframes
        // found are chef.js's recipe-video embed, whose *source* is
        // youtube/vimeo, not this app, and a hidden same-origin print
        // frame in chef.js that's never given an external src). So nothing
        // here relies on being embeddable by itself, and 'none' is safe.
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
      },
    },
    // Payment providers / QR flows open this app inside webviews and the
    // admin-frontend serves images/receipts cross-origin in places, so keep
    // COEP/CORP off (their default would break those) — every other Helmet
    // default (X-Content-Type-Options, X-Frame-Options via frameguard,
    // Referrer-Policy, X-DNS-Prefetch-Control, HSTS) stays on.
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: { maxAge: 15552000, includeSubDomains: true }, // 180 days; only sent over HTTPS by browsers anyway
  };
}

export function applySecurityHeaders(app) {
  app.use(helmet(buildHelmetOptions()));
  // Helmet's default X-Powered-By removal + a couple of legacy headers some
  // older browsers/reverse proxies still respect (X-XSS-Protection is
  // deprecated by modern browsers but harmless to keep for older webviews
  // sometimes used to display QR-code table pages).
  app.use((req, res, next) => {
    res.setHeader("X-XSS-Protection", "0"); // modern guidance: rely on CSP, disable the legacy filter (it can itself be an XSS vector)
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=(self)");
    next();
  });
}
