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
      code.includes("function KMe(") &&
      code.includes("localThreadCatalog") &&
      code.includes("567837310")
    ) {
      return file;
    }
  }

  fail("Could not locate Linux webview app bundle");
}

function findWebviewAppShellBundle() {
  if (!fs.existsSync(WEBVIEW_ASSETS_DIR)) {
    fail(`Missing webview assets dir: ${path.relative(PROJECT_ROOT, WEBVIEW_ASSETS_DIR)}`);
  }

  const candidates = fs
    .readdirSync(WEBVIEW_ASSETS_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(WEBVIEW_ASSETS_DIR, name));

  for (const file of candidates) {
    const code = fs.readFileSync(file, "utf8");
    if (code.includes("(0,OG.jsx)(L6t,{})") && code.includes("className:`relative flex flex-col`")) {
      return file;
    }
  }

  fail("Could not locate Linux webview app shell bundle");
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
      code.includes("3314958849") &&
      code.includes("hasLiveConversation:!1,summary:n")
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
      code.includes("visibleRecentChatItems:L") &&
      code.includes("visibleSidebarSectionKeys:ne") &&
      code.includes("let L=r?")
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
      code.includes("function Gr(") &&
      code.includes("function Kr(") &&
      code.includes("sidebar_workspace_task_groups_task_dirs") &&
      code.includes("function Yr(")
    ) {
      return file;
    }
  }

  fail("Could not locate Linux sidebar project groups bundle");
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

  const needle =
    "c=t===n.i.Dev?Ye(r):null;return c==null?{...s,deviceAttestation:ve({platform:i})}:{...s,...c,deviceAttestation:ve({platform:i})}";
  const replacement =
    "c=t===n.i.Dev?Ye(r):null,linuxFeatureResult=c==null?{...s,deviceAttestation:ve({platform:i})}:{...s,...c,deviceAttestation:ve({platform:i})};return i===`linux`?{...linuxFeatureResult,computerUseNodeRepl:!1}:linuxFeatureResult";

  console.log("  [patch] Disable computerUseNodeRepl on Linux");
  return replaceOnce(code, needle, replacement, "linux feature gate");
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

function patchLinuxWindowControlMessage(code) {
  if (code.includes("case`linux-window-control`")) {
    console.log("  [ok] Linux window control message already patched");
    return code;
  }

  const needle =
    "case`electron-window-focus-request`:{let t=a.BrowserWindow.fromWebContents(e);this.windowManager.sendMessageToWebContents(e,{type:`electron-window-focus-changed`,isFocused:t?.isFocused()??!1});break}";
  const replacement =
    "case`linux-window-control`:{let t=a.BrowserWindow.fromWebContents(e);if(process.platform===`linux`&&t&&!t.isDestroyed())switch(n.action){case`minimize`:t.minimize();break;case`toggle-maximize`:t.isMaximized()?t.unmaximize():t.maximize();break;case`close`:t.close();break}break}" +
    needle;

  console.log("  [patch] Add Linux window control message handler");
  return replaceOnce(code, needle, replacement, "linux window control message");
}

function patchLinuxWindowBehavior(code) {
  let next = code;

  if (next.includes("n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:f9(r)}:{titleBarStyle:`default`}")) {
    console.log("  [ok] Linux primary native titlebar already patched");
  } else {
    const needle =
      "n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:f9(r)}:{titleBarStyle:`default`}";
    const replacement =
      "n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:f9(r)}:{titleBarStyle:`default`}";

    console.log("  [patch] Use native titlebar for Linux primary windows");
    next = replaceOnce(next, needle, replacement, "linux primary window titlebar");
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

  if (next.includes("process.platform===`win32`&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(f9(t)))")) {
    console.log("  [ok] Linux titlebar overlay zoom update already patched");
  } else {
    const needle =
      "process.platform===`darwin`?n.setWindowButtonPosition(d9(t)):(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(f9(t)))";
    const replacement =
      "process.platform===`darwin`?n.setWindowButtonPosition(d9(t)):process.platform===`win32`&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(f9(t)))";

    console.log("  [patch] Disable Linux titlebar overlay zoom updates");
    next = replaceOnce(next, needle, replacement, "linux titlebar overlay zoom update");
  }

  if (next.includes("if(process.platform!==`win32`||t!==`primary`)return;")) {
    console.log("  [ok] Linux titlebar overlay install already patched");
  } else {
    const needle = "if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`)return;";
    const replacement = "if(process.platform!==`win32`||t!==`primary`)return;";

    console.log("  [patch] Disable Linux titlebar overlay install");
    next = replaceOnce(next, needle, replacement, "linux titlebar overlay install");
  }

  return next;
}

function patchRendererCatalogBridge(code) {
  if (code.includes("r===!1||a==null?null")) {
    console.log("  [ok] Renderer local thread catalog bridge already patched");
    return code;
  }

  const needle = "o=!(r??i)||a==null?null:(0,AQ.jsx)(qMe,{service:a})";
  const replacement = "o=r===!1||a==null?null:(0,AQ.jsx)(qMe,{service:a})";

  console.log("  [patch] Enable renderer local thread catalog bridge");
  return replaceOnce(code, needle, replacement, "renderer local thread catalog bridge");
}

function patchRendererLinuxWindowControls(code) {
  if (code.includes("data-codex-linux-window-controls")) {
    console.log("  [ok] Renderer Linux window controls already patched");
    return code;
  }

  const needle = "(0,OG.jsx)(L6t,{}),(0,OG.jsxs)(Nf.div,{ref:o,style:pe,className:`relative flex flex-col`";
  const controls =
    "(0,OG.jsx)(L6t,{}),typeof navigator<`u`&&/Linux/.test(navigator.platform)?(0,OG.jsxs)(`div`,{\"data-codex-linux-window-controls\":`true`,className:`no-drag`,style:{position:`fixed`,top:0,right:0,zIndex:9999,display:`flex`,height:32,alignItems:`center`,background:`rgba(245,245,245,.92)`,color:`#111`,boxShadow:`0 1px 2px rgba(0,0,0,.18)`},children:[(0,OG.jsx)(`button`,{type:`button`,title:`Minimize`,\"aria-label\":`Minimize`,style:{width:36,height:32,border:0,background:`transparent`,color:`inherit`,fontSize:13,cursor:`default`},onClick:()=>ht.dispatchMessage(`linux-window-control`,{action:`minimize`}),children:`_`}),(0,OG.jsx)(`button`,{type:`button`,title:`Maximize`,\"aria-label\":`Maximize`,style:{width:36,height:32,border:0,background:`transparent`,color:`inherit`,fontSize:13,cursor:`default`},onClick:()=>ht.dispatchMessage(`linux-window-control`,{action:`toggle-maximize`}),children:`[]`}),(0,OG.jsx)(`button`,{type:`button`,title:`Close`,\"aria-label\":`Close`,style:{width:40,height:32,border:0,background:`transparent`,color:`inherit`,fontSize:13,cursor:`default`},onClick:()=>ht.dispatchMessage(`linux-window-control`,{action:`close`}),children:`x`})]}):null,(0,OG.jsxs)(Nf.div,{ref:o,style:pe,className:`relative flex flex-col`";

  console.log("  [patch] Add renderer Linux window controls");
  return replaceOnce(code, needle, controls, "renderer Linux window controls");
}

function patchRendererStateDbSidebar(code) {
  if (code.includes("__codexDesktopLinuxStateDbSidebar")) {
    console.log("  [ok] Renderer state DB sidebar source already patched");
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

  const needle =
    "}else r>50&&this.threadSummaries.length>0?this.mergeRecentThreadSummaries(s.data,r,s.nextCursor!=null):this.threadSummaries.length>0&&this.replaceThreadSummaries([]);";
  const replacement =
    "}else globalThis.__codexDesktopLinuxSidebarThreadSummaries!==!1?this.mergeRecentThreadSummaries(s.data,Math.max(r,50),s.nextCursor!=null):r>50&&this.threadSummaries.length>0?this.mergeRecentThreadSummaries(s.data,r,s.nextCursor!=null):this.threadSummaries.length>0&&this.replaceThreadSummaries([]);";

  console.log("  [patch] Populate sidebar thread summaries from startup thread list");
  return replaceOnce(code, needle, replacement, "renderer sidebar thread summaries");
}

function patchRendererProjectGroupsFromThreadCwds(code) {
  if (code.includes("__codexDesktopLinuxThreadCwdWorkspaceRoots")) {
    console.log("  [ok] Renderer Linux thread cwd workspace roots already patched");
    return code;
  }

  const needle =
    "b=Object.fromEntries(g.map(({hostId:e})=>{let t=new Map((h[e]??$).map(e=>[k(e.dir),e]));return y[e]?.forEach(e=>{t.set(k(e.dir),e)}),[e,Array.from(t.values())]})),x=Vr([...Gr(n.data,h[o]??$,t(F,void 0).data?.codexHome),...Kr(M(t,l.LOCAL_PROJECTS)),...Jr(c,t(K))],M(t,l.PROJECT_ORDER)),";
  const replacement =
    "b=Object.fromEntries(g.map(({hostId:e})=>{let t=new Map((h[e]??$).map(e=>[k(e.dir),e]));return y[e]?.forEach(e=>{t.set(k(e.dir),e)}),[e,Array.from(t.values())]})),linuxWorkspaceRootData=globalThis.__codexDesktopLinuxThreadCwdWorkspaceRoots!==!1?{...n.data,roots:[...new Set([...(n.data?.roots??[]),...s.flatMap(t=>t.kind===`local`&&(t.hostId==null||t.hostId===`local`)&&t.cwd&&t.cwd!==`~`&&t.workspaceKind!==`projectless`&&!(Array.isArray(e.projectlessThreadIds)&&e.projectlessThreadIds.includes(t.conversationId))?[k(t.cwd)]:[])])]}:n.data,x=Vr([...Gr(linuxWorkspaceRootData,h[o]??$,t(F,void 0).data?.codexHome),...Kr(M(t,l.LOCAL_PROJECTS)),...Jr(c,t(K))],M(t,l.PROJECT_ORDER)),";

  console.log("  [patch] Feed Linux local thread cwd roots into project grouping");
  return replaceOnce(code, needle, replacement, "renderer Linux thread cwd workspace roots");
}

function patchRendererNativeSidebarChats(code) {
  const original =
    "let L=r?I:[],R=L.map(e=>e.task.key),z=!s&&i!==`connection`&&(L.length>0||e.canStartProjectlessChat),";
  const fallback =
    "let L=r?(globalThis.__codexDesktopLinuxUngroupedSidebarFallback!==!1&&!D&&I.length===0&&E.length===0&&F.length>0?F:I):[],R=L.map(e=>e.task.key),z=!s&&i!==`connection`&&(L.length>0||e.canStartProjectlessChat),";

  if (code.includes(original)) {
    console.log("  [ok] Renderer sidebar chat/project split is native");
    return code;
  }

  if (code.includes(fallback)) {
    console.log("  [patch] Restore native sidebar chat/project split");
    return replaceOnce(code, fallback, original, "renderer native sidebar chat/project split");
  }

  fail("renderer native sidebar chat/project split: patch anchor not found");
}

function main() {
  const bundle = findMainBundle();
  console.log(`-- patch-linux-runtime: ${path.relative(PROJECT_ROOT, bundle)}`);

  const original = fs.readFileSync(bundle, "utf8");
  let code = patchLinuxFeatureGate(original);
  code = patchThreadCatalogStartupSync(code);
  code = patchLinuxWindowControlMessage(code);
  code = patchLinuxWindowBehavior(code);

  if (code !== original) {
    fs.writeFileSync(bundle, code, "utf8");
    console.log("  [ok] Linux runtime patches applied");
  } else {
    console.log("  [ok] No changes needed");
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

  const appShellBundle = findWebviewAppShellBundle();
  console.log(`-- patch-linux-runtime: ${path.relative(PROJECT_ROOT, appShellBundle)}`);
  const originalAppShell = fs.readFileSync(appShellBundle, "utf8");
  const appShellCode = patchRendererLinuxWindowControls(originalAppShell);

  if (appShellCode !== originalAppShell) {
    fs.writeFileSync(appShellBundle, appShellCode, "utf8");
    console.log("  [ok] Linux app shell patches applied");
  } else {
    console.log("  [ok] No app shell changes needed");
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
  const threadStoreCode = patchRendererSidebarThreadSummaries(originalThreadStore);

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
}

main();
