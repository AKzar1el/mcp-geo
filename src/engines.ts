// Worker-only per-engine HTTP fan-out across the 5 LLM/SERP engines.
// runEngines() creates one runs row per engine then fires one
// self-fetch per engine to /admin/run-engine, so each engine executes
// in its OWN worker invocation with its own 50-subrequest budget. A
// naive "Promise.all five engines in one invocation" exceeds the
// free-plan cap with ~100 LLM fetches and half the rows go missing.
//
// The self-fetch goes through env.SELF.fetch() — a Cloudflare service
// binding pointing this worker at itself. A public-URL fetch back to
// the same hostname triggers Cloudflare's "Worker called itself"
// guard (error code 1042) and never reaches the handler.
//
// The runtime-agnostic engine registry (ALL_ENGINES, availability,
// in-process dispatch) lives in src/core/engines.ts; the local CLI
// uses that directly and never touches this file.

import {
  getAvailableEngines,
  type EngineKeys,
  type EngineName,
  type EngineRun,
  type RunEnginesResult,
} from './core/engines.js';
import type { Brand, Db, Prompt } from './db/types.js';

export interface WorkerEnginesEnv extends EngineKeys {
  db: Db;
  SEED_SECRET: string;
  // Service binding back to this worker — see file header for why a
  // service binding is required (the public-URL fetch is blocked by
  // Cloudflare's 1042 self-call guard).
  SELF: Fetcher;
  // Public URL of the deployed Worker. Required by the cron handler
  // (no Request to derive an origin from); HTTP-triggered code paths
  // fall back to `new URL(request.url).origin` when SELF_URL is
  // missing.
  SELF_URL?: string;
}

// Structural type so both Worker fetch ExecutionContext and Durable
// Object DurableObjectState satisfy it (refresh_brand fires from
// inside the MCP Durable Object).
export interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export class PromptSnapshotIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptSnapshotIntegrityError';
  }
}

// Resolve the prompt snapshot captured before Worker fan-out. Prompt
// regeneration soft-deactivates old rows, so this must not use
// getActivePrompts(). Reconstructing from the requested IDs keeps engine
// execution order stable even if an adapter returns rows in another order.
export async function resolveRunPromptSnapshot(
  db: Db,
  brandId: string,
  promptIds: string[],
): Promise<Prompt[]> {
  const requestedIds = new Set(promptIds);
  if (requestedIds.size !== promptIds.length) {
    throw new PromptSnapshotIntegrityError('prompt_ids contains duplicates');
  }
  const resolved = await db.getPromptsByIds(promptIds);
  const byId = new Map(resolved.map((prompt) => [prompt.id, prompt]));
  const unexpected = resolved.filter((prompt) => !requestedIds.has(prompt.id));
  if (unexpected.length > 0) {
    throw new PromptSnapshotIntegrityError(
      `prompt lookup returned unexpected IDs: ${unexpected.map((prompt) => prompt.id).join(', ')}`,
    );
  }
  const missing = promptIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new PromptSnapshotIntegrityError(
      `prompt snapshot IDs not found: ${missing.join(', ')}`,
    );
  }
  const wrongBrand = promptIds.filter(
    (id) => byId.get(id)?.brand_id !== brandId,
  );
  if (wrongBrand.length > 0) {
    throw new PromptSnapshotIntegrityError(
      `prompt snapshot IDs do not belong to brand ${brandId}: ${wrongBrand.join(', ')}`,
    );
  }
  return promptIds.map((id) => byId.get(id)!);
}

function resolveSelfUrl(env: WorkerEnginesEnv, request?: Request): string {
  if (env.SELF_URL && env.SELF_URL.length > 0) {
    return env.SELF_URL.replace(/\/$/, '');
  }
  if (request) {
    return new URL(request.url).origin;
  }
  throw new Error(
    'runEngines: SELF_URL not set and no request available to derive origin — set env.SELF_URL in wrangler.jsonc',
  );
}

// When `engineNames` is undefined, fans out across every engine whose
// API key is configured. When it's provided, runs exactly that set
// (still subject to availability — a requested engine without a key is
// dropped with a console warning rather than crashing the whole run).
// Returns early with an empty result if no engines are available at
// all so callers can surface a clear error.
//
// Pass `request` from /admin/* handlers (we use its origin as a
// fallback for env.SELF_URL). Pass undefined from cron / Durable
// Object contexts and rely on env.SELF_URL.
export async function runEngines(
  env: WorkerEnginesEnv,
  ctx: WaitUntilCtx,
  brand: Brand,
  prompts: Prompt[],
  engineNames?: EngineName[],
  request?: Request,
): Promise<RunEnginesResult> {
  const promptIds = prompts.map((prompt) => prompt.id);
  const available = getAvailableEngines(env);
  const availableSet = new Set<EngineName>(available);
  const requested = engineNames ?? available;
  const filtered = requested.filter((e) => {
    if (availableSet.has(e)) return true;
    console.warn('runEngines: requested engine has no API key, skipping', {
      engine: e,
    });
    return false;
  });

  if (filtered.length === 0) {
    console.error(
      'runEngines: no engines available — set at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, PERPLEXITY_API_KEY, SERPAPI_API_KEY',
    );
    return { run_ids: {}, engines: [] };
  }

  const selfUrl = resolveSelfUrl(env, request);

  const engineRuns: EngineRun[] = [];
  for (const engine of filtered) {
    const run = await env.db.createRun(brand, engine, 'live', prompts.length);
    engineRuns.push({ engine, run_id: run.id });
  }

  ctx.waitUntil(
    Promise.allSettled(
      engineRuns.map(async (er) => {
        const url = `${selfUrl}/admin/run-engine`;
        const body = {
          run_id: er.run_id,
          brand_id: brand.id,
          engine: er.engine,
          prompt_ids: promptIds,
        };
        // env.SELF.fetch() routes through Cloudflare's internal
        // service-binding fabric so this call doesn't trip the
        // "Worker called itself" guard (1042) that blocks
        // fetch()-to-own-hostname. The URL is still needed because
        // Request requires a valid absolute URL; the binding routes
        // by pathname, so the host portion of the URL doesn't
        // actually need to resolve over public DNS.
        const response = await env.SELF.fetch(
          new Request(url, {
            method: 'POST',
            headers: {
              'X-Seed-Secret': env.SEED_SECRET,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          }),
        );
        // Useful for users debugging their own deploys — leaves a
        // trail in wrangler tail showing which engine completed
        // (and which didn't).
        console.log('runEngines: self-fetch response', {
          engine: er.engine,
          run_id: er.run_id,
          status: response.status,
        });
        return response;
      }),
    ).then((results) => {
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error('runEngines: self-fetch threw past its own try/catch', {
            engine: engineRuns[i].engine,
            run_id: engineRuns[i].run_id,
            reason: String(r.reason),
          });
        } else if (!r.value.ok) {
          console.error('runEngines: /admin/run-engine returned non-2xx', {
            engine: engineRuns[i].engine,
            run_id: engineRuns[i].run_id,
            status: r.value.status,
          });
        }
      });
    }),
  );

  const run_ids: Record<string, string> = {};
  for (const er of engineRuns) run_ids[er.engine] = er.run_id;
  return { run_ids, engines: filtered };
}
