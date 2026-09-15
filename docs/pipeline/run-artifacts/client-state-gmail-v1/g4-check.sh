#!/bin/bash
# G4 evidence checker (R1 DONE bar items 1-8; wave-2 fix C11/G0B-23). Reads
# $CLIENT_STATE_G4_DIR (default ./g4/ next to this script); asserts EVERY
# named field/companion artifact per item (not just presence), prints a
# per-item PASS/FAIL table (G-OPS-2), and ships its own `--selftest` proving
# each item's check actually bites via a per-item negative fixture (G-OPS-2b).
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# --selftest generates its positive fixtures by RUNNING the real producers, so
# it needs the repo they live in. Defaults to the checkout this script sits in.
REPO_ROOT="${CLIENT_STATE_REPO_ROOT:-$(cd "$SELF_DIR/../../../.." && pwd)}"
MODE="${1:-}"

HAVE_JQ=0
if command -v jq >/dev/null 2>&1; then
  HAVE_JQ=1
fi

RESULTS=()
record() { RESULTS+=("$1|$2|$3"); }

# bash 3.2 (macOS /bin//bash) mis-parses a here-document nested inside a
# $( ... ) command substitution, so every python check body is written out
# ONCE here, at top level, and invoked by path.
PYLIB="$(mktemp -d "${TMPDIR:-/tmp}/g4-check-py.XXXXXX")"
trap 'rm -rf "$PYLIB"' EXIT

cat > "$PYLIB/check1.py" <<'PY'
import json, sys
suite = json.load(open(sys.argv[1]))
rec = json.load(open(sys.argv[2]))
want_sha = sys.argv[3]
bad = []
if suite.get('sha') != want_sha:
    bad.append(f"sha {suite.get('sha')!r} != {want_sha!r}")
if suite.get('tree_clean') is not True:
    bad.append('tree_clean is not True')
# G0B2-14: every count is REQUIRED and must be an int in BOTH documents --
# a plain 'suite.get(k) != rec.get(k)' passes when both sides omit the key
# (None == None), certifying a suite record that carries no counts at all.
for key in ('vitest_files', 'vitest_tests', 'pytest_passed', 'pytest_failed'):
    sv, rv = suite.get(key), rec.get(key)
    if not isinstance(sv, int) or isinstance(sv, bool):
        bad.append(f'suite.json {key} is not an int: {sv!r}')
    elif not isinstance(rv, int) or isinstance(rv, bool):
        bad.append(f'g1-record.json {key} is not an int: {rv!r}')
    elif sv != rv:
        bad.append(f'{key}: suite={sv!r} != g1-record={rv!r}')
if not isinstance(suite.get('sha'), str) or len(suite.get('sha') or '') < 7:
    bad.append(f"suite.json sha is not a commit sha: {suite.get('sha')!r}")
# G0B3-5: the G1 record must name the tree it MEASURED, and that tree must be
# the one this gate was invoked for. Validating suite.sha alone let a G1 record
# captured against any other tree certify this release.
rec_sha = rec.get('base_sha') or rec.get('sha')
if not isinstance(rec_sha, str) or len(rec_sha or '') < 7:
    bad.append(f'g1-record.json carries no measured-tree sha (base_sha/sha): {rec_sha!r}')
elif rec_sha != want_sha:
    bad.append(f'g1-record.json measured {rec_sha!r}, but this gate was invoked for {want_sha!r}')
elif suite.get('sha') != rec_sha:
    bad.append(f"suite.json sha {suite.get('sha')!r} != g1-record measured sha {rec_sha!r}")
print('OK' if not bad else 'FAIL: ' + '; '.join(bad))
PY

cat > "$PYLIB/check2.py" <<'PY'
import json, re, sys
text = open(sys.argv[1], encoding='utf-8').read()
ledger_path, receipt_path = sys.argv[2], sys.argv[3]
bad = []

# --- per-MESSAGE evidence, bound to the producer's real block format
# (client_state_projections.plan_message_preview). G0B2-5/G0B2-14: this is
# checked per message block, not as a set of global token greps.
blocks = re.split(r'^=== (?=source_ref=)', text, flags=re.M)[1:]
if not blocks:
    bad.append('no per-message block: expected a line starting \'=== source_ref=gmail:<id> thread_id=<tid> ===\'')
outcomes_seen = set()
for block in blocks:
    head = block.splitlines()[0]
    m = re.match(r'source_ref=(\S+) thread_id=(\S+) ===', head)
    if not m:
        bad.append(f'malformed message header: {head!r}')
        continue
    ref = m.group(1)
    om = re.search(r'^outcome: (filed|ignored|escalated)$', block, flags=re.M)
    if not om:
        bad.append(f'{ref}: block does not declare `outcome: filed|ignored|escalated`')
        continue
    outcome = om.group(1)
    outcomes_seen.add(outcome)
    # Required of EVERY block, whatever its outcome.
    common = {
        'sender': r'^From: .+ <[^>]+@[^>]+>$',
        'subject': r'^Subject: .+$',
        'resolution': r"^  resolution: slug=.* kind=.* method=.* outcome=.* reason=.* contact_id=.* email=.*$",
        # G0B3-4: every section is STATED, present or absent. An ignored message
        # legitimately has no CRM row -- but the block must say `CRM: none`, so
        # "nothing to write" and "the preview forgot it" cannot look the same.
        'extraction line': r'^  extraction: (n/a|cached=(True|False) cost_usd=\S+ model_receipt=\S+)$',
        'summary line': r'^  summary: .+$',
        'grounding quote or none': r'\[quote: .*\]',
        'CRM section': r'^  CRM( row: contact=|: )',
        'page section': r'^  page( diff for | : | : none)|^  page: none',
        'task section': r'^  task: ',
        'escalation section': r'^  escalation: ',
        'digest preview': r'^  digest preview: ',
    }
    for label, pattern in common.items():
        if not re.search(pattern, block, flags=re.M):
            bad.append(f'{ref}: missing {label}')
    if outcome == 'filed':
        # Only a FILED message must show a real extraction receipt and a real
        # effect preview.
        if not re.search(r'^  extraction: cached=(True|False) cost_usd=\S+ model_receipt=\S+$', block, flags=re.M):
            bad.append(f'{ref}: filed block has no extraction receipt')
        if not re.search(r'^  CRM row: contact=.*argv=\[', block, flags=re.M) and \
           not re.search(r'^  CRM: would create contact argv=\[', block, flags=re.M):
            bad.append(f'{ref}: filed block previews no CRM argv')
        if not re.search(r'^  page diff for ', block, flags=re.M):
            bad.append(f'{ref}: filed block previews no page diff')
    if outcome == 'escalated' and not re.search(r'^  escalation: (?!none$).+$', block, flags=re.M):
        bad.append(f'{ref}: escalated block carries no escalation text')
    if outcome == 'ignored' and not re.search(r'^  extraction: n/a$', block, flags=re.M):
        bad.append(f'{ref}: ignored block must not claim an extraction')
# G0B3-4: the evidence must EXERCISE the shapes a real inbox produces.
for want in ('filed', 'ignored', 'escalated'):
    if want not in outcomes_seen:
        bad.append(f'no {want} message in the dry-run evidence (outcomes seen: {sorted(outcomes_seen)})')

rows = [json.loads(l) for l in open(ledger_path) if l.strip()]
if not rows:
    bad.append('ledger has zero rows')
filed_rows = []
for i, r in enumerate(rows):
    for key, typ in (('source_ref', str), ('thread_id', str), ('content_digest', str), ('observed_at', str)):
        if not isinstance(r.get(key), typ) or not r.get(key):
            bad.append(f'ledger row {i}: {key} is not a non-empty {typ.__name__}')
    res = r.get('resolutions')
    if not isinstance(res, list) or not res:
        bad.append(f'ledger row {i}: resolutions is not a non-empty list')
        continue
    for j, one in enumerate(res):
        if not isinstance(one, dict):
            bad.append(f'ledger row {i}.resolutions[{j}] is not an object'); continue
        for key in ('slug', 'kind', 'method', 'outcome'):
            if key not in one:
                bad.append(f'ledger row {i}.resolutions[{j}] missing {key}')
        if one.get('outcome') not in ('filed', 'escalated', 'ignored'):
            bad.append(f"ledger row {i}.resolutions[{j}] outcome {one.get('outcome')!r} is not filed/escalated/ignored")
    if all(o.get('outcome') == 'filed' for o in res):
        filed_rows.append(r)
if not filed_rows:
    bad.append('no ledger row has every resolution filed (G4 item 3 needs at least ONE filed known entity)')
for r in filed_rows:
    ex = r.get('extraction')
    if not isinstance(ex, dict):
        bad.append(f"{r.get('source_ref')}: filed row carries no extraction object"); continue
    if not isinstance(ex.get('model_receipt'), str) or not ex.get('model_receipt'):
        bad.append(f"{r.get('source_ref')}: extraction.model_receipt missing")
    if not isinstance(ex.get('summary'), str) or not ex.get('summary'):
        bad.append(f"{r.get('source_ref')}: extraction.summary missing")
    if not isinstance(ex.get('cost_usd'), (int, float)):
        bad.append(f"{r.get('source_ref')}: extraction.cost_usd is not a number")
    effective = r.get('planned_writes') if r.get('simulated') else r.get('writes')
    if not effective:
        bad.append(f"{r.get('source_ref')}: filed row records no (planned_)writes")

receipt = json.load(open(receipt_path))
for key, typ in (('last_success_at', str), ('window_days', int), ('message_count', int)):
    v = receipt.get(key)
    if not isinstance(v, typ) or isinstance(v, bool):
        bad.append(f'run-receipt.json {key} is not a {typ.__name__}: {v!r}')
print('OK' if not bad else 'FAIL: ' + '; '.join(bad))
PY

cat > "$PYLIB/check3.py" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
bad = []
if doc.get('vault_porcelain', None) != '':
    bad.append('vault_porcelain not empty: ' + repr(doc.get('vault_porcelain')))
# G2r2-12: porcelain alone is NOT proof the vault was untouched. `*.md.lock` is
# gitignored, so the dry run's advisory-lock file (created and truncated INSIDE
# the vault) never showed up in `git status --porcelain`. The no-prod-writes
# evidence must therefore also carry a RECURSIVE FILE-LISTING diff of the vault
# copy, taken before and after the run, and it must be empty. A missing key is a
# FAILURE, not a pass: evidence that was never gathered proves nothing.
if 'vault_tree_diff' not in doc:
    bad.append('vault_tree_diff missing - a recursive vault file-listing diff is required '
               'because porcelain cannot see gitignored artifacts such as *.md.lock')
elif doc.get('vault_tree_diff') != '':
    bad.append('vault_tree_diff not empty: ' + repr(doc.get('vault_tree_diff')))
for key in ('contacts_json', 'interactions_jsonl'):
    row = doc.get('crm', {}).get(key, {})
    if not row.get('sha_before') or row.get('sha_before') != row.get('sha_after'):
        bad.append(f'crm.{key} sha mismatch or empty: {row}')
forbidden = doc.get('shim_forbidden_verbs', None)
if forbidden != []:
    bad.append('shim_forbidden_verbs not empty: ' + repr(forbidden))
allowed = {'+triage', '+read'}
verbs = doc.get('gws_argv_verbs', [])
bad_verbs = [v for v in verbs if v not in allowed]
if bad_verbs:
    bad.append('gws_argv_verbs has forbidden verbs: ' + repr(bad_verbs))
if not verbs:
    bad.append('gws_argv_verbs is empty - no evidence of live gws calls')
print('OK' if not bad else 'FAIL: ' + '; '.join(bad))
PY

cat > "$PYLIB/check4.py" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
bad = []

def need(key, want, label=None):
    if key not in doc:
        bad.append(f'{key} missing'); return
    if doc[key] != want:
        bad.append(f'{key} is {doc[key]!r}, expected {want!r}' + (f' ({label})' if label else ''))

# --- the immediately repeated identical run is fully inert ------------------
need('second_run_rows_added', 0)
need('second_run_claude_calls', 0)
need('second_run_previews_count', 0, 'zero write previews required')
need('second_run_cost_delta_usd', 0.0)
need('second_run_exit_code', 0)
# NOTE (G0B2-7): there is deliberately NO `second_run_receipt_unchanged`
# requirement. A repeated SUCCESSFUL run legitimately rewrites the success
# receipt (last_success_at, cost_usd); demanding otherwise asserts something
# the system does not and should not do. What the goal requires unchanged is
# the receipt across the LOCK-HELD third run, below.

# --- the third run: lock held by a live PID --------------------------------
need('third_run_lock_held_processed', False)
need('third_run_exit_code', 2)
need('third_run_receipt_byte_identical', True,
     'amended G4 item 5: a fail-closed halt must not falsify the success receipt')
refusal = doc.get('third_run_lock_refusal')
if not isinstance(refusal, dict):
    bad.append('third_run_lock_refusal is not an object (last-lock-refusal.json contents)')
else:
    if refusal.get('error') != 'lock-held':
        bad.append(f"third_run_lock_refusal.error is {refusal.get('error')!r}, expected 'lock-held'")
    if not isinstance(refusal.get('refused_at'), str) or not refusal.get('refused_at'):
        bad.append('third_run_lock_refusal.refused_at missing')

# --- stale lock: meeting-brief semantics (stale NEVER wins in band) --------
# G2r3-1 (corrects G0A-20): claimEventLease on a stale lock unlinks it and
# returns stale-cleared WITHOUT claiming in that same call
# (src/bus/meeting-brief.ts:398-418), precisely so the discovering call never
# wins. The earlier retry-once behaviour re-introduced that race: two pollers
# overlapping on one stale lock could both clear and both win. So the evidence
# is now two DISTINCT invocations - this one refuses, the next one wins.
need('stale_discovering_run_refuses', True,
     'the acquire() that discovers staleness must refuse (exit 2, ONE claim call), never reclaim in band')
if doc.get('stale_refusal_reason') != 'stale-cleared':
    bad.append('stale_refusal_reason is ' + repr(doc.get('stale_refusal_reason')) + ", expected 'stale-cleared'")
need('stale_then_next_acquire_wins', True)
print('OK' if not bad else 'FAIL: ' + '; '.join(bad))
PY

cat > "$PYLIB/check5.py" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
bad = []
for gid in ('G-BUS-1', 'G-BUS-2'):
    row = doc.get(gid)
    if not row:
        bad.append(f'{gid} missing'); continue
    if row.get('control_green') is not True:
        bad.append(f'{gid}.control_green is not True')
    if row.get('mutated_red') is not True:
        bad.append(f'{gid}.mutated_red is not True')
    if row.get('diff_applied') is not True:
        bad.append(f'{gid}.diff_applied is not True')
print('OK' if not bad else 'FAIL: ' + '; '.join(bad))
PY

py_get() {
  local file="$1" expr="$2"
  python3 -c "
import json, sys
doc = json.load(open(sys.argv[1]))
print($expr)
" "$file"
}

check_1_suite() {
  local dir="$1" sha="$2"
  local f="$dir/suite.json" rec="$dir/g1-record.json"
  if [ ! -f "$f" ]; then record "1-suite.json" 1 "missing $f"; return; fi
  if [ ! -f "$rec" ]; then record "1-suite.json" 1 "missing companion $rec"; return; fi
  local out
  out=$(python3 "$PYLIB/check1.py" "$f" "$rec" "$sha")
  if [ "$out" = "OK" ]; then
    record "1-suite.json" 0 "sha matches, tree clean, counts == G1 record"
  else
    record "1-suite.json" 1 "$out"
  fi
}

check_2_shim_tests() {
  local dir="$1"
  local f="$dir/shim-tests.log"
  if [ ! -f "$f" ]; then record "2-shim-tests.log" 1 "missing $f"; return; fi
  if ! grep -q '=== POSITIVE-CONTROL ===' "$f"; then
    record "2-shim-tests.log" 1 "missing '=== POSITIVE-CONTROL ===' marker"
    return
  fi
  local before after before_traps after_traps
  before=$(awk '/=== POSITIVE-CONTROL ===/{exit} {print}' "$f")
  after=$(awk 'f{print} /=== POSITIVE-CONTROL ===/{f=1}' "$f")
  before_traps=$(printf '%s\n' "$before" | grep -c 'TRAP:' || true)
  after_traps=$(printf '%s\n' "$after" | grep -c 'TRAP:' || true)
  if [ "${before_traps:-0}" -eq 0 ] && [ "${after_traps:-0}" -ge 1 ]; then
    record "2-shim-tests.log" 0 "0 trap lines before marker, $after_traps positive-control trap line(s)"
  else
    record "2-shim-tests.log" 1 "before_traps=$before_traps after_traps=$after_traps"
  fi
}

check_3_dry_run() {
  local dir="$1"
  local matches=()
  shopt -s nullglob
  matches=("$dir"/dry-run-*.txt)
  shopt -u nullglob
  if [ ${#matches[@]} -eq 0 ]; then
    record "3-dry-run" 1 "no dry-run-*.txt files under $dir"
    return
  fi
  local f="${matches[0]}"
  local base="${f%.txt}"
  local ledger="${base}.ledger.jsonl"
  local receipt="$dir/run-receipt.json"

  local filed_n
  filed_n=$(grep -oE 'filed=[0-9]+' "$f" | head -1 | grep -oE '[0-9]+' || true)
  if [ -z "$filed_n" ] || [ "$filed_n" -lt 1 ]; then
    record "3-dry-run" 1 "$f missing filed=N with N>=1 (got '${filed_n:-<none>}')"
    return
  fi
  if [ ! -f "$ledger" ]; then
    record "3-dry-run" 1 "missing companion ledger $ledger"
    return
  fi
  if [ ! -f "$receipt" ]; then
    record "3-dry-run" 1 "missing companion $receipt"
    return
  fi
  local out
  out=$(python3 "$PYLIB/check2.py" "$f" "$ledger" "$receipt")
  if [ "$out" = "OK" ]; then
    record "3-dry-run" 0 "$f has filed=$filed_n and every per-message field; ledger rows typed with a filed+receipted row; receipt complete"
  else
    record "3-dry-run" 1 "$out"
  fi
}

check_4_no_prod_writes() {
  local dir="$1"
  local f="$dir/no-prod-writes.json"
  if [ ! -f "$f" ]; then record "4-no-prod-writes.json" 1 "missing $f"; return; fi
  local out
  out=$(python3 "$PYLIB/check3.py" "$f")
  if [ "$out" = "OK" ]; then
    record "4-no-prod-writes.json" 0 "porcelain + recursive tree diff empty, sha pairs match, no forbidden verbs"
  else
    record "4-no-prod-writes.json" 1 "$out"
  fi
}

check_5_idempotency() {
  local dir="$1"
  local f="$dir/idempotency.json"
  if [ ! -f "$f" ]; then record "5-idempotency.json" 1 "missing $f"; return; fi
  local out
  out=$(python3 "$PYLIB/check4.py" "$f")
  if [ "$out" = "OK" ]; then
    record "5-idempotency.json" 0 "repeat run fully inert (0 rows/calls/previews/cost delta), lock-held exits 2 with a byte-identical receipt + last-lock-refusal.json, stale-cleared then next-acquire wins"
  else
    record "5-idempotency.json" 1 "$out"
  fi
}

check_6_digest() {
  local dir="$1"
  local f="$dir/digest-dry-run.txt"
  if [ ! -f "$f" ]; then record "6-digest-dry-run.txt" 1 "missing $f"; return; fi
  if ! grep -q 'Client state (Gmail)' "$f"; then
    record "6-digest-dry-run.txt" 1 "missing 'Client state (Gmail)' section header"
    return
  fi
  if ! grep -Eiq 'fireflies.*(error|missing|unset|fail)' "$f"; then
    record "6-digest-dry-run.txt" 1 "missing a Fireflies error line"
    return
  fi
  # G0B2-14: the goal requires the invariants section to read a FRESHLY
  # WRITTEN baseline and report zero NEW violations, and the changes list to
  # be present. "baseline missing" is the error line, not evidence.
  if grep -q 'invariants: baseline missing' "$f"; then
    record "6-digest-dry-run.txt" 1 "invariants section reports a MISSING baseline (run write-baseline first)"
    return
  fi
  if ! grep -q '^- invariants: OK' "$f"; then
    record "6-digest-dry-run.txt" 1 "invariants section does not report zero NEW violations ('- invariants: OK')"
    return
  fi
  if ! grep -Eq '^- (CRM|Page|Task created|Escalated|Revision|ignored|truncated)' "$f"; then
    record "6-digest-dry-run.txt" 1 "no changes list in the Gmail section (the dry-run ledger produced nothing)"
    return
  fi
  record "6-digest-dry-run.txt" 0 "Gmail section with a changes list and a baseline-backed 'invariants: OK', plus an independent Fireflies error line"
}

check_7_bus_guards() {
  local dir="$1"
  local f="$dir/bus-guards.json"
  if [ ! -f "$f" ]; then record "7-bus-guards.json" 1 "missing $f"; return; fi
  local out
  out=$(python3 "$PYLIB/check5.py" "$f")
  if [ "$out" = "OK" ]; then
    record "7-bus-guards.json" 0 "G-BUS-1 and G-BUS-2 control_green+mutated_red+diff_applied all true"
  else
    record "7-bus-guards.json" 1 "$out"
  fi
}

# G0B3-5: the goal's verification floor names EXACT artifacts. "Layer 1 / Layer 3
# plus any three operational filenames" could be satisfied by a floor.txt that
# never cites the Opus G0a artifact, the codex review/challenge stdout, the FINAL
# Fable artifact, their verify-review-artifact exit-0 records, or the
# gate_invocation records — i.e. a GREEN matrix with no second opinion behind it.
FLOOR_REQUIRED=(
  "g4/G0-review-opus.json|Layer 3 — Opus G0a artifact"
  "g4/G0-review-opus.verify.json|Layer 1 — verify-review-artifact exit-0 record for G0"
  "g4/G2-codex-review.stdout.log|Layer 3 — codex G2 review stdout"
  "g4/G2-codex-challenge.stdout.log|Layer 3 — codex G2 challenge stdout"
  "g4/FINAL-review-fable.json|Layer 3 — FINAL Fable artifact"
  "g4/FINAL-review-fable.verify.json|Layer 1 — verify-review-artifact exit-0 record for FINAL"
  "g4/gate-invocations.json|Layer 1 — gate_invocation records"
)

check_8_floor() {
  local dir="$1"
  local f="$dir/floor.txt"
  if [ ! -s "$f" ]; then
    record "8-floor.txt" 1 "$f missing or empty"
    return
  fi
  local missing_layers=()
  for layer in "Layer 1" "Layer 3"; do
    if ! grep -q "$layer" "$f"; then missing_layers+=("$layer"); fi
  done
  if [ ${#missing_layers[@]} -gt 0 ]; then
    record "8-floor.txt" 1 "$f does not name the required floor layer(s): ${missing_layers[*]}"
    return
  fi
  # Each REQUIRED artifact must be cited by floor.txt AND exist AND be non-empty.
  local uncited=() absent=() empty=()
  local entry rel label base
  for entry in "${FLOOR_REQUIRED[@]}"; do
    rel="${entry%%|*}"
    label="${entry#*|}"
    base="$(basename "$rel")"
    if ! grep -q "$base" "$f"; then uncited+=("$base ($label)"); continue; fi
    if [ ! -e "$dir/$rel" ]; then absent+=("$rel ($label)"); continue; fi
    if [ ! -s "$dir/$rel" ]; then empty+=("$rel ($label)"); fi
  done
  if [ ${#uncited[@]} -gt 0 ]; then
    record "8-floor.txt" 1 "floor.txt does not cite required evidence: ${uncited[*]}"
    return
  fi
  if [ ${#absent[@]} -gt 0 ]; then
    record "8-floor.txt" 1 "required evidence artifact(s) missing: ${absent[*]}"
    return
  fi
  if [ ${#empty[@]} -gt 0 ]; then
    record "8-floor.txt" 1 "required evidence artifact(s) empty: ${empty[*]}"
    return
  fi
  # …plus the operational artifacts the other items produce.
  local broken=()
  local name
  for name in suite.json shim-tests.log no-prod-writes.json idempotency.json digest-dry-run.txt bus-guards.json; do
    if grep -q "$name" "$f" && [ ! -e "$dir/$name" ]; then broken+=("$name"); fi
  done
  if [ ${#broken[@]} -gt 0 ]; then
    record "8-floor.txt" 1 "$f cites evidence path(s) that do not exist: ${broken[*]}"
    return
  fi
  record "8-floor.txt" 0 "Layer 1 + Layer 3 named; all ${#FLOOR_REQUIRED[@]} required evidence artifacts cited, present and non-empty"
}

run_all_checks() {
  local dir="$1" sha="$2"
  RESULTS=()
  check_1_suite "$dir" "$sha"
  check_2_shim_tests "$dir"
  check_3_dry_run "$dir"
  check_4_no_prod_writes "$dir"
  check_5_idempotency "$dir"
  check_6_digest "$dir"
  check_7_bus_guards "$dir"
  check_8_floor "$dir"
}

print_table_and_exit_code() {
  local overall=0
  printf '%-24s %-6s %s\n' "ITEM" "RESULT" "DETAIL"
  for row in "${RESULTS[@]}"; do
    IFS='|' read -r name rc detail <<< "$row"
    if [ "$rc" -eq 0 ]; then
      printf '%-24s %-6s %s\n' "$name" "PASS" "$detail"
    else
      printf '%-24s %-6s %s\n' "$name" "FAIL" "$detail"
      overall=1
    fi
  done
  return "$overall"
}

# ---------------------------------------------------------------------------
# --selftest: build one fully-satisfying fixture set, confirm all 8 PASS,
# then for EACH item independently break ONLY that item's fixture (negative
# fixture) and confirm ONLY that item's row flips to FAIL while the other 7
# stay PASS (G-OPS-2b: proves each check actually bites, not just "present").
# ---------------------------------------------------------------------------
selftest() {
  local scratch
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/g4-check-selftest.XXXXXX")"
  local sha="cafef00dcafef00dcafef00dcafef00dcafef00"

  build_good_fixture() {
    local dir="$1"
    mkdir -p "$dir"
    # G0B2-5/G0B2-14: items 3, 5 and 6 are generated by the REAL producers
    # (client_state_gmail.run --dry-run, its repeat/lock-held/stale runs, and
    # client_state_digest.gmail_section) -- a hand-written lookalike lets the
    # checker certify a format nothing actually emits, which is exactly how
    # `source_ref=` survived as a token the producer never printed.
    if ! python3 "$SELF_DIR/g4-gen-fixture.py" "$REPO_ROOT" "$dir" >/dev/null; then
      echo "SELFTEST FAILED: could not generate the real-producer fixture (g4-gen-fixture.py)" >&2
      return 1
    fi
    cat > "$dir/suite.json" <<EOF
{"sha": "$sha", "vitest_files": 40, "vitest_tests": 300, "pytest_passed": 120, "pytest_failed": 0, "tree_clean": true}
EOF
    cat > "$dir/g1-record.json" <<EOF
{"base_sha": "$sha", "vitest_files": 40, "vitest_tests": 300, "pytest_passed": 120, "pytest_failed": 0}
EOF
    # G0B3-5: the exact Layer-1 / Layer-3 artifacts the goal names.
    mkdir -p "$dir/g4"
    printf '{"reviewer":"opus","gate":"G0a","findings":[]}\n'   > "$dir/g4/G0-review-opus.json"
    printf '{"verified":true,"exit_code":0}\n'                  > "$dir/g4/G0-review-opus.verify.json"
    printf 'codex G2 review stdout\n'                           > "$dir/g4/G2-codex-review.stdout.log"
    printf 'codex G2 challenge stdout\n'                        > "$dir/g4/G2-codex-challenge.stdout.log"
    printf '{"reviewer":"fable","gate":"FINAL","findings":[]}\n' > "$dir/g4/FINAL-review-fable.json"
    printf '{"verified":true,"exit_code":0}\n'                  > "$dir/g4/FINAL-review-fable.verify.json"
    printf '{"G0-review":0,"G1-suite":0,"G4-matrix":0,"FINAL-review":0}\n' > "$dir/g4/gate-invocations.json"
    {
      echo "$(date -u +%FT%TZ) 1 1 cortextos bus list-tasks --open --class human --format json --limit 200"
      echo "=== POSITIVE-CONTROL ==="
      echo "$(date -u +%FT%TZ) 2 2 cortextos bus create-task x"
      echo "TRAP: cortextos bus create-task x"
    } > "$dir/shim-tests.log"
    cat > "$dir/no-prod-writes.json" <<'EOF'
{
  "vault_porcelain": "",
  "vault_tree_diff": "",
  "crm": {
    "contacts_json": {"sha_before": "aaa", "sha_after": "aaa"},
    "interactions_jsonl": {"sha_before": "bbb", "sha_after": "bbb"}
  },
  "shim_forbidden_verbs": [],
  "gws_argv_verbs": ["+triage", "+read", "+triage"]
}
EOF
    cat > "$dir/bus-guards.json" <<'EOF'
{
  "G-BUS-1": {"control_green": true, "mutation_applied": true, "mutated_red": true, "diff_applied": true},
  "G-BUS-2": {"control_green": true, "mutation_applied": true, "mutated_red": true, "diff_applied": true}
}
EOF
    cat > "$dir/floor.txt" <<'EOF'
Layer 1 (deterministic): g1-count-delta.sh + g4-check.sh -> suite.json, idempotency.json;
  verify-review-artifact exit-0 records g4/G0-review-opus.verify.json and
  g4/FINAL-review-fable.verify.json; gate_invocation records g4/gate-invocations.json
Layer 2 (honest substitute): live read-only dry-run on copies -> digest-dry-run.txt, no-prod-writes.json
Layer 3 (second opinion, fresh contexts): g4/G0-review-opus.json,
  g4/G2-codex-review.stdout.log, g4/G2-codex-challenge.stdout.log,
  g4/FINAL-review-fable.json -> shim-tests.log, bus-guards.json
EOF
  }

  local good_dir="$scratch/good"
  build_good_fixture "$good_dir"
  run_all_checks "$good_dir" "$sha"
  if ! print_table_and_exit_code > "$scratch/good-out.txt" 2>&1; then
    echo "SELFTEST FAILED: the fully-satisfying fixture did not pass all 8 items:" >&2
    cat "$scratch/good-out.txt" >&2
    return 1
  fi
  echo "g4-check selftest: OK - fully-satisfying fixture passes all 8 items"

  declare -a ITEM_NAMES=(1-suite.json 2-shim-tests.log 3-dry-run 4-no-prod-writes.json 5-idempotency.json 6-digest-dry-run.txt 7-bus-guards.json 8-floor.txt)
  local failures=0

  break_item() {
    local n="$1" dir="$2"
    case "$n" in
      1) python3 -c "import json; d=json.load(open('$dir/suite.json')); d['tree_clean']=False; json.dump(d, open('$dir/suite.json','w'))" ;;
      2) sed -i '' 's/=== POSITIVE-CONTROL ===//' "$dir/shim-tests.log" ;;
      3) sed -i '' 's/filed=[0-9][0-9]*/filed=0/' "$dir/dry-run-2026-09-14.txt" ;;
      4) python3 -c "import json; d=json.load(open('$dir/no-prod-writes.json')); d['vault_porcelain']='M some-file'; json.dump(d, open('$dir/no-prod-writes.json','w'))" ;;
      5) python3 -c "import json; d=json.load(open('$dir/idempotency.json')); d['stale_then_next_acquire_wins']=False; json.dump(d, open('$dir/idempotency.json','w'))" ;;
      6) sed -i '' 's/Fireflies error:.*/Fireflies section: all clear./' "$dir/digest-dry-run.txt" ;;
      7) python3 -c "import json; d=json.load(open('$dir/bus-guards.json')); d['G-BUS-2']['mutated_red']=False; json.dump(d, open('$dir/bus-guards.json','w'))" ;;
      8) : > "$dir/floor.txt" ;;
    esac
  }

  for i in 1 2 3 4 5 6 7 8; do
    local neg_dir="$scratch/neg-$i"
    rm -rf "$neg_dir"
    cp -r "$good_dir" "$neg_dir"
    break_item "$i" "$neg_dir"
    run_all_checks "$neg_dir" "$sha"
    local table
    table="$(print_table_and_exit_code || true)"
    local item_name="${ITEM_NAMES[$((i - 1))]}"
    local this_item_line
    this_item_line="$(printf '%s\n' "$table" | grep "^${item_name} ")"
    if ! printf '%s\n' "$this_item_line" | grep -q "FAIL"; then
      echo "SELFTEST FAILED: negative fixture for item $i ($item_name) did not flip that item to FAIL:" >&2
      printf '%s\n' "$table" >&2
      failures=$((failures + 1))
      continue
    fi
    local other_fail_count
    other_fail_count="$(printf '%s\n' "$table" | grep -c 'FAIL' || true)"
    if [ "${other_fail_count:-0}" -ne 1 ]; then
      echo "SELFTEST FAILED: negative fixture for item $i ($item_name) flipped $other_fail_count items, expected exactly 1:" >&2
      printf '%s\n' "$table" >&2
      failures=$((failures + 1))
      continue
    fi
    echo "g4-check selftest: OK - negative fixture for item $i ($item_name) flips ONLY that item to FAIL"
  done

  # --- G0B2-14: independently REMOVE each individually required field /
  # companion artifact and assert the owning item flips to FAIL. The coarse
  # one-break-per-item pass above cannot show that (say) a dry-run block with
  # no grounding quote, or an idempotency record with no last-lock-refusal, is
  # actually rejected. Each case is "<item-name>\t<shell mutator>".
  local -a FIELD_CASES=(
    "1-suite.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/suite.json'));d.pop('pytest_failed');json.dump(d,open('DIR/suite.json','w'))\""
    "1-suite.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/g1-record.json'));d.pop('vitest_tests');json.dump(d,open('DIR/g1-record.json','w'))\""
    "1-suite.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/suite.json'));d.pop('sha');json.dump(d,open('DIR/suite.json','w'))\""
    "3-dry-run"$'\t'"sed -i '' 's/^From: .*$//' DIR/dry-run-2026-09-14.txt"
    "3-dry-run"$'\t'"sed -i '' 's/\\[quote: [^]]*\\]//g' DIR/dry-run-2026-09-14.txt"
    "3-dry-run"$'\t'"sed -i '' 's/^  summary: .*$//' DIR/dry-run-2026-09-14.txt"
    "3-dry-run"$'\t'"sed -i '' 's/^  digest preview: .*$//' DIR/dry-run-2026-09-14.txt"
    "3-dry-run"$'\t'"sed -i '' 's/^  CRM row: .*$//' DIR/dry-run-2026-09-14.txt"
    "3-dry-run"$'\t'"sed -i '' 's/^  page diff for .*$//' DIR/dry-run-2026-09-14.txt"
    "3-dry-run"$'\t'"sed -i '' 's/^  task: .*$//' DIR/dry-run-2026-09-14.txt"
    "3-dry-run"$'\t'"sed -i '' 's/model_receipt/no_receipt/g' DIR/dry-run-2026-09-14.ledger.jsonl"
    "3-dry-run"$'\t'"python3 -c \"import json;d=json.load(open('DIR/run-receipt.json'));d.pop('window_days');json.dump(d,open('DIR/run-receipt.json','w'))\""
    "3-dry-run"$'\t'"rm -f DIR/run-receipt.json"
    "3-dry-run"$'\t'"rm -f DIR/dry-run-2026-09-14.ledger.jsonl"
    "4-no-prod-writes.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/no-prod-writes.json'));d['gws_argv_verbs']=['+draft'];json.dump(d,open('DIR/no-prod-writes.json','w'))\""
    "4-no-prod-writes.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/no-prod-writes.json'));d['shim_forbidden_verbs']=['create-task'];json.dump(d,open('DIR/no-prod-writes.json','w'))\""
    "4-no-prod-writes.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/no-prod-writes.json'));d['crm']['contacts_json']['sha_after']='zzz';json.dump(d,open('DIR/no-prod-writes.json','w'))\""
    "4-no-prod-writes.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/no-prod-writes.json'));d['vault_tree_diff']='+ clients/acme.md.lock';json.dump(d,open('DIR/no-prod-writes.json','w'))\""
    "4-no-prod-writes.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/no-prod-writes.json'));d.pop('vault_tree_diff');json.dump(d,open('DIR/no-prod-writes.json','w'))\""
    "5-idempotency.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/idempotency.json'));d['stale_discovering_run_refuses']=False;json.dump(d,open('DIR/idempotency.json','w'))\""
    "5-idempotency.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/idempotency.json'));d['stale_refusal_reason']='already-claimed';json.dump(d,open('DIR/idempotency.json','w'))\""
    "5-idempotency.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/idempotency.json'));d.pop('third_run_receipt_byte_identical');json.dump(d,open('DIR/idempotency.json','w'))\""
    "5-idempotency.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/idempotency.json'));d['third_run_receipt_byte_identical']=False;json.dump(d,open('DIR/idempotency.json','w'))\""
    "5-idempotency.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/idempotency.json'));d.pop('third_run_lock_refusal');json.dump(d,open('DIR/idempotency.json','w'))\""
    "5-idempotency.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/idempotency.json'));d['third_run_lock_refusal'].pop('refused_at');json.dump(d,open('DIR/idempotency.json','w'))\""
    "5-idempotency.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/idempotency.json'));d.pop('second_run_previews_count');json.dump(d,open('DIR/idempotency.json','w'))\""
    "5-idempotency.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/idempotency.json'));d['third_run_exit_code']=0;json.dump(d,open('DIR/idempotency.json','w'))\""
    "6-digest-dry-run.txt"$'\t'"sed -i '' 's/^- invariants: OK$/- invariants: baseline missing — run write-baseline/' DIR/digest-dry-run.txt"
    "6-digest-dry-run.txt"$'\t'"sed -i '' -E '/^- (CRM|Page|Task created|Escalated|Revision|ignored|truncated)/d' DIR/digest-dry-run.txt"
    "7-bus-guards.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/bus-guards.json'));d['G-BUS-1'].pop('diff_applied');json.dump(d,open('DIR/bus-guards.json','w'))\""
    "8-floor.txt"$'\t'"sed -i '' 's/^Layer 3 .*$//' DIR/floor.txt"
    "8-floor.txt"$'\t'"rm -f DIR/idempotency.json DIR/suite.json"
    # G0B3-5: one negative per REQUIRED floor artifact — removed, emptied, uncited
    "8-floor.txt"$'\t'"rm -f DIR/g4/G0-review-opus.json"
    "8-floor.txt"$'\t'"rm -f DIR/g4/G0-review-opus.verify.json"
    "8-floor.txt"$'\t'"rm -f DIR/g4/G2-codex-review.stdout.log"
    "8-floor.txt"$'\t'"rm -f DIR/g4/G2-codex-challenge.stdout.log"
    "8-floor.txt"$'\t'"rm -f DIR/g4/FINAL-review-fable.json"
    "8-floor.txt"$'\t'"rm -f DIR/g4/FINAL-review-fable.verify.json"
    "8-floor.txt"$'\t'"rm -f DIR/g4/gate-invocations.json"
    "8-floor.txt"$'\t'": > DIR/g4/G0-review-opus.json"
    "8-floor.txt"$'\t'": > DIR/g4/gate-invocations.json"
    "8-floor.txt"$'\t'"sed -i '' 's|g4/G2-codex-challenge.stdout.log||' DIR/floor.txt"
    # G0B3-5: the G1 record must be BOUND to the measured tree and to this gate
    "1-suite.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/g1-record.json'));d.pop('base_sha');json.dump(d,open('DIR/g1-record.json','w'))\""
    "1-suite.json"$'\t'"python3 -c \"import json;d=json.load(open('DIR/g1-record.json'));d['base_sha']='0'*40;json.dump(d,open('DIR/g1-record.json','w'))\""
    # G0B3-4: the outcome declaration and the outcome COVERAGE are both required
    "3-dry-run"$'\t'"sed -i '' 's/^outcome: ignored$//' DIR/dry-run-2026-09-14.txt"
    "3-dry-run"$'\t'"sed -i '' 's/^outcome: escalated$/outcome: filed/' DIR/dry-run-2026-09-14.txt"
    "3-dry-run"$'\t'"sed -i '' 's/^  escalation: .*$/  escalation: none/' DIR/dry-run-2026-09-14.txt"
    "3-dry-run"$'\t'"sed -i '' 's/^  CRM: none$//;s/^  CRM row: .*$//;s/^  CRM: would create.*$//' DIR/dry-run-2026-09-14.txt"
  )

  local case_i=0
  for entry in "${FIELD_CASES[@]}"; do
    case_i=$((case_i + 1))
    local want_item mutator fdir
    want_item="${entry%%$'\t'*}"
    mutator="${entry#*$'\t'}"
    fdir="$scratch/field-$case_i"
    rm -rf "$fdir"; cp -r "$good_dir" "$fdir"
    eval "${mutator//DIR/$fdir}"
    run_all_checks "$fdir" "$sha"
    local ftable
    ftable="$(print_table_and_exit_code || true)"
    if ! printf '%s\n' "$ftable" | grep "^${want_item} " | grep -q FAIL; then
      echo "SELFTEST FAILED: required-field case $case_i did not flip $want_item to FAIL: $mutator" >&2
      printf '%s\n' "$ftable" >&2
      failures=$((failures + 1))
    fi
  done
  echo "g4-check selftest: OK - all ${#FIELD_CASES[@]} individually-required field/artifact removals are rejected by their own item"

  if [ "$failures" -ne 0 ]; then
    echo "SELFTEST FAILED: $failures item(s) did not isolate correctly" >&2
    return 1
  fi
  return 0
}

if [ "$MODE" = "--selftest" ]; then
  selftest
  exit $?
fi

MERGE_SHA="${1:?usage: g4-check.sh <merge-sha> | --selftest}"
G4_DIR="${CLIENT_STATE_G4_DIR:-$SELF_DIR/g4}"
run_all_checks "$G4_DIR" "$MERGE_SHA"
print_table_and_exit_code
exit $?
