// Operator backup verification. Reports NOT VERIFIED unless the operator
// supplies artifact paths. Never prints backup contents, secrets, or .env.
import { existsSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

function gitIgnored(filePath) {
  try {
    execFileSync("git", ["-c", `safe.directory=${REPO_ROOT}`, "check-ignore", "-q", filePath], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function inspectPath(envName) {
  const p = String(process.env[envName] || "").trim();
  if (!p) {
    return { verdict: "NOT VERIFIED", reason: `${envName} is unset` };
  }
  if (!existsSync(p)) {
    return { verdict: "NOT VERIFIED", pathPresent: false, reason: "path does not exist" };
  }
  const st = statSync(p);
  const abs = path.resolve(p);
  const insideRepo = abs.startsWith(REPO_ROOT);
  return {
    verdict: insideRepo && !gitIgnored(abs) ? "NOT VERIFIED" : "PRESENT",
    pathPresent: true,
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    bytes: st.size,
    mtime: st.mtime.toISOString(),
    insideRepo,
    gitIgnored: insideRepo ? gitIgnored(abs) : true,
    reason: insideRepo && !gitIgnored(abs)
      ? "artifact is inside the git worktree and not ignored"
      : undefined,
  };
}

function gitHead() {
  try {
    return execFileSync("git", ["-c", `safe.directory=${REPO_ROOT}`, "rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function gitTagCommit(tag) {
  try {
    return execFileSync("git", ["-c", `safe.directory=${REPO_ROOT}`, "rev-parse", tag], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const candidateTag = "nesta-step2-cutover-ready";
  const expected = gitTagCommit(candidateTag);
  const head = gitHead();
  const historical = gitTagCommit("nesta-step2c-cutover");
  const report = {
    generatedAt: new Date().toISOString(),
    firebaseBackup: inspectPath("NESTA_FIREBASE_BACKUP_PATH"),
    postgresDump: inspectPath("NESTA_PG_BACKUP_PATH"),
    envBackup: inspectPath("NESTA_ENV_BACKUP_PATH"),
    application: {
      workingTreeHead: head,
      expectedFrozenCommit: expected,
      cutoverCandidateTag: candidateTag,
      headMatchesFrozen: Boolean(expected) && head === expected,
      tagCommit: expected,
      tagMatchesFrozen: Boolean(expected) && expected === gitTagCommit(candidateTag),
      step2cHistoricalTag: "nesta-step2c-cutover",
      step2cHistoricalCommit: historical,
      dataBackendUnchangedNote: "This script does not read or change DATA_BACKEND.",
      secretsOutsideGit: "Confirm .env and service-account files remain untracked. Do not print them.",
      verdict: Boolean(expected) && head === expected ? "COMMIT_TAG_MATCH" : "NOT VERIFIED",
    },
    postgresRestoreDrill: {
      verdict: "NOT VERIFIED",
      reason: "Restore into a disposable database is operator-owned. Local schema-only drill lives in step2d1-schema-restore-drill.mjs and is not a production dump restore.",
    },
  };
  const allPresent = ["firebaseBackup", "postgresDump", "envBackup"]
    .every((k) => report[k].verdict === "PRESENT");
  report.verdict = allPresent && report.application.verdict === "COMMIT_TAG_MATCH"
    ? "READY_FOR_OPERATOR_SIGN_OFF"
    : "NOT VERIFIED";
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict !== "READY_FOR_OPERATOR_SIGN_OFF") process.exit(1);
}

main().catch((err) => {
  console.error("BACKUP VERIFY FAILED:", err.message);
  process.exit(1);
});
