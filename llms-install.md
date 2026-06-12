# llms-install.md — AI agent installation guide for digestseo-mcp

This file is written for AI agents (Cline, Claude Code, Cursor agents, etc.) installing **digestseo-mcp**, an MCP server that tracks how ChatGPT, Claude, Perplexity, Gemini, and Google AI Overviews cite a brand. Every command below is copy-pasteable as-is. Choose exactly one path:

- **Path A (recommended): run locally via npx** — no hosting, data stays in a local SQLite file, user brings their own AI provider API keys.
- **Path B: self-host on Cloudflare Workers** — remote MCP server with D1 storage, cron auto-refresh, and admin HTTP routes.

---

## Path A (recommended): local stdio server via npx

### Requirements

- Node.js >= 18 (`node --version`)
- At least one API key from the table below

### API keys

All five keys are **optional individually, but at least one must be set** or the server prints an error and exits with code 1. Engines whose key is absent are skipped gracefully.

| Environment variable | Provider / engine | Where to get the key | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | OpenAI — ChatGPT engine (`gpt-4o-mini`) | https://platform.openai.com/api-keys | ~€0.0004 per prompt |
| `ANTHROPIC_API_KEY` | Anthropic — Claude engine (`claude-haiku-4-5`) | https://console.anthropic.com/ | Also powers prompt generation and `get_content_gaps` analysis |
| `GEMINI_API_KEY` | Google AI Studio — Gemini engine (`gemini-2.5-flash-lite`) | https://aistudio.google.com/app/apikey | Free tier available — cheapest way to start |
| `PERPLEXITY_API_KEY` | Perplexity — Sonar engine | https://www.perplexity.ai/settings/api | Paid only |
| `SERPAPI_API_KEY` | SerpAPI — Google AI Overviews engine | https://serpapi.com/dashboard | Free tier ~100 searches/month |

Data location: SQLite database at `~/.digestseo/digestseo.sqlite`, created automatically on first start. Override with the optional `DIGESTSEO_DB_PATH` environment variable.

### Sanity check (optional)

```bash
npx -y digestseo-mcp
```

With at least one key exported in the shell, this starts the server on stdio and logs `ready on stdio` to stderr (press Ctrl+C to stop). With zero keys it exits 1 with an error listing the five variable names.

### Claude Desktop

Edit the config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Merge this into the `mcpServers` object (include only the keys the user has; delete the other lines):

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "digestseo-mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-REPLACE_ME",
        "ANTHROPIC_API_KEY": "sk-ant-REPLACE_ME",
        "GEMINI_API_KEY": "REPLACE_ME",
        "PERPLEXITY_API_KEY": "pplx-REPLACE_ME",
        "SERPAPI_API_KEY": "REPLACE_ME"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

Alternative for Claude Desktop: download the `.mcpb` desktop extension from the [latest GitHub release](https://github.com/AKzar1el/mcp-geo/releases/latest), double-click it, and enter the keys in the settings UI it presents.

### Claude Code (CLI)

```bash
claude mcp add --transport stdio digestseo -s user --env OPENAI_API_KEY=sk-REPLACE_ME -- npx -y digestseo-mcp
```

Add one `--env NAME=VALUE` flag per key the user has (before the `--`). The base form without env flags is `claude mcp add --transport stdio digestseo -s user -- npx -y digestseo-mcp`, but remember the server exits at startup if it ends up with zero keys.

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in the project root, same shape as Claude Desktop:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "digestseo-mcp"],
      "env": {
        "GEMINI_API_KEY": "REPLACE_ME"
      }
    }
  }
}
```

### Cline

Open Cline → MCP Servers → Configure MCP Servers (this opens `cline_mcp_settings.json`) and merge:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "digestseo-mcp"],
      "env": {
        "GEMINI_API_KEY": "REPLACE_ME"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Verify the install

Ask the client to list tools. Exactly nine must appear: `check_visibility`, `get_visibility_history`, `compare_competitors`, `get_citations`, `get_content_gaps`, `refresh_brand`, `track_brand`, `list_brands`, `generate_prompts`.

### First brand: track → refresh → check

The database starts empty. Run this three-call sequence through the MCP client (natural-language equivalent: "Track acme.com as brand `acme` and run the first scan"):

1. **`track_brand`** with arguments:

   ```json
   {
     "brand_id": "acme",
     "name": "Acme Project Tool",
     "domain": "acme.com",
     "category": "Project management software",
     "competitors": ["asana.com", "monday.com"]
   }
   ```

   Creates the brand and generates 20 buyer-intent prompts via Claude Haiku when `ANTHROPIC_API_KEY` is set; without it you get 3 generic starter prompts (`prompt_source: "fallback"`) — add the key later and call `generate_prompts` with `{"brand_id": "acme"}` to upgrade.

2. **`refresh_brand`** with `{"brand_id": "acme"}` — runs every configured engine inline; progress is logged to stderr.

3. **`check_visibility`** with `{"brand_id": "acme"}` — returns the per-engine scores. `list_brands` (no arguments) recalls the `brand_id` later.

---

## Path B: self-host on Cloudflare Workers

Full walkthrough with troubleshooting: [SETUP.md](./SETUP.md). Condensed agent-executable sequence (≈5 minutes; requires a free Cloudflare account):

```bash
git clone https://github.com/AKzar1el/mcp-geo.git
cd mcp-geo
npm install
npx wrangler login                      # opens a browser — needs the user once
cp wrangler.example.jsonc wrangler.jsonc
```

Create resources. **`wrangler kv namespace create` asks three interactive questions** ("add on your behalf?" → answer `n`, binding name → Enter, local dev remote? → `n`); do not pipe input to it:

```bash
npx wrangler kv namespace create OAUTH_KV     # copy printed id over YOUR_OAUTH_KV_ID in wrangler.jsonc
npx wrangler kv namespace create RATE_LIMIT   # copy printed id over YOUR_RATE_LIMIT_KV_ID
npx wrangler d1 create digestseo-db           # copy database_id over YOUR_D1_DATABASE_ID
grep -E "(YOUR_OAUTH_KV_ID|YOUR_RATE_LIMIT_KV_ID|YOUR_D1_DATABASE_ID)" wrangler.jsonc   # must print nothing
```

Secrets (`SEED_SECRET` is required — it gates `/admin/*`; engine keys are opt-in, same five as Path A):

```bash
npx wrangler secret put SEED_SECRET
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put PERPLEXITY_API_KEY
npx wrangler secret put SERPAPI_API_KEY
```

Migrate, deploy, verify:

```bash
npx wrangler d1 migrations apply digestseo-db --remote
npx wrangler deploy        # prints the public URL — paste it into "SELF_URL" in wrangler.jsonc, then deploy again
npx wrangler deploy
curl https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/healthz   # → ok
```

Seed a brand and run the first scan (use the SEED_SECRET value set above):

```bash
curl -X POST https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/admin/seed \
  -H "X-Seed-Secret: YOUR_SEED_SECRET" -H "Content-Type: application/json" \
  -d '{"brand_id":"acme","name":"Acme Project Tool","domain":"acme.com","category":"Project management software","competitors":["asana.com","monday.com"]}'

curl -X POST https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/admin/run-live \
  -H "X-Seed-Secret: YOUR_SEED_SECRET" -H "Content-Type: application/json" \
  -d '{"brand_id":"acme"}'
```

Connect the client: in Claude.ai (or any remote-MCP-capable client) add a custom connector pointing at `https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/mcp`. The OAuth handshake auto-completes in the OSS build. The cron trigger (`0 */6 * * *`) then refreshes brands automatically on their `refresh_frequency` cadence.
