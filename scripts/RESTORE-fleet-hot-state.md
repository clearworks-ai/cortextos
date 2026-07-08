# RESTORE — Fleet Hot-State Backup

Operator runbook for restoring from a `fleet-hot-state-backup.sh` snapshot.
Read the WARNING at the bottom before choosing a path.

---

## What the archive contains

- `~/.cortextos/cortextos1/.cortextOS/` — all agents' `crons.json` (15 agents; 1.7 MB)
- `~/.cortextos/cortextos1/tasks/` — instance/audit task store
- `~/.cortextos/cortextos1/orgs/clearworksai/tasks/` — main task store (~11.5k tasks; 90 MB)
- `~/.cortextos/cortextos1/orgs/personal/tasks/`
- `~/.cortextos/cortextos1/orgs/clearworksai/approvals/`
- `~/.cortextos/cortextos1/orgs/clearworksai/deliverables/`
- `~/.cortextos/cortextos1/orgs/clearworksai/knowledge-base/chromadb/` — live RAG vector store (~981 MB)
- `~/.cortextos/cortextos1/orgs/clearworksai/knowledge-base/config.json`
- `~/.cortextos/cortextos1/orgs/clearworksai/knowledge-base/media/`
- `~/.cortextos/cortextos1/inbox/` — undelivered bus messages
- `~/.cortextos/cortextos1/config/` + `.env` + `dashboard.env` — instance config and secrets
- `~/.cortextos/cortextos1/state/` — per-agent session/heartbeat state
- `~/.cortextos/state/ACTIVE_INSTANCE` — active instance marker
- `~/code/cortextos/orgs/` — gitignored agent working dirs (mission, memory, goals, config)

Total at last verified backup (2026-07-06): ~1.3 GB compressed to ~848 MB.

---

## Where archives live

```
~/.cortextos-backups/fleet-state-<YYYYMMDDTHHMMSS>.tar.gz
```

- Retention: last **5** snapshots (override with `FLEET_BACKUP_KEEP=N`).
- Schedule: daily cron at **10:00**, cron entry managed by larry.
- Log: `~/.cortextos-backups/backup.log`

List available archives:

```bash
ls -lht ~/.cortextos-backups/fleet-state-*.tar.gz
```

---

## Archive format

Archives store **absolute paths with the leading `/` stripped** (standard `tar` behaviour). Extracting to `/` restores files to their original locations.

Example: `Users/joshweiss/.cortextos/cortextos1/tasks/` inside the archive → `/Users/joshweiss/.cortextos/cortextos1/tasks/` on disk.

---

## Step 1 — Verify archive integrity before doing anything

```bash
# Quick gzip check (also runs automatically after every new snapshot)
gzip -t ~/.cortextos-backups/fleet-state-<TS>.tar.gz && echo "OK"

# List top-level contents to confirm archive looks sane
tar -tzf ~/.cortextos-backups/fleet-state-<TS>.tar.gz | head -40
```

---

## Path A — Safe scratch extract (inspect first, restore selectively)

Use this when only one or a few files were clobbered. It does NOT touch live data.

```bash
ARCHIVE=~/.cortextos-backups/fleet-state-<TS>.tar.gz
SCRATCH=/tmp/restore-scratch

mkdir -p "${SCRATCH}"
tar -xzf "${ARCHIVE}" -C "${SCRATCH}"

# Now inspect:
ls "${SCRATCH}/Users/$(whoami)/.cortextos/cortextos1/orgs/clearworksai/tasks/" | wc -l
cat "${SCRATCH}/Users/$(whoami)/.cortextos/cortextos1/.cortextOS/state/agents/larry/crons.json" | python3 -m json.tool > /dev/null && echo "crons valid"

# Copy only the file(s) you need back to live:
cp "${SCRATCH}/Users/$(whoami)/.cortextos/cortextos1/state/larry/current-mission.txt" \
   ~/.cortextos/cortextos1/state/larry/current-mission.txt
```

---

## Path B — Destructive in-place restore (full rollback)

**PRECONDITION: STOP THE DAEMON FIRST.** An in-place restore while the daemon is running risks partial overwrites and leaves the process holding stale file handles.

```bash
# 1. Stop the daemon
pm2 stop cortextos-daemon

# 2. Restore all paths from the archive
ARCHIVE=~/.cortextos-backups/fleet-state-<TS>.tar.gz
tar xzf "${ARCHIVE}" -C /

# 3. Restart the daemon
pm2 start cortextos-daemon
pm2 logs cortextos-daemon --lines 30
```

---

## Verification checks (proven in 01-restore-verified.md, 2026-07-06)

Run these after either path to confirm restore quality:

```bash
SCRATCH=/tmp/restore-scratch   # or /  for in-place

# 1. gzip integrity
gzip -t "${ARCHIVE}" && echo "archive: OK"

# 2. ChromaDB vector store
sqlite3 "${SCRATCH}/Users/$(whoami)/.cortextos/cortextos1/orgs/clearworksai/knowledge-base/chromadb/chroma.sqlite3" \
  'PRAGMA integrity_check' | head -5
# Expected: "ok" (7 collections verified 2026-07-06)

# 3. crons.json JSON validity (all 15 agents)
for f in "${SCRATCH}/Users/$(whoami)/.cortextos/cortextos1/.cortextOS/state/agents"/*/crons.json; do
  python3 -c "import json,sys; json.load(open('${f}'))" && echo "OK: $f" || echo "FAIL: $f"
done

# 4. Task JSON spot-check (100 sample)
find "${SCRATCH}/Users/$(whoami)/.cortextos/cortextos1/orgs/clearworksai/tasks" \
  -name "*.json" | head -100 | while read f; do
  python3 -c "import json,sys; json.load(open('$f'))" || echo "FAIL: $f"
done
echo "task sample done"

# 5. ACTIVE_INSTANCE + larry mission present
cat "${SCRATCH}/Users/$(whoami)/.cortextos/state/ACTIVE_INSTANCE"
cat "${SCRATCH}/Users/$(whoami)/code/cortextos/orgs/clearworksai/agents/larry/state/current-mission.txt" 2>/dev/null || echo "(absent — may be clean state)"
```

---

## WARNING — in-place restore OVERWRITES, it does not merge

Extracting an archive over live data replaces every file in the archive with the snapshot version. Any tasks, bus messages, cron changes, or mission updates created **after** the snapshot timestamp are lost.

**Prefer Path A (scratch extract + selective copy)** when only one or a few files were clobbered. Use Path B (full in-place) only when the corruption is widespread and you need a known-good baseline.

---

## Related

- Backup script (canonical source): `scripts/fleet-hot-state-backup.sh`
- Operational cron entrypoint (kept in sync): `orgs/clearworksai/agents/larry/scripts/fleet-state-backup.sh`
- State map: `.agent/one-big-feature/fleet-hot-state-backup/00-state-map.md`
- Restore verification record: `.agent/one-big-feature/fleet-hot-state-backup/01-restore-verified.md`
