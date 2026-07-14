#!/usr/bin/env node
/**
 * Parse-check generated Linux JavaScript bundles after runtime patching.
 *
 * This intentionally checks all generated main/renderer bundles we package,
 * not just the files touched by the latest patch, so syntax regressions fail
 * before the app reaches day-to-day use.
 */
const fs = require("fs");
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

function rel(file) {
  return path.relative(PROJECT_ROOT, file);
}

function walkJavaScriptFiles(root) {
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(file);
    }
  }

  if (fs.existsSync(root)) walk(root);
  return files;
}

function bundleRoots() {
  return [path.join(SRC, ".vite", "build"), path.join(SRC, "webview", "assets")];
}

function collectBundleFiles() {
  const roots = bundleRoots();
  const missing = roots.filter((root) => !fs.existsSync(root));
  if (missing.length > 0) {
    fail(`Missing generated bundle dirs:\n${missing.map((root) => `  - ${rel(root)}`).join("\n")}`);
  }
  return roots.flatMap(walkJavaScriptFiles).sort();
}

function checkSyntax(files) {
  const failures = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ["--check", file], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      failures.push({
        file,
        output: `${error.stdout || ""}${error.stderr || ""}`.trim(),
      });
    }
  }
  return failures;
}

function main() {
  const platform = argValue("--platform", "linux-x64");
  if (!["linux-x64", "linux-arm64"].includes(platform)) fail(`Unsupported --platform ${platform}`);

  const files = collectBundleFiles();
  if (files.length === 0) fail("No generated JavaScript bundles found to syntax-check");

  const failures = checkSyntax(files);
  if (failures.length > 0) {
    const detail = failures
      .map(({ file, output }) => `  - ${rel(file)}\n${output.split("\n").map((line) => `    ${line}`).join("\n")}`)
      .join("\n");
    fail(`JavaScript syntax check failed:\n${detail}`);
  }

  console.log(`-- verify-linux-syntax: ${files.length} generated JavaScript bundle(s) parse successfully (${platform})`);
}

if (require.main === module) main();

module.exports = {
  bundleRoots,
  collectBundleFiles,
  checkSyntax,
  walkJavaScriptFiles,
};
