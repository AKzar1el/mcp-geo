import assert from 'node:assert/strict';
import test from 'node:test';
import type { Brand } from '../../src/db/types.ts';
import { buildResponseExcerpt } from '../../src/core/tools.ts';
import { extractCitations } from '../../src/core/openai.ts';

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

test('citation excerpt centers the same valid brand mention used by scoring', () => {
  const brand = makeBrand({
    domain: 'monday.com',
    name: 'Monday',
    exclude_terms: ['monday'],
  });
  const unrelated = 'Monday is a weekday in this generic planning discussion. '.repeat(10);
  const response = `${unrelated}For the actual product, see https://monday.com/features for details.`;

  const excerpt = buildResponseExcerpt(response, brand);

  assert.match(excerpt, /monday\.com\/features/);
  assert.ok(
    !excerpt.startsWith('Monday is a weekday'),
    'excerpt should not center on an excluded ambiguous bare-word occurrence',
  );
});

test('citation excerpt can center an explicit alias when no domain is present', () => {
  const brand = makeBrand({
    domain: 'example.com',
    name: 'Example',
    aliases: ['Example Pro'],
    exclude_terms: ['example'],
  });
  const response = `${'Unrelated context. '.repeat(20)}Example Pro is recommended for this workflow.`;

  const excerpt = buildResponseExcerpt(response, brand);

  assert.match(excerpt, /Example Pro is recommended/);
});

test('citation excerpt centers a scored prose mention rather than earlier source URL paths', () => {
  const brand = makeBrand({ domain: 'acme.com', name: 'Acme' });
  const urlReferences = Array.from(
    { length: 12 },
    (_, i) => `Reference ${i}: https://neutral.example/reviews/Acme/round-${i}.`,
  ).join(' ');
  const response = `${urlReferences} Independent assessment: Acme is the best fit.`;

  assert.equal(extractCitations(brand, response).brand_mentioned, 1);
  const excerpt = buildResponseExcerpt(response, brand);
  assert.match(excerpt, /Independent assessment: Acme is the best fit/);
  assert.ok(!excerpt.startsWith('Reference 0:'), 'excerpt must not center on the earliest URL path');
});

test('citation excerpts omit credential-bearing URLs without suppressing valid evidence', () => {
  const brand = makeBrand({ domain: 'example.com', name: 'Example' });
  const response =
    'Example appears at https://alice:private-token@example.com/report and ' +
    'https://account@other.example/report; the public source is https://example.com/docs.';

  const excerpt = buildResponseExcerpt(response, brand);

  assert.doesNotMatch(excerpt, /private-token|alice:|account@/);
  assert.doesNotMatch(excerpt, /https:\/\/alice:|https:\/\/account@/);
  assert.match(excerpt, /\[credential-bearing URL omitted\]/);
  assert.match(excerpt, /https:\/\/example\.com\/docs/);
});

test('citation excerpts redact secret query values without erasing benign source context', () => {
  const brand = makeBrand({ domain: 'example.com', name: 'Example' });
  const response = 'Example research: https://example.com/report?API%5FKEY=SYNTHETIC_SECRET_EXCERPT&ref=ai&access_token=SECOND_SECRET.';
  const excerpt = buildResponseExcerpt(response, brand);
  assert.doesNotMatch(excerpt, /SYNTHETIC_SECRET_EXCERPT|SECOND_SECRET/);
  assert.match(excerpt, /API%5FKEY=\[REDACTED\]/);
  assert.match(excerpt, /ref=ai/);
  assert.match(excerpt, /access_token=\[REDACTED\]/);
});

test('citation excerpts redact credentials after balanced parentheses in a URL path', () => {
  const brand = makeBrand({ domain: 'example.com', name: 'Example' });
  const response =
    'Example cites https://example.com/wiki/Guide_(2026)?access_token=QUERY_SENTINEL&view=public ' +
    'and https://example.com/wiki/Report_(2026)#id_token=FRAGMENT_SENTINEL&section=1.';
  const excerpt = buildResponseExcerpt(response, brand);
  assert.doesNotMatch(excerpt, /QUERY_SENTINEL|FRAGMENT_SENTINEL/);
  assert.match(excerpt, /Guide_\(2026\)\?access_token=\[REDACTED\]&view=public/);
  assert.match(excerpt, /Report_\(2026\)#id_token=\[REDACTED\]&section=1/);
});

test('citation excerpts redact credential parameters after square-bracket URL paths', () => {
  const brand = makeBrand({ domain: 'example.com', name: 'Example' });
  const query = buildResponseExcerpt(
    'Example cites https://example.com/docs/[2026]?access_token=QUERY_BRACKET_SECRET&view=public.',
    brand,
  );
  const fragment = buildResponseExcerpt(
    'Example cites https://example.com/docs/[2026]#id_token=FRAGMENT_BRACKET_SECRET&section=1.',
    brand,
  );
  assert.doesNotMatch(query, /QUERY_BRACKET_SECRET/);
  assert.doesNotMatch(fragment, /FRAGMENT_BRACKET_SECRET/);
  assert.match(query, /\[2026\]\?access_token=\[REDACTED\]&view=public/);
  assert.match(fragment, /\[2026\]#id_token=\[REDACTED\]&section=1/);
});

test('citation excerpts omit malformed URLs rather than expose credentials on parse failure', () => {
  const brand = makeBrand({ domain: 'example.com', name: 'Example' });
  const response =
    'Example cites https://example.com:invalid/docs?access_token=QUERY_INVALID_SECRET ' +
    'and https://alice:PRIVATE_USERINFO@example.com:bad/?id_token=SECOND_INVALID_SECRET. ' +
    'The public evidence is https://example.com/public?view=1.';
  const excerpt = buildResponseExcerpt(response, brand);

  assert.doesNotMatch(excerpt, /QUERY_INVALID_SECRET|PRIVATE_USERINFO|SECOND_INVALID_SECRET/);
  assert.match(excerpt, /\[unparseable URL omitted\]/);
  assert.match(excerpt, /https:\/\/example\.com\/public\?view=1/);
});

test('citation excerpts redact standalone authorization secrets without hiding public citations', () => {
  const brand = makeBrand({ domain: 'example.com', name: 'Example' });
  const response =
    'Example cites https://example.com/report?view=public. ' +
    'Authorization: Bearer SYNTHETIC_BEARER_SECRET ' +
    'access_token=SYNTHETIC_PLAINTEXT_SECRET; public context remains.';

  const excerpt = buildResponseExcerpt(response, brand);
  assert.doesNotMatch(excerpt, /SYNTHETIC_BEARER_SECRET|SYNTHETIC_PLAINTEXT_SECRET/);
  assert.match(excerpt, /Authorization: Bearer \[REDACTED\]/);
  assert.match(excerpt, /access_token=\[REDACTED\]/);
  assert.match(excerpt, /https:\/\/example\.com\/report\?view=public/);
});

test('citation excerpts mask Basic authorization and quoted API keys in provider prose', () => {
  const brand = makeBrand({ domain: 'example.com', name: 'Example' });
  const excerpt = buildResponseExcerpt(
    'Example: https://example.com/docs. AUTHORIZATION: Basic SYNTHETIC_BASIC_SECRET ' +
    'API-KEY="SYNTHETIC_API_SECRET"; the documentation remains public.',
    brand,
  );
  assert.doesNotMatch(excerpt, /SYNTHETIC_BASIC_SECRET|SYNTHETIC_API_SECRET/);
  assert.match(excerpt, /AUTHORIZATION: Basic \[REDACTED\]/);
  assert.match(excerpt, /API-KEY=\[REDACTED\]/);
  assert.match(excerpt, /https:\/\/example\.com\/docs/);
});

test('citation excerpts hide entire quoted credential values containing spaces', () => {
  const brand = makeBrand({ domain: 'example.com', name: 'Example' });
  const excerpt = buildResponseExcerpt(
    'Example cites https://example.com/public. ' +
    'Authorization: Bearer "SYNTHETIC BEARER SECRET"; ' +
    "api_key='SYNTHETIC API KEY SECRET'; visible context remains.",
    brand,
  );
  assert.doesNotMatch(excerpt, /SYNTHETIC|BEARER SECRET|API KEY SECRET/);
  assert.match(excerpt, /Authorization: Bearer \[REDACTED\]/);
  assert.match(excerpt, /api_key=\[REDACTED\]/);
  assert.match(excerpt, /https:\/\/example\.com\/public/);
});
