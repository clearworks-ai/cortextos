# Session log — 2026-07-03 night: merge wave + Batch A/C redo + the origin root-cause fix

Author: main Claude session (Opus 4.8 1M). Cortext-native record of every decision + action this session,
per Josh: "make sure all our decisions and things you do make it into the cortext native documentation."

Repo of record: **clearworks-ai/cortextos** (Josh's fork). Method: right-sized Workflow swarms
(explore → implement → high-effort adversarial verify), verify-before-merge, one PR each, rebase+reverify per merge.

## ★ ROOT CAUSE FOUND + FIXED — why everything kept landing on upstream
The local clone's **`origin` remote pointed at `grandamenium/cortextos` (UPSTREAM), not the fork.**
```
origin  → grandamenium (UPSTREAM)   ← the trap
fork    → clearworks-ai (Josh's fork = source of truth)
upstream→ grandamenium
```
Every isolated build agent, creating its branch, defaulted to `origin/main` = grandamenium. Proof: PR #50's branch
was literally `origin/main + 1 commit` (247 stray upstream commits); the WS7 #49 agent even logged "origin points at
grandamenium and denied the push." My own merges (#39/#40/#46/#45) were clean only because I explicitly rebased each
onto `fork/main`.
**FIX APPLIED:** `git remote set-url origin <clearworks-ai fork>`; local `main` now tracks `origin/main` = fork.
Standard fork layout (origin = your fork, upstream = original). Every new workflow also gets a base-sanity guard
("git diff --stat origin/main must be small; hundreds of files = wrong base, reset onto origin/main").

## MERGED to fork main this session
| PR | WS | What | Notes |
|----|----|------|------|
| #39 | WS2(partial) | cron banned-prompt validator at write choke point | clean |
| #40 | comms | deterministic ci-alert-gate | rebased onto main, re-verified |
| #46 | comms | source-event identity dedup (one inbound = one ping) | rebased, CI green |
| #45 | P1 | page-based pre-meeting brief + claim-first ATOMIC O_EXCL lease race fix | see D1; #48 closed |
| #50 | WS4 | fleet-reconcile + drift alarms + daemon auto-trigger | base-repaired (was upstream-based), CI green |

Each of #39/#40/#46/#45 conflicted on `src/cli/bus.ts` (all add CLI subcommands) → rebased onto fresh main + re-ran
build+tsc+vitest before merging.

## CLOSED
- #48 — competing #45 fix (mark-before-spawn); inferior (crash → permanent block, non-atomic). Superseded by #45.
- #30 — WS3 handoff-tail; SUPERSEDED (fork already has liveTailBlock via loadBuffer). See D4.
- #49 — WS7; upstream-based + would clobber fork code (6 of 10 ops cmds already fixed on fork). Re-run clean. See D3a.

## DECISIONS
### D1 — #45 race: atomic O_EXCL short-TTL lease, hand-hardened
Race: surfaced-mark is claim-LAST (post-publish); overlapping 15-min cron re-spawns a 2nd worker → duplicate brief.
Did NOT reuse event-dedup.ts (30-day prune floor blocks retry) → dedicated 20-min TTL lease. Adversarial verify found
the stale-reclaim branch was a non-atomic r+ RMW (empirically multiple winners). Final hand-fix: on stale lock, GC it
+ return `stale-cleared`; winning ONLY via atomic O_EXCL → double-win structurally impossible; crash recovery one cron
cycle later. Added skill-structural assertions locking the SKILL claim/release wiring. Lesson:
knowledge-sync/lessons/short-ttl-lease-must-not-share-storage-with-permanent-dedup-ledger.md.

### D2 — Batch A/B/C are REDOS against the fork, not merges
Those batch branches were built on upstream and are DELETED (PRs closed). Only Batch D (commitment-mining) reached the
fork (#44). Redo each workstream isolated against fork/main (broad refactors batched = the ~80-file conflict bombs).

### D3 — Redo order (Josh delegated to me): WS7, WS4, WS6, WS12, WS2 (WS2 last, warn-only — high blast radius).

### D3a — WS7 re-run clean (not ported)
The fork is FURTHER ALONG than upstream: restart/start/stop/doctor/enable-agent/notify-agent ALREADY route through
resolveInstanceId with no hardcoded default. Only add-agent/import-agent/dashboard/tunnel still need it, and the marker
resolver (resolve-active-instance.ts) is missing + resolve-instance-id.ts needs the marker wired. Porting #49's
upstream-based commits would clobber fork code, so WS7 was re-launched fresh against fork/main with that exact gap list.

### D4 — WS3 (#30) SUPERSEDED → closed
fork/main already injects the conversation-buffer tail via buildResumeContextBlocks() → liveTailBlock (loadBuffer),
more complete than #30's inline slice(-10). Certainty check paid off — nearly merged inferior duplicate. Lesson: grep
the actual symbol (`liveTail`), not the English description ("buffer tail").

## RUNNING (as of this checkpoint)
- WS6 context-diet (isolated) — MEMORY.md size-lint + no-fact-loss trim (already relocating index detail into topic files).
- WS12 scope-guard (isolated) — real-time SCOPE_GUARD checker (prevents 80-file conflict bombs).
- WS7-clean (isolated, fork-based) — the minimal marker + 4-command fix.

## QUEUED / DEFERRED
- WS2 verify-receipts — build WARN-ONLY (log completion-claims lacking a verification receipt at the send-telegram
  choke point; NEVER block). High blast radius (all outbound comms) → warn-only until Josh rules on a blocking gate.

## PROD-OPS still Josh-gated (do NOT auto-run)
- WS7 instance CUTOVER (write ACTIVE_INSTANCE marker on Josh's machine + hot-state backup + archive dead `default`).
  #49/WS7-clean is code-only; the cutover is separate.
- WS5 Clearpath export + re-embed (~2,700 gold rows), staging-first.

## NOT DONE / left alone
- Old June fork PRs (#24 HUD, #19, #18, #17, #16, #8, #4) — predate the 303-commit divergence; unsafe to merge blind.
- Upstream PR #720 (batchD) still shows OPEN on grandamenium though commitment-mining merged on the fork as #44 — cosmetic.
