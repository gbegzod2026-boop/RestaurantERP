// Step 2D.5 candidate trust: TWO-PHASE, no self-referential SHA.
//
// PHASE A — candidate precursor commit (this tree). Contains policy only:
// tag name, annotation marker, purpose, version. It does NOT contain an
// approved commit SHA and cannot self-authorize.
//
// PHASE B — annotated Git tag OUTSIDE the candidate commit. The tag object
// binds {tag name → target commit}. Trust is the tag object, not a SHA
// written into the same commit being approved.
//
// Historical tags (nesta-step2c-cutover, nesta-step2-cutover-ready) are
// never Step 2D.5 approval bindings. Do not move or delete them.
// Do not create the reviewed tag until after independent review.
//
// Unsigned annotated tag threat model (P2: signed tags not enforced here):
// the annotated tag protects against accidental local mis-selection. An
// actor with local Git tag write access can recreate it. LIVE GitHub main
// (git ls-remote, not cached origin/main) + Railway /api/deployment revision
// binding reduces accidental mismatch. That is not cryptographic signer proof.
// Cached refs/remotes/origin/main is diagnostic only and never authorizes.

export const STEP2C_TAG = "nesta-step2c-cutover";
export const STEP2C_COMMIT = "38f5a80681ebd431c9952e83e043ceb23fed6454";

/** Historical freeze tag. Must remain at 4929ad7…; it is NOT a Step 2D.5 approval. */
export const HISTORICAL_FROZEN_TAG = "nesta-step2-cutover-ready";
export const HISTORICAL_FROZEN_COMMIT = "4929ad7381fbf6970d7abfbeda4ea4f58ca4799e";
export const FROZEN_TAG = HISTORICAL_FROZEN_TAG;

export const REVIEWED_CUTOVER_APPROVAL_MARKER = "NESTA_STEP2_REVIEWED_CUTOVER_APPROVAL_V1";
export const REVIEWED_CUTOVER_PURPOSE = "step2-production-cutover";
export const REVIEWED_CUTOVER_APPROVAL_VERSION = 1;
export const REVIEWED_CUTOVER_TAG = "nesta-step2d5-reviewed-cutover";

export const REVIEWED_CUTOVER_CANDIDATES = Object.freeze([
  Object.freeze({
    version: REVIEWED_CUTOVER_APPROVAL_VERSION,
    candidateTag: REVIEWED_CUTOVER_TAG,
    purpose: REVIEWED_CUTOVER_PURPOSE,
    annotationMarker: REVIEWED_CUTOVER_APPROVAL_MARKER,
  }),
]);

export const APPROVED_CUTOVER_CANDIDATE = REVIEWED_CUTOVER_CANDIDATES[0];
export const CUTOVER_CANDIDATE_TAG = APPROVED_CUTOVER_CANDIDATE.candidateTag;
export const REQUIRED_FREEZE_BRANCH = "main";

const FULL_SHA_RE = /^[a-f0-9]{40}$/;
const FORBIDDEN_TAGS = new Set([STEP2C_TAG, HISTORICAL_FROZEN_TAG]);
const GIT_TAG_OBJECT_PREFIX = /^object [0-9a-f]{40}\n/;

export function reviewedCutoverApprovalMessage(policy = APPROVED_CUTOVER_CANDIDATE) {
  return [
    policy.annotationMarker,
    `purpose=${policy.purpose}`,
    `version=${policy.version}`,
  ].join("\n");
}

export const REVIEWED_CUTOVER_APPROVAL_MESSAGE = reviewedCutoverApprovalMessage();

/**
 * Strict 3-line annotation grammar.
 * Normalize CRLF -> LF only. Do not trim tokens or collapse blank lines.
 * `git cat-file -p <tag>` blobs are reduced to the message after the first
 * blank line. After stripping at most one trailing newline (git convention),
 * the body must equal the canonical 3-line message exactly. Extra lines,
 * duplicates (identical or conflicting), whitespace, wrong order, substring
 * markers, and alternate case all FAIL.
 */
export function extractAnnotatedTagMessage(raw) {
  let text = String(raw || "").replace(/\r\n/g, "\n");
  if (GIT_TAG_OBJECT_PREFIX.test(text)) {
    const idx = text.indexOf("\n\n");
    if (idx < 0) return "";
    text = text.slice(idx + 2);
  }
  if (text.endsWith("\n")) text = text.slice(0, -1);
  return text;
}

export function annotationSatisfiesPolicy(annotation, policy = APPROVED_CUTOVER_CANDIDATE) {
  const expected = reviewedCutoverApprovalMessage(policy);
  return extractAnnotatedTagMessage(annotation) === expected;
}

export function lookupReviewedCandidate(tagName) {
  const name = String(tagName || "").trim();
  if (!name || FORBIDDEN_TAGS.has(name)) return null;
  return REVIEWED_CUTOVER_CANDIDATES.find((c) => c.candidateTag === name) || null;
}

/** Env may select BETWEEN policy tag names only. Unset uses the approved default. */
export function resolveReviewedCandidate(env = process.env) {
  const requested = String(env.NESTA_CUTOVER_CANDIDATE_TAG || "").trim();
  if (!requested) {
    return { ok: true, candidate: APPROVED_CUTOVER_CANDIDATE, requested: null };
  }
  const found = lookupReviewedCandidate(requested);
  if (!found) {
    return { ok: false, candidate: null, requested, reason: "unapproved candidate tag" };
  }
  return { ok: true, candidate: found, requested };
}

export function intendedCutoverCandidateTag(env = process.env) {
  const resolved = resolveReviewedCandidate(env);
  return resolved.ok ? resolved.candidate.candidateTag : (resolved.requested || CUTOVER_CANDIDATE_TAG);
}

export function inspectGitTag(tagName, gitValue, gitRaw) {
  if (!tagName || typeof gitValue !== "function") {
    return { type: null, annotation: null, peeledCommit: null };
  }
  const readRaw = typeof gitRaw === "function" ? gitRaw : gitValue;
  const type = gitValue(["cat-file", "-t", tagName]);
  if (!type) return { type: null, annotation: null, peeledCommit: null };
  if (type !== "tag") {
    return {
      type,
      annotation: null,
      peeledCommit: gitValue(["rev-parse", "--verify", tagName]) || null,
    };
  }
  return {
    type: "tag",
    annotation: readRaw(["cat-file", "-p", tagName]),
    peeledCommit: gitValue(["rev-parse", "--verify", `${tagName}^{commit}`]) || null,
  };
}

export function readOperatorGitFacts(gitValue) {
  const porcelain = typeof gitValue === "function" ? gitValue(["status", "--porcelain"]) : null;
  const branch = typeof gitValue === "function"
    ? gitValue(["symbolic-ref", "--quiet", "--short", "HEAD"])
    : null;
  const originMain = typeof gitValue === "function"
    ? gitValue(["rev-parse", "--verify", "origin/main"])
    : null;
  return {
    head: typeof gitValue === "function" ? gitValue(["rev-parse", "HEAD"]) : null,
    dirty: porcelain == null ? null : porcelain.length > 0,
    branch: branch || null,
    originMain: originMain || null,
  };
}

export function candidateFreezeInput({
  head,
  candidateTagCommit,
  dirty,
  candidateTag,
  tagType,
  tagAnnotation,
  branch,
  originMain,
} = {}) {
  return {
    head: head || null,
    tag: candidateTagCommit || null,
    expectedCommit: candidateTagCommit || null,
    dirty,
    candidateTag: candidateTag || null,
    tagType: tagType || null,
    tagAnnotation: tagAnnotation || null,
    branch: branch || null,
    originMain: originMain || null,
  };
}

/** Build freeze git state. Unapproved env tags are not inspected into trust. */
export function freezeGitFromResolved({
  env = {},
  head,
  dirty,
  inspectTag,
  branch,
  originMain,
} = {}) {
  const resolved = resolveReviewedCandidate(env);
  if (!resolved.ok) {
    return candidateFreezeInput({
      head,
      candidateTagCommit: null,
      dirty,
      candidateTag: resolved.requested,
      tagType: null,
      tagAnnotation: null,
      branch,
      originMain,
    });
  }
  const inspected = typeof inspectTag === "function"
    ? inspectTag(resolved.candidate.candidateTag)
    : { type: null, annotation: null, peeledCommit: null };
  return candidateFreezeInput({
    head,
    candidateTagCommit: inspected?.peeledCommit || null,
    dirty,
    candidateTag: resolved.candidate.candidateTag,
    tagType: inspected?.type || null,
    tagAnnotation: inspected?.annotation || null,
    branch,
    originMain,
  });
}

export function evaluateDeployFreeze(git = {}, env = {}) {
  const requestedTag = String(git.candidateTag || env.NESTA_CUTOVER_CANDIDATE_TAG || "").trim()
    || CUTOVER_CANDIDATE_TAG;
  const historicalStep2c = requestedTag === STEP2C_TAG;
  const historicalFrozen = requestedTag === HISTORICAL_FROZEN_TAG;
  const approved = lookupReviewedCandidate(requestedTag);
  const policyOk = Boolean(approved && requestedTag === approved.candidateTag);
  const head = git.head && FULL_SHA_RE.test(git.head) ? git.head : null;
  const tag = git.tag && FULL_SHA_RE.test(git.tag) ? git.tag : null;
  const dirtyUnknown = git.dirty == null;
  const dirty = git.dirty === true;
  const workingTreeClean = git.dirty === false;
  const annotated = git.tagType === "tag";
  const lightweight = git.tagType === "commit";
  const annotationOk = Boolean(approved && annotationSatisfiesPolicy(git.tagAnnotation, approved));
  const noApprovalBinding = !annotated || !annotationOk;
  const headMatch = Boolean(head && tag && head === tag);
  const tagMatch = headMatch;
  const detachedHead = git.branch == null || git.branch === "";
  const branchMatch = git.branch === REQUIRED_FREEZE_BRANCH;
  const pass = Boolean(
    policyOk
    && !historicalStep2c
    && !historicalFrozen
    && annotated
    && annotationOk
    && headMatch
    && workingTreeClean
    && !dirtyUnknown
    && !detachedHead
    && branchMatch,
  );
  return {
    deployFreeze: pass ? "PASS" : "FAIL",
    workingTreeClean: workingTreeClean ? "PASS" : "FAIL",
    tagMatch: tagMatch ? "PASS" : "FAIL",
    headMatch: headMatch ? "PASS" : "FAIL",
    annotatedApproval: annotated && annotationOk ? "PASS" : "FAIL",
    branchMatch: branchMatch ? "PASS" : "FAIL",
    reviewedCandidateApproved: policyOk,
    noApprovalBinding,
    lightweightTagRefused: lightweight,
    detachedHead,
    requiredBranch: REQUIRED_FREEZE_BRANCH,
    branch: git.branch || null,
    originMain: git.originMain || null,
    head,
    tag,
    frozenCommit: tag,
    frozenTag: HISTORICAL_FROZEN_TAG,
    cutoverCandidateTag: requestedTag,
    step2cTag: STEP2C_TAG,
    step2cCommit: STEP2C_COMMIT,
    dirty,
    historicalStep2cRefused: historicalStep2c,
    historicalFrozenTagRefused: historicalFrozen,
    unapprovedCandidateTag: !approved,
  };
}
