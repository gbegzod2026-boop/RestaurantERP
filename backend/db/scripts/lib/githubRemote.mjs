// Live GitHub main verification. Cached refs/remotes/origin/main has
// zero authorization authority. Approval requires git ls-remote against
// the intended repository only.

export const EXPECTED_GITHUB_OWNER_REPO = "gbegzod2026-boop/RestaurantERP";
export const EXPECTED_GITHUB_ORIGIN_URLS = Object.freeze([
  "https://github.com/gbegzod2026-boop/RestaurantERP.git",
  "https://github.com/gbegzod2026-boop/RestaurantERP",
  "git@github.com:gbegzod2026-boop/RestaurantERP.git",
  "git@github.com:gbegzod2026-boop/RestaurantERP",
]);
export const LIVE_REMOTE_MAIN_REF = "refs/heads/main";
export const LS_REMOTE_MAIN_LINE_RE = /^([a-f0-9]{40})\trefs\/heads\/main$/;
export const LS_REMOTE_TIMEOUT_MS = 15000;

export function originUrlAllowed(url) {
  return EXPECTED_GITHUB_ORIGIN_URLS.includes(String(url || ""));
}

export function sanitizeOriginUrlForReport(url) {
  const raw = String(url || "");
  if (!raw) return null;
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const u = new URL(raw);
      if (u.username || u.password) {
        u.username = "";
        u.password = "";
        return `${u.protocol}//${u.host}${u.pathname}`;
      }
    }
  } catch {
    return "(unparseable-origin)";
  }
  if (raw.includes("@") && raw.includes("://")) return "(credentialed-origin-redacted)";
  return raw;
}

export function parseLsRemoteMain(stdout) {
  const text = String(stdout ?? "").replace(/\r\n/g, "\n");
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!body) return { ok: false, reason: "empty", sha: null };
  const lines = body.split("\n");
  if (lines.length !== 1) return { ok: false, reason: "multiple", sha: null };
  const m = LS_REMOTE_MAIN_LINE_RE.exec(lines[0]);
  if (!m) return { ok: false, reason: "malformed", sha: null };
  return { ok: true, reason: null, sha: m[1] };
}

function lsRemoteFailureReason(err) {
  if (!err) return "unavailable";
  if (err.killed === true || err.code === "ETIMEDOUT") return "timeout";
  const msg = String(err.message || "");
  if (/timed? ?out/i.test(msg)) return "timeout";
  return "unavailable";
}

export function makeGitLsRemoteImpl({
  repo,
  originUrl,
  execFileSyncImpl,
  timeoutMs = LS_REMOTE_TIMEOUT_MS,
} = {}) {
  return () => {
    if (!originUrlAllowed(originUrl) || typeof execFileSyncImpl !== "function") {
      throw new Error("wrong-origin");
    }
    return execFileSyncImpl("git", [
      "-c",
      `safe.directory=${repo}`,
      "ls-remote",
      "--exit-code",
      "--",
      originUrl,
      LIVE_REMOTE_MAIN_REF,
    ], {
      cwd: repo,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
}

export function probeLiveGithubMain({
  originUrl,
  head,
  lsRemoteImpl,
} = {}) {
  const fail = (reason) => ({
    ok: false,
    reason,
    liveRemoteMain: null,
    remoteMainLive: "FAIL",
    originMainMatch: "FAIL",
    originAllowed: originUrlAllowed(originUrl),
    originUrl: sanitizeOriginUrlForReport(originUrl),
    cachedOriginMainAuthoritative: false,
  });
  if (!originUrlAllowed(originUrl)) return fail("wrong-origin");
  if (typeof lsRemoteImpl !== "function") return fail("unavailable");
  let stdout;
  try {
    stdout = lsRemoteImpl();
  } catch (err) {
    return fail(lsRemoteFailureReason(err));
  }
  if (stdout == null) return fail("unavailable");
  const parsed = parseLsRemoteMain(stdout);
  if (!parsed.ok) return fail(parsed.reason);
  const h = typeof head === "string" && /^[a-f0-9]{40}$/.test(head) ? head : null;
  const match = Boolean(h && parsed.sha === h);
  return {
    ok: match,
    reason: match ? null : "mismatch",
    liveRemoteMain: parsed.sha,
    remoteMainLive: match ? "PASS" : "FAIL",
    originMainMatch: match ? "PASS" : "FAIL",
    originAllowed: true,
    originUrl: sanitizeOriginUrlForReport(originUrl),
    cachedOriginMainAuthoritative: false,
  };
}
