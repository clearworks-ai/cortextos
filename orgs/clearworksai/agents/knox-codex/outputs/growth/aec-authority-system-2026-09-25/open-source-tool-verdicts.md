# Open-source tool verdicts

Date: 2026-09-25
Scope: source-level audits and safe isolated validation; no production or provider-account connection.

## Engineering recommendation and pending decision gate

These are source-audit recommendations, not a final product decision by Josh. Before the authority stack is locked, present the concrete tradeoff between (a) a hardened disposable OneGlanse laboratory using dedicated noncritical accounts, (b) adapting its useful concepts into the Clearworks-owned API-first tracker, and (c) accepting the documented account, policy, and maintenance risks of operating it more broadly. SerpBear receives the same explicit stay/adapt/pilot decision rather than being silently dropped.

| Tool | Verdict | Appropriate use |
|---|---|---|
| OneGlanse | Do not deploy as-is; decision pending between hardened lab and concept adaptation | Reuse raw-response/citation lineage, provider-adapter, versioned-analysis, and dashboard ideas in an API-first tracker; a disposable-account laboratory remains an explicit option if Josh accepts the risks. |
| SerpBear | Conditional loopback pilot only; adapt selected concepts | Conventional Google organic position and read-only Search Console experiments only. It does not measure Maps, local packs, or AI-answer citations. |
| Surfer | Defer purchase | Reconsider when content planning/editing throughput becomes the bottleneck rather than measurement. |

## OneGlanse

Audited source: `aryamantodkar/oneglanse` commit `f40b3360b7afe491d9473ba2290e395d3f94954b`.

Validation:

- 442 source files pulled through `opensrc`;
- 332 code files graphified into 1,064 nodes and 2,216 edges;
- isolated dependency installation under `/tmp`;
- TypeScript checks passed for all nine workspaces;
- official lint failed with 18 errors and 140 warnings in the web package; broader scan stopped at 100 errors;
- zero test/spec files in the repository;
- no real provider credentials or accounts used;
- 1.9 GB temporary audit workspace removed after validation.

Blocking findings:

- Weekly scheduling is broken by the current PostgreSQL `format()` and `http_post` implementation; open issue #76 documents zero successful weekly executions.
- Open issues report current Claude and Perplexity capture failures.
- ChatGPT, Gemini, and Claude prompts can share conversation state; later observations are not independent. Gemini explicitly reuses a conversation.
- Provider cookies and localStorage are stored as plaintext browser-state JSON without application encryption or explicit restrictive file mode.
- A mock cookie was sufficient to report `connected: true`; connection state does not prove a valid authenticated provider session.
- Authentication state is instance-global rather than organization-scoped.
- The documented VPS helper uploads credential-equivalent browser state to a public port over plain HTTP.
- Self-hosted activity is sent to a hard-coded PostHog project without a code-level opt-out.
- Camoufox/proxy-driven consumer-UI automation conflicts with or creates high risk under OpenAI, Anthropic, Perplexity, and Google consumer-access restrictions.
- Provider selectors are hard-coded against volatile consumer interfaces.
- Analysis output is cast without strict schema validation and unsupported factual-risk judgments lack a canonical brand-fact set.
- PostgreSQL + ClickHouse + Redis is excessive for Clearworks' projected observation volume.

Adapt:

- a typed `runPrompt()` provider boundary using official APIs;
- org-scoped raw response, citation, model, prompt-version, locale, timestamp, and status records;
- versioned scoring rubric with canonical brand facts and strict validation;
- prompt history, citation-domain, competitor, failure, and change-over-time views;
- cortextOS scheduling and task/event receipts instead of pg_cron/BullMQ;
- PostgreSQL only at this scale.

Do not adapt:

- browser session capture;
- Camoufox/fingerprint masking;
- residential proxy rotation;
- consumer-UI automation;
- global auth directory;
- current scheduler;
- ClickHouse/Redis stack.

## SerpBear

Audited source: `towfiqi/serpbear` commit `a1328fb4142dde40e0011c646339c4d4dbabdaca`, v3.1.0-era source.

Validation:

- 133 code files graphified into 337 nodes and 824 edges;
- Node 22 production build passed;
- upstream Jest result: 24 of 39 tests passed, 15 failed;
- production dependency audit: 32 vulnerabilities - 3 critical, 17 high, 10 moderate, 2 low;
- no provider or Google credentials used;
- disposable audit directory removed.

Blocking findings:

- unauthenticated `POST /api/notify` can send SMTP mail;
- JWTs have no expiry, cookie lifetime calculation is incorrect, and the cookie is not secure;
- no login throttling and username/password error distinction;
- Google Ads OAuth callback lacks `state` validation;
- provider, SMTP, and GSC credentials share the JWT signing secret and are returned decrypted to settings calls;
- outdated Next.js dependency has critical advisories;
- no tenant or org isolation;
- Search Console data is limited to 1,000 rows with no pagination and can be served without freshness enforcement;
- GSC schedule activation depends on environment credentials and can disagree with UI configuration;
- local packs, Maps, AI Overviews, featured snippets, knowledge panels, and PAA are discarded even when the provider supplies them.

Appropriate private pilot:

- pin the audited image digest, never `latest`;
- loopback/private ingress only, behind TLS and an external access proxy;
- block SMTP and `/api/notify`;
- disposable volume and independent secrets;
- 4-10 real organic queries, one city, desktop/mobile;
- free SerpApi allowance if a provider account is authorized;
- compare stored positions with raw provider results;
- read-only Search Console only after service-account access is available;
- require security remediation, green tests, and raw geo/device validation before any broader use.

Adapt:

- small scraper-provider interface with explicit capability metadata;
- cost-control pagination modes;
- read-only GSC service-account pattern;
- normalize and paginate GSC data into the Clearworks store;
- schedule through cortextOS.

## Recommended Clearworks stack

1. First-party Google Search Console, including the new Generative AI performance report export.
2. Google Business Profile/local observations and actual customer actions.
3. Official OpenAI, Gemini, Perplexity, and available Anthropic search/grounding APIs for automated prompt observations.
4. Small bounded manual consumer-UI samples, explicitly separated from API results.
5. A Clearworks-owned org-scoped observation ledger with raw evidence and versioned scoring.
6. GA4, durable lead receipts, CRM provenance, and booking lifecycle for business outcomes.
7. A conventional SERP provider only if GSC and manual checks cannot answer the organic-rank question.

This stack is smaller, safer, and more auditable than deploying either audited dashboard wholesale.
