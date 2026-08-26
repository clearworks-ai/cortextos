---
title: Task Observer Improvement Program — Master Spec
project: cortextOS Task Observer
area: internal
type: spec
status: correction-review-not-pass
repo: /Users/joshweiss/code/cortextos
base-branch: origin/main
mockup: N/A — backend only
version: 2.0
date: 2026-08-24
keywords:
  - task-observer
  - skills
  - confidentiality
  - provenance
  - goalify
---

# Task Observer Improvement Program — Master Spec

## 1. Goal

Convert the accepted fleet review into a fully grounded, reversible planning program for exactly eight existing-skill improvements and ten new-skill contracts. This spec authorizes specification and independent review only. It does not authorize bundle authoring, installation, activation, or live skill mutation.

**In scope:** master governance, four bounded domain sub-specs, deterministic target/rebase rules, ownership boundaries, confidentiality enforcement, legacy negative activation, parent binding, and review gates.

**Explicitly out of scope:** live skill application; Goal 3/4 execution; ClearPath or Academy improvement/reactivation; daemon changes; merge, push, deploy, or external delivery.

## 2. Constitution check

| Invariant | How this spec satisfies it |
|---|---|
| Task Observer reviews stage complete bundles and never edit installed skills | FR-003 and FR-007 keep authoring/install gates separate and blocked |
| Client and personal evidence remain partitioned | FR-004 defines fail-closed classifications and declassification receipts |
| ClearPath and Academy are retired and excluded | FR-005 requires clean-room lineage and negative activation proof |
| Duplicate skill installs cannot be updated ambiguously | FR-006 requires a canonical target map and surface-specific rebase/exclusion |
| Lower findings cannot disappear | FR-008 binds every finding to a closure row |

## 3. UI mockup

No UI surface; mockup gate N/A. The review and approval surface remains immutable Markdown/JSON artifacts and `.skill` archives. A later change that adds a visual approval surface requires its own UI spec and approved HTML mockup.

## 4. Program decomposition

The Phase 1 scope check found four independent domains. Each is specified separately and is independently reviewable; none may absorb another domain silently.

| Sub-spec | Existing improvements | New-skill contracts |
|---|---|---|
| `specs/infrastructure.md` | `task-observer`, `agent-management`, `agent-browser`, `activity-channel` | `authority-cutoff-ledger`, `herdr-ccgram-session-lifecycle`, `fleet-restart-conductor` |
| `specs/audit-research.md` | `audit-pipeline`, `audit-assemble-master`, `source-collection` | `audit-evidence-ledger`, `research-claim-ledger` |
| `specs/creative-client-delivery.md` | none; legacy archive is forensic only | `creative-deliverable-acceptance`, `client-artifact-acceptance` |
| `specs/state-and-briefing.md` | `morning-review` | `crm-state-evidence`, `finance-truth-ledger`, `briefing-truth-reconciler` |

Count gate: eight existing improvements and ten new-skill contracts exactly. `clearpath-content-pipeline` is not an improvement target and is not counted.

## 5. Requirements

### FR-001 — Bounded sub-spec authority

**Requirement:** The program MUST preserve the master/four-sub-spec boundary and exact 8/10 scope.

**Acceptance:**
- WHEN a planner enumerates program work THE SYSTEM SHALL resolve every item to exactly one owning sub-spec and report counts `8 existing / 10 new`.
- WHEN an item would appear in two sub-specs THE SYSTEM SHALL fail validation until one owner and an adapter relationship are recorded.

**Bucket:** A — the task authority and file decomposition are locally verifiable (G-001, G-002, G-003).

**Depends on claims:** G-001, G-002, G-003

### FR-002 — Planner-neutral requirements

**Requirement:** Every sub-spec MUST define stable FRs, EARS acceptance, claim references, and reasoned feasibility buckets.

**Acceptance:**
- WHEN any sub-spec is validated THE SYSTEM SHALL reject missing FR/EARS/bucket/claim fields.
- WHEN a feasibility claim changes THE SYSTEM SHALL require the ledger evidence and bucket reason to change together.

**Bucket:** A — the Specify validator exists and runs locally (G-004).

**Depends on claims:** G-004

### FR-003 — Gate sequencing

**Requirement:** Review, staged authoring, and installation MUST remain distinct gates.

**Acceptance:**
- WHEN Goal 2 review is active THE SYSTEM SHALL permit read-only inspection and spec correction only.
- WHEN Goal 2 is not PASS THE SYSTEM SHALL block Goal 3 authoring and Goal 4 installation/activation.

**Bucket:** A — current task state and governing review prove the hard hold (G-005).

**Depends on claims:** G-005

### FR-004 — Confidentiality enforcement

**Requirement:** Every proposed input, output, observation, bundle, and receipt MUST carry an enforceable confidentiality class and allowed transition.

**Acceptance:**
- WHEN client/personal evidence is generalized THE SYSTEM SHALL require an internal source reference, transformation receipt, privacy scan, named reviewer, and output class; missing evidence SHALL fail closed.
- WHEN an artifact is marked `open_source` or `public_ready` THE SYSTEM SHALL contain no client identifier, private path, account data, or raw excerpt.

**Bucket:** B — partition/schema primitives exist, but transition validators and receipts must be specified/implemented (G-006).

**Depends on claims:** G-006

**Normative contract:** `confidentiality-contract-v2.json` defines the ordered class lattice, join, transition decision order, receipt fields/authority, quarantine, and retention. Implementations may not substitute the current two-value runtime observation schema for this program contract.

### FR-005 — ClearPath/Academy clean-room exclusion

**Requirement:** The program MUST prevent the retired ClearPath/Academy skill from being installed, routed, copied, renamed, or used as a successor base.

**Acceptance:**
- WHEN any later artifact targets `creative-deliverable-acceptance` THE SYSTEM SHALL build from a blank product-neutral template and fail if forbidden legacy identifiers, paths, endpoints, org IDs, triggers, or archive lineage appear.
- WHEN enabled Muse is inspected THE SYSTEM SHALL report current live legacy routes as a blocking PARTIAL prerequisite; clean-room specification may proceed, but later candidate authoring, installation, and activation SHALL remain blocked until a separate authorized cleanup produces zero live routes.
- WHEN the forensic archive is preserved THE SYSTEM SHALL retain its exact hash while `install_eligible=false` and `improve_or_reactivate=false` remain parent-bound.

**Bucket:** B — exclusion metadata exists; clean-room and negative-activation validators are new work (G-007, G-008).

**Depends on claims:** G-007, G-008

### FR-006 — Deterministic target and rebase policy

**Requirement:** Each existing-skill improvement MUST declare every enabled live target, canonical precedence, live base hash, staged base hash, and one of `rebase`, `exclude`, or `already-equivalent`.

**Acceptance:**
- WHEN enabled copies differ THE SYSTEM SHALL produce surface-specific rebases or explicit exclusions and SHALL NOT install one archive across divergent bases.
- WHEN a target changes after review THE SYSTEM SHALL invalidate the prior review and require a fresh diff/hash/validator receipt.

**Bucket:** B — target policy metadata now exists; full recursive tree/backup manifests remain later-gate work (G-009).

**Depends on claims:** G-009

### FR-007 — Immutable parent binding and reversibility

**Requirement:** One parent manifest MUST bind the master, all sub-specs, closure matrix, ledgers, review outputs, validator receipts, future staged bundles, and rollback sources by canonical path, mode, byte length, and SHA-256.

**Acceptance:**
- WHEN any child byte changes THE SYSTEM SHALL fail parent verification until the parent is regenerated and re-reviewed.
- WHEN a later installation is proposed THE SYSTEM SHALL name the exact pre-install bytes and deterministic rollback target for every surface.

**Bucket:** B — current planning tree is parent-bound; final review/validator children and later rollback tree sources remain pending (G-010).

**Depends on claims:** G-010

### FR-008 — Finding closure and convergence

**Requirement:** Every prior CRITICAL/HIGH/MEDIUM/LOW finding MUST have a closure row and both independent review tracks MUST converge to zero CRITICAL/HIGH before Goalify.

**Acceptance:**
- WHEN a finding is corrected THE SYSTEM SHALL link it to changed artifact paths, evidence, and reviewer disposition.
- WHEN any review round retains CRITICAL or HIGH THE SYSTEM SHALL remain in correction; after three rounds without convergence THE SYSTEM SHALL halt further dispatch and escalate with every open finding and disposition.

**Bucket:** A — the rejected review supplies a complete finding set and the review loop is procedural (G-011).

**Depends on claims:** G-011

## 6. Clarification decisions

All ownership/overlap rows are resolved for this correction cycle; none remain open.

| Decision | Resolution | Reason |
|---|---|---|
| Evidence ledger vs domain workflow | Ledger owns schema/validation; workflow skill is an adapter/producer/consumer | Prevent incompatible parallel ledgers |
| `creative-deliverable-acceptance` vs `client-artifact-acceptance` | Client artifact owns generic package/provenance/privacy acceptance and the sole terminal package decision; creative owns render/voice/platform adapter checks | One generic core, one creative adapter |
| `audit-assemble-master` vs client artifact core | Audit assembler owns audit-specific assembly and is only an adapter/consumer of the generic client-artifact decision; it cannot issue the generic terminal acceptance | Prevent a second package-acceptance authority |
| Research claim vs audit evidence | `research-claim-ledger` owns claim truth/provenance; `audit-evidence-ledger` references immutable claim IDs and owns finding/recommendation/outcome lineage without copying or readjudicating claims | Preserve one truth authority and one audit reasoning authority |
| `briefing-truth-reconciler` vs `morning-review` | Reconciler owns deterministic source/state reduction; morning review owns Josh-facing selection/prose | Separate truth computation from narration |
| Infrastructure candidates | Authority cutoff, session lifecycle, and restart conductor remain separate because their state machines and mutation boundaries differ | Avoid a catch-all fleet skill |
| Duplicate installs | Enabled runtime surface wins; divergent enabled copies receive explicit rebases or exclusions; archive/disabled copies are never targets | Deterministic and reversible |

## 7. Grounding Ledger

| ID | Claim | Probe | Evidence | Verdict |
|---|---|---|---|---|
| G-001 | Program task names 8 existing and 10 candidate skills | `cortextos bus list-tasks --agent larry-codex --format json` then select `task_1787545824115_45589776` | description enumerates 8 existing and 10 new contracts | VERIFIED |
| G-002 | Four bounded domains cover every existing improvement once | compare §4 list to task | 4+3+0+1 = 8; no duplicate | VERIFIED |
| G-003 | Four bounded domains cover every new contract once | compare §4 list to task | 3+2+2+3 = 10; no duplicate | VERIFIED |
| G-004 | Specify structural validator is callable | `node .../specify/scripts/validate-spec.mjs --selftest` | local zero-dependency validator present; self-test command defined | VERIFIED |
| G-005 | Current improvement task is blocked after Goal 2 rejection | `cortextos bus list-tasks --agent larry-codex --format json` then select `task_1787545824115_45589776` | `status: blocked`; no Goal 3/4 authority | VERIFIED |
| G-006 | Runtime observations are confidentiality partitioned | inspect `state/task-observer-v1/schema.json` and partition modes | org/agent paths, visibility field, 0700/0600 runtime modes | VERIFIED |
| G-007 | Legacy archive is parent metadata-excluded | inspect `manifest.json`, `correction-ledger.json`, `eligibility-matrix.json` | `SUPERSEDED/DO-NOT-APPLY`, preserved, install false | VERIFIED |
| G-008 | Enabled Muse still exposes the legacy live skill | `test -f orgs/clearworksai/agents/muse/.claude/skills/clearpath-content-pipeline/SKILL.md` | file exists; live SHA pinned in creative sub-spec | VERIFIED |
| G-009 | Known skill copies diverge by runtime class | validate `target-manifest-v2.json` against enabled inventory and hash every known copy | `morning-review` has enabled Codex/Muse bases plus disabled evidence base; `audit-assemble-master` has one enabled target and disabled divergent evidence | VERIFIED |
| G-010 | Current manifest omits full corrected artifact tree | inspect `manifest.json.files[]` | only original four planning children are bound | VERIFIED |
| G-011 | Goal 2 review is NOT PASS | hash/read `reviews/goal-2-independent-review.md` | 2 CRITICAL / 10 HIGH combined; lower findings preserved | VERIFIED |

Probed against local repo `/Users/joshweiss/code/cortextos` at HEAD `2d13075c00e500d8fb35178a9af6a430171b8633`; fetched `origin/main` at `15defb1307df39f2df77522e70737c46dac52079` on 2026-08-24. All probes were read-only.

## 8. Feasibility summary

| Bucket | FRs | Meaning |
|---|---|---|
| A — buildable now | FR-001, FR-002, FR-003, FR-008 | Planning structure and review machinery exist |
| B — needs work in existing artifacts | FR-004, FR-005, FR-006, FR-007 | Validators, target metadata, review receipts, and parent binding require later implementation/finalization |
| C — needs new schema/data | child FR-107/202/205/206/301/302/402/408/409 | Candidate ledgers, acceptance cores, reducer, and finance schemas do not exist |
| D — needs unavailable capability | child FR-108 | Authenticated atomic Herdr/CCGram gateway prerequisite FR-111 is absent |

## 9. Accepted assumptions

None. All load-bearing master claims were settled locally. A future install target that cannot be probed becomes a new clarification row and cannot inherit this PASS.

## 10. Non-functional requirements

### Program gate state machine

| State | Allowed action | Entry guard | Exit |
|---|---|---|---|
| `G0_SPEC_CORRECTION` | edit planning artifacts; read-only probes | prior NOT PASS bound | structural precheck produces no failures other than truthfully pending convergence metadata |
| `G1_IMMUTABLE_DUAL_REVIEW` | two independent read-only reviews | prechecked packet frozen by parent hash | provisional `0 CRITICAL / 0 HIGH`; every lower finding dispositioned |
| `G2_FINALIZE_AND_CONFIRM` | append convergence metadata, rehash, rerun structural validators, then final read-only confirmation | provisional G1 zero | exact final bytes receive structural PASS and final dual `0 CRITICAL / 0 HIGH` |
| `G3_STAGED_AUTHORING` | author complete staged bundles only | separately authorized after G2 AND Muse zero-activation receipt PASS | staged hashes/diffs/reviews PASS |
| `G4_INSTALL_ACTIVATE` | CAS install/activation | separately authorized after G3; prerequisites including Muse zero-activation PASS | verified install/rollback receipt |
| `HALTED` | ACK/read only | any drift, failed validator, missing receipt, confidentiality violation, or stale authority | correction returns to G0 |

Current state is `G0_SPEC_CORRECTION`. No state transition is implied by writing this table.

### Deterministic validation contract

- Structural command: `node /Users/joshweiss/.agents/skills/_backup-bones-20260813/specify/scripts/validate-spec.mjs <absolute-spec-path>` for the master and each of four sub-specs; threshold: exit `0`, no CRITICAL/HIGH, and an actual zero-CRITICAL/HIGH convergence changelog row written only after reviewers converge.
- Parent command: recompute `mode`, `bytes`, and SHA-256 for every absolute child listed in the packet; threshold: exact equality, no omitted required child, and no self-hash claim.
- Target command: validate every path/hash/status in `target-manifest-v2.json` against the current enabled-agent inventory; threshold: zero unknown/drifted enabled targets and zero disabled targets marked installable.
- Confidentiality command: validate each transition against `confidentiality-contract-v2.json`; threshold: every downgrade has a hash-bound authorized receipt and every missing/unknown label is quarantined.
- Clean-room command: later scan only candidate/bundle/install inputs against the exact denylist artifact; threshold: zero forbidden legacy matches and passing false-positive fixtures.
- Audit assembly command: later invoke the bundle-relative interface specified by audit FR-203; threshold: exit `0`, valid JSON receipt, zero generalized-bundle client literals.
- Review threshold: both independent tracks must separately report `0 CRITICAL / 0 HIGH`; MEDIUM/LOW must have an explicit accepted, corrected, deferred-with-owner, or rejected-with-reason disposition.

- All planning/review probes are read-only.
- Hash and path comparisons are byte-derived and fail closed.
- No raw confidential content is copied into master or sub-spec artifacts.
- Validators produce machine-readable receipts and nonzero exit on failure.
- A future authoring cycle preserves full bundle contents and verifies archive safety.

## 11. Open follow-ups

- Separately authorized Muse legacy-route cleanup must produce a rollback-bound zero-activation receipt before G3 candidate authoring.
- FR-111 authenticated lifecycle gateway remains the prerequisite for infrastructure FR-108.
- Complete target tree/backup manifests, validator implementations, and candidate bundles are later G3 work, not authorized now.

## 12. Handoff notes

**For `/goalify`:** do not run until every sub-spec and this master validate, the closure matrix is complete, and both review tracks report zero CRITICAL/HIGH.

**For writing plans:** preserve master/sub-spec ownership, canonical target map, clean-room exclusion, and confidentiality transitions verbatim.

**For plan mode:** start from FR-003 gate sequencing; no authoring/install task may be inferred from this spec.

## Changelog

- 2026-08-24 — v2.0 correction draft. Eleven master claims probed; adversarial convergence pending.
