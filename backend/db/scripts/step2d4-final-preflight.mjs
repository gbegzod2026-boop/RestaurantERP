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
import { currentFreezeBinding } from "./lib/freezeSnapshot.mjs";
import { freezeGitFromResolved, inspectGitTag, readOperatorGitFacts } from "./lib/deployFreeze.mjs";
import { runRailwayLivePreflight, evaluateLiveRailwayPreflight, classifyOperatorCliFailure } from "./lib/runRailwayLivePreflight.mjs";
import { writeRailwayLivePreflightAudit } from "./lib/railwayLivePreflightEvidence.mjs";
import { probeRuntimeRevision, REQUIRED_PRODUCTION_PROBE_ORIGIN } from "./lib/deployedRevision.mjs";
import { probeLiveGithubMain, makeGitLsRemoteImpl, LS_REMOTE_TIMEOUT_MS } from "./lib/githubRemote.mjs";
import { computeCutoverWindowIdentity, currentWriteStopBinding } from "./lib/cutoverWindow.mjs";

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

function gitRaw(args) {
  try {
    return execFileSync("git", ["-c", `safe.directory=${REPO}`, ...args], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

async function main() {
  const fileEnv = loadIsolatedEnv();
  const env = mergeEnv(fileEnv);
  const backups = scanCutoverBackups();
  const facts = readOperatorGitFacts(gitValue);
  const snapshotPresent = existsSync(path.join(REPO, "docs", "migration-reports", "step2d-source-snapshot.json"));
  const git = freezeGitFromResolved({
    env,
    head: facts.head,
    dirty: facts.dirty,
    branch: facts.branch,
    originMain: facts.originMain,
    inspectTag: (tag) => inspectGitTag(tag, gitValue, gitRaw),
  });
  const live = await runRailwayLivePreflight({ env: process.env, requireDatabasePublicUrl: true });
  try {
    writeRailwayLivePreflightAudit(REPO, live);
  } catch { /* audit-only */ }
  const revisionProbe = await probeRuntimeRevision({
    baseUrl: process.env.NESTA_CUTOVER_PROBE_BASE_URL || REQUIRED_PRODUCTION_PROBE_ORIGIN,
    fetchImpl: fetch,
  });
  const originUrl = gitValue(["remote", "get-url", "origin"]);
  const liveGithub = probeLiveGithubMain({
    originUrl,
    head: facts.head,
    lsRemoteImpl: makeGitLsRemoteImpl({
      repo: REPO,
      originUrl,
      execFileSyncImpl: execFileSync,
      timeoutMs: LS_REMOTE_TIMEOUT_MS,
    }),
  });
  const expectedIdentity = computeCutoverWindowIdentity({
    candidateCommit: git.head,
    remoteMain: liveGithub.liveRemoteMain,
    deployedRevision: revisionProbe.revision,
  });
  const now = Date.now();
  const writeStopBinding = currentWriteStopBinding(REPO, {
    expectedIdentity,
    expectedCommit: git.head,
    now,
  });
  const writeStopDoc = writeStopBinding.ok ? writeStopBinding.doc : null;
  const freezeBinding = currentFreezeBinding(REPO, {
    expectedIdentity,
    expectedCommit: git.head,
    writeStopGeneratedAt: writeStopDoc?.generatedAt,
    now,
  });
  const freezeDoc = freezeBinding.ok ? freezeBinding.doc : latestJson("freeze-snapshot-", "FREEZE.json");

  const evaluated = evaluateStep2dFinalGates({
    env,
    backups,
    git,
    snapshotPresent,
    reverseProxyVerified: false,
    dnsRollbackVerified: false,
    writeStopEvidence: writeStopDoc,
    freezeEvidence: freezeDoc,
    railwayLivePreflight: evaluateLiveRailwayPreflight(live).railwayLivePreflight,
    humanApprovalPresent: false,
    runtimeRevision: revisionProbe.revision,
    liveRemoteMain: liveGithub.liveRemoteMain,
    now,
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
  console.error("STEP 2D FINAL PREFLIGHT FAILED:", classifyOperatorCliFailure(err));
  process.exit(1);
});
