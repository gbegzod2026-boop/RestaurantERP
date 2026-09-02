// Canonical non-secret PostgreSQL target identity for Step 2D.5.
// Fingerprint is SHA-256 of STABLE connection/server facts only.
// Railway TCP proxy can change inet_server_addr / inet_server_port between
// connections, so those are never hashed. Never includes passwords, URLs,
// usernames, or connection strings.
import { createHash } from "crypto";

export const TARGET_FINGERPRINT_RE = /^[a-f0-9]{64}$/;

export const TARGET_IDENTITY_SQL = "SELECT current_database() AS current_database, (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier";

const CANONICAL_KEYS = Object.freeze([
  "currentDatabase",
  "database",
  "host",
  "port",
  "systemIdentifier",
]);

function asText(value) {
  if (value == null) return "";
  return String(value);
}

function normalizeHost(host) {
  return asText(host).trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function normalizePort(port) {
  const text = asText(port).trim();
  return text || "5432";
}

export function canonicalTargetIdentity(facts = {}) {
  const canonical = {
    currentDatabase: asText(facts.currentDatabase).trim(),
    database: asText(facts.database).trim(),
    host: normalizeHost(facts.host),
    port: normalizePort(facts.port),
    systemIdentifier: asText(facts.systemIdentifier).trim(),
  };
  return JSON.stringify(canonical, CANONICAL_KEYS);
}

export function targetFingerprintFromFacts(facts) {
  return createHash("sha256").update(canonicalTargetIdentity(facts), "utf8").digest("hex");
}

export function isTargetFingerprint(value) {
  return typeof value === "string" && TARGET_FINGERPRINT_RE.test(value);
}

export function assertSameTargetFingerprint(preflightFingerprint, migrationFingerprint) {
  if (!isTargetFingerprint(preflightFingerprint)) {
    throw new Error("NO-GO: live preflight target fingerprint is missing or malformed");
  }
  if (!isTargetFingerprint(migrationFingerprint)) {
    throw new Error("NO-GO: migration connection target fingerprint is missing or malformed");
  }
  if (preflightFingerprint !== migrationFingerprint) {
    throw new Error("NO-GO: migration connection is not the exact PostgreSQL target validated by live Railway preflight");
  }
}

export function targetFactsFromIdentityRow(connectionFacts, row = {}) {
  return {
    host: connectionFacts.host,
    port: connectionFacts.port || "5432",
    database: connectionFacts.database,
    currentDatabase: row.current_database,
    systemIdentifier: row.system_identifier,
  };
}

export async function collectPgTargetIdentity(client, connectionFacts) {
  if (!connectionFacts || !connectionFacts.host || !connectionFacts.database) {
    throw new Error("NO-GO: PostgreSQL connection facts are incomplete");
  }
  const result = await client.query(TARGET_IDENTITY_SQL);
  const row = result.rows?.[0];
  if (!row) throw new Error("NO-GO: PostgreSQL target identity query returned no row");
  const facts = targetFactsFromIdentityRow(connectionFacts, row);
  if (!facts.currentDatabase || !facts.systemIdentifier) {
    throw new Error("NO-GO: PostgreSQL target identity is incomplete");
  }
  return {
    facts,
    fingerprint: targetFingerprintFromFacts(facts),
  };
}

/** Deterministic fixture facts for unit tests. Not a live target. */
export const EXAMPLE_TARGET_FACTS = Object.freeze({
  host: "switchback.proxy.rlwy.net",
  port: "12345",
  database: "railway",
  currentDatabase: "railway",
  systemIdentifier: "1111111111111111111",
});

export function exampleLiveTargetFingerprint() {
  return targetFingerprintFromFacts(EXAMPLE_TARGET_FACTS);
}
