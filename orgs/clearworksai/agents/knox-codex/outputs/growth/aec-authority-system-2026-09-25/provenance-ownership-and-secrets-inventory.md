# AEC authority system provenance, ownership, and secrets inventory

Date: 2026-09-29
Scope: components and services actually used in the current evidence run; no secret values are recorded here.

## Source and service ledger

| Component | Version / immutable reference | License or service basis | How it was used | Current production state |
|---|---|---|---|---|
| OneGlanse | `aryamantodkar/oneglanse` at `f40b3360b7afe491d9473ba2290e395d3f94954b` | MIT, verified from the license at the audited commit | Complete source audit, graph, dependency install, TypeScript/static checks, and credential-free synthetic readiness checks | Not deployed; no provider account connected |
| SerpBear | `towfiqi/serpbear` at `a1328fb4142dde40e0011c646339c4d4dbabdaca` (v3.1.0-era source) | MIT, verified from the license at the audited commit | Complete source audit, graph, Node 22 build, upstream tests, and dependency audit | Not deployed; no provider, proxy, SMTP, or Google credential connected |
| Gemini grounded-baseline runner | This repository, PR #400 head `5dc91ce1e4bc1fd1101ca6f2095b320442924625`; runner `scripts/aec-authority/gemini_baseline.py` | Clearworks internal code; Google Gemini API service | Run `gemini-api-google-search-20260925-r1` with `gemini-2.5-flash` and `google_search`; 25 isolated prompt requests; redacted raw receipts retained | Research use only |
| Google Search Console | Existing URL-prefix property `https://clearworks.ai/` inspected 2026-09-26 | Google hosted service | Read first-party performance/indexing state and submit `/sitemap.xml`; readback was Success with 20 discovered pages | Live property; no ownership or permission change |
| Google Analytics 4 | Clearworks property / Measurement ID already deployed on the site | Google hosted service | Current-site event and journey audit; historical Justin session boundary; production fixes remain separately governed | Existing analytics live; broader proof-loop cutover not inferred |
| Zcal hosted service | Public invite/account capability reviewed; subscriber configuration still pending | Zcal hosted service | Source of `event.created`, `event.rescheduled`, and `event.cancelled` lifecycle events | Public capability verified; Josh's private subscriber remains unconfigured |
| Clearworks Astro site / Zcal receiver | Local repository `/Users/joshweiss/code/clearworks-sites/site`; reviewed source `8889f81cf2b8c29dc5f8b5f3fa9e885c6b9ae05a`; config successor `8175272e342e07e4d149cb1e48835ec254f501c3`; final release `30eebbc641a42e8ffcad2a8a3e80a35a3a65af76` | Clearworks internal site code; remote repository identity is not asserted because the local checkout has no configured remote | Implements signed `/api/webhooks/zcal`, transition ordering, conflict/replay handling, and D1 receipts | Released; no lead endpoint, lead worker/queue, or lead database behavior changed |
| Cloudflare Pages + D1 | Account `ce93b2622e1bbe58297726e4a780b4c8`; Pages project `clearworks-ai`; deployment `a8b36df3-ccb0-4b15-a795-95cfb8bc860b`; D1 `clearworks-zcal-events` / `a3aeaaf2-2990-4515-a27d-508049a0bffc` | Cloudflare hosted deployment and database services | Hosts the site endpoint and the dedicated Zcal lifecycle ledger | Live; synthetic create/replay/conflict/reschedule/cancel and remote D1 readback verified |
| SEOMonster | Public workflow inspected; package/version not yet pinned | Open-source candidate; license/version verification is a gate | Classified as a possible read-only Search Console/GA4/PageSpeed analysis helper | Not installed, authorized, or connected |
| OneGlanse / SerpBear container images | None | Not applicable | The audits used source checkouts and isolated local dependency installs | No image was pulled, pinned, retained, or deployed |

The detailed engineering findings and limits remain in `open-source-tool-verdicts.md`. The Gemini protocol and run conditions remain in `prompt-baseline-v1.md`, the run manifest, and the raw receipt folder. Search Console state remains in `search-console-access-baseline.md`.

## Operating ownership

| Responsibility | Accountable owner | Execution owner | Required proof / boundary |
|---|---|---|---|
| Search Console and GA4 property access | Josh Weiss | Knox performs authorized read-only measurement; site/analytics implementation uses its own reviewed branch | Property/account identity, date range, source export or screen readback, and no PII in GA4 |
| Weekly prompt and source measurement | Josh approves the frozen method and material changes | Knox runs the versioned prompt set and preserves raw receipts | Prompt-set version, provider/model, timestamp, locale/location state, raw answer/citations, tool-health state |
| Site publishing | Josh approves public copy and production release | Knox executed the current Zcal receiver release under `approval_1790437084_k0r60`; the execution owner for each future content/site branch must be named before release | Reviewed branch, rendered page, network/state verification, rollback path, and production readback |
| CRM source mapping and buyer-journey interpretation | Josh owns final commercial interpretation | Connect (`crm-codex`) reconciles CRM, form, email, calendar, and analytics evidence; implementation remains in its owning code lane | Origin source kept separate from web acquisition/assist; deterministic vs inferred joins labeled |
| Content claims and client evidence | Josh | Knox prepares the claim ledger and source packet | Permission, source class, date, scope, limitation, and public-language approval before publication |
| Open-source tool retention | Josh chooses lab, adaptation, or rejection | Knox performs source/security evaluation; engineering owner implements only after a separate authorized plan | Pinned source/image, license, credential scope, isolated test, security gate, and exit plan |
| Production secrets and provider connections | Josh | Knox owned the current Zcal deployment; every future system must name its own authorized deployment owner | Secret-manager receipt and least-privilege scope; never copied into research artifacts |

If a named implementation owner is absent for a future release, that release is blocked. “Knox researched it” is not production ownership.

## Secret and credential inventory

This inventory records only identifiers, storage class, purpose, and boundary. It intentionally contains no values, hashes of values, screenshots, cookies, browser storage, or copied authorization headers.

| Credential / auth surface | Storage class | Purpose | Current boundary |
|---|---|---|---|
| `GEMINI_API_KEY` | Clearworks org secret environment | Call Gemini GenerateContent for the grounded baseline | Read by the runner at execution; redacted from receipts and tests; no other credential accepted by the runner |
| Search Console / Google account session | Josh's trusted Chrome profile | Read the existing Search Console property and its reports | No session export, service-account creation, ownership change, or token copy |
| GA4 property access | Existing Google account/property configuration | Read analytics and configure approved events/dimensions when separately authorized | No PII in GA4; high-cardinality identifiers stay out of standard dimensions |
| Zcal webhook secret | Encrypted Cloudflare Pages secret `ZCAL_WEBHOOK_SECRET`; recovery copy in macOS Keychain service `ZCAL_WEBHOOK_SECRET`, account `clearworks-zcal-webhook` | Verify HMAC signatures for lifecycle events | Secret value never enters the evidence packet or Telegram; private subscriber binding and real test remain separate |
| Cloudflare / Wrangler deployment authentication | Host-authenticated Wrangler environment; the release receipt does not record the credential's value or storage implementation | Deploy the Pages project, bind `ZCAL_DB`, apply the D1 migration, and read back production state | Used only under approved release `approval_1790437084_k0r60`; no credential copied into this branch |
| Zcal private account session | Josh's trusted existing-profile Chrome session | Configure the subscriber, use Zcal's Test Endpoint action, and run the real lifecycle test | Not accessed by this run; blocked on human task `task_1790458200312_03073302`; no cookie/session export |
| Site deployment credentials | Existing site/hosting deployment controls | Publish reviewed site changes | Not used by this research branch; each production release requires its own approval and receipt |
| GitHub CLI OAuth credential | Host credential store | Push the task branch and update PR #400 | Never embed in remotes or artifacts; rotation is tracked in separate security task `task_1790480530426_85068794` |
| OneGlanse provider sessions | None supplied | Would authenticate consumer-provider browser sessions | Prohibited in the audited run; no cookies/localStorage captured or retained |
| SerpBear provider/GSC/SMTP credentials | None supplied | Would power rank updates, Search Console import, or notifications | Prohibited in the audited run; any future pilot requires independent disposable secrets and read-only Google scope |
| SEOMonster Google credentials | None supplied | Would permit Search Console/GA4/PageSpeed analysis | No connection until package/license audit and explicit least-privilege scope review |

## Change control

- Add a row before introducing a new repository, package, container image, hosted service, or credential class.
- Replace mutable version labels with immutable commits or image digests before any deployment.
- A research credential does not authorize a production connection.
- A successful login or API response does not prove measurement correctness; preserve raw receipts and downstream state.
- Owner changes, new scopes, and external publication require their own recorded decision.
