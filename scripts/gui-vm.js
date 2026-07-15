#!/usr/bin/env node
/** Manage the isolated KVM desktop used by Linux GUI acceptance. */
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const PROJECT_ROOT = path.join(__dirname, "..");
const STATE_ROOT = path.join(PROJECT_ROOT, "vm-state");
const IMAGE_ROOT = path.join(STATE_ROOT, "images");
const RUNTIME_ROOT = path.join(STATE_ROOT, "runtime");
const SCREENSHOT_ROOT = path.join(STATE_ROOT, "screenshots");
const CLOUD_IMAGE = path.join(IMAGE_ROOT, "ubuntu-24.04-server-cloudimg-amd64.img");
const BASELINE_DISK = path.join(STATE_ROOT, "baseline.qcow2");
const WORKING_DISK = path.join(STATE_ROOT, "working.qcow2");
const SEED_DISK = path.join(STATE_ROOT, "cloud-init-seed.img");
const SSH_KEY = path.join(STATE_ROOT, "id_ed25519");
const PID_FILE = path.join(RUNTIME_ROOT, "qemu.pid");
const QMP_SOCKET = path.join(RUNTIME_ROOT, "qmp.sock");
const QGA_SOCKET = path.join(RUNTIME_ROOT, "qga.sock");
const LOG_FILE = path.join(RUNTIME_ROOT, "qemu.log");
const CLOUD_IMAGE_URL = "https://cloud-images.ubuntu.com/releases/noble/release-20260705/ubuntu-24.04-server-cloudimg-amd64.img";
const CLOUD_IMAGE_SHA256 = "ffe6203da54deeb6db5d2a98a83f9ec8e55f149d3f7ba622e1abe5fa966ee3d6";
const SSH_PORT = 22222;
const SPICE_PORT = 5930;
const HOST_PROXY_PORT = 7897;
const VM_USER = "codex-test";
const UPDATE_NOTIFIER_OVERRIDE = `[Desktop Entry]\nType=Application\nName=Update Notifier\nHidden=true\n`;
const REQUIRED_COMMANDS = ["cloud-localds", "curl", "qemu-img", "qemu-system-x86_64", "ssh", "ssh-keygen"];

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`${command} exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function ensureCommands() {
  for (const command of REQUIRED_COMMANDS) {
    const result = run("sh", ["-c", `command -v ${command}`], { allowFailure: true });
    if (result.status !== 0) fail(`Missing required command: ${command}`);
  }
  if (!fs.existsSync("/dev/kvm")) fail("/dev/kvm is unavailable; run this command outside the filesystem sandbox");
}

function ensureDirectories() {
  for (const dir of [STATE_ROOT, IMAGE_ROOT, RUNTIME_ROOT, SCREENSHOT_ROOT]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
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

function ensureCloudImage() {
  if (fs.existsSync(CLOUD_IMAGE) && sha256File(CLOUD_IMAGE) === CLOUD_IMAGE_SHA256) return;
  const partial = `${CLOUD_IMAGE}.partial`;
  console.log(`[vm] Downloading ${CLOUD_IMAGE_URL}`);
  run("curl", ["--fail", "--location", "--continue-at", "-", "--output", partial, CLOUD_IMAGE_URL], { inherit: true });
  const actual = sha256File(partial);
  if (actual !== CLOUD_IMAGE_SHA256) {
    fail(`Cloud image SHA-256 mismatch: expected ${CLOUD_IMAGE_SHA256}, got ${actual}`);
  }
  fs.renameSync(partial, CLOUD_IMAGE);
}

function ensureSshKey() {
  if (!fs.existsSync(SSH_KEY)) {
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "codex-gui-acceptance", "-f", SSH_KEY]);
  }
  fs.chmodSync(SSH_KEY, 0o600);
  const publicKey = fs.readFileSync(`${SSH_KEY}.pub`, "utf8").trim();
  if (!publicKey.startsWith("ssh-ed25519 ")) fail("Unexpected VM SSH public key format");
  return publicKey;
}

function renderCloudInit(publicKey) {
  const template = fs.readFileSync(path.join(PROJECT_ROOT, "vm", "cloud-init", "user-data.yaml"), "utf8");
  if (!template.includes("__SSH_PUBLIC_KEY__")) fail("Cloud-init template is missing its SSH key placeholder");
  const userData = path.join(STATE_ROOT, "user-data.yaml");
  const metaData = path.join(STATE_ROOT, "meta-data.yaml");
  fs.writeFileSync(userData, template.replace("__SSH_PUBLIC_KEY__", publicKey), { mode: 0o600 });
  fs.writeFileSync(metaData, "instance-id: codex-gui-acceptance-v1\nlocal-hostname: codex-gui-acceptance\n", { mode: 0o600 });
  run("cloud-localds", [SEED_DISK, userData, metaData]);
}

function readPid() {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = Number.parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

function isRunning() {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function qemuArgs(disk) {
  return [
    "-name", "codex-gui-acceptance",
    "-machine", "q35,accel=kvm",
    "-cpu", "host",
    "-smp", "4",
    "-m", "8192",
    "-drive", `file=${disk},if=virtio,format=qcow2,cache=writeback,discard=unmap`,
    "-drive", `file=${SEED_DISK},if=virtio,format=raw,readonly=on`,
    "-netdev", `user,id=net0,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22`,
    "-device", "virtio-net-pci,netdev=net0",
    "-device", "virtio-serial-pci",
    "-chardev", `socket,path=${QGA_SOCKET},server=on,wait=off,id=qga0`,
    "-device", "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0",
    "-display", "none",
    "-spice", `addr=127.0.0.1,port=${SPICE_PORT},disable-ticketing=on`,
    "-vga", "virtio",
    "-device", "qemu-xhci",
    "-device", "usb-tablet",
    "-qmp", `unix:${QMP_SOCKET},server=on,wait=off`,
    "-daemonize",
    "-pidfile", PID_FILE,
  ];
}

function startQemu(disk) {
  if (isRunning()) fail(`VM is already running with PID ${readPid()}`);
  for (const file of [PID_FILE, QMP_SOCKET, QGA_SOCKET]) fs.rmSync(file, { force: true });
  fs.rmSync(path.join(STATE_ROOT, "known_hosts"), { force: true });
  const logFd = fs.openSync(LOG_FILE, "a", 0o600);
  try {
    run("qemu-system-x86_64", qemuArgs(disk), { stdio: ["ignore", logFd, logFd] });
  } finally {
    fs.closeSync(logFd);
  }
  if (!isRunning()) fail(`QEMU did not stay running; inspect ${LOG_FILE}`);
  console.log(`[vm] Started PID ${readPid()}; SSH 127.0.0.1:${SSH_PORT}; SPICE 127.0.0.1:${SPICE_PORT}`);
}

function sshArgs(command = null) {
  const args = [
    "-p", String(SSH_PORT),
    "-i", SSH_KEY,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", `UserKnownHostsFile=${path.join(STATE_ROOT, "known_hosts")}`,
    `${VM_USER}@127.0.0.1`,
  ];
  if (command) args.push(command);
  return args;
}

function proxyTunnelArgs() {
  return [
    "-p", String(SSH_PORT),
    "-i", SSH_KEY,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", `UserKnownHostsFile=${path.join(STATE_ROOT, "known_hosts")}`,
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-f", "-N", "-T",
    "-R", `127.0.0.1:${HOST_PROXY_PORT}:127.0.0.1:${HOST_PROXY_PORT}`,
    `${VM_USER}@127.0.0.1`,
  ];
}

function ssh(command, options = {}) {
  return run("ssh", sshArgs(command), options);
}

function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(1000, until - Date.now()));
}

function waitForSsh(timeoutMs = 20 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = ssh("true", { allowFailure: true });
    if (result.status === 0) return;
    if (!isRunning()) fail(`VM stopped while waiting for SSH; inspect ${LOG_FILE}`);
    sleep(5000);
  }
  fail(`Timed out waiting for VM SSH after ${Math.round(timeoutMs / 60000)} minutes`);
}

function proxyEgress() {
  const result = ssh(`curl --proxy http://127.0.0.1:${HOST_PROXY_PORT} --max-time 15 --silent --show-error https://api.ipify.org`, {
    allowFailure: true,
  });
  const address = (result.stdout || "").trim();
  return result.status === 0 && /^[0-9a-f:.]+$/i.test(address) ? address : null;
}

function startProxyTunnel() {
  const existing = proxyEgress();
  if (existing) {
    console.log(`[vm] Reverse proxy tunnel ready (egress ${existing})`);
    return;
  }
  run("ssh", proxyTunnelArgs());
  for (let attempt = 0; attempt < 10; attempt += 1) {
    sleep(1000);
    const address = proxyEgress();
    if (address) {
      console.log(`[vm] Reverse proxy tunnel ready (egress ${address})`);
      return;
    }
  }
  fail(`VM proxy verification failed on 127.0.0.1:${HOST_PROXY_PORT}`);
}

function waitForDesktop(timeoutMs = 10 * 60 * 1000) {
  const command = "test -f /var/lib/codex-gui-provisioned && systemctl is-active --quiet gdm3 && pgrep -u codex-test -x gnome-shell >/dev/null";
  const deadline = Date.now() + timeoutMs;
  let stableChecks = 0;
  while (Date.now() < deadline) {
    if (ssh(command, { allowFailure: true }).status === 0) {
      stableChecks += 1;
      if (stableChecks >= 5) {
        prepareDesktop();
        return;
      }
    } else {
      stableChecks = 0;
    }
    sleep(5000);
  }
  fail("Timed out waiting for a stable auto-login GNOME desktop");
}

function prepareDesktop() {
  run("ssh", sshArgs("install -D -m 0644 /dev/stdin ~/.config/autostart/update-notifier.desktop"), {
    input: UPDATE_NOTIFIER_OVERRIDE,
    stdio: ["pipe", "pipe", "pipe"],
  });
  ssh("pkill -x update-notifier", { allowFailure: true });
  ssh("pkill -x update-manager", { allowFailure: true });
}

function waitForStop(timeoutMs = 45 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning()) {
      for (const file of [PID_FILE, QMP_SOCKET, QGA_SOCKET]) fs.rmSync(file, { force: true });
      return;
    }
    sleep(1000);
  }
  fail(`VM did not stop within ${Math.round(timeoutMs / 1000)} seconds`);
}

function stopVm() {
  if (!isRunning()) {
    console.log("[vm] Already stopped");
    return;
  }
  ssh("sudo systemctl poweroff", { allowFailure: true });
  try {
    waitForStop();
  } catch {
    const pid = readPid();
    if (pid && isRunning()) {
      console.warn(`[vm] Guest poweroff did not exit QEMU; sending SIGTERM to PID ${pid}`);
      process.kill(pid, "SIGTERM");
    }
    waitForStop(15 * 1000);
  }
  console.log("[vm] Stopped");
}

function qmpCommand(execute, args = undefined) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(QMP_SOCKET);
    let buffer = "";
    let capabilitiesSent = false;
    let commandSent = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`QMP ${execute} timed out`));
    }, 10000);
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.QMP && !capabilitiesSent) {
          capabilitiesSent = true;
          socket.write(`${JSON.stringify({ execute: "qmp_capabilities" })}\r\n`);
        } else if (capabilitiesSent && !commandSent && Object.hasOwn(message, "return")) {
          commandSent = true;
          const request = { execute };
          if (args) request.arguments = args;
          socket.write(`${JSON.stringify(request)}\r\n`);
        } else if (commandSent && (Object.hasOwn(message, "return") || message.error)) {
          clearTimeout(timer);
          socket.end();
          if (message.error) reject(new Error(`QMP ${execute} failed: ${message.error.desc}`));
          else resolve(message.return);
        }
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function ppmHasVisibleContent(file) {
  const data = fs.readFileSync(file);
  const header = data.subarray(0, Math.min(data.length, 256)).toString("ascii");
  const match = header.match(/^P6\s+(?:#.*\s+)*(\d+)\s+(\d+)\s+255\s/);
  if (!match) fail(`Unexpected screenshot format: ${file}`);
  const payloadStart = match[0].length;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (width < 1024 || height < 700 || data.length - payloadStart < width * height * 3) return false;
  const pixels = width * height;
  const pixelStep = Math.max(1, Math.floor(pixels / 50000));
  const minimum = [255, 255, 255];
  const maximum = [0, 0, 0];
  let darkPixels = 0;
  let multichannelPixels = 0;
  let samples = 0;
  for (let pixel = 0; pixel < pixels; pixel += pixelStep) {
    const index = payloadStart + pixel * 3;
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    minimum[0] = Math.min(minimum[0], red);
    minimum[1] = Math.min(minimum[1], green);
    minimum[2] = Math.min(minimum[2], blue);
    maximum[0] = Math.max(maximum[0], red);
    maximum[1] = Math.max(maximum[1], green);
    maximum[2] = Math.max(maximum[2], blue);
    if (red < 32 && green < 32 && blue < 32) darkPixels += 1;
    if (green > 24 && blue > 24) multichannelPixels += 1;
    samples += 1;
  }
  return maximum.every((value, index) => value - minimum[index] >= 24)
    && darkPixels / samples <= 0.3
    && multichannelPixels / samples >= 0.01;
}

async function takeScreenshot() {
  if (!isRunning()) fail("VM is not running");
  const refreshed = ssh("DISPLAY=:0 XAUTHORITY=/run/user/1000/gdm/Xauthority xrefresh", { allowFailure: true });
  if (refreshed.status === 0) sleep(1000);
  const file = path.join(SCREENSHOT_ROOT, `desktop-${new Date().toISOString().replace(/[:.]/g, "-")}.ppm`);
  await qmpCommand("screendump", { filename: file });
  if (!ppmHasVisibleContent(file)) fail(`VM screenshot failed visual content checks: ${file}`);
  console.log(`[vm] Nonblank screenshot: ${path.relative(PROJECT_ROOT, file)}`);
  return file;
}

function createWorkingDisk() {
  fs.rmSync(WORKING_DISK, { force: true });
  run("qemu-img", ["create", "-f", "qcow2", "-F", "qcow2", "-b", BASELINE_DISK, WORKING_DISK]);
}

async function provision() {
  ensureCommands();
  ensureDirectories();
  if (fs.existsSync(WORKING_DISK)) fail("VM is already provisioned; use npm run vm:reset");
  const publicKey = ensureSshKey();
  if (!isRunning()) renderCloudInit(publicKey);
  if (!fs.existsSync(BASELINE_DISK)) {
    ensureCloudImage();
    console.log("[vm] Creating 48 GiB sparse baseline disk");
    run("qemu-img", ["convert", "-O", "qcow2", CLOUD_IMAGE, BASELINE_DISK]);
    run("qemu-img", ["resize", BASELINE_DISK, "48G"]);
  } else {
    console.log("[vm] Resuming the existing unfinalized baseline");
  }
  if (!isRunning()) startQemu(BASELINE_DISK);
  try {
    waitForSsh();
    console.log("[vm] Installing desktop packages through cloud-init; this can take 20-40 minutes");
    const cloudInit = ssh("sudo cloud-init status --wait --long", { allowFailure: true, inherit: true });
    if (cloudInit.status !== 0) {
      ssh("sudo cloud-init status --long; sudo tail -n 200 /var/log/cloud-init-output.log", { allowFailure: true, inherit: true });
      fail("Cloud-init provisioning failed");
    }
    ssh("sudo systemctl reboot", { allowFailure: true });
    sleep(10000);
    waitForSsh();
    waitForDesktop();
    stopVm();
  } catch (error) {
    console.error(`[vm] Provisioning stopped: ${error.message}`);
    throw error;
  }
  createWorkingDisk();
  startQemu(WORKING_DISK);
  waitForSsh();
  startProxyTunnel();
  waitForDesktop();
  await takeScreenshot();
  console.log("[vm] Provisioned isolated desktop baseline and started a disposable working VM");
}

async function main() {
  ensureDirectories();
  const command = process.argv[2];
  if (command === "provision") return provision();
  if (command === "start") {
    ensureCommands();
    if (!fs.existsSync(WORKING_DISK)) fail("Working disk is missing; run npm run vm:provision");
    startQemu(WORKING_DISK);
    waitForSsh();
    startProxyTunnel();
    waitForDesktop();
    return takeScreenshot();
  }
  if (command === "stop") return stopVm();
  if (command === "reset") {
    ensureCommands();
    if (!fs.existsSync(BASELINE_DISK)) fail("Baseline is missing; run npm run vm:provision");
    stopVm();
    createWorkingDisk();
    startQemu(WORKING_DISK);
    waitForSsh();
    startProxyTunnel();
    waitForDesktop();
    return takeScreenshot();
  }
  if (command === "status") {
    console.log(isRunning() ? `[vm] running (PID ${readPid()})` : "[vm] stopped");
    return;
  }
  if (command === "screenshot") return takeScreenshot();
  if (command === "proxy") {
    if (!isRunning()) fail("VM is not running");
    waitForSsh();
    startProxyTunnel();
    return;
  }
  if (command === "ssh") {
    const child = spawn("ssh", sshArgs(), { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }
  if (command === "viewer") {
    const child = spawn("remote-viewer", [`spice://127.0.0.1:${SPICE_PORT}`], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  fail("Usage: gui-vm.js provision|start|stop|reset|status|screenshot|proxy|ssh|viewer");
}

module.exports = {
  CLOUD_IMAGE_SHA256,
  qemuArgs,
  ppmHasVisibleContent,
  proxyTunnelArgs,
  sshArgs,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[vm] ${error.message}`);
    process.exit(1);
  });
}
