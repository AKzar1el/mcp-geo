import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAdminSetPrompts } from '../../src/core/admin-prompt-set.ts';
import type { Brand, Db, NewPromptInput, Prompt } from '../../src/db/types.ts';

const brand: Brand = {
  id: 'acme',
  user_id: 'dev-user',
  domain: 'acme.com',
  name: 'Acme',
  category: 'Project management',
  competitors: [],
  aliases: [],
  exclude_terms: [],
  refresh_frequency: 'weekly',
  created_at: 1,
  updated_at: 1,
};

function activePrompt(text: string, index: number): Prompt {
  return {
    id: `prompt-${index}`,
    brand_id: brand.id,
    text,
    intent_stage: null,
    shape: null,
    active: 1,
    created_at: index,
  };
}

function request(body: unknown): Request {
  return new Request('https://example.test/admin/set-prompts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('admin set-prompts rejects malformed prompt payloads before DB writes', async () => {
  let replaceCalls = 0;
  const db = {
    getBrand: async () => brand,
    replacePrompts: async () => {
      replaceCalls += 1;
      return 0;
    },
  } as unknown as Db;

  const response = await handleAdminSetPrompts(
    request({ brand_id: 'acme', prompts: ['valid', 42] }),
    db,
  );
  assert.equal(response.status, 400);
  assert.equal(replaceCalls, 0);
});

test('admin set-prompts returns 404 for an unknown brand', async () => {
  const db = { getBrand: async () => null } as unknown as Db;
  const response = await handleAdminSetPrompts(
    request({ brand_id: 'missing', prompts: ['Which tool is best?'] }),
    db,
  );
  assert.equal(response.status, 404);
});

test('admin set-prompts replaces and normalizes an exact measurement set', async () => {
  let saved: NewPromptInput[] | null = null;
  const db = {
    getBrand: async () => brand,
    getActivePrompts: async () => [activePrompt('Old prompt', 1)],
    replacePrompts: async (_brandId: string, prompts: NewPromptInput[]) => {
      saved = prompts;
      return prompts.length;
    },
  } as unknown as Db;

  const response = await handleAdminSetPrompts(
    request({
      brand_id: 'acme',
      prompts: [' Which   tool is best? ', 'Acme vs Asana?'],
    }),
    db,
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    changed: boolean;
    prompts_inserted: number;
    prompts: string[];
  };
  assert.equal(payload.changed, true);
  assert.equal(payload.prompts_inserted, 2);
  assert.deepEqual(payload.prompts, ['Which tool is best?', 'Acme vs Asana?']);
  assert.deepEqual(saved, [
    { text: 'Which tool is best?', intent_stage: null, shape: null },
    { text: 'Acme vs Asana?', intent_stage: null, shape: null },
  ]);
});
