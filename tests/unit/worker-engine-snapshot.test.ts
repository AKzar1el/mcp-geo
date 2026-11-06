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

test('runEngines dispatches each requested engine only once', async () => {
  const created: string[] = [];
  const dispatched: string[] = [];
  const db = {
    createRun: async (_brand: Brand, engine: string) => {
      created.push(engine);
      return { id: `run-${engine}` } as Run;
    },
  } as Db;
  const env = {
    db,
    SEED_SECRET: 'test-secret',
    SELF_URL: 'https://worker.example.test',
    OPENAI_API_KEY: 'test-key',
    ANTHROPIC_API_KEY: 'test-key',
    SELF: {
      fetch: async (request: Request) => {
        const body = (await request.json()) as { engine: string };
        dispatched.push(body.engine);
        return new Response(null, { status: 204 });
      },
    },
  };
  const ctx = { waitUntil: () => { throw new Error('unexpected background dispatch'); } };

  const result = await runEngines(
    env, ctx, brand, oldPrompts,
    ['chatgpt', 'claude', 'chatgpt', 'claude'], undefined, true,
  );
  assert.deepEqual(result.engines, ['chatgpt', 'claude']);
  assert.deepEqual(result.run_ids, { chatgpt: 'run-chatgpt', claude: 'run-claude' });
  assert.deepEqual(created, ['chatgpt', 'claude']);
  assert.deepEqual(dispatched, ['chatgpt', 'claude']);
});

test('runEngines can keep HTTP admin dispatch attached until service-binding work completes', async () => {
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  let waitUntilCalls = 0;
  const run: Run = {
    id: 'run-sync',
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
    createRun: async () => run,
  } as Db;
  const env = {
    db,
    SEED_SECRET: 'test-secret',
    SELF_URL: 'https://worker.example.test',
    OPENAI_API_KEY: 'test-key',
    SELF: {
      fetch: async () => {
        await fetchGate;
        return new Response(null, { status: 204 });
      },
    },
  };
  const ctx = {
    waitUntil: (_promise: Promise<unknown>) => {
      waitUntilCalls += 1;
    },
  };

  let settled = false;
  const pending = runEngines(
    env,
    ctx,
    brand,
    oldPrompts,
    ['chatgpt'],
    undefined,
    true,
  ).then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(settled, false, 'wait mode must not return before SELF.fetch settles');
  assert.equal(waitUntilCalls, 0, 'wait mode must not delegate work to waitUntil');

  releaseFetch();
  assert.deepEqual(await pending, {
    run_ids: { chatgpt: run.id },
    engines: ['chatgpt'],
  });
  assert.equal(settled, true);
});

test('runEngines marks non-2xx and rejected service dispatches terminal without retries', async () => {
  for (const [label, handler, expectedMessage] of [
    ['503', async () => new Response('temporarily unavailable', { status: 503 }), 'Engine dispatch returned HTTP 503'],
    ['rejection', async () => { throw new Error('connection lost'); }, 'Engine dispatch failed before completion'],
  ] as const) {
    let fetchCalls = 0;
    const failures: Array<{ runId: string; error: string }> = [];
    const db = {
      createRun: async () => ({
        id: 'transport-' + label,
        brand_id: brand.id,
        engine: 'chatgpt',
        mode: 'live' as const,
        status: 'in_progress' as const,
        batch_id: null,
        prompts_total: 1,
        prompts_completed: 0,
        cost_eur_estimate: null,
        error: null,
        started_at: 0,
        completed_at: null,
      }),
      failRunIfInProgress: async (runId: string, error: string) => {
        failures.push({ runId, error });
        return true;
      },
    } as Db;
    const env = {
      db,
      SEED_SECRET: 'test-secret',
      SELF_URL: 'https://worker.example.test',
      OPENAI_API_KEY: 'test-key',
      SELF: {
        fetch: async () => {
          fetchCalls += 1;
          return handler();
        },
      },
    };
    const ctx = { waitUntil: () => { throw new Error('waitUntil not expected'); } };
    const result = await runEngines(env, ctx, brand, [oldPrompts[0]], ['chatgpt'], undefined, true);
    assert.deepEqual(result.engines, ['chatgpt']);
    assert.deepEqual(failures, [{ runId: 'transport-' + label, error: expectedMessage }]);
    assert.equal(fetchCalls, 1, 'transport failure must not trigger another provider request');
  }
});
