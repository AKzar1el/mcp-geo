import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClaimedHostedEngine } from '../../src/core/hosted-engine-dispatch.js';
import type { Db } from '../../src/db/types.js';

type DispatchDb = Pick<Db, 'deleteResponsesForRun' | 'failRunIfInProgress'>;

test('claimed hosted engine clears old run rows once and executes exactly once', async () => {
  const calls: string[] = [];
  const db = {
    deleteResponsesForRun: async (id: string) => { calls.push(`clear:${id}`); },
    failRunIfInProgress: async () => { calls.push('failed'); return true; },
  } as DispatchDb;
  const result = await runClaimedHostedEngine(db, 'run-1', async () => {
    calls.push('dispatch');
  });
  assert.equal(result, true);
  assert.deepEqual(calls, ['clear:run-1', 'dispatch']);
});

test('adapter failure closes only active run, preserving partial evidence', async () => {
  const responses = ['successful prompt response'];
  const calls: string[] = [];
  const db = {
    deleteResponsesForRun: async () => { calls.push('clear'); },
    failRunIfInProgress: async (runId: string, reason: string) => {
      assert.equal(runId, 'run-2');
      assert.equal(reason, 'Hosted engine execution failed');
      calls.push('mark-failed');
      return true;
    },
  } as DispatchDb;
  const result = await runClaimedHostedEngine(db, 'run-2', async () => {
    responses.push('second successful prompt response');
    throw new Error('provider-error secret-token');
  });
  assert.equal(result, false);
  assert.deepEqual(calls, ['clear', 'mark-failed']);
  assert.deepEqual(responses, ['successful prompt response', 'second successful prompt response']);
});

test('clear failure prevents provider dispatch and closes the claimed run', async () => {
  let dispatched = 0;
  let failed = 0;
  const db = {
    deleteResponsesForRun: async () => { throw new Error('storage error'); },
    failRunIfInProgress: async (_runId: string, reason: string) => {
      assert.equal(reason, 'Hosted engine execution failed');
      failed += 1;
      return true;
    },
  } as DispatchDb;
  assert.equal(await runClaimedHostedEngine(db, 'run-3', async () => { dispatched += 1; }), false);
  assert.equal(dispatched, 0);
  assert.equal(failed, 1);
});

test('terminal transition failure does not repeat a billed provider operation', async () => {
  let dispatched = 0;
  const db = {
    deleteResponsesForRun: async () => {},
    failRunIfInProgress: async () => { throw new Error('D1 unavailable'); },
  } as DispatchDb;
  assert.equal(await runClaimedHostedEngine(db, 'run-4', async () => {
    dispatched += 1;
    throw new Error('adapter failure');
  }), false);
  assert.equal(dispatched, 1);
});
