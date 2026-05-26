// Google Gemini runner. Live mode only — Gemini doesn't have a comparable
// batch API for chat completions. Uses the public Generative Language API
// (api key in URL, no Authorization header).

import {
  buildSystemPrompt,
  extractCitations,
  hashPrompt,
} from './openai';
import {
  bulkCacheGet,
  persistEngineRun,
  updateRun,
  type Brand,
  type DbEnv,
  type EnginePromptResult,
  type Prompt,
} from './db';

// gemini-2.5-flash-lite has the most generous free-tier daily quota
// across the 2.5 family. If you need more headroom, switch to
// gemini-2.5-flash (paid tier).
export const MODEL = 'gemini-2.5-flash-lite';
export const ENGINE = 'gemini';

const LIVE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const GEMINI_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiEnv extends DbEnv {
  GEMINI_API_KEY?: string;
}

function requireGeminiKey(env: GeminiEnv): string {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set');
  }
  return env.GEMINI_API_KEY;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

export async function chatCompletion(
  apiKey: string,
  userText: string,
  systemPrompt: string,
): Promise<string> {
  const url = `${GEMINI_BASE}/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 600,
      },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini completion failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as GeminiResponse;
  if (data.promptFeedback?.blockReason) {
    throw new Error(
      `Gemini blocked prompt: ${data.promptFeedback.blockReason}`,
    );
  }
  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw new Error('Gemini response missing candidates[0]');
  }
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(
      `Gemini finished with non-STOP reason: ${candidate.finishReason}`,
    );
  }
  const text = candidate.content?.parts?.[0]?.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Gemini response missing candidates[0].content.parts[0].text');
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
  console.error('runLive[gemini]: prompt failed', {
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
  env: GeminiEnv,
  brand: Brand,
  prompts: Prompt[],
  runId: string,
): Promise<void> {
  // Bulk pattern — see src/openai.ts:runLive. Gemini's free-tier
  // daily quota is very low (a handful of req/min); rate-limited
  // failures now produce status='failed' rows instead of being
  // silently dropped.
  const CONCURRENCY = 5;
  const hashes = await Promise.all(
    prompts.map((p) => hashPrompt(p.text, ENGINE, MODEL)),
  );

  if (!env.GEMINI_API_KEY) {
    const results = prompts.map(buildSkippedResult);
    await persistEngineRun(
      env,
      runId,
      ENGINE,
      MODEL,
      LIVE_CACHE_TTL_SECONDS,
      results,
    );
    return;
  }

  const cacheMap = await bulkCacheGet(env, hashes, ENGINE, MODEL);
  const results: EnginePromptResult[] = new Array(prompts.length);

  for (let i = 0; i < prompts.length; i += CONCURRENCY) {
    const chunkStart = i;
    const chunk = prompts.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (prompt, j) => {
        const idx = chunkStart + j;
        const hash = hashes[idx];
        const cached = cacheMap.get(hash);
        try {
          let responseText: string;
          let cacheToPut: EnginePromptResult['cache_to_put'];
          if (cached !== undefined) {
            responseText = cached;
          } else {
            responseText = await chatCompletion(
              requireGeminiKey(env),
              prompt.text,
              buildSystemPrompt(),
            );
            cacheToPut = { prompt_hash: hash, raw_response: responseText };
          }
          const citations = extractCitations(brand, responseText);
          results[idx] = {
            prompt_id: prompt.id,
            raw_response: responseText,
            brand_mentioned: citations.brand_mentioned,
            brand_cited_with_link: citations.brand_cited_with_link,
            cited_urls: citations.cited_urls,
            competitors_mentioned: citations.competitors_mentioned,
            status: 'ok',
            cache_to_put: cacheToPut,
          };
        } catch (err) {
          results[idx] = buildFailedResult(prompt, err);
        }
      }),
    );
  }

  try {
    await persistEngineRun(
      env,
      runId,
      ENGINE,
      MODEL,
      LIVE_CACHE_TTL_SECONDS,
      results,
    );
  } catch (err) {
    console.error('runLive[gemini]: persistEngineRun failed', {
      run_id: runId,
      message: (err as Error).message,
    });
    await updateRun(env, runId, {
      status: 'failed',
      error: (err as Error).message,
      completed_at: Date.now(),
    }).catch(() => {});
  }
}
