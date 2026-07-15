# Codex Desktop Upstream Adaptation Standard

This is the normative process for adapting a new upstream Codex Desktop build
to Ubuntu. An adaptation is not complete until `npm run build:accepted` passes
without skipped required checks.

## 1. Branch And Change Discipline

1. Close every Codex Desktop process before final acceptance.
2. Inspect the current worktree. Commit intentional existing work before
   creating the adaptation branch; never hide or mix unrelated changes.
3. Run the read-only update check, then create
   `adapt/codex-<version>-<build>` from the current commit.
4. Update all pinned upstream inputs together with `npm run update:pins`.
5. Regenerate `src/` with the pinned inputs. Generated files remain ignored.
6. Treat every missing patch anchor as an upstream compatibility change. Do
   not weaken or skip a patch until the new upstream behavior is understood.
7. Keep adaptation changes surgical and add a regression assertion for every
   compatibility bug fixed during the adaptation.
8. Commit the adaptation before final acceptance. The accepted report must
   identify a clean Git commit.

## 2. Build Contracts

`npm run build` creates and statically verifies the Ubuntu x64 `.deb`. It emits
only the Debian package, refreshes the current candidate under the visible and
git-ignored `build-history/candidates/` directory, and does not mark the build
as accepted.

`npm run build:accepted` is the only release-quality entrypoint. It runs unit
tests, builds the candidate, verifies the generated JavaScript and package,
resets the isolated VM, starts the candidate extracted from its `.deb` with an
empty profile, installs it only in the guest, runs the authenticated core UI
suite against the guest `/usr/bin/codex-desktop`, discards the guest, and
promotes the candidate only after every gate passes.

Accepted packages are stored under:

```text
build-history/codex-desktop/<version>+<build>/<platform>/make/
```

The latest three accepted versions are retained. Rebuilding the same version
atomically refreshes its candidate. Its accepted artifact is replaced only
after the new candidate passes the full installed-app acceptance flow.

## 3. Authentication And Test Isolation

Authenticated tests must use a temporary clone of local Codex state. They must
never launch against the live profile.

- Source `$CODEX_HOME` or `~/.codex` and `$XDG_CONFIG_HOME/Codex` or
  `~/.config/Codex`.
- Require the host Codex process to be closed while the snapshot is created.
- Copy only `.codex-global-state.json`, `auth.json`, and `installation_id` from
  Codex state. Do not copy `config.toml`, logs, sessions, SQLite state, plugins,
  Skills, MCP configuration, locks, sockets, attachments, or symlinks.
- Copy only Cookies, Local State, Preferences, and Local Storage from the root
  Electron profile and its `codex-browser-app` partition.
- Set temporary `HOME`, `CODEX_HOME`, and `XDG_CONFIG_HOME` values and use
  private `0700` permissions.
- If the parent environment defines a proxy, force the same endpoint through
  Electron's proxy switch. The temporary `XDG_CONFIG_HOME` hides desktop proxy
  settings, and inheriting `HTTP_PROXY` alone does not cover `net.fetch`.
- Never hard-link profile data. Never write credentials, cookies, tokens, or
  profile contents to logs, reports, screenshots metadata, or Git.
- Stream the snapshot into guest `/run` tmpfs and delete the host temporary copy
  immediately. `--keep-profile` must never be used by mandatory acceptance.
- Keep the guest tmpfs path short enough for Chromium to append Unix socket
  names without exceeding Linux `sun_path` limits.
- Verify that source authentication files do not change while taking the
  snapshot. The host app may be reopened after the snapshot is complete.

The functional suite creates a disposable Git workspace with deterministic
text and image fixtures. All model tool calls and terminal commands must target
that workspace. No test may edit the rebuild repository or the user's files.

Installed GUI acceptance must run in the project-managed Ubuntu Desktop VM. Run
`npm run vm:provision` once, or `npm run vm:reprovision` after the tracked VM
schema changes. The visible, git-ignored `vm-state/` directory contains the
versioned clean baseline, disposable working disk, VM-only SSH key, logs, and
screenshots. A stale baseline is a blocking failure. The baseline must never
contain host Codex authentication, profile data, or an installed Codex package.
Normal acceptance reuses the read-only baseline: `vm:reset` and `vm:discard`
replace only the small qcow2 overlay. Do not reprovision the operating system on
every run. A reset must wait until the previous QEMU instance has released both
loopback SSH and SPICE ports before starting the next instance.

The host requires KVM/QEMU, `qemu-img`, `cloud-localds`, OpenSSH, and access to
`/dev/kvm`; `remote-viewer` is optional. VM lifecycle commands run as the normal
host user. Passwordless sudo is enabled only for the disposable `codex-test`
guest account, not on the host.

The VM uses KVM, an auto-login Xorg session with guest locking disabled, and a
loopback-only SPICE display. It remains active when the host desktop is locked
and does not open a host window unless `npm run vm:viewer` is requested. X11,
`xdotool`, and AT-SPI are mandatory so the native Electron file picker is
exercised for attachment tests. A missing GUI automation prerequisite is a
blocking failure, never a skipped check. Host-desktop execution is a debugging
fallback only and requires an unlocked X11 session.

The CDP smoke driver runs with the packaged Electron's Node runtime so its
WebSocket support matches the candidate. The driver must remove
`ELECTRON_RUN_AS_NODE` from the child environment before launching the desktop
application.

Each VM start establishes an SSH reverse tunnel from guest
`127.0.0.1:7897` to host `127.0.0.1:7897` and verifies the proxy egress before
declaring the VM ready. Clash remains bound to host loopback and is never
exposed to the LAN. App tests inside the VM use the guest loopback endpoint.
Provisioning also configures snapd through that tunnel before waiting for
cloud-init. `CODEX_VM_APT_MIRROR` may specify an unauthenticated HTTP(S) Ubuntu
mirror for the one-time baseline build; it is not needed for routine resets.

`build:accepted` may build and inspect files on the host, but it must not invoke
host `apt`, `sudo`, `pkexec`, or the host-installed Codex executable. A missing
VM prerequisite is a failure; the mandatory flow never falls back to the host
desktop.

## 4. Required Acceptance Gates

Every item below is blocking. A missing control, timeout, unexpected login
screen, raw protocol markup, fatal renderer/app-server log, or `skip` is a
failure.

### Static And Startup

- Pinned app, build, archive size, SHA-256, CLI version, and publication rule.
- Linux patch invariants in the prepared tree and packaged `app.asar`.
- Generated main and renderer JavaScript syntax.
- Debian metadata, launcher, Linux ELF binaries, native modules, and absence of
  packaged Mach-O binaries.
- Empty-profile launch, main window readiness, renderer page, and app-server
  handshake from the unpacked candidate.

### Installed Core UI

- Installed package version, desktop entry, launcher, authentication, main UI,
  composer, project context, and sidebar.
- Open the disposable workspace through the app's path-open contract.
- Normal chat returns a unique marker and does not use Plan layout.
- Text and image attachments can be added, displayed, submitted, and removed;
  the text attachment content is observed in the response.
- Model picker, reasoning/Fast controls, approval menu, settings, sidebar,
  bottom panel, and terminal are interactive.
- The terminal runs a marker command and renders its output.
- Command and file approvals exercise both approve and decline paths. Approved
  output must match exactly; declined output must not exist.
- Stop/Cancel terminates a long command and prevents its completion marker.
- `Shift+Tab` enters and exits Plan Mode and changes the visible active state.
- A Plan response renders in the dedicated Plan layout without raw
  `<proposed_plan>` tags.
- The Plan completion request exposes both implementation and additional-input
  paths. Additional input updates the Plan; implementation performs the
  expected workspace change.
- A normal message after leaving Plan Mode does not render as a Plan.
- Restarting the installed app with the same cloned profile restores the test
  conversation and its marker.

Core acceptance intentionally excludes external MCP servers, plugins, Skills,
browser access, voice, cloud tasks, and image generation. These may have
separate non-blocking compatibility checks but cannot replace the required
suite above.

## 5. Installation, Rollback, And Evidence

Before installation, acceptance must locate the same-version accepted `.deb`,
or otherwise the most recently accepted x64 `.deb`, in build history. The host
installed version is not used as the rollback source. If no rollback artifact
exists, installation is blocked.

Install the accepted baseline in the guest first and require both empty-profile
startup and an authenticated real marker response. Then install the candidate
with guest `sudo -n apt-get install --reinstall` and verify hashes for the main
binary, `app.asar`, and bundled CLI. If installation or core UI fails, reinstall
the rollback package and repeat both baseline probes.

Passwordless sudo exists only for the disposable VM account. The host Codex
package and executable hashes must be unchanged before and after acceptance.

Each run writes a local, ignored report under
`build-history/acceptance-runs/<run-id>/`. The report records the app/build/CLI
versions, Git branch and commit, VM/image identity, package and installed-file
hashes, stage and scenario durations, failure class, redacted logs, screenshots,
and rollback result. Evidence is scanned against in-memory authentication values
and must not contain copied profile data.

On failure, preserve the candidate and report, do not promote the build, collect
guest evidence, then run `vm:discard`. Classify the result as product,
infrastructure, or interrupted. Do not hide transient failures with automatic
retries; an explicit rerun keeps both results.

An adaptation is accepted only when all required checks pass, no required
scenario is skipped, the installed version is correct, the source profile is
unchanged, the report is complete, and the candidate is promoted into the
three-version accepted history.
