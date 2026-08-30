// Step 2D.5 production write-stop probe.
// GET /api/health first. If maintenance is not advertised, STOP without POSTing
// tenant writes. Never creates orders or payments. Never enables maintenance.
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { classifyHealth, evaluateWriteStop } from "./lib/writeStopProbe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "../../..");

function probeBase() {
  const raw = String(process.env.NESTA_CUTOVER_PROBE_BASE_URL || "").trim().replace(/\/$/, "");
  if (!raw) {
    return { ok: false, reason: "NESTA_CUTOVER_PROBE_BASE_URL is unset; refusing to guess a production host" };
  }
  let url;
  try { url = new URL(raw); } catch {
    return { ok: false, reason: "NESTA_CUTOVER_PROBE_BASE_URL is unparseable" };
  }
  return { ok: true, origin: `${url.protocol}//${url.host}` };
}

async function fetchJson(origin, pathname, method, body) {
  const res = await fetch(`${origin}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function main() {
  const base = probeBase();
  if (!base.ok) {
    console.log(JSON.stringify({
      productionWriteStop: "NOT VERIFIED",
      reason: base.reason,
      writeObserved: false,
    }, null, 2));
    process.exit(2);
  }

  const health = await fetchJson(base.origin, "/api/health", "GET");
  const healthClass = classifyHealth(health.status, health.body);
  if (!healthClass.maintenance) {
    console.log(JSON.stringify({
      productionWriteStop: "NOT VERIFIED",
      maintenance: "OFF",
      reason: "health.maintenance is not true; refusing tenant write/webhook POSTs so this probe cannot create production data",
      writeObserved: false,
      healthStatus: health.status,
    }, null, 2));
    process.exit(2);
  }

  const tenantWrite = await fetchJson(base.origin, "/api/pg/rtdb/set", "POST", { probe: true });
  const click = await fetchJson(base.origin, "/api/click/webhook", "POST", {});
  const payme = await fetchJson(base.origin, "/api/payme/webhook", "POST", { id: 1 });
  const uzum = await fetchJson(base.origin, "/api/uzum/webhook", "POST", {});
  const read = await fetchJson(base.origin, "/api/pg/rtdb/get", "POST", {});
  const login = await fetchJson(base.origin, "/api/auth/staff-login", "POST", {});
  const evaluated = evaluateWriteStop({
    health: healthClass,
    tenantWrite,
    click,
    payme,
    uzum,
  });

  const report = {
    ...evaluated,
    maintenance: "ON",
    healthStatus: health.status,
    readStatus: read.status,
    loginStatus: login.status,
    clickStatus: click.status,
    paymeStatus: payme.status,
    uzumStatus: uzum.status,
    tenantWriteStatus: tenantWrite.status,
    originClass: new URL(base.origin).host.replace(/^[^.]+/, "*"),
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(REPO, "cutover-backups", `write-stop-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "WRITE_STOP.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (evaluated.writeObserved) process.exit(1);
  process.exit(evaluated.productionWriteStop === "PASS" ? 0 : 1);
}

main().catch((err) => {
  console.error("WRITE-STOP PROBE FAILED:", err.message);
  process.exit(1);
});
