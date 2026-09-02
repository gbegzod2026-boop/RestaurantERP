import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECKPOINT_VERSION,
  emptyCheckpoint,
  checkpointBinding,
  assertCheckpointBinding,
  restaurantCompleted,
  commitRestaurantThenCheckpoint,
  withRestaurantCompleted,
  atomicWriteJsonFile,
} from "../scripts/lib/migrationCheckpoint.mjs";

const binding = checkpointBinding({
  attemptId: "11111111-1111-4111-8111-111111111111",
  targetFingerprint: "ab".repeat(32),
  candidateCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  cutoverWindowIdentity: "window",
  phase: "resume-full",
  freezeIdentity: "cd".repeat(32),
  batchId: "full-1",
});

test("legacy unbound checkpoints cannot authorize production resume", () => {
  assert.throws(
    () => assertCheckpointBinding({ completedRestaurants: { rest_1: true } }, binding),
    /legacy unbound checkpoint/,
  );
  assert.throws(
    () => assertCheckpointBinding(emptyCheckpoint(), binding),
    /legacy unbound checkpoint/,
  );
});

test("matching bound checkpoint is accepted", () => {
  const cp = emptyCheckpoint(binding);
  cp.version = CHECKPOINT_VERSION;
  assert.doesNotThrow(() => assertCheckpointBinding(cp, binding));
});

test("crash before COMMIT does not persist completion", async () => {
  const checkpoint = emptyCheckpoint(binding);
  let persisted = false;
  const client = {
    async query(sql) {
      if (sql === "COMMIT") throw new Error("crashed before commit");
    },
  };
  await assert.rejects(
    () => commitRestaurantThenCheckpoint({
      client,
      mode: "apply",
      checkpoint,
      restId: "rest_1",
      persist() { persisted = true; },
    }),
    /crashed before commit/,
  );
  assert.equal(persisted, false);
  assert.equal(restaurantCompleted(checkpoint, "rest_1"), false);
});

test("COMMIT failure does not mark the restaurant completed", async () => {
  const checkpoint = emptyCheckpoint(binding);
  let persisted = false;
  const client = {
    async query(sql) {
      if (sql === "COMMIT") throw new Error("commit failed");
    },
  };
  await assert.rejects(
    () => commitRestaurantThenCheckpoint({
      client,
      mode: "apply",
      checkpoint,
      restId: "rest_1",
      persist() { persisted = true; },
    }),
    /commit failed/,
  );
  assert.equal(persisted, false);
  assert.equal(restaurantCompleted(checkpoint, "rest_1"), false);
});

test("COMMIT success then checkpoint failure recovers idempotently without duplication", async () => {
  const db = new Set();
  const upsert = (key) => db.add(key);
  upsert("rest_1:orders:a");
  const checkpoint = emptyCheckpoint(binding);
  const client = {
    async query(sql) {
      if (sql !== "COMMIT" && sql !== "ROLLBACK") throw new Error(`unexpected ${sql}`);
    },
  };
  await assert.rejects(
    () => commitRestaurantThenCheckpoint({
      client,
      mode: "apply",
      checkpoint,
      restId: "rest_1",
      persist() { throw new Error("checkpoint write failed"); },
    }),
    /checkpoint write failed/,
  );
  assert.equal(restaurantCompleted(checkpoint, "rest_1"), false);
  upsert("rest_1:orders:a");
  assert.equal(db.size, 1);
  const recovered = withRestaurantCompleted(checkpoint, "rest_1");
  assert.equal(restaurantCompleted(recovered, "rest_1"), true);
});

test("resume cannot skip rolled-back work", () => {
  const checkpoint = emptyCheckpoint(binding);
  assert.equal(restaurantCompleted(checkpoint, "rest_1"), false);
});

test("failed temp checkpoint write leaves the old valid file intact", () => {
  const files = new Map([["/tmp/wave1-checkpoint.json", JSON.stringify({ version: 2, ok: true })]]);
  const io = {
    mkdirSync() {},
    openSync() { return 7; },
    writeFileSync() { throw new Error("disk full"); },
    fsyncSync() {},
    closeSync() {},
    renameSync() { throw new Error("rename must not run after a failed write"); },
    unlinkSync(p) { files.delete(p); },
    randomUUID() { return "11111111-1111-4111-8111-111111111111"; },
  };
  assert.throws(
    () => atomicWriteJsonFile("/tmp/wave1-checkpoint.json", { version: 2, truncated: true }, io),
    /disk full/,
  );
  assert.equal(files.get("/tmp/wave1-checkpoint.json"), JSON.stringify({ version: 2, ok: true }));
});

test("atomic rename publishes complete JSON only", () => {
  const files = new Map();
  const io = {
    mkdirSync() {},
    openSync() { return 3; },
    writeFileSync(_fd, data) { files.set("tmp", String(data)); },
    fsyncSync() {},
    closeSync() {},
    renameSync(tmp, dest) {
      files.set(dest, files.get("tmp"));
      files.delete("tmp");
    },
    unlinkSync() {},
    randomUUID() { return "22222222-2222-4222-8222-222222222222"; },
  };
  const payload = { version: CHECKPOINT_VERSION, completedRestaurants: { rest_1: true }, binding };
  atomicWriteJsonFile("/tmp/full-checkpoint.json", payload, io);
  const raw = files.get("/tmp/full-checkpoint.json");
  assert.ok(raw);
  assert.deepEqual(JSON.parse(raw), payload);
  assert.equal(files.has("tmp"), false);
});

test("interrupted write never replaces the final file with a truncated body", () => {
  const files = new Map([["/tmp/wave1-checkpoint.json", '{"version":2,"complete":true}']]);
  let renamed = false;
  const io = {
    mkdirSync() {},
    openSync() { return 1; },
    writeFileSync() { /* temp only */ },
    fsyncSync() {},
    closeSync() {},
    renameSync() { throw new Error("crash before rename"); },
    unlinkSync() {},
    randomUUID() { return "33333333-3333-4333-8333-333333333333"; },
  };
  assert.throws(
    () => atomicWriteJsonFile("/tmp/wave1-checkpoint.json", { version: 2, truncated: "xxxx" }, io),
    /crash before rename/,
  );
  assert.equal(renamed, false);
  assert.equal(files.get("/tmp/wave1-checkpoint.json"), '{"version":2,"complete":true}');
});

