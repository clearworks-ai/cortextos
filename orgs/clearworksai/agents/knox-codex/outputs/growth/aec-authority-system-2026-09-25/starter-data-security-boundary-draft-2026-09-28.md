# `/starter` data and security boundary — review draft

Date: 2026-09-28

Status: internal plain-language draft; **not specialist-reviewed and not approved for publication**

## Proposed page block

### The firm decides what the workflow can see and what it can do

Each workflow starts with an agreed job, named source records, and the smallest access needed to perform it. Before connecting a tool, Clearworks documents which accounts and systems are involved, what information may be read or written, who owns the workspace, and where the reviewed result belongs.

AI-assisted output remains a candidate until the responsible person checks it. Architects and the appropriate project or business leaders retain authorship, verification, approval, sealing, contractual decisions, accounting decisions, and business judgment.

Workspace ownership, user access, offboarding, retention, model-training controls, connector permissions, approved data categories, review thresholds, and the accepted destination are recorded for the live workflow. If the work crosses managed IT, cybersecurity, legal, insurance, compliance, or contractual boundaries, the specialist who owns that obligation remains responsible and joins the decision.

Clearworks builds and maintains the agreed working layer. Clearworks does not replace the firm's licensed professionals, managed IT provider, cybersecurity team, legal counsel, accountant, insurer, or compliance owner.

## What this block establishes

| Question | Proposed answer |
|---|---|
| What may the workflow use? | Only agreed sources and data categories required for the named job. |
| How much access should it have? | The smallest practical access, scoped by account, role, connector, and permitted action. |
| Can it write to a system? | Only where the write action, destination, review gate, rollback/exception path, and owner are explicitly approved. |
| When is the output official? | After the named responsible person reviews and accepts it into the agreed record. |
| Who owns professional judgment? | The architect, consultant, project leader, or business owner already responsible for the decision. |
| Who owns IT/security/legal obligations? | The firm's specialists; Clearworks coordinates but does not assume those roles. |
| What happens when the workflow changes? | Access, source, provider, review, exception, and retention decisions are reviewed again. |

## Required specialist decisions before publication

- [ ] Name the accountable reviewer and review date.
- [ ] Confirm the precise public wording for retention and model-training controls.
- [ ] Confirm whether deletion, export, and offboarding commitments belong on this page or in a linked policy.
- [ ] Confirm the public incident/escalation wording.
- [ ] Confirm how subprocessors or selected AI providers should be described without implying a fixed vendor stack.
- [ ] Confirm whether the page should link to a dedicated security/data page, privacy policy, or both.
- [ ] Check the wording against current contracts and actual operating practice.

## Claims this draft does not make

- No SOC 2, ISO, HIPAA, FedRAMP, or other certification claim.
- No promise that a specific model or provider never trains on data unless the configured service terms prove it.
- No claim that all client data is suitable for any AI tool.
- No claim that human review eliminates every error or risk.
- No promise that Clearworks replaces managed IT, cybersecurity, legal, compliance, insurance, or licensed-professional review.

## Source alignment

This draft consolidates the current public `/starter` professional boundary, the existing FAQ answers for access, privacy, retention, model-training controls, connectors, governance, and program ownership, and the accepted-record / review-gate glossary definitions. It adds no certification or provider-specific claim.

The proposed operating commitments above—including documenting access before connecting a tool and recording the controls for a live workflow—are not facts established by the cited public pages. Publication requires confirming them against current contracts and delivery practice.

Sources:

- `/Users/joshweiss/code/clearworks-sites/site/src/pages/starter.astro`
- `/Users/joshweiss/code/clearworks-sites/site/src/data/aecAnswerLibrary.ts`
- `content-briefs/01-ai-operations-implementation-architecture-firms.md`
- `starter-evidence-packet-2026-09-28.md`
