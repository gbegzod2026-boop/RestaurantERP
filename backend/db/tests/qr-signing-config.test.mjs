import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveQrSigningKey,
  assertQrSigningConfigured,
  signQrParams,
  verifyQrParams,
  resetQrSigningState,
  qrSigningHealth,
} from "../../security/qrSign.js";

const REST = "rest_1784740340104";
const LONG_KEY = "nesta-qr-signing-key-for-tests-32b";
const OTHER_KEY = "other-qr-signing-key-for-tests-32";

test("production without a signing key fails closed", () => {
  const env = { NODE_ENV: "production" };
  const resolved = resolveQrSigningKey(env);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.error, "qr_signing_key_missing");
  assert.throws(() => assertQrSigningConfigured(env), /QR_SIGNING_KEY/);
  const health = qrSigningHealth(env);
  assert.equal(health.ok, false);
  assert.equal(health.qrSigning, "qr_signing_key_missing");
});

test("production accepts QR_SIGNING_KEY and ENCRYPTION_KEY fallback", () => {
  assert.equal(resolveQrSigningKey({ NODE_ENV: "production", QR_SIGNING_KEY: LONG_KEY }).ok, true);
  assert.equal(resolveQrSigningKey({ NODE_ENV: "production", ENCRYPTION_KEY: LONG_KEY }).ok, true);
  assert.equal(resolveQrSigningKey({ NODE_ENV: "production", QR_SIGNING_KEY: LONG_KEY }).source, "QR_SIGNING_KEY");
  assert.equal(resolveQrSigningKey({ NODE_ENV: "production", ENCRYPTION_KEY: LONG_KEY }).source, "ENCRYPTION_KEY");
  assert.equal(resolveQrSigningKey({ NODE_ENV: "production", QR_SIGNING_KEY: "short" }).ok, false);
});

test("non-production may use an explicit ephemeral key", () => {
  const env = { NODE_ENV: "test" };
  const resolved = resolveQrSigningKey(env);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ephemeral, true);
  resetQrSigningState();
  const signed = signQrParams({ restId: REST, table: "1", tableId: "table_1" }, env);
  assert.equal(verifyQrParams({ restId: REST, table: "1", tableId: "table_1", ...signed }, env).valid, true);
});

test("two verifiers with the same configured key accept the same QR; a different key does not", () => {
  const envA = { QR_SIGNING_KEY: LONG_KEY };
  const envB = { QR_SIGNING_KEY: LONG_KEY };
  const envC = { QR_SIGNING_KEY: OTHER_KEY };
  const signed = signQrParams({ restId: REST, table: "1", tableId: "table_1" }, envA);
  assert.equal(verifyQrParams({ restId: REST, table: "1", tableId: "table_1", ...signed }, envB).valid, true);
  assert.equal(verifyQrParams({ restId: REST, table: "1", tableId: "table_1", ...signed }, envC).valid, false);
});

test("restart simulation with a stable key still verifies", () => {
  const env = { NODE_ENV: "production", QR_SIGNING_KEY: LONG_KEY };
  const signed = signQrParams({ restId: REST, table: "2", tableId: "table_2" }, env);
  resetQrSigningState();
  assert.equal(verifyQrParams({ restId: REST, table: "2", tableId: "table_2", ...signed }, env).valid, true);
});
