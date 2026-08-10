---
title: v9 Finish & Execute
repo: /Users/joshweiss/code/cortextos
base-branch: main
mockup: N/A — backend only
version: 1
date: 2026-08-09
---

# SPEC — v9 Finish & Execute (grounded, 2026-08-09)

**Target repo:** `/Users/joshweiss/code/cortextos` (single-machine fleet; live runtime `~/.cortextos/cortextos1`).
**Constitution (invariants):** atomic writes (`src/utils/atomic.ts`); no external runtime deps beyond package.json; custom code in `orgs/`/`community/`/config, any `src/` change = fork-delta + upstream-PR candidate (P7); every automated claim proven by a LIVE receipt, not config presence.
**UI surface:** none — backend/daemon/cron/worker only. **Mockup gate N/A (recorded decision).**
**Scope:** Tracks B, A (+P3.4 triple-sink), C2 (Multica teardown), E (gsuite-first), D (retire polls), CRM autonomous cluster, solution-design 5-stack (on-demand hardening). Multica is CUT.
**Sources:** state/FINISH-PLAN-v9-2026-08-09.md, altari-wiring-scope-2026-08-09.md, AUDIT + REPLAN (2026-08-09).

---

## Grounding Ledger (probed live this session)

| ID | Claim | Probe | Evidence | Verdict |
|----|-------|-------|----------|---------|
| G-01 | Programmatic worker spawn exists (no LLM needed) | grep cli/daemon | `spawn-worker` cmd `cli/workers.ts:6`; `agentManager.spawnWorker(name,dir,prompt,parent,model)` `agent-manager.ts:1245`; IPC `ipc-server.ts:665` | VERIFIED |
| G-02 | Bus supports human tasks | `list-tasks` + grep | `create-task --assignee <a> --needs-approval` `bus.ts:512,516`; `[HUMAN]`/`assignee:'human'` `approval.ts:212`,`signal-sweep.ts:244`; 10 live `[HUMAN]` tasks | VERIFIED |
| G-03 | Approval-card CLI exists | grep bus.ts | `create-approval <title> <category> [context]` `bus.ts:2338`; categories external-comms/financial/deployment/data-deletion/other | VERIFIED |
| G-04 | Webhook-bridge live: tunnel+HMAC+launchd | `tunnel status`, `webhook-bridge status`, grep | Cloudflare auth OK, tunnel `27754b3f…`, launchd running; `x-hub-signature`+`createHmac`+`timingSafeEqual` `webhook-bridge.ts:92-96,571-580`,`281` | VERIFIED |
| G-05 | Fireflies delivers real meetings | inbox scan | 37 fireflies msgs; pa inbox `WEBHOOK fireflies meeting.transcribed` Aug 6 + 3× Fri Aug 7 | VERIFIED |
| G-06 | Meeting spawn = NL nudge to pa LLM (not deterministic) | read relay | `buildRelayMessage` `webhook-bridge.ts:287` emits "cd pa … spawn meeting-writeback-worker"; no programmatic spawn on the event | VERIFIED |
| G-07 | Writeback not filing | ledger read | `ff-full-writeback-surfaced.txt` = 1 line, last Aug 4; 0 Aug 6-7 meetings filed; transcripts store 0 | VERIFIED |
| G-08 | ff-extractor extraction works | live run (read-only, /tmp) | 3 non-suppressed Fri/Aug6 IDs → `meetings:1` each, rc=0 | VERIFIED |
| G-09 | Marcos suppression = bug, now fixed | grep+run | `SUPPRESSED_NAMES=()` in all 3 copies; Marcos meeting now `meetings:1 suppressed:0` | VERIFIED |
| G-10 | Crons die silently on the codex cutover | cron-state read | larry cron-state: kb-reconcile/claude-mem-export last-fire Aug 5; many larry crons stale weeks; running proc is larry-codex | VERIFIED |
| G-11 | Multica = pure bus mirror; teardown targets | grep + sync-state | `triggerMulticaMirror` `bus.ts:540/593/677/719`; `multica-sync-inbound` cron on larry (died Aug 6); sync-state 558 links, 555 bus-origin, 0 meeting | VERIFIED |
| G-12 | Gmail/Calendar ingress = shadow only | audit #324 | shadow observe/propose, no worker wake, poll not retired; activation point confirm at build | PARTIAL |
| G-13 | comms-check-worker skill exists (EA triage entry) | find | SKILL.md present (crm-codex plugin + others) | VERIFIED |
| G-14 | CRM/EA/5-stack skills present, unwired | audit + find | skill+I/O-contract present; 0 wired to live trigger; crons run legacy workers | PARTIAL |
| G-15 | daemon cron scheduler reads crons.json, reloadable | grep daemon | auto-migrate config→crons.json + `reloadCrons()` `agent-manager.ts:620,1355` | VERIFIED |

No FALSE verdicts. PARTIALs (G-12/G-14) resolved as bucket-B build steps with in-FR investigation; no blocking user clarifications (all scope decided this session).

---

## Requirements (grouped by track; each FR: EARS criterion · bucket · reason)

### Track B — Cron liveness (stop the bleeding)
- **FR-B1** System MUST restore `kb-reconcile-nightly` + `claude-mem-export` firing under the running (`-codex`) agent. *WHEN the daemon runs the live agent THE SYSTEM SHALL fire both crons on schedule and append a fresh ledger row within one interval.* **Bucket B** — scheduler + reloadCrons exist (G-15); death cause = codex-cutover registry drift (G-10).
- **FR-B2** System MUST disable the `multica-sync-inbound` cron (Multica cut). *WHEN crons are listed THE SYSTEM SHALL show no enabled multica cron.* **Bucket A**.
- **FR-B3** System MUST detect a cron that has not fired within N× its interval and emit one alert row. *WHEN a cron's last-fire age exceeds its interval×N THE SYSTEM SHALL log a stale-cron event.* **Bucket B** — `last_fired_at`/`fire_count` exist in cron-state (G-10/G-15).

### Track A — Meeting suite files durably (backbone)
- **FR-A1** System MUST spawn the meeting-writeback worker **deterministically (daemon-side)** on a verified fireflies `meeting.completed`, not via an LLM nudge. *WHEN an HMAC-verified fireflies webhook arrives THE SYSTEM SHALL call `spawn-worker` for the writeback worker with `FF_MEETING_ID` and record a spawn receipt.* **Bucket B** — `spawnWorker` + IPC exist (G-01); replaces NL relay (G-06).
- **FR-A2** System MUST resolve the worker's script/state/output dir to the RUNNING agent (`pa-codex`), not a hardcoded `/agents/pa/`. *WHEN the worker runs under pa-codex THE SYSTEM SHALL read/write that agent's dir.* **Bucket B** — SKILL hardcodes pa path.
- **FR-A3** System MUST durably file each processed meeting to `knowledge/meetings/*.md` + client writeback + append the writeback ledger. *WHEN a non-suppressed meeting is extracted THE SYSTEM SHALL produce a meeting file, a client history entry, and a ledger line.* **Bucket B** — writer exists in SKILL Step 3; currently not reached (G-07).
- **FR-A4** System MUST backfill previously-suppressed / unfiled meetings (incl. Marcos) once A1–A3 are green. *WHEN backfill runs over past FF_MEETING_IDs THE SYSTEM SHALL file each not already in the ledger.* **Bucket B** — extractor supports `--meeting-id` (G-08/G-09).
- **FR-A5** Meeting suite skills (call-prep before via calendar; deal-debrief + followup-coordinator after) MUST fire autonomously off the chain. *WHEN a meeting completes (or is ~45min out) THE SYSTEM SHALL run the corresponding suite skill and emit its output via FR-A6 sinks.* **Bucket B** — skills present (G-14); wire to the FR-A1 spawn + calendar event.

### P3.4 — Commitments fan out to THREE sinks (folds into A)
- **FR-A6** System MUST send each extracted commitment to ALL of: (1) Telegram, (2) a **bus human task** (`create-task --assignee human`, `--needs-approval` for client-visible → approval card), (3) the existing BRIEFS POST. *WHEN a commitment is extracted THE SYSTEM SHALL create/refresh one bus human task AND POST to BRIEFS AND surface via Telegram, idempotently by a single deterministic commitment id.* **Bucket B** — bus APIs exist (G-02/G-03); BRIEFS POST exists; ADD the bus sink, KEEP BRIEFS+Telegram (do NOT retire).

### Track C2 — Multica teardown
- **FR-C1** System MUST stop the real-time bus→Multica mirror. *WHEN a bus task is created/updated/claimed/completed THE SYSTEM SHALL NOT call the Multica mirror.* **Bucket B** — remove/no-op `triggerMulticaMirror` at `bus.ts:540/593/677/719` (G-11).
- **FR-C2** System MUST archive (not delete) Multica code/secrets for possible reversal. *WHEN teardown completes THE SYSTEM SHALL retain `src/bus/multica` + secrets in an archived path.* **Bucket B**.

### Track E — Provider surfaces (GSUITE FIRST)
- **FR-E1** System MUST activate the Gmail push lane: an authenticated Gmail push deterministically spawns the comms-check triage worker (feeds the EA cluster). *WHEN a Gmail push notification is verified THE SYSTEM SHALL `spawn-worker` the comms-check triage with the history delta.* **Bucket B** — shadow ingress merged (G-12); reuse FR-A1 spawn pattern; confirm exact shadow→active switch at build.
- **FR-E2** System MUST activate the Calendar watch lane (feeds call-prep / booking). *WHEN a calendar watch fires THE SYSTEM SHALL spawn the relevant worker.* **Bucket B**.
- **FR-E3** System MUST build the Slack lane (full workspace, D5b), THEN omi + pr/ci — in that order after gsuite. *WHEN a slack/omi/pr event arrives THE SYSTEM SHALL spawn its worker.* **Bucket C** — slack/pr lanes not built; omi handler in legacy clearpath (repoint).

### Track D — Retire poll crons (after A+E lanes live)
- **FR-D1** System MUST disable each poll cron whose event lane is proven live, keeping one weekly safety-sweep. *WHEN an event lane has fired live for the gated period THE SYSTEM SHALL disable its old poll cron and assert only one version fires.* **Bucket B** — the remove-old-cron rule.

### CRM autonomous cluster
- **FR-CRM1** System MUST run data-enrichment-specialist + records-administrator + pipeline-operations-manager autonomously under the `crm` agent. *WHEN a crm event/schedule fires THE SYSTEM SHALL run the skill (not the legacy cron) and emit via FR-A6 sinks where a human task results.* **Bucket B** — skills present (G-14); crons run legacy.

### Solution-design 5-stack (on-demand hardening — NOT autonomous)
- **FR-S1** System MUST provide a single on-demand invoke that chains integration-engineer → proposal-writer → pricing-analyst (+ deal-room-producer, solutions-engineer producers) into a coherent quoting output, quality/consistency high enough to delegate to a human. *WHEN Josh invokes the solution-design flow THE SYSTEM SHALL produce a consistent quote/solution artifact from one entry point.* **Bucket B** — skills present; deliverable = pipeline coherence + quality, not event wiring. Trigger = Josh-driven on-demand (explicitly not autonomous).

---

## Feasibility summary
Bucket A: FR-B2. Bucket B (existing code, wire/fix): B1, B3, A1-A6, C1, C2, E1, E2, D1, CRM1, S1. Bucket C (new): E3 (slack/omi/pr lanes). **Zero bucket D** — the backbone (`spawnWorker`) and the bus human-task/approval surfaces already exist. No net-new external infra.

## Risks
1. Codex-cutover cron drift (G-10) may recur on the next restart — FR-B3 liveness alarm is the mitigation, must land in Track B.
2. Deterministic spawn (FR-A1) is a `src/` change → fork-delta + upstream-PR candidate (P7 invariant).
3. Triple-sink idempotency (FR-A6): one deterministic commitment id must dedup across all 3 sinks or re-runs duplicate.
4. Gmail activation exact switch (G-12) unverified in code — confirm at build before flipping (shadow→active must not double-fire the 45m poll before FR-D1 retires it).

## Planner adapter notes (for /goalify)
Execution order (hard sequence): **B → A(+A6) → C2 → E(gsuite→slack→omi/pr) → D → {CRM1, S1, P1.2 fold-in in parallel} → H(weekly review)**. Each track's DONE = a LIVE receipt (a real fire/file/spawn on the running daemon), never config presence. Staging/verify gate per track before advancing. Only human-gate: P7 #172 merge + valid clearworks-ai gh token. Quarantine (not this goal): goal-runner / fanout-ledger / obf-ledger.
