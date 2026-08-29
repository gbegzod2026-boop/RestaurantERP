// Isolated vs production Firebase identity environment.
// Production project restoran-30d51 must never receive acceptance Auth mints.
export const PRODUCTION_FIREBASE_PROJECT_IDS = Object.freeze(["restoran-30d51"]);

export function getConfiguredFirebaseProjectId() {
  return String(process.env.FIREBASE_PROJECT_ID || "").trim();
}

export function isProductionFirebaseProject(projectId = getConfiguredFirebaseProjectId()) {
  return PRODUCTION_FIREBASE_PROJECT_IDS.includes(String(projectId || "").trim());
}

export function getAuthEmulatorHost() {
  return String(process.env.FIREBASE_AUTH_EMULATOR_HOST || "").trim();
}

export function isolatedAuthRequired() {
  return process.env.NESTA_REQUIRE_ISOLATED_AUTH === "1";
}

export function allowRemoteStagingProject() {
  return process.env.NESTA_ALLOW_REMOTE_STAGING === "1";
}

/**
 * When NESTA_REQUIRE_ISOLATED_AUTH=1, refuse production Firebase and require
 * either the Auth emulator or an explicit remote staging project.
 * No-op when the flag is unset so production deploys stay unchanged.
 */
export function assertIsolatedAuthEnvironment() {
  if (!isolatedAuthRequired()) return;
  const projectId = getConfiguredFirebaseProjectId();
  if (!projectId || isProductionFirebaseProject(projectId)) {
    throw new Error(
      "NESTA_REQUIRE_ISOLATED_AUTH=1 refused: FIREBASE_PROJECT_ID is missing or production (restoran-30d51)"
    );
  }
  if (!getAuthEmulatorHost() && !allowRemoteStagingProject()) {
    throw new Error(
      "NESTA_REQUIRE_ISOLATED_AUTH=1 requires FIREBASE_AUTH_EMULATOR_HOST or NESTA_ALLOW_REMOTE_STAGING=1"
    );
  }
}

/** Refuse minting Auth users into production, including emulator+production ID mixups. */
export function assertAuthMintAllowed() {
  const projectId = getConfiguredFirebaseProjectId();
  const emulator = getAuthEmulatorHost();
  if (isolatedAuthRequired()) {
    assertIsolatedAuthEnvironment();
  }
  if (emulator && isProductionFirebaseProject(projectId)) {
    throw new Error("refusing Auth emulator while FIREBASE_PROJECT_ID is production");
  }
  if (isolatedAuthRequired() && isProductionFirebaseProject(projectId)) {
    throw new Error("refusing Auth mint against production Firebase");
  }
}

export function publicFirebaseWebConfig() {
  const projectId = getConfiguredFirebaseProjectId();
  const emulator = getAuthEmulatorHost();
  if (isolatedAuthRequired()) {
    assertIsolatedAuthEnvironment();
    return {
      apiKey: process.env.FIREBASE_API_KEY || "nesta-staging-emulator",
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
      projectId,
      appId: process.env.FIREBASE_APP_ID || "1:0:web:nesta-staging",
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "0",
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
    };
  }
  return {
    apiKey: process.env.FIREBASE_API_KEY || "AIzaSyCGCCIP3eFg40bOEENDLGcrw9c484ySCHQ",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "restoran-30d51.firebaseapp.com",
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://restoran-30d51-default-rtdb.firebaseio.com",
    projectId: projectId || "restoran-30d51",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "restoran-30d51.firebasestorage.app",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "862261129762",
    appId: process.env.FIREBASE_APP_ID || "1:862261129762:web:5577e6821b4ad7ea4e507b",
  };
}

export function authEnvironmentDiagnostic() {
  const emulator = getAuthEmulatorHost();
  return {
    firebaseProjectId: getConfiguredFirebaseProjectId() || null,
    productionFirebase: isProductionFirebaseProject(),
    authEmulator: Boolean(emulator),
    isolatedAuth: isolatedAuthRequired(),
  };
}

export function logAuthEnvironment() {
  const d = authEnvironmentDiagnostic();
  console.log(
    `🔐 Auth environment: project=${d.firebaseProjectId || "(unset)"} ` +
    `production=${d.productionFirebase} emulator=${d.authEmulator} ` +
    `isolated=${d.isolatedAuth} dataBackend=${process.env.DATA_BACKEND || ""}`
  );
}
