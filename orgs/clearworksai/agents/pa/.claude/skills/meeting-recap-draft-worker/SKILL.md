# Meeting Recap Draft Worker

You are a SHORT-LIVED WORKER SESSION. Your only job is to draft post-meeting recap emails as Gmail DRAFTS. Complete it and stop.

DO NOT:
- Read bootstrap files (IDENTITY.md, SOUL.md, etc.)
- Update heartbeat
- Write to daily memory
- Send confirmations or narration

DO:
- Run the exact bash blocks below VERBATIM, in order. Do not investigate, grep, or read other files first — the block IS the investigation. Do not draw conclusions about missing keys/config from anything other than the block's own exit code / stdout.
- Output DONE when complete

If a Telegram status message would report anything other than what a bash block's actual stdout/exit code says (e.g. "key missing", "degraded"), that is a bug — re-run the literal block instead of writing a status from memory/assumption.

**DRAFT ONLY — the only Gmail path this worker may use is the `gws gmail +draft` bash command (Step 5). It saves a Gmail draft; it structurally CANNOT send (the DWD shim's `+draft` has no send path). Never use `+send` or any send-capable command, never call a Gmail MCP tool (pa has no Gmail MCP configured — canonical path is `gws` + DWD token).**

---

## Step 1 — Task + dedup setup (Bash)

```bash
TASK_ID=$(cortextos bus create-task "Cron: meeting-recap-draft" --desc "Post-meeting recap Gmail draft worker" --assignee "${CTX_PARENT_AGENT:-pa}" 2>/dev/null)
cortextos bus update-task $TASK_ID in_progress 2>/dev/null
cortextos bus update-cron-fire meeting-recap-draft --interval 4h 2>/dev/null
LEDGER='/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa/state/meeting-recap-drafts-surfaced.txt'
mkdir -p "$(dirname "$LEDGER")"
[[ -f "$LEDGER" ]] || touch "$LEDGER"
echo "surfaced=$(wc -l < "$LEDGER")"
```

The ledger is ABSOLUTE-path on purpose (sibling ledgers were split-brained via cwd-relative paths; this worker colocates with the extractor watermark in pa/state).

---

## Step 2 — Run the extractor in recap mode (Bash)

ff-extractor is the only Fireflies touchpoint — never query the Fireflies API from this SKILL. Recap mode does not POST and does not touch the commitments watermark. Working directory MUST be the pa agent dir so `scripts/` resolves.

```bash
cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa
# set -a auto-exports everything sourced — .env/secrets.env use bare KEY=value
set -a
source /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa/.env 2>/dev/null
source /Users/joshweiss/code/cortextos/orgs/clearworksai/secrets.env 2>/dev/null
set +a

LEDGER='/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa/state/meeting-recap-drafts-surfaced.txt'
DEGRADED=0
if [[ -z "$FIREFLIES_API_KEY" || -z "$OPENROUTER_API_KEY" ]]; then
  # Env guard: recap needs both keys; nothing to draft without them.
  DEGRADED=1
  echo '{"recap":true,"meetings":[]}' > /tmp/ff-recap.json
else
  python3 scripts/ff-extractor.py --recap --limit 10 --recap-ledger "$LEDGER" > /tmp/ff-recap.json
fi
EXTRACTOR_RC=$?
echo "extractor_rc=$EXTRACTOR_RC degraded=$DEGRADED"
```

If `EXTRACTOR_RC` nonzero OR `DEGRADED=1` → log silently and skip directly to Step 6 — no drafts, no ledger writes, no Telegram.

---

## Step 3 — Trust ladder + draft execution

Read `/tmp/ff-recap.json`. Contract (owned by ff-extractor.py `--recap`): `meetings` array of `{id, title, date, organizer, attendees, summary:{overview,bullets,action_items}, client_context, next_steps:[{id,text,direction,source,sourceRef,...}]}`. `client_context` is the L0 context layer from `knowledge/clients/*.md`. `next_steps` is already noise-gated by the extractor.

Run the helper below from the `pa` agent dir. It owns all recap routing logic:
- L1 default: client-facing recaps -> Gmail draft only
- L2 conditional: internal-only + confidence > 0.9 -> auto-file, no draft
- L3 hardcoded VIP list: never auto-send/auto-file; stays draft-only
- Voice guidance comes from `orgs/clearworksai/knowledge/voice.md`
- VIP file comes from `orgs/clearworksai/knowledge/vip-clients.txt`

```bash
cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/pa
VOICE='/Users/joshweiss/code/cortextos/orgs/clearworksai/knowledge/voice.md'
VIP='/Users/joshweiss/code/cortextos/orgs/clearworksai/knowledge/vip-clients.txt'
python3 scripts/meeting_recap_draft.py \
  --payload /tmp/ff-recap.json \
  --ledger "$LEDGER" \
  --voice "$VOICE" \
  --vip-list "$VIP" \
  > /tmp/meeting-recap-draft-plan.json
PLAN_RC=$?
echo "plan_rc=$PLAN_RC"
cat /tmp/meeting-recap-draft-plan.json
```

If `PLAN_RC` is nonzero, or the helper reports draft failures, log `recap_degraded_no_gmail` via `cortextos bus log-event action recap_degraded_no_gmail warn 2>/dev/null`, then continue to Step 4. No Telegram.

The helper is the only place allowed to call `gws gmail +draft`. Do not substitute `+send`. Do not call Gmail MCP tools.

---

## Step 4 — Complete and exit

```bash
cortextos bus complete-task $TASK_ID --result "Meeting recap drafts checked" 2>/dev/null
cortextos bus log-event action cron_completed info --meta '{"cron":"meeting-recap-draft","agent":"pa"}' 2>/dev/null
# FINAL — self-terminate this worker PTY so it does not leak (worker-leak fix #25)
cortextos terminate-worker "$CTX_AGENT_NAME"
```

Output literally: `DONE`
