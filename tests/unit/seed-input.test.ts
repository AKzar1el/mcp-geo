import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedBrand, type SeedBrandInput } from '../../src/core/seed.ts';
import { DomainInputError } from '../../src/core/domain.ts';
import type { Db } from '../../src/db/types.ts';
import { openSqliteDb } from '../../src/db/sqlite.ts';
import { createD1Db } from '../../src/db/d1.ts';

// Execute the D1 adapter's real SQL and emulate transactional batch metadata.
function d1OnSqlite(local: ReturnType<typeof openSqliteDb>): Db {
  type Params = Parameters<ReturnType<typeof local.raw.prepare>['run']>;
  type BoundStatement = { runSync(): { meta: { changes: number } } };
  return createD1Db({
    prepare(sql: string) {
      return {
        bind(...params: Params) {
          const statement = local.raw.prepare(sql);
          const runSync = () => ({ meta: { changes: Number(statement.run(...params).changes) } });
          return { runSync, async run() { return runSync(); }, async first() { return statement.get(...params) ?? null; } };
        },
      };
    },
    async batch(statements: BoundStatement[]) {
      local.raw.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.runSync());
        local.raw.exec('COMMIT');
        return results;
      } catch (error) {
        local.raw.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as Parameters<typeof createD1Db>[0]);
}

for (const driver of ['sqlite', 'd1'] as const) {
  test(`seedBrand: starter insertion failure leaves no stranded brand (${driver})`, async () => {
    const local = openSqliteDb(':memory:');
    try {
      const db = driver === 'sqlite' ? local : d1OnSqlite(local);
      const input = { brand_id: 'atomic', name: 'Atomic', domain: 'atomic.example.com' };
      local.raw.exec(`CREATE TRIGGER fail_starter BEFORE INSERT ON prompts
        WHEN NEW.brand_id = 'atomic' AND NEW.intent_stage = 'comparison'
        BEGIN SELECT RAISE(ABORT, 'synthetic starter failure'); END`);
      await assert.rejects(seedBrand({ db }, input), /synthetic starter failure/);
      assert.equal(await local.getBrand('atomic'), null);
      assert.equal((await local.getActivePrompts('atomic')).length, 0);

      local.raw.exec('DROP TRIGGER fail_starter');
      const retry = await seedBrand({ db }, input);
      assert.equal(retry.seeded, true);
      assert.equal(retry.prompts_inserted, 3);
      const prompts = await local.getActivePrompts('atomic');
      assert.equal(prompts.length, 3);

      const duplicate = await seedBrand({ db }, { ...input, name: 'Duplicate' });
      assert.equal(duplicate.seeded, false);
      assert.equal((await local.getBrand('atomic'))?.name, 'Atomic');
      assert.deepEqual(await local.getActivePrompts('atomic'), prompts);
    } finally {
      local.close();
    }
  });
}

for (const driver of ['sqlite', 'd1'] as const) {
  test(`seedBrand: only the insertion winner seeds prompts (${driver})`, async () => {
    const local = openSqliteDb(':memory:');
    try {
      const adapter = driver === 'sqlite' ? local : d1OnSqlite(local);
      let initialReads = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      let replacements = 0;
      let initializations = 0;
      const db: Db = {
        ...adapter,
        async getBrand(id) {
          const row = await adapter.getBrand(id);
          if (id === 'acme' && ++initialReads <= 2) {
            assert.equal(row, null);
            if (initialReads === 2) release();
            await barrier;
          }
          return row;
        },
        async replacePrompts(id, prompts) {
          replacements++;
          return local.replacePrompts(id, prompts);
        },
        async createBrand(input, initialPrompts) {
          const inserted = await adapter.createBrand(input, initialPrompts);
          if (inserted && initialPrompts?.length) initializations++;
          return inserted;
        },
      };
      const input = { brand_id: 'acme', name: 'Acme', domain: 'acme.com' };
      const results = await Promise.all([
        seedBrand({ db }, input),
        seedBrand({ db }, { ...input, name: 'Other', domain: 'other.com' }),
      ]);
      assert.equal(results.filter((result) => result.seeded).length, 1);
      assert.equal(results.find((result) => !result.seeded)?.reason, 'already exists');
      assert.equal(initializations, 1);
      assert.equal(replacements, 0);
      const brand = await local.getBrand('acme');
      assert.equal(brand?.name, results[0].seeded ? 'Acme' : 'Other');
      const prompts = await local.getActivePrompts('acme');
      assert.equal(prompts.length, 3);
      assert.ok(prompts.every(({ text }) => text.includes(brand!.name)));
      assert.equal((await seedBrand({ db }, input)).seeded, false);
      assert.equal(initializations, 1);
      assert.equal(replacements, 0);
      assert.deepEqual(await local.getActivePrompts('acme'), prompts);
      const other = await seedBrand({ db }, { ...input, brand_id: 'beta' });
      assert.equal(other.seeded, true);
      assert.equal(initializations, 2);
      assert.equal(replacements, 0);
    } finally {
      local.close();
    }
  });
}

for (const field of ['category', 'name'] as const) {
  test(`seedBrand preserves literal replacement tokens in fallback ${field}`, async () => {
    for (const label of ['Tools $&', 'Tools $$', 'Tools $`', "Tools $'", 'Tools $CATEGORY']) {
      const input = {
        brand_id: 'acme', name: 'Acme', domain: 'acme.com', [field]: label,
      };
      let stored: unknown = null;
      let texts: string[] = [];
      const db = {
        getBrand: async () => stored,
        upsertUser: async () => {},
        createBrand: async (brand: unknown, prompts: Array<{ text: string }>) => {
          stored = brand;
          texts = prompts.map((prompt) => prompt.text);
          return true;
        },
        replacePrompts: async () => { throw new Error('unexpected non-atomic starter write'); },
      } as unknown as Db;
      const result = await seedBrand({ db }, input);
      assert.equal(result.prompt_source, 'fallback');
      assert.equal(result.prompts_inserted, 3);
      assert.deepEqual(texts, [
        `best tools for ${label}`,
        `top alternatives in ${label}`,
        `most popular ${label} options for small teams`,
      ], label);
    }
  });
}

test('seedBrand rejects malformed hosted JSON fields before querying or changing the database', async () => {
  const valid = { brand_id: 'acme', name: 'Acme', domain: 'acme.com' };
  const invalid: Array<[string, unknown]> = [
    ['brand_id', { ...valid, brand_id: 42 }],
    ['brand_id', { ...valid, brand_id: '   ' }],
    ['name', { ...valid, name: 42 }],
    ['domain', { ...valid, domain: 42 }],
    ['category', { ...valid, category: { text: 'software' } }],
    ['competitors', { ...valid, competitors: 'other.com' }],
    ['competitors', { ...valid, competitors: ['other.com', 42] }],
    ['aliases', { ...valid, aliases: 'Acme' }],
    ['exclude_terms', { ...valid, exclude_terms: ['common', 42] }],
  ];

  for (const [field, input] of invalid) {
    let dbCalls = 0;
    const db = {
      getBrand: async () => { dbCalls++; return null; },
      upsertUser: async () => { dbCalls++; },
      createBrand: async () => { dbCalls++; },
      replacePrompts: async () => { dbCalls++; },
    } as unknown as Db;
    await assert.rejects(
      seedBrand({ db }, input as SeedBrandInput),
      (error: unknown) => error instanceof DomainInputError && error.message.includes(field),
      `invalid ${field} must be a typed 400-level input error`,
    );
    assert.equal(dbCalls, 0, `${field} must be validated before database access`);
  }
});

test('seedBrand rejects malformed falsy fields and oversized onboarding metadata before database access', async () => {
  const valid = { brand_id: 'acme', name: 'Acme', domain: 'acme.com' };
  const invalid: Array<[string, Record<string, unknown>]> = [
    ['brand_id', { ...valid, brand_id: 0 }],
    ['name', { ...valid, name: false }],
    ['domain', { ...valid, domain: null }],
    ['brand_id', { ...valid, brand_id: 'a'.repeat(65) }],
    ['name', { ...valid, name: 'n'.repeat(201) }],
    ['category', { ...valid, category: 'c'.repeat(201) }],
    ['competitors', { ...valid, competitors: Array(21).fill('other.com') }],
    ['aliases', { ...valid, aliases: Array(21).fill('Alias') }],
    ['exclude_terms', { ...valid, exclude_terms: ['x'.repeat(101)] }],
    ['competitors', { ...valid, competitors: [''] }],
  ];
  for (const [field, input] of invalid) {
    let dbCalls = 0;
    const db = {
      getBrand: async () => { dbCalls++; return null; },
      upsertUser: async () => { dbCalls++; },
      createBrand: async () => { dbCalls++; },
    } as unknown as Db;
    await assert.rejects(
      seedBrand({ db }, input as SeedBrandInput),
      (error: unknown) => error instanceof DomainInputError && error.message.includes(field),
      `invalid ${field} must be rejected rather than silently ignored`,
    );
    assert.equal(dbCalls, 0, `invalid ${field} must not touch the database`);
  }
});
