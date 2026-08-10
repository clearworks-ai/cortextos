# HANDOFF — v9 finish goal-loop (PAUSED 2026-08-10 ~13:55 PDT, low credits)

Durable /goal loop driving the v9 finish plan with subagents. Paused to save credits. Everything
below is grounded. Governing docs: `state/specs/v9-finish-GOAL-2026-08-09.md` (has PROGRESS +
STAGING-RECEIPT GATE blocks — read first), `state/specs/v9-finish-spec-2026-08-09.md`,
`state/FINISH-PLAN-v9-2026-08-09.md`.

## FLEET SAFE
Prod daemon `cortextos-daemon` (pm2) online, untouched all session. No stray staging daemon.
Nothing merged, no daemon restart, no prod agent-dir mutation.

## PRs OPEN on `clearworks-ai/cortextos` (NONE merged — your gate)
- **#328** Track A — deterministic meeting-writeback spawn (FR-A1). commits 933279dc backbone +
  20704fa6 path-fix (hardcoded `/agents/frank2`→running-agent dir via `CTX_AGENT_DIR`; caught real
  bug: frank2 dir has no ff-extractor.py). **STAGING-PROVEN** (spawn guard + FF_MEETING_ID env, pos+neg).
- **#329** CRM1 — enrichment/records/pipeline-ops as SKILLs under crm on events. no src. tests green.
  Apply seams flagged in `orgs/clearworksai/skills/CRM1-WIRING.md` (crm-codex bare template + cron paths).
- **#330** A6 — commitment triple-sink (bus human-task + approval card + BRIEFS + Telegram, idempotent
  by one commitment id). 6 unit tests + local idempotency proven. **STAGING RECEIPT ESSENTIALLY PROVEN**
  (runner killed pre-write: RUN1 both SURFACE→2 human tasks+1 approval card, RUN2 both SKIP→0 dups) —
  receipt FILE not yet written to `state/staging-receipts/`.
- **#331** G — full-fleet deliverables fold-in. Router was hardcoded to 5 legacy agents, skipped
  `-codex` (auditmaster-codex=846 files). Now 1730/1747 routed, 0 unmapped. Manifest committed. Apply
  plan `APPLY-PLAN-fullfleet-2026-08-10.md`. Dry-run: 290 new/1431 skip/9 conflict/0 prod-writes. LOW-RISK
  (read-only+manifest) → NO staging receipt needed.
- **#332** F — 3 P2 jobs (Meeting Follow-Ups, Pre-Call Briefing, Status Updates) wired to live triggers
  + real-path output + bus row. no src. 13 contract tests green. Caught real bug: multi-colon dedup keys
  fail OPEN (`SOURCE_KEY_PATTERN` allows one colon) → switched to single-colon dotted ids. Runbook
  `orgs/clearworksai/skills/F-P2-JOBS-WIRING.md`.

## STAGING-RECEIPT GATE (Josh 2026-08-10 — HARD, now in the GOAL condition) — ALL RECEIPTS DONE
No lane merges until it has a REAL receipt on the isolated `cortextos-staging` daemon. Data-touching
lanes = A6, F, CRM1. Low-risk exempt (fixture/local) = S1, G. A already staging-proven.
Staging receipts captured 2026-08-10 (via codex-rescue; staging daemon torn down after; prod 0 restarts):
- **A6 — PASS** #330 commit 8fb09ea1. staging `[human]` task `task_1786395958246_37243539`, key
  `commitment:ff_staging_test_2026_08_10_abc123`; run1 SURFACE → run2 SKIP (0 dup). Receipt
  `state/staging-receipts/a6-2026-08-10.md`.
- **CRM1 — PASS** #329 commit 34a19867. staging task `task_1786395980256_17171940` (needs-approval),
  key `crm-pipeline:staging-deal-001.20260810`; SURFACE→SKIP. **SEAM:** `CRM1-WIRING.md` example keys
  use colons in the compound id (`crm-pipeline:<deal>:<date>`) which the CLI rejects — must be dots
  (`.<date>`). One-line doc fix needed before apply (same class as F's fixed bug).
- **F — PASS** #332 commit 18c80054. staging task `task_1786395963596_33314825` (needs-approval), key
  `followup-recap:kadre.2026-08-10`; SURFACE→SKIP (single-colon constraint validated). **SEAM:** the
  real-path output file (`outputs/followups/*.md`) needs live Fireflies+OpenRouter creds — staging
  proved the BUS-SINK half; the output write is covered by `tests/test_f_p2_jobs_wiring.py`. Real
  output receipt comes at the prod live-verify step.
Staging gotchas (critical): pin `CTX_INSTANCE_ID=cortextos-staging CTX_ROOT=~/.cortextos/cortextos-staging
CTX_FRAMEWORK_ROOT=~/.cortextos/cortextos-staging-fw CTX_ORG=clearworksai` on EVERY cli/daemon call
(bare call resolves PROD cortextos1 — INSTANCE MARKER DRIFT). Launch staging daemon from
`/tmp/track-a-build/dist/daemon.js` with cwd=FW_ROOT. See
`memory/reference_spawn_worker_dir_guard_requires_cwd_2026-08-10.md`.

## IN-FLIGHT WHEN PAUSED (worktrees persist on /tmp)
- **S1** (5-stack coherence) — KILLED mid-run, was running fixture coherence + scoping gate. No PR yet.
  worktree `/tmp/s1-solution-design`, branch `larry/s1-solution-design-5stack`. RESUME: finish coherence
  check on 2 fixtures, open PR. (S1 is fixture-only, no staging receipt needed.)
- **staging-receipt runner** — KILLED after proving A6, before CRM1/F receipts + before writing any
  receipt file. worktrees: A6 `/tmp/a6-triple-sink`, CRM1 `/tmp/crm1-cluster`, Track A dist `/tmp/track-a-build`.

## REMAINING TRACKS (gated on prod-promote = your daemon-restart approval)
- **E** (gsuite-first: Gmail push→comms-check→EA, then slack/omi/pr) — needs A live in prod. NOT started.
- **D** (retire 11 poll crons) — needs A+E live.
- **H** (weekly-review upgrade) — needs A+CRM live. last.

## RESUME NEXT SESSION (order)
1. Finish staging receipts: A6 (write file), CRM1, F → push to their PRs. (re-dispatch the receipt runner.)
2. Finish S1 → PR.
3. THEN your gates to unblock E/D/H:
   a. Merge #328-332 (after receipts PASS).
   b. Prod-promote Track A: `touch /tmp/josh-approved-daemon-restart-$(date +%Y%m%d%H)` → rebuild+deploy
      dist (933279dc) → `pm2 restart cortextos-daemon` → **rm the override immediately**.
   c. Live-verify A: 1 real fireflies meeting → filed `knowledge/meetings/*.md` + client writeback +
      ledger + `EVENT crm.meeting.completed`.
   d. Apply CRM1/F/G runbooks to prod agent dirs (commands in each WIRING/APPLY doc) + capture receipts.
   e. Then build E (gsuite), then D, then H.

## OPEN HUMAN GATES
- gh token: RE-AUTHED this session (clearworks-ai, ADMIN, repo+workflow) — push/PR work. (stale 401
  notes in subagent reports are wrong.)
- fork #172 merge (P7 re-baseline) — still open.
- All prod-promotes (daemon restart) need your explicit approval per envelope "build+PR+staging, halt at prod".

## COMMITTED THIS SESSION (branch larry/goal-durable-runner)
- 6b623cef fix(staging): Track A FR-A1 validatable on staging (cwd=FW_ROOT + skill stub + pkg marker).
- GOAL condition updated (PROGRESS + STAGING-RECEIPT GATE) — uncommitted in working tree, commit on resume.
