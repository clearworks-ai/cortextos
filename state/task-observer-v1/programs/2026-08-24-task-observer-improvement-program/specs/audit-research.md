---
title: Audit and Research Evidence Skills — Sub-spec
project: cortextOS Task Observer
area: internal
type: spec
status: correction-review-not-pass
repo: /Users/joshweiss/code/cortextos
base-branch: origin/main
mockup: N/A — backend only
version: 2.0
date: 2026-08-24
keywords: [audit, research, evidence, claims, acceptance]
---

# Audit and Research Evidence Skills — Sub-spec

## 1. Goal
Specify deterministic evidence/claim ownership for `audit-pipeline`, `audit-assemble-master`, `source-collection`, `audit-evidence-ledger`, and `research-claim-ledger`.

**Out of scope:** bundle edits/installation, client output, live DB writes, disabled/snapshot/worktree targets.

## 2. Constitution check
| Invariant | Satisfaction |
|---|---|
| Recommendations cannot outrun evidence | FR-201/02 stable trace and handoff gate |
| Collector does not decide claim truth | FR-205/02 separate acquisition from adjudication |
| Client paths/content cannot enter generalized bundles | FR-203/04 scan and config-driven script |
| Only enabled live copies are targets | FR-208/02 CAS target manifest |

## 3. UI mockup
No UI surface; mockup gate N/A.

## 4. Requirements

### FR-201 — Audit pipeline adapter
**Requirement:** `audit-pipeline` MUST block handoff unless audit-ledger coverage/trace validators pass.
**Acceptance:**
- WHEN a phase requests handoff THE SYSTEM SHALL emit PASS or missing stable IDs and refuse incomplete handoff.
**Bucket:** B — staged prose exists; executable ledger/gate wiring does not (G-203).
**Depends on claims:** G-203

### FR-202 — Audit evidence ledger
**Requirement:** A new `audit-evidence-ledger` MUST own stable typed IDs and trace validation.
**Acceptance:**
- WHEN evidence/finding/recommendation/outcome is recorded THE SYSTEM SHALL preserve links, confidence, contradictions, alternatives, coverage, author/time, and immutable revisions.
**Bucket:** C — no candidate bundle/schema exists (G-203).
**Depends on claims:** G-203

### FR-203 — Generalized assembly execution
**Requirement:** `audit-assemble-master` MUST resolve a valid enabled workspace/script root and explicit reference profile without user/client/legacy literals.
**Acceptance:**
- WHEN assembly validation starts THE SYSTEM SHALL resolve `scripts/assembly-check.py` from the enabled `audit-assemble-master` bundle root independent of process CWD, invoke `python3 <absolute-bundle-root>/scripts/assembly-check.py --workspace-root <absolute-workspace> --reference-profile <absolute-product-neutral-json>`, validate the profile against `../audit-reference-profile-v2.schema.json`, and fail if any argument/file is absent.
- WHEN generalized bundle bytes are scanned THE SYSTEM SHALL return zero client-specific names, absolute user/client paths, account/org values, provider endpoints/hosts, or credential values; the exact negative/false-positive corpus is supplied to `validation-contract-v2.json` rather than relying on three sample literals.
- WHEN the script exits THE SYSTEM SHALL use exit `0` only for a complete PASS, exit `1` for validation defects, and exit `2` for invalid arguments/config; stdout SHALL be machine-readable JSON and contain no client content.
**Bucket:** B — working script exists; current mandatory invocation is missing and internals are hard-coded (G-202).
**Depends on claims:** G-202

### FR-204 — Artifact acceptance gate
**Requirement:** Assembly MUST validate coverage, citations, render QA, de-identification, package allowlist, hashes, and consume/verify the generic core's hash-bound terminal receipt. It may emit audit-local readiness but SHALL NOT issue the generic terminal package decision.
**Acceptance:**
- WHEN delivery is proposed THE SYSTEM SHALL fail closed with itemized defects until every required check is proven.
**Bucket:** B — staged checklist exists; executable script covers only a subset (G-202, G-206).
**Depends on claims:** G-202, G-206

### FR-205 — Source provenance schema
**Requirement:** `source-collection` MUST preserve canonical URL, publisher, retrieval/publication/event dates, source class, surfacing query/feed, and partial-fetch receipt.
**Acceptance:**
- WHEN collection succeeds or partially fails THE SYSTEM SHALL persist all provenance and failure fields against stable item identity.
**Bucket:** C — live SQLite schema lacks the fields (G-204).
**Depends on claims:** G-204

### FR-206 — Research claim ledger
**Requirement:** A new `research-claim-ledger` MUST own claim/item binding and truth-state reasoning without fetching.
**Acceptance:**
- WHEN a consequential claim is drafted THE SYSTEM SHALL classify fact/opinion/inference, preserve conflict/unknown, record corroboration/confidence, and verify destination links.
**Bucket:** C — no claim table or bundle exists (G-204, G-205).
**Depends on claims:** G-204, G-205

### FR-207 — Ownership enforcement
**Requirement:** Collector, claim ledger, audit ledger, pipeline, and assembler MUST reject cross-owner operations.
**Acceptance:**
- WHEN collector attempts truth adjudication or ledger attempts network fetch THE SYSTEM SHALL fail the contract check.
- WHEN assembler encounters missing evidence THE SYSTEM SHALL reject rather than create/repair a fact.
- WHEN an audit finding cites research THE SYSTEM SHALL reference immutable research claim IDs; the research claim ledger remains sole claim-truth authority, while the audit ledger owns finding/recommendation/outcome lineage and SHALL NOT copy or readjudicate claim truth.
- WHEN the assembler consumes generic client-artifact acceptance THE SYSTEM SHALL act only as an audit adapter and SHALL NOT issue the generic terminal package decision.
**Bucket:** B — ownership is specified but its validator is later-gate work (G-206).
**Depends on claims:** G-201, G-206

### FR-208 — Enabled target CAS/rebase
**Requirement:** Every later bundle MUST bind canonical SHA, enabled target path/base SHA, expected post-SHA, atomic CAS, and rollback SHA.
**Acceptance:**
- WHEN target SHA drifts THE SYSTEM SHALL halt and require an isolated deterministic rebase; no opportunistic overwrite.
**Bucket:** B — bytes/targets exist; installer policy is new (G-206).
**Depends on claims:** G-206

### FR-209 — Exclusion and privacy scan
**Requirement:** Disabled agents, snapshots, worktrees, review archives, client names/paths, and retired product identifiers MUST be excluded from target bundles.
**Acceptance:**
- WHEN a full bundle is reviewed THE SYSTEM SHALL verify references/scripts exist, archive paths are safe, and privacy scan has zero forbidden matches.
**Bucket:** B — path classes are observable, but the generalized scanner/receipt contract is not implemented (G-206).
**Depends on claims:** G-206

## 5. Grounding Ledger
| ID | Claim | Probe | Evidence | Verdict |
|---|---|---|---|---|
| G-201 | Enabled targets are auditmaster-codex/knox-codex only | `cortextos bus list-agents`; hash target trees | enabled live paths/hashes pinned; legacy agents disabled | VERIFIED |
| G-202 | Assembly mandatory path/config is invalid/generalization unsafe | `test -e /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/auditmaster/plugins/cortextos-agent-skills/skills/audit-assemble-master/scripts/assembly-check.py`; inspect `/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/auditmaster-codex/plugins/cortextos-agent-skills/skills/audit-assemble-master/scripts/assembly-check.py:31-42` | documented legacy path missing; enabled script SHA `137906026c1166e4f2df61e71d075545526c1f7bf39d14f1d45d9d709512a610` embeds MSIA/user/page constants | PARTIAL |
| G-203 | Audit trace proposal lacks executable ledger | compare staged pipeline and candidate search | four prose rules staged; no ledger bundle/schema | PARTIAL |
| G-204 | Live source DB lacks claim/provenance fields | `sqlite3 /Users/joshweiss/code/cortextos/orgs/clearworksai/agents/knox-codex/research/db/signals.db 'PRAGMA table_info(items); SELECT count(*) FROM sqlite_master WHERE type=\"table\" AND name LIKE \"%claim%\";'` | items has 18 columns; zero claim table; required fields absent | VERIFIED |
| G-205 | Source rigor proposal is prose-only | archive listing/diff | one-file archive adds rules; no schema/validator | PARTIAL |
| G-206 | Live/staged/snapshot classes and hashes are distinguishable | tree/hash/archive inventory | exact enabled targets, disabled copies, snapshots, worktrees, archive SHAs reproduced | VERIFIED |

## 6. Feasibility summary
| Bucket | FRs | Meaning |
|---|---|---|
| A | FR-207 | Ownership contract is fully specified |
| B | FR-201, FR-203, FR-204, FR-208, FR-209 | Existing artifacts need integration/generalization |
| C | FR-202, FR-205, FR-206 | New ledger/storage schema required |
| D | — | none |

## 7. Accepted assumptions
None. SQLite and files were probed read-only.

## 8. Handoff and changelog
Goal 2 is read-only. Repair details become later authoring tasks only after program acceptance.

- 2026-08-24 — v2.0 grounded 6 claims; adversarial convergence pending.
