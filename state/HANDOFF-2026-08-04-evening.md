# HANDOFF — 2026-08-04 ~16:20 PDT (context exhausted)

Read this + `feedback_verify_at_source_live_test_before_any_status_claim` in memory BEFORE claiming any status.

---

## ⚠️ THE RULE THAT MATTERS MOST (learned the hard way, all day)

**Never claim a status without a LIVE TEST at the real endpoint.** I called SIX shipped, working systems "not done / dead / broken / needs Josh" today. Every one was wrong. Josh had to correct each. This burned the day and his trust.

1. **Live-test the real thing** — curl the actual public URL, run the actual script, read the actual dated artifact. Loopback ≠ public. Config file ≠ behavior. Status cache ≠ truth.
2. **Read agent memory + transcripts + bus FIRST** — the answer is often already recorded (larry had the webhook hostname in his memory; I never looked and spent an hour "discovering" it wrong).
3. **An empty grep / missing log line is NOT disproof.** The webhook bridge logs only "listening" and never logs successful relays — yet relays work. Negatives need POSITIVE disproof.
4. **Three axes, never inferred from each other: CODE** (merged PR) · **LIVE** (running) · **OUTPUT** (dated artifact). All three or say UNVERIFIED.
5. **Josh is the authority when he says something is done.** Verify to find the real gap, never to contradict him.
6. **Never "fix" what you haven't proven broken** — nearly "fixed" a non-bug this session.

### Claims of mine that COLLAPSED under live testing (all actually work)
| I claimed | Truth (live-verified) |
|---|---|
| Fireflies webhook "0 deliveries, unreachable, Josh must register" | `curl -X POST https://hooks.clearworks.ai/relay/fireflies` + HMAC → **HTTP 200 {"ok":true}**, lands in pa inbox + `processed/pa/`. WORKS. I'd tested the wrong URL (raw cfargotunnel from tunnel.json). |
| Tunnel "wrong port 3000 vs 20242" | `~/.cloudflared/config.yaml` (`.yaml` not `.yml`!) is CORRECT: `^/relay/.*` → localhost:20242 |
| pa `ff-extractor.py` "dead since Jul 9" | Modified Aug 4 04:37, `--help` runs, supports `--meeting-id`. ALIVE. (I'd read a different stale file as its health signal.) |
| comms-check "produces nothing since Jul 12" | Josh's Telegram shows live output today: Mark Lurie triage + draft, Steven Burns + Nancy Henriquez bookings |
| Dashboard "unbuilt" | PR#287 mission-control, wired to live CRM/pipeline/tasks |
| 3-signal detector "unbuilt" | PR#262, `src/bus/signal-sweep.ts` + cron wired |
| P2 "not started" | MASTER-BUILD-PLAN.md:6 — "P2 skills rollout DONE, gate 2.09 closed"; contract-lint 18 PASS/0 FAIL |
| LOOP1 "needs daemon restart" | #302 already IN running daemon (`grep realContextWindow dist/daemon.js` = 2) |

**Consequence: the P2/P5 status lists I produced are UNTRUSTWORTHY.** A live-test pass over every bullet was authorized but NOT run (context ran out). That is the next job — see below.

---

## 🔴 NEW BUG — PR#305 root cause (frank2 found it; capture is durable)

Both today's CRM bugs trace to **ONE commit: PR#305** (merged 18:15 UTC, "feat(crm): keyless enrichment + records-admin event triggers"). 8 files / 2196 lines, **every line a pure ADD, zero deletions** — first time those files ever touched git.

It shipped an **incomplete wire-up**, not a plain bug:
1. Added `--match-email` / `find_contact_by_email` to `upsert-contact.py` — but **never updated the two existing callers** (`calendar-backfill.py`, `comms-backfill.py`), which still pass the old `--id`. Every backfill since 18:15 mints a fresh duplicate (Mark Lurie ×3). → **bug #317**
2. Added 4 event-emit functions with a `CRM_EVENT_EMIT_LOG` test-safety seam — but **never wired the seam into the existing test setup**. Every fleet test run leaks real bus events into crm's live inbox. → **bug #318**, and the same root as the earlier "spoofed sender" flood scare that night.

**Why nobody caught it:** crm's core scripts are gitignored (`.gitignore:17` blanket-ignores `orgs/clearworksai/*`). Force-added files have **zero prior history → no diff to review**. A reviewer sees "new file, 265 lines" and can't tell it fails to wire into the two scripts that need it. `test_upsert_contact.py` is STILL untracked, never in any PR.

**Real fix (process, not patch):** force-track crm's live production scripts into git (codexer already did this for `calendar-backfill.py`) so future PRs there get a reviewable diff. Josh offered to spec it as its own task — **not yet specced.** Saved: `incident_gitignored_crm_scripts_unreviewable_pr305_2026-08-04`.

---

## ✅ SHIPPED THIS SESSION (merged + live-verified)

- **#302** daemon measures ctx-% vs real 1M window (deployed, in running daemon)
- **#308** Multica 400 fix — id-less `agent` assignee_type; outbound errors **145 → 0**
- **#309** Multica real-time outbound mirror on bus mutations (create/update/claim/complete). Proven: task create → CLE-194 `todo`; `in_progress` → issue flips; `cancelled` → flips
- **#311** Multica project grouping — `task.project` → find-or-create Multica project (flat dump → 41 real projects: cortextos, seiu-521, epics, clients)
- **#314** per-task lock kills duplicate-issue race (CLE-369/370). Verified: rapid create+update → 1 issue
- **#310** larry `ctx_handoff_threshold` −1 → 70 (all 13 agents on disk; daemon re-reads live via mtime)
- Merged for larry: **#312, #313, #315** (Lane A EA GWS booking + Zoom-in-invite), **#307**
- **Multica inbound**: writeback verified (`wrote_back: 2`) — but see debt below
- **Task hygiene**: ~67 verified-stale tasks closed (each matched to a merged PR / on-disk code) + 7 fake `Cron:` in_progress markers + 11 academy + 7 blocked-on-Josh cancelled. in_progress now = 2 REAL (frank2 multica, larry zoom epic)
- **knox-codex** was genuinely DOWN → restarted (fleet = 13)

## 🧾 Durable artifacts written
- `state/GROUNDED-STATUS-2026-08-04.md` — P1–P6/loops/waves/altari, PR-cited (**but pre-live-test; treat as suspect**)
- `state/CRON-ACCOUNTABILITY-2026-08-04.md` — all 78 crons, dispositions
- `state/P2-P5-SKILL-LEDGER-2026-08-04.md` — P2/P5 per-item
- `state/P2-P5-EXECUTION-RUNBOOK.md` — 42-step mechanical runbook (**contains the wrong Fireflies premise — fix before use**)
- Google Doc (phone-readable): https://docs.google.com/document/d/1ffHXoZk0IO6XpOhSpD1z_QvvSHNIoWgsrOyiVlBBOUA/edit

---

## 📌 STATE OF THE PLAN (P2/P5) — what's actually true

- **P2** = DONE (skill + I/O contract layer; contract-lint 18/0). 13 skills pass lint but had no observed live artifact — **UNVERIFIED, not "not done"** (the live-test pass would settle it).
- **P5-A** (kill bad crons) = **15/15 killed**, verified absent from live registries.
- **P5-C** (keep/rewire) = mostly done. Loose ends: retire `daily-wiki-prep` after 3 green kb-reconcile rows; add `gh pr list --repo grandamenium/cortextos` to larry/upstream-sync.
- **P5-B** (cron → event) = **the real remaining work.** Event surfaces exist and the Fireflies one is PROVEN working end-to-end. Polls still run alongside. **Do NOT kill any poll until its event path is proven to produce the same artifact** — the polls are what currently produce.
- **Deterministic conversions** (token saving): only ~4-5 of ~80 crons are deterministic; ~16 are LLM prompts doing mechanical work. Unstarted.
- **Josh's decision: NOT rebuilding from upstream** — commit to the fork (saved in memory).

## 💳 Debt I created (own it)
- Added a **2-min time-based crontab** for Multica inbound (`*/2 … multica-sync --direction in`) — exactly the polling Josh wants dead. Runs clean (0 errors) but must become event-driven. **Multica has NO outbound webhooks** (`/api/webhooks|hooks|subscriptions|events` all 404) and is an external REST SaaS (no local Postgres) — so "LISTEN/NOTIFY" as written is not applicable; needs a real design.
- Backfill flooded Multica with 173 issue creates; 60 x 409 conflicts self-heal via orphan adoption.
- A Multica orphan-reconcile sweep was **parked** — my first version wrongly checked `find orgs` for bus tasks (they live in `~/.cortextos`), so it flagged all 222 non-terminal issues as orphans. **Dry-run caught it; nothing was closed.** Needs the correct existence check before running.

## ➡️ NEXT (in order)
1. **Run the live-test pass over every P2/P5 bullet** (authorized, not run). One real command + its actual output per item; verdicts: PROVEN-WORKING / PROVEN-BROKEN / GENUINELY-ABSENT / UNVERIFIED / HUMAN-GATED. Read-only. → `state/LIVE-TEST-PASS-2026-08-04.md`. Only PROVEN-BROKEN becomes work.
2. **Spec the crm force-track task** (close the unreviewable-PR class).
3. Then P5-B event conversions + the ~16 deterministic conversions — **each gated on a passing live test first.**

## 🙋 Open for Josh
- Zoom marketplace login (open tab) — frank2 says nothing else blocks it
- #316 (Lane A receipts) has merge conflicts — needs rebase
- #245 (Zoom webhook v2) — his architecture call, still open
- Mission-control **portal** greenlit (dashboard or standalone, NOT cxportal) — spec exists at `altari-skilltree/mission-control-client-delivery-spec.md`; no epic created yet
- OakRoots is **NOT a client** and not in the blessed-5 (OCG · Kadre · Alloi · SEIU 521 · MSIA) — strike it from deliverables
