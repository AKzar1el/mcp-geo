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

test('OpenAI records primitive provider failures without aborting the run', async () => {
  const originalFetch = globalThis.fetch;
  const brand = { domain: 'acme.com', name: 'Acme', competitors: [], aliases: [], exclude_terms: [] } as Brand;
  const prompt = { id: 'offline-prompt', text: 'Where is Acme cited?' } as Prompt;
  let persisted: EnginePromptResult[] = [];
  const db = {
    persistEngineRun: async (
      _id: string, _engine: string, _model: string, _ttl: number, results: EnginePromptResult[],
    ) => { persisted = results; },
  } as Db;
  globalThis.fetch = (async () => { throw 'offline OpenAI provider failure'; }) as typeof fetch;
  try {
    await runLive({ db, OPENAI_API_KEY: 'offline-key' }, brand, [prompt], 'offline-run');
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].status, 'failed');
    assert.match(persisted[0].error_message ?? '', /offline OpenAI provider failure/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI preserves primitive persistence errors in failed run metadata', async () => {
  const updates: Array<{ status: string; error?: string }> = [];
  const brand = { domain: 'acme.com', name: 'Acme', competitors: [], aliases: [], exclude_terms: [] } as Brand;
  const db = {
    persistEngineRun: async () => { throw 'offline OpenAI persistence failure'; },
    updateRun: async (_id: string, update: { status: string; error?: string }) => {
      updates.push(update);
    },
  } as unknown as Db;
  await runLive({ db, OPENAI_API_KEY: 'offline-key' }, brand, [], 'offline-run');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, 'failed');
  assert.match(updates[0].error ?? '', /offline OpenAI persistence failure/);
});
