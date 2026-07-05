# Spec 02 — Lean Fable agent-type (WS2)

**Goal:** When a stage runs on Fable (provider:anthropic, `lean:true`), Fable must receive ONLY
the stage prompt — task + explore reports + instructions — and NOT the target repo's CLAUDE.md,
OPERATIONS.md, memory dumps, or the full coding-agent scaffolding. This is Josh's #1 requirement:
"when we use fable i dont want it filled with normal coding agent harness crap."

**Target files (codexer to confirm exact paths during investigation):**
- `.claude/workflows/dynamic-pipeline.js` (pin the lean agent-type on lean stages)
- Possibly a NEW agent-type definition (e.g. `.claude/agents/fable-lean.md` or the workflow's
  agentType registry) — codexer determines where workflow `agent({agentType})` resolves types from.

## Investigation (codexer, first — gpt-5-codex, off-Anthropic)
1. Determine how the Workflow `agent()` harness assembles a subagent's system prompt and what it
   auto-injects (repo CLAUDE.md? project instructions? tool list?). The `agent()` opt `agentType`
   selects a custom subagent type from the same registry as the Agent tool.
2. Find the leanest agent-type that: (a) can still Read files + return schema-validated JSON,
   (b) does NOT load repo CLAUDE.md / cortext bootstrap.

## Build
1. Define a minimal `fable-lean` agent-type: terse system prompt ("You are a focused planner/
   implementer. Use only the context in this prompt. Do not assume repo-wide conventions beyond
   what is given."), minimal tool set needed for its stage (Plan = read + reason; Implement-if-Fable
   = read/write/bash in its worktree).
2. In `dynamic-pipeline.js`, when `stage.lean === true && provider==='anthropic'`, pass
   `agentType:'fable-lean'` (plus `model:'fable'`, `effort`) into the `agent()` opts via `stageOpts`.
3. Keep Plan and (if Fable) Implement lean. Review/Merge/PR are NOT lean (they legitimately need
   repo context to review/merge).

## Fable-engagement gate (Josh directive 2026-07-05 — Fable is API-metered, opt-in per run)
- Fable footprint is LOCKED to the PLAN stage only. Not used anywhere else.
- Fable must be OPT-IN per build: before a stage routes to Fable, the system ASKS Josh (approval)
  with a short cost note and proceeds on Fable ONLY with explicit yes. NO silent Fable spend, ever.
- routing-config plan entry carries `requiresConfirmation: true` and `fallback` (a non-Fable model).
- On decline/timeout, planning falls back to `fallback` (Josh choosing Opus[rec] vs GLM-5.2 vs stop —
  default "opus" until confirmed). Wire it data-driven, not hardcoded.
- The confirmation mechanism should be a clean injection point (interface/hook), stubable now; the
  live Telegram-approval wiring can come with WS4. Do not hardcode the prompt path.

## Acceptance
- A lean Fable Plan stage, when asked "what CLAUDE.md rules apply here", has NO knowledge of repo
  CLAUDE.md (proves the bootstrap is stripped). Demonstrate via a probe run or a logged context dump.
- Plan stage still produces a valid PLAN_SCHEMA output from task + explore reports alone.
- Token count of the lean Fable stage is materially lower than a non-lean equivalent (report the delta).
- No regression to non-lean stages.
