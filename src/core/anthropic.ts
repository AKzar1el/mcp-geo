// Anthropic Claude runner. Mirrors src/openai.ts. Live mode only; the
// Anthropic Batch API is not used here.

import {
  buildSystemPrompt,
  extractCitations,
} from './openai.js';
import type {
  Brand,
  Db,
  EnginePromptResult,
  Prompt,
} from '../db/types.js';

export const MODEL = 'claude-haiku-4-5';
export const ENGINE = 'claude';

const LIVE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicEnv {
  db: Db;
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

function truncateError(msg: string): string {
  return msg.length > 500 ? msg.slice(0, 500) : msg;
}

function buildSkippedResult(prompt: Prompt): EnginePromptResult {
  return {
    prompt_id: prompt.id,
    raw_response: '',
    brand_mentioned: 0,
    brand_cited_with_link: 0,
    cited_urls: [],
    competitors_mentioned: [],
    status: 'skipped',
    error_message: 'no API key configured',
  };
}

function buildFailedResult(prompt: Prompt, err: unknown): EnginePromptResult {
  const msg = (err as Error).message;
  console.error('runLive[claude]: prompt failed', {
    prompt_id: prompt.id,
    message: msg,
  });
  return {
    prompt_id: prompt.id,
    raw_response: '',
    brand_mentioned: 0,
    brand_cited_with_link: 0,
    cited_urls: [],
    competitors_mentioned: [],
    status: 'failed',
    error_message: truncateError(msg),
  };
}

export async function runLive(
  env: AnthropicEnv,
  brand: Brand,
  prompts: Prompt[],
  runId: string,
): Promise<void> {
  // Bulk pattern — see src/openai.ts:runLive for the rationale.
  const CONCURRENCY = 5;

  if (!env.ANTHROPIC_API_KEY) {
    const results = prompts.map(buildSkippedResult);
    await env.db.persistEngineRun(
      runId,
      ENGINE,
      MODEL,
      LIVE_CACHE_TTL_SECONDS,
      results,
    );
    return;
  }

  const results: EnginePromptResult[] = new Array(prompts.length);

  for (let i = 0; i < prompts.length; i += CONCURRENCY) {
    const chunkStart = i;
    const chunk = prompts.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (prompt, j) => {
        const idx = chunkStart + j;
        try {
          const responseText = await chatCompletion(
            requireAnthropicKey(env),
            prompt.text,
            buildSystemPrompt(),
          );
          const citations = extractCitations(brand, responseText);
          results[idx] = {
            prompt_id: prompt.id,
            raw_response: responseText,
            brand_mentioned: citations.brand_mentioned,
            brand_cited_with_link: citations.brand_cited_with_link,
            cited_urls: citations.cited_urls,
            competitors_mentioned: citations.competitors_mentioned,
            status: 'ok',
          };
        } catch (err) {
          results[idx] = buildFailedResult(prompt, err);
        }
      }),
    );
  }

  try {
    await env.db.persistEngineRun(
      runId,
      ENGINE,
      MODEL,
      LIVE_CACHE_TTL_SECONDS,
      results,
    );
  } catch (err) {
    console.error('runLive[claude]: persistEngineRun failed', {
      run_id: runId,
      message: (err as Error).message,
    });
    await env.db.updateRun(runId, {
      status: 'failed',
      error: (err as Error).message,
      completed_at: Date.now(),
    }).catch(() => {});
  }
}
