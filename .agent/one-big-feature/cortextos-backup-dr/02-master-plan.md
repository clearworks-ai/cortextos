# Clearworks cortextOS Backup & DR — Master Plan

## Goal

Replace the stale same-Mac tar snapshots with an encrypted, observable, restorable backup system based on David's template and the fleet's real paths.

## Current-state evidence

- Five intact local archives exist from 2026-07-23 through 2026-07-30; the 2026-07-31 archive is truncated.
- The old job is not registered in cortextOS crons, user crontab, or LaunchAgents.
- No Time Machine destination, restic install/repository, or offsite backup currently exists.
- The old script excludes all `*/logs` and omits `~/.codex`, so it does not cover full message/event history or Codex state.
- The existing inclusive Cloudflare API token returns HTTP 403 for R2 bucket listing and needs R2 permission added before activation.

## Workstreams

1. Framework/infra backup
   - Restic-encrypted offsite repository.
   - Denylist-first roots: full cortextOS source, `~/.cortextos`, `~/.claude`, and `~/.codex`.
   - Preserve logs, messages, events, manifests, config, and runtime state.
   - Exclude only rebuildable caches/build output and live sockets/PIDs.

2. Business-data backup
   - Separate repository configuration and ledger.
   - Config-driven export roots so CXPortal/knowledge-sync exports can be added without coupling failure to fleet recovery.

3. Verification and retention
   - `restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune`.
   - `restic check --read-data-subset=5%` after each successful snapshot.
   - Atomic JSONL receipt with snapshot ID, profile, source roots, status, sizes, and timings.

4. Monitoring
   - A separate audit command checks the previous expected receipt and alerts only on a missing/red run.
   - Backup failure never prunes a prior good snapshot.

5. Recovery
   - Non-destructive restore into a new temporary directory by default.
   - Verify required sentinels, source manifests, runtime state, message logs, Claude state, and Codex state.
   - In-place restore requires an explicit flag and operator confirmation.

## Gates

- Local scripts, tests, dry-run coverage proof, and a local restic round-trip must pass before scheduling.
- Offsite bucket/repository initialization requires the existing Cloudflare token to gain R2 permission.
- The legacy five good snapshots remain untouched until an offsite snapshot and restore verification are green.

## Delivery

- Production source changes through Codexer.
- Larry reviews the diff, installs restic, performs local round-trip proof, activates offsite storage/config, registers daemon crons, proves first run, and records the restore receipt.
