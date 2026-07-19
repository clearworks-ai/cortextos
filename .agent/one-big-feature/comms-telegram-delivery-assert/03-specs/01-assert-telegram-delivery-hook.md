# Spec 01 — assert-telegram-delivery Stop hook

**Slug:** `comms-telegram-delivery-assert` · **Agent:** frank2 only · Build exactly as written; do not guess.

---

## Files

1. CREATE `orgs/clearworksai/agents/frank2/.claude/hooks/assert-telegram-delivery.sh` (bash, `chmod +x`).
2. EDIT `orgs/clearworksai/agents/frank2/.claude/settings.json` — append one command to `hooks.Stop[0].hooks`.
3. CREATE `tests/unit/hooks/assert-telegram-delivery.test.ts` (vitest).

Dependencies: pure `bash` + `jq` only (same as `gate-pipeline-stop.sh`). No new runtime deps. No `console.log`, no `any` in the test.

---

## 1. Hook script — `assert-telegram-delivery.sh`

### Contract
- Input: Stop-hook stdin JSON with (at least) `transcript_path` (string) and `stop_hook_active` (bool).
- Output: nothing (exit 0 = allow) OR a single line `{"decision":"block","reason":<json-string>}` then exit 0.
- **Always exit 0.** Blocking is signaled by the JSON on stdout, never by exit code. This matches `gate-pipeline-stop.sh`.
- **Fail-open everywhere:** any missing field, unreadable file, or jq error → produce no output, exit 0.

### Detection algorithm (step by step)

1. `set +e` at top (do NOT use `set -euo pipefail` — a parse miss must fail open, not abort with an error the daemon could misread). Add a short header comment explaining the hook's purpose and the fail-open/loop-guard safety, mirroring the style of `gate-pipeline-stop.sh`.

2. `PAYLOAD="$(cat 2>/dev/null)"`.

3. Parse:
   ```
   STOP_ACTIVE="$(printf '%s' "$PAYLOAD" | jq -r '.stop_hook_active // false' 2>/dev/null)"
   TRANSCRIPT="$(printf '%s' "$PAYLOAD" | jq -r '.transcript_path // empty' 2>/dev/null)"
   ```

4. **Loop guard:** `[ "$STOP_ACTIVE" = "true" ] && exit 0`.

5. **Fail-open on transcript:** `[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0`.

6. **Read the tail** of the transcript for performance (a turn is small; use a generous tail):
   ```
   TAIL="$(tail -n 400 "$TRANSCRIPT" 2>/dev/null)"
   [ -n "$TAIL" ] || exit 0
   ```
   Process the transcript as line-delimited JSON with `jq -s` (slurp) so we can index positionally. All `jq` invocations get `2>/dev/null` and their result is guarded; on empty/failure, exit 0.

7. **Find the index of the LAST `type:"user"` message** in the slurped array, and confirm it is a Telegram inbound. Content may be a **string OR an array** — coerce with `tostring` and substring-match the marker:
   ```
   LAST_USER_IS_TG="$(printf '%s' "$TAIL" | jq -rs '
     (map(.type) | rindex("user")) as $i
     | if $i == null then "no"
       else ((.[$i].message.content | tostring) | contains("=== TELEGRAM from")) end
   ' 2>/dev/null)"
   ```
   If this is not exactly `true` → `exit 0` (not a Telegram inbound turn; also covers the "no user message" and jq-error cases, which yield `no`/empty/`false`).

8. **Inspect this turn's assistant activity = messages AFTER that last user index.** Compute in one jq pass two booleans — `SENT` (a Bash `send-telegram` tool_use) and `HAS_TEXT` (a non-empty assistant text block):
   ```
   FLAGS="$(printf '%s' "$TAIL" | jq -rs '
     (map(.type) | rindex("user")) as $i
     | if $i == null then "err"
       else
         (.[($i+1):]) as $after
         | ([ $after[]
              | select(.type=="assistant")
              | .message.content[]?
              | select(.type=="tool_use" and .name=="Bash")
              | ((.input.command // "") | contains("send-telegram")) ]
            | any) as $sent
         | ([ $after[]
              | select(.type=="assistant")
              | .message.content[]?
              | select(.type=="text")
              | ((.text // "") | gsub("\\s";"") | length > 0) ]
            | any) as $hastext
         | "\($sent) \($hastext)"
       end
   ' 2>/dev/null)"
   ```
   Guard: if `FLAGS` is empty or `err` → `exit 0` (fail-open).
   Split: `SENT="${FLAGS%% *}"`, `HAS_TEXT="${FLAGS##* }"`.

   NOTE for the array/string content case on the assistant side: assistant messages in this transcript are consistently `content` arrays of blocks (verified), so `.message.content[]?` is correct for the assistant scan. The `[]?` operator safely yields nothing if content is ever a string, which keeps it fail-open.

9. **Decision:**
   - If `SENT` = `true` → delivered → `exit 0`.
   - If `HAS_TEXT` != `true` → tool-only / still-working turn → `exit 0`.
   - Else (`HAS_TEXT` true AND `SENT` false) → **BLOCK**.

10. **Emit block** using the exact reason string below, JSON-escaped via `jq -Rn`, then `exit 0`:
    ```
    printf '{"decision":"block","reason":%s}\n' "$(jq -Rn --arg r "$REASON" '$r')"
    exit 0
    ```

### Exact block-reason string (`$REASON`)

```
TELEGRAM DELIVERY GATE: this turn answered a Telegram inbound with reply text but NEVER called `cortextos bus send-telegram`. Assistant text is NOT delivered — `cortextos bus send-telegram <chat_id> '<your reply>'` is the ONLY path that surfaces in Telegram and on the dashboard. From your side it looks answered ("already replied above"); Josh sees silence. Before stopping, DELIVER the reply you just wrote: run `cortextos bus send-telegram <chat_id> '<reply>'` using the chat_id from the "=== TELEGRAM from ... (chat_id:...) ===" inbound. (This gate blocks once, then yields.)
```

Store it in a `REASON` shell variable (heredoc or quoted assignment); do not inline it into the printf.

---

## 2. settings.json wiring

In `orgs/clearworksai/agents/frank2/.claude/settings.json`, the `hooks.Stop` array has one group whose `hooks` array currently holds two objects (`hook-idle-flag`, then `gate-pipeline-stop.sh`). **Append this third object** to that same `hooks` array, after `gate-pipeline-stop.sh`:

```json
{
  "type": "command",
  "command": "/Users/joshweiss/code/cortextos/orgs/clearworksai/agents/frank2/.claude/hooks/assert-telegram-delivery.sh",
  "timeout": 10
}
```

Resulting `hooks.Stop`:

```json
"Stop": [
  {
    "hooks": [
      { "type": "command", "command": "cortextos bus hook-idle-flag", "timeout": 5 },
      { "type": "command", "command": ".../frank2/.claude/hooks/gate-pipeline-stop.sh", "timeout": 10 },
      { "type": "command", "command": ".../frank2/.claude/hooks/assert-telegram-delivery.sh", "timeout": 10 }
    ]
  }
]
```

(Use the full absolute path for the new command, exactly as the `gate-pipeline-stop.sh` entry does. Do not alter the existing two entries.)

---

## 3. Test — `tests/unit/hooks/assert-telegram-delivery.test.ts`

Match the style of `tests/unit/pipeline/hook-gates.test.ts`: vitest, `spawnSync('bash',[scriptPath],{input:JSON.stringify(payload),encoding:'utf-8'})`, tmp fixtures via `mkdtempSync`, cleanup in `afterEach`, and a **hook-present guard** (`existsSync(hookPath) ? describe : describe.skip`) since the hook is a gitignored per-agent artifact absent in CI.

### Helpers
- `hookPath = resolve(__dirname, '../../../orgs/clearworksai/agents/frank2/.claude/hooks/assert-telegram-delivery.sh')`.
- A `transcriptLine(type, message)` builder that emits one JSON line `{type, message:{role, content}}` (mirror hook-gates.test.ts).
- `writeTranscript(lines: string[]): string` → writes to a tmp `.jsonl` file, returns its path.
- `runHook(payload)` → `spawnSync('bash',[hookPath],{input:JSON.stringify(payload),encoding:'utf-8'})`.
- Fixture blocks:
  - Telegram-inbound user line: `type:"user"`, `content` as the **string** `"=== TELEGRAM from [USER: pd88] (chat_id:6690120787) ===\nwhat's the status?"`.
  - Non-telegram user line: `type:"user"`, `content:"just a normal message"`.
  - Assistant text block: `{type:"assistant", message:{role:"assistant", content:[{type:"text", text:"Here is your answer: all green."}]}}`.
  - Assistant send block: `{type:"assistant", message:{role:"assistant", content:[{type:"tool_use", name:"Bash", input:{command:"cortextos bus send-telegram 6690120787 'all green'"}}]}}`.

### 5 cases + expected outcomes

| # | Fixture (transcript, in order) | payload | Expect |
|---|---|---|---|
| a | TG-inbound user → assistant TEXT (no send) | `{transcript_path, stop_hook_active:false}` | `status===0` AND `stdout` contains `"decision":"block"` AND contains `TELEGRAM DELIVERY GATE` |
| b | TG-inbound user → assistant TEXT → assistant send-telegram Bash | `{transcript_path, stop_hook_active:false}` | `status===0` AND `stdout.trim()===''` (no block) |
| c | non-TG user → assistant TEXT (no send) | `{transcript_path, stop_hook_active:false}` | `status===0` AND `stdout.trim()===''` |
| d | TG-inbound user → assistant TEXT (no send) | `{transcript_path, stop_hook_active:true}` | `status===0` AND `stdout.trim()===''` (loop guard) |
| e | (no fixture) unreadable path | `{transcript_path:'/tmp/does-not-exist-<rand>.jsonl', stop_hook_active:false}` | `status===0` AND `stdout.trim()===''` (fail-open) |

Optional 6th (recommended, not required): TG-inbound user → assistant tool_use ONLY, no text block, no send → allow (tool-only turn). Same shape as (c)'s assertion.

---

## Acceptance criteria

1. `assert-telegram-delivery.sh` exists, is executable, pure bash+jq, `set +e`, always exits 0.
2. Blocks **only** on: last user message is a `=== TELEGRAM from` inbound AND this turn produced non-empty assistant text AND no `send-telegram` Bash tool_use fired after that inbound.
3. Allows on: `stop_hook_active:true`; non-Telegram inbound; tool-only turn (no assistant text); a turn that did call `send-telegram`; and any unreadable-transcript / jq-error (fail-open).
4. Block output is exactly `{"decision":"block","reason":<escaped>}` where reason is the verbatim string in §1, jq-escaped.
5. `settings.json` `hooks.Stop[0].hooks` has the new command as the 3rd entry; existing two entries unchanged; file remains valid JSON.
6. `tests/unit/hooks/assert-telegram-delivery.test.ts` passes all 5 (or 6) cases; no `any`, no `console.log`; uses the `describe.skip`-when-hook-absent guard.
7. `npm run build` clean; `npm test` green.
8. Scope: frank2 only — no other agent's files touched.
