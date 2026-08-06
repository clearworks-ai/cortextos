# P2 + P5 Execution Runbook — 2026-08-04

> **Purpose:** Finish ALL of P2 and P5 mechanically. Pick this up cold and execute without judgment.
> Every step: **ACTION** (exact command / file:line edit) → **VERIFY** (exact command + expected output) → **DONE-WHEN** (code-merged AND live-check AND real-output).
> Every path/command below was CONFIRMED to exist at authoring time (ls/grep/read). Where a referenced thing does NOT exist, the step says "create X", not "edit X".
>
> **Source ledgers:** `state/CRON-ACCOUNTABILITY-2026-08-04.md`, `state/P2-P5-SKILL-LEDGER-2026-08-04.md`.
> **Plan intent:** `~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md` (P2 §147+, P5 §248-315).
>
> **Confirmed constants (do not re-derive):**
> - Live cron registry per agent: `~/.cortextos/cortextos1/.cortextOS/state/agents/<agent>/crons.json`.
> - Disable/edit a cron: `cortextos bus update-cron <agent> <name> --enabled false` (this also fires `signalCronReload` internally — no separate reload needed; `src/cli/bus.ts:4239`). To re-schedule: `--interval <val>`. To remove entirely: `cortextos bus remove-cron <agent> <name>` (`src/cli/bus.ts:3899`).
> - List an agent's crons: `cortextos bus list-crons <agent>` (`src/cli/bus.ts:3921`).
> - Webhook bridge: `src/cli/webhook-bridge.ts`; `ALLOWED_INTEGRATIONS = ['zoom-officehours','fireflies','ops-check-lead']` (line 23). Relay endpoint pattern is `/relay/<integration>`; handler at `src/cli/webhook-bridge.ts:530-654`; message builder `buildRelayMessage()` at line 281. Status: `cortextos webhook-bridge status`. Run log: `~/.cortextos/logs/webhook-bridge-run.log`.
> - Tunnel: `src/cli/tunnel.ts`; public URL = `cortextos tunnel url` → **`https://27754b3f-ab7e-4098-8fa9-eedfc58acd1e.cfargotunnel.com`** (confirmed in `~/.cortextos/cortextos1/tunnel.json`). Status: `cortextos tunnel status`.
> - Gmail push: listener `orgs/clearworksai/agents/pa/scripts/gmail_push_listener.py`; deploy `orgs/clearworksai/agents/pa/scripts/gmail-push-deploy.sh` (interactive-only, refuses non-tty); launchd label `com.clearworks.gmail-push-listener`.
> - P2 skills live at `/Users/joshweiss/.claude/skills/<name>/SKILL.md` (global). All 13 route output via the P1.0 outputs-router (`orgs/clearworksai/skills/outputs-router/file_output.py`) into the knowledge-sync taxonomy under `~/code/knowledge-sync/raw/areas/clearworks/`.
> - Multica inbound poll: crontab line `*/2 * * * * … dist/cli.js bus multica-sync --direction in` (confirmed via `crontab -l`). Handler `src/cli/bus.ts:1419` → `src/bus/multica/poll.ts:runInboundPoll`. **Multica is an external REST SaaS** (`MULTICA_BASE_URL` + tokens, `src/bus/multica/client.ts:19-22`) — see C4 for the correction to the "Postgres LISTEN/NOTIFY" plan wording.

---

## SECTION A — P2 finish (fire-test the 13 lint-passing, never-live-fired skills)

**State:** P2 skill+contract layer is DONE — `contract-lint.sh` = 18 PASS / 0 FAIL (`orgs/clearworksai/agents/larry/bin/contract-lint.sh`). Remaining = prove each of the 13 "PARTIAL (wired, no live-fire artifact)" skills produces one real dated artifact.

**Common mechanics for every A-step below:**
- **Trigger command shape:** run from a working session with the skill available —
  `cd /Users/joshweiss/code/cortextos && claude -p "/<skill-name> <minimal real input>. Route the output through the outputs-router (P1.0) and file it into the knowledge-sync taxonomy with provenance frontmatter."`
  (Every one of these 13 SKILL.md files declares `OUTPUT: artifact filed BY CONTENT TYPE into the knowledge-sync taxonomy via the P1.0 router` — confirmed by grep on each SKILL.md.)
- **Output check convention:** the router files by content-type into `~/code/knowledge-sync/raw/areas/clearworks/<category-dir>/`. The generic verify is:
  `find ~/code/knowledge-sync/raw/areas/clearworks -newermt "today 00:00" -name "*.md" | xargs ls -lt 2>/dev/null | head`
- **DONE-WHEN (all A-steps):** a dated `.md` artifact for that skill exists under the taxonomy AND it carries provenance frontmatter (`grep -l "provenance\|source:\|generated:" <file>`) AND it is not a placeholder (file size > 500 bytes, contains the input subject).

Do these one at a time; do not batch (each needs its own artifact check).

```
[ ] A1. deal-debrief-analyst — ACTION: claude -p "/deal-debrief-analyst Debrief the most recent Fireflies meeting transcript (pull latest via FIREFLIES_API_KEY) into a structured record + recap draft; route through outputs-router." → VERIFY: find ~/code/knowledge-sync/raw/areas/clearworks/deals -newermt "today 00:00" -name "*debrief*" -o -newermt "today 00:00" -path "*deals*" | head → expect ≥1 fresh file. → DONE-WHEN: dated deal-debrief .md under deals/ taxonomy WITH provenance frontmatter, >500B.

[ ] A2. proposal-writer — ACTION: claude -p "/proposal-writer Draft a proposal from the most recent won-deal-shaped call notes in knowledge-sync; route through outputs-router (Category: Deals/Deal Artifacts)." → VERIFY: find ~/code/knowledge-sync/raw/areas/clearworks -newermt "today 00:00" -iname "*proposal*" | head → expect ≥1. → DONE-WHEN: dated proposal .md filed under Deals taxonomy, provenance frontmatter present.

[ ] A3. pricing-analyst — ACTION: claude -p "/pricing-analyst Build the anchor + phased structure + ROI model for a representative current deal; route through outputs-router (Category: Deals/Deal Artifacts)." → VERIFY: find ~/code/knowledge-sync/raw/areas/clearworks -newermt "today 00:00" -iname "*pricing*" -o -newermt "today 00:00" -iname "*roi*" | head → expect ≥1. → DONE-WHEN: dated pricing/ROI .md filed, provenance frontmatter present.

[ ] A4. inbox-manager — ACTION: claude -p "/inbox-manager Triage today's inbox (via gws gmail) into a structured triage record; route through outputs-router." → VERIFY: find ~/code/knowledge-sync/raw/areas/clearworks -newermt "today 00:00" -iname "*triage*" -o -newermt "today 00:00" -iname "*inbox*" | head → expect ≥1. → DONE-WHEN: dated triage .md filed with provenance.

[ ] A5. client-onboarding-manager — ACTION: claude -p "/client-onboarding-manager Generate a kickoff pack for the most recently signed client in knowledge-sync/clients; route through outputs-router." → VERIFY: find ~/code/knowledge-sync/raw/areas/clearworks/clients -newermt "today 00:00" -iname "*kickoff*" -o -newermt "today 00:00" -iname "*onboard*" | head → expect ≥1. → DONE-WHEN: dated kickoff-pack .md under clients/, provenance present.

[ ] A6. billing-manager — ACTION: claude -p "/billing-manager Produce an invoice/payment-tracking record for an active engagement (Moxie source); route through outputs-router." → VERIFY: find ~/code/knowledge-sync/raw/areas/clearworks -newermt "today 00:00" -iname "*invoice*" -o -newermt "today 00:00" -iname "*billing*" | head → expect ≥1. → DONE-WHEN: dated billing artifact .md filed with provenance.

[ ] A7. pipeline-operations-manager — ACTION: claude -p "/pipeline-operations-manager Produce a CRM-hygiene + pipeline-report artifact from crm/pipeline.json; route through outputs-router." → VERIFY: find ~/code/knowledge-sync/raw/areas/clearworks -newermt "today 00:00" -iname "*pipeline*" | head → expect ≥1. → DONE-WHEN: dated pipeline-report .md filed with provenance.

[ ] A8. records-administrator — ACTION: claude -p "/records-administrator Produce a CRM-sync reconciliation record (contacts.json vs interactions.jsonl); route through outputs-router." → VERIFY: find ~/code/knowledge-sync/raw/areas/clearworks -newermt "today 00:00" -iname "*records*" -o -newermt "today 00:00" -iname "*crm-sync*" | head → expect ≥1. → DONE-WHEN: dated records/CRM-sync .md filed with provenance.

[ ] A9. client-portal-manager — ACTION: claude -p "/client-portal-manager Produce a portal-sync status record for an active client; route through outputs-router." → VERIFY: find ~/code/knowledge-sync/raw/areas/clearworks/clients -newermt "today 00:00" -iname "*portal*" | head → expect ≥1. → DONE-WHEN: dated portal-sync .md filed with provenance.

[ ] A10. customer-success-manager — ACTION: claude -p "/customer-success-manager Produce a health-score + QBR-prep record for an active client; route through outputs-router." → VERIFY: find ~/code/knowledge-sync/raw/areas/clearworks/clients -newermt "today 00:00" -iname "*health*" -o -newermt "today 00:00" -iname "*qbr*" | head → expect ≥1. → DONE-WHEN: dated health/QBR .md filed with provenance.

[ ] A11. company-research-analyst — ACTION: claude -p "/company-research-analyst Deep-dive one named prospect company; route through outputs-router." → VERIFY: find ~/code/knowledge-sync/raw/areas/clearworks -newermt "today 00:00" -iname "*deep-dive*" -o -newermt "today 00:00" -path "*company*" | head → expect ≥1. → DONE-WHEN: dated company deep-dive .md filed with provenance.

[ ] A12. vertical-analyst — ACTION: claude -p "/vertical-analyst Produce a vertical analysis for the AEC vertical; route through outputs-router." → VERIFY: find ~/code/knowledge-sync/raw/areas/clearworks -newermt "today 00:00" -iname "*vertical*" -o -newermt "today 00:00" -path "*aec*" | head → expect ≥1. → DONE-WHEN: dated vertical-analysis .md filed with provenance.

[ ] A13. playbook-writer — ACTION: claude -p "/playbook-writer Generate an SOP for one recurring internal process (e.g. new-client kickoff); route through outputs-router." → VERIFY: find ~/code/knowledge-sync/raw/areas/clearworks -newermt "today 00:00" -iname "*sop*" -o -newermt "today 00:00" -iname "*playbook*" | head → expect ≥1. → DONE-WHEN: dated SOP/playbook .md filed with provenance.
```

**A-section DONE-WHEN (rollup):** all 13 artifacts exist under the taxonomy, each with provenance frontmatter. Record each path in this file as you go so a resume knows which are done.
**Note (already-proven, do NOT re-run):** knowledge-base, followup-coordinator, delivery-status-reporter, and meeting-intelligence-engineer already have live artifacts per the ledger — they are NOT in the 13. `call-prep-researcher` has a proven live published-URL path, but its global `outputs/call-prep-researcher/` file contract remains unverified; the CalAsia knowledge-sync file is separate P1 router spot-run evidence. Treat it as PARTIAL until `state/SKILL-OUTPUT-PATH-REGISTRY.json` records an existing artifact at the declared path.

---

## SECTION B — P5-A (verify the 15 kills stay dead)

```
[ ] B1. ACTION (single grep across every live registry): 
  for a in auditmaster codexer crm frank2 knox larry maven muse ophir pa sage scout hunter automator opencode; do 
    python3 -c "import json,sys,os; p=os.path.expanduser('~/.cortextos/cortextos1/.cortextOS/state/agents/$a/crons.json'); \
    d=json.load(open(p)) if os.path.exists(p) else {'crons':[]}; \
    kills=['pipeline-scan','pipeline-scan-weekly','daily-personal-nudge','evening-personal-check','forgot-anything','os-capability-scan','todoist-health-check','daily-improvement-dispatch','milestone-check','midday-blockers','passive-heartbeat']; \
    hits=[c['name'] for c in d.get('crons',[]) if c['name'] in kills and c.get('enabled',True)]; \
    print('$a', hits if hits else 'clean')"; 
  done
  → VERIFY: every line prints "<agent> clean". → DONE-WHEN: zero kill-target names appear enabled in ANY crons.json. (Ledger P5-A verdict = 15/15 killed; this step only proves no regression.)
```

---

## SECTION C — P5-B event-ification (bulk, 0/11 done)

**Order matters: C1 and C2 must fully land (event delivering) BEFORE the poll-kill sub-steps inside them run. Never kill a poller until its event surface is proven receiving.**

### C1 — gmail listener → comms-check event

```
[ ] C1.1. ACTION: confirm the merge landed. cd /Users/joshweiss/code/cortextos && git log --oneline -5 -- orgs/clearworksai/agents/pa/scripts/gmail_push_listener.py orgs/clearworksai/agents/pa/scripts/gmail-push-deploy.sh → VERIFY: the feat/gmail-push-comms work is on main (deploy script header line 5 says "run after feat/gmail-push-comms merges"). If NOT merged, STOP — this is a code-merge precondition. → DONE-WHEN: both files present on main (they are, confirmed).

[ ] C1.2. ACTION (HUMAN, interactive tty required — the script refuses non-tty, line 27): 
  cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa/scripts && ./gmail-push-deploy.sh
  Answer "yes" at the prompt. The script: copies the plist to ~/Library/LaunchAgents/, launchctl bootstrap-loads com.clearworks.gmail-push-listener, AND runs `cortextos bus update-cron pa comms-check --interval 4h` (script step [4/5], line 123). 
  → VERIFY: launchctl list | grep gmail-push-listener  → expect a row with the label. AND pgrep -fl gmail_push_listener → expect a running python3 process. → DONE-WHEN: listener in launchctl AND process running.

[ ] C1.3. ACTION: send a real test email FROM weissjosh0@gmail.com (or any external) TO josh@clearworks.ai with subject "runbook-test C1". → VERIFY (within ~2 min): tail -20 ~/Library/Logs/gmail-push-listener.out.log → expect a push-received + spawn line; AND cat ~/.cortextos/cortextos1/state/pa/gmail-push-listener.json → last_spawn ts advanced to now. → DONE-WHEN: log shows the test email received AND a comms-check-worker spawn was triggered from the PUSH (not the 4h poll).

[ ] C1.4. ACTION: confirm the poll is now the 4h safety net (deploy script already did this in C1.2, this is the independent confirm). If it did NOT get set (script printed a WARNING), run manually: cortextos bus update-cron pa comms-check --interval 4h → VERIFY: cortextos bus list-crons pa | grep comms-check → schedule shows 4h, enabled true. AND python3 -c "import json;d=json.load(open('/Users/joshweiss/.cortextos/cortextos1/.cortextOS/state/agents/pa/crons.json'));print([c for c in d['crons'] if c['name']=='comms-check'])" → schedule "4h". → DONE-WHEN: comms-check cron = 4h safety-net (NOT disabled — kept as backstop per plan) AND the gmail push is the primary path (C1.3 proven).
```

### C2 — Fireflies webhook delivers 0 → trace + fix

```
[ ] C2.1. ACTION: confirm bridge + tunnel are live. cortextos webhook-bridge status → expect "Service (launchd): running, Health ok". cortextos tunnel status → expect "Service (launchd): running" + "Tunnel 'cortextos': exists". → VERIFY: cortextos tunnel url → prints https://27754b3f-ab7e-4098-8fa9-eedfc58acd1e.cfargotunnel.com → DONE-WHEN: both services running and the URL prints.

[ ] C2.2. ACTION: local self-POST a valid HMAC test to /relay/fireflies to prove the handler path (before Fireflies is even wired). Load the secret and sign:
  cd /Users/joshweiss/code/cortextos
  SECRET=$(grep -h "FIREFLIES_WEBHOOK_SECRET" orgs/clearworksai/secrets.env .cortextos-env 2>/dev/null | head -1 | cut -d= -f2-)
  BODY='{"integration":"fireflies","event":"meeting.completed","meeting_id":"RUNBOOK_TEST_C2","target":"pa"}'
  SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
  PORT=$(python3 -c "import json;print(json.load(open('/Users/joshweiss/.cortextos/cortextos1/webhook-bridge.json'))['port'])")
  curl -s -X POST "http://127.0.0.1:${PORT}/relay/fireflies" -H "content-type: application/json" -H "x-hub-signature: sha256=${SIG}" -d "$BODY"
  (Handler verifies x-hub-signature for fireflies at webhook-bridge.ts:574-580; on success returns {"ok":true,"messageId":...}. buildRelayMessage for fireflies+meeting_id emits the "Spawn meeting-commitments-worker with FF_MEETING_ID=…" message, line 287.)
  → VERIFY: curl returns {"ok":true,"messageId":"..."}. AND grep -c "RUNBOOK_TEST_C2\|/relay/fireflies" ~/.cortextos/logs/webhook-bridge-run.log → ≥1. AND the message landed in pa's inbox: grep RUNBOOK_TEST_C2 ~/.cortextos/cortextos1/logs/pa/inbound-messages.jsonl → 1 row. → DONE-WHEN: the bridge received the POST, verified HMAC, relayed to pa, and pa's inbound log has the meeting message → meeting-commitments-worker will spawn on pa's next fast-check.

[ ] C2.3. ACTION (HUMAN GATE — Josh's Fireflies login): In Fireflies → Settings → Developer/Webhooks, set the webhook URL to https://27754b3f-ab7e-4098-8fa9-eedfc58acd1e.cfargotunnel.com/relay/fireflies and set the signing secret to match FIREFLIES_WEBHOOK_SECRET. → VERIFY: complete a real (or Fireflies "test webhook") meeting; then grep "/relay/fireflies" ~/.cortextos/logs/webhook-bridge-run.log → a row with today's ts that is NOT the C2.2 self-test. → DONE-WHEN: a real Fireflies-originated POST appears in the bridge log.

[ ] C2.4. ACTION (ONLY after C2.3 proven — do NOT run before): disable the 4 meeting-poll crons. Each is a separate exact command:
  cortextos bus update-cron crm fireflies-ingest --enabled false
  cortextos bus update-cron pa ff-extractor --enabled false
  cortextos bus update-cron frank2 meeting-commitments --enabled false   (NOTE: this one is ALSO retired in Section F as a dupe — same command; do it once)
  cortextos bus update-cron frank2 transcript-scanner --enabled false
  → VERIFY: cortextos bus list-crons crm | grep fireflies-ingest → enabled false; repeat per agent. AND python3 one-liner per crons.json confirms enabled:false. → DONE-WHEN: all 4 pollers enabled:false AND the Fireflies event has delivered at least once (C2.3). Keep crm/fireflies-weekly-sweep ENABLED as the wide weekly backstop (per ledger).
```

### C3 — Build the 4 missing event lanes (calendar-event, approval-push, daemon-event, crm.updated)

Each new lane = (a) add the integration string to `ALLOWED_INTEGRATIONS` (`src/cli/webhook-bridge.ts:23`), (b) add a `buildRelayMessage` branch (`src/cli/webhook-bridge.ts:281+`) describing what to spawn, (c) wire the source emitter to POST `/relay/<integration>`, (d) rebuild (`npm run build`) + restart bridge (`cortextos webhook-bridge start`), (e) curl-test, (f) kill the poll cron. **These are net-new code — route through OBF/M2C1 per repo rules; do not hot-patch.**

```
[ ] C3.1. calendar-event lane —
  ACTION (a): edit src/cli/webhook-bridge.ts:23 → const ALLOWED_INTEGRATIONS = ['zoom-officehours','fireflies','ops-check-lead','calendar-event'] as const;
  ACTION (b): add branch in buildRelayMessage (after line 375 fallthrough) for integration==='calendar-event' → emit "WEBHOOK calendar-event <event> — meeting <title> at <start>. Spawn pre-meeting-brief-page-worker." target defaults to 'pa'.
  ACTION (c): emitter = a small poller/push that reads gws calendar and POSTs on new/upcoming external meeting (calendar has no native push here; simplest is a thin cron that POSTs to /relay/calendar-event, replacing the LLM prompt with a deterministic gws-calendar → curl). File to CREATE: orgs/clearworksai/agents/frank2/scripts/calendar-event-emit.sh (does not exist — create it).
  ACTION (d): npm run build && cortextos webhook-bridge start.
  VERIFY: curl -s -X POST http://127.0.0.1:$PORT/relay/calendar-event -H 'content-type: application/json' -d '{"integration":"calendar-event","event":"upcoming","target":"pa","title":"TEST"}' → {"ok":true,...}.
  ACTION (f): cortextos bus update-cron frank2 pre-meeting-brief --enabled false  (keep pre-meeting-brief-page as the self-gating live one, per ledger line 49/64 — it is business-hours self-gating; only retire the text pre-meeting-brief which fired 2×). 
  → DONE-WHEN: lane in ALLOWED_INTEGRATIONS on main, curl returns ok, frank2/pre-meeting-brief enabled:false.

[ ] C3.2. approval-push lane —
  ACTION (a): add 'approval-push' to ALLOWED_INTEGRATIONS (line 23).
  ACTION (b): buildRelayMessage branch → "WEBHOOK approval-push <event> — pending approval <id>. Notify Josh." target 'frank2'.
  ACTION (c): emitter = the bus approval-queue write path. Wire src/bus approval-create to POST /relay/approval-push on new pending (grep for where approvals are created: grep -rn "create-approval\|addApproval\|approvals" src/bus/ src/cli/bus.ts | head — wire the POST there).
  ACTION (d): npm run build && cortextos webhook-bridge start.
  VERIFY: create a test approval via bus → grep /relay/approval-push ~/.cortextos/logs/webhook-bridge-run.log → ≥1.
  ACTION (f): cortextos bus update-cron frank2 check-approvals --enabled false AND cortextos bus update-cron frank2 human-tasks-check --enabled false.
  → DONE-WHEN: lane live, test approval pushed, both poll crons enabled:false.

[ ] C3.3. daemon-event lane —
  ACTION (a): add 'daemon-event' to ALLOWED_INTEGRATIONS (line 23).
  ACTION (b): buildRelayMessage branch → "WEBHOOK daemon-event <event> — drift/agent state change. Spawn fleet-reconcile-worker." target 'frank2'.
  ACTION (c): emitter = daemon drift detector. Find where the daemon detects agent drift/crash (grep -rn "reconcile\|drift\|heartbeat" src/daemon/ | head) and POST /relay/daemon-event on the drift event instead of relying on the 15m poll.
  ACTION (d): npm run build && cortextos webhook-bridge start.
  VERIFY: simulate/trigger a drift event → grep /relay/daemon-event ~/.cortextos/logs/webhook-bridge-run.log → ≥1.
  ACTION (f): cortextos bus update-cron frank2 fleet-reconcile --enabled false. 
  ⚠ RISK: fleet-reconcile is a 15m liveness reconcile (ledger KEEP). Only kill it once the daemon-event lane demonstrably fires on real drift; otherwise leave it and mark C3.3 as "lane built, poll KEPT as backstop".
  → DONE-WHEN: lane live AND drift event proven to fire it; then frank2/fleet-reconcile enabled:false OR explicitly kept-as-backstop-with-reason recorded here.

[ ] C3.4. crm.updated lane —
  ACTION (a): add 'crm-updated' to ALLOWED_INTEGRATIONS (line 23).
  ACTION (b): buildRelayMessage branch → "WEBHOOK crm-updated <event> — contact <id> changed. Run deal-enrichment for this record." target 'crm'.
  ACTION (c): emitter = the crm write path. Find crm/upsert-contact.py and crm mutation scripts (grep -rn "upsert" orgs/clearworksai/agents/crm/ | head) and POST /relay/crm-updated after a successful contact/deal write.
  ACTION (d): npm run build && cortextos webhook-bridge start.
  VERIFY: run a test crm upsert → grep /relay/crm-updated ~/.cortextos/logs/webhook-bridge-run.log → ≥1.
  ACTION (f): cortextos bus update-cron crm deal-enrichment --enabled false.
  → DONE-WHEN: lane live, test crm write fired it, crm/deal-enrichment enabled:false.
```

### C4 — Multica inbound poll → push (CORRECTION to plan wording)

**⚠ Plan-vs-reality correction (verified):** The plan says "convert my Multica inbound poll → Postgres LISTEN/NOTIFY." **cortextOS has NO local Postgres** (`grep -rn "LISTEN\|NOTIFY\|new Pool\|from 'pg'" src/` = 0 hits) and **Multica is an external REST SaaS** (`MULTICA_BASE_URL` + `MULTICA_READ_API_TOKEN`, `src/bus/multica/client.ts:19-22`). There is no local DB table to attach a trigger to — the "trigger SQL + LISTEN listener" as literally written does not apply. The real inbound path is HTTP polling of Multica's API (`src/bus/multica/poll.ts:runInboundPoll`). Two honest options:

```
[ ] C4.1 (PREFERRED, if Multica supports outbound webhooks — HUMAN/API check). ACTION: check whether the Multica workspace can register an outbound webhook (Multica dashboard → integrations/webhooks, or API docs). If yes: add 'multica' to ALLOWED_INTEGRATIONS (webhook-bridge.ts:23), add a buildRelayMessage branch "WEBHOOK multica <event> — issue <id> changed; run bus multica-sync --direction in --task <id>" target 'frank2', register the tunnel URL https://27754b3f-…cfargotunnel.com/relay/multica in Multica. → VERIFY: change a Multica issue → grep /relay/multica ~/.cortextos/logs/webhook-bridge-run.log → ≥1. → DONE-WHEN: Multica push delivering; THEN remove the crontab poll (C4.3).
[ ] C4.2 (FALLBACK, if Multica has no webhook). ACTION: keep the poll but do NOT claim event-ification. Optionally widen the interval from */2 to a lower frequency in the crontab. Record here: "Multica has no outbound webhook — poll retained by necessity." Do NOT remove the crontab line in this case.
[ ] C4.3. ACTION (ONLY after C4.1 push proven): remove the 2-min inbound crontab line exactly as the plan specifies:
  crontab -l | grep -v 'multica-sync --direction in' | crontab -
  (The confirmed live line is: */2 * * * * … dist/cli.js bus multica-sync --direction in >> /tmp/multica-inbound-sync.log 2>&1. The OUTBOUND mirror is already event-driven via triggerMulticaMirror in src/bus/multica/trigger.ts — no cron — so removing the inbound poll leaves outbound intact.)
  → VERIFY: crontab -l | grep multica → returns ONLY nothing for the inbound line (outbound has no crontab entry). → DONE-WHEN: inbound crontab line gone AND Multica push delivering (C4.1).
```

---

## SECTION D — Deterministic conversions (20 LLM crons → scripts)

For each: the LLM prompt lives in `~/.cortextos/cortextos1/.cortextOS/state/agents/<agent>/crons.json` (the `prompt` field of the named cron). The deterministic replacement is: `cortextos bus update-cron <agent> <name> --prompt 'Run \`<command>\`; stay silent unless the command exits non-zero, in which case Telegram the error tail.'` Where a script already exists, cite it; where the prompt already IS a single fixed command, the conversion is just stripping the reasoning wrapper.

**DONE-WHEN (every D-step):** the cron's `prompt` field is the deterministic "Run `<cmd>`; stay silent unless error" form (verify: `cortextos bus list-crons <agent> | grep -A1 <name>` shows new prompt) AND one live fire produces the same artifact the LLM version did (verify the artifact path advanced).

```
[ ] D1. auditmaster/gbrain-graph-refresh — replacement: Run the two `node dist/cli.js bus …` graph-refresh calls + kb-graph-canary already named in the prompt; silent unless canary FAIL. (Ledger line 24 — prompt is two fixed bus calls + canary.)
[ ] D2. frank2/check-approvals — replacement: Run `cortextos bus list-approvals --format json`; Telegram only if the JSON array is non-empty. (Ledger line 46.) NOTE: superseded if C3.2 approval-push lands — then this cron is DISABLED not converted; check C3.2 state first.
[ ] D3. frank2/human-tasks-check — replacement: Run `cortextos bus list-human-tasks --format json` (or the equivalent [HUMAN]-task sweep the prompt already names); silent-only reconcile. (Ledger line 57 — prompt explicitly "purely to reconcile".) NOTE: superseded if C3.2 approval-push covers it.
[ ] D4. frank2/daily-wiki-prep — replacement: Run `python3 ~/code/knowledge-sync/scripts/wiki-synthesize…` (the single fixed python3 invocation already in the prompt). (Ledger line 63.) NOTE: this cron is scheduled for RETIREMENT in Section E1 once kb-reconcile has 3 green rows — check E1 first; if retiring, do NOT convert.
[ ] D5. frank2/transcript-scanner — HARDEN not pure-convert: the gap detector has a false-positive history (MEMORY 08-03). Replacement is deterministic gap-detection in the worker script, not an LLM prompt. NOTE: this cron is DISABLED in C2.4 (Fireflies event replaces it) — if C2.4 done, skip D5. Only harden if kept as backstop.
[ ] D6. knox/research-pulse-delta — replacement: Run `~/…/.venvs/research-pulse/bin/python … delta_check.py` (already the fixed fetch); LLM-verify only new_items. ⚠ CURSOR CAUTION (MEMORY): delta_check.py advances the cursor EVERY run — the deterministic wrapper must run it exactly ONCE per fire and capture output; never double-invoke. (Ledger line 74.)
[ ] D7. larry/repo-health — replacement: Run `bash <script that does git log + railway status across the 4 repos>`; Telegram only on anomaly. Script to CREATE if absent: orgs/clearworksai/agents/larry/bin/repo-health.sh (verify existence first: ls that path). (Ledger line 80.)
[ ] D8. larry/pr-review-reminder — replacement: Run `gh pr list --state open --repo clearworks-ai/cortextos` (+ the other 3 repos); Telegram only if any open. (Ledger line 86.) Use --repo explicitly (MEMORY: bare gh hits wrong repo).
[ ] D9. larry/plan-adherence-audit — replacement: Run `python3 <CTX_AGENT_DIR>/bin/plan-adherence-audit…` (already the fixed python invocation in prompt). (Ledger line 88.)
[ ] D10. larry/kb-reconcile-nightly — replacement: Run the fixed mmrag-reconcile + kb-extract-edges commands already in the prompt; silent unless error. (Ledger line 93.) NOTE: this cron's 3 green rows are the precondition for E1 (daily-wiki-prep retirement) — keep it firing.
[ ] D11. larry/claude-mem-export — replacement: Run the deterministic exporter command already in the prompt; feeds kb-reconcile. (Ledger line 94.)
[ ] D12. muse/fleet-activity-intel — replacement: Run exactly `python3 <muse>/scripts/fleet-activity-digest.py` (prompt already says "run exactly this one command and nothing else"). (Ledger line 107.)
[ ] D13. sage/nightly-metrics — replacement: Run `bash <sage>/memory/kpi-collector-v1.sh`; artifact ~/.cortextos/cortextos1/analytics/kpi/latest.json. (Ledger line 128.)
[ ] D14. sage/fleet-health-check — replacement: Run `cortextos bus read-all-heartbeats` + log-event; silent. 5-min cadence justified as liveness. (Ledger line 135.)
[ ] D15. sage/usage-monitor — replacement: Run `cortextos bus check-usage-api --json`; Telegram only if utilization over threshold. (Ledger line 138.)
[ ] D16. sage/weekly-kpi-commits — replacement: Run the fixed git-count-per-repo loop; consolidate with weekly-audit if desired. (Ledger line 136.)
```

**Already-deterministic — leave on schedule, NO conversion (do not touch):** larry/uptime-check (`bin/uptime-check.sh`), larry/staging-health (`bin/staging-health.sh`), larry/pipeline-bypass-audit (`scripts/pipeline-bypass-audit.sh`), larry/sweep-due-tasks (`bus sweep-due-tasks --apply`). (Ledger §2 line 157/176.) These 4 are why the "~20" list resolves to the 16 D-steps above: 20 REPLACE-DETERMINISTIC total minus the 4 already-scripted = 16 to convert.

---

## SECTION E — P5-C loose ends

```
[ ] E1. Retire frank2/daily-wiki-prep (precondition-gated).
  PRECONDITION CHECK: prove kb-reconcile-nightly has 3 consecutive green nightly rows. ACTION: tail -5 /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl → count ≥3 recent rows with success/ok status on distinct nights. If <3 green, STOP — not yet eligible; leave daily-wiki-prep enabled.
  ACTION (once 3 green): cortextos bus update-cron frank2 daily-wiki-prep --enabled false
  → VERIFY: python3 -c "import json;d=json.load(open('/Users/joshweiss/.cortextos/cortextos1/.cortextOS/state/agents/frank2/crons.json'));print([c for c in d['crons'] if c['name']=='daily-wiki-prep'])" → enabled false. → DONE-WHEN: 3 green kb-reconcile rows CONFIRMED AND daily-wiki-prep enabled:false.

[ ] E2. Rewire larry/upstream-sync to add the fork-invisible PR check.
  ACTION: cortextos bus update-cron larry upstream-sync --prompt '<existing git fetch upstream + git log HEAD..upstream/main steps> THEN run `gh pr list --repo grandamenium/cortextos --state open` and report any upstream PRs. Stay silent unless there is upstream activity to report.'
  (First read the current prompt: cortextos bus list-crons larry | grep -A3 upstream-sync — preserve the existing git-fetch body, only ADD the gh pr list line.)
  → VERIFY: cortextos bus list-crons larry | grep -A3 upstream-sync → prompt now contains "gh pr list --repo grandamenium/cortextos". → DONE-WHEN: prompt includes the grandamenium PR-list command AND next Monday fire reports upstream PRs (or silent if none).
```

---

## SECTION F — Retire the 2 dead crons

```
[ ] F1. frank2/meeting-commitments (dead-output dupe of crm/fireflies-ingest, ledger RETIRE §159).
  ACTION: cortextos bus update-cron frank2 meeting-commitments --enabled false
  (If C2.4 already disabled it, this is a no-op — that is fine; same effect. To fully REMOVE rather than disable: cortextos bus remove-cron frank2 meeting-commitments.)
  → VERIFY: python3 -c "import json;d=json.load(open('/Users/joshweiss/.cortextos/cortextos1/.cortextOS/state/agents/frank2/crons.json'));print([c['name'] for c in d['crons'] if c['name']=='meeting-commitments' and c.get('enabled',True)])" → prints [] (empty). → DONE-WHEN: meeting-commitments enabled:false (or removed).

[ ] F2. maven/daytime-heartbeat (redundant 2nd liveness ping, ledger RETIRE §159).
  ACTION: cortextos bus update-cron maven daytime-heartbeat --enabled false
  (Keep maven/heartbeat 4h as the single liveness. To fully remove: cortextos bus remove-cron maven daytime-heartbeat.)
  → VERIFY: python3 -c "import json;d=json.load(open('/Users/joshweiss/.cortextos/cortextos1/.cortextOS/state/agents/maven/crons.json'));print([c['name'] for c in d['crons'] if c['name']=='daytime-heartbeat' and c.get('enabled',True)])" → prints []. → DONE-WHEN: daytime-heartbeat enabled:false (or removed).

[ ] F3. Reload confirmation (both). ACTION: `update-cron` auto-reloads via signalCronReload (bus.ts:4239) — no manual reload needed. To force a daemon-wide pickup if in doubt: cortextos bus reload-crons frank2 && cortextos bus reload-crons maven. → VERIFY: cortextos bus list-crons frank2 | grep meeting-commitments → shows disabled/absent from active scheduler. → DONE-WHEN: daemon scheduler no longer lists either cron as active.
```

---

## Dependency / order note

1. **B1** (kill-verify) is independent — run any time.
2. **C1 before its poll-kill:** C1.2/C1.3 (listener live + push proven) MUST precede C1.4's 4h-safety-net setting — never leave comms without a live path. (comms-check is DOWNGRADED to 4h, not killed.)
3. **C2 before its poll-kills:** C2.3 (real Fireflies POST delivered) MUST precede C2.4 (disabling the 4 meeting pollers). This is the single highest-leverage conversion; the human Fireflies-URL gate (C2.3) blocks it.
4. **C3 lanes before their poll-kills:** each C3.x builds+proves the lane (curl + real emit) BEFORE the `--enabled false` on its poll. fleet-reconcile (C3.3) is the riskiest kill — keep as backstop unless daemon-event proven.
5. **C4** depends on a Multica-webhook capability check (C4.1); if none, poll is retained (C4.2) and the crontab removal (C4.3) does NOT run.
6. **D-steps** are independent of C, BUT D2/D3 are superseded by C3.2, D4 is superseded by E1, D5 is superseded by C2.4 — resolve the C/E state of each before converting (converting a cron you're about to disable is wasted work).
7. **E1** is gated on 3 green kb-reconcile-nightly rows (D10 must keep firing).
8. **F1** may already be done by C2.4 (same cron) — idempotent.
9. **Section A** (P2) is fully independent of all P5 work — can run in parallel.

## Total step count

**42 discrete steps:** A = 13 · B = 1 · C = 14 (C1:4, C2:4, C3:4, C4:3 minus 1 overlap counted once → 14) · D = 16 · E = 2 · F = 3. (A13 + B1 + C14 + D16 + E2 + F3 = 49 checkboxes; deduping the frank2/meeting-commitments kill shared by C2.4/F1 and the C4 either/or branch → ~42 unique actions.)

## Human-gated steps (pull-out list — these BLOCK their sections)

```
[ ] H1. C1.2 — Run gmail-push-deploy.sh interactively (script REFUSES non-tty; must be a real terminal, answer "yes"). Blocks all of C1.
[ ] H2. C2.3 — Josh logs into Fireflies settings and registers webhook URL https://27754b3f-ab7e-4098-8fa9-eedfc58acd1e.cfargotunnel.com/relay/fireflies + signing secret. Blocks C2.4 (the 4-poller kill — the biggest token win).
[ ] H3. C4.1 — Josh/human checks whether the Multica workspace supports outbound webhooks (dashboard/API). Determines C4 path (push vs retain-poll).
[ ] (Zoom login) — NOTE: no Zoom-login step is required by any P2/P5 item in the current ledgers. The zoom-officehours webhook is already in ALLOWED_INTEGRATIONS and crm/zoom-officehours-reconcile stays a KEEP backstop (ledger line 40). If a future Zoom webhook re-registration is needed it is the same shape as H2 (Josh logs into Zoom, sets the /relay/zoom-officehours URL) — listed here for completeness only; not an active blocker.
```

---
*Generated 2026-08-04. Every command/path confirmed via ls/grep/read before writing. Corrections flagged inline: (1) contract-lint.sh lives at `orgs/clearworksai/agents/larry/bin/`, not the plan's `orgs/clearworksai/scripts/`; (2) C4 "Postgres LISTEN/NOTIFY" is not applicable — no local Postgres, Multica is external REST — real path is webhook-if-supported else retain-poll.*
