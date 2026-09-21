import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectBatch,
  runLive as runOpenAiLive,
} from '../../src/core/openai.ts';
import { runLive as runAnthropicLive } from '../../src/core/anthropic.ts';
import { runLive as runPerplexityLive } from '../../src/core/perplexity.ts';
import { runLive as runGeminiLive } from '../../src/core/gemini.ts';
import { runLive as runXAiLive } from '../../src/core/xai.ts';
import { runLive as runAiOverviewsLive } from '../../src/core/ai-overviews.ts';
import { runLive as runAiModeLive } from '../../src/core/ai-mode.ts';
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
  assertResult?: (result: EnginePromptResult) => void,
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
  assertResult?.(persisted[0]);
}

test('live scans bypass shared cached responses for every provider', async (t) => {
  await t.test('OpenAI', () =>
    assertLiveRunBypassesSharedCache(
      runOpenAiLive as LiveRunner,
      { OPENAI_API_KEY: 'test-key' },
      {
        choices: [{
          message: {
            content: 'Fresh Acme provider response.',
            annotations: [{
              type: 'url_citation',
              url_citation: { url: 'https://acme.com/source' },
            }],
          },
        }],
      },
      (call) => {
        assert.equal(call.url.pathname, '/v1/chat/completions');
        const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
        assert.equal(body.model, 'gpt-5-search-api');
        assert.deepEqual(body.web_search_options, { search_context_size: 'medium' });
        assert.equal('temperature' in body, false);
        assert.equal('max_tokens' in body, false);
      },
      (result) => {
        assert.deepEqual(result.engine_citations, ['https://acme.com/source']);
        assert.deepEqual(result.cited_urls, ['acme.com']);
        assert.equal(result.brand_cited_with_link, 1);
      },
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
        status: 'completed',
        output: [
          {
            type: 'search_results',
            queries: ['Acme'],
            results: [{ url: 'https://acme.com/fresh' }],
          },
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Fresh Acme provider response.' }],
          },
        ],
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
  await t.test('Grok', () =>
    assertLiveRunBypassesSharedCache(
      runXAiLive as LiveRunner,
      { XAI_API_KEY: 'test-key' },
      {
        output: [
          {
            type: 'message',
            content: [
              { type: 'output_text', text: 'Fresh Acme provider response.' },
            ],
          },
        ],
        citations: ['https://acme.com/fresh'],
      },
      (call) => {
        assert.equal(call.url.pathname, '/v1/responses');
        const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
        assert.equal(body.model, 'grok-4.6');
        assert.deepEqual(body.tools, [{ type: 'web_search' }]);
        assert.equal(body.tool_choice, 'required');
      },
      (result) => {
        assert.deepEqual(result.engine_citations, ['https://acme.com/fresh']);
        assert.deepEqual(result.cited_urls, ['acme.com']);
        assert.equal(result.brand_cited_with_link, 1);
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
  await t.test('Google AI Mode', () =>
    assertLiveRunBypassesSharedCache(
      runAiModeLive as LiveRunner,
      { SERPAPI_API_KEY: 'test-key', SERPAPI_AI_MODE_ENABLED: 'true' },
      {
        reconstructed_markdown: 'Fresh Acme provider response.',
        references: [{ link: 'https://acme.com/fresh' }],
      },
      (call) => {
        assert.equal(call.url.searchParams.get('engine'), 'google_ai_mode');
        assert.equal(call.url.searchParams.get('no_cache'), 'true');
      },
      (result) => {
        assert.deepEqual(result.engine_citations, ['https://acme.com/fresh']);
        assert.deepEqual(result.cited_urls, ['acme.com']);
        assert.equal(result.brand_cited_with_link, 1);
      },
    ));
});

test('OpenAI Batch completion continues to populate its persistent cache', async () => {
  let persisted: EnginePromptResult[] | undefined;
  let replaceExisting = false;
  let cacheTtlSeconds: number | undefined;
  const db = {
    getPromptsByIds: async (promptIds: string[]) =>
      promptIds.includes(prompt.id) ? [prompt] : [],
    persistEngineRun: async (
      _runId: string,
      _engine: string,
      _model: string,
      persistenceCacheTtlSeconds: number,
      results: EnginePromptResult[],
      options?: { replaceExisting?: boolean },
    ) => {
      persisted = results;
      replaceExisting = options?.replaceExisting === true;
      cacheTtlSeconds = persistenceCacheTtlSeconds;
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

  assert.ok(persisted);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].raw_response, 'Fresh Acme provider response.');
  assert.ok(persisted[0].cache_to_put);
  assert.equal(
    persisted[0].cache_to_put.raw_response,
    'Fresh Acme provider response.',
  );
  assert.equal(cacheTtlSeconds, 30 * 24 * 60 * 60);
  assert.equal(replaceExisting, true);
});

test('OpenAI Batch rejects invalid error-file IDs before persistence', async () => {
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

  async function expectIntegrityFailure(
    responses: Response[],
    expected: RegExp,
  ): Promise<void> {
    let persisted = false;
    const db = {
      getPromptsByIds: async (promptIds: string[]) =>
        promptIds.includes(prompt.id) ? [prompt] : [],
      persistEngineRun: async () => {
        persisted = true;
      },
      updateRun: async () => {},
    } as Db;
    let request = 0;
    await withMockFetch(() => responses[request++], async () => {
      await assert.rejects(
        collectBatch({ db, OPENAI_API_KEY: 'test-key' }, run, brand),
        expected,
      );
    });
    assert.equal(persisted, false);
  }

  await expectIntegrityFailure(
    [
      jsonResponse({ status: 'completed', error_file_id: 'error-1' }),
      new Response(JSON.stringify({ error: { message: 'missing ID' } })),
    ],
    /error file line missing custom_id/,
  );
  await expectIntegrityFailure(
    [
      jsonResponse({ status: 'completed', error_file_id: 'error-1' }),
      new Response(
        JSON.stringify({
          custom_id: 'unknown-prompt',
          error: { message: 'not submitted' },
        }),
      ),
    ],
    /custom_id.*unknown-prompt/,
  );
  await expectIntegrityFailure(
    [
      jsonResponse({
        status: 'completed',
        output_file_id: 'output-1',
        error_file_id: 'error-1',
      }),
      new Response(
        JSON.stringify({
          custom_id: prompt.id,
          response: {
            body: {
              choices: [{ message: { content: 'Acme success.' } }],
            },
          },
        }),
      ),
      new Response(
        JSON.stringify({
          custom_id: prompt.id,
          error: { message: 'conflicting failure' },
        }),
      ),
    ],
    /appears in both output and error files/,
  );
});
