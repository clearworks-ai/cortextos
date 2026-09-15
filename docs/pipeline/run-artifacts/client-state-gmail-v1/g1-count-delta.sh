#!/bin/bash
# G1 COUNT DELTA gate for client-state-gmail-v1 (STANDING RULES "Test runner",
# wave-2 fix C11). Regex pinned against the REAL captured log:
# docs/pipeline/run-artifacts/client-state-gmail-v1/baseline-npm-test.log
#   capture <out.json>                               — run the full suite once, write counts.
#   check <baseline.json> <+files> <+tests> <+pytest> — re-capture, assert == baseline + deltas.
#   --selftest                                        — extract-vs-BASELINE.json equality (real
#                                                        log) + doctored-log fail-closed proof.
set -euo pipefail

# G0A2-5: REQUIRED, exactly as mutation-check.sh requires it. A hardcoded
# fallback made every runner `( cd "$root" && ... )` into the REAL worktree, so
# a G1 run from any other tree silently measured a tree that was not the one
# under test — a green G1 recorded that way proves nothing about the code it
# gates. There is no default.
repo_root() {
  printf '%s' "${CLIENT_STATE_REPO_ROOT:?g1-count-delta: CLIENT_STATE_REPO_ROOT is required (the tree to measure); refusing to guess}"
}

baseline_log_path() {
  printf '%s' "${CLIENT_STATE_BASELINE_LOG:-$(repo_root)/docs/pipeline/run-artifacts/client-state-gmail-v1/baseline-npm-test.log}"
}

baseline_json_path() {
  printf '%s' "${CLIENT_STATE_BASELINE_JSON:-$(repo_root)/docs/pipeline/run-artifacts/client-state-gmail-v1/BASELINE.json}"
}

# Failing vitest FILE paths from a real `vitest run` log. Vitest prints TWO
# distinct failing-file line shapes, both starting " FAIL  " (one leading
# space, two after FAIL — pinned against the real log, NOT "every .test.ts
# mention" which G0B-22 found wrongly counted PASSING files too):
#   " FAIL  <path> [ <path> ]"                     — whole-file error (e.g. import blew up)
#   " FAIL  <path> > <describe> > ... > <test name>" — one failing test inside an
#                                                       otherwise-collectible file (no
#                                                       file-level line exists for these —
#                                                       4 of the real log's 18 failing files
#                                                       ONLY appear this way, e.g.
#                                                       tests/unit/daemon/fast-checker.test.ts)
# A path may itself contain "[...]" route-param brackets (e.g.
# dashboard/.../[id]/__tests__/route.test.ts) — splitting on the FIRST literal
# " [ " (space-bracket-space) is safe because vitest never puts spaces around
# an in-path bracket, only around its own trailing duplicate-path marker.
extract_vitest_failing_files() {
  local log="$1"
  python3 - "$log" <<'PY'
import sys
log = sys.argv[1]
files = set()
with open(log, "r", errors="replace") as fh:
    for line in fh:
        if not line.startswith(" FAIL  "):
            continue
        rest = line[len(" FAIL  "):].rstrip("\n")
        if " > " in rest:
            path = rest.split(" > ", 1)[0].strip()
        elif " [ " in rest:
            path = rest.split(" [ ", 1)[0].strip()
        else:
            path = rest.strip()
        if path:
            files.add(path)
for f in sorted(files):
    print(f)
PY
}

extract_vitest_summary() {
  # Prints "files\ttests" (the totals in parens) on stdout, or returns 1
  # (nothing printed) when either summary line is absent — fail-closed.
  local log="$1"
  local files_line tests_line files tests
  files_line=$(grep -a -E '^ *Test Files +[0-9]+ (passed|failed)' "$log" | tail -1 || true)
  tests_line=$(grep -a -E '^ *Tests +[0-9]+ (passed|failed)' "$log" | tail -1 || true)
  if [ -z "$files_line" ] || [ -z "$tests_line" ]; then
    return 1
  fi
  files=$(printf '%s' "$files_line" | grep -oE '\(([0-9]+)\)' | tr -d '()' || true)
  tests=$(printf '%s' "$tests_line" | grep -oE '\(([0-9]+)\)' | tr -d '()' || true)
  if [ -z "$files" ] || [ -z "$tests" ]; then
    return 1
  fi
  printf '%s\t%s\n' "$files" "$tests"
}

extract_pytest() {
  local log="$1"
  local passed failed failing
  passed=$(grep -a -oE '[0-9]+ passed' "$log" | tail -1 | awk '{print $1}' || true)
  failed=$(grep -a -oE '[0-9]+ failed' "$log" | tail -1 | awk '{print $1}' || true)
  if [ -z "$passed" ] && [ -z "$failed" ]; then
    return 1
  fi
  passed=${passed:-0}
  failed=${failed:-0}
  failing=$(grep -a -oE '^FAILED [^ ]+' "$log" | awk '{print $2}' | sort -u | tr '\n' ' ' || true)
  printf '%s\t%s\t%s\n' "$passed" "$failed" "$failing"
}

capture_from_logs() {
  # $1=vlog $2=plog $3=nodelog $4=vitest_rc $5=node_rc $6=pytest_rc $7=out $8=base_sha
  local vlog="$1" plog="$2" nodelog="$3" vitest_rc="$4" node_rc="$5" pytest_rc="$6" out="$7" base_sha="${8:-}"
  local vsummary vf vt vfailing pparsed pp pf pfailing
  if ! vsummary=$(extract_vitest_summary "$vlog"); then
    echo "g1-count-delta: FATAL - could not extract vitest 'Test Files'/'Tests' summary from $vlog (fail-closed, non-vacuous)" >&2
    return 1
  fi
  IFS=$'\t' read -r vf vt <<< "$vsummary"
  vfailing=$(extract_vitest_failing_files "$vlog" | tr '\n' '\t' || true)
  if ! pparsed=$(extract_pytest "$plog"); then
    echo "g1-count-delta: FATAL - could not extract pytest passed/failed summary from $plog (fail-closed, non-vacuous)" >&2
    return 1
  fi
  IFS=$'\t' read -r pp pf pfailing <<< "$pparsed"
  python3 - "$out" "$vf" "$vt" "$vfailing" "$pp" "$pf" "$pfailing" "$vitest_rc" "$node_rc" "$pytest_rc" "$base_sha" <<'PY'
import json, sys
out, vf, vt, vfailing, pp, pf, pfailing, vitest_rc, node_rc, pytest_rc, base_sha = sys.argv[1:12]
doc = {
    "vitest_files": int(vf),
    "vitest_tests": int(vt),
    "vitest_failing": sorted(x for x in vfailing.split("\t") if x),
    "pytest_passed": int(pp),
    "pytest_failed": int(pf),
    "pytest_failing": sorted(x for x in pfailing.split() if x),
    "vitest_rc": int(vitest_rc),
    "node_rc": int(node_rc),
    "pytest_rc": int(pytest_rc),
    # G0B2-15: `check` needs a resolvable baseline SHA to compute the diff the
    # overlap rule is evaluated against; emitting it here is what makes the
    # rule enforceable instead of silently skipped.
    "base_sha": base_sha,
}
with open(out, "w") as fh:
    json.dump(doc, fh, indent=2, sort_keys=True)
    fh.write("\n")
print(json.dumps(doc, sort_keys=True))
PY
}

run_and_capture() {
  local out="$1"
  # --selftest exercises check_mode's fail-closed paths, which abort BEFORE any
  # comparison; running the real suites there would add minutes and prove
  # nothing. Never set outside the selftest.
  if [ -n "${CLIENT_STATE_G1_SKIP_RUN:-}" ]; then
    printf '%s' '{"vitest_files":0,"vitest_tests":0,"vitest_failing":[],"pytest_passed":0,"pytest_failed":0,"pytest_failing":[],"vitest_rc":0,"node_rc":0,"pytest_rc":0,"base_sha":""}' > "$out"
    return 0
  fi
  local scratch root vlog plog nodelog
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/g1-count-delta.XXXXXX")"
  root="$(repo_root)"
  vlog="$scratch/vitest.log"
  plog="$scratch/pytest.log"
  nodelog="$scratch/test-node.log"

  # Every runner rc is captured BARE (never `|| true`) — vitest and test:node
  # run as two SEPARATE commands (never `npm test`'s `vitest run && npm run
  # test:node`, which silently skips test:node whenever vitest itself exits
  # non-zero — exactly what the real baseline log shows: rc=1 from vitest,
  # zero trace of test:node's own output anywhere in the log).
  local vitest_rc node_rc pytest_rc
  set +e
  ( cd "$root" && npx vitest run ) > "$vlog" 2>&1
  vitest_rc=$?
  ( cd "$root" && npm run test:node ) > "$nodelog" 2>&1
  node_rc=$?
  ( cd "$root" && python3 -m pytest scripts/brain/tests -q -p no:cacheprovider ) > "$plog" 2>&1
  pytest_rc=$?
  set -e

  # G0B2-15: record WHICH commit these counts were measured at. Fails closed:
  # `git rev-parse HEAD` must succeed in the tree we were told to measure.
  local base_sha
  if ! base_sha=$( cd "$root" && git rev-parse HEAD 2>/dev/null ); then
    echo "g1-count-delta: FATAL - could not resolve HEAD in $root (fail-closed)" >&2
    return 1
  fi

  capture_from_logs "$vlog" "$plog" "$nodelog" "$vitest_rc" "$node_rc" "$pytest_rc" "$out" "$base_sha"
}

check_mode() {
  local baseline="$1" want_files="$2" want_tests="$3" want_pytest="$4"
  local scratch cur root base_sha
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/g1-count-delta.XXXXXX")"
  cur="$scratch/current.json"
  run_and_capture "$cur"
  root="$(repo_root)"
  base_sha=$(python3 -c "import json; print(json.load(open('$baseline')).get('base_sha',''))")
  # G0B2-15: the overlap rule is a GATE, so every way of not computing it is a
  # failure, never a silent skip. A missing base_sha, an unresolvable one, or a
  # failed `git diff` all abort.
  if [ -z "$base_sha" ]; then
    echo "g1-count-delta: FATAL - baseline $baseline carries no base_sha; the diff-overlap rule cannot be evaluated (fail-closed)" >&2
    return 1
  fi
  if ! ( cd "$root" && git rev-parse --verify --quiet "${base_sha}^{commit}" >/dev/null ); then
    echo "g1-count-delta: FATAL - base_sha $base_sha does not resolve to a commit in $root (fail-closed)" >&2
    return 1
  fi
  local diff_files
  if ! diff_files=$( cd "$root" && git diff --name-only "${base_sha}...HEAD" | tr '\n' '\t' ); then
    echo "g1-count-delta: FATAL - git diff --name-only ${base_sha}...HEAD failed in $root (fail-closed)" >&2
    return 1
  fi
  compare_counts "$baseline" "$cur" "$want_files" "$want_tests" "$want_pytest" "$diff_files"
}

compare_counts() {
  # $1=baseline.json $2=current.json $3=+files $4=+tests $5=+pytest $6=TAB-joined diff files
  python3 - "$1" "$2" "$3" "$4" "$5" "${6:-}" <<'PY'
import json, sys
base_path, cur_path, want_files, want_tests, want_pytest, diff_files = sys.argv[1:7]
base = json.load(open(base_path))
cur = json.load(open(cur_path))
want_files, want_tests, want_pytest = int(want_files), int(want_tests), int(want_pytest)
violations = []

# BASELINE.json's own schema nests vitest/pytest counts one level deep; a
# plain flat baseline (this script's own `capture` output) is also accepted.
base_vfiles = base.get("vitest", base).get("files_failed" if "vitest" in base else "vitest_files",
                                            base.get("vitest_files", None))
base_v = base.get("vitest", base)
base_vitest_files = base_v.get("files_total", base.get("vitest_files"))
base_vitest_tests = base_v.get("tests_total", base.get("vitest_tests"))
base_pytest_passed = base.get("pytest", base).get("passed", base.get("pytest_passed"))
base_vfail = set(base_v.get("failing_files", base.get("vitest_failing", [])))
base_pfail = set(base.get("pytest", base).get("failing", base.get("pytest_failing", [])))

exp_files = base_vitest_files + want_files
exp_tests = base_vitest_tests + want_tests
exp_pytest = base_pytest_passed + want_pytest
if cur["vitest_files"] != exp_files:
    violations.append(f"vitest_files {cur['vitest_files']} != baseline {base_vitest_files} + {want_files} = {exp_files}")
if cur["vitest_tests"] != exp_tests:
    violations.append(f"vitest_tests {cur['vitest_tests']} != baseline {base_vitest_tests} + {want_tests} = {exp_tests}")
if cur["pytest_passed"] != exp_pytest:
    violations.append(f"pytest_passed {cur['pytest_passed']} != baseline {base_pytest_passed} + {want_pytest} = {exp_pytest}")

cur_vfail = set(cur.get("vitest_failing", []))
new_vfail = cur_vfail - base_vfail
if new_vfail:
    violations.append(f"new vitest failing files not in baseline: {sorted(new_vfail)}")
cur_pfail = set(cur.get("pytest_failing", []))
new_pfail = cur_pfail - base_pfail
if new_pfail:
    violations.append(f"new pytest failing tests not in baseline: {sorted(new_pfail)}")

if cur.get("node_rc") != 0:
    violations.append(f"node_rc (test:node phase) != 0: {cur.get('node_rc')}")

# G0B2-15: reconcile each runner's EXIT CODE with what its log was parsed to
# say. A runner that died before printing a summary, or printed a clean summary
# while exiting non-zero, must not pass as "counts matched".
if bool(cur.get("vitest_failing")) != (cur.get("vitest_rc") != 0):
    violations.append(
        f"vitest_rc {cur.get('vitest_rc')} disagrees with parsed failing files "
        f"{sorted(cur.get('vitest_failing', []))}"
    )
if bool(cur.get("pytest_failing")) != (cur.get("pytest_rc") != 0):
    violations.append(
        f"pytest_rc {cur.get('pytest_rc')} disagrees with parsed failing tests "
        f"{sorted(cur.get('pytest_failing', []))}"
    )

diff_set = {f for f in diff_files.split("\t") if f}
touched_baseline_red = diff_set & base_vfail
if touched_baseline_red:
    violations.append(f"this diff touches BASELINE-failing files (out of scope): {sorted(touched_baseline_red)}")

if violations:
    for v in violations:
        print(f"MISMATCH: {v}")
    sys.exit(1)
print("g1-count-delta: OK - counts match baseline + expected deltas, failing sets subset of baseline, "
      "test:node green, zero overlap with BASELINE-failing files")
sys.exit(0)
PY
}

selftest() {
  local log json_path scratch
  log="$(baseline_log_path)"
  json_path="$(baseline_json_path)"
  if [ ! -f "$log" ] || [ ! -f "$json_path" ]; then
    echo "SELFTEST FAILED: missing real baseline log ($log) or BASELINE.json ($json_path)" >&2
    return 1
  fi

  # --- Primary proof: extraction on the REAL log matches BASELINE.json's
  # failing_files EXACTLY (this IS the selftest — not a synthetic fixture). ---
  local extracted expected
  extracted="$(extract_vitest_failing_files "$log" | sort)"
  expected="$(python3 -c "
import json
doc = json.load(open('$json_path'))
for f in sorted(doc['vitest']['failing_files']):
    print(f)
")"
  if [ "$extracted" != "$expected" ]; then
    echo "SELFTEST FAILED: extraction from the real log does not match BASELINE.json's failing_files" >&2
    diff <(printf '%s\n' "$extracted") <(printf '%s\n' "$expected") >&2 || true
    return 1
  fi
  local n
  n=$(printf '%s\n' "$extracted" | grep -c .)
  echo "g1-count-delta selftest: OK - extracted $n failing files from the real log, exact match with BASELINE.json"

  # --- Secondary proof: a doctored log missing "Test Files" is fail-closed
  # (G-OPS-1, non-vacuous). ---
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/g1-count-delta-selftest.XXXXXX")"
  cat > "$scratch/bad-vitest.log" <<'EOF'
 Tests  10 passed (10)
 Duration  1.23s
EOF
  cat > "$scratch/good-pytest.log" <<'EOF'
10 passed in 1.23s
EOF
  local rc=0
  capture_from_logs "$scratch/bad-vitest.log" "$scratch/good-pytest.log" "$scratch/no-node.log" 0 0 0 "$scratch/should-not-exist.json" || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "SELFTEST FAILED: capture_from_logs did not fail on a doctored log missing 'Test Files' - extraction is vacuous" >&2
    return 1
  fi
  if [ -f "$scratch/should-not-exist.json" ]; then
    echo "SELFTEST FAILED: output JSON written despite failed extraction" >&2
    return 1
  fi
  echo "g1-count-delta selftest: OK - doctored log correctly rejected (non-vacuous)"

  # --- Third proof: extract_vitest_failing_files does NOT count a passing
  # file (G0B-22's exact regression) - synthesize a log with one PASS line
  # for a file mentioned nowhere else and assert it is absent from the set. ---
  cat > "$scratch/mixed-vitest.log" <<'EOF'
 ✓ tests/unit/some-passing-file.test.ts (3 tests) 12ms
 FAIL  tests/unit/some-failing-file.test.ts [ tests/unit/some-failing-file.test.ts ]
 Test Files  1 failed | 1 passed (2)
 Tests  1 failed | 3 passed (4)
EOF
  local mixed
  mixed="$(extract_vitest_failing_files "$scratch/mixed-vitest.log")"
  if printf '%s\n' "$mixed" | grep -q "some-passing-file"; then
    echo "SELFTEST FAILED: a PASSING file was counted as failing (G0B-22 regression)" >&2
    return 1
  fi
  if ! printf '%s\n' "$mixed" | grep -q "some-failing-file"; then
    echo "SELFTEST FAILED: the actually-failing file was not extracted" >&2
    return 1
  fi
  echo "g1-count-delta selftest: OK - passing files are never counted as failing (G0B-22 fixed)"

  # --- Fourth proof (G0B2-15): `check` fails CLOSED when the baseline carries
  # no base_sha, and again when it carries one that does not resolve. Neither
  # may be silently skipped into an "empty diff". ---
  local root; root="$(repo_root)"
  printf '%s' '{"vitest_files":1,"vitest_tests":1,"pytest_passed":1}' > "$scratch/no-sha.json"
  local rc2=0
  CLIENT_STATE_G1_SKIP_RUN=1 check_mode "$scratch/no-sha.json" 0 0 0 >"$scratch/no-sha.out" 2>&1 || rc2=$?
  if [ "$rc2" -eq 0 ] || ! grep -q 'carries no base_sha' "$scratch/no-sha.out"; then
    echo "SELFTEST FAILED: check did not fail closed on a baseline with no base_sha" >&2
    cat "$scratch/no-sha.out" >&2
    return 1
  fi
  printf '%s' '{"vitest_files":1,"vitest_tests":1,"pytest_passed":1,"base_sha":"0000000000000000000000000000000000000000"}' > "$scratch/bad-sha.json"
  local rc3=0
  CLIENT_STATE_G1_SKIP_RUN=1 check_mode "$scratch/bad-sha.json" 0 0 0 >"$scratch/bad-sha.out" 2>&1 || rc3=$?
  if [ "$rc3" -eq 0 ] || ! grep -q 'does not resolve to a commit' "$scratch/bad-sha.out"; then
    echo "SELFTEST FAILED: check did not fail closed on an unresolvable base_sha" >&2
    cat "$scratch/bad-sha.out" >&2
    return 1
  fi
  echo "g1-count-delta selftest: OK - check fails closed on a missing and on an unresolvable base_sha (G0B2-15)"

  # --- Fifth proof (G0B2-15): a runner rc that DISAGREES with its parsed log
  # is a violation, not a pass. ---
  python3 - "$scratch/rc-mismatch.json" <<'PY'
import json, sys
json.dump({"vitest_files": 1, "vitest_tests": 1, "vitest_failing": [], "vitest_rc": 1,
           "pytest_passed": 1, "pytest_failed": 0, "pytest_failing": [], "pytest_rc": 0,
           "node_rc": 0, "base_sha": "HEAD"}, open(sys.argv[1], "w"))
PY
  printf '%s' '{"vitest_files":1,"vitest_tests":1,"pytest_passed":1}' > "$scratch/rc-baseline.json"
  local rc4=0
  compare_counts "$scratch/rc-baseline.json" "$scratch/rc-mismatch.json" 0 0 0 "" >"$scratch/rc.out" 2>&1 || rc4=$?
  if [ "$rc4" -eq 0 ] || ! grep -q 'disagrees with parsed failing files' "$scratch/rc.out"; then
    echo "SELFTEST FAILED: a vitest_rc disagreeing with its parsed log was accepted" >&2
    cat "$scratch/rc.out" >&2
    return 1
  fi
  echo "g1-count-delta selftest: OK - a runner rc disagreeing with its parsed log is a violation (G0B2-15)"

  return 0
}

main() {
  # G0A2-5: hard requirement, checked ONCE up front so no mode can proceed
  # against a guessed tree (`${VAR:?}` inside a command substitution only
  # empties that substitution; this aborts).
  if [ -z "${CLIENT_STATE_REPO_ROOT:-}" ]; then
    echo "g1-count-delta: FATAL - CLIENT_STATE_REPO_ROOT is required (the tree to measure); refusing to guess" >&2
    exit 2
  fi
  local mode="${1:-}"
  case "$mode" in
    capture)
      local out="${2:?usage: g1-count-delta.sh capture <out.json>}"
      run_and_capture "$out"
      ;;
    check)
      local baseline="${2:?}" wf="${3:?}" wt="${4:?}" wp="${5:?}"
      check_mode "$baseline" "$wf" "$wt" "$wp"
      ;;
    --selftest)
      selftest
      ;;
    *)
      echo "usage: g1-count-delta.sh capture <out.json> | check <baseline.json> <+files> <+tests> <+pytest> | --selftest" >&2
      exit 2
      ;;
  esac
}

main "$@"
