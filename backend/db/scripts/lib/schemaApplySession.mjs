// Session policy for Step 2D.3 schema provisioning.
// Identify/tls-probe/preflight stay read-only. Apply uses a dedicated
// writable session for DDL only. No tenant data imports live here.

export const SCHEMA_APPLY_REQUIRED_DB = "railway";

export function isReadOnlyAction(action) {
  return action === "tls-probe" || action === "identify";
}

export function isSchemaApplyAction(action) {
  return action === "apply";
}

export const READ_ONLY_BEGIN_SQL = "BEGIN READ ONLY";
export const READ_ONLY_LOCAL_SQL = "SET LOCAL default_transaction_read_only = on";
export const APPLY_WRITABLE_SQL = [
  "SET default_transaction_read_only = off",
  "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
];

export function assertSchemaApplyInvariants({ snap, live } = {}) {
  if (!snap || !live) throw new Error("STOP: missing identity snapshot");
  if (snap.loopback) throw new Error("STOP: host is loopback");
  if (snap.providerClass !== "PUBLIC MANAGED") {
    throw new Error(`STOP: providerClass is ${snap.providerClass}, required PUBLIC MANAGED`);
  }
  const db = String(live.currentDatabase || snap.database || "").trim();
  if (!db) throw new Error("STOP: database name empty");
  if (db === "postgres") throw new Error('STOP: database "postgres" is not a production target');
  if (db === "nesta_migration_dryrun") throw new Error("STOP: refusing nesta_migration_dryrun");
  if (db !== SCHEMA_APPLY_REQUIRED_DB) {
    throw new Error(`STOP: current_database is ${db}, required ${SCHEMA_APPLY_REQUIRED_DB}`);
  }
  if (String(live.sslLive || "").toLowerCase() !== "on") {
    throw new Error(`STOP: SSL live is ${live.sslLive}, required on`);
  }
  const tables = Array.isArray(live.publicTables) ? live.publicTables : [];
  const allowed = new Set(["schema_migrations"]);
  const unexpected = tables.filter((t) => !allowed.has(t));
  if (unexpected.length) {
    throw new Error(`STOP: public tables already present: ${unexpected.join(",")}`);
  }
  if (live.restaurantsTableExists && Number(live.restaurants) > 0) {
    throw new Error(`STOP: restaurants=${live.restaurants}, required 0`);
  }
  if (Number(live.fixtureLike) > 0) {
    throw new Error(`STOP: rest_1999* fixture rows=${live.fixtureLike}`);
  }
  if (live.serverAddrClass === "loopback") {
    throw new Error("STOP: connected server is loopback");
  }
}
