# Independent Review — PR #285 loop1-stage1-backping-triad-cut

Reviewer: independent pipeline review agent (session 8fba1c38-716e-45ba-bb95-6289455d6441).
Did NOT build this PR. Reviewed adversarially in an isolated git worktree
(`review-285-loop1` @ 2d2b4679, checked out from origin/loop1-stage1-backping-triad-cut).

## Verdict: PASS

Scope is exactly what the commit message claims and nothing more. No KEEP fix dropped.
Build + typecheck clean. Daemon suite green modulo one pre-existing env failure.

## Diff scope (verified)

`git diff origin/main...HEAD --name-only` = exactly 3 files:
- `src/daemon/handoff-backping.ts` (deleted)
- `src/daemon/agent-process.ts`
- `tests/unit/daemon/agent-process-opencode.test.ts`

## Removal verified

- `src/daemon/handoff-backping.ts` absent on disk. Confirmed fork-only:
  `git cat-file -e upstream/main:src/daemon/handoff-backping.ts` → ABSENT upstream.
- ZERO residual back-ping refs under `src/` (grep for
  back-ping|backping|BackPing|last-back-ping|shouldSuppressBackPing|
  writeLastBackPingMs|readLastBackPingMs|isHandoffBackPingSuppressed|
  newestInboundMessageMs|HANDOFF_BACKPING_SUPPRESS → 0 hits).
- back-ping token count in HEAD:src/daemon/agent-process.ts = 0, matching
  upstream/main:src/daemon/agent-process.ts = 0. Convergence confirmed.

## Logic equivalence (ternary simplifications — no bug introduced)

- `handoffUxOverride`: now `isHandoffRestart && systemPingsEnabled &&
  shouldPromptTelegram`. Old code additionally required `!isHandoffBackPingSuppressed()`;
  with the suppressor deleted, this is the correct plain gate.
- Startup `onlineMessage`: `isHandoffRestart || !systemPingsEnabled ||
  !shouldPromptTelegram ? '' : '...back online'` — the De Morgan of the intended
  positive gate; upstream plain shape. Correct.
- Continue `onlineMessage`: `systemPingsEnabled && shouldPromptTelegram`. Correct.
- handleExit handoff path: msg1 (planned-restart notif) only; opencode msg2 daemon
  self-send removed. Agent self-sends "back — ..." via the boot prompt for both
  codex and opencode. Correct — no orphaned send path.

## KEEP fixes — ALL PRESENT (adversarially checked; none dropped)

- 078a9a3 systemPings gate: `systemPingsEnabled()` returns
  `this.config.emit_system_telegram_pings === true` — PRESERVED (agent-process.ts:1218).
- #242 clean-exit + startup-failure guard: cleanExitRestarts / cleanExitStartupFailures
  present (agent-process.ts:125,137,882-900).
- isPlannedRestart handleExit exemption: present (handleExit call-sites intact).
- single-flight: `inFlightStart` guard present (agent-process.ts:163-233).
- disabled-resurrection: `isDisabled()` + readEnabledAgentsMap + no-respawn-while-disabled
  present (agent-process.ts:707-768).
- mission-anchor / live-tail: ensureMissionAnchorFromBuffer + buildResumeContextBlocks
  present.
- pty-host: getPtyHostPid + reaper wiring present.
- fast-checker: NOT touched by this PR (`git diff --quiet origin/main HEAD --
  src/daemon/fast-checker.ts` → unchanged). Its vs-upstream divergence is pre-existing
  fork state, out of scope for this cut.

No KEEP fix accidentally dropped. The 08-01 HALT crisis root (a dropped clean-exit /
resurrection / single-flight guard) is NOT re-created.

## Build + test results

- `npm run build` → Build success in 117ms. GREEN.
- `npx tsc --noEmit` → exit 0. GREEN.
- `npx vitest run tests/unit/daemon/` → 488 passed, 1 failed (489 total).
  - Sole failure: `rebaseline-runtime-gates.test.ts > D5(a) fd-leak gate`.
  - Cause: `node_modules/node-pty/build/Release/spawn-helper` MISSING on disk — the
    test's own precondition assertion refuses to false-pass without the prebuild
    ("node-pty spawn-helper prebuild is missing or not executable"). This is an
    environmental / infra failure in the pty spawn path, which this diff does NOT
    touch (3-file scope: handoff prompt strings + deleted module + test). It is the
    documented pre-existing env failure set (node-pty prebuild; dashboard routes).
- The 2 opencode handoff tests changed by this PR (+ the full opencode file, 12 tests)
  → all pass.

## Conclusion

PASS. Merge-eligible. Daemon-runtime change: do NOT deploy/pm2-restart (live-promote
is Josh's gate).
