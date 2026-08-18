import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatCompletion,
  NO_AI_OVERVIEW,
} from '../../src/core/ai-overviews.ts';

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
