# Goal 2 independent review

Status: `NOT PASS`

Scope: read-only review of the four eligible existing-skill bundles, seven proposed candidate contracts, governing program specification, Goal condition, manifest, correction ledger, eligibility matrix, duplicate live install surfaces, and legacy exclusion. No staged or live skill bytes were changed.

## Verdict counts

- Logic/scope adversary: 2 CRITICAL, 7 HIGH, 3 MEDIUM, 1 LOW.
- Grounding verifier: 0 CRITICAL, 3 HIGH, 1 MEDIUM.
- Structural validator: `pass:false`, 10 failures.
- Advancement: Goalify, Goal 3 staging, Goal 4 installation/activation, and all live application remain blocked.

## CRITICAL

1. The program is not a Specify-compliant spec. It has no master/sub-spec decomposition, numbered FRs, EARS criteria, Grounding Ledger, feasibility buckets, clarification-gate dispositions, UI `N/A` record, or adversarial convergence changelog. The governing validator also reported missing required frontmatter. Treating it as Goalify-compatible can drop domains and turn unresolved assumptions into executable work.
2. ClearPath/Academy exclusion is prose-only. The successor allowance lacks a clean-room derivation rule, forbidden path/identifier/dependency inventory, lineage validator, and negative activation tests. A renamed copy could satisfy the words while reactivating legacy routing.

## HIGH — logic and sequencing

1. Duplicate live-install surfaces and precedence are not grounded or pinned.
2. Ownership/overlap is unresolved between the seven candidates and four existing improvements; there is no core-vs-adapter model or invocation precedence.
3. `SPEC.md` separates G2/G3/G4, while `GOAL-CONDITION.md` collapses them; G2 also says to rebase bundles even though authoring is reserved for a later separately authorized gate.
4. The acceptance condition permits premature completion after only G0/G1.
5. Goal 2 asks un-authored candidates for reversible staged paths, conflating intended destination with existing artifact evidence.
6. Confidentiality labels lack enforceable input/output transitions, declassification authority, validators, retention, and fail-closed rules.
7. Reproducibility is incomplete: canonical paths, full parent-tree binding, sub-specs, review receipts, and validator outputs are absent.

## HIGH — grounded bundle defects

1. `morning-review` has five enabled targets across three distinct bases. The staged delta is fresh only against the Codex base and hard-codes a Codex-only invocation path. The program does not select targets or require surface-specific rebases/exclusions.
2. `audit-assemble-master` preserves a mandatory `assembly-check.py` command pointing at a nonexistent legacy `agents/auditmaster/...` path instead of the enabled Codex surface.
3. The same complete archive embeds a client-specific `deliverables/msia/` path in `assembly-check.py`, contradicting `generalized_rules_only` and the program confidentiality claim.

## MEDIUM/LOW summary

- Eligibility has no state machine, owner, transition, blocker, terminal receipt, or rollback target.
- G6 labels have no exact commands/thresholds.
- UI gate is likely N/A but not recorded.
- Version/date/changelog lineage is missing.
- Enabled Muse still exposes the legacy `clearpath-content-pipeline`; later gates require explicit zero-activation/routing proof even though the staged legacy archive itself is correctly excluded.

## Integrity checks that passed

- Governing review and domain-manifest hashes reproduce.
- Program manifest file hashes, bytes, and modes reproduce.
- All five archives reproduce their declared SHA, pass archive integrity, match staged directories byte-for-byte, and contain no unsafe archive paths.
- `audit-pipeline` and `source-collection` are clean additive deltas against their enabled canonical bases.
- `clearpath-content-pipeline` is consistently `SUPERSEDED/DO-NOT-APPLY` in the current planning artifacts and was not applied.

## Required correction before re-review

Create one master program spec plus bounded domain sub-specs; add FR/EARS/bucket rows and a probe-backed Grounding Ledger for every live/duplicate/staged/activation surface; resolve overlap/ownership at the clarification gate; make ClearPath/Academy exclusion mechanically testable; align G2/G3/G4 and remove authoring from review; define confidentiality transitions and validators; repair the bundle-specific path/confidentiality defects; run grounding and logic rounds to zero CRITICAL/HIGH; run structural validation to exit 0; then pin the entire artifact/review tree in a parent manifest before Goalify.
