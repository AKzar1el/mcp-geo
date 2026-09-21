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
