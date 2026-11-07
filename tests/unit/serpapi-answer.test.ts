import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenSerpApiReferences } from '../../src/core/serpapi-answer.js';

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
