#!/usr/bin/env node
// Production READ-ONLY credential role preflight.
// Independently reviewable. Performs ZERO writes. Do not run against
// production until a later explicit operator approval.
// Never prints DSNs, hosts, URLs, tokens, passwords, hashes, or secrets.
import path from "path";
import { fileURLToPath } from "url";
import {
  GATE_ERROR,
  CredentialGateError,
  publicErrorCode,
  assertProductionStaticBeforeConnect,
} from "./lib/productionCredentialGate.mjs";
import { collectPgTargetIdentity } from "./lib/pgTargetFingerprint.mjs";
import { runProductionCredentialRolePreflight, ROLE_PREFLIGHT_CODE } from "./lib/credentialRolePreflight.mjs";
import { getPool, closePool, isPgAvailable, enableCredentialCliSafeMode, runCredentialCliSession, throwIfCredentialCliFailed } from "../postgres.js";

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

export async function main(env = process.env, deps = {}) {
  enableCredentialCliSafeMode();
  const connect = deps.getPool || getPool;
  const available = deps.isPgAvailable || isPgAvailable;
  const close = deps.closePool || closePool;
  const masked = assertProductionStaticBeforeConnect(env);
  if (!available()) throw new CredentialGateError(GATE_ERROR.PG_NOT_CONFIGURED);
  const pool = connect();
  const result = await runCredentialCliSession(pool, async (client) => {
    const identity = await collectPgTargetIdentity(client, masked);
    throwIfCredentialCliFailed();
    const preflight = await runProductionCredentialRolePreflight({
      client,
      env,
      masked,
      liveFingerprint: identity.fingerprint,
    });
    throwIfCredentialCliFailed();
    return preflight;
  }, close);
  console.log(JSON.stringify({
    code: result.code,
    ok: result.ok === true,
    sessionIsSuperuser: result.checks?.sessionIsSuperuser === true,
    canSetRoleNestaApp: result.checks?.canSetRoleNestaApp === true,
    canSetRoleLoginReader: result.checks?.canSetRoleLoginReader === true,
    canSetRoleRevealer: result.checks?.canSetRoleRevealer === true,
    nestaAppCannotReadPasswordHash: result.checks?.nestaAppCannotReadPasswordHash === true,
    nestaAppCannotReadPasswordEnc: result.checks?.nestaAppCannotReadPasswordEnc === true,
    forceRls: result.checks?.employeeCredentialsForceRls === true,
  }));
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error("PRODUCTION CREDENTIAL ROLE PREFLIGHT FAILED:", publicErrorCode(err) || ROLE_PREFLIGHT_CODE.ROLE_PREFLIGHT_FAILED);
    process.exit(1);
  });
}
