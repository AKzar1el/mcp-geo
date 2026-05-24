// Google Gemini runner. Live mode only — Gemini doesn't have a comparable
// batch API for chat completions. Uses the public Generative Language API
// (api key in URL, no Authorization header).

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

async function processSinglePrompt(
  env: GeminiEnv,
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
        requireGeminiKey(env),
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
    console.error('runLive[gemini]: prompt failed', {
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
  env: GeminiEnv,
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
    console.error('runLive[gemini]: run failed', {
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
