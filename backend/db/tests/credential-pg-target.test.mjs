import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  ACCEPTANCE_ERROR,
  AcceptanceTargetError,
  connectOnlyAfterLoopbackAccepted,
  inspectPgTargetFromEnv,
  loopbackClientConfig,
  mergePgDriverConfigForTests,
  postgresJsStyleConfig,
  refuseRemotePgTarget,
  canonicalizePgHost,
} from "../scripts/lib/credentialAcceptanceTarget.mjs";
import { main as localPreflightMain } from "../scripts/local-credential-role-preflight.mjs";
import { main as productionPreflightMain } from "../scripts/production-credential-role-preflight.mjs";
import { main as migrateMain } from "../scripts/production-credentials-migrate.mjs";
import {
  CREDENTIAL_TARGET_FINGERPRINT_ENV,
  GATE_ERROR,
  publicErrorCode,
} from "../scripts/lib/productionCredentialGate.mjs";
import { exampleLiveTargetFingerprint } from "../scripts/lib/pgTargetFingerprint.mjs";
import { ROLE_PREFLIGHT_CODE } from "../scripts/lib/credentialRolePreflight.mjs";

const require = createRequire(import.meta.url);
const ConnectionParameters = require("pg/lib/connection-parameters.js");
const FINGERPRINT = exampleLiveTargetFingerprint();

function driverHost(connectionString) {
  return new ConnectionParameters({ connectionString }).host;
}

function spyConnect(env) {
  let calls = 0;
  let cfg = null;
  const threw = (() => {
    try {
      connectOnlyAfterLoopbackAccepted(env, (passed) => {
        calls += 1;
        cfg = passed;
        return "connected";
      });
      return null;
    } catch (err) {
      return err;
    }
  })();
  return { calls, cfg, threw };
}

test("effective pg target matches pg 8.23 ConnectionParameters host merge", () => {
  const cases = [
    "postgres://u@127.0.0.1/db",
    "postgres://u@localhost/db",
    "postgres://u@127.0.0.1/db?host=remote.example",
    "postgres://u@remote.example/db?host=127.0.0.1",
    "postgres://u@127.0.0.1/db?host=remote%2Eexample",
    "postgres://u@[::1]/db",
    "postgres://u@127.0.0.1:5433/db",
  ];
  for (const url of cases) {
    const env = { POSTGRES_URL: url };
    const cfg = postgresJsStyleConfig(env);
    const merged = mergePgDriverConfigForTests(cfg, env);
    assert.equal(
      canonicalizePgHost(merged.host).host,
      canonicalizePgHost(driverHost(url)).host,
      `driver host mismatch for classified URL class=${inspectPgTargetFromEnv(env).class}`,
    );
  }
});

test("query host overrides URL hostname before any connection helper", () => {
  const remoteBypass = spyConnect({ POSTGRES_URL: "postgres://u@127.0.0.1/db?host=remote.example" });
  assert.equal(remoteBypass.calls, 0);
  assert.equal(remoteBypass.threw instanceof AcceptanceTargetError, true);
  assert.equal(remoteBypass.threw.code, ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED);
  assert.equal(inspectPgTargetFromEnv({ POSTGRES_URL: "postgres://u@127.0.0.1/db?host=remote.example" }).remote, true);

  const encoded = spyConnect({ POSTGRES_URL: "postgres://u@localhost/db?host=remote%2Eexample" });
  assert.equal(encoded.calls, 0);
  assert.equal(encoded.threw.code, ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED);

  const loopbackOverride = spyConnect({ POSTGRES_URL: "postgres://u@remote.example/db?host=127.0.0.1" });
  assert.equal(loopbackOverride.calls, 1);
  assert.equal(loopbackOverride.cfg.connectionString, undefined);
  assert.equal(loopbackOverride.cfg.host, "127.0.0.1");
});

test("every remote-effective configuration results in zero connection helper calls", () => {
  const remotes = [
    { POSTGRES_URL: "postgres://u@db.example.invalid/db" },
    { POSTGRES_URL: "postgres://u@127.0.0.1/db?host=db.example.invalid" },
    { POSTGRES_URL: "postgres://u@localhost/db?host=remote.example" },
    { POSTGRES_URL: "postgres://u@127.0.0.1/db?host=remote%2Eexample" },
    { POSTGRES_HOST: "db.example.invalid", POSTGRES_DB: "db", POSTGRES_USER: "u" },
    { POSTGRES_URL: "postgres://u@/db", PGHOST: "db.example.invalid" },
  ];
  for (const env of remotes) {
    const { calls, threw } = spyConnect(env);
    assert.equal(calls, 0, "remote-effective target must not invoke connect helper");
    assert.equal(threw instanceof AcceptanceTargetError, true);
    assert.equal(threw.code, ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED);
    assert.equal(inspectPgTargetFromEnv(env).remote, true);
  }
});

test("loopback IPv4, IPv6, localhost, and unix socket are accepted with discrete client config", () => {
  const loopbacks = [
    { POSTGRES_URL: "postgres://u@127.0.0.1/db" },
    { POSTGRES_URL: "postgres://u@localhost/db" },
    { POSTGRES_URL: "postgres://u@[::1]/db" },
    { POSTGRES_HOST: "127.0.0.1", POSTGRES_DB: "db", POSTGRES_USER: "u" },
    { POSTGRES_HOST: "[::1]", POSTGRES_DB: "db", POSTGRES_USER: "u" },
    { POSTGRES_HOST: "/tmp", POSTGRES_DB: "db", POSTGRES_USER: "u" },
  ];
  for (const env of loopbacks) {
    const { calls, cfg, threw } = spyConnect(env);
    assert.equal(threw, null, "loopback effective target must be accepted");
    assert.equal(calls, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(cfg, "connectionString"), false);
    assert.equal(typeof cfg.host, "string");
    assert.equal(inspectPgTargetFromEnv(env).loopback, true);
    const discrete = loopbackClientConfig(env);
    assert.equal(discrete.connectionString, undefined);
    assert.equal(discrete.host, cfg.host);
    if (String(env.POSTGRES_URL || "").includes("[::1]") || env.POSTGRES_HOST === "[::1]") {
      assert.equal(discrete.host, "::1");
    }
  }
});

test("PGHOST is honored only when the driver host is empty after URL parse", () => {
  const urlWins = mergePgDriverConfigForTests(
    postgresJsStyleConfig({ POSTGRES_URL: "postgres://u@127.0.0.1/db" }),
    { PGHOST: "db.example.invalid" },
  );
  assert.equal(urlWins.host, "127.0.0.1");
  assert.equal(inspectPgTargetFromEnv({
    POSTGRES_URL: "postgres://u@127.0.0.1/db",
    PGHOST: "db.example.invalid",
  }).loopback, true);

  const pghost = inspectPgTargetFromEnv({
    POSTGRES_URL: "postgres://u@/db",
    PGHOST: "db.example.invalid",
  });
  assert.equal(pghost.remote, true);
  assert.equal(spyConnect({ POSTGRES_URL: "postgres://u@/db", PGHOST: "db.example.invalid" }).calls, 0);
});

test("malformed connection string is refused before connect", () => {
  const malformed = spyConnect({ POSTGRES_URL: "postgres://[" });
  assert.equal(malformed.calls, 0);
  assert.equal(malformed.threw instanceof AcceptanceTargetError, true);
  assert.equal(
    malformed.threw.code === ACCEPTANCE_ERROR.MALFORMED_TARGET_REFUSED
      || malformed.threw.code === ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED,
    true,
  );
});

test("local role preflight cleanup failures fail closed", async (t) => {
  const logs = [];
  const restore = console.log;
  console.log = (...args) => { logs.push(args); };
  t.after(() => { console.log = restore; });
  const loopbackEnv = { POSTGRES_URL: "postgres://nesta@127.0.0.1/postgres" };
  const okResult = { ok: true, code: ROLE_PREFLIGHT_CODE.OK, checks: {} };

  function fakeClient({ endAdmin = false, endDisposable = false, dropFail = false } = {}) {
    return class FakeClient {
      constructor(cfg) {
        this.cfg = cfg;
      }
      async connect() {}
      async query(sql) {
        if (dropFail && String(sql).startsWith("DROP DATABASE")) {
          throw new Error("drop failed");
        }
        return { rows: [] };
      }
      async end() {
        const db = String(this.cfg?.database || "");
        if (endDisposable && db.startsWith("nesta_cred_role_pf_")) throw new Error("client end failed");
        if (endAdmin && db === "postgres") throw new Error("admin end failed");
      }
    };
  }

  await assert.rejects(
    () => localPreflightMain(loopbackEnv, {
      Client: fakeClient({ dropFail: true }),
      runDisposableChecks: async () => okResult,
    }),
    (err) => err instanceof AcceptanceTargetError && err.code === ACCEPTANCE_ERROR.ACCEPTANCE_CLEANUP_FAILED,
  );
  await assert.rejects(
    () => localPreflightMain(loopbackEnv, {
      Client: fakeClient({ endAdmin: true }),
      runDisposableChecks: async () => okResult,
    }),
    (err) => err instanceof AcceptanceTargetError && err.code === ACCEPTANCE_ERROR.ACCEPTANCE_CLEANUP_FAILED,
  );
  await assert.rejects(
    () => localPreflightMain(loopbackEnv, {
      Client: fakeClient({ endDisposable: true }),
      runDisposableChecks: async () => okResult,
    }),
    (err) => err instanceof AcceptanceTargetError && err.code === ACCEPTANCE_ERROR.ACCEPTANCE_CLEANUP_FAILED,
  );

  const passed = await localPreflightMain(loopbackEnv, {
    Client: fakeClient(),
    runDisposableChecks: async () => okResult,
  });
  assert.equal(passed.ok, true);

  await assert.rejects(
    () => localPreflightMain({ POSTGRES_URL: "postgres://u@127.0.0.1/db?host=remote.example" }, {
      Client: fakeClient(),
      runDisposableChecks: async () => okResult,
    }),
    (err) => err instanceof AcceptanceTargetError && err.code === ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED,
  );
});

test("production CLIs reject unsafe effective hosts before isPgAvailable or getPool", async () => {
  const env = {
    NESTA_MIGRATE_TARGET: "production",
    POSTGRES_SSL: "true",
    [CREDENTIAL_TARGET_FINGERPRINT_ENV]: FINGERPRINT,
    FIREBASE_PROJECT_ID: "restoran-30d51",
    FIREBASE_DATABASE_URL: "https://restoran-30d51-default-rtdb.firebaseio.com",
    POSTGRES_URL: "postgres://u@db.example.invalid/railway?host=127.0.0.1",
  };
  let poolCalls = 0;
  const deps = {
    getPool() {
      poolCalls += 1;
      throw new Error("pool must not be constructed");
    },
    isPgAvailable() {
      poolCalls += 1;
      return true;
    },
    closePool: async () => {},
  };
  await assert.rejects(
    () => migrateMain([], env, deps),
    (err) => publicErrorCode(err) === GATE_ERROR.TARGET_NOT_PRODUCTION,
  );
  await assert.rejects(
    () => productionPreflightMain(env, deps),
    (err) => publicErrorCode(err) === GATE_ERROR.TARGET_NOT_PRODUCTION,
  );
  assert.equal(poolCalls, 0);
  refuseRemotePgTarget({ POSTGRES_URL: "postgres://u@127.0.0.1/db" });
});

test("strict loopback canonicalization reconstructs discrete pg config", () => {
  const accepted = [
    { env: { POSTGRES_URL: "postgres://u@127.0.0.1/db" }, host: "127.0.0.1" },
    { env: { POSTGRES_HOST: "127.1.2.3", POSTGRES_DB: "db", POSTGRES_USER: "u" }, host: "127.1.2.3" },
    { env: { POSTGRES_URL: "postgres://u@localhost/db" }, host: "localhost" },
    { env: { POSTGRES_URL: "postgres://u@[::1]/db" }, host: "::1" },
    { env: { POSTGRES_HOST: "[::1]", POSTGRES_DB: "db", POSTGRES_USER: "u" }, host: "::1" },
    { env: { POSTGRES_HOST: "::1", POSTGRES_DB: "db", POSTGRES_USER: "u" }, host: "::1" },
  ];
  for (const item of accepted) {
    const cfg = loopbackClientConfig(item.env);
    assert.equal(cfg.host, item.host);
    assert.equal(Object.prototype.hasOwnProperty.call(cfg, "connectionString"), false);
    assert.equal(inspectPgTargetFromEnv(item.env).loopback, true);
    assert.equal(canonicalizePgHost(cfg.host).host.includes("["), false);
  }

  const refused = [
    { POSTGRES_HOST: "127.999.1.1", POSTGRES_DB: "db", POSTGRES_USER: "u" },
    { POSTGRES_HOST: "127.0.0", POSTGRES_DB: "db", POSTGRES_USER: "u" },
    { POSTGRES_HOST: "127.0.0.1.extra", POSTGRES_DB: "db", POSTGRES_USER: "u" },
    { POSTGRES_HOST: "[::1", POSTGRES_DB: "db", POSTGRES_USER: "u" },
    { POSTGRES_HOST: "2001:db8::1", POSTGRES_DB: "db", POSTGRES_USER: "u" },
    { POSTGRES_HOST: "localhost.example", POSTGRES_DB: "db", POSTGRES_USER: "u" },
  ];
  for (const env of refused) {
    const { calls, threw } = spyConnect(env);
    assert.equal(calls, 0);
    assert.equal(threw instanceof AcceptanceTargetError, true);
    assert.ok(
      threw.code === ACCEPTANCE_ERROR.MALFORMED_TARGET_REFUSED
        || threw.code === ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED,
    );
  }
  assert.equal(inspectPgTargetFromEnv({ POSTGRES_HOST: "127.999.1.1", POSTGRES_DB: "db", POSTGRES_USER: "u" }).malformed, true);
  assert.equal(inspectPgTargetFromEnv({ POSTGRES_HOST: "2001:db8::1", POSTGRES_DB: "db", POSTGRES_USER: "u" }).remote, true);
  assert.equal(inspectPgTargetFromEnv({ POSTGRES_HOST: "localhost.example", POSTGRES_DB: "db", POSTGRES_USER: "u" }).remote, true);
});

test("local credential CLI classifies the target before constructing Client", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "../scripts/local-credential-role-preflight.mjs"), "utf8");
  const mainSrc = src.slice(src.indexOf("export async function main"));
  function requireIdx(fragment) {
    const idx = mainSrc.indexOf(fragment);
    assert.notEqual(idx, -1, fragment);
    return idx;
  }
  const inspectIdx = requireIdx("inspectPgTargetFromEnv");
  const refuseIdx = requireIdx("refuseRemotePgTarget");
  const constructIdx = requireIdx("new Client(");
  assert.ok(inspectIdx < constructIdx);
  assert.ok(refuseIdx < constructIdx);
  const earlyClient = mainSrc.replace(
    "const Client = deps.Client || pg.Client;",
    "const Client = deps.Client || pg.Client;\n  const premature = new Client({});",
  );
  assert.throws(() => {
    const inspect = earlyClient.indexOf("inspectPgTargetFromEnv");
    const refuse = earlyClient.indexOf("refuseRemotePgTarget");
    const construct = earlyClient.indexOf("new Client(");
    assert.notEqual(inspect, -1);
    assert.notEqual(refuse, -1);
    assert.notEqual(construct, -1);
    assert.ok(inspect < construct && refuse < construct);
  });
});
