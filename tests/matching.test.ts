// Unit tests for brand/competitor mention matching in extractCitations.
// Run with: npm run test:unit  (node --test via tsx, so we can import the
// TypeScript source directly). tests/ is outside tsconfig `include`, so this
// file is intentionally not part of `npm run typecheck`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractCitations } from '../src/core/openai.ts';
import type { Brand } from '../src/db/types.ts';

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

test('citation hosts ignore trailing punctuation while preserving brand links', () => {
  const brand = makeBrand({
    domain: 'example.com',
    name: 'Example',
    competitors: ['notion.so'],
  });
  const result = extractCitations(
    brand,
    'Sources: https://example.com, https://notion.so; https://foo.example.com! ',
  );
  assert.deepEqual(result.cited_urls, ['example.com', 'notion.so', 'foo.example.com']);
  assert.equal(result.brand_cited_with_link, 1);
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

test('plain-text competitor names match the registrable label of common multi-part public suffixes', () => {
  const brand = makeBrand({
    domain: 'example.com',
    name: 'Example',
    competitors: ['acme.co.uk', 'zen.com.au', 'kumo.co.jp'],
  });
  const { competitors_mentioned } = extractCitations(
    brand,
    'For the shortlist, compare Acme with Zen and Kumo.',
  );
  assert.deepEqual(competitors_mentioned, ['acme.co.uk', 'zen.com.au', 'kumo.co.jp']);
});

test('Australian government-domain competitor names match visible prose without a URL', () => {
  const brand = makeBrand({
    domain: 'example.com',
    competitors: ['services.gov.au'],
  });
  assert.deepEqual(
    extractCitations(brand, 'Services provides the official guidance.').competitors_mentioned,
    ['services.gov.au'],
  );
  assert.deepEqual(
    extractCitations(brand, 'Our team uses ServicesHub instead.').competitors_mentioned,
    [],
  );
  assert.deepEqual(
    extractCitations(brand, 'Read https://fake-services.gov.au for details.').competitors_mentioned,
    [],
  );
});

test('multi-part public suffix matching does not count embedded words or lookalike hosts', () => {
  const brand = makeBrand({
    domain: 'example.com',
    name: 'Example',
    competitors: ['acme.co.uk'],
  });
  const { competitors_mentioned } = extractCitations(
    brand,
    'AcmeBank is not this brand; fakeacme.co.uk is an unrelated domain.',
  );
  assert.deepEqual(competitors_mentioned, []);
});

test('unrelated URL metadata cannot manufacture brand or competitor mentions', () => {
  const brand = makeBrand({ domain: 'acme.com', name: 'Acme', competitors: ['rival.com'] });
  for (const response of [
    'https://tracker.example/?target=acme.com',
    'https://tracker.example/?next=https://acme.com',
    'https://tracker.example/redirect/Acme',
    'https://tracker.example/article#acme.com',
    'https://tracker.example/search?q=Acme',
    'https://tracker.example/?utm_source=rival.com',
    'https://tracker.example/rival.com/redirect',
    'https://rival.com@tracker.example/docs',
  ]) {
    const result = extractCitations(brand, response);
    assert.equal(result.brand_mentioned, 0, response);
    assert.deepEqual(result.competitors_mentioned, [], response);
    assert.equal(result.brand_cited_with_link, 0, response);
  }
});

test('real citation hosts and visible prose remain valid mention evidence', () => {
  const brand = makeBrand({ domain: 'acme.com', name: 'Acme', competitors: ['rival.com'] });
  for (const response of [
    'https://acme.com/docs',
    'https://docs.acme.com/guide',
    '[Acme](https://tracker.example/?target=elsewhere)',
    'Acme is useful. https://tracker.example/?target=rival.com',
  ]) {
    const result = extractCitations(brand, response);
    assert.equal(result.brand_mentioned, 1, response);
    assert.deepEqual(result.competitors_mentioned, [], response);
  }
  assert.equal(extractCitations(brand, 'https://docs.acme.com/guide').brand_cited_with_link, 1);
  assert.deepEqual(
    extractCitations(brand, 'https://shop.rival.com/docs').competitors_mentioned,
    ['rival.com'],
  );
  assert.deepEqual(
    extractCitations(brand, '[Rival](https://tracker.example/guide)').competitors_mentioned,
    ['rival.com'],
  );
});

test('URL schemes are case-insensitive for evidence and mention scoring', () => {
  const brand = makeBrand({ domain: 'acme.com', name: 'Acme', competitors: ['rival.com'] });
  for (const raw of [
    'HTTPS://tracker.example/?q=Acme',
    'HTTP://tracker.example/?target=rival.com',
    'Https://tracker.example/redirect/acme.com',
  ]) {
    const result = extractCitations(brand, raw);
    assert.equal(result.brand_mentioned, 0, raw);
    assert.deepEqual(result.competitors_mentioned, [], raw);
    assert.equal(result.brand_cited_with_link, 0, raw);
  }
  const linked = extractCitations(brand, 'HTTPS://ACME.COM/docs');
  assert.equal(linked.brand_mentioned, 1);
  assert.equal(linked.brand_cited_with_link, 1);
  assert.deepEqual(linked.cited_urls, ['acme.com']);
  const rival = extractCitations(brand, 'HtTp://SHOP.RIVAL.COM/guide');
  assert.deepEqual(rival.competitors_mentioned, ['rival.com']);
  assert.deepEqual(rival.cited_urls, ['shop.rival.com']);
});
