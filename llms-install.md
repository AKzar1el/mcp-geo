# llms-install.md — AI agent installation guide for the DigestSEO GEO Tracker

This file is written for AI agents (Cline, Claude Code, Cursor agents, etc.) installing **@digestseo/mcp-geo** (the `digestseo-mcp` executable), an MCP server that tracks how ChatGPT, Claude, Perplexity, Gemini, and Google AI Overviews cite a brand. Every command below is copy-pasteable as-is. Choose exactly one path:

- **Path A (recommended): run locally via npx** — no hosting, data stays in a local SQLite file, user brings their own AI provider API keys.
- **Path B: self-host on Cloudflare Workers** — remote MCP server with D1 storage, cron auto-refresh, and admin HTTP routes. The connect URL at the end is `https://<worker-host>/mcp`.
- **Path C (optional): managed AI Visibility Audit** — if the user wants the result without installing or operating mcp-geo, the fixed-price EUR 99 one-time audit covers one brand/domain, up to three competitors, 20 buyer-intent prompts, up to five supported AI surfaces where usable, citation/source evidence, and a prioritized action memo. The open-source package remains free.

For Path C, review the [audit methodology](docs/ai-visibility-audit-methodology.md) and [sample report](docs/demo-report-full.png), then [open the source-marked audit request](mailto:info@tomiseregi.si?subject=mcp-geo%20AI%20Visibility%20Audit%20-%20EUR%2099&body=Hi%20Tomi%2C%0A%0AI%27d%20like%20the%20EUR%2099%20mcp-geo%20AI%20Visibility%20Audit.%0A%0ABrand%2Fdomain%3A%0ACompetitors%20%28up%20to%203%29%3A%0AContext%20or%20priority%20%28optional%29%3A%0A%0ASource%3A%20mcp-geo%20llms-install). No subscription or sales call is required; after fit and scope are confirmed, normal invoice/payment instructions are sent.

**Security rule for agents:** API keys and secrets are entered by the **user** — into their MCP client config file (Path A) or into the terminal prompt opened by `wrangler secret put` (Path B). Never ask the user to paste a secret into the chat, and never echo a secret back.

---

## Path A (recommended): local stdio server via npx

### Requirements

- Node.js >= 22 (`node --version`)
- API keys are optional for startup and MCP tool discovery; at least one is needed for engine-backed scans

### API keys

All five keys are **optional individually**. With zero keys, the server still starts so MCP clients can discover its tools, while engine-backed scans report that no engines are available. Engines whose key is absent are skipped gracefully. Add only the provider keys the user chooses to use.

| Environment variable | Provider / engine | Where to get the key | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | OpenAI — ChatGPT engine (`gpt-5-search-api`, web search) | https://platform.openai.com/api-keys | Grounded search; OpenAI bills web-search calls plus model tokens — check current API pricing |
| `ANTHROPIC_API_KEY` | Anthropic — Claude engine (`claude-haiku-4-5`) | https://console.anthropic.com/ | Recommended starter; also powers prompt generation and `get_content_gaps` analysis |
| `GEMINI_API_KEY` | Google AI Studio — Gemini engine (`gemini-3.1-flash-lite`) | https://aistudio.google.com/app/apikey | Rate limits vary by model, project, and usage tier; check the project's active limits in Google AI Studio |
| `PERPLEXITY_API_KEY` | Perplexity — Sonar engine | https://www.perplexity.ai/settings/api | Paid only |
| `SERPAPI_API_KEY` | SerpAPI — Google AI Overviews engine | https://serpapi.com/dashboard | Free tier 250 searches/month |

Recommend **OpenAI + Anthropic** as the starting pair. OpenAI provides grounded ChatGPT visibility through web search and bills search calls plus model tokens; Anthropic also powers prompt generation and content-gap analysis. Check current provider pricing before estimating scan cost.

Data location: SQLite database at `~/.digestseo/digestseo.sqlite`, created automatically on first start. Override with the optional `DIGESTSEO_DB_PATH` environment variable.

### Sanity check (optional)

```bash
npx -y @digestseo/mcp-geo
```

This starts the server on stdio and logs `ready on stdio` to stderr (press Ctrl+C to stop). With zero keys it still starts for MCP discovery and logs a warning; add one or more provider keys before running an engine-backed scan.

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
      "args": ["-y", "@digestseo/mcp-geo"],
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

### ChatGPT

ChatGPT does **not** connect directly to local STDIO MCP servers, so do not register Path A there. Use **Path B** and add the configured Worker `/mcp` URL as a custom MCP app in ChatGPT Developer Mode. If the MCP server must stay local/private, use OpenAI Secure MCP Tunnel instead of exposing or pretending to register the local `npx` command directly.

### Claude Code (CLI)

```bash
claude mcp add --transport stdio digestseo -s user --env OPENAI_API_KEY=sk-REPLACE_ME -- npx -y @digestseo/mcp-geo
```

Add one `--env NAME=VALUE` flag per key the user has (before the `--`). The base form without env flags is `claude mcp add --transport stdio digestseo -s user -- npx -y @digestseo/mcp-geo`; it starts for discovery, but engine-backed scans need at least one provider key.

### Codex CLI

```bash
codex mcp add digestseo -- npx -y @digestseo/mcp-geo
```

The base command starts the local STDIO server with zero provider keys for tool discovery. Add one `--env NAME=VALUE` option per provider key before the `--` when engine-backed scans are needed, then use `codex mcp list` to verify the server is configured.

### OpenCode v2

```bash
opencode mcp add digestseo --global -- npx -y @digestseo/mcp-geo
```

OpenCode v2 stores local MCP servers under `mcp.servers` and launches the command over STDIO. Omit `--global` for project-only configuration. The zero-key command is enough for discovery; add only the provider keys the user chose with `--env NAME=VALUE` before the `--` when scans are needed, then verify the connection with `opencode mcp list`.

### GitHub Copilot CLI

```bash
copilot mcp add digestseo -- npx -y @digestseo/mcp-geo
```

This zero-key base command is enough for tool discovery. Add provider keys with repeated `--env NAME=VALUE` options supported by Copilot CLI before the `digestseo -- ...` portion when engine-backed scans are needed.

### Factory Droid

```bash
droid mcp add digestseo "npx -y @digestseo/mcp-geo"
droid mcp list
```

Droid treats the quoted command as a local STDIO server and stores servers added by `droid mcp add` in the user-level `~/.factory/mcp.json`. The zero-key command is enough for MCP discovery. Before an engine-backed scan, add only the provider keys the user chose to the user-level server config; keep secrets out of project-level `.factory/mcp.json`. Droid supports `${NAME}` expansion for STDIO `env` values, so a user can reference an API key already present in their shell environment without committing the value to disk.

### Amazon Q Developer (IDE)

Open the Amazon Q Developer chat panel, select **Tools**, choose **+**, and add a **STDIO** MCP server with:

- Name: `digestseo`
- Command: `npx`
- Arguments: `-y` and `@digestseo/mcp-geo`
- Environment variables: only the provider keys the user chose to use

Amazon Q Developer supports local STDIO MCP servers and environment variables in this configuration UI. The zero-key command is enough for tool discovery; engine-backed scans still need at least one provider key.

### JetBrains AI Assistant (IDE)

Open **Settings > Tools > AI Assistant > Model Context Protocol (MCP)**, choose **Add > STDIO**, and paste:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"]
    }
  }
}
```

JetBrains AI Assistant supports local STDIO MCP servers and NPX launch commands. The zero-key configuration is sufficient for MCP discovery. Before an engine-backed scan, ensure only the chosen provider API keys are present in the environment inherited by the IDE process; alternatively, JetBrains can import an existing Claude MCP configuration.

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in the project root, same shape as Claude Desktop:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"],
      "env": {
        "OPENAI_API_KEY": "sk-REPLACE_ME"
      }
    }
  }
}
```

### Windsurf

Open Windsurf → **Manage MCPs → View raw config** and add:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"],
      "env": {
        "OPENAI_API_KEY": "sk-REPLACE_ME"
      }
    }
  }
}
```

Windsurf supports local stdio MCP servers. Keep only the provider keys the user chose; the zero-key base command still starts for tool discovery.

### VS Code

Use VS Code's MCP install URL for the local stdio package:

[Install `digestseo` in VS Code](vscode:mcp/install?%7B%22name%22%3A%22digestseo%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40digestseo%2Fmcp-geo%22%5D%7D)

The one-click link installs the zero-key base command (`npx -y @digestseo/mcp-geo`), which is enough for MCP tool discovery. Before engine-backed scans, run **MCP: Open User Configuration** and add only the provider API keys the user chose under this server's environment. Avoid hardcoding secrets in a shared workspace configuration.

### Cline

Open Cline → MCP Servers → Configure MCP Servers (this opens `cline_mcp_settings.json`) and merge:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"],
      "env": {
        "OPENAI_API_KEY": "sk-REPLACE_ME"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Roo Code

Open **MCP Servers > Edit Global MCP** for a global install, or create `.roo/mcp.json` in the project root, and add:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"]
    }
  }
}
```

This zero-key STDIO config is enough for discovery. Add only the provider environment variables the user chose before engine-backed scans. On Windows, Roo's documented fallback is `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@digestseo/mcp-geo"]` when direct `npx` launch is unavailable.

### Kiro

Open **Kiro: Open user MCP config (JSON)** for a global install, or **Kiro: Open workspace MCP config (JSON)** for a project-scoped install (`~/.kiro/settings/mcp.json` and `.kiro/settings/mcp.json` respectively), then add:

```json
{
  "mcpServers": {
    "digestseo": {
      "command": "npx",
      "args": ["-y", "@digestseo/mcp-geo"]
    }
  }
}
```

Kiro supports local STDIO MCP servers and reconnects after the JSON config is saved. The zero-key config is enough for MCP discovery; add only the provider environment variables the user chose before engine-backed scans. For a remote deployment, Kiro also supports HTTP MCP servers via a `url` entry, but use the user's configured self-hosted Worker rather than the public `geo-mcp.digestseo.com/mcp` endpoint.

### Verify the install

Ask the client to list tools. Exactly ten must appear: `check_visibility`, `get_visibility_history`, `compare_competitors`, `get_citations`, `get_content_gaps`, `refresh_brand`, `track_brand`, `list_brands`, `list_prompts`, `generate_prompts`.

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

   Creates the brand and generates 20 buyer-intent prompts via Claude Haiku when `ANTHROPIC_API_KEY` is set; without it you get 3 generic starter prompts (`prompt_source: "fallback"`) — add the key later and call `generate_prompts` with `{"brand_id": "acme"}` to upgrade. If the brand name or domain root is an everyday word ("Monday", "Notion"), pass `exclude_terms` (and optionally `aliases`) so mentions are matched accurately.

2. **`refresh_brand`** with `{"brand_id": "acme"}` — runs every configured engine inline; progress is logged to stderr.

3. **`check_visibility`** with `{"brand_id": "acme"}` — returns the per-engine scores. `list_brands` (no arguments) recalls the `brand_id` later. `list_prompts` with that `brand_id` shows the exact active measurement set without changing it.

---

## Path B: self-host on Cloudflare Workers

The human-oriented walkthrough with full explanations and troubleshooting is [SETUP.md](./SETUP.md) — this path mirrors it in deterministic steps (≈5 minutes; requires a free Cloudflare account). The Worker MCP surface exposes the six visibility tools; brand management happens over the `X-Seed-Secret`-gated `/admin/*` routes instead of `track_brand`.

### Step 1 — Clone and install

```bash
git clone https://github.com/AKzar1el/mcp-geo.git
cd mcp-geo
npm install
```

Wrangler ships as a devDependency, so `npx wrangler` works without a global install.

### Step 2 — Authenticate wrangler

```bash
npx wrangler login
```

This opens a browser; the user completes the Cloudflare login there. One-time per machine.

### Step 3 — Create wrangler.jsonc from the template

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

(`wrangler.jsonc` is gitignored; the template stays in git.)

### Step 4 — Create the KV namespace and D1 database, paste the ids

```bash
npx wrangler kv namespace create OAUTH_KV
```

Wrangler asks three interactive questions after creating the namespace — answer them exactly (do not try to script these; the user answers in the terminal):

- "Would you like Wrangler to add it on your behalf?" → **n**
- "What binding name would you like to use?" → press **Enter** (accepts `OAUTH_KV`)
- "For local dev, do you want to connect to the remote resource instead of a local resource?" → **n**

Capture the printed `id` and replace `YOUR_OAUTH_KV_ID` in `wrangler.jsonc` with it.

```bash
npx wrangler d1 create mcp-geo-db
```

Capture the printed `database_id` and replace `YOUR_D1_DATABASE_ID` in `wrangler.jsonc` with it.

Verify nothing was missed — this must print **nothing**:

```bash
grep -E "(YOUR_OAUTH_KV_ID|YOUR_D1_DATABASE_ID)" wrangler.jsonc
```

Change **only** those two ids. Do not rename the `OAUTH_KV` binding, the `DIGESTSEO_DB` D1 binding, the Durable Object binding `MCP_OBJECT` with class `GeoMcpAgent`, the `SELF` service binding, or the `migrations` block (tag `v1`, `new_sqlite_classes: ["GeoMcpAgent"]`) — the code depends on these exact names.

**Note on the `SELF` service binding:** `"services": [{ "binding": "SELF", "service": "digestseo-mcp" }]` must keep `service` identical to the top-level `name` field. If the user renames the worker, update both. This binding is how `/admin/run-live` fans out one worker invocation per engine (a public-URL self-fetch would trip Cloudflare error 1042).

### Step 5 — Set secrets

Required (gates the `/admin/*` routes; the user should generate a high-entropy string, e.g. `openssl rand -hex 32`, and save it — it is sent later as the `X-Seed-Secret` header):

```bash
npx wrangler secret put SEED_SECRET
```

Strongly recommended (without it, anyone who discovers the worker URL can connect an MCP client and spend the user's engine API credits — see [SECURITY.md](SECURITY.md)):

```bash
npx wrangler secret put CONNECT_SECRET
```

Then set the engine keys the user has (each is opt-in; at least one required — same five as Path A):

```bash
npx wrangler secret put OPENAI_API_KEY      # ChatGPT engine — recommended starter
npx wrangler secret put ANTHROPIC_API_KEY   # Claude engine + prompt generation — recommended starter
npx wrangler secret put GEMINI_API_KEY      # optional add-on
npx wrangler secret put PERPLEXITY_API_KEY  # optional, paid
npx wrangler secret put SERPAPI_API_KEY     # optional
```

### Step 6 — Apply migrations and deploy

```bash
npx wrangler d1 migrations apply mcp-geo-db --remote
```

Answer **y** if asked "Would you like to apply these migrations?".

```bash
npx wrangler deploy
```

Wrangler prints the Worker URL, e.g. `https://digestseo-mcp.<account-subdomain>.workers.dev`. **Record it** — every step below needs it.

Optional but recommended: paste that URL over the `SELF_URL` placeholder in the `"vars"` block of `wrangler.jsonc` and run `npx wrangler deploy` once more (runs work with the placeholder, but the real URL keeps logs honest).

### Step 7 — Verify the deploy

```bash
curl https://<worker-host>/healthz
```

Expected output: `ok`.

### Step 8 — Seed the user's first brand

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

The payload also accepts optional `"aliases": [...]` and `"exclude_terms": [...]` arrays — use `exclude_terms` when the brand name or domain root is an everyday word ("Monday", "Notion").

Expected response: `{"seeded": true, "brand_id": "acme", "prompts_inserted": 20, "prompt_source": "generated"}`. If `prompt_source` is `"fallback"`, the Claude Haiku prompt generator failed — usually because `ANTHROPIC_API_KEY` is not set (transient API/network failures also trigger it). Template prompts still work; to upgrade them, set the key and re-generate via `POST /admin/generate-prompts` (same `X-Seed-Secret` header, body `{"brand_id":"acme"}`).

### Step 9 — Trigger the first scan

```bash
curl -X POST https://<worker-host>/admin/run-live \
  -H "X-Seed-Secret: <SEED_SECRET value>" \
  -H "Content-Type: application/json" \
  -d '{"brand_id":"acme"}'
```

Wait 30–60 seconds for the engines to finish. After this, the built-in Cron Trigger (`0 */6 * * *`) auto-refreshes on each brand's `refresh_frequency` cadence — no further manual scans needed.

### Step 10 — Connect the MCP client

The connect URL is the Worker URL with path `/mcp`. The OAuth handshake auto-completes; if `CONNECT_SECRET` is set, a one-field browser form asks for it first.

#### Claude Code

```bash
claude mcp add --transport http digestseo https://<worker-host>/mcp
```

Then the user runs `/mcp` inside Claude Code to complete the OAuth handshake in the browser.

#### Claude.ai (web)

Settings → Connectors → Add custom connector → paste `https://<worker-host>/mcp`.

#### Claude Desktop

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

#### Cursor

Same `mcp-remote` block in `~/.cursor/mcp.json`, then restart Cursor.

#### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.digestseo]
command = "npx"
args = ["-y", "mcp-remote", "https://<worker-host>/mcp"]
```

### Step 11 — Verify end to end

In the connected client, ask:

> Check the AI visibility for brand_id `acme`.

The client should call `check_visibility` and return per-engine scores for every engine whose key was set.

### Troubleshooting (Path B)

- **Tools return empty data** — no engine key set, or the first scan hasn't run. Check `npx wrangler secret list`, re-run Step 9.
- **`401 unauthorized` from `/admin/*`** — the `X-Seed-Secret` header doesn't match the deployed `SEED_SECRET`.
- **Connector won't connect** — the URL must end in `/mcp`; if `CONNECT_SECRET` is set the browser form must be completed. If OAuth loops, remove and re-add the connector.
- **Error 1042 / 404 on self-fetch** — the `services` binding's `service` value doesn't match the worker's `name` field in `wrangler.jsonc`. Fix and redeploy.
- **Gemini rows all `failed` with 429** — check the project's active Gemini API limits in Google AI Studio; limits vary by model, project, and usage tier. Wait/retry or reduce request rate first, then consider a paid tier if the project consistently needs more capacity. See [README Troubleshooting](README.md#troubleshooting) for the full list.
