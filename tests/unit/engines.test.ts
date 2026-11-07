import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALL_ENGINES,
  getAvailableEngines,
  runEngineInProcess,
  uniqueEngineNames,
} from '../../src/core/engines.ts';
import type { Brand, Db, EnginePromptResult, Prompt } from '../../src/db/types.ts';

test('uniqueEngineNames preserves first-request order while removing duplicates', () => {
  assert.deepEqual(
    uniqueEngineNames(['chatgpt', 'claude', 'chatgpt', 'gemini', 'claude']),
    ['chatgpt', 'claude', 'gemini'],
  );
});

test('getAvailableEngines requires an explicit opt-in before SerpAPI AI Mode adds spend', () => {
  assert.deepEqual(
    getAvailableEngines({
      OPENAI_API_KEY: 'openai',
      XAI_API_KEY: 'xai',
      SERPAPI_API_KEY: 'serpapi',
    }),
    ['chatgpt', 'grok', 'ai_overviews'],
  );
  assert.deepEqual(
    getAvailableEngines({
      SERPAPI_API_KEY: 'serpapi',
      SERPAPI_AI_MODE_ENABLED: 'true',
    }),
    ['ai_overviews', 'ai_mode'],
  );
  assert.deepEqual(
    getAvailableEngines({
      SERPAPI_API_KEY: 'serpapi',
      SERPAPI_AI_MODE_ENABLED: '0',
    }),
    ['ai_overviews'],
  );
  assert.deepEqual(getAvailableEngines({ XAI_API_KEY: '' }), []);
});

test('getAvailableEngines ignores whitespace-only provider credentials', () => {
  assert.deepEqual(
    getAvailableEngines({
      OPENAI_API_KEY: ' ',
      ANTHROPIC_API_KEY: '\t',
      GEMINI_API_KEY: '\n ',
      PERPLEXITY_API_KEY: ' \r\n ',
      XAI_API_KEY: '  ',
      SERPAPI_API_KEY: ' \t ',
      SERPAPI_AI_MODE_ENABLED: 'true',
    }),
    [],
  );
  assert.deepEqual(
    getAvailableEngines({ XAI_API_KEY: ' xai-token ', SERPAPI_API_KEY: '  ' }),
    ['grok'],
  );
});

test('explicit in-process engine dispatch skips whitespace-only credentials without contacting providers', async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  const persisted = new Map<string, EnginePromptResult[]>();
  const db = {
    async persistEngineRun(
      runId: string,
      _engine: string,
      _model: string,
      _ttlSeconds: number,
      results: EnginePromptResult[],
    ) {
      persisted.set(runId, results);
    },
  } as unknown as Db;
  const brand = { id: 'test-brand', name: 'Acme', domain: 'acme.com' } as Brand;
  const prompts = [{ id: 'test-prompt', text: 'Which tools are best?' }] as Prompt[];
  const env = {
    db,
    OPENAI_API_KEY: ' ',
    ANTHROPIC_API_KEY: '\t',
    GEMINI_API_KEY: '\n ',
    PERPLEXITY_API_KEY: ' \r\n ',
    XAI_API_KEY: '  ',
    SERPAPI_API_KEY: ' \t ',
    SERPAPI_AI_MODE_ENABLED: 'true',
  };
  globalThis.fetch = async () => {
    providerCalls++;
    return new Response('{}', { status: 401 });
  };
  try {
    for (const engine of ALL_ENGINES) {
      await runEngineInProcess(env, brand, prompts, { engine, run_id: `run-${engine}` });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(providerCalls, 0, 'missing credentials must never reach a provider');
  for (const engine of ALL_ENGINES) {
    assert.deepEqual(
      persisted.get(`run-${engine}`)?.map((result) => result.status),
      ['skipped'],
      `${engine} should persist a skipped result`,
    );
  }
});
