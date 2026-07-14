const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");

function loadPinnedInputs(projectRoot = PROJECT_ROOT) {
  const packagePath = path.join(projectRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
  const macX64 = pkg.codexUpstream?.["mac-x64"];

  if (!macX64 || typeof macX64 !== "object") {
    throw new Error("package.json: codexUpstream.mac-x64 is required");
  }
  for (const field of ["version", "build", "url", "sha256"]) {
    if (typeof macX64[field] !== "string" || !macX64[field]) {
      throw new Error(`package.json: codexUpstream.mac-x64.${field} is required`);
    }
  }
  if (!Number.isSafeInteger(macX64.size) || macX64.size <= 0) {
    throw new Error("package.json: codexUpstream.mac-x64.size must be a positive integer");
  }
  if (!/^https:\/\/persistent\.oaistatic\.com\//.test(macX64.url)) {
    throw new Error("package.json: codexUpstream.mac-x64.url must use the official HTTPS host");
  }
  if (!/^[a-f0-9]{64}$/.test(macX64.sha256)) {
    throw new Error("package.json: codexUpstream.mac-x64.sha256 must be a lowercase SHA-256 digest");
  }
  if (pkg.version !== macX64.version) {
    throw new Error(
      `package.json version ${pkg.version} does not match pinned mac-x64 version ${macX64.version}`,
    );
  }
  if (String(pkg.codexBuildNumber || "") !== macX64.build) {
    throw new Error(
      `package.json codexBuildNumber ${pkg.codexBuildNumber || "<missing>"} does not match pinned mac-x64 build ${macX64.build}`,
    );
  }
  if (typeof pkg.codexCliVersion !== "string" || !/^\d+\.\d+\.\d+-cometix$/.test(pkg.codexCliVersion)) {
    throw new Error("package.json: codexCliVersion must pin an exact base version such as 0.144.1-cometix");
  }
  const cliSource = pkg.codexCliSource;
  if (!cliSource || typeof cliSource !== "object") {
    throw new Error("package.json: codexCliSource is required");
  }
  if (!/^\d+\.\d+\.\d+$/.test(cliSource.macBundledVersion || "")) {
    throw new Error("package.json: codexCliSource.macBundledVersion must be an exact version");
  }
  if (cliSource.packageVersion !== pkg.codexCliVersion) {
    throw new Error("package.json: codexCliSource.packageVersion must match codexCliVersion");
  }
  const selectors = new Set([
    "exact-mac-cli-version",
    "latest-linux-x64-published-before-mac-app",
  ]);
  if (!selectors.has(cliSource.selectedBy)) {
    throw new Error("package.json: codexCliSource.selectedBy is invalid");
  }
  const packagePublishedAt = Date.parse(cliSource.packagePublishedAt || "");
  const macAppPublishedAt = Date.parse(cliSource.macAppPublishedAt || "");
  if (!Number.isFinite(packagePublishedAt) || !Number.isFinite(macAppPublishedAt)) {
    throw new Error("package.json: codexCliSource publication timestamps must be valid dates");
  }
  if (
    cliSource.selectedBy === "latest-linux-x64-published-before-mac-app" &&
    packagePublishedAt > macAppPublishedAt
  ) {
    throw new Error("package.json: fallback CLI package must not be newer than the macOS app");
  }
  if (
    cliSource.selectedBy === "exact-mac-cli-version" &&
    pkg.codexCliVersion !== `${cliSource.macBundledVersion}-cometix`
  ) {
    throw new Error("package.json: exact CLI selection must match the macOS bundled CLI version");
  }

  return { macX64, codexCliVersion: pkg.codexCliVersion, cliSource };
}

async function verifyPinnedFile(filePath, pin, label) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`${label}: archive not found: ${filePath}`);
  }
  if (stat.size !== pin.size) {
    throw new Error(`${label}: size mismatch: expected ${pin.size}, got ${stat.size}`);
  }

  const actual = await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
  if (actual !== pin.sha256) {
    throw new Error(`${label}: SHA-256 mismatch: expected ${pin.sha256}, got ${actual}`);
  }
}

function assertExtractedVersion(asarDir, pin, label) {
  const packagePath = path.join(asarDir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
  } catch (error) {
    throw new Error(`${label}: cannot read extracted package.json: ${error.message}`);
  }
  if (pkg.version !== pin.version) {
    throw new Error(`${label}: extracted version ${pkg.version || "<missing>"} does not match pin ${pin.version}`);
  }
  if (String(pkg.codexBuildNumber || "") !== pin.build) {
    throw new Error(
      `${label}: extracted build ${pkg.codexBuildNumber || "<missing>"} does not match pin ${pin.build}`,
    );
  }
}

module.exports = { assertExtractedVersion, loadPinnedInputs, verifyPinnedFile };
