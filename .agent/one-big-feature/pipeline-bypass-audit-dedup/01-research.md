# 01 — Research: pipeline-bypass-audit-dedup

Slug: `pipeline-bypass-audit-dedup`
Origin: Josh/larry task — nightly `pipeline-bypass-audit.sh` recreates the same `[AUDIT]` bus
task for the same historical finding every single run, forever.
Date: 2026-08-04

## Problem, confirmed live

`orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh` runs nightly. It shells out to
`src/pipeline/bypass-audit.ts` (`runBypassAudit()`, ~1044 lines, see below), gets back an
`AuditReport.bypasses[]` array, and for every finding calls `cortextos bus create-task` with
title `[AUDIT] Close pipeline bypass: <slug> (<check-type>)`.

Live check (2026-08-04): `cortextos bus list-tasks --status pending | grep -c "AUDIT.*Close
pipeline bypass"` → **54**. Total task store: 2168 tasks, 361 open. The same finding (e.g. the
single `unknown (dispatch-no-slug)` finding) has been recreating a fresh task night after night
for weeks — confirmed in the related, separately-tracked backlog task
(`task_1785663323928`, out of scope here) which found 135 of 303 pending Multica-sync
candidates were duplicate AUDIT tasks, 107 of those the single `unknown (dispatch-no-slug)`
finding alone.

`src/pipeline/bypass-audit.ts` itself is pure: it only *produces* `AuditFinding[]`
(kinds: `dispatch-no-chain`, `dispatch-no-slug`, `pr-no-chain`, `pr-no-slug`, `push-no-chain`,
`push-no-slug`, `bus-store-bypass`, `hole3-no-spawn`, `hole3-no-artifact`,
`hole3-deep-authorship`, `hole3-structure`, `hole3-hand-authoring`) and optionally writes a
JSON snapshot to `--output`. It never calls `cortextos bus create-task` — that call site lives
entirely in the shell wrapper. **Do not touch `src/pipeline/bypass-audit.ts` — the findings
themselves are correct, this is purely a task-creation dedup bug in the shell script.**

## Important: this exact slug was already attempted once, improperly, and is unfinished

This is not a fresh task — a prior session already tried to fix this exact bug, hit real
pipeline gates as a result, and never shipped. Evidence, all discovered live during this
research pass:

1. **`orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh` is gitignored**
   (`.gitignore:17` → `orgs/clearworksai/*`) and was hand-edited on disk **2026-08-03 23:56:38**
   (confirmed via `stat`). `git status`/`git log` show nothing for this file — it has no git
   history at all; it's pure local runtime state, edited directly.
2. That hand-edit added a **partial, broken dedup fix** — currently live on disk right now:
   - Lines ~30-36 build `EXISTING_OPEN_TITLES` by scanning `$TASKS_DIR/*.json` directly (the
     correct uncapped approach) — **but this variable is never read again anywhere in the
     script.** Dead code.
   - The actual guard used before `create-task` (lines ~53-59) instead calls
     `cortextos bus list-tasks --format json --limit 200` and greps for a title match among
     `pending`/`in_progress`/`blocked`/`waiting` statuses only.
   - **This is why duplicates are still being created despite the fix attempt.** Verified live:
     the task store has 2168 total tasks; `cortextos bus list-tasks --format json --limit 200`
     surfaces only **23** `[AUDIT]` titles among its most-recent 200 rows, while **54** are
     actually pending. The `--limit 200` cap silently hides older-but-still-open duplicates from
     the check, so the guard passes (no match found) and a fresh duplicate gets created anyway.
3. The bypass-audit system caught this hand-edit as a violation of its own gates — two separate
   findings, both for slug `pipeline-bypass-audit-dedup`, sitting as memory feedback files and
   live bus tasks right now:
   - `orgs/clearworksai/agents/larry/memory/feedback_pipeline_bypass_2026-08-03_pipeline-bypass-audit-dedup_138.md`
     — kind `hole3-hand-authoring`: "Larry parent transcript directly wrote planning bytes for
     pipeline-bypass-audit-dedup before provenance row plan" (ledger ts 1785788026).
   - `task_1785838179459_61223636` (pending, live in the bus right now) — `[AUDIT] Close
     pipeline bypass: pipeline-bypass-audit-dedup (dispatch-no-chain)`, detail "No ledger rows
     for slug 'pipeline-bypass-audit-dedup'" — i.e. a GATE build was dispatched for this exact
     slug without ever signing a valid research→plan→specs chain first.
   - `task_1785788047451_56014846` — `"Epic: pipeline-bypass-audit-dedup"`, pending, created
     2026-08-03T20:14:07Z, description `"framework=one-big-feature repo=...
     (auto-opened at codexer/opencoder dispatch)"` — proof a GATE dispatch fired for this slug
     the same day, but no `.agent/one-big-feature/pipeline-bypass-audit-dedup/` directory exists
     on disk, no PR exists (`gh pr list --search "bypass-audit-dedup"` → empty), and the
     `state/pipeline-ledger.json[l]` has **zero** rows for this slug. The dispatch never
     completed a real build.
   - `.codex-handoff/pipeline-bypass-audit-dedup.md` (mtime 2026-08-03 13:13, gitignored, not
     part of the OBF flow) contains a full hand-written implementation spec for essentially this
     same fix — this is almost certainly what got hand-authored directly instead of going
     through `bin/pipeline-stage-emit`, triggering the `hole3-hand-authoring` finding above.
   - A `pipeline-bypass-audit-dedup` git branch exists but carries no unique commits for this
     fix (its head commits are unrelated `kb-reconcile` work) — a stale/reused branch name, not
     a real prior attempt at this code.

**Conclusion:** the prior attempt correctly diagnosed the bug and even landed a half-fix, but
did it out-of-process (hand-edited the script directly, GATE-dispatched without a signed chain),
so it (a) never actually fixed the bug — the guard it added is dead/broken — and (b) is itself
now flagged as two more entries in the exact backlog this feature is meant to stop growing. This
OBF run redoes the work through the proper research→plan→specs→signed-dispatch flow so the
dispatch this time has a valid chain and won't self-flag.

## Design decision: dedup identity and where state lives

Task instructions ask for a "stable, deterministic identity... check whether a task with that
identity already exists (open **or already resolved/closed**)". This is a materially different
(better) requirement than what the prior half-fix implemented (title match against **open**
tasks only, via a capped CLI call). Closing/triaging a finding as wontfix must permanently
suppress it — Josh's stated intent per the sibling batch-triage task is "triaged once."

Decided approach (justification):

1. **Primary identity: `TASK_TITLE`** (`[AUDIT] Close pipeline bypass: <slug> (<kind>)`), same
   string already used today — no format break, still human-readable in the bus UI.
2. **Membership check: full, uncapped scan of `$TASKS_DIR/*.json`, no status filter.** This
   fixes the exact bug in the current broken guard (the `--limit 200` CLI cap) by reading the
   task-store files directly, and satisfies "open or closed" by simply not filtering on
   `.status` at all — a title match in *any* task record, regardless of status, blocks
   recreation. This reuses/repairs the dead `EXISTING_OPEN_TITLES`-style scan that's already
   sitting unused in the script today (rename it, drop the status filter, actually use it).
3. **Secondary, persistent identity: `FINDING_ID = sha256(slug|kind|code|sorted(evidence))`
   truncated to 16 hex chars**, recorded in a new append-only local state file
   `orgs/clearworksai/agents/larry/state/bypass-audit/seen-findings.jsonl` (one JSON line per
   finding ever surfaced: `{finding_id, slug, kind, code, title, task_id, first_seen}`). This is
   the layer the task prompt explicitly asked for ("hash of slug + stage + check-type +
   evidence-path"), and it's what makes suppression durable even if a task is later deleted from
   the bus store entirely (title-scan alone wouldn't survive that). It also disambiguates the
   rare case where two distinct findings for the same slug produce the same `(slug, kind)` title
   (e.g. two different `hole3-hand-authoring` findings on different stages) — evidence differs,
   so the hash differs, and the newer one is correctly treated as new.
4. **A finding is skipped (no task, no feedback file) iff `TASK_TITLE` is already present in the
   uncapped task-store title scan OR `FINDING_ID` is already present in
   `seen-findings.jsonl`.** Either match is sufficient to suppress — this is the union of both
   layers, so a fresh install of the state file doesn't cause one more round of duplicates
   before catching up (the title scan alone catches the current 54-strong backlog on the very
   first post-fix run), and losing/rotating the state file doesn't reopen anything already
   visible in the live task store.
5. On a genuine new task creation, append one line to `seen-findings.jsonl` **after** the
   `create-task` call succeeds, capturing the returned task id.

This lives entirely in the shell script — no changes to `src/pipeline/bypass-audit.ts`, no new
CLI flags, no schema.

## Files this touches

- `orgs/clearworksai/agents/larry/scripts/pipeline-bypass-audit.sh` — the only file with real
  logic changes. (Gitignored/local, same as its current state — no repo tracking issue, this is
  intentional per-agent runtime config, same pattern as e.g. `crons.json`.)
- New (created at runtime by the fixed script, not authored by hand): `orgs/clearworksai/agents/larry/state/bypass-audit/seen-findings.jsonl`.

## Verified source facts

- Current live script content read in full 2026-08-04 (108 lines) — reproduced/cited above by
  line range; the broken/dead dedup code is real and present right now, not hypothetical.
- `src/pipeline/bypass-audit.ts` `AuditFinding` shape confirmed: `{ kind, slug?, code?, detail,
  evidence: string[] }` (lines 34-52) — `evidence` is always an array of strings, safe to
  `sort().join(',')` for hashing.
- `TASKS_DIR="${CTX_ROOT_REAL}/orgs/${ORG}/tasks"` already computed in the current script
  (line 12) — the uncapped scan target already exists as a shell variable, just needs to be
  used correctly.
- No test harness exists for this shell script today (`tests/unit/pipeline/bypass-audit.test.ts`
  only covers the TS finding-generator, confirmed by reading the test file directory listing).
  Verification must be manual/functional (documented in master-plan test plan), consistent with
  how the prior, adjacent CI-timebomb fix for this same script (PR #107,
  `fix(ci): kill both wall-clock time-bombs (bypass-audit + bus-list-health)`) was verified.
