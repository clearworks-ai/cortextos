#!/usr/bin/env bash
# Daily client-facing-automation stall sweep (Altari lane G / DESIGN-G-qa-reliability.md §2).
#
# Walks the machine-readable table in
#   ~/code/knowledge-sync/raw/areas/clearworks/production-stack.md
# and classifies each automation HEALTHY / DEGRADED / FAILING / STALLED / UNKNOWN from its real
# evidence source (a tailable file's mtime, plus an optional green_field on the last JSON line).
#
# Silent-unless-wrong, modeled on the fleet's kb-reconcile-nightly.sh / kb-maintenance-sweep.sh
# style: a STALLED/FAILING CLIENT-FACING row Telegrams Josh + opens a deduped bus task; everything
# else stays quiet (a FAILING non-client-facing row still logs a durable bus event). One summary
# bus log-event per sweep. Launched daily by larry's production-stack-sweep cron (17 6 * * *).
#
# Usage:
#   production-stack-sweep.sh [--dry-run] [--inventory PATH]
#     --dry-run       classify + print a table to stdout; no Telegram, no task, no bus log-event.
#     --inventory P   override the inventory path (default: the knowledge-sync path above).
set -u

REPO=/Users/joshweiss/code/cortextos
INVENTORY="$HOME/code/knowledge-sync/raw/areas/clearworks/production-stack.md"
TELEGRAM_CHAT_ID=6690120787
DRY_RUN=0
NOW=$(date -u +%s)
TODAY=$(date -u +%Y-%m-%d)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --inventory) INVENTORY="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$INVENTORY" ]]; then
  echo "production-stack-sweep: inventory not found: $INVENTORY" >&2
  exit 1
fi

# --- helpers ---------------------------------------------------------------

# mtime of a file in epoch seconds (portable: try GNU stat, then BSD/macOS stat).
file_mtime_epoch() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
}

# Extract a boolean field from the last non-empty JSON line of a file.
# Echoes "true" / "false" / "" (empty = couldn't parse). Never crashes the sweep.
last_json_green() {
  local file="$1" field="$2"
  python3 - "$file" "$field" <<'PY' 2>/dev/null
import sys, json
path, field = sys.argv[1], sys.argv[2]
last = None
try:
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                last = line
    if last is None:
        print(""); sys.exit(0)
    row = json.loads(last)
    val = row.get(field)
    if isinstance(val, bool):
        print("true" if val else "false")
    else:
        print("")
except Exception:
    print("")
PY
}

# --- classification --------------------------------------------------------

REPORT_LINES=()
ESCALATE=()            # client-facing STALLED/FAILING (name|class)
FAILING_LOG=()         # any FAILING (name|class) for a durable bus log-event
# Plain counters (bash 3.2 on macOS has no associative arrays).
C_HEALTHY=0; C_DEGRADED=0; C_FAILING=0; C_STALLED=0; C_UNKNOWN=0

# iso date (YYYY-MM-DD) -> epoch seconds, or empty on parse failure.
iso_date_epoch() {
  python3 - "$1" <<'PY' 2>/dev/null
import sys, datetime
try:
    d = datetime.datetime.strptime(sys.argv[1], "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc)
    print(int(d.timestamp()))
except Exception:
    print("")
PY
}

classify_row() {
  local name="$1" cadence_h="$2" evidence="$3" green_field="$4" client="$5" since="$6"
  local cadence_s=$(( cadence_h * 3600 ))
  local stalled_s=$(( cadence_s * 2 ))
  local cls=""

  if [[ "$evidence" == "UNKNOWN" ]]; then
    cls="UNKNOWN"
  else
    local full="$REPO/$evidence"
    if [[ ! -f "$full" ]]; then
      # Missing evidence file: new-and-hasn't-fired-yet (UNKNOWN) vs wired-but-stalled (STALLED).
      local since_epoch age_since
      since_epoch=$(iso_date_epoch "$since")
      if [[ -n "$since_epoch" ]]; then
        age_since=$(( NOW - since_epoch ))
        if (( age_since > stalled_s )); then cls="STALLED"; else cls="UNKNOWN"; fi
      else
        cls="UNKNOWN"
      fi
    else
      local mtime age
      mtime=$(file_mtime_epoch "$full")
      if [[ -z "$mtime" ]]; then
        cls="FAILING"                       # file present but unstattable
      else
        age=$(( NOW - mtime ))
        local green=""
        if [[ "$green_field" != "-" ]]; then
          green=$(last_json_green "$full" "$green_field")
          if [[ -z "$green" ]]; then
            cls="FAILING"                   # green_field expected but unparseable
          fi
        fi
        if [[ -z "$cls" ]]; then
          if (( age > stalled_s )); then
            cls="STALLED"
          elif [[ "$green" == "false" ]]; then
            cls="DEGRADED"
          elif (( age > cadence_s )); then
            cls="DEGRADED"
          else
            cls="HEALTHY"
          fi
        fi
      fi
    fi
  fi

  case "$cls" in
    HEALTHY)  C_HEALTHY=$(( C_HEALTHY + 1 )) ;;
    DEGRADED) C_DEGRADED=$(( C_DEGRADED + 1 )) ;;
    FAILING)  C_FAILING=$(( C_FAILING + 1 )) ;;
    STALLED)  C_STALLED=$(( C_STALLED + 1 )) ;;
    UNKNOWN)  C_UNKNOWN=$(( C_UNKNOWN + 1 )) ;;
  esac
  REPORT_LINES+=("$(printf '%-26s %-9s %s' "$name" "$cls" "$evidence")")
  if [[ "$cls" == "STALLED" || "$cls" == "FAILING" ]]; then
    [[ "$client" == "y" ]] && ESCALATE+=("$name|$cls")
    [[ "$cls" == "FAILING" ]] && FAILING_LOG+=("$name|$cls")
  fi
}

# --- parse the inventory table ---------------------------------------------
# Rows are pipe tables with exactly 8 data columns. Skip the header row (name) and the
# markdown separator row (---). Anything else that isn't an 8-column pipe row is ignored.
while IFS= read -r line; do
  [[ "$line" != \|* ]] && continue
  # strip leading/trailing pipe, split on |
  local_trimmed="${line#|}"; local_trimmed="${local_trimmed%|}"
  IFS='|' read -r -a cells <<< "$local_trimmed"
  [[ ${#cells[@]} -ne 8 ]] && continue
  # trim each cell
  for i in "${!cells[@]}"; do
    c="${cells[$i]}"; c="${c#"${c%%[![:space:]]*}"}"; c="${c%"${c##*[![:space:]]}"}"; cells[$i]="$c"
  done
  name="${cells[0]}"
  [[ "$name" == "name" ]] && continue                     # header
  [[ "$name" =~ ^-+$ ]] && continue                        # separator
  cadence="${cells[2]}"
  [[ ! "$cadence" =~ ^[0-9]+$ ]] && continue               # not a data row
  classify_row "$name" "$cadence" "${cells[3]}" "${cells[4]}" "${cells[5]}" "${cells[7]}"
done < "$INVENTORY"

# --- output ----------------------------------------------------------------

SUMMARY="HEALTHY=$C_HEALTHY DEGRADED=$C_DEGRADED FAILING=$C_FAILING STALLED=$C_STALLED UNKNOWN=$C_UNKNOWN"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "production-stack-sweep (dry-run) — $TODAY"
  echo "----------------------------------------------------------------"
  printf '%s\n' "${REPORT_LINES[@]}"
  echo "----------------------------------------------------------------"
  echo "$SUMMARY"
  if [[ ${#ESCALATE[@]} -gt 0 ]]; then
    echo "WOULD ESCALATE (client-facing STALLED/FAILING):"
    printf '  %s\n' "${ESCALATE[@]}"
  else
    echo "WOULD ESCALATE: none"
  fi
  exit 0
fi

# Durable bus log-event for any FAILING row (even non-client-facing), so there's a record.
for entry in "${FAILING_LOG[@]}"; do
  fname="${entry%%|*}"
  cortextos bus log-event reliability automation-failing error \
    --meta "{\"automation\":\"$fname\",\"sweep\":\"production-stack\",\"date\":\"$TODAY\"}" \
    >/dev/null 2>&1 || true
done

# Escalate client-facing STALLED/FAILING: Telegram + a deduped bus task per automation+date.
if [[ ${#ESCALATE[@]} -gt 0 ]]; then
  msg="⚠️ production-stack sweep — client-facing automation(s) not healthy ($TODAY):"
  for entry in "${ESCALATE[@]}"; do
    ename="${entry%%|*}"; ecls="${entry##*|}"
    msg="$msg"$'\n'"• $ename — $ecls"
    # Dedup: only create a task if one for this automation+date doesn't already exist.
    task_title="production-stack: $ename $ecls ($TODAY)"
    existing=$(cortextos bus list-tasks --json 2>/dev/null \
      | python3 -c "import sys,json;
try:
    d=json.load(sys.stdin); ts=d if isinstance(d,list) else d.get('tasks',[])
    print(sum(1 for t in ts if t.get('title')=='$task_title'))
except Exception:
    print(0)" 2>/dev/null || echo 0)
    if [[ "${existing:-0}" == "0" ]]; then
      cortextos bus create-task "$task_title" --assign larry --priority normal \
        >/dev/null 2>&1 || true
    fi
  done
  cortextos bus send-telegram "$TELEGRAM_CHAT_ID" "$msg" >/dev/null 2>&1 || true
fi

# Always: one summary bus log-event with the per-class counts.
cortextos bus log-event reliability production-stack-sweep info \
  --meta "{\"date\":\"$TODAY\",\"counts\":{\"healthy\":$C_HEALTHY,\"degraded\":$C_DEGRADED,\"failing\":$C_FAILING,\"stalled\":$C_STALLED,\"unknown\":$C_UNKNOWN},\"escalated\":${#ESCALATE[@]}}" \
  >/dev/null 2>&1 || true

exit 0
