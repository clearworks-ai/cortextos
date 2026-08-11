---
name: meeting-writeback-worker
description: File Fireflies meeting intelligence into meeting and client knowledge records.
---

# Meeting Writeback Worker

You are a SHORT-LIVED WORKER SESSION. Your only job is to file NEW meeting intelligence into `knowledge/meetings/*.md` and write it back to `knowledge/clients/*.md`. Complete it and stop.

DO NOT:
- Read bootstrap files
- Update heartbeat
- Write to daily memory
- Send Telegram
- Emit kb-dream payloads or guess a kb verdict

DO:
- Run the exact bash blocks below in order
- Stay SILENT-OK on empty
- Output DONE when complete

This worker intentionally stops after file writeback. `kb-dream` emission stays manual only.

---

## Step 1 — Task + ledger setup (Bash)

Everything below resolves against the RUNNING agent's own dir via `$CTX_*`
(never a hardcoded absolute path). The daemon sets, for a spawned worker:
`CTX_AGENT_DIR` (this worker's cwd = the running agent's dir), `CTX_PARENT_AGENT`
(the agent that owns this writeback, e.g. `pa` or `pa-codex`), `CTX_FRAMEWORK_ROOT`,
and `CTX_ORG`. When run outside the daemon (manual/poll), they fall back to `pwd`
and the current org layout.

```bash
AGENT_DIR="${CTX_AGENT_DIR:-$(pwd)}"
FW_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$AGENT_DIR/../../../.." && pwd)}"
ORG="${CTX_ORG:-clearworksai}"
ORG_ROOT="$FW_ROOT/orgs/$ORG"
OWNER_AGENT="${CTX_PARENT_AGENT:-$(basename "$AGENT_DIR")}"

TASK_ID=$(cortextos bus create-task "Cron: meeting-writeback" --desc "File new meeting intelligence into knowledge/meetings and knowledge/clients" --assignee "$OWNER_AGENT" 2>/dev/null)
cortextos bus update-task $TASK_ID in_progress 2>/dev/null
LEDGER_FILE="$AGENT_DIR/state/ff-full-writeback-surfaced.txt"
mkdir -p "$(dirname "$LEDGER_FILE")"
[[ -f "$LEDGER_FILE" ]] || touch "$LEDGER_FILE"
echo "ledger=$(wc -l < "$LEDGER_FILE")"
```

---

## Step 2 — Run the extractor in full mode (Bash)

Working directory MUST be the RUNNING agent's dir (`$CTX_AGENT_DIR`) so `scripts/`
and `state/` resolve correctly. Org secrets are already sourced into a daemon-spawned
worker's env; we re-source defensively for the manual/poll path.

```bash
cd "$AGENT_DIR"
set -a
source "$AGENT_DIR/.env" 2>/dev/null
source "$ORG_ROOT/secrets.env" 2>/dev/null
set +a

if [[ -n "${FF_MEETING_ID:-}" ]]; then
  python3 scripts/ff-extractor.py --mode full --meeting-id "$FF_MEETING_ID" --limit 1 --full-ledger "$LEDGER_FILE" > /tmp/ff-writeback.json
else
  python3 scripts/ff-extractor.py --mode full --limit 20 --full-ledger "$LEDGER_FILE" > /tmp/ff-writeback.json
fi
EXTRACTOR_RC=$?
echo "extractor_rc=$EXTRACTOR_RC"
```

If `EXTRACTOR_RC` is nonzero, skip straight to Step 4. No Telegram, no ledger writes.

---

## Step 3 — File meetings + client writeback (Bash)

For each meeting in `/tmp/ff-writeback.json`:
- File it under `knowledge/meetings/YYYY-MM-DD-[client]-[topic].md`
- Use the exact header schema: `**Attendees:** | **Source:** | **Processed:**`
- Prepend the exact History entry schema to the matched client file
- Append exact Open Items rows (`| Item | Owner | Deadline | Source | Status |`)
- `Owner` fallback = `NEEDS-OWNER`
- `Deadline` fallback = `NEEDS-DEADLINE`
- Append the Fireflies meeting id to the ledger ONLY after both writes succeed for that meeting

```bash
# Re-derive in case this block runs in a fresh shell; export for the module.
AGENT_DIR="${CTX_AGENT_DIR:-$(pwd)}"
FW_ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$AGENT_DIR/../../../.." && pwd)}"
ORG="${CTX_ORG:-clearworksai}"
export ORG_ROOT="$FW_ROOT/orgs/$ORG"
export LEDGER_FILE="$AGENT_DIR/state/ff-full-writeback-surfaced.txt"

python3 "$AGENT_DIR/scripts/meeting_writeback.py" --payload /tmp/ff-writeback.json > /tmp/ff-writeback-result.json
WRITEBACK_RC=$?
echo "writeback_rc=$WRITEBACK_RC"
```

If `WRITEBACK_RC` is nonzero, skip straight to Step 4.

The `crm.meeting.completed` emit is now owned by the daemon on-worker-success hook (FR-002, `src/daemon/meeting-event-emit.ts`), NOT this SKILL. The writeback module above writes the per-meeting payload file (`ff-meeting-event-<safeId>.json`); on worker exit the daemon reads it and emits exactly once (deduped by meeting_id). Do NOT re-add a `cortextos bus send-message crm ...` emit here — it was the broken separate-bash-fence path (WRITEBACK_RC was lost across tool-calls → silent no-emit).

---

## Step 4 — Complete and exit (Bash)

```bash
RESULT="Meeting writeback checked"
if [[ -f /tmp/ff-writeback-result.json ]]; then
  RESULT=$(python3 - <<'PY'
import json
from pathlib import Path
payload = json.loads(Path("/tmp/ff-writeback-result.json").read_text(encoding="utf-8"))
print(
    "Meeting writeback checked: "
    f"written={payload.get('written_count', 0)} "
    f"created_clients={payload.get('created_client_count', 0)}"
)
PY
)
fi
OWNER_AGENT="${CTX_PARENT_AGENT:-${CTX_AGENT_NAME:-pa}}"
cortextos bus complete-task $TASK_ID --result "$RESULT" 2>/dev/null
cortextos bus log-event action cron_completed info --meta "{\"cron\":\"meeting-writeback\",\"agent\":\"$OWNER_AGENT\"}" 2>/dev/null
cortextos terminate-worker "$CTX_AGENT_NAME"
```

Output literally: `DONE`
