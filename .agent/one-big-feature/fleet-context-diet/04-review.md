# Review — fleet-context-diet spec04 (front-context cuts)

Branch: `fix/front-context-cuts-ship`
Spec: `.agent/one-big-feature/fleet-context-diet/03-specs/04-front-context-cuts.md`
Changes: `~/.claude/hooks/wal-protocol.js`, `~/.claude/settings.json`, 11 skill symlinks moved, 2 agent files moved.

---

## Scope

4 independent cuts, no cortextos src/ changes. Zero fork-drift added.

- **CUT 2**: `~/.claude/hooks/wal-protocol.js` — 4-line early-exit when `additionalContext` is empty
- **CUT 4**: `~/.claude/settings.json` — removed second UserPromptSubmit hook group (caveman-mode-tracker standalone)
- **CUT 1**: 11 skill symlinks moved `~/.claude/skills/<name>` → `~/.claude/skills-disabled-2026-07-26/<name>`
- **CUT 3**: 2 agent .md files moved `~/.claude/agents/agency/` → `~/.claude/agents-disabled-2026-07-26/`

Evidence artifacts committed to `.agent/one-big-feature/fleet-context-diet/` in this branch.

---

## Checklist

### 1. SCOPE MATCH — PASS
All 4 cuts present, nothing outside scope. No cortextos runtime code changed.
The cortextos PR carries only: this review file, 05-true-verify.md, ROLLBACK.md, the checker script,
and the audit output JSON. All config changes live in `~/.claude` (clearworks-ai/claude-config repo).

### 2. CUT 2 CORRECTNESS — PASS

Logic added:
```js
// CUT-2: suppress empty envelope — saves ~760B / PostToolUse fire (was ~3.2k/restart)
if (!additionalContext) {
  process.exit(0);
}
```
Placed AFTER the `if (isDownloadsWrite)` block sets `additionalContext`, BEFORE `process.stdout.write`.

Gate conditions verified:
- `additionalContext` is `''` (falsy) when `isDownloadsWrite` is false → exits 0, emits nothing. CORRECT.
- `additionalContext` is non-empty string when `isDownloadsWrite` is true → proceeds to stdout.write. CORRECT.
- Malformed JSON input → catch block hits `process.exit(0)` unchanged. CORRECT.
- `tool_name` not in `['Write','Edit']` → `isContentTool=false` → `isDownloadsWrite=false` → `additionalContext=''` → exits 0. CORRECT.

Unit tests (manual, from spec goal condition 1):
- `printf '{"tool_name":"Bash","tool_input":{}}' | node ~/.claude/hooks/wal-protocol.js` → 0 bytes. PASS.
- `printf '{"tool_name":"Write","tool_input":{"file_path":"/Users/joshweiss/Downloads/x.md"}}' | node ~/.claude/hooks/wal-protocol.js` → FILE LOCATION WARNING JSON. PASS.
- `printf 'not json' | node ~/.claude/hooks/wal-protocol.js` → 0 bytes, exit 0. PASS.

### 3. CUT 4 CORRECTNESS — PASS

`grep -c caveman-mode-tracker ~/.claude/settings.json` = 0.
Plugin registration in `~/.claude/plugins/cache/caveman/.../.claude-plugin/plugin.json` untouched.
Backup exists at `~/.claude/settings.json.bak-caveman-dedup-spec04-<timestamp>`.

Risk: if plugin copy silently fails and standalone was live → per-turn caveman reminders drop to 0.
Mitigation: post-change assertion requires count == 1 per prompt (not 0); rollback is one cp command.

### 4. CUT 1 CORRECTNESS — PASS

Checker scanned 5063 transcript files (mtime ≤7d, ALL ~/.claude/projects/*/*.jsonl including
Josh's own sessions and sidechains). 11 move candidates confirmed 0 hits.

Protected list verified — all still present in ~/.claude/skills/:
m2c1, goalify, graphify, context-save, context-restore, adversarial-review, test-on-staging,
last30days, deep-research, context-budget, and all gws-*/worker-/caveman-prefixed/suffixed names.

All 11 moved skills are symlinks (→ ~/.agents/skills/<name>), not real directories.
Reversible with one `mv` per skill.

### 5. CUT 3 CORRECTNESS — PASS

Both files confirmed moved, agency/ dir removed. Remaining agents/ contents:
architect.md, codex-rescue.md, knox.md, sentinel.md, trace.md — all per protected list.

Note: the spec's ~1.5k savings estimate for CUT 3 is overstated — built-in agent types dominate
agent_listing_delta; the custom-type removals save ~0.3-0.7k realistically. Stated honestly in PR body.

### 6. SAVINGS HONESTY — PASS

PR body states ~4-6k/restart realistic (not the 15k spec target). The skill_listing cut (spec's
primary 15k lever) is Claude-Code-native and not per-agent scopeable without upstream changes.
The realistic lever is the shared-set shrink (11 symlinks removed) + the empty PostToolUse
suppression. Human task (~13k connector cut) flagged for Josh.

### 7. FAIL-OPEN — PASS

wal-protocol.js: the catch branch already exits 0. The new early-exit path also exits 0. No hook
can block Claude Code's prompt submission regardless of input.

### 8. LIVE-TREE CAVEAT — DOCUMENTED

~/.claude is live fleet config. Branch commits apply immediately before PR merge. Documented in PR body.
All changes are moves-not-deletes + hook exits-not-crashes. One-command rollback per cut in ROLLBACK.md.

---

## NON-BLOCKING NOTES

1. 11 symlinks moved vs "zero-use" window is exactly 7 days. Monthly-cadence skills (invoicing, naval,
   zenmillionaire) still present and protected. The 11 moved (brainstorming, best-practices,
   brand-guidelines, cold-email, copywriting, email-sequence, gemini, lesson-learned, performance,
   perplexity, seo) are genuinely inactive in the 7-day window AND are symlinks pointing to the
   ~/.agents/skills/ directory (which still exists), so re-enabling is a single mv.

2. CUT 4 wrong-duplicate risk is real (see ROLLBACK.md watch note). Monitor first post-change
   session transcript for caveman reminder count.

---

## VERDICT: PASS — ready for Josh review and merge.
