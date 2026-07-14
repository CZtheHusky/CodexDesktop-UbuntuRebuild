#!/usr/bin/env node
/**
 * Archive successful Linux package outputs and retain the latest versions.
 *
 * The active build output remains in out/. This script copies out/make into an
 * ignored history directory so recent packages survive the next build cleanup.
 */
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const OUT_MAKE = path.join(PROJECT_ROOT, "out", "make");
const HISTORY_ROOT = path.join(PROJECT_ROOT, "build-history", "codex-desktop");
const MAX_VERSION_HISTORY = 3;
const VALID_PLATFORMS = new Set(["linux-x64", "linux-arm64"]);

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function fail(message) {
  console.error(`[x] ${message}`);
  process.exit(1);
}

function rel(file) {
  return path.relative(PROJECT_ROOT, file);
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._+-]/g, "_");
}

function readPackageInfo() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  if (!pkg.version) fail("package.json is missing version");
  return {
    version: String(pkg.version),
    buildNumber: pkg.codexBuildNumber == null ? "" : String(pkg.codexBuildNumber),
  };
}

function walkFiles(root) {
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }

  if (fs.existsSync(root)) walk(root);
  return files;
}

function readJsonIfPresent(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function versionUpdatedAt(dir) {
  const manifest = readJsonIfPresent(path.join(dir, "manifest.json"), null);
  const timestamp = manifest?.updatedAt ?? manifest?.archivedAt;
  const parsed = timestamp == null ? NaN : Date.parse(timestamp);
  if (Number.isFinite(parsed)) return parsed;
  return fs.statSync(dir).mtimeMs;
}

function pruneOldVersions(currentVersionDir) {
  const entries = fs
    .readdirSync(HISTORY_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(HISTORY_ROOT, entry.name))
    .sort((a, b) => versionUpdatedAt(b) - versionUpdatedAt(a));

  const keep = new Set(entries.slice(0, MAX_VERSION_HISTORY));
  keep.add(currentVersionDir);

  for (const dir of entries) {
    if (keep.has(dir)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`   [prune] removed ${rel(dir)}/`);
  }
}

function main() {
  const platform = argValue("--platform", null);
  if (!VALID_PLATFORMS.has(platform)) {
    fail(`Usage: archive-build-history.js --platform <${[...VALID_PLATFORMS].join("|")}>`);
  }

  if (!fs.existsSync(OUT_MAKE)) fail("Missing out/make; run a successful package build first");
  const sourceFiles = walkFiles(OUT_MAKE);
  if (sourceFiles.length === 0) fail("out/make contains no files to archive");

  const { version, buildNumber } = readPackageInfo();
  const versionName = safeSegment(buildNumber ? `${version}+${buildNumber}` : version);
  const versionDir = path.join(HISTORY_ROOT, versionName);
  const platformDir = path.join(versionDir, platform);
  const tmpDir = `${platformDir}.tmp-${process.pid}`;
  const archivedAt = new Date().toISOString();

  fs.mkdirSync(HISTORY_ROOT, { recursive: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  fs.cpSync(OUT_MAKE, path.join(tmpDir, "make"), { recursive: true });

  const copiedFiles = walkFiles(tmpDir).map((file) => {
    const stat = fs.statSync(file);
    return {
      path: path.relative(tmpDir, file),
      size: stat.size,
    };
  });

  fs.rmSync(platformDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, platformDir);

  const manifestPath = path.join(versionDir, "manifest.json");
  const manifest = readJsonIfPresent(manifestPath, {
    version,
    buildNumber,
    platforms: {},
  });

  manifest.version = version;
  manifest.buildNumber = buildNumber;
  manifest.updatedAt = archivedAt;
  manifest.platforms ??= {};
  manifest.platforms[platform] = {
    archivedAt,
    source: "out/make",
    files: copiedFiles,
  };

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  pruneOldVersions(versionDir);

  console.log(`-- archive-build-history: ${rel(versionDir)}/ (${platform}, ${copiedFiles.length} files)`);
}

main();
