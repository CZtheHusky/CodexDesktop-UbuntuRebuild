const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  assertExtractedVersion,
  loadPinnedInputs,
  verifyPinnedFile,
} = require("./pinned-inputs");
const {
  extractMacCliVersion,
  findMacCliEntryFromListing,
  selectLinuxCliPackage,
} = require("./update-pinned-inputs");

test("the branch version and build are locked to its mac-x64 input", () => {
  const pins = loadPinnedInputs();
  assert.equal(pins.macX64.version, "26.707.71524");
  assert.equal(pins.macX64.build, "5263");
  assert.equal(pins.codexCliVersion, "0.144.1-cometix");
  assert.equal(pins.cliSource.macBundledVersion, "0.144.2");
  assert.equal(pins.cliSource.selectedBy, "latest-linux-x64-published-before-mac-app");
});

test("a stale or corrupted same-size cache cannot be used", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pin-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const archive = path.join(tempDir, "archive.zip");
  const expected = Buffer.from("expected archive");
  fs.writeFileSync(archive, expected);
  const pin = {
    size: expected.length,
    sha256: crypto.createHash("sha256").update(expected).digest("hex"),
  };

  await verifyPinnedFile(archive, pin, "fixture");
  fs.writeFileSync(archive, Buffer.from("corrupted archiv"));
  await assert.rejects(verifyPinnedFile(archive, pin, "fixture"), /SHA-256 mismatch/);
});

test("extracted app metadata must match the branch pin", (t) => {
  const asarDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-asar-test-"));
  t.after(() => fs.rmSync(asarDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(asarDir, "package.json"),
    JSON.stringify({ version: "26.707.71524", codexBuildNumber: "5263" }),
  );
  const pin = { version: "26.707.71524", build: "5263" };

  assert.doesNotThrow(() => assertExtractedVersion(asarDir, pin, "fixture"));
  fs.writeFileSync(
    path.join(asarDir, "package.json"),
    JSON.stringify({ version: "26.707.61608", codexBuildNumber: "5200" }),
  );
  assert.throws(() => assertExtractedVersion(asarDir, pin, "fixture"), /does not match pin/);
});

test("build scripts cannot regress to resolving the latest CLI or x64 appcast", () => {
  const prepare = fs.readFileSync(path.join(__dirname, "prepare-src.js"), "utf-8");
  const repackage = fs.readFileSync(path.join(__dirname, "build-from-upstream.js"), "utf-8");
  const sync = fs.readFileSync(path.join(__dirname, "sync-upstream.js"), "utf-8");

  assert.doesNotMatch(prepare, /npm view @cometix\/codex version/);
  assert.doesNotMatch(repackage, /npm view @cometix\/codex version/);
  assert.doesNotMatch(sync, /APPCAST_X64/);
});

test("macOS CLI version extraction uses the Codex-owned binary metadata anchor", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mac-cli-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const binary = path.join(tempDir, "codex");
  fs.writeFileSync(
    binary,
    "dependency-9.9.9\0codex.plugin_install_elicitation_sent0.144.2timing_metrics\0",
  );

  assert.equal(extractMacCliVersion(binary), "0.144.2");
});

test("CLI selection prefers an exact macOS version, then falls back by publication time", () => {
  const times = {
    "0.144.0-cometix": "2026-07-12T17:50:27.101Z",
    "0.144.0-cometix-linux-x64": "2026-07-12T17:50:07.801Z",
    "0.144.1-cometix": "2026-07-12T21:43:43.638Z",
    "0.144.1-cometix-linux-x64": "2026-07-12T21:43:25.245Z",
    "0.144.2-cometix": "2026-07-14T02:00:00.000Z",
    "0.144.2-cometix-linux-x64": "2026-07-14T01:59:00.000Z",
  };

  assert.deepEqual(
    selectLinuxCliPackage("0.144.2", "2026-07-14T00:50:28.000Z", times),
    {
      version: "0.144.2-cometix",
      selectedBy: "exact-mac-cli-version",
      packagePublishedAt: "2026-07-14T01:59:00.000Z",
    },
  );
  delete times["0.144.2-cometix"];
  delete times["0.144.2-cometix-linux-x64"];
  assert.deepEqual(
    selectLinuxCliPackage("0.144.2", "2026-07-14T00:50:28.000Z", times),
    {
      version: "0.144.1-cometix",
      selectedBy: "latest-linux-x64-published-before-mac-app",
      packagePublishedAt: "2026-07-12T21:43:25.245Z",
    },
  );
});

test("archive inspection requires exactly one top-level app CLI", () => {
  const listing = [
    "Path = archive.zip",
    "Path = ChatGPT.app/Contents/Resources/codex",
    "Path = ChatGPT.app/Contents/Resources/cua_node/bin/codex",
  ].join("\n");
  assert.equal(findMacCliEntryFromListing(listing), "ChatGPT.app/Contents/Resources/codex");
});
