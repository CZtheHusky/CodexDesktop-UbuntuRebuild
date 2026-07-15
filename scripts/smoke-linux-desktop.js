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
const VALID_MODES = new Set(["safe", "auth-clone", "plan-flow", "real"]);
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

  if (mode === "auth-clone" || mode === "plan-flow") {
    const realHome = os.homedir();
    const copiedCodex = copyDirIfPresent(path.join(realHome, ".codex"), path.join(profile.home, ".codex"));
    const copiedUserData = copyDirIfPresent(
      path.join(realHome, ".config", "Codex"),
      path.join(profile.home, ".config", "Codex"),
    );
    if (!copiedCodex && !copiedUserData) {
      fail(`${mode} smoke could not find ~/.codex or ~/.config/Codex to clone`);
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
      ariaPressed: el.getAttribute("aria-pressed") || "",
      ariaSelected: el.getAttribute("aria-selected") || "",
      className: typeof el.className === "string" ? el.className.slice(0, 400) : "",
      dataSelected: el.getAttribute("data-selected") || "",
      dataState: el.getAttribute("data-state") || "",
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      index,
      placeholder: el.getAttribute("placeholder") || "",
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
  return `${control.aria}\n${control.title}\n${control.text}\n${control.placeholder}`;
}

function hasControl(snapshot, pattern) {
  return snapshot.controls.some((control) => pattern.test(controlHaystack(control)));
}

function snapshotHaystack(snapshot) {
  return `${snapshot.bodyText}\n${snapshot.controls.map(controlHaystack).join("\n")}`;
}

function formatSnapshotForFailure(snapshot) {
  if (!snapshot) return "\n--- last UI snapshot ---\n<unavailable>";

  const controls = snapshot.controls
    .slice(0, 80)
    .map((control) => {
      const state = [
        control.ariaPressed && `pressed=${control.ariaPressed}`,
        control.ariaSelected && `selected=${control.ariaSelected}`,
        control.dataSelected && `dataSelected=${control.dataSelected}`,
        control.dataState && `dataState=${control.dataState}`,
        control.disabled && "disabled=true",
      ]
        .filter(Boolean)
        .join(" ");
      const label = controlHaystack(control).replace(/\s+/g, " ").trim().slice(0, 220);
      return `[${control.index}] ${control.tag}${control.role ? ` role=${control.role}` : ""}${
        state ? ` ${state}` : ""
      } ${label}`;
    })
    .join("\n");
  const bodyTail = (snapshot.bodyText || "").slice(-6000);
  return [
    "\n--- last UI snapshot ---",
    `title: ${snapshot.title || "<empty>"}`,
    `buttons: ${snapshot.buttonCount}, editables: ${snapshot.editableCount}`,
    "--- controls ---",
    controls || "<none>",
    "--- body tail ---",
    bodyTail || "<empty>",
  ].join("\n");
}

function isPlanControl(control) {
  const value = controlHaystack(control).trim();
  return /(^|\n)(Plan|计划|計劃)(\n|$)/i.test(value);
}

function detectPlanMode(snapshot) {
  return snapshot.controls.some(isPlanControl);
}

function positiveControlState(control) {
  const explicitState = [
    control.ariaPressed,
    control.ariaSelected,
    control.dataSelected,
    control.dataState,
  ]
    .filter(Boolean)
    .join("\n");
  if (/\b(true|on|checked|selected|active)\b/i.test(explicitState)) return true;
  if (/\b(false|off|unchecked)\b/i.test(explicitState)) return false;

  const className = control.className || "";
  if (/\b(active|selected|checked)\b/i.test(className)) return true;
  return null;
}

function detectActivePlanMode(snapshot) {
  const states = snapshot.controls.filter(isPlanControl).map(positiveControlState).filter((state) => state != null);
  if (states.length > 0) return states.some(Boolean);
  return /(?:Plan|计划|計劃)\s*(?:mode|模式)/i.test(snapshot.bodyText);
}

function extractProposedPlan(text) {
  if (typeof text !== "string") return null;
  const match = /<proposed_plan\b[^>]*>([\s\S]*?)<\/proposed_plan>/i.exec(text);
  const plan = match?.[1]?.trim() ?? "";
  return plan.length > 0 ? plan : null;
}

function hasRawProposedPlan(snapshot) {
  return /<\/?proposed_plan\b/i.test(snapshot.bodyText);
}

function hasPlanSummaryUi(snapshot, marker) {
  const text = snapshotHaystack(snapshot);
  if (!text.includes(marker)) return false;
  if (hasRawProposedPlan(snapshot)) return false;
  return /Download plan|Open plan in side panel|Collapse plan summary|Expand plan summary|下载计划|在侧边面板中打开计划|折叠计划摘要|展开计划摘要|下載計劃|開啟.*計劃.*側邊|摺疊.*計劃|展開.*計劃|下载套餐|在侧边面板中打开套餐|下載套餐|開啟.*套餐.*側邊|Implement plan|执行计划|执行此计划|实施计划|实施此计划|執行計劃|執行此計劃|實施計劃|實施此計劃/i.test(text);
}

function hasImplementPlanRequest(snapshot) {
  return /Implement plan|Implement this plan|Yes, implement this plan|执行计划|执行此计划|实施计划|实施此计划|執行計劃|執行此計劃|實施計劃|實施此計劃|實行計劃|實行此計劃/i.test(
    snapshotHaystack(snapshot),
  );
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

function composerEditorScript(body) {
  return `(() => {
    function editorText(el) {
      return [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder"), el.innerText, el.value]
        .filter(Boolean)
        .join("\\n");
    }
    function isUsableEditor(el) {
      return !el.disabled && el.getAttribute("aria-disabled") !== "true";
    }
    function isVisibleEditor(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    }
    function isTerminalEditor(el) {
      return Boolean(el.closest("[data-codex-terminal], .xterm")) || /terminal input|terminal|终端|終端/i.test(editorText(el));
    }
    const editors = [...document.querySelectorAll("[contenteditable=true], textarea")]
      .filter((el) => isUsableEditor(el) && isVisibleEditor(el) && !isTerminalEditor(el));
    const composerEditors = editors.filter((el) =>
      Boolean(el.closest("[data-codex-composer]")) || /chatgpt|message|消息|撰写|撰寫|输入|輸入/i.test(editorText(el))
    );
    const editor = composerEditors.at(-1) || editors.at(-1) || null;
    ${body}
  })()`;
}

async function focusComposer(cdp) {
  return cdp.evaluate(composerEditorScript(`
    if (!editor) return false;
    editor.focus();
    return document.activeElement === editor || editor.contains(document.activeElement);
  `));
}

async function getComposerText(cdp) {
  return cdp.evaluate(composerEditorScript(`
    return editor ? (editor.innerText || editor.value || "") : "";
  `));
}

async function clearComposer(cdp) {
  if (!(await focusComposer(cdp))) fail("composer/editor could not be focused");
  await dispatchKey(cdp, "a", "KeyA", 65, 2);
  await dispatchKey(cdp, "Backspace", "Backspace", 8);
  await sleep(250);
}

async function insertComposerText(cdp, text, expectedSubstring = text) {
  await clearComposer(cdp);
  await cdp.send("Input.insertText", { text });
  await sleep(300);
  let inserted = await getComposerText(cdp);
  if (inserted.includes(expectedSubstring)) return;

  await cdp.evaluate(composerEditorScript(`
    if (!editor) return false;
    editor.focus();
    document.execCommand("insertText", false, ${JSON.stringify(text)});
    return true;
  `));
  await sleep(300);
  inserted = await getComposerText(cdp);
  if (!inserted.includes(expectedSubstring)) {
    const snapshot = await cdp.evaluate(snapshotExpression());
    fail(`composer/editor did not accept prompt input${formatSnapshotForFailure(snapshot)}`);
  }
}

async function submitComposer(cdp, marker) {
  if (!(await focusComposer(cdp))) fail("composer/editor could not be focused before submit");
  await dispatchKey(cdp, "Enter", "Enter", 13);
  await sleep(1_000);
  const text = await getComposerText(cdp);
  if (!text.includes(marker)) return;

  const clicked = await clickFirst(cdp, "send|submit|发送|提交|傳送|送出|arrow");
  if (!clicked) fail("composer prompt did not submit with Enter and send button was not found");
}

async function waitForSnapshot(cdp, deadline, label, predicate) {
  let snapshot = null;
  while (Date.now() <= deadline) {
    snapshot = await cdp.evaluate(snapshotExpression());
    if (predicate(snapshot)) return snapshot;
    await sleep(500);
  }
  fail(`${label} did not appear${formatSnapshotForFailure(snapshot)}`);
}

async function markerContexts(cdp, marker) {
  return cdp.evaluate(`(() => {
    const marker = ${JSON.stringify(marker)};
    const hits = [];
    const elements = [...document.body.querySelectorAll("*")].filter((el) => {
      const text = el.innerText || "";
      if (!text.includes(marker)) return false;
      return ![...el.children].some((child) => (child.innerText || "").includes(marker));
    });
    for (const element of elements.slice(0, 20)) {
      const chain = [];
      let current = element;
      for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) {
        chain.push({
          aria: current.getAttribute("aria-label") || "",
          className: typeof current.className === "string" ? current.className.slice(0, 400) : "",
          role: current.getAttribute("role") || "",
          tag: current.tagName,
          text: (current.innerText || "").slice(0, 2000),
          title: current.getAttribute("title") || ""
        });
      }
      hits.push(chain);
    }
    return hits;
  })()`);
}

function markerContextLooksLikePlanUi(contexts, marker = null) {
  return contexts.some((chain) =>
    chain.some((entry) => {
      const text = `${entry.aria}\n${entry.title}\n${entry.text}\n${entry.className}`;
      if (
        marker != null &&
        entry.text.includes(marker) &&
        !/请只拟定|計劃內容必須包含標識|计划内容必须包含标识|不要执行|不要執行|不要修改/.test(entry.text) &&
        /目标|目標|标识|標識|实施|實施|执行|執行|验证|驗證|step/i.test(entry.text)
      ) {
        return true;
      }
      return /Download plan|Open plan in side panel|Collapse plan summary|Expand plan summary|下载计划|在侧边面板中打开计划|折叠计划摘要|展开计划摘要|下載計劃|開啟.*計劃.*側邊|摺疊.*計劃|展開.*計劃|下载套餐|在侧边面板中打开套餐|下載套餐|開啟.*套餐.*側邊|执行此计划|实施此计划|執行此計劃|實施此計劃|proposed-plan|plan-summary/i.test(
        text,
      );
    }),
  );
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
  if (!detectPlanMode(before)) {
    console.log("  [skip] Plan mode control is not rendered in this UI state; plan-flow smoke validates it");
    await dispatchKey(cdp, "Tab", "Tab", 9, 8);
    await sleep(250);
    await dispatchKey(cdp, "Tab", "Tab", 9, 8);
    return;
  }
  const initial = detectActivePlanMode(before);
  await dispatchKey(cdp, "Tab", "Tab", 9, 8);

  let after = before;
  for (let i = 0; i < 12; i += 1) {
    await sleep(250);
    after = await cdp.evaluate(snapshotExpression());
    if (detectActivePlanMode(after) !== initial) break;
  }
  if (detectActivePlanMode(after) === initial) fail("Shift+Tab did not toggle Plan mode active state");

  await dispatchKey(cdp, "Tab", "Tab", 9, 8);
  for (let i = 0; i < 12; i += 1) {
    await sleep(250);
    after = await cdp.evaluate(snapshotExpression());
    if (detectActivePlanMode(after) === initial) return;
  }
  fail("Shift+Tab did not restore the original Plan mode state");
}

async function openNewThread(cdp) {
  await dispatchKey(cdp, "n", "KeyN", 78, 2);
  await sleep(1_000);
}

async function togglePlanModeShortcut(cdp) {
  const focused = await focusComposer(cdp);
  if (!focused) {
    await cdp.evaluate(`(() => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      document.body.focus();
      return true;
    })()`);
  }
  await dispatchKey(cdp, "Tab", "Tab", 9, 8);
  await sleep(500);
}

async function exercisePlanFlow(cdp, deadline) {
  await openNewThread(cdp);
  await togglePlanModeShortcut(cdp);

  const marker = `codex-plan-smoke-${Date.now()}`;
  const prompt = [
    "请只拟定一个两步计划，不要执行，不要修改文件。",
    `计划内容必须包含标识 ${marker}。`,
    "计划必须很短。",
  ].join("\n");
  await insertComposerText(cdp, prompt, marker);
  await submitComposer(cdp, marker);

  const planSnapshot = await waitForSnapshot(
    cdp,
    Math.min(deadline, deadlineFromNow(180_000)),
    "Plan summary and implementation request UI",
    (snapshot) => hasPlanSummaryUi(snapshot, marker) && hasImplementPlanRequest(snapshot),
  );
  if (hasRawProposedPlan(planSnapshot)) fail("raw <proposed_plan> tags are visible in the UI");

  const planContexts = await markerContexts(cdp, marker);
  if (!markerContextLooksLikePlanUi(planContexts, marker)) {
    fail(`Plan marker was visible, but not inside the dedicated Plan summary UI${formatSnapshotForFailure(planSnapshot)}`);
  }

  await togglePlanModeShortcut(cdp);

  const chatMarker = `codex-chat-smoke-${Date.now()}`;
  await insertComposerText(cdp, `请只回复 ${chatMarker}，不要拟定计划，不要执行任何操作。`, chatMarker);
  await submitComposer(cdp, chatMarker);
  const chatSnapshot = await waitForSnapshot(
    cdp,
    Math.min(deadline, deadlineFromNow(180_000)),
    "default-mode follow-up response after exiting Plan mode",
    (snapshot) => snapshotHaystack(snapshot).includes(chatMarker),
  );
  if (hasRawProposedPlan(chatSnapshot)) fail("raw <proposed_plan> tags appeared after exiting Plan mode");
  const chatContexts = await markerContexts(cdp, chatMarker);
  if (markerContextLooksLikePlanUi(chatContexts, chatMarker)) {
    fail("Shift+Tab did not exit Plan mode; follow-up response rendered as a Plan summary");
  }
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
    await openNewThread(cdp);
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
    if (mode === "plan-flow") {
      await exercisePlanFlow(cdp, deadline);
    }
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
  detectActivePlanMode,
  detectPlanMode,
  extractProposedPlan,
  formatSnapshotForFailure,
  redactLog,
  runSmoke,
  shouldCopyProfilePath,
};
