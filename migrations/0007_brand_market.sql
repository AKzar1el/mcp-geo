-- Per-brand search market (mlw-geo, Day 21).
--
--   brands.market        — BCP 47 locale 'll-CC' (e.g. 'pl-PL'): hl, gl and
--                          the ChatGPT approximate user location.
--   brands.google_domain — Google domain sampled by AI Overviews.
--   runs.market          — market the run was scanned in; history reads
--                          only runs in the brand's current market.
--   runs.google_domain   — Google domain the run sampled, so evidence from
--                          an earlier market keeps its own label.
--
-- Every brand and run on this database so far was scanned with the Polish
-- quick patch (gl=pl, hl=pl, google.pl), so the defaults backfill them.
--
-- Apply with:
--   npx wrangler d1 execute mlw-geo-db --local  --file=migrations/0007_brand_market.sql
--   npx wrangler d1 execute mlw-geo-db --remote --file=migrations/0007_brand_market.sql

ALTER TABLE brands ADD COLUMN market TEXT NOT NULL DEFAULT 'pl-PL';
ALTER TABLE brands ADD COLUMN google_domain TEXT NOT NULL DEFAULT 'google.pl';
ALTER TABLE runs ADD COLUMN market TEXT NOT NULL DEFAULT 'pl-PL';
ALTER TABLE runs ADD COLUMN google_domain TEXT NOT NULL DEFAULT 'google.pl';
CREATE INDEX IF NOT EXISTS idx_runs_brand_market ON runs(brand_id, market);
