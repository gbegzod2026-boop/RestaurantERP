// Step 2D — inspect configured PostgreSQL WITHOUT applying migrations or data.
// Loopback-only. Never prints passwords, URLs, or secrets.
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  MIGRATION_TARGET_DB,
  readLocalPgParts,
  pgClientConfig,
  isLoopbackHost,
} from "./lib/migrationTargetGuard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (/:59999\b/.test(process.env.POSTGRES_URL || "")) delete process.env.POSTGRES_URL;
dotenv.config({ path: path.join(__dirname, "../../.env"), quiet: true });

function hostClass(host) {
  const h = String(host || "").trim().toLowerCase();
  if (!h) return "(empty)";
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return h;
  return h.replace(/^[^.]+/, "*");
}

async function inspectDb(client, database) {
  const out = { database, error: null };
  try {
    const ext = (await client.query(
      `SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto') ORDER BY 1`
    )).rows.map((r) => r.extname);
    out.extensions = ext;
    const mig = await client.query(
      `SELECT version, name FROM schema_migrations ORDER BY version`
    ).catch(() => ({ rows: [] }));
    out.schemaMigrations = mig.rows.map((r) => `${r.version}:${r.name}`);
    out.latestMigration = mig.rows.length ? mig.rows[mig.rows.length - 1] : null;
    await client.query("SELECT set_config('app.current_restaurant_id', '', true)").catch(() => {});
    const tables = ["restaurants", "employees", "orders", "payments", "custom_roles"];
    out.counts = {};
    for (const t of tables) {
      try {
        out.counts[t] = Number((await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
      } catch {
        out.counts[t] = null;
      }
    }
    try {
      out.fixtureLikeRestaurants = Number((await client.query(
        "SELECT count(*)::int AS n FROM restaurants WHERE legacy_rtdb_id LIKE 'rest_1999%'"
      )).rows[0].n);
    } catch {
      out.fixtureLikeRestaurants = null;
    }
    const rls = await client.query(`
      SELECT c.relname AS table,
             c.relrowsecurity AS rls,
             c.relforcerowsecurity AS force_rls
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname IN ('restaurants','employees','orders','order_items','payments','custom_roles')
      ORDER BY 1
    `).catch(() => ({ rows: [] }));
    out.rls = rls.rows;
    const roles = await client.query(`
      SELECT rolname FROM pg_roles
      WHERE rolname IN ('nesta_app','nesta_login_reader','nesta_credential_revealer','postgres')
      ORDER BY 1
    `);
    out.rolesPresent = roles.rows.map((r) => r.rolname);
    const size = await client.query(`
      SELECT pg_size_pretty(pg_database_size(current_database())) AS size
    `);
    out.databaseSize = size.rows[0].size;
    const poolHint = process.env.POSTGRES_POOL_MAX || "(unset, code default)";
    out.configuredPoolMaxEnv = poolHint;
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

async function main() {
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  delete process.env.NESTA_REQUIRE_ISOLATED_AUTH;
  const parts = readLocalPgParts();
  const loopback = isLoopbackHost(parts.host);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: "inspect-only-no-writes",
    configured: {
      hostClass: hostClass(parts.host),
      port: parts.port || "5432",
      envDatabase: parts.database || "(empty)",
      userPresent: Boolean(parts.user),
      loopback,
    },
    productionTarget: loopback ? "NOT PROVISIONED" : "REMOTE_HOST_PRESENT",
    verdict: null,
    databases: [],
    inspections: {},
    provisioningRequirements: [],
  };

  if (!parts.host || !parts.user) {
    report.verdict = "NOT PROVISIONED";
    report.productionTarget = "NOT PROVISIONED";
    report.provisioningRequirements = [
      "Provision a dedicated production PostgreSQL instance (not loopback Step 1 fixture, not nesta_migration_dryrun).",
      "Create empty database (suggested name: nesta_prod) owned by a migration role.",
      "Create runtime role nesta_app with RLS; do not use superuser for the app pool.",
      "Apply schema migrations 0001–0017 on the empty database before data load.",
      "Set POSTGRES_SSL=true on managed hosts.",
      "Size: local dry-run of this dataset is small; provision ≥20 GB SSD and connection limit ≥50 to start.",
      "Do not reuse database name postgres (Step 1 fixture) or nesta_migration_dryrun.",
    ];
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (!loopback) {
    report.verdict = "BLOCKED";
    report.note = "Configured host is not loopback. Step 2D will not open a remote production session from this preflight without explicit approval.";
    report.provisioningRequirements = [
      "Confirm the remote host/database identity in a reviewed change window.",
      "Then re-run inspect-only checks: schema_migrations through 0017, restaurants=0, no rest_1999*, FORCE RLS, nesta_app grants.",
    ];
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const admin = new pg.Client(pgClientConfig(parts));
  await admin.connect();
  try {
    const dbs = await admin.query(
      `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY 1`
    );
    report.databases = dbs.rows.map((r) => r.datname);
    const disk = await admin.query(`
      SELECT pg_size_pretty(sum(pg_database_size(datname))::bigint) AS cluster_size
      FROM pg_database
    `);
    report.clusterSize = disk.rows[0].cluster_size;
  } finally {
    await admin.end();
  }

  for (const name of report.databases.filter((n) => ["postgres", MIGRATION_TARGET_DB, "nesta_app", "nesta_prod"].includes(n))) {
    const c = new pg.Client(pgClientConfig(parts, name));
    await c.connect();
    try {
      report.inspections[name] = await inspectDb(c, name);
    } finally {
      await c.end();
    }
  }

  const dry = report.inspections[MIGRATION_TARGET_DB];
  if (dry && !dry.error) {
    const c = new pg.Client(pgClientConfig(parts, MIGRATION_TARGET_DB));
    await c.connect();
    try {
      await c.query("SELECT set_config('app.current_restaurant_id', '', true)");
      dry.businessReview = {
        unnamedRestaurants: (await c.query(`
          SELECT legacy_rtdb_id, name, domain, status
          FROM restaurants WHERE status = 'migration_review' ORDER BY 1
        `)).rows,
        emptyRoleEmployees: (await c.query(`
          SELECT r.legacy_rtdb_id AS restaurant, e.legacy_rtdb_id AS user_id, e.role, e.active
          FROM employees e JOIN restaurants r ON r.id = e.restaurant_id
          WHERE e.role = 'migration_pending' ORDER BY 1, 2
        `)).rows,
        pushIdRoleEmployees: (await c.query(`
          SELECT r.legacy_rtdb_id AS restaurant, e.legacy_rtdb_id AS user_id, e.role, e.active,
                 cr.legacy_rtdb_id AS custom_role_legacy, cr.name AS custom_role_name
          FROM employees e
          JOIN restaurants r ON r.id = e.restaurant_id
          LEFT JOIN custom_roles cr ON cr.id = e.custom_role_id
          WHERE e.role ~ '^-[A-Za-z0-9_-]{18,19}$'
        `)).rows,
        inconsistentOrders: (await c.query(`
          SELECT r.legacy_rtdb_id AS restaurant, o.legacy_rtdb_id AS order_id, o.total::text AS header_total,
                 o.extra->'financial_reconciliation'->>'remaining' AS remaining,
                 o.extra->'financial_reconciliation'->>'remainder_kind' AS remainder_kind
          FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
          WHERE o.extra->'financial_reconciliation'->>'remainder_kind' = 'LEGACY_INCONSISTENCY'
        `)).rows,
        unresolvedWaiterOrders: Number((await c.query(`
          SELECT count(*)::int AS n FROM orders
          WHERE waiter_id IS NULL AND extra ? 'unresolved_waiter_id'
        `)).rows[0].n),
      };
    } finally {
      await c.end();
    }
  }
  const fixture = report.inspections.postgres;
  report.localFindings = {
    dedicatedDryRunExists: Boolean(dry),
    dryRunLatestMigration: dry?.latestMigration || null,
    dryRunRestaurants: dry?.counts?.restaurants ?? null,
    fixtureRestaurants: fixture?.counts?.restaurants ?? null,
    fixtureLikeInFixture: fixture?.fixtureLikeRestaurants ?? null,
    fixtureLikeInDryRun: dry?.fixtureLikeRestaurants ?? null,
  };
  report.verdict = "NOT PROVISIONED";
  report.productionTarget = "NOT PROVISIONED";
  report.reason = "Configured PostgreSQL is loopback. nesta_migration_dryrun is the Step 2 local target only. Production database is not present in this cluster's known names.";
  report.provisioningRequirements = [
    "Create a new empty production database (not postgres, not nesta_migration_dryrun).",
    "Apply migrations 0001_wave0_core through 0017_step2c_p1 with the same checksums as this working tree.",
    "Confirm pgcrypto, FORCE RLS on tenant tables, roles nesta_app / nesta_login_reader / nesta_credential_revealer.",
    "Set nesta_app password via db:set-app-password; never embed it in SQL.",
    "App pool connects as nesta_app (POSTGRES_POOL_MAX known; default 10 in .env.example — raise for cutover).",
    "Pre-load restaurant count must be 0 and rest_1999* count must be 0.",
    "Take a verified empty-schema dump before --apply.",
    "Do not point production DATA_BACKEND at this loopback cluster.",
  ];
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("STEP2D PG PRECHECK FAILED:", err.message);
  process.exit(1);
});
