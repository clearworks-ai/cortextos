# F1 source-surface and evidence contract

Status: active discovery contract only; substantive SPEC authoring begins after this source surface is independently reproducible.

## F1 question

Can the program mechanically prove that no legacy ClearPath/Academy value, endpoint, route, dependency, archive lineage, or enabled/duplicate skill surface can bypass review, while producing an exhaustive deterministic target/rebase classification for every enabled and known duplicate copy?

## Required source surfaces

### Forensic legacy evidence

- `/Users/joshweiss/.cortextos/cortextos1/state/task-observer-v1/skill-updates/2026-08-23/clearpath-content-pipeline.skill`
- SHA-256 `063beaf57e361a1f2ea462b5d15b39158b28295effe6c2af113b8b5087368ca7`
- Prior correction ledgers/manifests and the immutable `c52988e…` packet.
- Muse live routing/bootstrap/config/skills/schedules/runtime receipts.
- Academy live-disabled state plus every dormant config/bootstrap/backup/archive residue.

### Exact target inventory roots

- `/Users/joshweiss/code/cortextos/orgs/**/agents/**/{.agents/skills,.claude/skills,plugins/**/skills}`
- `/Users/joshweiss/code/cortextos/templates/**/skills`
- `/Users/joshweiss/code/cortextos/community/skills`
- disabled OpenCode copies, legacy non-Codex agent copies, snapshots, worktrees, review archives, Academy/Hunter archives, and all Task Observer activation symlinks.
- Current enabled-agent inventory from `cortextos bus list-agents --format json` captured with timestamp/hash.

Skills covered in F1 inventory: `task-observer`, `agent-management`, `agent-browser`, `activity-channel`, `audit-pipeline`, `audit-assemble-master`, `source-collection`, `morning-review`, and the legacy forensic bundle.

## Evidence products required before the F1 SPEC

1. `legacy-deny-value-corpus.json`: exact normalized product names, domains/hosts, endpoints, org/account identifiers, credential keys, paths, archive hashes, dependency/lineage identities; sensitive raw values may be represented by salted exact hashes where necessary.
2. `clean-room-fixture-manifest.json`: absolute fixture paths, modes, byte sizes, SHA-256, expected decision. Required negatives include renamed bundle retaining a legacy endpoint, copied archive lineage, legacy symlink/hardlink/dependency, route/bootstrap activation, and exact-value obfuscation; false-positive fixtures cover generic protocol tokens without legacy values.
3. executable fail-closed validator contract: path/SHA, deterministic normalization/traversal, CLI, exit enum, receipt schema, and positive/negative test outputs. Missing corpus/fixture/path/hash is INVALID_INPUT, never PASS.
4. `surface-inventory.json`: every exact skill/activation path classified as canonical source, enabled target, enabled blocked target, disabled evidence, template, snapshot, worktree, archive, or forbidden legacy.
5. recursive tree manifest per exact surface: relative path, type, mode, bytes/hash or symlink target; no representative-only substitution.
6. canonical target/rebase policy: enabled-runtime precedence, one complete reviewed bundle per divergent base, drift CAS, dated review-specific staging roots, pre-write backups, expected post-tree SHA, all-or-rollback transaction, and exclusion proof.
7. Maven and Muse proof: exact enabled paths/hashes/tree digests and explicit target/rebase/exclusion disposition for their divergent management/browser/activity surfaces.

## F1 fail-closed acceptance

- Every enabled runtime surface appears exactly once and every known duplicate appears exactly once with a non-installable classification where appropriate.
- A renamed legacy successor with any pinned endpoint/value/lineage fails.
- The clean product-neutral positive fixture passes.
- Generic non-legacy protocol use does not false-fail.
- Missing or drifted corpus, fixture, surface, symlink, tree byte, or runtime inventory fails.
- No live/staged skill byte is changed by F1 discovery, specification, or review.

## First action receipt

F1 opened with task `task_1787559952654_76501014`; F2–F4 are blocked. First action is source-surface enumeration and byte-pinned evidence-contract construction only. No validator implementation or substantive SPEC claim is accepted until this contract is replayable.
