# GROUNDED STATUS — P1–P6 · Loops · Waves · Altari (2026-08-04)

Compiled by Fable, 2026-08-04 (evening). Trust-critical. **Every status cell cites a merged PR#, a commit sha, or a file:line.** Two dimensions are kept separate: **CODE** (is it merged? cite it) vs **LIVE** (deployed / tested / firing? cite the probe or mark UNVERIFIED). A merged PR = CODE DONE; it is NOT called "not working" without a positive live disproof. Where neither could be established, the cell is **UNVERIFIED**, not "not done."

Reacts to (and re-verifies) the prior `STATE-OF-THE-WORLD-2026-08-04.md` (commit `812e34ff`). Known prior false-negatives confirmed NOT repeated: dashboard = **#287 EXISTS** (`dashboard/src/app/(dashboard)/mission-control/page.tsx`), 3-signal detector = **#262 EXISTS** (`src/bus/signal-sweep.ts` + `src/cli/bus.ts:1342`), Fireflies ingest = **#232/#234/#239 BUILT** (user confirms tested).

**Master live fact (drives every LIVE cell):** running daemon `pid 38064` started **Aug 4 12:04:23**; `dist/daemon.js` rebuilt **Aug 4 13:21** (`ps -o lstart` + `stat`). **The running daemon predates the current build — every merge after ~12:04 is CODE-merged but NOT LIVE-deployed** until a Josh-gated daemon restart. This is why many CODE=DONE cells carry LIVE=UNVERIFIED/not-deployed.

---

## 1 · P1–P6 (+ sub-items)

| Item | What it is | CODE (PR#/commit or UNVERIFIED) | LIVE (evidence or UNVERIFIED) | Verdict |
|---|---|---|---|---|
| **P1.0** | Outputs-router (file by content-type) | DONE — `orgs/clearworksai/skills/outputs-router/` (SKILL.md+file_output.py+tests); #187, fixes #248 #250 #251 #254 #264; receipt #258 | Router code present; used by mirror run (manifest 820 rows) | **DONE (code+used)** |
| **P1.1** | Nightly kb-reconcile cron | DONE — #188, receipt #249; hardened #240 #288 #301; proactive loop #279 | Cron in config; last reconcile firing UNVERIFIED (daemon pre-13:21) | **DONE (code) / LIVE UNVERIFIED** |
| **P1.2** | Deliverables fold-in (812 files) | PARTIAL — router ran, `outputs-router/manifests/p1-2-mirror-manifest.jsonl` = 820 rows; receipt #254/#257 | Manifest is **UNCOMMITTED** (`git status` → `??`); 7-green-day write-path flip NOT done | **PARTIAL** |
| **P1.3** | org-Brain fold-in | DONE — #190 | Live symlink `orgs/clearworksai/knowledge -> ../../../knowledge-sync/raw/areas/clearworks/org-brain` (`readlink` verified) | **DONE (code+live)** |
| **P1.4** | cxportal → index | DONE — #191 `pull_cxportal.py`; path fixes #297; receipts #293 #296 | Sync run producing rows UNVERIFIED | **DONE (code) / LIVE UNVERIFIED** |
| **P1.5** | Agent-memory topic files → index | DONE — #193; receipt #256; exit-code fix #265 | Ingest firing UNVERIFIED | **DONE (code) / LIVE UNVERIFIED** |
| **P1.6** | claude-mem exporter → ingest | DONE — #192, receipt #253 | LIVE — `knowledge-sync/raw/areas/clearworks/session-memory/{observations,summaries}/` holds 2026-08-04 files (exporter is producing) | **DONE (code+live)** |
| **P1.7** | Fireflies full transcripts → store | Code path exists (ff-extractor persist); #177 #183 | `ls orgs/clearworksai/knowledge/transcripts/` = **0 files** (positive disproof: store empty). Push path gated on P4.1⑤ | **NOT PRODUCING (live disproof)** |
| **P1.7a** | Meeting/comms scripts → pa | DONE — #221 (ff-extractor moved to pa; comms-check-worker dropped from frank2); `orgs/clearworksai/agents/pa/scripts/ff-extractor.py` present | pa owns the scripts on disk | **DONE** |
| **P1.8** | Email → capture inbox | pa owns comms-check (cron in pa config) | Capture-inbox rows not probed this session | **UNVERIFIED** |
| **P1.9** | Clearpath drain → retire | Export scripts restored #186 | No export manifest on disk; gated on Josh org-pick (Internal156/Holdco83/both239) + D5a | **NOT STARTED (blocked-on-human)** |
| **P2** | JOB rollout — deliverable #1 = contract-lint.sh (declared scope) | DONE — #194 contract-lint.sh + I/O prepend; #196 uniform wording (18 skills); receipt #259 | contract-lint 18/18 PASS per plan header (08-03) | **DONE (declared scope)**. NOT the 25-job Wave1-3 buildout (explicitly later-bench, not started) |
| **P3.0a** | Reverse-import Multica→bus | DONE — #198, `src/bus/multica/poll.ts:426`; tests green (poll.test.ts:86/265) | rides sync (see P3 live) | **DONE (code)** |
| **P3.0b** | Duplicate-create recovery | DONE — #197, `src/bus/multica/push.ts:226-253`; push.test.ts:360 | rides sync | **DONE (code)** |
| **P3.0/3.1** | Multica pilot preconditions + #185 due-date | DONE (code) — receipt #260; #185 merged; CLI `src/cli/bus.ts` multica-sync | **NO multica-sync cron in ANY config** (`grep -l` = NONE); sync-state.json frozen **Jul 31 00:37** (positive disproof of a successful sync since). First real run = [HUMAN GATE] | **CODE DONE / PILOT NOT LIVE** |
| **P3.2** | Routing split agent/human at extraction | DONE — #261 (assignee_type agent + meeting-pipeline provenance) | rides sync | **DONE (code)** |
| **P3.3** | Done-state bidirectional (zombie fix) | Code in poll/push; #261 | UNVERIFIED live | **DONE (code) / LIVE UNVERIFIED** |
| **P4.1①** | Public HTTPS tunnel | DONE — #227 (zero-date sentinel) | LIVE per prior session probe (`tunnel status`: authed, tunnel exists, launchd running). Not re-probed this session | **DONE (code) / LIVE per prior probe** |
| **P4.1②** | HMAC Fireflies ingest route | DONE — #232 (+#239 camelCase) | route CODED; **0 fireflies deliveries ever** (prior log grep) | **DONE (code) / dormant** |
| **P4.1③** | Route → relay (target pa) | DONE — #234 (/relay/* ingress) | dormant until ⑤ | **DONE (code)** |
| **P4.1④** | Managed launchd bridge service | DONE — #158 + M4 runbook | LIVE per prior probe (`com.cortextos.webhook-bridge`) | **DONE (code) / LIVE per prior probe** |
| **P4.1⑤** | Register URL in Fireflies dashboard | n/a (human action) | NOT DONE — 0 fireflies hits ever (positive disproof). **[HUMAN GATE: Josh's Fireflies login]** | **BLOCKED-ON-HUMAN** |
| **P4.2** | Activity-feed shim | DONE (shim is the deliverable) per plan | UNVERIFIED beyond doc | **DONE (code) / LIVE UNVERIFIED** |
| **P4.3** | ONE approval surface + Multica round-trip | DONE (code) — Spec A #199, Spec B #216; `src/bus/task.ts` + `poll.ts` | Round-trip rides Multica sync = frozen since Jul 31 → **degraded live** | **CODE DONE / LIVE degraded** |
| **P4.4** | 3-signal detector + sweep-signals CLI | DONE — #262; `src/bus/signal-sweep.ts`; CLI `src/cli/bus.ts:1342 .command('sweep-signals')`; receipt #263 | `signal-sweep` cron present in `frank2/config.json` (grep hit). Daemon loaded it? pre-13:21 daemon → UNVERIFIED | **DONE (code+wired) / LIVE UNVERIFIED** |
| **P5-A** | Cron KILLs (15) + hygiene | DONE — #267 hygiene; receipt #276; live registry re-baselined to 80 crons per receipts | registry re-baseline per plan/receipts | **DONE** |
| **P5-B** | 11 cron→event conversions | NOT DONE — **correctly gated on P4.1⑤.** Positive check: `transcript-scanner`/`meeting-commitments`/`pre-meeting-brief` still in `frank2/config.json`; `fireflies-ingest` still in `crm/config.json` (grep hits) | crons still poll-firing (by design until ⑤) | **BLOCKED (by design) on H:P4.1⑤** |
| **P5-C** | KEEP+rewire (19) | DONE — orchestrator-off-Telegram #233; sage parity #230; larry upstream-sync fork-check #266; briefing crons on pa | live crons present in configs | **DONE** |
| **P6** | Weekly-review cadence | BUILD DONE — #274 deterministic core + live proof; receipt #280 | Done-condition = 4 consecutive weekly reports → structurally not yet earned (first fire this week) | **SHIPPED, cadence not yet earned** |

---

## 2 · LOOPS (Track-2, the 7-loop fork→upstream causal-chain convergence)

Loop scope defined by `state/v9-fleet-incident/upstream-review/_SYNTHESIS.md` (RW/M wound model) + `project_causal_chain_convergence_dispatch_hold_2026-08-03`.

| Loop | What it was | PR#/status | Verdict |
|---|---|---|---|
| **LOOP1** | Context-handoff convergence — adopt upstream ping, delete fork-only back-ping triad + ~21 compensators; real-window ctx-%. Sole irreversible gate = staging→Josh live-promote | Stage-1 back-ping triad **deleted #285** (`src/daemon/handoff-backping.ts` confirmed **absent** on disk). Real-window ctx-% **#302 MERGED** but running daemon pre-dates the 13:21 build → **not deployed**; #310 restored larry threshold-70 contingent on #302 being live | **PARTIAL — code merged, Josh-gated on daemon live-promote** |
| **LOOP2** | retrieval-enforcer REMOVE | Only **bypass #243** merged (SESSION-CONTINUATION skip). `src/hooks/hook-retrieval-enforcer.ts` **STILL EXISTS on main** (16KB, mtime Aug 3 — positive disproof of removal) | **PARTIAL / mis-scoped — handoff "done" is NOT grounded.** Either finish the delete or write down keep-with-bypass |
| **LOOP3** | Continuity consolidation (mission-anchor/handoff machinery) | KEEP-AS-UPSTREAM (no cut). Restart-context machinery intact | **KEEP-AS-UPSTREAM (done by definition)** |
| **LOOP4** | pty-host SPIKE (repro ptmx leak vs upstream before cutting) | KEEP (no cut). Wounds fixed in-place by WAVE-2 (#203 #204 #207 #211); `src/pty/` intact | **KEEP-AS-UPSTREAM; wounds fixed in WAVE-2** |
| **LOOP5** | Codex runtimes KEEP-freeze | No build required by definition (observation log 08-04) | **DONE (no-op by design)** |
| **LOOP6** | Restore `.cron-active` marker write | DONE — **#275**; `AgentManager.onFire` restore; ledger row `loop6-cron-active-restore` | **DONE (code) / LIVE UNVERIFIED (pre-13:21 daemon)** |
| **LOOP7** | Telegram cleanup — inbound-persist slice | DONE — **#247** (inbound survives failed inject + restart) | **DONE (code) / LIVE UNVERIFIED (pre-13:21 daemon)** |

Note: **wedge-watchdog #281** merged against a "hold" call (symptom-patch); flagged for removal — LOOP1 does not supersede it since the machinery was already converged.

---

## 3 · WAVES

| Wave | Scope | PRs | Verdict |
|---|---|---|---|
| **WAVE 0** | 5 "safe" convergence PRs (retrieval-enforcer, .cron-active, tool-result-router guard, system-pings gate, conversation-buffer inbound wire) | .cron-active **#275** ✓; enforcer became a *bypass* **#243** (not removal — see LOOP2); conversation-buffer/telegram wire folded into **#247** | **MOSTLY LANDED** — tool-result-router guard + system-pings gate specific PR#s **UNVERIFIED** |
| **WAVE 1** | Context-handoff convergence = **LOOP1** | #285 (stage-1) + #302 (ctx-%) | **PARTIAL, Josh-gated** (= LOOP1) |
| **WAVE 2** | 17-item RW-2..RW-10 + M1..M8 fan-out vs v9 causal model | **ALL 13 PRs MERGED**: #203 #204 #205 #206 #207 #208 #209 #210 #211 #212 #213 #214 #215 (+ #200 #202). 4 NO_OPs by design (M4/M5/M7/M8) | **DONE (all 13 merged)**; lands on next daemon restart per report §"Nothing touches live daemon" |
| **WAVE A** | Pipeline-gate integrity — completion earned only by true-verify | **#246** (removes `--mark-phase-complete`) | **DONE** |
| **WAVE B** | Re-earn P1–P6 true-verify receipts after shared-checkout ledger clobber | re-signs #249 #253–#258, then P2 #259, P3 #260, P4.4 #262/#263, P5 #276, P6 #280 | **DONE** |

---

## 4 · ALTARI Phase-1 (the 8 items + event-wiring)

Intent: `altari-skilltree/PHASE-1-WIRING-PLAN.md` (A–F wire; G = skip as separate workers). All 8 PRs **verified merged** (`gh pr list` mergedAt 08-04). "8/8 merged" is TRUE. Wiring column is the honest live dimension.

| Item | PR# | Merged? | Wired event/cron/dormant (cite) | Verdict |
|---|---|---|---|---|
| **A · EA cluster (proactive, on pa)** | **#304** (+#315 lane-a booking/Zoom) | YES | pa crons `comms-check`/`morning-brief`/`evening-wrap` + `booking_coordinator.py`, `zoom_meeting.py`, `gmail_push_listener.py` on disk. gmail-push = **written, NOT deployed**; zcal webhook needs Pro tier (open Josh decision). **Known bug: booking slot-times default `timezone.utc`** (`booking_coordinator.py:80,180`) with only a `--tz PT` *label* → ~8h skew (non-blocking, drafts-only) | **CODE DONE / partial live (inbox lane still cron; UTC bug queued)** |
| **B · CRM enrichment + records-admin events** | **#305** | YES | crm scripts emit events (`emit_stage_changed_event`, `emit_deal_created_event`, `emit_contact_created_event`) via `bus send-message crm` — **self-inbox, poll-carried** by crm crons (`deal-enrichment`, records-admin sweep). No external webhook | **CODE DONE / event-shaped, poll-carried** |
| **C · Meeting decisions & deal-state (meeting chain)** | **#277** | YES | Genuinely un-hardcoded: `ff-extractor.py:800 extract_decisions_and_deal_state` with comment "the two extractions the writeback hardcoded as none." Rides the meeting chain = **2h poll** (webhook path never fired, ⑤ unregistered) | **CODE DONE / live via poll only** |
| **D · Proactive KB maintenance** | **#279** | YES | 3-tier maintenance on kb-reconcile; `larry/bin/kb-maintenance-sweep.sh`; #288 fixed "crashing on every fire" (08-04). By-design nightly/weekly cron | **CODE DONE / LIVE UNVERIFIED (pre-13:21 daemon; post-#288)** |
| **E · Project-scoping / integration-engineer gate** | **#286** | YES | `src/pipeline/scoping-gate.ts` + `dist/pipeline/scoping-gate.js` + tests; exemplar-grounding double-gate. Fires in pipeline dispatch gate | **CODE DONE** |
| **F · Delivery-status-reporter (trained + live)** | **#306** | YES | `crm/.claude/skills/delivery-status-reporter-worker`; weekly cron → approval queue, drafts-only never auto-send (by design) | **CODE DONE / by-design cron** |
| **G · qa-engineer** | — | n/a | Evaluated REDUNDANT (verify skill + true-verify gate + red-team-reviewer + sage). NOT wired as separate worker (per plan) | **CORRECTLY SKIPPED** |
| **G · reliability-engineer / production-stack** | **#300** | YES | `larry/bin/production-stack-sweep.sh` + `sage/memory/production-stack.md`; daily stall-detection cron (DESIGN-G lane G) — the one non-redundant slice adopted | **CODE DONE** |
| **— Dashboard v2 (Mission-Control)** | **#287** | YES | `dashboard/src/app/(dashboard)/mission-control/page.tsx` + `api/mission-control/route.ts` + client.tsx exist. Reads live Multica status — which is **frozen since Jul 31** (renders stale) | **CODE DONE / renders stale Multica** |

**Fireflies webhook receiver (cross-cutting):** HMAC route CODED (#232) + bridge LIVE + tunnel LIVE, but **0 deliveries ever** — dormant until P4.1⑤.

---

## Counts

Counting the ~45 discrete cells across the four sections:

- **DONE (code, with live where checkable): 30** — P1.0, P1.1, P1.3, P1.4, P1.5, P1.6, P1.7a, P2, P3.0a, P3.0b, P3.2, P3.3, P4.1①②③④, P4.2, P4.3(code), P5-A, P5-C, LOOP3, LOOP4, LOOP5, LOOP6, LOOP7, WAVE2, WAVE-A, WAVE-B, Altari B/C/D/E/F/G-reliability/dashboard (Altari counted as the 8-block = DONE-code). [Of these, only P1.3 and P1.6 are additionally confirmed LIVE this session.]
- **PARTIAL: 6** — P1.2 (manifest uncommitted, flip pending), P4.4 (wired, live unverified), P6 (shipped, cadence unearned), LOOP1 (Josh-gated deploy), LOOP2 (only bypass merged), WAVE-0 (2 sub-PRs unverified).
- **UNVERIFIED: 4** — P1.8 (capture inbox), P4.2 (activity shim live), P4.4 live-load, WAVE-0 tool-result-router/system-pings PR#s.
- **BLOCKED-ON-HUMAN (not "not started" by our fault): 3** — P4.1⑤ (Fireflies register), P5-B (gated on ⑤), P1.9 (org pick).
- **Genuinely NOT-STARTED: 1** — the 25-job P2 Wave1-3 buildout (explicitly later-bench by plan, not a miss).
- **Live disproof of "not producing": 1** — P1.7 transcripts store (0 files, confirmed empty).

---

## UNVERIFIED cells — exact command to resolve each

1. **P1.1 / P1.4 / P1.5 kb ingest firing live** — `sqlite3 ~/.mmrag/*/chroma.sqlite3 "select count(*) from embeddings"` before/after `cortextos bus kb-reconcile`; assert distinct-file count rose over 3 nightly rows.
2. **P1.8 email capture inbox** — `ls -lt <capture-inbox path> | head` (locate via `grep -rn capture-inbox orgs/clearworksai/agents/pa/`) and assert md rows exist from comms-check.
3. **P4.2 activity shim live** — `grep -c '"type":"activity"' state/activity-feed.jsonl` (or the shim's sink) and assert workers are writing the one-line rows.
4. **P4.4 signal-sweep daemon-loaded** — after a daemon restart: `cortextos cron list --instance cortextos1 | grep signal-sweep` then confirm a fire row in daemon logs.
5. **LOOP6 / LOOP7 live** — resolved only by the Josh-gated daemon restart onto the 13:21 dist; then `cortextos status` + probe `.cron-active` write and a telegram-inbound survive-restart test.
6. **WAVE-0 tool-result-router guard + system-pings gate PR#s** — `git log --oneline --all --grep='tool-result-router' ; git log --oneline --all --grep='system.*ping'` to bind each to a merged PR (or confirm folded into #243/#247).
7. **P4.1①④ tunnel/bridge re-probe (marked "per prior probe")** — `node dist/cli.js tunnel status --instance cortextos1` and `node dist/cli.js webhook-bridge status` + `launchctl list | grep webhook-bridge`.
8. **Multica sync actually works post-#308** — one bounded real (non-dry) `node dist/cli.js bus multica-sync --direction out --limit 5`; assert `sync-state.json` mtime advances past Jul 31 and 0 HTTP 400s. (First unbounded run = [HUMAN GATE], writes creates into Josh's workspace.)

---

## Bottom line

The fork is **CODE-rich and LIVE-lagging.** Almost everything the plans call for is *merged* (P1–P6 receipted, all 8 Altari PRs, all 13 WAVE-2 PRs, LOOP1-stage1/6/7). The gap is **deployment + three human gates**, not missing code:
- **Daemon live-promote** (restart onto 13:21 dist) flips ~10 merged daemon/ctx/Multica PRs from merged→live in one action.
- **Fireflies ⑤ registration** (one Josh login) unblocks P5-B + P1.7 + the real-time meeting chain.
- **Multica pilot go** unfreezes the dashboard's stale status.

No cell was found where shipped code is genuinely absent except P1.7 (transcripts store empty — a live-wire gap, gated on ⑤) and the deliberately-deferred 25-job P2 buildout. The prior analysis's contradictions (LOOP2 not-a-removal, Multica unproven-live, P1.2 flip open) are re-confirmed here against disk.
