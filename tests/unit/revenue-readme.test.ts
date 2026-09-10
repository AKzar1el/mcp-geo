import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readme = readFileSync('README.md', 'utf8');

test('README audit CTA points to the verified live audit page', () => {
  assert.match(
    readme,
    /\[mcp-geo AI Visibility Audit\]\(https:\/\/geo-mcp\.digestseo\.com\/audit\)/,
  );
  assert.doesNotMatch(
    readme,
    /\[mcp-geo AI Visibility Audit\]\(mailto:info@tomiseregi\.si/,
  );
});
