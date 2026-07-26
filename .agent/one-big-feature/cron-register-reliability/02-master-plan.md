# 02-master-plan — cron-register-reliability

Goal: `bus add-cron` → crons.json → daemon is the ONLY cron path, and add-cron cannot print
success unless the cron is verifiably live in the running scheduler. Kill the "registered but
never fires" class at every layer: daemon truth (FP2), CLI verification (FP1), instance-dir
split (FP3), tick self-heal, allowlist removal, and a fleet liveness assertion.

Scope locked by Josh: A (remove in-memory cron path), B (reload-and-verify + FP1/FP2/FP3 +
tick mtime self-heal), C (fast-checker cron-liveness + job-liveness gate), D (kb-job-run
`.allowExcessArguments(true)` fold-in). The 7h daemon hang (pty in-process spawn,
`agent-pty.ts:65`) is DOCUMENTED here but built on the already-open
`fix/pty-host-wire-agent-pty` branch — follow-up, not this OBF.

## Framework-class recommendation: OBF — with one condition

OBF holds IF Phase 3 (instance-dir) stays scoped to: hard-fail guard in cron commands +
`doctor` check + orphan cleanup. That is additive and single-repo. If review decides the real
fix is unifying instance resolution itself (one shared resolver for CLI + daemon + agent env,
migrating `.cortextos-env` files, removing the `process.cwd()` fallback in `crons.ts`) — that
touches every CLI entrypoint and the daemon boot path and should ESCALATE to full M2C1 as its
own effort. This plan takes the narrow version and leaves a written pointer.

## Phases (ordered)

### Phase 0 — kb-job-run one-liner (spec 05) — independent, do first
- Files: `src/cli/bus.ts:2404` (add `.allowExcessArguments(true)` next to `.allowUnknownOption(true)`).
- Risk: none. Test: unit test invoking kb-job-run parse with excess args after `--`.

### Phase 1 — Daemon returns the truth (spec 02, daemon half)
- Files: `src/daemon/ipc-server.ts:722-733` (reload-crons handler), `src/daemon/agent-manager.ts`
  (expose per-agent `getCronNextFireTimes(agent)` via `cronSchedulers.get(agent)?.getNextFireTimes()`).
- Change: handler captures `const ok = this.agentManager.reloadCrons(agent)`; on `ok===false`
  reply `{success:false, code:'AGENT_NOT_SCHEDULED'}`; on success include
  `data.nextFireTimes` from the live scheduler. DELETE the false "next 30s tick" comment
  (ipc-server.ts:727-728). Also thread the result at ipc-server.ts:799/814/828.
- Risk: response-shape change is additive (`data` was a string, becomes an object) — audit the
  few `reload-crons` callers (`signalCronReload` is the only CLI caller; it discards today).
- Test: unit test on the handler with (a) scheduled agent → success + nextFireTimes contains
  the cron; (b) unknown agent → success:false AGENT_NOT_SCHEDULED; (c) hermes agent → success
  (documented no-op).

### Phase 2 — CLI reload-and-verify (spec 02, CLI half) — depends on Phase 1
- Files: `src/cli/bus.ts:3544-3549` (signalCronReload), `3588-3596` (add-cron tail), `3616`
  (remove-cron), `4005` (update-cron).
- Change: `signalCronReload` returns the `IPCResponse` (no swallow; ENOENT/ECONNREFUSED
  already resolve to `success:false` per ipc-server.ts:887-896). `add-cron` asserts the new
  cron name appears in `response.data.nextFireTimes` with numeric `nextFireAt` BEFORE printing
  `Added cron '<name>' … — live in scheduler, next fire <ISO>`. Any other outcome → stderr
  with the real state (written-to-file-but-NOT-live + remediation) → `process.exit(1)`.
  DELETE the false comment at bus.ts:3548.
- Back-compat: old daemon (no nextFireTimes in data) → treat as UNVERIFIED, exit 1 with
  "daemon predates verify protocol — restart daemon". Loud beats silent.
- Test: integration test with a fake IPC socket: success-with-name → exit 0; success-without-
  name, success:false, daemon-down → exit 1 + file still written.

### Phase 3 — Instance-dir guard + orphan cleanup (spec 03) — independent of 1/2 but lands after (Phase 2's exit-1 already catches wrong-socket)
- Files: `src/cli/bus.ts` (cron command preamble), `src/cli/doctor.ts`, ops cleanup step.
- Change: before any cron write, compare resolved `env.instanceId` against
  `resolveActiveInstance()` marker; mismatch → hard warn (and `--strict-instance` exit 1);
  `doctor` gains an orphan-instance check (crons.json trees under non-active instances with
  no live daemon socket). One-time cleanup: archive `~/.cortextos/default/.cortextOS/state/agents/*/crons.json`
  (13 orphans confirmed) to `~/.cortextos/default/.archived-2026-07/`.
- Risk: dev workflows legitimately using CTX_INSTANCE_ID=default with a default-instance
  daemon must not break — warn keys off "marker exists AND differs", not off 'default' per se.
- Test: unit tests for the mismatch predicate; doctor test with a fixture orphan tree.

### Phase 4 — tick() mtime self-heal (spec 02, scheduler part)
- Files: `src/daemon/cron-scheduler.ts` (tick() at 464; record loaded-mtime in loadCrons at 341).
- Change: one `statSync` of crons.json per 30s tick; if mtime > lastLoadedMtime → `loadCrons(true)`.
  Preserves the reload-while-firing guard (already in loadCrons, lines ~386-395). Makes the
  once-false "picked up on next tick" claim actually true (≤30s worst case) even with a lost signal.
- Risk: low — bounded 1 stat/agent/30s; must not fight Phase 1 (reload() and mtime-heal both
  route through loadCrons(true), idempotent by design).
- Test: extend existing cron-scheduler unit tests (fake timers): write crons.json after start,
  no reload call, assert the new cron is scheduled within one tick.

### Phase 5 — Remove the in-memory cron path (spec 01)
- Files: `src/cli/bus.ts:4605-4611` (REQUIRED_ALLOW), templates (`agent`, `analyst`,
  `orchestrator`): CLAUDE.md / AGENTS.md / ONBOARDING.md / skills SKILL.md mentions,
  `src/utils/cron-teaching-scanner.ts` (tighten patterns if needed), live
  `orgs/*/agents/*/.claude/settings.json` sweep via `fix-agent-settings`.
- Change: drop `CronCreate` (and decide CronList/CronDelete — see open decisions) from
  REQUIRED_ALLOW so `fix-agent-settings` stops re-injecting it; strip it from live agent
  settings; sweep template/skill teaching so the only documented path is
  `bus add-cron` / `bus add-reminder`.
- Risk: one-shot reminders — `src/bus/reminders.ts` exists precisely because CronCreate
  records are session-only; confirm no agent workflow still depends on CronCreate one-shots
  before removal (cron-teaching-scanner's own suggested text currently says "Keep CronCreate
  only for one-shot reminders" — that guidance gets updated too).
- Test: `bus cron-teaching` scan returns clean on templates; fix-agent-settings --dry-run
  shows removal not addition; grep-gate in CI/test for `CronCreate` in templates allowlists.

### Phase 6 — fast-checker cron-liveness + job-liveness gate (spec 04) — after Phases 1-4 (asserting liveness before the register path is fixed would page on known-broken behavior)
- Files: `src/daemon/fast-checker.ts` (new check in pollCycle cadence, reusing
  `getLastCronFireAt()` ~1186 and the existing restart/circuit machinery),
  `src/daemon/cron-scheduler.ts` or agent-manager (expose overdue info if needed).
- Change: per agent, if any ENABLED cron is overdue beyond `2 × schedule-tolerance`
  (i.e. a fire that should have happened in the last N min did not, per crons.json +
  cron-state.json), escalate through the EXISTING restart machinery — reload first,
  restart second, page third; circuit-breaker rules apply. NOT a new launchd agent.
- Job-liveness gate (process, not code): a cron task is "done" only when
  (1) add-cron exited 0 (registered+live), (2) first fire observed in cron-state.json /
  execution log, (3) canary green. Written into the cron-management SKILL.md as the
  definition-of-done checklist.
- Test: unit test with fixture crons.json (overdue cron) → detector flags; non-overdue → silent.

## Sequencing summary
0 (trivial) → 1 → 2 → 4 can merge as one PR (they are one logical protocol change);
3 and 5 are parallel-independent after that; 6 last. Single PR or 3 small PRs
(protocol / hygiene / liveness) — implementer's choice, tests per phase either way.

## Verify plan (whole feature)
- `npm run build && npm test` green.
- Live proof: on a running daemon, `bus add-cron <agent> canary-<ts> 5m 'echo canary'` →
  exit 0 prints next-fire ISO → cron fires ≤5m → `bus remove-cron` → exit 0.
- Negative proof: stop daemon → `add-cron` exits 1 with the written-but-not-live message.
- Orphan proof: `doctor` reports 0 orphan instances after cleanup.

## Open decisions for Josh (before dispatch)
1. Phase 5 breadth: remove only `CronCreate` from REQUIRED_ALLOW, or all three
   (`CronCreate`,`CronList`,`CronDelete`)? Recommendation: all three; reminders route via
   `bus add-reminder`, listing via `bus list-crons`.
2. Orphan handling: archive (recommended) vs delete `~/.cortextos/default` cron trees.
3. Confirm D-hang/pty stays on `fix/pty-host-wire-agent-pty` (follow-up), not folded here.
