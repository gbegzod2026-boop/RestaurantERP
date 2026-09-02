// Session policy for Step 2D.3 schema provisioning.
// Identify/tls-probe/preflight stay read-only. Apply uses a dedicated
// writable session for DDL only. No tenant data imports live here.
//
// Two fail-closed apply paths:
//   A) fresh-provision: empty Railway public schema (optionally schema_migrations)
//   B) upgrade-from-predecessor: exact 0017 contract, then only missing 0018
// Already-at REQUIRED_SCHEMA_VERSION is ALREADY_CURRENT / no-op.
import { REQUIRED_SCHEMA_VERSION } from "./migrationTargetGuard.mjs";
import {
  expectedHistoryThrough,
  expectedPublicTablesThrough,
  matchMigrationHistory,
  predecessorVersion,
  publicTableDiff,
  unknownMigrationVersions,
  assertRepoMigrationContract,
  SCHEMA_APPLY_PREDECESSOR_VERSION,
} from "./schemaMigrationCatalog.mjs";

export const SCHEMA_APPLY_REQUIRED_DB = "railway";
export { REQUIRED_SCHEMA_VERSION as SCHEMA_APPLY_REQUIRED_VERSION };

export const SCHEMA_APPLY_MODE = Object.freeze({
  FRESH_PROVISION: "fresh-provision",
  UPGRADE_FROM_PREDECESSOR: "upgrade-from-predecessor",
  ALREADY_CURRENT: "already-current",
});

export function isReadOnlyAction(action) {
  return action === "tls-probe" || action === "identify";
}

export function isSchemaApplyAction(action) {
  return action === "apply";
}

export const SCHEMA_ONLY_NO_CREDENTIAL_ROTATION = "schema-only action does not rotate credentials";

/** Schema apply never rotates nesta_app. Use db/set-app-role-password.js. */
export function schemaOnlyAppPasswordReport(env = {}) {
  void env;
  return {
    attempted: false,
    rotated: false,
    credentialMutations: 0,
    reason: SCHEMA_ONLY_NO_CREDENTIAL_ROTATION,
  };
}

export const READ_ONLY_BEGIN_SQL = "BEGIN READ ONLY";
export const READ_ONLY_LOCAL_SQL = "SET LOCAL default_transaction_read_only = on";
export const APPLY_WRITABLE_SQL = [
  "SET default_transaction_read_only = off",
  "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
];

export const PRODUCTION_SCHEMA_PROVISIONING_REQUIREMENTS = Object.freeze([
  "Choose one reviewed schema path: (A) initial provisioning of an empty Railway database named railway, or (B) in-place schema-only upgrade from the exact predecessor schema to the required version.",
  "Path A — initial provisioning: empty public schema (schema_migrations only is allowed), restaurants absent or 0, rest_1999*=0; apply 0001 through the required version with this working tree's checksums.",
  "Path B — in-place upgrade: latest schema_migrations must be the exact predecessor (currently 0017), 0001–predecessor names/checksums must match this working tree, public tables must be the canonical predecessor set (not an unrelated database that happens to have restaurants=0), restaurants=0, rest_1999*=0; then apply only the missing required version (currently 0018).",
  "Already at the required version is a schema-only no-op: verify, do not re-run destructive SQL.",
  "Do not reuse database name postgres (Step 1 fixture) or nesta_migration_dryrun.",
  "Confirm pgcrypto, FORCE RLS on tenant tables, roles nesta_app / nesta_login_reader / nesta_credential_revealer.",
  "Set nesta_app password via db:set-app-password; schema apply never rotates credentials.",
  "production_migration_attempts (0018) is platform-only: no restaurant_id, no nesta_app grants.",
]);

function fail(reason) {
  return { ok: false, reason, mode: null, allowWritable: false };
}

function latestMigrationVersion(live = {}) {
  const raw = live.latestMigration;
  if (raw == null || raw === "") return "";
  if (typeof raw === "string") return raw.split(":")[0];
  return String(raw.version || "");
}

function appliedRows(live = {}) {
  if (Array.isArray(live.schemaMigrationRows) && live.schemaMigrationRows.length) {
    return live.schemaMigrationRows.map((row) => ({
      version: String(row.version || ""),
      name: String(row.name || ""),
      checksum: row.checksum == null ? "" : String(row.checksum),
    }));
  }
  return [];
}

function identityStop({ snap, live }) {
  if (!snap || !live) return "STOP: missing identity snapshot";
  if (snap.loopback) return "STOP: host is loopback";
  if (snap.providerClass !== "PUBLIC MANAGED") {
    return `STOP: providerClass is ${snap.providerClass}, required PUBLIC MANAGED`;
  }
  const db = String(live.currentDatabase || snap.database || "").trim();
  if (!db) return "STOP: database name empty";
  if (db === "postgres") return 'STOP: database "postgres" is not a production target';
  if (db === "nesta_migration_dryrun") return "STOP: refusing nesta_migration_dryrun";
  if (db !== SCHEMA_APPLY_REQUIRED_DB) {
    return `STOP: current_database is ${db}, required ${SCHEMA_APPLY_REQUIRED_DB}`;
  }
  if (String(live.sslLive || "").toLowerCase() !== "on") {
    return `STOP: SSL live is ${live.sslLive}, required on`;
  }
  if (live.serverAddrClass === "loopback") return "STOP: connected server is loopback";
  if (live.restaurantsTableExists && Number(live.restaurants) > 0) {
    return `STOP: restaurants=${live.restaurants}, required 0`;
  }
  if (Number(live.fixtureLike) > 0) {
    return `STOP: rest_1999* fixture rows=${live.fixtureLike}`;
  }
  return null;
}

function assertCatalogMatch(actualTables, expectedSet, label) {
  const diff = publicTableDiff(actualTables, expectedSet);
  if (diff.unexpected.length) {
    return fail(`STOP: public tables already present: ${diff.unexpected.join(",")}`);
  }
  if (diff.missing.length) {
    return fail(`STOP: ${label} public schema is missing tables: ${diff.missing.join(",")}`);
  }
  return null;
}

export function classifySchemaApplyPath({ live, repoMigrations } = {}) {
  if (!Array.isArray(repoMigrations) || repoMigrations.length === 0) {
    return fail("STOP: repository migration contract is missing");
  }
  const required = REQUIRED_SCHEMA_VERSION;
  const predecessor = predecessorVersion(repoMigrations, required);
  if (!predecessor) return fail("STOP: no predecessor migration exists");
  if (live?.schemaMigrationChecksumsUnavailable) {
    return fail("STOP: schema_migrations checksums are unavailable");
  }

  const tables = Array.isArray(live?.publicTables) ? live.publicTables.slice() : [];
  const applied = appliedRows(live);
  const latest = latestMigrationVersion(live);
  const unknown = unknownMigrationVersions(applied, repoMigrations);
  if (unknown.length) {
    return fail(`STOP: unknown/out-of-band migration version: ${unknown.join(",")}`);
  }

  const bookkeepingOnly = tables.every((t) => t === "schema_migrations");
  if (bookkeepingOnly && applied.length === 0 && !latest) {
    return {
      ok: true,
      reason: null,
      mode: SCHEMA_APPLY_MODE.FRESH_PROVISION,
      allowWritable: true,
      predecessor,
      requiredVersion: required,
    };
  }

  if (latest && latest < predecessor) {
    return fail(`STOP: latest schema is ${latest}, required predecessor ${predecessor} or ${required}`);
  }
  if (latest && latest > required) {
    return fail(`STOP: latest schema is ${latest}, required ${required} or predecessor ${predecessor}`);
  }

  if (latest === predecessor) {
    if (Number(live.restaurants) !== 0 || !live.restaurantsTableExists) {
      return fail("STOP: predecessor upgrade requires restaurants=0");
    }
    if (Number(live.fixtureLike) !== 0) {
      return fail(`STOP: rest_1999* fixture rows=${live.fixtureLike}`);
    }
    const history = matchMigrationHistory(applied, expectedHistoryThrough(repoMigrations, predecessor));
    if (!history.ok) return fail(`STOP: ${history.reason}`);
    const catalog = assertCatalogMatch(
      tables,
      expectedPublicTablesThrough(repoMigrations, predecessor),
      `schema ${predecessor}`,
    );
    if (catalog) return catalog;
    return {
      ok: true,
      reason: null,
      mode: SCHEMA_APPLY_MODE.UPGRADE_FROM_PREDECESSOR,
      allowWritable: true,
      predecessor,
      requiredVersion: required,
    };
  }

  if (latest === required) {
    if (Number(live.restaurants) !== 0 || !live.restaurantsTableExists) {
      return fail("STOP: required schema verify requires restaurants=0");
    }
    if (Number(live.fixtureLike) !== 0) {
      return fail(`STOP: rest_1999* fixture rows=${live.fixtureLike}`);
    }
    const history = matchMigrationHistory(applied, expectedHistoryThrough(repoMigrations, required));
    if (!history.ok) return fail(`STOP: ${history.reason}`);
    const catalog = assertCatalogMatch(
      tables,
      expectedPublicTablesThrough(repoMigrations, required),
      `schema ${required}`,
    );
    if (catalog) return catalog;
    return {
      ok: true,
      reason: null,
      mode: SCHEMA_APPLY_MODE.ALREADY_CURRENT,
      allowWritable: false,
      predecessor,
      requiredVersion: required,
    };
  }

  const extra = tables.filter((t) => t !== "schema_migrations");
  if (extra.length) {
    return fail(`STOP: public tables already present: ${extra.join(",")}`);
  }
  return fail(`STOP: latest schema is ${latest || "(none)"}, required predecessor ${predecessor} or ${required}`);
}

export function assertSchemaApplyInvariants({ snap, live, repoMigrations } = {}) {
  const identity = identityStop({ snap, live });
  if (identity) throw new Error(identity);
  const classified = classifySchemaApplyPath({ live, repoMigrations });
  if (!classified.ok) throw new Error(classified.reason);
  return classified;
}

function sortedTables(live) {
  return [...(live?.publicTables || [])].map(String).sort();
}

export function schemaApplyLiveKey(live = {}) {
  return JSON.stringify({
    currentDatabase: String(live.currentDatabase || ""),
    sslLive: String(live.sslLive || "").toLowerCase(),
    systemIdentifier: String(live.systemIdentifier || ""),
    restaurants: live.restaurants == null ? null : Number(live.restaurants),
    fixtureLike: live.fixtureLike == null ? null : Number(live.fixtureLike),
    restaurantsTableExists: Boolean(live.restaurantsTableExists),
    publicTables: sortedTables(live),
    schemaMigrationRows: appliedRows(live),
    latest: latestMigrationVersion(live),
  });
}

export function assertWritableApplyRevalidation({
  snap,
  previousLive,
  previousDecision,
  nextLive,
  repoMigrations,
} = {}) {
  if (!previousDecision?.ok) {
    throw new Error("STOP: read-only schema apply classification is missing");
  }
  if (previousDecision.mode === SCHEMA_APPLY_MODE.ALREADY_CURRENT) {
    throw new Error("STOP: writable apply is not permitted for ALREADY_CURRENT");
  }
  const nextDecision = assertSchemaApplyInvariants({ snap, live: nextLive, repoMigrations });
  if (nextDecision.mode !== previousDecision.mode) {
    throw new Error(
      `STOP: apply connection classification is ${nextDecision.mode}, required ${previousDecision.mode}`,
    );
  }
  if (!nextDecision.allowWritable) {
    throw new Error("STOP: apply connection is not classified for writable schema apply");
  }
  if (schemaApplyLiveKey(previousLive) !== schemaApplyLiveKey(nextLive)) {
    throw new Error("STOP: apply connection target/catalog/history does not match the read-only classification");
  }
  if (nextDecision.predecessor !== SCHEMA_APPLY_PREDECESSOR_VERSION) {
    throw new Error(`STOP: apply connection predecessor is not ${SCHEMA_APPLY_PREDECESSOR_VERSION}`);
  }
  return nextDecision;
}

export async function revalidateThenEnterWritable({
  client,
  snap,
  previousLive,
  previousDecision,
  repoMigrations,
  identifyLiveImpl,
  enterWritableImpl,
} = {}) {
  if (typeof identifyLiveImpl !== "function" || typeof enterWritableImpl !== "function") {
    throw new Error("STOP: writable revalidation hooks are missing");
  }
  const nextLive = await identifyLiveImpl(client);
  assertWritableApplyRevalidation({
    snap,
    previousLive,
    previousDecision,
    nextLive,
    repoMigrations,
  });
  return enterWritableImpl(client);
}

export async function collectSchemaApplyLive(client) {
  const ident = await client.query(`
    SELECT current_user AS current_user,
           current_database() AS current_database,
           inet_server_addr()::text AS server_addr,
           current_setting('ssl') AS ssl,
           version() AS version,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier
  `);
  const tables = await client.query(`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY 1
  `);
  const restExists = tables.rows.some((r) => r.relname === "restaurants");
  let restaurants = null;
  let fixtureLike = null;
  if (restExists) {
    restaurants = Number((await client.query("SELECT count(*)::int AS n FROM restaurants")).rows[0].n);
    fixtureLike = Number((await client.query(
      "SELECT count(*)::int AS n FROM restaurants WHERE legacy_rtdb_id LIKE 'rest_1999%'",
    )).rows[0].n);
  }
  let schemaMigrationChecksumsUnavailable = false;
  let mig = { rows: [] };
  try {
    mig = await client.query(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
  } catch {
    try {
      const names = await client.query(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      );
      schemaMigrationChecksumsUnavailable = names.rows.length > 0;
      mig = { rows: names.rows.map((r) => ({ ...r, checksum: null })) };
    } catch {
      mig = { rows: [] };
    }
  }
  const row = ident.rows[0];
  const serverAddr = String(row.server_addr || "");
  const serverAddrClass = !serverAddr
    ? "(unavailable)"
    : /^127\.|^::1$/.test(serverAddr)
      ? "loopback"
      : serverAddr.replace(/\d+/g, "*");
  return {
    currentUser: row.current_user,
    currentDatabase: row.current_database,
    sslLive: row.ssl,
    serverVersion: String(row.version).split(",")[0],
    serverAddrClass,
    systemIdentifier: String(row.system_identifier || ""),
    publicTables: tables.rows.map((r) => r.relname),
    restaurantsTableExists: restExists,
    restaurants,
    fixtureLike,
    schemaMigrations: mig.rows.map((r) => `${r.version}:${r.name}`),
    schemaMigrationRows: mig.rows.map((r) => ({
      version: r.version,
      name: r.name,
      checksum: r.checksum || "",
    })),
    schemaMigrationChecksumsUnavailable,
    latestMigration: mig.rows.at(-1) || null,
  };
}

export async function applyMissingMigrations(client, repoMigrations, { throughVersion = REQUIRED_SCHEMA_VERSION } = {}) {
  const migrations = assertRepoMigrationContract(repoMigrations);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version      text PRIMARY KEY,
      name         text NOT NULL,
      checksum     text NOT NULL,
      applied_at   timestamptz NOT NULL DEFAULT now()
    )
  `);
  const applied = (await client.query(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  )).rows;
  const appliedMap = new Map(applied.map((r) => [r.version, r]));
  const results = [];
  for (const m of migrations) {
    if (throughVersion && m.version > throughVersion) continue;
    const rec = appliedMap.get(m.version);
    if (rec) {
      if (rec.checksum !== m.checksum) {
        throw new Error(`DRIFT ${m.version}_${m.name}: applied checksum differs from file`);
      }
      results.push({ version: m.version, name: m.name, status: "already-applied" });
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(m.sql);
      await client.query(
        "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
        [m.version, m.name, m.checksum],
      );
      await client.query("COMMIT");
      results.push({ version: m.version, name: m.name, status: "applied" });
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`${m.version}_${m.name} failed: ${err.message}`);
    }
  }
  return results;
}
