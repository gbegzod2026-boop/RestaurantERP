// Step 2D.4 — production app/config rollback inventory + file copies.
// Copies gitignored artifacts without printing secret values.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import dotenv from "dotenv";
import { paymentCutoverReport } from "../../payments/cutoverMode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "../../..");
const BACKEND = path.join(__dirname, "../..");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = path.join(REPO, "cutover-backups", `app-config-${STAMP}`);

function git(args) {
  try {
    return execFileSync("git", ["-c", `safe.directory=${REPO}`, ...args], {
      cwd: REPO,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function copySecretFile(src, destName) {
  if (!existsSync(src)) return { copied: false, name: destName, reason: "source absent" };
  copyFileSync(src, path.join(OUT_DIR, destName));
  const st = statSync(path.join(OUT_DIR, destName));
  return { copied: true, name: destName, bytes: st.size };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const isolated = {};
  dotenv.config({ path: path.join(BACKEND, ".env"), processEnv: isolated, quiet: true });
  const secretNameRe = /PASSWORD|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL|URL/i;
  const secretNames = Object.keys(isolated).filter((k) => secretNameRe.test(k)).sort();
  const nonSecretNames = Object.keys(isolated).filter((k) => !secretNameRe.test(k)).sort();

  const envCopy = copySecretFile(path.join(BACKEND, ".env"), "backend.env");
  const saCopy = copySecretFile(path.join(BACKEND, "serviceAccountKey.json"), "serviceAccountKey.json");

  const pkg = JSON.parse(readFileSync(path.join(BACKEND, "package.json"), "utf8"));
  let frontendPkg = null;
  const fePkgPath = path.join(REPO, "admin-frontend", "package.json");
  if (existsSync(fePkgPath)) frontendPkg = JSON.parse(readFileSync(fePkgPath, "utf8"));

  const inventory = {
    generatedAt: new Date().toISOString(),
    git: {
      head: git(["rev-parse", "HEAD"]),
      tagNestaStep2c: git(["rev-parse", "nesta-step2c-cutover"]),
      tagCutoverCandidate: git(["rev-parse", "nesta-step2-cutover-ready"]),
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
      dirty: Boolean(git(["status", "--porcelain"])),
    },
    backend: { name: pkg.name, version: pkg.version },
    frontend: frontendPkg ? { name: frontendPkg.name, version: frontendPkg.version } : { reason: "no admin-frontend/package.json version source" },
    runtimeFlags: {
      DATA_BACKEND: isolated.DATA_BACKEND || process.env.DATA_BACKEND || "(unset)",
      POSTGRES_POOL_MAX: isolated.POSTGRES_POOL_MAX || process.env.POSTGRES_POOL_MAX || "(unset, code default 10)",
      NESTA_MAINTENANCE_MODE: isolated.NESTA_MAINTENANCE_MODE || process.env.NESTA_MAINTENANCE_MODE || "(unset)",
      NESTA_PAYMENT_CUTOVER_MODE: isolated.NESTA_PAYMENT_CUTOVER_MODE || process.env.NESTA_PAYMENT_CUTOVER_MODE || "(unset)",
    },
    firebaseFrontendConfigNames: [
      "FIREBASE_API_KEY",
      "FIREBASE_AUTH_DOMAIN",
      "FIREBASE_DATABASE_URL",
      "FIREBASE_PROJECT_ID",
      "FIREBASE_STORAGE_BUCKET",
      "FIREBASE_MESSAGING_SENDER_ID",
      "FIREBASE_APP_ID",
    ].filter((k) => k in isolated || k in process.env),
    secretNamesOnly: secretNames,
    nonSecretConfigNames: nonSecretNames,
    copies: { env: envCopy, serviceAccount: saCopy },
    reverseProxy: "NOT VERIFIED (no nginx/caddy/cloudflare config in this workspace)",
    payment: paymentCutoverReport({ ...isolated, ...process.env }),
    poolRuntime: {
      codeDefault: 10,
      envValue: isolated.POSTGRES_POOL_MAX || process.env.POSTGRES_POOL_MAX || null,
      respected: true,
      note: "backend/db/postgres.js uses Number(process.env.POSTGRES_POOL_MAX || 10)",
    },
  };
  writeFileSync(path.join(OUT_DIR, "INVENTORY.json"), JSON.stringify(inventory, null, 2));

  const appOk = Boolean(inventory.git.head) && envCopy.copied;
  const configOk = envCopy.copied;
  const report = {
    appRollbackBackup: appOk ? "PASS" : "NOT VERIFIED",
    configRollbackBackup: configOk ? "PASS" : "NOT VERIFIED",
    gitHead: inventory.git.head,
    tag: inventory.git.tagNestaStep2c,
    dataBackend: inventory.runtimeFlags.DATA_BACKEND,
    postgresPoolMax: inventory.runtimeFlags.POSTGRES_POOL_MAX,
    secretNameCount: secretNames.length,
    envCopied: envCopy.copied,
    serviceAccountCopied: saCopy.copied,
    reverseProxy: inventory.reverseProxy,
    dumpDirClass: "cutover-backups/app-config-* (gitignored)",
  };
  console.log(JSON.stringify(report, null, 2));
  if (!appOk || !configOk) process.exit(1);
}

main().catch((err) => {
  console.error("APP/CONFIG BACKUP FAILED:", err.message);
  process.exit(1);
});
