import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, "../..");
const sourceHtmlPath = path.join(backendRoot, "../admin-frontend/public/superadmin.html");
const deployHtmlPath = path.join(backendRoot, "public/superadmin.html");

function inlineModules(html) {
  const modules = [];
  const re = /<script type="module">([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(html))) modules.push(match[1]);
  return modules;
}

function findModule(modules, needle) {
  const found = modules.find((src) => src.includes(needle));
  assert.ok(found, `missing inline module containing ${needle}`);
  return found;
}

function stripImports(src) {
  return String(src).replace(/^\s*import\s+[^;]+;\s*$/gm, "");
}

function loadCanonicalModules() {
  const source = readFileSync(sourceHtmlPath);
  const deploy = readFileSync(deployHtmlPath);
  assert.equal(Buffer.compare(source, deploy), 0, "source and deploy superadmin.html must be byte-identical");
  const modules = inlineModules(source.toString("utf8"));
  return {
    init: findModule(modules, "loadNestaFirebaseApp"),
    landing: findModule(modules, "function subscribeRequests()"),
    notif: findModule(modules, "function subscribeNotifSources()"),
  };
}

function el(extras = {}) {
  return {
    style: {},
    classList: { contains() { return false; }, toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    innerHTML: "",
    textContent: "",
    value: "all",
    id: "",
    getAttribute() { return null; },
    querySelector() { return null; },
    closest() { return null; },
    ...extras,
  };
}

async function tick(times = 8) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function createWorld({ readyState, hash = "" }) {
  const app = { name: "mock-nesta-app" };
  const db = {
    id: "mock-nesta-db",
    _checkReferenceNotDeleted() { return true; },
  };
  const refCalls = [];
  const getDatabaseCalls = [];
  const forceCalls = [];
  const initializeAppCalls = [];
  let resolveLoad;
  const loadPromise = new Promise((resolve) => { resolveLoad = resolve; });

  let currentReadyState = readyState;
  const listeners = {
    DOMContentLoaded: [],
    click: [],
  };
  const timeouts = [];
  const locationRef = { hash, href: "http://nesta.test/superadmin.html" };

  const requestsEl = el({ id: "requests" });
  const elements = {
    requests: requestsEl,
    reqFilterStatus: el({ id: "reqFilterStatus", value: "all" }),
    requestsTableBody: el({ id: "requestsTableBody" }),
    reqDetailModal: el({ id: "reqDetailModal" }),
    reqDetailContent: el({ id: "reqDetailContent" }),
    notifListContainer: el({ id: "notifListContainer" }),
    notifBadgeCount: el({ id: "notifBadgeCount" }),
    notifDropdown: el({ id: "notifDropdown" }),
    notifBellBtn: el({ id: "notifBellBtn" }),
    notifBellWrap: el({ id: "notifBellWrap" }),
  };

  const documentObj = {
    get readyState() { return currentReadyState; },
    addEventListener(type, fn) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    getElementById(id) { return elements[id] || null; },
    querySelector() { return null; },
  };

  const windowObj = {
    t: (_key, fallback) => fallback,
    allRestaurants: {},
    document: documentObj,
    location: locationRef,
  };

  class MutationObserver {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
  }

  const bindings = {
    window: windowObj,
    document: documentObj,
    location: locationRef,
    MutationObserver,
    setTimeout(fn, ms = 0) {
      const handle = { fn, ms: Number(ms) || 0, ran: false };
      timeouts.push(handle);
      return handle;
    },
    setInterval() { return 0; },
    clearTimeout(handle) {
      if (handle) handle.ran = true;
    },
    clearInterval() {},
    confirm: () => false,
    loadNestaFirebaseApp: () => loadPromise.then(() => app),
    getDatabase(passedApp) {
      getDatabaseCalls.push(passedApp);
      return db;
    },
    forceWebSockets() { forceCalls.push(true); },
    initializeApp() {
      initializeAppCalls.push(true);
      throw new Error("initializeApp must not be called by these modules");
    },
    ref(receivedDb, path) {
      if (receivedDb == null) {
        throw new TypeError("Cannot read properties of undefined (reading '_checkReferenceNotDeleted')");
      }
      receivedDb._checkReferenceNotDeleted();
      refCalls.push({ db: receivedDb, path });
      return { db: receivedDb, path };
    },
    onValue() {},
    update() {},
    remove() {},
  };

  function runModule(source) {
    const body = stripImports(source);
    const names = Object.keys(bindings);
    const fn = new Function(
      ...names,
      `"use strict";\nreturn (async () => {\n${body}\n})();`,
    );
    return fn(...names.map((name) => bindings[name]));
  }

  return {
    app,
    db,
    windowObj,
    listeners,
    timeouts,
    refCalls,
    getDatabaseCalls,
    forceCalls,
    initializeAppCalls,
    runModule,
    resolveLoad() { resolveLoad(app); },
    fireDOMContentLoaded() {
      currentReadyState = "interactive";
      for (const fn of listeners.DOMContentLoaded.slice()) fn();
    },
    flushTimeouts(maxMs = Infinity) {
      for (const handle of timeouts) {
        if (!handle.ran && handle.ms <= maxMs) {
          handle.ran = true;
          handle.fn();
        }
      }
    },
  };
}

test("source and deploy superadmin.html are byte-identical; consumers await shared ready", () => {
  const { init, landing, notif } = loadCanonicalModules();

  assert.match(init, /window\._nestaFirebaseReady\s*=/);
  assert.match(init, /await loadNestaFirebaseApp\(\)/);
  assert.match(init, /forceWebSockets\(\)/);
  assert.match(init, /getDatabase\(app\)/);
  assert.match(init, /window\._fbApp\s*=\s*app/);
  assert.match(init, /window\._fbDb\s*=\s*db/);
  assert.match(init, /return \{\s*app,\s*db\s*\}/);
  assert.equal((init.match(/getDatabase\(/g) || []).length, 1);
  assert.equal((init.match(/initializeApp\(/g) || []).length, 0);

  for (const src of [landing, notif]) {
    assert.match(src, /await window\._nestaFirebaseReady/);
    assert.doesNotMatch(src, /window\._fbDb/);
    assert.doesNotMatch(src, /window\._fbApp/);
    assert.doesNotMatch(src, /loadNestaFirebaseApp\(/);
    assert.doesNotMatch(src, /getDatabase\(/);
    assert.doesNotMatch(src, /initializeApp\(/);
    const awaitAt = src.indexOf("await window._nestaFirebaseReady");
    const refAt = src.indexOf("ref(db,");
    assert.ok(awaitAt >= 0 && refAt > awaitAt);
  }
});

test("actual initializer publishes _nestaFirebaseReady before load resolves; getDatabase once", async () => {
  const { init } = loadCanonicalModules();
  const world = createWorld({ readyState: "complete" });

  const initDone = world.runModule(init);
  await tick();
  await initDone;

  assert.equal(typeof world.windowObj._nestaFirebaseReady?.then, "function");
  assert.equal(world.windowObj._fbApp, undefined);
  assert.equal(world.windowObj._fbDb, undefined);
  assert.equal(world.getDatabaseCalls.length, 0);
  assert.equal(world.forceCalls.length, 0);

  world.resolveLoad();
  const ready = await world.windowObj._nestaFirebaseReady;
  assert.equal(ready.app, world.app);
  assert.equal(ready.db, world.db);
  assert.equal(world.windowObj._fbApp, world.app);
  assert.equal(world.windowObj._fbDb, world.db);
  assert.equal(world.getDatabaseCalls.length, 1);
  assert.equal(world.getDatabaseCalls[0], world.app);
  assert.equal(world.forceCalls.length, 1);
  assert.equal(world.initializeAppCalls.length, 0);
});

test("actual notification and landing modules do not call ref() until delayed init resolves", async () => {
  const { init, landing, notif } = loadCanonicalModules();
  const world = createWorld({ readyState: "interactive", hash: "#requests" });

  await world.runModule(init);
  assert.equal(typeof world.windowObj._nestaFirebaseReady?.then, "function");

  const landingDone = world.runModule(landing);
  const notifDone = world.runModule(notif);
  await tick();

  assert.equal(world.windowObj._fbDb, undefined);
  assert.equal(world.refCalls.length, 0);
  assert.equal(world.getDatabaseCalls.length, 0);

  world.resolveLoad();
  await notifDone;
  await landingDone;
  world.flushTimeouts(300);

  assert.ok(world.refCalls.length >= 2);
  for (const call of world.refCalls) {
    assert.equal(call.db, world.db);
    assert.notEqual(call.db, undefined);
    assert.equal(call.path === "landingRequests" || String(call.path).startsWith("landingRequests/"), true);
  }
  assert.equal(world.getDatabaseCalls.length, 1);
  assert.equal(world.initializeAppCalls.length, 0);
});

for (const readyState of ["interactive", "complete"]) {
  test(`actual consumers start immediately when readyState is ${readyState}`, async () => {
    const { init, landing, notif } = loadCanonicalModules();
    const world = createWorld({ readyState, hash: "#requests" });

    await world.runModule(init);
    const landingDone = world.runModule(landing);
    const notifDone = world.runModule(notif);
    await tick();
    assert.equal(world.refCalls.length, 0);

    world.resolveLoad();
    await notifDone;
    assert.ok(world.refCalls.some((call) => call.db === world.db && call.path === "landingRequests"));
    assert.equal(world.listeners.DOMContentLoaded.length, 0);

    await landingDone;
    const beforeFlush = world.refCalls.length;
    world.flushTimeouts(300);
    assert.ok(world.refCalls.length > beforeFlush);
    for (const call of world.refCalls) assert.equal(call.db, world.db);
  });
}

test("actual consumers wait for DOMContentLoaded when readyState is loading", async () => {
  const { init, landing, notif } = loadCanonicalModules();
  const world = createWorld({ readyState: "loading", hash: "#requests" });

  await world.runModule(init);
  const landingDone = world.runModule(landing);
  const notifDone = world.runModule(notif);
  await tick();
  assert.equal(world.refCalls.length, 0);

  world.resolveLoad();
  await notifDone;
  await landingDone;
  assert.ok(world.listeners.DOMContentLoaded.length >= 2);
  assert.equal(world.refCalls.length, 0, "no subscription before DOMContentLoaded");

  world.fireDOMContentLoaded();
  assert.ok(world.refCalls.some((call) => call.db === world.db && call.path === "landingRequests"));
  world.flushTimeouts(300);
  assert.ok(world.refCalls.length >= 2);
  for (const call of world.refCalls) assert.equal(call.db, world.db);
});
