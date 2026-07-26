# Adversarial Code Review — cron-register-reliability

**VERDICT: PASS-WITH-NITS**

Branch `fix/cron-register-reliability` @ 9f6b501 vs base main @ 30aa285.
Diff = exactly 13 files, 691 insertions / 44 deletions — matches the self-report 1:1.

> NOTE ON SPEC ARTIFACTS: The OBF planning dir `.agent/one-big-feature/cron-register-reliability/`
> (02-master-plan.md + 03-specs/*) does NOT exist on disk in the shared checkout at review time and
> is NOT committed in 9f6b501. It was an untracked scratch tree (session-start `git status` listed it
> as `??`) that has since been removed by another agent in the shared checkout. Review was therefore
> conducted against the acceptance criteria encoded in the review checklist itself (which restates the
> spec in full) plus the builder's per-file self-report, cross-checked against source. This is a
> process nit, not a code defect — but the plan/specs should be committed alongside the code so the
> build is auditable. Flagged in NON-BLOCKING-NITS.

---

## Checklist

### 1. SCOPE COMPLETENESS (7 phases) — PASS
Phase-by-phase, all implemented:

- **Phase 0 — kb-job-run excess args**: PASS. `bus.ts:2526` adds `.allowExcessArguments(true)` chained after `.allowUnknownOption(true)` on the `kb-job-run` command.
- **Phase 1 — daemon truth (reload-crons returns live schedule)**: PASS. `ipc-server.ts:727-744` — `reload-crons` now returns `AGENT_NOT_SCHEDULED` when `reloadCrons()` is false, else `{ message, nextFireTimes, runtime? }`. `agent-manager.ts:1308` adds `getCronNextFireTimes()` and `1315` adds `getAgentRuntime()`. `getNextFireTimes()` already existed on CronScheduler (`cron-scheduler.ts:335`).
- **Phase 2 — CLI verify before success**: PASS. `bus.ts` `signalCronReload` now returns `IPCResponse` (no longer swallows), and add/remove/update call `assertCronSchedulerLive(...)` which asserts liveness and `exit(1)` on any unverified outcome.
- **Phase 3 — instance guard + doctor + orphan script**: PASS. `warnOnInstanceMismatch()` (bus.ts:172) wired into add/remove/update; `doctor.ts:415-465` adds INSTANCE ORPHANS check; `scripts/archive-orphan-instances.sh` DRY-RUN by default.
- **Phase 4 — tick mtime self-heal**: PASS. `cron-scheduler.ts` adds `lastLoadedMtimeMs` field (set in `loadCrons`) and a mtime-compare block at top of `tick()` that calls `loadCrons(true)` when the file mtime advanced.
- **Phase 5 — remove in-memory cron perms + STRIP**: PASS. `CronCreate/CronList/CronDelete` removed from `REQUIRED_ALLOW` (bus.ts:4726) AND a `STRIP_ALLOW` pass added that removes them from existing allow arrays. `cron-teaching-scanner.ts` Keep-CronCreate clause dropped.
- **Phase 6 — fast-checker liveness**: PASS. New `cron-liveness.ts` pure detector; `fast-checker.ts` adds throttled `checkCronLiveness()` (once/min) invoked from the poll cycle, with reload→restart(sessionRefresh)→circuit escalation.

### 2. TWO false comments DELETED — PASS
`grep -n "30s tick" src/cli/bus.ts src/daemon/ipc-server.ts` returns nothing (exit 1, empty).
- ipc-server.ts:727-728 old "CronScheduler picks up the change on its next 30s tick" comment: gone (replaced by real reload-verify block).
- bus.ts:3548 old `catch { /* ... next 30s tick */ }` in the best-effort `signalCronReload`: gone (whole old function replaced by the IPCResponse-returning version at bus.ts:190).

### 3. add-cron asserts name present with finite nextFireAt before success — PASS
`assertCronSchedulerLive(resp, agent, name, 'present', 'Added')` at bus.ts:3703. Logic:
- hermes short-circuit first (see #4),
- `times === null` (success but unparseable → daemon predates reload-verify) → exit 1,
- `!resp.success` → exit 1 with daemon-down/wrong-instance/not-scheduled guidance,
- `mode==='present'` and (`!entry || !Number.isFinite(entry.nextFireAt)`) → exit 1 (name-missing / legacy-string),
- only prints success WITH the ISO next-fire when the entry is found and finite.
File is NOT rolled back on failure — `removeCron`/`writeCron` already ran; assert only reads. Matches spec ("leave the file").

### 4. Hermes short-circuit — PASS
`assertCronSchedulerLive` checks `isHermesReload(resp.data)` FIRST (before the name-assertion): on `success && data.runtime==='hermes'` it prints `(hermes-managed)` and returns (exit 0), skipping the name check. Coherent with `agent-manager.reloadCrons` returning `true` for hermes and ipc-server tagging `runtime:'hermes'` only for hermes agents. Ordering is correct — the empty `nextFireTimes:[]` a hermes agent produces never reaches the "name missing" branch.

### 5. Phase 5 — all three removed + STRIP pass + dry-run — PASS
- `REQUIRED_ALLOW` (bus.ts:4726) no longer contains CronCreate/CronList/CronDelete.
- `STRIP_ALLOW = ['CronCreate','CronList','CronDelete']` added.
- STRIP is applied on write: `settings.permissions.allow = [...current.filter(t => !STRIP_ALLOW.includes(t)), ...missing]` (bus.ts:4779) — removes from EXISTING arrays, not just stops adding.
- `--dry-run` path pushes `allow: -[...]` into `changes` (bus.ts:4762) so strips are shown before applying.

### 6. Phase 3 orphan script — PASS
`scripts/archive-orphan-instances.sh`: `EXECUTE=0` default; only `--execute` archives. Before archiving it diffs orphan-only crons (per-agent, via inline python3 comparing orphan vs live `crons.json` name-sets) and prints them; the `mv` only runs under `--execute`. Not a blind move. Reads `~/.cortextos/state/ACTIVE_INSTANCE` for the live instance (fallback `cortextos1`).

### 7. Code quality — PASS
- No `any` introduced (diff grep for `as any` / `: any` / `<any>` / `any[]` on added lines = none). `IPCResponse.data` is `unknown` and is narrowed via `isRecord`/type guards, no casts.
- `console.log` added only in `src/cli/bus.ts` — all CLI user-facing success output (add/remove/update result lines). That is the sanctioned CLI-output exception. The daemon side (`ipc-server.ts`) adds `console.warn` for a reload-false operational log, consistent with the file's existing 12 `console.*` calls and agent-manager's 38 — not a new pattern.
- Atomic writes: no regression. fix-agent-settings STRIP reuses the pre-existing raw `writeFileSync` (bus.ts:4717 `fsWrite`); settings.json writes were already non-atomic before this change, so nothing is downgraded. (See NIT.)

### 8. Tests — PASS (real assertions, not stubs)
- Phase 0: `cron-register-reliability.test.ts` "kb-job-run allowExcessArguments" — source-scan pin (real).
- Phase 1/2: `bus-crons.test.ts` updated — mock IPC now returns `nextFireTimes`; add/remove/update assert the new "live in scheduler"/"cleared from live scheduler" output, with a per-test "absent" override for remove and disable. Real behavioral assertions.
- Phase 3: `cron-register-reliability.test.ts` "fix-agent-settings Cron* strip" + "instance mismatch predicate" — source-scan + resolveActiveInstance identity. The mismatch test is weak (see NIT) but present.
- Phase 4: covered indirectly by existing `phase5-failure-modes` reload tests (not net-new here).
- Phase 5: "comment-deletion gate" + strip pin (real source scans).
- Phase 6: `cron-liveness.test.ts` — 7 real assertions on `evaluateCronLiveness`/`scheduleIntervalMs` (overdue, within-interval, young-never-fired, disabled, wake-skip, 30m parse). Genuine unit tests.

### 9. TEST-FAILURE CLAIM VERIFICATION — PASS (static)
Builder claim: 2886 pass / 16 fail = 14 dashboard better-sqlite3 ABI + 1 concurrent-cron-mutations pinned + 1 phase5 FM-9 flaky.
- **14 dashboard failures**: `dashboard/` is a separate Next.js app with its own `better-sqlite3` native dep; ZERO dashboard files are in the 13-file diff. Environmental ABI mismatch, unrelated to this change. VERIFIED pre-existing.
- **concurrent-cron-mutations**: file NOT in the diff. On `main` it is already titled `"... (pinned, expected to FAIL pre-fix)"` and guarded `describe.skipIf(!existsSync(DIST_CLI))`. Documents a lost-update race this OBF does not claim to fix. VERIFIED pre-existing, not a regression.
- **phase5-failure-modes FM-9**: file NOT in the diff (unchanged by branch). FM-9 exercises `scheduler.reload()` during an in-flight fire under `vi.useFakeTimers` with a real `setTimeout(...,60_000)` inside `onFire` — a known fake-timers/microtask ordering hazard; the `fired.push` timing is what flakes, not a schedule-correctness assertion. MY READ: genuine test-infra flake, NOT a masked regression. One caveat below (CONCERN, non-blocking).

No failing test is inside a changed file — so none of the 16 is a real regression in this diff.

### 10. Scope-creep — PASS
- `agent-pty.ts` NOT touched (confirmed absent from diff).
- No `dashboard/` files, no files beyond the declared 13.
- Every changed file maps to a declared phase. No silent extras.

---

## BLOCKING-ISSUES
(none)

---

## NON-BLOCKING-NITS

1. **Stale scanner suggestion points to a non-existent command.** `cron-teaching-scanner.ts:81` now tells users: *"One-shot reminders: 'cortextos bus add-reminder'."* There is NO `add-reminder` command — the real one is `create-reminder` (bus.ts:3528). Users following this teaching string will hit "unknown command." Fix: change the string to `cortextos bus create-reminder`. (User-facing incorrectness, but cosmetic — a teaching hint, not a code path.)

2. **Stray CJK characters in a test comment.** `tests/unit/cli/cron-register-reliability.test.ts:7`: `"...by importing尔斯 resolveActiveInstance"` — garbage bytes (`尔斯`) injected mid-comment. Compiles (inside `//`) but is sloppy; strip it.

3. **Weak instance-mismatch test.** The "instance mismatch predicate" describe block in `cron-register-reliability.test.ts` asserts only `typeof marker === 'string'` and the tautology `marker === marker`. It does NOT exercise `warnOnInstanceMismatch` producing a warning or the `--strict-instance` exit. The real logic (bus.ts:172) is untested behaviorally. Non-blocking because the strip/comment/kb tests in the same file are real, but this one is near-vacuous.

4. **Dead sub-clause in assertCronSchedulerLive.** `extractNextFireTimes` returns `NextFireEntry[] | null` (never `undefined`), so `if (!resp.success || times === undefined)` (bus.ts) — the `times === undefined` half is always false; the branch reduces to `!resp.success`. Harmless (the `null` case is caught one line above) but the dead check should be removed for clarity. The later `times ?? []` is likewise unreachable-null defensive code.

5. **CONCERN carried as a nit — tick() mtime-heal is new code FM tests exercise.** Phase 4 adds a `statSync`/`existsSync` + possible `loadCrons(true)` at the TOP of every `tick()`. FM-9 and sibling reload tests write crons.json (bumping mtime) then call `reload()`; the new tick-heal is an ADDITIVE reload (makes schedule more current, cannot drop entries), so `getNextFireTimes()` assertions still hold — but this path is only proven statically here. Recommend a real `npm test` run of `tests/integration/phase5-failure-modes.test.ts` post-build to confirm FM-9's flake rate is unchanged by the new tick I/O and not newly induced. Static reasoning says benign; a build-run would close it.

6. **OBF planning artifacts not committed.** The 02-master-plan + 03-specs were untracked and are now gone from the shared checkout; 9f6b501 ships only code + tests. Commit the plan/specs (or confirm they live elsewhere) so the build is auditable against its spec. Process nit.
