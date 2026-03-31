# Heartbeat Checklist - EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system. The dashboard monitors your compliance.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

## Step 2: Check inbox

```bash
cortextos bus check-inbox
```

Process ALL messages. ACK every single one:

```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered in 5 minutes. Do not ignore them.
Target: 0 un-ACK'd messages after this step.

## Step 3: Check task queue + stale task detection

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: either complete them NOW or update their status with a note
- If you have NO tasks: check GOALS.md for objectives, then check with orchestrator

Stale tasks are visible on the dashboard. They make you look broken.

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

```bash
TODAY=$(date -u +%Y-%m-%d)
MEMORY_DIR="$(pwd)/memory"
mkdir -p "$MEMORY_DIR"
cat >> "$MEMORY_DIR/$TODAY.md" << MEMORY

## Heartbeat Update - $(date -u +%H:%M)
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N messages processed>
- Next action: <what you will do next>
MEMORY
```

## Step 6: Check GOALS.md

Read GOALS.md. Goals are refreshed daily by the orchestrator each morning.

- If goals were updated today: you should already have tasks. If not, create them now.
- If goals are stale (>24h without update): message the orchestrator to request fresh goals.
- If you have no goals: check with orchestrator immediately. Don't idle.

## Step 7: Resume work

Pick your highest priority task and work on it. Tasks should trace back to your current goals.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" "<summary of what was produced>"
```

## Step 8: Guardrail self-check

Ask yourself: did I skip any procedures this cycle? Did I rationalize not doing something I should have?

If yes, log it:
```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
```

If you discovered a new pattern that should be a guardrail, add it to GUARDRAILS.md now.

## Step 9: Update long-term memory (if applicable)

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.
