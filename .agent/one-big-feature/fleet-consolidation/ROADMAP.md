# CORTEXT CONSOLIDATION — MASTER ROADMAP (the one thread, don't lose it)

Everything from the 2026-07-03 session lives in this folder: `~/code/cortextos/.agent/one-big-feature/fleet-consolidation/`.
To resurface it from your phone: ask frank2/cortext "what's left on the consolidation roadmap" — it's saved in fleet memory (`project_consolidation_roadmap_whats_left`).

## The two goals
1. ONE reliable repo / one version of everything. 2. A reliable REMOTE manager you run from your phone.

## The files (what's where)
- `00-fable-plan.json` — Fable's root-cause analysis + full plan.
- `01-josh-decisions.md` — every decision you made.
- `02-updated-workstreams.md` / `03-master-roadmap.md` — the 10 core workstreams + routing.
- `05-fable-ideation.json` — the opportunities Fable discovered (3 angles + top 3).
- `06-phase2-capabilities.md` — phase-2 features + your rulings + grounded shapes.
- `07-added-workstreams-and-audit.md` — WS11 (comms workers), WS12 (better coding agent), self-audit.
- `08-work-inventory-scaffold.md` — your deeper Agentic-OS work inventory (~70 items).
- `09-one-go-batch.md` — **THE ACTION LIST**: PRs to merge, prod-ops to run, questions to answer.

## STATUS → SINGLE SOURCE OF TRUTH: `VERIFIED-ROADMAP-2026-07-05.md`
> ⚠️ **Do not hand-maintain a status block here — it rots.** The old inline "STATUS (live)" /
> "STILL TO DO" blocks were stale (claimed WS1/#30 "merge-ready" and Batches "running" long
> after they were merged + deployed). Live, code-verified status now lives in **one place**:
>
> **→ [`VERIFIED-ROADMAP-2026-07-05.md`](./VERIFIED-ROADMAP-2026-07-05.md)** — every line checked
> against real code / files / live process state, waved (0/1/2…) per Josh's structural-first directive.
>
> The sections *below* this line are the durable **plan/thread** (goals, files, opportunities,
> rulings, session logs) — reference material, not live status. For "what's done / what's left,"
> read the VERIFIED-ROADMAP, not this file.

## OPPORTUNITIES FABLE FOUND (phase-2, not built yet — from `05`/`06`)
Top 3: (1) **Commitment mining + pre-meeting briefs** (relationship OS) — commitment-mining now in flight (Batch D); (2) **Verified price book + proposal-to-cash** (kills fabricated prices, automates revenue path); (3) **Tenant provisioning kit + vertical packs** (turns your fleet into a sellable product).
Also: ophir+Moxie finance, weekly-review upgrade, onboarding-discovery (Chase AI), building-in-public publish. Stashed: content-publish, agency-installer (Docker/one-click + provisioning pack).

## PHASE-2 RULINGS (yours)
Pre-meeting brief = copy Clearpath's briefing-generator shape → tokened web link. Commitment mining = finish-wire (in flight). Personal finance = keep ophir, plug Moxie, unblock its comms. Content-publish = stash. Weekly review = improve frank2's. Agency-installer = later, but Docker/one-click + provisioning pack is the productize phase. Onboarding = wire in Chase AI's prompt-discovery.

---

## WAVE 5 — audit-driven structural fixes (added 2026-07-04, from AUDIT-fable.md)
Full audit: `specs-2026-07-04/AUDIT-fable.md`. Grades: Instructions C+ · Skills C · Automations C− · Prompting C.
Core insight: stop growing MEMORY.md as the enforcement layer — convert invariants to HOOKS/SCHEMAS, delete the rules they replace ("2nd occurrence of a class = code fix, not a 3rd memory file").
- **WS-A1** verify-before-claim hook (retires ~7 verify_* feedback files) — highest leverage.
- **WS-A2** CLI↔daemon cron-path fix (open WS7 follow-up; unblocks all cron mgmt).
- **WS-A3** one-owner-per-cron lint + de-dup (daily-wiki-prep via WS5, morning-digest, theta-wave).
- **WS-A4** collapse 3 frameworks→1, prune skills ~150→~60 (retire gsd:* from loaded set).
- **WS-A5** MEMORY.md weight tiering (always-enforced→hooks vs recall-on-relevance).

### WAVE 5 — Fable-pass additions (authoritative audit, AUDIT-fable.md FABLE PASS)
Grades sharpened: Instructions C- · Skills D+ · Automations C- · Prompting B-.
- **WS-A6 (Fable "one thing"):** promote WS2 send-guard (554fc87, warn-only) → BLOCKING at the `send-telegram` chokepoint + require `--dedup-key` (source-event identity). Kills triple-pings, dead links, false-"live" claims in one deterministic gate. HIGHEST actionable leverage.
- **WS-A7 boot-file truth pass (~2h):** delete "restore crons from config.json" from frank2/muse CLAUDE.md (causes the inert-cron bug); resolve larry SCOPE_VALIDATION↔autonomous contradiction (make it a message for ambiguous scope only, not a wait-gate); regenerate stale model names + cron tables from live state.
- **WS-A2 sharpened:** not just fix the path — UNIFY the store (archive `default`, keep `cortextos1`), make `add-cron` verify the write landed, add a daily reconciler that diffs live crons vs a declarative manifest and pages larry on drift.
- **WS-A8 enforcement-point policy:** a correction isn't "closed" until it names its enforcement point (skill-file line / hook / denylist / code). Weekly cron flags any feedback_*.md with no enforcement artifact. Also: add-cron lint — any cron that sends to Josh must declare a file-based dedup/state key or be silent-log-only.
- **WS-A5 micro-skills → hooks/commands:** link-verify, deploy-verify (dist mtime>source), task-id-resolve — 3 prose rituals in memory become tools.

### SESSION PROGRESS 2026-07-04 (autonomous)
MERGED to main: #57 WS8 failover · #58 WS5 fail-loud/retrieval · #59 WS11 false-crash/cron-deny-fast · #60 cron-path fix (WS-A2) · #61 WS10 ledger+memory-correctness.
LIVE applied: opencode→glm-4.7-flash (verified); credential-preflight.py degrade-marker writer (tested).
Skill cleanup (WS-A4): gsd DURABLY removed (pkg+reinstaller hook, not just commands — root cause of 2 prior failed deletes); gstack removed (kept context-save/restore); codebase-memory 4→1; design/plan deduped; 32 skills → ~/.claude/_disabled-2026-07-04; global CLAUDE.md framework → M2C1+OBF only.
Boot-file truth pass (WS-A7): larry model/cron-count/SCOPE_VALIDATION-contradiction fixed; frank2+muse "restore crons from config.json" → daemon-managed. (backups in _disabled-2026-07-04/boot-files-backup)
FOLLOW-UP found: frank2 `cron-management` SKILL still says "restore from config.json / crons die on restart" — same stale instruction, needs the same fix (add to WS-A8 enforcement-point sweep).
REMAINING: WS2/WS-A6 send-gate (delicate — touches ping path), WS9-A CRM (gated), frank2-EA iMessage, commitment-mining watermark, WS-A1 verify-hook. GATED on Josh: Anthropic top-up, daemon rebuild+restart (deploys merged code), degrade_ok config apply.

### PAUSE POINT 2026-07-04 ~13:55 PT (autonomous run boundary)
Also fixed: frank2 cron-management SKILL "On Session Start → restore from config.json" section → "do nothing, daemon-managed" (the worker-read source of the recurring bug; the rest of that skill still uses the deprecated config.json+/loop model → WS-A8 full rewrite queued).
BUILT + WAITING ON JOSH: PR #62 WS2 send-gate (inert-by-default; look → merge → CTX_CLAIM_GATE=enforce per agent).
NOT STARTED (need Josh / larger): WS9-A CRM (staging-gated), frank2-EA iMessage, commitment-mining watermark diagnosis, WS-A1 verify-hook (largely subsumed by WS2), WS-A8 skill/instruction enforcement-point sweep.
HARD-GATED ON JOSH: Anthropic top-up (trending/synthesis/commitment-mining dead until then); daemon rebuild+restart (deploys all 5 merged PRs to the running fleet); degrade_ok + OPENROUTER_API_KEY apply to frank2/muse.
