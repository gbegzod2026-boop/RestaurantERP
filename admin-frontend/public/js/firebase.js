// firebase.js
import { initializeApp } from
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";

import { getDatabase, forceWebSockets } from
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

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

const firebaseConfig = {
  apiKey: "AIzaSyCGCCIP3eFg40bOEENDLGcrw9c484ySCHQ",
  authDomain: "restoran-30d51.firebaseapp.com",
  databaseURL: "https://restoran-30d51-default-rtdb.firebaseio.com",
  projectId: "restoran-30d51",
  storageBucket: "restoran-30d51.firebasestorage.app",
  messagingSenderId: "862261129762",
  appId: "1:862261129762:web:5577e6821b4ad7ea4e507b",
  measurementId: "G-8NG56H5ZGG"
};

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
