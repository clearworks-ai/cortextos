# 01-research — fleet-context-diet

Josh's verbatim ask (this session): "the thing that prevents so much context reinsertion at
each turn" — every agent turn currently re-injects a large amount of context (MEMORY.md,
mission anchor, retrieval blocks, MCP server lists, etc.) even when most of it is irrelevant
to that specific turn. Wants a "splitter": selective context reinsertion — only
relevant/recently-searched conversation and memory content gets reinserted per turn, not the
full context every time. This is the core context-burn fix behind the repeated
context-90%-hard-restart cycles visible in the fleet's own transcripts.

An earlier session claimed to have started this OBF and hadn't (empty scaffold dir found at
session start). This document is real, sourced investigation — every claim below carries a
file:line or command receipt.

---

## THE MECHANISM THAT RE-INJECTS EVERY TURN (the actual root cause)

**File:** `/Users/joshweiss/.claude/hooks/retrieval-enforcer.js` (NOT part of the cortextos git
repo — a global, untracked, personal dotfile at `~/.claude/hooks/`).

**Wiring:** every agent's `.claude/settings.json` registers it as a `UserPromptSubmit` hook,
e.g. `orgs/clearworksai/agents/larry/.claude/settings.json:175-190`:
```
"UserPromptSubmit": [{ "hooks": [
  { "type": "command", "command": "node \"/Users/joshweiss/.claude/hooks/retrieval-enforcer.js\"", "timeout": 20 },
  { "type": "command", "command": ".../gate-pipeline-route.sh", "timeout": 10 }
]}]
```
Confirmed also wired for frank2, crm, scout, maven, muse, automator, sage, auditos2, academy,
ophir (grep across `orgs/*/agents/*/.claude/settings.json`, 2026-07-25). `UserPromptSubmit`
fires on **every single prompt submitted in the session** — not just at boot/restart. This is
the literal "every turn" mechanism Josh is naming.

### What it does on every non-cron, non-trivial prompt (`retrieval-enforcer.js:236-276`)

```js
const kb = kbQuery(prompt);                 // line 244 — ALWAYS runs, unconditional
const commits = recentCommits();             // line 245 — ALWAYS runs, unconditional
const direction = conversationDirection();    // line 246 — ALWAYS runs, unconditional
const tr = wantTranscripts ? transcriptHits(prompt) : '';   // line 252 — the ONE gated block
```

- `kbQuery()` (line 70-79): spawns `cortextos bus kb-query "<prompt>" --top-k 5 --threshold 0.45`
  as a subprocess on **every** prompt, regardless of whether the prompt has any retrieval need.
- `recentCommits()` (line 193-206): runs `git log --all --since="48 hours ago" -n 12` on
  **every** prompt and re-injects up to 12 commit lines even when nothing has changed since the
  previous turn 30 seconds ago.
- `conversationDirection()` (line 210-227): reads the newest 3 transcript `.jsonl` files in full
  and re-injects the last 6 user/assistant turns **on every prompt**, oldest→newest. This content
  is, for any turn after the first in a live session, **already present verbatim in the model's
  own context** (it's the actual conversation history) — this block is close to pure duplication
  except immediately after a restart.
- Only `transcriptHits()` (the fourth block) has real relevance gating today: it fires only when
  `RETRIEVAL_INTENT` regex matches or a "strong" keyword (len≥7 or hyphenated/numeric) is present
  (line 251).

**No caching, no hash-based skip-if-unchanged, no per-turn relevance gate on 3 of 4 blocks.**
Every substantive prompt pays the full cost again, identical or not to the previous turn.

### Measured cost (receipted, from the fleet's own prior investigation)

`orgs/clearworksai/agents/larry/memory/reports/fable-retrieval-token-plan-2026-07-06.md`
(iteration-2 patch notes, same file still live today — diff confirmed byte-identical to what's
currently wired):
- "Enforcer's own tax: measured injection = 436 tokens/ordinary prompt, 1,080/retrieval-intent
  prompt, on EVERY UserPromptSubmit including cron fires." (pre-iteration-2 baseline)
- Iteration 2 (current live version, confirmed via `wc -c` = 11,762 bytes, matches
  `~/.claude/hooks/retrieval-enforcer.js` on disk today) deliberately traded quality for size:
  "Injection on substantive prompts grew ~436 → ~1,800–2,050 tokens (commits + direction + wider
  transcript firing)." — i.e. the last fix made the per-turn reinsertion problem Josh is now
  flagging **worse**, in exchange for fixing a different bug (stale/irrelevant hits). Both
  problems are real; this OBF fixes the one Josh is naming now without regressing the other.
- Cron fires are already short-circuited to empty (`main()` line 242) — that part is fine and
  must not regress.

### Prior history on this exact file (why it keeps recurring)

`orgs/clearworksai/agents/larry/state/strip-plan-full.md` (2026-07-03): a previous "scaffolding
strip" plan explicitly turned this hook OFF for larry ("DONE: retrieval-enforcer OFF (larry
settings UserPromptSubmit = [])"). It was later turned back on (current settings.json has it
live; `~/.claude/hooks/retrieval-enforcer.js.bak-2026-07-26` shows it was still being hand-edited
as of yesterday). The fleet has cycled this hook on/off/on without ever adding selective
reinsertion — each round either kills retrieval entirely (bad: post-restart amnesia) or restores
it at full unconditional cost (bad: the problem Josh is naming now). Neither round added the
missing piece: fire the expensive blocks only when they'd change or matter.

---

## WHY THIS FILE CANNOT BE THE PR TARGET (and what can)

`~/.claude/hooks/retrieval-enforcer.js` lives entirely outside any git repository — it is a
personal dotfile in the user's home directory, invoked via a raw `node <path>` command (not a
`cortextos bus hook-*` subcommand like every other hook in this fleet). Its proposed-fix sibling,
`orgs/clearworksai/agents/larry/scripts/retrieval-enforcer.proposed.js`, and the agent
`settings.json` files that wire it, are **git-ignored** in this repo:
```
$ git check-ignore -v orgs/clearworksai/agents/larry/scripts/retrieval-enforcer.proposed.js
.gitignore:17:orgs/clearworksai/*  ...
$ git check-ignore -v orgs/clearworksai/agents/larry/.claude/settings.json
.gitignore:17:orgs/clearworksai/*  ...
```
Nothing under `orgs/clearworksai/*` can be committed/PR'd in the cortextos repo — the whole tree
is excluded (line 17 of `.gitignore`). This explains the "git-ignored = clobberable" fragility
already flagged in `orgs/.../larry/memory/reports/attempt-ledgers-2026-07-06.md` (Thread A1):
fixes to this file keep evaporating because they were never real, trackable, testable repo code.

**The fix belongs in `src/hooks/`, the way every other Claude Code hook in this fleet already
works.** cortextOS already has an established pattern (`src/cli/bus.ts:2987-2991 runHook()`
+ `src/hooks/hook-idle-flag.ts`, `hook-context-status.ts`, `hook-compact-telegram.ts`, etc.):
a TypeScript module compiled to `dist/cli/hooks/<name>.js`, wired into the CLI as
`cortextos bus hook-<name>`, and referenced from `settings.json` as
`"command": "cortextos bus hook-<name>"` instead of a raw path. This is:
- **Testable** — `tests/unit/hooks/*.test.ts` already covers hook modules the same shape
  (see `tests/unit/hooks/hook-compact-telegram.test.ts`: exported functions, vitest mocks).
- **Durable** — compiled and shipped via `npm run build` + `git`, not a hand-edited dotfile that
  silently reverts.
- **PR-able** — actual `src/` source, satisfying the OBF gate's `repo=` requirement for real.

**Scope of this OBF:** build `src/hooks/hook-retrieval-enforcer.ts` (new file) with the same
external behavior/output contract as the current `retrieval-enforcer.js`, PLUS the selective
reinsertion logic described in `02-master-plan.md`. Wire it into `src/cli/bus.ts` as
`hook-retrieval-enforcer`, following the exact pattern at `src/cli/bus.ts:4325-4363`. Add unit
tests. **Deployment** (pointing each agent's `settings.json` at the new command instead of the
raw dotfile path, and retiring the old file) is an operational step Larry performs after merge,
outside this PR — those config files are git-ignored, agent-local, and high blast-radius; they
are not "production source" per Larry's CLAUDE.md write-boundary and do not belong in a codexer/
opencoder diff.

---

## OUT OF SCOPE (explicitly, to prevent a scope-creep regression)

- **Mission anchor / live tail** (`src/daemon/agent-process.ts:1093-1126`,
  `buildResumeContextBlocks()`): this fires only on session **boot/restart**
  (`buildStartupPrompt()` line 1034, `buildContinuePrompt()` line 1073), not per turn — it is a
  different mechanism from the per-turn retrieval-enforcer hook and is NOT part of "reinjection
  at each turn." It must not be touched by this OBF. This directly protects the "never skip
  mission-anchor for BLOCKING crons" requirement — it is untouched, so that behavior is
  unaffected by construction.
- **MEMORY.md loading** — the fleet-shared `MEMORY.md` index is loaded by Claude Code's own
  CLAUDE.md/project-memory mechanism at session start (native harness behavior, not a cortextOS
  hook); no cortextOS `src/` code controls it. Out of scope for a code fix; the existing
  `src/utils/memory-lint.ts` size-budget lint is the correct existing lever for MEMORY.md bloat
  and is untouched here.
- **MCP server list / deferred tool schemas** — confirmed structurally native-loaded with no
  `--mcp-config`/`--strict-mcp-config` flag in the daemon spawn path
  (`src/pty/agent-pty.ts:233-288`, per `retrieval-regression-synthesis-2026-07-06.md`); not
  purgeable from cortextOS code today, and not part of "per-turn reinjection" (it's fixed
  session-start weight, not something re-injected each turn).
- **`retrieval-enforcer.proposed.js`'s kb-query relevance improvements** (boilerplate filtering,
  ask-isolation for Telegram-framed prompts) are a genuinely separate, complementary fix (quality
  of what's returned, not whether/how often it's re-sent). Not duplicated here; noted as a
  candidate follow-up in `02-master-plan.md`.
