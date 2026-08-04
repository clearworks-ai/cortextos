# WAVE B P1.0 outputs-router — Research (re-verification, no new code diff)

## Purpose of this pass

This is a **re-verification** pipeline receipt, not a new build. `orgs/clearworksai/skills/outputs-router/file_output.py`
shipped and merged long ago (commit `9b8afb3` implementation, `13695fa` + folded into `0fb86f6`
"P1.0: outputs-router skill + path-traversal fix (#187)"). It is stable and has been running in
production use by agents since. The slug `wave-b-p1-0-outputs-router` has **zero** ledger rows
(`bin/pipeline-stage-emit --verify --slug wave-b-p1-0-outputs-router --through true-verify
--max-age 86400` → `NO_ROWS`) because an earlier same-day incident (`git reset --hard
origin/main` run directly in the shared main checkout by a different lane, logged in
`incident_shared_checkout_wiped_pipeline_ledger_2026-08-02.md`) silently wiped uncommitted ledger
rows before they could be committed. This pass re-earns a real, git-committed receipt from an
isolated worktree so it can never be silently lost again.

## Original scope (condensed from `.agent/one-big-feature/p1-0-outputs-router/01-research.md` and
`.agent/one-big-feature/system-plan-p1-0-outputs-router/01-research.md`)

Source of truth: `~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md`,
`DECISIONS-FOR-JOSH.md` (D4, accepted). Problem: agent outputs had no consistent home or
provenance convention. D4 mandates filing BY CONTENT TYPE into the existing knowledge-sync
taxonomy (not a generic `agent-outputs/<agent>/` dump), with provenance in frontmatter, never in
the path. P1.0 ships first because P1.2 (deliverables mirror) and P2 (job I/O contract) both
depend on this convention existing.

Constraint (C6/C7, binding): custom code lives in `orgs/`, `community/`, config — not `src/`. The
helper is a stdlib-only Python script (`file_output.py`) plus `SKILL.md`, matching the existing
`orgs/clearworksai/skills/*` pattern (no bus subcommand).

Binding contract:
- CLI flags: `--content-type`, `--source`, `--agent`, `--job`, `--source-task`, `--date`,
  `--client` (required only when `--content-type=client`).
- Routing table (7 content types): `client → raw/areas/clearworks/<client>/`,
  `people → raw/resources/people/`, `org → raw/resources/organizations/`,
  `sop → raw/resources/reference/clearworks/`, `diagram → raw/areas/clearworks/diagrams/`,
  `session → raw/sessions/`, `media → raw/media/`.
- Frontmatter contract: `agent:`, `job:`, `source-task:`, `date:` injected for `.md`/`.txt`;
  `<file>.provenance.md` sidecar for binaries.
- `shutil.copy2` (never move), stdlib only, refuse silent overwrite of an existing destination.

## What has already been verified against this exact code, and by whom

1. **Original spec review** (`.agent/one-big-feature/system-plan-p1-0-outputs-router/05-review.md`,
   static review): verdict PASS-WITH-NOTES. Found the `--client` path-traversal gap (no
   sanitization against absolute/`..` values) as a real, then-unfixed security issue, plus minor
   spec-conformance notes (frontmatter "merge" vs "inject", `SKILL.md` missing YAML frontmatter
   header). This predates the traversal fix.
2. **Path-traversal fix landed**: commit `13695fa` ("Security fix: sanitize --client parameter to
   prevent path traversal"), folded into merged commit `0fb86f6` (PR #187, on `main`). Confirmed
   live in this worktree — `validate_arguments()` (`file_output.py:53-71`) now rejects absolute
   `--client`, `..` components, and embedded path separators; `get_destination_path()`
   (`:74-91`) adds a `commonpath` containment backstop via `os.path.abspath()`.
3. **Independent adversarial re-verification this session**
   (`.agent/one-big-feature/wave-b-p1-0-outputs-router/04-review.md`, dated 2026-08-03, run
   against committed `main` @ `0fb86f6`): live-exercised the script end-to-end (SOP write,
   missing-`--client` refusal, duplicate-destination refusal, 3 traversal payloads + 1 legit
   client slug) — all **PASS**. Ran `pytest tests/ -v` → 11/11 passed, but found those 11 tests
   all belong to a *different* tool (`mirror_deliverables.py`, P1.2, added later in commit
   `0721f95`) — **`tests/` has zero dedicated coverage of `file_output.py`, and no
   `test_file_output.py` has ever existed in this repo's git history.** Overall verdict on that
   pass: **FAIL** on the checklist item "unit test suite passes 10/10", specifically because that
   claim cannot be substantiated for the component actually under review — it conflates two tools.
   The verdict also flagged a non-blocking follow-up: the committed containment check uses
   `os.path.abspath()`, not `os.path.realpath()`, so it doesn't resolve symlinks (a
   `os.path.realpath()` hardening exists uncommitted on a separate, unmerged branch,
   `p1-0-outputs-router-hardening` @ `1bf8d42` — out of scope for this VERIFY-only pass).

## Consequence for this pipeline run

The finding above is real and reproducible (confirmed independently again in this pass — see
`03-specs/` and `05-true-verify-evidence.md`): the functional behavior of `file_output.py` is
correct and has been live-exercised twice now, but the component had no committed automated test
file. Per this repo's own gate rule ("must be REAL... do NOT force a pass"), a receipt cannot
assert "unit test suite passes" without an actual suite to run. This pass closes that specific,
narrow gap — adding `orgs/clearworksai/skills/outputs-router/tests/test_file_output.py` with real,
deterministic (tmp-dir, monkeypatched destination table) coverage of the same branches already
proven live in `04-review.md` — so the true-verify claim is backed by an executable, committed
test suite rather than by hand-run CLI transcripts alone. This is a small, additive test-only
diff; it does not change `file_output.py`'s runtime behavior.
