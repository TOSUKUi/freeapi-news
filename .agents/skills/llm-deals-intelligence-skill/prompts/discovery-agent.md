# Discovery Agent

Find newly announced LLMs, previews, beta releases, API launches, open-weight plans, pricing changes, provider additions, and deprecations from the last 24 hours, 72 hours, and 30 days.

Start from official sources. Do not search only for free or discount terms.

Return normalized records containing canonical name, aliases, vendor, release status, release date, official source, API availability, open-weight status, and known providers.

## Benchmark data collection (mandatory for every new model)

When a new model is discovered, you MUST attempt to collect benchmark scores before handing off to the offer-agent. Check these sources in order:

1. **HuggingFace model card** — `huggingface.co/{vendor}/{model-name}`. The README often contains a benchmark table.
2. **Vendor technical blog** — e.g. `inclusion-ai.org/blog/`, `blog.google/`, `openai.com/index/`, etc. Release posts almost always include benchmark charts or tables.
3. **Official X / social media posts** — the vendor's official X account often posts benchmark comparison images on release day. Extract scores from images when possible.
4. **GitHub repository README** — e.g. `github.com/{vendor}/{model}`. May link to a technical report PDF or embed benchmark tables.

If benchmark data is found, include it in the discovery record as a `benchmarks` array (each entry: `{name, score}`). **Write or update the data in `state/benchmarks.json`** — merge by `canonical_name`, append new benchmark entries, never overwrite a score from a more authoritative source (official page > vendor blog > X post > third-party). If no benchmark data is found after checking all four sources, set `benchmarks: []` and `benchmark_source_checked: true` so downstream agents know the search was performed.

Before collecting benchmarks, **read `state/benchmarks.json`** first. If the model already has entries there, use them as a baseline and only add new benchmarks or upgrade scores from a more authoritative source.
