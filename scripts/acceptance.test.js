const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  appPathForPlatform,
  createLogMonitor,
  detectActivePlanMode,
  detectPlanMode,
  extractProposedPlan,
  occurrenceCount,
  redactLog,
  shouldCopyProfilePath,
} = require("./smoke-linux-desktop");
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
  assert.equal(shouldCopyProfilePath(`${root}/config.toml`, { kind: "codex", root }), true);
  assert.equal(shouldCopyProfilePath(`${root}/state_5.sqlite`, { kind: "codex", root }), false);
  assert.equal(shouldCopyProfilePath(`${root}/history.jsonl`, { kind: "codex", root }), false);
  assert.equal(shouldCopyProfilePath(`${root}/archived_sessions`, { kind: "codex", root }), false);
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

test("package scripts expose the reusable acceptance flow", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  for (const script of [
    "build:accepted",
    "verify:linux:syntax",
    "verify:build-history",
    "verify:build-candidate",
    "smoke:linux:safe",
    "smoke:linux:auth-clone",
    "smoke:linux:plan-flow",
    "smoke:linux:core",
    "smoke:linux:real",
  ]) {
    assert.equal(typeof pkg.scripts[script], "string", `${script} script missing`);
  }
  assert.match(pkg.scripts["build:accepted"], /accept-linux-desktop\.js/);
  assert.match(pkg.scripts["build:linux-x64"], /--channel candidate/);
  assert.match(pkg.scripts["build:linux-x64"], /verify-build-history\.js --channel candidate/);
});

test("acceptance runner requires install, core UI, rollback, and promotion", () => {
  const runner = fs.readFileSync(path.join(__dirname, "accept-linux-desktop.js"), "utf8");
  assert.match(runner, /install-candidate/);
  assert.match(runner, /installed-core-ui/);
  assert.match(runner, /async function rollback/);
  assert.match(runner, /installAttempted = true/);
  assert.match(runner, /if \(installAttempted\) await rollback\(\)/);
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
