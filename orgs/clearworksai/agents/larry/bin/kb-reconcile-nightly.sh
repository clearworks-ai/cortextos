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
# Pass raw output directly to python for proper JSON parsing
# Compose row using python3 to handle JSON parsing safely
RECON_OUT="$RECON_OUT" EDGES_OUT="$EDGES_OUT" python3 - "$RECON_STATUS" "$EDGES_STATUS" "$TS" "$LEDGER" <<'PYTHON_SCRIPT'
import sys
import json
import os
import re

recon_status = int(sys.argv[1])
edges_status = int(sys.argv[2])
ts = sys.argv[3]
ledger_path = sys.argv[4]

# Read raw output from environment (passed from bash)
recon_raw = os.environ.get('RECON_OUT', '')
edges_raw = os.environ.get('EDGES_OUT', '')

# Parse RECON_OUT using JSONDecoder.raw_decode to find LAST valid JSON object
try:
    if recon_raw.strip():
        # Find last '{' that starts a line (to avoid SKIP error messages with braces)
        decoder = json.JSONDecoder()
        lines = recon_raw.split('\n')
        start_idx = -1
        for i in range(len(lines) - 1, -1, -1):
            if lines[i].strip().startswith('{'):
                # Found the last line starting with '{'
                # Calculate the byte index of this line
                prefix = '\n'.join(lines[:i]) + '\n' if i > 0 else ''
                start_idx = len(prefix)
                break
        
        if start_idx != -1:
            recon_data, _ = decoder.raw_decode(recon_raw[start_idx:])
        else:
            recon_data = {}
    else:
        recon_data = {}
except (json.JSONDecodeError, ValueError):
    recon_data = {}

# Parse EDGES_OUT (already clean JSON)
try:
    if edges_raw.strip():
        edges_data = json.loads(edges_raw)
    else:
        edges_data = {}
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
    "errors": len(edges_data.get("errors", []) or [])
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

# Exit nonzero if either status is nonzero or if the composed row isn't green
final_status = 0 if (recon_status == 0 and edges_status == 0 and green) else 1
sys.exit(final_status)
PYTHON_SCRIPT

# Script exits with the reconcile status from the python3 block