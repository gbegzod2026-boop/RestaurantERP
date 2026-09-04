// pgRtdb.js — Firebase RTDB drop-in that routes tenant application data
// through the PostgreSQL HTTPS API + Socket.IO when DATA_BACKEND=postgres.
// In postgres mode, unmapped tenant paths fail closed (unmapped_path).
// Retained native Firebase: Auth (outside this module), systemData, .info.
import {
  ref as fbRef,
  onValue as fbOnValue,
  get as fbGet,
  set as fbSet,
  update as fbUpdate,
  remove as fbRemove,
  push as fbPush,
  query as fbQuery,
  orderByChild as fbOrderByChild,
  limitToLast as fbLimitToLast,
  equalTo as fbEqualTo,
  runTransaction as fbRunTransaction,
  off as fbOff,
  onChildAdded as fbOnChildAdded,
  onChildChanged as fbOnChildChanged,
  onChildRemoved as fbOnChildRemoved,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { canonicalizeRestId, parseRestId } from "./pgRestId.js";
import { isMapped, postgresDataPlane } from "./pgDataPlane.js";
import { matchesSubscriptionMessage, matchesTenantEvent } from "./pgRealtimeProtocol.js";

export { forceWebSockets, getDatabase } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

let _mode = "unknown";
let _modeP = null;
let _socket = null;
let _socketRestId = null;
let _lastSeq = 0;
const _listeners = new Set(); // { path, cb, errCb, query }

// Shared auth/token state — one in-flight wait and one force-refresh so
// 20 parallel /rtdb/get calls never mint 20 tokens or retry-storm the API.
let _waitUserP = null;
let _tokenCache = { token: null, exp: 0, uid: null };
let _getTokenP = null;
let _forceRefreshP = null;
let _authHooked = false;
let _tenantAuthority = { uid: null, restId: null, platformSuperAdmin: false, ts: 0, expMs: 0, gen: null };
let _tenantAuthorityP = null;
const _inflightGet = new Map();
const _refreshTimers = new Map();
let _authDenied = null; // { status, code, uid, restId, gen, ts }
let _subscribedAck = false;
let _pendingResync = false;
let _resyncInFlight = false;
let _authEpoch = 0;
let _authTransitionSeq = 0;
let _observedIdentityKey = null;
let _subscriptionSerial = 0;
let _activeSubscription = null; // { restId, generation, epoch }

function clearAuthorityCaches() {
  _tenantAuthority = { uid: null, restId: null, platformSuperAdmin: false, ts: 0, expMs: 0, gen: null };
  _tenantAuthorityP = null;
  _authDenied = null;
}

function tokenGeneration(user) {
  return `${user?.uid || ""}:${_tokenCache.exp || 0}`;
}

function denialHits(uid, restId, gen) {
  if (!_authDenied) return false;
  if (_authDenied.uid !== uid || _authDenied.restId !== restId || _authDenied.gen !== gen) return false;
  return Date.now() - _authDenied.ts < 15_000;
}

function rememberDenial(status, code, uid, restId, gen) {
  _authDenied = { status, code, uid, restId, gen, ts: Date.now() };
}

function invalidateRealtimeSubscription() {
  _authEpoch += 1;
  _subscriptionSerial += 1;
  const previous = _activeSubscription;
  _activeSubscription = null;
  _subscribedAck = false;
  _pendingResync = false;
  _resyncInFlight = false;
  _lastSeq = 0;
  _socketRestId = null;
  if (_socket && previous) {
    _socket.emit("nesta:unsubscribe", {
      restId: previous.restId,
      generation: previous.generation,
    });
  }
  for (const L of _listeners) {
    L.halted = true;
    L.epoch = -1;
  }
  if (typeof window !== "undefined") window.__nestaRealtimeState = "idle";
}

async function resumeRealtimeForCurrentIdentity(transitionSeq) {
  for (const L of _listeners) {
    if (transitionSeq !== _authTransitionSeq) return;
    const restId = restIdOf(L.path);
    if (!restId) continue;
    try {
      await ensureTenantAuthority(L.path);
      if (transitionSeq !== _authTransitionSeq) return;
      L.halted = false;
      L.epoch = _authEpoch;
      await ensureSocket(restId);
      if (transitionSeq === _authTransitionSeq) scheduleRefresh(L);
    } catch {
      L.halted = true;
    }
  }
}

async function handleAuthIdentity(user) {
  const transitionSeq = ++_authTransitionSeq;
  let restId = null;
  if (user) {
    try {
      const result = await user.getIdTokenResult(false);
      if (transitionSeq !== _authTransitionSeq) return;
      restId = canonicalizeRestId(result?.claims?.restId ?? result?.claims?.restaurantId ?? null);
    } catch { /* invalid tokens are handled by normal API authorization */ }
  }
  const identityKey = user ? `${user.uid}:${restId || ""}` : null;
  if (identityKey === _observedIdentityKey) return;
  _observedIdentityKey = identityKey;
  _tokenCache = { token: null, exp: 0, uid: null };
  _waitUserP = null;
  clearAuthorityCaches();
  invalidateRealtimeSubscription();
  if (user) await resumeRealtimeForCurrentIdentity(transitionSeq);
}

function hookAuthLifecycle() {
  if (_authHooked) return;
  _authHooked = true;
  try {
    const auth = getAuth();
    auth.onAuthStateChanged((user) => { void handleAuthIdentity(user); });
    if (typeof auth.onIdTokenChanged === "function") {
      auth.onIdTokenChanged((user) => { void handleAuthIdentity(user); });
    }
  } catch { /* Auth app may not be ready on first import */ }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve a Firebase Auth user before any PostgreSQL API call. Does not
 *  force-refresh the ID token. Times out so a logged-out page cannot hang. */
function waitForAuthUser(timeoutMs = 12000) {
  hookAuthLifecycle();
  const auth = getAuth();
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  if (_waitUserP) return _waitUserP;
  _waitUserP = (async () => {
    try {
      if (typeof auth.authStateReady === "function") await auth.authStateReady();
    } catch { /* proceed to onAuthStateChanged wait */ }
    if (auth.currentUser) return auth.currentUser;
    return new Promise((resolve) => {
      let done = false;
      const finish = (user) => {
        if (done) return;
        done = true;
        try { unsub(); } catch { /* */ }
        resolve(user || null);
      };
      const unsub = auth.onAuthStateChanged((user) => {
        if (user) finish(user);
      });
      setTimeout(() => finish(auth.currentUser), timeoutMs);
    });
  })().finally(() => { _waitUserP = null; });
  return _waitUserP;
}

function tokenExpMs(token, fallbackMs) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.exp) return Number(payload.exp) * 1000;
  } catch { /* malformed — use fallback */ }
  return fallbackMs;
}

/** Cached getIdToken(). forceRefresh shares one promise across callers. */
async function getBearerToken({ forceRefresh = false } = {}) {
  const user = await waitForAuthUser();
  if (!user) return null;
  const now = Date.now();
  if (
    !forceRefresh &&
    _tokenCache.token &&
    _tokenCache.uid === user.uid &&
    _tokenCache.exp - now > 60_000
  ) {
    return _tokenCache.token;
  }
  if (forceRefresh) {
    if (_forceRefreshP) return _forceRefreshP;
    _forceRefreshP = (async () => {
      clearAuthorityCaches();
      const token = await user.getIdToken(true);
      _tokenCache = {
        token,
        uid: user.uid,
        exp: tokenExpMs(token, Date.now() + 50 * 60 * 1000),
      };
      return token;
    })().finally(() => { _forceRefreshP = null; });
    return _forceRefreshP;
  }
  if (_getTokenP) return _getTokenP;
  _getTokenP = (async () => {
    const token = await user.getIdToken(false);
    _tokenCache = {
      token,
      uid: user.uid,
      exp: tokenExpMs(token, Date.now() + 50 * 60 * 1000),
    };
    return token;
  })().finally(() => { _getTokenP = null; });
  return _getTokenP;
}

export function getClientDataBackend() {
  return _mode;
}

export async function resolveClientDataBackend() {
  return ensureMode();
}

export function classifyClientError(error) {
  const status = Number(error?.status) || 0;
  const code = error?.code === "PG_UNAVAILABLE" ? "PG_UNAVAILABLE" : (error?.code || error?.error || null);
  if (status === 400 || code === "unmapped_path" || code === "restId_invalid" || code === "restId_conflict") {
    return { code: code || "INVALID_INPUT", status: 400 };
  }
  if (status === 401) return { code: "AUTH_REQUIRED", status: 401 };
  if (status === 403) return { code: "TENANT_FORBIDDEN", status: 403 };
  if (status === 404) return { code: "NOT_FOUND", status: 404 };
  if (status === 409 || error?.code === "CREDENTIAL_CONFLICT") return { code: "CREDENTIAL_CONFLICT", status: 409 };
  if (status === 503 || code === "PG_UNAVAILABLE") return { code: "PG_UNAVAILABLE", status: 503 };
  return { code: "UNEXPECTED", status: 500 };
}

function restIdOf(path) {
  const segs = String(path).split("/").filter(Boolean);
  return segs[0] === "restaurants" ? segs[1] : null;
}

function authorityTtlMs(expMs) {
  const untilExp = (Number(expMs) || 0) - Date.now() - 30_000;
  return Math.max(0, Math.min(60_000, untilExp));
}

async function ensureTenantAuthority(path) {
  const rawRestId = restIdOf(path);
  if (!rawRestId) return;
  const parsed = parseRestId(rawRestId);
  if (!parsed.ok || parsed.empty) {
    throw httpError(400, { error: "Invalid restaurant id", code: "restId_invalid" });
  }
  const requestedRestId = parsed.restId;
  const user = await waitForAuthUser();
  if (!user) throw httpError(401, { error: "AUTH_REQUIRED", code: "token_missing" });
  const gen = tokenGeneration(user);
  if (denialHits(user.uid, requestedRestId, gen)) {
    throw httpError(_authDenied.status, { error: _authDenied.code, code: _authDenied.code });
  }
  const now = Date.now();
  const cacheTtl = authorityTtlMs(_tenantAuthority.expMs);
  const cacheFresh = _tenantAuthority.uid === user.uid
    && _tenantAuthority.gen === gen
    && cacheTtl > 0
    && (now - _tenantAuthority.ts) < cacheTtl;
  if (cacheFresh && (_tenantAuthority.restId || _tenantAuthority.platformSuperAdmin === true)) {
    if (_tenantAuthority.platformSuperAdmin === true) return;
    if (_tenantAuthority.restId !== requestedRestId) {
      throw httpError(403, { error: "TENANT_FORBIDDEN", code: "restId_mismatch" });
    }
    return;
  }
  if (!_tenantAuthorityP) {
    _tenantAuthorityP = (async () => {
      try {
        const result = await user.getIdTokenResult(true);
        const claims = result?.claims || {};
        const expMs = result?.expirationTime ? Date.parse(result.expirationTime) : (tokenExpMs(_tokenCache.token, Date.now() + 60_000));
        return {
          uid: user.uid,
          restId: canonicalizeRestId(claims.restId ?? claims.restaurantId ?? null),
          platformSuperAdmin: claims.platformSuperAdmin === true,
          expMs,
          gen: `${user.uid}:${expMs}`,
        };
      } catch {
        throw httpError(403, { error: "TENANT_FORBIDDEN", code: "token_invalid" });
      }
    })().finally(() => { _tenantAuthorityP = null; });
  }
  const authority = await _tenantAuthorityP;
  _tokenCache.exp = authority.expMs || _tokenCache.exp;
  _tenantAuthority = { ...authority, ts: Date.now() };
  if (authority.uid !== user.uid) {
    throw httpError(403, { error: "TENANT_FORBIDDEN", code: "restId_mismatch" });
  }
  if (authority.platformSuperAdmin === true) return;
  if (authority.restId !== requestedRestId) {
    throw httpError(403, { error: "TENANT_FORBIDDEN", code: "restId_mismatch" });
  }
}

async function ensureMode() {
  if (_mode !== "unknown") return _mode;
  if (_modeP) return _modeP;
  _modeP = fetch("/api/pg/meta")
    .then((r) => {
      if (!r.ok) throw new Error(`GET /api/pg/meta ${r.status}`);
      return r.json();
    })
    .then((j) => {
      if (typeof j.restaurantCount === "number") {
        try { window.__canonicalRestaurantCount = j.restaurantCount; } catch { /* non-browser */ }
      }
      if (j.dataBackend !== "postgres" && j.dataBackend !== "firebase") {
        throw new Error("Backend mode unavailable");
      }
      _mode = j.dataBackend;
      return _mode;
    })
    .catch(() => {
      _modeP = null;
      throw httpError(503, { error: "PG_UNAVAILABLE" });
    });
  return _modeP;
}

function pathOf(r) {
  if (!r) return "";
  if (r.__nestaPath != null) return String(r.__nestaPath).replace(/^\/+/, "");
  if (typeof r.toString === "function") {
    const s = r.toString();
    const idx = s.indexOf(".io/");
    const idx2 = s.indexOf(".com/");
    const cut = idx >= 0 ? idx + 4 : idx2 >= 0 ? idx2 + 5 : -1;
    if (cut >= 0) {
      try { return decodeURIComponent(s.slice(cut).replace(/^\/+/, "")); } catch { return s.slice(cut).replace(/^\/+/, ""); }
    }
  }
  return "";
}

async function authHeaders(path, { forceRefresh = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = await getBearerToken({ forceRefresh });
  if (token) headers.Authorization = `Bearer ${token}`;
  const restId = canonicalizeRestId(restIdOf(path));
  if (restId) {
    headers["x-rest-id"] = restId;
    headers["x-user-id"] = getAuth().currentUser?.uid || "";
  }
  return headers;
}

function httpError(status, json) {
  const classification = classifyClientError({ status, code: json?.error || json?.code });
  const err = new Error(classification.code);
  err.status = status === 400 ? 400 : classification.status;
  err.code = json?.code || classification.code;
  err.details = json?.details != null ? json.details : json || null;
  return err;
}

async function api(method, url, body, pathForAuth, { _retried401 = false, _retried429 = 0 } = {}) {
  const path = pathForAuth || (body && body.path) || "";
  await waitForAuthUser();
  const headers = await authHeaders(path, { forceRefresh: false });
  if (!headers.Authorization) {
    throw httpError(401, { error: "Authentication required" });
  }
  const restId = canonicalizeRestId(restIdOf(path));
  const payload = body && restId ? { ...body, restId } : body;
  const res = await fetch(url, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const json = await res.json().catch(() => ({}));

  if (res.status === 401 && !_retried401) {
    await getBearerToken({ forceRefresh: true });
    return api(method, url, body, pathForAuth, { _retried401: true, _retried429 });
  }
  if (res.status === 401) {
    const user = getAuth().currentUser;
    rememberDenial(401, json?.code || "token_invalid", user?.uid || null, restId, tokenGeneration(user));
  }
  if (res.status === 403) {
    const code = json?.code || "";
    if (code === "restId_mismatch" || code === "token_missing_restId") {
      const user = getAuth().currentUser;
      rememberDenial(403, code, user?.uid || null, restId, tokenGeneration(user));
    }
  }
  if (res.status === 429 && _retried429 < 3) {
    const retryAfter = Number(res.headers.get("Retry-After"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(1000 * (2 ** _retried429), 8000);
    await sleep(waitMs);
    return api(method, url, body, pathForAuth, { _retried401, _retried429: _retried429 + 1 });
  }

  if (!res.ok) throw httpError(res.status, json);
  return json;
}

function snap(path, value) {
  return {
    val: () => (value === undefined ? null : value),
    exists: () => value != null,
    key: path.split("/").filter(Boolean).pop() || null,
    ref: wrapRef(path),
  };
}

function wrapRef(path, db) {
  return {
    __nestaPath: path,
    key: path.split("/").filter(Boolean).pop() || null,
    _db: db,
    toString: () => path,
    parent: path.includes("/") ? wrapRef(path.replace(/\/[^/]+$/, ""), db) : null,
  };
}

export function ref(db, path) {
  const p = path == null || path === "" ? "" : String(path);
  // Firebase rejects ref(db, "") — root must be ref(db) with no child path.
  const native = p === "" ? fbRef(db) : fbRef(db, p);
  const wrapped = wrapRef(p, db);
  wrapped._fb = native;
  return wrapped;
}

function toFb(r) {
  return r?._fb || r;
}

async function usePg(r) {
  const path = pathOf(r);
  const mode = await ensureMode();
  const plane = postgresDataPlane(path, mode);
  if (plane === "unmapped") {
    throw httpError(400, { error: "Unsupported path", code: "unmapped_path" });
  }
  if (plane === "postgres") {
    await ensureTenantAuthority(path);
    return true;
  }
  return false;
}

function applyQuery(value, constraints) {
  if (!constraints || !constraints.length || value == null || typeof value !== "object") return value;
  let entries = Object.entries(value);
  let orderField = null;
  let equal = undefined;
  let hasEqual = false;
  let limit = null;
  for (const c of constraints) {
    if (!c) continue;
    if (c.type === "orderByChild") orderField = c.field;
    if (c.type === "equalTo") { equal = c.v; hasEqual = true; }
    if (c.type === "limitToLast") limit = c.n;
  }
  if (orderField) {
    entries.sort((a, b) => {
      const av = a[1]?.[orderField]; const bv = b[1]?.[orderField];
      if (av == null && bv == null) return 0;
      if (av == null) return -1;
      if (bv == null) return 1;
      return av > bv ? 1 : av < bv ? -1 : 0;
    });
  }
  if (hasEqual && orderField) {
    entries = entries.filter(([, v]) => v && v[orderField] === equal);
  }
  if (limit != null) entries = entries.slice(-limit);
  const out = {};
  for (const [k, v] of entries) out[k] = v;
  return out;
}

async function pgGet(r) {
  const path = pathOf(r);
  const qkey = `${_authEpoch}\0${path}\0${JSON.stringify(r._query || null)}`;
  if (_inflightGet.has(qkey)) return _inflightGet.get(qkey);
  const pending = (async () => {
    const json = await api("POST", "/api/pg/rtdb/get", { path }, path);
    if (json.fallback) throw httpError(503, { error: "PG_UNAVAILABLE" });
    let value = json.value;
    if (r._query) value = applyQuery(value, r._query);
    return value;
  })().finally(() => { _inflightGet.delete(qkey); });
  _inflightGet.set(qkey, pending);
  return pending;
}

function clientPushId() {
  const chars = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
  let ts = Date.now();
  let time = "";
  for (let i = 7; i >= 0; i--) {
    time = chars.charAt(ts % 64) + time;
    ts = Math.floor(ts / 64);
  }
  let rand = "";
  for (let i = 0; i < 12; i++) rand += chars.charAt(Math.floor(Math.random() * 64));
  return time + rand;
}

async function emitSubscribe(restId) {
  const token = await getBearerToken().catch(() => null);
  const canonical = canonicalizeRestId(restId);
  if (!canonical || !_socket) return;
  const generation = `${Date.now()}:${++_subscriptionSerial}:${_authEpoch}`;
  _activeSubscription = { restId: canonical, generation, epoch: _authEpoch };
  _subscribedAck = false;
  _socket.emit("nesta:subscribe", {
    restId: canonical,
    generation,
    token,
    userId: getAuth().currentUser?.uid,
  });
}

function waitForSocketEvent(event, timeoutMs, predicate = () => true) {
  return new Promise((resolve) => {
    if (!_socket) return resolve(false);
    const t = setTimeout(() => {
      _socket.off(event, onMsg);
      resolve(false);
    }, timeoutMs);
    const onMsg = (msg) => {
      if (!predicate(msg)) return;
      clearTimeout(t);
      _socket.off(event, onMsg);
      resolve(true);
    };
    _socket.on(event, onMsg);
  });
}

async function emitResyncWithRetry() {
  if (_resyncInFlight || !_socket || !_socketRestId || !_subscribedAck) return;
  const expected = _activeSubscription;
  if (!expected || expected.epoch !== _authEpoch || expected.restId !== _socketRestId) return;
  _resyncInFlight = true;
  try {
    for (let i = 0; i < 3; i++) {
      if (
        !_subscribedAck ||
        _activeSubscription?.generation !== expected.generation ||
        _activeSubscription?.epoch !== expected.epoch
      ) break;
      _socket.emit("nesta:resync", {
        restId: expected.restId,
        generation: expected.generation,
        afterSeq: _lastSeq,
      });
      const ok = await Promise.race([
        waitForSocketEvent("nesta:resync", 4000, (msg) =>
          msg?.restId === expected.restId && msg?.generation === expected.generation),
        waitForSocketEvent("nesta:error", 4000, (e) =>
          e?.generation === expected.generation &&
          (e?.error === "not_subscribed" || e?.error === "resync_failed" || e?.error === "subscribe_denied")
        ).then((hit) => !hit && false),
      ]);
      if (ok) return;
      await sleep(300 * (i + 1));
    }
    for (const L of _listeners) scheduleRefresh(L);
  } finally {
    _resyncInFlight = false;
  }
}

async function ensureSocket(restId) {
  if (!restId) return;
  const user = await waitForAuthUser();
  if (!user) return;
  if (typeof window.io !== "function") {
    await new Promise((resolve, reject) => {
      if (document.querySelector("script[data-nesta-socket]")) {
        const t = setInterval(() => { if (typeof window.io === "function") { clearInterval(t); resolve(); } }, 50);
        setTimeout(() => { clearInterval(t); resolve(); }, 3000);
        return;
      }
      const s = document.createElement("script");
      s.src = "/socket.io/socket.io.js";
      s.dataset.nestaSocket = "1";
      s.onload = resolve;
      s.onerror = () => resolve();
      document.head.appendChild(s);
    });
  }
  if (typeof window.io !== "function") return;
  if (!_socket) {
    _socket = window.io({
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 400,
      reconnectionDelayMax: 5000,
      auth: async (cb) => {
        let token = null;
        try { token = await getBearerToken(); } catch { /* */ }
        cb({ token });
      },
    });
    _socket.on("connect", async () => {
      const wasReconnect = window.__nestaRealtimeState === "disconnected";
      window.__nestaRealtimeState = "connected";
      _subscribedAck = false;
      _pendingResync = wasReconnect;
      try {
        if (_socketRestId) await emitSubscribe(_socketRestId);
      } catch { /* */ }
    });
    _socket.on("disconnect", () => {
      window.__nestaRealtimeState = "disconnected";
      _subscribedAck = false;
    });
    _socket.on("nesta:event", (ev) => {
      const active = _activeSubscription;
      if (!matchesTenantEvent(active, ev, _authEpoch, _subscribedAck)) return;
      if (ev?.seq) _lastSeq = Math.max(_lastSeq, Number(ev.seq) || 0);
      if (!ev?.path) return;
      for (const L of _listeners) {
        if (L.halted || L.epoch !== _authEpoch || restIdOf(L.path) !== active.restId) continue;
        const p = L.path;
        if (ev.path === p || ev.path.startsWith(p + "/") || p.startsWith(String(ev.path) + "/") || prefixMatch(p, ev.path)) {
          scheduleRefresh(L);
        }
      }
    });
    _socket.on("nesta:resync", (msg) => {
      const active = _activeSubscription;
      if (!matchesSubscriptionMessage(active, msg, _authEpoch)) return;
      const events = msg?.events || [];
      if (events.length) _lastSeq = Math.max(_lastSeq, ...events.map((e) => Number(e.seq) || 0));
      for (const L of _listeners) {
        if (!L.halted && L.epoch === _authEpoch && restIdOf(L.path) === active.restId) scheduleRefresh(L);
      }
    });
    _socket.on("nesta:subscribed", async (msg) => {
      const active = _activeSubscription;
      if (!matchesSubscriptionMessage(active, msg, _authEpoch, { requireOk: true })) return;
      _subscribedAck = true;
      window.__nestaRealtimeState = "subscribed";
      if (_pendingResync) {
        _pendingResync = false;
        await emitResyncWithRetry();
      }
    });
    _socket.on("nesta:error", (err) => {
      if (err?.generation && err.generation !== _activeSubscription?.generation) return;
      if (err?.error === "resync_failed" || err?.error === "not_subscribed") {
        for (const L of _listeners) {
          if (!L.halted && L.epoch === _authEpoch) scheduleRefresh(L);
        }
      }
    });
  }
  if (_socketRestId !== restId) {
    if (_activeSubscription) {
      _socket.emit("nesta:unsubscribe", {
        restId: _activeSubscription.restId,
        generation: _activeSubscription.generation,
      });
    }
    _lastSeq = 0;
    _socketRestId = restId;
    await emitSubscribe(restId);
  }
}

function prefixMatch(listenerPath, eventPath) {
  if (!listenerPath || !eventPath) return false;
  const a = listenerPath.split("/");
  const b = String(eventPath).split("/");
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

function scheduleRefresh(L) {
  if (L.halted || L.epoch !== _authEpoch) return;
  const key = `${L.epoch}\0${L.path}\0${JSON.stringify(L.query || null)}`;
  if (_refreshTimers.has(key)) return;
  const t = setTimeout(() => {
    _refreshTimers.delete(key);
    refreshListener(L);
  }, 60);
  _refreshTimers.set(key, t);
}

async function refreshListener(L) {
  if (L.halted || L.epoch !== _authEpoch) return;
  const expectedEpoch = L.epoch;
  try {
    const value = await pgGet({ __nestaPath: L.path, _query: L.query });
    if (L.halted || L.epoch !== expectedEpoch || expectedEpoch !== _authEpoch) return;
    L.cb(snap(L.path, value));
  } catch (err) {
    if (err?.status === 401 || (err?.status === 403 && (err?.code === "restId_mismatch" || err?.code === "token_missing_restId" || err?.code === "TENANT_FORBIDDEN"))) {
      L.halted = true;
    }
    if (L.errCb) L.errCb(err);
  }
}

export function onValue(r, cb, errCb) {
  const path = pathOf(r);
  let unsub = () => {};
  let cancelled = false;
  (async () => {
    if (!(await usePg(r))) {
      if (cancelled) return;
      unsub = fbOnValue(toFb(r), cb, errCb) || (() => fbOff(toFb(r), "value", cb));
      return;
    }
    const L = { path, cb, errCb, query: r._query, epoch: _authEpoch, halted: false };
    _listeners.add(L);
    await ensureSocket(restIdOf(path));
    await refreshListener(L);
    unsub = () => { _listeners.delete(L); };
  })().catch((err) => { if (errCb) errCb(err); });
  return () => { cancelled = true; unsub(); };
}

export function onChildAdded(r, cb, errCb) {
  const seen = new Set();
  return onValue(r, (s) => {
    const val = s.val() || {};
    if (typeof val !== "object") return;
    for (const [k, v] of Object.entries(val)) {
      if (seen.has(k)) continue;
      seen.add(k);
      cb(snap(`${pathOf(r)}/${k}`, v));
    }
  }, errCb);
}

export function onChildChanged(r, cb, errCb) {
  let prev = {};
  return onValue(r, (s) => {
    const val = s.val() || {};
    if (typeof val !== "object") return;
    for (const [k, v] of Object.entries(val)) {
      if (JSON.stringify(prev[k]) !== JSON.stringify(v)) cb(snap(`${pathOf(r)}/${k}`, v));
    }
    prev = val;
  }, errCb);
}

export function onChildRemoved(r, cb, errCb) {
  let prev = {};
  return onValue(r, (s) => {
    const val = s.val() || {};
    if (typeof val !== "object") return;
    for (const k of Object.keys(prev)) {
      if (!(k in val)) cb(snap(`${pathOf(r)}/${k}`, prev[k]));
    }
    prev = val;
  }, errCb);
}

export function off(r, eventType, cb) {
  const path = pathOf(r);
  for (const L of [..._listeners]) {
    if (L.path === path && (!cb || L.cb === cb)) _listeners.delete(L);
  }
  try { fbOff(toFb(r), eventType, cb); } catch { /* native ref may be dummy */ }
}

export async function get(r) {
  if (!(await usePg(r))) return fbGet(toFb(r));
  const value = await pgGet(r);
  return snap(pathOf(r), value);
}

export async function set(r, value) {
  if (!(await usePg(r))) return fbSet(toFb(r), value);
  const path = pathOf(r);
  const json = await api("POST", "/api/pg/rtdb/set", { path, value }, path);
  if (json.fallback) throw httpError(503, { error: "PG_UNAVAILABLE" });
}

export async function update(r, values) {
  const path = pathOf(r);
  const mode = await ensureMode();
  const keys = values && typeof values === "object" ? Object.keys(values) : [];
  const absKeys = keys.map((k) => (k.startsWith("restaurants/") || k.startsWith("systemData/") || k.startsWith(".info/") ? k : (path ? `${path}/${k}` : k)));
  if (mode !== "postgres") return fbUpdate(toFb(r), values);
  const planes = (absKeys.length ? absKeys : [path]).map((k) => postgresDataPlane(k, mode));
  if (planes.some((p) => p === "unmapped") || postgresDataPlane(path, mode) === "unmapped") {
    throw httpError(400, { error: "Unsupported path", code: "unmapped_path" });
  }
  const anyPg = planes.some((p) => p === "postgres") || postgresDataPlane(path, mode) === "postgres";
  if (!anyPg) return fbUpdate(toFb(r), values);
  await ensureTenantAuthority(path || absKeys[0]);
  const json = await api("POST", "/api/pg/rtdb/update", { path, value: values }, path || keys[0]);
  if (json.fallback) throw httpError(503, { error: "PG_UNAVAILABLE" });
}

export async function remove(r) {
  if (!(await usePg(r))) return fbRemove(toFb(r));
  const path = pathOf(r);
  const json = await api("POST", "/api/pg/rtdb/remove", { path }, path);
  if (json.fallback) throw httpError(503, { error: "PG_UNAVAILABLE" });
}

export function push(r, value) {
  const path = pathOf(r);
  const localKey = clientPushId();
  const childPath = path ? `${path}/${localKey}` : localKey;
  const wrapped = wrapRef(childPath, r?._db);
  wrapped.key = localKey;
  const thenable = Promise.resolve().then(async () => {
    if (!(await usePg(r))) {
      const native = fbPush(toFb(r));
      wrapped.key = native.key;
      wrapped._fb = native;
      wrapped.__nestaPath = path ? `${path}/${native.key}` : native.key;
      if (value !== undefined) await fbSet(native, value);
      return wrapped;
    }
    if (value !== undefined) {
      const json = await api("POST", "/api/pg/rtdb/set", { path: childPath, value }, childPath);
      if (json.fallback) throw httpError(503, { error: "PG_UNAVAILABLE" });
    }
    return wrapped;
  });
  wrapped.then = thenable.then.bind(thenable);
  return wrapped;
}

export function query(r, ...constraints) {
  const wrapped = { ...wrapRef(pathOf(r), r?._db), _fb: toFb(r), _query: constraints };
  return wrapped;
}

export function orderByChild(field) { return { type: "orderByChild", field }; }
export function limitToLast(n) { return { type: "limitToLast", n }; }
export function equalTo(v) { return { type: "equalTo", v }; }

export async function runTransaction(r, updater) {
  if (!(await usePg(r))) return fbRunTransaction(toFb(r), updater);
  const path = pathOf(r);
  const current = await pgGet(r);
  const next = updater(current);
  if (next === undefined) return { committed: false, snapshot: snap(path, current) };
  const json = await api("POST", "/api/pg/rtdb/transaction", { path, next }, path);
  if (json.fallback) throw httpError(503, { error: "PG_UNAVAILABLE" });
  let value = json.value !== undefined ? json.value : next;
  if (typeof value === "object" && value !== null && (typeof next === "number" || typeof next === "string")) {
    value = next;
  }
  return { committed: true, snapshot: snap(path, value) };
}

window.__nestaRealtimeState = window.__nestaRealtimeState || "idle";
