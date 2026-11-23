import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchWithRetry, retryDelayMs } from '../../src/core/fetch.js';

test('retryDelayMs prefers provider hints, else backs off, capped', () => {
  assert.equal(retryDelayMs(new Headers({ 'retry-after-ms': '131' }), 0), 131);
  assert.equal(retryDelayMs(new Headers({ 'retry-after': '5' }), 0), 5_000);
  assert.equal(retryDelayMs(new Headers({ 'retry-after': 'Wed, 21 Oct' }), 1), 4_000);
  assert.equal(retryDelayMs(new Headers(), 10), 30_000);
});

test('fetchWithRetry retries 429/503, stops on success or other status', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };

  let statuses = [429, 503, 200];
  globalThis.fetch = (async () => new Response('x', { status: statuses.shift() })) as typeof fetch;
  assert.equal((await fetchWithRetry('https://example.test', {}, 3, sleep)).status, 200);
  assert.deepEqual(sleeps, [2_000, 4_000]);

  statuses = [400, 200];
  assert.equal((await fetchWithRetry('https://example.test', {}, 3, sleep)).status, 400);

  statuses = [429, 429, 429];
  assert.equal((await fetchWithRetry('https://example.test', {}, 2, sleep)).status, 429);
  assert.equal(statuses.length, 0);
});
