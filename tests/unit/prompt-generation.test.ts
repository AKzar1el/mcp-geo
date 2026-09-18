import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrompts } from '../../src/core/prompt-generation.ts';
import type { Brand, Db, NewPromptInput } from '../../src/db/types.ts';

function anthropicResponse(prompts: unknown[]): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(prompts) }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function prompt(text: string) {
  return {
    prompt: text,
    intent_stage: 'comparison',
    shape: 'best X for Y',
  };
}

const brand: Brand = {
  id: 'brand-1',
  user_id: 'user-1',
  domain: 'acme.com',
  name: 'Acme',
  category: 'project management software',
  competitors: ['rival.com'],
  aliases: [],
  exclude_terms: [],
  refresh_frequency: 'weekly',
  created_at: 0,
  updated_at: 0,
};

async function withMockAnthropic(
  responses: Response[],
  assertion: (state: { saved: NewPromptInput[] | null; calls: number }) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let saved: NewPromptInput[] | null = null;
  const db = {
    replacePrompts: async (_brandId: string, prompts: NewPromptInput[]) => {
      saved = prompts;
      return prompts.length;
    },
  } as unknown as Db;

  globalThis.fetch = (async () => {
    calls += 1;
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch call');
    return next;
  }) as typeof fetch;

  try {
    await assertion({
      get saved() {
        return saved;
      },
      get calls() {
        return calls;
      },
    });
    assert.equal(responses.length, 0, 'all mocked responses should be consumed');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('generatePrompts persists exactly the requested number of unique prompts', async () => {
  await withMockAnthropic(
    [anthropicResponse([prompt('Best tool for agencies'), prompt('Best tool for startups'), prompt('Best tool for enterprise')])],
    async (state) => {
      const result = await generatePrompts(
        { db: ({ replacePrompts: async () => 0 } as unknown as Db), ANTHROPIC_API_KEY: 'test-key' },
        brand,
        3,
      );
      assert.equal(result.length, 3);
      assert.equal(state.calls, 1);
    },
  );
});

test('generatePrompts retries when the first response has fewer unique prompts than requested', async () => {
  const first = [prompt('Best tool for agencies'), prompt(' best   tool for agencies '), prompt('Best tool for startups')];
  const second = [prompt('Best tool for agencies'), prompt('Best tool for startups'), prompt('Best tool for enterprise')];

  const originalFetch = globalThis.fetch;
  const responses = [anthropicResponse(first), anthropicResponse(second)];
  let saved: NewPromptInput[] | null = null;
  let calls = 0;
  const db = {
    replacePrompts: async (_brandId: string, prompts: NewPromptInput[]) => {
      saved = prompts;
      return prompts.length;
    },
  } as unknown as Db;
  globalThis.fetch = (async () => {
    calls += 1;
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch call');
    return next;
  }) as typeof fetch;

  try {
    const result = await generatePrompts({ db, ANTHROPIC_API_KEY: 'test-key' }, brand, 3);
    assert.equal(calls, 2);
    assert.equal(result.length, 3);
    assert.equal(saved?.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePrompts leaves the existing prompt set untouched when both attempts miss the requested unique count', async () => {
  const duplicateSet = [prompt('Best tool for agencies'), prompt('BEST TOOL FOR AGENCIES'), prompt('Best tool for startups')];
  const originalFetch = globalThis.fetch;
  const responses = [anthropicResponse(duplicateSet), anthropicResponse(duplicateSet)];
  let replaceCalls = 0;
  const db = {
    replacePrompts: async () => {
      replaceCalls += 1;
      return 0;
    },
  } as unknown as Db;
  globalThis.fetch = (async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch call');
    return next;
  }) as typeof fetch;

  try {
    await assert.rejects(
      generatePrompts({ db, ANTHROPIC_API_KEY: 'test-key' }, brand, 3),
      /unique valid prompts; expected 3/,
    );
    assert.equal(replaceCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
