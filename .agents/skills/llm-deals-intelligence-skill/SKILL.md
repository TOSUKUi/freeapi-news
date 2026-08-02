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
- The run manifest (the orchestrator passes its path) — your task assignment, provider, assigned model ids, and cached URLs.
- Operational state lives in SQLite (`state/collector.sqlite`); workers cannot read or write it directly. The deterministic pipeline reads it and hands you only what you need. **Never write state files** — you emit facts via `json_output` and the pipeline merges them.
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

If benchmark data is found, include it in the record's `benchmark_finds[]` with the score, the source URL, and (for text) a `body_excerpt` quoting the model, benchmark version, and score. The deterministic pipeline validates the evidence and persists accepted scores to SQLite; a proposal is not a fact until confirmed. If no data is found after checking all four sources, note `benchmark_source_checked` in `errors[]` so downstream phases know the search was performed.

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

Check the provider and discovery sources in the collector SQLite tables (`discovery_sources`, `search_terms`, `search_windows`), seeded by migration 0003 from the former `config/sources.yaml` and `config/search_queries.yaml` (spec 0004 AC-13). Use `npm run db:status` or the DB CLI to inspect them; the YAML files are gone.

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

#### "No free tier" is not a pricing-page conclusion

Never exclude a model with "no free tier" based on the pricing page alone. Free quotas can live outside the price list: data-sharing opt-ins, platform settings, help-center articles, launch campaigns. Before writing `No free tier` as an exclusion reason, you must also have checked the vendor's help center and any data-sharing / opt-in program pages, and the exclusion reason must state that you checked them.

#### Known conditional programs (verify current state each run)

- **OpenAI data-sharing complimentary tokens** (verified 2026-07-29 on https://help.openai.com/en/articles/10306912): eligible organizations that opt into data sharing get daily free tokens — `gpt-5.6-sol` in the 1M/day group (250K for usage tiers 1–2), `gpt-5.6-terra` and `gpt-5.6-luna` in the 10M/day group (2.5M for tiers 1–2), resetting 00:00 UTC, overage billed at normal rates. Eligibility varies per organization. Report as `F_CONDITIONAL` in `conditional_credits` with the data-use condition stated explicitly; re-check the help article each run for quota or model-list changes.

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

**Benchmark data lookup (mandatory before marking insufficient_benchmark_data):** Before concluding that a model has no benchmark data, check these sources in order: (1) HuggingFace model card, (2) vendor technical blog, (3) official X / social media posts (extract scores from benchmark images), (4) GitHub repository README or linked technical report, (5) third-party aggregators (lmmarketcap.com, openrouter.ai, awesomeagents.ai). Only mark `insufficient_benchmark_data` when all five categories have been checked and yielded no usable scores. The pipeline already attaches every score on record to the candidate view; only search for what is genuinely missing.

**Endpoint verification (mandatory, no exceptions):** Never write `base_url` or `model_id` from memory, training data, or a previous report. Every value must be copied from a page fetched during this run.

1. Read `build/provider-registry.json` first. If the provider is listed, use the registry's `base_url` verbatim and set `endpoint_source` to the registry's `docs_url` after fetching that docs page to confirm it is live and still states the same endpoint. If the fetched docs contradict the registry, emit a worker fact proposal with the fetched URL. The deterministic evidence audit stages a candidate registry change; workers never write the canonical registry directly.
2. If the provider is NOT listed, search and fetch the vendor's official API documentation and emit a provider candidate containing the documented base URL, model ID format, request example, and exact `added_from` URL. Deterministic evidence audit validates and stages the candidate registry entry. No worker directly edits `build/provider-registry.json`, and the offer cannot rank until the candidate is promoted.
3. A ranked offer without `endpoint_source`, with a `base_url` that contradicts the registry, from a provider missing from the registry, or with a citation that does not document its endpoint, fails `npm run validate` and aborts the batch. When in doubt about an endpoint, do not rank the offer.

OpenRouter-specific rule:

- **Use the API, not the web page.** `GET https://openrouter.ai/api/v1/models` returns every served model with `pricing`, `context_length`, `created`, and `top_provider` in one call. A `:free` variant is genuinely free and served only when its `id` is present in that catalog AND `pricing.prompt === "0"` and `pricing.completion === "0"`. The model page's "N providers" FAQ text refers to the **paid base model** (a shared component) and is NOT evidence that the `:free` variant is served — the `:free` page can render with an empty Activity chart and no Providers section while the FAQ still shows the base model's count. If the `:free` model_id is absent from the catalog, the variant has no provider and must be excluded. The deterministic catalog lane and lane reducer own this mechanically (catalog.js + lanes.js): a successful exhaustive catalog that omits an exact id moves it to `confirmed_removed`; a failed catalog never removes. Report validation does not re-fetch the catalog.

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

The deterministic reducer diffs the current run against the prior SQLite state and identifies newly added offers, changed prices, changed limits, changed provider count, changed end dates, ended offers, revived offers, and previously active offers that are now unavailable. Workers do not maintain this state — they only report current facts, and the pipeline computes the change records. The Editor writes the Japanese prose for those change records.

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
- Models under roughly 30B total parameters are local-run territory: a Q4 build fits in ≤24GB and anyone can run them at home, so a free API of one is not news. Do not rank them — unless the benchmarks prove the model is genuinely competitive (tier S/A): a small model that performs like a much larger one is worth featuring. Judge MoE models by TOTAL parameters, not active: active parameters only bound compute per token, but local inference must load every expert — a 118B/8B MoE needs ~60GB and is NOT easy local run territory, while a 26B/4B model loads in ~15GB and is. Borderline 30–35B totals may be featured.
- Every ranked offer must carry `total_parameters_b` and `active_parameters_b` (MoE; null active for dense) from the model card or official release material. If the vendor never publishes sizes (e.g. Google), set null and say so in `recent_activity` — but confirm the model is not a small model before ranking.
- Embedding, reranking, and single-purpose models do not belong in the main ranking.
- When a provider's free tier has multiple models, judge the tier by its best model, not its average.
- Ask: "Would a knowledgeable developer choose this over the best free alternative?" If no, exclude or demote.

### Individual model cards (routers included)

Emit each noteworthy free or ultra low cost model as its own offer card, including models accessed through routers like OpenRouter. Do not aggregate a router's free models into one card. For each router-hosted card set `delivery_type: "router"`, the router as `provider`, the router endpoint as `base_url`, the specific model's `model_id`/`benchmark`/`benchmarks`, and the deterministic price facts (spec 0004: one card per provider and exact model id; the catalog inventory list is gone). Put the router's per-model page (e.g. `https://openrouter.ai/{model_id}`) as `sources[0]` — the card's primary link must open the exact model's page, not a generic docs page. Only create cards for models that pass the quality gate.

### End dates

If an offer has a known end date, always set `end_at` and `end_timezone_known`. The page displays the deadline prominently. If the end date lacks a timezone, set `end_timezone_known: false`.

### Tier criteria (S/A)

Tier S/A certifies agentic coding competence and requires **Terminal-Bench 2.0 or 2.1 ≥ 50%** on record. The deterministic assembler derives tier from the verified benchmark rows in SQLite (≥65 S, 50–64.999 A) using the shared ranking policy (`build/ranking-policy.js`); the benchmark scout searches allowed official sources only for models with no accepted benchmark fact. Once a supplemental benchmark is accepted, the model is not searched again merely because Terminal-Bench is absent. A model scoring under 50%, or with no verified Terminal-Bench 2.0/2.1 score, is `benchmark_pending` and unranked (never a rankable tier B). The assembler, validator, and builder all enforce the same shared policy; workers never assign tier.

### Free allowance rank (display only)

A free API with a prototype-only quota is not the same offer as one that is usable at scale. Set `free_allowance_rank` from the documented limits (`free_limits`) for display context only. It never affects admission, tier, or ordering:

- `AMPLE`: effectively unrestricted, or large quotas (hundreds of requests/day, or millions of tokens/day)
- `NORMAL`: a usable everyday quota (roughly 20–100 requests/day)
- `TIGHT`: only a few requests per day
- `TINY`: prototype-only quotas (e.g. ≤10 requests/day, or small daily credit pools such as Workers AI's 10,000 neurons/day)

The rank must agree with the `free_limits` text. It is display context only and never affects ranking order.

### Sort order

Order is exactly: tier (S > A > B), access kind (FREE > ULTRA_LOW), score descending only within the same Terminal Bench version, then `price_verified_at` descending, then name ascending. Scores from different Terminal Bench versions are never compared. Free allowance is display only.

### Benchmark persistence (mandatory)

The SQLite `benchmarks` table is the persistent cache of verified scores across runs. Regeneration must never lose data:

- The assembler reads verified benchmark rows from SQLite; an offer with a score on record is never assembled with a null `benchmark.score`.
- Verified benchmark rows are immutable: a newly proposed score never replaces an existing verified row merely for being higher. A correction requires separately verified evidence naming the old value and reason.
- Workers report scores as proposals (`benchmark_finds[]`); the deterministic validator accepts them only when the fetched evidence confirms the model, benchmark version, and score, then persists them to SQLite.

The runtime order is deterministic: tier (S > A > B), access kind (FREE > ULTRA_LOW), score descending only within the same Terminal Bench version, then `price_verified_at` descending, then name ascending. Allowance, extra quota details, context, tooling, and other descriptive data are display only and never ranking inputs.

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

## Collection pipeline architecture

The daily collection (`.devops/db/collect.js`, driven by `npm run collect` / `full`) runs as a fail-safe pipeline. SQLite (`state/collector.sqlite`) is the sole operational state. Known offer verification and new discovery are separate lanes. Mechanical work (catalog fetch, liveness, tier, ranking, assembly) is deterministic code; LLM workers only extract facts, classify, scout benchmarks, and write Japanese prose. Workers emit facts via `json_output` and never write state files.

### Steps

```
1. Migrate + recover      apply migrations; recover any interrupted promotion
2. Pre run DB copy        copy the closed DB into the ignored run directory
3. Manifest + start run   build lane manifest from SQLite + registry
4. Catalog (deterministic)  providers with api_catalog_url fetched from their API
5. Lane workers (LLM)     known_refresh + discovery, parallel (GLOBAL_CONCURRENCY)
6. Lane reduction         liveness + enums + promotion gate (zero verified blocks)
7. Benchmark scout (LLM)  only models with no accepted benchmark fact; proposals validated
8. Candidate view         deterministic input for classifier + editor
9. Classifier + editor    final classification; Japanese prose only
10. Assembly              deterministic report.json from SQLite + prose
11. Validation + build    schema + live citation re-fetch; HTML + OG in candidate/
12. Promotion + deploy    phased manifest; canonical files change only after all
                          checks pass; push failure keeps validated_not_deployed
```

### Workers

1. `crawl-worker` (prompts/crawl-worker.md): per-provider facts. Handles known_refresh (re-verify known offers). Emits `crawl-facts.schema.json` facts.
2. `discovery-agent` (prompts/discovery-agent.md): finds new models and providers. Emits facts; failure never mutates known offers.
3. `benchmark-scout` (prompts/benchmark-scout.md): finds benchmark scores only for models with no accepted benchmark fact. Emits proposals (`benchmark-scout.schema.json`), confirmed by evidence before becoming facts.
4. `classifier-agent` (prompts/classifier-agent.md): final classification per candidate. Does NOT fetch.
5. `editor-agent` (prompts/editor-agent.md): writes Japanese prose only (`editorial.json`). Does NOT fetch, does NOT write data.

### Fail-safe guarantees

- Current tracked files change only after a candidate passes every check, via a phased promotion manifest with backups and hash verification.
- Workers never edit state; they emit facts only. SQLite is the sole operational state.
- A failed provider makes an offer stale, never confirmed_removed; a failed run leaves the previous report live.
- A benchmark proposal is not a fact; verified benchmark rows are immutable.
- A git push failure records validated_not_deployed and preserves the generation for retry.
- A concurrency lock prevents overlapping runs; run directories older than seven days are pruned.

### Run directory layout

```
state/crawl/<run_id>/
  manifest.json                 # lane task assignments
  artifacts/<task_id>.json      # worker + catalog outputs
  benchmarks/needs-*.json       # benchmark scout queue
  reduced/                      # lane coverage, candidate view, classifications
  candidate/                    # staged report.json, index.html, og-image.png, editorial.json
  backup/                       # pre run DB copy + canonical file backups
  promotion-manifest.json       # phased promotion state
```

Each artifact has `status: "complete" | "partial" | "failed"`. Even on failure, a worker must produce its artifact (the orchestrator writes a failure artifact when a worker yields nothing).

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
- workers only propose provider facts; deterministic fetched evidence audit stages a candidate registry entry with `added_from` provenance, and no worker writes the canonical registry directly
- every ranked offer has a `free_allowance_rank` consistent with its documented limits
- no ranked offer's free quota is app/web-chat-only while its API is paid, and no `effective_price_per_million` was zeroed from an app quota
- no ranked offer is a sub-30B total-parameter model (local-run territory), and parameter sizes were researched from model cards
- every tier S/A offer has a verified Terminal-Bench 2.0 or 2.1 score of 50%+ in SQLite
- no ranked offer lost a benchmark score that exists in the SQLite `benchmarks` table, and every accepted new score was persisted there
- no `base_url` or `model_id` was written from memory
- the final report is in Japanese
