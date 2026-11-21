import assert from 'node:assert/strict';
import test from 'node:test';
import { chatCompletion as anthropicChat, runLive as anthropicLive } from '../../src/core/anthropic.js';
import { chatCompletion as perplexityChat, runLive as perplexityLive } from '../../src/core/perplexity.js';
import { chatCompletion as xaiChat, runLive as xaiLive } from '../../src/core/xai.js';
import { chatCompletion as openaiChat, runLive as openaiLive } from '../../src/core/openai.js';
import type { Brand, Db, EnginePromptResult, Prompt } from '../../src/db/types.js';

const key = 'sk-OFFLINE-CREDENTIAL-Only+/=987654';
const encodedKey = encodeURIComponent(key);
const formEncodedKey = new URLSearchParams({ key }).toString().slice('key='.length);
const brand = {
  domain: 'acme.com', name: 'Acme', competitors: [], aliases: [], exclude_terms: [],
} as Brand;
const prompts = [{ id: 'p1', text: 'What tools do agencies use?' } as Prompt];

const providers = [
  {
    name: 'Anthropic',
    keyName: 'ANTHROPIC_API_KEY',
    complete: (secret: string) => anthropicChat(secret, 'Question', 'System'),
    run: (db: Db) => anthropicLive({ db, ANTHROPIC_API_KEY: key }, brand, prompts, 'offline-run'),
    persist: (db: Db) => anthropicLive({ db, ANTHROPIC_API_KEY: key }, brand, [], 'offline-run'),
  },
  {
    name: 'Perplexity',
    keyName: 'PERPLEXITY_API_KEY',
    complete: (secret: string) => perplexityChat(secret, 'Question', 'System'),
    run: (db: Db) => perplexityLive({ db, PERPLEXITY_API_KEY: key }, brand, prompts, 'offline-run'),
    persist: (db: Db) => perplexityLive({ db, PERPLEXITY_API_KEY: key }, brand, [], 'offline-run'),
  },
  {
    name: 'xAI',
    keyName: 'XAI_API_KEY',
    complete: (secret: string) => xaiChat(secret, 'Question', 'System'),
    run: (db: Db) => xaiLive({ db, XAI_API_KEY: key }, brand, prompts, 'offline-run'),
    persist: (db: Db) => xaiLive({ db, XAI_API_KEY: key }, brand, [], 'offline-run'),
  },
  {
    name: 'OpenAI',
    keyName: 'OPENAI_API_KEY',
    complete: (secret: string) => openaiChat(secret, 'Question'),
    run: (db: Db) => openaiLive({ db, OPENAI_API_KEY: key }, brand, prompts, 'offline-run'),
    persist: (db: Db) => openaiLive({ db, OPENAI_API_KEY: key }, brand, [], 'offline-run'),
  },
];

function assertNoSecret(text: string): void {
  assert.ok(!text.includes(key), 'raw provider key must not escape');
  assert.ok(!text.includes(encodedKey), 'percent-encoded provider key must not escape');
  assert.ok(!text.includes(formEncodedKey), 'form-encoded provider key must not escape');
}

test('live header-auth adapters redact upstream key echoes without hiding HTTP status', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const provider of providers) {
      globalThis.fetch = async () => new Response(
        `provider ${provider.name}: raw ${key}; encoded ${encodedKey}; form ${formEncodedKey}`,
        { status: 403 },
      );
      await assert.rejects(provider.complete(key), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /403/);
        assertNoSecret(error.message);
        assert.match(error.message, /\[REDACTED\]/);
        return true;
      }, provider.name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('live adapters sanitize network failures before persisting prompt errors or logging', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  try {
    for (const provider of providers) {
      const diagnostics: string[] = [];
      let saved: EnginePromptResult[] = [];
      globalThis.fetch = async () => { throw new Error(`offline fetch failed: ${key} ${encodedKey}`); };
      console.error = (...args: unknown[]) => { diagnostics.push(JSON.stringify(args)); };
      const db = {
        persistEngineRun: async (
          _runId: string, _engine: string, _model: string, _ttl: number,
          results: EnginePromptResult[],
        ) => { saved = results; },
      } as unknown as Db;
      await provider.run(db);
      assert.equal(saved.length, 1, provider.name);
      assert.equal(saved[0]?.status, 'failed', provider.name);
      assertNoSecret(saved[0]?.error_message ?? '');
      assert.match(saved[0]?.error_message ?? '', /\[REDACTED\]/);
      for (const diagnostic of diagnostics) assertNoSecret(diagnostic);
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test('provider-key echoes in persistence failures are not written to run diagnostics', async () => {
  const originalError = console.error;
  try {
    for (const provider of providers) {
      let failure: { error?: string; status?: string } | undefined;
      const diagnostics: string[] = [];
      console.error = (...args: unknown[]) => { diagnostics.push(JSON.stringify(args)); };
      const db = {
        persistEngineRun: async () => { throw new Error(`db unavailable while storing ${key}`); },
        updateRun: async (_id: string, fields: { error?: string; status?: string }) => {
          failure = fields;
        },
      } as unknown as Db;
      await provider.persist(db);
      assert.equal(failure?.status, 'failed', provider.name);
      assertNoSecret(failure?.error ?? '');
      assert.match(failure?.error ?? '', /\[REDACTED\]/);
      for (const diagnostic of diagnostics) assertNoSecret(diagnostic);
    }
  } finally {
    console.error = originalError;
  }
});
