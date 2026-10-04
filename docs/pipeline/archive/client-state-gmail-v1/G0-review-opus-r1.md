# G0a — EMPIRICAL plan review (Opus)

**Reviewer:** claude-opus-5 (requested: opus; receipt: unverified-by-reviewer)
**Plan:** `docs/pipeline/plans/2026-09-14-client-state-gmail-v1-build.md`
**Plan sha256:** `2a2b0f449170e2619beb03cc58d195675285b7b60ccc9ea4578c55bf57c181c9`
**Branch tip:** `eb72ca79`
**Spec:** `state/specs/2026-09-14-client-state-gmail-v1-spec.md` (FR-001..FR-010, D-11, G-01..G-17)
**Throwaway:** `…/scratchpad/g0a-throwaway` (detached at eb72ca79, `npm ci` rc=0, removed at the end)

**Verdict: 7 Critical, 13 Important.** The plan's S-01..S-03, S-05, S-07, S-08 and S-09
slices apply and go green essentially as written. **S-04 + S-06 (Tasks 8 and 15 — the
poller and the orchestrator, i.e. the product's entry point) do not work against the code
the plan's own earlier tasks deliver**, and the plan says so at line 7333: Task 15 was
"Verified (standalone … with stand-in sibling modules built strictly to the skeleton's
Interfaces block … this only proves Task 15's own orchestration logic, not Tasks 1–11's
actual delivered code."

Final suite after all 23 tasks **plus 10 reviewer deviations applied to keep going**:

```
python3 -m pytest scripts/brain/tests -q -p no:cacheprovider
17 failed, 637 passed, 3 skipped in 42.19s          (BASELINE: 507 passed, 0 failed)

npx vitest run tests/unit/bus/ tests/unit/cli/
Test Files  73 passed | 1 skipped (74)
     Tests  974 passed | 3 skipped (977)

npx tsc --noEmit -p tsconfig.json      rc=0
```

Without the deviations the suite is worse: four test files never collect at all.

---

## Per-task run log (real output)

Legend: **AS WRITTEN** = the plan applied verbatim. **DEV-n** = a minimal reviewer
deviation applied only so later tasks could still be exercised; every one is a finding.

### Task 1 — Runner + observation ledger (FR-001) ✅
RED (Step 2, before the impl):
```
import observation_ledger as OL
E   ModuleNotFoundError: No module named 'observation_ledger'
```
GREEN (Step 4): `9 passed in 0.03s` — plan expected `9 passed`. ✅

### Task 2 — single-flight lock (FR-002) ❌ as written
```
scripts/brain/tests/test_single_flight.py:21: in <module>
    from helpers_client_state import FakeRunner
E   ModuleNotFoundError: No module named 'helpers_client_state'
ERROR scripts/brain/tests/test_single_flight.py
1 error in 0.06s
```
`scripts/brain/__init__.py` and `scripts/brain/tests/__init__.py` are both **tracked at
eb72ca79**, so pytest roots the module at the repo root and the tests dir is never on
`sys.path`. → **G0A-8**. After **DEV-1** (tests-dir `sys.path` insert): `5 passed, 1
skipped` — matching the plan. ✅

### Task 3 — run receipt + gap detection (FR-002) ✅
RED: `6 failed, 9 passed`. GREEN: `15 passed in 0.03s` — plan expected `15 passed`. ✅

### Task 4 — `gmail_source.py` (query, windows, transport, parsing) ✅
RED: `16 failed in 0.06s` (plan predicted `16 failed`). GREEN: `16 passed in 0.02s`,
`py_compile ok`. ✅ `EXCLUSION_QUERY` byte-matches the comms-check-worker clause (A1).

### Task 5 — `gmail_source.sweep` (50-cap day-sweep) ❌ as written
RED matched the plan exactly (`3 failed, 18 passed`). GREEN did **not**:
```
scripts/brain/tests/helpers_client_state.py:30: in run
    for prefix, result in self.responses:
E   ValueError: too many values to unpack (expected 2, got 9)
3 failed, 18 passed in 0.05s
```
and after allowing the dict form:
```
assert [{'argv': ['gws','gmail','+triage',…], 'input': None, 'env': None, 'timeout': 120}]
    == [['gws','gmail','+triage',…]]
```
Task 1's shared `FakeRunner` takes a **list of (prefix, result)** pairs and records
**dict** calls; Task 5 constructs it with a **dict** and asserts **bare argv lists**.
→ **G0A-10**. After **DEV-2/DEV-3**: `21 passed` — matching the plan. ✅ (The sweep logic
itself is correct: full query first, one query per day on a 50-cap, union by id,
per-day truncation reported.)

### Task 6 — `resolve_email.py` ⚠️ count wrong
GREEN: `12 passed in 0.03s`. Plan says `Expected: 13 passed in 0.18s`. The block contains
exactly 12 `def test_`. → **G0A-16**.

### Task 7 — vault/CRM fixture builders ❌ as written
After DEV-1 the collection error becomes:
```
ERROR scripts/brain/tests/test_helpers_client_state.py - NameError: name 'Path' is not defined
```
Task 7's append uses `Path`, `shutil`, `json`; Task 1's module imports none of them.
→ **G0A-9**. After **DEV-4**: `2 passed` — matching the plan. ✅

### Task 8 — poller skeleton ❌ as written (product-code bug)
```
RunResult(exit_code=3, filed=0, ignored=0, …)
run-receipt.json: {"error": "cannot access local variable 'cfg' where it is not associated with a value"}
3 failed, 2 passed
```
`_file_message` does `del cfg, runner, ledger` on the line **before**
`tag = "[dry-run] " if cfg.dry_run else ""`. → **G0A-6**. Then:
```
run-receipt.json: {"error": "[Errno 2] No such file or directory: …/state/claims/0f7b9f64….lock"}
assert result.ignored == 25 → assert 9 == 25
```
`Lease.touch()` calls `os.utime` unguarded. → **G0A-13**. After **DEV-5/DEV-6**:
`5 passed` — matching the plan. ✅

(The receipt correctly persisting the cause here is the behaviour Task 15 later loses —
see G0A-4.)

### Task 9 — email extraction schema + module ✅
RED: `9 failed`. GREEN: `9 passed`, `py_compile ok` — plan expected `9 passed`. ✅

### Task 10 — `extract()` ✅
RED: `7 failed, 9 passed`. GREEN: `16 passed` — plan expected `16 passed`. ✅
`CLAUDE_ARGV` is byte-identical to `extract_meeting.py:358-371`. ✅

### Task 11 — `cached_or_extract()` + hostile body ✅ (with the documented cross-dep)
`19 passed, 1 deselected` — plan expected `19 passed`. The hostile test alone:
`1 failed … ModuleNotFoundError: No module named 'client_state_writes'` (plan said
"1 error"; same intent — the import is inside the test body).

### Task 12 — CRM contact auto-create + interaction write ✅
`10 passed` — plan expected `10 passed`. ✅

### Task 13 — `writeback_email.py` renderer ✅
`10 passed` — plan expected `10 passed`. ✅ (The prefix-matching History deviation is
flagged in the plan with its reason; reviewed and accepted.)

### Task 14 — owner normalization, tier-1/tier-2 dedup, task planning ❌ as written
```
assert difflib.SequenceMatcher(None, a, b).ratio() == 0.75
E   NameError: name 'difflib' is not defined. Did you forget to import 'difflib'?
2 failed, 19 passed
```
Both failures are the **tier-1 boundary tests** — the guard for the goal's BINDING
"ratio STRICTLY > 0.75". → **G0A-11**. Plan claims `21 passed`.

Task 14's mandated re-run of Task 11's containment test (plan: "Task 14's own Step 4
MUST re-run this exact test and confirm it passes"):
```
plans = plan_tasks(stamped, [], [], f"gmail:{msg.id}")
>   assert len(plans) == 1
E   assert 0 == 1
E    +  where 0 = len([])
```
**`plan_tasks` reads `commitment["owner"]`; the binding schema requires `owner_name`
with `additionalProperties: false`.** Every schema-valid commitment is dropped →
FR-008 creates zero tasks, ever. → **G0A-2** (Critical). Task 14's own unit tests pass
only because they hand-build commitments with an `owner` key the schema forbids.
After **DEV-7/DEV-8**: `21 passed` and the containment test green. ✅

### Task 15 — orchestrator wiring ❌❌ (the headline failure)
As written the test file does not compile:
```
File ".../test_client_state_gmail.py", line 233
    from __future__ import annotations
SyntaxError: from __future__ imports must occur at the beginning of the file
```
The "append" block is shaped as a whole file (docstring + `__future__` + duplicate
preamble). → **G0A-12**. After **DEV-9**: `13 failed, 1 passed`. The failures:

```
AssertionError: _WriteFakeRunner: unexpected argv ['cortextos','bus','meeting-brief-claim',
  'client-state-gmail','--claims-dir',…,'--ttl-min','60']          ×9
AssertionError: unexpected argv: ['claude','-p','--setting-sources','',…]   ×2  (Task 8's tests)
FileNotFoundError: …/state/run-receipt.json                                (lock-held test)
gmail_source.GmailSourceError: gws gmail +triage failed rc=1: boom: gmail api quota exceeded  (uncaught)
```
After **DEV-10** (scripting the claim/release and `claude` in the fakes): still
`13 failed, 1 passed`:
```
assert result.filed == 1 → assert 0 == 1
  RunResult(…, ignored=1, previews=['gmail:m1: no pending resolutions (escalated=0 ignored=1)'])
assert rows[0]["reason"] == "no-known-entity" → AssertionError: assert '' == 'no-known-entity'
FileNotFoundError: …/vault/raw/areas/clearworks/org-brain/clients/acme-co.md
```
The fixture sender is `marcos@acme.com` while Task 7's `vault_min` declares
`domains: acme.org`, and Task 6's resolver is (correctly, per FR-004) full-domain-key
only — so the message is ignored, never filed. → **G0A-1** (Critical).

Three further Criticals read straight off Task 15's module:

* `run()` catches **only** `BudgetExceeded`; `GmailSourceError`/`ExtractionError` escape
  uncaught, and the lock-held path returns exit 2 with no receipt — contradicting the
  plan's own exit-code contract and the goal's "Fail-closed halts persist the cause".
  Task 8's version had the broad handler; Task 15's rewrite dropped it. → **G0A-4**
* Every `ledger.append(row)` and the only `_write_receipt` sit behind `if not
  cfg.dry_run:` — the dry-run produces **no ledger and no receipt**, so G4 items 3, 5
  and 6 cannot be satisfied and a repeated dry-run re-spends real `claude` money.
  → **G0A-3**
* `if cfg.query: messages_raw = gmail_source.list_messages(runner, cfg.query)` — the
  backfill path drops the FR-003 verbatim exclusion clause (Task 8 merged it), ignores
  `--days`, and skips the 50-cap day-sweep. → **G0A-5**

### Task 16 — `createTask({ type })` ✅
Both OLD snippets matched exactly once in the unmodified `src/bus/task.ts` /
`src/cli/bus.ts`. RED: `2 failed | 2 passed`. GREEN: `4 passed` and `3 passed`;
`npx tsc --noEmit -p tsconfig.json` rc=0. ✅

### Task 17 — `claimTask` human-exempt refusal + `--force-claim` ✅
All four OLD snippets matched exactly once. RED: `1 failed | 6 passed`. GREEN:
`7 passed` and `6 passed`; tsc rc=0. Regression sweep
`npx vitest run tests/unit/bus/ tests/unit/cli/` → **73 passed | 1 skipped files,
974 passed | 3 skipped tests** — the new claim guard breaks nothing. ✅

**S-07 is the cleanest slice in the plan.**

### Task 18 — invariants + baseline ✅
`7 passed` — plan expected `7 passed`. ✅

### Task 19 — `gmail_section` ✅
RED: `4 failed, 7 passed`. GREEN: `11 passed` — plan expected `11 passed`. ✅

### Task 20 — `meeting_loop_watch.py` independent sections ✅
RED: `2 failed`. GREEN: `2 passed` — plan expected `2 passed`. ✅
`CLIENT_STATE_DIR`, `--dry-run` and `--days` all survive the 161→202-line rewrite.
(No pre-existing test imports this module, so the rewrite has no legacy coverage.)

### Task 21 — PATH-trap shims + COUNT DELTA + G4 checker ✅
Step 2 RED: `rc=127`. Step 4:
```
PASS: shims/cortextos traps 'bus create-task'
PASS: shims/cortextos passes through 'bus meeting-brief-claim'
PASS: shims/cortextos passes through 'bus meeting-brief-release'
PASS: shims/gws-trap always traps
PASS: shims/claude-trap always traps
g1-count-delta: FATAL - could not extract vitest 'Test Files'/'Tests' summary … (fail-closed, non-vacuous)
g1-count-delta selftest: OK - doctored log correctly rejected (non-vacuous)
g1-count-delta selftest: OK - clean log pair extracts successfully
PASS: g4-check.sh fails closed with no evidence artifacts
PASS: g4-check.sh exits 0 against a fully-satisfying fixture
PASS: g4-check.sh printed 8 PASS rows
ALL OPS-SHIM TESTS PASSED          rc=0
```
The shim's pass-through list is **exactly** `bus meeting-brief-claim` /
`bus meeting-brief-release`, as the goal requires. ✅

### Task 22 — coverage-diff + cron-precheck ✅
RED: `4 failed`. GREEN: `4 passed`; and
```
fixtures/crons-bad.json:0: cron 'range-with-step-regression' uses range-with-step form: 1-5/2 * * * *
cron-precheck selftest: OK (clean fixture -> 0, bad fixture -> 1)     rc=0
```
✅

### Task 23 — guard registry, mutation harness, parity, no-network ❌
Plan's Step-4 gate expects rc=0; actual `1 failed, 4 passed`:
```
AssertionError: registered guard ids with no '# G-<ID>' comment found:
['G-CRM-1','G-DEDUP-1','G-DIG-2','G-FAIL-1','G-HIST-1','G-HIST-2','G-IDEMP-1',
 'G-IDEMP-2','G-INJ-1','G-LOCK-3','G-PARITY-1','G-RECEIPT-1','G-SWEEP-1','G-SWEEP-2',
 'G-SWEEP-3','G-SWEEP-4','G-SWEEP-5','G-SWEEP-6','G-SWEEP-8','G-TASK-1']
```
Markers actually present in `scripts/brain/*.py`: G-DIG-1, G-EXT-1/2/3, G-INV-1/2,
G-LEDGER-1..5, G-LOCK-1/2, G-RECEIPT-2, G-RES-1/2, G-SWEEP-7 — 17 of 37 python rows.
→ **G0A-15**

`mutation-check.sh`:
```
Traceback (most recent call last):
  File "<stdin>", line 3, in <module>
ModuleNotFoundError: No module named 'test_client_state_guards'
rc=0
```
**rc=0 with zero guard rows executed.** `done < <(registry_rows)` — a failing process
substitution feeds an empty stream, `FAILED` stays 0, both output JSONs are written as
`{}` and the script exits clean. Reproduced in isolation. It also defaults
`REPO_ROOT` to a hardcoded `/Users/joshweiss/code/cortextos-worktrees/client-state-gmail-v1`
and sed-mutates modules in place, reverting with `git checkout --` (which cannot restore
an untracked file — and every new client-state module is untracked until committed).
→ **G0A-14**

Parity: `1 failed, 3 passed, 2 skipped` —
`RuntimeError: ensure_contact: could not resolve contact id for 'lori@abundowealth.com'`
→ **G0A-18**. Two of the parity rows are declared `pytest.skip` gaps (escalation text,
digest line) → **G0A-7**.

No-network: `1 failed, 1 passed` — `test_no_shim_traps_during_focused_suite` fails only
because the focused suite itself is red.

---

## Spec / goal conformance (analytical, verified in the applied tree)

| Check | Result |
|---|---|
| FR-010 allowlist | ✅ exactly `.gitignore`, `scripts/brain/meeting_loop_watch.py`, `src/bus/task.ts`, `src/cli/bus.ts` modified; everything else new under allowed dirs |
| Extraction argv pinned | ✅ byte-identical to `extract_meeting.py:358-371`, prompt on stdin, no tools, one turn |
| `bus comms-filter` never called | ✅ zero occurrences in delivered code |
| Full-domain keys only (FR-004) | ✅ `closed["domain_to_slug"].get(dom)`, never `registrable_label` |
| Tier-1 strictly > 0.75 (FR-008) | ✅ in code — ❌ its two boundary tests never execute (G0A-11) |
| `gmail:`-scoped invariants (FR-009) | ✅ regex scoped to `[source: gmail:…]` |
| Sections fail independently (FR-009) | ✅ Task 20, 2 passing tests |
| Verbatim comms-check exclusion (A1) | ✅ byte-compared against `comms-check-worker/SKILL.md` |
| Day-sweep full coverage (FR-002) | ✅ on the window path — ❌ bypassed entirely on `--query` (G0A-5) |
| Escalate-once (FR-003) | ❌ not built; `Ledger.escalated_for` has zero consumers, no `clientstate:` namespace (G0A-7) |
| `cortextos` shim pass-through | ✅ exactly meeting-brief-claim/release |
| External-write boundary | ✅ no code path writes the production vault/CRM/bus in dry-run — but the dry-run also writes nothing to its own scratch state dir, which is the opposite problem (G0A-3) |
| Every FR-001..FR-009 bullet has a task | ✅ |
| No task imports a symbol a later task defines | ✅ with the one plan-declared exception (Task 11 → Task 14) |

## Comments-are-claims

**Verified by execution or by reading the cited source:** `lock_path` ≡
`meeting-brief.ts claimLockPath`; the `meeting-brief-claim/release` arg shape;
`quote_gate` copying non-gated keys whole (`dict(extraction)` at
`resolve_meeting.py:437`); `dedupe_history.py:66` treating ≤0.75 as not-a-duplicate;
`bus list-tasks` having no bare `--json`; `createTask` hardcoding `type:'agent'` and
`claimTask` checking pending only; `isHumanExemptTask` already exported; the verbatim
exclusion clause; the FR-010 allowlist; the shim pass-through list; `g1-count-delta.sh`
being non-vacuous; `g4-check.sh` failing closed.

**Claims found FALSE:** Task 15's "Task 8's own tests are unmodified and keep passing";
Task 22's "matching the other scripts/brain/tests files" (it is the only one that gets
the sys.path insert right); `list_open_tasks`' 500-row enumeration (clamped to 200);
Task 6/8/14/15's stated expected counts.

**Taken on trust** (no credentialed/network runs at G0a): live `gws +triage`/`+read`
payload shapes; `add-interaction.py` / `upsert-contact.py` argv acceptance and stdout;
the real `claude -p` wrapper JSON; the real vault's `## History (dated, newest first)`
convention behind Task 13's prefix-matching deviation; the 2026-08-11 crons fixture;
the `LoggingRunner` argv.log satisfying G4 item 4; vitest totals outside
tests/unit/bus and tests/unit/cli.

## Not findings (locked decisions / accepted assumptions)

Post-hoc budget check; the unvalidated >0.75 threshold transfer; Gmail list ordering;
the latent range-with-step cron form; unknowable inbox volume; `--type human` being
inert before S-07; no triviality gate; comms-filter excluded from the records lane;
`matches_open_item` quote-gate exemption; Task 13's History-heading prefix match.
Each is cited to its row in the JSON artifact.

## Teardown

`git worktree remove --force` run; `git worktree list` no longer shows the throwaway;
`git -C /Users/joshweiss/code/cortextos-worktrees/client-state-gmail-v1 status --short`
is clean (the plan file lives under the gitignored `docs/`, so porcelain is empty —
nothing in that worktree was modified).
