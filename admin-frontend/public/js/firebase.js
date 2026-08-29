// firebase.js
import { loadNestaFirebaseApp } from "./nestaFirebaseApp.js";
import { getDatabase, forceWebSockets } from
  "./pgRtdb.js";

// forceWebSockets() — Realtime Database only, and only the real public API
// this SDK exposes for it (there is no `initializeDatabase({experimentalForce
// LongPolling, ...})` for Realtime Database; those options belong to
// Firestore's `initializeFirestore()`, a different Firebase product/SDK
// entry point this app doesn't use). Called as the very first executable
// statement in this module — before firebaseConfig, before initializeApp(),
// before getDatabase() — because forceWebSockets() has no dependency on any
// app/config (it only flips a static flag on the SDK's internal transport
// classes), so there is no reason to place it any later, and doing so
// removes any possible future ordering risk if this file is ever edited.
// Forces the SDK to only ever attempt WebSocket, never fall back to the
// legacy long-polling (`.lp`) transport. Trade-off: on a network that
// blocks WebSocket outright (some corporate proxies/firewalls), the
// database will now fail to connect at all instead of degrading to
// long-polling — see CSP_AUDIT.md for the full write-up.
forceWebSockets();

export const app = await loadNestaFirebaseApp();
export const db = getDatabase(app);
