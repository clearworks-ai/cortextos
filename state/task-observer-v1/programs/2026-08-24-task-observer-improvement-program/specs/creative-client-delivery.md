---
title: Creative and Client Artifact Acceptance — Sub-spec
project: cortextOS Task Observer
area: internal
type: spec
status: correction-review-not-pass
repo: /Users/joshweiss/code/cortextos
base-branch: origin/main
mockup: N/A — backend only
version: 2.0
date: 2026-08-24
keywords: [creative, artifact, legacy, clearpath, confidentiality]
---

# Creative and Client Artifact Acceptance — Sub-spec

## 1. Goal
Specify a product-neutral client artifact core and creative adapter while mechanically excluding ClearPath/Academy lineage.

**In scope:** `client-artifact-acceptance`, `creative-deliverable-acceptance`, clean-room lineage, Muse/Academy negative activation.

**Out of scope:** modifying/removing live legacy files, authoring candidate bundles, client artifacts, or UI changes.

## 2. Constitution check
| Invariant | Satisfaction |
|---|---|
| ClearPath/Academy never become a target/base | FR-303/04 clean-room and denylist |
| Muse zero-activation is proven, not inferred from crons | FR-304 scans bootstrap+runtime+skills |
| Generic core and creative adapter do not duplicate authority | FR-301/CRE01 ownership |
| Public output never declassifies private sources implicitly | FR-307 |

## 3. UI mockup
No UI/review surface; mockup gate N/A. Format checks operate on artifacts produced elsewhere.

## 4. Requirements

### FR-301 — Generic client artifact acceptance
**Requirement:** `client-artifact-acceptance` MUST own scope/coverage, evidence/citation, confidentiality, rights/approval, package manifest/hash, filename/link/openability/access, recipient boundary, and terminal decision.
**Acceptance:**
- WHEN an artifact enters acceptance THE SYSTEM SHALL issue ACCEPTED only if all required checks and delegated adapter receipts bind the exact artifact/package hashes.
- WHEN any check is absent/failed/stale THE SYSTEM SHALL issue REJECTED or PARTIAL, never infer acceptance.
**Bucket:** C — candidate is absent and requires a new contract/bundle (G-301).
**Depends on claims:** G-301

### FR-302 — Creative acceptance adapter
**Requirement:** `creative-deliverable-acceptance` MUST own render/page/frame/mobile/overflow, dimensions/crop/safe areas, hierarchy/contrast/legibility/accessibility, asset identity, brand/voice/Humanizer checks.
**Acceptance:**
- WHEN the core classifies an artifact creative THE SYSTEM SHALL invoke the adapter and bind its receipt to exact bytes.
- WHEN the adapter passes THE SYSTEM SHALL return its result to core and SHALL NOT authorize package/delivery itself.
**Bucket:** C — candidate is absent; format-specific skills exist but no unifying contract (G-301).
**Depends on claims:** G-301

### FR-303 — Clean-room authoring
**Requirement:** Both candidates MUST begin in blank directories from these sanitized specs with no legacy parent/path/hash/dependency. The scanner scope is the future candidate directories, bundle manifests, dependency graph, archives, and installer inputs; the immutable forensic ledger and these specification documents are explicitly evidence-only and exempt from token matching.
**Acceptance:**
- WHEN source lineage or archives are scanned THE SYSTEM SHALL reject legacy inode/symlink/hardlink/archive reuse and every forbidden token/path/dependency outside the forensic ledger.
**Bucket:** B — negative scanners/manifest rules must be added (G-302, G-309).
**Depends on claims:** G-302, G-309

### FR-304 — Muse zero-activation prerequisite
**Requirement:** Before candidate authoring, installation, or activation, Muse MUST have zero legacy routing matches across live skills, indexes, `AGENTS/CLAUDE/SYSTEM/TOOLS`, config, current crons, and runtime launch receipts. Specification and read-only clean-room design MAY proceed while that prerequisite is PARTIAL.
**Acceptance:**
- WHEN any legacy route remains THE SYSTEM SHALL keep later authoring/install gates blocked and report exact path/line.
- WHEN only current cron prompts are clean THE SYSTEM SHALL report PARTIAL, not zero activation.
**Bucket:** B — current state is PARTIAL because enabled Muse still explicitly routes legacy skill (G-303, G-304, G-305, G-306).
**Depends on claims:** G-303, G-304, G-305, G-306

**Owned predecessor gate:** a separately authorized Muse-cleanup task owned by Muse's runtime owner must pin pre-change tree/route hashes and rollback bytes, remove only live legacy activation/routing, rerun the exact `clean-room-denylist-v2.json` route inventory, and emit `{task_id,owner,pre_tree_sha,post_tree_sha,rollback_sha,scanned_paths,match_count=0,validator_sha,receipt_sha}`. Until that terminal receipt is parent-bound, G3 authoring for both creative/client candidates remains blocked.

### FR-305 — Academy runtime and residue classification
**Requirement:** Academy MUST remain disabled/not-running/zero-current-crons, while dormant residue is separately inventoried and excluded.
**Acceptance:**
- WHEN Academy runtime is checked THE SYSTEM SHALL prove all three runtime negatives and SHALL NOT treat dormant files/backups as live targets.
**Bucket:** A — runtime negatives and residue are verified (G-307, G-308).
**Depends on claims:** G-307, G-308

### FR-306 — Installer denylist
**Requirement:** Every future installer allowlist MUST deny skill name `clearpath-content-pipeline`, archive SHA `063beaf57e361a1f2ea462b5d15b39158b28295effe6c2af113b8b5087368ca7`, and all forbidden legacy tokens/paths.
**Acceptance:**
- WHEN the forensic archive is encountered THE SYSTEM SHALL preserve it outside install roots with `install_eligible=false` and reject it as source/target.
**Bucket:** B — exact archive/disposition are pinned, but the installer scanner and receipt do not yet exist (G-302, G-309).
**Depends on claims:** G-302, G-309

### FR-307 — Confidentiality transitions
**Requirement:** Core and adapter MUST inherit the highest input restriction and may emit generalized/open output only through an explicit minimized declassification receipt.
**Acceptance:**
- WHEN mixed classes join THE SYSTEM SHALL retain the highest restriction and partition tags.
- WHEN no authorized receipt exists THE SYSTEM SHALL emit schemas/checks/hashes only, never names, values, excerpts, source IDs, or linkable combinations.
**Bucket:** B — classes exist; deterministic transition validator is new (G-302).
**Depends on claims:** G-302

**Normative contract:** `../confidentiality-contract-v2.json`; missing classes/receipts quarantine, and only the named downgrade authority may declassify hash-bound bytes.

## 5. Forbidden clean-room inventory

The later clean-room validator reads an exact denylist artifact derived from the forensic ledger and scans only the future candidate source trees, dependency closure, archives, manifests, and installer inputs. It rejects exact legacy product identifiers, endpoints, organization identifiers, credentials/config keys, hosts, paths, and archive hashes. Generic protocol tokens are not forbidden unless paired with a legacy value. The forensic correction ledger, governing specs, review findings, and validator fixtures are evidence-only exemptions. The validator path, corpus, SHA, zero-match receipt, and false-positive fixtures are required before FR-303/306 may pass.

## 6. Grounding Ledger
| ID | Claim | Probe | Evidence | Verdict |
|---|---|---|---|---|
| G-301 | Both candidate skills are absent | exact directory search across repo and user skill roots | no candidate directories; planning mentions only | VERIFIED |
| G-302 | Legacy archive is forensic-only | inspect program/domain manifests and correction ledger | exact SHA pinned, `SUPERSEDED/DO-NOT-APPLY`, install false | VERIFIED |
| G-303 | Muse exposes legacy live skill | file/hash probe | live plain file SHA `35f57994…`; not symlink | VERIFIED |
| G-304 | Muse bootstrap explicitly routes legacy skill | inspect `CLAUDE.md:49`, `SYSTEM.md:22-28`, `CLAUDE-reference.md:29-39` | mandatory legacy API/skill routing remains | VERIFIED |
| G-305 | Muse is enabled/running | config/list-agents | enabled true, running true | VERIFIED |
| G-306 | Muse current crons lack direct legacy strings | parse three enabled crons | zero prompt matches; bootstrap routes remain | PARTIAL |
| G-307 | Academy runtime is inactive | config/list-agents/current crons | disabled, not running, zero current crons | VERIFIED |
| G-308 | Academy dormant residue remains | recursive config/bootstrap/backup inventory | legacy names/routes discoverable but inactive | PARTIAL |
| G-309 | Forensic archive integrity/disposition reproduce | hash/archive/manifest checks | SHA `063beaf5…`, archive clean, excluded | VERIFIED |

## 7. Feasibility summary
| Bucket | FRs | Meaning |
|---|---|---|
| A | FR-305 | Existing negative runtime evidence |
| B | FR-303, FR-304, FR-306, FR-307 | New validators and prerequisite cleanup required |
| C | FR-301, FR-302 | New skill contracts/bundles |
| D | — | none |

## 8. Accepted assumptions
None. Muse zero activation is explicitly not accepted today; it is a blocking prerequisite.

## 9. Handoff and changelog
Goal 2 may specify the prerequisite but cannot modify Muse/Academy or author candidates. Later authority must resolve Muse routing before authoring/activation.

- 2026-08-24 — v2.0 grounded 9 claims; adversarial convergence pending.
