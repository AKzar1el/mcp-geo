import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleAdminListBrands,
  handleAdminListPrompts,
  handleAdminSetPrompts,
} from '../../src/core/admin-prompt-set.ts';
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

test('admin list-brands returns tracked brand metadata and prompt counts', async () => {
  const db = {
    listBrands: async () => [{ ...brand, active_prompts: 2 }],
  } as unknown as Db;

  const response = await handleAdminListBrands(db);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    brands: [
      {
        brand_id: 'acme',
        name: 'Acme',
        domain: 'acme.com',
        category: 'Project management',
        competitors: [],
        refresh_frequency: 'weekly',
        active_prompts: 2,
        created_at: new Date(1).toISOString(),
      },
    ],
  });
});

test('admin list-brands explains how to start when no brands exist', async () => {
  const db = { listBrands: async () => [] } as unknown as Db;
  const response = await handleAdminListBrands(db);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    brands: [],
    hint: 'No brands tracked yet - POST /admin/seed to add one.',
  });
});
test('admin list-prompts requires a brand_id', async () => {
  const db = {} as Db;
  const response = await handleAdminListPrompts(
    new Request('https://example.test/admin/list-prompts'),
    db,
  );
  assert.equal(response.status, 400);
});

test('admin list-prompts returns 404 for an unknown brand', async () => {
  const db = { getBrand: async () => null } as unknown as Db;
  const response = await handleAdminListPrompts(
    new Request('https://example.test/admin/list-prompts?brand_id=missing'),
    db,
  );
  assert.equal(response.status, 404);
});

test('admin list-prompts returns the exact active measurement set', async () => {
  const prompts = [
    activePrompt('Which tool is best?', 1),
    activePrompt('Acme vs Asana?', 2),
  ];
  const db = {
    getBrand: async () => brand,
    getActivePrompts: async () => prompts,
  } as unknown as Db;

  const response = await handleAdminListPrompts(
    new Request('https://example.test/admin/list-prompts?brand_id=acme'),
    db,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    brand_id: 'acme',
    prompts: prompts.map((prompt) => ({
      id: prompt.id,
      text: prompt.text,
      intent_stage: prompt.intent_stage,
      shape: prompt.shape,
      created_at: new Date(prompt.created_at).toISOString(),
    })),
    count: 2,
  });
});
