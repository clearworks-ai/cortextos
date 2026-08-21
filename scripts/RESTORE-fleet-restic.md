# cortextOS Fleet Restic Backup & Disaster Recovery

This runbook covers the encrypted replacement for the legacy same-Mac tar
archives. The scripts are intentionally **not scheduled or activated by this
repository change**. Keep the five intact legacy archives until an offsite
snapshot and a restore from that snapshot are both green.

## What is protected

The framework profile is denylist-first and includes every descendant of:

- `/Users/joshweiss/code/cortextos` — working source plus root manifests
- `/Users/joshweiss/.cortextos` — daemon state, logs, messages, crons, tasks,
  approvals, deliverables, RAG data, and agent state
- `/Users/joshweiss/.claude` — project transcripts and CLI state
- `/Users/joshweiss/.codex` — sessions, skills, config, and cross-session state

The small exclusion file removes only rebuildable dependencies/build output,
disposable worktrees/caches, Git object databases, sockets, and PID files. It
does **not** exclude logs, messages, manifests, config, Claude transcripts, or
Codex state. The restored source tree is therefore sufficient to install and
build even when the Git host is unavailable.

The optional business profile reads a separate operator-maintained paths file,
uses a separate config/repository/password namespace, and writes a separate
ledger. Empty business coverage is an error.

## Prerequisites and activation gate

Install `restic` and ensure `python3` is available. Create a private object
storage bucket and repository only under an approved operator change. Do not
register backup crons until all of these are green:

1. Repository credentials have the required bucket permission.
2. `restic init` succeeds without exposing credentials.
3. A real offsite framework backup succeeds.
4. The snapshot restores into an empty scratch directory.
5. Sentinel verification and the morning audit are green.

No credential, bucket, cron, or runtime mutation is performed by the checked-in
tests or by merely installing these scripts.

## Operator configuration

Use one mode-0600 file per profile:

```text
~/.config/cortextos/fleet-restic-framework.env
~/.config/cortextos/fleet-restic-business.env
```

Example structure (place real values only in the external file):

```bash
RESTIC_REPOSITORY='s3:https://<account-endpoint>/<private-bucket>'
RESTIC_PASSWORD_FILE='/absolute/path/to/mode-0600/restic-password'
AWS_ACCESS_KEY_ID='<operator-materialized-value>'
AWS_SECRET_ACCESS_KEY='<operator-materialized-value>'
CORTEXTOS_BACKUP_ALERT_CHAT_ID='<approved-private-chat-id>'
FLEET_RESTIC_MAX_AGE_SECONDS='129600'
```

Profile-specific values override the standard variables when present:

```bash
FRAMEWORK_RESTIC_REPOSITORY='...'
FRAMEWORK_RESTIC_PASSWORD_FILE='...'
BUSINESS_RESTIC_REPOSITORY='...'
BUSINESS_RESTIC_PASSWORD_FILE='...'
```

For business exports, copy
`scripts/fleet-restic-paths-business.example.txt` to
`~/.config/cortextos/fleet-restic-paths-business.txt` and add one absolute
export root per line. The framework roots and shared denylist live in:

- `scripts/fleet-restic-paths-framework.txt`
- `scripts/fleet-restic-excludes.txt`

The scripts never print the repository, password file contents, storage
credentials, full environment, or raw restic errors. Runtime state defaults to
`~/.cortextos/backup-dr` with mode 0700; JSONL ledgers use mode 0600.

## Initialize an approved repository

Load the external config without echoing it, then initialize once:

```bash
set -a
. ~/.config/cortextos/fleet-restic-framework.env
set +a
restic init
restic snapshots
```

Repeat with the distinct business config/repository if business exports are
required.

## Backup and retention

Coverage-only proof:

```bash
scripts/fleet-restic-backup.sh --profile framework --dry-run
scripts/fleet-restic-backup.sh --profile business --dry-run
```

Real run:

```bash
scripts/fleet-restic-backup.sh --profile framework
scripts/fleet-restic-backup.sh --profile business
```

Each profile has an atomic lock. A successful real run performs this sequence:

1. encrypted snapshot;
2. snapshot listing that contains the new ID;
3. `restic check --read-data-subset=5%`;
4. `forget --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune`.

Retention never runs after a failed backup, missing new snapshot, or failed
integrity check. A new snapshot is retained even if retention itself fails.

One atomic JSONL receipt is appended per run:

```text
~/.cortextos/backup-dr/framework-runs.jsonl
~/.cortextos/backup-dr/business-runs.jsonl
```

Receipts contain only timestamp, profile, status, snapshot ID, duration, host,
source-root count, integrity status, retention status, and a sanitized error
class.

## Morning audit

```bash
scripts/fleet-restic-audit.sh --profile framework
scripts/fleet-restic-audit.sh --profile business
```

The audit reports:

- `GREEN` only when the newest receipt is recent, successful, integrity-checked,
  and retention-complete;
- `MISSING` when no current receipt exists;
- `RED` when the newest run or verification failed.

Missing/red audits return non-zero and send a sanitized private alert only when
`CORTEXTOS_BACKUP_ALERT_CHAT_ID` is configured. Dry runs never count as green
production receipts.

## Safe scratch restore (default)

Choose a new, empty directory outside the repo and home root:

```bash
RESTORE_TARGET="$(mktemp -d /tmp/cortextos-restore.XXXXXX)"
scripts/fleet-restic-restore.sh \
  --profile framework \
  --snapshot latest \
  --target "$RESTORE_TARGET"
```

The command refuses `/`, `$HOME`, the cortextOS repository root, symlinks, and
non-empty targets. It verifies all four recovery sentinels:

1. restored framework `package.json`;
2. restored runtime logs or message history;
3. restored Claude projects/settings;
4. restored Codex sessions, skills, or config.

Re-run only verification against an existing scratch restore:

```bash
scripts/fleet-restic-restore.sh \
  --profile framework \
  --snapshot latest \
  --target "$RESTORE_TARGET" \
  --verify-only
```

Machine-readable restore receipts are written separately:

```text
~/.cortextos/backup-dr/framework-restore.jsonl
~/.cortextos/backup-dr/business-restore.jsonl
```

On a replacement machine, install Node, the package manager, process manager,
restic, and Python first. Restore into scratch, verify, then use the restored
source tree itself:

```bash
cd "$RESTORE_TARGET/Users/joshweiss/code/cortextos"
npm ci
npm run build
```

This recovery path does not require cloning from GitHub.

## Explicit in-place recovery

In-place restore is destructive and may overwrite newer tasks, messages,
configuration, or agent state. Prefer selective copying from the scratch
restore. If a full recovery is truly required:

1. Stop the cortextOS daemon/process manager.
2. Record the incident and chosen snapshot ID.
3. Set the one-command confirmation token.
4. Run restore with `--in-place`.
5. Re-run sentinel verification before restarting services.

```bash
export FLEET_RESTIC_IN_PLACE_CONFIRM=RESTORE_IN_PLACE
scripts/fleet-restic-restore.sh \
  --profile framework \
  --snapshot <reviewed-snapshot-id> \
  --target / \
  --in-place
unset FLEET_RESTIC_IN_PLACE_CONFIRM
```

Never run an in-place restore while the daemon is live.

## Local acceptance proof

The repository test uses a temporary local restic repository and synthetic
roots only. It proves dry-run behavior, real snapshot/check/retention, exact
restore coverage, exclusions, locks, receipts, audits, unsafe targets, missing
configuration, empty business roots, and retention gating:

```bash
bash -n scripts/fleet-restic-backup.sh \
  scripts/fleet-restic-audit.sh \
  scripts/fleet-restic-restore.sh \
  tests/fleet-restic-backup.test.sh
bash tests/fleet-restic-backup.test.sh
```

Do not delete or rotate the five good legacy archives until a real offsite
snapshot and an independently verified restore receipt exist.
