// db/postgres.js — PostgreSQL connection layer (Phase 2, Wave 0).
//
// Same graceful-degrade posture as firebaseAdmin.js: if POSTGRES_* env vars
// aren't set, isPgAvailable() returns false and every other export throws a
// clear "not configured" error instead of crashing on import — this file is
// additive-only, nothing in the running app calls it yet (see the Wave 0
// report's "existing backend still starts" note), so there is no behavior
// to preserve here, just a contract to hold for whichever wave wires it in.
//
// Credentials: POSTGRES_PASSWORD (or POSTGRES_URL as a single connection
// string) comes from process.env only — .env locally, real environment
// variables in production. Never hardcoded, never logged (see maskedConfig()
// below, used only for the one-line startup log — logs host/db/user, never
// the password).
//
// Tenant isolation (RLS): every tenant-scoped query must run inside
// withTenantContext(restaurantId, fn) or withPlatformContext(fn) below —
// both open one transaction, SET LOCAL the session variable Wave 0's RLS
// policies check (app.current_restaurant_id), run the callback, and
// COMMIT/ROLLBACK. A bare pool.query() bypasses that and should only ever
// be used for genuinely tenant-agnostic reads (e.g. the migration runner
// itself). See db/migrations/0001_wave0_core.up.sql for the policies this
// pairs with, and db/tests/rls.test.mjs for the DENY/ALLOW proof.
import { AsyncLocalStorage } from "async_hooks";
import pg from "pg";
import dotenv from "dotenv";
import { withPgSsl } from "./pgSsl.js";

dotenv.config({ quiet: true });

const { Pool } = pg;

export const PG_IDLE_CLIENT_ERROR = "PG_IDLE_CLIENT_ERROR";
export const PG_CHECKED_OUT_CLIENT_ERROR = "PG_CHECKED_OUT_CLIENT_ERROR";
export const PG_CLIENT_RELEASE_FAILED = "PG_CLIENT_RELEASE_FAILED";
export const PG_POOL_CLOSE_FAILED = "PG_POOL_CLOSE_FAILED";
export const PG_CLEANUP_TIMEOUT = "PG_CLEANUP_TIMEOUT";
export const PG_ROLLBACK_FAILED = "PG_ROLLBACK_FAILED";

export const CREDENTIAL_CLI_ROLLBACK_TIMEOUT_MS = 1000;
export const CREDENTIAL_CLI_CALLBACK_SETTLE_TIMEOUT_MS = 1000;
export const CREDENTIAL_CLI_RELEASE_TIMEOUT_MS = 1000;
export const CREDENTIAL_CLI_POOL_CLOSE_TIMEOUT_MS = 5000;
export const CREDENTIAL_CLI_SAFE_CLIENT_KEYS = Object.freeze(["query"]);
/** Callback receives only safeClient. No second guard/context argument. */
export const CREDENTIAL_CLI_CALLBACK_CONTEXT_KEYS = Object.freeze([]);
export const CREDENTIAL_CLI_FORBIDDEN_HANDLE_KEYS = Object.freeze([
  "rawQuery",
  "originalQuery",
  "client",
  "rawClient",
  "pool",
  "connection",
  "stream",
  "queryable",
]);

const checkoutAls = new AsyncLocalStorage();
const idleReportedClients = new WeakSet();
let anonymousIdleReported = false;

const PHASE_ACTIVE = "active";
const PHASE_FAILED = "failed";
const PHASE_CLEANING = "cleaning";
const PHASE_RELEASED = "released";

let _pool = null;
let _warned = false;
let _credentialCliSafeMode = String(process.env.NESTA_CREDENTIAL_CLI_SAFE_MODE || "").trim() === "1";

export function enableCredentialCliSafeMode() {
  _credentialCliSafeMode = true;
}

export function isCredentialCliSafeMode() {
  return _credentialCliSafeMode === true
    || String(process.env.NESTA_CREDENTIAL_CLI_SAFE_MODE || "").trim() === "1";
}

export function reportIdleClientError(err) {
  if (isCredentialCliSafeMode()) {
    console.error(PG_IDLE_CLIENT_ERROR);
    return;
  }
  console.error("[postgres] idle client error:", err && err.message);
}

function reportIdleClientErrorOnce(client, err) {
  if (client) {
    const checkout = checkoutStates.get(client);
    if (checkout) {
      if (checkout.idleReported) return;
      checkout.idleReported = true;
    } else if (idleReportedClients.has(client)) {
      return;
    } else {
      idleReportedClients.add(client);
    }
  } else if (anonymousIdleReported) {
    return;
  } else {
    anonymousIdleReported = true;
  }
  if (isCredentialCliSafeMode()) {
    reportIdleClientError();
    return;
  }
  reportIdleClientError(err);
}

export function handleCredentialCliPoolError(err, client) {
  reportIdleClientErrorOnce(client, err);
}

export function reportCheckedOutClientError() {
  // Lifecycle helpers record/reject only. CLI boundary prints publicErrorCode once.
}

export function reportCredentialCliSafeCode() {
  // Lifecycle helpers record/reject only. CLI boundary prints publicErrorCode once.
}

function safeClientError(code) {
  const err = new Error(code);
  err.name = "CredentialCliClientError";
  err.code = code;
  return err;
}

export async function withCredentialCliTimeout(promise, ms, code) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(safeClientError(code)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const releasedIdleHandlers = new WeakMap();
const checkoutStates = new WeakMap();

function releasedIdleHandlerFor(client) {
  let handler = releasedIdleHandlers.get(client);
  if (!handler) {
    handler = function credentialCliReleasedClientSafeError() {
      const checkout = checkoutStates.get(client);
      if (checkout && checkout.phase !== PHASE_RELEASED) return;
      reportIdleClientErrorOnce(client);
    };
    releasedIdleHandlers.set(client, handler);
  }
  return handler;
}

function ensureReleasedIdleListener(client) {
  if (!client || typeof client.on !== "function") return;
  const handler = releasedIdleHandlerFor(client);
  if (typeof client.listeners === "function" && client.listeners("error").includes(handler)) return;
  client.on("error", handler);
}

export function attachCredentialCliClientGuard(client, options = {}) {
  const timeouts = {
    rollbackTimeoutMs: Number(options.rollbackTimeoutMs || CREDENTIAL_CLI_ROLLBACK_TIMEOUT_MS),
    callbackSettleTimeoutMs: Number(options.callbackSettleTimeoutMs || CREDENTIAL_CLI_CALLBACK_SETTLE_TIMEOUT_MS),
    releaseTimeoutMs: Number(options.releaseTimeoutMs || CREDENTIAL_CLI_RELEASE_TIMEOUT_MS),
  };
  const state = {
    phase: PHASE_ACTIVE,
    failed: false,
    error: null,
    reported: false,
    detached: false,
    sealed: false,
    rollbackAttempted: false,
    cleanupCode: null,
    idleReported: false,
  };
  const controller = new AbortController();
  let rejectFailure = () => {};
  const failure = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  failure.catch(() => {});

  let rawQuery = typeof client.query === "function" ? client.query.bind(client) : null;
  checkoutStates.set(client, state);

  function recordCleanup(code) {
    state.cleanupCode = code;
  }

  function markFailed() {
    if (state.reported) return state.error;
    state.reported = true;
    state.failed = true;
    if (state.phase === PHASE_ACTIVE) state.phase = PHASE_FAILED;
    state.error = safeClientError(PG_CHECKED_OUT_CLIENT_ERROR);
    reportCheckedOutClientError();
    if (!controller.signal.aborted) controller.abort();
    rejectFailure(state.error);
    return state.error;
  }

  const handler = () => {
    if (state.phase === PHASE_RELEASED) return;
    markFailed();
  };
  if (!client || typeof client.on !== "function") {
    throw safeClientError(PG_CHECKED_OUT_CLIENT_ERROR);
  }
  ensureReleasedIdleListener(client);
  client.on("error", handler);

  function throwIfFailed() {
    if (state.failed) throw state.error || safeClientError(PG_CHECKED_OUT_CLIENT_ERROR);
  }

  function checkoutClosed() {
    return state.phase !== PHASE_ACTIVE || state.sealed === true || !rawQuery;
  }

  function rollbackSqlText(args) {
    const first = args[0];
    if (typeof first === "string") return first;
    if (first && typeof first.text === "string") return first.text;
    return "";
  }

  function isFullRollbackSql(args) {
    return /^\s*ROLLBACK\s*;?\s*$/i.test(rollbackSqlText(args));
  }

  async function boundedRollback(sql = "ROLLBACK") {
    state.rollbackAttempted = true;
    if (!rawQuery) return { ok: true };
    const rb = await settleCredentialRollback(() => rawQuery(sql), timeouts.rollbackTimeoutMs);
    if (!rb.ok) recordCleanup(rb.code || PG_ROLLBACK_FAILED);
    return rb;
  }

  function credentialCliFacadeQuery(...args) {
    throwIfFailed();
    if (checkoutClosed()) {
      throw safeClientError(PG_CHECKED_OUT_CLIENT_ERROR);
    }
    if (isFullRollbackSql(args)) {
      const sql = rollbackSqlText(args) || "ROLLBACK";
      return boundedRollback(sql).then((rb) => {
        if (!rb.ok) {
          const err = safeClientError(rb.code || PG_ROLLBACK_FAILED);
          err.cleanupCode = rb.code || PG_ROLLBACK_FAILED;
          throw err;
        }
        return { rows: [] };
      });
    }
    let result;
    try {
      result = rawQuery(...args);
    } catch (err) {
      if (state.failed) throw state.error;
      throw err;
    }
    if (result && typeof result.then === "function") {
      return result.then((value) => {
        throwIfFailed();
        return value;
      }, (err) => {
        if (state.failed) throw state.error;
        throw err;
      });
    }
    throwIfFailed();
    return result;
  }

  const safeClient = Object.freeze(Object.assign(Object.create(null), {
    query: credentialCliFacadeQuery,
  }));

  function beginCleanup() {
    state.sealed = true;
    if (state.phase !== PHASE_RELEASED) state.phase = PHASE_CLEANING;
  }

  return {
    get phase() { return state.phase; },
    get failed() { return state.failed; },
    get error() { return state.error; },
    get cleanupCode() { return state.cleanupCode; },
    get rollbackAttempted() { return state.rollbackAttempted; },
    get attached() { return state.detached === false; },
    get sealed() { return state.sealed === true; },
    signal: controller.signal,
    failure,
    safeClient,
    throwIfFailed,
    beginCleanup,
    recordCleanup,
    boundedRollback,
    hasListener() {
      return typeof client.listeners === "function"
        ? client.listeners("error").includes(handler)
        : false;
    },
    async rollbackIfNeeded() {
      if (!state.failed) return;
      await boundedRollback("ROLLBACK");
    },
    async settleCallback(work) {
      try {
        await withCredentialCliTimeout(
          Promise.resolve(work).then(() => {}, () => {}),
          timeouts.callbackSettleTimeoutMs,
          PG_CLEANUP_TIMEOUT,
        );
      } catch {
        recordCleanup(PG_CLEANUP_TIMEOUT);
      }
    },
    async releaseOwned() {
      state.sealed = true;
      rawQuery = null;
      if (typeof client.release !== "function") {
        state.phase = PHASE_RELEASED;
        return;
      }
      try {
        const result = client.release();
        if (result && typeof result.then === "function") {
          await withCredentialCliTimeout(result, timeouts.releaseTimeoutMs, PG_CLIENT_RELEASE_FAILED);
        }
      } catch {
        recordCleanup(PG_CLIENT_RELEASE_FAILED);
      }
      state.phase = PHASE_RELEASED;
    },
    detach() {
      if (state.detached) return;
      ensureReleasedIdleListener(client);
      state.detached = true;
      if (typeof client.removeListener === "function") {
        client.removeListener("error", handler);
      }
    },
  };
}

export function guardedQuery(client, guard, sql, params) {
  if (guard) guard.throwIfFailed();
  const result = params !== undefined ? client.query(sql, params) : client.query(sql);
  if (result && typeof result.then === "function") {
    return result.then((value) => {
      if (guard) guard.throwIfFailed();
      return value;
    }, (err) => {
      if (guard && guard.failed) throw guard.error;
      throw err;
    });
  }
  if (guard) guard.throwIfFailed();
  return result;
}

export function throwIfCredentialCliFailed() {
  const store = checkoutAls.getStore();
  if (store && typeof store.throwIfFailed === "function") store.throwIfFailed();
}

/**
 * Run ROLLBACK under a deadline. Sync throws and Promise rejections both become
 * PG_ROLLBACK_FAILED; only a never-settling Promise becomes PG_CLEANUP_TIMEOUT.
 */
async function settleCredentialRollback(runQuery, timeoutMs) {
  let outcome;
  try {
    outcome = await withCredentialCliTimeout(
      Promise.resolve().then(() => runQuery()).then(
        () => ({ ok: true }),
        () => ({ ok: false, code: PG_ROLLBACK_FAILED }),
      ),
      timeoutMs,
      PG_CLEANUP_TIMEOUT,
    );
  } catch {
    return { ok: false, timedOut: true, code: PG_CLEANUP_TIMEOUT };
  }
  if (!outcome || outcome.ok !== true) {
    return { ok: false, code: PG_ROLLBACK_FAILED };
  }
  return { ok: true };
}

export async function boundedCredentialRollback(client, sql = "ROLLBACK") {
  const store = checkoutAls.getStore();
  if (store && typeof store.rollback === "function") {
    return store.rollback(sql);
  }
  const query = client && typeof client.query === "function" ? client.query.bind(client) : null;
  if (!query) return { ok: true };
  return settleCredentialRollback(() => query(sql), CREDENTIAL_CLI_ROLLBACK_TIMEOUT_MS);
}

function withCleanupMetadata(err, guard) {
  if (err && guard && guard.cleanupCode && !err.cleanupCode) {
    err.cleanupCode = guard.cleanupCode;
  }
  return err;
}

export async function withCredentialCliClient(pool, fn, options = {}) {
  enableCredentialCliSafeMode();
  const client = await pool.connect();
  let guard;
  try {
    guard = attachCredentialCliClientGuard(client, options);
  } catch (err) {
    try {
      if (typeof client.release === "function") client.release();
    } catch {
      throw safeClientError(PG_CLIENT_RELEASE_FAILED);
    }
    throw err;
  }
  const store = {
    throwIfFailed: () => guard.throwIfFailed(),
    rollback: (sql) => guard.boundedRollback(sql),
  };
  return checkoutAls.run(store, async () => {
    const work = Promise.resolve().then(() => fn(guard.safeClient));
    work.catch(() => {});
    let result;
    let caught = null;
    try {
      result = await Promise.race([work, guard.failure]);
      guard.throwIfFailed();
    } catch (err) {
      caught = guard.failed ? guard.error : err;
    }
    guard.beginCleanup();
    await guard.rollbackIfNeeded();
    await guard.settleCallback(work);
    await guard.releaseOwned();
    ensureReleasedIdleListener(client);
    guard.detach();
    if (caught) throw withCleanupMetadata(caught, guard);
    if (guard.failed) throw withCleanupMetadata(guard.error, guard);
    if (guard.cleanupCode) {
      throw withCleanupMetadata(safeClientError(guard.cleanupCode), guard);
    }
    return result;
  });
}

export async function runCredentialCliSession(pool, work, close, options = {}) {
  enableCredentialCliSafeMode();
  let result;
  let caught = null;
  try {
    result = await withCredentialCliClient(pool, work, options);
  } catch (err) {
    caught = err;
  }
  try {
    await closeCredentialCliPool(close);
  } catch (closeErr) {
    if (caught) {
      if (!caught.cleanupCode) caught.cleanupCode = closeErr.code;
    } else {
      caught = closeErr;
    }
  }
  if (caught) throw caught;
  return result;
}

function readConfig() {
  const url = process.env.POSTGRES_URL || "";
  if (url) {
    let host = "";
    try { host = new URL(url).hostname; } catch { host = ""; }
    const { config } = withPgSsl({
      connectionString: url,
      max: Number(process.env.POSTGRES_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
    }, host);
    return config;
  }
  const host = process.env.POSTGRES_HOST || "";
  const database = process.env.POSTGRES_DB || "";
  const user = process.env.POSTGRES_USER || "";
  const password = process.env.POSTGRES_PASSWORD || "";
  if (!host || !database || !user) return null;
  const { config } = withPgSsl({
    host,
    port: Number(process.env.POSTGRES_PORT || 5432),
    database,
    user,
    password,
    max: Number(process.env.POSTGRES_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
  }, host);
  return config;
}

/** Host/db/user only — safe for a startup log line. Never includes the
 *  password or a connection string (which may embed one). */
export function maskedConfig() {
  const cfg = readConfig();
  if (!cfg) return null;
  if (cfg.connectionString) {
    try {
      const u = new URL(cfg.connectionString);
      return { host: u.hostname, port: u.port || "5432", database: (u.pathname || "").replace(/^\//, ""), user: u.username || "" };
    } catch {
      return { host: "(unparseable POSTGRES_URL)", port: "", database: "", user: "" };
    }
  }
  return { host: cfg.host, port: String(cfg.port), database: cfg.database, user: cfg.user };
}

function tryInit() {
  if (_pool) return _pool;
  const cfg = readConfig();
  if (!cfg) {
    if (!_warned) {
      console.warn(
        "⚠️  [postgres] No POSTGRES_* config found (looked for POSTGRES_URL, or " +
        "POSTGRES_HOST+POSTGRES_DB+POSTGRES_USER+POSTGRES_PASSWORD). The Postgres " +
        "migration layer is DISABLED — nothing currently in the running app " +
        "depends on it, so this is expected until a real instance is provisioned. " +
        "See .env.example."
      );
      _warned = true;
    }
    return null;
  }
  _pool = new Pool(cfg);
  _pool.on("error", (err, client) => {
    if (isCredentialCliSafeMode()) {
      handleCredentialCliPoolError(err, client);
      return;
    }
    console.error("[postgres] idle client error:", err && err.message);
  });
  return _pool;
}

export function isPgAvailable() {
  return !!tryInit();
}

export function getPool() {
  const pool = tryInit();
  if (!pool) throw new Error("PostgreSQL is not configured — see .env.example POSTGRES_* vars");
  return pool;
}

/** Tenant-scoped work. Opens one transaction, SET LOCALs the session
 *  variables every Wave 0 RLS policy (and the role-escalation-prevention
 *  trigger on employees.role — see 0001_wave0_core.up.sql) checks, runs
 *  `fn(client)`, commits.
 *  restaurantId must be a real restaurants.id (uuid) — this function does
 *  not validate the caller's authorization to act as that tenant, that is
 *  the backend route's job (same division of responsibility as today's
 *  RTDB rules vs. Express route checks).
 *  `actingRole` (optional) is the calling employee's own role — set this
 *  whenever the caller is a real employee session, so the role-escalation
 *  trigger can tell an owner/admin's role change from anyone else's. Leave
 *  it unset for system-initiated writes with no employee behind them. */
export async function withTenantContext(restaurantId, fn, { actingRole = null, customerUid = null, customerTable = null } = {}) {
  if (!restaurantId) throw new Error("withTenantContext requires a restaurantId — use withPlatformContext for platform-level work");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // SET LOCAL ROLE nesta_app so FORCE ROW LEVEL SECURITY applies even when
    // the pool user is a table-owner/superuser (which would otherwise bypass
    // RLS). SET LOCAL, not SET — scoped to this transaction only.
    await client.query("SET LOCAL ROLE nesta_app");
    await client.query("SELECT set_config('app.current_restaurant_id', $1, true)", [String(restaurantId)]);
    await client.query("SELECT set_config('app.current_employee_role', $1, true)", [actingRole ? String(actingRole) : ""]);
    await client.query("SELECT set_config('app.current_customer_uid', $1, true)", [customerUid ? String(customerUid) : ""]);
    await client.query("SELECT set_config('app.current_customer_table', $1, true)", [customerTable ? String(customerTable) : ""]);
    const result = await fn(client);
    await client.query("COMMIT");
    try { await client.query("DISCARD ALL"); } catch { /* pool hygiene after tenant txn */ }
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    try { await client.query("DISCARD ALL"); } catch { /* pool hygiene after rollback */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Platform-level work (superadmin/platform_user) — explicitly clears the
 *  tenant context rather than leaving it unset, so RLS policies see a
 *  deliberate NULL instead of relying on connection-pool luck. Matches the
 *  RTDB rules' own "auth.token.restId == null means platform-level"
 *  convention (database.rules.json), carried over on purpose. */
export async function withPlatformContext(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE nesta_app");
    await client.query("SELECT set_config('app.current_restaurant_id', '', true)");
    await client.query("SELECT set_config('app.current_employee_role', '', true)");
    await client.query("SELECT set_config('app.current_customer_uid', '', true)");
    await client.query("SELECT set_config('app.current_customer_table', '', true)");
    const result = await fn(client);
    await client.query("COMMIT");
    try { await client.query("DISCARD ALL"); } catch { /* pool hygiene after platform txn */ }
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    try { await client.query("DISCARD ALL"); } catch { /* pool hygiene after rollback */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

export async function closeCredentialCliPool(close = closePool) {
  enableCredentialCliSafeMode();
  try {
    await withCredentialCliTimeout(
      Promise.resolve().then(() => close()),
      CREDENTIAL_CLI_POOL_CLOSE_TIMEOUT_MS,
      PG_POOL_CLOSE_FAILED,
    );
  } catch (err) {
    throw (err && err.code === PG_POOL_CLOSE_FAILED) ? err : safeClientError(PG_POOL_CLOSE_FAILED);
  }
}
