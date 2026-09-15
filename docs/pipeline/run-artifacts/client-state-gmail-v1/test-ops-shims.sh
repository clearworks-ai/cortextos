#!/bin/bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ops-shims-test.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

FAILURES=0
fail() { echo "FAIL: $1" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "PASS: $1"; }

# --- 1. shims/cortextos traps non-pass-through verbs ---
LOG1="$SCRATCH/log1.txt"
set +e
CLIENT_STATE_SHIM_LOG="$LOG1" "$SELF_DIR/shims/cortextos" bus create-task "x" >"$SCRATCH/out1.txt" 2>"$SCRATCH/err1.txt"
rc=$?
set -e
if [ "$rc" -eq 1 ] && grep -q 'TRAP: cortextos bus create-task x' "$SCRATCH/err1.txt"; then
  pass "shims/cortextos traps 'bus create-task'"
else
  fail "shims/cortextos did not trap 'bus create-task' (rc=$rc)"
fi
if grep -q 'cortextos bus create-task x' "$LOG1"; then
  pass "shims/cortextos logged the trapped call"
else
  fail "shims/cortextos did not log the trapped call"
fi

# --- 2. shims/cortextos passes through meeting-brief-claim/release ---
FAKE_REAL="$SCRATCH/fake-cortextos"
cat > "$FAKE_REAL" <<'FAKE'
#!/bin/bash
echo "REAL: $*"
FAKE
chmod +x "$FAKE_REAL"

LOG2="$SCRATCH/log2.txt"
OUT2=$(CLIENT_STATE_SHIM_LOG="$LOG2" CLIENT_STATE_REAL_CORTEXTOS="$FAKE_REAL" "$SELF_DIR/shims/cortextos" bus meeting-brief-claim demo --claims-dir /tmp/x)
if [ "$OUT2" = "REAL: bus meeting-brief-claim demo --claims-dir /tmp/x" ]; then
  pass "shims/cortextos passes through 'bus meeting-brief-claim'"
else
  fail "shims/cortextos did not pass through claim correctly: '$OUT2'"
fi
if grep -q 'cortextos bus meeting-brief-claim demo --claims-dir /tmp/x' "$LOG2"; then
  pass "shims/cortextos logged the pass-through call"
else
  fail "shims/cortextos did not log the pass-through call"
fi

LOG2B="$SCRATCH/log2b.txt"
OUT2B=$(CLIENT_STATE_SHIM_LOG="$LOG2B" CLIENT_STATE_REAL_CORTEXTOS="$FAKE_REAL" "$SELF_DIR/shims/cortextos" bus meeting-brief-release demo --claims-dir /tmp/x)
if [ "$OUT2B" = "REAL: bus meeting-brief-release demo --claims-dir /tmp/x" ]; then
  pass "shims/cortextos passes through 'bus meeting-brief-release'"
else
  fail "shims/cortextos did not pass through release correctly: '$OUT2B'"
fi

# --- 2c. shims/cortextos passes through the READ verb `bus list-tasks` ---
# Binding goal STANDING RULES, amended 2026-09-14 after G0 round-2 finding
# G0B2-6: the orchestrator calls list_open_tasks BEFORE extraction for every
# fileable message, so trapping this read makes the prescribed live dry-run
# exit 3 and G4 items 3-6 unreachable.
LOG2C="$SCRATCH/log2c.txt"
OUT2C=$(CLIENT_STATE_SHIM_LOG="$LOG2C" CLIENT_STATE_REAL_CORTEXTOS="$FAKE_REAL" "$SELF_DIR/shims/cortextos" bus list-tasks --open --class human --format json --limit 200)
if [ "$OUT2C" = "REAL: bus list-tasks --open --class human --format json --limit 200" ]; then
  pass "shims/cortextos passes through 'bus list-tasks'"
else
  fail "shims/cortextos did not pass through list-tasks correctly: '$OUT2C'"
fi
if grep -q 'cortextos bus list-tasks --open --class human --format json --limit 200' "$LOG2C"; then
  pass "shims/cortextos logged the 'bus list-tasks' pass-through call"
else
  fail "shims/cortextos did not log the 'bus list-tasks' pass-through call"
fi

# --- 2d. every OTHER write verb named by the goal still traps ---
for verb in send-telegram add-cron comms-filter; do
  LOG2D="$SCRATCH/log2d-$verb.txt"
  set +e
  CLIENT_STATE_SHIM_LOG="$LOG2D" CLIENT_STATE_REAL_CORTEXTOS="$FAKE_REAL" \
    "$SELF_DIR/shims/cortextos" bus "$verb" x >"$SCRATCH/out2d.txt" 2>"$SCRATCH/err2d.txt"
  rc=$?
  set -e
  if [ "$rc" -eq 1 ] && grep -q "TRAP: cortextos bus $verb x" "$SCRATCH/err2d.txt"; then
    pass "shims/cortextos still traps 'bus $verb'"
  else
    fail "shims/cortextos did NOT trap 'bus $verb' (rc=$rc)"
  fi
done

# --- 3. shims/gws-trap and shims/claude-trap always trap ---
LOG3="$SCRATCH/log3.txt"
set +e
CLIENT_STATE_SHIM_LOG="$LOG3" "$SELF_DIR/shims/gws-trap" gmail +triage --query x >"$SCRATCH/out3.txt" 2>"$SCRATCH/err3.txt"
rc=$?
set -e
if [ "$rc" -eq 1 ] && grep -q 'TRAP:' "$SCRATCH/err3.txt"; then
  pass "shims/gws-trap always traps"
else
  fail "shims/gws-trap did not trap (rc=$rc)"
fi

LOG4="$SCRATCH/log4.txt"
set +e
CLIENT_STATE_SHIM_LOG="$LOG4" "$SELF_DIR/shims/claude-trap" -p "hi" >"$SCRATCH/out4.txt" 2>"$SCRATCH/err4.txt"
rc=$?
set -e
if [ "$rc" -eq 1 ] && grep -q 'TRAP:' "$SCRATCH/err4.txt"; then
  pass "shims/claude-trap always traps"
else
  fail "shims/claude-trap did not trap (rc=$rc)"
fi

# --- 4. g1-count-delta.sh --selftest proves non-vacuous extraction ---
# G0A2-5: the gate REQUIRES the tree to measure -- name it explicitly (default
# to the repo this script lives in, which is what the selftest reads its real
# baseline log from).
if CLIENT_STATE_REPO_ROOT="${CLIENT_STATE_REPO_ROOT:-$(cd "$SELF_DIR/../../../.." && pwd)}" \
   "$SELF_DIR/g1-count-delta.sh" --selftest; then
  pass "g1-count-delta.sh --selftest passed (extraction is non-vacuous)"
else
  fail "g1-count-delta.sh --selftest failed"
fi

# --- 5. g4-check.sh fails closed against an empty g4 dir ---
EMPTY_G4="$SCRATCH/g4-empty"
mkdir -p "$EMPTY_G4"
set +e
CLIENT_STATE_G4_DIR="$EMPTY_G4" "$SELF_DIR/g4-check.sh" deadbeef >"$SCRATCH/g4empty.txt" 2>&1
rc=$?
set -e
if [ "$rc" -ne 0 ] && grep -q 'FAIL' "$SCRATCH/g4empty.txt"; then
  pass "g4-check.sh fails closed with no evidence artifacts"
else
  fail "g4-check.sh did not fail closed on empty g4 dir (rc=$rc)"
fi

# --- 6. g4-check.sh --selftest: a fully-satisfying fixture built from the REAL
# producers passes all 8 items, every per-item negative fixture flips exactly
# that item, and every individually-required field/artifact removal is
# rejected. This delegates instead of maintaining a SECOND hand-written
# fixture here, which is how the old copy drifted out of sync with the
# checker's own (G0B2-5/G0B2-14).
set +e
CLIENT_STATE_REPO_ROOT="${CLIENT_STATE_REPO_ROOT:-$(cd "$SELF_DIR/../../../.." && pwd)}" \
  "$SELF_DIR/g4-check.sh" --selftest >"$SCRATCH/g4self.txt" 2>&1
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  pass "g4-check.sh --selftest passed (real-producer fixture + per-item and per-field negatives)"
else
  fail "g4-check.sh --selftest failed (rc=$rc): $(tail -5 "$SCRATCH/g4self.txt")"
fi
if grep -q 'fully-satisfying fixture passes all 8 items' "$SCRATCH/g4self.txt"; then
  pass "g4-check.sh --selftest proved all 8 items pass on real producer output"
else
  fail "g4-check.sh --selftest never reported the 8-item positive pass"
fi
neg_count=$(grep -c 'negative fixture for item' "$SCRATCH/g4self.txt" || true)
if [ "${neg_count:-0}" -eq 8 ]; then
  pass "g4-check.sh --selftest isolated all 8 per-item negative fixtures"
else
  fail "g4-check.sh --selftest isolated $neg_count per-item negatives, expected 8"
fi
if grep -q 'individually-required field/artifact removals are rejected' "$SCRATCH/g4self.txt"; then
  pass "g4-check.sh --selftest rejected every individually-required field removal"
else
  fail "g4-check.sh --selftest did not run the required-field removals"
fi

if [ "$FAILURES" -eq 0 ]; then
  echo "ALL OPS-SHIM TESTS PASSED"
  exit 0
else
  echo "$FAILURES OPS-SHIM TEST(S) FAILED"
  exit 1
fi
