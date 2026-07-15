const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const { qemuArgs, ppmHasVisibleContent, proxyTunnelArgs, sshArgs } = require("./gui-vm");

test("VM networking and display stay loopback-only to isolate acceptance", () => {
  const args = qemuArgs("/tmp/working.qcow2").join(" ");
  assert.match(args, /accel=kvm/);
  assert.match(args, /hostfwd=tcp:127\.0\.0\.1:22222-:22/);
  assert.match(args, /addr=127\.0\.0\.1,port=5930/);
  assert.match(args, /-vga virtio/);
  assert.doesNotMatch(args, /-vga qxl/);
  assert.doesNotMatch(args, /-net\s+bridge|hostfwd=tcp:0\.0\.0\.0/);
  assert.doesNotMatch(args, /-display\s+(gtk|sdl)/);
});

test("cloud-init creates an unlocked Xorg desktop without host credentials", () => {
  const source = fs.readFileSync(path.join(root, "vm", "cloud-init", "user-data.yaml"), "utf8");
  assert.match(source, /AutomaticLogin=codex-test/);
  assert.match(source, /WaylandEnable=false/);
  assert.match(source, /lock-enabled=false/);
  assert.match(source, /python3-pyatspi/);
  assert.match(source, /update-notifier\.desktop/);
  assert.match(source, /Hidden=true/);
  assert.match(source, /__SSH_PUBLIC_KEY__/);
  assert.doesNotMatch(source, /\.codex|auth\.json|CODEX_HOME/);
  assert.doesNotMatch(source, /10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/);
});

test("VM SSH ignores unrelated host agent keys", () => {
  const args = sshArgs("true");
  assert.ok(args.includes("IdentitiesOnly=yes"));
  assert.ok(args.includes("BatchMode=yes"));
});

test("Clash reaches the guest only through a loopback reverse tunnel", () => {
  const args = proxyTunnelArgs().join(" ");
  assert.match(args, /-R 127\.0\.0\.1:7897:127\.0\.0\.1:7897/);
  assert.match(args, /ExitOnForwardFailure=yes/);
  assert.doesNotMatch(args, /0\.0\.0\.0:7897/);
});

test("screenshot validation rejects blank and QXL-corrupted displays", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-vm-ppm-"));
  const blank = path.join(dir, "blank.ppm");
  const corrupted = path.join(dir, "corrupted.ppm");
  const occluded = path.join(dir, "occluded.ppm");
  const visible = path.join(dir, "visible.ppm");
  try {
    const width = 1024;
    const height = 700;
    const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
    fs.writeFileSync(blank, Buffer.concat([header, Buffer.alloc(width * height * 3, 7)]));
    const redLines = Buffer.alloc(width * height * 3);
    const pixels = Buffer.alloc(width * height * 3);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const index = pixel * 3;
      if (pixel % width % 16 === 0) redLines[index] = 220;
      pixels[index] = pixel % 251;
      pixels[index + 1] = (pixel * 3) % 251;
      pixels[index + 2] = (pixel * 7) % 251;
    }
    const blackOcclusion = Buffer.from(pixels);
    blackOcclusion.fill(0, 0, Math.floor(blackOcclusion.length * 0.6));
    fs.writeFileSync(corrupted, Buffer.concat([header, redLines]));
    fs.writeFileSync(occluded, Buffer.concat([header, blackOcclusion]));
    fs.writeFileSync(visible, Buffer.concat([header, pixels]));
    assert.equal(ppmHasVisibleContent(blank), false);
    assert.equal(ppmHasVisibleContent(corrupted), false);
    assert.equal(ppmHasVisibleContent(occluded), false);
    assert.equal(ppmHasVisibleContent(visible), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
