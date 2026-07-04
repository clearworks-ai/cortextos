# Josh Work Inventory — deeper scaffold (grounded 2026-07-03)

Now I have a complete picture. Let me also quickly check a few key skill files to verify their purpose.

I have everything I need. Here is the full grounded inventory:

---

## Josh's Work Inventory — Grounded Deep Scan

**Sources:** cortextos1 crons.json files for all 16 agents + ~/.claude/skills/ directory. Every status is cited by exact cron name or skill folder name.

---

### CATEGORY 1: DAILY OPERATIONS & INTELLIGENCE

| Work Item | Input → Output | Status |
|---|---|---|
| Morning brief | Calendar + tasks + CRM + wiki → dashboard tab + Telegram URL | LIVE-CRON (`frank2/morning-brief`, daily 8am weekdays) |
| Morning digest (Josh-only intel) | Fireflies + Omi + HN API → one Telegram with conversations, build-in-public, AI-news-per-sector | LIVE-CRON (`muse/morning-digest`, daily 7:30am) |
| Personal morning nudge | Personal tasks + Todoist → 1-3 bullet Telegram, silent if nothing due | LIVE-CRON (`maven/daily-personal-nudge`, 7:30am weekdays) |
| Pre-meeting brief | Tomorrow's calendar + CRM + Gmail → per-meeting prep card Telegram | LIVE-CRON (`frank2/pre-meeting-brief`, 5pm weekdays) |
| Midday blocker check | In-progress tasks + stale threads + calendar → Telegram only if real blocker found | LIVE-CRON (`frank2/midday-blockers`, 2:30pm weekdays) |
| Evening wrap | Git log + Gmail + calendar + agent heartbeats → Telegraph brief + overnight agent dispatch | LIVE-CRON (`frank2/evening-wrap`, 5pm weekdays) |
| Personal evening check | Personal tasks → 1-2 line carry-forward Telegram | LIVE-CRON (`maven/evening-personal-check`, 8pm weekdays) |
| NE LA activities digest | Instagram/TikTok/Substack → 3-5 confirmed picks Telegram | LIVE-CRON (`scout/morning-digest`, daily 7:30am) |
| Ops dashboard publish | Bus tasks + CRM + trending picks → web dashboard refreshed | LIVE-CRON (`frank2/daily-ops-dashboard`, 3pm daily; `larry/refresh-briefs-dashboard`, every 30m) |
| Approval surfacing | Bus approval queue → Telegram only for items pending >1h | LIVE-CRON (`frank2/check-approvals`, 2h) |
| **Fleet monitoring — context budget** | Skills/agents/MCP count → weekly Telegram if changed | LIVE-CRON (`larry/context-budget-weekly`, Monday 3am) |

---

### CATEGORY 2: CLIENT DELIVERY

| Work Item | Input → Output | Status |
|---|---|---|
| Meeting → CRM ingest | Fireflies GraphQL transcripts → interaction records + action items + follow-up log + meeting MD | LIVE-CRON (`crm/fireflies-ingest`, every 2h) |
| Meeting commitments tracking | Recent meetings → open commitments surfaced | LIVE-CRON (`frank2/meeting-commitments` worker, every 2h via `meeting-commitments-worker` skill) |
| Client health check | Client folders + active tasks → stale contact / deliverable alerts | LIVE-CRON (`frank2/client-health`, Wednesdays) |
| Transcript scanner | Agent session transcripts → knowledge extraction | LIVE-CRON (`frank2/transcript-scanner` worker, every 2h via `transcript-scanner-worker` skill) |
| Proposal drafting | Deal discovery → scoped proposal doc | HAS-SKILL (`m2c1` for M2C1-scoped delivery; `humanizer` for copy review) — but no live cron; **MISSING from first pass as a standalone workflow item** |
| Workshop / audit delivery | Client engagement → deliverable (slides, audit doc, SOPs) | HUMAN-ONLY; no cron or skill scaffolds the delivery artifact itself |
| Clearworks package / scope design | Josh interview → service tier table | HAS-SKILL (`m2c1`) — currently HUMAN-ONLY for the interview phase |

---

### CATEGORY 3: SALES & PIPELINE

| Work Item | Input → Output | Status |
|---|---|---|
| CRM daily check | Inbound messages + yesterday meetings → actionable items to frank2 | LIVE-CRON (`crm/daily-checkin`, 8am weekdays) |
| CRM board sync | Live board stage changes → pipeline.json reverse sync | LIVE-CRON (`crm/sync-board`, every 15m) |
| Deal intake reconcile | `_deal_intents.jsonl` queue → pipeline.json upserts | LIVE-CRON (`crm/intake-reconcile`, every 15m) |
| Company Gmail feed | Gmail threads per company → `crm/feeds/*.gmail.json` | LIVE-CRON (`crm/company-gmail-feed`, every 4h) |
| Outreach check | Active tasks sales section + Gmail → stale prospect flag | LIVE-CRON (`frank2/outreach-check`, M/W/F) |
| Pipeline review | Pipeline.json → stage/revenue/next-action summary Telegram | LIVE-CRON (`frank2/pipeline-review`, Thursdays) |
| CRM weekly brief | Full pipeline summary → frank2 routing to Josh | LIVE-CRON (`crm/weekly-brief`, Monday 9am) |
| Comms triage | Gmail/Slack inbound → route or surface to Josh (15m loop) | LIVE-CRON (`frank2/comms-check`, every 15m via `comms-check-worker` skill) |
| Follow-up drafting | Stale deal + context → draft follow-up for Josh approval | NEEDS-SKILL — hunter is permanently off; crm agent surfaces the stale deal but no agent drafts the actual message |
| ~~Outbound prospecting~~ | ~~Lead list → outreach sequences~~ | PERMANENTLY OFF (hunter shut down 2026-06-27) |

---

### CATEGORY 4: CONTENT & RESEARCH

| Work Item | Input → Output | Status |
|---|---|---|
| GitHub trending scan + steal picks | github.com/trending scrape + codebase-reference analysis → trending-picks.json for dashboard | LIVE-CRON (`frank2/daily-trending-repos`, daily 7am) |
| Fleet activity intel for content | Agent memory + git log → FLEET_ACTIVITY_INTEL block in muse/memory | LIVE-CRON (`muse/fleet-activity-intel`, weekdays 8am PDT via `fleet-activity-digest.py`) |
| NE LA creator expansion | IG + TikTok + Substack → 4-6 new creator picks + data/creators.md update | LIVE-CRON (`scout/creator-expansion`, Fridays 6pm) |
| Venue regulars tracker | Last 4 weekly digests → "become-a-regular" flag when venue appears 3+ times | LIVE-CRON (`scout/regulars-tracker`, Mondays) |
| LinkedIn / social content posting | Content seed → published post | NEEDS-SKILL — muse generates the intel; no live cron drives posting (killed 6 content crons 2026-07-02) — **MISSING from first pass as a gap** |
| KB / wiki synthesis (nightly) | Raw knowledge-sync docs → wiki articles | LIVE-CRON (`frank2/daily-wiki-prep` + `larry/daily-wiki-prep`, nightly 2am) |
| KB RAG reconcile | wiki + raw dirs → shared-clearworksai vector collection | LIVE-CRON (`larry/kb-reconcile-nightly`, daily 9:30am) |
| IG-to-Spotify | Instagram reel frames → Spotify track ID | HAS-SKILL (`ig-to-spotify`) — on-demand |
| Building-in-public content pipeline | Fleet activity → LinkedIn seeds → Josh-picks → post draft | NEEDS-SKILL — intel is captured; selection-to-publish path has no cron; **MISSING from first pass** |

---

### CATEGORY 5: FINANCE

| Work Item | Input → Output | Status |
|---|---|---|
| Invoice creation | Client name + scope → Moxie invoice | HAS-SKILL (`invoicing`) — on-demand, HUMAN-INITIATED |
| AR / accounts receivable tracking | Pending invoices → overdue alert | NEEDS-SKILL — no live cron scans AR; **MISSING from first pass** |
| Monthly revenue snapshot | Pipeline + invoices → revenue summary | HUMAN-ONLY — no cron, no skill |
| **Personal finance / wealth tracking** | Monarch MCP → on-demand analysis via ophir | LIVE (ophir handles Monarch MCP; heartbeat 4h) — **MISSING from first pass** |
| Estate / legal doc retrieval | Google Drive → Cert of Status, EIN, W-9 on request | HAS-SKILL (none dedicated; manual Drive fetch) — HUMAN-ONLY |

---

### CATEGORY 6: ENGINEERING & PLATFORM

| Work Item | Input → Output | Status |
|---|---|---|
| Production uptime monitoring | HTTP HEAD checks → Telegram on non-2xx | LIVE-CRON (`larry/uptime-check`, every 4h; 4 apps) |
| Open PR reminder | gh pr list → Telegram for PRs pending >4h | LIVE-CRON (`larry/pr-review-reminder`, every 8h) |
| Daily test run | npm test across all repos → failures to Telegram | LIVE-CRON (`larry/test-status`, 6am weekdays) |
| Playwright coverage | Playwright suites → pass-rate + gap report | LIVE-CRON (`larry/playwright-coverage`, Tuesdays) |
| Dependency audit | npm audit + npm outdated → vuln alert | LIVE-CRON (`larry/dependency-audit`, Thursdays) |
| Weekly engineering digest | Git log + open PRs → what shipped/blocked | LIVE-CRON (`larry/release-coordinator`, Fridays 5pm) |
| cortextOS upstream sync check | git fetch upstream → pending-commit summary for Josh approval | LIVE-CRON (`larry/upstream-sync`, Mondays; `sage/check-upstream`, nightly) |
| Nightly fleet analysis | Agent logs + crashes → auto-fix or escalation | LIVE-CRON (`frank2/nightly-fleet-analysis`, nightly 2am) |
| Fleet health check (5m) | All agent heartbeats → stale agent alert to frank2 | LIVE-CRON (`sage/fleet-health-check`, every 5m) |
| Nightly KPI metrics | Bus + git + fleet → KPI JSON + digest | LIVE-CRON (`sage/nightly-metrics`, nightly 1:47am) |
| Weekly system audit | Codebase subsystem rotation → race conditions / silent failures | LIVE-CRON (`sage/weekly-audit`, Mondays) |
| Daily improvement dispatch | Agent goals vs completed work → gap-only improvement prompts to each agent | LIVE-CRON (`frank2/daily-improvement-dispatch`, 10am weekdays) |
| Theta-wave system improvement | Fleet experiments + KPI scores → 3 proposals, send approved changes | LIVE-CRON (`frank2/theta-wave` Fridays; `sage/theta-wave` Sundays) |
| Nightly Claude usage audit | Session logs + engineering-agent perf → friction/failure/fix report | LIVE-CRON (`larry/usage-audit`, nightly 11pm) |
| Task auto-reconcile (PR-to-done) | Merged PRs → auto-complete stale in_progress tasks | LIVE-CRON (`larry/task-reconcile`, daily 6am) |
| Code implementation (feature/bug) | Plan → shipping code | HAS-SKILL (`m2c1`) — on-demand |
| Context save/restore | Session state → checkpoint file | HAS-SKILL (`context-save`, `context-restore`) |

---

### CATEGORY 7: KNOWLEDGE MANAGEMENT _(new — missing from first pass)_

| Work Item | Input → Output | Status |
|---|---|---|
| Weekly synthesis | Daily notes + session files → week-of-YYYY-MM-DD.md + durable memory files | LIVE-CRON (`frank2/weekly-synthesis`, Fridays 4pm) |
| Forgotten threads scan | Daily notes + tasks + inbox → dropped item Telegram | LIVE-CRON (`frank2/forgot-anything`, Fridays) |
| Weekly cleanup | Active task files + Todoist → stale-flag edits + Telegram summary | LIVE-CRON (`frank2/weekly-cleanup`, Sundays) |
| Weekly review | Daily notes + git + Gmail + calendar → Telegraph brief | LIVE-CRON (`frank2/weekly-review`, Fridays 6pm) |
| Weekly prep | Next-week calendar + pipeline + AR → Telegraph brief | LIVE-CRON (`frank2/weekly-prep`, Saturdays 2pm) |
| Continuous learning | Session feedback → memory files | HAS-SKILL (`continuous-learning-v2`) |
| Graph/knowledge mapping | Any input → knowledge graph | HAS-SKILL (`graphify`) |
| Community skill catalog browse | cortextOS community catalog → new skill recommendations | LIVE-CRON (`sage/catalog-browse`, Sundays) |

---

### Items MISSING from Josh's First Pass (the "go deeper" value)

1. **Ophir / personal finance tracking** — Monarch MCP agent running continuously; not in original 6 categories
2. **KB reconcile and RAG pipeline** — two separate nightly crons (wiki synthesis + vector reconcile) that keep the RAG current; first pass treated "KB" as one item
3. **Building-in-public pipeline gap** — fleet-activity intel is captured deterministically, but the selection-to-LinkedIn-post path has no active cron (6 content crons killed 2026-07-02); this is an explicit workflow gap to fill
4. **AR / invoice tracking** — finance category has invoicing skill and Moxie integration but zero automated AR scan
5. **Proposal drafting as a workflow** — proposals happen (Marcos, OCG) but there is no cron or dedicated skill that drives the discovery-to-draft loop; it currently lives entirely inside M2C1 ad-hoc
6. **Daily experiment loop + theta-wave** — sage and frank2 both run automated improvement cycles; this whole meta-layer was absent from the first pass
7. **Context budget audit** — weekly automated scan of how much the CLAUDE.md chain, MCP count, and skill count weigh on context; invisible infrastructure