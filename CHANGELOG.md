# Changelog

All notable changes to this project are documented here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.1] — June 2026

A security + accuracy pass ahead of wider distribution.

### Added

- Optional `CONNECT_SECRET` secret. When set, the browser step of the OAuth connect flow shows a one-field form and only completes when the secret matches. Without it the OSS build keeps its auto-completing single-dev-user flow — which means anyone who knows the worker URL can connect an MCP client and call `refresh_brand` (spending your engine API credits). Recommended for every deployment whose URL is shared anywhere.
- `SECURITY.md` — security model, trust boundaries, and private vulnerability reporting.
- GitHub Actions CI (`.github/workflows/ci.yml`): `tsc --noEmit` + unit tests on every push and PR.
- Unit test suite (`npm run test:unit`, Node test runner + tsx) covering citation extraction (`extractCitations`, `hostMatchesDomain`) and score aggregation (`computeOverallScore`). These are the pure functions every score flows through; the smoke suite still covers the deployed Worker end-to-end.
- `migrations/README.md` documenting the intentional 0004 numbering gap and why files must never be renumbered.
- README: Claude Code connect instructions (`claude mcp add --transport http`), architecture diagram, security section, hero report image.

### Changed

- **Brand/competitor mention matching now requires word boundaries.** `acme` no longer matches inside "acmeshop" or "macme". Scores may shift slightly downward for brands whose root term is a common substring — the new number is the honest one.
- **Linked-citation checks require the exact brand domain or a subdomain of it.** Previously a substring check meant `notacme.com` counted as a link to `acme.com`. Applies to `extractCitations`, the Perplexity and AI Overviews engine-citation merge, and `get_citations`' `cited_url` selection.
- **`get_visibility_history` matches `check_visibility`'s stance on partial runs.** Runs interrupted mid-flight (stuck at `in_progress`) now count toward history via `COALESCE(completed_at, started_at)`, and runs with zero ok rows are excluded entirely instead of charting as a fake score of 0.
- `SEED_SECRET` and `CONNECT_SECRET` comparisons are constant-time.
- MCP server version string now tracks the package version (was stuck at 0.1.0).
- Runtime dependencies (`@cloudflare/workers-oauth-provider`, `@modelcontextprotocol/sdk`, `agents`, `zod`) moved from `devDependencies` to `dependencies` — wrangler bundles either way, but the manifest now tells the truth.

## [0.2.0] — May 2026

A correctness + architecture pass driven by an end-to-end debugging session on the production fork. Every fix is described in terms of what the prior version got wrong.

### Added

- `migrations/0005_response_status.sql`: `status` (`ok` / `failed` / `skipped`) and `error_message` columns on `prompt_responses`, plus an index on `status`. Failed engine calls used to write `raw_response='ERROR: ...'` rows that downstream scoring treated as real zero-mention hits. They're now explicit `status='failed'` rows that aggregates exclude.
- `POST /admin/run-engine` — single-engine handler. `/admin/run-live` self-fetches into it once per engine so each engine runs in its own worker invocation with its own free-plan 50-subrequest budget. Idempotent on `(run_id, engine)`.
- `POST /admin/cleanup-failed-runs` — one-shot deletion of legacy polluted rows that were written before the status column existed. Idempotent, optional `brand_id` filter.
- `bulkCacheGet` helper in `src/db.ts` — one D1 read for N prompt hashes instead of N separate reads.
- `persistEngineRun` helper in `src/db.ts` — one batched D1 write at the end of an engine run instead of per-prompt inserts + cache puts + per-chunk run updates.
- `EnginePromptResult` interface — engines collect their per-prompt results in memory and flush in one batch.
- `runEngineInProcess` in `src/engines.ts` — the in-process dispatcher used by `/admin/run-engine`.
- `Fetcher` service binding (`env.SELF`) in `Env` and `EnginesEnv`, plus `"services"` block in `wrangler.example.jsonc`. The per-engine fan-out goes through `env.SELF.fetch()` because a public-URL fetch back to your own `workers.dev` hostname trips Cloudflare's "Worker called itself" guard (error 1042) and never lands.
- `SELF_URL` env var in `wrangler.example.jsonc` — the cron path needs to know the worker's canonical URL since it has no inbound request to derive an origin from.

### Changed

- Each engine client (`src/openai.ts`, `anthropic.ts`, `perplexity.ts`, `gemini.ts`, `ai-overviews.ts`) now uses the bulk pattern: hash all prompts up front, `bulkCacheGet` once, run LLM fetches in CONCURRENCY=5 chunks, collect `EnginePromptResult[]`, flush via `persistEngineRun`. Per-invocation subrequest count drops from ~89 to ~26.
- `getLatestCompletedRun` anchors on `EXISTS(prompt_responses with status='ok')` instead of `runs.status='completed'`. Partially-finished runs still surface their data instead of silently disappearing from MCP tool output.
- `check_visibility`, `compare_competitors`, and `get_content_gaps` use `run.completed_at ?? run.started_at` so they accept in-progress runs.
- `get_visibility_history` and `get_citations` SQL queries filter `pr.status = 'ok'` in the join/where clause so failed/skipped rows can't pollute aggregates.
- `/admin/run-engine` `INSERT OR IGNORE`s its runs row before calling the engine — D1's cross-region replication may not have caught up with `/admin/run-live`'s `INSERT INTO runs` by the time the self-fetch lands, and a missing parent row would crash the engine's batched insert with `FOREIGN KEY constraint failed`.
- `runEngines` accepts an optional `request` argument and falls back to `new URL(request.url).origin` when `SELF_URL` isn't set, so HTTP-triggered code paths work even without the env var.

### Fixed

- Subrequest-cap row loss: pre-fix, every engine deterministically wrote 10 rows out of 20 because chunk 3 hit the 50-subrequest cap. Now writes complete in one batch under the cap.
- Silent row drops from failed Gemini / AI Overviews calls: pre-fix the catch block's `insertPromptResponse(failed)` was itself a D1 subrequest that could fail, leaving zero rows for the prompt. The bulk batch holds failure results in memory and writes them in the same batch as the successes.
- Visibility tools dropping engines whose runs got stuck at `in_progress`: relaxed `getLatestCompletedRun` surfaces them.

## [0.1.1] — May 2026

- Removed `scripts/setup.sh` — the bash script wasn't reliable across platforms (Git Bash on Windows in particular couldn't pipe stdin to wrangler's interactive prompts). Replaced with a fully manual, copy-pasteable walkthrough in SETUP.md as the canonical install path.
- SETUP.md is now self-contained — every wrangler command, every interactive prompt response, and the most common failure modes are documented inline.

## [0.1.0] — May 2026

Initial public release.

### Added

- 5-engine support: ChatGPT (`gpt-4o-mini`), Claude (`claude-haiku-4-5`), Perplexity (`sonar`), Gemini (`gemini-2.5-flash-lite`), and Google AI Overviews (via SerpAPI).
- 6 MCP tools: `check_visibility`, `get_visibility_history`, `compare_competitors`, `get_citations`, `get_content_gaps`, `refresh_brand`.
- Opt-in engine availability — engines are enabled only when their API key is present.
- D1-backed storage: brands, prompts, runs, prompt_responses, shared_prompt_cache.
- Cloudflare Cron Trigger (every 6h) that respects per-brand `refresh_frequency` (daily/weekly).
- Admin routes: `/admin/seed`, `/admin/run-live`, `/admin/run-batch-submit`, `/admin/run-batch-collect`, `/admin/generate-prompts`, `/admin/trigger-cron-test`. All gated by `SEED_SECRET`.
- Smoke test suite at `tests/smoke.test.mjs` (Node built-in test runner; no external deps).
- Claude-Haiku-powered prompt generator and content-gap analyzer with deterministic fallback recommendations.
