// READ-ONLY production PostgreSQL preflight CLI.
// Delegates to runRailwayLivePreflight. Never CREATE/ALTER/INSERT/DELETE.
// PREFLIGHT.json is written as AUDIT ONLY and is not an authorization input.
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { runRailwayLivePreflight, redactPreflightText } from "./lib/runRailwayLivePreflight.mjs";
import { writeRailwayLivePreflightAudit } from "./lib/railwayLivePreflightEvidence.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
if (/:59999\b/.test(process.env.POSTGRES_URL || "")) delete process.env.POSTGRES_URL;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
delete process.env.NESTA_REQUIRE_ISOLATED_AUTH;
delete process.env.PORT;
dotenv.config({ path: path.join(__dirname, "../../.env"), quiet: true });
if (!process.env.POSTGRES_URL) {
  const alt = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (alt) process.env.POSTGRES_URL = alt;
}

async function main() {
  const live = await runRailwayLivePreflight({
    env: process.env,
    requireDatabasePublicUrl: false,
  });
  try {
    writeRailwayLivePreflightAudit(REPO, live);
  } catch { /* audit must never change the live verdict */ }
  console.log(live.verdict);
  console.log(JSON.stringify(live, null, 2));
  if (!live.ok) process.exit(1);
}

main().catch((err) => {
  console.log("NO-GO");
  console.error("PREFLIGHT FAILED:", redactPreflightText(err.message));
  process.exit(1);
});
