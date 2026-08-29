import express from "express";
import {
  publicFirebaseWebConfig,
  getAuthEmulatorHost,
  authEnvironmentDiagnostic,
  isolatedAuthRequired,
} from "../firebaseEnv.js";

const router = express.Router();

function emulatorBrowserOrigin() {
  const host = getAuthEmulatorHost();
  if (!host) return null;
  const url = host.includes("://") ? host : `http://${host}`;
  try {
    const parsed = new URL(url);
    if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

router.get("/firebase-config", (_req, res) => {
  try {
    const config = publicFirebaseWebConfig();
    const diag = authEnvironmentDiagnostic();
    res.json({
      config,
      authEmulatorHost: emulatorBrowserOrigin(),
      firebaseProjectId: diag.firebaseProjectId,
      productionFirebase: diag.productionFirebase,
      isolatedAuth: diag.isolatedAuth,
    });
  } catch (err) {
    const status = isolatedAuthRequired() ? 503 : 500;
    res.status(status).json({ error: "firebase_config_unavailable", code: "firebase_config_unavailable" });
  }
});

export default router;
