// Step 2D.5 cutover-window arming report.
// Does not enable maintenance, migrate, switch DATA_BACKEND, or push.
import { readdirSync, existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import dotenv from "dotenv";
import { isMaintenanceMode } from "../../security/maintenance.js";
import { evaluateStep2dFinalGates, confirmStatus, EXPECTED_PAUSE_CONFIRM } from "./lib/step2dFinalGate.mjs";
import { candidateFreezeInput, CUTOVER_CANDIDATE_TAG, evaluateDeployFreeze } from "./lib/deployFreeze.mjs";
import { freezeSnapshotComplete } from "./lib/freezeSnapshot.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, "../..");
const REPO = path.join(__dirname, "../../..");

function loadEnv() {
  const isolated = {};
  dotenv.config({ path: path.join(BACKEND, ".env"), processEnv: isolated, quiet: true });
  return {
    ...isolated,
    NESTA_PAYMENT_CUTOVER_MODE: process.env.NESTA_PAYMENT_CUTOVER_MODE || isolated.NESTA_PAYMENT_CUTOVER_MODE,
    NESTA_PAYMENT_PAUSE_CONFIRM: process.env.NESTA_PAYMENT_PAUSE_CONFIRM || isolated.NESTA_PAYMENT_PAUSE_CONFIRM,
    NESTA_MAINTENANCE_MODE: process.env.NESTA_MAINTENANCE_MODE || isolated.NESTA_MAINTENANCE_MODE,
  };
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

function scanPrefix(prefix) {
  const root = path.join(REPO, "cutover-backups");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => e.name)
    .sort();
}

function latestJson(prefix, file) {
  const names = scanPrefix(prefix);
  const last = names.at(-1);
  if (!last) return null;
  const p = path.join(REPO, "cutover-backups", last, file);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function scanBackups() {
  return {
    firebase: scanPrefix("firebase-").length,
    pg: scanPrefix("pg-").length,
    appConfig: scanPrefix("app-config-").length,
  };
}

async function main() {
  const env = loadEnv();
  const porcelain = gitValue(["status", "--porcelain"]);
  const git = candidateFreezeInput({
    head: gitValue(["rev-parse", "HEAD"]),
    candidateTagCommit: gitValue(["rev-parse", CUTOVER_CANDIDATE_TAG]),
    dirty: porcelain == null ? null : porcelain.length > 0,
  });
  const freeze = evaluateDeployFreeze(git);
  const freezeDoc = latestJson("freeze-snapshot-", "FREEZE.json");
  const writeStopDoc = latestJson("write-stop-", "WRITE_STOP.json");
  const backups = scanBackups();
  const railwayLivePreflight = process.env.DATABASE_PUBLIC_URL ? "NOT RE-RUN" : "NOT RUN";

  const evaluated = evaluateStep2dFinalGates({
    env,
    backups,
    git,
    snapshotPresent: existsSync(path.join(REPO, "docs", "migration-reports", "step2d-source-snapshot.json")),
    freezeSnapshotVerified: freezeSnapshotComplete(freezeDoc),
    productionWriteStopVerified: writeStopDoc?.productionWriteStop === "PASS",
    railwayLivePreflight,
    humanApprovalPresent: false,
  });

  const report = {
    step2d5CutoverWindowGate: evaluated.cutoverWindowArmed ? "PASS" : (evaluated.preflightReady ? "PARTIAL" : "FAIL"),
    phase: evaluated.phase,
    deployFreeze: freeze.deployFreeze,
    workingTreeClean: freeze.workingTreeClean,
    tagMatch: freeze.tagMatch,
    headMatch: freeze.headMatch,
    maintenance: isMaintenanceMode(env) ? "ON" : "OFF",
    productionWriteStop: writeStopDoc?.productionWriteStop || "NOT VERIFIED",
    paymentPause: evaluated.confirm === "MATCH" && evaluated.mode === "OPERATOR_PAUSED" ? "PASS" : "FAIL",
    freezeFirebaseSnapshot: freezeSnapshotComplete(freezeDoc) ? "PASS" : "NOT RUN",
    railwayLivePreflight,
    remainingApprovalBlockers: evaluated.approvalBlockers,
    safeToRequestHumanApproval: evaluated.safeToRequestHumanApproval,
    safeToMigrateProductionData: false,
    providerPauseEvidence: "OPERATOR ATTESTATION",
    operatorCommands: {
      maintenance: "Set NESTA_MAINTENANCE_MODE=1 on every production backend instance and restart. This agent does not enable it.",
      writeStop: "NESTA_CUTOVER_PROBE_BASE_URL=https://<prod-host> node db/scripts/step2d5-write-stop-probe.mjs",
      freezeSnapshot: "node db/scripts/step2d5-freeze-snapshot.mjs --freeze-window",
      railway: "node db/scripts/step2d2-prod-pg-preflight.mjs",
      window: "node db/scripts/step2d5-cutover-window.mjs",
    },
    paymentConfirm: {
      expectedPhrase: EXPECTED_PAUSE_CONFIRM,
      effective: confirmStatus(env.NESTA_PAYMENT_PAUSE_CONFIRM),
      cutoverMode: evaluated.mode,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(evaluated.cutoverWindowArmed ? 0 : 2);
}

main().catch((err) => {
  console.error("STEP 2D.5 WINDOW FAILED:", err.message);
  process.exit(1);
});
