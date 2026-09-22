import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROVIDER_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
} from '../../src/core/fetch.js';

test('provider fetch timeout stays bounded and aborts a stalled request', async (t) => {
  assert.equal(PROVIDER_REQUEST_TIMEOUT_MS, 90_000);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input, init) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal, 'fetchWithTimeout must attach an AbortSignal');

      const rejectFromSignal = () => reject(signal.reason);
      if (signal.aborted) {
        rejectFromSignal();
      } else {
        signal.addEventListener('abort', rejectFromSignal, { once: true });
      }
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const keepAlive = setTimeout(() => {}, 100);
  t.after(() => clearTimeout(keepAlive));

  await assert.rejects(fetchWithTimeout('https://example.test', {}, 10), (error) => {
    return error instanceof DOMException && error.name === 'TimeoutError';
  });
});

test('provider fetch timeout preserves an earlier caller cancellation', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input, init) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal, 'fetchWithTimeout must attach an AbortSignal');

      const rejectFromSignal = () => reject(signal.reason);
      if (signal.aborted) {
        rejectFromSignal();
      } else {
        signal.addEventListener('abort', rejectFromSignal, { once: true });
      }
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const controller = new AbortController();
  const request = fetchWithTimeout(
    'https://example.test',
    { signal: controller.signal },
    1_000,
  );
  controller.abort(new DOMException('cancelled by caller', 'AbortError'));

  await assert.rejects(request, (error) => {
    return error instanceof DOMException && error.name === 'AbortError';
  });
});
