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
import { fetchWithTimeout } from './fetch.js';

export const MODEL = 'gpt-5-search-api';
const BATCH_MODEL = 'gpt-4o-mini';
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
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string;
      annotations?: Array<{
        type?: string;
        url_citation?: { url?: unknown };
      }>;
    };
  }>;
}

interface OpenAiCompletion {
  text: string;
  citations: string[];
}

export async function chatCompletion(
  apiKey: string,
  userText: string,
): Promise<OpenAiCompletion> {
  const resp = await fetchWithTimeout(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      web_search_options: { search_context_size: 'medium' },
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: userText },
      ],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI chat completion failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as ChatCompletionResponse;
  const finishReason = data.choices?.[0]?.finish_reason;
  // Only a normally finished, non-streaming answer is scoreable. Missing
  // metadata or tool handoff can contain partial text.
  if (finishReason !== 'stop') {
    throw new Error(`OpenAI response incomplete: ${finishReason ?? 'missing finish_reason'}`);
  }
  const message = data.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('OpenAI response missing choices[0].message.content');
  }
  const citations = (message?.annotations ?? [])
    .filter((annotation) => annotation && annotation.type === 'url_citation')
    .map((annotation) => annotation.url_citation?.url)
    .filter((url): url is string => typeof url === 'string' && normalizeHost(url) !== null);
  return { text: content, citations };
}

export interface CitationExtraction {
  brand_mentioned: 0 | 1;
  brand_cited_with_link: 0 | 1;
  cited_urls: string[];
  competitors_mentioned: string[];
}

// These common two-label public suffixes need the label immediately before
// the suffix, not the entire host minus its final label. This deliberately
// avoids guessing that every two-letter TLD has the same registry structure.
const COMMON_TWO_LABEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'net.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'govt.nz',
  'co.jp', 'or.jp', 'ne.jp',
  'com.br', 'com.mx', 'com.tr', 'com.sg', 'com.hk', 'com.tw',
  'co.kr', 'co.za', 'co.in', 'com.cn', 'com.ar',
  'co.id', 'com.ph', 'com.my',
  'com.co', 'co.il', 'com.vn',
  'com.pk', 'co.th',
]);

function rootTermFromDomain(domain: string): string {
  // 'example.com' -> 'example', 'monday.com' -> 'monday', 'notion.so' -> 'notion'
  const noProto = domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const host = noProto.split('/')[0] ?? noProto;
  const parts = host.split('.');
  if (parts.length <= 1) return host.toLowerCase();
  const suffix = parts.slice(-2).join('.').toLowerCase();
  if (parts.length >= 3 && COMMON_TWO_LABEL_PUBLIC_SUFFIXES.has(suffix)) {
    return parts[parts.length - 3]!.toLowerCase();
  }
  return parts.slice(0, -1).join('.').toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches `term` only as a standalone token — not buried inside a larger
// word. Boundaries = "no adjacent letter/digit" (Unicode-friendlier than \b).
function termMatchIndex(text: string, term: string): number {
  const t = term.trim();
  if (t.length === 0) return -1;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(t)}(?![\\p{L}\\p{N}])`, 'iu');
  return re.exec(text)?.index ?? -1;
}

export interface MatchTerms {
  domain: string;
  name?: string;
  aliases?: string[];
  excludeTerms?: string[];
}

function domainMatchIndex(text: string, domain: string): number {
  const fullDomain =
    domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0]?.toLowerCase() ?? '';
  if (fullDomain.length === 0) return -1;

  // Match the exact host or one of its subdomains, never a lookalike host
  // that merely contains the configured domain as a suffix or prefix.
  const re = new RegExp(
    `(?:^|[^\\p{L}\\p{N}-])((?:[a-z0-9-]+\\.)*${escapeRegExp(fullDomain)})(?=$|[^\\p{L}\\p{N}.-]|\\.(?![\\p{L}\\p{N}-]))`,
    'iu',
  );
  const match = re.exec(text);
  if (!match || !match[1]) return -1;
  return match.index + match[0].indexOf(match[1]);
}

function rootTermMatchIndexOutsideHostname(text: string, term: string): number {
  const t = term.trim();
  if (t.length === 0) return -1;
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}.])${escapeRegExp(t)}(?![\\p{L}\\p{N}]|\\.(?=[\\p{L}\\p{N}-]))`,
    'iu',
  );
  return re.exec(text)?.index ?? -1;
}

export function findTermSetMatchIndex(text: string, terms: MatchTerms): number {
  // 1. Exact domain/subdomain reference - highest confidence, never suppressed.
  const domainIndex = domainMatchIndex(text, terms.domain);
  if (domainIndex !== -1) return domainIndex;
  // 2. Explicit aliases — user-declared, count as word matches, never suppressed.
  for (const a of terms.aliases ?? []) {
    const aliasIndex = termMatchIndex(text, a);
    if (aliasIndex !== -1) return aliasIndex;
  }
  const excluded = new Set((terms.excludeTerms ?? []).map((e) => e.trim().toLowerCase()));
  // 3. Brand name as a standalone word — unless excluded.
  if (terms.name && !excluded.has(terms.name.trim().toLowerCase())) {
    const nameIndex = termMatchIndex(text, terms.name);
    if (nameIndex !== -1) return nameIndex;
  }
  // 4. Bare domain root as a standalone word — unless excluded.
  const root = rootTermFromDomain(terms.domain);
  if (root.length > 0 && !excluded.has(root)) {
    const rootIndex = rootTermMatchIndexOutsideHostname(text, root);
    if (rootIndex !== -1) return rootIndex;
  }
  return -1;
}

function mentionsTermSet(text: string, terms: MatchTerms): boolean {
  return findTermSetMatchIndex(text, terms) !== -1;
}

// True when host IS the domain or a subdomain of it. A substring check
// would also match lookalike domains that merely end with the brand
// domain — "notacme.com".includes("acme.com") is true.
export function hostMatchesDomain(host: string, domain: string): boolean {
  let d = domain
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase();
  let h = host.toLowerCase();
  // A single terminal DNS root dot is valid; repeated dots are not.
  if (d.endsWith('.')) d = d.slice(0, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!d || !h) return false;
  if ([d, h].some((value) => value.startsWith('.') || value.includes('..') || value.endsWith('.'))) {
    return false;
  }
  return h === d || h.endsWith(`.${d}`);
}

function normalizeHost(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    // Native source metadata is link evidence only when it points to a web URL.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Userinfo can disguise the actual destination and is not reliable source evidence.
    if (u.username || u.password) return null;
    let host = u.hostname.toLowerCase();
    // Strip terminal prose punctuation from a bare URL's hostname.
    // DNS names cannot end in commas, semicolons or exclamation marks.
    host = host.replace(/[;,!]+$/, '');
    if (host.endsWith('.')) host = host.slice(0, -1);
    if (host.endsWith('.')) return null; // Do not turn repeated root dots into brand evidence.
    if (host.startsWith('www.')) host = host.slice(4);
    return host || null;
  } catch {
    return null;
  }
}

// Keep linked-brand scoring independent of the bounded citation evidence list.
export function hasBrandInEngineCitations(
  brandDomain: string,
  urls: readonly string[],
): boolean {
  return urls.some((url) => {
    const host = normalizeHost(url);
    return host !== null && hostMatchesDomain(host, brandDomain);
  });
}

export function extractUrls(text: string): string[] {
  const markdownRe = /\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/gi;
  const plainRe = /https?:\/\/[^\s)\]\}'"`<>]+/gi;
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
  const urls = extractUrls(responseText);
  // Only visible prose and real URL hosts provide mention evidence.
  const mentionText = responseText.replace(/https?:\/\/[^\s)\]\}'"\x60<>]+/gi, ' ');
  let brandMentioned = mentionsTermSet(mentionText, {
    domain: brand.domain,
    name: brand.name,
    aliases: brand.aliases,
    excludeTerms: brand.exclude_terms,
  });
  const hosts: string[] = [];
  const seen = new Set<string>();
  // Keep the evidence list bounded without missing later brand links.
  let brandCitedWithLink = false;
  for (const url of urls) {
    const host = normalizeHost(url);
    if (!host) continue;
    if (hostMatchesDomain(host, brand.domain)) {
      brandCitedWithLink = true;
      brandMentioned = true;
    }
    if (hosts.length >= 20 || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }

  const competitorsMentioned: string[] = [];
  for (const competitor of brand.competitors) {
    if (
      mentionsTermSet(mentionText, { domain: competitor }) ||
      urls.some((url) => {
        const host = normalizeHost(url);
        return host !== null && hostMatchesDomain(host, competitor);
      })
    ) {
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
  const msg = err instanceof Error ? err.message : String(err);
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
  // Keep provider calls bounded while writing every response in one final
  // batch. A live refresh always obtains a new response for every prompt.
  const CONCURRENCY = 5;

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

  const results: EnginePromptResult[] = new Array(prompts.length);

  for (let i = 0; i < prompts.length; i += CONCURRENCY) {
    const chunkStart = i;
    const chunk = prompts.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (prompt, j) => {
        const idx = chunkStart + j;
        try {
          const completion = await chatCompletion(
            requireOpenAiKey(env),
            prompt.text,
          );
          const citations = extractCitations(brand, completion.text);
          const engineHosts = completion.citations
            .map(normalizeHost)
            .filter((host): host is string => host !== null);
          const citedUrls = Array.from(
            new Set([...citations.cited_urls, ...engineHosts]),
          ).slice(0, 30);
          results[idx] = {
            prompt_id: prompt.id,
            raw_response: completion.text,
            brand_mentioned: citations.brand_mentioned,
            brand_cited_with_link:
              citations.brand_cited_with_link === 1 ||
              hasBrandInEngineCitations(brand.domain, completion.citations)
                ? 1
                : 0,
            cited_urls: citedUrls,
            competitors_mentioned: citations.competitors_mentioned,
            engine_citations: completion.citations,
            status: 'ok',
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
    const message = err instanceof Error ? err.message : String(err);
    console.error('runLive: persistEngineRun failed', {
      run_id: runId,
      message,
    });
    // Best-effort: mark the run failed so it's not stuck in
    // 'in_progress' forever. If updateRun also throws (e.g. the
    // subrequest cap was already hit), there's nothing left to do —
    // getLatestCompletedRun anchors on EXISTS(ok rows), not
    // status='completed', so the data we wrote still surfaces.
    await env.db.updateRun(runId, {
      status: 'failed',
      error: message,
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
    model: BATCH_MODEL,
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

  let file: OpenAiFile;
  let batch: OpenAiBatch;
  try {
    const uploadResp = await fetchWithTimeout(`${OPENAI_BASE}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${requireOpenAiKey(env)}` },
      body: form,
    });
    if (!uploadResp.ok) {
      const text = await uploadResp.text();
      throw new Error(`OpenAI file upload failed: ${uploadResp.status} ${text}`);
    }
    file = (await uploadResp.json()) as OpenAiFile;
    if (typeof file?.id !== 'string' || !file.id.trim()) {
      throw new Error('OpenAI file upload returned no file id');
    }

    const createResp = await fetchWithTimeout(`${OPENAI_BASE}/batches`, {
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
    batch = (await createResp.json()) as OpenAiBatch;
    if (typeof batch?.id !== 'string' || !batch.id.trim()) {
      throw new Error('OpenAI batch create returned no batch id');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await env.db.updateRun(runId, {
        status: 'failed',
        error: message.slice(0, 500),
        completed_at: Date.now(),
      });
    } catch (persistError) {
      console.error('submitBatch: failed to mark rejected batch submission terminal', {
        run_id: runId,
        message: persistError instanceof Error ? persistError.message : String(persistError),
      });
    }
    throw error;
  }

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
    status_code?: number;
    body?: {
      choices?: Array<{ finish_reason?: string | null; message?: { content?: string } }>;
      error?: { message?: string };
    };
  };
  error?: { message?: string };
}

function parseBatchOutputLines(
  body: string,
  source: 'output' | 'error',
): BatchOutputLine[] {
  const output: BatchOutputLine[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(
        `OpenAI batch integrity error: invalid JSON ${source} file line`,
      );
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { custom_id?: unknown }).custom_id !== 'string' ||
      (parsed as { custom_id: string }).custom_id.length === 0
    ) {
      throw new Error(
        `OpenAI batch integrity error: ${source} file line missing custom_id`,
      );
    }
    output.push(parsed as BatchOutputLine);
  }
  return output;
}

async function downloadBatchFile(
  env: OpenAiEnv,
  fileId: string,
  source: 'output' | 'error',
): Promise<string> {
  const response = await fetchWithTimeout(`${OPENAI_BASE}/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${requireOpenAiKey(env)}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `OpenAI batch ${source} file failed: ${response.status} ${text}`,
    );
  }
  return response.text();
}

function assertUniqueBatchCustomIds(
  outputLines: BatchOutputLine[],
  errorLines: BatchOutputLine[],
): void {
  const outputIds = new Set<string>();
  for (const line of outputLines) {
    if (outputIds.has(line.custom_id)) {
      throw new Error(
        `OpenAI batch integrity error: duplicate custom_id ${line.custom_id} in output file`,
      );
    }
    outputIds.add(line.custom_id);
  }
  const errorIds = new Set<string>();
  for (const line of errorLines) {
    if (errorIds.has(line.custom_id)) {
      throw new Error(
        `OpenAI batch integrity error: duplicate custom_id ${line.custom_id} in error file`,
      );
    }
    if (outputIds.has(line.custom_id)) {
      throw new Error(
        `OpenAI batch integrity error: custom_id ${line.custom_id} appears in both output and error files`,
      );
    }
    errorIds.add(line.custom_id);
  }
}

function batchErrorMessage(line: BatchOutputLine): string {
  const message =
    line.error?.message ?? line.response?.body?.error?.message;
  if (typeof message === 'string' && message.length > 0) {
    return truncateError(message);
  }
  if (typeof line.response?.status_code === 'number') {
    return `OpenAI batch request failed with status ${line.response.status_code}`;
  }
  return 'no content in batch response';
}

export async function collectBatch(
  env: OpenAiEnv,
  run: Run,
  brand: Brand,
): Promise<CollectBatchResult> {
  if (!run.batch_id) {
    throw new Error(`run ${run.id} has no batch_id`);
  }
  const statusResp = await fetchWithTimeout(`${OPENAI_BASE}/batches/${run.batch_id}`, {
    headers: { Authorization: `Bearer ${requireOpenAiKey(env)}` },
  });
  if (!statusResp.ok) {
    const text = await statusResp.text();
    throw new Error(`OpenAI batch status failed: ${statusResp.status} ${text}`);
  }
  const batch = (await statusResp.json()) as OpenAiBatch;

  // OpenAI can terminate a Batch without ever entering "completed".
  // Expired/cancelled batches may still expose useful partial result files.
  const terminalFailure = batch.status === 'failed'
    || batch.status === 'expired'
    || batch.status === 'cancelled';
  if (batch.status !== 'completed' && !terminalFailure) {
    await env.db.updateRun(run.id, { status: 'in_progress' });
    return { ready: false, status: batch.status };
  }
  if (!batch.output_file_id && !batch.error_file_id) {
    const error = batch.status === 'completed'
      ? 'batch completed without output_file_id or error_file_id'
      : 'OpenAI batch ' + batch.status + ' without output or error files';
    await env.db.updateRun(run.id, {
      status: 'failed',
      error,
      completed_at: Date.now(),
    });
    if (terminalFailure) {
      return { ready: true, status: batch.status, completed: 0, failed: run.prompts_total };
    }
    throw new Error(error);
  }

  let outputLines: BatchOutputLine[];
  let errorLines: BatchOutputLine[];
  try {
    outputLines = batch.output_file_id
      ? parseBatchOutputLines(
        await downloadBatchFile(env, batch.output_file_id, 'output'),
        'output',
      )
      : [];
    errorLines = batch.error_file_id
      ? parseBatchOutputLines(
        await downloadBatchFile(env, batch.error_file_id, 'error'),
        'error',
      )
      : [];
    assertUniqueBatchCustomIds(outputLines, errorLines);
  } catch (error) {
    // Corrupt provider output is permanent; a failed download may be transient.
    // Do not close the run for transport failures that a later poll can retry.
    if (error instanceof Error && error.message.startsWith('OpenAI batch integrity error:')) {
      await env.db.updateRun(run.id, {
        status: 'failed',
        error: truncateError(error.message),
        completed_at: Date.now(),
      });
    }
    throw error;
  }

  const promptIds = [
    ...outputLines.map((line) => line.custom_id),
    ...errorLines.map((line) => line.custom_id),
  ];
  const prompts = await env.db.getPromptsByIds(promptIds);
  const promptById = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const unresolved = promptIds.filter((id) => {
    const prompt = promptById.get(id);
    return !prompt || prompt.brand_id !== brand.id;
  });
  if (unresolved.length > 0) {
    const error = `OpenAI batch integrity error: batch custom_id(s) do not match stored prompts for brand ${brand.id}: ${unresolved.join(', ')}`;
    await env.db.updateRun(run.id, {
      status: 'failed',
      error: truncateError(error),
      completed_at: Date.now(),
    });
    throw new Error(error);
  }

  if (batch.status === 'completed') {
    const rowCount = outputLines.length + errorLines.length;
    const counts = batch.request_counts;
    let discrepancy: string | null = null;
    if (rowCount !== run.prompts_total) {
      discrepancy = `completed batch returned ${rowCount} result row(s) for ${run.prompts_total} submitted prompts`;
    } else if (counts?.total !== undefined && counts.total !== run.prompts_total) {
      discrepancy = `provider request_counts.total is ${counts.total} for ${run.prompts_total} submitted prompts`;
    } else if (
      counts?.completed !== undefined && counts.failed !== undefined &&
      counts.completed + counts.failed !== run.prompts_total
    ) {
      discrepancy = `provider request_counts completed+failed is ${counts.completed + counts.failed} for ${run.prompts_total} submitted prompts`;
    }
    if (discrepancy) {
      const error = `OpenAI batch integrity error: ${discrepancy}`;
      // Retain any prior partial response evidence; never publish a completed score.
      await env.db.updateRun(run.id, {
        status: 'failed',
        error,
        completed_at: Date.now(),
      });
      throw new Error(error);
    }
  }

  const results: EnginePromptResult[] = [];
  for (const parsed of outputLines) {
    const prompt = promptById.get(parsed.custom_id);
    if (!prompt) {
      throw new Error(
        `OpenAI batch integrity error: unresolved custom_id ${parsed.custom_id}`,
      );
    }
    const choice = parsed.response?.body?.choices?.[0];
    const content = choice?.message?.content;
    const finishReason = choice?.finish_reason;
    const statusCode = parsed.response?.status_code;
    // A provider file can contain partial text from a length-limited or
    // filtered completion. Do not score or cache it as a visibility answer.
    if (
      (statusCode !== undefined && (statusCode < 200 || statusCode >= 300)) ||
      finishReason !== 'stop' ||
      typeof content !== 'string' ||
      content.trim().length === 0
    ) {
      const errorMessage = statusCode !== undefined && (statusCode < 200 || statusCode >= 300)
        ? batchErrorMessage(parsed)
        : finishReason !== 'stop'
          ? `OpenAI batch response incomplete: ${finishReason ?? 'missing finish_reason'}`
          : 'OpenAI batch response missing non-empty content';
      results.push({
        prompt_id: prompt.id,
        raw_response: '',
        brand_mentioned: 0,
        brand_cited_with_link: 0,
        cited_urls: [],
        competitors_mentioned: [],
        status: 'failed',
        error_message: errorMessage,
      });
      continue;
    }
    const hash = await hashPrompt(prompt.text, ENGINE, BATCH_MODEL);
    const citations = extractCitations(brand, content);
    results.push({
      prompt_id: prompt.id,
      raw_response: content,
      brand_mentioned: citations.brand_mentioned,
      brand_cited_with_link: citations.brand_cited_with_link,
      cited_urls: citations.cited_urls,
      competitors_mentioned: citations.competitors_mentioned,
      status: 'ok',
      cache_to_put: { prompt_hash: hash, raw_response: content },
    });
  }
  for (const parsed of errorLines) {
    const prompt = promptById.get(parsed.custom_id);
    if (!prompt) {
      throw new Error(
        `OpenAI batch integrity error: unresolved custom_id ${parsed.custom_id}`,
      );
    }
    results.push({
      prompt_id: prompt.id,
      raw_response: '',
      brand_mentioned: 0,
      brand_cited_with_link: 0,
      cited_urls: [],
      competitors_mentioned: [],
      status: 'failed',
      error_message: batchErrorMessage(parsed),
    });
  }

  await env.db.persistEngineRun(
    run.id,
    ENGINE,
    BATCH_MODEL,
    BATCH_CACHE_TTL_SECONDS,
    results,
    { replaceExisting: true },
  );
  const completed = results.filter((result) => result.status === 'ok').length;
  const explicitFailures = results.filter((result) => result.status === 'failed').length;
  // A terminally unsuccessful batch cannot produce the remaining prompt rows.
  const failed = terminalFailure
    ? Math.max(explicitFailures, run.prompts_total - completed)
    : explicitFailures;
  if (terminalFailure) {
    // persistEngineRun stores available partial responses and closes the run.
    // Preserve those responses but expose the provider's terminal failure.
    await env.db.updateRun(run.id, {
      status: 'failed',
      error: 'OpenAI batch ' + batch.status + '; ' + results.length + '/' + run.prompts_total + ' prompt results available',
      completed_at: Date.now(),
    });
  }
  return { ready: true, status: batch.status, completed, failed };
}
