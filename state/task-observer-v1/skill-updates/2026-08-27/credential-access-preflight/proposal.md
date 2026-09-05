# Staged Bootstrap/Skill Improvement Proposal

## Root cause

Unattended agents have inconsistent 1Password routing instructions. Governing
evidence shows the daemon held a scoped service-account token while the agent
subprocess did not inherit it; interactive signin and desktop/biometric fallback
were therefore the wrong paths. A bounded one-command token injection succeeded.
The shared env-management skill currently provides no 1Password/service-account
guidance.

## Proposed changes after review

1. Add the staged `credential-access-preflight` skill to the shared internal
   agent bundle.
2. Add a short bootstrap rule: unattended agents must use service-account routing,
   never interactive `op signin` fallback.
3. Implement or designate one reviewed platform wrapper that injects the daemon
   token into a single child-command environment without printing or persisting it.
4. Add typed audit events for token-presence boolean, identity verification,
   bounded operation class, and failure/handoff.

## Non-actions

This proposal does not install a skill, edit bootstrap files, change runtime or
configuration, broaden vault access, or expose credential values.

