import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { hashPassword, isHashed, verifyPassword } from "../../security/password.js";
import {
  classifyStoredPassword,
  sourceHashValue,
  sourceEncValue,
  MALFORMED_SOURCE,
} from "../scripts/lib/credentialHashCompatibility.mjs";
import { exampleLiveTargetFingerprint } from "../scripts/lib/pgTargetFingerprint.mjs";
import {
  APPROVED_RTDB_URL,
  ATTEMPT_SELECT_SQL,
  CREDENTIAL_APPLY_CONFIRM_ENV,
  CREDENTIAL_APPLY_CONFIRM_PHRASE,
  CREDENTIAL_INSERT_SQL,
  CREDENTIAL_MAINTENANCE_EVIDENCE_ENV,
  CREDENTIAL_MAINTENANCE_EVIDENCE_PHRASE,
  CREDENTIAL_TARGET_FINGERPRINT_ENV,
  EXISTING_ENC_SQL,
  EXISTING_HASH_SQL,
  EXISTING_META_SQL,
  GATE_ERROR,
  PROTECTED_CONTENT_FINGERPRINT_SQL,
  RECONCILE_COUNTS_SQL,
  RLS_ACTOR_PROBE_SQL,
  SESSION_PROTECTED_FINGERPRINT_SQL,
  SET_ACTOR_ROLE_SQL,
  SET_ROLE_APP_SQL,
  SET_ROLE_LOGIN_READER_SQL,
  SET_ROLE_NONE_SQL,
  SET_ROLE_REVEALER_SQL,
  SET_TENANT_SQL,
  assertCredentialApplyAuthorization,
  assertFirebaseProductionSource,
  assertRequiredFingerprintCoverage,
  assertProductionStaticBeforeConnect,
  fingerprintColumns,
  publicErrorCode,
  runCredentialGate,
  withLoginReader,
  EXCLUDED_FROM_PROTECTED_FINGERPRINT,
} from "../scripts/lib/productionCredentialGate.mjs";
import {
  ACCEPTANCE_ERROR,
  AcceptanceTargetError,
  acceptanceDisposition,
  connectOnlyAfterLoopbackAccepted,
  inspectPgTargetFromEnv,
  finalizeAcceptanceCleanup,
} from "../scripts/lib/credentialAcceptanceTarget.mjs";
import { ROLE_PREFLIGHT_CODE, runProductionCredentialRolePreflight, probeDenied42501, isExpectedPermissionDenied } from "../scripts/lib/credentialRolePreflight.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FINGERPRINT = exampleLiveTargetFingerprint();
const BCRYPT_TAIL = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
const gateSrc = readFileSync(path.join(here, "../scripts/lib/productionCredentialGate.mjs"), "utf8");
const cliSrc = readFileSync(path.join(here, "../scripts/production-credentials-migrate.mjs"), "utf8");
const step2bSrc = readFileSync(path.join(here, "../scripts/step2b-credentials-local.mjs"), "utf8");
const SESSION_USER = "nesta";

function applyMasked() {
  return { host: "switchback.proxy.rlwy.net", port: "12345", database: "railway", user: "u" };
}

function applyEnv(extra = {}) {
  return {
    NESTA_MIGRATE_TARGET: "production",
    [CREDENTIAL_APPLY_CONFIRM_ENV]: CREDENTIAL_APPLY_CONFIRM_PHRASE,
    NESTA_MAINTENANCE_MODE: "1",
    [CREDENTIAL_MAINTENANCE_EVIDENCE_ENV]: CREDENTIAL_MAINTENANCE_EVIDENCE_PHRASE,
    [CREDENTIAL_TARGET_FINGERPRINT_ENV]: FINGERPRINT,
    POSTGRES_SSL: "true",
    FIREBASE_PROJECT_ID: "restoran-30d51",
    FIREBASE_DATABASE_URL: APPROVED_RTDB_URL,
    ...extra,
  };
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function cloneMap(map) {
  return new Map([...map.entries()].map(([key, value]) => [key, { ...value }]));
}

function createWorld({ fbTree, restaurants, employees, credentials = [], attempts, tableCounts, restaurantName = "Cafe", abortOnHashSelect = false, restoreFailCode = null } = {}) {
  const restRows = restaurants || [{ id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "rest_1", name: restaurantName, status: "active", domain: "cafe.local" }];
  const empRows = employees || [
    { id: "e-hash", restaurant_id: restRows[0].id, legacy_rtdb_id: "waiter_hash" },
    { id: "e-enc", restaurant_id: restRows[0].id, legacy_rtdb_id: "waiter_enc" },
    { id: "e-both", restaurant_id: restRows[0].id, legacy_rtdb_id: "waiter_both" },
    { id: "e-missing", restaurant_id: restRows[0].id, legacy_rtdb_id: "waiter_missing" },
  ];
  const creds = new Map(credentials.map((row) => [String(row.employee_id), {
    updated_at: row.updated_at ?? 1,
    ...row,
  }]));
  const attemptRows = attempts || [{
    attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "FULL_COMPLETE",
    phase: "full-after-wave1",
    target_fingerprint: FINGERPRINT,
    firebase_project: "restoran-30d51",
    updated_at: "2026-01-01T00:00:00Z",
  }];
  const counts = {
    restaurants: restRows.length,
    employees: empRows.length,
    orders: 4,
    order_items: 8,
    payments: 2,
    custom_roles: 1,
    payment_credentials: 0,
    two_factor_credentials: 0,
    organizations: 1,
    platform_users: 1,
    backup_codes: 0,
    schema_migrations: 18,
    production_migration_attempts: 1,
    ...tableCounts,
  };
  const mutating = [];
  const statements = [];
  const fbWrites = [];
  const tree = fbTree || {};
  let currentUser = SESSION_USER;
  let actorRole = "";
  let restaurantId = "";
  let updatedClock = 10;
  let tx = null;
  let fingerprintMutated = false;
  let aborted = false;
  let pendingRestoreFail = null;

  function snapshot() {
    return {
      creds: cloneMap(creds),
      restName: restRows[0]?.name,
      currentUser,
      actorRole,
      restaurantId,
      aborted,
    };
  }

  function restore(saved) {
    creds.clear();
    for (const [key, value] of saved.creds) creds.set(key, { ...value });
    if (restRows[0]) restRows[0].name = saved.restName;
    currentUser = saved.currentUser;
    actorRole = saved.actorRole;
    restaurantId = saved.restaurantId;
    aborted = false;
  }

  function protectedRow() {
    return { fp: fingerprintMutated ? "mutated" : "stable" };
  }

  function sessionRow() {
    return {
      attempts_n: attemptRows.length,
      attempts_fp: String(attemptRows.length),
      schema_migrations_n: counts.schema_migrations,
      schema_migrations_fp: "schema",
    };
  }

  function deny() {
    const err = new Error("permission denied");
    err.code = "42501";
    throw err;
  }

  function assertHashRole() {
    if (currentUser !== "nesta_login_reader") deny();
  }
  function assertEncRole() {
    if (currentUser !== "nesta_credential_revealer") deny();
  }
  function assertAttemptRole() {
    if (currentUser === "nesta_app" || currentUser === "nesta_login_reader" || currentUser === "nesta_credential_revealer") {
      deny();
    }
  }

  const fb = {
    async shallowKeys(p) {
      if (p === "credentials") return Object.keys(tree);
      const one = /^credentials\/([^/]+)$/.exec(p);
      if (one) return Object.keys(tree[one[1]] || {});
      return [];
    },
    async getValue(p) {
      const leaf = /^credentials\/([^/]+)\/([^/]+)$/.exec(p);
      if (!leaf) return null;
      return tree[leaf[1]]?.[leaf[2]] ?? null;
    },
    async set() { fbWrites.push("set"); },
    async update() { fbWrites.push("update"); },
    async remove() { fbWrites.push("remove"); },
  };

  const client = {
    async query(sql, params = []) {
      const text = normalizeSql(sql);
      statements.push(text);
      if (text === "BEGIN" || text === "BEGIN READ ONLY") {
        mutating.push(text === "BEGIN READ ONLY" ? "BEGIN READ ONLY" : "BEGIN");
        aborted = false;
        tx = snapshot();
        return { rows: [], rowCount: 0 };
      }
      if (text === "COMMIT") {
        mutating.push("COMMIT");
        tx = null;
        aborted = false;
        return { rows: [], rowCount: 0 };
      }
      if (text === "ROLLBACK") {
        mutating.push("ROLLBACK");
        if (tx) restore(tx);
        tx = null;
        aborted = false;
        currentUser = SESSION_USER;
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("SAVEPOINT ") || text.startsWith("RELEASE SAVEPOINT")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("ROLLBACK TO SAVEPOINT")) {
        aborted = false;
        return { rows: [], rowCount: 0 };
      }
      if (aborted && restoreFailCode && (text === normalizeSql(SET_ROLE_APP_SQL) || text.startsWith("SET LOCAL ROLE nesta_app"))) {
        const err = new Error("restore failed");
        err.code = restoreFailCode;
        throw err;
      }
      if (aborted && !text.startsWith("ROLLBACK")) {
        const err = new Error("current transaction is aborted");
        err.code = "25P02";
        throw err;
      }
      if (text === normalizeSql(SET_ROLE_NONE_SQL) || text === "SET LOCAL ROLE NONE") {
        currentUser = SESSION_USER;
        return { rows: [], rowCount: 0 };
      }
      if (text === normalizeSql(SET_ROLE_APP_SQL) || text.startsWith("SET LOCAL ROLE nesta_app")) {
        if (pendingRestoreFail) {
          const err = new Error("restore failed");
          err.code = pendingRestoreFail;
          pendingRestoreFail = null;
          throw err;
        }
        currentUser = "nesta_app";
        return { rows: [], rowCount: 0 };
      }
      if (text === normalizeSql(SET_ROLE_LOGIN_READER_SQL)) {
        currentUser = "nesta_login_reader";
        return { rows: [], rowCount: 0 };
      }
      if (text === normalizeSql(SET_ROLE_REVEALER_SQL)) {
        currentUser = "nesta_credential_revealer";
        return { rows: [], rowCount: 0 };
      }
      if (text === normalizeSql(SET_ACTOR_ROLE_SQL) || text.startsWith("SELECT set_config('app.current_employee_role'")) {
        actorRole = String(params[0] ?? "");
        return { rows: [], rowCount: 0 };
      }
      if (text === normalizeSql(SET_TENANT_SQL) || text.startsWith("SELECT set_config('app.current_restaurant_id'")) {
        restaurantId = String(params[0] ?? "");
        return { rows: [], rowCount: 0 };
      }
      if (text === normalizeSql(RLS_ACTOR_PROBE_SQL) || text.includes("current_user AS current_user")) {
        return { rows: [{ current_user: currentUser, actor_role: actorRole, restaurant_id: restaurantId }] };
      }
      if (text === "SELECT id, legacy_rtdb_id FROM restaurants") return { rows: restRows };
      if (text === "SELECT id, legacy_rtdb_id FROM employees WHERE restaurant_id = $1") {
        return { rows: empRows.filter((row) => row.restaurant_id === params[0]) };
      }
      if (text === normalizeSql(EXISTING_HASH_SQL)) {
        assertHashRole();
        if (abortOnHashSelect) {
          aborted = true;
          const err = new Error("secret select failed");
          err.code = "XX000";
          throw err;
        }
        if (restoreFailCode) pendingRestoreFail = restoreFailCode;
        return { rows: [...creds.values()].map((row) => ({ employee_id: row.employee_id, password_hash: row.password_hash ?? null })) };
      }
      if (text === normalizeSql(EXISTING_ENC_SQL)) {
        assertEncRole();
        return { rows: [...creds.values()].map((row) => ({ employee_id: row.employee_id, password_enc: row.password_enc ?? null })) };
      }
      if (text === normalizeSql(EXISTING_META_SQL)) {
        return { rows: [...creds.values()].map((row) => ({ employee_id: row.employee_id, updated_at: row.updated_at ?? null })) };
      }
      if (text === "SELECT count(*)::int AS n FROM employees") return { rows: [{ n: empRows.length }] };
      if (text.includes("FROM production_migration_attempts")) {
        assertAttemptRole();
        if (text.includes("attempts_fp") || text.includes("credential-gate-session-protected-fingerprint")) {
          return { rows: [sessionRow()] };
        }
        const wanted = params[0];
        const rows = wanted
          ? attemptRows.filter((row) => row.target_fingerprint === wanted)
          : attemptRows;
        return { rows };
      }
      if (text.includes("credential-gate-protected-content-fingerprint") || text === normalizeSql(PROTECTED_CONTENT_FINGERPRINT_SQL)) {
        return { rows: [protectedRow()] };
      }
      if (text.includes("credential-gate-session-protected-fingerprint") || text === normalizeSql(SESSION_PROTECTED_FINGERPRINT_SQL)) {
        assertAttemptRole();
        return { rows: [sessionRow()] };
      }
      if (text === normalizeSql(RECONCILE_COUNTS_SQL) || (text.includes("distinct_employees") && !text.includes("password_hash"))) {
        const rows = [...creds.values()];
        return {
          rows: [{
            total: rows.length,
            distinct_employees: new Set(rows.map((row) => row.employee_id)).size,
          }],
        };
      }
      if (text.includes("FILTER (WHERE password_hash") || (text.includes("password_hash") && text.includes("count(") && currentUser === "nesta_app")) {
        deny();
      }
      if (text === normalizeSql(CREDENTIAL_INSERT_SQL) || text.startsWith("INSERT INTO employee_credentials")) {
        mutating.push("INSERT");
        if (text.includes("ON CONFLICT") || text.includes("COALESCE")) mutating.push("COALESCE_UPSERT");
        const employeeId = params[0];
        updatedClock += 1;
        creds.set(String(employeeId), {
          employee_id: employeeId,
          password_hash: params[1] ?? null,
          password_enc: params[2] ?? null,
          updated_at: updatedClock,
        });
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("UPDATE employee_credentials")) {
        mutating.push("UPDATE");
        const employeeId = params[0];
        const prev = creds.get(String(employeeId));
        if (prev) {
          updatedClock += 1;
          creds.set(String(employeeId), { ...prev, updated_at: updatedClock });
        }
        return { rows: [], rowCount: prev ? 1 : 0 };
      }
      throw new Error(`unhandled sql: ${text.slice(0, 180)}`);
    },
  };

  return {
    fb,
    client,
    mutating,
    statements,
    fbWrites,
    creds,
    restRows,
    empRows,
    currentUser: () => currentUser,
    mutateProtectedNonId() {
      fingerprintMutated = true;
      if (restRows[0]) restRows[0].name = `${restRows[0].name}-changed`;
    },
  };
}

function defaultTree(hash, extra = {}) {
  return {
    rest_1: {
      waiter_hash: { password: hash },
      waiter_enc: { passwordEnc: "enc-cipher" },
      waiter_both: { password: hash, passwordEnc: "enc-cipher" },
      waiter_ghost: { password: hash },
      ...extra,
    },
  };
}

function codeThrown(fn, code) {
  assert.throws(fn, (err) => publicErrorCode(err) === code);
}

test("verifyPassword acceptance paths match the classifier", async () => {
  const bcrypt = await hashPassword("4826");
  assert.equal(classifyStoredPassword(bcrypt).kind, "bcrypt");
  assert.equal(classifyStoredPassword("4826").kind, "plaintext");
  const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  assert.equal(classifyStoredPassword(sha).requiresReset, true);
  assert.equal(classifyStoredPassword(sha).copyable, false);
});

test("bcrypt cost 00 and truncated hashes are rejected", () => {
  const cost00 = `$2a$00$${BCRYPT_TAIL}`;
  assert.equal(cost00.length, 60);
  assert.equal(classifyStoredPassword(cost00).copyable, false);
  assert.equal(classifyStoredPassword(`$2a$32$${BCRYPT_TAIL}`).copyable, false);
});

test("uppercase SHA is not treated as compatible", () => {
  const classified = classifyStoredPassword("E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855");
  assert.notEqual(classified.kind, "sha256");
  assert.equal(classified.migratable, false);
});

test("object source hashes are malformed and never stringified", () => {
  assert.equal(sourceHashValue({ password: { nested: true } }), MALFORMED_SOURCE);
  assert.equal(sourceEncValue({ passwordEnc: ["x"] }), MALFORMED_SOURCE);
});

test("raw FIREBASE_DATABASE_URL must equal the canonical HTTPS origin", () => {
  assert.doesNotThrow(() => assertFirebaseProductionSource(applyEnv()));
  codeThrown(
    () => assertFirebaseProductionSource(applyEnv({ FIREBASE_DATABASE_URL: `${APPROVED_RTDB_URL}:443` })),
    GATE_ERROR.SOURCE_ORIGIN_INVALID,
  );
  codeThrown(
    () => assertFirebaseProductionSource(applyEnv({ FIREBASE_DATABASE_URL: `${APPROVED_RTDB_URL}?` })),
    GATE_ERROR.SOURCE_ORIGIN_INVALID,
  );
  codeThrown(
    () => assertFirebaseProductionSource(applyEnv({ FIREBASE_DATABASE_URL: `${APPROVED_RTDB_URL}#` })),
    GATE_ERROR.SOURCE_ORIGIN_INVALID,
  );
  codeThrown(
    () => assertFirebaseProductionSource(applyEnv({ FIREBASE_DATABASE_URL: `${APPROVED_RTDB_URL}/` })),
    GATE_ERROR.SOURCE_ORIGIN_INVALID,
  );
  codeThrown(
    () => assertFirebaseProductionSource(applyEnv({ FIREBASE_DATABASE_URL: "http://restoran-30d51-default-rtdb.firebaseio.com" })),
    GATE_ERROR.SOURCE_ORIGIN_INVALID,
  );
  codeThrown(
    () => assertFirebaseProductionSource(applyEnv({ FIREBASE_PROJECT_ID: "other-project" })),
    GATE_ERROR.SOURCE_PROJECT_INVALID,
  );
  assert.doesNotMatch(gateSrc, /dbUrl\.includes\(|new URL\(/);
  assert.match(gateSrc, /raw !== APPROVED_RTDB_URL/);
});

test("generated fingerprint SQL covers authorization fields and keeps NULL distinct from empty string", () => {
  assert.doesNotThrow(() => assertRequiredFingerprintCoverage(
    PROTECTED_CONTENT_FINGERPRINT_SQL,
    SESSION_PROTECTED_FINGERPRINT_SQL,
  ));
  const employeeSql = PROTECTED_CONTENT_FINGERPRINT_SQL;
  assert.equal(fingerprintColumns("employees").includes("login"), true);
  assert.equal(fingerprintColumns("employees").includes("custom_role_id"), true);
  assert.equal(fingerprintColumns("employees").includes("modules"), true);
  assert.equal(fingerprintColumns("employees").includes("actions"), true);
  assert.equal(fingerprintColumns("role_overrides").includes("restaurant_id"), true);
  assert.equal(fingerprintColumns("role_overrides").includes("base_role"), true);
  assert.equal(fingerprintColumns("role_overrides").includes("modules"), true);
  assert.equal(fingerprintColumns("role_overrides").includes("actions"), true);
  assert.equal(fingerprintColumns("restaurant_modules").includes("restaurant_id"), true);
  assert.equal(fingerprintColumns("restaurant_modules").includes("enabled_modules"), true);
  assert.equal(fingerprintColumns("restaurant_modules").includes("extra"), true);
  assert.match(employeeSql, /AS role_overrides_fp/);
  assert.match(employeeSql, /AS restaurant_modules_fp/);
  assert.match(employeeSql, /'login', login/);
  assert.match(employeeSql, /'base_role', base_role/);
  assert.match(employeeSql, /'enabled_modules', enabled_modules/);
  assert.match(employeeSql, /'extra', extra/);
  assert.match(employeeSql, /jsonb_build_array\(restaurant_id, base_role\)/);
  assert.equal(fingerprintColumns("platform_users").includes("permissions"), true);
  assert.equal(fingerprintColumns("schema_migrations").includes("checksum"), true);
  assert.equal(fingerprintColumns("production_migration_attempts").includes("target_fingerprint"), true);
  assert.match(employeeSql, /jsonb_build_object/);
  assert.match(employeeSql, /'login', login/);
  assert.doesNotMatch(employeeSql, /pg_stat_/);
  assert.doesNotMatch(employeeSql, /chr\(31\)|concat_ws/i);
  assert.doesNotMatch(employeeSql, /COALESCE\s*\(\s*[a-z_][a-z0-9_]*\s*,\s*''\s*\)/i);
  assert.match(PROTECTED_CONTENT_FINGERPRINT_SQL, /AT TIME ZONE 'UTC'/);
  assert.match(SESSION_PROTECTED_FINGERPRINT_SQL, /'checksum', checksum/);
  assert.match(SESSION_PROTECTED_FINGERPRINT_SQL, /'firebase_project', firebase_project/);
  const omittedLogin = PROTECTED_CONTENT_FINGERPRINT_SQL.replace(/'login',\s*login,\s*/g, "");
  assert.throws(
    () => assertRequiredFingerprintCoverage(omittedLogin, SESSION_PROTECTED_FINGERPRINT_SQL),
    /FINGERPRINT_FIELD_MISSING:employees\.login/,
  );
  const omittedActions = PROTECTED_CONTENT_FINGERPRINT_SQL.replace(/'actions',\s*actions/g, "'name', name");
  assert.throws(
    () => assertRequiredFingerprintCoverage(omittedActions, SESSION_PROTECTED_FINGERPRINT_SQL),
    /FINGERPRINT_FIELD_MISSING:.*actions/,
  );
  const omittedPermissions = PROTECTED_CONTENT_FINGERPRINT_SQL.replace(/'permissions',\s*permissions,\s*/g, "");
  assert.throws(
    () => assertRequiredFingerprintCoverage(omittedPermissions, SESSION_PROTECTED_FINGERPRINT_SQL),
    /FINGERPRINT_FIELD_MISSING:platform_users\.permissions/,
  );
  const omittedChecksum = SESSION_PROTECTED_FINGERPRINT_SQL.replace(/'checksum',\s*checksum,\s*/g, "");
  assert.throws(
    () => assertRequiredFingerprintCoverage(PROTECTED_CONTENT_FINGERPRINT_SQL, omittedChecksum),
    /FINGERPRINT_FIELD_MISSING:schema_migrations\.checksum/,
  );
  const omittedBinding = SESSION_PROTECTED_FINGERPRINT_SQL.replace(/'target_fingerprint',\s*target_fingerprint,\s*/g, "");
  assert.throws(
    () => assertRequiredFingerprintCoverage(PROTECTED_CONTENT_FINGERPRINT_SQL, omittedBinding),
    /FINGERPRINT_FIELD_MISSING:production_migration_attempts\.target_fingerprint/,
  );
  const omittedOverrides = PROTECTED_CONTENT_FINGERPRINT_SQL.replace(/AS role_overrides_fp/g, "AS skipped_fp");
  assert.throws(
    () => assertRequiredFingerprintCoverage(omittedOverrides, SESSION_PROTECTED_FINGERPRINT_SQL),
    /FINGERPRINT_TABLE_MISSING:role_overrides/,
  );
  const omittedModules = PROTECTED_CONTENT_FINGERPRINT_SQL.replace(/AS restaurant_modules_fp/g, "AS skipped_mod_fp");
  assert.throws(
    () => assertRequiredFingerprintCoverage(omittedModules, SESSION_PROTECTED_FINGERPRINT_SQL),
    /FINGERPRINT_TABLE_MISSING:restaurant_modules/,
  );
  assert.throws(
    () => assertRequiredFingerprintCoverage(
      PROTECTED_CONTENT_FINGERPRINT_SQL.replace(/'modifiers',\s*modifiers,\s*/g, ""),
      SESSION_PROTECTED_FINGERPRINT_SQL,
    ),
    /FINGERPRINT_FIELD_MISSING:order_items\.modifiers/,
  );
  assert.throws(
    () => assertRequiredFingerprintCoverage(
      PROTECTED_CONTENT_FINGERPRINT_SQL.replace(/'extras',\s*extras,\s*/g, ""),
      SESSION_PROTECTED_FINGERPRINT_SQL,
    ),
    /FINGERPRINT_FIELD_MISSING:order_items\.extras/,
  );
  assert.throws(
    () => assertRequiredFingerprintCoverage(
      PROTECTED_CONTENT_FINGERPRINT_SQL.replace(/'variant_snapshot',\s*variant_snapshot,\s*/g, ""),
      SESSION_PROTECTED_FINGERPRINT_SQL,
    ),
    /FINGERPRINT_FIELD_MISSING:order_items\.variant_snapshot/,
  );
  const courierAlias = " AS courier_assignments_fp";
  const courierIdx = PROTECTED_CONTENT_FINGERPRINT_SQL.indexOf(courierAlias);
  assert.notEqual(courierAlias === " AS courier_assignments_fp" ? courierIdx : -1, -1);
  assert.notEqual(courierIdx, -1);
  const courierStart = PROTECTED_CONTENT_FINGERPRINT_SQL.lastIndexOf("(SELECT md5", courierIdx);
  const courierFragment = PROTECTED_CONTENT_FINGERPRINT_SQL.slice(courierStart, courierIdx);
  const omittedCourierStatus = PROTECTED_CONTENT_FINGERPRINT_SQL.slice(0, courierStart)
    + courierFragment.replace("'status', status, ", "")
    + PROTECTED_CONTENT_FINGERPRINT_SQL.slice(courierIdx);
  assert.throws(
    () => assertRequiredFingerprintCoverage(omittedCourierStatus, SESSION_PROTECTED_FINGERPRINT_SQL),
    /FINGERPRINT_FIELD_MISSING:courier_assignments\.status/,
  );
  const omittedCourierRel = PROTECTED_CONTENT_FINGERPRINT_SQL.slice(0, courierStart)
    + courierFragment.replace("'courier_id', courier_id, ", "")
    + PROTECTED_CONTENT_FINGERPRINT_SQL.slice(courierIdx);
  assert.throws(
    () => assertRequiredFingerprintCoverage(omittedCourierRel, SESSION_PROTECTED_FINGERPRINT_SQL),
    /FINGERPRINT_FIELD_MISSING:courier_assignments\.courier_id/,
  );
  assert.equal(fingerprintColumns("order_items").includes("modifiers"), true);
  assert.equal(fingerprintColumns("order_items").includes("extras"), true);
  assert.equal(fingerprintColumns("order_items").includes("variant_snapshot"), true);
  assert.equal(fingerprintColumns("courier_assignments").includes("status"), true);
  assert.equal(fingerprintColumns("courier_assignments").includes("courier_id"), true);
  assert.equal(Object.hasOwn(EXCLUDED_FROM_PROTECTED_FINGERPRINT, "order_change_requests"), false);
  assert.equal(Object.hasOwn(EXCLUDED_FROM_PROTECTED_FINGERPRINT, "waiter_calls"), false);
  function tableSqlParts(sql, table) {
    const alias = ` AS ${table}_fp`;
    const idx = sql.indexOf(alias);
    assert.notEqual(idx, -1, alias);
    const start = sql.lastIndexOf("(SELECT md5", idx);
    return { alias, idx, start, fragment: sql.slice(start, idx) };
  }
  function omitTableNeedle(sql, table, needle) {
    const parts = tableSqlParts(sql, table);
    assert.equal(parts.fragment.includes(needle), true, needle);
    return sql.slice(0, parts.start) + parts.fragment.replace(needle, "") + sql.slice(parts.idx);
  }
  const ocr = tableSqlParts(PROTECTED_CONTENT_FINGERPRINT_SQL, "order_change_requests");
  assert.equal(ocr.fragment.includes("'legacy_rtdb_id', legacy_rtdb_id"), true);
  assert.equal(ocr.fragment.includes("'legacy_order_id', legacy_order_id"), true);
  assert.equal(ocr.fragment.includes("'payload', payload"), true);
  assert.equal(ocr.fragment.includes("'order_id', order_id"), true);
  assert.equal(ocr.fragment.includes("'requested_by', requested_by"), true);
  assert.throws(
    () => assertRequiredFingerprintCoverage(
      omitTableNeedle(PROTECTED_CONTENT_FINGERPRINT_SQL, "order_change_requests", "'legacy_rtdb_id', legacy_rtdb_id, "),
      SESSION_PROTECTED_FINGERPRINT_SQL,
    ),
    /FINGERPRINT_FIELD_MISSING:order_change_requests\.legacy_rtdb_id/,
  );
  assert.throws(
    () => assertRequiredFingerprintCoverage(
      omitTableNeedle(PROTECTED_CONTENT_FINGERPRINT_SQL, "order_change_requests", "'legacy_order_id', legacy_order_id, "),
      SESSION_PROTECTED_FINGERPRINT_SQL,
    ),
    /FINGERPRINT_FIELD_MISSING:order_change_requests\.legacy_order_id/,
  );
  assert.throws(
    () => assertRequiredFingerprintCoverage(
      omitTableNeedle(PROTECTED_CONTENT_FINGERPRINT_SQL, "order_change_requests", "'payload', payload, "),
      SESSION_PROTECTED_FINGERPRINT_SQL,
    ),
    /FINGERPRINT_FIELD_MISSING:order_change_requests\.payload/,
  );
  assert.throws(
    () => assertRequiredFingerprintCoverage(
      PROTECTED_CONTENT_FINGERPRINT_SQL.replace(/AS order_change_requests_fp/g, "AS skipped_ocr_fp"),
      SESSION_PROTECTED_FINGERPRINT_SQL,
    ),
    /FINGERPRINT_TABLE_MISSING:order_change_requests/,
  );
  const waiter = tableSqlParts(PROTECTED_CONTENT_FINGERPRINT_SQL, "waiter_calls");
  assert.equal(waiter.fragment.includes("'legacy_rtdb_id', legacy_rtdb_id"), true);
  assert.equal(waiter.fragment.includes("'legacy_table_key', legacy_table_key"), true);
  assert.equal(waiter.fragment.includes("'extra', extra"), true);
  assert.equal(waiter.fragment.includes("'table_id', table_id"), true);
  assert.throws(
    () => assertRequiredFingerprintCoverage(
      omitTableNeedle(PROTECTED_CONTENT_FINGERPRINT_SQL, "waiter_calls", "'legacy_rtdb_id', legacy_rtdb_id, "),
      SESSION_PROTECTED_FINGERPRINT_SQL,
    ),
    /FINGERPRINT_FIELD_MISSING:waiter_calls\.legacy_rtdb_id/,
  );
  assert.throws(
    () => assertRequiredFingerprintCoverage(
      omitTableNeedle(PROTECTED_CONTENT_FINGERPRINT_SQL, "waiter_calls", "'legacy_table_key', legacy_table_key, "),
      SESSION_PROTECTED_FINGERPRINT_SQL,
    ),
    /FINGERPRINT_FIELD_MISSING:waiter_calls\.legacy_table_key/,
  );
  assert.throws(
    () => assertRequiredFingerprintCoverage(
      omitTableNeedle(PROTECTED_CONTENT_FINGERPRINT_SQL, "waiter_calls", "'extra', extra, "),
      SESSION_PROTECTED_FINGERPRINT_SQL,
    ),
    /FINGERPRINT_FIELD_MISSING:waiter_calls\.extra/,
  );
  assert.throws(
    () => assertRequiredFingerprintCoverage(
      PROTECTED_CONTENT_FINGERPRINT_SQL.replace(/AS waiter_calls_fp/g, "AS skipped_waiter_fp"),
      SESSION_PROTECTED_FINGERPRINT_SQL,
    ),
    /FINGERPRINT_TABLE_MISSING:waiter_calls/,
  );
  const unordered = PROTECTED_CONTENT_FINGERPRINT_SQL.replace(/jsonb_agg\(obj ORDER BY ord\)/g, "jsonb_agg(obj)");
  assert.throws(
    () => assertRequiredFingerprintCoverage(unordered, SESSION_PROTECTED_FINGERPRINT_SQL),
    /FINGERPRINT_ORDER_MISSING/,
  );
  assert.doesNotMatch(gateSrc, /digestProtectedSnapshot|createHash/);
});

test("rtdbAuthz SQL lookups are not left in the fingerprint exclusion list", () => {
  const authzSrc = readFileSync(path.join(here, "../../pg/rtdbAuthz.js"), "utf8");
  const fromTables = [...authzSrc.matchAll(/\bFROM\s+([a-z_"]+)/gi)].map((m) => m[1].replace(/"/g, ""));
  assert.ok(fromTables.includes("order_change_requests"));
  assert.ok(fromTables.includes("waiter_calls"));
  assert.ok(fromTables.includes("tables"));
  for (const table of fromTables) {
    assert.equal(
      Object.hasOwn(EXCLUDED_FROM_PROTECTED_FINGERPRINT, table),
      false,
      `${table} is used in rtdbAuthz SQL and must not stay excluded`,
    );
  }
  assert.match(authzSrc, /legacy_order_id \|\| row\?\.payload\?\.orderId/);
  assert.match(authzSrc, /legacy_table_key \|\| row\?\.extra\?\.table \|\| row\?\.extra\?\.tableId/);
});

test("secret-column and attempt reads are denied for nesta_app", async () => {
  const world = createWorld({ fbTree: { rest_1: {} } });
  await world.client.query("BEGIN");
  await world.client.query(SET_ROLE_APP_SQL);
  await assert.rejects(() => world.client.query(EXISTING_HASH_SQL), (err) => err.code === "42501");
  await assert.rejects(() => world.client.query(EXISTING_ENC_SQL), (err) => err.code === "42501");
  await assert.rejects(() => world.client.query(ATTEMPT_SELECT_SQL, [FINGERPRINT]), (err) => err.code === "42501");
  await world.client.query(SET_ROLE_LOGIN_READER_SQL);
  await assert.doesNotReject(() => world.client.query(EXISTING_HASH_SQL));
  await assert.rejects(() => world.client.query(EXISTING_ENC_SQL), (err) => err.code === "42501");
  await world.client.query(SET_ROLE_REVEALER_SQL);
  await assert.doesNotReject(() => world.client.query(EXISTING_ENC_SQL));
  await world.client.query(SET_ROLE_NONE_SQL);
  await assert.doesNotReject(() => world.client.query(ATTEMPT_SELECT_SQL, [FINGERPRINT]));
});

test("dry-run validates source before any Firebase read and stays zero-write", async () => {
  const hash = await hashPassword("4826");
  const world = createWorld({ fbTree: defaultTree(hash) });
  let reads = 0;
  const fb = {
    ...world.fb,
    async shallowKeys(p) {
      reads += 1;
      return world.fb.shallowKeys(p);
    },
  };
  await assert.rejects(
    () => runCredentialGate({
      argv: [],
      env: applyEnv({ FIREBASE_DATABASE_URL: `${APPROVED_RTDB_URL}:443` }),
      masked: applyMasked(),
      fb,
      client: world.client,
      liveFingerprint: FINGERPRINT,
    }),
    (err) => publicErrorCode(err) === GATE_ERROR.SOURCE_ORIGIN_INVALID,
  );
  assert.equal(reads, 0);

  const report = await runCredentialGate({
    argv: [],
    env: applyEnv(),
    masked: applyMasked(),
    fb: world.fb,
    client: world.client,
    liveFingerprint: FINGERPRINT,
  });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.writes, 0);
  assert.equal(world.mutating.includes("INSERT"), false);
  assert.equal(world.mutating.includes("COMMIT"), false);
  assert.equal(world.mutating.includes("BEGIN READ ONLY"), true);
  assert.equal(world.mutating.includes("ROLLBACK"), true);
  assert.equal(world.fbWrites.length, 0);
  assert.equal(report.mappable, 3);
});

test("apply requires explicit --apply and confirmation phrase", () => {
  codeThrown(() => assertCredentialApplyAuthorization({ argv: [], env: applyEnv(), masked: applyMasked() }), GATE_ERROR.APPLY_FLAG_REQUIRED);
  codeThrown(
    () => assertCredentialApplyAuthorization({
      argv: ["--apply"],
      env: applyEnv({ [CREDENTIAL_APPLY_CONFIRM_ENV]: "yes" }),
      masked: applyMasked(),
    }),
    GATE_ERROR.APPLY_CONFIRM_INVALID,
  );
});

test("unknown production target is refused", () => {
  codeThrown(
    () => assertCredentialApplyAuthorization({
      argv: ["--apply"],
      env: applyEnv({ [CREDENTIAL_TARGET_FINGERPRINT_ENV]: "" }),
      masked: applyMasked(),
    }),
    GATE_ERROR.TARGET_FINGERPRINT_MISMATCH,
  );
  codeThrown(
    () => assertCredentialApplyAuthorization({
      argv: ["--apply"],
      env: applyEnv(),
      masked: { host: "127.0.0.1", database: "railway", user: "u" },
    }),
    GATE_ERROR.TARGET_NOT_PRODUCTION,
  );
});

test("hash-only, passwordEnc-only, and both are copied; plaintext is hashed first", async () => {
  const hash = await hashPassword("4826");
  const world = createWorld({ fbTree: defaultTree(hash) });
  const report = await runCredentialGate({
    argv: ["--apply"],
    env: applyEnv(),
    masked: applyMasked(),
    fb: world.fb,
    client: world.client,
    liveFingerprint: FINGERPRINT,
  });
  assert.equal(report.applied.inserted, 3);
  assert.equal(world.creds.get("e-hash").password_hash, hash);
  assert.equal(world.creds.get("e-enc").password_enc, "enc-cipher");
  assert.equal(JSON.stringify(report).includes(hash), false);

  const roles = world.statements;
  for (let i = 0; i < roles.length; i += 1) {
    if (roles[i] === normalizeSql(EXISTING_HASH_SQL)) {
      assert.equal(roles[i - 1], normalizeSql(SET_ROLE_LOGIN_READER_SQL));
      assert.equal(roles[i + 1], normalizeSql(SET_ROLE_APP_SQL));
    }
    if (roles[i] === normalizeSql(EXISTING_ENC_SQL)) {
      assert.equal(roles[i - 1], normalizeSql(SET_ROLE_REVEALER_SQL));
      assert.equal(roles[i + 1], normalizeSql(SET_ROLE_APP_SQL));
    }
    if (roles[i] === normalizeSql(ATTEMPT_SELECT_SQL)) {
      assert.equal(roles[i - 1], normalizeSql(SET_ROLE_NONE_SQL));
    }
  }

  const plainWorld = createWorld({
    fbTree: { rest_1: { waiter_hash: { password: "4826" } } },
    employees: [{ id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" }],
  });
  await runCredentialGate({
    argv: ["--apply"],
    env: applyEnv(),
    masked: applyMasked(),
    fb: plainWorld.fb,
    client: plainWorld.client,
    liveFingerprint: FINGERPRINT,
  });
  const stored = plainWorld.creds.get("e-hash").password_hash;
  assert.notEqual(stored, "4826");
  assert.equal(isHashed(stored), true);
  assert.equal((await verifyPassword("4826", stored)).ok, true);
});

test("destination conflict plus a missing row fails closed with zero inserts", async () => {
  const existing = await hashPassword("1111");
  const incoming = await hashPassword("9999");
  const world = createWorld({
    fbTree: {
      rest_1: {
        waiter_hash: { password: incoming },
        waiter_enc: { passwordEnc: "enc-cipher" },
      },
    },
    employees: [
      { id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" },
      { id: "e-enc", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_enc" },
    ],
    credentials: [
      { employee_id: "e-hash", password_hash: existing, password_enc: "old-enc", updated_at: 7 },
    ],
  });
  const dry = await runCredentialGate({
    argv: [],
    env: applyEnv(),
    masked: applyMasked(),
    fb: world.fb,
    client: world.client,
    liveFingerprint: FINGERPRINT,
  });
  assert.equal(dry.destinationConflicts.length, 1);
  assert.equal(dry.destinationConflicts[0].userId, "waiter_hash");
  assert.equal(dry.expectedInserts, 1);

  await assert.rejects(
    () => runCredentialGate({
      argv: ["--apply"],
      env: applyEnv(),
      masked: applyMasked(),
      fb: world.fb,
      client: world.client,
      liveFingerprint: FINGERPRINT,
    }),
    (err) => publicErrorCode(err) === GATE_ERROR.DESTINATION_CONFLICT,
  );
  assert.equal(world.creds.size, 1);
  assert.equal(world.creds.get("e-hash").password_hash, existing);
  assert.equal(world.creds.has("e-enc"), false);
  assert.equal(world.mutating.includes("INSERT"), false);
  assert.equal(world.mutating.includes("COMMIT"), false);
  assert.equal(world.mutating.includes("ROLLBACK"), true);
  assert.doesNotMatch(JSON.stringify(dry.destinationConflicts), /\$2[aby]\$/);
});

test("apply is idempotent on replay and does not bump updated_at", async () => {
  const hash = await hashPassword("4826");
  const world = createWorld({
    fbTree: { rest_1: { waiter_hash: { password: hash } } },
    employees: [{ id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" }],
  });
  const first = await runCredentialGate({
    argv: ["--apply"], env: applyEnv(), masked: applyMasked(), fb: world.fb, client: world.client, liveFingerprint: FINGERPRINT,
  });
  const updatedAt = world.creds.get("e-hash").updated_at;
  const second = await runCredentialGate({
    argv: ["--apply"], env: applyEnv(), masked: applyMasked(), fb: world.fb, client: world.client, liveFingerprint: FINGERPRINT,
  });
  assert.equal(first.applied.inserted, 1);
  assert.equal(second.applied.unchanged, 1);
  assert.equal(second.applied.inserted, 0);
  assert.equal(world.creds.get("e-hash").updated_at, updatedAt);
});

test("incompatible hash blocks apply", async () => {
  const hash = await hashPassword("4826");
  const world = createWorld({
    fbTree: defaultTree(hash, { waiter_bad: { password: "$argon2id$v=19$m=8,t=1,p=1$abc" } }),
    employees: [
      { id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" },
      { id: "e-enc", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_enc" },
      { id: "e-both", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_both" },
      { id: "e-missing", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_missing" },
      { id: "e-bad", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_bad" },
    ],
  });
  await assert.rejects(
    () => runCredentialGate({
      argv: ["--apply"], env: applyEnv(), masked: applyMasked(), fb: world.fb, client: world.client, liveFingerprint: FINGERPRINT,
    }),
    (err) => publicErrorCode(err) === GATE_ERROR.HASH_FORMAT_UNSUPPORTED,
  );
  assert.equal(world.creds.size, 0);
  assert.equal(world.mutating.includes("COMMIT"), false);
});

test("bcrypt cost 00 and uppercase SHA are not copied", async () => {
  const cost00 = `$2a$00$${BCRYPT_TAIL}`;
  const upper = "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855";
  for (const password of [cost00, upper]) {
    const world = createWorld({
      fbTree: { rest_1: { waiter_hash: { password } } },
      employees: [{ id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" }],
    });
    await assert.rejects(
      () => runCredentialGate({
        argv: ["--apply"], env: applyEnv(), masked: applyMasked(), fb: world.fb, client: world.client, liveFingerprint: FINGERPRINT,
      }),
      (err) => publicErrorCode(err) === GATE_ERROR.HASH_FORMAT_UNSUPPORTED,
    );
    assert.equal(world.creds.size, 0);
  }
});

test("legacy SHA is classified REQUIRES_RESET and is not copied into PostgreSQL", async () => {
  const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const bcrypt = await hashPassword("4826");
  const world = createWorld({
    fbTree: { rest_1: { waiter_hash: { password: bcrypt }, waiter_sha: { password: sha } } },
    employees: [
      { id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" },
      { id: "e-sha", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_sha" },
    ],
  });
  const report = await runCredentialGate({
    argv: ["--apply"], env: applyEnv(), masked: applyMasked(), fb: world.fb, client: world.client, liveFingerprint: FINGERPRINT,
  });
  assert.equal(world.creds.has("e-sha"), false);
  assert.equal(report.legacyShaRequiresReset.some((row) => row.userId === "waiter_sha"), true);
});

test("unsafe source ID fails report validation before COMMIT and rolls back writes", async () => {
  const hash = await hashPassword("4826");
  const world = createWorld({
    fbTree: { rest_1: { "user@evil": { password: hash } } },
    restaurants: [{ id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "rest_1", name: "Cafe", status: "active", domain: "x" }],
    employees: [{ id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "user@evil" }],
  });
  await assert.rejects(
    () => runCredentialGate({
      argv: ["--apply"], env: applyEnv(), masked: applyMasked(), fb: world.fb, client: world.client, liveFingerprint: FINGERPRINT,
    }),
    (err) => publicErrorCode(err) === GATE_ERROR.SECRET_OUTPUT_REJECTED,
  );
  assert.equal(world.mutating.includes("COMMIT"), false);
  assert.equal(world.mutating.includes("ROLLBACK"), true);
  assert.equal(world.creds.size, 0);
  assert.ok(world.mutating.includes("INSERT"));
  const applyFn = gateSrc.slice(gateSrc.indexOf("export async function applyCredentialCopy"), gateSrc.indexOf("export async function loadTerminalAttempt"));
  assert.ok(applyFn.indexOf("validateCredentialGateReport") < applyFn.indexOf('await client.query("COMMIT")'));
});

test("injected reconciliation fingerprint mismatch rolls back inserted rows", async () => {
  const hash = await hashPassword("4826");
  const world = createWorld({
    fbTree: { rest_1: { waiter_hash: { password: hash } } },
    employees: [{ id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" }],
  });
  const originalQuery = world.client.query.bind(world.client);
  let inserts = 0;
  world.client.query = async (sql, params) => {
    const result = await originalQuery(sql, params);
    if (normalizeSql(sql).startsWith("INSERT INTO employee_credentials")) {
      inserts += 1;
      world.mutateProtectedNonId();
    }
    return result;
  };
  await assert.rejects(
    () => runCredentialGate({
      argv: ["--apply"], env: applyEnv(), masked: applyMasked(), fb: world.fb, client: world.client, liveFingerprint: FINGERPRINT,
    }),
    (err) => publicErrorCode(err) === GATE_ERROR.RECONCILIATION_FAILED,
  );
  assert.ok(inserts > 0);
  assert.equal(world.creds.size, 0);
  assert.equal(world.mutating.includes("COMMIT"), false);
  assert.equal(world.mutating.includes("ROLLBACK"), true);
});

test("apply refuses when main migration is not FULL_COMPLETE", async () => {
  const hash = await hashPassword("4826");
  const world = createWorld({
    fbTree: { rest_1: { waiter_hash: { password: hash } } },
    employees: [{ id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" }],
    attempts: [{
      attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "WAVE1_COMPLETE",
      phase: "full-after-wave1",
      target_fingerprint: FINGERPRINT,
      firebase_project: "restoran-30d51",
    }],
  });
  await assert.rejects(
    () => runCredentialGate({
      argv: ["--apply"], env: applyEnv(), masked: applyMasked(), fb: world.fb, client: world.client, liveFingerprint: FINGERPRINT,
    }),
    (err) => publicErrorCode(err) === GATE_ERROR.ATTEMPT_NOT_TERMINAL,
  );
  assert.equal(world.mutating.includes("INSERT"), false);
  assert.equal(world.mutating.includes("COMMIT"), false);
});

test("connected PostgreSQL fingerprint mismatch is refused", async () => {
  const hash = await hashPassword("4826");
  const world = createWorld({
    fbTree: { rest_1: { waiter_hash: { password: hash } } },
    employees: [{ id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" }],
  });
  await assert.rejects(
    () => runCredentialGate({
      argv: ["--apply"], env: applyEnv(), masked: applyMasked(), fb: world.fb, client: world.client, liveFingerprint: "ab".repeat(32),
    }),
    (err) => publicErrorCode(err) === GATE_ERROR.TARGET_FINGERPRINT_MISMATCH,
  );
  assert.equal(world.mutating.includes("INSERT"), false);
});

test("Firebase write methods are never invoked and CLI does not print err.message", async () => {
  const hash = await hashPassword("4826");
  const world = createWorld({
    fbTree: { rest_1: { waiter_hash: { password: hash } } },
    employees: [{ id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" }],
  });
  const report = await runCredentialGate({
    argv: ["--apply"], env: applyEnv(), masked: applyMasked(), fb: world.fb, client: world.client, liveFingerprint: FINGERPRINT,
  });
  assert.deepEqual(world.fbWrites, []);
  assert.doesNotMatch(JSON.stringify(report), /"password_hash"/);
  assert.doesNotMatch(cliSrc, /err\.message/);
});

test("apply SQL control flow uses BEGIN, writes, reconcile, report validation, fingerprint, COMMIT", () => {
  const applyFn = gateSrc.slice(gateSrc.indexOf("export async function applyCredentialCopy"), gateSrc.indexOf("export async function loadTerminalAttempt"));
  assert.match(applyFn, /BEGIN/);
  assert.match(applyFn, /boundedCredentialRollback/);
  assert.ok(applyFn.indexOf("DESTINATION_CONFLICT") < applyFn.indexOf("CREDENTIAL_INSERT_SQL"));
  assert.ok(applyFn.indexOf("reconcileDestinationState") < applyFn.indexOf("validateCredentialGateReport"));
  assert.ok(applyFn.indexOf("validateCredentialGateReport") < applyFn.lastIndexOf("captureProtectedFingerprint"));
  assert.ok(applyFn.lastIndexOf("captureProtectedFingerprint") < applyFn.indexOf('await client.query("COMMIT")'));
  assert.match(gateSrc, /SET LOCAL ROLE NONE/);
  assert.match(gateSrc, /withLoginReader/);
  assert.match(gateSrc, /withRevealer/);
  assert.doesNotMatch(gateSrc, /ON CONFLICT|COALESCE\(EXCLUDED|pg_stat_user_tables|BYPASSRLS|DISABLE ROW LEVEL SECURITY|GRANT\s+ALL|SET ROLE postgres/);
  const mainSrc = cliSrc.slice(cliSrc.indexOf("export async function main"));
  function requireIdx(src, fragment) {
    const idx = src.indexOf(fragment);
    assert.notEqual(idx, -1, fragment);
    return idx;
  }
  const firebaseSrcIdx = requireIdx(mainSrc, "assertFirebaseProductionSource");
  const initIdx = requireIdx(mainSrc, "initFirebase");
  const staticIdx = requireIdx(mainSrc, "assertProductionStaticBeforeConnect");
  const availableIdx = requireIdx(mainSrc, "available()");
  const collectIdx = requireIdx(mainSrc, "collectPgTargetIdentity");
  const compareIdx = requireIdx(mainSrc, "identity.fingerprint !== env[CREDENTIAL_TARGET_FINGERPRINT_ENV]");
  const planIdx = requireIdx(mainSrc, "runCredentialGate");
  const wrapIdx = requireIdx(mainSrc, "runCredentialCliSession");
  assert.ok(firebaseSrcIdx < initIdx);
  assert.ok(staticIdx < availableIdx);
  assert.ok(collectIdx < compareIdx);
  assert.ok(compareIdx < initIdx);
  assert.ok(compareIdx < planIdx);
  assert.ok(wrapIdx < collectIdx);
  assert.match(mainSrc, /runCredentialCliSession\(pool,/);
  const initBeforeCompare = mainSrc.replace("initFirebase();", "/* moved */")
    .replace("if (identity.fingerprint !== env[CREDENTIAL_TARGET_FINGERPRINT_ENV]) {", "initFirebase();\n    if (identity.fingerprint !== env[CREDENTIAL_TARGET_FINGERPRINT_ENV]) {");
  assert.throws(() => {
    const movedInit = requireIdx(initBeforeCompare, "initFirebase");
    const movedCompare = requireIdx(initBeforeCompare, "identity.fingerprint !== env[CREDENTIAL_TARGET_FINGERPRINT_ENV]");
    assert.ok(movedCompare < movedInit);
  });
  const noCompare = mainSrc.replace("identity.fingerprint !== env[CREDENTIAL_TARGET_FINGERPRINT_ENV]", "false");
  assert.throws(() => {
    requireIdx(noCompare, "identity.fingerprint !== env[CREDENTIAL_TARGET_FINGERPRINT_ENV]");
  });
});

test("step2b local credentials script guards remain intact and are not described as production-impossible", () => {
  assert.match(step2bSrc, /enforceConnectedApplyTarget/);
  assert.match(step2bSrc, /Firebase: GET only/);
  assert.match(step2bSrc, /NESTA_MIGRATE_TARGET=production/);
});

test("secret SELECT error still issues outer ROLLBACK after aborted-transaction role restore failure", async () => {
  const world = createWorld({
    fbTree: { rest_1: { waiter_hash: { password: "4826" } } },
    employees: [{ id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" }],
    abortOnHashSelect: true,
  });
  await world.client.query("BEGIN");
  await assert.rejects(
    () => withLoginReader(world.client, () => world.client.query(EXISTING_HASH_SQL)),
    (err) => err.code === "XX000",
  );
  const restoreAttempted = world.statements.some((sql) => sql === normalizeSql(SET_ROLE_APP_SQL));
  assert.equal(restoreAttempted, true);
  await world.client.query("ROLLBACK");
  assert.equal(world.mutating.includes("ROLLBACK"), true);
  assert.equal(world.currentUser(), SESSION_USER);

  const applyWorld = createWorld({
    fbTree: { rest_1: { waiter_hash: { password: "4826" } } },
    employees: [{ id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" }],
    abortOnHashSelect: true,
  });
  await assert.rejects(
    () => runCredentialGate({
      argv: ["--apply"], env: applyEnv(), masked: applyMasked(), fb: applyWorld.fb, client: applyWorld.client, liveFingerprint: FINGERPRINT,
    }),
  );
  assert.equal(applyWorld.mutating.includes("ROLLBACK"), true);
  assert.equal(applyWorld.mutating.includes("COMMIT"), false);
  assert.equal(applyWorld.creds.size, 0);
  assert.equal(applyWorld.currentUser(), SESSION_USER);
  assert.match(gateSrc, /restoreAppRole/);
  assert.doesNotMatch(gateSrc, /restoreAppRoleBestEffort/);
});

test("0001 grants the SET ROLE chain without reader/revealer escalation", () => {
  const mig = readFileSync(path.join(here, "../migrations/0001_wave0_core.up.sql"), "utf8");
  assert.match(mig, /CREATE ROLE nesta_login_reader NOLOGIN/);
  assert.match(mig, /CREATE ROLE nesta_credential_revealer NOLOGIN/);
  assert.match(mig, /GRANT nesta_login_reader TO nesta_app WITH INHERIT FALSE/);
  assert.match(mig, /GRANT nesta_credential_revealer TO nesta_app WITH INHERIT FALSE/);
  assert.match(mig, /GRANT nesta_app TO CURRENT_USER/);
  assert.doesNotMatch(mig, /GRANT nesta_app TO nesta_login_reader/);
  assert.doesNotMatch(mig, /GRANT nesta_app TO nesta_credential_revealer/);
  assert.doesNotMatch(mig, /GRANT postgres TO nesta_app|BYPASSRLS|DISABLE ROW LEVEL SECURITY/i);
});

test("remote PostgreSQL URL is refused before any connection helper runs", () => {
  let called = 0;
  assert.throws(
    () => connectOnlyAfterLoopbackAccepted(
      { POSTGRES_URL: "postgres://u@example.invalid:5432/db" },
      () => { called += 1; return "connected"; },
    ),
    (err) => err instanceof AcceptanceTargetError && err.code === ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED,
  );
  assert.equal(called, 0);
  assert.equal(inspectPgTargetFromEnv({ POSTGRES_URL: "postgres://u@example.invalid:5432/db" }).remote, true);
  assert.equal(inspectPgTargetFromEnv({ POSTGRES_HOST: "127.0.0.1", POSTGRES_DB: "db", POSTGRES_USER: "u" }).loopback, true);
});

test("REQUIRE_DB=1 dispositions fail instead of skip", () => {
  const remote = { remote: true, configured: true, loopback: false };
  assert.equal(acceptanceDisposition({ target: remote, requireDb: false }).action, "fail");
  assert.equal(acceptanceDisposition({ target: remote, requireDb: true }).code, ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED);
  assert.equal(acceptanceDisposition({ target: { configured: false, remote: false, loopback: false }, requireDb: false }).action, "skip");
  assert.equal(acceptanceDisposition({ target: { configured: false, remote: false, loopback: false }, requireDb: true }).action, "fail");
  assert.equal(acceptanceDisposition({ target: { configured: true, loopback: true, remote: false }, requireDb: true, connected: false }).action, "fail");
  assert.equal(acceptanceDisposition({ target: { configured: true, loopback: true, remote: false }, requireDb: false, connected: false }).action, "skip");
  assert.equal(acceptanceDisposition({ target: { configured: true, loopback: true, remote: false }, requireDb: true, createdDb: false }).action, "fail");
  assert.equal(acceptanceDisposition({ target: { configured: true, loopback: true, remote: false }, requireDb: false, createdDb: false }).action, "skip");
});

test("production role preflight rejects session superuser, is read-only, and never DML", async () => {
  const preflightSrc = readFileSync(path.join(here, "../scripts/lib/credentialRolePreflight.mjs"), "utf8");
  const prodFn = preflightSrc.slice(
    preflightSrc.indexOf("export async function runProductionCredentialRolePreflight"),
    preflightSrc.indexOf("export async function runLocalCredentialRolePreflight"),
  );
  assert.match(prodFn, /BEGIN READ ONLY/);
  assert.match(prodFn, /finishCredentialRollback/);
  assert.match(prodFn, /SESSION_SUPERUSER_REJECTED/);
  assert.doesNotMatch(prodFn, /INSERT INTO|UPDATE |DELETE FROM|CREATE |DROP |ALTER /i);
  const cliSrcProd = readFileSync(path.join(here, "../scripts/production-credential-role-preflight.mjs"), "utf8");
  assert.match(cliSrcProd, /BEGIN READ ONLY|runProductionCredentialRolePreflight/);
  assert.doesNotMatch(cliSrcProd, /INSERT INTO employee_credentials/);

  const statements = [];
  const client = {
    async query(sql) {
      const text = normalizeSql(sql);
      statements.push(text);
      if (/INSERT INTO|UPDATE |DELETE FROM/i.test(text)) throw new Error("DML_FORBIDDEN");
      if (text.includes("rolsuper") || text.includes("session_is_superuser")) {
        return { rows: [{
          current_user: "postgres",
          session_user: "postgres",
          session_is_superuser: true,
          session_member_nesta_app: true,
          app_member_login_reader: true,
          app_member_revealer: true,
          reader_member_app: false,
          revealer_member_app: false,
        }] };
      }
      if (text.includes("relforcerowsecurity")) return { rows: [{ rls: true, force_rls: true }] };
      return { rows: [] };
    },
  };
  const result = await runProductionCredentialRolePreflight({
    client,
    env: applyEnv(),
    masked: applyMasked(),
    liveFingerprint: FINGERPRINT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, ROLE_PREFLIGHT_CODE.SESSION_SUPERUSER_REJECTED);
  assert.equal(statements[0], "BEGIN READ ONLY");
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(statements.some((sql) => /INSERT INTO/i.test(sql)), false);
});

test("SELECT success plus restore 42501 fails closed with ROLLBACK", async () => {
  const world = createWorld({
    fbTree: { rest_1: { waiter_hash: { password: "4826" } } },
    employees: [{ id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" }],
    restoreFailCode: "42501",
  });
  await world.client.query("BEGIN");
  await assert.rejects(
    () => withLoginReader(world.client, () => world.client.query(EXISTING_HASH_SQL)),
    (err) => err.code === "42501",
  );
  await world.client.query("ROLLBACK");
  assert.equal(world.mutating.includes("ROLLBACK"), true);
});

test("restore error other than 25P02 after SELECT failure is not swallowed", async () => {
  const world = createWorld({
    fbTree: { rest_1: { waiter_hash: { password: "4826" } } },
    employees: [{ id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" }],
    abortOnHashSelect: true,
    restoreFailCode: "XX001",
  });
  await world.client.query("BEGIN");
  await assert.rejects(
    () => withLoginReader(world.client, () => world.client.query(EXISTING_HASH_SQL)),
    (err) => err.code === "XX001",
  );
  await world.client.query("ROLLBACK");
});

test("successful secret read restores nesta_app", async () => {
  const world = createWorld({ fbTree: { rest_1: {} } });
  await world.client.query("BEGIN");
  await withLoginReader(world.client, () => world.client.query(EXISTING_HASH_SQL));
  assert.equal(world.currentUser(), "nesta_app");
  await world.client.query("ROLLBACK");
});

test("dry-run binds connected fingerprint before any Firebase or credential plan", async () => {
  const hash = await hashPassword("4826");
  const world = createWorld({
    fbTree: { rest_1: { waiter_hash: { password: hash } } },
    employees: [{ id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" }],
  });
  let reads = 0;
  const fb = {
    ...world.fb,
    async shallowKeys(p) {
      reads += 1;
      return world.fb.shallowKeys(p);
    },
  };
  await assert.rejects(
    () => runCredentialGate({
      argv: [],
      env: applyEnv(),
      masked: applyMasked(),
      fb,
      client: world.client,
      liveFingerprint: "ab".repeat(32),
    }),
    (err) => publicErrorCode(err) === GATE_ERROR.TARGET_FINGERPRINT_MISMATCH,
  );
  assert.equal(reads, 0);
  assert.equal(world.mutating.includes("INSERT"), false);
  assert.equal(world.statements.some((sql) => sql.startsWith("UPDATE ")), false);

  const ok = await runCredentialGate({
    argv: [],
    env: applyEnv(),
    masked: applyMasked(),
    fb,
    client: world.client,
    liveFingerprint: FINGERPRINT,
  });
  assert.equal(ok.mode, "dry-run");
  assert.equal(ok.writes, 0);
  assert.ok(reads > 0);
  assert.equal(world.mutating.includes("BEGIN READ ONLY"), true);
  assert.equal(world.mutating.includes("COMMIT"), false);
});

test("dry-run fails closed when terminal attempt is bound to a different fingerprint", async () => {
  const world = createWorld({
    fbTree: { rest_1: { waiter_hash: { password: "4826" } } },
    employees: [{ id: "e-hash", restaurant_id: "11111111-1111-1111-1111-111111111111", legacy_rtdb_id: "waiter_hash" }],
    attempts: [{
      attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "FULL_COMPLETE",
      phase: "full-after-wave1",
      target_fingerprint: "cd".repeat(32),
      firebase_project: "restoran-30d51",
    }],
  });
  await assert.rejects(
    () => runCredentialGate({
      argv: [],
      env: applyEnv(),
      masked: applyMasked(),
      fb: world.fb,
      client: world.client,
      liveFingerprint: FINGERPRINT,
    }),
    (err) => publicErrorCode(err) === GATE_ERROR.ATTEMPT_NOT_TERMINAL,
  );
  assert.equal(world.mutating.includes("INSERT"), false);
});

test("negative probes require SQLSTATE 42501 and SAVEPOINT recovery", async () => {
  const preflightSrc = readFileSync(path.join(here, "../scripts/lib/credentialRolePreflight.mjs"), "utf8");
  assert.match(preflightSrc, /ROLLBACK TO SAVEPOINT/);
  assert.match(preflightSrc, /SQLSTATE_DENIED = "42501"/);
  assert.doesNotMatch(
    preflightSrc.slice(preflightSrc.indexOf("export async function probeDenied42501"), preflightSrc.indexOf("async function probeAllowed")),
    /25P02 === SQLSTATE_DENIED/,
  );
  const statements = [];
  let aborted = false;
  const client = {
    async query(sql) {
      const text = normalizeSql(sql);
      statements.push(text);
      if (text.startsWith("SAVEPOINT")) return { rows: [] };
      if (text.startsWith("ROLLBACK TO SAVEPOINT")) {
        aborted = false;
        return { rows: [] };
      }
      if (text.startsWith("RELEASE SAVEPOINT")) return { rows: [] };
      if (aborted) {
        const err = new Error("aborted");
        err.code = "25P02";
        throw err;
      }
      if (text.includes("FROM production_migration_attempts")) {
        aborted = true;
        const err = new Error("denied");
        err.code = "42501";
        throw err;
      }
      throw new Error(`unhandled ${text}`);
    },
  };
  const denied = await probeDenied42501(client, "SELECT attempt_id FROM production_migration_attempts LIMIT 0");
  assert.equal(denied.denied, true);
  assert.equal(denied.sqlstate, "42501");
  aborted = false;
  await client.query("SAVEPOINT later");
  assert.equal(statements.some((s) => s.startsWith("ROLLBACK TO SAVEPOINT")), true);
});

test("only exact SQLSTATE 42501 is expected permission denial", async () => {
  const preflightSrc = readFileSync(path.join(here, "../scripts/lib/credentialRolePreflight.mjs"), "utf8");
  const deniedFn = preflightSrc.slice(
    preflightSrc.indexOf("export async function probeDenied42501"),
    preflightSrc.indexOf("async function probeAllowed"),
  );
  assert.match(deniedFn, /isExpectedPermissionDenied\(code\)/);
  const mutated = deniedFn.replace("if (!isExpectedPermissionDenied(code)) throw err;", "");
  assert.throws(() => {
    assert.match(mutated, /isExpectedPermissionDenied\(code\)/);
  });
  assert.equal(isExpectedPermissionDenied("42501"), true);
  assert.equal(isExpectedPermissionDenied("25P02"), false);
  assert.equal(isExpectedPermissionDenied("23505"), false);
  assert.equal(isExpectedPermissionDenied("42P01"), false);
  assert.equal(isExpectedPermissionDenied("UNKNOWN"), false);
  assert.equal(isExpectedPermissionDenied(""), false);

  async function probeCode(code) {
    const client = {
      async query(sql) {
        const text = String(sql);
        if (text.startsWith("SAVEPOINT") || text.startsWith("ROLLBACK TO SAVEPOINT") || text.startsWith("RELEASE SAVEPOINT")) {
          return { rows: [] };
        }
        const err = new Error("probe");
        if (code) err.code = code;
        throw err;
      },
    };
    return probeDenied42501(client, "SELECT 1");
  }
  const denied = await probeCode("42501");
  assert.equal(denied.denied, true);
  assert.equal(denied.sqlstate, "42501");
  await assert.rejects(() => probeCode("25P02"), (err) => err.code === "25P02");
  await assert.rejects(() => probeCode("23505"), (err) => err.code === "23505");
  await assert.rejects(() => probeCode("42P01"), (err) => err.code === "42P01");
  await assert.rejects(() => probeCode(undefined), (err) => !err.code || err.code !== "42501");
});

test("nesta_app bookkeeping denial leaves the transaction usable for later probes", async () => {
  const statements = [];
  let aborted = false;
  let role = "session";
  const client = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      statements.push(text);
      if (text.startsWith("SAVEPOINT")) return { rows: [] };
      if (text.startsWith("ROLLBACK TO SAVEPOINT")) {
        aborted = false;
        return { rows: [] };
      }
      if (text.startsWith("RELEASE SAVEPOINT")) return { rows: [] };
      if (aborted) {
        const err = new Error("aborted");
        err.code = "25P02";
        throw err;
      }
      if (text.startsWith("SET LOCAL ROLE")) {
        if (text.includes("nesta_login_reader")) role = "nesta_login_reader";
        else if (text.includes("nesta_credential_revealer")) role = "nesta_credential_revealer";
        else if (text.includes("nesta_app")) role = "nesta_app";
        else role = "session";
        return { rows: [] };
      }
      if (text.includes("FROM production_migration_attempts") && role === "nesta_app") {
        aborted = true;
        const err = new Error("denied");
        err.code = "42501";
        throw err;
      }
      if (text.includes("password_hash") && role === "nesta_login_reader") return { rows: [{ employee_id: "e", password_hash: "x" }] };
      if (text.includes("password_enc") && role === "nesta_credential_revealer") return { rows: [{ employee_id: "e", password_enc: "y" }] };
      return { rows: [] };
    },
  };
  await client.query("SET LOCAL ROLE nesta_app");
  const denied = await probeDenied42501(client, "SELECT attempt_id FROM production_migration_attempts LIMIT 0");
  assert.equal(denied.denied, true);
  assert.equal(denied.sqlstate, "42501");
  await client.query("SET LOCAL ROLE nesta_login_reader");
  const hash = await client.query("SELECT employee_id, password_hash FROM employee_credentials LIMIT 0");
  assert.equal(hash.rows.length, 1);
  await client.query("SET LOCAL ROLE nesta_credential_revealer");
  const enc = await client.query("SELECT employee_id, password_enc FROM employee_credentials LIMIT 0");
  assert.equal(enc.rows.length, 1);
  await client.query("SELECT version FROM schema_migrations LIMIT 0");
});

test("cleanup failure after success is ACCEPTANCE_CLEANUP_FAILED", () => {
  assert.throws(
    () => finalizeAcceptanceCleanup({ cleanupFailed: true }),
    (err) => err instanceof AcceptanceTargetError && err.code === ACCEPTANCE_ERROR.ACCEPTANCE_CLEANUP_FAILED,
  );
  const primary = new Error("primary");
  primary.code = "ROLE_PREFLIGHT_FAILED";
  assert.throws(
    () => finalizeAcceptanceCleanup({ primaryError: primary, cleanupFailed: true }),
    (err) => err === primary && err.cleanupCode === ACCEPTANCE_ERROR.ACCEPTANCE_CLEANUP_FAILED,
  );
  assert.doesNotThrow(() => finalizeAcceptanceCleanup({ cleanupFailed: false }));
});

test("unsafe effective host is classified before pool construction", () => {
  let pools = 0;
  assert.throws(
    () => assertProductionStaticBeforeConnect({
      POSTGRES_URL: "postgres://u@db.example.invalid/railway?host=127.0.0.1",
      NESTA_MIGRATE_TARGET: "production",
      POSTGRES_SSL: "true",
      [CREDENTIAL_TARGET_FINGERPRINT_ENV]: FINGERPRINT,
    }),
  );
  assert.equal(pools, 0);
  assert.throws(
    () => assertProductionStaticBeforeConnect({
      POSTGRES_URL: "postgres://u@127.0.0.1/railway",
      NESTA_MIGRATE_TARGET: "production",
      POSTGRES_SSL: "true",
      [CREDENTIAL_TARGET_FINGERPRINT_ENV]: FINGERPRINT,
    }),
  );
});

test("dry-run gate fails closed when final rollback rejects after successful worker", async () => {
  const hash = await hashPassword("4826");
  const world = createWorld({ fbTree: defaultTree(hash) });
  const orig = world.client.query.bind(world.client);
  world.client.query = async (sql, params = []) => {
    const text = normalizeSql(sql);
    if (text === "ROLLBACK") {
      return Promise.reject(new Error("rollback boom secret://x"));
    }
    return orig(sql, params);
  };
  await assert.rejects(
    () => runCredentialGate({
      argv: [],
      env: applyEnv(),
      masked: applyMasked(),
      fb: world.fb,
      client: world.client,
      liveFingerprint: FINGERPRINT,
    }),
    (err) => {
      assert.equal(err.code, GATE_ERROR.PG_ROLLBACK_FAILED);
      assert.equal(err.cleanupCode, GATE_ERROR.PG_ROLLBACK_FAILED);
      assert.equal(String(err.message || "").includes("secret://"), false);
      return true;
    },
  );
  assert.equal(world.mutating.includes("COMMIT"), false);
});

test("dry-run preserves worker SQLSTATE 42P01 when rollback rejects", async () => {
  const world = createWorld({ fbTree: {}, employees: [] });
  const orig = world.client.query.bind(world.client);
  world.client.query = async (sql, params = []) => {
    const text = normalizeSql(sql);
    if (text === "ROLLBACK") {
      return Promise.reject(new Error("rollback boom"));
    }
    if (/\bFROM\s+restaurants\b/i.test(text)) {
      const err = new Error("relation missing");
      err.code = "42P01";
      throw err;
    }
    return orig(sql, params);
  };
  await assert.rejects(
    () => runCredentialGate({
      argv: [],
      env: applyEnv(),
      masked: applyMasked(),
      fb: world.fb,
      client: world.client,
      liveFingerprint: FINGERPRINT,
    }),
    (err) => {
      assert.equal(err.code, "42P01");
      assert.equal(err.cleanupCode, GATE_ERROR.PG_ROLLBACK_FAILED);
      assert.notEqual(publicErrorCode(err), GATE_ERROR.RECONCILIATION_FAILED);
      return true;
    },
  );
});

test("dry-run preserves worker SQLSTATE 42P01 when rollback times out", async () => {
  const world = createWorld({ fbTree: {}, employees: [] });
  const orig = world.client.query.bind(world.client);
  world.client.query = async (sql, params = []) => {
    const text = normalizeSql(sql);
    if (text === "ROLLBACK") return new Promise(() => {});
    if (/\bFROM\s+restaurants\b/i.test(text)) {
      const err = new Error("relation missing");
      err.code = "42P01";
      throw err;
    }
    return orig(sql, params);
  };
  await assert.rejects(
    () => Promise.race([
      runCredentialGate({
        argv: [],
        env: applyEnv(),
        masked: applyMasked(),
        fb: world.fb,
        client: world.client,
        liveFingerprint: FINGERPRINT,
      }),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("WATCHDOG"), { code: "WATCHDOG" })), 4000)),
    ]),
    (err) => {
      assert.notEqual(err.code, "WATCHDOG");
      assert.equal(err.code, "42P01");
      assert.equal(err.cleanupCode, GATE_ERROR.PG_CLEANUP_TIMEOUT);
      return true;
    },
  );
});

test("dry-run preserves worker SQLSTATE 42P01 when rollback succeeds", async () => {
  const world = createWorld({ fbTree: {}, employees: [] });
  const orig = world.client.query.bind(world.client);
  world.client.query = async (sql, params = []) => {
    const text = normalizeSql(sql);
    if (/\bFROM\s+restaurants\b/i.test(text)) {
      const err = new Error("relation missing");
      err.code = "42P01";
      throw err;
    }
    return orig(sql, params);
  };
  await assert.rejects(
    () => runCredentialGate({
      argv: [],
      env: applyEnv(),
      masked: applyMasked(),
      fb: world.fb,
      client: world.client,
      liveFingerprint: FINGERPRINT,
    }),
    (err) => {
      assert.equal(err.code, "42P01");
      assert.equal(err.cleanupCode, undefined);
      assert.notEqual(err.code, GATE_ERROR.RECONCILIATION_FAILED);
      return true;
    },
  );
});

test("wrapCaught preserves SQLSTATE/driver codes and maps unsafe Error to PG_QUERY_FAILED not RECONCILIATION_FAILED", () => {
  const wrapSrc = gateSrc.slice(gateSrc.indexOf("function wrapCaught"), gateSrc.indexOf("function throwAfterBoundedRollback"));
  assert.match(wrapSrc, /isPgSqlState\(err\.code\)/);
  assert.match(wrapSrc, /isSafeDriverCode\(err\.code\)/);
  assert.match(wrapSrc, /PG_QUERY_FAILED/);
  assert.doesNotMatch(wrapSrc, /RECONCILIATION_FAILED/);
  assert.doesNotMatch(wrapSrc, /err\.code\s*===\s*["']42501["']/);
  assert.match(gateSrc, /throwAfterBoundedRollback/);
  assert.match(gateSrc, /PG_ROLLBACK_FAILED/);
  assert.match(gateSrc, /gateFail\(GATE_ERROR\.RECONCILIATION_FAILED\)/);
  assertNoRawFullRollback(gateSrc);
  const mutated = gateSrc.replace(/await boundedCredentialRollback\(client\)/g, 'await client.query("ROLLBACK")');
  assert.throws(() => assertNoRawFullRollback(mutated));
});

test("dry-run preserves ECONNRESET when rollback succeeds", async () => {
  const world = createWorld({ fbTree: {}, employees: [] });
  const orig = world.client.query.bind(world.client);
  world.client.query = async (sql, params = []) => {
    const text = normalizeSql(sql);
    if (/\bFROM\s+restaurants\b/i.test(text)) {
      const err = new Error("read ECONNRESET secret://x");
      err.code = "ECONNRESET";
      throw err;
    }
    return orig(sql, params);
  };
  await assert.rejects(
    () => runCredentialGate({
      argv: [],
      env: applyEnv(),
      masked: applyMasked(),
      fb: world.fb,
      client: world.client,
      liveFingerprint: FINGERPRINT,
    }),
    (err) => {
      assert.equal(err.code, "ECONNRESET");
      assert.equal(err.cleanupCode, undefined);
      assert.notEqual(err.code, GATE_ERROR.RECONCILIATION_FAILED);
      assert.equal(String(err.message || "").includes("secret://"), false);
      return true;
    },
  );
});

test("dry-run preserves ECONNRESET when rollback rejects", async () => {
  const world = createWorld({ fbTree: {}, employees: [] });
  const orig = world.client.query.bind(world.client);
  world.client.query = async (sql, params = []) => {
    const text = normalizeSql(sql);
    if (text === "ROLLBACK") return Promise.reject(new Error("rollback boom"));
    if (/\bFROM\s+restaurants\b/i.test(text)) {
      const err = new Error("read ECONNRESET");
      err.code = "ECONNRESET";
      throw err;
    }
    return orig(sql, params);
  };
  await assert.rejects(
    () => runCredentialGate({
      argv: [],
      env: applyEnv(),
      masked: applyMasked(),
      fb: world.fb,
      client: world.client,
      liveFingerprint: FINGERPRINT,
    }),
    (err) => {
      assert.equal(err.code, "ECONNRESET");
      assert.equal(err.cleanupCode, GATE_ERROR.PG_ROLLBACK_FAILED);
      assert.notEqual(err.code, GATE_ERROR.RECONCILIATION_FAILED);
      return true;
    },
  );
});

test("dry-run preserves ECONNRESET when rollback times out", async () => {
  const world = createWorld({ fbTree: {}, employees: [] });
  const orig = world.client.query.bind(world.client);
  world.client.query = async (sql, params = []) => {
    const text = normalizeSql(sql);
    if (text === "ROLLBACK") return new Promise(() => {});
    if (/\bFROM\s+restaurants\b/i.test(text)) {
      const err = new Error("read ECONNRESET");
      err.code = "ECONNRESET";
      throw err;
    }
    return orig(sql, params);
  };
  await assert.rejects(
    () => Promise.race([
      runCredentialGate({
        argv: [],
        env: applyEnv(),
        masked: applyMasked(),
        fb: world.fb,
        client: world.client,
        liveFingerprint: FINGERPRINT,
      }),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("WATCHDOG"), { code: "WATCHDOG" })), 4000)),
    ]),
    (err) => {
      assert.notEqual(err.code, "WATCHDOG");
      assert.equal(err.code, "ECONNRESET");
      assert.equal(err.cleanupCode, GATE_ERROR.PG_CLEANUP_TIMEOUT);
      return true;
    },
  );
});

test("dry-run maps generic Error with secret text to PG_QUERY_FAILED", async () => {
  const world = createWorld({ fbTree: {}, employees: [] });
  const orig = world.client.query.bind(world.client);
  world.client.query = async (sql, params = []) => {
    const text = normalizeSql(sql);
    if (/\bFROM\s+restaurants\b/i.test(text)) {
      throw new Error("password=SECRET postgres://u:p@host/db");
    }
    return orig(sql, params);
  };
  await assert.rejects(
    () => runCredentialGate({
      argv: [],
      env: applyEnv(),
      masked: applyMasked(),
      fb: world.fb,
      client: world.client,
      liveFingerprint: FINGERPRINT,
    }),
    (err) => {
      assert.equal(err.code, GATE_ERROR.PG_QUERY_FAILED);
      assert.notEqual(err.code, GATE_ERROR.RECONCILIATION_FAILED);
      assert.equal(String(err.message || "").includes("SECRET"), false);
      assert.equal(String(err.message || "").includes("postgres://"), false);
      return true;
    },
  );
});

test("dry-run sync rollback throw after worker success is PG_ROLLBACK_FAILED", async () => {
  const hash = await hashPassword("4826");
  const world = createWorld({ fbTree: defaultTree(hash) });
  const orig = world.client.query.bind(world.client);
  world.client.query = (sql, params = []) => {
    const text = normalizeSql(sql);
    if (text === "ROLLBACK") {
      throw new Error("sync rollback secret://x");
    }
    return orig(sql, params);
  };
  await assert.rejects(
    () => runCredentialGate({
      argv: [],
      env: applyEnv(),
      masked: applyMasked(),
      fb: world.fb,
      client: world.client,
      liveFingerprint: FINGERPRINT,
    }),
    (err) => {
      assert.equal(err.code, GATE_ERROR.PG_ROLLBACK_FAILED);
      assert.equal(err.cleanupCode, GATE_ERROR.PG_ROLLBACK_FAILED);
      assert.equal(String(err.message || "").includes("secret://"), false);
      return true;
    },
  );
});

function assertNoRawFullRollback(src) {
  assert.doesNotMatch(src, /(?:await\s+)?(?:client|safeClient|owned)\.query\s*\(\s*[`'"]ROLLBACK[`'"]\s*\)/);
}
