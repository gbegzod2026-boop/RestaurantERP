#!/usr/bin/env node
// db/migrate.js — production-safe migration runner (Phase 2 Wave 0).
//
// Deliberately hand-rolled instead of adding Prisma/Knex/node-pg-migrate:
// this backend already has zero query-builder/ORM dependencies (every
// Firebase call goes through the thin systemDb.js/firebaseAdmin.js
// abstractions, not a framework), and the `pg` package alone is enough to
// implement the four things a migration tool actually needs to guarantee —
// versioned, transactional, reversible, idempotent — without taking on a
// second dependency this codebase's own conventions don't otherwise call
// for. See the Wave 0 report for the tradeoff written out in full.
//
// Migration files live in db/migrations/ as pairs:
//   0001_wave0_core.up.sql
//   0001_wave0_core.down.sql
// The numeric prefix is the version and the sort order; the name after it
// is documentation only. Every migration runs inside one transaction —
// either the whole file applies or none of it does.
//
// Usage:
//   node db/migrate.js status        — list applied/pending, no changes
//   node db/migrate.js up            — apply every pending migration, in order
//   node db/migrate.js up --to 0002  — apply up through a specific version
//   node db/migrate.js down          — roll back exactly the last-applied migration
//   node db/migrate.js down --to 0   — roll back everything (down to empty)
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { getPool, isPgAvailable, maskedConfig, closePool } from "./postgres.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

const HISTORY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version      text PRIMARY KEY,
    name         text NOT NULL,
    checksum     text NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now()
  );
`;

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function loadMigrations() {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".up.sql"));
  const migrations = files
    .map((upFile) => {
      const m = upFile.match(/^(\d{4,})_(.+)\.up\.sql$/);
      if (!m) throw new Error(`Migration file does not match NNNN_name.up.sql pattern: ${upFile}`);
      const [, version, name] = m;
      const downFile = `${version}_${name}.down.sql`;
      const upPath = path.join(MIGRATIONS_DIR, upFile);
      const downPath = path.join(MIGRATIONS_DIR, downFile);
      let downSql = null;
      try {
        downSql = readFileSync(downPath, "utf8");
      } catch {
        throw new Error(`Missing down-migration for ${upFile}: expected ${downFile} — every migration must have a rollback (task requirement)`);
      }
      return {
        version,
        name,
        upSql: readFileSync(upPath, "utf8"),
        downSql,
        upChecksum: sha256(readFileSync(upPath, "utf8")),
      };
    })
    .sort((a, b) => a.version.localeCompare(b.version));

  // Duplicate-version guard — two files with the same numeric prefix is a
  // authoring mistake, not something the runner should silently pick one of.
  const seen = new Set();
  for (const m of migrations) {
    if (seen.has(m.version)) throw new Error(`Duplicate migration version ${m.version} — versions must be unique`);
    seen.add(m.version);
  }
  return migrations;
}

async function ensureHistoryTable(client) {
  await client.query(HISTORY_TABLE_SQL);
}

async function getApplied(client) {
  const { rows } = await client.query("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version");
  return rows;
}

async function cmdStatus() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureHistoryTable(client);
    const applied = await getApplied(client);
    const appliedMap = new Map(applied.map((r) => [r.version, r]));
    const all = loadMigrations();

    console.log(`\nMigrations (${all.length} total, ${applied.length} applied):\n`);
    for (const m of all) {
      const rec = appliedMap.get(m.version);
      if (!rec) {
        console.log(`  [ pending ] ${m.version}_${m.name}`);
      } else if (rec.checksum !== m.upChecksum) {
        console.log(`  [ ⚠ DRIFT ] ${m.version}_${m.name} — applied at ${rec.applied_at.toISOString()}, but the .up.sql file has changed since. Do not edit an applied migration; write a new one.`);
      } else {
        console.log(`  [ applied ] ${m.version}_${m.name} — ${rec.applied_at.toISOString()}`);
      }
    }
    console.log("");
  } finally {
    client.release();
  }
}

async function cmdUp(toVersion) {
  const pool = getPool();
  const all = loadMigrations();
  const client = await pool.connect();
  try {
    await ensureHistoryTable(client);
    const applied = await getApplied(client);
    const appliedVersions = new Set(applied.map((r) => r.version));

    for (const rec of applied) {
      const def = all.find((m) => m.version === rec.version);
      if (def && def.upChecksum !== rec.checksum) {
        throw new Error(`Refusing to continue: migration ${rec.version} was already applied but its .up.sql file has changed (checksum mismatch). Revert the file or write a new migration instead of editing history.`);
      }
    }

    const pending = all.filter((m) => !appliedVersions.has(m.version) && (!toVersion || m.version <= toVersion));
    if (!pending.length) {
      console.log("Nothing to apply — already up to date.");
      return;
    }

    for (const m of pending) {
      console.log(`Applying ${m.version}_${m.name} ...`);
      await client.query("BEGIN");
      try {
        await client.query(m.upSql);
        await client.query(
          "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [m.version, m.name, m.upChecksum]
        );
        await client.query("COMMIT");
        console.log(`  ✅ ${m.version}_${m.name}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  ❌ ${m.version}_${m.name} failed — transaction rolled back, nothing partially applied.`);
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

async function cmdDown(toVersion) {
  const pool = getPool();
  const all = loadMigrations();
  const byVersion = new Map(all.map((m) => [m.version, m]));
  const client = await pool.connect();
  try {
    await ensureHistoryTable(client);
    const applied = (await getApplied(client)).sort((a, b) => b.version.localeCompare(a.version)); // newest first

    const target = toVersion === "0" || toVersion === 0 ? null : toVersion;
    const toRollback = target
      ? applied.filter((r) => r.version > target)
      : applied.slice(0, 1); // default: exactly one step back

    if (!toRollback.length) {
      console.log("Nothing to roll back.");
      return;
    }

    for (const rec of toRollback) {
      const def = byVersion.get(rec.version);
      if (!def) throw new Error(`Cannot roll back ${rec.version} — its migration files are missing from db/migrations/ (were they deleted?)`);
      console.log(`Rolling back ${rec.version}_${rec.name} ...`);
      await client.query("BEGIN");
      try {
        await client.query(def.downSql);
        await client.query("DELETE FROM schema_migrations WHERE version = $1", [rec.version]);
        await client.query("COMMIT");
        console.log(`  ✅ rolled back ${rec.version}_${rec.name}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  ❌ rollback of ${rec.version}_${rec.name} failed — transaction rolled back, database unchanged.`);
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const toFlagIdx = rest.indexOf("--to");
  const toVersion = toFlagIdx !== -1 ? rest[toFlagIdx + 1] : null;

  if (!isPgAvailable()) {
    console.error("❌ PostgreSQL is not configured (see .env.example POSTGRES_* vars). Nothing to do.");
    process.exit(1);
  }
  const cfg = maskedConfig();
  console.log(`[migrate] target: ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

  try {
    if (cmd === "status") await cmdStatus();
    else if (cmd === "up") await cmdUp(toVersion);
    else if (cmd === "down") await cmdDown(toVersion);
    else {
      console.error("Usage: node db/migrate.js <status|up|down> [--to <version>]");
      process.exit(1);
    }
  } catch (err) {
    console.error("\n[migrate] FAILED:", err.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
