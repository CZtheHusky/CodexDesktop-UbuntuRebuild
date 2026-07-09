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
      code.includes("function KMe(") &&
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

  if (next.includes("show:l,parent:p,...m===void 0?{}:{focusable:m},...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{}")) {
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

function patchLinuxFileManagerOpenTarget(code) {
  let next = code;

  if (!next.includes("__codexDesktopLinuxOpenFileManager")) {
    const helperNeedle =
      "async function MM(e){let{shell:t}=await import(`electron`),n=NM(e);if(n&&(0,u.statSync)(n).isFile()){t.showItemInFolder(n);return}let r=n??e,i=await t.openPath(r);if(i)throw Error(i)}function NM(e){let t=e;for(;;){if((0,u.existsSync)(t))return t;let e=(0,s.dirname)(t);if(e===t)return null;t=e}}";
    const helperReplacement =
      "async function MM(e){let{shell:t}=await import(`electron`),n=NM(e);if(n&&(0,u.statSync)(n).isFile()){t.showItemInFolder(n);return}let r=n??e,i=await t.openPath(r);if(i)throw Error(i)}function NM(e){let t=e;for(;;){if((0,u.existsSync)(t))return t;let e=(0,s.dirname)(t);if(e===t)return null;t=e}}function __codexDesktopLinuxFileManagerCommand(){return os(`xdg-open`)??os(`gio`)??`system-default`}async function __codexDesktopLinuxOpenFileManager(e,t){let n=NM(e),r=n??e;if(n&&(0,u.statSync)(n).isFile())r=(0,s.dirname)(n);let i=[],a=[];t&&t!==`system-default`&&a.push(t);for(let e of[`xdg-open`,`gio`]){let t=os(e);t&&a.push(t)}for(let e of[...new Set(a)])try{await us(e,(0,s.basename)(e)===`gio`?[`open`,r]:[r]);return}catch(t){i.push(`${e}: ${t instanceof Error?t.message:String(t)}`)}let{shell:o}=await import(`electron`),c=await o.openPath(r);if(!c)return;i.push(`electron: ${c}`);throw Error(`Failed to open file manager for ${r}: ${i.join(`; `)}`)}";

    if (next.includes(helperNeedle)) {
      console.log("  [patch] Add robust Linux file manager opener");
      next = replaceOnce(next, helperNeedle, helperReplacement, "linux file manager opener helper");
    } else if (next.includes("function mce(e){let{shell:t}=await import(`electron`)")) {
      console.log("  [ok] Linux file manager opener helper not needed in worker bundle");
    } else {
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

  const needle = "title:e.name?.trim()||null,cwd:e.cwd||null,";
  const replacement =
    "title:globalThis.__codexDesktopLinuxSummaryTitleFallback!==!1?e.name?.trim()||e.preview?.replace(/\\s+/g,` `).trim()||null:e.name?.trim()||null,cwd:e.cwd||null,";

  console.log("  [patch] Use thread preview as sidebar summary title fallback");
  return replaceOnce(code, needle, replacement, "renderer thread summary title fallback");
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

  const needle =
    "b=Object.fromEntries(g.map(({hostId:e})=>{let t=new Map((h[e]??$).map(e=>[k(e.dir),e]));return y[e]?.forEach(e=>{t.set(k(e.dir),e)}),[e,Array.from(t.values())]})),x=Vr([...Gr(n.data,h[o]??$,t(F,void 0).data?.codexHome),...Kr(M(t,l.LOCAL_PROJECTS)),...Jr(c,t(K))],M(t,l.PROJECT_ORDER)),";
  const replacement =
    "b=Object.fromEntries(g.map(({hostId:e})=>{let t=new Map((h[e]??$).map(e=>[k(e.dir),e]));return y[e]?.forEach(e=>{t.set(k(e.dir),e)}),[e,Array.from(t.values())]})),linuxWorkspaceRootData=globalThis.__codexDesktopLinuxThreadCwdWorkspaceRoots!==!1?{...n.data,roots:[...new Set([...(n.data?.roots??[]),...s.flatMap(t=>t.kind===`local`&&(t.hostId==null||t.hostId===`local`)&&t.cwd&&t.cwd!==`~`&&t.workspaceKind!==`projectless`&&!(Array.isArray(e.projectlessThreadIds)&&e.projectlessThreadIds.includes(t.conversationId))?[t.cwd]:[])])]}:n.data,x=Vr([...Gr(linuxWorkspaceRootData,h[o]??$,t(F,void 0).data?.codexHome),...Kr(M(t,l.LOCAL_PROJECTS)),...Jr(c,t(K))],M(t,l.PROJECT_ORDER)),";

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
}

main();
