#!/usr/bin/env bash
# staging-down — stop the staging daemon (only ever the staging instance).
set -uo pipefail
INSTANCE="cortextos-staging"
HOME_DIR="$HOME/.cortextos/$INSTANCE"
PIDF="$HOME_DIR/staging-daemon.pid"
if [[ -f "$PIDF" ]]; then
  PID=$(cat "$PIDF")
  echo "stopping staging daemon pid=$PID"
  kill "$PID" 2>/dev/null; pkill -P "$PID" 2>/dev/null || true
  rm -f "$PIDF"
else
  # fallback: kill any daemon.js whose env names the staging instance
  pkill -f "CTX_INSTANCE_ID=$INSTANCE" 2>/dev/null || true
  echo "no pidfile; attempted env-scoped kill"
fi
echo "done"
