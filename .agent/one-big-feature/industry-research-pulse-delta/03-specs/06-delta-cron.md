# Spec 06 — `research-pulse-delta` cron entry

**Target file (tracked edit):** `community/agents/research-agent/config.json`
**Change:** ONE new object appended to the existing `crons` array. Nothing else in the file
changes.

## Why this file (runtime-home decision — resolved, do not reopen)

P1 promoted the research-pulse skill to the TRACKED `community/agents/research-agent/` location
(Option B); `orgs/clearworksai/agents/muse/` is gitignored, so muse's config cannot be the
shipped, PR-able artifact. **Post-merge runtime-activation caveat (verbatim from research
doc):** the research-agent is not currently running; muse is the live runtime owner (per plan),
but its config is gitignored so cannot be the shipped artifact. Post-merge runtime activation
(start research-agent OR register the cron on live muse pointing at the tracked
`delta_check.py` path) is a separate runtime op — noted, NOT a blocker for the P2 build/PR.
Flagged to Josh in the surface. The BUILD deliverable is exactly this tracked config edit.

## Entry schema (field-exact — match the sibling crons)

The `crons` array entries in this file (and the `CronEntry` interface at
`src/types/index.ts:263`) use exactly these fields: `name` (string), `type`
(`"recurring" | "once" | "disabled"`), `cron` (cron expression, takes precedence over
`interval`) OR `interval`, and `prompt` (string). There is **no `id` and no `enabled`
field** — identity is `name`, and "enabled" is expressed as `type: "recurring"` (vs
`"disabled"`). Match the sibling entries (`daily-research-brief`, `topic-briefing`) exactly in
shape, including the trailing `update-cron-fire` instruction inside the prompt.

## The new entry

Append to `crons`:

```json
{
  "name": "research-pulse-delta",
  "type": "recurring",
  "cron": "15 6,18 * * *",
  "prompt": "Run the research-pulse delta check: execute `python3 .claude/skills/research-pulse/scripts/delta_check.py` and read the JSON run summary it prints. SILENT-OK: if new_deltas is 0 and there are no errors, log the run and send NOTHING to Telegram. If new_deltas >= 10 in this run, send a Telegram digest of the newest items grouped by vertical. If any source was auto-deactivated (summary `deactivated` non-empty), send a bus message to larry (eng owner) naming the deactivated source ids — never page Josh raw for feed health. When finished, run: cortextos bus update-cron-fire research-pulse-delta --interval \"15 6,18 * * *\""
}
```

Schedule notes:
- `15 6,18 * * *` = 06:15 and 18:15 UTC — every 12h, offset from the top of the hour to avoid
  the feed-server rush (research-doc decision).
- The script path is relative to the agent's working directory (agent home), matching how the
  sibling prompts reference `.claude/skills/...` paths.

## Reporting contract (restated — the prompt above IS the enforcement point)

- **SILENT-OK:** `new_deltas == 0` and no errors → log only, no Telegram. (Fleet SILENT-OK
  rule.)
- **Escalate — delta flood:** `new_deltas >= 10` in one run → Telegram digest, newest items
  grouped by vertical.
- **Escalate — source death:** any source in the summary's `deactivated` list → message to
  larry, not Josh raw (Railway/feed-health = larry).

## Acceptance

- The edited `community/agents/research-agent/config.json` is valid JSON and the entry matches
  the sibling crons' field shape.
- `npm run build && npm test` in cortextos stays green (the crons config machinery validates
  the entry; this change adds ZERO TypeScript source changes).
- No other keys in config.json are touched.

## Test note

All fixtures and `test_delta_check.py` unit coverage belong to spec 05. Spec 06's verification
is the config edit itself + the schema-validity check via `npm run build && npm test` — no new
test files here.
