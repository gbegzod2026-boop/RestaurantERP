#!/usr/bin/env node
// Local developer helper: copy admin-frontend/public -> backend/public.
// Never fetches the network. Not imported by server.js / Railway runtime.
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SYNC_DEST = path.resolve(here, "../public");
export const SYNC_SRC = path.resolve(here, "../../admin-frontend/public");

const BLOCKED_EXT = new Set([".bak", ".log", ".map", ".docx", ".doc", ".pem", ".p12", ".pfx"]);
const BLOCKED_DIR = new Set(["word", "node_modules", ".git"]);

export function isBlockedName(name, { isDirectory = false } = {}) {
  const n = String(name || "").toLowerCase();
  if (!n) return true;
  if (isDirectory) return BLOCKED_DIR.has(n);
  if (n === ".env" || n.startsWith(".env.")) return true;
  if (n === ".npmrc" || n === ".ds_store" || n === "thumbs.db") return true;
  if (n === "serviceaccountkey.json" || n.includes("service-account")) return true;
  const ext = path.extname(n);
  if (BLOCKED_EXT.has(ext)) return true;
  if (ext === ".key" && n !== "public.key") return true;
  return false;
}

export function shouldCopy(srcPath) {
  let st;
  try {
    st = lstatSync(srcPath);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) return false;
  const name = path.basename(srcPath);
  if (st.isDirectory()) return !isBlockedName(name, { isDirectory: true });
  return !isBlockedName(name);
}

export function syncFrontend() {
  if (!existsSync(SYNC_SRC)) {
    throw new Error("sync-frontend: source directory is missing");
  }
  rmSync(SYNC_DEST, { recursive: true, force: true });
  mkdirSync(SYNC_DEST, { recursive: true });
  cpSync(SYNC_SRC, SYNC_DEST, {
    recursive: true,
    dereference: false,
    filter: shouldCopy,
  });
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  try {
    syncFrontend();
    console.log("sync-frontend: copied admin-frontend/public -> backend/public");
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}
