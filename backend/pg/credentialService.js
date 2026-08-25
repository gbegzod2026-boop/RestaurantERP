import { getPool } from "../db/postgres.js";
import { hashPassword, verifyPassword } from "../security/password.js";

const MANAGER_ROLES = new Set(["owner", "admin", "manager"]);

export class CredentialConflictError extends Error {
  constructor() {
    super("Credential conflict");
    this.code = "CREDENTIAL_CONFLICT";
  }
}

async function asLoginReader(client, fn) {
  await client.query("SET LOCAL ROLE nesta_login_reader");
  try {
    return await fn();
  } finally {
    await client.query("SET LOCAL ROLE nesta_app");
  }
}

export async function assertPinAvailable(client, { pin, excludeEmployeeId = null }) {
  const { rows } = await asLoginReader(client, () => client.query(
    `SELECT employee_id, password_hash
       FROM employee_credentials
      WHERE ($1::uuid IS NULL OR employee_id <> $1::uuid)`,
    [excludeEmployeeId]
  ));
  for (const row of rows) {
    if ((await verifyPassword(pin, row.password_hash)).ok) throw new CredentialConflictError();
  }
}

export async function upsertEmployeeCredential(client, { employeeId, pin }) {
  const passwordHash = await hashPassword(pin);
  await client.query(
    `INSERT INTO employee_credentials (employee_id, password_hash, password_enc, rotated_at)
     VALUES ($1, $2, NULL, now())
     ON CONFLICT (employee_id) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       password_enc = NULL,
       rotated_at = now()`,
    [employeeId, passwordHash]
  );
}

export async function deleteEmployeeCredential(client, { employeeId }) {
  await client.query("DELETE FROM employee_credentials WHERE employee_id = $1", [employeeId]);
}

/** Staff PIN authentication without any RTDB access. The untrusted legacy
 * restaurant id is used only to resolve one exact tenant, then every employee
 * and credential read runs with that tenant's RLS context. */
export async function authenticateStaffWithPostgres(restId, pin, { pool = getPool() } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE nesta_app");
    await client.query("SELECT set_config('app.current_restaurant_id', '', true)");
    await client.query("SELECT set_config('app.current_employee_role', '', true)");
    const { rows: restaurants } = await client.query(
      "SELECT id, status FROM restaurants WHERE legacy_rtdb_id = $1 LIMIT 1",
      [restId]
    );
    const restaurant = restaurants[0];
    if (!restaurant || restaurant.status === "blocked" || restaurant.status === "paused") {
      await client.query("COMMIT");
      return null;
    }

    await client.query("SELECT set_config('app.current_restaurant_id', $1, true)", [restaurant.id]);
    const { rows: employees } = await client.query(
      `SELECT id, legacy_rtdb_id, name, role, active, extra
         FROM employees
        WHERE restaurant_id = $1`,
      [restaurant.id]
    );
    const eligible = employees.filter((employee) => !MANAGER_ROLES.has(String(employee.role || "").toLowerCase()));
    const ids = eligible.map((employee) => employee.id);
    const credentials = ids.length === 0 ? [] : (await asLoginReader(client, () => client.query(
      "SELECT employee_id, password_hash FROM employee_credentials WHERE employee_id = ANY($1::uuid[])",
      [ids]
    ))).rows;
    const hashes = new Map(credentials.map((row) => [String(row.employee_id), row.password_hash]));
    const matches = [];
    for (const employee of eligible) {
      if ((await verifyPassword(pin, hashes.get(String(employee.id)))).ok) matches.push(employee);
    }
    if (matches.length > 1) throw new CredentialConflictError();
    await client.query("COMMIT");
    return matches[0] || null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
