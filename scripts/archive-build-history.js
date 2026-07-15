#!/usr/bin/env node
/** Archive candidate or accepted Linux package outputs with bounded retention. */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const OUT_MAKE = path.join(PROJECT_ROOT, "out", "make");
const ACCEPTED_ROOT = path.join(PROJECT_ROOT, "build-history", "codex-desktop");
const CANDIDATE_ROOT = path.join(PROJECT_ROOT, "build-history", "candidates", "codex-desktop");
const MAX_ACCEPTED_HISTORY = 3;
const MAX_CANDIDATE_HISTORY = 1;
const VALID_CHANNELS = new Set(["accepted", "candidate"]);
const VALID_PLATFORMS = new Set(["linux-x64", "linux-arm64"]);

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function fail(message) {
  throw new Error(message);
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
    buildNumber: pkg.codexBuildNumber == null ? "" : String(pkg.codexBuildNumber),
    cliVersion: pkg.codexCliVersion == null ? "" : String(pkg.codexCliVersion),
    version: String(pkg.version),
  };
}

function currentVersionName() {
  const { version, buildNumber } = readPackageInfo();
  return safeSegment(buildNumber ? `${version}+${buildNumber}` : version);
}

function historyRootFor(channel) {
  if (!VALID_CHANNELS.has(channel)) fail(`Unsupported history channel ${channel}`);
  return channel === "accepted" ? ACCEPTED_ROOT : CANDIDATE_ROOT;
}

function gitValue(args) {
  try {
    const value = execFileSync("git", args, {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!value) fail(`git ${args.join(" ")} returned no value`);
    return value;
  } catch (error) {
    fail(`git ${args.join(" ")} failed: ${error.message}`);
  }
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

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
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
  const parsed = Date.parse(manifest?.updatedAt ?? manifest?.archivedAt ?? "");
  return Number.isFinite(parsed) ? parsed : fs.statSync(dir).mtimeMs;
}

function pruneHistory(root, limit, currentVersionDir) {
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort((a, b) => versionUpdatedAt(b) - versionUpdatedAt(a));
  const keep = new Set(entries.slice(0, limit));
  keep.add(currentVersionDir);
  for (const dir of entries) {
    if (keep.has(dir)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`   [prune] removed ${rel(dir)}/`);
  }
}

function copyReport(reportDir, versionDir, runId) {
  if (!reportDir) return null;
  const source = path.resolve(reportDir);
  if (!fs.existsSync(path.join(source, "report.json"))) {
    fail(`Acceptance report is missing report.json: ${source}`);
  }
  const acceptanceRoot = path.join(versionDir, "acceptance");
  const destination = path.join(acceptanceRoot, safeSegment(runId));
  const temp = `${destination}.tmp-${process.pid}`;
  fs.mkdirSync(acceptanceRoot, { recursive: true });
  fs.rmSync(temp, { recursive: true, force: true });
  const rollbackRoot = path.join(source, "rollback");
  fs.cpSync(source, temp, {
    recursive: true,
    filter: (file) => file !== rollbackRoot && !file.startsWith(`${rollbackRoot}${path.sep}`),
  });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(temp, destination);
  return path.relative(versionDir, path.join(destination, "report.json"));
}

function removePromotedCandidate(versionName, platform) {
  const versionDir = path.join(CANDIDATE_ROOT, versionName);
  if (!fs.existsSync(versionDir)) return;
  fs.rmSync(path.join(versionDir, platform), { recursive: true, force: true });
  const manifestPath = path.join(versionDir, "manifest.json");
  const manifest = readJsonIfPresent(manifestPath, null);
  if (manifest?.platforms) delete manifest.platforms[platform];
  const remaining = fs
    .readdirSync(versionDir, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && VALID_PLATFORMS.has(entry.name));
  if (!remaining) fs.rmSync(versionDir, { recursive: true, force: true });
  else fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function archive(options) {
  const { channel, platform, reportDir = null, runId = null } = options;
  if (!VALID_PLATFORMS.has(platform)) fail(`Unsupported --platform ${platform}`);
  const root = historyRootFor(channel);
  if (!fs.existsSync(OUT_MAKE)) fail("Missing out/make; run a successful package build first");
  const sourceFiles = walkFiles(OUT_MAKE);
  if (sourceFiles.length === 0) fail("out/make contains no files to archive");

  const packageInfo = readPackageInfo();
  const versionName = currentVersionName();
  const versionDir = path.join(root, versionName);
  const stagedVersionDir = channel === "accepted" ? `${versionDir}.tmp-${process.pid}` : versionDir;
  if (channel === "accepted") {
    fs.rmSync(stagedVersionDir, { recursive: true, force: true });
    if (fs.existsSync(versionDir)) fs.cpSync(versionDir, stagedVersionDir, { recursive: true });
    else fs.mkdirSync(stagedVersionDir, { recursive: true });
  }
  const platformDir = path.join(stagedVersionDir, platform);
  const tempDir = `${platformDir}.tmp-${process.pid}`;
  const archivedAt = new Date().toISOString();

  fs.mkdirSync(root, { recursive: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  fs.cpSync(OUT_MAKE, path.join(tempDir, "make"), { recursive: true });

  const copiedFiles = walkFiles(tempDir).map((file) => ({
    path: path.relative(tempDir, file),
    sha256: sha256File(file),
    size: fs.statSync(file).size,
  }));
  fs.rmSync(platformDir, { recursive: true, force: true });
  fs.renameSync(tempDir, platformDir);

  const manifestPath = path.join(stagedVersionDir, "manifest.json");
  const manifest = readJsonIfPresent(manifestPath, {
    buildNumber: packageInfo.buildNumber,
    cliVersion: packageInfo.cliVersion,
    platforms: {},
    version: packageInfo.version,
  });
  manifest.version = packageInfo.version;
  manifest.buildNumber = packageInfo.buildNumber;
  manifest.cliVersion = packageInfo.cliVersion;
  manifest.channel = channel;
  manifest.status = channel;
  manifest.updatedAt = archivedAt;
  manifest.git = {
    branch: gitValue(["branch", "--show-current"]),
    commit: gitValue(["rev-parse", "HEAD"]),
  };
  manifest.platforms ??= {};
  manifest.platforms[platform] = { archivedAt, files: copiedFiles, source: "out/make" };

  if (channel === "accepted") {
    if (!reportDir || !runId) fail("Accepted history requires --report-dir and --run-id");
    const report = copyReport(reportDir, stagedVersionDir, runId);
    manifest.acceptance = { acceptedAt: archivedAt, report, runId };
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (channel === "accepted") {
    const backupDir = `${versionDir}.backup-${process.pid}`;
    fs.rmSync(backupDir, { recursive: true, force: true });
    try {
      if (fs.existsSync(versionDir)) fs.renameSync(versionDir, backupDir);
      fs.renameSync(stagedVersionDir, versionDir);
      execFileSync(process.execPath, [
        path.join(__dirname, "verify-build-history.js"),
        "--channel", "accepted",
        "--platform", platform,
        "--skip-retention",
      ], { cwd: PROJECT_ROOT, stdio: "inherit" });
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (error) {
      fs.rmSync(versionDir, { recursive: true, force: true });
      fs.rmSync(stagedVersionDir, { recursive: true, force: true });
      if (fs.existsSync(backupDir)) fs.renameSync(backupDir, versionDir);
      throw error;
    }
  }

  pruneHistory(
    root,
    channel === "accepted" ? MAX_ACCEPTED_HISTORY : MAX_CANDIDATE_HISTORY,
    versionDir,
  );
  if (channel === "accepted") removePromotedCandidate(versionName, platform);
  console.log(`-- archive-build-history: ${channel} ${rel(versionDir)}/ (${platform}, ${copiedFiles.length} files)`);
  return {
    manifestPath: path.join(versionDir, "manifest.json"),
    platformDir: path.join(versionDir, platform),
    versionDir,
  };
}

function main() {
  const platform = argValue("--platform", null);
  const channel = argValue("--channel", "candidate");
  archive({
    channel,
    platform,
    reportDir: argValue("--report-dir", null),
    runId: argValue("--run-id", null),
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[x] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  ACCEPTED_ROOT,
  CANDIDATE_ROOT,
  archive,
  currentVersionName,
  historyRootFor,
  safeSegment,
  sha256File,
};
