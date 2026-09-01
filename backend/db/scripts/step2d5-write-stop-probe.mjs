// Step 2D.5 production write-stop probe.
// GET /api/health first. If maintenance is not advertised, STOP without POSTing
// tenant writes. Never creates orders or payments. Never enables maintenance.
// WRITE_STOP.json is unsigned local evidence: authority is current-window
// identity + freshness, not file recency.
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { classifyHealth, evaluateWriteStop } from "./lib/writeStopProbe.mjs";
import {
  probeRuntimeRevision,
  REQUIRED_PRODUCTION_PROBE_ORIGIN,
  evaluateProductionProbeUrl,
} from "./lib/deployedRevision.mjs";
import { probeLiveGithubMain, makeGitLsRemoteImpl, LS_REMOTE_TIMEOUT_MS } from "./lib/githubRemote.mjs";
import { computeCutoverWindowIdentity, buildWriteStopEvidence } from "./lib/cutoverWindow.mjs";
import { readOperatorGitFacts } from "./lib/deployFreeze.mjs";

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

async function fetchJson(origin, pathname, method, body) {
  const res = await fetch(`${origin}${pathname}`, {
    method,
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function main() {
  const originCheck = evaluateProductionProbeUrl(
    process.env.NESTA_CUTOVER_PROBE_BASE_URL || REQUIRED_PRODUCTION_PROBE_ORIGIN,
  );
  if (!originCheck.ok) {
    console.log(JSON.stringify({
      productionWriteStop: "NOT VERIFIED",
      reason: originCheck.reason,
      writeObserved: false,
    }, null, 2));
    process.exit(2);
  }
  const origin = originCheck.origin;
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
    baseUrl: origin,
    fetchImpl: fetch,
  });
  const cutoverWindowIdentity = computeCutoverWindowIdentity({
    candidateCommit: facts.head,
    remoteMain: liveGithub.liveRemoteMain,
    deployedRevision: revisionProbe.revision,
  });
  if (!cutoverWindowIdentity) {
    console.log(JSON.stringify({
      productionWriteStop: "NOT VERIFIED",
      reason: "current-window identity incomplete; refusing write probes",
      writeObserved: false,
    }, null, 2));
    process.exit(2);
  }

  const health = await fetchJson(origin, "/api/health", "GET");
  const healthClass = classifyHealth(health.status, health.body);
  if (!healthClass.maintenance) {
    console.log(JSON.stringify({
      productionWriteStop: "NOT VERIFIED",
      maintenance: "OFF",
      reason: "health.maintenance is not true; refusing tenant write/webhook POSTs so this probe cannot create production data",
      writeObserved: false,
    }, null, 2));
    process.exit(2);
  }

  const tenantWrite = await fetchJson(origin, "/api/pg/rtdb/set", "POST", { probe: true });
  const click = await fetchJson(origin, "/api/click/webhook", "POST", {});
  const payme = await fetchJson(origin, "/api/payme/webhook", "POST", { id: 1 });
  const uzum = await fetchJson(origin, "/api/uzum/webhook", "POST", {});
  const classified = evaluateWriteStop({
    health: healthClass,
    tenantWrite,
    click,
    payme,
    uzum,
  });
  const generatedAt = new Date().toISOString();
  const evidence = buildWriteStopEvidence({
    classified: { ...classified, maintenance: "ON" },
    generatedAt,
    origin,
    candidateCommit: facts.head,
    cutoverWindowIdentity,
  });

  const stamp = generatedAt.replace(/[:.]/g, "-");
  const outDir = path.join(REPO, "cutover-backups", `write-stop-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "WRITE_STOP.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.writeObserved) process.exit(1);
  process.exit(evidence.productionWriteStop === "PASS" ? 0 : 1);
}

main().catch(() => {
  console.error("WRITE-STOP PROBE FAILED: OPERATOR_CLI_FAILED");
  process.exit(1);
});
