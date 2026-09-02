// Durable Step 2D.5 production migration attempt provenance.
// Stored in PostgreSQL table production_migration_attempts (schema 0018).
// Transitions are compare-and-swap on (status, phase, transition_epoch).
// File checkpoints and NESTA_PRODUCTION_ALLOW_RESUME never authorize a
// populated target. The human authorization phrase is never persisted.
import { randomUUID, createHash } from "crypto";
import { isTargetFingerprint } from "./pgTargetFingerprint.mjs";

export const PRODUCTION_MIGRATE_ATTEMPT_ID_ENV = "NESTA_PRODUCTION_MIGRATE_ATTEMPT_ID";

export const MIGRATION_PHASE = Object.freeze({
  WAVE1_INITIAL: "wave1-initial",
  FULL_AFTER_WAVE1: "full-after-wave1",
  RESUME_WAVE1: "resume-wave1",
  RESUME_FULL: "resume-full",
});

export const ATTEMPT_STATUS = Object.freeze({
  AUTHORIZED: "AUTHORIZED",
  WAVE1_IN_PROGRESS: "WAVE1_IN_PROGRESS",
  WAVE1_COMPLETE: "WAVE1_COMPLETE",
  FULL_IN_PROGRESS: "FULL_IN_PROGRESS",
  FULL_COMPLETE: "FULL_COMPLETE",
  FAILED: "FAILED",
});

export const ALLOWED_ATTEMPT_STATES = Object.freeze([
  Object.freeze({ status: ATTEMPT_STATUS.AUTHORIZED, phase: MIGRATION_PHASE.WAVE1_INITIAL }),
  Object.freeze({ status: ATTEMPT_STATUS.WAVE1_IN_PROGRESS, phase: MIGRATION_PHASE.WAVE1_INITIAL }),
  Object.freeze({ status: ATTEMPT_STATUS.WAVE1_IN_PROGRESS, phase: MIGRATION_PHASE.RESUME_WAVE1 }),
  Object.freeze({ status: ATTEMPT_STATUS.WAVE1_COMPLETE, phase: MIGRATION_PHASE.FULL_AFTER_WAVE1 }),
  Object.freeze({ status: ATTEMPT_STATUS.FULL_IN_PROGRESS, phase: MIGRATION_PHASE.FULL_AFTER_WAVE1 }),
  Object.freeze({ status: ATTEMPT_STATUS.FULL_IN_PROGRESS, phase: MIGRATION_PHASE.RESUME_FULL }),
  Object.freeze({ status: ATTEMPT_STATUS.FULL_COMPLETE, phase: MIGRATION_PHASE.FULL_AFTER_WAVE1 }),
  Object.freeze({ status: ATTEMPT_STATUS.FAILED, phase: MIGRATION_PHASE.WAVE1_INITIAL }),
  Object.freeze({ status: ATTEMPT_STATUS.FAILED, phase: MIGRATION_PHASE.RESUME_WAVE1 }),
  Object.freeze({ status: ATTEMPT_STATUS.FAILED, phase: MIGRATION_PHASE.FULL_AFTER_WAVE1 }),
  Object.freeze({ status: ATTEMPT_STATUS.FAILED, phase: MIGRATION_PHASE.RESUME_FULL }),
]);

const ALLOWED_TRANSITIONS = Object.freeze([
  [ATTEMPT_STATUS.AUTHORIZED, MIGRATION_PHASE.WAVE1_INITIAL, ATTEMPT_STATUS.WAVE1_IN_PROGRESS, MIGRATION_PHASE.WAVE1_INITIAL],
  [ATTEMPT_STATUS.AUTHORIZED, MIGRATION_PHASE.WAVE1_INITIAL, ATTEMPT_STATUS.WAVE1_IN_PROGRESS, MIGRATION_PHASE.RESUME_WAVE1],
  [ATTEMPT_STATUS.AUTHORIZED, MIGRATION_PHASE.WAVE1_INITIAL, ATTEMPT_STATUS.FAILED, MIGRATION_PHASE.WAVE1_INITIAL],
  [ATTEMPT_STATUS.WAVE1_IN_PROGRESS, MIGRATION_PHASE.WAVE1_INITIAL, ATTEMPT_STATUS.WAVE1_IN_PROGRESS, MIGRATION_PHASE.RESUME_WAVE1],
  [ATTEMPT_STATUS.WAVE1_IN_PROGRESS, MIGRATION_PHASE.WAVE1_INITIAL, ATTEMPT_STATUS.WAVE1_COMPLETE, MIGRATION_PHASE.FULL_AFTER_WAVE1],
  [ATTEMPT_STATUS.WAVE1_IN_PROGRESS, MIGRATION_PHASE.WAVE1_INITIAL, ATTEMPT_STATUS.FAILED, MIGRATION_PHASE.WAVE1_INITIAL],
  [ATTEMPT_STATUS.WAVE1_IN_PROGRESS, MIGRATION_PHASE.RESUME_WAVE1, ATTEMPT_STATUS.WAVE1_COMPLETE, MIGRATION_PHASE.FULL_AFTER_WAVE1],
  [ATTEMPT_STATUS.WAVE1_IN_PROGRESS, MIGRATION_PHASE.RESUME_WAVE1, ATTEMPT_STATUS.FAILED, MIGRATION_PHASE.RESUME_WAVE1],
  [ATTEMPT_STATUS.WAVE1_COMPLETE, MIGRATION_PHASE.FULL_AFTER_WAVE1, ATTEMPT_STATUS.FULL_IN_PROGRESS, MIGRATION_PHASE.FULL_AFTER_WAVE1],
  [ATTEMPT_STATUS.WAVE1_COMPLETE, MIGRATION_PHASE.FULL_AFTER_WAVE1, ATTEMPT_STATUS.FAILED, MIGRATION_PHASE.FULL_AFTER_WAVE1],
  [ATTEMPT_STATUS.FULL_IN_PROGRESS, MIGRATION_PHASE.FULL_AFTER_WAVE1, ATTEMPT_STATUS.FULL_IN_PROGRESS, MIGRATION_PHASE.RESUME_FULL],
  [ATTEMPT_STATUS.FULL_IN_PROGRESS, MIGRATION_PHASE.FULL_AFTER_WAVE1, ATTEMPT_STATUS.FULL_COMPLETE, MIGRATION_PHASE.FULL_AFTER_WAVE1],
  [ATTEMPT_STATUS.FULL_IN_PROGRESS, MIGRATION_PHASE.FULL_AFTER_WAVE1, ATTEMPT_STATUS.FAILED, MIGRATION_PHASE.FULL_AFTER_WAVE1],
  [ATTEMPT_STATUS.FULL_IN_PROGRESS, MIGRATION_PHASE.RESUME_FULL, ATTEMPT_STATUS.FULL_COMPLETE, MIGRATION_PHASE.FULL_AFTER_WAVE1],
  [ATTEMPT_STATUS.FULL_IN_PROGRESS, MIGRATION_PHASE.RESUME_FULL, ATTEMPT_STATUS.FAILED, MIGRATION_PHASE.RESUME_FULL],
  [ATTEMPT_STATUS.FAILED, MIGRATION_PHASE.WAVE1_INITIAL, ATTEMPT_STATUS.WAVE1_IN_PROGRESS, MIGRATION_PHASE.RESUME_WAVE1],
  [ATTEMPT_STATUS.FAILED, MIGRATION_PHASE.RESUME_WAVE1, ATTEMPT_STATUS.WAVE1_IN_PROGRESS, MIGRATION_PHASE.RESUME_WAVE1],
  [ATTEMPT_STATUS.FAILED, MIGRATION_PHASE.FULL_AFTER_WAVE1, ATTEMPT_STATUS.FULL_IN_PROGRESS, MIGRATION_PHASE.RESUME_FULL],
  [ATTEMPT_STATUS.FAILED, MIGRATION_PHASE.RESUME_FULL, ATTEMPT_STATUS.FULL_IN_PROGRESS, MIGRATION_PHASE.RESUME_FULL],
]);

const PHASES = new Set(Object.values(MIGRATION_PHASE));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function checkpointPhaseFamily(phase) {
  if (phase === MIGRATION_PHASE.WAVE1_INITIAL || phase === MIGRATION_PHASE.RESUME_WAVE1) {
    return "wave1";
  }
  if (phase === MIGRATION_PHASE.FULL_AFTER_WAVE1 || phase === MIGRATION_PHASE.RESUME_FULL) {
    return "full";
  }
  return phase;
}

export function isAttemptUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isAllowedAttemptState(status, phase) {
  return ALLOWED_ATTEMPT_STATES.some((row) => row.status === status && row.phase === phase);
}

export function assertAttemptTransition(fromStatus, fromPhase, toStatus, toPhase) {
  if (!isAllowedAttemptState(toStatus, toPhase)) {
    throw new Error("NO-GO: illegal migration attempt state");
  }
  if (fromStatus == null) {
    if (toStatus !== ATTEMPT_STATUS.AUTHORIZED || toPhase !== MIGRATION_PHASE.WAVE1_INITIAL) {
      throw new Error("NO-GO: new migration attempts must start AUTHORIZED/wave1-initial");
    }
    return;
  }
  if (fromStatus === ATTEMPT_STATUS.FULL_COMPLETE) {
    throw new Error("NO-GO: completed migration attempt cannot be replayed");
  }
  if (fromStatus === toStatus && fromPhase === toPhase) return;
  const ok = ALLOWED_TRANSITIONS.some((row) => (
    row[0] === fromStatus && row[1] === fromPhase && row[2] === toStatus && row[3] === toPhase
  ));
  if (!ok) throw new Error("NO-GO: illegal migration attempt transition");
}

export function requestedAttemptId(env = {}) {
  const raw = env[PRODUCTION_MIGRATE_ATTEMPT_ID_ENV];
  if (raw == null || raw === "") return "";
  if (typeof raw !== "string" || !isAttemptUuid(raw)) return "";
  return raw;
}

export function freezeIdentityFromEvidence(doc = {}) {
  const payload = JSON.stringify({
    generatedAt: String(doc.generatedAt || ""),
    firebaseProject: String(doc.firebaseProject || ""),
    candidateCommit: String(doc.candidateCommit || ""),
    cutoverWindowIdentity: String(doc.cutoverWindowIdentity || ""),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function attemptBindingFromContext({
  targetFingerprint,
  candidateCommit,
  reviewedTag,
  cutoverWindowIdentity,
  freezeEvidence,
  firebaseProject,
} = {}) {
  return {
    targetFingerprint,
    candidateCommit,
    reviewedTag,
    cutoverWindowIdentity,
    freezeGeneratedAt: freezeEvidence?.generatedAt || "",
    freezeIdentity: freezeIdentityFromEvidence(freezeEvidence || {}),
    firebaseProject: firebaseProject || freezeEvidence?.firebaseProject || "",
  };
}

export function bindingsMatch(attempt, binding) {
  if (!attempt || !binding) return false;
  return attempt.target_fingerprint === binding.targetFingerprint
    && attempt.candidate_commit === binding.candidateCommit
    && attempt.reviewed_tag === binding.reviewedTag
    && attempt.cutover_window_identity === binding.cutoverWindowIdentity
    && attempt.freeze_identity === binding.freezeIdentity
    && String(attempt.firebase_project) === String(binding.firebaseProject);
}

function fail(reason) {
  return {
    ok: false,
    reason,
    allowPopulatedTarget: false,
    create: false,
    attempt: null,
    nextStatus: null,
    nextPhase: null,
  };
}

export function evaluateMigrationPhaseAdmission({
  phase,
  restaurants,
  attempt = null,
  requestedAttemptId: requestId = "",
  binding,
  explicitCreateAuthorized = false,
} = {}) {
  if (!PHASES.has(phase)) return fail("unknown migration phase");
  if (!binding || !isTargetFingerprint(binding.targetFingerprint)) {
    return fail("target fingerprint binding is missing");
  }
  if (!binding.candidateCommit || !binding.cutoverWindowIdentity || !binding.freezeIdentity) {
    return fail("attempt binding is incomplete");
  }
  const count = Number(restaurants);
  if (!Number.isFinite(count) || count < 0) return fail("restaurant count is unavailable");

  if (phase === MIGRATION_PHASE.WAVE1_INITIAL) {
    if (!explicitCreateAuthorized) {
      return fail("explicit production apply authorization required to create a migration attempt");
    }
    if (requestId) {
      return fail("wave1-initial cannot reuse an existing attempt id");
    }
    if (count !== 0) {
      return fail("wave1-initial requires an empty production target (restaurants = 0)");
    }
    if (attempt) {
      return fail("a migration attempt already exists for this target, commit, window, and freeze");
    }
    return {
      ok: true,
      reason: null,
      allowPopulatedTarget: false,
      create: true,
      attempt: null,
      nextStatus: ATTEMPT_STATUS.WAVE1_IN_PROGRESS,
      nextPhase: MIGRATION_PHASE.WAVE1_INITIAL,
    };
  }

  if (!requestId || !isAttemptUuid(requestId)) {
    return fail("NESTA_PRODUCTION_MIGRATE_ATTEMPT_ID is required");
  }
  if (!attempt) {
    return fail("no matching durable migration attempt");
  }
  if (attempt.attempt_id !== requestId) {
    return fail("durable attempt id does not match NESTA_PRODUCTION_MIGRATE_ATTEMPT_ID");
  }
  if (!bindingsMatch(attempt, binding)) {
    if (attempt.target_fingerprint !== binding.targetFingerprint) {
      return fail("durable attempt belongs to a different PostgreSQL target");
    }
    if (attempt.candidate_commit !== binding.candidateCommit) {
      return fail("durable attempt belongs to a different reviewed commit");
    }
    if (attempt.cutover_window_identity !== binding.cutoverWindowIdentity) {
      return fail("durable attempt belongs to a different cutover window");
    }
    if (attempt.freeze_identity !== binding.freezeIdentity) {
      return fail("durable attempt belongs to a different source freeze");
    }
    return fail("durable attempt binding does not match the current cutover");
  }
  if (attempt.status === ATTEMPT_STATUS.FULL_COMPLETE) {
    return fail("completed migration attempt cannot be replayed");
  }

  if (phase === MIGRATION_PHASE.RESUME_WAVE1) {
    if (attempt.status === ATTEMPT_STATUS.WAVE1_COMPLETE) {
      return fail("Wave1 is already complete; use full-after-wave1");
    }
    if (attempt.status !== ATTEMPT_STATUS.WAVE1_IN_PROGRESS
      && attempt.status !== ATTEMPT_STATUS.AUTHORIZED
      && attempt.status !== ATTEMPT_STATUS.FAILED) {
      return fail("durable attempt is not resumable for Wave1");
    }
    if (attempt.phase !== MIGRATION_PHASE.WAVE1_INITIAL && attempt.phase !== MIGRATION_PHASE.RESUME_WAVE1) {
      return fail("durable attempt is not in a Wave1 phase");
    }
    return {
      ok: true,
      reason: null,
      allowPopulatedTarget: count > 0,
      create: false,
      attempt,
      nextStatus: ATTEMPT_STATUS.WAVE1_IN_PROGRESS,
      nextPhase: MIGRATION_PHASE.RESUME_WAVE1,
    };
  }

  if (phase === MIGRATION_PHASE.FULL_AFTER_WAVE1) {
    if (attempt.status !== ATTEMPT_STATUS.WAVE1_COMPLETE || attempt.phase !== MIGRATION_PHASE.FULL_AFTER_WAVE1) {
      return fail("full migration requires a matching WAVE1_COMPLETE attempt on this target");
    }
    if (count <= 0) {
      return fail("full-after-wave1 requires the Wave1-populated production target");
    }
    return {
      ok: true,
      reason: null,
      allowPopulatedTarget: true,
      create: false,
      attempt,
      nextStatus: ATTEMPT_STATUS.FULL_IN_PROGRESS,
      nextPhase: MIGRATION_PHASE.FULL_AFTER_WAVE1,
    };
  }

  if (phase === MIGRATION_PHASE.RESUME_FULL) {
    if (attempt.status !== ATTEMPT_STATUS.FULL_IN_PROGRESS && attempt.status !== ATTEMPT_STATUS.FAILED) {
      return fail("durable attempt is not resumable for full migration");
    }
    if (attempt.status === ATTEMPT_STATUS.FAILED && attempt.phase !== MIGRATION_PHASE.FULL_AFTER_WAVE1
      && attempt.phase !== MIGRATION_PHASE.RESUME_FULL) {
      return fail("FAILED attempt is not a full-migration recovery");
    }
    if (count <= 0) {
      return fail("resume-full requires the Wave1-populated production target");
    }
    return {
      ok: true,
      reason: null,
      allowPopulatedTarget: true,
      create: false,
      attempt,
      nextStatus: ATTEMPT_STATUS.FULL_IN_PROGRESS,
      nextPhase: MIGRATION_PHASE.RESUME_FULL,
    };
  }

  return fail("unhandled migration phase");
}

export function newAttemptRow(binding, { now = new Date(), phase = MIGRATION_PHASE.WAVE1_INITIAL } = {}) {
  const started = now instanceof Date ? now : new Date(now);
  const iso = started.toISOString();
  return {
    attempt_id: randomUUID(),
    target_fingerprint: binding.targetFingerprint,
    candidate_commit: binding.candidateCommit,
    reviewed_tag: binding.reviewedTag,
    cutover_window_identity: binding.cutoverWindowIdentity,
    firebase_project: binding.firebaseProject,
    freeze_generated_at: binding.freezeGeneratedAt,
    freeze_identity: binding.freezeIdentity,
    phase,
    status: ATTEMPT_STATUS.AUTHORIZED,
    transition_epoch: 0,
    wave1_batch_id: null,
    full_checkpoint_id: null,
    started_at: iso,
    updated_at: iso,
  };
}

function cloneRow(row) {
  return row ? { ...row } : null;
}

function applyCas(current, spec) {
  if (current.status !== spec.expectedStatus || current.phase !== spec.expectedPhase) {
    throw new Error("NO-GO: migration attempt transition conflict");
  }
  const expectedEpoch = Number(spec.expectedEpoch ?? current.transition_epoch ?? 0);
  if (Number(current.transition_epoch ?? 0) !== expectedEpoch) {
    throw new Error("NO-GO: migration attempt transition conflict");
  }
  assertAttemptTransition(spec.expectedStatus, spec.expectedPhase, spec.nextStatus, spec.nextPhase);
  return {
    ...current,
    status: spec.nextStatus,
    phase: spec.nextPhase,
    transition_epoch: expectedEpoch + 1,
    wave1_batch_id: spec.wave1_batch_id === undefined ? current.wave1_batch_id : spec.wave1_batch_id,
    full_checkpoint_id: spec.full_checkpoint_id === undefined ? current.full_checkpoint_id : spec.full_checkpoint_id,
    updated_at: new Date().toISOString(),
  };
}

export function createMemoryAttemptStore(seed = []) {
  const rows = new Map();
  for (const row of seed) rows.set(row.attempt_id, cloneRow(row));
  return {
    kind: "memory",
    async insert(row) {
      assertAttemptTransition(null, null, row.status, row.phase);
      if (rows.has(row.attempt_id)) throw new Error("NO-GO: migration attempt id already exists");
      for (const existing of rows.values()) {
        if (existing.target_fingerprint === row.target_fingerprint
          && existing.candidate_commit === row.candidate_commit
          && existing.cutover_window_identity === row.cutover_window_identity
          && existing.freeze_identity === row.freeze_identity) {
          throw new Error("NO-GO: a migration attempt already exists for this binding");
        }
      }
      const stored = { transition_epoch: 0, ...cloneRow(row) };
      rows.set(row.attempt_id, stored);
      return cloneRow(stored);
    },
    async getById(id) {
      return cloneRow(rows.get(id) || null);
    },
    async findByBinding(binding) {
      for (const row of rows.values()) {
        if (row.target_fingerprint === binding.targetFingerprint
          && row.candidate_commit === binding.candidateCommit
          && row.cutover_window_identity === binding.cutoverWindowIdentity
          && row.freeze_identity === binding.freezeIdentity) {
          return cloneRow(row);
        }
      }
      return null;
    },
    async cas(spec) {
      const current = rows.get(spec.id);
      if (!current) throw new Error("NO-GO: migration attempt not found");
      const next = applyCas(current, spec);
      rows.set(spec.id, next);
      return cloneRow(next);
    },
  };
}

function mapAttemptRow(row) {
  if (!row) return null;
  return {
    attempt_id: row.attempt_id,
    target_fingerprint: row.target_fingerprint,
    candidate_commit: row.candidate_commit,
    reviewed_tag: row.reviewed_tag,
    cutover_window_identity: row.cutover_window_identity,
    firebase_project: row.firebase_project,
    freeze_generated_at: row.freeze_generated_at instanceof Date
      ? row.freeze_generated_at.toISOString()
      : row.freeze_generated_at,
    freeze_identity: row.freeze_identity,
    phase: row.phase,
    status: row.status,
    transition_epoch: Number(row.transition_epoch ?? 0),
    wave1_batch_id: row.wave1_batch_id,
    full_checkpoint_id: row.full_checkpoint_id,
    started_at: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function missingTable(err) {
  const msg = String(err?.message || err);
  return /production_migration_attempts/i.test(msg) && /does not exist/i.test(msg);
}

export function createPgAttemptStore(client) {
  return {
    kind: "postgres",
    async insert(row) {
      assertAttemptTransition(null, null, row.status, row.phase);
      try {
        const result = await client.query(
          `INSERT INTO production_migration_attempts (
            attempt_id, target_fingerprint, candidate_commit, reviewed_tag,
            cutover_window_identity, firebase_project, freeze_generated_at,
            freeze_identity, phase, status, transition_epoch, wave1_batch_id, full_checkpoint_id,
            started_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          RETURNING *`,
          [
            row.attempt_id,
            row.target_fingerprint,
            row.candidate_commit,
            row.reviewed_tag,
            row.cutover_window_identity,
            row.firebase_project,
            row.freeze_generated_at,
            row.freeze_identity,
            row.phase,
            row.status,
            row.transition_epoch ?? 0,
            row.wave1_batch_id,
            row.full_checkpoint_id,
            row.started_at,
            row.updated_at,
          ],
        );
        return mapAttemptRow(result.rows[0]);
      } catch (err) {
        if (missingTable(err)) {
          throw new Error("NO-GO: production_migration_attempts is missing; schema 0018 is required");
        }
        if (/uq_production_migration_attempts_binding/i.test(String(err?.message || err)) || err?.code === "23505") {
          throw new Error("NO-GO: a migration attempt already exists for this binding");
        }
        throw new Error("NO-GO: failed to persist migration attempt");
      }
    },
    async getById(id) {
      try {
        const result = await client.query(
          "SELECT * FROM production_migration_attempts WHERE attempt_id = $1",
          [id],
        );
        return mapAttemptRow(result.rows[0] || null);
      } catch (err) {
        if (missingTable(err)) {
          throw new Error("NO-GO: production_migration_attempts is missing; schema 0018 is required");
        }
        throw new Error("NO-GO: failed to read migration attempt");
      }
    },
    async findByBinding(binding) {
      try {
        const result = await client.query(
          `SELECT * FROM production_migration_attempts
           WHERE target_fingerprint = $1
             AND candidate_commit = $2
             AND cutover_window_identity = $3
             AND freeze_identity = $4`,
          [
            binding.targetFingerprint,
            binding.candidateCommit,
            binding.cutoverWindowIdentity,
            binding.freezeIdentity,
          ],
        );
        return mapAttemptRow(result.rows[0] || null);
      } catch (err) {
        if (missingTable(err)) {
          throw new Error("NO-GO: production_migration_attempts is missing; schema 0018 is required");
        }
        throw new Error("NO-GO: failed to read migration attempt");
      }
    },
    async cas(spec) {
      assertAttemptTransition(spec.expectedStatus, spec.expectedPhase, spec.nextStatus, spec.nextPhase);
      try {
        const result = await client.query(
          `UPDATE production_migration_attempts SET
            phase = $5, status = $6, wave1_batch_id = COALESCE($7, wave1_batch_id),
            full_checkpoint_id = COALESCE($8, full_checkpoint_id),
            transition_epoch = transition_epoch + 1,
            updated_at = $9
           WHERE attempt_id = $1
             AND status = $2
             AND phase = $3
             AND transition_epoch = $4
           RETURNING *`,
          [
            spec.id,
            spec.expectedStatus,
            spec.expectedPhase,
            Number(spec.expectedEpoch ?? 0),
            spec.nextPhase,
            spec.nextStatus,
            spec.wave1_batch_id === undefined ? null : spec.wave1_batch_id,
            spec.full_checkpoint_id === undefined ? null : spec.full_checkpoint_id,
            new Date().toISOString(),
          ],
        );
        if (!result.rows[0]) {
          throw new Error("NO-GO: migration attempt transition conflict");
        }
        return mapAttemptRow(result.rows[0]);
      } catch (err) {
        if (String(err?.message || err).startsWith("NO-GO:")) throw err;
        throw new Error("NO-GO: failed to update migration attempt");
      }
    },
  };
}

export async function casAttempt(store, row, patch) {
  return store.cas({
    id: row.attempt_id,
    expectedStatus: row.status,
    expectedPhase: row.phase,
    expectedEpoch: row.transition_epoch ?? 0,
    nextStatus: patch.nextStatus ?? row.status,
    nextPhase: patch.nextPhase ?? row.phase,
    wave1_batch_id: patch.wave1_batch_id,
    full_checkpoint_id: patch.full_checkpoint_id,
  });
}

export async function prepareAttemptAdmission({
  store,
  phase,
  restaurants,
  env = {},
  binding,
  explicitCreateAuthorized = false,
} = {}) {
  const requestId = requestedAttemptId(env);
  let attempt = null;
  if (requestId) attempt = await store.getById(requestId);
  if (!attempt) attempt = await store.findByBinding(binding);
  const admission = evaluateMigrationPhaseAdmission({
    phase,
    restaurants,
    attempt,
    requestedAttemptId: requestId,
    binding,
    explicitCreateAuthorized,
  });
  return { admission, attempt, requestId };
}

export async function persistPreparedAttempt({
  store,
  admission,
  binding,
  now = new Date(),
} = {}) {
  if (!admission?.ok) throw new Error(`NO-GO: ${admission?.reason || "attempt admission failed"}`);
  if (admission.create) {
    const created = await store.insert(newAttemptRow(binding, { now, phase: MIGRATION_PHASE.WAVE1_INITIAL }));
    return store.cas({
      id: created.attempt_id,
      expectedStatus: ATTEMPT_STATUS.AUTHORIZED,
      expectedPhase: MIGRATION_PHASE.WAVE1_INITIAL,
      expectedEpoch: created.transition_epoch ?? 0,
      nextStatus: ATTEMPT_STATUS.WAVE1_IN_PROGRESS,
      nextPhase: MIGRATION_PHASE.WAVE1_INITIAL,
    });
  }
  return store.cas({
    id: admission.attempt.attempt_id,
    expectedStatus: admission.attempt.status,
    expectedPhase: admission.attempt.phase,
    expectedEpoch: admission.attempt.transition_epoch ?? 0,
    nextStatus: admission.nextStatus,
    nextPhase: admission.nextPhase,
  });
}

export async function admitAndPersistAttempt(args) {
  const prepared = await prepareAttemptAdmission(args);
  if (!prepared.admission.ok) {
    throw new Error(`NO-GO: ${prepared.admission.reason}`);
  }
  const attempt = await persistPreparedAttempt({
    store: args.store,
    admission: prepared.admission,
    binding: args.binding,
    now: args.now,
  });
  return { ...prepared.admission, attempt };
}
