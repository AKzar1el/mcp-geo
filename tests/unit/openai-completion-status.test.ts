import assert from 'node:assert/strict';
import test from 'node:test';
import { chatCompletion } from '../../src/core/openai.js';

test('OpenAI rejects text with length finish reason as an incomplete answer', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      finish_reason: 'length',
      message: { content: 'Partial Acme mention' },
    }],
  }), { status: 200 });
  try {
    await assert.rejects(chatCompletion('test-key', 'Find Acme'), /response incomplete: length/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI accepts normal completed answer text and preserves citations', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      finish_reason: 'stop',
      message: {
        content: 'Acme is cited.',
        annotations: [{ type: 'url_citation', url_citation: { url: 'https://acme.com/source' } }],
      },
    }],
  }), { status: 200 });
  try {
    assert.deepEqual(await chatCompletion('test-key', 'Find Acme'), {
      text: 'Acme is cited.',
      citations: ['https://acme.com/source'],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
