import assert from 'node:assert/strict';
import test from 'node:test';

import { chatCompletion, MODEL, runLive } from '../../src/core/gemini.js';
import type { Brand, Db, EnginePromptResult, Prompt } from '../../src/db/types.js';

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

test('Gemini retains primitive provider rejections as failed prompt evidence', async () => {
  const originalFetch = globalThis.fetch;
  let persisted: EnginePromptResult[] | undefined;
  const db = {
    persistEngineRun: async (
      _runId: string, _engine: string, _model: string, _ttl: number,
      results: EnginePromptResult[],
    ) => { persisted = results; },
  } as Db;
  globalThis.fetch = (async () => { throw 'offline Gemini provider failure'; }) as typeof fetch;
  try {
    await runLive(
      { db, GEMINI_API_KEY: 'offline-key' },
      { name: 'Acme', domain: 'acme.com', competitors: [], aliases: [], exclude_terms: [] } as Brand,
      [{ id: 'p1', text: 'Find Acme' } as Prompt],
      'offline-run',
    );
    assert.equal(persisted?.[0].status, 'failed');
    assert.equal(persisted?.[0].error_message, 'offline Gemini provider failure');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini URL API keys never enter provider failure errors, persisted rows, or logs', async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const secret = 'offline+Gemini/123';
  const encoded = encodeURIComponent(secret);
  const brand = { name: 'Acme', domain: 'acme.com', competitors: [], aliases: [], exclude_terms: [] } as Brand;
  const prompt = { id: 'p1', text: 'Find Acme' } as Prompt;
  const logs: string[] = [];
  let persisted: EnginePromptResult[] = [];
  const db = {
    persistEngineRun: async (
      _runId: string, _engine: string, _model: string, _ttl: number,
      results: EnginePromptResult[],
    ) => { persisted = results; },
  } as Db;

  try {
    console.error = (...args: unknown[]) => { logs.push(JSON.stringify(args)); };
    for (const failure of ['network', 'http'] as const) {
      globalThis.fetch = (async (input) => {
        if (failure === 'network') {
          throw new Error(`network refused ${String(input)} raw=${secret}`);
        }
        return new Response(`upstream rejected key=${secret}; encoded=${encoded}`, { status: 403 });
      }) as typeof fetch;
      await assert.rejects(
        chatCompletion(secret, 'Find Acme', 'Be concise.'),
        (error: Error) => {
          assert.match(error.message, failure === 'network' ? /network refused/ : /403/);
          assert.ok(!error.message.includes(secret));
          assert.ok(!error.message.includes(encoded));
          return true;
        },
      );
      await runLive({ db, GEMINI_API_KEY: secret }, brand, [prompt], `offline-${failure}`);
      assert.equal(persisted[0]?.status, 'failed');
      const exposed = [persisted[0]?.error_message ?? '', ...logs].join('\n');
      assert.ok(!exposed.includes(secret), 'raw Gemini key must remain private');
      assert.ok(!exposed.includes(encoded), 'encoded Gemini key must remain private');
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test('Gemini records primitive persistence errors as terminal failed run metadata', async () => {
  let failure: { status?: string; error?: string } | undefined;
  const db = {
    persistEngineRun: async () => { throw 'offline Gemini database failure'; },
    updateRun: async (_runId: string, update: { status?: string; error?: string }) => {
      failure = update;
    },
  } as unknown as Db;
  await runLive(
    { db, GEMINI_API_KEY: 'offline-key' },
    { name: 'Acme', domain: 'acme.com', competitors: [], aliases: [], exclude_terms: [] } as Brand,
    [],
    'offline-run',
  );
  assert.equal(failure?.status, 'failed');
  assert.equal(failure?.error, 'offline Gemini database failure');
});
