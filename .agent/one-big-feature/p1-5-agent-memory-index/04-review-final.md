# P1.5 Adversarial Review — FINAL

Slug: `p1-5-agent-memory-index` | Stage: `review`
Reviewer: fresh adversarial pass (no prior context reused), 2026-08-03
Files reviewed (as shipped on `origin/main`): `orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh`,
`orgs/clearworksai/agents/larry/bin/kb-reconcile-nightly.sh`
Commits inspected: `d7e8d98` (P1.5 land), `797d7ee` (grep -c JSON-corruption fix, already merged),
`12ad955` (unmerged local branch — JSON `exit` field cosmetic fix, assessed but NOT required)

## Verdict: **PASS**

The shipped code implements the spec faithfully, the safety gate is correct, the rsync
anchoring correctly excludes `handoffs/` and `memory-archive/`, the mirror is idempotent and
byte-verbatim, and the wrapper integration is exactly the three surgical additions the spec
calls for with mirror failure correctly non-fatal to the wrapper. One real-but-cosmetic bug
exists in the mirror script's JSON `exit` field (see Known Issue below) — it does **not**
affect the wrapper's actual green/red computation and does not block this review.

## Evidence — `agent-memory-mirror.sh`

- **Safety gate** (lines 8–17): `[[ ! -d "$SRC" ]]` → prints `{"error":"source missing or
  empty","exit":1}` and `exit 1`; separately, `SOURCE_COUNT=$(find "$SRC" -maxdepth 1 -name
  '*.md' | wc -l)` → if 0, same error JSON + `exit 1`. Matches spec exactly. Confirmed live
  (see Live-test section) by executing the identical guard-clause logic against (a) an
  existing-but-empty dir and (b) a nonexistent dir — both print the error JSON and would
  `exit 1`.
- **Mirror command** (line 23): `rsync -a --delete --include='/*.md' --exclude='*' "$SRC/"
  "$DST/"` — byte-identical to the spec's mandated invocation. No `--delete-excluded`,
  `--copy-links`, or recursion-widening flags added.
- **Anchoring verified live**: source has a `handoffs/` subdir (57 `*.md` files) and a
  `memory-archive/` subdir; mirrored count (813) == top-level source count (813) with **zero**
  subdirectories created in DST (`find $DST -mindepth 1 -type d` → empty). The 14 top-level
  filenames matching `grep handoff` (e.g. `feedback_context_limit_proactive_handoff.md`) are
  legitimate top-level topic files with "handoff" in the *filename*, not files pulled from the
  `handoffs/` subdirectory — confirmed by directory listing.
- **JSON contract** (line 36): `{"mirrored":N,"deleted":M,"source_count":K,"exit":0}` — field
  names and shape match spec.
- **Exit logic** (lines 38–43): `exit 1` if `RSYNC_STATUS -ne 0` OR `MIRRORED -ne
  SOURCE_COUNT`, else `exit 0`. Matches spec's "exit 0 only if rsync succeeded AND
  mirrored==source_count."
- **Idempotency**: ran twice live, identical `{"mirrored":813,"deleted":0,"source_count":813}`
  both times, exit 0 both times.
- **Byte-verbatim, no frontmatter mutation**: `diff` on
  `feedback_context_limit_proactive_handoff.md` between source and mirror → empty diff.
- **797d7ee is a real, necessary, already-merged fix**: the pre-fix line was
  `DELETED=$(echo "$RSYNC_OUTPUT" | grep -c "^*deleting" || echo "0")`. `grep -c` on zero
  matches prints `0` to stdout AND exits 1, so the old `|| echo "0"` fallback fired *in
  addition to* grep's own `0` output, producing `DELETED="0\n0"` — a two-line value spliced
  into the middle of the JSON line, corrupting it (`"deleted":0\n0,...}` — invalid JSON, and
  the wrapper's tolerant last-`{`-line parser could silently swallow it as `{}`). The current
  code (`2>/dev/null || true` + an explicit `[[ -z "$DELETED" ]]` empty-check) avoids the
  double-append and was confirmed live: real output is a single well-formed JSON line with
  `"deleted":0`.

## Evidence — `kb-reconcile-nightly.sh`

- **No `set -e`** in either script (confirmed via grep) — matches the "red ledger row is the
  alarm, mirror failure must not abort the wrapper" philosophy; only `set -u` is present, as
  before P1.5.
- **Step 0 block** (lines 16–18): calls the mirror script, redirects stderr to
  `/tmp/kb-reconcile-nightly.err` (append mode, same pattern as `RECON_OUT`/`EDGES_OUT`),
  captures `MIRROR_STATUS=$?` immediately after — correct placement (nothing intervenes
  between the call and the `$?` capture).
- **Ledger field + tolerant parsing**: `git show d7e8d98` on this file is a clean, surgical
  diff — the only additions are (1) the Step-0 block, (2) `MIRROR_OUT` piped into the embedded
  Python via the same `env-var + argv` pattern as `RECON_OUT`, parsed with the identical
  last-`{`-line `JSONDecoder.raw_decode` tolerant-fallback-to-`{}` logic already used for
  `recon_data`, and (3) a `mirror_stats` dict composed into the row as `memory_mirror`. No
  unrelated restructuring — matches spec's "three additions, nothing else restructured."
- **Green computation** (line 142 area): `green = (... and mirror_status == 0 and ...)` —
  extended exactly as required. `final_status` (line 170) also folds in `mirror_status == 0`,
  consistent with `recon_status`/`edges_status` treatment.
- **Mirror non-fatal to the wrapper**: `MIRROR_STATUS` is captured and threaded through to the
  ledger row / green flag, but a nonzero `MIRROR_STATUS` does not `exit` or otherwise abort the
  script before Step 1 (reconcile) and Step 2 (edges) run — confirmed by reading straight-line
  control flow with no conditional `exit` between Step 0 and Step 3.

## Live-test output (real commands, real output)

```
$ bash orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh; echo "EXIT_CODE=$?"
{"mirrored":813,"deleted":0,"source_count":813,"exit":0}
EXIT_CODE=0

$ bash orgs/clearworksai/agents/larry/bin/agent-memory-mirror.sh; echo "EXIT_CODE=$?"   # run 2, idempotency
{"mirrored":813,"deleted":0,"source_count":813,"exit":0}
EXIT_CODE=0

$ ls ~/code/knowledge-sync/raw/areas/clearworks/agent-memory | wc -l
813
$ ls ~/code/knowledge-sync/raw/areas/clearworks/agent-memory/*.json 2>&1
(no matches found) — confirmed empty
$ diff <(ls ~/.claude/projects/-Users-joshweiss-code-cortextos/memory/*.md | xargs -n1 basename) \
       <(ls ~/code/knowledge-sync/raw/areas/clearworks/agent-memory/*.md | xargs -n1 basename)
(empty diff, exit 0)
$ find ~/code/knowledge-sync/raw/areas/clearworks/agent-memory -mindepth 1 -type d
(empty — no subdirectories, handoffs/ and memory-archive/ correctly excluded)
$ find ~/.claude/projects/-Users-joshweiss-code-cortextos/memory/handoffs -maxdepth 1 -name '*.md' | wc -l
57   # confirms real handoffs/ content exists in source and was NOT pulled into DST
$ diff ~/.claude/projects/-Users-joshweiss-code-cortextos/memory/feedback_context_limit_proactive_handoff.md \
       ~/code/knowledge-sync/raw/areas/clearworks/agent-memory/feedback_context_limit_proactive_handoff.md
(empty diff, exit 0 — byte-verbatim mirror confirmed)
```

Safety-gate logic (identical guard clauses, executed inline — could not write a standalone
throwaway copy of the script to disk due to Larry's "no direct code writing" policy gate, so
verified via direct execution of the same conditionals):
```
Test 1 — dir exists, 0 .md files: {"error":"source missing or empty","exit":1}, would-exit=1
Test 2 — dir does not exist:      {"error":"source missing or empty","exit":1}, would-exit=1
```
Both match spec.

Note: I did not re-run the full `kb-reconcile-nightly.sh` wrapper end-to-end (that invokes a
multi-minute `mmrag.py reconcile` against the live chroma DB and `cortextos bus
kb-extract-edges`) — this review's live-test scope was the mirror script itself (as the task
explicitly requested) plus static/diff inspection of the wrapper's integration code, which is
a small, easily-audited surgical diff (see `git show d7e8d98` above) rather than something
that benefits materially from a live re-run for this review pass.

## Known issue — `12ad955` (unmerged, local branch `p1-5-agent-memory-mirror-exit-code-fix`)

**Real bug, correctly scoped, does NOT block this review.**

The current shipped script hardcodes `"exit":0` in the JSON line (line 36) *unconditionally*,
then separately decides the real process exit code afterward (lines 38–43). So a failing run
(rsync failure, or `mirrored != source_count`) would print `{"mirrored":X,...,"exit":0}` to
stdout while the *process* actually exits 1. This is a genuine self-contradiction in the
script's own output — a future consumer that greps/parses the JSON `exit` key directly (rather
than checking `$?`) would be misled into believing a failed mirror succeeded.

However, I independently confirmed this does **not** propagate into the wrapper's
success/failure logic: `kb-reconcile-nightly.sh` captures `MIRROR_STATUS=$?` (line 18) — the
real bash process exit code, not the JSON `exit` field — and that is what feeds `mirror_status`
into `mirror_stats["status"]`, the `green` computation, and `final_status`. The wrapper's
Python (lines 130–136) builds `mirror_stats` from `mirror_data.get("mirrored"/"deleted"/
"source_count")` but explicitly uses `mirror_status` (the argv-passed real `$?`), **not**
`mirror_data.get("exit")`, for the `"status"` key. So the one field that's actually wrong in
the JSON is never read by the one consumer that exists today.

Severity: low, cosmetic-but-real. Recommend merging `12ad955` as a fast-follow (it's a clean
2-line fix — compute `FINAL_EXIT` once, reuse for both the JSON field and the `exit` call) so
no future consumer inherits a misleading contract, but it is not a functional defect in
anything this review is gating and should not hold up merge of the already-shipped P1.5 code.

## Other findings

- No quoting bugs found; `set -u` is respected throughout (`SOURCE_COUNT`, `MIRRORED`,
  `DELETED`, `RSYNC_STATUS` are all assigned before use; no unset-variable exposure).
- `MIRROR_OUT`/`RECON_OUT`/`EDGES_OUT` env-var-passing pattern for the embedded Python is
  consistent across all three producers — no special-casing that would make `memory_mirror`
  parse differently than `reconcile`/`edges` under edge conditions (e.g. stderr leaking into
  stdout, multi-line output).
- Rollback path (spec) is intact: deleting the mirror dir and re-running reconcile would surface
  as `removed_files` per the spec's stated rollback description; nothing in the shipped code
  changes that assumption.
- Divergence-from-plan-line documentation requirement (spec: PR description must state the
  "mirror instead of literal root" divergence) is a PR-authoring requirement, not a code
  requirement — out of scope for this code review, flagged for whoever opens the PR.
