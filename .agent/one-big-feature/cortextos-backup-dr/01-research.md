# Clearworks cortextOS Backup & DR — Current-State Research

## Evidence collected 2026-08-21 PDT

- Legacy backup directory contains six archives. Five pass `gzip -t`: 2026-07-23, 07-24, 07-26, 07-29, and 07-30. The 2026-07-31 archive is truncated and fails integrity.
- The legacy log ends at the start of the failed 2026-07-31 run. No later successful receipt exists.
- No backup entry exists in current cortextOS daemon crons, user crontab, or LaunchAgents.
- `restic` is not installed. Time Machine reports no configured destination.
- Existing archives are local-only on the same Mac.
- The legacy hot-state script includes cortextOS runtime state, tasks, approvals, deliverables, RAG data, agent state, org files, config/env, and Claude project transcripts.
- The legacy script globally excludes `*/logs`, omitting message/event history, and does not include `~/.codex`.
- GitHub contains pushed tracked repository state, but local main is diverged and has dirty/untracked state, so it is not a current full recovery source.
- No separate proven business-platform-data backup or recent restore-test receipt was found.
- 1Password contains `Cloudflare Entire Account Cortext API` and its account ID. Read-only R2 bucket listing with that token returns HTTP 403, proving the existing token currently lacks effective R2 permission.

## Design conclusions

- Use restic encryption and object storage rather than large local tar archives.
- Preserve the five good legacy archives until the replacement has a green offsite backup and restore receipt.
- Cover full framework source plus `~/.cortextos`, `~/.claude`, and `~/.codex` with a denylist.
- Do not globally exclude logs.
- Keep framework and business-data profiles separate.
- Do not register production crons before repository credentials and an initial backup/restore round trip are green.
