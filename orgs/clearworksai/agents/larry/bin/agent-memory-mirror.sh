#!/bin/bash
set -u

SRC="$HOME/.claude/projects/-Users-joshweiss-code-cortextos/memory"
DST="$HOME/code/knowledge-sync/raw/areas/clearworks/agent-memory"

# Safety gate: check if source exists and contains at least one top-level *.md file
if [[ ! -d "$SRC" ]]; then
  echo '{"error":"source missing or empty","exit":1}'
  exit 1
fi

SOURCE_COUNT=$(find "$SRC" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')
if [[ "$SOURCE_COUNT" -eq 0 ]]; then
  echo '{"error":"source missing or empty","exit":1}'
  exit 1
fi

# Create destination directory
mkdir -p "$DST"

# Mirror: top-level *.md ONLY, one-way, deletions propagate
RSYNC_OUTPUT=$(rsync -a --delete --include='/*.md' --exclude='*' "$SRC/" "$DST/" 2>&1)
RSYNC_STATUS=$?

# Count mirrored files
MIRRORED=$(find "$DST" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')

# Count deletions from rsync output
DELETED=$(echo "$RSYNC_OUTPUT" | grep -c "^*deleting" || echo "0")

# Emit final JSON line
echo "{\"mirrored\":$MIRRORED,\"deleted\":$DELETED,\"source_count\":$SOURCE_COUNT,\"exit\":0}"

# Exit 0 only if rsync succeeded and mirrored == source_count
if [[ "$RSYNC_STATUS" -ne 0 ]] || [[ "$MIRRORED" -ne "$SOURCE_COUNT" ]]; then
  exit 1
fi

exit 0