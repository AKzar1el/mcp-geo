// Unified fan-out across the 5 LLM/SERP engines. Each engine runs its
// own runLive() against the same prompt set, in its own run row, in
// parallel. One engine failing does not affect the others
// (Promise.allSettled).

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
// API key. Users only set credentials for the engines they want, and the
// rest are silently skipped. getAvailableEngines(env) is the canonical
// way to decide which engines to fan out to when no explicit list is
// passed.
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
    AiOverviewsEnv {}

export interface EngineRun {
  engine: EngineName;
  run_id: string;
}

async function runOneEngine(
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

// Structural type so both Worker fetch ExecutionContext and Durable Object
// DurableObjectState satisfy it (refresh_brand fires from inside the MCP
// Durable Object).
export interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

// When `engineNames` is undefined, fans out across every engine whose
// API key is configured. When it's provided, runs exactly that set
// (still subject to availability — a requested engine without a key is
// dropped with a console warning rather than crashing the whole run).
// Returns early with an empty result if no engines are available at all
// so callers can surface a clear error.
export async function runEngines(
  env: EnginesEnv,
  ctx: WaitUntilCtx,
  brand: Brand,
  prompts: Prompt[],
  engineNames?: EngineName[],
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

  const engineRuns: EngineRun[] = [];
  for (const engine of filtered) {
    const run = await createRun(env, brand, engine, 'live', prompts.length);
    engineRuns.push({ engine, run_id: run.id });
  }

  ctx.waitUntil(
    Promise.allSettled(
      engineRuns.map((er) => runOneEngine(env, brand, prompts, er)),
    ).then((results) => {
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error('runEngines: engine threw past its own try/catch', {
            engine: engineRuns[i].engine,
            run_id: engineRuns[i].run_id,
            reason: String(r.reason),
          });
        }
      });
    }),
  );

  const run_ids: Record<string, string> = {};
  for (const er of engineRuns) run_ids[er.engine] = er.run_id;
  return { run_ids, engines: filtered };
}
