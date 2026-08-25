# P0-2 Remaining Credential Read — Design Report

**Status: investigation only. No code, rules, or schema were changed while producing this document**, per explicit instruction. This is not a fix — it is the groundwork for one, to be authorized separately.

---

## 1. What the residual gap actually is (re-derived from source, not copied from the prior audit)

`database.rules.json`'s `restaurants/$restId` node grants:
```
".read": "auth != null && (auth.token.restId == $restId || auth.token.restId == null)"
```
with **no role check at all** — any authenticated session whose token carries `restId == $restId` passes, regardless of `role`.

`users/$userId/password` and `users/$userId/passwordEnc` both carry `".read": false`. Firebase Realtime Database evaluates a read by walking from the requested path **up** to the root and allowing the read if **any** node on that path (the node itself or an ancestor) evaluates `.read` to `true` — a deeper node's `false` cannot revoke a shallower ancestor's `true`. This was already empirically proven live during the P0-2 write-side fix (documented in the rules file's own comments) and is standard, documented Firebase behavior, not a misconfiguration.

**Consequence:** any employee of any role, in any restaurant, using their own real, legitimately-obtained Firebase session (from a normal PIN/password login), can call the Firebase REST API directly —
```
GET https://<db>.firebaseio.com/restaurants/{restId}/users/{anyUid}/password.json?auth=<their own idToken>
```
— and read **any coworker's** `password` (and, if populated, `passwordEnc`), including the restaurant's own owner/admin. This does not require the app's UI at all; it bypasses `rbac.js`, `requirePermission()`, and every Express route entirely, because it never touches the backend — it's a direct client-SDK-shaped call to Firebase itself.

This is **not** the same as "one admin can see another admin's password" — it is **any waiter/cashier/courier/chef can see everyone's password in their own restaurant**, since the only check is "same restaurant," not "same or higher privilege."

## 2. Severity is worse than "reads a bcrypt hash" — two concrete amplifiers found this pass

1. **New employees sit with a plaintext password until their first login.** `admin.js`'s `addWaiter`/`addCashier`/`addChef`/`addCourier` write straight to Firebase from the browser (`set(ref(db, BASE_PATH + "/users/" + id), { ..., password, ... })`) with **no hashing at all** client-side — the plaintext PIN is what's persisted. `backend/security/password.js`'s bcrypt self-migration only happens **on that employee's first successful login**. Until then, the read gap above exposes the raw, plaintext PIN — zero cracking effort, instant account takeover.
2. **Staff PINs are 4-digit numeric codes** (`_genStrongPassword()`: `Math.floor(1000 + Math.random()*9000)` → 9,000 possible values). Even once bcrypt-hashed, this keyspace is small enough to brute-force offline in minutes, not because bcrypt is weak, but because the *input* space is tiny — bcrypt's cost factor barely matters against 9,000 candidates. So even the "good" (post-first-login) case offers only shallow protection once the hash is read.

`passwordEnc` (AES-256-GCM ciphertext, `backend/security/crypto.js`, key from `process.env.ENCRYPTION_KEY`) is comparatively lower-severity if read this way: the key never leaves the server, so a coworker reading the raw `iv.ciphertext.tag` blob cannot decrypt it themselves. It is still a real defense-in-depth violation (ciphertext exposure is never "fine" to ignore), just not immediately, directly exploitable the way `password` is.

The superadmin reveal flow itself (`backend/routes/superadminCredentials.js`) is **not** part of this gap — it already reads exclusively via the Admin SDK (bypasses rules by design) behind `requireSuperAdmin()` (verified token, no `restId` claim, rejects anonymous sessions). That flow was re-confirmed sound this pass, not re-derived from scratch line-by-line (no changes since the earlier audit, nothing in this pass touched it).

## 3. Why a "28-field read allowlist" is not actually implementable as a Firebase rules change

I want to correct an assumption embedded in how this task was framed, rather than silently work around it: **Firebase Realtime Database security rules cannot filter which fields of a node are returned in a single read.** A `.read` rule only gates *whether* a given path may be read at all — if it's granted, the entire subtree at that path is returned, with no per-field inclusion/exclusion. There is no rule syntax that means "allow reading `users/$uid` but strip out `password`/`passwordEnc` from the response."

A `$field`-wildcard rule one level below `$userId` (e.g. `"$field": { ".read": "$field !== 'password' && ..." }`) only governs reads that **target that specific field's path** (`users/$uid/name`); it is never consulted for a whole-record read of `users/$uid`, because Firebase only evaluates the exact requested path and its ancestors — a same-or-deeper sibling rule isn't part of that chain. So even with such a rule in place, a direct `GET users/{uid}.json` (the whole record) — or, as proven, a direct `GET users/{uid}/password.json` — would still succeed via `restaurants/$restId`'s own ancestor grant, completely bypassing any field-level rule.

This matches Firebase's own official guidance for this exact problem shape: the documented fix is to **store data that needs different access at a different location** — i.e., a schema change. That is the one thing I have been explicitly told not to do without your separate confirmation, so I'm not proposing it as an immediate action — just naming it accurately as *the* structurally correct fix, rather than implying a rules-only trick exists that doesn't.

## 4. What's realistically not achievable without either a schema change or a large blast-radius rules rewrite

To close this without moving `password`/`passwordEnc` to a separate path, the *only* alternative is removing or narrowing `restaurants/$restId`'s current all-encompassing `.read: true` grant and rebuilding per-subtree read rules from scratch (orders, menu, inventory, finance, tables, users, etc. each getting their own explicit `.read`). This is not a schema change (data doesn't move), but it is a rules rewrite with enormous blast radius: **every** current read in the app — including the anonymous client QR-ordering flow, which the rules file's own header comments say deliberately relies on this exact broad grant — depends on it today. Narrowing even just the `users` subtree specifically would still break a live, currently-working feature: `admin.js`'s real-time staff-list listener (`onValue(ref(db, BASE_PATH + "/users"), ...)`, confirmed at admin.js:9073) reads the whole `users` node directly from the client for live updates; routing that exclusively through the backend would require replacing a working real-time UI feature with a new polling or Socket.IO-based mechanism — a real, non-trivial frontend project, not a minimal fix, and squarely the kind of thing the instructions asked me not to attempt unilaterally.

## 5. What IS a genuinely low-risk, non-schema, non-rules-change mitigation

One concrete, small, well-scoped step *would* reduce real-world severity without touching rules or schema at all: **hash the PIN client-side (a browser-compatible bcrypt implementation) before the initial `set()` write** in `addWaiter`/`addCashier`/`addChef`/`addCourier`/the equivalent staff-creation paths, instead of writing the plaintext PIN and relying on first-login self-migration. This would close finding §2.1 (the plaintext-until-first-login window) entirely, while leaving the underlying read-rule gap unchanged — it does not fix the root cause, only removes the worst, zero-effort exploitation case. I have **not implemented this** — it's flagged here as the one option that doesn't require your schema/rules-change approval, should you want it done as its own, separately-scoped, single-issue fix later.

## 6. Recommendation

- **Immediate, low-risk, optional:** client-side PIN hashing before creation-write (§5) — closes the worst instant-takeover case, touches only the 4-5 `add*` functions in `admin.js`, no rules/schema change, would need its own `node --check`-equivalent (frontend syntax check) + live regression of staff creation before being considered "fixed."
- **Durable, correct fix:** requires your explicit, separate approval for one of:
  - (a) a schema change moving `password`/`passwordEnc` to a path outside `restaurants/$restId`'s broad grant (the Firebase-recommended shape for this exact problem), or
  - (b) a full, carefully-sequenced rules rewrite removing the blanket `restaurants/$restId` read grant in favor of per-subtree rules — high effort, high regression risk, needs its own dedicated engagement (deployment-order discipline at least as strict as the P0-2 write-side fix's own 4-step documented order).
- Neither (a) nor (b) was applied. This report is the analysis only, exactly as scoped.

## 7. Explicit answers to the phase's specific questions

| Question | Answer |
|---|---|
| Which frontend/backend code reads `password`/`passwordEnc`? | Backend: `routes/superadminCredentials.js` only (via Admin SDK, gated). Frontend: **no legitimate app code reads either field** — `admin.js`'s staff-creation flows only *write* `password` (never read it back), and the credentials-reveal modal calls the backend endpoint above, never Firebase directly. The exposure is not from the app's own code reading it — it's that any employee's session *could* read it directly against Firebase, outside the app entirely. |
| How does superadmin credential reveal work? | `POST /api/superadmin/credentials/:restId/:uid/reveal` → `requireSuperAdmin()` (verified token, no `restId` claim, rejects anonymous) → Admin-SDK read of `passwordEnc` → `decryptSecret()` server-side → plaintext returned only to that verified superadmin session, logged via `logSecurityEvent`, password value itself never logged. Sound, unchanged, re-confirmed this pass. |
| Where could a normal employee see this data? | Directly via the Firebase REST API using their own real session token — not through any app UI. Any role, not just owner/admin (see §1). |
| What safe options exist without a schema change? | Only the client-side pre-write hashing mitigation in §5 meaningfully reduces severity; no non-schema option closes the read gap itself (see §3–4). |
| Is the "28-field allowlist" idea complete/viable? | Not viable in the form implied — Firebase RTDB rules cannot do field-level allowlisting within one read grant at all (see §3). Whatever field count was estimated is moot; the mechanism itself doesn't exist. |
| Which variant is safest for regression? | Of the two durable options, (a) the schema change is more contained (touches exactly 2 fields' storage location plus their handful of readers/writers, all already enumerated in the rules file's own comments) than (b) the full rules rewrite (touches every read in the app). If/when you approve moving forward, (a) is the one I'd recommend scoping first — but only with your explicit go-ahead, per the standing instruction not to move this data without it. |
