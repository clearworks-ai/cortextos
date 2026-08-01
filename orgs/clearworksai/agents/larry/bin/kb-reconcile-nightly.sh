#!/usr/bin/env bash
# Nightly KB reconcile: mmrag reconcile (all DEFAULT_RECONCILE_ROOTS) + kb-extract-edges
# refresh + one JSONL counts row. Launched in background by larry's kb-reconcile-nightly cron.
set -u
REPO=/Users/joshweiss/code/cortextos
PY="$REPO/knowledge-base/venv/bin/python3"
MMRAG="$REPO/knowledge-base/scripts/mmrag.py"
LEDGER="$REPO/orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Source org secrets and set MMRAG_DIR
SECRETS_FILE="$REPO/orgs/clearworksai/secrets.env"
[[ -f "$SECRETS_FILE" ]] && set -o allexport && source "$SECRETS_FILE" && set +o allexport
export MMRAG_DIR="$HOME/.cortextos/${CTX_INSTANCE_ID:-default}/orgs/clearworksai/knowledge-base"

# Step 1 — reconcile (defaults cover all 3 DEFAULT_RECONCILE_ROOTS + shared-clearworksai)
RECON_OUT="$("$PY" "$MMRAG" reconcile --json --yes 2>>/tmp/kb-reconcile-nightly.err)"
RECON_STATUS=$?

# Step 2 — edge refresh (deterministic, zero-LLM)
EDGES_OUT="$(cortextos bus kb-extract-edges --org clearworksai --json 2>>/tmp/kb-reconcile-nightly.err)"
EDGES_STATUS=$?

# Step 3 — compose + append counts row
# Parse the LAST JSON object from RECON_OUT (the _emit_report dump)
RECON_JSON=$(echo "$RECON_OUT" | grep -v "^SKIP" | tail -1 | grep -v "^$" || echo "{}")
# Parse EDGES_OUT (already clean JSON)
EDGES_JSON=$(echo "$EDGES_OUT" | grep -v "^$" || echo "{}")

# Compose row using python3 to handle JSON parsing safely
python3 - "$RECON_STATUS" "$EDGES_STATUS" "$RECON_JSON" "$EDGES_JSON" "$TS" "$LEDGER" <<'PYTHON_SCRIPT'
import sys
import json
import os

recon_status = int(sys.argv[1])
edges_status = int(sys.argv[2])
recon_json = sys.argv[3]
edges_json = sys.argv[4]
ts = sys.argv[5]
ledger_path = sys.argv[6]

try:
    recon_data = json.loads(recon_json) if recon_json.strip() else {}
except json.JSONDecodeError:
    recon_data = {}

try:
    edges_data = json.loads(edges_json) if edges_json.strip() else {}
except json.JSONDecodeError:
    edges_data = {}

# Extract reconcile fields with fallbacks
recon_stats = {
    "status": recon_status,
    "new_files": recon_data.get("new_files", 0),
    "new_chunks": recon_data.get("new_chunks", 0),
    "changed_files": recon_data.get("changed_files", 0),
    "removed_files": recon_data.get("removed_files", 0),
    "failed_files": recon_data.get("failed_files", 0),
    "resumed_files": recon_data.get("resumed_files", 0),
    "total_files_on_disk": recon_data.get("total_files_on_disk", 0),
    "total_files_indexed_after": recon_data.get("total_files_indexed_after", 0),
    "delete_failures": recon_data.get("delete_failures", {"files": 0, "chunks": 0, "batches": 0})
}

# Extract edge fields with fallbacks
edges_stats = {
    "status": edges_status,
    "filesScanned": edges_data.get("filesScanned", 0),
    "filesSkippedUnchanged": edges_data.get("filesSkippedUnchanged", 0),
    "edgesUpserted": edges_data.get("edgesUpserted", 0),
    "typedEdges": edges_data.get("typedEdges", 0),
    "errors": edges_data.get("errors", 0)
}

# Determine green status
green = (
    recon_status == 0 and
    edges_status == 0 and
    recon_stats["failed_files"] == 0 and
    recon_stats["delete_failures"]["files"] == 0 and
    recon_stats["delete_failures"]["chunks"] == 0 and
    recon_stats["delete_failures"]["batches"] == 0 and
    edges_stats["errors"] == 0
)

# Compose row
row = {
    "ts": ts,
    "run": "kb-reconcile-nightly",
    "reconcile": recon_stats,
    "edges": edges_stats,
    "green": green
}

# Ensure ledger directory exists
ledger_dir = os.path.dirname(ledger_path)
if ledger_dir:
    os.makedirs(ledger_dir, exist_ok=True)

# Append row to ledger
with open(ledger_path, "a") as f:
    f.write(json.dumps(row) + "\n")

# Exit with reconcile status
sys.exit(recon_status)
PYTHON_SCRIPT

# Script exits with the reconcile status from the python3 block