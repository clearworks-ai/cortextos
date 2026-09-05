# F1 SPEC — legacy clean-room and exhaustive target inventory

Status: **DRAFT by Larry — NOT APPROVED, NOT IMPLEMENTATION AUTHORITY**

Task: `task_1787559952654_76501014`

This is the bounded F1 specification created after the source surface reproduced. It does not authorize Goalify, skill authoring, staging, installation, activation, legacy cleanup, or any mutation of a live, staged, template, snapshot, archive, or forensic skill byte.

## 1. Goal

Mechanically prove that no retired product value, endpoint, route, dependency, archive lineage, or enabled/duplicate skill surface can bypass review, and produce an exhaustive deterministic target/rebase disposition for every enabled and known duplicate copy.

F1 ends at a reviewed validator, corpus, fixtures, inventory, and target policy. F1 does not create or install improved skill bundles.

## 2. Frozen inputs

| Input | SHA-256 | Role |
|---|---|---|
| `DECOMPOSITION.md` | `a47bac0e9ef445ae06cd5e01f7e13c2c4cbac6d522856aee169d08a09cb68462` | lane authority and dependency order |
| `F1-SOURCE-SURFACE-CONTRACT.md` | `af84eea09d60023ec776201725f0b6db597f6a06b590794a05b37ea5cc9e3e4c` | discovery and acceptance boundary |
| `F1-INVENTORY-RECONCILIATION.md` | `eab0f0bb71b3ac3cc6216e384ffd3d38bf8291e4e7f86ba9383114036d13f653` | corrected 117/16 cardinality evidence |
| `F1-SURFACE-INVENTORY.json` | `7a24304abecc2661a17fdea943d27c349c720ae6d7cf163d105b1512d149e5ab` | 117 surfaces, 16 links, 147 recursive rows |
| `F1-DENY-FIXTURE-EVIDENCE-CONTRACT.json` | `fe5859b398a26484707cc9f7840c5d196b3f4fabeb63fbe2c154bf21c6f697bb` | corpus, fixture, decision, and receipt contract |
| legacy forensic bundle | `063beaf57e361a1f2ea462b5d15b39158b28295effe6c2af113b8b5087368ca7` | read-only deny-value/lineage evidence |
| immutable predecessor packet | `c52988e85f32a3192b31fd66f82bdb7a24112fc2d54e9211459ca7f5115d8ef6` | forensic findings only; never promoted |

Any byte drift in a frozen input invalidates the F1 review and returns the lane to `INPUT_DRIFT`.

## 3. Scope

In scope:

- exact normalized legacy deny values and lineage identities;
- clean-room positive, negative, false-positive, and invalid-input fixtures;
- an executable fail-closed validator and immutable receipts;
- all 117 exact `SKILL.md` surfaces, all 16 relevant links, and their 147 recursive tree rows;
- current runtime agent identities with `.DS_Store` and `_archive` rejected;
- deterministic classification, canonical precedence, rebase/exclude/equivalent policy, drift CAS, backup, rollback, and post-tree proof;
- explicit Maven and Muse dispositions;
- grounding, feasibility, finding closure, structural validation, and two independent reviews.

Out of scope:

- F2 authority/confidentiality state semantics;
- F3 publication/exactly-once infrastructure;
- F4 domain-skill changes;
- live or staged bundle mutation;
- Muse legacy-route cleanup;
- installation, activation, commit, push, merge, deploy, or production mutation.

## 4. Classification model

Every discovered surface MUST appear exactly once with one classification:

| Classification | Meaning | Install eligibility in F1 |
|---|---|---|
| `canonical_source` | community source used only as precedence evidence | false |
| `enabled_target` | enabled runtime copy whose `SKILL.md` matches the deterministic modal base | false |
| `enabled_blocked_target` | enabled or potentially enabled copy that diverges, lacks grounded config, or needs a surface-specific rebase | false |
| `disabled_evidence` | disabled runtime or compatibility copy retained as evidence | false |
| `template` | template/community-agent seed copy | false |
| `snapshot` | cutover or historical snapshot | false |
| `archive` | archive/deliverable evidence | false |
| `forbidden_legacy` | retired legacy skill or lineage | false forever |

Canonical precedence is: accepted reviewed live base for the exact enabled target, then canonical community source when present, then deterministic modal `SKILL.md` SHA only as a comparison baseline. Modal content MUST NOT silently overwrite a divergent enabled target.

## 5. Functional requirements and EARS acceptance

### F1-FR-001 — Immutable forensic separation

The system MUST preserve legacy and predecessor evidence without making it installable or authoritative.

- WHEN the legacy bundle or predecessor packet is loaded, THE SYSTEM SHALL verify its exact SHA before reading values.
- WHEN a later artifact references forensic evidence, THE SYSTEM SHALL mark it `read_only=true`, `install_eligible=false`, and `improve_or_reactivate=false`.
- IF a forensic SHA drifts, THEN THE SYSTEM SHALL return `INVALID_INPUT` and SHALL NOT scan or mutate targets.

### F1-FR-002 — Exhaustive surface and tree inventory

The system MUST enumerate every exact surface and recursively bind every byte.

- WHEN discovery runs, THE SYSTEM SHALL use `rg --files -uu` over `orgs`, `templates`, and `community` and exact covered-skill suffix matching.
- WHEN a surface is emitted, THE SYSTEM SHALL include absolute path, skill, classification, runtime config evidence, `SKILL.md` mode/bytes/SHA, and every recursive relative path/type/mode/bytes/SHA-or-link-target row.
- WHEN links are emitted, THE SYSTEM SHALL preserve literal and resolved targets and distinguish 13 Task Observer activations from 3 disabled OpenCode compatibility links.
- IF the surface count is not 117, link count is not 16, recursive row count is not 147, a path duplicates, or a link dangles, THEN THE SYSTEM SHALL return `INVALID_INPUT`.

### F1-FR-003 — Runtime identity filter

The system MUST derive valid runtime agents without trusting directory noise.

- WHEN runtime inventory is captured, THE SYSTEM SHALL hash the raw response and retain the exact row count.
- WHEN a row name is `.DS_Store`, `_archive`, empty, path-like, or fails the lowercase agent-name grammar, THE SYSTEM SHALL classify it as invalid and exclude it from enabled-target cardinality.
- IF an invalid identity is marked enabled by the raw registry, THEN THE SYSTEM SHALL record the registry defect and SHALL NOT promote it to a target.

### F1-FR-004 — Deterministic target disposition

Every known duplicate MUST receive exactly one disposition: `rebase`, `exclude`, or `already_equivalent`.

- WHEN an enabled target matches its approved comparison base recursively, THE SYSTEM SHALL emit `already_equivalent` with matching pre-tree and expected post-tree SHA.
- WHEN an enabled target differs, THE SYSTEM SHALL emit a target-specific `rebase` plan based on that target's fresh live tree; one archive SHALL NOT be applied across divergent bases.
- WHEN a surface is disabled evidence, template, snapshot, archive, or forbidden legacy, THE SYSTEM SHALL emit `exclude` with a reason and `install_eligible=false`.
- IF a surface is unknown or has more than one disposition, THEN THE SYSTEM SHALL return `INVALID_INPUT`.

### F1-FR-005 — Exact deny corpus

The system MUST build `legacy-deny-value-corpus.json` from immutable evidence and current live-route evidence.

- WHEN corpus records are created, THE SYSTEM SHALL include every field and kind required by `F1-DENY-FIXTURE-EVIDENCE-CONTRACT.json`.
- WHEN a value is sensitive, THE SYSTEM SHALL store a salted exact hash with an independently bound salt authority instead of raw plaintext.
- WHEN values are normalized, THE SYSTEM SHALL apply the ordered normalization pipeline exactly once and retain raw-source path/SHA lineage.
- IF a corpus source, hash, record field, salt authority, or kind is missing, THEN THE SYSTEM SHALL return `INVALID_INPUT`.

### F1-FR-006 — Clean-room fixture coverage

The system MUST prove deny behavior without false-failing generic protocol use.

- WHEN fixtures run, THE SYSTEM SHALL exercise all seven required negatives, both required positives, and every invalid-input case in the evidence contract.
- WHEN a renamed or copied candidate retains a legacy endpoint, normalized value, dependency, symlink, hardlink, route, or archive lineage, THE SYSTEM SHALL return the exact corresponding deny decision.
- WHEN a product-neutral bundle or generic protocol-only fixture contains no legacy value or lineage, THE SYSTEM SHALL return `PASS`.
- IF any expected decision differs, THEN the validator receipt SHALL be terminal `FAIL`.

### F1-FR-007 — Fail-closed validator and receipt

The system MUST provide one deterministic CLI whose evidence cannot self-authorize.

- WHEN invoked, THE VALIDATOR SHALL accept explicit corpus, fixture manifest, surface inventory, runtime inventory, and output-receipt paths; implicit discovery paths are forbidden.
- WHEN inputs are verified, THE VALIDATOR SHALL recompute every SHA, count, tree row, link target, hardlink identity, and expected fixture result before evaluating eligibility.
- WHEN complete, THE VALIDATOR SHALL write an atomic immutable receipt containing all fields required by the evidence contract and use process exit codes `0=PASS`, `2=DENY`, `3=INVALID_INPUT`, `4=INTERNAL_ERROR`.
- IF the validator executable hash is not pinned by an external manifest, THEN its `PASS` field SHALL be non-promotional evidence only.

### F1-FR-008 — Maven and Muse proof

The system MUST explicitly close the two known divergent legacy/runtime cases.

- WHEN Maven surfaces are evaluated, THE SYSTEM SHALL identify each enabled runtime path, recursive tree digest, modal/base relationship, and exact rebase/equivalent disposition separately.
- WHEN Muse surfaces are evaluated, THE SYSTEM SHALL classify `clearpath-content-pipeline` as `forbidden_legacy`, preserve its live and forensic hashes, and report any live route or bootstrap reference as blocking later authoring/activation.
- UNTIL a separately authorized Muse cleanup produces a rollback-bound zero-activation receipt, THE SYSTEM SHALL keep any successor skill authoring and activation closed.

### F1-FR-009 — CAS, backup, transaction, and rollback policy

The system MUST define later mutation safety without performing mutation in F1.

- WHEN a future install packet is prepared, THE SYSTEM SHALL bind each target's fresh pre-tree SHA, reviewed staged base SHA, expected post-tree SHA, backup path/SHA, and rollback tree SHA.
- IF any target changes after review, THEN compare-and-swap SHALL fail before the first write and invalidate the review.
- WHEN multiple targets belong to one approved transaction, THE SYSTEM SHALL preflight all targets before writing, install atomically, verify every post-tree, and roll back all written targets on any failure.
- WHEN a staged bundle is multi-file, THE SYSTEM SHALL deliver the complete `.skill` bundle and verify its archive listing; a bare `SKILL.md` is invalid.

### F1-FR-010 — Review and promotion gate

F1 MUST fail closed until exact final bytes pass all reviews.

- WHEN corpus, fixtures, validator, inventory, disposition map, grounding ledger, feasibility ledger, closure matrix, and manifest are frozen, THE SYSTEM SHALL compute one parent manifest over the complete tree.
- WHEN independent review runs, one reviewer SHALL cover grounding/provenance and one different reviewer SHALL cover logic/scope; each SHALL report severity counts.
- IF either review has any Critical or High finding, any artifact drifts, or structural validation fails, THEN F1 SHALL be `NOT_CONVERGED` and F2 SHALL remain blocked.
- WHEN and only when both reviews are `0C/0H`, deterministic validation passes, and an explicit promotion decision is recorded, F1 MAY become terminal `PASS` and open F2 planning.

## 6. Required F1 outputs

1. `legacy-deny-value-corpus.json`
2. `clean-room-fixture-manifest.json` plus pinned fixture tree
3. validator source and executable contract
4. validator positive/negative/invalid-input receipt
5. `surface-inventory.json` derived from the accepted 117/16/147 evidence
6. `target-disposition.json` with exactly one disposition per surface/link
7. `maven-muse-proof.json`
8. `grounding-ledger.json`
9. `feasibility-ledger.json`
10. `finding-closure-matrix.md`
11. deterministic structural validator receipt
12. independent grounding and logic review receipts
13. complete parent manifest and explicit promotion decision

No output path may overlap a live skill, a current staged review bundle, a template, snapshot, archive, or forensic input.

## 7. Grounding and feasibility ledger

| ID | Claim | Evidence | Bucket | Remaining proof |
|---|---|---|---|---|
| G-001 | exact file inventory is 117 | `F1-SURFACE-INVENTORY.json` SHA `7a24304a…5ab` | A — verified | independent review of final bytes |
| G-002 | relevant links are 13 Task Observer activations plus 3 disabled OpenCode links | same inventory | A — verified | none before final review |
| G-003 | recursive binding is 147 rows with zero dangling links | same inventory | A — verified | final drift replay |
| G-004 | raw runtime registry contains enabled `_archive` and `.DS_Store` noise | runtime snapshot SHA `d804c567…11e3` inside inventory | A — verified | validator identity-filter fixture |
| G-005 | legacy forensic bundle is preserved at SHA `063beaf5…ca7` | frozen input | A — verified | corpus extraction ledger |
| G-006 | enabled/duplicate surfaces diverge and need per-target policy | inventory classification: 37 enabled targets, 24 enabled blocked targets | A — verified | target-disposition artifact |
| G-007 | clean-room deny corpus can be built from pinned evidence | evidence contract SHA `fe5859b3…97bb` | B — bounded new work | corpus bytes and extraction receipt |
| G-008 | required negative/positive/invalid fixtures are executable | evidence contract | B — bounded new work | fixture tree and test receipt |
| G-009 | deterministic validator can enforce input drift and decisions | explicit FR-007 interface | B — bounded new work | implementation, tests, external hash binding |
| G-010 | Maven/Muse dispositions can be closed without live mutation | exact inventory rows and legacy SHA | B — bounded new work | dedicated proof artifact and route scan |
| G-011 | later multi-target install can be CAS/rollback bound | established atomic-write and staging conventions | C — design only in F1 | F3 implementation; not an F1 mutation |

No feasibility row is marked solved by prose alone. Bucket A means directly reproduced evidence; Bucket B means bounded implementation using present inputs; Bucket C means intentionally deferred implementation outside F1.

## 8. Finding closure matrix

| Finding | F1 disposition | Closure evidence required |
|---|---|---|
| C2 — rename/copy-bypassable legacy exclusion | FR-005/006/007 | deny corpus, renamed/copy/link/dependency fixtures, validator receipt |
| H1 — ungrounded/divergent live targets | FR-002/004/009 | 117/16/147 inventory plus one disposition and later CAS plan per row |
| H8 — divergent `morning-review` enabled bases | FR-004/008 | per-surface tree/base/disposition; no shared blind archive |
| M4 — enabled Muse legacy skill lacks zero-activation proof | FR-008 | forbidden classification now; later separate cleanup receipt before authoring |
| L1 — version/date/changelog lineage absent | FR-007/010 | schema versions, timestamps from live clock, full manifest lineage |
| R1 grounding H2/H3 — enabled targets/archive inventory incorrect | FR-002/003/004 | runtime raw hash, invalid identity filter, exhaustive classified rows |
| R1 grounding H4/M1 — clean room non-executable | FR-005/006/007 | executable fixtures and fail-closed receipt |
| R1 logic C1/H2 — unsatisfiable Muse gate | FR-008 | specification may finish; successor authoring remains blocked on separate zero-activation cleanup |
| R2 logic H4/H5/H6 — full trees, prior receipts, destinations absent | FR-002/007/009/010 | recursive trees, external validator binding, exact output roots, final parent manifest |
| R2 grounding H2/H3 — archive/activation/exclusion and precedence incomplete | FR-001/002/004 | exact classifications and one disposition per row |
| compressed command correctness risk | FR-007/010 | execute every embedded command against real data before freezing SPEC |

Items owned by F2, F3, or F4 are explicitly deferred and cannot be marked F1-closed.

## 9. State machine

`DISCOVERY_REPRODUCED` → `SPEC_DRAFT` → `SPEC_FROZEN` → `VALIDATOR_AND_FIXTURES_BUILT` → `STRUCTURAL_PASS` → `GROUNDING_REVIEW` + `LOGIC_REVIEW` → `F1_TERMINAL_PASS`.

Failure states are `INPUT_DRIFT`, `INVALID_INPUT`, `VALIDATION_FAIL`, and `NOT_CONVERGED`. Any failure leaves F2–F4 blocked. Correction returns to the earliest invalidated state; it does not open a broad predecessor review or mutate forensic evidence.

## 10. Pre-flight before freezing this SPEC

- Re-read all ten FRs and confirm each has executable EARS acceptance.
- Execute every embedded command and inspect output plausibility.
- Rehash every frozen input using the live filesystem.
- Machine-count required outputs, grounding rows, closure rows, surfaces, links, and tree rows.
- Confirm no live/staged/template/snapshot/archive/forensic skill byte changed.
- Confirm the exact implementation-approval marker is absent until all four planning gates pass.

Only after this pre-flight and a frozen-spec review may Larry mark the SPEC approved and issue any implementation handoff.
