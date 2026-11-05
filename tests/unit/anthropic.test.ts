import assert from 'node:assert/strict';
import test from 'node:test';
import { chatCompletion, MODEL, runLive } from '../../src/core/anthropic.js';

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

test('Anthropic persists primitive provider rejections as failed prompts', async () => {
  const originalFetch = globalThis.fetch;
  const persisted: Array<{ status: string; error_message?: string }> = [];
  const env = {
    ANTHROPIC_API_KEY: 'offline-test',
    db: {
      persistEngineRun: async (
        _runId: string,
        _engine: string,
        _model: string,
        _ttl: number,
        results: Array<{ status: string; error_message?: string }>,
      ) => {
        persisted.push(...results);
      },
    },
  } as unknown as Parameters<typeof runLive>[0];
  const brand = {
    domain: 'acme.com', name: 'Acme', competitors: [], aliases: [], exclude_terms: [],
  } as Parameters<typeof runLive>[1];
  const prompts = [{ id: 'test-prompt', text: 'What is Acme?' }] as Parameters<
    typeof runLive
  >[2];

  globalThis.fetch = async () => {
    throw 'offline Anthropic rejection';
  };
  try {
    await runLive(env, brand, prompts, 'offline-run');
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].status, 'failed');
    assert.match(persisted[0].error_message ?? '', /offline Anthropic rejection/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
