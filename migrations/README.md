# Migrations

Apply in filename order with:

```bash
npx wrangler d1 migrations apply mcp-geo-db --remote   # production
npx wrangler d1 migrations apply mcp-geo-db --local    # wrangler dev
```

Current set:

| File | What it does |
|---|---|
| `0001_initial.sql` | Base schema: users, brands, prompts, runs, prompt_responses, shared_prompt_cache. |
| `0002_fail_stuck_runs.sql` | One-time cleanup: marks pre-0.2.0 runs stuck at `in_progress` as failed. |
| `0003_perplexity_citations.sql` | Adds `engine_citations_json` (engine-native citation URLs). |
| `0004_response_status.sql` | Adds `status` (`ok`/`failed`/`skipped`) + `error_message` to prompt_responses. |
| `0005_brand_alias_exclude.sql` | Adds per-brand `aliases_json` + `exclude_terms_json` for mention matching. |

**Do not renumber or rename applied files.** Wrangler tracks applied migrations
by filename in the `d1_migrations` table; renaming a file makes existing
deployments think it was never applied and re-runs it. (If you deployed before
June 2026, your `d1_migrations` table may record the status-column migration
under its old name `0005_response_status.sql` — that's fine; just don't apply
`0004_response_status.sql` a second time. `ALTER TABLE ... ADD COLUMN` fails
loudly if the column already exists, so a double-apply is caught, not silent.)
