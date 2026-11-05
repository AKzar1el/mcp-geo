import assert from 'node:assert/strict';
import test from 'node:test';

import { chatCompletion, MODEL, runLive } from '../../src/core/gemini.js';

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
test('Gemini concatenates output text parts and excludes thinking parts', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [{
          content: { parts: [
            { text: 'Internal thoughts should never appear.', thought: true },
            { text: 'Acme ' },
            { text: 'is visible.' },
          ] },
          finishReason: 'STOP',
        }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  try {
    const result = await chatCompletion('test-key', 'Who is visible?', 'Be concise.');
    assert.equal(result, 'Acme is visible.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini records primitive provider rejections as failed prompts', async () => {
  const originalFetch = globalThis.fetch;
  const stored: Array<{ status: string; error_message?: string }> = [];
  const env = {
    GEMINI_API_KEY: 'offline-key',
    db: {
      persistEngineRun: async (
        _runId: string, _engine: string, _model: string, _ttl: number,
        results: Array<{ status: string; error_message?: string }>,
      ) => { stored.push(...results); },
    },
  } as unknown as Parameters<typeof runLive>[0];
  const brand = { domain: 'acme.com', name: 'Acme', competitors: [], aliases: [], exclude_terms: [] } as Parameters<typeof runLive>[1];
  const prompts = [{ id: 'offline-prompt', text: 'Where is Acme visible?' }] as Parameters<typeof runLive>[2];
  globalThis.fetch = async () => { throw 'offline Gemini rejection'; };
  try {
    await runLive(env, brand, prompts, 'offline-run');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, 'failed');
    assert.match(stored[0].error_message ?? '', /offline Gemini rejection/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini records primitive persistence rejections as failed runs', async () => {
  const updated: Array<{ status: string; error?: string }> = [];
  const env = {
    GEMINI_API_KEY: 'offline-key',
    db: {
      persistEngineRun: async () => { throw 'offline Gemini persist rejected'; },
      updateRun: async (_runId: string, update: { status: string; error?: string }) => {
        updated.push(update);
      },
    },
  } as unknown as Parameters<typeof runLive>[0];
  const brand = { domain: 'acme.com', name: 'Acme', competitors: [], aliases: [], exclude_terms: [] } as Parameters<typeof runLive>[1];
  await runLive(env, brand, [], 'offline-run');
  assert.equal(updated.length, 1);
  assert.equal(updated[0].status, 'failed');
  assert.match(updated[0].error ?? '', /offline Gemini persist rejected/);
});
