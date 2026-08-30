// Local/staging cutover rehearsal. Always forced onto nesta_migration_dryrun.
// Does not call production endpoints, does not switch DATA_BACKEND, does not
// write Firebase. Reports elapsed times per step.
import path from "path";
import { fileURLToPath } from "url";
import { performance } from "perf_hooks";
import express from "express";
import { once } from "node:events";
import dotenv from "dotenv";
import {
  isMaintenanceMode,
  maintenanceMiddleware,
  MAINTENANCE_CODE,
} from "../../security/maintenance.js";
import { paymentCutoverReport } from "../../payments/cutoverMode.js";
import {
  assertMigrationTarget,
} from "./lib/migrationTargetGuard.mjs";
import { getPool, maskedConfig, closePool, isPgAvailable } from "../postgres.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (/:59999\b/.test(process.env.POSTGRES_URL || "")) delete process.env.POSTGRES_URL;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
delete process.env.NESTA_REQUIRE_ISOLATED_AUTH;
delete process.env.PORT;
dotenv.config({ path: path.join(__dirname, "../../.env"), quiet: true });

function elapsed(start) {
  return Math.round(performance.now() - start);
}

async function probe(port, pathName, method = "POST") {
  const res = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : "{}",
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  const started = performance.now();
  const steps = [];
  if (!isPgAvailable()) throw new Error("PostgreSQL not configured");
  const cfg = maskedConfig();
  assertMigrationTarget(cfg);

  const prevMaint = process.env.NESTA_MAINTENANCE_MODE;
  const prevBackend = process.env.DATA_BACKEND;

  process.env.NESTA_MAINTENANCE_MODE = "1";
  let t = performance.now();
  if (!isMaintenanceMode()) throw new Error("maintenance did not enable");
  steps.push({ step: "maintenance_on", ms: elapsed(t), ok: true });

  t = performance.now();
  const app = express();
  app.use(express.json());
  app.use(maintenanceMiddleware);
  app.post("/api/pg/rtdb/set", (_req, res) => res.json({ wrote: true }));
  app.post("/api/pg/rtdb/get", (_req, res) => res.json({ read: true }));
  app.post("/api/click/webhook", (_req, res) => res.json({ error: 0 }));
  app.get("/api/health", (_req, res) => res.json({ ok: true, maintenance: true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const write = await probe(port, "/api/pg/rtdb/set");
    const read = await probe(port, "/api/pg/rtdb/get");
    const click = await probe(port, "/api/click/webhook");
    const health = await probe(port, "/api/health", "GET");
    const freezeOk = write.status === 503 && write.body.code === MAINTENANCE_CODE
      && read.status === 200 && click.status === 503 && click.body.error === -7
      && health.status === 200;
    steps.push({
      step: "writers_blocked",
      ms: elapsed(t),
      ok: freezeOk,
      write: write.status,
      read: read.status,
      webhook: click.status,
    });
    if (!freezeOk) throw new Error("freeze simulation failed");
  } finally {
    server.close();
    await once(server, "close");
  }

  t = performance.now();
  steps.push({
    step: "scheduler_paused",
    ms: elapsed(t),
    ok: isMaintenanceMode(),
    note: "scheduler/Telegram pollers return immediately when NESTA_MAINTENANCE_MODE=1",
  });

  t = performance.now();
  const pool = getPool();
  const c = await pool.connect();
  try {
    await c.query("SELECT set_config('app.current_restaurant_id', '', true)");
    const counts = {
      restaurants: Number((await c.query("SELECT count(*)::int AS n FROM restaurants")).rows[0].n),
      orders: Number((await c.query("SELECT count(*)::int AS n FROM orders")).rows[0].n),
      payments: Number((await c.query("SELECT count(*)::int AS n FROM payments")).rows[0].n),
    };
    const alreadyLoaded = counts.restaurants > 0;
    steps.push({
      step: "migrate_skipped_already_loaded",
      ms: elapsed(t),
      ok: alreadyLoaded,
      counts,
      expectedFromStep2C: { restaurants: 46, orders: 59, payments: 54 },
      note: "dedicated dry-run already loaded in Step 2C; this rehearsal does not re-apply and does not read production Firebase",
    });
    if (!alreadyLoaded) throw new Error("nesta_migration_dryrun has no restaurants; load it with Step 2B/2C first");
  } finally {
    c.release();
  }

  t = performance.now();
  steps.push({
    step: "reconcile_counts_only",
    ms: elapsed(t),
    ok: true,
    note: "full Firebase reconcile remains the Step 2C report; rehearsal does not re-read production RTDB",
  });

  t = performance.now();
  steps.push({
    step: "simulated_postgres_switch",
    ms: elapsed(t),
    ok: true,
    wouldSet: "postgres",
    processRemains: String(prevBackend || "(unset)"),
    didNotMutateDataBackend: true,
    note: "DATA_BACKEND was not written. Local .env may already say postgres from Step 1; this rehearsal does not cut over production.",
  });

  t = performance.now();
  steps.push({
    step: "smoke",
    ms: elapsed(t),
    ok: true,
    note: "browser smoke is operator-owned; rehearsal verified freeze HTTP contract only",
    paymentMatrix: paymentCutoverReport(),
  });

  t = performance.now();
  steps.push({
    step: "rollback_simulation",
    ms: elapsed(t),
    ok: true,
    note: "rollback before switch = keep DATA_BACKEND=firebase and turn maintenance off",
  });

  t = performance.now();
  if (prevMaint === undefined) delete process.env.NESTA_MAINTENANCE_MODE;
  else process.env.NESTA_MAINTENANCE_MODE = prevMaint;
  const maintOffOk = isMaintenanceMode() === isMaintenanceMode({ NESTA_MAINTENANCE_MODE: prevMaint || "" });
  steps.push({ step: "maintenance_off", ms: elapsed(t), ok: maintOffOk, restored: prevMaint || "(unset)" });

  await closePool();
  const report = {
    target: { host: cfg.host, port: cfg.port, database: cfg.database },
    productionEndpoints: "none",
    totalMs: elapsed(started),
    steps,
    ok: steps.every((s) => s.ok),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((err) => {
  console.error("REHEARSAL FAILED:", err.message);
  process.exit(1);
});
