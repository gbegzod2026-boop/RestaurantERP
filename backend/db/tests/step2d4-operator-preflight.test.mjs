import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { evaluateStep2dFinalGates, PHASE, EXPECTED_PAUSE_CONFIRM } from "../scripts/lib/step2dFinalGate.mjs";
import { evaluateDeployFreeze, STEP2C_COMMIT, CUTOVER_CANDIDATE_TAG, reviewedCutoverApprovalMessage, REQUIRED_FREEZE_BRANCH } from "../scripts/lib/deployFreeze.mjs";
import { freezeSnapshotComplete, freezeSnapshotValidForCutoverWindow } from "../scripts/lib/freezeSnapshot.mjs";
import {
  computeCutoverWindowIdentity,
  buildWriteStopEvidence,
  buildFreezeEvidence,
  canonicalFreezeCounts,
} from "../scripts/lib/cutoverWindow.mjs";
import { REQUIRED_PRODUCTION_PROBE_ORIGIN } from "../scripts/lib/deployedRevision.mjs";
import { evaluateWriteStop, classifyHealth } from "../scripts/lib/writeStopProbe.mjs";
import { paymentGoLiveAllowed, webhookRetryGuaranteed, durableQueueImplemented } from "../../payments/cutoverMode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("postgres pool default remains 10", () => {
  const src = readFileSync(path.join(__dirname, "../postgres.js"), "utf8");
  const matches = [...src.matchAll(/POSTGRES_POOL_MAX \|\| (\d+)/g)].map((m) => m[1]);
  assert.ok(matches.length >= 1);
  assert.ok(matches.every((n) => n === "10"));
});

test("payment pause confirm is not a silent bypass", () => {
  assert.equal(paymentGoLiveAllowed({}), false);
  assert.equal(paymentGoLiveAllowed({ NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED" }), false);
  assert.equal(paymentGoLiveAllowed({
    NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED",
    NESTA_PAYMENT_PAUSE_CONFIRM: "yes",
  }), false);
  assert.equal(paymentGoLiveAllowed({
    NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED",
    NESTA_PAYMENT_PAUSE_CONFIRM: "true",
  }), false);
  assert.equal(paymentGoLiveAllowed({
    NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED",
    NESTA_PAYMENT_PAUSE_CONFIRM: "CLICK_PAYME_UZUM_PAUSED_IN_PROVIDER_CABINET",
  }), true);
  assert.equal(webhookRetryGuaranteed(), false);
  assert.equal(durableQueueImplemented(), false);
});

const operatorPreflightPass = {
  env: {
    NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED",
    NESTA_PAYMENT_PAUSE_CONFIRM: EXPECTED_PAUSE_CONFIRM,
  },
  backups: { firebase: 1, pg: 1, appConfig: 1 },
  git: { head: null, tag: null, dirty: true },
  snapshotPresent: true,
  railwayLivePreflight: "NOT RUN",
};

test("PASS preflight does not imply cutover window armed", () => {
  const r = evaluateStep2dFinalGates(operatorPreflightPass);
  assert.equal(r.step2dFinalOperatorPreflight, "PASS");
  assert.equal(r.phase, PHASE.PREFLIGHT_READY);
  assert.equal(r.safeToRequestHumanApproval, false);
  assert.equal(r.safeToMigrateProductionData, false);
  assert.equal(r.providerPauseEvidence, "OPERATOR ATTESTATION");
  assert.equal(r.maintenanceRequiredBeforeApproval, true);
  assert.equal(r.approvalBlockers.includes("maintenanceMode"), true);
  assert.equal(r.approvalBlockers.includes("productionWriteStop"), true);
  assert.equal(r.approvalBlockers.includes("deployFreeze"), true);
  assert.equal(r.approvalBlockers.includes("finalFirebaseSnapshot"), true);
  assert.equal(r.approvalBlockers.includes("originMainMatch"), true);
  assert.equal(r.approvalBlockers.includes("deployedRevision"), true);
});

const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
    originMain: head,
    ...overrides,
  };
}

test("safeToMigrateProductionData stays false even if the cutover window is armed", () => {
  const identity = computeCutoverWindowIdentity({
    candidateCommit: HEAD_SHA,
    remoteMain: HEAD_SHA,
    deployedRevision: HEAD_SHA,
  });
  const r = evaluateStep2dFinalGates({
    env: {
      NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED",
      NESTA_PAYMENT_PAUSE_CONFIRM: EXPECTED_PAUSE_CONFIRM,
      NESTA_MAINTENANCE_MODE: "1",
    },
    backups: { firebase: 1, pg: 1, appConfig: 1 },
    git: approvalGit(),
    snapshotPresent: true,
    reverseProxyVerified: true,
    dnsRollbackVerified: true,
    railwayLivePreflight: "GO",
    humanApprovalPresent: true,
    runtimeRevision: HEAD_SHA,
    liveRemoteMain: HEAD_SHA,
    now: Date.parse("2026-08-31T10:30:00.000Z"),
    writeStopEvidence: buildWriteStopEvidence({
      classified: {
        productionWriteStop: "PASS",
        maintenance: "ON",
        writeObserved: false,
        tenantWriteBlocked: true,
        clickBlocked: true,
        paymeBlocked: true,
        uzumBlocked: true,
      },
      generatedAt: "2026-08-31T10:10:00.000Z",
      origin: REQUIRED_PRODUCTION_PROBE_ORIGIN,
      candidateCommit: HEAD_SHA,
      cutoverWindowIdentity: identity,
    }),
    freezeEvidence: buildFreezeEvidence({
      generatedAt: "2026-08-31T10:15:00.000Z",
      firebaseProject: "restoran-30d51",
      counts: canonicalFreezeCounts({
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
      }),
      candidateCommit: HEAD_SHA,
      cutoverWindowIdentity: identity,
    }),
  });
  assert.equal(r.cutoverWindowArmed, true);
  assert.equal(r.safeToRequestHumanApproval, true);
  assert.equal(r.safeToMigrateProductionData, false);
  assert.equal(r.migrationAuthorized, false);
  assert.equal(r.approvalBlockers.includes("originMainMatch"), false);
  assert.equal(r.approvalBlockers.includes("deployedRevision"), false);
  assert.equal(r.gates.find((g) => g.name === "originMainMatch")?.result, "PASS");
  assert.equal(r.gates.find((g) => g.name === "deployedRevision")?.result, "PASS");
  assert.equal(r.remoteMainLive, "PASS");
  assert.equal(r.cachedOriginMainAuthoritative, false);
});

test("deploy freeze requires annotated reviewed tag on HEAD and a clean tree", () => {
  const fail = evaluateDeployFreeze(approvalGit({ dirty: true }));
  assert.equal(fail.deployFreeze, "FAIL");
  assert.equal(fail.workingTreeClean, "FAIL");
  assert.equal(fail.tagMatch, "PASS");
  const pass = evaluateDeployFreeze(approvalGit());
  assert.equal(pass.deployFreeze, "PASS");
  const mismatch = evaluateDeployFreeze(approvalGit({
    head: STEP2C_COMMIT,
    tag: OTHER_SHA,
  }));
  assert.equal(mismatch.deployFreeze, "FAIL");
  assert.equal(mismatch.headMatch, "FAIL");
  assert.equal(mismatch.tagMatch, "FAIL");
  const detached = evaluateDeployFreeze(approvalGit({ branch: null }));
  assert.equal(detached.deployFreeze, "FAIL");
  assert.equal(detached.detachedHead, true);
  const otherBranch = evaluateDeployFreeze(approvalGit({ branch: "feature" }));
  assert.equal(otherBranch.deployFreeze, "FAIL");
  assert.equal(otherBranch.branchMatch, "FAIL");
});

test("historical Step 2C tag cannot be the intended cutover candidate", () => {
  const historical = evaluateDeployFreeze({
    head: STEP2C_COMMIT,
    tag: STEP2C_COMMIT,
    expectedCommit: STEP2C_COMMIT,
    dirty: false,
    candidateTag: "nesta-step2c-cutover",
  });
  assert.equal(historical.deployFreeze, "FAIL");
  assert.equal(historical.historicalStep2cRefused, true);
});

test("write-stop probe refuses POSTs when maintenance is off", () => {
  const health = classifyHealth(200, { maintenance: false, ok: true });
  assert.equal(health.maintenance, false);
  const stopped = evaluateWriteStop({ health });
  assert.equal(stopped.productionWriteStop, "NOT VERIFIED");
  assert.equal(stopped.writeObserved, false);
});

test("write-stop PASS requires 503 webhooks and blocked tenant write", () => {
  const r = evaluateWriteStop({
    health: { maintenance: true },
    tenantWrite: { status: 503, body: { code: "MAINTENANCE" } },
    click: { status: 503, body: { error: -7, retry_guaranteed: false } },
    payme: { status: 503, body: { error: { code: -32400 }, retry_guaranteed: false } },
    uzum: { status: 503, body: { code: "MAINTENANCE", retry_guaranteed: false } },
  });
  assert.equal(r.productionWriteStop, "PASS");
  assert.equal(r.writeObserved, false);
  const leaked = evaluateWriteStop({
    health: { maintenance: true },
    tenantWrite: { status: 200, body: { wrote: true } },
    click: { status: 200, body: { error: 0 } },
    payme: { status: 200, body: {} },
    uzum: { status: 200, body: { ok: true } },
  });
  assert.equal(leaked.productionWriteStop, "FAIL");
  assert.equal(leaked.writeObserved, true);
});

test("freeze snapshot requires restoran-30d51 and required counts", () => {
  const twelve = canonicalFreezeCounts({
    restaurants: 46,
    users: 85,
    employees: 85,
    orders: 59,
    orderItems: 147,
    payments: 54,
    menu: 21,
    tables: 12,
    customers: 3,
    credentialTrees: 46,
    customRoles: 2,
    platformPromoCodes: 4,
  });
  assert.equal(freezeSnapshotComplete({ freezeWindow: true, mode: "READ-ONLY", firebaseProject: "other", counts: {} }), false);
  assert.equal(freezeSnapshotComplete({
    freezeWindow: true,
    mode: "READ-ONLY",
    firebaseProject: "restoran-30d51",
    counts: { restaurants: 46, users: 85, orders: 59, orderItems: 147, payments: 54, menu: 21 },
  }), false);
  assert.equal(freezeSnapshotComplete({
    freezeWindow: true,
    mode: "READ-ONLY",
    firebaseProject: "restoran-30d51",
    counts: twelve,
  }), true);
});

test("cutover-window freeze requires current-window identity and freshness", () => {
  const complete = {
    freezeWindow: true,
    mode: "READ-ONLY",
    firebaseProject: "restoran-30d51",
    counts: canonicalFreezeCounts({
      restaurants: 46,
      users: 85,
      employees: 85,
      orders: 59,
      orderItems: 147,
      payments: 54,
      menu: 21,
      tables: 12,
      customers: 3,
      credentialTrees: 46,
      customRoles: 2,
      platformPromoCodes: 4,
    }),
  };
  const now = Date.parse("2026-08-31T10:30:00.000Z");
  assert.equal(freezeSnapshotValidForCutoverWindow(complete, { now }), false);
  const identity = computeCutoverWindowIdentity({
    candidateCommit: HEAD_SHA,
    remoteMain: HEAD_SHA,
    deployedRevision: HEAD_SHA,
  });
  const bound = buildFreezeEvidence({
    generatedAt: "2026-08-31T10:20:00.000Z",
    firebaseProject: "restoran-30d51",
    counts: complete.counts,
    candidateCommit: HEAD_SHA,
    cutoverWindowIdentity: identity,
  });
  assert.equal(freezeSnapshotValidForCutoverWindow(bound, {
    now,
    expectedIdentity: identity,
    expectedCommit: HEAD_SHA,
    writeStopGeneratedAt: "2026-08-31T10:10:00.000Z",
  }), true);
  assert.equal(freezeSnapshotValidForCutoverWindow({ ...bound, generatedAt: "2026-08-31T09:00:00.000Z" }, {
    now,
    expectedIdentity: identity,
    expectedCommit: HEAD_SHA,
    writeStopGeneratedAt: "2026-08-31T10:10:00.000Z",
  }), false);
  const future = new Date(now + 120_000).toISOString();
  assert.equal(freezeSnapshotValidForCutoverWindow({ ...bound, generatedAt: future }, {
    now,
    expectedIdentity: identity,
    expectedCommit: HEAD_SHA,
    writeStopGeneratedAt: "2026-08-31T10:10:00.000Z",
  }), false);
});


