import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion, MODEL, runLive } from '../../src/core/ai-mode.ts';
import type { Brand, Db, EnginePromptResult, Prompt } from '../../src/db/types.ts';

type FetchCall = { url: URL; init: RequestInit | undefined };

async function withMockFetch(
  responses: Array<Response | Error>,
  assertion: (calls: FetchCall[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: new URL(input.toString()), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch call');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  try {
    await assertion(calls);
    assert.equal(responses.length, 0, 'all mocked responses should be consumed');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Google AI Mode uses the dedicated SerpAPI engine and reconstructed markdown', async () => {
  await withMockFetch(
    [
      jsonResponse({
        reconstructed_markdown: 'Acme is recommended for teams.',
        references: [{ link: 'https://acme.com/' }],
      }),
    ],
    async (calls) => {
      const result = await chatCompletion('test-key', 'best project management tools');
      assert.equal(MODEL, 'serpapi-google-ai-mode');
      assert.equal(result.text, 'Acme is recommended for teams.');
      assert.deepEqual(result.citations, ['https://acme.com/']);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url.origin, 'https://serpapi.com');
      assert.equal(calls[0].url.pathname, '/search.json');
      assert.equal(calls[0].url.searchParams.get('engine'), 'google_ai_mode');
      assert.equal(calls[0].url.searchParams.get('q'), 'best project management tools');
      assert.equal(calls[0].url.searchParams.get('gl'), 'us');
      assert.equal(calls[0].url.searchParams.get('hl'), 'en');
      assert.equal(calls[0].url.searchParams.get('no_cache'), 'true');
    },
  );
});

test('Google AI Mode falls back to text blocks when reconstructed markdown is absent', async () => {
  await withMockFetch(
    [
      jsonResponse({
        text_blocks: [
          { snippet: 'Acme is cited.' },
          { list: [{ snippet: 'Fast setup' }, { text: 'Good reporting' }] },
        ],
        references: [{ link: 'https://example.com/source' }],
      }),
    ],
    async () => {
      const result = await chatCompletion('test-key', 'Acme');
      assert.equal(result.text, 'Acme is cited.\n\n- Fast setup\n\n- Good reporting');
      assert.deepEqual(result.citations, ['https://example.com/source']);
    },
  );
});

test('Google AI Mode rejects provider errors and empty payloads', async () => {
  await withMockFetch(
    [jsonResponse({ error: 'quota exceeded' })],
    async () => {
      await assert.rejects(chatCompletion('test-key', 'Acme'), /quota exceeded/);
    },
  );
  await withMockFetch(
    [jsonResponse({})],
    async () => {
      await assert.rejects(chatCompletion('test-key', 'Acme'), /no usable content/);
    },
  );
});


test('Google AI Mode runLive skips without the explicit cost opt-in', async () => {
  const brand: Brand = {
    id: 'acme', user_id: 'user', domain: 'acme.com', name: 'Acme', category: null,
    competitors: [], aliases: [], exclude_terms: [], refresh_frequency: 'weekly',
    created_at: 0, updated_at: 0,
  };
  const prompt: Prompt = {
    id: 'p1', brand_id: 'acme', text: 'What is Acme?', intent_stage: null, shape: null,
    active: 1, created_at: 0,
  };
  let persisted: EnginePromptResult[] | undefined;
  const db = {
    persistEngineRun: async (
      _runId: string, _engine: string, _model: string, _ttl: number, results: EnginePromptResult[],
    ) => { persisted = results; },
  } as Db;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('fetch must not run when AI Mode opt-in is disabled');
  }) as typeof fetch;
  try {
    await runLive(
      { db, SERPAPI_API_KEY: 'test-key', SERPAPI_AI_MODE_ENABLED: 'false' },
      brand,
      [prompt],
      'run-1',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(persisted);
  assert.equal(persisted[0].status, 'skipped');
  assert.match(persisted[0].error_message ?? '', /SERPAPI_AI_MODE_ENABLED/);
});
