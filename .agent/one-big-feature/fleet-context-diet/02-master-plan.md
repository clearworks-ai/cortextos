# 02-master-plan — fleet-context-diet

Goal: stop unconditional full re-injection of retrieval context on every agent turn. Build a
"splitter" — selective, cached, relevance-gated context reinsertion — as real, testable,
PR-able cortextOS source, replacing the untracked global dotfile mechanism identified in
`01-research.md`.

Non-negotiable constraints (carried from Josh's task + `01-research.md`):
1. Must not silently drop context an agent genuinely needs. Every gate below is a "skip only
   when provably redundant or provably irrelevant" rule, never a blanket suppression.
2. Must not touch mission-anchor / live-tail (`agent-process.ts`) — different mechanism, out of
   scope, must keep working exactly as today for every agent (including BLOCKING crons).
3. Must not break retrieval/memory for any agent using the hook today (larry, frank2, crm,
   scout, maven, muse, automator, sage, auditos2, academy, ophir).
4. Output contract (`hookSpecificOutput.hookEventName: 'UserPromptSubmit'`,
   `additionalContext: <string>`) must stay byte-compatible with what Claude Code expects — same
   contract `retrieval-enforcer.js` already emits (`retrieval-enforcer.js:229-234`).
5. Session boundary = full reset. A restart must always get the FULL first-turn context
   (direction + commits + kb), exactly like today — the fix only reduces reinjection on repeat
   turns within an already-live session, never on the first turn after a restart.

## Design — "the splitter"

Reuse the skip-if-unchanged / bootstrap-hash pattern already proven in the fleet
(`~/code/knowledge-sync/wiki/projects/agent-restart-phase1-implementation.md`: hash the inputs,
compare to a cached hash, skip recomputation/reinjection when unchanged) — but make it
**code-enforced inside the hook**, not a prompt instruction the model can skip (the wiki
pattern's version relies on telling the model to check a hash file itself, which the fleet's own
"willpower fails" note already flags as unreliable; this version never asks the model, the hook
decides).

### Per-session cache

- Cache key: a stable session id. Claude Code's `UserPromptSubmit` hook payload includes
  `session_id` on the JSON stdin envelope (same envelope this hook already parses at
  `retrieval-enforcer.js:63-68` via `getPrompt()`); use that field, falling back to a hash of
  `(agent name + newest transcript file path)` if absent.
- Cache location: `<ctxRoot or tmpdir>/retrieval-cache/<agent>/<sessionIdHash>.json` — a small
  JSON state file per (agent, session): `{ turnCount, lastCommitsHash, lastDirectionSentTurn,
  lastKbQueryNormalized, lastKbResultHash }`. Best-effort — any read/parse/write failure falls
  back to "treat as first turn" (i.e. fail OPEN, never fail closed/silent-drop — satisfies
  constraint 1).
- A fresh session (new transcript file / new session id, i.e. any restart) naturally gets a
  fresh cache file → turnCount 0 → every gate below evaluates as "first turn" → full context
  fires, matching today's restart behavior exactly (constraint 5).

### Gate A — `conversationDirection()` block

Today: recomputed and reinjected on every prompt (near-total duplication of live context after
turn 1). Fix: only include on `turnCount === 0` for this session cache, OR when the prompt itself
matches `RETRIEVAL_INTENT` (explicit "what did we discuss" / "catch me up" style ask — the model
may genuinely want a compact recap even mid-session). Every other repeat turn omits the block —
the model already has the real history in context; nothing is lost, only the duplicate copy.

### Gate B — `recentCommits()` block

Today: `git log` re-run and reinjected every prompt regardless of whether anything shipped since
the last turn. Fix: hash the git log output (`sha256` of the formatted string, same shape as the
knowledge-sync bootstrap-hash pattern). Compare to `lastCommitsHash` in the session cache.
- Unchanged since last turn in this session → omit the block entirely (nothing new to say).
- Changed (new commit landed, or first turn) → inject, and update the cached hash.
This is a pure win: it can only suppress content that is byte-identical to what the model was
already told a moment ago in this same session.

### Gate C — `kbQuery()` block

Today: runs the `cortextos bus kb-query` subprocess unconditionally on every prompt (a real
external call with up to a 12s timeout), even for routine "ok continue" turns with zero
retrieval need. Fix: reuse the exact same relevance gate `transcriptHits()` already uses today
(`wantTranscripts = RETRIEVAL_INTENT.test(prompt) || strong.length > 0`, line 251) to also gate
whether `kbQuery()` runs at all. Additionally cache the normalized query string; if identical to
the previous turn's query (e.g. a retried/near-duplicate ask) and the cached result set is still
fresh (<2 min old), reuse the cached hits instead of re-querying. This both cuts token
reinjection AND cuts real subprocess/latency cost on routine turns.
- Safety valve: if the prompt is empty of both intent-regex and strong keywords BUT is long
  (>200 chars) — treat as "ambiguous, possibly important" and run kb-query anyway. Never suppress
  based on brevity of the GATE logic alone; only suppress on genuine keyword-absence for short/
  routine turns.

### Gate D — `transcriptHits()` block

No change — already relevance-gated today via `wantTranscripts`. Keep as-is.

### Never-skip / force-open safety valve

Regardless of all cache state, if the prompt matches an urgency/blocking signal (reuse
`RETRIEVAL_INTENT` plus an added small `URGENT` regex: `urgent|prod(uction)? down|security
incident|breaking|outage`), force ALL gates open (full context, ignore cache) for that turn.
Defense in depth on top of constraint 5 (session-boundary reset already covers the common case);
this covers a genuinely important turn mid-session that happens to look identical to the last one
on the cache's terms.

### Unaffected

- Cron-fire short-circuit (`[CRON FIRED...]` → empty injection) — unchanged, still an explicit
  early return before any gate logic runs.
- Empty/very-short prompt short-circuit — unchanged.
- `<documented-past-retrieval>` wrapper + directive text — only emitted when at least one
  section has content, same as today; if every gate suppresses (a genuinely redundant, routine
  turn), the whole hook returns empty, which is itself the correct outcome and matches the
  existing cron-fire precedent of "no new information, no injection."

## Build shape

1. **New file `src/hooks/hook-retrieval-enforcer.ts`** — port `retrieval-enforcer.js` logic
   (prompt parsing, keyword extraction, transcript listing/scoring, kb-query, commits, direction)
   into TypeScript, matching the exported-function style of existing hook modules (see
   `src/hooks/hook-compact-telegram.ts` pattern: exported pure functions + a `main()`), so each
   gate is independently unit-testable. Preserve every existing behavior byte-for-byte except the
   four gates above.
2. **Cache module** — small helper (co-located in the same file or a new
   `src/hooks/lib/retrieval-cache.ts`) implementing read/write of the per-session cache file with
   fail-open semantics (any error → behave as if no cache exists → first-turn/full-context
   behavior).
3. **CLI wiring** — add to `src/cli/bus.ts` following the exact existing block at
   `src/cli/bus.ts:4325-4363`:
   ```
   busCommand
     .command('hook-retrieval-enforcer')
     .description('UserPromptSubmit hook: selective/cached documented-past retrieval injection')
     .action(() => runHook('hook-retrieval-enforcer'));
   ```
4. **Tests** — new `tests/unit/hooks/hook-retrieval-enforcer.test.ts` covering (see
   `03-specs/01-hook-retrieval-enforcer.md` for the full list): Gate A/B/C behavior including
   first-turn-always-full, repeat-turn-suppression, session-boundary reset, cache-read-failure
   fail-open, cron-fire and short-prompt short-circuits unchanged, force-open on urgency
   keywords, and output envelope shape unchanged.
5. **No changes** to `src/daemon/agent-process.ts`, anything under `orgs/`, or
   `~/.claude/hooks/retrieval-enforcer.js` (outside repo, untouched by this PR).

## Rollout (after PR merge — Larry owns, not part of this PR)

1. Deploy: build (`npm run build`), confirm `dist/cli/hooks/hook-retrieval-enforcer.js` exists
   and runs standalone against a sample stdin payload.
2. Point ONE agent's `settings.json` (larry, lowest blast radius / easiest to watch) at
   `"command": "cortextos bus hook-retrieval-enforcer"` instead of the raw node path; leave the
   old dotfile in place, untouched, as instant rollback (just revert the settings.json line).
3. Observe for a full session: confirm first-turn-after-restart still carries full context,
   confirm repeat turns shrink, confirm no missed-retrieval regressions on a real "what did we
   discuss earlier" ask.
4. Roll to the remaining agents (frank2, crm, scout, maven, muse, automator, sage, auditos2,
   academy, ophir) once larry proves clean.

## Explicitly deferred (not this OBF)

- Porting `retrieval-enforcer.proposed.js`'s kb-query relevance filtering (boilerplate exclusion,
  Telegram-ask isolation) — complementary, separate concern (quality vs. frequency).
- MEMORY.md size/content — already owned by `src/utils/memory-lint.ts`.
- MCP/tool-schema boot weight — structurally blocked at the daemon spawn layer, not a per-turn
  reinjection problem.
