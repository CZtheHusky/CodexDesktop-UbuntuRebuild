#!/usr/bin/env node
/** Mandatory host build and VM-isolated installed GUI acceptance runner. */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { ACCEPTED_ROOT, sha256File } = require("./archive-build-history");
const { createAuthSnapshot, sensitiveStringsFromAuth } = require("./acceptance-profile");
const {
  BASELINE_SCHEMA_VERSION,
  CLOUD_IMAGE_SHA256,
  HOST_PROXY_PORT,
  assertBaselineCurrent,
  discardVm,
  pullDirectoryFromGuest,
  pushFileToGuest,
  resetVm,
  sshArgs,
  streamDirectoryToGuest,
  takeScreenshot,
} = require("./gui-vm");
const { redactLog } = require("./smoke-linux-desktop");

const PROJECT_ROOT = path.join(__dirname, "..");
const REPORTS_ROOT = path.join(PROJECT_ROOT, "build-history", "acceptance-runs");
const GUEST_DISK_ROOT = "/home/codex-test/codex-acceptance";
const GUEST_AUTH_ROOT = "/run/user/1000/ca";
const GUEST_TMP_ROOT = "/tmp/ca";
const PACKAGE_IDENTITY_PATHS = [
  "usr/lib/codex-desktop/Codex",
  "usr/lib/codex-desktop/resources/app.asar",
  "usr/lib/codex-desktop/resources/codex",
];
const REQUIRED_PLATFORM = "linux-x64";
const INFRASTRUCTURE_STAGES = new Set([
  "preflight",
  "vm-reset",
  "auth-snapshot",
  "vm-stage",
  "guest-preflight",
  "accepted-baseline",
  "vm-evidence",
  "evidence-redaction",
  "vm-cleanup",
]);

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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function commandOutput(command, args, fallback = null) {
  try {
    return execFileSync(command, args, {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return fallback;
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
    dirty: Boolean(commandOutput("git", ["status", "--porcelain"], "unknown")),
  };
}

function installedVersion() {
  return commandOutput("dpkg-query", ["-W", "-f=${Version}", "codex-desktop"], null);
}

function hostInstallIdentity() {
  const executable = "/usr/lib/codex-desktop/Codex";
  return {
    executableSha256: fs.existsSync(executable) ? sha256File(executable) : null,
    version: installedVersion(),
  };
}

function walkFiles(root, predicate = () => true) {
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

function candidateDebFor(platform) {
  if (platform !== REQUIRED_PLATFORM) fail(`VM acceptance supports only ${REQUIRED_PLATFORM}; received ${platform}`);
  const dir = path.join(PROJECT_ROOT, "out", "make", "deb", "x64");
  const debs = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith(".deb")).map((name) => path.join(dir, name))
    : [];
  if (debs.length !== 1) fail(`Expected one candidate deb under ${dir}, found ${debs.length}`);
  return debs[0];
}

function debVersion(deb) {
  return commandOutput("dpkg-deb", ["-f", deb, "Version"], null);
}

function findRollbackDeb(candidateOrVersion, platform = REQUIRED_PLATFORM) {
  if (platform !== REQUIRED_PLATFORM) return null;
  const candidateVersion = fs.existsSync(candidateOrVersion) ? debVersion(candidateOrVersion) : candidateOrVersion;
  const candidates = walkFiles(ACCEPTED_ROOT, (file) => file.endsWith(".deb") && file.includes(`/${platform}/`))
    .map((file) => {
      const versionDir = file.slice(0, file.indexOf(`/${platform}/`));
      const manifest = path.join(versionDir, "manifest.json");
      let updatedAt = fs.statSync(file).mtimeMs;
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
        const timestamp = Date.parse(parsed.updatedAt || "");
        if (Number.isFinite(timestamp)) updatedAt = timestamp;
      } catch {}
      return { file, updatedAt, version: debVersion(file) };
    })
    .filter((entry) => entry.version)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates.find((entry) => entry.version === candidateVersion)?.file || candidates[0]?.file || null;
}

function codexIsRunning() {
  return Boolean(commandOutput("pgrep", ["-x", "Codex"], ""));
}

function profileSourcesExist() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return fs.existsSync(path.join(codexHome, "auth.json"));
}

function guestPaths(runId) {
  const safeRunId = safeSegment(runId);
  const tempRunId = crypto.createHash("sha256").update(runId).digest("hex").slice(0, 12);
  const disk = `${GUEST_DISK_ROOT}/${safeRunId}`;
  const auth = `${GUEST_AUTH_ROOT}/${tempRunId}`;
  const temp = `${GUEST_TMP_ROOT}/${tempRunId}`;
  return {
    auth,
    authCodex: `${auth}/source/.codex`,
    authUserData: `${auth}/source/.config/Codex`,
    candidateDeb: `${disk}/candidate.deb`,
    candidateExtracted: `${disk}/candidate-extracted`,
    disk,
    reports: `${disk}/reports`,
    rollbackDeb: `${disk}/rollback.deb`,
    rollbackExtracted: `${disk}/rollback-extracted`,
    scripts: `${disk}/scripts`,
    temp,
    tempWork: `${temp}/work`,
  };
}

function failureClassForStage(stage) {
  return INFRASTRUCTURE_STAGES.has(stage) ? "infrastructure" : "product";
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function markStaleReportsInterrupted() {
  if (!fs.existsSync(REPORTS_ROOT)) return;
  for (const reportPath of walkFiles(REPORTS_ROOT, (file) => path.basename(file) === "report.json")) {
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      if (report.status !== "running" || processExists(report.hostPid)) continue;
      report.status = "failed";
      report.failureClass = "interrupted";
      report.error = report.error || "Acceptance process ended before finalization";
      report.finishedAt = report.finishedAt || new Date().toISOString();
      writeJsonAtomic(reportPath, report);
    } catch {}
  }
}

function createAcceptanceReport(platform) {
  markStaleReportsInterrupted();
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
      execution: {
        cloudImageSha256: CLOUD_IMAGE_SHA256,
        kind: "kvm-vm",
        vmSchemaVersion: BASELINE_SCHEMA_VERSION,
      },
      failureClass: null,
      finishedAt: null,
      git,
      host: {
        arch: os.arch(),
        installBefore: hostInstallIdentity(),
        platform: os.platform(),
        release: os.release(),
      },
      hostPid: process.pid,
      install: {
        afterVersion: null,
        beforeVersion: null,
        candidateSha256: null,
        rollbackSha256: null,
      },
      platform,
      rollback: { attempted: false, succeeded: null },
      runId,
      schemaVersion: 2,
      stages: [],
      startedAt: new Date().toISOString(),
      status: "running",
    },
    reportDir,
  };
}

function pruneAcceptanceRuns(currentDir, limit = 10) {
  if (!fs.existsSync(REPORTS_ROOT)) return;
  const dirs = fs.readdirSync(REPORTS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(REPORTS_ROOT, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const keep = new Set(dirs.slice(0, limit));
  keep.add(currentDir);
  for (const dir of dirs) if (!keep.has(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function parseSha256Lines(output) {
  const hashes = {};
  for (const line of String(output).trim().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (match) hashes[match[2].replace(/^\*?\/?/, "")] = match[1].toLowerCase();
  }
  return hashes;
}

function textEvidenceFiles(root) {
  return walkFiles(root, (file) => {
    const extension = path.extname(file).toLowerCase();
    return ![".deb", ".png", ".ppm", ".jpg", ".jpeg", ".webp", ".qcow2"].includes(extension)
      && fs.statSync(file).size <= 10 * 1024 * 1024;
  });
}

function assertEvidenceContainsNoSecrets(root, sensitiveStrings) {
  for (const file of textEvidenceFiles(root)) {
    const content = fs.readFileSync(file);
    for (const secret of sensitiveStrings) {
      if (secret && content.includes(Buffer.from(secret))) fail(`Sensitive authentication data leaked into evidence: ${file}`);
    }
  }
}

async function runAcceptance(options = {}) {
  const platform = options.platform || REQUIRED_PLATFORM;
  if (platform !== REQUIRED_PLATFORM) fail(`Strict VM acceptance currently supports only ${REQUIRED_PLATFORM}`);
  const vm = options.vm || {
    assertBaselineCurrent,
    discardVm,
    pullDirectoryFromGuest,
    pushFileToGuest,
    resetVm,
    sshArgs,
    streamDirectoryToGuest,
    takeScreenshot,
  };
  const { report, reportDir } = createAcceptanceReport(platform);
  const reportPath = path.join(reportDir, "report.json");
  const logPath = path.join(reportDir, "acceptance.log");
  const paths = guestPaths(report.runId);
  let activeChild = null;
  let authSnapshot = null;
  let sensitiveStrings = [];
  let logText = "";
  let candidateDeb = null;
  let candidateVersion = null;
  let rollbackDeb = null;
  let installAttempted = false;
  let failure = null;
  let currentStage = null;
  let interruptedSignal = null;
  let evidenceCollected = false;
  let cleanupCompleted = false;

  function persist() {
    writeJsonAtomic(reportPath, report);
    fs.writeFileSync(logPath, redactLog(logText), { mode: 0o600 });
  }

  function onSignal(signal) {
    interruptedSignal = signal;
    if (activeChild?.pid) {
      try { process.kill(-activeChild.pid, "SIGTERM"); } catch {}
    }
  }
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  async function runCommand(command, args, commandOptions = {}) {
    if (interruptedSignal) fail(`Acceptance interrupted by ${interruptedSignal}`);
    const label = commandOptions.label || [command, ...args].join(" ");
    logText += `\n$ ${label}\n`;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: commandOptions.cwd || PROJECT_ROOT,
        detached: true,
        env: commandOptions.env || process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeChild = child;
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk) => {
          const text = chunk.toString("utf8");
          output += text;
          logText += text;
          process.stdout.write(text);
        });
      }
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (activeChild === child) activeChild = null;
        if (code === 0 && !interruptedSignal) resolve(output);
        else reject(new Error(`${label} failed with code=${code} signal=${signal || interruptedSignal || "none"}`));
      });
    });
  }

  async function runGuest(command, label) {
    return runCommand("ssh", vm.sshArgs(command), { label: label || `guest: ${command}` });
  }

  async function runStage(name, action) {
    currentStage = name;
    const stage = { durationMs: null, name, startedAt: new Date().toISOString(), status: "running" };
    const started = Date.now();
    report.stages.push(stage);
    persist();
    try {
      await action();
      if (interruptedSignal) fail(`Acceptance interrupted by ${interruptedSignal}`);
      stage.status = "passed";
    } catch (error) {
      stage.status = "failed";
      stage.error = redactLog(error.message);
      stage.failureClass = interruptedSignal ? "interrupted" : failureClassForStage(name);
      throw error;
    } finally {
      stage.durationMs = Date.now() - started;
      persist();
    }
  }

  function assertHostInstallUnchanged() {
    const after = hostInstallIdentity();
    report.host.installAfter = after;
    if (JSON.stringify(after) !== JSON.stringify(report.host.installBefore)) {
      fail("Host Codex installation changed during VM acceptance");
    }
  }

  function guestEnvironment() {
    return [
      "DISPLAY=:0",
      "XAUTHORITY=/run/user/1000/gdm/Xauthority",
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      "XDG_RUNTIME_DIR=/run/user/1000",
      `TMPDIR=${paths.tempWork}`,
      `HTTP_PROXY=http://127.0.0.1:${HOST_PROXY_PORT}`,
      `HTTPS_PROXY=http://127.0.0.1:${HOST_PROXY_PORT}`,
      `ALL_PROXY=http://127.0.0.1:${HOST_PROXY_PORT}`,
      "NO_PROXY=127.0.0.1,localhost",
      "NODE_USE_ENV_PROXY=1",
    ].join(" ");
  }

  async function runGuestSmoke(mode, app, reportName, timeoutMs) {
    const reportTarget = `${paths.reports}/${reportName}`;
    const args = [
      app, `${paths.scripts}/smoke-linux-desktop.js`,
      "--mode", mode,
      "--platform", platform,
      "--app", app,
      "--timeout-ms", String(timeoutMs),
      "--report-dir", reportTarget,
      "--run-id", report.runId,
      "--source-codex-home", paths.authCodex,
      "--source-user-data", paths.authUserData,
      "--temp-root", paths.tempWork,
    ].map(shellQuote).join(" ");
    await runGuest(`${guestEnvironment()} ELECTRON_RUN_AS_NODE=1 ${args}`, `guest smoke: ${mode} (${reportName})`);
  }

  async function guestPackageIdentity(extractedRoot) {
    const expectedFiles = PACKAGE_IDENTITY_PATHS.map((file) => `${extractedRoot}/${file}`);
    const installedFiles = PACKAGE_IDENTITY_PATHS.map((file) => `/${file}`);
    const expected = parseSha256Lines(await runGuest(`sha256sum ${expectedFiles.map(shellQuote).join(" ")}`, "guest: hash extracted package"));
    const installed = parseSha256Lines(await runGuest(`sha256sum ${installedFiles.map(shellQuote).join(" ")}`, "guest: hash installed package"));
    const identity = {};
    for (let index = 0; index < PACKAGE_IDENTITY_PATHS.length; index += 1) {
      const relative = PACKAGE_IDENTITY_PATHS[index];
      const expectedHash = expected[expectedFiles[index].replace(/^\//, "")];
      const installedHash = installed[installedFiles[index].replace(/^\//, "")];
      if (!expectedHash || expectedHash !== installedHash) fail(`Installed package identity mismatch: ${relative}`);
      identity[relative] = installedHash;
    }
    return identity;
  }

  async function installGuestPackage(deb, extractedRoot, expectedVersion) {
    await runGuest(
      `sudo -n env DEBIAN_FRONTEND=noninteractive http_proxy=http://127.0.0.1:${HOST_PROXY_PORT} https_proxy=http://127.0.0.1:${HOST_PROXY_PORT} apt-get install -y --reinstall ${shellQuote(deb)}`,
      `guest: install ${path.posix.basename(deb)}`,
    );
    const actual = (await runGuest("dpkg-query -W -f='${Version}' codex-desktop", "guest: query installed version")).trim();
    if (actual !== expectedVersion) fail(`Guest installed version is ${actual || "missing"}; expected ${expectedVersion}`);
    const identity = await guestPackageIdentity(extractedRoot);
    await runGuest("test -L /usr/bin/codex-desktop && test -f /usr/share/applications/codex-desktop.desktop && grep -q '^Exec=codex-desktop %U$' /usr/share/applications/codex-desktop.desktop", "guest: verify launcher and desktop entry");
    return { identity, version: actual };
  }

  async function collectEvidence(label, required = true) {
    fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
    let screenshotError = null;
    try {
      await vm.takeScreenshot(path.join(reportDir, `vm-desktop-${safeSegment(label)}.ppm`));
    } catch (error) {
      screenshotError = error;
      logText += `\n[evidence] VM screenshot failed: ${error.message}\n`;
    }
    try {
      vm.pullDirectoryFromGuest(paths.reports, reportDir);
    } catch (error) {
      logText += `\n[evidence] Guest report pull failed: ${error.message}\n`;
      throw error;
    }
    const qemuLog = path.join(PROJECT_ROOT, "vm-state", "runtime", "qemu.log");
    if (fs.existsSync(qemuLog)) fs.copyFileSync(qemuLog, path.join(reportDir, "qemu.log"));
    const diagnostics = await runGuest(
      "printf 'arch='; uname -m; printf 'os='; . /etc/os-release; echo \"$ID $VERSION_ID\"; printf 'session='; loginctl show-session 1 -p Type --value 2>/dev/null || true; sudo cloud-init status --long",
      "guest: collect diagnostics",
    );
    fs.writeFileSync(path.join(reportDir, "guest-diagnostics.log"), redactLog(diagnostics), { mode: 0o600 });
    if (required && screenshotError) throw screenshotError;
    evidenceCollected = true;
  }

  async function rollback() {
    report.rollback.attempted = true;
    try {
      if (!rollbackDeb) fail("Rollback package is unavailable");
      const result = await installGuestPackage(paths.rollbackDeb, paths.rollbackExtracted, debVersion(rollbackDeb));
      await runGuestSmoke("safe", "/usr/bin/codex-desktop", "rollback-safe", 120_000);
      await runGuestSmoke("auth-probe", "/usr/bin/codex-desktop", "rollback-auth-probe", 240_000);
      report.rollback.identity = result.identity;
      report.rollback.succeeded = true;
    } catch (error) {
      report.rollback.succeeded = false;
      report.rollback.error = redactLog(error.message);
    }
  }

  try {
    await runStage("preflight", async () => {
      if (report.git.dirty) fail("Final acceptance requires a clean tracked worktree");
      if (os.platform() !== "linux" || os.arch() !== "x64") fail("Strict VM acceptance requires an x64 Linux host");
      if (!profileSourcesExist()) fail("Local Codex authentication profile is unavailable");
      vm.assertBaselineCurrent();
      rollbackDeb = findRollbackDeb(report.app.version, platform);
      if (!rollbackDeb) fail("No accepted x64 rollback package is available");
      report.install.beforeVersion = debVersion(rollbackDeb);
      report.install.rollbackSha256 = sha256File(rollbackDeb);
    });

    await runStage("unit-tests", () => runCommand("npm", ["test"]));
    await runStage("candidate-build", async () => {
      await runCommand("npm", ["run", "build"]);
      candidateDeb = candidateDebFor(platform);
      candidateVersion = debVersion(candidateDeb);
      if (candidateVersion !== report.app.version) {
        fail(`Candidate version ${candidateVersion} does not match ${report.app.version}`);
      }
      report.install.candidateSha256 = sha256File(candidateDeb);
    });
    await runStage("generated-syntax", () => runCommand("npm", ["run", "verify:linux:syntax"]));
    await runStage("candidate-history", () => runCommand("node", [
      "scripts/verify-build-history.js", "--channel", "candidate", "--platform", platform,
    ]));
    await runStage("vm-reset", () => vm.resetVm());

    await runStage("auth-snapshot", async () => {
      if (codexIsRunning()) fail("Close the host Codex Desktop before creating the authentication snapshot");
      authSnapshot = createAuthSnapshot();
      sensitiveStrings = sensitiveStringsFromAuth(path.join(authSnapshot.codexHome, "auth.json"));
      report.authentication = { copiedFiles: authSnapshot.copiedFiles, sourceUnchanged: true, storage: "guest-tmpfs" };
    });

    await runStage("vm-stage", async () => {
      await runGuest(`install -d -m 0700 ${shellQuote(paths.disk)} ${shellQuote(paths.scripts)} ${shellQuote(paths.reports)} ${shellQuote(paths.auth)} ${shellQuote(paths.tempWork)}`, "guest: create acceptance directories");
      vm.pushFileToGuest(candidateDeb, paths.candidateDeb);
      vm.pushFileToGuest(rollbackDeb, paths.rollbackDeb);
      vm.pushFileToGuest(path.join(__dirname, "smoke-linux-desktop.js"), `${paths.scripts}/smoke-linux-desktop.js`);
      vm.pushFileToGuest(path.join(__dirname, "acceptance-profile.js"), `${paths.scripts}/acceptance-profile.js`);
      await vm.streamDirectoryToGuest(authSnapshot.root, `${paths.auth}/source`);
      authSnapshot.assertSourceUnchanged();
      authSnapshot.cleanup();
      authSnapshot = null;
      const expected = `${report.install.candidateSha256}  ${paths.candidateDeb}\n${report.install.rollbackSha256}  ${paths.rollbackDeb}`;
      await runGuest(`printf '%s\\n' ${shellQuote(expected)} | sha256sum -c -`, "guest: verify staged package hashes");
    });

    await runStage("guest-preflight", async () => {
      const output = await runGuest(
        `set -eu; test "$(uname -m)" = x86_64; test "$(findmnt -n -o FSTYPE /run)" = tmpfs; test "$(df -k --output=avail /tmp | tail -1)" -ge 8388608; test -S /run/user/1000/bus; test -f /run/user/1000/gdm/Xauthority; sudo -n true; test "$(node -p 'Number(process.versions.node.split(".")[0]) >= 18')" = true; ! dpkg-query -W codex-desktop >/dev/null 2>&1; curl --proxy http://127.0.0.1:${HOST_PROXY_PORT} --max-time 15 --silent --show-error https://api.ipify.org`,
        "guest: preflight",
      );
      const egress = output.trim().split(/\r?\n/).at(-1);
      if (!/^[0-9a-f:.]+$/i.test(egress)) fail("Guest proxy preflight returned an invalid egress address");
      report.execution.proxyEgress = egress;
      report.execution.guestArch = "x86_64";
      report.execution.guestOs = "ubuntu-24.04";
    });

    await runStage("candidate-empty-profile", async () => {
      await runGuest(`rm -rf ${shellQuote(paths.candidateExtracted)} && dpkg-deb -x ${shellQuote(paths.candidateDeb)} ${shellQuote(paths.candidateExtracted)}`, "guest: extract candidate package");
      await runGuestSmoke("safe", `${paths.candidateExtracted}/usr/lib/codex-desktop/Codex`, "candidate-smoke", 120_000);
    });

    await runStage("accepted-baseline", async () => {
      await runGuest(`rm -rf ${shellQuote(paths.rollbackExtracted)} && dpkg-deb -x ${shellQuote(paths.rollbackDeb)} ${shellQuote(paths.rollbackExtracted)}`, "guest: extract accepted package");
      const baseline = await installGuestPackage(paths.rollbackDeb, paths.rollbackExtracted, report.install.beforeVersion);
      report.install.rollbackIdentity = baseline.identity;
      await runGuestSmoke("safe", "/usr/bin/codex-desktop", "accepted-safe", 120_000);
      await runGuestSmoke("auth-probe", "/usr/bin/codex-desktop", "accepted-auth-probe", 240_000);
    });

    await runStage("install-candidate", async () => {
      installAttempted = true;
      const installed = await installGuestPackage(paths.candidateDeb, paths.candidateExtracted, candidateVersion);
      report.install.afterVersion = installed.version;
      report.install.candidateIdentity = installed.identity;
    });

    await runStage("installed-core-ui", () => runGuestSmoke(
      "core",
      "/usr/bin/codex-desktop",
      "installed-core",
      900_000,
    ));

    await runStage("vm-evidence", () => collectEvidence("passed"));
    await runStage("evidence-redaction", async () => assertEvidenceContainsNoSecrets(reportDir, sensitiveStrings));
    await runStage("vm-cleanup", async () => {
      await vm.discardVm();
      cleanupCompleted = true;
      assertHostInstallUnchanged();
    });

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
  } catch (error) {
    failure = error;
    report.status = "failed";
    report.failureClass = interruptedSignal ? "interrupted" : failureClassForStage(currentStage);
    report.error = redactLog(error.message);
    if (installAttempted && ["install-candidate", "installed-core-ui"].includes(currentStage)) {
      await rollback();
      if (!report.rollback.succeeded) report.failureClass = "infrastructure";
    }
    if (!evidenceCollected) {
      try {
        await collectEvidence("failed", false);
      } catch (evidenceError) {
        report.evidenceError = redactLog(evidenceError.message);
      }
    }
    try {
      assertEvidenceContainsNoSecrets(reportDir, sensitiveStrings);
    } catch (redactionError) {
      report.evidenceError = redactLog(redactionError.message);
      report.failureClass = "infrastructure";
    }
  } finally {
    if (authSnapshot) {
      try { authSnapshot.cleanup(); } catch {}
    }
    if (!cleanupCompleted) {
      try {
        await vm.discardVm();
        cleanupCompleted = true;
      } catch (cleanupError) {
        report.cleanupError = redactLog(cleanupError.message);
        report.failureClass = "infrastructure";
        if (!failure) failure = cleanupError;
        report.status = "failed";
      }
    }
    report.finishedAt = new Date().toISOString();
    try {
      assertHostInstallUnchanged();
    } catch (hostError) {
      report.hostError = redactLog(hostError.message);
      report.failureClass = "infrastructure";
      report.status = "failed";
      if (!failure) failure = hostError;
    }
    persist();
    pruneAcceptanceRuns(reportDir);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  if (failure) throw failure;
  console.log(`\n[ok] accepted ${report.app.version} (${report.runId})`);
  return { report, reportDir };
}

async function main() {
  await runAcceptance({ platform: argValue("--platform", REQUIRED_PLATFORM) });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n[x] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  INFRASTRUCTURE_STAGES,
  PACKAGE_IDENTITY_PATHS,
  assertEvidenceContainsNoSecrets,
  candidateDebFor,
  createAcceptanceReport,
  failureClassForStage,
  findRollbackDeb,
  guestPaths,
  installedVersion,
  parseSha256Lines,
  runAcceptance,
  safeSegment,
};
