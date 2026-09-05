---
title: Deterministic Fireflies Meeting Execution — Spec
project: cortextos
area: internal
type: spec
status: ready-to-plan
repo: clearworks-ai/cortextos
base-branch: origin/main
mockup: N/A — backend only
version: 1.2
date: 2026-08-11
keywords:
  - fireflies
  - meeting-chain
  - canonical-schema
  - supervised-saga
  - invariant-sinks
  - entity-dedupe
---

# Deterministic Fireflies Meeting Execution — Spec

## Specify: PASS
> 2026-08-11 — validator PASS (0 gate failures); 4 probe passes + 3 adversarial rounds
> (Codex grounding + Fable logic/scope), converged zero CRITICAL / zero HIGH.

## Reconciliation with Spec-1 (2026-08-11)
> This is **Spec-2**. Spec-1 (`state/specs/meeting-intelligence-chain-spec-2026-08-10.md`,
> Josh-authored) built the chain downstream (its FR-001…009: meeting_type, event-emit,
> abbey-bug, A6 triple-sink, followup-coordinator, deal-debrief, CRM-interaction,
> idempotency, emit root-cause) — ALL merged to `main` (foundation base `4d0da139` now 36
> commits behind; Track A `larry/track-a` + `fix/meeting-writeback` live on main). Spec-2
> is a re-architecture, not an extension: 10/14 FRs are greenfield. **FR-number collision
> with Spec-1 is real — Spec-2 FR-000…013 are canonical going forward; tag all branches/
> slugs/receipts `spec2-` so they don't clash with Spec-1 FR-001…010 in fleet ledgers.**
> Build off `origin/main` (NOT the 36-behind foundation branch). Batch-1 targets confirmed
> unstarted on main: suppression fully present, no durable manifest. Caveat for FR-013:
> whether the old `commitment:` dedup surface still runs is unverified — backfill must not
> assume it.

> Supersedes `state/specs/event-driven-and-cron-modernization-spec-2026-08-10.md`.
> Grounded by 4 read-only probe passes + 3 adversarial rounds (Codex grounding + Fable
> logic/scope), converged zero CRITICAL/HIGH, 2026-08-11 (ledger §7). Failure analysis:
> `.Codex/adversarial-review-fireflies-deterministic-execution/REVIEW.md`.
> Prior `/specify`+`/goalify`+`/goal` cycle (2026-08-10 18:48–19:51) ran and FAILED:
> the goal was narrowed to "buildable scope" at 19:50 and auto-cleared `met=true` at
> 19:51 before real DONE existed. This spec re-derives DONE so that cannot recur.

## 1. Goal

After every meaningful external meeting (Fireflies transcript, ≥1 non-Clearworks
attendee, substantive content), cortextOS must remove the follow-up burden from Josh:
produce a recap, his OUR-side task/reminder candidates, THEIR tracker, a Josh-only Gmail
draft + approval, a CRM interaction, an explicit commercial outcome, and one terminal
receipt — or fail each of those visibly, retryably, and *notified*. Nothing may silently
disappear behind meeting classification or a hardcoded identity block. Asked by Josh
2026-08-11 (clarification gate this session); the two live meetings that exposed the gap
are MSIA `01KZCGVH6HYN9XX4124033CTJV` and Kadre `01KZMNH3A753Z6Z9JAAJ1V19PC`.

**In scope (this spec's DONE — all built + staging-verified, none deferrable):**
- One canonical, versioned meeting schema + chain (extractor→writeback→fanout→CRM-sync
  →recap-draft→TS event boundary) that fails closed, living in ONE repo-level module —
  NOT copied inside any agent directory, with no hardcoded per-agent paths.
- The invariant sinks above, each exist-or-fail-visibly with a verified artifact ID and
  an escalation when a run stays failed.
- A per-meeting run manifest (foundational — built first) + supervised saga with per-sink
  idempotency/reconciliation and a terminal receipt delivered to Josh (not to an agent
  inbox).
- Classification demoted to advisory metadata (cannot gate a sink) — removing BOTH
  known `sales`-only gates.
- CRM commercial outcome as an approval-gated PROPOSAL with an executable apply-on-
  approval payload (never blind mutation); an explicit outcome is emitted for every
  meaningful external meeting.
- Removal of ALL hardcoded suppression; the only surviving identity rule is PTS→MSIA
  entity-dedupe via the existing `org-aliases.json` — sequenced FIRST (it fixes the only
  confirmed ongoing data loss).
- A re-drive path for meetings processed by the old chain during the build window.

**Explicitly out of scope (clarification-gate deferrals):**
- Any generalized per-stage queue / lease-claim system (REVIEW: unjustified before the
  saga passes the fixture gate). Per-meeting mutual exclusion via atomic manifest
  creation IS in scope — that is not a queue.
- New event lanes for Slack/omi/pr-ci and the broader cron-modernization program (the
  old superseded spec's Subsystems 2 & 3) — separate track.
- A "typed suppression policy" — rejected: there is no suppression system to build
  (Josh 2026-08-11: "there is no suppression thats a borken system").
- A fleet-wide provenance registry / halt-all-on-mismatch. FR-003 is per-run
  observability + a per-run guard only (Fable: a global halt is a new outage mode).

## 2. Constitution check

| Invariant | How this spec satisfies it |
|---|---|
| Skills/scripts live at repo level or `~/code` root, NEVER inside an agent dir (Josh, repeated) | FR-001 promotes the WHOLE chain (`ff-extractor`, `meeting_writeback`, `meeting-fanout`, `meeting-crm-sync`, `meeting_recap_draft`) into ONE repo-level module and deletes the `pa`, `pa-codex`, and `frank2-codex` copies + the hardcoded `pa`-extractor paths in fanout/crm-sync and the hardcoded crm dir in the daemon (G-21). |
| `pa` is a dead agent (Josh 2026-08-11) | No requirement targets `pa`/`pa-codex`/`frank2-codex` as a runtime; their meeting scripts are removed. Canonical logic is agent-neutral, invoked by the daemon saga. |
| Org isolation — every CRM access org-scoped, through the storage/script layer | FR-006/FR-010 mutate CRM only through the canonical `upsert-contact.py` / `add-interaction.py` / `upsert-engagement.py` scripts (there is no `crm-record` command — G-23); PTS→MSIA resolves to one org id via `org-aliases.json`; no raw writes. |
| Atomic writes (`src/utils/atomic.ts`) | The run manifest + per-sink receipts (FR-007/008) are atomic-written; the manifest is created with O_EXCL as the per-meeting lock (FR-007). |
| Approvals gate outward/irreversible actions | Gmail draft + CRM opportunity are approval-gated (FR-006/FR-011); Gmail has no send capability structurally; the CRM proposal applies only after approval via an executable payload. |
| Goal DONE cannot be narrowed / satisfied by deferred work | FR-012 encodes the non-negotiable goal invariants; no P1 acceptance criterion depends on a later-phase artifact (the manifest is P1). |

No invariant waived.

## 3. UI mockup

No UI surface; mockup gate N/A. Every artifact is a backend sink (task, approval, CRM
row, Gmail draft, BRIEFS row, Telegram message, run manifest).

## 4. Requirements

### FR-000 — Meaningful-external-meeting scope

**Requirement:** System MUST deterministically classify a Fireflies meeting as
`meaningful_external`, `internal`, or `needs_resolution`, from a canonical
internal-domain list and an explicit attendee-email resolution rule, and apply the
invariant-sink contract only to `meaningful_external`.

**Acceptance:**
- WHEN ≥1 attendee resolves to an email whose domain is not in the canonical internal
  set (`clearworks.ai` AND `clearworksai.com` — unified from the two divergent lists,
  G-16) AND the meeting has substantive content (transcript present and either a
  duration ≥ a configured floor or ≥1 extracted commitment/decision) THE SYSTEM SHALL
  mark it `meaningful_external` and apply FR-004.
- WHEN attendees are present but carry only speaker names, not emails THE SYSTEM SHALL
  attempt resolution against CRM contacts; if unresolved, mark `needs_resolution` and
  fail visibly — never silently treat as internal (G-16).
- WHEN all attendees are internal, or the meeting is a no-show / sub-floor with no
  commitments THE SYSTEM SHALL mark it `internal` and produce EXACTLY this reduced sink
  set: recap note + OUR/THEIR tracker + OUR candidate tasks + their BRIEFS rows + a
  terminal manifest with `outcome=internal_skip`. It SHALL NOT produce a Gmail draft, a
  CRM interaction, a CRM deal outcome, a debrief, a commercial outcome, or an approval.
  (The full six-sink invariant contract of FR-004 applies to `meaningful_external` only.)

**Bucket:** B — attendee data exists; the deterministic rule + unified domain source +
name→email resolution are new logic over it. **Depends on claims:** G-01, G-02, G-16

---

### FR-001 — One canonical versioned chain in a repo-level module

**Requirement:** System MUST define the entire meeting chain once, in a repo-level
module, with no per-agent copy and no hardcoded per-agent path. The schema carries
top-level `schemaVersion`, `meeting_type`, `meeting_type_confidence`, `deal_state`, and
`next_steps[]` where each item has `commitmentId`, `owner_identity`, `direction`
(OUR|THEIR), `due` or `NEEDS-DATE`, `sourceQuote`, and `text`; empty collections are
explicit `[]`, never absent.

**Acceptance:**
- WHEN the module is located THE SYSTEM SHALL find the chain at repo level (e.g.
  `src/meeting-chain/`), and grep MUST find zero meeting extractor/writeback/fanout/
  crm-sync/recap-draft copies under `orgs/clearworksai/agents/*/`.
- WHEN the dead copies are checked THE SYSTEM SHALL confirm `pa`, `pa-codex`, AND
  `frank2-codex` meeting scripts are deleted (G-21), and that fanout/crm-sync no longer
  hardcode the `pa` extractor path and the daemon no longer hardcodes the crm agent dir
  (G-21).
- WHEN extraction runs THE SYSTEM SHALL emit every required field or fail closed
  (FR-002); a schema-valid meeting with no commitments emits `next_steps: []`.

**Bucket:** B — the schema-correct logic exists in the dead `pa/ff-extractor.py`
(G-01), duplicated schema-poor in `pa-codex` (G-02) and again in `frank2-codex` (G-21);
the work is promotion to one repo-level module + deletion of the copies + de-hardcoding
the callers. **Depends on claims:** G-01, G-02, G-03, G-21

---

### FR-002 — Fail-closed schema validation across every boundary

**Requirement:** Writeback, fanout, CRM-sync, and the TypeScript event boundary MUST
validate `schemaVersion` + required fields and reject missing/mixed shapes visibly; they
MUST NOT read a field no extractor emits, MUST NOT cast arbitrary JSON and default
missing arrays, and MUST NOT infer a legitimate zero from an absent field.

**Acceptance:**
- WHEN writeback receives a payload missing `schemaVersion` or a required `next_steps`
  field THE SYSTEM SHALL record `schema_invalid:<field>` in the manifest and stop, not
  proceed on defaults.
- WHEN writeback needs commitment ids THE SYSTEM SHALL read `next_steps[].commitmentId`
  (the emitted location), not the top-level `commitmentIds` that nothing emits (G-03).
- WHEN the TypeScript boundary (`meeting-event-emit.ts`) receives the payload THE SYSTEM
  SHALL validate it against the versioned schema rather than cast + default (G-22), and
  MUST stop reading top-level `commitmentIds`.

**Bucket:** B — writeback reads a nonexistent top-level `commitmentIds` (G-03) and the
TS boundary casts + defaults + reuses `commitmentIds` (G-22). **Depends on claims:**
G-03, G-04, G-22

---

### FR-003 — Per-run provenance observability + guard (not a fleet halt)

**Requirement:** Each meeting run MUST record its execution provenance (git SHA, built-
dist hash, invoked-script hash, schema version) in that run's manifest, and MUST refuse
*that run* (marking it `provenance_mismatch`, notified) when the running values do not
match a **promotion record** — a small atomic-written file (e.g.
`state/meeting-chain/PROMOTED.json`) that the promote step writes with the expected SHA,
dist hash, script hash, and schema version. The guard compares the running values against
that record. It MUST NOT halt the whole fleet.

**Acceptance:**
- WHEN a meeting run starts THE SYSTEM SHALL record the four provenance values in the
  manifest.
- WHEN the running code does not match the promoted candidate THE SYSTEM SHALL fail that
  run visibly (`provenance_mismatch`) and notify, rather than silently execute stale
  code (the pa-codex-ran-stale incident, G-02) or halt all meetings.

**Bucket:** C — no meeting-runtime promotion registry exists; the pipeline ledger
(`ledger.ts`) binds pipeline artifacts, not deployment SHA/hash/schema (G-17). The spec
extends the run manifest to hold provenance rather than build a separate registry.
**Depends on claims:** G-02, G-17

---

### FR-004 — Invariant sinks exist-or-fail-visibly, with escalation

**Requirement:** For every `meaningful_external` meeting, System MUST produce ALL of:
(1) recap/tracker note; (2) OUR-side commitments as candidate tasks on the bus
human-task surface (assignee=human, surfaced in the dashboard + daily briefings) with
matching `commitmentId`; (3) Josh-only Gmail draft + approval; (4) CRM interaction;
(5) an explicit commercial outcome (FR-006); (6) a terminal receipt delivered to Josh
via Telegram + a `completed` manifest + an activity event — each with a verified artifact
ID, or a visible, retryable failure. THEIR commitments are tracker-only.

**Acceptance:**
- WHEN the chain completes THE SYSTEM SHALL show every OUR commitment as a candidate
  task on the bus human-task surface AND on BRIEFS with the same `commitmentId`
  (requires deterministic task↔commitment mapping — bus `create-task` today returns a
  random id and stores only the meeting id, G-18 — so the manifest records the
  `commitmentId → taskId` map and replay consults it).
- WHEN a commitment has no date THE SYSTEM SHALL persist `NEEDS-DATE` and suppress the
  bus default-due-date computation (G-18), never fabricate a due date.
- WHEN any sink cannot produce its artifact THE SYSTEM SHALL mark the run
  `partial_failed` with the exact failed stage; exit-0 / `dispatched` / non-empty stdout
  / a markdown file / a policy skip SHALL NOT count as terminal success.
- WHEN a run remains `partial_failed` after N automatic resume attempts, OR stays
  nonterminal-and-leased past the threshold (a stale/stuck lease, FR-007), THE SYSTEM
  SHALL escalate to Josh (Telegram + a human task) — a run MUST NOT fail silently in a
  loop, whether by repeated failure or by a stuck lease.
- WHEN the terminal receipt is delivered THE SYSTEM SHALL target Josh, never an agent
  inbox (`pa` is dead, G-21).

**Bucket:** B — the sinks exist as scripts but fire conditionally/detached (G-05, G-06,
G-09, G-10); the task-layer mapping + NEEDS-DATE suppression are small additions (G-18).
**Depends on claims:** G-05, G-06, G-09, G-10, G-18

---

### FR-005 — Classification is advisory metadata, never an authorization gate

**Requirement:** `meeting_type` MUST NOT gate whether any invariant sink fires. It may
only influence template, priority, and review labels. BOTH known `sales`-only gates MUST
be removed.

**Acceptance:**
- WHEN `meeting_type` is `sales`, `other`, or absent THE SYSTEM SHALL produce byte-for-
  byte the same set of invariant artifacts (same sinks, same `commitmentId`s); only
  labels/priority strings may differ, verified by an explicit artifact-set comparator.
- WHEN the CRM gate (`meeting-crm-sync.py:337`, G-07) AND the daemon debrief gate
  (`meeting-consumer-dispatch.ts:220`, G-25) are checked THE SYSTEM SHALL confirm both
  are removed; commercial evaluation (FR-006) runs on evidence, not on `meeting_type`.

**Bucket:** B — two hard gates today (G-07, G-25); no advisory path. **Depends on
claims:** G-07, G-25

---

### FR-006 — CRM commercial outcome is an approval-gated proposal with an executable payload

**Requirement:** For every `meaningful_external` meeting, System MUST emit exactly one
explicit commercial outcome — `no_evidence | matched_existing | proposed_new | ambiguous
| failed` — decided by a DETERMINISTIC evidence rule over the transcript + extracted
`deal_state` (not by `meeting_type`), each with cited evidence and an idempotency key. A
new opportunity or stage change is a PROPOSAL carrying an executable apply-on-approval
payload; the CRM pipeline is mutated only after Josh approves.

**Acceptance:**
- WHEN the deterministic rule finds deal evidence but no matching engagement THE SYSTEM
  SHALL emit `proposed_new` with the cited quote and create an approval whose payload,
  when approved, invokes `upsert-engagement.py` — NOT mutate CRM immediately (G-08 today
  calls it inline; G-20: generic approvals carry no executable payload, so the apply
  mechanism is new).
- WHEN a matching engagement exists THE SYSTEM SHALL emit `matched_existing` and stage
  any stage change as a proposal, applying only after approval.
- WHEN evidence is contradictory THE SYSTEM SHALL emit `ambiguous` and surface for
  review; WHEN none is found THE SYSTEM SHALL emit `no_evidence` (a valid terminal
  outcome). The rule's recall is measured by the Kadre fixture's positive assertion and
  a negation/​hypothetical negative fixture.
- WHEN Josh rejects a `proposed_new` THE SYSTEM SHALL key the proposal idempotency on
  (meeting_id + evidence-hash), so a later meeting with new evidence can re-propose (a
  rejection MUST NOT permanently blacklist the deal).

**Bucket:** C — approval-gated apply requires a new durable proposal/apply subsystem;
today CRM is mutated inline (G-08) and approvals hold metadata only, no executable
payload (G-20). **Depends on claims:** G-08, G-20

---

### FR-007 — Per-meeting run manifest (foundational) + supervised saga

**Requirement:** System MUST create a durable per-meeting run manifest keyed by
`transcriptId` (with `schemaVersion` recorded as a field, not part of the key), created
atomically with O_EXCL so exactly one runner owns a meeting (the per-meeting lock). One
versioned command drives each sink as a stage recording state, attempts, timestamps,
artifact IDs/counts, errors, and provenance. The manifest reaches `completed` ONLY after
every required sink is verified. A safety sweep finds nonterminal runs. Resuming a
nonterminal manifest (by the sweep OR an FR-013 re-drive) MUST acquire an exclusive lease
(O_EXCL lock file) on that manifest, so only one resumer runs a given meeting at a time —
a marker/receipt write on resume is guarded by the same lease, never a bare atomic write
two resumers could both pass. The lease MUST carry a TTL + holder-liveness check: a stale
lease (dead holder or expired TTL) is reclaimable, and a manifest that stays
nonterminal-and-leased past the FR-004 escalation threshold escalates (a lease no-op
counts toward that threshold) — a stuck lease MUST NOT silence a run forever.

**Acceptance:**
- WHEN two runners race the same meeting THE SYSTEM SHALL let the O_EXCL create winner
  proceed and the loser no-op (no second run, no second Telegram) — without a generalized
  queue.
- WHEN a run is interrupted THE SYSTEM SHALL leave a nonterminal manifest the sweep
  detects and resumes, re-running only missing/unverified sinks.
- WHEN the sweep and an FR-013 re-drive (or two sweeps) race the same nonterminal
  manifest THE SYSTEM SHALL let only the exclusive-lease holder resume it; the other
  no-ops — two resumers SHALL NOT both pass a marker check and double-fire a sink.
- WHEN all sinks are verified THE SYSTEM SHALL mark exactly one manifest `completed`;
  the manifest MUST NOT go `completed` before consumers finish (today's tmp payload does
  — G-17).

**Bucket:** C — no durable manifest exists; the nearest tmp payload is 6 fields and
completes before dispatch (G-17). **Depends on claims:** G-05, G-06, G-17

---

### FR-008 — Per-sink idempotency + reconciliation; per-sink delivery semantics; inert dry-run

**Requirement:** Each sink MUST have its OWN idempotency/reconciliation key and a
verified artifact receipt, with delivery semantics chosen per sink. Replay MUST return
existing artifact IDs. Dry-run/plan MUST occupy no `completed` key and write only a
clearly-marked ephemeral manifest the sweep ignores.

**Acceptance:**
- WHEN a reconcilable sink is replayed THE SYSTEM SHALL create no duplicate — one
  artifact each — using the reconciliation mechanism the sink supports: query-by-stored-key
  where the sink returns an id (task, approval, CRM interaction), and a locally-recorded
  client-supplied idempotency key sent WITH the write where the sink is write-only and
  returns no queryable id (BRIEFS is a write-only POST, `meeting-fanout.py:449-472`, G-15;
  Gmail draft reconciles by its stored draft id + meeting marker per FR-011). Because
  bus `create-task` returns a random id (G-18), the manifest stores the
  `commitmentId → taskId` map as the key.
- WHEN the batched commitment-fanout Telegram runs THE SYSTEM SHALL use at-most-once
  semantics: write a `telegram_sent` marker before sending and never re-send if the marker
  exists (a rare lost batch notice is preferred to duplicate spam; the OUR commitments are
  independently on the task surface + BRIEFS regardless).
- WHEN the TERMINAL RECEIPT Telegram runs (FR-004(6)) THE SYSTEM SHALL use at-least-once
  semantics: send, confirm the send succeeded, and record the confirmation; on resume it
  re-sends if the confirmation is absent. The manifest reaches `completed` only after the
  terminal-receipt send is confirmed — so a `completed` run has always delivered Josh's
  receipt (a rare duplicate receipt is acceptable; a silent miss is not, and there is no
  "marker-before-send" loss window for the receipt).
- WHEN one sink fails THE SYSTEM SHALL leave the other sinks' receipts intact and resume
  only the failed sink — a single shared key SHALL NOT make partial success
  unrecoverable (G-09, G-10).
- WHEN a dry-run executes THE SYSTEM SHALL consume no dedupe key and record no completion
  state (G-11 today consumes the key).

**Bucket:** C — independent receipts + reconciliation + crash recovery + the task key-map
require the new manifest/receipt subsystem, not just editing the shared fanout key (G-09,
G-18). **Depends on claims:** G-09, G-10, G-11, G-18

---

### FR-009 — Consumers capture child results and surface failure

**Requirement:** Consumers MUST capture child exit codes/output and MUST NOT record the
fire-once key before the action succeeds; failures surface as `partial_failed` with the
exact stage (the batch fanout Telegram excepted per FR-008's marker-before-send; the
terminal receipt uses FR-008's at-least-once send+confirm, not the marker pattern).

**Acceptance:**
- WHEN a consumer spawns a sink worker THE SYSTEM SHALL capture its exit/output rather
  than spawn detached with ignored stdio (G-05).
- WHEN the action fails after the key would have been recorded THE SYSTEM SHALL NOT mark
  the sink deduped/dispatched; the key is recorded only on verified success (G-06).

**Bucket:** B — `meeting-consumer-dispatch.ts:95-98` spawns detached/`stdio:'ignore'`;
`:272` records the key before `:277` runs (G-05, G-06). **Depends on claims:** G-05, G-06

---

### FR-010 — Remove all hardcoded suppression; PTS→MSIA entity-dedupe only (ships FIRST)

**Requirement:** System MUST remove every hardcoded suppression rule and MUST NOT drop
any meeting, commitment, recap, contact, or email on identity grounds. The only surviving
identity rule is PTS→MSIA org entity-dedupe, implemented via the existing
`org-aliases.json` (which lacks a `pts.org` entry today, G-19) and consulted by CRM sync
when creating contacts and matching engagements. This requirement is sequenced FIRST — it
is a pure deletion + one alias entry and fixes the only confirmed ongoing data loss.

**Acceptance:**
- WHEN the codebase is grepped THE SYSTEM SHALL contain no `SUPPRESSED_NAMES` list and no
  `_ingest_suppression.json` domain/name/id block that drops data (G-12, G-13, G-14).
- WHEN Julie Lurie (`@pts.org`) appears THE SYSTEM SHALL capture her email, contact, and
  meeting, and CRM sync SHALL resolve PTS→MSIA via `org-aliases.json` rather than create
  a duplicate org (G-19).
- WHEN "Marcos Santa Ana" / Alloi appears THE SYSTEM SHALL treat the meeting normally —
  no drop, no special routing (the Hunter agent no longer exists, so lead-sourcing
  routing is moot).

**Bucket:** B — deletions + a `pts.org` alias entry, PLUS the CRM-sync changes the alias
requires: pass company/org on contact upsert (today it passes none, `:233-243`) and
resolve engagements through the org alias, not contact-id-only matching (`:296-305`, G-19).
The alias file alone is insufficient without this wiring. **Depends on claims:** G-12,
G-13, G-14, G-19

---

### FR-011 — Gmail draft sink: daemon-wired, draft-only, reconcilable

**Requirement:** The Gmail draft worker MUST be wired into the daemon as an event sink
(not a separate periodic path), create a draft only — addressed to Josh only, no send
capability in the code path, tagged with the `meeting_id` in a stable marker (subject or
metadata) usable for reconciliation in BOTH staging (`[STAGING:<meeting_id>]`) and
production — capture and record the draft ID, and reconcile an ambiguous creation to the
existing draft rather than duplicate.

**Acceptance:**
- WHEN the Gmail sink runs THE SYSTEM SHALL create only a Josh-only self-draft, record
  its draft ID in the manifest, and leave Gmail Sent unchanged (send-disabled is
  fleet-consistent design — memory `gws_dwd_gmail_send_disabled_by_design`).
- WHEN a prior draft carrying the meeting's marker exists THE SYSTEM SHALL reconcile to
  that draft ID, not create a second (G-24: the worker records only the meeting id after
  success and captures no draft id today).
- WHEN the draft is created THE SYSTEM SHALL create the paired approval; the approval's
  effect is to surface the draft for Josh to send (Gmail has no programmatic send).
- WHEN the sink calls the `gws gmail +draft` command THE SYSTEM SHALL capture its stdout
  and parse a stable draft id, and query drafts by the meeting marker for reconciliation;
  if the command returns no parseable id / offers no marker lookup, extending it to do so
  is a prerequisite of this FR (today the worker captures neither, G-24; see A-04).

**Bucket:** B — a draft-only Josh-addressed worker exists but is unwired and captures no
draft id (G-24); wiring + id capture + marker lookup are the work (id capture may require
a small `gws` change, A-04). **Depends on claims:** G-24

---

### FR-012 — Goal governance invariants (for the `/goalify` handoff)

**Requirement:** The DONE condition MUST NOT be narrowable to "buildable scope";
deferred/gated work MUST NOT yield `met=true`; no completion is valid without the terminal
receipts of FR-004/FR-007. No P1 acceptance criterion may depend on a later-phase
artifact. If Josh removes a requirement, he removes it explicitly from the active goal
rather than relabeling it "gated".

**Acceptance:**
- WHEN the goal loop evaluates DONE THE SYSTEM SHALL require every FR-004 sink verified on
  both fixtures (§ testing) with terminal receipts before `met=true`.
- WHEN any requirement is outstanding THE SYSTEM SHALL keep the goal unmet, even if all
  currently-buildable work is done.

**Bucket:** A — process constraint carried into the goal condition. **Depends on
claims:** —

---

### FR-013 — Re-drive for meetings processed during the build window

**Requirement:** System MUST provide a re-drive path that reconciles meetings the old
chain partially processed during the build window. Because old-chain artifacts carry no
new reconciliation keys (old Telegram/BRIEFS left no queryable artifact; old Gmail drafts
carry no marker), the re-drive MUST seed a manifest from a ONE-TIME backfill of the old
evidence — the old `commitment:` dedupe surface (proof each commitment's fanout sinks
fired), the old recap-draft per-meeting ledger (proof a draft was created, G-24), and
`followups.jsonl` — reconstructing `telegram_sent` markers and per-sink keys before
completing. It then completes only the genuinely-missing sinks; where an old artifact
cannot be keyed, it MUST prefer skipping the re-send and flagging that sink for manual
review over duplicating it.

**Acceptance:**
- WHEN a meeting the old chain fired is re-driven THE SYSTEM SHALL seed markers/keys from
  the old dedupe surface + recap-draft ledger + `followups.jsonl` and create only the
  missing sinks — no duplicate Telegram, no duplicate draft.
- WHEN an old artifact cannot be keyed from the backfill THE SYSTEM SHALL skip re-sending
  it and flag it for manual review, never blind-replay.

**Bucket:** C — a new legacy-artifact importer/reconciliation step is required: old
tasks/approvals store the meeting id but no commitment mapping (`meeting-fanout.py:294-310`),
old Gmail stores only the meeting id (`meeting_recap_draft.py:328-332`), and event-dedup
stores timestamps/booleans, not artifact ids (`src/utils/event-dedup.ts:106-130`) — so the
backfill reconstructs keys from partial evidence, and unkeyable artifacts are skipped +
flagged (never blind-replayed). **Depends on claims:** G-09, G-11, G-24

## 5. API contracts

The chain calls one external HTTP sink (BRIEFS) and otherwise uses internal `cortextos
bus` CLI commands (`create-task`, `create-approval`, `send-telegram`) and the canonical
CRM scripts (`upsert-contact.py`, `add-interaction.py`, `upsert-engagement.py`) — direct
script calls, NOT an HTTP API and NOT a `crm-record` command (which does not exist,
G-23). No new endpoint is exposed.

| Method | Path | Auth | Verified status | Response shape | Probe evidence |
|--------|------|------|-----------------|----------------|----------------|
| POST | `$BRIEFS_INGEST_URL` (BRIEFS ingest) | env `$BRIEFS_INGEST_URL` present | UNVERIFIABLE — external write path, not live-probed | opaque ack | G-15 |

- **BRIEFS:** synchronous `urlopen` POST; `meeting-fanout.py:467-472` catches all
  exceptions and returns `True` regardless (G-15). FR-008 requires it to carry its own
  reconciliation receipt instead of a swallowed `True`. Not re-probed (external write, no
  canary). Owner: FR-008 / A-01.

## 6. MCP tool contracts

No `mcp__*` tool is on the meeting-execution critical path. All sinks are `bus` CLI +
canonical CRM scripts + the BRIEFS POST above. N/A.

## 7. Grounding Ledger

Probed against the working tree at `origin/main` @ `5389b713`, 2026-08-11, by 4 read-only
subagent passes + a Codex grounding round. No writes performed.

| ID | Claim | Probe | Evidence | Verdict |
|----|-------|-------|----------|---------|
| G-01 | Canonical `pa/ff-extractor.py` emits `meeting_type` + nested `next_steps[].commitmentId` + `owner_identity` | read `orgs/clearworksai/agents/pa/scripts/ff-extractor.py` | `:1753` commit_entries derive `owner_identity` + `commitmentId`; `meeting_type` emitted top-level | VERIFIED |
| G-02 | `pa-codex/ff-extractor.py` emits `id`/`owner` only — none of the three fields | read `orgs/clearworksai/agents/pa-codex/scripts/ff-extractor.py` | `:1563-1584` entry keys `id,text,direction,source,sourceRef,owner,deadline,…`; grep finds none of the three | VERIFIED |
| G-03 | Writeback reads top-level `commitmentIds` (no extractor emits) + `next_steps` loop ignores `commitmentId` | read `orgs/clearworksai/agents/pa/scripts/meeting_writeback.py` | `:517 meeting.get("commitmentIds")…`; `:395-415` loop reads only `text/owner/deadline` | VERIFIED |
| G-04 | REVIEW claim: repair `352e6078` hand-injects top-level `commitmentIds`, masking the boundary | `git show 352e6078` | injects `commitmentIds` into a TEST fixture + asserts it (`tests/unit/daemon/meeting-event-emit.test.ts:194-206,254-259`); runtime extractor unchanged → tests go green while runtime stays broken | PARTIAL |
| G-05 | Consumers spawn detached with ignored stdio (no child result) | read `src/daemon/meeting-consumer-dispatch.ts` | `:95-98 spawn(cmd,args,{detached:true,stdio:'ignore'}); child.unref()` | VERIFIED |
| G-06 | Fire-once key recorded BEFORE the action; sync spawn labeled `dispatched` | read `src/daemon/meeting-consumer-dispatch.ts` | `:272 if(!recordEvent(...))` precedes `:277 action()`; `:278 status:'dispatched'` | VERIFIED |
| G-07 | `meeting_type == "sales"` gate controls DEAL-STAGE mutation only — contacts/interactions run for all types (narrower than "all commercial handling") | read `orgs/clearworksai/agents/crm/crm/meeting-crm-sync.py` | `:337 if meeting_type != "sales": return skipped` gates `sync_deal_stage`; contact upsert + interaction run before, at `:435` | VERIFIED |
| G-08 | `no_engagement_for_contact` is a silent exit-0 skip; no opportunity created; CRM mutated inline | read `orgs/clearworksai/agents/crm/crm/meeting-crm-sync.py` | `:346-348` returns skipped when no match; `:353` calls `upsert-engagement.py` inline when matched | VERIFIED |
| G-09 | Fanout uses ONE `commitment:` dedupe key gating all four sinks | read `orgs/clearworksai/agents/crm/crm/meeting-fanout.py` | `:281 source_key=f"commitment:{c.commitment_id}"`; `:282 dedup_surface` gates task/approval/BRIEFS/followup/Telegram (`:294-347`) | VERIFIED |
| G-10 | Sink failures are swallowed | read `orgs/clearworksai/agents/crm/crm/meeting-fanout.py` | `:358 _run` logs+returns `""`; `:467-472` BRIEFS catches all, returns `True` | VERIFIED |
| G-11 | Dry-run consumes the same dedupe key | read `orgs/clearworksai/agents/crm/crm/meeting-fanout.py` | `:282 dedup_surface` runs before `:287-288 if dry_run: continue` | VERIFIED |
| G-12 | Global `pts.org` domain block rejects Julie's email, exit-0, no receipt | read `_ingest_suppression.json` + `crm/upsert-contact.py` | `_ingest_suppression.json:3-4 "domains":["pts.org"]`; `upsert-contact.py:162-169` prints `SUPPRESSED`, `return 0`, no event | VERIFIED |
| G-13 | Marcos `SUPPRESSED_NAMES` substring drops the WHOLE meeting | read `orgs/clearworksai/agents/pa/scripts/meeting_recap_draft.py` | `:21 SUPPRESSED_NAMES=("marcos santa ana",)`; `:242-251 if is_suppressed_meeting(...): continue` skips entire meeting | VERIFIED |
| G-14 | Meeting/CRM ingest suppression is untyped (booleans/strings), no per-sink scope (claim scoped to meeting/CRM ingest, not repo-wide) | grep suppression decision points in crm + pa meeting scripts | `upsert-contact.py:40-55` returns a string-or-None reason; `meeting_recap_draft.py:116` returns a bool; no effect/scope fields (core code has unrelated typed Telegram suppression at `session-context.ts:101`, out of scope) | VERIFIED |
| G-15 | BRIEFS POST failure is not recorded (returns True on exception) | read `orgs/clearworksai/agents/crm/crm/meeting-fanout.py` | synchronous `urlopen`; `:467-472` returns `True` on exception; only `briefs_attempted` incremented | VERIFIED |
| G-16 | Internal-domain source is divergent + attendees may be names not emails | read recap + crm-sync + extractor | recap knows only `clearworks.ai` (`meeting_recap_draft.py:20`); crm-sync also `clearworksai.com` (`meeting-crm-sync.py:56`); `attendees` may hold speaker names (`pa-codex/ff-extractor.py:1907-1924`) | VERIFIED |
| G-25 | A SECOND classification gate: daemon spawns deal-debrief only for exact `sales` | read `src/daemon/meeting-consumer-dispatch.ts` | sales gate `:220`; non-sales recorded skipped `:246-248`; debrief spawns only for `sales` | VERIFIED |
| G-17 | No durable run manifest; tmp payload is 6 fields and goes `completed` before consumers dispatch | read `src/daemon/meeting-event-emit.ts` + `agent-manager.ts` | 6-field shape `meeting-event-emit.ts:21-28`; tmp path `:67-78`; premature completion `:153-172`; dispatch follows at `agent-manager.ts:1260-1267` | VERIFIED |
| G-18 | Bus `create-task` returns a random id + auto-computes due date; fanout stores only meeting id | read `src/bus/task.ts` + `meeting-fanout.py` | random id `task.ts:773-779`; default due-date calc `:741-770`; `meeting-fanout.py:294-300` stores meeting id in description | VERIFIED |
| G-19 | `org-aliases.json` exists but lacks `pts.org`; CRM sync creates contacts with no company + matches engagements by contact-id only (no alias) | read `crm/org-aliases.json` + `meeting-crm-sync.py` | `org-aliases.json:2` present, no `pts.org`; contact creation `:221-252` passes no company (`:233-243`); engagement match contact-id-only `:296-305` | VERIFIED |
| G-20 | Generic approvals carry metadata but no executable proposal payload | read `src/bus/approval.ts` | `:224-240` approval record has metadata + linked task only, no action/apply payload | VERIFIED |
| G-21 | Chain files are agent-local + duplicated (pa/pa-codex/frank2-codex) + callers hardcode the dead `pa` extractor / crm dir | read fanout, crm-sync, dispatch, frank2-codex | `meeting-fanout.py:49-56` + `meeting-crm-sync.py:46-50` hardcode `pa`; `meeting-consumer-dispatch.ts:179` hardcodes crm dir; third extractor at `frank2-codex/scripts/ff-extractor.py:1` | VERIFIED |
| G-22 | TS event boundary casts arbitrary JSON, defaults missing arrays, uses top-level `commitmentIds` | read `src/daemon/meeting-event-emit.ts` | payload decl `:21-27`; arbitrary cast `:139-141`; default arrays + top-level `commitmentIds` `:160-163` | VERIFIED |
| G-23 | No `crm-record` command/script exists | grep repo for `crm-record` | only agent-local `upsert-contact.py`/`add-interaction.py`/`upsert-engagement.py` invoked (`meeting-crm-sync.py:46`) | VERIFIED |
| G-24 | Gmail worker is unwired, captures no draft id, records only meeting id after success | read `pa-codex/scripts/meeting_recap_draft.py` + dispatch | `:260-273` draft-only Josh-addressed; `:328-332` records meeting id, no draft id; dispatch consumer list `:179-248` contains no Gmail worker | VERIFIED |

## 8. Feasibility summary

| Bucket | FRs | Meaning |
|---|---|---|
| A — buildable now | FR-012 | Process/governance constraint carried into the goal |
| B — needs work in existing code | FR-000, FR-001, FR-002, FR-004, FR-005, FR-009, FR-010, FR-011 | Logic/scripts exist; relocate, rewire, de-hardcode, or de-condition |
| C — needs new subsystem | FR-003 (per-run provenance + promotion record), FR-006 (approval-apply payload), FR-007 (run manifest/saga), FR-008 (receipt/reconciliation), FR-013 (legacy-artifact importer/reconciliation) | No manifest, no approval-apply, no receipt store, no legacy importer exists today |
| D — needs a capability we lack | — | none |

## 9. Accepted assumptions

| ID | Assumption | Why unprobed | Owner | Settles when |
|----|-----------|--------------|-------|--------------|
| A-01 | Real BRIEFS ingest accepts the reconciliation-keyed payload FR-008 adds | external write path, no canary | Josh | first run posts to real BRIEFS (staging stub cannot settle it — flagged) |
| A-02 | The schema-correct logic in dead `pa/ff-extractor.py` is the intended canonical shape (vs a newer unshipped variant) | `pa` is dead; no running reference | Josh | promoted module passes both fixtures |
| A-03 | The configured "substantive content" floor (duration/commitment threshold) for FR-000 matches Josh's intent | judgment call, not in code | Josh | first week of runs; tune if no-shows slip through or real meetings are excluded |
| A-04 | `gws gmail +draft` can return a parseable stable draft id and support query-by-marker (FR-011 reconciliation) | not probed — external `gws` command surface | build owner | first staging Gmail-sink run; if not, a small `gws` change is a prerequisite |
| A-05 | Real BRIEFS accepts a client-supplied idempotency key on the POST (FR-008 write-only reconciliation) | external write path, no canary | Josh | first real BRIEFS post; if not, local dedup-before-POST is the fallback |

## 10. Non-functional requirements

- **Safety:** Gmail sink has no send capability in the code path (FR-011); CRM pipeline
  never blind-mutated (FR-006, approval-gated apply). Staging runs fail closed if any
  resolved path is production.
- **Idempotency + delivery:** reconcilable sinks are exactly-once by reconciliation; the
  batch commitment-fanout Telegram is at-most-once (marker-before-send); the terminal
  receipt Telegram is at-least-once (send+confirm+record, manifest completes only after
  confirmed send); replay yields one reconcilable artifact each (FR-008).
- **Observability:** the run manifest is the single source of truth for run state; dry-run
  writes only an ephemeral `dry_run`-marked manifest the sweep ignores (FR-008);
  `dispatched`/exit-0/markdown are not success signals (FR-004, FR-007).
- **Provenance:** per-run SHA + dist hash + script hash + schema version recorded; a
  mismatch fails that run + notifies (FR-003), never a fleet halt.

## 11. Open follow-ups (out of scope, noted not fixed)

- The daemon step-value cron parser bug (`cron-scheduler.ts:~85-96`) forcing crm
  comms-ingest/calendar-ingest onto the heartbeat workaround — from the superseded spec
  (its FR-C4). Track separately.
- Broader cron modernization + new event lanes (Slack/omi/pr-ci) — superseded spec's
  Subsystems 2 & 3.
- The unrelated typed Telegram suppression in `src/hooks/lib/session-context.ts:101`
  (surfaced by Codex) is core-hook behavior, not meeting suppression — left as-is.

## 12. Handoff notes

**For `/goalify`:** Phase the loop as —
- **P1 (ships first): FR-010** remove suppression + PTS→MSIA alias (pure deletion, stops
  the only confirmed live data loss) **and FR-007** the run manifest (foundational — every
  later phase's acceptance writes to it, so it cannot come later; this fixes the v1.0 C2
  ordering trap).
- **P2: FR-001/002/003** canonical repo-level module + fail-closed schema (incl. TS
  boundary) + per-run provenance; delete pa/pa-codex/frank2-codex copies + de-hardcode
  callers.
- **P3: FR-008/009/013** per-sink reconciliation + child-result capture + re-drive.
- **P4: FR-004/005/006/011** invariant sinks + advisory classification (both gates) +
  approval-gated CRM proposal + wired Gmail draft.

Staging gate after each phase; do not promote to production until both fixtures (MSIA +
Kadre) pass the full matrix. Carry FR-012 verbatim as the non-narrowable DONE guard:
`met=true` requires every FR-004 sink verified on both fixtures with terminal receipts;
deferred/gated work cannot satisfy it.

**For `writing-plans`:** copy §2 constitution verbatim as Global Constraints — especially
"canonical chain at repo level, never inside an agent dir, no hardcoded per-agent paths"
and "pa is dead".

**For plan mode:** start from §4 + §7; the ledger answers "does this exist / where"
without re-probing.

## Testing gate (staging-first, from REVIEW § testing)

Run in `cortextos-staging` (`CTX_INSTANCE_ID=cortextos-staging`, temporary framework/ctx
root, explicit staging stores, BRIEFS stub, Gmail Josh-only self-draft boundary,
PA/Telegram capture). Fail closed if any resolved path is production. **Production
isolation check:** hash the SPECIFIC prod CRM/task/approval objects the fixtures touch
(by entity id) before+after — those must be object-identical; do NOT assert global
byte-identity of prod stores (unrelated prod crons legitimately write concurrently —
v1.0's global-hash gate was unpassable, H9). Gmail Sent unchanged; Gmail Draft may change
only at the Josh-only staging boundary.

**Fixtures MUST be frozen, redacted transcripts committed to the repo — not live-fetched.**
The `--meeting-id` path only filters the recent-transcript page and needs live Fireflies/
OpenRouter creds (`ff-extractor.py:1885-1890`), and old meetings age out of that window; a
fixture that depends on a live fetch is not reproducible. Capture MSIA/Kadre/Julie/Marcos/
internal once, redact, and commit them.

Fixture matrix (each with positive + negative assertions; each fixture seeds its
prerequisites — e.g. the MSIA org must be seeded before the Julie fixture, M4):

| Fixture | Must produce | Must NOT |
|---|---|---|
| MSIA `01KZCGVH6HYN9XX4124033CTJV` | note/writeback; adjudicated OUR/THEIR; OUR candidate tasks with commitmentId; Gmail draft+approval; CRM interaction; explicit commercial outcome; terminal receipt to Josh with real IDs | duplicate identities/deal; THEIR task; fabricated due date; inline pipeline mutation |
| Kadre `01KZMNH3A753Z6Z9JAAJ1V19PC` | note/writeback; adjudicated OUR/THEIR; all invariant sinks; `proposed_new` commercial outcome from cited verbal-yes/deposit/kickoff even when `meeting_type` is `other`/absent | classifier-dependent invariant delta; silent commercial result; inline opportunity/stage mutation |
| Commercial-evidence negative (negation/hypothetical) | `no_evidence` or `ambiguous` with the run still `completed` | a `proposed_new` from hedged/negated speech (false-positive recall guard, C1) |
| Julie / `pts.org` under seeded MSIA | contact email captured + interaction linked; org resolves to existing MSIA via `org-aliases.json` | second/duplicate MSIA-vs-PTS deal; exit-0-empty; domain-wide drop |
| Marcos / Alloi | meeting, commitment, recap draft, CRM interaction all survive normally | any name-substring whole-meeting drop; any special suppression/routing |
| Internal-only meeting | recap + OUR candidate tasks + BRIEFS rows + manifest `internal_skip` | any Gmail draft, CRM interaction, CRM deal outcome, debrief, commercial outcome, or approval |

Per fixture: (1) assert one manifest reaches `completed`, every stage timestamped with
artifact IDs, manifest NOT completed before consumers finish; (2) OUR items on the bus
human-task surface + BRIEFS with same `commitmentId`, THEIR tracker-only, missing dates
`NEEDS-DATE` (no auto-due); (3) replay twice + two concurrent copies → exactly one of each
reconcilable artifact, at most one Telegram; (4) inject failure at every sink boundary
(after task before receipt, after Gmail draft before checkpoint, BRIEFS timeout, CRM write
fail, Telegram fail) → `partial_failed` + exact stage + resume only missing sinks + Josh
escalation after N attempts; (5) force `meeting_type` = `sales`/`other`/absent → invariant
artifact set identical (comparator); (6) corrupt/drop a required schema field → visible
fail (incl. the TS boundary); (7) prove deployment SHA + dist hash + script hash + schema
version match the staged candidate before each pass; (8) reject a `proposed_new` then feed
a new-evidence meeting → re-proposal allowed. **Any uncovered requirement or failed
assertion is RED and blocks release.**

## Changelog
- **2026-08-11 v1.2** — Adversarial rounds 2 & 3 → **CONVERGED (zero CRITICAL, zero HIGH)**.
  Round 2 (Fable): 0 CRITICAL, 5 residual HIGH (C3 promotion-record source, H2 resume-race,
  H7 key-less re-drive, NEW-1 internal sink-set contradiction, NEW-2 false Telegram
  backstop) — all fixed inline. Round 2 (Codex): 0 verdict reversals; corrected line
  citations on G-16/17/18/19/21/22/24/25, bucketed FR-013 B→C, surfaced BRIEFS-non-queryable
  + Gmail-no-draft-id + fixtures-must-be-frozen (added A-04/A-05 + frozen-fixture rule +
  FR-010/FR-008/FR-011 reconciliation reality). Round 3 (Fable) confirm: C3/H2/H7/NEW-1
  resolved, NEW-2 partial + a new HIGH (resume-lease had no expiry) — both fixed (split the
  two Telegram uses across §10/FR-009; added lease TTL + stuck-lease escalation to
  FR-007/FR-004). No CRITICAL at any round; all HIGH closed.
- **2026-08-11 v1.1** — Adversarial round 1 (Codex grounding + Fable logic/scope):
  Fable 3 CRITICAL / 9 HIGH, Codex 5 wrong/updated ledger rows + 12 unrecorded
  assumptions + 2 bucket corrections. Fixes applied inline: deterministic commercial-
  evidence rule + always-emit outcome (C1); manifest made foundational/P1, no P1 criterion
  depends on a later artifact (C2); provenance descoped to per-run observability+guard, no
  fleet halt (C3); per-sink delivery semantics chosen — reconcile vs Telegram at-most-once
  (H1); atomic O_EXCL manifest as per-meeting lock (H2); terminal receipt retargeted to
  Josh, not dead `pa` (H3); canonical module expanded to the whole chain incl. crm-sync/
  recap-draft/TS-boundary + de-hardcode callers + delete frank2-codex copy (H4, G-21);
  candidate-task surface named + reconciliation via manifest key-map (H5, G-18); approval
  lifecycle + re-proposal keying (H6); re-drive FR added (H7, FR-013); FR-010 resequenced
  first (H8); prod-isolation hash scoped to fixture entities (H9); FR-006/FR-008 rebucketed
  B→C. Added ledger rows G-16..G-24. **Not yet converged — round 2 pending.**
- **2026-08-11 v1.0** — initial. Probed 15 claims (13 VERIFIED, 1 later corrected to
  PARTIAL [G-04], 1 UNVERIFIABLE [G-15]). Clarification gate closed with Josh.
