// Copy Firebase credentials/$restId/$uid hashes into the dedicated local
// migration database by default. Firebase: GET only.
// Target enforcement is shared enforceConnectedApplyTarget: default is
// loopback + nesta_migration_dryrun. Production is not implicit. It is only
// possible when NESTA_MIGRATE_TARGET=production plus the existing production
// confirm phrase, tag, and SSL guards. This file is not the production
// credential cutover tool (use production-credentials-migrate.mjs).
// Never prints password, hash, or ciphertext.
import path from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync } from "fs";
import { initFirebase, shallowKeys, getValue } from "./lib/fbRead.mjs";
import { enforceConnectedApplyTarget } from "./lib/migrationTargetGuard.mjs";
import { getPool, maskedConfig, closePool, isPgAvailable } from "../postgres.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_DIR = path.join(__dirname, "../../../docs/migration-reports");

async function main() {
  if (!isPgAvailable()) throw new Error("PostgreSQL not configured");
  const cfg = maskedConfig();
  initFirebase();
  const pool = getPool();
  const client = await pool.connect();
  await enforceConnectedApplyTarget(client, cfg, process.env, {
    writesCommitted: true,
    allowTenantRows: true,
  });
  await client.query("SELECT set_config('app.current_restaurant_id', '', true)");

  const credRests = await shallowKeys("credentials");
  const empRests = (await client.query("SELECT id, legacy_rtdb_id FROM restaurants")).rows;
  const restByLegacy = new Map(empRests.map((r) => [r.legacy_rtdb_id, r.id]));

  const report = {
    generatedAt: new Date().toISOString(),
    credentialTrees: credRests.length,
    restaurantsInPg: empRests.length,
    copied: 0,
    missingCredentialNode: [],
    employeeWithoutCredential: [],
    credentialWithoutEmployee: [],
    restaurantsWithoutCredentialTree: empRests
      .filter((r) => r.legacy_rtdb_id && !credRests.includes(r.legacy_rtdb_id))
      .map((r) => r.legacy_rtdb_id),
  };

  for (const restLegacy of [...new Set([...credRests, ...empRests.map((r) => r.legacy_rtdb_id).filter(Boolean)])]) {
    const restUuid = restByLegacy.get(restLegacy);
    const credUsers = credRests.includes(restLegacy) ? await shallowKeys(`credentials/${restLegacy}`) : [];
    if (!restUuid) continue;
    const emps = (await client.query(
      "SELECT id, legacy_rtdb_id FROM employees WHERE restaurant_id = $1",
      [restUuid]
    )).rows;
    const empByLegacy = new Map(emps.map((e) => [e.legacy_rtdb_id, e.id]));
    for (const uid of credUsers) {
      const rec = await getValue(`credentials/${restLegacy}/${uid}`);
      const empId = empByLegacy.get(uid);
      if (!empId) {
        report.credentialWithoutEmployee.push({ restId: restLegacy, userId: uid });
        continue;
      }
      const hash = rec && typeof rec === "object" ? (rec.password || rec.passwordHash || null) : null;
      const enc = rec && typeof rec === "object" ? (rec.passwordEnc || null) : null;
      if (!hash && !enc) {
        report.missingCredentialNode.push({ restId: restLegacy, userId: uid });
        continue;
      }
      await client.query(
        `INSERT INTO employee_credentials (employee_id, password_hash, password_enc, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (employee_id) DO UPDATE
           SET password_hash = COALESCE(EXCLUDED.password_hash, employee_credentials.password_hash),
               password_enc = COALESCE(EXCLUDED.password_enc, employee_credentials.password_enc),
               updated_at = now()`,
        [empId, hash, enc]
      );
      report.copied++;
    }
    for (const emp of emps) {
      if (!credUsers.includes(emp.legacy_rtdb_id)) {
        report.employeeWithoutCredential.push({ restId: restLegacy, userId: emp.legacy_rtdb_id });
      }
    }
  }

  client.release();
  await closePool();
  mkdirSync(AUDIT_DIR, { recursive: true });
  const out = path.join(AUDIT_DIR, "step2b-credentials-local.json");
  writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({
    copied: report.copied,
    restaurantsWithoutCredentialTree: report.restaurantsWithoutCredentialTree.length,
    employeeWithoutCredential: report.employeeWithoutCredential.length,
    credentialWithoutEmployee: report.credentialWithoutEmployee.length,
    missingCredentialNode: report.missingCredentialNode.length,
  }));
  console.log(`Wrote ${out} (gitignored JSON; no secrets)`);
}

main().catch((err) => {
  console.error("CREDENTIALS LOCAL FAILED:", err.message);
  process.exit(1);
});
