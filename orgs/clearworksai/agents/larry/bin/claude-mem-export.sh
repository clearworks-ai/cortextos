#!/usr/bin/env bash
# Nightly claude-mem exporter: new observations/session_summaries -> markdown into
# knowledge-sync raw/areas/clearworks/session-memory/ (ingested by kb-reconcile at 03:37).
# Forward-only: cursor state file; history stays in claude-mem FTS (query on demand).
set -u
REPO=/Users/joshweiss/code/cortextos
DB="$HOME/.claude-mem/claude-mem.db"
OUT_ROOT="$HOME/code/knowledge-sync/raw/areas/clearworks/session-memory"
STATE="$REPO/orgs/clearworksai/agents/larry/state/claude-mem-export-state.json"
LEDGER="$REPO/orgs/clearworksai/agents/larry/state/claude-mem-export-ledger.jsonl"

python3 "$REPO/orgs/clearworksai/agents/larry/bin/claude-mem-export.py" \
  --db "$DB" --out-root "$OUT_ROOT" --state "$STATE" --ledger "$LEDGER" \
  --source-task "${1:-cron:claude-mem-export}" 2>>/tmp/claude-mem-export.err
exit $?