#!/usr/bin/env bash
# End-to-end local restic proof for fleet backup, audit, and safe restore.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BACKUP="${ROOT}/scripts/fleet-restic-backup.sh"
AUDIT="${ROOT}/scripts/fleet-restic-audit.sh"
RESTORE="${ROOT}/scripts/fleet-restic-restore.sh"
EXCLUDES="${ROOT}/scripts/fleet-restic-excludes.txt"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleet-restic-test.XXXXXX")"
OUTPUT_LOG="${TMP}/commands.log"
FAILURES=0
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
}

assert_file() {
  [ -f "$1" ] || fail "expected file: $1"
}

assert_absent() {
  [ ! -e "$1" ] || fail "expected excluded path to be absent: $1"
}

expect_failure() {
  label="$1"
  shift
  if "$@" >>"$OUTPUT_LOG" 2>&1; then
    fail "$label unexpectedly succeeded"
  fi
}

json_assert_latest() {
  ledger="$1"
  expected_status="$2"
  expected_error="$3"
  python3 - "$ledger" "$expected_status" "$expected_error" <<'PY' || return 1
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    rows = [json.loads(line) for line in handle if line.strip()]
assert rows, "ledger empty"
row = rows[-1]
assert row["status"] == sys.argv[2], row
assert row["error_class"] == sys.argv[3], row
PY
}

make_config() {
  config="$1"
  repo="$2"
  password="$3"
  paths="$4"
  state="$5"
  cat >"$config" <<EOF
RESTIC_REPOSITORY='$repo'
RESTIC_PASSWORD_FILE='$password'
FLEET_RESTIC_PATHS_FILE='$paths'
FLEET_RESTIC_EXCLUDES_FILE='$EXCLUDES'
FLEET_RESTIC_STATE_DIR='$state'
FLEET_RESTIC_MAX_AGE_SECONDS='3600'
AWS_SECRET_ACCESS_KEY='DO_NOT_LEAK_BACKUP_SECRET'
EOF
  chmod 600 "$config"
}

command -v restic >/dev/null 2>&1 || {
  echo "SKIP: restic is required for fleet-restic-backup.test.sh" >&2
  exit 77
}
command -v python3 >/dev/null 2>&1 || {
  echo "SKIP: python3 is required for fleet-restic-backup.test.sh" >&2
  exit 77
}

bash -n "$BACKUP" "$AUDIT" "$RESTORE" "$0" || fail "bash syntax check"

# Four isolated roots model source, runtime, Claude, and Codex state without
# touching or naming production paths.
FIXTURE="${TMP}/fixture"
SOURCE="${FIXTURE}/source"
RUNTIME="${FIXTURE}/runtime"
CLAUDE="${FIXTURE}/claude"
CODEX="${FIXTURE}/codex"
mkdir -p \
  "${SOURCE}/src" "${SOURCE}/node_modules/pkg" "${SOURCE}/dist" \
  "${RUNTIME}/logs" "${RUNTIME}/messages" \
  "${CLAUDE}/projects/example" "${CODEX}/sessions" "${CODEX}/skills/example"
printf '{"name":"fixture"}\n' >"${SOURCE}/package.json"
printf 'source\n' >"${SOURCE}/src/index.ts"
printf 'rebuildable\n' >"${SOURCE}/node_modules/pkg/ignored.txt"
printf 'build output\n' >"${SOURCE}/dist/ignored.js"
printf '{"event":"kept"}\n' >"${RUNTIME}/logs/events.jsonl"
printf '{"message":"kept"}\n' >"${RUNTIME}/messages/history.jsonl"
printf '12345\n' >"${RUNTIME}/daemon.pid"
printf '{"session":"claude"}\n' >"${CLAUDE}/projects/example/session.jsonl"
printf '{"session":"codex"}\n' >"${CODEX}/sessions/thread.jsonl"
printf 'skill state\n' >"${CODEX}/skills/example/SKILL.md"

PATHS="${TMP}/framework-paths.txt"
printf '%s\n%s\n%s\n%s\n' "$SOURCE" "$RUNTIME" "$CLAUDE" "$CODEX" >"$PATHS"
PASSWORD="${TMP}/restic-password"
printf 'local-test-password\n' >"$PASSWORD"
chmod 600 "$PASSWORD"
REPOSITORY="${TMP}/repository"
STATE="${TMP}/state"
CONFIG="${TMP}/framework.env"
make_config "$CONFIG" "$REPOSITORY" "$PASSWORD" "$PATHS" "$STATE"

RESTIC_REPOSITORY="$REPOSITORY" RESTIC_PASSWORD_FILE="$PASSWORD" \
  restic init --quiet >>"$OUTPUT_LOG" 2>&1 || fail "local repository init"

# Dry-run proves coverage without creating a snapshot or running retention.
CORTEXTOS_BACKUP_CONFIG_FILE="$CONFIG" "$BACKUP" --profile framework --dry-run \
  >>"$OUTPUT_LOG" 2>&1 || fail "framework dry-run"
snapshot_count="$(RESTIC_REPOSITORY="$REPOSITORY" RESTIC_PASSWORD_FILE="$PASSWORD" \
  restic snapshots --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
[ "$snapshot_count" = "0" ] || fail "dry-run created a snapshot"
json_assert_latest "${STATE}/framework-runs.jsonl" "dry_run" "none" \
  || fail "dry-run receipt"

# Real backup includes durable logs/messages/CLI state, checks integrity, and
# applies retention only after the snapshot is listable.
CORTEXTOS_BACKUP_CONFIG_FILE="$CONFIG" "$BACKUP" --profile framework \
  >>"$OUTPUT_LOG" 2>&1 || fail "framework backup"
[ ! -d "${STATE}/locks/framework.lock" ] || fail "backup lock was not cleaned up"
json_assert_latest "${STATE}/framework-runs.jsonl" "success" "none" \
  || fail "success receipt"
python3 - "${STATE}/framework-runs.jsonl" <<'PY' || fail "success receipt fields"
import json
import sys
row = json.loads(open(sys.argv[1], encoding="utf-8").read().splitlines()[-1])
assert row["source_root_count"] == 4
assert row["snapshot_id"]
assert row["integrity_status"] == "ok"
assert row["retention_status"] == "ok"
PY

RESTORE_TARGET="${TMP}/restore"
CORTEXTOS_BACKUP_CONFIG_FILE="$CONFIG" "$RESTORE" --profile framework \
  --snapshot latest --target "$RESTORE_TARGET" >>"$OUTPUT_LOG" 2>&1 \
  || fail "framework restore"
[ ! -d "${STATE}/locks/framework.lock" ] || fail "restore lock was not cleaned up"

restored() {
  printf '%s/%s\n' "$RESTORE_TARGET" "${1#/}"
}

assert_file "$(restored "${SOURCE}/package.json")"
assert_file "$(restored "${RUNTIME}/logs/events.jsonl")"
assert_file "$(restored "${RUNTIME}/messages/history.jsonl")"
assert_file "$(restored "${CLAUDE}/projects/example/session.jsonl")"
assert_file "$(restored "${CODEX}/sessions/thread.jsonl")"
assert_file "$(restored "${CODEX}/skills/example/SKILL.md")"
assert_absent "$(restored "${SOURCE}/node_modules/pkg/ignored.txt")"
assert_absent "$(restored "${SOURCE}/dist/ignored.js")"
assert_absent "$(restored "${RUNTIME}/daemon.pid")"

# Verify-only is non-mutating and accepts an already-populated scratch target.
CORTEXTOS_BACKUP_CONFIG_FILE="$CONFIG" "$RESTORE" --profile framework \
  --snapshot latest --target "$RESTORE_TARGET" --verify-only \
  >>"$OUTPUT_LOG" 2>&1 || fail "verify-only restore proof"
json_assert_latest "${STATE}/framework-restore.jsonl" "success" "none" \
  || fail "restore receipt"
python3 - "${STATE}/framework-restore.jsonl" <<'PY' || fail "restore receipt fields"
import json
import sys
row = json.loads(open(sys.argv[1], encoding="utf-8").read().splitlines()[-1])
assert row["verified_root_count"] == 4
assert row["sentinels_verified"] is True
assert row["verify_only"] is True
PY

# Audit states: current green, newest red, and absent receipt.
CORTEXTOS_BACKUP_CONFIG_FILE="$CONFIG" "$AUDIT" --profile framework \
  >>"$OUTPUT_LOG" 2>&1 || fail "green audit"
python3 - "${STATE}/framework-runs.jsonl" <<'PY'
import datetime
import json
import sys
row = {
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "profile": "framework",
    "status": "failed",
    "snapshot_id": None,
    "duration_seconds": 0,
    "host": "fixture",
    "source_root_count": 4,
    "integrity_status": "not_run",
    "retention_status": "not_run",
    "error_class": "backup_failed",
}
with open(sys.argv[1], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(row) + "\n")
PY
expect_failure "red audit" env CORTEXTOS_BACKUP_CONFIG_FILE="$CONFIG" \
  "$AUDIT" --profile framework

MISSING_STATE="${TMP}/missing-state"
MISSING_CONFIG="${TMP}/missing-audit.env"
make_config "$MISSING_CONFIG" "$REPOSITORY" "$PASSWORD" "$PATHS" "$MISSING_STATE"
expect_failure "missing audit" env CORTEXTOS_BACKUP_CONFIG_FILE="$MISSING_CONFIG" \
  "$AUDIT" --profile framework

# Missing config, empty business roots, and a held same-profile lock are loud.
expect_failure "missing config" env \
  CORTEXTOS_BACKUP_CONFIG_FILE="${TMP}/does-not-exist.env" \
  FLEET_RESTIC_STATE_DIR="${TMP}/missing-config-state" \
  "$BACKUP" --profile framework
json_assert_latest "${TMP}/missing-config-state/framework-runs.jsonl" "failed" "missing_config" \
  || fail "missing-config receipt"

EMPTY_PATHS="${TMP}/empty-business-paths.txt"
: >"$EMPTY_PATHS"
BUSINESS_CONFIG="${TMP}/business.env"
BUSINESS_STATE="${TMP}/business-state"
make_config "$BUSINESS_CONFIG" "$REPOSITORY" "$PASSWORD" "$EMPTY_PATHS" "$BUSINESS_STATE"
expect_failure "empty business paths" env CORTEXTOS_BACKUP_CONFIG_FILE="$BUSINESS_CONFIG" \
  "$BACKUP" --profile business
json_assert_latest "${BUSINESS_STATE}/business-runs.jsonl" "failed" "empty_paths" \
  || fail "empty business receipt"

mkdir -p "${STATE}/locks/framework.lock"
expect_failure "same-profile lock" env CORTEXTOS_BACKUP_CONFIG_FILE="$CONFIG" \
  "$BACKUP" --profile framework
rmdir "${STATE}/locks/framework.lock"
json_assert_latest "${STATE}/framework-runs.jsonl" "failed" "lock_busy" \
  || fail "lock receipt"

# Unsafe targets are rejected before restic can write anything.
expect_failure "root restore target" env CORTEXTOS_BACKUP_CONFIG_FILE="$CONFIG" \
  "$RESTORE" --profile framework --snapshot latest --target /
expect_failure "home restore target" env CORTEXTOS_BACKUP_CONFIG_FILE="$CONFIG" \
  "$RESTORE" --profile framework --snapshot latest --target "$HOME"
expect_failure "repository restore target" env CORTEXTOS_BACKUP_CONFIG_FILE="$CONFIG" \
  "$RESTORE" --profile framework --snapshot latest --target "$ROOT"
NONEMPTY="${TMP}/nonempty"
mkdir -p "$NONEMPTY"
printf 'keep\n' >"${NONEMPTY}/existing.txt"
expect_failure "nonempty restore target" env CORTEXTOS_BACKUP_CONFIG_FILE="$CONFIG" \
  "$RESTORE" --profile framework --snapshot latest --target "$NONEMPTY"
assert_file "${NONEMPTY}/existing.txt"

# A fake restic makes the negative sequencing falsifiable: forget/prune must
# never run after backup failure or after a failed snapshot listing.
FAKE_BIN="${TMP}/fake-bin"
mkdir -p "$FAKE_BIN"
cat >"${FAKE_BIN}/restic" <<'SH'
#!/usr/bin/env bash
case "${FAKE_RESTIC_MODE:-}" in
  backup-fail)
    [ "${1:-}" = "backup" ] && exit 9
    ;;
  list-fail)
    case "${1:-}" in
      backup) printf '%s\n' '{"message_type":"summary","snapshot_id":"abcdef1234567890"}'; exit 0 ;;
      snapshots) exit 8 ;;
    esac
    ;;
  check-fail)
    case "${1:-}" in
      backup) printf '%s\n' '{"message_type":"summary","snapshot_id":"abcdef1234567890"}'; exit 0 ;;
      snapshots) printf '%s\n' '[{"id":"abcdef1234567890"}]'; exit 0 ;;
      check) exit 7 ;;
    esac
    ;;
esac
if [ "${1:-}" = "forget" ]; then
  : >"$FORGET_MARKER"
fi
exit 0
SH
chmod +x "${FAKE_BIN}/restic"

FAIL_STATE="${TMP}/failed-backup-state"
FAIL_CONFIG="${TMP}/failed-backup.env"
make_config "$FAIL_CONFIG" "fixture:repo" "$PASSWORD" "$PATHS" "$FAIL_STATE"
FORGET_MARKER="${TMP}/forget-after-failure"
expect_failure "failed backup" env PATH="${FAKE_BIN}:$PATH" \
  FAKE_RESTIC_MODE=backup-fail FORGET_MARKER="$FORGET_MARKER" \
  CORTEXTOS_BACKUP_CONFIG_FILE="$FAIL_CONFIG" "$BACKUP" --profile framework
assert_absent "$FORGET_MARKER"
json_assert_latest "${FAIL_STATE}/framework-runs.jsonl" "failed" "backup_failed" \
  || fail "failed-backup receipt"

LIST_STATE="${TMP}/failed-list-state"
LIST_CONFIG="${TMP}/failed-list.env"
make_config "$LIST_CONFIG" "fixture:repo" "$PASSWORD" "$PATHS" "$LIST_STATE"
expect_failure "failed snapshot listing" env PATH="${FAKE_BIN}:$PATH" \
  FAKE_RESTIC_MODE=list-fail FORGET_MARKER="$FORGET_MARKER" \
  CORTEXTOS_BACKUP_CONFIG_FILE="$LIST_CONFIG" "$BACKUP" --profile framework
assert_absent "$FORGET_MARKER"
json_assert_latest "${LIST_STATE}/framework-runs.jsonl" "failed" "snapshot_listing_failed" \
  || fail "snapshot-listing receipt"

CHECK_STATE="${TMP}/failed-check-state"
CHECK_CONFIG="${TMP}/failed-check.env"
make_config "$CHECK_CONFIG" "fixture:repo" "$PASSWORD" "$PATHS" "$CHECK_STATE"
expect_failure "failed integrity check" env PATH="${FAKE_BIN}:$PATH" \
  FAKE_RESTIC_MODE=check-fail FORGET_MARKER="$FORGET_MARKER" \
  CORTEXTOS_BACKUP_CONFIG_FILE="$CHECK_CONFIG" "$BACKUP" --profile framework
assert_absent "$FORGET_MARKER"
json_assert_latest "${CHECK_STATE}/framework-runs.jsonl" "failed" "integrity_failed" \
  || fail "integrity-failure receipt"

# Secrets are permitted in the operator config but never emitted to output or
# receipts. Search only generated logs/state, not the config itself.
if grep -R -F 'DO_NOT_LEAK_BACKUP_SECRET' "$OUTPUT_LOG" "$STATE" "$BUSINESS_STATE" \
  "$FAIL_STATE" "$LIST_STATE" "$CHECK_STATE" >/dev/null 2>&1; then
  fail "operator secret leaked into output or receipt"
fi

if [ "$FAILURES" -ne 0 ]; then
  echo "fleet-restic-backup.test: FAIL (${FAILURES})" >&2
  exit 1
fi
echo "fleet-restic-backup.test: PASS"
