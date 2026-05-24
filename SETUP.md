# SETUP.md — Deploying digestseo-mcp to Cloudflare Workers

This is the long-form walkthrough. If you'd rather not read it, run
`./scripts/setup.sh` from the repo root — it does everything below
interactively.

## Prerequisites

- **Node 18+** and **npm**. `node --version` should print v18 or higher.
- A free **Cloudflare account** ([dash.cloudflare.com](https://dash.cloudflare.com/sign-up)). The Workers Free plan covers a single-brand deployment comfortably; D1 is also free up to 5 GB.
- At least one engine API key — see the engine list in [README.md](./README.md#step-1--get-api-keys). You can start with just OpenAI or just Gemini.

## 1 — Clone and install

```bash
git clone https://github.com/YOUR-FORK/digestseo-mcp.git
cd digestseo-mcp
npm install
```

Wrangler is pulled in as a devDependency, so you don't need a global
install. All `wrangler` commands below can be prefixed with `npx`.

## 2 — Authenticate wrangler

```bash
npx wrangler login
```

This opens a browser, asks you to authorize wrangler against your
Cloudflare account, and stashes the credentials in
`~/.wrangler/config/default.toml`. You only need to do this once per
machine.

## 3 — Recommended path: run the setup script

```bash
./scripts/setup.sh
```

The script is interactive and idempotent — re-running it will skip
already-completed steps. It:

1. Verifies wrangler is installed and logged in.
2. Copies `wrangler.example.jsonc` → `wrangler.jsonc` and `.dev.vars.example` → `.dev.vars` if either is missing.
3. Creates the two KV namespaces (`OAUTH_KV`, `RATE_LIMIT`) and patches their IDs into `wrangler.jsonc`.
4. Creates the D1 database (`digestseo-db`) and patches its ID into `wrangler.jsonc`.
5. Prompts for each engine API key — leave blank to skip. Writes filled values to `.dev.vars` *and* installs them as Worker secrets via `wrangler secret put`.
6. Prompts for the required `SEED_SECRET`.
7. Applies all migrations to remote D1.
8. Prints the exact next commands (`wrangler deploy`, get URL, connect to Claude.ai).

If the script runs cleanly, **skip to section 9**.

## 4 — Manual path: create KV namespaces

If you'd rather walk through the wrangler commands yourself, start here.

```bash
npx wrangler kv namespace create OAUTH_KV
# → 🌀 Creating namespace with title "OAUTH_KV"
#   ✨ Success!
#   Add the following to your configuration file in your kv_namespaces array:
#   { "binding": "OAUTH_KV", "id": "abc123..." }

npx wrangler kv namespace create RATE_LIMIT
# → ... same output with a different id
```

Copy each returned `id` into `wrangler.jsonc`, replacing
`YOUR_OAUTH_KV_ID` and `YOUR_RATE_LIMIT_KV_ID` in the
`kv_namespaces` block.

## 5 — Manual path: create D1 database

```bash
npx wrangler d1 create digestseo-db
# → ✅ Successfully created DB 'digestseo-db' in region UNKNOWN
#   Created database 'digestseo-db' at 0f3a... (...)
#
#   [[d1_databases]]
#   binding = "DIGESTSEO_DB"
#   database_name = "digestseo-db"
#   database_id = "abc123..."
```

Paste the returned `database_id` into `wrangler.jsonc`, replacing
`YOUR_D1_DATABASE_ID`.

## 6 — Manual path: set secrets

For every engine you want to use, run the corresponding command and
paste your key when prompted:

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put PERPLEXITY_API_KEY
npx wrangler secret put SERPAPI_API_KEY
```

`SEED_SECRET` is required (it gates the `/admin/*` routes):

```bash
npx wrangler secret put SEED_SECRET
# Pick any high-entropy string. Save it — you'll need it as the
# X-Seed-Secret header for /admin/seed, /admin/run-live, etc.
```

For local `wrangler dev`, mirror the values you actually want to use
into `.dev.vars` (copy from `.dev.vars.example`). Wrangler reads from
`.dev.vars` only in dev mode; production reads from the encrypted
secret store.

## 7 — Manual path: apply migrations

The schema is in `migrations/`. Apply to both local and remote D1:

```bash
# Local (for `wrangler dev`)
npx wrangler d1 migrations apply digestseo-db --local

# Remote (for the deployed Worker)
npx wrangler d1 migrations apply digestseo-db --remote
```

If `migrations apply` fails because it can't find the migrations table,
run the initial file directly:

```bash
npx wrangler d1 execute digestseo-db --remote --file=migrations/0001_initial.sql
npx wrangler d1 execute digestseo-db --remote --file=migrations/0002_fail_stuck_runs.sql
npx wrangler d1 execute digestseo-db --remote --file=migrations/0003_perplexity_citations.sql
```

## 8 — Manual path: deploy

```bash
npx wrangler deploy
```

The first deploy prints the public URL — something like
`https://digestseo-mcp.YOUR-SUBDOMAIN.workers.dev`. Note it down.

## 9 — Verify it's alive

```bash
curl https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/healthz
# → ok
```

If you get `ok`, the Worker is deployed and reachable.

## 10 — Seed a test brand

```bash
curl -X POST https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/admin/seed \
  -H "X-Seed-Secret: <your SEED_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{
    "brand_id": "acme",
    "name": "Acme Project Tool",
    "domain": "acme.com",
    "category": "Project management software",
    "competitors": ["asana.com", "monday.com", "clickup.com", "notion.so"]
  }'
# → {"seeded": true, "brand_id": "acme", "prompts_inserted": 20, "prompt_source": "generated"}
```

If `prompt_source` is `"fallback"`, prompt generation failed (probably
because `ANTHROPIC_API_KEY` isn't set) and the brand was seeded with 3
generic prompts. Set the key and re-run via `/admin/generate-prompts`
to replace them with category-specific prompts.

## 11 — Kick off a live run

```bash
curl -X POST https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/admin/run-live \
  -H "X-Seed-Secret: <your SEED_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"brand_id":"acme"}'
# → {"run_ids":{"chatgpt":"...","gemini":"..."},"prompts_total":20,"engines":["chatgpt","gemini"]}
```

The `engines` array reflects whatever keys you actually configured.
Wait 30-60s for the parallel runs to finish.

## 12 — Connect to Claude.ai

In Claude.ai → Settings → Connectors → Add custom connector:

```
https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/mcp
```

Complete the OAuth flow (the OSS build auto-completes with a single
dev user — no Google/GitHub round trip). The connector turns green
when ready.

Then in any Claude.ai conversation:

> Check the AI visibility for brand_id `acme`.

Claude will call `check_visibility` and return per-engine scores. From
there, try `compare_competitors`, `get_citations`, `get_content_gaps`,
and `refresh_brand`.

## 13 — Optional: custom domain

Workers domains (`*.workers.dev`) are public and free. If you want
something like `mcp.digestseo.com`, see Cloudflare's
[custom domains for Workers](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
docs — it's a few clicks in the dashboard once the domain is on
Cloudflare DNS.

## Where to go next

- Read [README.md](./README.md) for the full tools reference and
  troubleshooting.
- Read the source in `src/index.ts` — the 6 MCP tools, the OAuth
  glue, the cron handler, and the admin routes are all there in one
  file.
- Re-run `./scripts/setup.sh` any time you want to add a key you
  skipped initially — it's idempotent.
