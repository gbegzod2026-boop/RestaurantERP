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
import pg from "pg";
import dotenv from "dotenv";
import { withPgSsl } from "./pgSsl.js";

dotenv.config();

const { Pool } = pg;

let _pool = null;
let _warned = false;

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
  _pool.on("error", (err) => {
    // A pooled client emitted an error while idle (e.g. connection dropped) —
    // pg's own documented pattern is to log and let the pool recover, never
    // let this crash the process the way an unhandled 'error' event would.
    console.error("[postgres] idle client error:", err.message);
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
