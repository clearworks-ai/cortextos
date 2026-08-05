# _SYNTHESIS — Root-wound vs band-aid classification of all fork↔upstream daemon divergences

Synthesized 2026-08-01 from the 24 per-file deep reviews in this directory. Merge-base with upstream: `a15baad` (2026-07-20). All SHAs/dates re-verified against `git log` at synthesis time.

## The causal model (one paragraph)

Upstream is stable without any of the fork's supervision machinery. The fork's instability is a **compounding chain**: (1) a months-old commit (`f5d69e4`, 2026-06-08) planted TWO wounds — a fleet-HALTing session-id bug (excised 2026-06-25) and a **still-live rate-limit exit reclassifier that bypasses both crash circuit breakers**, converting transient failures into unbounded 60s-cadence respawn loops; (2) that respawn churn — plus context-handoff churn — multiplied PTY allocation far past upstream's rate, which (3) exhausted macOS ptmx fds (a real node-pty leak, but one upstream never hits at its allocation rate), which (4) motivated the fork-per-PTY pty-host band-aid (`4c3fe4f`/`28f6e91`, 2026-07-23/26) whose SIGKILL-vs-IPC kill race, timeout-less waitReady, and reaper-less design **traded the fd-leak class for an orphan-process class**; (5) meanwhile registry band-aids (`d2375f5` phantom reconcile) authorize respawning on top of live orphans, and a dual instance-resolver split-brain (`b5daa2a`) makes CLI/daemon/bus disagree about which state tree is truth. Orphans + spawn storms → host resource exhaustion → posix_spawnp refusal → overnight fleet death → watchdogs fire more → more churn. Every band-aid layer is dated evidence of, and in three cases an amplifier of, this loop.

**Not fork wounds (upstream-shared, do NOT "fix" as fork drift):** early `status='running'` at PTY allocation (agent-process.ts:294 == upstream:183, and pty-host-entry.ts:58 faithfully relays the same semantics); the 30s "Bootstrap timeout — proceeding anyway" (fast-checker.ts:445, upstream `1b3336b` 2026-04-06); env.ts:51-55 agentName cwd-fallback (byte-identical upstream). These are latent upstream weaknesses that only become lethal in combination with the fork's churn — fixing them is optional hardening, not wound excision. fast-checker.ts itself is now **byte-identical to upstream** (fork band-aids stripped by re-baseline `9a33532` 2026-07-28).

---

## RANKED ROOT-CAUSE-INSTABILITY divergences (band-aids excluded)

### RW-1. RATE_LIMIT exit reclassification defeats both crash circuit breakers — `f5d69e4`, 2026-06-08 ★ the months-old wound
- **Where:** src/daemon/agent-process.ts:613-628 (`detectRateLimitCrash` — 16KB stdout-tail substring match), :765-779 (handleExit early-return BEFORE CrashLoopPauser and daily crashCount/HALT), :295-296 (`rateLimitCount = 0` reset at PTY-allocation 'running', not REPL readiness).
- **Mechanism:** any exit whose stdout tail contains prose like `usage limit` / `quota exceeded` / `too many requests` is reclassified RATE_LIMIT → uncharged, un-HALTable respawn. Counter resets every spawn that reaches (falsely early) 'running' → backoff pinned at 60s forever → ~1440 uncounted respawns/day/agent under sustained depletion, synchronized fleet-wide (spawn storm at the exact moment the API can't recover them). False-positive class PROVEN in production once already (`e86afbc` 2026-06-28 had to remove bare `rate limit` patterns after TUI session titles tripped it). Each respawn = fresh pty-host = a roll of the orphan dice (RW-4). This is the oldest live instability hunk in the fork and matches Josh's "months and months ago" window exactly.
- **Upstream:** every crash charges the crash window; HALT applies. Stable.
- **Fix: REVERT-TO-UPSTREAM** (rate-limit exits charge the breaker like any crash), or minimally KEEP-BUT-FIX: key on exit signatures not prose, reset counter only at proven REPL readiness, cap RATE_LIMIT respawns/day. Excision test: if overnight deaths stop tracking Anthropic-depletion windows, this is confirmed as the daemon-side root wound.

### RW-2. Instance-resolution split-brain: CLI honors marker, daemon/bus/env never do — `b5daa2a`, 2026-07-03 (lineage `9571967`, 2026-06-10)
- **Where:** src/utils/resolve-active-instance.ts (whole file, fork-only) + src/cli/resolve-instance-id.ts:17 (CLI chain: `--instance` → `CTX_INSTANCE_ID` → `~/.cortextos/state/ACTIVE_INSTANCE` marker → 'default') vs src/utils/env.ts:33-37 (daemon/bus/hooks chain: overrides → `CTX_INSTANCE_ID` → .env → 'default' — **never reads the marker**). Live marker on this host = `cortextos1`.
- **Mechanism:** two resolvers disagree → CLI ops (status/stop/restart/bus) target a different `~/.cortextos/<instance>/` tree (crons.json, registry, sockets, heartbeats) than the live daemon writes. Silent fail-open fallback makes the split intermittent/unreproducible. Plausible mechanism for the confirmed 2026-08-01 registry-desync / "not in registry" hard-restart failures and "status running ≠ functioning" reads. The fork admits it: bus.ts:177-188 `warnOnInstanceMismatch()` (FP3) + `TODO(instance-unification)` — a warn-only band-aid over this wound.
- **Upstream:** no marker system; single identity scheme.
- **Fix: KEEP-BUT-FIX** — one shared resolver across CLI + daemon + agent env (finish the fork's own TODO), or delete the marker system (REVERT) and pin CTX_INSTANCE_ID everywhere.

### RW-3. Phantom-registry reconcile: pid-only liveness + delete-without-kill → respawn over live orphans; EPERM/pid-recycle false-alive → wedged registry — `d2375f5`, 2026-07-05
- **Where:** src/daemon/agent-manager.ts:170-178 (`isPidAlive` — true on EPERM/recycled pid), :185-207 (`reconcileDeadRegistryEntry` — stops pollers, deletes registry entry, NEVER calls `entry.process.stop()` or kills the tree), call sites :322, :338-344.
- **Mechanism:** the pid checked is the **pty-host** pid; "pty-host dead" ≠ "claude dead" (grandchild reparents, RW-4). Every phantom reconcile green-lights a fresh spawn while the reparented claude keeps running — +1 permanent process per cycle, no reaper anywhere in src/daemon → the confirmed accumulation → posix_spawnp-refusal fleet death. The false-alive branch (EPERM/pid recycle) keeps phantoms wedged: start returns DEDUPED, hard-restart fails "not in registry" — the exact 2026-08-01 muse incident shape.
- **Upstream:** no phantom reconciler; doesn't need one (fewer unnoticed exits).
- **Fix: KEEP-BUT-FIX** — reconcile must kill/reap the full process tree (pty-host + descendants) before deleting the entry, and treat EPERM/recycled pids skeptically. Becomes fully REMOVABLE once RW-1 (churn source) and RW-4 (reaper) are fixed.

### RW-4. pty-host kill path: async `pty-kill` IPC + immediate SIGKILL race orphans the claude grandchild — `4c3fe4f` 2026-07-23, weaponized by `28f6e91` 2026-07-26 (destroy semantics seeded by `8301f21` 2026-07-20)
- **Where:** src/pty/agent-pty.ts:356-365 (`kill()`: `pty.kill()` = async `child.send({type:'pty-kill'})`, then `pty.destroy?.()` = synchronous SIGKILL); src/pty/pty-host-client.ts:167-170 (`destroy()` = `this._child.kill('SIGKILL')`); src/pty/pty-host-entry.ts:91-96 (pty-kill handler has no self-exit fallback/timeout); src/pty/pty-ipc.ts (protocol defines NO graceful host-shutdown message — SIGKILL is the only teardown).
- **Mechanism:** SIGKILL lands before the child dequeues the IPC message → no handler runs → claude grandchild never signaled → reparents to launchd, holds pty slave/memory for days (confirmed alloc 61-65). EVERY daemon-initiated teardown (watchdog force-restart, handoff restart, hard-restart, worker reap) goes through this path — the fork's restart-happy band-aids mint orphans at their firing rate. Plus: pty-host-entry's destroy-right-after-kill can suppress its own onExit → host idles forever holding its allocation.
- **Upstream:** in-process node-pty; kill is direct and race-free. (The pty-host architecture itself STAYS — the ptmx native leak is proven, per fleet memory — but its kill protocol is the wound.)
- **Fix: KEEP-BUT-FIX** — add a graceful `pty-dispose` protocol message; client sends pty-kill, awaits pty-exit with a 2-5s deadline, only then SIGKILLs; entry arms `setTimeout(() => process.exit(0), 5000).unref()` after signaling; give pty-host-entry a SIGTERM handler that kills its node-pty child.

### RW-5. `hostSpawn()` await-forever: `waitReady()` has no timeout and is never rejected on child exit — `4c3fe4f` 2026-07-23 (live from `28f6e91` 2026-07-26)
- **Where:** src/pty/pty-host-client.ts:73-94 (`_ready` settled only by pty-ready / pty-error / fork `error`; `child.on('exit')` at :81-90 fires exit listeners but never rejects `_ready`), :215 (`await proxy.waitReady()` — no timeout); bare `await this.spawnFn!(...)` at agent-pty.ts:147.
- **Mechanism:** child dies pre-ready (OOM-kill, module-load failure, posix_spawnp refusal inside the host — exactly the confirmed overnight regime) → the agent's spawn path wedges forever, silently, pinning proxy + ChildProcess in memory. Converts "spawn failed, retry" into "spawn wedged permanently" — the alive-but-loop-dead shape, upstream of fast-checker's proceed-anyway hole. Same class in codex path (RW-7).
- **Upstream:** synchronous in-process spawn; failure throws immediately.
- **Fix: KEEP-BUT-FIX** — reject `_ready` on child `exit`; add a spawn deadline to `waitReady()`; pty-host-entry exits(1) if no `pty-spawn` arrives within ~15s.

### RW-6. No pty-host PID registry / no reaper anywhere — `4c3fe4f`, 2026-07-23
- **Where:** src/pty/pty-host-client.ts:193-217 (`hostSpawn` forks; only handle is the returned proxy; no pidfile, no daemon-side set); confirmed zero reaper in src/daemon.
- **Mechanism:** any abandoned proxy (RW-5 hang, restart churn dropping references, registry desync per RW-2/RW-3) leaves host + claude grandchild unfindable and unreapable. The missing containment that lets RW-3/RW-4 failures become *permanent* population growth.
- **Fix: KEEP-BUT-FIX** — durable pty-host PID ledger + periodic reaper (kill process group of any host not owned by a live registry entry).

### RW-7. Codex kill-during-spawn race: async hostSpawn window where `kill()` has nothing to kill — `28f6e91`, 2026-07-26
- **Where:** src/pty/codex-app-server-pty.ts:417-456 (`startAppServer` wraps hostSpawn in `.then((pty) => ...)`; `this._appServerPty` null until continuation; `kill()`/`cleanupSpawnAttempt()` in that window is a no-op; the pending spawn then resolves and assigns a live pty to a dead adapter — never killed).
- **Mechanism:** every daemon/watchdog restart that lands mid-codex-spawn leaks a pty-host + codex app-server pair permanently. Upstream's synchronous spawn has zero such window.
- **Fix: KEEP-BUT-FIX** — re-check `this._alive` inside the continuation; if dead, kill+destroy immediately instead of assigning; plus RW-5's ready-rejection fix.

### RW-8. ReconcileTrigger: `Atomics.wait` file-locks + sync fs sweeps ON the daemon event loop, and dryRun:false task reclaim keyed off known-wrong liveness — `e1d45f7` 2026-07-03; risk hunks `f516311` + `f7879aa` 2026-07-12
- **Where:** src/daemon/reconcile-trigger.ts:267-319 (all-sync pass every 15min); task.ts:262-263/:383-384 (`withFileLockSync` → `Atomics.wait` TRUE thread-block up to 5s each, twice per pass, on a lock contended by every agent CLI fleet-wide); reconcile-trigger.ts:332-362 (orphan reclaim: `status==='running'` treated as live — wrong both ways: loop-dead agents count live, registry-desynced live agents get ALL tasks yanked every 15min).
- **Mechanism:** periodic daemon main-thread freezes (PTY backpressure, IPC timeouts, stalled heartbeats — indistinguishable from loop-death while they last) + silent task-ownership churn off a stale signal. index.ts:274 comment still claims "READ-ONLY — never mutates" — false since 2026-07-12.
- **Upstream:** module doesn't exist.
- **Fix: REVERT-TO-UPSTREAM (drop the module)** or KEEP-BUT-FIX: move passes to a spawned worker, never mutate ownership from daemon-internal liveness alone, fix the false comment.

### RW-9. Locked read of enabled-agents.json on the boot/startAgent critical path: "never throws" is false; throw escalates to whole-daemon fatal — `df151e0`, 2026-07-07
- **Where:** src/daemon/agent-manager.ts:162-168 (`readInstanceEnableList` → `readEnabledAgentsMap`, enabled-agents-io.ts:173-178, no catch) → `withFileLockSync` (lock.ts:113-133) THROWS after 5s if a live process holds the config lock, and `Atomics.wait`-blocks the daemon thread while waiting. `discoverAndStart` awaited bare at index.ts:269 → lock-timeout at boot = `.daemon-crashed`, fleet daemon dead. Same throw makes any runtime `startAgent` (incl. supervision restarts) fail via `resolveAgentOrg` (:274/:377).
- **Upstream:** plain try/catch `JSON.parse(readFileSync)` — can never throw, never block.
- **Fix: KEEP-BUT-FIX** — non-throwing, non-blocking read on the boot/start path (catch → `.bak` → `{}`); keep the locked read only for writers.

### RW-10. Worker 10-min reaper: self-reap permanently wedges the worker registry + rolls the orphan dice — `fb4ec92`, 2026-06-23
- **Where:** src/daemon/worker-process.ts:19/:78-84 (10-min `void this.terminate()`); AgentPTY.kill() disposes listeners BEFORE killing (agent-pty.ts:359-361) → `onDoneCallback` never runs → agent-manager's 30s auto-remove never scheduled → Map entry lives until daemon restart → `spawnWorker` throws "already running" forever for that name (agent-manager.ts:1107-1108); every reaper fire traverses the RW-4 SIGKILL race; hung force-killed workers report `status='completed'`.
- **Mechanism:** fixed-name workers (comms-check-worker fuse spawns) silently blocked after one reap — a silent-comms-stall mechanism; each fire can mint an orphan.
- **Upstream:** no lifetime cap ("workers run until task is complete") — and upstream workers don't hang.
- **Fix: KEEP-BUT-FIX** — self-reap must delete from the workers Map and report a distinct 'reaped' status; route termination through a graceful-then-escalate kill (RW-4 fix).

**Historical root wound, already excised (context for RW-1's lineage):** `f5d69e4` 2026-06-08 also shipped the fixed `--session-id` (src/utils/agent-session-isolation.ts) → "Session ID already in use" → fleet-wide HALT loop, reverted `7285fb0` 2026-06-25. The module is now dead code (zero src imports) — delete it + its test to remove the re-wiring temptation. The rate-limit half of that same commit (RW-1) was never reverted.

**Amplifier worth noting (classified NEUTRAL-with-hazard, not ranked):** `96f1c91` 2026-07-23 op:// resolution — synchronous `execFileSync('op')` up to 10s+ per env load on the daemon main thread during every spawn, failures never cached, and on op failure agents boot "successfully" with literal `op://...` strings as secrets (silent Telegram-401 stall class). Fix: async resolution off-thread, cache failures, loud degraded-boot marker.

---

## BAND-AIDS and the wound each compensates for (removability map)

| Band-aid | SHA / date | Where | Compensates for | Removable when |
|---|---|---|---|---|
| ReconcileTrigger drift alarms + sweeps | e1d45f7 2026-07-03 (+f516311/f7879aa 07-12, 828811c 07-18) | index.ts:271-282, reconcile-trigger.ts | fleet dying/drifting (RW-1 churn, RW-3/RW-4 orphans) | RW-1 + RW-4 fixed (or fix per RW-8 if kept) |
| bootSelfHeal retry of missing agents | f82b827 2026-07-04 | agent-manager.ts:210-255 | silent bulk-boot start failures (early-running/exhaustion) | RW-5 timeout + true readiness land |
| Phantom-registry reconcile | d2375f5 2026-07-05 | agent-manager.ts:170-207 | unnoticed exits/phantoms — but AMPLIFIES the wound (see RW-3) | true readiness + reaper (RW-6) land |
| Locked enabled-agents read | df151e0 2026-07-07 | agent-manager.ts:162-168 | boot/CLI write race on enabled-agents.json — carries its own edge (RW-9) | writer-side locking retained; reader reverted |
| Handoff back-ping dedup (3 commits) | 6b7fb16 07-11, 9ecaebc 07-15, 078a9a3 07-16 | handoff-backping.ts + agent-process.ts:915-985 | Telegram spam from restart/handoff churn (RW-1) | churn rate returns to upstream levels |
| Mission anchor + verbatim live-tail resume | dd8992c 06-29, 904aaee 07-26, 455d8bc evil-merge 07-31 | agent-process.ts:1001-1076, restart-context.ts, conversation-buffer.ts | context destroyed by crash/handoff restarts (RW-1 churn). 455d8bc staleness-refresh additionally risks resurrecting stale instructions (known "anchor = stale retrieval" class) | churn fixed; at minimum revert the un-audited 455d8bc hunk |
| isDisabled resurrection gate | 6abfe16 2026-08-01 | agent-process.ts:653-671, :703-710 | the fork's own uncharged respawn paths (RW-1 rate-limit, image-poison timer) resurrecting disabled agents | RW-1 reverted (keep meanwhile — it's correct) |
| Worker 10-min reaper | fb4ec92 2026-06-23 | worker-process.ts:19-84 | fork workers hanging (PTY layer wedges) — itself creates RW-10 | RW-4/RW-5 fixed |
| `.is-worker` crash-page suppression marker | e86afbc 2026-06-28 | worker-process.ts:55-58 | false crash pages from the fork's crash-alert hook | keep (benign) or delete with hook |
| Source-event dedup ledger | 23a5aff 07-03, daedce7 07-17 | event-dedup.ts | comms-check workers re-firing/rewording the same event | comms worker re-fire fixed at source |
| `probeAvailability` 3-state daemon probe | 9571967 2026-06-10 | ipc-server.ts:942-959 | daemon socket timeouts under load (event-loop starvation: RW-8/RW-9/op://) — dated proof the wound predates 06-10 | keep (cheap fail-safe) |
| reload-crons AGENT_NOT_SCHEDULED surfacing | 9f6b501 2026-07-25 | ipc-server.ts:745-755 | silent cron-reload failures | keep — harmless, upstreamable |
| buildSubprocessCtxEnv | 3d28b01 2026-07-26 | env.ts:185-212 | fork watchdog children crashing on the #313 sandbox guard | delete if heartbeat machinery stays upstream-stripped |
| warnOnInstanceMismatch (FP3) | later | bus.ts:177-188 | RW-2 split-brain (warn-only) | RW-2 unified resolver lands |
| Atomic-restart + liveness verify (HISTORICAL — already removed) | 12ebcfe 07-18, removed 9a33532 07-28 | cli/restart.ts | restart "success" on ACK while status lies (upstream-shared early-running) | already gone; readiness truthfulness makes it unneeded |
| pty-host architecture itself | 4c3fe4f/28f6e91 07-23/26 | src/pty/* | proven node-pty native ptmx leak — STAYS per fleet decision, but only *needed* at fork churn rates | keep; fix RW-4/5/6/7 inside it |
| Crash-alert scoping + cooldown | 0c05d1b 2026-07-26 | agent-manager.ts:488-522 | double Telegram alerts | keep (NEUTRAL) |

**Exonerated files (no live instability divergence):** fast-checker.ts (byte-identical upstream post-rebaseline), index.ts (wiring only), inject.ts (dead `remove()` — note the re-baseline seam: #69's dedup-rollback caller was silently dropped, partially re-opening silent retry drops), telegram-streamer.ts, conversation-buffer.ts (hygiene bugs only), handoff-backping.ts, instance.ts, resolve-instance-id.ts, restart.ts, event-dedup.ts, agent-session-isolation.ts (dead — delete).

## Recommended excision order

1. **RW-1 revert** (rate-limit breaker bypass) — cheapest, oldest, highest-leverage; test against depletion windows.
2. **RW-4 + RW-5 + RW-6** as one pty-host teardown/readiness/reaper patch (keeps the ptmx fix, closes the orphan factory) — includes RW-7.
3. **RW-3 fix** (reconcile kills tree before delete) + **RW-2 resolver unification**.
4. **RW-9** non-throwing enabled-agents read; **RW-8** drop or offload ReconcileTrigger; **RW-10** worker-map fix.
5. Then retire band-aids per the removability map as churn subsides — each retired band-aid is a regression test that the wound is actually healed.
