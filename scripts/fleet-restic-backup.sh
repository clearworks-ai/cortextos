#!/usr/bin/env bash
# Encrypted, profile-scoped cortextOS fleet backup. This script is inert until
# an operator supplies a mode-0600 config file and initialized restic repo.

set -euo pipefail

usage() {
  echo "usage: $0 --profile framework|business [--dry-run]" >&2
  exit 64
}

PROFILE=""
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      [ "$#" -ge 2 ] || usage
      PROFILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *) usage ;;
  esac
done

case "$PROFILE" in
  framework|business) ;;
  *) usage ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
HOST_NAME="$(hostname -s 2>/dev/null || hostname)"
START_EPOCH="$(date +%s)"
SNAPSHOT_ID=""
INTEGRITY_STATUS="not_run"
RETENTION_STATUS="not_run"
SOURCE_ROOT_COUNT=0
LOCK_HELD=0
LOCK_DIR=""
TMP_DIR=""

default_state_dir() {
  printf '%s\n' "${HOME}/.cortextos/backup-dr"
}

CONFIG_FILE="${CORTEXTOS_BACKUP_CONFIG_FILE:-${XDG_CONFIG_HOME:-${HOME}/.config}/cortextos/fleet-restic-${PROFILE}.env}"
STATE_DIR="${FLEET_RESTIC_STATE_DIR:-$(default_state_dir)}"
LEDGER="${STATE_DIR}/${PROFILE}-runs.jsonl"

file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

append_receipt() {
  status="$1"
  error_class="$2"
  duration="$(( $(date +%s) - START_EPOCH ))"
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
  python3 - "$LEDGER" "$PROFILE" "$status" "$SNAPSHOT_ID" "$duration" \
    "$HOST_NAME" "$SOURCE_ROOT_COUNT" "$INTEGRITY_STATUS" \
    "$RETENTION_STATUS" "$error_class" <<'PY'
import datetime
import json
import os
import sys

(path, profile, status, snapshot_id, duration, host, root_count,
 integrity, retention, error_class) = sys.argv[1:]
row = {
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "profile": profile,
    "status": status,
    "snapshot_id": snapshot_id or None,
    "duration_seconds": int(duration),
    "host": host,
    "source_root_count": int(root_count),
    "integrity_status": integrity,
    "retention_status": retention,
    "error_class": error_class,
}
payload = (json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n").encode()
fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
try:
    os.write(fd, payload)
finally:
    os.close(fd)
os.chmod(path, 0o600)
PY
}

fail_run() {
  error_class="$1"
  message="$2"
  echo "fleet-restic-backup: ERROR: ${message}" >&2
  append_receipt "failed" "$error_class"
  exit 1
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  if [ "$LOCK_HELD" -eq 1 ] && [ -n "$LOCK_DIR" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

command -v python3 >/dev/null 2>&1 || fail_run "missing_dependency" "python3 is required"

if [ ! -f "$CONFIG_FILE" ]; then
  fail_run "missing_config" "operator config is missing"
fi
if [ "$(file_mode "$CONFIG_FILE")" != "600" ]; then
  fail_run "unsafe_config_mode" "operator config must have mode 0600"
fi

set -a
# shellcheck disable=SC1090
. "$CONFIG_FILE"
set +a

STATE_DIR="${FLEET_RESTIC_STATE_DIR:-$(default_state_dir)}"
LEDGER="${STATE_DIR}/${PROFILE}-runs.jsonl"
mkdir -p "${STATE_DIR}/locks"
chmod 700 "$STATE_DIR" "${STATE_DIR}/locks" 2>/dev/null || true
LOCK_DIR="${STATE_DIR}/locks/${PROFILE}.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  fail_run "lock_busy" "another ${PROFILE} operation is already running"
fi
LOCK_HELD=1

case "$PROFILE" in
  framework)
    RESTIC_REPOSITORY="${FRAMEWORK_RESTIC_REPOSITORY:-${RESTIC_REPOSITORY:-}}"
    RESTIC_PASSWORD_FILE="${FRAMEWORK_RESTIC_PASSWORD_FILE:-${RESTIC_PASSWORD_FILE:-}}"
    PATHS_FILE="${FLEET_RESTIC_PATHS_FILE:-${SCRIPT_DIR}/fleet-restic-paths-framework.txt}"
    ;;
  business)
    RESTIC_REPOSITORY="${BUSINESS_RESTIC_REPOSITORY:-${RESTIC_REPOSITORY:-}}"
    RESTIC_PASSWORD_FILE="${BUSINESS_RESTIC_PASSWORD_FILE:-${RESTIC_PASSWORD_FILE:-}}"
    PATHS_FILE="${FLEET_RESTIC_PATHS_FILE:-${XDG_CONFIG_HOME:-${HOME}/.config}/cortextos/fleet-restic-paths-business.txt}"
    ;;
esac
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE

[ -n "$RESTIC_REPOSITORY" ] || fail_run "missing_repository" "restic repository is not configured"
[ -n "$RESTIC_PASSWORD_FILE" ] || fail_run "missing_password_file" "restic password file is not configured"
[ -f "$RESTIC_PASSWORD_FILE" ] || fail_run "missing_password_file" "restic password file is missing"
password_mode="$(file_mode "$RESTIC_PASSWORD_FILE")"
case "$password_mode" in
  400|600) ;;
  *) fail_run "unsafe_password_mode" "restic password file must have mode 0400 or 0600" ;;
esac
command -v restic >/dev/null 2>&1 || fail_run "missing_dependency" "restic is required"

[ -f "$PATHS_FILE" ] || fail_run "missing_paths" "profile paths file is missing"
EXCLUDES_FILE="${FLEET_RESTIC_EXCLUDES_FILE:-${SCRIPT_DIR}/fleet-restic-excludes.txt}"
[ -f "$EXCLUDES_FILE" ] || fail_run "missing_excludes" "exclude file is missing"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fleet-restic-backup.XXXXXX")"
NORMALIZED_PATHS="${TMP_DIR}/paths.txt"
: > "$NORMALIZED_PATHS"
while IFS= read -r raw || [ -n "$raw" ]; do
  line="${raw%$'\r'}"
  case "$line" in
    ''|'#'*) continue ;;
    '~') path="$HOME" ;;
    '~/'*) path="${HOME}/${line#\~/}" ;;
    /*) path="$line" ;;
    *) fail_run "invalid_paths" "profile paths must be absolute or home-relative" ;;
  esac
  [ -e "$path" ] || fail_run "missing_source_root" "a configured source root is missing"
  printf '%s\n' "$path" >> "$NORMALIZED_PATHS"
  SOURCE_ROOT_COUNT=$((SOURCE_ROOT_COUNT + 1))
done < "$PATHS_FILE"

[ "$SOURCE_ROOT_COUNT" -gt 0 ] || fail_run "empty_paths" "profile paths file is empty"
if [ "$PROFILE" = "framework" ] && [ "$SOURCE_ROOT_COUNT" -lt 4 ]; then
  fail_run "incomplete_framework_paths" "framework profile must include all four required roots"
fi

BACKUP_OUTPUT="${TMP_DIR}/backup.jsonl"
BACKUP_ERROR="${TMP_DIR}/backup.err"
backup_args=(
  backup
  --json
  --files-from-verbatim "$NORMALIZED_PATHS"
  --exclude-file "$EXCLUDES_FILE"
  --tag "cortextos-fleet"
  --tag "profile:${PROFILE}"
  --host "$HOST_NAME"
)

if [ "$DRY_RUN" -eq 1 ]; then
  if ! restic "${backup_args[@]}" --dry-run >"$BACKUP_OUTPUT" 2>"$BACKUP_ERROR"; then
    fail_run "backup_failed" "restic dry-run failed"
  fi
  append_receipt "dry_run" "none"
  echo "fleet-restic-backup: DRY-RUN OK profile=${PROFILE} roots=${SOURCE_ROOT_COUNT}"
  exit 0
fi

if ! restic "${backup_args[@]}" >"$BACKUP_OUTPUT" 2>"$BACKUP_ERROR"; then
  fail_run "backup_failed" "restic backup failed"
fi

SNAPSHOT_ID="$(python3 - "$BACKUP_OUTPUT" <<'PY'
import json
import sys

snapshot = ""
with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("message_type") == "summary" and row.get("snapshot_id"):
            snapshot = row["snapshot_id"]
print(snapshot)
PY
)"
[ -n "$SNAPSHOT_ID" ] || fail_run "missing_snapshot_id" "backup completed without a snapshot id"

SNAPSHOTS_OUTPUT="${TMP_DIR}/snapshots.json"
if ! restic snapshots --json --tag "profile:${PROFILE}" >"$SNAPSHOTS_OUTPUT" 2>"${TMP_DIR}/snapshots.err"; then
  fail_run "snapshot_listing_failed" "snapshot listing failed; retention was not run"
fi
if ! python3 - "$SNAPSHOTS_OUTPUT" "$SNAPSHOT_ID" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    rows = json.load(handle)
wanted = sys.argv[2]
if not any(str(row.get("id", "")).startswith(wanted) or wanted.startswith(str(row.get("id", ""))) for row in rows):
    raise SystemExit(1)
PY
then
  fail_run "snapshot_listing_failed" "new snapshot was not present in listing; retention was not run"
fi

if restic check --json --read-data-subset=5% >"${TMP_DIR}/check.json" 2>"${TMP_DIR}/check.err"; then
  INTEGRITY_STATUS="ok"
else
  INTEGRITY_STATUS="failed"
  fail_run "integrity_failed" "repository integrity check failed; retention was not run"
fi

if restic forget --json --tag "profile:${PROFILE}" --keep-daily 7 \
  --keep-weekly 4 --keep-monthly 3 --prune >"${TMP_DIR}/forget.json" 2>"${TMP_DIR}/forget.err"; then
  RETENTION_STATUS="ok"
else
  RETENTION_STATUS="failed"
  fail_run "retention_failed" "retention/prune failed; the new snapshot was retained"
fi

append_receipt "success" "none"
echo "fleet-restic-backup: OK profile=${PROFILE} snapshot=${SNAPSHOT_ID} roots=${SOURCE_ROOT_COUNT}"
