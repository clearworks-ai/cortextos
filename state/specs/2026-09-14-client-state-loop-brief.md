---
title: Client State Loop — running client state from every source
slug: client-state-loop
date: 2026-09-14
mode: standard
status: APPROVED-BRIEF
supersedes: state/specs/brain-source-to-state-2026-09-04-spec.md §FR-017..FR-022 (replaces; FR-001..FR-016 stand)
owner: Josh
ambiguity_score: 0.22
---

# Client State Loop — brief

## The ask (Josh, verbatim, 2026-09-13)

> "the goal is to have a running client state for clearworks all updated to the proper
> org/person/project/client whatever. that is the business outcome. so an email from
> marcos comes in, it hits the crm, it hits the client state/history doc, it's a state
> maintenance."

State maintenance, not meeting processing. Sources are evidence; the CRM record and the
client state/history page are the targets. The meeting pipeline (FR-001..FR-016, live and
proven on 300 meetings) is ONE source's handler, not the model.

## Actor

**Who is blocked today:** Josh — solo operator of Clearworks — pays the "wait, what's the
latest with this client?" tax before every call and every status draft, because state
lives in Fireflies, Gmail, Slack, GitHub and his head, and only meetings currently flow
in automatically. Secondary actor: every fleet agent (pa-codex drafting a brief,
crm-codex answering a pipeline question) that reads a client page and must be able to
trust it is current.

## Success evidence

Observable, demoable, per source:

1. Marcos emails Josh about the Alloi tacticals. WITHIN 10 MINUTES (≤ 600 s), with zero manual
   steps: `interactions.jsonl` has one new row (type ≠ meeting, source ref
   `gmail:<msgid>`), `clients/alloi.md` History has one new dated entry citing that
   source ref, and any commitment in the email exists as exactly ONE bus task (not two,
   even though the meeting last week promised the same thing).
2. A Slack thread in a bound client channel gains five replies AFTER being filed →
   the derived history entry is superseded, not duplicated (D-02 demonstrably fires).
3. Josh opens one client page before a call and is current — the `context-maintenance.md`
   ladder's "fully autonomous" rung, testable by diffing the page against the last
   7 days of that client's Gmail/Slack/Fireflies activity and finding nothing material missing.
4. The daily watcher reports the loop healthy across ALL live sources, not just Fireflies.

**Measured by:** the per-source handler's own receipt (deterministic), the daily watcher's
source-vs-state diff, and spot-check 3 above run on n = 2 real clients before v1 is called done.

## Premises (confirmed 2026-09-14)

1. Sources are evidence that updates state on the correct entity (org / person / project /
   client). Targets: CRM + org-brain client page. Meetings keep their richer
   meeting-specific outputs (recap draft, attendee model).
2. FR-017..FR-022 are REPLACED. No kind-sink threading through run_meeting.py, no one-way
   storage_id, no per-kind sentence floors, no rule-0 bolted onto the meeting resolver.
   Salvage: the envelope idea (now: observation with a version) and per-source validation.
3. Mechanism: deterministic handler scripts. The inbox is escalation-only (entity
   unresolvable), never the happy path. This is the lesson of 2026-09-13: the LLM-worker
   lane received webhooks for months and filed nothing.

## Decisions (CONTEXT)

| ID | Area | Decision | Provenance | Settled by | Evidence | Locked by | Date |
|----|------|----------|------------|------------|----------|-----------|------|
| D-01 | Source of truth | CRM owns structured FACTS (contact, company, stage); the client page owns NARRATIVE (history, outcomes, open items). Each writes its half; neither overwrites the other. | settled | grill | AskUserQuestion 2026-09-14 | Josh | 2026-09-14 |
| D-02 | Mutable sources | Re-derive on version change (Alloi's model): observations carry sourceRecordId + version/content digest; a changed digest re-derives and SUPERSEDES the prior derivation. Solves Astra's immutable-event objection. | settled | grill | alloi-os packages/domain/src/generation.ts (GeneratorInputObservation.sourceVersionOrDigest) | Josh | 2026-09-14 |
| D-03 | Write safety | AUTO-WRITE, no approval layer. Discipline instead of gates: (a) fill-blanks-only for CRM facts — never overwrite a human-entered value; (b) every state change appends a History entry with its source ref (already the meeting convention, `[source: <kind>:<id>]`); (c) escalation to Telegram ONLY when entity resolution fails — routing, not approval. Everything is in git. | directive | grill | Josh: "i think we just write to these things. maybe track history too." Altari records-administrator's confirm-every-write gate deliberately NOT adopted (it targets two-way external-CRM sync); its sibling rule "fill blanks only, never overwrite human-entered data" (DESIGN-B-crm.md) IS adopted. | Josh | 2026-09-14 |
| D-04 | Entity resolution | One shared resolver library, extracted from resolve_meeting.py's machinery (declared `- CRM org name:` lines, domains, rules 12/13 overrides) — it carries eight rounds of Josh's ground truth. Alloi-style STATIC bindings only for Slack channels and GitHub repos, which genuinely are static. | settled | grill | resolve_meeting.py; 2026-09-13/14 ground-truth memory | Josh | 2026-09-14 |
| D-05 | Commitment dedup | One commitment, many evidences. Dedup on normalized owner+text against open items before creating a bus task (same shape as CRM's source_ref+contact_id dedup). Gmail and Slack DO produce commitments/tasks — only the recap draft is meeting-specific. | settled | grill | Josh 2026-09-13: "gmail should also produce tasks/commitments. so can slack" | Josh | 2026-09-14 |
| D-06 | Currentness | v1 is write-on-arrival only. Alloi's currentness state machine (staleness tracking, refresh windows) is v2. The daily watcher already alarms on a dead pipe, which is the failure that actually occurred. | settled | grill | meeting_loop_watch.py | Josh | 2026-09-14 |
| D-07 | Alloi boundary | Contracts, not code — with ONE exception Josh named: `source-slack-window.ts` (+ its `source-snapshot-contract.ts` redaction contract) may be used directly. Alloi is a client; this is Josh's commercial call, recorded as such. | directive | grill | Josh: "we could probably use the slack adapter primitive we made for them" / "yes of course use it exactly"; audit 2026-09-07 "do not lift code across the Alloi product boundary" | Josh | 2026-09-14 |
| D-08 | v1 scope + order | All four sources: Gmail, Slack, GitHub, Zoom-attendance. Build the shared SPINE once (observation store w/ version digests, association, resolver library, handler skeleton), then land sources: Zoom-attendance → Gmail → Slack → GitHub. Gmail gated on a one-hour dedup check against the EXISTING Gmail CRM ingest (Astra). | settled | grill | AskUserQuestion 2026-09-14 (all four selected) | Josh | 2026-09-14 |
| D-09 | No proposal service | Alloi's proposal/approval layer is not adopted. Josh is the only reviewer; D-03's discipline + git + the daily watcher are the containment. | directive | grill | Josh: "i dont think i want a proposal service" | Josh | 2026-09-14 |
| D-10 | GitHub output shape | GitHub history is CLIENT STATE: the evolution of the app, curated for client eyes — what shipped and what it does now, never the 3am bugfix diary. A delivery-narrative writer, not a meeting record. | directive | grill | Josh 2026-09-13 verbatim | Josh | 2026-09-14 |

## Non-goals

- Omi adapter (redundant with Fireflies for meetings; no participant emails without the
  calendar join, which stays WAIT).
- Meeting-shaped outputs (recap draft, attendee model) for non-meeting sources.
- A proposal/approval service.
- FR-017's kind-sink refactor of run_meeting.py (~19 literal sites), storage_id encoding,
  per-kind not-ready floors, resolver rule 0.
- Two-way sync with external CRMs (HubSpot/Attio etc.) — records-administrator territory,
  different risk profile, separately gated if ever wanted.

## Carried findings the FR phase MUST address (from Astra's review + probes)

1. `meeting-crm-sync.py` hard-codes `--type meeting` (L307) — any source routed through it
   misfiles as a meeting. Non-meeting handlers need their own interaction type.
2. An existing Gmail CRM ingest already writes interaction rows (observed live: Railway
   deployment alerts). Gmail's handler must establish coverage/dedup against it FIRST.
3. The pipeline's receipt model refuses re-derivation — D-02's supersede-on-version-change
   is new machinery, not a flag on the old loop.
4. Zoom: the zoom-officehours integration EXISTS IN CODE with tests, but there is no
   evidence it ever processed a live event (Josh: "never been proven or used"). Treat its
   AMBIG-escalation shape as a design reference, not a proven path. Zoom-attendance v1 is
   for CRM/marketing attendance data.
5. Fireflies writes `duration_s` in MINUTES; backfill converts to seconds — independent
   unit bug, fix separately.

## Reference material for FR extraction

- Alloi shape: `alloi-os/packages/domain/src/{observations,generation,currentness}.ts`
  (SourceSystem union, per-source content limits, version digests). Contracts only (D-07).
- Content doctrine: `knowledge-sync/raw/areas/clearworks/altari-skilltree/jobs/`
  `context-maintenance.md` ("one living file per client that everything reads and writes"),
  `crm-sync.md`, `crm-hygiene.md`, `entity-compliance.md`, `status-updates.md`.
- Write-path ground truth: `DESIGN-B-crm.md` (event mechanism reality; enrichment rules).
- Transport: webhook-hub (Railway, `main`, HMAC per source) → `bridge.clearworks.ai` →
  daemon spawn → handler script. Proven end to end for Fireflies 2026-09-13.

## Roast verdict

**RESHAPE → amendments accepted by Josh** · confidence medium-high · 2026-09-14 · mode=code
Biggest risk: confidently-wrong resolutions never escalate (D-03 watched the wrong failure mode) and become permanent under fill-blanks-once — MSIA already shows the damage pattern at one source.
Cheapest 48-hour test (probe): replay digest-supersede against the existing 292-meeting corpus, count duplicate History entries (MSIA = dirty control); plus Astra's 5-thread Gmail gap-check → ledger claims in Phase 2.
Cheapest 48-hour test (demo): n/a — mechanism questions.
Scores: Constitution 6/10 · YAGNI 4/10 · Contrarian 3/10 · Code-Researcher 7/10 · Operator 4/10

**Accepted amendments (Josh, "sure try it", 2026-09-14):**
- **D-03 AMENDED — detection, not approval.** Auto-write stands. ADD: a daily per-client "state changes made yesterday" digest and an invariant check (CRM org vs declared page lines), so wrong-but-confident writes surface within a day. Escalation-on-unresolvable alone is refuted by this repo's own history (eight ground-truth rounds of confident wrong picks).
- **D-02/D-03 RECONCILED (to be specified in FRs):** supersede = a marked replacement entry in History, never a silent rewrite; define whether/how a supersede propagates into an already-filled fill-blanks-once fact.
- **D-08 RESEQUENCED:** Gmail thin slice FIRST against the existing resolver; the spine is extracted when the SECOND source needs it; Zoom-attendance drops to last. The Gmail dedup gate against comms-backfill.py's live path is a build-order gate, not a footnote.

**Peer-review corrections carried into Phase 1:** two identity schemes (source_ref+contact_id vs observation digest) must be one scheme or explicitly mapped; D-04 must name the actual source-agnostic resolver core (domain/contact/alias matching) rather than claim "the resolver" extracts.

## Next (fresh session recommended)

1. specify Phase 0.8 — `Skill(roast)` mode=code on this brief's premise. NOT yet run:
   Astra's 2026-09-13 scope review (SCOPE-CHALLENGE-astra.txt, verdict BUILD SOME) was an
   adversarial pass on the predecessor premise in ONE context, and this brief already
   folds its findings in — but it is not the five-seat council and does not substitute.
2. Phase 1 FR extraction from this brief.
3. Phase 2 capability probes — the spine's claims: observation store location, association
   shape, resolver-library extraction seam, each source's auth/API reality (Gmail ingest
   overlap, Slack scopes, GitHub access, Zoom webhook events for attendance).
4. Adversarial rounds → final spec → /bonesify.
