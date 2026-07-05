# llms-install.md — agent installation guide for mcp-geo (digestseo-mcp)

This file is for AI agents (Cline, Claude Code, Cursor, etc.) installing **mcp-geo** on behalf of a user. It takes the user from zero to a personal, self-hosted instance on Cloudflare Workers. The human-oriented walkthrough with full explanations is [SETUP.md](SETUP.md) — this file mirrors it in deterministic, copy-pasteable steps.

**What you are deploying:** a remote MCP server that tracks how often a brand is cited by ChatGPT, Claude, Perplexity, Gemini, and Google AI Overviews (6 tools: `check_visibility`, `get_visibility_history`, `compare_competitors`, `get_citations`, `get_content_gaps`, `refresh_brand`). It runs on the user's own Cloudflare account with the user's own engine API keys, stores data in D1, and auto-refreshes via a Cron Trigger. The connect URL at the end is `https://<worker-host>/mcp`.

**Engines are opt-in.** Each of the five engines activates only when its API key is set as a Worker secret; engines without keys are skipped gracefully. At least one engine key must be set for the server to return data.

**Security rule for agents:** every secret is entered by the **user directly into the terminal prompt** opened by `wrangler secret put`. Never ask the user to paste a secret into the chat, and never echo a secret back.

## Prerequisites (check before starting)

1. **Node.js 18+ and npm** — verify with `node --version`.
2. **A Cloudflare account** — the free Workers + D1 plan is enough for a single brand on a daily cadence. If the user has none, have them sign up at <https://dash.cloudflare.com/sign-up>.
3. **At least one engine API key** (all five are optional individually, but at least one must be set):

   | Worker secret | Provider / engine | Where the user gets the key | Notes |
   |---|---|---|---|
   | `OPENAI_API_KEY` | OpenAI — ChatGPT engine | <https://platform.openai.com/api-keys> | Recommended starter |
   | `ANTHROPIC_API_KEY` | Anthropic — Claude engine | <https://console.anthropic.com/> | Recommended starter; also powers prompt generation and `get_content_gaps` |
   | `GEMINI_API_KEY` | Google AI Studio — Gemini engine | <https://aistudio.google.com/app/apikey> | Free tier rate-limits brands with more than ~5 prompts — treat as an opt-in add-on |
   | `PERPLEXITY_API_KEY` | Perplexity — Sonar engine | <https://www.perplexity.ai/settings/api> | Paid only |
   | `SERPAPI_API_KEY` | SerpAPI — Google AI Overviews engine | <https://serpapi.com/dashboard> | Free tier ~100 calls/month |

   Recommend **OpenAI + Anthropic** as the starting pair — both bill per token with no rate-limit surprises, so the first scan returns clean, scorable data.

## Step 1 — Clone and install

```bash
git clone https://github.com/AKzar1el/mcp-geo.git
cd mcp-geo
npm install
```

Wrangler ships as a devDependency, so `npx wrangler` works without a global install.

## Step 2 — Authenticate wrangler

```bash
npx wrangler login
```

This opens a browser; the user completes the Cloudflare login there. One-time per machine.

## Step 3 — Create wrangler.jsonc from the template

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

(`wrangler.jsonc` is gitignored; the template stays in git.)

## Step 4 — Create the KV namespace and D1 database, paste the ids

```bash
npx wrangler kv namespace create OAUTH_KV
```

Wrangler asks three interactive questions after creating the namespace — answer them exactly (do not try to script these; the user answers in the terminal):

- "Would you like Wrangler to add it on your behalf?" → **n**
- "What binding name would you like to use?" → press **Enter** (accepts `OAUTH_KV`)
- "For local dev, do you want to connect to the remote resource instead of a local resource?" → **n**

Capture the printed `id` and replace `YOUR_OAUTH_KV_ID` in `wrangler.jsonc` with it.

```bash
npx wrangler d1 create digestseo-db
```

Capture the printed `database_id` and replace `YOUR_D1_DATABASE_ID` in `wrangler.jsonc` with it.

Verify nothing was missed — this must print **nothing**:

```bash
grep -E "(YOUR_OAUTH_KV_ID|YOUR_D1_DATABASE_ID)" wrangler.jsonc
```

Change **only** those two ids. Do not rename the `OAUTH_KV` binding, the `DIGESTSEO_DB` D1 binding, the Durable Object binding `MCP_OBJECT` with class `GeoMcpAgent`, the `SELF` service binding, or the `migrations` block (tag `v1`, `new_sqlite_classes: ["GeoMcpAgent"]`) — the code depends on these exact names.

**Note on the `SELF` service binding:** `"services": [{ "binding": "SELF", "service": "digestseo-mcp" }]` must keep `service` identical to the top-level `name` field. If the user renames the worker, update both. This binding is how `/admin/run-live` fans out one worker invocation per engine (a public-URL self-fetch would trip Cloudflare error 1042).

## Step 5 — Set secrets

Required (gates the `/admin/*` routes; the user should generate a high-entropy string, e.g. `openssl rand -hex 32`, and save it — it is sent later as the `X-Seed-Secret` header):

```bash
npx wrangler secret put SEED_SECRET
```

Strongly recommended (without it, anyone who discovers the worker URL can connect an MCP client and spend the user's engine API credits — see [SECURITY.md](SECURITY.md)):

```bash
npx wrangler secret put CONNECT_SECRET
```

Then set the engine keys the user has (each is opt-in; at least one required):

```bash
npx wrangler secret put OPENAI_API_KEY      # ChatGPT engine — recommended starter
npx wrangler secret put ANTHROPIC_API_KEY   # Claude engine + prompt generation — recommended starter
npx wrangler secret put GEMINI_API_KEY      # optional add-on
npx wrangler secret put PERPLEXITY_API_KEY  # optional, paid
npx wrangler secret put SERPAPI_API_KEY     # optional
```

## Step 6 — Apply migrations and deploy

```bash
npx wrangler d1 migrations apply digestseo-db --remote
```

Answer **y** if asked "Would you like to apply these migrations?".

```bash
npx wrangler deploy
```

Wrangler prints the Worker URL, e.g. `https://digestseo-mcp.<account-subdomain>.workers.dev`. **Record it** — every step below needs it.

Optional but recommended: paste that URL over the `SELF_URL` placeholder in the `"vars"` block of `wrangler.jsonc` and run `npx wrangler deploy` once more (runs work with the placeholder, but the real URL keeps logs honest).

## Step 7 — Verify the deploy

```bash
curl https://<worker-host>/healthz
```

Expected output: `ok`.

## Step 8 — Seed the user's first brand

Ask the user for their brand name, domain, category, and competitor domains, then:

```bash
curl -X POST https://<worker-host>/admin/seed \
  -H "X-Seed-Secret: <SEED_SECRET value>" \
  -H "Content-Type: application/json" \
  -d '{
    "brand_id": "acme",
    "name": "Acme Project Tool",
    "domain": "acme.com",
    "category": "Project management software",
    "competitors": ["asana.com", "monday.com"]
  }'
```

Expected response: `{"seeded": true, "brand_id": "acme", "prompts_inserted": 20, "prompt_source": "generated"}`. If `prompt_source` is `"fallback"`, the Claude Haiku prompt generator failed — usually because `ANTHROPIC_API_KEY` is not set (transient API/network failures also trigger it). Template prompts still work; to upgrade them, set the key and re-generate via `POST /admin/generate-prompts` (same `X-Seed-Secret` header, body `{"brand_id":"acme"}`).

## Step 9 — Trigger the first scan

```bash
curl -X POST https://<worker-host>/admin/run-live \
  -H "X-Seed-Secret: <SEED_SECRET value>" \
  -H "Content-Type: application/json" \
  -d '{"brand_id":"acme"}'
```

Wait 30–60 seconds for the engines to finish. After this, the built-in Cron Trigger (`0 */6 * * *`) auto-refreshes on each brand's `refresh_frequency` cadence — no further manual scans needed.

## Step 10 — Connect the MCP client

The connect URL is the Worker URL with path `/mcp`. The OAuth handshake auto-completes; if `CONNECT_SECRET` is set, a one-field browser form asks for it first.

### Claude Code

```bash
claude mcp add --transport http digestseo https://<worker-host>/mcp
```

Then the user runs `/mcp` inside Claude Code to complete the OAuth handshake in the browser.

### Claude.ai (web)

Settings → Connectors → Add custom connector → paste `https://<worker-host>/mcp`.

### Claude Desktop

Merge into `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<worker-host>/mcp"]
    }
  }
}
```

### Cursor

Same `mcp-remote` block in `~/.cursor/mcp.json`, then restart Cursor.

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.digestseo]
command = "npx"
args = ["-y", "mcp-remote", "https://<worker-host>/mcp"]
```

## Step 11 — Verify end to end

In the connected client, ask:

> Check the AI visibility for brand_id `acme`.

The client should call `check_visibility` and return per-engine scores for every engine whose key was set.

## Troubleshooting

- **Tools return empty data** — no engine key set, or the first scan hasn't run. Check `npx wrangler secret list`, re-run Step 9.
- **`401 unauthorized` from `/admin/*`** — the `X-Seed-Secret` header doesn't match the deployed `SEED_SECRET`.
- **Connector won't connect** — the URL must end in `/mcp`; if `CONNECT_SECRET` is set the browser form must be completed. If OAuth loops, remove and re-add the connector.
- **Error 1042 / 404 on self-fetch** — the `services` binding's `service` value doesn't match the worker's `name` field in `wrangler.jsonc`. Fix and redeploy.
- **Gemini rows all `failed` with 429** — Gemini free-tier rate limit; drop the key or upgrade. See [README Troubleshooting](README.md#troubleshooting) for the full list.
