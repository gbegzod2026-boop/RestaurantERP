import { getPool, closePool } from "../postgres.js";

const pool = await getPool();
const c = await pool.connect();
try {
  await c.query("SELECT set_config('app.current_restaurant_id', '', true)");
  const r = await c.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE legacy_rtdb_id LIKE 'rest_1999%')::int AS fixtures,
      count(*) FILTER (WHERE legacy_rtdb_id NOT LIKE 'rest_1999%')::int AS other
    FROM restaurants
  `);
  console.log(JSON.stringify(r.rows[0]));
} finally {
  c.release();
  await closePool();
}
