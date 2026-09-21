import assert from 'node:assert/strict';
import test from 'node:test';

import { chatCompletion, MODEL } from '../../src/core/gemini.js';

test('Gemini uses the current Flash-Lite model with the existing GenerateContent contract', async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  let seenInit: RequestInit | undefined;

  globalThis.fetch = async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: 'Acme answer.' }] },
            finishReason: 'STOP',
          },
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

    assert.equal(MODEL, 'gemini-3.1-flash-lite');
    assert.equal(
      seenUrl,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=test-key',
    );
    assert.equal(seenInit?.method, 'POST');
    assert.deepEqual(JSON.parse(String(seenInit?.body)), {
      systemInstruction: { parts: [{ text: 'Be concise.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Where is Acme visible?' }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 600,
      },
    });
    assert.equal(result, 'Acme answer.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
