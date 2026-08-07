# Runbook
- Health check: create one test task and confirm it is visible to the target user.
- Common failure mode: task created but hidden. Cause: state mismatch. Fix: inspect active/visibility flags before retrying.
- Safe replay: rerun with the isolated test channel first, then promote to the live path.
- Escalation: do not edit credential mappings live without the builder; escalate if visibility remains broken after one verified retry.
