#!/usr/bin/env node
/**
 * Verify the local build-history contract after a successful Linux build.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
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

function ok(message) {
  console.log(`  [ok] ${message}`);
}

function rel(file) {
  return path.relative(PROJECT_ROOT, file);
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._+-]/g, "_");
}

function archDirFor(platform) {
  return platform === "linux-arm64" ? "arm64" : "x64";
}

function readPackageInfo() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  if (!pkg.version) fail("package.json is missing version");
  return {
    version: String(pkg.version),
    buildNumber: pkg.codexBuildNumber == null ? "" : String(pkg.codexBuildNumber),
  };
}

function currentVersionName() {
  const { version, buildNumber } = readPackageInfo();
  return safeSegment(buildNumber ? `${version}+${buildNumber}` : version);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`Could not read JSON ${rel(file)}: ${error.message}`);
  }
}

function listVersionDirs() {
  if (!fs.existsSync(HISTORY_ROOT)) return [];
  return fs
    .readdirSync(HISTORY_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(HISTORY_ROOT, entry.name))
    .sort();
}

function assertIgnored() {
  try {
    execFileSync("git", ["check-ignore", "-q", "build-history/"], { cwd: PROJECT_ROOT, stdio: "ignore" });
  } catch {
    fail("build-history/ is not ignored by git");
  }
  ok("build-history/ is ignored by git");
}

function findDeb(platformDir, platform) {
  const debDir = path.join(platformDir, "make", "deb", archDirFor(platform));
  if (!fs.existsSync(debDir)) fail(`Missing deb history dir: ${rel(debDir)}`);
  return fs.readdirSync(debDir).filter((name) => name.endsWith(".deb"));
}

function verify(platform) {
  console.log(`-- verify-build-history: ${platform}`);
  if (!VALID_PLATFORMS.has(platform)) fail(`Unsupported --platform ${platform}`);

  assertIgnored();

  const versionDirs = listVersionDirs();
  if (versionDirs.length === 0) fail("build-history/codex-desktop contains no archived versions");
  if (versionDirs.length > MAX_VERSION_HISTORY) {
    fail(`build history keeps ${versionDirs.length} versions; expected at most ${MAX_VERSION_HISTORY}`);
  }
  ok(`build history keeps ${versionDirs.length} version(s)`);

  const versionDir = path.join(HISTORY_ROOT, currentVersionName());
  if (!fs.existsSync(versionDir)) fail(`Missing current version history dir: ${rel(versionDir)}`);

  const manifestPath = path.join(versionDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) fail(`Missing history manifest: ${rel(manifestPath)}`);
  const manifest = readJson(manifestPath);
  if (manifest.version !== readPackageInfo().version) fail("history manifest version does not match package.json");
  if (!manifest.platforms || !manifest.platforms[platform]) fail(`history manifest is missing platform ${platform}`);
  if (!Array.isArray(manifest.platforms[platform].files) || manifest.platforms[platform].files.length === 0) {
    fail(`history manifest has no archived files for ${platform}`);
  }

  const platformDir = path.join(versionDir, platform);
  if (!fs.existsSync(platformDir)) fail(`Missing platform history dir: ${rel(platformDir)}`);

  const debs = findDeb(platformDir, platform);
  if (debs.length === 0) fail(`No deb package archived under ${rel(platformDir)}`);
  ok(`archived ${debs.length} deb package(s) for current ${platform} build`);
}

function main() {
  verify(argValue("--platform", "linux-x64"));
}

if (require.main === module) main();

module.exports = {
  archDirFor,
  currentVersionName,
  listVersionDirs,
  safeSegment,
  verify,
};
