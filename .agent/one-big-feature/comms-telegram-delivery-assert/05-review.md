# 05 — Adversarial Review & True-Verify: comms-telegram-delivery-assert

**Verdict: PASS** (logic + true-verify). One ship-model note for Josh (gitignored artifacts) carried forward from the prior review — not a code defect.
**Reviewer:** architect (Opus) · **Date:** 2026-07-18
**Scope:** frank2 Stop hook `assert-telegram-delivery.sh` + settings.json wiring + tracked vitest. Frank2-only, no other agent files touched. Matches spec exactly.

---

## Per-check findings

### Blocks ONLY when: last-user = TELEGRAM inbound AND assistant text present AND no send-telegram tool_use
PASS. Gate order: loop-guard → transcript readable → last user is `=== TELEGRAM from` → compute `SENT` (Bash tool_use whose `.input.command` contains `send-telegram`) and `HAS_TEXT` (non-empty assistant text). Blocks only on `HAS_TEXT=true AND SENT=false`. Verified live:
- True positive (TG inbound + text, no send) → blocks, emits valid `{"decision":"block",...}` (reason_len 579).
- Assistant text that literally contains the words "send-telegram" but makes no Bash call → still blocks. Detection keys on `tool_use.name=="Bash"` + `.input.command`, never on prose — an agent can't fool the gate by mentioning the command in text.

### Fail-open (any other case must ALLOW)
PASS on every path:
- Last user is a *later* non-TG message (TG inbound earlier in the turn) → allow. `rindex("user")` correctly anchors to the true last user turn.
- Whitespace-only assistant text (`gsub("\\s";"")` → length 0) → HAS_TEXT false → allow.
- Tool-only turn (Read, no text block) → allow (test f).
- Non-TG inbound → allow (test c).
- Delivered turn (send-telegram Bash present) → allow (test b).
- Malformed / non-JSON transcript line → jq errors `2>/dev/null` + result-guarded → allow.
- Missing/unreadable transcript path → allow (test e).

### stop_hook_active short-circuit (loop guard)
PASS. Line 14 `[ "$STOP_ACTIVE" = "true" ] && exit 0` fires before any transcript work. Test d confirms allow. Prevents an infinite Stop loop after the single block. Reason string self-documents "blocks once, then yields."

### Always exit 0 / block via stdout JSON only
PASS. Every exit is `exit 0`; block signaled purely by stdout JSON. `set +e` (not `set -euo pipefail`), so a parse miss fails open rather than aborting the daemon. Matches `gate-pipeline-stop.sh` idiom.

### settings.json wiring
PASS. `hooks.Stop[0].hooks` has exactly 3 entries in order: `hook-idle-flag` → `gate-pipeline-stop.sh` → `assert-telegram-delivery.sh` (absolute path, timeout 10). Existing two entries unchanged; valid JSON.

### Test quality (no `any`, no console.log, self-skip when hook absent)
PASS. grep for `console.log` / `: any` / `<any>` → NONE. Fixtures typed `Array<Record<string, unknown>>`. `describeHook = existsSync(hookPath) ? describe : describe.skip` gates on the gitignored per-agent hook so CI stays green when the file is absent. 6 cases (5 required + tool-only 6th).

### Executable bit
PASS. `-rwx------`.

---

## True-verify (this review, run from repo root)
- `npx vitest run tests/unit/hooks/assert-telegram-delivery.test.ts` → **6 passed / 6**, exit 0.
- `npm run build` → clean, exit 0.
- `bash -n .../assert-telegram-delivery.sh` → OK, exit 0.
- settings.json → valid JSON, hook is 3rd Stop entry.
- 5 adversarial probes (above) all behaved as specified.
Full evidence in `06-true-verify-evidence.txt`.

---

## Risks / notes (non-blocking)
- **400-line tail window:** a pathologically long derailed turn could push the TG inbound out of the tail window → no user line found → fail-open (allow, never false-block). Safe direction; bump the tail only if silent-replies ever slip through on very long turns.
- **Marker coupling:** detection depends on the literal `=== TELEGRAM from` inbound marker. If that inbound format ever changes, the gate silently stops firing (fails open). Keep the marker stable; flag to whoever owns the inbound formatter.

## SHIP-MODEL note for Josh (carried from prior review — not a defect)
The hook + settings.json are gitignored per-agent artifacts (no agent `.claude/` file is repo-tracked; `gate-pipeline-stop.sh` is itself an untracked local copy). The hook is already installed live in frank2. Only the **test** is PR-able, and it `describe.skip`s in CI when the hook is absent, so CI stays green. Activation = frank2 restart. Options: (A) accept the local install + restart frank2 + PR the test-only guard — recommended, matches existing hook precedent; (B) build a tracked hook-template/deploy mechanism first. Josh's call — this is a delivery-model decision, not a code fix.
