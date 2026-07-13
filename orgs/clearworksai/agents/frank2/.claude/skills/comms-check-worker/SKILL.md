# Comms Check Worker

You are a SHORT-LIVED WORKER SESSION. Your only job is comms triage. Complete it and stop.

DO NOT:
- Read IDENTITY.md, SOUL.md, GUARDRAILS.md, GOALS.md, HEARTBEAT.md, or any bootstrap files
- Update heartbeat
- Write to daily memory
- Send "OK" confirmations or progress narration to anyone
- Explain what you're doing

DO:
- Run the checks below
- Send Telegram to 6690120787 only if ACTIONABLE items found
- Create HUMAN kanban tasks for items that need Josh
- Output DONE when complete

---

## Step 1 — Task + dedup setup (Bash, run first)

```bash
TASK_ID=$(cortextos bus create-task "Cron: comms-check" --desc "Comms check: Gmail, iMessage, GitHub CI" 2>/dev/null)
cortextos bus update-task $TASK_ID in_progress 2>/dev/null
cortextos bus update-cron-fire comms-check --interval 15m 2>/dev/null
```

Dedup is now DETERMINISTIC and upstream of your reasoning: in Step 2 the raw Gmail
fetch JSON is piped through `cortextos bus comms-filter`, which drops any message
whose source id was already surfaced. You never see an already-announced email, so
you cannot re-announce it — there is no honor-system step to forget. No surfaced.txt
file, no manual per-thread holds.

---

## Step 2 — Run checks in parallel

**HARD EXCLUSIONS** (skip entirely, mark as seen in dedup, no Telegram):
- Subject starts with 'Accepted:', 'Declined:', or 'Tentative:' — calendar noise. Do an explicit fire-once record-then-skip: `cortextos bus event-dedup --source "gmail:${MSG_ID}" --fire-once >/dev/null` then skip. Calendar accepts/confirms are fire-once events: one inbound acceptance email (e.g. 'Alloi Interview #4 confirmed: Bassem Dawod accepted') = at most one lifetime handling, never re-surfaced regardless of rewording or re-run. The source key is the acceptance EMAIL's message id (calendar accepts arrive as emails), not a text hash.
- from:noreply@skool.com, from:events@tailscale.com, from:hello@mindstream.news, any newsletter/digest
- from:sanebox.com (SaneBox filter)
- Any webinar or Skool event invite
- Mercury bank notifications, vendor "any thoughts on our demo" sales follow-ups
- Any zcal booking confirmation or calendar meeting notification — these go on the calendar automatically. Do an explicit fire-once record-then-skip: `cortextos bus event-dedup --source "gmail:${MSG_ID}" --fire-once >/dev/null` then skip. Fire-once = at most one lifetime handling, never re-surfaced regardless of rewording or re-run; the source key is the confirmation EMAIL's message id, not a text hash.
- from:notify.railway.app (and any Railway "Deployment crashed" / deploy alert) — DO NOT surface to Josh and DO NOT route to Larry. Railway/CI infra alerts reach Larry directly via the repo-health cron + Railway CLI/MCP; routing them here just re-pings Larry every cycle for the same stale email. Skip entirely, mark as seen.
- CI / GitHub Actions failure alerts for any cortextos repo (`clearworks-ai/cortextos` or `grandamenium/cortextos`) — DO NOT surface to Josh and DO NOT route to Larry. Larry gets CI health directly via the repo-health cron + `gh` CLI; routing build/type-check/test-run failures here just re-pings Larry every cycle, often for a stale or already-superseded run. Skip entirely, mark as seen. (Durable replacement in flight: PR #40 adds `cortextos bus ci-alert-gate` for a deterministic surface/skip decision; until it merges, do not emit CI-failure alerts from this worker at all.)

**OOO / AUTO-REPLY EXCLUSIONS** (skip silently — these are never actionable):
After reading headers for any email, check subject and sender patterns BEFORE surfacing:
- Subject contains (case-insensitive): "out of office", "auto-reply", "auto reply", "automatic reply", "away from", "i am out", "i'm out", "OOO:", "vacation reply", "on leave", "currently unavailable", "be back", "returning on"
- Header Auto-Submitted contains "auto-replied" or "auto-generated"
- From address contains "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon"
- If ANY of these match: skip silently. OOO replies require zero action.

**COLD INBOUND SPAM EXCLUSIONS** (skip silently — unsolicited sales outreach is not actionable):
After reading subject/body, skip if the email matches cold outreach patterns:
- Subject or body contains phrases like: "would love to connect", "quick question", "partnership opportunity", "I came across your", "reach out about", "free demo", "schedule a call", "let me know if you're interested", "synergy", "just checking in" from unknown senders
- Sender domain is a known SaaS vendor (egnyte.com and similar) sending partnership/demo requests
- Email is clearly a mass or templated outreach (merge fields visible, generic opener with no specific context about Josh)
- Rule: if you don't recognize the sender as someone Josh has a real relationship with AND the email reads like a template, skip it.

Run these 4 checks (Bash):

1. **AP INVOICES**: `gws gmail +triage --query 'to:ap@clearworks.ai newer_than:3d' --format json | cortextos bus comms-filter --namespace gmail`
   The `comms-filter` pipe drops any invoice email already surfaced in a prior cycle — you only ever see first-seen items.
   Skip auto-renewing subs (CalendarBridge, Senja, Google Workspace, Supabase).
   For real AP: `gws gmail +read --id <id> --headers` to extract vendor, amount, payment link, due date.

2. **JOSH INBOX**: `gws gmail +triage --query 'is:unread newer_than:1h -category:promotions -category:social -from:notify.railway.app' --format json | cortextos bus comms-filter --namespace gmail`
   The `comms-filter` pipe is the real protection layer: it records each message id in the shared dedup ledger and emits only messages not seen before, so an already-announced email (e.g. the Bones-skills thread) can never reach you a second time regardless of rewording.
   For each result: `gws gmail +read --id <id> --headers` to get content.

3. **GITHUB CI FAILURES**: `gws gmail +triage --query 'from:notifications@github.com subject:"Run failed" newer_than:6h' --format json`
   Group by repo.
   **Before surfacing any CI failure**, run ALL of the following gates. Skip silently if ANY gate fires:

   **GATE A — Branch already merged/closed:**
   - Extract repo and branch from the email (e.g. `clearworks-ai/cortextos` on `fix/daemon-context-handoff-race`)
   - `gh pr list --repo <owner>/<repo> --state all --head <branch> --json state,number | jq -r '.[0].state // "NOTFOUND"'`
   - If state is `MERGED` or `CLOSED`: skip silently

   **GATE B — Head SHA is behind or identical to main (HARD GATE — catches merged branches even when PR lookup fails):**
   - Extract the run ID from the email URL (e.g. `github.com/<owner>/<repo>/actions/runs/<run_id>`)
   - Get the head SHA: `gh run view <run_id> --repo <owner>/<repo> --json headSha -q '.headSha' 2>/dev/null`
   - Compare against main: `gh api repos/<owner>/<repo>/compare/main...<head_sha> --jq '.status' 2>/dev/null`
   - If status is `"behind"` or `"identical"`: skip silently — this SHA is already incorporated into main
   - Example: run 28336892710 on fix/daemon-context-handoff-race (merged as PR #29 → b8ee112) would show status "behind" and MUST be skipped

   **GATE C — Newer run already succeeded:**
   - `gh run list --repo <owner>/<repo> --branch <branch> --limit 5 --json conclusion | jq '[.[].conclusion] | any(. == "success")'`
   - If true: skip silently

   **GATE D — Same run already alerted (dedup — kills repeat spam for one failing run):**
   - Using the `<run_id>` extracted in GATE B, run the deterministic gate WITH `--run-id`:
     `cortextos bus ci-alert-gate --repo <owner>/<repo> --branch <branch> --head-sha <head_sha> --run-id <run_id> --json`
   - This folds gates A/B/C AND per-run dedup into one call. If it prints `{"surface":false,...}` (any reason, including `already alerted (dedup)`): skip silently.
   - It records the run id on the FIRST surface only, so the 2nd..Nth "Run failed" email for the same run (different message ids, reworded text) all SKIP. Root CI failure is unaffected — this only suppresses duplicate alerts for an already-surfaced run.

   Only alert on failures where ALL gates pass (`ci-alert-gate --run-id` prints `surface:true`): PR still OPEN, SHA not behind main, no subsequent success, and this run not already alerted.

4. **iMESSAGE**: Use mcp imessage tool — only flag messages timestamped within the last 30 min.

---

## Step 3 — Dedup already happened (no per-item gate to run)

There is no manual dedup step here anymore. In Step 2 every Gmail fetch was piped through
`cortextos bus comms-filter`, which keys on the SOURCE EVENT identity (namespace + message
id) and atomically records-and-drops anything already surfaced. Rewording the same inbound
does NOT make it new — the id is immutable, so the filter has already removed it before you
saw it. Nothing you do in reasoning can re-surface a previously announced email.

For the fire-once carve-outs (calendar accepts / zcal confirmations) the exclusion rules in
Step 2 still call `cortextos bus event-dedup --source "gmail:${MSG_ID}" --fire-once` to
permanently suppress those specific noise classes.

---

## Step 4 — Pre-surface commitment check

Before surfacing any "Josh owes someone something" item:
```bash
gws gmail +triage --query 'from:josh@clearworks.ai to:<recipient> newer_than:14d' --format json
```
If sent mail found covering the commitment, drop it silently.

---

## Step 4b — Task creation guardrails (apply BEFORE creating any [HUMAN] task)

Before creating any task, verify ALL of the following:

1. **It requires a human action** — Josh must personally do something (pay, reply, send, decide, review). If it's something an agent can do (route, dispatch, research), do it yourself — do NOT create a HUMAN task.
2. **It is not conditional on a future event** — "after contract signing", "once X happens", "when Y is ready" = do NOT create. Wait until the condition is met.
3. **It is not already in the bus** — run: `cortextos bus list-tasks --format json | python3 -c "import json,sys; tasks=json.load(sys.stdin); [print(t['title']) for t in tasks if '[HUMAN]' in t.get('title','') and t.get('status') != 'completed']"` — if a similar task exists, skip creation.
4. **It is not a calendar event** — meetings, calls, zcal bookings are on the calendar. No task.
5. **It is not already sent/completed** — if Josh sent a reply or the action is visibly done (check sent mail), skip.

If ANY check fails → do NOT create the task.

---

## Step 5 — Handle results

- **AP invoices** → Telegram 6690120787 + create task:
  `cortextos bus create-task "[HUMAN] Pay [vendor] $[amount] by [due_date]" --assignee human --project human-tasks`

- **Railway/CI failures** → FIRST check the sender. If the email is from `notify.railway.app` (any "Deployment crashed" / deploy / redeploy notice), it is a HARD EXCLUSION (see top of file): SKIP entirely, mark as seen, do NOT route to Larry and do NOT Telegram Josh. Larry already gets real Railway health via the repo-health cron + Railway CLI/MCP; routing these here just re-pings him every cycle for the same stale email. This carve-out overrides the routing rule below.
  For a genuine CI failure from a NON-`notify.railway.app` source (e.g. GitHub Actions): NEVER send raw alerts to Josh (6690120787). Route directly to Larry:
  `cortextos bus send-message larry normal 'CI alert: [repo] [branch] — [brief description]. Please investigate and diagnose.'`
  Josh gets ONLY the diagnosis + fix from Larry, never the raw alert. If Larry is offline/unreachable, log silently and retry next cycle.

- **Action-item emails** → Telegram + create task:
  `cortextos bus create-task "[HUMAN] [action item]" --assignee human --project human-tasks`

- **Meeting confirmations / zcal bookings** → SKIP. They are already on the calendar. Do NOT create a task. Do NOT send Telegram.

- **Needs response** → Telegram with draft response.

- **Nothing new** → `cortextos bus log-event action comms_check_ok info --meta '{"agent":"frank2"}'` — NO Telegram.

---

## Step 6 — Complete and exit

```bash
cortextos bus complete-task $TASK_ID --result "Comms check complete"
cortextos bus log-event action cron_completed info --meta '{"cron":"comms-check","agent":"frank2"}'
# FINAL — self-terminate this worker PTY so it does not leak (worker-leak fix #25)
cortextos terminate-worker "$CTX_AGENT_NAME"
```

Output literally: `DONE`
