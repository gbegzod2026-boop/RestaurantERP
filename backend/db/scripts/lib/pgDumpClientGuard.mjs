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

/**
 * Production pg_restore --list acceptance. ALL of the following must hold:
 * 1. no spawnSync error
 * 2. no OS signal
 * 3. status === 0
 * 4. stdout+stderr contain no `pg_restore: error:` or `pg_restore: fatal:`
 * 5. stdout has `; Archive created at`
 * 6. stdout has `; TOC Entries: <N>` with N >= 1
 * 7. stdout has `; Format: CUSTOM`
 * 8. stdout has `; Selected TOC Entries:`
 * 9. stdout has exactly N dump TOC item lines (`^\d+;\s+\d+\s+\d+\s+\S+`)
 *
 * status !== 0, SIGPIPE, spawn errors, partial headers, or error diagnostics
 * are FAIL. This helper authorizes the backup gate; it never treats
 * broken-pipe as success.
 */
export const PG_RESTORE_LIST_CONTRACT = "status=0, no spawn error, no signal, no pg_restore error/fatal, complete custom-format TOC";

const TOC_ARCHIVE_HEADER = /;\s*Archive created at/i;
const TOC_ENTRIES_HEADER = /;\s*TOC Entries:\s*(\d+)/i;
const TOC_FORMAT_CUSTOM = /;\s*Format:\s*CUSTOM\b/i;
const TOC_SELECTED = /;\s*Selected TOC Entries:/i;
const TOC_ITEM_LINE = /^\d+;\s+\d+\s+\d+\s+\S+/gm;
const PG_RESTORE_FAILURE = /pg_restore:\s*(error|fatal):/i;

function listFailure(reason, extra = {}) {
  return { ok: false, verified: false, authorizing: false, reason, status: extra.status ?? null };
}

export function verifyPgRestoreListResult({
  status = null,
  stdout = "",
  stderr = "",
  signal = null,
  error = null,
} = {}) {
  if (error) {
    return listFailure("pg_restore --list spawn failed", { status });
  }
  if (signal) {
    return listFailure(`pg_restore --list terminated by signal ${signal}`, { status });
  }
  if (status !== 0) {
    return listFailure(`pg_restore --list failed (status=${status})`, { status });
  }
  const combined = `${stdout || ""}\n${stderr || ""}`;
  if (PG_RESTORE_FAILURE.test(combined)) {
    return listFailure("pg_restore --list reported error/fatal diagnostics", { status });
  }
  const body = String(stdout || "");
  if (!TOC_ARCHIVE_HEADER.test(body)) {
    return listFailure("pg_restore --list is missing archive header", { status });
  }
  const declaredMatch = body.match(TOC_ENTRIES_HEADER);
  const declared = declaredMatch ? Number(declaredMatch[1]) : NaN;
  if (!Number.isInteger(declared) || declared < 1) {
    return listFailure("pg_restore --list is missing a positive TOC Entries count", { status });
  }
  if (!TOC_FORMAT_CUSTOM.test(body)) {
    return listFailure("pg_restore --list is not a CUSTOM-format archive listing", { status });
  }
  if (!TOC_SELECTED.test(body)) {
    return listFailure("pg_restore --list is missing Selected TOC Entries", { status });
  }
  TOC_ITEM_LINE.lastIndex = 0;
  const items = body.match(TOC_ITEM_LINE) || [];
  if (items.length !== declared) {
    return listFailure(
      `pg_restore --list is incomplete (listed ${items.length} TOC items, declared ${declared})`,
      { status },
    );
  }
  return {
    ok: true,
    verified: true,
    authorizing: true,
    reason: null,
    status: 0,
    tocEntries: declared,
  };
}

/**
 * Legacy observation helper for historical PowerShell
 * `pg_restore --list dump | Select-Object -First N` broken-pipe evidence.
 * NEVER authorizing. Must not be used as a backup gate.
 */
export function describeLegacyBrokenPipePgRestoreList(result = {}) {
  void result;
  return {
    authorizing: false,
    verified: false,
    ok: false,
    legacyObservationOnly: true,
    reason: "PowerShell broken-pipe listings are not a production backup verification path",
  };
}

export function runPgRestoreList(exe, dumpFile, spawn = spawnSync) {
  const r = spawn(exe, ["--list", dumpFile], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    signal: r.signal || null,
    error: r.error || null,
  };
}
