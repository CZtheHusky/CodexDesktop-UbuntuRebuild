#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="${CODEX_STATE_FILE:-$HOME/.codex/.codex-global-state.json}"
APPLY=0

if [[ "${1:-}" == "--apply" ]]; then
  APPLY=1
elif [[ "${1:-}" != "" ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 2
fi

node - "$STATE_FILE" "$APPLY" <<'NODE'
const fs = require("fs");
const os = require("os");

const stateFile = process.argv[2];
const apply = process.argv[3] === "1";
const home = process.env.HOME || os.homedir() || "/home/husky";

const staleRoots = new Set([
  `${home}/onedrive_huskyc/0-works/weekly_report/630`,
  `${home}/downloads/gs-agent-tool`,
  `${home}/workspace/work_okr`,
]);

const staleAtomKeys = new Set([
  `sidebar-project-expanded-v1-codex:${home}/downloads/gs-agent-tool`,
]);

const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));

const beforeRoots = state["electron-saved-workspace-roots"] ?? [];
const afterRoots = beforeRoots.filter((root) => !staleRoots.has(root));

const atom = state["electron-persisted-atom-state"] ?? {};
const removedAtomKeys = [];

for (const key of Object.keys(atom)) {
  if (staleAtomKeys.has(key)) {
    removedAtomKeys.push(key);
    delete atom[key];
  }
}

state["electron-saved-workspace-roots"] = afterRoots;
state["electron-persisted-atom-state"] = atom;

const removedRoots = beforeRoots.filter((root) => staleRoots.has(root));

console.log("State file:", stateFile);
console.log("Mode:", apply ? "apply" : "dry-run");
console.log("");

console.log("Roots to remove:");
if (removedRoots.length === 0) console.log("  none");
for (const root of removedRoots) console.log("  -", root);

console.log("");
console.log("Atom keys to remove:");
if (removedAtomKeys.length === 0) console.log("  none");
for (const key of removedAtomKeys) console.log("  -", key);

if (!apply) {
  console.log("");
  console.log("No changes written. Re-run with --apply to modify the state file.");
  process.exit(0);
}

const backup = `${stateFile}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(stateFile, backup);
fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");

console.log("");
console.log("Backup written:", backup);
console.log("State file updated.");
NODE
