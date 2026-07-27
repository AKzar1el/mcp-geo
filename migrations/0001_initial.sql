-- geo-mcp initial schema (Day 2).
-- Apply with:
--   npx wrangler d1 execute mcp-geo-db --local  --file=migrations/0001_initial.sql
--   npx wrangler d1 execute mcp-geo-db --remote --file=migrations/0001_initial.sql
--
-- D1 is SQLite. Integer timestamps are unix-ms. JSON fields are stored as TEXT.

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  plan                TEXT NOT NULL DEFAULT 'free',
  api_key_hash        TEXT,
  stripe_customer_id  TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS brands (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  domain              TEXT NOT NULL,
  name                TEXT NOT NULL,
  category            TEXT,
  competitors_json    TEXT,
  refresh_frequency   TEXT NOT NULL DEFAULT 'weekly',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brands_user ON brands(user_id);

CREATE TABLE IF NOT EXISTS prompts (
  id                  TEXT PRIMARY KEY,
  brand_id            TEXT NOT NULL REFERENCES brands(id),
  text                TEXT NOT NULL,
  intent_stage        TEXT,
  shape               TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompts_brand ON prompts(brand_id);

CREATE TABLE IF NOT EXISTS runs (
  id                  TEXT PRIMARY KEY,
  brand_id            TEXT NOT NULL REFERENCES brands(id),
  engine              TEXT NOT NULL,
  mode                TEXT NOT NULL,
  status              TEXT NOT NULL,
  batch_id            TEXT,
  prompts_total       INTEGER NOT NULL,
  prompts_completed   INTEGER NOT NULL DEFAULT 0,
  cost_eur_estimate   REAL,
  error               TEXT,
  started_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_brand_completed ON runs(brand_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS prompt_responses (
  id                          TEXT PRIMARY KEY,
  run_id                      TEXT NOT NULL REFERENCES runs(id),
  prompt_id                   TEXT NOT NULL REFERENCES prompts(id),
  engine                      TEXT NOT NULL,
  raw_response                TEXT NOT NULL,
  brand_mentioned             INTEGER NOT NULL DEFAULT 0,
  brand_cited_with_link       INTEGER NOT NULL DEFAULT 0,
  cited_urls_json             TEXT,
  competitors_mentioned_json  TEXT,
  captured_at                 INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_responses_run    ON prompt_responses(run_id);
CREATE INDEX IF NOT EXISTS idx_responses_prompt ON prompt_responses(prompt_id);

CREATE TABLE IF NOT EXISTS shared_prompt_cache (
  prompt_hash    TEXT NOT NULL,
  engine         TEXT NOT NULL,
  model          TEXT NOT NULL,
  raw_response   TEXT NOT NULL,
  captured_at    INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  PRIMARY KEY (prompt_hash, engine, model)
);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON shared_prompt_cache(expires_at);
