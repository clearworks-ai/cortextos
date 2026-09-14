---
title: Client State v1 — Gmail thin slice
slug: client-state-gmail-v1
date: 2026-09-14
mode: standard
status: draft-in-probes
supersedes: state/specs/2026-09-14-client-state-loop-brief.md (implements its v1 wedge per amended D-08)
owner: Josh
---

# Client State v1 — Gmail thin slice (spec DRAFT)

The wedge from the approved brief, post-roast: ONE source (Gmail), the shared write
discipline, and the detection net — built directly against the existing resolver and CRM
machinery. The spine (observation store as a subsystem, source-slack-window, GitHub
narrative) is deliberately NOT here; it gets extracted when the second source lands.

Mockup gate: **No UI surface; mockup gate N/A** — outputs are CRM rows, markdown History
entries, bus tasks, and Telegram messages, all with existing rendering.

## Requirements

### FR-001 — Observation ledger (one identity scheme)
System MUST record one observation row per handled Gmail message in an append-only JSONL
ledger, keyed by `source_ref = "gmail:<messageId>"` — the SAME scheme add-interaction.py
already dedupes on, not a second key — carrying `{source_ref, thread_id, content_digest,
observed_at, resolution: {slug, kind, method} | {escalated} | {ignored, reason},
writes: [paths/task ids]}`.
- WHEN the handler processes a message whose `source_ref` already has a row with the same
  `content_digest` THE SYSTEM SHALL make no writes and record nothing.
- WHEN the same `source_ref` arrives with a DIFFERENT digest (edited draft re-sent, rare
  for Gmail) THE SYSTEM SHALL write a superseding History entry marked as a revision and
  append (never rewrite) — D-02 semantics.
- [Bucket: B — source_ref convention VERIFIED (G-01, G-02); the ledger file itself is new]

### FR-002 — Bounded-window poller, dedup instead of cursor
System MUST poll Gmail on a schedule (pa-codex cron) over a FIXED lookback window
(default 3 days), relying on FR-001's observation ledger for idempotency — no cursor
file. This matches the repo's only existing convention (comms-backfill.py rescans a
7-day window and dedups by source_ref; probe G-06 found no cursor pattern anywhere) and
makes crash recovery trivial: re-running is always safe.
- WHEN the poller runs THE SYSTEM SHALL list messages from the last N days for
  `josh@clearworks.ai` and process only those with no observation row for their
  (source_ref, content_digest).
- The list call returns AT MOST 50 messages and exposes no pagination (G-11: gws-dwd
  caps max_results at 50, no pageToken wired). WHEN a filtered window returns exactly 50
  THE SYSTEM SHALL narrow the window (halve N) and re-query until under the cap, and
  SHALL report in FR-009's digest whenever narrowing was needed — hitting the cap
  silently is exactly the "silent cap" failure the Contrarian seat warned about.
- WHEN the poller has not completed successfully for longer than the lookback window
  THE SYSTEM SHALL say so in FR-009's daily digest (a gap larger than the window is
  silent data loss — the failure class this system is built to avoid).
- [Bucket: B — pattern exists in comms-backfill.py, ledger is new]

### FR-003 — Relevance filter: known entities only
System MUST file only messages that resolve to a known entity; the rest are ignored
observations, not escalations.
- WHEN a message's counterparty (sender for inbound, recipients for outbound) matches a
  CRM contact email or a page-declared domain THE SYSTEM SHALL proceed; otherwise THE
  SYSTEM SHALL record `{ignored, reason: "no-known-entity"}` and write nothing.
- WHEN a KNOWN counterparty matches but page binding conflicts (contact maps to one page,
  domain to another) THE SYSTEM SHALL escalate one Telegram (routing, not approval) and
  record `{escalated}`.
- The automated-sender exclusion SHALL reuse the EXISTING comms-check Gmail query
  VERBATIM (comms-check-worker/SKILL.md step 2: -category:promotions -category:social,
  every no-reply/donotreply/mailer-daemon variant, notify.railway.app,
  notifications@github.com, Accepted:/Declined:/Tentative:/out-of-office/auto-reply
  subjects) plus `cortextos bus comms-filter --namespace gmail` for first-seen dedup —
  the "real people only" filter Josh already trusts, not a re-implementation. Layer the
  known-entity match on top of what survives it.
- Unknown-but-real humans are NOT this system's job: PA's comms-check lane already
  surfaces actionable mail from unknown real senders to Josh as [HUMAN] tasks (the
  ATTENTION lane); client-state is the RECORDS lane and files them once they become
  known entities. Complementary, not overlapping.
- `[NEEDS CLARIFICATION: D-11 — Josh confirms: known entities only for STATE writes,
  reusing the comms-check query as the machine filter; unknown humans stay covered by
  the comms-check attention lane. One line.]`

### FR-004 — Entity resolution via the existing machinery
System MUST resolve the entity using the resolver's source-agnostic core (page domains,
declared `- CRM org name:` lines, contact-email lookup) — no meeting envelope, no new
resolver.
- WHEN the counterparty email's registrable domain maps via page `domains:` or a contact
  row's company maps via declared names THE SYSTEM SHALL bind to that page; ambiguity per
  FR-003's escalation rule.
- [Bucket: A — load_closed_sets takes only vault; call path verified (G-05)]

### FR-005 — Bounded extraction (email-shaped, quote-grounded)
System MUST derive `{summary, commitments[], decisions[], open_questions[]}` from the
message via ONE bounded LLM call whose outputs are quote-grounded against the message
body, reusing the meeting pipeline's validation seam (quote gate, RELATIONSHIPS/commitment
shape) with an email-specific prompt — a sibling `extract_email.py`, not a fork of the
meeting prompt.
- WHEN any extracted item's quote is not present in the body THE SYSTEM SHALL drop that
  item and count it, exactly as the meeting quote_gate does.
- WHEN the message is trivial ((&lt;2 sentences after quote-stripping, pure scheduling
  chatter) THE SYSTEM SHALL file a History line with no extraction call — cost control.
- INJECTION SURFACE (G-12): the gws shim routes Gmail straight to gws-dwd, BYPASSING
  Model Armor sanitization by design — email bodies reach the extraction LLM unfiltered,
  and the quote gate does not help against attacker-authored text (a hostile body's own
  words are, by definition, grounded quotes). Bounds and rules: only FR-003-known
  entities ever reach extraction; the extraction call SHALL have no tool access and a
  schema-constrained output; commitments extracted from email SHALL only ever become
  bus tasks and digest lines — never an autonomous action; and every email-sourced task
  appears in FR-009's daily digest so an implausible commitment is seen within a day.
- [Bucket: B — quote_gate imports unmodified (it reads only text_units); a sibling
  email extraction schema is required: drop owner_participant/meeting_type, new schema
  const (G-04 PARTIAL)]

### FR-006 — CRM write (facts half, D-01/D-03)
System MUST append one interaction row per known contact on the message via
`add-interaction.py --type email --source-ref gmail:<messageId>` (existing dedup:
source_ref + contact_id) and MUST fill blank contact facts only — never overwrite a
non-blank or human-entered value.
- WHEN the existing Gmail ingest (comms-backfill / its cron) has already written a row
  for the same source_ref+contact THE SYSTEM SHALL not duplicate it (same dedup key —
  this is the D-08 dedup gate made mechanical).
- VERIFIED feasible as written: `--type email` is an existing argparse choice and dedup
  is update-in-place on source_ref+contact_id (G-01). The live writer to coexist with is
  comms-backfill.py, piggybacked on crm-codex's 4h heartbeat because the dedicated
  comms-ingest cron is BROKEN (daemon step-value cron parser bug — G-02). This handler
  must either subsume that piggyback or coexist via the shared source_ref convention;
  subsuming is preferred and is a scope decision for the plan, not silent.
- [Bucket: A]

### FR-007 — Client page write (narrative half, D-01/D-03)
System MUST append one dated History entry to the bound page:
`- YYYY-MM-DD — <subject> (email) [source: gmail:<messageId>]` with the extraction's
summary/decisions/open-questions as sub-bullets — append-only; supersedes are marked
replacement entries (roast amendment), never silent rewrites.

### FR-008 — Commitments → tasks with cross-source dedup (D-05)
System MUST create one bus task per extracted OURS commitment UNLESS a near-identical
open commitment already exists (normalized owner+text similarity vs open items and open
bus tasks) — one commitment, many evidences; the meeting that promised it and the email
that confirms it yield ONE task.
- WHEN a duplicate is suppressed THE SYSTEM SHALL append the new source_ref to the
  existing task/open-item row as additional evidence.

### FR-009 — Detection, not approval (roast amendment to D-03)
System MUST send Josh one daily Telegram digest listing every state change made by
automated writers in the last day (page + one line + source ref), and MUST run a daily
invariant check (every CRM org name declared on exactly ≤1 page; every History source ref
resolvable) whose violations appear in the same digest.
- WHEN no changes and no violations THE SYSTEM SHALL send the one-line OK (a silent
  watcher is indistinguishable from a dead one).
- [Bucket: B — extend meeting_loop_watch.py main() directly; no plugin seam exists (G-07 PARTIAL)]

### FR-010 — Meeting pipeline untouched
The meeting pipeline's behavior MUST be unchanged: its suite stays green, no shared file
is modified except where an FR names it, and any shared function used is used read-only.
- WHEN the brain test suite runs after this build THE SYSTEM SHALL pass with the same
  count delta accounting used by G1 (every new test attributed).

## Decisions (CONTEXT)
Inherited from the brief (D-01..D-10 as amended by the roast verdict recorded there).
New here: D-11 (FR-003's relevance filter) — **inferred, needs Josh's confirm at the
clarification gate.**

## Grounding Ledger

Probes run 2026-09-14 by two read-only subagents (code claims; live gws capability).
Full evidence excerpts in the probe returns; condensed rows here.

| ID | Claim (settled fact) | Probe | Evidence | Verdict |
|----|----------------------|-------|----------|---------|
| G-01 | `add-interaction.py --type` accepts exactly {email, meeting, call, message, social, manual, task}; dedup = source_ref+contact_id, update-in-place | read add-interaction.py | `:52` argparse choices; `:86` dedup match | VERIFIED |
| G-02 | The only live Gmail→CRM writer is comms-backfill.py, piggybacked on crm-codex's 4h heartbeat because the dedicated comms-ingest cron is broken (daemon step-value cron parser bug); writes `--type email --source-ref gmail:<id>` | read comms-backfill.py + crons.json | `:118-123`, `:175`, `:201`; heartbeat prompt documents the workaround | VERIFIED |
| G-03 | contacts.json is `{contacts:[{id,name,emails:[...]}]}`; email→contact lookup exists (resolve_meeting.py) | read both | `resolve_meeting.py:54`, `:845-846` | VERIFIED |
| G-04 | quote_gate (resolve_meeting.py:402) is source-shape-generic (needs only extraction + text_units) and imports unmodified; extract_meeting's PROMPT, owner_participant, meeting_type and schema const are meeting-coupled — extract_email needs a sibling schema | read extract_meeting.py + extraction.schema.json + quote_gate | `:402`; schema requires owner_participant, meeting_type enum | PARTIAL — reuse gate + validator walker; new schema/prompt required |
| G-05 | load_closed_sets(vault) builds domain_to_slug + org_name_to_slug from pages alone; smallest call path is `closed["domain_to_slug"].get(registrable_label(domain))` / `closed["org_name_to_slug"].get(_norm_title(name))` | read resolve_meeting.py:295-352 | signature takes only vault | VERIFIED |
| G-06 | No incremental cursor convention exists; nearest patterns are fireflies-ingest's seen-ledger and comms-backfill's fixed-window + source_ref dedup | grepped crm/ + scripts/brain | comms-backfill docstring: 7-day window, no cursor | PARTIAL — FR-002 adopts fixed window + ledger dedup |
| G-07 | meeting_loop_watch.py is one linear main() with no source-plugin seam; a gmail check extends main() directly | read meeting_loop_watch.py:105-158 | single flow fetch→diff→probe→message | PARTIAL — extend main() |
| G-08 | `gws gmail +triage --query --max` lists messages with stable id/threadId | live run, 5 rows | ids + threadIds returned | VERIFIED |
| G-09 | `gws gmail +read --id` returns headers-only or headers+body | live run both modes | full mode keys include body (len 793) | VERIFIED |
| G-10 | Date-query cursoring works (`after:`, `newer_than:`); NO historyId mechanism exposed (gws-dwd never calls history.list) | live runs | date-consistent rows both queries | VERIFIED (date-window only) |
| G-11 | List is capped at 50/call, no pagination; resultSizeEstimate is query-insensitive (flat 201) and unusable as a count; 7-day sample: 33/50 messages from external domains, top external = github noise the FR-003 query already excludes | live runs, sampled | identical estimate across disjoint queries | PARTIAL — cap owned by FR-002; counts approximate |
| G-12 | The gws shim execs gws-dwd for gmail BEFORE the --sanitize branch — Model Armor never inspects Gmail payloads; email content reaches downstream LLMs unfiltered | read ~/.local/bin/gws | `:31-33` comment + exec | VERIFIED — hardening rules in FR-005 |

## Accepted assumptions (owned)

- Exact 7-day inbox volume is unknowable through this CLI (G-11); the poller's cap-and-
  narrow rule plus FR-009 reporting owns the residual risk. Owner: Josh (accepted by
  building FR-002 this way).
- The comms-ingest daemon cron stays broken until the cron root-cause work lands; the
  heartbeat piggyback (or this handler subsuming it) is the interim. Owner: Josh.

## Roast verdict
Inherited: RESHAPE with accepted amendments, recorded in the brief
(2026-09-14, scores 6/4/3/7/4). This spec IS the reshaped wedge; premise unchanged since.
