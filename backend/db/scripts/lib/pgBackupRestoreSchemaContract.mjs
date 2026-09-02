// Step 2D.4 dump/restore schema contract.
// PRE_UPGRADE_SOURCE = exact predecessor (currently 0017) for a pre-0018 backup.
// POST_UPGRADE_SOURCE = exact required version (currently 0018).
// This drill requires PRE_UPGRADE: dump/restore exact 0017, do not apply 0018.
import {
  SCHEMA_APPLY_MODE,
  SCHEMA_APPLY_REQUIRED_VERSION,
  assertSchemaApplyInvariants,
  classifySchemaApplyPath,
} from "./schemaApplySession.mjs";
import { SCHEMA_APPLY_PREDECESSOR_VERSION } from "./schemaMigrationCatalog.mjs";

export const BACKUP_SOURCE_CLASS = Object.freeze({
  PRE_UPGRADE: "PRE_UPGRADE_SOURCE",
  POST_UPGRADE: "POST_UPGRADE_SOURCE",
});

export const STEP2D4_REQUIRED_BACKUP_SOURCE_CLASS = BACKUP_SOURCE_CLASS.PRE_UPGRADE;

export function artifactClassForBackupSource(sourceClass = STEP2D4_REQUIRED_BACKUP_SOURCE_CLASS) {
  if (sourceClass === BACKUP_SOURCE_CLASS.PRE_UPGRADE) {
    return `PRE-${SCHEMA_APPLY_REQUIRED_VERSION} / PRE-UPGRADE backup`;
  }
  if (sourceClass === BACKUP_SOURCE_CLASS.POST_UPGRADE) {
    return `POST-${SCHEMA_APPLY_REQUIRED_VERSION} / POST-UPGRADE backup`;
  }
  return `UNKNOWN backup source class ${sourceClass}`;
}

export function expectedSchemaVersionForBackupSource(sourceClass = STEP2D4_REQUIRED_BACKUP_SOURCE_CLASS) {
  if (sourceClass === BACKUP_SOURCE_CLASS.PRE_UPGRADE) return SCHEMA_APPLY_PREDECESSOR_VERSION;
  if (sourceClass === BACKUP_SOURCE_CLASS.POST_UPGRADE) return SCHEMA_APPLY_REQUIRED_VERSION;
  throw new Error(`STOP: unknown backup source class ${sourceClass}`);
}

export function expectedModeForBackupSource(sourceClass = STEP2D4_REQUIRED_BACKUP_SOURCE_CLASS) {
  if (sourceClass === BACKUP_SOURCE_CLASS.PRE_UPGRADE) {
    return SCHEMA_APPLY_MODE.UPGRADE_FROM_PREDECESSOR;
  }
  if (sourceClass === BACKUP_SOURCE_CLASS.POST_UPGRADE) {
    return SCHEMA_APPLY_MODE.ALREADY_CURRENT;
  }
  throw new Error(`STOP: unknown backup source class ${sourceClass}`);
}

export function latestSchemaVersionOf(live = {}) {
  const raw = live.latestMigration;
  if (raw == null || raw === "") return "";
  if (typeof raw === "string") return raw.split(":")[0];
  return String(raw.version || "");
}

function contractFields(sourceClass, extra = {}) {
  const expectedVersion = expectedSchemaVersionForBackupSource(sourceClass);
  return {
    sourceClass,
    artifactClass: artifactClassForBackupSource(sourceClass),
    expectedVersion,
    expectedPredecessor: SCHEMA_APPLY_PREDECESSOR_VERSION,
    requiredVersion: SCHEMA_APPLY_REQUIRED_VERSION,
    expectedMode: expectedModeForBackupSource(sourceClass),
    ...extra,
  };
}

function failContract(sourceClass, reason, extra = {}) {
  return {
    ok: false,
    reason,
    ...contractFields(sourceClass, extra),
  };
}

export function evaluateBackupSourceContract({
  snap,
  live,
  repoMigrations,
  sourceClass = STEP2D4_REQUIRED_BACKUP_SOURCE_CLASS,
} = {}) {
  const latest = latestSchemaVersionOf(live);
  try {
    const classified = assertSchemaApplyInvariants({ snap, live, repoMigrations });
    const expectedMode = expectedModeForBackupSource(sourceClass);
    if (classified.mode !== expectedMode) {
      return failContract(
        sourceClass,
        `STOP: ${sourceClass} backup requires schema mode ${expectedMode} `
          + `(exact ${expectedSchemaVersionForBackupSource(sourceClass)}), `
          + `got ${classified.mode} (latest=${latest || "(none)"})`,
        { mode: classified.mode, latest },
      );
    }
    return {
      ok: true,
      reason: null,
      mode: classified.mode,
      latest,
      ...contractFields(sourceClass),
    };
  } catch (err) {
    return failContract(sourceClass, err.message, { latest });
  }
}

export function evaluateRestoredSchemaContract({
  live,
  repoMigrations,
  sourceClass = STEP2D4_REQUIRED_BACKUP_SOURCE_CLASS,
  restoreExtras = {},
} = {}) {
  const latest = latestSchemaVersionOf(live);
  const expectedMode = expectedModeForBackupSource(sourceClass);
  const classified = classifySchemaApplyPath({ live, repoMigrations });
  if (!classified.ok) {
    return failContract(sourceClass, classified.reason, { latest, mode: classified.mode });
  }
  if (classified.mode !== expectedMode) {
    return failContract(
      sourceClass,
      `STOP: restored schema is ${classified.mode} (latest=${latest || "(none)"}), `
        + `required ${expectedMode} / exact ${expectedSchemaVersionForBackupSource(sourceClass)}`,
      { latest, mode: classified.mode },
    );
  }
  if (restoreExtras.pgcrypto === false) {
    return failContract(sourceClass, "STOP: restored database is missing pgcrypto", { latest, mode: classified.mode });
  }
  if ((restoreExtras.missingRls || []).length) {
    return failContract(
      sourceClass,
      `STOP: restored RLS missing on ${restoreExtras.missingRls.join(",")}`,
      { latest, mode: classified.mode },
    );
  }
  if ((restoreExtras.missingForce || []).length) {
    return failContract(
      sourceClass,
      `STOP: restored FORCE RLS missing on ${restoreExtras.missingForce.join(",")}`,
      { latest, mode: classified.mode },
    );
  }
  if (Array.isArray(restoreExtras.requiredUniques)
    && restoreExtras.requiredUniques.some((u) => !u.ok)) {
    return failContract(sourceClass, "STOP: restored required unique constraints are incomplete", {
      latest,
      mode: classified.mode,
    });
  }
  return {
    ok: true,
    reason: null,
    mode: classified.mode,
    latest,
    ...contractFields(sourceClass),
  };
}
