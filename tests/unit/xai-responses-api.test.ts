import assert from 'node:assert/strict';
import test from 'node:test';

import { chatCompletion, MODEL, runLive } from '../../src/core/xai.js';

test('xAI uses Responses API with required web search and captures only answer-linked citations', async () => {
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
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Acme is visible in this answer.',
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://acme.example/source',
                    start_index: 0,
                    end_index: 10,
                  },
                ],
              },
            ],
          },
        ],
        citations: [
          'https://example.com/source-a',
          { url: 'https://example.org/source-b' },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const result = await chatCompletion(
      'test-key',
      'Where is Acme visible?',
      'Be concise.',
    );

    assert.equal(MODEL, 'grok-4.7');
    assert.equal(seenUrl, 'https://api.x.ai/v1/responses');
    assert.equal(seenInit?.method, 'POST');
    assert.equal(
      (seenInit?.headers as Record<string, string>).Authorization,
      'Bearer test-key',
    );
    assert.deepEqual(JSON.parse(String(seenInit?.body)), {
      model: 'grok-4.7',
      store: false,
      input: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Where is Acme visible?' },
      ],
      tools: [{ type: 'web_search' }],
      tool_choice: 'required',
    });
    assert.deepEqual(result, {
      text: 'Acme is visible in this answer.',
      citations: ['https://acme.example/source'],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('xAI surfaces non-2xx Responses API failures', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('{"error":{"message":"bad key"}}', { status: 401 });

  try {
    await assert.rejects(
      () => chatCompletion('bad-key', 'Question', 'System'),
      /xAI Responses API failed: 401/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('xAI only returns valid web citation evidence from provider metadata', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{
      type: 'output_text', text: 'The answer names Acme.',
      annotations: [
        { url: 'ftp://acme.example/other' },
        { type: 'url_citation', url_citation: { url: 'https://acme.example/article' }, start_index: 0, end_index: 8 },
        { type: 'url_citation', url: 'https://acme.example/unpositioned-outside-text', start_index: 200, end_index: 210 },
        { url: 'https://example.org:bad/path' },
        { url_citation: { url: 'https://[::1]/internal' } },
        { url: 'https://acme.example../malformed-root' },
      ],
    }, {
      type: 'output_text',
      annotations: [{ type: 'url_citation', url: 'https://acme.example/no-answer-text', start_index: 0, end_index: 5 }],
    }] }],
    citations: [
      'acme.example',
      'javascript:alert(1)',
      'https://user:password@example.com/private',
      'http://localhost/internal',
      'https://127.0.0.1/secret',
      'https://example.org/source',
      { url: 'https://acme.example/article' },
    ],
  }), { status: 200 });
  try {
    const result = await chatCompletion('test-key', 'Question', 'System');
    assert.deepEqual(result.citations, ['https://acme.example/article']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('xAI search-encountered brand URLs do not inflate answer-linked brand evidence', async () => {
  const originalFetch = globalThis.fetch;
  const persisted: Array<{ brand_cited_with_link: number; cited_urls: string[]; engine_citations?: string[] }> = [];
  const env = {
    XAI_API_KEY: 'offline-key',
    db: {
      persistEngineRun: async (
        _runId: string, _engine: string, _model: string, _ttl: number,
        results: typeof persisted,
      ) => { persisted.push(...results); },
    },
  } as unknown as Parameters<typeof runLive>[0];
  const brand = {
    domain: 'acme.example', name: 'Acme', competitors: [], aliases: [], exclude_terms: [],
  } as Parameters<typeof runLive>[1];
  const prompts = [{ id: 'p1', text: 'What are the options?' }] as Parameters<typeof runLive>[2];
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{
      type: 'output_text', text: 'Acme was mentioned, but no sources linked.',
      annotations: [{ type: 'url_citation', url: 'https://acme.example/encountered-unpositioned' }],
    }] }],
    citations: ['https://acme.example/visited-only'],
  }), { status: 200 });

  try {
    await runLive(env, brand, prompts, 'offline-run');
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].brand_cited_with_link, 0);
    assert.deepEqual(persisted[0].cited_urls, []);
    assert.deepEqual(persisted[0].engine_citations, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('xAI rejects responses without output text', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: 'completed', output: [], citations: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    await assert.rejects(
      () => chatCompletion('test-key', 'Question', 'System'),
      /xAI response missing output_text/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('xAI rejects nonterminal Responses API status even when output text exists', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'incomplete',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'Partial Acme mention' }] }],
  }), { status: 200 });
  try {
    await assert.rejects(chatCompletion('test-key', 'Question', 'System'), /response incomplete: incomplete/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
