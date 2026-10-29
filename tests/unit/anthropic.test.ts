import assert from 'node:assert/strict';
import test from 'node:test';
import { chatCompletion, MODEL } from '../../src/core/anthropic.js';

test('Anthropic joins all text blocks while ignoring non-text content', async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  globalThis.fetch = async (input) => {
    seenUrl = String(input);
    return new Response(JSON.stringify({
      content: [
        { type: 'text', text: 'Acme is visible.' },
        { type: 'thinking', thinking: 'not user-visible' },
        { type: 'text', text: 'It is cited at https://acme.test.' },
        { type: 'text', text: '' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await chatCompletion('test-key', 'Find Acme', 'Be concise.');
    assert.equal(MODEL, 'claude-haiku-4-5');
    assert.equal(seenUrl, 'https://api.anthropic.com/v1/messages');
    assert.equal(result, 'Acme is visible.\nIt is cited at https://acme.test.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic fails when response has no usable text blocks', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [{ type: 'thinking', thinking: 'not user-visible' }],
  }), { status: 200 });
  try {
    await assert.rejects(
      chatCompletion('test-key', 'Find Acme', 'Be concise.'),
      /missing text content block/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});