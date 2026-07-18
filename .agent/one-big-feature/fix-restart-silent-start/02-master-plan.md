# 02 — Master Plan: fix `cortextos restart` silent start-failure

**Slug:** fix-restart-silent-start
**Repo:** ~/code/cortextos
**Framework:** one-big-feature
**Planner:** Opus (Fable off org-wide; Josh standing "Opus unless you say otherwise", frank2 GO 2026-07-18)
**Task:** task_1784303702525_73457745

## Goal
`cortextos restart <agent>` must (a) not race stop→start, and (b) report a truthful result:
if the agent does not reach a running state, print a real error + recovery hint and exit non-zero.
No more "printed Starting X but agent absent".

## Approach (single spec)
Fix at the CLI layer (`src/cli/restart.ts`), preserving the async IPC contract for other callers:

1. **Kill the race** — remove the two separate stop+start IPC calls. Either:
   - use the atomic `restart-agent` IPC (which runs `restartAgent()` = stop→await→start), keeping
     the `writeStopMarker()` call in restart.ts before it; OR
   - keep an explicit stop, but await stop *completion* (poll `status` until the agent leaves the
     registry / is not running) before sending start.
   Prefer the atomic `restart-agent` IPC — it already sequences correctly and re-reads config/.env.
2. **Verify liveness after start** — poll `status` IPC (short interval, ~500ms) up to a bounded
   timeout (~10s) until the target agent appears running. On success print `<agent> restarted`.
   On timeout print a real failure + `Recover with: cortextos start <agent>` and `process.exit(1)`.
3. Keep `writeStopMarker()` crash-alert suppression intact across the stop.

## Out of scope
- Changing the fire-and-forget IPC dispatch contract for `start`/`stop`/`restart` used by other
  callers (soft-restart-all, self-restart, enable). Only the interactive `cortextos restart` CLI
  gains liveness verification.
- Daemon-process restart (`pm2 restart cortextos-daemon`).

## Verify
- `npm run build` clean.
- New/updated unit test for restart liveness: a start that never reaches running → non-zero exit +
  error message; a normal restart → success. Mock the IPC client / status responses.
- Manual: `cortextos restart <agent>` on a live agent brings it back and reports truthfully.

## Files
- `src/cli/restart.ts` (primary)
- Possibly a small shared status-poll helper (co-located or in `src/cli/`).
- Test file under `tests/` matching existing CLI test conventions.
