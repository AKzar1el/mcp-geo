import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectBatch,
  submitBatch,
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
        assert.equal(body.model, 'grok-4.7');
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

test('OpenAI Batch completed result files must cover every submitted prompt', async () => {
  let persisted = false;
  const db = {
    getPromptsByIds: async (ids: string[]) =>
      ids.includes(prompt.id) ? [prompt] : [],
    persistEngineRun: async () => { persisted = true; },
    updateRun: async () => {},
  } as unknown as Db;
  const run: Run = {
    id: 'cardinality-batch-run', brand_id: brand.id, engine: 'chatgpt',
    mode: 'batch', status: 'in_progress', prompts_total: 2,
    prompts_completed: 0, batch_id: 'batch-cardinality',
    batch_input_file_id: null, started_at: 0, completed_at: null, error: null,
  };
  const resultLine = JSON.stringify({
    custom_id: prompt.id,
    response: { body: { choices: [{ message: { content: 'One response only.' } }] } },
  });
  let request = 0;
  await withMockFetch(
    () => (++request === 1
      ? jsonResponse({ status: 'completed', output_file_id: 'incomplete-output' })
      : new Response(resultLine + '\n')),
    async () => {
      await assert.rejects(
        collectBatch({ db, OPENAI_API_KEY: 'test-key' }, run, brand),
        /completed batch returned 1 result row\(s\) for 2 submitted prompts/,
      );
    },
  );
  assert.equal(persisted, false);
});
test('OpenAI Batch terminal failures without files stop polling and close the run', async () => {
  for (const status of ['failed', 'expired', 'cancelled']) {
    const updates: Array<Partial<Run>> = [];
    let persisted = false;
    const db = {
      updateRun: async (_runId: string, fields: Partial<Run>) => { updates.push(fields); },
      persistEngineRun: async () => { persisted = true; },
    } as unknown as Db;
    const run: Run = {
      id: 'terminal-batch-run',
      brand_id: brand.id,
      engine: 'chatgpt',
      mode: 'batch',
      status: 'in_progress',
      prompts_total: 2,
      prompts_completed: 0,
      batch_id: 'batch-terminal',
      batch_input_file_id: null,
      started_at: 0,
      completed_at: null,
      error: null,
    } as Run;
    await withMockFetch(
      () => jsonResponse({ status, output_file_id: null, error_file_id: null }),
      async (calls) => {
        const result = await collectBatch(
          { db, OPENAI_API_KEY: 'test-key' }, run, brand,
        );
        assert.deepEqual(result, { ready: true, status, completed: 0, failed: 2 });
        assert.equal(calls.length, 1);
      },
    );
    assert.equal(updates.length, 1);
    assert.equal(updates[0].status, 'failed');
    assert.match(String(updates[0].error), new RegExp(status));
    assert.equal(typeof updates[0].completed_at, 'number');
    assert.equal(persisted, false);
  }
});

test('OpenAI Batch expiry preserves available partial results and records failure', async () => {
  const updates: Array<Partial<Run>> = [];
  let persisted: EnginePromptResult[] | undefined;
  const db = {
    getPromptsByIds: async (ids: string[]) =>
      ids.includes(prompt.id) ? [prompt] : [],
    persistEngineRun: async (
      _runId: string, _engine: string, _model: string,
      _ttl: number, results: EnginePromptResult[],
    ) => { persisted = results; },
    updateRun: async (_runId: string, fields: Partial<Run>) => { updates.push(fields); },
  } as Db;
  const run: Run = {
    id: 'partial-batch-run',
    brand_id: brand.id,
    engine: 'chatgpt',
    mode: 'batch',
    status: 'in_progress',
    prompts_total: 2,
    prompts_completed: 0,
    batch_id: 'batch-expired',
    batch_input_file_id: null,
    started_at: 0,
    completed_at: null,
    error: null,
  } as Run;
  const output = JSON.stringify({
    custom_id: prompt.id,
    response: { body: { choices: [{ message: { content: 'Partial Acme response.' } }] } },
  });
  let request = 0;
  await withMockFetch(
    () => (++request === 1
      ? jsonResponse({ status: 'expired', output_file_id: 'partial-output' })
      : new Response(output + '\n')),
    async (calls) => {
      const result = await collectBatch(
        { db, OPENAI_API_KEY: 'test-key' }, run, brand,
      );
      assert.deepEqual(result, {
        ready: true, status: 'expired', completed: 1, failed: 1,
      });
      assert.equal(calls.length, 2);
    },
  );
  assert.equal(persisted?.length, 1);
  assert.equal(persisted?.[0].raw_response, 'Partial Acme response.');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, 'failed');
  assert.match(String(updates[0].error), /1\/2 prompt results available/);
  assert.equal(typeof updates[0].completed_at, 'number');
});

test('OpenAI Batch cancellation-in-progress remains pending until terminal', async () => {
  const updates: Array<Partial<Run>> = [];
  const db = {
    updateRun: async (_runId: string, fields: Partial<Run>) => { updates.push(fields); },
  } as unknown as Db;
  const run: Run = {
    id: 'cancelling-batch-run', brand_id: brand.id, engine: 'chatgpt',
    mode: 'batch', status: 'in_progress', prompts_total: 1, prompts_completed: 0,
    batch_id: 'batch-cancelling', batch_input_file_id: null,
    started_at: 0, completed_at: null, error: null,
  } as Run;
  await withMockFetch(
    () => jsonResponse({ status: 'cancelling' }),
    async () => {
      const result = await collectBatch(
        { db, OPENAI_API_KEY: 'test-key' }, run, brand,
      );
      assert.deepEqual(result, { ready: false, status: 'cancelling' });
    },
  );
  assert.deepEqual(updates, [{ status: 'in_progress' }]);
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

test('OpenAI Batch submit preserves JSONL prompt identities and provider contract offline', async () => {
  const updated: Array<{ id: string; fields: Record<string, unknown> }> = [];
  const db = {
    updateRun: async (id: string, fields: Record<string, unknown>) => {
      updated.push({ id, fields });
    },
  } as Db;
  const prompts = [
    prompt,
    { ...prompt, id: 'prompt-2', text: 'Compare Acme and Beta.' },
  ];
  let responseNumber = 0;
  await withMockFetch(() => {
    responseNumber += 1;
    return responseNumber === 1
      ? jsonResponse({ id: 'file-123' })
      : jsonResponse({ id: 'batch-123', status: 'validating' });
  }, async (calls) => {
    const result = await submitBatch(
      { db, OPENAI_API_KEY: 'test-key' },
      brand,
      prompts,
      'batch-fixture',
    );
    assert.deepEqual(result, {
      batch_id: 'batch-123',
      input_file_id: 'file-123',
    });
    assert.equal(calls.length, 2);

    const [upload, create] = calls;
    assert.equal(upload.url.pathname, '/v1/files');
    assert.equal(upload.init?.method, 'POST');
    assert.ok(upload.init?.body instanceof FormData);
    const form = upload.init.body;
    assert.equal(form.get('purpose'), 'batch');
    const file = form.get('file');
    assert.ok(file instanceof Blob);
    assert.equal(file.type, 'application/jsonl');
    assert.equal((file as File).name, 'geo-mcp-run-batch-fixture.jsonl');
    const raw = await file.text();
    assert.ok(raw.endsWith('\n'));
    const lines = raw.trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.custom_id), ['prompt-1', 'prompt-2']);
    for (const [index, line] of lines.entries()) {
      assert.equal(line.method, 'POST');
      assert.equal(line.url, '/v1/chat/completions');
      assert.equal(line.body.model, 'gpt-4o-mini');
      assert.equal(line.body.temperature, 0.3);
      assert.equal(line.body.max_tokens, 600);
      assert.equal(line.body.messages[0].role, 'system');
      assert.deepEqual(line.body.messages[1], {
        role: 'user',
        content: prompts[index].text,
      });
    }

    assert.equal(create.url.pathname, '/v1/batches');
    assert.equal(create.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(create.init?.body)), {
      input_file_id: 'file-123',
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    });
  });
  assert.deepEqual(updated, [{
    id: 'batch-fixture',
    fields: { batch_id: 'batch-123', status: 'in_progress' },
  }]);
});

test('OpenAI Batch rejects upload failure without batch creation or run mutation', async () => {
  const db = {
    updateRun: async () => { throw new Error('unexpected run mutation'); },
  } as unknown as Db;
  await withMockFetch(new Response('rate limited', { status: 429 }), async (calls) => {
    await assert.rejects(
      submitBatch({ db, OPENAI_API_KEY: 'test-key' }, brand, [prompt], 'batch-failed'),
      /OpenAI file upload failed: 429/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, '/v1/files');
  });
});
