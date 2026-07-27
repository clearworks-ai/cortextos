# fleet-context-diet — rollback / re-enable runbook (2026-07-26)

This document covers the spec04 front-context cuts. For earlier specs (MCP diet, plugin diet, PTY fix),
see the main repo's `.agent/one-big-feature/fleet-context-diet/ROLLBACK.md`.

---

## Spec 04 — front-context cuts rollback (PR fix/front-context-cuts-ship)

Branch: `fix/front-context-cuts-ship` (NOT merged into main — Josh merges after morning review)

### CUT 2: wal-protocol.js empty-envelope suppression

**What changed:** Added `if (!additionalContext) { process.exit(0); }` before the stdout.write in
`~/.claude/hooks/wal-protocol.js` (line ~51). Empty PostToolUse hook no longer emits a ~760B envelope.

**Rollback:** Remove the early-exit block:
```bash
# Edit ~/.claude/hooks/wal-protocol.js
# Remove these 4 lines (after the if (isDownloadsWrite) block, before process.stdout.write):
#
#     // CUT-2: suppress empty envelope — saves ~760B / PostToolUse fire (was ~3.2k/restart)
#     if (!additionalContext) {
#       process.exit(0);
#     }
```

**Verify after rollback:** `printf '{"tool_name":"Bash","tool_input":{}}' | node ~/.claude/hooks/wal-protocol.js` should produce ~760 bytes of JSON.

---

### CUT 4: settings.json caveman-mode-tracker dedup

**What changed:** Removed the standalone second UserPromptSubmit hook group running
`/Users/joshweiss/.hermes/node/bin/node /Users/joshweiss/.claude/hooks/caveman-mode-tracker.js`
from `~/.claude/settings.json`. Plugin-provided registration in
`~/.claude/plugins/cache/caveman/.../plugin.json` is untouched.

**Backup:** `~/.claude/settings.json.bak-caveman-dedup-spec04-<timestamp>` (created before edit)

**Rollback:** Restore from backup or re-add the second UserPromptSubmit group:
```bash
# Option A — restore from backup
cp ~/.claude/settings.json.bak-caveman-dedup-spec04-* ~/.claude/settings.json

# Option B — re-add manually to ~/.claude/settings.json hooks.UserPromptSubmit array:
# {
#   "hooks": [
#     {
#       "type": "command",
#       "command": "\"/Users/joshweiss/.hermes/node/bin/node\" \"/Users/joshweiss/.claude/hooks/caveman-mode-tracker.js\"",
#       "timeout": 5,
#       "statusMessage": "Tracking caveman mode..."
#     }
#   ]
# }
```

**Watch for:** caveman per-prompt reminders stopping entirely (would mean the plugin registration
silently failed and this standalone was the live one). Check new transcripts for `CAVEMAN MODE ACTIVE (`
with count == 1 per prompt. If count drops to 0, restore from backup.

**Plugin update churn note:** If `caveman@caveman` plugin updates and re-adds a standalone mode-tracker
to settings.json, this fix would be undone. Check `~/.claude/settings.json` after plugin updates.

---

### CUT 1: skills-disabled-2026-07-26 (11 skills moved)

**What moved:**
- `~/.claude/skills/best-practices` → `~/.claude/skills-disabled-2026-07-26/best-practices`
- `~/.claude/skills/brainstorming` → `~/.claude/skills-disabled-2026-07-26/brainstorming`
- `~/.claude/skills/brand-guidelines` → `~/.claude/skills-disabled-2026-07-26/brand-guidelines`
- `~/.claude/skills/cold-email` → `~/.claude/skills-disabled-2026-07-26/cold-email`
- `~/.claude/skills/copywriting` → `~/.claude/skills-disabled-2026-07-26/copywriting`
- `~/.claude/skills/email-sequence` → `~/.claude/skills-disabled-2026-07-26/email-sequence`
- `~/.claude/skills/gemini` → `~/.claude/skills-disabled-2026-07-26/gemini`
- `~/.claude/skills/lesson-learned` → `~/.claude/skills-disabled-2026-07-26/lesson-learned`
- `~/.claude/skills/performance` → `~/.claude/skills-disabled-2026-07-26/performance`
- `~/.claude/skills/perplexity` → `~/.claude/skills-disabled-2026-07-26/perplexity`
- `~/.claude/skills/seo` → `~/.claude/skills-disabled-2026-07-26/seo`

All 11 are symlinks pointing into `~/.agents/skills/<name>`. Zero 7-day transcript hits confirmed
by spec04-skill-usage-checker.py (5063 transcripts scanned, mtime ≤7d).

**Rollback (all):**
```bash
for name in best-practices brainstorming brand-guidelines cold-email copywriting email-sequence gemini lesson-learned performance perplexity seo; do
  mv ~/.claude/skills-disabled-2026-07-26/$name ~/.claude/skills/$name
done
```

**Rollback (one skill):**
```bash
mv ~/.claude/skills-disabled-2026-07-26/<skill-name> ~/.claude/skills/<skill-name>
```

**Trigger for individual re-enable:** an agent transcript shows `Skill not found` or similar error
referencing a moved skill name. No agent restart needed — skill listing regenerates on next session start.

---

### CUT 3: agents-disabled-2026-07-26 (2 agency agents moved)

**What moved:**
- `~/.claude/agents/agency/finance-fpa-analyst.md` → `~/.claude/agents-disabled-2026-07-26/finance-fpa-analyst.md`
- `~/.claude/agents/agency/sales-proposal-strategist.md` → `~/.claude/agents-disabled-2026-07-26/sales-proposal-strategist.md`
- `~/.claude/agents/agency/` directory removed (was empty after move)

Zero 7-day invocations confirmed in codexer's audit (/tmp/fleet-context-diet-spec04-audit.md).

**Rollback:**
```bash
mkdir -p ~/.claude/agents/agency
mv ~/.claude/agents-disabled-2026-07-26/finance-fpa-analyst.md ~/.claude/agents/agency/
mv ~/.claude/agents-disabled-2026-07-26/sales-proposal-strategist.md ~/.claude/agents/agency/
```

---

## Honest savings estimate

Target was ~15k/restart. Realistic achievable:
- CUT 2: ~3.2k/restart (17 empty PostToolUse attachments × ~760B eliminated per larry restart cycle)
- CUT 4: ~0 token savings (dedup only — was paying once, now still paying once from plugin)
- CUT 1: 11 skills × ~100-200 chars each = ~1-2k reduction in skill_listing
- CUT 3: 2 agent types removed from agent_listing_delta; residual ~0.3-0.7k (built-ins dominate)

**Total realistic: ~4-6k/restart floor drop** (not the 15k spec assumed, which required full
skill_listing removal — a Claude-Code-native feature not per-agent scopeable without upstream changes).

The ~13k connector cut (claude.ai Gmail/Drive/Calendar) remains a human task for Josh (account-level
in claude.ai Settings).
