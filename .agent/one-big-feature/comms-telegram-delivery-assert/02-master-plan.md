# 02 — Master Plan: assert Telegram delivery on frank2 turns

**Slug:** `comms-telegram-delivery-assert` · **Framework:** one-big-feature · **Agent:** frank2 only

## Goal

Add a deterministic Stop-hook backstop so that when frank2 answers a Telegram inbound in text but forgets to actually `cortextos bus send-telegram` it, the turn is **blocked once** with a reason that tells frank2 to deliver the reply it already wrote. Prevents the 2026-07-17 "silent frank2" delivery failure from recurring.

## Deliverables (3 build items)

1. **New hook:** `orgs/clearworksai/agents/frank2/.claude/hooks/assert-telegram-delivery.sh` — pure bash + jq, `set +e`, fail-open.
2. **Settings wiring:** append the new hook as the THIRD command in `hooks.Stop[0].hooks` of `orgs/clearworksai/agents/frank2/.claude/settings.json` (after `hook-idle-flag` and `gate-pipeline-stop.sh`).
3. **Test:** `tests/unit/hooks/assert-telegram-delivery.test.ts` (vitest, drives the shell via `spawnSync`), 5 cases.

## Detection logic (summary — full algorithm in 03-specs)

Read stdin JSON → `transcript_path`, `stop_hook_active`.

1. `stop_hook_active == true` → **exit 0** (loop guard: only nudge once).
2. `transcript_path` empty / not a file → **exit 0** (fail-open).
3. Find the **LAST `type:"user"`** message in the transcript tail. Coerce its `message.content` to a string. If it does NOT contain `=== TELEGRAM from` → **exit 0** (not a Telegram turn).
4. Within the messages **after that last user message** (this turn's assistant activity):
   - `SENT` = did any assistant `tool_use` with `name=="Bash"` have `.input.command` containing `send-telegram`?
   - `HAS_TEXT` = did any assistant message contain a non-empty `type:"text"` block?
5. **BLOCK** only when: Telegram inbound AND `HAS_TEXT` AND NOT `SENT`. Otherwise **exit 0**.
6. Block-once guard: on the block path, honor `stop_hook_active` (step 1 already covers the re-entry, since a Stop hook block sets `stop_hook_active` on the next Stop). Emit `{"decision":"block","reason":...}` via `jq -Rn`, then `exit 0`.
7. Any `jq` failure anywhere → treat as parse-miss → **exit 0** (fail-open).

## Block-vs-allow truth table

| stop_hook_active | last user = TG inbound | turn has assistant text | send-telegram fired | Result |
|---|---|---|---|---|
| true | — | — | — | ALLOW (exit 0) — loop guard |
| false | no | — | — | ALLOW — not a TG turn |
| false | yes | no | — | ALLOW — tool-only / still-working turn |
| false | yes | yes | yes | ALLOW — delivered |
| false | yes | yes | no | **BLOCK** — wrote a reply, never sent |
| (transcript unreadable / jq fails, any row) | — | — | — | ALLOW — fail-open |

## Edge cases handled

- **Loop guard:** `stop_hook_active` true → immediate allow. A block sets this flag on the subsequent Stop, so frank2 can never be trapped.
- **Fail-open:** missing/unreadable `transcript_path`, empty payload, or any `jq` non-zero → exit 0. The hook must NEVER crash or hard-block frank2's turn on its own error.
- **String vs array content:** the inbound marker check coerces `message.content` to a string first (real inbounds are often plain strings, not block arrays) — otherwise real Telegram turns are missed.
- **Tool-only turns:** Telegram inbound but no assistant text this turn (frank2 is mid-work, will reply on a later turn) → allow. We do NOT force a send on every tool-running turn, only on turns that produced a user-facing answer.
- **Marker in assistant text:** the marker string also appears inside skill/doc templates quoted by the assistant. We only inspect the LAST `type:"user"` message for the inbound decision, never assistant text, so quoted templates don't false-trigger.
- **`send-message` ≠ delivery:** only `send-telegram` counts as delivery. Agent-to-agent `send-message` does not surface to Josh.

## Out of scope

- The OTHER half of the 2026-07-17 incident (turn-derail / lost-thread / "already answered above" reasoning bug) — separate work item.
- Any other agent's hooks or settings. **frank2 only.**
- Editing the telegram-inbound skill prose (this is the hard backstop; the skill nudge is a separate soft layer if desired later).
- Changing `send-telegram` delivery internals in `src/`.

## Verify

- `npm run build` (TypeScript compiles).
- `npm test` — new `assert-telegram-delivery.test.ts` passes all 5 cases; the hook-present `describe.skip` guard keeps CI green where the gitignored hook is absent, matching `hook-gates.test.ts`.
- Manual: pipe a synthetic block-case payload into the hook, confirm `{"decision":"block",...}` on stdout and exit 0; pipe an unreadable path, confirm empty stdout + exit 0.
