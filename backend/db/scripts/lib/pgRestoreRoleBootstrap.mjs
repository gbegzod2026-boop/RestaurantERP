// Local-only cluster-role bootstrap for Step 2D.4 pg_restore.
// Database dumps do not include CREATE ROLE. Policies still reference nesta_*.
// Never run against Railway / DATABASE_PUBLIC_URL.
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { isLoopbackHost, isRailwayPgHost } from "./migrationTargetGuard.mjs";
import { STEP2D4_RESTORE_DB, quoteIdent, redactSecrets } from "./pgBackupRestoreTarget.mjs";

export const MINIMUM_RESTORE_ROLES = [
  "nesta_app",
  "nesta_login_reader",
  "nesta_credential_revealer",
];

const EXCLUDED_ROLE_NAMES = new Set([
  STEP2D4_RESTORE_DB,
  "nesta_migration_dryrun",
  "postgres",
  "public",
]);

const NESTA_ROLE_RE = /\bnesta_[a-z][a-z0-9_]*\b/gi;

export function deriveNestaRolesFromText(text) {
  const found = new Set();
  for (const m of String(text || "").matchAll(NESTA_ROLE_RE)) {
    const name = m[0].toLowerCase();
    if (EXCLUDED_ROLE_NAMES.has(name)) continue;
    if (name.startsWith("pg_")) continue;
    found.add(name);
  }
  return [...found].sort();
}

export function deriveRolesFromMigrationDir(dir) {
  let text = "";
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".sql")) continue;
    text += `${readFileSync(path.join(dir, file), "utf8")}\n`;
  }
  return deriveNestaRolesFromText(text);
}

export function requiredRestoreRoles({ dumpListText = "", migrationRoles = [] } = {}) {
  const derived = new Set([
    ...MINIMUM_RESTORE_ROLES,
    ...migrationRoles,
    ...deriveNestaRolesFromText(dumpListText),
  ]);
  for (const name of EXCLUDED_ROLE_NAMES) derived.delete(name);
  return [...derived].sort();
}

export function assertLocalRoleBootstrapTarget(restore) {
  if (!restore?.ok) {
    return { ok: false, reason: "STOP: role bootstrap restore target is not resolved" };
  }
  if (isRailwayPgHost(restore.host) || restore.hostClass?.includes("rlwy.net")) {
    return { ok: false, reason: "STOP: never CREATE ROLE on Railway / DATABASE_PUBLIC_URL" };
  }
  if (!isLoopbackHost(restore.host)) {
    return { ok: false, reason: "STOP: role bootstrap host is not loopback" };
  }
  if (restore.restoreDatabase !== STEP2D4_RESTORE_DB) {
    return { ok: false, reason: `STOP: role bootstrap database must be ${STEP2D4_RESTORE_DB}` };
  }
  if (restore.adminDatabase !== "postgres") {
    return { ok: false, reason: "STOP: role bootstrap admin database must be local postgres" };
  }
  return { ok: true };
}

export function createRoleSql(name) {
  const ident = quoteIdent(name);
  return `CREATE ROLE ${ident} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOLOGIN`;
}

export function dangerousRoleAttrs(row = {}) {
  const flags = [];
  if (row.rolsuper) flags.push("SUPERUSER");
  if (row.rolcreatedb) flags.push("CREATEDB");
  if (row.rolcreaterole) flags.push("CREATEROLE");
  if (row.rolreplication) flags.push("REPLICATION");
  if (row.rolbypassrls) flags.push("BYPASSRLS");
  return flags;
}

export function classifyPgRestoreOutput(status, text) {
  const redacted = redactSecrets(text);
  const lines = String(redacted || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (status === 0) {
    return { ok: true, exitCode: 0, harmful: [], ignored: lines };
  }
  const harmful = [];
  const ignored = [];
  for (const line of lines) {
    if (/role .* does not exist/i.test(line)) {
      harmful.push(line);
      continue;
    }
    if (/\bERROR:/i.test(line)) {
      harmful.push(line);
      continue;
    }
    ignored.push(line);
  }
  return { ok: harmful.length === 0, exitCode: status, harmful, ignored };
}

export async function bootstrapRestoreRoles(client, { restore, roles }) {
  const guard = assertLocalRoleBootstrapTarget(restore);
  if (!guard.ok) {
    throw new Error(guard.reason);
  }
  const preexisting = [];
  const created = [];
  for (const name of roles) {
    quoteIdent(name);
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
    if (exists.rowCount > 0) {
      preexisting.push(name);
      continue;
    }
    await client.query(createRoleSql(name));
    created.push(name);
  }
  let createdFlags = [];
  if (created.length) {
    const attrs = await client.query(`
      SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
        FROM pg_roles WHERE rolname = ANY($1)
    `, [created]);
    createdFlags = attrs.rows.map((row) => ({
      role: row.rolname,
      dangerous: dangerousRoleAttrs(row),
      canLogin: row.rolcanlogin === true,
    }));
    const dangerous = createdFlags.filter((r) => r.dangerous.length);
    if (dangerous.length) {
      throw new Error(`STOP: bootstrap roles have dangerous privileges: ${dangerous.map((d) => `${d.role}=${d.dangerous.join(",")}`).join("; ")}`);
    }
  }
  return {
    required: [...roles],
    preexisting,
    created,
    createdFlags,
    dangerousPrivileges: "NONE",
  };
}

export async function dropTemporaryRestoreRoles(client, { restore, created }) {
  const guard = assertLocalRoleBootstrapTarget(restore);
  if (!guard.ok) {
    throw new Error(guard.reason);
  }
  const dropped = [];
  const skipped = [];
  for (const name of created || []) {
    quoteIdent(name);
    try {
      await client.query(`DROP ROLE IF EXISTS ${quoteIdent(name)}`);
      dropped.push(name);
    } catch (err) {
      skipped.push({ role: name, reason: redactSecrets(err.message) });
    }
  }
  return { dropped, skipped };
}
