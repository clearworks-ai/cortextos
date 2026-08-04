#!/usr/bin/env bash
# Nightly KB content-health maintenance sweep (Tier 1 deterministic, zero-LLM).
#
# Sibling of kb-reconcile-nightly.sh (NOT a step inside it) so a maintenance-sweep crash
# can never redden the index-reconcile ledger. Runs the six Tier-1 scans over the live
# knowledge-sync corpus, appends one green/red row to kb-maintenance-ledger.jsonl, and
# writes a dated findings file. Launched in background by larry's kb-maintenance cron.
#
# Design: knowledge-sync/raw/areas/clearworks/altari-skilltree/DESIGN-D-knowledge-base.md §3.
#
# Args (all optional):
#   --canary                 also run the live seed read-canary (needs `cortextos bus`)
#   --changed-files a,b,c    Tier-3 event marks from the reconcile row (raw paths)
set -u
REPO=/Users/joshweiss/code/cortextos
PY="$REPO/knowledge-base/venv/bin/python3"
[[ -x "$PY" ]] || PY="python3"
SCRIPT="$REPO/knowledge-base/scripts/kb_maintenance.py"
LEDGER="$REPO/orgs/clearworksai/agents/larry/state/kb-maintenance-ledger.jsonl"
FINDINGS_DIR="$HOME/code/knowledge-sync/system/kb-maintenance"

# Source org secrets (kb-query canary needs the same env reconcile uses).
SECRETS_FILE="$REPO/orgs/clearworksai/secrets.env"
[[ -f "$SECRETS_FILE" ]] && set -o allexport && source "$SECRETS_FILE" && set +o allexport

# mmrag requires MMRAG_DIR at import time (sys.exit(2) if unset). Same line
# kb-reconcile-nightly.sh uses — without it kb_maintenance.py crashes on every fire.
export MMRAG_DIR="$HOME/.cortextos/${CTX_INSTANCE_ID:-default}/orgs/clearworksai/knowledge-base"

"$PY" "$SCRIPT" \
  --tier 1 \
  --ledger "$LEDGER" \
  --findings-dir "$FINDINGS_DIR" \
  --json \
  "$@" 2>>/tmp/kb-maintenance-sweep.err
STATUS=$?

# Exit nonzero if the sweep itself crashed (a scan errored) — the cron prompt checks the
# previous row and Telegrams Josh only on red/missing, same pattern as kb-reconcile.
exit $STATUS
