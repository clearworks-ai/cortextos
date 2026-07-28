# Research — ff-extractor commitment-quality gate regression

## Bug
`orgs/clearworksai/agents/frank2/scripts/ff-extractor.py` `ACTION_ITEMS_PROMPT` (lines 93-112)
regressed in commit 5917125 (PR cortextos#162, merged to main as 710e0c3). The prompt added a
permissive fallback rule:

    - Only surface items material to an active Clearworks engagement or a dated commitment; drop the rest.
    - If client context is empty, keep only explicit Clearworks work or dated commitments that still need follow-through.

This is too loose. When `client_context` is populated for a prospect (not an existing client),
the "material to an active Clearworks engagement" branch does not apply, and the model falls
back to accepting generic pitch/business-model narration phrased with task-like structure (e.g.
"the way my business works is...") as a real action item, because the rule never requires a
specific named owner, a concrete date, or explicit commitment language.

## Live confirmation
Confirmed against a real transcript (Nerin Kadribegovic prospect call, ingested via Fireflies)
that produced 3 false-positive "action items" — none of them a real commitment made during the
call, all narration about how Clearworks' engagement model works.

## Root cause
The extraction bar conditions on relationship state (client vs. prospect / context populated vs.
empty) rather than on the intrinsic properties of a real commitment (named owner + concrete date
+ explicit commitment language). Fix must make the bar apply uniformly regardless of relationship
state and must explicitly reject business-model/pitch narration and hypothetical examples.

## Scope
Single prompt-string edit inside `ACTION_ITEMS_PROMPT`, lines 99-106 of
`orgs/clearworksai/agents/frank2/scripts/ff-extractor.py` as of origin/main 710e0c3. No other
code path touched.
