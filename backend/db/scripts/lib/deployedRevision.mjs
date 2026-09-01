// Bind local reviewed commit to LIVE GitHub main and the Railway runtime
// revision from GET /api/deployment on the exact production origin.
//
// Cached refs/remotes/origin/main has zero authorization authority.
//
// P2 trust boundary: RAILWAY_GIT_COMMIT_SHA is Railway runtime metadata.
// An account/operator with enough Railway configuration control may
// potentially spoof environment metadata. This is not cryptographic
// deployment attestation. Missing/malformed => no trusted revision.
// No fallback variable.
import {
  sanitizeRevisionSha,
  publicDeploymentIdentity,
  RAILWAY_GIT_COMMIT_SHA_ENV,
} from "../../../security/deploymentRevision.js";

export {
  sanitizeRevisionSha,
  publicDeploymentIdentity,
  RAILWAY_GIT_COMMIT_SHA_ENV,
};

export const REQUIRED_PRODUCTION_HOSTNAME = "restauranterp-production-5c27.up.railway.app";
export const REQUIRED_PRODUCTION_PROBE_ORIGIN = "https://restauranterp-production-5c27.up.railway.app";
export const REQUIRED_DEPLOYMENT_PATH = "/api/deployment";
export const REQUIRED_DEPLOYMENT_URL = `${REQUIRED_PRODUCTION_PROBE_ORIGIN}${REQUIRED_DEPLOYMENT_PATH}`;

export function responseUrlMatchesDeployment(url, expected = REQUIRED_DEPLOYMENT_URL) {
  return typeof url === "string" && url.length > 0 && url === expected;
}

export function evaluateProductionProbeUrl(raw) {
  if (raw == null || raw === "") {
    return { ok: false, reason: "unset", origin: null };
  }
  if (typeof raw !== "string") {
    return { ok: false, reason: "malformed", origin: null };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed", origin: null };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "scheme", origin: null };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "credentials", origin: null };
  }
  if (url.hostname !== REQUIRED_PRODUCTION_HOSTNAME) {
    return { ok: false, reason: "host", origin: null };
  }
  if (url.port !== "") {
    return { ok: false, reason: "port", origin: null };
  }
  if (url.hash !== "") {
    return { ok: false, reason: "fragment", origin: null };
  }
  if (url.search !== "") {
    return { ok: false, reason: "query", origin: null };
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return { ok: false, reason: "path", origin: null };
  }
  return { ok: true, reason: null, origin: REQUIRED_PRODUCTION_PROBE_ORIGIN };
}

function contentTypeIsJson(res) {
  const get = res?.headers?.get;
  if (typeof get !== "function") return false;
  const ct = String(get.call(res.headers, "content-type") || "");
  return /application\/json/i.test(ct);
}

export function revisionFromProbeResponse(status, body, { contentTypeOk = true } = {}) {
  if (status >= 300 && status < 400) {
    return { ok: false, reason: "redirect", revision: null };
  }
  if (status !== 200) {
    return { ok: false, reason: "non-200", revision: null };
  }
  if (!contentTypeOk) {
    return { ok: false, reason: "content-type", revision: null };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "malformed", revision: null };
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "revision") {
    return { ok: false, reason: "malformed", revision: null };
  }
  if (body.revision == null) {
    return { ok: false, reason: "missing", revision: null };
  }
  const revision = sanitizeRevisionSha(body.revision);
  if (!revision) {
    return { ok: false, reason: "malformed", revision: null };
  }
  return { ok: true, reason: null, revision };
}

export function evaluateOriginMainMatch({ head, liveRemoteMain } = {}) {
  const h = sanitizeRevisionSha(head);
  const live = sanitizeRevisionSha(liveRemoteMain);
  const pass = Boolean(h && live && h === live);
  return {
    originMainMatch: pass ? "PASS" : "FAIL",
    remoteMainLive: pass ? "PASS" : "FAIL",
    liveRemoteMain: live,
    head: h,
  };
}

export function evaluateDeployedRevision({
  head,
  tag,
  runtimeRevision,
  liveRemoteMain,
} = {}) {
  const h = sanitizeRevisionSha(head);
  const t = sanitizeRevisionSha(tag);
  const r = sanitizeRevisionSha(runtimeRevision);
  const live = sanitizeRevisionSha(liveRemoteMain);
  const pass = Boolean(h && t && r && live && h === t && h === r && h === live);
  return {
    deployedRevision: pass ? "PASS" : "FAIL",
    runtimeRevision: r,
    head: h,
    tag: t,
    liveRemoteMain: live,
  };
}

export function evaluateCommitEqualityBinding({
  head,
  tag,
  originMain,
  liveRemoteMain,
  runtimeRevision,
} = {}) {
  const origin = evaluateOriginMainMatch({ head, liveRemoteMain });
  const deployed = evaluateDeployedRevision({
    head,
    tag,
    runtimeRevision,
    liveRemoteMain,
  });
  const allMatch = origin.originMainMatch === "PASS" && deployed.deployedRevision === "PASS";
  return {
    originMainMatch: origin.originMainMatch,
    remoteMainLive: origin.remoteMainLive,
    deployedRevision: deployed.deployedRevision,
    allMatch,
    head: origin.head,
    tag: deployed.tag,
    liveRemoteMain: origin.liveRemoteMain,
    runtimeRevision: deployed.runtimeRevision,
    cachedOriginMain: sanitizeRevisionSha(originMain),
    cachedOriginMainAuthoritative: false,
  };
}

export function resolveCutoverProbeBaseUrl(raw) {
  if (raw == null || raw === "") {
    return evaluateProductionProbeUrl(REQUIRED_PRODUCTION_PROBE_ORIGIN);
  }
  return evaluateProductionProbeUrl(raw);
}

export async function probeRuntimeRevision({
  baseUrl,
  fetchImpl,
  timeoutMs = 8000,
} = {}) {
  const parsed = resolveCutoverProbeBaseUrl(baseUrl);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, revision: null };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, reason: "unavailable", revision: null };
  }
  const requested = `${parsed.origin}${REQUIRED_DEPLOYMENT_PATH}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(requested, {
      method: "GET",
      redirect: "manual",
      signal: ac.signal,
      headers: { accept: "application/json" },
    });
    const status = Number(res?.status);
    if (status >= 300 && status < 400) {
      return { ok: false, reason: "redirect", revision: null };
    }
    if (!responseUrlMatchesDeployment(res?.url, requested)) {
      return { ok: false, reason: "response-url", revision: null };
    }
    const body = await res.json().catch(() => null);
    return revisionFromProbeResponse(status, body, {
      contentTypeOk: contentTypeIsJson(res),
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, reason: "timeout", revision: null };
    }
    return { ok: false, reason: "unavailable", revision: null };
  } finally {
    clearTimeout(timer);
  }
}
