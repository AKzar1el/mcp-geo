-- Per-brand alias and exclusion terms for mention matching.
--
--   aliases_json       — JSON array of extra terms that always count as a
--                        brand mention (e.g. former names, product lines).
--   exclude_terms_json — JSON array of terms that suppress the bare-word
--                        match for the brand name / domain root, so a brand
--                        whose name is an everyday word ("Monday") stops
--                        matching that word ("monday" the weekday). The full
--                        domain and explicit aliases still count.
--
-- Both default to NULL, which the loader (rowToBrand) reads as an empty
-- array — existing brands behave exactly as before until terms are set.
--
-- Apply with:
--   npx wrangler d1 execute mcp-geo-db --local  --file=migrations/0005_brand_alias_exclude.sql
--   npx wrangler d1 execute mcp-geo-db --remote --file=migrations/0005_brand_alias_exclude.sql

ALTER TABLE brands ADD COLUMN aliases_json TEXT;
ALTER TABLE brands ADD COLUMN exclude_terms_json TEXT;
