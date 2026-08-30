// Independent resolvers for Step 2D.4 PG dump (Railway) vs restore (local).
// DATABASE_PUBLIC_URL is never used as a restore target.
import { isLoopbackHost, isRailwayPgHost } from "./migrationTargetGuard.mjs";

export const STEP2D4_RESTORE_DB = "nesta_step2d4_restore";
export const STEP2D4_SOURCE_DB = "railway";
const FORBIDDEN_RESTORE_DB = new Set([
  "postgres",
  "template0",
  "template1",
  "nesta_app",
  "nesta_migration_dryrun",
  "railway",
]);

export function parsePgUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || "5432",
      database: decodeURIComponent((u.pathname || "/").replace(/^\//, "") || ""),
      user: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
    };
  } catch {
    return null;
  }
}

export function hostClass(host) {
  const h = String(host || "").trim().toLowerCase();
  if (!h) return "(empty)";
  if (isLoopbackHost(h)) return h;
  if (h.endsWith(".rlwy.net") || h.endsWith(".railway.app") || h.endsWith(".railway.internal")) {
    return `*.${h.split(".").slice(-2).join(".")}`;
  }
  return h.replace(/^[^.]+/, "*");
}

export function redactSecrets(text) {
  return String(text || "")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgres://***")
    .replace(/PGPASSWORD=\S+/gi, "PGPASSWORD=***")
    .replace(/DATABASE_(?:PUBLIC_|PRIVATE_)?URL=\S+/gi, "DATABASE_URL=***")
    .replace(/POSTGRES_URL=\S+/gi, "POSTGRES_URL=***")
    .replace(/STEP2D4_RESTORE_DATABASE_URL=\S+/gi, "STEP2D4_RESTORE_DATABASE_URL=***");
}

export function resolveDumpSource(env = {}) {
  const url = String(env.DATABASE_PUBLIC_URL || "").trim()
    || (isRailwayPgHost(parsePgUrl(env.DATABASE_URL)?.host) ? String(env.DATABASE_URL).trim() : "");
  if (!url) {
    return { ok: false, reason: "DATABASE_PUBLIC_URL is unset; refusing to use localhost as dump source" };
  }
  const parts = parsePgUrl(url);
  if (!parts) return { ok: false, reason: "DATABASE_PUBLIC_URL is unparseable" };
  if (isLoopbackHost(parts.host)) {
    return { ok: false, reason: "dump source host is loopback" };
  }
  if (!isRailwayPgHost(parts.host)) {
    return { ok: false, reason: "dump source is not a Railway host" };
  }
  if (parts.database !== STEP2D4_SOURCE_DB) {
    return { ok: false, reason: `dump source database is ${parts.database}, required ${STEP2D4_SOURCE_DB}` };
  }
  return {
    ok: true,
    host: parts.host,
    port: parts.port,
    database: parts.database,
    user: parts.user,
    password: parts.password,
    hostClass: hostClass(parts.host),
    providerClass: "PUBLIC MANAGED",
    urlKey: env.DATABASE_PUBLIC_URL ? "DATABASE_PUBLIC_URL" : "DATABASE_URL",
  };
}

function partsFromDiscrete(env = {}) {
  return {
    host: env.PGHOST || env.POSTGRES_HOST || "",
    port: String(env.PGPORT || env.POSTGRES_PORT || "5432"),
    database: env.PGDATABASE || env.POSTGRES_DB || "",
    user: env.PGUSER || env.POSTGRES_USER || "",
    password: env.PGPASSWORD || env.POSTGRES_PASSWORD || "",
  };
}

export function resolveRestoreTarget(env = {}, dotenvFile = {}) {
  const dedicated = String(env.STEP2D4_RESTORE_DATABASE_URL || "").trim();
  let admin;
  if (dedicated) {
    admin = parsePgUrl(dedicated);
    if (!admin) return { ok: false, reason: "STEP2D4_RESTORE_DATABASE_URL is unparseable" };
  } else {
    const fileUrl = String(dotenvFile.POSTGRES_URL || "").trim();
    const fromUrl = fileUrl ? parsePgUrl(fileUrl) : null;
    const discrete = partsFromDiscrete(dotenvFile);
    if (fromUrl?.host && isLoopbackHost(fromUrl.host)) {
      admin = fromUrl;
    } else if (discrete.host && isLoopbackHost(discrete.host)) {
      admin = discrete;
    } else {
      admin = fromUrl || discrete;
    }
  }
  if (!admin?.host) {
    return { ok: false, reason: "no local restore target (set STEP2D4_RESTORE_DATABASE_URL or backend/.env loopback POSTGRES_HOST)" };
  }
  if (!isLoopbackHost(admin.host)) {
    return { ok: false, reason: "restore target host is not loopback" };
  }
  if (isRailwayPgHost(admin.host)) {
    return { ok: false, reason: "DATABASE_PUBLIC_URL/Railway host cannot be a restore target" };
  }
  const restoreDatabase = STEP2D4_RESTORE_DB;
  if (FORBIDDEN_RESTORE_DB.has(restoreDatabase)) {
    return { ok: false, reason: "restore database name is forbidden" };
  }
  if (dedicated) {
    const named = String(admin.database || "").trim();
    if (named && named !== STEP2D4_RESTORE_DB && named !== "postgres") {
      return { ok: false, reason: `restore URL database is ${named}, required ${STEP2D4_RESTORE_DB} (or postgres as admin only)` };
    }
  }
  return {
    ok: true,
    host: admin.host,
    port: admin.port || "5432",
    user: admin.user,
    password: admin.password,
    adminDatabase: "postgres",
    restoreDatabase,
    hostClass: hostClass(admin.host),
    sourceIgnored: ["DATABASE_PUBLIC_URL", "DATABASE_URL"],
  };
}

export function assertRestoreDatabaseName(name) {
  if (name !== STEP2D4_RESTORE_DB) {
    throw new Error(`STOP: restore database must be ${STEP2D4_RESTORE_DB}`);
  }
  if (FORBIDDEN_RESTORE_DB.has(name)) {
    throw new Error("STOP: restore database name is forbidden");
  }
}

export function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(String(name || ""))) {
    throw new Error("STOP: unsafe SQL identifier");
  }
  return `"${name}"`;
}

export function sourceCannotBeRestoreTarget(source, restore) {
  if (!source?.ok || !restore?.ok) return true;
  if (source.host === restore.host && !isLoopbackHost(source.host)) return false;
  return source.host !== restore.host || source.database !== restore.restoreDatabase;
}
