import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rtdbUpdate } from "../../pg/pathRouter.js";
import { classifyStaffMutationFailure, createStaffMutationAuthority } from "../../staffMutationAuthority.js";
import { preparePgStaffCreate, preparePgStaffPatch } from "../../staffPayload.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(path.resolve(here, "../../server.js"), "utf8");

function routeBlock(start, end) {
  const from = serverSource.indexOf(start);
  const to = serverSource.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing route marker: ${start}`);
  assert.notEqual(to, -1, `missing route end marker: ${end}`);
  return serverSource.slice(from, to);
}

test("PostgreSQL staff create branches before every RTDB staff or credential access", () => {
  const block = routeBlock('app.post("/api/staff"', 'app.patch("/api/staff/:id"');
  const pgBranch = block.indexOf("if (usePostgres())");
  assert.ok(pgBranch >= 0);
  for (const call of ["systemGet(", "systemSet(", "systemUpdate(", "systemRemove("]) {
    const position = block.indexOf(call);
    if (position >= 0) assert.ok(position > pgBranch, `${call} must stay after the PostgreSQL return branch`);
  }
  assert.match(block, /upsertEmployeeCredential\(client/);
  assert.doesNotMatch(block.slice(0, pgBranch), /system(?:Get|Set|Update|Remove)\(/);
  assert.doesNotMatch(block.slice(pgBranch, block.indexOf("const usersSnap")), /auditFromReq\(/);
});

test("PostgreSQL staff delete branches before RTDB and deletes employee in its tenant transaction", () => {
  const block = routeBlock('app.delete("/api/staff/:id"', '// ── Staff credential');
  const pgBranch = block.indexOf("if (usePostgres())");
  const firstRtdb = block.search(/system(?:Get|Set|Update|Remove)\(/);
  assert.ok(pgBranch >= 0 && firstRtdb > pgBranch);
  assert.match(block, /upsertEmployee\(client, ctx, staffId, null, events\)/);
  assert.doesNotMatch(block.slice(pgBranch, firstRtdb), /auditFromReq\(/);
});

test("Firebase staff create path remains isolated from PostgreSQL calls", () => {
  const block = routeBlock('app.post("/api/staff"', 'app.patch("/api/staff/:id"');
  const pgBranch = block.indexOf("if (usePostgres())");
  const firebasePath = block.slice(block.indexOf("const usersSnap", pgBranch));
  assert.match(firebasePath, /systemSet\(`\$\{basePath\(restId\)\}\/users\/\$\{staffId\}`/);
  assert.match(firebasePath, /systemSet\(`credentials\/\$\{restId\}\/\$\{staffId\}`/);
  assert.doesNotMatch(firebasePath, /pgCatalog\.|EmployeeCredential\(/);
});

test("PostgreSQL staff PATCH merges employee and credential in one tenant callback", () => {
  const block = routeBlock('app.patch("/api/staff/:id"', 'app.delete("/api/staff/:id"');
  const pgBranch = block.indexOf("if (usePostgres())");
  const firebasePath = block.indexOf("const userPath", pgBranch);
  assert.ok(pgBranch >= 0 && firebasePath > pgBranch);
  const postgresPath = block.slice(pgBranch, firebasePath);
  assert.match(postgresPath, /patchEmployee\(client, ctx, staffId, employeePatch, events\)/);
  assert.match(postgresPath, /upsertEmployeeCredential\(client/);
  assert.doesNotMatch(postgresPath, /system(?:Get|Set|Update|Remove)\(|auditFromReq\(/);
});

test("PostgreSQL credential routes return before every RTDB credential access", () => {
  const postBlock = routeBlock('app.post("/api/staff/:id/credential"', 'app.get("/api/staff/:id/credential"');
  const postPg = postBlock.indexOf("if (usePostgres())");
  assert.ok(postPg >= 0);
  assert.ok(postBlock.indexOf("systemGet(") > postPg);
  assert.ok(postBlock.indexOf("systemUpdate(") > postPg);
  assert.match(postBlock, /upsertEmployeeCredential\(client/);

  const getBlock = routeBlock('app.get("/api/staff/:id/credential"', '// ─── Normalizers');
  const getPg = getBlock.indexOf("if (usePostgres())");
  assert.ok(getPg >= 0);
  assert.ok(getBlock.indexOf("systemGet(") > getPg);
  assert.doesNotMatch(getBlock.slice(getPg, getBlock.indexOf("const encSnap")), /decryptSecret|password:\s*plain/);
});

test("employee partial patch merges current values instead of applying create defaults", async () => {
  const currentRow = {
    id: "employee-uuid",
    legacy_rtdb_id: "waiter_1",
    restaurant_id: "restaurant-uuid",
    name: "Original Name",
    login: "original-login",
    role: "chef",
    active: false,
    modules: { orders: true, reports: true },
    actions: { edit: true },
    extra: { locale: "uz" },
    created_at: new Date(1),
    updated_at: new Date(2),
  };
  let upsertParams;
  const client = {
    async query(sql, params) {
      if (sql.startsWith("SELECT * FROM employees")) return { rows: [currentRow] };
      if (sql.includes("INSERT INTO employees")) {
        upsertParams = params;
        return { rows: [{ ...currentRow, name: params[2], login: params[3], role: params[4], active: params[5], modules: JSON.parse(params[6]), actions: JSON.parse(params[7]) }] };
      }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("INSERT INTO realtime_events")) return { rows: [{ seq: 1 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const events = [];
  const preparedPatch = preparePgStaffPatch(
    { name: "Renamed", modules: { orders: false } },
    { isSafeId: (id) => /^[A-Za-z0-9_-]+$/.test(id), now: () => 3 }
  );
  const result = await rtdbUpdate(
    client,
    { restaurantUuid: "restaurant-uuid", restId: "tenant-a" },
    "restaurants/tenant-a/users/waiter_1",
    preparedPatch.staffPatch,
    events
  );

  assert.equal(upsertParams[2], "Renamed");
  assert.equal(upsertParams[3], "original-login");
  assert.equal(upsertParams[4], "chef");
  assert.equal(upsertParams[5], false);
  assert.deepEqual(JSON.parse(upsertParams[6]), { orders: false, reports: true });
  assert.deepEqual(JSON.parse(upsertParams[7]), { edit: true });
  assert.equal(result.value.name, "Renamed");
  assert.equal(events.length, 1);
});

test("global request failure handling does not publish raw err.message", () => {
  const block = serverSource.slice(serverSource.indexOf("app.use((err, req, res, _next)"));
  assert.doesNotMatch(block, /NotificationService\.send\([^\n]+err\.message/);
  assert.match(block, /classifyStaffMutationFailure\(err, isPgUnavailableError\)/);
});

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("staff mutation authority allows only verified same-tenant owner/admin before downstream DB work", async () => {
  for (const role of ["owner", "admin"]) {
    let downstreamCalls = 0;
    const middleware = createStaffMutationAuthority({
      resolveIdentity: async () => ({ verified: true, restId: "tenant-a", role, userId: `${role}-1` }),
      getRestId: () => "tenant-a",
      usePostgres: () => true,
    });
    const req = {};
    await middleware(req, responseRecorder(), () => { downstreamCalls += 1; });
    assert.equal(downstreamCalls, 1);
    assert.equal(req.nestaAuth.role, role);
  }
});

test("custom staff role is deterministic 403 with zero downstream DB calls", async () => {
  let downstreamCalls = 0;
  const middleware = createStaffMutationAuthority({
    resolveIdentity: async () => ({ verified: true, restId: "tenant-a", role: "manager", userId: "manager-1" }),
    getRestId: () => "tenant-a",
    usePostgres: () => true,
  });
  const res = responseRecorder();
  await middleware({}, res, () => { downstreamCalls += 1; });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "Access Denied" });
  assert.equal(downstreamCalls, 0);
});

test("missing authentication is 401 and wrong or missing tenant claim is 403", async () => {
  for (const scenario of [
    { identity: { verified: false }, status: 401 },
    { identity: { verified: true, restId: "tenant-b", role: "owner" }, status: 403 },
    { identity: { verified: true, restId: null, role: "owner" }, status: 403 },
  ]) {
    let downstreamCalls = 0;
    const middleware = createStaffMutationAuthority({
      resolveIdentity: async () => scenario.identity,
      getRestId: () => "tenant-a",
      usePostgres: () => true,
    });
    const res = responseRecorder();
    await middleware({}, res, () => { downstreamCalls += 1; });
    assert.equal(res.statusCode, scenario.status);
    assert.equal(downstreamCalls, 0);
  }
});

test("Firebase mode delegates custom roles to the existing permission middleware without PG authority work", async () => {
  let identityCalls = 0;
  let downstreamCalls = 0;
  const middleware = createStaffMutationAuthority({
    resolveIdentity: async () => {
      identityCalls += 1;
      return { verified: true, restId: "tenant-a", role: "manager" };
    },
    getRestId: () => "tenant-a",
    usePostgres: () => false,
  });
  await middleware({}, responseRecorder(), () => { downstreamCalls += 1; });
  assert.equal(identityCalls, 0);
  assert.equal(downstreamCalls, 1);
});

test("every staff mutation route applies literal authority guard before permission/DB middleware", () => {
  for (const route of [
    'app.post("/api/staff", requireStaffMutationAuthority, requirePermission',
    'app.patch("/api/staff/:id", requireStaffMutationAuthority, requirePermission',
    'app.delete("/api/staff/:id", requireStaffMutationAuthority, requirePermission',
    'app.post("/api/staff/:id/credential", requireStaffMutationAuthority, requirePermission',
  ]) assert.ok(serverSource.includes(route), `missing authority order: ${route}`);
});

test("PG outage maps to sanitized 503 and unexpected raw DB detail maps to generic 500", () => {
  const transient = classifyStaffMutationFailure(
    Object.assign(new Error("password=secret host=db.internal"), { code: "ECONNREFUSED" }),
    (err) => err.code === "ECONNREFUSED"
  );
  assert.deepEqual(transient, { status: 503, body: { error: "PG_UNAVAILABLE" } });

  const unexpected = classifyStaffMutationFailure(
    new Error("SELECT password_hash FROM employee_credentials failed"),
    () => false
  );
  assert.deepEqual(unexpected, { status: 500, body: { error: "Internal server error" } });
  assert.doesNotMatch(JSON.stringify(unexpected), /password|SELECT|credential/i);
});

test("PG staff create preserves the legitimate employee model and safe extras", () => {
  const prepared = preparePgStaffCreate({
    legacy_rtdb_id: "chef_existing_1",
    name: "  Head Chef  ",
    role: "chef",
    active: false,
    login: "chef.login",
    chefCategories: ["grill", "general"],
    kitchenStation: "hot-kitchen",
    isHeadChef: true,
    salaryMode: "fixed",
    permissions: { menu: ["view", "edit"] },
    phone: "+998901234567",
    note: "night shift",
    password: "1234",
  }, { isSafeId: (id) => /^[A-Za-z0-9_-]+$/.test(id), now: () => 123 });

  assert.equal(prepared.staffId, "chef_existing_1");
  assert.equal(prepared.requestedPin, "1234");
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.staffData)), {
    name: "Head Chef",
    role: "chef",
    active: false,
    login: "chef.login",
    chefCategories: ["grill", "general"],
    kitchenStation: "hot-kitchen",
    isHeadChef: true,
    salaryMode: "fixed",
    permissions: { menu: ["view", "edit"] },
    phone: "+998901234567",
    note: "night shift",
    createdAt: 123,
    updatedAt: 123,
  });
});

test("recursive sanitizer preserves legitimate nested employee extras and permissions", () => {
  const prepared = preparePgStaffCreate({
    name: "Nested Chef",
    role: "chef",
    permissions: {
      menu: { actions: ["view", "edit"], limits: { daily: 10 } },
      kitchen: { stations: [{ code: "hot", enabled: true }] },
    },
    profile: { contact: { phone: "+99890", locale: "uz" }, tags: ["lead", "night"] },
  }, { isSafeId: (id) => /^[A-Za-z0-9_-]+$/.test(id), now: () => 11 });
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.staffData.permissions)), {
    menu: { actions: ["view", "edit"], limits: { daily: 10 } },
    kitchen: { stations: [{ code: "hot", enabled: true }] },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.staffData.profile)), {
    contact: { phone: "+99890", locale: "uz" }, tags: ["lead", "night"],
  });
  assert.equal(Object.getPrototypeOf(prepared.staffData.permissions), null);
  assert.equal(Object.getPrototypeOf(prepared.staffData.profile.contact), null);
});

test("PG staff create strips credentials, tenant/authority fields, and prototype-pollution keys", () => {
  const input = JSON.parse(`{
    "name":"Waiter", "role":"waiter", "password":"4321", "PIN":"9999",
    "password_hash":"raw", "passwordSalt":"salt", "pin_hash":"pin-hash", "passwordEnc":"enc", "restId":"tenant-b",
    "restaurant_id":"uuid-b", "tenant-id":"tenant-b", "platformSuperAdmin":true,
    "platform_role":"root", "is_super_admin":true, "claims":{"role":"owner"}, "token":"secret",
    "acting_role":"owner", "uid":"victim", "id":"forged", "_pgId":"forged-pg", "__proto__":{"polluted":true},
    "prototype":{"polluted":true}, "constructor":{"prototype":{"polluted":true}}
  }`);
  const prepared = preparePgStaffCreate(input, {
    isSafeId: (id) => /^[A-Za-z0-9_-]+$/.test(id),
    now: () => 456,
  });
  assert.equal(prepared.requestedPin, "4321");
  for (const forbidden of [
    "password", "PIN", "password_hash", "passwordSalt", "pin_hash", "passwordEnc", "restId", "restaurant_id",
    "tenant-id", "platformSuperAdmin", "platform_role", "is_super_admin", "claims", "token",
    "acting_role", "uid", "id", "_pgId", "__proto__", "prototype", "constructor",
  ]) assert.equal(Object.hasOwn(prepared.staffData, forbidden), false, forbidden);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(prepared.staffData), null);
});

test("recursive sanitizer strips nested sensitive aliases and prototype-pollution keys", () => {
  const input = JSON.parse(`{
    "name":"Waiter", "role":"waiter",
    "profile": {"phone":"+998", "security_token":"raw", "nested": {
      "password-salt":"salt", "PIN_HASH":"hash", "tenant_id":"other",
      "employee-id":"forged", "__proto__":{"polluted":true}
    }},
    "permissions": {"menu":{"actions":["view"], "claims":{"admin":true}}, "constructor":{"prototype":{"polluted":true}}}
  }`);
  const prepared = preparePgStaffCreate(input, {
    isSafeId: (id) => /^[A-Za-z0-9_-]+$/.test(id), now: () => 22,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.staffData.profile)), {
    phone: "+998", nested: {},
  });
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.staffData.permissions)), {
    menu: { actions: ["view"] },
  });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(prepared.staffData.profile.nested), null);
});

test("PG PATCH shares recursive stripping while preserving legitimate nested changes", () => {
  const patch = preparePgStaffPatch(JSON.parse(`{
    "name":"  Updated  ", "role":"chef", "password":"2468",
    "rest_id":"other", "platform-authority":"root", "_pgId":"forged",
    "permissions":{"menu":{"actions":["view","edit"],"token_value":"secret"}},
    "profile":{"contact":{"phone":"+99891","passwordHash":"raw"}}
  }`), {
    isSafeId: (id) => /^[A-Za-z0-9_-]+$/.test(id), now: () => 33,
  });
  assert.equal(patch.requestedPin, "2468");
  assert.deepEqual(JSON.parse(JSON.stringify(patch.staffPatch)), {
    name: "Updated",
    role: "chef",
    permissions: { menu: { actions: ["view", "edit"] } },
    profile: { contact: { phone: "+99891" } },
    updatedAt: 33,
  });
  assert.equal(Object.getPrototypeOf(patch.staffPatch.permissions.menu), null);
});

test("PG staff create accepts only a safe legacy_rtdb_id and otherwise uses the existing generated-id contract", () => {
  const deps = { isSafeId: (id) => /^[A-Za-z0-9_-]+$/.test(id), now: () => 789 };
  assert.equal(
    preparePgStaffCreate({ name: "Chef", role: "chef", legacy_rtdb_id: "chef_7" }, deps).staffId,
    "chef_7"
  );
  assert.equal(
    preparePgStaffCreate({ name: "Chef", role: "chef" }, deps).staffId,
    "chef_789"
  );
  assert.equal(
    preparePgStaffCreate({ name: "Chef", role: "chef", legacy_rtdb_id: "../tenant-b" }, deps).error,
    "Invalid staff id"
  );
  assert.equal(
    preparePgStaffCreate({ name: "Chef", role: "../owner" }, deps).error,
    "Invalid staff role"
  );
});
