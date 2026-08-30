// Payment cutover policy. HTTP 503 during maintenance is NOT a guaranteed
// provider retry. Go-live stays BLOCKED until the operator records either
// OPERATOR_PAUSED (provider cabinet pause confirmed) or a real DURABLE_QUEUE
// (not implemented in this step).

export const PAYMENT_PAUSE_CONFIRM = "CLICK_PAYME_UZUM_PAUSED_IN_PROVIDER_CABINET";
export const PAYMENT_QUEUE_CONFIRM = "I_CONFIRM_DURABLE_PAYMENT_QUEUE_IS_LIVE";

export const PROVIDER_STATUS = Object.freeze({
  click: "BLOCKED",
  payme: "BLOCKED",
  uzum: "BLOCKED",
});

export function paymentCutoverMode(env = process.env) {
  const v = String(env.NESTA_PAYMENT_CUTOVER_MODE || "BLOCKED").trim().toUpperCase();
  if (v === "OPERATOR_PAUSED" || v === "DURABLE_QUEUE") return v;
  return "BLOCKED";
}

export function webhookRetryGuaranteed() {
  return false;
}

export function durableQueueImplemented() {
  return false;
}

export function paymentGoLiveAllowed(env = process.env) {
  const mode = paymentCutoverMode(env);
  if (mode === "OPERATOR_PAUSED") {
    return String(env.NESTA_PAYMENT_PAUSE_CONFIRM || "") === PAYMENT_PAUSE_CONFIRM;
  }
  if (mode === "DURABLE_QUEUE") {
    return durableQueueImplemented()
      && String(env.NESTA_PAYMENT_QUEUE_CONFIRM || "") === PAYMENT_QUEUE_CONFIRM;
  }
  return false;
}

export function paymentCutoverReport(env = process.env) {
  const mode = paymentCutoverMode(env);
  const goLive = paymentGoLiveAllowed(env);
  return {
    click: goLive ? mode : "BLOCKED",
    payme: goLive ? mode : "BLOCKED",
    uzum: goLive ? mode : "BLOCKED",
    mode,
    goLiveAllowed: goLive,
    retryGuaranteed: webhookRetryGuaranteed(),
    durableQueueImplemented: durableQueueImplemented(),
    note: mode === "DURABLE_QUEUE" && !durableQueueImplemented()
      ? "DURABLE_QUEUE is not implemented; HTTP 503 is not a substitute."
      : "HTTP 503 Retry-After is advisory only; provider retry is not guaranteed.",
  };
}
