# Wave 2 Convergence Report — RW-2..RW-10 + M1..M8 Fan-Out

Date: 2026-08-02
Scope: 17 items fanned out across worktree-isolated lanes against the v9 fleet-incident convergence plan (fork vs upstream/main `dfedf9b`, base `cbb733b`). 13 PRs opened, 4 NO_OP (2 folded into open PRs, 2 verify/exonerate). Every PR built clean (`tsup` + `tsc --noEmit`) and passed its targeted suites; the single recurring failure (`rebaseline-runtime-gates.test.ts` darwin fd-leak gate, node-pty spawn-helper prebuild missing in fresh worktrees) was proven pre-existing at clean HEAD via `git stash` re-run in every lane — environmental, unrelated.

---

## 1. Item Table

| Item | Outcome | PR | Build / Tests | Adversarial Verdict | Residual Risk |
|---|---|---|---|---|---|
| **RW-2** Instance-resolution split-brain + M7 boot-pin drift monitor | PR_OPENED | [#208](https://github.com/clearworks-ai/cortextos/pull/208) | Build clean; 63/63 targeted, 1005/1006 full (pre-existing fail); PR CI all SUCCESS | **MERGEABLE** | Hosts with a stale ACTIVE_INSTANCE marker: bare env-path calls now follow the marker (intended); drift monitor is warn-only — pinned daemon under a rewritten marker persists until restart by design |
| **RW-3** Phantom-registry reconcile (EPERM=alive, delete-without-kill) | PR_OPENED | [#209](https://github.com/clearworks-ai/cortextos/pull/209) | Build clean; 22 new tests; 186+75 targeted green; 15 pre-existing full-suite fails proven at HEAD | **NEEDS_WORK** — merge conflict with RW-6 #211 (same-offset method inserts in 5 shared files); rebase onto #211, delegate kill sweep to the ledger | Recycled-pid heuristic best-effort (120s slack, ps-failure=keep — fail direction wedge-visible, never kill-innocent); reparented descendants invisible to ppid walk (RW-6 scope); lands on daemon restart |
| **RW-4** pty-host kill path: graceful pty-dispose before SIGKILL | PR_OPENED | [#207](https://github.com/clearworks-ai/cortextos/pull/207) | Build clean; pty suite 149/149 incl. real-node-pty dispose gate + orphan control test; 434/435 daemon (pre-existing fail) | **MERGEABLE** | Wedged-host teardown now up to 5s before SIGKILL (inside 15s stop window); SIGHUP-ignoring grandchild gets hard 4s SIGKILL fallback (dead, never orphaned); pre-existing pty-kill fd-close nit not a regression |
| **RW-5** hostSpawn await-forever: waitReady timeout-less | PR_OPENED | [#204](https://github.com/clearworks-ai/cortextos/pull/204) | Build clean; pty 145/145 incl. 3 new regression tests; 434/435 daemon (pre-existing fail) | **NEEDS_WORK** — merge-tree confirmed conflict with RW-6 #211 in the hostSpawn/waitReady block; land #211 first, rebase #204 preserving both orphan-kill and ledger update | Post-ready hangs out of scope (watchdog); 15s deadline could fire on extreme-load fork but caller retries (correct semantic); torn-IPC pty-error flush lossy but exit(1) covers |
| **RW-6** No pty-host PID ledger / reaper | PR_OPENED | [#211](https://github.com/clearworks-ai/cortextos/pull/211) | Build clean; 28 new tests (ledger 11 + reaper 17); pty-leak gate delta=0; full 2777 pass, 10 pre-existing fails proven at HEAD | **NEEDS_WORK** — import-block conflict with RW-4 #207 in pty-host-client.ts, and its Tier-2 surviving-pty-child path is DEAD until RW-4's graceful destroy lands; rebase onto #207 | Pre-existing hostless claude orphans need one manual sweep (no ledger entry to find them); Tier-3 accuracy bounded by 10-min grace + two-sweep persistence; detached hosts lose foreground Ctrl-C (IPC-disconnect self-exit covers); Windows skipped (fleet is macOS) |
| **RW-7** Codex kill-during-spawn race | PR_OPENED | [#203](https://github.com/clearworks-ai/cortextos/pull/203) | Build clean; 83/83 incl. 3 new tests; 579/580 (pre-existing fail) | **MERGEABLE** — hunks at ~397/~440 don't overlap RW-3/RW-6's ~212 region | Low. Theoretical stale-pty on re-spawn of same adapter (no caller does this); second kill() via rejection path verified idempotent |
| **RW-8** ReconcileTrigger deletion (sync sweeps + Atomics.wait on daemon loop, wrong-signal dryRun:false reclaim) | PR_OPENED | [#206](https://github.com/clearworks-ai/cortextos/pull/206) | Build clean; bus 546/546; daemon 539/540 (pre-existing fail); zero dangling refs grep-verified | **MERGEABLE** — net −598 lines fork divergence; note #208/#211 branched pre-RW-8 and still carry ReconcileTrigger imports in index.ts diffs → downstream rebases, not a defect here | Orphan reclaim / due resurface / experiment nags no longer automatic (intentional — signal was provably wrong; restore cadence via agent cron calling preserved read-only CLI commands); task lock domain itself untouched |
| **RW-9 (+M5)** Locked enabled-agents reads on boot/exit paths | PR_OPENED | [#205](https://github.com/clearworks-ai/cortextos/pull/205) | Build clean; 55/55 targeted incl. new lock-held-reader regression; 457/458 daemon (pre-existing fail) | **NEEDS_WORK** — fix itself airtight, but branch cut at `cbb733b` never picked up `da09588` (Multica Spec B approval-resolution bridge): as-diffed it silently deletes 21 prod lines + 178 test lines. Rebase onto current main, re-verify, then merge | Narrow quarantine race retained (needs corrupt primary + corrupt .bak concurrent with a write); readers may see pre-mutation map for ms (upstream semantics); future direct writes to enabled-agents.json would reintroduce torn-read exposure |
| **RW-10** Worker 10-min self-reap wedges worker registry | PR_OPENED | [#210](https://github.com/clearworks-ai/cortextos/pull/210) | Build clean; 50/50 incl. 7 new; 440/441 daemon (pre-existing fail) | **MERGEABLE** — one non-blocking test-name overstatement (mock PTY doesn't strip listeners; prod code still correct) | 10-min cap still kills legit >10-min workers (Wave 6 retirement call), but honestly reported 'reaped' and name frees; escalated kills traverse RW-4 race until #207 lands; terminate IPC latency up to ~2s |
| **M1** 9 missing review docs + inject.ts rebaseline drift | PR_OPENED | [#214](https://github.com/clearworks-ai/cortextos/pull/214) | Build clean; inject + daemon suites 440/441 (pre-existing fail); byte-identity to upstream verified via git show diff exit 0 | **MERGEABLE** — 15+9=24 docs confirmed on disk; zero-caller deletion grep-proven; no collision with #202–#215 | Low — deleted code had zero callers, runtime unchanged. Silent retry-drop window remains open exactly as upstream; re-land trigger (pty-ipc delivery ack) documented, not shipped. 2/9 docs honestly self-annotate unverified SHAs |
| **M2** src/hooks audit + retrieval-enforcer shell injection | PR_OPENED | [#212](https://github.com/clearworks-ai/cortextos/pull/212) | Build clean; 16/16 enforcer incl. 3 injection regressions; hooks 184 pass, 8 pre-existing lifecycle-gate fails proven at HEAD | **MERGEABLE** — execFileSync argv arrays make the injection class structurally impossible; hostile-org test proves the critical path | Behavior parity exact; needs `cortextos` on PATH sans shell (already true). Wave 5 follow-ups open: 12s sync turn-start latency measurement; re-audit tool-result-router if ever registered fleet-wide |
| **M3** Task-lock hold-time measurement (RW-8 gate) + .bak leak | PR_OPENED | [#215](https://github.com/clearworks-ai/cortextos/pull/215) | Build clean; task suites 115/115; full unit 2,156 pass; live-copy prune proof 10,021 orphans in 613ms | **MERGEABLE** | First archive-cron run holds task lock ~0.6s extra (one-time, 8x under timeout); zero in-tree readers of task .json.bak (out-of-tree scripts lose source); other .bak fallbacks untouched. Ops gap: no live archive cron yet, legacy orphans drain lazily |
| **M4** webhook-bridge supervision review | NO_OP | — | No code changes; existing suite 13/13 | (no PR) Code exonerated | **OPERATOR ACTION REQUIRED:** production webhook ingress rides orphaned PID 15124 out of /tmp (codexer test leftover since 07-28, no launchd entry — dies silently, Alloi-miss class). Runbook: `node dist/cli.js webhook-bridge start` from the repo, verify launchctl + healthz, kill 15124 first (port 20242 conflict), low-webhook window |
| **M5** isDisabled locked read blocks handleExit | NO_OP (folded) | [#205](https://github.com/clearworks-ai/cortextos/pull/205) | Verified at PR commit a1af21b: build clean, 33/33 targeted | Rides RW-9's verdict (**NEEDS_WORK**, rebase-only) | If #205 closes unmerged, M5 reopens. Reviewer should confirm the atomic-rename re-justification of the sage-drop TOCTOU comment |
| **M6** op:// sync execFileSync daemon block + no failure cache + silent degraded boot | PR_OPENED | [#213](https://github.com/clearworks-ai/cortextos/pull/213) | Build clean; 977/978 (pre-existing fail); 13 new env tests, targeted 69/69 | **MERGEABLE** — CodexAppServerPTY op:// gap pre-existing/out-of-scope (accurate exclusion) | Degraded marker loud but non-blocking (agent boots with literal refs — availability over hard-fail); 5-min failure TTL delays recovery detection; sequential per-key fallback worth parallelizing later; lands on daemon restart |
| **M7** Daemon reads marker once at start (boot-pin drift) | NO_OP (folded) | [#208](https://github.com/clearworks-ai/cortextos/pull/208) | #208 CI all SUCCESS; drift-monitor tests green | Covered by RW-2 verdict (**MERGEABLE**) | Warn-only drift monitor (by design); stale PM2 ecosystem.config.js can still boot a generation-pinned daemon, now loud at boot. If #208 rejected, M7 reopens as REVERT-marker-system |
| **M8** Coverage confirmations + 2b34244 image-poison breaker survival | NO_OP | — | Verify-only; both hunks + companion tests confirmed byte-identical on origin/main | (no PR needed) | None. Note: 2b34244 squash-merged as `2c66b87` — future containment checks must grep content or cite 2c66b87, not the branch SHA |

---

## 2. Merge Order Recommendation

### Batch A — clean, zero-collision, merge now (any order within batch)
1. **#203** (RW-7) — single file, hunks proven non-overlapping with every other lane
2. **#210** (RW-10) — worker-process/agent-manager, zero overlap with #202/#207/#200
3. **#212** (M2) — hooks only, touches nothing any other PR touches
4. **#214** (M1) — review docs + upstream-identical inject.ts reset, zero collision
5. **#215** (M3) — bus/task.ts only, zero collision
6. **#213** (M6) — env.ts + agent-pty.ts. *Minor caution:* #207 also touches agent-pty.ts (documentation-level change); verified against #200/#202 only — merge #213 and #207 back-to-back and rerun CI between them; any conflict is trivial

### Batch B — MERGEABLE but sequenced (shared daemon/index.ts region)
7. **#207** (RW-4) — merge before the NEEDS_WORK pty chain rebases onto it
8. **#208** (RW-2 + M7) — CI already fully green; touches daemon/index.ts
9. **#206** (RW-8) — MERGEABLE verdict, but #208 and #206 both edit daemon/index.ts from pre-each-other bases: merge #208 first, then **rebase #206** (its change is a deletion; resolution is mechanical) and land it

### Batch C — NEEDS_WORK, fix then merge in this dependency order
10. **#205** (RW-9/M5) — rebase onto current main to restore `da09588` (Multica Spec B — 21 prod lines + 178 test lines currently silently deleted), re-verify counts, then merge. Fix itself is approved as airtight
11. **#211** (RW-6) — rebase onto #207 (RW-4) so the graceful destroy makes the Tier-2 surviving-pty-child reaper path live; resolve import-block conflict by keeping all imports; also pick up #206's index.ts (ReconcileTrigger removal)
12. **#204** (RW-5) — rebase onto #211; conflict resolution must preserve both RW-5's orphan-kill-on-waitReady-failure and RW-6's `updatePtyHostPtyPid` ledger update atomically
13. **#209** (RW-3) — rebase onto #211 last; co-locate `getHostPid`/`getPtyHostPid`, and consider delegating the reconciler's kill sweep to the RW-6 ledger instead of its own process-tree BFS (both modules carry Wave 6 removal markers)

### Human review before merge
- **#205** — reviewer must confirm the da09588 restoration and the sage-drop TOCTOU atomic-rename reasoning
- **#211/#204/#209 post-rebase** — the three-way pty-host-client.ts merge is the only place in this wave where wrong conflict resolution silently reintroduces an orphan path
- **M4 runbook** — operator (not PR) action: re-home the webhook bridge under launchd, then kill PID 15124

### Non-PR operator actions
- Execute M4 runbook in a low-webhook window (kill 15124 → `webhook-bridge start` → verify launchctl + healthz)
- One-time manual sweep of pre-existing hostless claude orphans (RW-6 residual — ledger can't see them)
- After #206 lands: decide whether to restore reclaim/due-sweep/experiment-nag cadence via an agent cron calling the preserved read-only CLI commands

---

## 3. Non-Wounds / False Positives Caught by Convergence Discipline

| Claimed wound | Verdict | Evidence lane |
|---|---|---|
| RW-8 "lock hold-time forces offload of reconcile work" | **FALSE premise** — M3 measured p50 35–51ms / max 177ms sweeps, 5s timeout needs ~100x live scale; RW-8 was decided (correctly) on its ownership-mutation wound alone | M3 [#215](https://github.com/clearworks-ai/cortextos/pull/215) |
| CLI per-spawn module-load tax | **Non-wound** — 778KB vs 434KB dist = +5.8ms/spawn, negligible, no action | M3 #215 |
| hook-tool-result-router = live Telegram-429 amplifier | **Exonerated** — DORMANT, zero registrations in any agent settings.json or template | M2 [#212](https://github.com/clearworks-ai/cortextos/pull/212) |
| telegram-streamer.ts / handoff-backping.ts instability | **Exonerated** with written evidence — bounded buffers/timers, off the daemon supervision path | M1 [#214](https://github.com/clearworks-ai/cortextos/pull/214) |
| webhook-bridge Telegram token custody + unsupervised code | **FALSE** — only WEBHOOK_BRIDGE_SECRET held, delivery is HMAC file-bus; launchd KeepAlive supervision correct. Real wound was operational (orphan PID), not code | M4 (NO_OP) |
| M7 start.ts-local instability | **Non-wound** — no race/growth/block/orphan/leak in start.ts itself; the real drift wound lives in (and is fixed by) #208 | M7 (NO_OP) |
| M8 fear: image-poison breaker lost in merge | **Non-wound** — both 2b34244 hunks + tests byte-identical on main at 2c66b87 | M8 (NO_OP) |
| RW-3 wound-doc detail: "registered pid is the pty-host pid" | **Corrected** — pty-host-entry.ts:58 sends the INNER node-pty pid; fix covers both roots regardless | RW-3 [#209](https://github.com/clearworks-ai/cortextos/pull/209) |
| inject.ts #69 dedup divergence worth re-landing | **Converged instead** — rebaseline #172 already deleted all callers; silent-drop window is upstream-shared; re-land trigger documented | M1 #214 |

---

## 4. Cross-Cutting Notes

- **Every lane independently re-proved the fork-only vs upstream question** before choosing KEEP-BUT-FIX vs CONVERGE — 2 full converge-to-upstream deletions landed (RW-8 reconcile-trigger −598 lines; M1 inject.ts byte-identical reset), 1 partial (RW-9 read-lock removal; M3 keepBak drop), the rest justified ADDs on the proven pty-host / instance / op:// / webhook capabilities upstream lacks.
- **The 3 NEEDS_WORK verdicts are all merge-mechanics (stale base / lane collision), zero logic defects found** — the adversarial pass confirmed core correctness on all 13 PRs.
- **Nothing in this wave touches the live daemon**; every change lands on next daemon restart post-merge.
- Wave 6 retirement candidates now on record: RW-10's 10-min worker cap, RW-3's process-tree.ts + reconcile heuristics (once RW-6 reaper holds), hook-crash-alert band-aid stack (gated on RW-1 #202 revert proof).
