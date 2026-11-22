import assert from 'node:assert/strict';
import test from 'node:test';

import { chatCompletion, MODEL, PRESET, runLive } from '../../src/core/perplexity.js';

test('Perplexity uses the Agent API fast preset and parses search-result URLs', async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  let seenInit: RequestInit | undefined;

  globalThis.fetch = async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return new Response(
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'search_results',
            queries: ['Acme visibility'],
            results: [
              { url: 'https://example.com/source-a' },
              { url: 'https://example.org/source-b' },
            ],
          },
          {
            type: 'message',
            content: [
              { type: 'output_text', text: 'Acme ' },
              { type: 'output_text', text: 'answer.' },
            ],
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const result = await chatCompletion('test-key', 'Where is Acme visible?', 'Be concise.');

    assert.equal(PRESET, 'fast');
    assert.equal(MODEL, 'preset:fast');
    assert.equal(seenUrl, 'https://api.perplexity.ai/v1/agent');
    assert.equal(seenInit?.method, 'POST');
    assert.deepEqual(JSON.parse(String(seenInit?.body)), {
      preset: 'fast',
      store: false,
      input: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Where is Acme visible?' },
      ],
      tools: [{ type: 'web_search' }],
      tool_choice: { type: 'web_search' },
      temperature: 0.3,
      max_output_tokens: 600,
    });
    assert.deepEqual(result, {
      text: 'Acme answer.',
      citations: ['https://example.com/source-a', 'https://example.org/source-b'],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Perplexity does not credit an unreferenced search result when inline source IDs are present', async () => {
  const originalFetch = globalThis.fetch;
  const persisted: Array<{
    brand_mentioned: number;
    brand_cited_with_link: number;
    cited_urls: string[];
    engine_citations?: string[];
  }> = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'completed',
    output: [
      { type: 'search_results', results: [
        { id: 5, url: 'https://acme.example/pricing' },
        { id: 7, url: 'https://research.example/report' },
        { id: 3, url: 'https://press.example/article' },
        { id: 8, url: 'https://unused.example/other' },
      ] },
      { type: 'message', content: [{
        type: 'output_text', text: 'Acme is mentioned in research [web:7] and news [3].',
      }] },
    ],
  }), { status: 200 });

  try {
    await runLive({
      PERPLEXITY_API_KEY: 'offline-test-key',
      db: {
        persistEngineRun: async (_runId, _engine, _model, _ttl, results) => {
          persisted.push(...results);
        },
      },
    } as Parameters<typeof runLive>[0], {
      domain: 'acme.example', name: 'Acme', competitors: [], aliases: [], exclude_terms: [],
    } as Parameters<typeof runLive>[1], [
      { id: 'one', text: 'Who mentions Acme?' },
    ] as Parameters<typeof runLive>[2], 'offline-run');

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].brand_mentioned, 1);
    assert.equal(persisted[0].brand_cited_with_link, 0);
    assert.deepEqual(persisted[0].engine_citations, [
      'https://research.example/report',
      'https://press.example/article',
    ]);
    assert.deepEqual(persisted[0].cited_urls, ['research.example', 'press.example']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Perplexity source IDs in code and hidden markup do not count as visible citations', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'completed',
    output: [
      { type: 'search_results', results: [
        { id: 1, url: 'https://acme.example/uncited' },
        { id: 7, url: 'https://research.example/actually-cited' },
      ] },
      { type: 'message', content: [{
        type: 'output_text',
        text: 'Example:\n```md\n[web:1]\n```\n`[1]` <!-- [web:1] --> <span hidden>[web:1]</span> Escaped \\[web:1]. Real source [web:7].',
      }] },
    ],
  }), { status: 200 });
  try {
    const result = await chatCompletion('offline-test-key', 'Question', 'System');
    assert.deepEqual(result.citations, ['https://research.example/actually-cited']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Perplexity does not fall back to uncited search results for hidden-only source markers', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'completed',
    output: [
      { type: 'search_results', results: [{ id: 1, url: 'https://acme.example/uncited' }] },
      { type: 'message', content: [{
        type: 'output_text', text: 'Code example:\n```text\n[web:1]\n```',
      }] },
    ],
  }), { status: 200 });
  try {
    const result = await chatCompletion('offline-test-key', 'Question', 'System');
    assert.deepEqual(result.citations, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Perplexity declines ambiguous or malformed inline source IDs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'completed',
    output: [
      { type: 'search_results', results: [
        { id: 7, url: 'https://acme.example/claim' },
        { id: 7, url: 'https://other.example/conflict' },
        { id: '9', url: 'https://acme.example/string-id' },
      ] },
      { type: 'message', content: [{
        type: 'output_text', text: 'Answer with conflicting [web:7] and invalid [9] sources.',
      }] },
    ],
  }), { status: 200 });
  try {
    const result = await chatCompletion('offline-test-key', 'Question', 'System');
    assert.deepEqual(result.citations, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Perplexity does not fall back to every search result for oversized inline IDs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'completed',
    output: [
      { type: 'search_results', results: [
        { id: 1, url: 'https://acme.example/uncited' },
      ] },
      { type: 'message', content: [{
        type: 'output_text', text: 'A citation with an invalid ID [web:9999999999999999999999].',
      }] },
    ],
  }), { status: 200 });
  try {
    const result = await chatCompletion('offline-test-key', 'Question', 'System');
    assert.deepEqual(result.citations, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Perplexity excludes non-web search-result references from native citations', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'completed',
    output: [
      { type: 'search_results', results: [
        { url: 'ftp://acme.example/private' },
        { url: 'file://acme.example/private' },
        { url: 'mailto:owner@acme.example' },
        { url: 'acme.example' },
        { url: 'https://acme.example@other.example/impersonation' },
        { url: 'https://admin:password@acme.example/private' },
        { url: 'http://localhost/private' },
        { url: 'https://127.0.0.1/debug' },
        { url: 'https://[::1]/debug' },
        { url: 'https://acme.example../malformed-root' },
        { url: 'HTTPS://source.example/reference' },
        { url: 'https://valid.example/page' },
      ] },
      { type: 'message', content: [
        { type: 'output_text', text: 'Independent answer with web sources.' },
      ] },
    ],
  }), { status: 200 });

  try {
    const result = await chatCompletion('test-key', 'Question', 'System');
    assert.deepEqual(result.citations, [
      'HTTPS://source.example/reference',
      'https://valid.example/page',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Perplexity treats HTTP-200 failed Agent responses as failures', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        status: 'failed',
        error: { message: 'provider failed', code: 'upstream_error' },
        output: [],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  try {
    await assert.rejects(
      () => chatCompletion('test-key', 'Question', 'System'),
      /Perplexity Agent API status failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Perplexity rejects completed Agent responses without output text', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        status: 'completed',
        output: [{ type: 'search_results', results: [] }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  try {
    await assert.rejects(
      () => chatCompletion('test-key', 'Question', 'System'),
      /response missing output_text/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Perplexity records non-Error provider rejections as failed prompts', async () => {
  const originalFetch = globalThis.fetch;
  const persisted: Array<{ status: string; error_message?: string }> = [];
  const env = {
    PERPLEXITY_API_KEY: 'offline-test',
    db: {
      persistEngineRun: async (
        _runId: string,
        _engine: string,
        _model: string,
        _ttl: number,
        results: Array<{ status: string; error_message?: string }>,
      ) => {
        persisted.push(...results);
      },
    },
  } as unknown as Parameters<typeof runLive>[0];
  const brand = {
    domain: 'acme.com', name: 'Acme', competitors: [], aliases: [], exclude_terms: [],
  } as Parameters<typeof runLive>[1];
  const prompts = [{ id: 'test-prompt', text: 'What is Acme?' }] as Parameters<
    typeof runLive
  >[2];

  globalThis.fetch = async () => {
    throw 'offline provider error';
  };
  try {
    await runLive(env, brand, prompts, 'offline-run');
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].status, 'failed');
    assert.match(persisted[0].error_message ?? '', /offline provider error/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Perplexity persists primitive database failures as failed run metadata', async () => {
  let recordedStatus: string | undefined;
  let recordedError: string | undefined;
  let recordedCompletedAt: number | undefined;
  const env = {
    PERPLEXITY_API_KEY: 'offline-test',
    db: {
      persistEngineRun: async () => {
        throw 'database offline';
      },
      updateRun: async (
        _id: string,
        update: { status: string; error: string; completed_at: number },
      ) => {
        recordedStatus = update.status;
        recordedError = update.error;
        recordedCompletedAt = update.completed_at;
      },
    },
  } as unknown as Parameters<typeof runLive>[0];
  const brand = { domain: 'acme.com', name: 'Acme' } as Parameters<typeof runLive>[1];

  await runLive(env, brand, [], 'offline-run');
  assert.equal(recordedStatus, 'failed');
  assert.equal(recordedError, 'database offline');
  assert.equal(typeof recordedCompletedAt, 'number');
});
