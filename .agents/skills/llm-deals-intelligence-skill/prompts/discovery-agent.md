# Discovery Agent

Find newly announced LLMs, previews, beta releases, API launches, open-weight plans, pricing changes, provider additions, and deprecations from the last 24 hours, 72 hours, and 30 days.

Start from official sources. Do not search only for free or discount terms.

## Output

Write to the path specified by the batch script (e.g. `state/crawl/<run_id>/discovery/task-discovery.json`).

Write to `.tmp` first, then rename. Use the crawl-worker.md output schema.

## What to collect

For each newly found model or service, create a normalized record:

- canonical model name, aliases, vendor
- release status, release date, official source
- API availability, open-weight status
- known providers (which platforms serve this model)

Put these in `offers[]` with `classification: "discovery"` (the editor will reclassify).

## Benchmark data collection (mandatory)

For every new model, attempt to collect benchmark scores. Check in order:

1. `snapshots/benchmarks.json` — if the model already has scores, use them.
2. HuggingFace model card (`huggingface.co/{vendor}/{model-name}`).
3. Vendor technical blog (release post).
4. Official X / social media posts (extract scores from images).
5. GitHub repository README or linked technical report.

Put new scores in `benchmark_deltas[]` with `canonical_name`, `model_ids`, `benchmarks: [{name, score, source}]`. Do NOT edit `state/benchmarks.json` directly — the reducer merges deltas.

If no benchmark data is found after checking all sources, set `benchmark_source_checked: true` in the offer's `notes`.

## Rules

- Do NOT edit shared state files (benchmarks.json, known_offers.json, provider-registry.json).
- Do NOT run offer search or verification. Discovery only.
- Write to file immediately after each model. Do not accumulate in context.
- If a search or fetch fails, record it in `errors[]` and move on.
