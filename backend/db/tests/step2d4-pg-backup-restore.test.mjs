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
  runPgRestoreList,
  PG_RESTORE_LIST_ARGS,
  countPgRestoreTocItemLines,
  parsePgRestoreVerboseToc,
  LEGACY_PERMISSIVE_TOC_ITEM_LINE,
  PG_DUMP_TOC_DESCRIPTIONS,
  PG_DATABASE_RELATION_ID,
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
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SCHEMA_APPLY_MODE } from "../scripts/lib/schemaApplySession.mjs";
import {
  loadRepoMigrations,
  expectedHistoryThrough,
  expectedPublicTablesThrough,
  predecessorVersion,
} from "../scripts/lib/schemaMigrationCatalog.mjs";
import { REQUIRED_SCHEMA_VERSION } from "../scripts/lib/migrationTargetGuard.mjs";
import {
  BACKUP_SOURCE_CLASS,
  STEP2D4_REQUIRED_BACKUP_SOURCE_CLASS,
  evaluateBackupSourceContract,
  evaluateRestoredSchemaContract,
} from "../scripts/lib/pgBackupRestoreSchemaContract.mjs";

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
;     TOC Entries: 6
;     Compression: gzip
;     Dump Version: 1.16-0
;     Format: CUSTOM
;     Integer: 4 bytes
;     Offset: 8 bytes
;
;
; Selected TOC Entries:
;
1; 0 0 ENCODING - ENCODING
2; 0 0 STDSTRINGS - STDSTRINGS
3; 0 0 SEARCHPATH - SEARCHPATH
4; 1262 16384 DATABASE - railway postgres
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

function pg18ListHeader(declared) {
  return `;
; Archive created at 2026-09-03 00:00:00 UTC
;     dbname: railway
;     TOC Entries: ${declared}
;     Compression: gzip
;     Dump Version: 1.16-0
;     Format: CUSTOM
;     Integer: 4 bytes
;     Offset: 8 bytes
;
;
; Selected TOC Entries:
;
`;
}

const PG18_SPECIAL_TOC = [
  "1; 0 0 ENCODING - ENCODING",
  "2; 0 0 STDSTRINGS - STDSTRINGS",
  "3; 0 0 SEARCHPATH - SEARCHPATH",
  "4; 1262 16384 DATABASE - railway postgres",
];

function pg18TableLine(i) {
  return `${5 + i}; 1259 ${16384 + i} TABLE public t_${i} nesta_migrator`;
}

function pg18VerboseList(tableCount) {
  const items = [...PG18_SPECIAL_TOC, ...Array.from({ length: tableCount }, (_, i) => pg18TableLine(i))];
  return `${pg18ListHeader(items.length)}${items.join("\n")}\n;\tdepends on: 1\n`;
}

test("production listing uses --list --verbose with no pipe", () => {
  assert.deepEqual([...PG_RESTORE_LIST_ARGS], ["--list", "--verbose"]);
  let args;
  runPgRestoreList("pg_restore", "dump.pgdump", (_exe, received) => {
    args = received;
    return { status: 0, stdout: "", stderr: "", error: null, signal: null };
  });
  assert.deepEqual(args, ["--list", "--verbose", "dump.pgdump"]);
});

test("PostgreSQL 18.6 verbose TOC listing of 1148 entries PASSes; non-verbose 1144/1148 FAILs", () => {
  const tableCount = 1144;
  const verbose = pg18VerboseList(tableCount);
  const declared = 4 + tableCount;
  assert.equal(declared, 1148);
  assert.equal(countPgRestoreTocItemLines(verbose), 1148);
  const pass = verifyPgRestoreListResult({ status: 0, stdout: verbose });
  assert.equal(pass.ok, true);
  assert.equal(pass.authorizing, true);
  assert.equal(pass.tocEntries, 1148);

  const nonVerbose = `${pg18ListHeader(1148)}${Array.from({ length: tableCount }, (_, i) => pg18TableLine(i)).join("\n")}\n`;
  assert.equal(countPgRestoreTocItemLines(nonVerbose), 1144, "previous non-verbose listing misses the 4 REQ_SPECIAL/DATABASE lines");
  const miss = verifyPgRestoreListResult({ status: 0, stdout: nonVerbose });
  assert.equal(miss.ok, false);
  assert.equal(miss.authorizing, false);
  assert.match(miss.reason, /listed 1144 unique TOC items, declared 1148/);

  const compact = pg18VerboseList(2);
  assert.equal(countPgRestoreTocItemLines(compact), 6);
  assert.equal(verifyPgRestoreListResult({ status: 0, stdout: compact }).ok, true);
});

test("PostgreSQL 18.6 TOC completeness remains fail-closed", () => {
  const verbose = pg18VerboseList(2);
  const failClosed = (result, msg) => {
    assert.equal(result.ok, false, msg);
    assert.equal(result.authorizing, false, msg);
  };
  const missingOne = verbose.replace(/\n6; 1259 16385 TABLE public t_1 nesta_migrator\n/, "\n");
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: missingOne }), "genuine missing 1 entry");
  const truncatedLast = verbose.replace(
    "6; 1259 16385 TABLE public t_1 nesta_migrator",
    "6; 1259",
  );
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: truncatedLast }), "truncated last entry");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: verbose,
    stderr: "pg_restore: error: could not read from input file",
  }), "diagnostic + valid-looking TOC");
  const countForgedNoSpecials = `${pg18ListHeader(6)}${Array.from({ length: 6 }, (_, i) => pg18TableLine(i)).join("\n")}\n`;
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: countForgedNoSpecials }), "count match without REQ_SPECIAL/DATABASE");
});

test("verbose TOC parser rejects spoofed and malformed listings", () => {
  const failClosed = (result, msg) => {
    assert.equal(result.ok, false, msg);
    assert.equal(result.authorizing, false, msg);
    assert.equal(result.verified, false, msg);
  };
  const specials = [...PG18_SPECIAL_TOC];
  const t0 = "5; 1259 16384 TABLE public t_0 nesta_migrator";
  const t1 = "6; 1259 16385 TABLE public t_1 nesta_migrator";
  const valid = `${pg18ListHeader(6)}${[...specials, t0, t1].join("\n")}\n`;
  const pass = verifyPgRestoreListResult({ status: 0, stdout: valid });
  assert.equal(pass.ok, true);
  assert.equal(pass.uniqueDumpIds, 6);

  const dupId = `${pg18ListHeader(6)}${[...specials, t0, "6; 1259 16385 TABLE public t_dup nesta_migrator".replace("6;", "5;")].join("\n")}\n`;
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: dupId }), "duplicate dump ID");
  const dupSpecial = `${pg18ListHeader(6)}${["1; 0 0 ENCODING - ENCODING", "1; 0 0 STDSTRINGS - STDSTRINGS", "3; 0 0 SEARCHPATH - SEARCHPATH", "4; 1262 16384 DATABASE - railway postgres", t0, t1].join("\n")}\n`;
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: dupSpecial }), "duplicate special-entry dump ID");
  const garbage = `${pg18ListHeader(6)}${[...specials, "5; 0 0 GARBAGE - x y", "6; 0 0 GARBAGE - x y"].join("\n")}\n`;
  LEGACY_PERMISSIVE_TOC_ITEM_LINE.lastIndex = 0;
  assert.equal((garbage.match(LEGACY_PERMISSIVE_TOC_ITEM_LINE) || []).length, 6, "legacy regex accepted GARBAGE");
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: garbage }), "arbitrary GARBAGE descriptor");
  const numericSpoof = `${pg18ListHeader(6)}${[...specials, "5; 0 0 99 88 77", "6; 1 2 3 4 5"].join("\n")}\n`;
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: numericSpoof }), "numeric text matching old regex");
  const badOid = `${pg18ListHeader(6)}${[...specials, t0, "6; x 16385 TABLE public t_1 nesta_migrator"].join("\n")}\n`;
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: badOid }), "malformed OID fields");
  const noSemi = `${pg18ListHeader(6)}${[...specials, t0, "6 1259 16385 TABLE public t_1 nesta_migrator"].join("\n")}\n`;
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: noSemi }), "missing semicolon");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: valid.replace("6; 1259 16385 TABLE public t_1 nesta_migrator", "6; 1259"),
  }), "truncated final item");
  const dupOrdinary = `${pg18ListHeader(6)}${[...specials, t0, t0].join("\n")}\n`;
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: dupOrdinary }), "duplicate ordinary line");
  const replaced = `${pg18ListHeader(6)}${[...specials, t0, "6; 0 0 GARBAGE - x y"].join("\n")}\n`;
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: replaced }), "count-preserving malformed replacement");
  const fakeDesc = `${pg18ListHeader(6)}${[...specials, t0, "6; 1259 16385 TOCENTRY public t_1 nesta_migrator"].join("\n")}\n`;
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: fakeDesc }), "unknown fake descriptor");
  const uniqueSmaller = `${pg18ListHeader(6)}${[...specials, t0, t0].join("\n")}\n`;
  const parsedDup = parsePgRestoreVerboseToc(uniqueSmaller);
  assert.equal(parsedDup.uniqueDumpIds, 5);
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: uniqueSmaller }), "declared matches line count but unique IDs are smaller");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: valid,
    stderr: "pg_restore: fatal: could not find block",
  }), "diagnostics + valid-looking TOC");
  failClosed(verifyPgRestoreListResult({ status: 1, stdout: valid }), "nonzero");
  failClosed(verifyPgRestoreListResult({ status: -1, stdout: valid }), "-1");
  failClosed(verifyPgRestoreListResult({ status: 0, stdout: valid, signal: "SIGPIPE" }), "signal");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: valid,
    error: new Error("spawn failed"),
  }), "spawn error");
});

test("descriptor-specific TOC tails reject fabricated two-token garbage", () => {
  const failClosed = (result, msg) => {
    assert.equal(result.ok, false, msg);
    assert.equal(result.authorizing, false, msg);
  };
  const specials = [...PG18_SPECIAL_TOC];
  const t0 = "5; 1259 16384 TABLE public t_0 nesta_migrator";
  const t1 = "6; 1259 16385 TABLE public t_1 nesta_migrator";
  const listing = (items) => `${pg18ListHeader(items.length)}${items.join("\n")}\n`;
  const replaceAt = (index, line) => {
    const items = [...specials, t0, t1];
    items[index] = line;
    return listing(items);
  };
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: replaceAt(0, "1; 0 0 ENCODING 99 88"),
  }), "ENCODING 99 88");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: replaceAt(1, "2; 0 0 STDSTRINGS 99 88"),
  }), "STDSTRINGS 99 88");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: replaceAt(2, "3; 0 0 SEARCHPATH 99 88"),
  }), "SEARCHPATH 99 88");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: replaceAt(3, "4; 1262 16384 DATABASE 99 88"),
  }), "DATABASE 99 88");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: replaceAt(5, "6; 1259 16385 TABLE 99 88"),
  }), "TABLE 99 88");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: replaceAt(5, "6; 1259 16385 INDEX 99 88"),
  }), "INDEX 99 88");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: replaceAt(5, "6; 1259 16385 VIEW 99 88"),
  }), "recognized descriptor + two fake tokens");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: replaceAt(5, "6; 1259 16385 TABLE public"),
  }), "TABLE public missing name/owner");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: replaceAt(5, "6; 1259 16385 TABLE - -"),
  }), "TABLE too few fields");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: replaceAt(5, "6; 1259 16385 TABLE public t_1"),
  }), "missing owner where required");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: replaceAt(0, "1; 0 0 ENCODING - STDSTRINGS"),
  }), "malformed special entry");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing([...specials, t0, "6; 1259 16385 TABLE 99 88"]),
  }), "count-preserving replacement of real entry with fake recognized-descriptor entry");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: replaceAt(5, "6; 3079 24589 EXTENSION 99 88"),
  }), "EXTENSION without namespace placeholder");
});

test("DATABASE catalog IDs and DATABASE PROPERTIES nilCatalogId are source-backed", () => {
  const failClosed = (result, msg) => {
    assert.equal(result.ok, false, msg);
    assert.equal(result.authorizing, false, msg);
  };
  const pass = (stdout, msg) => {
    const result = verifyPgRestoreListResult({ status: 0, stdout });
    assert.equal(result.ok, true, msg);
    assert.equal(result.authorizing, true, msg);
  };
  assert.equal(PG_DATABASE_RELATION_ID, 1262);
  const listing = (items) => `${pg18ListHeader(items.length)}${items.join("\n")}\n`;
  const withDb = (dbLine, extra = []) => listing([
    "1; 0 0 ENCODING - ENCODING",
    "2; 0 0 STDSTRINGS - STDSTRINGS",
    "3; 0 0 SEARCHPATH - SEARCHPATH",
    dbLine,
    "5; 1259 16384 TABLE public t_0 nesta_migrator",
    ...extra,
  ]);
  pass(withDb("4; 1262 16384 DATABASE - railway postgres"), "legitimate DATABASE");
  pass(withDb("4; 1262 16384 DATABASE - my db nesta migrator"), "DATABASE name and owner containing spaces");
  pass(listing([
    "1; 0 0 ENCODING - ENCODING",
    "2; 0 0 STDSTRINGS - STDSTRINGS",
    "3; 0 0 SEARCHPATH - SEARCHPATH",
    "4; 1262 16384 DATABASE - railway postgres",
    "5; 0 0 DATABASE PROPERTIES - railway postgres",
    "6; 1259 16384 TABLE public t_0 nesta_migrator",
  ]), "legitimate DATABASE PROPERTIES 0 0");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: withDb("4; 0 16384 DATABASE - railway postgres"),
  }), "fabricated DATABASE tableoid=0 oid=nonzero");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: withDb("4; 1262 0 DATABASE - railway postgres"),
  }), "DATABASE object OID 0");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: withDb("4; 0 0 DATABASE - railway postgres"),
  }), "DATABASE nilCatalogId");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing([
      "1; 0 0 ENCODING - ENCODING",
      "2; 0 0 STDSTRINGS - STDSTRINGS",
      "3; 0 0 SEARCHPATH - SEARCHPATH",
      "4; 1262 16384 DATABASE - railway postgres",
      "5; 1262 16384 DATABASE PROPERTIES - railway postgres",
      "6; 1259 16384 TABLE public t_0 nesta_migrator",
    ]),
  }), "DATABASE PROPERTIES with pg_database catalog ID");
});

test("TOC identifier fields are not rejected by character content", () => {
  const listing = (items) => `${pg18ListHeader(items.length)}${items.join("\n")}\n`;
  const specials = [...PG18_SPECIAL_TOC];
  const pass = (line, msg) => {
    const stdout = listing([...specials, "5; 1259 16384 TABLE public t_0 nesta_migrator", line]);
    const result = verifyPgRestoreListResult({ status: 0, stdout });
    assert.equal(result.ok, true, msg);
    assert.equal(result.authorizing, true, msg);
  };
  pass("6; 1259 16385 TABLE 88 t_1 nesta_migrator", "numeric schema shape");
  pass("6; 1259 16385 TABLE public t_1 +", "punctuation-only owner shape");
  pass("6; 1259 16385 TABLE public my table nesta migrator", "names and owner containing spaces");
  pass("6; 1259 16385 TABLE public кафе nesta_migrator", "UTF-8 name");
});

test("verbose TOC parser accepts legitimate PostgreSQL 18 description forms", () => {
  const items = [
    ...PG18_SPECIAL_TOC,
    "5; 0 0 DATABASE PROPERTIES - railway postgres",
    "6; 3079 24589 EXTENSION - pgcrypto",
    "7; 1259 16384 TABLE public restaurants nesta_migrator",
    "8; 1259 16384 TABLE DATA public restaurants nesta_migrator",
    "9; 1255 16400 FUNCTION public foo(integer, text) nesta_migrator",
    "10; 2606 16410 CONSTRAINT public restaurants restaurants_pkey nesta_migrator",
    "11; 2606 16411 FK CONSTRAINT public orders orders_restaurant_id_fkey nesta_migrator",
    "12; 2606 16412 CHECK CONSTRAINT public employees employees_email_check nesta_migrator",
    "13; 1259 16420 SEQUENCE public orders_id_seq nesta_migrator",
    "14; 0 0 SEQUENCE SET public orders_id_seq nesta_migrator",
    "15; 1259 16430 INDEX public restaurants_legacy_rtdb_id_idx nesta_migrator",
    "16; 2615 2200 SCHEMA - public postgres",
    "17; 0 0 ACL - public postgres",
    "18; 0 0 COMMENT - SCHEMA public postgres",
    "19; 2612 16440 POLICY public restaurants_tenant nesta_migrator",
    "20; 0 0 ROW SECURITY public restaurants nesta_migrator",
    "21; 2279 16450 TRIGGER public restaurants restaurants_updated_at nesta_migrator",
    "22; 1247 16460 TYPE public order_status nesta_migrator",
    "23; 0 0 DEFAULT public restaurants id nesta_migrator",
    "24; 2605 16470 CAST - CAST (integer AS integer)",
    "25; 1259 16480 VIEW public open_orders nesta_migrator",
    "26; 0 0 STATISTICS DATA public restaurants_stats",
    "27; 1417 16490 OPERATOR public +(integer, integer) nesta_migrator",
    "28; 2210 16510 STATISTICS public restaurants_stats nesta_migrator",
  ];
  const stdout = `${pg18ListHeader(items.length)}${items.join("\n")}\n;\tdepends on: 4 6\n`;
  const parsed = parsePgRestoreVerboseToc(stdout);
  assert.equal(parsed.malformed.length, 0);
  assert.equal(parsed.unsupported.length, 0);
  assert.equal(parsed.duplicates.length, 0);
  assert.equal(parsed.uniqueDumpIds, items.length);
  const result = verifyPgRestoreListResult({ status: 0, stdout });
  assert.equal(result.ok, true);
  assert.equal(result.authorizing, true);
  assert.equal(result.tocEntries, items.length);
});

test("invented and non-ArchiveEntry descriptors are unsupported", () => {
  assert.equal(PG_DUMP_TOC_DESCRIPTIONS.includes("LARGE OBJECT"), false);
  assert.equal(PG_DUMP_TOC_DESCRIPTIONS.includes("LANGUAGE"), false);
  assert.equal(PG_DUMP_TOC_DESCRIPTIONS.includes("EXTENDED STATISTICS DATA"), false);
  assert.equal(PG_DUMP_TOC_DESCRIPTIONS.includes("PROPERTY GRAPH"), false);
  assert.equal(PG_DUMP_TOC_DESCRIPTIONS.includes("STATISTICS"), true);
  assert.equal(PG_DUMP_TOC_DESCRIPTIONS.includes("STATISTICS DATA"), true);
  const failClosed = (result, msg) => {
    assert.equal(result.ok, false, msg);
    assert.equal(result.authorizing, false, msg);
    assert.equal(result.unsupported > 0, true, msg);
  };
  const listing = (line) => `${pg18ListHeader(6)}${[...PG18_SPECIAL_TOC, "5; 1259 16384 TABLE public t_0 nesta_migrator", line].join("\n")}\n`;
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing("6; 1259 16385 TOCENTRY public t_1 nesta_migrator"),
  }), "invented descriptor");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing("6; 1259 16385 LARGE OBJECT public blob nesta_migrator"),
  }), "removed non-ArchiveEntry LARGE OBJECT");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing("6; 1259 16385 LANGUAGE - plpgsql postgres"),
  }), "removed non-ArchiveEntry LANGUAGE");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing("6; 0 0 EXTENDED STATISTICS DATA public restaurants_stats nesta_migrator"),
  }), "EXTENDED STATISTICS DATA is not a PostgreSQL 18 ArchiveEntry description");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing("6; 1259 16500 PROPERTY GRAPH public g nesta_migrator"),
  }), "PROPERTY GRAPH is not a PostgreSQL 18 ArchiveEntry description");
});

test("mandatory special TOC entries are required regardless of declared count", () => {
  const failClosed = (result, msg) => {
    assert.equal(result.ok, false, msg);
    assert.equal(result.authorizing, false, msg);
  };
  const listing = (declared, items) => `${pg18ListHeader(declared)}${items.join("\n")}\n`;
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing(1, ["221; 1259 16384 TABLE public restaurants nesta_migrator"]),
  }), "declared=1 valid TABLE only");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing(3, [
      "1; 0 0 ENCODING - ENCODING",
      "2; 0 0 STDSTRINGS - STDSTRINGS",
      "3; 0 0 SEARCHPATH - SEARCHPATH",
    ]),
  }), "declared=3 specials without DATABASE");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing(5, [
      "2; 0 0 STDSTRINGS - STDSTRINGS",
      "3; 0 0 SEARCHPATH - SEARCHPATH",
      "4; 1262 16384 DATABASE - railway postgres",
      "5; 1259 16384 TABLE public t_0 nesta_migrator",
      "6; 1259 16385 TABLE public t_1 nesta_migrator",
    ]),
  }), "missing ENCODING");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing(5, [
      "1; 0 0 ENCODING - ENCODING",
      "3; 0 0 SEARCHPATH - SEARCHPATH",
      "4; 1262 16384 DATABASE - railway postgres",
      "5; 1259 16384 TABLE public t_0 nesta_migrator",
      "6; 1259 16385 TABLE public t_1 nesta_migrator",
    ]),
  }), "missing STDSTRINGS");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing(5, [
      "1; 0 0 ENCODING - ENCODING",
      "2; 0 0 STDSTRINGS - STDSTRINGS",
      "4; 1262 16384 DATABASE - railway postgres",
      "5; 1259 16384 TABLE public t_0 nesta_migrator",
      "6; 1259 16385 TABLE public t_1 nesta_migrator",
    ]),
  }), "missing SEARCHPATH");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing(5, [
      "1; 0 0 ENCODING - ENCODING",
      "2; 0 0 STDSTRINGS - STDSTRINGS",
      "3; 0 0 SEARCHPATH - SEARCHPATH",
      "5; 1259 16384 TABLE public t_0 nesta_migrator",
      "6; 1259 16385 TABLE public t_1 nesta_migrator",
    ]),
  }), "missing DATABASE");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing(6, [
      "1; 0 0 ENCODING - ENCODING",
      "2; 0 0 ENCODING - ENCODING",
      "3; 0 0 STDSTRINGS - STDSTRINGS",
      "4; 0 0 SEARCHPATH - SEARCHPATH",
      "5; 1262 16384 DATABASE - railway postgres",
      "6; 1259 16384 TABLE public t_0 nesta_migrator",
    ]),
  }), "duplicate ENCODING");
  failClosed(verifyPgRestoreListResult({
    status: 0,
    stdout: listing(6, [
      "1; 0 0 ENCODING - ENCODING",
      "2; 0 0 STDSTRINGS - STDSTRINGS",
      "3; 0 0 SEARCHPATH - SEARCHPATH",
      "4; 1262 16384 DATABASE - railway postgres",
      "5; 1262 16385 DATABASE - other postgres",
      "6; 1259 16384 TABLE public t_0 nesta_migrator",
    ]),
  }), "duplicate DATABASE");
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

const here = path.dirname(fileURLToPath(import.meta.url));
const repoMigrations = loadRepoMigrations(path.join(here, "../migrations"));
const predecessor = predecessorVersion(repoMigrations, REQUIRED_SCHEMA_VERSION);
const tables0017 = [...expectedPublicTablesThrough(repoMigrations, predecessor)].sort();
const tables0018 = [...expectedPublicTablesThrough(repoMigrations, REQUIRED_SCHEMA_VERSION)].sort();
const history0017 = expectedHistoryThrough(repoMigrations, predecessor);
const history0018 = expectedHistoryThrough(repoMigrations, REQUIRED_SCHEMA_VERSION);
const okSnap = { loopback: false, providerClass: "PUBLIC MANAGED", database: "railway" };

function liveAtPredecessor(extra = {}) {
  return {
    currentDatabase: "railway",
    sslLive: "on",
    serverAddrClass: "*.*.*.*",
    publicTables: tables0017,
    restaurantsTableExists: true,
    restaurants: 0,
    fixtureLike: 0,
    schemaMigrationRows: history0017,
    latestMigration: { version: predecessor, name: history0017.at(-1).name },
    ...extra,
  };
}

function liveAtRequired(extra = {}) {
  return {
    currentDatabase: "railway",
    sslLive: "on",
    serverAddrClass: "*.*.*.*",
    publicTables: tables0018,
    restaurantsTableExists: true,
    restaurants: 0,
    fixtureLike: 0,
    schemaMigrationRows: history0018,
    latestMigration: { version: "0018", name: history0018.at(-1).name },
    ...extra,
  };
}

test("Step2D4 requires PRE-UPGRADE 0017, not current 0018", () => {
  assert.equal(STEP2D4_REQUIRED_BACKUP_SOURCE_CLASS, BACKUP_SOURCE_CLASS.PRE_UPGRADE);
  assert.equal(predecessor, "0017");
  assert.equal(REQUIRED_SCHEMA_VERSION, "0018");
  assert.equal(tables0017.length, 79);
  assert.equal(tables0018.length, 80);
  const src = readFileSync(path.join(here, "../scripts/step2d4-pg-backup-restore.mjs"), "utf8");
  assert.match(src, /PRE-0018 \/ PRE-UPGRADE/);
  assert.match(src, /evaluateBackupSourceContract/);
  assert.match(src, /evaluateRestoredSchemaContract/);
  assert.doesNotMatch(src, /latestMigration !== REQUIRED_SCHEMA_VERSION/);
  assert.doesNotMatch(src, /verified\.latestMigration === REQUIRED_SCHEMA_VERSION/);
  assert.doesNotMatch(src, /applyMissingMigrations/);
});

test("exact canonical 0017 source allows PRE-UPGRADE backup gate", () => {
  const r = evaluateBackupSourceContract({
    snap: okSnap,
    live: liveAtPredecessor(),
    repoMigrations,
  });
  assert.equal(r.ok, true);
  assert.equal(r.sourceClass, BACKUP_SOURCE_CLASS.PRE_UPGRADE);
  assert.equal(r.expectedVersion, "0017");
  assert.equal(r.mode, SCHEMA_APPLY_MODE.UPGRADE_FROM_PREDECESSOR);
  assert.match(r.artifactClass, /PRE-0018 \/ PRE-UPGRADE/);
});

test("restored exact canonical 0017 PASSes PRE-UPGRADE restore validation", () => {
  const r = evaluateRestoredSchemaContract({
    live: liveAtPredecessor(),
    repoMigrations,
    restoreExtras: {
      pgcrypto: true,
      missingRls: [],
      missingForce: [],
      requiredUniques: [{ table: "restaurants", cols: ["legacy_rtdb_id"], ok: true }],
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.expectedVersion, "0017");
  assert.equal(r.latest, "0017");
});

test("PRE-UPGRADE backup source FAILs closed on identity/catalog/history mismatches", () => {
  const fail = (args, pattern) => {
    const r = evaluateBackupSourceContract({
      snap: okSnap,
      repoMigrations,
      sourceClass: BACKUP_SOURCE_CLASS.PRE_UPGRADE,
      ...args,
    });
    assert.equal(r.ok, false, pattern);
    assert.match(r.reason, pattern);
  };
  fail({ live: liveAtPredecessor({ latestMigration: { version: "0016", name: "x" }, schemaMigrationRows: expectedHistoryThrough(repoMigrations, "0016"), publicTables: [...expectedPublicTablesThrough(repoMigrations, "0016")] }) }, /0016/);
  fail({ live: liveAtRequired() }, /already-current|PRE_UPGRADE_SOURCE|0018/);
  fail({
    live: liveAtPredecessor({
      schemaMigrationRows: history0017.map((row, i) => (i === 0 ? { ...row, checksum: "deadbeef" } : row)),
    }),
  }, /checksum/);
  fail({
    live: liveAtPredecessor({
      schemaMigrationRows: [...history0017, { version: "0099", name: "evil", checksum: "abc" }],
      latestMigration: { version: "0099", name: "evil" },
    }),
  }, /unknown\/out-of-band/);
  fail({
    live: liveAtPredecessor({
      schemaMigrationRows: history0017.filter((row) => row.version !== "0007"),
    }),
  }, /schema_migrations count/);
  fail({ live: liveAtPredecessor({ publicTables: [...tables0017, "not_a_nesta_table"] }) }, /not_a_nesta_table/);
  fail({ live: liveAtPredecessor({ publicTables: tables0017.slice(0, -1) }) }, /missing tables/);
  fail({ live: liveAtPredecessor({ publicTables: tables0018 }) }, /production_migration_attempts|already present/);
  fail({ live: liveAtPredecessor({ restaurants: 2 }) }, /restaurants=2/);
  fail({ live: liveAtPredecessor({ fixtureLike: 1 }) }, /rest_1999/);
  fail({ live: liveAtPredecessor({ sslLive: "off" }) }, /SSL live/);
  fail({ live: liveAtPredecessor({ currentDatabase: "postgres" }) }, /postgres/);
  fail({ snap: { ...okSnap, providerClass: "OTHER" }, live: liveAtPredecessor() }, /providerClass/);
  fail({ snap: { ...okSnap, loopback: true }, live: liveAtPredecessor() }, /loopback/);
});

test("PRE-UPGRADE restore FAILs if restored latest is 0018 or catalog is malformed", () => {
  const restored0018 = evaluateRestoredSchemaContract({
    live: liveAtRequired(),
    repoMigrations,
    restoreExtras: { pgcrypto: true, missingRls: [], missingForce: [], requiredUniques: [{ ok: true }] },
  });
  assert.equal(restored0018.ok, false);
  assert.match(restored0018.reason, /already-current|exact 0017|PRE_UPGRADE/);
  const malformed = evaluateRestoredSchemaContract({
    live: liveAtPredecessor({ publicTables: [...tables0017, "orphan_table"] }),
    repoMigrations,
  });
  assert.equal(malformed.ok, false);
  assert.match(malformed.reason, /orphan_table/);
});

test("POST_UPGRADE_SOURCE is distinct and does not authorize a 0017 pre-upgrade backup", () => {
  const pre = evaluateBackupSourceContract({
    snap: okSnap,
    live: liveAtPredecessor(),
    repoMigrations,
    sourceClass: BACKUP_SOURCE_CLASS.POST_UPGRADE,
  });
  assert.equal(pre.ok, false);
  const post = evaluateBackupSourceContract({
    snap: okSnap,
    live: liveAtRequired(),
    repoMigrations,
    sourceClass: BACKUP_SOURCE_CLASS.POST_UPGRADE,
  });
  assert.equal(post.ok, true);
  assert.equal(post.expectedVersion, "0018");
});
