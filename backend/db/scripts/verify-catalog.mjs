#!/usr/bin/env node
// Live PostgreSQL catalog verification for Phase 1. Queries system catalogs
// only — no Firebase, no secrets printed.
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPool, closePool, maskedConfig } from "../postgres.js";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/migration-reports/catalog-verification.json");

const client = await getPool().connect();
try {
  const version = (await client.query("SELECT version() AS v, current_database() AS db")).rows[0];
  const migrations = (await client.query("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")).rows;
  const tables = (await client.query(`
    SELECT c.relname AS table_name,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`)).rows;
  const indexes = (await client.query(`
    SELECT indexrelid::regclass::text AS index_name,
           indrelid::regclass::text AS table_name,
           indisunique AS is_unique,
           indisprimary AS is_pk
      FROM pg_index
      JOIN pg_class t ON t.oid = indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
     ORDER BY 2, 1`)).rows;
  const fks = (await client.query(`
    SELECT conrelid::regclass::text AS table_name,
           conname,
           pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE contype = 'f' AND connamespace = 'public'::regnamespace
     ORDER BY 1, 2`)).rows;
  const uniques = (await client.query(`
    SELECT conrelid::regclass::text AS table_name,
           conname,
           pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE contype IN ('u','p') AND connamespace = 'public'::regnamespace
     ORDER BY 1, 2`)).rows;
  const checks = (await client.query(`
    SELECT conrelid::regclass::text AS table_name,
           conname,
           pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE contype = 'c' AND connamespace = 'public'::regnamespace
     ORDER BY 1, 2`)).rows;
  const policies = (await client.query(`
    SELECT schemaname, tablename, policyname, cmd, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
     ORDER BY tablename, policyname`)).rows;
  const rlsMissingForce = tables.filter((t) => t.rls_enabled && !t.rls_forced).map((t) => t.table_name);
  const rlsEnabled = tables.filter((t) => t.rls_enabled);
  const rlsForced = tables.filter((t) => t.rls_forced);

  const report = {
    verifiedAt: new Date().toISOString(),
    postgres: { version: version.v, database: version.db, ...maskedConfig() },
    migrations: migrations.map((m) => ({ version: m.version, name: m.name })),
    counts: {
      tables: tables.length,
      indexes: indexes.length,
      foreignKeys: fks.length,
      uniqueConstraints: uniques.length,
      checkConstraints: checks.length,
      rlsPolicies: policies.length,
      rlsEnabled: rlsEnabled.length,
      rlsForced: rlsForced.length,
    },
    tables: tables.map((t) => t.table_name),
    rlsEnabledButNotForced: rlsMissingForce,
    policies: policies.map((p) => ({ table: p.tablename, name: p.policyname, cmd: p.cmd })),
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.counts, null, 2));
  console.log("migrations:", report.migrations.map((m) => m.version).join(", "));
  console.log("tables:", report.counts.tables);
  console.log("rlsEnabledButNotForced:", rlsMissingForce.join(", ") || "(none)");
  console.log("wrote", OUT);
} finally {
  client.release();
  await closePool();
}
