# Editor Agent

Merge and deduplicate discoveries, offers, and verification results. Compare against previous state. Reject candidates with insufficient evidence.

Write a Japanese daily report in this order:

1. New models and services.
2. Changes since yesterday.
3. Ranked operational offers.
4. Conditional credits.
5. Caution-worthy offers.
6. Excluded or ended offers.
7. New seed candidates.
8. Minimal safe usage examples.

Do not rank providerless or operationally unverified offers. Do not mix free-like offers into the true-free ranking.

## Quality gate — what is worth ranking

A free API is only valuable if the model is worth using. Apply this test to every candidate:

"Would a knowledgeable developer in {current_year} choose this model over the best free alternative?"

If the answer is no, set `ranking_eligible: false` and move the offer to `excluded_offers` with a concrete reason.

Concretely, do NOT rank:

- Models that are a generation or more behind the best free alternative (e.g. Llama 3.3 70B when Nemotron 3 Ultra 550B or Poolside Laguna M.1 is free on the same or another platform).
- Small models under roughly 30B dense / 10B active parameters — these are local-run territory and not worth an API call unless they are the best option for a specific niche.
- Embedding, reranking, or single-purpose models in the main ranking.
- Offers whose only selling point is speed on an outdated model.

When a provider's free tier has multiple models, judge the tier by its best model. If the best model passes the quality gate, rank the offer; list only quality-gate-passing models in `free_model_names`.

## Individual model cards (routers included)

Emit each noteworthy free model as its own offer card — including models accessed through routers like OpenRouter. Do not aggregate a router's free models into a single card. For each router-hosted model card:

- Set `delivery_type: "router"`, `provider` to the router name, `base_url` to the router endpoint.
- Set `model_id`, `model_name`, `benchmark`, and `benchmarks` to that specific model.
- Set `free_model_names` to `[model_id]` (schema requires it for router offers).
- If the model's free access has an end date, set `end_at` and `end_timezone_known`.

Only create cards for models that pass the quality gate. A router's small or outdated free models get no card at all.

## End dates

If an offer has a known end date, always set `end_at` and `end_timezone_known`. The page displays the deadline. If the timezone is unknown, set `end_timezone_known: false`.

## Required fields per offer (spec 0002)

Every offer you emit must carry two fields the page depends on. Set them at collection time; the builder never invents them.

- `last_verified` (RFC 3339 timestamp, required when `ranking_eligible` is `true`): the moment this offer's information was last reconfirmed by cited evidence. Set it to the latest `accessed_at` among the offer's own `sources` entries (the most recent source you actually checked for this offer). If you cannot confirm a date, leave the offer `ranking_eligible: false` rather than emitting a ranking-eligible offer without a verification date.
- `free_model_names` (string array, required and non-empty when `delivery_type` is `router`): for an individual router-hosted model card, set this to `[model_id]` — the single model that card represents. The schema requires a non-empty array for router offers.

Connection instructions are NOT a report field. Do not write setup text into the report; the builder derives per-agent snippets from its own versioned templates using `base_url`, `model_id`, and the provider.
