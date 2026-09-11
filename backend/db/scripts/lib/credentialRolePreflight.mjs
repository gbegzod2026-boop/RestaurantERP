// Credential-gate role preflight.
// Local/disposable mode may prove INSERT/42501 then ROLLBACK.
// Production mode is independently reviewable, READ ONLY, zero DML, and must
// never be pointed at production from tests in this change.
import { identifyProductionPgTarget, GATE_ERROR } from "./productionCredentialGate.mjs";
import { boundedCredentialRollback, throwIfCredentialCliFailed } from "../../postgres.js";

export const ROLE_PREFLIGHT_CODE = Object.freeze({
  OK: "OK",
  ROLE_PREFLIGHT_FAILED: "ROLE_PREFLIGHT_FAILED",
  SESSION_SUPERUSER_REJECTED: "SESSION_SUPERUSER_REJECTED",
  ARCHITECTURAL_BLOCKER: "ARCHITECTURAL_BLOCKER",
});

const SQLSTATE_DENIED = "42501";
const SQLSTATE_ABORTED = "25P02";

const SESSION_FACTS_SQL = `SELECT
  current_user AS current_user,
  session_user AS session_user,
  (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS session_is_superuser,
  pg_has_role(session_user, 'nesta_app', 'member') AS session_member_nesta_app,
  pg_has_role('nesta_app', 'nesta_login_reader', 'member') AS app_member_login_reader,
  pg_has_role('nesta_app', 'nesta_credential_revealer', 'member') AS app_member_revealer,
  pg_has_role('nesta_login_reader', 'nesta_app', 'member') AS reader_member_app,
  pg_has_role('nesta_credential_revealer', 'nesta_app', 'member') AS revealer_member_app`;

const FORCE_RLS_SQL = `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'employee_credentials'`;

function failResult(code, checks) {
  return { ok: false, code, checks };
}

function safeBool(value) {
  return value === true;
}

function sqlstateOf(err) {
  return err && err.code ? String(err.code) : "UNKNOWN";
}

let probeSeq = 0;

export function isExpectedPermissionDenied(sqlstate) {
  return sqlstate === SQLSTATE_DENIED;
}

export async function probeDenied42501(client, sql) {
  probeSeq += 1;
  const sp = `probe_${probeSeq}`;
  const text = typeof sql === "string" ? sql : sql.text;
  const values = typeof sql === "string" ? undefined : sql.values;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    await client.query(text, values);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return { denied: false, sqlstate: "UNEXPECTED_SUCCESS" };
  } catch (err) {
    const code = sqlstateOf(err);
    if (code === SQLSTATE_ABORTED) throw err;
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    if (!isExpectedPermissionDenied(code)) throw err;
    return { denied: true, sqlstate: SQLSTATE_DENIED };
  }
}

async function probeAllowed(client, sql) {
  await client.query(sql);
  return true;
}

async function canSetRole(client, role) {
  probeSeq += 1;
  const sp = `probe_role_${probeSeq}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SET LOCAL ROLE NONE");
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return true;
  } catch (err) {
    const code = sqlstateOf(err);
    if (code === SQLSTATE_ABORTED) throw err;
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return false;
  }
}

function classifyUser(name) {
  if (name === "nesta_app") return "nesta_app";
  if (name === "nesta_login_reader") return "nesta_login_reader";
  if (name === "nesta_credential_revealer") return "nesta_credential_revealer";
  return "session";
}

export async function collectRoleFacts(client) {
  const facts = (await client.query(SESSION_FACTS_SQL)).rows[0] || {};
  const rls = (await client.query(FORCE_RLS_SQL)).rows[0] || {};
  return {
    currentUserClass: classifyUser(facts.current_user),
    sessionUserClass: classifyUser(facts.session_user),
    sessionIsSuperuser: safeBool(facts.session_is_superuser),
    sessionMemberNestaApp: safeBool(facts.session_member_nesta_app),
    appMemberLoginReader: safeBool(facts.app_member_login_reader),
    appMemberRevealer: safeBool(facts.app_member_revealer),
    readerCannotEscalateToApp: facts.reader_member_app !== true,
    revealerCannotEscalateToApp: facts.revealer_member_app !== true,
    employeeCredentialsRls: safeBool(rls.rls),
    employeeCredentialsForceRls: safeBool(rls.force_rls),
  };
}

export async function probeRoleCapabilities(client) {
  const facts = await collectRoleFacts(client);
  const canApp = await canSetRole(client, "nesta_app");
  const canReader = await canSetRole(client, "nesta_login_reader");
  const canRevealer = await canSetRole(client, "nesta_credential_revealer");

  await probeAllowed(client, "SELECT attempt_id FROM production_migration_attempts LIMIT 0");
  await probeAllowed(client, "SELECT version, name, checksum FROM schema_migrations LIMIT 0");

  await client.query("SET LOCAL ROLE nesta_app");
  const appAttempts = await probeDenied42501(client, "SELECT attempt_id FROM production_migration_attempts LIMIT 0");
  const appHash = await probeDenied42501(client, "SELECT password_hash FROM employee_credentials LIMIT 0");
  const appEnc = await probeDenied42501(client, "SELECT password_enc FROM employee_credentials LIMIT 0");
  const appCanSetReader = await canSetRole(client, "nesta_login_reader");
  await client.query("SET LOCAL ROLE nesta_app");
  const appCanSetRevealer = await canSetRole(client, "nesta_credential_revealer");

  await client.query("SET LOCAL ROLE nesta_login_reader");
  await probeAllowed(client, "SELECT employee_id, password_hash FROM employee_credentials LIMIT 0");
  const readerEnc = await probeDenied42501(client, "SELECT password_enc FROM employee_credentials LIMIT 0");
  const readerAttempts = await probeDenied42501(client, "SELECT attempt_id FROM production_migration_attempts LIMIT 0");

  await client.query("SET LOCAL ROLE nesta_credential_revealer");
  await probeAllowed(client, "SELECT employee_id, password_enc FROM employee_credentials LIMIT 0");
  const revealerHash = await probeDenied42501(client, "SELECT password_hash FROM employee_credentials LIMIT 0");

  await client.query("SET LOCAL ROLE NONE");

  return {
    ...facts,
    canSetRoleNestaApp: canApp,
    canSetRoleLoginReader: canReader,
    canSetRoleRevealer: canRevealer,
    sessionReadsAttempts: true,
    sessionReadsMigrations: true,
    nestaAppCannotReadAttempts: appAttempts.denied === true && appAttempts.sqlstate === SQLSTATE_DENIED,
    nestaAppCannotReadPasswordHash: appHash.denied === true && appHash.sqlstate === SQLSTATE_DENIED,
    nestaAppCannotReadPasswordEnc: appEnc.denied === true && appEnc.sqlstate === SQLSTATE_DENIED,
    nestaAppCanSetLoginReader: appCanSetReader,
    nestaAppCanSetRevealer: appCanSetRevealer,
    readerCanReadHash: true,
    readerCannotReadEnc: readerEnc.denied === true && readerEnc.sqlstate === SQLSTATE_DENIED,
    readerCannotReadAttempts: readerAttempts.denied === true && readerAttempts.sqlstate === SQLSTATE_DENIED,
    revealerCanReadEnc: true,
    revealerCannotReadHash: revealerHash.denied === true && revealerHash.sqlstate === SQLSTATE_DENIED,
  };
}

function requiredCapabilityOk(checks) {
  return [
    checks.canSetRoleNestaApp,
    checks.canSetRoleLoginReader,
    checks.canSetRoleRevealer,
    checks.sessionReadsAttempts,
    checks.sessionReadsMigrations,
    checks.nestaAppCannotReadAttempts,
    checks.nestaAppCannotReadPasswordHash,
    checks.nestaAppCannotReadPasswordEnc,
    checks.nestaAppCanSetLoginReader,
    checks.nestaAppCanSetRevealer,
    checks.readerCanReadHash,
    checks.readerCannotReadEnc,
    checks.revealerCanReadEnc,
    checks.revealerCannotReadHash,
    checks.employeeCredentialsForceRls,
    checks.appMemberLoginReader,
    checks.appMemberRevealer,
    checks.readerCannotEscalateToApp,
    checks.revealerCannotEscalateToApp,
  ].every((value) => value === true);
}

async function finishCredentialRollback(client, primaryErr) {
  const rb = await boundedCredentialRollback(client);
  if (primaryErr) {
    if (!rb.ok) primaryErr.cleanupCode = rb.code || GATE_ERROR.PG_ROLLBACK_FAILED;
    throw primaryErr;
  }
  if (!rb.ok) {
    const code = rb.code || GATE_ERROR.PG_ROLLBACK_FAILED;
    const err = new Error(code);
    err.code = code;
    err.cleanupCode = code;
    throw err;
  }
}

export async function runProductionCredentialRolePreflight({
  client,
  env = {},
  masked,
  liveFingerprint,
} = {}) {
  identifyProductionPgTarget(masked, env);
  if (liveFingerprint && env.NESTA_PRODUCTION_PG_TARGET_FINGERPRINT
    && liveFingerprint !== env.NESTA_PRODUCTION_PG_TARGET_FINGERPRINT) {
    return failResult(GATE_ERROR.TARGET_FINGERPRINT_MISMATCH, {});
  }
  throwIfCredentialCliFailed();

  await client.query("BEGIN READ ONLY");
  let result;
  let workerError = null;
  try {
    const checks = await probeRoleCapabilities(client);
    throwIfCredentialCliFailed();
    if (checks.sessionIsSuperuser) {
      result = failResult(ROLE_PREFLIGHT_CODE.SESSION_SUPERUSER_REJECTED, checks);
    } else if (!requiredCapabilityOk(checks)) {
      result = failResult(ROLE_PREFLIGHT_CODE.ROLE_PREFLIGHT_FAILED, checks);
    } else {
      result = { ok: true, code: ROLE_PREFLIGHT_CODE.OK, checks };
    }
  } catch (err) {
    workerError = err;
  }
  await finishCredentialRollback(client, workerError);
  throwIfCredentialCliFailed();
  return result;
}

export async function runLocalCredentialRolePreflight(client, {
  restaurantId,
  adminEmployeeId,
  waiterEmployeeId,
  passwordHash,
} = {}) {
  await client.query("BEGIN");
  let checks;
  try {
    checks = await probeRoleCapabilities(client);
  } catch (err) {
    await finishCredentialRollback(client, err);
  }
  await finishCredentialRollback(client);

  checks.adminInsertOk = false;
  checks.waiterInsertSqlstate = null;
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE nesta_app");
    await client.query("SELECT set_config('app.current_restaurant_id', $1, true)", [restaurantId]);
    await client.query("SELECT set_config('app.current_employee_role', 'admin', true)");
    await client.query(
      "INSERT INTO employee_credentials (employee_id, password_hash, password_enc, updated_at) VALUES ($1, $2, NULL, now())",
      [adminEmployeeId, passwordHash],
    );
    checks.adminInsertOk = true;
    await client.query("SELECT set_config('app.current_employee_role', 'waiter', true)");
    const waiter = await probeDenied42501(
      client,
      {
        text: "INSERT INTO employee_credentials (employee_id, password_hash, password_enc, updated_at) VALUES ($1, $2, NULL, now())",
        values: [waiterEmployeeId, passwordHash],
      },
    );
    checks.waiterInsertSqlstate = waiter.sqlstate;
    checks.waiterDenied42501 = waiter.denied === true && waiter.sqlstate === SQLSTATE_DENIED;
  } catch (err) {
    await finishCredentialRollback(client, err);
  }
  await finishCredentialRollback(client);
  const ok = requiredCapabilityOk(checks)
    && checks.adminInsertOk === true
    && checks.waiterDenied42501 === true;
  return {
    ok,
    code: ok ? ROLE_PREFLIGHT_CODE.OK : ROLE_PREFLIGHT_CODE.ROLE_PREFLIGHT_FAILED,
    checks,
  };
}
