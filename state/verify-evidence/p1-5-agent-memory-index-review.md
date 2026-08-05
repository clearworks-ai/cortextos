# P1.5 agent-memory-index — Independent Adversarial Review

**Verdict: PASS** (with one minor cosmetic defect noted, spec-permitted, non-blocking)

Reviewer: independent adversarial pass, everything below was actually run/read on
2026-08-03 against the live repo at `/Users/joshweiss/code/cortextos` (main, post-PR#193 merge).

## 1. Script structure vs spec

Read `orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh` (43 lines) in full and
compared line-by-line against `03-specs/01-agent-memory-mirror-spec.md` Step 1.

- Safety gate: `[[ ! -d "$SRC" ]]` then `find "$SRC" -maxdepth 1 -name '*.md' | wc -l` == 0
  both hard-exit 1 with `{"error":"source missing or empty","exit":1}` **before** `mkdir -p`
  or rsync ever run. Confirmed: `--delete` can never fire against a missing/empty source. Matches spec exactly.
- rsync invocation: `rsync -a --delete --include='/*.md' --exclude='*' "$SRC/" "$DST/"` —
  byte-identical to the spec's mandated command. Anchored `--include='/*.md'` + `--exclude='*'`
  is top-level-only, no recursion, no `--delete-excluded`/`--copy-links`/widened filters added.
- JSON output contract: `{"mirrored":N,"deleted":M,"source_count":K,"exit":0/1}` — confirmed
  by live runs (see §2).
- Exit logic: `if [[ "$RSYNC_STATUS" -ne 0 ]] || [[ "$MIRRORED" -ne "$SOURCE_COUNT" ]]; then exit 1; fi` —
  exit 0 only when rsync succeeded AND mirrored==source_count. Matches spec §Step 1.6 exactly.

## 2. Live double-run (idempotency)

```
$ /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh
{"mirrored":811,"deleted":0,"source_count":811,"exit":0}
exit=0

$ /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh
{"mirrored":811,"deleted":0,"source_count":811,"exit":0}
exit=0
```
Identical counts both runs, exit 0 both times. Idempotency requirement met. (Source has grown
from 743 at spec-write time to 811 today — organic memory growth, not a bug.)

## 3. Leakage checks (all passed)

```
$ ls ~/code/knowledge-sync/raw/areas/clearworks/agent-memory | grep -E '^handoff-'
(empty, grep exit 1)

$ ls ~/code/knowledge-sync/raw/areas/clearworks/agent-memory/*.json 2>&1
no matches found: .../agent-memory/*.json

$ diff <(ls ~/.claude/projects/-Users-joshweiss-code-cortextos/memory/*.md | xargs -n1 basename) \
       <(ls ~/code/knowledge-sync/raw/areas/clearworks/agent-memory/*.md | xargs -n1 basename)
(empty, diff exit 0)

$ find ~/code/knowledge-sync/raw/areas/clearworks/agent-memory -maxdepth 1 -type d
/Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/agent-memory   (only itself, no subdirs)
```
Confirmed source actually contains `handoffs/`, `memory-archive/`, and a top-level
`context-budget-baseline.json` — all three are correctly excluded from the mirror by the
anchored include/exclude filter. Exact filename parity between source and mirror. No feedback_*
or incident_* top-level topic files were misclassified as leakage (per task instructions).

## 4. kb-reconcile-nightly.sh integration

Read the full 174-line current file. Confirmed:

- **Step 0 does not abort the wrapper on mirror failure.** `MIRROR_STATUS=$?` is captured
  right after the mirror call; nothing checks/exits on it before Step 1 (reconcile) runs.
  Script uses `set -u` only (no `set -e`), so a non-zero `MIRROR_STATUS` cannot implicitly
  kill the script either. Reconcile and edges steps run unconditionally after Step 0 — matches
  spec's "mirror failure = red row = existing escalation path, not a hard abort."
- **`memory_mirror` correctly folded into `green`:** `green = (recon_status == 0 and
  edges_status == 0 and mirror_status == 0 and recon_stats["failed_files"] == 0 and
  recon_stats["delete_failures"][...] == 0 and edges_stats["errors"] == 0)` — `mirror_status`
  is one of the required ANDed terms, not decorative.
- **JSON parsing of MIRROR_OUT is robust and matches the RECON_OUT pattern exactly:** both use
  `JSONDecoder().raw_decode()` on the last line starting with `{`, wrapped in
  `try/except (json.JSONDecodeError, ValueError): ... = {}`. Same tolerant-fallback shape as
  the pre-existing RECON_OUT handling — no special-casing, no asymmetry.
- Ledger row composition includes `"memory_mirror": mirror_stats` with `status`, `mirrored`,
  `deleted`, `source_count` fields, using `.get(key, 0)` fallbacks against a possibly-empty
  `mirror_data` dict — won't KeyError on a malformed mirror output.

Live ledger evidence (tail of `orgs/clearworksai/agents/larry/state/kb-reconcile-ledger.jsonl`,
3 most recent rows as of this review):
```
{"ts":"2026-08-01T09:21:07Z", ..., "memory_mirror":{"status":0,"mirrored":760,"deleted":0,"source_count":760}, ..., "green":false}
{"ts":"2026-08-01T10:37:35Z", ..., "memory_mirror":{"status":0,"mirrored":760,"deleted":0,"source_count":760}, ..., "green":false}
{"ts":"2026-08-02T10:37:49Z", ..., "memory_mirror":{"status":0,"mirrored":777,"deleted":0,"source_count":777}, ..., "green":false}
```
`memory_mirror.status: 0` in every row (mirror component healthy). `green: false` in all three
is caused by `reconcile.failed_files: 3` in the same rows — a pre-existing, unrelated reconcile
issue, NOT introduced by or attributable to the P1.5 mirror code. Confirmed the `green` formula
is an AND over independent healthy/unhealthy components exactly as designed; mirror is not
masking or being masked by the other failure.

## 5. Live Chroma index evidence

```
DB=/Users/joshweiss/.cortextos/cortextos1/orgs/clearworksai/knowledge-base/chromadb/chroma.sqlite3

SELECT COUNT(DISTINCT string_value) FROM embedding_metadata
WHERE key='source_file' AND string_value LIKE '%/raw/areas/clearworks/agent-memory/%';
→ 777

SELECT COUNT(*) FROM embedding_metadata WHERE key='source_file' AND string_value LIKE '%/.claude/%';
→ 0

SELECT COUNT(*) FROM embedding_metadata WHERE key='source_file' AND string_value LIKE '%/agent-memory/handoffs/%';
→ 0
```
777 distinct agent-memory source files indexed (close to the 811 currently mirrored — some
staleness is expected since the last reconcile ran before today's growth to 811; this is
freshness lag, not a defect — reconcile runs nightly per cron). Zero `.claude` leakage, zero
`handoffs/` leakage in the index — matches the done-condition's negative checks exactly.

## 6. Live kb-query retrieval proof

```
$ cortextos bus kb-query --org clearworksai "What was the root cause of the duplicate Telegram back-ping messages?"

[1] Score: 0.821 | /Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/agent-memory/incident_backping_dupe_two_emitters_root_cause.md
[2] Score: 0.811 | .../wiki/projects/feedback-no-dedup-on-handoff-back-messages.md (source: raw/areas/clearworks/agent-memory/...)
[3] Score: 0.800 | .../wiki/projects/feedback-reworded-dupes-bypass-telegram-dedup.md (source: raw/areas/clearworks/agent-memory/...)
[4] Score: 0.799 | /Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/agent-memory/incident_backping_dupe_two_emitters_root_cause.md
[5] Score: 0.792 | /Users/joshweiss/code/knowledge-sync/raw/areas/clearworks/agent-memory/feedback_no_dedup_on_handoff_back_messages.md
```
Top hit (score 0.821) directly cites an `agent-memory/` path and answers the question
correctly (this exact incident is also independently documented in this session's injected
MEMORY.md, confirming the retrieved content is factually correct, not just topically similar).
Done-condition #3 satisfied with a real, unprompted query.

## 7. Git history / known-bug verification

```
$ git log --oneline -8 -- orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh
717393b fix(hooks): SESSION CONTINUATION prompts bypass retrieval-enforcer KB query (#243)   [unrelated, touches other logic in same file]
3b78005 Cleanup: remove debug instrumentation from kb-reconcile-nightly.sh
796c63b debug: add mirror_data instrumentation ...
797d7ee fix: mirror script JSON output - handle grep -c exit code correctly
d7e8d98 P1.5 agent-memory fold-in: mirror memory topic files into knowledge-sync + nightly ledger field
0884801 P1.1: kb-reconcile-nightly cron + wrapper script (#188)
```

Confirmed the specific bug and fix described in the task brief. Original code (in d7e8d98):
```bash
DELETED=$(echo "$RSYNC_OUTPUT" | grep -c "^*deleting" || echo "0")
```
`grep -c` on zero matches prints `"0"` to stdout **and** exits 1; the pipeline's exit status
is grep's exit status (1), so `|| echo "0"` fires too, appending a second `"0"` line —
`DELETED` becomes `"0\n0"`, a multi-line value that breaks arithmetic/JSON emission. Fixed in
797d7ee to:
```bash
DELETED=$(echo "$RSYNC_OUTPUT" | grep -c "^*deleting" 2>/dev/null || true)
if [[ -z "$DELETED" ]]; then DELETED=0; fi
```
`|| true` never re-emits anything, so `DELETED` is always exactly grep's single-line count (or
empty on a genuine failure, caught by the `-z` check). **Confirmed present and correct in the
current file** (read in full above, lines 30-33). The fix holds.

## 8. Real bug found: `deleted` count is structurally always 0 (minor, spec-permitted)

Verified empirically with an isolated `/tmp` rsync test (not touching real source/dest):
```
$ rsync -a --delete --include='/*.md' --exclude='*' /tmp/rsync-test-src/ /tmp/rsync-test-dst/ 2>&1
[]   ← empty output, even though stale.md was actually deleted from dst
```
`rsync -a` (archive mode) without `-v` or `-i`/`--itemize-changes` **never prints any output**
for transfers or deletions, even when files really are deleted. So
`grep -c "^*deleting"` against `$RSYNC_OUTPUT` will **always** return `0`, regardless of how
many mirror files are actually pruned by `--delete`. This is a real, structural inaccuracy —
`deleted` in the JSON contract is currently dead weight, not a computed value.

**Assessment: NOT a blocking defect.** The spec explicitly pre-authorizes exactly this
shortcut: *"Computing `deleted` exactly from rsync output is optional... correctness bar is
`mirrored == source_count`."* The correctness bar (`mirrored == source_count`, verified live in
§2) is met on every run. `deleted` is informational-only and was never part of the exit-code or
green-boolean logic (confirmed — `green` only checks `mirror_status`, not `mirror_stats.deleted`).
Recommend (non-blocking, future cleanup): switch to `rsync -a --delete -i ...` and grep for
lines starting with `*deleting` in the itemized output, or drop the field's pretense of
precision in a doc comment. Filed as observation, not required for this PASS.

## 9. Other robustness checks

- **Quoting/spaces-in-$HOME:** `$SRC`, `$DST` are quoted everywhere they're used (`[[ ! -d "$SRC" ]]`,
  `find "$SRC" ...`, `mkdir -p "$DST"`, `rsync ... "$SRC/" "$DST/"`, `find "$DST" ...`). Safe.
- **`mkdir -p "$DST"` failure handling:** not exit-code-checked, but a `mkdir -p` failure (e.g.
  permissions) would cause the subsequent rsync to fail loudly (`RSYNC_STATUS != 0`), which the
  exit-1 branch already catches. No silent-success-on-failure path found.
- **Stray non-.md files in $DST:** the anchored `--include='/*.md' --exclude='*'` filter scopes
  both transfer AND deletion — files outside the filter's purview (e.g. a hand-placed `.txt`)
  are neither transferred nor deleted. No risk of unrelated destination content being wiped.
- **Concurrency:** no file locking, as spec explicitly says is not required. If the manual
  script and the nightly cron overlap, worst case is a benign double-rsync (rsync is safe to
  run concurrently against the same non-conflicting file set; no corruption risk observed or
  plausible for a `-a --delete` pass over static markdown files). Flagged only as an accepted
  risk, matching spec's own risk section — not a new finding.
- **grep pattern `^*deleting`:** technically a leading `*` right after `^` in BRE has ambiguous
  literal-vs-quantifier semantics across grep implementations, but moot — see §8, the pattern
  never has a chance to match real rsync output either way.

## 10. Scope check vs spec's "out of scope" list

- No `knowledge-base/scripts/mmrag.py` changes: confirmed absent from `git show d7e8d98 --stat`.
- No new cron/config.json change **from the P1.5 commit itself**: `git show d7e8d98 --stat`
  touches exactly `agent-memory-mirror.sh` (new), `kb-reconcile-nightly.sh` (edit), plus two
  incidental one-line `updated_at` timestamp bumps in `.cortextOS/state/agents/alice/crons.json`
  and `.json.bak` (both `"crons": []` before and after — no actual cron content added; looks
  like unrelated live-state noise swept in by a broad `git add`, not a scope violation of the
  P1.5 feature itself). Worth a process note for future commits, not a functional bug.
- No git operations run against knowledge-sync by the script: confirmed — no `git` invocation
  anywhere in `agent-memory-mirror.sh`.
- **Process note (not a code bug):** PR #193 as actually merged bundled P1.5 together with
  P1.0, P1.1, P1.3, P1.4, P1.6, cxportal-import, and several unrelated skill additions into one
  large PR — the spec's Step 6 says "Commit contents: exactly the two files," which the P1.5
  *commit* (d7e8d98) honored, but the *PR* it shipped in was a large multi-feature batch. This
  is a repo-process observation, not a defect in the P1.5 code under review.

## Summary

All 8 requested live checks pass. The one real technical finding (`deleted` always reports 0)
is a known, spec-permitted shortcut, not a hidden defect — the spec's actual correctness bar
(`mirrored == source_count`) holds on every run, exit codes are correct, no leakage, retrieval
works end-to-end with a real citation. The previously-fixed `grep -c` JSON-corruption bug
(797d7ee) is confirmed still fixed in the current file.

**Verdict: PASS.**
