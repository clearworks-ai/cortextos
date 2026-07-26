# Organization Knowledge Base

Shared facts, context, and institutional knowledge for all agents in this org. Read on every session start. Update when you learn something that all agents should know.

## Business

**ClearWorks AI** — an AI Operations and Consulting company run by Josh Weiss.

**Official LLC name:** Clearworks.AI LLC — Entity No. B20260246278, formed 06/19/2026, CA Active
**Registered address:** 849 N Avenue 63, Lower Level, Los Angeles, CA 90042
**CEO / Manager / Registered Agent:** Joshua Shawn Weiss (self-registered)
**Type of business (Clearworks.AI LLC):** AI + Digital Operations Consulting
**Official business phone (Google Voice):** (213) 222-6625
**Source:** CA SOS Certificate of Status + SOI LLC-12 filings (2026-06-19), Google Drive Operations folder

Current focus areas:
- **AuditOS** — audit app, primary engineering push right now
- **ClearPath Academy** — course/training product, launching soon
- **Marketing campaign launch** — top-of-funnel for the consulting arm
- **Client delivery model** — still being designed; open question

Stage: pre-launch / actively shipping product.

## Team

- **Josh Weiss** — founder, operator, primary human in the loop
- Core human team: TBD (fill in as agents learn)
- AI agent fleet (Clearworks-wide, not all inside this cortextOS instance yet):
  FRANK (CoS), HUNTER (sales), COMPASS (client ops), SENTINEL (ops/legal/finance),
  MUSE (content), MAVEN (personal), LARRY (engineering), SRE (security/perf).
  Each has its own Telegram bot. Content is owned by MUSE — do not draft LinkedIn/newsletter directly.

## Technical

Apps and repos (all at `clearworks-ai` on GitHub, local at `~/code/`):

| App | Repo | Railway URL |
|-----|------|-------------|
| Clearpath (gold standard) | `clearworks-ai/clearpath` | clearpath-production-c86d.up.railway.app |
| Lifecycle X | `clearworks-ai/lifecycle-killer` | lifecycle-killer-production.up.railway.app |
| Nonprofit Hub | `clearworks-ai/nonprofit-hub` | nonprofit-hub-production.up.railway.app |
| AuditOS | (extraction/audit product — active dev) | — |

> _Zoom Downloader killed/archived 2026-06-08 (Josh request): GitHub repo archived, Railway service torn down._

**Stack (locked):** Node.js + TypeScript strict, Express 5 (REST only), React 18 + Vite + TanStack Query v5, Drizzle ORM + PostgreSQL, Shadcn/ui + Radix + Tailwind (semantic tokens only), express-session + connect-pg-simple.

**LLM:** Anthropic primary (`claude-3-5-sonnet`). OpenAI only for embeddings (`text-embedding-3-small`).

**Hosting:** Railway auto-deploy on push to main. Never create `railway.json`/`railway.toml` in Clearpath — custom healthcheck config blocks all deploys. Deploy via `git push` to main only.

**Non-negotiables:** every query org-scoped, no `any` type, no `console.log` in committed code, no endpoints without org-scoping, every storage method takes `orgId`.

## Key Links

- Clearpath prod: https://clearpath-production-c86d.up.railway.app
- Clearpath repo: https://github.com/clearworks-ai/clearpath
- Knowledge-sync (Obsidian vault): `~/code/knowledge-sync/`
Obsidian vault: `/Users/joshweiss/code/knowledge-sync/wiki/`
Raw vault: `/Users/joshweiss/code/knowledge-sync/raw/`
Outputs vault: `/Users/joshweiss/code/knowledge-sync/outputs/`

## Knowledge Base — MMRAG (the cortextOS index)

**MMRAG (`cortextos bus kb-query` / `kb-ingest`, backed by `mmrag.py` + local ChromaDB) is the ONE knowledge index the fleet actually reads.** The `documented-past-retrieval` hook injects its hits into every agent turn. Fed by frank2 synthesis crons (nightly wiki, weekly session-archaeology/synthesis) — vault docs + Josh's personal sessions. NOT fed: meeting transcripts, agent transcripts, CRM email.

**Clearpath's intelligence stack (`clrpath.ai/api/intelligence/*`, Supabase+pgvector+Gemini embeddings) is LEGACY/RETIRED — Clearpath itself is an old app, not in active use.** Its only writer (academy agent's nightly cron) has been offline for months; no agent calls `/ask`. Do not route KB reads/writes there. Confirmed directly by Josh 2026-07-25 after a prior stale version of this section wrongly called it "authoritative."

Known gaps (open, not yet fixed): agent transcripts (~9.4GB under `~/.claude/projects/`) never indexed; wiki-synthesis cron has failed silently before — needs a canary, not blind trust. See `feedback_reliability_not_deletion.md` and `project_kb_underfed_mmrag_2026-07-24.md` in shared memory.

## Clearpath Org IDs (UUIDs, not slugs)

The Clearpath MCP expects the real DB UUID, not a slug. Unknown UUIDs silently return empty stats (no error) — guessing is unproductive.

- **Clearworks.AI Internal (client)** — use this for intelligence queries
  `0ce7b73b-9161-47a6-a800-a0c8f15a4ae4`
- **Clearworks.AI (reseller)**
  `06b560b6-524d-4b0e-90d4-6059addeb9e8`
- **Holdco Partner Platform**
  `48d14151-a951-4a36-b6f5-0aba059a357e`

Josh's Clearpath user_id: `53388948`

Source: frank-cc memory (`reference_clearpath_org_ids.md`), 2026-04-10.

## Decisions Log

- **2026-03-30** — Stack locked: Clearworks apps use Node + TS strict, Express 5, React 18 + Vite + TanStack Query v5, Drizzle + Postgres, Shadcn + Tailwind semantic tokens only.
- **2026-03-30** — LLM: Anthropic primary, OpenAI embeddings only. Hosting: Railway auto-deploy on push to main.
- **2026-03-30** — MUSE owns all content. Frank / other agents do not draft LinkedIn or newsletter posts directly.
- **2026-03-30** — Todoist is authoritative for tasks, not markdown files. Query the API for status.
- **2026-04-05** — Never create `railway.json`/`railway.toml` in Clearpath. Custom healthcheck config blocks deploys. Deploy via `git push` to main only.
- **2026-07-21** — Adopted SkillTree `knowledge-base` convention as the org's structured brain: `knowledge/` (this file's sibling dir) holds `company.md`, `offer.md`, `voice.md`, `stack.md`, `STATE.md`, `clients/`, `meetings/`, `playbooks/`. This `knowledge.md` file stays the canonical deep reference; `knowledge/STATE.md` is the fast read-first/write-last session file.

## Knowledge Base Rules

1. **Read before write.** Any session doing client or business work reads `knowledge/STATE.md` and the relevant `knowledge/clients/*.md` first.
2. **Write after work.** Material changes (deal moved, decision made, deliverable shipped) get written back the same session — to the client file and `STATE.md`.
3. **One fact, one home.** Exact facts (prices, dates, statuses) live in exactly one file; everything else links to it.
4. **Dated history, newest first.** Never delete history — append above it.
5. **The stack file is law.** Skills/agents use the tools `knowledge/stack.md` names. When a tool changes, update one file and every skill follows.
6. **No orphan transcripts.** Every meeting transcript in `knowledge/meetings/` gets its outcomes extracted into the relevant client file within a day.
