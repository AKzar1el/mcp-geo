// Per-engine HTTP fan-out across the 5 LLM/SERP engines. runEngines()
// creates one runs row per engine then fires one self-fetch per engine
// to /admin/run-engine, so each engine executes in its OWN worker
// invocation with its own 50-subrequest budget. A naive
// "Promise.all five engines in one invocation" exceeds the free-plan
// cap with ~100 LLM fetches and half the rows go missing.
//
// The self-fetch goes through env.SELF.fetch() — a Cloudflare service
// binding pointing this worker at itself. A public-URL fetch back to
// the same hostname triggers Cloudflare's "Worker called itself"
// guard (error code 1042) and never reaches the handler.

import {
  runLive as runLiveChatgpt,
  type OpenAiEnv,
} from './openai';
import {
  runLive as runLiveClaude,
  type AnthropicEnv,
} from './anthropic';
import {
  runLive as runLivePerplexity,
  type PerplexityEnv,
} from './perplexity';
import {
  runLive as runLiveGemini,
  type GeminiEnv,
} from './gemini';
import {
  runLive as runLiveAiOverviews,
  type AiOverviewsEnv,
} from './ai-overviews';
import { createRun, type Brand, type Prompt } from './db';

export const ALL_ENGINES = [
  'chatgpt',
  'claude',
  'perplexity',
  'gemini',
  'ai_overviews',
] as const;
export type EngineName = (typeof ALL_ENGINES)[number];

export function isEngineName(s: string): s is EngineName {
  return (ALL_ENGINES as readonly string[]).includes(s);
}

// Public OSS opt-in model: engines are enabled by the presence of their
// API key. Users only set credentials for the engines they want, and
// the rest are silently skipped. getAvailableEngines(env) is the
// canonical way to decide which engines to fan out to when no explicit
// list is passed.
export interface AvailabilityEnv {
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  SERPAPI_API_KEY?: string;
}

export function getAvailableEngines(env: AvailabilityEnv): EngineName[] {
  const engines: EngineName[] = [];
  if (env.OPENAI_API_KEY) engines.push('chatgpt');
  if (env.ANTHROPIC_API_KEY) engines.push('claude');
  if (env.GEMINI_API_KEY) engines.push('gemini');
  if (env.PERPLEXITY_API_KEY) engines.push('perplexity');
  if (env.SERPAPI_API_KEY) engines.push('ai_overviews');
  return engines;
}

export interface EnginesEnv
  extends OpenAiEnv,
    AnthropicEnv,
    PerplexityEnv,
    GeminiEnv,
    AiOverviewsEnv {
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

export interface EngineRun {
  engine: EngineName;
  run_id: string;
}

// Direct in-process dispatch used by /admin/run-engine. Each branch
// makes at most ~20 LLM/SERP fetches + the bulk D1 ops in db.ts'
// persistEngineRun — well under the 50-subrequest cap for a single
// worker invocation.
export async function runEngineInProcess(
  env: EnginesEnv,
  brand: Brand,
  prompts: Prompt[],
  engineRun: EngineRun,
): Promise<void> {
  switch (engineRun.engine) {
    case 'chatgpt':
      return runLiveChatgpt(env, brand, prompts, engineRun.run_id);
    case 'claude':
      return runLiveClaude(env, brand, prompts, engineRun.run_id);
    case 'perplexity':
      return runLivePerplexity(env, brand, prompts, engineRun.run_id);
    case 'gemini':
      return runLiveGemini(env, brand, prompts, engineRun.run_id);
    case 'ai_overviews':
      return runLiveAiOverviews(env, brand, prompts, engineRun.run_id);
  }
}

export interface RunEnginesResult {
  run_ids: Record<string, string>;
  engines: EngineName[];
}

// Structural type so both Worker fetch ExecutionContext and Durable
// Object DurableObjectState satisfy it (refresh_brand fires from
// inside the MCP Durable Object).
export interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

function resolveSelfUrl(env: EnginesEnv, request?: Request): string {
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
  env: EnginesEnv,
  ctx: WaitUntilCtx,
  brand: Brand,
  prompts: Prompt[],
  engineNames?: EngineName[],
  request?: Request,
): Promise<RunEnginesResult> {
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
    const run = await createRun(env, brand, engine, 'live', prompts.length);
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
