#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { checkMacX64Version } = require("./check-update");
const { loadPinnedInputs } = require("./pinned-inputs");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PACKAGE_PATH = path.join(PROJECT_ROOT, "package.json");
const TEMP_DIR = path.join(os.tmpdir(), "codex-sync");
const MAC_CLI_VERSION_PATTERN =
  /codex\.plugin_install_elicitation_sent(\d+\.\d+\.\d+)timing_metrics/;

function findSevenZip() {
  for (const command of ["7zz", "7z"]) {
    try {
      execFileSync(command, ["--help"], { stdio: "ignore" });
      return command;
    } catch {}
  }
  throw new Error("7zz or 7z is required to inspect the macOS archive");
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
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

function downloadArchive(url, destination, force) {
  if (!force && fs.existsSync(destination)) {
    console.log(`   [cache] ${destination}`);
    return;
  }
  const partial = `${destination}.download`;
  fs.rmSync(partial, { force: true });
  try {
    execFileSync(
      "curl",
      ["-L", "--fail", "--retry", "3", "--retry-delay", "2", "-o", partial, url],
      { stdio: "inherit" },
    );
    fs.rmSync(destination, { force: true });
    fs.renameSync(partial, destination);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
}

function findMacCliEntryFromListing(listing) {
  const entries = listing
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Path = "))
    .map((line) => line.slice("Path = ".length));
  const matches = entries.filter((entry) => /^[^/]+\.app\/Contents\/Resources\/codex$/.test(entry));
  if (matches.length !== 1) {
    throw new Error(`Expected one bundled macOS Codex CLI, found ${matches.length}`);
  }
  return matches[0];
}

function findMacCliEntry(archivePath, sevenZip) {
  const listing = execFileSync(sevenZip, ["l", "-slt", archivePath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return findMacCliEntryFromListing(listing);
}

function extractMacCli(archivePath, destination) {
  const sevenZip = findSevenZip();
  const entry = findMacCliEntry(archivePath, sevenZip);
  const output = fs.openSync(destination, "w");
  try {
    execFileSync(sevenZip, ["e", "-so", archivePath, entry], {
      stdio: ["ignore", output, "inherit"],
    });
  } finally {
    fs.closeSync(output);
  }
}

function extractMacCliVersion(binaryPath) {
  const fd = fs.openSync(binaryPath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  let carry = "";
  const matches = new Set();
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      const text = carry + buffer.subarray(0, bytes).toString("latin1");
      for (const match of text.matchAll(new RegExp(MAC_CLI_VERSION_PATTERN.source, "g"))) {
        matches.add(match[1]);
      }
      carry = text.slice(-256);
    }
  } finally {
    fs.closeSync(fd);
  }
  if (matches.size !== 1) {
    throw new Error(`Could not determine one macOS bundled CLI version; found: ${[...matches].join(", ") || "none"}`);
  }
  return [...matches][0];
}

function selectLinuxCliPackage(macCliVersion, macAppPublishedAt, npmTimes) {
  const exactBase = `${macCliVersion}-cometix`;
  const exactPlatform = `${exactBase}-linux-x64`;
  if (npmTimes[exactBase] && npmTimes[exactPlatform]) {
    return {
      version: exactBase,
      selectedBy: "exact-mac-cli-version",
      packagePublishedAt: new Date(npmTimes[exactPlatform]).toISOString(),
    };
  }

  const cutoff = Date.parse(macAppPublishedAt);
  if (!Number.isFinite(cutoff)) throw new Error(`Invalid macOS app publication date: ${macAppPublishedAt}`);
  const candidates = Object.entries(npmTimes)
    .filter(([version]) => /^\d+\.\d+\.\d+-cometix-linux-x64$/.test(version))
    .map(([platformVersion, publishedAt]) => ({
      platformVersion,
      version: platformVersion.slice(0, -"-linux-x64".length),
      publishedAt: Date.parse(publishedAt),
    }))
    .filter((candidate) => npmTimes[candidate.version] && candidate.publishedAt <= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt);
  if (candidates.length === 0) {
    throw new Error(`No Linux x64 CLI package was published by ${macAppPublishedAt}`);
  }
  return {
    version: candidates[0].version,
    selectedBy: "latest-linux-x64-published-before-mac-app",
    packagePublishedAt: new Date(candidates[0].publishedAt).toISOString(),
  };
}

function getNpmTimes() {
  const output = execFileSync("npm", ["view", "@cometix/codex", "time", "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(output);
}

async function main() {
  const force = process.argv.includes("--force");
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  console.log("== Update pinned x64 inputs ==\n");
  const upstream = await checkMacX64Version();
  if (!upstream.downloadUrl || !upstream.size || !upstream.pubDate || !upstream.build) {
    throw new Error("macOS x64 appcast entry is missing URL, size, publication date, or build");
  }
  const macAppPublishedAt = new Date(upstream.pubDate).toISOString();
  const archivePath = path.join(TEMP_DIR, `Codex-x64-${upstream.version}.zip`);
  console.log(`   desktop: ${upstream.version} (build ${upstream.build})`);
  downloadArchive(upstream.downloadUrl, archivePath, force);
  const stat = fs.statSync(archivePath);
  if (stat.size !== upstream.size) {
    throw new Error(`Downloaded archive size ${stat.size} does not match appcast ${upstream.size}`);
  }
  console.log("   [hash] SHA-256");
  const sha256 = sha256File(archivePath);

  const macCliPath = path.join(TEMP_DIR, `codex-mac-x64-${upstream.version}`);
  console.log("   [inspect] bundled macOS Codex CLI");
  extractMacCli(archivePath, macCliPath);
  const macBundledVersion = extractMacCliVersion(macCliPath);
  fs.rmSync(macCliPath, { force: true });
  console.log(`   mac CLI: ${macBundledVersion}`);

  const cli = selectLinuxCliPackage(macBundledVersion, macAppPublishedAt, getNpmTimes());
  console.log(`   linux CLI: ${cli.version} (${cli.selectedBy})`);

  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  pkg.version = upstream.version;
  pkg.codexBuildNumber = String(upstream.build);
  pkg.codexCliVersion = cli.version;
  pkg.codexCliSource = {
    macBundledVersion,
    packageVersion: cli.version,
    selectedBy: cli.selectedBy,
    packagePublishedAt: cli.packagePublishedAt,
    macAppPublishedAt,
  };
  pkg.codexUpstream = pkg.codexUpstream || {};
  pkg.codexUpstream["mac-x64"] = {
    version: upstream.version,
    build: String(upstream.build),
    url: upstream.downloadUrl,
    size: upstream.size,
    sha256,
  };

  const tempPackagePath = `${PACKAGE_PATH}.tmp`;
  fs.writeFileSync(tempPackagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  fs.renameSync(tempPackagePath, PACKAGE_PATH);
  loadPinnedInputs();
  console.log("\n   [ok] package.json pins updated");
}

module.exports = {
  extractMacCliVersion,
  findMacCliEntryFromListing,
  selectLinuxCliPackage,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n[x] ${error.message}`);
    process.exit(1);
  });
}
