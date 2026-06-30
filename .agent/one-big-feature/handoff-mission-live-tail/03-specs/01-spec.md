# Spec 01 — Daemon programmatic live-tail + mission injection

Repo: `/Users/joshweiss/code/cortextos`. Branch: `fix/handoff-live-tail-injection`.
Verify: `npm run build && npm test`.

## Precedence to encode in all injected framing
**verbatim newest inbound (live tail) > mission anchor > handoff doc.** State it explicitly in the prompt text.

---

## Change 1 — Wire `loadBuffer()` into `buildStartupPrompt()`  (`src/daemon/agent-process.ts` ~812-837)
- Import `loadBuffer` from `../daemon/conversation-buffer.js` (already in same dir tree; use correct relative path).
- After `const handoffBlock = this.consumeHandoffBlock();`, build:
  - `missionBlock`: read `join(this.env.agentDir, 'state', 'current-mission.txt')` (**agentDir root**). If present, inject ABOVE handoffBlock, framed: `MISSION ANCHOR (written <age>): <contents>. Verify against the live tail below before acting; if older than 2h treat as possibly stale.` Include mtime/age. If absent, emit nothing.
  - `liveTailBlock`: `loadBuffer(this.env.ctxRoot, this.name)` (**ctxRoot root**). If non-empty, format the last entries as `<ts> <sender>: <content truncated to ~200 chars>` joined by newlines, framed: `VERBATIM LIVE TAIL (your most recent messages — the NEWEST inbound message is AUTHORITATIVE; if the handoff doc conflicts with it, the newest message wins):`. If empty, emit nothing.
- Place `liveTailBlock` AFTER `handoffBlock` in the template (read last = freshest), `missionBlock` BEFORE it.
- **Edit the `handoffUxOverride` at ~831** so the mandated first "back —" message is derived from "doc + newest inbound, newest wins," not the doc alone. This is load-bearing; without it the doc framing still leads.

## Change 2 — Same live-tail + mission injection in `buildContinuePrompt()`  (`src/daemon/agent-process.ts` ~839-845)
- Inject the same `missionBlock` + `liveTailBlock` (build a shared private helper `buildResumeContextBlocks(): { missionBlock: string; liveTailBlock: string }` and call it from both builders to avoid drift). `--continue` restarts currently get none of this — the biggest hole.

## Change 3 — Auto-derive mission at handoff-fire time  (`src/daemon/fast-checker.ts`)
- In the Tier-2 handoff path (~1330-1347, before/around `injectMessage(handoffPrompt)`) AND the `forceContextRestart` recovery block (~1374-1393): if `join(agentDir, 'state', 'current-mission.txt')` does **not** exist, derive one from the buffer.
  - Read buffer via `loadBuffer(ctxRoot, agentName)`. Scan backwards for the contiguous trailing run of INBOUND entries (sender ≠ agentName). If found, write their concatenated text (cap ~600 chars) to `current-mission.txt` (mkdirSync recursive on the `state` dir first). If the trailing entries are all outbound (agent monologue), write NOTHING (do not anchor on the agent's own words). Never overwrite an existing mission.
- Use `this.agent.getAgentDir()` for the mission path and `this.env.ctxRoot` (running instance root) for the buffer — never `default`.

## Change 4 — Fix the handoff-generation prompt  (`src/daemon/fast-checker.ts:1338` `handoffPrompt`)
- Rewrite so the doc MUST lead with a `## LIVE PRIORITY` section quoting the newest inbound user message(s) verbatim, ABOVE `## Current Tasks`. Add instruction: "Before calling hard-restart, write/refresh `state/current-mission.txt` with the LIVE PRIORITY." Keep the existing sections after.

## Change 5 — Doc freshness guard  (`src/daemon/fast-checker.ts:1377-1393`)
- When picking the most-recent handoff doc by mtime, only honor it if `mtimeMs >= this.ctxHandoffFiredAt` (when set). Prevents adopting a half-written or previous-session doc.

## Change 6 — `recall-conversation` bus command  (`src/cli/bus.ts`)
- New subcommand `recall-conversation` (alias `search-transcripts`): args `--agent <name>` (default self), `--grep <pattern>`, `--days <n>` or `--limit <n>`. Reads `conversation-buffer.jsonl` + `conversation-buffer-archive.jsonl` under `ctxRoot/state/<agent>/`, filters by pattern/date, prints matching `<ts> <sender>: <content>` lines. Must scope by date/limit (archive is unbounded, already 100s of KB) — never full-dump. Independent, low-risk.

## Change 7 — Unit test  (`tests/`)
- New test for `buildResumeContextBlocks`: seed a buffer under a temp `ctxRoot/state/<agent>/`, a mission under a temp `agentDir/state/`, assert both blocks render with correct roots + framing; assert empty-buffer → no block; assert inbound-only anchor selection (trailing outbound run → no mission auto-derive); assert `--continue` path includes the live-tail block.

## Out of scope (Larry handles separately)
- AGENTS.md / templates resume-order rewrite (markdown, Larry owns). Keep existing step 0/2.5 as backstop.

## Constraints (NON-NEGOTIABLE)
- No `any`, no `console.log`. Buffer reads/writes must never throw into the prompt path (wrap in try/catch, fail to empty string).
- Path roots: buffer = `ctxRoot/state/<agent>/`; mission = `agentDir/state/`. Do not mix.
- TypeScript strict; `npm run build` clean; `npm test` green (existing + new test).
- Return a diff + scope-validation report. Do not commit or push.
