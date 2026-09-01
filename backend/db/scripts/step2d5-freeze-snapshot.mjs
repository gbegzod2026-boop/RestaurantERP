// Step 2D.5 READ-ONLY freeze-time Firebase snapshot.
// GET only via fbRead. No Auth mutation. Requires --freeze-window.
import { fileURLToPath } from "url";
import path from "path";
import { initFirebase, shallowKeys, getValue } from "./lib/fbRead.mjs";
import { EXPECTED_FIREBASE_PROJECT } from "./lib/freezeSnapshot.mjs";
import { computeCutoverWindowIdentity } from "./lib/cutoverWindow.mjs";
import { produceFreezeSnapshot, FREEZE_READ_FAILED } from "./lib/freezeCollector.mjs";
import { readOperatorGitFacts } from "./lib/deployFreeze.mjs";
import {
  probeRuntimeRevision,
  REQUIRED_PRODUCTION_PROBE_ORIGIN,
} from "./lib/deployedRevision.mjs";
import { probeLiveGithubMain, makeGitLsRemoteImpl, LS_REMOTE_TIMEOUT_MS } from "./lib/githubRemote.mjs";
import { execFileSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "../../..");

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

function projectFromUrl(dbUrl) {
  try {
    const host = new URL(dbUrl).hostname;
    const m = host.match(/^([^.]+)\./);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function main() {
  if (!process.argv.includes("--freeze-window")) {
    console.log(JSON.stringify({
      freezeFirebaseSnapshot: "NOT RUN",
      reason: "pass --freeze-window to take a READ-ONLY freeze-time snapshot",
    }, null, 2));
    process.exit(2);
  }

  const facts = readOperatorGitFacts(gitValue);
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
    baseUrl: REQUIRED_PRODUCTION_PROBE_ORIGIN,
    fetchImpl: fetch,
  });
  const cutoverWindowIdentity = computeCutoverWindowIdentity({
    candidateCommit: facts.head,
    remoteMain: liveGithub.liveRemoteMain,
    deployedRevision: revisionProbe.revision,
  });
  if (!cutoverWindowIdentity) {
    console.log(JSON.stringify({
      freezeFirebaseSnapshot: "NOT RUN",
      reason: "current-window identity incomplete; refusing freeze snapshot",
    }, null, 2));
    process.exit(2);
  }

  initFirebase();
  const dbUrl = process.env.FIREBASE_DATABASE_URL || "";
  const project = process.env.FIREBASE_PROJECT_ID || projectFromUrl(dbUrl);
  if (project !== EXPECTED_FIREBASE_PROJECT) {
    console.error("Refusing: Firebase project is not restoran-30d51");
    process.exit(2);
  }
  let host = "(unparseable)";
  try { host = new URL(dbUrl).host; } catch { /* ignore */ }
  if (host.includes("nesta-staging")) {
    console.error("Refusing: discovery host is not production RTDB");
    process.exit(2);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const generatedAt = new Date().toISOString();
  const result = await produceFreezeSnapshot({
    shallowKeys,
    getValue,
    outDir: path.join(REPO, "cutover-backups", `freeze-snapshot-${stamp}`),
    generatedAt,
    candidateCommit: facts.head,
    cutoverWindowIdentity,
    firebaseProject: EXPECTED_FIREBASE_PROJECT,
  });

  if (!result.ok) {
    console.log(JSON.stringify({
      freezeFirebaseSnapshot: "FAIL",
      code: result.code || FREEZE_READ_FAILED,
      dimension: result.dimension || null,
      artifactClass: "none",
    }, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify({
    freezeFirebaseSnapshot: "PASS",
    generatedAt,
    firebaseProject: EXPECTED_FIREBASE_PROJECT,
    counts: result.counts,
    candidateCommit: facts.head,
    cutoverWindowIdentity,
    artifactClass: "cutover-backups/freeze-snapshot-*/FREEZE.json",
  }, null, 2));
}

main().catch(() => {
  console.error("FREEZE SNAPSHOT FAILED");
  process.exit(1);
});
