# Guardrails

Read this file on every session start. Full reference: `.claude/skills/guardrails-reference/SKILL.md`

---

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip this one, I just updated recently" | Always update heartbeat on schedule. No exceptions. The dashboard tracks staleness. |
| Starting work | "This is too small for a task entry" | Every significant piece of work gets a task. If it takes more than 10 minutes, it's significant. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. Context you don't write down is context the next session loses. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages redeliver and block other agents. |
| Bus script available | "I'll handle this directly instead of using the bus" | Use the bus script. Work that doesn't go through the bus is invisible to the system. |

## Specialist Agent Patterns

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Task assigned to me | "I'll get to it later" | ACK and start within one heartbeat cycle. Stale tasks make you look broken. |
| Blocked on something | "I'll wait and see" | Create a blocker task or escalate to orchestrator immediately. Silent blockers are invisible. |
| Work finished | "Orchestrator will notice" | Complete the task and log the event now. Unlogged completions don't exist. |

For the complete red flag table (15 patterns), see `.claude/skills/guardrails-reference/SKILL.md`.

---

## How to Use

1. **On boot**: Read this table. Internalize the patterns.
2. **During work**: When you notice yourself thinking a red flag thought, stop and follow the required action.
3. **On heartbeat**: Self-check - did I hit any guardrails this cycle? If yes, log it:
   ```bash
   cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
   ```
4. **When you discover a new pattern**: Add a new row to the table in `.claude/skills/guardrails-reference/SKILL.md`. The file improves over time.

---

## Adding Guardrails

If you catch yourself almost skipping something important that isn't in the table, add it to the skill file. Format:

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| [situation] | "[what you almost told yourself]" | [what you must do instead] |


---

## Bash Hang Prevention (added 2026-05-02 after Larry-stuck-12-hours incident)

**Never write Bash commands that can hang indefinitely.** This is the #1 cause of agents going silent — claude blocks on the Bash tool waiting for the command to complete, while cron prompts and Telegram messages queue up behind it. From outside, you appear "frozen" or "typing forever." From inside, you are genuinely stuck.

| Trigger | Red Flag Thought | Required Action |
|---------|------------------|-----------------|
| Writing `until <cond>; do <body>; done` | "It will eventually succeed" | NEVER unbounded. Add a max-iteration counter: `for i in {1..30}; do <body>; <cond> && break; sleep N; done` |
| Writing `while true; do ... done` | "I will just sleep between attempts" | Always cap. `for i in {1..N}` instead of `while true`. |
| Calling `curl` to wait for a remote condition | "It will return when ready" | Always set `--max-time 30` (or appropriate cap). Never let curl hang. |
| Polling an endpoint until it returns success | "Just sleep and retry forever" | Cap iterations AND total wall-clock. After 5-10 minutes max, give up and report status. |
| Long-running external job (build, deploy, extraction) | "I will tail logs / poll until done" | Spawn the job, return the task_id, and exit the turn. Let a separate cron poll status. Do NOT block your own session waiting. |
| `tail -f`, `watch`, `inotifywait -m` | "I need to see the next event" | Never invoke these from a Bash tool call. Use one-shot reads instead. |
| Need to wait for AuditOS Phase 1 / similar long task | "I will wait here and check periodically" | Hand off to a cron. Phase 1 takes 20+ min — way longer than a single tool call should hold the session. Schedule a check-back via `cortextos bus create-reminder` or similar. |

**Why this is non-negotiable:** Every Bash tool call blocks claude until it returns. While blocked, no other input can be processed — your inbox queues, your crons queue, the user gets silence on Telegram. A single unbounded loop turns a healthy agent into a brick.

**If you find yourself reaching for an unbounded loop:** stop, set a hard ceiling, and accept that "the job might not be done when you check" is the correct answer — with a follow-up scheduled.
