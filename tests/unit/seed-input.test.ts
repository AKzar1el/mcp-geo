import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedBrand, type SeedBrandInput } from '../../src/core/seed.ts';
import { DomainInputError } from '../../src/core/domain.ts';
import type { Db } from '../../src/db/types.ts';
import { openSqliteDb } from '../../src/db/sqlite.ts';
import { createD1Db } from '../../src/db/d1.ts';

for (const driver of ['sqlite', 'd1'] as const) {
  test(`seedBrand: only the insertion winner seeds prompts (${driver})`, async () => {
    const local = openSqliteDb(':memory:');
    try {
      // Run the actual D1 SQL against SQLite and emulate its statement metadata.
      const adapter = driver === 'sqlite' ? local : createD1Db({
        prepare(sql: string) {
          return {
            bind(...params: Parameters<ReturnType<typeof local.raw.prepare>['run']>) {
              const statement = local.raw.prepare(sql);
              return {
                async first() { return statement.get(...params) ?? null; },
                async run() { return { meta: { changes: Number(statement.run(...params).changes) } }; },
              };
            },
          };
        },
      } as unknown as Parameters<typeof createD1Db>[0]);
      let initialReads = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      let replacements = 0;
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
      };
      const input = { brand_id: 'acme', name: 'Acme', domain: 'acme.com' };
      const results = await Promise.all([
        seedBrand({ db }, input),
        seedBrand({ db }, { ...input, name: 'Other', domain: 'other.com' }),
      ]);
      assert.equal(results.filter((result) => result.seeded).length, 1);
      assert.equal(results.find((result) => !result.seeded)?.reason, 'already exists');
      assert.equal(replacements, 1);
      const brand = await local.getBrand('acme');
      assert.equal(brand?.name, results[0].seeded ? 'Acme' : 'Other');
      assert.equal((await local.getActivePrompts('acme')).length, 3);
      assert.equal((await seedBrand({ db }, input)).seeded, false);
      assert.equal(replacements, 1);
      const other = await seedBrand({ db }, { ...input, brand_id: 'beta' });
      assert.equal(other.seeded, true);
      assert.equal(replacements, 2);
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
        createBrand: async (brand: unknown) => { stored = brand; return true; },
        replacePrompts: async (_id: string, prompts: Array<{ text: string }>) => {
          texts = prompts.map((prompt) => prompt.text);
        },
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
