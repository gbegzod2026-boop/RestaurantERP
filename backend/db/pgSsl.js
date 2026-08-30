// PostgreSQL TLS helper. Never logs URLs, passwords, or certificate bodies.
// Default remote hosts: encrypt + verify (rejectUnauthorized true).
// Railway public/private hosts: encrypt always. Full CA+hostname verification
// is not possible on the stock image (leaf CN=localhost, CA unpublished).
// If POSTGRES_SSL_CA or POSTGRES_SSL_CA_FILE is set, verify the chain against
// that CA (verify-ca). NODE_TLS_REJECT_UNAUTHORIZED is never touched.
import { existsSync, readFileSync } from "fs";
import { isLoopbackHost, isRailwayPgHost } from "./scripts/lib/migrationTargetGuard.mjs";

export { isRailwayPgHost };

export function stripPgUrlSslParams(connectionString) {
  if (!connectionString) return connectionString;
  const u = new URL(connectionString);
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey", "sslnegotiation"]) {
    u.searchParams.delete(key);
  }
  return u.toString();
}

function loadPinnedCa(env = process.env) {
  const inline = String(env.POSTGRES_SSL_CA || "").trim();
  if (inline.includes("BEGIN CERTIFICATE")) return inline;
  const file = String(env.POSTGRES_SSL_CA_FILE || "").trim();
  if (file && existsSync(file)) return readFileSync(file, "utf8");
  return null;
}

/**
 * @returns {{ ssl: false | object, tlsMode: string, certificateVerification: string }}
 */
export function resolvePgSsl({ host, env = process.env } = {}) {
  const h = String(host || "").trim();
  if (!h || isLoopbackHost(h)) {
    if (String(env.POSTGRES_SSL || "").trim().toLowerCase() === "true") {
      return {
        ssl: { rejectUnauthorized: true },
        tlsMode: "verify-full",
        certificateVerification: "enabled",
      };
    }
    return { ssl: false, tlsMode: "disable", certificateVerification: "n/a" };
  }

  const ca = loadPinnedCa(env);
  if (ca) {
    const railway = isRailwayPgHost(h);
    return {
      ssl: {
        rejectUnauthorized: true,
        ca,
        ...(railway ? { checkServerIdentity: () => undefined } : {}),
      },
      tlsMode: railway ? "verify-ca-railway" : "verify-full",
      certificateVerification: railway
        ? "ca-pinned-chain-only (Railway leaf CN=localhost)"
        : "enabled",
    };
  }

  if (isRailwayPgHost(h)) {
    return {
      ssl: { rejectUnauthorized: false },
      tlsMode: "require-railway",
      certificateVerification:
        "encryption-required; CA/hostname not verifiable on stock Railway Postgres (unpublished per-instance CA, CN=localhost)",
    };
  }

  return {
    ssl: { rejectUnauthorized: true },
    tlsMode: "verify-full",
    certificateVerification: "enabled",
  };
}

export function withPgSsl(config, host, env = process.env) {
  const { ssl, tlsMode, certificateVerification } = resolvePgSsl({ host, env });
  const next = { ...config, ssl };
  if (next.connectionString) {
    next.connectionString = stripPgUrlSslParams(next.connectionString);
  }
  return { config: next, tlsMode, certificateVerification };
}
