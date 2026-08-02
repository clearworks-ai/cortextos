# Deep pass: src/daemon/agent-manager.ts (fork vs upstream/main)

Analyzed: 2026-08-02 (M1 backfill). Upstream ref = `upstream/main` @ `dfedf9b`. Divergence: **+130 / -10 lines** (`git diff upstream/main -- src/daemon/agent-manager.ts`).

## D1. Locked `readEnabledAgentsMap` on the boot path — RW-9 SURFACE (CONFIRMED)

- **Introduced:** `df151e0` 2026-07-07 (#87 "unify task lock domain").
- **Where:** import (:19), `readInstanceEnableList()` (:162-168) → `enabled-agents-io.ts:173-177` → `withFileLockSync` (lock.ts:131-133: `Atomics.wait`-blocks up to 5s, then THROWS). Upstream: plain try/catch `JSON.parse(readFileSync)` — never blocks, never throws.
- **Mechanism:** `discoverAndStart` is awaited bare (index.ts:269); daemon `start().catch(...) → process.exit(1)` (index.ts:375). A contended lock at boot (any agent CLI holding the shared task-lock domain) = 5s block then whole-daemon fatal `.daemon-crashed`. Same throw path hits runtime `startAgent` via `resolveAgentOrg`.
- **Fix (Wave 4 / RW-9):** lock-free, non-throwing read on boot/start/exit paths (catch → `.bak` → `{}`); locking stays writer-only.

## D2. Phantom-registry reconcile: pid-only liveness + delete-without-kill — RW-3 (CONFIRMED, AMPLIFIER)

- **Introduced:** `d2375f5` 2026-07-05 (#72).
- **Where:** `isPidAlive` (:170-177 — returns TRUE on EPERM, and on recycled pids); `reconcileDeadRegistryEntry` (:185-205 — stops pollers, deletes the Map entry + cron scheduler, **never kills the process tree**); call sites :322 (inspectAgentOp start), :338/:343 (startAgent, called twice — redundant double-reconcile).
- **Mechanism:** the pid checked is the **pty-host** pid; host dead ≠ claude dead (grandchild reparents per RW-4). Every phantom reconcile green-lights a fresh spawn while the reparented claude keeps running → +1 permanent process per cycle (no reaper anywhere, RW-6). The EPERM/recycled false-alive branch is the 2026-08-01 muse wedge: start DEDUPED + hard-restart "not in registry".
- **Fix (Wave 3 / RW-3):** kill/reap the full tree before deleting; treat EPERM/recycled pids skeptically. REMOVABLE once RW-1 + RW-6 land.

## D3. `bootSelfHeal` retry pass — BAND-AID

- **Introduced:** `f82b827` 2026-07-04 (code confirmed; SHA attribution unverified).
- **Where:** call (:146), implementation (:214-255): after bulk start, any enabled agent missing from the registry gets one more `startAgent` attempt, errors logged not thrown.
- **Analysis:** additive-only and guarded; no instability of its own. Exists because bulk-boot starts fail silently (RW-5 wedge class). Retire when RW-5 timeout + true readiness land (Wave 6).

## D4. Crash-alert scoping + 10-min cooldown — NEUTRAL (keep)

- **Introduced:** `0c05d1b` (attribution unverified; code confirmed).
- **Where:** `daemonOwnsCrashAlerts` (:500-501 — daemon only alerts for codex-app-server/opencode; claude/hermes get hook-crash-alert coverage), `CRASH_ALERT_COOLDOWN_MS` 10min (:505), gates at :508/:519, `halted` exempt (fires for all runtimes).
- **Analysis:** pure Telegram dedup of the dual-emitter bug. Correct; keep.

## Shared-with-upstream

Everything else (discover loop, org resolution, poller/checker wiring, worker spawn, auto-remove at :1131-1138) is upstream-shaped; the RW-10 wedge is caused in agent-pty.ts's listener-strip order, not here.

**Verdict:** two CONFIRMED wound surfaces (RW-3, RW-9) + one band-aid (bootSelfHeal) + one keeper (alert scoping). Fix per Waves 3-4; no additional unrecorded wounds found.
