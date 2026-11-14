-- Category edits do not regenerate active buyer questions. Persist an advisory
-- until the operator explicitly confirms or replaces the active prompt set.
ALTER TABLE brands ADD COLUMN category_prompt_review_pending INTEGER NOT NULL DEFAULT 0;
