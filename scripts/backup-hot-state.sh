#!/usr/bin/env bash
# WS7 — written but NOT scheduled/run; cutover is a separate Josh-approved window.
#
# backup-hot-state.sh — hot-state snapshot of a cortextOS instance.
#
# ALL hot state (crons, tasks, memory, KB manifests) lives under
# ~/.cortextos/<instance>/ OUTSIDE git — a single copy with no backup. This
# script produces a point-in-time tarball of the hot-state dirs
# (config/, state/, orgs/) so a cutover or a bad day is recoverable.
#
# Usage:
#   backup-hot-state.sh [--instance <id>] [--home <dir>] [--dest <dir>] [--run]
#
# Defaults:
#   --home      $HOME/.cortextos
#   --instance  first line of <home>/ACTIVE_INSTANCE, else cortextos1
#   --dest      $HOME/.cortextos-backups
#
# DRY-RUN BY DEFAULT: without --run it only prints what would be archived
# (directory listing + du -sh of each hot-state dir). With --run it creates
#   <dest>/<instance>-<UTC timestamp>.tar.gz
# from those dirs, excluding chromadb binary dirs (a manifest of excluded
# paths is written into the archive instead).
#
# STRICTLY READ-ONLY on the source tree: never deletes, never writes inside
# <home>. All writes go to <dest> (and a mktemp staging dir for the manifest).

set -euo pipefail

INSTANCE=""
CTX_HOME="${HOME}/.cortextos"
DEST="${HOME}/.cortextos-backups"
RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance)
      INSTANCE="${2:?--instance requires a value}"; shift 2 ;;
    --home)
      CTX_HOME="${2:?--home requires a value}"; shift 2 ;;
    --dest)
      DEST="${2:?--dest requires a value}"; shift 2 ;;
    --run)
      RUN=1; shift ;;
    -h|--help)
      sed -n '2,26p' "$0"; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Resolve instance: --instance > <home>/ACTIVE_INSTANCE marker > cortextos1.
if [[ -z "$INSTANCE" ]]; then
  if [[ -f "$CTX_HOME/ACTIVE_INSTANCE" ]]; then
    INSTANCE="$(head -n 1 "$CTX_HOME/ACTIVE_INSTANCE" | tr -d '[:space:]')"
  fi
  if [[ -z "$INSTANCE" ]] || ! [[ "$INSTANCE" =~ ^[a-z0-9_-]+$ ]]; then
    INSTANCE="cortextos1"
  fi
fi

if ! [[ "$INSTANCE" =~ ^[a-z0-9_-]+$ ]]; then
  echo "Invalid instance id: $INSTANCE" >&2; exit 2
fi

SRC="$CTX_HOME/$INSTANCE"
if [[ ! -d "$SRC" ]]; then
  echo "Instance dir not found: $SRC" >&2; exit 1
fi

# Hot-state dirs to snapshot (crons/config, tasks/memory state, org tasks/KB manifests).
HOT_DIRS=()
for d in config state orgs; do
  [[ -d "$SRC/$d" ]] && HOT_DIRS+=("$d")
done

if [[ ${#HOT_DIRS[@]} -eq 0 ]]; then
  echo "No hot-state dirs (config/state/orgs) found under $SRC" >&2; exit 1
fi

# Enumerate chromadb binary dirs to exclude (recorded in a manifest instead).
EXCLUDED_PATHS="$(find "${HOT_DIRS[@]/#/$SRC/}" -type d -name 'chromadb*' 2>/dev/null | sort || true)"

echo "backup-hot-state: instance=$INSTANCE"
echo "  source: $SRC"
echo "  dest:   $DEST"
echo "  dirs:"
for d in "${HOT_DIRS[@]}"; do
  du -sh "$SRC/$d" | sed 's/^/    /'
done
echo "  contents:"
for d in "${HOT_DIRS[@]}"; do
  ls -la "$SRC/$d" | sed "s|^|    $d/ |"
done
if [[ -n "$EXCLUDED_PATHS" ]]; then
  echo "  excluded (chromadb binary dirs, manifest only):"
  echo "$EXCLUDED_PATHS" | sed 's/^/    /'
fi

if [[ "$RUN" -ne 1 ]]; then
  echo ""
  echo "DRY RUN — nothing archived. Re-run with --run to create the snapshot."
  exit 0
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$DEST/$INSTANCE-$TIMESTAMP.tar.gz"
mkdir -p "$DEST"

# Stage the exclusion manifest OUTSIDE the source tree (read-only guarantee).
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/backup-hot-state.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
MANIFEST="$STAGING/EXCLUDED-PATHS.manifest"
{
  echo "# chromadb binary dirs excluded from $ARCHIVE"
  echo "# instance: $INSTANCE  source: $SRC  created: $TIMESTAMP"
  if [[ -n "$EXCLUDED_PATHS" ]]; then
    echo "$EXCLUDED_PATHS"
  else
    echo "# (none found)"
  fi
} > "$MANIFEST"

tar -czf "$ARCHIVE" \
  --exclude='*/chromadb*' \
  -C "$STAGING" "EXCLUDED-PATHS.manifest" \
  -C "$SRC" "${HOT_DIRS[@]}"

echo ""
echo "Snapshot written: $ARCHIVE"
du -sh "$ARCHIVE" | sed 's/^/  /'
