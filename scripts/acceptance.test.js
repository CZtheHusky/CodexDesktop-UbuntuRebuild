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
  redactLog,
  shouldCopyProfilePath,
} = require("./smoke-linux-desktop");
const {
  archDirFor,
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

test("acceptance helpers resolve platform-specific paths", () => {
  assert.equal(archDirFor("linux-x64"), "x64");
  assert.equal(archDirFor("linux-arm64"), "arm64");
  assert.equal(safeSegment("26.707.71524+5263"), "26.707.71524+5263");
  assert.equal(safeSegment("26/707 71524"), "26_707_71524");
  assert.equal(path.basename(appPathForPlatform("linux-x64")), "Codex");
  assert.match(appPathForPlatform("linux-x64"), /out\/Codex-linux-x64\/Codex$/);
});

test("package scripts expose the reusable acceptance flow", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  for (const script of [
    "build:accepted",
    "verify:linux:syntax",
    "verify:build-history",
    "smoke:linux:safe",
    "smoke:linux:auth-clone",
    "smoke:linux:plan-flow",
    "smoke:linux:real",
  ]) {
    assert.equal(typeof pkg.scripts[script], "string", `${script} script missing`);
  }
  assert.match(pkg.scripts["build:accepted"], /smoke:linux:auth-clone/);
  assert.match(pkg.scripts["build:accepted"], /smoke:linux:plan-flow/);
  assert.match(pkg.scripts["build:accepted"], /verify:build-history/);
});
