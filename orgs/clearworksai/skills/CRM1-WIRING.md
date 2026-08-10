# CRM1 Autonomous Cluster — wiring (v9 finish, FR-CRM1)

Canonical, version-controlled source for wiring the three Altari CRM skills to run **as SKILLS under the running `crm` agent** (codex runtime: `crm-codex`) on crm events/schedule — **not** the legacy standalone cron workers — emitting via the A6 sinks where a human task results.

- **data-enrichment-specialist** — `orgs/clearworksai/skills/data-enrichment-specialist/SKILL.md`
- **records-administrator** — `orgs/clearworksai/skills/records-administrator/SKILL.md`
- **pipeline-operations-manager** — `orgs/clearworksai/skills/pipeline-operations-manager/SKILL.md`

Each org skill carries its own `## cortextOS CRM wiring` section (trigger surface + A6 sink + idempotency key). This doc is the agent-side glue: the AGENTS.md event runbook + the crons that fire the skills. It is the apply-target for the live receipt (the running `crm-codex` agent dir + config are machine-local runtime, gitignored — this doc is what gets copied in).

Spec: `state/specs/v9-finish-spec-2026-08-09.md` FR-CRM1. Goal: `state/specs/v9-finish-GOAL-2026-08-09.md` (CRM1 track).

---

## Trigger surfaces (per skill)

| Skill | Event (deterministic, primary) | Schedule (backstop) | Emitter of the event |
|---|---|---|---|
| data-enrichment-specialist | `crm.contact.created` → keyless single-contact enrichment (fill-blanks-only) | `deal-enrichment` (`0 2 * * 2-6`) folds Account-Enrichment into the nightly dossier | `crm/upsert-contact.py` (person create only) |
| records-administrator | `crm.contact.created` / `crm.deal.created` / `crm.deal.stage_changed` / `crm.meeting.completed` / `crm.email.captured` / `crm.doc.received` → reconcile per the runbook table | `records-admin-sweep` (`0 20 * * 0`) drift catcher + compliance sweep | `upsert-contact.py`, `reconcile-intake.py`, `sync-board.py`, `comms-backfill.py` |
| pipeline-operations-manager | `crm.deal.stage_changed` → scoped CRM Hygiene / stage-honesty audit | `pipeline-ops` (`0 9 * * 1`) full pass: Hygiene → Report → Forecast (DRAFT) — **replaces the legacy inline `weekly-brief` cron** | `crm/sync-board.py` |

The event lane carries the intraweek load; the schedule is the drift catcher. All three run as the named SKILL, never as a re-implemented inline cron prompt.

---

## AGENTS.md — Records-Admin Event Runbook (apply to `crm-codex/AGENTS.md`)

The running `crm-codex/AGENTS.md` is the bare codex template with no CRM domain runbook. Insert the block below (verbatim structure — `test_crm_events.py::test_runbook_maps_every_emitted_event` asserts every event type + the pipeline-ops row + the A6 human-task sink line are present). It matches the non-codex `crm/AGENTS.md` runbook with the new **pipeline-operations-manager** row added.

> ### Records-Admin Event Runbook (CRM1 cluster)
>
> Scripts self-send `EVENT crm.<type> — <compact json>` to this agent's own inbox on write (`upsert-contact.py` on create, `reconcile-intake.py` per consumed intent, `sync-board.py` per stage/archive change, `comms-backfill.py` per new interaction). When an inbox message starts with `EVENT crm.<type>`, dispatch per this table (invoke the named SKILL for the diff/dedupe/enrichment logic). ACK only after the handler exits `0`.
>
> | Event | Skill invoked | Action |
> |---|---|---|
> | `crm.contact.created` | data-enrichment-specialist + records-administrator | Dedupe scan (name+domain), normalize company via `crm/org-aliases.json`, then keyless single-contact enrichment (fill-blanks-only on company/role/industry, set `email_status` + `enrichment` per `crm/schema.md`) |
> | `crm.deal.created` | records-administrator | Conform-on-arrival: alias/dup check vs existing engagements, rebuild that company's timeline feed, scaffold a knowledge-sync client note if missing |
> | `crm.deal.stage_changed` | pipeline-operations-manager + records-administrator | Pipeline hygiene / stage-honesty audit scoped to the affected company (stage vs last-activity + next-step; zombie-deal flag); sync mirrors (company feeds + client note); on `won`/`active_client`: doc-filing checklist + compliance touch |
> | `crm.meeting.completed` | records-administrator | Single-meeting ingest now (don't wait on the 2h fireflies poll): attendee upsert (→ `crm.contact.created`), interaction, followups, `meetings/` file; sync check on any named deal |
> | `crm.email.captured` | records-administrator | Refresh `last_contact_date`, re-check stale-deal status, render note via `crm/interactions-to-notes.py` |
> | `crm.doc.received` | records-administrator | File by content type via the P1.0 outputs router, link from the engagement, update the doc index |
>
> **A6 sink — where a human task results.** Additive/evidence-backed fixes (STALE, MISSING) auto-apply via the idempotent scripts. Every human decision (DUPLICATE/ORPHAN merge-or-delete, CONFLICT, stage-audit pursue-or-kill, forecast sign-off, enrichment spend, send-safety hold, compliance deadline) routes to the bus, never a freeform Telegram DM:
> `cortextos bus create-task "<title>" --assignee human [--needs-approval] --desc "<evidence · idempotency key>"`, and for client-visible / financial / data-deletion items ALSO `cortextos bus create-approval "<title>" <category> "<context>"`. Each task's `--desc` carries a deterministic idempotency key (`crm-enrich:*`, `crm-records:*`, `crm-compliance:*`, `crm-pipeline:*`, `crm-forecast:*`) so re-runs never duplicate.

---

## config.json crons (apply to `crm-codex/config.json` `crons[]`, then reboot the agent)

Two changes vs the current live cron set:

1. **Rename/replace `weekly-brief` → `pipeline-ops`** so the Monday 9:00 run invokes the SKILL rather than the legacy inline brief prompt:

```json
{
  "name": "pipeline-ops",
  "type": "recurring",
  "cron": "0 9 * * 1",
  "prompt": "TASK_ID=$(cortextos bus create-task \"Cron: pipeline-ops\" --desc \"Monday 9am pipeline-operations-manager: hygiene -> report -> forecast\" 2>/dev/null); cortextos bus update-task $TASK_ID in_progress 2>/dev/null; cortextos bus update-cron-fire pipeline-ops --interval 168h 2>/dev/null; Run the pipeline-operations-manager SKILL (orgs/clearworksai/skills/pipeline-operations-manager/SKILL.md) full pass over crm/pipeline.json + crm/contacts.json: Hygiene (stage-honesty, dedupe, zombie flag) -> Pipeline Report (deltas vs prior outputs/pipeline-operations-manager/) -> Forecast (DRAFT, unsigned). Post the report to the org activity feed via cortextos bus post-activity (<=7 bullets). Route every human decision (stage-audit pursue-or-kill, forecast sign-off) to the A6 bus sink per the skill's A6 section (create-task --assignee human, --needs-approval + create-approval for the forecast), idempotent by crm-pipeline:<deal_id>.<yyyymmdd> / crm-forecast:<isoweek>. SILENT-OK: if hygiene is clean and no decisions surface, log COMMS_OK and respond literally 'OK'. When finished: cortextos bus complete-task $TASK_ID --result 'Cron: pipeline-ops complete' 2>/dev/null"
}
```

2. **`deal-enrichment` (`0 2 * * 2-6`) and `records-admin-sweep` (`0 20 * * 0`) stay** — they already invoke the enrichment/records skills. Verify their prompts still name the org-skill path (`orgs/clearworksai/skills/...`) rather than the global `~/.claude/skills/...` copy so the versioned skill is the one that runs.

The `crm-codex` agent has no `crm/` scripts dir of its own; the crons resolve `crm/*.py` under the crm agent root. If crm-codex runs the crons, either (a) symlink `orgs/clearworksai/agents/crm-codex/crm -> ../crm/crm`, or (b) keep the crons homed on the non-codex `crm` agent. Confirm at apply-time.

---

## Live receipt (prod — Josh runs, halt-before-prod respected)

The condition per the spec = **a real enrichment/record update fired by the SKILL**. To capture it after applying the block above to the prod `crm-codex` agent dir and rebooting that one agent:

```bash
# 1. Apply: insert the runbook block into crm-codex/AGENTS.md, add the pipeline-ops cron to
#    crm-codex/config.json, ensure the org-skill path resolves (symlink crm scripts if needed).
# 2. Reboot ONLY the crm-codex agent so it re-reads config (no full daemon restart):
cortextos bus hard-restart --reason "CRM1 wiring apply"   # run as crm-codex, or restart via agent-management

# 3a. Event path — fire a real stage change and watch pipeline-operations-manager wake + emit:
cd orgs/clearworksai/agents/crm && python3 crm/sync-board.py         # emits EVENT crm.deal.stage_changed on any real move
#     then inspect the crm inbox + the filed artifact:
ls -t orgs/clearworksai/agents/crm/outputs/pipeline-operations-manager/ | head
cortextos bus list-tasks --assignee human | grep -i 'crm-pipeline\|crm-forecast'

# 3b. Enrichment path — a real new person contact drives keyless enrichment:
cd orgs/clearworksai/agents/crm && python3 crm/upsert-contact.py --name "<real new contact>" --type person --email "<addr>"
#     -> EVENT crm.contact.created -> data-enrichment-specialist fills blanks on that contact record.

# LIVE RECEIPT = the filed outputs/*.md (or the updated contact/pipeline record) + the
# EVENT crm.* line in the crm inbox + (if a decision surfaced) the crm-* keyed human task.
```

Do **not** run these against prod as part of the build — this is the human-gate step.
