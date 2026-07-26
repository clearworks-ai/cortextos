#!/usr/bin/env bash
# gmail-push-deploy.sh — Idempotent deploy for Gmail Push Listener (pa agent)
#
# RUN THIS YOURSELF (Josh) on the morning after feat/gmail-push-comms merges.
# This script MUST be run interactively — it will refuse if stdin is not a tty.
#
# What it does:
#   1. Copies the LaunchAgent plist to ~/Library/LaunchAgents/
#   2. Loads (or reloads) the LaunchAgent via launchctl bootstrap
#   3. Updates the pa comms-check cron to 4h safety-net sweep
#   4. Prints verify one-liners
#
# DOES NOT:
#   - Start or stop the production daemon (cortextos)
#   - Merge anything to main
#   - Run destructive operations
#
# Rollback:
#   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.clearworks.gmail-push-listener.plist
#   rm ~/Library/LaunchAgents/com.clearworks.gmail-push-listener.plist
#   cortextos bus update-cron pa comms-check --interval 45m
set -euo pipefail

# ---------------------------------------------------------------------------
# Hard gate: interactive-only
# ---------------------------------------------------------------------------
if ! [ -t 0 ]; then
  echo "ERROR: This script must be run interactively (stdin is not a tty)." >&2
  echo "       Do NOT pipe, source, or background this script." >&2
  exit 1
fi

BANNER="
╔═══════════════════════════════════════════════════════════════╗
║       Gmail Push Listener — Morning Deploy (pa agent)         ║
║                                                               ║
║  This will:                                                   ║
║  1. Install ~/Library/LaunchAgents/com.clearworks...plist     ║
║  2. Load the listener via launchctl                           ║
║  3. Retire 45m poll → update comms-check cron to 4h          ║
║                                                               ║
║  Run ONCE after feat/gmail-push-comms merges to main.         ║
║  Rollback: see script header comments.                        ║
╚═══════════════════════════════════════════════════════════════╝
"
echo "$BANNER"

read -r -p "Proceed? [yes/no]: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 0
fi

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_SRC="${SCRIPT_DIR}/com.clearworks.gmail-push-listener.plist"
PLIST_DEST="${HOME}/Library/LaunchAgents/com.clearworks.gmail-push-listener.plist"
LISTENER_SCRIPT="${SCRIPT_DIR}/gmail_push_listener.py"
LOG_DIR="${HOME}/Library/Logs"
LABEL="com.clearworks.gmail-push-listener"

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
echo "[1/5] Pre-flight checks..."

if [ ! -f "$PLIST_SRC" ]; then
  echo "ERROR: plist not found at $PLIST_SRC" >&2
  exit 1
fi

if [ ! -f "$LISTENER_SCRIPT" ]; then
  echo "ERROR: listener script not found at $LISTENER_SCRIPT" >&2
  exit 1
fi

if ! command -v cortextos &>/dev/null; then
  echo "WARNING: cortextos not on PATH — cron update step will be skipped"
fi

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# ---------------------------------------------------------------------------
# Step 1: Copy plist
# ---------------------------------------------------------------------------
echo "[2/5] Installing LaunchAgent plist..."
cp -f "$PLIST_SRC" "$PLIST_DEST"
echo "      → $PLIST_DEST"

# ---------------------------------------------------------------------------
# Step 2: Load/reload the LaunchAgent
# ---------------------------------------------------------------------------
echo "[3/5] Loading LaunchAgent..."
BOOTSTRAP_TARGET="gui/$(id -u)"

# Unload if already loaded (idempotent)
if launchctl list "$LABEL" &>/dev/null 2>&1; then
  echo "      → Unloading existing instance..."
  launchctl bootout "$BOOTSTRAP_TARGET" "$PLIST_DEST" 2>/dev/null || true
  sleep 1
fi

launchctl bootstrap "$BOOTSTRAP_TARGET" "$PLIST_DEST"
echo "      → Loaded: $LABEL"

# Brief wait to confirm it started
sleep 3
if launchctl list "$LABEL" &>/dev/null 2>&1; then
  echo "      → Verified: listener is running"
else
  echo "WARNING: launchctl list did not show $LABEL immediately."
  echo "         Check ~/Library/Logs/gmail-push-listener.err.log for errors."
fi

# ---------------------------------------------------------------------------
# Step 3: Update comms-check cron to 4h safety-net sweep
# ---------------------------------------------------------------------------
echo "[4/5] Updating comms-check cron interval to 4h..."
if command -v cortextos &>/dev/null; then
  cortextos bus update-cron pa comms-check --interval 4h 2>&1 && \
    echo "      → comms-check now fires every 4h (safety-net sweep)" || \
    echo "WARNING: update-cron failed — check cortextos bus list-crons pa"
else
  echo "SKIP: cortextos not on PATH"
fi

# ---------------------------------------------------------------------------
# Step 4: Print verify one-liners
# ---------------------------------------------------------------------------
echo "[5/5] Post-deploy verify one-liners:"
cat <<'VERIFY'

  # Listener in launchctl
  launchctl list | grep gmail-push-listener

  # Listener process
  pgrep -fl gmail_push_listener

  # State file (last_pull, last_spawn, etc.)
  cat ~/.cortextos/cortextos1/state/pa/gmail-push-listener.json

  # Live log
  tail -f ~/Library/Logs/gmail-push-listener.out.log

  # Confirm cron updated
  cortextos bus list-crons pa | grep comms-check

  # Test: send a real email from weissjosh0@gmail.com to josh@clearworks.ai
  # Expected: Telegram ping within 2 minutes
VERIFY

echo ""
echo "Deploy complete. Send a test email and confirm surface within 2 min."
echo ""
echo "ROLLBACK if needed:"
echo "  launchctl bootout gui/\$(id -u) ~/Library/LaunchAgents/com.clearworks.gmail-push-listener.plist"
echo "  rm ~/Library/LaunchAgents/com.clearworks.gmail-push-listener.plist"
echo "  cortextos bus update-cron pa comms-check --interval 45m"
