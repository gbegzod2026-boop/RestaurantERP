import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const directDatabaseSdk = /https:\/\/www\.gstatic\.com\/firebasejs\/[^"'`\s]+\/firebase-database\.js/g;
const directRestDatabase = /https:\/\/[^"'`\s]+(?:firebaseio\.com|firebasedatabase\.app)\/[^"'`\s]*\.json/g;
const packageDatabaseSdk = /(?:from\s*|import\s*\(\s*)["']firebase\/database["']/g;

function frontendFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return frontendFiles(path);
    return [".js", ".html"].includes(extname(entry.name)) ? [path] : [];
  });
}

// These are infrastructure roots, not tenant data. Counts are intentional:
// adding another native SDK import requires reviewing and updating this list.
const nativeSdkAllowlist = new Map([
  ["admin.html", 1],          // systemData/globalAnnouncement
  ["help.html", 1],           // systemData/platform contact information
  ["index.html", 1],          // public marketing landingRequests
  ["js/pgRtdb.js", 2],        // the sole tenant-data bridge
  ["superadmin.html", 3],     // genuine .info and marketing landingRequests
]);

test("all public JS and HTML keep native RTDB access on the exact infrastructure allowlist", () => {
  const seen = new Map();
  for (const file of frontendFiles(publicDir)) {
    const source = readFileSync(file, "utf8");
    const rel = relative(publicDir, file).replaceAll("\\", "/");
    const imports = source.match(directDatabaseSdk) || [];
    if (imports.length) seen.set(rel, imports.length);
    assert.doesNotMatch(source, directRestDatabase, `${rel} bypasses the frontend data bridge`);
    assert.doesNotMatch(source, packageDatabaseSdk, `${rel} imports firebase/database directly`);
  }
  assert.deepEqual(seen, nativeSdkAllowlist);
});

test("native infrastructure files reference only their approved RTDB roots", () => {
  const approvedMarkers = new Map([
    ["admin.html", ["systemData/globalAnnouncement"]],
    ["help.html", ["systemData/platform"]],
    ["index.html", ["landingRequests"]],
    ["superadmin.html", [".info/connected", "landingRequests"]],
  ]);
  for (const [rel, roots] of approvedMarkers) {
    const source = readFileSync(new URL(`../public/${rel}`, import.meta.url), "utf8");
    for (const marker of roots) assert.ok(source.includes(marker), `${rel} lost approved ${marker} use`);
  }
});

test("public frontend does not bake the production Firebase project into runtime init", () => {
  for (const file of frontendFiles(publicDir)) {
    const source = readFileSync(file, "utf8");
    const rel = relative(publicDir, file).replaceAll("\\", "/");
    if (rel === "js/nestaFirebaseApp.js") {
      assert.match(source, /loadNestaFirebaseApp/);
      assert.doesNotMatch(source, /apiKey:\s*["']AIza/);
      continue;
    }
    assert.doesNotMatch(source, /restoran-30d51/, `${rel} still embeds production Firebase project`);
    assert.doesNotMatch(source, /AIzaSyCGCCIP3eFg40bOEENDLGcrw9c484ySCHQ/, `${rel} still embeds production apiKey`);
  }
});
