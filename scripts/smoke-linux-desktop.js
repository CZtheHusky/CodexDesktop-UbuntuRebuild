#!/usr/bin/env node
/**
 * GUI smoke tests for the rebuilt Linux Codex Desktop app.
 *
 * The default modes avoid mutating the user's real profile. auth-clone copies
 * the login/profile data into a temporary HOME so the app can pass real UI
 * gates without requiring a fresh login.
 */
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const VALID_MODES = new Set(["safe", "auth-clone", "real"]);
const VALID_PLATFORMS = new Set(["linux-x64", "linux-arm64"]);
const DEFAULT_TIMEOUT_MS = 90_000;
const LOG_LIMIT = 256 * 1024;

const PROFILE_SKIP_NAMES = new Set([
  "Cache",
  "Code Cache",
  "Crashpad",
  "DawnCache",
  "GPUCache",
  "ShaderCache",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  ".tmp",
  "logs",
]);

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

function rel(file) {
  return path.relative(PROJECT_ROOT, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deadlineFromNow(timeoutMs) {
  return Date.now() + timeoutMs;
}

function assertNotExpired(deadline, label) {
  if (Date.now() > deadline) fail(`${label} timed out`);
}

function platformOutDir(platform) {
  return platform === "linux-arm64" ? "Codex-linux-arm64" : "Codex-linux-x64";
}

function appPathForPlatform(platform) {
  return path.join(PROJECT_ROOT, "out", platformOutDir(platform), "Codex");
}

function redactLog(text) {
  return String(text)
    .replace(/([A-Za-z0-9_-]{48,})/g, "<redacted>")
    .replace(/(Bearer|token|secret|authorization)([=: ]+)(\S+)/gi, "$1$2<redacted>");
}

function createLogMonitor() {
  let buffer = "";
  const fatalPatterns = [
    /\bSyntaxError\b/,
    /\bReferenceError\b/,
    /render-process-gone[^\n]*(reason|exitCode|crashed|killed)/i,
    /renderer process gone/i,
    /initialize_handshake_result[^\n]*outcome=(?!success)\w+/,
    /Codex CLI initialized[^\n]*error/i,
    /app-server[^\n]*(failed|crashed|exited)/i,
  ];

  function push(chunk) {
    buffer += chunk.toString("utf8");
    if (buffer.length > LOG_LIMIT) buffer = buffer.slice(buffer.length - LOG_LIMIT);
  }

  function text() {
    return buffer;
  }

  function includes(pattern) {
    return pattern.test(buffer);
  }

  function fatalMatch() {
    return fatalPatterns.find((pattern) => pattern.test(buffer)) ?? null;
  }

  function assertNoFatal() {
    const match = fatalMatch();
    if (!match) return;
    fail(`fatal startup log matched ${match}: ${redactLog(buffer).slice(-6000)}`);
  }

  return { assertNoFatal, includes, push, text };
}

function shouldCopyProfilePath(source) {
  return !PROFILE_SKIP_NAMES.has(path.basename(source));
}

function copyDirIfPresent(source, destination) {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: shouldCopyProfilePath,
  });
  return true;
}

function createTempHome(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".config"), { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.chmodSync(home, 0o700);
  return { home, root };
}

function createProfile(mode, options = {}) {
  if (mode === "real") {
    if (process.env.CODEX_DESKTOP_SMOKE_REAL_PROFILE !== "1") {
      fail("real profile smoke requires CODEX_DESKTOP_SMOKE_REAL_PROFILE=1");
    }
    return {
      cleanup: () => {},
      env: { ...process.env },
      home: os.homedir(),
      root: null,
    };
  }

  const profile = createTempHome(`codex-desktop-smoke-${mode}-`);
  const env = {
    ...process.env,
    CODEX_HOME: path.join(profile.home, ".codex"),
    HOME: profile.home,
    XDG_CONFIG_HOME: path.join(profile.home, ".config"),
  };

  if (mode === "auth-clone") {
    const realHome = os.homedir();
    const copiedCodex = copyDirIfPresent(path.join(realHome, ".codex"), path.join(profile.home, ".codex"));
    const copiedUserData = copyDirIfPresent(
      path.join(realHome, ".config", "Codex"),
      path.join(profile.home, ".config", "Codex"),
    );
    if (!copiedCodex && !copiedUserData) {
      fail("auth-clone smoke could not find ~/.codex or ~/.config/Codex to clone");
    }
  }

  return {
    cleanup: () => {
      if (!options.keepProfile) fs.rmSync(profile.root, { recursive: true, force: true });
      else console.log(`  [debug] kept smoke profile: ${profile.root}`);
    },
    env,
    home: profile.home,
    root: profile.root,
  };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function httpJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`${url} returned ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error(`${url} timed out`));
    });
  });
}

async function waitForCdpTarget(port, deadline) {
  const url = `http://127.0.0.1:${port}/json/list`;
  while (Date.now() <= deadline) {
    try {
      const targets = await httpJson(url);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Electron may not have opened the DevTools endpoint yet.
    }
    await sleep(250);
  }
  fail("DevTools page target did not appear");
}

function connectCdp(webSocketDebuggerUrl) {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable; use Node 20+");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    let nextId = 0;
    const pending = new Map();

    function send(method, params = {}) {
      return new Promise((innerResolve, innerReject) => {
        const id = ++nextId;
        pending.set(id, { reject: innerReject, resolve: innerResolve });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    };
    ws.onerror = () => reject(new Error("DevTools WebSocket failed"));
    ws.onopen = () => {
      resolve({
        close: () => ws.close(),
        evaluate: async (expression) => {
          const result = await send("Runtime.evaluate", {
            awaitPromise: true,
            expression,
            returnByValue: true,
          });
          if (result.exceptionDetails) {
            const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
            fail(`Runtime.evaluate failed: ${description}`);
          }
          return result.result.value;
        },
        send,
      });
    };
  });
}

async function waitForLog(logs, pattern, deadline, label) {
  while (Date.now() <= deadline) {
    logs.assertNoFatal();
    if (logs.includes(pattern)) return;
    await sleep(250);
  }
  fail(`${label} did not appear in startup logs`);
}

async function stopProcess(child) {
  if (child.exitCode != null || child.signalCode != null) return;

  function signal(signalName) {
    try {
      process.kill(-child.pid, signalName);
    } catch {
      try {
        child.kill(signalName);
      } catch {
        // Process already exited.
      }
    }
  }

  signal("SIGINT");
  for (let i = 0; i < 20; i += 1) {
    if (child.exitCode != null || child.signalCode != null) return;
    await sleep(100);
  }
  signal("SIGTERM");
  for (let i = 0; i < 20; i += 1) {
    if (child.exitCode != null || child.signalCode != null) return;
    await sleep(100);
  }
  signal("SIGKILL");
}

function snapshotExpression() {
  return `(() => {
    const controls = [...document.querySelectorAll("button,[role=button],textarea,input,[contenteditable=true]")].map((el, index) => ({
      aria: el.getAttribute("aria-label") || "",
      index,
      role: el.getAttribute("role") || "",
      tag: el.tagName,
      text: (el.innerText || el.value || "").trim().slice(0, 180),
      title: el.getAttribute("title") || ""
    }));
    return {
      bodyText: (document.body && document.body.innerText || "").slice(0, 20000),
      buttonCount: controls.filter((control) => control.tag === "BUTTON" || control.role === "button").length,
      controls,
      editableCount: document.querySelectorAll("textarea,input,[contenteditable=true]").length,
      title: document.title
    };
  })()`;
}

function controlHaystack(control) {
  return `${control.aria}\n${control.title}\n${control.text}`;
}

function hasControl(snapshot, pattern) {
  return snapshot.controls.some((control) => pattern.test(controlHaystack(control)));
}

function detectPlanMode(snapshot) {
  return snapshot.controls.some((control) => {
    const value = controlHaystack(control).trim();
    return /(^|\n)(Plan|计划|計劃)(\n|$)/i.test(value);
  });
}

function assertCoreUi(snapshot, mode) {
  if (!snapshot.title || !/Codex/i.test(snapshot.title)) fail(`unexpected page title: ${snapshot.title || "<empty>"}`);
  if (snapshot.bodyText.length < 20) fail("page body is unexpectedly empty");
  if (mode === "safe") return;

  if (/log in|sign in|登录|登入/i.test(snapshot.bodyText)) {
    fail(`${mode} smoke reached a login screen; auth profile was not usable`);
  }
  if (snapshot.editableCount < 1) fail("composer/editor control was not found");
  if (snapshot.buttonCount < 8) fail("too few interactive controls were found");
  if (!/Codex/.test(snapshot.bodyText)) fail("main app text does not include Codex");
}

async function waitForUiSnapshot(cdp, mode, deadline) {
  let snapshot = null;
  while (Date.now() <= deadline) {
    snapshot = await cdp.evaluate(snapshotExpression());
    if (mode === "safe" && snapshot.bodyText.length >= 20) return snapshot;
    if (mode !== "safe" && snapshot.bodyText.length >= 20 && snapshot.editableCount >= 1) return snapshot;
    await sleep(250);
  }
  return snapshot;
}

async function dispatchKey(cdp, key, code, keyCode, modifiers = 0) {
  const params = {
    code,
    key,
    modifiers,
    nativeVirtualKeyCode: keyCode,
    windowsVirtualKeyCode: keyCode,
  };
  await cdp.send("Input.dispatchKeyEvent", { ...params, type: "rawKeyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...params, type: "keyUp" });
}

async function pressEscape(cdp) {
  await dispatchKey(cdp, "Escape", "Escape", 27);
}

async function clickFirst(cdp, patternSource, flags = "i") {
  return cdp.evaluate(`(() => {
    const pattern = new RegExp(${JSON.stringify(patternSource)}, ${JSON.stringify(flags)});
    const controls = [...document.querySelectorAll("button,[role=button]")];
    const target = controls.find((el) => pattern.test([el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText].filter(Boolean).join("\\n")));
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

async function exerciseMenu(cdp, patternSource, label) {
  const clicked = await clickFirst(cdp, patternSource);
  if (!clicked) fail(`${label} control was not found`);
  await sleep(250);
  await pressEscape(cdp);
}

async function exerciseComposerDraft(cdp) {
  const draft = `codex-smoke-${Date.now()}`;
  const focused = await cdp.evaluate(`(() => {
    const editor = document.querySelector("[contenteditable=true], textarea");
    if (!editor) return false;
    editor.focus();
    return document.activeElement === editor || editor.contains(document.activeElement);
  })()`);
  if (!focused) fail("composer/editor could not be focused");

  await cdp.send("Input.insertText", { text: draft });
  await sleep(300);
  const inserted = await cdp.evaluate(`(() => {
    const editor = document.querySelector("[contenteditable=true], textarea");
    return editor ? (editor.innerText || editor.value || "") : "";
  })()`);
  if (!inserted.includes(draft)) fail("composer/editor did not accept temporary draft input");

  await dispatchKey(cdp, "a", "KeyA", 65, 2);
  await dispatchKey(cdp, "Backspace", "Backspace", 8);
  await sleep(300);
  const cleared = await cdp.evaluate(`(() => {
    const editor = document.querySelector("[contenteditable=true], textarea");
    return editor ? (editor.innerText || editor.value || "") : "";
  })()`);
  if (cleared.includes(draft)) fail("temporary draft text was not cleared");
}

async function exercisePlanShortcut(cdp) {
  await cdp.evaluate(`(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const button = document.querySelector("button,[role=button]");
    if (button && button.focus) button.focus();
    return true;
  })()`);
  const before = await cdp.evaluate(snapshotExpression());
  const initial = detectPlanMode(before);
  await dispatchKey(cdp, "Tab", "Tab", 9, 8);

  let after = before;
  for (let i = 0; i < 12; i += 1) {
    await sleep(250);
    after = await cdp.evaluate(snapshotExpression());
    if (detectPlanMode(after) !== initial) break;
  }
  if (detectPlanMode(after) === initial) fail("Shift+Tab did not toggle Plan mode");

  await dispatchKey(cdp, "Tab", "Tab", 9, 8);
  for (let i = 0; i < 12; i += 1) {
    await sleep(250);
    after = await cdp.evaluate(snapshotExpression());
    if (detectPlanMode(after) === initial) return;
  }
  fail("Shift+Tab did not restore the original Plan mode state");
}

async function exerciseCoreUi(cdp, mode) {
  const snapshot = await waitForUiSnapshot(cdp, mode, deadlineFromNow(30_000));
  if (!snapshot) fail("UI snapshot was unavailable");
  assertCoreUi(snapshot, mode);
  if (mode === "safe") return;

  if (!hasControl(snapshot, /sidebar|侧边栏|側邊欄/i)) fail("sidebar toggle control was not found");

  await exerciseComposerDraft(cdp);
  await exercisePlanShortcut(cdp);
  await exerciseMenu(cdp, "sidebar|侧边栏|側邊欄", "sidebar toggle");
  if (hasControl(await cdp.evaluate(snapshotExpression()), /bottom panel|底部面板|下方面板/i)) {
    await exerciseMenu(cdp, "bottom panel|底部面板|下方面板", "bottom panel toggle");
  } else {
    console.log("  [skip] bottom panel toggle is not rendered in this UI state");
  }
  await exerciseMenu(cdp, "project|项目|專案", "project/menu");
  await exerciseMenu(cdp, "approval|approve|审批|審批|替我审批", "approval menu");

  if (mode !== "real") {
    await dispatchKey(cdp, "n", "KeyN", 78, 2);
    await sleep(500);
    await dispatchKey(cdp, "n", "KeyN", 78, 3);
    await sleep(500);
  }
}

async function runSmoke(options) {
  const mode = options.mode || "safe";
  const platform = options.platform || "linux-x64";
  if (!VALID_MODES.has(mode)) fail(`Unsupported --mode ${mode}`);
  if (!VALID_PLATFORMS.has(platform)) fail(`Unsupported --platform ${platform}`);

  const appPath = options.appPath || appPathForPlatform(platform);
  if (!fs.existsSync(appPath)) fail(`Missing app executable ${rel(appPath)}; run npm run build first`);

  const port = options.port || (await findFreePort());
  const deadline = deadlineFromNow(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const profile = createProfile(mode, { keepProfile: options.keepProfile });
  const logs = createLogMonitor();
  let cdp = null;
  let child = null;

  try {
    console.log(`-- smoke-linux-desktop: ${mode} (${platform}, port ${port})`);
    child = spawn(appPath, ["--no-sandbox", `--remote-debugging-port=${port}`], {
      cwd: PROJECT_ROOT,
      detached: true,
      env: profile.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", logs.push);
    child.stderr.on("data", logs.push);
    child.on("exit", (code, signal) => {
      logs.push(`\n[smoke] app exited code=${code} signal=${signal}\n`);
    });

    const target = await waitForCdpTarget(port, deadline);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.bringToFront");

    await waitForLog(logs, /window ready-to-show/, deadline, "main window ready-to-show");
    await waitForLog(logs, /initialize_handshake_result[^\n]*outcome=success/, deadline, "app-server handshake");
    assertNotExpired(deadline, "smoke-linux-desktop");
    logs.assertNoFatal();

    await exerciseCoreUi(cdp, mode);
    logs.assertNoFatal();

    console.log(`  [ok] ${mode} smoke passed`);
  } catch (error) {
    const excerpt = logs.text() ? `\n--- recent app log ---\n${redactLog(logs.text()).slice(-8000)}` : "";
    error.message = `${error.message}${excerpt}`;
    throw error;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopProcess(child);
    profile.cleanup();
  }
}

async function main() {
  await runSmoke({
    appPath: argValue("--app", null),
    keepProfile: hasFlag("--keep-profile"),
    mode: argValue("--mode", "safe"),
    platform: argValue("--platform", "linux-x64"),
    port: Number(argValue("--port", "0")) || null,
    timeoutMs: Number(argValue("--timeout-ms", String(DEFAULT_TIMEOUT_MS))),
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[x] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  appPathForPlatform,
  controlHaystack,
  createLogMonitor,
  createProfile,
  detectPlanMode,
  redactLog,
  runSmoke,
  shouldCopyProfilePath,
};
