// Production employee-credential copy gate (Firebase credentials/* -> PostgreSQL
// employee_credentials). Separate from step2b-credentials-local.mjs.
// Default: read-only dry-run. Apply writes only employee_credentials.
import { createHash } from "crypto";
import { isMaintenanceMode } from "../../../security/maintenance.js";
import { boundedCredentialRollback, throwIfCredentialCliFailed } from "../../postgres.js";
import { maskedEffectivePgConfig, inspectPgTargetFromEnv } from "./credentialAcceptanceTarget.mjs";
import {
  PROTECTED_CONTENT_FINGERPRINT_SQL as GENERATED_PROTECTED_FP_SQL,
  SESSION_PROTECTED_FINGERPRINT_SQL as GENERATED_SESSION_FP_SQL,
} from "./credentialProtectedFingerprint.mjs";
import { verifyPassword } from "../../../security/password.js";
import {
  FORBIDDEN_DB,
  MIGRATION_TARGET_DB,
  isLoopbackHost,
  isProductionMigrateTarget,
  sslConfigured,
} from "./migrationTargetGuard.mjs";
import { ATTEMPT_STATUS, MIGRATION_PHASE } from "./productionMigrationAttempt.mjs";
import { isTargetFingerprint } from "./pgTargetFingerprint.mjs";
import {
  classifyStoredPassword,
  isMalformedSource,
  materializeMigratableHash,
  sourceEncValue,
  sourceHashValue,
} from "./credentialHashCompatibility.mjs";

export const CREDENTIAL_APPLY_FLAG = "--apply";
export const CREDENTIAL_APPLY_CONFIRM_ENV = "NESTA_PRODUCTION_CREDENTIAL_MIGRATE_CONFIRM";
export const CREDENTIAL_APPLY_CONFIRM_PHRASE = "I_CONFIRM_PRODUCTION_EMPLOYEE_CREDENTIAL_COPY";
export const CREDENTIAL_MAINTENANCE_EVIDENCE_ENV = "NESTA_CREDENTIAL_MAINTENANCE_EVIDENCE";
export const CREDENTIAL_MAINTENANCE_EVIDENCE_PHRASE = "I_CONFIRM_NESTA_MAINTENANCE_MODE_IS_ON";
export const CREDENTIAL_TARGET_FINGERPRINT_ENV = "NESTA_PRODUCTION_PG_TARGET_FINGERPRINT";

export const APPROVED_FIREBASE_PROJECT_ID = "restoran-30d51";
export const APPROVED_RTDB_HOSTNAME = "restoran-30d51-default-rtdb.firebaseio.com";
export const APPROVED_RTDB_ORIGIN = "https://restoran-30d51-default-rtdb.firebaseio.com";
export const APPROVED_RTDB_URL = "https://restoran-30d51-default-rtdb.firebaseio.com";
export const CREDENTIAL_ACTOR_ROLE = "admin";

export const GATE_ERROR = Object.freeze({
  SOURCE_ORIGIN_INVALID: "SOURCE_ORIGIN_INVALID",
  SOURCE_PROJECT_INVALID: "SOURCE_PROJECT_INVALID",
  TARGET_FINGERPRINT_MISMATCH: "TARGET_FINGERPRINT_MISMATCH",
  HASH_FORMAT_UNSUPPORTED: "HASH_FORMAT_UNSUPPORTED",
  LEGACY_SHA_REQUIRES_RESET: "LEGACY_SHA_REQUIRES_RESET",
  DESTINATION_CONFLICT: "DESTINATION_CONFLICT",
  RLS_CONTEXT_INVALID: "RLS_CONTEXT_INVALID",
  RECONCILIATION_FAILED: "RECONCILIATION_FAILED",
  SECRET_OUTPUT_REJECTED: "SECRET_OUTPUT_REJECTED",
  APPLY_FLAG_REQUIRED: "APPLY_FLAG_REQUIRED",
  APPLY_CONFIRM_INVALID: "APPLY_CONFIRM_INVALID",
  MAINTENANCE_EVIDENCE_INVALID: "MAINTENANCE_EVIDENCE_INVALID",
  TARGET_NOT_PRODUCTION: "TARGET_NOT_PRODUCTION",
  ATTEMPT_NOT_TERMINAL: "ATTEMPT_NOT_TERMINAL",
  PG_NOT_CONFIGURED: "PG_NOT_CONFIGURED",
  PG_CHECKED_OUT_CLIENT_ERROR: "PG_CHECKED_OUT_CLIENT_ERROR",
  PG_CLIENT_RELEASE_FAILED: "PG_CLIENT_RELEASE_FAILED",
  PG_POOL_CLOSE_FAILED: "PG_POOL_CLOSE_FAILED",
  PG_CLEANUP_TIMEOUT: "PG_CLEANUP_TIMEOUT",
  PG_ROLLBACK_FAILED: "PG_ROLLBACK_FAILED",
  PG_QUERY_FAILED: "PG_QUERY_FAILED",
  GATE_FAILED: "GATE_FAILED",
});

/** Node-style driver/network codes safe to preserve as primary (never as RECONCILIATION_FAILED). */
const SAFE_DRIVER_CODES = Object.freeze(new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EPIPE",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ECONNABORTED",
]));

export class CredentialGateError extends Error {
  constructor(code) {
    const safe = GATE_ERROR[code] ? code : GATE_ERROR.GATE_FAILED;
    super(safe);
    this.name = "CredentialGateError";
    this.code = safe;
  }
}

export function fail(code) {
  throw new CredentialGateError(code);
}

export function publicErrorCode(err) {
  // Never expose raw Error text or stack. Only fixed allowlisted GATE_ERROR codes.
  const code = typeof err?.code === "string" ? err.code : GATE_ERROR.GATE_FAILED;
  if (Object.prototype.hasOwnProperty.call(GATE_ERROR, code)) return code;
  return GATE_ERROR.GATE_FAILED;
}

function isPgSqlState(code) {
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
}

function isSafeDriverCode(code) {
  return typeof code === "string" && SAFE_DRIVER_CODES.has(code);
}

function wrapCaught(err) {
  let wrapped;
  if (err instanceof CredentialGateError) wrapped = err;
  else if (err && err.name === "CredentialCliClientError") wrapped = err;
  else if (err && typeof err.code === "string" && Object.prototype.hasOwnProperty.call(GATE_ERROR, err.code)) wrapped = err;
  else if (err && isPgSqlState(err.code)) wrapped = err;
  else if (err && isSafeDriverCode(err.code)) {
    wrapped = new Error(err.code);
    wrapped.name = "CredentialGateDriverError";
    wrapped.code = err.code;
  } else {
    wrapped = new CredentialGateError(GATE_ERROR.PG_QUERY_FAILED);
  }
  if (err && err.cleanupCode && !wrapped.cleanupCode) wrapped.cleanupCode = err.cleanupCode;
  return wrapped;
}

function throwAfterBoundedRollback(rb, primaryErr) {
  if (primaryErr) {
    const wrapped = wrapCaught(primaryErr);
    if (!rb.ok) wrapped.cleanupCode = rb.code || GATE_ERROR.PG_ROLLBACK_FAILED;
    throw wrapped;
  }
  if (!rb.ok) {
    const code = rb.code || GATE_ERROR.PG_ROLLBACK_FAILED;
    const err = new CredentialGateError(GATE_ERROR[code] ? code : GATE_ERROR.GATE_FAILED);
    err.cleanupCode = code;
    throw err;
  }
}

export const SET_ROLE_APP_SQL = "SET LOCAL ROLE nesta_app";
export const SET_ROLE_LOGIN_READER_SQL = "SET LOCAL ROLE nesta_login_reader";
export const SET_ROLE_REVEALER_SQL = "SET LOCAL ROLE nesta_credential_revealer";
export const SET_ROLE_NONE_SQL = "SET LOCAL ROLE NONE";
export const SET_ACTOR_ROLE_SQL = "SELECT set_config('app.current_employee_role', $1, true)";
export const SET_TENANT_SQL = "SELECT set_config('app.current_restaurant_id', $1, true)";
export const RLS_ACTOR_PROBE_SQL = "SELECT current_user AS current_user, current_setting('app.current_employee_role', true) AS actor_role, current_setting('app.current_restaurant_id', true) AS restaurant_id";
export const EXISTING_HASH_SQL = "SELECT employee_id, password_hash FROM employee_credentials";
export const EXISTING_ENC_SQL = "SELECT employee_id, password_enc FROM employee_credentials";
export const EXISTING_META_SQL = "SELECT employee_id, updated_at FROM employee_credentials";
export const CREDENTIAL_INSERT_SQL = "INSERT INTO employee_credentials (employee_id, password_hash, password_enc, updated_at) VALUES ($1, $2, $3, now())";
export const RECONCILE_COUNTS_SQL = "SELECT count(*)::int AS total, count(DISTINCT employee_id)::int AS distinct_employees FROM employee_credentials";
export const ATTEMPT_SELECT_SQL = `SELECT attempt_id, status, phase, target_fingerprint, firebase_project
       FROM production_migration_attempts
      WHERE target_fingerprint = $1
      ORDER BY updated_at DESC
      LIMIT 1`;

export const PROTECTED_CONTENT_FINGERPRINT_SQL = GENERATED_PROTECTED_FP_SQL;
export const SESSION_PROTECTED_FINGERPRINT_SQL = GENERATED_SESSION_FP_SQL;
export {
  buildProtectedContentFingerprintSql,
  buildSessionProtectedFingerprintSql,
  fingerprintColumns,
  assertFingerprintSqlContract,
  assertRequiredFingerprintCoverage,
  assertFingerprintHasDeterministicOrder,
  REQUIRED_FINGERPRINT_FIELDS,
  EXCLUDED_FROM_PROTECTED_FINGERPRINT,
} from "./credentialProtectedFingerprint.mjs";

// Prefixed / alphanumeric legacy keys (rest_*, chef_*, Firebase Auth UIDs).
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// Exact Firebase RTDB push ID: leading '-' + 19 charset chars (20 total).
const FIREBASE_PUSH_ID_RE = /^-[0-9A-Za-z_-]{19}$/;
// Observed compound employee keys: -<pushId>_<millisTimestamp> only.
const FIREBASE_PUSH_COMPOUND_RE = /^-[0-9A-Za-z_-]{19}_\d{10,16}$/;
// Exact legacy percent-encoded phone key: %2B + 8–15 digits (E.164-ish). No other escapes.
const LEGACY_PERCENT_PHONE_KEY_RE = /^%2[Bb]\d{8,15}$/;
const SAFE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_ID_RE = /^id:[0-9a-f]{12}$/;
const ISO_GENERATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const FORBIDDEN_REPORT_KEYS = /^(password|passwordhash|passwordenc|password_hash|password_enc|ciphertext|token|dsn|secret|authorization|postgres_url|database_url|private_key|api_key|copyhash|copyenc|plaintext|pin|encryption_key)$/i;
// Structural bcrypt / DSN markers (also covered by containsSecretLikeMaterial).
const SECRET_VALUE_RE = /(\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{20,})|(postgres(ql)?:\/\/\S+)/i;
// Realistic JWT anywhere (header starts with eyJ = base64url of '{'). Not ordinary dotted IDs.
const JWT_REALISTIC_ANYWHERE_RE = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i;
const BEARER_ANYWHERE_RE = /Bearer\s+\S+/i;
const PEM_LIKE_RE = /-----BEGIN[ A-Z]*PRIVATE KEY-----|-----BEGIN RSA PRIVATE KEY-----/i;
// Case-insensitive API token prefixes (detection only; originals are never lowercased for emit).
const API_TOKEN_ANYWHERE_RE = /(?:sk_live_|sk_test_|pk_live_|pk_test_|rk_live_|rk_test_|AIza|ghp_|github_pat_|xox[baprs]-)/i;
const SECRET_KEY_VALUE_ANYWHERE_RE = /(?:password|passwd|pwd|secret|token|api[_-]?key|encryption[_-]?key|private[_-]?key)\s*=\s*\S+/i;
const LONG_HEX_ANYWHERE_RE = /[A-Fa-f0-9]{32,}/;
const LONG_BASE64URL_ANYWHERE_RE = /[A-Za-z0-9_-]{40,}={0,2}/;
const CREDENTIAL_LEAK_MARKER_RE = /PASSWORD_MARKER|SECRET_PIN_MARKER|ENCRYPTION_KEY_MARKER|TOKEN_MARKER_|PLAINTEXT_PASSWORD|SUPER_SECRET_PIN/i;
const ALLOWED_REPORT_KEYS = new Set([
  "generatedAt", "mode", "writes", "firebaseWrites",
  "credentialTrees", "credentialUserNodes", "restaurantsInPg", "employeesInPg",
  "currentEmployeeCredentials", "mappable", "hashOnly", "passwordEncOnly", "both",
  "loginCompatible", "expectedInserts", "expectedUpdates", "expectedUnchanged",
  "expectedConflicts", "expectedShaReset", "expectedShaResetWithEnc", "expectedShaResetOnly",
  "credentialWithoutEmployee",
  "employeeWithoutCredential", "missingCredentialNode", "restaurantsWithoutCredentialTree",
  "incompatibleHash", "legacyShaRequiresReset", "destinationConflicts", "planned",
  "incompatibleHashBlocksApply", "reconciliation", "applied", "verdict",
]);
const ALLOWED_ID_ROW_KEYS = new Set(["restId", "userId", "restaurantId", "employeeId", "reason", "kind", "action", "hasHash", "hasEnc"]);
const ALLOWED_APPLIED_KEYS = new Set(["inserted", "updated", "unchanged", "conflicts", "shaReset"]);
const ALLOWED_RECONCILE_KEYS = new Set([
  "sourceMappable", "pgEmployeeCredentials", "missingMappings", "nullPasswordHash",
  "nullPasswordEnc", "duplicateEmployeeId", "loginCompatible", "protectedFingerprintUnchanged",
]);

function gateFail(code) {
  fail(code);
}

export function isCredentialApplyRequested(argv = []) {
  return Array.isArray(argv) && argv.includes(CREDENTIAL_APPLY_FLAG);
}

/** Exact legacy shapes that may suppress ONLY entropy detectors (not explicit markers). */
export function isExactKnownSafeIdShape(value) {
  if (typeof value !== "string" || !value) return false;
  return SAFE_UUID_RE.test(value)
    || FIREBASE_PUSH_ID_RE.test(value)
    || FIREBASE_PUSH_COMPOUND_RE.test(value)
    || LEGACY_PERCENT_PHONE_KEY_RE.test(value)
    || OPAQUE_ID_RE.test(value);
}

/**
 * Realistic JWT heuristic: three base64url segments whose header starts with eyJ
 * (base64url of JSON `{`). Ordinary dotted app IDs (branch.v1.active) are NOT JWTs.
 * Short labels like a.b.c are intentionally not treated as tokens.
 */
export function containsJwtLikeToken(value) {
  if (typeof value !== "string" || !value) return false;
  return JWT_REALISTIC_ANYWHERE_RE.test(value);
}

/** Explicit credential/token markers — always checked before shape exemptions. */
export function containsExplicitSecretMarker(value) {
  if (typeof value !== "string" || !value) return false;
  if (SECRET_VALUE_RE.test(value)) return true;
  if (containsJwtLikeToken(value)) return true;
  if (BEARER_ANYWHERE_RE.test(value)) return true;
  if (PEM_LIKE_RE.test(value)) return true;
  if (API_TOKEN_ANYWHERE_RE.test(value)) return true;
  if (SECRET_KEY_VALUE_ANYWHERE_RE.test(value)) return true;
  if (CREDENTIAL_LEAK_MARKER_RE.test(value)) return true;
  return false;
}

/** Generic high-entropy detectors — exact known-safe shapes may suppress these. */
export function containsEntropySecretMaterial(value) {
  if (typeof value !== "string" || !value) return false;
  if (LONG_HEX_ANYWHERE_RE.test(value)) return true;
  if (LONG_BASE64URL_ANYWHERE_RE.test(value)) return true;
  return false;
}

/**
 * Secret detection decision order:
 * 1) explicit secret markers (never bypassed by shape exemption)
 * 2) exact known-safe shape → skip entropy only
 * 3) generic entropy / high-randomness detection
 */
export function containsSecretLikeMaterial(value) {
  if (typeof value !== "string" || !value) return false;
  if (containsExplicitSecretMarker(value)) return true;
  if (isExactKnownSafeIdShape(value)) return false;
  if (containsEntropySecretMaterial(value)) return true;
  return false;
}

/** @deprecated alias — prefer containsSecretLikeMaterial */
export function isSecretLikeValue(value) {
  return containsSecretLikeMaterial(value);
}

export function assertSecretFree(value, path = "$") {
  if (value == null) return;
  if (typeof value === "string") {
    if (containsSecretLikeMaterial(value)) gateFail(GATE_ERROR.SECRET_OUTPUT_REJECTED);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertSecretFree(item, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_REPORT_KEYS.test(key)) gateFail(GATE_ERROR.SECRET_OUTPUT_REJECTED);
      assertSecretFree(child, `${path}.${key}`);
    }
  }
}

function isPathHazardId(value) {
  return value.includes("://") || value.includes("/") || value.includes("\\") || value.includes("@");
}

function isHostileIdShape(value) {
  if (value.length === 0 || value.length > 128) return true;
  if (/[\u0000-\u001f\u007f]/.test(value)) return true;
  if (/\s/.test(value)) return true;
  return false;
}

function matchesExactSafeRawId(value) {
  if (isExactKnownSafeIdShape(value)) return true;
  if (SAFE_ID_RE.test(value) && !containsSecretLikeMaterial(value)) return true;
  return false;
}

/** True when value is a known-safe legacy identifier shape (not opaque correlation). */
export function isAllowlistedReportId(value) {
  if (typeof value !== "string") return false;
  if (isHostileIdShape(value) || isPathHazardId(value) || containsSecretLikeMaterial(value)) return false;
  return matchesExactSafeRawId(value);
}

/**
 * Correlation-only opaque id (sha256 prefix). Not cryptographic anonymization against guessing.
 * Never embeds the original value.
 */
export function opaqueReportId(value) {
  const digest = createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 12);
  return `id:${digest}`;
}

/**
 * Raw-ID decision tree:
 * 1) string/length/hostile shape
 * 2) path hazards
 * 3) secret-like material anywhere (before any permissive ID regex)
 * 4) exact known-safe shapes only
 * 5) null → caller may opaque non-secrets or fail-closed secrets
 */
export function safeReportId(value) {
  if (typeof value !== "string") return null;
  if (isHostileIdShape(value)) return null;
  if (isPathHazardId(value)) return null;
  if (containsSecretLikeMaterial(value)) return null;
  if (SAFE_UUID_RE.test(value)) return value.toLowerCase();
  if (FIREBASE_PUSH_ID_RE.test(value)) return value;
  if (FIREBASE_PUSH_COMPOUND_RE.test(value)) return value;
  if (LEGACY_PERCENT_PHONE_KEY_RE.test(value)) return value;
  if (OPAQUE_ID_RE.test(value)) return value;
  if (SAFE_ID_RE.test(value)) return value;
  return null;
}

export function safeUuidOrId(value) {
  if (typeof value !== "string") return null;
  if (isHostileIdShape(value) || isPathHazardId(value) || containsSecretLikeMaterial(value)) return null;
  if (SAFE_UUID_RE.test(value)) return value.toLowerCase();
  return safeReportId(value);
}

function requireSafeId(value) {
  const raw = String(value);
  if (isHostileIdShape(raw) || isPathHazardId(raw) || containsSecretLikeMaterial(raw)) {
    gateFail(GATE_ERROR.SECRET_OUTPUT_REJECTED);
  }
  const safe = safeReportId(raw);
  if (safe) return safe;
  // Non-secret, non-allowlisted legacy key: correlate via opaque hash; never echo raw.
  return opaqueReportId(raw);
}

function requireSafeUuidOrId(value) {
  const safe = safeUuidOrId(value);
  if (!safe) gateFail(GATE_ERROR.SECRET_OUTPUT_REJECTED);
  return safe;
}

function sanitizeIdRow(row = {}) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (!ALLOWED_ID_ROW_KEYS.has(key) || value == null) continue;
    if (key === "hasHash" || key === "hasEnc") out[key] = Boolean(value);
    else if (key === "restaurantId" || key === "employeeId") out[key] = requireSafeUuidOrId(String(value));
    else out[key] = requireSafeId(String(value));
  }
  return out;
}

function allowlistedObject(value, allowedKeys, nested) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    out[key] = nested ? nested(key, value[key]) : value[key];
  }
  return out;
}

export function identifyProductionPgTarget(masked, env = {}) {
  if (!masked) gateFail(GATE_ERROR.PG_NOT_CONFIGURED);
  if (isLoopbackHost(masked.host) || String(masked.host || "").startsWith("/")) {
    gateFail(GATE_ERROR.TARGET_NOT_PRODUCTION);
  }
  const db = String(masked.database || "").trim();
  if (!db) gateFail(GATE_ERROR.TARGET_NOT_PRODUCTION);
  if (FORBIDDEN_DB.has(db) || db === MIGRATION_TARGET_DB) gateFail(GATE_ERROR.TARGET_NOT_PRODUCTION);
  if (!sslConfigured(env)) gateFail(GATE_ERROR.TARGET_NOT_PRODUCTION);
  if (!isProductionMigrateTarget(env)) gateFail(GATE_ERROR.TARGET_NOT_PRODUCTION);
  const expected = String(env[CREDENTIAL_TARGET_FINGERPRINT_ENV] || "").trim();
  if (!isTargetFingerprint(expected)) gateFail(GATE_ERROR.TARGET_FINGERPRINT_MISMATCH);
  return expected;
}

export function assertProductionStaticBeforeConnect(env = process.env) {
  const target = inspectPgTargetFromEnv(env);
  if (!target.configured || target.loopback || target.malformed) {
    gateFail(GATE_ERROR.TARGET_NOT_PRODUCTION);
  }
  const masked = maskedEffectivePgConfig(env);
  identifyProductionPgTarget(masked, env);
  return masked;
}

export function assertFirebaseProductionSource(env = {}) {
  const projectId = String(env.FIREBASE_PROJECT_ID || "").trim();
  if (projectId !== APPROVED_FIREBASE_PROJECT_ID) gateFail(GATE_ERROR.SOURCE_PROJECT_INVALID);
  const raw = String(env.FIREBASE_DATABASE_URL ?? "");
  if (raw !== APPROVED_RTDB_URL) gateFail(GATE_ERROR.SOURCE_ORIGIN_INVALID);
}

export function assertMaintenanceEvidence(env = {}) {
  if (!isMaintenanceMode(env)) gateFail(GATE_ERROR.MAINTENANCE_EVIDENCE_INVALID);
  if (String(env[CREDENTIAL_MAINTENANCE_EVIDENCE_ENV] || "") !== CREDENTIAL_MAINTENANCE_EVIDENCE_PHRASE) {
    gateFail(GATE_ERROR.MAINTENANCE_EVIDENCE_INVALID);
  }
}

export function assertCredentialApplyAuthorization({ argv = [], env = {}, masked } = {}) {
  if (!isCredentialApplyRequested(argv)) gateFail(GATE_ERROR.APPLY_FLAG_REQUIRED);
  if (String(env[CREDENTIAL_APPLY_CONFIRM_ENV] || "") !== CREDENTIAL_APPLY_CONFIRM_PHRASE) {
    gateFail(GATE_ERROR.APPLY_CONFIRM_INVALID);
  }
  identifyProductionPgTarget(masked, env);
  assertMaintenanceEvidence(env);
  assertFirebaseProductionSource(env);
}

export function assertTerminalFullComplete(attempt) {
  if (!attempt || attempt.status !== ATTEMPT_STATUS.FULL_COMPLETE) {
    gateFail(GATE_ERROR.ATTEMPT_NOT_TERMINAL);
  }
  if (attempt.phase !== MIGRATION_PHASE.FULL_AFTER_WAVE1) {
    gateFail(GATE_ERROR.ATTEMPT_NOT_TERMINAL);
  }
}

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function validateCredentialGateReport(report) {
  // Scan the entire input (including non-allowlisted fields like metadata) before pick.
  assertSecretFree(report);
  const picked = allowlistedObject(report, ALLOWED_REPORT_KEYS, (key, value) => {
    if (key === "generatedAt") {
      const raw = value == null ? "" : String(value);
      if (!ISO_GENERATED_AT_RE.test(raw) || containsSecretLikeMaterial(raw)) {
        gateFail(GATE_ERROR.SECRET_OUTPUT_REJECTED);
      }
      return raw;
    }
    if (Array.isArray(value) && [
      "credentialWithoutEmployee", "employeeWithoutCredential", "missingCredentialNode",
      "incompatibleHash", "legacyShaRequiresReset", "destinationConflicts", "planned",
    ].includes(key)) {
      return value.map((row) => sanitizeIdRow(row));
    }
    if (key === "restaurantsWithoutCredentialTree") {
      return (value || []).map((id) => requireSafeId(id));
    }
    if (key === "applied") return allowlistedObject(value, ALLOWED_APPLIED_KEYS);
    if (key === "reconciliation") {
      if (value == null) return null;
      return allowlistedObject(value, ALLOWED_RECONCILE_KEYS);
    }
    if (typeof value === "string") {
      if (containsSecretLikeMaterial(value)) gateFail(GATE_ERROR.SECRET_OUTPUT_REJECTED);
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || value == null) {
      return value;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number")) {
      for (const item of value) {
        if (typeof item === "string" && containsSecretLikeMaterial(item)) {
          gateFail(GATE_ERROR.SECRET_OUTPUT_REJECTED);
        }
      }
      return value;
    }
    gateFail(GATE_ERROR.SECRET_OUTPUT_REJECTED);
  });
  assertSecretFree(picked);
  return picked;
}

function emptyPlan() {
  return {
    credentialTrees: 0, credentialUserNodes: 0, restaurantsInPg: 0, employeesInPg: 0,
    currentEmployeeCredentials: 0, mappable: 0, hashOnly: 0, passwordEncOnly: 0, both: 0,
    loginCompatible: 0, expectedInserts: 0, expectedUpdates: 0, expectedUnchanged: 0,
    expectedConflicts: 0, expectedShaReset: 0, expectedShaResetWithEnc: 0, expectedShaResetOnly: 0,
    credentialWithoutEmployee: [],
    employeeWithoutCredential: [], missingCredentialNode: [], restaurantsWithoutCredentialTree: [],
    incompatibleHash: [], legacyShaRequiresReset: [], destinationConflicts: [], planned: [],
  };
}

async function enterAppRole(client) {
  await client.query(SET_ROLE_APP_SQL);
}

async function restoreAppRole(client, { operationFailed = false } = {}) {
  try {
    await enterAppRole(client);
  } catch (restoreErr) {
    const restoreCode = restoreErr && restoreErr.code ? String(restoreErr.code) : "";
    if (operationFailed && restoreCode === "25P02") return;
    throw restoreErr;
  }
}

async function enterReadActorContext(client) {
  await enterAppRole(client);
  await client.query(SET_ACTOR_ROLE_SQL, [""]);
  await client.query(SET_TENANT_SQL, [""]);
}

async function withPrivilegedRole(client, setRoleSql, fn) {
  await client.query(setRoleSql);
  let operationError = null;
  let result;
  try {
    result = await fn();
  } catch (err) {
    operationError = err;
  }
  try {
    await restoreAppRole(client, { operationFailed: Boolean(operationError) });
  } catch (restoreErr) {
    throw restoreErr;
  }
  if (operationError) throw operationError;
  return result;
}

export async function withLoginReader(client, fn) {
  return withPrivilegedRole(client, SET_ROLE_LOGIN_READER_SQL, fn);
}

export async function withRevealer(client, fn) {
  return withPrivilegedRole(client, SET_ROLE_REVEALER_SQL, fn);
}

export async function withSessionRole(client, fn) {
  return withPrivilegedRole(client, SET_ROLE_NONE_SQL, fn);
}

async function loadExistingCredentials(client) {
  const hashes = (await withLoginReader(client, () => client.query(EXISTING_HASH_SQL))).rows;
  const encs = (await withRevealer(client, () => client.query(EXISTING_ENC_SQL))).rows;
  const meta = (await client.query(EXISTING_META_SQL)).rows;
  const existing = new Map();
  for (const row of hashes) {
    existing.set(String(row.employee_id), {
      employee_id: row.employee_id,
      password_hash: row.password_hash ?? null,
      password_enc: null,
      updated_at: null,
    });
  }
  for (const row of encs) {
    const prev = existing.get(String(row.employee_id)) || { employee_id: row.employee_id, password_hash: null, updated_at: null };
    prev.password_enc = row.password_enc ?? null;
    existing.set(String(row.employee_id), prev);
  }
  for (const row of meta) {
    const prev = existing.get(String(row.employee_id)) || { employee_id: row.employee_id, password_hash: null, password_enc: null };
    prev.updated_at = row.updated_at ?? null;
    existing.set(String(row.employee_id), prev);
  }
  return existing;
}

async function destinationAction(prev, classified, sourceRaw, copyEnc) {
  if (!prev) return "insert";
  const destHash = prev.password_hash ?? null;
  const destEnc = prev.password_enc ?? null;
  const encSame = (copyEnc || null) === (destEnc || null);
  let hashSame = false;
  if (!sourceRaw) hashSame = destHash == null;
  else if (classified.kind === "bcrypt") hashSame = destHash === sourceRaw;
  else if (classified.kind === "plaintext") {
    hashSame = destHash ? (await verifyPassword(sourceRaw, destHash)).ok : false;
  }
  if (hashSame && encSame) return "unchanged";
  return "conflict";
}

export async function planCredentialCopyInTx({ fb, client } = {}) {
  const check = () => { throwIfCredentialCliFailed(); };
  const plan = emptyPlan();
  const credRests = await fb.shallowKeys("credentials");
  check();
  plan.credentialTrees = credRests.length;

  const empRests = (await client.query("SELECT id, legacy_rtdb_id FROM restaurants")).rows;
  plan.restaurantsInPg = empRests.length;
  const restByLegacy = new Map(empRests.map((r) => [r.legacy_rtdb_id, r.id]));
  plan.restaurantsWithoutCredentialTree = empRests
    .filter((r) => r.legacy_rtdb_id && !credRests.includes(r.legacy_rtdb_id))
    .map((r) => r.legacy_rtdb_id);

  const existingByEmp = await loadExistingCredentials(client);
  check();
  plan.currentEmployeeCredentials = existingByEmp.size;
  plan.employeesInPg = Number((await client.query("SELECT count(*)::int AS n FROM employees")).rows[0].n);

  const restLegacies = [...new Set([
    ...credRests,
    ...empRests.map((r) => r.legacy_rtdb_id).filter(Boolean),
  ])];

  for (const restLegacy of restLegacies) {
    check();
    const restUuid = restByLegacy.get(restLegacy);
    const credUsers = credRests.includes(restLegacy) ? await fb.shallowKeys(`credentials/${restLegacy}`) : [];
    check();
    plan.credentialUserNodes += credUsers.length;
    if (!restUuid) {
      for (const uid of credUsers) {
        plan.credentialWithoutEmployee.push({ restId: restLegacy, userId: uid, reason: "restaurant-unmapped" });
      }
      continue;
    }
    const emps = (await client.query(
      "SELECT id, legacy_rtdb_id FROM employees WHERE restaurant_id = $1",
      [restUuid]
    )).rows;
    const empByLegacy = new Map(emps.map((e) => [e.legacy_rtdb_id, e.id]));

    for (const uid of credUsers) {
      const rec = await fb.getValue(`credentials/${restLegacy}/${uid}`);
      check();
      const empId = empByLegacy.get(uid);
      if (!empId) {
        plan.credentialWithoutEmployee.push({ restId: restLegacy, userId: uid });
        continue;
      }
      const hash = sourceHashValue(rec);
      const enc = sourceEncValue(rec);
      if (isMalformedSource(hash) || isMalformedSource(enc)) {
        plan.incompatibleHash.push({ restId: restLegacy, userId: uid, kind: "incompatible-type" });
        continue;
      }
      if (!hash && !enc) {
        plan.missingCredentialNode.push({ restId: restLegacy, userId: uid });
        continue;
      }

      let classified = null;
      if (hash) {
        classified = classifyStoredPassword(hash);
        if (classified.kind === "sha256") {
          const hasEnc = Boolean(enc);
          // SHA is one-way; do not copy as a usable hash. A paired passwordEnc
          // may exist, but this gate never reverse-reveals it to rehash — that
          // would expand migrate privilege. Track hasEnc for ops only; apply
          // stays blocked until resets clear.
          plan.legacyShaRequiresReset.push({
            restId: restLegacy,
            userId: uid,
            kind: classified.kind,
            hasEnc,
          });
          plan.expectedShaReset += 1;
          if (hasEnc) plan.expectedShaResetWithEnc += 1;
          else plan.expectedShaResetOnly += 1;
          continue;
        }
        if (!classified.migratable) {
          plan.incompatibleHash.push({ restId: restLegacy, userId: uid, kind: classified.kind });
          continue;
        }
        if (classified.loginCompatible) plan.loginCompatible += 1;
      }

      if (hash && enc) plan.both += 1;
      else if (hash) plan.hashOnly += 1;
      else plan.passwordEncOnly += 1;

      const copyEnc = enc || null;
      const prev = existingByEmp.get(String(empId));
      const action = await destinationAction(prev, classified || { kind: "empty" }, hash, copyEnc);
      let copyHash = null;
      if (action === "insert") {
        copyHash = hash ? await materializeMigratableHash(classified, hash) : null;
      }

      if (action === "insert") plan.expectedInserts += 1;
      else if (action === "unchanged") plan.expectedUnchanged += 1;
      else {
        plan.expectedConflicts += 1;
        plan.destinationConflicts.push({ restId: restLegacy, userId: uid, reason: "DESTINATION_NEWER_OR_DIFFERENT" });
      }
      plan.mappable += 1;
      plan.planned.push({
        restId: restLegacy,
        userId: uid,
        restaurantId: restUuid,
        employeeId: empId,
        hasHash: Boolean(hash),
        hasEnc: Boolean(copyEnc),
        action,
        copyHash,
        copyEnc,
        sourceKind: classified?.kind || "enc-only",
      });
    }
    for (const emp of emps) {
      if (!credUsers.includes(emp.legacy_rtdb_id)) {
        plan.employeeWithoutCredential.push({ restId: restLegacy, userId: emp.legacy_rtdb_id });
      }
    }
  }
  check();
  return plan;
}

export async function planCredentialCopy({ fb, client }) {
  await client.query("BEGIN READ ONLY");
  try {
    await enterReadActorContext(client);
    const plan = await planCredentialCopyInTx({ fb, client });
    throwIfCredentialCliFailed();
    const rb = await boundedCredentialRollback(client);
    throwAfterBoundedRollback(rb);
    return plan;
  } catch (err) {
    if (err && err.cleanupCode && (err.code === GATE_ERROR.PG_CLEANUP_TIMEOUT || err.code === GATE_ERROR.PG_ROLLBACK_FAILED)) {
      throw err;
    }
    const rb = await boundedCredentialRollback(client);
    throwAfterBoundedRollback(rb, err);
  }
}

async function captureProtectedFingerprint(client) {
  const sessionFp = await withSessionRole(client, async () => {
    const { rows } = await client.query(SESSION_PROTECTED_FINGERPRINT_SQL);
    return rows[0] ?? null;
  });
  const { rows } = await client.query(PROTECTED_CONTENT_FINGERPRINT_SQL);
  return JSON.stringify({ protected: rows[0] ?? null, session: sessionFp });
}

async function assertRlsWriteContext(client, restaurantId) {
  const probe = (await client.query(RLS_ACTOR_PROBE_SQL)).rows[0] || {};
  if (probe.current_user !== "nesta_app") gateFail(GATE_ERROR.RLS_CONTEXT_INVALID);
  if (probe.actor_role !== "owner" && probe.actor_role !== CREDENTIAL_ACTOR_ROLE) {
    gateFail(GATE_ERROR.RLS_CONTEXT_INVALID);
  }
  if (String(probe.restaurant_id || "") !== String(restaurantId || "")) {
    gateFail(GATE_ERROR.RLS_CONTEXT_INVALID);
  }
}

async function reconcileDestinationState(client, plan, credBefore) {
  await client.query(SET_TENANT_SQL, [""]);
  await enterAppRole(client);

  const counts = (await client.query(RECONCILE_COUNTS_SQL)).rows[0] || {};
  if (Number(counts.distinct_employees) !== Number(counts.total)) gateFail(GATE_ERROR.RECONCILIATION_FAILED);
  const expectedAfter = credBefore + plan.expectedInserts;
  if (Number(counts.total) !== expectedAfter) gateFail(GATE_ERROR.RECONCILIATION_FAILED);

  const hashes = (await withLoginReader(client, () => client.query(EXISTING_HASH_SQL))).rows;
  for (const row of hashes) {
    if (row.password_hash == null) continue;
    const classified = classifyStoredPassword(row.password_hash);
    if (classified.kind !== "bcrypt" || !classified.copyable) gateFail(GATE_ERROR.RECONCILIATION_FAILED);
  }

  const hashByEmp = new Map(hashes.map((row) => [String(row.employee_id), row.password_hash ?? null]));
  for (const row of plan.planned) {
    if (row.action !== "insert") continue;
    const stored = hashByEmp.get(String(row.employeeId));
    if (row.copyHash && stored == null) gateFail(GATE_ERROR.RECONCILIATION_FAILED);
    if (row.copyHash && stored !== row.copyHash) gateFail(GATE_ERROR.RECONCILIATION_FAILED);
  }

  const encs = (await withRevealer(client, () => client.query(EXISTING_ENC_SQL))).rows;
  const encByEmp = new Map(encs.map((row) => [String(row.employee_id), row.password_enc ?? null]));
  let nullHash = 0;
  let nullEnc = 0;
  for (const row of hashes) {
    if (row.password_hash == null) nullHash += 1;
  }
  for (const row of encs) {
    if (row.password_enc == null) nullEnc += 1;
  }
  for (const row of plan.planned) {
    if (row.action !== "insert") continue;
    if ((encByEmp.get(String(row.employeeId)) || null) !== (row.copyEnc || null)) {
      gateFail(GATE_ERROR.RECONCILIATION_FAILED);
    }
  }

  const bothNull = [...new Set([...hashByEmp.keys(), ...encByEmp.keys()])]
    .filter((id) => hashByEmp.get(id) == null && encByEmp.get(id) == null).length;
  if (bothNull > 0) gateFail(GATE_ERROR.RECONCILIATION_FAILED);

  return {
    employeeCredentialsAfter: Number(counts.total),
    nullPasswordHash: nullHash,
    nullPasswordEnc: nullEnc,
    duplicateEmployeeId: false,
    protectedFingerprintUnchanged: true,
  };
}

function secretFreePlanView(plan) {
  return {
    credentialTrees: asInt(plan.credentialTrees),
    credentialUserNodes: asInt(plan.credentialUserNodes),
    restaurantsInPg: asInt(plan.restaurantsInPg),
    employeesInPg: asInt(plan.employeesInPg),
    currentEmployeeCredentials: asInt(plan.currentEmployeeCredentials),
    mappable: asInt(plan.mappable),
    hashOnly: asInt(plan.hashOnly),
    passwordEncOnly: asInt(plan.passwordEncOnly),
    both: asInt(plan.both),
    loginCompatible: asInt(plan.loginCompatible),
    expectedInserts: asInt(plan.expectedInserts),
    expectedUpdates: 0,
    expectedUnchanged: asInt(plan.expectedUnchanged),
    expectedConflicts: asInt(plan.expectedConflicts),
    expectedShaReset: asInt(plan.expectedShaReset),
    expectedShaResetWithEnc: asInt(plan.expectedShaResetWithEnc),
    expectedShaResetOnly: asInt(plan.expectedShaResetOnly),
    credentialWithoutEmployee: plan.credentialWithoutEmployee,
    employeeWithoutCredential: plan.employeeWithoutCredential,
    missingCredentialNode: plan.missingCredentialNode,
    restaurantsWithoutCredentialTree: plan.restaurantsWithoutCredentialTree,
    incompatibleHash: plan.incompatibleHash,
    legacyShaRequiresReset: plan.legacyShaRequiresReset,
    destinationConflicts: plan.destinationConflicts,
    planned: (plan.planned || []).map((row) => ({
      restId: row.restId,
      userId: row.userId,
      restaurantId: row.restaurantId,
      employeeId: row.employeeId,
      hasHash: Boolean(row.hasHash),
      hasEnc: Boolean(row.hasEnc),
      action: row.action,
    })),
  };
}

function buildApplyReport(plan, applied, reconciled) {
  return {
    generatedAt: new Date().toISOString(),
    mode: "apply",
    writes: "employee_credentials-only",
    firebaseWrites: 0,
    ...secretFreePlanView(plan),
    incompatibleHashBlocksApply: plan.incompatibleHash.length > 0,
    applied: {
      inserted: applied.inserted,
      updated: 0,
      unchanged: applied.unchanged,
      conflicts: applied.conflicts,
      shaReset: applied.shaReset,
    },
    reconciliation: {
      sourceMappable: plan.mappable,
      pgEmployeeCredentials: reconciled.employeeCredentialsAfter,
      missingMappings: plan.credentialWithoutEmployee.length,
      nullPasswordHash: reconciled.nullPasswordHash,
      nullPasswordEnc: reconciled.nullPasswordEnc,
      duplicateEmployeeId: reconciled.duplicateEmployeeId,
      loginCompatible: plan.loginCompatible,
      protectedFingerprintUnchanged: reconciled.protectedFingerprintUnchanged,
    },
    verdict: "OK",
  };
}

export async function applyCredentialCopy({ client, fb, liveFingerprint }) {
  await client.query("BEGIN");
  try {
    throwIfCredentialCliFailed();
    const attempt = await withSessionRole(client, () => loadTerminalAttempt(client, liveFingerprint));
    throwIfCredentialCliFailed();
    assertTerminalFullComplete(attempt);
    if (attempt.firebase_project && attempt.firebase_project !== APPROVED_FIREBASE_PROJECT_ID) {
      gateFail(GATE_ERROR.SOURCE_PROJECT_INVALID);
    }

    await enterReadActorContext(client);
    const beforeFingerprint = await captureProtectedFingerprint(client);
    const plan = await planCredentialCopyInTx({ fb, client });
    throwIfCredentialCliFailed();
    if (plan.incompatibleHash.length > 0) gateFail(GATE_ERROR.HASH_FORMAT_UNSUPPORTED);
    if (plan.expectedShaReset > 0 || plan.legacyShaRequiresReset.length > 0) {
      gateFail(GATE_ERROR.LEGACY_SHA_REQUIRES_RESET);
    }
    if (plan.destinationConflicts.length > 0) gateFail(GATE_ERROR.DESTINATION_CONFLICT);

    const credBefore = plan.currentEmployeeCredentials;
    const inserts = plan.planned.filter((row) => row.action === "insert");
    const byRest = new Map();
    for (const row of inserts) {
      const list = byRest.get(row.restaurantId) || [];
      list.push(row);
      byRest.set(row.restaurantId, list);
    }

    await enterAppRole(client);
    await client.query(SET_ACTOR_ROLE_SQL, [CREDENTIAL_ACTOR_ROLE]);
    for (const [restaurantId, rows] of byRest) {
      await client.query(SET_TENANT_SQL, [restaurantId]);
      await assertRlsWriteContext(client, restaurantId);
      for (const row of rows) {
        await client.query(CREDENTIAL_INSERT_SQL, [row.employeeId, row.copyHash, row.copyEnc]);
      }
    }

    const reconciled = await reconcileDestinationState(client, plan, credBefore);
    const report = buildApplyReport(plan, {
      inserted: plan.expectedInserts,
      unchanged: plan.expectedUnchanged,
      conflicts: 0,
      shaReset: plan.expectedShaReset,
    }, reconciled);
    const validated = validateCredentialGateReport(report);

    const afterFingerprint = await captureProtectedFingerprint(client);
    if (afterFingerprint !== beforeFingerprint) gateFail(GATE_ERROR.RECONCILIATION_FAILED);

    await client.query("COMMIT");
    return validated;
  } catch (err) {
    const rb = await boundedCredentialRollback(client);
    throwAfterBoundedRollback(rb, err);
  }
}

export async function loadTerminalAttempt(client, fingerprint) {
  const { rows } = await client.query(ATTEMPT_SELECT_SQL, [fingerprint]);
  return rows[0] || null;
}

export async function runCredentialGate({
  argv = [],
  env = {},
  masked,
  fb,
  client,
  liveFingerprint,
} = {}) {
  assertFirebaseProductionSource(env);
  identifyProductionPgTarget(masked, env);
  const expected = env[CREDENTIAL_TARGET_FINGERPRINT_ENV];
  if (liveFingerprint !== expected) gateFail(GATE_ERROR.TARGET_FINGERPRINT_MISMATCH);
  throwIfCredentialCliFailed();

  const apply = isCredentialApplyRequested(argv);
  if (apply) {
    assertCredentialApplyAuthorization({ argv, env, masked });
    const report = await applyCredentialCopy({ client, fb, liveFingerprint });
    throwIfCredentialCliFailed();
    return report;
  }

  await client.query("BEGIN READ ONLY");
  try {
    const attempt = await withSessionRole(client, () => loadTerminalAttempt(client, liveFingerprint));
    throwIfCredentialCliFailed();
    assertTerminalFullComplete(attempt);
    if (attempt.firebase_project && attempt.firebase_project !== APPROVED_FIREBASE_PROJECT_ID) {
      gateFail(GATE_ERROR.SOURCE_PROJECT_INVALID);
    }
    await enterReadActorContext(client);
    const plan = await planCredentialCopyInTx({ fb, client });
    throwIfCredentialCliFailed();
    const rb = await boundedCredentialRollback(client);
    throwAfterBoundedRollback(rb);
    const report = validateCredentialGateReport({
      generatedAt: new Date().toISOString(),
      mode: "dry-run",
      writes: 0,
      firebaseWrites: 0,
      ...secretFreePlanView(plan),
      incompatibleHashBlocksApply: plan.incompatibleHash.length > 0,
      reconciliation: null,
      verdict: plan.incompatibleHash.length > 0
        ? GATE_ERROR.HASH_FORMAT_UNSUPPORTED
        : plan.legacyShaRequiresReset.length > 0
          ? GATE_ERROR.LEGACY_SHA_REQUIRES_RESET
          : plan.destinationConflicts.length > 0
            ? GATE_ERROR.DESTINATION_CONFLICT
            : "OK",
    });
    throwIfCredentialCliFailed();
    return report;
  } catch (err) {
    if (err && err.cleanupCode && (err.code === GATE_ERROR.PG_CLEANUP_TIMEOUT || err.code === GATE_ERROR.PG_ROLLBACK_FAILED)) {
      throw err;
    }
    const rb = await boundedCredentialRollback(client);
    throwAfterBoundedRollback(rb, err);
  }
}
