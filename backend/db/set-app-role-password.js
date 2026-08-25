#!/usr/bin/env node
// db/set-app-role-password.js — sets/rotates the nesta_app role's login
// password. Kept as a separate, one-purpose script instead of embedding a
// password in any .sql migration file (migrations are committed to source
// control; this script's input never is — it reads POSTGRES_APP_PASSWORD
// from the environment only, same convention as every other secret in this
// backend, and never logs the value).
//
// Usage:
//   POSTGRES_APP_PASSWORD='...' node db/set-app-role-password.js
// or set POSTGRES_APP_PASSWORD in backend/.env (gitignored, same as every
// other credential in that file) and just run:
//   node db/set-app-role-password.js
import dotenv from "dotenv";
import { getPool, isPgAvailable, maskedConfig, closePool } from "./postgres.js";

dotenv.config();

async function main() {
  const password = process.env.POSTGRES_APP_PASSWORD;
  if (!password) {
    console.error("❌ POSTGRES_APP_PASSWORD is not set — nothing to do. Set it in backend/.env or the environment.");
    process.exit(1);
  }
  if (!isPgAvailable()) {
    console.error("❌ PostgreSQL is not configured (see .env.example POSTGRES_* vars).");
    process.exit(1);
  }

  const cfg = maskedConfig();
  console.log(`[set-app-role-password] connecting as ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database} to rotate nesta_app's password (value never logged)`);

  const pool = getPool();
  const client = await pool.connect();
  try {
    // ALTER ROLE ... PASSWORD does not accept a $1 query parameter in
    // PostgreSQL's grammar (PASSWORD expects a literal, not a bind
    // parameter) — client.escapeLiteral() is pg's own safe quoting
    // primitive for exactly this situation: it properly escapes embedded
    // quotes/backslashes so the value still never appears unescaped or
    // concatenated unsafely, without needing a bind parameter. The value
    // itself is never logged either way.
    const quoted = client.escapeLiteral(password);
    await client.query(`ALTER ROLE nesta_app WITH PASSWORD ${quoted}`);
    console.log("✅ nesta_app password set.");
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exitCode = 1;
});
