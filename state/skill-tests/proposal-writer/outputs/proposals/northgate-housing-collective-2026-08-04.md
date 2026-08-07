# Proposal: Northgate Housing Collective · One place to see where every application actually is
**Prepared:** 2026-08-04
**For:** Dana Ruiz, COO
**Patterned from:** default structure — `outputs/proposals/riverbend-clinic-2026-05-12.md` is the closest shape match (same three-systems-disagree problem), but **no proposal in `outputs/proposals/` carries an OUTCOME line, so no proposal in the folder can be treated as WON.** Not guessing. Default structure used.
**OUTCOME:** pending ← update to WON/LOST when the deal resolves; this is what powers pattern-matching for every future proposal

---

## The Problem

"Nobody can tell me where an application actually is."

Dana said it twice on the call, and it is the whole problem. Intake lives in a Google Form, eligibility in a spreadsheet, case notes in Salesforce, and none of the three agree. Priya spends Mondays "just reconciling."

It isn't a tooling gap. As Priya put it: "It's not that we don't have tools. We have too many."

The cost isn't abstract. Last month two families were denied twice, because two coordinators were working off different sheets. That is the failure mode a status system exists to prevent, and it is already happening.

## What We'll Build

One place where you look and know: this family is at stage three, here's who touched it last, here's what's blocking it. Dana's sentence, made literal.

Not a fourth system. The Form, the spreadsheet, and Salesforce keep doing what they do — we make them agree, and we put a single status view on top of them. When a coordinator opens a file, there is one answer about where it stands, and it is the same answer Dana sees.

What changes: no Monday reconciliation. No second denial. When the board asks how many families are stuck at eligibility, that is a number you read, not a number you assemble.

## Phases

**Phase 1 · Discovery**
- Map the real application flow end to end — Form, spreadsheet, Salesforce, and the handoffs between them
- Find where duplicates are born (the two-coordinators-two-sheets path, and any others)
- Define the stage model: what "stage three" means, who owns each stage
- Written findings + the target-state pipeline design
- **Done looks like:** you and Priya read the process map and agree it's your actual process, and the duplicate sources are named.

**Phase 2 · Build the unified pipeline view**
- One status record per application, reconciled across the three systems
- Stage, last-touched-by, and current blocker visible on every record
- Duplicate prevention at the point the duplicate is currently born
- Handover walkthrough with Priya and the coordinator team
- **Done looks like:** Dana opens one view, picks any family, and gets stage + owner + blocker without asking anyone.

**Phase 3 · Keep it honest** `[CONFIRM SCOPE: ongoing support was floated on the call and Dana did not respond — this phase is proposed, not agreed]`
- Monthly hygiene pass: drift, orphaned records, stage definitions that stopped matching reality
- A standing check-in with Priya
- **Done looks like:** the view still tells the truth in month six.

## Timeline

- **Phase 1 · Discovery** — 3 weeks, begins on signing. Scheduled to complete in the first three weeks of September, ahead of the September board meeting, per Dana.
- **Phase 2 · Build** — begins on Phase 1 completion, runs into Q4. `[CONFIRM SCOPE: duration not discussed on the call — Q4 window inferred from Dana's "the build can run into Q4"]`
- **Phase 3 · Keep it honest** — begins on Phase 2 handover, monthly.

## Investment

- **Phase 1 · Discovery** — `[CONFIRM PRICE: $X]` — the smallest commitment and the natural place to start. You get the process map and the duplicate analysis whether or not you go further.
- **Phase 2 · Build** — `[CONFIRM PRICE: $X]`
- **Phase 3 · Keep it honest** — `[CONFIRM PRICE: $X/mo]`

`[CONFIRM PRICE: $18,000]` — Dana stated the board approved "something around eighteen thousand for the year for systems work." That number came from the client, not from us, and it has not been allocated across phases. Confirm before it appears in anything sent.

## Next Step

Reply to confirm the phase structure and we'll send the agreement for Phase 1.

---

## ⚠ Confirm Before Sending

- `[CONFIRM PRICE: $X]` — **Investment · Phase 1 Discovery.** No number set.
- `[CONFIRM PRICE: $X]` — **Investment · Phase 2 Build.** No number set.
- `[CONFIRM PRICE: $X/mo]` — **Investment · Phase 3 Keep it honest.** No number set.
- `[CONFIRM PRICE: $18,000]` — **Investment · closing note.** Client-stated board budget for the year. Not our quote, not yet split across phases.
- `[CONFIRM SCOPE: ...]` — **Phases · Phase 3.** Ongoing support was floated by Josh on the call; Dana did not respond. Included as proposed. Cut it or keep it.
- `[CONFIRM SCOPE: ...]` — **Timeline · Phase 2.** Build duration was never stated; "into Q4" is inferred from Dana's phrasing.

## Open commitment from the call (not part of the proposal — carry it separately)

- **"It'll be a day or so, but I'm going to analyze the interviews and send them both emails with Mark on copy."** — Owner: Josh Weiss (first-person, resolved to speaker). Due: ~1 day from 2026-08-04, i.e. by 2026-08-05, stated as "a day or so." Recipients: Dana Ruiz and Priya Shah, cc **Mark** — `[CONFIRM SCOPE: "Mark" was not identified by surname or role on the call — NEEDS-OWNER resolution before sending]`. This is a pre-proposal commitment, and it lands before this document does.
