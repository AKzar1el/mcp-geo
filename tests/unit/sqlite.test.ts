// Unit tests for the node:sqlite Db adapter (src/db/sqlite.ts) and
// the core seeding flow (src/core/seed.ts) on top of it. Runs against a
// throwaway database under the OS temp dir — no network, no Cloudflare.
// Run with: npm run test:unit
//
// Some fixtures are still inserted through the adapter's exposed raw
// raw node:sqlite handle where the test wants exact control over row
// shape, independent of the Db methods under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteDb, type SqliteDb } from '../../src/db/sqlite.ts';
import { createD1Db } from '../../src/db/d1.ts';
import { LIVE_RUN_STALE_AFTER_MS } from '../../src/db/types.ts';
import { runEngines } from '../../src/engines.ts';
import { seedBrand } from '../../src/core/seed.ts';
import { collectBatch } from '../../src/core/openai.ts';

const EXPECTED_MIGRATIONS = [
  '0001_initial.sql',
  '0002_fail_stuck_runs.sql',
  '0003_perplexity_citations.sql',
  '0004_response_status.sql',
  '0005_brand_alias_exclude.sql',
  '0006_brand_identity_boundary.sql',
];

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'digestseo-sqlite-test-'));
}

function seedBrandFixture(db: SqliteDb, brandId: string): void {
  const now = Date.now();
  db.raw
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, plan, created_at, updated_at)
       VALUES ('test-user', 'test@local', 'free', ?, ?)`,
    )
    .run(now, now);
  db.raw
    .prepare(
      `INSERT INTO brands
         (id, user_id, domain, name, category, competitors_json,
          refresh_frequency, created_at, updated_at)
       VALUES (?, 'test-user', 'acme.com', 'Acme Project Tool',
               'Project management software',
               '["asana.com","monday.com"]', 'weekly', ?, ?)`,
    )
    .run(brandId, now, now);
}

function seedPromptFixture(
  db: SqliteDb,
  brandId: string,
  promptId: string,
  text: string,
): void {
  db.raw
    .prepare(
      `INSERT INTO prompts (id, brand_id, text, intent_stage, shape, active, created_at)
       VALUES (?, ?, ?, 'awareness', 'best X', 1, ?)`,
    )
    .run(promptId, brandId, text, Date.now());
}

test('open applies every migration in order, tracks them, and creates parent dirs', () => {
  const root = tempRoot();
  // Nested path that does not exist yet — open must create it.
  const dbPath = join(root, 'nested', 'dir', 'digestseo.sqlite');
  const db = openSqliteDb(dbPath);
  try {
    assert.ok(existsSync(dbPath), 'database file was not created');
    const applied = db.raw
      .prepare('SELECT name FROM _migrations ORDER BY name ASC')
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      applied.map((r) => r.name),
      EXPECTED_MIGRATIONS,
    );
    const tables = new Set(
      (
        db.raw
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    for (const t of [
      'users',
      'brands',
      'prompts',
      'runs',
      'prompt_responses',
      'shared_prompt_cache',
    ]) {
      assert.ok(tables.has(t), `expected table '${t}' to exist`);
    }
    const identityColumn = db.raw
      .prepare('PRAGMA table_info(brands)').all() as Array<{ name: string }>;
    assert.ok(identityColumn.some((column) => column.name === 'identity_changed_at'));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('re-opening an existing database does not re-apply migrations', () => {
  const root = tempRoot();
  const dbPath = join(root, 'digestseo.sqlite');
  const first = openSqliteDb(dbPath);
  first.close();
  // 0003/0005/0006 are ALTER TABLE ADD COLUMN — re-applying them would throw
  // "duplicate column name", so a clean second open proves tracking works.
  const second = openSqliteDb(dbPath);
  try {
    const applied = second.raw
      .prepare('SELECT COUNT(*) AS n FROM _migrations')
      .get() as { n: number };
    assert.equal(applied.n, EXPECTED_MIGRATIONS.length);
  } finally {
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('SQLite and D1 reserve one live scan atomically; completed, failed, and stale runs release the reservation', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'single-flight.sqlite'));
  try {
    await db.upsertUser('test-user', 'test@local');
    await db.createBrand({
      id: 'single-flight', user_id: 'test-user', domain: 'example.org',
      name: 'Single Flight', category: null, competitors: [], aliases: [],
      exclude_terms: [], refresh_frequency: 'weekly',
    });
    const brand = await db.getBrand('single-flight');
    assert.ok(brand);
    // Use real SQLite statement execution for the hosted adapter as well:
    // the D1-style run/first wrapper exercises identical SQL, offline.
    const hosted = createD1Db({
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async run() {
                const stmt = db.raw.prepare(sql);
                const result = stmt.run(...(params as Parameters<typeof stmt.run>));
                return { meta: { changes: result.changes } };
              },
              async first() {
                const stmt = db.raw.prepare(sql);
                return stmt.get(...(params as Parameters<typeof stmt.get>)) ?? null;
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof createD1Db>[0]);

    const [first, second] = await Promise.all([
      db.reserveLiveRun(brand, 'chatgpt', 2),
      hosted.reserveLiveRun(brand, 'chatgpt', 2),
    ]);
    assert.ok(first && second);
    assert.equal([first.started, second.started].filter(Boolean).length, 1);
    assert.equal(first.run.id, second.run.id);
    assert.equal((await db.getRunById(first.run.id))?.status, 'pending');
    // Competing service-binding invocations must claim a run at most once,
    // even across the SQLite and hosted/D1 implementations.
    const claims = await Promise.all([
      db.claimPendingLiveRun(first.run.id),
      hosted.claimPendingLiveRun(first.run.id),
    ]);
    assert.deepEqual(claims.sort(), [false, true]);
    assert.equal((await db.getRunById(first.run.id))?.status, 'in_progress');
    assert.equal(await db.claimPendingLiveRun(first.run.id), false);
    const count = () => Number((db.raw.prepare(
      "SELECT COUNT(*) AS n FROM runs WHERE brand_id='single-flight' AND engine='chatgpt'",
    ).get() as { n: number }).n);
    assert.equal(count(), 1);

    await db.updateRun(first.run.id, { status: 'completed', completed_at: Date.now() });
    const afterComplete = await hosted.reserveLiveRun(brand, 'chatgpt', 2);
    assert.ok(afterComplete?.started);
    assert.equal((await db.getRunById(afterComplete.run.id))?.status, 'pending');
    assert.equal(count(), 2);
    assert.equal(await hosted.failRunIfInProgress(afterComplete.run.id, 'transport failure'), true);
    const afterFailure = await db.reserveLiveRun(brand, 'chatgpt', 2);
    assert.ok(afterFailure?.started);
    assert.equal(count(), 3);
    db.raw.prepare('UPDATE runs SET started_at = ? WHERE id = ?')
      .run(Date.now() - LIVE_RUN_STALE_AFTER_MS - 1000, afterFailure.run.id);
    const afterStale = await hosted.reserveLiveRun(brand, 'chatgpt', 2);
    assert.ok(afterStale?.started);
    assert.equal(count(), 4);
    // Batch mode retains its independent lifetime and does not block live runs.
    await db.createRun(brand, 'gemini', 'batch', 2);
    assert.equal((await hosted.reserveLiveRun(brand, 'gemini', 2))?.started, true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('two overlapping Worker refreshes share one run ID and dispatch only once', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'overlap.sqlite'));
  try {
    await db.upsertUser('test-user', 'test@local');
    await db.createBrand({
      id: 'overlap', user_id: 'test-user', domain: 'example.org',
      name: 'Overlap', category: null, competitors: [], aliases: [],
      exclude_terms: [], refresh_frequency: 'weekly',
    });
    const brand = await db.getBrand('overlap');
    assert.ok(brand);
    seedPromptFixture(db, brand.id, 'overlap-prompt', 'Compare solutions');
    const prompts = await db.getActivePrompts(brand.id);
    let dispatches = 0;
    const env = {
      db, SEED_SECRET: 'test', SELF_URL: 'https://worker.example.test',
      OPENAI_API_KEY: 'test',
      SELF: { fetch: async () => {
        dispatches++;
        return new Response(null, { status: 204 });
      } },
    };
    const ctx = { waitUntil: () => { throw new Error('unexpected background dispatch'); } };
    const [a, b] = await Promise.all([
      runEngines(env, ctx, brand, prompts, ['chatgpt'], undefined, true),
      runEngines(env, ctx, brand, prompts, ['chatgpt'], undefined, true),
    ]);
    assert.equal(dispatches, 1);
    assert.equal(a.run_ids.chatgpt, b.run_ids.chatgpt);
    assert.deepEqual([a.engines.length, b.engines.length].sort(), [0, 1]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('openSqliteDb() with no argument honors DIGESTSEO_DB_PATH', () => {
  const root = tempRoot();
  const envPath = join(root, 'from-env', 'env.sqlite');
  const prev = process.env.DIGESTSEO_DB_PATH;
  process.env.DIGESTSEO_DB_PATH = envPath;
  try {
    const db = openSqliteDb();
    db.close();
    assert.ok(existsSync(envPath), 'DIGESTSEO_DB_PATH was not used');
  } finally {
    if (prev === undefined) delete process.env.DIGESTSEO_DB_PATH;
    else process.env.DIGESTSEO_DB_PATH = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('dispatch failure closes only an in-progress run and keeps completed evidence', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'prompt-1', 'What is Acme?');
    const brand = await db.getBrand('acme');
    assert.ok(brand);
    const failed = await db.createRun(brand, 'chatgpt', 'live', 1);
    await db.insertPromptResponse({
      run_id: failed.id,
      prompt_id: 'prompt-1',
      engine: 'chatgpt',
      raw_response: 'Acme appeared in a partial result.',
      brand_mentioned: 1,
      brand_cited_with_link: 0,
      cited_urls: [],
      competitors_mentioned: [],
      status: 'ok',
    });
    assert.equal(await db.failRunIfInProgress(failed.id, 'HTTP 503'), true);
    assert.equal((await db.getRunById(failed.id))?.status, 'failed');
    assert.equal((await db.getRunById(failed.id))?.error, 'HTTP 503');
    assert.ok((await db.getRunById(failed.id))?.completed_at);
    assert.equal((await db.getResponsesForRun(failed.id)).length, 1);
    assert.equal(await db.failRunIfInProgress(failed.id, 'late retry'), false);
    assert.equal((await db.getRunById(failed.id))?.error, 'HTTP 503');

    const completed = await db.createRun(brand, 'claude', 'live', 1);
    await db.updateRun(completed.id, {
      status: 'completed', prompts_completed: 1, completed_at: Date.now(),
    });
    assert.equal(await db.failRunIfInProgress(completed.id, 'late 503'), false);
    assert.equal((await db.getRunById(completed.id))?.status, 'completed');
    assert.equal((await db.getRunById(completed.id))?.error, null);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('insert brand → getBrand round-trips with parsed competitors', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    seedBrandFixture(db, 'acme');
    const brand = await db.getBrand('acme');
    assert.ok(brand, 'brand not found after insert');
    assert.equal(brand.id, 'acme');
    assert.equal(brand.name, 'Acme Project Tool');
    assert.equal(brand.domain, 'acme.com');
    assert.deepEqual(brand.competitors, ['asana.com', 'monday.com']);
    assert.equal(await db.getBrand('missing'), null);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('record a run: createRun + persistEngineRun + getResponsesForRun', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'p1', 'best project management tools');
    seedPromptFixture(db, 'acme', 'p2', 'asana alternatives');
    const brand = await db.getBrand('acme');
    assert.ok(brand);
    const prompts = await db.getActivePrompts('acme');
    assert.equal(prompts.length, 2);

    const run = await db.createRun(brand, 'chatgpt', 'live', prompts.length);
    assert.equal(run.status, 'in_progress');

    await db.persistEngineRun(run.id, 'chatgpt', 'gpt-4o-mini', 3600, [
      {
        prompt_id: 'p1',
        raw_response: 'Acme (https://acme.com) and Asana are popular.',
        brand_mentioned: 1,
        brand_cited_with_link: 1,
        cited_urls: ['acme.com'],
        competitors_mentioned: ['asana.com'],
        status: 'ok',
        cache_to_put: { prompt_hash: 'hash-p1', raw_response: 'cached body' },
      },
      {
        prompt_id: 'p2',
        raw_response: '',
        brand_mentioned: 0,
        brand_cited_with_link: 0,
        cited_urls: [],
        competitors_mentioned: [],
        status: 'failed',
        error_message: 'OpenAI chat completion failed: 500',
      },
    ]);

    // Only the status='ok' row surfaces; JSON columns come back parsed.
    const responses = await db.getResponsesForRun(run.id);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].prompt_id, 'p1');
    assert.equal(responses[0].prompt_text, 'best project management tools');
    assert.deepEqual(responses[0].cited_urls, ['acme.com']);
    assert.deepEqual(responses[0].competitors_mentioned, ['asana.com']);

    // The run is closed with the ok-count, never left in_progress.
    const closed = await db.getRunById(run.id);
    assert.ok(closed);
    assert.equal(closed.status, 'completed');
    assert.equal(closed.prompts_completed, 1);
    assert.ok(closed.completed_at !== null);

    // getLatestCompletedRun anchors on EXISTS(ok rows).
    const latest = await db.getLatestCompletedRun('acme', 'chatgpt');
    assert.ok(latest);
    assert.equal(latest.id, run.id);

    // Cache back-fill landed and round-trips through bulkCacheGet.
    const cacheMap = await db.bulkCacheGet(
      ['hash-p1', 'hash-miss'],
      'chatgpt',
      'gpt-4o-mini',
    );
    assert.equal(cacheMap.get('hash-p1'), 'cached body');
    assert.equal(cacheMap.has('hash-miss'), false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('getResponsesSince returns every usable response in the requested brand window', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'p1', 'best project management tools');
    const brand = await db.getBrand('acme');
    assert.ok(brand);

    const first = await db.createRun(brand, 'chatgpt', 'live', 1);
    await db.persistEngineRun(first.id, 'chatgpt', 'gpt-4o-mini', 3600, [
      {
        prompt_id: 'p1',
        raw_response: 'Acme and Asana are popular.',
        brand_mentioned: 1,
        brand_cited_with_link: 0,
        cited_urls: [],
        competitors_mentioned: ['asana.com'],
        status: 'ok',
      },
    ]);
    const second = await db.createRun(brand, 'chatgpt', 'live', 1);
    await db.persistEngineRun(second.id, 'chatgpt', 'gpt-4o-mini', 3600, [
      {
        prompt_id: 'p1',
        raw_response: 'Asana and Monday are popular.',
        brand_mentioned: 0,
        brand_cited_with_link: 0,
        cited_urls: [],
        competitors_mentioned: ['asana.com', 'monday.com'],
        status: 'ok',
      },
    ]);

    await db.insertPromptResponse({
      run_id: first.id,
      prompt_id: 'p1',
      engine: 'chatgpt',
      raw_response: 'Provider failed before usable scoring evidence.',
      brand_mentioned: 0,
      brand_cited_with_link: 0,
      cited_urls: [],
      competitors_mentioned: [],
      status: 'failed',
    });

    // Repeated successful attempts inside one run/prompt must not increase
    // comparison evidence rows; the newest usable attempt is authoritative.
    await db.insertPromptResponse({
      run_id: first.id,
      prompt_id: 'p1',
      engine: 'chatgpt',
      raw_response: 'Asana is popular without Acme.',
      brand_mentioned: 0,
      brand_cited_with_link: 0,
      cited_urls: [],
      competitors_mentioned: ['asana.com'],
      status: 'ok',
    });
    const now = Date.now();
    db.raw.prepare('UPDATE prompt_responses SET captured_at = ? WHERE raw_response = ?')
      .run(now - 5_000, 'Acme and Asana are popular.');
    db.raw.prepare('UPDATE prompt_responses SET captured_at = ? WHERE raw_response = ?')
      .run(now - 1_000, 'Asana is popular without Acme.');

    const all = await db.getResponsesSince('acme', Date.now() - 60_000);
    assert.equal(
      all.length,
      2,
      'comparison windows must include more than the latest run',
    );
    assert.deepEqual(
      all.map((r) => r.run_id),
      [first.id, second.id],
    );
    assert.equal(all[0].brand_mentioned, 0, 'latest successful retry must win');
    assert.equal(all[0].run_started_at, first.started_at,
      'identity comparisons must use run start, not response capture time');
    assert.equal(all[1].run_started_at, second.started_at);

    const hostedSql: string[] = [];
    const hosted = createD1Db({
      prepare(sql: string) {
        hostedSql.push(sql);
        return {
          bind(...params: unknown[]) {
            return {
              async all() {
                const statement = db.raw.prepare(sql);
                return { results: statement.all(...(params as Parameters<typeof statement.all>)) };
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof createD1Db>[0]);
    const hostedRows = await hosted.getResponsesSince('acme', Date.now() - 60_000);
    assert.deepEqual(hostedRows, all, 'D1 and SQLite must return identical deduplication evidence');
    for (const row of all) {
      assert.ok(row.id && row.run_id && row.prompt_id && row.engine);
      assert.equal(row.status, 'ok');
      assert.ok(Number.isSafeInteger(row.captured_at));
      assert.equal(typeof row.prompt_text, 'string');
      assert.ok(Array.isArray(row.competitors_mentioned));
      for (const unused of ['raw_response', 'cited_urls', 'engine_citations', 'error_message']) {
        assert.equal(Object.hasOwn(row, unused), false, `${unused} must not be materialized for comparisons`);
      }
    }
    assert.ok(hostedSql.every((sql) => !sql.includes('raw_response')));

    db.raw.prepare('UPDATE prompt_responses SET captured_at = ? WHERE run_id = ? AND status = ?')
      .run(now - 1_000, first.id, 'ok');
    const tiedIds = db.raw
      .prepare('SELECT id FROM prompt_responses WHERE run_id = ? AND status = ? ORDER BY id DESC')
      .all(first.id, 'ok') as Array<{ id: string }>;
    const tied = await db.getResponsesSince('acme', Date.now() - 60_000);
    assert.equal(tied.find((row) => row.run_id === first.id)?.id, tiedIds[0].id,
      'equal-timestamp successful retries must break ties by highest response ID');
    assert.deepEqual(await hosted.getResponsesSince('acme', Date.now() - 60_000), tied,
      'D1 and SQLite must agree on same-timestamp tie-breaking');

    db.raw
      .prepare('UPDATE prompt_responses SET captured_at = ? WHERE run_id = ?')
      .run(Date.now() - 120_000, first.id);
    const recent = await db.getResponsesSince('acme', Date.now() - 60_000);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].run_id, second.id);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('citation source projections preserve complete window, engine and status parity in SQLite and D1', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'p1', 'Which tools cite Acme?');
    seedBrandFixture(db, 'other');
    seedPromptFixture(db, 'other', 'p2', 'Which tools cite Other?');
    const brand = await db.getBrand('acme');
    const other = await db.getBrand('other');
    assert.ok(brand);
    assert.ok(other);
    const now = Date.now();
    const insert = async (
      target: typeof brand,
      promptId: string,
      engine: string,
      status: 'ok' | 'failed',
      citedUrl: string,
      capturedAt: number,
      mode: 'live' | 'batch' = 'live',
    ) => {
      const run = await db.createRun(target, engine, mode, 1);
      await db.persistEngineRun(run.id, engine, 'offline-model', 3600, [{
        prompt_id: promptId,
        raw_response: 'This large AI answer is not needed for source aggregation. '.repeat(30),
        brand_mentioned: 0,
        brand_cited_with_link: 0,
        cited_urls: [],
        competitors_mentioned: [],
        engine_citations: [citedUrl],
        status,
      }]);
      db.raw.prepare('UPDATE prompt_responses SET captured_at = ? WHERE run_id = ?')
        .run(capturedAt, run.id);
      return run.id;
    };
    const firstRunId = await insert(brand, 'p1', 'chatgpt', 'ok', 'https://research.example/old', now - 20_000, 'batch');
    const secondRunId = await insert(brand, 'p1', 'perplexity', 'ok', 'https://research.example/new', now - 10_000);
    await insert(brand, 'p1', 'gemini', 'failed', 'https://invalid.example/failed', now - 5_000);
    await insert(other, 'p2', 'chatgpt', 'ok', 'https://other.example/citation', now - 5_000);
    // A successful retry supersedes an older observation of the same run and
    // prompt. It must not double-count source evidence or preserve stale URLs.
    await db.insertPromptResponse({
      run_id: firstRunId,
      prompt_id: 'p1',
      engine: 'chatgpt',
      raw_response: 'Latest source-only retry',
      brand_mentioned: 0,
      brand_cited_with_link: 0,
      cited_urls: [],
      competitors_mentioned: [],
      engine_citations: ['https://research.example/retried'],
      status: 'ok',
    });
    db.raw.prepare('UPDATE prompt_responses SET captured_at = ? WHERE run_id = ? AND raw_response = ?')
      .run(now - 15_000, firstRunId, 'Latest source-only retry');

    const selectedSql: string[] = [];
    const hosted = createD1Db({
      prepare(sql: string) {
        selectedSql.push(sql);
        return {
          bind(...params: unknown[]) {
            return {
              async all() {
                const statement = db.raw.prepare(sql);
                return { results: statement.all(...(params as Parameters<typeof statement.all>)) };
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof createD1Db>[0]);

    const expectedUrls = ['https://research.example/retried', 'https://research.example/new'];
    for (const adapter of [db, hosted]) {
      const full = await adapter.getCitationSourceRows('acme', now - 30_000, now);
      assert.deepEqual(full.map((row) => row.engine_citations[0]), expectedUrls);
      assert.deepEqual(full.map((row) => row.engine), ['chatgpt', 'perplexity']);
      assert.deepEqual(full.map((row) => row.mode), ['batch', 'live'],
        'SQLite and D1 must retain source run mode without reading AI answer bodies');
      assert.deepEqual(full.map((row) => row.run_started_at),
        [(await db.getRunById(firstRunId))?.started_at, (await db.getRunById(secondRunId))?.started_at],
        'SQLite and D1 must project originating run start instead of source capture time');
      const frozenWindow = await adapter.getCitationSourceRows('acme', now - 30_000, now - 18_000);
      assert.deepEqual(frozenWindow.map((row) => row.engine_citations[0]),
        ['https://research.example/old'],
        'a retry after the frozen window must not erase its earlier source evidence');
      assert.ok(full.every((row) => !Object.hasOwn(row, 'raw_response')));
      assert.ok(full.every((row) => !Object.hasOwn(row, 'prompt_text')));
      const filtered = await adapter.getCitationSourceRows(
        'acme', now - 15_000, now - 8_000, 'perplexity',
      );
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].engine_citations[0], expectedUrls[1]);
      assert.deepEqual(
        await adapter.getCitationSourceRows('acme', now - 9_000, now),
        [],
        'failed observations and other brands must not appear',
      );
    }
    // Equal capture times must choose the highest response ID consistently,
    // including through D1's SQL projection.
    await db.insertPromptResponse({
      run_id: firstRunId,
      prompt_id: 'p1',
      engine: 'chatgpt',
      raw_response: 'Tied successful source retry',
      brand_mentioned: 0,
      brand_cited_with_link: 0,
      cited_urls: [],
      competitors_mentioned: [],
      engine_citations: ['https://research.example/tied'],
      status: 'ok',
    });
    db.raw.prepare('UPDATE prompt_responses SET captured_at = ? WHERE run_id = ? AND raw_response = ?')
      .run(now - 15_000, firstRunId, 'Tied successful source retry');
    const winner = db.raw.prepare(
      'SELECT engine_citations_json FROM prompt_responses WHERE run_id = ? AND captured_at = ? ORDER BY id DESC LIMIT 1',
    ).get(firstRunId, now - 15_000) as { engine_citations_json: string };
    const winningUrl = JSON.parse(winner.engine_citations_json)[0];
    for (const adapter of [db, hosted]) {
      const rows = await adapter.getCitationSourceRows('acme', now - 30_000, now);
      assert.deepEqual(rows.map((row) => row.engine_citations[0]),
        [winningUrl, 'https://research.example/new']);
    }
    assert.ok(selectedSql.length >= 3);
    assert.ok(selectedSql.every((sql) => !sql.includes('raw_response')));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('getLatestCompletedRun skips runs whose rows all failed', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'p1', 'best project management tools');
    const brand = await db.getBrand('acme');
    assert.ok(brand);

    const goodRun = await db.createRun(brand, 'chatgpt', 'live', 1);
    await db.persistEngineRun(goodRun.id, 'chatgpt', 'gpt-4o-mini', 3600, [
      {
        prompt_id: 'p1',
        raw_response: 'Acme is great.',
        brand_mentioned: 1,
        brand_cited_with_link: 0,
        cited_urls: [],
        competitors_mentioned: [],
        status: 'ok',
      },
    ]);

    // A later run where every prompt failed must not shadow the good one.
    const badRun = await db.createRun(brand, 'chatgpt', 'live', 1);
    await db.persistEngineRun(badRun.id, 'chatgpt', 'gpt-4o-mini', 3600, [
      {
        prompt_id: 'p1',
        raw_response: '',
        brand_mentioned: 0,
        brand_cited_with_link: 0,
        cited_urls: [],
        competitors_mentioned: [],
        status: 'failed',
        error_message: 'rate limited',
      },
    ]);

    const latest = await db.getLatestCompletedRun('acme', 'chatgpt');
    assert.ok(latest);
    assert.equal(latest.id, goodRun.id);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('SQLite and D1 can select live or batch evidence independently while preserving latest default', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'mode-query.sqlite'));
  try {
    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'p1', 'Best project management tools');
    const brand = await db.getBrand('acme');
    assert.ok(brand);

    const live = await db.createRun(brand, 'chatgpt', 'live', 2);
    await db.persistEngineRun(live.id, 'chatgpt', 'offline', 3600, [{
      prompt_id: 'p1', raw_response: 'Acme', brand_mentioned: 1,
      brand_cited_with_link: 0, cited_urls: [], competitors_mentioned: [], status: 'ok',
    }]);
    // Retain one successfully measured prompt despite a partial run.
    db.raw.prepare("UPDATE runs SET started_at = 1000, completed_at = NULL, status = 'in_progress' WHERE id = ?")
      .run(live.id);

    const batch = await db.createRun(brand, 'chatgpt', 'batch', 1);
    await db.persistEngineRun(batch.id, 'chatgpt', 'offline', 3600, [{
      prompt_id: 'p1', raw_response: 'No brand', brand_mentioned: 0,
      brand_cited_with_link: 0, cited_urls: [], competitors_mentioned: [], status: 'ok',
    }]);
    db.raw.prepare('UPDATE runs SET started_at = 2000, completed_at = 3000 WHERE id = ?')
      .run(batch.id);

    const hosted = createD1Db({
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async first() {
                const statement = db.raw.prepare(sql);
                return statement.get(...(params as Parameters<typeof statement.get>)) ?? null;
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof createD1Db>[0]);

    for (const adapter of [db, hosted]) {
      assert.equal((await adapter.getLatestCompletedRun('acme', 'chatgpt'))?.id, batch.id);
      assert.equal((await adapter.getLatestCompletedRun('acme', 'chatgpt', 'live'))?.id, live.id);
      assert.equal((await adapter.getLatestCompletedRun('acme', 'chatgpt', 'batch'))?.id, batch.id);
      assert.equal(await adapter.getLatestCompletedRun('acme', 'claude', 'batch'), null);
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectBatch resolves submitted prompts after they are deactivated', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  const originalFetch = globalThis.fetch;
  try {
    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'old-a', 'original prompt A');
    seedPromptFixture(db, 'acme', 'old-b', 'original prompt B');
    const brand = await db.getBrand('acme');
    assert.ok(brand);
    const submitted = await db.getActivePrompts(brand.id);
    const run = await db.createRun(brand, 'chatgpt', 'batch', submitted.length);
    await db.updateRun(run.id, { batch_id: 'batch-1' });

    await db.replacePrompts(brand.id, [
      { text: 'replacement prompt', intent_stage: null, shape: null },
    ]);
    assert.deepEqual(
      (await db.getActivePrompts(brand.id)).map((prompt) => prompt.text),
      ['replacement prompt'],
    );
    assert.deepEqual(
      (await db.getPromptsByIds(['old-b', 'old-a'])).map((prompt) => prompt.id),
      ['old-b', 'old-a'],
    );

    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(
          JSON.stringify({ status: 'completed', output_file_id: 'output-1' }),
        );
      }
      return new Response(
        [
          JSON.stringify({
            custom_id: 'old-b',
            response: {
              body: {
                choices: [{ finish_reason: 'stop', message: { content: 'Acme answer for B.' } }],
              },
            },
          }),
          JSON.stringify({
            custom_id: 'old-a',
            response: {
              body: {
                choices: [{ finish_reason: 'stop', message: { content: 'Acme answer for A.' } }],
              },
            },
          }),
        ].join('\n'),
      );
    }) as typeof fetch;

    const result = await collectBatch(
      { db, OPENAI_API_KEY: 'test-key' },
      { ...run, batch_id: 'batch-1' },
      brand,
    );
    assert.deepEqual(result, {
      ready: true,
      status: 'completed',
      completed: 2,
      failed: 0,
    });
    const responses = await db.getResponsesForRun(run.id);
    assert.deepEqual(
      responses.map((response) => response.prompt_id).sort(),
      ['old-a', 'old-b'],
    );
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectBatch replaces partial results when the same completed batch is collected again', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  const originalFetch = globalThis.fetch;
  try {
    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'prompt-a', 'first prompt');
    seedPromptFixture(db, 'acme', 'prompt-b', 'second prompt');
    seedPromptFixture(db, 'acme', 'prompt-c', 'third prompt');
    const brand = await db.getBrand('acme');
    assert.ok(brand);
    const run = await db.createRun(brand, 'chatgpt', 'batch', 3);
    await db.updateRun(run.id, { batch_id: 'batch-1' });

    await db.insertPromptResponse({
      run_id: run.id,
      prompt_id: 'prompt-a',
      engine: 'chatgpt',
      raw_response: 'stale partial result',
      brand_mentioned: 0,
      brand_cited_with_link: 0,
      cited_urls: [],
      competitors_mentioned: [],
      status: 'ok',
    });

    let request = 0;
    let collection = 0;
    globalThis.fetch = (async () => {
      request += 1;
      const requestInCollection = request % 3;
      if (requestInCollection === 1) {
        collection += 1;
        return new Response(
          JSON.stringify({
            status: 'completed',
            output_file_id: 'output-1',
            error_file_id: 'error-1',
          }),
        );
      }
      const suffix = collection === 1 ? 'first' : 'second';
      if (requestInCollection === 0) {
        return new Response(
          JSON.stringify({
            custom_id: 'prompt-c',
            response: {
              status_code: 429,
              body: { error: { message: `Acme ${suffix} error C.` } },
            },
          }),
        );
      }
      return new Response(
        [
          JSON.stringify({
            custom_id: 'prompt-a',
            response: {
              body: {
                choices: [{ finish_reason: 'stop', message: { content: `Acme ${suffix} answer A.` } }],
              },
            },
          }),
          JSON.stringify({
            custom_id: 'prompt-b',
            response: {
              body: {
                choices: [{ finish_reason: 'stop', message: { content: `Acme ${suffix} answer B.` } }],
              },
            },
          }),
        ].join('\n'),
      );
    }) as typeof fetch;

    await collectBatch(
      { db, OPENAI_API_KEY: 'test-key' },
      { ...run, batch_id: 'batch-1' },
      brand,
    );
    await collectBatch(
      { db, OPENAI_API_KEY: 'test-key' },
      { ...run, batch_id: 'batch-1' },
      brand,
    );

    const responseCount = db.raw
      .prepare('SELECT COUNT(*) AS n FROM prompt_responses WHERE run_id = ?')
      .get(run.id) as { n: number };
    assert.equal(responseCount.n, 3);
    assert.deepEqual(
      (await db.getResponsesForRun(run.id))
        .map((response) => response.raw_response)
        .sort(),
      ['Acme second answer A.', 'Acme second answer B.'],
    );
    const refreshedRun = await db.getRunById(run.id);
    assert.equal(refreshedRun?.prompts_completed, 2);
    assert.deepEqual(
      db.raw
        .prepare(
          'SELECT prompt_id, status, error_message FROM prompt_responses WHERE run_id = ? ORDER BY prompt_id',
        )
        .all(run.id)
        .map((row) => ({ ...row })),
      [
        { prompt_id: 'prompt-a', status: 'ok', error_message: null },
        { prompt_id: 'prompt-b', status: 'ok', error_message: null },
        {
          prompt_id: 'prompt-c',
          status: 'failed',
          error_message: 'Acme second error C.',
        },
      ],
    );
    assert.deepEqual(
      (
        db.raw
          .prepare(
            "SELECT raw_response FROM shared_prompt_cache WHERE engine = 'chatgpt' ORDER BY raw_response",
          )
          .all() as Array<{ raw_response: string }>
      ).map((row) => row.raw_response),
      ['Acme second answer A.', 'Acme second answer B.'],
    );
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectBatch persists an all-failed batch from its error file', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  const originalFetch = globalThis.fetch;
  try {
    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'failed-prompt', 'a failing prompt');
    const brand = await db.getBrand('acme');
    assert.ok(brand);
    const run = await db.createRun(brand, 'chatgpt', 'batch', 1);

    let request = 0;
    globalThis.fetch = (async () => {
      request += 1;
      return request === 1
        ? new Response(
          JSON.stringify({ status: 'completed', error_file_id: 'error-1' }),
        )
        : new Response(
          JSON.stringify({
            custom_id: 'failed-prompt',
            error: { message: 'OpenAI timed out the request.' },
          }),
        );
    }) as typeof fetch;

    const result = await collectBatch(
      { db, OPENAI_API_KEY: 'test-key' },
      { ...run, batch_id: 'batch-1' },
      brand,
    );
    assert.deepEqual(result, {
      ready: true,
      status: 'completed',
      completed: 0,
      failed: 1,
    });
    assert.deepEqual(
      db.raw
        .prepare(
          'SELECT prompt_id, status, error_message FROM prompt_responses WHERE run_id = ?',
        )
        .all(run.id)
        .map((row) => ({ ...row })),
      [
        {
          prompt_id: 'failed-prompt',
          status: 'failed',
          error_message: 'OpenAI timed out the request.',
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectBatch rejects unknown output prompt IDs before writing responses', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  const originalFetch = globalThis.fetch;
  try {
    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'known-prompt', 'known prompt');
    const brand = await db.getBrand('acme');
    assert.ok(brand);
    const run = await db.createRun(brand, 'chatgpt', 'batch', 1);

    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(
          JSON.stringify({ status: 'completed', output_file_id: 'output-1' }),
        );
      }
      return new Response(
        [
          JSON.stringify({
            custom_id: 'known-prompt',
            response: {
              body: {
                choices: [{ finish_reason: 'stop', message: { content: 'Acme valid answer.' } }],
              },
            },
          }),
          JSON.stringify({
            custom_id: 'missing-prompt',
            response: {
              body: {
                choices: [{ finish_reason: 'stop', message: { content: 'Unknown answer.' } }],
              },
            },
          }),
        ].join('\n'),
      );
    }) as typeof fetch;

    await assert.rejects(
      collectBatch(
        { db, OPENAI_API_KEY: 'test-key' },
        { ...run, batch_id: 'batch-1' },
        brand,
      ),
      /OpenAI batch integrity error.*missing-prompt/,
    );
    assert.deepEqual(await db.getResponsesForRun(run.id), []);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('getBrandsDueForRefresh uses the latest run with usable responses', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    await db.upsertUser('test-user', 'test@local');
    const now = Date.now();
    const recent = now - 24 * 60 * 60 * 1000;
    const old = now - 8 * 24 * 60 * 60 * 1000;

    async function createCadenceBrand(id: string) {
      await db.createBrand({
        id,
        user_id: 'test-user',
        domain: `${id}.com`,
        name: id,
        category: null,
        competitors: [],
        aliases: [],
        exclude_terms: [],
        refresh_frequency: 'weekly',
      });
      seedPromptFixture(db, id, `${id}-prompt`, `What is ${id}?`);
      const brand = await db.getBrand(id);
      assert.ok(brand);
      return brand;
    }

    async function persistRun(
      brand: NonNullable<Awaited<ReturnType<typeof db.getBrand>>>,
      status: 'ok' | 'failed',
      timestamp: number,
    ) {
      const run = await db.createRun(brand, 'chatgpt', 'live', 1);
      await db.persistEngineRun(run.id, 'chatgpt', 'gpt-4o-mini', 3600, [
        {
          prompt_id: `${brand.id}-prompt`,
          raw_response: status === 'ok' ? `${brand.name} is available.` : '',
          brand_mentioned: status === 'ok' ? 1 : 0,
          brand_cited_with_link: 0,
          cited_urls: [],
          competitors_mentioned: [],
          status,
          error_message: status === 'failed' ? 'provider unavailable' : null,
        },
      ]);
      db.raw
        .prepare('UPDATE runs SET started_at = ?, completed_at = ? WHERE id = ?')
        .run(timestamp, timestamp, run.id);
    }

    const recentFailed = await createCadenceBrand('recent-failed');
    await persistRun(recentFailed, 'failed', recent);

    const recentUsable = await createCadenceBrand('recent-usable');
    await persistRun(recentUsable, 'ok', recent);

    const oldUsableThenFailed = await createCadenceBrand('old-usable-then-failed');
    await persistRun(oldUsableThenFailed, 'ok', old);
    await persistRun(oldUsableThenFailed, 'failed', recent);

    await createCadenceBrand('no-runs');
    await db.createBrand({
      id: 'manual-only',
      user_id: 'test-user',
      domain: 'manual-only.com',
      name: 'Manual Only',
      category: null,
      competitors: [],
      aliases: [],
      exclude_terms: [],
      refresh_frequency: 'manual',
    });

    const due = new Set((await db.getBrandsDueForRefresh()).map((brand) => brand.id));
    assert.equal(due.has('recent-failed'), true);
    assert.equal(due.has('recent-usable'), false);
    assert.equal(due.has('old-usable-then-failed'), true);
    assert.equal(due.has('no-runs'), true);
    assert.equal(due.has('manual-only'), false);

    const engineDue = new Set(
      (await db.getBrandsDueForRefresh(['chatgpt'])).map((brand) => brand.id),
    );
    assert.equal(engineDue.has('manual-only'), false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cron skips brands without active prompts in SQLite and D1', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    await db.upsertUser('test-user', 'test@local');
    for (const id of ['empty-brand', 'ready-brand']) {
      await db.createBrand({
        id,
        user_id: 'test-user',
        domain: `${id}.example`,
        name: id,
        category: null,
        competitors: [],
        aliases: [],
        exclude_terms: [],
        refresh_frequency: 'weekly',
      });
    }
    seedPromptFixture(db, 'ready-brand', 'ready-p1', 'Which tools are available?');
    const hosted = createD1Db({
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async all() {
                const statement = db.raw.prepare(sql);
                return { results: statement.all(...(params as Parameters<typeof statement.all>)) };
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof createD1Db>[0]);

    const assertDue = async (emptyIsDue: boolean) => {
      for (const adapter of [db, hosted]) {
        for (const engines of [undefined, ['chatgpt']]) {
          const due = new Set((await adapter.getBrandsDueForRefresh(engines)).map((b) => b.id));
          assert.equal(due.has('empty-brand'), emptyIsDue);
          assert.equal(due.has('ready-brand'), true);
        }
      }
    };

    await assertDue(false);
    seedPromptFixture(db, 'empty-brand', 'empty-p1', 'A new active question');
    await assertDue(true);
    db.raw.prepare('UPDATE prompts SET active = 0 WHERE brand_id = ?').run('empty-brand');
    await assertDue(false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cron live freshness ignores completed model-only batches in SQLite and D1', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    await db.upsertUser('test-user', 'test@local');
    await db.createBrand({
      id: 'batch-only-cron',
      user_id: 'test-user',
      domain: 'batch-only-cron.com',
      name: 'Batch Only Cron',
      category: null,
      competitors: [],
      aliases: [],
      exclude_terms: [],
      refresh_frequency: 'weekly',
    });
    seedPromptFixture(db, 'batch-only-cron', 'batch-prompt', 'Which products are available?');
    const brand = await db.getBrand('batch-only-cron');
    assert.ok(brand);
    const hosted = createD1Db({
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async all() {
                const statement = db.raw.prepare(sql);
                return { results: statement.all(...(params as Parameters<typeof statement.all>)) };
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof createD1Db>[0]);
    const persistSuccessfulRun = async (mode: 'live' | 'batch') => {
      const run = await db.createRun(brand, 'chatgpt', mode, 1);
      await db.persistEngineRun(run.id, 'chatgpt', 'test-model', 3600, [{
        prompt_id: 'batch-prompt',
        raw_response: 'Batch Only Cron is mentioned.',
        brand_mentioned: 1,
        brand_cited_with_link: 0,
        cited_urls: [],
        competitors_mentioned: [],
        status: 'ok',
      }]);
    };
    const assertCronDue = async (expected: boolean) => {
      for (const adapter of [db, hosted]) {
        for (const engines of [undefined, ['chatgpt']]) {
          const due = await adapter.getBrandsDueForRefresh(engines);
          assert.equal(due.some((item) => item.id === brand.id), expected);
        }
      }
    };

    // Batch evidence is valuable for model-only visibility, but cannot make
    // a live-search cron scan fresh or consume its weekly retry allowance.
    await persistSuccessfulRun('batch');
    await assertCronDue(true);
    await persistSuccessfulRun('batch');
    await assertCronDue(true);
    await persistSuccessfulRun('live');
    await assertCronDue(false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('partial prompt failures do not reset engine freshness and retry after a bounded cooldown', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    await db.upsertUser('test-user', 'test@local');
    await db.createBrand({
      id: 'partial-retry',
      user_id: 'test-user',
      domain: 'partial-retry.com',
      name: 'Partial Retry',
      category: null,
      competitors: [],
      aliases: [],
      exclude_terms: [],
      refresh_frequency: 'weekly',
    });
    seedPromptFixture(db, 'partial-retry', 'retry-p1', 'First buyer question');
    seedPromptFixture(db, 'partial-retry', 'retry-p2', 'Second buyer question');
    const brand = await db.getBrand('partial-retry');
    assert.ok(brand);
    // Exercise the D1 SQL through a compatible node:sqlite read-only binding,
    // so both adapters must agree on the same real database fixture.
    const hosted = createD1Db({
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async all() {
                const statement = db.raw.prepare(sql);
                return { results: statement.all(...(params as Parameters<typeof statement.all>)) };
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof createD1Db>[0]);
    const assertBothDue = async (expected: boolean) => {
      for (const adapter of [db, hosted]) {
        assert.equal(
          (await adapter.getBrandsDueForRefresh(['chatgpt'])).some((b) => b.id === brand.id),
          expected,
        );
        assert.equal(
          (await adapter.getBrandsDueForRefresh()).some((b) => b.id === brand.id),
          expected,
        );
      }
    };
    const now = Date.now();
    const partial = await db.createRun(brand, 'chatgpt', 'live', 2);
    const result = (prompt_id: string, status: 'ok' | 'failed') => ({
      prompt_id,
      raw_response: status === 'ok' ? 'Partial Retry is mentioned.' : '',
      brand_mentioned: status === 'ok' ? 1 : 0,
      brand_cited_with_link: 0,
      cited_urls: [],
      competitors_mentioned: [],
      status,
      error_message: status === 'failed' ? 'Provider unavailable' : null,
    });
    await db.persistEngineRun(partial.id, 'chatgpt', 'test-model', 3600, [
      result('retry-p1', 'ok'),
      result('retry-p2', 'failed'),
    ]);
    // A recent failed attempt must not trigger another paid retry every 6-hour cron.
    await assertBothDue(false);
    db.raw.prepare('UPDATE runs SET started_at = ?, completed_at = ? WHERE id = ?')
      .run(now - 25 * 60 * 60 * 1000, now - 25 * 60 * 60 * 1000, partial.id);
    // Having one usable row must not make the failed prompt fresh for a week.
    await assertBothDue(true);

    const secondPartial = await db.createRun(brand, 'chatgpt', 'live', 2);
    await db.persistEngineRun(secondPartial.id, 'chatgpt', 'test-model', 3600, [
      result('retry-p1', 'ok'),
      result('retry-p2', 'failed'),
    ]);
    // Even after another 24 hours, a weekly brand cannot consume quota daily
    // on an indefinitely failing prompt: two attempts within a week is the cap.
    db.raw.prepare('UPDATE runs SET started_at = ?, completed_at = ? WHERE id = ?')
      .run(now - 25 * 60 * 60 * 1000, now - 25 * 60 * 60 * 1000, secondPartial.id);
    await assertBothDue(false);

    // After the earlier attempt falls outside the rolling week, retry is due.
    db.raw.prepare('UPDATE runs SET started_at = ?, completed_at = ? WHERE id = ?')
      .run(now - 8 * 24 * 60 * 60 * 1000, now - 8 * 24 * 60 * 60 * 1000, partial.id);
    await assertBothDue(true);

    const complete = await db.createRun(brand, 'chatgpt', 'live', 2);
    await db.persistEngineRun(complete.id, 'chatgpt', 'test-model', 3600, [
      result('retry-p1', 'ok'),
      result('retry-p2', 'ok'),
    ]);
    await assertBothDue(false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('getBrandsDueForRefresh keeps a brand due when one configured engine is stale', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    await db.upsertUser('test-user', 'test@local');
    await db.createBrand({
      id: 'mixed-freshness',
      user_id: 'test-user',
      domain: 'mixed-freshness.com',
      name: 'Mixed Freshness',
      category: null,
      competitors: [],
      aliases: [],
      exclude_terms: [],
      refresh_frequency: 'weekly',
    });
    seedPromptFixture(db, 'mixed-freshness', 'mixed-prompt', 'best tools');
    const brand = await db.getBrand('mixed-freshness');
    assert.ok(brand);

    const now = Date.now();
    const old = now - 8 * 24 * 60 * 60 * 1000;
    for (const [engine, timestamp] of [
      ['claude', old],
      ['chatgpt', now],
    ] as const) {
      const run = await db.createRun(brand, engine, 'live', 1);
      await db.persistEngineRun(run.id, engine, 'test-model', 3600, [
        {
          prompt_id: 'mixed-prompt',
          raw_response: 'Mixed Freshness is visible.',
          brand_mentioned: 1,
          brand_cited_with_link: 0,
          cited_urls: [],
          competitors_mentioned: [],
          status: 'ok',
        },
      ]);
      db.raw
        .prepare('UPDATE runs SET started_at = ?, completed_at = ? WHERE id = ?')
        .run(timestamp, timestamp, run.id);
    }

    const onlyFreshEngine = new Set(
      (await db.getBrandsDueForRefresh(['chatgpt'])).map((item) => item.id),
    );
    assert.equal(onlyFreshEngine.has('mixed-freshness'), false);

    const allConfiguredEngines = new Set(
      (await db.getBrandsDueForRefresh(['chatgpt', 'claude'])).map(
        (item) => item.id,
      ),
    );
    assert.equal(allConfiguredEngines.has('mixed-freshness'), true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('read history: getVisibilityHistoryRows aggregates ok rows per run', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'p1', 'best project management tools');
    seedPromptFixture(db, 'acme', 'p2', 'asana alternatives');
    const brand = await db.getBrand('acme');
    assert.ok(brand);

    const run = await db.createRun(brand, 'claude', 'live', 2);
    await db.persistEngineRun(run.id, 'claude', 'claude-haiku-4-5', 3600, [
      {
        prompt_id: 'p1',
        raw_response: 'Acme leads the pack.',
        brand_mentioned: 1,
        brand_cited_with_link: 0,
        cited_urls: [],
        competitors_mentioned: [],
        status: 'ok',
      },
      {
        prompt_id: 'p2',
        raw_response: 'Asana and Monday are common picks.',
        brand_mentioned: 0,
        brand_cited_with_link: 0,
        cited_urls: [],
        competitors_mentioned: ['asana.com', 'monday.com'],
        status: 'ok',
      },
    ]);

    const rows = await db.getVisibilityHistoryRows('acme', 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].run_id, run.id);
    assert.equal(rows[0].engine, 'claude');
    assert.equal(rows[0].started_at, run.started_at);
    assert.equal(Number(rows[0].total), 2);
    assert.equal(Number(rows[0].hits), 1);
    assert.equal(Number(rows[0].roster_expected), 2);
    assert.equal(Number(rows[0].roster_observed), 2);
    assert.deepEqual(rows[0].roster_ids_csv?.split(',').sort(), ['p1', 'p2']);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('SQLite and D1 history count only the latest successful observation per run and prompt', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'history-observation.sqlite'));
  try {
    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'p1', 'best project management tools');
    seedPromptFixture(db, 'acme', 'p2', 'asana alternatives');
    const brand = await db.getBrand('acme');
    assert.ok(brand);
    const run = await db.createRun(brand, 'chatgpt', 'live', 2);
    const insert = db.raw.prepare(
      `INSERT INTO prompt_responses
         (id, run_id, prompt_id, engine, raw_response, brand_mentioned,
          brand_cited_with_link, cited_urls_json, competitors_mentioned_json,
          status, captured_at)
       VALUES (?, ?, ?, 'chatgpt', '', ?, 0, '[]', '[]', ?, ?)`,
    );
    insert.run('old-no-mention', run.id, 'p1', 0, 'ok', 1000);
    insert.run('new-mention', run.id, 'p1', 1, 'ok', 2000);
    insert.run('later-failed', run.id, 'p1', 0, 'failed', 3000);
    // Match computeOverallScore's deterministic id tie-breaker.
    insert.run('a-old-tie', run.id, 'p2', 0, 'ok', 2000);
    insert.run('b-new-tie', run.id, 'p2', 1, 'ok', 2000);

    const hosted = createD1Db({
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async all() {
                const statement = db.raw.prepare(sql);
                return { results: statement.all(...(params as Parameters<typeof statement.all>)) };
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof createD1Db>[0]);

    for (const adapter of [db, hosted]) {
      const rows = await adapter.getVisibilityHistoryRows('acme', 0);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].started_at, run.started_at,
        'both adapters must expose the real scan start for historical identity attribution');
      assert.equal(Number(rows[0].total), 2, 'retries must not inflate prompt denominator');
      assert.equal(Number(rows[0].hits), 2, 'latest successful response determines the hit');
      assert.equal(Number(rows[0].roster_observed), 2);
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('replacePrompts soft-deletes old prompts and getCitationRows filters by engine', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'p1', 'old prompt');
    const brand = await db.getBrand('acme');
    assert.ok(brand);

    const run = await db.createRun(brand, 'chatgpt', 'live', 1);
    await db.persistEngineRun(run.id, 'chatgpt', 'gpt-4o-mini', 3600, [
      {
        prompt_id: 'p1',
        raw_response: 'Acme (https://acme.com) is a solid choice.',
        brand_mentioned: 1,
        brand_cited_with_link: 1,
        cited_urls: ['acme.com'],
        competitors_mentioned: [],
        status: 'ok',
      },
    ]);

    const inserted = await db.replacePrompts('acme', [
      { text: 'new prompt one', intent_stage: 'comparison', shape: 'X vs Y' },
      { text: 'new prompt two', intent_stage: null, shape: null },
    ]);
    assert.equal(inserted, 2);
    const active = await db.getActivePrompts('acme');
    assert.deepEqual(
      active.map((p) => p.text).sort(),
      ['new prompt one', 'new prompt two'],
    );

    // Historical citation rows survive the soft-delete (FK target kept).
    const citations = await db.getCitationRows('acme', 0);
    assert.equal(citations.length, 1);
    assert.equal(citations[0].prompt, 'old prompt');
    assert.equal(citations[0].brand_cited_with_link, 1);
    assert.equal(citations[0].mode, 'live', 'citation provenance must preserve stored run dispatch mode');
    assert.equal(citations[0].run_started_at, run.started_at,
      'citation page identity provenance must use run start, not response capture');
    const hosted = createD1Db({
      prepare(sql: string) {
        return { bind(...params: unknown[]) {
          return { async all() {
            const stmt = db.raw.prepare(sql);
            return { results: stmt.all(...(params as Parameters<typeof stmt.all>)) };
          } };
        } };
      },
    } as unknown as Parameters<typeof createD1Db>[0]);
    assert.equal((await hosted.getCitationRows('acme', 0))[0].run_started_at, run.started_at,
      'D1 and SQLite citation pages must return identical run start provenance');
    const filtered = await db.getCitationRows('acme', 0, 'claude');
    assert.equal(filtered.length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('getCitationRows returns genuine link-only citations but excludes failed and unrelated responses', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    seedBrandFixture(db, 'acme');
    for (const promptId of ['p-link', 'p-mention', 'p-unrelated', 'p-failed']) {
      seedPromptFixture(db, 'acme', promptId, promptId);
    }
    const brand = await db.getBrand('acme');
    assert.ok(brand);
    const run = await db.createRun(brand, 'perplexity', 'live', 4);
    await db.persistEngineRun(run.id, 'perplexity', 'preset:fast', 3600, [
      { prompt_id: 'p-link', raw_response: 'Other brands only.', brand_mentioned: 0,
        brand_cited_with_link: 1, cited_urls: ['acme.com'],
        engine_citations: ['https://acme.com/report'], competitors_mentioned: [], status: 'ok' },
      { prompt_id: 'p-mention', raw_response: 'Acme has features.', brand_mentioned: 1,
        brand_cited_with_link: 0, cited_urls: [], competitors_mentioned: [], status: 'ok' },
      { prompt_id: 'p-unrelated', raw_response: 'No brand.', brand_mentioned: 0,
        brand_cited_with_link: 0, cited_urls: [], competitors_mentioned: [], status: 'ok' },
      { prompt_id: 'p-failed', raw_response: 'An incomplete result.', brand_mentioned: 0,
        brand_cited_with_link: 1, cited_urls: ['acme.com'], competitors_mentioned: [], status: 'failed' },
    ]);
    const rows = await db.getCitationRows('acme', 0);
    assert.deepEqual(rows.map((row) => row.prompt).sort(), ['p-link', 'p-mention']);
    assert.equal(rows.find((row) => row.prompt === 'p-link')?.brand_mentioned, 0);
    assert.equal(rows.find((row) => row.prompt === 'p-link')?.brand_cited_with_link, 1);
    assert.equal((await db.getCitationRows('acme', 0, 'chatgpt')).length, 0);
    const until = Date.now();
    const firstPage = await db.getCitationRows('acme', 0, undefined, { limit: 1, until });
    assert.equal(firstPage.length, 1);
    const anchor = firstPage[0];
    const secondPage = await db.getCitationRows('acme', 0, undefined, {
      limit: 1,
      until,
      before: {
        captured_at: anchor.captured_at,
        run_id: anchor.run_id,
        prompt_id: anchor.prompt_id,
      },
    });
    assert.equal(secondPage.length, 1);
    assert.notEqual(secondPage[0].prompt_id, anchor.prompt_id);
    assert.equal((await db.getCitationRows('acme', 0, undefined, {
      limit: 1,
      until,
      before: {
        captured_at: secondPage[0].captured_at,
        run_id: secondPage[0].run_id,
        prompt_id: secondPage[0].prompt_id,
      },
    })).length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('citation row pagination preserves repeated observations of the same run and prompt', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'p1', 'best project management');
    const brand = await db.getBrand('acme');
    assert.ok(brand);
    const run = await db.createRun(brand, 'chatgpt', 'live', 1);
    const observation = {
      prompt_id: 'p1',
      raw_response: 'Acme is recommended.',
      brand_mentioned: 1 as const,
      brand_cited_with_link: 0 as const,
      cited_urls: [],
      competitors_mentioned: [],
      status: 'ok' as const,
    };
    await db.persistEngineRun(run.id, 'chatgpt', 'test-model', 3600, [
      observation,
      { ...observation, raw_response: 'Acme is another recommendation.' },
    ]);
    const rows = await db.getCitationRows('acme', 0);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].captured_at, rows[1].captured_at);
    assert.equal(new Set(rows.map((row) => row.response_id)).size, 2);

    const until = Date.now();
    const first = await db.getCitationRows('acme', 0, undefined, { limit: 1, until });
    assert.equal(first.length, 1);
    const second = await db.getCitationRows('acme', 0, undefined, {
      limit: 1, until,
      before: {
        captured_at: first[0].captured_at,
        run_id: first[0].run_id,
        prompt_id: first[0].prompt_id,
        response_id: first[0].response_id,
      },
    });
    assert.equal(second.length, 1);
    assert.notEqual(first[0].response_id, second[0].response_id);
    assert.equal((await db.getCitationRows('acme', 0, undefined, {
      limit: 1, until,
      before: {
        captured_at: second[0].captured_at,
        run_id: second[0].run_id,
        prompt_id: second[0].prompt_id,
        response_id: second[0].response_id,
      },
    })).length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('upsertUser + createBrand: insert-or-ignore semantics, getBrand round-trip', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    await db.upsertUser('local-user', 'local@localhost');
    // Second upsert with a different email is a no-op (INSERT OR IGNORE).
    await db.upsertUser('local-user', 'changed@localhost');

    await db.createBrand({
      id: 'acme',
      user_id: 'local-user',
      domain: 'acme.com',
      name: 'Acme Project Tool',
      category: 'Project management software',
      competitors: ['asana.com', 'monday.com'],
      refresh_frequency: 'weekly',
    });
    // Re-creating the same id must not throw and must not clobber.
    await db.createBrand({
      id: 'acme',
      user_id: 'local-user',
      domain: 'other.com',
      name: 'Other',
      category: null,
      competitors: [],
      refresh_frequency: 'daily',
    });

    const brand = await db.getBrand('acme');
    assert.ok(brand);
    assert.equal(brand.domain, 'acme.com');
    assert.equal(brand.name, 'Acme Project Tool');
    assert.deepEqual(brand.competitors, ['asana.com', 'monday.com']);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('listBrands returns every brand with its active prompt count', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    assert.deepEqual(await db.listBrands(), []);

    seedBrandFixture(db, 'acme');
    seedPromptFixture(db, 'acme', 'p1', 'best project management tools');
    seedPromptFixture(db, 'acme', 'p2', 'asana alternatives');
    // A second brand with zero prompts.
    db.raw
      .prepare(
        `INSERT INTO brands
           (id, user_id, domain, name, category, competitors_json,
            refresh_frequency, created_at, updated_at)
         VALUES ('beta', 'test-user', 'beta.io', 'Beta', NULL, NULL, 'weekly', ?, ?)`,
      )
      .run(Date.now() + 1, Date.now() + 1);

    const brands = await db.listBrands();
    assert.equal(brands.length, 2);
    const acme = brands.find((b) => b.id === 'acme');
    const beta = brands.find((b) => b.id === 'beta');
    assert.ok(acme);
    assert.ok(beta);
    assert.equal(Number(acme.active_prompts), 2);
    assert.equal(Number(beta.active_prompts), 0);
    assert.deepEqual(acme.competitors, ['asana.com', 'monday.com']);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('seedBrand (core): fallback prompts without ANTHROPIC_API_KEY, $CATEGORY substituted', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    const result = await seedBrand(
      { db },
      {
        brand_id: 'acme',
        name: 'Acme Project Tool',
        domain: 'acme.com',
        category: 'Project management software',
        competitors: ['asana.com'],
        refresh_frequency: 'manual',
      },
    );
    assert.equal(result.seeded, true);
    assert.equal(result.brand_id, 'acme');
    assert.equal(result.prompt_source, 'fallback');
    assert.equal(result.prompts_inserted, 3);
    assert.match(result.starter_prompt_limitations ?? '', /small starter sample/);

    const brand = await db.getBrand('acme');
    assert.ok(brand);
    assert.deepEqual(brand.competitors, ['asana.com']);
    assert.equal(brand.refresh_frequency, 'manual');

    const prompts = await db.getActivePrompts('acme');
    assert.equal(prompts.length, 3);
    const texts = prompts.map((p) => p.text);
    assert.ok(
      texts.includes('best tools for Project management software'),
      `expected $CATEGORY to be substituted; got: ${JSON.stringify(texts)}`,
    );
    assert.ok(
      texts.every((t) => !t.includes('$CATEGORY')),
      `a literal $CATEGORY placeholder leaked into prompts: ${JSON.stringify(texts)}`,
    );
    assert.ok(texts.every((text) => text.includes('Project management software')),
      'every provider-free starter prompt must be anchored to the supplied category');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider-free starter prompts disclose missing-category brand-name bias', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    const result = await seedBrand({ db }, {
      brand_id: 'uncategorized',
      name: 'Sample Studio',
      domain: 'sample.studio',
    });
    assert.equal(result.seeded, true);
    assert.equal(result.prompt_source, 'fallback');
    assert.match(result.starter_prompt_limitations ?? '', /bias brand-mention results/);
    assert.match(result.starter_prompt_limitations ?? '', /before scanning/);
    const prompts = await db.getActivePrompts('uncategorized');
    assert.equal(prompts.length, 3);
    assert.ok(prompts.every(({ text }) => text.includes('Sample Studio')));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('seedBrand requires an explicit opt-in before generating paid Anthropic prompts', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  let rejectWithNull = false;
  globalThis.fetch = async (input) => {
    providerCalls++;
    assert.match(String(input), /api\.anthropic\.com/);
    if (rejectWithNull) throw null;
    return Response.json({
      stop_reason: 'end_turn',
      content: [{
        type: 'text',
        text: JSON.stringify([{
          prompt: 'Best project management software for agencies?',
          intent_stage: 'awareness',
          shape: 'best X for Y',
        }]),
      }],
    });
  };
  try {
    const free = await seedBrand(
      { db, ANTHROPIC_API_KEY: 'mock-key' },
      { brand_id: 'free', name: 'Free', domain: 'free.example.com' },
    );
    assert.equal(free.prompt_source, 'fallback');
    assert.equal(free.prompts_inserted, 3);
    assert.equal(providerCalls, 0, 'configured key alone must not trigger billed generation');

    await assert.rejects(
      seedBrand(
        { db },
        {
          brand_id: 'missing-key',
          name: 'Missing Key',
          domain: 'missing-key.example.com',
          prompt_generation: 'anthropic',
        },
      ),
      /requires ANTHROPIC_API_KEY/,
    );
    assert.equal(await db.getBrand('missing-key'), null);

    const generated = await seedBrand(
      { db, ANTHROPIC_API_KEY: 'mock-key' },
      {
        brand_id: 'generated',
        name: 'Generated',
        domain: 'generated.example.com',
        prompt_generation: 'anthropic',
      },
      1,
    );
    assert.equal(generated.prompt_source, 'generated');
    assert.equal(generated.prompts_inserted, 1);
    assert.equal(providerCalls, 1, 'explicit generation makes one successful mocked request');
    assert.equal((await db.getActivePrompts('generated')).length, 1);

    const duplicate = await seedBrand(
      { db, ANTHROPIC_API_KEY: 'mock-key' },
      {
        brand_id: 'generated',
        name: 'Duplicate',
        domain: 'duplicate.example.com',
        prompt_generation: 'anthropic',
      },
      1,
    );
    assert.equal(duplicate.seeded, false);
    assert.equal(duplicate.reason, 'already exists');
    assert.equal(providerCalls, 1);
    const duplicateWithoutKey = await seedBrand(
      { db },
      {
        brand_id: 'generated',
        name: 'Duplicate Without Key',
        domain: 'duplicate.example.com',
        prompt_generation: 'anthropic',
      },
      1,
    );
    assert.equal(duplicateWithoutKey.reason, 'already exists');
    assert.equal(providerCalls, 1);

    rejectWithNull = true;
    const unavailable = await seedBrand(
      { db, ANTHROPIC_API_KEY: 'mock-key' },
      {
        brand_id: 'unavailable',
        name: 'Unavailable Provider',
        domain: 'unavailable.example.com',
        category: 'Project management',
        prompt_generation: 'anthropic',
      },
      1,
    );
    assert.equal(unavailable.prompt_source, 'fallback');
    assert.equal(unavailable.prompts_inserted, 3);
    assert.equal((await db.getActivePrompts('unavailable')).length, 3,
      'a failed provider must not strand a newly created brand without prompts');
    assert.equal(providerCalls, 2, 'provider errors must not trigger extra billed retries');

    await assert.rejects(
      seedBrand(
        { db, ANTHROPIC_API_KEY: ' \t ' },
        {
          brand_id: 'blank-key',
          name: 'Blank Key',
          domain: 'blank-key.example.com',
          prompt_generation: 'anthropic',
        },
        1,
      ),
      /requires ANTHROPIC_API_KEY/,
    );
    assert.equal(await db.getBrand('blank-key'), null,
      'blank provider credentials must be rejected before brand creation');
    assert.equal(providerCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('seedBrand normalizes hosted domain and competitor inputs before writing', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    const result = await seedBrand(
      { db },
      {
        brand_id: 'acme',
        name: 'Acme',
        domain: 'https://www.Acme.com/pricing?source=seed',
        competitors: [
          'https://www.Asana.com/pricing',
          'asana.com',
          'WWW.MONDAY.COM:443',
          'acme.com',
        ],
      },
    );
    assert.equal(result.seeded, true);
    const brand = await db.getBrand('acme');
    assert.ok(brand);
    assert.equal(brand.domain, 'acme.com');
    assert.deepEqual(brand.competitors, ['asana.com', 'monday.com']);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('seedBrand rejects a whitespace-only name before creating any records', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    await assert.rejects(
      seedBrand({ db }, { brand_id: 'blank-name', name: '  \t ', domain: 'example.com' }),
      /name must not be empty/,
    );
    assert.equal(await db.getBrand('blank-name'), null);
    const users = db.raw.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    assert.equal(users.count, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('seedBrand trims brand name for stored identity and provider-free prompts', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    const result = await seedBrand(
      { db },
      { brand_id: 'spaced-name', name: '  Acme Studio  ', domain: 'acme.com' },
    );
    assert.equal(result.seeded, true);
    assert.equal((await db.getBrand('spaced-name'))?.name, 'Acme Studio');
    const prompts = await db.getActivePrompts('spaced-name');
    assert.equal(prompts.length, 3);
    assert.ok(prompts.every(({ text }) => text.includes('Acme Studio')));
    assert.ok(prompts.every(({ text }) => !text.includes('  Acme Studio  ')));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('seedBrand rejects malformed domains before writing any rows', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    await assert.rejects(
      seedBrand(
        { db },
        {
          brand_id: 'invalid',
          name: 'Invalid',
          domain: 'not a domain',
        },
      ),
      /does not look like a domain/,
    );
    assert.equal(await db.getBrand('invalid'), null);
    const users = db.raw
      .prepare('SELECT COUNT(*) AS count FROM users')
      .get() as { count: number };
    assert.equal(users.count, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('seedBrand rejects invalid refresh_frequency before writing any rows', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    await assert.rejects(
      seedBrand(
        { db },
        {
          brand_id: 'invalid-cadence',
          name: 'Invalid cadence',
          domain: 'example.com',
          refresh_frequency: 'hourly' as 'daily',
        },
      ),
      /refresh_frequency must be daily, weekly, or manual/,
    );
    assert.equal(await db.getBrand('invalid-cadence'), null);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('seedBrand (core): already-existing brand is a clean no-op, empty input is a no-op', async () => {
  const root = tempRoot();
  const db = openSqliteDb(join(root, 'digestseo.sqlite'));
  try {
    const first = await seedBrand(
      { db },
      { brand_id: 'acme', name: 'Acme', domain: 'acme.com' },
    );
    assert.equal(first.seeded, true);

    const second = await seedBrand(
      { db },
      { brand_id: 'acme', name: 'Acme Again', domain: 'other.com' },
    );
    assert.equal(second.seeded, false);
    assert.equal(second.reason, 'already exists');
    // Prompts from the first seed are untouched.
    assert.equal((await db.getActivePrompts('acme')).length, 3);

    const empty = await seedBrand({ db }, null);
    assert.equal(empty.seeded, false);
    assert.equal(empty.reason, 'no brand payload provided');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
