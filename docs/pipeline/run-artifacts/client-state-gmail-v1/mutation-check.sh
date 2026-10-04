#!/bin/bash
# Runs EVERY GUARD_REGISTRY row through control-PASS -> sed-mutate ->
# diff-prove-applied -> mutated-FAIL -> restore-from-backup, dispatching on
# module_path's extension. Writes g4/py-guards.json (.py rows) and
# g4/bus-guards.json (.ts rows). BSD/macOS `sed -i ''`.
#
# wave-2 fixes (G0A-14 / C11):
#   - REPO_ROOT is REQUIRED (no silent worktree default) - an unset/wrong
#     REPO_ROOT sed-mutating the wrong checkout is worse than refusing to run.
#   - the registry loader's own exit code is checked; a loader failure (e.g.
#     ModuleNotFoundError) or a loader that emits ZERO rows is a HARD FAILURE
#     (exit 1), never a silent "0 guards, exit 0" (the exact G0A-14 bug: a
#     failing `< <(process substitution)` fed the while loop nothing and the
#     script still exited 0).
#   - NEVER `git checkout --` a mutated file: at verification time the
#     guard under test (e.g. Task 17's claim guard in src/bus/task.ts) may
#     itself be UNCOMMITTED, and `git checkout --` would silently discard it,
#     not just the mutation (G0B-25). Every target is copied to a backup file
#     before mutation and restored FROM THAT BACKUP under a bash `EXIT` trap,
#     so a mid-run crash (Ctrl-C, unhandled error) still restores every file
#     touched so far - `git checkout --` is never called anywhere in this
#     script.
set -euo pipefail

# G0A2-7: CPython validates a .pyc against (source mtime in SECONDS, source
# size). A control run, the cp, a byte-length-PRESERVING sed and the mutated
# run all complete inside one wall-clock second, so stale bytecode is reused
# and the mutation is invisible ("mutated_red: false" for a guard that DOES
# bite). Never write bytecode here, and sweep any __pycache__ that predates
# this run.
export PYTHONDONTWRITEBYTECODE=1

REPO_ROOT="${CLIENT_STATE_REPO_ROOT:?CLIENT_STATE_REPO_ROOT is required - refusing to sed-mutate an unspecified checkout}"
if [ ! -d "$REPO_ROOT" ]; then
  echo "mutation-check.sh: REPO_ROOT '$REPO_ROOT' is not a directory" >&2
  exit 1
fi

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
G4_DIR="${CLIENT_STATE_G4_DIR:-$SELF_DIR/g4}"
mkdir -p "$G4_DIR"

BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mutation-check-backups.XXXXXX")"
declare -a RESTORE_TARGETS=()
declare -a RESTORE_BACKUPS=()

restore_all() {
  # G0B3-9: the EXIT handler captures the script's real exit status FIRST, then
  # restores. If ANY restore failed we exit non-zero regardless of how the rows
  # went -- finishing "green" while a target is still mutated would be the exact
  # opposite of fail-closed.
  local rc=$?
  local i failed=0
  for ((i = ${#RESTORE_TARGETS[@]} - 1; i >= 0; i--)); do
    local target="${RESTORE_TARGETS[$i]}" backup="${RESTORE_BACKUPS[$i]}"
    if [ -f "$backup" ]; then
      cp "$backup" "$target" || failed=1
    else
      failed=1
    fi
  done
  if [ "$failed" -ne 0 ]; then
    # G0B2-8: a backup we could not restore is the ONE case where the backup
    # directory must survive -- deleting it would strand a mutated file with
    # no way back.
    echo "mutation-check.sh: FATAL - one or more targets could not be restored; backups KEPT at $BACKUP_DIR" >&2
    exit 90            # G0B3-9: overrides a green run
  fi
  rm -rf "$BACKUP_DIR"
  exit "$rc"
}
trap restore_all EXIT

cd "$REPO_ROOT"
purge_pycache_bootstrap() { find "$REPO_ROOT/scripts" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true; }
purge_pycache_bootstrap

FAILED=0

LAST_BACKUP=""

backup_target() {
  # $1 = module_path (relative to REPO_ROOT). Copies it to a fresh backup file,
  # registers it for EXIT-trap restore, and publishes the path in the GLOBAL
  # LAST_BACKUP.
  #
  # G0B2-8: this MUST be called in the parent shell. It used to be invoked as
  # `backup="$(backup_target ...)"`, whose command substitution runs in a
  # SUBSHELL -- the RESTORE_TARGETS/RESTORE_BACKUPS appends happened there and
  # vanished, so the EXIT trap had zero registered targets and an interrupted
  # run left the tree mutated while deleting the only backups.
  local module_path="$1"
  local backup="$BACKUP_DIR/$(echo "$module_path" | tr '/' '_').bak"
  cp "$module_path" "$backup"
  RESTORE_TARGETS+=("$module_path")
  RESTORE_BACKUPS+=("$backup")
  LAST_BACKUP="$backup"
}

purge_pycache() {
  # G0A2-7: mtime-second + size is not enough to invalidate a .pyc for a
  # same-length mutation applied within the same second.
  find "$REPO_ROOT/scripts" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
}

run_py_node() {
  python3 -m pytest "$1" -q -p no:cacheprovider
}

run_ts_node() {
  # $1 = "path::test title" — split on the FIRST "::" only (a vitest test
  # title may itself contain "::").
  local node="$1" file title
  file="${node%%::*}"
  title="${node#*::}"
  npx vitest run "$file" -t "$title"
}

registry_rows() {
  # Emits ALL rows, tab-separated: guard_id, module_path, test_node_id, sed_expr.
  # Exit code is the loader's real exit code — a ModuleNotFoundError or any
  # other import failure propagates as a nonzero rc, checked by the caller.
  python3 - <<'PY'
import sys
sys.path.insert(0, "scripts/brain/tests")
import test_client_state_guards as m
for row in m.GUARD_REGISTRY:
    guard_id, module_path, description, test_node_id, sed_expr = row
    print("\t".join([guard_id, module_path, test_node_id, sed_expr]))
PY
}

# G0B3-9 fault-injection hook, used ONLY by --selftest below: register a target
# whose backup does not exist, mutate it, and exit 0. The REAL EXIT trap must
# still turn that green exit into a failure and keep the backups.
if [ -n "${CLIENT_STATE_MUTATION_BREAK_RESTORE:-}" ]; then
  echo "original" > "$BACKUP_DIR/victim.txt"
  RESTORE_TARGETS+=("$BACKUP_DIR/victim.txt")
  RESTORE_BACKUPS+=("$BACKUP_DIR/does-not-exist.bak")
  echo "mutated" > "$BACKUP_DIR/victim.txt"
  echo "mutation-check.sh: fault injection armed (BACKUP_DIR=$BACKUP_DIR)"
  exit 0
fi

if [ "${1:-}" = "--selftest" ]; then
  set +e
  out="$(CLIENT_STATE_MUTATION_BREAK_RESTORE=1 CLIENT_STATE_REPO_ROOT="$REPO_ROOT" \
           bash "${BASH_SOURCE[0]}" 2>&1)"
  self_rc=$?
  set -e
  if [ "$self_rc" -eq 0 ]; then
    echo "SELFTEST FAILED: a failed EXIT-trap restore did not override the green exit status" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  if ! printf '%s\n' "$out" | grep -q "could not be restored"; then
    echo "SELFTEST FAILED: no restore-failure diagnostic" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  kept="$(printf '%s\n' "$out" | sed -n 's/.*backups KEPT at //p' | tail -1)"
  if [ -z "$kept" ] || [ ! -d "$kept" ]; then
    echo "SELFTEST FAILED: backups were deleted despite a failed restore (kept='$kept')" >&2
    exit 1
  fi
  rm -rf "$kept"
  echo "mutation-check selftest: OK - a failed EXIT-trap restore exits $self_rc and KEEPS the backups (G0B3-9)"
  exit 0
fi

ROWS_FILE="$(mktemp "${TMPDIR:-/tmp}/mutation-check-rows.XXXXXX")"
set +e
registry_rows > "$ROWS_FILE" 2> "$ROWS_FILE.err"
loader_rc=$?
set -e
if [ "$loader_rc" -ne 0 ]; then
  echo "mutation-check.sh: FATAL - GUARD_REGISTRY loader exited $loader_rc (never silently proceeding with zero rows):" >&2
  cat "$ROWS_FILE.err" >&2
  rm -f "$ROWS_FILE" "$ROWS_FILE.err"
  exit 1
fi
row_count=$(grep -c . "$ROWS_FILE" || true)
if [ "${row_count:-0}" -eq 0 ]; then
  echo "mutation-check.sh: FATAL - GUARD_REGISTRY loader exited 0 but emitted ZERO rows (G0A-14 regression guard)" >&2
  rm -f "$ROWS_FILE" "$ROWS_FILE.err"
  exit 1
fi
echo "mutation-check.sh: loaded $row_count guard row(s) from GUARD_REGISTRY"
rm -f "$ROWS_FILE.err"

run_one_row() {
  # $1=guard_id $2=module_path $3=test_node_id $4=sed_expr $5=is_ts(0/1)
  # Writes result fields (no trailing newline) to $ROW_RESULT_FILE.
  local guard_id="$1" module_path="$2" test_node_id="$3" sed_expr="$4" is_ts="$5"
  echo "== $guard_id =="
  local control_green=false mutation_applied=false mutated_red=false
  if [ "$is_ts" -eq 1 ]; then
    if run_ts_node "$test_node_id"; then control_green=true; fi
  else
    if run_py_node "$test_node_id"; then control_green=true; fi
  fi

  # G0B2-8: parent-shell call, so the EXIT-trap arrays actually gain this row.
  backup_target "$module_path"
  local backup="$LAST_BACKUP"
  local before after diff_text
  before="$(cat "$module_path")"
  sed -E -i '' -e "$sed_expr" "$module_path"
  purge_pycache
  after="$(cat "$module_path")"
  diff_text=""
  if [ "$before" != "$after" ]; then
    mutation_applied=true
    diff_text="$(diff -u "$backup" "$module_path" | sed -n '4,12p' | tr '\n' '\r' || true)"
    if [ "$is_ts" -eq 1 ]; then
      if ! run_ts_node "$test_node_id"; then mutated_red=true; fi
    else
      if ! run_py_node "$test_node_id"; then mutated_red=true; fi
    fi
  fi
  # Restore THIS file immediately (not just at script exit) so the next
  # row's control run starts from a clean, unmutated tree — restoration is
  # always from the backup, never `git checkout --`.
  cp "$backup" "$module_path"
  purge_pycache

  # Every row records the same three booleans PLUS the diff that proves the
  # mutation was really applied (G4 item 7 / decision (g)).
  local diff_json
  diff_json="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1].replace(chr(13), chr(10))))' "$diff_text")"
  printf '"control_green": %s, "mutation_applied": %s, "diff_applied": %s, "mutated_red": %s, "diff": %s' \
    "$control_green" "$mutation_applied" "$mutation_applied" "$mutated_red" "$diff_json" > "$ROW_RESULT_FILE"
  if [ "$control_green" != "true" ] || [ "$mutation_applied" != "true" ] || [ "$mutated_red" != "true" ]; then
    FAILED=1
  fi
}

py_out="$G4_DIR/py-guards.json"
ts_out="$G4_DIR/bus-guards.json"
: > "$py_out"; echo "{" >> "$py_out"
: > "$ts_out"; echo "{" >> "$ts_out"
py_first=1
ts_first=1
ROW_RESULT_FILE="$(mktemp "${TMPDIR:-/tmp}/mutation-check-row.XXXXXX")"

while IFS=$'\t' read -r guard_id module_path test_node_id sed_expr; do
  [ -z "$guard_id" ] && continue
  case "$module_path" in
    *.ts)
      run_one_row "$guard_id" "$module_path" "$test_node_id" "$sed_expr" 1
      row_body="$(cat "$ROW_RESULT_FILE")"
      if [ "$ts_first" -eq 0 ]; then printf ',\n' >> "$ts_out"; fi
      ts_first=0
      printf '  "%s": {%s}' "$guard_id" "$row_body" >> "$ts_out"
      ;;
    *)
      run_one_row "$guard_id" "$module_path" "$test_node_id" "$sed_expr" 0
      row_body="$(cat "$ROW_RESULT_FILE")"
      if [ "$py_first" -eq 0 ]; then printf ',\n' >> "$py_out"; fi
      py_first=0
      printf '  "%s": {%s}' "$guard_id" "$row_body" >> "$py_out"
      ;;
  esac
done < "$ROWS_FILE"
rm -f "$ROWS_FILE" "$ROW_RESULT_FILE"

printf '\n}\n' >> "$py_out"
printf '\n}\n' >> "$ts_out"

exit "$FAILED"
