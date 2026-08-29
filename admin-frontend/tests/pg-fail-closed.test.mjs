import test from "node:test";
import assert from "node:assert/strict";
import { postgresDataPlane, isTenantApplicationPath, isPlatformFirebasePath, isMapped } from "../public/js/pgDataPlane.js";
import { parseRestId, canonicalizeRestId } from "../public/js/pgRestId.js";

const REST = "rest_1000000000001";

function spyPlaneGet(path, mode, spies) {
  const plane = postgresDataPlane(path, mode);
  if (plane === "unmapped") {
    const err = new Error("unmapped_path");
    err.code = "unmapped_path";
    throw err;
  }
  if (plane === "postgres") {
    spies.pgGet += 1;
    return "pg";
  }
  spies.fbGet += 1;
  return "fb";
}

test("postgres data plane never selects Firebase for unmapped tenant paths", () => {
  assert.equal(postgresDataPlane(`restaurants/${REST}/orders`, "postgres"), "postgres");
  assert.equal(postgresDataPlane(`restaurants/${REST}/info`, "postgres"), "postgres");
  assert.equal(postgresDataPlane(`restaurants/${REST}/secret`, "postgres"), "unmapped");
  assert.equal(postgresDataPlane(`credentials/${REST}/admin_1`, "postgres"), "unmapped");
  assert.equal(postgresDataPlane("systemData/platformUsers", "postgres"), "firebase");
  assert.equal(postgresDataPlane(".info/connected", "postgres"), "firebase");
  assert.equal(isTenantApplicationPath(`restaurants/${REST}/secret`), true);
  assert.equal(isPlatformFirebasePath("systemData/x"), true);
  assert.equal(isMapped(`restaurants/${REST}/orders`), true);
});

test("native Firebase get spy is never called for unmapped tenant paths in postgres mode", () => {
  const spies = { fbGet: 0, pgGet: 0 };
  assert.equal(spyPlaneGet(`restaurants/${REST}/orders`, "postgres", spies), "pg");
  assert.equal(spies.fbGet, 0);
  assert.equal(spyPlaneGet(`restaurants/${REST}/info`, "postgres", spies), "pg");
  assert.equal(spies.fbGet, 0);
  assert.throws(() => spyPlaneGet(`restaurants/${REST}/secret`, "postgres", spies), { code: "unmapped_path" });
  assert.equal(spies.fbGet, 0);
  assert.throws(() => spyPlaneGet(`credentials/${REST}/u1`, "postgres", spies), { code: "unmapped_path" });
  assert.equal(spies.fbGet, 0);
  assert.equal(spyPlaneGet("systemData/x", "postgres", spies), "fb");
  assert.equal(spies.fbGet, 1);
  spyPlaneGet(`restaurants/${REST}/orders`, "firebase", spies);
  assert.equal(spies.fbGet, 2);
});

test("client restId grammar matches backend canonical + legacy staff uid only", () => {
  assert.equal(canonicalizeRestId(`${REST}__admin_1`), REST);
  assert.equal(parseRestId("rest_s1a_1__admin_1").ok, false);
  assert.equal(parseRestId(`${REST}  `).ok, false);
  assert.equal(parseRestId(`${REST}__${REST}__x`).ok, false);
});
