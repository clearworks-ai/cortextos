# P7 live receipt — nightly fleet deterministic-core cron rewire

Date: 2026-08-11

## Authorization

- Josh explicitly approved P7 in the active Codex chat at 09:13 PDT.
- Approval: `approval_1786436408_3w2la` → `approved`.
- Execution task: `task_1786436393744_35834600` → `completed`.

## Correct live target

The program spec named the legacy `frank2` cron. Live inspection before mutation found:

- `frank2`: disabled and not running; its stale cron had not fired since 2026-08-05.
- `frank2-codex`: enabled and running; canonical owner of the active
  `nightly-fleet-analysis` cron, with schedule `3 2 * * *` and seven prior fires.

The approved functional P7 rewire was therefore applied to
`frank2-codex/nightly-fleet-analysis`. The disabled legacy row was not changed.

## Change

- Operation: `cortextos bus update-cron frank2-codex nightly-fleet-analysis --prompt <P7 prompt>`
- Instance pinned on every call: `CTX_INSTANCE_ID=cortextos1`.
- CWD/framework root: `/Users/joshweiss/code/cortextos`.
- Schedule preserved: `3 2 * * *`.
- Enabled state preserved: `true`.
- Fire count/history preserved: seven prior fires; no manual fire.
- New prompt: `p7-nightly-fleet-cron-2026-08-11.prompt.txt`.
- New prompt SHA-256: `cb76ef497c93d15fc79474786e8730d78eedc40cc7c8e19fc1af064f84c219f5`.
- Rollback prompt: `p7-nightly-fleet-cron-2026-08-11.rollback-prompt.txt`.
- Rollback SHA-256: `c0cf76e9aaa62ab539e17c04d94b04e7a7e4c201ef1c296740f538305510cafa`.

The prompt now:

1. discovers only enabled canonical Clearworks agents;
2. runs merged `nightly-fleet-scan.py` once over the fleet;
3. stops without an LLM when there are zero candidates;
4. passes only candidate JSON + current registry JSON to one bounded verifier;
5. rejects disabled identities, deduplicates cross-log crash rows, and requires more than two
   distinct `WATCHDOG-HARD-RESTART` events for a crash-loop finding;
6. preserves the existing severity routing and approval gates.

## Live scheduler verification

The current CLI wrote the prompt, then conservatively exited non-zero because the running daemon's
older reload response does not include the newer `nextFireTimes` verification field. The daemon's
own ordered log provides stronger direct evidence of the actual result:

```text
1722812: [ipc] reload-crons frank2-codex from cortextos bus cron-cmd
1722813: [daemon] [cron-scheduler] reloaded for agent "frank2-codex" — 15 cron(s) active
1722814: [agent-manager] Cron scheduler reloaded for frank2-codex
```

Post-write readback proved the persisted prompt exactly matches the approved artifact (same
SHA-256), contains the deterministic script invocation, contains the raw-log guard, and contains
the zero-candidate no-verifier exit.

The daemon was not restarted:

- PM2 process: `cortextos-daemon`, PID 427, online.
- Uptime unchanged: `2026-08-11T06:52:27.545Z`.
- Restart count unchanged: 3.

The next natural schedule is 2026-08-12 at 02:03 PDT. No manual test-fire was performed because
the approval covered the rewire, not an extra production analysis run.

## Pre-rollout staging evidence

See `state/staging-receipts/p7-nightly-fleet-2026-08-11.md`: isolated input parity and thin-verifier
final-decision parity both passed before this production change.

## Verdict

P7 DONE: staging parity passed, Josh approved the gate, the canonical production cron was rewired,
the running scheduler reloaded it, rollback is preserved, and no daemon restart occurred.
