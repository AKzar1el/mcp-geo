// Google AI Overviews via SerpAPI. Mirrors perplexity.ts (engine-native
// citations alongside the answer text). No system prompt — SerpAPI is
// not an LLM; we're just reading Google's AI Overview block for the query.
//
// Many queries don't trigger an AI Overview at all. In that case we still
// write a prompt_response row (so the run is structurally complete) with
// raw_response='[NO_AI_OVERVIEW]'. extractCitations finds nothing useful in
// that sentinel and brand_mentioned stays 0; scoring naturally reflects
// "AI Overview rarely shows for this category" as a lower per-engine score.
//
// Cost: each SerpAPI call costs ~€0.005 on the lowest plan, ~€0.0015 on
// volume. 20 prompts × 1 brand = ~€0.10 per full multi-engine run.

import {
  extractCitations,
  hashPrompt,
} from './openai.js';
import type {
  Brand,
  Db,
  EnginePromptResult,
  Prompt,
} from '../db/types.js';

export const MODEL = 'serpapi-google-ai-overview';
export const ENGINE = 'ai_overviews';
export const NO_AI_OVERVIEW = '[NO_AI_OVERVIEW]';

const LIVE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const SERPAPI_URL = 'https://serpapi.com/search.json';

export interface AiOverviewsEnv {
  db: Db;
  SERPAPI_API_KEY?: string;
}

function requireSerpApiKey(env: AiOverviewsEnv): string {
  if (!env.SERPAPI_API_KEY) {
    throw new Error('SERPAPI_API_KEY not set');
  }
  return env.SERPAPI_API_KEY;
}

export interface AiOverviewCompletion {
  text: string;
  citations: string[];
}

interface SerpApiTextBlock {
  type?: string;
  snippet?: string;
  list?: Array<{ snippet?: string }>;
}

interface SerpApiReference {
  link?: string;
  source?: string;
  title?: string;
}

interface SerpApiAiOverview {
  text_blocks?: SerpApiTextBlock[];
  references?: SerpApiReference[];
}

interface SerpApiResponse {
  ai_overview?: SerpApiAiOverview;
  error?: string;
}

function flattenTextBlocks(blocks: SerpApiTextBlock[] | undefined): string {
  if (!blocks || blocks.length === 0) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block) continue;
    if (typeof block.snippet === 'string' && block.snippet.length > 0) {
      parts.push(block.snippet);
    }
    if (Array.isArray(block.list)) {
      for (const item of block.list) {
        if (item && typeof item.snippet === 'string' && item.snippet.length > 0) {
          parts.push('• ' + item.snippet);
        }
      }
    }
  }
  return parts.join('\n\n');
}

function flattenReferences(refs: SerpApiReference[] | undefined): string[] {
  if (!refs || refs.length === 0) return [];
  const out: string[] = [];
  for (const r of refs) {
    if (r && typeof r.link === 'string' && r.link.length > 0) {
      out.push(r.link);
    }
  }
  return out;
}

// SerpAPI doesn't take a system prompt — we're asking Google for an AI
// Overview, not asking an LLM to generate one.
export async function chatCompletion(
  apiKey: string,
  userText: string,
): Promise<AiOverviewCompletion> {
  const params = new URLSearchParams({
    api_key: apiKey,
    engine: 'google',
    q: userText,
    google_domain: 'google.com',
    gl: 'us',
    hl: 'en',
    no_cache: 'false',
  });
  const resp = await fetch(`${SERPAPI_URL}?${params.toString()}`, {
    method: 'GET',
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SerpAPI search failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as SerpApiResponse;
  if (typeof data.error === 'string' && data.error.length > 0) {
    throw new Error(`SerpAPI error: ${data.error}`);
  }
  const overview = data.ai_overview;
  if (!overview) {
    return { text: NO_AI_OVERVIEW, citations: [] };
  }
  const text = flattenTextBlocks(overview.text_blocks);
  const citations = flattenReferences(overview.references);
  if (text.length === 0 && citations.length === 0) {
    return { text: NO_AI_OVERVIEW, citations: [] };
  }
  return { text: text.length > 0 ? text : NO_AI_OVERVIEW, citations };
}

interface CachedPayload {
  text: string;
  citations: string[];
}

function packCached(payload: CachedPayload): string {
  return JSON.stringify(payload);
}

function unpackCached(raw: string): CachedPayload {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
      const citations = Array.isArray(parsed.citations)
        ? parsed.citations.filter((c: unknown): c is string => typeof c === 'string')
        : [];
      return { text: parsed.text, citations };
    }
  } catch {
    // fall through to legacy plain-text cache rows
  }
  return { text: raw, citations: [] };
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
  console.error('runLive[ai_overviews]: prompt failed', {
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

function buildResultFromPayload(
  brand: Brand,
  prompt: Prompt,
  payload: CachedPayload,
  cacheToPut?: EnginePromptResult['cache_to_put'],
): EnginePromptResult {
  // No-overview sentinel: "Google's AI Overview didn't trigger for this
  // prompt" is a legitimate signal, not an error. status stays 'ok' so
  // the row counts toward the per-engine total, but brand_mentioned=0
  // naturally drags the AI Overviews score down — accurate.
  if (payload.text === NO_AI_OVERVIEW && payload.citations.length === 0) {
    return {
      prompt_id: prompt.id,
      raw_response: NO_AI_OVERVIEW,
      brand_mentioned: 0,
      brand_cited_with_link: 0,
      cited_urls: [],
      competitors_mentioned: [],
      status: 'ok',
      cache_to_put: cacheToPut,
    };
  }
  const citations = extractCitations(brand, payload.text);
  const merged_cited = mergeUrls(citations.cited_urls, payload.citations);
  const fullDomain = brand.domain.toLowerCase();
  const brandCitedWithLink =
    citations.brand_cited_with_link === 1 ||
    merged_cited.some((h) => h.includes(fullDomain))
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
    cache_to_put: cacheToPut,
  };
}

export async function runLive(
  env: AiOverviewsEnv,
  brand: Brand,
  prompts: Prompt[],
  runId: string,
): Promise<void> {
  // Bulk pattern — see src/openai.ts:runLive. AI Overviews caches the
  // SerpAPI {text, citations} payload as JSON (see packCached), so
  // cacheToPut wraps that, not raw text.
  const CONCURRENCY = 5;
  const hashes = await Promise.all(
    prompts.map((p) => hashPrompt(p.text, ENGINE, MODEL)),
  );

  if (!env.SERPAPI_API_KEY) {
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

  const cacheMap = await env.db.bulkCacheGet(hashes, ENGINE, MODEL);
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
          let payload: CachedPayload;
          let cacheToPut: EnginePromptResult['cache_to_put'];
          if (cached !== undefined) {
            payload = unpackCached(cached);
          } else {
            const completion = await chatCompletion(
              requireSerpApiKey(env),
              prompt.text,
            );
            payload = {
              text: completion.text,
              citations: completion.citations,
            };
            cacheToPut = {
              prompt_hash: hash,
              raw_response: packCached(payload),
            };
          }
          results[idx] = buildResultFromPayload(
            brand,
            prompt,
            payload,
            cacheToPut,
          );
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
    console.error('runLive[ai_overviews]: persistEngineRun failed', {
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
