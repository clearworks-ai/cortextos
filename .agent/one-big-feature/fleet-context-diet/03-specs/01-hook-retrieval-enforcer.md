# Spec 01 — hook-retrieval-enforcer (selective/cached retrieval injection)

Repo: `/Users/joshweiss/code/cortextos`. Framework: one-big-feature. Slug: `fleet-context-diet`.

## Context (read before writing code)

Read these exact files first — this spec assumes you've read them, do not re-derive from
scratch:
- `/Users/joshweiss/.claude/hooks/retrieval-enforcer.js` (276 lines) — the reference
  implementation to port and extend. This file is OUTSIDE the repo (do not edit it, do not
  reference it from repo code — read-only reference for behavior parity).
- `/Users/joshweiss/code/cortextos/src/cli/bus.ts` lines 2987-2991 (`runHook()`) and lines
  4325-4363 (existing `hook-*` command registrations) — the wiring pattern to follow exactly.
- `/Users/joshweiss/code/cortextos/src/hooks/index.ts` — shared hook utilities (`readStdin`,
  etc.) already available to reuse.
- `/Users/joshweiss/code/cortextos/src/hooks/hook-compact-telegram.ts` and
  `/Users/joshweiss/code/cortextos/tests/unit/hooks/hook-compact-telegram.test.ts` — the
  established pattern of exporting pure functions from a hook module and unit-testing them with
  vitest + `vi.mock`.
- `/Users/joshweiss/code/cortextos/.agent/one-big-feature/fleet-context-diet/01-research.md` and
  `02-master-plan.md` in this same directory — full root cause + design. This spec is the
  buildable slice of that plan; do not re-litigate the design, implement it.

## Deliverable 1 — `src/hooks/hook-retrieval-enforcer.ts` (new file)

Port the full behavior of `~/.claude/hooks/retrieval-enforcer.js` to TypeScript (strict, no
`any`), preserving these functions/behaviors exactly (same inputs → same outputs):
- `readPrompt(raw: string): string` — parse stdin JSON, extract `.prompt`/`.user_prompt`/
  `.message`. ALSO extract and return `session_id` from the same parsed JSON object if present
  (the reference implementation's `getPrompt()` discards everything but the prompt text — this
  port needs the session id too, see Deliverable 2).
- `kbQuery(prompt: string, org: string): string` — same `cortextos bus kb-query` subprocess call
  and formatting as the reference (`--top-k 5 --threshold 0.45`).
- `extractKeywords(prompt: string): { strong: string[]; weak: string[] }` — identical STOP set
  and strong/weak split logic (len≥7 or hyphen/digit = strong).
- `listRecentTranscripts(agentName: string): string[]` — identical mtime-based recency sort
  (reference already fixed the UUID-alphabetical bug; preserve the mtime sort).
- `transcriptHits(prompt: string, agentName: string): string` — identical scored/spread
  candidate selection.
- `recentCommits(): string` — identical `git log --all --since="48 hours ago" -n 12` call and
  formatting.
- `conversationDirection(agentName: string): string` — identical last-6-turns extraction.
- `RETRIEVAL_INTENT` regex — identical.
- Cron-fire short-circuit (`/^\s*\[CRON FIRED/`) and empty/short-prompt short-circuit (<3 chars)
  — identical, unconditional, evaluated BEFORE any gate/cache logic.

Then ADD the following NEW behavior (the actual fix — see `02-master-plan.md` "Design — the
splitter" for full rationale):

### New: `URGENT` regex
```ts
const URGENT = /urgent|prod(uction)? down|security incident|breaking|outage/i;
```

### New: per-session cache (fail-open)
Exported functions (must be independently unit-testable):
```ts
interface RetrievalCacheState {
  turnCount: number;
  lastCommitsHash?: string;
  lastDirectionSentTurn?: number;
  lastKbQueryNormalized?: string;
  lastKbResultHash?: string;
  lastKbResultAtMs?: number;
}

function cachePathFor(agentName: string, sessionKey: string): string;
// Location: join(os.tmpdir(), 'cortextos-retrieval-cache', agentName, `${sha256(sessionKey).slice(0,16)}.json`)
// sessionKey = the session_id from the hook payload if present, else `${agentName}:${newestTranscriptPath}`.

function readCache(path: string): RetrievalCacheState;
// MUST fail open: any missing file, parse error, or read error returns
// { turnCount: 0 } (i.e. "treat as first turn" — never treat a read failure as "seen before,
// suppress"). This is a hard correctness requirement, not a style preference — a fail-closed
// cache would silently drop context, which the spec's parent plan explicitly forbids.

function writeCache(path: string, state: RetrievalCacheState): void;
// Best-effort; swallow write errors (never throw, never block hook output).

function sha256Hex(input: string): string; // Node crypto, reuse pattern from src/pipeline/ledger.ts if convenient.
```

### New: gate functions (each independently unit-testable, pure where possible)
```ts
function shouldForceOpen(prompt: string): boolean;
// RETRIEVAL_INTENT.test(prompt) || URGENT.test(prompt)

function shouldIncludeDirection(cache: RetrievalCacheState, prompt: string): boolean;
// cache.turnCount === 0 || shouldForceOpen(prompt)

function shouldIncludeCommits(commitsText: string, cache: RetrievalCacheState, prompt: string): boolean;
// cache.turnCount === 0 || shouldForceOpen(prompt) || sha256Hex(commitsText) !== cache.lastCommitsHash
// (also true, naturally, when commitsText is empty vs cache had a hash — i.e. any change fires)

function shouldRunKbQuery(prompt: string, strong: string[]): boolean;
// RETRIEVAL_INTENT.test(prompt) || strong.length > 0 || prompt.length > 200
```

### Rewired `main()`
1. Read stdin, parse prompt + session id.
2. Cron-fire / empty-prompt short-circuits — UNCHANGED, before cache is even touched.
3. Load cache via `readCache(cachePathFor(...))`.
4. Compute `commits = recentCommits()` always (cheap, needed for the hash compare either way),
   but only include the `## Recent commits` section in the output when
   `shouldIncludeCommits(commits, cache, prompt)` is true.
5. Only include `## Conversation direction` when `shouldIncludeDirection(cache, prompt)` is true.
6. Only call `kbQuery()` (the subprocess) when `shouldRunKbQuery(prompt, strong)` is true —
   unlike commits/direction, do NOT call it unconditionally; this one also saves the subprocess
   spawn, not just the injected text. When skipped, do not add a `## MMRAG` section at all (not
   even the "no hits" message — nothing was queried).
7. `transcriptHits()` gating — UNCHANGED (`wantTranscripts` as today).
8. If NOTHING was included (all gates suppressed), emit `''` exactly like the cron-fire path —
   same empty-envelope behavior, not a special case.
9. Update cache: increment `turnCount`, and if commits/kb sections were included, store their
   new hashes; write via `writeCache()` (best-effort, swallow errors).
10. Emit the same JSON envelope shape as today
    (`{ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: <string> } }`).

## Deliverable 2 — CLI wiring in `src/cli/bus.ts`

Add immediately after the existing `hook-loop-detector` registration (around line 4360-4364),
following the exact pattern of the other `hook-*` registrations at lines 4325-4363:
```ts
busCommand
  .command('hook-retrieval-enforcer')
  .description('UserPromptSubmit hook: selective/cached documented-past retrieval injection (fleet-context-diet)')
  .action(() => runHook('hook-retrieval-enforcer'));
```
Do not modify `runHook()` itself — it already does the right thing (spawns
`dist/cli/hooks/hook-retrieval-enforcer.js` via `stdio: 'inherit'`).

## Deliverable 3 — Tests: `tests/unit/hooks/hook-retrieval-enforcer.test.ts`

Follow the mocking style of `tests/unit/hooks/hook-compact-telegram.test.ts` (vitest, `vi.mock`
for `child_process.execSync`/`fs` where needed to avoid real subprocess/filesystem side effects
in the test run). Required cases — every one must pass:

1. **Cron-fire short-circuit unchanged**: `[CRON FIRED...]` prompt → empty additionalContext,
   regardless of cache state.
2. **Empty/short prompt short-circuit unchanged**: prompt `<3` chars → empty additionalContext.
3. **First turn (turnCount 0) always includes direction + commits** (when non-empty) regardless
   of prompt content — proves session-boundary full-context behavior is preserved.
4. **Repeat turn with identical commits hash omits the `## Recent commits` section** — the core
   fix for Gate B.
5. **Repeat turn with CHANGED commits (different hash) re-includes the section** and updates the
   cache.
6. **Repeat turn (turnCount > 0), no retrieval intent/urgent keyword, omits `## Conversation
   direction`** — the core fix for Gate A.
7. **A prompt matching `RETRIEVAL_INTENT` on a repeat turn re-includes direction** even though
   turnCount > 0.
8. **A prompt matching the new `URGENT` regex forces both commits and direction open** even with
   an unchanged-hash / repeat-turn cache state — proves the safety valve.
9. **Routine short prompt with no strong keywords and no intent match skips `kbQuery` entirely**
   — assert the mocked `execSync`/subprocess call for kb-query is NOT invoked (this is the
   subprocess-cost savings, not just token savings).
10. **Cache read failure (corrupt JSON / missing file) behaves exactly like turnCount 0** (fail
    open) — write a malformed cache file and assert full context still fires. This is the single
    most important test in the suite: it's the proof the fix cannot silently drop context.
11. **New session (different session_id / no cache file yet) after a prior session's cache
    exists on disk gets full context** — proves session-boundary reset, not global suppression
    across sessions.
12. **Output envelope shape unchanged**: `hookSpecificOutput.hookEventName === 'UserPromptSubmit'`
    and `additionalContext` is a string, matching the existing contract exactly.
13. `npm run build` must compile with zero TypeScript errors (strict mode, no `any`) and
    `npm test` must pass in full (not just the new test file — no regression in the existing
    suite).

## Explicit non-goals / do-not-touch (scope guard)

- Do NOT edit `/Users/joshweiss/.claude/hooks/retrieval-enforcer.js` — it's outside the repo,
  read-only reference only.
- Do NOT edit anything under `orgs/` (git-ignored in this repo; any edit there is a silent no-op
  for version control and out of this PR's scope).
- Do NOT edit `src/daemon/agent-process.ts` (mission-anchor/live-tail — different mechanism, must
  keep working unchanged for every agent including BLOCKING-cron cases).
- Do NOT add a `console.log` anywhere in `src/hooks/hook-retrieval-enforcer.ts` (the hook's
  stdout IS the JSON envelope Claude Code parses — any stray console.log corrupts the hook
  output contract; use the module's own emit function only, matching how the reference
  implementation only ever calls `process.stdout.write` once via `emit()`).
- No new runtime dependencies — kb-query stays a subprocess call via `child_process.execSync`
  (same as the reference implementation), not a library import.

## Definition of done

- `src/hooks/hook-retrieval-enforcer.ts` exists, compiles, matches the behavior spec above.
- `src/cli/bus.ts` has the new `hook-retrieval-enforcer` command wired per Deliverable 2.
- `tests/unit/hooks/hook-retrieval-enforcer.test.ts` exists with all 13 cases above passing.
- `npm run build && npm test` both green.
- Diff touches only: `src/hooks/hook-retrieval-enforcer.ts` (new), `src/cli/bus.ts` (one command
  registration added), `tests/unit/hooks/hook-retrieval-enforcer.test.ts` (new). Nothing else.
