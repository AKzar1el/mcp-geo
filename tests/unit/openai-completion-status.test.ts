import assert from 'node:assert/strict';
import test from 'node:test';
import { chatCompletion, runLive } from '../../src/core/openai.js';
import type { Brand, Db, EnginePromptResult, Prompt } from '../../src/db/types.js';

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

test('OpenAI live scan persists primitive provider rejections as failed prompt evidence', async () => {
  const originalFetch = globalThis.fetch;
  let persisted: EnginePromptResult[] | undefined;
  const db = {
    persistEngineRun: async (
      _runId: string, _engine: string, _model: string, _ttl: number,
      results: EnginePromptResult[],
    ) => { persisted = results; },
  } as Db;
  globalThis.fetch = (async () => { throw 'offline provider string failure'; }) as typeof fetch;
  try {
    await runLive(
      { db, OPENAI_API_KEY: 'offline-key' },
      { domain: 'acme.com', name: 'Acme', competitors: [], aliases: [], exclude_terms: [] } as Brand,
      [{ id: 'p1', text: 'Find Acme' } as Prompt],
      'offline-run',
    );
    assert.equal(persisted?.[0].status, 'failed');
    assert.equal(persisted?.[0].error_message, 'offline provider string failure');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI live scan records primitive database persistence errors as terminal failures', async () => {
  let failure: { status?: string; error?: string } | undefined;
  const db = {
    persistEngineRun: async () => { throw 'offline persistence string failure'; },
    updateRun: async (_runId: string, fields: { status?: string; error?: string }) => {
      failure = fields;
    },
  } as unknown as Db;
  await runLive(
    { db, OPENAI_API_KEY: 'offline-key' },
    { domain: 'acme.com', name: 'Acme', competitors: [], aliases: [], exclude_terms: [] } as Brand,
    [],
    'offline-run',
  );
  assert.equal(failure?.status, 'failed');
  assert.equal(failure?.error, 'offline persistence string failure');
});
