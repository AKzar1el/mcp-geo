// Anthropic Claude runner. Mirrors src/openai.ts. Live mode only; the
// Anthropic Batch API path is Day 5 cleanup.

import {
  buildSystemPrompt,
  extractCitations,
  hashPrompt,
} from './openai';
import {
  cacheGet,
  cachePut,
  insertPromptResponse,
  updateRun,
  type Brand,
  type DbEnv,
  type Prompt,
} from './db';

export const MODEL = 'claude-haiku-4-5';
export const ENGINE = 'claude';

const LIVE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicEnv extends DbEnv {
  ANTHROPIC_API_KEY?: string;
}

function requireAnthropicKey(env: AnthropicEnv): string {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }
  return env.ANTHROPIC_API_KEY;
}

interface AnthropicMessageResponse {
  content?: Array<{ type?: string; text?: string }>;
}

export async function chatCompletion(
  apiKey: string,
  userText: string,
  systemPrompt: string,
  maxTokens: number = 600,
): Promise<string> {
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic completion failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as AnthropicMessageResponse;
  const textBlock = data.content?.find((b) => b.type === 'text');
  const text = textBlock?.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Anthropic response missing text content block');
  }
  return text;
}

async function processSinglePrompt(
  env: AnthropicEnv,
  brand: Brand,
  prompt: Prompt,
  runId: string,
): Promise<void> {
  try {
    const hash = await hashPrompt(prompt.text, ENGINE, MODEL);
    let responseText: string;
    const cached = await cacheGet(env, hash, ENGINE, MODEL);
    if (cached) {
      responseText = cached.raw_response;
    } else {
      responseText = await chatCompletion(
        requireAnthropicKey(env),
        prompt.text,
        buildSystemPrompt(),
      );
      await cachePut(
        env,
        hash,
        ENGINE,
        MODEL,
        responseText,
        LIVE_CACHE_TTL_SECONDS,
      );
    }
    const citations = extractCitations(brand, responseText);
    await insertPromptResponse(env, {
      run_id: runId,
      prompt_id: prompt.id,
      engine: ENGINE,
      raw_response: responseText,
      brand_mentioned: citations.brand_mentioned,
      brand_cited_with_link: citations.brand_cited_with_link,
      cited_urls: citations.cited_urls,
      competitors_mentioned: citations.competitors_mentioned,
    });
  } catch (err) {
    console.error('runLive[claude]: prompt failed', {
      run_id: runId,
      prompt_id: prompt.id,
      message: (err as Error).message,
    });
    await insertPromptResponse(env, {
      run_id: runId,
      prompt_id: prompt.id,
      engine: ENGINE,
      raw_response: `ERROR: ${(err as Error).message}`,
      brand_mentioned: 0,
      brand_cited_with_link: 0,
      cited_urls: [],
      competitors_mentioned: [],
    });
  }
}

export async function runLive(
  env: AnthropicEnv,
  brand: Brand,
  prompts: Prompt[],
  runId: string,
): Promise<void> {
  const CONCURRENCY = 5;
  let completed = 0;
  try {
    for (let i = 0; i < prompts.length; i += CONCURRENCY) {
      const chunk = prompts.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        chunk.map((prompt) => processSinglePrompt(env, brand, prompt, runId)),
      );
      completed += chunk.length;
      await updateRun(env, runId, { prompts_completed: completed });
    }
    await updateRun(env, runId, {
      status: 'completed',
      completed_at: Date.now(),
      prompts_completed: completed,
    });
  } catch (err) {
    console.error('runLive[claude]: run failed', {
      run_id: runId,
      message: (err as Error).message,
    });
    await updateRun(env, runId, {
      status: 'failed',
      error: (err as Error).message,
      completed_at: Date.now(),
    });
  }
}
