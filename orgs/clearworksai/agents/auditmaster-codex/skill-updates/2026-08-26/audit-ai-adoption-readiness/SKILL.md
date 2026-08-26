---
name: audit-ai-adoption-readiness
description: "Audit chain phase 4.5. Assess one client's actual AI tool environment, administration, data rules, human review, training, adoption, and use-case ownership, then produce the client-facing 04a section. Use after systems and integration analysis and before workflows, architecture, and solutions."
---

# AI Operating Environment and Adoption Readiness (phase 4.5)

**Internal Clearworks skill.** This is one bounded phase inside a single client audit. It is not a cross-client learning system, compliance certification, security assessment, managed-service framework, or permission to inspect or change a client's tenant.

Read `audit-foundation` first. Consume the locked strategy anchor, pain-point atlas, `03-systems-inventory`, and `04-integration-gap-analysis`. Produce:

- `deliverables/<client>/04a-ai-operating-environment-and-adoption.md` (client-facing section)
- `deliverables/<client>/_internal/04a-ai-operating-environment-evidence.json` (internal evidence ledger; never assemble into the client report)

Before writing the client-facing section, use `the-humanizer` for the report channel and apply the shared client-facing discipline from the other audit skills.

## What to assess

Assess only what the evidence supports:

1. AI tools actually in use, including employee-selected tools not yet covered by a company standard.
2. Named business and technical owner for each consequential tool.
3. SSO, account provisioning, role changes, and offboarding.
4. Privacy, retention, model-training, sharing, and connector/data-access settings.
5. Company, client, employee, financial, project, or regulated data entering the tools.
6. Approved-use rules, prohibited data/actions, and required human review.
7. Training by role and the support people receive when use cases fail or change.
8. Adoption: who uses the tools, where use has stuck, and where people return to old workarounds. Do not invent utilization percentages.
9. How a new use case is requested, reviewed, prioritized, assigned, tested, and revisited.
10. Prioritized fixes: implement now vs later, dependencies, owner, and evidence needed.

Optional ongoing support may appear as one short recommendation only when the client's evidence shows an ownership or operating-cadence gap. Do not turn the section into a recurring-services pitch.

## Evidence rules

- One client/project at a time. Never use another client's evidence, examples, numbers, or language.
- Read raw interviews, surveys, intake, configuration exports, policies, and admin screenshots directly. Do not use AuditOS-derived analysis tables as evidence.
- Resolve speaker identity from content, not diarization labels.
- Every current-state or gap finding requires a citation and confidence: `confirmed`, `reported`, or `inferred`.
  - `confirmed`: directly observed configuration, policy, export, or system evidence.
  - `reported`: a named interviewee described it; state who and cite the moment.
  - `inferred`: evidence indicates a likely gap but the responsible owner or configuration was not checked. Say what remains unverified.
- Missing evidence is an evidence gap, not proof of missing governance or unsafe configuration.
- Never expose credentials, tokens, private configuration values, or security-sensitive implementation detail in the client section.
- Never say the client is compliant, secure, unsafe, mature, immature, ready, or unready without a defined and evidenced criterion. Describe the observed condition and consequence instead.

## State separation

Keep these fields separate in notes and output:

- **Current state:** what is in use or configured now.
- **Gap:** the specific missing, inconsistent, or unverified operating condition.
- **Recommendation:** the bounded change Clearworks recommends.
- **Timing:** `now` or `later`.
- **Dependency:** evidence, owner, policy decision, technical prerequisite, or budget needed first.

An implemented tool is not evidence of adoption. A recommendation is not an implemented control. A reported practice is not a confirmed tenant setting.

## Workflow

1. **Scope the client and evidence boundary.** Record the client slug, project ID, source roots, interviewed roles, and unverified owners. Stop on mixed-client inputs.
2. **Build the internal evidence ledger.** Use the schema in [references/client-section-template.md](references/client-section-template.md). Run:
   ```bash
   python3 scripts/validate_readiness.py validate <ledger.json>
   ```
3. **Cover the ten assessment areas.** For each area, record evidenced current state, gaps, and open questions. `Not established from available evidence` is valid.
4. **Prioritize fixes.** `now` means the client can act with existing authority and dependencies; `later` requires a named prerequisite. No generic maturity roadmap.
5. **Write the client section.** Follow [references/client-section-template.md](references/client-section-template.md). Keep internal paths and sensitive configuration details in the ledger; use client-safe citations in the report.
6. **Pre-flight.** Re-read this skill and verify: single client; every factual finding cited; confidence visible; current/gap/recommendation not conflated; no secret values; no compliance claim; now/later and dependencies present; evidence gaps retained; Humanizer self-check passed.
7. **Handoff.** The completed `04a` section feeds workflow maps, architecture, the solution portfolio, roadmap, and master assembly. It does not create solutions by itself.

## Done when

- All ten areas are evidenced or explicitly marked not established.
- Every finding has confidence and a client-safe citation.
- Recommendations are separated into now/later with owners and dependencies.
- The internal ledger passes the validator.
- The client section passes Rule Zero, confidentiality, and Humanizer review.
- Josh locks the first section format before it is reused at scale.
