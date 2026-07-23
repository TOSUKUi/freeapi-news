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

## Required fields per offer (spec 0002)

Every offer you emit must carry two fields the page depends on. Set them at collection time; the builder never invents them.

- `last_verified` (RFC 3339 timestamp, required when `ranking_eligible` is `true`): the moment this offer's information was last reconfirmed by cited evidence. Set it to the latest `accessed_at` among the offer's own `sources` entries (the most recent source you actually checked for this offer). If you cannot confirm a date, leave the offer `ranking_eligible: false` rather than emitting a ranking-eligible offer without a verification date.
- `free_model_names` (string array, required and non-empty when `delivery_type` is `router`): for router offers (OpenRouter), every free model ID currently available, pulled from OpenRouter's authoritative model catalog (models whose effective input and output price are zero and that are available). Deduplicate by exact model ID and sort lexicographically. Emit the full list with no cap and no truncation. If the catalog could not be fetched, do not emit the router offer as ranking eligible; the schema rejects a router offer with an empty list.

Connection instructions are NOT a report field. Do not write setup text into the report; the builder derives per-agent snippets from its own versioned templates using `base_url`, `model_id`, and the provider.
