// backend/scripts/migrate-credentials.mjs
//
// P0-2 residual-gap fix — one-time data migration.
//
// Moves `password`/`passwordEnc` off restaurants/$restId/users/$userId
// (where a same-restaurant employee of ANY role could read them directly
// via the Firebase REST API, because RTDB rules cascade downward for
// GRANTING only — restaurants/$restId's own broad read grant could never
// be revoked by a deeper ".read": false) onto the new, structurally
// separate credentials/$restId/$userId tree, whose rules
// (database.rules.json) are genuinely enforced there. See
// P0-2-CREDENTIAL-READ-DESIGN.md for the full analysis.
//
// SAFETY DESIGN:
//   - Defaults to DRY RUN (reports only, writes nothing). Pass --apply to
//     actually perform the migration.
//   - Before any write, --apply mode writes a full backup of every affected
//     {restId, userId, password, passwordEnc} tuple to a local, gitignored
//     JSON file (backend/_PRE_MIGRATION_BACKUP_credentials_<timestamp>.json)
//     — same recovery-artifact pattern already used for the rules deploy
//     (_PRE_DEPLOY_BACKUP_live_rules_*.json). This file DOES contain bcrypt
//     hashes / AES ciphertext — never printed to the console, never
//     committed (see .gitignore), kept on disk only for recovery.
//   - Per-user: copies password/passwordEnc to credentials/$restId/$userId
//     ONLY if not already present there (idempotent — safe to re-run),
//     verifies the copy actually landed, THEN removes the two fields from
//     the old users/$userId location. A user is never left with a
//     credential in neither location — the copy is verified before the old
//     one is deleted.
//   - Console output is restId/userId/counts only — no password, hash, or
//     ciphertext value is ever logged.
//   - Uses the Admin SDK (bypasses rules, same trusted-server pattern as
//     every other backend write in this app).
//
// Run with:
//   node backend/scripts/migrate-credentials.mjs             (dry run)
//   node backend/scripts/migrate-credentials.mjs --apply      (live run)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env") });

import { isAdminAvailable, getAdminDb } from "../firebaseAdmin.js";

const APPLY = process.argv.includes("--apply");

console.log("========================================");
console.log(APPLY ? "CREDENTIALS MIGRATION — LIVE RUN" : "CREDENTIALS MIGRATION — DRY RUN (pass --apply to write)");
console.log("========================================\n");

if (!isAdminAvailable()) {
  console.error("Firebase Admin SDK is not available (no service account configured).");
  console.error("Migration cannot proceed without Admin SDK access. Exiting — nothing was attempted.");
  process.exit(1);
}

const db = getAdminDb();

const restaurantsSnap = await db.ref("restaurants").get(); // READ ONLY at this point
const restaurants = restaurantsSnap.val() || {};

const toMigrate = [];   // { restId, userId, hasPassword, hasPasswordEnc }
const alreadyDone = []; // { restId, userId } — target already has the field(s), old location will still be cleared if stale data remains
const nothingToDo = []; // { restId, userId } — no password/passwordEnc at the old location at all

for (const [restId, restData] of Object.entries(restaurants)) {
  const users = restData?.users || {};
  for (const [userId, user] of Object.entries(users)) {
    const hasPassword = user?.password !== undefined && user?.password !== null;
    const hasPasswordEnc = user?.passwordEnc !== undefined && user?.passwordEnc !== null;
    if (!hasPassword && !hasPasswordEnc) {
      nothingToDo.push({ restId, userId });
      continue;
    }
    toMigrate.push({ restId, userId, hasPassword, hasPasswordEnc });
  }
}

console.log(`Restaurants scanned:        ${Object.keys(restaurants).length}`);
console.log(`Users with legacy password/passwordEnc at the old location: ${toMigrate.length}`);
console.log(`Users with nothing to migrate:                              ${nothingToDo.length}\n`);

if (toMigrate.length === 0) {
  console.log("Nothing to migrate. Exiting.");
  process.exit(0);
}

if (!APPLY) {
  console.log("Users that WOULD be migrated (restId / userId only — no secret values):");
  for (const u of toMigrate) {
    console.log(`  ${u.restId} / ${u.userId}  (password:${u.hasPassword} passwordEnc:${u.hasPasswordEnc})`);
  }
  console.log("\nDRY RUN — no writes performed. Re-run with --apply to migrate for real.");
  process.exit(0);
}

// ── LIVE RUN below ──────────────────────────────────────────────────────

// Backup, BEFORE any write — local file only, gitignored, never printed.
const backupData = {};
for (const { restId, userId } of toMigrate) {
  const user = restaurants[restId].users[userId];
  backupData[restId] = backupData[restId] || {};
  backupData[restId][userId] = {
    password: user.password ?? null,
    passwordEnc: user.passwordEnc ?? null,
  };
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(__dirname, "..", `_PRE_MIGRATION_BACKUP_credentials_${stamp}.json`);
fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2), "utf8");
console.log(`Backup written to ${backupPath} (contains real hashes/ciphertext — keep local, already gitignored).\n`);

let migrated = 0;
let skippedAlreadyPresent = 0;
let errors = 0;

for (const { restId, userId, hasPassword, hasPasswordEnc } of toMigrate) {
  try {
    const user = restaurants[restId].users[userId];
    const credRef = db.ref(`credentials/${restId}/${userId}`);
    const existingCredSnap = await credRef.get();
    const existingCred = existingCredSnap.val() || {};

    const toWrite = {};
    if (hasPassword && existingCred.password === undefined) toWrite.password = user.password;
    if (hasPasswordEnc && existingCred.passwordEnc === undefined) toWrite.passwordEnc = user.passwordEnc;

    if (Object.keys(toWrite).length > 0) {
      await credRef.update(toWrite);
    }

    // Verify the target now has whatever the source had, THEN clear the
    // source — never delete the old copy before confirming the new one
    // exists, so a mid-migration crash can never leave a user with no
    // credential anywhere.
    const verifySnap = await credRef.get();
    const verifyVal = verifySnap.val() || {};
    const passwordOk = !hasPassword || verifyVal.password !== undefined;
    const passwordEncOk = !hasPasswordEnc || verifyVal.passwordEnc !== undefined;

    if (!passwordOk || !passwordEncOk) {
      console.error(`  FAILED verify — ${restId} / ${userId} — target missing expected field(s) after write, old location left untouched.`);
      errors++;
      continue;
    }

    const oldFieldClear = {};
    if (hasPassword) oldFieldClear.password = null;
    if (hasPasswordEnc) oldFieldClear.passwordEnc = null;
    await db.ref(`restaurants/${restId}/users/${userId}`).update(oldFieldClear);

    if (Object.keys(toWrite).length === 0) skippedAlreadyPresent++;
    console.log(`  OK — ${restId} / ${userId}`);
    migrated++;
  } catch (err) {
    console.error(`  ERROR — ${restId} / ${userId} — ${err.message}`);
    errors++;
  }
}

console.log("\n========================================");
console.log(`Migrated (old location cleared): ${migrated}`);
console.log(`  of which already had a target copy (only old location cleared): ${skippedAlreadyPresent}`);
console.log(`Errors (old location left untouched): ${errors}`);
console.log("========================================");

process.exit(errors > 0 ? 1 : 0);
