# Spec 01 — Encrypted Fleet Backup and Disaster Recovery

## Operator interfaces

- `scripts/fleet-restic-backup.sh --profile framework|business [--dry-run]`
- `scripts/fleet-restic-audit.sh --profile framework|business`
- `scripts/fleet-restic-restore.sh --profile framework|business --snapshot latest --target <dir> [--verify-only]`
- `scripts/fleet-restic-paths-framework.txt`
- `scripts/fleet-restic-excludes.txt`
- `scripts/fleet-restic-paths-business.example.txt`
- `scripts/RESTORE-fleet-restic.md`

## Configuration contract

Configuration is read from a mode-0600 operator file outside git. The scripts must support standard restic variables without printing secrets:

- `RESTIC_REPOSITORY`
- `RESTIC_PASSWORD_FILE`
- S3/R2 access variables when that backend is used
- Optional profile-specific repository/password overrides
- `CORTEXTOS_BACKUP_ALERT_CHAT_ID`

Credentials may be materialized from 1Password by the operator wrapper, but must never be committed, logged, or emitted in receipts.

## Framework coverage

Required roots:

- `/Users/joshweiss/code/cortextos` including source and root manifests
- `/Users/joshweiss/.cortextos` including logs, message history, daemon state, crons, tasks, approvals, deliverables, RAG data, and agent state
- `/Users/joshweiss/.claude` including project transcripts and relevant settings
- `/Users/joshweiss/.codex` including sessions, skills/config, and cross-session state

The implementation is denylist-first. Exclusions may cover node_modules, build output, worktrees, package caches, browser binaries/caches, sockets, PIDs, and other provably rebuildable content. It must not globally exclude logs, message history, config, manifests, or CLI session state.

## Business profile

- Reads an operator-maintained paths file.
- Uses a distinct restic repository/password/config namespace and ledger.
- A missing/empty business paths file is a hard, explicit non-zero result, not a green no-op.

## Safety and concurrency

- Atomic lock directory prevents overlapping same-profile runs.
- Trap removes locks and temporary files.
- Backup and check must not mutate source paths.
- Retention/prune runs only after a successful backup and successful snapshot listing.
- Logs and ledgers redact environment values and repository credentials.

## Receipts

Append one atomic JSONL row per run with UTC timestamp, profile, status, snapshot ID, duration, host, source-root count, integrity status, retention status, and sanitized error class. Never store secrets or full command environments.

## Restore behavior

- Default target must be an empty caller-provided directory.
- Refuse `/`, `$HOME`, `~`, repository root, or a non-empty directory unless an explicit in-place recovery mode is supplied.
- Verify restored sentinels for framework source, cortextOS runtime/message history, Claude state, and Codex state.
- Produce a machine-readable verification receipt.

## Tests

- Shell syntax/static checks.
- Temporary local restic repository round trip with fixtures representing all four required roots.
- Exclusion proof: rebuildable fixtures excluded; logs/messages/manifests/Codex and Claude state restored.
- Lock/concurrency, missing configuration, failed backup, retention gating, audit missing/red/green, and unsafe restore-target tests.
- No real credentials or production paths in tests.

## Scheduling

After offsite proof, register daemon-managed crons:

- Framework backup daily off-peak.
- Business backup daily at a separate time.
- Morning backup audit after both expected completion windows.

Do not register a cron that can only fail before credentials and repository initialization are green.
