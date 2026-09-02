// Local schema-only backup + restore drill. Loopback only. Never production.
// Creates a disposable empty database, applies schema through the required
// version, dumps schema, restores into a second disposable DB, verifies
// restaurants=0 and the required schema version.
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import path from "path";
import os from "os";
import pg from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import {
  readLocalPgParts,
  pgClientConfig,
  isLoopbackHost,
  REQUIRED_SCHEMA_VERSION,
} from "./lib/migrationTargetGuard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (/:59999\b/.test(process.env.POSTGRES_URL || "")) delete process.env.POSTGRES_URL;
dotenv.config({ path: path.join(__dirname, "../../.env"), quiet: true });

const SOURCE_DB = "nesta_schema_rehearsal";
const RESTORE_DB = "nesta_schema_rehearsal_restore";

function bin(name) {
  const fromEnv = process.env.POSTGRES_BIN_DIR;
  if (fromEnv) return path.join(fromEnv, name);
  const fallback = "D:\\nesta-postgresql\\pgsql\\bin";
  return path.join(fallback, name);
}

function run(cmd, args, extraEnv = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) {
    throw new Error(`${path.basename(cmd)} failed: ${(r.stderr || r.stdout || "").slice(0, 400)}`);
  }
  return r.stdout;
}

async function main() {
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const parts = readLocalPgParts();
  if (!isLoopbackHost(parts.host)) {
    throw new Error("refusing: restore drill is loopback-only");
  }
  const admin = new pg.Client(pgClientConfig(parts, "postgres"));
  await admin.connect();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nesta-schema-drill-"));
  const dumpFile = path.join(tmp, "schema.dump");
  const report = {
    loopback: true,
    sourceDb: SOURCE_DB,
    restoreDb: RESTORE_DB,
    dumpInTemp: true,
  };
  try {
    for (const name of [SOURCE_DB, RESTORE_DB]) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [name]).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    }
    await admin.query(`CREATE DATABASE ${SOURCE_DB}`);
    const migrateEnv = {
      POSTGRES_URL: "",
      POSTGRES_HOST: parts.host,
      POSTGRES_PORT: String(parts.port || 5432),
      POSTGRES_DB: SOURCE_DB,
      POSTGRES_USER: parts.user,
      POSTGRES_PASSWORD: parts.password,
    };
    const migrate = spawnSync(process.execPath, ["db/migrate.js", "up"], {
      cwd: path.join(__dirname, "../.."),
      encoding: "utf8",
      env: { ...process.env, ...migrateEnv, PORT: undefined },
    });
    if (migrate.status !== 0) {
      throw new Error(`migrate up failed: ${(migrate.stderr || migrate.stdout || "").slice(0, 400)}`);
    }
    const pgDump = bin("pg_dump.exe");
    const pgRestore = bin("pg_restore.exe");
    const dumpEnv = { PGPASSWORD: parts.password };
    run(pgDump, [
      "-h", parts.host, "-p", String(parts.port || 5432), "-U", parts.user,
      "-d", SOURCE_DB, "-F", "c", "-f", dumpFile, "--no-owner", "--no-privileges",
    ], dumpEnv);

    await admin.query(`CREATE DATABASE ${RESTORE_DB}`);
    run(pgRestore, [
      "-h", parts.host, "-p", String(parts.port || 5432), "-U", parts.user,
      "-d", RESTORE_DB, "--no-owner", "--no-privileges",
      dumpFile,
    ], dumpEnv);

    const restored = new pg.Client(pgClientConfig(parts, RESTORE_DB));
    await restored.connect();
    try {
      const mig = await restored.query("SELECT version, name FROM schema_migrations ORDER BY version");
      report.schemaMigrations = mig.rows.map((r) => `${r.version}:${r.name}`);
      report.latest = mig.rows.at(-1) || null;
      await restored.query("SELECT set_config('app.current_restaurant_id', '', true)");
      report.restaurants = Number((await restored.query("SELECT count(*)::int AS n FROM restaurants")).rows[0].n);
      report.fixtureLike = Number((await restored.query("SELECT count(*)::int AS n FROM restaurants WHERE legacy_rtdb_id LIKE 'rest_1999%'")).rows[0].n);
      const maxConn = await restored.query("SHOW max_connections");
      report.maxConnections = maxConn.rows[0].max_connections;
    } finally {
      await restored.end();
    }
    report.ok = report.restaurants === 0 && report.fixtureLike === 0 && report.latest?.version === REQUIRED_SCHEMA_VERSION;
  } finally {
    for (const name of [SOURCE_DB, RESTORE_DB]) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [name]).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    }
    await admin.end();
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((err) => {
  console.error("SCHEMA RESTORE DRILL FAILED:", err.message);
  process.exit(1);
});
