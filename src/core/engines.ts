// Runtime-agnostic engine registry: which engines exist, which are
// enabled by the configured API keys, and how to execute one engine
// in-process. The Worker-only fan-out (service-binding self-fetch per
// engine) lives in src/engines.ts; the local CLI runs engines inline
// and sequentially via runEngineInProcess.

import {
  runLive as runLiveChatgpt,
  type OpenAiEnv,
} from './openai.js';
import {
  runLive as runLiveClaude,
  type AnthropicEnv,
} from './anthropic.js';
import {
  runLive as runLivePerplexity,
  type PerplexityEnv,
} from './perplexity.js';
import {
  runLive as runLiveGemini,
  type GeminiEnv,
} from './gemini.js';
import {
  runLive as runLiveAiOverviews,
  type AiOverviewsEnv,
} from './ai-overviews.js';
import type { Brand, Prompt } from '../db/types.js';

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
export interface EngineKeys {
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  SERPAPI_API_KEY?: string;
}

export function getAvailableEngines(env: EngineKeys): EngineName[] {
  const engines: EngineName[] = [];
  if (env.OPENAI_API_KEY) engines.push('chatgpt');
  if (env.ANTHROPIC_API_KEY) engines.push('claude');
  if (env.GEMINI_API_KEY) engines.push('gemini');
  if (env.PERPLEXITY_API_KEY) engines.push('perplexity');
  if (env.SERPAPI_API_KEY) engines.push('ai_overviews');
  return engines;
}

// Everything a single engine execution needs: the Db plus the engine
// API keys. Satisfied by both the Worker deps and the CLI deps.
export interface CoreEnginesEnv
  extends OpenAiEnv,
    AnthropicEnv,
    PerplexityEnv,
    GeminiEnv,
    AiOverviewsEnv {}

export interface EngineRun {
  engine: EngineName;
  run_id: string;
}

// Direct in-process dispatch. On the Worker this is invoked once per
// engine via /admin/run-engine (each invocation gets its own
// 50-subrequest budget); on the CLI it's simply called in a loop.
export async function runEngineInProcess(
  env: CoreEnginesEnv,
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
