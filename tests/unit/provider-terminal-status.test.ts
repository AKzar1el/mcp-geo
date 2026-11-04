import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatCompletion as chatOpenAi } from '../../src/core/openai.ts';
import { chatCompletion as chatAnthropic } from '../../src/core/anthropic.ts';
import { chatCompletion as chatXAi } from '../../src/core/xai.ts';

async function withProviderPayload(
  payload: unknown,
  assertion: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
  try {
    await assertion();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('OpenAI rejects a nonterminal or missing finish reason even when answer text exists', async () => {
  for (const finish_reason of [undefined, null, 'tool_calls', 'function_call']) {
    await withProviderPayload(
      { choices: [{ finish_reason, message: { content: 'Acme is mentioned.' } }] },
      async () => {
        await assert.rejects(
          chatOpenAi('test-key', 'What is Acme?'),
          /OpenAI response incomplete/,
        );
      },
    );
  }
});

test('Anthropic rejects missing, paused or refused stop reasons with apparent answer text', async () => {
  for (const stop_reason of [undefined, null, 'pause_turn', 'tool_use', 'refusal']) {
    await withProviderPayload(
      { stop_reason, content: [{ type: 'text', text: 'Acme is mentioned.' }] },
      async () => {
        await assert.rejects(
          chatAnthropic('test-key', 'What is Acme?', 'Be concise.'),
          /Anthropic response incomplete/,
        );
      },
    );
  }
});

test('xAI rejects a missing status despite a nonempty output_text', async () => {
  await withProviderPayload(
    {
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'Acme is mentioned.' }],
      }],
    },
    async () => {
      await assert.rejects(
        chatXAi('test-key', 'What is Acme?', 'Be concise.'),
        /xAI response incomplete/,
      );
    },
  );
});
