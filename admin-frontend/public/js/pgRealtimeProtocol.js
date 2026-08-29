export function matchesSubscriptionMessage(active, message, authEpoch, { requireOk = false } = {}) {
  if (!active || active.epoch !== authEpoch) return false;
  if (requireOk && message?.ok !== true) return false;
  return message?.restId === active.restId && message?.generation === active.generation;
}

export function matchesTenantEvent(active, event, authEpoch, subscribed) {
  return Boolean(
    subscribed &&
    active &&
    active.epoch === authEpoch &&
    event?.restId === active.restId
  );
}
