# FastChecker context accounting — Discovery

Status: COMPLETE

Frank supplied the authoritative regression and runtime invariants. The current implementation in `src/daemon/fast-checker.ts` sums input, output, cache-read, and cache-creation tokens and divides by a model-derived window. The bridge already emits the effective `context_window_size`; FastChecker must instead use that denominator and current input plus output only.
