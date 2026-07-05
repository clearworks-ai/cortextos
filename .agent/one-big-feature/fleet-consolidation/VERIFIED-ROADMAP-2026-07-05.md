# CORTEXT — VERIFIED WAVED ROADMAP (2026-07-05)

> **This supersedes the stale STATUS block at the top of `ROADMAP.md`.** Every status line below was verified against **real code / files / live process state** on 2026-07-05 (not doc claims), per Josh's directive: *"check the code and verify everything… then give me a real good roadmap with all of this in waves and phases… finish all the structural stuff now, get this as reliable as possible, then the creative stuff."*
>
> Method: git log + merged-PR check, dist-vs-daemon build-state, per-file source reads (3 parallel verify agents), live cron inventory, on-disk marker/seam check.

---

## THE HEADLINE
Josh's instinct was correct — **more is done than the roadmap said.** The consolidation is largely *built and merged*; the gap is **deploy + turn-on + finish-the-half-done**, not build-from-scratch. The single biggest reliability lever is not new code — it's **deploying what's already merged** and **switching on the gates that are sitting inert.**

---

## VERIFIED STATE (ground truth, 2026-07-05)

### ✅ Shipped AND live-active (running behavior on live paths)
| WS | What | Evidence |
|----|------|----------|
| WS4 | Fleet-reconcile + drift alarms, daemon auto-triggered every 15min | `src/daemon/index.ts:276`, `reconcile-trigger.ts:44` |
| WS5 | KB fail-loud ingest (default on via `bus/kb-ingest.sh`) | `kb-ingest.sh:34` |
| WS11 | False-crash alert kill + cron permission deny-fast | `src/hooks/hook-crash-alert.ts`, live hook path |
| WS-A2 | Cron commands route to live instance path | `bus.ts:127` `ensureCtxRootEnv`, `env.ts:33` |
| **WS7** | **Instance cutover — marker `~/.cortextos/state/ACTIVE_INSTANCE=cortextos1` exists on disk; resolver wired** | `resolve-active-instance.ts`, `status.ts:13` — **DONE (Josh was right)** |
| P2/#44 | **Commitment-mining FULLY wired** — worker POSTs to briefs `/api/tasks/ingest` (durable tasks) + uses ff-extractor first-person/concreteness LLM gates | `ff-extractor.py:771`, `frank2/.env:35` — **better than the "gap" the doc claimed** |
| P1/#45 | **Pre-meeting brief PAGE live** — old Telegram-wall cron disabled, new tokened-page cron enabled | `frank2 config.json:207` — **contradicts "reportedly missing"** |
| #30 | Briefs tasks lost-update fix merged to origin/main + deployed | `briefs src/briefs.ts:2472` 409 gate |
| A4 | gsd + gstack frameworks removed; M2C1 + OBF only | skills dir clean |
| A7 | Larry SCOPE_VALIDATION↔autonomous contradiction resolved | `larry/CLAUDE.md:100` |

### ⚙️ Merged but DEFAULT-INERT (built + wired, switched OFF — a decision, not a build)
| WS | What | How to turn on |
|----|------|----------------|
| WS2 | Claim/verify send-guard at the send-telegram chokepoint | `CTX_CLAIM_GATE=warn` today → ramp to `require-confirm` → `enforce` per agent |
| WS10 | Did-vs-claimed activity ledger + memory-correctness harness | CLI-only; needs a cron to write/check it on real activity |
| WS12 | SCOPE_GUARD scope-drift checker | standalone command; NOT wired into codex/M2C1 dispatch yet |

### ❌ Claimed/implied done but NOT actually done
| WS | Claim | Reality |
|----|-------|---------|
| WS6 | MEMORY.md dieted to ≤10KB index | **Still 47KB / 411 lines.** Only the size-lint guard shipped; the actual trim never ran |
| WS-A4 | skills pruned ~150→~60 | **196 skills live** (up, not down); only 33 archived |
| WS-A7 | boot-file "restore crons from config.json" removed | PARTIAL — stale language survives in frank2 skill frontmatter/triggers + 1 CLAUDE.md line |
| ophir | Moxie plugged / weekly snapshot | Moxie MCP **missing** from ophir; no weekly financial snapshot firing. (ophir CAN already message Josh — the claimed "internal-only block" doesn't exist, so that quick-win is moot) |

### 🔴 THE DEPLOY GAP (highest-leverage, near-zero build)
- `dist/` rebuilt **Jul 4 22:53** (reflects all merges through #62) — but the **daemon has 6h uptime (started ~17:12), so it predates that rebuild.** The running fleet is executing **stale dist**. Merged code (#50–#62) is NOT guaranteed live until **rebuild + restart**.
- Routing **seam** (`pipeline-model-routing` — the "right workers do the right work" DNA): built on disk (`.claude/workflows/lib/runtime-bridge.js`, `dynamic-pipeline.js`, `routing-config.json`), review = PASS, but **uncommitted + gitignored + not merged + not deployed.**
- Live cron inventory (healthy, ~66 total): larry 17 · frank2 26 · muse 5 · crm 9 · ophir 2 · maven 7. No mass-missing.

---

# THE WAVES

## 🌊 WAVE 0 — DEPLOY & SWITCH ON WHAT'S ALREADY BUILT
*Highest leverage, near-zero new code. This is where "get it as reliable as possible" actually happens.*

1. **Deploy the merged fleet** — `npm run build` (already current) + **rebuild + restart the daemon** so the running fleet executes merged code (WS4/5/8/11/A2 + everything through #62). Requires the dated restart marker (bounces fleet ~1 min). **← Josh go-gate.**
2. **Ship the routing seam (the DNA).** Decide FLAG 1 ship-path: `git add -f` the gitignored workflow files + PR, **or** local-only deploy. Then Larry opens PR → Josh merges → deploy. Makes M2C1/OBF route each task to the right provider/model instead of funneling through one head+one worker. **← Josh: ship-path + merge.**
3. **Turn on the inert gates, deliberately & staged:**
   - WS2 claim-gate: `warn` → `require-confirm` → `enforce`, per agent, watching for false blocks.
   - WS10 ledger + WS12 SCOPE_GUARD: wire each into a cron / the dispatch path so they actually run (today they're dead CLI commands).

## 🌊 WAVE 1 — FINISH THE HALF-DONE STRUCTURAL WORK
*Close the items that were claimed done but aren't.*

4. **WS6 context-diet for real** — trim MEMORY.md 47KB → ≤12KB (lint guard is already in place to hold it). Bloated memory = compaction loss = the exact "lose the thread" failure mode. High reliability payoff.
5. **WS-A4 skills prune** — 196 → ~60; archive the rest to `_disabled`. Cuts prompt weight + wrong-skill misfires.
6. **WS-A7 finish** — kill the remaining stale "restore crons from config.json" in frank2 skill frontmatter/triggers + the one CLAUDE.md line (root cause of the recurring inert-cron bug).
7. **WS8 failover posture** — the degrade-marker reader is live-but-dormant; decide the failover trigger + confirm the writer (credential-preflight) wires to it, so Anthropic rate-limits auto-degrade instead of stalling.

## 🌊 WAVE 2 — RELIABILITY HARDENING
*"As reliable as possible" — the durability layer.*

8. **Hot-state backup (biggest risk).** ALL fleet state (crons, tasks, memory, markers) is a **single un-backed-up copy outside git**. One disk loss = the whole manager is gone. Off-machine / git-backed snapshot + restore path. (In WS7 scope, never done.)
9. **Cron reliability** — declarative cron manifest + daily reconciler that diffs live crons vs manifest and pages Larry on drift; one-owner-per-cron dedup (WS-A2 sharpened / WS-A8).
10. **Enforcement-point policy (WS-A8)** — a correction isn't "closed" until it names its enforcement artifact (hook / schema / denylist / skill-line). Weekly cron flags any `feedback_*.md` with no enforcement point. Stops the "3rd memory file for the same bug" pattern.
11. **Single source of truth for status** — kill the stale-roadmap-top problem: status lives in one generated place (this doc's pattern), never hand-edited prose that rots.

## 🌊 WAVE 3 — RELATIONSHIP-OS / NEAR-TERM CREATIVE
*Enhance what already exists (Josh's phase-2 "IN" rulings).*

12. **Ophir finance** — add the Moxie MCP (income/AR side) → real burn-rate + cash-flow against Monarch's expense side; make the weekly financial snapshot actually fire; add estate/inheritance context.
13. **Weekly-review upgrade** (frank2) — compose WS9 CRM + Moxie + commitments + cost now that the pieces exist.
14. **WS9 CRM canonical finish** — sync-board flip (board stops overwriting crm every 15min) + Clearpath→crm push on contact/deal events. (The one-time backfill RUN stays SKIP per Josh; the code still stands.)
15. **WS5 prod-op** — Clearpath meeting-intel export (~2,700 gold rows) → MMRAG re-embed at 768d, **staging-first**, then re-enable the nightly.

## 🌊 WAVE 4 — NEW CAPABILITY / PRODUCTIZE
*The creative phase-2 layer, once structural is solid.*

16. **Onboarding-discovery skill** (Chase AI prompt-discovery) — dual mode: TENANT (`tenant-identity.json`) + USER (`user-identity.md`); gate activation on it. Turns onboarding into a grounded interview that auto-builds recurring workflows into skills.
17. **Self-interview / Full Work Inventory → Automation Map tab** — Josh's deeper work inventory with grounded build-status per item.
18. **Content approval-to-publish loop** (stashed) — "marketing is hard but I want some."
19. **Productize cortext** — Docker / one-click deploy image + provisioning pack + vertical packs + multi-tenant. The sellable-product phase.

---

## IMMEDIATE DECISIONS FOR JOSH (unblock Wave 0)
- **A. Deploy go?** Rebuild + restart the fleet now to make all merged code live (dated marker, ~1 min bounce).
- **B. Seam ship-path?** `git add -f` gitignored workflow files → PR, **or** local-only deploy.
- **C. Claim-gate ramp?** OK to start WS2 at `require-confirm` for larry/frank2 (comms-sensitive agents) and watch?

Everything in Waves 1–2 (finish structural + hardening) I can execute autonomously via the codexer pipeline once Wave 0 is unblocked — no per-step approval needed except merge-to-main.
