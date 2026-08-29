import test from "node:test";
import assert from "node:assert/strict";
import { signQrParams, verifyQrParams } from "../../security/qrSign.js";
import { customerSessionUid, evaluateQrSessionMint } from "../../pg/qrSession.js";

const REST = "rest_1784740340104";
const REST_B = "rest_2000000000002";

test("valid signed QR mints the matching table session", () => {
  const { sig, exp } = signQrParams({ restId: REST, table: "1", tableId: "table_1" });
  const decision = evaluateQrSessionMint({ restId: REST, table: "1", tableId: "table_1", sig, exp });
  assert.equal(decision.ok, true);
  assert.equal(decision.dineIn, true);
  assert.equal(decision.table, "1");
  assert.equal(customerSessionUid(decision), `client_${REST}_1`);
  const again = evaluateQrSessionMint({ restId: REST, table: "1", tableId: "table_1", sig, exp });
  assert.equal(again.ok, true, "replay of an unexpired printed QR is the existing contract");
});

test("modified table or restId is rejected", () => {
  const { sig, exp } = signQrParams({ restId: REST, table: "1", tableId: "table_1" });
  assert.equal(evaluateQrSessionMint({ restId: REST, table: "2", tableId: "table_1", sig, exp }).ok, false);
  assert.equal(evaluateQrSessionMint({ restId: REST_B, table: "1", tableId: "table_1", sig, exp }).ok, false);
});

test("expired, missing, and malformed QR signatures are rejected", () => {
  const { sig } = signQrParams({ restId: REST, table: "1", tableId: "table_1" });
  assert.equal(evaluateQrSessionMint({ restId: REST, table: "1", tableId: "table_1", sig, exp: Date.now() - 1000 }).code, "expired");
  assert.equal(evaluateQrSessionMint({ restId: REST, table: "1", tableId: "table_1" }).code, "missing_signature");
  assert.equal(evaluateQrSessionMint({ restId: REST, table: "1", tableId: "table_1", sig: "deadbeef", exp: Date.now() + 10000 }).ok, false);
  assert.equal(evaluateQrSessionMint({ restId: "not-a-rest", table: "1", sig: "x", exp: 1 }).code, "restId_invalid");
  assert.equal(verifyQrParams({ restId: REST, table: "1", tableId: "table_1" }).reason, "missing_signature");
});

test("unsigned requests cannot receive table authority", () => {
  const decision = evaluateQrSessionMint({ restId: REST, table: "1", tableId: "table_1" });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "missing_signature");
});
