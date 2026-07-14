#!/usr/bin/env node
/**
 * Linux-only runtime patch applied after prepare-src.js.
 *
 * The Linux build is assembled from the macOS app resources, then packed from
 * flat src/. Keep these changes in a script so rebuilt bundles get the same
 * fixes without committing generated bundle output.
 */
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const BUILD_DIR = path.join(PROJECT_ROOT, "src", ".vite", "build");
const WEBVIEW_ASSETS_DIR = path.join(PROJECT_ROOT, "src", "webview", "assets");
const NATIVE_STATE_DB_SIDEBAR_SNIPPET = "a==null?null:{hasLiveConversation:!1,summary:a}";
const NATIVE_SIDEBAR_AGGREGATION_SNIPPET =
  "{allProjectGroups:w,allSidebarItems:T}=h(sE,{canStartProjectlessChat:o,localProjectActionsEnabled:l})";
const PLAN_MODE_COMMAND_WITHOUT_KEYBINDING =
  "{id:`composer.togglePlanMode`,titleIntlId:`codex.command.composer.togglePlanMode`,descriptionIntlId:`codex.commandDescription.composer.togglePlanMode`,shortcutScope:`app`}";
const PLAN_MODE_COMMAND_WITH_BROKEN_SHIFT_TAB =
  "{id:`composer.togglePlanMode`,titleIntlId:`codex.command.composer.togglePlanMode`,descriptionIntlId:`codex.commandDescription.composer.togglePlanMode`,shortcutScope:`app`,electron:{defaultKeybindings:[{key:`Shift+Tab`]}}}";
const PLAN_MODE_COMMAND_WITH_SHIFT_TAB =
  "{id:`composer.togglePlanMode`,titleIntlId:`codex.command.composer.togglePlanMode`,descriptionIntlId:`codex.commandDescription.composer.togglePlanMode`,shortcutScope:`app`,electron:{defaultKeybindings:[{key:`Shift+Tab`}]}}";

function fail(message) {
  console.error(`[x] ${message}`);
  process.exit(1);
}

function findMainBundle() {
  if (!fs.existsSync(BUILD_DIR)) fail(`Missing build dir: ${path.relative(PROJECT_ROOT, BUILD_DIR)}`);

  const candidates = fs
    .readdirSync(BUILD_DIR)
    .filter((name) => /^main(?:-[\w-]+)?\.js$/.test(name))
    .map((name) => path.join(BUILD_DIR, name));

  for (const file of candidates) {
    const code = fs.readFileSync(file, "utf8");
    if (code.includes("function Je(") && code.includes("threadCatalogSyncManager")) return file;
  }

  fail("Could not locate Linux main bundle");
}

function findOpenInWorkerBundle() {
  if (!fs.existsSync(BUILD_DIR)) fail(`Missing build dir: ${path.relative(PROJECT_ROOT, BUILD_DIR)}`);

  const candidates = fs
    .readdirSync(BUILD_DIR)
    .filter((name) => /^worker(?:-[\w-]+)?\.js$/.test(name))
    .map((name) => path.join(BUILD_DIR, name));

  for (const file of candidates) {
    const code = fs.readFileSync(file, "utf8");
    if (
      code.includes("get-target-command") &&
      code.includes("Unknown open target") &&
      code.includes("id:`fileManager`")
    ) {
      return file;
    }
  }

  fail("Could not locate Linux open-in worker bundle");
}

function findWebviewAppBundle() {
  if (!fs.existsSync(WEBVIEW_ASSETS_DIR)) {
    fail(`Missing webview assets dir: ${path.relative(PROJECT_ROOT, WEBVIEW_ASSETS_DIR)}`);
  }

  const candidates = fs
    .readdirSync(WEBVIEW_ASSETS_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(WEBVIEW_ASSETS_DIR, name));

  for (const file of candidates) {
    const code = fs.readFileSync(file, "utf8");
    if (
      (code.includes("function KMe(") || code.includes("function Wge(")) &&
      code.includes("localThreadCatalog") &&
      code.includes("567837310")
    ) {
      return file;
    }
  }

  fail("Could not locate Linux webview app bundle");
}

function findSidebarStateBundle() {
  if (!fs.existsSync(WEBVIEW_ASSETS_DIR)) {
    fail(`Missing webview assets dir: ${path.relative(PROJECT_ROOT, WEBVIEW_ASSETS_DIR)}`);
  }

  const candidates = fs
    .readdirSync(WEBVIEW_ASSETS_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(WEBVIEW_ASSETS_DIR, name));

  for (const file of candidates) {
    const code = fs.readFileSync(file, "utf8");
    if (
      (code.includes("3314958849") && code.includes("hasLiveConversation:!1,summary:n")) ||
      (code.includes("SO=tr(") && code.includes("hasLiveConversation:!1,summary:a")) ||
      code.includes(NATIVE_STATE_DB_SIDEBAR_SNIPPET)
    ) {
      return file;
    }
  }

  fail("Could not locate Linux sidebar state bundle");
}

function findThreadStoreBundle() {
  if (!fs.existsSync(WEBVIEW_ASSETS_DIR)) {
    fail(`Missing webview assets dir: ${path.relative(PROJECT_ROOT, WEBVIEW_ASSETS_DIR)}`);
  }

  const candidates = fs
    .readdirSync(WEBVIEW_ASSETS_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(WEBVIEW_ASSETS_DIR, name));

  for (const file of candidates) {
    const code = fs.readFileSync(file, "utf8");
    if (
      code.includes("async runRecentConversationRefresh") &&
      code.includes("async listRecentThreads") &&
      code.includes("mergeRecentThreadSummaries")
    ) {
      return file;
    }
  }

  fail("Could not locate Linux thread store bundle");
}

function findSidebarAggregationBundle() {
  if (!fs.existsSync(WEBVIEW_ASSETS_DIR)) {
    fail(`Missing webview assets dir: ${path.relative(PROJECT_ROOT, WEBVIEW_ASSETS_DIR)}`);
  }

  const candidates = fs
    .readdirSync(WEBVIEW_ASSETS_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(WEBVIEW_ASSETS_DIR, name));

  for (const file of candidates) {
    const code = fs.readFileSync(file, "utf8");
    if (
      (code.includes("visibleRecentChatItems:L") &&
        code.includes("visibleSidebarSectionKeys:ne") &&
        code.includes("let L=r?")) ||
      (code.includes("visibleRecentChatItems:U") &&
        code.includes("visibleSidebarSectionKeys:Z") &&
        code.includes("let U=i?H:[]")) ||
      code.includes(NATIVE_SIDEBAR_AGGREGATION_SNIPPET)
    ) {
      return file;
    }
  }

  fail("Could not locate Linux sidebar aggregation bundle");
}

function findSidebarProjectGroupsBundle() {
  if (!fs.existsSync(WEBVIEW_ASSETS_DIR)) {
    fail(`Missing webview assets dir: ${path.relative(PROJECT_ROOT, WEBVIEW_ASSETS_DIR)}`);
  }

  const candidates = fs
    .readdirSync(WEBVIEW_ASSETS_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(WEBVIEW_ASSETS_DIR, name));

  for (const file of candidates) {
    const code = fs.readFileSync(file, "utf8");
    if (
      code.includes("sidebar_workspace_task_groups_task_dirs") &&
      (
        (code.includes("function Gr(") && code.includes("function Kr(") && code.includes("function Yr(")) ||
        (code.includes("Lhe(") && code.includes("PROJECT_ORDER"))
      )
    ) {
      return file;
    }
  }

  fail("Could not locate Linux sidebar project groups bundle");
}

function findPlanModeCommandBundles() {
  const dirs = [BUILD_DIR, WEBVIEW_ASSETS_DIR];
  const bundles = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) fail(`Missing bundle dir: ${path.relative(PROJECT_ROOT, dir)}`);

    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".js")) continue;

      const file = path.join(dir, name);
      const code = fs.readFileSync(file, "utf8");
      if (
        code.includes(PLAN_MODE_COMMAND_WITHOUT_KEYBINDING) ||
        code.includes(PLAN_MODE_COMMAND_WITH_BROKEN_SHIFT_TAB) ||
        code.includes(PLAN_MODE_COMMAND_WITH_SHIFT_TAB)
      ) {
        bundles.push(file);
      }
    }
  }

  if (bundles.length === 0) fail("Could not locate composer.togglePlanMode command bundles");
  return bundles;
}

function replaceOnce(code, needle, replacement, label) {
  const first = code.indexOf(needle);
  if (first < 0) fail(`${label}: patch anchor not found`);
  if (code.indexOf(needle, first + needle.length) >= 0) fail(`${label}: patch anchor is ambiguous`);
  return code.slice(0, first) + replacement + code.slice(first + needle.length);
}

function patchLinuxFeatureGate(code) {
  if (code.includes("linuxFeatureResult")) {
    console.log("  [ok] Linux node_repl feature gate already patched");
    return code;
  }

  console.log("  [patch] Disable computerUseNodeRepl on Linux");
  const variants = [
    {
      needle:
        "c=t===n.i.Dev?Ye(r):null;return c==null?{...s,deviceAttestation:ve({platform:i})}:{...s,...c,deviceAttestation:ve({platform:i})}",
      replacement:
        "c=t===n.i.Dev?Ye(r):null,linuxFeatureResult=c==null?{...s,deviceAttestation:ve({platform:i})}:{...s,...c,deviceAttestation:ve({platform:i})};return i===`linux`?{...linuxFeatureResult,computerUseNodeRepl:!1}:linuxFeatureResult",
    },
    {
      needle:
        "s=t===i.a.Dev?Ze(n):null;return s==null?{...o,deviceAttestation:be({platform:r})}:{...o,...s,deviceAttestation:be({platform:r})}",
      replacement:
        "s=t===i.a.Dev?Ze(n):null,linuxFeatureResult=s==null?{...o,deviceAttestation:be({platform:r})}:{...o,...s,deviceAttestation:be({platform:r})};return r===`linux`?{...linuxFeatureResult,computerUseNodeRepl:!1}:linuxFeatureResult",
    },
  ];

  for (const { needle, replacement } of variants) {
    if (code.includes(needle)) {
      return replaceOnce(code, needle, replacement, "linux feature gate");
    }
  }

  fail("linux feature gate: patch anchor not found");
}

function patchThreadCatalogStartupSync(code) {
  if (code.includes("Thread catalog startup sync failed")) {
    console.log("  [ok] Thread catalog startup sync already patched");
    return code;
  }

  const needle =
    "this.threadCatalogSyncManager!=null){let t=this.threadCatalogSyncManager;this.disposables.add(t),";
  const replacement =
    "this.threadCatalogSyncManager!=null){let t=this.threadCatalogSyncManager;this.disposables.add(t),this.disposables.add(t.subscribe(()=>{})),t.requestStartupSync().catch(e=>{j2.warning(`Thread catalog startup sync failed`,{safe:{},sensitive:{error:e}})}),";

  console.log("  [patch] Request local thread catalog startup sync");
  return replaceOnce(code, needle, replacement, "thread catalog startup sync");
}

function patchLinuxWindowBehavior(code) {
  let next = code;

  if (
    next.includes("n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:f9(r)}:{titleBarStyle:`default`}") ||
    next.includes("n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:j9(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}}")
  ) {
    console.log("  [ok] Linux primary native titlebar already patched");
  } else {
    console.log("  [patch] Use native titlebar for Linux primary windows");
    const variants = [
      {
        needle:
          "n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:f9(r)}:{titleBarStyle:`default`}",
        replacement:
          "n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:f9(r)}:{titleBarStyle:`default`}",
      },
      {
        needle:
          "n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:j9(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}}",
        replacement:
          "n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:j9(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}}",
      },
    ];

    let patched = false;
    for (const { needle, replacement } of variants) {
      if (next.includes(needle)) {
        next = replaceOnce(next, needle, replacement, "linux primary window titlebar");
        patched = true;
        break;
      }
    }
    if (!patched) fail("linux primary window titlebar: patch anchor not found");
  }

  if (
    next.includes("show:l,parent:p,...m===void 0?{}:{focusable:m},...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{}") ||
    next.includes("...m===void 0?{}:{focusable:m},...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{}")
  ) {
    console.log("  [ok] Linux window focusable default already patched");
  } else {
    const needle =
      "show:l,parent:p,focusable:m,...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{}";
    const replacement =
      "show:l,parent:p,...m===void 0?{}:{focusable:m},...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{}";

    console.log("  [patch] Preserve default focusability for Linux windows");
    next = replaceOnce(next, needle, replacement, "linux window focusable default");
  }

  if (next.includes("process.platform===`darwin`&&e.moveTop()")) {
    console.log("  [ok] Linux hotkey window top policy already patched");
  } else {
    const needle =
      "this.configuredWindowIds.has(e.id)||(this.configuredWindowIds.add(e.id),process.platform===`darwin`?e.setVisibleOnAllWorkspaces(!0,{visibleOnFullScreen:!0,skipTransformProcessType:!0}):e.setVisibleOnAllWorkspaces(!0)),e.moveTop()";
    const replacement =
      "this.configuredWindowIds.has(e.id)||(this.configuredWindowIds.add(e.id),process.platform===`darwin`&&e.setVisibleOnAllWorkspaces(!0,{visibleOnFullScreen:!0,skipTransformProcessType:!0})),process.platform===`darwin`&&e.moveTop()";

    console.log("  [patch] Disable Linux hotkey window all-workspace/top policy");
    next = replaceOnce(next, needle, replacement, "linux hotkey window top policy");
  }

  if (!next.includes(":{titleBarStyle:`default`,minimizable:!1,maximizable:!1,fullscreenable:!1,alwaysOnTop:!0}")) {
    console.log("  [ok] Linux HUD always-on-top already patched");
  } else {
    const needle = ":{titleBarStyle:`default`,minimizable:!1,maximizable:!1,fullscreenable:!1,alwaysOnTop:!0}";
    const replacement = ":{titleBarStyle:`default`}";

    console.log("  [patch] Disable Linux HUD always-on-top window policy");
    next = replaceOnce(next, needle, replacement, "linux HUD always-on-top policy");
  }

  if (
    next.includes("process.platform===`win32`&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(f9(t)))") ||
    next.includes("process.platform===`win32`&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(j9(t)))")
  ) {
    console.log("  [ok] Linux titlebar overlay zoom update already patched");
  } else {
    console.log("  [patch] Disable Linux titlebar overlay zoom updates");
    const variants = [
      {
        needle:
          "process.platform===`darwin`?n.setWindowButtonPosition(d9(t)):(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(f9(t)))",
        replacement:
          "process.platform===`darwin`?n.setWindowButtonPosition(d9(t)):process.platform===`win32`&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(f9(t)))",
      },
      {
        needle:
          "process.platform===`darwin`?n.setWindowButtonPosition(A9(t)):(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(j9(t)))",
        replacement:
          "process.platform===`darwin`?n.setWindowButtonPosition(A9(t)):process.platform===`win32`&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(j9(t)))",
      },
    ];

    let patched = false;
    for (const { needle, replacement } of variants) {
      if (next.includes(needle)) {
        next = replaceOnce(next, needle, replacement, "linux titlebar overlay zoom update");
        patched = true;
        break;
      }
    }
    if (!patched) fail("linux titlebar overlay zoom update: patch anchor not found");
  }

  if (
    next.includes("if(process.platform!==`win32`||t!==`primary`)return;") ||
    next.includes("if(process.platform!==`win32`||t!==`primary`&&t!==`quickChat`)return;")
  ) {
    console.log("  [ok] Linux titlebar overlay install already patched");
  } else {
    console.log("  [patch] Disable Linux titlebar overlay install");
    const variants = [
      {
        needle: "if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`)return;",
        replacement: "if(process.platform!==`win32`||t!==`primary`)return;",
      },
      {
        needle:
          "if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`&&t!==`quickChat`)return;",
        replacement: "if(process.platform!==`win32`||t!==`primary`&&t!==`quickChat`)return;",
      },
    ];

    let patched = false;
    for (const { needle, replacement } of variants) {
      if (next.includes(needle)) {
        next = replaceOnce(next, needle, replacement, "linux titlebar overlay install");
        patched = true;
        break;
      }
    }
    if (!patched) fail("linux titlebar overlay install: patch anchor not found");
  }

  return next;
}

function patchLinuxFileManagerOpenTarget(code) {
  let next = code;

  if (!next.includes("__codexDesktopLinuxOpenFileManager")) {
    const helperVariants = [
      {
        needle:
          "async function MM(e){let{shell:t}=await import(`electron`),n=NM(e);if(n&&(0,u.statSync)(n).isFile()){t.showItemInFolder(n);return}let r=n??e,i=await t.openPath(r);if(i)throw Error(i)}function NM(e){let t=e;for(;;){if((0,u.existsSync)(t))return t;let e=(0,s.dirname)(t);if(e===t)return null;t=e}}",
        replacement:
          "async function MM(e){let{shell:t}=await import(`electron`),n=NM(e);if(n&&(0,u.statSync)(n).isFile()){t.showItemInFolder(n);return}let r=n??e,i=await t.openPath(r);if(i)throw Error(i)}function NM(e){let t=e;for(;;){if((0,u.existsSync)(t))return t;let e=(0,s.dirname)(t);if(e===t)return null;t=e}}function __codexDesktopLinuxFileManagerCommand(){return os(`xdg-open`)??os(`gio`)??`system-default`}async function __codexDesktopLinuxOpenFileManager(e,t){let n=NM(e),r=n??e;if(n&&(0,u.statSync)(n).isFile())r=(0,s.dirname)(n);let i=[],a=[];t&&t!==`system-default`&&a.push(t);for(let e of[`xdg-open`,`gio`]){let t=os(e);t&&a.push(t)}for(let e of[...new Set(a)])try{await us(e,(0,s.basename)(e)===`gio`?[`open`,r]:[r]);return}catch(t){i.push(`${e}: ${t instanceof Error?t.message:String(t)}`)}let{shell:o}=await import(`electron`),c=await o.openPath(r);if(!c)return;i.push(`electron: ${c}`);throw Error(`Failed to open file manager for ${r}: ${i.join(`; `)}`)}",
      },
      {
        needle:
          "async function bM(e){let{shell:t}=await import(`electron`),n=xM(e);if(n&&(0,p.statSync)(n).isFile()){t.showItemInFolder(n);return}let r=n??e,i=await t.openPath(r);if(i)throw Error(i)}function xM(e){let t=e;for(;;){if((0,p.existsSync)(t))return t;let e=(0,u.dirname)(t);if(e===t)return null;t=e}}",
        replacement:
          "async function bM(e){let{shell:t}=await import(`electron`),n=xM(e);if(n&&(0,p.statSync)(n).isFile()){t.showItemInFolder(n);return}let r=n??e,i=await t.openPath(r);if(i)throw Error(i)}function xM(e){let t=e;for(;;){if((0,p.existsSync)(t))return t;let e=(0,u.dirname)(t);if(e===t)return null;t=e}}function __codexDesktopLinuxFileManagerCommand(){return ks(`xdg-open`)??ks(`gio`)??`system-default`}async function __codexDesktopLinuxOpenFileManager(e,t){let n=xM(e),r=n??e;if(n&&(0,p.statSync)(n).isFile())r=(0,u.dirname)(n);let i=[],a=[];t&&t!==`system-default`&&a.push(t);for(let e of[`xdg-open`,`gio`]){let t=ks(e);t&&a.push(t)}for(let e of[...new Set(a)])try{await Ns(e,(0,u.basename)(e)===`gio`?[`open`,r]:[r]);return}catch(t){i.push(`${e}: ${t instanceof Error?t.message:String(t)}`)}let{shell:o}=await import(`electron`),s=await o.openPath(r);if(!s)return;i.push(`electron: ${s}`);throw Error(`Failed to open file manager for ${r}: ${i.join(`; `)}`)}",
      },
      {
        needle:
          "async function Tle(e){let{shell:t}=await import(`electron`),n=Ele(e);if(n&&(0,w.statSync)(n).isFile()){t.showItemInFolder(n);return}let r=n??e,i=await t.openPath(r);if(i)throw Error(i)}function Ele(e){let t=e;for(;;){if((0,w.existsSync)(t))return t;let e=(0,E.dirname)(t);if(e===t)return null;t=e}}",
        replacement:
          "async function Tle(e){let{shell:t}=await import(`electron`),n=Ele(e);if(n&&(0,w.statSync)(n).isFile()){t.showItemInFolder(n);return}let r=n??e,i=await t.openPath(r);if(i)throw Error(i)}function Ele(e){let t=e;for(;;){if((0,w.existsSync)(t))return t;let e=(0,E.dirname)(t);if(e===t)return null;t=e}}function __codexDesktopLinuxFileManagerCommand(){return G7(`xdg-open`)??G7(`gio`)??`system-default`}async function __codexDesktopLinuxOpenFileManager(e,t){let n=Ele(e),r=n??e;if(n&&(0,w.statSync)(n).isFile())r=(0,E.dirname)(n);let i=[],a=[];t&&t!==`system-default`&&a.push(t);for(let e of[`xdg-open`,`gio`]){let t=G7(e);t&&a.push(t)}for(let e of[...new Set(a)])try{await q7(e,(0,E.basename)(e)===`gio`?[`open`,r]:[r]);return}catch(t){i.push(`${e}: ${t instanceof Error?t.message:String(t)}`)}let{shell:o}=await import(`electron`),s=await o.openPath(r);if(!s)return;i.push(`electron: ${s}`);throw Error(`Failed to open file manager for ${r}: ${i.join(`; `)}`)}",
      },
      {
        needle:
          "async function Lle(e){let{shell:t}=await import(`electron`),n=Rle(e);if(n&&(0,w.statSync)(n).isFile()){t.showItemInFolder(n);return}let r=n??e,i=await t.openPath(r);if(i)throw Error(i)}function Rle(e){let t=e;for(;;){if((0,w.existsSync)(t))return t;let e=(0,E.dirname)(t);if(e===t)return null;t=e}}",
        replacement:
          "async function Lle(e){let{shell:t}=await import(`electron`),n=Rle(e);if(n&&(0,w.statSync)(n).isFile()){t.showItemInFolder(n);return}let r=n??e,i=await t.openPath(r);if(i)throw Error(i)}function Rle(e){let t=e;for(;;){if((0,w.existsSync)(t))return t;let e=(0,E.dirname)(t);if(e===t)return null;t=e}}function __codexDesktopLinuxFileManagerCommand(){return G7(`xdg-open`)??G7(`gio`)??`system-default`}async function __codexDesktopLinuxOpenFileManager(e,t){let n=Rle(e),r=n??e;if(n&&(0,w.statSync)(n).isFile())r=(0,E.dirname)(n);let i=[],a=[];t&&t!==`system-default`&&a.push(t);for(let e of[`xdg-open`,`gio`]){let t=G7(e);t&&a.push(t)}for(let e of[...new Set(a)])try{await q7(e,(0,E.basename)(e)===`gio`?[`open`,r]:[r]);return}catch(t){i.push(`${e}: ${t instanceof Error?t.message:String(t)}`)}let{shell:o}=await import(`electron`),s=await o.openPath(r);if(!s)return;i.push(`electron: ${s}`);throw Error(`Failed to open file manager for ${r}: ${i.join(`; `)}`)}",
      },
    ];

    let patched = false;
    for (const { needle, replacement } of helperVariants) {
      if (next.includes(needle)) {
        patched = true;
      console.log("  [patch] Add robust Linux file manager opener");
        next = replaceOnce(next, needle, replacement, "linux file manager opener helper");
        break;
      }
    }

    if (!patched && next.includes("function mce(e){let{shell:t}=await import(`electron`)")) {
      console.log("  [ok] Linux file manager opener helper not needed in worker bundle");
    } else if (!patched) {
      fail("linux file manager opener helper: patch anchor not found");
    }
  } else {
    console.log("  [ok] Robust Linux file manager opener already patched");
  }

  const variants = [
    {
      needle:
        "AM=Zj({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>cs(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:jM,args:e=>cs(e),open:async({path:e})=>MM(e)}})",
      replacement:
        "AM=Zj({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>cs(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:jM,args:e=>cs(e),open:async({path:e})=>MM(e)},linux:{label:`File Manager`,icon:`apps/file-explorer.png`,detect:__codexDesktopLinuxFileManagerCommand,args:e=>cs(e),open:async({command:e,path:t})=>__codexDesktopLinuxOpenFileManager(t,e)}})",
    },
    {
      needle:
        "AM=Zj({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>cs(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:jM,args:e=>cs(e),open:async({path:e})=>MM(e)},linux:{label:`File Manager`,icon:`apps/file-explorer.png`,detect:()=>`system-default`,args:e=>cs(e),open:async({path:e})=>MM(e)}})",
      replacement:
        "AM=Zj({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>cs(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:jM,args:e=>cs(e),open:async({path:e})=>MM(e)},linux:{label:`File Manager`,icon:`apps/file-explorer.png`,detect:__codexDesktopLinuxFileManagerCommand,args:e=>cs(e),open:async({command:e,path:t})=>__codexDesktopLinuxOpenFileManager(t,e)}})",
    },
    {
      needle:
        "fce=S9({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>q7(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:pce,args:e=>q7(e),open:async({path:e})=>mce(e)}})",
      replacement:
        "fce=S9({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>q7(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:pce,args:e=>q7(e),open:async({path:e})=>mce(e)},linux:{label:`File Manager`,icon:`apps/file-explorer.png`,detect:()=>K7(`xdg-open`)??K7(`gio`)??`system-default`,args:e=>q7(e),open:async({path:e})=>mce(e)}})",
    },
    {
      needle:
        "fce=S9({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>q7(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:pce,args:e=>q7(e),open:async({path:e})=>mce(e)},linux:{label:`File Manager`,icon:`apps/file-explorer.png`,detect:()=>`system-default`,args:e=>q7(e),open:async({path:e})=>mce(e)}})",
      replacement:
        "fce=S9({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>q7(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:pce,args:e=>q7(e),open:async({path:e})=>mce(e)},linux:{label:`File Manager`,icon:`apps/file-explorer.png`,detect:()=>K7(`xdg-open`)??K7(`gio`)??`system-default`,args:e=>q7(e),open:async({path:e})=>mce(e)}})",
    },
    {
      needle:
        "vM=zj({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>js(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:yM,args:e=>js(e),open:async({path:e})=>bM(e)}})",
      replacement:
        "vM=zj({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>js(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:yM,args:e=>js(e),open:async({path:e})=>bM(e)},linux:{label:`File Manager`,icon:`apps/file-explorer.png`,detect:__codexDesktopLinuxFileManagerCommand,args:e=>js(e),open:async({command:e,path:t})=>__codexDesktopLinuxOpenFileManager(t,e)}})",
    },
    {
      needle:
        "Cle=x9({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>K7(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:wle,args:e=>K7(e),open:async({path:e})=>Tle(e)}})",
      replacement:
        "Cle=x9({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>K7(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:wle,args:e=>K7(e),open:async({path:e})=>Tle(e)},linux:{label:`File Manager`,icon:`apps/file-explorer.png`,detect:__codexDesktopLinuxFileManagerCommand,args:e=>K7(e),open:async({command:e,path:t})=>__codexDesktopLinuxOpenFileManager(t,e)}})",
    },
    {
      needle:
        "Fle=S9({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>K7(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:Ile,args:e=>K7(e),open:async({path:e})=>Lle(e)}})",
      replacement:
        "Fle=S9({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>K7(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:Ile,args:e=>K7(e),open:async({path:e})=>Lle(e)},linux:{label:`File Manager`,icon:`apps/file-explorer.png`,detect:__codexDesktopLinuxFileManagerCommand,args:e=>K7(e),open:async({command:e,path:t})=>__codexDesktopLinuxOpenFileManager(t,e)}})",
    },
  ];

  for (const { replacement } of variants) {
    if (next.includes(replacement)) {
      console.log("  [ok] Linux file manager open target already patched");
      return next;
    }
  }

  for (const { needle, replacement } of variants) {
    if (next.includes(needle)) {
      console.log("  [patch] Add Linux file manager open target");
      return replaceOnce(next, needle, replacement, "linux file manager open target");
    }
  }

  fail("linux file manager open target: patch anchor not found");
}

function patchRendererThreadSummaryTitleFallback(code) {
  if (code.includes("__codexDesktopLinuxSummaryTitleFallback")) {
    console.log("  [ok] Renderer thread summary title fallback already patched");
    return code;
  }

  console.log("  [patch] Use thread preview as sidebar summary title fallback");
  const variants = [
    {
      needle: "title:e.name?.trim()||null,cwd:e.cwd||null,",
      replacement:
        "title:globalThis.__codexDesktopLinuxSummaryTitleFallback!==!1?e.name?.trim()||e.preview?.replace(/\\s+/g,` `).trim()||null:e.name?.trim()||null,cwd:e.cwd||null,",
    },
    {
      needle: "title:t.name?.trim()||null,cwd:t.cwd||null,",
      replacement:
        "title:globalThis.__codexDesktopLinuxSummaryTitleFallback!==!1?t.name?.trim()||t.preview?.replace(/\\s+/g,` `).trim()||null:t.name?.trim()||null,cwd:t.cwd||null,",
    },
  ];

  for (const { needle, replacement } of variants) {
    if (code.includes(needle)) {
      return replaceOnce(code, needle, replacement, "renderer thread summary title fallback");
    }
  }

  fail("renderer thread summary title fallback: patch anchor not found");
}

function patchRendererCatalogBridge(code) {
  if (code.includes("r===!1||a==null?null")) {
    console.log("  [ok] Renderer local thread catalog bridge already patched");
    return code;
  }

  console.log("  [patch] Enable renderer local thread catalog bridge");
  const variants = [
    {
      needle: "o=!(r??i)||a==null?null:(0,AQ.jsx)(qMe,{service:a})",
      replacement: "o=r===!1||a==null?null:(0,AQ.jsx)(qMe,{service:a})",
    },
    {
      needle: "o=!(r??i)||a==null?null:(0,YZe.jsx)(qZe,{service:a})",
      replacement: "o=r===!1||a==null?null:(0,YZe.jsx)(qZe,{service:a})",
    },
    {
      needle: "o=!(r??i)||a==null?null:(0,i1.jsx)(Gge,{service:a})",
      replacement: "o=r===!1||a==null?null:(0,i1.jsx)(Gge,{service:a})",
    },
  ];

  for (const { needle, replacement } of variants) {
    if (code.includes(needle)) {
      return replaceOnce(code, needle, replacement, "renderer local thread catalog bridge");
    }
  }

  fail("renderer local thread catalog bridge: patch anchor not found");
}

function patchRendererStateDbSidebar(code) {
  if (code.includes("__codexDesktopLinuxStateDbSidebar")) {
    console.log("  [ok] Renderer state DB sidebar source already patched");
    return code;
  }

  if (
    (code.includes("SO=tr(") && code.includes("hasLiveConversation:!1,summary:a")) ||
    code.includes(NATIVE_STATE_DB_SIDEBAR_SNIPPET)
  ) {
    console.log("  [ok] Renderer state DB sidebar source is native");
    return code;
  }

  const needle =
    "if(e(Je,`3314958849`))for(let n of e(ke,De))n.parentThreadId!=null||yt(n.source)?.parentThreadId!=null||t.set(n.conversationId,{hasLiveConversation:!1,summary:n});";
  const replacement =
    "if(globalThis.__codexDesktopLinuxStateDbSidebar!==!1||e(Je,`3314958849`))for(let n of e(ke,De))n.parentThreadId!=null||yt(n.source)?.parentThreadId!=null||t.set(n.conversationId,{hasLiveConversation:!1,summary:n});";

  console.log("  [patch] Enable renderer state DB summaries in sidebar");
  return replaceOnce(code, needle, replacement, "renderer state DB sidebar source");
}

function patchRendererSidebarThreadSummaries(code) {
  if (code.includes("__codexDesktopLinuxSidebarThreadSummaries")) {
    console.log("  [ok] Renderer sidebar thread summaries already patched");
    return code;
  }

  console.log("  [patch] Populate sidebar thread summaries from startup thread list");
  const variants = [
    {
      needle:
        "}else r>50&&this.threadSummaries.length>0?this.mergeRecentThreadSummaries(s.data,r,s.nextCursor!=null):this.threadSummaries.length>0&&this.replaceThreadSummaries([]);",
      replacement:
        "}else globalThis.__codexDesktopLinuxSidebarThreadSummaries!==!1?this.mergeRecentThreadSummaries(s.data,Math.max(r,50),s.nextCursor!=null):r>50&&this.threadSummaries.length>0?this.mergeRecentThreadSummaries(s.data,r,s.nextCursor!=null):this.threadSummaries.length>0&&this.replaceThreadSummaries([]);",
    },
    {
      needle:
        "}else r>50&&this.threadSummaries.length>0?this.mergeRecentThreadSummaries(c,r,s.nextCursor!=null):this.threadSummaries.length>0&&this.replaceThreadSummaries([]);",
      replacement:
        "}else globalThis.__codexDesktopLinuxSidebarThreadSummaries!==!1?this.mergeRecentThreadSummaries(c,Math.max(r,50),s.nextCursor!=null):r>50&&this.threadSummaries.length>0?this.mergeRecentThreadSummaries(c,r,s.nextCursor!=null):this.threadSummaries.length>0&&this.replaceThreadSummaries([]);",
    },
  ];

  for (const { needle, replacement } of variants) {
    if (code.includes(needle)) {
      return replaceOnce(code, needle, replacement, "renderer sidebar thread summaries");
    }
  }

  fail("renderer sidebar thread summaries: patch anchor not found");
}

function patchRendererProjectGroupsFromThreadCwds(code) {
  if (code.includes("__codexDesktopLinuxThreadCwdWorkspaceRoots")) {
    if (code.includes("?[k(t.cwd)]:[]")) {
      console.log("  [patch] Preserve Linux thread cwd casing in project roots");
      return replaceOnce(
        code,
        "?[k(t.cwd)]:[]",
        "?[t.cwd]:[]",
        "renderer Linux thread cwd project root casing"
      );
    }
    console.log("  [ok] Renderer Linux thread cwd workspace roots already patched");
    return code;
  }

  console.log("  [patch] Feed Linux local thread cwd roots into project grouping");
  const variants = [
    {
      needle:
        "b=Object.fromEntries(g.map(({hostId:e})=>{let t=new Map((h[e]??$).map(e=>[k(e.dir),e]));return y[e]?.forEach(e=>{t.set(k(e.dir),e)}),[e,Array.from(t.values())]})),x=Vr([...Gr(n.data,h[o]??$,t(F,void 0).data?.codexHome),...Kr(M(t,l.LOCAL_PROJECTS)),...Jr(c,t(K))],M(t,l.PROJECT_ORDER)),",
      replacement:
        "b=Object.fromEntries(g.map(({hostId:e})=>{let t=new Map((h[e]??$).map(e=>[k(e.dir),e]));return y[e]?.forEach(e=>{t.set(k(e.dir),e)}),[e,Array.from(t.values())]})),linuxWorkspaceRootData=globalThis.__codexDesktopLinuxThreadCwdWorkspaceRoots!==!1?{...n.data,roots:[...new Set([...(n.data?.roots??[]),...s.flatMap(t=>t.kind===`local`&&(t.hostId==null||t.hostId===`local`)&&t.cwd&&t.cwd!==`~`&&t.workspaceKind!==`projectless`&&!(Array.isArray(e.projectlessThreadIds)&&e.projectlessThreadIds.includes(t.conversationId))?[t.cwd]:[])])]}:n.data,x=Vr([...Gr(linuxWorkspaceRootData,h[o]??$,t(F,void 0).data?.codexHome),...Kr(M(t,l.LOCAL_PROJECTS)),...Jr(c,t(K))],M(t,l.PROJECT_ORDER)),",
    },
    {
      needle:
        "b=Object.fromEntries(g.map(({hostId:e})=>{let t=new Map((h[e]??rP).map(e=>[yn(e.dir),e]));return y[e]?.forEach(e=>{t.set(yn(e.dir),e)}),[e,Array.from(t.values())]})),x=kN([...AN(r.data,h[i]??rP,e(Ga,void 0).data?.codexHome),...jN(Fn(e,kr.LOCAL_PROJECTS)),...MN(l,e(_O))],Fn(e,kr.PROJECT_ORDER)),",
      replacement:
        "b=Object.fromEntries(g.map(({hostId:e})=>{let t=new Map((h[e]??rP).map(e=>[yn(e.dir),e]));return y[e]?.forEach(e=>{t.set(yn(e.dir),e)}),[e,Array.from(t.values())]})),linuxWorkspaceRootData=globalThis.__codexDesktopLinuxThreadCwdWorkspaceRoots!==!1?{...r.data,roots:[...new Set([...(r.data?.roots??[]),...c.flatMap(t=>t.kind===`local`&&(t.hostId==null||t.hostId===`local`)&&t.cwd&&t.cwd!==`~`&&t.workspaceKind!==`projectless`&&!(Array.isArray(o)&&o.includes(t.conversationId))?[t.cwd]:[])])]}:r.data,x=kN([...AN(linuxWorkspaceRootData,h[i]??rP,e(Ga,void 0).data?.codexHome),...jN(Fn(e,kr.LOCAL_PROJECTS)),...MN(l,e(_O))],Fn(e,kr.PROJECT_ORDER)),",
    },
    {
      needle:
        "x=Object.fromEntries(g.map(({hostId:e})=>{let t=new Map((h[e]??fP).map(e=>[ze(e.dir),e]));return b[e]?.forEach(e=>{t.set(ze(e.dir),e)}),[e,Array.from(t.values())]})),S=bN([...wN(r.data,h[i]??fP,e(xo,void 0).data?.codexHome),...TN(_(e,Se.LOCAL_PROJECTS)),...DN(l,e(FD))],_(e,Se.PROJECT_ORDER)),",
      replacement:
        "x=Object.fromEntries(g.map(({hostId:e})=>{let t=new Map((h[e]??fP).map(e=>[ze(e.dir),e]));return b[e]?.forEach(e=>{t.set(ze(e.dir),e)}),[e,Array.from(t.values())]})),linuxWorkspaceRootData=globalThis.__codexDesktopLinuxThreadCwdWorkspaceRoots!==!1?{...r.data,roots:[...new Set([...(r.data?.roots??[]),...c.flatMap(t=>t.kind===`local`&&(t.hostId==null||t.hostId===`local`)&&t.cwd&&t.cwd!==`~`&&t.workspaceKind!==`projectless`&&!(Array.isArray(o)&&o.includes(t.conversationId))?[t.cwd]:[])])]}:r.data,S=bN([...wN(linuxWorkspaceRootData,h[i]??fP,e(xo,void 0).data?.codexHome),...TN(_(e,Se.LOCAL_PROJECTS)),...DN(l,e(FD))],_(e,Se.PROJECT_ORDER)),",
    },
  ];

  for (const { needle, replacement } of variants) {
    if (code.includes(needle)) {
      return replaceOnce(code, needle, replacement, "renderer Linux thread cwd workspace roots");
    }
  }

  fail("renderer Linux thread cwd workspace roots: patch anchor not found");
}

function patchRendererNativeSidebarChats(code) {
  const original =
    "let L=r?I:[],R=L.map(e=>e.task.key),z=!s&&i!==`connection`&&(L.length>0||e.canStartProjectlessChat),";
  const latestOriginal =
    "let U=i?H:[],W=U.map(e=>e.task.key),G=!l&&a!==`connection`&&(U.length>0||e.canStartProjectlessChat),";
  const currentOriginal = NATIVE_SIDEBAR_AGGREGATION_SNIPPET;
  const fallback =
    "let L=r?(globalThis.__codexDesktopLinuxUngroupedSidebarFallback!==!1&&!D&&I.length===0&&E.length===0&&F.length>0?F:I):[],R=L.map(e=>e.task.key),z=!s&&i!==`connection`&&(L.length>0||e.canStartProjectlessChat),";

  if (code.includes(original) || code.includes(latestOriginal) || code.includes(currentOriginal)) {
    console.log("  [ok] Renderer sidebar chat/project split is native");
    return code;
  }

  if (code.includes(fallback)) {
    console.log("  [patch] Restore native sidebar chat/project split");
    return replaceOnce(code, fallback, original, "renderer native sidebar chat/project split");
  }

  fail("renderer native sidebar chat/project split: patch anchor not found");
}

function patchPlanModeShortcut(code) {
  if (code.includes(PLAN_MODE_COMMAND_WITH_SHIFT_TAB)) {
    console.log("  [ok] Plan mode Shift+Tab shortcut already patched");
    return code;
  }

  if (code.includes(PLAN_MODE_COMMAND_WITH_BROKEN_SHIFT_TAB)) {
    console.log("  [patch] Repair Plan mode Shift+Tab shortcut syntax");
    return replaceOnce(
      code,
      PLAN_MODE_COMMAND_WITH_BROKEN_SHIFT_TAB,
      PLAN_MODE_COMMAND_WITH_SHIFT_TAB,
      "Plan mode Shift+Tab shortcut syntax"
    );
  }

  if (!code.includes(PLAN_MODE_COMMAND_WITHOUT_KEYBINDING)) {
    fail("Plan mode shortcut: patch anchor not found");
  }

  console.log("  [patch] Add Shift+Tab shortcut for Plan mode");
  return replaceOnce(
    code,
    PLAN_MODE_COMMAND_WITHOUT_KEYBINDING,
    PLAN_MODE_COMMAND_WITH_SHIFT_TAB,
    "Plan mode Shift+Tab shortcut"
  );
}

function main() {
  const bundle = findMainBundle();
  console.log(`-- patch-linux-runtime: ${path.relative(PROJECT_ROOT, bundle)}`);

  const original = fs.readFileSync(bundle, "utf8");
  let code = patchLinuxFeatureGate(original);
  code = patchThreadCatalogStartupSync(code);
  code = patchLinuxWindowBehavior(code);
  code = patchLinuxFileManagerOpenTarget(code);

  if (code !== original) {
    fs.writeFileSync(bundle, code, "utf8");
    console.log("  [ok] Linux runtime patches applied");
  } else {
    console.log("  [ok] No changes needed");
  }

  const workerBundle = findOpenInWorkerBundle();
  console.log(`-- patch-linux-runtime: ${path.relative(PROJECT_ROOT, workerBundle)}`);
  const originalWorker = fs.readFileSync(workerBundle, "utf8");
  const workerCode = patchLinuxFileManagerOpenTarget(originalWorker);

  if (workerCode !== originalWorker) {
    fs.writeFileSync(workerBundle, workerCode, "utf8");
    console.log("  [ok] Linux open-in worker patches applied");
  } else {
    console.log("  [ok] No open-in worker changes needed");
  }

  const webviewBundle = findWebviewAppBundle();
  console.log(`-- patch-linux-runtime: ${path.relative(PROJECT_ROOT, webviewBundle)}`);
  const originalWebview = fs.readFileSync(webviewBundle, "utf8");
  const webviewCode = patchRendererCatalogBridge(originalWebview);

  if (webviewCode !== originalWebview) {
    fs.writeFileSync(webviewBundle, webviewCode, "utf8");
    console.log("  [ok] Linux webview runtime patches applied");
  } else {
    console.log("  [ok] No webview changes needed");
  }

  const sidebarStateBundle = findSidebarStateBundle();
  console.log(`-- patch-linux-runtime: ${path.relative(PROJECT_ROOT, sidebarStateBundle)}`);
  const originalSidebarState = fs.readFileSync(sidebarStateBundle, "utf8");
  const sidebarStateCode = patchRendererStateDbSidebar(originalSidebarState);

  if (sidebarStateCode !== originalSidebarState) {
    fs.writeFileSync(sidebarStateBundle, sidebarStateCode, "utf8");
    console.log("  [ok] Linux sidebar state patches applied");
  } else {
    console.log("  [ok] No sidebar state changes needed");
  }

  const threadStoreBundle = findThreadStoreBundle();
  console.log(`-- patch-linux-runtime: ${path.relative(PROJECT_ROOT, threadStoreBundle)}`);
  const originalThreadStore = fs.readFileSync(threadStoreBundle, "utf8");
  let threadStoreCode = patchRendererSidebarThreadSummaries(originalThreadStore);
  threadStoreCode = patchRendererThreadSummaryTitleFallback(threadStoreCode);

  if (threadStoreCode !== originalThreadStore) {
    fs.writeFileSync(threadStoreBundle, threadStoreCode, "utf8");
    console.log("  [ok] Linux thread store patches applied");
  } else {
    console.log("  [ok] No thread store changes needed");
  }

  const sidebarProjectGroupsBundle = findSidebarProjectGroupsBundle();
  console.log(`-- patch-linux-runtime: ${path.relative(PROJECT_ROOT, sidebarProjectGroupsBundle)}`);
  const originalSidebarProjectGroups = fs.readFileSync(sidebarProjectGroupsBundle, "utf8");
  const sidebarProjectGroupsCode = patchRendererProjectGroupsFromThreadCwds(originalSidebarProjectGroups);

  if (sidebarProjectGroupsCode !== originalSidebarProjectGroups) {
    fs.writeFileSync(sidebarProjectGroupsBundle, sidebarProjectGroupsCode, "utf8");
    console.log("  [ok] Linux sidebar project grouping patches applied");
  } else {
    console.log("  [ok] No sidebar project grouping changes needed");
  }

  const sidebarAggregationBundle = findSidebarAggregationBundle();
  console.log(`-- patch-linux-runtime: ${path.relative(PROJECT_ROOT, sidebarAggregationBundle)}`);
  const originalSidebarAggregation = fs.readFileSync(sidebarAggregationBundle, "utf8");
  const sidebarAggregationCode = patchRendererNativeSidebarChats(originalSidebarAggregation);

  if (sidebarAggregationCode !== originalSidebarAggregation) {
    fs.writeFileSync(sidebarAggregationBundle, sidebarAggregationCode, "utf8");
    console.log("  [ok] Linux sidebar native split patches applied");
  } else {
    console.log("  [ok] No sidebar aggregation changes needed");
  }

  for (const planModeBundle of findPlanModeCommandBundles()) {
    console.log(`-- patch-linux-runtime: ${path.relative(PROJECT_ROOT, planModeBundle)}`);
    const originalPlanModeBundle = fs.readFileSync(planModeBundle, "utf8");
    const planModeBundleCode = patchPlanModeShortcut(originalPlanModeBundle);

    if (planModeBundleCode !== originalPlanModeBundle) {
      fs.writeFileSync(planModeBundle, planModeBundleCode, "utf8");
      console.log("  [ok] Plan mode shortcut patch applied");
    } else {
      console.log("  [ok] No Plan mode shortcut changes needed");
    }
  }
}

main();
