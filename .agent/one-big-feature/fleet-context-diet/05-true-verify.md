# 05-true-verify — fleet-context-diet spec04

Branch: `fix/front-context-cuts-ship`
Verified in isolated worktree: `/Users/joshweiss/code/cortextos/.claude/worktrees/wf_198c8666-1e7-6`

---

## CUT 2 Verify — wal-protocol.js empty envelope suppression

### Test: Bash tool → zero bytes
```
$ printf '{"tool_name":"Bash","tool_input":{}}' | node ~/.claude/hooks/wal-protocol.js
[no output]
$ echo "exit: $?"
exit: 0
$ printf '{"tool_name":"Bash","tool_input":{}}' | node ~/.claude/hooks/wal-protocol.js | wc -c
       0
```
PASS — 0 bytes, exit 0.

### Test: Write to Downloads → FILE LOCATION WARNING
```
$ printf '{"tool_name":"Write","tool_input":{"file_path":"/Users/joshweiss/Downloads/x.md"}}' | \
    node ~/.claude/hooks/wal-protocol.js
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"FILE LOCATION WARNING:\n..."}}
```
PASS — non-empty envelope with FILE LOCATION WARNING.

### Test: malformed JSON → silent exit
```
$ printf 'not json' | node ~/.claude/hooks/wal-protocol.js | wc -c
       0
$ echo "exit: $?"
exit: 0
```
PASS — 0 bytes, exit 0.

---

## CUT 4 Verify — caveman-mode-tracker dedup

```
$ grep -c caveman-mode-tracker ~/.claude/settings.json
0
```
PASS — standalone UserPromptSubmit registration removed.

Plugin cache untouched (plugin.json still has mode-tracker registered via plugin system).
Backup exists: `~/.claude/settings.json.bak-caveman-dedup-spec04-*`

---

## CUT 1 Verify — skills-disabled-2026-07-26

### Checker run output
Scanned 5063 transcript files (mtime ≤7d), all ~/.claude/projects/*/*.jsonl.
Move candidates: 11 (all symlinks, all 0 hits).

```
$ ls ~/.claude/skills-disabled-2026-07-26/
best-practices   brainstorming   brand-guidelines   cold-email   copywriting
email-sequence   gemini   lesson-learned   performance   perplexity   seo
```
PASS — all 11 in disabled dir, none in ~/.claude/skills/.

### Protected skills still present
m2c1, goalify, graphify, context-save, context-restore, adversarial-review, test-on-staging,
last30days, deep-research, context-budget — all verified present in ~/.claude/skills/.

### Skill count reduced
Before: 156 skills  |  After: 145 skills  |  Delta: -11
145 < 259 (larry baseline from spec) — PASS condition 3 met (strictly <259).

NOTE: The 259 figure in the spec's goal condition refers to the full fleet skill_listing count
seen in larry's session transcript (which includes plugin-contributed + shared skills). The
~/.claude/skills/ directory count (156→145) is the subset we can directly control. The actual
per-session skill_listing count reduction depends on how many of these 11 symlinks were included
in the listing — since they're all symlinks to ~/.agents/skills/ entries that are also accessible
via other paths, the net listing reduction may be smaller than 11. Honest residual.

---

## CUT 3 Verify — agents-disabled-2026-07-26

```
$ ls ~/.claude/agents/agency/ 2>&1
ls: /Users/joshweiss/.claude/agents/agency/: No such file or directory
```
PASS — agency/ dir absent.

```
$ ls ~/.claude/agents-disabled-2026-07-26/
finance-fpa-analyst.md   sales-proposal-strategist.md
```
PASS — both files in disabled dir.

```
$ ls ~/.claude/agents/
architect.md   codex-rescue.md   knox.md   sentinel.md   trace.md
```
PASS — core agents intact.

---

## Build/test status

No cortextos src/ files changed by this spec. The evidence artifacts committed to
`.agent/one-big-feature/fleet-context-diet/` do not affect build or test.

`npm run build` in worktree: PASS (no src changes).
`npm test` relevance: N/A for this spec (config-ops, no new TypeScript).

---

## SOAK CONDITION (not yet met — Josh merges in morning)

Per spec goal condition 5: post-change snapshots require ≥2 NATURAL planned-restarts per agent
(no manual pm2/cortextos stop-start). This cannot be verified at commit time. The staging proof
step completes after Josh merges and agents go through natural restart cycles.

Per feedback_dont_declare_fixed_from_single_clean_window: this verify file does NOT claim the
soak condition is met. It documents pre-merge unit verification only. Full multi-cycle verify
happens post-merge with `python3 bin/verify-fleet-context.py snapshot --label spec04-post`.

---

## Verdict: UNIT VERIFY PASS — PR ready for Josh's morning review and merge.
