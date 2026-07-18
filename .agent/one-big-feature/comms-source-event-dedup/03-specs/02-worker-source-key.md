# Spec 02 — Emitting workers pass a deterministic source key

## Grounding: who actually emits the duplicate pings

The emitters are **LLM worker prompts (SKILL.md files), not TypeScript** — there is no
compiled "meeting-reminder worker" in `src/`. Verified via:

```
grep -rln "meeting" src/ community/ --include=*.ts
  → only src/bus/meeting-brief.ts, src/utils/meeting-alert-gate.ts, src/cli/bus.ts
grep -rln -i "meeting" orgs/clearworksai/agents/{automator,pa,frank2}
grep -rln -i "comms-check|meeting-commitments" community/ orgs/
```

Identified emit sites (the literal `cortextos bus send-telegram 6690120787 "…"` calls the
LLM is instructed to make):

| # | File | Emit-site anchor | Git status | Notes |
|---|------|------------------|-----------|-------|
| 1 | `orgs/clearworksai/agents/pa/.claude/skills/comms-check-worker/SKILL.md` | Step 4c lines 143-177 (meeting-alert-gate call, lines 160-165) + Step 5 "Meeting reminders" bullet lines 190-192; Telegram target declared line 14 | **git-ignored** (agent-local; `git check-ignore` exit 0) | Current rev already has the Step 4c gate (PR #109) — honor-system, upstream of the send |
| 2 | `orgs/clearworksai/agents/frank2/.claude/skills/comms-check-worker/SKILL.md` | Telegram sends at lines 14, 145, 149 | git-ignored | **Older revision — has NO Step 4c meeting gate at all.** This copy can still emit ungated meeting pings |
| 3 | `orgs/clearworksai/agents/automator/.claude/skills/comms/SKILL.md` line 16 + `orgs/clearworksai/agents/pa/.claude/skills/comms/SKILL.md` | `Reply using: cortextos bus send-telegram <chat_id> "<your reply>"` | git-ignored | Automator's freeform send path — how the ERatePros 4× dupes went out. Automator currently has only a `heartbeat` cron (`~/.cortextos/cortextos1/state/automator/cron-state.json`), so its meeting pings come from ad-hoc/comms-driven sessions, not a dedicated cron |
| 4 | `community/skills/comms/SKILL.md` line 17 | same `Reply using:` template | **git-TRACKED** (repo template distributed to agents) | The durable, reviewable lever |

**Gap statement (explicit):** the exact Automator session/cron that composed the original
4 reworded ERatePros/Dean Wilcox pings is not recoverable from tracked source — automator
has no meeting cron today and its cron-state shows only `heartbeat`. That is precisely why
the enforcement moves to the `bus.ts` choke point (Spec 01); the SKILL.md edits below are
the instruction layer, not the enforcement layer.

`orgs/clearworksai/agents/pa/.claude/skills/meeting-commitments-worker/SKILL.md` (and the
frank2 copy) dedup on the extractor's deterministic commitment id (Step 4, lines 80-91) —
already identity-keyed, per-item file-based. Optional migration to `--source-key
pa:ffcommit-<id>` is a follow-up, NOT in this OBF's scope.

## Change 1 — `community/skills/comms/SKILL.md` (tracked; codexer or Larry)

After the message-format section (the `Reply using: cortextos bus send-telegram …` line 17),
add a short section:

```markdown
## Proactive event-driven pings — always pass --source-key

If you are notifying about a SOURCE EVENT (a meeting, a calendar change, an email thread,
an alert) rather than replying to a human message, you MUST pass a deterministic identity
key so the same event can never ping twice regardless of wording:

    cortextos bus send-telegram <chat_id> "<message>" \
      --source-key "<agent>:meeting-<eventId>" --source-ttl-sec 43200

Key = <your-agent-name>:<event-type>-<stable-id>. Use the calendar event id for meetings,
the Gmail thread id for email threads (`<agent>:thread-<threadId>`), the run id for CI.
NEVER derive the key from your own generated wording. If the send prints
"Message suppressed (source event ...)", the event was already announced — stop; do not
reword and resend.
```

## Change 2 — pa `comms-check-worker/SKILL.md` (git-ignored → **Larry edits directly**, hook-safe)

In Step 4c (lines 143-177): keep the `meeting-alert-gate` pre-check, and extend the
`"surface":true` instruction (lines 170-172) so the single permitted Telegram carries the
same identity to the choke point:

```bash
# On "surface":true — send exactly ONE Telegram, carrying the meeting identity:
if [ -n "$EVENT_ID" ]; then KEY="pa:meeting-${EVENT_ID}"; else KEY="pa:meeting-$(echo "$MEETING_TITLE" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9')-${MEETING_DATE}"; fi
cortextos bus send-telegram 6690120787 "<the one reminder>" --source-key "$KEY" --source-ttl-sec 43200
```

Key derivation mirrors `deriveMeetingKey` (`src/utils/meeting-alert-gate.ts:35-53`):
event id preferred; fallback = lowercased alphanumeric subject + the MEETING's local date
(`YYYY-MM-DD`), so two different meetings on the same day still get distinct keys.
Namespace `pa` (lowercase, matches `SOURCE_KEY_PATTERN` `/^[a-z0-9_-]{1,32}:…/`).

Also update the Step 5 "Meeting reminders / meeting updates" bullet (lines 190-192) to
state the `--source-key` requirement.

## Change 3 — frank2 `comms-check-worker/SKILL.md` (git-ignored → Larry)

Bring to parity with the pa revision (it currently lacks Step 4c entirely): copy the pa
file, change the namespace in derived keys to `frank2:` (or keep the worker's
`${CTX_PARENT_AGENT}` convention). This closes the one emit site that today has neither
gate nor key.

## Change 4 — automator + pa agent-local `comms/SKILL.md` (git-ignored → Larry)

Apply the same section as Change 1 with the agent's own namespace
(`automator:meeting-<eventId>`, `automator:thread-<gmailThreadId>`). This is the direct
fix for the observed Automator behavior: all four reworded ERatePros compositions would
have carried `automator:meeting-<same-eventId>` and sends 2-4 would have been suppressed
by the ledger at the choke point.

## TTL to pass

`--source-ttl-sec 43200` (12 h) for meeting reminders — see master plan §4 for the
fire-once rejection (recurring-event base ids + 365 d fire-once retention would suppress
future instances) and the 12 h rationale (covers the observed ~2 h dupe storm and a full
day of worker cycles; next-day/next-week instances still surface). Thread-alert keys
(`<agent>:thread-<threadId>`) may omit the flag and take the 30 d default — a thread is a
one-time announce.
