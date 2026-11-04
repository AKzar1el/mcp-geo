import assert from 'node:assert/strict';
import test from 'node:test';

import { chatCompletion as openAiCompletion } from '../../src/core/openai.js';
import { chatCompletion as anthropicCompletion } from '../../src/core/anthropic.js';
import { chatCompletion as geminiCompletion } from '../../src/core/gemini.js';
import { chatCompletion as xaiCompletion } from '../../src/core/xai.js';
import { chatCompletion as perplexityCompletion } from '../../src/core/perplexity.js';

async function assertProviderRejects(body: unknown, run: () => Promise<unknown>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
  try {
    await assert.rejects(run(), /missing|incomplete|empty|finishReason/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('OpenAI never scores a whitespace-only completed response', async () => {
  await assertProviderRejects({
    choices: [{ finish_reason: 'stop', message: { content: ' \n\t ' } }],
  }, () => openAiCompletion('test-key', 'Find Acme'));
});

test('Anthropic never scores whitespace-only completed text blocks', async () => {
  await assertProviderRejects({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: ' \n\t ' }],
  }, () => anthropicCompletion('test-key', 'Find Acme', 'Be concise.'));
});

test('Gemini does not score text without a terminal finish reason', async () => {
  await assertProviderRejects({
    candidates: [{ content: { parts: [{ text: 'Acme is visible.' }] } }],
  }, () => geminiCompletion('test-key', 'Find Acme', 'Be concise.'));
});

test('Gemini never scores whitespace-only STOP text', async () => {
  await assertProviderRejects({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: ' \n\t ' }] } }],
  }, () => geminiCompletion('test-key', 'Find Acme', 'Be concise.'));
});

test('xAI never scores whitespace-only completed output', async () => {
  await assertProviderRejects({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: ' \n\t ' }] }],
  }, () => xaiCompletion('test-key', 'Find Acme', 'Be concise.'));
});

test('Perplexity never scores whitespace-only completed output', async () => {
  await assertProviderRejects({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: ' \n\t ' }] }],
  }, () => perplexityCompletion('test-key', 'Find Acme', 'Be concise.'));
});
