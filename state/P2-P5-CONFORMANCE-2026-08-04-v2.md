# P2 / P5 Conformance Re-run

Date of run: 2026-08-05
Workspace: `/Users/joshweiss/code/cortextos`
Mode: sequential test-and-report only

This rerun executed or attempted each target skill against a scratch fixture under `state/skill-tests/<skill>/`, wrote no production data, and treated the live cron registry at `~/.cortextos/cortextos1/.cortextOS/state/agents/*/crons.json` as authoritative for wiring.

## Scope notes

- Repo vs home skill copies both exist and differ for `meeting-intelligence-engineer`, `followup-coordinator`, and `knowledge-base`.
- The other 15 target skills exist only in `~/.claude/skills/<skill>/SKILL.md`.
- Raw scratch fixtures and outputs are retained under `state/skill-tests/`.

## Counts

`CONFORMS` and `WIRED` are independent axes.

Conformance counts:

- `CONFORMS`: 14
- `VIOLATES-SPEC`: 2
- `CANNOT-EXECUTE`: 1
- `BLOCKED-NEEDS-LIVE-RUN`: 1

Wiring counts:

- `WIRED-AND-FIRING`: 3
- `WIRED-BUT-NOT-FIRING`: 2
- `UNWIRED`: 9
- `UNWIRED-BY-REGRESSION`: 4

## Verdict Table

| skill | conformance | wiring | declared output | key finding | fix (describe only) | effort |
|---|---|---|---|---|---|---|
| `meeting-intelligence-engineer` | `VIOLATES-SPEC` | `WIRED-AND-FIRING` | `knowledge/meetings/YYYY-MM-DD-[client]-[topic].md` + `knowledge/clients/[client].md` | live invoker `~/.cortextos/cortextos1/.cortextOS/state/agents/pa/crons.json:57`; `ff-extractor.py` drops the required first-person vague-deadline commitment upstream, while the writeback worker preserves it when the payload includes it | change upstream extraction/gating in `orgs/clearworksai/agents/pa/scripts/ff-extractor.py`; do not rewrite the writeback worker first | M |
| `deal-debrief-analyst` | `CONFORMS` | `UNWIRED` | `outputs/deal-debrief-analyst/[YYYY-MM-DD]-[company].md` | live invoker `NOTHING`; scratch output matched the spec shape | add an explicit on-demand or event route if this skill should matter live | M |
| `call-prep-researcher` | `CONFORMS` | `WIRED-AND-FIRING` | `outputs/call-prep-researcher/[YYYY-MM-DD]-[company-or-name].md` | live invokers `~/.cortextos/cortextos1/.cortextOS/state/agents/frank2/crons.json:61` and `:268`; real artifact exists, but the live path is router-style (`.../calasia-callbrief-2026-08-05.md`), not the spec path | either bless the router path in the spec or make the worker emit the spec path too | M |
| `followup-coordinator` | `CONFORMS` | `UNWIRED` | `outputs/followups/[client]-[YYYY-MM-DD].md` + `knowledge/clients/[client].md` | live invoker `NOTHING`; only historical spot-run proof exists at `~/.cortextos/cortextos1/orgs/clearworksai/tasks/audit/task_1785607558365_21141751.jsonl:7` | add a real live invoker or retire this spec in favor of the commitment worker | M |
| `inbox-manager` | `CONFORMS` | `UNWIRED-BY-REGRESSION` | `outputs/inbox-manager/digest-[YYYY-MM-DD].md` | live bypass `~/.cortextos/cortextos1/.cortextOS/state/agents/pa/crons.json:47`; `comms-check-worker` acts on inbox threads but never writes the digest artifact the skill promises | either wire the named skill or rewrite the skill contract to match the live worker | M |
| `records-administrator` | `CANNOT-EXECUTE` | `UNWIRED-BY-REGRESSION` | `outputs/records-administrator/` | live invoker `NOTHING`; config-only sweep remains at `orgs/clearworksai/agents/crm/config.json:61`; the spec contradicts itself on whether safe writes are human-gated | reconcile the spec before any retest, then reconcile config/event path vs live registry | S |
| `pipeline-operations-manager` | `CONFORMS` | `UNWIRED-BY-REGRESSION` | `outputs/pipeline-operations-manager/[YYYY-MM-DD]-pipeline.md` | live invoker `NOTHING`; stale config still names it at `orgs/clearworksai/agents/frank2/config.json:60`; canonical writer `orgs/clearworksai/agents/crm/crm/upsert-engagement.py` conforms on a scratch `pipeline.json` copy | restore a live invoker or wire the canonical writer directly into the intended review path | M |
| `client-portal-manager` | `CONFORMS` | `UNWIRED` | `outputs/portals/[client]/` | live invoker `NOTHING`; there is historical adjacent deal-room activity, but no direct proof that this skill itself is invoked today | define an explicit on-demand route or integrate it into the deal-room flow with a real contract | M |
| `delivery-status-reporter` | `VIOLATES-SPEC` | `UNWIRED` | `outputs/status-updates/[client]/[YYYY-MM-DD].md` | live invoker `NOTHING`; historical spot-run only at `~/.cortextos/cortextos1/orgs/clearworksai/tasks/audit/task_1785607558365_21141751.jsonl:7`; the live worker/router writes `knowledge-sync/raw/.../status-update-*` and `status-brief-*` instead of the spec path | align the worker/router path or amend the skill spec to the router taxonomy | M |
| `client-onboarding-manager` | `CONFORMS` | `UNWIRED` | `outputs/onboarding/[client]/` | live invoker `NOTHING`; scratch onboarding pack conformed | add an explicit on-demand route if this is meant to be live | M |
| `customer-success-manager` | `CONFORMS` | `UNWIRED-BY-REGRESSION` | `outputs/customer-success-manager/` | live bypass `~/.cortextos/cortextos1/.cortextOS/state/agents/frank2/crons.json:142-143`; `client-health` only sends messages/tasks and never writes the skill output | either wire the real skill or rewrite the contract around the `client-health` cron | M |
| `billing-manager` | `CONFORMS` | `UNWIRED` | `outputs/billing-manager/` | live invoker `NOTHING`; scratch ledger/invoice/chase outputs conformed | add an explicit on-demand route if intended | M |
| `proposal-writer` | `CONFORMS` | `WIRED-BUT-NOT-FIRING` | `outputs/proposals/[client]-[YYYY-MM-DD].md` | on-demand historical proof exists at `~/.cortextos/cortextos1/lessons/lessons-2026-07-29.jsonl:21-23`; no live cron/event invoker today | keep it on-demand, but document the invoker and durable output path clearly | S |
| `pricing-analyst` | `CONFORMS` | `WIRED-BUT-NOT-FIRING` | `outputs/pricing-analyst/[client]-[YYYY-MM-DD].md` | on-demand historical proof exists at `~/.cortextos/cortextos1/lessons/lessons-2026-07-29.jsonl:23` and `~/.cortextos/cortextos1/orgs/clearworksai/analytics/events/auditmaster/2026-08-03.jsonl:25`; prior artifact exists at `orgs/personal/agents/ophir/outputs/pricing-analyst/architecture-bd-proposal-combined-2026-07-29.md` | keep it on-demand, but document the invoker and durable output path clearly | S |
| `knowledge-base` | `BLOCKED-NEEDS-LIVE-RUN` | `WIRED-AND-FIRING` | live MMRAG store + `orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl` | live invoker `~/.cortextos/cortextos1/.cortextOS/state/agents/larry/crons.json:192-193`; 19 live fires, but the ledger has 13 rows / 0 green | add a safe scratch mode to the script or run the exact live command once under explicit approval in a live test | M-L |
| `company-research-analyst` | `CONFORMS` | `UNWIRED` | `outputs/company-research-analyst/[YYYY-MM-DD-HHMMSS]-[company-name].md` | live invoker `NOTHING`; scratch research report conformed | add an explicit on-demand route if intended | S-M |
| `vertical-analyst` | `CONFORMS` | `UNWIRED` | `outputs/vertical-analyst/[YYYY-MM-DD]-[vertical-slug].md` | live invoker `NOTHING`; scratch report conformed | add an explicit on-demand route if intended | S-M |
| `playbook-writer` | `CONFORMS` | `UNWIRED` | `knowledge/playbooks/[topic].md` + `outputs/handoffs/[client]/` | live invoker `NOTHING`; scratch SOP + handoff pack conformed | add a ship/handoff hook if this should happen automatically | M |

## Non-conforming Detail

### `meeting-intelligence-engineer`

Spec rules violated:

- `orgs/clearworksai/skills/meeting-intelligence-engineer/SKILL.md:145-165` requires the meeting transcript to be filed and written back to the client file using the follow-up table format, with `Owner=NEEDS-OWNER` and `Deadline=NEEDS-DEADLINE` when those are not explicit.
- `orgs/clearworksai/skills/meeting-intelligence-engineer/SKILL.md:160-164` explicitly forbids guessing owners and deadlines.

Failing assertions and evidence:

1. The mandated first-person vague-deadline commitment was present in the fixture.
   Evidence: `state/skill-tests/meeting-intelligence-engineer/out/ff-extractor-caseA-faithful.json:45` preserves the exact source quote.
2. When the downstream writeback worker receives that item, it conforms.
   Evidence: `state/skill-tests/meeting-writeback-worker/rerunA/knowledge/clients/northwind-logistics.md:31` writes the row with `NEEDS-OWNER | NEEDS-DEADLINE`.
3. The live extractor gate drops the same item before writeback.
   Evidence: `state/skill-tests/meeting-intelligence-engineer/out/ff-extractor-caseB-drop.json:37-38` has no second item at all, and `state/skill-tests/meeting-writeback-worker/rerunB/knowledge/clients/northwind-logistics.md:31` contains only the named-owner control item.
4. The control commitment survives, so this is not a total parse failure.
   Evidence: `state/skill-tests/meeting-writeback-worker/rerunB/knowledge/clients/northwind-logistics.md:31` still contains Sarah Chen's dated commitment.

Root cause:

- `orgs/clearworksai/agents/pa/scripts/ff-extractor.py:102-106` drops any item without a specific named owner and a concrete due date.
- `orgs/clearworksai/agents/pa/scripts/ff-extractor.py:1211-1226` applies a conservative inbound gate that returns `None` for generic owners.

Suggested fix location:

- `orgs/clearworksai/agents/pa/scripts/ff-extractor.py:102-106`
- `orgs/clearworksai/agents/pa/scripts/ff-extractor.py:1211-1226`

Most important comparison result:

- The writeback worker is already better than the extractor on this exact failure mode.
- `meeting-writeback-worker` preserves the required row when the payload includes it.
- `ff-extractor.py` is where the loss happens.
- Verdict of the comparison: wire/use the existing writeback worker for writeback logic, but fix upstream extraction first because the worker cannot recover an item that never reaches the payload.

### `delivery-status-reporter`

Spec rules violated:

- `~/.claude/skills/delivery-status-reporter/SKILL.md:118-122` requires writing to `outputs/status-updates/[client]/[YYYY-MM-DD].md`.
- `~/.claude/skills/delivery-status-reporter/SKILL.md:144-150` requires the artifact to be saved there every run.

Failing assertions and evidence:

1. GOOD/NEUTRAL draft case writes the router path, not the spec path.
   Evidence: `state/skill-tests/delivery-status-reporter/out/plan-good-rerun.json:42` writes `raw/areas/clearworks/clients/testco/status-update-2026-08-05.md`.
2. BAD/MIXED case also writes the router path, not the spec path.
   Evidence: `state/skill-tests/delivery-status-reporter/out/plan-rerun.json:46` writes `raw/areas/clearworks/clients/testco/status-brief-2026-08-05.md`.
3. The live worker contract explicitly instructs the off-spec path.
   Evidence: `orgs/clearworksai/agents/crm/.claude/skills/delivery-status-reporter-worker/SKILL.md:111-123`.
4. Real artifacts follow the off-spec taxonomy too.
   Evidence: `/Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/alloi/status-update-2026-08-03.md` and `/Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/oakrootsaccounting/oakrootsaccounting-status-2026-08-03.md`.

Notes:

- OakRoots is not one of the blessed-5 clients (`OCG`, `Kadre`, `Alloi`, `SEIU 521`, `MSIA`), so the live path is not enforcing that distinction.
- The only direct proof of this lane running is a human-triggered spot-run, not a live cron, so wiring remains `UNWIRED`.

Suggested fix location:

- `orgs/clearworksai/agents/crm/.claude/skills/delivery-status-reporter-worker/SKILL.md:111-123`
- If the router taxonomy is intended, align the spec and router together in `src/bus/delivery-status.ts`.

### `records-administrator`

Why this is `CANNOT-EXECUTE`:

- `~/.claude/skills/records-administrator/SKILL.md:15-16` says every live write, including safe updates and new-record creates, must be explicitly human-confirmed and that nothing should auto-apply.
- `~/.claude/skills/records-administrator/SKILL.md:101-105` says `STALE` and `MISSING` changes should auto-apply.

That is a direct contract contradiction. A faithful run cannot satisfy both rules at once.

Wiring state:

- No live cron currently invokes it.
- A stale config-only sweep remains at `orgs/clearworksai/agents/crm/config.json:61`.
- The event runbook still references it at `orgs/clearworksai/agents/crm/AGENTS.md:39-50`, but I found no current live firing proof for that dispatch path in this run.

Leakage check on the "66+ live CRM events" claim:

- I did not confirm test-fixture names in live CRM stores.
- The fixture strings (`zz-smoketest`, `OCG Expansion`, `Automation Sprint`) were found in tests, not in the live `contacts.json`, `pipeline.json`, `interactions.jsonl`, or `followups.jsonl`.
- Best current read: the prior "66+ live CRM events" claim is more likely test-fixture leakage or memory overstatement than actual live event volume.

Suggested fix location:

- `~/.claude/skills/records-administrator/SKILL.md:15-16`
- `~/.claude/skills/records-administrator/SKILL.md:101-105`
- Then reconcile the live/event model with `orgs/clearworksai/agents/crm/AGENTS.md:39-50` and `orgs/clearworksai/agents/crm/config.json:61`.

### `knowledge-base`

Why this is `BLOCKED-NEEDS-LIVE-RUN`:

- The live cron exists and fires, but the faithful command writes to live state that the run boundary forbids touching.
- `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh:5-15` hardcodes the live repo, live ledger, and live `MMRAG_DIR`.
- `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh:17-25` mirrors agent memory, runs live reconcile, and refreshes edges.
- The live cron explicitly background-launches that script at `~/.cortextos/cortextos1/.cortextOS/state/agents/larry/crons.json:192-193`.

Current health evidence:

- Live cron fire count: 19
- Last live fire: `2026-08-04T10:37:21.412Z`
- Ledger rows: 13
- Green rows: 0
- Last ledger row: `2026-08-04T10:39:34Z`, `green=false`

`knowledge/clients/*.md` writeback spot check:

- `orgs/clearworksai/agents/frank2/scripts/sync_client_context.py:2` says it rebuilds `knowledge/clients/*.md` from CRM data.
- `orgs/clearworksai/agents/frank2/scripts/sync_client_context.py:342-377` deletes all existing client markdown files and rewrites them from CRM inputs.
- The 2026-08-04 mtime cluster across `alloi.md`, `ocg.md`, `kadre.md`, `msia.md`, and `seiu-521.md` matches a batch rebuild much better than a one-off meeting append.
- Best current read: `orgs/clearworksai/knowledge/clients/msia.md` on 2026-08-04T11:10:12-0700 was most likely written by `sync_client_context.py`, not by the meeting-intelligence-engineer contract.

Suggested fix location:

- Add a scratch/safe mode to `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh`.
- If not, settle it with the exact one-command live test listed in the final section below.

## Bypass Inventory

These are cases where something live does the job shape of the skill while writing somewhere the skill spec never names.

1. `meeting-intelligence-engineer`
   Live path: `~/.cortextos/cortextos1/.cortextOS/state/agents/pa/crons.json:57`
   Divergence: runs `python3 scripts/ff-extractor.py` and posts task-style commitments; does not itself write the spec's `knowledge/meetings/...` + `knowledge/clients/...` contract.

2. `followup-coordinator`
   Adjacent live path: `~/.cortextos/cortextos1/.cortextOS/state/agents/frank2/crons.json:198`
   Divergence: `meeting-commitments-worker` surfaces only `P0` items via Telegram and `state/meeting-commitments-surfaced.txt`; it never writes `outputs/followups/[client]-[date].md`.

3. `inbox-manager`
   Live path: `~/.cortextos/cortextos1/.cortextOS/state/agents/pa/crons.json:47`
   Divergence: `comms-check-worker` triages/responds, but does not write `outputs/inbox-manager/digest-[date].md`.

4. `call-prep-researcher`
   Live path: `~/.cortextos/cortextos1/.cortextOS/state/agents/frank2/crons.json:268`
   Divergence: live artifact lands at `/Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/calasia-construction/calasia-callbrief-2026-08-05.md`, not `outputs/call-prep-researcher/...`.

5. `delivery-status-reporter`
   Worker path: `orgs/clearworksai/agents/crm/.claude/skills/delivery-status-reporter-worker/SKILL.md:111-123`
   Divergence: writes `raw/areas/clearworks/clients/[client]/status-update-*` or `status-brief-*`, not `outputs/status-updates/[client]/[date].md`.

6. `pipeline-operations-manager`
   Live adjacent path: `~/.cortextos/cortextos1/.cortextOS/state/agents/frank2/crons.json:156-157`
   Divergence: `pipeline-review` only summarizes and routes tasks; the actual stage writer is `orgs/clearworksai/agents/crm/crm/upsert-engagement.py`, which writes `pipeline.json`, not the report artifact.

7. `customer-success-manager`
   Live path: `~/.cortextos/cortextos1/.cortextOS/state/agents/frank2/crons.json:142-143`
   Divergence: `client-health` sends Telegram / creates tasks and never writes `outputs/customer-success-manager/`.

## P5 Cron Set

`kind` is my classification:

- `DETERMINISTIC`: scripts/threshold logic, no open-ended LLM judgment
- `LLM-MECHANICAL`: worker or bounded synthesis job
- `LLM-JUDGMENT`: open-ended review/synthesis/recommendation

Rows marked `N/A` under destination alignment are standalone cron jobs, not obvious implementations of one of the named P2 skills.

### P5-B

| cron | schedule | enabled | kind | supposed SKILL.md / job | prompt-to-destination alignment | newest durable artifact |
|---|---|---:|---|---|---|---|
| `pa/comms-check` | `15m` | `true` | `LLM-MECHANICAL` | inbox-manager-adjacent via `comms-check-worker` | `NO` — prompt only says `"Read .claude/skills/comms-check-worker/SKILL.md and execute it exactly"`; no `outputs/inbox-manager/` path | `NONE` durable file found |
| `pa/ff-extractor` | `0 */4 * * *` | `true` | `DETERMINISTIC` | meeting-intelligence-engineer-adjacent | `NO` — prompt is just `"python3 scripts/ff-extractor.py"`; no `knowledge/meetings` / `knowledge/clients` path | `NONE` durable file named by prompt |
| `frank2/transcript-scanner` | `2h` | `true` | `LLM-MECHANICAL` | `orgs/clearworksai/agents/frank2/.claude/skills/transcript-scanner-worker/SKILL.md` | `N/A` — worker path only, no output path quoted in cron prompt | `NONE` durable file identified from the cron prompt alone |
| `frank2/meeting-commitments` | `2h` | `true` | `LLM-MECHANICAL` | `orgs/clearworksai/agents/frank2/.claude/skills/meeting-commitments-worker/SKILL.md` | `NO` — worker writes surfacing state / Telegram; no `outputs/followups/` path | `NONE` dated durable file; only `state/meeting-commitments-surfaced.txt` |
| `frank2/pre-meeting-brief` | `0 17 * * 1-5` | `true` | `LLM-JUDGMENT` | call-prep-researcher-adjacent | `NO` — prompt says `"Telegram to 6690120787"`; no `outputs/call-prep-researcher/` path | `NONE` durable file named by prompt |
| `frank2/pre-meeting-brief-page` | `*/15 7-19 * * 1-5` | `true` | `LLM-MECHANICAL` | `orgs/clearworksai/agents/frank2/.claude/skills/pre-meeting-brief-page-worker/SKILL.md` | `NO` — cron only spawns the worker; the live artifact lands off-spec | `/Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/calasia-construction/calasia-callbrief-2026-08-05.md` (`2026-08-03T17:03:15-0700`) |
| `frank2/check-approvals` | `2h` | `true` | `DETERMINISTIC` | inline approval check | `N/A` — prompt is `"list-approvals"` + reminders only | `NONE` durable file |
| `frank2/human-tasks-check` | `4h` | `true` | `DETERMINISTIC` | inline human-task counter | `N/A` — prompt explicitly says `"SILENT-ONLY, no Telegram, ever"` and logs counts only | `NONE` durable file |
| `frank2/fleet-reconcile` | `15m` | `true` | `LLM-MECHANICAL` | `orgs/clearworksai/agents/frank2/.claude/skills/fleet-reconcile-worker/SKILL.md` | `N/A` — worker path only in cron prompt | `NONE` durable file identified from the cron prompt alone |
| `crm/fireflies-ingest` | `2h` | `true` | `DETERMINISTIC` | inline CRM ingest job | `N/A` — prompt says `"Save raw transcript link + summary to meetings/YYYY-MM-DD-<slug>.md"` | `orgs/clearworksai/agents/crm/meetings/2026-08-04-cw-msia-catchup.md` (`2026-08-04T19:03:23-0700`) |
| `crm/deal-enrichment` | `0 2 * * 2-6` | `true` | `LLM-MECHANICAL` | inline enrichment + knox dossier job | `N/A` — prompt says `"Write dossier to meetings/YYYY-MM-DD-<contact-slug>-dossier.md"` | `orgs/clearworksai/agents/crm/meetings/2026-06-27-amara-norman-dossier.md` (`2026-06-27T02:02:07-0700`) |

### P5-C

| cron | schedule | enabled | kind | supposed SKILL.md / job | prompt-to-destination alignment | newest durable artifact |
|---|---|---:|---|---|---|---|
| `pa/morning-brief` | `3 8 * * 1-5` | `true` | `DETERMINISTIC` | `orgs/clearworksai/agents/pa/scripts/morning-brief.sh` | `N/A` — shell script only | `NONE` durable file audited here |
| `pa/evening-wrap` | `2 17 * * 1-5` | `true` | `LLM-JUDGMENT` | inline wrap job | `N/A` — prompt writes `/tmp/evening-wrap-content.md`, then sends dashboard URL | `NONE` durable repo file |
| `frank2/weekly-review` | `3 18 * * 5` | `true` | `LLM-JUDGMENT` | `orgs/clearworksai/agents/frank2/.claude/skills/weekly-review/SKILL.md` | `NO` — live prompt writes `/tmp/weekly-review-content.md`; the config-only version had the pipeline append and durable report path | `NONE` durable file named by the live prompt |
| `frank2/weekly-prep` | `7 14 * * 6` | `true` | `LLM-JUDGMENT` | inline prep job | `N/A` — prompt writes `/tmp/weekly-prep-content.md` then publishes dashboard | `NONE` durable repo file |
| `frank2/weekly-synthesis` | `3 16 * * 5` | `true` | `LLM-JUDGMENT` | inline synthesis job | `YES` — prompt says `"Write to ~/code/knowledge-sync/cc/synthesis/week-of-YYYY-MM-DD.md"` | `/Users/joshweiss/code/knowledge-sync/cc/synthesis/week-of-2026-07-27.md` (`2026-07-31T16:04:34-0700`) |
| `frank2/weekly-cleanup` | `3 10 * * 0` | `true` | `LLM-JUDGMENT` | inline cleanup job | `N/A` — prompt edits tasks and sends Telegram only | `NONE` durable file |
| `frank2/client-health` | `4 9 * * 3` | `true` | `LLM-JUDGMENT` | customer-success-manager-adjacent | `NO` — prompt says `"Telegram to 6690120787"` and route remediation; no `outputs/customer-success-manager/` path | `NONE` durable file |
| `frank2/pipeline-review` | `3 15 * * 4` | `true` | `LLM-JUDGMENT` | pipeline-operations-manager-adjacent | `NO` — prompt says `"Summarize"` and `"send-message crm"`; no `outputs/pipeline-operations-manager/` path | `NONE` durable file |
| `frank2/nightly-fleet-analysis` | `3 2 * * *` | `true` | `LLM-JUDGMENT` | inline fleet analysis | `N/A` — prompt says `"Write to memory/$(date -u +%Y-%m-%d).md"` | `orgs/clearworksai/agents/frank2/memory/2026-08-04.md` (`2026-08-04T04:37:16-0700`) |
| `frank2/daily-ops-dashboard` | `5 15 * * *` | `true` | `DETERMINISTIC` | inline dashboard publisher | `N/A` — dashboard build + Telegram only | `NONE` durable local file |
| `frank2/outreach-check` | `2 10 * * 1,3,5` | `true` | `LLM-JUDGMENT` | inline outreach review | `N/A` — prompt creates tasks / sends messages, no file artifact | `NONE` durable file |
| `frank2/daily-wiki-prep` | `7 2 * * *` | `true` | `DETERMINISTIC` | inline wiki synthesis script | `N/A` — prompt runs `python3 scripts/wiki-synthesis.py` and commits wiki changes | `NONE` single durable artifact isolated in this audit |
| `frank2/daily-trending-repos` | `30 16 * * 1-5` | `true` | `LLM-JUDGMENT` | inline trending job reusing `~/.claude/skills/codebase-reference/SKILL.md` | `YES` — prompt says `"Update memory/trending-picks.json"` | `orgs/clearworksai/agents/frank2/memory/trending-picks.json` (`2026-08-04T16:46:41-0700`) |
| `frank2/session-archaeology` | `0 17 * * 0` | `true` | `LLM-JUDGMENT` | inline session synthesis | `YES` — prompt says `"Write output to .../memory/session-archaeology-$(date +%Y-%m-%d).md"` | `orgs/clearworksai/agents/frank2/memory/session-archaeology-2026-08-02.md` (`2026-08-02T17:01:45-0700`) |
| `sage/theta-wave` | `0 9 * * 0` | `true` | `LLM-JUDGMENT` | `orgs/clearworksai/agents/sage/.claude/skills/theta-wave/SKILL.md` | `YES` — prompt says `"Write weekly memory: memory/weekly-$(date +%Y-W%V).md"` | `orgs/clearworksai/agents/sage/memory/weekly-2026-W31.md` (`2026-08-02T09:02:53-0700`) |
| `sage/usage-monitor` | `2h` | `true` | `DETERMINISTIC` | inline usage threshold check | `YES` — prompt says `"Always log the current levels in your daily memory"` | `orgs/clearworksai/agents/sage/memory/2026-08-05.md` (`2026-08-04T19:44:02-0700`) |
| `crm/daily-checkin` | `0 8 * * 1-5` | `true` | `DETERMINISTIC` | inline CRM check-in | `N/A` — Telegram/log only | `NONE` durable file |
| `crm/weekly-brief` | `0 9 * * 1` | `true` | `DETERMINISTIC` | inline pipeline brief | `N/A` — Telegram/log only | `NONE` durable file |
| `crm/fireflies-weekly-sweep` | `0 17 * * 5` | `true` | `DETERMINISTIC` | inline Fireflies sweep | `N/A` — prompt may save `meetings/YYYY-MM-DD-<slug>.md`, but this cron has `fire_count=0` in the current live log sample | `NONE` proven from a live fire in this audit |
| `larry/upstream-sync` | `0 9 * * 1` | `true` | `DETERMINISTIC` | inline upstream status check | `N/A` — Telegram only | `NONE` durable file |
| `larry/kb-reconcile-nightly` | `37 3 * * *` | `true` | `DETERMINISTIC` | `orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh` | `YES` for the script path it actually names — prompt says `"run bash $CTX_AGENT_DIR/bin/kb-reconcile-nightly.sh"` and `"the script writes its own ledger row"` | `orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl` (`2026-08-04T08:27:04-0700`) |

## Config-vs-Live Cron Reconciliation

Real total live cron count: `81`

| agent | in-config-only | in-live-only | in-both |
|---|---|---|---|
| `academy` | `content-audit,daily-research,heartbeat,theta-research,trend-synthesis` | `-` | `-` |
| `auditmaster` | `-` | `gbrain-graph-refresh` | `heartbeat` |
| `auditmaster-codex` | `heartbeat` | `-` | `-` |
| `auditos` | `heartbeat,verify-gate-check` | `-` | `-` |
| `auditos2` | `heartbeat` | `-` | `-` |
| `automator` | `-` | `-` | `-` |
| `crm` | `records-admin-sweep` | `zoom-officehours-reconcile` | `daily-checkin,deal-enrichment,fireflies-ingest,fireflies-weekly-sweep,heartbeat,weekly-brief` |
| `frank2` | `signal-sweep` | `-` | `check-approvals,client-health,daily-ops-dashboard,daily-trending-repos,daily-wiki-prep,fleet-reconcile,heartbeat,human-tasks-check,meeting-commitments,nightly-fleet-analysis,outreach-check,pipeline-review,pre-meeting-brief,pre-meeting-brief-page,session-archaeology,transcript-scanner,weekly-cleanup,weekly-prep,weekly-review,weekly-synthesis` |
| `frank2-codex` | `check-approvals,client-health,comms-check,daily-improvement-dispatch,daily-ops-dashboard,daily-trending-repos,daily-wiki-prep,evening-wrap,ff-extractor,fleet-reconcile,forgot-anything,heartbeat,human-tasks-check,meeting-commitments,midday-blockers,milestone-check,morning-brief,nightly-fleet-analysis,os-capability-scan,outreach-check,pipeline-review,pre-meeting-brief,pre-meeting-brief-page,session-archaeology,theta-wave,todoist-health-check,transcript-scanner,weekly-cleanup,weekly-prep,weekly-review,weekly-synthesis` | `-` | `-` |
| `hunter` | `-` | `-` | `-` |
| `knox` | `-` | `-` | `daily-research-brief,heartbeat,research-pulse-delta,research-quality-review,topic-briefing,weekly-trends-review` |
| `knox-codex` | `daily-research-brief,heartbeat,research-pulse-delta,research-quality-review,topic-briefing,weekly-trends-review` | `-` | `-` |
| `larry` | `kb-maintenance-digest,kb-maintenance-sweep,playwright-coverage,production-stack-sweep` | `sweep-due-tasks` | `claude-mem-export,cxportal-pull-nightly,dependency-audit,heartbeat,kb-reconcile-nightly,pipeline-bypass-audit,plan-adherence-audit,pr-review-reminder,release-coordinator,repo-health,staging-health,test-status,upstream-sync,uptime-check,usage-audit,weekly-security-audit` |
| `larry-codex` | `claude-mem-export,cxportal-pull-nightly,dependency-audit,heartbeat,kb-maintenance-digest,kb-maintenance-sweep,kb-reconcile-nightly,pipeline-bypass-audit,plan-adherence-audit,playwright-coverage,pr-review-reminder,production-stack-sweep,release-coordinator,repo-health,staging-health,test-status,upstream-sync,uptime-check,usage-audit,weekly-security-audit` | `-` | `-` |
| `maven` | `-` | `daytime-heartbeat` | `heartbeat` |
| `muse` | `-` | `fleet-activity-intel,morning-digest` | `heartbeat` |
| `opencode` | `-` | `-` | `-` |
| `pa` | `-` | `ff-extractor,meeting-recap-draft` | `comms-check,evening-wrap,heartbeat,morning-brief` |
| `sage` | `-` | `usage-monitor` | `auto-commit,catalog-browse,check-upstream,daily-system-analysis,experiment-loop,fleet-health-check,heartbeat,nightly-metrics,theta-wave,weekly-audit,weekly-kpi-commits` |
| `scout` | `-` | `creator-expansion,morning-digest,regulars-tracker` | `heartbeat` |
| `sre` | `-` | `-` | `-` |

## Still Unproven / Live Tests Required

### `knowledge-base`

Status: `BLOCKED-NEEDS-LIVE-RUN`

Exact one-command live test:

```bash
cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/larry && bash bin/kb-reconcile-nightly.sh
```

What it would touch:

- `orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl`
- `~/.cortextos/cortextos1/orgs/clearworksai/knowledge-base/chromadb/`
- `~/.cortextos/cortextos1/orgs/clearworksai/knowledge-base/embedding-cache.sqlite`
- outputs of `agent-memory-mirror.sh`
- outputs of `cortextos bus kb-extract-edges --org clearworksai --json`

Why I did not run it:

- It would mutate live KB state and violate the run boundary.
