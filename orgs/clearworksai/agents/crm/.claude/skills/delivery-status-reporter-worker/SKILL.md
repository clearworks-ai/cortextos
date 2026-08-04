# Delivery Status Reporter Worker (Altari Phase-1 F)

<!--
  Owner split (DESIGN-F-delivery-status.md + CLIENT-ROSTER-AND-PHASES.md):
    - larry BUILDS the lane (src/bus/delivery-status.ts + this worker skill).
    - crm RUNS it — this cron lives on the crm agent (holds client data,
      interactions/followups, existing weekly-brief cron, always_ask:external-comms).
  Trigger: weekly cron (Mon AM). This is the missed-event safety-net + cadence sweep.
  NEVER auto-sends. Approve != send. A human sends. Bad/mixed news -> Josh only.
-->

You are a SHORT-LIVED WORKER SESSION. Your only job is to draft proactive client
delivery-status updates into the approval queue. Complete it and stop.

DO NOT:
- Read IDENTITY.md, SOUL.md, GUARDRAILS.md, GOALS.md, HEARTBEAT.md, or bootstrap files
- Update heartbeat or write to daily memory
- Send anything to any client, ever — no Slack, no email, no gws send
- Send "OK"/progress narration to anyone
- Fabricate a status when data is thin (skip the client instead)

DO:
- Run the blessed roster (5 clients) through the plan engine
- File drafts + create approval rows + one activity line
- Route bad/mixed news to a private Josh brief only
- Output DONE when complete

---

## Hard rules (non-negotiable — DESIGN-F §2)

1. **GOOD / NEUTRAL → client draft. BAD or MIXED → NO client draft**; write a private
   brief to Josh first (call vs email vs Josh-edited draft is HIS call). Mixed = bad.
2. **Never auto-send.** Every output is a DRAFT + an `external-comms` approval row.
   Approve = "content is right"; a HUMAN sends. There is no send path in this worker.
3. **Skip gracefully** when there's insufficient activity since `last_update`. No
   fabricated status. The plan engine returns `action: "skip"` — honor it, move on.
4. **Voice:** every good-news draft goes through **the-humanizer** skill before it
   lands (crm AGENTS.md "Voice & Writing — MANDATORY"). The plan gives you the
   skeleton; humanize the Slack + email bodies, do not ship robotic bullets.

## Blessed roster (Josh-blessed 2026-08-03 — the ONLY clients in scope)

Source of truth: `CLIENT-ROSTER-AND-PHASES.md` (5 active engagements). Do NOT report to
dormant clients.

| Client | slug | Phase | Cadence |
|---|---|---|---|
| OCG | `ocg` | 1 · Pre-sales Design | biweekly |
| Kadre | `kadre` | 1 · Pre-sales Design | biweekly |
| Alloi | `alloi` | 2 · Build / Active Delivery | weekly |
| SEIU 521 | `seiu-521` | 3 · Delivered / Monitoring | monthly |
| MSIA | `msia` | 4 · Post-delivery Follow-up | monthly |

Each client's `## Reporting` block (cadence · channel · contact · milestones ·
last_update) lives in `raw/areas/clearworks/org-brain/clients/[slug].md`.

---

## Step 1 — Task + cron bookkeeping (Bash, run first)

```bash
TASK_ID=$(cortextos bus create-task "Cron: delivery-status-reporter" \
  --desc "Weekly per-client status drafts to approval queue" \
  --assignee "${CTX_AGENT_NAME:-crm}" 2>/dev/null)
cortextos bus update-task "$TASK_ID" in_progress 2>/dev/null
cortextos bus update-cron-fire delivery-status-reporter --interval 7d 2>/dev/null
```

## Step 2 — Gather sources per client, then run the plan engine

For each blessed client, assemble what moved since `last_update` and run the
deterministic plan engine (`src/bus/delivery-status.ts` via the CLI). The engine does
gather + classify + draft-both-channels + approval-row-spec. It NEVER sends.

Sources to collect into the optional JSON inputs (all read-only):
- **org-brain History** — already read from the client file by the engine.
- **Multica issues** for the client → `--issues issues.json` (array of
  `{title,status,updated_at}`; the engine keeps only done/in_review/in_progress/blocked).
  Pull via `cortextos bus` Multica read path / your CRM notes.
- **Completed bus tasks** tagged to the client → `--tasks tasks.json`
  (`{title,completedAt}`).
- **crm interactions/followups** since last_update → `--interactions inter.json`
  (`{summary,date}`).

```bash
ROSTER="ocg kadre alloi seiu-521 msia"
KS="$HOME/code/knowledge-sync"
TODAY=$(date +%F)
for slug in $ROSTER; do
  CF="$KS/raw/areas/clearworks/org-brain/clients/$slug.md"
  [ -f "$CF" ] || { echo "skip $slug — no client file"; continue; }
  # Build optional source JSONs here (issues/tasks/interactions) from real data.
  PLAN=$(cortextos bus delivery-status-plan "$slug" "$CF" --today "$TODAY" \
           ${ISSUES:+--issues "$ISSUES"} ${TASKS:+--tasks "$TASKS"} ${INTER:+--interactions "$INTER"})
  echo "$PLAN" > "/tmp/plan-$slug.json"
done
```

The plan JSON has `action`: `draft` | `brief` | `skip`.

## Step 3 — Act on each plan (still no send)

**action = skip** → nothing to do for this client. (Optionally note it in the cadence
summary so a client gone quiet is visible.)

**action = draft** (GOOD/NEUTRAL):
1. Humanize `draft.channels.slack` and `draft.channels.email.body` via **the-humanizer**.
   Fold the humanized text back into `draft.fileContent` (both `## Slack draft` and
   `## Email draft` sections).
2. Write the file to `draft.relPath` (under the knowledge-sync repo) — the router's
   standardized `clients/[client]/status-update-YYYY-MM-DD.md`.
3. Create the approval row EXACTLY from `draft.approval`:
   ```bash
   cortextos bus create-approval "$TITLE" external-comms "$CONTEXT" \
     --client "$SLUG" --owning-job delivery-status-reporter
   ```
   This is the ONLY client-facing artifact that ever leaves this worker, and it goes to
   the dashboard `/approvals` lane — not to a client.

**action = brief** (BAD/MIXED):
1. Write `brief.fileContent` to `brief.relPath` (`status-brief-YYYY-MM-DD.md`,
   labelled HUMAN REVIEW REQUIRED).
2. Do NOT create a client-send approval and do NOT draft the client message. Surface it
   to Josh privately (Telegram brief or a needs-Josh kanban task) with the signals from
   `brief.signals`. Josh decides call vs email vs a Josh-edited draft.

## Step 4 — One activity line + close

After the loop, post ONE activity line (mission-control Reporter row — no new tables):

```bash
N=<count of drafts created>
cortextos bus post-activity "Weekly status update drafted for $N clients · pending approval"
cortextos bus complete-task "$TASK_ID" "drafted $N updates, $B briefs, $S skipped" 2>/dev/null
```

Output `DONE` and stop.

---

## Ties to Mission Control (DESIGN-F §3)

- `create-approval` rows → dashboard `/approvals` lane (the "heart of the screen").
- `post-activity` line → the "This morning, run by agents" feed.
- No new Supabase tables, no confidence scores, no auto-send — those are deferred (§4).

## What this worker will NEVER do

- Send a client message (Slack/email/gws) — approve ≠ send; a human sends.
- Draft a client message for bad/mixed news.
- Invent progress a source row doesn't support.
- Report to a client not on the blessed roster.
