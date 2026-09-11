#!/usr/bin/env node
// Non-production credential role preflight against a disposable loopback DB.
// Refuses remote/production targets before any socket. Never prints DSNs,
// hosts, URLs, tokens, passwords, hashes, or secrets.
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import pg from "pg";
import {
  ACCEPTANCE_ERROR,
  AcceptanceTargetError,
  inspectPgTargetFromEnv,
  refuseRemotePgTarget,
  loopbackClientConfig,
  finalizeAcceptanceCleanup,
} from "./lib/credentialAcceptanceTarget.mjs";
import { runLocalCredentialRolePreflight, ROLE_PREFLIGHT_CODE } from "./lib/credentialRolePreflight.mjs";
import { loadRepoMigrations } from "./lib/schemaMigrationCatalog.mjs";
import { applyMissingMigrations } from "./lib/schemaApplySession.mjs";
import { hashPassword } from "../../security/password.js";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "../../.env"), quiet: true });

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

function safeDbName() {
  return `nesta_cred_role_pf_${Date.now()}`;
}

export async function main(env = process.env, deps = {}) {
  const Client = deps.Client || pg.Client;
  const target = inspectPgTargetFromEnv(env);
  refuseRemotePgTarget(env);
  if (!target.configured || !target.loopback) {
    throw new AcceptanceTargetError(ACCEPTANCE_ERROR.PG_NOT_CONFIGURED);
  }
  const adminCfg = loopbackClientConfig(env);
  const dbName = safeDbName();
  const admin = new Client(adminCfg);
  let created = false;
  let client;
  let primaryError = null;
  let cleanupFailed = false;
  let result;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    created = true;
    client = new Client(loopbackClientConfig(env, dbName));
    await client.connect();
    if (typeof deps.runDisposableChecks === "function") {
      result = await deps.runDisposableChecks(client);
    } else {
      const repo = loadRepoMigrations(path.join(here, "../migrations"));
      await applyMissingMigrations(client, repo);
      const restaurantId = (await client.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id)
         VALUES ('role-pf.local', 'Role Preflight', 'rest_role_pf') RETURNING id`,
      )).rows[0].id;
      const adminEmployeeId = (await client.query(
        `INSERT INTO employees (restaurant_id, legacy_rtdb_id, name, login, role, active)
         VALUES ($1, 'admin_pf', 'Admin', 'admin_pf', 'admin', true) RETURNING id`,
        [restaurantId],
      )).rows[0].id;
      const waiterEmployeeId = (await client.query(
        `INSERT INTO employees (restaurant_id, legacy_rtdb_id, name, login, role, active)
         VALUES ($1, 'waiter_pf', 'Waiter', 'waiter_pf', 'waiter', true) RETURNING id`,
        [restaurantId],
      )).rows[0].id;
      const passwordHash = await hashPassword("4826");
      result = await runLocalCredentialRolePreflight(client, {
        restaurantId,
        adminEmployeeId,
        waiterEmployeeId,
        passwordHash,
      });
    }
    if (!result || result.ok !== true) {
      primaryError = new AcceptanceTargetError(ROLE_PREFLIGHT_CODE.ROLE_PREFLIGHT_FAILED);
    }
  } catch (err) {
    primaryError = err;
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        cleanupFailed = true;
      }
    }
    if (created) {
      try {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [dbName],
        );
      } catch {
        cleanupFailed = true;
      }
      try {
        if (typeof deps.dropDatabase === "function") {
          await deps.dropDatabase(admin, dbName);
        } else {
          await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
        }
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await admin.end();
    } catch {
      cleanupFailed = true;
    }
  }
  finalizeAcceptanceCleanup({ primaryError, cleanupFailed });
  if (result && result.ok !== true) {
    throw new AcceptanceTargetError(ROLE_PREFLIGHT_CODE.ROLE_PREFLIGHT_FAILED);
  }
  console.log(JSON.stringify({
    code: result.code,
    ok: result.ok === true,
    sessionIsSuperuser: result.checks?.sessionIsSuperuser === true,
    canSetRoleNestaApp: result.checks?.canSetRoleNestaApp === true,
    canSetRoleLoginReader: result.checks?.canSetRoleLoginReader === true,
    canSetRoleRevealer: result.checks?.canSetRoleRevealer === true,
    adminInsertOk: result.checks?.adminInsertOk === true,
    waiterDenied42501: result.checks?.waiterDenied42501 === true,
    forceRls: result.checks?.employeeCredentialsForceRls === true,
  }));
  return result;
}

if (isDirectRun()) {
  main().catch((err) => {
    const code = err instanceof AcceptanceTargetError
      ? err.code
      : (err && err.cleanupCode) || ROLE_PREFLIGHT_CODE.ROLE_PREFLIGHT_FAILED;
    console.error("LOCAL CREDENTIAL ROLE PREFLIGHT FAILED:", code);
    process.exit(1);
  });
}
