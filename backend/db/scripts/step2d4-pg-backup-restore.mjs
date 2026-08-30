// Step 2D.4 — Railway pg_dump (read) + restore into local nesta_step2d4_restore.
// DATABASE_PUBLIC_URL is the dump source only. Restore never uses it.
import { spawnSync } from "child_process";
import { mkdirSync, statSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { performance } from "perf_hooks";
import pg from "pg";
import dotenv from "dotenv";
import { withPgSsl } from "../pgSsl.js";
import { REQUIRED_SCHEMA_VERSION } from "./lib/migrationTargetGuard.mjs";
import {
  STEP2D4_RESTORE_DB,
  resolveDumpSource,
  resolveRestoreTarget,
  assertRestoreDatabaseName,
  redactSecrets,
  quoteIdent,
} from "./lib/pgBackupRestoreTarget.mjs";
import {
  parsePgVersionString,
  parseServerVersionNum,
  assertPgDumpCompatible,
  assertPgRestoreCompatible,
  resolvePgClientBins,
  probePgToolVersion,
  clientToolsReport,
} from "./lib/pgDumpClientGuard.mjs";
import {
  assertLocalRoleBootstrapTarget,
  requiredRestoreRoles,
  deriveRolesFromMigrationDir,
  bootstrapRestoreRoles,
  dropTemporaryRestoreRoles,
  classifyPgRestoreOutput,
} from "./lib/pgRestoreRoleBootstrap.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "../../..");
const BACKEND = path.join(__dirname, "../..");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = path.join(REPO, "cutover-backups", `pg-${STAMP}`);

const TENANT_CATALOG_SQL = `
  SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND (
       c.relname = 'restaurants'
       OR EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'restaurant_id'
            AND NOT a.attisdropped AND a.attnum > 0
       )
       OR c.relname IN ('employee_credentials', 'payment_credentials', 'combo_items')
     )
`;

function loadDotenvFile() {
  const isolated = {};
  dotenv.config({ path: path.join(BACKEND, ".env"), processEnv: isolated, quiet: true });
  return isolated;
}

function pgChildEnv(extraEnv) {
  const env = { ...process.env, ...extraEnv, PATH: process.env.PATH };
  delete env.DATABASE_URL;
  delete env.DATABASE_PUBLIC_URL;
  delete env.DATABASE_PRIVATE_URL;
  delete env.POSTGRES_URL;
  return env;
}

function runTool(exe, args, extraEnv, { maxText = 400 } = {}) {
  const r = spawnSync(exe, args, {
    encoding: "utf8",
    env: pgChildEnv(extraEnv),
  });
  return {
    status: r.status,
    text: redactSecrets((r.stderr || r.stdout || "").slice(0, maxText)),
  };
}

function runToolOrThrow(exe, args, extraEnv) {
  const r = runTool(exe, args, extraEnv);
  if (r.status !== 0) {
    throw new Error(`${path.basename(exe)} failed: ${r.text}`);
  }
}

function localClient(target, database) {
  return new pg.Client({
    host: target.host,
    port: Number(target.port || 5432),
    database,
    user: target.user,
    password: target.password,
  });
}

const REQUIRED_UNIQUES = [
  { table: "restaurants", cols: ["legacy_rtdb_id"] },
  { table: "employees", cols: ["restaurant_id", "legacy_rtdb_id"] },
  { table: "orders", cols: ["restaurant_id", "legacy_rtdb_id"] },
  { table: "custom_roles", cols: ["restaurant_id", "legacy_rtdb_id"] },
];

async function inspectRequiredUniques(client) {
  const uniques = [];
  for (const spec of REQUIRED_UNIQUES) {
    const found = await client.query(`
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
    uniques.push({ table: spec.table, cols: spec.cols, ok: found.rowCount > 0 });
  }
  return uniques;
}

async function inspectRestored(client) {
  await client.query("SELECT set_config('app.current_restaurant_id', '', true)");
  const ver = await client.query(
    "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"
  ).catch(() => ({ rows: [] }));
  const ext = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'");
  const roles = await client.query(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1)",
    [["nesta_app", "nesta_login_reader", "nesta_credential_revealer"]]
  );
  const restaurants = Number((await client.query("SELECT count(*)::int AS n FROM restaurants")).rows[0].n);
  const fixtures = Number((await client.query(
    "SELECT count(*)::int AS n FROM restaurants WHERE legacy_rtdb_id LIKE 'rest_1999%'"
  )).rows[0].n);
  const catalog = await client.query(TENANT_CATALOG_SQL);
  const missingRls = catalog.rows.filter((r) => r.relrowsecurity !== true).map((r) => r.table_name);
  const missingForce = catalog.rows.filter((r) => r.relforcerowsecurity !== true).map((r) => r.table_name);
  const uniques = await inspectRequiredUniques(client);
  return {
    latestMigration: ver.rows[0]?.version || null,
    pgcrypto: ext.rowCount > 0,
    applicationSchemaPresent: Boolean(ver.rows[0]?.version) && catalog.rows.length > 0,
    rolesPresentOnCluster: roles.rows.map((r) => r.rolname).sort(),
    roleHandling: "cluster-global roles are bootstrapped on the local loopback cluster before pg_restore; dump/read of Railway never CREATE ROLE",
    restaurants,
    fixtures,
    tenantCatalog: catalog.rows.length,
    rls: catalog.rows.filter((r) => r.relrowsecurity).length,
    forceRls: catalog.rows.filter((r) => r.relforcerowsecurity).length,
    missingRls,
    missingForce,
    requiredUniques: uniques,
  };
}

async function inspectSourceReadOnly(source) {
  const { config } = withPgSsl({
    host: source.host,
    port: Number(source.port),
    database: source.database,
    user: source.user,
    password: source.password,
    connectionTimeoutMillis: 20000,
  }, source.host);
  const c = new pg.Client(config);
  await c.connect();
  try {
    await c.query("BEGIN READ ONLY");
    await c.query("SET LOCAL default_transaction_read_only = on");
    const ssl = await c.query("SHOW ssl");
    const serverVer = await c.query("SHOW server_version");
    const serverNum = await c.query("SHOW server_version_num");
    const ver = await c.query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1");
    const restaurants = Number((await c.query("SELECT count(*)::int AS n FROM restaurants")).rows[0].n);
    const catalog = await c.query(TENANT_CATALOG_SQL);
    await c.query("ROLLBACK");
    const fromText = parsePgVersionString(serverVer.rows[0]?.server_version);
    const fromNum = parseServerVersionNum(serverNum.rows[0]?.server_version_num);
    const server = fromText.ok
      ? fromText
      : (fromNum ? { ok: true, ...fromNum, raw: String(serverVer.rows[0]?.server_version || "") } : { ok: false });
    return {
      sslLive: ssl.rows[0]?.ssl,
      latestMigration: ver.rows[0]?.version || null,
      restaurants,
      tenantCatalog: catalog.rows.length,
      rls: catalog.rows.filter((r) => r.relrowsecurity).length,
      forceRls: catalog.rows.filter((r) => r.relforcerowsecurity).length,
      serverVersion: server.ok ? server.raw : null,
      serverMajor: server.ok ? server.major : null,
    };
  } finally {
    await c.end();
  }
}

async function main() {
  const started = performance.now();
  const timings = { backupMs: null, restoreMs: null, validationMs: null, totalMs: null };
  const bins = resolvePgClientBins(process.env);
  const dumpProbe = probePgToolVersion(bins.pgDump.path);
  const restoreProbe = probePgToolVersion(bins.pgRestore.path);
  const tools = () => clientToolsReport(bins, dumpProbe, restoreProbe);

  const source = resolveDumpSource(process.env);
  if (!source.ok) {
    console.log(JSON.stringify({
      pgBackup: "NOT RUN",
      pgRestoreDrill: "NOT RUN",
      reason: source.reason,
      railwayAttempted: false,
      clientTools: tools(),
    }, null, 2));
    process.exit(2);
  }

  const restore = resolveRestoreTarget(process.env, loadDotenvFile());
  if (!restore.ok) {
    console.log(JSON.stringify({
      pgBackup: "NOT RUN",
      pgRestoreDrill: "FAIL",
      reason: restore.reason,
      sourceHostClass: source.hostClass,
      clientTools: tools(),
    }, null, 2));
    process.exit(1);
  }
  assertRestoreDatabaseName(restore.restoreDatabase);

  if (!dumpProbe.ok) {
    console.log(JSON.stringify({
      pgBackup: "FAIL",
      pgRestoreDrill: "NOT RUN",
      reason: `pg_dump --version failed (${dumpProbe.reason}). Set PG_DUMP_BIN to a PostgreSQL 18+ client.`,
      dumped: false,
      clientTools: tools(),
    }, null, 2));
    process.exit(1);
  }
  if (!restoreProbe.ok) {
    console.log(JSON.stringify({
      pgBackup: "FAIL",
      pgRestoreDrill: "NOT RUN",
      reason: `pg_restore --version failed (${restoreProbe.reason}). Set PG_RESTORE_BIN to a PostgreSQL 18+ client.`,
      dumped: false,
      clientTools: tools(),
    }, null, 2));
    process.exit(1);
  }

  let sourceLive;
  try {
    sourceLive = await inspectSourceReadOnly(source);
  } catch (err) {
    console.log(JSON.stringify({
      pgBackup: "FAIL",
      pgRestoreDrill: "NOT RUN",
      reason: redactSecrets(err.message),
      dumped: false,
      clientTools: tools(),
    }, null, 2));
    process.exit(1);
  }
  if (String(sourceLive.sslLive).toLowerCase() !== "on"
    || sourceLive.latestMigration !== REQUIRED_SCHEMA_VERSION
    || sourceLive.restaurants !== 0) {
    console.log(JSON.stringify({
      pgBackup: "FAIL",
      pgRestoreDrill: "NOT RUN",
      reason: "Railway source failed read-only pre-dump checks",
      dumped: false,
      sourceLive: {
        sslLive: sourceLive.sslLive,
        latestMigration: sourceLive.latestMigration,
        restaurants: sourceLive.restaurants,
        serverVersion: sourceLive.serverVersion,
      },
      clientTools: clientToolsReport(bins, dumpProbe, restoreProbe, sourceLive),
    }, null, 2));
    process.exit(1);
  }

  const dumpCompat = assertPgDumpCompatible(sourceLive.serverMajor, dumpProbe.major);
  if (!dumpCompat.ok) {
    console.log(JSON.stringify({
      pgBackup: "FAIL",
      pgRestoreDrill: "NOT RUN",
      reason: dumpCompat.reason,
      dumped: false,
      clientTools: clientToolsReport(bins, dumpProbe, restoreProbe, sourceLive),
    }, null, 2));
    process.exit(1);
  }
  const restoreCompat = assertPgRestoreCompatible(sourceLive.serverMajor, restoreProbe.major);
  if (!restoreCompat.ok) {
    console.log(JSON.stringify({
      pgBackup: "FAIL",
      pgRestoreDrill: "NOT RUN",
      reason: restoreCompat.reason,
      dumped: false,
      clientTools: clientToolsReport(bins, dumpProbe, restoreProbe, sourceLive),
    }, null, 2));
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const dumpFile = path.join(OUT_DIR, "railway-schema.pgdump");
  const tDump = performance.now();
  runToolOrThrow(bins.pgDump.path, [
    "--format=custom",
    "--no-owner",
    "--no-acl",
    "--file", dumpFile,
    "--no-password",
  ], {
    PGHOST: source.host,
    PGPORT: String(source.port),
    PGDATABASE: source.database,
    PGUSER: source.user,
    PGPASSWORD: source.password,
    PGSSLMODE: "require",
  });
  timings.backupMs = Math.round(performance.now() - tDump);
  const dumpStat = statSync(dumpFile);
  if (!dumpStat.size) throw new Error("pg_dump produced an empty artifact");

  const dumpList = runTool(bins.pgRestore.path, ["--list", dumpFile], {}, { maxText: 200000 });
  const migrationRoles = deriveRolesFromMigrationDir(path.join(BACKEND, "db", "migrations"));
  const rolesNeeded = requiredRestoreRoles({
    dumpListText: dumpList.text || "",
    migrationRoles,
  });

  const restoreIdent = quoteIdent(STEP2D4_RESTORE_DB);
  const tRestore = performance.now();
  const bootstrapGuard = assertLocalRoleBootstrapTarget(restore);
  if (!bootstrapGuard.ok) {
    console.log(JSON.stringify({
      pgBackup: dumpStat.size > 0 ? "PASS" : "FAIL",
      pgRestoreDrill: "FAIL",
      reason: bootstrapGuard.reason,
      dumped: true,
      railwayModified: false,
    }, null, 2));
    process.exit(1);
  }

  let roleBootstrap = {
    required: rolesNeeded,
    preexisting: [],
    created: [],
    dropped: [],
    skipped: [],
    dangerousPrivileges: "NONE",
  };

  const admin = localClient(restore, restore.adminDatabase);
  await admin.connect();
  try {
    roleBootstrap = {
      ...roleBootstrap,
      ...(await bootstrapRestoreRoles(admin, { restore, roles: rolesNeeded })),
    };
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [STEP2D4_RESTORE_DB]
    ).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${restoreIdent}`);
    await admin.query(`CREATE DATABASE ${restoreIdent}`);
  } finally {
    await admin.end();
  }

  const restoreTool = runTool(bins.pgRestore.path, [
    "--no-owner",
    "--no-acl",
    "--exit-on-error",
    "--dbname", STEP2D4_RESTORE_DB,
    dumpFile,
  ], {
    PGHOST: restore.host,
    PGPORT: String(restore.port),
    PGDATABASE: STEP2D4_RESTORE_DB,
    PGUSER: restore.user,
    PGPASSWORD: restore.password,
    PGSSLMODE: "disable",
  });
  timings.restoreMs = Math.round(performance.now() - tRestore);
  const restoreClassified = classifyPgRestoreOutput(restoreTool.status, restoreTool.text);

  const tVal = performance.now();
  let verified = {
    latestMigration: null,
    pgcrypto: false,
    applicationSchemaPresent: false,
    restaurants: null,
    fixtures: null,
    tenantCatalog: 0,
    rls: 0,
    forceRls: 0,
    missingRls: [],
    missingForce: [],
    requiredUniques: [],
  };
  try {
    const restored = localClient(restore, STEP2D4_RESTORE_DB);
    await restored.connect();
    try {
      verified = await inspectRestored(restored);
    } finally {
      await restored.end();
    }
  } catch (err) {
    verified.inspectError = redactSecrets(err.message);
  }

  const admin2 = localClient(restore, restore.adminDatabase);
  await admin2.connect();
  try {
    await admin2.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [STEP2D4_RESTORE_DB]
    ).catch(() => {});
    await admin2.query(`DROP DATABASE IF EXISTS ${restoreIdent}`);
    const cleanup = await dropTemporaryRestoreRoles(admin2, {
      restore,
      created: roleBootstrap.created,
    });
    roleBootstrap.dropped = cleanup.dropped;
    roleBootstrap.skipped = cleanup.skipped;
  } finally {
    await admin2.end();
  }
  timings.validationMs = Math.round(performance.now() - tVal);
  timings.totalMs = Math.round(performance.now() - started);

  const schemaOk = verified.latestMigration === REQUIRED_SCHEMA_VERSION;
  const emptyOk = verified.restaurants === 0 && verified.fixtures === 0;
  const rlsOk = verified.missingRls.length === 0 && verified.missingForce.length === 0
    && verified.tenantCatalog === sourceLive.tenantCatalog;
  const uniquesOk = verified.requiredUniques.every((u) => u.ok);
  const restoreToolOk = restoreClassified.ok;
  const ok = dumpStat.size > 0 && schemaOk && emptyOk && verified.pgcrypto && rlsOk
    && uniquesOk && restoreToolOk;

  const report = {
    pgBackup: dumpStat.size > 0 ? "PASS" : "FAIL",
    pgRestoreDrill: ok ? "PASS" : "FAIL",
    railwayModified: false,
    source: {
      hostClass: source.hostClass,
      database: source.database,
      urlKey: source.urlKey,
      sslLive: sourceLive.sslLive,
      latestMigration: sourceLive.latestMigration,
      serverVersion: sourceLive.serverVersion,
      serverMajor: sourceLive.serverMajor,
    },
    clientTools: clientToolsReport(bins, dumpProbe, restoreProbe, sourceLive),
    restoreTarget: {
      hostClass: restore.hostClass,
      adminDatabase: restore.adminDatabase,
      restoreDatabase: restore.restoreDatabase,
      droppedAfterVerify: true,
    },
    dumpBytes: dumpStat.size,
    backupArtifactTimestamp: dumpStat.mtime.toISOString(),
    dumpArtifactClass: "cutover-backups/pg-*/railway-schema.pgdump",
    restoreTool: {
      exitCode: restoreTool.status,
      classifiedOk: restoreClassified.ok,
      harmful: restoreClassified.harmful,
      detail: restoreTool.status === 0 ? null : restoreTool.text,
    },
    roleBootstrap,
    timings,
    verified,
    sourceCatalog: {
      tenantCatalog: sourceLive.tenantCatalog,
      rls: sourceLive.rls,
      forceRls: sourceLive.forceRls,
    },
  };
  writeFileSync(path.join(OUT_DIR, "DRILL.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error("PG BACKUP/RESTORE FAILED:", redactSecrets(err.message));
  process.exit(1);
});
