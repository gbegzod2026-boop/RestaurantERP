import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import {
  enableCredentialCliSafeMode,
  reportIdleClientError,
  handleCredentialCliPoolError,
  PG_IDLE_CLIENT_ERROR,
  PG_CHECKED_OUT_CLIENT_ERROR,
  PG_CLIENT_RELEASE_FAILED,
  PG_POOL_CLOSE_FAILED,
  PG_CLEANUP_TIMEOUT,
  PG_ROLLBACK_FAILED,
  CREDENTIAL_CLI_ROLLBACK_TIMEOUT_MS,
  CREDENTIAL_CLI_SAFE_CLIENT_KEYS,
  CREDENTIAL_CLI_CALLBACK_CONTEXT_KEYS,
  CREDENTIAL_CLI_FORBIDDEN_HANDLE_KEYS,
  attachCredentialCliClientGuard,
  withCredentialCliClient,
  runCredentialCliSession,
  closeCredentialCliPool,
  guardedQuery,
} from "../postgres.js";
import { probeDenied42501, runProductionCredentialRolePreflight } from "../scripts/lib/credentialRolePreflight.mjs";
import { main as migrateMain } from "../scripts/production-credentials-migrate.mjs";
import { main as preflightMain } from "../scripts/production-credential-role-preflight.mjs";
import {
  APPROVED_RTDB_URL,
  CREDENTIAL_TARGET_FINGERPRINT_ENV,
  GATE_ERROR,
  publicErrorCode,
  planCredentialCopy,
  safeReportId,
  opaqueReportId,
  isSecretLikeValue,
  containsSecretLikeMaterial,
  assertSecretFree,
  validateCredentialGateReport,
} from "../scripts/lib/productionCredentialGate.mjs";
import { exampleLiveTargetFingerprint } from "../scripts/lib/pgTargetFingerprint.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pgSrc = readFileSync(path.join(here, "../postgres.js"), "utf8");
const migrateSrc = readFileSync(path.join(here, "../scripts/production-credentials-migrate.mjs"), "utf8");
const preflightSrc = readFileSync(path.join(here, "../scripts/production-credential-role-preflight.mjs"), "utf8");
const SECRET_TEXT = "password=SECRET postgres://u:p@host/db token=SECRET";
const SECRET_MARKERS = ["password=SECRET", "postgres://u:p@host/db", "token=SECRET", "SECRET"];

function requireIdx(src, fragment) {
  const idx = src.indexOf(fragment);
  assert.notEqual(idx, -1, fragment);
  return idx;
}

function assertNoSecretMarkers(text) {
  const joined = String(text || "");
  for (const marker of SECRET_MARKERS) {
    assert.equal(joined.includes(marker), false, marker);
  }
}

function countLinesWith(lines, code) {
  return lines.filter((line) => String(line).includes(code)).length;
}

function printCliBoundary(err) {
  console.error("PRODUCTION CREDENTIAL GATE FAILED:", publicErrorCode(err));
}

function assertSafeClientShape(safeClient, rawClient, pool) {
  assert.deepEqual(Object.getOwnPropertyNames(safeClient), [...CREDENTIAL_CLI_SAFE_CLIENT_KEYS]);
  assert.deepEqual(Reflect.ownKeys(safeClient), [...CREDENTIAL_CLI_SAFE_CLIENT_KEYS]);
  assert.deepEqual(Object.getOwnPropertySymbols(safeClient), []);
  assert.equal(Object.getPrototypeOf(safeClient), null);
  assert.equal(Object.isFrozen(safeClient), true);
  for (const key of CREDENTIAL_CLI_FORBIDDEN_HANDLE_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(safeClient, key), false);
    assert.equal(safeClient[key], undefined);
  }
  const descriptors = Object.getOwnPropertyDescriptors(safeClient);
  for (const key of Reflect.ownKeys(safeClient)) {
    const desc = descriptors[key];
    const value = desc.get ? desc.get.call(safeClient) : desc.value;
    assert.notEqual(value, rawClient);
    assert.notEqual(value, rawClient.query);
    if (pool) assert.notEqual(value, pool);
  }
  assert.equal(safeClient.query.name, "credentialCliFacadeQuery");
}

function assertCallbackVisibleContext(args, rawClient, pool) {
  assert.equal(args.length, 1 + CREDENTIAL_CLI_CALLBACK_CONTEXT_KEYS.length);
  assertSafeClientShape(args[0], rawClient, pool);
  for (let i = 0; i < CREDENTIAL_CLI_CALLBACK_CONTEXT_KEYS.length; i += 1) {
    assertNoRawHandleOn(args[i + 1], rawClient);
  }
}

function assertNoRawHandleOn(obj, rawClient) {
  for (const key of Reflect.ownKeys(obj)) {
    assert.equal(typeof key === "symbol", false);
    assert.equal(CREDENTIAL_CLI_FORBIDDEN_HANDLE_KEYS.includes(key), false, String(key));
    assert.notEqual(obj[key], rawClient);
    assert.notEqual(obj[key], rawClient.query);
  }
  for (const key of CREDENTIAL_CLI_FORBIDDEN_HANDLE_KEYS) {
    assert.equal(obj[key], undefined);
  }
}

function productionCliEnv() {
  return {
    NESTA_MIGRATE_TARGET: "production",
    POSTGRES_SSL: "true",
    [CREDENTIAL_TARGET_FINGERPRINT_ENV]: exampleLiveTargetFingerprint(),
    FIREBASE_PROJECT_ID: "restoran-30d51",
    FIREBASE_DATABASE_URL: APPROVED_RTDB_URL,
    POSTGRES_URL: "postgres://u@switchback.proxy.rlwy.net:12345/railway",
  };
}

function productionMasked() {
  return { host: "switchback.proxy.rlwy.net", port: "12345", database: "railway", user: "u" };
}

function waitForErrorListener(client) {
  return (async () => {
    for (let i = 0; i < 40 && client.listenerCount("error") === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(client.listenerCount("error") > 0);
  })();
}

async function withWatchdog(promise, ms = 4000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("WATCHDOG")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeCheckedOutClient() {
  const client = new pg.Client({ host: "127.0.0.1", user: "u", database: "db", password: "x" });
  const statements = [];
  client.query = async (sql) => {
    statements.push(String(sql));
    return { rows: [] };
  };
  client.release = () => {
    client._released = true;
  };
  return { client, statements };
}

function hungRollbackAfterBegin(client, statements) {
  client.query = (sql) => {
    statements.push(String(sql));
    const text = String(sql).replace(/\s+/g, " ").trim();
    if (text === "BEGIN" || text === "BEGIN READ ONLY") return Promise.resolve({ rows: [] });
    if (/^ROLLBACK\s*;?$/i.test(text)) return new Promise(() => {});
    const err = new Error("WORKER_FAILED");
    err.code = "42P01";
    return Promise.reject(err);
  };
}

function rejectRollbackAfterBegin(client, statements, { workerCode = "42P01", failWorker = true } = {}) {
  client.query = (sql) => {
    statements.push(String(sql));
    const text = String(sql).replace(/\s+/g, " ").trim();
    if (text === "BEGIN" || text === "BEGIN READ ONLY") return Promise.resolve({ rows: [] });
    if (/^ROLLBACK\s*;?$/i.test(text)) {
      const err = new Error("rollback boom secret://x");
      return Promise.reject(err);
    }
    if (failWorker) {
      const err = new Error("WORKER_FAILED");
      err.code = workerCode;
      return Promise.reject(err);
    }
    if (/count\(\*\)/i.test(text)) return Promise.resolve({ rows: [{ n: 0 }] });
    return Promise.resolve({ rows: [] });
  };
}

function assertNoRawFullRollbackCall(src) {
  assert.doesNotMatch(src, /(?:await\s+)?(?:client|safeClient|owned)\.query\s*\(\s*[`'"]ROLLBACK[`'"]\s*\)/);
}

function sqlErr(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function successOutput(text) {
  return /"ok"\s*:\s*true|\bok\s*:\s*true\b|\bPASS\b/.test(String(text || ""));
}

async function publishAfterSession(pool, close, work, options) {
  const result = await runCredentialCliSession(pool, work, close, options);
  console.log(JSON.stringify({ ok: result.ok === true, verdict: "PASS" }));
  return result;
}

function makeReusablePool(client) {
  return {
    connect: async () => {
      client._released = false;
      return client;
    },
  };
}

function makePermissionProbeDriver() {
  const { client, statements } = makeCheckedOutClient();
  let aborted = false;
  client.query = async (sql) => {
    const text = String(sql).replace(/\s+/g, " ").trim();
    statements.push(text);
    if (text.startsWith("SAVEPOINT") || text.startsWith("RELEASE SAVEPOINT")) return { rows: [] };
    if (text.startsWith("ROLLBACK TO SAVEPOINT") || text === "ROLLBACK") {
      aborted = false;
      return { rows: [] };
    }
    if (aborted) throw sqlErr("25P02");
    if (text.includes("SELECT boom_25p02")) {
      aborted = true;
      throw sqlErr("25P02");
    }
    if (text.includes("SELECT missing_table")) throw sqlErr("42P01");
    if (text.includes("SELECT dup_key")) throw sqlErr("23505");
    if (text.includes("FROM production_migration_attempts") || text.includes("password_enc FROM employee_credentials")) {
      aborted = true;
      throw sqlErr("42501");
    }
    return { rows: [{ ok: true }] };
  };
  return { client, statements };
}

function sessionCallSource(src) {
  const mainSrc = src.slice(src.indexOf("export async function main"));
  const sessionIdx = requireIdx(mainSrc, "await runCredentialCliSession");
  let depth = 0;
  let started = false;
  let end = sessionIdx;
  for (let i = sessionIdx; i < mainSrc.length; i += 1) {
    const ch = mainSrc[i];
    if (ch === "(") {
      depth += 1;
      started = true;
    } else if (ch === ")") {
      depth -= 1;
      if (started && depth === 0) {
        end = i;
        break;
      }
    }
  }
  return {
    mainSrc,
    call: mainSrc.slice(sessionIdx, end + 1),
    after: mainSrc.slice(end + 1),
    end,
  };
}

test("credential CLI safe mode prints only PG_IDLE_CLIENT_ERROR for idle client errors", () => {
  enableCredentialCliSafeMode();
  const leaked = [
    "password=super-secret",
    "postgres://nesta:hunter2@db.example.invalid:5432/railway",
    "https://example.invalid/?token=abc",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaa.bbbb",
  ];
  const messages = [];
  const restore = console.error;
  console.error = (...args) => { messages.push(args.map(String).join(" ")); };
  try {
    reportIdleClientError({
      message: leaked.join(" | "),
    });
  } finally {
    console.error = restore;
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0], PG_IDLE_CLIENT_ERROR);
  for (const secret of leaked) {
    assert.equal(messages[0].includes(secret), false);
  }
  assert.match(pgSrc, /reportIdleClientError/);
  assert.match(pgSrc, /PG_IDLE_CLIENT_ERROR/);
  assert.doesNotMatch(pgSrc, /console\.error\("\[postgres\] idle client error:", err\.message\)/);
});

test("postgres.js dotenv is quiet and production CLIs enable safe mode before pool use", () => {
  assert.match(pgSrc, /dotenv\.config\(\{\s*quiet:\s*true\s*\}\)/);
  const migrateMainSrc = migrateSrc.slice(migrateSrc.indexOf("export async function main"));
  const preflightMainSrc = preflightSrc.slice(preflightSrc.indexOf("export async function main"));
  const migrateSafe = requireIdx(migrateMainSrc, "enableCredentialCliSafeMode()");
  const migrateAvailable = requireIdx(migrateMainSrc, "available()");
  const preflightSafe = requireIdx(preflightMainSrc, "enableCredentialCliSafeMode()");
  const preflightAvailable = requireIdx(preflightMainSrc, "available()");
  assert.ok(migrateSafe < migrateAvailable);
  assert.ok(preflightSafe < preflightAvailable);
  const dotenvBanner = "injected env (0) from .env";
  assert.doesNotMatch(migrateMainSrc, /console\.(log|error|warn)\(.*injected env/);
  assert.doesNotMatch(preflightMainSrc, /console\.(log|error|warn)\(.*injected env/);
  assert.equal(dotenvBanner.includes("injected env"), true);
  assert.doesNotMatch(migrateSrc, /err\.message/);
  assert.doesNotMatch(preflightSrc, /err\.message/);
  assert.match(migrateMainSrc, /runCredentialCliSession/);
  assert.match(preflightMainSrc, /runCredentialCliSession/);
});

test("installed pg 8.23 Client emits raw EventEmitter errors unless a listener is attached", () => {
  assert.match(require("pg/package.json").version, /^8\.23/);
  const bare = new pg.Client({ host: "127.0.0.1", user: "u", database: "db" });
  assert.throws(
    () => bare.emit("error", new Error(SECRET_TEXT)),
    (err) => SECRET_MARKERS.every((marker) => String(err && err.message || err).includes(marker)),
  );
});

test("checked-out credential client error is recorded without low-level printing", async () => {
  const { client } = makeCheckedOutClient();
  const errors = [];
  const restore = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    const guard = attachCredentialCliClientGuard(client);
    assert.equal(guard.hasListener(), true);
    assert.doesNotThrow(() => client.emit("error", new Error(SECRET_TEXT)));
    assert.equal(guard.failed, true);
    assert.equal(guard.error.code, PG_CHECKED_OUT_CLIENT_ERROR);
    await assert.rejects(() => guard.failure, (err) => err.code === PG_CHECKED_OUT_CLIENT_ERROR);
    assert.equal(countLinesWith(errors, PG_CHECKED_OUT_CLIENT_ERROR), 0);
    assertNoSecretMarkers(errors.join("\n"));
    client.emit("error", new Error(SECRET_TEXT));
    assert.equal(countLinesWith(errors, PG_CHECKED_OUT_CLIENT_ERROR), 0);
    await guard.releaseOwned();
    guard.detach();
    assert.equal(guard.hasListener(), false);
    assert.ok(client.listenerCount("error") > 0);
    client.emit("error", new Error(SECRET_TEXT));
    assert.equal(countLinesWith(errors, PG_IDLE_CLIENT_ERROR), 1);
    assertNoSecretMarkers(errors.join("\n"));
  } finally {
    console.error = restore;
  }
});

test("checked-out client error during an active transaction rolls back and cannot PASS", async () => {
  const { client, statements } = makeCheckedOutClient();
  const pool = { connect: async () => client };
  const errors = [];
  const restore = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    const pending = withCredentialCliClient(pool, async (owned) => {
      await owned.query("BEGIN");
      await new Promise(() => {});
      return { ok: true, verdict: "PASS" };
    }, { rollbackTimeoutMs: 40, callbackSettleTimeoutMs: 40, releaseTimeoutMs: 40 });
    for (let i = 0; i < 20 && client.listenerCount("error") === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    client.emit("error", new Error(SECRET_TEXT));
    await assert.rejects(pending, (err) => err.code === PG_CHECKED_OUT_CLIENT_ERROR);
    assert.equal(statements.includes("ROLLBACK"), true);
    assert.equal(client._released, true);
    assert.equal(countLinesWith(errors, PG_CHECKED_OUT_CLIENT_ERROR), 0);
    assertNoSecretMarkers(errors.concat(statements).join("\n"));
  } finally {
    console.error = restore;
  }
});

test("checked-out client error during a Firebase-read wait fails the command with no raw output", async () => {
  const { client } = makeCheckedOutClient();
  const pool = { connect: async () => client };
  const errors = [];
  const logs = [];
  const restoreError = console.error;
  const restoreLog = console.log;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  try {
    const pending = withCredentialCliClient(pool, async () => {
      await new Promise(() => {});
      return { ok: true, verdict: "PASS" };
    }, { rollbackTimeoutMs: 40, callbackSettleTimeoutMs: 40, releaseTimeoutMs: 40 });
    for (let i = 0; i < 20 && client.listenerCount("error") === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    client.emit("error", new Error(SECRET_TEXT));
    await assert.rejects(pending, (err) => {
      assert.equal(err.code, PG_CHECKED_OUT_CLIENT_ERROR);
      assert.notEqual(err.message, SECRET_TEXT);
      return true;
    });
    assert.equal(countLinesWith(errors, PG_CHECKED_OUT_CLIENT_ERROR), 0);
    assertNoSecretMarkers([...errors, ...logs].join("\n"));
  } finally {
    console.error = restoreError;
    console.log = restoreLog;
  }
});

test("checked-out listener is removed after release and late errors print idle once", async () => {
  const { client } = makeCheckedOutClient();
  const pool = { connect: async () => client };
  const errors = [];
  const restore = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    await withCredentialCliClient(pool, async () => ({ ok: true }));
    assert.equal(client._released, true);
    assert.equal(countLinesWith(errors, PG_CHECKED_OUT_CLIENT_ERROR), 0);
    assert.doesNotThrow(() => client.emit("error", new Error(SECRET_TEXT)));
    handleCredentialCliPoolError(new Error(SECRET_TEXT), client);
    client.emit("error", new Error(SECRET_TEXT));
    assert.equal(countLinesWith(errors, PG_IDLE_CLIENT_ERROR), 1);
    assertNoSecretMarkers(errors.join("\n"));
  } finally {
    console.error = restore;
  }
});

test("production CLIs fail closed on checked-out pg 8.23 client errors", async () => {
  const env = productionCliEnv();
  const errors = [];
  const logs = [];
  const restoreError = console.error;
  const restoreLog = console.log;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  async function failCli(run) {
    const { client } = makeCheckedOutClient();
    client.query = (sql) => {
      if (String(sql).includes("ROLLBACK")) return Promise.resolve({ rows: [] });
      return new Promise(() => {});
    };
    const pending = run({
      getPool() {
        return { connect: async () => client };
      },
      isPgAvailable() { return true; },
      closePool: async () => {},
    });
    for (let i = 0; i < 20 && client.listenerCount("error") === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(client.listenerCount("error") > 0);
    client.emit("error", new Error(SECRET_TEXT));
    await pending;
  }
  try {
    await assert.rejects(
      () => failCli((deps) => migrateMain([], env, deps)),
      (err) => publicErrorCode(err) === GATE_ERROR.PG_CHECKED_OUT_CLIENT_ERROR,
    );
    await assert.rejects(
      () => failCli((deps) => preflightMain(env, deps)),
      (err) => publicErrorCode(err) === GATE_ERROR.PG_CHECKED_OUT_CLIENT_ERROR,
    );
    const output = [...errors, ...logs].join("\n");
    assert.equal(output.includes("PASS"), false);
    assert.equal(countLinesWith(errors, PG_CHECKED_OUT_CLIENT_ERROR), 0);
    assertNoSecretMarkers(output);
  } finally {
    console.error = restoreError;
    console.log = restoreLog;
  }
});

test("checked-out client guard source keeps sanitized listener lifecycle", () => {
  const attachSrc = pgSrc.slice(
    pgSrc.indexOf("export function attachCredentialCliClientGuard"),
    pgSrc.indexOf("export async function withCredentialCliClient"),
  );
  const withSrc = pgSrc.slice(pgSrc.indexOf("export async function withCredentialCliClient"));
  const rollbackSrc = attachSrc.slice(attachSrc.indexOf("async function boundedRollback"));
  const returnSrc = attachSrc.slice(attachSrc.indexOf("return {"));
  assert.match(attachSrc, /client\.on\("error", handler\)/);
  assert.match(attachSrc, /removeListener\("error", handler\)/);
  assert.match(attachSrc, /PG_CHECKED_OUT_CLIENT_ERROR/);
  assert.match(attachSrc, /reportCheckedOutClientError\(\)/);
  assert.doesNotMatch(attachSrc, /err\.message|err\.stack|String\(err\)|util\.inspect/);
  assert.doesNotMatch(attachSrc, /console\.(log|error|warn)\([^\n]*err/);
  assert.match(rollbackSrc, /rawQuery\(sql\)/);
  assert.doesNotMatch(rollbackSrc, /originalQuery/);
  assert.match(rollbackSrc, /CREDENTIAL_CLI_ROLLBACK_TIMEOUT_MS|timeouts\.rollbackTimeoutMs/);
  assert.match(rollbackSrc, /withCredentialCliTimeout/);
  assert.doesNotMatch(rollbackSrc, /setImmediate/);
  assert.doesNotMatch(pgSrc, /installCredentialCliQueryGuard/);
  assert.doesNotMatch(pgSrc, /credentialCliGuardedQuery/);
  assert.doesNotMatch(pgSrc, /credentialCliSealedQuery/);
  assert.doesNotMatch(attachSrc, /client\.query\s*=(?!=)/);
  assert.doesNotMatch(withSrc, /client\.query\s*=(?!=)/);
  assert.doesNotMatch(returnSrc, /originalQuery/);
  assert.match(pgSrc, /credentialCliFacadeQuery/);
  assert.match(pgSrc, /closeCredentialCliPool/);
  assert.match(pgSrc, /PG_CLIENT_RELEASE_FAILED/);
  assert.match(pgSrc, /PG_POOL_CLOSE_FAILED/);
  assert.match(pgSrc, /PG_CLEANUP_TIMEOUT/);
  assert.match(withSrc, /Promise\.race/);
  assert.match(withSrc, /guard\.failure/);
  assert.match(withSrc, /rollbackIfNeeded/);
  assert.match(withSrc, /settleCallback/);
  assert.match(withSrc, /releaseOwned/);
  assert.match(withSrc, /throwIfFailed/);
  assert.match(withSrc, /guard\.detach\(\)/);
  assert.match(withSrc, /fn\(guard\.safeClient\)/);
  assert.doesNotMatch(withSrc, /fn\(guard\.safeClient,\s*guard\)/);
  assert.match(pgSrc, /CREDENTIAL_CLI_CALLBACK_CONTEXT_KEYS/);
  assert.deepEqual([...CREDENTIAL_CLI_CALLBACK_CONTEXT_KEYS], []);
  assert.match(pgSrc, /credentialCliReleasedClientSafeError/);
  assert.match(pgSrc, /reportIdleClientError\(\)/);
  assert.match(pgSrc, /handleCredentialCliPoolError/);
  assert.match(pgSrc, /export async function boundedCredentialRollback/);
  const attachFallbackIdx = requireIdx(attachSrc, "ensureReleasedIdleListener(client)");
  const attachCheckedIdx = requireIdx(attachSrc, 'client.on("error", handler)');
  assert.ok(attachFallbackIdx < attachCheckedIdx);
  const detachSrc = attachSrc.slice(attachSrc.indexOf("detach()"));
  const detachFallbackIdx = requireIdx(detachSrc, "ensureReleasedIdleListener(client)");
  const detachRemoveIdx = requireIdx(detachSrc, 'removeListener("error", handler)');
  assert.ok(detachFallbackIdx < detachRemoveIdx);
  const withFallbackIdx = requireIdx(withSrc, "ensureReleasedIdleListener(client)");
  const withDetachIdx = requireIdx(withSrc, "guard.detach()");
  assert.ok(withFallbackIdx < withDetachIdx);
  const handlerSrc = attachSrc.slice(attachSrc.indexOf("const handler"), attachSrc.indexOf("client.on"));
  assert.doesNotMatch(handlerSrc, /err\.message/);
  assert.match(pgSrc, /console\.error\("\[postgres\] idle client error:", err && err\.message\)/);
  const tenantSrc = pgSrc.slice(pgSrc.indexOf("export async function withTenantContext"));
  assert.doesNotMatch(tenantSrc, /attachCredentialCliClientGuard/);
  const migrateSession = sessionCallSource(migrateSrc);
  const preflightSession = sessionCallSource(preflightSrc);
  assert.doesNotMatch(migrateSession.call, /console\.log/);
  assert.doesNotMatch(preflightSession.call, /console\.log/);
  assert.match(migrateSession.after, /console\.log\(JSON\.stringify/);
  assert.match(preflightSession.after, /console\.log\(JSON\.stringify/);
  assert.match(migrateSrc, /runCredentialCliSession\(pool,/);
  assert.match(preflightSrc, /runCredentialCliSession\(pool,/);
  assert.match(pgSrc, /await closeCredentialCliPool\(close\)/);
  assert.match(migrateSrc, /throwIfCredentialCliFailed\(\)/);
  assert.match(preflightSrc, /throwIfCredentialCliFailed\(\)/);
  assert.doesNotMatch(migrateSrc, /guard\.throwIfFailed\(\)/);
  assert.doesNotMatch(preflightSrc, /guard\.throwIfFailed\(\)/);
  assert.doesNotMatch(migrateSrc.slice(migrateSrc.indexOf("export async function main")), /await pool\.connect\(\)/);
  assert.doesNotMatch(preflightSrc.slice(preflightSrc.indexOf("export async function main")), /await pool\.connect\(\)/);
  assert.doesNotMatch(migrateSrc, /err\.message/);
  assert.doesNotMatch(preflightSrc, /err\.message/);
});

test("callback cannot run SQL after checked-out client error or release", async () => {
  const { client, statements } = makeCheckedOutClient();
  const pool = { connect: async () => client };
  const errors = [];
  const restore = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  let resolveDeferred;
  let queryAttempted = false;
  let releasedBeforeQueryAttempt = false;
  try {
    const pending = withCredentialCliClient(pool, async (owned) => {
      await new Promise((resolve) => { resolveDeferred = resolve; });
      queryAttempted = true;
      releasedBeforeQueryAttempt = client._released === true;
      assert.equal(owned.originalQuery, undefined);
      await owned.query("SELECT after_error");
      return { ok: true, verdict: "PASS" };
    }, { rollbackTimeoutMs: 40, callbackSettleTimeoutMs: 200, releaseTimeoutMs: 40 });
    await waitForErrorListener(client);
    client.emit("error", new Error(SECRET_TEXT));
    resolveDeferred();
    await assert.rejects(withWatchdog(pending), (err) => err.code === PG_CHECKED_OUT_CLIENT_ERROR);
    assert.equal(queryAttempted, true);
    assert.equal(releasedBeforeQueryAttempt, false);
    assert.equal(statements.some((sql) => String(sql).includes("SELECT after_error")), false);
    assert.equal(client._released, true);
    assert.equal(errors.join("\n").includes("PASS"), false);
    assertNoSecretMarkers(errors.join("\n"));
  } finally {
    console.error = restore;
  }
});

test("error between await boundaries prevents the next query", async () => {
  const { client, statements } = makeCheckedOutClient();
  const pool = { connect: async () => client };
  let resolveFirst;
  const pending = withCredentialCliClient(pool, async (owned) => {
    await owned.query("SELECT first");
    await new Promise((resolve) => { resolveFirst = resolve; });
    await owned.query("SELECT second");
    return { verdict: "PASS" };
  }, { rollbackTimeoutMs: 40, callbackSettleTimeoutMs: 200, releaseTimeoutMs: 40 });
  await waitForErrorListener(client);
  for (let i = 0; i < 20 && !resolveFirst; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  client.emit("error", new Error(SECRET_TEXT));
  resolveFirst();
  await assert.rejects(withWatchdog(pending), (err) => err.code === PG_CHECKED_OUT_CLIENT_ERROR);
  assert.equal(statements.some((sql) => String(sql).includes("SELECT first")), true);
  assert.equal(statements.some((sql) => String(sql).includes("SELECT second")), false);
  assert.equal(client._released, true);
});

test("release throw after successful work fails closed without PASS", async () => {
  const { client } = makeCheckedOutClient();
  client.release = () => {
    client._released = true;
    throw new Error(SECRET_TEXT);
  };
  const pool = { connect: async () => client };
  const errors = [];
  const restore = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    await assert.rejects(
      () => withCredentialCliClient(pool, async () => ({ ok: true, verdict: "PASS" })),
      (err) => err.code === PG_CLIENT_RELEASE_FAILED,
    );
    assert.equal(errors.join("\n").includes("PASS"), false);
    assert.equal(countLinesWith(errors, PG_CLIENT_RELEASE_FAILED), 0);
    printCliBoundary({ code: PG_CLIENT_RELEASE_FAILED });
    assert.equal(countLinesWith(errors, PG_CLIENT_RELEASE_FAILED), 1);
    assertNoSecretMarkers(errors.join("\n"));
  } finally {
    console.error = restore;
  }
});

test("release throw after primary failure preserves PG_CHECKED_OUT_CLIENT_ERROR", async () => {
  const { client } = makeCheckedOutClient();
  client.release = () => {
    client._released = true;
    throw new Error(SECRET_TEXT);
  };
  const pool = { connect: async () => client };
  const errors = [];
  const restore = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    const pending = withCredentialCliClient(pool, async () => {
      await new Promise(() => {});
      return { verdict: "PASS" };
    }, { rollbackTimeoutMs: 40, callbackSettleTimeoutMs: 40, releaseTimeoutMs: 40 });
    await waitForErrorListener(client);
    client.emit("error", new Error(SECRET_TEXT));
    let caught;
    await assert.rejects(withWatchdog(pending), (err) => {
      caught = err;
      assert.equal(err.code, PG_CHECKED_OUT_CLIENT_ERROR);
      assert.equal(err.cleanupCode, PG_CLIENT_RELEASE_FAILED);
      return true;
    });
    assert.equal(countLinesWith(errors, PG_CHECKED_OUT_CLIENT_ERROR), 0);
    assert.equal(countLinesWith(errors, PG_CLIENT_RELEASE_FAILED), 0);
    printCliBoundary(caught);
    assert.equal(countLinesWith(errors, PG_CHECKED_OUT_CLIENT_ERROR), 1);
    assert.equal(countLinesWith(errors, PG_CLIENT_RELEASE_FAILED), 0);
    assertNoSecretMarkers(errors.join("\n"));
    assert.equal(errors.join("\n").includes("PASS"), false);
  } finally {
    console.error = restore;
  }
});

test("pool.end that never resolves fails with PG_POOL_CLOSE_FAILED", async () => {
  const errors = [];
  const restore = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    await assert.rejects(
      () => withWatchdog(closeCredentialCliPool(() => new Promise(() => {})), 8000),
      (err) => err.code === PG_POOL_CLOSE_FAILED,
    );
    assert.equal(countLinesWith(errors, PG_POOL_CLOSE_FAILED), 0);
    printCliBoundary({ code: PG_POOL_CLOSE_FAILED });
    assert.equal(countLinesWith(errors, PG_POOL_CLOSE_FAILED), 1);
    assertNoSecretMarkers(errors.join("\n"));
  } finally {
    console.error = restore;
  }
});

test("never-resolving ROLLBACK still terminates with primary checked-out failure", async () => {
  const { client, statements } = makeCheckedOutClient();
  client.query = (sql) => {
    statements.push(String(sql));
    if (String(sql).includes("ROLLBACK")) return new Promise(() => {});
    return Promise.resolve({ rows: [] });
  };
  const pool = { connect: async () => client };
  const errors = [];
  const restore = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    const pending = withCredentialCliClient(pool, async (owned) => {
      await owned.query("BEGIN");
      await new Promise(() => {});
      return { verdict: "PASS" };
    }, { rollbackTimeoutMs: 50, callbackSettleTimeoutMs: 50, releaseTimeoutMs: 50 });
    await waitForErrorListener(client);
    client.emit("error", new Error(SECRET_TEXT));
    await assert.rejects(withWatchdog(pending, 3000), (err) => {
      assert.equal(err.code, PG_CHECKED_OUT_CLIENT_ERROR);
      assert.notEqual(err.code, "WATCHDOG");
      return true;
    });
    assert.equal(statements.includes("ROLLBACK") || statements.some((sql) => String(sql).includes("ROLLBACK")), true);
    assert.equal(client._released, true);
    assert.equal(errors.join("\n").includes("PASS"), false);
    assertNoSecretMarkers(errors.join("\n"));
  } finally {
    console.error = restore;
  }
});

test("rollback deadline is locked by timeout helper and constant", () => {
  const attachSrc = pgSrc.slice(pgSrc.indexOf("export function attachCredentialCliClientGuard"));
  const boundedSrc = attachSrc.slice(
    attachSrc.indexOf("async function boundedRollback"),
    attachSrc.indexOf("function credentialCliFacadeQuery"),
  );
  const settleSrc = pgSrc.slice(
    pgSrc.indexOf("async function settleCredentialRollback"),
    pgSrc.indexOf("export async function boundedCredentialRollback"),
  );
  assert.match(attachSrc, /CREDENTIAL_CLI_ROLLBACK_TIMEOUT_MS/);
  assert.match(boundedSrc, /timeouts\.rollbackTimeoutMs/);
  assert.match(boundedSrc, /settleCredentialRollback/);
  assert.match(settleSrc, /withCredentialCliTimeout/);
  assert.match(settleSrc, /Promise\.resolve\(\)\.then\(\s*\(\)\s*=>\s*runQuery\(\)/);
  assert.equal(CREDENTIAL_CLI_ROLLBACK_TIMEOUT_MS > 0, true);
  const withoutDeadline = settleSrc.replace(/withCredentialCliTimeout\(/g, "Promise.resolve(");
  assert.doesNotMatch(withoutDeadline, /withCredentialCliTimeout/);
  assert.match(pgSrc, /rollbackTimeoutMs: Number\(options\.rollbackTimeoutMs \|\| CREDENTIAL_CLI_ROLLBACK_TIMEOUT_MS\)/);
});

test("checkout installs guardedQuery and production helpers do not rebind client.query", () => {
  assert.equal(typeof guardedQuery, "function");
  const gateSrc = readFileSync(path.join(here, "../scripts/lib/productionCredentialGate.mjs"), "utf8");
  const roleSrc = readFileSync(path.join(here, "../scripts/lib/credentialRolePreflight.mjs"), "utf8");
  const migrateMainSrc = migrateSrc.slice(migrateSrc.indexOf("export async function main"));
  const preflightMainSrc = preflightSrc.slice(preflightSrc.indexOf("export async function main"));
  assert.doesNotMatch(migrateMainSrc, /client\.query\s*=/);
  assert.doesNotMatch(preflightMainSrc, /client\.query\s*=/);
  assert.match(migrateMainSrc, /runCredentialGate\(/);
  assert.doesNotMatch(migrateMainSrc, /guard,/);
  assert.doesNotMatch(preflightMainSrc, /guard,/);
  assert.match(gateSrc, /throwIfCredentialCliFailed\(\)/);
  assert.match(roleSrc, /throwIfCredentialCliFailed\(\)/);
  assert.match(gateSrc, /boundedCredentialRollback/);
  assert.match(roleSrc, /boundedCredentialRollback/);
  assertNoRawFullRollbackCall(gateSrc);
  assertNoRawFullRollbackCall(roleSrc);
  assert.match(roleSrc, /ROLLBACK TO SAVEPOINT/);
  assert.doesNotMatch(pgSrc, /installCredentialCliQueryGuard\(client, guard\)/);
  assert.match(pgSrc, /credentialCliFacadeQuery/);

  const mutatedGate = gateSrc.replace(/await boundedCredentialRollback\(client\)/g, 'await client.query("ROLLBACK")');
  assert.match(mutatedGate, /client\.query\("ROLLBACK"\)/);
  assert.throws(() => assertNoRawFullRollbackCall(mutatedGate));
  const mutatedRole = roleSrc.replace(/await boundedCredentialRollback\(client\)/g, 'await client.query("ROLLBACK")');
  assert.throws(() => assertNoRawFullRollbackCall(mutatedRole));
});

test("bounded rollback rejection cannot be swallowed to timedOut-false success", () => {
  const settleSrc = pgSrc.slice(
    pgSrc.indexOf("async function settleCredentialRollback"),
    pgSrc.indexOf("export async function boundedCredentialRollback"),
  );
  assert.match(settleSrc, /Promise\.resolve\(\)\.then\(\s*\(\)\s*=>\s*runQuery\(\)/);
  assert.match(settleSrc, /ok:\s*false,\s*code:\s*PG_ROLLBACK_FAILED/);
  assert.match(settleSrc, /\{\s*ok:\s*true\s*\}/);
  assert.doesNotMatch(settleSrc, /\.then\(\s*\(\)\s*=>\s*\{\s*\}\s*,\s*\(\)\s*=>\s*\{\s*\}\s*\)/);
  assert.doesNotMatch(settleSrc, /timedOut:\s*false/);
  assert.match(settleSrc, /outcome\.ok\s*!==\s*true|!outcome/);
  const swallowed = settleSrc
    .replace(/\(\)\s*=>\s*\(\{\s*ok:\s*true\s*\}\)/g, "() => {}")
    .replace(/\(\)\s*=>\s*\(\{\s*ok:\s*false,\s*code:\s*PG_ROLLBACK_FAILED\s*\}\)/g, "() => {}")
    .replace(/if\s*\(!outcome \|\| outcome\.ok !== true\)[\s\S]*?return \{\s*ok:\s*false,\s*code:\s*PG_ROLLBACK_FAILED\s*\};\s*/g, "")
    .replace(/return \{\s*ok:\s*true\s*\};/g, "return { timedOut: false };");
  assert.match(swallowed, /\(\)\s*=>\s*\{\s*\}/);
  assert.match(swallowed, /timedOut:\s*false/);
  assert.throws(() => {
    assert.doesNotMatch(swallowed, /\(\)\s*=>\s*\{\s*\}/);
    assert.doesNotMatch(swallowed, /timedOut:\s*false/);
    assert.match(swallowed, /ok:\s*false,\s*code:\s*PG_ROLLBACK_FAILED/);
  });
  const syncEager = settleSrc.replace(
    /Promise\.resolve\(\)\.then\(\s*\(\)\s*=>\s*runQuery\(\)/,
    "Promise.resolve(runQuery()",
  );
  assert.throws(() => {
    assert.match(syncEager, /Promise\.resolve\(\)\.then\(\s*\(\)\s*=>\s*runQuery\(\)/);
  });
});

test("callback-visible surface is only frozen safeClient.query", async () => {
  const { client, statements } = makeCheckedOutClient();
  const pool = { connect: async () => client };
  await withCredentialCliClient(pool, async function worker(owned) {
    assertCallbackVisibleContext(arguments, client, pool);
    assert.equal(Object.prototype.hasOwnProperty.call(owned, "originalQuery"), false);
    assert.equal(owned.originalQuery, undefined);
    assert.equal(owned.client, undefined);
    assert.equal(typeof owned.query, "function");
    await owned.query("SELECT allowed");
  });
  assert.equal(statements.some((sql) => String(sql).includes("SELECT allowed")), true);
  const attachSrc = pgSrc.slice(
    pgSrc.indexOf("export function attachCredentialCliClientGuard"),
    pgSrc.indexOf("export async function withCredentialCliClient"),
  );
  assert.doesNotMatch(attachSrc.slice(attachSrc.indexOf("return {")), /originalQuery/);
  const other = makeCheckedOutClient().client;
  const guard = attachCredentialCliClientGuard(other);
  assertNoRawHandleOn(guard, other);
});

test("mutating safeClient with rawQuery or client would fail exact-key isolation", () => {
  const rawClient = { query() { return { rows: [] }; } };
  const leaked = Object.assign(Object.create(null), {
    query() {},
    rawQuery: rawClient.query,
  });
  assert.throws(() => assertSafeClientShape(leaked, rawClient, null));
  const withClient = Object.assign(Object.create(null), {
    query() {},
    client: rawClient,
  });
  assert.throws(() => assertSafeClientShape(withClient, rawClient, null));
  const withSymbol = Object.assign(Object.create(null), { query() {} });
  Object.defineProperty(withSymbol, Symbol("raw"), { value: rawClient, enumerable: false });
  assert.throws(() => assertSafeClientShape(withSymbol, rawClient, null));
  const proto = { client: rawClient };
  const inherited = Object.assign(Object.create(proto), { query() {} });
  assert.throws(() => assertSafeClientShape(inherited, rawClient, null));
  const getterObj = Object.create(null);
  Object.defineProperty(getterObj, "query", { get() { return rawClient.query; }, enumerable: true });
  Object.freeze(getterObj);
  assert.throws(() => assertSafeClientShape(getterObj, rawClient, null));
  const guardLeak = { client: rawClient, query() {} };
  assert.throws(() => assertNoRawHandleOn(guardLeak, rawClient));
  assert.deepEqual([...CREDENTIAL_CLI_CALLBACK_CONTEXT_KEYS], []);
  assert.deepEqual([...CREDENTIAL_CLI_SAFE_CLIENT_KEYS], ["query"]);

  const facadeCtor = pgSrc.slice(
    pgSrc.indexOf("const safeClient = Object.freeze"),
    pgSrc.indexOf("function beginCleanup"),
  );
  assert.match(facadeCtor, /query:\s*credentialCliFacadeQuery/);
  assert.doesNotMatch(facadeCtor, /rawQuery|originalQuery|\bclient\b|\bpool\b|\bstream\b/);
  assert.ok(facadeCtor.includes("query: credentialCliFacadeQuery"));
  const mutatedRawQuery = `${facadeCtor}\n    rawQuery: rawQuery,`;
  assert.match(mutatedRawQuery, /rawQuery:\s*rawQuery/);
  assert.throws(() => {
    assert.doesNotMatch(mutatedRawQuery, /rawQuery/);
  });
  const mutatedClient = `${facadeCtor}\n    client: client,`;
  assert.throws(() => {
    assert.doesNotMatch(mutatedClient, /\bclient:\s*client\b/);
  });

  const guardReturnStart = pgSrc.indexOf("get phase()");
  const guardReturn = pgSrc.slice(guardReturnStart, pgSrc.indexOf("export function guardedQuery"));
  assert.ok(guardReturn.includes("safeClient"));
  assert.doesNotMatch(guardReturn, /^\s*client\s*,/m);
  assert.doesNotMatch(guardReturn, /^\s*rawClient\s*,/m);
  assert.doesNotMatch(guardReturn, /^\s*rawQuery\s*,/m);
  assert.doesNotMatch(guardReturn, /^\s*originalQuery\s*,/m);
  assert.doesNotMatch(guardReturn, /^\s*pool\s*,/m);
  const mutatedGuardClient = `${guardReturn}\n    client,`;
  assert.throws(() => {
    assert.doesNotMatch(mutatedGuardClient, /^\s*client\s*,/m);
  });
});

test("guarded facade preserves ordinary SQLSTATE instead of PG_CHECKED_OUT_CLIENT_ERROR", async () => {
  for (const code of ["42501", "23505", "42P01", "25P02"]) {
    const { client } = makeCheckedOutClient();
    client.query = async () => {
      throw sqlErr(code);
    };
    const pool = { connect: async () => client };
    await assert.rejects(
      () => withCredentialCliClient(pool, async (owned) => guardedQuery(owned, null, "SELECT probe")),
      (err) => err.code === code && err.code !== PG_CHECKED_OUT_CLIENT_ERROR,
    );
  }
});

test("probeDenied42501 works through the actual checkout-scoped facade", async () => {
  const { client, statements } = makePermissionProbeDriver();
  const pool = { connect: async () => client };
  await withCredentialCliClient(pool, async (owned) => {
    const denied = await probeDenied42501(owned, "SELECT attempt_id FROM production_migration_attempts LIMIT 0");
    assert.equal(denied.denied, true);
    assert.equal(denied.sqlstate, "42501");
    await assert.rejects(
      () => probeDenied42501(owned, "SELECT boom_25p02"),
      (err) => err.code === "25P02" && err.code !== PG_CHECKED_OUT_CLIENT_ERROR,
    );
    await owned.query("ROLLBACK TO SAVEPOINT unused").catch(() => {});
    await assert.rejects(
      () => probeDenied42501(owned, "SELECT missing_table"),
      (err) => err.code === "42P01",
    );
    await assert.rejects(
      () => probeDenied42501(owned, "SELECT dup_key"),
      (err) => err.code === "23505",
    );
    const later = await probeDenied42501(owned, "SELECT password_enc FROM employee_credentials LIMIT 0");
    assert.equal(later.denied, true);
    assert.equal(later.sqlstate, "42501");
    await owned.query("SELECT reader_probe");
  });
  assert.equal(statements.some((sql) => String(sql).includes("ROLLBACK TO SAVEPOINT")), true);
  assert.equal(statements.some((sql) => String(sql).includes("SELECT reader_probe")), true);
});

test("async EventEmitter error during query wins over a later normal result", async () => {
  const { client, statements } = makeCheckedOutClient();
  const errors = [];
  const restore = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  client.query = () => new Promise((resolve) => {
    setImmediate(() => {
      client.emit("error", new Error(SECRET_TEXT));
      setImmediate(() => resolve({ rows: [{ ok: true }] }));
    });
  });
  const pool = { connect: async () => client };
  try {
    await assert.rejects(
      () => withCredentialCliClient(pool, async (owned) => owned.query("SELECT race")),
      (err) => err.code === PG_CHECKED_OUT_CLIENT_ERROR,
    );
    assert.equal(countLinesWith(errors, PG_CHECKED_OUT_CLIENT_ERROR), 0);
    assertNoSecretMarkers(errors.concat(statements).join("\n"));
  } finally {
    console.error = restore;
  }
});

test("successful work does not print ok/PASS when release throws", async () => {
  const { client } = makeCheckedOutClient();
  client.release = () => {
    client._released = true;
    throw new Error(SECRET_TEXT);
  };
  const pool = { connect: async () => client };
  const logs = [];
  const errors = [];
  const restoreLog = console.log;
  const restoreErr = console.error;
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    await assert.rejects(
      () => publishAfterSession(pool, async () => {}, async () => ({ ok: true, verdict: "PASS" })),
      (err) => err.code === PG_CLIENT_RELEASE_FAILED,
    );
    assert.equal(successOutput([...logs, ...errors].join("\n")), false);
    assert.equal(countLinesWith(errors, PG_CLIENT_RELEASE_FAILED), 0);
    assertNoSecretMarkers([...logs, ...errors].join("\n"));
  } finally {
    console.log = restoreLog;
    console.error = restoreErr;
  }
});

test("successful work does not print ok/PASS when pool.end fails", async () => {
  const { client } = makeCheckedOutClient();
  const pool = { connect: async () => client };
  const logs = [];
  const errors = [];
  const restoreLog = console.log;
  const restoreErr = console.error;
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    await assert.rejects(
      () => publishAfterSession(pool, () => { throw new Error(SECRET_TEXT); }, async () => ({ ok: true, verdict: "PASS" })),
      (err) => err.code === PG_POOL_CLOSE_FAILED,
    );
    assert.equal(successOutput([...logs, ...errors].join("\n")), false);
    assert.equal(countLinesWith(errors, PG_POOL_CLOSE_FAILED), 0);
    assertNoSecretMarkers([...logs, ...errors].join("\n"));
  } finally {
    console.log = restoreLog;
    console.error = restoreErr;
  }
});

test("cleanup timeout after successful work does not print ok/PASS", async () => {
  const { client } = makeCheckedOutClient();
  client.release = () => new Promise(() => {});
  const pool = { connect: async () => client };
  const logs = [];
  const errors = [];
  const restoreLog = console.log;
  const restoreErr = console.error;
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    await assert.rejects(
      () => withWatchdog(
        publishAfterSession(pool, async () => {}, async () => ({ ok: true, verdict: "PASS" }), {
          rollbackTimeoutMs: 40,
          callbackSettleTimeoutMs: 40,
          releaseTimeoutMs: 40,
        }),
        3000,
      ),
      (err) => err.code === PG_CLIENT_RELEASE_FAILED && err.code !== "WATCHDOG",
    );
    assert.equal(successOutput([...logs, ...errors].join("\n")), false);
    assertNoSecretMarkers([...logs, ...errors].join("\n"));
  } finally {
    console.log = restoreLog;
    console.error = restoreErr;
  }
});

test("complete credential CLI lifecycle publishes success exactly once", async () => {
  const { client } = makeCheckedOutClient();
  const pool = { connect: async () => client };
  const logs = [];
  const restoreLog = console.log;
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  try {
    const result = await publishAfterSession(pool, async () => {}, async () => ({ ok: true }));
    assert.equal(result.ok, true);
    assert.equal(logs.filter((line) => successOutput(line)).length, 1);
  } finally {
    console.log = restoreLog;
  }
});

test("same physical client is reusable on a second checkout", async () => {
  const { client, statements } = makeCheckedOutClient();
  const driverQuery = client.query;
  const pool = makeReusablePool(client);
  await withCredentialCliClient(pool, async (owned) => {
    await owned.query("SELECT checkout_1");
  });
  assert.equal(client.query, driverQuery);
  const listenersAfterFirst = client.listenerCount("error");
  await withCredentialCliClient(pool, async (owned) => {
    await owned.query("SELECT checkout_2");
  });
  assert.equal(client.query, driverQuery);
  assert.equal(statements.some((sql) => String(sql).includes("SELECT checkout_1")), true);
  assert.equal(statements.some((sql) => String(sql).includes("SELECT checkout_2")), true);
  assert.equal(client.listenerCount("error"), listenersAfterFirst);
});

test("old checkout callback cannot issue SQL on a reused pooled client", async () => {
  const { client, statements } = makeCheckedOutClient();
  const pool = makeReusablePool(client);
  const errors = [];
  const restore = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  let stale;
  try {
    await withCredentialCliClient(pool, async (owned) => {
      stale = owned;
      await owned.query("SELECT checkout_1");
    });
    assert.equal(statements.some((sql) => String(sql).includes("SELECT checkout_1")), true);
    await withCredentialCliClient(pool, async (owned) => {
      assert.throws(
        () => stale.query("SELECT stolen"),
        (err) => err.code === PG_CHECKED_OUT_CLIENT_ERROR,
      );
      await owned.query("SELECT checkout_2");
    });
    assert.equal(statements.some((sql) => String(sql).includes("SELECT stolen")), false);
    assert.equal(statements.some((sql) => String(sql).includes("SELECT checkout_2")), true);
    assert.equal(client._released, true);
    assertNoSecretMarkers(errors.join("\n"));
  } finally {
    console.error = restore;
  }
});

test("deferred checkout-1 callback cannot use a later reused client", async () => {
  const { client, statements } = makeCheckedOutClient();
  const pool = makeReusablePool(client);
  const errors = [];
  const restore = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  let stale;
  let resolveDeferred;
  try {
    const pending = withCredentialCliClient(pool, async (owned) => {
      stale = owned;
      await new Promise((resolve) => { resolveDeferred = resolve; });
      await owned.query("SELECT from_old_callback");
      return { ok: true, verdict: "PASS" };
    }, { rollbackTimeoutMs: 40, callbackSettleTimeoutMs: 200, releaseTimeoutMs: 40 });
    await waitForErrorListener(client);
    client.emit("error", new Error(SECRET_TEXT));
    resolveDeferred();
    await assert.rejects(withWatchdog(pending), (err) => err.code === PG_CHECKED_OUT_CLIENT_ERROR);
    await withCredentialCliClient(pool, async (owned) => {
      assert.throws(
        () => stale.query("SELECT stolen"),
        (err) => err.code === PG_CHECKED_OUT_CLIENT_ERROR,
      );
      await owned.query("SELECT from_new_checkout");
    });
    assert.equal(statements.some((sql) => /from_old_callback|stolen/.test(String(sql))), false);
    assert.equal(statements.some((sql) => String(sql).includes("SELECT from_new_checkout")), true);
    assertNoSecretMarkers(errors.join("\n"));
  } finally {
    console.error = restore;
  }
});

test("fallback error listener is attached before checked-out listener removal", async () => {
  const { client } = makeCheckedOutClient();
  const pool = { connect: async () => client };
  const events = [];
  const origOn = client.on.bind(client);
  const origRemove = client.removeListener.bind(client);
  client.on = function on(type, fn) {
    if (type === "error") events.push(`add:${fn && fn.name ? fn.name : "anonymous"}`);
    return origOn(type, fn);
  };
  client.removeListener = function removeListener(type, fn) {
    if (type === "error") events.push(`remove:${fn && fn.name ? fn.name : "anonymous"}`);
    return origRemove(type, fn);
  };
  await withCredentialCliClient(pool, async () => ({ ok: true }));
  const addFallback = events.indexOf("add:credentialCliReleasedClientSafeError");
  const addChecked = events.findIndex((event) => event.startsWith("add:") && event !== "add:credentialCliReleasedClientSafeError");
  const removeChecked = events.findIndex((event) => event.startsWith("remove:") && event !== "remove:credentialCliReleasedClientSafeError");
  assert.notEqual(addFallback, -1);
  assert.notEqual(addChecked, -1);
  assert.notEqual(removeChecked, -1);
  assert.ok(addFallback < addChecked);
  assert.ok(addFallback < removeChecked);
  assert.equal(events.includes("remove:credentialCliReleasedClientSafeError"), false);
});

test("removeListener re-entrancy cannot create a zero-listener error window", async () => {
  const { client } = makeCheckedOutClient();
  const pool = { connect: async () => client };
  const logs = [];
  const errors = [];
  const restoreLog = console.log;
  const restoreErr = console.error;
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  const origRemove = client.removeListener.bind(client);
  client.removeListener = function removeListener(type, fn) {
    if (type === "error") {
      assert.ok(this.listenerCount("error") > 0, "listeners before synthetic emit");
      this.emit("error", new Error(SECRET_TEXT));
      assert.ok(this.listenerCount("error") > 0, "listeners during removeListener");
      const result = origRemove(type, fn);
      assert.ok(this.listenerCount("error") > 0, "listeners after checked-out removal");
      this.emit("error", new Error(SECRET_TEXT));
      return result;
    }
    return origRemove(type, fn);
  };
  try {
    await withCredentialCliClient(pool, async () => ({ ok: true }));
    const out = [...errors, ...logs].join("\n");
    assertNoSecretMarkers(out);
    assert.equal(out.includes(PG_CHECKED_OUT_CLIENT_ERROR), false);
    assert.equal(countLinesWith(errors, PG_IDLE_CLIENT_ERROR), 1);
    assert.equal(successOutput(logs.join("\n")), false);
  } finally {
    console.log = restoreLog;
    console.error = restoreErr;
  }
});

test("never-resolving ordinary-worker ROLLBACK terminates with primary error and cleanup timeout", async () => {
  const { client, statements } = makeCheckedOutClient();
  hungRollbackAfterBegin(client, statements);
  const pool = { connect: async () => client };
  const errors = [];
  const logs = [];
  let poolEnded = false;
  const restoreError = console.error;
  const restoreLog = console.log;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  const env = productionCliEnv();
  try {
    await assert.rejects(
      () => withWatchdog(runCredentialCliSession(pool, async (owned) => (
        runProductionCredentialRolePreflight({
          client: owned,
          env,
          masked: productionMasked(),
          liveFingerprint: env[CREDENTIAL_TARGET_FINGERPRINT_ENV],
        })
      ), async () => { poolEnded = true; }, {
        rollbackTimeoutMs: 50,
        callbackSettleTimeoutMs: 50,
        releaseTimeoutMs: 50,
      }), 3000),
      (err) => {
        assert.notEqual(err.code, "WATCHDOG");
        assert.notEqual(err.code, PG_CHECKED_OUT_CLIENT_ERROR);
        assert.equal(err.code, "42P01");
        assert.equal(err.cleanupCode, PG_CLEANUP_TIMEOUT);
        assert.equal(successOutput(err.message), false);
        return true;
      },
    );
    assert.equal(statements.some((sql) => String(sql).includes("BEGIN READ ONLY")), true);
    assert.equal(statements.some((sql) => /^ROLLBACK\s*;?$/i.test(String(sql).trim()) || String(sql) === "ROLLBACK"), true);
    assert.equal(client._released, true);
    assert.equal(poolEnded, true);
    assert.equal(successOutput([...logs, ...errors].join("\n")), false);
    assertNoSecretMarkers([...logs, ...errors, ...statements].join("\n"));
  } finally {
    console.error = restoreError;
    console.log = restoreLog;
  }
});

test("never-resolving ordinary-worker ROLLBACK in dry-run gate terminates with primary 42P01 and cleanup timeout", async () => {
  const { client, statements } = makeCheckedOutClient();
  hungRollbackAfterBegin(client, statements);
  const pool = { connect: async () => client };
  const errors = [];
  const restore = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    await assert.rejects(
      () => withWatchdog(withCredentialCliClient(pool, async (owned) => (
        planCredentialCopy({
          fb: { shallowKeys: async () => [] },
          client: owned,
        })
      ), { rollbackTimeoutMs: 50, callbackSettleTimeoutMs: 50, releaseTimeoutMs: 50 }), 3000),
      (err) => {
        assert.notEqual(err.code, "WATCHDOG");
        assert.notEqual(err.code, PG_CHECKED_OUT_CLIENT_ERROR);
        assert.equal(err.code, "42P01");
        assert.equal(err.cleanupCode, GATE_ERROR.PG_CLEANUP_TIMEOUT);
        assert.equal(successOutput(err.message), false);
        return true;
      },
    );
    assert.equal(client._released, true);
    assert.equal(successOutput(errors.join("\n")), false);
    assertNoSecretMarkers(errors.concat(statements).join("\n"));
  } finally {
    console.error = restore;
  }
});

test("rejecting final ROLLBACK after successful dry-run worker fails closed with PG_ROLLBACK_FAILED", async () => {
  const { client, statements } = makeCheckedOutClient();
  rejectRollbackAfterBegin(client, statements, { failWorker: false });
  const pool = { connect: async () => client };
  const logs = [];
  const errors = [];
  let poolEnded = false;
  const restoreLog = console.log;
  const restoreErr = console.error;
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    await assert.rejects(
      () => withWatchdog(runCredentialCliSession(pool, async (owned) => (
        planCredentialCopy({
          fb: { shallowKeys: async () => [], getValue: async () => null },
          client: owned,
        })
      ), async () => { poolEnded = true; }, {
        rollbackTimeoutMs: 50,
        callbackSettleTimeoutMs: 50,
        releaseTimeoutMs: 50,
      }), 3000),
      (err) => {
        assert.notEqual(err.code, "WATCHDOG");
        assert.equal(err.code, GATE_ERROR.PG_ROLLBACK_FAILED);
        assert.equal(err.cleanupCode, GATE_ERROR.PG_ROLLBACK_FAILED);
        assert.equal(err.code, PG_ROLLBACK_FAILED);
        assert.equal(successOutput(err.message), false);
        assert.equal(String(err.message || "").includes("secret://"), false);
        return true;
      },
    );
    assert.equal(client._released, true);
    assert.equal(poolEnded, true);
    assert.equal(successOutput([...logs, ...errors].join("\n")), false);
    assertNoSecretMarkers([...logs, ...errors, ...statements].join("\n"));
  } finally {
    console.log = restoreLog;
    console.error = restoreErr;
  }
});

test("rejecting ROLLBACK after worker 42P01 preserves primary and sets cleanupCode PG_ROLLBACK_FAILED", async () => {
  const { client, statements } = makeCheckedOutClient();
  rejectRollbackAfterBegin(client, statements, { workerCode: "42P01", failWorker: true });
  const pool = { connect: async () => client };
  let poolEnded = false;
  const errors = [];
  const restore = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    await assert.rejects(
      () => withWatchdog(runCredentialCliSession(pool, async (owned) => (
        planCredentialCopy({
          fb: { shallowKeys: async () => [] },
          client: owned,
        })
      ), async () => { poolEnded = true; }, {
        rollbackTimeoutMs: 50,
        callbackSettleTimeoutMs: 50,
        releaseTimeoutMs: 50,
      }), 3000),
      (err) => {
        assert.equal(err.code, "42P01");
        assert.equal(err.cleanupCode, PG_ROLLBACK_FAILED);
        assert.notEqual(err.code, GATE_ERROR.RECONCILIATION_FAILED);
        assert.equal(successOutput(err.message), false);
        return true;
      },
    );
    assert.equal(client._released, true);
    assert.equal(poolEnded, true);
    assertNoSecretMarkers(errors.concat(statements).join("\n"));
  } finally {
    console.error = restore;
  }
});

test("fallback boundedCredentialRollback rejects fail closed without ALS store", async () => {
  const { client, statements } = makeCheckedOutClient();
  rejectRollbackAfterBegin(client, statements, { failWorker: false });
  const { boundedCredentialRollback } = await import("../postgres.js");
  const rb = await boundedCredentialRollback(client);
  assert.equal(rb.ok, false);
  assert.equal(rb.code, PG_ROLLBACK_FAILED);
  assert.equal(rb.timedOut, undefined);
  assert.equal(statements.some((sql) => /^ROLLBACK\s*;?$/i.test(String(sql).trim())), true);
});

test("synchronous rollback throw is PG_ROLLBACK_FAILED not timeout", async () => {
  const { client, statements } = makeCheckedOutClient();
  client.query = (sql) => {
    statements.push(String(sql));
    if (/^ROLLBACK\s*;?$/i.test(String(sql).replace(/\s+/g, " ").trim())) {
      throw new Error("sync rollback boom secret://x");
    }
    return Promise.resolve({ rows: [] });
  };
  const { boundedCredentialRollback } = await import("../postgres.js");
  const rb = await boundedCredentialRollback(client);
  assert.equal(rb.ok, false);
  assert.equal(rb.code, PG_ROLLBACK_FAILED);
  assert.notEqual(rb.timedOut, true);
  assert.equal(rb.timedOut, undefined);
});

test("never-resolving rollback Promise is PG_CLEANUP_TIMEOUT", async () => {
  const { client } = makeCheckedOutClient();
  client.query = (sql) => {
    if (/^ROLLBACK\s*;?$/i.test(String(sql).replace(/\s+/g, " ").trim())) return new Promise(() => {});
    return Promise.resolve({ rows: [] });
  };
  const pool = { connect: async () => client };
  await assert.rejects(
    () => withWatchdog(withCredentialCliClient(pool, async (owned) => {
      const rb = await import("../postgres.js").then((m) => m.boundedCredentialRollback(owned));
      assert.equal(rb.ok, false);
      assert.equal(rb.timedOut, true);
      assert.equal(rb.code, PG_CLEANUP_TIMEOUT);
      throw Object.assign(new Error(PG_CLEANUP_TIMEOUT), { code: PG_CLEANUP_TIMEOUT, cleanupCode: PG_CLEANUP_TIMEOUT });
    }, { rollbackTimeoutMs: 50, callbackSettleTimeoutMs: 50, releaseTimeoutMs: 50 }), 3000),
    (err) => err.code === PG_CLEANUP_TIMEOUT,
  );
});

test("worker success plus sync rollback throw fails closed with PG_ROLLBACK_FAILED", async () => {
  const { client, statements } = makeCheckedOutClient();
  client.query = (sql) => {
    statements.push(String(sql));
    const text = String(sql).replace(/\s+/g, " ").trim();
    if (/^ROLLBACK\s*;?$/i.test(text)) throw new Error("sync rb secret://x");
    if (/count\(\*\)/i.test(text)) return Promise.resolve({ rows: [{ n: 0 }] });
    return Promise.resolve({ rows: [] });
  };
  const pool = { connect: async () => client };
  const logs = [];
  const errors = [];
  let poolEnded = false;
  const restoreLog = console.log;
  const restoreErr = console.error;
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    await assert.rejects(
      () => withWatchdog(runCredentialCliSession(pool, async (owned) => (
        planCredentialCopy({
          fb: { shallowKeys: async () => [], getValue: async () => null },
          client: owned,
        })
      ), async () => { poolEnded = true; }, {
        rollbackTimeoutMs: 50,
        callbackSettleTimeoutMs: 50,
        releaseTimeoutMs: 50,
      }), 3000),
      (err) => {
        assert.equal(err.code, PG_ROLLBACK_FAILED);
        assert.equal(err.cleanupCode, PG_ROLLBACK_FAILED);
        assert.equal(successOutput(err.message), false);
        assert.equal(String(err.message || "").includes("secret://"), false);
        return true;
      },
    );
    assert.equal(client._released, true);
    assert.equal(poolEnded, true);
    assert.equal(successOutput([...logs, ...errors].join("\n")), false);
  } finally {
    console.log = restoreLog;
    console.error = restoreErr;
  }
});

test("worker 42P01 plus sync rollback throw preserves primary and cleanupCode", async () => {
  const { client, statements } = makeCheckedOutClient();
  client.query = (sql) => {
    statements.push(String(sql));
    const text = String(sql).replace(/\s+/g, " ").trim();
    if (text === "BEGIN" || text === "BEGIN READ ONLY") return Promise.resolve({ rows: [] });
    if (/^ROLLBACK\s*;?$/i.test(text)) throw new Error("sync rb");
    const err = new Error("WORKER_FAILED");
    err.code = "42P01";
    return Promise.reject(err);
  };
  const pool = { connect: async () => client };
  await assert.rejects(
    () => withWatchdog(withCredentialCliClient(pool, async (owned) => (
      planCredentialCopy({
        fb: { shallowKeys: async () => [] },
        client: owned,
      })
    ), { rollbackTimeoutMs: 50, callbackSettleTimeoutMs: 50, releaseTimeoutMs: 50 }), 3000),
    (err) => {
      assert.equal(err.code, "42P01");
      assert.equal(err.cleanupCode, PG_ROLLBACK_FAILED);
      return true;
    },
  );
});

test("removing ordinary-worker rollback timeout would hang under the test watchdog", () => {
  const settleSrc = pgSrc.slice(
    pgSrc.indexOf("async function settleCredentialRollback"),
    pgSrc.indexOf("export async function boundedCredentialRollback"),
  );
  assert.match(settleSrc, /withCredentialCliTimeout/);
  const mutated = settleSrc.replace(/withCredentialCliTimeout\(/g, "Promise.resolve(");
  assert.doesNotMatch(mutated, /withCredentialCliTimeout/);
  const roleSrc = readFileSync(path.join(here, "../scripts/lib/credentialRolePreflight.mjs"), "utf8");
  const finishSrc = roleSrc.slice(
    roleSrc.indexOf("async function finishCredentialRollback"),
    roleSrc.indexOf("export async function runProductionCredentialRolePreflight"),
  );
  assert.match(finishSrc, /boundedCredentialRollback/);
  assert.match(finishSrc, /PG_CLEANUP_TIMEOUT|PG_ROLLBACK_FAILED/);
  assert.match(finishSrc, /!rb\.ok/);
});

test("credential report ID sanitizer accepts observed legacy shapes and rejects hostile IDs", () => {
  const shapes = [
    "-Nabcdefghijklmnopqr_1700000000001",
    "-O0123456789ABCDEFGH_1785493031293",
    "-Pzyxwvutsrqponmlkji_1699999999999",
  ];
  for (const id of shapes) {
    assert.equal(safeReportId(id), id);
    assert.equal(isSecretLikeValue(id), false);
  }
  assert.equal(safeReportId("-Nabcdefghijklmnopqr"), "-Nabcdefghijklmnopqr");
  assert.equal(safeReportId("chef_1700000000001"), "chef_1700000000001");
  assert.equal(safeReportId("%2B998901234567"), "%2B998901234567");

  assert.equal(safeReportId("user@evil"), null);
  assert.equal(safeReportId("a/b"), null);
  assert.equal(safeReportId("a\\b"), null);
  assert.equal(safeReportId("has space"), null);
  assert.equal(safeReportId("has\nnewline"), null);
  assert.equal(safeReportId("\u0001control"), null);
  assert.equal(safeReportId(`x${"y".repeat(200)}`), null);
  assert.equal(safeReportId("postgres://u:p@h/db"), null);
  // Ordinary dotted labels are not JWTs; SAFE_ID_RE may emit them raw.
  assert.equal(containsSecretLikeMaterial("a.b.c"), false);
  assert.equal(safeReportId("a.b.c"), "a.b.c");
  assert.equal(containsSecretLikeMaterial("token:a.b.c"), false);
  assert.equal(safeReportId("token:a.b.c"), "token:a.b.c");
  assert.equal(safeReportId("user:ghp_abcd1234"), null);
  assert.equal(safeReportId(`id:${"a".repeat(32)}`), null);
  assert.equal(safeReportId("sk_live_abcd1234"), null);
  assert.equal(safeReportId("Sk_LiVe_abcd1234"), null);
  assert.equal(safeReportId("GhP_abcd1234"), null);
  assert.equal(containsSecretLikeMaterial("ghp_abcd1234"), true);
  assert.equal(containsSecretLikeMaterial("GhP_abcd1234"), true);
  assert.equal(containsSecretLikeMaterial("a".repeat(32)), true);
  assert.equal(containsSecretLikeMaterial("G".repeat(40)), true);
  assert.equal(isSecretLikeValue("Bearer abc.def.ghi"), true);
  assert.equal(isSecretLikeValue("password=SUPER_SECRET_PIN_987654"), true);
  const realisticJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepad";
  assert.equal(containsSecretLikeMaterial(realisticJwt), true);
  assert.equal(safeReportId(realisticJwt), null);
  assert.equal(containsSecretLikeMaterial("employee:branch.v1.active"), false);

  const gateSrc = readFileSync(path.join(here, "../scripts/lib/productionCredentialGate.mjs"), "utf8");
  const migrateSrc = readFileSync(path.join(here, "../scripts/production-credentials-migrate.mjs"), "utf8");
  assert.match(gateSrc, /containsSecretLikeMaterial/);
  assert.match(gateSrc, /JWT_REALISTIC_ANYWHERE_RE/);
  assert.doesNotMatch(gateSrc, /JWT_LIKE_ANYWHERE_RE/);
  assert.match(gateSrc, /API_TOKEN_ANYWHERE_RE/);
  assert.match(gateSrc, /API_TOKEN_ANYWHERE_RE = \/[^\n]+\/i/);
  assert.match(gateSrc, /LONG_HEX_ANYWHERE_RE/);
  assert.match(gateSrc, /LONG_BASE64URL_ANYWHERE_RE/);
  assert.doesNotMatch(gateSrc, /console\.(log|info|debug|warn|error)/);
  assert.doesNotMatch(gateSrc, /process\.env\.ENCRYPTION_KEY|decryptSecret|decryptPassword/);
  assert.doesNotMatch(migrateSrc, /process\.env\.ENCRYPTION_KEY|decryptSecret|decryptPassword/);
  assert.doesNotMatch(
    migrateSrc,
    /console\.(log|info|debug|warn|error)\s*\(\s*[^)]*\b(password|passwordHash|passwordEnc|plaintext|plaintextCredential|ENCRYPTION_KEY|decrypt|pin)\b/i,
  );
  const publicFn = gateSrc.slice(gateSrc.indexOf("export function publicErrorCode"), gateSrc.indexOf("function isPgSqlState"));
  assert.doesNotMatch(publicFn.replace(/\/\/[^\n]*/g, ""), /err\.message/);
  assert.equal(publicErrorCode(new Error("PLAINTEXT_PASSWORD_MARKER_123")), GATE_ERROR.GATE_FAILED);

  assert.throws(
    () => assertSecretFree({ password: "PLAINTEXT_PASSWORD_MARKER_123" }),
    (err) => publicErrorCode(err) === GATE_ERROR.SECRET_OUTPUT_REJECTED,
  );

  const report = validateCredentialGateReport({
    generatedAt: "2026-01-01T00:00:00.000Z",
    mode: "dry-run",
    writes: 0,
    firebaseWrites: 0,
    credentialTrees: 1,
    credentialUserNodes: 1,
    restaurantsInPg: 1,
    employeesInPg: 1,
    currentEmployeeCredentials: 0,
    mappable: 1,
    hashOnly: 1,
    passwordEncOnly: 0,
    both: 0,
    loginCompatible: 1,
    expectedInserts: 1,
    expectedUpdates: 0,
    expectedUnchanged: 0,
    expectedConflicts: 0,
    expectedShaReset: 1,
    expectedShaResetWithEnc: 0,
    expectedShaResetOnly: 1,
    credentialWithoutEmployee: [],
    employeeWithoutCredential: [],
    missingCredentialNode: [],
    restaurantsWithoutCredentialTree: [],
    incompatibleHash: [],
    legacyShaRequiresReset: [{ restId: "rest_1", userId: shapes[0], kind: "sha256", hasEnc: false }],
    destinationConflicts: [],
    planned: [{
      restId: "rest_1",
      userId: shapes[0],
      restaurantId: "11111111-1111-1111-1111-111111111111",
      employeeId: "22222222-2222-2222-2222-222222222222",
      hasHash: true,
      hasEnc: false,
      action: "insert",
    }],
    incompatibleHashBlocksApply: false,
    reconciliation: null,
    verdict: GATE_ERROR.LEGACY_SHA_REQUIRES_RESET,
  });
  assert.equal(report.planned[0].userId, shapes[0]);
  assert.equal(report.legacyShaRequiresReset[0].hasEnc, false);
  const text = JSON.stringify(report);
  assert.equal(text.includes("$2a$"), false);
  assert.equal(text.includes("postgres://"), false);
  assert.equal(text.includes("SUPER_SECRET_PIN_987654"), false);
  assert.equal(text.includes("PLAINTEXT_PASSWORD_MARKER"), false);
  assert.equal(text.includes("ENCRYPTION_KEY_MARKER"), false);
  assert.equal(opaqueReportId("weird*key").startsWith("id:"), true);
});
