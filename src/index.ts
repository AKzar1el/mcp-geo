// Cloudflare Worker entry: McpAgent wiring, D1 deps construction,
// /admin/* routes, the cron trigger, and the per-engine fan-out. All
// tool logic lives in src/core/tools.ts and is shared with the local
// stdio CLI (src/cli.ts).

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createD1Db } from './db/d1.js';
import type { Db } from './db/types.js';
import {
  ALL_ENGINES,
  getAvailableEngines,
  isEngineName,
  runEngineInProcess,
  type EngineName,
} from './core/engines.js';
import { registerTools } from './core/tools.js';
import { collectBatch, submitBatch } from './core/openai.js';
import { generatePrompts } from './core/prompt-generation.js';
import { runEngines, type WorkerEnginesEnv } from './engines.js';
import { seedBrand, type SeedBrandInput } from './core/seed.js';

export interface Env {
  OAUTH_KV: KVNamespace;
  DIGESTSEO_DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_PROVIDER: any;
  // Engine API keys are opt-in. Set only the ones you have; the rest of
  // the engines skip gracefully. See src/core/engines.ts:getAvailableEngines.
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  GEMINI_API_KEY?: string;
  SERPAPI_API_KEY?: string;
  // Shared secret gating /admin/* routes.
  SEED_SECRET: string;
  // Optional shared secret gating the OAuth /authorize auto-complete.
  // When set, anyone connecting an MCP client must type this secret
  // into a one-field browser form before a token is issued. When
  // unset, /authorize auto-completes for any client that knows the
  // worker URL — fine for private/obscure deployments, risky for
  // anything you've shared publicly (connected clients can call
  // refresh_brand, which spends your engine API credits).
  CONNECT_SECRET?: string;
  // Service binding back to this same worker. /admin/run-live fans out
  // by self-fetching /admin/run-engine once per engine via env.SELF.
  // A public-URL fetch back to the same hostname triggers Cloudflare's
  // "Worker called itself" guard (error 1042) and never reaches the
  // handler; service bindings route through Cloudflare's internal
  // fabric and bypass that guard. See wrangler.example.jsonc for the
  // matching "services" config.
  SELF: Fetcher;
  // Public URL of the deployed Worker. Cron path (no Request to
  // derive from) requires this; HTTP-triggered paths fall back to
  // `new URL(request.url).origin` when SELF_URL is missing. Set it to
  // your https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev (or custom
  // domain) after the first deploy.
  SELF_URL?: string;
  // Reserved for future use (e.g. a public /check endpoint). The OSS
  // build does not currently reference these but keeps them in scope so
  // forks can wire them up without changing the Env shape.
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

interface AgentProps extends Record<string, unknown> {
  user_id: string;
  email: string;
}

const DEV_USER_ID = 'dev-user';
const DEV_USER_EMAIL = 'dev@local';

// Everything the worker-side fan-out needs, derived from the worker Env
// plus a constructed Db. Spelled out (rather than spreading env) so the
// dependency surface stays visible.
function workerEnginesEnv(env: Env, db: Db): WorkerEnginesEnv {
  return {
    db,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: env.GEMINI_API_KEY,
    PERPLEXITY_API_KEY: env.PERPLEXITY_API_KEY,
    SERPAPI_API_KEY: env.SERPAPI_API_KEY,
    SEED_SECRET: env.SEED_SECRET,
    SELF: env.SELF,
    SELF_URL: env.SELF_URL,
  };
}

// Keep in sync with package.json "version".
const SERVER_VERSION = '0.3.2';

export class GeoMcpAgent extends McpAgent<Env, unknown, AgentProps> {
  server = new McpServer({
    name: 'digestseo-mcp',
    version: SERVER_VERSION,
  });

  async init() {
    const db = createD1Db(this.env.DIGESTSEO_DB);
    registerTools(
      this.server,
      {
        db,
        env: this.env,
        // Worker implementation of refresh_brand's engine dispatch:
        // per-engine fan-out via the SELF service binding so each engine
        // gets its own invocation (and its own 50-subrequest budget).
        runEnginesInline: (brand, prompts, engines) =>
          runEngines(
            workerEnginesEnv(this.env, db),
            this.ctx,
            brand,
            prompts,
            engines,
          ),
      },
      { namespaced: true },
    );
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Constant-time string comparison so the secret check doesn't leak
// match-prefix length through response timing. (Length inequality still
// short-circuits, which is fine — the length of a high-entropy secret
// is not useful to an attacker.)
function safeEquals(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function requireSeedSecret(request: Request, env: Env): Response | null {
  const provided = request.headers.get('X-Seed-Secret') ?? '';
  if (!env.SEED_SECRET || !safeEquals(provided, env.SEED_SECRET)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  return null;
}

async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function handleAdminSeed(
  request: Request,
  env: Env,
  db: Db,
): Promise<Response> {
  // Body shape:
  //   { "brand_id": "acme",
  //     "name": "Acme Project Tool",
  //     "domain": "acme.com",
  //     "category": "Project management software",
  //     "competitors": ["asana.com", "monday.com"] }
  // Empty body returns a clean no-op.
  const body = await readJsonBody<SeedBrandInput>(request);
  const result = await seedBrand(
    { db, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY },
    body,
  );
  return jsonResponse(result);
}

async function handleAdminRunLive(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  db: Db,
): Promise<Response> {
  const body = await readJsonBody<{
    brand_id?: string;
    engines?: string[];
  }>(request);
  const brandId = body?.brand_id;
  if (!brandId) {
    return jsonResponse({ error: 'brand_id required' }, 400);
  }
  const available = getAvailableEngines(env);
  if (available.length === 0) {
    return jsonResponse(
      {
        error:
          'no engines available — set at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, PERPLEXITY_API_KEY, SERPAPI_API_KEY',
      },
      400,
    );
  }
  let engineNames: EngineName[];
  if (Array.isArray(body?.engines) && body!.engines!.length > 0) {
    const unknown = body!.engines!.filter((e) => !isEngineName(e));
    if (unknown.length > 0) {
      return jsonResponse(
        {
          error: `Unknown engines: ${unknown.join(', ')}. Allowed: ${ALL_ENGINES.join(', ')}`,
        },
        400,
      );
    }
    engineNames = body!.engines! as EngineName[];
  } else {
    engineNames = available;
  }
  const brand = await db.getBrand(brandId);
  if (!brand) return jsonResponse({ error: 'brand not found' }, 404);
  const prompts = await db.getActivePrompts(brandId);
  if (prompts.length === 0) {
    return jsonResponse({ error: 'no active prompts for brand' }, 400);
  }
  // runEngines creates the run rows then HTTP-self-fetches
  // /admin/run-engine via env.SELF (service binding) so each engine
  // executes in its own worker invocation with its own 50-subrequest
  // budget. Passing `request` lets the orchestrator derive the
  // worker's own origin as a fallback when env.SELF_URL isn't set.
  const { run_ids, engines } = await runEngines(
    workerEnginesEnv(env, db),
    ctx,
    brand,
    prompts,
    engineNames,
    request,
  );
  return jsonResponse({
    run_ids,
    prompts_total: prompts.length,
    engines,
  });
}

async function handleAdminGeneratePrompts(
  request: Request,
  env: Env,
  db: Db,
): Promise<Response> {
  const body = await readJsonBody<{ brand_id?: string; count?: number }>(
    request,
  );
  const brandId = body?.brand_id;
  if (!brandId) {
    return jsonResponse({ error: 'brand_id required' }, 400);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse(
      {
        error:
          'ANTHROPIC_API_KEY not set — prompt generation requires Claude Haiku',
      },
      400,
    );
  }
  const count =
    typeof body?.count === 'number' && body.count > 0 && body.count <= 50
      ? body.count
      : 20;
  const brand = await db.getBrand(brandId);
  if (!brand) return jsonResponse({ error: 'brand not found' }, 404);
  try {
    const generated = await generatePrompts(
      { db, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY },
      brand,
      count,
    );
    return jsonResponse({
      brand_id: brand.id,
      prompts_inserted: generated.length,
      prompt_source: 'generated',
    });
  } catch (err) {
    console.error('handleAdminGeneratePrompts: generation failed', {
      brand_id: brand.id,
      message: (err as Error).message,
    });
    return jsonResponse(
      {
        error: 'prompt generation failed',
        message: (err as Error).message,
      },
      500,
    );
  }
}

async function handleAdminRunBatchSubmit(
  request: Request,
  env: Env,
  db: Db,
): Promise<Response> {
  const body = await readJsonBody<{ brand_id?: string }>(request);
  const brandId = body?.brand_id;
  if (!brandId) {
    return jsonResponse({ error: 'brand_id required' }, 400);
  }
  if (!env.OPENAI_API_KEY) {
    return jsonResponse(
      { error: 'OPENAI_API_KEY not set — batch submit requires OpenAI' },
      400,
    );
  }
  const brand = await db.getBrand(brandId);
  if (!brand) return jsonResponse({ error: 'brand not found' }, 404);
  const prompts = await db.getActivePrompts(brandId);
  if (prompts.length === 0) {
    return jsonResponse({ error: 'no active prompts for brand' }, 400);
  }
  const run = await db.createRun(brand, 'chatgpt', 'batch', prompts.length);
  const { batch_id } = await submitBatch(
    { db, OPENAI_API_KEY: env.OPENAI_API_KEY },
    brand,
    prompts,
    run.id,
  );
  return jsonResponse({ run_id: run.id, batch_id });
}

async function handleAdminRunBatchCollect(
  request: Request,
  env: Env,
  db: Db,
): Promise<Response> {
  const body = await readJsonBody<{ run_id?: string }>(request);
  const runId = body?.run_id;
  if (!runId) {
    return jsonResponse({ error: 'run_id required' }, 400);
  }
  if (!env.OPENAI_API_KEY) {
    return jsonResponse(
      { error: 'OPENAI_API_KEY not set — batch collect requires OpenAI' },
      400,
    );
  }
  const run = await db.getRunById(runId);
  if (!run) return jsonResponse({ error: 'run not found' }, 404);
  const brand = await db.getBrand(run.brand_id);
  if (!brand) return jsonResponse({ error: 'brand not found' }, 404);
  const prompts = await db.getActivePrompts(brand.id);
  const result = await collectBatch(
    { db, OPENAI_API_KEY: env.OPENAI_API_KEY },
    run,
    brand,
    prompts,
  );
  return jsonResponse({ run_id: run.id, ...result });
}

async function handleAdminTriggerCronTest(db: Db): Promise<Response> {
  const brandsDue = await db.getBrandsDueForRefresh();
  return jsonResponse({ brands_due_count: brandsDue.length });
}

// Single-engine execution. Called by runEngines() via env.SELF.fetch so
// each engine gets its own worker invocation and its own 50-subrequest
// budget. Idempotent: INSERT OR IGNOREs the runs row (the upstream
// run-live insert may not have replicated to this edge region yet —
// D1 is eventually consistent across regions, and a missing parent
// row makes persistEngineRun's batched insert fail with "FOREIGN KEY
// constraint failed"), then deletes any prior prompt_responses for the
// run_id before re-inserting, then dispatches the engine.
//
// Trust-the-body model: this route is X-Seed-Secret-gated and only
// ever called by the worker calling itself, so we deliberately do NOT
// re-query the runs row by id here. The brand row, by contrast, is
// stable and safe to read.
async function handleAdminRunEngine(
  request: Request,
  env: Env,
  db: Db,
): Promise<Response> {
  console.log('/admin/run-engine received', {
    method: request.method,
    path: new URL(request.url).pathname,
    has_seed_secret_header: Boolean(request.headers.get('X-Seed-Secret')),
  });
  const body = await readJsonBody<{
    run_id?: string;
    brand_id?: string;
    engine?: string;
  }>(request);
  const runId = body?.run_id;
  const brandId = body?.brand_id;
  const engine = body?.engine;
  if (!runId || !brandId || !engine) {
    console.log('/admin/run-engine returning 400', {
      reason: 'run_id, brand_id, engine all required',
    });
    return jsonResponse(
      { error: 'run_id, brand_id, engine all required' },
      400,
    );
  }
  if (!isEngineName(engine)) {
    console.log('/admin/run-engine returning 400', {
      reason: `unknown engine: ${engine}`,
    });
    return jsonResponse(
      {
        error: `Unknown engine: ${engine}. Allowed: ${ALL_ENGINES.join(', ')}`,
      },
      400,
    );
  }
  const brand = await db.getBrand(brandId);
  if (!brand) {
    console.log('/admin/run-engine returning 404', { reason: 'brand not found' });
    return jsonResponse({ error: 'brand not found' }, 404);
  }
  const prompts = await db.getActivePrompts(brandId);
  if (prompts.length === 0) {
    console.log('/admin/run-engine returning 400', {
      reason: 'no active prompts for brand',
    });
    return jsonResponse({ error: 'no active prompts for brand' }, 400);
  }
  // FK guard: prompt_responses.run_id REFERENCES runs(id). /admin/run-live
  // inserts the runs row in region A; this handler can land in region B
  // before D1 has replicated the row, causing persistEngineRun's batched
  // INSERT to fail with "FOREIGN KEY constraint failed" and drop all
  // prompt_responses rows on the floor. INSERT OR IGNORE makes the row
  // exist locally: if the upstream row has replicated, this is a no-op;
  // if not, we create the same row here. 'live' mode matches what
  // runEngines passes to createRun so the row shape is identical
  // either way.
  await env.DIGESTSEO_DB.prepare(
    `INSERT OR IGNORE INTO runs
       (id, brand_id, engine, mode, status, prompts_total,
        prompts_completed, started_at)
     VALUES (?, ?, ?, 'live', 'in_progress', ?, 0, ?)`,
  )
    .bind(runId, brandId, engine, prompts.length, Date.now())
    .run();
  // Idempotency: clear any prior rows for this run_id so a retry
  // produces exactly one row per prompt instead of duplicating them.
  await db.deleteResponsesForRun(runId);
  await runEngineInProcess(
    {
      db,
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: env.GEMINI_API_KEY,
      PERPLEXITY_API_KEY: env.PERPLEXITY_API_KEY,
      SERPAPI_API_KEY: env.SERPAPI_API_KEY,
    },
    brand,
    prompts,
    { engine, run_id: runId },
  );
  return jsonResponse({
    run_id: runId,
    engine,
    prompts_total: prompts.length,
  });
}

interface CleanupCounts {
  total_deleted: number;
  per_engine: Record<string, number>;
}

// One-shot cleanup of legacy polluted prompt_responses rows. New writes
// (post-0004-migration) use status='failed' instead of writing
// raw_response='ERROR: ...' — those rows are NOT touched here, since
// scoring already excludes them via the status filter.
async function handleAdminCleanupFailedRuns(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJsonBody<{ brand_id?: string }>(request);
  const brandId = body?.brand_id;

  const baseWhere =
    `(raw_response LIKE '%Too many subrequests%'
      OR raw_response LIKE 'ERROR:%'
      OR (raw_response = '' AND status = 'ok'))`;

  let countSql = `SELECT engine, COUNT(*) AS n FROM prompt_responses WHERE ${baseWhere}`;
  let deleteSql = `DELETE FROM prompt_responses WHERE ${baseWhere}`;
  const params: unknown[] = [];
  if (brandId) {
    const brandClause =
      ' AND prompt_id IN (SELECT id FROM prompts WHERE brand_id = ?)';
    countSql += brandClause;
    deleteSql += brandClause;
    params.push(brandId);
  }
  countSql += ' GROUP BY engine';

  const { results } = await env.DIGESTSEO_DB.prepare(countSql)
    .bind(...params)
    .all<{ engine: string; n: number }>();
  const counts: CleanupCounts = { total_deleted: 0, per_engine: {} };
  for (const row of results ?? []) {
    counts.per_engine[row.engine] = Number(row.n);
    counts.total_deleted += Number(row.n);
  }

  await env.DIGESTSEO_DB.prepare(deleteSql)
    .bind(...params)
    .run();

  return jsonResponse({
    cleaned: true,
    brand_id: brandId ?? null,
    ...counts,
  });
}

const defaultHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      if (request.method !== 'GET') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { Allow: 'GET' },
        });
      }
      return new Response(
        'digestseo-mcp — DigestSEO AI Visibility MCP server.\n' +
          'Connect this URL as a custom MCP connector in Claude.ai:\n' +
          `${url.origin}/mcp\n`,
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }

    if (url.pathname === '/healthz' && request.method === 'GET') {
      return new Response('ok', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const db = createD1Db(env.DIGESTSEO_DB);

    if (url.pathname === '/admin/seed' && request.method === 'POST') {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminSeed(request, env, db);
    }

    if (url.pathname === '/admin/run-live' && request.method === 'POST') {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminRunLive(request, env, ctx, db);
    }

    if (
      url.pathname === '/admin/run-batch-submit' &&
      request.method === 'POST'
    ) {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminRunBatchSubmit(request, env, db);
    }

    if (
      url.pathname === '/admin/run-batch-collect' &&
      request.method === 'POST'
    ) {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminRunBatchCollect(request, env, db);
    }

    if (
      url.pathname === '/admin/generate-prompts' &&
      request.method === 'POST'
    ) {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminGeneratePrompts(request, env, db);
    }

    if (
      url.pathname === '/admin/trigger-cron-test' &&
      request.method === 'POST'
    ) {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminTriggerCronTest(db);
    }

    if (url.pathname === '/admin/run-engine' && request.method === 'POST') {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminRunEngine(request, env, db);
    }

    if (
      url.pathname === '/admin/cleanup-failed-runs' &&
      request.method === 'POST'
    ) {
      const denied = requireSeedSecret(request, env);
      if (denied) return denied;
      return handleAdminCleanupFailedRuns(request, env);
    }

    if (url.pathname === '/authorize') {
      return handleAuthorize(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// One-field consent form shown when CONNECT_SECRET is set. The form
// POSTs back to /authorize with the original OAuth query string intact
// so parseAuthRequest sees the exact params the MCP client sent.
function renderConnectForm(query: string, error?: string): Response {
  const action = `/authorize${escapeHtml(query)}`;
  const errorHtml = error
    ? `<p class="err">${escapeHtml(error)}</p>`
    : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect &mdash; DigestSEO MCP</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1117; color: #e6e6e6;
         display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  main { max-width: 26rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: #9aa0ae; font-size: .9rem; line-height: 1.5; }
  .err { color: #f87171; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .75rem; margin: .75rem 0;
          border: 1px solid #2a2f3a; border-radius: 6px; background: #161a22; color: #e6e6e6; }
  button { width: 100%; padding: .6rem; border: 0; border-radius: 6px;
           background: #4f7df9; color: #fff; font-size: .95rem; cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>DigestSEO MCP</h1>
<p>This server requires a connect secret before an MCP client can be
authorized. Enter the <code>CONNECT_SECRET</code> you set during deploy.</p>
${errorHtml}
<form method="post" action="${action}">
  <input type="password" name="connect_secret" placeholder="Connect secret" autofocus required>
  <button type="submit">Authorize client</button>
</form>
</main>
</body>
</html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// Self-hosted OSS authorization. Without CONNECT_SECRET this
// auto-completes with a single local dev user so the Worker can be
// connected as a custom MCP connector without a real OAuth round trip.
// With CONNECT_SECRET set, the browser step of the OAuth flow shows a
// one-field form and only completes when the secret matches — anyone
// who merely knows the worker URL can no longer mint a token. Replace
// with Google/GitHub OAuth in a fork if you expose the Worker to
// multiple end-users.
async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const invalidRequest = () =>
    new Response(
      'Invalid OAuth authorization request. This endpoint is called by MCP clients during the connection flow, not directly in a browser.',
      {
        status: 400,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      },
    );

  // MCP clients always arrive with OAuth params; a bare browser visit
  // (or a scanner probe) gets a clean 400 instead of the connect form.
  if (!url.searchParams.has('client_id')) {
    return invalidRequest();
  }

  let authRequestSource = request;
  if (env.CONNECT_SECRET) {
    if (request.method === 'GET') {
      return renderConnectForm(url.search);
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, POST' },
      });
    }
    const form = await request.formData().catch(() => null);
    const provided = form?.get('connect_secret');
    if (
      typeof provided !== 'string' ||
      !safeEquals(provided, env.CONNECT_SECRET)
    ) {
      return renderConnectForm(
        url.search,
        'Wrong connect secret. Use the CONNECT_SECRET value you set with `wrangler secret put CONNECT_SECRET`.',
      );
    }
    // parseAuthRequest reads OAuth params from the URL query (preserved
    // verbatim by the form action); re-wrap as GET so the library sees
    // the canonical request shape rather than a form POST.
    authRequestSource = new Request(request.url, { method: 'GET' });
  }

  let claudeAuthRequest;
  try {
    claudeAuthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(
      authRequestSource,
    );
  } catch (err) {
    console.warn('Invalid /authorize request', {
      message: (err as Error).message,
    });
    return invalidRequest();
  }
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: claudeAuthRequest,
    userId: DEV_USER_ID,
    metadata: { email: DEV_USER_EMAIL },
    scope: claudeAuthRequest.scope,
    props: { user_id: DEV_USER_ID, email: DEV_USER_EMAIL },
  });
  return Response.redirect(redirectTo, 302);
}

const oauthProvider = new OAuthProvider({
  apiHandlers: {
    '/mcp': GeoMcpAgent.serve('/mcp'),
  },
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
});

export default {
  fetch: (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> => oauthProvider.fetch(request, env, ctx),
  // Cloudflare Cron Trigger. wrangler.jsonc sets the schedule to every
  // 6 hours; this handler checks each brand against its refresh_frequency
  // and dispatches runEngines only for brands that are actually due.
  scheduled: async (
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> => {
    if (!env.SELF_URL) {
      console.error(
        'scheduled trigger: env.SELF_URL is not set — cron cannot self-fetch /admin/run-engine. Set SELF_URL in wrangler.jsonc and redeploy.',
        { cron: event.cron },
      );
      return;
    }
    const available = getAvailableEngines(env);
    if (available.length === 0) {
      console.warn(
        'scheduled trigger: no engines available — set at least one engine API key',
        { cron: event.cron },
      );
      return;
    }
    const db = createD1Db(env.DIGESTSEO_DB);
    const brandsDue = await db.getBrandsDueForRefresh();
    console.log('scheduled trigger', {
      cron: event.cron,
      brands_due: brandsDue.length,
      engines: available,
    });
    if (brandsDue.length === 0) return;
    const results = await Promise.allSettled(
      brandsDue.map(async (brand) => {
        const prompts = await db.getActivePrompts(brand.id);
        if (prompts.length === 0) {
          return { brand_id: brand.id, skipped: true };
        }
        return runEngines(
          workerEnginesEnv(env, db),
          ctx,
          brand,
          prompts,
          available,
        );
      }),
    );
    const succeeded = results.filter(
      (r) => r.status === 'fulfilled',
    ).length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      for (const r of results) {
        if (r.status === 'rejected') {
          console.error('scheduled trigger: brand dispatch failed', {
            reason: String(r.reason),
          });
        }
      }
    }
    console.log('scheduled trigger complete', { succeeded, failed });
  },
};
