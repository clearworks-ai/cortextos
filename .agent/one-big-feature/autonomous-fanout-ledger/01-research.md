# Research — Larry-owned autonomous fan-out pilot

**Framework:** one-big-feature pilot, backend-only.  
**Repository:** `/Users/joshweiss/code/cortextos`  
**Status:** grounded research; no implementation claimed.

## Problem

The direct Larry harness coordinator is the only partially working execution path. The
checked-in `dynamic-pipeline.js` has no proven end-to-end run, and the two Codex goal/control
plane attempts did not provide autonomous continuation. The current durable GoalRunner is
opt-in and one-shot; the signed pipeline ledger is a linear provenance chain, not a scheduler.

## Live evidence

| Claim | Evidence | Verdict |
|---|---|---|
| Signed stage chain exists | `src/pipeline/ledger.ts`, `bin/pipeline-stage-emit`, `state/pipeline-ledger.jsonl` | VERIFIED |
| Staging/true-verify machinery exists | `src/pipeline/staging-verify/*`; ledger requires review → staging-verify → true-verify | VERIFIED |
| Goal runner is one-shot | `src/pty/codex-app-server-pty.ts` calls `GoalRunner.processTick()` after `/goal`; `src/daemon/goal-runner.ts` runs one thread turn and verifier | VERIFIED |
| Existing runner schedules a DAG | No workstream/lease/DAG scheduler in `src/daemon/` | FALSE |
| Dynamic runner is operational | `.claude/workflows/dynamic-pipeline.js` has no proven live run and omits required stages | FALSE |
| Canonical multi-model rules exist | `orgs/clearworksai/agents/larry-codex/PIPELINE.md` | VERIFIED (documented) |
| Existing bus/MultiCA wiring is end-to-end | No single trace currently proves goal → dispatch → receipt → ledger → status | UNVERIFIED |

## Canonical routing for the pilot

Graphify/current code graph for internal exploration; Gemini for external research; Opus for
synthesis/review; `/specify` before `/goalify`; confirmed Fable/Opus plan; Codex heavy worker;
staging verification and true-verify before PR. The pilot first proves one worker path, then
three independent lanes.

## Fable/adversarial findings

See `01-fable-analysis.md`. Root causes include missing terminal specs receipts,
`TRANSCRIPT_MISSING`, artifact SHA drift, no provenance-repair queue, no supervisor wake-up,
and global serialization behind a single gate.
