# Adversarial Code Review — fleet-context-diet

**VERDICT: PASS-WITH-NITS**

OBF slug `fleet-context-diet`, spec `03-specs/01-hook-retrieval-enforcer.md`.
Diff `/tmp/fleet-context-diet.diff` = exactly 4 files (2 new, 2 edited):
- `src/hooks/hook-retrieval-enforcer.ts` (new, 530 lines)
- `src/cli/bus.ts` (+5 lines, one command registration)
- `tsup.config.ts` (+1 line, one build entry)
- `tests/unit/hooks/hook-retrieval-enforcer.test.ts` (new, 301 lines, 14 `it()` blocks)

> METHOD: The diff was unapplied at review time (files absent from the working tree). I
> applied it to a scratch copy of the tree, ran `npm run build` and
> `npx vitest run tests/unit/hooks/hook-retrieval-enforcer.test.ts`, then restored the tree
> to its pre-review clean state and removed the stray `dist/` artifacts. Empirical results
> below are from that applied run, not static reasoning. Parity of the ported functions was
> cross-checked line-for-line against the read-only reference
> `/Users/joshweiss/.claude/hooks/retrieval-enforcer.js`.

---

## Checklist

### 1. SCOPE MATCH — PASS
Every deliverable present, nothing outside the 4 declared files.
- **Deliverable 1 (hook module)**: all required exports present — `readPrompt` (now returns
  `{ prompt, sessionId }`), `kbQuery`, `extractKeywords`, `listRecentTranscripts`,
  `transcriptHits`, `recentCommits`, `conversationDirection`, `RETRIEVAL_INTENT`, plus the new
  `URGENT`, `RetrievalCacheState`, `cachePathFor`, `readCache`, `writeCache`, `sha256Hex`, and
  the four gate functions (`shouldForceOpen` / `shouldIncludeDirection` / `shouldIncludeCommits`
  / `shouldRunKbQuery`). `buildAdditionalContext` is the rewired `main()` body, `main()` wraps it
  and emits the envelope once via a single `process.stdout.write`.
- **Deliverable 2 (CLI wiring)**: `bus.ts:4365-4369` registers `hook-retrieval-enforcer` right
  after `hook-loop-detector`, delegating to `runHook('hook-retrieval-enforcer')`. `runHook()`
  itself is untouched (spec-compliant). `tsup.config.ts:22` adds the entry, so
  `dist/hooks/hook-retrieval-enforcer.js` is emitted (verified: 16.58 KB CJS bundle built).
- **Deliverable 3 (tests)**: file present, 14 `it()` blocks (13 spec cases + 1 extra kb-metadata
  assertion), all pass.

### 2. PARITY WITH REFERENCE — PASS
Line-for-line against `~/.claude/hooks/retrieval-enforcer.js`:
- `recentCommits()` matches the reference's actual two-step form (`git rev-parse --show-toplevel`
  then `git -C "<top>" log --all --since="48 hours ago" -n 12 ...`). The spec §Deliverable-1
  shorthand "same `git log --all --since` call" describes this; the reference (the mandated parity
  source) uses rev-parse first, and the port copies it exactly, including the
  `repo <base> (git log --all, last 48h, incl. unmerged branches):` header. Correct.
- `listRecentTranscripts` preserves the mtime-sort (reference's fixed UUID-alphabetical bug stays
  fixed), the `3 * 86400 * 1000` (3-day) cutoff, and the `AGENT ? dir.includes(AGENT)` filter.
- `extractKeywords` STOP set, the `len≥7 || /[-0-9]/` strong split, `.slice(0,4)` caps — identical.
- `transcriptHits` scoring/spread (`maxTotal 8`, `maxPerFile 3`, `maxCandidatesPerFile 6`,
  `.slice(0,14)` files, `< 40`-char floor, ts-desc final sort) — identical.
- `conversationDirection` last-6-turns, `.slice(0,3)` files, `< 30`-char floor, CRON/`<`-prefix
  skip — identical.
- `RETRIEVAL_INTENT` regex — identical alternation.
- Cron-fire (`/^\s*\[CRON FIRED/`) and `<3`-char short-circuits are evaluated at the TOP of
  `buildAdditionalContext` (lines 468-473), BEFORE the cache is read (line 480). Spec §main-step-2
  satisfied.

### 3. NEW BEHAVIOR — PASS
- `URGENT` regex matches spec verbatim.
- Gate functions match spec signatures/bodies exactly:
  - `shouldForceOpen` = `RETRIEVAL_INTENT || URGENT`.
  - `shouldIncludeDirection` = `turnCount === 0 || shouldForceOpen`.
  - `shouldIncludeCommits` = `turnCount === 0 || shouldForceOpen || sha256Hex(commitsText) !== lastCommitsHash`.
  - `shouldRunKbQuery` = `RETRIEVAL_INTENT || strong.length > 0 || prompt.length > 200`.
- `main()` order (lines 475-526) follows spec steps 3-10: cache load → commits computed always →
  per-section gating → kb subprocess only when `includeKb` (line 489, so the spawn itself is
  skipped, not just the text) → no `## MMRAG` section emitted at all when kb is skipped → cache
  incremented and hashes stored → empty-envelope (`''`) when `sections.length === 0` → single
  envelope shape.
- Cache path = `join(tmpdir(), 'cortextos-retrieval-cache', agentName, sha256(sessionKey).slice(0,16)+'.json')`
  per spec. `sessionKey = sessionId ?? '<agent>:<newestTranscript>'` per spec.

### 4. FAIL-OPEN CORRECTNESS — PASS (this is the load-bearing property)
- `readCache` (lines 401-421): `existsSync` false, non-record JSON, parse throw, or read throw all
  return `{ turnCount: 0 }` — i.e. "treat as first turn," never "seen before, suppress." This is
  the hard requirement in spec §readCache and it is met on every failure branch.
- `writeCache` (423-430): `mkdirSync`+`writeFileSync` wrapped, swallows all errors, never throws.
- `kbQuery`, `recentCommits`, `transcriptHits`, `conversationDirection`, `listRecentTranscripts`
  every external read is in try/catch returning `''`/`[]`. No uncaught path can reach
  `process.stdout.write`.
- `main()` (line 551) is `.catch(() => process.exit(0))` — a total failure still exits 0 with no
  stderr noise, so the hook never blocks Claude Code's prompt submission.
- EMPIRICALLY PROVEN: test "cache read failure behaves like turnCount 0" writes `{not-json` to the
  cache path and asserts BOTH `## Recent commits` and `## Conversation direction` still fire and
  the rewritten `turnCount` is `1`. This is the single most important test and it is real, not a
  stub — it reads a genuinely corrupt file through `readCache` and checks full context is restored.

### 5. TEST QUALITY — PASS (real, not tautological)
Applied-run result: **Test Files 1 passed / Tests 13 passed** (150ms).
- The `execSync` mock is a real dispatcher keyed on command text (git rev-parse / git log / kb-query),
  so gating assertions exercise the actual subprocess boundary.
- Case 4 (identical-hash omits commits) seeds `lastCommitsHash: sha256Hex(formattedCommits())` and
  asserts the section is ABSENT — genuinely proves Gate B suppression.
- Case 5 (changed hash) seeds a stale hash and asserts the section returns AND the cache is rewritten
  to the new hash with `turnCount` incremented — proves both re-inclusion and cache update.
- Case 6 (repeat omits direction) cleverly seeds a NON-matching commits hash so commits stay present
  while direction is asserted absent — isolates Gate A instead of confounding it with the commits gate.
- Case 9 (skip kbQuery) asserts `kbQueryCalls().toHaveLength(0)` — a real negative on the subprocess,
  proving the spawn-cost savings, not just token savings.
- Case 11 (new session) seeds a `turnCount:10` cache under a DIFFERENT session id and proves the new
  session id resolves to a different cache path and gets full context — proves session-boundary reset,
  not global suppression.
- Envelope-shape and cron/short-circuit cases assert `mockExecSync` was NOT called at all on the
  short-circuit paths — proving the short-circuit precedes any subprocess work.
None of the 14 are tautological (no `x === x`, no `expect(true)`); every one binds an observable
output to a seeded input.

### 6. CODE QUALITY — PASS
- `grep` for `: any` / `<any>` / `as any` / `any[]` on the new hook: NONE. `unknown` is used at the
  JSON boundaries (`readPrompt`, `lineText`, `readCache`) and narrowed via `isRecord` /
  `readOptionalString` / `readOptionalNumber` type guards — the correct strict-mode pattern.
- `grep` for `console.(log|error|warn|info)` in the new hook: NONE. Output goes through the single
  `process.stdout.write(JSON.stringify(...))` in `main()`, satisfying the spec's "stdout IS the
  envelope" constraint. Test file has no `console.*` either.
- `npm run build` (tsup, strict) compiled with zero TS errors and emitted the new bundle.
- No new runtime dependencies; kb-query stays an `execSync` subprocess.

### 7. CORRECTNESS BUGS HUNTED — none blocking
- **turnCount off-by-one**: `nextState.turnCount = cache.turnCount + 1` written AFTER the gates read
  `cache.turnCount === 0`. First turn (0) fires full context then persists `1`; second turn reads `1`
  and gates selectively. Correct — no off-by-one.
- **Hash compare**: `shouldIncludeCommits` hashes the SAME `commitsText` the section will emit, and
  `nextState.lastCommitsHash = sha256Hex(commits)` stores that identical string. Empty-commits case:
  `includeCommits = Boolean(commits) && shouldIncludeCommits(...)` short-circuits to false when
  commits is `''`, so an empty-vs-cached transition does not emit an empty section (a benign
  divergence from the spec's parenthetical, see NIT 3). No hash mismatch bug.
- **Keyword extraction edge**: regex `[a-z][a-z0-9-]{3,}` requires len≥4 pre-STOP-filter; matches
  reference. Empty-prompt path is short-circuited earlier. No crash on punctuation-only prompts
  (yields `[]`).
- **Session-key collision across agents**: IMPOSSIBLE — cache path is namespaced by `agentName`
  directory before the sessionKey hash, so two agents can never share a cache file even with the
  same fallback sessionKey. Within one agent, only same-`session_id` (or, in the no-session-id
  fallback, same newest-transcript-path) collide, which is the intended per-session behavior.

---

## BLOCKING-ISSUES
(none)

---

## NON-BLOCKING-NITS

1. **`readPrompt` treats a `.message` OBJECT as prompt text via `coerceString`.** Line 182:
   `parsed.prompt ?? parsed.user_prompt ?? parsed.message`. If a payload ever sends `message` as an
   object (some hook event shapes do), `coerceString` yields `"[object Object]"` (17 chars, passes
   the `<3` gate) and that string becomes the prompt fed to kb-query/keyword extraction. The
   reference has the same latent behavior, so this is parity-preserving, not a regression — but it is
   a real garbage-in path. Cheap guard: only accept `message` when `typeof === 'string'`. Cosmetic
   for the current UserPromptSubmit payload (which uses `.prompt`).

2. **`buildAdditionalContext` reads `process.env` for defaults, weakening pure-function testability.**
   Lines 475-476 fall back to `process.env.CTX_AGENT_NAME` / `CTX_ORG` when options are absent. The
   tests always pass explicit options, so it is covered — but a gate function billed as "pure where
   possible" that silently reads env is a mild surprise. Non-blocking: `main()` passes them
   explicitly and the fallback only fires if a caller omits them.

3. **Empty-commits transition does not emit the section, contradicting the spec's parenthetical.**
   Spec §shouldIncludeCommits notes "(also true, naturally, when commitsText is empty vs cache had a
   hash — i.e. any change fires)". The gate function itself honors that (`sha256Hex('') !== oldHash`
   is true), but `main()` guards with `Boolean(commits) &&` (line 483), so a repo going quiet
   (commits → `''`) emits NO `## Recent commits` section rather than an empty one. This is arguably
   BETTER (an empty section is noise) and cannot drop real context, but it is a deliberate deviation
   from the spec text that should be acknowledged in the plan or the guard removed for literal
   compliance. Behaviorally harmless.

4. **`lastKbResultAtMs` / `lastKbResultNormalized` are written but never read for gating.** The cache
   stores kb metadata (lines 521-524) and one test asserts it, but no gate consults
   `lastKbResultAtMs` for a time-based kb-dedup — kb re-runs whenever `shouldRunKbQuery` is true
   regardless of how recently it ran. That matches the spec (kb gate is keyword/length-based, not
   time-based), so the stored fields are currently forward-looking dead state. Fine to keep; just
   note they are unused so a future reader does not assume kb caching is active.

5. **14th test (`records kb query metadata`) is beyond the 13 required cases.** Harmless extra
   coverage, not scope creep in production code — worth keeping.

6. **Process nit — OBF planning artifacts.** `01-research.md` / `02-master-plan.md` / this spec live
   in the untracked `.agent/one-big-feature/fleet-context-diet/` tree. Commit them alongside the code
   so the build is auditable against its spec (same recommendation as the prior
   cron-register-reliability review).

---

## Recommendation
Ship after Josh's merge approval. All spec acceptance criteria met, build green, 13/13 required
tests pass empirically, fail-open proven by a real corrupt-cache test, no `any`, no `console.log`,
no scope creep. The nits are cosmetic/documentation and can land as-is or in a trivial follow-up.
