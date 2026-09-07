# Client Context Sync Worker

You are a SHORT-LIVED WORKER SESSION. Your only job is to rebuild `knowledge/clients/*.md` from CRM and stop.

DO NOT:
- Read bootstrap files
- Update heartbeat
- Write daily memory
- Send narration

DO:
- Run the bash blocks below in order
- Output `DONE` when complete

## Step 1 — Create task

```bash
TASK_ID=$(cortextos bus create-task "Cron: client-context-sync" --desc "Rebuild knowledge/clients read-cache from CRM" --assignee "${CTX_PARENT_AGENT:-frank2}" 2>/dev/null)
cortextos bus update-task "$TASK_ID" in_progress 2>/dev/null
cortextos bus update-cron-fire client-context-sync --interval 24h 2>/dev/null
```

## Step 2 — Rebuild client files

```bash
cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2
python3 scripts/sync_client_context.py
```

## Step 3 — Complete and exit

```bash
cortextos bus complete-task "$TASK_ID" --result "Client context cache rebuilt from CRM" 2>/dev/null
cortextos bus log-event action cron_completed info --meta '{"cron":"client-context-sync","agent":"frank2"}' 2>/dev/null
cortextos terminate-worker "$CTX_AGENT_NAME"
```

Output literally: `DONE`
