# FR-008 — client `.md` concurrent-writer conflict (design note, needs staging + Josh call)

**Status:** GAP found in chain-completion Phase 1 verification. NOT patched blind —
touches client-file data-plane → staging-first (non-negotiable).

## The gap
Two processes write `knowledge/clients/*.md` with **different models**:

| Writer | Model | Lock |
|---|---|---|
| `pa/scripts/meeting_writeback.py` | parse-sections → **append** one History row → `write_text` (RMW) | ✅ `client_file_lock` (`<file>.lock`, flock LOCK_EX, :40-58) |
| `frank2/scripts/sync_client_context.py` | **full rebuild** from CRM (`interactions.jsonl` + meetings + pipeline): unlink-all `.md` (:352-354) then `write_text` each (:377) | ❌ no lock |

The writeback lock only serializes writeback-vs-writeback. `sync_client_context` takes
no lock and does a destructive unlink-all-then-write, so:
1. **Torn-write / lost-append:** a writeback appending to `client-X.md` can interleave with
   sync's unlink+rewrite of the same file → the History append is lost.
2. **Semantic overwrite:** sync rebuilds History from `interactions.jsonl`. If crm-sync
   (FR-007) has already written the interaction, sync reconstructs it (safe, eventual
   consistency). If writeback's `.md` append lands before crm-sync writes the jsonl and a
   sync runs in between, that row is dropped until the next sync — a window, not permanent
   loss, **provided crm-sync always mirrors what writeback appends.**

## Why not a blind lock-add
Making both lock the same `<file>.lock` fixes (1). It does NOT resolve the deeper issue:
**two writers own the same file with conflicting models.** The clean design is a single
owner. That is an architecture decision for Josh.

## Options (validate the chosen one on `cortextos-staging` before prod)
- **A (recommended) — single owner:** `sync_client_context` owns the `.md` (rebuilt from
  CRM). `meeting_writeback` stops appending History directly to `.md`; it writes only CRM
  (`interactions.jsonl` via crm-sync FR-007) + the meeting doc. The `.md` History then always
  regenerates from the CRM source of truth. Removes the race entirely; one source of truth.
- **B — coexist + serialize:** keep both writers, make `sync_client_context` acquire the
  same per-file `client_file_lock` around each file's unlink+write (restructure away from
  unlink-all-upfront to per-file write-then-prune-stale). Fixes torn writes; leaves the
  redundant-model debt.

## Acceptance (either option)
- Staging: run a real meeting through the chain WHILE forcing a `sync_client_context` run;
  assert the meeting's History row survives in the client `.md` (no loss, no torn file).
- No `.md` is left missing during a sync (no unlink-gap window).

## Gate
Josh picks A or B → build on a branch → validate on `cortextos-staging` → prod only after
the daemon-restart gate.
