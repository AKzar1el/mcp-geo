import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenSerpApiAnswer,
  flattenSerpApiReferences,
  MAX_SERPAPI_ANSWER_TEXT_LENGTH,
} from '../../src/core/serpapi-answer.js';

test('SerpAPI citation evidence excludes credential-bearing and non-web reference links', () => {
  const links = flattenSerpApiReferences([
    { link: 'https://example.com/source' },
    { link: 'http://www.example.org/story' },
    { link: 'https://user:password@example.com/private' },
    { link: 'https://example.com@other.example/impersonation' },
    { link: 'javascript:alert(1)' },
    { link: 'example.com/path' },
    { link: 'https://example.net/another' },
  ]);
  assert.deepEqual(links, [
    'https://example.com/source',
    'http://www.example.org/story',
    'https://example.net/another',
  ]);
});

test('SerpAPI table parsing ignores non-string metadata and keeps visible cells', () => {
  assert.equal(flattenSerpApiAnswer([{
    type: 'table',
    table: [
      ['Product', 'Benefit'],
      ['Acme', { snippet: 'Not visible table text' }, 'Cited only if listed as a source'],
      [' ', null, ''],
    ],
  }]), 'Product | Benefit\n\nAcme | Cited only if listed as a source');
});

test('SerpAPI table parsing preserves existing text and block-count safety limits', () => {
  assert.throws(() => flattenSerpApiAnswer([{
    type: 'table', table: [['a'.repeat(250_001)]],
  }]), /structured-text size limit/);
  assert.throws(() => flattenSerpApiAnswer([{
    type: 'table', table: [Array.from({ length: 2049 }, () => '')],
  }]), /structured-text nesting limit/);
});

test('SerpAPI answer size limit accounts for rendered block separators', () => {
  const withinLimit = flattenSerpApiAnswer(
    Array.from({ length: 2048 }, () => ({ text: 'x'.repeat(120) })),
  );
  assert.ok(withinLimit.length <= MAX_SERPAPI_ANSWER_TEXT_LENGTH);

  // Individual snippets fit, but the final double-newline separators push this over the cap.
  assert.throws(() => flattenSerpApiAnswer(
    Array.from({ length: 2048 }, () => ({ text: 'x'.repeat(121) })),
  ), /structured-text size limit/);
});

test('SerpAPI table limit counts rows even when they contain no visible cells', () => {
  assert.throws(() => flattenSerpApiAnswer([{
    type: 'table', table: Array.from({ length: 2049 }, () => []),
  }]), /structured-text nesting limit/);
  assert.throws(() => flattenSerpApiAnswer([{
    type: 'table', table: Array.from({ length: 2049 }, () => null),
  }]), /structured-text nesting limit/);
});

test('SerpAPI comparison blocks preserve product labels and visible feature values', () => {
  assert.equal(flattenSerpApiAnswer([{
    type: 'comparison',
    product_labels: ['Acme Analytics', 'Beta Insights'],
    comparison: [
      { feature: 'Audit evidence', values: ['Cited sources', 'Summary only'] },
      { feature: 'Setup', values: ['Self-service', { snippet: 'Metadata is not a value' }] },
    ],
  }]), 'Acme Analytics | Beta Insights\n\nAudit evidence | Cited sources | Summary only\n\nSetup | Self-service');
});

test('SerpAPI comparison blocks enforce existing text and block-count limits', () => {
  assert.throws(() => flattenSerpApiAnswer([{
    type: 'comparison', comparison: [{ feature: 'Size', values: ['x'.repeat(250_001)] }],
  }]), /structured-text size limit/);
  assert.throws(() => flattenSerpApiAnswer([{
    type: 'comparison', product_labels: Array.from({ length: 2049 }, () => ''),
  }]), /structured-text nesting limit/);
});
