# Clearworks AEC authority system - master checklist

Date: 2026-09-25
Status: active working checklist; research and private content package complete, production measurement gates still open
Governing task: `task_1790398044100_06722606`

## Current state - 2026-09-26

The authority strategy is ready to move into reviewed content production. The measurement implementation is not yet live, and no Google-ranking claim is supported.

| Layer | State | Governing evidence or gate |
|---|---|---|
| Open-source tool decision | Complete | OneGlanse: do not deploy as-is; preserve a later choice between a hardened disposable lab and adapting the safe concepts. SerpBear: private loopback pilot only after hardening; not a Maps or AI-answer tracker. |
| Buyer-prompt baseline | Complete, directional | Gemini + Google Search grounding run `gemini-api-google-search-20260925-r1`: 25/25 successful prompts, 114 grounding queries, 324 citation records, raw receipts preserved. One run is not a visibility score. |
| Returned-site intelligence | Complete for first sample | Ten recurring provider entities and ten influential source/page profiles inspected with 49 live links. |
| Public keyword/SERP study | Complete with limits | 35 query rows and 18 provisional opportunities. Accessible volume is broad-category evidence; generic web-search ordering is discovery only, never Google/Bing rank. |
| Google/Search Console truth | Blocked | Human task `task_1790406824361_93723891` for read-only Search Console access or export. Josh's manual Google check did not show Clearworks for one exact query; that is a bounded observation, not a universal absence claim. |
| GA4-to-lead proof-loop code | Implemented and reviewed off-production | Site branch through `f34c23778c91936d37759161567bd6669edb95f1`; receiver reliability commit `410b54d676bda7a23bd5e0d80d615624b83dff43`. Production cutover remains separate and gated. |
| Zcal lifecycle receiver | Release slice PASS, not deployed | Immutable SHA `8889f81cf2b8c29dc5f8b5f3fa9e885c6b9ae05a`; 18/18 tests, 28-page build, exact route/config/manifest checks. Blocked on `approval_1790437084_k0r60` before D1, secret, binding, subscriber, or deploy mutation. |
| Private authority content package | Complete and independently reviewed | Five briefs at governing content commit `48b8ce37f127cef17572801b9d7e764492d72d06`; checklist receipt `150ed081`. No publication has occurred. |

### Next dependency-ordered actions

1. Obtain the Search Console export/access and freeze the pre-publication Google baseline.
2. Resolve the explicit Zcal production decision. If approved, deploy only immutable SHA `8889f81...` through its gated release procedure and verify create/reschedule/cancel plus the unchanged lead route.
3. Reconcile the broader lead/CRM cutover only through its own production gate; do not infer it from Zcal approval.
4. Select the first canonical page from the five reviewed briefs and publish through a separately reviewed site branch.
5. Record indexation, retrieval/citation, multi-asset engagement, qualified conversations, and booked outcomes as separate measures.
6. At the tool-choice gate, present Josh with the explicit OneGlanse choice: hardened disposable lab, safe-concept adaptation, or acceptance of the documented account/policy/maintenance risk. Do not silently drop the tool.

## Outcome

Build a reliable loop that can answer five questions every week:

1. What do real AEC buyers ask Google and AI answer engines?
2. Which companies, pages, people, and sources are returned now?
3. Why are those sources retrieved, cited, or ranked?
4. Where does Clearworks have a defensible evidence advantage or content gap?
5. Which content and proof should Clearworks publish next, and did it produce qualified attention or pipeline?

Content production starts only after the baseline, measurement, and buyer-journey instrumentation are usable.

## Non-negotiable boundaries

- Separate originating awareness from web acquisition and assisted validation.
- Never claim person-level identity from an anonymous analytics sequence without a deterministic join.
- Never send names or email addresses to GA4.
- No new cookie/analytics-consent popup in the current build. GA browser client/session identifiers are deferred; the durable proof loop must not depend on them.
- Treat AI-answer output as sampled, volatile evidence, not a stable rank.
- Do not create city or neighborhood doorway pages without real local evidence and demand.
- Do not publish generated provider rankings before the methodology, disclosure, and source ledger exist.
- Install third-party open-source tools in isolation before granting credentials or production access.
- Production code changes require a dedicated branch/worktree, tests, a pushed PR, and explicit merge/deploy authorization.

## Workstream 0 - Evidence and ownership

- [x] Create the governing task and mark it in progress.
- [x] Create a dedicated cortextOS worktree and branch for durable artifacts.
- [x] Preserve the verified Justin Garner journey boundary: warm referral origin, Google/site validation, later booking.
- [x] Preserve the GA4 audit and its exact failure matrix.
- [ ] Record every repository, license, version, commit, container image, and external service used.
- [ ] Define owners for analytics, site publishing, CRM mapping, weekly measurement, and content approval.
- [ ] Create a secrets inventory without copying secret values into artifacts.

Acceptance:

- Every subsequent checklist item points to a source, owner, test, or explicit blocker.

## Workstream 1 - OneGlanse source audit and isolated proof

Interim safety gate: do not connect any real provider account. Source review found plaintext browser session-state storage, consumer-UI automation that conflicts with multiple provider restrictions, contaminated Gemini sampling through conversation reuse, and an unresolved scheduler defect. Continue only credential-free local checks and assess reusable architecture rather than deployment.

- [x] Pull the complete OneGlanse source and record the inspected commit.
- [x] Confirm license and dependency licenses.
- [x] Map its services, queues, databases, browser workers, schedulers, authentication, and retention model.
- [x] Inspect how provider sessions and credentials are stored and refreshed.
- [x] Inspect whether browser automation violates or materially risks provider accounts or terms.
- [x] Confirm prompt scheduling, retries, rate limits, concurrency, failure capture, screenshots/raw responses, and dedupe.
- [x] Confirm whether location, locale, login state, and personalization can be controlled and recorded.
- [x] Confirm exports/API access and whether observations remain reproducible outside its UI.
- [x] Run a credential-free local boot/build in an isolated directory.
- [x] Run unit/static checks available in the repository.
- [x] Run safe synthetic authentication/readiness behavior with mocked state.
- [x] Document CPU, memory, storage, browser, database, and operational requirements.
- [x] Issue a `USE`, `ADAPT`, or `REJECT` verdict with source locations: **REJECT deployment; ADAPT selected API-first data and UI concepts.**

Acceptance:

- The service boots without production credentials.
- A synthetic observation can be scheduled, stored, retrieved, and exported.
- Account and policy risks are explicit before any real provider login is introduced.

## Workstream 2 - SerpBear source audit and isolated proof

Interim safety gate: conditional private pilot only. Do not expose publicly or connect valuable credentials until authentication defects, vulnerable dependencies, and failing tests are resolved. SerpBear covers conventional organic ranks only; it does not measure Maps/local packs or AI-answer citations.

- [x] Pull the complete SerpBear source and record the inspected commit.
- [x] Confirm license and dependency licenses.
- [x] Map database, authentication, scheduler, scraping/provider, proxy, and Search Console paths.
- [x] Verify keyword, location, language, device, domain, and competitor dimensions.
- [x] Determine whether local-pack results are observed or only conventional web rankings.
- [x] Determine the real requirement and cost for SERP APIs or proxies.
- [x] Inspect rate-limit handling, retries, history retention, export, and backup.
- [x] Verify Google Search Console permissions and data boundaries.
- [x] Install dependencies and complete a credential-free production build in isolation.
- [x] Run repository tests: build passed; upstream tests failed 15 of 39; dependency audit found 32 production vulnerabilities.
- [x] Issue a `USE`, `ADAPT`, or `REJECT` verdict with source locations: **conditional loopback pilot only; ADAPT provider/GSC concepts rather than deploy publicly.**

Acceptance:

- The application boots locally, persists a test project and keyword, and proves one update cycle without touching production.
- The limits of local-intent measurement are explicit.

## Workstream 3 - Prompt and query universe

- [x] Define the buyer roles: principal/executive, operations leader, technology/BIM leader, engineering leader, contractor/design-build leader, and investor/portfolio operator.
- [x] Define intent clusters:
  - local/category discovery;
  - problem diagnosis;
  - use-case discovery;
  - trust and proof;
  - partner selection;
  - training vs strategy vs implementation;
  - build vs buy vs connect;
  - cost/timeline/commercial shape;
  - security/governance/professional judgment;
  - ongoing adoption and administration.
- [x] Research real vocabulary from recent practitioner discussions, CRM questions, AEC sites, and public sources; Search Console/AIA/internal refresh remains a quarterly input.
- [x] Create a broad candidate set without inventing search volume.
- [x] Select a frozen 25-prompt weekly core with clear inclusion criteria.
- [x] Maintain an extended rotating set for exploration and content research.
- [x] Record exact prompt text, engine, account state, locale, location, date/time, model/mode, and personalization state.
- [x] Define when prompt changes create a new series rather than rewriting history.

Acceptance:

- Every core prompt maps to a buyer, intent, commercial decision, and potential Clearworks page or proof source.
- Prompt wording and test conditions are versioned.

## Workstream 4 - Baseline capture across Google and AI answers

- [x] Complete the first directional Gemini API + Google Search grounding run: 25/25 prompts succeeded, with 114 grounding queries, 324 citation records, and raw receipts preserved. This is one repetition, not a visibility score.
- [x] Complete a generic web-search demand study across 35 query rows and rank 18 provisional opportunities. This is discovery evidence, not an observed Google SERP or controlled rank-tracker series.
- [ ] Capture Google organic results for the frozen query set with locale, device, and location controls.
- [ ] Capture Google local/map results separately where the query triggers them.
- [ ] Capture Google AI Overview or AI Mode only when shown; record `not triggered` separately from `not cited`.
- [ ] Export the dedicated Search Console Generative AI performance report before content changes and retain its page/country/device/date baseline.
- [ ] Confirm whether the dedicated Generative AI report is available through an API; until proven, treat the documented UI export as the authoritative extraction path.
- [ ] Capture ChatGPT Search, Gemini, and Perplexity outputs under controlled test conditions.
- [ ] Preserve the full answer, citations, ordering, recommendation language, and screenshots/raw receipts where permitted.
- [ ] Repeat a subset to measure same-day volatility before interpreting ranks.
- [ ] Score independently:
  - Clearworks mention;
  - Clearworks citation;
  - citation prominence;
  - recommendation/shortlist status;
  - accurate category description;
  - competitor mention/citation share;
  - source diversity;
  - answer stability.
- [ ] Never collapse Google rank and AI-answer visibility into one score.

Acceptance:

- The same frozen prompt can be rerun and compared without losing its test conditions or raw evidence.
- Baseline uncertainty and provider failures remain visible.

## Workstream 5 - Returned-company and source-site intelligence

- [x] Complete a first live inspection of 10 recurring provider entities and 10 influential cited source/page profiles from the Gemini baseline, with 49 live source links and explicit source classifications.
For every organization or source returned often enough to matter:

- [ ] Normalize entity, domain, URL, page title, result type, and engine.
- [ ] Distinguish service provider, software vendor, association, publication, directory, academic source, and social/community source.
- [ ] Inspect the cited/ranking page and its surrounding content cluster.
- [ ] Record category language, audience, geography, offer, CTA, proof, named clients, case studies, credentials, reviews, authorship, reviewed dates, citations, and disclosures.
- [ ] Inspect crawlability, canonicalization, internal links, sitemaps, robots directives, and supported structured data.
- [ ] Inspect local entity consistency: Business Profile, address/service area, association pages, directories, reviews, local links, and event/speaking evidence.
- [ ] Inspect conversion path: direct contact, booking, lead magnet, newsletter, assessment, or product trial.
- [ ] Record why the page may have earned retrieval or ranking as an evidence-based hypothesis, not fact.
- [ ] Tag tactics Clearworks can ethically adapt and tactics to avoid.

Acceptance:

- Every competitive conclusion links to an inspected page and a dated observation.
- Provider size, evidence, and category fit are not inferred from marketing language alone.

## Workstream 6 - AEO/GEO field research

- [x] Run `/last30days` on open-source and low-cost niche-brand SEO/GEO practice.
- [x] Review official Google guidance on AI features, local visibility, structured data, crawlability, and measurement.
- [x] Review official OpenAI crawler/search-publisher guidance.
- [x] Review primary empirical GEO research and separate replicated findings from unvalidated claims.
- [x] Run a dated public keyword/SERP study with verified-volume, zero-reported, and unknown evidence classes. Broad demand exists; most exact consultant/audit/local/size phrases reported zero in the accessible Google Ads-derived source.
- [ ] Document platform volatility, personalization, query fan-out, citation selection, and citation absorption.
- [ ] Document what schema can clarify and what it cannot guarantee.
- [ ] Compare open-source tools for AI visibility, rank tracking, technical SEO, plagiarism, analytics, and content briefs.
- [ ] Identify where conventional SEO remains the governing mechanism.
- [ ] Produce a claim ledger with `official`, `empirical`, `practitioner`, `vendor`, or `hypothesis` evidence classes.

Acceptance:

- Recommendations cite primary or direct sources.
- No tactic is presented as proven solely because a GEO vendor says it works.

## Workstream 7 - GA4 -> lead -> CRM -> booking proof loop

### Client and attribution

- [ ] Import shared `SiteAnalytics` on the standalone homepage.
- [ ] Verify every homepage booking link emits exactly one `booking_link_click`.
- [ ] Generate one stable UUID `submission_id` per form attempt.
- [ ] Persist immutable first-touch fields and refreshed last-touch fields.
- [ ] Carry landing URL, referrer, UTM fields, current URL, and timestamps into the private lead record.
- [ ] Deferred: consider carrying GA pseudonymous client/session identifiers privately only after a separate privacy/consent decision; never send PII to GA4.

### Server and delivery truth

- [ ] Replace timestamp/email pseudo-dedupe with `lead:submission:${submission_id}` idempotency.
- [ ] Return the same receipt on replay.
- [ ] Store an append-only lead record and per-leg receipts for KV, Mailchimp, notification, and CRM relay.
- [ ] Track attempts, last error, retry/dead-letter state, and final delivery status.
- [ ] Distinguish browser/API `accepted` from `all_downstreams_delivered`.

### CRM and booking

- [ ] Store `origin_source` independently from web acquisition and assist sources.
- [ ] Preserve human-reported referral detail without letting GA last-click overwrite it.
- [ ] Add a Zcal webhook/callback for booked, rescheduled, and cancelled events. Official capability is verified; authenticated account configuration remains unverified because trusted-browser access requires a new grant.
- [x] Verify observed Zcal reschedule lineage: three independent historical pairs retained the same event ID before and after rescheduling. Treat this as strong account-history evidence, not a universal schema guarantee.
- [ ] Persist stable booking ID and reschedule lineage in the proof loop after account webhook access is confirmed.
- [ ] Join booking to submission/lead receipt where possible; label email-based matching as CRM matching, not GA proof.

### GA reporting and tests

- [ ] Register low-cardinality event-scoped custom dimensions after the Analytics Admin API is available.
- [ ] Keep high-cardinality URLs and identifiers out of standard dimensions.
- [ ] Test homepage booking clicks, form lifecycle, accepted vs delivered states, idempotent replay, downstream retry, booking joins, reschedules, cancellations, and duplicate-deal prevention.
- [ ] Verify rendered events, network requests, durable records, CRM state, and failure behavior end to end.
- [ ] Push a dedicated branch and open a PR; do not merge or deploy without explicit authorization.

Acceptance:

- A test journey can be followed from first touch through resource delivery and booking with stable receipts.
- Replaying a submission or webhook creates no duplicate lead, relay, or opportunity.
- Each attribution statement carries its evidence class and confidence.

## Workstream 8 - Authority dashboard and operating cadence

- [x] Issue engineering verdicts for OneGlanse and SerpBear while preserving Josh's final product-choice gate; see `open-source-tool-verdicts.md`.
- [ ] Define one durable observation schema spanning prompt, engine, answer/result, cited source, entity, test conditions, and raw receipt.
- [ ] Keep Google rank, local result, AI mention, AI citation, site behavior, and CRM outcome as separate measures.
- [ ] Build weekly comparisons without overwriting prior runs.
- [ ] Add source/tool health indicators so silence cannot be mistaken for no visibility.
- [ ] Define the weekly operator checklist and monthly strategy review.
- [ ] Define alert thresholds for new citations, lost citations, material rank movement, crawl/indexing problems, and qualified conversions.

Acceptance:

- A weekly run can be executed by someone other than its author using the written procedure.
- Tool failure is distinguishable from a real zero result.

## Workstream 9 - Content decision gate

Do not begin bulk production until workstreams 3 through 7 have usable baselines.

- [x] Rank the first six content opportunities by buyer decision, prompt gap, Clearworks evidence advantage, and conversion relevance in `first-content-batch.md`.
- [x] Rank 18 SEO/SERP opportunities from current live results and public demand evidence in `clearworks-aec-seo-serp-demand-2026-09-25.md`.
- [x] Produce and independently review five private implementation briefs: AI operations and implementation, AEC Busywork Audit, project reporting automation, existing-resource upgrades, and the Modern AEC Firm canonical hub. Governing brief commit: `48b8ce37f127cef17572801b9d7e764492d72d06`.
- [ ] Prefer original evidence: AIA/TAP sessions, implementation work, audits, research, buyer questions, and explicit operating lessons.
- [ ] Choose one canonical page per buyer decision; avoid keyword-variant duplication.
- [ ] Create a source/evidence packet before each draft.
- [ ] Include direct answer, real AEC language, proof, limitations, authorship/review date, adjacent questions, and one matching CTA.
- [ ] Publish through reviewed branches only.
- [ ] Adapt each canonical item to Google Business Profile, LinkedIn, newsletter, and AIA surfaces without copy-pasting.
- [ ] Measure indexation, retrieval/citation, qualified engagement, assisted journeys, and booked conversations.

Acceptance:

- Each content brief exists because of a measured buyer question or evidence-backed authority opportunity.
- Each published page can be tied to one intended buyer decision and one observable outcome.

## Initial build order

1. Complete source audits and isolated boots for OneGlanse and SerpBear.
2. Freeze prompt methodology and the 25-prompt core.
3. Capture the pre-content baseline and returned-site corpus.
4. Implement and verify the analytics/CRM/booking repair on a dedicated site branch.
5. Select the authority-stack components from verified results.
6. Produce the gap-ranked content brief backlog.
7. Begin the publishing cadence only after the baseline is preserved.

## Current evidence

- Google states that standard SEO fundamentals remain applicable to AI Overviews and AI Mode, and that no special AI schema or machine-readable file is required.
- Google states that AI features may use query fan-out, so related subtopics and source coverage matter even when the literal prompt is unchanged.
- Google now exposes a dedicated Search Console Generative AI performance report for AI Overviews and AI Mode, globally available as of 2026-08-31. It reports impressions by page, country, device, and date and supports a UI export. The data is also included in the overall Web performance report. A supported API path for the dedicated view has not yet been verified.
- OpenAI states that OAI-SearchBot access is required for content to be discovered and cited in ChatGPT search, while GPTBot controls potential training access separately.
- The current Clearworks resource-page analytics emit useful events, but the complete journey is not deterministically joinable and the homepage/booking/dedupe paths remain incomplete.
- The accessible Google Ads-derived dataset reports meaningful broad US demand (`AI in construction` 1,900/month; `AI for architects` 720; `AI in architecture` 590; `AI tools for architects` 140), while most exact AEC consultant/audit/local/size phrases returned zero reported volume. Zero reported is not proof of zero searches.
- A generic web-search discovery tool returned Clearworks pages for `where should an architecture firm start with AI`, `which AI tools should an architecture firm standardize`, and `Modern AEC Firm Playbook`; AEC Hub pages were also returned for the first two. The provider and ordering are abstracted, so this is page-discovery evidence only—not Google/Bing rank, ordering, or coexistence proof. A user-run Google search on 2026-09-26 did not show Clearworks for the first query.
- Google blocked the isolated localized inspection, so local-pack visibility remains unknown pending Search Console/GBP or an authorized local-rank data source.

These facts support building the measurement and proof loop first. They do not prove that any specific content tactic will cause rankings or citations.
