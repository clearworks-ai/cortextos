# Session log — 2026-07-03 night: merge wave + Batch A/C redo

Author: main Claude session (Opus 4.8 1M). This file is the cortext-native record of every
decision and action taken this session, per Josh's instruction "make sure all our decisions and
things you do make it into the cortext native documentation of what's happening."

Repo of record: **clearworks-ai/cortextos** (Josh's fork). `main` = fork main.
Method: right-sized Workflow swarms (explore → implement → adversarial verify with high-effort
Opus verifiers), verify-before-merge, one PR each, rebase-and-reverify on every merge.

## Josh's directives this session
1. "start the proper workflow work with the right models and merge everything you can."
2. "what do we do with batch a and c — lets fix and whats next." → then: "you decide."
3. "finish all these things, and pause with auto-resume when you hit the 5-hour limit. go."
4. "make sure all our decisions and things you do make it into the cortext native documentation."

## MERGED to fork main this session
| PR | Workstream | What | Notes |
|----|-----------|------|-------|
| #39 | WS2 (partial) | cron banned-prompt validator at the write choke point | clean |
| #40 | comms | deterministic ci-alert-gate (kills stale CI false positives) | rebased onto main (bus.ts conflict), re-verified |
| #46 | WS-comms | source-event identity dedup — one inbound event = at most one ping | rebased, CI green |
| #45 | P1 pre-meeting brief | page-based tokened brief + **claim-first atomic lease** race fix | see decision D1 |

Every one of #39/#40/#46/#45 conflicted on `src/cli/bus.ts` after the prior merge (all add CLI
subcommands there). Resolved by rebasing each branch onto the freshly-updated main and re-running
`npm run build` + `npx tsc --noEmit` + `npx vitest run tests/unit` before merging. This is the
predicted "broad edits to one hub file serialize" cost — handled by sequential rebase, not batching.

## DECISIONS

### D1 — #45 duplicate-worker race: atomic O_EXCL lease, NOT mark-before-spawn
- Confirmed race: the surfaced-mark is claim-LAST (worker SKILL Step 8, only after a multi-minute
  verified publish). An overlapping 15-min cron fire re-spawns a second worker → duplicate brief +
  duplicate Telegram link.
- Two competing fixes existed:
  - **PR #48** (older workflow `woeh6h5sy`): mark-surfaced-BEFORE-spawn, clear-on-failure. Rejected:
    a mid-flight crash between mark and clear permanently blocks the event (no TTL), and mark/clear
    on the shared surfaced store is a non-atomic read-modify-write. **Closed #48 in favor of #45.**
  - **PR #45 branch** (workflow `wxylvnofo`): dedicated SHORT-TTL (20 min) claim lease, atomic
    across processes via per-event O_EXCL lockfile. Chosen.
- **Did NOT reuse `src/utils/event-dedup.ts`** (the #46 ledger): its `pruneLedger` enforces a 30-day
  minimum retention floor, which would permanently block retry after a failed publish. A claim lease
  needs a ~20-min TTL. Lesson written:
  `knowledge-sync/lessons/short-ttl-lease-must-not-share-storage-with-permanent-dedup-ledger.md`.
- **Adversarial verifiers caught a residual race** in the stale-reclaim branch: it used
  `openSync(lockPath, 'r+')` + last-writer-wins (non-atomic), and one verifier empirically produced
  multiple winners (3/15 forked-process trials). Even the verifiers' suggested "unlink then recreate"
  fix has a 3-way boundary race (racer B can unlink racer A's *fresh* lock).
- **Final fix (this session, hand-applied):** on a stale lock, GC it (`unlink`) and return
  `stale-cleared` WITHOUT reclaiming in-band. Winning now happens ONLY through the atomic O_EXCL
  fast path, so a double-win is structurally impossible. Crash recovery lands one cron cycle later
  (~15 min) — the deliberate tradeoff for a hard no-duplicate guarantee. Added a
  `stale-clear-never-double-wins` test and skill-structural assertions locking the SKILL's
  claim-before-publish / release-on-failure / mark+release-on-success wiring so a future edit can't
  silently reopen the race (the load-bearing guard lives in the SKILL, not just the code).

### D2 — Batch A/C reframe: they are REDOS against the fork, not merges
- The A/B/C batch branches (`wf/batchA-reliability`, `wf/batchB-knowledge-crm`,
  `wf/batchC-context-instance`) were built on **upstream (grandamenium)**, and their PRs
  (#717/#718/#719) are **CLOSED, not merged — branches deleted**. Only Batch D (commitment-mining)
  was re-created on the fork and merged (#44). Upstream `main` is 303 commits diverged from the fork.
- Therefore "fixing Batch A/C" = **redoing each workstream against fork main**, and the broad ones
  must be built **in isolation** (root-cause lesson: broad refactors batched together = the ~80-file
  conflict bombs that killed #718/#719's WS4/WS6/WS12).

### D3 — Redo order (Josh delegated the call to me)
Chosen order and rationale:
1. **WS7** instance-canonical — small, clean, high value (fixes the dead-`default` trap). **Running/landed → PR #49 (needs a follow-up fix, see A-items).**
2. **WS4** fleet-reconcile + drift alarms — reliability (catches silent non-restart like the sage incident). Running.
3. **WS6** context-diet — MEMORY.md is 403 lines / 64 KB (active bloat). Queued.
4. **WS2** verify-receipts / claim-gate remainder — certainty. Queued.
5. **WS12** scope-guard coding agent — the meta-fix that prevents future conflict bombs. Queued.
- Isolation: each redo runs as its own worktree-isolated Workflow, opens exactly ONE fork PR, and is
  merged only after a high-effort adversarial verifier returns ship + a green local re-run.

### D4 — WS3 handoff-tail (PR #30) is SUPERSEDED → CLOSED
- CORRECTION: an initial grep for "buffer tail" missed it, but a proper check of the rebase conflict
  showed fork main ALREADY injects the conversation-buffer tail via `buildResumeContextBlocks()` →
  `liveTailBlock` (using `loadBuffer()` from `conversation-buffer.js`), merged with #685/#699. Main's
  version is MORE complete than #30's inline `conversation-buffer.jsonl` `slice(-10)` read (structured
  loadBuffer + mission-anchor integration + "newest inbound message is authoritative" framing).
- **Action taken: CLOSED #30 as redundant.** WS3's goal is already met on main. (Certainty check paid
  off — nearly merged inferior duplicate code. Lesson: grep the ACTUAL symbol names, not the English
  description — main called it `liveTail`, not "buffer tail".)

## OPEN A-ITEMS (must finish)
- **A1 — WS7 #49 follow-up (major):** ~10 CLI commands (`restart.ts`, `start.ts`, `stop.ts`,
  `doctor.ts`, `enable-agent.ts`, `add-agent.ts`, `notify-agent.ts`) still use commander
  `.option('--instance <id>', 'Instance ID', 'default')`. Commander fills the literal `'default'`
  when omitted, so `options.instance` is never undefined and the marker is BYPASSED — meaning the
  headline symptom (`cortextos restart <agent>` returns "Daemon is not running" unless
  `--instance cortextos1`) is NOT fixed by #49 as-is. Fix: drop the hardcoded `'default'` commander
  default and route each through the marker-aware resolver. Do NOT merge #49 until this is done.
- **A2 — WS3 #30:** ✅ DONE — closed as superseded (main already has liveTailBlock). See D4.
- **A3 — WS4:** merge when the workflow lands + verifier says ship (guard against 80-file over-reach
  and the missing daemon auto-trigger that killed the last attempt).
- **A4 — WS6 / WS2 / WS12:** run isolated workflows, verify, merge.

## PROD-OPS still Josh-gated (do NOT auto-run)
- WS7 instance CUTOVER (write the ACTIVE_INSTANCE marker on Josh's machine, hot-state backup, archive
  the dead `default` root). #49 is code-only; the cutover is separate.
- WS5 Clearpath export + re-embed (~2,700 gold rows) — pre-approved, staging-first, after PR merges.

## NOT DONE / left alone (out of scope, risky)
- Old June fork PRs (#24 HUD, #19, #18, #17, #16, #8, #4) — predate the 303-commit divergence;
  merging blind is unsafe. Left untouched.
- Upstream PR #720 (batchD) still shows OPEN on grandamenium though commitment-mining merged on the
  fork as #44 — cosmetic upstream cleanup, not blocking.
