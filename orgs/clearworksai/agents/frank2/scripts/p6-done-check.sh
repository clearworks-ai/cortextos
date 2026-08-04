#!/usr/bin/env bash
# p6-done-check.sh — P6 done-condition evidence checker (master plan shard 2).
#
# P6 closes only after 4 CONSECUTIVE Friday weekly-review reports each:
#   1. exist at ~/code/knowledge-sync/raw/weekly-reviews/<YYYY-MM-DD>-weekly-review.md
#   2. carry the identical fixed heading set (## SYSTEM AUDIT / ## FIX TASKS / ## PIPELINE MOVEMENT)
#   3. have every fix-task ID in their ## FIX TASKS section traceable in `cortextos bus list-tasks`
#
# This is a manual/audit evidence tool, NOT a cron step. Exit 0 on overall PASS, 1 on FAIL.
# The "clean week has zero fix-task IDs" case is a PASS (flagged open question for Josh's HUMAN
# GATE — research §Open questions #1); the checker surfaces it rather than failing on it.
#
# Deps: bash, coreutils (date), grep, and the `cortextos` CLI on PATH.
set -u

KS_ROOT="${KNOWLEDGE_SYNC_ROOT:-$HOME/code/knowledge-sync}"
REVIEW_DIR="$KS_ROOT/raw/weekly-reviews"
CORTEXTOS_BIN="${CORTEXTOS_BIN:-cortextos}"

REQUIRED_HEADINGS=("## SYSTEM AUDIT" "## FIX TASKS" "## PIPELINE MOVEMENT")

# Compute the last 4 Friday dates (inclusive of today if today is Friday), newest first.
# date +%u : Mon=1 .. Sun=7 ; Friday=5.
compute_fridays() {
  local dow offset_to_friday i
  dow=$(date +%u)
  # days back from today to the most-recent Friday (0 if today IS Friday)
  offset_to_friday=$(( (dow - 5 + 7) % 7 ))
  for i in 0 1 2 3; do
    local back=$(( offset_to_friday + i * 7 ))
    # GNU vs BSD date differ; try BSD (-v) first, fall back to GNU (-d).
    if date -v-1d >/dev/null 2>&1; then
      date -v-"${back}"d +%Y-%m-%d
    else
      date -d "-${back} days" +%Y-%m-%d
    fi
  done
}

# Collect all task IDs currently known to the bus (best-effort; full untruncated IDs).
BUS_TASKS="$("$CORTEXTOS_BIN" bus list-tasks 2>/dev/null || true)"

overall_pass=1
pass_count=0

for date in $(compute_fridays); do
  file="$REVIEW_DIR/${date}-weekly-review.md"

  if [ ! -f "$file" ]; then
    echo "FAIL $date missing-file ($file)"
    overall_pass=0
    continue
  fi

  # Every required heading must be present (exact string).
  missing_heading=""
  for h in "${REQUIRED_HEADINGS[@]}"; do
    if ! grep -qF -- "$h" "$file"; then
      missing_heading="$h"
      break
    fi
  done
  if [ -n "$missing_heading" ]; then
    echo "FAIL $date missing-heading ('$missing_heading')"
    overall_pass=0
    continue
  fi

  # Extract full task_ IDs from the ## FIX TASKS section only.
  fix_section="$(awk '/^## FIX TASKS/{f=1;next} /^## /{f=0} f' "$file")"
  task_ids="$(printf '%s\n' "$fix_section" | grep -oE 'task_[0-9A-Za-z_]+' | sort -u)"

  if [ -z "$task_ids" ]; then
    echo "PASS $date (clean week — 0 fix tasks)"
    pass_count=$(( pass_count + 1 ))
    continue
  fi

  # Every found task ID must be traceable in the bus.
  untraceable=""
  while IFS= read -r tid; do
    [ -z "$tid" ] && continue
    if ! printf '%s' "$BUS_TASKS" | grep -qF -- "$tid"; then
      untraceable="$tid"
      break
    fi
  done <<< "$task_ids"

  if [ -n "$untraceable" ]; then
    echo "FAIL $date untraceable-task ($untraceable)"
    overall_pass=0
    continue
  fi

  echo "PASS $date ($(printf '%s\n' "$task_ids" | grep -c .) fix task(s), all traceable)"
  pass_count=$(( pass_count + 1 ))
done

if [ "$overall_pass" -eq 1 ] && [ "$pass_count" -eq 4 ]; then
  echo "P6 DONE-CONDITION: PASS"
  exit 0
else
  echo "P6 DONE-CONDITION: FAIL (${pass_count}/4)"
  exit 1
fi
