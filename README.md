# DigestSEO — AI Visibility MCP for SEO & GEO

Track how your brand is cited by ChatGPT, Claude, Perplexity, Gemini, and Google AI Overviews — through MCP. Self-hosted on Cloudflare Workers, works with Claude Desktop, Claude.ai web (custom connectors), Cursor, Codex CLI, and any MCP-compatible client.

> **Prefer zero setup?** Try the hosted version at [digestseo.com](https://digestseo.com) — managed Cloudflare infra, no API keys to manage, multi-brand, scheduled refresh, web UI. Waitlist now open. [Join waitlist →](https://digestseo.com) <!-- TODO: replace with real waitlist URL once landing page is live -->

---

## What's New

### [0.2.0] — May 2026

- **Per-engine HTTP fan-out.** `/admin/run-live` now creates one runs row per engine and self-fetches `/admin/run-engine` once per engine. Each engine runs in its own worker invocation with its own free-plan 50-subrequest budget — a single-invocation fan-out used to burst past the cap mid-run and lose half the rows.
- **Service binding (`env.SELF`)** dispatches the per-engine fan-out through Cloudflare's internal fabric instead of a public-URL fetch, dodging the "Worker called itself" guard (error 1042) that silently blocks the latter.
- **Status column** on `prompt_responses` (`ok` / `failed` / `skipped`) plus `error_message`. Failed engine calls used to write `raw_response='ERROR: ...'` rows that downstream scoring treated as real zero-mention hits; now they're explicitly excluded.
- **FK-resistant inserts.** `/admin/run-engine` `INSERT OR IGNORE`s its runs row before persisting — D1 is eventually consistent across edge regions, and the upstream `INSERT INTO runs` from `/admin/run-live` doesn't always replicate before the downstream engine call lands. The IGNORE makes the FK happy either way.
- **Bulk D1 batch.** Each engine collects its 20 prompt results in memory then flushes inserts + cache writes + the final `UPDATE runs SET status='completed'` in a single `D1.batch()` call. Drops the per-invocation subrequest count from ~89 to ~26.
- **Relaxed visibility queries.** `getLatestCompletedRun` anchors on `EXISTS(ok rows)` instead of `status='completed'`, so partially-finished runs still surface their data in MCP tool output instead of silently disappearing.
- **New admin route `POST /admin/cleanup-failed-runs`** for one-shot deletion of legacy polluted rows after migrating to 0005.

### [0.1.1] — May 2026

- Manual install is now the canonical path. The unreliable bash setup script was removed; SETUP.md is self-contained and copy-pasteable, with every interactive wrangler prompt documented inline.

### [0.1.0] — May 2026

- Initial public release.
- 5-engine support: ChatGPT (`gpt-4o-mini`), Claude (`claude-haiku-4-5`), Perplexity (`sonar`), Gemini (`gemini-2.5-flash-lite`), and Google AI Overviews (via SerpAPI).
- 6 MCP tools: `check_visibility`, `get_visibility_history`, `compare_competitors`, `get_citations`, `get_content_gaps`, `refresh_brand`.
- Engines are opt-in based on which API keys you provide — set only the credentials you have, the rest skip gracefully.
- Cloudflare Cron Trigger that auto-refreshes tracked brands every 6h, respecting per-brand `refresh_frequency` (daily/weekly).
- D1-backed storage for brands, prompts, runs, citations, and a shared prompt cache.

---

## What Can This Do?

- **See which AI tools cite your brand and which don't** — get a per-engine breakdown of who's citing you for buyer-intent queries.
- **Track AI visibility weekly, automatically** — the built-in Cron Trigger re-runs scans on the cadence you configure per brand.
- **Compare your AI visibility to competitors** — share-of-voice percentages, prompts you win, prompts they win.
- **Find content gaps** — Claude-Haiku-synthesized recommendations grounded in your actual losing prompts.
- **Use it inside Claude.ai conversations** — add the deployed Worker URL as a custom MCP connector and ask in natural language.
- **Self-hosted on your own Cloudflare account** — your API keys, your data, your cost ceiling. The free Workers + D1 tiers cover a single brand with daily refreshes.

---

## Available Tools

| Tool | What it does | What you provide |
|---|---|---|
| `check_visibility` | Latest AI visibility snapshot across all configured engines for a tracked brand, with per-engine scores, winning prompts, and losing prompts. | `brand_id`, optional `engines[]` filter |
| `get_visibility_history` | Time-series history of overall and per-engine visibility, bucketed daily or weekly. | `brand_id`, optional `days` (default 30), optional `granularity` (`daily`/`weekly`) |
| `compare_competitors` | Share-of-voice comparison against competitor domains, with prompts you win and prompts they win. | `brand_id`, optional `competitor_domains[]`, optional `days` |
| `get_citations` | The actual citation events — prompt, engine, response excerpt, citation type, brand URL when present. | `brand_id`, optional `days`, optional `engine` filter |
| `get_content_gaps` | Prioritized Claude-Haiku-generated content recommendations targeting your losing prompts. | `brand_id`, optional `max_recommendations` (1-10) |
| `refresh_brand` | Manually trigger a fresh scan across every engine whose API key is set. | `brand_id`, optional `engines[]` filter |

---

## Getting Started

### Step 1 — Get API keys

Engines are opt-in. Pick the ones you want; the rest skip silently.

- **OpenAI** — ChatGPT engine. ~€0.0004 per prompt with `gpt-4o-mini`. Batch path roughly halves that. [platform.openai.com](https://platform.openai.com/api-keys)
- **Anthropic** — Claude engine, plus prompt generation and content-gap analysis (both call Claude Haiku). ~€0.0002 per prompt. Free trial credits are usually enough to evaluate. [console.anthropic.com](https://console.anthropic.com/)
- **Google AI Studio (Gemini)** — Gemini engine. ~€0.0001 per prompt. Free tier covers ~1500 requests/day — enough for a single brand on a daily cadence. [aistudio.google.com](https://aistudio.google.com/app/apikey)
- **Perplexity** — Perplexity Sonar engine. ~€0.005-0.008 per prompt. Paid only. [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api)
- **SerpAPI** — Google AI Overviews engine. ~€0.005 (free tier) / ~€0.0015 (volume) per prompt. Free tier covers ~100 calls/month — enough for development. [serpapi.com/dashboard](https://serpapi.com/dashboard)

Solo evaluation runs comfortably under €1/month on Gemini + OpenAI alone.

### Step 2 — Deploy to your Cloudflare account

The deploy is 6 commands and takes about 5 minutes. See [SETUP.md](./SETUP.md) for the full walkthrough with explanations and troubleshooting, or follow the quick version below.

```bash
# 1. Install deps
npm install

# 2. Log in to Cloudflare
npx wrangler login

# 3. Copy the config template
cp wrangler.example.jsonc wrangler.jsonc

# 4. Create KV namespaces + D1 database, paste each printed id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create RATE_LIMIT
npx wrangler d1 create digestseo-db

# 5. Set the required secret + at least one engine API key
npx wrangler secret put SEED_SECRET
npx wrangler secret put GEMINI_API_KEY   # free tier — easiest engine to start with

# 6. Apply migrations and deploy
npx wrangler d1 migrations apply digestseo-db --remote
npx wrangler deploy
```

After deploy, wrangler prints your Worker URL. Save it.

### Step 3 — Connect to your MCP client

After `wrangler deploy` finishes, you get a URL like
`https://digestseo-mcp.YOUR-SUBDOMAIN.workers.dev`.

#### Claude.ai (web)

Settings → Connectors → Add custom connector. Paste:

```
https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/mcp
```

Complete the OAuth handshake. The connector turns green when ready.

#### Claude Desktop

Edit your Claude Desktop config:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```jsonc
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/mcp"
      ]
    }
  }
}
```

Restart Claude Desktop after editing.

#### Cursor

Edit `~/.cursor/mcp.json`:

```jsonc
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/mcp"
      ]
    }
  }
}
```

Restart Cursor.

#### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.digestseo]
command = "npx"
args = [
  "-y",
  "mcp-remote",
  "https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/mcp",
]
```

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | opt-in | unset | Enables the ChatGPT engine. Without it, ChatGPT is skipped. |
| `ANTHROPIC_API_KEY` | opt-in | unset | Enables the Claude engine *and* the Claude-Haiku-powered prompt generator + content-gap analyzer. |
| `GEMINI_API_KEY` | opt-in | unset | Enables the Gemini engine. Free tier covers solo use. |
| `PERPLEXITY_API_KEY` | opt-in | unset | Enables the Perplexity Sonar engine. Paid only. |
| `SERPAPI_API_KEY` | opt-in | unset | Enables the Google AI Overviews engine (via SerpAPI). |
| `SEED_SECRET` | **yes** | unset | Shared secret that gates every `/admin/*` route. Pick a high-entropy string. |
| `TURNSTILE_SITE_KEY` | no | unset | Reserved for forks that add a public `/check` form. Unused by the OSS build. |
| `TURNSTILE_SECRET_KEY` | no | unset | Same — reserved for forks. |

All values are set via `wrangler secret put VAR` in production or `.dev.vars` locally. None are stored in `wrangler.jsonc`.

---

## Sample Prompts

Once the connector is live in Claude.ai (or any MCP client), try:

| Tool | Example prompt |
|---|---|
| `check_visibility` | "How visible is brand_id `acme` on AI right now?" |
| `get_visibility_history` | "Show me the visibility trend for `acme` over the last 60 days, daily." |
| `compare_competitors` | "Compare `acme` against asana.com and monday.com over the last 14 days." |
| `get_citations` | "Show me real Perplexity citations for `acme` from the last week." |
| `get_content_gaps` | "What content should `acme` publish to close its visibility gap? Give me the top 5." |
| `refresh_brand` | "Refresh `acme` across every available engine right now." |
| `refresh_brand` | "Refresh `acme` but only for Gemini and Claude." |

---

## Hosted Version

If you'd rather not run your own Cloudflare account, manage API keys, or pay individual engine bills, the hosted version of DigestSEO runs the same MCP server on managed infrastructure with multi-brand support, scheduled refresh, a web UI, and consolidated billing. Waitlist now open at [digestseo.com](https://digestseo.com). <!-- TODO: replace placeholder with real waitlist URL -->

---

## Troubleshooting

- **Worker deploys but tools return empty data** — at least one engine API key is missing. Check `wrangler secret list` and add the keys you intend to use. Engines without keys are silently skipped, which can leave `check_visibility` with no data.
- **`no engines available` error in logs** — no engine API keys are set at all. Set at least one of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `SERPAPI_API_KEY`.
- **D1 migration fails** — make sure you've run `npx wrangler d1 migrations apply digestseo-db --remote` (and also `--local` for `wrangler dev`). For ad-hoc fixes, `npx wrangler d1 execute digestseo-db --remote --file=migrations/0001_initial.sql`.
- **Custom MCP connector in Claude.ai not connecting** — the URL must end in `/mcp`. The OAuth handshake auto-completes in the OSS build (single dev user). If it loops, clear the connector and re-add it. Double-check the Worker is publicly reachable (`curl https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/healthz` should return `ok`).
- **Cron not firing** — check the Cloudflare dashboard at **Workers & Pages → digestseo-mcp → Settings → Triggers**. The "Cron Triggers" section should list `0 */6 * * *`. If it's missing, run `npx wrangler deploy` again — the trigger is registered on deploy. The handler also only dispatches engines for brands whose `refresh_frequency` cadence has elapsed, so a freshly-seeded brand might not fire on the next 6h boundary.
- **`401 unauthorized` from `/admin/*`** — `X-Seed-Secret` header is missing or doesn't match the deployed `SEED_SECRET`. Re-run `npx wrangler secret put SEED_SECRET` and update your `.env.test`.
- **Worker returns 404 on self-fetch / error code 1042** — the `services` binding in `wrangler.jsonc` is missing or the `service` name doesn't match the worker's `name` field. `/admin/run-live` self-fetches `/admin/run-engine` via `env.SELF` (a Cloudflare service binding) precisely because a public-URL fetch back to your own `workers.dev` hostname is blocked by Cloudflare's "Worker called itself" guard. Confirm the `wrangler.jsonc` you deployed contains `"services": [{ "binding": "SELF", "service": "<your-worker-name>" }]` with the same name you set in the top-level `"name"` field. After fixing, `npx wrangler deploy` and re-run.
- **Gemini rate limit (HTTP 429) on every prompt** — the Gemini free tier caps `gemini-2.5-flash-lite` at single-digit requests per minute and a low daily total. For brands with more than ~5 prompts you'll see `status='failed'` rows with 429 error messages, which excludes Gemini from scoring. Workarounds: upgrade to paid Gemini, switch the `MODEL` constant in `src/gemini.ts` to a different model with a higher quota, or invoke `/admin/run-engine` for one engine at a time so the per-minute window has time to refill between batches.
- **`FOREIGN KEY constraint failed` in wrangler tail during `/admin/run-engine`** — D1's cross-region replication hasn't caught up with the `INSERT INTO runs` that `/admin/run-live` just performed. The handler `INSERT OR IGNORE`s the runs row locally to dodge this, so you should not see this on the 0.2.0+ build; if you do, confirm you've deployed the latest `src/index.ts` (`grep -n "INSERT OR IGNORE INTO runs" src/index.ts` should match).

---

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the short version.

---

## License

[MIT](./LICENSE).

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for the full version history.

### [0.2.0] — May 2026

- Per-engine HTTP fan-out via `env.SELF` service binding (one worker invocation per engine, dodges Cloudflare's 1042 self-call guard).
- `status` + `error_message` columns on `prompt_responses` — failed engine calls are now explicit rows, no more `ERROR:` strings in `raw_response`.
- `INSERT OR IGNORE` on the runs row inside `/admin/run-engine` (handles D1 cross-region replication lag without dropping prompt_responses to FK violations).
- Bulk D1 batch in each engine's `runLive` (~26 subrequests/invocation instead of ~89; full 20-prompt runs now fit under the free-plan cap).
- `getLatestCompletedRun` anchored on `EXISTS(ok rows)`; partially-finished runs still show their data.
- New `POST /admin/cleanup-failed-runs` admin route.

### [0.1.1] — May 2026

- Removed the unreliable bash setup script. Manual install via SETUP.md is now the canonical path.

### [0.1.0] — May 2026

- Initial public release.
- 5-engine support: ChatGPT, Claude, Perplexity, Gemini, Google AI Overviews.
- 6 MCP tools.
- Engines opt-in based on which API keys you provide.
- Cloudflare Cron Trigger for auto-refresh.
