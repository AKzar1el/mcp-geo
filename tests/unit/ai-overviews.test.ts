import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatCompletion,
  NO_AI_OVERVIEW,
  runLive,
} from '../../src/core/ai-overviews.ts';
import type { Brand, Db, EnginePromptResult, Prompt } from '../../src/db/types.ts';

type FetchCall = {
  url: URL;
  init: RequestInit | undefined;
};

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

test('AI Overview direct content uses one normal Google request', async () => {
  await withMockFetch(
    [
      jsonResponse({
        ai_overview: {
          text_blocks: [{ snippet: 'Acme is a project management tool.' }],
          references: [{ link: 'https://acme.com/about' }],
        },
      }),
    ],
    async (calls) => {
      const result = await chatCompletion('test-key', 'What is Acme?');
      assert.equal(result.text, 'Acme is a project management tool.');
      assert.deepEqual(result.citations, ['https://acme.com/about']);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url.searchParams.get('engine'), 'google');
    },
  );
});

test('AI Overview counts only HTTP(S) provider references as source evidence', async () => {
  await withMockFetch(
    [jsonResponse({
      ai_overview: {
        text_blocks: [{ snippet: 'Independent summary of Acme.' }],
        references: [
          { link: 'ftp://acme.example/private' },
          { link: 'mailto:press@acme.example' },
          { link: 'file://acme.example/private' },
          { link: 'javascript:alert(1)' },
          { link: 'acme.example' },
          { link: 'https://' },
          { link: 'https://acme.example@attacker.example/misleading' },
          { link: 'https://user:password@acme.example/private' },
          { link: 'HTTPS://source.example/article' },
          { link: 'http://valid.example/page' },
        ],
      },
    })],
    async (calls) => {
      const result = await chatCompletion('test-key', 'Acme');
      assert.equal(result.text, 'Independent summary of Acme.');
      assert.deepEqual(result.citations, [
        'HTTPS://source.example/article',
        'http://valid.example/page',
      ]);
      assert.equal(calls.length, 1, 'reference validation must not trigger another paid search');
    },
  );
});

test('AI Overview retains list titles, nested answer content and excludes source metadata', async () => {
  await withMockFetch(
    [
      jsonResponse({
        ai_overview: {
          text_blocks: [
            { type: 'heading', snippet: 'Recommendations' },
            {
              type: 'list',
              list: [
                {
                  title: 'Acme Analytics:',
                  snippet: 'Useful for teams.',
                  text_blocks: [{ type: 'paragraph', text: 'Acme reporting is detailed.' }],
                  list: [{ title: 'Acme Dashboards', snippet: 'A nested capability.' }],
                },
                { title: 'Title-only Acme' },
              ],
            },
          ],
          references: [{
            title: 'Unrelated source metadata should not be answer text',
            link: 'https://source.example/acme',
          }],
        },
      }),
    ],
    async (calls) => {
      const result = await chatCompletion('test-key', 'best analytics');
      assert.equal(
        result.text,
        'Recommendations\n\n• Acme Analytics: Useful for teams.\n\nAcme reporting is detailed.\n\n• Acme Dashboards A nested capability.\n\n• Title-only Acme',
      );
      assert.deepEqual(result.citations, ['https://source.example/acme']);
      assert.doesNotMatch(result.text, /Unrelated source metadata/);
      assert.equal(calls.length, 1, 'parsing must not trigger extra paid searches');
    },
  );
});

test('AI Overview page token is immediately resolved through the SerpAPI endpoint', async () => {
  await withMockFetch(
    [
      jsonResponse({
        ai_overview: {
          page_token: 'short-lived-token',
          serpapi_link: 'https://untrusted.example/should-not-be-fetched',
        },
      }),
      jsonResponse({
        ai_overview: {
          text_blocks: [{ snippet: 'Acme is returned by the follow-up.' }],
          references: [{ link: 'https://acme.com/follow-up' }],
        },
      }),
    ],
    async (calls) => {
      const result = await chatCompletion('test-key', 'What is Acme?');
      assert.equal(result.text, 'Acme is returned by the follow-up.');
      assert.deepEqual(result.citations, ['https://acme.com/follow-up']);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url.searchParams.get('engine'), 'google');
      assert.equal(calls[1].url.origin, 'https://serpapi.com');
      assert.equal(calls[1].url.pathname, '/search.json');
      assert.equal(calls[1].url.searchParams.get('engine'), 'google_ai_overview');
      assert.equal(calls[1].url.searchParams.get('page_token'), 'short-lived-token');
      assert.equal(calls[1].url.searchParams.get('api_key'), 'test-key');
      assert.equal(calls[1].url.searchParams.get('no_cache'), 'true');
    },
  );
});

test('AI Overview follows a page token even when the initial response has only references', async () => {
  await withMockFetch(
    [
      jsonResponse({
        ai_overview: {
          references: [{ link: 'https://acme.com/unrelated-reference' }],
          page_token: 'references-first-token',
        },
      }),
      jsonResponse({
        ai_overview: {
          text_blocks: [{ snippet: 'The follow-up contains the actual answer.' }],
          references: [{ link: 'https://example.com/answer' }],
        },
      }),
    ],
    async (calls) => {
      const result = await chatCompletion('test-key', 'What is Acme?');
      assert.equal(result.text, 'The follow-up contains the actual answer.');
      assert.deepEqual(result.citations, ['https://example.com/answer']);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].url.searchParams.get('engine'), 'google_ai_overview');
      assert.equal(calls[1].url.searchParams.get('page_token'), 'references-first-token');
    },
  );
});

test('AI Overview ignores reference-only results with no page token', async () => {
  await withMockFetch(
    [jsonResponse({ ai_overview: { references: [{ link: 'https://acme.com/' }] } })],
    async (calls) => {
      assert.deepEqual(await chatCompletion('test-key', 'Acme'), {
        text: NO_AI_OVERVIEW,
        citations: [],
      });
      assert.equal(calls.length, 1);
    },
  );
});

test('AI Overview rejects a reference-only page-token follow-up', async () => {
  await withMockFetch(
    [
      jsonResponse({ ai_overview: { page_token: 'token' } }),
      jsonResponse({ ai_overview: { references: [{ link: 'https://acme.com/' }] } }),
    ],
    async (calls) => {
      await assert.rejects(
        chatCompletion('test-key', 'Acme'),
        /follow-up returned no usable content/,
      );
      assert.equal(calls.length, 2);
    },
  );
});

test('AI Overview page-token follow-up failures throw', async () => {
  await withMockFetch(
    [
      jsonResponse({ ai_overview: { page_token: 'short-lived-token' } }),
      jsonResponse({ error: 'page token expired' }),
    ],
    async (calls) => {
      await assert.rejects(
        chatCompletion('test-key', 'What is Acme?'),
        /SerpAPI error: page token expired/,
      );
      assert.equal(calls.length, 2);
    },
  );
});

test('Google results without an AI Overview return the no-overview sentinel', async () => {
  await withMockFetch(
    [jsonResponse({ organic_results: [] })],
    async (calls) => {
      const result = await chatCompletion('test-key', 'What is Acme?');
      assert.deepEqual(result, { text: NO_AI_OVERVIEW, citations: [] });
      assert.equal(calls.length, 1);
    },
  );
});

test('AI Overview records primitive provider failures as failed prompts', async () => {
  const originalFetch = globalThis.fetch;
  const brand = { domain: 'acme.com', name: 'Acme', competitors: [], aliases: [], exclude_terms: [] } as Brand;
  const prompt = { id: 'offline-prompt', text: 'How is Acme mentioned?' } as Prompt;
  let persisted: EnginePromptResult[] = [];
  const db = {
    persistEngineRun: async (
      _id: string, _engine: string, _model: string, _ttl: number, results: EnginePromptResult[],
    ) => { persisted = results; },
  } as Db;
  globalThis.fetch = (async () => { throw 'offline AI Overview provider failure'; }) as typeof fetch;
  try {
    await runLive({ db, SERPAPI_API_KEY: 'offline-key' }, brand, [prompt], 'offline-run');
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].status, 'failed');
    assert.match(persisted[0].error_message ?? '', /offline AI Overview provider failure/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI Overview preserves primitive persistence errors on failed runs', async () => {
  const updates: Array<{ status: string; error?: string }> = [];
  const brand = { domain: 'acme.com', name: 'Acme', competitors: [], aliases: [], exclude_terms: [] } as Brand;
  const db = {
    persistEngineRun: async () => { throw 'offline AI Overview persistence failure'; },
    updateRun: async (_id: string, update: { status: string; error?: string }) => {
      updates.push(update);
    },
  } as unknown as Db;
  await runLive({ db, SERPAPI_API_KEY: 'offline-key' }, brand, [], 'offline-run');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, 'failed');
  assert.match(updates[0].error ?? '', /offline AI Overview persistence failure/);
});
