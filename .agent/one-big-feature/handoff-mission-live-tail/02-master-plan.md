# Daemon-native handoff/mission: programmatic live-tail injection (fleet-critical)

## Goal
After ANY restart (context handoff, force-restart, or `--continue`), an agent must resume on the user's NEWEST instruction — never on stale task-state frozen in a handoff doc. The daemon — not agent discipline — must programmatically inject the verbatim recent conversation and a mission anchor into every wake-up prompt, with explicit precedence: **verbatim newest inbound > mission anchor > handoff doc.**

## Root cause (verified in source + architect-reviewed 2026-06-30)
1. **Authority asymmetry (imperative vs advisory).** On restart the daemon force-injects the compressed handoff doc as a hard imperative (`agent-process.ts` `consumeHandoffBlock()` ~894-905, `buildStartupPrompt()` ~812-837, and the `handoffUxOverride` at ~831 that orders "read doc → first tool call MUST be X"). The verbatim live tail (`conversation-buffer.jsonl`) is only a skippable bash step in AGENTS.md (step 2.5 / step 0). Stale outranks live by construction.
2. **Dead code.** `conversation-buffer.ts:loadBuffer()` was written to inject the live tail. It has ZERO callers. The read half was never wired in. (Writes work: live `cortextos1/state/<agent>/conversation-buffer.jsonl` is current.)
3. **Handoff-generation prompt** (`fast-checker.ts:1338` `handoffPrompt`) never tells the authoring agent to lead with the newest user instruction → the doc encodes stale "do X FIRST."
4. **Mission anchor** (`current-mission.txt`) is read ONLY to defer restarts (`fast-checker.ts` ~1166-1206), never surfaced on resume, never auto-created. An agent that never wrote one (frank2) has no anchor at all.

## Critical constraints the architect surfaced (MUST honor)
- **PATH ROOTS ARE NOT INTERCHANGEABLE.** Buffer = `ctxRoot/state/<agent>/` (`conversation-buffer.ts:34`, = `paths.stateDir`). Mission = `agentDir/state/current-mission.txt` (`fast-checker.ts:1179`). Use `this.env.ctxRoot` for buffer, `this.env.agentDir` for mission. Mixing them is the most likely bug.
- **`buildContinuePrompt()` (`agent-process.ts` ~839-845) must get the live-tail block too.** Force-fresh-only fixes leave a live hole on `--continue` restarts. This is the biggest gap.
- **Auto-derive the mission at handoff-fire time, in-buffer** (`fast-checker.ts` ~1330-1347 Tier-2 path AND ~1374-1393 recovery path), NOT at next boot — the load-bearing message can rotate out of the 20-entry buffer into the archive before the next session reads it.
- **Anchor on newest INBOUND** (sender ≠ agentName, `via:'telegram'`), never the agent's own outbound; anchor on the contiguous trailing inbound burst, not a single message. Do not key off a hardcoded `"josh"` string (sender is the lowercased Telegram first name, config-dependent).
- **Empty buffer on true first boot** → inject nothing (no empty header). **Char-cap** each turn (~200 chars) to avoid prompt bloat.
- **Doc freshness:** in the recovery block (`fast-checker.ts:1377-1393`) only honor a handoff doc whose mtime is after `ctxHandoffFiredAt` (avoid picking a half-written or previous-session doc).
- Keep AGENTS.md step 0 / 2.5 as a **backstop** (codex-app-server prompt injection is unreliable — issue #392); do not delete it. Daemon owns the mechanism; AGENTS.md owns the bash fallback.

## Scope
Single repo (cortextOS framework). Spec: `03-specs/01-spec.md`.

## Done =
A real restart (handoff + force + `--continue`) demonstrably returns the agent on the user's newest instruction; `loadBuffer` is wired into both prompt builders; mission auto-created at handoff time; unit test asserts both injected blocks with correct roots, empty-buffer no-op, inbound-only anchor selection, and `--continue` coverage. Verified by test + a live restart.
