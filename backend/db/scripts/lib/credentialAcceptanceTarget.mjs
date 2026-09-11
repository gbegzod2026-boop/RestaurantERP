// Classify the configured PostgreSQL target from env using the SAME
// connection-string merge that node-postgres (pg 8.23 / pg-connection-string)
// uses. Never opens a socket. Never logs hosts, URLs, passwords, or DSNs.
import { createRequire } from "module";
import { isLoopbackHost, canonicalizePgHost } from "./migrationTargetGuard.mjs";

const require = createRequire(import.meta.url);
const parsePgConnectionStringModule = require("pg-connection-string");
const parsePgConnectionString = parsePgConnectionStringModule.parse || parsePgConnectionStringModule;

export const ACCEPTANCE_ERROR = Object.freeze({
  REMOTE_TARGET_REFUSED: "REMOTE_TARGET_REFUSED",
  PG_NOT_CONFIGURED: "PG_NOT_CONFIGURED",
  LOOPBACK_CONNECT_FAILED: "LOOPBACK_CONNECT_FAILED",
  DISPOSABLE_DB_FAILED: "DISPOSABLE_DB_FAILED",
  REQUIRE_DB_FAILED: "REQUIRE_DB_FAILED",
  ACCEPTANCE_CLEANUP_FAILED: "ACCEPTANCE_CLEANUP_FAILED",
  MALFORMED_TARGET_REFUSED: "MALFORMED_TARGET_REFUSED",
});

export class AcceptanceTargetError extends Error {
  constructor(code) {
    super(code);
    this.name = "AcceptanceTargetError";
    this.code = code;
  }
}

export function requireDbEnabled(env = process.env) {
  return String(env.REQUIRE_DB || "").trim() === "1";
}

export function isLocalPgHost(host) {
  const h = String(host || "").trim();
  if (!h) return false;
  if (h.startsWith("/")) return true;
  return isLoopbackHost(h);
}

export function postgresJsStyleConfig(env = process.env) {
  const url = String(env.POSTGRES_URL || "").trim();
  if (url) return { connectionString: url };
  const host = String(env.POSTGRES_HOST || "").trim();
  const database = String(env.POSTGRES_DB || "").trim();
  const user = String(env.POSTGRES_USER || "").trim();
  const password = String(env.POSTGRES_PASSWORD || "");
  if (!host || !database || !user) return null;
  return {
    host,
    port: Number(env.POSTGRES_PORT || 5432),
    database,
    user,
    password,
  };
}

function mergePgDriverConfig(cfg, env = {}) {
  let merged = { ...(cfg || {}) };
  if (merged.connectionString) {
    const parsed = parsePgConnectionString(String(merged.connectionString));
    merged = Object.assign({}, merged, parsed);
  }
  const rawHost = String(merged.host || env.PGHOST || "localhost").trim();
  const canon = canonicalizePgHost(rawHost);
  if (canon.malformed || !canon.ok) {
    const err = new Error(ACCEPTANCE_ERROR.MALFORMED_TARGET_REFUSED);
    err.code = ACCEPTANCE_ERROR.MALFORMED_TARGET_REFUSED;
    throw err;
  }
  const host = canon.host;
  const port = merged.port || env.PGPORT || "5432";
  const database = merged.database || env.PGDATABASE || env.POSTGRES_DB || "";
  const user = merged.user || env.PGUSER || env.POSTGRES_USER || "";
  const password = merged.password || env.PGPASSWORD || env.POSTGRES_PASSWORD || "";
  return {
    host,
    port: String(port || "5432"),
    database: String(database || "").trim(),
    user: String(user || "").trim(),
    password: password == null ? "" : String(password),
    isDomainSocket: host.startsWith("/"),
  };
}

export function resolveEffectivePgTarget(env = process.env) {
  const cfg = postgresJsStyleConfig(env);
  if (!cfg) {
    return {
      configured: false,
      loopback: false,
      remote: false,
      malformed: false,
      socket: false,
      class: "none",
    };
  }
  let facts;
  try {
    facts = mergePgDriverConfig(cfg, env);
  } catch {
    return {
      configured: true,
      loopback: false,
      remote: true,
      malformed: true,
      socket: false,
      class: "malformed",
    };
  }
  const host = facts.host;
  const loopback = isLocalPgHost(host);
  return {
    configured: true,
    loopback,
    remote: !loopback,
    malformed: false,
    socket: host.startsWith("/"),
    class: loopback ? "loopback" : "remote",
  };
}

export function inspectPgTargetFromEnv(env = process.env) {
  return resolveEffectivePgTarget(env);
}

export function maskedEffectivePgConfig(env = process.env) {
  const cfg = postgresJsStyleConfig(env);
  if (!cfg) return null;
  try {
    const facts = mergePgDriverConfig(cfg, env);
    if (!facts.host) return null;
    return {
      host: facts.host,
      port: facts.port || "5432",
      database: facts.database,
      user: facts.user,
    };
  } catch {
    return null;
  }
}

export function loopbackClientConfig(env = process.env, databaseOverride) {
  const target = resolveEffectivePgTarget(env);
  if (target.malformed) throw new AcceptanceTargetError(ACCEPTANCE_ERROR.MALFORMED_TARGET_REFUSED);
  if (target.remote) throw new AcceptanceTargetError(ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED);
  if (!target.configured || !target.loopback) {
    throw new AcceptanceTargetError(ACCEPTANCE_ERROR.PG_NOT_CONFIGURED);
  }
  const cfg = postgresJsStyleConfig(env);
  const facts = mergePgDriverConfig(cfg, env);
  return {
    host: facts.host,
    port: Number(facts.port || 5432),
    database: databaseOverride || facts.database || "postgres",
    user: facts.user,
    password: facts.password,
    connectionTimeoutMillis: 4000,
  };
}

export function refuseRemotePgTarget(env = process.env) {
  const info = resolveEffectivePgTarget(env);
  if (info.malformed) throw new AcceptanceTargetError(ACCEPTANCE_ERROR.MALFORMED_TARGET_REFUSED);
  if (info.remote) throw new AcceptanceTargetError(ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED);
  return info;
}

export function acceptanceDisposition({ target, requireDb, connected, createdDb, cleanupFailed } = {}) {
  if (target?.malformed) {
    return { action: "fail", code: ACCEPTANCE_ERROR.MALFORMED_TARGET_REFUSED, verified: false };
  }
  if (target?.remote) {
    return { action: "fail", code: ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED, verified: false };
  }
  if (!target?.configured) {
    return requireDb
      ? { action: "fail", code: ACCEPTANCE_ERROR.PG_NOT_CONFIGURED, verified: false }
      : { action: "skip", code: "NOT_VERIFIED", verified: false };
  }
  if (connected === false) {
    return requireDb
      ? { action: "fail", code: ACCEPTANCE_ERROR.LOOPBACK_CONNECT_FAILED, verified: false }
      : { action: "skip", code: "NOT_VERIFIED", verified: false };
  }
  if (createdDb === false) {
    return requireDb
      ? { action: "fail", code: ACCEPTANCE_ERROR.DISPOSABLE_DB_FAILED, verified: false }
      : { action: "skip", code: "NOT_VERIFIED", verified: false };
  }
  if (cleanupFailed) {
    return { action: "fail", code: ACCEPTANCE_ERROR.ACCEPTANCE_CLEANUP_FAILED, verified: false };
  }
  return { action: "run", code: "OK", verified: true };
}

export function connectOnlyAfterLoopbackAccepted(env, connectFn) {
  const info = refuseRemotePgTarget(env);
  if (!info.configured) throw new AcceptanceTargetError(ACCEPTANCE_ERROR.PG_NOT_CONFIGURED);
  if (typeof connectFn !== "function") throw new AcceptanceTargetError(ACCEPTANCE_ERROR.REQUIRE_DB_FAILED);
  return connectFn(loopbackClientConfig(env));
}

export function finalizeAcceptanceCleanup({ primaryError, cleanupFailed } = {}) {
  if (primaryError) {
    if (cleanupFailed && primaryError && typeof primaryError === "object") {
      primaryError.cleanupCode = ACCEPTANCE_ERROR.ACCEPTANCE_CLEANUP_FAILED;
    }
    throw primaryError;
  }
  if (cleanupFailed) throw new AcceptanceTargetError(ACCEPTANCE_ERROR.ACCEPTANCE_CLEANUP_FAILED);
}

export { mergePgDriverConfig as mergePgDriverConfigForTests, canonicalizePgHost };
