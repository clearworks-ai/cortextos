# Upstream cortextOS Digest
Generated: 2026-07-03

---

## 0. Metadata

- **Default branch**: `main`
- **Total files in upstream tree**: 1,059 blobs
- **Key upstream commit**: `5a0882d` (HEAD of main)
- **Files read for this digest**: 24 (SOUL, IDENTITY, GUARDRAILS, AGENTS, CLAUDE, ONBOARDING, HEARTBEAT, TOOLS, MEMORY templates, orchestrator/analyst variants, kb-ingest, kb-query, kb-setup, kb-SKILL, mmrag.py header, upstream agent-process.ts boot prompt, cron-scheduler.ts, inject.ts, org/knowledge.md template)

---

## 1. How Upstream Keeps Agents LEAN

### Baseline instruction weight per agent type

| File | Lines | Bytes | Notes |
|------|-------|-------|-------|
| SOUL.md (base agent) | 55 | 2,692 | "Read once per session, internalize, do not reference in conversation" |
| IDENTITY.md | 18 | ~400 | Blank template — filled during onboarding |
| GUARDRAILS.md | 47 | ~1,800 | 5-row red-flag table + how-to |
| AGENTS.md (shared across all 3 templates) | 453 | 21,181 | Full ops reference (task workflow, memory protocol, comms, crons, restart) |
| MEMORY.md template | 4 | ~120 | Blank: just a header comment |
| TOOLS.md | 157 | — | Compact command index; full docs loaded on demand via skill |
| HEARTBEAT.md | 141 | — | Heartbeat frequency + checklist |

**Total "always-loaded" agent context**: ~26 KB across all bootstrap files. MEMORY.md starts blank (4 lines). No org-wide shared memory index is injected.

### Boot prompt injected by daemon (per session start)

```
"You are starting a new session. Current UTC time: <ISO>. Read AGENTS.md and all bootstrap files listed there.
External crons are auto-loaded by the daemon — do NOT call CronCreate or CronList for cron restoration.
[optional: reminder block for overdue reminders]
[optional: deliverables block if require_deliverables enabled]
[optional: handoff block if context-handoff restart]
[optional: onboarding append if first boot]
Send a Telegram message to the user saying you are back online."
```

This is a **single compact string** — the minimum needed to orient the session. The daemon does NOT inject MEMORY.md contents, SOUL.md contents, or the org knowledge base into the boot prompt. The agent is instructed to read them itself as file reads. The org `knowledge.md` is also a near-blank template that agents read from disk.

### Skill loading is demand-driven

TOOLS.md is a compact command index. Agents load a full skill (e.g. `tasks/SKILL.md`, `comms/SKILL.md`) only when they need the detailed reference for that workflow. Every skill file has a YAML frontmatter trigger list so Claude Code auto-activates the right one.

### Upstream design philosophy

SOUL.md explicitly says: "Read once per session. Internalize. Do not reference in conversation." The expectation is that the agent reads files at boot and holds them in working memory — there is no continuous re-injection. The framework never re-injects bootstrap files mid-session.

---

## 2. Our Fork's Divergence (Bloat Sources)

| Item | Upstream | Our Fork |
|------|---------|----------|
| Shared MEMORY.md (Claude project memory) | Not a concept — each agent has its own MEMORY.md, starts blank | `/Users/joshweiss/.claude/projects/-Users-joshweiss-code-cortextos/memory/MEMORY.md` = 391 lines / 62.8 KB, loaded by Claude Code itself into every main-session context window |
| Per-agent MEMORY.md at boot | 4 lines (blank template) | frank2=82 lines, larry=40, muse=85 |
| SOUL.md per agent | 55 lines (2,692 bytes) | muse SOUL=8,935 bytes (3.3x), larry SOUL=4,023 bytes (1.5x), frank2 SOUL=2,976 bytes (~same) |
| AGENTS.md | 21,181 bytes (identical across all templates) | frank2=27,218 bytes (28% heavier), muse=26,481 bytes |
| Org `knowledge.md` | Near-blank template, filled by user | `orgs/clearworksai/knowledge.md` is custom — content unknown but likely non-trivial |
| Custom SOUL content | Identity is blank — filled at onboarding | muse SOUL includes full Josh backstory, voice rules, Josh's 18-year MSP career, persona, brand-voice constraints |
| "Reference" variants | None | larry has AGENTS-reference.md, GUARDRAILS-reference.md, OPERATIONS.md, OPERATIONS-reference.md, TOOLS-reference.md, SWARM-PROTOCOL.md |

**The 62.8 KB MEMORY.md is not injected into agents at runtime** — it's the Claude Code project memory for this main conversation session. That said, it's still loaded into every main-session context where the human talks to Claude Code about this project.

**The real agent-level bloat** is in per-agent SOUL.md files (especially muse at 3.3x upstream) and custom AGENTS.md variants (frank2 is 28% heavier than upstream, with custom routing logic).

---

## 3. Upstream Knowledge Model (MMRAG / RAG)

### Architecture

- **Engine**: `knowledge-base/scripts/mmrag.py` — Multimodal RAG using:
  - **ChromaDB** (local, in `~/.cortextos/<instance>/orgs/<org>/knowledge-base/chromadb/`)
  - **Gemini Embedding 2** for vector embeddings (768 dimensions)
  - **Gemini Flash** for generating text descriptions of non-text media (video, audio, images, PDFs)
  - **GEMINI_API_KEY** required in `orgs/<org>/secrets.env`

- **Multimodal support**: Ingests `.txt`, `.md`, `.csv`, `.json`, `.py`, `.ts`, `.sh`, `.yaml`, `.html`, `.sql` as text; also `.pdf`, `.docx`, `.pptx`, `.xlsx` (Flash-described), `.mp4`, `.mov` (60s video chunks), `.mp3`, `.wav` (60s audio chunks), `.png`, `.jpg` (image described by Flash).

- **Collections**: Two scopes:
  - `shared-<org>` — visible to all agents in the org
  - `agent-<name>` — private to one agent
  
  Collections are named and queryable via `cortextos bus kb-query`, `kb-ingest`, `kb-collections`.

- **Chunking defaults**: 1,500 chars with 200-char overlap for text; 60s windows for video/audio.

- **Token tracking**: mmrag.py has a built-in usage tracker (embedding + Flash tokens) with `usage.json` per instance.

### Ingest cadence / usage pattern

Upstream design: **on-demand, post-research**. There is no automatic nightly re-index of all memory files. The intended workflow is:
1. Agent runs `kb-query "<question>"` before starting research (check if already known)
2. Agent does research externally if not found
3. Agent runs `kb-ingest <result-files>` after completing research

SOUL.md says the KB is "auto-indexed from MEMORY.md every heartbeat" — but this is aspirational text in the soul/principles file. The bus scripts require explicit calls; there is no daemon-side auto-ingest watcher. Agents must call `kb-ingest` themselves via heartbeat crons if they want automatic indexing.

### Our fork's KB divergence

Our fork has `.agent/one-big-feature/kb-reconciler/` specs suggesting active work on KB reconciliation and timeout hardening (spec-09). This implies we are building more automated KB management on top of upstream's on-demand model. The `--rebuild` path needing spec-11 cache+resume (per project MEMORY.md) suggests we've added continuous/nightly KB pipelines that upstream does not have.

---

## 4. Upstream Handoff / Context / Memory Model

### Three-layer memory (canonical upstream design)

1. **Daily memory** (`memory/YYYY-MM-DD.md`) — Working memory / session journal. Written at: session start, every heartbeat, before/after tasks, session end. Format: structured entries that answer "if my context was wiped right now, what would I need to know to resume intelligently?"

2. **Long-term memory** (`MEMORY.md`) — Consolidated durable knowledge. Patterns that work, user preferences discovered over time, corrections received, decisions and rationale. NOT a log — a living document.

3. **Knowledge Base (KB)** — Vector store (ChromaDB + Gemini). Shared across sessions and agents. Queried before research, ingested after.

### Handoff mechanism (context-handoff-lease.ts)

Upstream has a **context handoff lease system** for orderly context-window-full restarts:
- When an agent detects context filling, it requests a `HandoffLeaseDecision` (acquired or queued with wait time)
- Max concurrent handoffs = 2 (prevents fleet-wide simultaneous restarts)
- Lease TTL = 10 min; queue TTL = 30 min; stagger = 15s + 15s jitter
- Agent writes a handoff doc (path stored in `.handoff-doc-path` marker file)
- On next boot, daemon reads the marker and injects the handoff doc reference into the boot prompt
- **Handoff UX override**: if a handoff restart is detected, the FIRST tool call MUST be `cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID 'back — [what you were just working on]'` — skip the normal "Booting up..." step

The handoff doc is written by the agent using the daily memory protocol (session-end checkpoint). There is no separate "gather-context" step — `bus/gather-context.sh` is for experiment context, not handoff.

### Our fork's handoff divergence

Our fork extended handoff with PR #699 ("context-handoff lifecycle + native opencode adapter") and has the same lease mechanism. Per project MEMORY.md, the handoff mechanism is known to have a tail-leak problem: the handoff doc is written at ~80% context but the last 20% of decisions can vanish. The fix (PR #30) is a structural improvement to write memory at moment of instruction, not at handoff time.

---

## 5. The Analyst Agent's Intended Job

Upstream's analyst (`community/agents/analyst/`) is a **persistent system optimizer**, not a research agent. Its specific accountability targets (from SOUL.md) differ from the base agent:

```
>= 2 events logged (including: metrics_collected, anomaly_detected)
0 pending analysis requests older than 1h
All agents have heartbeats < 5h old (flag any that don't)
```

**Intended responsibilities**:
- Monitor fleet health (heartbeat staleness, crash patterns)
- Collect system metrics
- Detect anomalies in agent behavior or system state
- Propose system improvements
- Has a `goals.json` with `focus` and `goals` fields — if empty on boot, asks orchestrator for today's goals
- Runs its own `experiments/` directory (hypothesis → evaluate → learnings.md cycle)
- Distinct from the research-agent template (which is a community agent for external research)

The analyst is effectively the fleet's internal telemetry and optimization layer. It's the agent that watches other agents.

---

## 6. Upstream vs Our Fork — Concrete Divergence List

### Things upstream has that we match (largely identical)
- AGENTS.md core content (21,181 bytes baseline; ours slightly heavier)
- SOUL.md structure and accountability targets
- GUARDRAILS.md red-flag table
- ChromaDB + MMRAG knowledge base engine
- Context handoff lease mechanism
- Cron system (daemon-managed, not session-managed)
- Bus script vocabulary

### Things we added that upstream does NOT have

1. **Per-agent personalized SOUL.md** — muse SOUL contains Josh's full backstory, voice rules, persona, brand constraints (8,935 bytes vs upstream's 2,692). Upstream keeps SOUL.md generic; persona is put in IDENTITY.md (18 lines, blank template).

2. **Custom AGENTS.md variants** — frank2/muse AGENTS.md are 28% heavier than upstream's canonical 453-line file. Additions include org-specific routing logic, larry/frank2 delegation rules.

3. **Reference file variants** — larry has AGENTS-reference.md, GUARDRAILS-reference.md, OPERATIONS-reference.md, TOOLS-reference.md, SWARM-PROTOCOL.md. Upstream has no "reference" pattern — single source of truth per doc.

4. **Custom org skills** — `orgs/clearworksai/skills/` (proof-editor, the-humanizer). Upstream has community skills but not org-level custom skills in this location.

5. **OBF (one-big-feature) KB pipeline work** — `.agent/one-big-feature/kb-reconciler/` specs (timeout hardening, content-hash cache, resumable checkpoints, nightly incremental). Upstream KB is purely on-demand / manual trigger.

6. **Multiple org directories** — `orgs/clearworksai/`, `orgs/personal/`, `orgs/sondre-hq/`. Upstream's templates support multi-org but don't ship with pre-populated orgs.

7. **M2C1 orchestration framework** — `.claude/skills/m2c1/`, `.agent/` folder with M2C1 phase files. Upstream has a basic `m2c1-worker` template but not the full M2C1 orchestration system.

8. **Claude project MEMORY.md** (62.8 KB, 391 lines at `/Users/joshweiss/.claude/projects/-Users-joshweiss-code-cortextos/memory/MEMORY.md`) — this is loaded by Claude Code's main conversation session, not by the daemon. Upstream has no equivalent concept; it's a Claude Code project-level memory that accumulates all fleet corrections, feedback, incidents, and references. This is the heaviest single context load in our setup.

### Things upstream has that we have not yet fully adopted

1. **Blank MEMORY.md template** — upstream MEMORY.md starts at 4 lines and grows organically through agent-written entries. Our agents have more pre-seeded content.

2. **IDENTITY.md as the persona container** — upstream puts all persona/name/vibe in IDENTITY.md (filled at onboarding), not in SOUL.md. We put Josh backstory and voice rules in SOUL.md (muse), which mixes principles with persona.

3. **Community catalog / upstream sync** — `ecosystem.catalog_browse.enabled` and `ecosystem.upstream_sync.enabled` config flags for agents to self-update from the community catalog and pull upstream framework patches. Whether we have these wired is not clear.

4. **Auto-skill detection** — post-task self-check: "did this take 8+ distinct tool calls? Have I solved this 3+ times?" → draft a skill candidate. This is in AGENTS.md but may not be practiced.

5. **ONBOARDING.md per-agent** — upstream ships a detailed 398-line onboarding skill that gates agent operation until completed. Our agents may skip this gate.

---

## 7. Key Architectural Insight

Upstream's lean design relies on **file reads at boot being cheap** — the agent reads SOUL.md, IDENTITY.md, GUARDRAILS.md, GOALS.md, HEARTBEAT.md, MEMORY.md, USER.md, TOOLS.md, SYSTEM.md as the first action of every session. The boot prompt is tiny. Context budget is preserved for actual work.

Our fork's main divergence is in **pre-populating these files with dense org-specific content** (especially SOUL.md and AGENTS.md) rather than keeping them lean and loading detail on-demand through skills. The 62.8 KB project MEMORY.md is a separate concern (Claude Code project memory, not agent runtime).

The upstream MEMORY.md-as-blank-template philosophy is intentional: memory grows from real agent experience, not pre-seeding. Our fork's heavier-populated SOULs and AGENTS files represent a tradeoff: faster agent onboarding vs. higher per-session context cost.
