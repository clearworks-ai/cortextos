---
title: State Evidence and Briefing Truth — Sub-spec
project: cortextOS Task Observer
area: internal
type: spec
status: correction-review-not-pass
repo: /Users/joshweiss/code/cortextos
base-branch: origin/main
mockup: N/A — backend only
version: 2.0
date: 2026-08-24
keywords: [briefing, crm, finance, reconciliation, confidentiality]
---

# State Evidence and Briefing Truth — Sub-spec

## 1. Goal
Specify deterministic briefing reconciliation, CRM/finance evidence contracts, and target-specific `morning-review` adapters.

**Out of scope:** CRM/finance writes, live providers, email/calendar mutation, bundle installation, Academy/ClearPath.

## 2. Constitution check
| Invariant | Satisfaction |
|---|---|
| Truth computation is separate from prose | FR-402/05 core/adapter split |
| CRM writers remain sole mutation owner | FR-406/02 evidence envelope only |
| Finance provenance is separate from forecasting | FR-408/02 ledger vs analyst |
| Enabled targets and disabled evidence are explicit | FR-401 pins two enabled Codex targets, one enabled-but-blocked Muse target, and two disabled evidence copies |

## 3. UI mockup
No UI surface; mockup gate N/A. Telegram text remains an existing delivery surface.

## 4. Requirements

### FR-401 — Morning-review target matrix
**Requirement:** The program MUST pin every `morning-review` surface by current runtime status: two enabled Codex targets on one base, one enabled-but-blocked Muse target on a second base, and two disabled Claude copies on a third base that remain evidence-only.
**Acceptance:**
- WHEN review starts THE SYSTEM SHALL emit `{agent,runtime,path,base_sha,enabled,disposition}` for all five known copies and SHALL count only three as enabled runtime surfaces.
- WHEN a target differs THE SYSTEM SHALL preserve its frontmatter/manual path and fail on base drift.
**Bucket:** A — exact target matrix is verified (G-401, G-402, G-403).
**Depends on claims:** G-401, G-402, G-403

### FR-402 — Deterministic briefing reducer
**Requirement:** `briefing-truth-reconciler` MUST normalize task/event/calendar/email/meeting/memory/CRM/finance evidence without side effects.
**Acceptance:**
- WHEN sources arrive THE SYSTEM SHALL emit deterministic records/order/digest containing source identity, subject, observed time, authority, class, claim/state, and artifact reference.
**Bucket:** C — the source adapters exist, but the normalization schema/core is a new candidate (G-404, G-405).
**Depends on claims:** G-404, G-405

### FR-403 — Authority/conflict reduction
**Requirement:** The reducer MUST retain conflicting claims and select only by declared precedence and observation time.
**Acceptance:**
- WHEN claims disagree THE SYSTEM SHALL emit both plus conflict/unknown and SHALL NOT silently choose.
**Bucket:** B — staged prose exists; deterministic reducer absent (G-405).
**Depends on claims:** G-405

### FR-404 — Open-loop lifecycle
**Requirement:** The reducer MUST classify owner and lifecycle with terminal evidence.
**Acceptance:**
- WHEN a loop is observed THE SYSTEM SHALL classify Josh-owned/agent-owned/waiting-on-them/non-task and open/completed/abandoned/superseded/still-waiting with owner, last change, next action/trigger.
- WHEN terminal evidence is absent THE SYSTEM SHALL not mark completed.
**Bucket:** B — task fields exist; lifecycle reducer is new (G-404).
**Depends on claims:** G-404

### FR-405 — Morning-review adapter only
**Requirement:** Each `morning-review` target MUST acquire sources, call the same reducer contract, and render consequential deltas/durable refs without reimplementing truth logic.
**Acceptance:**
- WHEN invoked on enabled eligible surfaces THE SYSTEM SHALL resolve the target-specific path and produce semantically equivalent reconciliation output. Disabled Claude copies remain evidence-only; Muse remains excluded until the zero-activation prerequisite passes.
**Bucket:** B — staged delta is valid only on Codex base today (G-401, G-402).
**Depends on claims:** G-401, G-402

### FR-406 — CRM state evidence
**Requirement:** `crm-state-evidence` MUST preserve canonical identity, source provenance, and idempotent projection while existing `crm-record` remains sole writer.
**Acceptance:**
- WHEN an event is projected THE SYSTEM SHALL key/receipt by stable `source_ref` plus `{org_id,entity_type,canonical_id}` and emit read-before-write old/new/conflict evidence.
- WHEN aliases exist THE SYSTEM SHALL bind `{alias_type,alias_value,canonical_id,authority_source,observed_at}`; conflicting alias ownership quarantines instead of merging.
- WHEN evidence is emitted THE SYSTEM SHALL include source version/digest, writer receipt ID, prior/new canonical record digest, lifecycle state, and terminal read-back result from `crm-record`.
**Bucket:** B — existing writers/IDs are verified; evidence envelope is new (G-406).
**Depends on claims:** G-406

### FR-407 — CRM lifecycle contract
**Requirement:** CRM evidence MUST model waiting/completed/abandoned/superseded states without mutating from the reconciler.
**Acceptance:**
- WHEN lifecycle fields are unavailable THE SYSTEM SHALL retain proposed state as unknown and route any later write only through `crm-record` under separate authority.
**Bucket:** B — writer contract exists; exact lifecycle extension must be planned after schema inspection (G-406).
**Depends on claims:** G-406

### FR-408 — Finance truth ledger
**Requirement:** `finance-truth-ledger` MUST separate raw and derived facts with account/source ID, as-of/period, transaction state, currency, classification basis, confidence, and unknowns.
**Acceptance:**
- WHEN a fact enters THE SYSTEM SHALL retain immutable provenance and SHALL NOT silently net/reclassify.
**Bucket:** C — analyst exists, but the provenance ledger schema is a new candidate (G-407).
**Depends on claims:** G-407

### FR-409 — Finance reconciliation
**Requirement:** The finance ledger MUST reconcile opening + inflows − outflows = closing per account/currency/period and retain discrepancies.
**Acceptance:**
- WHEN equation fails or currencies differ THE SYSTEM SHALL emit discrepancy and forbid forecast-ready status.
**Bucket:** C — the reconciliation schema/validator is new and live provider availability is not claimed (G-407).
**Depends on claims:** G-407

### FR-410 — Fail-closed classification/declassification
**Requirement:** Every input/derived output MUST carry the highest source confidentiality; declassification requires explicit authorized receipt.
**Acceptance:**
- WHEN labels are missing/mixed THE SYSTEM SHALL quarantine or use highest restriction.
- WHEN no declassification receipt exists THE SYSTEM SHALL emit generalized schema only, never names/values/excerpts/source IDs/linkable combinations.
**Bucket:** B — classes exist; enforcement helper is new (G-408).
**Depends on claims:** G-408

**Normative contract:** `../confidentiality-contract-v2.json`; the validator follows its decision order and result enum, retains source bytes in their origin partition, and emits no raw confidential content in receipts.

## 5. Target matrix
| Targets | Runtime/path class | Base SHA | Disposition |
|---|---|---|---|
| `pa-codex`, `frank2-codex` | enabled plugin targets | `13891dfac155e384de06a3b2b9e6327774f0e26064d25a93bdcad81a3668df31` | target-specific rebase |
| `pa`, `frank2` | disabled `.claude/skills` evidence | `36eac3e25719e5b74686a5d3edd26fb3d384142d5738a251bc8d4e1cc7213da5` | exclude; never install |
| `muse` | enabled-but-blocked `.claude/skills` target | `93bac1074bcba0361868e2d095fbefd2afaabd0db7eacde9bd77a345f72e99bb` | exclude until legacy zero-activation prerequisite; then fresh rebase |
| Academy/community/templates | disabled/scaffold | divergent | not targets |

## 6. Grounding Ledger
| ID | Claim | Probe | Evidence | Verdict |
|---|---|---|---|---|
| G-401 | Five known copies span three bases; three runtime surfaces are enabled | `cortextos bus list-agents --format json`; exact path/hash inventory | enabled: pa-codex, frank2-codex, muse; disabled evidence: pa, frank2 | VERIFIED |
| G-402 | Staged bundle is Codex-base-specific | staged-vs-live diff and invocation line | additive delta against `13891dfa…`; Codex plugin path embedded | PARTIAL |
| G-403 | Agent-local runtime root owns precedence | inspect `src/cli/add-agent.ts:107-108` and local triggers | Codex plugin and Claude `.claude` roots differ | VERIFIED |
| G-404 | Task contract exposes identity/lifecycle fields | `src/types/index.ts:50-94` | status/owner/org/project/timestamps/outputs/blockers/due/escalation fields | VERIFIED |
| G-405 | Morning-review currently mixes acquisition, mutation, prose | inspect live skill/staged delta | no deterministic reducer; staged rules are prose | VERIFIED |
| G-406 | `crm-record` owns stable writers/idempotency/stage history | inspect skill SHA `5ce5b3ec…` | source_ref/idempotency/aliases/stage_history/no-op rules | VERIFIED |
| G-407 | Finance analyst exists but is not a provenance ledger | inspect skill SHA `efa87c29…` | forecasting/budget consumer; configured sources assumed | VERIFIED |
| G-408 | Governing classes/partition rules exist | runtime schema/master spec | partitioned classes; no transition helper | PARTIAL |

## 7. Feasibility summary
| Bucket | FRs | Meaning |
|---|---|---|
| A | FR-401 | Inventory is fully grounded |
| B | FR-403-05, FR-406-07, FR-410 | New adapters over existing sources |
| C | FR-402, FR-408, FR-409 | New reducer/finance schemas and validators |
| D | — | live provider ingestion is explicitly not claimed |

## 8. Accepted assumptions
None. Provider availability is out of scope; CRM lifecycle extension remains a later writer-plan detail, not a verified schema claim.

## 9. Handoff and changelog
Goal 2 review cannot author rebases. Later authoring emits one complete bundle per pinned enabled target and CAS rollback receipts.

- 2026-08-24 — v2.0 grounded 8 claims; adversarial convergence pending.
