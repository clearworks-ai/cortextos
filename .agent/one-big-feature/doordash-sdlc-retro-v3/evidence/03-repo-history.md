# 03 — Repo History: DoorDash / SEIU-521 Build Arc

Source: `~/code/doordash-linker` — `origin = github.com/clearworks-ai/doordash-linker`
Range: 271 commits, 2026-04-22 → 2026-07-19.

Commit distribution by month: Apr 16 · May 15 · Jun 10 · Jul 230.

The build was a long-tail: a compact Phase-1/Phase-2 core in late April, a scattered
May–June hardening cadence (the transcript-gap window), then a massive July "OPS recovery"
convergence where the June reconciliation was driven from ~34/90 → 82/90+ match rate and the
David-facing dashboard/chat/order-spine were built.

---

## (a) Full Dated Commit Timeline

### April 2026 — Phase 1 + Phase 2 core, then Reconciliation Workflow 2
```
2026-04-22 19:42 | c75e40a | Initial commit: Phase 1 complete
2026-04-22 19:59 | e16e3b3 | feat(db): initial Drizzle schema + RLS on Supabase seiu521-doordash
2026-04-22 20:02 | 48381ac | feat(phase2): wire onInboundEmail task (1/7)
2026-04-22 20:22 | a000ad2 | feat(phase2): wire assembleSubmission task (2/7)
2026-04-22 20:27 | d327af5 | feat(phase2): wire remaining 5 tasks + Egnyte client (3/7-7/7)
2026-04-22 21:40 | b64a29b | fix(phase2): P0 + HIGH + MEDIUM reliability sweep
2026-04-22 22:37 | 0999b12 | fix(config): make RESEND_INBOUND_WEBHOOK_SECRET optional
2026-04-29 17:39 | 5482d09 | feat(reconcile): CSV write-back + Pattern A drop-folder + smoke
2026-04-29 21:59 | a33efe7 | feat(reconcile): XLSX support + smart sheet selection
2026-04-29 22:25 | fdca182 | feat(reconcile): historical PDF backfill + matcher loosening
2026-04-29 22:47 | 6cb9c98 | fix(reconcile): inbox->processed move, UTC tz parse, token-overlap vendor
2026-04-29 23:44 | d07deaa | fix(reconcile): Inbox->Processed move + matcher hardening for ~98% match
2026-04-30 00:00 | 255690b | feat(reconcile): voided detection + confidence flag + unused-files CSV + match-rate metric
2026-04-30 00:05 | 09a7308 | feat(reconcile): auto-archive prior outputs (finance sees only latest)
2026-04-30 09:54 | 8f31692 | fix(extract): teach Claude about SEIU company-paid receipt structure
2026-04-30 11:08 | bc20cc1 | fix(extract): empty-PDF + not-a-receipt sentinels, JSON-only prompt
```

### May 2026 — migration handoff, notify polish, classification, security hardening (GAP WINDOW)
```
2026-05-01 10:12 | 1c8b06d | docs(migration): runbook + helper scripts for client-infra handoff
2026-05-05 17:48 | 0d3830c | feat(notify): verbose failure email w/ resubmission instructions
2026-05-05 17:50 | 67dc04d | feat(notify): failure email 3-attachment guidance copy
2026-05-05 18:05 | f32d9b9 | feat(notify): dynamic failure-email sentence from actual error reason
2026-05-05 18:15 | 2c036a1 | feat(classify): classify attachments by doc type, dynamic failure email
2026-05-05 18:22 | 569d79b | feat(classify): vision OCR classification — read file content via Sonnet
2026-05-05 22:32 | 49b8c98 | fix(security): C1-C5 + H7 — HMAC verifier del, svix replay guard, dedup, caps
2026-05-05 23:13 | bbfba85 | fix(security): R1/R5 test-import + NaN-guard svix timestamp
2026-05-05 23:13 | 0edc974 | merge(security): fix/security-storage — C1-C5+H7 hardening
2026-05-05 23:20 | a2c72df | fix(matcher+extract): H2 ambiguity, H3 raw ts, H4 is_receipt bool, M2 logging
2026-05-05 23:21 | a831f9a | merge(matcher): fix/matcher-datamodel — H2-H4, M2, R6-R8, M-R3
2026-05-05 23:29 | 7580ebf | feat(classify): per-page PDF classification for mixed docs; +infra H5/M1/M3/M5
2026-05-05 23:29 | 71250b2 | fix(mixed-pdf): classifyPdfByPage MAX_PAGES=10 cap
2026-05-11 14:04 | a76ad07 | feat(monitoring): CC ddmonitoring@seiu521.org on all outbound + forward replies (#2)
2026-05-11 14:53 | 6167852 | feat(inbound): drop emails from senders outside allowed domains (#3)
```
(No commits 2026-05-12 → 2026-06-03.)

### June 2026 — matcher tiers, classify decoupling, ingest hardening
```
2026-06-04 11:06 | 478cb.. | DD-2 + DD-3: dedup-reply + top-level error boundary on onInboundEmail (#5)
2026-06-04 11:06 | 5fc84.. | feat(dd-1): submission-status admin script + getStatusSummary (#4)
2026-06-16 15:21 | 6ccd0.. | fix(pipeline): ruleset hardening — 4 failure fixes + matchBilling rules (#6)
2026-06-16 16:00 | 23424.. | feat(matcher): Tier-3 open-PDF verification for ambiguous duplicates (#7)
2026-06-25 11:19 | ba1a8.. | fix(inbound): attachment-fetch resilience — skip unfetchable, fail only if zero (#8)
2026-06-25 12:51 | f6578.. | feat(classify): decouple is_receipt from DoorDash, add is_doordash flag (#9)
2026-06-25 21:57 | bc3f2.. | feat(inbound): capture id-only attachments at ingest, read storage-first (SPEC-04) (#11)
2026-06-26 12:54 | 9a290.. | fix(inbound): harden reprocess upsert collision (spec-06) (#12)
2026-06-26 13:13 | db452.. | fix(notify): 365d idempotency TTL on admin notifications (spec-07) (#13)
2026-06-26 15:09 | eba1e.. | feat(reconcile): monthly reconciliation summary email (draft to Josh) (#14)
```

### July 2026 — OPS recovery, dashboard, order-spine, classification cascade, multilink/value (230 commits)
High-signal milestones only (full daily counts: 07-09:9, 07-10:7, 07-11:1, 07-13:2, 07-14:2, 07-15:64, 07-16:47, 07-17:48, 07-18:41, 07-19:5):
```
2026-07-08 18:56 | feat(reconcile): OPS recovery base — final-sheet enrich + open-PDF ambiguous + matcher widening
2026-07-08 19:25 | feat(reconcile): auto index-rebuild + order-id-aware recovery + tiered David email (#15)
2026-07-09 02:50 | feat(dashboard): foundation — magic-link auth + thread/exception/reconcile_runs schema
2026-07-09 03:02 | feat(dashboard): stats API + runs/rows/export routes
2026-07-09 03:17 | feat(dashboard): self-serve upload -> match-billing trigger + poll
2026-07-09 03:42 | feat(dashboard): submission-narrative correlation engine
2026-07-09 04:50 | feat(dashboard): David-facing React UI (magic-link, months overview, thread timeline) (#16)
2026-07-09 20:56 | feat(521): upload-time classify accuracy + month loop-state + reclassify-unknown (#17)
2026-07-10 00:02 | fix(521): merge loop attempts sharing a subject loop-UUID (#20)
2026-07-10 09:02 | fix(reconcile): amount-guard matcher + 3-section client summary email (#21)
2026-07-10 14:00 | fix(auth): magic-link callback GET-safe against link-preview scanners (#24)
2026-07-10 17:30 | fix(vision): omit deprecated temperature param that silently killed extraction (#26)
2026-07-10 21:02 | fix(521): emit Match Status + numeric confidence in final sheet (#27)
2026-07-13 09:27 | fix(521): remove wrong-city tier; dashboard confidence + pdfjs lazyload (#29)
2026-07-13 11:02 | fix(521): auto-file receipts + deterministic dedup + 31-col David sheet (#30)
2026-07-14 07:25 | fix(521): two-pool matcher + order-level claim for merged PDFs (#31)
2026-07-14 22:20 | feat(match): last-ditch matcher + combined-receipt recovery — June 70/90 (#32)
2026-07-15 05:57 | fix(matcher): deterministic pre-open combined-sum + single-order acceptance tier
2026-07-15 09:49 | feat(email): EMAIL_REDIRECT_TO staging safety guard (staging env work begins)
2026-07-15 11:06 | feat(matcher): subject-fingerprint recovery tier + combined-sum pass
2026-07-15 12:13 | fix(matcher): prod PDF-render resilience — direct canvas dep + per-PDF timeout
2026-07-15 18:27 | feat(monitor): webhook-health-check scheduled task — page on ingestion stall
2026-07-15 18:51 | fix(edge): remove svix-skew replay check that auto-disabled the inbound webhook (P0 outage)
2026-07-15 20:27 | feat(status-meter): live-progress backend + frontend for reconcile runs
2026-07-15 21:06 | SP1-SP7 app-surface-refinement: order date, ambiguous candidates, CFO dashboard,
                    receipt-backed landing, proof-first drawer, agentic chat (read + PDF-verify),
                    follow-up-doc ingestion (stop dropping reply attachments)
2026-07-16 09:42 | style(dashboard): SEIU 521 brand — purple/yellow, logo, Open Sans
2026-07-16 11:53 | feat(reconcile): self-updating rematch + Refresh button
2026-07-16 13:08 | feat(match): review-queue Phase 1 — deterministic auto-match, demote fuzzy/LLM
2026-07-16 16:16 | fix(match): enforce receipt uniqueness — one receipt matches at most one order
2026-07-16 16:58..19:04 | R1-R24 robustness sweep: multi-page split, refund/negative class,
                    company-paid $0 fallback, exception aging digest, match-rate regression alert,
                    not_a_receipt rescue lane, dry-run harness, double-claim guards
2026-07-17 09:48 | H1-H9 reconcile-hardening (adversarial audit): stale-run pin, double-claim scan,
                    cents-off tolerance, live-rematch crash, staging-email guard
2026-07-17 15:27..20:06 | ORDER-SPINE rescue P0-P5: 5-table order spine + deriveOrderState fold +
                    orderKey, classification-on-all-paths eligibility gate, order materializer,
                    re-derivation reconcile (fixes 25 false-missing), supersede, gate-then-match,
                    sweep-correlation requires orderKey/loop-UUID (never sender-alone). Staging-proven.
2026-07-17 21:13 | P2 frontend: consolidated one-model reconcile dashboard as homepage
2026-07-17 22:36 | taxonomy: 31 unknown pages root-caused = OCR-gap (text-layer-only classifier)
2026-07-18 00:23 | wire page-evidence persistence into inbound classify path
2026-07-18 01:17 | C#4 content-based segmentation over page evidence (replaces amount-split)
2026-07-18 11:47 | R25-C1/C2: mistralOcr module — cheap OCR for scanner/image PDFs (cascade Tier 1)
2026-07-18 12:28..14:47 | classify v3/v4: describe-every-page + Mistral OCR fallback + other_document
                    catch-all — 31 unknowns -> 1 on real June data
2026-07-18 11:47 | feat(dashboard): rich drill-in — matched tab, per-row detail, cleanup-tray
2026-07-18 15:58 | dashboard P1: three actionable buckets (missing-form / getReceipt / unidentifiable)
2026-07-18 16:21 | dashboard P3: combined-receipt membership — charges sharing one combined PDF
2026-07-18 17:10..17:25 | drilldown D1/D2: per-row match-explain (reason/confidence/receipt/vision),
                    reason-based combined receipts, page-anchored deep-links
2026-07-19 02:16 | E1: unidentifiable card real reconcile state (orphanNoCharge vs matchedComplete)
2026-07-19 02:25 | E2: multiple Egnyte links per order + same-order ambiguity recovery
2026-07-19 02:31 | E3: Value-delivered card — time + $ saved from real funnel counts
2026-07-19 02:45 | merge feat/order-multilink: E1 orphan messaging + E2 multi-link + E3 value card
```

---

## (b) Apr23–May25 Gap-Window Reconstruction

Transcript archives are missing for Apr 23 – May 25 2026. The git history covers it fully:
**24 commits** land in this window (2026-04-29 → 2026-05-11). Work clustered into four bursts;
there was a hard silence 2026-05-12 → 2026-06-03 (no commits at all).

**Burst 1 — Reconciliation Workflow 2 built out (Apr 29–30, 9 commits, ~2,500 LOC added).**
This is where PRD "Workflow 2" (billing CSV → multi-field match → enriched output) went from
nothing to ~98% match. `5482d09` alone is the anchor: +201 LOC `match/reconcileOutput.ts`,
new `pollReconcileInbox.ts` (+174), `reconcileCron.ts`, `notifyAdmin.ts` (+132), Egnyte client
(+180), an architecture.html doc (+1013), db-probe/smoke/replay scripts, and migration 0001.
Then XLSX support + smart sheet selection (`a33efe7`), historical PDF backfill + matcher
loosening (`fdca182`), UTC tz parsing + token-overlap vendor matching, and a hardening pass
to ~98% (`d07deaa`). Capped by voided-receipt detection, confidence flags, unused-files CSV,
match-rate metric (`255690b`), and auto-archiving prior outputs so finance sees only the latest run.

**Burst 2 — Extraction accuracy (Apr 30, 2 commits).** Taught Claude the SEIU company-paid
receipt structure (`8f31692`), then added empty-PDF / not-a-receipt sentinels and a JSON-only
prompt (`bc20cc1`) — the first "the LLM is misreading real docs" corrections.

**Burst 3 — Client-infra migration + notify polish + CLASSIFICATION (May 1, May 5; 8 commits).**
Migration runbook for client-infra handoff (`1c8b06d`). Then a notify-copy cluster (verbose
failure emails, 3-attachment guidance, dynamic error-reason sentences). The pivotal May-5
addition is **document classification**: `2c036a1` classifies attachments by doc type;
`569d79b` adds **vision-OCR classification reading actual file content via Sonnet** (±1000 LOC
lockfile churn, rewrites `classify/docTypes.ts`); `7580ebf`/`71250b2` add **per-page PDF
classification for mixed docs** with a MAX_PAGES=10 cap — the origin of the mixed-document /
page-level handling that the July doc-reader work builds on.

**Burst 4 — Security hardening + data-model fixes (May 5 late-night, 5 commits).** A graded
adversarial-audit sweep: deleted a dead HMAC verifier, added a svix replay guard + svixId
storage keys + filename dedup + attachment caps (C1-C5/H7), NaN-guard on svix timestamp,
plus matcher/extract data-model fixes (H2 ambiguity surfacing, H3 raw-timestamp field, H4
is_receipt boolean, M2 sentinel logging). This is the security/data-model tightening that
mid-May transcripts would have discussed.

**Tail — Monitoring + inbound allowlist (May 11, 2 commits → PRs #2/#3).** CC ddmonitoring on
all outbound + reply-forwarding (`a76ad07`), and dropping emails from senders outside the
allowed domains (`6167852`). Then the repo goes silent until 2026-06-04.

Gap-window takeaway: the "happy path" (intake→assemble→file, and reconcile→match→write-back)
was essentially finished in this window, and the *first three whole categories of scope growth*
(document classification, vision OCR, per-page mixed-PDF handling, and security/svix hardening)
were all introduced here — not in July.

---

## (c) Scope-Growth Milestones vs Original Phase-1 Scope

**Original PRD v2.0 scope (2026-04-20, the "happy path"):**
- Workflow 1 — 3-attachment intake → validate count → merge PDF → Claude extracts vendor/total/
  timestamp/city → deterministic filename → file to Egnyte subfolder → error reply on failure.
- Workflow 2 — monthly billing CSV → multi-field match (vendor+total+timestamp, not filename) →
  enrich each row with doc-ID + Egnyte link → flag unmatched/ambiguous → write back / email finance.
- Stack: Trigger.dev + Supabase(Postgres)/Drizzle + Resend Inbound/outbound + Claude Sonnet + pdf-lib.
- Six-status match model carried forward from v1.0.

Everything below is scope that grew **beyond** that happy path, dated:

| # | Scope growth (beyond Phase-1 happy path) | First landed | Where |
|---|---|---|---|
| 1 | **Document classification by doc type** (which attachment is which) | 2026-05-05 | 2c036a1 |
| 2 | **Vision-OCR classification** — read actual file content via Sonnet, not filename | 2026-05-05 | 569d79b |
| 3 | **Per-page / mixed-PDF classification** (MAX_PAGES cap) | 2026-05-05 | 7580ebf/71250b2 |
| 4 | **Security/webhook hardening** — svix replay guard, dedup, attachment caps, HMAC removal | 2026-05-05 | 49b8c98 |
| 5 | **Verbose/dynamic failure-notification emails** (resubmission guidance from real error) | 2026-05-05 | 0d3830c..f32d9b9 |
| 6 | **Monitoring** — CC ddmonitoring + reply-forwarding; sender-domain allowlist | 2026-05-11 | a76ad07/6167852 |
| 7 | **Dedup-reply + top-level error boundary** on inbound | 2026-06-04 | #5 |
| 8 | **Matcher ruleset hardening + Tier-3 open-PDF verification** for ambiguous dups | 2026-06-16 | #6/#7 |
| 9 | **Attachment-fetch resilience** (skip unfetchable, fail only if zero receipts) | 2026-06-25 | #8 |
| 10 | **is_doordash flag** — decouple is_receipt from DoorDash; file genuine non-DD receipts | 2026-06-25 | #9 |
| 11 | **id-only attachment capture at ingest + storage-first read** (SPEC-04) | 2026-06-25 | #11 |
| 12 | **Reprocess upsert-collision hardening + 365d idempotency TTL** | 2026-06-26 | #12/#13 |
| 13 | **Monthly reconciliation summary email** | 2026-06-26 | #14 |
| 14 | **OPS-recovery engine** — auto index-rebuild, order-id-aware recovery, tiered David email | 2026-07-08 | #15 |
| 15 | **David-facing web DASHBOARD** — magic-link auth, months overview, submission-thread timeline, self-serve upload→match | 2026-07-09 | #16 |
| 16 | **Upload-time classify accuracy + month loop-state + reclassify-unknown** | 2026-07-09 | #17 |
| 17 | **Order-multilink / loop-UUID** — merge loop attempts sharing a subject | 2026-07-10 | #20 |
| 18 | **Amount-guard matcher + 3-section client summary email** | 2026-07-10 | #21 |
| 19 | **Numeric confidence + Match-Status vocabulary in final sheet** | 2026-07-10 | #27/#28 |
| 20 | **Combined-receipt recovery + last-ditch matcher** (June 34→70/90) | 2026-07-14 | #31/#32 |
| 21 | **Two-pool matcher + order-level claim for merged PDFs** | 2026-07-14 | #31 |
| 22 | **Subject-fingerprint recovery tier + combined-sum tier**; month-bucket by order date | 2026-07-15 | 120bf |
| 23 | **Staging environment isolation** (EMAIL_REDIRECT_TO, EGNYTE_WRITE_ROOT_PATH) | 2026-07-15 | e88d3/b8eec |
| 24 | **Webhook-health monitor** + external health-check (post P0 inbound outage) | 2026-07-15 | 485fc |
| 25 | **Live status-meter** (reconcile-run progress backend + polling frontend) | 2026-07-15 | 080ca |
| 26 | **App-surface refinement SP1-SP7** — CFO dashboard, proof-first drawer, ambiguous-candidate suggestions, receipt-backed landing, **agentic reconciliation chat** (read + PDF-verify), **follow-up-doc ingestion** (stop dropping reply attachments) | 2026-07-15 | SP1-SP7 |
| 27 | **Self-updating rematch** (incremental re-match of unmatched + Refresh button) | 2026-07-16 | SP-rematch |
| 28 | **Human review-queue** (deterministic auto-match, demote fuzzy/LLM, resolve lane) | 2026-07-16 | review-queue A/B/C |
| 29 | **Receipt-uniqueness / bijective match** — one receipt ↔ one order, double-claim guards | 2026-07-16 | R16-R18 |
| 30 | **R1-R24 robustness sweep** — multi-page split, refund/negative class, company-paid $0 fallback, exception-aging digest, match-rate regression alert, not_a_receipt rescue, dry-run harness | 2026-07-16 | R1-R24 |
| 31 | **ORDER-SPINE (P0-P5)** — 5-table order spine, deriveOrderState fold, orderKey, classification-on-all-paths eligibility gate, re-derivation reconcile (fixed 25 false-missing), gate-then-match, sweep-correlation via orderKey/loop-UUID | 2026-07-17 | order-spine P0-P5 |
| 32 | **OCR classification cascade** — Mistral OCR for scanner/image PDFs, describe-every-page, other_document catch-all (31→1 unknown on real June) | 2026-07-18 | R25-C1/C2, v3/v4 |
| 33 | **Dashboard human-review redesign** — three actionable buckets, combined-receipt membership groups, per-row match-explain drilldown, page-anchored deep-links | 2026-07-18 | P1-P3 + D1/D2 |
| 34 | **Multi-Egnyte-links per order + orphan-vs-complete messaging + Value-delivered ROI card** | 2026-07-19 | E1/E2/E3 |

**Arc summary:** Phase-1 happy path was two workflows finished by end-April. The remaining
32 scope-growth items are almost entirely driven by *real messy client documents*: mixed/multi-
page PDFs, scanned/image receipts needing OCR, combined receipts covering multiple orders,
follow-up docs arriving as reply attachments, ambiguous duplicates, and orphan/void rows — plus
an entirely unplanned client-facing surface (dashboard + agentic chat + review queue + value
reporting). The single largest architectural growth was the **July order-spine rewrite (#31, P0-P5)**,
which replaced ad-hoc per-submission matching with a derived order state machine to kill
false-missing rows and enforce receipt uniqueness.
