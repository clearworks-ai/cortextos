#!/usr/bin/env bash
# staging-up — launch the staging daemon, ISOLATED, with a hard guard:
# if it discovers ANY agent other than the tlab* test agents, kill it immediately
# (protects against a framework-root misread spawning the real fleet).
set -uo pipefail

INSTANCE="cortextos-staging"
HOME_DIR="$HOME/.cortextos/$INSTANCE"
FW_ROOT="$HOME/.cortextos/$INSTANCE-fw"
REPO="/Users/joshweiss/code/cortextos"
LOG="$HOME_DIR/logs/daemon.out"

# refuse if verify hasn't passed
bash "$REPO/scripts/staging/staging-verify.sh" >/dev/null 2>&1 || { echo "REFUSE: staging-verify failed"; exit 2; }

mkdir -p "$HOME_DIR/logs"
echo "== launching $INSTANCE (fw=$FW_ROOT) =="
# NOTE: CTX_PROJECT_ROOT intentionally UNSET (resolveEnv rejects fw!=project if both set).
CTX_INSTANCE_ID="$INSTANCE" \
CTX_ROOT="$HOME_DIR" \
CTX_FRAMEWORK_ROOT="$FW_ROOT" \
CTX_ORG="clearworksai" \
  nohup node "$REPO/dist/daemon.js" >"$LOG" 2>&1 &
PID=$!
echo "launched pid=$PID; waiting 6s to inspect discovery…"
sleep 6

# GUARD: what agents did it discover/start?
started=$(grep -iE 'discover|starting agent|Skipping disabled' "$LOG" 2>/dev/null | tail -20)
bad=$(echo "$started" | grep -iE 'starting agent' | grep -viE 'tlab' || true)
echo "--- discovery tail ---"; echo "$started" | tail -8
if [[ -n "$bad" ]]; then
  echo "!! GUARD TRIPPED: staging tried to start non-tlab agent(s) — killing pid $PID"
  echo "$bad"
  kill "$PID" 2>/dev/null; pkill -P "$PID" 2>/dev/null
  exit 3
fi
echo "OK: staging daemon up, only tlab* in scope. sock=$HOME_DIR/daemon.sock pid=$PID"
echo "$PID" > "$HOME_DIR/staging-daemon.pid"
