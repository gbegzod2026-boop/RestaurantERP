// backend/scripts/migration-dry-run.mjs
//
// ════════════════════════════════════════════════════════════════════════
//  ⚠️  DRY-RUN ONLY — THIS SCRIPT NEVER WRITES ANYTHING, ANYWHERE.  ⚠️
// ════════════════════════════════════════════════════════════════════════
//
// Purpose: inventory/compare RTDB restaurant users against Firebase
// Authentication users, ahead of a possible future migration (Variant B —
// see the plan discussed separately) that would give every RTDB
// restaurant user its own Firebase Auth record, keyed by a deterministic,
// globally-unique synthetic UID:
//
//     proposedFirebaseUid = `${restId}__${rtdbUid}`
//
// This is necessary because RTDB uids (e.g. "admin_1") are only unique
// WITHIN a restaurant — the same string is reused across every restaurant
// — so they can never be used as a Firebase Auth UID directly (Firebase
// Auth UIDs must be globally unique).
//
// SAFETY DESIGN — read this before ever touching this file again:
//   - Every Firebase-touching function below is explicitly named
//     read*()/list*() and does ONLY reads (admin.database().ref(...).get(),
//     admin.auth().listUsers()). There is no function in this file capable
//     of writing anywhere.
//   - No migration/create/write logic exists here, not even commented out.
//     A future migration script must be a SEPARATE file, explicitly
//     reviewed and approved on its own — never "uncommented" from this one.
//   - Nothing here calls any of: createUser, importUsers,
//     setCustomUserClaims, updateUser, disableUser, deleteUser, RTDB set,
//     update, remove, transaction, push. (Verified by static grep as part
//     of this task — see the final report.)
//   - No password, password hash (bcrypt or legacy SHA-256), passwordEnc
//     ciphertext, Firebase ID token, or custom token is ever read into a
//     variable here, let alone printed — only non-secret metadata
//     (restId, uid, name, login *username string*, role, active) is
//     touched.
//
// Run with:  node backend/scripts/migration-dry-run.mjs
// (safe to run from any working directory — see the dotenv path handling
// below, which resolves backend/.env relative to this file, not to CWD.)

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// This script lives in backend/scripts/ — resolve backend/.env relative to
// THIS file's location so it works regardless of the caller's CWD, without
// requiring any change to the existing app's own dotenv.config() call in
// server.js (which only runs when the app itself starts).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// Reuses the project's EXISTING Admin SDK initialization module as-is —
// no second Firebase init architecture introduced. This module is only
// ever asked for its Auth/Database handles below; nothing about it is
// modified.
import { isAdminAvailable, getAdminAuth, getAdminDb } from "../firebaseAdmin.js";

console.log("========================================");
console.log("FIREBASE AUTH MIGRATION DRY RUN");
console.log("READ ONLY — NO FIREBASE WRITES WILL OCCUR");
console.log("========================================\n");

if (!isAdminAvailable()) {
  console.error("Firebase Admin SDK is not available (no service account configured).");
  console.error("Dry-run cannot proceed without read access. Exiting — nothing was attempted.");
  process.exit(1);
}

const auth = getAdminAuth();
const db = getAdminDb({ purpose: "migration" });

// ────────────────────────────────────────────────────────────────────────
// READ-ONLY: RTDB restaurant users
// ────────────────────────────────────────────────────────────────────────
async function readRtdbUsers() {
  const snap = await db.ref("restaurants").get(); // READ ONLY
  const restaurants = snap.val() || {};
  const users = [];
  const malformed = [];

  for (const [restId, rest] of Object.entries(restaurants)) {
    if (!restId || typeof restId !== "string") {
      malformed.push({ reason: "missing/invalid restId at top level", restIdSeen: restId });
      continue;
    }
    const userMap = rest?.users;
    if (userMap == null) continue; // restaurant with no users yet — not malformed, just empty
    if (typeof userMap !== "object" || Array.isArray(userMap)) {
      malformed.push({ restId, reason: "users node is not an object" });
      continue;
    }

    for (const [rtdbUid, u] of Object.entries(userMap)) {
      if (!rtdbUid || typeof rtdbUid !== "string") {
        malformed.push({ restId, reason: "missing/invalid rtdbUid", uidSeen: rtdbUid });
        continue;
      }
      if (u == null || typeof u !== "object") {
        malformed.push({ restId, rtdbUid, reason: "user record is not an object" });
        continue;
      }

      users.push({
        restId,
        rtdbUid,
        name: typeof u.name === "string" ? u.name : null,
        login: typeof u.login === "string" ? u.login : null, // username string, not a secret
        role: typeof u.role === "string" ? u.role : null,
        active: u.active !== false,
        proposedFirebaseUid: `${restId}__${rtdbUid}`,
        // Explicitly NEVER carried forward: u.password, u.passwordEnc.
      });
    }
  }

  return { users, malformed };
}

// ────────────────────────────────────────────────────────────────────────
// READ-ONLY: Firebase Auth users (paginated — do not assume one page)
// ────────────────────────────────────────────────────────────────────────
async function listAllFirebaseAuthUsers() {
  const byUid = new Map(); // uid -> { uid, disabled, hasEmail, hasPhone, providerCount, creationTime }
  let pageToken = undefined;
  let pages = 0;

  do {
    const result = await auth.listUsers(1000, pageToken); // READ ONLY
    pages++;
    for (const u of result.users) {
      byUid.set(u.uid, {
        uid: u.uid,
        disabled: u.disabled,
        hasEmail: !!u.email,
        hasPhone: !!u.phoneNumber,
        providerCount: Array.isArray(u.providerData) ? u.providerData.length : 0,
        creationTime: u.metadata?.creationTime || null,
      });
    }
    pageToken = result.pageToken;
  } while (pageToken);

  return { byUid, pages };
}

// ────────────────────────────────────────────────────────────────────────
// MAIN — read, compare, classify, report. No writes anywhere below.
// ────────────────────────────────────────────────────────────────────────
const { users: rtdbUsers, malformed: malformedRtdb } = await readRtdbUsers();
const { byUid: authUsersByUid, pages: authPages } = await listAllFirebaseAuthUsers();

// Conflict A: two different (restId, rtdbUid) pairs producing the same
// proposedFirebaseUid. Structurally shouldn't happen (restId itself is
// unique, so the concatenation is unique) unless a restId literally
// contains the "__" separator followed by content that collides with
// another restId+uid combination — checked for defensively anyway.
const proposedUidOwners = new Map(); // proposedFirebaseUid -> [ {restId, rtdbUid}, ... ]
for (const u of rtdbUsers) {
  const list = proposedUidOwners.get(u.proposedFirebaseUid) || [];
  list.push({ restId: u.restId, rtdbUid: u.rtdbUid });
  proposedUidOwners.set(u.proposedFirebaseUid, list);
}
const conflictsA = [...proposedUidOwners.entries()].filter(([, owners]) => owners.length > 1);

// Conflict E: duplicate RTDB user keys inside the same restaurant. Object
// keys in a JS object read from RTDB can't literally duplicate (RTDB
// itself enforces unique child keys), but this is checked defensively in
// case of any unexpected data shape.
const seenRestUidPairs = new Set();
const conflictsE = [];
for (const u of rtdbUsers) {
  const key = `${u.restId} ${u.rtdbUid}`;
  if (seenRestUidPairs.has(key)) {
    conflictsE.push({ restId: u.restId, rtdbUid: u.rtdbUid });
  }
  seenRestUidPairs.add(key);
}

// Classification per user: CREATE_REQUIRED vs ALREADY_EXISTS, plus
// Conflict B: an existing Firebase Auth user at the proposed UID with
// metadata that looks unexpected for a "shell" migration account (has an
// email/phone/provider, i.e. looks like a real, independently-created
// account rather than one this migration would have made).
const createRequired = [];
const alreadyExists = [];
const conflictsB = [];

for (const u of rtdbUsers) {
  const existing = authUsersByUid.get(u.proposedFirebaseUid);
  if (!existing) {
    createRequired.push(u);
  } else {
    alreadyExists.push({ ...u, existingMeta: existing });
    if (existing.hasEmail || existing.hasPhone || existing.providerCount > 0) {
      conflictsB.push({
        proposedFirebaseUid: u.proposedFirebaseUid,
        restId: u.restId,
        rtdbUid: u.rtdbUid,
        reason: "existing Firebase Auth user at this UID has email/phone/provider data — unexpected for a migration shell account",
        existingMeta: existing,
      });
    }
  }
}

// Role / active summary
const roleCounts = {};
let activeCount = 0;
let inactiveCount = 0;
let missingRoleCount = 0;
for (const u of rtdbUsers) {
  const roleKey = u.role || "(missing role)";
  roleCounts[roleKey] = (roleCounts[roleKey] || 0) + 1;
  if (!u.role) missingRoleCount++;
  if (u.active) activeCount++; else inactiveCount++;
}

// Firebase Auth users with no corresponding RTDB proposed UID at all —
// informational only, never touched.
const proposedUidSet = new Set(rtdbUsers.map(u => u.proposedFirebaseUid));
const unrelatedAuthUsersCount = [...authUsersByUid.keys()].filter(uid => !proposedUidSet.has(uid)).length;

const malformedCount = malformedRtdb.length;
const conflictCount = conflictsA.length + conflictsB.length + conflictsE.length;

// ────────────────────────────────────────────────────────────────────────
// OUTPUT
// ────────────────────────────────────────────────────────────────────────
console.log(`RTDB users:                 ${rtdbUsers.length}`);
console.log(`Firebase Auth users:        ${authUsersByUid.size}  (fetched in ${authPages} page(s))`);
console.log(`Already mapped:             ${alreadyExists.length}`);
console.log(`Create required:            ${createRequired.length}`);
console.log(`Conflicts:                  ${conflictCount}`);
console.log(`Malformed:                  ${malformedCount}`);
console.log(`Firebase Auth users unrelated to RTDB restaurant users: ${unrelatedAuthUsersCount}`);
console.log("  (informational only — not deleted, not modified)\n");

console.log("----------------------------------------");
console.log("CREATE REQUIRED");
console.log("----------------------------------------");
if (createRequired.length === 0) {
  console.log("NONE");
} else {
  for (const u of createRequired) {
    console.log(u.proposedFirebaseUid);
    console.log(`  restaurant: ${u.restId}`);
    console.log(`  RTDB uid:   ${u.rtdbUid}`);
    console.log(`  role:       ${u.role || "(missing)"}`);
    console.log(`  active:     ${u.active}`);
    console.log("");
  }
}

console.log("----------------------------------------");
console.log("ALREADY EXISTS");
console.log("----------------------------------------");
if (alreadyExists.length === 0) {
  console.log("NONE");
} else {
  for (const u of alreadyExists) {
    console.log(u.proposedFirebaseUid);
    console.log(`  restaurant: ${u.restId}`);
    console.log(`  RTDB uid:   ${u.rtdbUid}`);
    console.log(`  role:       ${u.role || "(missing)"}`);
    console.log(`  existing auth disabled: ${u.existingMeta.disabled}`);
    console.log("");
  }
}

console.log("----------------------------------------");
console.log("CONFLICTS");
console.log("----------------------------------------");
if (conflictCount === 0) {
  console.log("NONE");
} else {
  if (conflictsA.length > 0) {
    console.log("A) Same proposed Firebase UID from different RTDB pairs:");
    for (const [uid, owners] of conflictsA) console.log(`   ${uid} <- ${JSON.stringify(owners)}`);
  }
  if (conflictsB.length > 0) {
    console.log("B) Existing Firebase Auth user with unexpected metadata:");
    for (const c of conflictsB) console.log(`   ${JSON.stringify(c)}`);
  }
  if (conflictsE.length > 0) {
    console.log("E) Duplicate RTDB (restId, uid) pair encountered:");
    for (const c of conflictsE) console.log(`   ${JSON.stringify(c)}`);
  }
}

console.log("\n----------------------------------------");
console.log("MALFORMED RECORDS (C, D, F)");
console.log("----------------------------------------");
if (malformedCount === 0) {
  console.log("NONE");
} else {
  for (const m of malformedRtdb) console.log(`   ${JSON.stringify(m)}`);
}

console.log("\n----------------------------------------");
console.log("ROLE SUMMARY");
console.log("----------------------------------------");
for (const [role, count] of Object.entries(roleCounts)) {
  console.log(`${role}: ${count}`);
}
console.log(`\nactive users:   ${activeCount}`);
console.log(`inactive users: ${inactiveCount}`);
console.log(`missing role:   ${missingRoleCount}`);

console.log("\n========================================");
console.log("NO WRITES PERFORMED");
console.log("========================================");
console.log("NO FIREBASE WRITES WERE PERFORMED.");

process.exit(0);
