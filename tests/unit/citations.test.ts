// Unit tests for the citation extractor — the core of every score this
// server produces. Pure functions, no network, no D1.
//
// Run with:
//   npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCitations, hostMatchesDomain } from '../../src/openai';
import type { Brand } from '../../src/db';

const acme: Brand = {
  id: 'acme',
  user_id: 'dev-user',
  domain: 'acme.com',
  name: 'Acme Project Tool',
  category: 'Project management software',
  competitors: ['asana.com', 'monday.com', 'notion.so'],
  refresh_frequency: 'weekly',
  created_at: 0,
  updated_at: 0,
};

test('brand mention by name', () => {
  const r = extractCitations(acme, 'I recommend Acme Project Tool for small teams.');
  assert.equal(r.brand_mentioned, 1);
  assert.equal(r.brand_cited_with_link, 0);
});

test('brand mention by domain root', () => {
  const r = extractCitations(acme, 'Many teams use acme for sprint planning.');
  assert.equal(r.brand_mentioned, 1);
});

test('brand mention by full domain', () => {
  const r = extractCitations(acme, 'Check out acme.com for details.');
  assert.equal(r.brand_mentioned, 1);
});

test('no mention when brand root only appears inside another word', () => {
  const r = extractCitations(acme, 'Try Acmeshop or Macme for this use case.');
  assert.equal(r.brand_mentioned, 0);
});

test('markdown link to brand domain counts as linked citation', () => {
  const r = extractCitations(
    acme,
    'Top picks: [Acme](https://acme.com) and [Asana](https://asana.com).',
  );
  assert.equal(r.brand_mentioned, 1);
  assert.equal(r.brand_cited_with_link, 1);
  assert.ok(r.cited_urls.includes('acme.com'));
  assert.ok(r.cited_urls.includes('asana.com'));
});

test('subdomain link counts as linked citation', () => {
  const r = extractCitations(acme, 'See https://docs.acme.com/setup for the guide. Acme is solid.');
  assert.equal(r.brand_cited_with_link, 1);
});

test('www link counts as linked citation', () => {
  const r = extractCitations(acme, 'Acme lives at https://www.acme.com/.');
  assert.equal(r.brand_cited_with_link, 1);
});

test('lookalike domain does NOT count as linked citation', () => {
  const r = extractCitations(
    acme,
    'You might also like https://notacme.com which is unrelated.',
  );
  assert.equal(r.brand_cited_with_link, 0);
});

test('competitors detected with word boundaries', () => {
  const r = extractCitations(
    acme,
    'Asana and Monday.com are popular. Notion fans disagree. Asanapro is unrelated.',
  );
  assert.deepEqual(
    [...r.competitors_mentioned].sort(),
    ['asana.com', 'monday.com', 'notion.so'],
  );
});

test('competitor not detected when absent', () => {
  const r = extractCitations(acme, 'Acme is the only tool worth using.');
  assert.deepEqual(r.competitors_mentioned, []);
});

test('cited hosts are deduped by hostname', () => {
  const r = extractCitations(
    acme,
    'Links: https://asana.com/pricing and https://asana.com/features and [Asana](https://www.asana.com).',
  );
  assert.deepEqual(r.cited_urls, ['asana.com']);
});

test('hostMatchesDomain: exact, subdomain, lookalike, unrelated', () => {
  assert.equal(hostMatchesDomain('acme.com', 'acme.com'), true);
  assert.equal(hostMatchesDomain('docs.acme.com', 'acme.com'), true);
  assert.equal(hostMatchesDomain('notacme.com', 'acme.com'), false);
  assert.equal(hostMatchesDomain('acme.com.evil.io', 'acme.com'), false);
  assert.equal(hostMatchesDomain('asana.com', 'acme.com'), false);
  // domain stored with protocol/www noise still matches
  assert.equal(hostMatchesDomain('acme.com', 'https://www.acme.com'), true);
});
