import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readme = readFileSync('README.md', 'utf8');

test('README audit CTA remains actionable when Worker deployment is unavailable', () => {
  assert.match(
    readme,
    /\[mcp-geo AI Visibility Audit\]\(mailto:info@tomiseregi\.si\?subject=mcp-geo%20AI%20Visibility%20Audit\)/,
  );
  assert.doesNotMatch(
    readme,
    /\[mcp-geo AI Visibility Audit\]\(https:\/\/geo-mcp\.digestseo\.com\/audit\)/,
  );
});
