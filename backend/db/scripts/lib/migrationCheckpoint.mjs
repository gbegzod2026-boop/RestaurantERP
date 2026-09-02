// Production migration checkpoint helpers.
// Checkpoint writes happen only after the restaurant transaction COMMIT
// succeeds. Legacy unbound checkpoints never authorize production resume.
// File replacement is temp-write + fsync + rename so a crash cannot leave
// a truncated final checkpoint.
import {
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "fs";
import { randomUUID } from "crypto";
import path from "path";

export const CHECKPOINT_VERSION = 2;

export function emptyCheckpoint(binding = null) {
  return {
    version: CHECKPOINT_VERSION,
    completedRestaurants: {},
    startedAt: null,
    binding,
  };
}

export function checkpointBinding(fields = {}) {
  return {
    attemptId: fields.attemptId || "",
    targetFingerprint: fields.targetFingerprint || "",
    candidateCommit: fields.candidateCommit || "",
    cutoverWindowIdentity: fields.cutoverWindowIdentity || "",
    phase: fields.phase || "",
    freezeIdentity: fields.freezeIdentity || "",
    checkpointVersion: CHECKPOINT_VERSION,
    batchId: fields.batchId || "",
  };
}

export function assertCheckpointBinding(checkpoint, expected) {
  const binding = checkpoint?.binding;
  if (!binding || typeof binding !== "object") {
    throw new Error("NO-GO: legacy unbound checkpoint cannot authorize production resume");
  }
  if (Number(checkpoint.version) !== CHECKPOINT_VERSION) {
    throw new Error("NO-GO: checkpoint version cannot authorize production resume");
  }
  const checks = [
    ["attemptId", expected.attemptId],
    ["targetFingerprint", expected.targetFingerprint],
    ["candidateCommit", expected.candidateCommit],
    ["cutoverWindowIdentity", expected.cutoverWindowIdentity],
    ["phase", expected.phase],
    ["freezeIdentity", expected.freezeIdentity],
  ];
  for (const [key, value] of checks) {
    if (!value || binding[key] !== value) {
      throw new Error(`NO-GO: checkpoint ${key} does not match the durable migration attempt`);
    }
  }
}

export function restaurantCompleted(checkpoint, restId) {
  return checkpoint?.completedRestaurants?.[restId] === true;
}

export function withRestaurantCompleted(checkpoint, restId) {
  return {
    ...checkpoint,
    version: CHECKPOINT_VERSION,
    completedRestaurants: {
      ...(checkpoint.completedRestaurants || {}),
      [restId]: true,
    },
  };
}

export function defaultAtomicWriteIo() {
  return {
    mkdirSync,
    openSync,
    writeFileSync,
    fsyncSync,
    closeSync,
    renameSync,
    unlinkSync,
    randomUUID,
  };
}

/**
 * Write JSON by completing a unique temp file in the same directory, then
 * renaming over the destination. A failed temp write cannot replace a
 * previously valid checkpoint.
 */
export function atomicWriteJsonFile(filePath, value, io = defaultAtomicWriteIo()) {
  const dir = path.dirname(filePath);
  io.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(filePath)}.${io.randomUUID()}.tmp`);
  let fd = null;
  try {
    const json = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    fd = io.openSync(tmp, "w");
    io.writeFileSync(fd, json, "utf8");
    if (typeof io.fsyncSync === "function") io.fsyncSync(fd);
    io.closeSync(fd);
    fd = null;
    io.renameSync(tmp, filePath);
  } catch (err) {
    if (fd != null) {
      try { io.closeSync(fd); } catch { /* ignore */ }
    }
    try { io.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * COMMIT (or ROLLBACK for dry-run) first. Only then persist completion.
 * If persist throws after COMMIT, in-memory checkpoint is left unmarked so
 * a later process rediscovers committed rows via idempotent upserts.
 */
export async function commitRestaurantThenCheckpoint({
  client,
  mode,
  checkpoint,
  restId,
  persist,
} = {}) {
  if (!client || typeof client.query !== "function") {
    throw new Error("restaurant transaction client is required");
  }
  if (mode === "apply") {
    await client.query("COMMIT");
  } else {
    await client.query("ROLLBACK");
  }
  const next = withRestaurantCompleted(checkpoint, restId);
  persist(next);
  checkpoint.completedRestaurants = next.completedRestaurants;
  checkpoint.version = next.version;
  if (next.binding) checkpoint.binding = next.binding;
  return checkpoint;
}
