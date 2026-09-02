import test from "node:test";
import assert from "node:assert/strict";
import {
  STEP2D4_RESTORE_DB,
  resolveDumpSource,
  resolveRestoreTarget,
  assertRestoreDatabaseName,
  redactSecrets,
  sourceCannotBeRestoreTarget,
} from "../scripts/lib/pgBackupRestoreTarget.mjs";
import {
  parsePgVersionString,
  assertPgDumpCompatible,
  resolvePgClientBins,
  probePgToolVersion,
  verifyPgRestoreListResult,
  describeLegacyBrokenPipePgRestoreList,
} from "../scripts/lib/pgDumpClientGuard.mjs";
import {
  MINIMUM_RESTORE_ROLES,
  deriveNestaRolesFromText,
  requiredRestoreRoles,
  assertLocalRoleBootstrapTarget,
  createRoleSql,
  dangerousRoleAttrs,
  classifyPgRestoreOutput,
  bootstrapRestoreRoles,
  dropTemporaryRestoreRoles,
} from "../scripts/lib/pgRestoreRoleBootstrap.mjs";

const railwayUrl = "postgres://u:secret@altaria.proxy.rlwy.net:12345/railway";
const localAdmin = {
  POSTGRES_HOST: "127.0.0.1",
  POSTGRES_PORT: "5432",
  POSTGRES_USER: "postgres",
  POSTGRES_PASSWORD: "x",
  POSTGRES_DB: "postgres",
};

function snapshot(obj) {
  const { password, ...rest } = obj;
  return rest;
}

test("Railway source and local restore target are independent", () => {
  const source = resolveDumpSource({ DATABASE_PUBLIC_URL: railwayUrl, POSTGRES_SSL: "true" });
  const restore = resolveRestoreTarget({ DATABASE_PUBLIC_URL: railwayUrl, POSTGRES_URL: railwayUrl }, localAdmin);
  assert.equal(source.ok, true);
  assert.equal(source.database, "railway");
  assert.equal(source.hostClass.includes("rlwy.net"), true);
  assert.equal(restore.ok, true);
  assert.equal(restore.host, "127.0.0.1");
  assert.equal(restore.restoreDatabase, STEP2D4_RESTORE_DB);
  assert.equal(restore.restoreDatabase, "nesta_step2d4_restore");
  assert.notEqual(restore.restoreDatabase, "railway");
  assert.equal(sourceCannotBeRestoreTarget(source, restore), true);
});

test("DATABASE_PUBLIC_URL can never become restore target", () => {
  const restoreFromPublicOnly = resolveRestoreTarget({ DATABASE_PUBLIC_URL: railwayUrl }, {});
  assert.equal(restoreFromPublicOnly.ok, false);
  const restoreHijack = resolveRestoreTarget({ STEP2D4_RESTORE_DATABASE_URL: railwayUrl }, localAdmin);
  assert.equal(restoreHijack.ok, false);
  assert.match(restoreHijack.reason, /loopback|Railway/i);
  const processOverlay = resolveRestoreTarget(
    { DATABASE_PUBLIC_URL: railwayUrl, POSTGRES_URL: railwayUrl },
    localAdmin
  );
  assert.equal(processOverlay.ok, true);
  assert.equal(processOverlay.host, "127.0.0.1");
  assert.equal(processOverlay.restoreDatabase, STEP2D4_RESTORE_DB);
});

test("remote restore target is STOP", () => {
  const r = resolveRestoreTarget({
    STEP2D4_RESTORE_DATABASE_URL: "postgres://u:p@db.example.com:5432/nesta_step2d4_restore",
  }, {});
  assert.equal(r.ok, false);
});

test("wrong local DB name is STOP", () => {
  const r = resolveRestoreTarget({
    STEP2D4_RESTORE_DATABASE_URL: "postgres://u:p@localhost:5432/nesta_migration_dryrun",
  }, {});
  assert.equal(r.ok, false);
  assert.throws(() => assertRestoreDatabaseName("postgres"));
  assert.throws(() => assertRestoreDatabaseName("railway"));
  assert.throws(() => assertRestoreDatabaseName("nesta_migration_dryrun"));
  assert.doesNotThrow(() => assertRestoreDatabaseName("nesta_step2d4_restore"));
});

test("exact disposable local target is allowed", () => {
  const r = resolveRestoreTarget({
    STEP2D4_RESTORE_DATABASE_URL: "postgres://u:p@localhost:5432/nesta_step2d4_restore",
  }, {});
  assert.equal(r.ok, true);
  assert.equal(r.restoreDatabase, "nesta_step2d4_restore");
  assert.equal(r.adminDatabase, "postgres");
  assert.equal(r.hostClass, "localhost");
});

test("dotenv Railway POSTGRES_URL does not override local discrete restore host", () => {
  const r = resolveRestoreTarget({ DATABASE_PUBLIC_URL: railwayUrl }, {
    POSTGRES_URL: railwayUrl,
    ...localAdmin,
  });
  assert.equal(r.ok, true);
  assert.equal(r.host, "127.0.0.1");
  assert.equal(r.restoreDatabase, STEP2D4_RESTORE_DB);
});

test("dump source refuses localhost substitution", () => {
  const r = resolveDumpSource({
    POSTGRES_URL: "postgres://u:p@127.0.0.1:5432/postgres",
    POSTGRES_HOST: "127.0.0.1",
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /DATABASE_PUBLIC_URL is unset/);
});

test("production Railway identity is dump-only", () => {
  const source = resolveDumpSource({ DATABASE_PUBLIC_URL: railwayUrl });
  const restore = resolveRestoreTarget({ DATABASE_PUBLIC_URL: railwayUrl }, localAdmin);
  assert.equal(source.database, "railway");
  assert.equal(restore.restoreDatabase, "nesta_step2d4_restore");
  assert.notEqual(source.host, restore.host);
  const dumped = JSON.stringify(snapshot(source));
  const restored = JSON.stringify(snapshot(restore));
  assert.equal(dumped.includes("secret"), false);
  assert.equal(restored.includes("secret"), false);
  assert.equal(restored.includes("altaria"), false);
  assert.equal(restored.includes("railway"), false);
});

test("secrets are not logged by redaction helper", () => {
  const raw = "pg_dump failed: postgres://u:supersecret@altaria.proxy.rlwy.net:1/railway PGPASSWORD=supersecret DATABASE_PUBLIC_URL=postgres://u:supersecret@x/railway";
  const out = redactSecrets(raw);
  assert.equal(out.includes("supersecret"), false);
  assert.equal(out.includes("postgres://***"), true);
  assert.equal(out.includes("DATABASE_URL=***"), true);
});

test("pg_dump 16 vs server 18 is STOP", () => {
  const r = assertPgDumpCompatible(18, 16);
  assert.equal(r.ok, false);
  assert.equal(r.code, "PG_DUMP_VERSION_INCOMPATIBLE");
  assert.match(r.reason, /PG_DUMP_VERSION_INCOMPATIBLE:/);
  assert.match(r.reason, /server=18/);
  assert.match(r.reason, /pg_dump=16/);
});

test("pg_dump 18 vs server 18 is allowed", () => {
  const same = assertPgDumpCompatible(18, 18);
  assert.equal(same.ok, true);
  const newer = assertPgDumpCompatible(18, 19);
  assert.equal(newer.ok, true);
});

test("explicit PG_DUMP_BIN takes precedence over POSTGRES_BIN_DIR and PATH", () => {
  const explicitDump = "C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe";
  const explicitRestore = "C:\\Program Files\\PostgreSQL\\18\\bin\\pg_restore.exe";
  const r = resolvePgClientBins({
    PG_DUMP_BIN: explicitDump,
    PG_RESTORE_BIN: explicitRestore,
    POSTGRES_BIN_DIR: "D:\\other-postgresql\\pgsql\\bin",
  }, { platform: "win32" });
  assert.equal(r.pgDump.source, "PG_DUMP_BIN");
  assert.equal(r.pgDump.path, explicitDump);
  assert.equal(r.pgRestore.source, "PG_RESTORE_BIN");
  assert.equal(r.pgRestore.path, explicitRestore);
  const pathOnly = resolvePgClientBins({}, { platform: "win32" });
  assert.equal(pathOnly.pgDump.source, "PATH");
  assert.equal(pathOnly.pgDump.path, "pg_dump.exe");
});

test("probePgToolVersion parses pg_dump --version without logging secrets", () => {
  const fakeSpawn = () => ({
    status: 0,
    stdout: "pg_dump (PostgreSQL) 16.15\n",
    stderr: "PGPASSWORD=supersecret postgres://u:supersecret@host/railway",
  });
  const probe = probePgToolVersion("pg_dump", fakeSpawn);
  assert.equal(probe.ok, true);
  assert.equal(probe.major, 16);
  assert.equal(probe.version, "16.15");
  assert.equal(JSON.stringify(probe).includes("supersecret"), false);
});

test("parsePgVersionString reads server 18.6 and client 16.15", () => {
  assert.equal(parsePgVersionString("18.6").major, 18);
  assert.equal(parsePgVersionString("pg_dump (PostgreSQL) 16.15").major, 16);
});

const loopbackRestore = {
  ok: true,
  host: "127.0.0.1",
  restoreDatabase: "nesta_step2d4_restore",
  adminDatabase: "postgres",
};

function fakeRoleClient({ existing = new Set() } = {}) {
  const queries = [];
  const roles = new Set(existing);
  return {
    queries,
    roles,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (String(sql).includes("FROM pg_roles WHERE rolname = $1")) {
        return { rowCount: roles.has(params[0]) ? 1 : 0, rows: [] };
      }
      if (String(sql).includes("FROM pg_roles WHERE rolname = ANY")) {
        const names = params[0] || [];
        return {
          rowCount: names.length,
          rows: names.map((rolname) => ({
            rolname,
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolreplication: false,
            rolbypassrls: false,
            rolcanlogin: false,
          })),
        };
      }
      if (String(sql).startsWith("CREATE ROLE")) {
        const m = String(sql).match(/CREATE ROLE "([^"]+)"/);
        if (m) roles.add(m[1]);
        return { rowCount: 1, rows: [] };
      }
      if (String(sql).startsWith("DROP ROLE")) {
        const m = String(sql).match(/DROP ROLE IF EXISTS "([^"]+)"/);
        if (m) roles.delete(m[1]);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

test("missing nesta_app can be bootstrapped locally", async () => {
  const client = fakeRoleClient();
  const r = await bootstrapRestoreRoles(client, { restore: loopbackRestore, roles: ["nesta_app"] });
  assert.deepEqual(r.created, ["nesta_app"]);
  assert.deepEqual(r.preexisting, []);
  assert.equal(client.queries.some((q) => q.sql.startsWith("CREATE ROLE \"nesta_app\"")), true);
});

test("bootstrap role has no dangerous privileges", () => {
  const sql = createRoleSql("nesta_app");
  assert.match(sql, /NOSUPERUSER/);
  assert.match(sql, /NOCREATEDB/);
  assert.match(sql, /NOCREATEROLE/);
  assert.match(sql, /NOREPLICATION/);
  assert.match(sql, /NOBYPASSRLS/);
  assert.match(sql, /NOLOGIN/);
  assert.equal(/CREATE ROLE .* SUPERUSER/.test(sql.replaceAll("NOSUPERUSER", "")), false);
  assert.deepEqual(dangerousRoleAttrs({
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
  }), []);
});

test("remote role bootstrap is STOP", async () => {
  const client = fakeRoleClient();
  await assert.rejects(
    () => bootstrapRestoreRoles(client, {
      restore: {
        ok: true,
        host: "db.example.com",
        restoreDatabase: "nesta_step2d4_restore",
        adminDatabase: "postgres",
      },
      roles: ["nesta_app"],
    }),
    /not loopback/
  );
  assert.equal(client.queries.length, 0);
});

test("production Railway never receives CREATE ROLE", async () => {
  const client = fakeRoleClient();
  const railwayRestore = {
    ok: true,
    host: "altaria.proxy.rlwy.net",
    restoreDatabase: "nesta_step2d4_restore",
    adminDatabase: "postgres",
    hostClass: "*.rlwy.net",
  };
  assert.equal(assertLocalRoleBootstrapTarget(railwayRestore).ok, false);
  await assert.rejects(
    () => bootstrapRestoreRoles(client, { restore: railwayRestore, roles: ["nesta_app"] }),
    /Railway|DATABASE_PUBLIC_URL|loopback/
  );
  assert.equal(client.queries.some((q) => String(q.sql).includes("CREATE ROLE")), false);
  assert.equal(client.queries.length, 0);
});

test("pre-existing local roles are not removed", async () => {
  const client = fakeRoleClient({ existing: new Set(["nesta_app"]) });
  const boot = await bootstrapRestoreRoles(client, {
    restore: loopbackRestore,
    roles: ["nesta_app", "nesta_login_reader"],
  });
  assert.deepEqual(boot.preexisting, ["nesta_app"]);
  assert.deepEqual(boot.created, ["nesta_login_reader"]);
  const cleanup = await dropTemporaryRestoreRoles(client, {
    restore: loopbackRestore,
    created: boot.created,
  });
  assert.deepEqual(cleanup.dropped, ["nesta_login_reader"]);
  assert.equal(client.roles.has("nesta_app"), true);
  assert.equal(client.roles.has("nesta_login_reader"), false);
});

test("temporary roles can be cleaned up safely", async () => {
  const client = fakeRoleClient();
  const boot = await bootstrapRestoreRoles(client, {
    restore: loopbackRestore,
    roles: MINIMUM_RESTORE_ROLES,
  });
  assert.equal(boot.created.length, 3);
  const cleanup = await dropTemporaryRestoreRoles(client, {
    restore: loopbackRestore,
    created: boot.created,
  });
  assert.deepEqual(cleanup.dropped.sort(), [...MINIMUM_RESTORE_ROLES].sort());
  assert.equal(cleanup.skipped.length, 0);
});

test("production pg_restore --list verifier is fail-closed", () => {
  const valid = `;
; Archive created at 2026-09-02 12:00:00 UTC
;     dbname: railway
;     TOC Entries: 2
;     Compression: gzip
;     Dump Version: 1.16-0
;     Format: CUSTOM
;     Integer: 4 bytes
;     Offset: 8 bytes
;
;
; Selected TOC Entries:
;
221; 1259 16384 TABLE public restaurants nesta_migrator
222; 1259 16385 TABLE public employees nesta_migrator
`;
  const pass = verifyPgRestoreListResult({ status: 0, stdout: valid });
  assert.equal(pass.ok, true);
  assert.equal(pass.authorizing, true);
  assert.equal(pass.verified, true);
  const passAgain = verifyPgRestoreListResult({ status: 0, stdout: valid });
  assert.equal(passAgain.ok, true, "global TOC regex must not fail-open or fail a second valid listing");

  const partial = `;
; Archive created at 2026-09-02 12:00:00 UTC
;     TOC Entries: 12
;     Format: CUSTOM
;
; Selected TOC Entries:
;
221; 1259 16384 TABLE public restaurants nesta_migrator
`;
  const failClosed = (result, msg) => {
    assert.equal(result.ok, false, msg);
    assert.equal(result.authorizing, false, msg);
    assert.equal(result.verified, false, msg);
  };
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: valid,
    stderr: "pg_restore: error: could not read from input file",
  }), "status 0 + pg_restore: error:");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: `${valid}\npg_restore: fatal: corrupt custom-format dump`,
  }), "status 0 + pg_restore: fatal:");
  failClosed(verifyPgRestoreListResult({ status: -1, stdout: valid }), "status -1 + full TOC");
  failClosed(verifyPgRestoreListResult({ status: -1, stdout: partial }), "status -1 + partial TOC");
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: valid, signal: "SIGPIPE" }), "SIGPIPE");
  failClosed(verifyPgRestoreListResult({
    status: -1,
    stdout: partial,
    signal: "SIGPIPE",
  }), "SIGPIPE + partial TOC");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: valid,
    error: new Error("spawn failed"),
  }), "spawn error");
  failClosed(verifyPgRestoreListResult({ status: 1, stdout: valid }), "status 1");
  failClosed(verifyPgRestoreListResult({
    status: 1,
    stdout: "",
    stderr: "pg_restore: error: unsupported version (1.16) in file header",
  }), "corrupt custom-format dump");
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: "" }), "empty output");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: "; Archive created at 2026-09-02 12:00:00 UTC\n",
  }), "only Archive created at");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: "; TOC Entries: 2\n",
  }), "only TOC Entries");
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: partial }), "truncated/partial TOC");
  const legacy = describeLegacyBrokenPipePgRestoreList({ status: -1, stdout: valid, signal: "SIGPIPE" });
  failClosed(legacy, "legacy broken-pipe helper");
  assert.equal(legacy.legacyObservationOnly, true);
});

test("pg_restore role-reference failure is not classified harmless", () => {
  const classified = classifyPgRestoreOutput(1, 'pg_restore: error: could not execute query: ERROR:  role "nesta_app" does not exist');
  assert.equal(classified.ok, false);
  assert.equal(classified.harmful.length > 0, true);
  const clean = classifyPgRestoreOutput(0, "");
  assert.equal(clean.ok, true);
});

test("dump/schema text derives nesta roles including policies", () => {
  const fromPolicy = deriveNestaRolesFromText("CREATE POLICY p ON t TO nesta_app USING (true); GRANT SELECT ON t TO nesta_login_reader;");
  assert.equal(fromPolicy.includes("nesta_app"), true);
  assert.equal(fromPolicy.includes("nesta_login_reader"), true);
  const required = requiredRestoreRoles({
    dumpListText: "ACL TABLE restaurants nesta_app",
    migrationRoles: ["nesta_payment_revealer"],
  });
  assert.equal(required.includes("nesta_app"), true);
  assert.equal(required.includes("nesta_credential_revealer"), true);
  assert.equal(required.includes("nesta_payment_revealer"), true);
});
