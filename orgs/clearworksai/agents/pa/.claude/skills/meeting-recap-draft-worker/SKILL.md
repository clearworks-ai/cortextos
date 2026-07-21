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

**DRAFT ONLY — never call any Gmail send tool. The only Gmail tool this worker may call is `mcp__claude_ai_Gmail__create_draft`.**

---

## Step 1 — Task + dedup setup (Bash)

```bash
TASK_ID=$(cortextos bus create-task "Cron: meeting-recap-draft" --desc "Post-meeting recap Gmail draft worker" --assignee "${CTX_PARENT_AGENT:-pa}" 2>/dev/null)
cortextos bus update-task $TASK_ID in_progress 2>/dev/null
cortextos bus update-cron-fire meeting-recap-draft --interval 4h 2>/dev/null
LEDGER='/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/state/meeting-recap-drafts-surfaced.txt'
mkdir -p "$(dirname "$LEDGER")"
[[ -f "$LEDGER" ]] || touch "$LEDGER"
echo "surfaced=$(wc -l < "$LEDGER")"
```

The ledger is ABSOLUTE-path on purpose (sibling ledgers split-brained across pa/state and frank2/state via cwd-relative paths; this worker colocates with the extractor watermark in frank2/state).

---

## Step 2 — Run the extractor in recap mode (Bash)

ff-extractor is the only Fireflies touchpoint — never query the Fireflies API from this SKILL. Recap mode does not POST and does not touch the commitments watermark. Working directory MUST be the frank2 agent dir so `scripts/` resolves.

```bash
cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2
# set -a auto-exports everything sourced — .env/secrets.env use bare KEY=value
set -a
source /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/.env 2>/dev/null
source /Users/joshweiss/code/cortextos/orgs/clearworksai/secrets.env 2>/dev/null
set +a

LEDGER='/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/state/meeting-recap-drafts-surfaced.txt'
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

## Step 3 — Parse results

Read `/tmp/ff-recap.json`. Contract (owned by ff-extractor.py `--recap`): `meetings` array of `{id, title, date, organizer, attendees, summary:{overview,bullets,action_items}, next_steps:[{id,text,direction,source,sourceRef}]}`. `next_steps` is already noise-gated (VAGUE_ACTION_PREFIXES / SUPPRESSED_NAMES / GENERIC_OWNERS inside the extractor).

Belt-and-suspenders post-filter before drafting: **EXCLUDE any meeting or next-step mentioning Marcos Santa Ana (hard no — never draft).**

---

## Step 4 — Dedup check (mandatory)

Dedup key = the Fireflies meeting `id`. For each meeting:

```bash
grep -qF "$MEETING_ID" "$LEDGER" && echo SKIP || echo NEW
```

Do NOT append here — append happens in Step 5 only after the draft is actually created. Ledger is append-only; never delete lines.

---

## Step 5 — Create the Gmail draft (one per NEW meeting)

For each NEW meeting, call the Gmail MCP tool `mcp__claude_ai_Gmail__create_draft` with:

- **to:** `weissjosh0@gmail.com` (default self-draft — Josh reviews/edits/sends. Do NOT auto-address meeting attendees.)
- **subject:** `Recap: <title> — <date YYYY-MM-DD>`
- **body:**
  1. One recap paragraph from `summary.overview` (fallback: `summary.bullets`, then `summary.action_items`; if all empty, one neutral line naming the meeting + attendees).
  2. Blank line, then `Next steps:` followed by a numbered list of `next_steps[].text`. Render inbound items (`direction == "inbound"`, text prefixed `[inbound] Owner: ...`) as `Owner: action`; render outbound items as `Josh: action`. If `next_steps` is empty, write `Next steps: none captured.`
  3. Footer line: `— drafted automatically from the Fireflies transcript (<sourceRef meeting id>); review before sending.`

**NEVER call any send tool.** Draft only.

Only AFTER `create_draft` returns success for a meeting:

```bash
echo "$MEETING_ID $(date -u +%s)" >> "$LEDGER"
```

If `create_draft` fails or the Gmail MCP tool is unavailable: do NOT append the ledger (the meeting retries next run), log `recap_degraded_no_gmail` via `cortextos bus log-event action recap_degraded_no_gmail warn 2>/dev/null`, continue to Step 6.

If `meetings` is empty or everything was deduped/excluded: SILENT-OK — log silently, no drafts, no Telegram.

---

## Step 6 — Complete and exit

```bash
cortextos bus complete-task $TASK_ID --result "Meeting recap drafts checked" 2>/dev/null
cortextos bus log-event action cron_completed info --meta '{"cron":"meeting-recap-draft","agent":"pa"}' 2>/dev/null
# FINAL — self-terminate this worker PTY so it does not leak (worker-leak fix #25)
cortextos terminate-worker "$CTX_AGENT_NAME"
```

Output literally: `DONE`