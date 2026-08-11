# Fork deltas — upstream dependencies we are living without

Tracks, per MASTER-BUILD-PLAN.md `P3 · Multica task rail` item 3.0c, the fallback decision for
upstream PRs the Multica pilot names as external dependencies it explicitly does NOT wait for.
Plan's fallback rule: "cherry-pick the PR branch onto our fork if it stalls >2 weeks after pilot
start, or live with the wart (each is an annoyance, not a data-loss bug)."

## 2026-08-03 — initial decision: live with all 3 warts

| Upstream PR (grandamenium/cortextos) | Title | State (checked 2026-08-03) | Wart if left unmerged |
|---|---|---|---|
| [#762](https://github.com/grandamenium/cortextos/pull/762) | fix(bus/daemon): ack-path defects — reply_to send-time ack, dual-dir ackInbox, DEFERRED_CONFIRM with payload attribution | OPEN | ack-path defects — annoyance, not data loss per the plan's own framing |
| [#772](https://github.com/grandamenium/cortextos/pull/772) | fix(bus): a locked inbox must never look like an empty one | OPEN | a locked inbox can appear empty — annoyance, not data loss |
| [#816](https://github.com/grandamenium/cortextos/pull/816) | fix(cli): list-tasks renders full ids + supports --project filter | OPEN | truncated task ids / no --project filter in list-tasks output — annoyance, not data loss |

**Decision:** live with all 3 warts. The Multica pilot has not formally started yet — the 3.1
cron (`cortextos bus multica-sync`, spec at
`.agent/one-big-feature/multica-task-bridge/03-specs/04-cron.md`) is still waiting on Josh's own
manual dry-run → `--direction out` → `--direction in` round-trip confirmation before it is
scheduled. The plan's own ">2 weeks after pilot start" cherry-pick trigger has therefore not
started counting for any of the 3 PRs.

**Re-evaluate:** re-check each PR's state once the pilot formally starts (the 10-min cron is
scheduled and running); if any of the 3 is still OPEN more than 2 weeks after that start date,
cherry-pick that PR's branch onto our fork per the plan's fallback rule rather than continuing to
wait on upstream.

## 2026-08-10 — fork-additive `src/` deltas (upstream-PR candidates, P7 invariant)

Changes we carry on the fork ahead of upstream. Each is a candidate to push upstream
to `grandamenium/cortextos` once stabilized.

| Fork branch / PR | `src/` files | What it adds | Upstream-PR candidate? |
|---|---|---|---|
| `larry/track-a-meeting-deterministic-spawn` — [fork PR #328](https://github.com/clearworks-ai/cortextos/pull/328), commit `933279dc` | `src/cli/webhook-bridge.ts`, `src/cli/workers.ts`, `src/daemon/agent-manager.ts`, `src/daemon/ipc-server.ts` | Track A / FR-A1: deterministic daemon `spawn-worker` on a fireflies `meeting.completed` event (`planMeetingWritebackSpawn`/`trySpawnMeetingWriteback`), dynamic agent-dir resolution (no hardcoded path), `CtxEnv.extraEnv` threading `FF_MEETING_ID` into the worker PTY, `spawn-worker --env KEY=VAL` IPC/CLI. Falls back to the NL relay when the daemon is unreachable. | YES — generic webhook→deterministic-worker-spawn plumbing, not Clearworks-specific. |

Note: the Track A path-parameterization fix (running-agent dir resolution via `$CTX_*`
in `meeting-writeback-worker/SKILL.md`) is an agent-local skill edit, not a `src/`
change, so it is NOT an upstream-PR candidate — it stays on our fork.
## 2026-08-10 — A6 commitment triple-sink (NO src/ delta — recorded for traceability)

Track A6 (commitment triple-sink: BUS + BRIEFS + Telegram) was implemented WITHOUT touching
`src/` — it reuses the existing bus CLI surface (`bus create-task --assignee human`,
`bus create-approval`, `bus event-dedup`) as-is. The change lives entirely in the org's
meeting pipeline: `orgs/clearworksai/agents/pa/scripts/ff-extractor.py` (new pure
`bus_task_entries()` / `is_client_visible()` + `busTasks[]` in the run-output contract) and the
`meeting-commitments-worker` SKILL (new Step 4b bus sink gated on
`bus event-dedup --source commitment:<id>`). **No fork-delta / upstream-PR candidate** — this is
additive org config, not a `src/` modification, so the P7 invariant does not apply.
## 2026-08-10 — S1 lane (solution-design 5-stack, on-demand)

| Lane | Branch | src touched | Upstream candidate |
|---|---|---|---|
| S1 | `larry/s1-solution-design-5stack` | `src/pipeline/deal-context.ts` (new), `src/pipeline/scoping-gate.ts` (filename-guard fix), `tsup.config.ts` (add deal-context entry) | YES — `deal-context.ts` is a pure pipeline util with no org-specific logic; upstream PR candidate once fork #172 merges |

**What S1 adds:** `dist/pipeline/deal-context.js` CLI (`init` + `coherence-check`) threads a
single JSON deal spine (slug + phase ids + artifact paths) across the 5-stack producers so
proposal scope == pricing line items == deal-room sections provably. Scoping-gate guard fix stops
the entry from firing when inlined into the deal-context bundle. Fixture at
`state/skill-tests/solution-design-chain/` (positive PASS + negative named-violations).
No event/cron wiring; Josh-driven only.
## 2026-08-10 — codex context-full DEADLOCK fix (fork-additive `src/` delta, P7 invariant)

| Fork branch / PR | `src/` files | What it adds | Upstream-PR candidate? |
|---|---|---|---|
| `larry/codex-context-full-handoff-fix` | `src/pty/codex-app-server-pty.ts`, `src/bus/system.ts`, `src/daemon/fast-checker.ts`, `src/daemon/agent-process.ts`, `src/daemon/restart-context.ts` (new) | Breaks the codex `-codex` context-full deadlock (push-only telemetry can't measure a resumed full thread → false 0% → recovery never fires). **Fix 1 (deadlock-breaker):** on `thread/resume`, pull true window occupancy from the app-server rollout JSONL `token_count` event (codex v2 has NO per-thread usage-read request) → `context_status.json` reflects real usage with `measurement_source: resume_rollout` → FastChecker bypasses the fresh-thread spike-grace and fires the normal proactive `[CONTEXT HANDOFF REQUIRED]`. **Fix 2 (safety net):** catch the "ran out of room / context window" turn error in `handleTurnQueueFailure` → route through the SAME `planContextHardRestart` marker contract the fast-checker uses (`.force-fresh` + `.restart-planned` + reset context bridge + `.handoff-doc-path` re-inject of the most-recent handoff doc — never a blank thread) + daemon `sessionRefresh`, with a persisted loop guard (≤2 recoveries / 5min). Shared `planContextHardRestart()` + `findFreshRecentHandoffDoc()`/`ensureMissionAnchorFromBuffer()` extracted into `restart-context.ts`. | YES — generic codex-app-server runtime reliability (context-full recovery + rollout-usage pull), no Clearworks-specific logic. |

**Verify:** unit `tests/unit/pty/codex-app-server-pty.test.ts`, `tests/unit/daemon/fast-checker.test.ts`, `tests/unit/daemon/agent-process-codex-app-server.test.ts` (all green, failing-first proven). Staging receipt `state/staging-receipts/codex-context-full-fix-2026-08-10.md` + regression spec `tests/staging/codex-context-full-staging-verify.test.ts` (both behaviors proven on pinned `cortextos-staging` with real on-disk artifacts). Incident: `incident_codex_thread_context_full_false_zero_telemetry_2026-08-10`.
