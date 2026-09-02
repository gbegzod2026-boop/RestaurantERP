// Shared READ-ONLY Railway production PostgreSQL preflight.
// Authorization for Step 2D.5 comes from THIS in-process execution, never
// from PREFLIGHT.json. Every statement is SELECT/SHOW/SET/BEGIN/ROLLBACK.
// No INSERT/UPDATE/DELETE/DDL/GRANT/migrations/fixture writes.
import pg from "pg";
import {
  FORBIDDEN_DB,
  MIGRATION_TARGET_DB,
  REQUIRED_SCHEMA_VERSION,
  isLoopbackHost,
  sslConfigured,
  readLocalPgParts,
  pgClientConfig,
} from "./migrationTargetGuard.mjs";
import {
  TARGET_IDENTITY_SQL,
  isTargetFingerprint,
  targetFactsFromIdentityRow,
  targetFingerprintFromFacts,
} from "./pgTargetFingerprint.mjs";
import { withPgSsl } from "../../pgSsl.js";
import { READ_ONLY_BEGIN_SQL, READ_ONLY_LOCAL_SQL } from "./schemaApplySession.mjs";
import {
  CANONICAL_TENANT_RLS_TABLES,
  EXPECTED_TENANT_CATALOG_COUNT,
  REQUIRED_NAMED_RLS_TABLES,
} from "./tenantCatalog.mjs";

export { CANONICAL_TENANT_RLS_TABLES, EXPECTED_TENANT_CATALOG_COUNT, REQUIRED_NAMED_RLS_TABLES };

export const RAILWAY_PRODUCTION_PUBLIC_PROXY_HOST_CLASS = "*.proxy.rlwy.net";
export const REQUIRED_SCHEMA_MIGRATION_VERSION = REQUIRED_SCHEMA_VERSION;
export const REQUIRED_PREFLIGHT_ROLES = Object.freeze([
  "nesta_app",
  "nesta_credential_revealer",
  "nesta_login_reader",
]);
export const REQUIRED_PREFLIGHT_UNIQUES = Object.freeze([
  Object.freeze({ table: "restaurants", cols: Object.freeze(["legacy_rtdb_id"]) }),
  Object.freeze({ table: "employees", cols: Object.freeze(["restaurant_id", "legacy_rtdb_id"]) }),
  Object.freeze({ table: "orders", cols: Object.freeze(["restaurant_id", "legacy_rtdb_id"]) }),
  Object.freeze({ table: "custom_roles", cols: Object.freeze(["restaurant_id", "legacy_rtdb_id"]) }),
]);
export const REQUIRED_CONFIGURED_POOL_MAX = 10;
export const CANONICAL_ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const SESSION_READ_ONLY_SQL = "SET default_transaction_read_only = on";
export const TENANT_GUC_SQL = "SELECT set_config('app.current_restaurant_id', $1, true)";
export const SHOW_SSL_SQL = "SHOW ssl";
export const PGCRYPTO_SQL = "SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'";
export const ROLES_SQL = "SELECT rolname FROM pg_roles WHERE rolname = ANY($1)";
export const MIGRATIONS_SQL = "SELECT version FROM schema_migrations ORDER BY version";
export const RESTAURANTS_COUNT_SQL = "SELECT count(*)::int AS n FROM restaurants";
export const FIXTURE_COUNT_SQL = "SELECT count(*)::int AS n FROM restaurants WHERE legacy_rtdb_id LIKE 'rest_1999%'";
export const MAX_CONNECTIONS_SQL = "SHOW max_connections";
export const ROLLBACK_SQL = "ROLLBACK";
export { TARGET_IDENTITY_SQL };
export const UNIQUE_INDEX_SQL = `
          SELECT 1
          FROM pg_index i
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public' AND t.relname = $1 AND i.indisunique
            AND (
              SELECT array_agg(a.attname::text ORDER BY x.ordinality)
              FROM unnest(i.indkey) WITH ORDINALITY AS x(attnum, ordinality)
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
            ) = $2::text[]
        `;
export const TENANT_CATALOG_SQL = `
  SELECT c.relname AS table_name,
         c.relrowsecurity,
         c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND (
       c.relname = 'restaurants'
       OR EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid
            AND a.attname = 'restaurant_id'
            AND NOT a.attisdropped
            AND a.attnum > 0
       )
       OR c.relname IN ('employee_credentials', 'payment_credentials', 'combo_items')
     )
   ORDER BY c.relname
`;

const WRITE_VERB = /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|COPY|VACUUM|LOCK|CALL)\b/i;
const ALLOWED_PREFIX = /^(SET\b|BEGIN\b|SELECT\b|SHOW\b|ROLLBACK\b)/i;
const FAILURE_CODE_RE = /^[A-Z][A-Z0-9_]{2,64}$/;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const BEARER_RE = /Bearer\s+\S+/i;
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/\S+/i;
const KEYVAL_SECRET_RE = /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization|bearer|credential|database(?:_public)?_url|postgres_url|pgpassword)\s*[:=]\s*\S+/ig;
const SUSPICIOUS_KEY = /password|passwd|secret|token|api[_-]?key|private[_-]?key|client_email|serviceaccount|service[_-]?account|authorization|bearer|credential|database_url|database_public_url|postgres_url|pgpassword|firebase_|qr[_-]?sign|qr[_-]?secret|privatekey/i;
const CREDENTIAL_URI = /postgres(?:ql)?:\/\/[^\s/:]+:[^@\s]+@/i;
const PEM_BLOCK = /-----BEGIN ([A-Z ]+)?PRIVATE KEY-----/;

export const LIVE_RESULT_SCHEMA = Object.freeze({
  type: "object",
  keys: Object.freeze({
    ok: { type: "boolean" },
    verdict: { type: "string" },
    mode: { type: "string" },
    readOnly: { type: "boolean" },
    executed: { type: "boolean" },
    status: { type: "string" },
    hostClass: { type: "string" },
    database: { type: "string" },
    sslLive: { type: "string" },
    pgcrypto: { type: "boolean" },
    latestMigration: {
      type: "object",
      keys: Object.freeze({ version: { type: "string" } }),
    },
    restaurants: { type: "number" },
    fixtureLike: { type: "number" },
    configuredPoolMax: { type: "number" },
    rolesPresent: { type: "array", items: { type: "string" } },
    requiredUniques: {
      type: "array",
      items: {
        type: "object",
        keys: Object.freeze({
          table: { type: "string" },
          cols: { type: "array", items: { type: "string" } },
          ok: { type: "boolean" },
        }),
      },
    },
    rls: {
      type: "array",
      items: {
        type: "object",
        keys: Object.freeze({
          table: { type: "string" },
          rls: { type: "boolean" },
          force_rls: { type: "boolean" },
        }),
      },
    },
    rlsCatalogCount: { type: "number" },
    targetFingerprint: { type: "string" },
    failures: { type: "array", items: { type: "string" }, optional: true },
  }),
});

export function isCanonicalIsoUtc(value) {
  if (typeof value !== "string" || !CANONICAL_ISO_UTC_RE.test(value)) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString() === value;
}

export function railwayProductionPublicProxyHostClass(host) {
  const h = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h.endsWith(".proxy.rlwy.net")) return RAILWAY_PRODUCTION_PUBLIC_PROXY_HOST_CLASS;
  return null;
}

export const PREFLIGHT_SQL = Object.freeze({
  sessionReadOnly: SESSION_READ_ONLY_SQL,
  beginReadOnly: READ_ONLY_BEGIN_SQL,
  localReadOnly: READ_ONLY_LOCAL_SQL,
  tenantGuc: TENANT_GUC_SQL,
  showSsl: SHOW_SSL_SQL,
  pgcrypto: PGCRYPTO_SQL,
  roles: ROLES_SQL,
  migrations: MIGRATIONS_SQL,
  tenantCatalog: TENANT_CATALOG_SQL,
  restaurantsCount: RESTAURANTS_COUNT_SQL,
  fixtureCount: FIXTURE_COUNT_SQL,
  uniqueIndex: UNIQUE_INDEX_SQL,
  maxConnections: MAX_CONNECTIONS_SQL,
  targetIdentity: TARGET_IDENTITY_SQL,
  rollback: ROLLBACK_SQL,
});

export function railwayLivePreflightSqlList() {
  return Object.values(PREFLIGHT_SQL);
}

export function normalizePreflightSql(sql) {
  return String(sql || "").replace(/\s+/g, " ").trim().replace(/;+\s*$/, "");
}

const ALLOWED_PREFLIGHT_SQL = new Set(Object.values(PREFLIGHT_SQL).map(normalizePreflightSql));

export function assertReadOnlySql(sql) {
  const raw = String(sql || "");
  if (/;/.test(raw.replace(/;+\s*$/, ""))) {
    throw new Error("refusing multi-statement SQL in live preflight");
  }
  const normalized = normalizePreflightSql(raw);
  if (!ALLOWED_PREFLIGHT_SQL.has(normalized)) {
    throw new Error("refusing undeclared SQL in live preflight");
  }
  return normalized;
}

export function databasePublicUrlPresent(env = {}) {
  return Boolean(String(env.DATABASE_PUBLIC_URL || "").trim());
}

export function classifyPreflightFailure(err) {
  const msg = String(err?.message || err || "");
  if (/DATABASE_PUBLIC_URL is not set/i.test(msg) || msg === "DATABASE_PUBLIC_URL_UNSET") return "DATABASE_PUBLIC_URL_UNSET";
  if (/DATABASE_PUBLIC_URL is missing or unparseable/i.test(msg) || msg === "DATABASE_PUBLIC_URL_INVALID") return "DATABASE_PUBLIC_URL_INVALID";
  if (/PostgreSQL is not configured/i.test(msg) || msg === "PG_NOT_CONFIGURED") return "PG_NOT_CONFIGURED";
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect/i.test(msg)) return "PG_CONNECT_FAILED";
  if (/ssl/i.test(msg) && FAILURE_CODE_RE.test(msg) === false) return "PG_SSL_FAILED";
  if (typeof err === "string" && FAILURE_CODE_RE.test(err)) return err;
  return "PG_QUERY_FAILED";
}

export function classifyOperatorCliFailure(err) {
  const msg = String(err?.message || err || "");
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg)) return "PG_CONNECT_FAILED";
  return "OPERATOR_CLI_FAILED";
}

export function redactPreflightText(text) {
  return classifyPreflightFailure(text);
}

export function sanitizeDiagnosticText(text) {
  return classifyPreflightFailure(text);
}

function asFailureCode(value) {
  const code = typeof value === "string" && FAILURE_CODE_RE.test(value)
    ? value
    : classifyPreflightFailure(value);
  return FAILURE_CODE_RE.test(code) ? code : "PG_QUERY_FAILED";
}

function schemaError(path, msg) {
  return `${path}: ${msg}`;
}

export function validateClosedSchema(value, spec = LIVE_RESULT_SCHEMA, path = "$") {
  if (!spec) return schemaError(path, "missing spec");
  if (spec.optional && value === undefined) return null;
  if (spec.type === "string") {
    return typeof value === "string" ? null : schemaError(path, "expected string");
  }
  if (spec.type === "boolean") {
    return typeof value === "boolean" ? null : schemaError(path, "expected boolean");
  }
  if (spec.type === "number") {
    return typeof value === "number" && Number.isFinite(value) ? null : schemaError(path, "expected finite number");
  }
  if (spec.type === "array") {
    if (!Array.isArray(value)) return schemaError(path, "expected array");
    for (let i = 0; i < value.length; i++) {
      const err = validateClosedSchema(value[i], spec.items, `${path}[${i}]`);
      if (err) return err;
    }
    return null;
  }
  if (spec.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return schemaError(path, "expected object");
    }
    const allowed = spec.keys || {};
    for (const key of Object.keys(value)) {
      if (SUSPICIOUS_KEY.test(key)) return schemaError(`${path}.${key}`, "suspicious key");
      if (!Object.prototype.hasOwnProperty.call(allowed, key)) {
        return schemaError(`${path}.${key}`, "unknown property");
      }
    }
    for (const [key, child] of Object.entries(allowed)) {
      const err = validateClosedSchema(value[key], child, `${path}.${key}`);
      if (err) return err;
    }
    return null;
  }
  return schemaError(path, "unsupported spec");
}

function secretishString(value) {
  const text = String(value || "");
  return CREDENTIAL_URI.test(text)
    || PEM_BLOCK.test(text)
    || JWT_RE.test(text)
    || BEARER_RE.test(text)
    || URL_RE.test(text)
    || KEYVAL_SECRET_RE.test(text)
    || /firebaseio\.com|googleapis\.com|service_account/i.test(text);
}

function walkRejectSecrets(value) {
  if (typeof value === "string") {
    if (secretishString(value)) return true;
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(walkRejectSecrets);
  for (const [k, v] of Object.entries(value)) {
    if (SUSPICIOUS_KEY.test(k)) return true;
    if (walkRejectSecrets(v)) return true;
  }
  return false;
}

function colsEqual(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  if (actual.length !== expected.length) return false;
  return expected.every((col, i) => String(actual[i]) === String(col));
}

export function requiredUniquesSatisfied(rows) {
  if (!Array.isArray(rows)) return false;
  return REQUIRED_PREFLIGHT_UNIQUES.every((expected) => (
    rows.some((row) => (
      row
      && row.table === expected.table
      && colsEqual(row.cols, expected.cols)
      && row.ok === true
    ))
  ));
}

export function requiredRolesSatisfied(roles) {
  if (!Array.isArray(roles)) return false;
  return REQUIRED_PREFLIGHT_ROLES.every((name) => roles.includes(name));
}

export function requiredRlsSatisfied(rows, catalogCount) {
  if (!Array.isArray(rows)) return false;
  if (catalogCount !== EXPECTED_TENANT_CATALOG_COUNT) return false;
  if (rows.length !== EXPECTED_TENANT_CATALOG_COUNT) return false;
  const names = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") return false;
    if (typeof row.table !== "string" || !row.table) return false;
    if (row.rls !== true || row.force_rls !== true) return false;
    names.push(row.table);
  }
  if (new Set(names).size !== EXPECTED_TENANT_CATALOG_COUNT) return false;
  const expected = new Set(CANONICAL_TENANT_RLS_TABLES);
  if (names.some((name) => !expected.has(name))) return false;
  if (CANONICAL_TENANT_RLS_TABLES.some((name) => !names.includes(name))) return false;
  return REQUIRED_NAMED_RLS_TABLES.every((name) => names.includes(name));
}

function hostClassOf(host) {
  return railwayProductionPublicProxyHostClass(host)
    || (isLoopbackHost(host) ? "localhost" : (String(host || "").includes("railway.internal") ? "railway-internal" : "non-railway-public"));
}

function parsePublicUrlParts(env) {
  const url = String(env.DATABASE_PUBLIC_URL || "").trim();
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || "5432",
      database: decodeURIComponent((u.pathname || "/").replace(/^\//, "") || ""),
      user: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
      connectionString: url,
    };
  } catch {
    return { unparseable: true };
  }
}

function emptyLive({ status, failures, hostClass = "", database = "", configuredPoolMax = REQUIRED_CONFIGURED_POOL_MAX }) {
  return {
    ok: false,
    verdict: "NO-GO",
    mode: "READ-ONLY",
    readOnly: true,
    executed: false,
    status,
    hostClass,
    database,
    sslLive: "",
    pgcrypto: false,
    latestMigration: { version: "" },
    restaurants: -1,
    fixtureLike: -1,
    configuredPoolMax,
    rolesPresent: [],
    requiredUniques: [],
    rls: [],
    rlsCatalogCount: 0,
    targetFingerprint: "",
    failures: failures.map(asFailureCode),
  };
}

export function sanitizeLiveRailwayPreflightResult(raw = {}) {
  const failures = Array.isArray(raw.failures)
    ? raw.failures.map(asFailureCode)
    : [];
  return {
    ok: raw.ok === true,
    verdict: raw.verdict === "GO" ? "GO" : "NO-GO",
    mode: "READ-ONLY",
    readOnly: true,
    executed: raw.executed === true,
    status: typeof raw.status === "string" ? raw.status : (raw.ok === true ? "PASS" : "FAIL"),
    hostClass: raw.hostClass === RAILWAY_PRODUCTION_PUBLIC_PROXY_HOST_CLASS
      ? RAILWAY_PRODUCTION_PUBLIC_PROXY_HOST_CLASS
      : (typeof raw.hostClass === "string" ? raw.hostClass : ""),
    database: raw.database === "railway" ? "railway" : (typeof raw.database === "string" ? raw.database : ""),
    sslLive: String(raw.sslLive || "").toLowerCase() === "on" ? "on" : String(raw.sslLive || ""),
    pgcrypto: raw.pgcrypto === true,
    latestMigration: { version: String(raw.latestMigration?.version || "") },
    restaurants: Number(raw.restaurants),
    fixtureLike: Number(raw.fixtureLike),
    configuredPoolMax: Number(raw.configuredPoolMax),
    rolesPresent: Array.isArray(raw.rolesPresent) ? raw.rolesPresent.map(String) : [],
    requiredUniques: Array.isArray(raw.requiredUniques)
      ? raw.requiredUniques.map((row) => ({
        table: String(row?.table || ""),
        cols: Array.isArray(row?.cols) ? row.cols.map(String) : [],
        ok: row?.ok === true,
      }))
      : [],
    rls: Array.isArray(raw.rls)
      ? raw.rls.map((row) => ({
        table: String(row?.table || row?.table_name || ""),
        rls: row?.rls === true || row?.relrowsecurity === true,
        force_rls: row?.force_rls === true || row?.relforcerowsecurity === true,
      }))
      : [],
    rlsCatalogCount: Number(raw.rlsCatalogCount),
    targetFingerprint: isTargetFingerprint(raw.targetFingerprint) ? raw.targetFingerprint : "",
    failures,
  };
}

export function evaluateLiveRailwayPreflight(liveResult, {
  auditArtifact,
  requireZeroRestaurants = true,
} = {}) {
  void auditArtifact;
  if (liveResult == null) {
    return {
      railwayLivePreflight: "NOT RUN",
      reason: "live Railway preflight was not executed in this process",
    };
  }
  const schemaErr = validateClosedSchema(liveResult, LIVE_RESULT_SCHEMA);
  if (schemaErr) {
    return { railwayLivePreflight: "FAIL", reason: `live result schema: ${schemaErr}` };
  }
  if (walkRejectSecrets(liveResult)) {
    return { railwayLivePreflight: "FAIL", reason: "live result contains secret material" };
  }
  if (liveResult.executed !== true) {
    if (liveResult.status === "NOT RUN") {
      return { railwayLivePreflight: "NOT RUN", reason: liveResult.failures?.[0] || "live Railway preflight was not executed" };
    }
    return { railwayLivePreflight: "FAIL", reason: liveResult.failures?.[0] || "live Railway preflight did not execute queries" };
  }
  if (Array.isArray(liveResult.failures) && liveResult.failures.length > 0) {
    return { railwayLivePreflight: "FAIL", reason: liveResult.failures[0] };
  }
  if (liveResult.ok !== true || liveResult.verdict !== "GO" || liveResult.mode !== "READ-ONLY" || liveResult.readOnly !== true) {
    return { railwayLivePreflight: "FAIL", reason: "live result is not a READ-ONLY GO" };
  }
  if (liveResult.hostClass !== RAILWAY_PRODUCTION_PUBLIC_PROXY_HOST_CLASS) {
    return { railwayLivePreflight: "FAIL", reason: "hostClass is not the Railway production public proxy class" };
  }
  if (liveResult.database !== "railway") {
    return { railwayLivePreflight: "FAIL", reason: "database is not railway" };
  }
  if (liveResult.sslLive !== "on") {
    return { railwayLivePreflight: "FAIL", reason: "sslLive is not on" };
  }
  if (liveResult.pgcrypto !== true) {
    return { railwayLivePreflight: "FAIL", reason: "pgcrypto is not true" };
  }
  if (liveResult.latestMigration?.version !== REQUIRED_SCHEMA_MIGRATION_VERSION) {
    return { railwayLivePreflight: "FAIL", reason: `latestMigration.version is not ${REQUIRED_SCHEMA_MIGRATION_VERSION}` };
  }
  if (!isTargetFingerprint(liveResult.targetFingerprint)) {
    return { railwayLivePreflight: "FAIL", reason: "targetFingerprint is missing or malformed" };
  }
  if (requireZeroRestaurants && liveResult.restaurants !== 0) {
    return { railwayLivePreflight: "FAIL", reason: "restaurants is not 0" };
  }
  if (!requireZeroRestaurants && !(Number.isFinite(liveResult.restaurants) && liveResult.restaurants >= 0)) {
    return { railwayLivePreflight: "FAIL", reason: "restaurants count is unavailable" };
  }
  if (liveResult.fixtureLike !== 0) {
    return { railwayLivePreflight: "FAIL", reason: "fixtureLike is not 0" };
  }
  if (liveResult.configuredPoolMax !== REQUIRED_CONFIGURED_POOL_MAX) {
    return { railwayLivePreflight: "FAIL", reason: `configuredPoolMax is not ${REQUIRED_CONFIGURED_POOL_MAX}` };
  }
  if (!requiredRolesSatisfied(liveResult.rolesPresent)) {
    return { railwayLivePreflight: "FAIL", reason: "required roles are incomplete" };
  }
  if (!requiredUniquesSatisfied(liveResult.requiredUniques)) {
    return { railwayLivePreflight: "FAIL", reason: "required unique checks are incomplete or mismatched" };
  }
  if (!requiredRlsSatisfied(liveResult.rls, liveResult.rlsCatalogCount)) {
    return { railwayLivePreflight: "FAIL", reason: "required RLS/FORCE RLS catalog is incomplete" };
  }
  return {
    railwayLivePreflight: "PASS",
    reason: "in-process READ-ONLY Railway preflight GO",
  };
}

async function queryReadOnly(client, name, params) {
  const sql = PREFLIGHT_SQL[name];
  if (!sql) throw new Error("unknown preflight query");
  assertReadOnlySql(sql);
  return params !== undefined ? client.query(sql, params) : client.query(sql);
}

/**
 * Execute the genuine READ-ONLY Railway live preflight.
 * `clientFactory` is injectable for tests; production callers omit it.
 * PREFLIGHT.json is never consulted.
 */
export async function runRailwayLivePreflight({
  env = process.env,
  clientFactory = null,
  requireDatabasePublicUrl = true,
  requireZeroRestaurants = true,
} = {}) {
  const poolMax = Number(env.POSTGRES_POOL_MAX || REQUIRED_CONFIGURED_POOL_MAX) || REQUIRED_CONFIGURED_POOL_MAX;
  if (requireDatabasePublicUrl && !databasePublicUrlPresent(env)) {
    return sanitizeLiveRailwayPreflightResult(emptyLive({
      status: "NOT RUN",
      failures: ["DATABASE_PUBLIC_URL is not set"],
      configuredPoolMax: poolMax,
    }));
  }

  let parts;
  if (requireDatabasePublicUrl) {
    parts = parsePublicUrlParts(env);
    if (!parts || parts.unparseable || !parts.host) {
      return sanitizeLiveRailwayPreflightResult(emptyLive({
        status: "FAIL",
        failures: ["DATABASE_PUBLIC_URL is missing or unparseable"],
      }));
    }
  } else {
    parts = databasePublicUrlPresent(env) ? parsePublicUrlParts(env) : readLocalPgParts();
    if (!parts || parts.unparseable || !parts.host || !parts.user || !parts.database) {
      return sanitizeLiveRailwayPreflightResult(emptyLive({
        status: "NOT RUN",
        failures: ["PostgreSQL is not configured"],
      }));
    }
  }

  const failures = [];
  const hostClass = hostClassOf(parts.host);
  const db = String(parts.database || "").trim();
  if (isLoopbackHost(parts.host)) failures.push("PG_HOST_LOOPBACK");
  if (hostClass !== RAILWAY_PRODUCTION_PUBLIC_PROXY_HOST_CLASS) {
    failures.push("PG_HOST_NOT_RAILWAY_PUBLIC");
  }
  if (FORBIDDEN_DB.has(db) || db === "postgres" || db === MIGRATION_TARGET_DB) {
    failures.push("PG_DATABASE_FORBIDDEN");
  }
  if (!sslConfigured(env)) {
    failures.push("PG_SSL_NOT_CONFIGURED");
  }

  const { config: clientCfg } = withPgSsl(pgClientConfig(parts), parts.host);
  const client = clientFactory
    ? await clientFactory(clientCfg)
    : new pg.Client(clientCfg);

  const out = {
    ok: false,
    verdict: "NO-GO",
    mode: "READ-ONLY",
    readOnly: true,
    executed: false,
    status: "FAIL",
    hostClass,
    database: db,
    sslLive: "",
    pgcrypto: false,
    latestMigration: { version: "" },
    restaurants: -1,
    fixtureLike: -1,
    configuredPoolMax: poolMax,
    rolesPresent: [],
    requiredUniques: [],
    rls: [],
    rlsCatalogCount: 0,
    targetFingerprint: "",
    failures,
  };

  try {
    await client.connect();
    try {
      await queryReadOnly(client, "sessionReadOnly");
      await queryReadOnly(client, "beginReadOnly");
      await queryReadOnly(client, "localReadOnly");
      await queryReadOnly(client, "tenantGuc", [""]);
      out.executed = true;

      const ssl = await queryReadOnly(client, "showSsl").catch(() => ({ rows: [{ ssl: "off" }] }));
      out.sslLive = ssl.rows[0]?.ssl;
      if (String(out.sslLive).toLowerCase() !== "on") {
        failures.push("PG_SSL_NOT_ON");
      }

      const ext = await queryReadOnly(client, "pgcrypto");
      out.pgcrypto = ext.rowCount > 0;
      if (!out.pgcrypto) failures.push("PG_PGCRYPTO_MISSING");

      const roles = await queryReadOnly(client, "roles", [REQUIRED_PREFLIGHT_ROLES.slice()]);
      out.rolesPresent = roles.rows.map((r) => r.rolname).sort();
      for (const name of REQUIRED_PREFLIGHT_ROLES) {
        if (!out.rolesPresent.includes(name)) failures.push("PG_ROLE_MISSING");
      }

      const mig = await queryReadOnly(client, "migrations").catch(() => ({ rows: [] }));
      out.latestMigration = { version: String(mig.rows.at(-1)?.version || "") };
      if (out.latestMigration.version !== REQUIRED_SCHEMA_MIGRATION_VERSION) {
        failures.push("PG_SCHEMA_VERSION_MISMATCH");
      }

      const catalog = await queryReadOnly(client, "tenantCatalog");
      out.rls = catalog.rows.map((row) => ({
        table: String(row.table_name || row.table || ""),
        rls: row.relrowsecurity === true || row.rls === true,
        force_rls: row.relforcerowsecurity === true || row.force_rls === true,
      }));
      out.rlsCatalogCount = out.rls.length;
      if (!requiredRlsSatisfied(out.rls, out.rlsCatalogCount)) {
        failures.push("PG_RLS_CATALOG_MISMATCH");
      }
      for (const name of REQUIRED_NAMED_RLS_TABLES) {
        const row = out.rls.find((r) => r.table === name);
        if (!row) failures.push("PG_RLS_CRITICAL_MISSING");
        else {
          if (row.rls !== true) failures.push("PG_RLS_DISABLED");
          if (row.force_rls !== true) failures.push("PG_FORCE_RLS_DISABLED");
        }
      }
      for (const row of out.rls) {
        if (row.rls !== true) failures.push("PG_RLS_DISABLED");
        if (row.force_rls !== true) failures.push("PG_FORCE_RLS_DISABLED");
      }

      out.restaurants = Number((await queryReadOnly(client, "restaurantsCount")).rows[0].n);
      out.fixtureLike = Number((await queryReadOnly(client, "fixtureCount")).rows[0].n);
      if (requireZeroRestaurants && out.restaurants !== 0) failures.push("PG_RESTAURANTS_NONEMPTY");
      if (out.fixtureLike !== 0) failures.push("PG_FIXTURE_ROWS_PRESENT");

      try {
        const identity = await queryReadOnly(client, "targetIdentity");
        const fp = targetFingerprintFromFacts(targetFactsFromIdentityRow({
          host: parts.host,
          port: parts.port || "5432",
          database: db,
        }, identity.rows[0] || {}));
        if (!isTargetFingerprint(fp)) failures.push("PG_TARGET_IDENTITY_UNAVAILABLE");
        else out.targetFingerprint = fp;
      } catch {
        failures.push("PG_TARGET_IDENTITY_UNAVAILABLE");
      }

      const uniques = [];
      for (const spec of REQUIRED_PREFLIGHT_UNIQUES) {
        try {
          const found = await queryReadOnly(client, "uniqueIndex", [spec.table, spec.cols.slice()]);
          const ok = found.rowCount > 0;
          uniques.push({ table: spec.table, cols: spec.cols.slice(), ok });
          if (!ok) failures.push("PG_UNIQUE_MISSING");
        } catch {
          uniques.push({ table: spec.table, cols: spec.cols.slice(), ok: false });
          failures.push("PG_UNIQUE_CHECK_FAILED");
        }
      }
      out.requiredUniques = uniques;

      if (poolMax !== REQUIRED_CONFIGURED_POOL_MAX) {
        failures.push("PG_POOL_MAX_MISMATCH");
      }
      await queryReadOnly(client, "maxConnections");
      await queryReadOnly(client, "rollback");
    } catch (err) {
      failures.push(classifyPreflightFailure(err));
      await queryReadOnly(client, "rollback").catch(() => {});
    } finally {
      if (typeof client.end === "function") await client.end();
    }
  } catch (err) {
    failures.push(classifyPreflightFailure(err));
    try {
      if (typeof client?.end === "function") await client.end();
    } catch { /* ignore */ }
  }

  out.failures = failures.map(asFailureCode);
  out.ok = out.failures.length === 0 && out.executed === true;
  out.verdict = out.ok ? "GO" : "NO-GO";
  out.status = out.ok ? "PASS" : "FAIL";
  out.configuredPoolMax = poolMax;
  return sanitizeLiveRailwayPreflightResult(out);
}
