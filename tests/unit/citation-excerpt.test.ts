import assert from 'node:assert/strict';
import test from 'node:test';
import type { Brand } from '../../src/db/types.ts';
import { buildResponseExcerpt } from '../../src/core/tools.ts';

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
