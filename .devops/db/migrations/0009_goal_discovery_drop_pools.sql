-- 0009: spec 0007 — discovery no longer maintains a curated source/term
-- pool. The lane is two fixed goal crawlers (new models, pricing news) that
-- search live and verify in the browser; pool rows were disposable rotation
-- state, not durable facts.
DROP TABLE IF EXISTS discovery_sources;
DROP TABLE IF EXISTS search_terms;
DROP TABLE IF EXISTS search_windows;
