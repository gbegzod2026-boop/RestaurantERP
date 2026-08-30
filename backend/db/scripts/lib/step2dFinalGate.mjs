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
  railwayLivePreflight = "NOT RE-RUN",
  humanApprovalPresent = false,
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

  const gates = [
    gate(
      "railwayPgSchema",
      railwayLivePreflight,
      "GO",
      railwayLivePreflight === "PASS" || railwayLivePreflight === "GO"
        ? "PASS"
        : railwayLivePreflight === "FAIL" ? "FAIL" : "NOT VERIFIED",
      "live step2d2-prod-pg-preflight this process; prior operator GO is not re-used as a silent PASS",
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
    gate("productionWriteStop", productionWriteStopVerified ? "verified" : "NOT VERIFIED", "tenant POST 503 MAINTENANCE on production; webhooks never HTTP 200", productionWriteStopVerified ? "PASS" : "NOT VERIFIED", "this script does not probe production HTTP; local middleware tests are not production write-stop", { blocksApproval: true }),
    gate("workingTreeFreeze", freeze.workingTreeClean, "PASS (clean tree)", freeze.workingTreeClean === "PASS" ? "PASS" : "FAIL", "git status --porcelain empty", { blocksApproval: true }),
    gate("deployFreeze", freeze.deployFreeze, "PASS (clean tree + HEAD + tag nesta-step2-cutover-ready = current cutover candidate)", freeze.deployFreeze === "PASS" ? "PASS" : "FAIL", "git rev-parse HEAD and nesta-step2-cutover-ready; historical nesta-step2c-cutover is not the freeze target", { blocksApproval: true }),
    gate("finalFirebaseSnapshot", freezeSnapshotVerified ? "freeze-time verified" : (snapshotPresent ? "prior report present" : "absent"), "read-only source snapshot/count at freeze", freezeSnapshotVerified ? "PASS" : "NOT VERIFIED", "prior step2d-source-snapshot.json is not freeze-time evidence", { blocksApproval: true }),
    gate("railwayLivePreflightThisRun", railwayLivePreflight, "GO", railwayLivePreflight === "PASS" || railwayLivePreflight === "GO" ? "PASS" : "NOT VERIFIED", "DATABASE_PUBLIC_URL live identify; not run unless URL present", { blocksApproval: false }),
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
  };
}
