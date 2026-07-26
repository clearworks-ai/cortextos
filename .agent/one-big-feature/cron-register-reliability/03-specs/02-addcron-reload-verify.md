# Spec 02 — add-cron reload-and-verify + tick mtime self-heal (Scope B: FP1, FP2, self-heal)

## Problem
`add-cron` prints success unconditionally after a fire-and-forget IPC signal; the daemon
handler always replies success; the scheduler never re-reads crons.json. Full chain in
`01-research.md` and the auditmaster root-cause doc.

## Change 1 — Daemon: `reload-crons` returns the real result (`src/daemon/ipc-server.ts:722-733`)

Replace the handler body:
```ts
// BEFORE (729-730): result discarded, always success
this.agentManager.reloadCrons(agentToReload);
response = { success: true, data: `Crons reloaded for ${agentToReload}` };
```
with:
```ts
const ok = this.agentManager.reloadCrons(agentToReload);
if (!ok) {
  response = { success: false, code: 'AGENT_NOT_SCHEDULED',
               error: `Agent '${agentToReload}' is not scheduled in this daemon (stopped, unknown, or wrong instance)` };
} else {
  response = { success: true,
               data: { message: `Crons reloaded for ${agentToReload}`,
                       nextFireTimes: this.agentManager.getCronNextFireTimes(agentToReload) } };
}
```
- New accessor in `src/daemon/agent-manager.ts` (near `reloadCrons`, line 1278):
  `getCronNextFireTimes(agentName: string): Array<{name: string; nextFireAt: number}>`
  → `this.cronSchedulers.get(agentName)?.getNextFireTimes() ?? []`.
  `CronScheduler.getNextFireTimes()` already exists (`cron-scheduler.ts:~330`).
- Hermes agents: `reloadCrons` returns `true` with no scheduler (by design,
  `agent-manager.ts:1290-1295`) → `nextFireTimes` will be `[]`; include
  `data.runtime: 'hermes'` so the CLI can skip name-assertion for Hermes (see Change 2).
- DELETE the false comment at `ipc-server.ts:727-728`
  ("CronScheduler picks up the change on its next 30s tick").
- Thread the boolean at the other call sites `ipc-server.ts:799, 814, 828`
  (enable/disable/update paths): log a warning on `false`; response handling there may stay
  as-is if those commands get their verification from the same helper later.

## Change 2 — CLI: verify before claiming (`src/cli/bus.ts`)

`signalCronReload` (`bus.ts:3544-3549`): change signature to
`async function signalCronReload(agentName: string, instanceId: string): Promise<IPCResponse>`,
return `await ipc.send(...)`; keep a try/catch but return
`{success:false, error: String(err)}` instead of swallowing. DELETE the false comment at 3548.
(Note: `IPCClient.send` already RESOLVES `{success:false}` on ECONNREFUSED/ENOENT —
`ipc-server.ts:887-896` — so daemon-down flows through the same path.)

`add-cron` action tail (`bus.ts:3588-3596`): replace
```ts
await signalCronReload(agent, env.instanceId);
console.log(`Added cron '${name}' for ${agent}`);
```
with logic:
1. `const resp = await signalCronReload(agent, env.instanceId);`
2. Hermes short-circuit: `resp.success && resp.data?.runtime === 'hermes'` → print
   `Added cron '<name>' for <agent> (hermes-managed)` and exit 0.
3. Assert `resp.success === true` AND `resp.data.nextFireTimes` contains an entry with
   `entry.name === name` and `Number.isFinite(entry.nextFireAt)`.
4. Pass → `console.log(\`Added cron '${name}' for ${agent} — live in scheduler, next fire ${new Date(entry.nextFireAt).toISOString()}\`)`.
5. Fail → stderr:
   `Cron '<name>' written to crons.json but NOT live in the running scheduler (<reason: resp.error || 'name missing from live schedule'>). Daemon down, wrong instance, or agent not scheduled. Fix: cortextos bus reload-crons <agent> after starting the daemon, or restart the daemon.`
   → `process.exit(1)`. The file write is NOT rolled back — the state message says so.
6. Old-daemon compat: `resp.success` but `resp.data` is the legacy string → UNVERIFIED →
   same exit-1 path with reason `daemon predates reload-verify — restart the daemon`.

`remove-cron` (`bus.ts:3616`) and `update-cron` (`bus.ts:4005`): check `resp.success`; on
failure print the analogous written-but-not-live warning and exit 1. (Name-assertion inverts
for remove: name must be ABSENT from `nextFireTimes`.)

## Change 3 — Scheduler: tick() mtime self-heal (`src/daemon/cron-scheduler.ts`)

- In `loadCrons()` (line 341): after a successful `readCronsWithStatus`, record
  `this.lastLoadedMtimeMs` via `statSync` of the crons.json path (0 if missing).
- At the TOP of `tick()` (line 464): stat crons.json; if `mtimeMs > this.lastLoadedMtimeMs`,
  call `this.loadCrons(true)` before iterating. Wrap the stat in try/catch (missing file →
  skip). One stat per agent per 30s (`TICK_INTERVAL_MS = 30_000`, line 268).
- The existing reload-while-firing guard in `loadCrons` (lines ~386-395) already protects
  against double-fire during self-heal — do not duplicate it.
- Effect: any crons.json write reaches the live schedule ≤30s later even if the IPC signal is
  lost, making the (deleted) tick-comment claim true at last.

## Edge cases
- Daemon down: CLI exits 1, file written — Phase-4 self-heal picks it up when the daemon
  starts (start() → loadCrons anyway).
- Wrong instance (FP3): IPC ENOENT → success:false → exit 1 (loud). Spec 03 adds the
  pre-write guard.
- Agent in start-window gap: `reloadCrons` already lazy-wires the scheduler
  (`agent-manager.ts:1296-1301`, iter-7 fix) — verify assertion still passes there.
- Atomic rename-over writes: mtime check works (rejected fs.watch precisely because rename-over
  is unreliable on macOS — root-cause doc, "Rejected alternatives").
- Clock skew on mtime: compare with `>`, store exact mtimeMs from the stat, never `Date.now()`.

## Tests that prove it
- `tests/unit/daemon/` ipc handler: scheduled agent → success + name in nextFireTimes;
  unknown agent → `success:false` + `AGENT_NOT_SCHEDULED`; hermes → success + runtime tag.
- CLI integration (fake socket or spawned daemon fixture): add-cron exit 0 prints ISO
  next-fire; daemon-down → exit 1 AND crons.json contains the cron; name-missing response →
  exit 1.
- cron-scheduler unit (fake timers, temp CTX_ROOT): start scheduler → write new cron to
  crons.json directly (no reload call) → advance 30s → assert scheduled map contains it;
  assert exactly one extra loadCrons per mtime change (no reload loop).
- Comment-deletion check: grep test asserting the string "next 30s tick" no longer exists in
  `src/cli/bus.ts` or `src/daemon/ipc-server.ts`.
