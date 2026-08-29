import { assertMigrationTarget } from "./lib/migrationTargetGuard.mjs";
import { getPool, maskedConfig, closePool, isPgAvailable } from "../postgres.js";
import { PG_COUNT_TABLES } from "./lib/run-engine.mjs";

const TABLES = [
  "restaurants", "employees", "employee_credentials", "custom_roles", "tables",
  "menu_categories", "menu_items", "combo_items", "kitchen_stations", "restaurant_settings",
  "restaurant_modules",
  ...PG_COUNT_TABLES,
];

async function main() {
  if (!isPgAvailable()) throw new Error("PostgreSQL not configured");
  const cfg = maskedConfig();
  assertMigrationTarget(cfg);
  const pool = getPool();
  const c = await pool.connect();
  await c.query("SELECT set_config('app.current_restaurant_id', '', true)");
  const counts = {};
  for (const t of TABLES) {
    try {
      counts[t] = Number((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
    } catch {
      counts[t] = null;
    }
  }
  const fixtureLike = Number((await c.query(
    "SELECT count(*)::int AS n FROM restaurants WHERE legacy_rtdb_id LIKE 'rest_1999%'"
  )).rows[0].n);
  console.log(JSON.stringify({
    target: { host: cfg.host, port: cfg.port, database: cfg.database },
    fixtureLikeRestaurants: fixtureLike,
    counts,
  }));
  c.release();
  await closePool();
}

main().catch((err) => {
  console.error("COUNTS FAILED:", err.message);
  process.exit(1);
});
