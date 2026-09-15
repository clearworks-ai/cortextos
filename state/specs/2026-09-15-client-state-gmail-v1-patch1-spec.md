---
title: Client State v1 — Gmail thin slice — patch 1 (event trigger + real-person relevance)
slug: client-state-gmail-v1-patch1
date: 2026-09-15
mode: patch
status: converged
repo: cortextos
base-branch: main
version: 3
mockup: N/A — backend only
supersedes: 2026-09-14-client-state-gmail-v1-spec.md
owner: Josh
---

# Client State v1 — Gmail thin slice — patch 1

Delta on the locked base spec (v3, converged 2026-09-14). Premise unchanged. Two owner
directives (Josh, 2026-09-15: "we had already agreed that it should be a webhook not a
10 minute poll, and that it is based on an existing email real person filter not on
known people") replace the base's **FR-002 trigger** and **FR-003 relevance gate**,
correct **D-11**, and — because unknown senders now reach extraction and the digest must
see the trigger — amend **FR-005** (two sentences superseded), **FR-006** (free-mail contact
creation, inside FR-003), **FR-009** (trigger health), **FR-001** (created effect), and
**FR-010** (allowlist). Every other base FR
and every base ledger row G-01..G-17 stand. The code already built on
`feat/client-state-gmail-v1-build` (ledger, resolver pieces, extraction, writers,
digest, bus guards) stays valid; this patch adds to it.

Mockup gate: **No UI surface; mockup gate N/A** (unchanged).

## Requirements (delta)

### FR-002 — Event-driven trigger (replaces "Bounded-window poller")
System MUST run the records lane per Gmail change event, not on a 10-minute sweep. The
trigger is tiered; every tier hands ids to ONE deterministic entry
(`client_state_gmail.py`, no model in the control path — phase G shape, G-26) through a
durable queue, never by blocking the producer.
- WHEN the pa Gmail listener (`orgs/clearworksai/agents/pa/scripts/gmail_push_listener.py`
  — a 60 s `history.list` delta poll with a 120 s debounce, G-20, G-37) observes new
  INBOX message ids THE SYSTEM SHALL append `{ids, history_id, observed_at}` to the
  durable queue `<state-dir>/inbox-queue.jsonl` (atomic append) and start a DETACHED
  drain (`subprocess.Popen`, never waited on) of `client_state_gmail.py --drain-queue
  --repo-root <shared> --vault <vault> --crm-dir <crm> --state-dir <state>`; the
  listener's own loop — prefilter decisions, `pending_since` transitions, attention
  spawn argv and spawn timing — is unchanged, pinned by a fake-clock regression test
  that compares those observables before and after the hook (P1-26). Tier A; the v1
  trigger. Latency bound ≤ 120 s from arrival to drain start. The listener is loaded
  under launchd as part of activation (not loaded today, G-21).
- WHEN `--drain-queue` runs THE SYSTEM SHALL take the single-flight lock (base FR-002:
  held ⇒ exit 2, the queue persists, the next drain or sweep continues), read the queue,
  dedupe ids against the ledger's terminal rows, read each remaining id via `gws gmail
  +read` (G-09) retaining `labelIds`, apply the FR-003 predicate locally, process the
  admitted ids exactly as a sweep run does (FR-001 identity, extraction cache, writes),
  and remove an entry from the queue only after its ids are terminal or recorded on a
  ledger row. `--message-ids <id,…>` is the manual form of the same path.
- WHEN a Gmail Pub/Sub push arrives at the bridge Gmail lane (`POST
  /relay/gmail-pubsub`, Google OIDC Bearer, `{emailAddress, historyId}` in
  `message.data` — G-18) AND the lane is `active` AND FR-011 is complete THE SYSTEM
  SHALL enqueue `{history_id}` durably BEFORE acknowledging (today the handler advances
  its cursor and returns 200 even when nothing spawns — G-34; FR-011 item 3 changes
  that) and start a detached drain. Tier B. Until FR-011 lands the lane stays `shadow`.
- WHEN the drain sees a queued `history_id` THE SYSTEM SHALL list history from the
  per-mailbox `last_processed_history_id` (persisted in the state dir), following
  `nextPageToken` to the end (default page 100 records, max 500 — G-38), enqueueing the
  `INBOX` `messagesAdded` ids of EACH page as its own queue entry BEFORE fetching the
  next page (page-level checkpoint: a crash loses at most the in-flight page), dedupe,
  and advance `last_processed_history_id` to the queued watermark ONLY after every
  collected id is terminal or on a ledger row (P1-10, P1-11). The event receipt records
  `history_pages`, `history_records`, `unique_ids`, and `remaining` (queue entries not
  yet terminal). The INITIAL cursor is the `historyId` returned by `users.watch`,
  persisted by FR-011 item 4 BEFORE push delivery is enabled; it is NEVER initialised
  from a post-notification `users.getProfile` (that cursor is already at or past the
  watermark and would drop the first event — P2-3). WHEN a push arrives and no prior
  cursor exists THE SYSTEM SHALL treat the event as a sweep trigger (full-window sweep,
  cursor set from the push watermark afterwards) rather than a history list. A stale start
  id (HTTP 404 — Gmail keeps history "typically at least a week, sometimes only hours",
  G-22) SHALL enqueue a gap-covering sweep — total span = the days elapsed since the persisted
  `last_processed_at` timestamp (stored beside the cursor), minimum the default window,
  UNCAPPED, executed as chained 7-day `--days`/`--query` windows (day-granular
  `after:`/`before:` clauses, G-10) so no single run is unbounded — set the cursor from
  the push watermark only after the last chunk completes, and never drop the event
  (P1-5). Zero ids ⇒ advance the cursor and record `event: empty`.
  Reads use the listener's DWD client (G-31), imported read-only by path.
- The fixed-window sweep (`--days N`, default 3; `--query` composes with the exclusion
  clause; every sweep query carries `in:inbox` — FR-003) REMAINS ONLY as retry/backfill:
  a pa-codex cron every 2 hours (`bus add-cron`, base G-02 rules). It is NOT the trigger.
- RECEIPTS (P1-13): `last_success_at` / `window_days` / `message_count` are written ONLY
  by a completed full-window sweep — they are the FR-009 coverage proof. Event runs
  write a separate `last_event_run_at`, `event_ids_requested`, `event_ids_processed`,
  `queue_depth`, `last_processed_history_id`, and `last_event_error`; they never touch
  `last_success_at`.
- The single-flight lock (60-minute TTL, heartbeat) is shared by all entry forms; a
  stale lock is cleared and NOT re-acquired in-band (meeting-brief semantics) — the next
  drain or sweep wins.

**Depends on claims:** G-18, G-20, G-21, G-22, G-25, G-26, G-27, G-31, G-34, G-37, G-38, base G-09, G-10, G-16

**Bucket:** B — the listener, its Gmail client, the bridge lane, and the spawn IPC all
exist and are verified; the work is the queue + detached drain hook in the listener,
the `--drain-queue` / `--message-ids` entry and history-cursor reader (absent today —
G-25), the local predicate, the receipt split, and loading the listener in launchd.
Tier B's infrastructure and bridge changes are FR-011 (D).

### FR-003 — Relevance: the existing real-person filter (replaces "known entities only")
System MUST record every INBOUND message that passes the real-person filter — the
comms-check exclusion clause reused VERBATIM as the sweep query (base G-13 rules on
`comms-filter` unchanged) — on the observation ledger regardless of whether the sender
is a known entity, and MUST file it to a home (existing or created) for every
relationship EXCEPT `personal`, which is recorded with outcome `ignored` and gets no
page or CRM write (A-08). "File" below means page + CRM effects; "record" means the
ledger row.
- ONE shared predicate for every entry form (P1-16): a message is admitted iff it
  carries the `INBOX` label AND none of the exclusion clause's terms match, where
  `-from:` tokens are case-insensitive substrings of the From address, `-subject:`
  tokens are case-insensitive substrings of the Subject, and `-category:promotions` /
  `-category:social` are the label ids `CATEGORY_PROMOTIONS` / `CATEGORY_SOCIAL`. The
  sweep query is the clause plus `in:inbox`; `Message` retains `label_ids`, raw From,
  raw Subject. A parity fixture records, for a corpus, the query-selected oracle set and
  the local result; the two SHALL agree, and at runtime any id the sweep query admitted that the
  local predicate rejects is treated as EXCLUDED (fail-closed) and counted in the digest
  as `predicate divergence`; the reverse case (local-admitted, query-rejected) is only
  observable offline and is covered by the fixture, not a runtime check (P1-17). The listener's own
  spawn-avoidance list is NOT this predicate (G-20).
- WHEN an admitted sender resolves cleanly to a known entity (base FR-004) THE SYSTEM
  SHALL proceed as the base spec describes.
- WHEN an admitted sender resolves to NO entity THE SYSTEM SHALL run the two-stage
  path (P1-19): stage 1 = a classification call under the EMPTY binding (identity
  `(source_ref, content_digest, "classify")`, cached on the row) returning
  `{org_name, domain, relationship, confidence, evidence}` with the meeting enum
  client|prospect|vendor|partner|colleague|personal|internal (G-24), whose `evidence`
  is quote-gated by an EMAIL-LOCAL gate (`normalize_quote`/`quote_grounded` imported
  read-only from `resolve_meeting.py`, applied to the body + From/Subject headers —
  P1-27); an ungrounded or invalid classification ⇒ `escalated` (never a created page).
  Stage 2 = deterministic bind/create (below) then the ordinary extraction under the
  final bound-slug context (identity `(source_ref, content_digest, slugs)`), both calls
  budgeted under `--max-usd`. If stage 2's own classification disagrees with stage 1,
  stage 1's binding stands and a `classification drift` digest line is emitted.
- BIND/CREATE rules: `internal`/`colleague` are VALID ONLY for a sender whose domain is
  in `OURS_DOMAINS` (P1-23) and bind to `orgs/clearworks-internal.md`; an external
  domain classified internal is invalid ⇒ `escalated`. `personal` ⇒ observation with
  outcome `ignored`, reason `personal`, no page, no CRM write (A-08). `client`/`prospect`
  ⇒ `clients/<slug>.md`; `vendor`/`partner` ⇒ `orgs/<slug>.md`, created by an
  EMAIL-SPECIFIC planner in `writeback_email.create_page(kind, slug, org_name,
  domains, contacts)` that seeds the existing client template (`clients/_template.md`:
  Contacts / Current state / What we're delivering / Financials / History / Open Items)
  and writes the `domains:` line and `- CRM org name:` line explicitly — NOT
  `writeback_render.planned_files`, which is meeting-shaped and also mints a meeting
  note (P1-20, G-23). Slug = `registrable_label(domain)` or a normalised org name;
  BEFORE creating, check `clients/<slug>.md`, `orgs/<slug>.md`, and the closed-set
  org-name/domain maps: reuse an existing page ONLY on an identity match (same declared
  domain or same normalised CRM org name), otherwise allocate `<slug>-<label>` and
  never append into the colliding page (P1-22). FREE-MAIL senders (`FREE_MAIL` in
  `resolve_meeting.py:18-31` — G-36) NEVER declare their domain on any page (declaring
  `gmail.com` would bind every Gmail sender to that page — P1-15): they bind through the
  CRM contact instead: base FR-006 is AMENDED so that contact auto-create is ALSO
  permitted for an admitted free-mail sender whose stage-1 classification passed the
  evidence gate, with `--company <org_name>` from the classification (idempotent on the
  exact address as in the base; recorded as a `contact:<id>` effect on the row; no
  rollback path is needed because the row is the audit and a repeated message is a
  no-op by identity), and the page declares that org name, so the next message resolves
  via `contact.company → org_name_to_slug` (base G-05) (P2-2).
- Every created page is recorded on the ledger row as a `created:<vault-relative
  path>` effect (FR-001 delta) and rendered in the FR-009 digest as `created` (P1-21).
- WHEN an admitted sender resolves AMBIGUOUSLY THE SYSTEM SHALL escalate exactly once
  (base FR-003, unchanged; the send carries the mandatory `clientstate:` source key).
- `ignored` reasons are now `excluded` (failed the predicate — recorded only on by-id
  reads), `personal`, and `predicate-divergence`. `no-known-entity` no longer exists.
- The attention lane keeps its own gate untouched (base G-13).

**Depends on claims:** G-20, G-23, G-24, G-36, base G-03, G-04, G-05, G-13, G-15

**Bucket:** B/C — the exclusion clause, resolver pieces, quote helpers, and the client
template exist (G-20, G-23, G-36); new: the shared predicate + parity fixture, the
`classification` field and email-local evidence gate (C: new schema field, G-24), the
two-stage identity, the email page creator + collision rule, and the free-mail binding
rule.

### FR-005 — Bounded extraction (amendment)
The base sentences "only FR-003-known entities ever reach extraction" and "volume is
already bounded by FR-003's two filters" are SUPERSEDED (P1-18): any sender admitted by
the FR-003 predicate may reach the no-tools, one-turn, schema-constrained extractor;
volume is bounded by the predicate, the INBOX requirement, and `--max-usd`. Every other
FR-005 rule stands: no tool access, schema validation, quote gate, `matches_open_item`
range check, commitments only ever become human-routed tasks and digest lines.
- WHEN an unknown sender's stage-1 classification runs THE SYSTEM SHALL invoke the same
  `claude -p` shape as the base and stamp cost/receipt on the row; a message whose
  stage 1 fails validation twice is frozen and reported (base at-most-once rule as
  adjudicated in the build ledger: one automatic retry after an invalid result).

**Depends on claims:** G-24, base G-04, G-12

**Bucket:** A — the amendment removes a constraint; the machinery is the base's.

### FR-009 — Detection (amendment: trigger health)
The base digest and invariants stand; the digest gains the event trigger's health
(P1-14) so a healthy sweep never masks a dead trigger.
- WHEN the Tier A listener is not loaded in launchd, or its state file's `last_pull`
  is older than 10 minutes, or `queue_depth` has been non-zero for longer than one
  drain interval THE SYSTEM SHALL print a `trigger: DOWN/STALE (<reason>)` line in the
  Gmail section and SHALL NOT collapse the section to the one-line OK.
- WHEN the digest renders THE SYSTEM SHALL report `last_success_at` (sweep coverage)
  and `last_event_run_at` (event trigger) as separate lines.

**Depends on claims:** G-20, G-21, G-37

**Bucket:** B — extends the Gmail digest section built in the base goal.

### FR-001 — Observation ledger (amendment: created effect)
Ledger `writes` gain a `created:<vault-relative path>` effect token; the digest and the
parity projections render it. No other change.
- WHEN FR-003 creates a page THE SYSTEM SHALL record `created:<vault-relative path>` in
  the row's `writes` and the digest SHALL list it under `created`.

**Depends on claims:** G-23

**Bucket:** A — one effect token added to an existing ledger row shape; no new machinery.

### FR-011 — Tier B prerequisite: Gmail push infrastructure (new)
System MUST have, before `lanes.gmail` is flipped `active`, ALL of: (1) a Pub/Sub topic
`projects/cortextos-gws-495505/topics/<name>` (the topic's project must equal the
credential's project executing `users.watch` — P1-25, G-31) granting
`gmail-api-push@system.gserviceaccount.com` the Publisher role, and a push subscription
targeting the hub; (2) a webhook-hub integration `gmail-pubsub` registered under the
hub's `/webhooks/:name` route (the hub serves `/healthz` and `/webhooks/:name` for the
registered integrations zoom-officehours, ops-check-lead, fireflies; no Gmail
integration exists — G-19) that verifies the Google OIDC token (audience = the hub URL, expected
service account = the push subscription's identity) and relays the raw envelope to
`BRIDGE_URL/relay/gmail-pubsub` under the hub's own `x-webhook-bridge-secret` scheme with
NO Authorization header (G-35, relay.ts:45-66); (3) bridge runtime configuration for
the Gmail lane — the expected `subscription` value the handler validates
(provider-shadow-ingress.ts:213), plus a SECOND accepted auth mode for the lane: a
request bearing a valid `x-webhook-bridge-secret` from the hub is accepted as
hub-verified, the OIDC-Bearer verifier remaining the mode for direct Pub/Sub delivery
(today the lane requires a Bearer the hub never sends, so the two do not compose —
P1-3; the live server also constructs no `gmailShadow` option, G-18) — and a
records-lane worker template and durable-enqueue-before-ack (G-34); (4) a `users.watch` renewal cron at least every 7 days (G-22) using the DWD
identity whose scopes already satisfy `watch` (G-31), which persists the `historyId`
each `watch` response returns as the lane's prior cursor BEFORE the subscription is
enabled (initial cursor for FR-002 Tier B — P2-3); (5) an activation manifest health
probe covering (1)–(4) that the lane resolver consults — `active` in
`provider-config.json` alone MUST NOT enable Tier B (P1-24).
- WHEN any of (1)–(5) is absent THE SYSTEM SHALL resolve the lane to `shadow`, emit a
  diagnostic, and Tier A remains the trigger; flipping the config needs no restart (G-27).

**Depends on claims:** G-18, G-19, G-22, G-26, G-27, G-28, G-29, G-30, G-31, G-32, G-33, G-34, G-35

**Bucket:** D — the Pub/Sub topic/subscription and API enablement are UNVERIFIABLE from
this host (no gcloud, G-28..G-30; the project identity is known, G-28); provisioning
is owned by Josh (A-07). Deferred to a follow-up goal; not in the build goal's DONE bar.

### FR-010 — Meeting pipeline untouched (allowlist extension)
Unchanged, with the permitted-file list extended by
`orgs/clearworksai/agents/pa/scripts/gmail_push_listener.py` (queue append + detached
drain only; attention-lane observables pinned by the FR-002 regression) and
`src/bus/multica/poll.ts` (its deliberate human claim passes `force` explicitly, so the
bus guard needs no claimant-name exemption — build ledger G2r3-9).
- WHEN the brain and bus suites run after this patch THE SYSTEM SHALL pass with the
  count-delta accounting of the base FR-010, and the listener regression SHALL show
  identical prefilter decisions, `pending_since` transitions, and attention spawn argv
  and timing before and after the hook.

**Bucket:** A — a constraint on the build, not new machinery.

## API Contracts

| Method | Path | Auth | Verified status | Response shape | Probe evidence |
|--------|------|------|-----------------|----------------|----------------|
| POST | `/relay/gmail-pubsub` | webhook-bridge (local + `https://bridge.clearworks.ai`); Google OIDC Bearer from the Pub/Sub push subscription; the verifier is NOT wired in the live server today (`gmail_auth_unavailable`) | code-read only — lane `shadow`, no subscription exists (G-27, G-29); `gmail_not_configured` / `gmail_auth_unavailable` / 200 accepted paths read from source | request = Pub/Sub envelope, `message.data` base64 JSON `{emailAddress, historyId}`; shadow mode records the receipt; active mode advances the cursor and returns 200 before or without spawning | G-18, G-34 |
| POST | `/webhooks/:name` | webhook-hub (Railway); per-integration secret; the `gmail-pubsub` integration does not exist yet and is created by FR-011 | 200 observed for the three registered integrations (hub `/healthz` 200 on 2026-09-15); `gmail-pubsub` returns not-found today | raw body parsed to `NormalizedEvent`, then relayed to `BRIDGE_URL/relay/NAME` with `x-webhook-bridge-secret` (+ `x-hub-signature` re-sign for fireflies only) | G-19, G-32, G-35 |

## Decisions (CONTEXT) — delta

| ID | Area | Decision | Provenance | Settled by | Evidence | Locked by | Date |
|----|------|----------|------------|------------|----------|-----------|------|
| D-11 | Relevance filter | CORRECTED: state writes are gated by the existing real-person filter (comms-check exclusion clause, verbatim, plus INBOX), NOT by known-entities-only; a real human sender with no entity gets a created home (FR-003), except relationship `personal`, which is recorded and ignored (A-08). The base's reading of Josh's "ok" was wrong. | directive | n/a | Josh 2026-09-15: "based on an existing email real person filter not on known people" | Josh | 2026-09-15 |
| D-12 | Trigger | Event-driven, tiered: Tier A = existing pa Gmail listener lane (≤120 s) feeding a durable queue + detached drain; Tier B = Gmail push via Pub/Sub → hub → bridge once FR-011 lands; the window sweep is retry/backfill only (2-hour cron), never the trigger. | directive | n/a | Josh 2026-09-15: "it should be a webhook not a 10 minute poll" | Josh | 2026-09-15 |

## Non-goals (delta)
- Tier B provisioning and bridge/hub changes (FR-011) are a follow-up goal.
- The listener's spawn-avoidance prefilter is not harmonised with the comms-check clause.
- A `people/` home for `personal` correspondence (A-08).

## Grounding Ledger

Delta rows G-18..G-38 probed 2026-09-15 by two read-only subagents (code;
infrastructure) and corrected after the Codex round (P1-1..P1-9); full evidence
`scratchpad/patch-probes-code.md`, `patch-probes-infra.md`, `patch-adv-r1.json`. Rows
G-03, G-04, G-05, G-09, G-10, G-12, G-13, G-15, G-16 are carried VERBATIM from the base
spec (unchanged FR dependencies; not re-probed — patch mode).

| ID | Claim (settled fact) | Probe | Evidence | Verdict |
|----|----------------------|-------|----------|---------|
| G-18 | The bridge Gmail lane handler exists (`POST /relay/gmail-pubsub`, Google OIDC Bearer, base64 `{emailAddress,historyId}`; lane mode from `provider-config.json` key `lanes.gmail`) BUT the LIVE server is constructed without `gmailShadow`/OIDC verifier (`gmail_not_configured` / `gmail_auth_unavailable` paths), and its `buildPrompt` is hard-wired to the comms-check skill (no parameterised command) | read provider-shadow-ingress.ts, webhook-bridge.ts | provider-shadow-ingress.ts:144-168, :209-233; webhook-bridge.ts:723-748, :1127-1136 | PARTIAL |
| G-19 | webhook-hub serves `/healthz` and `/webhooks/:name` for three registered integrations (zoom-officehours, ops-check-lead, fireflies); NO Gmail/Pub/Sub integration exists; the relay sends `x-webhook-bridge-secret` to `BRIDGE_URL/relay/<name>` and re-signs `x-hub-signature` for fireflies only | read server.ts, integrations/index.ts, relay.ts | server.ts:31, :35; integrations/index.ts:1-10; relay.ts:45-66 | VERIFIED |
| G-20 | `gmail_push_listener.py` mints its own DWD token (key `~/.config/gws/service-account-key.json`; scopes mail.google.com, gmail.readonly, gmail.modify), polls `history.list` every 60 s, debounces 120 s, spawns `cortextos spawn-worker <name> --dir … --parent frank2 --model claude-haiku-4-5-20251001 --prompt …`; its hard-exclusion prefilter is NOT the comms-check clause (10 extra senders; lacks category + github terms) | read gmail_push_listener.py; SKILL.md:26 | listener :44, :147-151, :52-53, :286-291, :63-91 | PARTIAL |
| G-21 | The listener is not loaded in launchd; plist points at `pa/scripts/gmail_push_listener.py`; its state file does not exist | `launchctl list \| grep -i gmail`; read plist; `ls` | empty; plist line 16; ENOENT | VERIFIED |
| G-22 | Gmail: a `historyId` is "typically valid for at least a week" but "may be valid for only a few hours"; a stale `startHistoryId` → HTTP 404; only `users.watch` carries the 7-day renewal requirement; the listener already abandons a stale cursor and bootstraps from the profile | WebFetch history.list + push docs; listener :42, :255-268, :443-454 | doc sentences in evidence file; listener 404 handling | VERIFIED |
| G-23 | The resolver's page creation is an inline branch of `resolve()` returning a `created` dict; `resolve()` requires a meeting-shaped source (participants/text_units — SystemExit(5) only when both absent) and treats `classification` as optional; `writeback_render.planned_files` is meeting-shaped (renders meeting History, mints a meeting note, never writes a `domains:` value) — NOT reusable for email page creation | read resolve_meeting.py:643-1106, writeback_render.py:66-89, :227-256, :324-350 | resolve_meeting.py:1093-1106, :650-651, :691-695; writeback_render.py:229-256, :324-350 | VERIFIED |
| G-24 | The meeting classifier enum is client\|prospect\|vendor\|partner\|colleague\|personal\|internal; the build branch's `email_extraction.schema.json` has NO `classification` field; the meeting quote gate covers decisions/commitments/open questions/promotion only | read both schemas; resolve_meeting.py:402-442 | extraction.schema.json:37-39; worktree schema required keys | VERIFIED |
| G-25 | Build-branch `client_state_gmail.py` has flags `--repo-root --vault --crm-dir --state-dir --days --query --dry-run --max-usd --today` (live mode = absence of `--dry-run`; there is no `--apply`), and NO `--drain-queue` / `--message-ids` / `--history-id` | read worktree argparse | client_state_gmail.py:793-804 | VERIFIED |
| G-26 | The daemon spawn-worker IPC (`{type:'spawn-worker', data:{name,dir,prompt,parent,env}}`) is generic and shared by both lane templates | read worker-spawn-plan.ts | `trySpawnWorkerForEvent` / `planWorkerSpawn` | VERIFIED |
| G-27 | Lane config `<configDir>/provider-config.json` key `lanes.gmail`, default `shadow`; file absent on this machine ⇒ shadow; read fresh per request ⇒ no restart to flip; the resolver returns `active` for any valid config string without checking prerequisites | read provider-lane-config.ts:37-43, :68-69 | no file found | VERIFIED |
| G-28 | The `gcloud` CLI and its configuration are absent on this host; the GCP project identity IS readable from the existing credential: project `cortextos-gws-495505`, service account `gws-agent@cortextos-gws-495505.iam.gserviceaccount.com` | `which gcloud`; read key file metadata (no key material) | exit 127; `project_id`, `client_email` fields | PARTIAL |
| G-29 | Whether a Gmail Pub/Sub topic + push subscription exists cannot be checked here | blocked by G-28 | — | UNVERIFIABLE |
| G-30 | Whether Pub/Sub + Gmail APIs are enabled cannot be checked here | blocked by G-28 | — | UNVERIFIABLE |
| G-31 | DWD identity `gws-agent@cortextos-gws-495505.iam.gserviceaccount.com` impersonating `josh@clearworks.ai`; listener scopes satisfy `users.watch` (needs one of mail.google.com / gmail.modify / gmail.readonly / gmail.metadata); topic must grant `gmail-api-push@system.gserviceaccount.com` Publisher and live in the same project; notifications carry only emailAddress + historyId | read gws-dwd + listener; WebFetch push guide + watch reference | evidence file | PARTIAL |
| G-32 | webhook-hub (Railway) and the local bridge are running and healthy: launchd `com.cortextos.webhook-bridge` running (pid 24989), `http://127.0.0.1:20242/healthz` 200, `https://bridge.clearworks.ai/healthz` 200, hub `/healthz` 200 (re-probed 2026-09-15 ~06:40Z after a reviewer reported it stopped) | `launchctl list`; `curl -s -o /dev/null -w '%{http_code}'` ×3; `cortextos webhook-bridge status` | 200/200/200; "Service (launchd): running" | VERIFIED |
| G-33 | The hub repo has its own Railway link (`~/code/webhook-hub` → project `webhook-hub`, env production); variable NAMES: BRIDGE_URL, FIREFLIES_WEBHOOK_SECRET, OPS_CHECK_SHARED_SECRET, WEBHOOK_BRIDGE_SECRET, ZOOM_WEBHOOK_SECRET_TOKEN (+ RAILWAY_*) — no Gmail/Pub/Sub variable yet | `railway status` + `railway variables --service webhook-hub --kv` from the hub dir (names only) | listed names | VERIFIED |
| G-34 | In `active` mode the bridge Gmail handler persists its receipt and advances the high-water cursor BEFORE spawning, ignores the spawn result, and returns 200 — a push can be acknowledged with no job | read provider-shadow-ingress.ts:200-206, :225-233; provider-shadow-ingress.test.ts:147-153 | active/accepted with zero spawns is pinned by a test | VERIFIED |
| G-35 | Hub→bridge relay authentication is `x-webhook-bridge-secret` (env WEBHOOK_BRIDGE_SECRET), with `x-hub-signature` re-signing for fireflies only | read relay.ts:45-66; Railway variable names | as above | VERIFIED |
| G-36 | `resolve_meeting.FREE_MAIL` = {gmail.com, googlemail.com, outlook.com, hotmail.com, live.com, msn.com, yahoo.com, icloud.com, me.com, aol.com, proton.me, protonmail.com}; a domain declared on a page binds every sender at that domain via `domain_to_slug` | read resolve_meeting.py:18-31, :312-313 | list quoted | VERIFIED |
| G-37 | The listener loop performs filtering, `pending_since` updates, the attention spawn, `save_state`, and `sleep(60)` in ONE synchronous loop (a blocking records subprocess would shift attention timing) | read gmail_push_listener.py:478-512 | loop body quoted | VERIFIED |
| G-38 | `history.list` returns `nextPageToken`; default 100 records per page, max 500; the listener calls it without `maxResults`/`pageToken` and reads one page | WebFetch history.list reference; listener :209-218, :467-474 | doc + code | VERIFIED |
| G-03 | contacts.json is `{contacts:[{id,name,emails:[...]}]}`; email→contact lookup exists but is NESTED inside meeting-shaped resolve() — a standalone seam must be extracted (FR-004) | read both; round-1 correction | resolve_meeting.py:54/:845-846; `_match_contact`/`_resolve_company_slug` nested | VERIFIED |
| G-04 | quote_gate (resolve_meeting.py:402) is source-shape-generic (needs only extraction + text_units) and imports unmodified; it does NOT ground `summary` and drops availability pleasantries; single-line/control-char checks live separately in validate_extraction; extract_meeting's PROMPT and schema are meeting-coupled — extract_email needs a sibling schema | read extract_meeting.py + schema + gate; round-1 additions | `:402`; extract_meeting.py:101/:178/:358 | PARTIAL |
| G-05 | load_closed_sets(vault) builds domain_to_slug + org_name_to_slug from pages alone. Corrected round 1: the map carries BOTH full-domain and bare-label keys; label keys collide across TLDs (last-writer-wins), duplicate CRM names produce "" keys, and the SAME domain declared twice still overwrites silently (FR-009 invariant covers it) — FR-004 uses full-domain keys only, ""/None as no-match | read resolve_meeting.py:295-352; rounds 1–2 re-probes :207/:311-315 | registrable_label + both-key insert confirmed | VERIFIED |
| G-09 | `gws gmail +read --id` returns headers-only or headers+body | live run both modes | full mode keys include body (len 793) | VERIFIED |
| G-10 | Date-query windowing works (`after:`, `newer_than:`), day-granular; NO historyId mechanism exposed (gws-dwd never calls history.list) | live runs | date-consistent rows both queries | VERIFIED |
| G-12 | The gws shim execs gws-dwd for gmail BEFORE the --sanitize branch — Model Armor never inspects Gmail payloads; email content reaches downstream LLMs unfiltered; hardening rules live in FR-005/FR-008 | read ~/.local/bin/gws | `:31-33` comment + exec | VERIFIED |
| G-13 | `bus comms-filter` is a MUTATING shared first-seen gate: records `<ns>:<id>` (default ns `gmail`) in shared `state/comms-event-dedup.json`, 30-day suppression, consumed by PA's attention lane — a second consumer starves one lane; records lane excluded (FR-003) | rounds 1–2 probes (both reviewers + main thread) | bus.ts:4208; event-dedup.ts:18/:104 | VERIFIED |
| G-15 | Existing History idempotency refuses same-source revisions (any entry whose `[source:]` marker already exists returns the old page — :136-137) and renders meeting-shaped lines — email renderer + supersede path are new (FR-007) | rounds 1–2 probes | writeback_render.py:133/:136-137 | VERIFIED |
| G-16 | Reusable single-flight claim primitives exist (bus claim commands: exclusive file creation, configurable claims dir + TTL, stale cleanup) — FR-002's lock reuses them | round-2 probe (Codex) | bus.ts:2541; meeting-brief.ts:368 | VERIFIED |

## Accepted assumptions (owned)

| ID | Assumption | Ledger | Owner |
|----|------------|--------|-------|
| A-06 | Tier A latency (≤ 120 s via the listener's 60 s delta poll + 120 s debounce, then a detached drain) satisfies "webhook, not a 10-minute poll" for v1; true push (Tier B) follows FR-011. Recorded reading of the directive, not a silent one. | G-20, G-21, G-37 | Josh |
| A-07 | Pub/Sub topic/subscription and API enablement cannot be verified from this host (G-28, G-29, G-30); FR-011 is bucket D and a follow-up goal; Josh (or an agent with gcloud in project cortextos-gws-495505) provisions. | G-28, G-29, G-30 | Josh |
| A-08 | Relationship `personal` records the observation and writes no page or CRM row; colleague/internal (owned domain only) file to `orgs/clearworks-internal.md`. Flip in a later patch if personal correspondence should have a home. | G-24, G-36 | Josh |
| A-09 | The listener's spawn-avoidance prefilter stays as-is; it only decides whether the attention worker spawns; the records lane applies the shared FR-003 predicate. | G-20 | Josh |
| A-10 | Stage-1 classification of an unknown sender is a paid model call per new sender (bounded by the predicate + `--max-usd`); a sender whose classification fails validation twice is frozen for the digest rather than retried forever. | G-24 | Josh |

## Roast verdict

**n/a — patch, premise re-affirmed** · 2026-09-15
Base: state/specs/2026-09-14-client-state-gmail-v1-spec.md
User re-affirmed: "we had already agreed that it should be a webhook not a 10 minute poll, and that it is based on an existing email real person filter not on known people." (Josh, 2026-09-15)

## Adversarial changelog

**Round 1 — 2026-09-15.** Codex grounding pass (`codex exec`, read-only, reasoning
high) scoped to FR-002/FR-003/FR-011 + G-18..G-33: 27 findings (16 CRITICAL, 11
HIGH), 7 ledger rows WRONG, 2 rejected as directive by the reviewer. Dispositions in
v2: G-18/19/22/23/28/33 restated to the probed facts (P1-1, P1-4..P1-7, P1-9); G-32
re-probed live and VERIFIED (P1-8 was a bad probe — the bridge is running, 200 on
localhost, tunnel, and hub); Tier B cursor/pagination/404 semantics (P1-10, P1-11);
complete argv + live-mode contract (P1-12); sweep-coverage vs event receipts split
(P1-13); FR-009 trigger-health line (P1-14); free-mail domains never declared, contact
binding instead (P1-15); shared INBOX+labels predicate with fail-closed divergence
(P1-16, P1-17); FR-005 sentences explicitly superseded (P1-18); two-stage extraction
identity (P1-19); email-specific page creator, not `planned_files` (P1-20); `created`
ledger effect (P1-21); slug-collision rule (P1-22); internal only for owned domains
(P1-23); FR-011 prerequisites complete incl. topic project + activation manifest
(P1-24, P1-25); durable queue + detached drain, listener observables pinned (P1-26);
email-local classification evidence gate (P1-27); bridge ack-before-spawn recorded as
G-34; hub relay auth as G-35; FREE_MAIL as G-36; listener loop as G-37; history
pagination as G-38. 
**Round 2 — 2026-09-15.** Scoped Codex re-review of v2: 20/27 RESOLVED, 6 PARTIAL,
1 OPEN, 3 NEW (P2-1 HIGH file-vs-ignore contradiction for `personal`; P2-2 HIGH
free-mail binding blocked by base FR-006; P2-3 CRITICAL Tier B first push lost when
the cursor is bootstrapped after the event). Applied in v3: top-level MUST split into
record (ledger) vs file (home) with the explicit `personal` exception + D-11 (P2-1);
FR-006 amended for classification-backed free-mail contact creation with idempotency
semantics (P1-15, P2-2); Tier B initial cursor = persisted `users.watch` historyId,
never a post-notification profile, no-cursor push ⇒ sweep trigger (P1-10, P2-3);
page-level queue checkpoints + `history_pages/records/unique_ids/remaining` receipts
(P1-11); 404 ⇒ gap-covering sweep sized from `last_processed_at`, max 7 days (P1-5);
runtime divergence check stated as one-directional, reverse case fixture-only (P1-17);
FR-011 item 2/3 auth composition — hub relays with the bridge secret and no Bearer, so
the bridge Gmail lane gains a hub-verified auth mode, plus the `subscription` config
value (P1-1, P1-3). 
**Round 3 — 2026-09-15.** Scoped Codex re-review of the v3 sentences: 9/10 RESOLVED
(P1-1, P1-3, P1-10, P1-11, P1-15, P1-17, P2-1, P2-2, P2-3 — the two new code claims,
`provider-shadow-ingress.ts:213` subscription check and `relay.ts:45-66` no
Authorization header, verified against the repo), zero NEW findings. P1-5 residual
(the 7-day cap left a gap older than 7 days uncovered) fixed in the final text: the
gap-covering sweep is uncapped and chained in 7-day windows. 
**CONVERGED 2026-09-15 — round 3 returned zero CRITICAL/HIGH findings** (the single residual was a mechanical cap removal, recorded above).
