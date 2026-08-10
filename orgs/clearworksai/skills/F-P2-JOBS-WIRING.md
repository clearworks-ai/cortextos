# Track F — 3 P2 jobs wired to a live trigger (v9 finish, prove the loop)

Canonical, version-controlled source for wiring **three real P2 jobs** to a REAL trigger with
**real-path output + a structured bus row** — proving the P2 loop end-to-end instead of the earlier
spot-run that wrote only synthetic fixtures (0 of 25 jobs were wired). This mirrors the CRM1 pattern
(`CRM1-WIRING.md`): each job skill carries its own `## cortextOS wiring` section (trigger + real output
path + bus row + idempotency key); this doc is the agent-side glue (AGENTS.md runbook rows + crons) and
the apply-target for the live receipt.

Spec: `state/specs/v9-finish-spec-2026-08-09.md`. Goal: `state/specs/v9-finish-GOAL-2026-08-09.md` (Track F).
Finish plan: `state/FINISH-PLAN-v9-2026-08-09.md` §TRACK F.

The three jobs (do NOT boil the ocean — prove the loop, then scale):

| P2 job | Skill | Runs under agent |
|---|---|---|
| **Meeting Follow-Ups** | `orgs/clearworksai/skills/followup-coordinator/SKILL.md` | crm (or pa off the meeting chain) |
| **Pre-Call Briefing** | `orgs/clearworksai/agents/frank2/.claude/skills/pre-meeting-brief-page-worker/SKILL.md` | frank2 |
| **Status Updates** | `orgs/clearworksai/agents/crm/.claude/skills/delivery-status-reporter-worker/SKILL.md` | crm |

Each skill's `## cortextOS wiring` section is the source of truth for its trigger/output/bus-row; this
table is the fleet-side map.

---

## Trigger surfaces (per job)

| Job | Event (deterministic, primary) | Schedule (backstop / cadence) | Real output path | Structured bus row + idempotency key |
|---|---|---|---|---|
| Meeting Follow-Ups | `crm.meeting.completed` (Track A's ff spawn chain) → run followup-coordinator on the just-filed transcript | `followup-sweep` (`0 18 * * 1-5`) — overdue-item chaser across trackers | `outputs/followups/[client]-[date].md` + `knowledge/clients/[client].md` `## Open Items` | `create-task --assignee human --needs-approval` + `create-approval external-comms` for the recap; plain human task per overdue item. Keys `followup-recap:<client>.<date>` / `followup:<client>.<date>.<slug>` |
| Pre-Call Briefing | `calendar.event.upcoming` (Track E watch, ~45m pre-start) → spawn pre-meeting-brief worker | `pre-meeting-brief-page` (`*/15 7-19 * * 1-5`) — 15-min scan (live today) | published BRIEFS page (link Josh opens) + `state/pre-meeting-brief-surfaced.txt` mark | `create-task "Cron: pre-meeting-brief-page"` → `complete-task` (the run row). Key = surfaced-mark + `event-dedup --source calendar:<eventId> --fire-once` |
| Status Updates | `crm.deal.stage_changed`→active_client/won (optional off-cadence accelerator) | `delivery-status-reporter` (`0 9 * * 1`) — weekly roster sweep (primary, by design) | `outputs/delivery-status-reporter/*.md` DRAFTS (never a client channel) | `create-approval external-comms --client <c>` per good-news draft + `post-activity`. Key `status:<client>.<isoweek>` |

> **Idempotency-key format (hard constraint, verified against the built CLI).** `cortextos bus
> event-dedup --source` keys are `<namespace>:<id>` with **exactly one colon** — the id charset in
> `SOURCE_KEY_PATTERN` (`src/utils/event-dedup.ts`) does NOT include `:`. A multi-colon key
> (`followup-recap:<client>:<date>`) is rejected as `invalid-key`, fails OPEN, and every re-run falsely
> SURFACEs — silently breaking dedup. All three jobs therefore encode the compound id with dots
> (`followup-recap:<client>.<date>`, `status:<client>.<isoweek>`). Proven in this build: SURFACE on first
> sight, SKIP on the identical re-run.

The event lane (where it exists) carries the intraweek/same-day load; the schedule is the drift catcher
/ cadence engine. Every job runs as the NAMED SKILL, never a re-implemented inline cron prompt.

---

## AGENTS.md — Follow-Up event row (apply to the running crm agent's `AGENTS.md`)

The crm agent's `crm.meeting.completed` runbook row already ingests the meeting (attendee upsert,
interaction, followups, `meetings/` file). Extend that row to ALSO invoke the Follow-Up Coordinator so
the closed loop (recap draft + tracked open items + bus row) happens same-day. Add, after the existing
`crm.meeting.completed` action:

> On `crm.meeting.completed`, after the records ingest, invoke the **followup-coordinator** SKILL
> (`orgs/clearworksai/skills/followup-coordinator/SKILL.md`) on the just-filed transcript: extract OUR /
> THEIR commitments with source quotes, file `outputs/followups/<client>-<date>.md`, update the client
> `## Open Items` tracker, and emit the A6-style bus row per the skill's `## cortextOS wiring` section
> (recap → `create-task --assignee human --needs-approval` + `create-approval external-comms`, gated by
> `event-dedup --source followup-recap:<client>:<date>`). ACK only after the skill exits `0`.

Pre-Call Briefing needs no AGENTS.md row — it is cron-driven today; its event upgrade lands with Track E
(`calendar.event.upcoming`). Status Updates is cron-driven by design (cadence sweep).

---

## config.json crons (apply to the running agent, then reboot ONLY that agent)

1. **crm agent — add `followup-sweep`** (overdue-item chaser; the event lane carries same-day follow-ups):

```json
{
  "name": "followup-sweep",
  "type": "recurring",
  "cron": "0 18 * * 1-5",
  "prompt": "TASK_ID=$(cortextos bus create-task \"Cron: followup-sweep\" --desc \"6pm chase of overdue-unconfirmed open items across client trackers\" 2>/dev/null); cortextos bus update-task $TASK_ID in_progress 2>/dev/null; cortextos bus update-cron-fire followup-sweep --interval 24h 2>/dev/null; Run the followup-coordinator SKILL (orgs/clearworksai/skills/followup-coordinator/SKILL.md) in chase mode ONLY: scan every knowledge/clients/*.md Open Items table for rows past deadline and still unconfirmed. For each, gate on cortextos bus event-dedup --source followup:<client>.<date>.<slug> (single colon; dots in the compound id) and create a plain human task (cortextos bus create-task --assignee human --desc '... key followup:...'). Do NOT re-extract meetings — the crm.meeting.completed event lane owns fresh follow-ups. SILENT-OK: if nothing is overdue, log COMMS_OK and respond literally 'OK'. When finished: cortextos bus complete-task $TASK_ID --result 'Cron: followup-sweep complete' 2>/dev/null"
}
```

2. **`pre-meeting-brief-page` (`*/15 7-19 * * 1-5`) and `delivery-status-reporter` (`0 9 * * 1`) stay** —
   they already fire the two other skills. Verify their prompts still name the org/agent-skill path (not
   a stale global `~/.claude/skills/...` copy). Once Track E's `calendar.event.upcoming` lane is live,
   Track D drops the `*/15` poll to a once-hourly safety sweep.

The running `crm-codex` / `frank2-codex` agent dirs are machine-local runtime (gitignored) — this doc is
what gets copied in. If crm-codex runs the crons, ensure the org-skill path resolves (symlink or home the
cron on the non-codex agent). Confirm at apply-time.

---

## Verification done in this build (staging / local, real non-synthetic input — halt before prod)

Per the spec's STAGING-FIRST rule, Track F is **additive skill/output wiring** (no `src/` change, no
control-plane touch) → it verifies **locally against a real input sample**, NOT on the staging daemon
(which is reserved for control-plane tracks A/B/C1). What was proven in the build worktree:

- **Contract test** `test_f_p2_jobs_wiring.py` (green): all three skills exist, each declares its trigger
  surface + real output path + a structured bus row + a deterministic idempotency key; the follow-up
  event row is mapped in this runbook; every cron named here is well-formed.
- **Real-input dry-run of the bus-sink gate** against REAL (non-synthetic) inputs — client `kadre`/`ocg`
  and real fireflies meeting id `01KZ71M4876B6NKT8V3TFCQBRW` — run against the built CLI in an ISOLATED
  temp `CTX_ROOT` (zero prod side effects). Result: `followup-recap:kadre.2026-08-08` and
  `status:kadre.2026-W32` SURFACE on first sight, SKIP on identical re-run; a distinct client (`ocg`)
  stays a distinct key. **Bug caught + fixed in this build:** the first key draft used a multi-colon
  form (`followup-recap:<client>:<date>`) which `event-dedup` rejects as `invalid-key` and fails OPEN —
  every re-run would have falsely SURFACEd, silently breaking idempotency. All keys were switched to the
  single-colon dotted-id form before shipping.

No prod agent dir was mutated and the daemon was NOT restarted.

---

## Live receipt (prod — Josh runs; halt-before-prod respected)

The condition per Track F = **each job produces a real-path artifact + a structured bus row off a real
trigger**. Capture after applying the AGENTS.md row + `followup-sweep` cron to the running agents and
rebooting ONLY those agents (no full daemon restart):

```bash
# ── Meeting Follow-Ups (event lane) ──────────────────────────────────────────
# Fire the same-meeting fast path for ONE real recent fireflies meeting (Track A chain),
# which emits EVENT crm.meeting.completed → followup-coordinator runs:
cd orgs/clearworksai/agents/pa && source .env && \
  python3 scripts/ff-extractor.py --mode full --meeting-id <REAL_FF_MEETING_ID>
# then confirm the closed loop:
ls -t orgs/clearworksai/agents/crm/outputs/followups/ | head          # filed follow-up md
cortextos bus list-tasks --assignee human | grep -i 'followup-recap\|Send recap'   # bus row + approval

# ── Pre-Call Briefing (cron lane, live today) ────────────────────────────────
# Let the */15 scan fire against a REAL upcoming external meeting (or trigger a scan),
# then confirm the published brief + the run row:
grep -c . orgs/clearworksai/agents/frank2/state/pre-meeting-brief-surfaced.txt   # a new surfaced line
cortextos bus list-tasks | grep -i 'pre-meeting-brief-page'          # create→complete run row (link delivered)

# ── Status Updates (weekly cron) ─────────────────────────────────────────────
# Fire the Monday sweep (or the off-cadence stage-changed accelerator) for the blessed roster:
ls -t orgs/clearworksai/agents/crm/outputs/delivery-status-reporter/ | head   # per-client DRAFTS
cortextos bus list-approvals | grep -i 'status\|delivery'           # external-comms approval cards

# LIVE RECEIPT (each job) = the filed real-path artifact + the structured bus row (task/approval/activity),
# with the idempotency key so a re-fire does not duplicate.
```

Do **not** run these against prod as part of the build — this is the human-gate step.
