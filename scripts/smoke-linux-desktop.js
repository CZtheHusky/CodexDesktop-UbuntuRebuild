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
const { execFileSync, spawn } = require("child_process");
const {
  assertProfileSourcesUnchanged,
  copyDirIfPresent,
  createTempRoot,
  fingerprintProfileSources,
  shouldCopyProfilePath,
  sourcePaths,
} = require("./acceptance-profile");

const PROJECT_ROOT = path.join(__dirname, "..");
const VALID_MODES = new Set(["safe", "auth-clone", "auth-probe", "core", "plan-flow", "real"]);
const VALID_PLATFORMS = new Set(["linux-x64", "linux-arm64"]);
const DEFAULT_TIMEOUT_MS = 90_000;
const LOG_LIMIT = 256 * 1024;

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

function parseX11Windows(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.match(/^(0x[0-9a-f]+)\s+\S+\s+(\d+)\s+(\S+)\s+\S+\s+(.*)$/i))
    .filter(Boolean)
    .map((match) => ({ className: match[3], id: match[1], pid: Number(match[2]), title: match[4] }));
}

function listX11Windows() {
  try {
    return parseX11Windows(execFileSync("wmctrl", ["-lxp"], { encoding: "utf8", timeout: 2000 }));
  } catch {
    fail("native file picker automation requires wmctrl in an X11 desktop session");
  }
}

async function closeNativeFileDialog(existingWindowIds) {
  if (!process.env.DISPLAY) fail("native file picker automation requires an X11 DISPLAY");
  let dialog = null;
  const openDeadline = deadlineFromNow(10_000);
  while (Date.now() <= openDeadline) {
    const added = listX11Windows().filter((window) => !existingWindowIds.has(window.id));
    dialog = added.find((window) => /(^|\.)codex($|\.)/i.test(window.className)) ?? (added.length === 1 ? added[0] : null);
    if (dialog) break;
    await sleep(200);
  }
  if (!dialog) return false;

  const decimalWindowId = String(Number.parseInt(dialog.id, 16));
  execFileSync("xdotool", ["windowactivate", "--sync", decimalWindowId]);
  execFileSync("xdotool", ["key", "--clearmodifiers", "Escape"]);
  await sleep(500);
  return true;
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

function chromiumProxyServerForEnv(env) {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (!raw) return null;

  let proxy;
  try {
    proxy = new URL(raw);
  } catch {
    fail("Configured proxy URL is invalid");
  }
  if (proxy.username || proxy.password) fail("Authenticated proxy URLs cannot be exposed through Electron arguments");

  const protocol = proxy.protocol === "socks5h:" ? "socks5:" : proxy.protocol;
  if (!["http:", "https:", "socks:", "socks5:"].includes(protocol)) {
    fail(`Unsupported Electron proxy protocol ${proxy.protocol}`);
  }
  return `${protocol}//${proxy.host}`;
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

function createTempHome(prefix, tempRoot = os.tmpdir()) {
  const root = createTempRoot(prefix, tempRoot);
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
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    return {
      cleanup: () => {},
      env,
      home: os.homedir(),
      root: null,
    };
  }

  const profile = createTempHome(`codex-desktop-smoke-${mode}-`, options.tempRoot);
  const env = {
    ...process.env,
    CODEX_HOME: path.join(profile.home, ".codex"),
    HOME: profile.home,
    XDG_CONFIG_HOME: path.join(profile.home, ".config"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (chromiumProxyServerForEnv(env)) env.NODE_USE_ENV_PROXY = "1";

  let sourceFingerprints = {};
  if (mode === "auth-clone" || mode === "auth-probe" || mode === "core" || mode === "plan-flow") {
    const { codexHome: sourceCodex, userData: sourceUserData } = sourcePaths(options);
    sourceFingerprints = fingerprintProfileSources([
      path.join(sourceCodex, "auth.json"),
      path.join(sourceCodex, "config.toml"),
      path.join(sourceCodex, "installation_id"),
      path.join(sourceUserData, "Cookies"),
      path.join(sourceUserData, "Local State"),
      path.join(sourceUserData, "Preferences"),
    ]);
    const copiedCodex = copyDirIfPresent(sourceCodex, path.join(profile.home, ".codex"), "codex");
    const copiedUserData = copyDirIfPresent(
      sourceUserData,
      path.join(profile.home, ".config", "Codex"),
      "desktop",
    );
    if (!copiedCodex && !copiedUserData) {
      fail(`${mode} smoke could not find ~/.codex or ~/.config/Codex to clone`);
    }
  }

  return {
    cleanup: () => {
      assertProfileSourcesUnchanged(sourceFingerprints);
      if (!options.keepProfile) fs.rmSync(profile.root, { recursive: true, force: true });
      else console.log(`  [debug] kept smoke profile: ${profile.root}`);
    },
    env,
    home: profile.home,
    root: profile.root,
    sourceFingerprints,
  };
}

function createTestWorkspace(tempRoot = os.tmpdir()) {
  const root = createTempRoot("codex-desktop-acceptance-workspace-", tempRoot);
  const externalRoot = createTempRoot("codex-desktop-acceptance-external-", tempRoot);
  fs.chmodSync(root, 0o700);
  fs.chmodSync(externalRoot, 0o700);
  fs.writeFileSync(path.join(root, "seed.txt"), "seed-content\n", "utf8");
  fs.writeFileSync(path.join(root, "attachment.txt"), "attachment-content-marker\n", "utf8");
  fs.writeFileSync(
    path.join(root, "fixture.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  );
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "acceptance@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Codex Acceptance"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "acceptance fixture"]);
  return {
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(externalRoot, { recursive: true, force: true });
    },
    externalRoot,
    root,
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
    const listeners = new Map();

    function send(method, params = {}) {
      return new Promise((innerResolve, innerReject) => {
        const id = ++nextId;
        pending.set(id, { reject: innerReject, resolve: innerResolve });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
        return;
      }
      for (const listener of listeners.get(message.method) ?? []) listener(message.params ?? {});
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
        on: (method, listener) => {
          const values = listeners.get(method) ?? [];
          values.push(listener);
          listeners.set(method, values);
          return () => listeners.set(method, values.filter((value) => value !== listener));
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
    const controls = [...document.querySelectorAll("button,[role=button],[role=menuitem],[role=option],textarea,input,[contenteditable=true]")].map((el, index) => ({
      aria: el.getAttribute("aria-label") || "",
      ariaPressed: el.getAttribute("aria-pressed") || "",
      ariaSelected: el.getAttribute("aria-selected") || "",
      className: typeof el.className === "string" ? el.className.slice(0, 400) : "",
      dataSelected: el.getAttribute("data-selected") || "",
      dataState: el.getAttribute("data-state") || "",
      dataTestId: el.getAttribute("data-testid") || "",
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      index,
      placeholder: el.getAttribute("placeholder") || "",
      role: el.getAttribute("role") || "",
      tag: el.tagName,
      text: (el.innerText || el.value || "").trim().slice(0, 180),
      title: el.getAttribute("title") || "",
      type: el.getAttribute("type") || ""
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
  return `${control.aria}\n${control.title}\n${control.text}\n${control.placeholder}\n${control.dataTestId || ""}`;
}

function isDefaultApprovalControl(control) {
  return /(^|\n)(Ask for approval|Request approval|请求批准|請求批准)(\n|$)/i.test(controlHaystack(control));
}

function isApprovalAllowControl(control) {
  return /(^|\n)(Allow once|Run once|Approve once|允许一次|运行一次|允許一次|執行一次)(\n|$)/i.test(
    controlHaystack(control),
  );
}

function isApprovalDenyControl(control) {
  return /(^|\n)(Deny|Decline|Reject|拒绝|拒絕)(\n|$)/i.test(controlHaystack(control));
}

function safeArtifactName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function captureScreenshot(cdp, reportDir, label) {
  if (!reportDir) return null;
  const screenshots = path.join(reportDir, "screenshots");
  fs.mkdirSync(screenshots, { recursive: true, mode: 0o700 });
  const file = path.join(screenshots, `${safeArtifactName(label)}.png`);
  const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(file, Buffer.from(result.data, "base64"), { mode: 0o600 });
  return path.relative(reportDir, file);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function hasControl(snapshot, pattern) {
  return snapshot.controls.some((control) => pattern.test(controlHaystack(control)));
}

function snapshotHaystack(snapshot) {
  return `${snapshot.bodyText}\n${snapshot.controls.map(controlHaystack).join("\n")}`;
}

function isSettingsSurface(snapshot) {
  return hasControl(snapshot, /search settings|搜索设置|搜尋設定/i);
}

function occurrenceCount(text, value) {
  return String(text).split(value).length - 1;
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
    const controls = [...document.querySelectorAll("button,[role=button],[role=menuitem],[role=option]")];
    const target = controls.find((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      const enabled = !el.disabled && el.getAttribute("aria-disabled") !== "true";
      return visible && enabled && pattern.test([el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText].filter(Boolean).join("\\n"));
    });
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

async function pointerClickFirst(cdp, patternSource, flags = "i") {
  const point = await cdp.evaluate(`(() => {
    const pattern = new RegExp(${JSON.stringify(patternSource)}, ${JSON.stringify(flags)});
    const controls = [...document.querySelectorAll("button,[role=button],[role=menuitem],[role=option]")];
    const target = controls.find((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      const enabled = !el.disabled && el.getAttribute("aria-disabled") !== "true";
      return visible && enabled && pattern.test([el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText].filter(Boolean).join("\\n"));
    });
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) return false;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await cdp.send("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    clickCount: 1,
    type: "mousePressed",
    ...point,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 0,
    clickCount: 1,
    type: "mouseReleased",
    ...point,
  });
  return true;
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

function isLoadingSubmitBlock(snapshot) {
  return /unable to send message|cannot send message|无法发送消息|無法傳送訊息/i.test(snapshot.bodyText)
    && /\bloading\b|加载|載入/i.test(snapshot.bodyText);
}

async function submitComposer(cdp, marker, loadingDeadline = Date.now() + 30_000) {
  if (!(await focusComposer(cdp))) fail("composer/editor could not be focused before submit");
  await dispatchKey(cdp, "Enter", "Enter", 13);
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    const text = await getComposerText(cdp);
    if (!text.includes(marker)) return;
    const snapshot = await cdp.evaluate(snapshotExpression());
    if (/unable to send message|cannot send message|无法发送消息|無法傳送訊息/i.test(snapshot.bodyText)) {
      if (isLoadingSubmitBlock(snapshot) && Date.now() <= loadingDeadline) {
        const dismissed = await clickFirst(cdp, "^OK$|^确定$|^確定$");
        if (!dismissed) await pressEscape(cdp);
        await sleep(500);
        return submitComposer(cdp, marker, loadingDeadline);
      }
      fail(`message submission reached an error dialog${formatSnapshotForFailure(snapshot)}`);
    }
  }

  const clicked = await cdp.evaluate(composerEditorScript(`
    if (!editor) return false;
    let container = editor;
    for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
      const buttons = [...container.querySelectorAll("button,[role=button]")].filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !button.disabled && button.getAttribute("aria-disabled") !== "true";
      });
      if (buttons.length > 0) {
        const send = buttons.find((button) => /send|submit|发送|提交|傳送|送出/i.test([
          button.getAttribute("aria-label"),
          button.getAttribute("title"),
          button.innerText
        ].filter(Boolean).join("\\n"))) || buttons.at(-1);
        send.click();
        return true;
      }
    }
    return false;
  `));
  if (!clicked) {
    const snapshot = await cdp.evaluate(snapshotExpression());
    fail(`composer prompt did not submit and its send button was not found${formatSnapshotForFailure(snapshot)}`);
  }
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    if (!(await getComposerText(cdp)).includes(marker)) return;
    const snapshot = await cdp.evaluate(snapshotExpression());
    if (/unable to send message|cannot send message|无法发送消息|無法傳送訊息/i.test(snapshot.bodyText)) {
      if (isLoadingSubmitBlock(snapshot) && Date.now() <= loadingDeadline) {
        const dismissed = await clickFirst(cdp, "^OK$|^确定$|^確定$");
        if (!dismissed) await pressEscape(cdp);
        await sleep(500);
        return submitComposer(cdp, marker, loadingDeadline);
      }
      fail(`message submission reached an error dialog${formatSnapshotForFailure(snapshot)}`);
    }
  }
  const snapshot = await cdp.evaluate(snapshotExpression());
  fail(`composer prompt remained after submit${formatSnapshotForFailure(snapshot)}`);
}

async function waitForControl(cdp, pattern, deadline, label) {
  return waitForSnapshot(cdp, deadline, label, (snapshot) => hasControl(snapshot, pattern));
}

async function dropFilesOnComposer(cdp, files) {
  const point = await cdp.evaluate(composerEditorScript(`
    if (!editor) return null;
    const rect = editor.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  `));
  if (!point) fail("composer/editor drop target was unavailable");
  const data = {
    dragOperationsMask: 1,
    files,
    items: [{
      data: files.map((file) => `file://${file}`).join("\r\n"),
      mimeType: "text/uri-list",
    }],
  };
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await cdp.send("Input.dispatchDragEvent", { data, type, ...point });
  }
}

async function setFileInputFiles(cdp, files) {
  await cdp.send("DOM.enable");
  async function fileInputs() {
    const document = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    return cdp.send("DOM.querySelectorAll", {
      nodeId: document.root.nodeId,
      selector: 'input[type="file"]',
    });
  }

  async function openFilesAndFoldersAction() {
    const filesPattern = "files and folders|文件和文件夹|檔案和資料夾";
    const addPattern = "add files and more|add files|add photos|attach files|添加文件|添加照片|新增檔案|新增照片";
    let selected = await pointerClickFirst(cdp, filesPattern);
    for (let attempt = 0; !selected && attempt < 3; attempt += 1) {
      if (!(await pointerClickFirst(cdp, addPattern))) break;
      for (let poll = 0; !selected && poll < 10; poll += 1) {
        await sleep(100);
        selected = await pointerClickFirst(cdp, filesPattern);
      }
    }
    if (!selected) {
      const snapshot = await cdp.evaluate(snapshotExpression());
      fail(`files and folders attachment action was not found${formatSnapshotForFailure(snapshot)}`);
    }
    await sleep(500);
  }

  const existingWindowIds = new Set(listX11Windows().map((window) => window.id));
  let result = await fileInputs();
  if (result.nodeIds.length === 0) {
    const opened = await pointerClickFirst(
      cdp,
      "add files and more|add files|add photos|attach files|添加文件|添加照片|新增檔案|新增照片",
    );
    if (!opened) fail("attachment control was not found");
    await sleep(500);
    result = await fileInputs();
  }
  if (result.nodeIds.length === 0) {
    await openFilesAndFoldersAction();
    result = await fileInputs();
  }
  if (result.nodeIds.length === 0) {
    if (files.length !== 1) fail("native file picker automation selects one fixture at a time");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        await openFilesAndFoldersAction();
        result = await fileInputs();
        if (result.nodeIds.length > 0) break;
      }
      if (await closeNativeFileDialog(existingWindowIds)) {
        await dropFilesOnComposer(cdp, files);
        return;
      }
    }
    if (result.nodeIds.length === 0) fail("native file picker window did not appear after one retry");
  }
  await cdp.send("DOM.setFileInputFiles", {
    files,
    nodeId: result.nodeIds.at(-1),
  });
}

async function removeAttachment(cdp, filename) {
  return cdp.evaluate(`(() => {
    const filename = ${JSON.stringify(filename)};
    const removePattern = /remove|delete|clear|移除|删除|刪除/i;
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const label = (element) => [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.innerText,
    ].filter(Boolean).join("\\n");
    const controls = [...document.querySelectorAll("button,[role=button]")]
      .filter((element) => visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true");
    const direct = controls.find((element) => label(element).includes(filename) && removePattern.test(label(element)));
    if (direct) {
      direct.click();
      return true;
    }

    const leaves = [...document.body.querySelectorAll("*")].filter((element) => {
      if (!visible(element) || !(element.innerText || "").includes(filename)) return false;
      return ![...element.children].some((child) => (child.innerText || "").includes(filename));
    });
    for (const leaf of leaves) {
      let container = leaf;
      for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
        const remove = [...container.querySelectorAll("button,[role=button]")]
          .find((element) => visible(element) && removePattern.test(label(element)));
        if (remove) {
          remove.click();
          return true;
        }
      }
    }
    return false;
  })()`);
}

async function waitForFile(file, deadline, label) {
  while (Date.now() <= deadline) {
    if (fs.existsSync(file)) return;
    await sleep(250);
  }
  fail(`${label} was not created: ${file}`);
}

async function exerciseNormalChat(cdp, deadline) {
  await openNewThread(cdp);
  const marker = `codex-normal-chat-${Date.now()}`;
  await insertComposerText(cdp, `只回复 ${marker}，不要调用工具，不要拟定计划。`, marker);
  await submitComposer(cdp, marker);
  const snapshot = await waitForSnapshot(
    cdp,
    Math.min(deadline, deadlineFromNow(180_000)),
    "normal chat response",
    (value) => occurrenceCount(value.bodyText, marker) >= 2,
  );
  if (hasRawProposedPlan(snapshot)) fail("normal chat rendered raw proposed_plan markup");
  const contexts = await markerContexts(cdp, marker);
  if (markerContextLooksLikePlanUi(contexts, marker)) fail("normal chat response rendered in Plan UI");
  return marker;
}

async function exerciseAttachments(cdp, workspace, deadline) {
  await openNewThread(cdp);
  const textFile = path.join(workspace.root, "attachment.txt");
  const imageFile = path.join(workspace.root, "fixture.png");
  await setFileInputFiles(cdp, [textFile]);
  await waitForSnapshot(
    cdp,
    deadlineFromNow(10_000),
    "text attachment chip",
    (snapshot) => snapshotHaystack(snapshot).includes("attachment.txt"),
  );
  await setFileInputFiles(cdp, [imageFile]);
  await waitForSnapshot(
    cdp,
    deadlineFromNow(10_000),
    "text and image attachment chips",
    (snapshot) => snapshotHaystack(snapshot).includes("attachment.txt") && snapshotHaystack(snapshot).includes("fixture.png"),
  );
  if (!(await removeAttachment(cdp, "fixture.png"))) fail("image attachment remove action was not found");
  await waitForSnapshot(
    cdp,
    deadlineFromNow(10_000),
    "image attachment removal",
    (snapshot) => !snapshotHaystack(snapshot).includes("fixture.png") && snapshotHaystack(snapshot).includes("attachment.txt"),
  );
  await setFileInputFiles(cdp, [imageFile]);
  await waitForSnapshot(
    cdp,
    deadlineFromNow(10_000),
    "image attachment re-addition",
    (snapshot) => snapshotHaystack(snapshot).includes("attachment.txt") && snapshotHaystack(snapshot).includes("fixture.png"),
  );

  const marker = `attachment-observed-${Date.now()}`;
  const prompt = `读取所附 attachment.txt，只回复 attachment-content-marker 和 ${marker}。`;
  await insertComposerText(cdp, prompt, marker);
  await submitComposer(cdp, marker);
  await waitForSnapshot(
    cdp,
    Math.min(deadline, deadlineFromNow(180_000)),
    "attachment content response",
    (snapshot) =>
      occurrenceCount(snapshot.bodyText, marker) >= 2 &&
      occurrenceCount(snapshot.bodyText, "attachment-content-marker") >= 2,
  );
  return marker;
}

async function selectDefaultApprovals(cdp) {
  const current = await cdp.evaluate(snapshotExpression());
  if (current.controls.some(isDefaultApprovalControl)) return;

  const opened = await pointerClickFirst(
    cdp,
    "change permissions|ask for approval|request approval|full access|approve for me|更改权限|请求批准|完全访问|替我审批|變更權限|請求批准|完整存取",
  );
  if (!opened) fail("permissions dropdown was not found");
  await waitForSnapshot(
    cdp,
    deadlineFromNow(5_000),
    "default request-approval menu item",
    (snapshot) => snapshot.controls.some(isDefaultApprovalControl),
  );
  const selected = await pointerClickFirst(
    cdp,
    "(^|\\n)(Ask for approval|Request approval|请求批准|請求批准)(\\n|$)",
  );
  if (!selected) fail("default request-approval mode was not found");
  await waitForSnapshot(
    cdp,
    deadlineFromNow(5_000),
    "default request-approval mode",
    (snapshot) => snapshot.controls.some(isDefaultApprovalControl),
  );
}

async function exerciseApprovals(cdp, workspace, deadline) {
  await selectDefaultApprovals(cdp);

  const approvedFile = path.join(workspace.externalRoot, "approved.txt");
  const approvedMarker = `approved-command-${Date.now()}`;
  await openNewThread(cdp);
  const approvedPrompt = `必须使用 shell 运行 printf '${approvedMarker}\\n' > '${approvedFile}'，不要使用其他方式。`;
  await insertComposerText(cdp, approvedPrompt, approvedMarker);
  await submitComposer(cdp, approvedMarker);
  await waitForSnapshot(
    cdp,
    Math.min(deadline, deadlineFromNow(120_000)),
    "command approval request",
    (snapshot) => snapshot.controls.some(isApprovalAllowControl),
  );
  if (!(await pointerClickFirst(
    cdp,
    "(^|\\n)(Allow once|Run once|Approve once|允许一次|运行一次|允許一次|執行一次)(\\n|$)",
  ))) {
    fail("command approval could not be accepted");
  }
  await waitForFile(approvedFile, Math.min(deadline, deadlineFromNow(60_000)), "approved command output");
  if (fs.readFileSync(approvedFile, "utf8").trim() !== approvedMarker) fail("approved command output was incorrect");

  const deniedFile = path.join(workspace.externalRoot, "denied.txt");
  const deniedMarker = `denied-file-${Date.now()}`;
  await openNewThread(cdp);
  const deniedPrompt = `使用文件修改工具在 '${deniedFile}' 写入 ${deniedMarker}，不要使用 shell。`;
  await insertComposerText(cdp, deniedPrompt, deniedMarker);
  await submitComposer(cdp, deniedMarker);
  await waitForSnapshot(
    cdp,
    Math.min(deadline, deadlineFromNow(120_000)),
    "file approval request",
    (snapshot) => snapshot.controls.some(isApprovalDenyControl),
  );
  if (!(await pointerClickFirst(cdp, "(^|\\n)(Deny|Decline|Reject|拒绝|拒絕)(\\n|$)"))) {
    fail("file approval decline action was not found");
  }
  await waitForSnapshot(
    cdp,
    deadlineFromNow(10_000),
    "dismissed file approval request",
    (snapshot) => !snapshot.controls.some(isApprovalDenyControl),
  );
  if (fs.existsSync(deniedFile)) fail("declined file change was applied");
}

async function exerciseStop(cdp, workspace, deadline) {
  await openNewThread(cdp);
  const output = path.join(workspace.root, "cancelled-command.txt");
  const marker = `cancelled-command-${Date.now()}`;
  const prompt = `必须使用 shell 原样运行 sleep 15 && printf '${marker}\\n' > '${output}'。`;
  await insertComposerText(cdp, prompt, marker);
  await submitComposer(cdp, marker);
  await waitForControl(
    cdp,
    /stop|cancel|停止|取消|終止/i,
    Math.min(deadline, deadlineFromNow(90_000)),
    "running task stop control",
  );
  if (!(await clickFirst(cdp, "stop|cancel|停止|取消|終止"))) fail("running task could not be stopped");
  await sleep(16_000);
  if (fs.existsSync(output)) fail("cancelled command still wrote its completion marker");
}

async function exerciseTerminal(cdp, deadline) {
  const opened = await pointerClickFirst(
    cdp,
    "(^|\\n)(Toggle bottom panel|Open Terminal|Terminal|切换底部面板|打开终端|切換底部面板|開啟終端)(\\n|$)",
  );
  if (!opened) fail("terminal toggle was not found");
  const marker = `terminal-marker-${Date.now()}`;
  let focused = false;
  const inputDeadline = deadlineFromNow(10_000);
  while (!focused && Date.now() <= inputDeadline) {
    focused = await cdp.evaluate(`(() => {
      const input = document.querySelector(".xterm-helper-textarea, .xterm textarea, [data-codex-terminal] textarea");
      if (!input) return false;
      input.focus();
      return document.activeElement === input;
    })()`);
    if (!focused) await sleep(250);
  }
  if (!focused) fail("terminal input was not available");
  await cdp.send("Input.insertText", { text: `printf '${marker}\\n'` });
  await dispatchKey(cdp, "Enter", "Enter", 13);
  await waitForSnapshot(
    cdp,
    Math.min(deadline, deadlineFromNow(30_000)),
    "terminal command output",
    (snapshot) => snapshotHaystack(snapshot).includes(marker),
  );
  if (!(await pointerClickFirst(
    cdp,
    "(^|\\n)(Toggle bottom panel|Terminal|切换底部面板|终端|切換底部面板|終端)(\\n|$)",
  ))) {
    fail("terminal could not be closed");
  }
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

async function waitForTurnCompletion(cdp, deadline, label) {
  let snapshot = null;
  while (Date.now() <= deadline) {
    snapshot = await cdp.evaluate(snapshotExpression());
    if (snapshot.controls.some(isApprovalAllowControl)) {
      if (!(await pointerClickFirst(
        cdp,
        "(^|\\n)(Allow once|Run once|Approve once|允许一次|运行一次|允許一次|執行一次)(\\n|$)",
      ))) {
        fail(`${label} approval could not be accepted`);
      }
      await sleep(500);
      continue;
    }
    const running = snapshot.controls.some((control) =>
      /(^|\n)(Steer|Stop|Cancel|指导|停止|取消|引導|終止)(\n|$)/i.test(controlHaystack(control))
    );
    if (!running && snapshot.editableCount > 0) return snapshot;
    await sleep(500);
  }
  fail(`${label} did not finish${formatSnapshotForFailure(snapshot)}`);
}

async function currentConversationTitle(cdp) {
  return cdp.evaluate(`(() => {
    const actions = [...document.querySelectorAll("button,[role=button]")].find((element) =>
      /task actions|任务操作|任務操作/i.test([
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.innerText,
      ].filter(Boolean).join("\\n"))
    );
    let current = actions?.parentElement ?? null;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      const lines = (current.innerText || "").split(/\\n/).map((line) => line.trim()).filter(Boolean);
      const title = lines.find((line) =>
        line.length <= 180 && !/^(task actions|open in|任务操作|任務操作|打开方式|開啟方式)$/i.test(line)
      );
      if (title) return title;
    }
    return null;
  })()`);
}

async function openConversationFromSearch(cdp, title, deadline) {
  if (!(await pointerClickFirst(cdp, "(^|\\n)(Search|搜索|搜尋)(\\n|$)"))) {
    fail("global task search was not found after restart");
  }
  await waitForSnapshot(
    cdp,
    Math.min(deadline, deadlineFromNow(10_000)),
    "global task search input",
    (snapshot) => snapshot.editableCount > 0 && /search tasks|search tasks or run a command|搜索任务|搜尋任務/i.test(
      snapshotHaystack(snapshot),
    ),
  );
  const focused = await cdp.evaluate(`(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const editors = [...document.querySelectorAll("input,textarea,[contenteditable=true]")].filter(visible);
    const editor = editors.find((element) => /search tasks|search tasks or run a command|搜索任务|搜尋任務/i.test(
      element.getAttribute("placeholder") || element.getAttribute("aria-label") || ""
    )) ?? editors.at(-1);
    if (!editor) return false;
    editor.focus();
    return document.activeElement === editor;
  })()`);
  if (!focused) fail("global task search input could not be focused");
  await dispatchKey(cdp, "a", "KeyA", 65, 2);
  await cdp.send("Input.insertText", { text: title });
  await waitForSnapshot(
    cdp,
    Math.min(deadline, deadlineFromNow(30_000)),
    "persisted task search result",
    (snapshot) => snapshot.bodyText.includes(title),
  );
  await dispatchKey(cdp, "Enter", "Enter", 13);
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

async function closeSettings(cdp, snapshot) {
  if (!(await pointerClickFirst(cdp, "^Back(?:\\n|$)|back to app|返回应用|返回應用"))) {
    fail(`settings back control was not found${formatSnapshotForFailure(snapshot)}`);
  }
  await waitForSnapshot(
    cdp,
    deadlineFromNow(10_000),
    "main app after closing settings",
    (value) => !isSettingsSurface(value) && value.editableCount >= 1,
  );
}

async function exerciseSettings(cdp) {
  await dispatchKey(cdp, ",", "Comma", 188, 2);
  for (let i = 0; i < 8; i += 1) {
    await sleep(250);
    const snapshot = await cdp.evaluate(snapshotExpression());
    if (isSettingsSurface(snapshot)) {
      await closeSettings(cdp, snapshot);
      return;
    }
  }

  let opened = await pointerClickFirst(cdp, "settings|设置|設定");
  if (!opened) {
    opened = await pointerClickFirst(cdp, "profile|account|个人资料|個人資料|账户|帳戶|打开个人|開啟個人");
  }
  if (!opened) {
    const snapshot = await cdp.evaluate(snapshotExpression());
    fail(`profile/settings menu control was not found${formatSnapshotForFailure(snapshot)}`);
  }
  await sleep(300);
  if (!(await pointerClickFirst(cdp, "settings|设置|設定"))) {
    const snapshot = await cdp.evaluate(snapshotExpression());
    fail(`settings action was not found in the profile menu${formatSnapshotForFailure(snapshot)}`);
  }
  const snapshot = await waitForSnapshot(
    cdp,
    deadlineFromNow(10_000),
    "settings surface",
    (value) => isSettingsSurface(value),
  );
  await closeSettings(cdp, snapshot);
}

async function exerciseModelPicker(cdp) {
  const pickerPattern = "select model|model picker|model|\\b\\d+\\.\\d+\\b|sol|选择模型|模型|選擇模型";
  if (!(await pointerClickFirst(cdp, pickerPattern))) fail("model picker control was not found");
  const snapshot = await waitForSnapshot(
    cdp,
    deadlineFromNow(5_000),
    "model picker menu",
    (value) => /model|模型/i.test(snapshotHaystack(value)) && /speed|速度/i.test(snapshotHaystack(value)),
  );
  if (!/reasoning|effort|推理|思考|low|medium|high|低|中|高|极高|極高/i.test(snapshotHaystack(snapshot))) {
    fail(`reasoning effort control was not found in the model picker${formatSnapshotForFailure(snapshot)}`);
  }
  if (!(await pointerClickFirst(cdp, "speed|速度"))) fail("speed control was not found in the model picker");
  await waitForSnapshot(
    cdp,
    deadlineFromNow(5_000),
    "Fast mode option",
    (value) => /fast|快速/i.test(snapshotHaystack(value)),
  );
  await pressEscape(cdp);
  await pressEscape(cdp);
}

async function exerciseToggle(cdp, patternSource, label) {
  if (!(await clickFirst(cdp, patternSource))) fail(`${label} control was not found`);
  await sleep(300);
  if (!(await clickFirst(cdp, patternSource))) fail(`${label} control could not restore its initial state`);
  await sleep(300);
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

async function exercisePlanShortcut(cdp, required = false) {
  await cdp.evaluate(`(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const button = document.querySelector("button,[role=button]");
    if (button && button.focus) button.focus();
    return true;
  })()`);
  const before = await cdp.evaluate(snapshotExpression());
  const hadPlanControl = detectPlanMode(before);
  if (!hadPlanControl && !required) {
    console.log("  [info] Plan mode control is not rendered in this UI state; dedicated Plan flow will validate it");
    await dispatchKey(cdp, "Tab", "Tab", 9, 8);
    await sleep(250);
    await dispatchKey(cdp, "Tab", "Tab", 9, 8);
    return;
  }
  const initial = hadPlanControl ? detectActivePlanMode(before) : false;
  await dispatchKey(cdp, "Tab", "Tab", 9, 8);

  let after = before;
  for (let i = 0; i < 12; i += 1) {
    await sleep(250);
    after = await cdp.evaluate(snapshotExpression());
    if (detectActivePlanMode(after) !== initial || (!initial && detectPlanMode(after))) break;
  }
  if (detectActivePlanMode(after) === initial && !(!initial && detectPlanMode(after))) {
    fail("Shift+Tab did not toggle Plan mode active state");
  }
  const activationDetectedByPresence = !initial && !detectActivePlanMode(after) && detectPlanMode(after);

  await dispatchKey(cdp, "Tab", "Tab", 9, 8);
  for (let i = 0; i < 12; i += 1) {
    await sleep(250);
    after = await cdp.evaluate(snapshotExpression());
    if (activationDetectedByPresence ? !detectPlanMode(after) : detectActivePlanMode(after) === initial) return;
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

async function exercisePlanFlow(cdp, deadline, workspace = null) {
  await openNewThread(cdp);
  await togglePlanModeShortcut(cdp);

  const marker = `codex-plan-smoke-${Date.now()}`;
  const implementationMarker = `codex-plan-implemented-${Date.now()}`;
  const implementationFile = workspace ? path.join(workspace.root, "plan-result.txt") : null;
  const prompt = [
    "请只拟定一个两步计划，不要执行，不要修改文件。",
    `计划内容必须包含标识 ${marker}。`,
    implementationFile
      ? `计划在用户选择执行后，必须在 ${implementationFile} 写入 ${implementationMarker}。`
      : "计划必须包含一个可以执行的验证步骤。",
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

  if (planSnapshot.editableCount < 1) fail("Plan completion UI does not allow additional user input");
  const revisionMarker = `codex-plan-revision-${Date.now()}`;
  await insertComposerText(
    cdp,
    `补充信息：请更新计划并在计划内容中加入 ${revisionMarker}，仍然不要执行。`,
    revisionMarker,
  );
  await submitComposer(cdp, revisionMarker);
  await waitForSnapshot(
    cdp,
    Math.min(deadline, deadlineFromNow(180_000)),
    "revised Plan summary and implementation request UI",
    (snapshot) => hasPlanSummaryUi(snapshot, revisionMarker) && hasImplementPlanRequest(snapshot),
  );

  if (workspace) {
    const implemented = await clickFirst(
      cdp,
      "implement this plan|implement plan|yes, implement|执行此计划|执行计划|实施此计划|实施计划|執行此計劃|執行計劃|實施此計劃",
    );
    if (!implemented) fail("Plan implementation action was not found");
    const implementationDeadline = Math.min(deadline, deadlineFromNow(180_000));
    let implementationSnapshot = null;
    while (!fs.existsSync(implementationFile) && Date.now() <= implementationDeadline) {
      implementationSnapshot = await cdp.evaluate(snapshotExpression());
      if (implementationSnapshot.controls.some(isApprovalAllowControl)) break;
      await sleep(500);
    }
    if (!fs.existsSync(implementationFile)) {
      if (!implementationSnapshot?.controls.some(isApprovalAllowControl)) {
        fail(`Plan implementation did not create output or request approval${formatSnapshotForFailure(implementationSnapshot)}`);
      }
      if (!(await pointerClickFirst(
        cdp,
        "(^|\\n)(Allow once|Run once|Approve once|允许一次|运行一次|允許一次|執行一次)(\\n|$)",
      ))) {
        fail("Plan implementation approval could not be accepted");
      }
    }
    await waitForFile(
      implementationFile,
      implementationDeadline,
      "Plan implementation output",
    );
    if (fs.readFileSync(implementationFile, "utf8").trim() !== implementationMarker) {
      fail("Plan implementation output was incorrect");
    }
    await waitForTurnCompletion(
      cdp,
      Math.min(deadline, deadlineFromNow(180_000)),
      "Plan implementation turn",
    );
  }

  const beforeExit = await cdp.evaluate(snapshotExpression());
  if (detectActivePlanMode(beforeExit)) await togglePlanModeShortcut(cdp);

  const chatMarker = `codex-chat-smoke-${Date.now()}`;
  await insertComposerText(cdp, `请只回复 ${chatMarker}，不要拟定计划，不要执行任何操作。`, chatMarker);
  await submitComposer(cdp, chatMarker);
  const chatSnapshot = await waitForSnapshot(
    cdp,
    Math.min(deadline, deadlineFromNow(180_000)),
    "default-mode follow-up response after exiting Plan mode",
    (snapshot) => occurrenceCount(snapshot.bodyText, chatMarker) >= 2,
  );
  if (hasRawProposedPlan(chatSnapshot)) fail("raw <proposed_plan> tags appeared after exiting Plan mode");
  const chatContexts = await markerContexts(cdp, chatMarker);
  if (markerContextLooksLikePlanUi(chatContexts, chatMarker)) {
    fail("Shift+Tab did not exit Plan mode; follow-up response rendered as a Plan summary");
  }
  return chatMarker;
}

async function exerciseCoreUi(cdp, mode) {
  const snapshot = await waitForUiSnapshot(cdp, mode, deadlineFromNow(30_000));
  if (!snapshot) fail("UI snapshot was unavailable");
  assertCoreUi(snapshot, mode);
  if (mode === "safe") return;

  if (!hasControl(snapshot, /sidebar|侧边栏|側邊欄/i)) fail("sidebar toggle control was not found");

  if (mode === "core") await openNewThread(cdp);
  await exerciseComposerDraft(cdp);
  await exercisePlanShortcut(cdp, mode === "core");
  await exerciseToggle(cdp, "sidebar|侧边栏|側邊欄", "sidebar toggle");
  if (hasControl(await cdp.evaluate(snapshotExpression()), /bottom panel|底部面板|下方面板/i)) {
    await exerciseToggle(cdp, "bottom panel|底部面板|下方面板", "bottom panel toggle");
  } else if (mode === "core") {
    fail("bottom panel toggle is not rendered in the required core UI state");
  } else {
    console.log("  [info] bottom panel toggle is not rendered in this UI state");
  }
  await exerciseMenu(cdp, "project|项目|專案", "project/menu");
  await exerciseMenu(cdp, "approval|approve|审批|審批|替我审批", "approval menu");

  if (mode === "core") {
    await exerciseSettings(cdp);
    await waitForControl(
      cdp,
      /select model|model picker|model|\b\d+\.\d+\b|sol|选择模型|模型|選擇模型/i,
      deadlineFromNow(10_000),
      "model picker after closing settings",
    );
    await exerciseModelPicker(cdp);
  }

  if (mode !== "real" && mode !== "core") {
    await openNewThread(cdp);
    await dispatchKey(cdp, "n", "KeyN", 78, 3);
    await sleep(500);
  }
}

async function exerciseCoreFlow(cdp, workspace, deadline, runStep = async (_name, action) => action()) {
  const initial = await cdp.evaluate(snapshotExpression());
  if (!snapshotHaystack(initial).includes(path.basename(workspace.root))) {
    fail(`opened project does not show workspace ${path.basename(workspace.root)}`);
  }
  await runStep("normal-chat", () => exerciseNormalChat(cdp, deadline));
  await runStep("attachments", () => exerciseAttachments(cdp, workspace, deadline));
  await runStep("approvals", () => exerciseApprovals(cdp, workspace, deadline));
  await runStep("terminal", () => exerciseTerminal(cdp, deadline));
  await runStep("stop-cancel", () => exerciseStop(cdp, workspace, deadline));
  const persistenceMarker = await runStep("plan-flow", () => exercisePlanFlow(cdp, deadline, workspace));
  return { persistenceMarker };
}

async function runSmoke(options) {
  const mode = options.mode || "safe";
  const platform = options.platform || "linux-x64";
  if (!VALID_MODES.has(mode)) fail(`Unsupported --mode ${mode}`);
  if (!VALID_PLATFORMS.has(platform)) fail(`Unsupported --platform ${platform}`);

  const appPath = options.appPath || appPathForPlatform(platform);
  if (!fs.existsSync(appPath)) fail(`Missing app executable ${rel(appPath)}; run npm run build first`);

  const timeoutMs = options.timeoutMs || (mode === "core" ? 15 * 60_000 : DEFAULT_TIMEOUT_MS);
  const deadline = deadlineFromNow(timeoutMs);
  const profile = createProfile(mode, {
    keepProfile: options.keepProfile,
    sourceCodexHome: options.sourceCodexHome,
    sourceUserData: options.sourceUserData,
    tempRoot: options.tempRoot,
  });
  const workspace = mode === "core" || mode === "auth-probe"
    ? createTestWorkspace(options.tempRoot)
    : null;
  const reportDir = options.reportDir ? path.resolve(options.reportDir) : null;
  const report = {
    appPath,
    finishedAt: null,
    mode,
    platform,
    runId: options.runId || `smoke-${Date.now()}`,
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    status: "running",
    steps: [],
  };
  let combinedLogs = "";
  let current = null;
  let failure = null;

  async function launch() {
    const port = current == null && options.port ? options.port : await findFreePort();
    const logs = createLogMonitor();
    let child = null;
    let cdp = null;
    try {
      console.log(`-- smoke-linux-desktop: ${mode} (${platform}, port ${port})`);
      const args = ["--no-sandbox", "--password-store=basic", `--remote-debugging-port=${port}`];
      const proxyServer = chromiumProxyServerForEnv(profile.env);
      if (proxyServer) args.push(`--proxy-server=${proxyServer}`);
      if (workspace) args.push("--open-project", workspace.root);
      child = spawn(appPath, args, {
        cwd: workspace?.root || PROJECT_ROOT,
        detached: true,
        env: profile.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", logs.push);
      child.stderr.on("data", logs.push);
      child.on("exit", (code, signal) => logs.push(`\n[smoke] app exited code=${code} signal=${signal}\n`));

      const target = await waitForCdpTarget(port, deadline);
      cdp = await connectCdp(target.webSocketDebuggerUrl);
      await cdp.send("Runtime.enable");
      await cdp.send("Page.enable");
      await cdp.send("Page.bringToFront");
      try {
        const { windowId } = await cdp.send("Browser.getWindowForTarget");
        await cdp.send("Browser.setWindowBounds", {
          bounds: { height: 1000, left: 20, top: 20, width: 1440, windowState: "normal" },
          windowId,
        });
      } catch {
        // Window sizing is evidence stabilization; the UI assertions remain authoritative.
      }
      await waitForLog(logs, /window ready-to-show/, deadline, "main window ready-to-show");
      await waitForLog(logs, /initialize_handshake_result[^\n]*outcome=success/, deadline, "app-server handshake");
      logs.assertNoFatal();
      return { cdp, child, logs };
    } catch (error) {
      if (cdp) cdp.close();
      if (child) await stopProcess(child);
      combinedLogs += logs.text();
      throw error;
    }
  }

  async function closeCurrent() {
    if (!current) return;
    if (current.cdp) current.cdp.close();
    if (current.child) await stopProcess(current.child);
    combinedLogs += current.logs.text();
    current = null;
  }

  async function runStep(name, action) {
    const step = { durationMs: null, evidence: [], name, startedAt: new Date().toISOString(), status: "running" };
    const started = Date.now();
    report.steps.push(step);
    try {
      const result = await action();
      if (current?.cdp && reportDir) {
        const screenshot = await captureScreenshot(current.cdp, reportDir, `${report.steps.length}-${name}`);
        if (screenshot) step.evidence.push(screenshot);
      }
      step.status = "passed";
      return result;
    } catch (error) {
      step.status = "failed";
      step.error = redactLog(error.message);
      if (current?.cdp && reportDir) {
        try {
          const screenshot = await captureScreenshot(current.cdp, reportDir, `${report.steps.length}-${name}-failed`);
          if (screenshot) step.evidence.push(screenshot);
        } catch {}
      }
      throw error;
    } finally {
      step.durationMs = Date.now() - started;
    }
  }

  try {
    await runStep("startup", async () => {
      current = await launch();
    });
    await runStep("core-ui", async () => {
      if (mode !== "auth-probe") return exerciseCoreUi(current.cdp, mode);
      const snapshot = await waitForUiSnapshot(current.cdp, mode, deadlineFromNow(30_000));
      if (!snapshot) fail("authenticated probe UI snapshot was unavailable");
      assertCoreUi(snapshot, mode);
    });

    if (mode === "auth-probe") await runStep("normal-chat", () => exerciseNormalChat(current.cdp, deadline));
    if (mode === "plan-flow") await runStep("plan-flow", () => exercisePlanFlow(current.cdp, deadline));
    if (mode === "core") {
      const { persistenceMarker } = await exerciseCoreFlow(current.cdp, workspace, deadline, runStep);
      await runStep("conversation-restart", async () => {
        const conversationTitle = await currentConversationTitle(current.cdp);
        if (!conversationTitle) fail("test conversation title could not be read before restart");
        await closeCurrent();
        current = await launch();
        const snapshot = await waitForUiSnapshot(current.cdp, mode, deadlineFromNow(30_000));
        assertCoreUi(snapshot, mode);
        if (!snapshot.bodyText.includes(persistenceMarker)) {
          await openConversationFromSearch(current.cdp, conversationTitle, deadline);
        }
        await waitForSnapshot(
          current.cdp,
          Math.min(deadline, deadlineFromNow(60_000)),
          "restored test conversation",
          (value) => value.bodyText.includes(persistenceMarker),
        );
      });
    }
    current.logs.assertNoFatal();
    report.status = "passed";
    console.log(`  [ok] ${mode} smoke passed`);
  } catch (error) {
    failure = error;
    report.status = "failed";
    report.error = redactLog(error.message);
  } finally {
    await closeCurrent();
    if (reportDir) {
      fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(reportDir, "app.log"), redactLog(combinedLogs), { mode: 0o600 });
    }
    for (const cleanup of [() => profile.cleanup(), () => workspace?.cleanup()]) {
      try {
        cleanup();
      } catch (error) {
        if (!failure) failure = error;
        report.status = "failed";
        report.error = redactLog(error.message);
      }
    }
    report.finishedAt = new Date().toISOString();
    if (reportDir) writeJson(path.join(reportDir, "smoke-report.json"), report);
  }

  if (failure) {
    const excerpt = combinedLogs ? `\n--- recent app log ---\n${redactLog(combinedLogs).slice(-8000)}` : "";
    failure.message = `${failure.message}${excerpt}`;
    throw failure;
  }
  return report;
}

async function main() {
  const mode = argValue("--mode", "safe");
  const timeoutArg = argValue("--timeout-ms", null);
  await runSmoke({
    appPath: argValue("--app", null),
    keepProfile: hasFlag("--keep-profile"),
    mode,
    platform: argValue("--platform", "linux-x64"),
    port: Number(argValue("--port", "0")) || null,
    reportDir: argValue("--report-dir", null),
    runId: argValue("--run-id", null),
    sourceCodexHome: argValue("--source-codex-home", null),
    sourceUserData: argValue("--source-user-data", null),
    tempRoot: argValue("--temp-root", null),
    timeoutMs: timeoutArg == null ? null : Number(timeoutArg),
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
  chromiumProxyServerForEnv,
  controlHaystack,
  createLogMonitor,
  createProfile,
  createTestWorkspace,
  detectActivePlanMode,
  detectPlanMode,
  extractProposedPlan,
  formatSnapshotForFailure,
  fingerprintProfileSources,
  isApprovalAllowControl,
  isApprovalDenyControl,
  isLoadingSubmitBlock,
  isDefaultApprovalControl,
  isSettingsSurface,
  occurrenceCount,
  parseX11Windows,
  redactLog,
  runSmoke,
  shouldCopyProfilePath,
  writeJson,
};
