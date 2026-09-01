// Step 2D.5 — git deploy freeze check. Does not push, deploy, or mutate remotes.
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { freezeGitFromResolved, evaluateDeployFreeze, inspectGitTag, readOperatorGitFacts } from "./lib/deployFreeze.mjs";

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

const facts = readOperatorGitFacts(gitValue);
const report = evaluateDeployFreeze(freezeGitFromResolved({
  env: process.env,
  head: facts.head,
  dirty: facts.dirty,
  branch: facts.branch,
  originMain: facts.originMain,
  inspectTag: (tag) => inspectGitTag(tag, gitValue, gitRaw),
}), process.env);
console.log(JSON.stringify({
  ...report,
  pushed: false,
  deployed: false,
}, null, 2));
process.exit(report.deployFreeze === "PASS" ? 0 : 2);
