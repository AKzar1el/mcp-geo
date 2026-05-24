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
  cacheGet,
  cachePut,
  insertPromptResponse,
  updateRun,
  type Brand,
  type DbEnv,
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

async function processSinglePrompt(
  env: PerplexityEnv,
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
      const completion = await chatCompletion(
        requirePerplexityKey(env),
        prompt.text,
        buildSystemPrompt(),
      );
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
    const citations = extractCitations(brand, payload.text);
    const merged_cited = mergeUrls(citations.cited_urls, payload.citations);
    // Re-evaluate brand_cited_with_link against the merged URL set so a
    // Perplexity-provided URL pointing at brand.domain counts even when
    // the brand isn't markdown-linked in the response text.
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
    console.error('runLive[perplexity]: prompt failed', {
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
  env: PerplexityEnv,
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
    console.error('runLive[perplexity]: run failed', {
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
