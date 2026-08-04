# Comms Check Worker

<!-- PUSH LISTENER NOTE (added feat/gmail-push-comms):
     gmail_push_listener.py is the PRIMARY trigger for this worker. It polls
     Gmail history every 60s, debounces 120s, then spawns this worker on new
     actionable inbox messages. This cron fires every 4h as a missed-event
     safety-net sweep. The shared comms-event-dedup ledger makes double-fire
     harmless — whichever trigger fires first wins; the other is a no-op.
-->

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
TASK_ID=$(cortextos bus create-task "Cron: comms-check" --desc "Comms check: Gmail, iMessage, GitHub CI" --assignee "${CTX_PARENT_AGENT:-frank2}" 2>/dev/null)
cortextos bus update-task $TASK_ID in_progress 2>/dev/null
cortextos bus update-cron-fire comms-check --interval 4h 2>/dev/null
```

Dedup is DETERMINISTIC and upstream of your reasoning: in Step 2 you filter the Josh-inbox
Gmail fetch through `cortextos bus comms-filter --namespace gmail`, which records each gmail
message id and emits only first-seen items (NO auto-send — the `--surface` auto-send path was
reverted with PR#131 on 2026-07-25 because it bypassed your exclusion rules).

Every EXACT sender/subject exclusion (the ones that leaked on 2026-07-25 — info@raisedonors.com,
receipts@openrouter.ai) is now enforced INSIDE the Gmail query itself (Step 2.2a) via `-from:`/
`-subject:` operators — this is Gmail's own deterministic search engine, the same mechanism
already proven for the railway carve-out, not a new code gate. It cannot be skipped by judgment
because the excluded mail never comes back from the fetch. Step 2b is judgment-only for the
handful of checks that genuinely can't be expressed as an exact query term (cold-inbound spam
phrasing, "is this a known relationship" calls). Send Telegram only for surviving real mail (Step 2d).

---

## Step 2 — Run checks in parallel

**HARD EXCLUSIONS — ENFORCED AT THE QUERY (Step 2.2a), not by judgment:**
Every sender/domain/subject-prefix below is baked into the Gmail search query itself, so this
mail never comes back from the fetch — nothing to misjudge:
- `noreply@skool.com`, `events@tailscale.com`, `hello@mindstream.news`
- `sanebox.com` (SaneBox filter)
- `notify.railway.app` (any Railway deploy/crash alert) — Larry gets Railway health via the repo-health cron + Railway CLI/MCP; this worker never routes it anywhere
- `info@raisedonors.com`, `receipts@openrouter.ai` — the two that leaked 2026-07-25
- generic transactional patterns: `noreply`, `no-reply`, `donotreply`, `do-not-reply`, `mailer-daemon`
- bulk-mail platform domains: `beehiiv.com`, `mailchimp.com`, `substack.com`, `convertkit.com`
- subject prefixes: `Accepted:`, `Declined:`, `Tentative:` (calendar noise), `out of office`, `auto-reply`, `automatic reply`, `OOO:`, `vacation reply`
- CI / GitHub Actions failure alerts for any cortextos repo — routed via GATE D below (`cortextos bus ci-alert-gate`, shipped), never by judgment.

For calendar accepts / zcal confirmations specifically (query catches the subject prefix, but
zcal confirmation subjects vary), still record fire-once so re-wordings never resurface:
`cortextos bus event-dedup --source "gmail:${MSG_ID}" --fire-once >/dev/null` then skip.

**REMAINING JUDGMENT CALLS** (cannot be expressed as an exact query term — apply in Step 2b):
- Webinar/Skool event invites and Mercury bank notifications by BODY content (not sender)
- Vendor "any thoughts on our demo" sales follow-ups by content
- Header `Auto-Submitted: auto-replied`/`auto-generated` (some auto-replies don't match the subject-prefix list above)

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

2. **JOSH INBOX** — TWO STEPS. Do NOT pipe the raw fetch straight into `comms-filter --surface` — that sends atomically on first-seen, before you ever get a chance to apply the exclusion rules above, which is exactly how non-human mail (automated reports, receipts) slipped through on 2026-07-25.

   a. Fetch candidates — every HARD EXCLUSION above is a `-from:`/`-subject:` term in this query, so excluded mail is never in the result set to begin with:
      `gws gmail +triage --query 'is:unread newer_than:5h -category:promotions -category:social -from:notify.railway.app -from:notifications@github.com -from:noreply@skool.com -from:events@tailscale.com -from:hello@mindstream.news -from:sanebox.com -from:info@raisedonors.com -from:receipts@openrouter.ai -from:noreply -from:no-reply -from:donotreply -from:do-not-reply -from:mailer-daemon -from:beehiiv.com -from:mailchimp.com -from:substack.com -from:convertkit.com -subject:"Accepted:" -subject:"Declined:" -subject:"Tentative:" -subject:"out of office" -subject:"auto-reply" -subject:"automatic reply" -subject:"OOO:" -subject:"vacation reply"' --format json > /tmp/josh-inbox-raw.json`

   b. Apply only the REMAINING JUDGMENT CALLS listed above (content-based webinar/Mercury/demo-followup checks, cold-inbound spam heuristics, Auto-Submitted header) to each item's `from`/`subject`/`snippet`/headers, and drop non-surviving items. Everything sender/subject-exact is already gone from the fetch — this step is judgment-only for the handful of checks that genuinely need it.
      Write the surviving items (same `{ "emails": [...] }` shape as the input) to `/tmp/josh-inbox-filtered.json`.

   c. Pipe ONLY the filtered file through the dedup filter — first-seen only, NO auto-send (the `--surface` auto-send path was reverted with PR#131 on 2026-07-25 because it bypassed your exclusion rules and leaked marketing/receipt mail):
      `cat /tmp/josh-inbox-filtered.json | cortextos bus comms-filter --namespace gmail > /tmp/josh-inbox-firstseen.json`

   d. For each item in `/tmp/josh-inbox-firstseen.json`, surface it YOURSELF with one Telegram. You have already applied every HARD / OOO / COLD-INBOUND exclusion in step 2b, so only real human mail reaches here:
      `cortextos bus send-telegram 6690120787 "New email — From: <from> | Subject: <subject> | <one-line snippet>"`
      Use `gws gmail +read --id <id> --headers` first if you need more detail for a surfaced id.

   e. **EA LANE CLASSIFICATION (proactive event-based EA — Lane A + Lane B routing).** Before/alongside surfacing, classify each first-seen human email into exactly ONE inbox-manager lane, and split out SCHEDULING-INTENT for the booking desk. This REPLACES the old binary keep/drop for Josh-inbox mail — noise is already gone (steps 2a/2b), so what survives gets a lane, not just a ping.

      First, run the deterministic SCHEDULING-INTENT detector over the surviving mail (this is the classifier seam — the SKILL prose only judges the residual ambiguous cases):
      ```bash
      cd "$CTX_AGENT_DIR"
      python3 scripts/booking_coordinator.py classify --payload /tmp/josh-inbox-firstseen.json > /tmp/josh-inbox-classified.json
      cat /tmp/josh-inbox-classified.json
      ```
      The helper returns `{scheduling_intent:[...], other:[...], candidates:[...]}`. For each item:

      | Lane | Meaning | Action |
      |------|---------|--------|
      | **NEEDS YOU** | real question/decision only Josh can answer | **draft a reply** as a Gmail draft (below), then surface with `✏ draft ready` |
      | **QUICK REPLY** | routine confirm/thanks/logistics | **draft a reply** as a Gmail draft, surface `✏ draft ready` |
      | **SCHEDULING-INTENT** | "let's find a time", reschedule, ghosted-link follow-up (from the helper's `scheduling_intent`) | route to **Lane B** (booking) — see 2f; do NOT double-draft here |
      | **WAITING** | ball in someone else's court | note only, no draft |
      | **FYI** | receipts/newsletters/cc | no draft (most already excluded upstream) |
      | **REVIEW** | money / legal / complaint / big decision | flag to Josh (Lane D / approvals), draft at most a careful holding reply |

      For **NEEDS YOU** and **QUICK REPLY** only, write a REAL Gmail draft in Josh's voice — never send, never archive:
      ```bash
      # voice from the same source the recap worker uses; threadId anchors the draft to the chain
      gws gmail +draft --to "<from>" --thread-id "<threadId>" --body "<reply in Josh's voice>"
      ```
      Voice: `orgs/clearworksai/knowledge/voice.md`. Draft-only is structural: `+draft` on the DWD shim has no send path. NEVER `+send`, NEVER a Gmail MCP tool. Leave `[NEED FROM YOU: …]` / `[CONFIRM: …]` placeholders rather than inventing a commitment (inbox-manager rule). This satisfies `always_ask: external-comms` — the draft sits in Josh's drafts folder, he sends.

   f. **SCHEDULING-INTENT → Lane B (booking desk).** For each row in the helper's `candidates` array, append it to the booking tracker and spawn the booking worker in new-booking mode (freebusy → slot-proposal DRAFT). No slot is proposed here in comms-check; the booking worker owns freebusy + the draft.
      ```bash
      cd "$CTX_AGENT_DIR"
      TRACKER="state/booking-tracker.json"; mkdir -p state; [[ -f "$TRACKER" ]] || echo '{"rows":[]}' > "$TRACKER"
      # append each candidate row (atomic write is owned by the helper; append via a tiny python merge)
      python3 - "$TRACKER" /tmp/josh-inbox-classified.json <<'PY'
import json,sys
tracker,classified=sys.argv[1],sys.argv[2]
t=json.load(open(tracker)); cands=json.load(open(classified)).get("candidates",[])
have={(r.get("thread_id"),r.get("prospect")) for r in t["rows"]}
for c in cands:
    if (c.get("thread_id"),c.get("prospect")) not in have:
        t["rows"].append(c)
import os,tempfile
fd,tmp=tempfile.mkstemp(dir="state",prefix=".booking-tracker.",suffix=".tmp")
os.write(fd,json.dumps(t,indent=2,sort_keys=True).encode()); os.close(fd); os.replace(tmp,tracker)
print(f"tracker_rows={len(t['rows'])}")
PY
      # spawn Lane B worker (drafts only) for the newly-added proposed rows
      cortextos spawn-worker "booking-$(date +%s)" --dir "$CTX_AGENT_DIR" --parent pa --prompt "Read .claude/skills/booking-coordinator-worker/SKILL.md and execute it. Mode: new-booking. Draft slot proposals for the newest proposed rows in state/booking-tracker.json. Drafts only — never send. Output DONE." 2>&1 || echo "booking spawn failed"
      ```

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
   - It records the run id on the FIRST surface only, so the 2nd..Nth "Run failed" email for the same run (different message ids, reworded text) all SKIP. Root CI failure is unaffected — this only suppresses duplicate alerts for an already-surfaced run. (Shipped: PR #106.)

   Only alert on failures where ALL gates pass (`ci-alert-gate --run-id` prints `surface:true`): PR still OPEN, SHA not behind main, no subsequent success, and this run not already alerted.

4. **iMESSAGE**: Use mcp imessage tool — only flag messages timestamped within the last 30 min.

---

## Step 3 — Dedup already happened (no per-item gate to run)

There is no manual dedup step here anymore. In Step 2 the Josh-inbox Gmail fetch is filtered through
`cortextos bus comms-filter --namespace gmail`, which keys on the SOURCE EVENT identity
(namespace + message id) and emits only first-seen emails. Rewording the same inbound does NOT make
it new — the id is immutable, so a previously-seen email never reappears in the filter output. You
surface surviving first-seen items yourself (Step 2d) AFTER applying the exclusion rules; do not
re-send anything the filter already suppressed.

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

## Step 4c — Meeting-notification gate (MANDATORY before ANY meeting Telegram)

One meeting = ONE notification, ever, within its scheduling window. A single meeting
generates many inbound emails (schedule → platform question → confirmation → meeting
link). Each email has a fresh gmail id, so comms-filter correctly shows it to you —
but that does NOT make it a fresh meeting. Before sending ANY Telegram that is a
meeting reminder, meeting notification, meeting update, or meeting-link message, you
MUST run the deterministic gate and obey it:

```bash
# Derive the meeting identity FIRST:
#   - EVENT_ID: the calendar event id, when the notice comes from (or matches) a
#     calendar event. Always preferred.
#   - Fallback: MEETING_TITLE = the meeting's title (strip Re:/Fwd: mentally — the
#     gate normalizes case/punctuation deterministically) and MEETING_DATE = the
#     MEETING's local date as YYYY-MM-DD (the day the meeting happens, NOT the day
#     the email arrived).
if [ -n "$EVENT_ID" ]; then
  GATE=$(cortextos bus meeting-alert-gate --event-id "$EVENT_ID" --json)
else
  GATE=$(cortextos bus meeting-alert-gate --subject "$MEETING_TITLE" --date "$MEETING_DATE" --json)
fi
echo "$GATE"
```

- If the output contains `"surface":false` → SKIP the Telegram entirely. Do not
  reword it, do not summarize it, do not fold it into another message. The meeting
  was already announced; a new email about the same meeting is not news.
- If `"surface":true` → send exactly one Telegram for this meeting. The gate has now
  recorded the meeting key; every later email about the same meeting will gate false.
- The gate records on the FIRST surface only and keys on the MEETING (calendar event
  id, or normalized title + meeting date) — so 4 differently-worded emails about the
  same Thursday 10 AM meeting collapse to one ping, while two different meetings on
  the same day each still surface once.

---

## Step 5 — Handle results

- **AP invoices** → Telegram 6690120787 + create task:
  `cortextos bus create-task "[HUMAN] Pay [vendor] $[amount] by [due_date]" --assignee human --project human-tasks`

- **Railway/CI failures** → FIRST check the sender. If the email is from `notify.railway.app` (any "Deployment crashed" / deploy / redeploy notice), it is a HARD EXCLUSION (see top of file): SKIP entirely, mark as seen, do NOT route to Larry and do NOT Telegram Josh. Larry already gets real Railway health via the repo-health cron + Railway CLI/MCP; routing these here just re-pings him every cycle for the same stale email. This carve-out overrides the routing rule below.
  For a genuine CI failure from a NON-`notify.railway.app` source (e.g. GitHub Actions): NEVER send raw alerts to Josh (6690120787). Route directly to Larry:
  `cortextos bus send-message larry normal 'CI alert: [repo] [branch] — [brief description]. Please investigate and diagnose.'`
  Josh gets ONLY the diagnosis + fix from Larry, never the raw alert. If Larry is offline/unreachable, log silently and retry next cycle.

- **Meeting reminders / meeting updates** → gated by Step 4c. Only a
  `"surface":true` result may produce a Telegram, and only ONE per meeting. On
  `"surface":false`, skip silently — no task, no summary, no reworded follow-up.

- **Action-item emails** → Telegram + create task:
  `cortextos bus create-task "[HUMAN] [action item]" --assignee human --project human-tasks`

- **Meeting confirmations / zcal bookings** → SKIP. They are already on the calendar. Do NOT create a task. Do NOT send Telegram. If you nonetheless judge a meeting notice worth surfacing (e.g. a new external meeting Josh may not have seen), it MUST pass the Step 4c meeting-alert-gate first.

- **Needs response** → Telegram with draft response.

- **Nothing new** → `cortextos bus log-event action comms_check_ok info --meta '{"agent":"frank2"}'` — NO Telegram.

---

## Step 5.5 — No-show sweep (EA Lane B / E5 — cheap state read every fire)

A booked call whose `call_time + 45 min` has passed with NO Fireflies transcript
close-out is a no-show. We detect this from the ABSENCE of a transcript (a signal we
uniquely have), not from a human reporting it. This is a cheap read over the tracker —
no new cron.

```bash
cd "$CTX_AGENT_DIR"
[[ -f state/booking-tracker.json ]] || echo '{"rows":[]}' > state/booking-tracker.json
python3 scripts/booking_coordinator.py no-show-sweep --tracker state/booking-tracker.json > /tmp/booking-noshow.json
cat /tmp/booking-noshow.json
```

For each candidate in `/tmp/booking-noshow.json` (`action: recovery-draft` → spawn a
recovery draft; `action: stop-recovery` → advance the row to `not-now`, no draft, two
touches spent). Recovery drafts are Gmail drafts only (Lane B worker), never sends:

```bash
NEED=$(python3 -c "import json;print(len(json.load(open('/tmp/booking-noshow.json')).get('candidates',[])))" 2>/dev/null || echo 0)
if [ "$NEED" -gt 0 ]; then
  cortextos spawn-worker "booking-recovery-$(date +%s)" --dir "$CTX_AGENT_DIR" --parent pa --prompt "Read .claude/skills/booking-coordinator-worker/SKILL.md and execute it. Mode: recovery. Process /tmp/booking-noshow.json — draft no-show recovery (2-touch cap), then move exhausted rows to not-now. Drafts only. Output DONE." 2>&1 || echo "recovery spawn failed"
fi
```

---

## Step 6 — Complete and exit

```bash
cortextos bus complete-task $TASK_ID --result "Comms check complete"
cortextos bus log-event action cron_completed info --meta '{"cron":"comms-check","agent":"frank2"}'
# FINAL — self-terminate this worker PTY so it does not leak (worker-leak fix #25)
cortextos terminate-worker "$CTX_AGENT_NAME"
```

Output literally: `DONE`
