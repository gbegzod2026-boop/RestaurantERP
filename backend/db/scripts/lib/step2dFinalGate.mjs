// Step 2D final gate evaluation. Does not migrate, switch DATA_BACKEND,
// enable maintenance, or print secrets.
import { isMaintenanceMode } from "../../../security/maintenance.js";
import {
  PAYMENT_PAUSE_CONFIRM,
  paymentCutoverReport,
  webhookRetryGuaranteed,
  durableQueueImplemented,
} from "../../../payments/cutoverMode.js";
import { evaluateDeployFreeze } from "./deployFreeze.mjs";
import { evaluateCommitEqualityBinding } from "./deployedRevision.mjs";
import { computeCutoverWindowIdentity, evaluateWriteStopEvidence, evaluateFreezeEvidence } from "./cutoverWindow.mjs";
export {
  CUTOVER_CANDIDATE_TAG,
  FROZEN_TAG,
  STEP2C_COMMIT,
  STEP2C_TAG,
} from "./deployFreeze.mjs";
export const EXPECTED_PAUSE_CONFIRM = "CLICK_PAYME_UZUM_PAUSED_IN_PROVIDER_CABINET";

export const PHASE = {
  PREFLIGHT_READY: "PREFLIGHT_READY",
  CUTOVER_WINDOW_ARMED: "CUTOVER_WINDOW_ARMED",
  PRODUCTION_MIGRATION_AUTHORIZED: "PRODUCTION_MIGRATION_AUTHORIZED",
};

function gate(name, current, required, result, evidence, { blocksApproval = false, blocksPreflight = false } = {}) {
  return { name, current, required, result, evidence, blocksApproval, blocksPreflight };
}

export function confirmStatus(value) {
  if (!value) return "UNSET";
  if (value === EXPECTED_PAUSE_CONFIRM && EXPECTED_PAUSE_CONFIRM === PAYMENT_PAUSE_CONFIRM) return "MATCH";
  return "MISMATCH";
}

export function evaluateStep2dFinalGates({
  env = {},
  backups = { firebase: 0, pg: 0, appConfig: 0 },
  git = { head: null, tag: null, dirty: null },
  snapshotPresent = false,
  freezeSnapshotVerified = false,
  reverseProxyVerified = false,
  dnsRollbackVerified = false,
  productionWriteStopVerified = false,
  railwayLivePreflight = "NOT RUN",
  humanApprovalPresent = false,
  runtimeRevision = null,
  liveRemoteMain = null,
  writeStopEvidence = null,
  freezeEvidence = null,
  now = Date.now(),
  livePreflightCompletedAt = null,
} = {}) {
  const payments = paymentCutoverReport(env);
  const confirm = confirmStatus(env.NESTA_PAYMENT_PAUSE_CONFIRM);
  const mode = String(env.NESTA_PAYMENT_CUTOVER_MODE || "").trim().toUpperCase() || "(unset)";
  const paused = confirm === "MATCH" && mode === "OPERATOR_PAUSED" && payments.goLiveAllowed === true;
  const maintenanceOn = isMaintenanceMode(env);
  const confirmGuardPass = PAYMENT_PAUSE_CONFIRM === EXPECTED_PAUSE_CONFIRM
    && confirmStatus("yes") === "MISMATCH"
    && confirmStatus("true") === "MISMATCH"
    && confirmStatus("1") === "MISMATCH"
    && webhookRetryGuaranteed() === false
    && durableQueueImplemented() === false;
  const freeze = evaluateDeployFreeze(git);
  const equality = evaluateCommitEqualityBinding({
    head: git.head,
    tag: git.tag,
    originMain: git.originMain,
    liveRemoteMain,
    runtimeRevision,
  });
  const expectedIdentity = computeCutoverWindowIdentity({
    candidateCommit: git.head,
    remoteMain: liveRemoteMain,
    deployedRevision: runtimeRevision,
  });
  const writeStopEval = evaluateWriteStopEvidence(writeStopEvidence, {
    expectedIdentity,
    expectedCommit: git.head,
    now,
  });
  const freezeEval = evaluateFreezeEvidence(freezeEvidence, {
    expectedIdentity,
    expectedCommit: git.head,
    writeStopGeneratedAt: writeStopEval.ok ? writeStopEval.generatedAt : null,
    livePreflightCompletedAt,
    now,
  });
  const writeStopOk = writeStopEval.ok === true;
  const freezeOk = freezeEval.ok === true;

  const gates = [
    gate(
      "railwayPgSchema",
      railwayLivePreflight,
      "GO/PASS from in-process READ-ONLY runRailwayLivePreflight",
      railwayLivePreflight === "PASS" || railwayLivePreflight === "GO"
        ? "PASS"
        : railwayLivePreflight === "FAIL" ? "FAIL" : "NOT VERIFIED",
      "in-process runRailwayLivePreflight READ-ONLY result; PREFLIGHT.json is audit-only and never PASS",
      {
        blocksApproval: !(railwayLivePreflight === "PASS" || railwayLivePreflight === "GO"),
        blocksPreflight: railwayLivePreflight === "FAIL",
      },
    ),
    gate("firebaseBackup", backups.firebase > 0 ? "present" : "absent", ">=1 gitignored firebase-* artifact", backups.firebase > 0 ? "PASS" : "FAIL", "cutover-backups/firebase-* directory count", { blocksApproval: true, blocksPreflight: true }),
    gate("pgBackup", backups.pg > 0 ? "present" : "absent", ">=1 gitignored pg-* artifact", backups.pg > 0 ? "PASS" : "FAIL", "cutover-backups/pg-* directory count", { blocksApproval: true, blocksPreflight: true }),
    gate("pgRestoreDrill", backups.pg > 0 ? "artifact present" : "absent", "local nesta_step2d4_restore drill artifact", backups.pg > 0 ? "PASS" : "FAIL", "pg backup artifact presence; this script does not re-run pg_restore", { blocksApproval: true, blocksPreflight: true }),
    gate("paymentPauseAttestation", paused ? "OPERATOR_PAUSED+MATCH" : `${mode}/${confirm}`, "OPERATOR_PAUSED + exact confirm phrase", paused ? "PASS" : "FAIL", "OPERATOR ATTESTATION via env; cabinets are not independently probed", { blocksApproval: true, blocksPreflight: true }),
    gate("paymentConfirmGuard", confirmGuardPass ? "fail-closed" : "broken", "exact phrase only; yes/true/1 refused; retry not guaranteed", confirmGuardPass ? "PASS" : "FAIL", "payments/cutoverMode.js", { blocksApproval: true, blocksPreflight: true }),
    gate("retryGuaranteed", String(webhookRetryGuaranteed()), "false", webhookRetryGuaranteed() === false ? "PASS" : "FAIL", "webhookRetryGuaranteed() always false", { blocksApproval: true, blocksPreflight: true }),
    gate("durableQueueImplemented", String(durableQueueImplemented()), "false", durableQueueImplemented() === false ? "PASS" : "FAIL", "durable queue is not implemented", { blocksApproval: true, blocksPreflight: true }),
    gate("maintenanceMode", maintenanceOn ? "on" : "off", "on for cutover window (NESTA_MAINTENANCE_MODE=1 on production instances)", maintenanceOn ? "PASS" : "FAIL", "env only; this script never enables maintenance", { blocksApproval: true }),
    gate("productionWriteStop", writeStopOk ? "verified" : "NOT VERIFIED", "current-window WRITE_STOP.json: PASS + origin + identity + freshness", writeStopOk ? "PASS" : "NOT VERIFIED", "recomputed cutoverWindowIdentity; latest PASS file is not sufficient; unsigned JSON is not tamper-proof", { blocksApproval: true }),
    gate("workingTreeFreeze", freeze.workingTreeClean, "PASS (clean tree)", freeze.workingTreeClean === "PASS" ? "PASS" : "FAIL", "git status --porcelain empty", { blocksApproval: true }),
    gate("deployFreeze", freeze.deployFreeze, "PASS (main branch + clean tree + annotated reviewed-cutover tag target === HEAD)", freeze.deployFreeze === "PASS" ? "PASS" : "FAIL", "annotated Git tag approval outside the candidate commit; detached HEAD and non-main branches refused; NESTA_CUTOVER_CANDIDATE_TAG may select among policy tag names only; historical nesta-step2c-cutover and nesta-step2-cutover-ready refused", { blocksApproval: true }),
    gate("originMainMatch", equality.originMainMatch, "PASS (LIVE GitHub main SHA === HEAD)", equality.originMainMatch, "git ls-remote --exit-code against gbegzod2026-boop/RestaurantERP refs/heads/main; cached refs/remotes/origin/main is diagnostic only and never authorizes", { blocksApproval: true }),
    gate("deployedRevision", equality.deployedRevision, "PASS (Railway GET /api/deployment revision === HEAD === reviewed tag === LIVE GitHub main)", equality.deployedRevision, "HTTPS https://restauranterp-production-5c27.up.railway.app/api/deployment only; redirect=manual; 3xx fail closed; NESTA_CUTOVER_PROBE_BASE_URL cannot select another host", { blocksApproval: true }),
    gate("finalFirebaseSnapshot", freezeOk ? "freeze-time verified" : (snapshotPresent ? "prior report present" : "absent"), "current-window FREEZE.json after current-window write-stop", freezeOk ? "PASS" : "NOT VERIFIED", "recomputed cutoverWindowIdentity + TTL + write-stop ordering; historical FREEZE.json never authorizes", { blocksApproval: true }),
    gate("railwayLivePreflightThisRun", railwayLivePreflight, "PASS", railwayLivePreflight === "PASS" || railwayLivePreflight === "GO" ? "PASS" : "NOT VERIFIED", "in-process live preflight only; PREFLIGHT.json has zero authorization authority", { blocksApproval: false }),
    gate("reverseProxyRollback", reverseProxyVerified ? "verified" : "NOT VERIFIED", "nginx/caddy/cloudflare rollback config", reverseProxyVerified ? "PASS" : "NOT VERIFIED", "app-config backup reverseProxy field; no proxy config in workspace", { blocksApproval: false }),
    gate("dnsRollback", dnsRollbackVerified ? "verified" : "NOT VERIFIED", "DNS rollback procedure recorded", dnsRollbackVerified ? "PASS" : "NOT VERIFIED", "not encoded in repo", { blocksApproval: false }),
    gate("humanApproval", humanApprovalPresent ? "present" : "absent", "named approver + timestamp (checklist step 8)", "FAIL", "this script never authorizes migrate-firebase --apply", { blocksApproval: false }),
  ];

  const preflightBlockers = gates.filter((g) => g.blocksPreflight && g.result !== "PASS");
  const approvalBlockers = gates.filter((g) => g.blocksApproval && g.result !== "PASS");
  const preflightReady = preflightBlockers.length === 0;
  const cutoverWindowArmed = approvalBlockers.length === 0;
  const migrationAuthorized = false;

  let phase = "NOT_READY";
  if (cutoverWindowArmed) phase = PHASE.CUTOVER_WINDOW_ARMED;
  else if (preflightReady) phase = PHASE.PREFLIGHT_READY;

  return {
    phase,
    preflightReady,
    cutoverWindowArmed,
    migrationAuthorized,
    step2dFinalOperatorPreflight: preflightReady ? "PASS" : "PARTIAL",
    safeToRequestHumanApproval: cutoverWindowArmed,
    safeToMigrateProductionData: false,
    providerPauseEvidence: "OPERATOR ATTESTATION",
    maintenanceRequiredBeforeApproval: true,
    payments,
    confirm,
    mode,
    maintenanceOn,
    gates,
    preflightBlockers: preflightBlockers.map((g) => g.name),
    approvalBlockers: approvalBlockers.map((g) => g.name),
    retryNote: payments.note,
    remoteMainLive: equality.remoteMainLive,
    deployedRevision: equality.deployedRevision,
    cachedOriginMainAuthoritative: false,
    cutoverWindowIdentity: expectedIdentity,
    writeStopEvidenceOk: writeStopOk,
    freezeEvidenceOk: freezeOk,
  };
}
