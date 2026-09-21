import assert from 'node:assert/strict';
import test from 'node:test';

import { chatCompletion, MODEL } from '../../src/core/xai.js';

test('xAI uses Responses API with required web search and captures citations', async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  let seenInit: RequestInit | undefined;

  globalThis.fetch = async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return new Response(
      JSON.stringify({
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

    assert.equal(MODEL, 'grok-4.6');
    assert.equal(seenUrl, 'https://api.x.ai/v1/responses');
    assert.equal(seenInit?.method, 'POST');
    assert.equal(
      (seenInit?.headers as Record<string, string>).Authorization,
      'Bearer test-key',
    );
    assert.deepEqual(JSON.parse(String(seenInit?.body)), {
      model: 'grok-4.6',
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
    new Response(JSON.stringify({ output: [], citations: [] }), {
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
