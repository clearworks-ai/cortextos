#!/usr/bin/env bash
set -u

AGENT_DIR="${CTX_AGENT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
CORTEXTOS_BIN="${CORTEXTOS_BIN:-cortextos}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
ENV_FILE="${ENV_FILE:-$AGENT_DIR/.env}"
EXTRACTOR_PATH="${EXTRACTOR_PATH:-$AGENT_DIR/scripts/ff-extractor.py}"

TASK_ID="$($CORTEXTOS_BIN bus create-task "Cron: ff-extractor" --desc "Extract Fireflies meeting commitments to briefs board" 2>/dev/null)" || exit 1
$CORTEXTOS_BIN bus update-task "$TASK_ID" in_progress 2>/dev/null || exit 1
$CORTEXTOS_BIN bus update-cron-fire ff-extractor --interval 4h 2>/dev/null || true

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

cd "$AGENT_DIR" || exit 1
"$PYTHON_BIN" "$EXTRACTOR_PATH"
EXTRACTOR_RC=$?

if [[ "$EXTRACTOR_RC" -eq 0 ]]; then
  $CORTEXTOS_BIN bus log-event action ff_extractor_ran info --meta '{"provider":"codex-subscription","status":"success"}' 2>/dev/null || true
  $CORTEXTOS_BIN bus complete-task "$TASK_ID" --result "ff-extractor ran successfully" 2>/dev/null || exit 1
  exit 0
fi

$CORTEXTOS_BIN bus log-event error ff_extractor_failed error --meta "{\"provider\":\"codex-subscription\",\"exit_code\":$EXTRACTOR_RC}" 2>/dev/null || true
$CORTEXTOS_BIN bus update-task "$TASK_ID" blocked 2>/dev/null || true
exit "$EXTRACTOR_RC"
