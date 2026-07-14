#!/usr/bin/env node
/**
 * sync-upstream.js — Extract full upstream Codex resources
 *
 * Output structure per platform:
 *   src/{platform}/
 *     _asar/              Extracted app.asar content (patch target)
 *     app.asar.unpacked/  Native modules (kept as-is from upstream)
 *     codex|codex.exe     CLI binary (will be replaced by @cometix/codex)
 *     rg|rg.exe           ripgrep binary (kept from upstream)
 *     plugins/            Bundled plugins
 *     native/             Platform native modules
 *     ...                 All other upstream resources
 *
 * Usage:
 *   node scripts/sync-upstream.js [--force] [--skip-mac] [--skip-win] [--platform <target>]
 *
 * Targets:
 *   mac-arm64, mac-x64, linux-arm64, linux-x64, win, win-x64
 */

const https = require("https");
const tls = require("tls");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { assertExtractedVersion, loadPinnedInputs, verifyPinnedFile } = require("./pinned-inputs");

// TLS certs for MS delivery CDN
const certsDir = path.join(__dirname, "certs");
const extraCAs = [...tls.rootCertificates];
for (const f of ["ms-root-ca.pem", "ms-update-ca.pem"]) {
  const p = path.join(certsDir, f);
  if (fs.existsSync(p)) extraCAs.push(fs.readFileSync(p, "utf-8"));
}
https.globalAgent.options.ca = extraCAs;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const TEMP_DIR = path.join(require("os").tmpdir(), "codex-sync");
const VERSION_FILE = path.join(__dirname, ".versions.json");

const APPCAST_ARM64 = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const CHECK_ONLY = args.includes("--check-only");
const SKIP_MAC = args.includes("--skip-mac");
const SKIP_WIN = args.includes("--skip-win");

const PLATFORM_TARGETS = {
  "mac-arm64": ["mac-arm64"],
  "mac-x64": ["mac-x64"],
  "linux-arm64": ["mac-arm64"],
  "linux-x64": ["mac-x64"],
  win: ["win"],
  "win-x64": ["win"],
};

// ─── Helpers ────────────────────────────────────────────────────

function argValue(name) {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) {
    const value = eq.slice(name.length + 1);
    if (!value) throw new Error(`${name} requires a value`);
    return value;
  }

  const idx = args.indexOf(name);
  if (idx === -1) return "";

  const value = args[idx + 1] || "";
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function selectedTargets() {
  const requestedPlatform = argValue("--platform");
  if (requestedPlatform && !PLATFORM_TARGETS[requestedPlatform]) {
    const valid = Object.keys(PLATFORM_TARGETS).join(", ");
    throw new Error(`Unsupported --platform "${requestedPlatform}". Expected one of: ${valid}`);
  }

  const targets = new Set(
    requestedPlatform
      ? PLATFORM_TARGETS[requestedPlatform]
      : ["mac-arm64", "mac-x64", "win"],
  );

  if (SKIP_MAC) {
    targets.delete("mac-arm64");
    targets.delete("mac-x64");
  }
  if (SKIP_WIN) targets.delete("win");

  if (targets.size === 0) {
    throw new Error("No upstream platforms selected after applying --platform/--skip-* options");
  }

  return targets;
}

function httpGet(url) {
  const mod = url.startsWith("https") ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location).then(resolve, reject);
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

function curlDownload(url, dest, label) {
  console.log(`  [dl] ${label}`);
  const partial = `${dest}.download`;
  fs.rmSync(partial, { force: true });
  try {
    execSync(`curl -L --fail --retry 3 --retry-delay 2 -o "${partial}" "${url}"`, { stdio: "inherit" });
    fs.rmSync(dest, { force: true });
    fs.renameSync(partial, dest);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
}

function extractArchive(archive, dest) {
  if (process.platform === "darwin" && archive.endsWith(".zip")) {
    // ditto preserves macOS symlinks + resource forks (required for .app)
    execSync(`ditto -xk "${archive}" "${dest}"`);
  } else {
    // 7zz for Windows MSIX and Linux (symlinks don't matter — only ASAR content used)
    for (const bin of ["7zz", "7z"]) {
      try {
        execSync(`${bin} x -y -o"${dest}" "${archive}"`, { stdio: "pipe" });
        return;
      } catch {
        if (fs.readdirSync(dest).length > 0) return;
      }
    }
    throw new Error(`Failed to extract ${archive}`);
  }
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) { const r = findFile(full, name); if (r) return r; }
  }
  return null;
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d); }
    else if (e.isSymbolicLink()) { /* skip */ }
    else { fs.copyFileSync(s, d); count++; }
  }
  return count;
}

function clearDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

// ─── Version detection ──────────────────────────────────────────

async function getAppcastVersion(url) {
  const { XMLParser } = require("fast-xml-parser");
  const res = await httpGet(url);
  if (res.status !== 200) throw new Error(`Appcast fetch failed: ${res.status}`);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
  const parsed = parser.parse(res.body.toString());
  const items = parsed.rss?.channel?.item;
  const latest = Array.isArray(items) ? items[0] : items;
  let enc = latest.enclosure;
  if (Array.isArray(enc)) enc = enc[0];
  return {
    version: latest.shortVersionString || latest.title,
    build: String(latest.version || ""),
    url: enc?.["@_url"] || "",
  };
}

async function getWindowsVersion() {
  const msstore = require("./fetch-msstore");
  const cookie = await msstore.getCookie();
  const info = await msstore.getAppInfo("9plm9xgg6vks", "US");
  if (!info.categoryId) throw new Error("No CategoryID");
  const pkgs = await msstore.getFileList(cookie, info.categoryId, "Retail");
  if (pkgs.length === 0) throw new Error("No packages");
  const pkg = pkgs[0];
  const url = await msstore.getDownloadUrl(pkg.updateID, pkg.revisionNumber, "Retail", pkg.digest);
  const verMatch = pkg.name.match(/_(\d+\.\d+\.\d+(?:\.\d+)?)_/);
  return { version: verMatch?.[1] || "unknown", url, packageName: pkg.name };
}

// ─── Extract macOS ──────────────────────────────────────────────

async function syncMac(variant, info, destDir) {
  const label = `macOS-${variant}`;
  console.log(`\n-- ${label}`);

  console.log(`   version: ${info.version} (build ${info.build})`);

  const zipPath = path.join(TEMP_DIR, `Codex-${variant}-${info.version}.zip`);
  const extractDir = path.join(
    TEMP_DIR,
    variant === "x64" ? `${variant}-${info.version}-extract` : `${variant}-extract`,
  );

  if (FORCE || !fs.existsSync(zipPath)) {
    curlDownload(info.url, zipPath, label);
  } else {
    console.log(`   [cache] ${zipPath}`);
  }
  if (info.sha256) {
    console.log("   [verify] size + SHA-256");
    await verifyPinnedFile(zipPath, info, label);
  }

  console.log("   [unzip]");
  clearDir(extractDir);
  extractArchive(zipPath, extractDir);

  const resourcesDir = findResourcesDir(extractDir);
  if (!resourcesDir) throw new Error(`${label}: Resources directory not found`);

  assembleOutput(resourcesDir, destDir, label);
  if (info.sha256) {
    assertExtractedVersion(path.join(destDir, "_asar"), info, label);
  }
  return info;
}

// ─── Extract Windows ────────────────────────────────────────────

async function syncWin(destDir) {
  console.log("\n-- Windows");

  const info = await getWindowsVersion();
  console.log(`   version: ${info.version}`);

  const msixPath = path.join(TEMP_DIR, info.packageName || `codex-win-${info.version}.msix`);
  const extractDir = path.join(TEMP_DIR, "win-extract");

  if (!fs.existsSync(msixPath)) {
    curlDownload(info.url, msixPath, "Windows MSIX");
  } else {
    console.log(`   [cache] ${msixPath}`);
  }

  console.log("   [unzip]");
  clearDir(extractDir);
  extractArchive(msixPath, extractDir);

  const resourcesDir = path.join(extractDir, "app", "resources");
  if (!fs.existsSync(resourcesDir)) {
    const alt = findFile(extractDir, "app.asar");
    throw new Error(`Windows: resources dir not found${alt ? `, app.asar at ${alt}` : ""}`);
  }

  assembleOutput(resourcesDir, destDir, "Windows");
  return info;
}

// ─── Assemble output ────────────────────────────────────────────

function assembleOutput(resourcesDir, destDir, label) {
  const asarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarPath)) throw new Error(`${label}: app.asar not found`);

  console.log(`   [assemble] -> ${path.relative(PROJECT_ROOT, destDir)}/`);
  clearDir(destDir);

  // 1. Extract app.asar → _asar/ (for patching)
  const asarDest = path.join(destDir, "_asar");
  console.log("   [asar extract] -> _asar/");
  execSync(`npx asar extract "${asarPath}" "${asarDest}"`);

  // 2. Copy app.asar.unpacked/ as-is (native modules)
  const unpackedSrc = path.join(resourcesDir, "app.asar.unpacked");
  if (fs.existsSync(unpackedSrc)) {
    const n = copyRecursive(unpackedSrc, path.join(destDir, "app.asar.unpacked"));
    console.log(`   [copy] app.asar.unpacked/ (${n} files)`);
  }

  // 3. Copy all other resources (binaries, plugins, native, etc.)
  let extraCount = 0;
  for (const e of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (e.name === "app.asar" || e.name === "app.asar.unpacked") continue;
    if (e.name.endsWith(".lproj")) continue;
    const s = path.join(resourcesDir, e.name);
    const d = path.join(destDir, e.name);
    if (e.isDirectory()) { extraCount += copyRecursive(s, d); }
    else if (!e.isSymbolicLink()) { fs.copyFileSync(s, d); extraCount++; }
  }
  console.log(`   [copy] ${extraCount} extra resource files`);

  const total = countFiles(destDir);
  console.log(`   [ok] ${total} files total`);
}

function findResourcesDir(extractDir) {
  const appDir = findFile(extractDir, "app.asar");
  return appDir ? path.dirname(appDir) : null;
}

// ─── Version state ──────────────────────────────────────────────

function loadVersions() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, "utf-8")); } catch { return {}; }
}
function saveVersions(v) {
  fs.writeFileSync(VERSION_FILE, JSON.stringify(v, null, 2) + "\n");
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log("== Codex upstream sync ==\n");
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const targets = selectedTargets();
  const results = {};
  const pinned = targets.has("mac-x64") ? loadPinnedInputs() : null;

  // Detect versions
  if (targets.has("mac-arm64")) {
    try {
      const arm64Info = await getAppcastVersion(APPCAST_ARM64);
      console.log(`\n   mac-arm64: ${arm64Info.version} (build ${arm64Info.build})`);
      results["mac-arm64"] = arm64Info;
    } catch (e) { throw new Error(`mac-arm64 check: ${e.message}`); }
  }

  if (targets.has("mac-x64")) {
    try {
      const x64Info = pinned.macX64;
      console.log(`${targets.has("mac-arm64") ? "" : "\n"}   mac-x64:   ${x64Info.version} (build ${x64Info.build}, pinned)`);
      results["mac-x64"] = x64Info;
    } catch (e) { throw new Error(`mac-x64 check: ${e.message}`); }
  }

  if (targets.has("win")) {
    try {
      const winInfo = await getWindowsVersion();
      console.log(`   win:       ${winInfo.version}`);
      results.win = winInfo;
    } catch (e) { throw new Error(`win check: ${e.message}`); }
  }

  if (CHECK_ONLY) {
    console.log("\n== Check only, skipping download ==");
    return;
  }

  // Download and extract
  if (targets.has("mac-arm64") && results["mac-arm64"]) {
    try {
      results["mac-arm64"] = await syncMac("arm64", results["mac-arm64"], path.join(SRC_DIR, "mac-arm64"));
    } catch (e) { throw new Error(`mac-arm64 sync: ${e.message}`); }
  }
  if (targets.has("mac-x64") && results["mac-x64"]) {
    try {
      results["mac-x64"] = await syncMac("x64", results["mac-x64"], path.join(SRC_DIR, "mac-x64"));
    } catch (e) { throw new Error(`mac-x64 sync: ${e.message}`); }
  }
  if (targets.has("win") && results.win) {
    try {
      results.win = await syncWin(path.join(SRC_DIR, "win"));
    } catch (e) { throw new Error(`win sync: ${e.message}`); }
  }

  const saved = loadVersions();
  for (const [key, info] of Object.entries(results)) {
    saved[key] = { version: info.version, build: info.build || "", checkedAt: new Date().toISOString() };
  }
  saveVersions(saved);

  console.log("\n== Done ==");
  for (const [key, info] of Object.entries(results)) {
    console.log(`   ${key}: ${info.version}`);
  }
}

main().catch((e) => { console.error(`\n[x] ${e.message}`); process.exit(1); });
