// pgRtdb.js — Firebase RTDB drop-in that routes mapped paths through the
// PostgreSQL HTTPS API + Socket.IO when DATA_BACKEND=postgres.
// Unmapped paths (subscription, systemData, credentials, …) still use Firebase.
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

export { forceWebSockets, getDatabase } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const MAPPED = new Set([
  "orders", "menu", "categories", "tables", "users", "customers", "reservations",
  "inventory", "ingredients", "notifications", "settings", "orderChangeRequests",
  "courierAssignments", "couriers", "orderTimeline", "meta", "activityLogs",
  "waiterCalls", "kitchenStations", "orderChats",
]);

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
const _inflightGet = new Map();
const _refreshTimers = new Map();

function hookAuthLifecycle() {
  if (_authHooked) return;
  _authHooked = true;
  try {
    getAuth().onAuthStateChanged((user) => {
      if (!user || user.uid !== _tokenCache.uid) {
        _tokenCache = { token: null, exp: 0, uid: null };
      }
    });
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
  return _mode === "unknown" ? "firebase" : _mode;
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
      _mode = j.dataBackend === "postgres" ? "postgres" : "firebase";
      return _mode;
    })
    .catch(() => {
      _mode = "firebase";
      return _mode;
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

function restIdOf(path) {
  const segs = String(path).split("/").filter(Boolean);
  return segs[0] === "restaurants" ? segs[1] : null;
}

function isMapped(path) {
  const segs = String(path).split("/").filter(Boolean);
  return segs[0] === "restaurants" && segs.length >= 3 && MAPPED.has(segs[2]);
}

async function authHeaders(path, { forceRefresh = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = await getBearerToken({ forceRefresh });
  if (token) headers.Authorization = `Bearer ${token}`;
  const restId = restIdOf(path);
  if (restId) {
    headers["x-rest-id"] = restId;
    headers["x-user-id"] = getAuth().currentUser?.uid || "";
  }
  return headers;
}

function httpError(status, json) {
  const err = new Error(json.error || `HTTP ${status}`);
  err.status = status;
  err.body = json;
  return err;
}

async function api(method, url, body, pathForAuth, { _retried401 = false, _retried429 = 0 } = {}) {
  const path = pathForAuth || (body && body.path) || "";
  await waitForAuthUser();
  const headers = await authHeaders(path, { forceRefresh: false });
  if (!headers.Authorization) {
    throw httpError(401, { error: "Authentication required" });
  }
  const restId = restIdOf(path);
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
  const mode = await ensureMode();
  return mode === "postgres" && isMapped(pathOf(r));
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
  const qkey = path + "\0" + JSON.stringify(r._query || null);
  if (_inflightGet.has(qkey)) return _inflightGet.get(qkey);
  const pending = (async () => {
    const json = await api("POST", "/api/pg/rtdb/get", { path }, path);
    if (json.fallback) return (await fbGet(toFb(r))).val();
    let value = json.value;
    if (r._query) value = applyQuery(value, r._query);
    return value;
  })().finally(() => { _inflightGet.delete(qkey); });
  _inflightGet.set(qkey, pending);
  return pending;
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
      try {
        const token = await getBearerToken();
        if (_socketRestId) _socket.emit("nesta:subscribe", { restId: _socketRestId, token, userId: getAuth().currentUser?.uid });
        if (wasReconnect) _socket.emit("nesta:resync", { restId: _socketRestId, afterSeq: _lastSeq });
      } catch { /* */ }
    });
    _socket.on("disconnect", () => { window.__nestaRealtimeState = "disconnected"; });
    _socket.on("nesta:event", (ev) => {
      if (ev?.seq) _lastSeq = Math.max(_lastSeq, Number(ev.seq) || 0);
      for (const L of _listeners) {
        const p = L.path;
        if (!ev.path || ev.path === p || ev.path.startsWith(p + "/") || p.startsWith(String(ev.path) + "/") || prefixMatch(p, ev.path)) {
          scheduleRefresh(L);
        } else if (ev.restId && restIdOf(p) === ev.restId) {
          scheduleRefresh(L);
        }
      }
    });
    _socket.on("nesta:resync", (msg) => {
      const events = msg?.events || [];
      if (events.length) _lastSeq = Math.max(_lastSeq, ...events.map((e) => Number(e.seq) || 0));
      for (const L of _listeners) scheduleRefresh(L);
    });
    _socket.on("nesta:subscribed", () => { window.__nestaRealtimeState = "subscribed"; });
  }
  if (_socketRestId !== restId) {
    _socketRestId = restId;
    try {
      const token = await getBearerToken();
      _socket.emit("nesta:subscribe", { restId, token, userId: getAuth().currentUser?.uid });
    } catch {
      _socket.emit("nesta:subscribe", { restId, userId: getAuth().currentUser?.uid });
    }
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
  const key = L.path + "\0" + JSON.stringify(L.query || null);
  if (_refreshTimers.has(key)) return;
  const t = setTimeout(() => {
    _refreshTimers.delete(key);
    refreshListener(L);
  }, 60);
  _refreshTimers.set(key, t);
}

async function refreshListener(L) {
  try {
    const value = await pgGet({ __nestaPath: L.path, _query: L.query });
    L.cb(snap(L.path, value));
  } catch (err) {
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
    const L = { path, cb, errCb, query: r._query };
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
  if (json.fallback) return fbSet(toFb(r), value);
}

export async function update(r, values) {
  const path = pathOf(r);
  const keys = values && typeof values === "object" ? Object.keys(values) : [];
  const looksMulti = keys.some((k) => k.includes("/"));
  if ((await ensureMode()) !== "postgres") return fbUpdate(toFb(r), values);
  const anyMapped = looksMulti
    ? keys.some((k) => isMapped(k.startsWith("restaurants/") ? k : `${path}/${k}`))
    : isMapped(path);
  if (!anyMapped) return fbUpdate(toFb(r), values);
  const json = await api("POST", "/api/pg/rtdb/update", { path, value: values }, path || keys[0]);
  if (json.fallback) return fbUpdate(toFb(r), values);
}

export async function remove(r) {
  if (!(await usePg(r))) return fbRemove(toFb(r));
  const path = pathOf(r);
  const json = await api("POST", "/api/pg/rtdb/remove", { path }, path);
  if (json.fallback) return fbRemove(toFb(r));
}

export function push(r, value) {
  const path = pathOf(r);
  const native = fbPush(toFb(r));
  const key = native.key;
  const childPath = path ? `${path}/${key}` : key;
  const wrapped = wrapRef(childPath, r?._db);
  wrapped.key = key;
  wrapped._fb = native;
  const thenable = Promise.resolve().then(async () => {
    if (!(await usePg(r))) {
      if (value !== undefined) await fbSet(native, value);
      return wrapped;
    }
    if (value !== undefined) {
      const json = await api("POST", "/api/pg/rtdb/set", { path: childPath, value }, childPath);
      if (json.fallback) await fbSet(native, value);
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
  if (json.fallback) return fbRunTransaction(toFb(r), updater);
  let value = json.value !== undefined ? json.value : next;
  if (typeof value === "object" && value !== null && (typeof next === "number" || typeof next === "string")) {
    value = next;
  }
  return { committed: true, snapshot: snap(path, value) };
}

ensureMode();
window.__nestaRealtimeState = window.__nestaRealtimeState || "idle";
