# Plan & Specs — followup-coordinator recap email completeness

## Synthesis

The defect: Step 3 of the followup-coordinator skill instructed the drafting step to "write the
recap in the company voice" from the call generally, and its only completeness rule was
one-directional ("no item appears in the email that isn't in the tracker"). Nothing enforced the
reverse — that every tracker row survives into the email. In production this let a real client
commitment ("add Josh to the Slack test channel"), correctly captured in the THEIR-COMMITMENTS
table, silently vanish from the drafted recap. This is a trust/reliability failure, not a cosmetic
one: a client-facing recap that quietly drops a commitment misrepresents what was agreed to, and
the failure is invisible until the client (or Josh) notices independently. A single-layer fix would
be insufficient — construction-time discipline alone can still fail for an unanticipated reason, and
a detection-time check alone still lets a bad draft get most of the way to "done" before being
caught. The two-part fix (prevent at construction, catch at detection) is defense in depth for a
failure mode with real client-facing cost.

## Plan

Both changes land in the same file, same Step 3 section, in this order:

1. **Construction-time fix (primary).** Rewrite the "What we're doing" and "What we need from you"
   bullet instructions to require walking the OUR-COMMITMENTS / THEIR-COMMITMENTS tables row by row,
   replacing the freeform "summarize the call in company voice" framing. This is primary because it
   changes how the draft is generated in the first place — a table-driven walk structurally cannot
   skip a row without an explicit, visible decision to cut it, whereas a narrative summary drawn from
   memory of the call has no such guardrail.
2. **Detection-time fix (safety net).** Add an explicit bidirectional completeness check to the
   "Rules for the draft" list: count tracker rows per side, count email bullets per section, confirm
   1:1 match. This exists to catch any drop that the row-by-row construction misses (e.g. a future
   edit reintroduces freeform drafting) and to require any length-driven cut to be stated explicitly
   in the draft rather than silently omitted.

No other sections of SKILL.md change. Step 4 (tracker write) and task-table formatting are untouched
per explicit scope boundary below.

## Specs

Acceptance criteria:

1. Given a meeting with N items in THEIR-COMMITMENTS, the drafted recap email's "What we need from
   you" section contains exactly N bullets — one per tracker row.
2. Given a meeting with M items in OUR-COMMITMENTS, "What we're doing" contains exactly M bullets —
   one per tracker row.
3. If an item is cut for length, the draft states this explicitly rather than silently omitting it.
4. No item appears in the email that isn't in the tracker (existing one-directional rule, preserved
   unchanged).
5. Both bullet-drafting instructions explicitly direct row-by-row table traversal, not narrative
   summarization from memory of the call.
6. The "Rules for the draft" list contains an explicit bidirectional completeness check (row count ==
   bullet count, both directions) as a post-draft step, distinct from and in addition to the
   construction-time row-walk.

Out of scope: task-table formatting is explicitly NOT touched by this fix. Josh: "leave the tasks for
now ill work with them live" / "dont change yet." Re-running extraction for past meetings/clients is
also out of scope — this fix governs future runs only.
