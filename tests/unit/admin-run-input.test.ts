import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasRequiredIdentifier,
  selectAdminRunEngines,
} from '../../src/core/admin-run-input.ts';

test('hosted admin run IDs require nonempty strings before storage access', () => {
  for (const invalid of [undefined, null, '', '  ', 42, true, ['acme'], { id: 'acme' }]) {
    assert.equal(hasRequiredIdentifier(invalid), false, JSON.stringify(invalid));
  }
  assert.equal(hasRequiredIdentifier('acme'), true);
  assert.equal(hasRequiredIdentifier('run-123'), true);
});

test('malformed explicit engine selection cannot silently fan out to every provider', () => {
  const available = ['chatgpt', 'gemini'] as const;
  for (const invalid of ['chatgpt', null, true, { engine: 'chatgpt' }, 3]) {
    const selected = selectAdminRunEngines(invalid, available);
    assert.ok(selected.error, JSON.stringify(invalid));
    assert.equal(selected.engineNames, undefined);
  }
});

test('valid admin engine selections keep legacy defaults and remove duplicates', () => {
  const available = ['chatgpt', 'gemini'] as const;
  assert.deepEqual(selectAdminRunEngines(undefined, available).engineNames, [...available]);
  assert.deepEqual(selectAdminRunEngines([], available).engineNames, [...available]);
  assert.deepEqual(selectAdminRunEngines(['gemini', 'gemini'], available).engineNames, ['gemini']);
  assert.match(selectAdminRunEngines(['unknown'], available).error ?? '', /Unknown engines/);
  assert.match(selectAdminRunEngines([null], available).error ?? '', /Unknown engines/);
});
