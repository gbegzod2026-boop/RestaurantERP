import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { readLocalPgParts, pgClientConfig, MIGRATION_TARGET_DB } from "./lib/migrationTargetGuard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (/:59999\b/.test(process.env.POSTGRES_URL || "")) delete process.env.POSTGRES_URL;
dotenv.config({ path: path.join(__dirname, "../../.env"), quiet: true });

async function main() {
  const parts = readLocalPgParts();
  if (parts.database === MIGRATION_TARGET_DB) {
    throw new Error("refusing: configured database is the migration target, not the fixture/maintenance DB");
  }
  const client = new pg.Client(pgClientConfig(parts));
  await client.connect();
  try {
    const exists = await client.query("SELECT to_regclass('public.restaurants') AS t");
    if (!exists.rows[0].t) {
      console.log(JSON.stringify({ database: parts.database, hostClass: parts.host, restaurantsTable: false }));
      return;
    }
    const total = await client.query("SELECT count(*)::int AS n FROM restaurants");
    const fixture = await client.query("SELECT count(*)::int AS n FROM restaurants WHERE legacy_rtdb_id LIKE 'rest_1999%'");
    const production = await client.query("SELECT count(*)::int AS n FROM restaurants WHERE legacy_rtdb_id IS NOT NULL AND legacy_rtdb_id NOT LIKE 'rest_1999%'");
    console.log(JSON.stringify({
      readOnlyCheck: true,
      database: parts.database,
      hostClass: parts.host,
      restaurants: total.rows[0].n,
      fixtureLike: fixture.rows[0].n,
      productionLegacyRows: production.rows[0].n,
    }));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("FIXTURE CHECK FAILED:", err.message);
  process.exit(1);
});
