import assert from 'node:assert/strict';
import test from 'node:test';

import { chatCompletion, MODEL } from '../../src/core/perplexity.js';

test('Perplexity uses Agent API with grounded Sonar and parses search-result URLs', async () => {
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

    assert.equal(MODEL, 'perplexity/sonar');
    assert.equal(seenUrl, 'https://api.perplexity.ai/v1/agent');
    assert.equal(seenInit?.method, 'POST');
    assert.deepEqual(JSON.parse(String(seenInit?.body)), {
      model: 'perplexity/sonar',
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