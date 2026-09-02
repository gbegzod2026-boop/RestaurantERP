import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalTargetIdentity,
  targetFingerprintFromFacts,
  assertSameTargetFingerprint,
  EXAMPLE_TARGET_FACTS,
  exampleLiveTargetFingerprint,
  TARGET_IDENTITY_SQL,
  collectPgTargetIdentity,
} from "../scripts/lib/pgTargetFingerprint.mjs";

test("exact target facts produce a stable 64-char fingerprint", () => {
  const fp = exampleLiveTargetFingerprint();
  assert.match(fp, /^[a-f0-9]{64}$/);
  assert.equal(targetFingerprintFromFacts(EXAMPLE_TARGET_FACTS), fp);
  assert.equal(canonicalTargetIdentity(EXAMPLE_TARGET_FACTS).includes("postgres://"), false);
  assert.equal(canonicalTargetIdentity(EXAMPLE_TARGET_FACTS).includes("password"), false);
  assert.doesNotMatch(TARGET_IDENTITY_SQL, /inet_server_addr|inet_server_port/);
  assert.match(TARGET_IDENTITY_SQL, /current_database\(\)/);
  assert.match(TARGET_IDENTITY_SQL, /system_identifier/);
});

test("host is lowercased and IPv6 brackets are stripped; default port is 5432", () => {
  const a = targetFingerprintFromFacts({ ...EXAMPLE_TARGET_FACTS, host: "Switchback.Proxy.Rlwy.Net" });
  const b = targetFingerprintFromFacts({ ...EXAMPLE_TARGET_FACTS, host: "[switchback.proxy.rlwy.net]" });
  assert.equal(a, exampleLiveTargetFingerprint());
  assert.equal(b, exampleLiveTargetFingerprint());
  const withDefault = targetFingerprintFromFacts({ ...EXAMPLE_TARGET_FACTS, port: "" });
  assert.equal(withDefault, targetFingerprintFromFacts({ ...EXAMPLE_TARGET_FACTS, port: "5432" }));
});

test("same schema on a different Railway DB has a different fingerprint", () => {
  const a = exampleLiveTargetFingerprint();
  const b = targetFingerprintFromFacts({ ...EXAMPLE_TARGET_FACTS, host: "other.proxy.rlwy.net" });
  const c = targetFingerprintFromFacts({ ...EXAMPLE_TARGET_FACTS, systemIdentifier: "9999999999999999999" });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.throws(() => assertSameTargetFingerprint(a, b), /not the exact PostgreSQL target/);
});

test("different database name fails fingerprint equality", () => {
  const a = exampleLiveTargetFingerprint();
  const b = targetFingerprintFromFacts({ ...EXAMPLE_TARGET_FACTS, database: "otherdb", currentDatabase: "otherdb" });
  assert.notEqual(a, b);
  assert.throws(() => assertSameTargetFingerprint(a, b), /not the exact PostgreSQL target/);
});

test("same cluster/database with a different inet_server_addr is the SAME fingerprint", () => {
  const a = exampleLiveTargetFingerprint();
  const b = targetFingerprintFromFacts({
    ...EXAMPLE_TARGET_FACTS,
    inetServerAddr: "10.0.0.9",
    inetServerPort: 65432,
  });
  assert.equal(a, b);
  assert.doesNotThrow(() => assertSameTargetFingerprint(a, b));
});

test("configured port and host remain distinguishing; volatile sockets do not", () => {
  const a = exampleLiveTargetFingerprint();
  const port = targetFingerprintFromFacts({ ...EXAMPLE_TARGET_FACTS, port: "5432" });
  assert.notEqual(a, port);
});

test("exact target fingerprints pass equality", () => {
  const a = exampleLiveTargetFingerprint();
  assert.doesNotThrow(() => assertSameTargetFingerprint(a, a));
});

test("collectPgTargetIdentity hashes stable facts and ignores inet fields on the row", async () => {
  const connection = { host: "switchback.proxy.rlwy.net", port: "12345", database: "railway" };
  const rowA = {
    rows: [{
      current_database: "railway",
      system_identifier: "1111111111111111111",
      inet_server_addr: "10.0.0.1",
      inet_server_port: 5432,
    }],
  };
  const rowB = {
    rows: [{
      current_database: "railway",
      system_identifier: "1111111111111111111",
      inet_server_addr: "10.9.8.7",
      inet_server_port: 59999,
    }],
  };
  const a = await collectPgTargetIdentity({ query: async () => rowA }, connection);
  const b = await collectPgTargetIdentity({ query: async () => rowB }, connection);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.fingerprint, exampleLiveTargetFingerprint());
});
