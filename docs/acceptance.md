# Codex Desktop Linux Acceptance

Every upstream adaptation must pass this acceptance flow before the build is
installed for daily use or treated as releasable.

## Required Command

```bash
npm run build:accepted
```

This command runs:

1. Unit tests.
2. Linux x64 build.
3. Prepared tree and package verifiers.
4. Generated JavaScript syntax checks.
5. GUI smoke with an empty temporary profile.
6. GUI smoke with a temporary clone of the local Codex profile.
7. GUI smoke with a temporary auth clone that submits a real Plan-mode prompt.
8. Build history contract verification.

Any failure blocks the adaptation. Do not install or archive a failed build as a
known-good local version.

## Profile Modes

`smoke:linux:safe` uses a temporary empty `HOME`. It verifies the app can start,
open the main window, and complete the app-server handshake without relying on a
logged-in account.

`smoke:linux:auth-clone` is the default real-functionality gate. It creates a
temporary `HOME`, copies `~/.codex` and `~/.config/Codex` when present, excludes
cache and singleton-lock files, runs the smoke tests, then deletes the temporary
profile. This avoids a fresh login while keeping the user's live profile out of
the test process.

`smoke:linux:plan-flow` uses the same temporary auth clone, then submits a short
Plan-mode prompt with a unique marker. It verifies that the response renders as
a Plan summary instead of raw `<proposed_plan>` text, that the implementation
request UI appears, and that `Shift+Tab` exits Plan mode. It can consume a small
amount of model usage.

`smoke:linux:real` uses the live profile and is intentionally gated:

```bash
CODEX_DESKTOP_SMOKE_REAL_PROFILE=1 npm run smoke:linux:real
```

Use it only for explicit final confirmation. The real-profile smoke mode does
not submit prompts, and it skips shortcut paths that would create tasks in the
real profile.

## Acceptance Coverage

The static gates verify:

- Pinned upstream version/build/CLI inputs.
- Linux runtime patches in the prepared tree and packaged `app.asar`.
- No stale Linux patch branches or broken Plan shortcut syntax.
- Generated main/renderer JavaScript parses with `node --check`.
- Debian entrypoints, desktop metadata, Linux ELF binaries, and absence of
  macOS Mach-O binaries.
- Visible `build-history/` is ignored by git and retains at most three versions.

The GUI smoke gates verify:

- Electron exposes a main `app://-/index.html` page.
- Main window reaches `ready-to-show`.
- Codex app-server handshake succeeds.
- Fatal startup logs are absent.
- Auth-clone mode can see the main Codex UI, composer, sidebar, and controls.
- Composer can focus, accept a temporary draft, and clear it.
- `Shift+Tab` toggles Plan mode and restores the initial state.
- Plan mode can submit a real prompt, render the dedicated Plan summary layout,
  show the implement-plan waiting request, and hide raw `<proposed_plan>` tags.
- `Shift+Tab` exits Plan mode after the Plan flow.
- Sidebar, project, and approval controls can be opened/closed.
- Bottom panel controls are opened/closed when rendered in the current UI state.

Known non-fatal startup noise, such as update/protocol handler warnings, network
403s for announcements, deprecation warnings, or missing optional plugin art, is
not itself a blocker unless it prevents the required UI and handshake checks.

## Failure Handling

When acceptance fails:

1. Keep the failing branch and build artifacts for inspection.
2. Read the smoke failure excerpt; it is redacted and limited to recent logs.
3. Re-run the failing smoke command with `--keep-profile` only when profile state
   is needed for debugging.
4. Add or tighten verifier coverage for the failure before considering the fix
   complete.
