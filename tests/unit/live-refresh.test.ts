import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectBatch,
  runLive as runOpenAiLive,
} from '../../src/core/openai.ts';
import { runLive as runAnthropicLive } from '../../src/core/anthropic.ts';
import { runLive as runPerplexityLive } from '../../src/core/perplexity.ts';
import { runLive as runGeminiLive } from '../../src/core/gemini.ts';
import { runLive as runAiOverviewsLive } from '../../src/core/ai-overviews.ts';
import type {
  Brand,
  Db,
  EnginePromptResult,
  Prompt,
  Run,
} from '../../src/db/types.ts';

const brand: Brand = {
  id: 'acme',
  user_id: 'test-user',
  domain: 'acme.com',
  name: 'Acme',
  category: null,
  competitors: [],
  aliases: [],
  exclude_terms: [],
  refresh_frequency: 'weekly',
  created_at: 0,
  updated_at: 0,
};

const prompt: Prompt = {
  id: 'prompt-1',
  brand_id: brand.id,
  text: 'What is Acme?',
  intent_stage: null,
  shape: null,
  active: 1,
  created_at: 0,
};

type FetchCall = { url: URL; init: RequestInit | undefined };

async function withMockFetch(
  response: Response | Error | ((call: FetchCall) => Response | Error),
  assertion: (calls: FetchCall[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call = { url: new URL(input.toString()), init };
    calls.push(call);
    const next = typeof response === 'function' ? response(call) : response;
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  try {
    await assertion(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

type LiveRunner = (
  env: { db: Db } & Record<string, string>,
  brand: Brand,
  prompts: Prompt[],
  runId: string,
) => Promise<void>;

async function assertLiveRunBypassesSharedCache(
  runLive: LiveRunner,
  env: Record<string, string>,
  providerResponse: unknown,
  assertRequest?: (call: FetchCall) => void,
): Promise<void> {
  let cacheReads = 0;
  let persisted: EnginePromptResult[] | undefined;
  const db = {
    bulkCacheGet: async (promptHashes: string[]) => {
      cacheReads += 1;
      return new Map(
        promptHashes.map((hash) => [
          hash,
          'Stale cached response without Acme.',
        ]),
      );
    },
    persistEngineRun: async (
      _runId: string,
      _engine: string,
      _model: string,
      _cacheTtlSeconds: number,
      results: EnginePromptResult[],
    ) => {
      persisted = results;
    },
  } as Db;

  await withMockFetch(jsonResponse(providerResponse), async (calls) => {
    await runLive({ db, ...env }, brand, [prompt], 'run-1');
    assert.equal(calls.length, 1, 'a live scan must call its provider');
    assertRequest?.(calls[0]);
  });

  assert.equal(cacheReads, 0, 'live scans must not read shared_prompt_cache');
  assert.ok(persisted);
  assert.equal(persisted[0].raw_response, 'Fresh Acme provider response.');
  assert.equal(persisted[0].brand_mentioned, 1);
  assert.equal(persisted[0].status, 'ok');
  assert.equal(persisted[0].cache_to_put, undefined);
}

test('live scans bypass shared cached responses for every provider', async (t) => {
  await t.test('OpenAI', () =>
    assertLiveRunBypassesSharedCache(
      runOpenAiLive as LiveRunner,
      { OPENAI_API_KEY: 'test-key' },
      { choices: [{ message: { content: 'Fresh Acme provider response.' } }] },
    ));
  await t.test('Anthropic', () =>
    assertLiveRunBypassesSharedCache(
      runAnthropicLive as LiveRunner,
      { ANTHROPIC_API_KEY: 'test-key' },
      { content: [{ type: 'text', text: 'Fresh Acme provider response.' }] },
    ));
  await t.test('Perplexity', () =>
    assertLiveRunBypassesSharedCache(
      runPerplexityLive as LiveRunner,
      { PERPLEXITY_API_KEY: 'test-key' },
      {
        choices: [{ message: { content: 'Fresh Acme provider response.' } }],
        citations: ['https://acme.com/fresh'],
      },
    ));
  await t.test('Gemini', () =>
    assertLiveRunBypassesSharedCache(
      runGeminiLive as LiveRunner,
      { GEMINI_API_KEY: 'test-key' },
      {
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ text: 'Fresh Acme provider response.' }] },
          },
        ],
      },
    ));
  await t.test('AI Overviews', () =>
    assertLiveRunBypassesSharedCache(
      runAiOverviewsLive as LiveRunner,
      { SERPAPI_API_KEY: 'test-key' },
      {
        ai_overview: {
          text_blocks: [{ snippet: 'Fresh Acme provider response.' }],
          references: [{ link: 'https://acme.com/fresh' }],
        },
      },
      (call) => assert.equal(call.url.searchParams.get('no_cache'), 'true'),
    ));
});

test('OpenAI Batch completion continues to populate its persistent cache', async () => {
  const cachePuts: Array<{ rawResponse: string; ttlSeconds: number }> = [];
  const inserted: Array<{ raw_response: string }> = [];
  const db = {
    getPromptsByIds: async (promptIds: string[]) =>
      promptIds.includes(prompt.id) ? [prompt] : [],
    cachePut: async (
      _hash: string,
      _engine: string,
      _model: string,
      rawResponse: string,
      ttlSeconds: number,
    ) => {
      cachePuts.push({ rawResponse, ttlSeconds });
    },
    insertPromptResponse: async (response: { raw_response: string }) => {
      inserted.push(response);
    },
    updateRun: async () => {},
  } as Db;
  const run: Run = {
    id: 'batch-run',
    brand_id: brand.id,
    engine: 'chatgpt',
    mode: 'batch',
    status: 'in_progress',
    prompts_total: 1,
    prompts_completed: 0,
    batch_id: 'batch-1',
    batch_input_file_id: null,
    started_at: 0,
    completed_at: null,
    error: null,
  };
  const batchOutput = JSON.stringify({
    custom_id: prompt.id,
    response: { body: { choices: [{ message: { content: 'Fresh Acme provider response.' } }] } },
  });

  let request = 0;
  await withMockFetch(() => {
    request += 1;
    return request === 1
      ? jsonResponse({ status: 'completed', output_file_id: 'output-1' })
      : new Response(`${batchOutput}\n`);
  }, async (calls) => {
    const result = await collectBatch(
      { db, OPENAI_API_KEY: 'test-key' },
      run,
      brand,
    );
    assert.deepEqual(result, {
      ready: true,
      status: 'completed',
      completed: 1,
      failed: 0,
    });
    assert.equal(calls.length, 2);
  });

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].raw_response, 'Fresh Acme provider response.');
  assert.equal(cachePuts.length, 1);
  assert.equal(cachePuts[0].rawResponse, 'Fresh Acme provider response.');
  assert.equal(cachePuts[0].ttlSeconds, 30 * 24 * 60 * 60);
});
