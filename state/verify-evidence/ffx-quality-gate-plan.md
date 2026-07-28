# Plan — ff-extractor commitment-quality gate fix

## Goal
Tighten the action-item extraction bar in `ACTION_ITEMS_PROMPT` (ff-extractor.py) so that
generic prospect-pitch/business-model narration can no longer be extracted as a false-positive
action item, regardless of whether client context is populated or empty, and regardless of
whether the other party is a prospect or an existing client.

## Files Touched
- `orgs/clearworksai/agents/frank2/scripts/ff-extractor.py` — `ACTION_ITEMS_PROMPT` string only,
  lines 99-106 as of origin/main 710e0c3. No other file, no other line range.

## Implementation Steps
1. Locate the block currently reading:
```
For each action item:
- Clear, actionable description of what needs to be done
- Owner: person responsible (or "Unassigned" if not specified)
- Due date or timeframe if mentioned
- Status: pending
- Only surface items material to an active Clearworks engagement or a dated commitment; drop the rest.
- If client context is empty, keep only explicit Clearworks work or dated commitments that still need follow-through.
No artificial limit on count. Zero acceptable if none found.
```
2. Replace it in place with a bar that requires, for every surviving action item: (a) a specific
   named real person as owner (not "the team," not "Unassigned"), (b) a concrete due date or
   explicit near-term timeframe stated in the transcript, (c) explicit commitment language rather
   than hedged/speculative language, applied uniformly regardless of client-context state or
   prospect/client relationship — and that explicitly rejects business-model/pitch narration and
   hypothetical/illustrative examples even when phrased with task-like structure. Full exact text
   is specified in the paired specs artifact (ffx-quality-gate-specs.md).
3. No other prompt text, no other function, no other file changes.

## Out of scope
Any refactor, any other prompt in the file, any unrelated cleanup.
