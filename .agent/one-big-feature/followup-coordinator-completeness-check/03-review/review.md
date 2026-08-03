# Adversarial Review — followup-coordinator completeness-check fix

**File:** `orgs/clearworksai/skills/followup-coordinator/SKILL.md`
**Verdict: APPROVE WITH NOTES**

## Does it close the original gap?
Yes, on the primary path. Change 1 (row-by-row table walk instead of freeform narrative summary) removes the actual mechanism that dropped the Slack-channel commitment — the model can no longer "summarize from memory of the call" and silently skip a row. Change 2 (bidirectional count check) is a real second layer: the original check only caught invented items, never omissions; counting tracker rows vs. email bullets per section directly catches a drop even if row-walking is imperfectly followed. Together these are construction + verification, which is the right shape of fix.

## Clarity for an LLM to follow
Mostly clear, with one real seam: the "confirm they match 1:1" rule and the 6+ item compression exception are stated in the same paragraph but not reconciled arithmetically. A literal reader could apply the count check first (top-N + "+N more" line ≠ row count → "bug, add missing bullet"), then run into the exception clause and have to backtrack. Cheap fix: state the reconciliation explicitly, e.g. "itemized bullets + the number folded into '+N more' must equal the row count."

## Remaining edge case / new failure mode
The 6+ compression path reintroduces a smaller version of the original failure shape: an item can be tracker-complete but invisible as a named line in the client-facing email — which is exactly what happened in the incident (item was correctly in the tracker table, still dropped from the email). The fix's own logic notes a tracked-but-unbulleted item is "the same failure as an invented one" for the <6 case, then permits it for the ≥6 case via a summary line. That's a defensible tradeoff against the 30-second-read rule, but "top items" has no selection criterion — nothing stops a genuinely important item (the Slack-channel type of ask) from landing in the "+N more" bucket instead of a named bullet. Worth a follow-up note (not a blocker): prioritize items with hard deadlines/named asks into the visible bullets.

Separately unaddressed: SOFT-marked items (Step 1, vague/unconfirmed commitments) aren't reconciled against this new rule — if those are meant to stay out of the client email pre-confirmation, that's a deliberate cut the "ONLY case ... is a genuinely long list" language doesn't account for.

## Scope
Confirmed bounded to Step 3 (draft) and its rules list. Step 4 (Write to the Tracker) and table formatting are untouched in the diff.
