# Master Plan v9 — Live-State Audit (2026-08-09)

> Method: 4 parallel read-only auditors ran the plan's own machine-checkable done-conditions
> against LIVE state (chromadb sqlite, live cron registry, tunnel/bridge status, worker SKILL.md,
> file existence). NO mutations. "Signed receipt / merged commit" was NOT trusted — only live
> evidence. Plan's self-reported LIVE STATUS block is 6 days stale (2026-08-03).
> Source plan: `knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md`.

## The one-sentence finding

**The system is ~90% code-complete and ~0% live-operational.** Every item provable by a merged
PR or a green test is done. Every item that requires a real thing to flow end-to-end — a meeting
into Multica, an approval round-tripping, an event replacing a poll, a job firing itself — has
**never happened once**. Zero meetings have ever flowed through the rail. The pilot never went live.
Then the fleet got pulled into the goal-runner/ledger rabbit hole (separate doc) and two live P1
crons silently died on Aug 5.

---

## DONE — verified live (real, not just signed)

- **P1.0** outputs-router convention doc + skill — present.
- **P1.3** org Brain fold-in — symlink resolves; **1,848 chunks / 205 of 207 files indexed**.
  (Plan's scary "0 chunks" baseline was a path-query artifact — it queried the pre-symlink path.)
- **P1.4** cxportal→index — nightly cron + 46 client files / 318 chunks indexed.
- **P1.5** agent-memory→index — 846 files / 3,285 chunks.
- **P3.0a** reverse-import + **P3.0b** dup-recovery — code + tests green (29/29 vitest).
- **P4.1①** tunnel — Cloudflare authenticated, tunnel created, launchd service running, URL set (genuinely live, not the old ad-hoc loopback).
- **P4.1②** HMAC fireflies route — real `x-hub-signature` / `createHmac` / `timingSafeEqual`.
- **P4.1④** launchd bridge service — running as managed service (pid 76455), not ad-hoc.
- **P4.1⑤ Fireflies URL registered — DONE (audit was stale-wrong; corrected 2026-08-09).** The
  first auditor grepped bridge stdout and reported "0 deliveries" — FALSE. Real deliveries hit the
  chain: **37 fireflies messages fleet-wide**, e.g. pa inbox `2-1786145694903-from-webhook-hub-godle.json`
  (Aug 6) + three on **Friday Aug 7** (11:07 / 14:02 / 16:34), each a
  `WEBHOOK fireflies meeting.transcribed — meeting <ULID>` spawning meeting-writeback-worker with FF_MEETING_ID.
  The delivery layer (Fireflies → bridge HMAC → webhook-hub → pa inbox) is genuinely live.
- **P4.3** approval⇄Multica sync — code + integration test green (NOT live-exercised).
- **P4.4** "3 signals" detector — **BUILT** (`sweep-signals` CLI + `signal-sweep.ts`). Contradicts the stale plan, which called this the only unbuilt P4 item.
- **P5-A** KILL-15 — all 15 dead crons gone from the live registry.
- **P5-C** pa briefing crons (morning-brief/evening-wrap moved frank2→pa), session-mining lane, larry upstream-sync rewired to check `grandamenium/cortextos` PRs. sage-analyst-parity (usage-monitor cron + experiments/config.json) live.
- **P7** `state/fork-deltas.md` exists; larry upstream-sync checks fork PRs.

## PARTIAL / STALE / REGRESSED

- **P1.1 nightly kb-reconcile — REGRESSED.** Built and was green (rows 12,605→13,999) but the
  cron **stopped firing after Aug 5** — no rows Aug 6–9. Live agent is `larry-codex`; the reconcile
  cron appears not to have survived the last restart. This is the recurring "crons die on
  restart / registry drift" failure mode, live right now.
- **P1.6 claude-mem exporter — REGRESSED.** Same: ingesting (12,223 chunks) but exporter ledger
  also last-green **Aug 5**, dead since.
- **P3.2 routing split — transport only.** multica-sync has 652 links but **all bus-origin; ZERO
  `meeting-pipeline` provenance**. The meeting→Multica routing has never been exercised.
- **P3.3 done-state / zombie fix** — code + test present, but never live-verified (no real re-emit run).
- **P5-B event-replace-11** — the 11 poll crons still run (correct — they're gated on P4, which isn't done). Ownership migration frank2→pa is further along than the plan text (comms-check, ff-extractor already on pa).
- **Live cron count = 83 across 12 agents** (re-baseline claimed 80; muse +3, pa/crm carry migrated meeting crons).

## NOT DONE / DROPPED

- **P1.2 deliverables fold-in (812→now 1,680 files)** — only **20 frank2 files** mirrored, no
  source→target manifest. Effectively not started.
- **P1.7 Fireflies transcripts store** — designated store `org-brain/transcripts/` = **0 files**. (Depends on P4.1 going live.)
- **P1.8 email→capture inbox** — 17 files, **all dated Jul 31** (one-time backfill). No live `mail.human` capture running.
- **P1.9 Clearpath drain/retire** — no export manifest, not attempted (gated on D5a).
- **P2 — the entire 25-job automation. This is the biggest gap.** contract-lint passes (18/18
  skills have the I/O contract), BUT **0 of the 25 jobs are wired to any live trigger.** Crons still
  run the *legacy* workers, not the P2 job skills. The 3-job spot-run wrote **synthetic fixtures**
  (TestCo/Northwind) to a scratch dir — NOT the real knowledge-sync router paths, NO structured
  bus/Multica row. "Skill installed + linted" is true for all; "job runs automatically" is false for all.
- **P3 multica-sync cron — still wired to 0 agents.** Pilot never went live.
- **P3.4 legacy-path migration — NOT DONE.** meeting-commitments-worker SKILL.md (both pa + frank2
  copies) still POSTs `$BRIEFS_INGEST_URL` + raw Telegram to Josh; **zero Multica / approval-queue
  refs.** The whole point of the rail — routing meeting output through Multica — isn't wired.
- **P4.1⑤ — DONE, moved to the verified-live list above (audit was stale-wrong).** NOT the blocker.
- **NEW REAL BLOCKER — the meeting chain delivers but does not durably FILE.** Deliveries fire and
  spawn meeting-writeback-worker, but of 4 real meetings Aug 6–7: the 3 Friday meetings left **0
  output** (no trace in pa state), and the Aug-6 one produced only bus tasks + an analytics event
  line — **NOT** a filed transcript or meeting record. transcripts store = 0, meeting-provenance
  Multica links = 0. So the front half (ingress) works; the back half (writeback → durable file →
  KB → Multica) is where the chain dies. THIS is the keystone, not the Fireflies login.
- **P4.1 other lanes** — `mail.human` (Gmail push), `slack.message`, `omi.memory`, `pr.opened`/`ci.failed`
  — **none built** in the bridge (only zoom/fireflies/ops-check integrations exist). NOTE: the
  separate "google shadow ingress" work exists but is observe-only and not wired to these lanes.
- **P6 weekly-review cadence — NOT STARTED.** 3 report files on disk (2 from the same week), at the
  wrong path (`raw/weekly-reviews/`, not the P1.0 content-type route); weekly-review prompt is NOT
  upgraded to read Multica / approval-queue / MOVEMENT report. Needs 4 consecutive.
- **cron-liveness.sh** — never shipped as a script (daemon-side `cron-state.ts` fire-recording is a de-facto partial replacement).

## Unverifiable

- **Fork PR #172** (re-baseline daemon onto upstream) merge status — `gh` returned HTTP 401 (invalid clearworks-ai token), not a read limit. Needs a valid token to confirm.

---

## The pattern (for the replan)

Three systemic reasons the plan stalled at "code-done, never-live":

1. **The chain delivers but doesn't durably file.** Ingress is live (Fireflies webhook fires on
   real meetings). The dam is the **back half**: meeting-writeback-worker spawns but doesn't land a
   filed transcript / meeting record / Multica link. So P1.7 transcripts stay 0, P3 rail stays
   untested, P3.4 migration can't be proven, P5-B event-replace can't unblock, P6 has nothing real
   to review. **Everything downstream is dammed behind the writeback/filing step, not the login.**
2. **"Done" was scored on merge/test, never on a live receipt.** Same root disease as the
   goal-runner rabbit hole: no acceptance gate ever required "a real thing flowed through the live
   system." So P2/P3 got signed off as built while 0 jobs actually run and 0 meetings route.
3. **Live crons silently die on restart.** P1.1 + P1.6 were green then went dead Aug 5 with nobody
   noticing — the exact recurring registry-drift failure mode. Any "it's automated" claim needs a
   liveness check, not a config grep.

## Suggested replan spine (in dependency order)

1. **Unblock the keystone (REVISED):** the Fireflies URL is already registered and delivering.
   Debug the **writeback back-half** — take one of Friday's delivered meeting IDs (e.g.
   `01KZF3MM897VEM5FDQN5R7HASA`), run meeting-writeback-worker on it by hand, and find why it
   produces no durable transcript/meeting file. Fix until ONE real meeting flows end-to-end and
   files (the P4 chain-trace done-condition). This lights up P1.7, P3, P3.4, P5-B at once.
2. **Fix the two dead crons** (kb-reconcile, claude-mem-export) + add a real liveness alarm so
   "automated" can't silently rot again.
3. **Wire multica-sync live** (P3.1 human round-trip) + build P3.4 (worker→Multica dual-write,
   retire BRIEFS POST + raw Telegram).
4. **P2: pick 3 real jobs and actually wire them to triggers** with real-path output + a structured
   row — prove the job loop once before claiming the 25.
5. **P1.2 deliverables fold-in** — run the router across all agents + emit the manifest.
6. **P6** weekly-review upgrade — last, once there's real Multica/approval data to review.
7. **Quarantine** the goal-runner/fanout-ledger/obf-ledger work as separate goals (see
   `state/REPLAN-original-purpose-2026-08-09.md`).
