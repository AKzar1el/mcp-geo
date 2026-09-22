// xAI Grok runner. Live mode only. Uses the Responses API with required
// Web Search so visibility checks are grounded in current public web results.

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
import { fetchWithTimeout } from './fetch.js';

export const MODEL = 'grok-4.6';
export const ENGINE = 'grok';

const LIVE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses';

export interface XAiEnv {
  db: Db;
  XAI_API_KEY?: string;
}

function requireXAiKey(env: XAiEnv): string {
  if (!env.XAI_API_KEY) {
    throw new Error('XAI_API_KEY not set');
  }
  return env.XAI_API_KEY;
}

interface XAiOutputText {
  type?: string;
  text?: unknown;
  annotations?: Array<{
    type?: string;
    url?: unknown;
    url_citation?: { url?: unknown };
  }>;
}

interface XAiOutputItem {
  type?: string;
  content?: XAiOutputText[];
}

interface XAiResponse {
  output?: XAiOutputItem[];
  citations?: unknown[];
}

export interface XAiCompletion {
  text: string;
  citations: string[];
}

function extractResponseText(data: XAiResponse): string {
  const chunks: string[] = [];
  for (const item of data.output ?? []) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part.type === 'output_text' && typeof part.text === 'string') {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join('');
}

function extractResponseCitations(data: XAiResponse): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) return;
    seen.add(value);
    urls.push(value);
  };

  for (const citation of data.citations ?? []) {
    if (typeof citation === 'string') {
      add(citation);
    } else if (citation && typeof citation === 'object' && 'url' in citation) {
      add((citation as { url?: unknown }).url);
    }
  }
  for (const item of data.output ?? []) {
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      for (const annotation of part.annotations ?? []) {
        add(annotation.url);
        add(annotation.url_citation?.url);
      }
    }
  }
  return urls;
}

export async function chatCompletion(
  apiKey: string,
  userText: string,
  systemPrompt = buildSystemPrompt(),
): Promise<XAiCompletion> {
  const resp = await fetchWithTimeout(XAI_RESPONSES_URL, {
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
      tool_choice: 'required',
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`xAI Responses API failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as XAiResponse;
  const text = extractResponseText(data);
  if (text.length === 0) {
    throw new Error('xAI response missing output_text');
  }
  return { text, citations: extractResponseCitations(data) };
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

function truncateError(message: string): string {
  return message.length > 500 ? message.slice(0, 500) : message;
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
  const message = err instanceof Error ? err.message : String(err);
  console.error('runLive[grok]: prompt failed', {
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

function buildOkResult(
  brand: Brand,
  prompt: Prompt,
  payload: XAiCompletion,
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
  env: XAiEnv,
  brand: Brand,
  prompts: Prompt[],
  runId: string,
): Promise<void> {
  const CONCURRENCY = 5;

  if (!env.XAI_API_KEY) {
    await env.db.persistEngineRun(
      runId,
      ENGINE,
      MODEL,
      LIVE_CACHE_TTL_SECONDS,
      prompts.map(buildSkippedResult),
    );
    return;
  }

  const results: EnginePromptResult[] = new Array(prompts.length);
  for (let i = 0; i < prompts.length; i += CONCURRENCY) {
    const chunkStart = i;
    const chunk = prompts.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (prompt, j) => {
        const index = chunkStart + j;
        try {
          const payload = await chatCompletion(requireXAiKey(env), prompt.text);
          results[index] = buildOkResult(brand, prompt, payload);
        } catch (err) {
          results[index] = buildFailedResult(prompt, err);
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
    console.error('runLive[grok]: persistEngineRun failed', {
      run_id: runId,
      message: err instanceof Error ? err.message : String(err),
    });
    await env.db.updateRun(runId, {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      completed_at: Date.now(),
    }).catch(() => {});
  }
}
