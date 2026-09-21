import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAvailableEngines,
  uniqueEngineNames,
} from '../../src/core/engines.ts';

test('uniqueEngineNames preserves first-request order while removing duplicates', () => {
  assert.deepEqual(
    uniqueEngineNames(['chatgpt', 'claude', 'chatgpt', 'gemini', 'claude']),
    ['chatgpt', 'claude', 'gemini'],
  );
});

test('getAvailableEngines includes Grok only when XAI_API_KEY is configured', () => {
  assert.deepEqual(
    getAvailableEngines({
      OPENAI_API_KEY: 'openai',
      XAI_API_KEY: 'xai',
      SERPAPI_API_KEY: 'serpapi',
    }),
    ['chatgpt', 'grok', 'ai_overviews'],
  );
  assert.deepEqual(getAvailableEngines({ XAI_API_KEY: '' }), []);
});
