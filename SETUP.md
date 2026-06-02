# SETUP.md — Deploying digestseo-mcp to Cloudflare Workers

5-minute walkthrough. If you hit a problem, the Troubleshooting section at the bottom likely covers it.

## Prerequisites

- **Node 18+** — verify with `node --version`.
- A free **Cloudflare account** — sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
- At least one engine API key — see the engine list in [README.md → Step 1 — Get API keys](./README.md#step-1--get-api-keys).

## 1 — Clone and install

```bash
git clone https://github.com/AKzar1el/mcp-geo.git
cd mcp-geo
npm install
```

Wrangler ships as a devDependency, so `npx wrangler` works without a global install.

## 2 — Authenticate wrangler

```bash
npx wrangler login
```

This opens a browser, authorizes wrangler against your Cloudflare account, and stashes credentials locally. One-time per machine.

## 3 — Copy the config template

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

`wrangler.jsonc` is gitignored. Your real IDs go here. The template stays in the repo.

Optional: also copy `.dev.vars.example` to `.dev.vars` if you plan to run `wrangler dev` locally.

```bash
cp .dev.vars.example .dev.vars
```

## 4 — Create the KV namespace

```bash
npx wrangler kv namespace create OAUTH_KV
```

Wrangler will ask three questions after creating the namespace:

- "Would you like Wrangler to add it on your behalf?" → answer **n** (we'll do it manually below).
- "What binding name would you like to use?" → press Enter to accept `OAUTH_KV`.
- "For local dev, do you want to connect to the remote resource instead of a local resource?" → press Enter or answer **n**.

Wrangler prints a JSON snippet like:

```json
"kv_namespaces": [
  {
    "binding": "OAUTH_KV",
    "id": "d260b40c2a9b42ad9ce11a0c8a9ae652"
  }
]
```

**Copy the `id` value**, open `wrangler.jsonc`, and replace `YOUR_OAUTH_KV_ID` with it.

## 5 — Create the D1 database

```bash
npx wrangler d1 create digestseo-db
```

Output includes:

```
[[d1_databases]]
binding = "DIGESTSEO_DB"
database_name = "digestseo-db"
database_id = "abc12345-1234-1234-1234-abc123456789"
```

**Copy the `database_id` value** and replace `YOUR_D1_DATABASE_ID` in `wrangler.jsonc`.

## 6 — Verify wrangler.jsonc is fully filled in

```bash
grep -E "(YOUR_OAUTH_KV_ID|YOUR_D1_DATABASE_ID)" wrangler.jsonc
```

Expected output: **nothing**. If grep prints any line, you missed one — go back and replace it.

## 7 — Set required secrets

The only secret strictly required is `SEED_SECRET` — it gates the `/admin/*` routes.

```bash
npx wrangler secret put SEED_SECRET
```

Paste any high-entropy string when prompted (e.g. `openssl rand -hex 32`). Save it — you'll need it as the `X-Seed-Secret` header for admin endpoints.

Then add API keys for whichever engines you want to use. Each is opt-in — engines without keys are silently skipped.

```bash
npx wrangler secret put OPENAI_API_KEY      # ChatGPT engine — recommended starter
npx wrangler secret put ANTHROPIC_API_KEY   # Claude engine + prompt generation — recommended starter
npx wrangler secret put GEMINI_API_KEY      # Gemini engine (opt-in; free-tier rate limits, see Troubleshooting)
npx wrangler secret put PERPLEXITY_API_KEY  # Perplexity engine (paid)
npx wrangler secret put SERPAPI_API_KEY     # Google AI Overviews (paid)
```

Recommended starting pair is **OpenAI + Anthropic (Claude)** — both bill per token with no rate-limit surprises, so your first scan returns clean, scorable data across the ChatGPT and Claude engines, and the Anthropic key also powers prompt generation. Solo evaluation runs comfortably under €1/month on the two together. Add Gemini, Perplexity, or SerpAPI once you want more coverage.

## 8 — Configure the `SELF` service binding

When `/admin/run-live` fires, it splits its work into one self-fetch per engine to `/admin/run-engine`. Each self-fetch runs in its own worker invocation, so each engine gets its own free-plan 50-subrequest budget. Without that split, one invocation tries to do 5 engines × 20 prompts in a single budget and bursts past the cap mid-run.

Cloudflare blocks a worker from calling its own public URL — `fetch("https://my-worker.workers.dev/...")` from inside that same worker trips error code 1042 and the request never lands. The fix is a **service binding** that points the worker at itself through Cloudflare's internal fabric.

The binding is already set in `wrangler.example.jsonc`:

```jsonc
"services": [
  { "binding": "SELF", "service": "digestseo-mcp" }
]
```

The `service` value **must match** the `name` field at the top of the same file. If you renamed your worker (e.g. to `acme-mcp`), update both:

```jsonc
{
  "name": "acme-mcp",
  ...
  "services": [
    { "binding": "SELF", "service": "acme-mcp" }
  ]
}
```

Service bindings route by request pathname; the host part of the URL doesn't actually have to resolve over public DNS. But `new Request(url, ...)` requires a syntactically valid URL, so the orchestrator still needs to know the canonical hostname. After your first `wrangler deploy` (in Step 10), wrangler will print the URL — paste it back into the `SELF_URL` value at the top of `wrangler.jsonc`:

```jsonc
"vars": {
  "SELF_URL": "https://digestseo-mcp.YOUR-SUBDOMAIN.workers.dev"
}
```

If you leave the placeholder in place, HTTP-triggered runs (via `/admin/run-live` or the `refresh_brand` MCP tool while a Claude.ai connector is talking to the worker) still work because the orchestrator falls back to deriving the origin from the inbound request. The cron path (no inbound request to derive from) will log a clear error and bail until `SELF_URL` is set.

## 9 — Apply migrations

```bash
npx wrangler d1 migrations apply digestseo-db --remote
```

If it asks "Would you like to apply these migrations?" answer **y**.

If `migrations apply` fails because it can't find the migrations table, run each file directly:

```bash
npx wrangler d1 execute digestseo-db --remote --file=migrations/0001_initial.sql
npx wrangler d1 execute digestseo-db --remote --file=migrations/0002_fail_stuck_runs.sql
npx wrangler d1 execute digestseo-db --remote --file=migrations/0003_perplexity_citations.sql
npx wrangler d1 execute digestseo-db --remote --file=migrations/0004_response_status.sql
```

## 10 — Deploy

```bash
npx wrangler deploy
```

Wrangler prints the public URL. Looks like `https://digestseo-mcp.YOUR-SUBDOMAIN.workers.dev`. **Save this URL** — you'll need it in every step below.

## 11 — Verify it's alive

```bash
curl https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/healthz
# → ok
```

If you see `ok`, the Worker is reachable.

## 12 — Seed your first brand

```bash
curl -X POST https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/admin/seed \
  -H "X-Seed-Secret: YOUR_SEED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "brand_id": "acme",
    "name": "Acme Project Tool",
    "domain": "acme.com",
    "category": "Project management software",
    "competitors": ["asana.com", "monday.com", "clickup.com", "notion.so"]
  }'
```

Expected response:

```json
{"seeded": true, "brand_id": "acme", "prompts_inserted": 20, "prompt_source": "generated"}
```

If `prompt_source` is `"fallback"`, the prompt generator (Claude Haiku) failed — usually because `ANTHROPIC_API_KEY` isn't set. Set the key and re-run via `/admin/generate-prompts`.

## 13 — Trigger a live scan

```bash
curl -X POST https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/admin/run-live \
  -H "X-Seed-Secret: YOUR_SEED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"brand_id":"acme"}'
```

Wait 30-60s for the engines to finish.

## 14 — Connect to Claude.ai

Claude.ai → Settings → Connectors → Add custom connector:

```
https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/mcp
```

The OAuth handshake auto-completes in the OSS build (single dev user, no Google/GitHub round-trip).

In a Claude.ai conversation, try:

> Check the AI visibility for brand_id `acme`.

Claude will call `check_visibility` and return per-engine scores. From there try `compare_competitors`, `get_citations`, `get_content_gaps`, `refresh_brand`.

## Troubleshooting

- **`wrangler deploy` says "KV namespace 'YOUR_OAUTH_KV_ID' is not valid"** — you forgot to replace one of the placeholder ids in `wrangler.jsonc`. Run the grep check from Step 6.
- **`wrangler kv namespace create` hangs** — wrangler is waiting for your answer to one of the three interactive prompts. Don't try to script these; run the command directly in your terminal and answer them by typing.
- **`Cannot find module '@cloudflare/workers-oauth-provider'` on deploy** — you skipped `npm install`. Run it from the repo root.
- **`401 unauthorized` from `/admin/*`** — `X-Seed-Secret` header is missing or doesn't match the deployed `SEED_SECRET`. Re-run `npx wrangler secret put SEED_SECRET` and use the value you set.
- **`prompt_source: "fallback"`** in seed response — `ANTHROPIC_API_KEY` isn't set, so Claude Haiku-based prompt generation skipped. Set it via `npx wrangler secret put ANTHROPIC_API_KEY` and the next seed will use real generated prompts.
- **Cron not firing** — Cloudflare dashboard → Workers & Pages → digestseo-mcp → Settings → Triggers. The cron `0 */6 * * *` should be listed. If missing, re-run `npx wrangler deploy`.
- **Custom MCP connector in Claude.ai not connecting** — URL must end in `/mcp`. Try `curl https://YOUR-URL/mcp` and confirm you get a non-error response. If the OAuth loops, remove and re-add the connector.

## Optional: custom domain

Workers `.workers.dev` URLs work, but if you want `mcp.example.com`, see Cloudflare's [custom domains for Workers](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) — a few clicks once your domain is on Cloudflare DNS.
