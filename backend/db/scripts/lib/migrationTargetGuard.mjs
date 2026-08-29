// Refuses migration writes against the Step 1 fixture database, production
// PostgreSQL, or any non-loopback host. Callers must pass maskedConfig()
// (host/db/user only — never a password or URL).
export const MIGRATION_TARGET_DB = "nesta_migration_dryrun";
const FORBIDDEN_DB = new Set(["postgres", "template0", "template1", "nesta_app"]);

export function isLoopbackHost(host) {
  const h = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

export function assertMigrationTarget(masked) {
  if (!masked) {
    throw new Error("migration target refused: PostgreSQL is not configured");
  }
  if (!isLoopbackHost(masked.host)) {
    throw new Error("migration target refused: host is not loopback");
  }
  const db = String(masked.database || "").trim();
  if (FORBIDDEN_DB.has(db)) {
    throw new Error(`migration target refused: database "${db}" is the fixture/system database`);
  }
  if (db !== MIGRATION_TARGET_DB) {
    throw new Error(`migration target refused: expected database ${MIGRATION_TARGET_DB}`);
  }
}

export function withDatabaseName(connectionString, database) {
  const u = new URL(connectionString);
  u.pathname = `/${database}`;
  return u.toString();
}

export function readLocalPgParts() {
  const url = process.env.POSTGRES_URL || "";
  if (url) {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || "5432",
      database: decodeURIComponent((u.pathname || "/").replace(/^\//, "") || "postgres"),
      user: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
      connectionString: url,
    };
  }
  return {
    host: process.env.POSTGRES_HOST || "",
    port: String(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || "postgres",
    user: process.env.POSTGRES_USER || "",
    password: process.env.POSTGRES_PASSWORD || "",
  };
}

export function pgClientConfig(parts, databaseOverride) {
  const database = databaseOverride || parts.database;
  if (parts.connectionString) {
    return databaseOverride
      ? { connectionString: withDatabaseName(parts.connectionString, databaseOverride) }
      : { connectionString: parts.connectionString };
  }
  return {
    host: parts.host,
    port: Number(parts.port || 5432),
    database,
    user: parts.user,
    password: parts.password,
  };
}

export function migrationChildEnv(baseEnv, parts) {
  const env = { ...baseEnv };
  if (parts.connectionString) {
    env.POSTGRES_URL = withDatabaseName(parts.connectionString, MIGRATION_TARGET_DB);
  } else {
    // Keep an empty POSTGRES_URL so child dotenv.config() cannot reload a
    // fixture/production URL from .env (dotenv does not override existing keys).
    env.POSTGRES_URL = "";
    env.POSTGRES_HOST = parts.host;
    env.POSTGRES_PORT = String(parts.port || 5432);
    env.POSTGRES_DB = MIGRATION_TARGET_DB;
    env.POSTGRES_USER = parts.user;
    env.POSTGRES_PASSWORD = parts.password;
  }
  return env;
}
