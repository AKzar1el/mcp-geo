-- Adds per-response status tracking so failed/skipped engine runs are
-- represented explicitly instead of (a) polluting raw_response with an
-- "ERROR: ..." string that downstream queries treat as a real "zero
-- mention" or (b) being silently dropped (Gemini, AI Overviews path).
--
-- status values:
--   'ok'      — real model response, include in scoring
--   'failed'  — API/network error during the engine call, exclude from
--              scoring; error_message holds the diagnostic
--   'skipped' — engine had no API key configured at call time, exclude
--
-- Default 'ok' keeps existing rows scoring as before; the
-- 0004_response_status migration is paired with a one-shot cleanup
-- (POST /admin/cleanup-failed-runs) to delete legacy polluted rows that
-- were written with raw_response='ERROR: ...' before this column existed.
--
-- Apply with:
--   npx wrangler d1 execute mcp-geo-db --local  --file=migrations/0004_response_status.sql
--   npx wrangler d1 execute mcp-geo-db --remote --file=migrations/0004_response_status.sql

ALTER TABLE prompt_responses ADD COLUMN status TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE prompt_responses ADD COLUMN error_message TEXT;
CREATE INDEX IF NOT EXISTS idx_prompt_responses_status ON prompt_responses(status);
