# Track B — Staging Stand-up + Cron-Stranding Fix Runbook (2026-08-09)

> Josh chose staging-first for the cron fix. cortextOS staging = a second named daemon instance
> (`setup-staging-environment` Variant C — flagged DESIGNED-not-yet-proven, so this is the first
> stand-up; designed here before executing). Goal: reproduce the stranding, verify the migration +
> enabled-agents repair + stale-cron alarm on staging, THEN apply to prod `cortextos1`.

## Root cause (confirmed live)
Aug 5-6 codex cutover stranded crons under dead base agents: `larry` (8 crons) + `frank2` (4+) run
as `larry-codex`/`frank2-codex` with EMPTY cron registries → crons fire into dead sessions, dead
since cutover. `enabled-agents.json` also corrupted (garbage keys). Full detail:
`memory/incident_codex_cutover_stranded_crons_2026-08-09.md`.

## Isolation model (built in — verified from code)
- Instance resolves via `CTX_INSTANCE_ID` (`src/utils/env.ts:48`); home `~/.cortextos/<instance>/`,
  socket `~/.cortextos/<instance>/daemon.sock` (`src/utils/paths.ts:32,60`). Ephemeral PTY ports
  (PR#94) — no collision with `cortextos1`.
- Prod marker `~/.cortextos/state/ACTIVE_INSTANCE = cortextos1` — DO NOT change it. Launch staging by
  explicit `CTX_INSTANCE_ID=cortextos-staging` only, never by flipping the marker.

## Stand-up steps (execute after Josh greenlights the LAUNCH)
1. **Build:** `npm run build` (tsc clean) on the fix branch (worktree).
2. **Seed minimal home** `~/.cortextos/cortextos-staging/` with a MINIMAL config — 2 dummy agents
   only (`tlab` + `tlab-codex`) to reproduce the base→codex stranding. Do NOT clone the live fleet.
3. **HARDEN side-effect keys (safety-critical — do BEFORE any launch):** the staging agent `.env` /
   `secrets.env` MUST have NO Telegram bot token, NO Resend/email key, NO Slack token, NO Twilio —
   blank them. Staging must be provably unable to message anyone. Verify: `grep -iE
   'TELEGRAM|BOT_TOKEN|RESEND|SMTP|SLACK|TWILIO' ~/.cortextos/cortextos-staging/**/.env` → empty.
4. **Prove isolation (do not skip):** separate socket (`ls ~/.cortextos/cortextos-staging/daemon.sock`
   != prod), `ACTIVE_INSTANCE` still `cortextos1`, no prod file touched.
5. **Reproduce:** register a test cron under `tlab` while only `tlab-codex` runs → confirm it does
   NOT fire (reproduces the bug).
6. **Verify the fix:** migrate the cron entry `tlab` → `tlab-codex` (crons.json move + `reloadCrons`)
   → confirm it fires (fresh ledger row = live receipt). This proves the migration mechanism.
7. **Verify enabled-agents repair:** write a corrupted enabled-agents.json in staging, run the repair,
   confirm it normalizes to clean agent-name keys without dropping live agents.
8. **Verify stale-cron alarm (FR-B3):** age a cron's last-fire past interval×N → confirm one alarm row.
9. **Teardown staging** or leave inert (keys blanked). Then apply the PROVEN steps to prod:
   migrate larry(8) + frank2(4+) crons base→-codex, disable multica-sync, repair enabled-agents,
   install the alarm. Live receipt on cortextos1 = fresh ledger rows for kb-reconcile + claude-mem-export.

## Why this is greenlit-gated
Launching a first-ever cortextOS staging daemon is outward-facing risk (a mis-hardened instance could
fire real client comms) and unproven. Steps 1-4 are safe/inert; the LAUNCH (step 5+) is the gate.
Prod application (step 9) is a separate confirm — it changes the live fleet's cron behavior.
