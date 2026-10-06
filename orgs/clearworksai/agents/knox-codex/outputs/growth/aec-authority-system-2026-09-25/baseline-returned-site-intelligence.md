---
title: Baseline Returned-Site Intelligence
date: 2026-09-25
timezone: America/Los_Angeles
status: verified directional research
scope: first Gemini API + Google Search grounding baseline, one repetition
run_id: gemini-api-google-search-20260925-r1
sources:
  - gemini-baseline/gemini-api-google-search-20260925-r1/manifest.json
  - gemini-baseline/gemini-api-google-search-20260925-r1/returned-entity-domain-ledger.json
  - live public pages linked in this document
---

# Baseline returned-site intelligence

## TL;DR

- The first 25-prompt Gemini run did **not mention Clearworks once**. It repeatedly returned a small AEC-specific set—YegaTech, AI in AEC, AEC Hub, Advisor Labs, Zweig Group, Reope, Active AI, and AECforward—because their sites make their category, audience, workflows, proof, and next step unusually explicit.
- Citation visibility is not the same as market credibility. AEC Hub and AIA act as high-leverage ecosystem sources; `bestaiconsultingfirm.com` is a disclosed operator-owned ranking that disproportionately promotes Advisor Labs; several local pages rank despite thin or questionable localization. The baseline is therefore a map of what Gemini could retrieve and synthesize, not an endorsement ledger.
- The ethical Clearworks opportunity is not to imitate the inflated claims. It is to publish direct, evidence-bound answers built from real AEC operating work: named workflows, who owns each handoff, what changes, what the source evidence is, what success means, and one obvious next step.

## What this analysis can and cannot establish

The underlying run completed 25 of 25 prompts with Google Search grounding and produced 324 citation records. Clearworks had zero exact-string appearances. The source-of-truth artifacts are the [run manifest](gemini-baseline/gemini-api-google-search-20260925-r1/manifest.json) and [returned-entity/domain ledger](gemini-baseline/gemini-api-google-search-20260925-r1/returned-entity-domain-ledger.json).

This is **one randomized repetition on one model and one search surface**. Entity recurrence means a name appeared in more answers; citation count means a domain supplied more grounding records. Neither is a visibility rate, market-share estimate, quality score, or proof that a buyer would select the firm. Every proof statement below is labeled as self-published unless independently established by the inspected source itself.

Research was performed on September 25, 2026 PT. Google grounding redirects were resolved to their current destination pages, then the live public pages were inspected. No account login, outreach, paid API, website mutation, or publication occurred.

## Ten commercially relevant recurring entities

### 1. YegaTech — 11 of 25 prompts

- **Verified category / offer:** AEC-only AI strategy, advisory, governance, training, and transformation programs. Its current positioning is “Customized AI strategy, training, and advisory services” for architecture, engineering, and construction firms. ([homepage](https://yegatech.com/); [AI strategy page](https://yegatech.com/ai-strategy-for-architecture-and-engineering-firms/))
- **Audience / geography:** Architecture, engineering, and construction leadership in the United States; the site states that YegaTech is based in California.
- **Primary CTA:** A free consultation or booked call. A secondary assessment CTA scores AI-transformation maturity.
- **Proof on the inspected pages:** Self-published claims include eight US patents, three books, 10,000+ professionals trained, 5,000+ leaders in its community, named work with SSOE and Wade Trim, and client testimonials. These are strong specificity signals, but this review did not independently validate the totals or causal outcomes.
- **Citation-ready pattern:** One industry, one leadership audience, one problem (“scattered experiments”), named client stories, and a clear two-track offer: set direction or build capability. Gemini could lift concise descriptions without inferring what the company does.
- **Conversion path:** Insight page or case narrative → assessment / free consultation → strategy engagement or training program → ongoing advisory.
- **What Clearworks can ethically adapt:** Publish firm-type-specific decision pages and show the bridge from an operating problem to a bounded first engagement. Use only Clearworks’ verified client evidence and distinguish the audit, implementation, and managed-support layers.
- **Hypothesis:** YegaTech’s breadth across category, local, implementation, trust, and consultant-selection prompts comes from topical consistency and proof density more than from any single page.

### 2. AI in AEC — 9 of 25 prompts

- **Verified category / offer:** AEC workflow audits, implementation sprints, workshops, training, and education. The site explicitly says it helps firms move from “scattered experiments” to workflow implementation. ([workflow audit](https://www.aiinaec.com/ai-workflow-audit); [about](https://www.aiinaec.com/about-us))
- **Audience / geography:** AEC firms and practitioners globally. The site claims students in 78 countries and 60+ companies helped; a headquarters location was not established from the inspected pages.
- **Primary CTA:** “Start the Audit,” “Book an Audit,” or “Book a Sprint.” The audit is listed from $6,000 per team with fixed scope and price.
- **Proof on the inspected pages:** Self-published claims include 1,000+ students, 60+ firms helped, 200+ bid-prep hours saved, and one 250-person firm recovering $4.5 million through workflow optimization. Treat these as vendor claims until the underlying case evidence is inspected.
- **Citation-ready pattern:** A memorable problem diagnosis, a numbered implementation process, explicit pricing, a firm-size range, and a sharp point of view: workflows before tools.
- **Conversion path:** Educational content → audit page → fixed-scope audit → sprint / rollout → mastery program.
- **What Clearworks can ethically adapt:** Clearworks already has a stronger evidence-led operating diagnosis. It should make the process legible in public: the actual work-movement map, evidence classes, prioritization method, and the handoff from finding to shipped change. Do not copy AI in AEC’s claims or process language.
- **Hypothesis:** The current audit page is more commercially competitive with Clearworks than the older course-first framing captured in prior research; future tracking should treat AI in AEC as both educator and implementation competitor.

### 3. AEC Hub — 8 of 25 prompts as a named entity; 19 citations across 14 prompts

- **Verified category / offer:** AEC technology directory, buyer-guide publisher, benchmark/resource hub, consultant marketplace, and a direct AI implementation/advisory practice. The consultant page advertises workflow audits through firm-wide rollouts. ([consultant directory](https://www.aechub.org/consultants); [architecture AI buyer’s guide](https://www.aechub.org/guides/best-ai-tools-for-architecture-firms))
- **Audience / geography:** AEC firms; the direct AEC Hub listing says remote service for the United States and globally.
- **Primary CTA:** Browse consultants, run an AI workflow audit, use a calculator/assessment, or book a free AI strategy session.
- **Proof on the inspected pages:** The site displays a 500-tool directory and many structured buyer guides. Consultant proof is a mixture of self-authored profiles, linked vendor pages, and AEC Hub descriptions; each claim should be traced to the listed provider before reuse.
- **Citation-ready pattern:** AEC Hub is the clearest example of a citation engine: category pages, comparison structures, direct-answer headings, tool cards, FAQs, a consultant directory, calculators, and internal links that cover the full buyer journey.
- **Conversion path:** Search-oriented guide / directory → calculator, assessment, or comparison → strategy session / audit → implementation or referral to a listed consultant.
- **What Clearworks can ethically adapt:** Build neutral, evidence-labeled buyer guidance around decisions Clearworks actually sees in audits. Clearly disclose methodology, commercial relationships, and whether a recommendation is independent, partner-linked, or based on client evidence.
- **Important classification:** AEC Hub is **not merely a service provider**. It is an ecosystem source that can both rank providers and sell adjacent implementation. Its 19 citations make it the baseline’s most influential publisher/domain.

### 4. Advisor Labs — 7 of 25 prompts; 8 domain citations

- **Verified category / offer:** Multi-industry AI consulting and digital transformation with a dedicated AEC landing page. Offers readiness assessment, strategy, custom software, process automation, implementation, and post-launch success management. ([AEC practice](https://www.advisorlabs.com/industry/aec-ai); [homepage](https://www.advisorlabs.com/))
- **Audience / geography:** Mid-market and enterprise organizations; AEC is one of several verticals. The site lists a South Jordan, Utah address.
- **Primary CTA:** Free consultation, free assessment, or a saved-email maturity score.
- **Proof on the inspected pages:** Self-published claims include typical 2.5x productivity improvement, a state DOT engagement, a multi-year/multi-million-dollar solution, and “10’s of millions” in annual expense reduction. The AEC page also publishes entry price bands: $8,000–$15,000 for “sprint zero” and $60,000–$180,000 for a production build. These claims require independent case evidence before Clearworks cites them as fact.
- **Citation-ready pattern:** A broad pillar page names workflows—RFI triage, submittal review, lien waivers, bid margin scoring, RFP drafting—then adds FAQs, price ranges, process steps, and a case narrative.
- **Conversion path:** Search landing page → maturity assessment / free consultation → assessment → custom build → implementation / success management.
- **What Clearworks can ethically adapt:** Publish answer pages around specific AEC workflows and selection questions, but ground each one in source evidence, review authority, system boundaries, and what Clearworks has actually built.
- **Hypothesis:** Advisor Labs’ visibility is amplified by a separate operator-owned ranking site, not just its own AEC page. That makes the recurrence commercially important but not independent validation.

### 5. Zweig Group — 6 of 25 prompts; 8 domain citations

- **Verified category / offer:** Established AEC advisory, research, events, training, and AI consulting. Its AI page offers analysis, first steps, a strategic plan, implementation support, change management, training, and on-call services. ([AI consulting services](https://zweiggroup.com/pages/ai-innovation-discovery))
- **Audience / geography:** Architecture, engineering, planning, and environmental firms, primarily in the United States. The inspected page lists Dallas and Fayetteville offices/contact points.
- **Primary CTA:** Contact the AI consulting team / get started.
- **Proof on the inspected page:** The strongest proof is institutional: AEC specialization, an existing research/events/training ecosystem, and a broad advisory portfolio. The page does not expose fixed pricing or a quantified AI case result.
- **Citation-ready pattern:** Long-form service page that connects AI to existing AEC management categories—talent, operations, culture, leadership, process, and profitability—rather than presenting AI as a standalone tool.
- **Conversion path:** Research, events, training, or existing advisory relationship → AI discovery / consulting inquiry → strategic plan → implementation / on-call support.
- **What Clearworks can ethically adapt:** Connect AI content to operational leadership topics rather than publishing detached AI news. Clearworks can be more concrete by showing workflow evidence, artifacts, decision rights, and implemented change.
- **Hypothesis:** Zweig’s domain authority and AEC institutional role likely contribute more to its citation frequency than the AI page alone.

### 6. Reope — 5 of 25 prompts

- **Verified category / offer:** AEC-specific custom software, BIM consulting, and Revit tooling delivered by “architects and engineers who code.” ([official site](https://www.reope.com/); [AEC Hub profile that Gemini cited](https://www.aechub.org/consultants))
- **Audience / geography:** Architecture and engineering design teams, especially those with BIM/Revit automation needs. Headquarters/contact location shown: Oslo, Norway.
- **Primary CTA:** Contact us / get started for software development, consulting, or the toolbox.
- **Proof on the inspected site:** Named testimonials from KPF, Heatherwick Studio, Autodesk, Multiconsult, Oslo Works, and Nordic Office of Architecture; one testimonial claims thousands of hours saved on BIM-delivery standardization. These are attributed client statements on Reope’s site, not independently audited outcomes in this review.
- **Citation-ready pattern:** A crisp category phrase, recognizable client names, testimonials tied to specific workflow outcomes, and clear separation of services, consulting, and products.
- **Conversion path:** Homepage / case / product page → contact or get started → custom software / BIM engagement or plugin purchase.
- **What Clearworks can ethically adapt:** Use named workflow-level proof and show the before/after operating mechanism. Where client permission prevents naming, label the story as anonymized and preserve evidence boundaries.
- **Hypothesis:** Reope’s recurrence is largely ecosystem-mediated through AEC Hub rather than extensive direct-domain citation in this run.

### 7. Active AI — 4 of 25 prompts; 7 domain citations

- **Verified category / offer:** General AI consultancy with programmatic industry pages, including an architecture-firm page offering a $497/month readiness program and custom AI solutions. ([architecture page](https://www.beactive.ai/ai-for-architecture-firms); [about](https://www.beactive.ai/about-active-ai))
- **Audience / geography:** Cross-industry businesses, including small firms; headquartered in Canada with addresses shown in Montréal, Toronto, and New York.
- **Primary CTA:** Free AI strategy session, readiness program, or custom-solutions inquiry.
- **Proof on the inspected page:** The page claims 60% design-time reduction, 80–85% fewer documentation errors, 3x project capacity, and a “Studio Nexus” case story. No independent supporting source or identifiable case-study page was established in this review. These figures should be treated as unverified vendor marketing.
- **Citation-ready pattern:** Exact buyer language, prominent quantified claims, use-case blocks, FAQs, a starting price, and a low-friction free session.
- **Conversion path:** Search-targeted vertical page → free strategy session → monthly readiness offer → custom implementation.
- **What Clearworks can ethically adapt:** The structure—specific pains, use cases, price/fit boundaries, and next step—is useful. The proof standard is not. Clearworks should publish only numbers traceable to an approved evidence ledger.
- **Hypothesis:** Active AI demonstrates that a tightly optimized vertical page can earn grounding citations even when the firm is not AEC-specialist; this is a content lesson, not a credibility endorsement.

### 8. AECforward — 4 of 25 prompts

- **Verified category / offer:** AEC AI studio building custom systems for drawing analysis, document intelligence, knowledge graphs, fabrication/design agents, computational design, layout generation, and visualization. ([official site](https://www.aecforward.ai/); [AEC Hub profile that Gemini cited](https://www.aechub.org/consultants))
- **Audience / geography:** Engineering firms, contractors, and manufacturers. Founder credentials and a France-linked background are shown; the site does not position geography as its primary buying filter.
- **Primary CTA:** Contact / discuss a workflow.
- **Proof on the inspected site:** A four-step delivery path—discovery, prototype, production, support—and founder/domain credentials. The reviewed homepage did not expose the same density of named client proof as Reope.
- **Citation-ready pattern:** A highly differentiated technical vocabulary built around native AEC inputs—PDF drawings, 3D models, IFC, specifications—and clear “what we build” categories.
- **Conversion path:** Technical problem page → discovery → prototype on real data → production integration → training and support.
- **What Clearworks can ethically adapt:** Name the files, systems, handoffs, and review roles involved in a workflow. Show what a bounded proof would ingest and produce without pretending generic AI can interpret every AEC artifact.
- **Hypothesis:** AECforward’s differentiation comes from mechanism specificity, while discovery likely comes through directories and niche ecosystem mentions.

### 9. Lotus AI — 3 of 25 prompts

- **Verified category / offer:** Los Angeles boutique AI consultancy offering strategy, ML platform engineering, LLM/RAG integration, creative AI, analytics platforms, and full-cycle AI product development. ([official site](https://getlotusai.com/))
- **Audience / geography:** Startups through established enterprises; based in Los Angeles. The site does **not** establish AEC as a core vertical.
- **Primary CTA:** “Start a Conversation.”
- **Proof on the inspected page:** Self-published counts of 10+ AI systems, 100+ cinematic scenes, and 400+ development hours. No named AEC case was found.
- **Citation-ready pattern:** Polished local positioning, a broad but well-labeled service taxonomy, and a simple homepage CTA.
- **Conversion path:** Local/category discovery → service overview → conversation → strategy or build.
- **What Clearworks can ethically adapt:** A strong local entity page and clear service taxonomy. Clearworks should outperform it on AEC evidence and specific operating workflows, not on generic AI-development claims.
- **Important boundary:** Gemini repeatedly named Lotus in Los Angeles prompts, but the baseline citations also leaned on a third-party local ranking. It is a local AI competitor, not a verified AEC specialist.

### 10. Perceptive Analytics — 3 of 25 prompts; 4 domain citations

- **Verified category / offer:** Enterprise AI engineering, data engineering, ML, RAG, workflow automation, and analytics consulting, with a Los Angeles landing page. ([Los Angeles AI consulting page](https://www.perceptive-analytics.com/ai-consulting-los-angeles-ca/); [partner-selection guide](https://www.perceptive-analytics.com/how-do-i-choose-an-ai-consulting-partner/))
- **Audience / geography:** Enterprise buyers seeking technical delivery. The site asserts Los Angeles presence plus New York, Miami, and Dallas.
- **Primary CTA:** Free consultation or technical audit.
- **Proof on the inspected pages:** Self-published security/partner statements, enterprise client logos/testimonials, and performance claims. The partner-selection guide is detailed and decision-oriented, but the local page contains obvious localization inconsistencies—including calling Los Angeles the Southeast’s business capital and referring to the world’s busiest airport—so its factual reliability is uneven.
- **Citation-ready pattern:** Direct-answer decision content, named evaluation criteria, comparison tables, red flags, FAQs, technical vocabulary, and internal links to adjacent buyer questions.
- **Conversion path:** Local or “how to choose” answer page → free strategy session / technical audit → architecture review → phased engineering engagement.
- **What Clearworks can ethically adapt:** Publish buyer-decision frameworks with actual AEC examples, explicit evidence limits, and a real local presence. Avoid mass-produced city pages or unsupported “best” language.
- **Hypothesis:** The guide’s answer-first structure is likely more valuable for citations than the local page’s localization quality.

## Ten influential cited domains and exact pages

This list prioritizes **commercial relevance to Clearworks**, not simply the raw top ten domains. It excludes general platforms such as YouTube, IBM, and Microsoft when their citations do not teach us how an AEC AI-services buyer is being routed.

| Domain / page | Baseline footprint | Source type | What Gemini used it for | Intelligence for Clearworks |
|---|---:|---|---|---|
| [AEC Hub consultant directory](https://www.aechub.org/consultants) and [architecture AI guide](https://www.aechub.org/guides/best-ai-tools-for-architecture-firms) | 19 citations / 14 prompts | Directory, publisher, marketplace, and service provider | Provider discovery, tool selection, implementation advice, and comparisons | Highest-leverage ecosystem source. Recreate the decision usefulness with transparent evidence and relationship disclosures, not a pay-to-rank impression. |
| [YegaTech AI strategy](https://yegatech.com/ai-strategy-for-architecture-and-engineering-firms/) | 9 citations / 5 prompts | AEC-specialist provider | Strategy, training, governance, case examples, and insider credibility | Own clear AEC category language and connect it to verifiable operational outcomes. |
| [Advisor Labs AEC practice](https://www.advisorlabs.com/industry/aec-ai) | 8 citations / 8 prompts | Multi-industry provider with AEC vertical page | Named AEC workflows, integration, consulting process, and price bands | Comprehensive pillar pages with FAQs and workflow specificity can create broad prompt coverage. |
| [Best AI Consulting Firm: AEC ranking](https://bestaiconsultingfirm.com/best-ai-consulting-aec/) | 8 citations / 8 prompts | Disclosed operator-owned ranking / comparison publisher | Rankings, provider comparisons, buyer criteria, price ranges, and repeated Advisor Labs claims | Treat as commercially interested content, not independent validation. Clearworks should publish methodology-led guides and clearly disclose interests. |
| [Zweig Group AI consulting](https://zweiggroup.com/pages/ai-innovation-discovery) | 8 citations / 8 prompts | AEC advisory, training, research, and publication ecosystem | Strategy, roadmap, implementation, culture, and training | Tie AI to firm management and operating context; add more concrete proof and bounded deliverables. |
| [Active AI for architecture firms](https://www.beactive.ai/ai-for-architecture-firms) | 7 citations / 7 prompts | General provider’s vertical landing page | Architecture use cases, ROI claims, readiness offer, and workflow ideas | Vertical page architecture works, but unverified proof is a reputational risk. |
| [AIA AI Firm Toolkit](https://www.aia.org/resource-center/ai-firm-toolkit) | 5 citations / 4 prompts | Professional association / authoritative educational source | Responsible adoption, maturity, policy, literacy, and professional judgment | AIA is a trust source, not a provider competitor. Clearworks should connect its content to professional standards and cite primary guidance. |
| [Pedro J. Hernández: AI consulting for architecture studios](https://pedrojhernandez.com/en/ai-consulting-for-architecture-studios/) | 5 citations, all in 1 prompt | Independent provider / niche architecture page | Local/remote consultant discovery and a process-first offer | One sharply focused service page can dominate a narrow prompt. Breadth still requires more topics and independent sources. |
| [AI in AEC workflow audit](https://www.aiinaec.com/ai-workflow-audit) | 4 citations / 4 prompts | AEC-specialist provider and education platform | Workflow-first audit, roadmap, training, implementation process | Clearworks needs equally legible packaging around the work it already does, with stronger evidence provenance. |
| [Perceptive Analytics Los Angeles page](https://www.perceptive-analytics.com/ai-consulting-los-angeles-ca/) and [selection guide](https://www.perceptive-analytics.com/how-do-i-choose-an-ai-consulting-partner/) | 4 citations / 4 prompts | Technical provider plus answer-first publisher | Local consultant discovery, technical depth, and partner-selection criteria | Decision frameworks can earn citations. Programmatic local content with factual errors can also surface, so visibility must not be confused with trust. |

## What the baseline says about citation-ready content

### Verified patterns across the returned sites

1. **The category is written literally.** “AI consulting for AEC,” “AI for architecture firms,” “workflow audit,” and named workflow labels appear in titles, headings, navigation, and body copy.
2. **The reader gets a direct answer early.** The strongest pages state who the service is for, the problem, the method, and the next step before expanding into explanation.
3. **The best pages name operational mechanisms.** RFI triage, submittal review, proposal retrieval, BIM coordination, drawing analysis, project reporting, data handoffs, and governance are more retrievable than generic “transform with AI” language.
4. **Comparison and selection pages travel across prompts.** AEC Hub’s guides, the operator-owned “best firms” list, and Perceptive’s partner-selection framework give the model reusable structures: criteria, tables, fit boundaries, and FAQs.
5. **Offer ladders are visible.** Assessments, free sessions, audits, pilots, training, builds, and ongoing support create clear next-step language for both search engines and buyers.
6. **Proof is attached to the offer.** Named clients, testimonials, prices, process timing, and quantified claims recur on the pages Gemini cited. Proof quality varies widely; visibility does not validate it.
7. **Ecosystem sources matter.** AEC Hub and AIA can establish a provider or decision category without being direct substitutes for the provider.
8. **Local modifiers work even when quality is uneven.** Los Angeles and architecture-specific pages surfaced repeatedly. This supports a real local strategy, but the Perceptive page shows why generated geography copy must be fact-checked.

### Ethical adaptations for Clearworks

- Publish **one answer per real buyer decision**, not generic news: how to choose an AEC AI partner, audit versus pilot, build versus buy, what evidence a workflow audit needs, what “implementation” actually includes, and what a 30/60/90-day first deployment looks like.
- Build pages from approved evidence: transcript-backed quotes, anonymized role stories, source-file examples, delivery receipts, before/after workflow maps, and explicit caveats.
- Make the operating mechanism visible: trigger, source record, owner, review authority, exception, downstream state, and success measure.
- Use local pages only where Clearworks has a genuine service area and local proof. A page for Los Angeles or Pasadena should include Josh’s real AIA involvement, real local availability, and local AEC context—not swapped place names.
- Publish neutral comparison content only when the methodology and commercial interests are visible. It is acceptable for Clearworks to name itself among several choices if the selection criteria are consistent and competitors’ strengths are represented honestly.
- Add a proof path to every authority page: useful answer → relevant case / artifact → one practical diagnostic → conversation CTA. Do not gate the only useful information behind a form.

## Priority gaps Clearworks can now close

1. **Entity clarity:** The current baseline did not retrieve Clearworks. Publish a canonical company/service/about footprint that consistently states “AEC AI operations and implementation partner,” service area, leadership, proof boundaries, and the exact engagement ladder.
2. **Decision content:** The returned ecosystem has multiple “best consultant” and “how to choose” pages; Clearworks lacks equivalent, methodologically stronger buyer guidance.
3. **Workflow pages:** Create specific pages for the workflows Clearworks can prove—project state and handoffs, proposal/RFP operations, meeting/action follow-through, management reporting, systems integration, and AI governance—rather than an undifferentiated AI-consulting page.
4. **Evidence packaging:** Convert approved work into citation-sized facts with source class, date, scope, owner, result, and limitation. This is the strongest defensible contrast with pages whose numbers cannot be independently traced.
5. **External corroboration:** Earn references from AIA chapters, AEC publications, partners, client-authorized case pages, and relevant directories. Do not manufacture a satellite ranking site or undisclosed self-ranking network.
6. **Measurement discipline:** Re-run the frozen prompts across the defined repetitions before interpreting movement. Track entity selection, citations, source diversity, branded queries, AI-referral traffic, lead submissions, and booked meetings as separate metrics.

## Sources

### Baseline evidence

- [Gemini run manifest](gemini-baseline/gemini-api-google-search-20260925-r1/manifest.json)
- [Returned-entity and cited-domain ledger](gemini-baseline/gemini-api-google-search-20260925-r1/returned-entity-domain-ledger.json)
- [Human-reviewed entity mentions](gemini-baseline/gemini-api-google-search-20260925-r1/entity-mentions-reviewed.json)

### Live first-party and exact cited pages

- [AEC Hub consultant directory](https://www.aechub.org/consultants); [AEC Hub architecture AI buyer’s guide](https://www.aechub.org/guides/best-ai-tools-for-architecture-firms)
- [YegaTech](https://yegatech.com/); [YegaTech AI strategy](https://yegatech.com/ai-strategy-for-architecture-and-engineering-firms/)
- [Advisor Labs](https://www.advisorlabs.com/); [Advisor Labs AEC practice](https://www.advisorlabs.com/industry/aec-ai)
- [Zweig Group AI consulting](https://zweiggroup.com/pages/ai-innovation-discovery)
- [AI in AEC workflow audit](https://www.aiinaec.com/ai-workflow-audit); [AI in AEC about](https://www.aiinaec.com/about-us)
- [Reope](https://www.reope.com/)
- [AECforward](https://www.aecforward.ai/)
- [Active AI architecture page](https://www.beactive.ai/ai-for-architecture-firms); [Active AI about](https://www.beactive.ai/about-active-ai)
- [Lotus AI](https://getlotusai.com/)
- [Perceptive Analytics Los Angeles page](https://www.perceptive-analytics.com/ai-consulting-los-angeles-ca/); [partner-selection guide](https://www.perceptive-analytics.com/how-do-i-choose-an-ai-consulting-partner/)
- [AIA AI Firm Toolkit](https://www.aia.org/resource-center/ai-firm-toolkit)
- [Best AI Consulting Firm: AEC ranking](https://bestaiconsultingfirm.com/best-ai-consulting-aec/)
- [Pedro J. Hernández architecture-studio AI consulting](https://pedrojhernandez.com/en/ai-consulting-for-architecture-studios/)
