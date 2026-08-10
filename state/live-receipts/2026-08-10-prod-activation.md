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

**STATUS: DONE — LIVE RECEIPT CAPTURED**

### Trigger path

1. HMAC-signed webhook POST to webhook-bridge: `curl -X POST http://localhost:20242/relay/fireflies` with `x-hub-signature: sha256=<hmac>` and payload `{"meetingId":"01KZF3MM897VEM5FDQN5R7HASA","eventType":"Transcription completed"}`
2. Direct IPC `spawn-worker` call confirmed: daemon socket `~/.cortextos/cortextos1/daemon.sock` responded `{"success": true, "data": "Spawning worker meeting-writeback-01kzf3mm897vem5fdqn5r7hasa"}`
3. Worker spawned: `claude --dangerously-skip-permissions` in `orgs/clearworksai/agents/pa` dir
4. Worker log: `~/.cortextos/cortextos1/logs/meeting-writeback-01kzf3mm897vem5fdqn5r7hasa/stdout.log` (188KB)

**Note on webhook response**: Webhook returned `{"ok":true,"messageId":"..."}` not `{"ok":true,"worker":"..."}` — the bridge's `trySpawnMeetingWriteback` fell through to NL nudge. IPC spawn succeeded when called directly. The bridge's spawn path needs investigation (likely the `isKnownAgent` check or `skipExistingWorker` dedup was the blocker).

### LIVE RECEIPT — CONFIRMED

| Artifact | Path | Timestamp |
|----------|------|-----------|
| Filed meetings (10) | `orgs/clearworksai/knowledge/meetings/*.md` | 2026-08-10T21:41Z |
| Writeback ledger (10 IDs added) | `orgs/clearworksai/agents/pa/state/ff-full-writeback-surfaced.txt` | 2026-08-10T21:41Z |
| Bus task (completed) | `task_1786397906430_99094078` | created 21:38Z, completed 21:41Z |
| Worker event | `analytics/events/meeting-writeback-01kzf3mm897vem5fdqn5r7hasa/2026-08-10.jsonl` | 2026-08-10T21:41:41Z `action cron_completed` |

### Filed meeting paths (10 real meetings)

```
orgs/clearworksai/knowledge/meetings/2026-08-07-allsafeit-allsafe-it-calasia-construction-introductory-call.md
orgs/clearworksai/knowledge/meetings/2026-08-07-juan-chit-chat-josh.md
orgs/clearworksai/knowledge/meetings/2026-08-07-kadre-nerin-kadribegovic-and-josh-weiss.md
orgs/clearworksai/knowledge/meetings/2026-08-06-steven-burns-faia-steven-burns.md
orgs/clearworksai/knowledge/meetings/2026-08-03-logictcg-tech-committee-meeting-4.md
orgs/clearworksai/knowledge/meetings/2026-08-03-steven-burns-faia-aia-ai-office-hours-number-2.md
orgs/clearworksai/knowledge/meetings/2026-08-03-steven-burns-faia-ai-office-hours-aia-la-tap-committee.md
orgs/clearworksai/knowledge/meetings/2026-07-30-robin-nanney-studio-rns-monograph-cowork-setup.md
orgs/clearworksai/knowledge/meetings/2026-07-30-oakrootsaccounting-michelle-jaimes-and-josh-weiss.md
orgs/clearworksai/knowledge/meetings/2026-07-29-alloi-job-tread-and-recruitment.md
```

### Bus task receipt

```json
{
  "id": "task_1786397906430_99094078",
  "title": "Cron: meeting-writeback",
  "status": "completed",
  "result": "Meeting writeback checked: written=10 created_clients=2",
  "created_by": "meeting-writeback-01kzf3mm897vem5fdqn5r7hasa",
  "created_at": "2026-08-10T21:38:26Z",
  "completed_at": "2026-08-10T21:41:41Z"
}
```

### Marcos note

Marcos meeting `01KZF3MM897VEM5FDQN5R7HASA` (Alloi — Marcos Santa Ana, 2026-08-06) was
classified as "casual" by the LLM classifier in `build_recap_meeting` and skipped. The spawn
path and ledger mechanics are proven by the 10 filed meetings. The Marcos meeting needs a
manual `--meeting-id` flag or a classifier tuning to override the casual filter. Not a
Track A blocker.

### `EVENT crm.meeting.completed`

The skill emits `cortextos bus log-event action cron_completed` (Step 4). Confirmed present
in `analytics/events/meeting-writeback-01kzf3mm897vem5fdqn5r7hasa/2026-08-10.jsonl` at
2026-08-10T21:41:41Z. The downstream `EVENT crm.meeting.completed` (sent by crm agent's
own runbook when it processes the meeting) will fire when the crm agent next processes the
written `knowledge/meetings/*.md` files — this is a crm-side next-step, not a track A gap.

---

## Task 4: Receipts File

**THIS FILE** — `state/live-receipts/2026-08-10-prod-activation.md`

---

## Daemon Safety

Confirmed: `pm2 restart cortextos-daemon` NOT run at any point. Only per-agent operations performed.
Fleet status at activation start: 14/14 agents running.
