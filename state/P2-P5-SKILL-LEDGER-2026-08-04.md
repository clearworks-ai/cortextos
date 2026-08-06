# P2 + P5 Source-Verified Skill/Cron Accountability Ledger — 2026-08-04

> Every cell cited to a source file:line or a live command run this session. Zero guessing.
> Question per item: DETERMINISTIC or LLM? old cron KILLED? EVENT-based now? OUTPUT artifact? did the plan actually happen?
>
> **Authoritative item lists** from `~/code/knowledge-sync/raw/areas/clearworks/altari-skilltree/MASTER-BUILD-PLAN.md`:
> - P2 = "The JOB rollout" §147-212 (25-job priority ladder, Wave 0-3 tables :159-194).
> - P5 = the P5-A kill (:261-270), P5-B event-replace (:276-290), P5-C keep+rewire (:292-312), P5-D non-priority (:317-330).
>
> **Live cron source** = `~/.cortextos/cortextos1/.cortextOS/state/agents/<agent>/crons.json` (the daemon registry — authoritative per re-baseline note MASTER-BUILD-PLAN.md:344-350; config.json is retired as ledger unit). Total live = **80 enabled crons / 12 agents** (live `python3` count this session — matches :347 re-baseline target of 80).

---

## 1 · P2 JOB ROLLOUT TABLE

P2's actual delivered scope was **skill-wiring + I/O contract + contract-lint gate**, NOT autonomous 24/7 job workers. The 25 jobs collapse to **18 unique skills** (many jobs share a skill). `contract-lint.sh` ran live this session: **18 PASS / 0 FAIL, exit 0** (`orgs/clearworksai/agents/larry/bin/contract-lint.sh` — note: NOT the plan-declared path `orgs/clearworksai/scripts/contract-lint.sh` :203, which does not exist).

| Job (playbook) | Skill | Intended tier | ACTUAL now (source) | Fires as | OUTPUT (dated artifact / UNVERIFIED) | PLAN-HAPPENED? |
|---|---|---|---|---|---|---|
| Call Capture / Transcript Processing | meeting-intelligence-engineer | AUTONOMOUS | Skill wired w/ I/O contract (`orgs/clearworksai/skills/meeting-intelligence-engineer/SKILL.md` has `I/O Contract` heading — grep hit; contract-lint PASS). Real trigger still = 2h poll (`ff-extractor.py`), push path NOT live (§161 v8 honesty; webhook 0 events — see P5-B) | LLM worker (interim poll) | `brief-feed.json` mtime Aug 4 08:03; `meeting-commitments-last.txt` Aug 4 13:47 (pipeline live via poll) | PARTIAL (skill+contract YES; autonomous push NO) |
| Context Maintenance | knowledge-base | AUTONOMOUS | contract-lint PASS; `knowledge-base/SKILL.md` has I/O contract. Nightly reconcile now LIVE: `larry/kb-reconcile-nightly` cron enabled=true (state crons.json) | LLM cron (larry, 24h) | kb-reconcile cron runs nightly (P1.1) | YES (skill wired + reconcile cron live) |
| Post-Call Debrief / Follow-Up Drafting | deal-debrief-analyst | ASSISTED | contract-lint PASS | on-demand skill | UNVERIFIED (no dated debrief artifact found this session) | PARTIAL (wired, no live-fire proof) |
| Meeting Follow-Ups | followup-coordinator | ASSISTED | contract-lint PASS; `followup-coordinator/SKILL.md` has I/O contract | on-demand skill | `alloi/alloi-followup-2026-07-29.md` (real dated followup artifact) | YES (wired + artifact) |
| Pre-Call Briefing | call-prep-researcher | AUTONOMOUS | contract-lint PASS; `frank2/pre-meeting-brief-page` publishes `/tmp/pmb-brief.md` through `briefs/publisher/publish_brief.py` and sends the curl-verified URL; see `state/SKILL-OUTPUT-PATH-REGISTRY.json` | LLM cron (calendar-scan) | Verified published URL. No durable local output from the worker; `calasia-callbrief-2026-08-05.md` is separate P1 router spot-run evidence and does not prove the global `outputs/call-prep-researcher/` path | PARTIAL (worker publishes; declared file path UNVERIFIED) |
| Email Triage | inbox-manager | ASSISTED | contract-lint PASS | on-demand / comms-check lane | UNVERIFIED (triage output not separately located) | PARTIAL |
| Proposal Generation | proposal-writer | ASSISTED | contract-lint PASS | on-demand skill | UNVERIFIED | PARTIAL (wired, no live-fire proof) |
| Pricing Support | pricing-analyst | ASSISTED | contract-lint PASS | on-demand skill | UNVERIFIED | PARTIAL |
| Status Updates | delivery-status-reporter | ASSISTED | contract-lint PASS; PHASE-1-WIRING-PLAN.md:35 marks this "trained + live" | on-demand skill | `alloi/status-update-2026-08-03.md`, `oakrootsaccounting-status-2026-08-03.md` (real dated) | YES (wired + artifacts) |
| Kickoff Pack | client-onboarding-manager | ASSISTED | contract-lint PASS | on-demand skill | UNVERIFIED | PARTIAL |
| Invoice Gen / Payment Tracking / Collections | billing-manager | ASSISTED/AUTO | contract-lint PASS | on-demand skill (Moxie) | UNVERIFIED | PARTIAL |
| CRM Hygiene / Pipeline Reporting / Forecasting | pipeline-operations-manager | AUTO/ASSISTED | contract-lint PASS | on-demand skill | UNVERIFIED (crm agent has live pipeline.json but not attributable to this skill firing) | PARTIAL |
| CRM Sync | records-administrator | ASSISTED | contract-lint PASS. PHASE-1-WIRING-PLAN.md:16 wants it "automatic/unattended" — Phase-1 aspiration, NOT proven firing on its own | on-demand skill | UNVERIFIED | PARTIAL (wired; auto-fire = NO) |
| Portal Sync | client-portal-manager | ASSISTED | contract-lint PASS | on-demand skill | UNVERIFIED | PARTIAL |
| Health Scoring / QBR Prep / Renewals | customer-success-manager | AUTO/ASSISTED | contract-lint PASS | on-demand skill | UNVERIFIED | PARTIAL |
| Company Deep-Dive | company-research-analyst + vertical-analyst | AUTONOMOUS | contract-lint PASS (both) | on-demand skill | UNVERIFIED | PARTIAL |
| SOP Generation | playbook-writer | ASSISTED | contract-lint PASS | on-demand skill | UNVERIFIED | PARTIAL |

**P2 verdict:** The declared P2 done-condition (MASTER-BUILD-PLAN.md:208 — `contract-lint.sh` exits 0 across the rollout skills) is **VERIFIED PASS (18/18, exit 0)**. The `:6` "P2 skills rollout DONE" claim is TRUE **for the skill-wiring + contract layer**. It is NOT true for "jobs run autonomously" — most are wired on-demand skills with no live-fire artifact. §9-10 of the plan already flags this: the "full 25-job Wave1-3 job-automation buildout... is separate, later-bench work, not started."

---

## 2 · P5 CRON LEDGER TABLE

### P5-A · KILL-now (15) — MASTER-BUILD-PLAN.md:261-270

Verified by grepping every live `state/agents/*/crons.json` for each name (absent/enabled=false → killed).

| Agent | Cron(s) | Old cron KILLED? (live grep) | PLAN-HAPPENED? |
|---|---|---|---|
| hunter | heartbeat, pipeline-scan, pipeline-scan-weekly | KILLED — `hunter/crons.json` = EMPTY (0 crons); grep `pipeline-scan` = ABSENT fleet-wide | YES |
| automator | heartbeat | KILLED — `automator/crons.json` = EMPTY | YES |
| opencode | heartbeat | KILLED — `opencode/crons.json` = EMPTY | YES |
| maven | daily-personal-nudge, evening-personal-check | KILLED — grep both = ABSENT; maven now only `heartbeat` + `daytime-heartbeat` | YES |
| frank2 | forgot-anything, os-capability-scan, todoist-health-check, theta-wave(dup), daily-improvement-dispatch, milestone-check, midday-blockers | KILLED — grep ALL 7 = ABSENT fleet-wide | YES |
| larry | passive-heartbeat | KILLED — grep = ABSENT | YES |

**P5-A verdict: 15/15 KILLED — fully executed.** All kill-target names absent from the live registry. Matches D3 SIGNED OFF (:354).

### P5-B · Priority-job crons — EVENT-replace when the wire exists (11) — MASTER-BUILD-PLAN.md:276-290

The core question. **Event RECEIVER infra now EXISTS** (built since v8): webhook-bridge launchd service **running** (`webhook-bridge status` live = "Service (launchd): running, Health ok"); tunnel authenticated + created + running (`tunnel status` live: tunnel `27754b3f...` exists, Cloudflare auth OK); HMAC verify code present (`src/cli/webhook-bridge.ts:92` `hmacSignatureMatches`, :574 checks `x-hub-signature`); `fireflies` in `ALLOWED_INTEGRATIONS` (:23); gmail push receiver file exists (`orgs/clearworksai/agents/pa/scripts/gmail_push_listener.py` + `.plist`).

**BUT — event NOT LIVE / delivering:** webhook-bridge log (`~/.cortextos/logs/webhook-bridge-run.log`) shows only "listening", **0 fireflies/relay/POST hits** (grep count = 0) — the Fireflies webhook URL is unregistered (P4.1⑤ HUMAN GATE, Josh's Fireflies login, §18). gmail_push_listener is **NOT loaded in launchctl** and **no process running** (`launchctl list | grep gmail` = empty; `pgrep gmail_push_listener` = none). **Per the plan's own rule (:280 "until then they KEEP running") and the prompt's rule (receiver exists + cron still polls = NOT event-ified = PARTIAL): every P5-B cron is still an enabled poller.**

| Agent | Cron | Intended replacement | ACTUAL now (source) | DET/LLM | Old poller KILLED? | EVENT live? | PLAN-HAPPENED? |
|---|---|---|---|---|---|---|---|
| **pa** (moved from frank2) | comms-check (15m) | `mail.human` event | enabled=true, polls 15m; spawns `comms-check-worker` (LLM). `pa/crons.json` | LLM (spawn-worker reads SKILL.md) | NO — still enabled | RECEIVER built (gmail_push_listener.py) but NOT running (launchctl empty) | PARTIAL |
| **pa** (moved from frank2) | ff-extractor (4h) | `meeting.completed` | enabled=true; runs `python3 scripts/ff-extractor.py`. `pa/crons.json` | DETERMINISTIC (plain script) | NO — still enabled | webhook receiver built, 0 events delivered | PARTIAL |
| frank2 | transcript-scanner (2h) | `meeting.completed` + P3.3 done-check | enabled=true; spawns `transcript-scanner-worker` (haiku). `frank2/crons.json` | LLM | NO — still enabled | 0 events | PARTIAL |
| frank2 | meeting-commitments (2h) | `meeting.completed` fast path | enabled=true; spawns `meeting-commitments-worker` (haiku) | LLM | NO — still enabled | 0 events | PARTIAL |
| frank2 | ff-extractor... | (listed as pa's above; the frank2 duplicate is gone) | frank2 no longer has ff-extractor — it moved to pa | — | migrated to pa | — | YES (ownership migration) |
| frank2 | pre-meeting-brief · pre-meeting-brief-page | calendar event | both enabled=true, poll (24h / 15m 7-19). LLM prompts | LLM | NO — still enabled (calendar-poll, not event) | NO calendar-event lane | PARTIAL |
| frank2 | check-approvals · human-tasks-check (2h/4h) | approval-queue push | both enabled=true, poll. Prompt is semi-scripted (`list-approvals --format json` then reason) | LLM (mostly) | NO — still enabled | NO approval push wire | PARTIAL |
| frank2 | fleet-reconcile (15m) | daemon event | enabled=true; spawns `fleet-reconcile-worker`. `frank2/crons.json` | LLM | NO — still enabled | NO daemon-event lane | NO |
| crm | fireflies-ingest (2h) | `meeting.completed` | enabled=true; paragraph prompt "Pull meetings completed in last 2h via Fireflies GraphQL... reason" | LLM | NO — still enabled | 0 events | PARTIAL |
| crm | deal-enrichment (24h) | `crm.updated` event | enabled=true; nightly LLM enrichment pass. `crm/crons.json` | LLM | NO — still enabled | NO crm-event lane | NO |

**P5-B verdict: 0 of 11 pollers actually flipped to event.** Event RECEIVERS were built (webhook-bridge + HMAC + gmail listener file) but 0 events are being delivered (webhook log empty, gmail listener not running, Fireflies URL unregistered). The only P5-B progress that DID land = the **ownership migration frank2→pa** for comms-check + ff-extractor (both now in `pa/crons.json`, absent from frank2) — matches the binding ownership note (:290). Everything else = PARTIAL/NO.

### P5-C · KEEP + rewire now (19) — MASTER-BUILD-PLAN.md:292-312

| Agent | Cron(s) | ACTUAL now (source) | PLAN-HAPPENED? |
|---|---|---|---|
| **pa** briefing lane (MOVED from frank2 per correction-5) | morning-brief, evening-wrap | LIVE in `pa/crons.json` (morning-brief 08:03 M-F, evening-wrap 17:02 M-F), ABSENT from frank2 | YES (migration done) |
| frank2 orchestrator | weekly-review, weekly-prep, weekly-synthesis, weekly-cleanup, client-health, pipeline-review, nightly-fleet-analysis, daily-ops-dashboard, outreach-check | ALL enabled=true in `frank2/crons.json` | YES (kept) |
| frank2 | daily-wiki-prep | enabled=true (KEEP-until-P1.1 verdict :298). P1.1 kb-reconcile now live (larry/kb-reconcile-nightly) — its removal is due but NOT yet executed | PARTIAL (still firing; removal owed once 3 green rows) |
| frank2 | daily-trending-repos, session-archaeology | both enabled=true (correction-5 reprieve, claude-mem/session-mining lane) | YES (kept) |
| sage | theta-wave | enabled=true in `sage/crons.json` (sage-owned; frank2 dup killed) | YES |
| crm | daily-checkin, weekly-brief, fireflies-weekly-sweep | all enabled=true in `crm/crons.json` | YES |
| larry | upstream-sync | enabled=true, 7d; prompt runs `git fetch upstream` + reasons — P7 rule-3 `gh pr list --repo grandamenium/cortextos` rewire: NOT confirmed in prompt tail (shows git-log only) | PARTIAL (kept; the grandamenium PR-list rewire unverified) |
| sage | usage-monitor (NEW, parity add) | enabled=true, 2h in `sage/crons.json` — sage-to-upstream-analyst-parity add | YES (parity landed, :350) |

**P5-C verdict: mostly DONE.** Briefing-lane migration to pa = YES. sage usage-monitor parity = YES. Two loose ends: `daily-wiki-prep` removal owed (P1.1 live but wiki cron not yet retired); larry `upstream-sync` grandamenium-PR-list rewire unverified.

### P5-D · Non-priority KEEP-AS-IS (51) — MASTER-BUILD-PLAN.md:317-330

Explicitly deferred this phase (heartbeats ×14, larry ×12, sre ×5, sage ×9, academy ×4, muse ×6, auditos ×1). **PLAN-HAPPENED = N/A (intentional keep).** Note: post-kill fleet re-baselined to 80/12 (sre agent has 0 live crons in state registry — sre's config crons not present in live daemon registry; academy/auditos likewise thinned). Not a plan miss — the "51 keep" was a config.json-era count; live registry is smaller.

---

## 3 · ROLLUP

**P2 (18 unique rollout skills / 25 jobs):**
- DETERMINISTIC gate delivered: `contract-lint.sh` = 18 PASS / 0 FAIL, exit 0 (VERIFIED live).
- Wired w/ I/O contract: 18/18 skills.
- PLAN-HAPPENED **YES** (wired + live artifact at the declared path): 3 (knowledge-base, followup-coordinator, delivery-status-reporter).
- PLAN-HAPPENED **PARTIAL** (wired + contract-lint PASS, no live artifact at the declared path / not autonomous): 14 (including call-prep-researcher: its live worker publishes a verified URL, but does not emit the global skill's local-file path).
- PLAN-HAPPENED **NO**: 0 — but "autonomous 24/7 job worker" was never built for any; the plan itself scopes that as later-bench (:9-10).

**P5 crons (56 named items across A/B/C, +51 deferred D):**
- **Old crons KILLED:** P5-A = **15 / 15** (fully executed, all absent from live registry). P5-B = **0 / 11** killed (all still enabled pollers). Total intentional kills done = 15/15.
- **Went DETERMINISTIC vs still-LLM (P5-B priority pollers):** DETERMINISTIC = 1 (ff-extractor → plain `python3` script). LLM = 10/11 (spawn-worker or reason-paragraph prompts). Fleet-wide the ratio is ~5 deterministic / 75 LLM of 80 live crons.
- **Actually EVENT-based (poller replaced by live event):** **0 / 11.** Event receivers BUILT (webhook-bridge running, HMAC code, tunnel live, gmail listener file) but 0 events delivered (webhook log empty, gmail listener not running, Fireflies URL unregistered — P4.1⑤ human gate).
- **PLAN-HAPPENED tally:**
  - P5-A: 15 YES.
  - P5-B: 2 YES (frank2→pa migration of comms-check + ff-extractor), rest PARTIAL (8) / NO (2: fleet-reconcile daemon-event, deal-enrichment crm-event — no event lane exists at all).
  - P5-C: ~16 YES, 2 PARTIAL (daily-wiki-prep removal owed, upstream-sync rewire unverified).
- **Net: 15 crons actually killed; 0 pollers actually event-ified; the "kill old crons" half of the plan LANDED, the "event-ify to save tokens" half did NOT.**

---

## 4 · PLANNED-BUT-NOT-DONE — the actionable backlog (token-saving / event conversions that never landed)

These are the specific conversions the plan promised and the code does NOT reflect. Each is a real, still-open item:

1. **`comms-check` → `mail.human` event** — receiver `gmail_push_listener.py` EXISTS but is NOT running (not in launchctl, no process). Cron still polls every 15m (LLM worker spawn). **Action: install + launch the gmail push listener as a launchd service, then disable the 15m poll.** (P5-B row 1; gate P4 ingress ① — ingress is live, the listener install is the gap.)
2. **`transcript-scanner` + `meeting-commitments` + `ff-extractor` + crm `fireflies-ingest` → `meeting.completed` event** — webhook-bridge + HMAC + relay are BUILT and the bridge is running, but **0 events are delivered** because the Fireflies webhook URL is unregistered. **Action: P4.1⑤ HUMAN GATE — Josh registers the tunnel URL (`https://27754b3f-ab7e-4098-8fa9-eedfc58acd1e.cfargotunnel.com`) in Fireflies settings; then disable the 4 poll crons.** This is the single highest-leverage token-saving conversion still open — 4 LLM/poll crons firing 2-4h collapse to one event.
3. **`pre-meeting-brief` / `pre-meeting-brief-page` → calendar event** — no calendar-event lane built; both still poll (15m + 24h). **Action: build calendar-event trigger or accept as poll.**
4. **`check-approvals` / `human-tasks-check` → approval-queue push** — no push wire; both still poll. **Action: wire approval-queue push (depends on P4.3 surface).**
5. **`fleet-reconcile` → daemon event** — no daemon-event lane; still 15m LLM worker. PLAN-HAPPENED = NO.
6. **`deal-enrichment` → `crm.updated` event** — no crm-event lane; still nightly LLM. PLAN-HAPPENED = NO.
7. **`daily-wiki-prep` removal** — its removal is P1.1's done-condition; kb-reconcile-nightly is now LIVE but daily-wiki-prep is still enabled=true. **Action: after 3 green kb-reconcile nightly rows, retire daily-wiki-prep.**
8. **larry `upstream-sync` rewire** — plan (P7 rule 3, :305) requires it run `gh pr list --repo grandamenium/cortextos`; live prompt tail shows only `git fetch` + `git log HEAD..upstream/main`. **Action: confirm/add the fork-invisible PR-list check.**
9. **`contract-lint.sh` path drift** — plan declares `orgs/clearworksai/scripts/contract-lint.sh` (:203); actual lives at `orgs/clearworksai/agents/larry/bin/contract-lint.sh`. Cosmetic but the plan-cited path does not exist. **Action: reconcile the path or update the plan.**

**Bottom line (brutally honest):** The **kill** half of P5 fully executed (15/15). The **event-ification / token-saving** half did NOT — 0 of 11 pollers flipped to event despite the receiver infrastructure being built and the tunnel being live. The one thing blocking the biggest win (items 1-2) is a single Fireflies webhook registration (Josh's login) plus starting the gmail listener service — everything code-side is ready. P2's contract/skill layer is genuinely DONE and verified (18/18 lint pass); the autonomous-job layer was never in P2's real scope.
