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
 * Production pg_restore --list --verbose acceptance.
 *
 * PrintTOCSummary (REL_18_STABLE pg_backup_archiver.c) emits:
 *   `%d; %u %u %s %s %s %s\n`
 *   dumpId; tableoid oid desc schema name owner
 *
 * Safely provable from one line:
 * - dumpId, tableoid, oid (integers)
 * - desc, matched longest-prefix against PostgreSQL 18 ArchiveEntry
 *   description vocabulary
 * - catalog-ID invariants that pg_dump actually writes
 *   (DATABASE uses pg_database.tableoid/oid; REQ_SPECIAL and
 *   DATABASE PROPERTIES use nilCatalogId {0,0})
 * - nonempty schema/name/owner tail after desc
 * - minimum whitespace-separated field count from whether ArchiveEntry
 *   omitted namespace and/or owner (spaces only increase the count)
 *
 * - N == count of unique valid items (no ± tolerance)
 * - exactly one each of ENCODING, STDSTRINGS, SEARCHPATH, DATABASE
 *   (unconditional for this full custom-format database dump workflow;
 *   DATABASE PROPERTIES is optional)
 *
 * Intentionally NOT inferred (sanitize_line does not quote names):
 * - SQL identifier validity from character content
 * - exact tag vs owner split when any field contains spaces
 * - numeric / punctuation / UTF-8 / spaced names as "fake"
 */
export const PG_RESTORE_LIST_CONTRACT = "status=0, no spawn error, no signal, no pg_restore error/fatal, verbose structurally valid unique TOC";
export const PG_RESTORE_LIST_ARGS = Object.freeze(["--list", "--verbose"]);

/** pg_database catalog OID from PostgreSQL 18 pg_database.h (DatabaseRelationId). */
export const PG_DATABASE_RELATION_ID = 1262;

/** Permissive historic matcher. NEVER used to authorize. */
export const LEGACY_PERMISSIVE_TOC_ITEM_LINE = /^\d+;\s+\d+\s+\d+\s+\S+/gm;

/**
 * PostgreSQL 18 ArchiveEntry `.description` strings from REL_18_6 pg_dump.c
 * (the installed pg_restore 18.6 toolchain): string literals plus runtime
 * reltypename / dumpFunc / dumpConstraint keywords.
 * Longest-first matching so TABLE DATA is not parsed as TABLE, and
 * DATABASE PROPERTIES is not parsed as DATABASE.
 */
export const PG_DUMP_TOC_DESCRIPTIONS = Object.freeze([
  "PUBLICATION TABLES IN SCHEMA",
  "TEXT SEARCH CONFIGURATION",
  "MATERIALIZED VIEW DATA",
  "TEXT SEARCH DICTIONARY",
  "FOREIGN DATA WRAPPER",
  "TEXT SEARCH TEMPLATE",
  "DATABASE PROPERTIES",
  "TEXT SEARCH PARSER",
  "SUBSCRIPTION TABLE",
  "SEQUENCE OWNED BY",
  "CHECK CONSTRAINT",
  "MATERIALIZED VIEW",
  "OPERATOR FAMILY",
  "PROCEDURAL LANGUAGE",
  "PUBLICATION TABLE",
  "STATISTICS DATA",
  "BLOB METADATA",
  "DEFAULT ACL",
  "EVENT TRIGGER",
  "FK CONSTRAINT",
  "FOREIGN TABLE",
  "INDEX ATTACH",
  "OPERATOR CLASS",
  "ROW SECURITY",
  "SECURITY LABEL",
  "SEQUENCE SET",
  "SHELL TYPE",
  "TABLE ATTACH",
  "TABLE DATA",
  "USER MAPPING",
  "ACCESS METHOD",
  "AGGREGATE",
  "COLLATION",
  "CONSTRAINT",
  "CONVERSION",
  "DATABASE",
  "ENCODING",
  "EXTENSION",
  "PROCEDURE",
  "PUBLICATION",
  "SEARCHPATH",
  "SEQUENCE",
  "STATISTICS",
  "STDSTRINGS",
  "SUBSCRIPTION",
  "TRANSFORM",
  "FUNCTION",
  "OPERATOR",
  "POLICY",
  "TRIGGER",
  "COMMENT",
  "DEFAULT",
  "DOMAIN",
  "INDEX",
  "SCHEMA",
  "SERVER",
  "BLOBS",
  "CAST",
  "RULE",
  "TYPE",
  "VIEW",
  "ACL",
  "TABLE",
  "pg_largeobject",
].sort((a, b) => b.length - a.length || a.localeCompare(b)));

const TOC_ARCHIVE_HEADER = /;\s*Archive created at/i;
const TOC_ENTRIES_HEADER = /;\s*TOC Entries:\s*(\d+)/i;
const TOC_FORMAT_CUSTOM = /;\s*Format:\s*CUSTOM\b/i;
const TOC_SELECTED = /;\s*Selected TOC Entries:/i;
const PG_RESTORE_FAILURE = /pg_restore:\s*(error|fatal):/i;
const UINT32_MAX = 4294967295;
const DUMP_ID_MAX = 2147483647;
const REQUIRED_SPECIAL_DESCS = Object.freeze(["ENCODING", "STDSTRINGS", "SEARCHPATH", "DATABASE"]);

/**
 * ArchiveEntry omits namespace (PrintTOCSummary schema field is "-").
 * COMMENT/ACL/SECURITY LABEL/DEFAULT ACL are excluded: namespace is optional.
 */
const NIL_NAMESPACE_DESCS = new Set([
  "ENCODING",
  "STDSTRINGS",
  "SEARCHPATH",
  "DATABASE",
  "DATABASE PROPERTIES",
  "EXTENSION",
  "CAST",
  "TRANSFORM",
  "pg_largeobject",
  "ACCESS METHOD",
  "BLOBS",
  "BLOB METADATA",
  "SCHEMA",
  "PUBLICATION",
  "SUBSCRIPTION",
  "EVENT TRIGGER",
  "PROCEDURAL LANGUAGE",
  "SERVER",
  "FOREIGN DATA WRAPPER",
  "USER MAPPING",
]);

/**
 * ArchiveEntry omits owner or may pass NULL/empty owner, so the last %s
 * may be absent. Spaces in remaining fields only increase token count.
 */
const OPTIONAL_OWNER_DESCS = new Set([
  "ENCODING",
  "STDSTRINGS",
  "SEARCHPATH",
  "EXTENSION",
  "CAST",
  "TRANSFORM",
  "pg_largeobject",
  "ACCESS METHOD",
  "STATISTICS DATA",
  "COMMENT",
  "ACL",
  "SECURITY LABEL",
]);

function failTail(reason) {
  return { ok: false, reason };
}

function tokenizeTocTail(after) {
  return String(after || "").trim() ? String(after).trim().split(/\s+/).filter(Boolean) : [];
}

function minTailTokens(desc) {
  return OPTIONAL_OWNER_DESCS.has(desc) ? 2 : 3;
}

function validateTocTail(desc, tableOid, objectOid, after) {
  const tokens = tokenizeTocTail(after);
  if (!tokens.length) {
    return failTail("STOP: TOC item is truncated (missing schema/name/owner fields)");
  }

  if (desc === "ENCODING" || desc === "STDSTRINGS" || desc === "SEARCHPATH") {
    if (tableOid !== 0 || objectOid !== 0) {
      return failTail(`STOP: ${desc} TOC entry must use nilCatalogId 0 0`);
    }
    if (tokens.length !== 2 || tokens[0] !== "-" || tokens[1] !== desc) {
      return failTail(`STOP: ${desc} TOC entry shape must be "- ${desc}"`);
    }
    return { ok: true };
  }

  if (desc === "DATABASE") {
    if (tableOid !== PG_DATABASE_RELATION_ID || objectOid === 0) {
      return failTail("STOP: DATABASE TOC entry catalog ID must be pg_database tableoid with a nonzero object OID");
    }
    if (tokens[0] !== "-" || tokens.length < 3) {
      return failTail("STOP: DATABASE TOC entry must start with namespace \"-\" and include name and owner fields");
    }
    return { ok: true };
  }

  if (desc === "DATABASE PROPERTIES") {
    if (tableOid !== 0 || objectOid !== 0) {
      return failTail("STOP: DATABASE PROPERTIES TOC entry must use nilCatalogId 0 0");
    }
    if (tokens[0] !== "-" || tokens.length < 3) {
      return failTail("STOP: DATABASE PROPERTIES TOC entry must start with namespace \"-\" and include name and owner fields");
    }
    return { ok: true };
  }

  if (NIL_NAMESPACE_DESCS.has(desc) && tokens[0] !== "-") {
    return failTail(`STOP: ${desc} TOC entry must use namespace placeholder "-"`);
  }

  if (tokens.length < minTailTokens(desc)) {
    return failTail(`STOP: ${desc} TOC entry is truncated (missing schema/name/owner fields)`);
  }
  return { ok: true };
}

function listFailure(reason, extra = {}) {
  return { ok: false, verified: false, authorizing: false, reason, status: extra.status ?? null };
}

function parseUnsigned32(text, label) {
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    return { ok: false, reason: `STOP: TOC ${label} is not a valid unsigned integer` };
  }
  const n = Number(text);
  if (!Number.isInteger(n) || n > UINT32_MAX) {
    return { ok: false, reason: `STOP: TOC ${label} is out of range` };
  }
  return { ok: true, value: n };
}

function matchKnownDescription(rest) {
  for (const desc of PG_DUMP_TOC_DESCRIPTIONS) {
    if (rest === desc || rest.startsWith(`${desc} `)) return desc;
  }
  return null;
}

export function parsePgRestoreTocItemLine(line) {
  const raw = String(line || "");
  const m = /^([1-9]\d*); (0|[1-9]\d*) (0|[1-9]\d*) (.+)$/.exec(raw);
  if (!m) {
    return { ok: false, reason: "STOP: TOC item line is not dumpId; tableoid oid desc ..." };
  }
  const dumpIdRaw = m[1];
  const dumpId = Number(dumpIdRaw);
  if (!Number.isInteger(dumpId) || dumpId < 1 || dumpId > DUMP_ID_MAX) {
    return { ok: false, reason: "STOP: TOC dump ID is not a positive archive dumpId" };
  }
  const tableOid = parseUnsigned32(m[2], "catalog OID");
  if (!tableOid.ok) return tableOid;
  const objectOid = parseUnsigned32(m[3], "object OID");
  if (!objectOid.ok) return objectOid;
  const rest = m[4].trimEnd();
  const desc = matchKnownDescription(rest);
  if (!desc) {
    return { ok: false, unsupported: true, reason: "STOP: TOC item has an unknown object description" };
  }
  const after = rest.slice(desc.length).trim();
  const tableOidValue = tableOid.value;
  const objectOidValue = objectOid.value;
  const tail = validateTocTail(desc, tableOidValue, objectOidValue, after);
  if (!tail.ok) return tail;
  return {
    ok: true,
    dumpId,
    tableOid: tableOidValue,
    objectOid: objectOidValue,
    desc,
  };
}

export function parsePgRestoreVerboseToc(body) {
  const malformed = [];
  const unsupported = [];
  const items = [];
  const lines = String(body || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\s*;/.test(line)) continue;
    const parsed = parsePgRestoreTocItemLine(line);
    if (!parsed.ok) {
      if (parsed.unsupported) unsupported.push(parsed.reason);
      else malformed.push(parsed.reason);
      continue;
    }
    items.push(parsed);
  }
  const seen = new Set();
  const duplicates = [];
  for (const item of items) {
    if (seen.has(item.dumpId)) duplicates.push(item.dumpId);
    seen.add(item.dumpId);
  }
  const byDesc = new Map();
  for (const item of items) {
    byDesc.set(item.desc, (byDesc.get(item.desc) || 0) + 1);
  }
  return {
    items,
    uniqueDumpIds: seen.size,
    duplicates,
    malformed,
    unsupported,
    byDesc,
  };
}

export function countPgRestoreTocItemLines(body) {
  const parsed = parsePgRestoreVerboseToc(body);
  if (parsed.malformed.length || parsed.unsupported.length || parsed.duplicates.length) {
    return parsed.uniqueDumpIds;
  }
  return parsed.uniqueDumpIds;
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
  const parsed = parsePgRestoreVerboseToc(body);
  const specials = Object.fromEntries(
    REQUIRED_SPECIAL_DESCS.map((desc) => [desc, parsed.byDesc.get(desc) || 0]),
  );
  const tocMeta = {
    tocEntries: declared,
    uniqueDumpIds: parsed.uniqueDumpIds,
    malformed: parsed.malformed.length,
    unsupported: parsed.unsupported.length,
    duplicates: parsed.duplicates.length,
    specials,
  };
  if (parsed.malformed.length) {
    return { ...listFailure(parsed.malformed[0], { status }), ...tocMeta };
  }
  if (parsed.unsupported.length) {
    return { ...listFailure(parsed.unsupported[0], { status }), ...tocMeta };
  }
  if (parsed.duplicates.length) {
    return {
      ...listFailure(
        `pg_restore --list has duplicate dump ID ${parsed.duplicates[0]}`,
        { status },
      ),
      ...tocMeta,
    };
  }
  if (parsed.uniqueDumpIds !== declared) {
    return {
      ...listFailure(
        `pg_restore --list is incomplete (listed ${parsed.uniqueDumpIds} unique TOC items, declared ${declared})`,
        { status },
      ),
      ...tocMeta,
    };
  }
  for (const desc of REQUIRED_SPECIAL_DESCS) {
    const n = parsed.byDesc.get(desc) || 0;
    if (n !== 1) {
      return {
        ...listFailure(
          `pg_restore --list requires exactly one ${desc} TOC entry, found ${n}`,
          { status },
        ),
        ...tocMeta,
      };
    }
  }
  return {
    ok: true,
    verified: true,
    authorizing: true,
    reason: null,
    status: 0,
    ...tocMeta,
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
  const r = spawn(exe, [...PG_RESTORE_LIST_ARGS, dumpFile], {
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
