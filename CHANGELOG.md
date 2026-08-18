# Changelog

All notable changes to this project are documented here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.2] — July 27, 2026

Published to npm as `@digestseo/mcp-geo`.

### Added

- **Hosted MCP tool metadata:** hosted tools use `visibility.*` namespaces and provide typed input/output schemas; the local stdio CLI retains flat tool names.
- **Dedicated Worker storage configuration:** Worker examples and migration documentation target the dedicated `mcp-geo-db` D1 database.
- **Marketplace metadata:** Cursor and Claude Code plugin manifests, along with refreshed MCP Registry, MCPB, Cline, and Smithery metadata for the DigestSEO-branded server and hosted endpoint.

### Changed

- Package, registry, MCPB, and Worker-reported metadata are synchronized on version `0.3.2` and the `@digestseo/mcp-geo` package identity.
- Production transitive dependencies are pinned to patched Hono, `fast-uri`, and `body-parser` versions.

## [0.3.0] — July 2026

A second distribution path: a local stdio CLI where users bring their own API keys, published to npm as `@digestseo/mcp-geo`, plus registry/marketplace metadata. The Cloudflare Workers path keeps every 0.2.1 behavior — the accuracy and security fixes now live in the runtime-agnostic core shared by both.

### Added

- **Local stdio CLI** (`npx -y @digestseo/mcp-geo`): the same MCP tools backed by a local SQLite database (`~/.digestseo/digestseo.sqlite`, override with `DIGESTSEO_DB_PATH`). Engines run inline and sequentially — no fan-out needed locally. All logging goes to stderr; stdout is the JSON-RPC channel.
- **Local brand-management tools** (CLI only): `track_brand` (creates a brand + generated prompt set; falls back to three starter prompts without `ANTHROPIC_API_KEY`; accepts the per-brand `aliases` and `exclude_terms` from 0.2.1), `list_brands` (brands with active prompt counts), `generate_prompts` (regenerate a brand's prompt set via Claude Haiku). On Workers deployments these operations remain behind the `X-Seed-Secret`-gated `/admin/*` routes; the Worker MCP surface still exposes exactly the original six tools.
- `src/core/` — runtime-agnostic core shared by the Worker and the CLI: engine callers, scoring, prompt generation, content-gap analysis, brand seeding, and `registerTools`/`registerLocalManagementTools`.
- `src/db/types.ts` (`Db` contract), `src/db/d1.ts` (D1 adapter), `src/db/sqlite.ts` (better-sqlite3 adapter with a `_migrations`-tracked migration runner). Both adapters carry the 0.2.1 brand columns (`aliases_json`, `exclude_terms_json`) and the partial-run-aware visibility-history query.
- Packaging/metadata: npm `bin` + `mcpName`, `server.json` for the official MCP registry (npm package + templated Worker remote in one manifest), `manifest.json` + `.mcpbignore` for the MCPB desktop extension, `Dockerfile`, `glama.json`, `llms-install.md`, README Quick Install section, CI + release-publish GitHub Actions workflows.
- Unit tests for the sqlite adapter and core seeding, alongside the 0.2.1 matching/citations/scoring suites (`npm run test:unit` runs all of them), and a stdio smoke test that drives the built CLI over JSON-RPC (`npm run test:stdio`).

### Fixed

- Fallback seed prompts no longer contain a literal `$CATEGORY` placeholder — it is substituted with the brand's category (or name) before insert. Affects the Worker's `/admin/seed` fallback path too.

### Changed

- `hashPrompt` keeps 0.2.1's `HASH_FIELD_SEP = '\x1f'` field separator (cache keys are unchanged from 0.2.1).
- npm manifest: `dependencies` now lists only what the published CLI actually needs at runtime (`@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`); Worker-only packages (`@cloudflare/workers-oauth-provider`, `agents`) are `devDependencies` — wrangler bundles them into the Worker regardless, and `npx @digestseo/mcp-geo` installs stay small. This supersedes 0.2.1's "manifest tells the truth" arrangement, which predated the npm package.

## [0.2.1] — June 2026

A security + accuracy pass ahead of wider distribution.

### Added

- Optional `CONNECT_SECRET` secret. When set, the browser step of the OAuth connect flow shows a one-field form and only completes when the secret matches. Without it the OSS build keeps its auto-completing single-dev-user flow — which means anyone who knows the worker URL can connect an MCP client and call `refresh_brand` (spending your engine API credits). Recommended for every deployment whose URL is shared anywhere.
- Per-brand `aliases` and `exclude_terms` (`migrations/0005_brand_alias_exclude.sql`, `Brand` in `src/db.ts`, `SeedBrandInput` in `src/seed.ts`). Aliases are extra terms that always count as a mention; exclude terms suppress the bare-word match on the brand name and domain root — so "Monday" the brand stops matching "monday" the weekday — while the full domain and aliases still count. `extractCitations` now matches through a `mentionsTermSet` term set; its exported signature is unchanged. Apply 0005 to add the `aliases_json` + `exclude_terms_json` columns; existing brands read as empty arrays and behave exactly as before.
- `SECURITY.md` — security model, trust boundaries, and private vulnerability reporting.
- GitHub Actions CI (`.github/workflows/ci.yml`): `tsc --noEmit` + unit tests on every push and PR.
- Unit test suite (`npm run test:unit`, Node test runner + tsx): `tests/matching.test.ts` covers brand/competitor mention matching (excluded bare words, full-domain matches that survive exclusion, root terms not matching inside a larger word); `tests/unit/citations.test.ts` and `tests/unit/scoring.test.ts` cover citation extraction (`extractCitations`, `hostMatchesDomain`) and score aggregation (`computeOverallScore`). These are the pure functions every score flows through; the smoke suite still covers the deployed Worker end-to-end.
- `migrations/README.md` — how to apply migrations and why files must never be renumbered.
- README: Claude Code connect instructions (`claude mcp add --transport http`), architecture diagram, security section.

### Fixed

- Word-boundary brand/competitor matching in `src/openai.ts`. `mentionsTerm` used `haystack.includes(root)`, a raw substring test: a brand whose domain root is a common word (`monday.com` → "monday", `notion.so` → "notion") false-positived on the everyday word, and any term matched inside a larger word ("motion" inside "promotional"). Matching now uses Unicode-aware boundary checks — `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])` — for the brand name and the domain root, while the full domain is still accepted as a high-confidence substring. The exported `extractCitations` signature is unchanged. (The homograph case — a bare root term that is itself a common word, e.g. "monday"/"notion" — is handled via the new per-brand `exclude_terms`.)
- **Linked-citation checks require the exact brand domain or a subdomain of it.** Previously a substring check meant `notacme.com` counted as a link to `acme.com`. Applies to `extractCitations`, the Perplexity and AI Overviews engine-citation merge, and `get_citations`' `cited_url` selection — all through the new shared `hostMatchesDomain` helper.
- NUL → unit-separator hash delimiter in `hashPrompt` (`src/openai.ts`). The field join used two literal NUL (`\x00`) bytes, which made git classify the whole file as binary and refuse to render its diffs. It now joins with the ASCII unit separator through a named `HASH_FIELD_SEP = '\x1f'` constant. Hash outputs change, so existing `shared_prompt_cache` rows simply miss and expire on their TTL — no cache clear or migration required.
- **`get_visibility_history` matches `check_visibility`'s stance on partial runs.** Runs interrupted mid-flight (stuck at `in_progress`) now count toward history via `COALESCE(completed_at, started_at)`, and runs with zero ok rows are excluded entirely instead of charting as a fake score of 0.

### Changed

- Docs (`README.md`, `SETUP.md`) now recommend **OpenAI + Anthropic (Claude)** as the starting engine pair instead of the Gemini free tier. The Gemini free tier 429s for brands with more than ~5 prompts (excluding it from scoring), and Google AI Overviews frequently returns `NO_AI_OVERVIEW` (scored as a zero), so the cheapest documented path produced misleading first-run data. Gemini and SerpAPI stay documented as opt-in engines; engine availability is unchanged and remains key-driven (`getAvailableEngines` untouched).
- `SEED_SECRET` and `CONNECT_SECRET` comparisons are constant-time.
- MCP server version string now tracks the package version (was stuck at an older value).
- Runtime dependencies (`@cloudflare/workers-oauth-provider`, `@modelcontextprotocol/sdk`, `agents`, `zod`) moved from `devDependencies` to `dependencies` — wrangler bundles either way, but the manifest now tells the truth.

## [0.2.0] — May 2026

A correctness + architecture pass driven by an end-to-end debugging session on the production fork. Every fix is described in terms of what the prior version got wrong.

### Added

- `migrations/0004_response_status.sql`: `status` (`ok` / `failed` / `skipped`) and `error_message` columns on `prompt_responses`, plus an index on `status`. Failed engine calls used to write `raw_response='ERROR: ...'` rows that downstream scoring treated as real zero-mention hits. They're now explicit `status='failed'` rows that aggregates exclude.
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
