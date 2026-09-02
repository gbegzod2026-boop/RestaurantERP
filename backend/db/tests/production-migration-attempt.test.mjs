import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTEMPT_STATUS,
  MIGRATION_PHASE,
  ALLOWED_ATTEMPT_STATES,
  isAllowedAttemptState,
  assertAttemptTransition,
  createMemoryAttemptStore,
  createPgAttemptStore,
  casAttempt,
  persistPreparedAttempt,
  evaluateMigrationPhaseAdmission,
  newAttemptRow,
  attemptBindingFromContext,
} from "../scripts/lib/productionMigrationAttempt.mjs";
import { exampleLiveTargetFingerprint } from "../scripts/lib/pgTargetFingerprint.mjs";

const binding = attemptBindingFromContext({
  targetFingerprint: exampleLiveTargetFingerprint(),
  candidateCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  reviewedTag: "nesta-step2d5-reviewed-cutover",
  cutoverWindowIdentity: "window",
  freezeEvidence: {
    generatedAt: "2026-08-31T10:15:00.000Z",
    firebaseProject: "restoran-30d51",
    candidateCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    cutoverWindowIdentity: "window",
  },
  firebaseProject: "restoran-30d51",
});

function authorizedRow() {
  return newAttemptRow(binding, { now: new Date("2026-08-31T10:30:00.000Z") });
}

test("valid phase/status combinations are accepted; illegal ones are rejected", () => {
  for (const row of ALLOWED_ATTEMPT_STATES) {
    assert.equal(isAllowedAttemptState(row.status, row.phase), true);
  }
  assert.equal(isAllowedAttemptState(ATTEMPT_STATUS.FULL_COMPLETE, MIGRATION_PHASE.WAVE1_INITIAL), false);
  assert.equal(isAllowedAttemptState(ATTEMPT_STATUS.WAVE1_COMPLETE, MIGRATION_PHASE.RESUME_FULL), false);
  assert.equal(isAllowedAttemptState(ATTEMPT_STATUS.WAVE1_COMPLETE, MIGRATION_PHASE.WAVE1_INITIAL), false);
  assert.equal(isAllowedAttemptState(ATTEMPT_STATUS.AUTHORIZED, MIGRATION_PHASE.FULL_AFTER_WAVE1), false);
  assert.throws(
    () => assertAttemptTransition(
      ATTEMPT_STATUS.WAVE1_COMPLETE,
      MIGRATION_PHASE.FULL_AFTER_WAVE1,
      ATTEMPT_STATUS.AUTHORIZED,
      MIGRATION_PHASE.WAVE1_INITIAL,
    ),
    /illegal migration attempt transition/,
  );
  assert.throws(
    () => assertAttemptTransition(
      ATTEMPT_STATUS.FULL_COMPLETE,
      MIGRATION_PHASE.FULL_AFTER_WAVE1,
      ATTEMPT_STATUS.FAILED,
      MIGRATION_PHASE.FULL_AFTER_WAVE1,
    ),
    /cannot be replayed/,
  );
});

test("concurrent AUTHORIZED -> WAVE1_IN_PROGRESS: only one succeeds", async () => {
  const created = authorizedRow();
  const store = createMemoryAttemptStore([created]);
  const spec = {
    nextStatus: ATTEMPT_STATUS.WAVE1_IN_PROGRESS,
    nextPhase: MIGRATION_PHASE.WAVE1_INITIAL,
  };
  const results = await Promise.allSettled([
    casAttempt(store, created, spec),
    casAttempt(store, created, spec),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 1);
  assert.match(String(bad[0].reason), /transition conflict/);
  const row = await store.getById(created.attempt_id);
  assert.equal(row.status, ATTEMPT_STATUS.WAVE1_IN_PROGRESS);
  assert.equal(row.transition_epoch, 1);
});

test("concurrent WAVE1_COMPLETE -> FULL_IN_PROGRESS: only one succeeds", async () => {
  const created = {
    ...authorizedRow(),
    status: ATTEMPT_STATUS.WAVE1_COMPLETE,
    phase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
    transition_epoch: 2,
  };
  const store = createMemoryAttemptStore([created]);
  const spec = {
    nextStatus: ATTEMPT_STATUS.FULL_IN_PROGRESS,
    nextPhase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
  };
  const results = await Promise.allSettled([
    casAttempt(store, created, spec),
    casAttempt(store, created, spec),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 1);
  assert.match(String(bad[0].reason), /transition conflict/);
  const row = await store.getById(created.attempt_id);
  assert.equal(row.status, ATTEMPT_STATUS.FULL_IN_PROGRESS);
});

test("FULL_COMPLETE cannot be overwritten by FAILED", async () => {
  const created = {
    ...authorizedRow(),
    status: ATTEMPT_STATUS.FULL_COMPLETE,
    phase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
    transition_epoch: 4,
  };
  const store = createMemoryAttemptStore([created]);
  await assert.rejects(
    () => casAttempt(store, created, {
      nextStatus: ATTEMPT_STATUS.FAILED,
      nextPhase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
    }),
    /cannot be replayed/,
  );
  const row = await store.getById(created.attempt_id);
  assert.equal(row.status, ATTEMPT_STATUS.FULL_COMPLETE);
});

test("terminal replay is rejected", async () => {
  const created = {
    ...authorizedRow(),
    status: ATTEMPT_STATUS.FULL_COMPLETE,
    phase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
    transition_epoch: 4,
  };
  const store = createMemoryAttemptStore([created]);
  await assert.rejects(
    () => casAttempt(store, created, {
      nextStatus: ATTEMPT_STATUS.FULL_COMPLETE,
      nextPhase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
    }),
    /cannot be replayed/,
  );
  const admission = evaluateMigrationPhaseAdmission({
    phase: MIGRATION_PHASE.RESUME_FULL,
    restaurants: 2,
    attempt: created,
    requestedAttemptId: created.attempt_id,
    binding,
    explicitCreateAuthorized: true,
  });
  assert.equal(admission.ok, false);
  assert.match(admission.reason, /cannot be replayed/);
});

test("duplicate full processes conflict on the same WAVE1_COMPLETE row", async () => {
  const created = {
    ...authorizedRow(),
    status: ATTEMPT_STATUS.WAVE1_COMPLETE,
    phase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
    transition_epoch: 2,
  };
  const store = createMemoryAttemptStore([created]);
  const admission = {
    ok: true,
    create: false,
    attempt: created,
    nextStatus: ATTEMPT_STATUS.FULL_IN_PROGRESS,
    nextPhase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
  };
  const results = await Promise.allSettled([
    persistPreparedAttempt({ store, admission, binding }),
    persistPreparedAttempt({ store, admission, binding }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
});

function pgCasClient(seed) {
  let row = { ...seed };
  const updates = [];
  return {
    updates,
    current: () => row,
    async query(sql, params) {
      const s = String(sql);
      if (!s.includes("UPDATE production_migration_attempts")) {
        throw new Error(`unexpected sql: ${s.slice(0, 80)}`);
      }
      assert.match(s, /AND status = \$2/);
      assert.match(s, /AND phase = \$3/);
      assert.match(s, /AND transition_epoch = \$4/);
      const [id, expectedStatus, expectedPhase, expectedEpoch, nextPhase, nextStatus] = params;
      updates.push({ id, expectedStatus, expectedPhase, expectedEpoch, nextPhase, nextStatus });
      if (
        row.attempt_id === id
        && row.status === expectedStatus
        && row.phase === expectedPhase
        && Number(row.transition_epoch) === Number(expectedEpoch)
      ) {
        row = {
          ...row,
          phase: nextPhase,
          status: nextStatus,
          transition_epoch: Number(row.transition_epoch) + 1,
          updated_at: new Date().toISOString(),
        };
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };
}

test("PG store CAS predicate rejects a lost race and never writes FULL_COMPLETE -> FAILED", async () => {
  const created = authorizedRow();
  const client = pgCasClient(created);
  const store = createPgAttemptStore(client);
  const first = await casAttempt(store, created, {
    nextStatus: ATTEMPT_STATUS.WAVE1_IN_PROGRESS,
    nextPhase: MIGRATION_PHASE.WAVE1_INITIAL,
  });
  await assert.rejects(
    () => casAttempt(store, created, {
      nextStatus: ATTEMPT_STATUS.WAVE1_IN_PROGRESS,
      nextPhase: MIGRATION_PHASE.WAVE1_INITIAL,
    }),
    /transition conflict/,
  );
  assert.equal(first.status, ATTEMPT_STATUS.WAVE1_IN_PROGRESS);
  assert.equal(client.current().status, ATTEMPT_STATUS.WAVE1_IN_PROGRESS);

  const complete = {
    ...client.current(),
    status: ATTEMPT_STATUS.FULL_COMPLETE,
    phase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
  };
  const completeClient = pgCasClient(complete);
  const completeStore = createPgAttemptStore(completeClient);
  await assert.rejects(
    () => casAttempt(completeStore, complete, {
      nextStatus: ATTEMPT_STATUS.FAILED,
      nextPhase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
    }),
    /cannot be replayed/,
  );
  assert.equal(completeClient.updates.length, 0);
  assert.equal(completeClient.current().status, ATTEMPT_STATUS.FULL_COMPLETE);
});
