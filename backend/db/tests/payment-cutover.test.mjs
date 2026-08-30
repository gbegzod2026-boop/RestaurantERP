import test from "node:test";
import assert from "node:assert/strict";
import {
  paymentCutoverMode,
  paymentGoLiveAllowed,
  paymentCutoverReport,
  webhookRetryGuaranteed,
  durableQueueImplemented,
  PAYMENT_PAUSE_CONFIRM,
  PROVIDER_STATUS,
} from "../../payments/cutoverMode.js";

test("providers stay BLOCKED by default", () => {
  assert.deepEqual(PROVIDER_STATUS, { click: "BLOCKED", payme: "BLOCKED", uzum: "BLOCKED" });
  assert.equal(paymentCutoverMode({}), "BLOCKED");
  assert.equal(paymentGoLiveAllowed({}), false);
  assert.equal(webhookRetryGuaranteed(), false);
  assert.equal(durableQueueImplemented(), false);
});

test("OPERATOR_PAUSED requires the exact cabinet-pause phrase", () => {
  assert.equal(paymentGoLiveAllowed({ NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED" }), false);
  assert.equal(paymentGoLiveAllowed({
    NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED",
    NESTA_PAYMENT_PAUSE_CONFIRM: "yes",
  }), false);
  assert.equal(paymentGoLiveAllowed({
    NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED",
    NESTA_PAYMENT_PAUSE_CONFIRM: PAYMENT_PAUSE_CONFIRM,
  }), true);
});

test("DURABLE_QUEUE does not enable go-live while unimplemented", () => {
  const report = paymentCutoverReport({
    NESTA_PAYMENT_CUTOVER_MODE: "DURABLE_QUEUE",
    NESTA_PAYMENT_QUEUE_CONFIRM: "I_CONFIRM_DURABLE_PAYMENT_QUEUE_IS_LIVE",
  });
  assert.equal(report.goLiveAllowed, false);
  assert.equal(report.click, "BLOCKED");
  assert.equal(report.retryGuaranteed, false);
});
