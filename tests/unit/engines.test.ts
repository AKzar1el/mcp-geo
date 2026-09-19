import assert from 'node:assert/strict';
import test from 'node:test';
import { uniqueEngineNames } from '../../src/core/engines.ts';

test('uniqueEngineNames preserves first-request order while removing duplicates', () => {
  assert.deepEqual(
    uniqueEngineNames(['chatgpt', 'claude', 'chatgpt', 'gemini', 'claude']),
    ['chatgpt', 'claude', 'gemini'],
  );
});
