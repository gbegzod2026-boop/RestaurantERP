// Repository migration contract for Step 2D.3 schema-only apply.
// Checksums are SHA-256 of the raw .up.sql file (same as applySchema).
// Public table sets are CREATE TABLE names through a version, plus
// schema_migrations (created by the apply bookkeeping, not a numbered file).
import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { REQUIRED_SCHEMA_VERSION } from "./migrationTargetGuard.mjs";

export const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";
export const SCHEMA_APPLY_REQUIRED_VERSION = REQUIRED_SCHEMA_VERSION;
export const SCHEMA_APPLY_PREDECESSOR_VERSION = predecessorOf(REQUIRED_SCHEMA_VERSION);

export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function stripTxWrappers(sql) {
  return String(sql || "").replace(/\bBEGIN\s*;/gi, "").replace(/\bCOMMIT\s*;\s*$/i, "");
}

function stripNoise(sql) {
  return String(sql || "")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'(?:[^']|'')*'/g, "''");
}

export function parseCreatedTableNames(sql) {
  const clean = stripNoise(sql);
  const names = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let m;
  while ((m = re.exec(clean))) names.push(m[1]);
  return names;
}

export function predecessorOf(requiredVersion) {
  const n = Number(requiredVersion);
  if (!Number.isInteger(n) || n < 2) return "";
  return String(n - 1).padStart(String(requiredVersion).length, "0");
}

export function expectedContiguousVersions(requiredVersion = REQUIRED_SCHEMA_VERSION) {
  const last = Number(requiredVersion);
  if (!Number.isInteger(last) || last < 1) {
    throw new Error(`STOP: invalid required schema version ${requiredVersion}`);
  }
  const width = String(requiredVersion).length;
  const out = [];
  for (let i = 1; i <= last; i++) out.push(String(i).padStart(width, "0"));
  return out;
}

export function assertRepoMigrationContract(migrations, requiredVersion = REQUIRED_SCHEMA_VERSION) {
  const list = migrations || [];
  if (!list.length) throw new Error("STOP: repository migration contract is empty");
  const expected = expectedContiguousVersions(requiredVersion);
  const versions = list.map((m) => m.version);
  const files = list.map((m) => m.file || `${m.version}_${m.name}.up.sql`);
  const seenVersion = new Set();
  const seenFile = new Set();
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!/^\d{4,}$/.test(String(m.version || ""))) {
      throw new Error(`STOP: malformed migration version ${m.version}`);
    }
    if (seenVersion.has(m.version)) {
      throw new Error(`STOP: duplicate migration version ${m.version}`);
    }
    seenVersion.add(m.version);
    const file = files[i];
    if (seenFile.has(file)) {
      throw new Error(`STOP: duplicate migration filename ${file}`);
    }
    seenFile.add(file);
  }
  const future = versions.filter((v) => v > requiredVersion);
  if (future.length) {
    throw new Error(`STOP: unexpected future migration version ${future.join(",")}; required contract ends at ${requiredVersion}`);
  }
  if (versions.join(",") !== expected.join(",")) {
    throw new Error(`STOP: repository migrations must be contiguous ${expected[0]}..${requiredVersion}`);
  }
  const predecessor = predecessorOf(requiredVersion);
  if (predecessorVersion(list, requiredVersion) !== predecessor) {
    throw new Error(`STOP: predecessor must be ${predecessor} for required ${requiredVersion}`);
  }
  return list;
}

export function loadRepoMigrations(migrationsDir, { requiredVersion = REQUIRED_SCHEMA_VERSION } = {}) {
  const loaded = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".up.sql"))
    .map((upFile) => {
      const m = upFile.match(/^(\d{4,})_(.+)\.up\.sql$/);
      if (!m) throw new Error(`bad migration name ${upFile}`);
      const sql = readFileSync(path.join(migrationsDir, upFile), "utf8");
      return {
        version: m[1],
        name: m[2],
        file: upFile,
        sql: stripTxWrappers(sql),
        checksum: sha256Text(sql),
      };
    })
    .sort((a, b) => a.version.localeCompare(b.version));
  return assertRepoMigrationContract(loaded, requiredVersion);
}

export function predecessorVersion(repoMigrations, requiredVersion) {
  const below = (repoMigrations || [])
    .map((m) => m.version)
    .filter((v) => v < requiredVersion)
    .sort();
  return below.length ? below[below.length - 1] : "";
}

export function expectedHistoryThrough(repoMigrations, throughVersion) {
  return (repoMigrations || [])
    .filter((m) => m.version <= throughVersion)
    .map((m) => ({
      version: m.version,
      name: m.name,
      checksum: m.checksum,
    }));
}

export function expectedPublicTablesThrough(repoMigrations, throughVersion) {
  const tables = new Set([SCHEMA_MIGRATIONS_TABLE]);
  for (const m of repoMigrations || []) {
    if (m.version > throughVersion) continue;
    for (const name of parseCreatedTableNames(m.sql)) tables.add(name);
  }
  return tables;
}

export function unknownMigrationVersions(appliedRows, repoMigrations) {
  const known = new Set((repoMigrations || []).map((m) => m.version));
  return (appliedRows || [])
    .map((row) => row.version)
    .filter((version) => version && !known.has(version));
}

export function matchMigrationHistory(appliedRows, expectedRows) {
  const applied = appliedRows || [];
  const expected = expectedRows || [];
  if (applied.length !== expected.length) {
    return {
      ok: false,
      reason: `schema_migrations count is ${applied.length}, required ${expected.length}`,
    };
  }
  for (let i = 0; i < expected.length; i++) {
    const a = applied[i];
    const e = expected[i];
    if (a.version !== e.version) {
      return {
        ok: false,
        reason: `schema_migrations[${i}] version is ${a.version || "(none)"}, required ${e.version}`,
      };
    }
    if (a.name !== e.name) {
      return {
        ok: false,
        reason: `schema_migrations ${e.version} name is ${a.name || "(none)"}, required ${e.name}`,
      };
    }
    if (!a.checksum || a.checksum !== e.checksum) {
      return {
        ok: false,
        reason: `schema_migrations ${e.version} checksum/name history does not match this working tree`,
      };
    }
  }
  return { ok: true };
}

export function publicTableDiff(actualTables, expectedSet) {
  const actual = new Set(actualTables || []);
  const expected = expectedSet instanceof Set ? expectedSet : new Set(expectedSet || []);
  const unexpected = [...actual].filter((t) => !expected.has(t)).sort();
  const missing = [...expected].filter((t) => !actual.has(t)).sort();
  return { unexpected, missing, ok: unexpected.length === 0 && missing.length === 0 };
}
