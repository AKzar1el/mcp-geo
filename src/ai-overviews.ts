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

export const MODEL = 'serpapi-google-ai-overview';
export const ENGINE = 'ai_overviews';
export const NO_AI_OVERVIEW = '[NO_AI_OVERVIEW]';

const LIVE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const SERPAPI_URL = 'https://serpapi.com/search.json';

export interface AiOverviewsEnv extends DbEnv {
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

async function processSinglePrompt(
  env: AiOverviewsEnv,
  brand: Brand,
  prompt: Prompt,
  runId: string,
): Promise<void> {
  try {
    const hash = await hashPrompt(prompt.text, ENGINE, MODEL);
    let payload: CachedPayload;
    const cached = await cacheGet(env, hash, ENGINE, MODEL);
    if (cached) {
      payload = unpackCached(cached.raw_response);
    } else {
      const completion = await chatCompletion(requireSerpApiKey(env), prompt.text);
      payload = { text: completion.text, citations: completion.citations };
      await cachePut(
        env,
        hash,
        ENGINE,
        MODEL,
        packCached(payload),
        LIVE_CACHE_TTL_SECONDS,
      );
    }

    // For the no-overview sentinel, write a structural row but don't try
    // to extract anything meaningful from it.
    if (payload.text === NO_AI_OVERVIEW && payload.citations.length === 0) {
      await insertPromptResponse(env, {
        run_id: runId,
        prompt_id: prompt.id,
        engine: ENGINE,
        raw_response: NO_AI_OVERVIEW,
        brand_mentioned: 0,
        brand_cited_with_link: 0,
        cited_urls: [],
        competitors_mentioned: [],
      });
      return;
    }

    const citations = extractCitations(brand, payload.text);
    const merged_cited = mergeUrls(citations.cited_urls, payload.citations);
    // Re-evaluate brand_cited_with_link against the merged URL set — a
    // reference URL pointing at brand.domain counts even when the text
    // doesn't markdown-link to it.
    const fullDomain = brand.domain.toLowerCase();
    const brandCitedWithLink =
      citations.brand_cited_with_link === 1 ||
      merged_cited.some((h) => h.includes(fullDomain))
        ? 1
        : 0;
    await insertPromptResponse(env, {
      run_id: runId,
      prompt_id: prompt.id,
      engine: ENGINE,
      raw_response: payload.text,
      brand_mentioned: citations.brand_mentioned,
      brand_cited_with_link: brandCitedWithLink,
      cited_urls: merged_cited,
      competitors_mentioned: citations.competitors_mentioned,
      engine_citations: payload.citations,
    });
  } catch (err) {
    console.error('runLive[ai_overviews]: prompt failed', {
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
  env: AiOverviewsEnv,
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
    console.error('runLive[ai_overviews]: run failed', {
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
