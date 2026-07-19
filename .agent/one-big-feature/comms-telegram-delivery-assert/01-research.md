# 01 — Research: assert Telegram delivery on frank2 turns

**Slug:** `comms-telegram-delivery-assert`
**Repo:** `/Users/joshweiss/code/cortextos`
**Agent scope:** frank2 ONLY (do not touch any other agent's hooks/settings)
**Task:** `task_1784303957325`
**Date:** 2026-07-18

---

## The bug (verbatim)

> "When its turn got derailed, frank2 emitted user-facing answers as plain assistant TEXT instead of send-telegram tool calls, so Josh got silence while frank2 believed it replied ('already answered above'). Fix: frank2 comms/telegram-inbound skill must guarantee every user-facing reply ends in an actual send-telegram call; a turn that produces reply text but no send is a bug. Consider a Stop-hook assertion: if inbound was a Telegram user msg and no send-telegram fired this turn, warn/block."

## Root cause

This is the **delivery half** of the 2026-07-17 "frank2-silent" incident (two compounding bugs on the same turn):

1. **(other half, out of scope here)** — the turn got derailed / lost the thread, so frank2 stopped mid-reply thinking it had already answered.
2. **(this half — the delivery bug)** — frank2 *wrote* a user-facing answer as a plain assistant **text block** and ended the turn, but never issued the `cortextos bus send-telegram` Bash call that is the ONLY path which actually surfaces text in Telegram / on the dashboard. From frank2's own point of view the reply existed ("already answered above"); from Josh's point of view it was silence.

The delivery contract frank2 must honor (confirmed in `src/pty/codex-app-server-pty.ts:307` and `src/cli/init.ts:202`):

> Reply via: `cortextos bus send-telegram <chat_id> '<your reply>'` — this is the only path that surfaces in Telegram and on the dashboard.

So: **a turn that answers a Telegram inbound in text but never calls `send-telegram` has failed to deliver.** That is exactly the class of bug a Stop-hook assertion can catch deterministically, because both the trigger (Telegram inbound this turn) and the required action (a `send-telegram` Bash call this turn) are observable in the transcript.

## Where the signals live in the transcript (verified against real frank2 jsonl)

Transcripts: `/Users/joshweiss/.claude/projects/-Users-joshweiss-code-cortextos-orgs-clearworksai-agents-frank2/*.jsonl`, one JSON object per line.

### 1. Telegram inbound marker — VERIFIED

A Telegram inbound arrives as a **`type:"user"`** message whose text content begins with the marker:

```
=== TELEGRAM from [USER: <name>] (chat_id:<digits>) ===
```

Real example line (from `01386fd5-4e0c-4437-b861-2eef669e238d.jsonl`, `type:"user"`):

```
=== TELEGRAM from [USER: pd88] (chat_id:6690120787) ===
[Recent conversation:]
[user]: why is codexer crashing
[frank2]: was actually DOWN — hit daemon max-crash cap ...
```

**Exact verified marker substring to test for:** `=== TELEGRAM from`

Content-shape caveat (must handle both):
- `message.content` is sometimes a **plain string** (the common inbound case), and
- sometimes an **array** of blocks (`[{type:"text", text:"..."}, ...]`).

The detector must stringify/normalize both. A naive `.content[]?|select(.type=="text")` MISSES the string case (verified: one file showed `ctype:"array"` with empty extracted text, another showed `ctype:"string"` with the real marker). Use a "contains on the whole content, coerced to string" check.

NOTE: the same marker string also appears **inside assistant text** (documentation/skill templates that quote the reply instructions). Those are NOT inbounds. The detector therefore only inspects the **last `type:"user"` message**, never assistant text, to decide "was this turn a Telegram inbound."

### 2. send-telegram delivery — VERIFIED

frank2 delivers via a **Bash `tool_use`** whose command contains `send-telegram`. Real examples pulled from the same transcripts:

```
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID 'back — fleet recovered ...'
cortextos bus send-telegram 6690120787 'Yeah — that noise is every agent DMing you ...'
```

**Detection:** an assistant message block with `type=="tool_use"`, `name=="Bash"`, and `.input.command` containing the substring `send-telegram`.

Decision: we assert on **`send-telegram` specifically** (per the task), NOT the broader `send-message`. `send-message` is agent-to-agent bus traffic and does not surface to Josh in Telegram; treating it as "delivered" would defeat the check.

## Current Stop-hook wiring (verified)

`orgs/clearworksai/agents/frank2/.claude/settings.json` → `hooks.Stop` is an array with ONE hook-group containing two commands, run in order:

1. `cortextos bus hook-idle-flag` (timeout 5)
2. `.../frank2/.claude/hooks/gate-pipeline-stop.sh` (timeout 10)

The new assertion is appended as a **third** command after these two.

## Why a Stop hook is the right mechanism

- **Deterministic + observable:** both trigger (Telegram inbound this turn) and required action (a `send-telegram` Bash call this turn) are plainly in the transcript. No LLM judgment needed.
- **Fires at exactly the failure point:** the Stop hook runs when frank2 tries to END the turn — the precise moment "I wrote a reply but never sent it" becomes a completed bug. A `block` decision feeds a reason back into the model and gives it one more turn to actually call `send-telegram`.
- **Matches existing proven pattern:** `gate-pipeline-stop.sh` already demonstrates the exact idiom — read stdin JSON, honor `stop_hook_active`, tail the transcript, emit `{"decision":"block","reason":...}` via `jq -Rn`, block-once-then-yield. We copy that shape; it is battle-tested in this same agent.

## Fail-open requirement (non-negotiable)

A Stop gate that misfires is dangerous — it can trap or silently kill frank2's turn. This hook MUST:
- Exit 0 (allow) if `stop_hook_active` is true — never re-block a turn we already nudged (loop guard).
- Exit 0 if `transcript_path` is missing/unreadable, or if any `jq` parse fails — **fail-open, never block on hook error.**
- Exit 0 for any non-Telegram inbound turn (plain chat, cron, agent-to-agent).
- Exit 0 for tool-only turns (Telegram inbound but frank2 produced NO user-facing text this turn — e.g. it's still working, will reply later). We only block the specific "wrote a reply, forgot to send it" shape.
- Never `set -e` its way into a hard exit on a missing field — use `set +e`-style guards exactly like `gate-pipeline-stop.sh`.

## Confirmed reference facts

- send-telegram is the sole user-facing delivery path: `src/pty/codex-app-server-pty.ts:307`, `src/pty/opencode-pty.ts:293`, `src/cli/init.ts:202`.
- Existing hook-test style (vitest + `spawnSync('bash',[script],{input})` + tmp fixtures + `describe.skip` when the gitignored hook is absent): `tests/unit/pipeline/hook-gates.test.ts`. New test matches this.
