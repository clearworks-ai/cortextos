# nightly-fleet-scan — FR-C2 proof-of-pattern note

Proof-of-pattern for **FR-C2** (spec `event-driven-and-cron-modernization-spec-2026-08-10.md`,
SUBSYSTEM 3): deterministic bulk FLOW + thin LLM VERIFY, applied to ONE representative
LLM-driven KEEP cron. **Not wired into the live cron** — that is a gated deploy.

## Why `nightly-fleet-analysis` was chosen

Of the FR-C2 candidates (frank2 `client-health`, `nightly-fleet-analysis`, …),
`nightly-fleet-analysis` (frank2, `3 2 * * *`) is the cleanest to filter deterministically
**and** the highest-value:

- Its live prompt dispatches a **Sonnet** subagent to READ raw stdout tails (200 lines ×
  7 agents), `restarts.log`, `crashes.log`, and daily memory, then eyeball-detect issues.
  That is the exact "dump the haystack into the LLM" anti-pattern the principle
  (`feedback_deterministic_cron_core_llm_verify_layer.md`) names, and the shape that
  caused a context bootloop this week.
- Every detection pattern in the prompt is already deterministic:
  | prompt pattern | deterministic rule |
  |---|---|
  | CRASH LOOP (`WATCHDOG-HARD-RESTART >2x / 24h`) | count in-window events per agent, threshold |
  | HOOK ERRORS (`PreToolUse hook error`) | ANSI-strip stdout tail, regex grep |
  | SILENT AGENTS (`heartbeat not updated >5h`) | `crons.json` heartbeat `last_fired_at` age threshold |
  | FRUSTRATION (`sloppy / broken / can't trust`) | keyword grep of daily memory |
  | WORKAROUNDS (`⚠️` in AGENTS.md) | marker count |

`client-health`, by contrast, requires semantic reading of client notes to judge
"stalled" — much weaker deterministic separation, so a poorer first template.

## What the script does (the FLOW)

`nightly-fleet-scan.py` performs the whole bulk scan in code — no network, no LLM —
and emits ONLY the few surviving candidate anomalies as JSON, each with the exact
evidence line attached:

```bash
python3 nightly-fleet-scan.py \
  --logs-dir   ~/.cortextos/cortextos1/logs \
  --state-dir  ~/.cortextos/cortextos1/.cortextOS/state/agents \
  --memory-dir <dir holding <agent>/memory/<date>.md>
```

Live smoke test (2026-08-11): swept the multi-MB fleet log corpus → **5 candidates**.
Deterministic output (stable given the same tree + `--now`); empty candidate list is a
valid healthy result (exit 0). Tests: `tests/test_nightly_fleet_scan.py` (17 cases,
stdlib `unittest`) — covers each detector plus the noise-rejection paths (below-threshold,
fresh heartbeat, out-of-window, big-noisy-tree-collapses-to-one).

## How it would replace the current LLM-polling cron (GATED — not done here)

The cron prompt would shrink to: **run the script, then hand ONLY `candidates` to a thin
LLM verify.** Concretely, the new prompt body:

1. `SCAN=$(python3 $CTX_AGENT_DIR/scripts/nightly-fleet-scan.py --logs-dir … --state-dir … --memory-dir …)`
2. If `.candidates` is empty → `bus log-event action nightly_analysis_complete info` and **stop**
   (no subagent, no Telegram) — today this still burns a Sonnet run to conclude "nothing".
3. If non-empty → pass the **short candidate JSON** (never the raw logs) to a Haiku/Sonnet
   verify step that judges `root_cause` / `severity` / `auto_fixable` per candidate, then
   applies the existing routing (CRITICAL auto-fix immediately, else approval + Telegram; etc.).

Net effect: the LLM sees ~5 pre-de-noised rows instead of thousands of raw log lines —
the same downstream decisions, without the context blow-up.

### Why this stays gated
- Rewiring the live cron edits `crons.json` via `cortextos bus update-cron` — a deliberate,
  receipted deploy (per FR-E2 / the disposition doc's ledger discipline), not a dev-branch change.
- The thin LLM verify step itself (prompt + routing) is the other half and is out of scope
  for this proof-of-pattern; this deliverable is the deterministic core + its tests only.
- Thresholds (`CRASH_LOOP_THRESHOLD=2`, `SILENT_AGENT_HOURS=5`) mirror the current prompt;
  any tuning belongs in the gated rollout, validated against a staging log tree first.
