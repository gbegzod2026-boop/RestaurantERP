import test from "node:test";
import assert from "node:assert/strict";
import {
  originUrlAllowed,
  parseLsRemoteMain,
  probeLiveGithubMain,
  makeGitLsRemoteImpl,
  EXPECTED_GITHUB_ORIGIN_URLS,
  LIVE_REMOTE_MAIN_REF,
} from "../scripts/lib/githubRemote.mjs";
import {
  evaluateProductionProbeUrl,
  probeRuntimeRevision,
  REQUIRED_PRODUCTION_PROBE_ORIGIN,
  REQUIRED_PRODUCTION_HOSTNAME,
  REQUIRED_DEPLOYMENT_PATH,
} from "../scripts/lib/deployedRevision.mjs";

const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ORIGIN = EXPECTED_GITHUB_ORIGIN_URLS[0];
const PROD = REQUIRED_PRODUCTION_PROBE_ORIGIN;
const DEPLOY_URL = `${PROD}${REQUIRED_DEPLOYMENT_PATH}`;

function jsonHeaders() {
  return { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) };
}

function deploymentRes(status, body, url = DEPLOY_URL) {
  return {
    status,
    url,
    headers: jsonHeaders(),
    json: async () => body,
  };
}

test("intended GitHub origin URLs are accepted; arbitrary origins fail", () => {
  for (const url of EXPECTED_GITHUB_ORIGIN_URLS) {
    assert.equal(originUrlAllowed(url), true);
  }
  assert.equal(originUrlAllowed("https://github.com/attacker/RestaurantERP.git"), false);
  assert.equal(originUrlAllowed("https://evil.example/gbegzod2026-boop/RestaurantERP.git"), false);
  assert.equal(originUrlAllowed("https://github.com/gbegzod2026-boop/RestaurantERP.git/"), false);
  assert.equal(originUrlAllowed("https://user:token@github.com/gbegzod2026-boop/RestaurantERP.git"), false);
  assert.equal(originUrlAllowed(""), false);
});

test("parseLsRemoteMain requires exactly one tab-separated refs/heads/main line", () => {
  assert.equal(parseLsRemoteMain(`${HEAD_SHA}\trefs/heads/main\n`).ok, true);
  assert.equal(parseLsRemoteMain(`${HEAD_SHA}\trefs/heads/main\n`).sha, HEAD_SHA);
  assert.equal(parseLsRemoteMain("").reason, "empty");
  assert.equal(parseLsRemoteMain(`${HEAD_SHA} refs/heads/main\n`).reason, "malformed");
  assert.equal(parseLsRemoteMain(`${HEAD_SHA.toUpperCase()}\trefs/heads/main\n`).reason, "malformed");
  assert.equal(parseLsRemoteMain(`${HEAD_SHA}\trefs/heads/master\n`).reason, "malformed");
  assert.equal(parseLsRemoteMain(`${HEAD_SHA}\trefs/heads/main\n${OTHER_SHA}\trefs/heads/main\n`).reason, "multiple");
  assert.equal(parseLsRemoteMain(`${HEAD_SHA}\trefs/heads/main\n${HEAD_SHA}\trefs/heads/main^{}\n`).reason, "multiple");
});

test("cached ref is irrelevant; live ls-remote SHA is authoritative", () => {
  const liveOld = probeLiveGithubMain({
    originUrl: ORIGIN,
    head: HEAD_SHA,
    lsRemoteImpl: () => `${OTHER_SHA}\trefs/heads/main\n`,
  });
  assert.equal(liveOld.originMainMatch, "FAIL");
  assert.equal(liveOld.liveRemoteMain, OTHER_SHA);
  assert.equal(liveOld.cachedOriginMainAuthoritative, false);

  const liveMatch = probeLiveGithubMain({
    originUrl: ORIGIN,
    head: HEAD_SHA,
    lsRemoteImpl: () => `${HEAD_SHA}\trefs/heads/main\n`,
  });
  assert.equal(liveMatch.originMainMatch, "PASS");
  assert.equal(liveMatch.remoteMainLive, "PASS");
  assert.equal(liveMatch.liveRemoteMain, HEAD_SHA);
});

test("wrong origin never calls ls-remote", () => {
  let called = false;
  const r = probeLiveGithubMain({
    originUrl: "https://github.com/attacker/RestaurantERP.git",
    head: HEAD_SHA,
    lsRemoteImpl: () => {
      called = true;
      return `${HEAD_SHA}\trefs/heads/main\n`;
    },
  });
  assert.equal(called, false);
  assert.equal(r.reason, "wrong-origin");
  assert.equal(r.originMainMatch, "FAIL");
});

test("live remote unavailable, timeout, and malformed responses fail closed", () => {
  assert.equal(probeLiveGithubMain({
    originUrl: ORIGIN,
    head: HEAD_SHA,
  }).reason, "unavailable");
  assert.equal(probeLiveGithubMain({
    originUrl: ORIGIN,
    head: HEAD_SHA,
    lsRemoteImpl: () => { throw new Error("ECONNREFUSED"); },
  }).reason, "unavailable");
  const timeoutErr = new Error("spawnSync git ETIMEDOUT");
  timeoutErr.code = "ETIMEDOUT";
  timeoutErr.killed = true;
  assert.equal(probeLiveGithubMain({
    originUrl: ORIGIN,
    head: HEAD_SHA,
    lsRemoteImpl: () => { throw timeoutErr; },
  }).reason, "timeout");
  assert.equal(probeLiveGithubMain({
    originUrl: ORIGIN,
    head: HEAD_SHA,
    lsRemoteImpl: () => "not-a-ref-line\n",
  }).reason, "malformed");
  assert.equal(probeLiveGithubMain({
    originUrl: ORIGIN,
    head: HEAD_SHA,
    lsRemoteImpl: () => `${HEAD_SHA}\trefs/heads/main\n${OTHER_SHA}\trefs/heads/main\n`,
  }).reason, "multiple");
});

test("makeGitLsRemoteImpl invokes git ls-remote --exit-code against the validated URL", () => {
  const calls = [];
  const impl = makeGitLsRemoteImpl({
    repo: "C:/repo",
    originUrl: ORIGIN,
    execFileSyncImpl: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return `${HEAD_SHA}\trefs/heads/main\n`;
    },
  });
  const out = impl();
  assert.match(out, new RegExp(HEAD_SHA));
  assert.equal(calls[0].cmd, "git");
  assert.equal(calls[0].args.includes("ls-remote"), true);
  assert.equal(calls[0].args.includes("--exit-code"), true);
  assert.equal(calls[0].args.includes(ORIGIN), true);
  assert.equal(calls[0].args.includes(LIVE_REMOTE_MAIN_REF), true);
  assert.equal(calls[0].opts.timeout > 0, true);
});

test("exact production HTTPS origin is accepted; lookalikes fail", () => {
  assert.equal(evaluateProductionProbeUrl(PROD).ok, true);
  assert.equal(evaluateProductionProbeUrl(`${PROD}/`).ok, true);
  assert.equal(evaluateProductionProbeUrl(`http://${REQUIRED_PRODUCTION_HOSTNAME}`).reason, "scheme");
  assert.equal(evaluateProductionProbeUrl("http://127.0.0.1").reason, "scheme");
  assert.equal(evaluateProductionProbeUrl("http://localhost").reason, "scheme");
  assert.equal(evaluateProductionProbeUrl("https://localhost").reason, "host");
  assert.equal(evaluateProductionProbeUrl("https://127.0.0.1").reason, "host");
  assert.equal(evaluateProductionProbeUrl("https://[::1]").reason, "host");
  assert.equal(evaluateProductionProbeUrl("https://10.0.0.1").reason, "host");
  assert.equal(evaluateProductionProbeUrl("https://192.168.1.1").reason, "host");
  assert.equal(evaluateProductionProbeUrl("https://169.254.1.1").reason, "host");
  assert.equal(evaluateProductionProbeUrl("https://attacker.example").reason, "host");
  assert.equal(evaluateProductionProbeUrl("https://other-service.up.railway.app").reason, "host");
  assert.equal(evaluateProductionProbeUrl(`https://user:pass@${REQUIRED_PRODUCTION_HOSTNAME}`).reason, "credentials");
  assert.equal(evaluateProductionProbeUrl(`${PROD}:8443`).reason, "port");
  assert.equal(evaluateProductionProbeUrl(`${PROD}/api/deployment`).reason, "path");
  assert.equal(evaluateProductionProbeUrl(`${PROD}#x`).reason, "fragment");
  assert.equal(evaluateProductionProbeUrl("not a url").reason, "malformed");
});

test("rejected probe URLs never invoke fetch", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return deploymentRes(200, { revision: HEAD_SHA });
  };
  for (const baseUrl of [
    "http://127.0.0.1",
    "http://localhost",
    "https://127.0.0.1",
    "https://localhost",
    "https://10.1.2.3",
    "https://attacker.example",
    "https://evil.up.railway.app",
    `https://user:x@${REQUIRED_PRODUCTION_HOSTNAME}`,
    `${PROD}:4433`,
  ]) {
    called = false;
    const r = await probeRuntimeRevision({ baseUrl, fetchImpl });
    assert.equal(called, false, baseUrl);
    assert.equal(r.ok, false, baseUrl);
    assert.equal(r.revision, null, baseUrl);
  }
});

test("redirect 301/302/307/308 fail closed even from the production host", async () => {
  for (const status of [301, 302, 307, 308]) {
    const r = await probeRuntimeRevision({
      baseUrl: PROD,
      fetchImpl: async (_url, opts) => {
        assert.equal(opts.redirect, "manual");
        return {
          status,
          url: "https://attacker.example/api/deployment",
          headers: jsonHeaders(),
          json: async () => ({ revision: HEAD_SHA }),
        };
      },
    });
    assert.equal(r.ok, false, String(status));
    assert.equal(r.reason, "redirect", String(status));
    assert.equal(r.revision, null, String(status));
  }
});

test("direct 200 from exact production /api/deployment continues SHA validation", async () => {
  const ok = await probeRuntimeRevision({
    baseUrl: PROD,
    fetchImpl: async (url, opts) => {
      assert.equal(opts.redirect, "manual");
      assert.equal(url, DEPLOY_URL);
      return deploymentRes(200, { revision: HEAD_SHA });
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.revision, HEAD_SHA);

  const upper = await probeRuntimeRevision({
    baseUrl: PROD,
    fetchImpl: async () => deploymentRes(200, { revision: HEAD_SHA.toUpperCase() }),
  });
  assert.equal(upper.ok, false);
  assert.equal(upper.reason, "malformed");

  const space = await probeRuntimeRevision({
    baseUrl: PROD,
    fetchImpl: async () => deploymentRes(200, { revision: ` ${HEAD_SHA}` }),
  });
  assert.equal(space.ok, false);

  const missing = await probeRuntimeRevision({
    baseUrl: PROD,
    fetchImpl: async () => deploymentRes(200, { revision: null }),
  });
  assert.equal(missing.reason, "missing");

  const extra = await probeRuntimeRevision({
    baseUrl: PROD,
    fetchImpl: async () => deploymentRes(200, { revision: HEAD_SHA, ok: true }),
  });
  assert.equal(extra.reason, "malformed");
});

test("Response.url must equal the exact production deployment URL", async () => {
  const body = { revision: HEAD_SHA };
  const missingUrl = await probeRuntimeRevision({
    baseUrl: PROD,
    fetchImpl: async () => ({ status: 200, headers: jsonHeaders(), json: async () => body }),
  });
  assert.equal(missingUrl.reason, "response-url");
  const emptyUrl = await probeRuntimeRevision({
    baseUrl: PROD,
    fetchImpl: async () => deploymentRes(200, body, ""),
  });
  assert.equal(emptyUrl.reason, "response-url");
  const query = await probeRuntimeRevision({
    baseUrl: PROD,
    fetchImpl: async () => deploymentRes(200, body, `${DEPLOY_URL}?x=1`),
  });
  assert.equal(query.reason, "response-url");
  const fragment = await probeRuntimeRevision({
    baseUrl: PROD,
    fetchImpl: async () => deploymentRes(200, body, `${DEPLOY_URL}#frag`),
  });
  assert.equal(fragment.reason, "response-url");
  const creds = await probeRuntimeRevision({
    baseUrl: PROD,
    fetchImpl: async () => deploymentRes(200, body, `https://u:p@${REQUIRED_PRODUCTION_HOSTNAME}${REQUIRED_DEPLOYMENT_PATH}`),
  });
  assert.equal(creds.reason, "response-url");
  const otherPath = await probeRuntimeRevision({
    baseUrl: PROD,
    fetchImpl: async () => deploymentRes(200, body, `${PROD}/api/health`),
  });
  assert.equal(otherPath.reason, "response-url");
  const otherHost = await probeRuntimeRevision({
    baseUrl: PROD,
    fetchImpl: async () => deploymentRes(200, body, "https://attacker.example/api/deployment"),
  });
  assert.equal(otherHost.reason, "response-url");
  const exact = await probeRuntimeRevision({
    baseUrl: PROD,
    fetchImpl: async () => deploymentRes(200, body, DEPLOY_URL),
  });
  assert.equal(exact.ok, true);
});
