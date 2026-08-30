// Classify cutover write-stop probe results. Never issues HTTP itself.
import { MAINTENANCE_CODE } from "../../../security/maintenance.js";

export function classifyHealth(status, body = {}) {
  if (status !== 200 && status !== 503) {
    return { ok: false, maintenance: false, reason: `health HTTP ${status}` };
  }
  return {
    ok: true,
    maintenance: body.maintenance === true,
    reason: body.maintenance === true ? "maintenance advertised" : "maintenance not advertised",
  };
}

export function classifyTenantWrite(status, body = {}) {
  const blocked = status === 503 && body.code === MAINTENANCE_CODE && body.wrote === undefined;
  return {
    ok: blocked,
    writeObserved: status === 200 && body.wrote === true,
    status,
  };
}

export function classifyWebhook(status, body = {}, provider) {
  const never200 = status !== 200;
  const blocked = status === 503 && body.retry_guaranteed === false;
  if (provider === "click") {
    return { ok: never200 && status === 503 && body.error === -7, never200, status };
  }
  if (provider === "payme") {
    return { ok: never200 && status === 503 && body.error?.code === -32400, never200, status };
  }
  return { ok: never200 && status === 503 && body.code === MAINTENANCE_CODE, never200, status };
}

export function evaluateWriteStop(results) {
  if (!results?.health?.maintenance) {
    return {
      productionWriteStop: "NOT VERIFIED",
      tenantWriteBlocked: false,
      clickBlocked: false,
      paymeBlocked: false,
      uzumBlocked: false,
      writeObserved: false,
      reason: "refusing write probes until /api/health reports maintenance=true",
    };
  }
  const tenant = classifyTenantWrite(results.tenantWrite.status, results.tenantWrite.body);
  const click = classifyWebhook(results.click.status, results.click.body, "click");
  const payme = classifyWebhook(results.payme.status, results.payme.body, "payme");
  const uzum = classifyWebhook(results.uzum.status, results.uzum.body, "uzum");
  const writeObserved = tenant.writeObserved === true;
  const ok = tenant.ok && click.ok && payme.ok && uzum.ok && !writeObserved
    && results.click.status !== 200 && results.payme.status !== 200 && results.uzum.status !== 200;
  return {
    productionWriteStop: ok ? "PASS" : "FAIL",
    tenantWriteBlocked: tenant.ok,
    clickBlocked: click.ok,
    paymeBlocked: payme.ok,
    uzumBlocked: uzum.ok,
    writeObserved,
  };
}
