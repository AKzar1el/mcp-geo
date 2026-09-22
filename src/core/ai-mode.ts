// Google AI Mode via SerpAPI. This is a distinct search surface from
// Google AI Overviews and is opt-in because enabling it adds one SerpAPI
// request per prompt. SERPAPI_AI_MODE_ENABLED must be truthy in addition
// to SERPAPI_API_KEY before the engine is included in automatic refreshes.

import { extractCitations, hostMatchesDomain } from './openai.js';
import type { Brand, Db, EnginePromptResult, Prompt } from '../db/types.js';
import { fetchWithTimeout } from './fetch.js';

export const MODEL = 'serpapi-google-ai-mode';
export const ENGINE = 'ai_mode';

const LIVE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const SERPAPI_URL = 'https://serpapi.com/search.json';

export interface AiModeEnv {
  db: Db;
  SERPAPI_API_KEY?: string;
  SERPAPI_AI_MODE_ENABLED?: string;
}

export interface AiModeCompletion {
  text: string;
  citations: string[];
}

interface SerpApiTextBlock {
  snippet?: string;
  text?: string;
  list?: Array<{ snippet?: string; text?: string }>;
}

interface SerpApiReference {
  link?: string;
}

interface SerpApiAiModeResponse {
  text_blocks?: SerpApiTextBlock[];
  references?: SerpApiReference[];
  reconstructed_markdown?: string;
  error?: string;
}

function requireSerpApiKey(env: AiModeEnv): string {
  if (!env.SERPAPI_API_KEY) throw new Error('SERPAPI_API_KEY not set');
  return env.SERPAPI_API_KEY;
}

function flattenTextBlocks(blocks: SerpApiTextBlock[] | undefined): string {
  if (!blocks || blocks.length === 0) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    const text = block?.snippet ?? block?.text;
    if (typeof text === 'string' && text.trim().length > 0) {
      parts.push(text.trim());
    }
    if (Array.isArray(block?.list)) {
      for (const item of block.list) {
        const itemText = item?.snippet ?? item?.text;
        if (typeof itemText === 'string' && itemText.trim().length > 0) {
          parts.push(`- ${itemText.trim()}`);
        }
      }
    }
  }
  return parts.join('\n\n');
}

function flattenReferences(refs: SerpApiReference[] | undefined): string[] {
  if (!refs || refs.length === 0) return [];
  return refs
    .map((ref) => ref?.link)
    .filter((link): link is string => typeof link === 'string' && link.length > 0);
}

export async function chatCompletion(
  apiKey: string,
  userText: string,
): Promise<AiModeCompletion> {
  const params = new URLSearchParams({
    api_key: apiKey,
    engine: 'google_ai_mode',
    q: userText,
    gl: 'us',
    hl: 'en',
    no_cache: 'true',
  });
  const resp = await fetchWithTimeout(`${SERPAPI_URL}?${params.toString()}`, { method: 'GET' });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`SerpAPI AI Mode search failed: ${resp.status} ${body}`);
  }
  const data = (await resp.json()) as SerpApiAiModeResponse;
  if (typeof data.error === 'string' && data.error.length > 0) {
    throw new Error(`SerpAPI AI Mode error: ${data.error}`);
  }

  const reconstructed = data.reconstructed_markdown?.trim() ?? '';
  const text = reconstructed.length > 0 ? reconstructed : flattenTextBlocks(data.text_blocks);
  const citations = flattenReferences(data.references);
  if (text.length === 0 && citations.length === 0) {
    throw new Error('SerpAPI AI Mode returned no usable content');
  }
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

function buildSkippedResult(prompt: Prompt, reason: string): EnginePromptResult {
  return {
    prompt_id: prompt.id,
    raw_response: '',
    brand_mentioned: 0,
    brand_cited_with_link: 0,
    cited_urls: [],
    competitors_mentioned: [],
    status: 'skipped',
    error_message: reason,
  };
}

function buildFailedResult(prompt: Prompt, err: unknown): EnginePromptResult {
  const message = (err as Error).message;
  console.error('runLive[ai_mode]: prompt failed', {
    prompt_id: prompt.id,
    message,
  });
  return {
    prompt_id: prompt.id,
    raw_response: '',
    brand_mentioned: 0,
    brand_cited_with_link: 0,
    cited_urls: [],
    competitors_mentioned: [],
    status: 'failed',
    error_message: truncateError(message),
  };
}

function buildResultFromPayload(
  brand: Brand,
  prompt: Prompt,
  payload: AiModeCompletion,
): EnginePromptResult {
  const citations = extractCitations(brand, payload.text);
  const mergedCited = mergeUrls(citations.cited_urls, payload.citations);
  const brandCitedWithLink =
    citations.brand_cited_with_link === 1 ||
    mergedCited.some((host) => hostMatchesDomain(host, brand.domain))
      ? 1
      : 0;
  return {
    prompt_id: prompt.id,
    raw_response: payload.text,
    brand_mentioned: citations.brand_mentioned,
    brand_cited_with_link: brandCitedWithLink,
    cited_urls: mergedCited,
    competitors_mentioned: citations.competitors_mentioned,
    engine_citations: payload.citations,
    status: 'ok',
  };
}

export async function runLive(
  env: AiModeEnv,
  brand: Brand,
  prompts: Prompt[],
  runId: string,
): Promise<void> {
  const CONCURRENCY = 5;
  const aiModeEnabled = /^(1|true|yes|on)$/i.test(
    env.SERPAPI_AI_MODE_ENABLED?.trim() ?? '',
  );
  if (!env.SERPAPI_API_KEY || !aiModeEnabled) {
    const reason = !env.SERPAPI_API_KEY
      ? 'no API key configured'
      : 'SERPAPI_AI_MODE_ENABLED is not enabled';
    await env.db.persistEngineRun(
      runId,
      ENGINE,
      MODEL,
      LIVE_CACHE_TTL_SECONDS,
      prompts.map((prompt) => buildSkippedResult(prompt, reason)),
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
          const payload = await chatCompletion(requireSerpApiKey(env), prompt.text);
          results[idx] = buildResultFromPayload(brand, prompt, payload);
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
    console.error('runLive[ai_mode]: persistEngineRun failed', {
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

