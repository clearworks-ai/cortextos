#!/usr/bin/env bash
# Non-destructive-by-default restic restore and sentinel verification.

set -euo pipefail

usage() {
  echo "usage: $0 --profile framework|business --snapshot <id|latest> --target <absolute-dir> [--verify-only] [--in-place]" >&2
  exit 64
}

PROFILE=""
SNAPSHOT=""
TARGET=""
VERIFY_ONLY=0
IN_PLACE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      [ "$#" -ge 2 ] || usage
      PROFILE="$2"
      shift 2
      ;;
    --snapshot)
      [ "$#" -ge 2 ] || usage
      SNAPSHOT="$2"
      shift 2
      ;;
    --target)
      [ "$#" -ge 2 ] || usage
      TARGET="$2"
      shift 2
      ;;
    --verify-only)
      VERIFY_ONLY=1
      shift
      ;;
    --in-place)
      IN_PLACE=1
      shift
      ;;
    *) usage ;;
  esac
done
case "$PROFILE" in
  framework|business) ;;
  *) usage ;;
esac
[ -n "$SNAPSHOT" ] || usage
[ -n "$TARGET" ] || usage
case "$TARGET" in
  /*) ;;
  *) echo "fleet-restic-restore: ERROR: target must be absolute" >&2; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
HOST_NAME="$(hostname -s 2>/dev/null || hostname)"
START_EPOCH="$(date +%s)"
VERIFIED_ROOT_COUNT=0
LOCK_HELD=0
LOCK_DIR=""
TMP_DIR=""
CONFIG_FILE="${CORTEXTOS_BACKUP_CONFIG_FILE:-${XDG_CONFIG_HOME:-${HOME}/.config}/cortextos/fleet-restic-${PROFILE}.env}"
STATE_DIR="${FLEET_RESTIC_STATE_DIR:-${HOME}/.cortextos/backup-dr}"
LEDGER="${STATE_DIR}/${PROFILE}-restore.jsonl"

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
  python3 - "$LEDGER" "$PROFILE" "$status" "$SNAPSHOT" "$duration" \
    "$HOST_NAME" "$VERIFIED_ROOT_COUNT" "$error_class" "$VERIFY_ONLY" <<'PY'
import datetime
import json
import os
import sys

(path, profile, status, snapshot, duration, host, verified_count,
 error_class, verify_only) = sys.argv[1:]
row = {
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "profile": profile,
    "status": status,
    "snapshot": snapshot,
    "duration_seconds": int(duration),
    "host": host,
    "verified_root_count": int(verified_count),
    "sentinels_verified": status == "success",
    "verify_only": verify_only == "1",
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

fail_restore() {
  error_class="$1"
  message="$2"
  echo "fleet-restic-restore: ERROR: ${message}" >&2
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

command -v python3 >/dev/null 2>&1 || fail_restore "missing_dependency" "python3 is required"
if [ ! -f "$CONFIG_FILE" ]; then
  fail_restore "missing_config" "operator config is missing"
fi
if [ "$(file_mode "$CONFIG_FILE")" != "600" ]; then
  fail_restore "unsafe_config_mode" "operator config must have mode 0600"
fi

set -a
# shellcheck disable=SC1090
. "$CONFIG_FILE"
set +a

STATE_DIR="${FLEET_RESTIC_STATE_DIR:-${HOME}/.cortextos/backup-dr}"
LEDGER="${STATE_DIR}/${PROFILE}-restore.jsonl"
mkdir -p "${STATE_DIR}/locks"
chmod 700 "$STATE_DIR" "${STATE_DIR}/locks" 2>/dev/null || true
LOCK_DIR="${STATE_DIR}/locks/${PROFILE}.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  fail_restore "lock_busy" "another ${PROFILE} operation is already running"
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

[ -n "$RESTIC_REPOSITORY" ] || fail_restore "missing_repository" "restic repository is not configured"
[ -n "$RESTIC_PASSWORD_FILE" ] || fail_restore "missing_password_file" "restic password file is not configured"
[ -f "$RESTIC_PASSWORD_FILE" ] || fail_restore "missing_password_file" "restic password file is missing"
password_mode="$(file_mode "$RESTIC_PASSWORD_FILE")"
case "$password_mode" in
  400|600) ;;
  *) fail_restore "unsafe_password_mode" "restic password file must have mode 0400 or 0600" ;;
esac
command -v restic >/dev/null 2>&1 || fail_restore "missing_dependency" "restic is required"
[ -f "$PATHS_FILE" ] || fail_restore "missing_paths" "profile paths file is missing"

TARGET_CANON="$(python3 - "$TARGET" <<'PY'
import os
import sys
print(os.path.realpath(os.path.abspath(sys.argv[1])))
PY
)"
HOME_CANON="$(cd "$HOME" && pwd -P)"
if [ "$IN_PLACE" -eq 0 ]; then
  case "$TARGET" in
    '~'|'~/'*) fail_restore "unsafe_target" "home-relative restore targets are refused" ;;
  esac
  if [ "$TARGET_CANON" = "/" ] || [ "$TARGET_CANON" = "$HOME_CANON" ] || [ "$TARGET_CANON" = "$REPO_ROOT" ]; then
    fail_restore "unsafe_target" "live or repository restore target is refused"
  fi
  if [ -L "$TARGET" ]; then
    fail_restore "unsafe_target" "symlink restore targets are refused"
  fi
  mkdir -p "$TARGET"
  if [ "$VERIFY_ONLY" -eq 0 ] && [ -n "$(find "$TARGET" -mindepth 1 -maxdepth 1 -print 2>/dev/null | sed -n '1p')" ]; then
    fail_restore "nonempty_target" "restore target must be empty"
  fi
else
  [ "${FLEET_RESTIC_IN_PLACE_CONFIRM:-}" = "RESTORE_IN_PLACE" ] \
    || fail_restore "in_place_unconfirmed" "in-place restore requires explicit confirmation"
  [ -d "$TARGET" ] || fail_restore "missing_target" "in-place target must already exist"
fi

PATH_ROOTS=()
while IFS= read -r raw || [ -n "$raw" ]; do
  line="${raw%$'\r'}"
  case "$line" in
    ''|'#'*) continue ;;
    '~') path="$HOME" ;;
    '~/'*) path="${HOME}/${line#\~/}" ;;
    /*) path="$line" ;;
    *) fail_restore "invalid_paths" "profile paths must be absolute or home-relative" ;;
  esac
  PATH_ROOTS+=("$path")
done < "$PATHS_FILE"
[ "${#PATH_ROOTS[@]}" -gt 0 ] || fail_restore "empty_paths" "profile paths file is empty"
if [ "$PROFILE" = "framework" ] && [ "${#PATH_ROOTS[@]}" -lt 4 ]; then
  fail_restore "incomplete_framework_paths" "framework profile must include all four required roots"
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fleet-restic-restore.XXXXXX")"
if [ "$VERIFY_ONLY" -eq 0 ]; then
  if ! restic restore "$SNAPSHOT" --target "$TARGET" --tag "profile:${PROFILE}" \
    >"${TMP_DIR}/restore.out" 2>"${TMP_DIR}/restore.err"; then
    fail_restore "restore_failed" "restic restore failed"
  fi
fi

restored_path() {
  original="$1"
  if [ "$TARGET_CANON" = "/" ]; then
    printf '%s\n' "$original"
  else
    printf '%s/%s\n' "$TARGET_CANON" "${original#/}"
  fi
}

has_files() {
  candidate="$1"
  [ -d "$candidate" ] && [ -n "$(find "$candidate" -type f -print 2>/dev/null | sed -n '1p')" ]
}

if [ "$PROFILE" = "framework" ]; then
  source_root="$(restored_path "${PATH_ROOTS[0]}")"
  runtime_root="$(restored_path "${PATH_ROOTS[1]}")"
  claude_root="$(restored_path "${PATH_ROOTS[2]}")"
  codex_root="$(restored_path "${PATH_ROOTS[3]}")"

  [ -f "${source_root}/package.json" ] \
    || fail_restore "missing_source_manifest" "restored framework manifest is missing"
  VERIFIED_ROOT_COUNT=$((VERIFIED_ROOT_COUNT + 1))

  runtime_history=0
  has_files "${runtime_root}/logs" && runtime_history=1
  has_files "${runtime_root}/messages" && runtime_history=1
  [ "$runtime_history" -eq 1 ] \
    || fail_restore "missing_runtime_history" "restored runtime logs/message history is missing"
  VERIFIED_ROOT_COUNT=$((VERIFIED_ROOT_COUNT + 1))

  if ! has_files "${claude_root}/projects" && [ ! -f "${claude_root}/settings.json" ]; then
    fail_restore "missing_claude_state" "restored Claude state is missing"
  fi
  VERIFIED_ROOT_COUNT=$((VERIFIED_ROOT_COUNT + 1))

  if ! has_files "${codex_root}/sessions" && ! has_files "${codex_root}/skills" && [ ! -f "${codex_root}/config.toml" ]; then
    fail_restore "missing_codex_state" "restored Codex state is missing"
  fi
  VERIFIED_ROOT_COUNT=$((VERIFIED_ROOT_COUNT + 1))
else
  for root in "${PATH_ROOTS[@]}"; do
    restored="$(restored_path "$root")"
    [ -e "$restored" ] || fail_restore "missing_business_root" "a restored business root is missing"
    VERIFIED_ROOT_COUNT=$((VERIFIED_ROOT_COUNT + 1))
  done
fi

append_receipt "success" "none"
if [ "$VERIFY_ONLY" -eq 1 ]; then
  echo "fleet-restic-restore: VERIFY OK profile=${PROFILE} roots=${VERIFIED_ROOT_COUNT}"
else
  echo "fleet-restic-restore: OK profile=${PROFILE} snapshot=${SNAPSHOT} roots=${VERIFIED_ROOT_COUNT}"
fi
