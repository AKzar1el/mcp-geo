import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLive as runAiMode } from '../../src/core/ai-mode.ts';
import { runLive as runAiOverviews } from '../../src/core/ai-overviews.ts';
import type { Brand, Db, EnginePromptResult, Prompt } from '../../src/db/types.ts';

const brand = { domain: 'acme.example', name: 'Acme', competitors: [], aliases: [], exclude_terms: [] } as Brand;
const prompt = { id: 'p1', text: 'Where is Acme mentioned?' } as Prompt;
const secret = 'secret+SerpAPI/123';
const encodedSecret = encodeURIComponent(secret);

async function assertFailureKeepsCredentialsPrivate(
  run: (db: Db) => Promise<void>,
  fakeFetch: typeof fetch,
  expectedDiagnostic: RegExp,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const logs: string[] = [];
  let persisted: EnginePromptResult[] = [];
  const db = {
    persistEngineRun: async (
      _runId: string, _engine: string, _model: string, _ttl: number,
      results: EnginePromptResult[],
    ) => { persisted = results; },
  } as unknown as Db;
  globalThis.fetch = fakeFetch;
  console.error = (...args: unknown[]) => { logs.push(JSON.stringify(args)); };
  try {
    await run(db);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].status, 'failed');
  assert.match(persisted[0].error_message ?? '', expectedDiagnostic);
  const exposed = [persisted[0].error_message ?? '', ...logs].join('\n');
  assert.doesNotMatch(exposed, /secret\+SerpAPI\/123/i);
  assert.ok(!exposed.includes(encodedSecret), 'URL-encoded API key must not enter diagnostics');
}

test('AI Mode redacts raw and URL-encoded SerpAPI API keys from failed request diagnostics', async () => {
  await assertFailureKeepsCredentialsPrivate(
    (db) => runAiMode(
      { db, SERPAPI_API_KEY: secret, SERPAPI_AI_MODE_ENABLED: 'true' },
      brand, [prompt], 'run-mode',
    ),
    (async (input: RequestInfo | URL) => {
      throw new Error(`network failed for ${String(input)}; credential ${secret}`);
    }) as typeof fetch,
    /network failed/,
  );
});

test('AI Overviews redacts SerpAPI API keys echoed by upstream HTTP failures', async () => {
  await assertFailureKeepsCredentialsPrivate(
    (db) => runAiOverviews(
      { db, SERPAPI_API_KEY: secret },
      brand, [prompt], 'run-overview',
    ),
    (async () => new Response(
      `quota rejected: api_key=${secret}; encoded=${encodedSecret}`,
      { status: 403 },
    )) as typeof fetch,
    /403/,
  );
});
