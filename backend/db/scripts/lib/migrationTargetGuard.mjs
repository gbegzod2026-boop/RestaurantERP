import {
  CUTOVER_CANDIDATE_TAG,
  HISTORICAL_FROZEN_TAG,
  STEP2C_TAG,
} from "./deployFreeze.mjs";

// Migration target policy.
// Default (unset NESTA_MIGRATE_TARGET): loopback + nesta_migration_dryrun only.
// Production --apply requires NESTA_MIGRATE_TARGET=production plus two exact
// confirmation strings. Callers must pass maskedConfig() (host/db/user only —
// never a password or URL). There is no yes/true/1 bypass.
export const MIGRATION_TARGET_DB = "nesta_migration_dryrun";
export const FORBIDDEN_DB = new Set(["postgres", "template0", "template1", "nesta_app", "nesta_migration_dryrun"]);
export const PRODUCTION_CONFIRM_PHRASE = "I_CONFIRM_PRODUCTION_FIREBASE_TO_POSTGRES_CUTOVER";
/** Step 2D.5 reviewed tag. Historical nesta-step2-cutover-ready never authorizes. */
export const PRODUCTION_REQUIRED_TAG = CUTOVER_CANDIDATE_TAG;
export const STEP2C_HISTORICAL_TAG = STEP2C_TAG;
export const REQUIRED_SCHEMA_VERSION = "0018";
const DRYRUN_FORBIDDEN_DB = new Set(["postgres", "template0", "template1", "nesta_app"]);
const TENANT_RLS_TABLES = ["restaurants", "employees", "orders", "order_items", "payments", "custom_roles"];

export function isLoopbackHost(host) {
  const h = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

export function assertMigrationTarget(masked) {
  if (!masked) {
    throw new Error("migration target refused: PostgreSQL is not configured");
  }
  if (!isLoopbackHost(masked.host)) {
    throw new Error("migration target refused: host is not loopback");
  }
  const db = String(masked.database || "").trim();
  if (DRYRUN_FORBIDDEN_DB.has(db)) {
    throw new Error(`migration target refused: database "${db}" is the fixture/system database`);
  }
  if (db !== MIGRATION_TARGET_DB) {
    throw new Error(`migration target refused: expected database ${MIGRATION_TARGET_DB}`);
  }
}

export function isProductionMigrateTarget(env = process.env) {
  return String(env.NESTA_MIGRATE_TARGET || "").trim() === "production";
}

export function isRailwayPgHost(host) {
  const h = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  return (
    h.endsWith(".proxy.rlwy.net")
    || h.endsWith(".rlwy.net")
    || h.endsWith(".railway.internal")
  );
}

export function sslConfigured(env = process.env) {
  if (String(env.POSTGRES_SSL || "").trim().toLowerCase() === "true") return true;
  const url = String(env.POSTGRES_URL || env.DATABASE_PUBLIC_URL || env.DATABASE_URL || "");
  if (/[?&]sslmode=(require|verify-full|verify-ca)\b/i.test(url)) return true;
  try {
    if (url && isRailwayPgHost(new URL(url).hostname)) return true;
  } catch { /* unparseable */ }
  return false;
}

/** Operator acknowledgement only. Never authorizes a populated target. */
export function productionResumeAllowed(env = process.env) {
  const value = String(env.NESTA_PRODUCTION_ALLOW_RESUME || "").trim();
  if (!value) return false;
  if (value === HISTORICAL_FROZEN_TAG || value === STEP2C_TAG) return false;
  return value === PRODUCTION_REQUIRED_TAG;
}

export function assertProductionStaticTarget(masked, env = process.env) {
  if (!masked) throw new Error("NO-GO: PostgreSQL is not configured");
  if (isLoopbackHost(masked.host)) {
    throw new Error("NO-GO: production target host is loopback");
  }
  const db = String(masked.database || "").trim();
  if (!db) throw new Error("NO-GO: production database name is empty");
  if (FORBIDDEN_DB.has(db) || db === MIGRATION_TARGET_DB) {
    throw new Error(`NO-GO: database "${db}" is not a production target`);
  }
  if (!sslConfigured(env)) {
    throw new Error("NO-GO: production PostgreSQL requires POSTGRES_SSL=true or sslmode=require");
  }
  if (String(env.NESTA_PRODUCTION_MIGRATE_CONFIRM || "") !== PRODUCTION_CONFIRM_PHRASE) {
    throw new Error("NO-GO: NESTA_PRODUCTION_MIGRATE_CONFIRM does not match the required phrase");
  }
  const tag = String(env.NESTA_PRODUCTION_MIGRATE_TAG || "").trim();
  if (tag === HISTORICAL_FROZEN_TAG || tag === STEP2C_TAG) {
    throw new Error("NO-GO: historical cutover tag cannot authorize Step 2D.5 production migration");
  }
  if (tag !== PRODUCTION_REQUIRED_TAG) {
    throw new Error(`NO-GO: NESTA_PRODUCTION_MIGRATE_TAG must be ${PRODUCTION_REQUIRED_TAG}`);
  }
}

export function assertApplyTarget(masked, env = process.env) {
  if (isProductionMigrateTarget(env)) {
    assertProductionStaticTarget(masked, env);
    return "production";
  }
  assertMigrationTarget(masked);
  return "dryrun";
}

export async function assertLiveApplyInvariants(client, { production, allowTenantRows } = {}) {
  if (!production) return;
  await client.query("SELECT set_config('app.current_restaurant_id', '', true)");
  const ver = await client.query(
    "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"
  ).catch(() => ({ rows: [] }));
  if (ver.rows[0]?.version !== REQUIRED_SCHEMA_VERSION) {
    throw new Error(`NO-GO: schema version is ${ver.rows[0]?.version || "(none)"}, required ${REQUIRED_SCHEMA_VERSION}`);
  }
  const rls = await client.query(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)
  `, [TENANT_RLS_TABLES]);
  for (const name of TENANT_RLS_TABLES) {
    const row = rls.rows.find((r) => r.relname === name);
    if (!row?.relrowsecurity || !row?.relforcerowsecurity) {
      throw new Error(`NO-GO: ${name} is missing RLS/FORCE RLS`);
    }
  }
  const fixtures = Number((await client.query(
    "SELECT count(*)::int AS n FROM restaurants WHERE legacy_rtdb_id LIKE 'rest_1999%'"
  )).rows[0].n);
  if (fixtures > 0) throw new Error("NO-GO: fixture rest_1999* rows present");
  const restaurants = Number((await client.query("SELECT count(*)::int AS n FROM restaurants")).rows[0].n);
  if (!allowTenantRows && restaurants > 0) {
    throw new Error("NO-GO: production database is not empty (restaurants > 0); populated target requires matching WAVE1_COMPLETE attempt provenance");
  }
}

export async function enforceConnectedApplyTarget(client, masked, env = process.env, {
  writesCommitted = false,
  resume = false,
  allowTenantRows = false,
  allowPopulatedTarget = false,
} = {}) {
  void resume;
  const mode = assertApplyTarget(masked, env);
  if (mode !== "production") return mode;
  const populated = allowPopulatedTarget === true || allowTenantRows === true;
  await assertLiveApplyInvariants(client, {
    production: true,
    allowTenantRows: writesCommitted && populated,
  });
  return mode;
}

export function withDatabaseName(connectionString, database) {
  const u = new URL(connectionString);
  u.pathname = `/${database}`;
  return u.toString();
}

export function readLocalPgParts() {
  const url = process.env.POSTGRES_URL || "";
  if (url) {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || "5432",
      database: decodeURIComponent((u.pathname || "/").replace(/^\//, "") || "postgres"),
      user: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
      connectionString: url,
    };
  }
  return {
    host: process.env.POSTGRES_HOST || "",
    port: String(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || "postgres",
    user: process.env.POSTGRES_USER || "",
    password: process.env.POSTGRES_PASSWORD || "",
  };
}

export function pgClientConfig(parts, databaseOverride) {
  const database = databaseOverride || parts.database;
  if (parts.connectionString) {
    return databaseOverride
      ? { connectionString: withDatabaseName(parts.connectionString, databaseOverride) }
      : { connectionString: parts.connectionString };
  }
  return {
    host: parts.host,
    port: Number(parts.port || 5432),
    database,
    user: parts.user,
    password: parts.password,
  };
}

export function migrationChildEnv(baseEnv, parts) {
  const env = { ...baseEnv };
  if (parts.connectionString) {
    env.POSTGRES_URL = withDatabaseName(parts.connectionString, MIGRATION_TARGET_DB);
  } else {
    // Keep an empty POSTGRES_URL so child dotenv.config() cannot reload a
    // fixture/production URL from .env (dotenv does not override existing keys).
    env.POSTGRES_URL = "";
    env.POSTGRES_HOST = parts.host;
    env.POSTGRES_PORT = String(parts.port || 5432);
    env.POSTGRES_DB = MIGRATION_TARGET_DB;
    env.POSTGRES_USER = parts.user;
    env.POSTGRES_PASSWORD = parts.password;
  }
  return env;
}
