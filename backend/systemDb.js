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

export async function systemPush(path, data) {
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
  if (isAdminAvailable()) return getAdminDb().ref(path).set(data);
  return set(ref(getDB(), path), data);
}

export async function systemUpdate(path, data) {
  if (isAdminAvailable()) return getAdminDb().ref(path).update(data);
  return update(ref(getDB(), path), data);
}

export async function systemGet(path) {
  if (isAdminAvailable()) {
    const snap = await getAdminDb().ref(path).once("value");
    return { exists: () => snap.exists(), val: () => snap.val() };
  }
  return get(ref(getDB(), path));
}

/** Admin-or-client equivalent of query(ref(db,path), orderByChild(field), limitToLast(n)). */
export async function systemQueryOrderedLimit(path, field, limitCount) {
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
  if (isAdminAvailable()) {
    const result = await getAdminDb().ref(path).transaction(updateFn);
    return { committed: result.committed, snapshot: { val: () => (result.snapshot ? result.snapshot.val() : null) } };
  }
  const result = await runTransaction(ref(getDB(), path), updateFn);
  return { committed: result.committed, snapshot: { val: () => result.snapshot.val() } };
}
