import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import {
  computeCutoverWindowIdentity,
  canonicalWindowBindingString,
  buildWriteStopEvidence,
  evaluateWriteStopEvidence,
  buildFreezeEvidence,
  evaluateFreezeEvidence,
  currentWriteStopBinding,
  FREEZE_COUNT_KEYS,
  CUTOVER_EVIDENCE_TTL_MS,
  CUTOVER_CLOCK_SKEW_MS,
  CUTOVER_EVIDENCE_VERSION,
} from "../scripts/lib/cutoverWindow.mjs";
import { evaluateStep2dFinalGates, EXPECTED_PAUSE_CONFIRM } from "../scripts/lib/step2dFinalGate.mjs";
import {
  CUTOVER_CANDIDATE_TAG,
  reviewedCutoverApprovalMessage,
  REQUIRED_FREEZE_BRANCH,
} from "../scripts/lib/deployFreeze.mjs";
import { REQUIRED_PRODUCTION_PROBE_ORIGIN } from "../scripts/lib/deployedRevision.mjs";
import { freezeSnapshotComplete } from "../scripts/lib/freezeSnapshot.mjs";

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

function twelveCounts(overrides = {}) {
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

function approvalGit() {
  return {
    head: HEAD_SHA,
    tag: HEAD_SHA,
    dirty: false,
    candidateTag: CUTOVER_CANDIDATE_TAG,
    tagType: "tag",
    tagAnnotation: reviewedCutoverApprovalMessage(),
    branch: REQUIRED_FREEZE_BRANCH,
    originMain: OTHER_SHA,
  };
}

function finalGate(extra = {}) {
  return evaluateStep2dFinalGates({
    env: {
      NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED",
      NESTA_PAYMENT_PAUSE_CONFIRM: EXPECTED_PAUSE_CONFIRM,
      NESTA_MAINTENANCE_MODE: "1",
    },
    backups: { firebase: 1, pg: 1, appConfig: 1 },
    git: approvalGit(),
    railwayLivePreflight: "PASS",
    runtimeRevision: HEAD_SHA,
    liveRemoteMain: HEAD_SHA,
    writeStopEvidence: passWrite(),
    freezeEvidence: passFreeze(),
    now: NOW,
    ...extra,
  });
}

test("window identity is SHA-256 of the canonical binding and ignores cached origin/main", () => {
  const id = identityFor();
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(id, identityFor(HEAD_SHA));
  const canonical = canonicalWindowBindingString({
    candidateCommit: HEAD_SHA,
    remoteMain: HEAD_SHA,
    deployedRevision: HEAD_SHA,
  });
  assert.match(canonical, /"purpose":"step2-production-cutover"/);
  assert.match(canonical, /"candidateTag":"nesta-step2d5-reviewed-cutover"/);
  assert.equal(computeCutoverWindowIdentity({
    candidateCommit: HEAD_SHA,
    remoteMain: OTHER_SHA,
    deployedRevision: HEAD_SHA,
  }), null);
});

test("fresh same-window write-stop artifact PASSes", () => {
  const r = evaluateWriteStopEvidence(passWrite(), {
    expectedIdentity: identityFor(),
    expectedCommit: HEAD_SHA,
    now: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.productionWriteStop, "PASS");
});

test("write-stop fail-closed cases", () => {
  const ctx = { expectedIdentity: identityFor(), expectedCommit: HEAD_SHA, now: NOW };
  assert.equal(evaluateWriteStopEvidence(passWrite({
    generatedAt: new Date(NOW - CUTOVER_EVIDENCE_TTL_MS - 1000).toISOString(),
  }), ctx).reason, "stale-timestamp");
  assert.equal(evaluateWriteStopEvidence(passWrite({ candidateCommit: OTHER_SHA }), ctx).reason, "candidate-commit");
  assert.equal(evaluateWriteStopEvidence(passWrite({ cutoverWindowIdentity: "0".repeat(64) }), ctx).reason, "window-identity");
  assert.equal(evaluateWriteStopEvidence(passWrite({ origin: "https://attacker.example" }), ctx).reason, "origin");
  assert.equal(evaluateWriteStopEvidence(passWrite({ generatedAt: "2026-08-31T10:10:00Z" }), ctx).reason, "malformed-timestamp");
  const missingTs = passWrite();
  delete missingTs.generatedAt;
  assert.equal(evaluateWriteStopEvidence(missingTs, ctx).reason, "schema");
  assert.equal(evaluateWriteStopEvidence(passWrite({
    generatedAt: new Date(NOW + 120_000).toISOString(),
  }), ctx).reason, "future-timestamp");
  assert.equal(evaluateWriteStopEvidence(passWrite({ maintenance: "OFF" }), ctx).reason, "maintenance");
  assert.equal(evaluateWriteStopEvidence(passWrite({ writeObserved: true }), ctx).reason, "write-observed");
  assert.equal(evaluateWriteStopEvidence(passWrite({ clickBlocked: false }), ctx).reason, "click");
  assert.equal(evaluateWriteStopEvidence(passWrite({ tenantWriteBlocked: false }), ctx).reason, "tenant");
  assert.equal(evaluateWriteStopEvidence(passWrite({ extra: true }), ctx).reason, "schema");
  assert.equal(evaluateWriteStopEvidence({
    productionWriteStop: "PASS",
    generatedAt: WRITE_AT,
  }, ctx).reason, "schema");
});

test("fresh current-window freeze after current-window write-stop PASSes", () => {
  const r = evaluateFreezeEvidence(passFreeze(), {
    expectedIdentity: identityFor(),
    expectedCommit: HEAD_SHA,
    writeStopGeneratedAt: WRITE_AT,
    now: NOW,
  });
  assert.equal(r.ok, true);
});

test("freeze fail-closed cases", () => {
  const ctx = {
    expectedIdentity: identityFor(),
    expectedCommit: HEAD_SHA,
    writeStopGeneratedAt: WRITE_AT,
    now: NOW,
  };
  assert.equal(evaluateFreezeEvidence(passFreeze({
    generatedAt: new Date(NOW - CUTOVER_EVIDENCE_TTL_MS - 1000).toISOString(),
  }), ctx).reason, "stale-timestamp");
  assert.equal(evaluateFreezeEvidence(passFreeze({ candidateCommit: OTHER_SHA }), ctx).reason, "candidate-commit");
  assert.equal(evaluateFreezeEvidence(passFreeze({ cutoverWindowIdentity: identityFor(OTHER_SHA) || "1".repeat(64) }), ctx).reason, "window-identity");
  assert.equal(evaluateFreezeEvidence(passFreeze({ generatedAt: "nope" }), ctx).reason, "malformed-timestamp");
  assert.equal(evaluateFreezeEvidence(passFreeze({
    generatedAt: new Date(NOW + 120_000).toISOString(),
  }), ctx).reason, "future-timestamp");
  assert.equal(evaluateFreezeEvidence(passFreeze({ generatedAt: "2026-08-31T10:00:00.000Z" }), ctx).reason, "ordering");
  assert.equal(evaluateFreezeEvidence(passFreeze({ firebaseProject: "nesta-staging" }), ctx).reason, "firebase-project");
  assert.equal(evaluateFreezeEvidence(passFreeze({ counts: { restaurants: 1 } }), ctx).reason, "counts");
  const previousWindow = passFreeze({
    cutoverWindowIdentity: "ab".repeat(32),
    generatedAt: "2026-08-31T10:20:00.000Z",
  });
  assert.equal(evaluateFreezeEvidence(previousWindow, ctx).reason, "window-identity");
  const plausible = passFreeze({
    counts: twelveCounts({ restaurants: 46, users: 85, orders: 59, orderItems: 147, payments: 54, menu: 21 }),
    candidateCommit: OTHER_SHA,
  });
  assert.equal(evaluateFreezeEvidence(plausible, ctx).reason, "candidate-commit");
});

test("current-window evidence arms the final gate; stale or wrong evidence does not", () => {
  const pass = finalGate();
  assert.equal(pass.cutoverWindowArmed, true);
  assert.equal(pass.safeToRequestHumanApproval, true);
  assert.equal(pass.safeToMigrateProductionData, false);
  assert.equal(pass.migrationAuthorized, false);
  assert.equal(pass.writeStopEvidenceOk, true);
  assert.equal(pass.freezeEvidenceOk, true);

  const staleWrite = finalGate({
    writeStopEvidence: passWrite({
      generatedAt: new Date(NOW - CUTOVER_EVIDENCE_TTL_MS - 5_000).toISOString(),
    }),
  });
  assert.equal(staleWrite.safeToRequestHumanApproval, false);
  assert.equal(staleWrite.approvalBlockers.includes("productionWriteStop"), true);

  const staleFreeze = finalGate({
    freezeEvidence: passFreeze({
      generatedAt: new Date(NOW - CUTOVER_EVIDENCE_TTL_MS - 5_000).toISOString(),
    }),
  });
  assert.equal(staleFreeze.safeToRequestHumanApproval, false);
  assert.equal(staleFreeze.approvalBlockers.includes("finalFirebaseSnapshot"), true);

  const booleanOnly = evaluateStep2dFinalGates({
    env: {
      NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED",
      NESTA_PAYMENT_PAUSE_CONFIRM: EXPECTED_PAUSE_CONFIRM,
      NESTA_MAINTENANCE_MODE: "1",
    },
    backups: { firebase: 1, pg: 1, appConfig: 1 },
    git: approvalGit(),
    productionWriteStopVerified: true,
    freezeSnapshotVerified: true,
    railwayLivePreflight: "PASS",
    runtimeRevision: HEAD_SHA,
    liveRemoteMain: HEAD_SHA,
    now: NOW,
  });
  assert.equal(booleanOnly.safeToRequestHumanApproval, false);
});

test("evidence version is the closed schema constant", () => {
  assert.equal(passWrite().evidenceVersion, CUTOVER_EVIDENCE_VERSION);
  assert.equal(passFreeze().evidenceVersion, CUTOVER_EVIDENCE_VERSION);
});

test("freeze counts require the exact 12 integer dimensions", () => {
  const ctx = {
    expectedIdentity: identityFor(),
    expectedCommit: HEAD_SHA,
    writeStopGeneratedAt: WRITE_AT,
    now: NOW,
  };
  assert.deepEqual([...FREEZE_COUNT_KEYS], [
    "restaurants",
    "users",
    "employees",
    "orders",
    "orderItems",
    "payments",
    "menu",
    "tables",
    "customers",
    "credentialTrees",
    "customRoles",
    "platformPromoCodes",
  ]);
  const exact = passFreeze();
  assert.equal(evaluateFreezeEvidence(exact, ctx).ok, true);
  assert.equal(freezeSnapshotComplete(exact), true);
  assert.equal(Object.keys(exact.counts).length, 12);

  for (const missing of FREEZE_COUNT_KEYS) {
    const counts = twelveCounts();
    delete counts[missing];
    assert.equal(evaluateFreezeEvidence(passFreeze({ counts }), ctx).reason, "counts", missing);
    assert.equal(freezeSnapshotComplete({ ...exact, counts }), false, missing);
  }

  const extra = twelveCounts();
  extra.unexpected = 1;
  assert.equal(evaluateFreezeEvidence(passFreeze({ counts: extra }), ctx).reason, "counts");
  assert.equal(freezeSnapshotComplete({ ...exact, counts: extra }), false);

  assert.equal(evaluateFreezeEvidence(passFreeze({ counts: twelveCounts({ employees: -1 }) }), ctx).reason, "counts");
  assert.equal(evaluateFreezeEvidence(passFreeze({ counts: twelveCounts({ tables: 1.5 }) }), ctx).reason, "counts");
  assert.equal(evaluateFreezeEvidence(passFreeze({ counts: twelveCounts({ customRoles: "1" }) }), ctx).reason, "counts");
  assert.equal(evaluateFreezeEvidence(passFreeze({ counts: twelveCounts({ customers: null }) }), ctx).reason, "counts");
  assert.equal(evaluateFreezeEvidence(passFreeze({ counts: twelveCounts({ credentialTrees: NaN }) }), ctx).reason, "counts");
  assert.equal(evaluateFreezeEvidence(passFreeze({ counts: null }), ctx).reason, "counts");
  assert.equal(evaluateFreezeEvidence(passFreeze({ counts: [] }), ctx).reason, "counts");
  assert.equal(evaluateFreezeEvidence(passFreeze({ counts: "nope" }), ctx).reason, "counts");
});

test("exact TTL and future-skew boundaries", () => {
  const writeCtx = { expectedIdentity: identityFor(), expectedCommit: HEAD_SHA, now: NOW };
  const freezeCtx = {
    expectedIdentity: identityFor(),
    expectedCommit: HEAD_SHA,
    writeStopGeneratedAt: new Date(NOW - CUTOVER_EVIDENCE_TTL_MS).toISOString(),
    now: NOW,
  };
  const ttlExact = new Date(NOW - CUTOVER_EVIDENCE_TTL_MS).toISOString();
  const ttlPlusOne = new Date(NOW - CUTOVER_EVIDENCE_TTL_MS - 1).toISOString();
  const skewExact = new Date(NOW + CUTOVER_CLOCK_SKEW_MS).toISOString();
  const skewPlusOne = new Date(NOW + CUTOVER_CLOCK_SKEW_MS + 1).toISOString();

  assert.equal(evaluateWriteStopEvidence(passWrite({ generatedAt: ttlExact }), writeCtx).ok, true);
  assert.equal(evaluateWriteStopEvidence(passWrite({ generatedAt: ttlPlusOne }), writeCtx).reason, "stale-timestamp");
  assert.equal(evaluateWriteStopEvidence(passWrite({ generatedAt: skewExact }), writeCtx).ok, true);
  assert.equal(evaluateWriteStopEvidence(passWrite({ generatedAt: skewPlusOne }), writeCtx).reason, "future-timestamp");

  assert.equal(evaluateFreezeEvidence(passFreeze({ generatedAt: ttlExact }), freezeCtx).ok, true);
  assert.equal(evaluateFreezeEvidence(passFreeze({ generatedAt: ttlPlusOne }), freezeCtx).reason, "stale-timestamp");
  assert.equal(evaluateFreezeEvidence(passFreeze({ generatedAt: skewExact }), freezeCtx).ok, true);
  assert.equal(evaluateFreezeEvidence(passFreeze({ generatedAt: skewPlusOne }), freezeCtx).reason, "future-timestamp");
});

test("newest valid current-window write-stop is selected over a later malformed artifact", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nesta-write-stop-"));
  try {
    const olderDir = path.join(tmp, "cutover-backups", "write-stop-aaa");
    const middleDir = path.join(tmp, "cutover-backups", "write-stop-mmm");
    const laterDir = path.join(tmp, "cutover-backups", "write-stop-zzz");
    mkdirSync(olderDir, { recursive: true });
    mkdirSync(middleDir, { recursive: true });
    mkdirSync(laterDir, { recursive: true });
    writeFileSync(path.join(olderDir, "WRITE_STOP.json"), JSON.stringify(passWrite({
      generatedAt: "2026-08-31T10:18:00.000Z",
    })));
    writeFileSync(path.join(middleDir, "WRITE_STOP.json"), JSON.stringify(passWrite({
      generatedAt: "2026-08-31T10:12:00.000Z",
    })));
    writeFileSync(path.join(laterDir, "WRITE_STOP.json"), JSON.stringify({
      generatedAt: "2026-08-31T10:20:00.000Z",
      productionWriteStop: "PASS",
    }));
    const selected = currentWriteStopBinding(tmp, {
      expectedIdentity: identityFor(),
      expectedCommit: HEAD_SHA,
      now: NOW,
    });
    assert.equal(selected.ok, true);
    assert.equal(selected.doc.generatedAt, "2026-08-31T10:18:00.000Z");
    assert.equal(path.basename(path.dirname(selected.file)), "write-stop-aaa");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("current-window write-stop binding refuses directory-newest malformed-only evidence", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nesta-write-stop-"));
  try {
    const dir = path.join(tmp, "cutover-backups", "write-stop-zzz");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "WRITE_STOP.json"), JSON.stringify({
      generatedAt: "2026-08-31T10:20:00.000Z",
      productionWriteStop: "PASS",
    }));
    const selected = currentWriteStopBinding(tmp, {
      expectedIdentity: identityFor(),
      expectedCommit: HEAD_SHA,
      now: NOW,
    });
    assert.equal(selected.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
