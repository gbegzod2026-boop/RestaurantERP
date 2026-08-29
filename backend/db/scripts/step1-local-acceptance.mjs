#!/usr/bin/env node
// Disposable PostgreSQL-only acceptance data for Step 1 Remediation Round 2.
// This script never imports Firebase modules and refuses every non-loopback
// PostgreSQL host. It is not a migration and must never be used as production
// seed data.
import { closePool, withPlatformContext, withTenantContext } from "../postgres.js";
import { upsertEmployeeCredential } from "../../pg/credentialService.js";

const ENABLE_FLAG = "NESTA_LOCAL_ACCEPTANCE";
const REQUIRED_MIGRATION = "0012";
const FIXTURES = [
  {
    legacyId: "rest_1999000000001",
    domain: "step1-round2-a.localhost",
    name: "[LOCAL ACCEPTANCE] Tenant A",
    login: "step1_admin_a",
    passwordEnv: "NESTA_ACCEPTANCE_ADMIN_A_PASSWORD",
    staffPinEnv: "NESTA_ACCEPTANCE_STAFF_A_PIN",
    chefPinEnv: "NESTA_ACCEPTANCE_CHEF_A_PIN",
    cashierPinEnv: "NESTA_ACCEPTANCE_CASHIER_A_PIN",
  },
  {
    legacyId: "rest_1999000000002",
    domain: "step1-round2-b.localhost",
    name: "[LOCAL ACCEPTANCE] Tenant B",
    login: "step1_admin_b",
    passwordEnv: "NESTA_ACCEPTANCE_ADMIN_B_PASSWORD",
    staffPinEnv: "NESTA_ACCEPTANCE_STAFF_B_PIN",
    chefPinEnv: "NESTA_ACCEPTANCE_CHEF_B_PIN",
    cashierPinEnv: "NESTA_ACCEPTANCE_CASHIER_B_PIN",
  },
];

class FixtureError extends Error {}

function configuredHost() {
  const connectionString = String(process.env.POSTGRES_URL || "").trim();
  if (connectionString) {
    try {
      return new URL(connectionString).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    } catch {
      throw new FixtureError("POSTGRES_URL is not a valid URL");
    }
  }
  return String(process.env.POSTGRES_HOST || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
}

function assertLocalSafety() {
  if (process.env[ENABLE_FLAG] !== "1") {
    throw new FixtureError(`${ENABLE_FLAG}=1 is required for this disposable fixture`);
  }
  const host = configuredHost();
  const octets = host.split(".");
  const isIpv4Loopback = octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255) &&
    Number(octets[0]) === 127;
  const isLoopback = host === "localhost" || host === "::1" || isIpv4Loopback;
  if (!isLoopback) {
    throw new FixtureError("refusing acceptance fixture: PostgreSQL host is not loopback");
  }
}

function readSecret(name, { pin = false } = {}) {
  const value = String(process.env[name] || "");
  if (!value) throw new FixtureError(`${name} is required for seed`);
  if (pin && !/^\d{4}$/.test(value)) throw new FixtureError(`${name} must contain exactly four digits`);
  if (!pin && value.length < 12) throw new FixtureError(`${name} must contain at least 12 characters`);
  return value;
}

async function assertSchemaReady() {
  await withPlatformContext(async (client) => {
    const { rows } = await client.query(
      `SELECT
         to_regclass('public.restaurants') IS NOT NULL AS restaurants,
         to_regclass('public.restaurant_settings') IS NOT NULL AS settings,
         to_regclass('public.employee_credentials') IS NOT NULL AS credentials,
         to_regclass('public.inventory_items') IS NOT NULL AS inventory,
         to_regclass('public.realtime_events') IS NOT NULL AS realtime`,
    );
    if (!rows[0]?.restaurants || !rows[0]?.settings || !rows[0]?.credentials ||
        !rows[0]?.inventory || !rows[0]?.realtime) {
      throw new FixtureError(`PostgreSQL schema is not ready; apply migrations through ${REQUIRED_MIGRATION}`);
    }
  });
}

async function assertNoForeignCollisions(client) {
  const ids = FIXTURES.map((fixture) => fixture.legacyId);
  const { rows } = await client.query(
    `SELECT legacy_rtdb_id, domain, name
       FROM restaurants
      WHERE legacy_rtdb_id = ANY($1::text[])`,
    [ids]
  );
  for (const row of rows) {
    const fixture = FIXTURES.find((item) => item.legacyId === row.legacy_rtdb_id);
    if (!fixture || row.domain !== fixture.domain || row.name !== fixture.name) {
      throw new FixtureError(`fixture id collision for ${row.legacy_rtdb_id}; refusing to alter existing data`);
    }
  }
}

async function upsertRestaurants() {
  return withPlatformContext(async (client) => {
    await assertNoForeignCollisions(client);
    const rows = [];
    for (const fixture of FIXTURES) {
      const result = await client.query(
        `INSERT INTO restaurants (legacy_rtdb_id, domain, name, status, business_type, info)
         VALUES ($1, $2, $3, 'active', 'acceptance_fixture',
                 '{"localOnly":true,"fixture":"step1-remediation-round2"}'::jsonb)
         ON CONFLICT (legacy_rtdb_id) DO UPDATE SET
           status = 'active',
           business_type = EXCLUDED.business_type,
           info = EXCLUDED.info
         RETURNING id`,
        [fixture.legacyId, fixture.domain, fixture.name]
      );
      rows.push({ ...fixture, id: result.rows[0].id });
    }
    return rows;
  });
}

async function seedTenant(fixture) {
  const adminPassword = readSecret(fixture.passwordEnv);
  const staffPin = readSecret(fixture.staffPinEnv, { pin: true });
  const chefPin = readSecret(fixture.chefPinEnv, { pin: true });
  const cashierPin = readSecret(fixture.cashierPinEnv, { pin: true });
  let fixtureStage = "tenant settings";
  try {
  await withTenantContext(fixture.id, async (client) => {
    fixtureStage = "tenant settings";
    await client.query(
      `INSERT INTO restaurant_settings (restaurant_id, settings)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (restaurant_id) DO UPDATE SET settings = EXCLUDED.settings`,
      [fixture.id, JSON.stringify({
        restaurantName: fixture.name,
        currency: "UZS",
        language: "uz",
        receipt: { enabled: true },
        fixture: "step1-remediation-round2",
      })]
    );
    fixtureStage = "tenant modules";
    await client.query(
      `INSERT INTO restaurant_modules (restaurant_id, enabled_modules)
       VALUES ($1, $2::text[])
       ON CONFLICT (restaurant_id) DO UPDATE SET enabled_modules = EXCLUDED.enabled_modules`,
      [fixture.id, ["dashboard", "staff", "menu", "tables", "warehouse", "notifications"]]
    );
    fixtureStage = "role overrides";
    await client.query(
      `INSERT INTO role_overrides (restaurant_id, base_role, modules, actions)
       VALUES
         ($1, 'admin', $2::jsonb, '["view","edit","delete"]'::jsonb),
         ($1, 'waiter', '["menu","tables","orders"]'::jsonb, '["view"]'::jsonb)
       ON CONFLICT (restaurant_id, base_role) DO UPDATE SET
         modules = EXCLUDED.modules, actions = EXCLUDED.actions`,
      [fixture.id, JSON.stringify(["dashboard", "staff", "menu", "tables", "warehouse", "notifications"])]
    );

    const employees = [
      ["admin_1", "Local Acceptance Admin", fixture.login, "admin", true, ["dashboard", "staff", "menu", "tables", "warehouse", "notifications"], ["view", "edit", "delete"], {}],
      ["waiter_1", "Local Acceptance Waiter", `${fixture.login}_waiter`, "waiter", true, ["menu", "tables", "orders"], ["view"], {}],
      ["chef_1", "Local Acceptance Chef", `${fixture.login}_chef`, "chef", true, ["dashboard", "orders", "notifications"], ["view", "edit"], {}],
      ["cashier_1", "Local Acceptance Cashier", `${fixture.login}_cashier`, "cashier", true, ["dashboard", "orders", "kassa"], ["view", "edit"], {}],
      ["blocked_1", "Local Acceptance Blocked", `${fixture.login}_blocked`, "waiter", false, ["menu", "tables", "orders"], ["view"], { blocked: true, blockedReason: "acceptance fixture" }],
    ];
    const employeeIds = new Map();
    fixtureStage = "employees";
    for (const [legacyId, name, login, role, active, modules, actions, extra] of employees) {
      const { rows } = await client.query(
        `INSERT INTO employees
           (legacy_rtdb_id, restaurant_id, name, login, role, active, modules, actions, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)
         ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
           name = EXCLUDED.name, login = EXCLUDED.login, role = EXCLUDED.role,
           active = EXCLUDED.active, modules = EXCLUDED.modules,
           actions = EXCLUDED.actions, extra = EXCLUDED.extra
         RETURNING id`,
        [legacyId, fixture.id, name, login, role, active, JSON.stringify(modules), JSON.stringify(actions), JSON.stringify(extra)]
      );
      employeeIds.set(legacyId, rows[0].id);
    }
    fixtureStage = "employee credentials";
    await upsertEmployeeCredential(client, { employeeId: employeeIds.get("admin_1"), pin: adminPassword });
    await upsertEmployeeCredential(client, { employeeId: employeeIds.get("waiter_1"), pin: staffPin });
    await upsertEmployeeCredential(client, { employeeId: employeeIds.get("chef_1"), pin: chefPin });
    await upsertEmployeeCredential(client, { employeeId: employeeIds.get("cashier_1"), pin: cashierPin });

    fixtureStage = "tables";
    await client.query(
      `INSERT INTO tables
         (legacy_rtdb_id, restaurant_id, number, table_type, capacity, active, status, extra)
       VALUES
         ('table_1',$1,1,'oddiy',4,true,'free','{"fixture":true}'::jsonb),
         ('table_2',$1,2,'oddiy',2,true,'free','{"fixture":true}'::jsonb)
       ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
         number = EXCLUDED.number, capacity = EXCLUDED.capacity, active = true,
         status = EXCLUDED.status, extra = EXCLUDED.extra`,
      [fixture.id]
    );
    fixtureStage = "menu categories";
    await client.query(
      `INSERT INTO menu_categories
         (legacy_rtdb_id, restaurant_id, name, sort_order, extra)
       VALUES ('fixture_category',$1,'{"uz":"Test taomlar","ru":"Тестовые блюда","en":"Test dishes"}'::jsonb,1,'{"fixture":true}'::jsonb)
       ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
         name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, extra = EXCLUDED.extra`,
      [fixture.id]
    );
    fixtureStage = "menu items";
    await client.query(
      `INSERT INTO menu_items
         (legacy_rtdb_id, restaurant_id, name, price, active, extra)
       VALUES ('fixture_item',$1,'{"uz":"Test osh","ru":"Тестовый плов","en":"Test pilaf"}'::jsonb,25000,true,
               '{"category":"fixture_category","fixture":true,"modifierIds":["mod_cheese"]}'::jsonb)
       ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
         name = EXCLUDED.name, price = EXCLUDED.price, active = true, extra = EXCLUDED.extra`,
      [fixture.id]
    );
    fixtureStage = "modifiers";
    await client.query(
      `INSERT INTO modifiers
         (legacy_rtdb_id, restaurant_id, name, price_delta, active, extra)
       VALUES
         ('mod_cheese',$1,'{"uz":"Pishloq","en":"Cheese"}'::jsonb,2000,true,'{"fixture":true}'::jsonb),
         ('mod_unrelated',$1,'{"uz":"Begona","en":"Unrelated"}'::jsonb,1000,true,'{"fixture":true}'::jsonb)
       ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
         name = EXCLUDED.name, price_delta = EXCLUDED.price_delta, active = true, extra = EXCLUDED.extra`,
      [fixture.id]
    );
    fixtureStage = "inventory";
    await client.query(
      `INSERT INTO inventory_items
         (legacy_rtdb_id, restaurant_id, name, category, unit, stock, min_stock, price, tracked_as, extra)
       VALUES ('fixture_stock',$1,'Acceptance rice','food','kg',10,2,18000,'both','{"fixture":true}'::jsonb)
       ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
         name = EXCLUDED.name, stock = EXCLUDED.stock, min_stock = EXCLUDED.min_stock,
         price = EXCLUDED.price, tracked_as = EXCLUDED.tracked_as, extra = EXCLUDED.extra`,
      [fixture.id]
    );
    fixtureStage = "notifications";
    await client.query(
      `INSERT INTO notifications_log
         (legacy_rtdb_id, restaurant_id, channel, recipient, subject, body, status, payload)
       VALUES ('fixture_notice',$1,'in_app','admin','Local acceptance','Fixture ready','unread','{"fixture":true}'::jsonb)
       ON CONFLICT (restaurant_id, legacy_rtdb_id) DO UPDATE SET
         subject = EXCLUDED.subject, body = EXCLUDED.body, status = EXCLUDED.status,
         payload = EXCLUDED.payload`,
      [fixture.id]
    );
    fixtureStage = "realtime";
    await client.query(
      `INSERT INTO realtime_events (restaurant_id, seq, event_type, payload)
       VALUES ($1, 1, 'path_changed', $2::jsonb)
       ON CONFLICT (restaurant_id, seq) DO UPDATE SET
         event_type = EXCLUDED.event_type, payload = EXCLUDED.payload`,
      [fixture.id, JSON.stringify({ path: `restaurants/${fixture.legacyId}/settings`, fixture: true })]
    );
  }, { actingRole: "admin" });
  } catch (error) {
    error.fixtureStage = fixtureStage;
    throw error;
  }
}

async function seed() {
  for (const fixture of FIXTURES) {
    readSecret(fixture.passwordEnv);
    readSecret(fixture.staffPinEnv, { pin: true });
    readSecret(fixture.chefPinEnv, { pin: true });
    readSecret(fixture.cashierPinEnv, { pin: true });
  }
  await assertSchemaReady();
  const restaurants = await upsertRestaurants();
  for (const restaurant of restaurants) await seedTenant(restaurant);
  console.log("Local PostgreSQL acceptance fixture is ready.");
  for (const fixture of FIXTURES) {
    console.log(`- ${fixture.legacyId}: manager login ${fixture.login}; password from ${fixture.passwordEnv}; staff PIN from ${fixture.staffPinEnv}`);
  }
  console.log("No Firebase service, user, claim, or RTDB data was read or changed.");
}

async function cleanup() {
  await assertSchemaReady();
  const deleted = await withPlatformContext(async (client) => {
    await assertNoForeignCollisions(client);
    const ids = FIXTURES.map((fixture) => fixture.legacyId);
    const domains = FIXTURES.map((fixture) => fixture.domain);
    const { rowCount } = await client.query(
      `DELETE FROM restaurants
        WHERE legacy_rtdb_id = ANY($1::text[])
          AND domain = ANY($2::text[])
          AND info->>'fixture' = 'step1-remediation-round2'`,
      [ids, domains]
    );
    return rowCount;
  });
  console.log(`Removed ${deleted} local PostgreSQL acceptance tenant(s) and cascading fixture rows.`);
  console.log("No Firebase service, user, claim, or RTDB data was read or changed.");
}

async function status() {
  await assertSchemaReady();
  const rows = await withPlatformContext(async (client) => (
    await client.query(
      `SELECT legacy_rtdb_id,
              (info->>'fixture' = 'step1-remediation-round2') AS owned_fixture
         FROM restaurants
        WHERE legacy_rtdb_id = ANY($1::text[])
        ORDER BY legacy_rtdb_id`,
      [FIXTURES.map((fixture) => fixture.legacyId)]
    )
  ).rows);
  for (const fixture of FIXTURES) {
    const row = rows.find((item) => item.legacy_rtdb_id === fixture.legacyId);
    console.log(`${fixture.legacyId}: ${row?.owned_fixture ? "READY" : row ? "COLLISION" : "ABSENT"}`);
  }
}

const action = process.argv[2];
if (!new Set(["seed", "cleanup", "status"]).has(action)) {
  console.error("Usage: node db/scripts/step1-local-acceptance.mjs <seed|cleanup|status>");
  process.exit(2);
}

try {
  assertLocalSafety();
  await ({ seed, cleanup, status })[action]();
} catch (error) {
  const stage = error?.fixtureStage ? ` at ${error.fixtureStage}` : "";
  const object = error?.column ? ` column=${error.column}` : (error?.table ? ` table=${error.table}` : "");
  const detail = error instanceof FixtureError ? error.message : `failed${stage} (${error?.code || "UNKNOWN"}${object})`;
  console.error(`[step1-local-acceptance] ${detail}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
