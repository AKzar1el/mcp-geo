// Unit tests for the better-sqlite3 Db adapter (src/db/sqlite.ts) and
// the core seeding flow (src/core/seed.ts) on top of it. Runs against a
// throwaway database under the OS temp dir — no network, no Cloudflare.
// Run with: npm run test:unit
//
// Some fixtures are still inserted through the adapter's exposed raw
// better-sqlite3 handle where the test wants exact control over row
// shape, independent of the Db methods under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteDb, type SqliteDb } from '../../src/db/sqlite.ts';
import { seedBrand } from '../../src/core/seed.ts';
import { collectBatch } from '../../src/core/openai.ts';

const EXPECTED_MIGRATIONS = [
  '0001_initial.sql',
  '0002_fail_stuck_runs.sql',
  '0003_perplexity_citations.sql',
  '0004_response_status.sql',
  '0005_brand_alias_exclude.sql',
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
  // 0003/0005 are ALTER TABLE ADD COLUMN — re-applying them would throw
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
                choices: [{ message: { content: 'Acme answer for B.' } }],
              },
            },
          }),
          JSON.stringify({
            custom_id: 'old-a',
            response: {
              body: {
                choices: [{ message: { content: 'Acme answer for A.' } }],
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
                choices: [{ message: { content: 'Acme valid answer.' } }],
              },
            },
          }),
          JSON.stringify({
            custom_id: 'missing-prompt',
            response: {
              body: {
                choices: [{ message: { content: 'Unknown answer.' } }],
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

    const due = new Set((await db.getBrandsDueForRefresh()).map((brand) => brand.id));
    assert.equal(due.has('recent-failed'), true);
    assert.equal(due.has('recent-usable'), false);
    assert.equal(due.has('old-usable-then-failed'), true);
    assert.equal(due.has('no-runs'), true);
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
    assert.equal(Number(rows[0].total), 2);
    assert.equal(Number(rows[0].hits), 1);
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
    const filtered = await db.getCitationRows('acme', 0, 'claude');
    assert.equal(filtered.length, 0);
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
      },
    );
    assert.equal(result.seeded, true);
    assert.equal(result.brand_id, 'acme');
    assert.equal(result.prompt_source, 'fallback');
    assert.equal(result.prompts_inserted, 3);

    const brand = await db.getBrand('acme');
    assert.ok(brand);
    assert.deepEqual(brand.competitors, ['asana.com']);

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
  } finally {
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
