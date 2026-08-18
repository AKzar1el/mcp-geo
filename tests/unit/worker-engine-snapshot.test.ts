import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRunPromptSnapshot,
  runEngines,
} from '../../src/engines.ts';
import type { Brand, Db, Prompt, Run } from '../../src/db/types.ts';

const brand: Brand = {
  id: 'acme',
  user_id: 'test-user',
  domain: 'acme.com',
  name: 'Acme',
  category: null,
  competitors: [],
  aliases: [],
  exclude_terms: [],
  refresh_frequency: 'weekly',
  created_at: 0,
  updated_at: 0,
};

const oldPrompts: Prompt[] = [
  {
    id: 'old-a',
    brand_id: brand.id,
    text: 'original prompt A',
    intent_stage: null,
    shape: null,
    active: 1,
    created_at: 0,
  },
  {
    id: 'old-b',
    brand_id: brand.id,
    text: 'original prompt B',
    intent_stage: null,
    shape: null,
    active: 1,
    created_at: 0,
  },
];

test('runEngines dispatches the prompt IDs present when the run is created', async () => {
  let dispatchedBody: Record<string, unknown> | undefined;
  let background: Promise<unknown> | undefined;
  let createdPromptsTotal: number | undefined;
  let activePromptLookupUsed = false;
  const regeneratedPrompts: Prompt[] = [
    { ...oldPrompts[0], id: 'new-a', text: 'replacement prompt A' },
    { ...oldPrompts[1], id: 'new-b', text: 'replacement prompt B' },
  ];
  const run: Run = {
    id: 'run-1',
    brand_id: brand.id,
    engine: 'chatgpt',
    mode: 'live',
    status: 'in_progress',
    batch_id: null,
    prompts_total: oldPrompts.length,
    prompts_completed: 0,
    cost_eur_estimate: null,
    error: null,
    started_at: 0,
    completed_at: null,
  };
  const db = {
    createRun: async (
      _brand: Brand,
      _engine: string,
      _mode: 'live' | 'batch',
      promptsTotal: number,
    ) => {
      createdPromptsTotal = promptsTotal;
      return run;
    },
    getActivePrompts: async () => {
      activePromptLookupUsed = true;
      return regeneratedPrompts;
    },
    getPromptsByIds: async (promptIds: string[]) => {
      assert.deepEqual(promptIds, ['old-a', 'old-b']);
      return [oldPrompts[1], oldPrompts[0]];
    },
  } as Db;
  const env = {
    db,
    SEED_SECRET: 'test-secret',
    SELF_URL: 'https://worker.example.test',
    OPENAI_API_KEY: 'test-key',
    SELF: {
      fetch: async (request: Request) => {
        dispatchedBody = (await request.json()) as Record<string, unknown>;
        return new Response(null, { status: 204 });
      },
    },
  };
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      background = promise;
    },
  };

  const result = await runEngines(env, ctx, brand, oldPrompts, ['chatgpt']);
  await background;

  assert.deepEqual(result, { run_ids: { chatgpt: run.id }, engines: ['chatgpt'] });
  assert.equal(createdPromptsTotal, oldPrompts.length);
  assert.deepEqual(dispatchedBody?.prompt_ids, ['old-a', 'old-b']);
  assert.deepEqual(
    (await resolveRunPromptSnapshot(db, brand.id, ['old-a', 'old-b'])).map(
      (prompt) => prompt.id,
    ),
    ['old-a', 'old-b'],
  );
  assert.equal(activePromptLookupUsed, false);
});
