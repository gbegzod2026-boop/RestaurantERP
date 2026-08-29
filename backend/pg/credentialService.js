import { getPool, withTenantContext } from "../db/postgres.js";
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
  const update = async () => client.query(
    `UPDATE employee_credentials
        SET password_hash = $2, password_enc = NULL, rotated_at = now()
      WHERE employee_id = $1`,
    [employeeId, passwordHash]
  );
  const updated = await update();
  if (updated.rowCount > 0) return;
  try {
    await client.query(
      `INSERT INTO employee_credentials (employee_id, password_hash, password_enc, rotated_at)
       VALUES ($1, $2, NULL, now())`,
      [employeeId, passwordHash]
    );
  } catch (error) {
    // Preserve least privilege: nesta_app intentionally cannot SELECT
    // password_hash, so INSERT ... ON CONFLICT cannot be used here. Resolve
    // only the concurrent-create race with an authorized column UPDATE.
    if (error?.code !== "23505") throw error;
    const raced = await update();
    if (raced.rowCount === 0) throw error;
  }
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

/** Manager authentication across tenant boundaries without reading RTDB.
 * Restaurant discovery is tenant-agnostic; each employee/credential check is
 * then performed in that restaurant's own RLS transaction. */
export async function authenticateManagerWithPostgres(login, password, { restId = null, pool = getPool() } = {}) {
  const normalizedLogin = String(login || "").trim().toLowerCase();
  const params = restId ? [String(restId)] : [];
  const { rows: restaurants } = await pool.query(
    `SELECT id, legacy_rtdb_id, name, domain, status
       FROM restaurants
      ${restId ? "WHERE legacy_rtdb_id = $1" : ""}
      ORDER BY legacy_rtdb_id`,
    params
  );
  const matches = [];
  for (const restaurant of restaurants) {
    const match = await withTenantContext(restaurant.id, async (client) => {
      const { rows: employees } = await client.query(
        `SELECT id, legacy_rtdb_id, name, login, role, active, extra
           FROM employees
          WHERE restaurant_id = $1
            AND lower(login) = $2
            AND lower(role) = ANY($3::text[])`,
        [restaurant.id, normalizedLogin, [...MANAGER_ROLES]]
      );
      for (const employee of employees) {
        const { rows: credentials } = await asLoginReader(client, () => client.query(
          "SELECT password_hash FROM employee_credentials WHERE employee_id = $1",
          [employee.id]
        ));
        if ((await verifyPassword(password, credentials[0]?.password_hash)).ok) return employee;
      }
      return null;
    }, { actingRole: "owner" });
    if (match) matches.push({ ...match, restaurant });
  }
  if (matches.length > 1) throw new CredentialConflictError();
  return matches[0] || null;
}
