#!/usr/bin/env node
/** Mandatory build, install, authenticated UI acceptance, and rollback runner. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { ACCEPTED_ROOT, CANDIDATE_ROOT, sha256File } = require("./archive-build-history");
const { redactLog, writeJson } = require("./smoke-linux-desktop");

const PROJECT_ROOT = path.join(__dirname, "..");
const REPORTS_ROOT = path.join(PROJECT_ROOT, "build-history", "acceptance-runs");
const VALID_PLATFORMS = new Set(["linux-x64", "linux-arm64"]);

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function fail(message) {
  throw new Error(message);
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._+-]/g, "_");
}

function commandOutput(command, args, fallback = null) {
  try {
    return execFileSync(command, args, { cwd: PROJECT_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return fallback;
  }
}

function commandSucceeds(command, args) {
  try {
    execFileSync(command, args, { cwd: PROJECT_ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readPackageInfo() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  return {
    buildNumber: String(pkg.codexBuildNumber || ""),
    cliVersion: String(pkg.codexCliVersion || ""),
    version: String(pkg.version),
  };
}

function gitIdentity() {
  return {
    branch: commandOutput("git", ["branch", "--show-current"], "unknown"),
    commit: commandOutput("git", ["rev-parse", "HEAD"], "unknown"),
    dirty: Boolean(commandOutput("git", ["status", "--porcelain", "--untracked-files=no"], "unknown")),
  };
}

function installedVersion() {
  return commandOutput("dpkg-query", ["-W", "-f=${Version}", "codex-desktop"], null);
}

function walkFiles(root, predicate) {
  const matches = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && predicate(file)) matches.push(file);
    }
  }
  if (fs.existsSync(root)) walk(root);
  return matches;
}

function debArchDir(platform) {
  return platform === "linux-arm64" ? "arm64" : "x64";
}

function candidateDebFor(platform) {
  const dir = path.join(PROJECT_ROOT, "out", "make", "deb", debArchDir(platform));
  const debs = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith(".deb")).map((name) => path.join(dir, name))
    : [];
  if (debs.length !== 1) fail(`Expected one candidate deb under ${dir}, found ${debs.length}`);
  return debs[0];
}

function findRollbackDeb(version, platform) {
  if (!version) return null;
  const candidates = walkFiles(ACCEPTED_ROOT, (file) => file.endsWith(".deb") && file.includes(`/${platform}/`));
  for (const deb of candidates) {
    const packageVersion = commandOutput("dpkg-deb", ["-f", deb, "Version"], null);
    if (packageVersion === version) return deb;
  }
  return null;
}

function codexIsRunning() {
  const output = commandOutput("pgrep", ["-x", "Codex"], "");
  return Boolean(output);
}

function profileSourcesExist() {
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return fs.existsSync(path.join(codexHome, "auth.json")) && fs.existsSync(path.join(configRoot, "Codex"));
}

function verifyInstalledPackage(expectedVersion) {
  const actual = installedVersion();
  if (actual !== expectedVersion) fail(`Installed version is ${actual || "missing"}; expected ${expectedVersion}`);
  const launcher = "/usr/bin/codex-desktop";
  const desktop = "/usr/share/applications/codex-desktop.desktop";
  if (!fs.existsSync(launcher)) fail(`Installed launcher is missing: ${launcher}`);
  if (!fs.existsSync(desktop)) fail(`Installed desktop entry is missing: ${desktop}`);
  const desktopText = fs.readFileSync(desktop, "utf8");
  if (!/^Exec=codex-desktop %U$/m.test(desktopText)) fail("Installed desktop entry has an unexpected Exec line");
  return { actual, desktop, launcher };
}

function pruneAcceptanceRuns(currentDir, limit = 10) {
  if (!fs.existsSync(REPORTS_ROOT)) return;
  const dirs = fs
    .readdirSync(REPORTS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(REPORTS_ROOT, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const keep = new Set(dirs.slice(0, limit));
  keep.add(currentDir);
  for (const dir of dirs) if (!keep.has(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function installCommand(deb) {
  const aptArgs = ["install", "-y", "--reinstall", deb];
  if (process.getuid?.() === 0) return { command: "apt", args: aptArgs };
  if (commandSucceeds("sudo", ["-n", "true"])) {
    return { command: "sudo", args: ["-n", "apt", ...aptArgs] };
  }
  if (process.env.DISPLAY && commandOutput("which", ["pkexec"], null)) {
    return { command: "pkexec", args: ["apt", ...aptArgs] };
  }
  return { command: "sudo", args: ["apt", ...aptArgs] };
}

function createAcceptanceReport(platform) {
  const pkg = readPackageInfo();
  const git = gitIdentity();
  const runId = [
    new Date().toISOString().replace(/[:.]/g, "-"),
    safeSegment(`${pkg.version}+${pkg.buildNumber}`),
    git.commit.slice(0, 8),
  ].join("-");
  const reportDir = path.join(REPORTS_ROOT, runId);
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  return {
    report: {
      app: pkg,
      finishedAt: null,
      git,
      host: { arch: os.arch(), platform: os.platform(), release: os.release() },
      install: { afterVersion: null, beforeVersion: installedVersion(), candidateSha256: null },
      platform,
      rollback: { attempted: false, succeeded: null },
      runId,
      schemaVersion: 1,
      stages: [],
      startedAt: new Date().toISOString(),
      status: "running",
    },
    reportDir,
  };
}

async function runAcceptance(options = {}) {
  const platform = options.platform || "linux-x64";
  if (!VALID_PLATFORMS.has(platform)) fail(`Unsupported platform ${platform}`);
  const { report, reportDir } = createAcceptanceReport(platform);
  const reportPath = path.join(reportDir, "report.json");
  const logPath = path.join(reportDir, "acceptance.log");
  let logText = "";
  let rollbackDeb = null;
  let installAttempted = false;
  let failure = null;

  function persist() {
    writeJson(reportPath, report);
    fs.writeFileSync(logPath, redactLog(logText), { mode: 0o600 });
  }

  async function runCommand(command, args, commandOptions = {}) {
    const label = [command, ...args].join(" ");
    logText += `\n$ ${label}\n`;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: commandOptions.cwd || PROJECT_ROOT,
        env: commandOptions.env || process.env,
        stdio: ["inherit", "pipe", "pipe"],
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk) => {
          const text = chunk.toString("utf8");
          logText += text;
          process.stdout.write(text);
        });
      }
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`${label} failed with code=${code} signal=${signal || "none"}`));
      });
    });
  }

  async function runStage(name, action) {
    const stage = { durationMs: null, name, startedAt: new Date().toISOString(), status: "running" };
    const started = Date.now();
    report.stages.push(stage);
    persist();
    try {
      await action();
      stage.status = "passed";
    } catch (error) {
      stage.status = "failed";
      stage.error = redactLog(error.message);
      throw error;
    } finally {
      stage.durationMs = Date.now() - started;
      persist();
    }
  }

  async function rollback() {
    report.rollback.attempted = true;
    try {
      if (!rollbackDeb) fail("Rollback package is unavailable");
      const command = installCommand(rollbackDeb);
      await runCommand(command.command, command.args);
      verifyInstalledPackage(report.install.beforeVersion);
      await runCommand("node", [
        "scripts/smoke-linux-desktop.js",
        "--mode", "safe",
        "--platform", platform,
        "--app", "/usr/bin/codex-desktop",
        "--report-dir", path.join(reportDir, "rollback-smoke"),
        "--run-id", report.runId,
      ]);
      report.rollback.succeeded = true;
    } catch (error) {
      report.rollback.succeeded = false;
      report.rollback.error = redactLog(error.message);
    }
  }

  try {
    await runStage("preflight", async () => {
      if (report.git.dirty) fail("Final acceptance requires a clean tracked worktree");
      if (os.platform() !== "linux") fail("Linux acceptance must run on Linux");
      const expectedArch = platform === "linux-arm64" ? "arm64" : "x64";
      if (os.arch() !== expectedArch) fail(`Host architecture ${os.arch()} cannot accept ${platform}`);
      if (!process.env.DISPLAY || process.env.XDG_SESSION_TYPE === "wayland") {
        fail("Installed UI acceptance requires an X11 DISPLAY");
      }
      if (!profileSourcesExist()) fail("Local Codex authentication profile is unavailable");
      if (codexIsRunning()) fail("Close every running Codex Desktop window before final acceptance");
      if (!report.install.beforeVersion) fail("codex-desktop is not currently installed");
      rollbackDeb = findRollbackDeb(report.install.beforeVersion, platform);
      if (!rollbackDeb) fail(`No accepted rollback deb found for installed version ${report.install.beforeVersion}`);
      const rollbackDir = path.join(reportDir, "rollback");
      fs.mkdirSync(rollbackDir, { recursive: true, mode: 0o700 });
      const rollbackSnapshot = path.join(rollbackDir, path.basename(rollbackDeb));
      fs.copyFileSync(rollbackDeb, rollbackSnapshot, fs.constants.COPYFILE_FICLONE);
      rollbackDeb = rollbackSnapshot;
      const canElevate =
        process.getuid?.() === 0 ||
        commandOutput("which", ["sudo"], null) ||
        (process.env.DISPLAY && commandOutput("which", ["pkexec"], null));
      if (!canElevate) fail("sudo or pkexec is required for package installation");
      report.install.rollbackDebSha256 = sha256File(rollbackDeb);
    });

    await runStage("unit-tests", () => runCommand("npm", ["test"]));
    await runStage("candidate-build", () => runCommand("npm", ["run", "build"]));
    const candidateDeb = candidateDebFor(platform);
    report.install.candidateSha256 = sha256File(candidateDeb);
    await runStage("generated-syntax", () => runCommand("npm", ["run", "verify:linux:syntax"]));
    await runStage("candidate-history", () => runCommand("node", [
      "scripts/verify-build-history.js", "--channel", "candidate", "--platform", platform,
    ]));
    await runStage("candidate-empty-profile", () => runCommand("node", [
      "scripts/smoke-linux-desktop.js",
      "--mode", "safe",
      "--platform", platform,
      "--report-dir", path.join(reportDir, "candidate-smoke"),
      "--run-id", report.runId,
    ]));
    await runStage("install-candidate", async () => {
      const command = installCommand(candidateDeb);
      installAttempted = true;
      await runCommand(command.command, command.args);
      report.install.afterVersion = verifyInstalledPackage(report.app.version).actual;
    });
    await runStage("installed-core-ui", () => runCommand("node", [
      "scripts/smoke-linux-desktop.js",
      "--mode", "core",
      "--platform", platform,
      "--app", "/usr/bin/codex-desktop",
      "--timeout-ms", "900000",
      "--report-dir", path.join(reportDir, "installed-core"),
      "--run-id", report.runId,
    ]));

    report.status = "passed";
    report.finishedAt = new Date().toISOString();
    persist();
    await runCommand("node", [
      "scripts/archive-build-history.js",
      "--channel", "accepted",
      "--platform", platform,
      "--report-dir", reportDir,
      "--run-id", report.runId,
    ]);
    await runCommand("node", [
      "scripts/verify-build-history.js", "--channel", "accepted", "--platform", platform,
    ]);
    report.status = "passed";
  } catch (error) {
    failure = error;
    report.status = "failed";
    report.error = redactLog(error.message);
    if (installAttempted) await rollback();
  } finally {
    report.finishedAt = new Date().toISOString();
    persist();
    pruneAcceptanceRuns(reportDir);
  }

  if (failure) throw failure;
  console.log(`\n[ok] accepted ${report.app.version} (${report.runId})`);
  return { report, reportDir };
}

async function main() {
  await runAcceptance({ platform: argValue("--platform", "linux-x64") });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n[x] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  CANDIDATE_ROOT,
  candidateDebFor,
  createAcceptanceReport,
  findRollbackDeb,
  installedVersion,
  runAcceptance,
  safeSegment,
  verifyInstalledPackage,
};
