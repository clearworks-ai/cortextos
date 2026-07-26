# Spec 02 — AGENTS.md + CLAUDE.md diet (extract-to-reference)

Effort M. Blast radius: fleet-wide behavioral (each agent's constitution). Adversarial review REQUIRED.
Per-agent AGENTS.md/CLAUDE.md are GITIGNORED (safe live edits); only templates/ are tracked (PR those).

## Bugs to fix in this pass
1. maven AGENTS.md has the DEAD cron model (On-Session-Start step 6 = CronList + /loop restore) — re-baseline maven from the new template, re-add only its KB/Clearpath note line.
2. CLAUDE.md double-loads AGENTS.md content (pa/scout CLAUDE.md == templates/agent/CLAUDE.md, 8.2KB, injected EVERY session incl --continue) — dedup to ~3KB.

## File groups (independent gitignored copies, NOT template-driven at runtime)
- pa == templates/agent/AGENTS.md (27.7KB); muse/scout/hunter identical variant (26.5KB); maven stale (23.4KB); frank2 == templates/orchestrator variant (26.8KB, +295-line diff). larry(5.5KB)/crm(1.9KB) already lean — DO NOT TOUCH.

## Extract to AGENTS-REFERENCE.md sibling (NOT .claude/skills — muse has 0 of 6 skills). Each extracted section replaced by ONE line: "Full details: read AGENTS-REFERENCE.md §<anchor> when needed — do NOT read at boot." The do-NOT-read-at-boot clause is load-bearing; do not add reference file to the step-2 bootstrap list.

KEEP inline (live behavior): First Boot, On Session Start, Context Handoff table+Never-list, Time-Awareness 4 rules, Task Workflow 4 commands, Blocked/Human/Approval decision rule+CONSEQUENCE lines, Memory checkpoint+inline-NOTE rules, Telegram message rules (ALL), A2A, Crons short section, Restart contract, Skills, System Mgmt.
EXTRACT (low-freq reference/templates): session-end heredoc, handoff config-knob para, time bash snippets, blocked-state shell blocks, memory heredoc templates, KB/ChromaDB Layer-3 (keep 3 lines), event-logging 13-row table (keep 1-line list), External-Persistent-Crons explainer (3KB — biggest single win).
Net ~27.7KB → ~16.5KB inline (−2.8k tok/agent), ~11KB to reference.

## CLAUDE.md dedup (Step B, higher per-token leverage — paid every session)
templates/agent/CLAUDE.md 8.2KB → ~3KB: KEEP First-Boot, Task-Type Routing (knox/trace/sentinel/architect — CLAUDE.md-only, keep), restart contract, + 1 pointer line per duplicated section. DELETE duplicated session-start/task-workflow/memory/event-logging/Telegram/A2A/crons/system tables. −1.3k tok every session. muse/hunter/maven/frank2 CLAUDE.md are custom — diff each first, dedup preserving deltas.

## Safety gate (mandatory)
grep -nE 'MUST|Do NOT|NEVER|Never|always|CONSEQUENCE|TARGET' old-AGENTS.md → every hit MUST appear verbatim in new AGENTS.md ∪ AGENTS-REFERENCE.md. Script as sorted-line diff; require EMPTY diff; attach to PR.

## Rollout: templates via PR; per-agent gitignored files direct-write. pa=copy template; muse/scout/hunter=port group delta; maven=re-baseline; frank2=own-file surgery (keep its "Incoming Work" + "Voice & Writing" inline). F3 interplay: editing bumps mtime → next --continue within 15min re-reads (desired). Canary scout 24h before pa/frank2.
