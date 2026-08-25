// db/scripts/lib/upsert.mjs — the write half of the migration engine.
//
// Every insert is ON CONFLICT … DO UPDATE so a second run converges instead
// of duplicating. RETURNING (xmax = 0) tells us insert vs update without a
// follow-up SELECT. JSON text produced by leftoverExtra() is parsed back to
// objects so node-pg sends jsonb, not a double-encoded string.

const JSON_COLS = new Set([
  "extra", "payload", "modifiers", "extras", "name_snapshot", "delivery_address",
  "loyalty_card", "settings", "participants", "read_by", "before_state",
  "after_state", "detail", "variant_snapshot", "meta", "stage_timestamps",
]);

function prepareValue(col, v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (JSON_COLS.has(col) && typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      // node-pg sends a JS string to jsonb as raw text. A parsed JSON
      // string like "sfsdfds" would then be invalid JSON. Keep the original
      // encoded text for primitives; pass objects/arrays so pg stringifies.
      if (parsed !== null && typeof parsed === "object") return parsed;
      return v;
    } catch {
      return JSON.stringify(v);
    }
  }
  return v;
}

/**
 * Upsert one row. `conflict` is an array of column names matching a real
 * UNIQUE constraint on `table`.
 * Returns { id, inserted: boolean }.
 */
export async function upsertRow(client, table, row, conflict) {
  // created_at / updated_at are NOT NULL DEFAULT now() on almost every
  // table. Sending SQL NULL (Firebase had no timestamp) violates NOT NULL;
  // omitting the column lets the default fill it. That is the same
  // "generated, not legacy" rule Wave 1 already uses for tables.created_at.
  const DEFAULTABLE = new Set(["created_at", "updated_at"]);
  const cols = Object.keys(row).filter((k) => {
    if (row[k] === undefined) return false;
    if (DEFAULTABLE.has(k) && row[k] === null) return false;
    return true;
  });
  if (!cols.length) throw new Error(`upsert ${table}: empty row`);
  const vals = cols.map((c) => prepareValue(c, row[c]));
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const updateCols = cols.filter((c) => !conflict.includes(c) && c !== "id");
  const updateSet = updateCols.length
    ? updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(", ")
    : conflict.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
  const conflictList = conflict.join(", ");
  // print_settings / terminal_settings use restaurant_id as PK and have no
  // `id` column — RETURNING * keeps both shapes working.
  const sql = `
    INSERT INTO ${table} (${cols.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}
    RETURNING *, (xmax = 0) AS inserted`;
  const { rows } = await client.query(sql, vals);
  const out = rows[0];
  return { id: out.id ?? out[conflict[0]] ?? true, inserted: out.inserted === true };
}

export async function resolveRestaurantUuid(client, legacyId) {
  const { rows } = await client.query(
    "SELECT id FROM restaurants WHERE legacy_rtdb_id = $1",
    [legacyId]
  );
  return rows[0]?.id || null;
}

export async function countByRestaurantLegacy(client, table, restLegacyIds) {
  const { rows } = await client.query(
    `SELECT r.legacy_rtdb_id AS rest, count(*)::int AS n
       FROM ${table} t
       JOIN restaurants r ON r.id = t.restaurant_id
      WHERE r.legacy_rtdb_id = ANY($1)
      GROUP BY r.legacy_rtdb_id`,
    [restLegacyIds]
  );
  const map = new Map();
  for (const r of rows) map.set(r.rest, r.n);
  return map;
}

export async function countTable(client, table) {
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}
