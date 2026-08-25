#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const suites = ["rls.test.mjs", "rls-wave1.test.mjs", "rls-wave2.test.mjs"];

for (const suite of suites) {
  const result = spawnSync(process.execPath, [`db/tests/${suite}`], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, REQUIRE_DB: "1" },
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Strict RLS runner could not start ${suite}.`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
