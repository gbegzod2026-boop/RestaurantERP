// Step 2D.3 — Railway production PostgreSQL SCHEMA-ONLY identity + provision.
// Fresh empty railway DB, or in-place upgrade from exact predecessor 0017 to 0018.
// Never prints passwords, URLs, or secrets. Never imports Firebase.
// Never switches DATA_BACKEND. Does not run migrate-firebase.
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  FORBIDDEN_DB,
  MIGRATION_TARGET_DB,
  REQUIRED_SCHEMA_VERSION,
  isLoopbackHost,
} from "./lib/migrationTargetGuard.mjs";
import { withPgSsl, resolvePgSsl } from "../pgSsl.js";
import {
  isReadOnlyAction,
  isSchemaApplyAction,
  READ_ONLY_BEGIN_SQL,
  READ_ONLY_LOCAL_SQL,
  APPLY_WRITABLE_SQL,
  assertSchemaApplyInvariants,
  schemaOnlyAppPasswordReport,
  SCHEMA_APPLY_MODE,
  collectSchemaApplyLive,
  applyMissingMigrations,
  revalidateThenEnterWritable,
} from "./lib/schemaApplySession.mjs";
import { loadRepoMigrations } from "./lib/schemaMigrationCatalog.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, "../..");
const MIGRATIONS_DIR = path.join(__dirname, "../migrations");
const ACTION = process.argv[2] || "identify";

const SECRET_KEYS = /^(POSTGRES_URL|DATABASE_URL|POSTGRES_PASSWORD|PGPASSWORD|POSTGRES_APP_PASSWORD|DATABASE_PRIVATE_URL|DATABASE_PUBLIC_URL)$/i;

function hostClass(host) {
  const h = String(host || "").trim().toLowerCase();
  if (!h) return "(empty)";
  if (isLoopbackHost(h)) return h;
  if (h.endsWith(".rlwy.net") || h.endsWith(".railway.app") || h.endsWith(".railway.internal")) {
    return `*.${h.split(".").slice(-2).join(".")}`;
  }
  return h.replace(/^[^.]+/, "*");
}

function providerClass(host) {
  const h = String(host || "").trim().toLowerCase();
  if (isLoopbackHost(h)) return "LOOPBACK";
  if (h.endsWith(".rlwy.net") || h.endsWith(".railway.app") || h.endsWith(".railway.internal")) {
    return "PUBLIC MANAGED";
  }
  return "OTHER";
}

function parseUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || "5432",
      database: decodeURIComponent((u.pathname || "/").replace(/^\//, "") || ""),
      user: decodeURIComponent(u.username || ""),
      sslmode: u.searchParams.get("sslmode"),
    };
  } catch {
    return { host: "(unparseable)", port: "", database: "", user: "", sslmode: null };
  }
}

function partsFromEnv(env) {
  const urlKeys = ["POSTGRES_URL", "DATABASE_PUBLIC_URL", "DATABASE_URL"];
  const parsed = [];
  for (const key of urlKeys) {
    if (!env[key]) continue;
    const p = parseUrl(env[key]);
    if (p) parsed.push({ key, ...p });
  }
  const remote = parsed.find((p) => p.host && !isLoopbackHost(p.host));
  const chosen = remote || parsed[0];
  if (chosen) {
    return {
      host: chosen.host,
      port: chosen.port,
      database: chosen.database,
      user: chosen.user,
      sslmode: chosen.sslmode,
      urlKey: chosen.key,
    };
  }
  return {
    host: env.PGHOST || env.POSTGRES_HOST || "",
    port: String(env.PGPORT || env.POSTGRES_PORT || "5432"),
    database: env.PGDATABASE || env.POSTGRES_DB || "",
    user: env.PGUSER || env.POSTGRES_USER || "",
    sslmode: String(env.POSTGRES_SSL || "").toLowerCase() === "true" ? "require" : null,
    urlKey: null,
  };
}

function listedPgNames(env) {
  return Object.keys(env)
    .filter((k) => /^(POSTGRES_|PG|DATABASE_)/i.test(k) || /RAILWAY/i.test(k))
    .filter((k) => !SECRET_KEYS.test(k) && !/PASSWORD|SECRET|TOKEN|KEY|URL/i.test(k))
    .sort();
}

function secretNamesSet(env) {
  return Object.keys(env)
    .filter((k) => SECRET_KEYS.test(k) || /PASSWORD|SECRET|TOKEN/i.test(k) && /POSTGRES|PG|DATABASE|RAILWAY/i.test(k))
    .sort()
    .map((k) => k);
}

function snapshot(label, env) {
  const parts = partsFromEnv(env);
  return {
    label,
    pgRelatedNonSecretNames: listedPgNames(env),
    secretNamesPresent: secretNamesSet(env),
    hostClass: hostClass(parts.host),
    providerClass: providerClass(parts.host),
    port: parts.port,
    database: parts.database,
    userPresent: Boolean(parts.user),
    sslmode: parts.sslmode || null,
    urlKey: parts.urlKey || null,
    loopback: isLoopbackHost(parts.host),
    forbiddenName: FORBIDDEN_DB.has(parts.database) || parts.database === MIGRATION_TARGET_DB || parts.database === "postgres",
    tlsPlan: resolvePgSsl({ host: parts.host, env }).tlsMode,
  };
}

function loadDotenvFile() {
  const isolated = {};
  dotenv.config({ path: path.join(BACKEND, ".env"), processEnv: isolated, quiet: true });
  return isolated;
}

function chooseTarget(processSnap, fileSnap) {
  const processHas = processSnap.userPresent && processSnap.hostClass !== "(empty)";
  const fileHas = fileSnap.userPresent && fileSnap.hostClass !== "(empty)";
  if (processHas && !processSnap.loopback) {
    if (fileHas && !fileSnap.loopback && fileSnap.hostClass !== processSnap.hostClass) {
      return { ok: false, reason: "process env and .env disagree on remote host class — STOP" };
    }
    return { ok: true, source: "process.env", snap: processSnap };
  }
  if (processHas && processSnap.loopback) {
    if (fileHas && !fileSnap.loopback) {
      return { ok: false, reason: "process env is loopback; .env is remote — ambiguous, STOP" };
    }
    return { ok: false, reason: "process env target is loopback — refusing local PostgreSQL" };
  }
  if (fileHas && !fileSnap.loopback) {
    return { ok: true, source: "backend/.env", snap: fileSnap };
  }
  if (fileHas && fileSnap.loopback) {
    return { ok: false, reason: "only loopback PostgreSQL is configured — refusing local fixture" };
  }
  return { ok: false, reason: "no PostgreSQL target in process env or backend/.env" };
}

function clientConfig(source) {
  const env = source === "process.env" ? process.env : Object.assign({}, process.env, loadDotenvFile());
  const parts = partsFromEnv(env);
  const url = parts.urlKey ? env[parts.urlKey] : "";
  const base = url
    ? { connectionString: url, connectionTimeoutMillis: 20000 }
    : {
      host: env.PGHOST || env.POSTGRES_HOST,
      port: Number(env.PGPORT || env.POSTGRES_PORT || 5432),
      database: env.PGDATABASE || env.POSTGRES_DB,
      user: env.PGUSER || env.POSTGRES_USER,
      password: env.PGPASSWORD || env.POSTGRES_PASSWORD,
      connectionTimeoutMillis: 20000,
    };
  return withPgSsl(base, parts.host, env);
}

function loadMigrations() {
  return loadRepoMigrations(MIGRATIONS_DIR);
}

const TENANT_CATALOG_SQL = `
  SELECT c.relname AS table_name,
         c.relrowsecurity,
         c.relforcerowsecurity,
         EXISTS (
           SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid
              AND a.attname = 'restaurant_id'
              AND NOT a.attisdropped
              AND a.attnum > 0
         ) AS has_restaurant_id
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND (
       c.relname = 'restaurants'
       OR EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid
            AND a.attname = 'restaurant_id'
            AND NOT a.attisdropped
            AND a.attnum > 0
       )
       OR c.relname IN ('employee_credentials', 'payment_credentials', 'combo_items')
     )
   ORDER BY c.relname
`;

async function enterReadOnly(client) {
  await client.query(READ_ONLY_BEGIN_SQL);
  await client.query(READ_ONLY_LOCAL_SQL);
}

async function leaveReadOnly(client) {
  await client.query("ROLLBACK").catch(() => {});
}

async function enterSchemaApplyWritable(client) {
  for (const sql of APPLY_WRITABLE_SQL) {
    await client.query(sql);
  }
  const def = await client.query("SHOW default_transaction_read_only");
  const tx = await client.query("SHOW transaction_read_only");
  if (String(def.rows[0].default_transaction_read_only).toLowerCase() !== "off") {
    throw new Error("STOP: apply session default_transaction_read_only is not off");
  }
  if (String(tx.rows[0].transaction_read_only).toLowerCase() === "on") {
    throw new Error("STOP: apply session transaction_read_only is on");
  }
  return {
    default_transaction_read_only: def.rows[0].default_transaction_read_only,
    transaction_read_only: tx.rows[0].transaction_read_only,
  };
}

async function identifyLive(client) {
  await enterReadOnly(client);
  try {
    return await collectSchemaApplyLive(client);
  } finally {
    await leaveReadOnly(client);
  }
}

function unexpectedData(live) {
  if (live.restaurants && live.restaurants > 0) return `restaurants=${live.restaurants}`;
  if (live.fixtureLike && live.fixtureLike > 0) return `rest_1999*=${live.fixtureLike}`;
  return null;
}

async function applySchema(client) {
  return applyMissingMigrations(client, loadMigrations());
}

async function postVerify(client) {
  await client.query("SELECT set_config('app.current_restaurant_id', '', true)");
  const ext = await client.query("SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'");
  const roles = await client.query(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1)",
    [["nesta_app", "nesta_login_reader", "nesta_credential_revealer"]]
  );
  const catalog = await client.query(TENANT_CATALOG_SQL);
  const withRid = catalog.rows.filter((r) => r.has_restaurant_id);
  const missingRls = catalog.rows.filter((r) => r.relrowsecurity !== true).map((r) => r.table_name);
  const missingForce = catalog.rows.filter((r) => r.relforcerowsecurity !== true).map((r) => r.table_name);
  const restaurants = Number((await client.query("SELECT count(*)::int AS n FROM restaurants")).rows[0].n);
  const fixtureLike = Number((await client.query(
    "SELECT count(*)::int AS n FROM restaurants WHERE legacy_rtdb_id LIKE 'rest_1999%'"
  )).rows[0].n);
  const uniques = [];
  const specs = [
    { table: "restaurants", cols: ["legacy_rtdb_id"] },
    { table: "employees", cols: ["restaurant_id", "legacy_rtdb_id"] },
    { table: "orders", cols: ["restaurant_id", "legacy_rtdb_id"] },
    { table: "custom_roles", cols: ["restaurant_id", "legacy_rtdb_id"] },
  ];
  for (const spec of specs) {
    const found = await client.query(`
      SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relname = $1 AND i.indisunique
        AND (
          SELECT array_agg(a.attname::text ORDER BY x.ordinality)
          FROM unnest(i.indkey) WITH ORDINALITY AS x(attnum, ordinality)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
        ) = $2::text[]
    `, [spec.table, spec.cols]);
    uniques.push({ table: spec.table, cols: spec.cols, ok: found.rowCount > 0 });
  }
  const nameUnique = await client.query(`
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'custom_roles'::regclass AND conname = 'custom_roles_restaurant_id_name_key'
  `);
  const legacyUnique = await client.query(`
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'custom_roles'::regclass AND conname = 'uq_custom_roles_restaurant_legacy'
  `);
  const cols = await client.query(`
    SELECT
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='employees' AND column_name='extra') AS employees_extra,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='restaurant_modules' AND column_name='extra') AS modules_extra,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='restaurants' AND column_name='subscription') AS restaurants_subscription
  `);
  const pkCount = Number((await client.query(`
    SELECT count(*)::int AS n FROM pg_constraint
    WHERE contype = 'p' AND connamespace = 'public'::regnamespace
  `)).rows[0].n);
  const tenantFk = Number((await client.query(`
    SELECT count(*)::int AS n
    FROM pg_constraint
    WHERE contype = 'f' AND connamespace = 'public'::regnamespace
      AND confrelid = 'restaurants'::regclass
  `)).rows[0].n);
  const max = await client.query("SHOW max_connections");
  const ssl = await client.query("SHOW ssl");
  const activity = await client.query("SELECT count(*)::int AS n FROM pg_stat_activity");
  const size = await client.query("SELECT pg_size_pretty(pg_database_size(current_database())) AS size");
  const ver = await client.query("SHOW server_version");
  const latest = await client.query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1");
  const maxConn = Number(max.rows[0].max_connections);
  return {
    pgcrypto: ext.rowCount > 0,
    rolesPresent: roles.rows.map((r) => r.rolname).sort(),
    tenantCatalog: {
      full: catalog.rows.length,
      restaurantIdSubset: withRid.length,
      rls: catalog.rows.filter((r) => r.relrowsecurity).length,
      forceRls: catalog.rows.filter((r) => r.relforcerowsecurity).length,
      missingRls,
      missingForce,
    },
    restaurants,
    fixtureLike,
    requiredUniques: uniques,
    customRolesNameUniqueDropped: nameUnique.rowCount === 0,
    customRolesLegacyUnique: legacyUnique.rowCount > 0,
    step2cColumns: cols.rows[0],
    primaryKeys: pkCount,
    fksToRestaurants: tenantFk,
    maxConnections: maxConn,
    currentConnections: Number(activity.rows[0].n),
    sslLive: ssl.rows[0].ssl,
    serverVersion: ver.rows[0].server_version,
    databaseSize: size.rows[0].size,
    latestMigration: latest.rows[0]?.version || null,
    recommendedPoolMax: Math.max(5, Math.min(10, Math.floor((maxConn - 5 - 2) / 1))),
  };
}

async function main() {
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  delete process.env.NESTA_REQUIRE_ISOLATED_AUTH;
  const processSnap = snapshot("process.env", process.env);
  const fileSnap = snapshot("backend/.env", loadDotenvFile());
  const choice = chooseTarget(processSnap, fileSnap);
  const report = {
    action: ACTION,
    processEnv: processSnap,
    dotenvFile: fileSnap,
    choice,
  };
  if (!choice.ok) {
    console.log(JSON.stringify({ ...report, verdict: "STOP", firebaseWrites: 0, dataMigrated: false, dataBackendSwitched: false }, null, 2));
    process.exit(2);
  }
  if (choice.snap.forbiddenName && choice.snap.loopback) {
    console.log(JSON.stringify({ ...report, verdict: "STOP", reason: "forbidden local database name" }, null, 2));
    process.exit(2);
  }

  const envForClient = choice.source === "process.env"
    ? process.env
    : Object.assign({}, process.env, loadDotenvFile());
  const resolved = clientConfig(choice.source);
  report.tls = {
    tlsMode: resolved.tlsMode,
    certificateVerification: resolved.certificateVerification,
    sslEnabled: Boolean(resolved.config.ssl),
    nodeTlsRejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED || "(unset)",
  };
  const c = new pg.Client(resolved.config);
  await c.connect();
  let identifyOpen = true;
  try {
    if (ACTION === "tls-probe") {
      await enterReadOnly(c);
      try {
        const row = (await c.query(`
          SELECT current_database() AS current_database,
                 current_user AS current_user,
                 version() AS version,
                 current_setting('ssl') AS ssl,
                 current_setting('transaction_read_only') AS transaction_read_only
        `)).rows[0];
        report.minimal = {
          currentDatabase: row.current_database,
          currentUser: row.current_user,
          serverVersion: String(row.version).split(",")[0],
          sslLive: row.ssl,
          transactionReadOnly: row.transaction_read_only,
        };
        report.readOnly = isReadOnlyAction(ACTION);
        report.verdict = String(row.ssl).toLowerCase() === "on" ? "TLS_OK" : "TLS_FAIL";
        report.firebaseWrites = 0;
        report.dataMigrated = false;
        report.dataBackendSwitched = false;
        console.log(JSON.stringify(report, null, 2));
        if (report.verdict !== "TLS_OK") process.exit(1);
        return;
      } finally {
        await leaveReadOnly(c);
      }
    }
    const live = await identifyLive(c);
    report.readOnlyIdentify = isReadOnlyAction("identify");
    report.live = {
      currentUser: live.currentUser,
      currentDatabase: live.currentDatabase,
      sslLive: live.sslLive,
      serverVersion: live.serverVersion,
      serverAddrClass: live.serverAddrClass,
      tableCount: live.publicTables.length,
      publicTables: live.publicTables,
      restaurantsTableExists: live.restaurantsTableExists,
      restaurants: live.restaurants,
      fixtureLike: live.fixtureLike,
      schemaMigrations: live.schemaMigrations,
      latestMigration: live.latestMigration,
      schemaMigrationRowCount: live.schemaMigrationRows.length,
    };
    if (choice.snap.loopback || live.serverAddrClass === "loopback") {
      report.verdict = "STOP";
      report.reason = "connected server is loopback";
      console.log(JSON.stringify(report, null, 2));
      process.exit(2);
    }
    if (live.currentDatabase === MIGRATION_TARGET_DB || live.currentDatabase === "nesta_migration_dryrun") {
      report.verdict = "STOP";
      report.reason = "refusing nesta_migration_dryrun";
      console.log(JSON.stringify(report, null, 2));
      process.exit(2);
    }
    const bad = unexpectedData(live);
    if (bad) {
      report.verdict = "STOP";
      report.reason = `unexpected application data: ${bad}`;
      console.log(JSON.stringify(report, null, 2));
      process.exit(2);
    }
    if (ACTION === "identify") {
      report.verdict = "IDENTITY_OK";
      report.next = "re-run with action=apply for schema-only fresh provision or in-place upgrade from the exact predecessor to the required version";
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (!isSchemaApplyAction(ACTION)) {
      throw new Error(`unknown action ${ACTION}`);
    }
    const repoMigrations = loadMigrations();
    let decision;
    try {
      decision = assertSchemaApplyInvariants({ snap: choice.snap, live, repoMigrations });
    } catch (err) {
      report.verdict = "STOP";
      report.reason = err.message;
      console.log(JSON.stringify(report, null, 2));
      process.exit(2);
    }
    report.schemaApply = {
      mode: decision.mode,
      predecessor: decision.predecessor,
      requiredVersion: decision.requiredVersion,
      writableOpened: decision.allowWritable === true,
    };
    const pwd = schemaOnlyAppPasswordReport(envForClient);
    const appPassword = {
      attempted: pwd.attempted,
      rotated: false,
      credentialMutations: pwd.credentialMutations,
      reason: pwd.reason,
    };

    async function finishVerify(client, { migrations, writableOpened, verdictIfOk }) {
      report.migrations = migrations;
      report.appPassword = appPassword;
      report.verify = await postVerify(client);
      report.firebaseWrites = 0;
      report.dataMigrated = false;
      report.dataBackendSwitched = false;
      report.applySession = {
        ...(report.applySession || {}),
        dedicatedConnection: writableOpened,
        schemaOnly: true,
        writableOpened,
      };
      const v = report.verify;
      const ok = v.latestMigration === REQUIRED_SCHEMA_VERSION
        && v.pgcrypto
        && v.rolesPresent.includes("nesta_app")
        && v.rolesPresent.includes("nesta_login_reader")
        && v.rolesPresent.includes("nesta_credential_revealer")
        && v.tenantCatalog.missingRls.length === 0
        && v.tenantCatalog.missingForce.length === 0
        && v.restaurants === 0
        && v.fixtureLike === 0
        && v.requiredUniques.every((u) => u.ok)
        && v.customRolesLegacyUnique
        && v.customRolesNameUniqueDropped
        && String(v.sslLive).toLowerCase() === "on";
      report.verdict = ok ? verdictIfOk : "PARTIAL";
      console.log(JSON.stringify(report, null, 2));
      if (!ok) process.exit(1);
    }

    if (decision.mode === SCHEMA_APPLY_MODE.ALREADY_CURRENT) {
      await finishVerify(c, {
        migrations: repoMigrations.map((m) => ({
          version: m.version,
          name: m.name,
          status: "already-applied",
        })),
        writableOpened: false,
        verdictIfOk: "ALREADY_CURRENT",
      });
      return;
    }

    await c.end();
    identifyOpen = false;
    const applyClient = new pg.Client(resolved.config);
    await applyClient.connect();
    try {
      const writable = await revalidateThenEnterWritable({
        client: applyClient,
        snap: choice.snap,
        previousLive: live,
        previousDecision: decision,
        repoMigrations,
        identifyLiveImpl: identifyLive,
        enterWritableImpl: enterSchemaApplyWritable,
      });
      report.applySession = { ...writable, dedicatedConnection: true, schemaOnly: true, writableOpened: true };
      const applied = await applySchema(applyClient);
      const newlyApplied = applied.some((m) => m.status === "applied");
      await finishVerify(applyClient, {
        migrations: applied,
        writableOpened: true,
        verdictIfOk: newlyApplied ? "PASS" : "ALREADY_CURRENT",
      });
    } finally {
      await applyClient.end();
    }
    return;
  } finally {
    if (identifyOpen) await c.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error("STEP2D3 FAILED:", err.message);
  process.exit(1);
});
