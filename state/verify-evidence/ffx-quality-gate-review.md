# Review: ff-extractor commitment-quality gate fix

Branch: fix/ff-extractor-commitment-quality-gate (sha 6393e16)
File touched: orgs/clearworksai/agents/frank2/scripts/ff-extractor.py (ACTION_ITEMS_PROMPT block only, ~lines 99-106 pre-change)

## Diff scope check
`git diff origin/main...fix/ff-extractor-commitment-quality-gate --stat` confirms exactly one file changed, 16 insertions / 8 deletions, entirely within the ACTION_ITEMS_PROMPT string literal. No refactors, no unrelated files, no test/config changes.

## Correctness review
Root cause: commit 5917125 (PR#162) shipped a permissive fallback in ACTION_ITEMS_PROMPT that let generic prospect-pitch narration get extracted as action items. Confirmed live on a real prospect call (Nerin Kadribegovic) that produced 3 false-positive tasks (since cancelled).

The fix requires, for every extracted item, ALL of:
1. A specific named real person as owner (rejects "the team", "Unassigned", implied parties).
2. A concrete due date or explicit near-term timeframe (rejects "eventually", unstated timing).
3. Explicit commitment language ("I will", "I'll send") rather than hedged/speculative phrasing ("could", "might").

It also explicitly rejects self-referential pitch/business-model narration and hypothetical/illustrative examples, and applies uniformly regardless of prospect vs. client status — closing the exact gap that caused the false positives.

## Risk assessment
Low risk: single prompt-string edit, no code-path/control-flow change, no schema change. Slight risk of being overly strict (a true actionable item with slightly indirect phrasing could be dropped) — acceptable tradeoff given the bug was false positives creating bogus tasks, and the prompt still allows "No artificial limit on count. Zero acceptable if none found."

## Verdict
APPROVE. Change is correctly scoped to the reported bug, matches the plan/specs artifacts, and does not touch anything outside the prompt block.
