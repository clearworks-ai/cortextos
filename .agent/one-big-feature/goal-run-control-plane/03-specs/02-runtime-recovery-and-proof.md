# Runtime Recovery and Live-Proof Specification

## Scope

This document remediates the durable `/goal` runtime only. It does not change native
fallback behavior, task policy, git approval policy, or any client production system.

## Required behavior

### Durable ingress

- `/goal <objective>` writes one atomic run record before responding with
  `[goal] queued <run-id>`.
- The default repository is the app-server's real project CWD. A documented explicit
  project/worktree option may be used only after absolute-path validation and must be
  persisted in the run receipt.
- A goal created from an agent control directory must not silently run the default
  project checks there. It must require an explicit repository binding or enter a
  recoverable `needs_human` state with a durable reason.

### Turn lifecycle

- Persist a `turn_started` receipt with the goal run and thread identifiers before
  dispatching work.
- A goal turn completion is correlated by the dedicated thread and turn identifiers.
  Unrelated interactive turns cannot advance the goal.
- Only the correlated terminal completion may append `turn_completed` and transition
  to `verifying`.
- The lease is renewed while a goal turn is outstanding. Timeout, process loss, or
  missing completion leaves the run recoverable; it must not be verified or marked
  done.

### Scheduler and recovery

- A bounded daemon-owned cadence processes each enabled agent's queued,
  retry-wait-ready, and expired-lease runs. It cannot require a second slash command.
- Startup performs the same bounded recovery pass after goal storage is initialized.
- A run is not processed concurrently with an interactive turn for the same PTY.
- Restart recovery resumes the stored dedicated goal thread and preserves the run
  event sequence, ownership rules, and explicit repository/worktree binding.

### Verification and proof

- Checks run only after the matching goal turn completion and always use `run.repo`.
- Required check stdout/stderr and exit results are stored as run artifacts.
- Completion requires all required checks to pass; otherwise the run remains
  recoverable or has a durable blocker reason.
- The implementation must add tests for ingress persistence, path binding, completion
  correlation, premature-verification prevention, periodic processing, restart
  recovery, lease renewal/reclaim, and an end-to-end receipt from create through
  verification.

## Non-goals

- No automatic git push, PR merge, deployment, credentials change, or destructive
  operation.
- No replacement of independent Alloi, fleet, Fireflies, Google, SEIU, Multica, or
  Zoom workstreams.
