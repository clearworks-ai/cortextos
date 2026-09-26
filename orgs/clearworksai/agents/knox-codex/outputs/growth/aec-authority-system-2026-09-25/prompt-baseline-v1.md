# Clearworks AEC AI visibility baseline - prompt set v1

Date frozen: 2026-09-25
Minimum freeze: eight weeks
Purpose: measure unbranded discovery, recommendation, citation, and local fit without inventing search demand.

## Frozen weekly core

| ID | Cluster | Exact prompt |
|---|---|---|
| L01 | Local discovery | Who are the best AI consultants for architecture firms in Los Angeles? |
| L02 | Local discovery | Find an AI workflow consultant in Los Angeles who understands architecture and design firms. |
| L03 | Local discovery | Which Los Angeles consultants help small AEC firms implement AI, not just train staff? |
| L04 | Local discovery | Recommend a local advisor for an architecture firm's AI strategy, workflow audit, and implementation. |
| C01 | Category discovery | What firms specialize in AI operations consulting for architecture, engineering, and construction companies? |
| C02 | Category discovery | Who are the best AEC AI implementation consultants for a 25-person architecture firm? |
| C03 | Category discovery | Which consultants help small and mid-size AEC firms move from AI experiments to working systems? |
| C04 | Category discovery | Recommend an independent AEC technology consultant who can connect workflows, data, automation, and AI. |
| U01 | Use case | Our architecture firm rebuilds weekly project reports by hand. Who can help us automate that workflow safely? |
| U02 | Use case | Who can build a searchable AI knowledge system over an architecture firm's standards, project files, and past work? |
| U03 | Use case | Which consultants help AEC firms automate proposals and RFP responses using approved project experience? |
| U04 | Use case | We need meetings, RFIs, submittals, and field updates turned into reviewed actions and records. Who can implement that? |
| P01 | Problem | Our staff use ChatGPT and other AI tools inconsistently, with no ownership or review process. Who can help? |
| P02 | Problem | Our project, staffing, financial, and pipeline information lives in disconnected systems. Can an AEC AI consultant fix this? |
| P03 | Problem | Too much of our architecture firm's knowledge lives in a few senior people's heads. What firms can help us solve that? |
| P04 | Problem | We have several AI pilots but nothing dependable in daily operations. Who can help us move into implementation? |
| X01 | Comparison | For a 40-person architecture firm, should we hire an AEC-specialist AI consultant or a general IT consultancy? |
| X02 | Comparison | Is an AI workflow audit or an AI training workshop the better first investment for an architecture firm? |
| X03 | Comparison | Should our architecture firm buy another AI platform or hire someone to integrate the tools we already have? |
| T01 | Trust/proof | Which AEC AI consultants publish credible case studies with quantified results? |
| T02 | Trust/proof | Who should an architecture firm trust to implement AI around client documents and professional responsibility? |
| T03 | Trust/proof | What should I look for in an AI consultant for an architecture practice, and which firms meet those criteria? |
| I01 | Implementation | I need a consultant to map one workflow, build a pilot, train the team, and stay for ongoing support. Who does this for AEC firms? |
| I02 | Implementation | Who can implement AI in an architecture firm with permissions, source attribution, human review, and writeback to the system of record? |
| I03 | Implementation | What is a practical 90-day AI implementation plan for a 30-person architecture firm, and who could help us execute it? |

## Surfaces

Keep API and consumer UI observations separate.

- OpenAI API with web search
- Gemini API with Google Search grounding
- Perplexity API/search
- Anthropic API with web search, if available and authorized
- Google organic results
- Google local results when triggered
- Google AI Overview or AI Mode when triggered
- manual consumer-UI spot checks in fresh/temporary conversations
- Search Console Generative AI performance report export

Do not automate consumer interfaces using credential-bearing browser sessions without explicit provider permission.

## Initial variance baseline

Run every core prompt five times per supported automated surface over seven days before changing content. For consumer interfaces, use bounded manual samples.

After the baseline:

- Run all 25 prompts once weekly per automated surface.
- Select one sentinel from each of the seven clusters and run two additional repetitions.
- Run a complete three-repetition matrix monthly.
- Do not call a change meaningful unless it exceeds initial run-to-run variance or persists for two consecutive weeks.

## Reproducibility controls

1. Keep prompt spelling, punctuation, and IDs frozen under `prompt_set_version`.
2. Start every prompt in a fresh conversation with no prior context.
3. Randomize order using a stored weekly seed.
4. Record provider, surface, API/UI, model label, search mode, account tier, timestamp, locale, general location, device class, login state, memory state, and personalization state.
5. Retry technical errors only. Preserve failures and never rerun because an answer was unfavorable.
6. Preserve full answer text, citations, canonical and original URLs, and screenshots/rendered receipts where allowed.
7. Treat model/interface upgrades as a measurement-regime change.
8. Add new demand language to the extended set first; do not rewrite the core series.
9. Record demand evidence as unknown or name the observed source/date/value. Never invent search volume.
10. Open each citation and verify whether it supports the nearby claim.

## Scoring dimensions

Never average these into one headline score.

- named visibility rate;
- shortlist rate;
- first-choice rate;
- ordinal position when mentioned;
- Clearworks citation-selection rate;
- third-party corroboration rate;
- supported-claim/citation-fidelity rate;
- citation-absorption rate;
- local-match rate;
- entity-accuracy rate;
- qualified competitor share of voice;
- repetition stability;
- cross-platform source overlap;
- AI Overview trigger rate;
- AI Overview conditional and unconditional Clearworks visibility;
- Google organic top-10 rate and median rank;
- Google local-pack presence.

Mention grade:

- 0: no Clearworks mention;
- 1: unattributed description that could fit Clearworks;
- 2: Clearworks named descriptively;
- 3: Clearworks shortlisted or recommended as a candidate;
- 4: Clearworks explicitly preferred or listed first.

Citation fidelity:

- 0: citation does not support the nearby claim;
- 1: relevant but weak support;
- 2: direct support.

Citation absorption:

- 0: page does not materially inform the answer;
- 1: recognizable fact, definition, or method is paraphrased;
- 2: distinctive evidence, structure, numbers, or procedure is used.

Local fit:

- 0: no Los Angeles relevance;
- 1: service coverage plausible but unstated;
- 2: Los Angeles or Southern California explicitly stated;
- 3: concrete local proof such as AIA LA work, events, projects, clients, reviews, or service presence.

## Required run record

```text
run_id
protocol_version
prompt_set_version
prompt_id
prompt_text
cluster
buyer_stage
platform
surface
ui_or_api
model_label
search_mode
account_tier
run_timestamp
repetition
randomization_seed
logged_in
memory_state
personalization_state
connected_apps_state
device_location_state
ip_general_area
locale
device_class
technical_status
ai_overview_triggered
response_text_or_receipt_path
clearworks_mention_grade
clearworks_ordinal_position
recommendation_strength
exact_mention_excerpt
local_fit
entity_accuracy
competitors_in_order
citations
organic_rank
local_pack_rank
```

## Returned-entity inspection

Inspect every named company and every cited domain that appears in a valid run:

1. Normalize entity, domain, URL, result type, prompt, platform, and position.
2. Inspect the exact cited/ranking page plus homepage, about/team page, main service page, strongest proof page, and conversion page.
3. Record title/H1, value proposition, audience, firm-size fit, category, services, sequence, geography, CTA, and friction.
4. Grade proof from unsupported claim through independently corroborated measured result.
5. Inspect definitions, statistics/provenance, expert quotations, comparisons, procedural content, original research, authorship, reviewed dates, direct answers, and internal links.
6. Inspect robots, indexability, canonical, sitemap, HTTPS, text availability, structured data validity, OAI-SearchBot, and Googlebot access.
7. Inspect NAP consistency, service area, Business Profile, reviews, local projects/clients, AIA relationships, events, and local citations.
8. Record the likely retrieval/ranking mechanism as a dated hypothesis, never as a known ranking factor.

## Initial uncontrolled reconnaissance

These are starting entities for identity matching, not baseline visibility scores:

- AEC Hub
- Digital Flow
- DataDrivenAEC
- Harmonic Intelligence
- AI in AEC
- AI Architecture Lab / ArchAIFlow
- Hallian Technologies
- YegaTech (page inspection incomplete due HTTP 429)

Recurring category claims include AEC specialization, workflow-before-tools, bounded pilots, implementation plus training, internal ownership, governance, baselines, and ongoing support. Clearworks must differentiate through evidenced operating depth, Los Angeles/AIA relationships, workflow-to-system implementation, careful outcome labels, and the audit-to-embedded-partnership path.
