#!/usr/bin/env node
/** Verify candidate or accepted local build-history contracts. */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  ACCEPTED_ROOT,
  CANDIDATE_ROOT,
  currentVersionName,
  historyRootFor,
  safeSegment,
  sha256File,
} = require("./archive-build-history");

const PROJECT_ROOT = path.join(__dirname, "..");
const MAX_HISTORY = { accepted: 3, candidate: 1 };
const VALID_CHANNELS = new Set(["accepted", "candidate"]);
const VALID_PLATFORMS = new Set(["linux-x64", "linux-arm64"]);
const REQUIRED_ACCEPTANCE_STAGES = [
  "preflight",
  "unit-tests",
  "candidate-build",
  "generated-syntax",
  "candidate-history",
  "candidate-empty-profile",
  "install-candidate",
  "installed-core-ui",
];
const REQUIRED_CORE_STEPS = [
  "startup",
  "core-ui",
  "normal-chat",
  "attachments",
  "approvals",
  "terminal",
  "stop-cancel",
  "plan-flow",
  "conversation-restart",
];

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function fail(message) {
  throw new Error(message);
}

function ok(message) {
  console.log(`  [ok] ${message}`);
}

function rel(file) {
  return path.relative(PROJECT_ROOT, file);
}

function archDirFor(platform) {
  return platform === "linux-arm64" ? "arm64" : "x64";
}

function readPackageInfo() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  return {
    buildNumber: pkg.codexBuildNumber == null ? "" : String(pkg.codexBuildNumber),
    version: String(pkg.version),
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`Could not read JSON ${rel(file)}: ${error.message}`);
  }
}

function listVersionDirs(channel = "accepted") {
  const root = historyRootFor(channel);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function assertIgnored() {
  for (const target of ["build-history/", "build-history/candidates/"]) {
    try {
      execFileSync("git", ["check-ignore", "-q", target], { cwd: PROJECT_ROOT, stdio: "ignore" });
    } catch {
      fail(`${target} is not ignored by git`);
    }
  }
  ok("build history roots are ignored by git");
}

function findDeb(platformDir, platform) {
  const debDir = path.join(platformDir, "make", "deb", archDirFor(platform));
  if (!fs.existsSync(debDir)) fail(`Missing deb history dir: ${rel(debDir)}`);
  const debs = fs.readdirSync(debDir).filter((name) => name.endsWith(".deb"));
  if (debs.length !== 1) fail(`Expected one deb under ${rel(debDir)}, found ${debs.length}`);
  return path.join(debDir, debs[0]);
}

function assertRequiredPassed(entries, requiredNames, label) {
  if (!Array.isArray(entries)) fail(`${label} results are missing`);
  const skipped = entries.find((entry) => entry.status === "skipped");
  if (skipped) fail(`${label} contains skipped result ${skipped.name || "unknown"}`);
  const names = new Set();
  for (const entry of entries) {
    if (!entry?.name) fail(`${label} contains an unnamed result`);
    if (names.has(entry.name)) fail(`${label} contains duplicate result ${entry.name}`);
    names.add(entry.name);
  }
  for (const name of requiredNames) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) fail(`${label} is missing required result ${name}`);
    if (entry.status !== "passed") fail(`${label} result ${name} is ${entry.status || "missing status"}`);
  }
}

function verify(options) {
  const { channel = "accepted", platform = "linux-x64", skipRetention = false } = options;
  console.log(`-- verify-build-history: ${channel} ${platform}`);
  if (!VALID_CHANNELS.has(channel)) fail(`Unsupported --channel ${channel}`);
  if (!VALID_PLATFORMS.has(platform)) fail(`Unsupported --platform ${platform}`);
  assertIgnored();

  const versionDirs = listVersionDirs(channel);
  if (versionDirs.length === 0) fail(`${channel} build history contains no versions`);
  if (!skipRetention && versionDirs.length > MAX_HISTORY[channel]) {
    fail(`${channel} history keeps ${versionDirs.length} versions; expected at most ${MAX_HISTORY[channel]}`);
  }
  if (!skipRetention) ok(`${channel} history keeps ${versionDirs.length} version(s)`);

  const versionDir = path.join(historyRootFor(channel), currentVersionName());
  if (!fs.existsSync(versionDir)) fail(`Missing current ${channel} version: ${rel(versionDir)}`);
  const manifestPath = path.join(versionDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const packageInfo = readPackageInfo();
  if (manifest.version !== packageInfo.version || manifest.buildNumber !== packageInfo.buildNumber) {
    fail(`${channel} manifest version does not match package.json`);
  }
  if (manifest.channel !== channel || manifest.status !== channel) fail(`${channel} manifest status is invalid`);
  if (
    !manifest.git?.commit ||
    !manifest.git?.branch ||
    manifest.git.commit === "unknown" ||
    manifest.git.branch === "unknown"
  ) {
    fail(`${channel} manifest is missing Git identity`);
  }
  const platformEntry = manifest.platforms?.[platform];
  if (!platformEntry?.files?.length) fail(`${channel} manifest has no files for ${platform}`);

  const platformDir = path.join(versionDir, platform);
  const deb = findDeb(platformDir, platform);
  const manifestDeb = platformEntry.files.find((entry) => entry.path.endsWith(".deb"));
  if (!manifestDeb || manifestDeb.sha256 !== sha256File(deb)) fail(`${channel} deb SHA-256 does not match manifest`);

  if (channel === "accepted") {
    const reportPath = manifest.acceptance?.report && path.join(versionDir, manifest.acceptance.report);
    if (!reportPath || !fs.existsSync(reportPath)) fail("accepted history is missing its acceptance report");
    const report = readJson(reportPath);
    if (report.status !== "passed") fail("accepted history references a non-passing report");
    if (report.git?.commit !== manifest.git.commit) fail("accepted report commit does not match history manifest");
    if (
      report.app?.version !== manifest.version ||
      report.app?.buildNumber !== manifest.buildNumber ||
      report.app?.cliVersion !== manifest.cliVersion
    ) {
      fail("accepted report app identity does not match history manifest");
    }
    if (report.install?.candidateSha256 !== sha256File(deb)) {
      fail("accepted report candidate SHA-256 does not match archived deb");
    }
    if (report.install?.afterVersion !== manifest.version) {
      fail("accepted report does not confirm the installed candidate version");
    }
    assertRequiredPassed(report.stages, REQUIRED_ACCEPTANCE_STAGES, "acceptance stages");

    const coreReportPath = path.join(path.dirname(reportPath), "installed-core", "smoke-report.json");
    if (!fs.existsSync(coreReportPath)) fail("accepted history is missing the installed core UI report");
    const coreReport = readJson(coreReportPath);
    if (coreReport.status !== "passed") fail("installed core UI report did not pass");
    if (coreReport.appPath !== "/usr/bin/codex-desktop") {
      fail("installed core UI report did not exercise /usr/bin/codex-desktop");
    }
    assertRequiredPassed(coreReport.steps, REQUIRED_CORE_STEPS, "installed core UI scenarios");
  }
  ok(`${channel} ${platform} artifact and manifest are valid`);
  return { deb, manifest, versionDir };
}

function main() {
  verify({
    channel: argValue("--channel", "accepted"),
    platform: argValue("--platform", "linux-x64"),
    skipRetention: hasFlag("--skip-retention"),
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
  REQUIRED_ACCEPTANCE_STAGES,
  REQUIRED_CORE_STEPS,
  archDirFor,
  assertRequiredPassed,
  currentVersionName,
  findDeb,
  listVersionDirs,
  safeSegment,
  verify,
};
