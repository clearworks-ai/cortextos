# RESTART CHECKPOINT — Chroma safe recovery

Written: 2026-08-24 13:17 PDT  
Reason: computer restart imminent. No new work started. No running commands to abort.

## HEAD

- Branch: `feat/cortextos-backup-dr`
- Tracking: `origin/feat/cortextos-backup-dr` **ahead 11** (not pushed)
- HEAD: `ba8ee066a25ad64a0351353dbdb950ed2ae4a9ec`
- HEAD subject: `feat(mmrag): add fixture-only drain and write-once KB surface backup`

Recovery lineage at HEAD (newest first):

1. `ba8ee066` FR-016 fixture drain + write-once backup
2. `408d361d` FR-015 side embedding-cache isolation
3. `5e5c528e` I1 fail-closed `PersistentClient` factory hold
4. `69d0fa63` reviewed recovery spec (preserve)
5. `e5c78ad4` initial recovery spec

## Spec (do not rewrite)

- Path: `state/specs/mmrag-chroma-safe-recovery-2026-08-24.md`
- Commit: `69d0fa63`
- SHA-256: `c7abed485df222ad1a44857c76377f8565318f7b470bf37a0bde47c105bd3dfa`
- Status: document `converged`. **Not** live authority.

## Current slice

FR-015 and FR-016 are **already committed**. Working-tree dirt below is **unrelated** and was left uncommitted on purpose (not this slice; not tested as part of it). No extra commit made for this checkpoint.

## Last test result

```
cd knowledge-base/scripts && python3 -m pytest \
  _test_clients/test_mmrag_drain_backup.py \
  _test_clients/test_mmrag_side_embed_cache.py \
  _test_clients/test_mmrag_native_hold.py -q
# 22 passed in 1.82s  (2026-08-24, this session)
```

I1 vitest (earlier same session):

```
npx vitest run tests/unit/bus/knowledge-base.test.ts \
  tests/unit/bus/mmrag-dir-guard.test.ts \
  tests/unit/hooks/hook-retrieval-enforcer.test.ts
# 31 passed
```

`npm run build` succeeded after I1 (`5e5c528e`).

## Hard constraints (still in force)

- Do **not** create a live `NATIVE_HOLD`
- Do **not** open/mutate live Chroma (`~/.cortextos/cortextos1/orgs/clearworksai/knowledge-base/`)
- Do **not** edit crons
- Live epoch remains **human L0**
- Ignore invalid G5RT/G5RTC stop-token tests; do not repeat them
- Visible lane only

## Working tree (preserve; do not clean)

Modified, **not** part of recovery commits:

- `.cortextOS/state/agents/alice/crons.json`
- `.cortextOS/state/agents/alice/crons.json.bak`
- `orgs/clearworksai/skills/comms-check-worker/SKILL.md`
- `state/pipeline-ledger.jsonl`

Untracked, **not** part of recovery commits:

- `.agent-worktrees/`
- `.cortextOS/state/agents/bob/`
- `.data/`
- `.worker-inputs/`
- `community/skills/task-observer/`
- `state/specs/deterministic-fireflies-meeting-execution-spec-2026-08-11.md`
- `state/specs/mmrag-chromadb-native-crash-guard-2026-08-24.md`
- `state/specs/mmrag-chromadb-native-crash-guard-v2-2026-08-24.md`
- `state/specs/mmrag-chromadb-native-crash-guard-v3-2026-08-24.md`
- `state/task-observer-v1/`

## Live epoch

**Not started.** No live `NATIVE_HOLD`. No live backup. No cron freeze.

## Next command

After reboot, continue **fixture-only** FR-005 corpus inventory (same `_is_ignored` rules; no PersistentClient; no live sqlite):

```
cd /Users/joshweiss/code/cortextos
git status -sb
git log -5 --oneline
# implement FR-005 against tmp fixtures only; do not touch live chromadb or crons
```

Alternate next slice if inventory is deferred: FR-007 side-rebuild scaffolding (empty sibling dir; never `_rebuild_collection` against live).
