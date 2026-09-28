#!/usr/bin/env bash
# Repeat race-sensitive lifecycle + connector files. A single failure exits.
# Bounded: REPEAT clamped to 1–100; two globs only; counts-only stdout summary.
set -euo pipefail

n="${REPEAT:-100}"
if ! [[ "$n" =~ ^[1-9][0-9]*$ ]] || [ "$n" -gt 100 ]; then
  echo "REPEAT must be an integer 1-100" >&2
  exit 1
fi

files=(
  tests/unit/daemon/agent-manager-map-entry-race.test.ts
  tests/unit/connectors
)

passed=0
for i in $(seq 1 "$n"); do
  npx vitest run "${files[@]}" --reporter=dot
  passed=$((passed + 1))
done
printf '{"job":"lifecycle-connectors-100x","passed_repeats":%s,"repeat":%s}\n' "$passed" "$n"
