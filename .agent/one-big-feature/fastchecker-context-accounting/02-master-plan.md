# FastChecker context accounting correction

Artifact order: discovery → research → plan → specs.

Status: APPROVED by Larry

## Goal

Correct FastChecker occupancy without changing the already-validated runtime model, reasoning, or context configuration.

## Invariants

- Preserve `model_context_window=1050000` and emitted `context_window_size=997500`.
- Numerator is only `current_usage.input_tokens + current_usage.output_tokens`.
- Do not include `cache_read_input_tokens` or `cache_creation_input_tokens`.
- Denominator is the positive finite `context_status.json.context_window_size` when present; retain the existing model-window fallback only for older/malformed status payloads.
- No runtime canary and no config changes.

## Files

- `src/daemon/fast-checker.ts`
- `tests/unit/daemon/context-monitor.test.ts`

## Proof

- Regression sample: `278039 + 947 = 278986`; `278986 / 997500 * 100 = 27.9685...`, reported as `27.97%`.
- Cache-token fields can be non-zero without affecting the result.
- Focused tests, typecheck, build, then new live FastChecker evidence from the rebuilt running daemon.
