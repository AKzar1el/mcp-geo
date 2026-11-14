import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectBatch, submitBatch } from '../../src/core/openai.js';
import type { Brand, Db, EnginePromptResult, Prompt, Run } from '../../src/db/types.js';

const key = 'sk-OFFLINE-BATCH-KEY+/=123456';
const encodedKey = encodeURIComponent(key);
const formKey = new URLSearchParams({ key }).toString().slice('key='.length);
const echoed = `raw ${key}; percent ${encodedKey}; form ${formKey}`;
const brand = { id: 'acme', domain: 'acme.com', name: 'Acme' } as Brand;
const prompt = { id: 'p1', brand_id: brand.id, text: 'Which tools compete with Acme?' } as Prompt;
const run = {
  id: 'batch-private', brand_id: brand.id, engine: 'chatgpt', mode: 'batch',
  status: 'in_progress', batch_id: 'batch-id', prompts_total: 1,
  prompts_completed: 0, batch_input_file_id: null, started_at: 0,
  completed_at: null, error: null,
} as Run;

function noSecret(value: string): void {
  assert.ok(!value.includes(key), 'raw key exposed');
  assert.ok(!value.includes(encodedKey), 'percent-encoded key exposed');
  assert.ok(!value.includes(formKey), 'form-encoded key exposed');
  assert.match(value, /\[REDACTED\]/);
}

async function withFetch(
  handler: (path: string) => Response | Promise<Response>,
  operation: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(new URL(input.toString()).pathname)) as typeof fetch;
  try {
    await operation();
  } finally {
    globalThis.fetch = original;
  }
}

test('OpenAI Batch submission redacts credential echoes from rejected uploads and creation', async () => {
  for (const stage of ['upload', 'create'] as const) {
    const updates: Array<Partial<Run>> = [];
    const db = {
      updateRun: async (_id: string, fields: Partial<Run>) => { updates.push(fields); },
    } as unknown as Db;
    await withFetch(
      (path) => path === '/v1/files' && stage === 'create'
        ? new Response(JSON.stringify({ id: 'file-id' }), { status: 200 })
        : new Response(echoed, { status: 403 }),
      async () => {
        await assert.rejects(submitBatch({ db, OPENAI_API_KEY: key }, brand, [prompt], run.id),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /403/);
            noSecret(error.message);
            return true;
          });
      },
    );
    assert.equal(updates.length, 1);
    assert.equal(updates[0].status, 'failed');
    noSecret(String(updates[0].error));
  }
});

test('OpenAI Batch submission redacts network failure and persistence diagnostic echoes', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => { logs.push(JSON.stringify(args)); };
  globalThis.fetch = (async () => { throw new Error(`network error: ${echoed}`); }) as typeof fetch;
  const db = {
    updateRun: async () => { throw new Error(`persistence failed: ${echoed}`); },
  } as unknown as Db;
  try {
    await assert.rejects(submitBatch({ db, OPENAI_API_KEY: key }, brand, [prompt], run.id),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        noSecret(error.message);
        return true;
      });
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
  assert.equal(logs.length, 1);
  noSecret(logs[0]);
});

test('OpenAI Batch polling redacts status and output download errors without closing retryable runs', async () => {
  for (const stage of ['status', 'download'] as const) {
    const updates: Array<Partial<Run>> = [];
    const db = {
      updateRun: async (_id: string, fields: Partial<Run>) => { updates.push(fields); },
    } as unknown as Db;
    await withFetch(
      (path) => path.includes('/batches/') && stage === 'download'
        ? new Response(JSON.stringify({ status: 'completed', output_file_id: 'file-id' }), { status: 200 })
        : new Response(echoed, { status: 503 }),
      async () => {
        await assert.rejects(collectBatch({ db, OPENAI_API_KEY: key }, run, brand),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /503/);
            noSecret(error.message);
            return true;
          });
      },
    );
    assert.deepEqual(updates, []);
  }
});

test('OpenAI Batch redacts provider error-file messages before persisting failed prompts', async () => {
  let stored: EnginePromptResult[] = [];
  const db = {
    getPromptsByIds: async () => [prompt],
    persistEngineRun: async (
      _runId: string, _engine: string, _model: string, _ttl: number, results: EnginePromptResult[],
    ) => { stored = results; },
  } as unknown as Db;
  await withFetch((path) => path.includes('/batches/')
    ? new Response(JSON.stringify({ status: 'completed', error_file_id: 'errors' }), { status: 200 })
    : new Response(JSON.stringify({
      custom_id: 'p1', response: { status_code: 403, body: { error: { message: echoed } } },
    }) + '\n', { status: 200 }),
  async () => {
    const result = await collectBatch({ db, OPENAI_API_KEY: key }, run, brand);
    assert.equal(result.ready, true);
  });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'failed');
  noSecret(String(stored[0].error_message));
});
