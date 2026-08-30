// Step 2D.5 — git deploy freeze check. Does not push, deploy, or mutate remotes.
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { candidateFreezeInput, CUTOVER_CANDIDATE_TAG, evaluateDeployFreeze } from "./lib/deployFreeze.mjs";

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

const porcelain = gitValue(["status", "--porcelain"]);
const candidate = gitValue(["rev-parse", CUTOVER_CANDIDATE_TAG]);
const report = evaluateDeployFreeze(candidateFreezeInput({
  head: gitValue(["rev-parse", "HEAD"]),
  candidateTagCommit: candidate,
  dirty: porcelain == null ? null : porcelain.length > 0,
}));
console.log(JSON.stringify({ ...report, pushed: false, deployed: false }, null, 2));
process.exit(report.deployFreeze === "PASS" ? 0 : 2);
