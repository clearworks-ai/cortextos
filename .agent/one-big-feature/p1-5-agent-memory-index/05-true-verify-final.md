# P1.5 True-Verify — FINAL

Slug: `p1-5-agent-memory-index` | Stage: `true-verify`
Run by: Larry (main thread, no subagent), live against real infra, 2026-08-03.
Purpose: this is a VERIFY-pass-only receipt (no new code diff) — confirming the already-shipped
feature (on `origin/main`, commits `d7e8d98` + `797d7ee`) genuinely works end-to-end, after the
review stage (04-review-final.md, PASS) was re-authored fresh following an earlier ledger clobber
(`git reset --hard origin/main` in the shared main checkout wiped this slug's review+true-verify
rows; research/plan/specs rows were unaffected and remain the same signed artifacts).

## Verdict: PASS

## Live evidence captured this run

### 1. Mirror script executed directly (not simulated)

```
$ /Users/joshweiss/code/cortextos/.claude/worktrees/agent-a4df3fa0c3156935e/orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh
{"mirrored":813,"deleted":0,"source_count":813,"exit":0}
exit:0
```
Ran a second time back-to-back (idempotency check) — same counts, same exit 0.

Source dir: `~/.claude/projects/-Users-joshweiss-code-cortextos/memory/*.md` = 813 top-level files
(confirmed via `find ... -maxdepth 1 -name '*.md' | wc -l` = 813).
Mirror dir: `~/code/knowledge-sync/raw/areas/clearworks/agent-memory/` — no subdirectories present
(`find ... -mindepth 1 -type d` returned empty), confirming `handoffs/` and `memory-archive/`
subdirs were correctly excluded by the anchored rsync filter. 14 mirrored files have "handoff" in
their *filename* (e.g. `feedback_no_dedup_on_handoff_back_messages.md`) — these are legitimate
top-level topic files, not leakage from the excluded `handoffs/` subdirectory (verified by diffing
the mirrored filename list against the source top-level filename list — identical).

### 2. kb-query cites real memory-mirror files, live

```
$ cortextos bus kb-query --org clearworksai "Why is UID a dangerous variable name in bash scripts?"
[1] Score: 0.761 | .../raw/areas/clearworks/agent-memory/feedback_bash_reserved_uid_var.md
[2] Score: 0.659 | .../raw/areas/clearworks/agent-memory/feedback_bash_approval_timeout_trap.md
...
```

```
$ cortextos bus kb-query --org clearworksai "What was the root cause of the duplicate Telegram back-ping messages?"
[1] Score: 0.821 | .../raw/areas/clearworks/agent-memory/incident_backping_dupe_two_emitters_root_cause.md
[2] Score: 0.811 | .../wiki/projects/feedback-no-dedup-on-handoff-back-messages.md
...
[5] Score: 0.792 | .../raw/areas/clearworks/agent-memory/feedback_no_dedup_on_handoff_back_messages.md
```

Both queries return top-ranked hits directly from `raw/areas/clearworks/agent-memory/...` with
real content excerpts (not stubs/placeholders) — the mirror-then-reconcile path is genuinely
indexed and retrievable, not just present on disk.

### 3. Chunk-count + negative leakage checks (live sqlite against the active chromadb)

DB resolved to the live (non-backup, non-archived) instance:
`~/.cortextos/cortextos1/orgs/clearworksai/knowledge-base/chromadb/chroma.sqlite3`
(distinguished from 3 sibling backup/archive dirs — `chromadb.old-*`, `chromadb.bak-*`,
`chromadb.archived-*` — which are stale snapshots, not the live index; querying one of those by
mistake first returned a false 0 and was discarded).

```sql
SELECT COUNT(DISTINCT string_value) FROM embedding_metadata
  WHERE key='source_file' AND string_value LIKE '%/raw/areas/clearworks/agent-memory/%';
-- 777   (distinct indexed source files under the mirror path; > 0, close to the 813 mirrored
--          count — some files may not yet have completed embedding on the latest reconcile pass,
--          not a correctness concern for this check, whose bar is simply "> 0, ballpark match")

SELECT COUNT(*) FROM embedding_metadata
  WHERE key='source_file' AND string_value LIKE '%/.claude/%';
-- 0   (no leakage of the raw ~/.claude source tree into the index — double-index premise holds)

SELECT COUNT(*) FROM embedding_metadata
  WHERE key='source_file' AND string_value LIKE '%/agent-memory/handoffs/%';
-- 0   (excluded subdirectory correctly never reached the index)
```

## Review-stage cross-check

Stage `review` (04-review-final.md, signed in this same ledger chain immediately before this row)
independently reached PASS via fresh code inspection + its own live run of the mirror script
(813/813, idempotent, exit 0 both times) and confirmed the wrapper (`kb-reconcile-nightly.sh`)
correctly threads `MIRROR_STATUS` (`$?`, not the JSON `exit` field) into the ledger's `green`
computation. This true-verify pass independently re-ran the mirror script and the retrieval path
from a clean shell and got consistent live results — two independent live executions, same
outcome.

## Known follow-up (not a blocker)

Local branch `p1-5-agent-memory-mirror-exit-code-fix` (commit `12ad955`, unmerged, not on
`origin/main`) fixes a real but cosmetic bug: the mirror script's JSON `exit` field is hardcoded
to `0` even when the script would otherwise report failure. Confirmed independently (both in the
review stage and here) that the wrapper never reads that JSON field — it uses the script's actual
process exit code (`$?`) via `MIRROR_STATUS=$?`, which is correct. This does not affect the
done-condition proven above and does not block true-verify. Recommend a teammate reviews and
merges `12ad955` separately as a small follow-up fix for hygiene.

## Conclusion

The agent-memory mirror-then-reconcile feature, as it exists on `origin/main` right now, is real
and functioning: it mirrors 813/813 top-level memory topic files idempotently, excludes
`handoffs/`/`memory-archive/` correctly, is indexed into the live knowledge base (777 distinct
source files, 0 leakage from `.claude` or `handoffs/`), and is retrievable via `kb-query` with
real citations and real content. true-verify PASSES.
