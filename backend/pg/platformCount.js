// Shared platform restaurant count. PostgreSQL is the source of truth when
// the pool is configured; callers must not invent a second Firebase count
// for the same KPI (landing "Ulangan restoranlar" vs superadmin
// "Umumiy restoranlar").
import { isPgAvailable, getPool } from "../db/postgres.js";

/**
 * @returns {Promise<{ count: number|null, source: "postgres"|"unavailable"|"error" }>}
 */
export async function countCanonicalRestaurants() {
  if (!isPgAvailable()) {
    return { count: null, source: "unavailable" };
  }
  try {
    const { rows } = await getPool().query("SELECT COUNT(*)::int AS n FROM restaurants");
    return { count: Number(rows[0]?.n || 0), source: "postgres" };
  } catch (err) {
    console.error("[platformCount] restaurants COUNT failed:", err?.message || err);
    return { count: null, source: "error" };
  }
}
