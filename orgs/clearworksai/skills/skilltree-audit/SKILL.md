---
name: skilltree-audit
description: "The SkillTree map (altari.ai/skilltree) charts every AI job-to-be-done in a business across 7 departments. You can mark your own deployment status by hand · or you can run this audit and let an agent compute it. It inspects your environment for evidence (keys, tools, files, integrations), asks you only what it can't see, grades honestly, and outputs: Use when working on: Company Knowledge Base."
---

# SkillTree Audit · your tree, computed

**Category:** Foundation
**Version:** 1.0
**Part of:** SkillTree · altari.ai/skilltree

> The map asks 137 questions. This skill answers them by looking at your actual stack · then hands you a file the map can import.

## What This Is

The SkillTree map (altari.ai/skilltree) charts every AI job-to-be-done in a business across 7 departments. You can mark your own deployment status by hand · or you can run this audit and let an agent compute it. It inspects your environment for evidence (keys, tools, files, integrations), asks you only what it can't see, grades honestly, and outputs:

1. **`skilltree-your-tree.json`** · import it on the map (V1.0 chip → Import) and watch your tree light up
2. **A gap report** · where you actually are, the FTE cost of your biggest gaps, and the three builds to do next, in dependency order

## Required API Keys

None. The audit reads your environment; it never calls external services.

## How to Run

Drop this file into the project where your business actually runs (or `~/.claude/skills/` if you use Claude Code), then tell Claude:

- "Run the SkillTree audit"
- "Audit my AI stack"
- "Compute my tree"

---

## Agent Instructions

> Everything below this line is what Claude follows when running this skill.

### Identity

You are an AI operations auditor. Your job is to grade this business against the SkillTree taxonomy · honestly. An inflated audit is worthless: the user makes build decisions from this. When in doubt, grade down and say why.

### Grading Rubric

For every job in the checklist, assign exactly one status:

- **`live`** · AI does this work today, on real volume, regularly. Not a demo, not a one-off experiment. If it stopped tomorrow, someone would notice this week.
- **`dev`** · partially built, being tested, or running but unreliable / still human-driven with AI assistance.
- **not started** · everything else, including "we have the tool but never use it." Omit these from the output file entirely.

Hard rules: a subscription is not deployment. A ChatGPT tab is not deployment. If the user hesitates or says "kind of," it's `dev` at best.

### Phase 1 · Evidence Scan (don't ask what you can see)

Inspect the environment before asking anything:

1. **Env files** (`.env`, `.env.local`, etc. · read key NAMES only, never print values): CRM keys (HubSpot/Attio/Salesforce), transcription (Fireflies/Deepgram/Otter), sending (Instantly/HeyReach/SendGrid/Resend), enrichment (Apollo/Exa/Clay/Apify), payments (Stripe), calendars (Cal.com/Calendly), AI providers.
2. **Stack file**: does `knowledge/stack.md` exist? If yes, read it · it names the CRM/sending/notetaker/payments tools and settles many "do you have X wired" questions before you ask them. If no, note its absence in the report (it's part of brain).
3. **Knowledge base**: does a `knowledge/` folder (or equivalent · context files, client files, a STATE/handoff doc) exist? Is it current (check dates)? This settles `HUB::Company Knowledge Base`.
4. **Project structure**: automation code (jobs/, crons, webhooks, integrations/), output folders (proposals, emails, reports · generated artifacts are evidence of live jobs), skill/agent files already installed.
5. **Git history** (if available): does automation code change regularly, or was it touched once six months ago?

A key proves access, not deployment · evidence settles a job as "worth asking about specifically," and obvious absence settles it as not started.

### Phase 2 · Interview (batched, fast)

Walk the 7 departments in order. For each, ask about ONLY the jobs the evidence didn't settle · in one batched message per department, grouped plainly ("Do replies to your outbound get classified automatically, or do you read them all yourself?"). Accept short answers. Push back once if an answer smells inflated ("running daily, or ran once?"). Skip whole departments the user says don't apply (no community → skip Community; no employees → skip Talent) · mark those jobs not started, note the skip in the report.

### Phase 3 · Write the Tree File

Output `skilltree-your-tree.json` in the project root, EXACTLY this shape:

```json
{
  "resource": "skilltree",
  "version": "1.0",
  "exported": "<ISO timestamp>",
  "states": {
    "HUB::Company Knowledge Base": "live",
    "Sales::ICP Definition": "dev"
  }
}
```

Keys must match the canonical checklist below CHARACTER-FOR-CHARACTER (department name, two colons, job name). Only include `live` and `dev` entries. Any key not in the checklist will be ignored by the map.

### Phase 4 · The Gap Report

Deliver in chat (and save as `skilltree-audit-report.md`):

1. **The number**: "X of 137 live, Y in development." Per-department one-liners.
2. **Brain verdict**: knowledge base status, and what it's costing if absent (every other job grades lower without it · say so plainly).
3. **Top 3 next builds**, in dependency order, each with: why now (what's already live that it builds on), what it replaces (hours or salary), and effort guess (days, not weeks). Use the sequence doctrine: knowledge base first, then each department's foundation node · `Sales::ICP Definition`, `Deals::Call Capture`, `Marketing::Performance Mining`, `Operations::Context Maintenance`, `Intelligence::Company Deep-Dive`, `Customer::FAQ & Self-Serve`, `Back Office::Invoice Generation` · then jobs whose prerequisites are live.
4. **Close**: "Import `skilltree-your-tree.json` at altari.ai/skilltree (V1.0 chip → Import) to see your tree."

### Canonical Checklist · 137 Jobs

Grade every job. Key format: `Department::Job Name`.

Plus brain: `HUB::Company Knowledge Base` · the knowledge base itself.

### Sales
- `Sales::ICP Definition` · Define and refine ideal customer profiles per vertical · firmographics, pain patterns, buying triggers.
- `Sales::Market Mapping` · Map the total addressable companies in a target vertical before a campaign.
- `Sales::Trigger Detection` · Watch for buying signals · hiring, funding, tech changes, leadership moves.
- `Sales::Lookalike Modeling` · Build new target lists off the shape of your closed-won accounts.
- `Sales::Database Mining` · Pull targeted company and contact lists from structured databases.
- `Sales::Web & Maps Scraping` · Scrape local businesses, directories, and niche sources for leads.
- `Sales::Social Mining` · Harvest engaged audiences · post commenters, followers, group members.
- `Sales::List Building` · Merge, dedupe, and segment raw leads into campaign-ready lists.
- `Sales::Contact Enrichment` · Find and append emails, phones, and LinkedIn profiles to every lead.
- `Sales::Email Verification` · Validate every address before it ever gets a send.
- `Sales::Account Enrichment` · Layer firmographics, tech stack, and headcount trends onto target accounts.
- `Sales::Fit Scoring` · Score every lead against ICP so outreach spends effort where it converts.
- `Sales::Personalization Research` · Build a personalization dossier per prospect · hooks, context, common ground.
- `Sales::Cold Email Drafting` · Write multi-step cold email sequences tuned to the vertical and offer.
- `Sales::LinkedIn Messaging` · Draft connection notes and DM sequences that read human.
- `Sales::Proof Matching` · Match the right case study to each prospect’s industry and problem.
- `Sales::Cold-Call Scripting` · Call and voicemail scripts with branching objection handling that read human.
- `Sales::Video Prospecting` · Personalized video scripts · the hook, the personal line, the CTA, under 90 seconds.
- `Sales::Campaign Orchestration` · Build multi-channel cadences · email, LinkedIn, phone touches in order.
- `Sales::Campaign Launch` · Push finished campaigns into sending platforms with correct settings.
- `Sales::Deliverability` · Keep domains healthy · warmup, spam testing, inbox rotation.
- `Sales::Send Optimization` · Schedule sends by timezone and pace volume to protect reply rates.

### Deals
- `Deals::Reply Classification` · Read every reply and tag it · interested, objection, referral, not now, never.
- `Deals::Objection Response` · Draft responses to common objections from a tuned library.
- `Deals::Hot-Lead Routing` · Route interested replies to the calendar and the pipeline instantly.
- `Deals::Meeting Booking` · Propose slots, book calls, chase no-shows.
- `Deals::Referral Capture` · Spot the "talk to my colleague" replies and action the warm intro.
- `Deals::Speed-to-Lead` · Acknowledge and engage every inbound lead within minutes.
- `Deals::Lead Qualification` · Parse intake forms and score inbound leads before a human looks.
- `Deals::Comment-CTA Fulfillment` · Detect keyword comments on content and deliver the promised asset by DM.
- `Deals::Inbox Triage` · Sort inbound email and DMs · client, lead, brand deal, noise.
- `Deals::Pre-Call Briefing` · Build a brief before every call · who, company, history, objectives, talking points.
- `Deals::Call Capture` · Record, transcribe, and file every meeting automatically.
- `Deals::Post-Call Debrief` · Extract outcomes, action items, and deal updates from the transcript.
- `Deals::Follow-Up Drafting` · Draft the recap email with next steps before the prospect forgets the call.
- `Deals::Objection Library` · Mine every call for the objections that come up · build the rebuttals that win.
- `Deals::Demo Prototyping` · Turn discovery notes into a working visual prototype before the next meeting.
- `Deals::Proposal Generation` · Generate branded proposals rendered to PDF from call context.
- `Deals::Deal Room Assembly` · Spin up tracked, password-gated deal rooms per prospect.
- `Deals::Agreement Drafting` · Produce the services agreement the moment a deal closes verbally.
- `Deals::Pricing Support` · Model anchors, phase structures, and ROI comparisons per deal.
- `Deals::CRM Hygiene` · Keep records deduped, fields normalized, stages honest.
- `Deals::Pipeline Reporting` · Weekly pipeline state · what moved, what stalled, what closes next.
- `Deals::Forecasting` · Probability-weight the pipeline into a revenue forecast.
- `Deals::Reactivation` · Revive dormant deals and win back lost ones on a schedule.
- `Deals::Win/Loss Analysis` · Tag why deals close or die; feed patterns back into targeting.

### Marketing
- `Marketing::Performance Mining` · Rank your own content corpus · what worked, what to re-hash.
- `Marketing::Trend Monitoring` · Watch the niche for breaking topics and rising formats.
- `Marketing::Competitor Analysis` · Scrape and transcribe competitor content; extract hook patterns.
- `Marketing::Audience Analysis` · Mine comments and DMs for questions, objections, and content ideas.
- `Marketing::Hook Writing` · Generate and rank hooks per platform from proven patterns.
- `Marketing::Script Writing` · Full reel and video scripts in the house voice.
- `Marketing::Caption Writing` · Platform-correct captions with CTA placement rules baked in.
- `Marketing::Carousel Production` · Design and export branded carousel slides.
- `Marketing::Video Production` · Programmatic video · overlays, captions, motion graphics on recordings.
- `Marketing::Image Generation` · Brand-consistent images from reference libraries.
- `Marketing::Thumbnail & Cover Design` · Scroll-stopping thumbnails and covers tuned to earn the click.
- `Marketing::Ad Creative` · Generate and iterate paid-ad variations · hooks, angles, formats.
- `Marketing::Landing Page Copy` · Conversion copy for the whole page · hero, proof, offer, FAQ, CTA.
- `Marketing::Deck Production` · Webinar and talk decks in the brand design system.
- `Marketing::Cross-Platform Adaptation` · One idea → native formats for every platform.
- `Marketing::Clip Extraction` · Cut long recordings into short-form clips worth posting.
- `Marketing::Lead-Magnet Builds` · Turn content themes into gated guides and landing pages.
- `Marketing::Publishing` · Schedule and post across platforms via API.
- `Marketing::Newsletter & Broadcast` · Design and send the weekly email in the brand system.
- `Marketing::SEO & GEO` · Make the site legible to search engines and LLMs.
- `Marketing::OG & Share Surface` · Every page ships with share-ready open-graph imagery.
- `Marketing::Deal Scripting` · Sponsored scripts in the proven format, per brand brief.
- `Marketing::Approval Docs` · Brand-safe formatted docs for sponsor sign-off.

### Operations
- `Operations::Kickoff Pack` · Welcome email, access checklist, and project scaffold the day a deal closes.
- `Operations::Access Collection` · Chase and verify every credential and API key needed to build.
- `Operations::Project Scaffolding` · Stand up the repo, context files, and plan for a new engagement.
- `Operations::Document Extraction` · High-volume structured extraction from client documents.
- `Operations::Integration Builds` · Wire client systems together · CRMs, calendars, transcripts, payments.
- `Operations::Data Migration` · Move and clean data between systems without losing or mangling a row.
- `Operations::Portal Provisioning` · Spin up client-scoped delivery portals with live status.
- `Operations::QA & Verification` · Verify every build against real data before the client sees it.
- `Operations::Agent Evaluation` · Test agent outputs against a benchmark before they touch real work.
- `Operations::Monitoring & Alerting` · Watch every automation for failures and silent stalls · know before the client does.
- `Operations::Cost & Usage Tracking` · Token and API spend tracked against budget · no surprise bills.
- `Operations::Incident Response` · When an automation breaks · triage, root-cause, fix, and write the note.
- `Operations::Status Updates` · Clients see progress without asking for it.
- `Operations::Meeting Follow-Ups` · Client call transcripts → action items → assigned and tracked.
- `Operations::Portal Sync` · Session summaries and deliverables flow into the client portal automatically.
- `Operations::Transcript Processing` · Every meeting becomes searchable, structured context.
- `Operations::Context Maintenance` · Per-client context files stay current as work happens.
- `Operations::SOP Generation` · Turn delivered work into reusable playbooks.
- `Operations::Handoff Docs` · Clean documentation when a system ships to the client.

### Intelligence
- `Intelligence::Company Deep-Dive` · Financials, growth signals, org structure, strategic posture.
- `Intelligence::Tech-Stack Detection` · What a target company runs, and where the gaps are.
- `Intelligence::Funding & Financials Lookup` · Rounds, investors, revenue estimates, filings · who just got budget.
- `Intelligence::Buying-Committee Mapping` · Who actually decides · economic buyer, champion, blockers, their roles.
- `Intelligence::Person Research` · Background, content trail, interests, mutual ground for any contact.
- `Intelligence::Network Mapping` · Who knows whom · paths into a target account.
- `Intelligence::Warm-Path Finding` · The shortest real intro path into a target account · who can connect you.
- `Intelligence::Competitor Teardown` · Pricing, positioning, strengths, weaknesses, exploitable gaps.
- `Intelligence::Vertical Analysis` · Is this vertical worth entering · demand, budgets, buying behavior.
- `Intelligence::Pricing Research` · What the market charges, anchors, and packaging patterns.
- `Intelligence::TAM / Market Sizing` · How many companies actually fit · the real size of the prize.
- `Intelligence::Account Monitoring` · Watch a target list for funding, hiring, leadership, and tech changes · ongoing.
- `Intelligence::News & Mention Tracking` · Every mention of your brand, competitors, and topics · as it lands.
- `Intelligence::Alert Routing` · The signals that matter reach the right person · the noise gets filtered.
- `Intelligence::Research Reports` · Any question → structured, cited report with diagrams.
- `Intelligence::Data Visualization` · Turn a pile of research into charts and diagrams that explain themselves.
- `Intelligence::Adversarial Verification` · Claims get attacked before they get believed.

### Customer
- `Customer::Ticket Triage` · Classify, prioritize, and route every support request the moment it lands.
- `Customer::FAQ & Self-Serve` · Answer the questions that repeat · and turn them into living help content.
- `Customer::Escalations` · Spot the angry, the churn-risk, and the edge case · and get a human there fast.
- `Customer::Macro Authoring` · Turn the tickets that repeat into canned, on-brand responses agents reuse.
- `Customer::Onboarding Journeys` · Guide every new customer through activation, step by step.
- `Customer::Health Scoring` · Score every account on usage, sentiment, and engagement · before renewal season.
- `Customer::Churn Prediction` · Predict which accounts are about to slip · before the usage even dips.
- `Customer::Renewals & Expansion` · Time renewal conversations and spot upsell openings.
- `Customer::Advocacy & Referrals` · Turn your happiest customers into referrals, reviews, and case studies.
- `Customer::QBR Prep` · Build the quarterly business review from real account data.
- `Customer::Engagement & Replies` · Every member question and mention gets a response in the house voice.
- `Customer::Moderation` · Keep the space clean · spam, conduct, and noise handled quietly.
- `Customer::Member Spotlights` · Find and celebrate member wins · the retention engine.
- `Customer::Event Coordination` · Run the AMAs, calls, and spotlights on a cadence the community can count on.

### Back Office
- `Back Office::Invoice Generation` · Branded invoices per entity, currency, and tax treatment.
- `Back Office::Payment Tracking` · Know what’s paid, due, and late · without opening a bank app.
- `Back Office::Collections` · Overdue invoices get chased politely and persistently.
- `Back Office::Revenue Reporting` · Monthly revenue truth across entities and currencies.
- `Back Office::Goal Pacing` · Tracking against the income target, with pace forecasts.
- `Back Office::Cash-Flow Forecasting` · Project cash in and out · know your runway before it becomes an emergency.
- `Back Office::Budget Tracking` · Spend vs budget by category, with overruns flagged early.
- `Back Office::CRM Sync` · Deals, contacts, and statuses stay current everywhere.
- `Back Office::Expense Categorization` · Spend categorized for the accountant before they ask.
- `Back Office::Document Filing & Retrieval` · Every document named, filed, and findable in ten seconds.
- `Back Office::Contract Lifecycle` · Renewals, expiries, and obligations tracked so nothing sneaks up.
- `Back Office::Entity Compliance` · Filings and obligations per entity, tracked and scheduled.
- `Back Office::Calendar Management` · Scheduling, conflicts, buffers, and timezone math handled.
- `Back Office::Email Triage` · The inbox sorted by what actually needs the human.
- `Back Office::Candidate Sourcing` · Find and rank candidates for open roles across platforms.
- `Back Office::Screening & Scheduling` · First-pass screens and interview logistics, handled.
- `Back Office::Onboarding & Training` · New hires get the playbooks, access, and 30-day plan automatically.
- `Back Office::HR & Policy Assistant` · Answer staff policy questions from the real handbook · leave, expenses, onboarding admin.


---

*From SkillTree by Altari · the map of every AI job-to-be-done in a business. The audit is free; so is the map. altari.ai/skilltree*
