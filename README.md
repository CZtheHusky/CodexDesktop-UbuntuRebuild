# Codex Desktop Ubuntu Rebuild

This repository rebuilds the OpenAI Codex Desktop app for Ubuntu Desktop.

It is not a general cross-platform distribution. The supported install target is
Ubuntu Desktop via the Debian package produced by the Linux build.

## Supported Target

| Target | Architecture | Status |
| --- | --- | --- |
| Ubuntu Desktop | x64 / amd64 | Supported |
| Ubuntu Desktop | arm64 | Build script available; verify on target hardware |
| macOS | x64, arm64 | Not supported by this repo |
| Windows | x64 | Not supported by this repo |
| Other Linux distributions | x64, arm64 | Not supported; use at your own risk |

The Linux rebuild uses upstream macOS Codex app resources as build input, then
repackages them for Ubuntu with Linux-native Electron packaging, native modules,
and bundled `codex`/`rg` binaries.

## What This Rebuild Changes

- Builds an Ubuntu desktop package named `codex-desktop`.
- Installs the GUI launcher as `codex-desktop`; it does not install or replace
  `/usr/bin/codex`.
- Uses the native Ubuntu window titlebar instead of custom Linux window controls.
- Removes macOS-only runtime resources from the Linux package.
- Rebuilds native Node modules for Linux and verifies that packaged binaries are
  Linux ELF files, not macOS Mach-O files.
- Applies Linux runtime fixes for startup thread sync, sidebar history/project
  grouping, window focus behavior, and disabled macOS-only `node_repl` behavior.

## Build Requirements

Use Ubuntu Desktop on the same architecture you want to package. Cross-building
is not the supported path because native modules are rebuilt for the host
architecture.

Install system dependencies:

```bash
sudo apt update
sudo apt install -y \
  git curl ca-certificates \
  build-essential python3 pkg-config \
  dpkg-dev fakeroot rpm p7zip-full
```

Install Node.js 20 or newer before running the npm commands below.

## Build

Install project dependencies:

```bash
npm ci
```

Fetch upstream Codex app resources if `src/mac-x64/_asar` or
`src/mac-arm64/_asar` is missing. The `src/` directory is generated and ignored
by git, so a fresh clone normally needs this step:

```bash
npm run sync -- --skip-win
```

Build the Ubuntu x64 package:

```bash
npm run build
```

On Ubuntu arm64 hardware, build the arm64 package instead:

```bash
npm run build:linux-arm64
```

`npm run build` is the default Ubuntu x64 build. The macOS and Windows scripts
still exist for maintenance of the upstream-derived rebuild tooling, but they
are not supported release targets for this repository.

The Linux build pipeline runs these steps:

1. `prepare-src.js` converts the upstream app resources into a Linux Forge
   source tree.
2. `electron-rebuild` rebuilds native modules for the host Ubuntu architecture.
3. `sync-native-modules.js` copies the rebuilt native modules into `src/`.
4. `patch-linux-runtime.js` applies Ubuntu runtime patches.
5. `verify-linux-desktop.js` checks the prepared tree.
6. Electron Forge creates the package.
7. `verify-linux-desktop.js` checks the generated `.deb`.

## Output

The supported Ubuntu package is written to:

```text
out/make/deb/x64/codex-desktop_<version>_amd64.deb
```

For arm64 builds, use the matching `out/make/deb/arm64/` package.

Electron Forge may also emit `.rpm` and `.zip` files because the maker config
still contains those makers. They are build artifacts only; this repo supports
the Ubuntu `.deb` install path.

## Install

Install the generated package:

```bash
sudo apt install ./out/make/deb/x64/codex-desktop_*.deb
```

For arm64:

```bash
sudo apt install ./out/make/deb/arm64/codex-desktop_*.deb
```

Launch Codex Desktop from the Ubuntu app launcher, or run:

```bash
codex-desktop
```

Uninstall with:

```bash
sudo apt remove codex-desktop
```

## Verify Manually

The build scripts run verification automatically. To rerun checks manually:

```bash
node scripts/verify-linux-desktop.js --stage prepared --platform linux-x64
node scripts/verify-linux-desktop.js --stage package --platform linux-x64
```

Use `linux-arm64` for arm64 builds.

The package verifier checks the `.deb` entrypoints, desktop launcher metadata,
Linux runtime patches, bundled `codex` and `rg` binaries, and absence of
macOS-only Mach-O files.

## Troubleshooting

If the build fails with `Source not found` or `_asar/ not found`, run:

```bash
npm run sync -- --skip-win
```

If archive extraction fails, confirm `p7zip-full` is installed and that `7zz` or
`7z` is available on `PATH`.

If package creation fails around RPM tooling, confirm the `rpm` package is
installed. The supported installer remains the generated `.deb`.

If native module rebuilds fail, confirm the build is running on Ubuntu for the
same architecture you are packaging, then reinstall dependencies with `npm ci`
and rerun the Linux build command.

## Project Layout

```text
resources/linux-desktop.ejs        Ubuntu desktop entry template
scripts/prepare-src.js             Converts upstream resources for Linux Forge
scripts/sync-native-modules.js     Copies rebuilt Linux native modules
scripts/patch-linux-runtime.js     Applies Ubuntu runtime patches
scripts/verify-linux-desktop.js    Fails loud when Linux package invariants break
scripts/sync-upstream.js           Downloads and extracts upstream app resources
forge.config.js                    Electron Forge packaging config
```

Generated directories:

```text
src/                               Ignored build input/cache
out/                               Ignored package output
```

## Credits

- OpenAI Codex Desktop app resources and Codex CLI lineage.
- Cometix Space for the cross-platform rebuild work and `@cometix/codex`
  binaries used by the rebuild pipeline.
- Electron Forge for packaging.

## License

This project rebuilds Codex Desktop app resources for Ubuntu Desktop packaging.
Original Codex CLI components by OpenAI are licensed under Apache-2.0.
