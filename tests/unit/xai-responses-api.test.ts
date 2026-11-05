import assert from 'node:assert/strict';
import test from 'node:test';

import { chatCompletion, MODEL, runLive } from '../../src/core/xai.js';
import type { Brand, Db, EnginePromptResult, Prompt } from '../../src/db/types.js';

test('xAI uses Responses API with required web search and captures citations', async () => {
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
                    url_citation: { url: 'https://acme.example/source' },
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
      citations: [
        'https://example.com/source-a',
        'https://example.org/source-b',
        'https://acme.example/source',
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('xAI ignores non-web native citation metadata while keeping HTTP(S) sources', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'completed',
    output: [{
      type: 'message',
      content: [{
        type: 'output_text',
        text: 'This answer contains independently linked sources.',
        annotations: [
          { url: 'file://acme.example/private' },
          { url_citation: { url: 'https://annotated.example/article' } },
          { url_citation: { url: 'javascript:alert(1)' } },
        ],
      }],
    }],
    citations: [
      'ftp://acme.example/record',
      'mailto:editor@acme.example',
      'acme.example',
      'HTTPS://web.example/story',
      { url: 'https://source.example/report' },
      { url: 'data:text/plain,example' },
    ],
  }), { status: 200 });

  try {
    const result = await chatCompletion('test-key', 'Question', 'System');
    assert.deepEqual(result.citations, [
      'HTTPS://web.example/story',
      'https://source.example/report',
      'https://annotated.example/article',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('xAI does not persist non-web URI metadata as citation evidence', async () => {
  const originalFetch = globalThis.fetch;
  let saved: EnginePromptResult[] | undefined;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{
      type: 'output_text', text: 'The answer names no brand or competitor.',
    }] }],
    citations: [
      'ftp://acme.example/source',
      'file://acme.example/source',
      'mailto:owner@acme.example',
      'https://unrelated.example/article',
    ],
  }), { status: 200 });

  const brand: Brand = {
    id: 'brand-1', user_id: 'user-1', domain: 'acme.example', name: 'Acme',
    category: 'Software', competitors: [], aliases: [], exclude_terms: [],
    refresh_frequency: 'weekly', created_at: 0, updated_at: 0,
  };
  const db = {
    persistEngineRun: async (
      _runId: string, _engine: string, _model: string,
      _ttl: number, results: EnginePromptResult[],
    ) => { saved = results; },
  } as unknown as Db;

  try {
    await runLive({ db, XAI_API_KEY: 'test-key' }, brand, [
      { id: 'prompt-1', text: 'Which tools are available?' } as Prompt,
    ], 'run-1');
    assert.equal(saved?.[0].status, 'ok');
    assert.deepEqual(saved?.[0].engine_citations, ['https://unrelated.example/article']);
    assert.deepEqual(saved?.[0].cited_urls, ['unrelated.example']);
    assert.equal(saved?.[0].brand_cited_with_link, 0);
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
