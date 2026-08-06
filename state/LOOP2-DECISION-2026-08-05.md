# LOOP2 decision — retrieval enforcer

Date: 2026-08-05

## Decision

Keep `src/hooks/hook-retrieval-enforcer.ts` in the runtime and downgrade LOOP2
from “remove” to “keep with explicit bypass.” The hook remains the deterministic
retrieval guard for prompts that ask for historical/session evidence. Removing it
would reopen the unsafe answer-from-memory path and would invalidate its existing
unit and injection-regression coverage.

The accepted exception is the upstream `SESSION-CONTINUATION` bypass (#243):
continuation prompts do not trigger a redundant KB lookup. All other retrieval
intent continues through the hook.

## Evidence

- `tests/unit/hooks/hook-retrieval-enforcer.test.ts` covers retrieval intent,
  malformed configuration, and command-injection regressions.
- `src/hooks/hook-retrieval-enforcer.ts` is included in the current build and
  remains registered by `src/cli/bus.ts`.
- The bypass is narrowly scoped to `SESSION-CONTINUATION`; it is not a global
  disable.

## Acceptance

LOOP2 is closed as **KEEP-WITH-BYPASS**. Future removal requires a replacement
retrieval guard plus equivalent regression coverage; a deletion-only change is
not acceptable.
