#!/usr/bin/env node
/**
 * Fail-loud checks for the unsupported Linux rebuild path.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const SRC = path.join(PROJECT_ROOT, "src");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function fail(message) {
  console.error(`[x] ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`  [ok] ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function rel(file) {
  return path.relative(PROJECT_ROOT, file);
}

function readMagic(file, length = 4) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

function isElf(file) {
  const magic = readMagic(file);
  return magic.length >= 4 && magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46;
}

function isMachO(file) {
  const magic = readMagic(file);
  if (magic.length < 4) return false;
  const hex = magic.toString("hex");
  return ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(hex);
}

function walkFiles(root, visit) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkFiles(file, visit);
    else if (entry.isFile()) visit(file);
  }
}

function assertNoMachO(root, label) {
  const hits = [];
  walkFiles(root, (file) => {
    if (isMachO(file)) hits.push(file);
  });
  assert(hits.length === 0, `${label} contains Mach-O files:\n${hits.map((file) => `  - ${file}`).join("\n")}`);
  ok(`${label} contains no Mach-O files`);
}

function findMainBundle() {
  const buildDir = path.join(SRC, ".vite", "build");
  assert(fs.existsSync(buildDir), `Missing Linux build dir: ${rel(buildDir)}`);

  const candidates = fs
    .readdirSync(buildDir)
    .filter((name) => /^main(?:-[\w-]+)?\.js$/.test(name))
    .map((name) => path.join(buildDir, name));

  for (const file of candidates) {
    const code = fs.readFileSync(file, "utf8");
    if (code.includes("function Je(") && code.includes("threadCatalogSyncManager")) {
      return { file, code };
    }
  }

  fail("Could not locate Linux main bundle");
}

function findWebviewAppBundle() {
  const assetsDir = path.join(SRC, "webview", "assets");
  assert(fs.existsSync(assetsDir), `Missing Linux webview assets dir: ${rel(assetsDir)}`);

  const candidates = fs
    .readdirSync(assetsDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(assetsDir, name));

  for (const file of candidates) {
    const code = fs.readFileSync(file, "utf8");
    if (code.includes("function KMe(") && code.includes("localThreadCatalog")) {
      return { file, code };
    }
  }

  fail("Could not locate Linux webview app bundle");
}

function findWebviewAppShellBundle() {
  const assetsDir = path.join(SRC, "webview", "assets");
  assert(fs.existsSync(assetsDir), `Missing Linux webview assets dir: ${rel(assetsDir)}`);

  const candidates = fs
    .readdirSync(assetsDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(assetsDir, name));

  for (const file of candidates) {
    const code = fs.readFileSync(file, "utf8");
    if (code.includes("(0,OG.jsx)(L6t,{})") && code.includes("className:`relative flex flex-col`")) {
      return { file, code };
    }
  }

  fail("Could not locate Linux webview app shell bundle");
}

function findSidebarStateBundle() {
  const assetsDir = path.join(SRC, "webview", "assets");
  assert(fs.existsSync(assetsDir), `Missing Linux webview assets dir: ${rel(assetsDir)}`);

  const candidates = fs
    .readdirSync(assetsDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(assetsDir, name));

  for (const file of candidates) {
    const code = fs.readFileSync(file, "utf8");
    if (
      code.includes("3314958849") &&
      code.includes("hasLiveConversation:!1,summary:n")
    ) {
      return { file, code };
    }
  }

  fail("Could not locate Linux sidebar state bundle");
}

function findThreadStoreBundle() {
  const assetsDir = path.join(SRC, "webview", "assets");
  assert(fs.existsSync(assetsDir), `Missing Linux webview assets dir: ${rel(assetsDir)}`);

  const candidates = fs
    .readdirSync(assetsDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(assetsDir, name));

  for (const file of candidates) {
    const code = fs.readFileSync(file, "utf8");
    if (
      code.includes("async runRecentConversationRefresh") &&
      code.includes("async listRecentThreads") &&
      code.includes("mergeRecentThreadSummaries")
    ) {
      return { file, code };
    }
  }

  fail("Could not locate Linux thread store bundle");
}

function findSidebarAggregationBundle() {
  const assetsDir = path.join(SRC, "webview", "assets");
  assert(fs.existsSync(assetsDir), `Missing Linux webview assets dir: ${rel(assetsDir)}`);

  const candidates = fs
    .readdirSync(assetsDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(assetsDir, name));

  for (const file of candidates) {
    const code = fs.readFileSync(file, "utf8");
    if (
      code.includes("visibleRecentChatItems:L") &&
      code.includes("visibleSidebarSectionKeys:ne") &&
      code.includes("let L=r?")
    ) {
      return { file, code };
    }
  }

  fail("Could not locate Linux sidebar aggregation bundle");
}

function verifyPrepared() {
  console.log("-- verify-linux-desktop: prepared");

  const marker = path.join(SRC, ".build-mode");
  assert(fs.existsSync(marker), "Missing src/.build-mode; run prepare-src.js first");
  assert(fs.readFileSync(marker, "utf8").trim() === "linux", "src/.build-mode is not linux");
  ok("build mode is linux");

  const { code } = findMainBundle();
  assert(code.includes("linuxFeatureResult"), "Linux node_repl feature gate patch is missing");
  assert(code.includes("Thread catalog startup sync failed"), "Thread catalog startup sync patch is missing");
  assert(code.includes("case`linux-window-control`"), "Linux window control message patch is missing");
  assert(
    code.includes("n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:f9(r)}:{titleBarStyle:`default`}"),
    "Linux primary native titlebar patch is missing"
  );
  assert(code.includes("process.platform===`darwin`&&e.moveTop()"), "Linux hotkey window top policy patch is missing");
  assert(
    !code.includes(":{titleBarStyle:`default`,minimizable:!1,maximizable:!1,fullscreenable:!1,alwaysOnTop:!0}"),
    "Linux HUD always-on-top patch is missing"
  );
  assert(
    code.includes("process.platform===`win32`&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(f9(t)))"),
    "Linux titlebar overlay zoom update patch is missing"
  );
  assert(
    !code.includes("(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(f9(t)))"),
    "Linux titlebar overlay zoom update branch is still present"
  );
  assert(
    code.includes("if(process.platform!==`win32`||t!==`primary`)return;"),
    "Linux titlebar overlay install patch is missing"
  );
  assert(
    !code.includes("if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`)return;"),
    "Linux titlebar overlay install branch is still present"
  );
  const webview = findWebviewAppBundle();
  assert(webview.code.includes("r===!1||a==null?null"), "Renderer local thread catalog bridge patch is missing");
  const appShell = findWebviewAppShellBundle();
  assert(appShell.code.includes("data-codex-linux-window-controls"), "Renderer Linux window controls patch is missing");
  const sidebarState = findSidebarStateBundle();
  assert(
    sidebarState.code.includes("__codexDesktopLinuxStateDbSidebar"),
    "Renderer state DB sidebar source patch is missing"
  );
  const threadStore = findThreadStoreBundle();
  assert(
    threadStore.code.includes("__codexDesktopLinuxSidebarThreadSummaries"),
    "Renderer sidebar thread summaries patch is missing"
  );
  const sidebarAggregation = findSidebarAggregationBundle();
  assert(
    sidebarAggregation.code.includes("__codexDesktopLinuxUngroupedSidebarFallback"),
    "Renderer ungrouped sidebar fallback patch is missing"
  );
  ok("Linux runtime bundle patches are present");

  assert(!fs.existsSync(path.join(SRC, "cua_node")), "Flat Linux src/ must not contain cua_node");
  assert(!fs.existsSync(path.join(SRC, "node_repl")), "Flat Linux src/ must not contain node_repl");
  ok("macOS-only runtime paths are absent from flat src/");

  for (const dir of [".vite", "webview", "skills", "native-menu-locales", "node_modules"]) {
    assertNoMachO(path.join(SRC, dir), `src/${dir}`);
  }
}

function archDirFor(platform) {
  return platform === "linux-arm64" ? "arm64" : "x64";
}

function findLatestDeb(platform) {
  const dir = path.join(PROJECT_ROOT, "out", "make", "deb", archDirFor(platform));
  assert(fs.existsSync(dir), `Missing deb output dir: ${rel(dir)}`);
  const debs = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".deb"))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  assert(debs.length > 0, `No deb found in ${rel(dir)}`);
  return debs[0];
}

function dpkgDeb(args) {
  try {
    return execFileSync("dpkg-deb", args, { encoding: "utf8", maxBuffer: 200 * 1024 * 1024 });
  } catch (error) {
    fail(`dpkg-deb ${args.join(" ")} failed: ${error.message}`);
  }
}

function verifyPackage(platform) {
  console.log(`-- verify-linux-desktop: package (${platform})`);

  const deb = findLatestDeb(platform);
  ok(`checking ${rel(deb)}`);

  const contents = dpkgDeb(["-c", deb]);
  assert(!contents.includes("./usr/bin/codex ->"), "Package must not install /usr/bin/codex");
  assert(contents.includes("./usr/bin/codex-desktop -> ../lib/codex-desktop/Codex"), "Package must install /usr/bin/codex-desktop");
  assert(!contents.includes("/cua_node/"), "Package must not include cua_node");
  ok("deb entrypoints and macOS-only resources are correct");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desktop-deb-"));
  try {
    dpkgDeb(["-x", deb, tempDir]);
    const libRoot = path.join(tempDir, "usr", "lib", "codex-desktop");
    const resources = path.join(libRoot, "resources");
    const desktopEntry = path.join(tempDir, "usr", "share", "applications", "codex-desktop.desktop");
    const pixmapIcon = path.join(tempDir, "usr", "share", "pixmaps", "codex-desktop.png");

    assert(fs.existsSync(path.join(libRoot, "Codex")), "Packaged Electron executable is missing");
    assert(fs.existsSync(desktopEntry), "Packaged desktop entry is missing");
    assert(fs.existsSync(pixmapIcon), "Packaged desktop icon is missing");
    const desktopText = fs.readFileSync(desktopEntry, "utf8");
    assert(desktopText.includes("Icon=codex-desktop"), "Desktop entry must reference codex-desktop icon");
    assert(desktopText.includes("StartupWMClass=codex"), "Desktop entry must include StartupWMClass=codex");
    ok("desktop launcher metadata is correct");

    const appAsar = path.join(resources, "app.asar");
    assert(fs.existsSync(appAsar), "Packaged app.asar is missing");
    const appAsarContent = fs.readFileSync(appAsar);
    assert(appAsarContent.includes(Buffer.from("linuxFeatureResult")), "Packaged app.asar is missing Linux node_repl feature gate patch");
    assert(appAsarContent.includes(Buffer.from("Thread catalog startup sync failed")), "Packaged app.asar is missing thread catalog startup sync patch");
    assert(appAsarContent.includes(Buffer.from("case`linux-window-control`")), "Packaged app.asar is missing Linux window control message patch");
    assert(
      appAsarContent.includes(Buffer.from("n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:f9(r)}:{titleBarStyle:`default`}")),
      "Packaged app.asar is missing Linux primary native titlebar patch"
    );
    assert(
      appAsarContent.includes(Buffer.from("process.platform===`darwin`&&e.moveTop()")),
      "Packaged app.asar is missing Linux hotkey window top policy patch"
    );
    assert(
      !appAsarContent.includes(Buffer.from(":{titleBarStyle:`default`,minimizable:!1,maximizable:!1,fullscreenable:!1,alwaysOnTop:!0}")),
      "Packaged app.asar is missing Linux HUD always-on-top patch"
    );
    assert(
      appAsarContent.includes(Buffer.from("process.platform===`win32`&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(f9(t)))")),
      "Packaged app.asar is missing Linux titlebar overlay zoom update patch"
    );
    assert(
      !appAsarContent.includes(Buffer.from("(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(f9(t)))")),
      "Packaged app.asar still contains Linux titlebar overlay zoom update branch"
    );
    assert(
      appAsarContent.includes(Buffer.from("if(process.platform!==`win32`||t!==`primary`)return;")),
      "Packaged app.asar is missing Linux titlebar overlay install patch"
    );
    assert(
      !appAsarContent.includes(Buffer.from("if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`)return;")),
      "Packaged app.asar still contains Linux titlebar overlay install branch"
    );
    assert(appAsarContent.includes(Buffer.from("r===!1||a==null?null")), "Packaged app.asar is missing renderer local thread catalog bridge patch");
    assert(
      appAsarContent.includes(Buffer.from("data-codex-linux-window-controls")),
      "Packaged app.asar is missing renderer Linux window controls patch"
    );
    assert(
      appAsarContent.includes(Buffer.from("__codexDesktopLinuxStateDbSidebar")),
      "Packaged app.asar is missing renderer state DB sidebar source patch"
    );
    assert(
      appAsarContent.includes(Buffer.from("__codexDesktopLinuxSidebarThreadSummaries")),
      "Packaged app.asar is missing renderer sidebar thread summaries patch"
    );
    assert(
      appAsarContent.includes(Buffer.from("__codexDesktopLinuxUngroupedSidebarFallback")),
      "Packaged app.asar is missing renderer ungrouped sidebar fallback patch"
    );
    assert(fs.existsSync(path.join(resources, "codex")), "Packaged Codex CLI binary is missing");
    assert(fs.existsSync(path.join(resources, "rg")), "Packaged rg binary is missing");
    ok("packaged app.asar contains Linux runtime patches");

    assert(isElf(path.join(resources, "codex")), "Packaged resources/codex must be a Linux ELF binary");
    assert(isElf(path.join(resources, "rg")), "Packaged resources/rg must be a Linux ELF binary");
    assert(!fs.existsSync(path.join(resources, "cua_node")), "Extracted package must not contain resources/cua_node");
    ok("packaged Codex CLI and rg are Linux ELF binaries");

    assertNoMachO(libRoot, "extracted deb");
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

function main() {
  const stage = argValue("--stage", "prepared");
  const platform = argValue("--platform", "linux-x64");

  if (!["linux-x64", "linux-arm64"].includes(platform)) {
    fail(`Unsupported --platform ${platform}`);
  }

  if (stage === "prepared") verifyPrepared();
  else if (stage === "package") verifyPackage(platform);
  else if (stage === "all") {
    verifyPrepared();
    verifyPackage(platform);
  } else {
    fail(`Unsupported --stage ${stage}`);
  }
}

main();
