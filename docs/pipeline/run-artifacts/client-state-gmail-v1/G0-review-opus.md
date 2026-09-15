# G0a EMPIRICAL plan review — ROUND 3 (final)

- **Reviewer:** claude-opus-5 (requested: opus; receipt unverified by the reviewer)
- **Plan:** `docs/pipeline/plans/2026-09-14-client-state-gmail-v1-build.md`
- **sha256:** `8ac1ca58847cf0991c0ba3a114592921b2d7cede91257adcff0a02701f3c1bad` — **verified** by `shasum -a 256`
- **Branch tip:** `248d61de` — verified
- **Artifact:** `G0-review-opus.json` (79 findings: every id from rounds 1–3)

## Verdict

**The integrator's core claim reproduces.** A fresh detached worktree at `248d61de`,
materialised **only** from the plan's own labelled blocks by a materialiser I wrote for
this round, gives **pytest 693 passed / 0 failed / 1 skipped**, **tsc rc 0**, **vitest 7+6**,
**mutation 60/60 green**, and every ops selftest rc 0. Zero Criticals remain open.

Two **Important** documentation defects survive the integration (details below). Neither
breaks a gate mechanically; both are residuals of findings the integrator reported as
fully fixed.

## Method

I did not reuse the integrator's harness. Three independent tools:

- `scratchpad/r3-mat.py` — replays every `# file:` / `// file:` block **in plan order**,
  honouring `(append)` and `<!-- retire: P -->`, with a `--through TASK` and an
  `--until-line` cutoff so a tree can be built to any point mid-task.
- `scratchpad/r3-ts.py` — applies the Task 16/17 `// OLD` / `// NEW` pairs and **fails
  loudly** if an anchor is missing or matches more than once.
- `scratchpad/r3-walk.sh` — for each task: `git checkout -- . && git clean -fd`,
  re-materialise **through that task only**, run that task's own Step-4 command.

That last point matters: the plan was checked task-by-task from a reset tree, not merely
at the end.

### TS anchors

All **8** `OLD` anchors in Tasks 16–17 matched **exactly once** against the real
`src/bus/task.ts`, `src/cli/bus.ts` and the two new test files. Zero missing, zero
ambiguous. The plan's TS diffs are accurate against the branch tip.

## Task-by-task (stated vs actual)

| Task | Stated | Actual | |
|---|---|---|---|
| 1 | 9 passed | 9 passed | ✅ |
| 2 | 7 passed, 1 skipped | 7 passed, 1 skipped | ✅ |
| 3 | 16 passed | 16 passed | ✅ |
| 4 | 16 passed | 16 passed | ✅ |
| 5 | 22 passed | 22 passed | ✅ |
| 6 | 13 passed | 13 passed | ✅ |
| 7 | 2 passed | 2 passed | ✅ |
| 8 | 6 passed | 6 passed | ✅ |
| 9 | 12 passed | 12 passed | ✅ |
| 10 | 19 passed | 19 passed | ✅ |
| 11 | 24 passed | 24 passed | ✅ |
| 12 | 7 passed | 7 passed | ✅ |
| 13 | 10 passed | 10 passed | ✅ |
| 14 | 24 passed | 24 passed | ✅ |
| 15 | 32 passed | 32 passed | ✅ |
| 16–17 | vitest green, tsc 0 | 7 passed / 6 passed, tsc rc 0 | ✅ |
| 18 | 8 passed | 8 passed | ✅ |
| 19 | 16 passed | 16 passed | ✅ |
| 20 | 3 passed | 3 passed | ✅ |
| 21 | 18 PASS rows, ALL OPS-SHIM TESTS PASSED | identical | ✅ |
| 22 | 4 passed + selftest OK | identical | ✅ |
| 23 | 13 passed | 13 passed | ✅ |

Every Step-4 count in the plan is now **true**. (Task 23 initially failed in my harness
with `PermissionError` on `shims/cortextos` — that was my materialiser not setting exec
bits; the plan's Task 21 Step 4 does `chmod +x` the shims. Re-run faithfully: 13 passed.)

### Step-2 (RED) claims

The plan must be true at its red steps too, so I rebuilt the pre-Step-3 state for five tasks:

| Task | Stated | Actual | |
|---|---|---|---|
| 3 | 9 passed, 7 failed | 7 failed, 9 passed | ✅ |
| 4 | 16 failed | 16 failed | ✅ |
| 5 | 4 failed, 18 passed | 4 failed, 18 passed | ✅ |
| 19 | "Re-derived (wave2): 14 passed" | **8 failed, 8 passed** | ❌ **G0A3-2** |
| 20 | `TypeError: main() takes 0 positional arguments…` | exactly that, on all 3 | ✅ |

## Special-attention areas

**Simulated dry-run rows vs `is_terminal` vs the live run — sound.** A dry run sets
`simulated=True` with `planned_writes` populated and `writes=[]`. `Ledger.is_terminal`
(`observation_ledger.py:130`) and `Ledger.escalated_for` (`:169`) both return `False` on
a simulated row. `client_state_projections.effective_writes()` switches on the flag so
the digest renders planned effects tagged `[simulated]`. `open_email_tasks()` reads
`row.writes`, which is empty for dry runs, so previews cannot leak into task dedup.
`coverage-diff.confirmed_crm_keys` counts only real `crm:` tokens. `G-LEDGER-6` is
mutation-pinned green. I also checked `_persist_partial` (`client_state_gmail.py:282`),
which omits `simulated=` — benign, because it early-returns when `cfg.dry_run`.

**FakeRunner consume-if-followed — coherent.** Implementation at
`helpers_client_state.py:73-77` matches its docstring exactly: first match in insertion
order; consumed only if an identical prefix appears later. One semantics, every consumer
green.

**Cached extraction context re-resolution — correct.** `rebind_cached_matches` maps each
cached index back through the stored context, finds the same `(text, source)` in the
current context, and clears to `None` on a miss. Called on every cache hit; no new LLM call.

**Lost-lease stop — correct.** `touch()` sets `lost` on `FileNotFoundError`; the
orchestrator touches at the top of **every** message iteration and raises `LeaseLost`
before any further effect; `release()` is a no-op once lost.

**Shim pass-through — exactly the three required verbs.** `{bus meeting-brief-claim,
bus meeting-brief-release, bus list-tasks}`, all logged; everything else traps and exits 1.

**g1-count-delta — fail-closed.** No hardcoded fallback survives: bare `--selftest` exits
2 with `FATAL - CLIENT_STATE_REPO_ROOT is required … refusing to guess`. With it set,
rc 0 and 5 OK lines including both `base_sha` proofs.

**g4-check positive fixtures — real producers.** Items 3/5/6 come from `g4-gen-fixture.py`,
which imports and drives `client_state_gmail`, `client_state_digest` and
`observation_ledger`. I went further and proved the **real** `bus-guards.json` emitted by
`mutation-check.sh` satisfies g4's item-7 validator, so producer and checker agree.

**mutation-check — parent-shell arrays and restore trap both real.** `declare -a` at
parent scope (`:44-45`), `trap restore_all EXIT` (`:66`), `backup_target` called in the
parent shell (`:159`). `purge_pycache` runs after the mutation *and* after the restore,
closing the byte-length-preserving hole. Empirically `src/bus/task.ts` and `src/cli/bus.ts`
were **md5-identical** before and after the 60-row run. One note: `diff_applied` is printed
from the same variable as `mutation_applied`, so the four booleans are really three
independent signals plus the `diff` string — I confirmed all 60 diffs are non-empty, so no
false green was produced.

**coverage-diff — keyed per `(source_ref, contact_id)`** from real `crm:` write tokens only.

**FR-010 allowlist — exact.** `git status --porcelain --untracked-files=no` on the fully
materialised tree lists **exactly four** existing files, all allowlisted:

- `.gitignore` (one added line, `state/client-state/`)
- `scripts/brain/meeting_loop_watch.py`
- `src/bus/task.ts`
- `src/cli/bus.ts`

All other 38 of the 42 paths are new.

**Comments are claims.** Executed the cheap ones. `G-LOCK-1`'s "must reproduce
`src/bus/meeting-brief.ts` `claimLockPath` exactly" — verified identical
(`sha256(...).hex[:32] + '.lock'`). `G0A-19`'s "`LIST_TASKS_MAX_LIMIT` is 200,
`src/bus/task.ts:89`" — that line reads exactly `export const LIST_TASKS_MAX_LIMIT = 200;`.
Task 15's retire is a real `git rm -f`, not just an HTML comment.

## Dispositions

| | Count |
|---|---|
| fixed-and-reverified | 75 |
| still-open (Important) | 2 — `G0A-16`, `G0A2-11` |
| new, open (Important) | 2 — `G0A3-1`, `G0A3-2` |
| **Critical not closed** | **0** |

## New findings

### G0A3-1 (Important) — File map still omits a new test file

The tree contains exactly **42** new-or-modified tracked paths, matching the integrator's
count. But 7 are named nowhere in `## File map`. Four are legitimately covered by the glob
`fixtures/client_state/*.json`. The other three are not:

- `scripts/brain/tests/test_client_state_projections.py` — a **new test file** created by
  Task 15, contributing 8 tests
- `…/fixtures/client_state/vault_min/…/clients/{acme,alloi}.md` — the glob is `*.json` and
  does not reach into `vault_min/`

The ops row also omits `shims/claude-trap`, `test-ops-shims.sh`, `g4-gen-fixture.py`,
`mutation-check.sh` and `fixtures/crons-*.json`, and misfiles `test_coverage_diff.py` under
`docs/pipeline/run-artifacts/` when it lives at `scripts/brain/tests/`.

This is the residual of `G0A-16` / `G0A2-11`, which the integrator reported fixed ("lists
all 42 tracked paths … including the two previously-omitted test files"). **Not Critical:**
`g1-count-delta.sh` never reads the File map — it takes explicit `+files +tests +pytest`
deltas as arguments and re-runs the suite — so nothing breaks mechanically. The cost is a
builder deriving G1's `+files` from the File map under-counts by one test file.

### G0A3-2 (Important) — Task 19's Step-2 sandbox note contradicts the in-sequence reality

The note claims "Re-derived (wave2, real run): **14 passed**". Built in task order from the
plan's own blocks, Task 19's Step-2 command gives **8 failed, 8 passed**. The note itself
discloses it was measured against `scratchpad/wave2-sandbox/` with "a LOCAL STUB
`client_state_projections.py`" and "a LOCAL `FakeRunner` patch" — i.e. not from this plan's
blocks and not in task order.

Mitigating: the task's **primary** `Expected:` line is correct and matches my run
("AttributeError … no attribute `gmail_section` on the new tests (Part A's 8 stay green)"),
so a builder reading the authoritative line is not misled. This is the Step-2 residual of
`G0A2-12`, whose fix re-derived Step-4 counts only.

## Note on the integration artifact

`G0-r3-integration.json`'s `G0A2-2` disposition cites the pin
`test_dry_run_escalation_row_does_not_suppress_the_live_escalation`. No such node exists;
the real one is `…_does_not_suppress_the_live_telegram`, and it passes. Citation error in
the integration artifact, not a plan defect.

## Teardown

Throwaway worktree removed; `git worktree list` clean of it. The real worktree was read
only — its sole modification is this artifact pair.
