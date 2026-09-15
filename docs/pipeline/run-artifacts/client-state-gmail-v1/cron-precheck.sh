#!/bin/bash
# FR-002 rollout step: grep a crons.json for the range-with-step cron form
# ("a-b/N", e.g. "0-30/5") that tests/unit/daemon/cron-parser-live-fleet.test.ts
# pins as the daemon parser's one unsupported form.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RANGE_STEP_RE='[0-9]+-[0-9]+/[0-9]+'

check_file() {
  local file="$1"
  python3 - "$file" "$RANGE_STEP_RE" <<'PY'
import json, re, sys
path, pattern = sys.argv[1], sys.argv[2]
rx = re.compile(pattern)
doc = json.load(open(path))
crons = doc.get("crons", [])
hits = []
for i, c in enumerate(crons):
    schedule = c.get("schedule", "")
    fields = schedule.split()
    if len(fields) != 5:
        continue
    for field in fields:
        if rx.search(field):
            hits.append((i, c.get("name", "<unnamed>"), schedule))
            break
for idx, name, schedule in hits:
    print(f"{path}:{idx}: cron '{name}' uses range-with-step form: {schedule}")
sys.exit(1 if hits else 0)
PY
}

if [ "${1:-}" = "--selftest" ]; then
  GOOD="$SELF_DIR/fixtures/crons-2026-08-11.json"
  BAD="$SELF_DIR/fixtures/crons-bad.json"
  set +e
  check_file "$GOOD"
  good_rc=$?
  set -e
  if [ "$good_rc" -ne 0 ]; then
    echo "SELFTEST FAILED: clean fixture $GOOD reported a range-with-step hit" >&2
    exit 1
  fi
  set +e
  check_file "$BAD"
  bad_rc=$?
  set -e
  if [ "$bad_rc" -ne 1 ]; then
    echo "SELFTEST FAILED: bad fixture $BAD did not exit 1" >&2
    exit 1
  fi
  echo "cron-precheck selftest: OK (clean fixture -> 0, bad fixture -> 1)"
  exit 0
fi

if [ "$#" -eq 0 ]; then
  echo "usage: cron-precheck.sh <crons.json...> | --selftest" >&2
  exit 2
fi

overall=0
for f in "$@"; do
  if [ ! -f "$f" ]; then
    echo "cron-precheck: missing file $f" >&2
    overall=1
    continue
  fi
  set +e
  check_file "$f"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    overall=1
  fi
done
exit "$overall"
