import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { once } from "node:events";
import { qrSigningHealth } from "../../security/qrSign.js";
import { getDataBackend } from "../../pg/config.js";
import { isPgAvailable } from "../../db/postgres.js";
import { getDatabaseState } from "../../db.js";
import { isMaintenanceMode, isMaintenanceAllowed } from "../../security/maintenance.js";
import { publicDeploymentIdentity } from "../../security/deploymentRevision.js";
import { authEnvironmentDiagnostic } from "../../firebaseEnv.js";
import { isBlockedName, shouldCopy } from "../../scripts/sync-frontend.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, "../..");
const serverSrc = readFileSync(path.join(backendRoot, "server.js"), "utf8");
const staticPath = path.join(backendRoot, "public");
const sourcePublic = path.join(backendRoot, "../admin-frontend/public");
const TESTED_PAGES = ["/", "/login.html", "/index.html", "/headoffice.html"];

function walkFiles(dir, acc = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

function isExternalRef(ref) {
  return /^(https?:|\/\/|data:|mailto:|tel:|#|javascript:)/i.test(String(ref || "").trim());
}

function toUrlPath(ref, fromFile) {
  const cleaned = String(ref || "").trim().split(/[?#]/)[0];
  if (!cleaned || isExternalRef(cleaned)) return null;
  if (cleaned.startsWith("/")) return cleaned;
  const fromDir = path.posix.dirname("/" + fromFile.replaceAll("\\", "/"));
  const resolved = path.posix.normalize(path.posix.join(fromDir, cleaned));
  return resolved.startsWith("/") ? resolved : `/${resolved}`;
}

function extractHtmlAssetRefs(html) {
  const refs = [];
  const re = /<(?:script|link|img|source|video|audio|use)\b[^>]*>/gi;
  const attrRe = /\b(?:src|href)=["']([^"']+)["']/i;
  let match;
  while ((match = re.exec(html))) {
    const attr = match[0].match(attrRe);
    if (attr) refs.push(attr[1]);
  }
  return refs;
}

function extractCssUrls(css) {
  const refs = [];
  const re = /url\(\s*(['"]?)([^"')]+)\1\s*\)/gi;
  let match;
  while ((match = re.exec(css))) refs.push(match[2]);
  return refs;
}

function stripJsComments(js) {
  return String(js || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function extractJsLocalImports(js) {
  const refs = [];
  const re = /(?:import|export)\s+(?:[^'"\n]*from\s+)?["'](\.[^"']+)["']/g;
  let match;
  while ((match = re.exec(js))) refs.push(match[1]);
  return refs;
}

function collectRuntimeAssets(pageFile) {
  const pending = [pageFile];
  const seen = new Set();
  const assets = [];
  while (pending.length) {
    const rel = pending.pop();
    const urlPath = rel.startsWith("/") ? rel : `/${rel.replaceAll("\\", "/")}`;
    if (seen.has(urlPath)) continue;
    seen.add(urlPath);
    assets.push(urlPath);
    const disk = path.join(staticPath, urlPath.replace(/^\//, ""));
    if (!existsSync(disk)) continue;
    const ext = path.extname(disk).toLowerCase();
    const text = (ext === ".html" || ext === ".css" || ext === ".js")
      ? readFileSync(disk, "utf8")
      : "";
    const refs = ext === ".html"
      ? [...extractHtmlAssetRefs(text), ...extractJsLocalImports(text)]
      : ext === ".css"
        ? extractCssUrls(text)
        : ext === ".js"
          ? extractJsLocalImports(stripJsComments(text))
          : [];
    const fromFile = urlPath.replace(/^\//, "");
    for (const ref of refs) {
      const next = toUrlPath(ref, fromFile);
      if (next) pending.push(next);
    }
  }
  return assets;
}

async function withStaticApp(fn) {
  const app = express();
  app.get("/api/health", async (_req, res) => {
    const qr = qrSigningHealth();
    const payload = {
      ok: qr.ok !== false,
      dbState: getDatabaseState(),
      dataBackend: getDataBackend(),
      postgres: isPgAvailable(),
      qrSigning: qr.qrSigning,
      maintenance: isMaintenanceMode(),
      revision: publicDeploymentIdentity().revision,
      ...authEnvironmentDiagnostic(),
    };
    if (!qr.ok) return res.status(503).json(payload);
    res.json(payload);
  });
  app.use((req, res, next) => {
    if (req.path.toLowerCase().endsWith(".bak")) {
      return res.status(404).end();
    }
    next();
  });
  app.use(express.static(staticPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      }
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    await fn(port);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("sync denylist blocks internal docs, bak, env, and secrets by name", () => {
  assert.equal(isBlockedName("NestaCRM_Admin_Tahlil.docx"), true);
  assert.equal(isBlockedName("admin.html.bak"), true);
  assert.equal(isBlockedName("notes.log"), true);
  assert.equal(isBlockedName("app.js.map"), true);
  assert.equal(isBlockedName(".env"), true);
  assert.equal(isBlockedName(".env.local"), true);
  assert.equal(isBlockedName(".npmrc"), true);
  assert.equal(isBlockedName("word", { isDirectory: true }), true);
  assert.equal(isBlockedName("login.html"), false);
  assert.equal(isBlockedName("headoffice.css"), false);
  assert.equal(shouldCopy(path.join(sourcePublic, "login.html")), true);
  assert.equal(shouldCopy(path.join(sourcePublic, "word/NestaCRM_Admin_Tahlil.docx")), false);
});

test("server.js serves backend/public and keeps bak/html/health wiring", () => {
  assert.match(serverSrc, /const staticPath = path\.join\(__dirname, "public"\);/);
  assert.doesNotMatch(serverSrc, /const staticPath = path\.join\(__dirname, "\.\.\/admin-frontend\/public"\);/);
  assert.match(serverSrc, /req\.path\.toLowerCase\(\)\.endsWith\("\.bak"\)/);
  assert.match(serverSrc, /Cache-Control", "no-cache, must-revalidate"/);
  assert.match(serverSrc, /app\.get\("\/api\/health"/);
  assert.match(serverSrc, /dataBackend: getDataBackend\(\)/);
  assert.match(serverSrc, /if \(!qr\.ok\) return res\.status\(503\)\.json\(payload\);/);
  assert.equal(existsSync(path.join(sourcePublic, "login.html")), true);
  assert.equal(existsSync(path.join(sourcePublic, "word/NestaCRM_Admin_Tahlil.docx")), true);
  assert.equal(existsSync(path.join(staticPath, "login.html")), true);
  assert.equal(existsSync(path.join(staticPath, "index.html")), true);
  assert.equal(existsSync(path.join(staticPath, "headoffice.html")), true);
  assert.equal(existsSync(path.join(staticPath, "js/headoffice.js")), false);
  assert.equal(existsSync(path.join(staticPath, "word/NestaCRM_Admin_Tahlil.docx")), false);
  assert.equal(existsSync(path.join(staticPath, ".env")), false);
  const publicFiles = walkFiles(staticPath);
  assert.equal(publicFiles.some((f) => f.toLowerCase().endsWith(".bak")), false);
  assert.equal(publicFiles.some((f) => f.toLowerCase().endsWith(".docx")), false);
  const hoHtml = readFileSync(path.join(staticPath, "headoffice.html"), "utf8");
  assert.doesNotMatch(hoHtml, /<script[^>]+src=["'][^"']*headoffice\.js["']/i);
});

test("static pages, denylisted paths, health shape, and local asset refs", async () => {
  // Static HTTP + HTML/CSS/JS reference audit of the deployable tree.
  // This is not a browser runtime / click-through coverage claim.
  await withStaticApp(async (port) => {
    const base = `http://127.0.0.1:${port}`;

    for (const page of TESTED_PAGES) {
      const res = await fetch(`${base}${page}`);
      assert.equal(res.status, 200, `${page} should be 200`);
      if (page.endsWith(".html") || page === "/") {
        assert.equal(res.headers.get("cache-control"), "no-cache, must-revalidate");
      }
    }

    const ho = await fetch(`${base}/headoffice.html`);
    const hoHtml = await ho.text();
    assert.doesNotMatch(hoHtml, /<script[^>]+src=["'][^"']*headoffice\.js["']/i);
    const missingJs = await fetch(`${base}/js/headoffice.js`);
    assert.equal(missingJs.status, 404);

    const bak = await fetch(`${base}/admin.html.bak`);
    assert.equal(bak.status, 404);

    const docx = await fetch(`${base}/word/NestaCRM_Admin_Tahlil.docx`);
    assert.equal(docx.status, 404);

    const pageFiles = {
      "/": "index.html",
      "/index.html": "index.html",
      "/login.html": "login.html",
      "/headoffice.html": "headoffice.html",
    };
    const needed = new Set();
    for (const file of Object.values(pageFiles)) {
      for (const asset of collectRuntimeAssets(file)) needed.add(asset);
    }
    for (const asset of needed) {
      const encoded = asset.split("/").map(encodeURIComponent).join("/").replace(/^\/?/, "/");
      const res = await fetch(`${base}${encoded}`);
      assert.equal(res.status, 200, `runtime asset ${asset} should be 200`);
    }

    const health = await fetch(`${base}/api/health`);
    assert.ok(health.status === 200 || health.status === 503);
    const body = await health.json();
    assert.equal(typeof body.ok, "boolean");
    assert.equal("dbState" in body, true);
    assert.equal("dataBackend" in body, true);
    assert.equal("postgres" in body, true);
    assert.equal("qrSigning" in body, true);
    assert.equal("maintenance" in body, true);
    assert.equal("revision" in body, true);
    assert.equal(isMaintenanceAllowed("GET", "/api/health"), true);
    if (!body.ok) assert.equal(health.status, 503);
  });
});
