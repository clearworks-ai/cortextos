# Rebaseline Migration Manifest — cortextOS fork onto upstream/main

**Date:** 2026-07-28
**Fork:** clearworks-ai/cortextos `main` @ `ab00870`
**Upstream:** grandamenium/cortextos `upstream/main` @ `a15baad`
**Divergence:** 463 ahead / 247 behind. `git diff --stat upstream/main main` = **685 files, +97,491 / −3,439**.
**Goal:** Re-baseline the daemon onto upstream/main (stable), re-applying only genuine product code. Discard hand-rolled instability adds that upstream has since fixed.

> READ-ONLY analysis. Evidence is git-cited. Mutable-state claims (what's "live") are hypotheses to verify on staging before cutover.

---

## 1. Divergence map by directory

Aggregated from `git diff --numstat upstream/main main`:

| Area | Files | +Lines | −Lines | What diverged |
|---|---|---|---|---|
| `.agent/` | 218 | 24,244 | 0 | OBF/M2C1 planning artifacts (research/specs/plans). Not runtime. |
| `tests/` | 120 | 23,429 | 222 | Fork-added unit/integration/E2E for pipeline, kb-graph, workflows, pty-leak. |
| `ROOT/other` | 57 | 10,567 | 62 | package.json, tsup/vitest config, scripts, docs, gate shell hooks. |
| `dashboard/` | 73 | 5,116 | 709 | Next.js dashboard extensions (agent views, pipeline UI). |
| `src/bus` | 24 | 5,148 | 263 | kb-graph engine, activity-ledger, reconcile, reliable-job, scope-guard. |
| `src/pipeline` | 16 | 5,228 | 0 | **Entirely fork-only** — build-gate, ledger, staging-verify subsystem. |
| `knowledge-base` | 13 | 4,863 | 181 | KB content + graph seed. |
| `community/` | 41 | 4,805 | 193 | Community skills/agent catalog additions. |
| `src/cli` | 19 | 3,985 | 244 | CLI extensions (instance resolve, webhook-bridge, bus-reconcile). |
| `src/daemon` | 14 | 2,905 | 207 | **CRITICAL** — fast-checker stall watchdog, cron-liveness, reconcile-trigger, telegram-streamer, conversation-buffer, restart-context. |
| `src/other` (utils/types) | 19 | 2,811 | 99 | claim-detector, memory-lint, cron-prompt-validator, session-isolation, gates. |
| `templates/` | 33 | 1,548 | 967 | Agent/orchestrator/analyst template rewrites. |
| `src/hooks` | 12 | 1,377 | 91 | retrieval-enforcer, tool-result-router, system-pings, session-context. |
| `src/pty` | 7 | 662 | 172 | **CRITICAL** — pty-host out-of-process refactor (#132) + adapter rewires. |
| `state/` | 16 | 511 | 0 | Runtime state files (ledger, pipeline-run, crons). Do NOT port. |
| `src/telegram` | 3 | 292 | 29 | dedup module + api.ts streaming/dedup wiring + logging. |

---

## 2. Fork-only files under `src/` (in `main`, absent in `upstream/main`)

Lifecycle/restart/spawn-related flagged **⚠️LIFECYCLE**.

**src/daemon/** (all critical surface)
- `conversation-buffer.ts` — rolling Josh↔agent buffer across restarts. ⚠️LIFECYCLE (product-ish)
- `cron-liveness.ts` — overdue-cron detector feeding FastChecker restart escalation. ⚠️LIFECYCLE
- `handoff-backping.ts` — suppression window for handoff back-ping re-fires. ⚠️LIFECYCLE
- `reconcile-trigger.ts` — daemon auto-trigger for fleet reconcile (WS4). ⚠️LIFECYCLE
- `restart-context.ts` — mission-anchor/handoff recovery from buffer on restart. ⚠️LIFECYCLE
- `telegram-streamer.ts` — incremental Telegram message streaming.

**src/pty/**
- `pty-host-client.ts` — daemon-side proxy that forks pty-host-entry. ⚠️LIFECYCLE/SPAWN
- `pty-host-entry.ts` — short-lived child holding one node-pty allocation. ⚠️LIFECYCLE/SPAWN
- `pty-ipc.ts` — message types for pty-host IPC.

**src/telegram/**
- `dedup.ts` — Telegram message dedup.

**src/pipeline/** (entirely fork-only product)
- `build-gate.ts`, `bypass-audit.ts`, `ledger.ts`, `pr-target.ts`, `stage-emit.ts` + `staging-verify/*` (12 files: cli, deploy, drive, emit, evidence, railway, repos, runner, state-read, types, verify).

**src/bus/**
- `activity-ledger.ts`, `enabled-agents-io.ts`, `experiment-sweep.ts`, `meeting-brief.ts`, `reconcile.ts`, `reliable-job.ts`, `scope-guard.ts`, `kb-graph/*` (11 files: db, dream, extract, frontmatter, index, link-extraction, relational, resolve).

**src/cli/**
- `bus-activity-ledger.ts`, `bus-reconcile.ts`, `instance.ts`, `resolve-instance-id.ts`, `webhook-bridge.ts`.

**src/hooks/**
- `hook-retrieval-enforcer.ts`, `hook-tool-result-router.ts`, `lib/session-context.ts`, `system-pings.ts`.

**src/utils/**
- `agent-session-isolation.ts` ⚠️LIFECYCLE, `ci-alert-gate.ts`, `claim-classifier.ts`, `claim-detector.ts`, `cron-prompt-validator.ts`, `event-dedup.ts`, `meeting-alert-gate.ts`, `memory-correctness.ts`, `memory-lint.ts`, `resolve-active-instance.ts`, `scope-guard.ts`, `verification-receipt.ts`.

---

## 3. Upstream-only gains — themes of the 247 commits we lack

`git log --oneline main..upstream/main` prefix counts:

| Theme | Count | Theme | Count |
|---|---|---|---|
| fix(daemon) | 40 | fix(hooks) | 5 |
| feat(crons) | 27 | feat(telegram) | 5 |
| fix(dashboard) | 10 | fix(security) | 4 |
| feat(daemon) | 10 | fix(pty) | 4 |
| fix(cli) | 9 | fix(ctx-watchdog) | 3 |
| fix(cron) | 8 | fix(fast-checker) | 2 |
| fix(bus) | 7 | feat(pty) | 2 |
| fix(telegram) | 6 | feat(security) | 2 |

**The ~15 most stability-relevant commits (daemon/pty/telegram):**

1. `593e0c0` fix(daemon): kill false-positive crash detection — no-unlink markers + first-heartbeat clear (**#445/#550**) — directly kills the fork's restart-churn class.
2. `ee21f17` fix(daemon): audit silent-failure class — BOM, PATH-unaware execFile, supervision gaps (**#459/#556**) — PATH/supervision hardening.
3. `c7dffe7` fix(daemon): retry Telegram command registration so restarts don't drop the slash menu (**#668**) — fixes orphaned/dropped Telegram command class.
4. `99158f8` feat(daemon): context-handoff mechanism — default-on at 60% model window (**#685**).
5. `b15ca01` feat(daemon): context-handoff lifecycle + native opencode adapter (**#699**).
6. `381aa49` fix(daemon): image-poison crash auto-recovery (#446/#552).
7. `de521d1` / `59913b5` / `dfc5556` guard worker PTY null-write + crash visibility, pre-arm .force-fresh to break --continue loop (#223/#196/#194).
8. `2458a61`/`8301f21` fix(daemon): close leaked ptmx fd on PTY exit/kill + spawn-failure recovery (**#112**) — upstream's *own* ptmx attempt (see §5).
9. `788a9e6` fix(pty): rotate stdout.log at 50 MB to prevent file-cache pressure (#175).
10. `2faa961` fix(fast-checker): inject unhandled callbacks with PTY-injection sanitization (#604).
11. `20583d3` fix(daemon): sanitize PTY injection — dynamic-fence + forged-header (#592).
12. `164742e` fix(bus): hard-restart sends IPC restart-agent to terminate session (#217).
13. `f03de88` / `da76631` thread --model through spawn-worker; AgentConfig.crash_window CrashLoopPauser (#283/#153/#377).
14. `525ba48` feat(pty): CodexPTY adapter — exec-mode Codex CLI runtime (#322); `66a9a7a` telegram_polling flag to suppress poller on specialists (#297).
15. `5a0882d`/`8267bab` security leak-guard CI + pre-push hook (SEC-1) (#704/#698).

---

## 4. Subsystem classification — the bucket table (centerpiece)

**Buckets:** **A** = KEEP-FORK-RE-PORT (genuine product, re-apply on upstream base) · **B** = TAKE-UPSTREAM (fork hand-rolled; upstream now does it better) · **C** = DROP (pure instability add, no upstream equivalent, no product value).

### Coarse subsystems

| Subsystem | Bucket | Justification |
|---|---|---|
| `src/pipeline/` (+ staging-verify) | **A** | Entirely fork-only product (+5,228/−0). No upstream equivalent. Re-apply verbatim on upstream base. |
| `src/bus/kb-graph/` + bus product extensions | **A** | Knowledge-graph engine, activity-ledger, reliable-job, reconcile — product, no upstream analog. |
| `dashboard/` extensions | **A** | Product UI. Re-port on top of upstream's 10× fix(dashboard) + 4× feat(dashboard). |
| `community/`, `templates/`, `knowledge-base/` | **A** | Product content/catalog. Merge-favor-fork but rebase onto upstream template rewrites. |
| `src/hooks/` (retrieval-enforcer, tool-result-router, system-pings) | **A** | Fork product hooks. Re-apply; reconcile with upstream's 5 fix(hooks). |
| `src/cli/` extensions | **A** | instance/webhook-bridge/bus-reconcile are product. Rebase onto upstream 9 fix(cli)+2 feat(cli). |
| `src/utils/` gates (claim-detector, memory-lint, cron-prompt-validator, verification-receipt, dedup) | **A** | Fork correctness/gate product. Re-port. |
| `.agent/`, `state/` | **DROP-from-port** | Planning artifacts + runtime state. Never ported into a rebaseline; regenerated at runtime. |
| Context-handoff (fork's ctx-watchdog/handoff bits) | **B** | Upstream #685/#699 (default-on at 60% window + lifecycle) supersedes fork's hand-rolled handoff. Adopt upstream's. |
| opencode/codex runtime | **B** | Upstream ships `opencode-pty.ts`, `codex-app-server-pty.ts`, `hermes-pty.ts`, `opencode-context-reporter.ts`, CodexPTY (#322), native opencode adapter (#699). Take upstream's; drop fork's ad-hoc rewires. |
| Telegram command registration | **B** | Upstream #668 (retry registration on restart) fixes the orphaned-poller/dropped-menu class the fork worked around. Adopt upstream. |

### File-by-file: `src/daemon` (critical surface)

| File | Bucket | Justification |
|---|---|---|
| `agent-manager.ts` (+283/−43) | **B** | Take upstream base (40 fix(daemon)); re-apply only genuine product deltas atop it. |
| `agent-process.ts` (+752/−61) | **B** | Upstream has #445/#550 (false-positive crash kill), #459/#556 (supervision), image-poison recovery. Rebase fork product onto upstream, do not carry fork's crash-detection edits. |
| `fast-checker.ts` (+519/−37) | **B (core) + C (stall watchdog)** | Take upstream #445/#550/#604 base. **DROP** the fork-added `stall*` watchdog fields (stallCircuitRestarts, stallCircuitBrokenAt, stallLastProgressSignalAt…) and the `evaluateCronLiveness` escalation import — these are the redundant restart triggers behind churn. |
| `cron-scheduler.ts` (+93/−20), `cron-migration.ts` (+29/−5) | **B** | Upstream 27 feat(crons)+8 fix(cron) with double-fire/reload fixes. Take upstream. |
| `ipc-server.ts` (+69/−40) | **B** | Upstream #349 IPC DEDUPED/NOT_FOUND/NOT_RUNNING semantics. Take upstream. |
| `index.ts` (+18), `worker-process.ts` (+24/−1) | **B** | Small deltas; take upstream, re-wire product entry points only. |
| `conversation-buffer.ts` (fork-only) | **A** | Genuine product (buffer for Josh↔agent recall). Re-port — but decouple from restart escalation. |
| `restart-context.ts` (fork-only) | **A→reconcile** | Mission-anchor/handoff recovery. Overlaps upstream #685/#699 context-handoff → **prefer upstream handoff**, keep only the fork's buffer-recovery glue if still needed. |
| `telegram-streamer.ts` (fork-only) | **A** | Incremental streaming = product UX. Re-port on upstream telegram base. |
| `handoff-backping.ts` (fork-only) | **C** | Back-ping suppression exists only because the fork's handoff dupes. Upstream handoff (#685/#699) makes it moot. Drop. |
| `reconcile-trigger.ts` (fork-only) | **A** | Fleet-reconcile auto-trigger = product. Re-port. |
| `cron-liveness.ts` (fork-only) | **C** | Feeds FastChecker cron-liveness restart escalation — a redundant restart trigger. Upstream cron double-fire/reload fixes cover the real bug. Drop the escalation; keep at most a passive overdue metric if wanted. |

### File-by-file: `src/pty` (critical surface)

| File | Bucket | Justification |
|---|---|---|
| `agent-pty.ts` (+79/−81) | **B base + A rewire** | Take upstream base; re-apply only the pty-host client wiring (see §5). |
| `codex-app-server-pty.ts` (+125/−55) | **B** | Upstream owns codex runtime (#322/#437/#699). Take upstream; re-apply pty-host wiring only. |
| `opencode-pty.ts` (+40/−35), `inject.ts` (+13/−1) | **B** | Upstream owns opencode + PTY-injection sanitization (#592/#596/#604). Take upstream. |
| `pty-host-client.ts` / `pty-host-entry.ts` / `pty-ipc.ts` (fork-only) | **A (keep+harden)** | The out-of-process ptmx-leak fix (#132). Upstream has no equivalent at tip. **KEEP.** See §5. |

### File-by-file: `src/telegram` (critical surface)

| File | Bucket | Justification |
|---|---|---|
| `api.ts` (+145/−16) | **B base + A** | Take upstream telegram base (#668 registration, #402/#181 parse-mode, #467 multi-user). Re-apply fork streaming/dedup wiring. |
| `dedup.ts` (fork-only) | **A** | Genuine dedup product (documented incident: backping dupe two-emitter root cause). Re-port — but the *handoff* dupe source goes away under upstream, so scope dedup to true bus-fanout dupes only. |
| `logging.ts` (+43/−13) | **B** | Take upstream. |

---

## 5. pty-host special question — verdict

**Question:** Does dropping the fork's out-of-process pty-host (`pty-host-{client,entry}.ts`, `pty-ipc.ts`, added by #132) reintroduce the /dev/ptmx leak?

**Evidence:**
- Both fork and upstream pin `node-pty ^1.1.0` (identical). The leak is a property of that node-pty version: `~2 ptmx/spawn`, exhausting `kern.tty.ptmx_max=511` → `posix_spawnp` crash loop.
- Fork #132 mitigates by hosting each node-pty allocation in a **short-lived forked child** (`pty-host-entry.ts` header: "On pty exit it sends PtyExitMsg then calls process.exit(0) so the kernel reclaims all /dev/ptmx fds held by this process"). The daemon itself holds **zero** ptmx fds (`pty-host-client.ts` header).
- **Upstream at tip has NO in-process ptmx reclaim.** `git grep 'ptmx|reclaim|masterFd|/dev/pt' upstream/main -- src/pty src/daemon` returns nothing relevant (the one `closeSync(fd)` hit at `agent-process.ts:464` is a stdout-log tail read, not a pty fd).
- Upstream's `agent-pty.ts` cleanup path only calls `pty.kill()` and disposes onData/onExit handlers (lines 165–169, 351, 374). `node-pty` `.kill()` sends a signal to the child but does **not** promptly close the master ptmx fd held by the daemon process — that is exactly the fd that accumulates.
- Upstream *did* attempt an in-process fix earlier (`8301f21`/`2458a61` "close leaked ptmx fd on PTY exit/kill", #112) — but that code is **not present at `upstream/main` tip** for the leaking path, i.e. the direct-spawn model remains.

**Verdict: KEEP + HARDEN the pty-host. Do NOT drop it.**
Dropping pty-host and reverting to upstream's direct `node-pty` spawn **reintroduces the ptmx leak** on macOS, since upstream has no equivalent mitigation at tip and pins the same node-pty. The pty-host is the *one* fork lifecycle add that is genuinely load-bearing product-infrastructure, not instability cruft. Re-port it as a Bucket-A component: keep `pty-host-{client,entry}.ts` + `pty-ipc.ts` verbatim, and re-apply the thin wiring in upstream's `agent-pty.ts` / `codex-app-server-pty.ts` so allocations route through the host. Harden by: (a) adding an explicit child-exit/timeout reaper so a wedged host child can't leak its own fd, (b) a startup assertion counting `/dev/ptmx` fds held by the daemon PID (must stay 0), (c) keeping the existing pty-leak test as a regression gate. **Verify on staging under a multi-spawn soak before fleet cutover.**

---

## 6. Risk-ordered execution stages

Each stage is independently shippable and staging-validatable. Blast radius is on the live ~11-agent fleet. Never hard-restart mid-pipeline-run.

**Stage 0 — Baseline branch + staging clone (no fleet impact).**
Cut `rebaseline/upstream-a15baad` from `upstream/main`. Stand up the staging environment (setup-staging-environment). Blast radius: none (branch only).

**Stage 1 — Re-port pure product with no lifecycle coupling (LOWEST risk / HIGH value).**
Cherry-apply Bucket-A leaf subsystems onto the upstream base: `src/pipeline/` (+staging-verify), `src/bus/kb-graph/`, product utils (claim-detector, memory-lint, verification-receipt, gates), `community/`, `knowledge-base/`, `templates/`, `dashboard/`. These don't touch daemon/pty/telegram runtime. Blast radius: build-time only; no change to how agents spawn or restart. **← RECOMMENDED STAGE-1 ACTION.**

**Stage 2 — Adopt upstream daemon/cron/telegram base (drop fork instability).**
Take upstream `agent-manager.ts`, `agent-process.ts`, `cron-scheduler.ts`, `ipc-server.ts`, `telegram/api.ts` verbatim. **DROP** Bucket-C: fast-checker `stall*` watchdog, `cron-liveness.ts` escalation, `handoff-backping.ts`. Adopt upstream context-handoff (#685/#699), Telegram registration (#668), false-positive crash kill (#445/#550). Blast radius: HIGH — this is the restart/spawn/handoff surface. Soak on staging 24–48h, watch for restart churn, ptmx count, dropped Telegram menus.

**Stage 3 — Re-wire the pty-host onto upstream pty (KEEP+HARDEN).**
Re-apply `pty-host-{client,entry}.ts` + `pty-ipc.ts` and the thin routing hooks in upstream `agent-pty.ts` / `codex-app-server-pty.ts`. Add the ptmx-count startup assertion + child reaper. Blast radius: HIGH (every agent spawn). Staging soak = repeated spawn/kill loop; assert daemon holds 0 ptmx fds and no posix_spawnp failures.

**Stage 4 — Re-port coupled daemon product (conversation-buffer, reconcile-trigger, telegram-streamer, dedup, hooks).**
Re-apply Bucket-A daemon files on top of the now-upstream base, decoupled from restart escalation. Scope `telegram/dedup.ts` to bus-fanout dupes only (handoff dupes gone under upstream). Blast radius: MEDIUM. Validate recall/reconcile/streaming behavior on staging.

**Stage 5 — Cutover + regression + security.**
Adopt upstream security leak-guard (#704/#698 pre-push + CI). Full regression (`npm run build && npm test`), fleet smoke on staging, then flip production one agent at a time. Blast radius: full fleet — gated, incremental, reversible via branch.

---

*End of manifest. All classifications grounded in git evidence above; "live/deployed" states are hypotheses to confirm on staging before production cutover.*

---

## EMPIRICAL PROOF — node-pty ptmx/fd leak (2026-07-28, this machine)

Josh challenged the #132 commit's leak claim ("upstream couldn't have this leak"). Tested it instead of trusting prose. node-pty 1.1.0, node v22.22.3, macOS.

**Test: upstream-style spawn → onExit → kill(), 60 iterations, measure open fds.**
- `/dev/ttys` (slave) held = **0** throughout — kill() DOES release the slave.
- Total open fds grew **linearly +3/spawn**: 23 → 83 → 143 → 203. Never reclaimed after settle.
- Leaked types (after 40): `42 CHR` (pty master), `40 (revoked)` (killed slaves, fd not freed), `44 KQUEUE`.

**Test B: same but disposing onData/onExit disposables** → identical 203 fds. **JS disposal does NOT fix it.**

**Conclusion:** genuine node-pty native-addon leak (master CHR fd + kqueue), unreclaimable from JS. Wall is the **process fd ulimit (256 soft)**, NOT ptmx_max=511 (commit mis-named it). pty-host (#132, child process.exit reclaims via OS) is the ONLY valid fix short of a node-pty version bump. **VERDICT: keep+harden pty-host. Check node-pty >1.1.0 for a native fix in Stage 3 — if fixed, drop pty-host.**
