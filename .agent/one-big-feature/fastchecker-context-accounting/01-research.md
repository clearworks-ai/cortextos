# FastChecker context accounting — Research

Status: COMPLETE

- Implementation: `FastChecker.checkContextStatus` in `src/daemon/fast-checker.ts`.
- Focused regression home: `tests/unit/daemon/context-monitor.test.ts`.
- Existing runtime values are already validated and out of edit scope: `model_context_window=1050000`, `context_window_size=997500`.
- Correct sample: `(278039 + 947) / 997500 * 100 = 27.9685...%`, displayed as `27.97%`.
- Cache-read and cache-creation fields describe reuse/traffic and do not represent current context occupancy.
