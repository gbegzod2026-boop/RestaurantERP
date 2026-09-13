#!/usr/bin/env node
// Production Firebase -> PostgreSQL employee_credentials gate.
// Default: READ-ONLY dry-run. --apply requires a separate confirmation phrase.
// Never writes Firebase. Never prints secrets. Does not touch the terminal
// FULL_COMPLETE production_migration_attempts row.
import path from "path";
import { fileURLToPath } from "url";
import { mkdirSync, writeFileSync } from "fs";
import { initFirebase, shallowKeys, getValue } from "./lib/fbRead.mjs";
import { collectPgTargetIdentity } from "./lib/pgTargetFingerprint.mjs";
import { getPool, closePool, isPgAvailable, enableCredentialCliSafeMode, runCredentialCliSession, throwIfCredentialCliFailed } from "../postgres.js";
import {
  GATE_ERROR,
  CredentialGateError,
  publicErrorCode,
  runCredentialGate,
  assertFirebaseProductionSource,
  assertProductionStaticBeforeConnect,
  CREDENTIAL_TARGET_FINGERPRINT_ENV,
} from "./lib/productionCredentialGate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_DIR = path.join(__dirname, "../../../docs/migration-reports");

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  enableCredentialCliSafeMode();
  const connect = deps.getPool || getPool;
  const available = deps.isPgAvailable || isPgAvailable;
  const close = deps.closePool || closePool;
  assertFirebaseProductionSource(env);
  const masked = assertProductionStaticBeforeConnect(env);
  if (!available()) throw new CredentialGateError(GATE_ERROR.PG_NOT_CONFIGURED);
  const pool = connect();
  const result = await runCredentialCliSession(pool, async (client) => {
    const identity = await collectPgTargetIdentity(client, masked);
    throwIfCredentialCliFailed();
    if (identity.fingerprint !== env[CREDENTIAL_TARGET_FINGERPRINT_ENV]) {
      throw new CredentialGateError(GATE_ERROR.TARGET_FINGERPRINT_MISMATCH);
    }
    initFirebase();
    throwIfCredentialCliFailed();
    const report = await runCredentialGate({
      argv,
      env,
      masked,
      fb: deps.fb || { shallowKeys, getValue },
      client,
      liveFingerprint: identity.fingerprint,
    });
    throwIfCredentialCliFailed();
    return report;
  }, close);
  mkdirSync(AUDIT_DIR, { recursive: true });
  const out = path.join(AUDIT_DIR, "production-credentials-gate.json");
  writeFileSync(out, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify({
    mode: result.mode,
    verdict: result.verdict,
    credentialTrees: result.credentialTrees,
    credentialUserNodes: result.credentialUserNodes,
    mappable: result.mappable,
    expectedInserts: result.expectedInserts,
    expectedUpdates: result.expectedUpdates,
    expectedUnchanged: result.expectedUnchanged,
    expectedConflicts: result.expectedConflicts,
    expectedShaReset: result.expectedShaReset,
    expectedShaResetWithEnc: result.expectedShaResetWithEnc,
    expectedShaResetOnly: result.expectedShaResetOnly,
    currentEmployeeCredentials: result.currentEmployeeCredentials,
    credentialWithoutEmployee: result.credentialWithoutEmployee.length,
    employeeWithoutCredential: result.employeeWithoutCredential.length,
    missingCredentialNode: result.missingCredentialNode.length,
    restaurantsWithoutCredentialTree: result.restaurantsWithoutCredentialTree.length,
    incompatibleHash: result.incompatibleHash.length,
    writes: result.writes,
  }));
  console.log("Wrote production-credentials-gate.json (gitignored JSON; no secrets)");
  return result;
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error("PRODUCTION CREDENTIAL GATE FAILED:", publicErrorCode(err));
    process.exit(1);
  });
}
