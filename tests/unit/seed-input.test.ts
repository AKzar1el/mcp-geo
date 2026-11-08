import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedBrand, type SeedBrandInput } from '../../src/core/seed.ts';
import { DomainInputError } from '../../src/core/domain.ts';
import type { Db } from '../../src/db/types.ts';

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
