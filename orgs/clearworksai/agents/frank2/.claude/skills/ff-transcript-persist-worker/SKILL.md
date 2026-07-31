# FF Transcript Persist Worker

You are a SHORT-LIVED WORKER SESSION. Your only job is to persist newly available Fireflies transcripts into `knowledge/transcripts/*.md`, ingest any new files into the knowledge base, and stop.

DO NOT:
- Read bootstrap files
- Update heartbeat
- Write daily memory
- Send Telegram
- Emit narration

DO:
- Run the bash blocks below in order
- Stay SILENT-OK when nothing new is written
- Output `DONE` when complete

## Step 1 — Create task + cron bookkeeping

```bash
TASK_ID=$(cortextos bus create-task "Cron: ff-transcript-persist" --desc "Persist new Fireflies transcripts into knowledge/transcripts" --assignee "${CTX_PARENT_AGENT:-frank2}" 2>/dev/null)
cortextos bus update-task "$TASK_ID" in_progress 2>/dev/null
cortextos bus update-cron-fire ff-transcript-persist --interval 2h 2>/dev/null
mkdir -p state
LEDGER_FILE="state/ff-transcript-persist-ledger.txt"
[[ -f "$LEDGER_FILE" ]] || touch "$LEDGER_FILE"
```

## Step 2 — Run the transcript persist script

Working directory MUST be the frank2 agent dir so `scripts/` and `state/` resolve correctly.

```bash
cd /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2
set -a
source /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/.env 2>/dev/null
source /Users/joshweiss/code/cortextos/orgs/clearworksai/secrets.env 2>/dev/null
set +a

python3 scripts/ff-transcript-persist.py --limit 20 --ledger state/ff-transcript-persist-ledger.txt > /tmp/ff-transcript-persist.json
PERSIST_RC=$?
echo "persist_rc=$PERSIST_RC"
```

If `PERSIST_RC` is nonzero, skip directly to Step 4.

## Step 3 — Ingest new transcript files if any were written

```bash
python3 - <<'PY'
import json
import subprocess
from pathlib import Path

payload = json.loads(Path("/tmp/ff-transcript-persist.json").read_text(encoding="utf-8"))
files = payload.get("files") or []
if payload.get("persisted", 0) <= 0 or not files:
    raise SystemExit(0)
paths = [str(Path("/Users/joshweiss/code/cortextos/orgs/clearworksai") / rel) for rel in files]
subprocess.run(
    ["cortextos", "bus", "kb-ingest", *paths, "--org", "clearworksai", "--scope", "shared"],
    check=True,
)
PY
```

## Step 4 — Complete and exit

```bash
RESULT="Transcript persistence checked"
if [[ -f /tmp/ff-transcript-persist.json ]]; then
  RESULT=$(python3 - <<'PY'
import json
from pathlib import Path
payload = json.loads(Path("/tmp/ff-transcript-persist.json").read_text(encoding="utf-8"))
print(
    "Transcript persistence checked: "
    f"persisted={payload.get('persisted', 0)} "
    f"skipped_ledger={payload.get('skipped_ledger', 0)} "
    f"empty={payload.get('empty', 0)}"
)
PY
)
fi
cortextos bus complete-task "$TASK_ID" --result "$RESULT" 2>/dev/null
cortextos bus log-event action cron_completed info --meta '{"cron":"ff-transcript-persist","agent":"frank2"}' 2>/dev/null
cortextos terminate-worker "$CTX_AGENT_NAME"
```

Output literally: `DONE`
