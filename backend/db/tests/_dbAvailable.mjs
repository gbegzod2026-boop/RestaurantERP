// db/tests/_dbAvailable.mjs — preflight used by the database-backed tests.
//
// Without this, `npm run db:test` fails on a machine with no PostgreSQL, and
// a connection-refused error looks identical to a genuine RLS failure. But a
// skip must never be laundered into a pass either, so:
//
//   * under `node --test`, the file registers a real SKIPPED test, so the
//     runner's own counters say "skipped", not "pass";
//   * run directly, it prints an unmissable banner and exits 0;
//   * with REQUIRE_DB=1 (use this in CI), an unreachable database is a hard
//     failure — which is what you want the moment these tests actually gate
//     something.
import { getPool, closePool } from "../postgres.js";

export async function dbAvailable() {
  try {
    const pool = getPool();
    const c = await pool.connect();
    try {
      await c.query("SELECT 1");
      return true;
    } finally {
      c.release();
    }
  } catch (err) {
    await closePool().catch(() => {});
    return { error: err.message || String(err) };
  }
}

/** Call as `return await skipUnavailable(name, detail)` — it either ends the
 *  process or registers a skipped test and returns, and in both cases the
 *  caller must not continue. */
export async function skipUnavailable(testName, detail) {
  const reason = `PostgreSQL unreachable${detail ? `: ${detail}` : ""}`;

  if (process.env.REQUIRE_DB === "1") {
    console.error(`\n❌ ${testName}: REQUIRE_DB=1 but ${reason}`);
    process.exit(1);
  }

  if (process.env.NODE_TEST_CONTEXT) {
    const { test } = await import("node:test");
    test(`${testName} — tenant isolation NOT VERIFIED`, { skip: reason }, () => {});
    await closePool().catch(() => {});
    return;
  }

  console.log(`\n⏭  SKIPPED — ${testName}`);
  console.log(`   ${reason}.`);
  console.log(`   This is NOT a pass. Run against a real instance to verify tenant isolation:`);
  console.log(`     node db/migrate.js up && npm run db:test:rls`);
  console.log(`   Set REQUIRE_DB=1 to make an unreachable database a failure instead.`);
  await closePool().catch(() => {});
  process.exit(0);
}
