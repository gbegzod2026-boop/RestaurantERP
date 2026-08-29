import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { spawn } from "child_process";
import {
  MIGRATION_TARGET_DB,
  assertMigrationTarget,
  readLocalPgParts,
  pgClientConfig,
  migrationChildEnv,
} from "./lib/migrationTargetGuard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (/:59999\b/.test(process.env.POSTGRES_URL || "")) delete process.env.POSTGRES_URL;
if (process.env.FIREBASE_DATABASE_URL === "") delete process.env.FIREBASE_DATABASE_URL;
dotenv.config({ path: path.join(__dirname, "../../.env"), quiet: true });

async function main() {
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  delete process.env.NESTA_REQUIRE_ISOLATED_AUTH;
  const RESET = process.argv.includes("--reset");

  const parts = readLocalPgParts();
  if (!parts.host || !parts.user) throw new Error("PostgreSQL host/user not configured");
  assertMigrationTarget({ host: parts.host, port: parts.port, database: MIGRATION_TARGET_DB, user: parts.user });
  console.log(`cluster host class: ${parts.host}`);
  console.log(`maintenance database (CREATE DATABASE only): ${parts.database}`);
  console.log(`migration target database: ${MIGRATION_TARGET_DB}`);
  if (RESET) console.log("reset requested: DROP DATABASE then recreate (dedicated target only)");

  const admin = new pg.Client(pgClientConfig(parts));
  await admin.connect();
  try {
    const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [MIGRATION_TARGET_DB]);
    if (rows.length && RESET) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [MIGRATION_TARGET_DB]
      );
      await admin.query(`DROP DATABASE ${MIGRATION_TARGET_DB}`);
      console.log("dropped dedicated database");
    }
    const again = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [MIGRATION_TARGET_DB]);
    if (!again.rows.length) {
      await admin.query(`CREATE DATABASE ${MIGRATION_TARGET_DB}`);
      console.log("created dedicated database");
    } else {
      console.log("dedicated database already exists");
    }
  } finally {
    await admin.end();
  }

  const targetCfg = pgClientConfig(parts, MIGRATION_TARGET_DB);
  const target = new pg.Client(targetCfg);
  await target.connect();
  let restaurantCount = -1;
  try {
    const exists = await target.query("SELECT to_regclass('public.restaurants') AS t");
    if (exists.rows[0].t) {
      const c = await target.query("SELECT count(*)::int AS n FROM restaurants");
      restaurantCount = c.rows[0].n;
    } else {
      restaurantCount = 0;
    }
  } finally {
    await target.end();
  }
  console.log(`restaurants before schema apply: ${restaurantCount}`);
  if (restaurantCount > 0) throw new Error("dedicated database already has restaurant rows");

  const childEnv = migrationChildEnv(process.env, parts);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["db/migrate.js", "up"], {
      cwd: path.join(__dirname, "../.."),
      env: childEnv,
      stdio: "inherit",
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`migrate up exit ${code}`))));
  });

  const after = new pg.Client(targetCfg);
  await after.connect();
  try {
    const c = await after.query("SELECT count(*)::int AS n FROM restaurants");
    const prodish = await after.query(
      "SELECT count(*)::int AS n FROM restaurants WHERE legacy_rtdb_id IS NOT NULL AND legacy_rtdb_id NOT LIKE 'rest_1999%'"
    );
    console.log(JSON.stringify({
      targetDatabase: MIGRATION_TARGET_DB,
      hostClass: parts.host,
      port: parts.port,
      restaurantCount: c.rows[0].n,
      productionLegacyRows: prodish.rows[0].n,
    }));
    if (c.rows[0].n !== 0 || prodish.rows[0].n !== 0) {
      throw new Error("dedicated database is not empty after schema apply");
    }
  } finally {
    await after.end();
  }
}

main().catch((err) => {
  console.error("PREPARE FAILED:", err.message);
  process.exit(1);
});
