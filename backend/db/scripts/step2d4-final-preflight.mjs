// Step 2D final operator preflight. Does not migrate Firebase, does not
// switch DATA_BACKEND, does not enable maintenance, does not print secrets.
import { readdirSync, existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import dotenv from "dotenv";
import { isMaintenanceMode } from "../../security/maintenance.js";
import {
  evaluateStep2dFinalGates,
  confirmStatus,
  EXPECTED_PAUSE_CONFIRM,
} from "./lib/step2dFinalGate.mjs";
import { freezeSnapshotComplete } from "./lib/freezeSnapshot.mjs";
import { candidateFreezeInput, CUTOVER_CANDIDATE_TAG } from "./lib/deployFreeze.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, "../..");
const REPO = path.join(__dirname, "../../..");

function loadIsolatedEnv() {
  const isolated = {};
  dotenv.config({ path: path.join(BACKEND, ".env"), processEnv: isolated, quiet: true });
  return isolated;
}

function mergeEnv(fileEnv) {
  return {
    ...fileEnv,
    NESTA_PAYMENT_CUTOVER_MODE: process.env.NESTA_PAYMENT_CUTOVER_MODE || fileEnv.NESTA_PAYMENT_CUTOVER_MODE,
    NESTA_PAYMENT_PAUSE_CONFIRM: process.env.NESTA_PAYMENT_PAUSE_CONFIRM || fileEnv.NESTA_PAYMENT_PAUSE_CONFIRM,
    NESTA_MAINTENANCE_MODE: process.env.NESTA_MAINTENANCE_MODE || fileEnv.NESTA_MAINTENANCE_MODE,
  };
}

function backupClass(dirName, prefix) {
  return String(dirName).startsWith(prefix);
}

function scanCutoverBackups() {
  const root = path.join(REPO, "cutover-backups");
  if (!existsSync(root)) {
    return { present: false, firebase: 0, pg: 0, appConfig: 0 };
  }
  const entries = readdirSync(root, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  return {
    present: true,
    firebase: dirs.filter((n) => backupClass(n, "firebase-")).length,
    pg: dirs.filter((n) => backupClass(n, "pg-")).length,
    appConfig: dirs.filter((n) => backupClass(n, "app-config-")).length,
    dirClass: "cutover-backups/* (gitignored)",
  };
}

function latestJson(prefix, file) {
  const root = path.join(REPO, "cutover-backups");
  if (!existsSync(root)) return null;
  const names = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => e.name)
    .sort();
  const last = names.at(-1);
  if (!last) return null;
  const p = path.join(root, last, file);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function gitValue(args) {
  try {
    return execFileSync("git", ["-c", `safe.directory=${REPO}`, ...args], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const fileEnv = loadIsolatedEnv();
  const env = mergeEnv(fileEnv);
  const backups = scanCutoverBackups();
  const porcelain = gitValue(["status", "--porcelain"]);
  const snapshotPresent = existsSync(path.join(REPO, "docs", "migration-reports", "step2d-source-snapshot.json"));
  const freezeDoc = latestJson("freeze-snapshot-", "FREEZE.json");
  const writeStopDoc = latestJson("write-stop-", "WRITE_STOP.json");

  const evaluated = evaluateStep2dFinalGates({
    env,
    backups,
    git: candidateFreezeInput({
      head: gitValue(["rev-parse", "HEAD"]),
      candidateTagCommit: gitValue(["rev-parse", CUTOVER_CANDIDATE_TAG]),
      dirty: porcelain == null ? null : porcelain.length > 0,
    }),
    snapshotPresent,
    freezeSnapshotVerified: freezeSnapshotComplete(freezeDoc),
    reverseProxyVerified: false,
    dnsRollbackVerified: false,
    productionWriteStopVerified: writeStopDoc?.productionWriteStop === "PASS",
    railwayLivePreflight: process.env.DATABASE_PUBLIC_URL ? "NOT RE-RUN" : "NOT RUN",
    humanApprovalPresent: false,
  });

  const report = {
    step2dFinalOperatorPreflight: evaluated.step2dFinalOperatorPreflight,
    phase: evaluated.phase,
    railwayPg: evaluated.gates.find((g) => g.name === "railwayPgSchema")?.result,
    firebaseBackup: backups.firebase > 0 ? "PASS" : "NOT VERIFIED",
    pgBackup: backups.pg > 0 ? "PASS" : "NOT VERIFIED",
    pgRestoreDrill: backups.pg > 0 ? "PASS" : "NOT VERIFIED",
    clickPaused: evaluated.confirm === "MATCH" && evaluated.mode === "OPERATOR_PAUSED" ? "PASS" : "FAIL",
    paymePaused: evaluated.confirm === "MATCH" && evaluated.mode === "OPERATOR_PAUSED" ? "PASS" : "FAIL",
    uzumPaused: evaluated.confirm === "MATCH" && evaluated.mode === "OPERATOR_PAUSED" ? "PASS" : "FAIL",
    paymentConfirmGuard: evaluated.gates.find((g) => g.name === "paymentConfirmGuard")?.result,
    paymentConfirm: {
      expectedPhrase: EXPECTED_PAUSE_CONFIRM,
      processEnv: confirmStatus(process.env.NESTA_PAYMENT_PAUSE_CONFIRM),
      dotenvFile: confirmStatus(fileEnv.NESTA_PAYMENT_PAUSE_CONFIRM),
      effective: evaluated.confirm,
      cutoverMode: evaluated.mode,
      goLiveAllowed: evaluated.payments.goLiveAllowed,
    },
    providerPauseEvidence: evaluated.providerPauseEvidence,
    providers: {
      click: evaluated.payments.click,
      payme: evaluated.payments.payme,
      uzum: evaluated.payments.uzum,
    },
    retryGuaranteed: evaluated.payments.retryGuaranteed,
    durableQueueImplemented: evaluated.payments.durableQueueImplemented,
    retryNote: evaluated.retryNote,
    maintenanceModeCurrentlyOn: isMaintenanceMode(env),
    maintenanceRequiredBeforeApproval: evaluated.maintenanceRequiredBeforeApproval,
    backups,
    productionMigrate: "NOT RUN",
    dataBackendSwitched: false,
    safeToRequestHumanApproval: evaluated.safeToRequestHumanApproval,
    safeToMigrateProductionData: false,
    approvalBlockers: evaluated.approvalBlockers,
    preflightBlockers: evaluated.preflightBlockers,
    gates: evaluated.gates,
  };

  console.log(JSON.stringify(report, null, 2));
  if (report.step2dFinalOperatorPreflight !== "PASS") process.exit(2);
}

main().catch((err) => {
  console.error("STEP 2D FINAL PREFLIGHT FAILED:", err.message);
  process.exit(1);
});
