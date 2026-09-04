// Loads Firebase web config from the same-origin backend so local acceptance
// can point Auth at an isolated project/emulator without baking production
// restoran-30d51 into every page. Production still receives the existing
// public client config when the backend is not in isolated-auth mode.
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

let _loadP = null;
let _connectTried = false;

export async function fetchNestaFirebaseWebConfig() {
  const res = await fetch("/api/public/firebase-config", { credentials: "same-origin" });
  if (!res.ok) throw new Error("firebase_config_unavailable");
  const body = await res.json();
  const config = body?.config;
  if (!config?.projectId || !config?.apiKey) throw new Error("firebase_config_invalid");
  return body;
}

function attachEmulator(app, body) {
  if (!body.authEmulatorHost || _connectTried) return;
  _connectTried = true;
  connectAuthEmulator(getAuth(app), body.authEmulatorHost, { disableWarnings: true });
}

function assertProjectMatches(app, projectId) {
  const existingId = app?.options?.projectId;
  if (existingId && existingId !== projectId) {
    throw new Error("firebase_project_mismatch");
  }
}

export async function loadNestaFirebaseApp() {
  if (_loadP) return _loadP;
  _loadP = (async () => {
    const body = await fetchNestaFirebaseWebConfig();
    const existing = getApps()[0];
    if (existing) {
      assertProjectMatches(existing, body.config.projectId);
      attachEmulator(existing, body);
      return existing;
    }
    const app = initializeApp(body.config);
    attachEmulator(app, body);
    return app;
  })();
  try {
    return await _loadP;
  } catch (err) {
    _loadP = null;
    throw err;
  }
}

export async function loadNestaNamedFirebaseApp(name) {
  const body = await fetchNestaFirebaseWebConfig();
  const found = getApps().find((app) => app.name === name);
  if (found) {
    assertProjectMatches(found, body.config.projectId);
    return found;
  }
  return initializeApp(body.config, name);
}
