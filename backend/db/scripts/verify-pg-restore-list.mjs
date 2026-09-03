#!/usr/bin/env node
// Deterministic production pg_restore --list --verbose verification. No PowerShell pipe.
// Usage: node db/scripts/verify-pg-restore-list.mjs <custom-format.dump>
import { resolvePgClientBins, runPgRestoreList, verifyPgRestoreListResult } from "./lib/pgDumpClientGuard.mjs";

const dumpFile = process.argv[2];
if (!dumpFile) {
  console.error("usage: node db/scripts/verify-pg-restore-list.mjs <custom-format.dump>");
  process.exit(2);
}

const bins = resolvePgClientBins(process.env);
const raw = runPgRestoreList(bins.pgRestore.path, dumpFile);
const check = verifyPgRestoreListResult(raw);
console.log(JSON.stringify({
  ok: check.ok === true && check.authorizing === true,
  authorizing: check.authorizing === true,
  verified: check.verified === true,
  reason: check.reason,
  status: raw.status,
  tocEntries: check.tocEntries ?? null,
  uniqueDumpIds: check.uniqueDumpIds ?? null,
  malformed: check.malformed ?? null,
  unsupported: check.unsupported ?? null,
  duplicates: check.duplicates ?? null,
  specials: check.specials ?? null,
  diagnostics: (raw.stderr || "").trim() ? "present" : "none",
  command: "pg_restore --list --verbose (no pipe)",
}, null, 2));
process.exit(check.ok === true && check.authorizing === true ? 0 : 1);
