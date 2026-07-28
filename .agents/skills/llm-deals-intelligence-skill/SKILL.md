---
name: llm-deals-intelligence-skill
description: "Discovers newly announced LLMs and services, then searches, verifies, and ranks current offers that make high-performance or frontier-class models cheaper to use: free APIs, permanent free tiers, limited-time free access, launch credits, discounts, off-peak pricing, and conditional credits. Produces a daily Japanese report with citations, risk scores, and usage examples. Use when tracking free or discounted LLM access."
allowed-tools: "Bash, Read, Grep, Glob, Write, Edit, Agent"
---

# LLM Deals Intelligence Skill

## Purpose

Discover, verify, rank, and report current offers that make high-performance or frontier-class LLMs materially cheaper to use, including:

- truly free APIs
- permanent free tiers
- limited-time free access
- launch or beta credits
- 50%–90%+ discounts
- off-peak or night-time pricing
- top-up bonuses
- startup, student, research, and accelerator credits

The skill must find new models first, then investigate whether those models have free or discounted access. It must not begin only with searches for “free” or “discount.”

## Output language

Japanese.

## Recommended schedule

Run once daily at 11:00 Asia/Tokyo.

## Required capabilities

The agent should have access to:

1. General web search with recency filters.
2. Browser/page retrieval for official pricing, model, event, changelog, status, terms, and privacy pages.
3. GitHub search covering repositories, Issues, Discussions, Releases, commits, and pull requests.
4. Reddit search covering posts and comments.
5. Optional HTTP/API checks for public model catalogs and unauthenticated status endpoints.
6. Persistent state from the previous run.

Do not require user credentials. Never request session cookies, browser tokens, third-party API keys, or other secrets to verify a promotion.

## Inputs

- Current date and time.
- User timezone, default `Asia/Tokyo`.
- `config/sources.yaml`.
- `config/search_queries.yaml`.
- Previous state in `state/known_offers.json`, if available.
- Benchmark cache in `state/benchmarks.json`, if available.
- Provider endpoint registry at `build/provider-registry.json` (project root). Read it before writing any `base_url` or `model_id`. It is the single source of truth shared with the validator and the site build.

## Core workflow

### Phase 0 — Discover newly announced models and services

Search the last 24 hours, 72 hours, and 30 days for newly announced models, previews, betas, open-weight plans, API launches, pricing changes, provider additions, and deprecations.

Search official sources before community sources. Check:

- official blogs
- official X or equivalent public announcement feeds
- event pages
- pricing pages
- model catalogs
- changelogs
- deprecation pages
- GitHub Releases and pull requests
- top-page banners

Do not trust a static model list as the sole source of truth.

For every newly found model or service, create a normalized discovery record:

- canonical model name
- aliases
- vendor
- release status
- release date
- official source
- API availability
- open-weight status
- known providers

**Benchmark data collection (mandatory):** For every newly discovered model, attempt to collect benchmark scores before proceeding to Phase 1. Check these sources in order:

1. HuggingFace model card (`huggingface.co/{vendor}/{model-name}`) — README often contains a benchmark table.
2. Vendor technical blog — release posts almost always include benchmark charts or tables.
3. Official X / social media posts — release-day posts frequently include benchmark comparison images; extract scores from images.
4. GitHub repository README — may link to a technical report PDF or embed benchmark tables.

If benchmark data is found, include it in the discovery record and **write/update it in `state/benchmarks.json`** (merge by `canonical_name`; append new benchmark entries, never overwrite existing scores from a more authoritative source). If no data is found after checking all four sources, set `benchmark_source_checked: true` so downstream phases know the search was performed.

Before starting benchmark collection, **read `state/benchmarks.json`** first. If the model already has benchmark entries there, use them as a baseline and only add new benchmarks or upgrade scores from a more authoritative source (official page > vendor blog > X post > third-party).

### Phase 1 — Search each discovered model for offers

For every discovered model and every high-priority existing model, search for:

- free API
- free tier
- free credits
- launch credits
- promotion
- limited time
- beta access
- sponsored inference
- no credit card
- coupon or promo code
- balance or top-up bonus
- 10x usage
- 50%, 70%, 80%, 90%, 95%, 98% off
- off-peak or night-time pricing
- zero-dollar per-million-token pricing
- data-sharing or training opt-in quotas: free tokens granted in exchange for allowing prompts/outputs to be used for training or product improvement

Run searches in English, Japanese, and Chinese where relevant.

### Phase 2 — Search known providers and aggregators

Check the provider and discovery sources in `config/sources.yaml`.

For routers and marketplaces, inspect:

- model catalog
- provider list
- active endpoint/provider count
- pricing
- recent activity or uptime
- status page
- campaign banners
- terms and privacy policy

Some vendors grant free token quotas conditional on data sharing (training opt-in) rather than money. These are real offers but conditional: check the vendor's pricing, platform settings, and terms pages for opt-in quotas, record the exact quota per model, and treat the data-use consent as the price. See the verification leads below for current rumors to check.

For coding products, distinguish:

- public API access
- product-internal access only
- subscription credit multiplier
- third-party client access
- terms-of-service restrictions

#### Verification leads (unverified — check before reporting)

- OpenAI may grant free API token quotas in exchange for data-sharing consent (community claim: GPT-5.6 Luna and Terra around 10M free tokens, Sol around 1M). This is an unverified lead, not a fact: verify the exact quotas, models, and conditions on OpenAI's official pricing / platform document pages before reporting anything. If confirmed, report it as an `F_CONDITIONAL` offer in `conditional_credits` with the data-use condition stated explicitly.

### Phase 3 — Community early-warning scan

Search Reddit, GitHub, Hacker News, Product Hunt, public Discord announcements, technical blogs, and newsletters.

Community reports are discovery evidence, not final proof. Verify with one or more of:

1. official announcement
2. official pricing or model page
3. live provider or endpoint listing
4. multiple recent user reports
5. billing dashboard screenshots or reproducible request metadata from a trustworthy source

### Phase 4 — Verify that the offer is actually usable

A model page or `$0` label alone is insufficient.

For each candidate, verify as many of the following as possible:

- provider name
- active endpoint
- recent activity or uptime
- supported region
- model ID
- base URL
- official request example
- provider count
- rate limits
- end date and timezone
- billing behavior

**Benchmark data lookup (mandatory before marking insufficient_benchmark_data):** Before concluding that a model has no benchmark data, check these sources in order: (1) HuggingFace model card, (2) vendor technical blog, (3) official X / social media posts (extract scores from benchmark images), (4) GitHub repository README or linked technical report, (5) third-party aggregators (lmmarketcap.com, openrouter.ai, awesomeagents.ai). Only mark `insufficient_benchmark_data` when all five categories have been checked and yielded no usable scores. **Also check `state/benchmarks.json`** — if benchmark data exists there from a previous run, use it instead of marking the model as insufficient.

**Endpoint verification (mandatory, no exceptions):** Never write `base_url` or `model_id` from memory, training data, or a previous report. Every value must be copied from a page fetched during this run.

1. Read `build/provider-registry.json` first. If the provider is listed, use the registry's `base_url` verbatim and set `endpoint_source` to the registry's `docs_url` after fetching that docs page to confirm it is live and still states the same endpoint. If the fetched docs contradict the registry, update the registry entry from the docs in the same run and record the new docs URL — the fetched page is the authority, the registry is the cache.
2. If the provider is NOT listed, grow the registry: search the provider's official API documentation (vendor's official domain only), fetch the page, and copy the documented base URL, model ID format, and an official request example verbatim. Then add a new entry to `build/provider-registry.json` (`key`, `label`, `match`, `base_url`, `base_url_pattern`, `env`, `openai`, `docs_url`, `added_at`, `added_from`) where `added_from` is the exact docs URL you fetched, and set the offer's `endpoint_source` to the same URL. Only after the entry exists may the offer be ranked. Never add an entry from memory: the validator re-fetches every `endpoint_source` page and hard-fails when the page does not document the claimed `base_url`, so an entry you did not look up will abort the batch.
3. A ranked offer without `endpoint_source`, with a `base_url` that contradicts the registry, from a provider missing from the registry, or with a citation that does not document its endpoint, fails `npm run validate` and aborts the batch. When in doubt about an endpoint, do not rank the offer.

OpenRouter-specific rule:

- If the Providers page has zero providers, classify as unavailable and exclude from the active ranking.

If live operation cannot be verified, mark:

`掲載あり・稼働未確認`

and do not include the offer in the active ranking.

### Phase 5 — Normalize price and conditions

Normalize pricing to USD per one million tokens for:

- input
- output
- cache read
- cache write, if applicable

For subscription or credit-multiplier offers, show:

- nominal plan price
- included credits or calls
- multiplier
- effective discount
- whether the estimate is exact or inferred

Do not mix product-internal credits with public API token pricing.

Normalize opaque quota units into money readers understand. When a free tier is denominated in vendor units (neurons, credits, compute units, CU, etc.), append the USD equivalent computed from the provider's published unit price, e.g. `10,000 neurons/day free ≈ $0.11/day (about $3.30/month equivalent; $0.011/1,000 neurons)`. Fetch the unit price from the provider's pricing page in the same run — never convert from memory.

`effective_price_per_million` is what a reader pays for **API calls**. It may be zero only when API requests are genuinely billed at zero (free API tier or 100%-off campaign on the API). Never zero out a paid API price because a consumer app, web chat, or playground is free. If the pricing page says the API costs money, `effective_price_per_million` says the same money.

### Free app access is NOT a free API (zero tolerance)

This site ranks free or discounted **API** access. A free consumer app, web chat, or playground quota does not make the API free. If the provider's pricing page or docs show a paid API price, the offer is NOT rankable — no matter how generous the app quota is and no matter how high the model scores. Set `ranking_eligible: false`, classify at most `G_FREE_LIKE`, and exclude with a reason that states the actual API price.

Failing to do this is the single most damaging mistake this skill can make: it puts a paid product at the top of a free ranking and destroys the site's credibility. When the `free_limits` text contains the word "app" next to "free", stop and verify on the pricing page whether the **API itself** is free before ranking.

### Phase 6 — Classify the offer

Use one primary classification:

- `A_TRUE_FREE`: no payment method or deposit required; API use costs zero
- `B_PERMANENT_FREE_TIER`: ongoing free quota with rate or daily limits
- `C_LIMITED_FREE`: limited-time free campaign
- `D_TRIAL_CREDIT`: registration or trial credits
- `E_DISCOUNT`: major discount, off-peak price, or top-up bonus
- `F_CONDITIONAL`: startup, student, researcher, region, invite, KYC, accelerator, or data-sharing / training opt-in condition
- `G_FREE_LIKE`: minimum deposit, mandatory card, auto-renewal, referral requirement, UI-only access, tiny trial, non-refundable balance, or similar caveat

`G_FREE_LIKE` must never appear in the free ranking. It may appear under discounts or cautions.

### Phase 7 — Score risk and confidence

#### Suspicion score

- `0`: official or major vendor; legal entity, pricing, terms, and data policy are clear
- `1`: established third party with clear billing and conditions
- `2`: new or small provider; some limits, operations, retention, or SLA details are unclear
- `3`: unusually cheap; prepaid or non-refundable; unclear model source; weak documentation; billing or outage complaints
- `4`: anonymous operation; unofficial reverse proxy; shared account; crypto-only payment; requires depositing another provider's key
- `5`: phishing, malware, session-cookie requests, credential theft, or explicit terms circumvention

Score 5 candidates are excluded and only mentioned as warnings without direct links.

#### Information confidence

- `HIGH`: official source plus active endpoint/provider evidence
- `MEDIUM`: official promotion exists but limits or live operation are incomplete
- `LOW`: community-only or unverified claim

#### Operational confidence

- `HIGH`: active provider plus recent successful activity/uptime
- `MEDIUM`: model and endpoint exist but recent successful traffic is not confirmed
- `LOW`: listing only, stale reports, or no provider information

### Phase 8 — Compare with previous state

Compare current findings with `state/known_offers.json` and identify:

- newly added offers
- changed prices
- changed limits
- changed provider count
- changed end dates
- ended offers
- revived offers
- previously active offers that are now unavailable

Update state only after the report is complete.

### Phase 9 — Produce the daily report

Use this order:

1. New models, previews, and services from the last 24–72 hours, even if no promotion exists.
2. Changes since the previous report.
3. Ranked, operationally verified offers worth using now.
4. Conditional startup, student, research, accelerator, or data-sharing opt-in credits.
5. Caution-worthy offers with suspicion score and concrete reasons.
6. Ended, false, free-like, or providerless offers and exclusion reasons.
7. Newly discovered providers or information sources and whether they should be added to the seed list.
8. Minimal usage example for top offers: base URL, model ID, and a safe curl or environment-variable example.

Every nontrivial claim must cite a source. Label Reddit and GitHub findings as community reports.

If no meaningful new information is found, say so. Never pad the report with stale or weakly related offers.

## Ranking rules

Rank only candidates with `operational_confidence` of `HIGH` or `MEDIUM`.

### Quality gate — do not rank models that are not worth using

A free API is only valuable if the model itself is worth using. Do not rank offers whose best available model is clearly outdated or outperformed by freely available alternatives. Concretely:

- If a frontier-class or near-frontier model is available for free elsewhere, do not rank a free tier whose best model is a generation or more behind (e.g. Llama 3.3 70B when Nemotron 3 Ultra 550B is free).
- Small models (roughly under 30B dense or under 10B active parameters) are local-run territory; they are not worth featuring as API offers unless they are the best available option for a specific use case (e.g. a specialized coding model).
- Embedding, reranking, and single-purpose models do not belong in the main ranking.
- When a provider's free tier has multiple models, judge the tier by its best model, not its average.
- Ask: "Would a knowledgeable developer choose this over the best free alternative?" If no, exclude or demote.

### Individual model cards (routers included)

Emit each noteworthy free model as its own offer card, including models accessed through routers like OpenRouter. Do not aggregate a router's free models into one card. For each router-hosted card set `delivery_type: "router"`, the router as `provider`, the router endpoint as `base_url`, the specific model's `model_id`/`benchmark`/`benchmarks`, and `free_model_names: [model_id]`. Only create cards for models that pass the quality gate.

### End dates

If an offer has a known end date, always set `end_at` and `end_timezone_known`. The page displays the deadline prominently. If the end date lacks a timezone, set `end_timezone_known: false`.

### Free allowance rank (mandatory for ranked offers)

A free API with a prototype-only quota is not the same offer as one that is usable at scale. Set `free_allowance_rank` from the documented limits (`free_limits`):

- `AMPLE`: effectively unrestricted, or large quotas (hundreds of requests/day, or millions of tokens/day)
- `NORMAL`: a usable everyday quota (roughly 20–100 requests/day)
- `TIGHT`: only a few requests per day
- `TINY`: prototype-only quotas (e.g. ≤10 requests/day, or small daily credit pools such as Workers AI's 10,000 neurons/day)

The rank must agree with the `free_limits` text — never label a quota AMPLE or NORMAL when the documented limits show it is tiny. The ranking sorts by allowance after tier and score, so tiny quotas sink below equally performant offers that are actually usable.

### Sort order

Primary: performance tier (S > A > B), then benchmark score descending.
Secondary: free allowance (`AMPLE` > `NORMAL` > `TIGHT` > `TINY`).
Tertiary: freshness (`last_verified` descending).
Quaternary: name ascending.

Performance is the primary axis. A high-score model verified yesterday outranks a low-score model verified today. Within equal performance, a generous free tier outranks a tiny one.

### Benchmark persistence (mandatory)

`state/benchmarks.json` is the persistent cache of verified scores across runs. Regeneration must never lose data:

- Before assigning benchmarks, read `state/benchmarks.json`. If the model has scores there, the report's `benchmark.score` must not be null — merge from state (upgrading only from a more authoritative source).
- Every new or improved score collected during a run must be written to `state/benchmarks.json` in the same run (merge by `canonical_name`, include the model's `model_ids`).
- The validator hard-fails both a regression (state has scores, report says null) and a score that was not persisted to state.

Recommended ranking formula:

```text
value_score =
  0.30 * performance_score +
  0.25 * discount_score +
  0.15 * operational_confidence_score +
  0.10 * context_and_tooling_score +
  0.10 * access_ease_score +
  0.10 * duration_score -
  risk_penalty
```

Where:

- `performance_score`: frontier, near-frontier, or task-specialized quality
- `discount_score`: effective savings versus normal price
- `operational_confidence_score`: verified provider and recent activity
- `context_and_tooling_score`: context length, tool calling, structured output, multimodal support
- `access_ease_score`: no card, no deposit, simple signup, public API
- `duration_score`: remaining campaign duration and stability
- `risk_penalty`: derived from suspicion score and data-use concerns

Do not rank a dead endpoint above an active but slightly weaker model.

## Data safety rules

For every free or heavily discounted provider, explicitly check whether prompts or outputs may be logged or used for training.

When a free quota is conditional on data sharing, that trade-off IS the price. Set `training_use` to state it (e.g. `あり — 無料枠の条件 (学習利用への同意)`), put the exact quota per model in `free_limits`, list the consent in `registration_conditions`, classify `F_CONDITIONAL`, and place the offer in `conditional_credits` — never in the true-free ranking. Readers must be able to see what they are paying with.

Warn users not to submit:

- API keys
- passwords
- session cookies
- customer data
- personal data
- confidential source code
- unreleased product information

Do not perform destructive or billable verification calls without explicit permission.

## Failure handling

- If an official page is inaccessible, use cached search snippets only as provisional evidence and mark confidence lower.
- If sources conflict, show both claims and explain which source is more authoritative.
- If the end date lacks a timezone, state that explicitly.
- If a provider requires login to view limits, mark those limits as unverified.
- If an offer is discovered but cannot be verified operationally, exclude it from ranking.
- If the same model appears under multiple providers, compare each provider separately.

## Subagent decomposition

Use four specialized subagents where supported:

1. `discovery-agent`: finds new models and new providers.
2. `offer-agent`: searches promotions, credits, and pricing for each discovered model.
3. `verification-agent`: checks provider activity, limits, terms, privacy, and billing conditions.
4. `editor-agent`: deduplicates, scores, compares with previous state, and writes the Japanese report.

The editor must reject findings that do not include enough evidence.

## Acceptance criteria

A run is successful only when:

- new-model discovery happened before offer search
- official sources were checked for top-ranked offers
- operational status was verified or explicitly marked unverified
- zero-provider listings were excluded
- free-like offers were separated from real free offers
- risk and confidence were assigned with reasons
- changes from the previous run were identified
- top claims include citations
- every ranked offer's provider exists in `build/provider-registry.json` and its `base_url` matches the registry pattern
- every ranked offer has an `endpoint_source` URL fetched during this run, and the fetched page documents the claimed `base_url` (the validator re-checks this online)
- providers missing from the registry were researched from official docs and added to the registry (with `added_from` provenance) before ranking
- every ranked offer has a `free_allowance_rank` consistent with its documented limits
- no ranked offer's free quota is app/web-chat-only while its API is paid, and no `effective_price_per_million` was zeroed from an app quota
- no ranked offer lost a benchmark score that exists in `state/benchmarks.json`, and every new score was persisted there
- no `base_url` or `model_id` was written from memory
- the final report is in Japanese
