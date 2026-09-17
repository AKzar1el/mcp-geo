// Perplexity Sonar runner. Live mode only (no Perplexity batch API).
// Captures the engine-native citations array Perplexity returns alongside
// the answer text — those URLs are explicit sources Perplexity grounded
// its answer on, so we keep them in addition to whatever extractCitations
// finds in the response body.

import {
  buildSystemPrompt,
  extractCitations,
  hostMatchesDomain,
} from './openai.js';
import type {
  Brand,
  Db,
  EnginePromptResult,
  Prompt,
} from '../db/types.js';

export const MODEL = 'perplexity/sonar';
export const ENGINE = 'perplexity';

const LIVE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const PERPLEXITY_URL = 'https://api.perplexity.ai/v1/agent';

export interface PerplexityEnv {
  db: Db;
  PERPLEXITY_API_KEY?: string;
}

function requirePerplexityKey(env: PerplexityEnv): string {
  if (!env.PERPLEXITY_API_KEY) {
    throw new Error('PERPLEXITY_API_KEY not set');
  }
  return env.PERPLEXITY_API_KEY;
}

interface PerplexityMessageOutput {
  type: 'message';
  content?: Array<{ type?: string; text?: unknown }>;
}

interface PerplexitySearchResultsOutput {
  type: 'search_results';
  results?: Array<{ url?: unknown }>;
}

type PerplexityOutput =
  | PerplexityMessageOutput
  | PerplexitySearchResultsOutput
  | { type?: string; [key: string]: unknown };

interface PerplexityResponse {
  status?: string;
  error?: unknown;
  output?: PerplexityOutput[];
}

export interface PerplexityCompletion {
  text: string;
  citations: string[];
}

function extractAgentText(data: PerplexityResponse): string {
  const chunks: string[] = [];
  for (const item of data.output ?? []) {
    if (item.type !== 'message' || !('content' in item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part.type === 'output_text' && typeof part.text === 'string') {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join('');
}

function extractAgentCitations(data: PerplexityResponse): string[] {
  const urls: string[] = [];
  for (const item of data.output ?? []) {
    if (
      item.type !== 'search_results' ||
      !('results' in item) ||
      !Array.isArray(item.results)
    ) continue;
    for (const result of item.results) {
      if (typeof result.url === 'string') urls.push(result.url);
    }
  }
  return urls;
}

function describeAgentError(data: PerplexityResponse): string {
  if (typeof data.error === 'string') return data.error;
  if (data.error && typeof data.error === 'object') {
    try {
      return JSON.stringify(data.error);
    } catch {}
  }
  return 'unknown error';
}

export async function chatCompletion(
  apiKey: string,
  userText: string,
  systemPrompt: string,
): Promise<PerplexityCompletion> {
  const resp = await fetch(PERPLEXITY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
      tools: [{ type: 'web_search' }],
      tool_choice: { type: 'web_search' },
      temperature: 0.3,
      max_output_tokens: 600,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Perplexity Agent API failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as PerplexityResponse;
  if (data.status !== 'completed') {
    throw new Error(
      'Perplexity Agent API status ' +
        (data.status ?? 'unknown') +
        ': ' +
        describeAgentError(data),
    );
  }
  const text = extractAgentText(data);
  if (text.length === 0) {
    throw new Error('Perplexity Agent API response missing output_text');
  }
  const citations = extractAgentCitations(data);
  return { text, citations };
}

function normalizeHost(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host || null;
  } catch {
    return null;
  }
}

function mergeUrls(extracted: string[], engineCitations: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const url of [...extracted, ...engineCitations]) {
    const host = normalizeHost(url) ?? url.toLowerCase();
    if (seen.has(host)) continue;
    seen.add(host);
    merged.push(host);
    if (merged.length >= 30) break;
  }
  return merged;
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
  console.error('runLive[perplexity]: prompt failed', {
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

function buildOkResult(
  brand: Brand,
  prompt: Prompt,
  payload: PerplexityCompletion,
): EnginePromptResult {
  const citations = extractCitations(brand, payload.text);
  const merged_cited = mergeUrls(citations.cited_urls, payload.citations);
  const brandCitedWithLink =
    citations.brand_cited_with_link === 1 ||
    merged_cited.some((h) => hostMatchesDomain(h, brand.domain))
      ? 1
      : 0;
  return {
    prompt_id: prompt.id,
    raw_response: payload.text,
    brand_mentioned: citations.brand_mentioned,
    brand_cited_with_link: brandCitedWithLink,
    cited_urls: merged_cited,
    competitors_mentioned: citations.competitors_mentioned,
    engine_citations: payload.citations,
    status: 'ok',
  };
}

export async function runLive(
  env: PerplexityEnv,
  brand: Brand,
  prompts: Prompt[],
  runId: string,
): Promise<void> {
  // Bound provider calls while writing every fresh response in one final
  // batch. Perplexity citations are persisted alongside each response.
  const CONCURRENCY = 5;

  if (!env.PERPLEXITY_API_KEY) {
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
          const payload = await chatCompletion(
            requirePerplexityKey(env),
            prompt.text,
            buildSystemPrompt(),
          );
          results[idx] = buildOkResult(brand, prompt, payload);
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
    console.error('runLive[perplexity]: persistEngineRun failed', {
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
