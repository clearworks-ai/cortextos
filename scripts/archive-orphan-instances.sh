#!/usr/bin/env bash
# archive-orphan-instances.sh — EDIT 3 of cron-register-reliability
# Default: DRY-RUN print only. Pass --execute to actually archive.
# Archives ~/.cortextos/default/.cortextOS → ~/.cortextos/default/.archived-2026-07/
set -uo pipefail
EXECUTE=0
if [[ "${1:-}" == "--execute" ]]; then EXECUTE=1; fi

ACTIVE_MARKER="${HOME}/.cortextos/state/ACTIVE_INSTANCE"
ACTIVE=$(tr -d '[:space:]' < "$ACTIVE_MARKER" 2>/dev/null || echo "cortextos1")
DEFAULT_ROOT="${HOME}/.cortextos/default"
DEFAULT_TREE="${DEFAULT_ROOT}/.cortextOS"
ARCHIVE_ROOT="${DEFAULT_ROOT}/.archived-2026-07"
LIVE_ROOT="${HOME}/.cortextos/${ACTIVE}/.cortextOS"

echo "Active instance: ${ACTIVE}"
echo "Orphan tree:     ${DEFAULT_TREE}"
echo "Archive root:    ${ARCHIVE_ROOT}"
echo "Live root:       ${LIVE_ROOT}"
echo

if [[ ! -d "$DEFAULT_TREE" ]]; then
  echo "No orphan tree at ${DEFAULT_TREE} — nothing to archive."
  exit 0
fi

echo "=== Diff: orphan-only crons (present in default, not in live) ==="
ORPHAN_ONLY=0
while IFS= read -r -d '' f; do
  agent=$(basename "$(dirname "$f")")
  live_f="${LIVE_ROOT}/state/agents/${agent}/crons.json"
  if [[ ! -f "$live_f" ]]; then
    echo "AGENT ${agent}: entire crons.json only in orphan"
    ORPHAN_ONLY=$((ORPHAN_ONLY+1))
    continue
  fi
  # list cron names
  python3 - "$f" "$live_f" "$agent" <<'PY' || true
import json,sys
orphan=json.load(open(sys.argv[1]))
live=json.load(open(sys.argv[2]))
agent=sys.argv[3]
onames={c.get("name") for c in orphan.get("crons",[]) if c.get("name")}
lnames={c.get("name") for c in live.get("crons",[]) if c.get("name")}
only=sorted(onames-lnames)
if only:
    print(f"AGENT {agent}: orphan-only crons: {', '.join(only)}")
PY
done < <(find "$DEFAULT_TREE/state/agents" -name crons.json -print0 2>/dev/null)

echo
if [[ "$EXECUTE" -eq 1 ]]; then
  mkdir -p "$ARCHIVE_ROOT"
  echo "MOVING ${DEFAULT_TREE} → ${ARCHIVE_ROOT}/"
  mv "$DEFAULT_TREE" "$ARCHIVE_ROOT/"
  echo "Done."
else
  echo "DRY-RUN only. Re-run with --execute to archive (after reviewing orphan-only list above)."
fi
