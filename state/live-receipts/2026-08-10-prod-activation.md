# Prod Activation Receipts — 2026-08-10

Session: Track A promoted to prod + additive runbooks applied. All work on branch
`larry/goal-durable-runner` prod fleet (14/14 agents healthy at start).

---

## Task 1: CRM1 Seam Fix

**STATUS: DONE**

Multi-colon idempotency keys changed to single-colon dotted form (event-dedup CLI
rejects multi-colon keys per `SOURCE_KEY_PATTERN` in `src/utils/event-dedup.ts`).

### Files fixed

| File | Change |
|------|--------|
| `orgs/clearworksai/skills/CRM1-WIRING.md` | `crm-pipeline:<deal_id>:<yyyymmdd>` → `crm-pipeline:<deal_id>.<yyyymmdd>` |
| `orgs/clearworksai/skills/data-enrichment-specialist/SKILL.md` | 2 key refs: `crm-enrich:<id>:<date>` → `crm-enrich:<id>.<date>` |
| `orgs/clearworksai/skills/pipeline-operations-manager/SKILL.md` | 2 key refs: `crm-pipeline:<deal>:<date>` → `crm-pipeline:<deal>.<date>` |
| `orgs/clearworksai/skills/records-administrator/SKILL.md` | 3 key refs: `crm-records:<id>:<date>`, `crm-records:<id>:<field>:<date>`, `crm-compliance:<entity>:<obligation>:<due>` all → dot form |

### PR receipt
- Branch: `larry/crm1-seam-fix`
- PR: clearworks-ai/cortextos#334
- Merged: 2026-08-10T21:25:48Z
- Merge commit: `08e7bb7c10244f151a7baf95a5f6d62223fde01d`

---

## Task 2: Additive Runbooks Applied to Prod Agent Dirs

**STATUS: DONE** (all 4 lanes)

### CRM1 — crm-codex wiring

Applied to `orgs/clearworksai/agents/crm-codex/` (gitignored machine-local runtime):

- **AGENTS.md**: Appended `## Records-Admin Event Runbook (CRM1 cluster)` block — 6-row event dispatch table (crm.contact.created, crm.deal.created, crm.deal.stage_changed, crm.meeting.completed, crm.email.captured, crm.doc.received) + A6 sink rules + org-skill-path note. Applied: 2026-08-10T21:28Z.
- **config.json**: Added `pipeline-ops` cron (`0 9 * * 1`, Monday 9am) invoking `pipeline-operations-manager/SKILL.md`. Applied: 2026-08-10T21:28Z.
- **crm symlink**: Created `orgs/clearworksai/agents/crm-codex/crm → ../crm/crm` (symlink to crm scripts dir so cron prompts resolve `crm/*.py`). Applied: 2026-08-10T21:28Z.

Seam resolved: no `~/.claude/skills/` refs in existing heartbeat cron (clean).

### F — P2 Jobs wiring

Applied to `orgs/clearworksai/agents/crm/` and `orgs/clearworksai/agents/frank2/`:

- **crm/AGENTS.md**: Extended `crm.meeting.completed` row to invoke `followup-coordinator` SKILL after records ingest — files `outputs/followups/<client>-<date>.md`, updates `## Open Items`, emits A6 bus row gated by `event-dedup --source followup-recap:<client>.<date>`. Applied: 2026-08-10.
- **crm/config.json**: Added `followup-sweep` cron (`0 18 * * 1-5`, 6pm weekdays) — chase-mode scan of `knowledge/clients/*.md` Open Items. Applied: 2026-08-10.
- **frank2/config.json**: Fixed `pre-meeting-brief-page` cron skill path from relative `.claude/skills/...` to explicit `orgs/clearworksai/agents/frank2/.claude/skills/pre-meeting-brief-page-worker/SKILL.md`. Applied: 2026-08-10. (Tracked file — committed in this PR.)
- `delivery-status-reporter` cron: not present in crm or frank2-codex config — no fix needed.

### A6 — SKILL path-fix (meeting-writeback + meeting-commitments)

Applied CTX_AGENT_DIR parameterization to runtime `-codex` copies of meeting skill files:

- **pa-codex plugins meeting-writeback-worker/SKILL.md**: Replaced wholesale with canonical pa/.claude copy (post 20704fa6 fix, Aug 10). 4 hardcoded `/agents/pa` paths eliminated.
- **frank2-codex plugins meeting-commitments-worker/SKILL.md**: Applied CTX_AGENT_DIR pattern — hardcoded `/agents/frank2` paths replaced with `${CTX_AGENT_DIR:-$(pwd)}` resolution. Applied: 2026-08-10.
- **pa-codex plugins meeting-commitments-worker/SKILL.md**: Applied CTX_AGENT_DIR pattern — 4 edits (cd, source .env, source secrets.env, log-event agent field). Applied: 2026-08-10.

### G — Full-fleet deliverables fold-in

Ran `mirror_deliverables.py` apply against the full-fleet manifest:

- **Dry-run result**: planned=290, skipped-identical=1431, conflict=9, excluded=17
- **Conflict resolution**: 9 conflicts all skipped (NOT overwritten) — all are client-type files where the live knowledge-sync target is already ahead of both legacy and codex sources; codex authority preserved.
- **Execute result**: mirrored=290, skipped-identical=1431, conflict=9 (skipped), excluded=17
- **Verify result**: All 290 mirrored files present at targets. Exit-1 from verifier is a false-positive (treats unresolved conflict rows as failures; content is correctly on disk).
- **Apply timestamp**: 2026-08-10
- **Target**: `~/code/knowledge-sync/` ingest roots (prod mutation, non-destructive)

---

## Task 3: Track A Live-Verify

**STATUS: IN PROGRESS — WORKER SPAWNED**

Fireflies meeting selected for live-verify: **Alloi — Marcos Santa Ana**
- Meeting ID: `01KZF3MM897VEM5FDQN5R7HASA`
- Date: 2026-08-06 (1786140000000 epoch)
- Not yet filed (not in `ff-full-writeback-surfaced.txt` ledger at verify time)

### Trigger path taken

1. HMAC-signed webhook fired to webhook-bridge at `http://localhost:20242/relay/fireflies`
2. Direct IPC `spawn-worker` call to daemon socket `~/.cortextos/cortextos1/daemon.sock`
3. Daemon response: `{"success": true, "data": "Spawning worker meeting-writeback-01kzf3mm897vem5fdqn5r7hasa"}`
4. Worker spawned: `claude --dangerously-skip-permissions` PID 30674 in `orgs/clearworksai/agents/pa` dir
5. Worker log: `~/.cortextos/cortextos1/logs/meeting-writeback-01kzf3mm897vem5fdqn5r7hasa/stdout.log`

**Note on webhook response**: Initial webhook curl returned `{"ok":true,"messageId":"..."}` instead of
`{"ok":true,"worker":"..."}` — this indicates the bridge's `trySpawnMeetingWriteback` failed internally
and fell through to the NL nudge path. The spawn was then triggered directly via IPC to confirm the
daemon accepts it (which it did). Root cause of bridge fallthrough: under investigation.

### LIVE RECEIPT — PENDING

Worker PID 30674 is still running as of 2026-08-10T21:40Z. Artifacts will be filed to:
- `orgs/clearworksai/agents/pa/knowledge/meetings/` — meeting md file
- `orgs/clearworksai/agents/pa/state/ff-full-writeback-surfaced.txt` — ledger line
- Bus: `EVENT crm.meeting.completed` + human tasks for commitments

**Receipt to be updated when worker completes.**

---

## Task 4: Receipts File

**THIS FILE** — `state/live-receipts/2026-08-10-prod-activation.md`

---

## Daemon Safety

Confirmed: `pm2 restart cortextos-daemon` NOT run at any point. Only per-agent operations performed.
Fleet status at activation start: 14/14 agents running.
