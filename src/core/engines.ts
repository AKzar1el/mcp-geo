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
import {
  runLive as runLiveGrok,
  type XAiEnv,
} from './xai.js';
import {
  runLive as runLiveAiMode,
  type AiModeEnv,
} from './ai-mode.js';
import type { Brand, Prompt } from '../db/types.js';

export const ALL_ENGINES = [
  'chatgpt',
  'claude',
  'perplexity',
  'gemini',
  'grok',
  'ai_overviews',
  'ai_mode',
] as const;
export type EngineName = (typeof ALL_ENGINES)[number];

export function isEngineName(s: string): s is EngineName {
  return (ALL_ENGINES as readonly string[]).includes(s);
}

export function uniqueEngineNames(
  engines: readonly EngineName[],
): EngineName[] {
  return [...new Set(engines)];
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
  XAI_API_KEY?: string;
  SERPAPI_API_KEY?: string;
  SERPAPI_AI_MODE_ENABLED?: string;
}

function hasConfiguredKey(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function getAvailableEngines(env: EngineKeys): EngineName[] {
  const engines: EngineName[] = [];
  if (hasConfiguredKey(env.OPENAI_API_KEY)) engines.push('chatgpt');
  if (hasConfiguredKey(env.ANTHROPIC_API_KEY)) engines.push('claude');
  if (hasConfiguredKey(env.GEMINI_API_KEY)) engines.push('gemini');
  if (hasConfiguredKey(env.PERPLEXITY_API_KEY)) engines.push('perplexity');
  if (hasConfiguredKey(env.XAI_API_KEY)) engines.push('grok');
  const serpApiConfigured = hasConfiguredKey(env.SERPAPI_API_KEY);
  if (serpApiConfigured) engines.push('ai_overviews');
  if (
    serpApiConfigured &&
    /^(1|true|yes|on)$/i.test(env.SERPAPI_AI_MODE_ENABLED?.trim() ?? '')
  ) {
    engines.push('ai_mode');
  }
  return engines;
}

// Everything a single engine execution needs: the Db plus the engine
// API keys. Satisfied by both the Worker deps and the CLI deps.
export interface CoreEnginesEnv
  extends OpenAiEnv,
    AnthropicEnv,
    PerplexityEnv,
    GeminiEnv,
    XAiEnv,
    AiOverviewsEnv,
    AiModeEnv {}

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
  // Explicit engine selections bypass getAvailableEngines. Normalize blank
  // credentials here too, so adapters persist skipped evidence instead of
  // making requests with unusable Authorization headers.
  const providerEnv: CoreEnginesEnv = {
    ...env,
    OPENAI_API_KEY: hasConfiguredKey(env.OPENAI_API_KEY) ? env.OPENAI_API_KEY : undefined,
    ANTHROPIC_API_KEY: hasConfiguredKey(env.ANTHROPIC_API_KEY) ? env.ANTHROPIC_API_KEY : undefined,
    GEMINI_API_KEY: hasConfiguredKey(env.GEMINI_API_KEY) ? env.GEMINI_API_KEY : undefined,
    PERPLEXITY_API_KEY: hasConfiguredKey(env.PERPLEXITY_API_KEY) ? env.PERPLEXITY_API_KEY : undefined,
    XAI_API_KEY: hasConfiguredKey(env.XAI_API_KEY) ? env.XAI_API_KEY : undefined,
    SERPAPI_API_KEY: hasConfiguredKey(env.SERPAPI_API_KEY) ? env.SERPAPI_API_KEY : undefined,
  };
  switch (engineRun.engine) {
    case 'chatgpt':
      return runLiveChatgpt(providerEnv, brand, prompts, engineRun.run_id);
    case 'claude':
      return runLiveClaude(providerEnv, brand, prompts, engineRun.run_id);
    case 'perplexity':
      return runLivePerplexity(providerEnv, brand, prompts, engineRun.run_id);
    case 'gemini':
      return runLiveGemini(providerEnv, brand, prompts, engineRun.run_id);
    case 'grok':
      return runLiveGrok(providerEnv, brand, prompts, engineRun.run_id);
    case 'ai_overviews':
      return runLiveAiOverviews(providerEnv, brand, prompts, engineRun.run_id);
    case 'ai_mode':
      return runLiveAiMode(providerEnv, brand, prompts, engineRun.run_id);
  }
}

export interface RunEnginesResult {
  run_ids: Record<string, string>;
  engines: EngineName[];
}
