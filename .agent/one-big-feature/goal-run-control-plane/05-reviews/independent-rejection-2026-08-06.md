# Independent Review — REJECT

Status: REMEDIATION REQUIRED

## Findings to close

1. Validate opaque generated run IDs and agent path segments at every store boundary; resolve paths and prove containment beneath `goal-runs/<agent>`; verify persisted `run.agentName` and `run.id` match the requested record. Add `/goal clear` and `/goal resume` traversal/cross-agent regressions.
2. Recover an all-items-done `verifying` run by rerunning final verification/audit under its lease. Add crash-boundary tests after last-item persistence and after final-check persistence.
3. Give the independent reviewer the verbatim overall objective, exact item text, implementation receipt and artifacts, evidence/check receipts, and unresolved findings. Set the reviewer thread goal. Assert the full reviewer contract in tests.
4. Preserve `worktree || repo` on thread creation and resume; never substitute the interactive PTY cwd for a persisted run location. Add create/restart worktree propagation tests.
5. Verifier shutdown must terminate the spawned process group, wait a bounded grace period, escalate to `SIGKILL`, and allow the scheduler to release/recover the lease. Test with a real SIGTERM-resistant child and grandchild.

## Required gates

- Original 121 focused tests remain green.
- New security, crash, reviewer-context, worktree, and resistant-process regressions pass.
- Typecheck, build, and `git diff --check` pass.
- Fresh independent review must return PASS before commit/PR.
