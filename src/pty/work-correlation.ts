/**
 * Task 3.4 introduced `WorkCorrelationEvent` inline inside
 * `codex-app-server-pty.ts` as the shape any PTY adapter emits to correlate
 * runtime activity back to `WorkRecord`s in the lifecycle ledger
 * (`runtime-accepted`/`progress`/`completed` for the three genuinely separate
 * positive moments; `failed`/`needs-review`/`cancelled` for the three
 * distinct negative outcomes).
 *
 * Task 3.8 extends this pattern to non-Codex providers (Claude/Hermes/
 * OpenCode) — per that task's own explicit instruction ("do not invent a
 * second event shape"), the type is pulled out to this shared module so
 * `agent-process.ts` can build/forward these events on behalf of a provider
 * that has no PTY-level emitter of its own (Step 3's `needs-review`
 * fallback), without duplicating the union. `codex-app-server-pty.ts`
 * re-exports this type under its original name for back-compat with any
 * existing `import type { WorkCorrelationEvent } from './codex-app-server-pty.js'`
 * call site.
 */
export type WorkCorrelationEvent =
  | { type: 'runtime-accepted'; workIds: string[]; turnId: string }
  | { type: 'progress'; workIds: string[]; turnId: string }
  | { type: 'completed'; workIds: string[]; turnId: string }
  | { type: 'failed'; workIds: string[]; turnId: string | null; error: string }
  | { type: 'needs-review'; workIds: string[]; turnId: string | null; reason: string }
  | { type: 'cancelled'; workIds: string[]; turnId: string | null; reason: string };
