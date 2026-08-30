// pg_dump / pg_restore client resolution and major-version compatibility.
// Never logs connection URLs or passwords.
import path from "path";
import { spawnSync } from "child_process";
import { redactSecrets } from "./pgBackupRestoreTarget.mjs";

export function parsePgVersionString(text) {
  const line = String(text || "").trim().split(/\r?\n/)[0].trim();
  const m = line.match(/(\d+)\.(\d+)/);
  if (!m) {
    return { ok: false, reason: "unparseable PostgreSQL version", raw: line || null };
  }
  return {
    ok: true,
    major: Number(m[1]),
    minor: Number(m[2]),
    raw: line,
  };
}

export function parseServerVersionNum(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n < 100000) return null;
  return { major: Math.floor(n / 10000), minor: n % 10000 };
}

export function formatDumpIncompatible(serverMajor, dumpMajor) {
  return `PG_DUMP_VERSION_INCOMPATIBLE:\nserver=${serverMajor}\npg_dump=${dumpMajor}`;
}

export function assertPgDumpCompatible(serverMajor, dumpMajor) {
  const server = Number(serverMajor);
  const dump = Number(dumpMajor);
  if (!Number.isFinite(server) || !Number.isFinite(dump)) {
    return { ok: false, code: "PG_DUMP_VERSION_UNKNOWN", reason: "PostgreSQL major version is unknown" };
  }
  if (dump < server) {
    return {
      ok: false,
      code: "PG_DUMP_VERSION_INCOMPATIBLE",
      reason: formatDumpIncompatible(server, dump),
      server,
      pg_dump: dump,
    };
  }
  return { ok: true, code: "PG_DUMP_VERSION_OK", server, pg_dump: dump };
}

export function assertPgRestoreCompatible(serverMajor, restoreMajor) {
  const server = Number(serverMajor);
  const restore = Number(restoreMajor);
  if (!Number.isFinite(server) || !Number.isFinite(restore)) {
    return { ok: false, code: "PG_RESTORE_VERSION_UNKNOWN", reason: "PostgreSQL major version is unknown" };
  }
  if (restore < server) {
    return {
      ok: false,
      code: "PG_RESTORE_VERSION_INCOMPATIBLE",
      reason: `PG_RESTORE_VERSION_INCOMPATIBLE:\nserver=${server}\npg_restore=${restore}`,
      server,
      pg_restore: restore,
    };
  }
  return { ok: true, code: "PG_RESTORE_VERSION_OK", server, pg_restore: restore };
}

function envBin(env, key) {
  return String(env?.[key] || "").trim();
}

function defaultToolName(base, platform) {
  if (platform === "win32" && !base.endsWith(".exe")) return `${base}.exe`;
  return base;
}

export function resolvePgClientBins(env = {}, { platform = process.platform } = {}) {
  const dir = envBin(env, "POSTGRES_BIN_DIR");
  const dumpName = defaultToolName("pg_dump", platform);
  const restoreName = defaultToolName("pg_restore", platform);

  const dumpExplicit = envBin(env, "PG_DUMP_BIN");
  const restoreExplicit = envBin(env, "PG_RESTORE_BIN");

  const pgDump = dumpExplicit
    ? { path: dumpExplicit, source: "PG_DUMP_BIN" }
    : dir
      ? { path: path.join(dir, dumpName), source: "POSTGRES_BIN_DIR" }
      : { path: dumpName, source: "PATH" };

  const pgRestore = restoreExplicit
    ? { path: restoreExplicit, source: "PG_RESTORE_BIN" }
    : dir
      ? { path: path.join(dir, restoreName), source: "POSTGRES_BIN_DIR" }
      : { path: restoreName, source: "PATH" };

  return { pgDump, pgRestore };
}

export function probePgToolVersion(exe, spawn = spawnSync) {
  let r;
  try {
    r = spawn(exe, ["--version"], { encoding: "utf8" });
  } catch {
    return { ok: false, path: exe, reason: `failed to run ${path.basename(String(exe))} --version` };
  }
  if (!r || (r.status !== 0 && !r.stdout && !r.stderr)) {
    return { ok: false, path: exe, reason: `failed to run ${path.basename(String(exe))} --version` };
  }
  const text = redactSecrets(`${r.stdout || ""}\n${r.stderr || ""}`);
  const parsed = parsePgVersionString(text);
  if (!parsed.ok) {
    return {
      ok: false,
      path: exe,
      reason: r.status !== 0
        ? `failed to run ${path.basename(String(exe))} --version`
        : parsed.reason,
      raw: parsed.raw,
    };
  }
  return {
    ok: true,
    path: exe,
    major: parsed.major,
    minor: parsed.minor,
    version: `${parsed.major}.${parsed.minor}`,
    raw: parsed.raw,
  };
}

export function clientToolsReport(bins, dumpProbe, restoreProbe, server = null) {
  return {
    serverMajor: server?.major ?? server?.serverMajor ?? null,
    serverVersion: server?.raw ?? server?.serverVersion ?? null,
    pgDumpPath: bins.pgDump.path,
    pgDumpSource: bins.pgDump.source,
    pgDumpVersion: dumpProbe?.version || dumpProbe?.raw || null,
    pgDumpMajor: dumpProbe?.major ?? null,
    pgRestorePath: bins.pgRestore.path,
    pgRestoreSource: bins.pgRestore.source,
    pgRestoreVersion: restoreProbe?.version || restoreProbe?.raw || null,
    pgRestoreMajor: restoreProbe?.major ?? null,
  };
}
