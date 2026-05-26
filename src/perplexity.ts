// Perplexity Sonar runner. Live mode only (no Perplexity batch API).
// Captures the engine-native citations array Perplexity returns alongside
// the answer text — those URLs are explicit sources Perplexity grounded
// its answer on, so we keep them in addition to whatever extractCitations
// finds in the response body.

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

export const MODEL = 'sonar';
export const ENGINE = 'perplexity';

const LIVE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

export interface PerplexityEnv extends DbEnv {
  PERPLEXITY_API_KEY?: string;
}

function requirePerplexityKey(env: PerplexityEnv): string {
  if (!env.PERPLEXITY_API_KEY) {
    throw new Error('PERPLEXITY_API_KEY not set');
  }
  return env.PERPLEXITY_API_KEY;
}

interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: unknown;
}

export interface PerplexityCompletion {
  text: string;
  citations: string[];
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
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
      temperature: 0.3,
      max_tokens: 600,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Perplexity completion failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as PerplexityResponse;
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Perplexity response missing choices[0].message.content');
  }
  const citations = Array.isArray(data.citations)
    ? data.citations.filter((c): c is string => typeof c === 'string')
    : [];
  return { text, citations };
}

// Cache value packs text + citations so cache hits don't lose the
// engine-native URLs. Stored as JSON in the existing raw_response column.
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
    // fall through to legacy behavior
  }
  // Legacy cache rows written before this commit are plain text.
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
  payload: CachedPayload,
  cacheToPut?: EnginePromptResult['cache_to_put'],
): EnginePromptResult {
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
  env: PerplexityEnv,
  brand: Brand,
  prompts: Prompt[],
  runId: string,
): Promise<void> {
  // Bulk pattern — see src/openai.ts:runLive. Perplexity additionally
  // packs {text, citations} as JSON in the cache, so cacheToPut wraps
  // packCached(payload) instead of raw text.
  const CONCURRENCY = 5;
  const hashes = await Promise.all(
    prompts.map((p) => hashPrompt(p.text, ENGINE, MODEL)),
  );

  if (!env.PERPLEXITY_API_KEY) {
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
          let payload: CachedPayload;
          let cacheToPut: EnginePromptResult['cache_to_put'];
          if (cached !== undefined) {
            payload = unpackCached(cached);
          } else {
            const completion = await chatCompletion(
              requirePerplexityKey(env),
              prompt.text,
              buildSystemPrompt(),
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
          results[idx] = buildOkResult(brand, prompt, payload, cacheToPut);
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
    console.error('runLive[perplexity]: persistEngineRun failed', {
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
