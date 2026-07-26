# Spec 01 — Remove the in-memory cron creation path (Scope A)

## Problem
Session-only crons (Claude Code `CronCreate` tool, `/loop`-as-persistent-cron teaching) die on
restart but report "registered". Templates already teach against them
(`templates/agent/CLAUDE.md:27` and `:146`), and template `settings.json` allowlists do NOT
include CronCreate — but `bus fix-agent-settings` re-injects the tools fleet-wide.

## Changes

### 1. `src/cli/bus.ts` — `fix-agent-settings` REQUIRED_ALLOW (lines 4605-4611)
Current:
```ts
    const REQUIRED_ALLOW = [
      'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
      'ToolSearch', 'CronCreate', 'CronList', 'CronDelete', 'Skill', 'Agent',
    ];
```
Remove `'CronCreate', 'CronList', 'CronDelete'` (pending Josh decision — minimum: remove
`CronCreate`). ADD a removal pass: `fix-agent-settings` should also STRIP these names from
existing `allow` arrays it patches (today it only adds missing entries — see the loop starting
~bus.ts:4630). `--dry-run` must show strips as well as adds.

### 2. Live agent settings sweep
Run the updated `fix-agent-settings` across `orgs/*/agents/*/.claude/settings.json`
(grep on 2026-07-25 found no live CronCreate entries in orgs — the sweep is a guard, cheap).

### 3. Template/skill teaching sweep
Files with residual `CronCreate` mentions (confirmed by grep):
- `templates/agent/CLAUDE.md`, `templates/agent/AGENTS.md`
- `templates/analyst/CLAUDE.md`, `AGENTS.md`, `ONBOARDING.md`
- `templates/agent/.claude/skills/agent-management/SKILL.md`, `guardrails-reference/SKILL.md`
- `templates/analyst/.claude/skills/agent-management/SKILL.md`, `cron-management/SKILL.md`,
  `guardrails-reference/SKILL.md`
Rewrite so the ONLY documented persistent-cron path is
`cortextos bus add-cron <agent> <name> <interval> <prompt>`, and one-shot reminders route via
the bus reminder commands (`bus.ts:3397` block), NOT `CronCreate {recurring:false}`.
Keep the existing "Do NOT use CronCreate or /loop" warnings — they are correct.

### 4. `src/utils/cron-teaching-scanner.ts`
Update the suggestion string at line ~81 — currently:
```ts
"Use 'cortextos bus add-cron <agent> <name> <interval> <prompt>' for persistent crons. Keep CronCreate only for one-shot reminders (recurring: false)."
```
Drop the "Keep CronCreate for one-shot reminders" clause; point one-shots at `bus` reminders.
Scanner patterns (line ~118) already match CronCreate/CronList/CronDelete//loop — verify they
catch the template files above; extend if a mention survives a scan.

## Edge cases
- An agent mid-session with CronCreate already in its session tool set: removal takes effect on
  next session start; no live-session migration needed.
- Hermes-runtime agents manage crons natively (`agent-manager.ts:1290-1295`) — do not touch
  Hermes teaching, only the Claude Code tool path.
- Do NOT remove the `CronCreate`-shaped injected text the daemon scheduler emits on fire
  (`agent-manager.ts` comment near startAgentCronScheduler) — that is output formatting, not a tool.

## Test that proves it
- New unit test: `fix-agent-settings --dry-run` on a fixture settings.json containing
  `CronCreate` shows a STRIP, and result JSON has no Cron* tools.
- `cortextos bus cron-teaching` scan over `templates/` exits clean (no flagged teaching).
- Grep-gate test: `grep -r "CronCreate" templates/*/.claude/settings.json` → empty (already
  true; the test pins it).
