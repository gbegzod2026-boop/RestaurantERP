import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import dotenv from "dotenv";
import {
  readLocalPgParts,
  migrationChildEnv,
} from "./lib/migrationTargetGuard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, "../..");
if (/:59999\b/.test(process.env.POSTGRES_URL || "")) delete process.env.POSTGRES_URL;
if (process.env.FIREBASE_DATABASE_URL === "") delete process.env.FIREBASE_DATABASE_URL;
dotenv.config({ path: path.join(BACKEND, ".env"), quiet: true });

function cleanFirebaseOverlay() {
  // Strip only the isolated-app Auth emulator overlay. Production RTDB
  // URL / service-account path must remain so fbRead can GET source data.
  // Never strip FIREBASE_DATABASE_URL or credential paths here.
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  delete process.env.NESTA_REQUIRE_ISOLATED_AUTH;
}

function targetEnv() {
  cleanFirebaseOverlay();
  delete process.env.PORT;
  const parts = readLocalPgParts();
  if (!parts.host || !parts.user) throw new Error("PostgreSQL host/user not configured");
  const env = migrationChildEnv({ ...process.env, PORT: undefined }, parts);
  // Local runner never inherits a production apply confirmation.
  delete env.NESTA_MIGRATE_TARGET;
  delete env.NESTA_PRODUCTION_MIGRATE_CONFIRM;
  delete env.NESTA_PRODUCTION_MIGRATE_TAG;
  delete env.NESTA_PRODUCTION_ALLOW_RESUME;
  return env;
}

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: BACKEND, env, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exit ${code}`))));
  });
}

const step = process.argv[2];
const map = {
  wave1: ["db/scripts/migrate-wave1-apply.mjs", "--apply", "--fresh"],
  "wave1-dry": ["db/scripts/migrate-wave1-apply.mjs", "--dry-run", "--fresh"],
  credentials: ["db/scripts/step2b-credentials-local.mjs"],
  "fb-apply": ["db/scripts/migrate-firebase.mjs", "--apply", "--reset-checkpoint"],
  "fb-resume": ["db/scripts/migrate-firebase.mjs", "--apply", "--resume"],
  "fb-limit3": ["db/scripts/migrate-firebase.mjs", "--apply", "--reset-checkpoint", "--limit", "3"],
  "fb-idempotent": ["db/scripts/migrate-firebase.mjs", "--apply"],
  "fb-dry": ["db/scripts/migrate-firebase.mjs", "--dry-run", "--reset-checkpoint"],
  discover: ["db/scripts/firebase-discover.mjs"],
  roots: ["db/scripts/firebase-discover-legacy-roots.mjs"],
  issues: ["db/scripts/step2a-source-issues.mjs"],
  reconcile: ["db/scripts/step2b-reconcile.mjs"],
  counts: ["db/scripts/step2b-counts.mjs"],
  promocodes: ["db/scripts/step2c-promocodes.mjs"],
  "fee-probe": ["db/scripts/step2c-fee-probe.mjs"],
  "fee-reclass": ["db/scripts/step2c-fee-probe.mjs", "--write-reclass"],
  "source-snapshot": ["db/scripts/step2d-source-snapshot.mjs"],
  "pg-precheck": ["db/scripts/step2d-pg-precheck.mjs"],
  "prod-preflight": ["db/scripts/step2d2-prod-pg-preflight.mjs"],
  rehearsal: ["db/scripts/step2d2-rehearsal.mjs"],
  "backup-verify": ["db/scripts/step2d2-backup-verify.mjs"],
};

const AS_CONFIGURED = new Set(["prod-preflight", "backup-verify"]);

if (!map[step]) {
  console.error("usage: step2b-run.mjs <wave1|wave1-dry|credentials|fb-apply|fb-resume|fb-limit3|fb-idempotent|fb-dry|discover|roots|issues|reconcile|counts|promocodes|fee-probe|fee-reclass|source-snapshot|pg-precheck|prod-preflight|rehearsal|backup-verify>");
  process.exit(2);
}

const childEnv = AS_CONFIGURED.has(step)
  ? (() => {
    cleanFirebaseOverlay();
    delete process.env.PORT;
    return { ...process.env };
  })()
  : targetEnv();

run(map[step], childEnv).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
