import assert from 'node:assert/strict';
import test from 'node:test';
import { chatCompletion, MODEL, runLive } from '../../src/core/anthropic.js';
import type { Brand, Db, EnginePromptResult, Prompt } from '../../src/db/types.js';

test('Anthropic joins all text blocks while ignoring non-text content', async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  globalThis.fetch = async (input) => {
    seenUrl = String(input);
    return new Response(JSON.stringify({
      stop_reason: 'end_turn',
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
    stop_reason: 'end_turn',
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

test('Anthropic rejects truncated but nonempty text rather than scoring a partial answer', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    stop_reason: 'max_tokens',
    content: [{ type: 'text', text: 'Partial Acme mention' }],
  }), { status: 200 });
  try {
    await assert.rejects(chatCompletion('test-key', 'Find Acme', 'Be concise.'), /response incomplete: max_tokens/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic live scan persists primitive provider rejections as failed prompt evidence', async () => {
  const originalFetch = globalThis.fetch;
  let persisted: EnginePromptResult[] | undefined;
  const db = {
    persistEngineRun: async (
      _runId: string, _engine: string, _model: string, _ttl: number,
      results: EnginePromptResult[],
    ) => { persisted = results; },
  } as Db;
  globalThis.fetch = (async () => { throw 'offline Anthropic provider string failure'; }) as typeof fetch;
  try {
    await runLive(
      { db, ANTHROPIC_API_KEY: 'offline-key' },
      { domain: 'acme.com', name: 'Acme', competitors: [], aliases: [], exclude_terms: [] } as Brand,
      [{ id: 'p1', text: 'Find Acme' } as Prompt],
      'offline-run',
    );
    assert.equal(persisted?.[0].status, 'failed');
    assert.equal(persisted?.[0].error_message, 'offline Anthropic provider string failure');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic live scan records primitive database persistence errors as terminal failures', async () => {
  let failure: { status?: string; error?: string } | undefined;
  const db = {
    persistEngineRun: async () => { throw 'offline Anthropic persistence string failure'; },
    updateRun: async (_runId: string, fields: { status?: string; error?: string }) => {
      failure = fields;
    },
  } as unknown as Db;
  await runLive(
    { db, ANTHROPIC_API_KEY: 'offline-key' },
    { domain: 'acme.com', name: 'Acme', competitors: [], aliases: [], exclude_terms: [] } as Brand,
    [],
    'offline-run',
  );
  assert.equal(failure?.status, 'failed');
  assert.equal(failure?.error, 'offline Anthropic persistence string failure');
});
