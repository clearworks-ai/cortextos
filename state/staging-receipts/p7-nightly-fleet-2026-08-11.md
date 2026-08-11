# P7 staging receipt — nightly fleet deterministic core + thin verify

Date: 2026-08-11

Scope: P7 staging validation only. No production cron was changed or fired.

## Isolation

- Instance pinned as `CTX_INSTANCE_ID=cortextos-staging`.
- CWD/framework root: `~/.cortextos/cortextos-staging-fw`.
- The read-only fleet inputs were copied into
  `~/.cortextos/cortextos-staging/fixtures/nightly-fleet-2026-08-11`.
- The staging tree has no org secrets or activity-channel credentials.
- Script under test: `orgs/clearworksai/agents/frank2/scripts/nightly-fleet-scan.py`
  from merged PR #355.

## Deterministic parity

Both the live read-only tree and its isolated staging snapshot were scanned with the same explicit
anchor, agent set, and script:

- Anchor: `2026-08-11T08:00:45.896Z`
- Agents: `frank2,maven,auditos,sage,muse,larry,sre`
- Result: byte-equivalent JSON (`true`)
- Candidate count: prod input `5`; staging snapshot `5`

Candidates passed to the thin verifier (and only these rows, never raw logs):

| Candidate | Deterministic evidence |
|-----------|------------------------|
| frank2 `silent_agent` | heartbeat age 125.8h |
| larry `silent_agent` | heartbeat age 125.8h |
| maven `silent_agent` | heartbeat age 24.3h |
| sage `silent_agent` | heartbeat age 24.3h |
| muse `crash_loop` | count 6; latest `2026-08-11T06:52:26.385Z` |

## Thin verification

The verifier checked current agent status and the legacy `nightly-fleet-analysis` rules.

| Candidate | Verdict | Why |
|-----------|---------|-----|
| frank2 | REJECT | Disabled legacy identity; `frank2-codex` is enabled/running. |
| larry | REJECT | Disabled legacy identity; `larry-codex` is enabled/running. |
| maven | REJECT | Disabled legacy identity; `maven-codex` is enabled/running. |
| sage | REJECT | Disabled legacy identity; `sage-codex` is enabled/running. |
| muse | REJECT | Three `exit_code=1` events were counted twice across `restarts.log` and `crashes.log`; there were zero `WATCHDOG-HARD-RESTART` events, and Muse is currently running. |

Final surviving candidates: `[]`.

Legacy same-input decision: `[]`. The legacy prompt defines crash-loop as more than two
`WATCHDOG-HARD-RESTART` events in 24h and standing fleet semantics exclude intentionally disabled
identities after live-status verification. Final decision parity therefore PASSED.

## Non-blocking scanner-noise finding

`nightly-fleet-scan.py` uses `_CRASH_TOKENS = WATCHDOG-HARD-RESTART|CRASH|type=crash` and reads both
`restarts.log` and `crashes.log` without cross-file event deduplication. That produces a broader,
duplicated candidate set than the legacy watchdog-only detector. The thin verifier removed the
noise and preserved final-decision parity, so the staged flow passed; the detector can be tightened
before or after rollout as a separate efficiency hardening change.

## Gate

- Staging candidate/input parity: PASS.
- Thin-verifier final-decision parity: PASS.
- Production `cortextos bus update-cron`: NOT RUN (Josh-gated).
