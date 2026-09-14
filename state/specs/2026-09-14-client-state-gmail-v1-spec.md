---
title: Client State v1 — Gmail thin slice
slug: client-state-gmail-v1
date: 2026-09-14
mode: standard
status: draft-round-1-applied
supersedes: state/specs/2026-09-14-client-state-loop-brief.md (implements its v1 wedge per amended D-08)
owner: Josh
---

# Client State v1 — Gmail thin slice (spec DRAFT)

The wedge from the approved brief, post-roast: ONE source (Gmail), the shared write
discipline, and the detection net — built directly against the existing resolver and CRM
machinery. The spine (observation store as a subsystem, source-slack-window, GitHub
narrative) is deliberately NOT here; it gets extracted when the second source lands.

**Scope (round 1): INBOUND mail only.** Josh's sent mail is an explicit v1.1 deferral —
the reused relevance query is an inbound-triage filter with no sent-mail variant, and the
demo ("an email from Marcos comes in") is inbound. See Non-goals.

Mockup gate: **No UI surface; mockup gate N/A** — outputs are CRM rows, markdown History
entries, bus tasks, and Telegram messages, all with existing rendering.

## Requirements

### FR-001 — Observation ledger (one identity scheme)
System MUST record one observation row per handled Gmail message in an append-only JSONL
ledger, keyed by `source_ref = "gmail:<messageId>"` — the SAME scheme add-interaction.py
already dedupes on, not a second key — carrying `{source_ref, thread_id, content_digest,
observed_at, outcome: "filed" | "escalated" | "ignored", reason?, resolutions:
[{slug, kind, method}], writes: [paths/task ids]}`. `resolutions` is a LIST: a message
legitimately involving two known entities files to both, and the ledger records both.
- WHEN the handler processes a message whose `source_ref` already has a row with the same
  `content_digest` AND `outcome: "filed"` THE SYSTEM SHALL make no writes and record
  nothing. The skip predicate is outcome-aware: `ignored` and `escalated` rows are NOT
  terminal — a message still inside the poll window is RE-EVALUATED each run (a cheap
  resolution re-check, no LLM call until it files), so a sender Josh adds to the CRM
  today gets yesterday's mail filed tomorrow without any special machinery.
- WHEN a sender becomes a known entity AFTER their mail has left the poll window THE
  SYSTEM SHALL support a manual backfill invocation (`--days N` and/or `--query
  "from:<addr>"`) that re-runs the same handler over the wider window; the daily digest's
  ignored-sender counts are the cue to run it. (Automatic on-contact-add sweeps are v1.1.)
- WHEN the same `source_ref` arrives with a DIFFERENT digest (edited draft re-sent, rare
  for Gmail) THE SYSTEM SHALL write a superseding History entry marked as a revision and
  append (never rewrite) — D-02 semantics. Supersede PROPAGATION (roast amendment,
  specified here): the facts half (CRM interaction row) is update-in-place by the
  existing source_ref+contact dedup — that rewrite is INTENDED for facts and the digest
  reports it as a revision; any OPEN bus task derived from the superseded digest is
  flagged in the daily digest as "evidence superseded — review", never auto-closed.
- [Bucket: C — the source_ref convention is verified (G-01, G-02) but the ledger is a
  new persistent artifact with its own schema, not reuse of an existing store]

### FR-002 — Bounded-window poller, dedup instead of cursor
System MUST poll Gmail on a `*/10 * * * *` pa-codex cron over a FIXED lookback window
(default 3 days), relying on FR-001's observation ledger for idempotency — no cursor
file. This matches the repo's only existing convention (comms-backfill.py rescans a
7-day window and dedups by source_ref; probe G-06 found no cursor pattern anywhere) and
makes crash recovery trivial: re-running is always safe.
- The schedule is expressible: the daemon cron parser supports `*/N` (probed round 1:
  cron-scheduler.ts expandField `*/`-branch; cron-parser-live-fleet.test.ts documents the
  only broken form as range-with-step, e.g. `8-18/2`, which this cron does not use). The
  cron SHALL be installed directly into pa-codex's crons.json via `bus create-cron` —
  NEVER via config.json migration, whose `enabled`-key refusal and once-per-agent guard
  are the two defects that silently killed prior crons.
- WHEN the poller runs THE SYSTEM SHALL take a single-flight LOCK (claim file, same
  pattern as pre_meeting_brief's claims; stale locks older than 2× the interval are
  broken) so overlapping runs cannot double-append History entries.
- WHEN the poller runs THE SYSTEM SHALL list messages from the last N days for
  `josh@clearworks.ai` and process only those not skipped by FR-001's outcome-aware
  predicate, and on success SHALL write a RUN RECEIPT (`{last_success_at, window_days,
  message_count}`) — the artifact gap detection reads; per-message rows alone cannot
  distinguish a quiet weekend from a dead poller.
- The list call returns AT MOST 50 messages and exposes no pagination (G-11: gws-dwd
  caps max_results at 50, no pageToken wired). WHEN a filtered window returns exactly 50
  THE SYSTEM SHALL narrow the window and re-query, with a FLOOR of 1 day (Gmail date
  operators are day-granular — G-10 — so halving below a day cannot change the query).
  WHEN a single day still returns 50 THE SYSTEM SHALL process those 50 in the order the
  list returns them and REPORT the truncation (day + count) in FR-009's digest — a
  bounded, reported loss on a freak day, never an infinite narrowing loop.
- WHEN the run receipt's `last_success_at` is older than the lookback window THE SYSTEM
  SHALL say so in FR-009's daily digest AND state that a manual `--days N` backfill is
  needed to cover the gap (detection plus the named repair, not detection alone).
- [Bucket: B — pattern exists in comms-backfill.py; ledger, lock, and receipt are new]

### FR-003 — Relevance filter: known entities only
System MUST file only INBOUND messages that resolve to a known entity; the rest are
ignored observations, not escalations.
- WHEN a message's sender matches a CRM contact email or a page-declared domain THE
  SYSTEM SHALL proceed; otherwise THE SYSTEM SHALL record `{ignored, reason:
  "no-known-entity"}` and write nothing. (Ignored rows re-evaluate per FR-001 while in
  window; the digest carries ignored-sender counts as the backfill cue.)
- WHEN one sender resolves AMBIGUOUSLY (contact maps to one page, domain to another)
  THE SYSTEM SHALL escalate one Telegram (routing, not approval) and record
  `{escalated}`. A message whose known counterparties each resolve CLEANLY to different
  entities is NOT a conflict — it fans out (FR-007 writes each bound page; FR-001
  records the list). Multi-party mail is a normal event, not an escalation.
- The automated-sender exclusion SHALL reuse the EXISTING comms-check Gmail QUERY STRING
  VERBATIM (comms-check-worker/SKILL.md step 2: -category:promotions -category:social,
  every no-reply/donotreply/mailer-daemon variant, notify.railway.app,
  notifications@github.com, Accepted:/Declined:/Tentative:/out-of-office/auto-reply
  subjects) — the "real people only" filter Josh already trusts, not a re-implementation.
  The records lane SHALL NOT invoke `bus comms-filter`: that command is a MUTATING
  shared first-seen gate (bus.ts comms-filter → checkAndRecordSourceEvent, 30-day
  suppression in the shared `comms-event-dedup.json`, keys `gmail:<id>`) already
  consumed by PA's attention lane — piping the records lane through it would starve
  whichever lane runs second (probed round 1, both reviewers independently). FR-001's
  ledger is this lane's ONLY idempotency layer; the attention lane's gate is untouched.
- Unknown-but-real humans are NOT this system's job: PA's comms-check lane already
  surfaces actionable mail from unknown real senders to Josh as [HUMAN] tasks (the
  ATTENTION lane); client-state is the RECORDS lane. Complementary, not overlapping —
  and with comms-filter out of this lane, they now share no mutable state.
- D-11 CONFIRMED (Josh, 2026-09-14: "the whole email filter we built for what matters.
  real people only. could be worth it." + "ok"): known entities only for STATE writes;
  the comms-check query is the machine filter; unknown humans stay covered by the
  comms-check attention lane.
- [Bucket: B — query string reused verbatim; the filter harness around it is new]

### FR-004 — Entity resolution via the existing machinery
System MUST resolve the entity using the resolver's source-agnostic PIECES (page-domain
maps, declared `- CRM org name:` lines, contact-email lookup) — no meeting envelope. The
pieces exist but are NESTED inside meeting-shaped `resolve()` (`_match_contact`,
`_resolve_company_slug` are inner functions): extracting the standalone
email→entity seam is implementation work, not a bare import.
- Domain lookup SHALL use the FULL-domain key: `closed["domain_to_slug"].get(<domain>)`.
  The map also carries bare registrable-LABEL keys, but labels collide (`example.com`
  and `example.org` both label to `example`, last-writer-wins — resolve_meeting.py:207,
  :311); the full-domain key is the collision-free one and the ONLY one this FR uses.
- WHEN a matched contact has an empty/missing company, or a name key is empty or
  duplicate-suppressed in the closed sets, THE SYSTEM SHALL treat it as NO match
  (→ ignored or escalated per FR-003) — never pass None/"" into `_norm_title` or bind
  to a "" key (probed: `_norm_title(None)` raises; duplicate CRM names produce "" keys).
- [Bucket: B — maps and lookups verified (G-05), but the standalone resolution seam
  with the guards above must be built (round-1 correction from A)]

### FR-005 — Bounded extraction (email-shaped, quote-grounded)
System MUST derive `{summary, commitments[], decisions[], open_questions[]}` from the
message via ONE bounded LLM call whose itemized outputs are quote-grounded against the
message body, reusing the meeting pipeline's validation pieces with an email-specific
prompt — a sibling `extract_email.py`, not a fork of the meeting prompt.
- The reuse contract names ALL the pieces (round-1 correction — the gate alone is not
  the validation): `quote_gate` for item grounding, PLUS `validate_extraction`'s
  single-line/control-character checks, PLUS schema validation of the model output.
  Known gate behaviors carried knowingly: `summary` is NOT quote-grounded (it renders
  as derived text in FR-007 and appears in the digest, where a wrong summary is visible
  within a day); grounded availability pleasantries are dropped by design.
- Extraction runs on EVERY filed message — no triviality gate. (Round-1 removal: "pure
  scheduling chatter" is not deterministically decidable, and a one-line "yes, we'll
  sign Friday" is exactly the decision+commitment short mail exists to capture. Volume
  is already bounded by FR-003's two filters; the cost control is the relevance filter,
  not a length rule.)
- Cross-source commitment context: the call SHALL receive the bound entity's open items
  and open email-sourced task titles as context and return, per commitment, an optional
  `matches_open_item` id — the semantic half of FR-008's dedup, done inside the one call
  this FR already pays for, quote-gated like every other item.
- INJECTION SURFACE (G-12): the gws shim routes Gmail straight to gws-dwd, BYPASSING
  Model Armor sanitization by design — email bodies reach the extraction LLM unfiltered,
  and the quote gate does not help against attacker-authored text (a hostile body's own
  words are, by definition, grounded quotes). Bounds and rules: only FR-003-known
  entities ever reach extraction; the extraction call SHALL have no tool access and a
  schema-constrained output; commitments extracted from email SHALL only ever become
  HUMAN-EXEMPT bus tasks and digest lines (FR-008 — agents never execute them); and
  every email-sourced task appears in FR-009's daily digest so an implausible
  commitment is seen within a day.
- [Bucket: C — quote_gate imports unmodified (it reads only text_units), but the sibling
  schema, prompt, and validation harness are a new artifact (round-1 correction from B)]

### FR-006 — CRM write (facts half, D-01/D-03)
System MUST append one interaction row per known contact on the message via
`add-interaction.py --type email --source-ref gmail:<messageId>` (existing dedup:
source_ref + contact_id, update-in-place).
- FACT SCOPE (round-1 pin — the fill-blanks clause needs a named source): v1 writes NO
  contact facts from message content. The ONLY fact write is minimal contact
  auto-creation when a domain-matched sender has no contact row yet: `{name}` from the
  From display name, `{email}` from the address — headers, never body parsing, never
  signature scraping. Fill-blanks-only governs exactly that row; nothing else fills
  anything.
- WHEN the existing Gmail ingest (comms-backfill / its heartbeat piggyback) has already
  written a row for the same source_ref+contact THE SYSTEM SHALL not duplicate it (same
  dedup key — the D-08 dedup gate made mechanical).
- SUBSUME chosen (Josh "ok" 2026-09-14): this handler becomes the one Gmail reader and
  the heartbeat piggyback line is removed from crm-codex's cron prompt — but removal is
  GATED on a coverage diff, not just the dedup key (round-1 addition): run both writers
  in parallel for 7 days, enumerate every interaction row the old path wrote that the
  new path did not (the new filter is strictly narrower — comms-check exclusions +
  known-entity gate), and rule on each excluded class before the piggyback line is
  deleted. Dedup prevents doubles; the diff catches silent coverage loss.
- [Bucket: A for the interaction write (G-01); the rollout diff is a build step]

### FR-007 — Client page write (narrative half, D-01/D-03)
System MUST append one dated History entry to EACH bound page (fan-out per FR-003):
`- YYYY-MM-DD — <subject> (email) [source: gmail:<messageId>]` with the extraction's
summary/decisions/open-questions as sub-bullets — append-only; supersedes are marked
replacement entries (roast amendment), never silent rewrites.
- This is a NEW renderer, not a reuse (round-1 correction): the existing
  writeback_render is meeting-shaped (renders `(meeting: <path>)` lines) and its
  idempotency REFUSES revisions — any existing `[source:]` marker returns the old page
  unexamined (writeback_render.py:83), which is exactly wrong for D-02. The email
  renderer takes `(source_ref, digest)` and appends a marked revision entry when the
  digest is new.
- [Bucket: B — page format and append conventions exist; renderer + supersede path new]

### FR-008 — Commitments → tasks with cross-source dedup (D-05)
System MUST create one bus task per extracted OURS commitment UNLESS a matching open
commitment already exists — one commitment, many evidences; the meeting that promised it
and the email that confirms it yield ONE task.
- CONTAINMENT (fixes the round-1 CRITICAL): every email-sourced task SHALL be created
  HUMAN-EXEMPT — `type: human`, assigned to `human` — which the bus actually enforces
  (isHumanExemptTask guards reclaim/list/exec paths, task.ts:257/351/560/651; multica
  maps them to Josh). Rationale: bus task defaults are autonomous (`type: agent`,
  assignee auto-resolves, immediate notify) and `needs_approval` is set but enforced
  NOWHERE — a compromised known-contact account must never be able to make an agent act
  by writing an email. Josh promotes a task to an agent deliberately if he wants it run.
- DEDUP ALGORITHM (round-1 pin — "near-identical" was untestable): two tiers, either
  suppresses. Tier 1, deterministic: normalized owner match (casefold, alias-normalized)
  AND `difflib.SequenceMatcher` ratio ≥ 0.75 on normalized text (the threshold already
  proven by dedupe_history.py on this corpus). Tier 2, semantic: the extraction call's
  `matches_open_item` id (FR-005) — this is what catches "Send Alloi the tacticals doc"
  vs "share the tactical plan with Marcos", which no string ratio will.
- The dedup READER must enumerate deliberately (round-1 pin): `list-tasks` defaults to
  the build class and 50 rows — the check SHALL query the relevant classes explicitly
  with explicit limits, plus the bound entity's page open items.
- WHEN a duplicate is suppressed THE SYSTEM SHALL record the new source_ref as evidence
  in the FR-001 ledger row and note it in the daily digest. v1 does NOT mutate the
  existing task (no structured evidence-append operation exists on bus tasks — probed;
  inventing one is not this wedge).
- Cross-source identity is NEW machinery (round-1 pin): existing commitment ids hash
  source kind+id+text+ordinal (adapt_meeting.py:60) — by construction never equal across
  sources. The dedup above IS the cross-source join; no shared id is pretended.
- [Bucket: B]

### FR-009 — Detection, not approval (roast amendment to D-03)
System MUST send Josh one daily Telegram digest listing every state change made by
automated writers in the last day (page + one line + source ref), and MUST run a daily
invariant check (every CRM org name declared on ≤1 page; every post-epoch History source
ref present in the observation ledger) whose NEW violations appear in the same digest.
- WHEN no changes and no violations THE SYSTEM SHALL send the one-line OK (a silent
  watcher is indistinguishable from a dead one).
- BASELINE (round-1 pin — first-run flood kills the channel): the invariant check runs
  against a one-time committed baseline snapshot; pre-existing violations and pre-ledger
  refs (300 meetings of `fireflies:` history) are grandfathered — only NEW violations
  reach the digest. "Resolvable" means present in the observation ledger, defined only
  for refs written after the ledger epoch.
- INDEPENDENCE (round-1 pin): the Gmail digest section SHALL run and send even when the
  Fireflies section fails — meeting_loop_watch.py currently returns before ANY
  notification when FIREFLIES_API_KEY is missing (line 111-115); the extension
  restructures main() into independently-failing sections, each reporting its own error
  line rather than aborting the message.
- DELIVERY (round-1 pin): digest and escalation sends SHALL NOT reuse `gmail:<id>` keys
  in any shared dedup namespace (the attention lane owns those; a consumed key silently
  suppresses the escalation) — any send-side dedup uses a `clientstate:` prefix. Long
  digests split at Telegram's 4096-char bound (existing api.ts behavior, acceptable).
- Poller-gap and cap-truncation lines from FR-002 land in this digest.
- [Bucket: B — extend meeting_loop_watch.py main() directly; no plugin seam exists (G-07 PARTIAL)]

### FR-010 — Meeting pipeline untouched
The meeting pipeline's behavior MUST be unchanged: its suite stays green, no shared file
is modified except where an FR names it, and any shared function used is used read-only.
- WHEN the brain test suite runs after this build THE SYSTEM SHALL pass with the same
  count delta accounting used by G1 (every new test attributed).

## Decisions (CONTEXT)
Inherited from the brief (D-01..D-10 as amended by the roast verdict recorded there).
New here: D-11 (FR-003's relevance filter) — **settled** (Josh 2026-09-14).
Round-1 scope call, flagged for Josh: **inbound-only v1** (sent mail deferred to v1.1) —
inferred from "simplest possible solution" + the inbound-shaped reused filter; say the
word and outbound gets specced as a v1.1 delta.

## Non-goals (v1)
- Josh's SENT mail (outbound counterparty filing) — v1.1; the reused triage query has no
  sent variant and the demo is inbound.
- Automatic backfill sweep on contact-add — v1.1; manual `--days/--query` backfill +
  digest cue covers it.
- Structured evidence-append on bus tasks — ledger + digest carry the evidence.
- Everything the brief already excludes (proposal service, spine extraction, other sources).

## Grounding Ledger

Probes run 2026-09-14 by two read-only subagents (code claims; live gws capability),
corrected 2026-09-14 by adversarial round 1 (Codex grounding pass + logic pass + main-
thread verification probes). Full evidence excerpts in the probe returns; condensed here.

| ID | Claim (settled fact) | Probe | Evidence | Verdict |
|----|----------------------|-------|----------|---------|
| G-01 | `add-interaction.py --type` accepts exactly {email, meeting, call, message, social, manual, task}; dedup = source_ref+contact_id, update-in-place | read add-interaction.py | `:52` argparse choices; `:86` dedup match | VERIFIED |
| G-02 | The only live Gmail→CRM writer is comms-backfill.py, piggybacked on crm-codex's 4h heartbeat. **CORRECTED round 1:** the daemon cron parser is NOT broken for `*/N` — expandField supports star-slash-N; the only broken form is range-with-step (`8-18/2`, silently mis-parsed), used by ZERO live crons (cron-parser-live-fleet.test.ts documents the old comms-ingest diagnosis as a non-issue). The real cron killers are the two MIGRATION defects (enabled-key refusal; once-per-agent guard) — avoided by installing crons directly via `bus create-cron`. | read comms-backfill.py + crons.json; round-1 re-probe of cron-scheduler.ts + regression test | `cron-scheduler.ts` expandField; `cron-parser-live-fleet.test.ts:13-30` | VERIFIED (corrected) |
| G-03 | contacts.json is `{contacts:[{id,name,emails:[...]}]}`; email→contact lookup exists but is NESTED inside meeting-shaped resolve() — a standalone seam must be extracted (FR-004) | read both; round-1 correction | `resolve_meeting.py:54`, `:845-846`; `_match_contact`/`_resolve_company_slug` nested | VERIFIED (nesting caveat) |
| G-04 | quote_gate (resolve_meeting.py:402) is source-shape-generic (needs only extraction + text_units) and imports unmodified; it does NOT ground `summary` and drops availability pleasantries; single-line/control-char checks live separately in validate_extraction. extract_meeting's PROMPT, owner_participant, meeting_type and schema const are meeting-coupled — extract_email needs a sibling schema | read extract_meeting.py + extraction.schema.json + quote_gate; round-1 additions | `:402`; extract_meeting.py:101/:178/:358 | PARTIAL — reuse gate + validator pieces; new schema/prompt required |
| G-05 | load_closed_sets(vault) builds domain_to_slug + org_name_to_slug from pages alone. **CORRECTED round 1:** domain_to_slug carries BOTH full-domain and bare-label keys; label keys collide (last-writer-wins) and duplicate CRM names produce "" keys — FR-004 uses full-domain keys only and treats ""/None as no-match | read resolve_meeting.py:295-352; round-1 re-probe :207/:311 | registrable_label + both-key insert confirmed | VERIFIED (corrected) |
| G-06 | No incremental cursor convention exists; nearest patterns are fireflies-ingest's seen-ledger and comms-backfill's fixed-window + source_ref dedup | grepped crm/ + scripts/brain | comms-backfill docstring: 7-day window, no cursor | PARTIAL — FR-002 adopts fixed window + ledger dedup |
| G-07 | meeting_loop_watch.py is one linear main() with no source-plugin seam; it RETURNS before any notification when FIREFLIES_API_KEY is missing — sections must fail independently (FR-009) | read meeting_loop_watch.py:105-158; round-1 addition | `:111-115` early return rc=2 | PARTIAL — extend main(), restructured |
| G-08 | `gws gmail +triage --query --max` lists messages with stable id/threadId | live run, 5 rows | ids + threadIds returned | VERIFIED |
| G-09 | `gws gmail +read --id` returns headers-only or headers+body | live run both modes | full mode keys include body (len 793) | VERIFIED |
| G-10 | Date-query cursoring works (`after:`, `newer_than:`); day-granular; NO historyId mechanism exposed (gws-dwd never calls history.list) | live runs | date-consistent rows both queries | VERIFIED (date-window only) |
| G-11 | List is capped at 50/call, no pagination; resultSizeEstimate is query-insensitive (flat 201) and unusable as a count; list ORDER is as-returned (no sort contract established) — FR-002's 1-day floor + truncation reporting owns the residual | live runs, sampled; round-1 scope note | identical estimate across disjoint queries | PARTIAL — cap + floor owned by FR-002 |
| G-12 | The gws shim execs gws-dwd for gmail BEFORE the --sanitize branch — Model Armor never inspects Gmail payloads; email content reaches downstream LLMs unfiltered | read ~/.local/bin/gws | `:31-33` comment + exec | VERIFIED — hardening rules in FR-005/FR-008 |
| G-13 | `bus comms-filter` is a MUTATING shared first-seen gate: records `<ns>:<id>` in shared `state/comms-event-dedup.json` with ~30-day suppression, consumed by PA's attention lane — a second consumer starves one lane | round-1 probe (both reviewers + main-thread read) | bus.ts comms-filter cmd; event-dedup.ts checkAndRecordSourceEvent | VERIFIED — records lane excluded from it (FR-003) |
| G-14 | Bus task defaults are autonomous (`type: agent`, assignee auto-resolves, immediate notify); `needs_approval` is stored but enforced nowhere; HUMAN-EXEMPTION (`type: human` / `assigned_to: human`) IS enforced at reclaim/list/exec paths | round-1 probe | task.ts:166/:198-206/:257/:351/:560/:651; grep needs_approval = 2 refs | VERIFIED — FR-008 containment uses human-exempt |
| G-15 | Existing History idempotency refuses revisions (any `[source:]` marker returns old page) and renders meeting-shaped lines — email renderer + supersede path are new | round-1 probe | writeback_render.py:83/:133 | VERIFIED — FR-007 bucket B |

## Accepted assumptions (owned)

- Exact 7-day inbox volume is unknowable through this CLI (G-11); the poller's cap-and-
  narrow rule (1-day floor, reported truncation) plus FR-009 reporting owns the residual
  risk. Owner: Josh (accepted by building FR-002 this way).
- The range-with-step cron form stays broken (latent, zero live users); this build's
  `*/10` cron does not use it. The migration defects stay unfixed until the cron
  root-cause lane lands; this build bypasses them via `bus create-cron`. Owner: Josh.
- Gmail list ordering has no established sort contract; on a 50-cap truncation day the
  processed subset is "whatever the list returned", reported. Owner: Josh.

## Roast verdict
Inherited: RESHAPE with accepted amendments, recorded in the brief
(2026-09-14, scores 6/4/3/7/4). This spec IS the reshaped wedge; premise unchanged since.

## Adversarial changelog

**Round 1 — 2026-09-14.** Codex grounding pass (gpt-6-astra, read-only, 3-pass) + Fable
logic pass (independent subagent), merged per adversary-briefs rules; every disputed
factual claim re-probed in the main thread before any fix.
- Findings: 3 CRITICAL, 8 HIGH, 4 MEDIUM, 1 LOW (logic) + 1 wrong ledger row, 11
  unrecorded assumptions, 4 bucket corrections (grounding). Nothing dropped by the
  confidence/failure-scenario filters.
- CRITICAL fixes: outcome-aware skip predicate + manual backfill (C1 → FR-001/003);
  human-exempt email-sourced tasks, `needs_approval` proven decorative (C2 → FR-008,
  G-14); cron-parser claim REVERSED by probe — `*/N` works, migration defects are the
  real killer, install path pinned (C3 → FR-002, G-02 corrected).
- HIGH fixes: comms-filter removed from records lane (H1/G-13); run receipt + single-
  flight lock + named repair (H2/M4 → FR-002); 1-day narrowing floor + reported
  truncation (H3); resolutions list + fan-out vs conflict distinction (H4 → FR-001/003/
  007); inbound-only v1, outbound deferred (H5 → scope + non-goals); SUBSUME gated on
  7-day coverage diff (H6 → FR-006); supersede propagation into facts + open tasks
  specified (H7 → FR-001); two-tier dedup algorithm, deliberate task enumeration,
  no task mutation (H8 → FR-005/008).
- MEDIUM/LOW fixes: invariant baseline + grandfathering (M1/L1 → FR-009); triviality
  gate removed (M2 → FR-005); fact scope pinned to header-derived auto-create only
  (M3 → FR-006); watcher section independence (Codex → FR-009); full-domain-key lookup
  + None/"" guards (Codex → FR-004, G-05 corrected); reuse contracts enumerated
  (Codex → FR-005/007, G-04/G-15); buckets corrected FR-001 B→C, FR-004 A→B, FR-005
  B→C, FR-003/007/008 assigned B.
- FR coverage: FR-001..FR-009 amended; FR-010 untouched. Zero CRITICAL/HIGH left
  unaddressed. Round 2 verifies the fixes.
