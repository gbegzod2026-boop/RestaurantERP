// Railway injects RAILWAY_GIT_COMMIT_SHA at deploy time when the service
// originated from a GitHub trigger. See https://docs.railway.com/variables/reference
// Do not invent a substitute variable name. Do not echo raw env.
//
// P2 trust boundary: this is runtime metadata, not cryptographic
// deployment attestation. An account/operator with enough Railway
// configuration control may potentially spoof the env value.
// Missing/malformed => no trusted revision. No fallback variable.

export const RAILWAY_GIT_COMMIT_SHA_ENV = "RAILWAY_GIT_COMMIT_SHA";
export const FULL_REVISION_SHA_RE = /^[a-f0-9]{40}$/;

export function sanitizeRevisionSha(value) {
  if (typeof value !== "string") return null;
  if (!FULL_REVISION_SHA_RE.test(value)) return null;
  return value;
}

export function readRailwayGitCommitSha(env = process.env) {
  return sanitizeRevisionSha(env?.[RAILWAY_GIT_COMMIT_SHA_ENV]);
}

export function publicDeploymentIdentity(env = process.env) {
  return { revision: readRailwayGitCommitSha(env) };
}
