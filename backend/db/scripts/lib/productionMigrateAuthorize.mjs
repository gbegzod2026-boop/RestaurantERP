// Step 2D.5 production --apply authorization.
//
// migrationTargetGuard remains the lower-level host/SSL/confirm/tag-name
// layer. This wrapper proves CUTOVER_WINDOW_ARMED, exact target fingerprint
// equality, and a durable PostgreSQL migration attempt for the requested
// phase. The human authorization phrase is compared byte-for-byte and is
// never persisted. It may create one attempt for the current commit, window,
// target, and freeze. Resume and full-after-wave1 require that attempt id.
//
// evaluateStep2dFinalGates never sets safeToMigrateProductionData=true.
// Only authorizeProductionMigrationApply may, after live PG invariants and
// attempt provenance. A durable attempt does not replace fresh gates.
import { readdirSync, existsSync } from "fs";
import { execFileSync as childExecFileSync } from "child_process";
import path from "path";
import { evaluateStep2dFinalGates } from "./step2dFinalGate.mjs";
import {
  freezeGitFromResolved,
  inspectGitTag,
  readOperatorGitFacts,
  CUTOVER_CANDIDATE_TAG,
} from "./deployFreeze.mjs";
import {
  computeCutoverWindowIdentity,
  currentWriteStopBinding,
} from "./cutoverWindow.mjs";
import { currentFreezeBinding } from "./freezeSnapshot.mjs";
import {
  probeRuntimeRevision,
  REQUIRED_PRODUCTION_PROBE_ORIGIN,
} from "./deployedRevision.mjs";
import {
  probeLiveGithubMain,
  makeGitLsRemoteImpl,
  LS_REMOTE_TIMEOUT_MS,
} from "./githubRemote.mjs";
import {
  runRailwayLivePreflight,
  evaluateLiveRailwayPreflight,
} from "./runRailwayLivePreflight.mjs";
import {
  collectPgTargetIdentity,
  assertSameTargetFingerprint,
  isTargetFingerprint,
} from "./pgTargetFingerprint.mjs";
import {
  MIGRATION_PHASE,
  PRODUCTION_MIGRATE_ATTEMPT_ID_ENV,
  prepareAttemptAdmission,
  persistPreparedAttempt,
  attemptBindingFromContext,
  createPgAttemptStore,
} from "./productionMigrationAttempt.mjs";
import {
  enforceConnectedApplyTarget,
  isProductionMigrateTarget,
  assertApplyTarget,
  assertLiveApplyInvariants,
} from "./migrationTargetGuard.mjs";

export const PRODUCTION_APPLY_AUTHORIZATION_PHRASE = "I_AUTHORIZE_NESTA_STEP2D5_PRODUCTION_MIGRATE_NOW";
export const PRODUCTION_APPLY_AUTHORIZATION_FLAG = "--authorize-production-migrate";
export const PRODUCTION_APPLY_AUTHORIZATION_ENV = "NESTA_PRODUCTION_APPLY_AUTHORIZATION";
export { PRODUCTION_MIGRATE_ATTEMPT_ID_ENV, MIGRATION_PHASE };

export function explicitProductionApplyAuthorized({ env = {}, argv = [] } = {}) {
  const flag = Array.isArray(argv) && argv.includes(PRODUCTION_APPLY_AUTHORIZATION_FLAG);
  if (!flag) return false;
  const phrase = env[PRODUCTION_APPLY_AUTHORIZATION_ENV];
  return phrase === PRODUCTION_APPLY_AUTHORIZATION_PHRASE;
}

function scanCutoverBackups(repoRoot) {
  const root = path.join(repoRoot, "cutover-backups");
  if (!existsSync(root)) return { firebase: 0, pg: 0, appConfig: 0 };
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  return {
    firebase: dirs.filter((n) => n.startsWith("firebase-")).length,
    pg: dirs.filter((n) => n.startsWith("pg-")).length,
    appConfig: dirs.filter((n) => n.startsWith("app-config-")).length,
  };
}

function phaseRequiresAttemptCreate(phase) {
  return phase === MIGRATION_PHASE.WAVE1_INITIAL;
}

export function evaluateProductionApplyAuthorization({
  env = {},
  argv = [],
  git = {},
  backups = { firebase: 0, pg: 0, appConfig: 0 },
  writeStopEvidence = null,
  freezeEvidence = null,
  railwayLivePreflight = "NOT RUN",
  runtimeRevision = null,
  liveRemoteMain = null,
  now = Date.now(),
  livePreflightCompletedAt = null,
  phase = MIGRATION_PHASE.WAVE1_INITIAL,
} = {}) {
  const window = evaluateStep2dFinalGates({
    env,
    backups,
    git,
    writeStopEvidence,
    freezeEvidence,
    railwayLivePreflight,
    runtimeRevision,
    liveRemoteMain,
    now,
    livePreflightCompletedAt,
    humanApprovalPresent: false,
  });
  if (window.safeToMigrateProductionData !== false || window.migrationAuthorized !== false) {
    return {
      ok: false,
      reason: "preflight evaluator must not authorize migration",
      cutoverWindowArmed: false,
      explicitAuthorization: false,
      safeToMigrateProductionData: false,
      migrationAuthorized: false,
      approvalBlockers: window.approvalBlockers,
    };
  }
  if (!window.cutoverWindowArmed) {
    return {
      ok: false,
      reason: "cutover window is not armed",
      cutoverWindowArmed: false,
      explicitAuthorization: false,
      safeToMigrateProductionData: false,
      migrationAuthorized: false,
      approvalBlockers: window.approvalBlockers,
    };
  }
  const explicitAuthorization = explicitProductionApplyAuthorized({ env, argv });
  if (phaseRequiresAttemptCreate(phase) && !explicitAuthorization) {
    return {
      ok: false,
      reason: "explicit production apply authorization required",
      cutoverWindowArmed: true,
      explicitAuthorization: false,
      safeToMigrateProductionData: false,
      migrationAuthorized: false,
      approvalBlockers: [],
    };
  }
  return {
    ok: true,
    reason: null,
    cutoverWindowArmed: true,
    explicitAuthorization,
    safeToMigrateProductionData: false,
    migrationAuthorized: false,
    approvalBlockers: [],
  };
}

async function restaurantCount(client) {
  const rows = await client.query("SELECT count(*)::int AS n FROM restaurants");
  return Number(rows.rows[0].n);
}

export async function authorizeProductionMigrationApply({
  env = {},
  argv = [],
  client,
  masked,
  writesCommitted = false,
  resume = false,
  git,
  backups,
  writeStopEvidence,
  freezeEvidence,
  railwayLivePreflight,
  runtimeRevision,
  liveRemoteMain,
  now,
  livePreflightCompletedAt,
  phase = MIGRATION_PHASE.WAVE1_INITIAL,
  liveResult = null,
  attemptStore = null,
  readTargetIdentityImpl = collectPgTargetIdentity,
} = {}) {
  void resume;
  const evaluated = evaluateProductionApplyAuthorization({
    env,
    argv,
    git,
    backups,
    writeStopEvidence,
    freezeEvidence,
    railwayLivePreflight,
    runtimeRevision,
    liveRemoteMain,
    now,
    livePreflightCompletedAt,
    phase,
  });
  if (!evaluated.ok) {
    throw new Error(`NO-GO: ${evaluated.reason}`);
  }
  const mode = assertApplyTarget(masked, env);
  if (!liveResult) {
    throw new Error("NO-GO: in-process live Railway preflight result is required");
  }
  const structural = evaluateLiveRailwayPreflight(liveResult, { requireZeroRestaurants: false });
  if (structural.railwayLivePreflight !== "PASS") {
    throw new Error(`NO-GO: live Railway preflight ${structural.railwayLivePreflight}: ${structural.reason}`);
  }
  if (phase === MIGRATION_PHASE.WAVE1_INITIAL) {
    const empty = evaluateLiveRailwayPreflight(liveResult, { requireZeroRestaurants: true });
    if (empty.railwayLivePreflight !== "PASS") {
      throw new Error(`NO-GO: ${empty.reason}`);
    }
  }
  const preflightFingerprint = liveResult.targetFingerprint;
  if (!isTargetFingerprint(preflightFingerprint)) {
    throw new Error("NO-GO: live preflight target fingerprint is missing");
  }
  const identity = await readTargetIdentityImpl(client, {
    host: masked.host,
    port: masked.port || "5432",
    database: masked.database,
  });
  assertSameTargetFingerprint(preflightFingerprint, identity.fingerprint);

  const restaurants = await restaurantCount(client);
  if (Number(liveResult.restaurants) !== restaurants) {
    throw new Error("NO-GO: live preflight restaurant count does not match the migration connection");
  }

  const windowIdentity = computeCutoverWindowIdentity({
    candidateCommit: git.head,
    remoteMain: liveRemoteMain,
    deployedRevision: runtimeRevision,
  });
  const binding = attemptBindingFromContext({
    targetFingerprint: preflightFingerprint,
    candidateCommit: git.head,
    reviewedTag: CUTOVER_CANDIDATE_TAG,
    cutoverWindowIdentity: windowIdentity,
    freezeEvidence,
    firebaseProject: freezeEvidence?.firebaseProject,
  });
  const store = attemptStore || createPgAttemptStore(client);
  const prepared = await prepareAttemptAdmission({
    store,
    phase,
    restaurants,
    env,
    binding,
    explicitCreateAuthorized: evaluated.explicitAuthorization === true,
  });
  if (!prepared.admission.ok) {
    throw new Error(`NO-GO: ${prepared.admission.reason}`);
  }

  await assertLiveApplyInvariants(client, {
    production: true,
    allowTenantRows: writesCommitted && prepared.admission.allowPopulatedTarget === true,
  });

  const attempt = await persistPreparedAttempt({
    store,
    admission: prepared.admission,
    binding,
    now: typeof now === "number" ? new Date(now) : now,
  });
  return {
    ...evaluated,
    mode,
    authorized: true,
    migrationAuthorized: true,
    safeToMigrateProductionData: true,
    phase,
    allowPopulatedTarget: prepared.admission.allowPopulatedTarget === true,
    attempt,
    targetFingerprint: preflightFingerprint,
    cutoverWindowIdentity: windowIdentity,
    freezeIdentity: binding.freezeIdentity,
  };
}

function gitRunner(repoRoot, execFileSyncImpl) {
  return (args) => {
    try {
      return execFileSyncImpl("git", ["-c", `safe.directory=${repoRoot}`, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
}

function gitRawRunner(repoRoot, execFileSyncImpl) {
  return (args) => {
    try {
      return execFileSyncImpl("git", ["-c", `safe.directory=${repoRoot}`, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  };
}

/**
 * Live collection for production --apply. Tests inject mocks into
 * evaluateProductionApplyAuthorization / authorizeProductionMigrationApply
 * instead of calling this. PREFLIGHT.json is never read as authority.
 * Structural GO does not require restaurants = 0; the migration phase does.
 */
export async function collectProductionApplyContext(repoRoot, {
  env = process.env,
  now = Date.now(),
  execFileSyncImpl = childExecFileSync,
  fetchImpl = fetch,
  runPreflightImpl = runRailwayLivePreflight,
} = {}) {
  const gitValue = gitRunner(repoRoot, execFileSyncImpl);
  const gitRaw = gitRawRunner(repoRoot, execFileSyncImpl);
  const facts = readOperatorGitFacts(gitValue);
  const git = freezeGitFromResolved({
    env,
    head: facts.head,
    dirty: facts.dirty,
    branch: facts.branch,
    originMain: facts.originMain,
    inspectTag: (tag) => inspectGitTag(tag, gitValue, gitRaw),
  });
  const live = await runPreflightImpl({
    env,
    requireDatabasePublicUrl: true,
    requireZeroRestaurants: false,
  });
  const railwayLivePreflight = evaluateLiveRailwayPreflight(live, {
    requireZeroRestaurants: false,
  }).railwayLivePreflight;
  const originUrl = gitValue(["remote", "get-url", "origin"]);
  const liveGithub = probeLiveGithubMain({
    originUrl,
    head: facts.head,
    lsRemoteImpl: makeGitLsRemoteImpl({
      repo: repoRoot,
      originUrl,
      execFileSyncImpl,
      timeoutMs: LS_REMOTE_TIMEOUT_MS,
    }),
  });
  const revisionProbe = await probeRuntimeRevision({
    baseUrl: REQUIRED_PRODUCTION_PROBE_ORIGIN,
    fetchImpl,
  });
  const expectedIdentity = computeCutoverWindowIdentity({
    candidateCommit: git.head,
    remoteMain: liveGithub.liveRemoteMain,
    deployedRevision: revisionProbe.revision,
  });
  const writeStopBinding = currentWriteStopBinding(repoRoot, {
    expectedIdentity,
    expectedCommit: git.head,
    now,
  });
  const writeStopDoc = writeStopBinding.ok ? writeStopBinding.doc : null;
  const freezeBinding = currentFreezeBinding(repoRoot, {
    expectedIdentity,
    expectedCommit: git.head,
    writeStopGeneratedAt: writeStopDoc?.generatedAt,
    now,
  });
  return {
    git,
    backups: scanCutoverBackups(repoRoot),
    writeStopEvidence: writeStopDoc,
    freezeEvidence: freezeBinding.ok ? freezeBinding.doc : null,
    railwayLivePreflight,
    liveResult: live,
    runtimeRevision: revisionProbe.revision,
    liveRemoteMain: liveGithub.liveRemoteMain,
    now,
  };
}

export async function enforceProductionApplyGate({
  repoRoot,
  env = process.env,
  argv = [],
  client,
  masked,
  writesCommitted = false,
  resume = false,
  phase = MIGRATION_PHASE.WAVE1_INITIAL,
  attemptStore = null,
  execFileSyncImpl,
  fetchImpl,
  runPreflightImpl,
  now,
} = {}) {
  if (!isProductionMigrateTarget(env) || !writesCommitted) {
    const mode = await enforceConnectedApplyTarget(client, masked, env, {
      writesCommitted,
      resume,
    });
    return {
      mode,
      authorized: false,
      safeToMigrateProductionData: false,
      migrationAuthorized: false,
      phase,
      attempt: null,
    };
  }
  const ctx = await collectProductionApplyContext(repoRoot, {
    env,
    now,
    execFileSyncImpl,
    fetchImpl,
    runPreflightImpl,
  });
  return authorizeProductionMigrationApply({
    env,
    argv,
    client,
    masked,
    writesCommitted,
    resume,
    phase,
    attemptStore,
    ...ctx,
  });
}
