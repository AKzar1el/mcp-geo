import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyExactPromptSet, normalizeExactPrompts } from '../../src/core/prompt-set.ts';
import type { Db, NewPromptInput, Prompt } from '../../src/db/types.ts';

function activePrompt(text: string, index: number): Prompt {
  return {
    id: `prompt-${index}`,
    brand_id: 'acme',
    text,
    intent_stage: null,
    shape: null,
    active: 1,
    created_at: index,
  };
}

test('normalizeExactPrompts normalizes whitespace and rejects case-insensitive duplicates', () => {
  assert.deepEqual(normalizeExactPrompts(['  Best   tool? ', 'Acme vs Asana?']), [
    'Best tool?',
    'Acme vs Asana?',
  ]);
  assert.throws(
    () => normalizeExactPrompts(['Best tool?', '  BEST   TOOL?  ']),
    /must be unique/,
  );
});

test('applyExactPromptSet is a no-op when the active set already matches', async () => {
  let replaceCalls = 0;
  const db = {
    getActivePrompts: async () => [
      activePrompt('Best tool?', 1),
      activePrompt('Acme vs Asana?', 2),
    ],
    replacePrompts: async () => {
      replaceCalls += 1;
      return 0;
    },
  } as Pick<Db, 'getActivePrompts' | 'replacePrompts'>;

  const result = await applyExactPromptSet(db, 'acme', [
    'Best tool?',
    'Acme vs Asana?',
  ]);
  assert.equal(result.changed, false);
  assert.equal(result.prompts_inserted, 0);
  assert.equal(replaceCalls, 0);
});

test('applyExactPromptSet replaces the active set with normalized exact prompts', async () => {
  let saved: NewPromptInput[] | null = null;
  const db = {
    getActivePrompts: async () => [activePrompt('Old prompt', 1)],
    replacePrompts: async (_brandId: string, prompts: NewPromptInput[]) => {
      saved = prompts;
      return prompts.length;
    },
  } as Pick<Db, 'getActivePrompts' | 'replacePrompts'>;

  const result = await applyExactPromptSet(db, 'acme', [
    ' Best   tool? ',
    'Acme vs Asana?',
  ]);
  assert.equal(result.changed, true);
  assert.equal(result.prompts_inserted, 2);
  assert.deepEqual(saved, [
    { text: 'Best tool?', intent_stage: null, shape: null },
    { text: 'Acme vs Asana?', intent_stage: null, shape: null },
  ]);
});
