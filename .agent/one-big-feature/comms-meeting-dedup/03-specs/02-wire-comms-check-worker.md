# Spec 02 — Wire the gate into comms-check-worker SKILL.md

**File:** `orgs/clearworksai/agents/pa/.claude/skills/comms-check-worker/SKILL.md`
**Depends on:** Spec 01 (the `cortextos bus meeting-alert-gate` command must exist).
**Enforcement shape to mirror:** GATE D for CI failures (SKILL.md:93-99) — a hard bash
call whose JSON answer decides surface/skip, upstream of any LLM judgment.

## Edit 1 — new "Step 4c" section

**Insert location:** after line 139 (`If ANY check fails → do NOT create the task.`,
the end of Step 4b) and before the existing `---` separator at line 141 that precedes
Step 5. Add a trailing `---` so the document keeps its section separators.

Exact text to insert:

```markdown

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
```

## Edit 2 — Step 5 bullet

**Insert location:** in `## Step 5 — Handle results`, add a new bullet directly after
the Railway/CI-failures bullet (currently lines 148-151) and before the
`**Action-item emails**` bullet (currently line 153):

```markdown
- **Meeting reminders / meeting updates** → gated by Step 4c. Only a
  `"surface":true` result may produce a Telegram, and only ONE per meeting. On
  `"surface":false`, skip silently — no task, no summary, no reworded follow-up.
```

## Edit 3 — cross-reference in the existing zcal bullet

**Location:** the existing Step 5 bullet at line 156
(`- **Meeting confirmations / zcal bookings** → SKIP. ...`). Append one sentence to
that bullet (do not otherwise change it):

```markdown
 If you nonetheless judge a meeting notice worth surfacing (e.g. a new external
 meeting Josh may not have seen), it MUST pass the Step 4c meeting-alert-gate first.
```

## Key-derivation guidance baked into the text (why it is worded this way)

- **eventId preferred:** immutable identity; survives any wording. Use whenever the
  worker resolved the notice to a calendar event.
- **Fallback = meeting title + MEETING date:** the gate's normalization (lowercase,
  strip `re:`/`fwd:`, drop non-alphanumerics) makes same-title rewordings collapse
  deterministically; the meeting DATE (not email date) makes the key stable across
  the multi-day email lifecycle and keeps distinct occurrences of a recurring
  meeting distinct.
- Residual risk accepted: a differently-TITLED thread about the same meeting may
  produce a second key → at most one extra ping, never a dropped meeting.

## Acceptance

- SKILL.md contains Step 4c verbatim (bash snippet included), the new Step 5 bullet,
  and the zcal cross-reference.
- No other SKILL.md content changed (hard exclusions, gates A-D, task guardrails,
  Step 6 untouched).
- Dry-run proof: with the gate built, run the Step 4c snippet twice with
  `MEETING_TITLE="E-Rate for Scholarship Prep" MEETING_DATE=2026-07-16` → first
  prints `"surface":true`, second `"surface":false`.
