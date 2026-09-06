#!/usr/bin/env bash
# Receipt-based backup health check. It never opens the restic repository and
# never prints configuration values.

set -euo pipefail

usage() {
  echo "usage: $0 --profile framework|business" >&2
  exit 64
}

PROFILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      [ "$#" -ge 2 ] || usage
      PROFILE="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done
case "$PROFILE" in
  framework|business) ;;
  *) usage ;;
esac

CONFIG_FILE="${CORTEXTOS_BACKUP_CONFIG_FILE:-${XDG_CONFIG_HOME:-${HOME}/.config}/cortextos/fleet-restic-${PROFILE}.env}"
STATE_DIR="${FLEET_RESTIC_STATE_DIR:-${HOME}/.cortextos/backup-dr}"

file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

send_alert() {
  message="$1"
  if [ -n "${CORTEXTOS_BACKUP_ALERT_CHAT_ID:-}" ] && command -v cortextos >/dev/null 2>&1; then
    cortextos bus send-telegram "$CORTEXTOS_BACKUP_ALERT_CHAT_ID" "$message" >/dev/null 2>&1 || true
  fi
}

if [ ! -f "$CONFIG_FILE" ]; then
  echo "fleet-restic-audit: RED profile=${PROFILE} class=missing_config" >&2
  exit 1
fi
if [ "$(file_mode "$CONFIG_FILE")" != "600" ]; then
  echo "fleet-restic-audit: RED profile=${PROFILE} class=unsafe_config_mode" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$CONFIG_FILE"
set +a

STATE_DIR="${FLEET_RESTIC_STATE_DIR:-${HOME}/.cortextos/backup-dr}"
LEDGER="${STATE_DIR}/${PROFILE}-runs.jsonl"
MAX_AGE_SECONDS="${FLEET_RESTIC_MAX_AGE_SECONDS:-129600}"
case "$MAX_AGE_SECONDS" in
  ''|*[!0-9]*)
    echo "fleet-restic-audit: RED profile=${PROFILE} class=invalid_max_age" >&2
    exit 1
    ;;
esac

set +e
audit_result="$(python3 - "$LEDGER" "$PROFILE" "$MAX_AGE_SECONDS" <<'PY'
import datetime
import json
import os
import sys

path, profile, max_age_text = sys.argv[1:]
if not os.path.isfile(path):
    print("MISSING no_receipt")
    raise SystemExit(2)

with open(path, encoding="utf-8") as handle:
    lines = [line.strip() for line in handle if line.strip()]
if not lines:
    print("MISSING no_receipt")
    raise SystemExit(2)

try:
    row = json.loads(lines[-1])
except json.JSONDecodeError:
    print("RED malformed_receipt")
    raise SystemExit(3)

if row.get("profile") != profile:
    print("RED profile_mismatch")
    raise SystemExit(3)
if row.get("status") != "success":
    print("RED latest_run_failed")
    raise SystemExit(3)
if row.get("integrity_status") != "ok" or row.get("retention_status") != "ok":
    print("RED verification_incomplete")
    raise SystemExit(3)

try:
    timestamp = datetime.datetime.fromisoformat(str(row["timestamp"]).replace("Z", "+00:00"))
    now = datetime.datetime.now(datetime.timezone.utc)
    age = max(0, int((now - timestamp).total_seconds()))
except (KeyError, TypeError, ValueError):
    print("RED invalid_timestamp")
    raise SystemExit(3)

if age > int(max_age_text):
    print("MISSING stale_receipt")
    raise SystemExit(2)
print(f"GREEN age_seconds={age}")
PY
)"
audit_rc=$?
set -e

case "$audit_rc" in
  0)
    echo "fleet-restic-audit: GREEN profile=${PROFILE} ${audit_result#GREEN }"
    exit 0
    ;;
  2)
    class="${audit_result#MISSING }"
    echo "fleet-restic-audit: MISSING profile=${PROFILE} class=${class}" >&2
    send_alert "cortextOS backup MISSING: profile=${PROFILE} class=${class}"
    exit 1
    ;;
  *)
    class="${audit_result#RED }"
    echo "fleet-restic-audit: RED profile=${PROFILE} class=${class}" >&2
    send_alert "cortextOS backup RED: profile=${PROFILE} class=${class}"
    exit 1
    ;;
esac
