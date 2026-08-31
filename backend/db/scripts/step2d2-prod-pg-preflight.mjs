// READ-ONLY production PostgreSQL preflight. Never CREATE/ALTER/INSERT/DELETE.
// Uses the configured POSTGRES_* target as-is (does not rewrite to
// nesta_migration_dryrun). Exit 0 only when every production invariant holds.
// Prints NO-GO and exits 1 otherwise. Never prints passwords or URLs.
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  FORBIDDEN_DB,
  MIGRATION_TARGET_DB,
  REQUIRED_SCHEMA_VERSION,
  isLoopbackHost,
  sslConfigured,
  readLocalPgParts,
  pgClientConfig,
} from "./lib/migrationTargetGuard.mjs";
import { withPgSsl } from "../pgSsl.js";
import { redactPreflightText, writeRailwayLivePreflightEvidence } from "./lib/railwayLivePreflightEvidence.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
if (/:59999\b/.test(process.env.POSTGRES_URL || "")) delete process.env.POSTGRES_URL;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
delete process.env.NESTA_REQUIRE_ISOLATED_AUTH;
delete process.env.PORT;
dotenv.config({ path: path.join(__dirname, "../../.env"), quiet: true });
if (!process.env.POSTGRES_URL) {
  const alt = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (alt) process.env.POSTGRES_URL = alt;
}

const TENANT_RLS_TABLES = ["restaurants", "employees", "orders", "order_items", "payments", "custom_roles"];
const REQUIRED_ROLES = ["nesta_app", "nesta_login_reader", "nesta_credential_revealer"];
const REQUIRED_UNIQUES = [
  { table: "restaurants", cols: ["legacy_rtdb_id"] },
  { table: "employees", cols: ["restaurant_id", "legacy_rtdb_id"] },
  { table: "orders", cols: ["restaurant_id", "legacy_rtdb_id"] },
  { table: "custom_roles", cols: ["restaurant_id", "legacy_rtdb_id"] },
];

function hostClass(host) {
  if (isLoopbackHost(host)) return String(host || "").trim() || "(loopback)";
  return String(host || "").replace(/^[^.]+/, "*");
}

function fail(failures, msg) {
  failures.push(msg);
}

async function main() {
  const failures = [];
  const parts = readLocalPgParts();
  if (!parts.host || !parts.user || !parts.database) {
    const missing = {
      ok: false,
      verdict: "NO-GO",
      mode: "READ-ONLY",
      failures: ["PostgreSQL is not configured"],
    };
    writeRailwayLivePreflightEvidence(REPO, missing);
    console.log("NO-GO");
    console.log(JSON.stringify(missing, null, 2));
    process.exit(1);
  }

  const db = String(parts.database || "").trim();
  if (isLoopbackHost(parts.host)) fail(failures, "host is loopback");
  if (FORBIDDEN_DB.has(db) || db === "postgres" || db === MIGRATION_TARGET_DB) {
    fail(failures, `database "${db}" is forbidden for production`);
  }
  if (!sslConfigured(process.env)) {
    fail(failures, "SSL is not configured (POSTGRES_SSL=true or sslmode=require)");
  }

  const { config: clientCfg } = withPgSsl(pgClientConfig(parts), parts.host);

  const out = {
    ok: false,
    verdict: "NO-GO",
    mode: "READ-ONLY",
    hostClass: hostClass(parts.host),
    port: parts.port,
    database: db,
    userPresent: Boolean(parts.user),
    sslEnv: sslConfigured(process.env),
    failures,
  };

  const c = new pg.Client(clientCfg);
  await c.connect();
  try {
    await c.query("SET default_transaction_read_only = on");
    await c.query("BEGIN READ ONLY");
    await c.query("SELECT set_config('app.current_restaurant_id', '', true)");

    const ssl = await c.query("SHOW ssl").catch(() => ({ rows: [{ ssl: "off" }] }));
    out.sslLive = ssl.rows[0]?.ssl;
    if (String(out.sslLive).toLowerCase() !== "on") {
      fail(failures, `live SHOW ssl is ${out.sslLive}, required on`);
    }

    const ext = await c.query("SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'");
    out.pgcrypto = ext.rowCount > 0;
    if (!out.pgcrypto) fail(failures, "pgcrypto missing");

    const roles = await c.query(
      "SELECT rolname FROM pg_roles WHERE rolname = ANY($1)",
      [REQUIRED_ROLES]
    );
    out.rolesPresent = roles.rows.map((r) => r.rolname).sort();
    for (const name of REQUIRED_ROLES) {
      if (!out.rolesPresent.includes(name)) fail(failures, `role ${name} missing`);
    }

    const mig = await c.query(
      "SELECT version, name FROM schema_migrations ORDER BY version"
    ).catch(() => ({ rows: [] }));
    out.schemaMigrations = mig.rows.map((r) => `${r.version}:${r.name}`);
    out.latestMigration = mig.rows.at(-1) || null;
    if (out.latestMigration?.version !== REQUIRED_SCHEMA_VERSION) {
      fail(failures, `schema version ${out.latestMigration?.version || "(none)"}, required ${REQUIRED_SCHEMA_VERSION}`);
    }

    const rls = await c.query(`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)
      ORDER BY 1
    `, [TENANT_RLS_TABLES]);
    out.rls = rls.rows;
    for (const name of TENANT_RLS_TABLES) {
      const row = rls.rows.find((r) => r.table === name);
      if (!row?.rls) fail(failures, `${name} RLS disabled`);
      if (!row?.force_rls) fail(failures, `${name} FORCE RLS disabled`);
    }

    out.restaurants = Number((await c.query("SELECT count(*)::int AS n FROM restaurants")).rows[0].n);
    out.fixtureLike = Number((await c.query(
      "SELECT count(*)::int AS n FROM restaurants WHERE legacy_rtdb_id LIKE 'rest_1999%'"
    )).rows[0].n);
    if (out.restaurants !== 0) fail(failures, `restaurants=${out.restaurants}, required 0 before migration`);
    if (out.fixtureLike !== 0) fail(failures, `rest_1999* fixture rows=${out.fixtureLike}`);

    const uniques = [];
    for (const spec of REQUIRED_UNIQUES) {
      try {
        const found = await c.query(`
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
        `, [spec.table, spec.cols]);
        const ok = found.rowCount > 0;
        uniques.push({ table: spec.table, cols: spec.cols, ok });
        if (!ok) fail(failures, `unique ${spec.table}(${spec.cols.join(",")}) missing`);
      } catch (err) {
        uniques.push({ table: spec.table, cols: spec.cols, ok: false, error: err.message });
        fail(failures, `unique ${spec.table}(${spec.cols.join(",")}) check failed`);
      }
    }
    out.requiredUniques = uniques;

    const max = await c.query("SHOW max_connections");
    out.maxConnections = Number(max.rows[0].max_connections);
    const instances = Math.max(1, Number(process.env.NESTA_BACKEND_INSTANCES || 1) || 1);
    const poolEnv = Number(process.env.POSTGRES_POOL_MAX || 10) || 10;
    out.backendInstances = instances;
    out.configuredPoolMax = poolEnv;
    out.recommendedPoolMax = Math.max(5, Math.floor((out.maxConnections - 5 - 2) / instances));
    out.poolNote = "recommendedPoolMax = max(5, floor((max_connections - 5 monitor - 2 migrate) / instances))";
    await c.query("ROLLBACK");
  } catch (err) {
    fail(failures, err.message);
    await c.query("ROLLBACK").catch(() => {});
  } finally {
    await c.end();
  }

  out.failures = failures.map((f) => redactPreflightText(f));
  out.ok = out.failures.length === 0;
  out.verdict = out.ok ? "GO" : "NO-GO";
  writeRailwayLivePreflightEvidence(REPO, out);
  console.log(out.verdict);
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok) process.exit(1);
}

main().catch((err) => {
  const failed = {
    ok: false,
    verdict: "NO-GO",
    mode: "READ-ONLY",
    failures: [redactPreflightText(err.message)],
  };
  try { writeRailwayLivePreflightEvidence(REPO, failed); } catch { /* keep fail-closed */ }
  console.log("NO-GO");
  console.error("PREFLIGHT FAILED:", redactPreflightText(err.message));
  process.exit(1);
});
