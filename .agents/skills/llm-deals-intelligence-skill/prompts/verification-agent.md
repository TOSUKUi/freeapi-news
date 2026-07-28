# Verification Agent

Verify every candidate against official pricing, model, provider, status, terms, and privacy pages.

A zero-dollar model page is not enough. Confirm provider count, endpoint, model ID, base URL, region, recent activity or uptime, rate limits, billing conditions, end date, and data-use policy when possible.

## Endpoint verification (mandatory, no exceptions)

Never report a `base_url` or `model_id` from memory or training data. Every value must come from a page fetched during this run, and every ranked offer needs an `endpoint_source` citation:

1. Read `build/provider-registry.json` (project root) first. For listed providers, use the registry `base_url` verbatim, fetch its `docs_url` to confirm the endpoint is unchanged, and set `endpoint_source` to that docs URL. If the fetched docs contradict the registry, update the registry entry from the docs and record the new docs URL.
2. For providers NOT in the registry: fetch the official API docs (vendor domain only), copy the documented base URL and model ID format verbatim, add a new registry entry with `added_from` set to the exact docs URL you fetched, and set `endpoint_source` to the same URL. Only then may the offer be ranked. The validator re-fetches every citation and hard-fails when the page does not document the claimed base_url — an entry written from memory aborts the batch.
3. Suspect URLs (unofficial domains, native endpoints used as OpenAI-compatible ones, guessed hosts like `api.kimi.ai`) are verification failures, not findings. The validator hard-fails them.

OpenRouter rule: zero providers means unavailable and must be excluded from active ranking.

## Benchmark data lookup (mandatory before marking insufficient_benchmark_data)

Before concluding that a model has insufficient benchmark data, you MUST check these sources in order:

1. **HuggingFace model card** — `huggingface.co/{vendor}/{model-name}`. The README often contains a benchmark table. If the model card does not exist yet, proceed to step 2.
2. **Vendor technical blog** — search for the model name on the vendor's official blog (e.g. `inclusion-ai.org/blog/`, `blog.google/`, `openai.com/index/`). Release posts almost always include benchmark charts or tables.
3. **Official X / social media posts** — search for the model name on the vendor's official X account. Release-day posts frequently include benchmark comparison images. Extract scores from images when possible (OCR or visual reading).
4. **GitHub repository README** — e.g. `github.com/{vendor}/{model}`. May link to a technical report PDF or embed benchmark tables.
5. **Third-party aggregators** — lmmarketcap.com, openrouter.ai model pages, awesomeagents.ai, etc. as a fallback.

If benchmark data is found in any of these sources, extract the scores and attach them to the verification result as a `benchmarks` array (each entry: `{name, score}`). **Write or update the data in `state/benchmarks.json`** — merge by `canonical_name`, append new benchmark entries, never overwrite a score from a more authoritative source. Do NOT mark a model as `insufficient_benchmark_data` unless all five source categories have been checked and yielded no usable scores. **Also check `state/benchmarks.json`** — if benchmark data exists there from a previous run, use it instead of marking the model as insufficient.

Return suspicion score, information confidence, operational confidence, and concrete reasons.
