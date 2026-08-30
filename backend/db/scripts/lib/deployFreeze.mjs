// Historical Step 2C migration artifact. Do not reset --hard to this.
export const STEP2C_TAG = "nesta-step2c-cutover";
export const STEP2C_COMMIT = "38f5a80681ebd431c9952e83e043ceb23fed6454";

// Current production cutover candidate. Deploy freeze requires HEAD + this tag.
export const CUTOVER_CANDIDATE_TAG = "nesta-step2-cutover-ready";
export const FROZEN_TAG = CUTOVER_CANDIDATE_TAG;

export function candidateFreezeInput({ head, candidateTagCommit, dirty } = {}) {
  return {
    head: head || null,
    tag: candidateTagCommit || null,
    expectedCommit: candidateTagCommit || null,
    dirty,
  };
}

export function evaluateDeployFreeze(git = {}) {
  const expected = git.expectedCommit || git.tag || null;
  const head = git.head || null;
  const tag = git.tag || null;
  const dirty = git.dirty === true;
  const headMatch = Boolean(expected && head && head === expected);
  const tagMatch = Boolean(expected && tag && tag === expected);
  const workingTreeClean = git.dirty === false;
  const pass = headMatch && tagMatch && workingTreeClean;
  return {
    deployFreeze: pass ? "PASS" : "FAIL",
    workingTreeClean: workingTreeClean ? "PASS" : "FAIL",
    tagMatch: tagMatch ? "PASS" : "FAIL",
    headMatch: headMatch ? "PASS" : "FAIL",
    head,
    tag,
    frozenCommit: expected,
    frozenTag: FROZEN_TAG,
    cutoverCandidateTag: CUTOVER_CANDIDATE_TAG,
    step2cTag: STEP2C_TAG,
    step2cCommit: STEP2C_COMMIT,
    dirty,
  };
}
