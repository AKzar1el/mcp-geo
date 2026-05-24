-- Day 3 adds engine-native citations. Today only Perplexity returns these
-- (its response has a top-level `citations` array of URLs). Day 4's
-- get_citations tool reads this column when present and falls back to the
-- extracted cited_urls otherwise.

ALTER TABLE prompt_responses ADD COLUMN engine_citations_json TEXT;
