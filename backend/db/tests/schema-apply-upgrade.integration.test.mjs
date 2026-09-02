import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import pg from "pg";
import {
  isLoopbackHost,
  readLocalPgParts,
  pgClientConfig,
  REQUIRED_SCHEMA_VERSION,
} from "../scripts/lib/migrationTargetGuard.mjs";
import {
  loadRepoMigrations,
  expectedPublicTablesThrough,
  SCHEMA_APPLY_PREDECESSOR_VERSION,
} from "../scripts/lib/schemaMigrationCatalog.mjs";
import { applyMissingMigrations } from "../scripts/lib/schemaApplySession.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "../..");
dotenv.config({ path: path.join(BACKEND, ".env"), quiet: true });

const parts = readLocalPgParts();
const skipReason = !parts.host || !parts.user
  ? "local PostgreSQL is not configured; 0017->0018 execution NOT VERIFIED"
  : !isLoopbackHost(parts.host)
    ? "configured PostgreSQL is not loopback; refusing remote/production; 0017->0018 execution NOT VERIFIED"
    : null;

if (skipReason) {
  test("schema 0017->0018 execution NOT VERIFIED", { skip: skipReason }, () => {});
} else {
  test("disposable local DB applies 0017 then 0018 and second run is no-op", async (t) => {
    const repo = loadRepoMigrations(path.join(here, "../migrations"));
    const tables0017 = expectedPublicTablesThrough(repo, SCHEMA_APPLY_PREDECESSOR_VERSION);
    const tables0018 = expectedPublicTablesThrough(repo, REQUIRED_SCHEMA_VERSION);
    const dbName = `nesta_r14_su_${Date.now()}`;
    const adminCfg = {
      ...pgClientConfig(parts, parts.database || "postgres"),
      connectionTimeoutMillis: 4000,
    };
    const admin = new pg.Client(adminCfg);
    let created = false;
    try {
      await admin.connect();
    } catch (err) {
      t.skip(`local PostgreSQL unreachable; 0017->0018 execution NOT VERIFIED: ${err.message}`);
      return;
    }
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
      created = true;
    } catch (err) {
      await admin.end().catch(() => {});
      t.skip(`local CREATE DATABASE unavailable; 0017->0018 execution NOT VERIFIED: ${err.message}`);
      return;
    }

    const client = new pg.Client({
      ...pgClientConfig(parts, dbName),
      connectionTimeoutMillis: 4000,
    });
    try {
      await client.connect();
      const first = await applyMissingMigrations(client, repo, {
        throughVersion: SCHEMA_APPLY_PREDECESSOR_VERSION,
      });
      assert.equal(first.some((m) => m.version === "0018"), false);
      const after17 = await publicTables(client);
      assert.equal(after17.length, tables0017.size);
      assert.equal(after17.includes("production_migration_attempts"), false);
      assert.equal(await countRestaurants(client), 0);

      const upgrade = await applyMissingMigrations(client, repo, {
        throughVersion: REQUIRED_SCHEMA_VERSION,
      });
      assert.equal(upgrade.find((m) => m.version === "0018")?.status, "applied");
      const after18 = await publicTables(client);
      assert.equal(after18.length, tables0018.size);
      assert.equal(after18.includes("production_migration_attempts"), true);
      const latest = (await client.query(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
      )).rows[0].version;
      assert.equal(latest, "0018");
      assert.equal(await countRestaurants(client), 0);
      const tenantish = Number((await client.query(
        "SELECT count(*)::int AS n FROM restaurants WHERE legacy_rtdb_id LIKE 'rest_1999%'",
      )).rows[0].n);
      assert.equal(tenantish, 0);

      const second = await applyMissingMigrations(client, repo, {
        throughVersion: REQUIRED_SCHEMA_VERSION,
      });
      assert.equal(second.every((m) => m.status === "already-applied"), true);
      assert.equal(second.find((m) => m.version === "0018")?.status, "already-applied");
    } finally {
      await client.end().catch(() => {});
      if (created) {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [dbName],
        ).catch(() => {});
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
      }
      await admin.end().catch(() => {});
    }
  });
}

async function publicTables(client) {
  const { rows } = await client.query(`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY 1
  `);
  return rows.map((r) => r.relname);
}

async function countRestaurants(client) {
  const { rows } = await client.query("SELECT count(*)::int AS n FROM restaurants");
  return Number(rows[0].n);
}
