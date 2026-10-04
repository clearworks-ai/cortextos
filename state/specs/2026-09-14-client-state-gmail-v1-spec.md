---
title: Client State v1 — Gmail thin slice
slug: client-state-gmail-v1
date: 2026-09-14
mode: standard
status: converged
repo: cortextos
base-branch: main
version: 3
mockup: N/A — backend only
supersedes: state/specs/2026-09-14-client-state-loop-brief.md
owner: Josh
---

# Client State v1 — Gmail thin slice

The wedge from the approved brief, post-roast: ONE source (Gmail), the shared write
discipline, and the detection net — built directly against the existing resolver and CRM
machinery. The spine (observation store as a subsystem, source-slack-window, GitHub
narrative) is deliberately NOT here; it gets extracted when the second source lands.

**Scope: INBOUND mail only.** Josh's sent mail is an explicit v1.1 deferral — the reused
relevance query is an inbound-triage filter with no sent-mail variant, and the demo ("an
email from Marcos comes in") is inbound. See Non-goals.

Mockup gate: **No UI surface; mockup gate N/A** — outputs are CRM rows, markdown History
entries, bus tasks, and Telegram messages, all with existing rendering.

## Requirements

### FR-001 — Observation ledger (one identity scheme)
System MUST record one observation row per handled Gmail message in an append-only JSONL
ledger, keyed by `source_ref = "gmail:<messageId>"` — the SAME scheme add-interaction.py
already dedupes on (G-01), not a second key — carrying `{source_ref, thread_id,
content_digest, observed_at, resolutions: [{slug, kind, method, outcome}], reason?,
extraction?, writes: [paths/task ids]}`. Outcome lives PER RESOLUTION (`filed` /
`escalated` / `ignored`): a multi-party message can be filed for one entity while
another entity's binding is still ambiguous, and the row must represent that.
- WHEN every resolution on a message's latest row is `filed` for the same
  `content_digest` THE SYSTEM SHALL treat the message as terminal and make no writes.
- WHEN a message inside the poll window has any non-`filed` resolution THE SYSTEM SHALL
  re-evaluate resolution on each run (a cheap closed-sets re-check, no LLM call), file
  only the not-yet-filed resolutions, and reuse the row's CACHED `extraction` for any
  later filing — the LLM runs at most once per (source_ref, content_digest,
  bound-entity set): WHEN a late-bound resolution files and the entity set differs from
  the set at extraction time THE SYSTEM SHALL re-run the extraction with the widened
  open-items context (round-3 fix — a cached extraction computed before entity B
  resolved never saw B's open items, silently voiding tier-2 dedup for exactly the
  partial-resolution case), and the refreshed result replaces the cache. Item text is
  quote-gated identically on re-run, so re-extraction cannot mint ungrounded items.
- WHEN a re-check changes nothing THE SYSTEM SHALL write nothing — re-checks are not
  observations; digest counts (the backfill cue) are per DISTINCT source_ref.
- WHEN a sender becomes a known entity after their mail has left the poll window THE
  SYSTEM SHALL support a manual backfill invocation (`--days N` and/or `--query
  "from:<addr>"`) running the same handler over the wider window under the same FR-002
  lock; the digest's ignored-sender counts are the cue. (Automatic on-contact-add
  sweeps are v1.1.)
- WHEN the same `source_ref` arrives with a DIFFERENT digest (edited draft re-sent, rare
  for Gmail) THE SYSTEM SHALL write a superseding History entry marked as a revision and
  append, never rewrite — D-02 semantics. Supersede PROPAGATION (roast amendment): the
  facts half (CRM interaction row) is update-in-place by the existing dedup — intended
  for facts, reported in the digest as a revision; any OPEN bus task derived from the
  superseded digest is flagged in the digest as "evidence superseded — review", never
  auto-closed.

**Depends on claims:** G-01, G-02

**Bucket:** C — the source_ref convention is verified (G-01, G-02) but the ledger is a
new persistent artifact with its own schema, not reuse of an existing store.

### FR-002 — Bounded-window poller, dedup instead of cursor
System MUST poll Gmail on a `*/10 * * * *` pa-codex cron over a FIXED lookback window
(default 3 days), relying on FR-001's ledger for idempotency — no cursor file. This
matches the repo's only existing convention (comms-backfill.py rescans a 7-day window
and dedups by source_ref; G-06 found no cursor pattern anywhere) and makes crash
recovery trivial: re-running is always safe. Listing uses `gws gmail +triage` (G-08),
reads use `+read` (G-09), windowing uses day-granular date operators (G-10).
- The schedule is expressible: the daemon parser supports `*/N`; the only broken form is
  range-with-step, unused here (G-02, corrected round 1). The cron SHALL be installed
  via `bus add-cron`, which writes crons.json directly (crons.ts addCron→writeCrons) —
  NEVER via config.json migration, whose `enabled`-key refusal and once-per-agent guard
  are the defects that silently killed prior crons. Rollout step: grep the live fleet's
  crons.json for range-with-step before install (the regression test pins a 2026-08-11
  snapshot, not today's fleet).
- WHEN the poller runs THE SYSTEM SHALL acquire a single-flight lock via the existing
  claim primitives (bus claim commands: exclusive file creation, configurable dir + TTL
  — verified round 2) with TTL 60 minutes, sized above the worst poller run (50
  messages × bounded extraction), and a locked tick SHALL exit without processing — the
  next tick catches up safely via the ledger. The manual backfill takes the SAME lock
  and, because its runtime is unbounded (a `--days 30` day-sweep), SHALL refresh the
  claim periodically (heartbeat-touch) so stale cleanup never releases a live run —
  without this, a long backfill loses its lock mid-run and the next tick double-files
  (round-3 finding).
- WHEN a run completes successfully THE SYSTEM SHALL write a RUN RECEIPT
  (`{last_success_at, window_days, message_count}`) — the artifact gap detection reads;
  per-message rows alone cannot distinguish a quiet weekend from a dead poller.
- The list call returns AT MOST 50 messages with no pagination (G-11). WHEN a window
  query returns exactly 50 THE SYSTEM SHALL sweep the window as day-granular
  sub-queries covering the FULL window (one query per day — the union must cover every
  day, not merely a narrowed tail), and report in FR-009's digest any single DAY that
  itself returns 50 (day + count), processing that day's 50 in list order — bounded,
  reported loss on a freak day; never an uncovered remainder after an outage.
- WHEN the run receipt's `last_success_at` is older than the lookback window THE SYSTEM
  SHALL say so in FR-009's daily digest AND name the repair (`--days N` backfill sized
  to the gap) — detection plus the named repair, not detection alone.

**Depends on claims:** G-02, G-06, G-08, G-09, G-10, G-11, G-16

**Bucket:** B — window pattern exists in comms-backfill.py and the claim primitives
exist; ledger, receipt, and day-sweep are new.

### FR-003 — Relevance filter: known entities only
System MUST file only INBOUND messages that resolve to a known entity; the rest are
ignored observations, not escalations.
- WHEN a message's sender matches a CRM contact email or a page-declared domain THE SYSTEM SHALL proceed; otherwise THE SYSTEM SHALL record outcome `ignored`
  with reason `no-known-entity` and write nothing. Ignored rows re-evaluate per FR-001
  while in window; the digest carries ignored-sender counts as the backfill cue.
- WHEN a single counterparty resolves AMBIGUOUSLY (contact maps to one page, domain to
  another) THE SYSTEM SHALL escalate by Telegram EXACTLY ONCE per (source_ref,
  content_digest) — send-side dedup under the `clientstate:` namespace is MANDATORY,
  and re-evaluations stay silent unless the resolution outcome changes. Without this,
  the 10-minute re-evaluation loop would re-page the same ambiguity ~432 times per
  3-day window (round-2 finding). Routing, not approval.
- A message whose known counterparties each resolve CLEANLY to different entities is
  NOT a conflict — it fans out (FR-007 writes each bound page; FR-001 records each
  resolution with its own outcome). Multi-party mail is a normal event.
- The automated-sender exclusion SHALL reuse the EXISTING comms-check Gmail QUERY STRING
  VERBATIM (comms-check-worker/SKILL.md step 2: -category:promotions -category:social,
  every no-reply/donotreply/mailer-daemon variant, notify.railway.app,
  notifications@github.com, Accepted:/Declined:/Tentative:/out-of-office/auto-reply
  subjects) — the "real people only" filter Josh already trusts, not a re-implementation.
  The records lane SHALL NOT invoke `bus comms-filter`: that command is a MUTATING
  shared first-seen gate (G-13 — 30-day suppression in the shared comms-event-dedup
  ledger, keys `gmail:<id>`) already consumed by PA's attention lane; piping the records
  lane through it would starve whichever lane runs second. FR-001's ledger is this
  lane's ONLY idempotency layer; the attention lane's gate is untouched.
- Unknown-but-real humans are NOT this system's job: PA's comms-check lane already
  surfaces actionable mail from unknown real senders to Josh as [HUMAN] tasks (the
  ATTENTION lane); client-state is the RECORDS lane. Complementary, not overlapping —
  and with comms-filter out of this lane, they share no mutable state.
- D-11 CONFIRMED (Josh, 2026-09-14: "the whole email filter we built for what matters.
  real people only. could be worth it." + "ok"): known entities only for STATE writes;
  the comms-check query is the machine filter; unknown humans stay covered by the
  attention lane.

**Depends on claims:** G-13

**Bucket:** B — query string reused verbatim; the filter harness and escalation dedup
are new.

### FR-004 — Entity resolution via the existing machinery
System MUST resolve the entity using the resolver's source-agnostic PIECES (page-domain
maps, declared `- CRM org name:` lines, contact-email lookup — G-03, G-05) — no meeting
envelope. The pieces exist but are NESTED inside meeting-shaped `resolve()`
(`_match_contact`, `_resolve_company_slug` are inner functions): extracting the
standalone email→entity seam is implementation work, not a bare import.
- WHEN looking up a sender domain THE SYSTEM SHALL use the FULL-domain key
  (`closed["domain_to_slug"].get(<domain>)`), never the bare registrable-label key:
  labels collide across TLDs (`example.com`/`example.org` both label to `example`,
  last-writer-wins — G-05 corrected). Full-domain keys still overwrite silently when
  the SAME domain is declared on two pages — FR-009's invariant check covers that
  (each domain declared on ≤1 page), mirroring the org-name invariant.
- WHEN a matched contact has an empty/missing company, or a name key is empty or
  duplicate-suppressed in the closed sets, THE SYSTEM SHALL treat it as NO match
  (→ ignored or escalated per FR-003) — never pass None/"" into `_norm_title` or bind
  to a "" key (probed: `_norm_title(None)` raises; duplicate CRM names produce "" keys).

**Depends on claims:** G-03, G-05

**Bucket:** B — maps and lookups verified (G-05), but the standalone resolution seam
with the guards above must be built (round-1 correction from A).

### FR-005 — Bounded extraction (email-shaped, quote-grounded)
System MUST derive `{summary, commitments[], decisions[], open_questions[]}` from the
message via ONE bounded LLM call whose itemized outputs are quote-grounded against the
message body, reusing the meeting pipeline's validation pieces with an email-specific
prompt — a sibling `extract_email.py`, not a fork of the meeting prompt. The result is
CACHED in the FR-001 ledger row: at most one LLM call per (source_ref, content_digest,
bound-entity set) — a late-bound entity widens the context and re-runs (FR-001).
- The reuse contract names ALL the pieces (G-04, expanded round 1): `quote_gate` for
  item grounding, PLUS `validate_extraction`'s single-line/control-character checks,
  PLUS schema validation of the model output. Known gate behaviors carried knowingly:
  `summary` is NOT quote-grounded (it renders as derived text in FR-007 and appears in
  the digest, where a wrong summary is visible within a day); grounded availability
  pleasantries are dropped by design.
- WHEN a message is filed THE SYSTEM SHALL run extraction — no triviality gate (round-1
  removal: "scheduling chatter" is not deterministically decidable, and a one-line
  "yes, we'll sign Friday" is exactly the decision+commitment short mail exists to
  capture; volume is already bounded by FR-003's two filters).
- Cross-source commitment context: the call SHALL receive the UNION of ALL bound
  entities' Open Items (reader exists: brain_rollup's section parser, status=open —
  verified round 2) plus open email-sourced task titles, enumerated with
  INVOCATION-LOCAL ids (1..N; no stable open-item id exists — round-2 finding), and
  return per commitment an optional `matches_open_item` index. That field is EXEMPT
  from the quote gate (it references supplied context, not derived text — gating it
  would kill tier-2 dedup silently) and is instead validated against the id range.
- INJECTION SURFACE (G-12): the gws shim routes Gmail straight to gws-dwd, BYPASSING
  Model Armor sanitization by design — email bodies reach the extraction LLM unfiltered,
  and the quote gate does not help against attacker-authored text (a hostile body's own
  words are, by definition, grounded quotes). Bounds and rules: only FR-003-known
  entities ever reach extraction; WHEN extraction runs THE SYSTEM SHALL invoke it with
  no tool access and a schema-constrained output; commitments extracted from email
  SHALL only ever become human-routed bus tasks and digest lines (FR-008) — never an
  autonomous action; and every email-sourced task appears in FR-009's daily digest so
  an implausible commitment is seen within a day.

**Depends on claims:** G-04, G-12, G-17

**Bucket:** C — quote_gate imports unmodified (it reads only text_units), but the
sibling schema, prompt, context assembly, and validation harness are a new artifact
(round-1 correction from B).

### FR-006 — CRM write (facts half, D-01/D-03)
System MUST append one interaction row per known contact on the message via
`add-interaction.py --type email --source-ref gmail:<messageId>` (existing dedup:
source_ref + contact_id, update-in-place — G-01).
- FACT SCOPE (round-1 pin — the fill-blanks clause needs a named source): v1 writes NO
  contact facts from message content. The ONLY fact write is minimal contact
  auto-creation when a domain-matched sender has no contact row yet: `{name}` from the
  From display name, `{email}` from the address — headers, never body parsing, never
  signature scraping. Fill-blanks-only governs exactly that row; nothing else fills
  anything.
- WHEN the existing Gmail ingest (comms-backfill, G-02) has already written a row for the same source_ref+contact THE SYSTEM SHALL not duplicate it
  (same dedup key — the D-08 dedup gate made mechanical).
- SUBSUME chosen (Josh "ok" 2026-09-14): this handler becomes the one Gmail reader and
  the heartbeat piggyback line is removed from crm-codex's cron prompt — but removal is
  GATED on a coverage diff, not just the dedup key (round-1 addition): run both writers
  in parallel for 7 days, enumerate every interaction row the old path wrote that the
  new path did not (the new filter is strictly narrower — comms-check exclusions +
  known-entity gate), and rule on each excluded class before the piggyback line is
  deleted. Dedup prevents doubles; the diff catches silent coverage loss.

**Depends on claims:** G-01, G-02

**Bucket:** A — the interaction write is verified feasible as written (G-01); the
rollout diff is a build step, not new machinery.

### FR-007 — Client page write (narrative half, D-01/D-03)
System MUST append one dated History entry to EACH bound page (fan-out per FR-003):
`- YYYY-MM-DD — <subject> (email) [source: gmail:<messageId>]` with the extraction's
summary/decisions/open-questions as sub-bullets — append-only; supersedes are marked
replacement entries (roast amendment), never silent rewrites.
- WHEN a revision (new digest, same source_ref) files THE SYSTEM SHALL append a marked
  replacement entry rather than returning the old page: this is a NEW renderer, not a
  reuse (G-15) — the existing writeback_render is meeting-shaped (renders
  `(meeting: <path>)` lines) and its idempotency REFUSES any entry whose `[source:]`
  marker already exists on the page (writeback_render.py:136-137), which is exactly
  wrong for D-02. The email renderer takes `(source_ref, digest)` and appends a marked
  revision entry when the digest is new.

**Depends on claims:** G-15

**Bucket:** B — page format and append conventions exist; renderer + supersede path new.

### FR-008 — Commitments → tasks with cross-source dedup (D-05)
System MUST create one bus task per extracted OURS commitment UNLESS a matching open
commitment already exists — one commitment, many evidences; the meeting that promised it
and the email that confirms it yield ONE task.
- CONTAINMENT (rebuilt round 2 — the round-1 version claimed machinery that does not
  exist): email-sourced tasks SHALL be created with `--assignee human` (exists today;
  keeps them out of agent-facing list/reclaim/health paths and multica maps them to
  Josh — G-14). But exemption is NOT yet an execution barrier: `create-task` cannot set
  `type: human` (createTask hardcodes `type: 'agent'`, task.ts:786) and `claim-task`
  never checks exemption (claimTask checks pending status only, task.ts:1163-1192), so
  an agent told to claim by id would take the task. THIS BUILD THEREFORE INCLUDES the
  two missing guards, with tests: a `--type human` creation flag, and a human-exempt
  refusal in claimTask (override flag for deliberate promotion). FR-010's
  untouched-files rule names src/bus/task.ts and src/cli/bus.ts as permitted here.
- DEDUP ALGORITHM (round-1 pin — "near-identical" was untestable): two tiers, either
  suppresses. Tier 1, deterministic: normalized owner match (casefold,
  alias-normalized) AND `difflib.SequenceMatcher` ratio STRICTLY > 0.75 on normalized
  text. The threshold is borrowed from dedupe_history.py's title dedup on this corpus —
  NOT validated for cross-source commitment text (round-2 caveat, owned below); every
  suppression appears in the digest, so miscalibration is visible within a day. Tier 2,
  semantic: the extraction call's `matches_open_item` index (FR-005) — this is what
  catches "Send Alloi the tacticals doc" vs "share the tactical plan with Marcos",
  which no string ratio will.
- WHEN checking for duplicates THE SYSTEM SHALL enumerate deliberately: `list-tasks`
  defaults to the build class and 50 rows, so the check queries the relevant classes
  explicitly with explicit limits, plus every bound entity's page Open Items.
- WHEN a duplicate is suppressed THE SYSTEM SHALL record the new source_ref as evidence
  in the FR-001 ledger row and note it in the daily digest. v1 does NOT mutate the
  existing task (no structured evidence-append operation exists on bus tasks — probed;
  inventing one is not this wedge).
- Cross-source identity is NEW machinery (round-1 pin): existing commitment ids hash
  source kind+id+text+ordinal (adapt_meeting.py:60) — by construction never equal
  across sources. The dedup above IS the cross-source join; no shared id is pretended.

**Depends on claims:** G-14

**Bucket:** B — creation flag + claim guard are small in-scope bus changes with tests;
dedup logic is new but composed from verified readers.

### FR-009 — Detection, not approval (roast amendment to D-03)
System MUST send Josh one daily Telegram digest listing every state change made by
automated writers in the last day (page + one line + source ref), and MUST run a daily
invariant check whose NEW violations appear in the same digest. Invariants: every CRM
org name declared on ≤1 page; every DOMAIN declared on ≤1 page (guards FR-004's
full-domain key against silent overwrite); every post-epoch `gmail:` History source ref
present in the observation ledger — SCOPED to `gmail:` refs (round-2 fix: the ledger
records Gmail only, and the live meeting pipeline appends `fireflies:` refs daily;
an all-source invariant would violate on every meeting forever and train Josh to skim
past the one channel D-03 depends on).
- WHEN there are no changes and no violations THE SYSTEM SHALL send the one-line OK (a
  silent watcher is indistinguishable from a dead one).
- BASELINE (round-1 pin — first-run flood kills the channel): the invariant check runs
  against a one-time committed baseline snapshot; pre-existing violations and
  pre-epoch refs are grandfathered — only NEW violations reach the digest.
- INDEPENDENCE (round-1 pin): WHEN the Fireflies section fails THE SYSTEM SHALL still
  run and send the Gmail digest section — meeting_loop_watch.py currently returns
  before ANY notification on a missing FIREFLIES_API_KEY (G-07, :111-115); the
  extension restructures main() into independently-failing sections, each reporting
  its own error line rather than aborting the message.
- DELIVERY (round-1 pin): digest and escalation sends SHALL NOT reuse `gmail:<id>` keys
  in any shared dedup namespace (the attention lane owns those — G-13; a consumed key
  silently suppresses the escalation) — send-side dedup uses the `clientstate:` prefix
  (mandatory for escalations per FR-003). Long digests split at Telegram's 4096-char
  bound (existing api.ts behavior, acceptable).
- Poller-gap and cap-truncation lines from FR-002 land in this digest.

**Depends on claims:** G-07, G-13

**Bucket:** B — extend meeting_loop_watch.py main() directly; no plugin seam exists
(G-07); baseline artifact and section restructure are new.

### FR-010 — Meeting pipeline untouched
The meeting pipeline's behavior MUST be unchanged: its suite stays green, and any shared
function used is used read-only. Files this spec explicitly permits modifying:
meeting_loop_watch.py (FR-009's section restructure), src/bus/task.ts + src/cli/bus.ts
(FR-008's two guards), crm-codex's cron prompt (FR-006's gated piggyback removal). No
other shared file changes.
- WHEN the brain test suite runs after this build THE SYSTEM SHALL pass with the same
  count delta accounting used by G1 (every new test attributed).

**Bucket:** A — a constraint on the build, not new machinery.

## Decisions (CONTEXT)

Inherited from the brief: D-01..D-10 as amended by the roast verdict recorded there.

| ID | Area | Decision | Provenance | Settled by | Evidence | Locked by | Date |
|----|------|----------|------------|------------|----------|-----------|------|
| D-11 | Relevance filter | Known entities only for state writes; the comms-check QUERY (verbatim) is the machine filter; unknown real humans stay covered by PA's attention lane | settled | grill | Josh 2026-09-14: "the whole email filter we built for what matters. real people only. could be worth it." + "ok" | Josh | 2026-09-14 |

Round-1 scope call, flagged for Josh (inferred, owned — not a locked decision):
**inbound-only v1**, from "simplest possible solution" + the inbound-shaped reused
filter; say the word and outbound gets specced as a v1.1 delta.

## Non-goals (v1)
- Josh's SENT mail (outbound counterparty filing) — v1.1; the reused triage query has no
  sent variant and the demo is inbound.
- Automatic backfill sweep on contact-add — v1.1; manual `--days/--query` backfill +
  digest cue covers it.
- Structured evidence-append on bus tasks — ledger + digest carry the evidence.
- Everything the brief already excludes (proposal service, spine extraction, other
  sources).

## Grounding Ledger

Probes run 2026-09-14 by two read-only subagents (code claims; live gws capability);
corrected and extended by adversarial rounds 1–2 (Codex grounding passes + logic passes
+ main-thread verification probes). Full evidence excerpts in the probe returns.

| ID | Claim (settled fact) | Probe | Evidence | Verdict |
|----|----------------------|-------|----------|---------|
| G-01 | `add-interaction.py --type` accepts exactly {email, meeting, call, message, social, manual, task}; dedup = source_ref+contact_id, update-in-place | read add-interaction.py | `:52` argparse choices; `:86` dedup match | VERIFIED |
| G-02 | The only live Gmail→CRM writer is comms-backfill.py on crm-codex's 4h heartbeat. Corrected rounds 1–2: the daemon cron parser SUPPORTS `*/N`; only range-with-step silently mis-parses, and the 2026-08-11 fleet snapshot used none (re-grep live crons at build time). The real cron killers are the two migration defects (enabled-key refusal; once-per-agent guard); `bus add-cron` (NOT "create-cron") writes crons.json directly, bypassing both | read comms-backfill.py + crons.json; rounds 1–2 re-probes | cron-scheduler.ts expandField; cron-parser-live-fleet.test.ts:13-35; bus.ts:3911; crons.ts:217/:232; cron-migration.ts:397/:457 | VERIFIED |
| G-03 | contacts.json is `{contacts:[{id,name,emails:[...]}]}`; email→contact lookup exists but is NESTED inside meeting-shaped resolve() — a standalone seam must be extracted (FR-004) | read both; round-1 correction | resolve_meeting.py:54/:845-846; `_match_contact`/`_resolve_company_slug` nested | VERIFIED |
| G-04 | quote_gate (resolve_meeting.py:402) is source-shape-generic (needs only extraction + text_units) and imports unmodified; it does NOT ground `summary` and drops availability pleasantries; single-line/control-char checks live separately in validate_extraction; extract_meeting's PROMPT and schema are meeting-coupled — extract_email needs a sibling schema | read extract_meeting.py + schema + gate; round-1 additions | `:402`; extract_meeting.py:101/:178/:358 | PARTIAL |
| G-05 | load_closed_sets(vault) builds domain_to_slug + org_name_to_slug from pages alone. Corrected round 1: the map carries BOTH full-domain and bare-label keys; label keys collide across TLDs (last-writer-wins), duplicate CRM names produce "" keys, and the SAME domain declared twice still overwrites silently (FR-009 invariant covers it) — FR-004 uses full-domain keys only, ""/None as no-match | read resolve_meeting.py:295-352; rounds 1–2 re-probes :207/:311-315 | registrable_label + both-key insert confirmed | VERIFIED |
| G-06 | No incremental cursor convention exists; nearest patterns are fireflies-ingest's seen-ledger and comms-backfill's fixed-window + source_ref dedup | grepped crm/ + scripts/brain | comms-backfill docstring: 7-day window, no cursor | PARTIAL |
| G-07 | meeting_loop_watch.py is one linear main() with no source-plugin seam; it RETURNS before any notification when FIREFLIES_API_KEY is missing — sections must fail independently (FR-009) | read meeting_loop_watch.py:105-158; round-1 addition | `:111-115` early return rc=2 | PARTIAL |
| G-08 | `gws gmail +triage --query --max` lists messages with stable id/threadId | live run, 5 rows | ids + threadIds returned | VERIFIED |
| G-09 | `gws gmail +read --id` returns headers-only or headers+body | live run both modes | full mode keys include body (len 793) | VERIFIED |
| G-10 | Date-query windowing works (`after:`, `newer_than:`), day-granular; NO historyId mechanism exposed (gws-dwd never calls history.list) | live runs | date-consistent rows both queries | VERIFIED |
| G-11 | List is capped at 50/call, no pagination; resultSizeEstimate is query-insensitive (flat 201) and unusable as a count; list ORDER has no established sort contract — FR-002's day-sweep + truncation reporting owns the residual | live runs, sampled; round-2 scope note | identical estimate across disjoint queries | PARTIAL |
| G-12 | The gws shim execs gws-dwd for gmail BEFORE the --sanitize branch — Model Armor never inspects Gmail payloads; email content reaches downstream LLMs unfiltered; hardening rules live in FR-005/FR-008 | read ~/.local/bin/gws | `:31-33` comment + exec | VERIFIED |
| G-13 | `bus comms-filter` is a MUTATING shared first-seen gate: records `<ns>:<id>` (default ns `gmail`) in shared `state/comms-event-dedup.json`, 30-day suppression, consumed by PA's attention lane — a second consumer starves one lane; records lane excluded (FR-003) | rounds 1–2 probes (both reviewers + main thread) | bus.ts:4208; event-dedup.ts:18/:104 | VERIFIED |
| G-14 | Bus task defaults are autonomous (`type: agent` HARDCODED in createTask; assignee auto-resolves; immediate notify); `needs_approval` is stored but enforced nowhere; human-exemption (assigned_to human / type human) is enforced on LIST/RECLAIM/HEALTH paths but NOT on claim — claimTask checks pending status only. Creation cannot set type:human today. FR-008 builds the two missing guards | rounds 1–2 probes | task.ts:166/:198-206/:786/:1163-1192; bus.ts:514/:668; enforcement sites :257/:351/:560/:651 | VERIFIED |
| G-15 | Existing History idempotency refuses same-source revisions (any entry whose `[source:]` marker already exists returns the old page — :136-137) and renders meeting-shaped lines — email renderer + supersede path are new (FR-007) | rounds 1–2 probes | writeback_render.py:133/:136-137 | VERIFIED |
| G-16 | Reusable single-flight claim primitives exist (bus claim commands: exclusive file creation, configurable claims dir + TTL, stale cleanup) — FR-002's lock reuses them | round-2 probe (Codex) | bus.ts:2541; meeting-brief.ts:368 | VERIFIED |
| G-17 | A Python Open Items reader exists (brain_rollup section parser, rows carry item/owner/deadline/source/status, filtered to status=open) but rows have NO stable id — FR-005 uses invocation-local indices | round-2 probe (Codex) | brain_rollup.py:184/:205/:244 | VERIFIED |

## Accepted assumptions (owned)

- Exact 7-day inbox volume is unknowable through this CLI (G-11); the day-sweep rule
  (full-window coverage, reported per-day truncation) plus FR-009 reporting owns the
  residual risk. Owner: Josh (accepted by building FR-002 this way).
- The range-with-step cron form stays broken (latent; zero users in the 2026-08-11
  snapshot, re-checked against the live fleet at build time). The migration defects
  stay unfixed until the cron root-cause lane lands; this build bypasses them via
  `bus add-cron`. Owner: Josh.
- Gmail list ordering has no sort contract; on a 50-cap single-day truncation the
  processed subset is "whatever the list returned", reported. Owner: Josh.
- FR-008's tier-1 threshold (>0.75) transfers from title dedup, unvalidated for
  cross-source commitment text; digest-reported suppressions are the calibration
  channel. Owner: Josh.

## Roast verdict
Inherited: RESHAPE with accepted amendments, recorded in the brief
(2026-09-14, scores 6/4/3/7/4). This spec IS the reshaped wedge; premise unchanged
since. Cheapest 48-hour test (probe, from the brief): replay digest-supersede against
the 292-meeting corpus counting duplicate History entries (MSIA = dirty control), plus
the 5-thread Gmail gap-check — both folded into this spec's ledger claims and FR-006's
coverage-diff gate.

## Adversarial changelog

**Round 1 — 2026-09-14.** Codex grounding pass (gpt-6-astra, read-only, 3-pass) + Fable
logic pass (independent subagent), merged per adversary-briefs rules; every disputed
factual claim re-probed in the main thread before any fix. Findings: 3 CRITICAL, 8
HIGH, 4 MEDIUM, 1 LOW (logic) + 1 wrong ledger row, 11 unrecorded assumptions, 4 bucket
corrections (grounding). Nothing dropped by the confidence/failure-scenario filters.
Headline fixes: outcome-aware skip predicate (C1); human-exempt tasks (C2 — later
rebuilt in round 2); cron-parser claim REVERSED by probe (C3 — G-02 corrected);
comms-filter removed from records lane (H1/G-13); run receipt + lock (H2/M4); narrowing
floor (H3 — later replaced by day-sweep); resolutions list + fan-out (H4); inbound-only
scope (H5); SUBSUME coverage-diff gate (H6); supersede propagation (H7); two-tier dedup
(H8); invariant baseline (M1/L1); triviality gate removed (M2); fact scope pinned (M3);
buckets corrected.

**Round 2 — 2026-09-14.** Verification round, both reviewers. All 16 round-1 closures
verified CLOSED against their original failure scenarios. New findings: grounding — the
round-1 C2 containment claimed machinery that does not exist (`create-task` hardcodes
type:agent, claimTask never checks exemption → FR-008 rebuilt to include the two
guards; G-14 rewritten), `bus create-cron` → `add-cron`, tier-1 threshold transfer
unproven (owned), same-domain double-declaration silent overwrite (FR-009 invariant
added), open items have no stable ids (FR-005 invocation-local indices), G-15 line cite
corrected, cron test pins a snapshot (build-time re-grep added). Logic — 3 HIGH
composition defects in round-1's new machinery, all fixed: escalation re-fire under
re-evaluation (FR-003 escalate-once mandate), Gmail-only ledger × all-source invariant
= permanent digest noise (FR-009 scoped to gmail: refs), cap-narrowing left the window
remainder uncovered after an outage (FR-002 day-sweep with full coverage); plus 4
MEDIUM/LOW: per-resolution outcomes + cached extraction (FR-001), tier-2 context union
+ quote-gate exemption (FR-005), lock TTL sized to worst run + backfill takes the lock
(FR-002), no-change re-checks write nothing (FR-001).

**Round 3 — 2026-09-14.** All round-2 findings applied; structural conformance to the
validator (frontmatter, single-line EARS per FR, bucket lines, verdict tokens,
G-16/G-17 added). Final logic verification: 7/8 round-2 closures CLOSED; 1 GAP
(backfill runtime vs fixed lock TTL → claim heartbeat-touch, FR-002) and 1 NEW HIGH
(cached extraction froze tier-2 context before late-binding entities resolved →
extraction identity widened to (source_ref, content_digest, bound-entity set),
FR-001/FR-005) — both fixed inline exactly as the reviewer prescribed; no new
machinery. **CONVERGED 2026-09-14: zero CRITICAL/HIGH findings open after 3 rounds** (2 full
two-reviewer rounds + 1 scoped verification round, cap reached with all findings
closed). Validator exit 0.
