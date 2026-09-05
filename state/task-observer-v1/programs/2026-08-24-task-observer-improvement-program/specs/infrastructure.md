---
title: Task Observer Infrastructure Skills — Sub-spec
project: cortextOS Task Observer
area: internal
type: spec
status: correction-review-not-pass
repo: /Users/joshweiss/code/cortextos
base-branch: origin/main
mockup: N/A — backend only
version: 2.0
date: 2026-08-24
keywords: [task-observer, lifecycle, browser, restart, authority]
---

# Task Observer Infrastructure Skills — Sub-spec

## 1. Goal

Specify four existing infrastructure improvements and three non-overlapping new contracts without changing live/staged skills.

**In scope:** `task-observer`, `agent-management`, `agent-browser`, `activity-channel`; `authority-cutoff-ledger`, `herdr-ccgram-session-lifecycle`, `fleet-restart-conductor`.

**Out of scope:** implementation, provider/browser mutation, topic/tab changes, daemon restart, install, or legacy snapshot updates.

## 2. Constitution check

| Invariant | Satisfaction |
|---|---|
| Immutable framework bundle and mutable runtime state are separate | FR-101 names both roots explicitly |
| Authority order is durable | FR-107 owns cutoff ordering only |
| Visible sessions publish only after readiness | FR-108 consumes cutoff/provider receipts |
| Shared restart is one guarded transaction | FR-109 owns restart only |

## 3. UI mockup

No UI surface; mockup gate N/A. Human-visible session/topic naming is a string contract, not a new review UI.

## 4. Requirements

### FR-101 — Task Observer path and init contract
**Requirement:** The system MUST resolve the immutable framework bundle independently from mutable runtime state and initialize one org/agent partition.
**Acceptance:**
- WHEN a substantive session starts/resumes THE SYSTEM SHALL resolve `/Users/joshweiss/code/cortextos/community/skills/task-observer` and `/Users/joshweiss/.cortextos/cortextos1/state/task-observer-v1` separately.
- WHEN initialization completes THE SYSTEM SHALL enforce 0700 partition directories and 0600 state files.
**Bucket:** A — both roots and permissions are verified (G-101, G-103).
**Depends on claims:** G-101, G-103

### FR-102 — Concurrent confidential observation writes
**Requirement:** The system MUST append observations without collision or confidentiality leakage.
**Acceptance:**
- WHEN writers append concurrently THE SYSTEM SHALL lock, allocate unique monotonic sequences, append+fsync, and verify one surviving ID each.
- WHEN visibility is `open_source` THE SYSTEM SHALL reject session/client context.
**Bucket:** A — writer and post-restart concurrency behavior are verified (G-104).
**Depends on claims:** G-104

### FR-103 — Infrastructure target manifest
**Requirement:** The system MUST classify every existing skill copy as canonical, enabled target, disabled duplicate, snapshot, or archive and rebase per pinned base.
**Acceptance:**
- WHEN a proposal is reviewed THE SYSTEM SHALL list absolute path/base SHA/target class and fail on unknown drift.
- WHEN bases differ THE SYSTEM SHALL emit surface-specific bundles or explicit exclusions, never one blind overwrite.
**Bucket:** B — copies/hashes exist; target-policy metadata must be added (G-102).
**Depends on claims:** G-102

### FR-104 — Agent-management adapter
**Requirement:** `agent-management` MUST consume authority, readiness, lifecycle, and receipt contracts without duplicating their state machines.
**Acceptance:**
- WHEN stop/supersession arrives THE SYSTEM SHALL query cutoff before lifecycle action.
- WHEN launch is requested THE SYSTEM SHALL require provider and session-readiness receipts and a human title `<Client or CW> - <Project> ▸ deliverable (Model)`.
**Bucket:** B — staged prose exists but is not live and delegates are absent (G-102).
**Depends on claims:** G-102

### FR-105 — Browser/provider preflight adapter
**Requirement:** `agent-browser` MUST prove executable owner, account, model entitlement, existing-profile attachment, and one no-write probe before visible session creation.
**Acceptance:**
- WHEN any preflight fails THE SYSTEM SHALL emit a typed failure and create no Herdr/CCGram surface.
- WHEN authenticated or visible browser work is requested THE SYSTEM SHALL attach native CUA to Josh's already-open signed-in regular Chrome profile/window; it SHALL NOT launch a new/test/temp/copied profile, change Chrome preferences, or substitute AI-mode Chrome.
- WHEN acting THE SYSTEM SHALL take a fresh snapshot before every bounded token action, use background token actions, use Chromium pixel-form `type_text` only when required, and verify the rendered value/state from a fresh read-back.
- WHEN route identity or read-back is ambiguous THE SYSTEM SHALL fail closed. It SHALL NOT use foreground/global keyboard, clipboard, DOM `set_value`, or preference/profile escalation without Josh's explicit narrow authorization.
- WHEN agent-browser/CDP is used THE SYSTEM SHALL limit it to isolated unauthenticated testing or Josh's explicit request and SHALL NOT claim authenticated-profile proof from it.
**Bucket:** B — staged rules exist; typed receipt integration is new (G-102).
**Depends on claims:** G-102

### FR-106 — Activity publication authority
**Requirement:** `activity-channel` is the sole topic publisher and MUST publish exactly one human-named topic only after lifecycle emits `READY_TO_PUBLISH`.
**Acceptance:**
- WHEN publication succeeds THE SYSTEM SHALL return the topic ID/receipt for lifecycle to record; lifecycle and agent-management SHALL NOT publish.
- WHEN lifecycle fails or is superseded THE SYSTEM SHALL publish nothing and bind the compensating cleanup receipt.
**Bucket:** B — staged rule exists but transactional receipt consumption is new (G-102, G-106).
**Depends on claims:** G-102, G-106

### FR-107 — Authority cutoff ledger
**Requirement:** A new `authority-cutoff-ledger` MUST own immutable scoped ordering and return `EXECUTE` or `ACK_ONLY`.
**Acceptance:**
- WHEN explicit stop/supersession/scope correction is accepted THE SYSTEM SHALL append `(source,event_id,observed_at,scope,action,predecessor,status)`.
- WHEN an older delayed event arrives THE SYSTEM SHALL return `ACK_ONLY` without activating work.
**Bucket:** C — no durable cutoff schema/store exists (G-105).
**Depends on claims:** G-105

### FR-108 — Herdr/CCGram session lifecycle
**Requirement:** A new lifecycle contract MUST own hidden-tab readiness, provider binding, naming, state/compensation, and the `READY_TO_PUBLISH` transition; it records the topic receipt returned by `activity-channel` but never publishes.
**Acceptance:**
- WHEN launch begins THE SYSTEM SHALL keep the tab hidden until exact native provider/session readiness is verified.
- WHEN any later step fails THE SYSTEM SHALL close/rebind deterministically and leave no blank topic/tab.
**Bucket:** D — primitives exist but no authenticated atomic gateway exists; prerequisite FR-111 (G-106, G-107).
**Depends on claims:** G-106, G-107

### FR-109 — Fleet restart conductor
**Requirement:** A new restart conductor MUST own source/dist/cron/rollback hashes, exactly one guarded reload, post-reload proof, and rollback.
**Acceptance:**
- WHEN a restart is authorized THE SYSTEM SHALL prove clean validation, PID change, restart count +1, enabled-agent recovery, schedule cardinality/test fire, partition continuity, and concurrent sequences.
- WHEN stability fails THE SYSTEM SHALL restore pinned rollback bytes and prove the restored process.
**Bucket:** B — procedure is proven once but not reusable as a contract (G-108).
**Depends on claims:** G-108

### FR-110 — Scheduled staged-only review
**Requirement:** Task Observer MUST preserve one local scheduled review that reads partitions independently and stages complete bundles only.
**Acceptance:**
- WHEN the cron fires THE SYSTEM SHALL write an immutable review receipt and update fire state without live skill mutation.
**Bucket:** A — declaration and test fire are verified (G-105).
**Depends on claims:** G-105

### FR-111 — Authenticated lifecycle gateway prerequisite
**Requirement:** A later implementation plan MUST specify an authenticated local adapter joining Herdr session identity to CCGram topic identity with idempotent receipts.
**Acceptance:**
- WHEN the adapter is unavailable THE SYSTEM SHALL keep FR-108 deferred and allow no partial transaction claim.
**Bucket:** B — both local services expose primitives; adapter contract/build is new (G-106, G-107).
**Depends on claims:** G-106, G-107

## 5. Grounding Ledger

### Candidate transition contracts

- Authority cutoff identity is `(scope, source, event_id)`; total order is `(accepted_authority_epoch, observed_at, source_priority, event_id)`. Equal timestamps use source priority then bytewise event ID. A narrower scope overrides only its intersection; missing predecessors quarantine; terminal supersession returns `ACK_ONLY`. Legal states: `OBSERVED -> ACCEPTED_EXECUTE|ACCEPTED_ACK_ONLY -> SUPERSEDED`; every other transition fails closed.
- Session lifecycle identity is `(workspace_id, requested_session_id)`. Legal states: `REQUESTED -> PREFLIGHTED -> TAB_HIDDEN -> READY_TO_PUBLISH -> PUBLISHED -> RUNNING -> STOPPING -> CLOSED`; any pre-publish failure becomes `FAILED_NO_PUBLICATION`, any post-publish failure becomes `COMPENSATING -> CLOSED|QUARANTINED`. Activity-channel alone performs `READY_TO_PUBLISH -> PUBLISHED` and returns the topic receipt.
- Restart identity is `(artifact_manifest_sha, authorization_event_id)`. Legal states: `PLANNED -> LOCKED -> RELOADING -> UNKNOWN_COMMIT -> VERIFIED|ROLLBACK_REQUIRED -> ROLLED_BACK|QUARANTINED`. After crash/restart, PID/restart-count/artifact/schedule/readback decide `UNKNOWN_COMMIT`; retries reuse the same identity and cannot issue a second reload after evidence of commit.
- Every transition receipt includes identity, prior/new state, guard evidence hashes, attempt, actor, observed time, terminal flag, and error enum. Illegal transitions emit a nonzero deterministic validation result and no side effect.

| ID | Claim | Probe | Evidence | Verdict |
|---|---|---|---|---|
| G-101 | Framework and runtime roots are distinct | `test -d /Users/joshweiss/code/cortextos/community/skills/task-observer; test -d /Users/joshweiss/.cortextos/cortextos1/state/task-observer-v1; shasum -a 256 /Users/joshweiss/code/cortextos/community/skills/task-observer/SKILL.md` | immutable framework and mutable runtime both exist at separate absolute roots; SKILL SHA `76418b3fd600d80450d5305051185aff018e3ee3a280a4b6e4c685130a7a048e` | VERIFIED |
| G-102 | Existing infrastructure copies/staged deltas are inventoried | verify each absolute target in `../target-manifest-v2.json`, hashing its `SKILL.md` and staged archive | full live SHAs `fee1620d2e340dae7530f5f50d8957743f568d1cc815792e90ed8e972af9f56a`, `24ec83eb77d392d752bd9b3518253d19b772b8314d438e827b3faec3fbf81be1`, `befd342ca9c913ccb1703651ea2bfb5d99f08066a76e10c1ddbac301d66f29f0`; staged archives are parent-bound | VERIFIED |
| G-103 | Runtime partitions have required modes | `stat`/`find` under runtime state | 13 initialized partitions; 0700 dirs/0600 logs | VERIFIED |
| G-104 | Writer is concurrency-safe | inspect `cortextos_observe.py:45-85`; fresh-process test | flock, monotonic seq, fsync; sequences `[1,2,3,4]` distinct | VERIFIED |
| G-105 | One weekly review schedule is active | parse Larry `crons.json`; test-fire receipt | one enabled `weekly-skill-review`, test fire recorded | VERIFIED |
| G-106 | Herdr exposes lifecycle primitives | `herdr --version/status/integration`; inspect supervisor guide | 0.8.0 healthy; create/rename/close/start/read/wait exist | VERIFIED |
| G-107 | CCGram exists but no atomic cortextOS gateway exists | LaunchAgent/binary/guide inspection | pinned 4.6.0 service; guide states no adapter/atomic task transaction | PARTIAL |
| G-108 | Controlled restart contract was demonstrated | read `final-fleet-receipt.md` | PID 78353→52210, restart 5→6, schedule/agents/partitions verified | VERIFIED |

## 6. Feasibility summary
| Bucket | FRs | Meaning |
|---|---|---|
| A | FR-101, FR-102, FR-110 | Existing proven behavior |
| B | FR-103, FR-104, FR-105, FR-106, FR-109, FR-111 | Existing primitives need deterministic contracts/integration |
| C | FR-107 | New durable cutoff schema/store |
| D | FR-108 | Deferred until FR-111 gateway prerequisite |

## 7. Accepted assumptions
None. FR-108 is an explicit deferral, not an assumption.

## 8. Handoff and changelog
Review only; do not rebase or author bundles in Goal 2. Later authoring uses CAS, full bundles, rollback SHA, and enabled-target manifests.

- 2026-08-24 — v2.0 grounded 8 claims; adversarial convergence pending.
