import test from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCTION_FIREBASE_PROJECT_IDS,
  isProductionFirebaseProject,
  assertIsolatedAuthEnvironment,
  assertAuthMintAllowed,
} from "../../firebaseEnv.js";

test("production Firebase project id is restoran-30d51", () => {
  assert.ok(PRODUCTION_FIREBASE_PROJECT_IDS.includes("restoran-30d51"));
  assert.equal(isProductionFirebaseProject("restoran-30d51"), true);
  assert.equal(isProductionFirebaseProject("nesta-staging"), false);
});

test("isolated auth refuses production project", () => {
  const prevIsolated = process.env.NESTA_REQUIRE_ISOLATED_AUTH;
  const prevProject = process.env.FIREBASE_PROJECT_ID;
  const prevEmu = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  process.env.NESTA_REQUIRE_ISOLATED_AUTH = "1";
  process.env.FIREBASE_PROJECT_ID = "restoran-30d51";
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
  try {
    assert.throws(() => assertIsolatedAuthEnvironment(), /production/);
  } finally {
    process.env.NESTA_REQUIRE_ISOLATED_AUTH = prevIsolated;
    process.env.FIREBASE_PROJECT_ID = prevProject;
    process.env.FIREBASE_AUTH_EMULATOR_HOST = prevEmu;
  }
});

test("isolated auth accepts nesta-staging emulator", () => {
  const prevIsolated = process.env.NESTA_REQUIRE_ISOLATED_AUTH;
  const prevProject = process.env.FIREBASE_PROJECT_ID;
  const prevEmu = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const prevRemote = process.env.NESTA_ALLOW_REMOTE_STAGING;
  process.env.NESTA_REQUIRE_ISOLATED_AUTH = "1";
  process.env.FIREBASE_PROJECT_ID = "nesta-staging";
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
  delete process.env.NESTA_ALLOW_REMOTE_STAGING;
  try {
    assert.doesNotThrow(() => assertIsolatedAuthEnvironment());
    assert.doesNotThrow(() => assertAuthMintAllowed());
  } finally {
    process.env.NESTA_REQUIRE_ISOLATED_AUTH = prevIsolated;
    process.env.FIREBASE_PROJECT_ID = prevProject;
    process.env.FIREBASE_AUTH_EMULATOR_HOST = prevEmu;
    if (prevRemote == null) delete process.env.NESTA_ALLOW_REMOTE_STAGING;
    else process.env.NESTA_ALLOW_REMOTE_STAGING = prevRemote;
  }
});
