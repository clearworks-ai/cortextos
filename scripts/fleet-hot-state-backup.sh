#!/usr/bin/env bash
#
# fleet-hot-state-backup.sh — git-tracked CANONICAL source for the fleet
# hot-state backup. Snapshots the irreplaceable, not-in-git fleet hot-state
# to a timestamped local archive with rotation.
#
# WHY: all fleet runtime state (crons, ~11.5k tasks, RAG vector store, mission
# anchors, inbox, config) is a single un-backed-up copy on disk. A clobber (CRM
# once overwrote a mission file) or corruption is unrecoverable. This gives
# point-in-time history so any single bad write is recoverable.
#
# Scope map (verified 2026-07-05):
#   .agent/one-big-feature/fleet-hot-state-backup/00-state-map.md
#
# LOCAL-ONLY by design. State includes secrets (.env / config) — do NOT push
# these archives to any off-box/remote destination without scrubbing + Josh's ok.
#
# Restore: see scripts/RESTORE-fleet-hot-state.md for full runbook.
#   Quick form: `tar xzf <archive> -C /` (archives store absolute paths with
#   the leading slash stripped; extract from / to restore in place).
#
# CANONICAL SOURCE: this repo-root copy (scripts/fleet-hot-state-backup.sh) is
# the git-tracked canonical source. The operational cron entrypoint is kept in
# sync with it at:
#   orgs/clearworksai/agents/larry/scripts/fleet-state-backup.sh
# Do NOT edit the cron entrypoint directly — edit here, then sync the live copy
# before the next cron tick.
#
# Usage:
#   scripts/fleet-hot-state-backup.sh              # take a snapshot + rotate
#   scripts/fleet-hot-state-backup.sh --dry-run    # print what would be archived, take none
#
set -euo pipefail

# --- config ---------------------------------------------------------------
HOME_CTX="${HOME}/.cortextos"
ACTIVE_INSTANCE="$(cat "${HOME_CTX}/state/ACTIVE_INSTANCE" 2>/dev/null || echo cortextos1)"
DATA_ROOT="${HOME_CTX}/${ACTIVE_INSTANCE}"
REPO_ROOT="${HOME}/code/cortextos"
BACKUP_DIR="${HOME}/.cortextos-backups"
KEEP="${FLEET_BACKUP_KEEP:-5}"          # how many snapshots to retain
LOG_FILE="${BACKUP_DIR}/backup.log"
TS="$(date +%Y%m%dT%H%M%S)"
ARCHIVE="${BACKUP_DIR}/fleet-state-${TS}.tar.gz"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

mkdir -p "${BACKUP_DIR}"
# HARDENING 1: archives contain .env/config secrets; lock the backup dir so it
# is not world-readable (drwxr-xr-x → drwx------). Best-effort: never abort.
chmod 700 "${BACKUP_DIR}" 2>/dev/null || true

log() { echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] $*" | tee -a "${LOG_FILE}"; }

# --- include set (irreplaceable, not in git) ------------------------------
# Paths are relative to / ; missing paths are skipped (tar --ignore-failed-read).
INCLUDES=(
  "${DATA_ROOT}/.cortextOS"                                   # all agents' crons.json
  "${DATA_ROOT}/tasks"                                        # instance/audit tasks
  "${DATA_ROOT}/orgs/clearworksai/tasks"                      # main task store (~11.5k)
  "${DATA_ROOT}/orgs/personal/tasks"
  "${DATA_ROOT}/orgs/clearworksai/approvals"
  "${DATA_ROOT}/orgs/clearworksai/deliverables"
  "${DATA_ROOT}/orgs/clearworksai/knowledge-base/chromadb"    # live RAG vector store
  "${DATA_ROOT}/orgs/clearworksai/knowledge-base/config.json"
  "${DATA_ROOT}/orgs/clearworksai/knowledge-base/media"
  "${DATA_ROOT}/inbox"                                        # undelivered bus msgs
  "${DATA_ROOT}/config"
  "${DATA_ROOT}/.env"
  "${DATA_ROOT}/dashboard.env"
  "${DATA_ROOT}/state"                                        # per-agent session/heartbeat (filtered below)
  "${HOME_CTX}/state/ACTIVE_INSTANCE"
  "${REPO_ROOT}/orgs"                                         # gitignored mission/memory/goals/config
  "${HOME}/.claude/projects"                                 # Claude Code session transcripts: main .jsonl + subagents/ + tool-results/ (irreplaceable, not in git; loss found 2026-07-08)
)

# --- exclude filters (regenerable / disposable / stale / bloat / secrets-heavy) ---
EXCLUDES=(
  --exclude="*/logs"
  --exclude="*/processed"
  # Ephemeral per-run session scratch — lives under both state/ AND inbox/, so
  # match the prefix anywhere (do NOT anchor to */state/).
  --exclude="*/comms-check-*"
  --exclude="*/meeting-commitments-*"
  --exclude="*/fleet-reconcile-*"
  --exclude="*/knowledge-base/embedding-cache.sqlite"        # 3.3G, re-derivable
  --exclude="*/knowledge-base/chromadb.bak-*"
  --exclude="*/knowledge-base/chromadb.old-*"
  --exclude="*/knowledge-base/chromadb.archived-*"
  --exclude="*/agents/larry/state/deploy-*.log"              # ~190M disposable
  --exclude="*/agents/larry/state/cowork-handoff-pkg"        # 61M disposable
  --exclude="*/node_modules"
  --exclude="*/.git"
  --exclude="*/projects/*claude-mem-observer*"               # 1.4G regenerable observer store, not agent transcripts
)
# NOTE: do NOT exclude "*/.cortextOS" — that suffix-matches the LIVE crons dir
# ${DATA_ROOT}/.cortextOS (the crown jewel) and would silently drop every
# agent's crons.json. The stale repo-relative .cortextOS is not under any
# include path (we include ${REPO_ROOT}/orgs, not ${REPO_ROOT}), so no exclude
# is needed for it.

# --- present-only include list (skip missing) -----------------------------
PRESENT=()
for p in "${INCLUDES[@]}"; do
  [ -e "$p" ] && PRESENT+=("$p") || log "skip (absent): $p"
done

if [ "${#PRESENT[@]}" -eq 0 ]; then
  log "ERROR: no include paths present — aborting (data root ${DATA_ROOT} wrong?)"
  exit 1
fi

if [ "${DRY_RUN}" -eq 1 ]; then
  log "DRY-RUN: would archive ${#PRESENT[@]} roots → ${ARCHIVE}"
  printf '  include: %s\n' "${PRESENT[@]}"
  du -sch "${PRESENT[@]}" 2>/dev/null | tail -1 | sed 's/^/  raw total: /'
  exit 0
fi

# --- snapshot -------------------------------------------------------------
log "snapshot start → ${ARCHIVE} (instance=${ACTIVE_INSTANCE}, keep=${KEEP})"
# Include paths are pre-filtered to existing entries (PRESENT[]); bsdtar (macOS
# default) has no --ignore-failed-read. It still exits rc=1 on "file changed as
# we read it" for transient files, which is non-fatal for a snapshot.
tar "${EXCLUDES[@]}" -czf "${ARCHIVE}" "${PRESENT[@]}" 2>>"${LOG_FILE}" || {
  rc=$?
  if [ "$rc" -ne 1 ]; then
    log "ERROR: tar failed rc=${rc} — removing partial archive"
    rm -f "${ARCHIVE}"
    exit "$rc"
  fi
  log "tar rc=1 (files changed mid-read) — archive still usable"
}

SIZE="$(du -h "${ARCHIVE}" | cut -f1)"
log "snapshot OK: ${ARCHIVE} (${SIZE})"

# HARDENING 3: restrict the archive file itself (it contains secrets).
chmod 600 "${ARCHIVE}" 2>/dev/null || true

# HARDENING 2: gzip integrity check before rotation — a corrupt new archive
# must never cause a good old one to be pruned. Run BEFORE the rotation step.
if gzip -t "${ARCHIVE}" 2>>"${LOG_FILE}"; then
  log "integrity OK (gzip -t): ${ARCHIVE}"
else
  log "ERROR: gzip -t FAILED on ${ARCHIVE} — removing corrupt archive"
  rm -f "${ARCHIVE}"
  exit 1
fi

# --- rotate (keep newest ${KEEP}) -----------------------------------------
# Portable to macOS bash 3.2 (no mapfile): stream oldest-beyond-KEEP into a loop.
ls -1t "${BACKUP_DIR}"/fleet-state-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while IFS= read -r f; do
  [ -n "$f" ] || continue
  rm -f "$f" && log "pruned old snapshot: $(basename "$f")"
done

log "done — $(ls -1 "${BACKUP_DIR}"/fleet-state-*.tar.gz 2>/dev/null | wc -l | tr -d ' ') snapshot(s) retained"
