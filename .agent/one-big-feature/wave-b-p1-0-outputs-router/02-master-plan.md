# WAVE B P1.0 outputs-router — Master Plan (VERIFY-only re-certification, no runtime code diff)

## What this pass is, and is not

This is **not** a new feature build. `orgs/clearworksai/skills/outputs-router/file_output.py`
shipped, merged, and has been in stable production use since PR #187 (commit `0fb86f6`, folding in
the path-traversal security fix from `13695fa`). Original scope (condensed from
`.agent/one-big-feature/p1-0-outputs-router/02-master-plan.md` and
`.agent/one-big-feature/system-plan-p1-0-outputs-router/02-master-plan.md`):

- A stdlib-only Python CLI (`file_output.py`) that files agent-produced artifacts into the
  knowledge-sync taxonomy by content type (`client|people|org|sop|diagram|session|media`),
  copying via `shutil.copy2` (never moves), injecting `agent:`/`job:`/`source-task:`/`date:`
  frontmatter into `.md`/`.txt` destinations, or writing a `<file>.provenance.md` sidecar for
  binaries.
- Refuses (non-zero exit, one-line stderr, no traceback) on: unknown content type, missing
  `--client` when `--content-type=client`, nonexistent `--source`, and an already-existing
  destination (never silently overwrites).
- `--client` is sanitized against path traversal (rejects absolute values, `..` components,
  embedded path separators), and `get_destination_path()` adds a `commonpath`-based containment
  backstop as defense-in-depth.
- Companion `SKILL.md` + a one-page knowledge-sync convention doc (both already shipped,
  out of scope for this pass — not re-touched here).

The slug `wave-b-p1-0-outputs-router` has zero pipeline-ledger rows because an earlier same-day
incident (`git reset --hard origin/main` run directly against the shared main checkout by a
different lane) silently wiped uncommitted ledger rows before they could be committed (see
`incident_shared_checkout_wiped_pipeline_ledger_2026-08-02.md`). This pass re-earns a real,
git-committed receipt from an isolated worktree so the record can't be lost the same way again.

## What has already been independently confirmed this session

An adversarial re-verification pass (`04-review.md`, run live against committed `main` @
`0fb86f6`) re-exercised the shipped script end-to-end and found:

- **PASS** — wrong-pattern directory (a stray non-taxonomy dump dir) absent.
- **PASS** — convention doc present and matches the routing table.
- **PASS** — CLI live-exercised: SOP write, missing-`--client` refusal, duplicate-destination
  refusal, three path-traversal payloads (absolute path, `..` components, embedded separator all
  rejected), one legitimate flat client slug (succeeds, lands at the expected path).
- **PASS** — the committed security fix (`validate_arguments()` sanitization +
  `get_destination_path()` `commonpath` backstop) is present and behaves correctly.
- **FAIL** — "unit test suite passes 10/10" cannot be substantiated for this component.
  `pytest tests/ -v` under `orgs/clearworksai/skills/outputs-router/tests/` does run and pass
  (currently 11/11), but every one of those tests belongs to a *different* tool
  (`mirror_deliverables.py`, P1.2, added later in commit `0721f95`). Confirmed live in this pass:
  `tests/` contains exactly one file, `test_mirror_deliverables.py`; `test_file_output.py` has
  never existed in this repo's git history. A receipt cannot claim "unit test suite passes" for
  `file_output.py` when no suite for `file_output.py` exists to run.

Non-blocking side note carried forward, explicitly **out of scope** for this pass: the committed
containment check uses `os.path.abspath()`, not `os.path.realpath()`, so it does not resolve
symlinks. A `os.path.realpath()` hardening already exists, uncommitted, on a separate unmerged
branch (`p1-0-outputs-router-hardening` @ `1bf8d42`). This pass does not touch that branch or that
question — it is a VERIFY-only pass on already-shipped `main`, not a hardening pass.

## The one real gap this pass closes

Add `orgs/clearworksai/skills/outputs-router/tests/test_file_output.py`: a genuine, deterministic,
committed automated test suite for `file_output.py`, covering exactly the branches already proven
live by hand in `04-review.md`, so the true-verify claim is backed by an executable suite instead
of resting on hand-run CLI transcripts alone.

This is a **small, additive, test-only change**:
- It adds one new file under `tests/`.
- It does **not** modify `file_output.py` in any way — no behavior change, no refactor, not even a
  whitespace touch.
- It does **not** touch `SKILL.md`, the convention doc, `mirror_deliverables.py`, or its existing
  test file.
- It does **not** write into the real `~/code/knowledge-sync` tree — the new suite must be fully
  self-contained under pytest `tmp_path` fixtures (see spec for the exact mechanism, since
  `CONTENT_TYPE_MAPPING` is a module-level constant baked from `os.path.expanduser(...)` at import
  time and must be monkeypatched rather than routed around).

## Deliverables (this pass)

1. `.agent/one-big-feature/wave-b-p1-0-outputs-router/03-specs/spec-01-reverify.md` (this spec) —
   defines the exact test cases a later build stage must implement in
   `orgs/clearworksai/skills/outputs-router/tests/test_file_output.py`.
2. (Later stage, not this one) `orgs/clearworksai/skills/outputs-router/tests/test_file_output.py`
   itself — implemented by the codexer/build stage against this spec.
3. (Later stage, not this one) A true-verify run that executes the new suite and records a real
   pass/fail receipt, closing the FAIL item from `04-review.md`.

## Explicitly out of scope for this pass

- Any change to `file_output.py` runtime behavior (including the known
  `os.path.realpath()` symlink-resolution gap — tracked separately on
  `p1-0-outputs-router-hardening`, not here).
- Any change to `SKILL.md` or the knowledge-sync convention doc.
- Any change to `mirror_deliverables.py` or `test_mirror_deliverables.py`.
- Writing the test file itself (that is the build stage's job, not this planning pass's).
- Re-litigating routing-table content, frontmatter contract, or CLI flag surface — all already
  shipped and independently re-confirmed correct in `04-review.md`.

## Sequencing

1. `01-research.md` — done (already written, read as input to this plan).
2. `02-master-plan.md` — this document.
3. `03-specs/spec-01-reverify.md` — concrete test-case spec (this pass's second deliverable).
4. Build stage (separate, later): implement `tests/test_file_output.py` per the spec.
5. True-verify stage (separate, later): run the new suite, confirm it is real (not
   vacuously-passing, not skipped), commit, and emit the pipeline-ledger receipt for
   `wave-b-p1-0-outputs-router`.

## Risk / rollback

Risk is minimal: the change is additive-only (one new test file), has no runtime code path, and
cannot regress production behavior. If the new suite somehow reveals a real behavioral bug in
`file_output.py` while being written, that finding must be escalated and handled as a *separate*,
explicitly-scoped fix — not silently folded into this test-only pass.

## File ownership

Build stage owns: `orgs/clearworksai/skills/outputs-router/tests/test_file_output.py` (new file
only). No other file in the repo is in scope for this pass.

## Rollout

Feature branch off `cortextos` main, PR to `clearworks-ai/cortextos`, Josh approves merge. Never
push to main directly. Branch name must equal the OBF slug (`wave-b-p1-0-outputs-router`) with no
prefix, per `reference_pr_gate_slug_branch_name_must_equal_obf_slug`.
