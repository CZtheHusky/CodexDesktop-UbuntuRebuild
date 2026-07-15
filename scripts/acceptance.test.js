const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  appPathForPlatform,
  chromiumProxyServerForEnv,
  createLogMonitor,
  createProfile,
  detectActivePlanMode,
  detectPlanMode,
  extractProposedPlan,
  occurrenceCount,
  parseX11Windows,
  redactLog,
  shouldCopyProfilePath,
} = require("./smoke-linux-desktop");
const { copyDirIfPresent, createAuthSnapshot } = require("./acceptance-profile");
const {
  assertEvidenceContainsNoSecrets,
  failureClassForStage,
  guestPaths,
  parseSha256Lines,
} = require("./accept-linux-desktop");
const { historyRootFor } = require("./archive-build-history");
const {
  REQUIRED_ACCEPTANCE_STAGES,
  REQUIRED_CORE_STEPS,
  archDirFor,
  assertRequiredPassed,
  safeSegment,
} = require("./verify-build-history");

test("smoke profile clone excludes cache and singleton lock paths", () => {
  assert.equal(shouldCopyProfilePath("/home/user/.config/Codex/Cache"), false);
  assert.equal(shouldCopyProfilePath("/home/user/.codex/.tmp"), false);
  assert.equal(shouldCopyProfilePath("/home/user/.config/Codex/Code Cache"), false);
  assert.equal(shouldCopyProfilePath("/home/user/.config/Codex/SingletonLock"), false);
  assert.equal(shouldCopyProfilePath("/home/user/.config/Codex/Local Storage"), true);
  assert.equal(shouldCopyProfilePath("/home/user/.codex/auth.json"), true);
});

test("authenticated smoke copies only required Codex root files", () => {
  const root = "/home/user/.codex";
  assert.equal(shouldCopyProfilePath(`${root}/auth.json`, { kind: "codex", root }), true);
  assert.equal(shouldCopyProfilePath(`${root}/config.toml`, { kind: "codex", root }), false);
  assert.equal(shouldCopyProfilePath(`${root}/state_5.sqlite`, { kind: "codex", root }), false);
  assert.equal(shouldCopyProfilePath(`${root}/history.jsonl`, { kind: "codex", root }), false);
  assert.equal(shouldCopyProfilePath(`${root}/archived_sessions`, { kind: "codex", root }), false);
});

test("authenticated snapshot uses an explicit Electron state allowlist", () => {
  const root = "/home/user/.config/Codex";
  assert.equal(shouldCopyProfilePath(`${root}/Cookies`, { kind: "desktop", root }), true);
  assert.equal(shouldCopyProfilePath(`${root}/Local Storage/leveldb/CURRENT`, { kind: "desktop", root }), true);
  assert.equal(shouldCopyProfilePath(`${root}/Partitions/codex-browser-app/Preferences`, { kind: "desktop", root }), true);
  assert.equal(shouldCopyProfilePath(`${root}/Session Storage/CURRENT`, { kind: "desktop", root }), false);
  assert.equal(shouldCopyProfilePath(`${root}/Cache/index`, { kind: "desktop", root }), false);
});

test("authenticated snapshot rejects symlinks instead of following host paths", () => {
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "codex-profile-source-"));
  const destination = `${root}-copy`;
  try {
    fs.mkdirSync(path.join(root, "Local Storage"), { recursive: true });
    fs.symlinkSync("/etc/passwd", path.join(root, "Local Storage", "linked"));
    assert.throws(() => copyDirIfPresent(root, destination, "desktop"), /symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});

test("authenticated snapshot detects source changes before credentials leave the host", () => {
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "codex-auth-source-"));
  const codexHome = path.join(root, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), '{"token":"original-auth-value"}\n');
  const snapshot = createAuthSnapshot({ sourceCodexHome: codexHome, sourceUserData: path.join(root, "Codex") });
  try {
    fs.writeFileSync(path.join(codexHome, "auth.json"), '{"token":"changed-auth-value"}\n');
    assert.throws(() => snapshot.assertSourceUnchanged(), /changed during snapshot/);
  } finally {
    snapshot.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("smoke forces Electron networking through the configured proxy", () => {
  assert.equal(
    chromiumProxyServerForEnv({ HTTPS_PROXY: "http://127.0.0.1:7897" }),
    "http://127.0.0.1:7897",
  );
  assert.equal(
    chromiumProxyServerForEnv({ ALL_PROXY: "socks5h://127.0.0.1:7897" }),
    "socks5://127.0.0.1:7897",
  );
  assert.equal(chromiumProxyServerForEnv({}), null);
  assert.throws(
    () => chromiumProxyServerForEnv({ HTTPS_PROXY: "http://user:secret@127.0.0.1:7897" }),
    /cannot be exposed/,
  );
});

test("Electron-as-Node smoke driver launches the child as a desktop app", () => {
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = "1";
  const profile = createProfile("safe");
  try {
    assert.equal(profile.env.ELECTRON_RUN_AS_NODE, undefined);
  } finally {
    profile.cleanup();
    if (previous == null) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previous;
  }
});

test("native picker discovery does not depend on the currently focused X11 window", () => {
  assert.deepEqual(
    parseX11Windows("0x04e00004  0 327008 codex.codex host Codex\n"),
    [{ className: "codex.codex", id: "0x04e00004", pid: 327008, title: "Codex" }],
  );
});

test("smoke log monitor treats startup syntax errors as fatal", () => {
  const logs = createLogMonitor();
  logs.push("Launching app\nSyntaxError: Unexpected token ']'\n");
  assert.throws(() => logs.assertNoFatal(), /SyntaxError/);
});

test("smoke log monitor accepts successful app-server handshake", () => {
  const logs = createLogMonitor();
  logs.push("initialize_handshake_result durationMs=177 outcome=success transportKind=stdio\n");
  logs.push('"_events":{"render-process-gone":[null]} targetDestroyed=false\n');
  assert.doesNotThrow(() => logs.assertNoFatal());
  assert.equal(logs.includes(/outcome=success/), true);
});

test("log redaction removes long token-like strings", () => {
  const redacted = redactLog("token=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  assert.equal(redacted, "token=<redacted>");
  assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ/);
});

test("Plan mode detection works for English and Chinese controls", () => {
  assert.equal(
    detectPlanMode({ controls: [{ aria: "Plan", text: "", title: "" }] }),
    true,
  );
  assert.equal(
    detectPlanMode({ controls: [{ aria: "", text: "计划", title: "" }] }),
    true,
  );
  assert.equal(
    detectPlanMode({ controls: [{ aria: "Chat", text: "", title: "" }] }),
    false,
  );
});

test("Plan mode active detection uses explicit control state", () => {
  assert.equal(
    detectActivePlanMode({
      bodyText: "",
      controls: [{ aria: "Plan", ariaPressed: "true", text: "", title: "" }],
    }),
    true,
  );
  assert.equal(
    detectActivePlanMode({
      bodyText: "",
      controls: [{ aria: "计划", ariaPressed: "false", text: "", title: "" }],
    }),
    false,
  );
});

test("proposed_plan extraction ignores surrounding assistant text", () => {
  assert.equal(
    extractProposedPlan("before <proposed_plan>\n- step one\n</proposed_plan> after"),
    "- step one",
  );
  assert.equal(extractProposedPlan("plain plan text"), null);
});

test("response markers must appear in both prompt and response", () => {
  assert.equal(occurrenceCount("marker", "marker"), 1);
  assert.equal(occurrenceCount("marker then marker", "marker"), 2);
});

test("acceptance helpers resolve platform-specific paths", () => {
  assert.equal(archDirFor("linux-x64"), "x64");
  assert.equal(archDirFor("linux-arm64"), "arm64");
  assert.equal(safeSegment("26.707.71524+5263"), "26.707.71524+5263");
  assert.equal(safeSegment("26/707 71524"), "26_707_71524");
  assert.match(historyRootFor("candidate"), /build-history\/candidates\/codex-desktop$/);
  assert.match(historyRootFor("accepted"), /build-history\/codex-desktop$/);
  assert.equal(path.basename(appPathForPlatform("linux-x64")), "Codex");
  assert.match(appPathForPlatform("linux-x64"), /out\/Codex-linux-x64\/Codex$/);
});

test("accepted reports cannot omit or skip required gates", () => {
  const passed = REQUIRED_ACCEPTANCE_STAGES.map((name) => ({ name, status: "passed" }));
  assert.doesNotThrow(() => assertRequiredPassed(passed, REQUIRED_ACCEPTANCE_STAGES, "acceptance"));
  assert.throws(
    () => assertRequiredPassed(passed.slice(1), REQUIRED_ACCEPTANCE_STAGES, "acceptance"),
    /missing required result preflight/,
  );
  assert.throws(
    () => assertRequiredPassed([{ name: REQUIRED_CORE_STEPS[0], status: "skipped" }], REQUIRED_CORE_STEPS, "core"),
    /contains skipped result startup/,
  );
});

test("VM acceptance contract requires isolation, baseline, evidence, and cleanup", () => {
  for (const stage of [
    "vm-reset",
    "auth-snapshot",
    "guest-preflight",
    "accepted-baseline",
    "installed-core-ui",
    "vm-evidence",
    "evidence-redaction",
    "vm-cleanup",
  ]) {
    assert.ok(REQUIRED_ACCEPTANCE_STAGES.includes(stage), `${stage} is not mandatory`);
  }
  assert.equal(failureClassForStage("vm-reset"), "infrastructure");
  assert.equal(failureClassForStage("installed-core-ui"), "product");
  assert.match(guestPaths("run/id").temp, /^\/run\/user\/1000\/ca\/[a-f0-9]{12}$/);
});

test("guest tmpfs paths leave room for Chromium Unix socket names", () => {
  const first = guestPaths("2026-07-15T11-52-43-292Z-long-version-and-commit");
  const second = guestPaths("2026-07-15T11-52-43-293Z-long-version-and-commit");
  assert.ok(first.tempWork.length < 64, `temporary path is too long: ${first.tempWork}`);
  assert.notEqual(first.temp, second.temp);
  assert.match(first.disk, /long-version-and-commit/);
});

test("installed package identity parser preserves absolute file hashes", () => {
  const hash = "a".repeat(64);
  assert.deepEqual(parseSha256Lines(`${hash}  /usr/lib/codex-desktop/resources/app.asar\n`), {
    "usr/lib/codex-desktop/resources/app.asar": hash,
  });
});

test("evidence scan blocks copied authentication secrets", () => {
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "codex-evidence-"));
  try {
    fs.writeFileSync(path.join(root, "app.log"), "token-for-acceptance-test");
    assert.throws(() => assertEvidenceContainsNoSecrets(root, ["token-for-acceptance-test"]), /leaked/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package scripts expose the reusable acceptance flow", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  for (const script of [
    "build:accepted",
    "verify:linux:syntax",
    "verify:build-history",
    "verify:build-candidate",
    "smoke:linux:safe",
    "smoke:linux:auth-clone",
    "smoke:linux:auth-probe",
    "smoke:linux:plan-flow",
    "smoke:linux:core",
    "smoke:linux:real",
    "vm:discard",
    "vm:reprovision",
  ]) {
    assert.equal(typeof pkg.scripts[script], "string", `${script} script missing`);
  }
  assert.match(pkg.scripts["build:accepted"], /accept-linux-desktop\.js/);
  assert.match(pkg.scripts["build:linux-x64"], /--channel candidate/);
  assert.match(pkg.scripts["build:linux-x64"], /verify-build-history\.js --channel candidate/);
});

test("acceptance runner installs, rolls back, and cleans up only inside the VM", () => {
  const runner = fs.readFileSync(path.join(__dirname, "accept-linux-desktop.js"), "utf8");
  assert.match(runner, /accepted-baseline/);
  assert.match(runner, /install-candidate/);
  assert.match(runner, /installed-core-ui/);
  assert.match(runner, /async function rollback/);
  assert.match(runner, /installAttempted = true/);
  assert.match(runner, /vm\.resetVm\(\)/);
  assert.match(runner, /vm\.discardVm\(\)/);
  assert.match(runner, /ELECTRON_RUN_AS_NODE=1/);
  assert.doesNotMatch(runner, /pkexec|function installCommand/);
  assert.match(runner, /--channel", "accepted"/);
});

test("accepted history promotion verifies before deleting its rollback directory", () => {
  const archive = fs.readFileSync(path.join(__dirname, "archive-build-history.js"), "utf8");
  assert.match(archive, /verify-build-history\.js/);
  assert.match(archive, /--skip-retention/);
  assert.match(archive, /fs\.renameSync\(backupDir, versionDir\)/);
});

test("core UI smoke opens only its isolated test project", () => {
  const smoke = fs.readFileSync(path.join(__dirname, "smoke-linux-desktop.js"), "utf8");
  assert.match(smoke, /args\.push\("--open-project", workspace\.root\)/);
});

test("ADAPTATION.md is the single normative acceptance document", () => {
  const root = path.join(__dirname, "..");
  const standard = fs.readFileSync(path.join(root, "ADAPTATION.md"), "utf8");
  assert.match(standard, /npm run build:accepted/);
  assert.match(standard, /Installed Core UI/);
  assert.match(standard, /Rollback/);
  assert.equal(fs.existsSync(path.join(root, "docs", "acceptance.md")), false);
});
