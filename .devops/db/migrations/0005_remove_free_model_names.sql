-- 0005 remove the retired router inventory from durable offer facts.
-- Idempotent cleanup for rows written before the inventory contract changed.
UPDATE offers
SET facts_json = (
  SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE json_group_object(key, value) END
  FROM json_each(facts_json)
  WHERE key != 'free_model_names'
)
WHERE facts_json IS NOT NULL
  AND facts_json != ''
  AND EXISTS (
    SELECT 1 FROM json_each(facts_json) WHERE key = 'free_model_names'
  );
