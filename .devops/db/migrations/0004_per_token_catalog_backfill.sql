-- 0004 per-token catalog price normalization backfill.
-- Spec 0004 AC-3, AC-4. OpenRouter's official catalog (GET /api/v1/models)
-- quotes prompt/completion prices PER TOKEN, but migration 0003 stored those
-- values as if they were USD PER MILLION tokens. A paid per-token model like
-- kimi-k3 (0.000003 / 0.000015 per token) was therefore recorded as 0.000003
-- / 0.000015 USD per million and incorrectly admitted as ULTRA_LOW. Its true
-- price is 3 / 15 USD per million, which is above the ULTRA_LOW ceiling.
--
-- This migration backfills rows whose prices came from the OpenRouter
-- catalog path (source_kind = 'catalog', provider_key = 'openrouter') and
-- whose source_unit was misrecorded as per_million_tokens while the source
-- values are per-token magnitudes:
--   * source_amount_input/output := the prior per-token raw values
--   * normal/effective *_price_usd := raw × 1,000,000
--   * source_unit := 'per_token'
--
-- Rows that are genuinely free (both prices are positive zero) are unchanged
-- except for source_unit: zero × 1,000,000 is zero, so the normalized price
-- stays zero. Setting source_unit to per_token keeps the source evidence
-- honest for every OpenRouter catalog row.
--
-- Rows already written as per_million_tokens from a non OpenRouter path
-- (source_unit = 'per_million_tokens' and source_kind != 'catalog' or
-- provider != openrouter) are left untouched: they already follow the
-- per-million contract.
--
-- The backfill also strips any typed price keys that leaked into
-- facts_json (AC-3) using JSON1.

-- 1. Normalize the OpenRouter catalog rows (transaction covers the whole
--    migration via the runner).
UPDATE offers
SET
  source_amount_input = effective_input_price_usd,
  source_amount_output = effective_output_price_usd,
  normal_input_price_usd = normal_input_price_usd * 1000000,
  normal_output_price_usd = normal_output_price_usd * 1000000,
  effective_input_price_usd = effective_input_price_usd * 1000000,
  effective_output_price_usd = effective_output_price_usd * 1000000,
  source_unit = 'per_token'
WHERE provider_key = 'openrouter'
  AND source_kind = 'catalog'
  AND source_unit = 'per_million_tokens';

-- 2. Purge typed price keys from facts_json (AC-3). Runs on every row so
--    bootstrap / import / finalize leftovers are cleaned too. JSON1 is
--    built into Node's SQLite.
UPDATE offers
SET facts_json = (
  SELECT json_group_object(key, value)
  FROM json_each(facts_json)
  WHERE key NOT IN (
    'pricing', 'prompt_price', 'completion_price', 'pricing_hash', 'is_free',
    'normal_price_per_million', 'effective_price_per_million',
    'normal_input_price_usd', 'normal_output_price_usd',
    'normal_cache_read_price_usd', 'normal_cache_write_price_usd',
    'effective_input_price_usd', 'effective_output_price_usd',
    'effective_cache_read_price_usd', 'effective_cache_write_price_usd',
    'source_amount_input', 'source_amount_output',
    'source_currency', 'source_unit',
    'conversion_rate', 'conversion_source', 'conversion_confirmed_at',
    'price_source_url', 'price_verified_at',
    'discount_start_at', 'discount_end_at'
  )
)
WHERE facts_json IS NOT NULL AND facts_json != '';
