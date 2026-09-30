#!/usr/bin/env bash
# Reviewed 100x manifest of selected race-sensitive lifecycle files from
# docs/pipeline/plans/2026-09-28-upstream-catchup.md Task 5.
# Named set only — not exhaustive of all daemon/PTY tests:
#   map-entry race, eviction round4, Hermes force-fresh timing,
#   PTY disposal, connector tests.
# Bounded: REPEAT clamped to 1–100; counts-only stdout summary.
set -euo pipefail

n="${REPEAT:-100}"
if ! [[ "$n" =~ ^[1-9][0-9]*$ ]] || [ "$n" -gt 100 ]; then
  echo "REPEAT must be an integer 1-100" >&2
  exit 1
fi

files=(
  tests/unit/daemon/agent-manager-map-entry-race.test.ts
  tests/unit/daemon/agent-manager-eviction-race-round4.test.ts
  tests/unit/daemon/agent-process-hermes.test.ts
  tests/unit/pty/pty-host-dispose.test.ts
  tests/unit/connectors
)

passed=0
for i in $(seq 1 "$n"); do
  npx vitest run "${files[@]}" --reporter=dot
  passed=$((passed + 1))
done
printf '{"job":"lifecycle-connectors-100x","passed_repeats":%s,"repeat":%s}\n' "$passed" "$n"
