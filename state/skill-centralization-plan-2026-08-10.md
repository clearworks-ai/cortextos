# Skill Centralization Plan — 2026-08-10

## Context

Josh directive: canonical skill store = `orgs/clearworksai/skills/` (NOT `community/skills` = upstream).
Per-agent physical copies must be replaced with references to canonical copies.

This run migrated the two meeting-chain skills. The remaining ~40 skills need migration in future runs.

---

## Completed in this run

### Canonical skills created

| Skill | Canonical path |
|---|---|
| meeting-writeback-worker | `orgs/clearworksai/skills/meeting-writeback-worker/SKILL.md` |
| meeting-commitments-worker | `orgs/clearworksai/skills/meeting-commitments-worker/SKILL.md` |

### Improvements in canonical versions

**meeting-writeback-worker** (canonical = pa-codex Track A version + pa webhook features):
- Uses `$CTX_AGENT_DIR` / `$CTX_FRAMEWORK_ROOT` / `$CTX_ORG` env vars — no hardcoded paths
- Supports `FF_MEETING_ID` single-meeting fast path for webhook-triggered cadence
- Emits `EVENT crm.meeting.completed` after successful writeback
- Uses `$OWNER_AGENT` in bus events (not hardcoded `pa`)

**meeting-commitments-worker** (canonical = pa version + CTX_* env vars):
- Uses `$CTX_AGENT_DIR` / `$CTX_FRAMEWORK_ROOT` / `$CTX_ORG` env vars — no hardcoded paths
- Dynamic `$OWNER_AGENT` for bus events
- Includes overdue chase (Step 5b) and orphan audit (Step 5c) from pa version
- Full WE-vs-THEY framing rules preserved

### Per-agent copies updated to canonical content

| Per-agent location | Updated |
|---|---|
| `orgs/clearworksai/agents/pa/.claude/skills/meeting-writeback-worker/SKILL.md` | yes |
| `orgs/clearworksai/agents/frank2/.claude/skills/meeting-commitments-worker/SKILL.md` | yes |

Note: pa-codex and frank2-codex directories are untracked (runtime-generated plugin dirs).
They must be updated post-deploy by running the agent-codex template re-scaffold or manual copy.
Command to update untracked copies:
```bash
cp orgs/clearworksai/skills/meeting-writeback-worker/SKILL.md \
   orgs/clearworksai/agents/pa-codex/plugins/cortextos-agent-skills/skills/meeting-writeback-worker/SKILL.md

cp orgs/clearworksai/skills/meeting-commitments-worker/SKILL.md \
   orgs/clearworksai/agents/pa-codex/plugins/cortextos-agent-skills/skills/meeting-commitments-worker/SKILL.md

cp orgs/clearworksai/skills/meeting-commitments-worker/SKILL.md \
   orgs/clearworksai/agents/frank2-codex/plugins/cortextos-agent-skills/skills/meeting-commitments-worker/SKILL.md
```

---

## Remaining skills (~40 copies to migrate)

### Priority order for future migration runs

**Group A — worker skills (short-lived sessions, high impact):**
- `booking-coordinator-worker` — tracked in pa/.claude/skills only
- `comms-check-worker` — tracked in pa/.claude/skills only
- `meeting-recap-draft-worker` — tracked in pa/.claude/skills only
- `client-context-sync-worker` — tracked in frank2/.claude/skills only
- `ff-transcript-persist-worker` — tracked in frank2/.claude/skills only
- `pre-meeting-brief-page-worker` — tracked in frank2/.claude/skills only
- `delivery-status-reporter-worker` — tracked in crm/.claude/skills only

**Group B — codex plugin skills (untracked, high count):**
- All 40+ skills in `pa-codex/plugins/cortextos-agent-skills/skills/`
- All 73+ skills in `frank2-codex/plugins/cortextos-agent-skills/skills/`
- These are runtime-generated from templates; need a template-level fix to reference canonical path

**Group C — community skills (upstream):**
- `community/skills/` — upstream from grandamenium/cortextos
- These should NOT be moved; they are upstream skills, not org-specific
- Clearworks-specific variants should live in `orgs/clearworksai/skills/`

### Migration pattern

For each skill:
1. Create canonical copy at `orgs/clearworksai/skills/<skill-name>/SKILL.md`
2. Verify canonical version uses `$CTX_*` env vars (no hardcoded paths)
3. Update all per-agent tracked copies to match canonical content
4. Note untracked codex plugin dirs — update via deploy step or template fix
5. Add a pipeline receipt row for the migration

### Symlink vs copy decision

Physical copies (current approach) chosen because:
- Git does not track symlinks portably across platforms
- Worktree setup duplicates symlinks as broken links
- Per-agent copies are small (10-50KB each)

When a canonical copy changes, run the deploy step above to propagate.
A future improvement: a `cortextos skills sync` command that propagates canonical → per-agent automatically.

---

## Total scope estimate

| Category | Count | Status |
|---|---|---|
| meeting-chain skills | 2 | DONE this run |
| Other tracked worker skills | 6 | Queued Group A |
| Community skills (upstream) | ~30 | Skip (upstream) |
| Codex plugin skills (untracked) | ~100+ | Queued Group B |

Estimated effort: 3-4 focused runs to complete Group A + B.
