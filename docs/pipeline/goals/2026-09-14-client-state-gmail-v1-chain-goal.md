# Goal — traverse bonesify chain 2026-09-14-client-state-gmail-v1

**Default:** the session that wrote this file **keeps running the chain here**
(autonomous). This file is also the resume spine after compaction or a new
session — not a stop-and-wait paste gate.

Optional (Claude Code only, if you want host `/goal` re-invoke): paste this
`file://` into `/goal` in a fresh session.

```text
CHAIN (the only state that matters; chat is disposable)
  /Users/joshweiss/code/cortextos/docs/pipeline/chains/2026-09-14-client-state-gmail-v1.json

CLI
  b() { node /Users/joshweiss/code/bones-dev-skills/bonesify/scripts/bonesify.mjs "$@"; }
  Trust exit codes. Never pipe a gate check (zsh blanks ${PIPESTATUS[0]}).
  Never hand-edit the chain JSON.

STANDING RULES
0. **Autonomous.** After seed, continue until DONE or HALT. Do not ask
   permission to start the next ready goal. Do not stop after printing commands.
1. The graph decides what runs next, not a plan made at the start. Re-run
   `b next /Users/joshweiss/code/cortextos/docs/pipeline/chains/2026-09-14-client-state-gmail-v1.json` every iteration — handoffs add nodes as you go.
2. Follow /Users/joshweiss/code/bones-dev-skills/bonesify/SKILL.md run mode for HOW to dispatch each node type
   (goalify job / `← NEXT` goal / open spec node). This condition owns only
   the "keep going" part.
3. One **stage claim** at a time (staging mutex on `/stage`). A concurrency
   limit on deploys, not a ban on coding. Two goals on one staging surface may
   develop in parallel on **stacked branches** (see
   /Users/joshweiss/code/bones-dev-skills/bonesify/references/stacked-branches.md); only final staging merges
   serialize. The chain dispatcher still runs one `← NEXT` goal for stage
   completion in **this session**. Handing that stage-claim loop to a separate
   Codex session leaves this loop re-checking a condition it cannot advance —
   if you do that deliberately, stop this loop and poll with `/loop 30m`
   instead. A sibling session coding the upper stacked worktree without
   `mark-running` is fine.
4. Never `mark-done` without --evidence or --force-no-ship --reason.
   Self-graded "looks good" is not evidence.
5. **Subagents by DEFAULT — try a subagent first whenever possible.** Stay
   in-process only for the carve-out in rule 6. Do not read a ledger, a spec,
   a codebase area, a doctrine file, a graph query, or promote material into
   this context when an agent can return the rows, paths or verdict instead.
   The main thread carries the graph and the decisions; it must not carry the
   material behind them. A traversal survives a dozen nodes only if it stays
   thin.
   - Dispatch independent units **in parallel, in one message**. Serial
     delegation of independent work is the slow failure mode.
   - **Return contract:** the agent's final message IS the return value —
     table rows, file:line citations, a verdict. Never a transcript, never a
     narrated tour. Doctrine that must reach `goalify` comes back **verbatim**;
     a paraphrase has broken the contract. Bulky evidence gets **written to a
     file** and the agent returns the path plus a gist.
   - **Independence is a property of the execution context, not the lens.**
     Findings corroborate only when they came from **separately dispatched**
     contexts. Five review angles reasoned through in one context are five
     perspectives and ONE witness. Never write "independently confirmed" or
     promote a severity on the strength of lenses that shared a context.
   - **Verify an agent's load-bearing claim yourself before acting on it.** An
     agent reporting `file:line` is a lead, not a probe. Re-read the line here
     when the claim decides an architecture, a gate, or a HALT.
   - When `next` says goalify is ready: pull `node-design.md` verification
     layers + Learn-from bullets via a **subagent** (verbatim return), then
     invoke goalify with that injection — do not load the whole doctrine file
     into this context.
6. **NEVER delegate these** — the only carve-out; everything else defaults to
   subagent:
   - Any `b` command that changes status (`mark-*`, `*-handoff`), any
     validator, any script whose **exit code is the evidence**. A delegated
     exit code is the subagent's *claim* about a gate — self-grading with
     extra steps. Run it here and read the number yourself.
   - Anything gated on the human. A subagent cannot ask, so it guesses, and a
     guessed answer to a forcing question is the failure this system exists to
     prevent.
   - **The traversal itself**, and **node goal execution**. A node IS a `/goal`
     loop, not an Agent call; its context is managed by compaction plus its
     ledger. A delegated traversal dies with the subagent that held it.
     (Inside that goal, the *condition* still requires subagents by default.)
   - Doctrine/corpus **writes** (Learn-from append, learn-refresh edits).
     Investigation may be delegated; the write stays here.
7. Do not auto-promote. `/promote` is the human's.

EACH ITERATION
- `b next /Users/joshweiss/code/cortextos/docs/pipeline/chains/2026-09-14-client-state-gmail-v1.json`
- Dispatch exactly what it says is ready.
- On completion: `b mark-done /Users/joshweiss/code/cortextos/docs/pipeline/chains/2026-09-14-client-state-gmail-v1.json <id> --evidence … [--sha …]`
  On failure:    `b mark-failed /Users/joshweiss/code/cortextos/docs/pipeline/chains/2026-09-14-client-state-gmail-v1.json <id> --error "…"`
- Loop. "goal-a is done, shall I start goal-b?" is the failure mode this
  condition exists to remove: `next` already answered, so start it.

HALT (ask, do not proceed) — only these:
- metered spend over $2, production writes, external messages
- real product ambiguity: a question whose answer changes WHAT gets built
Permission to continue is not ambiguity.

DONE WHEN this exits 0:
  The promote node is EXCLUDED from `open` on purpose. lib.mjs sets
  `promote.status = "ready"` in the same branch that sets the chain to
  `awaiting_promote`, so a finished chain always has promote sitting at
  `ready` — and rule 7 forbids this loop from clearing it. Counting it as
  open made this bar unsatisfiable: a correct, finished chain returned 1
  forever and the traversal had no terminus. Guarded by
  tests/chain-done-bar.test.mjs; do not "simplify" the filter back.
  node -e 'const d=require("/Users/joshweiss/code/cortextos/docs/pipeline/chains/2026-09-14-client-state-gmail-v1.json");const open=d.nodes.filter(n=>n.type!=="promote"&&["ready","running","blocked"].includes(n.status));process.exit(d.status==="awaiting_promote"&&open.length===0&&d.learn_from_scan?0:1)'
AND `b promote-report /Users/joshweiss/code/cortextos/docs/pipeline/chains/2026-09-14-client-state-gmail-v1.json` has been printed for the human.

A `failed` node that blocks the rest also ends the run: run
`b learn-from /Users/joshweiss/code/cortextos/docs/pipeline/chains/2026-09-14-client-state-gmail-v1.json`, report, stop.
```
