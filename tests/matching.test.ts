// Unit tests for brand/competitor mention matching in extractCitations.
// Run with: npm run test:unit  (node --test via tsx, so we can import the
// TypeScript source directly). tests/ is outside tsconfig `include`, so this
// file is intentionally not part of `npm run typecheck`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractCitations } from '../src/openai.ts';
import type { Brand } from '../src/db.ts';

function makeBrand(overrides: Partial<Brand>): Brand {
  return {
    id: 'test-brand',
    user_id: 'dev-user',
    domain: 'example.com',
    name: 'Example',
    category: null,
    competitors: [],
    aliases: [],
    exclude_terms: [],
    refresh_frequency: 'weekly',
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

test('excluded bare word does not count as a brand mention', () => {
  const brand = makeBrand({
    domain: 'monday.com',
    name: 'Monday',
    competitors: ['notion.so'],
    aliases: [],
    exclude_terms: ['monday'],
  });
  const { brand_mentioned } = extractCitations(
    brand,
    'send the report on monday, promise.',
  );
  assert.equal(brand_mentioned, 0);
});

test('full domain still counts even when the bare word is excluded', () => {
  const brand = makeBrand({
    domain: 'monday.com',
    name: 'Monday',
    competitors: ['notion.so'],
    aliases: [],
    exclude_terms: ['monday'],
  });
  const { brand_mentioned } = extractCitations(brand, 'check monday.com for that.');
  assert.equal(brand_mentioned, 1);
});

test('root term is not matched inside a larger word', () => {
  const brand = makeBrand({
    domain: 'notion.so',
    name: 'Notion',
    exclude_terms: [],
  });
  const { brand_mentioned } = extractCitations(
    brand,
    'this was promotional content.',
  );
  assert.equal(brand_mentioned, 0);
});

test('competitor is matched as a standalone word', () => {
  const brand = makeBrand({
    domain: 'monday.com',
    name: 'Monday',
    competitors: ['notion.so'],
  });
  const { competitors_mentioned } = extractCitations(
    brand,
    'I prefer Notion for docs.',
  );
  assert.deepEqual(competitors_mentioned, ['notion.so']);
});
