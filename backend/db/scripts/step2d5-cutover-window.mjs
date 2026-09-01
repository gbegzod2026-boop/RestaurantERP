// Step 2D.5 cutover-window arming report.
// Does not enable maintenance, migrate, switch DATA_BACKEND, or push.
import { readdirSync, existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import dotenv from "dotenv";
import { isMaintenanceMode } from "../../security/maintenance.js";
import { evaluateStep2dFinalGates, confirmStatus, EXPECTED_PAUSE_CONFIRM } from "./lib/step2dFinalGate.mjs";
import { freezeGitFromResolved, evaluateDeployFreeze, inspectGitTag, readOperatorGitFacts } from "./lib/deployFreeze.mjs";
import { currentFreezeBinding } from "./lib/freezeSnapshot.mjs";
import { computeCutoverWindowIdentity, currentWriteStopBinding } from "./lib/cutoverWindow.mjs";
import { runRailwayLivePreflight, evaluateLiveRailwayPreflight, classifyOperatorCliFailure } from "./lib/runRailwayLivePreflight.mjs";
import { writeRailwayLivePreflightAudit } from "./lib/railwayLivePreflightEvidence.mjs";
import { probeRuntimeRevision, REQUIRED_PRODUCTION_PROBE_ORIGIN } from "./lib/deployedRevision.mjs";
import { probeLiveGithubMain, makeGitLsRemoteImpl, LS_REMOTE_TIMEOUT_MS } from "./lib/githubRemote.mjs";

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
  const facts = readOperatorGitFacts(gitValue);
  const git = freezeGitFromResolved({
    env,
    head: facts.head,
    dirty: facts.dirty,
    branch: facts.branch,
    originMain: facts.originMain,
    inspectTag: (tag) => inspectGitTag(tag, gitValue, gitRaw),
  });
  const freeze = evaluateDeployFreeze(git, env);
  const backups = scanBackups();
  const live = await runRailwayLivePreflight({ env: process.env, requireDatabasePublicUrl: true });
  try {
    writeRailwayLivePreflightAudit(REPO, live);
  } catch { /* audit must never authorize or change the live verdict */ }
  const railwayEvidence = evaluateLiveRailwayPreflight(live);
  const railwayLivePreflight = railwayEvidence.railwayLivePreflight;
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
  const revisionProbe = await probeRuntimeRevision({
    baseUrl: process.env.NESTA_CUTOVER_PROBE_BASE_URL || REQUIRED_PRODUCTION_PROBE_ORIGIN,
    fetchImpl: fetch,
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
    snapshotPresent: existsSync(path.join(REPO, "docs", "migration-reports", "step2d-source-snapshot.json")),
    writeStopEvidence: writeStopDoc,
    freezeEvidence: freezeDoc,
    railwayLivePreflight,
    humanApprovalPresent: false,
    runtimeRevision: revisionProbe.revision,
    liveRemoteMain: liveGithub.liveRemoteMain,
    now,
  });

  const report = {
    step2d5CutoverWindowGate: evaluated.cutoverWindowArmed ? "PASS" : (evaluated.preflightReady ? "PARTIAL" : "FAIL"),
    phase: evaluated.phase,
    deployFreeze: freeze.deployFreeze,
    workingTreeClean: freeze.workingTreeClean,
    tagMatch: freeze.tagMatch,
    headMatch: freeze.headMatch,
    branchMatch: freeze.branchMatch,
    detachedHead: freeze.detachedHead,
    originMainMatch: evaluated.gates.find((g) => g.name === "originMainMatch")?.result,
    remoteMainLive: evaluated.remoteMainLive,
    deployedRevision: evaluated.deployedRevision,
    cachedOriginMainAuthoritative: false,
    liveGithubReason: liveGithub.reason || null,
    runtimeRevisionReason: revisionProbe.reason || null,
    maintenance: isMaintenanceMode(env) ? "ON" : "OFF",
    productionWriteStop: evaluated.writeStopEvidenceOk ? "PASS" : "NOT VERIFIED",
    paymentPause: evaluated.confirm === "MATCH" && evaluated.mode === "OPERATOR_PAUSED" ? "PASS" : "FAIL",
    freezeFirebaseSnapshot: evaluated.freezeEvidenceOk ? "PASS" : "NOT RUN",
    cutoverWindowIdentity: evaluated.cutoverWindowIdentity,
    railwayLivePreflight,
    railwayLivePreflightReason: railwayEvidence.reason,
    preflightJsonAuthorization: false,
    remainingApprovalBlockers: evaluated.approvalBlockers,
    safeToRequestHumanApproval: evaluated.safeToRequestHumanApproval,
    safeToMigrateProductionData: false,
    providerPauseEvidence: "OPERATOR ATTESTATION",
    operatorCommands: {
      maintenance: "Set NESTA_MAINTENANCE_MODE=1 on every production backend instance and restart. This agent does not enable it.",
      writeStop: "NESTA_CUTOVER_PROBE_BASE_URL=https://restauranterp-production-5c27.up.railway.app node db/scripts/step2d5-write-stop-probe.mjs",
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
  console.error("STEP 2D.5 WINDOW FAILED:", classifyOperatorCliFailure(err));
  process.exit(1);
});
