const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CODEX_PROFILE_ALLOW_NAMES = new Set([
  ".codex-global-state.json",
  "auth.json",
  "installation_id",
]);

const DESKTOP_PROFILE_ALLOW_PATHS = [
  "Cookies",
  "Cookies-journal",
  "Local State",
  "Local Storage",
  "Preferences",
  "Partitions/codex-browser-app/Cookies",
  "Partitions/codex-browser-app/Cookies-journal",
  "Partitions/codex-browser-app/Local Storage",
  "Partitions/codex-browser-app/Preferences",
];

const PROFILE_SKIP_NAMES = new Set([
  ".tmp",
  "cache",
  "code cache",
  "crashpad",
  "dawngraphitecache",
  "dawnwebgpucache",
  "devtoolsactiveport",
  "gpucache",
  "lock",
  "log",
  "shadercache",
  "singletoncookie",
  "singletonlock",
  "singletonsocket",
  "transportsecurity",
]);

function fail(message) {
  throw new Error(message);
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function normalizedRelative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function desktopPathAllowed(relative) {
  if (!relative) return true;
  return DESKTOP_PROFILE_ALLOW_PATHS.some(
    (allowed) => relative === allowed || relative.startsWith(`${allowed}/`) || allowed.startsWith(`${relative}/`),
  );
}

function shouldCopyProfilePath(source, options = {}) {
  const base = path.basename(source);
  const lower = base.toLowerCase();
  if (PROFILE_SKIP_NAMES.has(lower)) return false;
  if (/\.(?:lock|log|pid|sock|socket|sqlite(?:-shm|-wal)?)$/i.test(base)) return false;
  if (/^\.org\.chromium\.Chromium\./.test(base)) return false;

  if (!options.root) return true;
  const relative = normalizedRelative(options.root, source);
  if (relative.startsWith("../") || relative === "..") return false;
  if (options.kind === "codex") return !relative || (!relative.includes("/") && CODEX_PROFILE_ALLOW_NAMES.has(relative));
  if (options.kind === "desktop") return desktopPathAllowed(relative);
  return true;
}

function secureCopiedTree(root) {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) fail(`Profile snapshot contains a symlink: ${root}`);
  fs.chmodSync(root, stat.isDirectory() ? 0o700 : 0o600);
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(root)) secureCopiedTree(path.join(root, entry));
}

function copyDirIfPresent(source, destination, kind = "desktop") {
  if (!fs.existsSync(source)) return false;
  if (!fs.lstatSync(source).isDirectory()) fail(`Profile source is not a directory: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (file) => {
      if (!shouldCopyProfilePath(file, { kind, root: source })) return false;
      if (fs.lstatSync(file).isSymbolicLink()) fail(`Profile source contains a symlink: ${file}`);
      return true;
    },
  });
  secureCopiedTree(destination);
  return true;
}

function fingerprintProfileSources(paths) {
  const fingerprints = {};
  for (const file of paths) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) fingerprints[file] = sha256File(file);
  }
  return fingerprints;
}

function fingerprintAllowedTree(root, kind) {
  const files = [];
  function walk(file) {
    if (!shouldCopyProfilePath(file, { kind, root })) return;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) fail(`Profile source contains a symlink: ${file}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file)) walk(path.join(file, entry));
    } else if (stat.isFile()) {
      files.push(file);
    }
  }
  if (fs.existsSync(root)) walk(root);
  return fingerprintProfileSources(files);
}

function assertProfileSourcesUnchanged(fingerprints) {
  for (const [file, before] of Object.entries(fingerprints)) {
    if (!fs.existsSync(file)) fail(`Source profile file disappeared during snapshot: ${file}`);
    if (sha256File(file) !== before) fail(`Source profile file changed during snapshot: ${file}`);
  }
}

function createTempRoot(prefix, tempRoot = os.tmpdir()) {
  tempRoot ||= os.tmpdir();
  fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(tempRoot, prefix));
  fs.chmodSync(root, 0o700);
  return root;
}

function sourcePaths(options = {}) {
  const home = options.home || os.homedir();
  const codexHome = options.sourceCodexHome || process.env.CODEX_HOME || path.join(home, ".codex");
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const userData = options.sourceUserData || path.join(configRoot, "Codex");
  return { codexHome, userData };
}

function createAuthSnapshot(options = {}) {
  const sources = sourcePaths(options);
  const authFile = path.join(sources.codexHome, "auth.json");
  if (!fs.existsSync(authFile)) fail(`Codex authentication is unavailable: ${authFile}`);

  const sourceFingerprints = {
    ...fingerprintAllowedTree(sources.codexHome, "codex"),
    ...fingerprintAllowedTree(sources.userData, "desktop"),
  };
  const root = createTempRoot("codex-acceptance-auth-", options.tempRoot);
  const codexHome = path.join(root, ".codex");
  const userData = path.join(root, ".config", "Codex");
  try {
    copyDirIfPresent(sources.codexHome, codexHome, "codex");
    copyDirIfPresent(sources.userData, userData, "desktop");
    assertProfileSourcesUnchanged(sourceFingerprints);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }

  return {
    assertSourceUnchanged: () => assertProfileSourcesUnchanged(sourceFingerprints),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    codexHome,
    copiedFiles: Object.keys(sourceFingerprints).length,
    root,
    sourceFingerprints,
    userData,
  };
}

function sensitiveStringsFromAuth(authFile) {
  if (!fs.existsSync(authFile)) return [];
  let value;
  try {
    value = JSON.parse(fs.readFileSync(authFile, "utf8"));
  } catch {
    return [];
  }
  const strings = new Set();
  function visit(item) {
    if (typeof item === "string") {
      if (item.length >= 16) strings.add(item);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) visit(child);
    }
  }
  visit(value);
  return [...strings];
}

module.exports = {
  CODEX_PROFILE_ALLOW_NAMES,
  DESKTOP_PROFILE_ALLOW_PATHS,
  assertProfileSourcesUnchanged,
  copyDirIfPresent,
  createAuthSnapshot,
  createTempRoot,
  fingerprintProfileSources,
  sensitiveStringsFromAuth,
  shouldCopyProfilePath,
  sourcePaths,
};
