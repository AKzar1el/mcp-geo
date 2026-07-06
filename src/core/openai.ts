// OpenAI runners: live (synchronous loop) and batch (Files + Batch API).
// We call the HTTP API directly via fetch() so the worker bundle stays small
// and we keep Workers runtime compatibility without the openai npm package.

import type {
  Brand,
  Db,
  EnginePromptResult,
  Prompt,
  Run,
} from '../db/types.js';

export const MODEL = 'gpt-4o-mini';
const ENGINE = 'chatgpt';

const LIVE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const BATCH_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

const OPENAI_BASE = 'https://api.openai.com/v1';

// TODO: when input/output volume grows we can route JSONL through an R2
// bucket (env.OPENAI_BATCH_BUCKET) instead of holding it in memory. v1
// uploads straight to OpenAI's Files API, so no R2 is needed today.

export interface OpenAiEnv {
  db: Db;
  OPENAI_API_KEY?: string;
}

function requireOpenAiKey(env: OpenAiEnv): string {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set');
  }
  return env.OPENAI_API_KEY;
}

export function buildSystemPrompt(): string {
  return [
    'You are answering a search query that a real buyer might ask an AI assistant when researching products in a category.',
    'Answer concisely, naming 3-7 specific tools/brands when relevant.',
    'Include short URLs (homepages) for tools you recommend, in the form `[Tool Name](https://tool.com)`.',
    "If you don't know, say so.",
    "Don't say you're an AI.",
  ].join(' ');
}

const HASH_FIELD_SEP = '\x1f'; // ASCII unit separator. NOT NUL — a NUL delimiter makes git treat this file as binary.

export async function hashPrompt(
  promptText: string,
  engine: string,
  model: string,
): Promise<string> {
  const input = `${promptText}${HASH_FIELD_SEP}${engine}${HASH_FIELD_SEP}${model}`;
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export async function chatCompletion(
  apiKey: string,
  userText: string,
): Promise<string> {
  const resp = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: userText },
      ],
      temperature: 0.3,
      max_tokens: 600,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI chat completion failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('OpenAI response missing choices[0].message.content');
  }
  return content;
}

export interface CitationExtraction {
  brand_mentioned: 0 | 1;
  brand_cited_with_link: 0 | 1;
  cited_urls: string[];
  competitors_mentioned: string[];
}

function rootTermFromDomain(domain: string): string {
  // 'example.com' -> 'example', 'monday.com' -> 'monday', 'notion.so' -> 'notion'
  const noProto = domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const host = noProto.split('/')[0] ?? noProto;
  const parts = host.split('.');
  if (parts.length <= 1) return host.toLowerCase();
  return parts.slice(0, -1).join('.').toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches `term` only as a standalone token — not buried inside a larger
// word. Boundaries = "no adjacent letter/digit" (Unicode-friendlier than \b).
function termAppearsAsWord(text: string, term: string): boolean {
  const t = term.trim();
  if (t.length === 0) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(t)}(?![\\p{L}\\p{N}])`, 'iu');
  return re.test(text);
}

interface MatchTerms {
  domain: string;
  name?: string;
  aliases?: string[];
  excludeTerms?: string[];
}

function mentionsTermSet(text: string, terms: MatchTerms): boolean {
  const fullDomain =
    terms.domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0]?.toLowerCase() ?? '';
  // 1. Full domain substring — highest confidence, never suppressed.
  if (fullDomain.length > 0 && text.toLowerCase().includes(fullDomain)) return true;
  // 2. Explicit aliases — user-declared, count as word matches, never suppressed.
  for (const a of terms.aliases ?? []) {
    if (termAppearsAsWord(text, a)) return true;
  }
  const excluded = new Set((terms.excludeTerms ?? []).map((e) => e.trim().toLowerCase()));
  // 3. Brand name as a standalone word — unless excluded.
  if (terms.name && !excluded.has(terms.name.trim().toLowerCase()) && termAppearsAsWord(text, terms.name)) {
    return true;
  }
  // 4. Bare domain root as a standalone word — unless excluded.
  const root = rootTermFromDomain(terms.domain);
  if (root.length > 0 && !excluded.has(root) && termAppearsAsWord(text, root)) return true;
  return false;
}

// True when host IS the domain or a subdomain of it. A substring check
// would also match lookalike domains that merely end with the brand
// domain — "notacme.com".includes("acme.com") is true.
export function hostMatchesDomain(host: string, domain: string): boolean {
  const d = domain
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase();
  if (d.length === 0) return false;
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
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

function extractUrls(text: string): string[] {
  const markdownRe = /\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/g;
  const plainRe = /https?:\/\/[^\s)\]\}'"`<>]+/g;
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = markdownRe.exec(text)) !== null) {
    urls.push(m[1]);
  }
  // Run plain after markdown — plainRe also catches the URL inside the
  // markdown link, which is fine: we dedupe by hostname below.
  while ((m = plainRe.exec(text)) !== null) {
    urls.push(m[0]);
  }
  return urls;
}

export function extractCitations(
  brand: Brand,
  responseText: string,
): CitationExtraction {
  const brandMentioned = mentionsTermSet(responseText, {
    domain: brand.domain,
    name: brand.name,
    aliases: brand.aliases,
    excludeTerms: brand.exclude_terms,
  });

  const urls = extractUrls(responseText);
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const host = normalizeHost(url);
    if (!host) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
    if (hosts.length >= 20) break;
  }

  // Linked-citation check uses the full brand.domain (not the root term).
  // Mentions tolerate paraphrase ("we use Example"), but a link counts as a
  // citation only if the URL points at the brand's actual domain (or a
  // subdomain of it).
  const brandCitedWithLink = hosts.some((h) =>
    hostMatchesDomain(h, brand.domain),
  );

  const competitorsMentioned: string[] = [];
  for (const competitor of brand.competitors) {
    if (mentionsTermSet(responseText, { domain: competitor })) {
      competitorsMentioned.push(competitor);
    }
  }

  return {
    brand_mentioned: brandMentioned ? 1 : 0,
    brand_cited_with_link: brandCitedWithLink ? 1 : 0,
    cited_urls: hosts,
    competitors_mentioned: competitorsMentioned,
  };
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
  console.error('runLive: prompt failed', {
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
  env: OpenAiEnv,
  brand: Brand,
  prompts: Prompt[],
  runId: string,
): Promise<void> {
  // Bulk pattern: one D1 read for the cache (bulkCacheGet), up to N
  // parallel LLM fetches, one D1.batch() at the end. Without this, 20
  // prompts × ~4 D1 ops each + LLM fetches blow past Workers free-plan
  // 50-subrequest cap and the worker is killed mid-chunk, dropping
  // half the rows. The current shape lands at ~22 subrequests per
  // /admin/run-engine invocation.
  const CONCURRENCY = 5;
  const hashes = await Promise.all(
    prompts.map((p) => hashPrompt(p.text, ENGINE, MODEL)),
  );

  if (!env.OPENAI_API_KEY) {
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
          let responseText: string;
          let cacheToPut: EnginePromptResult['cache_to_put'];
          if (cached !== undefined) {
            responseText = cached;
          } else {
            responseText = await chatCompletion(
              requireOpenAiKey(env),
              prompt.text,
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
    await env.db.persistEngineRun(
      runId,
      ENGINE,
      MODEL,
      LIVE_CACHE_TTL_SECONDS,
      results,
    );
  } catch (err) {
    console.error('runLive: persistEngineRun failed', {
      run_id: runId,
      message: (err as Error).message,
    });
    // Best-effort: mark the run failed so it's not stuck in
    // 'in_progress' forever. If updateRun also throws (e.g. the
    // subrequest cap was already hit), there's nothing left to do —
    // getLatestCompletedRun anchors on EXISTS(ok rows), not
    // status='completed', so the data we wrote still surfaces.
    await env.db.updateRun(runId, {
      status: 'failed',
      error: (err as Error).message,
      completed_at: Date.now(),
    }).catch(() => {});
  }
}

interface OpenAiFile {
  id: string;
}

interface OpenAiBatch {
  id: string;
  status: string;
  output_file_id?: string;
  error_file_id?: string;
  request_counts?: { total?: number; completed?: number; failed?: number };
}

function buildBatchLine(prompt: Prompt): string {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: prompt.text },
    ],
    temperature: 0.3,
    max_tokens: 600,
  };
  return JSON.stringify({
    custom_id: prompt.id,
    method: 'POST',
    url: '/v1/chat/completions',
    body,
  });
}

export interface SubmitBatchResult {
  batch_id: string;
  input_file_id: string;
}

export async function submitBatch(
  env: OpenAiEnv,
  _brand: Brand,
  prompts: Prompt[],
  runId: string,
): Promise<SubmitBatchResult> {
  const jsonl = prompts.map(buildBatchLine).join('\n') + '\n';

  const form = new FormData();
  form.append('purpose', 'batch');
  form.append(
    'file',
    new Blob([jsonl], { type: 'application/jsonl' }),
    `geo-mcp-run-${runId}.jsonl`,
  );

  const uploadResp = await fetch(`${OPENAI_BASE}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${requireOpenAiKey(env)}` },
    body: form,
  });
  if (!uploadResp.ok) {
    const text = await uploadResp.text();
    throw new Error(`OpenAI file upload failed: ${uploadResp.status} ${text}`);
  }
  const file = (await uploadResp.json()) as OpenAiFile;

  const createResp = await fetch(`${OPENAI_BASE}/batches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireOpenAiKey(env)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input_file_id: file.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    }),
  });
  if (!createResp.ok) {
    const text = await createResp.text();
    throw new Error(`OpenAI batch create failed: ${createResp.status} ${text}`);
  }
  const batch = (await createResp.json()) as OpenAiBatch;

  await env.db.updateRun(runId, { batch_id: batch.id, status: 'in_progress' });

  return { batch_id: batch.id, input_file_id: file.id };
}

export interface CollectBatchResult {
  ready: boolean;
  status: string;
  completed?: number;
  failed?: number;
}

interface BatchOutputLine {
  custom_id: string;
  response?: {
    body?: { choices?: Array<{ message?: { content?: string } }> };
  };
  error?: { message?: string };
}

export async function collectBatch(
  env: OpenAiEnv,
  run: Run,
  brand: Brand,
  prompts: Prompt[],
): Promise<CollectBatchResult> {
  if (!run.batch_id) {
    throw new Error(`run ${run.id} has no batch_id`);
  }
  const statusResp = await fetch(`${OPENAI_BASE}/batches/${run.batch_id}`, {
    headers: { Authorization: `Bearer ${requireOpenAiKey(env)}` },
  });
  if (!statusResp.ok) {
    const text = await statusResp.text();
    throw new Error(`OpenAI batch status failed: ${statusResp.status} ${text}`);
  }
  const batch = (await statusResp.json()) as OpenAiBatch;

  if (batch.status !== 'completed') {
    await env.db.updateRun(run.id, { status: 'in_progress' });
    return { ready: false, status: batch.status };
  }
  if (!batch.output_file_id) {
    await env.db.updateRun(run.id, {
      status: 'failed',
      error: 'batch completed without output_file_id',
      completed_at: Date.now(),
    });
    throw new Error('batch completed without output_file_id');
  }

  const outputResp = await fetch(
    `${OPENAI_BASE}/files/${batch.output_file_id}/content`,
    { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } },
  );
  if (!outputResp.ok) {
    const text = await outputResp.text();
    throw new Error(`OpenAI batch output failed: ${outputResp.status} ${text}`);
  }
  const body = await outputResp.text();

  const promptById = new Map(prompts.map((p) => [p.id, p]));
  let completed = 0;
  let failed = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: BatchOutputLine;
    try {
      parsed = JSON.parse(line) as BatchOutputLine;
    } catch {
      continue;
    }
    const prompt = promptById.get(parsed.custom_id);
    if (!prompt) continue;
    const content = parsed.response?.body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      failed += 1;
      await env.db.insertPromptResponse({
        run_id: run.id,
        prompt_id: prompt.id,
        engine: ENGINE,
        raw_response: '',
        brand_mentioned: 0,
        brand_cited_with_link: 0,
        cited_urls: [],
        competitors_mentioned: [],
        status: 'failed',
        error_message: truncateError(
          parsed.error?.message ?? 'no content in batch response',
        ),
      });
      continue;
    }
    const hash = await hashPrompt(prompt.text, ENGINE, MODEL);
    await env.db.cachePut(hash, ENGINE, MODEL, content, BATCH_CACHE_TTL_SECONDS);
    const citations = extractCitations(brand, content);
    await env.db.insertPromptResponse({
      run_id: run.id,
      prompt_id: prompt.id,
      engine: ENGINE,
      raw_response: content,
      brand_mentioned: citations.brand_mentioned,
      brand_cited_with_link: citations.brand_cited_with_link,
      cited_urls: citations.cited_urls,
      competitors_mentioned: citations.competitors_mentioned,
      status: 'ok',
    });
    completed += 1;
  }

  await env.db.updateRun(run.id, {
    status: 'completed',
    prompts_completed: completed,
    completed_at: Date.now(),
  });
  return { ready: true, status: batch.status, completed, failed };
}
