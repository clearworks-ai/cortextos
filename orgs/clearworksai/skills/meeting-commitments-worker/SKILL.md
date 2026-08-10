# Meeting Commitments Worker

You are a SHORT-LIVED WORKER SESSION. Your only job is to run the Fireflies commitment extractor and surface Josh's NEW meeting commitments. Complete it and stop.

DO NOT:
- Read bootstrap files (IDENTITY.md, SOUL.md, etc.)
- Update heartbeat
- Write to daily memory
- Send confirmations or narration

DO:
- Run the exact bash blocks below VERBATIM, in order. Do not investigate, grep, or read other files first — the block IS the investigation. Do not draw conclusions about missing keys/config from anything other than the block's own exit code / stdout.
- Send Telegram to 6690120787 only if NEW commitments found
- Output DONE when complete

If a Telegram status message would report anything other than what a bash block's actual stdout/exit code says (e.g. "key missing", "degraded"), that is a bug — re-run the literal block instead of writing a status from memory/assumption.

---

## Step 1 — Task + dedup setup (Bash)

Everything below resolves against the RUNNING agent's own dir via `$CTX_*`
(never a hardcoded absolute path). The daemon sets `CTX_AGENT_DIR`, `CTX_PARENT_AGENT`,
`CTX_FRAMEWORK_ROOT`, and `CTX_ORG` for a spawned worker.

```bash
AGENT_DIR="${CTX_AGENT_DIR:-$(pwd)}"
FW_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$AGENT_DIR/../../../.." && pwd)}"
ORG="${CTX_ORG:-clearworksai}"
ORG_ROOT="$FW_ROOT/orgs/$ORG"
OWNER_AGENT="${CTX_PARENT_AGENT:-$(basename "$AGENT_DIR")}"

TASK_ID=$(cortextos bus create-task "Cron: meeting-commitments" --desc "Post-meeting commitment extractor" --assignee "$OWNER_AGENT" 2>/dev/null)
cortextos bus update-task $TASK_ID in_progress 2>/dev/null
cortextos bus update-cron-fire meeting-commitments --interval 2h 2>/dev/null
mkdir -p "$AGENT_DIR/state"
SURFACED_FILE="$AGENT_DIR/state/meeting-commitments-surfaced.txt"
[[ -f "$SURFACED_FILE" ]] || touch "$SURFACED_FILE"
echo "surfaced=$(wc -l < $SURFACED_FILE)"
```

There is no cutoff/timestamp logic here anymore. The old `state/meeting-commitments-last.txt` cutoff is replaced by the extractor's own watermark (`state/ff-extractor-watermark.json`), which the extractor advances only after a successful ingest POST — so nothing is lost if a run fails partway.

---

## Step 2 — Run the extractor (Bash)

The extractor owns the full pipeline: Haiku casualness gate + Sonnet extraction + first-person/concreteness refinement, then a POST to `$BRIEFS_INGEST_URL` (header `x-api-key: $TASKS_INGEST_TOKEN`) that turns commitments into durable tasks with server-side dedup by deterministic id. Do not query the Fireflies API directly from this SKILL — the extractor is the only Fireflies touchpoint.

Working directory MUST be the RUNNING agent's dir (`$CTX_AGENT_DIR`) so `scripts/`
and `state/` resolve correctly. Org secrets are already sourced into a daemon-spawned
worker's env; we re-source defensively for the manual/poll path.

```bash
cd "$AGENT_DIR"
# set -a auto-exports everything sourced — .env/secrets.env use bare KEY=value
# (no `export`), and without this the python3 child would NOT inherit the vars
# even though the bash guard below sees them (guard says OK, extractor fails).
set -a
source "$AGENT_DIR/.env" 2>/dev/null
source "$ORG_ROOT/secrets.env" 2>/dev/null
set +a

DEGRADED=0
if [[ -z "$BRIEFS_INGEST_URL" || -z "$TASKS_INGEST_TOKEN" ]]; then
  # Env guard: ingest not configured — extract + print only, no POST, watermark NOT advanced
  DEGRADED=1
  python3 scripts/ff-extractor.py --limit 20 --dry-run > /tmp/ff-commitments.json
else
  python3 scripts/ff-extractor.py --limit 20 > /tmp/ff-commitments.json
fi
EXTRACTOR_RC=$?
echo "extractor_rc=$EXTRACTOR_RC degraded=$DEGRADED"
```

## Step 2b — Notify crm of the completed meeting

```bash
if [[ -n "$FF_MEETING_ID" ]]; then
  cortextos bus send-message crm normal "EVENT crm.meeting.completed — {\"meeting_id\":\"$FF_MEETING_ID\"}"
fi
```

The extractor exits nonzero on failure. If `EXTRACTOR_RC` is nonzero: log silently and skip directly to Step 6 — no Telegram, no dedup writes.

---

## Step 3 — Parse results

The extractor stdout JSON always contains an `items` array of `{id, text, direction, source, sourceRef, owner, deadline, sourceQuote}` (contract owned by `ff-extractor.py`; the last three may be empty strings). Read `/tmp/ff-commitments.json` and iterate `items`.

Keep the existing exclusion rules as a belt-and-suspenders post-filter before surfacing:

**EXCLUDE:**
- Anything mentioning Marcos Santa Ana (hard no — never surface)
- rachel_security_deliverables_jsp (suppressed permanently)

**WE-vs-THEY is not cosmetic.** `direction` decides how an item may ever be framed:
- `outbound` (WE committed) = Josh's own action item. Fine to show a due date, fine to eventually chase as overdue.
- `inbound` (THEY committed to us) = someone ELSE's action item and someone ELSE's deadline. NEVER render it as something due FROM Josh, never let it read like a Josh reminder. It is FYI/tracking only (root cause of 2026-07-25 incident: Chris Samron's own 07-27 deadline got surfaced as if it were Josh's due-dated task — see `feedback_meeting_commitments_they_committed_noise.md`).

---

## Step 4 — Dedup check (mandatory)

Dedup key is the deterministic commitment `id` from the extractor (`ff_…` / `ffin_…`). For each item:

```bash
grep -qF "$ID" state/meeting-commitments-surfaced.txt && echo SKIP || echo NEW
# If NEW:
echo "$ID $(date -u +%s)" >> state/meeting-commitments-surfaced.txt
```

Old-format lines (`TRANSCRIPT_ID:RECIPIENT:first_3_words`) remain in the file harmlessly — never match the new id keys, never delete them.

---

## Step 5 — Surface new commitments

For NEW commitments only, send ONE Telegram to 6690120787, grouped by meeting (`sourceRef`) then OUR-vs-THEIR. Use `sourceRef` for the meeting title.

Message format (still ONE Telegram, still only for NEW items):

```
[Meeting title from sourceRef]

WE committed to (outbound) — your action items:
1. [text]
   ↳ "[sourceQuote, truncated to 140 chars]" (only if sourceQuote non-empty)

FYI — they committed to us (inbound, NOT your action item):
1. [owner] owes: [text] (their deadline: [deadline], if any)
   ↳ "[sourceQuote, truncated to 140 chars]" (only if sourceQuote non-empty)
```

Rules:
- Omit an empty section entirely (no outbound → skip WE block; no inbound → skip THEY block).
- WE block only: may show `— due [deadline]` as a Josh due-date. THEY block: never use the word "due" for Josh — always phrase as "[owner]'s deadline" / "their deadline", since the date belongs to them, not Josh. Never phrase an inbound item so it reads as something Josh owes.
- Inbound `text` already carries the `[inbound] Owner:` prefix from the extractor — strip that prefix when rendering (owner is shown from the `owner` field instead).
- Keep the existing DEGRADED prepend rule (if `DEGRADED=1`, prepend one line noting commitments were NOT persisted to the tasks board — missing `BRIEFS_INGEST_URL`/`TASKS_INGEST_TOKEN` in the agent's `.env`).
- Underscore-heavy strings go in backticks (Telegram markdown rule).

If `items` is empty or everything was deduped: no new-commitments section (overdue / orphan steps may still send).

---

## Step 5b — Overdue chase from client files

The client-file `## Open Items` table (`orgs/clearworksai/knowledge/clients/*.md`) is the canonical deadline store. Every run, flag rows with Status `OPEN` and Deadline strictly before today (UTC). Dedup key `overdue_<file-basename>_<md5 of item+deadline>` in the SAME surfaced ledger — each item+deadline pair pings once; if the deadline is renegotiated (row edited) it re-pings once.

```bash
cd "$AGENT_DIR"
CLIENTS_DIR="${CLIENTS_DIR:-$ORG_ROOT/knowledge/clients}"
SURFACED_FILE="${SURFACED_FILE:-$AGENT_DIR/state/meeting-commitments-surfaced.txt}"
TODAY=$(date -u +%F)
OVERDUE_LINES=""
for f in "$CLIENTS_DIR"/*.md; do
  [ -e "$f" ] || continue
  base=$(basename "$f"); [ "$base" = "_template.md" ] && continue
  while IFS='|' read -r _ item owner deadline source st _; do
    item=$(echo "$item" | xargs); owner=$(echo "$owner" | xargs)
    deadline=$(echo "$deadline" | xargs); st=$(echo "$st" | xargs)
    [ -z "$item" ] && continue
    case "$st" in OPEN|open|Open) ;; *) continue;; esac
    echo "$deadline" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || continue
    [ "$deadline" \< "$TODAY" ] || continue
    KEY="overdue_${base}_$(printf '%s|%s' "$item" "$deadline" | md5 -q)"
    grep -qF "$KEY" "$SURFACED_FILE" && continue
    echo "$KEY $(date -u +%s)" >> "$SURFACED_FILE"
    OVERDUE_LINES="${OVERDUE_LINES}- ${base%.md}: ${item} (owner: ${owner}, was due ${deadline})"$'\n'
  done < <(awk '/^## Open Items/{flag=1;next}/^## /{flag=0}flag && /^\|/' "$f" | tail -n +3)
done
printf '%s' "$OVERDUE_LINES" > /tmp/overdue-chase.txt
echo "overdue_count=$(grep -c . /tmp/overdue-chase.txt || true)"
```

Surface rule: if `/tmp/overdue-chase.txt` is non-empty, append to the SAME single Telegram message from Step 5 (or send it alone if there were no new commitments):

```
OVERDUE — unconfirmed past deadline (from client files):
[contents of /tmp/overdue-chase.txt]
```

If both new-commitments and overdue are empty: continue to Step 5c (orphans may still send); if all three empty: SILENT-OK, no Telegram.

---

## Step 5c — Orphan transcript audit

Run the audit every fire; dedup key `orphan_<basename>_<YYYY-MM-DD>` in the same surfaced ledger → each orphan pings at most once per UTC day, and keeps nagging daily until `Processed: yes` lands (deliberate — the rule is a hard rule; knowledge.md #6).

```bash
cd "$AGENT_DIR"
SURFACED_FILE="${SURFACED_FILE:-$AGENT_DIR/state/meeting-commitments-surfaced.txt}"
TODAY=$(date -u +%F)
ORPHAN_LINES=""
while read -r _ base; do
  KEY="orphan_${base}_${TODAY}"
  grep -qF "$KEY" "$SURFACED_FILE" && continue
  echo "$KEY $(date -u +%s)" >> "$SURFACED_FILE"
  ORPHAN_LINES="${ORPHAN_LINES}- ${base}"$'\n'
done < <(bash scripts/orphan-meeting-audit.sh | grep '^ORPHAN ' || true)
printf '%s' "$ORPHAN_LINES" > /tmp/orphan-audit.txt
echo "orphan_count=$(grep -c . /tmp/orphan-audit.txt || true)"
```

Surface rule: non-empty `/tmp/orphan-audit.txt` → append one section to the run's single Telegram message (or send alone):

```
ORPHAN TRANSCRIPTS — filed >1 day, outcomes never extracted (rule: knowledge.md #6):
[lines]
Run the Meeting Intelligence Engineer on each.
```

All-empty run (no commitments, no overdue, no orphans) stays SILENT-OK.

---

## Step 6 — Complete and exit

```bash
cortextos bus complete-task $TASK_ID --result "Meeting commitments checked" 2>/dev/null
cortextos bus log-event action cron_completed info --meta "{\"cron\":\"meeting-commitments\",\"agent\":\"$OWNER_AGENT\"}" 2>/dev/null
# FINAL — self-terminate this worker PTY so it does not leak (worker-leak fix #25)
cortextos terminate-worker "$CTX_AGENT_NAME"
```

Output literally: `DONE`
