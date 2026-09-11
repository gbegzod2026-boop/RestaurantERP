import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import pg from "pg";
import {
  isLoopbackHost,
} from "../scripts/lib/migrationTargetGuard.mjs";
import { loadRepoMigrations } from "../scripts/lib/schemaMigrationCatalog.mjs";
import { applyMissingMigrations } from "../scripts/lib/schemaApplySession.mjs";
import { exampleLiveTargetFingerprint } from "../scripts/lib/pgTargetFingerprint.mjs";
import {
  applyCredentialCopy,
  CREDENTIAL_ACTOR_ROLE,
  CREDENTIAL_INSERT_SQL,
  GATE_ERROR,
  PROTECTED_CONTENT_FINGERPRINT_SQL,
  publicErrorCode,
  SESSION_PROTECTED_FINGERPRINT_SQL,
  SET_ACTOR_ROLE_SQL,
  SET_ROLE_APP_SQL,
  SET_TENANT_SQL,
} from "../scripts/lib/productionCredentialGate.mjs";
import {
  ACCEPTANCE_ERROR,
  AcceptanceTargetError,
  acceptanceDisposition,
  connectOnlyAfterLoopbackAccepted,
  inspectPgTargetFromEnv,
  loopbackClientConfig,
  requireDbEnabled,
} from "../scripts/lib/credentialAcceptanceTarget.mjs";
import { runLocalCredentialRolePreflight } from "../scripts/lib/credentialRolePreflight.mjs";
import { hashPassword, isHashed } from "../../security/password.js";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "../../.env"), quiet: true });

const rlsSrc = readFileSync(fileURLToPath(import.meta.url), "utf8");
const gateSrc = readFileSync(path.join(here, "../scripts/lib/productionCredentialGate.mjs"), "utf8");
const policySrc = readFileSync(path.join(here, "../migrations/0012_employee_credentials_actor_rls.up.sql"), "utf8");
const localPreflightSrc = readFileSync(path.join(here, "../scripts/local-credential-role-preflight.mjs"), "utf8");
const FINGERPRINT = exampleLiveTargetFingerprint();
const OTHER_FINGERPRINT = "ab".repeat(32);

test("credential gate keeps 0012 actor RLS and does not introduce privilege bypass", () => {
  assert.match(policySrc, /app\.current_employee_role[\s\S]*?'owner'[\s\S]*?'admin'/);
  assert.match(policySrc, /ALTER TABLE employee_credentials FORCE ROW LEVEL SECURITY/);
  assert.doesNotMatch(policySrc, /BYPASSRLS|DISABLE ROW LEVEL SECURITY|GRANT\s+ALL/i);
  assert.match(gateSrc, /SET LOCAL ROLE nesta_app/);
  assert.match(gateSrc, /SET LOCAL ROLE nesta_login_reader/);
  assert.match(gateSrc, /SET LOCAL ROLE NONE/);
  assert.match(gateSrc, /app\.current_employee_role/);
  assert.doesNotMatch(gateSrc, /BYPASSRLS|DISABLE ROW LEVEL SECURITY|GRANT\s+ALL|SET ROLE postgres/i);
});

test("acceptance inspects the configured target before any pool or dbAvailable helper", () => {
  assert.doesNotMatch(rlsSrc, /from ["']\.\/_dbAvailable\.mjs["']/);
  assert.doesNotMatch(rlsSrc, /from ["']\.\.\/postgres\.js["']/);
  assert.match(rlsSrc, /inspectPgTargetFromEnv/);
  assert.match(rlsSrc, /connectOnlyAfterLoopbackAccepted/);
  assert.match(rlsSrc, /CREATE DATABASE/);
  assert.match(rlsSrc, /DROP DATABASE/);
  assert.match(localPreflightSrc, /refuseRemotePgTarget/);
  const inspectIdx = localPreflightSrc.indexOf("inspectPgTargetFromEnv");
  const connectIdx = localPreflightSrc.indexOf("admin.connect");
  assert.ok(inspectIdx >= 0 && inspectIdx < connectIdx);
});

test("remote configured URL is refused before the connection helper is invoked", () => {
  let invoked = 0;
  assert.throws(
    () => connectOnlyAfterLoopbackAccepted(
      { POSTGRES_URL: "postgres://u@db.example.invalid:5432/railway" },
      () => {
        invoked += 1;
        return "connected";
      },
    ),
    (err) => err instanceof AcceptanceTargetError && err.code === ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED,
  );
  assert.equal(invoked, 0);
  invoked = 0;
  assert.throws(
    () => connectOnlyAfterLoopbackAccepted(
      { POSTGRES_URL: "postgres://u@127.0.0.1/railway?host=db.example.invalid" },
      () => {
        invoked += 1;
        return "connected";
      },
    ),
    (err) => err instanceof AcceptanceTargetError && err.code === ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED,
  );
  assert.equal(invoked, 0);
});

function mockFb(tree) {
  return {
    async shallowKeys(p) {
      if (p === "credentials") return Object.keys(tree);
      const one = /^credentials\/([^/]+)$/.exec(p);
      if (one) return Object.keys(tree[one[1]] || {});
      return [];
    },
    async getValue(p) {
      const leaf = /^credentials\/([^/]+)\/([^/]+)$/.exec(p);
      if (!leaf) return null;
      return tree[leaf[1]]?.[leaf[2]] ?? null;
    },
  };
}

function snapshotFp(client) {
  return Promise.all([
    client.query(PROTECTED_CONTENT_FINGERPRINT_SQL),
    client.query(SESSION_PROTECTED_FINGERPRINT_SQL),
  ]).then(([protectedRows, sessionRows]) => JSON.stringify({
    protected: protectedRows.rows[0],
    session: sessionRows.rows[0],
  }));
}

const requireDb = requireDbEnabled();
const target = inspectPgTargetFromEnv();

if (target.remote) {
  test("configured PostgreSQL target is remote and must not be contacted", () => {
    throw new AcceptanceTargetError(ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED);
  });
} else if (!target.configured) {
  const d = acceptanceDisposition({ target, requireDb });
  if (d.action === "fail") {
    test("REQUIRE_DB=1 requires a loopback PostgreSQL target", () => {
      throw new AcceptanceTargetError(ACCEPTANCE_ERROR.PG_NOT_CONFIGURED);
    });
  } else {
    test("production-credentials-rls live acceptance NOT VERIFIED", {
      skip: "PostgreSQL is not configured; live RLS/apply/fingerprint acceptance NOT VERIFIED",
    }, () => {});
  }
} else {
  test("disposable loopback DB: fingerprint SQL, negative RLS, role preflight, applyCredentialCopy", async (t) => {
    const adminCfg = loopbackClientConfig();
    if (!isLoopbackHost(adminCfg.host) && !String(adminCfg.host || "").startsWith("/")) {
      throw new AcceptanceTargetError(ACCEPTANCE_ERROR.REMOTE_TARGET_REFUSED);
    }
    const dbName = `nesta_cred_gate_${Date.now()}`;
    const admin = new pg.Client(adminCfg);
    let created = false;
    let cleanupError = null;
    try {
      await admin.connect();
    } catch {
      const d = acceptanceDisposition({ target, requireDb, connected: false });
      if (d.action === "skip") {
        t.skip("local PostgreSQL unreachable; live acceptance NOT VERIFIED");
        return;
      }
      throw new AcceptanceTargetError(ACCEPTANCE_ERROR.LOOPBACK_CONNECT_FAILED);
    }
    try {
      try {
        await admin.query(`CREATE DATABASE ${dbName}`);
        created = true;
      } catch {
        const d = acceptanceDisposition({ target, requireDb, createdDb: false });
        if (d.action === "skip") {
          t.skip("local CREATE DATABASE unavailable; live acceptance NOT VERIFIED");
          return;
        }
        throw new AcceptanceTargetError(ACCEPTANCE_ERROR.DISPOSABLE_DB_FAILED);
      }

      const client = new pg.Client(loopbackClientConfig(process.env, dbName));
      try {
        await client.connect();
        const repo = loadRepoMigrations(path.join(here, "../migrations"));
        await applyMissingMigrations(client, repo);
        await client.query("SELECT set_config('app.current_restaurant_id', '', false)");
        await client.query("SELECT set_config('app.current_employee_role', '', false)");

        const restaurantId = (await client.query(
          `INSERT INTO restaurants (domain, name, legacy_rtdb_id)
           VALUES ('cred-disp.local', 'Disposable', 'rest_disp') RETURNING id`,
        )).rows[0].id;
        const roleId = (await client.query(
          `INSERT INTO custom_roles (restaurant_id, name, modules, actions, legacy_rtdb_id)
           VALUES ($1, 'Crew', '[]'::jsonb, '[]'::jsonb, 'role_disp') RETURNING id`,
          [restaurantId],
        )).rows[0].id;
        const employeeId = (await client.query(
          `INSERT INTO employees (restaurant_id, legacy_rtdb_id, name, login, role, custom_role_id, modules, actions, active)
           VALUES ($1, 'waiter_disp', 'Waiter', 'waiter_disp', 'waiter', $2, '[]'::jsonb, '[]'::jsonb, true) RETURNING id`,
          [restaurantId, roleId],
        )).rows[0].id;
        const otherEmployeeId = (await client.query(
          `INSERT INTO employees (restaurant_id, legacy_rtdb_id, name, login, role, active)
           VALUES ($1, 'waiter_other', 'Other', 'waiter_other', 'waiter', true) RETURNING id`,
          [restaurantId],
        )).rows[0].id;
        const adminTargetId = (await client.query(
          `INSERT INTO employees (restaurant_id, legacy_rtdb_id, name, login, role, active)
           VALUES ($1, 'waiter_admin_target', 'Waiter A', 'cred_gate_a', 'waiter', true) RETURNING id`,
          [restaurantId],
        )).rows[0].id;
        const waiterTargetId = (await client.query(
          `INSERT INTO employees (restaurant_id, legacy_rtdb_id, name, login, role, active)
           VALUES ($1, 'waiter_rls_target', 'Waiter B', 'cred_gate_b', 'waiter', true) RETURNING id`,
          [restaurantId],
        )).rows[0].id;
        const platformUserId = (await client.query(
          `INSERT INTO platform_users (email, display_name, role, permissions, status)
           VALUES ('pf@example.invalid', 'PF', 'support', '{}'::jsonb, 'active') RETURNING id`,
        )).rows[0].id;
        const orderId = (await client.query(
          `INSERT INTO orders (restaurant_id, order_type, waiter_id, status, total)
           VALUES ($1, 'dine_in', $2, 'order_created', 0) RETURNING id`,
          [restaurantId, employeeId],
        )).rows[0].id;
        await client.query(
          `INSERT INTO production_migration_attempts (
             attempt_id, target_fingerprint, candidate_commit, reviewed_tag,
             cutover_window_identity, firebase_project, freeze_generated_at, freeze_identity,
             phase, status, transition_epoch, started_at, updated_at
           ) VALUES (
             gen_random_uuid(), $1, 'deadbeef', 'reviewed',
             'window', 'restoran-30d51', now(), $1,
             'full-after-wave1', 'FULL_COMPLETE', 0, now(), now()
           )`,
          [FINGERPRINT],
        );

        let beforeMutations;
        await client.query("BEGIN");
        try {
          beforeMutations = await snapshotFp(client);
          let previous = beforeMutations;
          await client.query("UPDATE employees SET login = 'login_mut' WHERE id = $1", [employeeId]);
          let next = await snapshotFp(client);
          assert.notEqual(next, previous, "employee login update must change fingerprint SQL");
          previous = next;

          await client.query("UPDATE employees SET custom_role_id = NULL WHERE id = $1", [employeeId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "employee custom_role_id update must change fingerprint SQL");
          previous = next;

          await client.query("UPDATE employees SET modules = '{\"pos\":true}'::jsonb, actions = '{\"edit\":true}'::jsonb WHERE id = $1", [employeeId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "employee modules/actions update must change fingerprint SQL");
          previous = next;

          await client.query("UPDATE custom_roles SET actions = '{\"manage\":true}'::jsonb WHERE id = $1", [roleId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "custom role actions update must change fingerprint SQL");
          previous = next;

          await client.query(
            `INSERT INTO role_overrides (restaurant_id, base_role, modules, actions)
             VALUES ($1, 'waiter', '{}'::jsonb, '{}'::jsonb)`,
            [restaurantId],
          );
          previous = await snapshotFp(client);
          await client.query("UPDATE role_overrides SET actions = '{\"override\":true}'::jsonb WHERE restaurant_id = $1 AND base_role = 'waiter'", [restaurantId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "role_overrides permission field update must change fingerprint SQL");
          previous = next;

          await client.query(
            `INSERT INTO restaurant_modules (restaurant_id, enabled_modules, extra)
             VALUES ($1, ARRAY['pos'], '{}'::jsonb)`,
            [restaurantId],
          );
          previous = await snapshotFp(client);
          await client.query("UPDATE restaurant_modules SET enabled_modules = ARRAY['pos','kds'] WHERE restaurant_id = $1", [restaurantId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "restaurant_modules enabled/state update must change fingerprint SQL");
          previous = next;

          await client.query("UPDATE platform_users SET permissions = '{\"all\":true}'::jsonb WHERE id = $1", [platformUserId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "platform user permissions update must change fingerprint SQL");
          previous = next;

          await client.query("UPDATE orders SET waiter_id = $1 WHERE id = $2", [otherEmployeeId, orderId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "relationship-column update must change fingerprint SQL");
          previous = next;

          await client.query(
            `INSERT INTO order_items (order_id, restaurant_id, name_snapshot, price_snapshot, qty, line_total, modifiers, extras)
             VALUES ($1, $2, '{}'::jsonb, 0, 1, 0, '[]'::jsonb, '[]'::jsonb)`,
            [orderId, restaurantId],
          );
          previous = await snapshotFp(client);
          await client.query("UPDATE order_items SET modifiers = '[{\"n\":1}]'::jsonb WHERE order_id = $1", [orderId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "order_items.modifiers update must change fingerprint SQL");
          previous = next;
          await client.query("UPDATE order_items SET extras = '[{\"n\":1}]'::jsonb WHERE order_id = $1", [orderId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "order_items.extras update must change fingerprint SQL");
          previous = next;
          await client.query("UPDATE order_items SET variant_snapshot = '{\"v\":1}'::jsonb WHERE order_id = $1", [orderId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "order_items.variant_snapshot update must change fingerprint SQL");
          previous = next;

          await client.query(
            `INSERT INTO courier_assignments (restaurant_id, order_id, status)
             VALUES ($1, $2, 'assigned')`,
            [restaurantId, orderId],
          );
          previous = await snapshotFp(client);
          await client.query("UPDATE courier_assignments SET status = 'accepted' WHERE order_id = $1", [orderId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "courier_assignments status update must change fingerprint SQL");
          previous = next;

          await client.query(
            `INSERT INTO order_change_requests (restaurant_id, order_id, legacy_order_id, request_type, payload)
             VALUES ($1, $2, 'ord_bind_1', 'other', '{"orderId":"ord_bind_1"}'::jsonb)`,
            [restaurantId, orderId],
          );
          previous = await snapshotFp(client);
          await client.query("UPDATE order_change_requests SET legacy_order_id = 'ord_bind_2' WHERE order_id = $1", [orderId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "order_change_requests order binding update must change fingerprint SQL");
          previous = next;
          await client.query("UPDATE order_change_requests SET payload = '{\"orderId\":\"ord_bind_3\"}'::jsonb WHERE order_id = $1", [orderId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "order_change_requests payload binding update must change fingerprint SQL");
          previous = next;

          const tableId = (await client.query(
            `INSERT INTO tables (restaurant_id, number, legacy_rtdb_id)
             VALUES ($1, 7, 'table_disp') RETURNING id`,
            [restaurantId],
          )).rows[0].id;
          await client.query(
            `INSERT INTO waiter_calls (restaurant_id, table_id, legacy_table_key, extra)
             VALUES ($1, $2, 'table_disp', '{}'::jsonb)`,
            [restaurantId, tableId],
          );
          previous = await snapshotFp(client);
          await client.query("UPDATE waiter_calls SET legacy_table_key = 'table_disp_2' WHERE restaurant_id = $1", [restaurantId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "waiter_calls legacy_table_key update must change fingerprint SQL");
          previous = next;
          await client.query("UPDATE waiter_calls SET extra = '{\"table\":\"table_disp_3\"}'::jsonb WHERE restaurant_id = $1", [restaurantId]);
          next = await snapshotFp(client);
          assert.notEqual(next, previous, "waiter_calls extra/table binding update must change fingerprint SQL");
          previous = next;

          await client.query("UPDATE employees SET modules = NULL WHERE id = $1", [employeeId]);
          const nullFp = await snapshotFp(client);
          await client.query("UPDATE employees SET modules = '\"\"'::jsonb WHERE id = $1", [employeeId]);
          const emptyFp = await snapshotFp(client);
          assert.notEqual(nullFp, emptyFp, "NULL and empty string must not hash identically");

          await client.query("UPDATE employees SET name = $1, login = 'left' WHERE id = $2", [`a${String.fromCharCode(31)}b`, employeeId]);
          const delimA = await snapshotFp(client);
          await client.query("UPDATE employees SET name = 'a', login = $1 WHERE id = $2", [`b`, employeeId]);
          const delimB = await snapshotFp(client);
          assert.notEqual(delimA, delimB, "delimiter-like values must not collide under canonical JSON");

          await client.query("UPDATE schema_migrations SET checksum = 'deadbeef' WHERE version = '0001'");
          next = await snapshotFp(client);
          assert.notEqual(next, delimB, "schema checksum change must change session fingerprint");

          await client.query(
            `INSERT INTO production_migration_attempts (
               attempt_id, target_fingerprint, candidate_commit, reviewed_tag,
               cutover_window_identity, firebase_project, freeze_generated_at, freeze_identity,
               phase, status, transition_epoch, started_at, updated_at
             ) VALUES (
               gen_random_uuid(), $1, 'deadbeef', 'reviewed',
               'window-mut', 'restoran-30d51', now(), $1,
               'wave1-initial', 'AUTHORIZED', 0, now(), now()
             )`,
            [OTHER_FINGERPRINT],
          );
          const attemptFp = await snapshotFp(client);
          assert.notEqual(attemptFp, next, "attempt fingerprint/binding change must change session fingerprint");
        } finally {
          await client.query("ROLLBACK");
        }
        assert.equal(await snapshotFp(client), beforeMutations, "rollback restores original digest");

        const passwordHash = await hashPassword("4826");
        const localPf = await runLocalCredentialRolePreflight(client, {
          restaurantId,
          adminEmployeeId: adminTargetId,
          waiterEmployeeId: waiterTargetId,
          passwordHash,
        });
        assert.equal(localPf.ok, true);
        assert.equal(localPf.checks.waiterDenied42501, true);
        assert.equal(localPf.checks.employeeCredentialsForceRls, true);

        await client.query("BEGIN");
        try {
          await client.query(SET_ROLE_APP_SQL);
          await client.query(SET_ACTOR_ROLE_SQL, [CREDENTIAL_ACTOR_ROLE]);
          await client.query(SET_TENANT_SQL, [restaurantId]);
          await client.query(CREDENTIAL_INSERT_SQL, [adminTargetId, passwordHash, null]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        }

        let denied;
        await client.query("BEGIN");
        try {
          await client.query(SET_ROLE_APP_SQL);
          await client.query(SET_ACTOR_ROLE_SQL, ["waiter"]);
          await client.query(SET_TENANT_SQL, [restaurantId]);
          await client.query(CREDENTIAL_INSERT_SQL, [waiterTargetId, passwordHash, null]);
          await client.query("COMMIT");
        } catch (err) {
          denied = err;
          await client.query("ROLLBACK").catch(() => {});
        }
        assert.ok(denied, "waiter INSERT must fail");
        assert.equal(denied.code, "42501");
        assert.notEqual(denied.code, "23505");
        const waiterRows = await client.query(
          "SELECT employee_id FROM employee_credentials WHERE employee_id = $1",
          [waiterTargetId],
        );
        assert.equal(waiterRows.rows.length, 0);

        const fb = mockFb({ rest_disp: { waiter_disp: { password: passwordHash } } });
        const originalQuery = client.query.bind(client);
        let injected = 0;
        client.query = async (sql, params) => {
          const result = await originalQuery(sql, params);
          if (String(sql).startsWith("INSERT INTO employee_credentials") && injected === 0) {
            injected += 1;
            await originalQuery("UPDATE employees SET login = login || '-mut' WHERE id = $1", [employeeId]);
          }
          return result;
        };
        await assert.rejects(
          () => applyCredentialCopy({ client, fb, liveFingerprint: FINGERPRINT }),
          (err) => publicErrorCode(err) === GATE_ERROR.RECONCILIATION_FAILED,
        );
        client.query = originalQuery;
        const rolled = await client.query(
          "SELECT employee_id FROM employee_credentials WHERE employee_id = $1",
          [employeeId],
        );
        assert.equal(rolled.rows.length, 0);
        assert.ok(injected > 0);

        const report = await applyCredentialCopy({ client, fb, liveFingerprint: FINGERPRINT });
        assert.equal(report.applied.inserted, 1);
        const stored = (await client.query(
          "SELECT password_hash FROM employee_credentials WHERE employee_id = $1",
          [employeeId],
        )).rows[0];
        assert.equal(isHashed(stored.password_hash), true);
        const replay = await applyCredentialCopy({ client, fb, liveFingerprint: FINGERPRINT });
        assert.equal(replay.applied.inserted, 0);
        assert.equal(replay.applied.unchanged, 1);
      } finally {
        await client.end().catch((err) => {
          cleanupError = err;
        });
      }
    } finally {
      if (created) {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [dbName],
        ).catch(() => {});
        try {
          await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
        } catch (err) {
          cleanupError = err;
        }
      }
      await admin.end().catch((err) => {
        cleanupError = err;
      });
    }
    if (cleanupError) {
      throw new AcceptanceTargetError(ACCEPTANCE_ERROR.ACCEPTANCE_CLEANUP_FAILED);
    }
  });
}
