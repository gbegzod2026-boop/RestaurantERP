import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { evaluateStep2dFinalGates, PHASE, EXPECTED_PAUSE_CONFIRM } from "../scripts/lib/step2dFinalGate.mjs";
import { evaluateDeployFreeze, STEP2C_COMMIT } from "../scripts/lib/deployFreeze.mjs";
import { freezeSnapshotComplete } from "../scripts/lib/freezeSnapshot.mjs";
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
});

test("safeToMigrateProductionData stays false even if the cutover window is armed", () => {
  const r = evaluateStep2dFinalGates({
    env: {
      NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED",
      NESTA_PAYMENT_PAUSE_CONFIRM: EXPECTED_PAUSE_CONFIRM,
      NESTA_MAINTENANCE_MODE: "1",
    },
    backups: { firebase: 1, pg: 1, appConfig: 1 },
    git: {
      head: "cccccccccccccccccccccccccccccccccccccccc",
      tag: "cccccccccccccccccccccccccccccccccccccccc",
      expectedCommit: "cccccccccccccccccccccccccccccccccccccccc",
      dirty: false,
    },
    snapshotPresent: true,
    reverseProxyVerified: true,
    dnsRollbackVerified: true,
    productionWriteStopVerified: true,
    freezeSnapshotVerified: true,
    railwayLivePreflight: "GO",
    humanApprovalPresent: true,
  });
  assert.equal(r.cutoverWindowArmed, true);
  assert.equal(r.safeToRequestHumanApproval, true);
  assert.equal(r.safeToMigrateProductionData, false);
  assert.equal(r.migrationAuthorized, false);
});

test("deploy freeze requires clean tree and matching current candidate tag", () => {
  const candidate = "cccccccccccccccccccccccccccccccccccccccc";
  const fail = evaluateDeployFreeze({
    head: candidate,
    tag: candidate,
    expectedCommit: candidate,
    dirty: true,
  });
  assert.equal(fail.deployFreeze, "FAIL");
  assert.equal(fail.workingTreeClean, "FAIL");
  assert.equal(fail.tagMatch, "PASS");
  const pass = evaluateDeployFreeze({
    head: candidate,
    tag: candidate,
    expectedCommit: candidate,
    dirty: false,
  });
  assert.equal(pass.deployFreeze, "PASS");
  const historical = evaluateDeployFreeze({
    head: STEP2C_COMMIT,
    tag: STEP2C_COMMIT,
    expectedCommit: candidate,
    dirty: false,
  });
  assert.equal(historical.deployFreeze, "FAIL");
  assert.equal(historical.headMatch, "FAIL");
  assert.equal(historical.tagMatch, "FAIL");
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
  assert.equal(freezeSnapshotComplete({ freezeWindow: true, mode: "READ-ONLY", firebaseProject: "other", counts: {} }), false);
  assert.equal(freezeSnapshotComplete({
    freezeWindow: true,
    mode: "READ-ONLY",
    firebaseProject: "restoran-30d51",
    counts: { restaurants: 46, users: 85, orders: 59, orderItems: 147, payments: 54, menu: 21 },
  }), true);
});


