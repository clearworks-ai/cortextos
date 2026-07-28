# Specs — ff-extractor commitment-quality gate fix

## Exact replacement

Replace this exact block (currently lines 99-106 of `ACTION_ITEMS_PROMPT` in
`orgs/clearworksai/agents/frank2/scripts/ff-extractor.py`, origin/main 710e0c3):

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

With:

```
For each action item, ALL of the following must be true or the item must be dropped:
- A SPECIFIC named owner — a real person mentioned by name in the transcript (not "the team,"
  not a generic/implied party, not "Unassigned"). If no real person is named, drop it.
- A CONCRETE due date or explicit near-term timeframe stated in the transcript (e.g. "by Friday,"
  "next week"). Vague or absent timing ("eventually," "at some point," unstated) means: drop it.
- Explicit commitment language — "I will," "I'll send," "let's do X by Y" — not hedged or
  speculative language ("could," "might," "worth considering," "an option would be to").
This bar applies REGARDLESS of whether client context is populated or empty, and regardless of
whether the other party is a prospect or an existing client — the test is always: is this a real,
specifically-owned, specifically-dated commitment, not whether the relationship is established.
Explicitly REJECT: descriptions of what a company/service offers in the abstract, self-referential
pitch or business-model narration (e.g. "the way my company works is...", "we typically do X for
clients"), and hypothetical/illustrative examples — these are never action items even if phrased
with task-like structure.
No artificial limit on count. Zero acceptable if none found — that is the expected result for a
call with no real commitments.
```

## Acceptance
- No other line in `ff-extractor.py` changes.
- The prospect-call regression (business-model narration extracted as an action item) no longer
  reproduces once this text is live: an item is only kept if it has a named real person, a
  concrete date/timeframe, and explicit commitment language.
