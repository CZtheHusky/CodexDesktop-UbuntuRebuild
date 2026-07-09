#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: cleanup-station-lan-codex-state.sh [--apply]

Default mode is dry-run. Re-run with --apply to write changes.

Environment overrides:
  CODEX_STATE_DIR   default: $HOME/.codex
  CODEX_STATE_FILE  default: $CODEX_STATE_DIR/.codex-global-state.json
  CODEX_STATE_DB    default: $CODEX_STATE_DIR/state_5.sqlite
EOF
}

APPLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

STATE_DIR="${CODEX_STATE_DIR:-$HOME/.codex}"
STATE_FILE="${CODEX_STATE_FILE:-$STATE_DIR/.codex-global-state.json}"
STATE_DB="${CODEX_STATE_DB:-$STATE_DIR/state_5.sqlite}"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "Missing state file: $STATE_FILE" >&2
  exit 1
fi

if [[ ! -f "$STATE_DB" ]]; then
  echo "Missing state database: $STATE_DB" >&2
  exit 1
fi

command -v node >/dev/null || {
  echo "Missing dependency: node" >&2
  exit 1
}

command -v sqlite3 >/dev/null || {
  echo "Missing dependency: sqlite3" >&2
  exit 1
}

echo "State file: $STATE_FILE"
echo "State database: $STATE_DB"
echo "Mode: $([[ "$APPLY" == "1" ]] && echo apply || echo dry-run)"
echo ""

echo "Active subagent threads that should not appear as normal sidebar sessions:"
sqlite3 -header -column "$STATE_DB" <<'SQL'
SELECT
  thread_source,
  CASE
    WHEN source LIKE '%guardian%' THEN 'guardian'
    WHEN source LIKE '%thread_spawn%' THEN 'thread_spawn'
    ELSE source
  END AS source_kind,
  cwd,
  COUNT(*) AS active_threads,
  MAX(LENGTH(title)) AS max_title_len
FROM threads
WHERE archived = 0
  AND thread_source = 'subagent'
GROUP BY thread_source, source_kind, cwd
ORDER BY source_kind, active_threads DESC, cwd;
SQL
echo ""

if [[ "$APPLY" == "1" ]]; then
  BACKUP_DIR="$STATE_DIR/backups/cleanup-station-lan-codex-state-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"

  cp "$STATE_FILE" "$BACKUP_DIR/.codex-global-state.json"
  sqlite3 "$STATE_DB" ".backup '$BACKUP_DIR/state_5.sqlite'"

  echo "Backups written:"
  echo "  $BACKUP_DIR/.codex-global-state.json"
  echo "  $BACKUP_DIR/state_5.sqlite"
  echo ""
fi

echo "Workspace root cleanup preview:"
node - "$STATE_FILE" "$APPLY" <<'NODE'
const fs = require("fs");
const os = require("os");

const stateFile = process.argv[2];
const apply = process.argv[3] === "1";
const home = process.env.HOME || os.homedir();

const exactCaseRoots = new Map([
  [
    `${home}/workspace/embodied-manipulation-benchmark-for-mllm`,
    `${home}/workspace/Embodied-Manipulation-Benchmark-for-MLLM`,
  ],
]);

const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const touchedRoots = new Set();
const listNames = [
  "active-workspace-roots",
  "electron-saved-workspace-roots",
];

const summary = [];

for (const listName of listNames) {
  const before = Array.isArray(state[listName]) ? state[listName] : [];
  const after = [];
  const seen = new Set();
  const replacements = [];
  const removals = [];
  const duplicates = [];

  for (const root of before) {
    let next = root;
    const exactCaseRoot = exactCaseRoots.get(root);

    if (exactCaseRoot && fs.existsSync(exactCaseRoot)) {
      next = exactCaseRoot;
      replacements.push({ from: root, to: next });
      touchedRoots.add(root);
    }

    if (!fs.existsSync(next)) {
      removals.push(next);
      touchedRoots.add(root);
      touchedRoots.add(next);
      continue;
    }

    if (seen.has(next)) {
      duplicates.push(next);
      touchedRoots.add(root);
      continue;
    }

    seen.add(next);
    after.push(next);
  }

  summary.push({ listName, before, after, replacements, removals, duplicates });
  state[listName] = after;
}

const atom = state["electron-persisted-atom-state"] ?? {};
const removedAtomKeys = [];

for (const key of Object.keys(atom)) {
  for (const root of touchedRoots) {
    if (root && key.includes(root)) {
      removedAtomKeys.push(key);
      delete atom[key];
      break;
    }
  }
}

state["electron-persisted-atom-state"] = atom;

for (const item of summary) {
  console.log(`  ${item.listName}:`);

  console.log("    replacements:");
  if (item.replacements.length === 0) console.log("      none");
  for (const { from, to } of item.replacements) {
    console.log(`      - ${from} -> ${to}`);
  }

  console.log("    missing roots to remove:");
  if (item.removals.length === 0) console.log("      none");
  for (const root of item.removals) console.log(`      - ${root}`);

  console.log("    duplicate roots to remove:");
  if (item.duplicates.length === 0) console.log("      none");
  for (const root of item.duplicates) console.log(`      - ${root}`);

  console.log("    after:");
  if (item.after.length === 0) console.log("      []");
  for (const root of item.after) console.log(`      - ${root}`);
}

console.log("  atom keys to remove:");
if (removedAtomKeys.length === 0) console.log("    none");
for (const key of removedAtomKeys) console.log(`    - ${key}`);

if (!apply) process.exit(0);

fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");
NODE

if [[ "$APPLY" != "1" ]]; then
  echo ""
  echo "No changes written. Re-run with --apply after closing Codex Desktop to clean the state."
  exit 0
fi

echo "Archiving active subagent threads..."
sqlite3 "$STATE_DB" <<'SQL'
BEGIN IMMEDIATE;
UPDATE threads
SET archived = 1,
    archived_at = COALESCE(archived_at, CAST(strftime('%s', 'now') AS INTEGER))
WHERE archived = 0
  AND thread_source = 'subagent';
COMMIT;
SQL

echo "Cleanup complete."
echo ""
echo "Remaining active subagent threads:"
sqlite3 -header -column "$STATE_DB" <<'SQL'
SELECT COUNT(*) AS remaining_active_subagent_threads
FROM threads
WHERE archived = 0
  AND thread_source = 'subagent';
SQL
