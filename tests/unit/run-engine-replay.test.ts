import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExistingEngineRun } from '../../src/core/run-engine-replay.ts';
import type { Run } from '../../src/db/types.ts';

const liveRun: Run = {
  id: 'run-123',
  brand_id: 'acme',
  engine: 'chatgpt',
  mode: 'live',
  status: 'in_progress',
  batch_id: null,
  prompts_total: 2,
  prompts_completed: 0,
  cost_eur_estimate: null,
  error: null,
  started_at: 100,
  completed_at: null,
};

test('only an unclaimed live run may start a provider dispatch', () => {
  assert.equal(validateExistingEngineRun(null, 'acme', 'chatgpt', 2), null);
  assert.equal(validateExistingEngineRun({ ...liveRun, status: 'pending' }, 'acme', 'chatgpt', 2), null);
  assert.match(validateExistingEngineRun(liveRun, 'acme', 'chatgpt', 2) ?? '', /already.*dispatch/i);
});

test('completed or failed run IDs cannot be replayed over saved evidence', () => {
  for (const status of ['completed', 'failed'] as const) {
    const message = validateExistingEngineRun({ ...liveRun, status }, 'acme', 'chatgpt', 2);
    assert.match(message ?? '', new RegExp(`already ${status}`));
  }
});

test('mismatched run identity and prompt counts fail closed before dispatch', () => {
  for (const run of [
    { ...liveRun, brand_id: 'other' },
    { ...liveRun, engine: 'claude' },
    { ...liveRun, mode: 'batch' as const },
    { ...liveRun, prompts_total: 3 },
  ]) {
    assert.match(
      validateExistingEngineRun(run, 'acme', 'chatgpt', 2) ?? '',
      /different brand, engine, mode, or prompt count/,
    );
  }
});
