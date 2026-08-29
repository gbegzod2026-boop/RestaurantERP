// systemDb.js — Production Security Fix Pass, Phase 2 (High: "audit logging
// failures").
//
// Phase 1 locked `systemData/*` (security log, Payme transaction index) to
// ".read": false / ".write": false in database.rules.json, since it's
// backend-only data no browser has a legitimate reason to touch. But the
// backend itself was still writing there with the plain, unauthenticated
// client SDK (db.js) — which is subject to those same rules once deployed,
// so logSecurityEvent() and Payme's CreateTransaction/PerformTransaction
// index would silently start failing (breaking security logging AND, more
// seriously, Payme payments) the moment those rules actually go live,
// unless the backend has a way to write there that bypasses rules.
//
// This module is that way: it writes via the Firebase Admin SDK (which
// bypasses Security Rules entirely, by design — that's what makes a server
// trusted) when a service account is configured, and transparently falls
// back to the plain client SDK otherwise — the exact same graceful-degrade
// pattern as firebaseAdmin.js itself, so behavior is unchanged for anyone
// who hasn't added the service account key yet (and was already the
// documented, pre-existing behavior for these two paths before this file
// existed).
//
// Update (Architecture Fix Pass): these helpers are generic admin-or-client
// path accessors — nothing about them is systemData-specific — so once
// database.rules.json started requiring `auth != null` on restaurants/
// $restId too (see that file's header), rbac.js/auth.js/server.js reuse
// them for that path as well, rather than duplicating the same fallback
// logic under a new name.
import { ref, push, set, update, get, remove, query, orderByChild, orderByKey, orderByValue, equalTo, limitToLast, limitToFirst, runTransaction } from "firebase/database";
import { getDB } from "./db.js";
import { isAdminAvailable, getAdminDb } from "./firebaseAdmin.js";
import { assertFirebaseDataPlaneAccess, classifyBackendDataPath } from "./dataPlane.js";
import { usePostgres } from "./pg/config.js";
import { withLegacyRest } from "./pg/legacyBridge.js";
import * as pathRouter from "./pg/pathRouter.js";

function snapshot(value) {
  return { exists: () => value !== null && value !== undefined, val: () => value ?? null };
}

function postgresTenantPath(path) {
  if (!usePostgres()) return null;
  const classification = classifyBackendDataPath(path);
  if (classification.kind !== "tenant") return null;
  const restId = classification.segments[0] === "restaurants" ? classification.segments[1] : null;
  if (!restId || !pathRouter.isMappedPath(classification.path)) {
    assertFirebaseDataPlaneAccess(path);
  }
  return { path: classification.path, restId };
}

async function pgRead(path) {
  const tenant = postgresTenantPath(path);
  if (!tenant) return null;
  const result = await withLegacyRest(tenant.restId, (client, ctx) =>
    pathRouter.rtdbGet(client, ctx, tenant.path));
  if (result?.error) {
    const err = new Error(result.error);
    err.code = result.code || "PG_PATH_UNAVAILABLE";
    throw err;
  }
  return snapshot(result?.value);
}

async function pgWrite(operation, path, value) {
  const tenant = postgresTenantPath(path);
  if (!tenant) return null;
  const result = await withLegacyRest(tenant.restId, (client, ctx, events) =>
    operation === "rtdbRemove"
      ? pathRouter.rtdbRemove(client, ctx, tenant.path, events)
      : pathRouter[operation](client, ctx, tenant.path, value, events));
  if (result?.error) {
    const err = new Error(result.error);
    err.code = result.code || "PG_PATH_UNAVAILABLE";
    throw err;
  }
  return result;
}

export async function systemPush(path, data) {
  const tenant = postgresTenantPath(path);
  if (tenant) {
    const result = await withLegacyRest(tenant.restId, (client, ctx, events) =>
      pathRouter.rtdbPush(client, ctx, tenant.path, data, events));
    if (result?.error) throw Object.assign(new Error(result.error), { code: result.code });
    return result?.key;
  }
  assertFirebaseDataPlaneAccess(path);
  if (isAdminAvailable()) {
    const newRef = getAdminDb().ref(path).push();
    await newRef.set(data);
    return newRef.key;
  }
  const newRef = push(ref(getDB(), path));
  await set(newRef, data);
  return newRef.key;
}

export async function systemSet(path, data) {
  const routed = await pgWrite("rtdbSet", path, data);
  if (routed) return routed.value;
  assertFirebaseDataPlaneAccess(path);
  if (isAdminAvailable()) return getAdminDb().ref(path).set(data);
  return set(ref(getDB(), path), data);
}

export async function systemUpdate(path, data) {
  const routed = await pgWrite("rtdbUpdate", path, data);
  if (routed) return routed.value;
  assertFirebaseDataPlaneAccess(path);
  if (isAdminAvailable()) return getAdminDb().ref(path).update(data);
  return update(ref(getDB(), path), data);
}

export async function systemGet(path) {
  const routed = await pgRead(path);
  if (routed) return routed;
  assertFirebaseDataPlaneAccess(path);
  if (isAdminAvailable()) {
    const snap = await getAdminDb().ref(path).once("value");
    return { exists: () => snap.exists(), val: () => snap.val() };
  }
  return get(ref(getDB(), path));
}

/** Admin-or-client equivalent of query(ref(db,path), orderByChild(field), limitToLast(n)). */
export async function systemQueryOrderedLimit(path, field, limitCount) {
  const routed = await pgRead(path);
  if (routed) {
    const entries = Object.entries(routed.val() || {})
      .sort((a, b) => {
        const av = a[1]?.[field];
        const bv = b[1]?.[field];
        return av === bv ? a[0].localeCompare(b[0]) : (av > bv ? 1 : -1);
      })
      .slice(-Math.max(0, Number(limitCount) || 0));
    return snapshot(Object.fromEntries(entries));
  }
  assertFirebaseDataPlaneAccess(path);
  if (isAdminAvailable()) {
    const snap = await getAdminDb().ref(path).orderByChild(field).limitToLast(limitCount).once("value");
    return { exists: () => snap.exists(), val: () => snap.val() };
  }
  return get(query(ref(getDB(), path), orderByChild(field), limitToLast(limitCount)));
}

/**
 * General-purpose admin-or-client query, for callers that need something
 * other than the orderByChild+limitToLast shape systemQueryOrderedLimit()
 * covers (e.g. an equalTo() lookup). `opts`:
 *   { orderByChild: "field" } | { orderByKey: true } | { orderByValue: true }
 *   equalTo: value
 *   limitToFirst: n | limitToLast: n
 * No current backend call site needs this yet (every existing query in this
 * app is covered by systemGet or systemQueryOrderedLimit) — added for
 * completeness/future use per the systemDb helper contract.
 */
export async function systemQuery(path, opts = {}) {
  const { orderByChild: orderField, orderByKey: byKey, orderByValue: byValue, equalTo: eq, limitToFirst: firstN, limitToLast: lastN } = opts;

  const routed = await pgRead(path);
  if (routed) return routed;
  assertFirebaseDataPlaneAccess(path);

  if (isAdminAvailable()) {
    let q = getAdminDb().ref(path);
    if (orderField) q = q.orderByChild(orderField);
    else if (byKey) q = q.orderByKey();
    else if (byValue) q = q.orderByValue();
    if (eq !== undefined) q = q.equalTo(eq);
    if (firstN != null) q = q.limitToFirst(firstN);
    if (lastN != null) q = q.limitToLast(lastN);
    const snap = await q.once("value");
    return { exists: () => snap.exists(), val: () => snap.val() };
  }

  const constraints = [];
  if (orderField) constraints.push(orderByChild(orderField));
  else if (byKey) constraints.push(orderByKey());
  else if (byValue) constraints.push(orderByValue());
  if (eq !== undefined) constraints.push(equalTo(eq));
  if (firstN != null) constraints.push(limitToFirst(firstN));
  if (lastN != null) constraints.push(limitToLast(lastN));
  return get(query(ref(getDB(), path), ...constraints));
}

export async function systemRemove(path) {
  const routed = await pgWrite("rtdbRemove", path);
  if (routed) return routed.value;
  assertFirebaseDataPlaneAccess(path);
  if (isAdminAvailable()) return getAdminDb().ref(path).remove();
  return remove(ref(getDB(), path));
}

/**
 * Admin-or-client equivalent of an atomic read-modify-write. `updateFn(current)`
 * receives the CURRENT value at `path` (or null) and must return either the
 * new value to write, or `undefined` to abort the write (Firebase's normal
 * transaction-abort convention — same contract for both SDKs). Firebase
 * retries `updateFn` internally if another writer raced it, so `updateFn`
 * must be a pure function of its input (no side effects) — exactly the same
 * contract the client SDK's runTransaction() already documents.
 * First real caller: discountClaims/claimsService.js's available->used
 * transition (one-time QR discount claims) — needs a genuine atomic guard so
 * two concurrent orders can never both consume the same claim.
 */
export async function systemTransaction(path, updateFn) {
  const tenant = postgresTenantPath(path);
  if (tenant) {
    return withLegacyRest(tenant.restId, async (client, ctx, events) => {
      const txn = await pathRouter.rtdbTransaction(client, ctx, tenant.path);
      if (txn?.error) throw Object.assign(new Error(txn.error), { code: txn.code });
      const next = updateFn(txn.value);
      if (next === undefined) return { committed: false, snapshot: snapshot(txn.value) };
      const applied = txn.apply
        ? await txn.apply(next, events)
        : await pathRouter.rtdbSet(client, ctx, tenant.path, next, events);
      if (applied?.error) throw Object.assign(new Error(applied.error), { code: applied.code });
      return { committed: true, snapshot: snapshot(next) };
    });
  }
  assertFirebaseDataPlaneAccess(path);
  if (isAdminAvailable()) {
    const result = await getAdminDb().ref(path).transaction(updateFn);
    return { committed: result.committed, snapshot: { val: () => (result.snapshot ? result.snapshot.val() : null) } };
  }
  const result = await runTransaction(ref(getDB(), path), updateFn);
  return { committed: result.committed, snapshot: { val: () => result.snapshot.val() } };
}
