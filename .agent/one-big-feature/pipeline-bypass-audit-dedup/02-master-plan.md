# 02 — Master Plan: pipeline-bypass-audit-dedup

Slug: `pipeline-bypass-audit-dedup`
Framework: one-big-feature (single cohesive shell-script fix, one repo, no schema, no
multi-repo, no new dependency)
Date: 2026-08-04

## The single feature

Fix `orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh` so it never recreates a
bus task for a pipeline-bypass finding that has already been surfaced — whether the earlier task
for it is still open or has since been closed/resolved/wontfix'd. Repair the dedup guard that's
already (half-)present on disk (see `01-research.md`): it computes an uncapped title scan but
never uses it, and instead uses a `cortextos bus list-tasks --limit 200` call that silently
misses older duplicates once open AUDIT tasks exceed 200 rows — which is exactly what's
happening today (54 open, only 23 visible in the top-200 CLI slice).

## Approach

1. Delete the dead/broken code: the unused `EXISTING_OPEN_TITLES` block that scans `$TASKS_DIR`
   but is never read, and the live-but-broken guard that queries
   `cortextos bus list-tasks --format json --limit 200`.
2. Replace with a single uncapped scan of `$TASKS_DIR/*.json` — read every task file directly,
   collect `.title` with **no `.status` filter** (open or closed both count), build one
   newline-separated set. Reuse the already-correct pattern from the dead block, just actually
   wire it into the guard and drop the status filter.
3. Add a new persistent state file `orgs/clearworksai/agents/larry/state/bypass-audit/seen-findings.jsonl`.
   Compute `FINDING_ID = sha256(<slug>|<kind>|<code>|<sorted evidence joined by ,>)` (first 16
   hex chars) per finding. Load existing `finding_id` values from the file (if present) into a
   second set.
4. Skip (no `create-task`, no feedback-file write) when either: the finding's `TASK_TITLE` is in
   the uncapped title set, OR its `FINDING_ID` is in the persisted hash set.
5. On genuine new-finding creation: write the feedback file (unchanged behavior), call
   `create-task`, then append one line to `seen-findings.jsonl` recording
   `{finding_id, slug, kind, code, title, task_id, first_seen}`.
6. Everything else in the script (audit invocation, Telegram summary page, `FINDINGS=...
   ADVISORIES=...` stdout line) is unchanged.

Exact before/after script text is in `03-specs/01-dedup-fix.md`.

### Git-tracking decision (resolves a real delivery gap, not just the dedup bug)

`orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh` is currently matched by
`.gitignore:17` (`orgs/clearworksai/*`) and has **zero git history** (`git ls-files` /
`git log --all` both empty for this path) — confirmed in `01-research.md`. This is almost
certainly how the prior attempt ended up hand-editing it directly with no PR, no review, no
revert path, which is exactly the anti-pattern this whole feature exists to stop. Since this
script contains real, shared, important logic (creates bus tasks nightly for every agent's
pipeline-bypass findings) it should not remain untracked. Decision: **codexer force-adds this
one file into git** (`git add -f orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh`)
as part of this fix's commit, giving it real PR review and `git revert` capability going
forward, then opens a normal PR exactly like any other src change. This does not change the
`.gitignore` pattern itself (other files under `orgs/clearworksai/*` stay ignored by default) —
only this one file is force-tracked, going forward normal `git add`/`git status` on it behaves
like any other tracked file since git does not re-apply ignore rules to already-tracked paths.

## Files touched (exactly 1 code file + 1 new runtime state file)

| File | Change |
|---|---|
| `orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh` | Remove dead/broken dedup code; add uncapped title scan + persistent finding-hash dedup before every `create-task` call |
| `orgs/clearworksai/agents/larry/state/bypass-audit/seen-findings.jsonl` | New, created at runtime by the script itself (append-only) — not hand-authored, no manual seed data required since the uncapped title scan already covers the entire current 54-task backlog on the very first post-fix run |

No `src/` changes. No schema. No new dependency (uses `shasum`/`sha256sum`, already required
by other agent tooling in this repo — confirm availability in spec, fall back to `openssl
dgst -sha256` if `shasum`/`sha256sum` is unavailable, both are standard on macOS/Linux CI
runners already used elsewhere in this fleet).

## Test plan

No existing automated test harness covers this shell script (`tests/unit/pipeline/bypass-audit.test.ts`
only covers the TS finding-generator). Verify functionally:

1. `bash -n orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh` — syntax check
   passes clean.
2. Dry run against the real, current task store (read-only steps first): confirm the uncapped
   title scan actually enumerates all 54 currently-pending `[AUDIT] Close pipeline bypass: ...`
   titles (spot check with `wc -l` / `grep -c` against the known list from
   `cortextos bus list-tasks --status pending | grep -c "AUDIT.*Close pipeline bypass"`).
3. Run the fixed script once for real. Expect **zero** new `[AUDIT]` tasks created for findings
   that already have an existing task (open or closed) anywhere in `$TASKS_DIR` — i.e. the
   backlog does not grow by even one more duplicate on this first run, unlike the current
   broken guard.
4. Run it again immediately after. Confirm `seen-findings.jsonl` now has entries and a second
   run still creates zero duplicates (both the title-scan layer and the hash layer agree).
5. Manually close one of the 54 existing AUDIT tasks (`cortextos bus complete-task <id>` or
   equivalent), then re-run the script a third time. Confirm it does **not** recreate a task for
   that closed finding (this is the specific behavior that differs from — and improves on — the
   half-fix already on disk, which only checked open statuses).
6. If a genuinely new, previously-unseen finding kind/slug/evidence combination appears (can be
   simulated by temporarily pointing `--output`/inputs at a synthetic report, or just trust the
   next real nightly run), confirm it DOES still create a task — the guard only suppresses exact
   repeats, not new findings.

## Verify commands

```bash
bash -n orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh
```

(No `npm run build` / `npm test` dependency — this is a standalone, gitignored shell script, not
part of the compiled `src/` → `dist/` TypeScript build. Confirm this explicitly in the PR/review
notes so reviewers don't expect CI signal that doesn't exist for this file.)

## Risk

**LOW.** Pure shell-script logic change to an already-broken dedup guard; does not touch
`src/pipeline/bypass-audit.ts` finding-generation logic (proven correct, out of scope), does not
touch the bus/task schema, does not touch any other cron or agent. Failure mode if the fix itself
has a bug is the same failure mode that exists today (duplicate tasks keep appearing) — not a new
or worse failure mode. No destructive operation, no prod data at risk (staging-first protocol
does not apply — this only ever *creates* bus tasks, never deletes/mutates existing ones).

## Rollback

Revert the single commit (`git revert <sha>`) once the change is committed to the repo (note:
today the file itself is gitignored/local-only in `orgs/clearworksai/*`, so the actual rollback
mechanism is restoring the previous on-disk copy of the script from PR history / codexer's diff,
same as any other agent-local runtime script change in this repo).
