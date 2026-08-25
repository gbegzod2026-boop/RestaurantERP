import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("strict RLS runner is cross-platform and forces REQUIRE_DB=1", async () => {
  const source = await readFile(new URL("./run-rls-strict.mjs", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["db:test:rls:strict"], "node db/tests/run-rls-strict.mjs");
  assert.match(source, /process\.execPath/);
  assert.match(source, /env:\s*\{\s*\.\.\.process\.env,\s*REQUIRE_DB:\s*"1"\s*\}/s);
  assert.deepEqual(
    [...source.matchAll(/"(rls(?:-wave[12])?\.test\.mjs)"/g)].map((match) => match[1]),
    ["rls.test.mjs", "rls-wave1.test.mjs", "rls-wave2.test.mjs"]
  );
  assert.doesNotMatch(source, /shell:\s*true/);
});
