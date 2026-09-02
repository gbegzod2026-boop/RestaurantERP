import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import {
  evaluateProductionApplyAuthorization,
  authorizeProductionMigrationApply,
  explicitProductionApplyAuthorized,
  PRODUCTION_APPLY_AUTHORIZATION_PHRASE,
  PRODUCTION_APPLY_AUTHORIZATION_FLAG,
  PRODUCTION_APPLY_AUTHORIZATION_ENV,
} from "../scripts/lib/productionMigrateAuthorize.mjs";
import {
  PRODUCTION_CONFIRM_PHRASE,
  PRODUCTION_REQUIRED_TAG,
  REQUIRED_SCHEMA_VERSION,
} from "../scripts/lib/migrationTargetGuard.mjs";
import {
  CUTOVER_CANDIDATE_TAG,
  HISTORICAL_FROZEN_TAG,
  STEP2C_TAG,
  reviewedCutoverApprovalMessage,
  REQUIRED_FREEZE_BRANCH,
} from "../scripts/lib/deployFreeze.mjs";
import {
  buildWriteStopEvidence,
  buildFreezeEvidence,
  computeCutoverWindowIdentity,
  CUTOVER_EVIDENCE_TTL_MS,
} from "../scripts/lib/cutoverWindow.mjs";
import { evaluateStep2dFinalGates, EXPECTED_PAUSE_CONFIRM } from "../scripts/lib/step2dFinalGate.mjs";
import { REQUIRED_PRODUCTION_PROBE_ORIGIN } from "../scripts/lib/deployedRevision.mjs";
import { sanitizeLiveRailwayPreflightResult } from "../scripts/lib/runRailwayLivePreflight.mjs";
import { canonicalRlsCatalogRows } from "../scripts/lib/tenantCatalog.mjs";
import {
  REQUIRED_PREFLIGHT_ROLES,
  REQUIRED_PREFLIGHT_UNIQUES,
  EXPECTED_TENANT_CATALOG_COUNT,
  REQUIRED_CONFIGURED_POOL_MAX,
} from "../scripts/lib/runRailwayLivePreflight.mjs";
import {
  EXAMPLE_TARGET_FACTS,
  exampleLiveTargetFingerprint,
  targetFingerprintFromFacts,
} from "../scripts/lib/pgTargetFingerprint.mjs";
import {
  ATTEMPT_STATUS,
  MIGRATION_PHASE,
  PRODUCTION_MIGRATE_ATTEMPT_ID_ENV,
  createMemoryAttemptStore,
  newAttemptRow,
  attemptBindingFromContext,
  evaluateMigrationPhaseAdmission,
} from "../scripts/lib/productionMigrationAttempt.mjs";

const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NOW = Date.parse("2026-08-31T10:30:00.000Z");
const WRITE_AT = "2026-08-31T10:10:00.000Z";
const FREEZE_AT = "2026-08-31T10:15:00.000Z";

function identityFor(sha = HEAD_SHA) {
  return computeCutoverWindowIdentity({
    candidateCommit: sha,
    remoteMain: sha,
    deployedRevision: sha,
  });
}

function twelveCounts() {
  return {
    restaurants: 1,
    users: 1,
    employees: 1,
    orders: 1,
    orderItems: 1,
    payments: 1,
    menu: 1,
    tables: 1,
    customers: 1,
    credentialTrees: 1,
    customRoles: 1,
    platformPromoCodes: 1,
  };
}

function passWrite(overrides = {}) {
  return {
    ...buildWriteStopEvidence({
      classified: {
        productionWriteStop: "PASS",
        maintenance: "ON",
        writeObserved: false,
        tenantWriteBlocked: true,
        clickBlocked: true,
        paymeBlocked: true,
        uzumBlocked: true,
      },
      generatedAt: WRITE_AT,
      origin: REQUIRED_PRODUCTION_PROBE_ORIGIN,
      candidateCommit: HEAD_SHA,
      cutoverWindowIdentity: identityFor(),
    }),
    ...overrides,
  };
}

function passFreeze(overrides = {}) {
  return {
    ...buildFreezeEvidence({
      generatedAt: FREEZE_AT,
      firebaseProject: "restoran-30d51",
      counts: twelveCounts(),
      candidateCommit: HEAD_SHA,
      cutoverWindowIdentity: identityFor(),
    }),
    ...overrides,
  };
}

function approvalGit(overrides = {}) {
  const head = overrides.head || HEAD_SHA;
  return {
    head,
    tag: overrides.tag === undefined ? head : overrides.tag,
    dirty: false,
    candidateTag: CUTOVER_CANDIDATE_TAG,
    tagType: "tag",
    tagAnnotation: reviewedCutoverApprovalMessage(),
    branch: REQUIRED_FREEZE_BRANCH,
    originMain: OTHER_SHA,
    ...overrides,
  };
}

function armedEnv(extra = {}) {
  return {
    NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED",
    NESTA_PAYMENT_PAUSE_CONFIRM: EXPECTED_PAUSE_CONFIRM,
    NESTA_MAINTENANCE_MODE: "1",
    NESTA_MIGRATE_TARGET: "production",
    NESTA_PRODUCTION_MIGRATE_CONFIRM: PRODUCTION_CONFIRM_PHRASE,
    NESTA_PRODUCTION_MIGRATE_TAG: PRODUCTION_REQUIRED_TAG,
    POSTGRES_SSL: "true",
    ...extra,
  };
}

function authorizeArgv() {
  return [PRODUCTION_APPLY_AUTHORIZATION_FLAG];
}

function authorizeEnv(extra = {}) {
  return armedEnv({
    [PRODUCTION_APPLY_AUTHORIZATION_ENV]: PRODUCTION_APPLY_AUTHORIZATION_PHRASE,
    ...extra,
  });
}

function armedWindow(extra = {}) {
  return {
    env: armedEnv(),
    argv: [],
    backups: { firebase: 1, pg: 1, appConfig: 1 },
    git: approvalGit(),
    railwayLivePreflight: "PASS",
    runtimeRevision: HEAD_SHA,
    liveRemoteMain: HEAD_SHA,
    writeStopEvidence: passWrite(),
    freezeEvidence: passFreeze(),
    now: NOW,
    ...extra,
  };
}

function passLiveResult(overrides = {}) {
  return sanitizeLiveRailwayPreflightResult({
    ok: true,
    verdict: "GO",
    mode: "READ-ONLY",
    readOnly: true,
    executed: true,
    status: "PASS",
    hostClass: "*.proxy.rlwy.net",
    database: "railway",
    sslLive: "on",
    pgcrypto: true,
    latestMigration: { version: REQUIRED_SCHEMA_VERSION },
    restaurants: 0,
    fixtureLike: 0,
    configuredPoolMax: REQUIRED_CONFIGURED_POOL_MAX,
    rolesPresent: [...REQUIRED_PREFLIGHT_ROLES],
    requiredUniques: REQUIRED_PREFLIGHT_UNIQUES.map((spec) => ({
      table: spec.table,
      cols: [...spec.cols],
      ok: true,
    })),
    rls: canonicalRlsCatalogRows(),
    rlsCatalogCount: EXPECTED_TENANT_CATALOG_COUNT,
    targetFingerprint: exampleLiveTargetFingerprint(),
    failures: [],
    ...overrides,
  });
}

function currentBinding() {
  return attemptBindingFromContext({
    targetFingerprint: exampleLiveTargetFingerprint(),
    candidateCommit: HEAD_SHA,
    reviewedTag: CUTOVER_CANDIDATE_TAG,
    cutoverWindowIdentity: identityFor(),
    freezeEvidence: passFreeze(),
    firebaseProject: "restoran-30d51",
  });
}

function defaultPhaseFor(status) {
  if (status === ATTEMPT_STATUS.WAVE1_COMPLETE || status === ATTEMPT_STATUS.FULL_COMPLETE) {
    return MIGRATION_PHASE.FULL_AFTER_WAVE1;
  }
  if (status === ATTEMPT_STATUS.FULL_IN_PROGRESS) return MIGRATION_PHASE.FULL_AFTER_WAVE1;
  return MIGRATION_PHASE.WAVE1_INITIAL;
}

function seedAttempt(status, extra = {}) {
  const row = newAttemptRow(currentBinding(), { now: new Date(NOW) });
  return {
    ...row,
    status,
    phase: extra.phase || defaultPhaseFor(status),
    transition_epoch: extra.transition_epoch ?? 0,
    ...extra,
  };
}

function emptyProductionClient({ restaurants = 0, fixtures = 0 } = {}) {
  return {
    async query(sql, params) {
      const s = String(sql);
      if (s.includes("set_config")) return { rows: [] };
      if (s.includes("schema_migrations")) return { rows: [{ version: REQUIRED_SCHEMA_VERSION }] };
      if (s.includes("pg_class")) {
        const names = params?.[0] || ["restaurants", "employees", "orders", "order_items", "payments", "custom_roles"];
        return {
          rows: names.map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })),
        };
      }
      if (s.includes("rest_1999")) return { rows: [{ n: fixtures }] };
      if (s.includes("FROM restaurants")) return { rows: [{ n: restaurants }] };
      return { rows: [] };
    },
  };
}

async function matchingIdentity() {
  return { fingerprint: exampleLiveTargetFingerprint(), facts: EXAMPLE_TARGET_FACTS };
}

function identityFromFacts(facts) {
  return { fingerprint: targetFingerprintFromFacts(facts), facts };
}

function authorizeArgs(extra = {}) {
  return {
    ...armedWindow(),
    env: authorizeEnv(extra.env || {}),
    argv: extra.argv || authorizeArgv(),
    client: extra.client || emptyProductionClient({ restaurants: extra.restaurants ?? 0 }),
    masked: extra.masked || { ...maskedProd, port: "12345" },
    writesCommitted: extra.writesCommitted !== false,
    liveResult: extra.liveResult || passLiveResult({ restaurants: extra.restaurants ?? 0 }),
    attemptStore: extra.attemptStore || createMemoryAttemptStore(extra.seed || []),
    readTargetIdentityImpl: extra.readTargetIdentityImpl || matchingIdentity,
    phase: extra.phase || MIGRATION_PHASE.WAVE1_INITIAL,
  };
}

const maskedProd = { host: "switchback.proxy.rlwy.net", database: "railway", user: "migrator" };

test("explicit apply authorization is exact byte-for-byte and not yes/true/1 or the confirm phrase", () => {
  assert.equal(explicitProductionApplyAuthorized({
    env: authorizeEnv(),
    argv: authorizeArgv(),
  }), true);
  assert.equal(explicitProductionApplyAuthorized({
    env: armedEnv({ [PRODUCTION_APPLY_AUTHORIZATION_ENV]: PRODUCTION_APPLY_AUTHORIZATION_PHRASE }),
    argv: [],
  }), false);
  assert.equal(explicitProductionApplyAuthorized({
    env: armedEnv({ [PRODUCTION_APPLY_AUTHORIZATION_ENV]: ` ${PRODUCTION_APPLY_AUTHORIZATION_PHRASE}` }),
    argv: authorizeArgv(),
  }), false);
  assert.equal(explicitProductionApplyAuthorized({
    env: armedEnv({ [PRODUCTION_APPLY_AUTHORIZATION_ENV]: `${PRODUCTION_APPLY_AUTHORIZATION_PHRASE} ` }),
    argv: authorizeArgv(),
  }), false);
  assert.equal(explicitProductionApplyAuthorized({
    env: armedEnv({ [PRODUCTION_APPLY_AUTHORIZATION_ENV]: `${PRODUCTION_APPLY_AUTHORIZATION_PHRASE}\n` }),
    argv: authorizeArgv(),
  }), false);
  assert.equal(explicitProductionApplyAuthorized({
    env: armedEnv({ [PRODUCTION_APPLY_AUTHORIZATION_ENV]: `${PRODUCTION_APPLY_AUTHORIZATION_PHRASE}\t` }),
    argv: authorizeArgv(),
  }), false);
  assert.equal(explicitProductionApplyAuthorized({
    env: armedEnv({ [PRODUCTION_APPLY_AUTHORIZATION_ENV]: PRODUCTION_APPLY_AUTHORIZATION_PHRASE.toLowerCase() }),
    argv: authorizeArgv(),
  }), false);
  assert.equal(explicitProductionApplyAuthorized({
    env: armedEnv({ [PRODUCTION_APPLY_AUTHORIZATION_ENV]: `x${PRODUCTION_APPLY_AUTHORIZATION_PHRASE}` }),
    argv: authorizeArgv(),
  }), false);
  assert.equal(explicitProductionApplyAuthorized({
    env: armedEnv({ [PRODUCTION_APPLY_AUTHORIZATION_ENV]: "yes" }),
    argv: authorizeArgv(),
  }), false);
  assert.equal(explicitProductionApplyAuthorized({
    env: armedEnv({ [PRODUCTION_APPLY_AUTHORIZATION_ENV]: "true" }),
    argv: authorizeArgv(),
  }), false);
  assert.equal(explicitProductionApplyAuthorized({
    env: armedEnv({ [PRODUCTION_APPLY_AUTHORIZATION_ENV]: "1" }),
    argv: authorizeArgv(),
  }), false);
  assert.equal(explicitProductionApplyAuthorized({
    env: armedEnv({ [PRODUCTION_APPLY_AUTHORIZATION_ENV]: PRODUCTION_CONFIRM_PHRASE }),
    argv: authorizeArgv(),
  }), false);
  assert.equal(explicitProductionApplyAuthorized({
    env: armedEnv({ [PRODUCTION_APPLY_AUTHORIZATION_ENV]: HISTORICAL_FROZEN_TAG }),
    argv: authorizeArgv(),
  }), false);
});

test("safeToMigrateProductionData stays false before explicit production apply authorization", () => {
  const preflight = evaluateStep2dFinalGates({
    ...armedWindow(),
    humanApprovalPresent: true,
  });
  assert.equal(preflight.cutoverWindowArmed, true);
  assert.equal(preflight.safeToMigrateProductionData, false);
  assert.equal(preflight.migrationAuthorized, false);

  const noAuth = evaluateProductionApplyAuthorization(armedWindow());
  assert.equal(noAuth.ok, false);
  assert.equal(noAuth.reason, "explicit production apply authorization required");
  assert.equal(noAuth.cutoverWindowArmed, true);
  assert.equal(noAuth.safeToMigrateProductionData, false);
  assert.equal(noAuth.migrationAuthorized, false);
});

test("armed window plus one-shot authorization may proceed to live PG invariants", () => {
  const r = evaluateProductionApplyAuthorization({
    ...armedWindow(),
    env: authorizeEnv(),
    argv: authorizeArgv(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.cutoverWindowArmed, true);
  assert.equal(r.explicitAuthorization, true);
  assert.equal(r.safeToMigrateProductionData, false);
  assert.equal(r.migrationAuthorized, false);
});

test("historical nesta-step2-cutover-ready cannot arm production apply", () => {
  const r = evaluateProductionApplyAuthorization({
    ...armedWindow({
      git: approvalGit({ candidateTag: HISTORICAL_FROZEN_TAG }),
      env: authorizeEnv(),
      argv: authorizeArgv(),
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.cutoverWindowArmed, false);
  assert.equal(r.approvalBlockers.includes("deployFreeze"), true);
});

test("historical Step2C tag cannot arm production apply", () => {
  const r = evaluateProductionApplyAuthorization({
    ...armedWindow({
      git: approvalGit({ candidateTag: STEP2C_TAG }),
      env: authorizeEnv(),
      argv: authorizeArgv(),
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.approvalBlockers.includes("deployFreeze"), true);
});

test("arbitrary tag cannot arm production apply", () => {
  const r = evaluateProductionApplyAuthorization({
    ...armedWindow({
      git: approvalGit({ candidateTag: "nesta-random-tag" }),
      env: authorizeEnv(),
      argv: authorizeArgv(),
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.approvalBlockers.includes("deployFreeze"), true);
});

test("correct env tag but wrong annotated tag target fails", () => {
  const r = evaluateProductionApplyAuthorization({
    ...armedWindow({
      git: approvalGit({ tag: OTHER_SHA }),
      env: authorizeEnv(),
      argv: authorizeArgv(),
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.approvalBlockers.includes("deployFreeze"), true);
});

test("correct env tag but non-main branch fails", () => {
  const r = evaluateProductionApplyAuthorization({
    ...armedWindow({
      git: approvalGit({ branch: "feature" }),
      env: authorizeEnv(),
      argv: authorizeArgv(),
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.approvalBlockers.includes("deployFreeze"), true);
});

test("correct env tag but dirty tree fails", () => {
  const r = evaluateProductionApplyAuthorization({
    ...armedWindow({
      git: approvalGit({ dirty: true }),
      env: authorizeEnv(),
      argv: authorizeArgv(),
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.approvalBlockers.includes("workingTreeFreeze"), true);
});

test("correct env tag but live GitHub mismatch fails", () => {
  const r = evaluateProductionApplyAuthorization({
    ...armedWindow({
      liveRemoteMain: OTHER_SHA,
      env: authorizeEnv(),
      argv: authorizeArgv(),
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.approvalBlockers.includes("originMainMatch"), true);
});

test("correct env tag but Railway revision mismatch fails", () => {
  const r = evaluateProductionApplyAuthorization({
    ...armedWindow({
      runtimeRevision: OTHER_SHA,
      env: authorizeEnv(),
      argv: authorizeArgv(),
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.approvalBlockers.includes("deployedRevision"), true);
});

test("stale WRITE_STOP fails production apply", () => {
  const r = evaluateProductionApplyAuthorization({
    ...armedWindow({
      writeStopEvidence: passWrite({
        generatedAt: new Date(NOW - CUTOVER_EVIDENCE_TTL_MS - 5_000).toISOString(),
      }),
      env: authorizeEnv(),
      argv: authorizeArgv(),
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.approvalBlockers.includes("productionWriteStop"), true);
});

test("stale FREEZE fails production apply", () => {
  const r = evaluateProductionApplyAuthorization({
    ...armedWindow({
      freezeEvidence: passFreeze({
        generatedAt: new Date(NOW - CUTOVER_EVIDENCE_TTL_MS - 5_000).toISOString(),
      }),
      env: authorizeEnv(),
      argv: authorizeArgv(),
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.approvalBlockers.includes("finalFirebaseSnapshot"), true);
});

test("maintenance OFF fails production apply", () => {
  const r = evaluateProductionApplyAuthorization({
    ...armedWindow({
      env: authorizeEnv({ NESTA_MAINTENANCE_MODE: "0" }),
      argv: authorizeArgv(),
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.approvalBlockers.includes("maintenanceMode"), true);
});

test("PG preflight NO-GO fails production apply", () => {
  const r = evaluateProductionApplyAuthorization({
    ...armedWindow({
      railwayLivePreflight: "FAIL",
      env: authorizeEnv(),
      argv: authorizeArgv(),
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.approvalBlockers.includes("railwayPgSchema"), true);
});

test("no explicit human authorization fails even when the window is armed", () => {
  const r = evaluateProductionApplyAuthorization(armedWindow());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "explicit production apply authorization required");
  assert.equal(r.cutoverWindowArmed, true);
  assert.equal(r.safeToMigrateProductionData, false);
});

test("production apply PASS requires reviewed tag, current-window evidence, exact target, and a new Wave1 attempt", async () => {
  const r = await authorizeProductionMigrationApply(authorizeArgs());
  assert.equal(r.ok, true);
  assert.equal(r.mode, "production");
  assert.equal(r.authorized, true);
  assert.equal(r.cutoverWindowArmed, true);
  assert.equal(r.explicitAuthorization, true);
  assert.equal(r.safeToMigrateProductionData, true);
  assert.equal(r.migrationAuthorized, true);
  assert.equal(r.phase, MIGRATION_PHASE.WAVE1_INITIAL);
  assert.equal(r.allowPopulatedTarget, false);
  assert.equal(r.attempt.status, ATTEMPT_STATUS.WAVE1_IN_PROGRESS);
  assert.equal(r.targetFingerprint, exampleLiveTargetFingerprint());
});

test("historical env tag is refused by the live apply invariants path", async () => {
  await assert.rejects(
    () => authorizeProductionMigrationApply(authorizeArgs({
      env: { NESTA_PRODUCTION_MIGRATE_TAG: HISTORICAL_FROZEN_TAG },
    })),
    /NO-GO/,
  );
});

test("wave1 and full migrate scripts use the production apply gate", () => {
  const wave1 = readFileSync(new URL("../scripts/migrate-wave1-apply.mjs", import.meta.url), "utf8");
  const full = readFileSync(new URL("../scripts/migrate-firebase.mjs", import.meta.url), "utf8");
  assert.match(wave1, /enforceProductionApplyGate/);
  assert.match(full, /enforceProductionApplyGate/);
  assert.match(wave1, /WAVE1_COMPLETE/);
  assert.match(full, /commitRestaurantThenCheckpoint/);
  assert.match(full, /FULL_AFTER_WAVE1/);
  assert.equal(wave1.includes("enforceConnectedApplyTarget("), false);
  assert.equal(full.includes("enforceConnectedApplyTarget("), false);
  const commitIdx = full.indexOf("commitRestaurantThenCheckpoint");
  const saveBeforeCommit = /saveCheckpoint\(checkpoint\);\s*[\s\S]{0,80}COMMIT/.test(full);
  assert.equal(saveBeforeCommit, false);
  assert.ok(commitIdx > 0);
});

test("populated target first Wave1 fails; empty Wave1 passes", async () => {
  await assert.rejects(
    () => authorizeProductionMigrationApply(authorizeArgs({ restaurants: 1 })),
    /restaurants is not 0|empty production target/,
  );
  const empty = await authorizeProductionMigrationApply(authorizeArgs({ restaurants: 0 }));
  assert.equal(empty.attempt.status, ATTEMPT_STATUS.WAVE1_IN_PROGRESS);
  assert.equal(empty.allowPopulatedTarget, false);
});

test("Wave1 COMPLETE matching attempt allows full apply on the populated target", async () => {
  const seeded = seedAttempt(ATTEMPT_STATUS.WAVE1_COMPLETE);
  const r = await authorizeProductionMigrationApply(authorizeArgs({
    restaurants: 1,
    phase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
    seed: [seeded],
    env: { [PRODUCTION_MIGRATE_ATTEMPT_ID_ENV]: seeded.attempt_id },
    argv: [],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.allowPopulatedTarget, true);
  assert.equal(r.attempt.status, ATTEMPT_STATUS.FULL_IN_PROGRESS);
  assert.equal(r.explicitAuthorization, false);
});

test("populated target without attempt fails", async () => {
  await assert.rejects(
    () => authorizeProductionMigrationApply(authorizeArgs({
      restaurants: 1,
      phase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
      argv: [],
    })),
    /NESTA_PRODUCTION_MIGRATE_ATTEMPT_ID|no matching durable/,
  );
});

test("populated target wrong attempt fails", async () => {
  const seeded = seedAttempt(ATTEMPT_STATUS.WAVE1_COMPLETE);
  await assert.rejects(
    () => authorizeProductionMigrationApply(authorizeArgs({
      restaurants: 1,
      phase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
      seed: [seeded],
      env: { [PRODUCTION_MIGRATE_ATTEMPT_ID_ENV]: "00000000-0000-4000-8000-000000000000" },
      argv: [],
    })),
    /no matching durable|does not match/,
  );
});

test("populated target wrong target fingerprint fails", async () => {
  const seeded = seedAttempt(ATTEMPT_STATUS.WAVE1_COMPLETE, {
    target_fingerprint: targetFingerprintFromFacts({ ...EXAMPLE_TARGET_FACTS, host: "other.proxy.rlwy.net" }),
  });
  await assert.rejects(
    () => authorizeProductionMigrationApply(authorizeArgs({
      restaurants: 1,
      phase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
      seed: [seeded],
      env: { [PRODUCTION_MIGRATE_ATTEMPT_ID_ENV]: seeded.attempt_id },
      argv: [],
    })),
    /different PostgreSQL target/,
  );
});

test("wrong commit, window, or freeze fails populated full apply", async () => {
  const wrongCommit = seedAttempt(ATTEMPT_STATUS.WAVE1_COMPLETE, { candidate_commit: OTHER_SHA });
  await assert.rejects(
    () => authorizeProductionMigrationApply(authorizeArgs({
      restaurants: 1,
      phase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
      seed: [wrongCommit],
      env: { [PRODUCTION_MIGRATE_ATTEMPT_ID_ENV]: wrongCommit.attempt_id },
      argv: [],
    })),
    /different reviewed commit/,
  );
});

test("NESTA_PRODUCTION_ALLOW_RESUME tag alone cannot authorize resume", async () => {
  await assert.rejects(
    () => authorizeProductionMigrationApply(authorizeArgs({
      restaurants: 1,
      phase: MIGRATION_PHASE.RESUME_FULL,
      argv: [],
      env: { NESTA_PRODUCTION_ALLOW_RESUME: PRODUCTION_REQUIRED_TAG },
    })),
    /NESTA_PRODUCTION_MIGRATE_ATTEMPT_ID/,
  );
});

test("valid durable attempt plus fresh gates can resume full migration", async () => {
  const seeded = seedAttempt(ATTEMPT_STATUS.FULL_IN_PROGRESS, { phase: MIGRATION_PHASE.FULL_AFTER_WAVE1 });
  const r = await authorizeProductionMigrationApply(authorizeArgs({
    restaurants: 1,
    phase: MIGRATION_PHASE.RESUME_FULL,
    seed: [seeded],
    env: { [PRODUCTION_MIGRATE_ATTEMPT_ID_ENV]: seeded.attempt_id },
    argv: [],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.allowPopulatedTarget, true);
  assert.equal(r.attempt.status, ATTEMPT_STATUS.FULL_IN_PROGRESS);
});

test("historical attempt from another commit cannot resume", async () => {
  const seeded = seedAttempt(ATTEMPT_STATUS.FULL_IN_PROGRESS, {
    phase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
    candidate_commit: OTHER_SHA,
    cutover_window_identity: identityFor(OTHER_SHA),
  });
  await assert.rejects(
    () => authorizeProductionMigrationApply(authorizeArgs({
      restaurants: 1,
      phase: MIGRATION_PHASE.RESUME_FULL,
      seed: [seeded],
      env: { [PRODUCTION_MIGRATE_ATTEMPT_ID_ENV]: seeded.attempt_id },
      argv: [],
    })),
    /different reviewed commit|different cutover window/,
  );
});

test("completed attempt cannot be replayed", async () => {
  const seeded = seedAttempt(ATTEMPT_STATUS.FULL_COMPLETE);
  await assert.rejects(
    () => authorizeProductionMigrationApply(authorizeArgs({
      restaurants: 1,
      phase: MIGRATION_PHASE.RESUME_FULL,
      seed: [seeded],
      env: { [PRODUCTION_MIGRATE_ATTEMPT_ID_ENV]: seeded.attempt_id },
      argv: [],
    })),
    /cannot be replayed/,
  );
});

test("attempt from a different database cannot authorize this target", async () => {
  const otherFp = targetFingerprintFromFacts({ ...EXAMPLE_TARGET_FACTS, systemIdentifier: "9999999999999999999" });
  const seeded = seedAttempt(ATTEMPT_STATUS.WAVE1_COMPLETE, { target_fingerprint: otherFp });
  await assert.rejects(
    () => authorizeProductionMigrationApply(authorizeArgs({
      restaurants: 1,
      phase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
      seed: [seeded],
      env: { [PRODUCTION_MIGRATE_ATTEMPT_ID_ENV]: seeded.attempt_id },
      argv: [],
    })),
    /different PostgreSQL target/,
  );
});

test("exact preflight target must equal the migration connection fingerprint", async () => {
  await assert.rejects(
    () => authorizeProductionMigrationApply(authorizeArgs({
      readTargetIdentityImpl: async () => identityFromFacts({ ...EXAMPLE_TARGET_FACTS, host: "other.proxy.rlwy.net" }),
    })),
    /not the exact PostgreSQL target/,
  );
  const pass = await authorizeProductionMigrationApply(authorizeArgs());
  assert.equal(pass.targetFingerprint, exampleLiveTargetFingerprint());
});

test("same schema on a different Railway DB fails target equality", async () => {
  await assert.rejects(
    () => authorizeProductionMigrationApply(authorizeArgs({
      readTargetIdentityImpl: async () => identityFromFacts({ ...EXAMPLE_TARGET_FACTS, systemIdentifier: "2222222222222222222" }),
    })),
    /not the exact PostgreSQL target/,
  );
});

test("phase admission rejects env-only populated resume", () => {
  const r = evaluateMigrationPhaseAdmission({
    phase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
    restaurants: 2,
    attempt: null,
    requestedAttemptId: "",
    binding: currentBinding(),
    explicitCreateAuthorized: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ATTEMPT_ID/);
});

test("failing final live invariant leaves no durable attempt row", async () => {
  const store = createMemoryAttemptStore();
  await assert.rejects(
    () => authorizeProductionMigrationApply(authorizeArgs({
      attemptStore: store,
      client: emptyProductionClient({ restaurants: 0, fixtures: 1 }),
    })),
    /fixture rest_1999/,
  );
  assert.equal(await store.findByBinding(currentBinding()), null);
});

