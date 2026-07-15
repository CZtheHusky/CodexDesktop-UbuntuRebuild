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
starts the unpacked candidate with an empty profile, installs the `.deb`, runs
the authenticated core UI suite against `/usr/bin/codex-desktop`, and promotes
the candidate only after every gate passes.

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
- Copy only authentication and startup configuration from Codex state. Exclude
  logs, caches, session transcripts, SQLite state, locks, sockets, PID files,
  temporary files, shell snapshots, process state, and attachments.
- Copy the Electron profile while excluding caches, Crashpad, GPU data,
  singleton files, logs, and DevTools state.
- Set temporary `HOME`, `CODEX_HOME`, and `XDG_CONFIG_HOME` values and use
  private `0700` permissions.
- Never hard-link profile data. Never write credentials, cookies, tokens, or
  profile contents to logs, reports, screenshots metadata, or Git.
- Delete the cloned profile after success or failure. `--keep-profile` is an
  explicit local debugging exception and must never be used by the mandatory
  acceptance command.
- Verify that the source authentication files are unchanged after the run.

The functional suite creates a disposable Git workspace with deterministic
text and image fixtures. All model tool calls and terminal commands must target
that workspace. No test may edit the rebuild repository or the user's files.

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

Before installation, acceptance must locate a `.deb` for the currently
installed accepted version. If no rollback artifact exists, installation is
blocked.

Install the candidate with privileged `apt install --reinstall`. If
installation or the installed-app UI suite fails after replacement, reinstall
the rollback package and verify that it can complete the empty-profile startup
gate. A rollback failure must be reported explicitly.

The runner uses an existing non-interactive `sudo` credential when available;
otherwise an X11 desktop session uses `pkexec` for the system authentication
dialog. Credentials must never be passed through command arguments or logs.

Each run writes a local, ignored report under
`build-history/acceptance-runs/<run-id>/`. The report records the app/build/CLI
versions, Git branch and commit, package SHA-256, installed versions, stage and
scenario durations, pass/fail status, redacted logs, screenshots, and rollback
result. It must not contain copied profile data.

On failure, preserve the candidate and report, do not promote the build, and
add or tighten an automated regression check before claiming a fix. Do not
hide transient failures with automatic retries; an explicit rerun keeps both
results.

An adaptation is accepted only when all required checks pass, no required
scenario is skipped, the installed version is correct, the source profile is
unchanged, the report is complete, and the candidate is promoted into the
three-version accepted history.
